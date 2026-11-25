'use strict';
/* The HELOC's Paid back counts the payment when it leaves the Bills account (Dale, #821 7161929211: "It can be counted when
 * it leaves the bills account"), the paying-side rule the spend cards already follow. Rule 17 (Grok Bot, Plan #6):
 *   1. each HELOC payment leaving Bills is noted with the line `card payment: HELOC`, kept beside the note's existing text,
 *      so the note LINE is matched, not the whole note;
 *   2. the HELOC-side "TFR-FR" receipt is ignored for Paid back and is never a reversal.
 * Before: only rows on the HELOC account itself of kind 'payment' counted. Real TD rows ("TFR-FR …", "Payment, Transfer",
 * no kind hint) withheld the figure as an unconfirmed credit, and the Bills debit read as an unidentified card payment on
 * the spend cards. Invented data only, realistic TD rows without kind hints. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Forecast = require('../public/forecast');
const { fixture } = require('./fixtures/card-posted-period-movement-data');
const { loadStackPage } = require('./lib/budget-page-harness');

const FIRST = '2026-08-18';
const THIRD = '2026-08-20';
const LONG_NOTE = 'HELOC payment – matched to TD receipt 12\ncard payment: HELOC';
// The Bills (chequing-a) debit to the HELOC, as TD posts it: a TFR-TO to the HELOC's account number, "Payment, Transfer".
const billsDebit = (extra = {}) => ({ id: 'to-heloc', date: FIRST, atlasAccountId: 'chequing-a', accountRole: 'household-cash',
  categoryLabel: 'Payment, Transfer', amount: 300, currency: 'cad', pending: false,
  original_name: 'EF789 TFR-TO 7654321', displayedPayee: 'EF789 TFR-TO 7654321', ...extra });
// The HELOC's own receipt of it: a TFR-FR credit on the HELOC account, also "Payment, Transfer".
const helocReceipt = { id: 'heloc-in', date: FIRST, atlasAccountId: 'heloc', accountRole: 'heloc',
  categoryLabel: 'Payment, Transfer', amount: -300, currency: 'cad', pending: false,
  original_name: 'EF789 TFR-FR 1111111', displayedPayee: 'EF789 TFR-FR 1111111' };

function world(rows) {
  const { plan, debts, overlay, packet } = fixture();
  debts.push({ id: 'heloc', label: 'Example HELOC', structure: 'Interest-only revolving — never amortises', secured: true,
    balance: 42025.35, evidenceDate: THIRD, limit: 60000, pending: 0, rate: 4.9 });
  const travel = plan.obligations.find(o => o.debtId === 'travelvisa');
  travel.amount = 20;
  plan.obligations.push({ ...JSON.parse(JSON.stringify(travel)), id: 'heloc-minimum', debtId: 'heloc', name: 'HELOC minimum', amount: 210 });
  plan.cardPurchaseCoverage.opening.asOf = '2026-08-13';
  packet.syncEvidence.push({ id: 'chequing-a', role: 'household-cash', syncEvidence: 'proven', fields: { last_fetch: true } });
  packet.syncEvidence.push({ id: 'heloc', role: 'heloc', syncEvidence: 'proven', fields: { last_fetch: true } });
  packet.observationAsOf = THIRD;
  packet.coverageThrough = THIRD;
  packet.transactionWindow.endDate = THIRD;
  packet.transactions = rows.map(raw => {
    // Only the decision fields the provider packet retains reach the page: never the raw ledger note.
    const { notes, original_name, ...row } = raw;
    return { ...row, ...Forecast.classifyCurrentPeriodTransaction.derivedFlags(raw, plan),
      coverageRef: 'invented-' + row.id, savingsPostingEvidence: 'posted' };
  });
  overlay.overlays = overlay.overlays.map(item => ({ ...item, evidenceDate: THIRD }));
  overlay.overlays.push({ locator: 'debts:heloc', field: 'balance', proposedValue: 42025.35, evidenceDate: THIRD });
  return { meta: { asOf: THIRD }, accounts: [], revolvingExtra: [], plan, debts,
    liveOverlay: { ...overlay, operatingPlan: 'live', currentPeriodActuals: packet } };
}

async function render(rows) {
  const page = await loadStackPage({ data: world(rows) });
  assert.equal(page.status(), 'rendered');
  const ctx = page.context();
  const view = ctx.recommendation.payPeriodViews.find(v => v.start === page.selectedKey());
  assert.equal(view.timelineRole, 'current');
  const credit = view.stackSummary.credit;
  return { credit, heloc: credit.lines.find(line => line.id === 'heloc'), card: page.blockHtml('credit') };
}
const amounts = list => JSON.stringify(list.map(p => p.amount));
const spendLines = credit => JSON.stringify(credit.lines.filter(line => line.id !== 'heloc'));

function assertCounted(page, label) {
  const { heloc, credit } = page;
  assert.equal(heloc.minimum.amount, 210);
  assert.equal(heloc.paidBack.amount, 300, `${label}: the Bills debit counts`);
  assert.equal(heloc.paidToward.amount, 300);
  assert.equal(heloc.paidBack.trust, 'calculated');
  assert.equal(heloc.minimumCovered.value, true, `${label}: it covers the minimum`);
  assert.equal(heloc.stillToPayBack.amount, 0);
  assert.equal(credit.unconfirmedPayments.length, 0, `${label}: it is no unidentified card payment`);
}

test('a Bills debit noted `card payment: HELOC` inside a longer note counts and covers the minimum', async () => {
  assertCounted(await render([billsDebit({ notes: LONG_NOTE })]), 'long note');
});

test('the note line alone counts the same', async () => {
  assertCounted(await render([billsDebit({ notes: 'card payment: HELOC' })]), 'note line alone');
});

test('a note naming the HELOC "(by amount)" counts at estimated trust', async () => {
  const { heloc } = await render([billsDebit({ notes: 'card payment: HELOC (by amount)' })]);
  assert.equal(heloc.paidBack.amount, 300);
  assert.equal(heloc.paidBack.trust, 'estimated');
  assert.ok(heloc.paidBack.reasons.includes('card-payment-by-amount'));
});

test('the HELOC-side TFR-FR receipt is not counted twice and is not a reversal', async () => {
  const page = await render([billsDebit({ notes: LONG_NOTE }), helocReceipt]);
  assertCounted(page, 'with the receipt');
  for (const figure of [page.heloc.paidBack, page.heloc.stillToPayBack, page.heloc.minimumCovered, page.credit.totals.minimumsPaid])
    assert.ok(!figure.reasons.includes('payment-direction-unresolved') && !figure.reasons.includes('card-credit-purpose-unconfirmed'));
  const alone = await render([helocReceipt]);
  assert.equal(alone.heloc.paidBack.amount, 0, 'the receipt alone pays nothing back');
  assert.ok(!alone.heloc.paidBack.reasons.includes('card-credit-purpose-unconfirmed'), 'and does not withhold it');
  assert.equal(alone.credit.unconfirmedPayments.length, 0);
});

test('an unnoted Bills debit to the HELOC stays an unconfirmed payment and is not counted', async () => {
  const page = await render([billsDebit()]);
  assert.equal(amounts(page.credit.unconfirmedPayments), '[300]');
  assert.equal(page.heloc.paidBack.amount, 0);
  assert.equal(page.heloc.paidBack.trust, 'estimated');
  assert.ok(page.heloc.paidBack.reasons.includes('card-payment-destination-unconfirmed'));
  assert.notEqual(page.heloc.minimumCovered.value, true);
  const travel = page.credit.lines.find(line => line.id === 'travelvisa');
  assert.ok(travel.paidBack.reasons.includes('card-payment-destination-unconfirmed'), 'the spend cards are qualified as before');
});

test('a noted HELOC payment leaves the spend cards exactly as with no HELOC payment', async () => {
  const noted = await render([billsDebit({ notes: LONG_NOTE }), helocReceipt]);
  const none = await render([]);
  assert.equal(spendLines(noted.credit), spendLines(none.credit));
});

test('a mutant restoring the HELOC-side-only rule fails the paying-side checks', async () => {
  const file = path.join(__dirname, '..', 'public', 'forecast-card-period.js');
  const source = fs.readFileSync(file, 'utf8');
  const from = "      if (card.id === 'heloc' && !pubCard) return countedZero(['heloc-not-observed']);\n";
  assert.ok(source.includes(from), 'forecast-card-period.js carries the rule to mutate');
  // The rule this PR replaces: only the HELOC account's own posted rows of kind 'payment' count.
  const mutant = source.replace(from, `      if (card.id === 'heloc') {
        if (!pubCard) return countedZero(['heloc-not-observed']);
        let paidCents = 0;
        for (const row of pubCard.posted || []) if (row.kind === 'payment') paidCents += -Math.round(row.amount * 100);
        return { amount: paidCents / 100, trust: 'estimated', reasons: [] };
      }
`);
  const read = fs.readFileSync;
  fs.readFileSync = function (target, ...rest) {
    return path.resolve(String(target)) === file ? mutant : read.call(this, target, ...rest);
  };
  try {
    const page = await render([billsDebit({ notes: LONG_NOTE }), helocReceipt]);
    assert.throws(() => assertCounted(page, 'mutant'), assert.AssertionError,
      'MUTANT: reading only the HELOC side counts nothing from Bills');
    assert.equal(page.heloc.paidBack.amount, 0);
  } finally {
    fs.readFileSync = read;
  }
});
