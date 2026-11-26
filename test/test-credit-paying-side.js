'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Forecast = require('../public/forecast');
const { fixture } = require('./fixtures/card-posted-period-movement-data');
const { loadStackPage } = require('./lib/budget-page-harness');

const FIRST = '2026-08-18';
const THIRD = '2026-08-20';
const EXACT = 'card payment: Travel Visa';
const payment = (notes, extra = {}) => ({
  id: 'outgoing', date: FIRST, atlasAccountId: 'chequing-a', accountRole: 'household-cash',
  categoryLabel: 'Credit Card Payment', kindHint: 'payment', amount: 43, currency: 'cad', pending: false,
  notes, ...extra,
});
const issuer = {
  id: 'incoming', date: THIRD, atlasAccountId: 'travelvisa', accountRole: 'revolving-credit',
  displayedPayee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', kindHint: 'payment',
  amount: -43, currency: 'cad', pending: false,
};

function world(asOf, rows) {
  const { plan, debts, overlay, packet } = fixture();
  plan.obligations.find(o => o.debtId === 'travelvisa').amount = 20;
  plan.cardPurchaseCoverage.opening.asOf = '2026-08-13';
  packet.syncEvidence.push({ id: 'chequing-a', role: 'household-cash', syncEvidence: 'proven', fields: { last_fetch: true } });
  packet.observationAsOf = asOf;
  packet.coverageThrough = asOf;
  packet.transactionWindow.endDate = asOf;
  packet.transactions = rows.map(raw => {
    // Pass only the decision fields the provider packet retains. The browser never sees the raw ledger note.
    const { notes, original_name, ...row } = raw;
    return { ...row, ...Forecast.classifyCurrentPeriodTransaction.derivedFlags(raw, plan),
      coverageRef: 'invented-' + row.id, savingsPostingEvidence: row.pending ? 'pending' : 'posted' };
  });
  overlay.overlays = overlay.overlays.map(item => ({ ...item, evidenceDate: asOf }));
  return { meta: { asOf }, accounts: [], revolvingExtra: [], plan, debts,
    liveOverlay: { ...overlay, operatingPlan: 'live', currentPeriodActuals: packet } };
}

async function render(asOf, rows, editPacket) {
  const data = world(asOf, rows);
  if (editPacket) editPacket(data.liveOverlay.currentPeriodActuals, data.plan);
  return renderWorld(data);
}

async function renderWorld(data) {
  const page = await loadStackPage({ data });
  assert.equal(page.status(), 'rendered');
  const ctx = page.context();
  const view = ctx.recommendation.payPeriodViews.find(v => v.start === page.selectedKey());
  assert.equal(view.timelineRole, 'current');
  return { period: { start: view.start, end: view.end }, credit: view.stackSummary.credit,
    breakdown: view.stackSummary.creditBreakdown, card: page.blockHtml('credit'),
    waterfall: page.blockHtml('waterfall'),
    openWaterfall: () => page.sandbox.StackWaterfall.html(ctx, { creditOpen: true }),
    sheet: id => page.sandbox.StackSheet.html(ctx, 'card:' + id) };
}

const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function unconfirmedText(page, id) {
  const section = page.sheet(id).match(/<section[^>]*data-stack-unconfirmed-payments[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(section, 'the selected card sheet shows the unassigned payment');
  return plain(section[1]);
}

function checkPayment(page, amount, trust, reason, cardId = 'travelvisa') {
  const { credit } = page;
  const line = credit.lines.find(item => item.id === cardId);
  for (const figure of [line.paidToward, line.paidBack, credit.totals.minimumsPaid]) {
    assert.equal(figure.amount, amount, 'paid toward, Paid back and the head use the single paying-side amount');
    assert.equal(figure.trust, trust);
  }
  if (reason) {
    assert.ok(line.paidToward.reasons.includes(reason));
    assert.ok(line.paidBack.reasons.includes(reason));
    assert.ok(credit.totals.minimumsPaid.reasons.includes(reason));
  }
  assert.equal(line.minimum.amount, 20);
  const covered = amount >= 20;
  assert.equal(line.minimumCovered.value, covered);
  assert.equal(credit.totals.minimumsCoveredCount, Number(covered));
  const row = page.card.split('<li>').find(item => item.includes('data-stack-sheet="card:' + cardId + '"'))?.split('</li>')[0];
  assert.ok(row, 'the selected card appears on the rendered Credit page');
  assert.equal(row.includes('aria-label="Minimum covered'), covered);
  const paid = row.match(/<span class="stack-credit-x[^"]*"[^>]*>([^<]+)<\/span>/)?.[1];
  assert.ok(paid === '$' + amount || paid === '+$' + amount, 'the row prints its own Paid back');
  const head = page.card.match(/data-stack-credit-total>([\s\S]*?)<\/i>/)?.[1];
  assert.ok(head, 'the Credit head has a published amount');
  assert.equal(plain(head), '$' + amount + ' / $20');
  assert.match(plain(page.sheet(cardId)), new RegExp('Paid back \\+?\\$' + amount + '(?![\\d.])'));
}

test('a ledger-named paying transfer pays its own card before the issuer posts and exactly once afterwards', async () => {
  for (const [asOf, rows] of [[FIRST, [payment(EXACT)]], [THIRD, [payment(EXACT), issuer]]]) {
    const page = await render(asOf, rows);
    checkPayment(page, 43, 'calculated');
    assert.equal(page.credit.lines.find(l => l.id === 'cashback').paidBack.amount, 0);
    assert.doesNotMatch(page.sheet('travelvisa'), /data-stack-unconfirmed-payments/);
  }
  checkPayment(await render(THIRD, [issuer]), 0, 'estimated', 'no-confirmed-paying-side-payments');
});

test('the by-amount note can cover a minimum but retains estimated trust', async () => {
  const page = await render(FIRST, [payment(EXACT + ' (by amount)')]);
  checkPayment(page, 43, 'estimated', 'card-payment-by-amount');
  assert.doesNotMatch(page.sheet('travelvisa'), /data-stack-unconfirmed-payments/);
});

test('payments without one recognized card remain visible and unassigned', async () => {
  for (const notes of [undefined, 'card payment:', 'card payment: Invented Card', EXACT + '; card payment: TD Cash Back Visa']) {
    const page = await render(FIRST, [payment(notes)]);
    checkPayment(page, 0, 'estimated', 'card-payment-destination-unconfirmed');
    assert.equal(page.credit.unconfirmedPayments.length, 1);
    assert.equal(page.credit.unconfirmedPayments[0].amount, 43);
    assert.equal(page.credit.unconfirmedPayments[0].date, FIRST);
    assert.deepEqual(Object.keys(page.credit.unconfirmedPayments[0]).sort(), ['amount', 'date']);
    for (const id of ['travelvisa', 'cashback']) {
      const line = page.credit.lines.find(item => item.id === id);
      assert.equal(line.paidBack.amount, 0);
      const shown = unconfirmedText(page, id);
      assert.match(shown, /Unconfirmed payments/);
      assert.match(shown, /Aug 18/);
      assert.match(shown, /Paying account · Card unidentified/);
      assert.match(shown, /\$43(?:\.00)?\b/);
    }
  }
});

test('a separate unconfirmed transfer cannot inflate or erase the known paying-side amount', async () => {
  const page = await render(FIRST, [payment(EXACT), payment(undefined, { id: 'second-transfer', amount: 71 })]);
  checkPayment(page, 43, 'estimated', 'card-payment-destination-unconfirmed');
  assert.equal(page.credit.unconfirmedPayments.length, 1);
  assert.equal(page.credit.unconfirmedPayments[0].amount, 71);
});

const internalDebit = payment(undefined, {
  id: 'invented-transfer-out', categoryLabel: 'Payment, Transfer', amount: 250,
  payee: 'AB123 TFR-TO INVENTED-B',
});
const internalCredit = payment(undefined, {
  id: 'invented-transfer-in', categoryLabel: 'Payment, Transfer', amount: -250,
  payee: 'AB123 TFR-FR INVENTED-A', atlasAccountId: 'chequing-b',
});

function waterfallCardRow(html, id) {
  const row = html.split('</li>').find(part => part.includes(`data-debt-id="${id}"`));
  assert.ok(row, 'the opened Credit dropdown includes the card');
  return row;
}

function assertTransferRepayment(page) {
  checkPayment(page, 43, 'calculated');
  assert.equal(page.credit.unconfirmedPayments.length, 0);
  const due = page.credit.lines.find(line => line.minimum.amount === 20);
  assert.equal(due.stillToPayBack.amount, 0);
  const html = page.openWaterfall();
  assert.match(html, /Still to pay back on each card/);
  assert.match(waterfallCardRow(html, due.id), /data-source="stackSummary\.creditBreakdown\.rows\.\d+\.amount">\$0<\/span>/);
}

test('a household transfer pair leaves the Credit head and waterfall at the noted repayment', async () => {
  assertTransferRepayment(await render(FIRST, [payment(EXACT)]));
  assertTransferRepayment(await render(FIRST, [payment(EXACT), internalDebit, internalCredit]));
  assertTransferRepayment(await render(FIRST, [
    { ...internalDebit, amount: 43, notes: EXACT }, { ...internalCredit, amount: -43 },
  ]));

  const purchase = {
    id: 'invented-purchase', date: FIRST, atlasAccountId: 'cashback', accountRole: 'revolving-credit',
    categoryLabel: 'Groceries', displayedPayee: 'Invented shop', amount: 71, currency: 'cad', pending: false,
  };
  const page = await render(FIRST, [payment(EXACT), internalDebit, internalCredit, purchase]);
  assertTransferRepayment(page);
  assert.match(waterfallCardRow(page.openWaterfall(), purchase.atlasAccountId),
    /data-source="stackSummary\.creditBreakdown\.rows\.\d+\.amount">\$71<\/span>/);
});

test('an unpaired transfer and an unnoted card transfer stay unassigned', async () => {
  const cardDebit = { ...internalDebit, payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C' };
  for (const rows of [[internalDebit], [cardDebit]]) {
    const page = await render(FIRST, [payment(EXACT), ...rows]);
    assert.deepEqual(Array.from(page.credit.unconfirmedPayments, row => row.amount), rows.map(row => row.amount));
    const due = page.credit.lines.find(line => line.minimum.amount === 20);
    assert.ok(due.paidBack.reasons.includes('card-payment-destination-unconfirmed'));
    assert.equal(page.credit.totals.minimumsPaid.amount, 43);
  }
  // The incoming household credit names no card, so it is not a reversal beside the unassigned card debit.
  const page = await render(FIRST, [payment(EXACT), cardDebit, internalCredit]);
  assert.deepEqual(Array.from(page.credit.unconfirmedPayments, row => row.amount), [cardDebit.amount]);
  const due = page.credit.lines.find(line => line.minimum.amount === 20);
  assert.equal(due.stillToPayBack.amount, 0);
  assert.equal(page.credit.totals.minimumsPaid.amount, 43);
  assert.ok(!page.credit.totals.minimumsPaid.reasons.includes('payment-direction-unresolved'));
});

test('removing the household exclusion lets the outgoing transfer count as unassigned', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'public', 'forecast-card-period.js');
  const source = fs.readFileSync(file, 'utf8');
  const exclusion = 'if (primitives.unnotedHouseholdMovement?.(tx)) continue;';
  assert.ok(source.includes(exclusion));
  const read = fs.readFileSync;
  fs.readFileSync = function (target, ...rest) {
    return path.resolve(String(target)) === file ? source.replace(exclusion, '') : read.call(this, target, ...rest);
  };
  try {
    const page = await render(FIRST, [payment(EXACT), internalDebit, internalCredit]);
    assert.throws(() => assertTransferRepayment(page), assert.AssertionError);
    // The outgoing leg becomes an unassigned payment. The incoming leg names no card, so it still does not blank Credit.
    assert.deepEqual(Array.from(page.credit.unconfirmedPayments, row => row.amount), [250]);
    const due = page.credit.lines.find(line => line.minimum.amount === 20);
    assert.equal(due.paidBack.amount, 43);
    assert.equal(due.stillToPayBack.amount, 0);
    assert.equal(page.credit.totals.minimumsPaid.amount, 43);
    assert.ok(due.paidBack.reasons.includes('card-payment-destination-unconfirmed'));
    assert.ok(!page.credit.totals.minimumsPaid.reasons.includes('payment-direction-unresolved'));
  } finally {
    fs.readFileSync = read;
  }
});

test('a non-due card keeps its named payment when a separate debit has no destination', async () => {
  const page = await render(FIRST, [
    payment('card payment: TD Cash Back Visa'), payment(undefined, { id: 'unassigned', amount: 71 }),
  ]);
  checkPayment(page, 0, 'estimated', 'card-payment-destination-unconfirmed');
  assert.equal(page.credit.totals.minimumsDueCount, 1);
  const line = page.credit.lines.find(item => item.id === 'cashback');
  assert.ok(line.minimum.reasons.includes('no-minimum-due-in-period'));
  assert.equal(line.target.amount, 0);
  for (const figure of [line.paidToward, line.paidBack]) {
    assert.equal(figure.amount, 43);
    assert.equal(figure.trust, 'calculated');
    assert.ok(!figure.reasons.includes('card-payment-destination-unconfirmed'));
  }
  assert.match(plain(page.sheet('cashback')), /Paid back [+$−]*43\b/);
  assert.equal(page.credit.unconfirmedPayments.length, 1);
  assert.equal(page.credit.unconfirmedPayments[0].amount, 71);
});

test('a card with new spending and no minimum keeps its named amount at estimated trust when another payment is unassigned', async () => {
  const purchase = { id: 'new-spending', date: FIRST, atlasAccountId: 'cashback', accountRole: 'revolving-credit',
    categoryLabel: 'Groceries', displayedPayee: 'Invented market', amount: 60, currency: 'cad', pending: false };
  const page = await render(FIRST, [purchase, payment('card payment: TD Cash Back Visa'),
    payment(undefined, { id: 'unassigned', amount: 71 })]);
  const line = page.credit.lines.find(item => item.id === 'cashback');
  assert.ok(line.minimum.reasons.includes('no-minimum-due-in-period'));
  assert.equal(line.target.amount, 60);
  assert.equal(page.credit.unconfirmedPayments.length, 1);
  assert.equal(page.credit.unconfirmedPayments[0].amount, 71);
  assert.equal(line.stillToPayBack.amount, 17);
  assert.equal(line.targetCovered.value, false);
  for (const figure of [line.paidToward, line.paidBack]) {
    assert.equal(figure.amount, 43);
    assert.equal(figure.trust, 'estimated');
    assert.ok(figure.reasons.includes('card-payment-destination-unconfirmed'));
  }
});

test('the head retains the unidentified debit reason even when no card has a minimum due', async () => {
  const page = await render(FIRST, [payment(undefined)], (_packet, plan) => {
    plan.obligations = plan.obligations.filter(item => item.debtId !== 'travelvisa');
  });
  const totals = page.credit.totals;
  assert.equal(totals.minimumsDueCount, 0);
  assert.equal(totals.minimumsDue.amount, 0);
  assert.equal(totals.minimumsPaid.amount, 0);
  assert.equal(totals.minimumsPaid.trust, 'estimated');
  assert.ok(totals.minimumsPaid.reasons.includes('card-payment-destination-unconfirmed'));
  assert.equal(page.credit.unconfirmedPayments.length, 1);
});

test('pending transfers, other accounts and unrelated purchases never pay a posted minimum', async () => {
  const rows = [
    payment(EXACT, { pending: true }),
    payment(EXACT, { id: 'external', atlasAccountId: 'outside', accountRole: 'household-external' }),
    payment(EXACT, { id: 'groceries', kindHint: 'purchase', categoryLabel: 'Groceries' }),
    payment(undefined, { id: 'ordinary-transfer', kindHint: 'transfer', categoryLabel: 'Transfer' }),
  ];
  const page = await render(FIRST, rows);
  checkPayment(page, 0, 'estimated', 'no-confirmed-paying-side-payments');
  assert.doesNotMatch(page.sheet('travelvisa'), /data-stack-unconfirmed-payments/);
});

test('a saved destination without the note-strength field counts with estimated provenance', async () => {
  const page = await render(FIRST, [payment(EXACT)], packet => {
    const row = packet.transactions[0];
    assert.equal(row.cardPaymentNoteDestination, 'travelvisa');
    assert.ok(!Object.hasOwn(row, 'notes'));
    delete row.cardPaymentNoteByAmount;
  });
  checkPayment(page, 43, 'estimated', 'card-payment-note-provenance-unconfirmed');
  assert.doesNotMatch(page.sheet('travelvisa'), /data-stack-unconfirmed-payments/);
});

test('a named reserve debit pays the minimum even with no issuer sync evidence', async () => {
  const reserve = payment(EXACT, { atlasAccountId: 'savings', accountRole: 'household-reserve' });
  const page = await render(FIRST, [reserve], packet => {
    // The reserve payment itself supplies the payer evidence. Neither the Bills sync nor the issuer sync can help.
    packet.syncEvidence = packet.syncEvidence.filter(account => account.id !== 'travelvisa' && account.id !== 'chequing-a');
  });
  checkPayment(page, 43, 'calculated');
  assert.doesNotMatch(page.sheet('travelvisa'), /data-stack-unconfirmed-payments/);
});

test('a manual-statement card receives its named payment from the payer alone', async () => {
  const data = world(FIRST, [payment('card payment: Triangle Mastercard')]);
  const packet = data.liveOverlay.currentPeriodActuals;
  packet.syncEvidence = packet.syncEvidence.filter(account => account.id !== 'triangle');
  data.plan.obligations.find(item => item.debtId === 'travelvisa').debtId = 'triangle';

  const page = await renderWorld(data);
  const movements = Forecast.cardPeriodMovements(data.plan, data.debts, FIRST, page.period, data.liveOverlay);
  const manual = movements.cards.find(card => card.id === 'triangle');
  assert.equal(manual.manualStatement, true);
  assert.deepEqual(manual.posted, []);
  assert.deepEqual(manual.pending, []);
  checkPayment(page, 43, 'calculated', null, 'triangle');
  assert.equal(page.credit.lines.find(card => card.id === 'travelvisa').paidBack.amount, 0);
});

function checkWithheld(page, reason) {
  const line = page.credit.lines.find(item => item.id === 'travelvisa');
  for (const figure of [line.paidToward, line.paidBack, page.credit.totals.minimumsPaid]) {
    assert.equal(figure.amount, null);
    assert.equal(figure.trust, 'unavailable');
  }
  assert.ok(line.paidBack.reasons.includes(reason));
  assert.equal(line.minimumCovered.value, 'unknown');
  assert.match(plain(page.card.match(/data-stack-credit-total>([\s\S]*?)<\/i>/)[1]), /^— \/ \$20$/);
}

test('a named reversal withholds the affected payment and its minimum coverage', async () => {
  const page = await render(THIRD, [
    payment(EXACT), payment(EXACT, { id: 'reversal', date: THIRD, amount: -43 }),
    payment('card payment: TD Cash Back Visa', { id: 'unrelated', amount: 11 }),
  ]);
  checkWithheld(page, 'payment-direction-unresolved');
  const line = page.credit.lines.find(item => item.id === 'travelvisa');
  assert.equal(line.stillToPayBack.amount, null);
  assert.equal(line.targetCovered.value, 'unknown');
  assert.equal(page.credit.totals.minimumsCoveredCount, 0);
  assert.ok(page.credit.totals.minimumsPaid.reasons.includes('payment-direction-unresolved'));
  const other = page.credit.lines.find(item => item.id === 'cashback');
  assert.equal(other.paidBack.amount, 11);
  assert.equal(other.paidBack.trust, 'calculated');
});

test('a reversal alone cannot establish payer coverage for another tracked card', async () => {
  const page = await render(FIRST, [payment(EXACT, { amount: -43 })], packet => {
    packet.syncEvidence = packet.syncEvidence.filter(account => !['household-cash', 'household-reserve'].includes(account.role));
  });
  const other = page.credit.lines.find(item => item.id === 'cashback');
  for (const figure of [other.paidToward, other.paidBack]) {
    assert.equal(figure.amount, null);
    assert.equal(figure.trust, 'unavailable');
    assert.ok(figure.reasons.includes('paying-account-not-observed'));
  }
});

test('an unidentified payment reversal withholds the paid head', async () => {
  const page = await render(THIRD, [
    payment(EXACT), payment(undefined, { id: 'unassigned-reversal', date: THIRD, amount: -43 }),
  ]);
  const { totals } = page.credit;
  assert.equal(totals.minimumsPaid.amount, null);
  assert.equal(totals.minimumsPaid.trust, 'unavailable');
  assert.ok(totals.minimumsPaid.reasons.includes('payment-direction-unresolved'));
  const named = page.credit.lines.find(item => item.id === 'travelvisa');
  assert.equal(named.paidBack.amount, 43);
  assert.equal(page.credit.unconfirmedPayments.length, 1);
  assert.equal(page.credit.unconfirmedPayments[0].amount, -43);
  const shown = unconfirmedText(page, 'travelvisa');
  assert.match(shown, /Paying account · Reversal, card unidentified/);
  assert.match(shown, /[−-]\$43(?:\.00)?\b/);
});

test('an unidentified reversal withholds the head even if no minimum is due', async () => {
  const page = await render(FIRST, [payment(undefined, { amount: -43 })], (_packet, plan) => {
    plan.obligations = plan.obligations.filter(item => item.debtId !== 'travelvisa');
  });
  const { totals } = page.credit;
  assert.equal(totals.minimumsDueCount, 0);
  assert.equal(totals.minimumsCoveredCount, 0);
  assert.equal(totals.minimumsPaid.amount, null);
  assert.equal(totals.minimumsPaid.trust, 'unavailable');
  assert.ok(totals.minimumsPaid.reasons.includes('payment-direction-unresolved'));
});

test('an unidentified reversal withholds the due card checks, coverage bar and remaining amount', async () => {
  const page = await render(THIRD, [
    payment(EXACT), payment(undefined, { id: 'undirected-return', date: THIRD, amount: -43 }),
  ]);
  const { totals, lines, unconfirmedPayments } = page.credit;
  const line = lines.find(item => item.id === 'travelvisa');
  assert.equal(line.paidBack.amount, 43);
  assert.equal(unconfirmedPayments[0].amount, -43);
  assert.equal(line.minimum.amount, 20);
  assert.equal(line.target.amount, 20);
  assert.equal(line.minimumCovered.value, 'unknown');
  assert.equal(line.targetCovered.value, 'unknown');
  assert.equal(line.stillToPayBack.amount, null);
  assert.equal(totals.minimumsPaid.amount, null);
  for (const figure of [line.minimumCovered, line.targetCovered, line.stillToPayBack, totals.minimumsPaid]) {
    assert.equal(figure.trust, 'unavailable');
    assert.ok(figure.reasons.includes('payment-direction-unresolved'));
  }
  assert.equal(totals.minimumsDueCount, 1);
  assert.equal(totals.minimumsCoveredCount, null);
  assert.equal(totals.minimumsCoveredTrust, 'unavailable');
  const row = page.card.match(/<li><button[^>]*data-stack-sheet="card:travelvisa"[\s\S]*?<\/li>/)[0];
  assert.match(row, /aria-label="Paid back \$43"/);
  assert.doesNotMatch(row, /aria-label="Minimum covered|is-good|stack-credit-tick is-on/);
  assert.match(page.card, /class="stack-credit-bar[^"]*"[^>]*><i style="width:0(?:\.0)?%"/);
  const sheet = page.sheet('travelvisa');
  assert.match(plain(sheet), /Minimum \$20\b/);
  assert.doesNotMatch(sheet, /✓|stack-credit-x is-good/);
  const remaining = page.waterfall.match(/<li[^>]*data-debt-id="travelvisa"[^>]*>[\s\S]*?<\/li>/)[0];
  assert.match(remaining, /data-unpublished="true"/);
  assert.match(remaining, /aria-label="not available"/);
  assert.doesNotMatch(remaining, /aria-label="Minimum paid/);
});

test('a differently sized unidentified return withholds progress only where the spend card has a positive target', async () => {
  const page = await render(THIRD, [
    payment(EXACT), payment('card payment: TD Cash Back Visa', { id: 'other-payment', amount: 11 }),
    payment(undefined, { id: 'unidentified-return', date: THIRD, amount: -7 }),
  ]);
  const due = page.credit.lines.find(item => item.id === 'travelvisa');
  assert.equal(due.paidBack.amount, 43);
  assert.equal(due.minimumCovered.value, 'unknown');
  assert.ok(due.minimumCovered.reasons.includes('payment-direction-unresolved'));
  const other = page.credit.lines.find(item => item.id === 'cashback');
  assert.equal(other.target.amount, 0);
  assert.equal(other.paidBack.amount, 11);
  assert.equal(other.stillToPayBack.amount, 0);
  assert.equal(other.targetCovered.value, false);
});

test('a named reversal on a manual-statement card cannot fall back to an estimated zero', async () => {
  const note = 'card payment: Triangle Mastercard';
  const page = await render(THIRD, [payment(note), payment(note, { id: 'reversal', date: THIRD, amount: -43 })],
    (packet, plan) => {
      packet.syncEvidence = packet.syncEvidence.filter(item => item.id !== 'triangle');
      plan.obligations.find(item => item.debtId === 'travelvisa').debtId = 'triangle';
    });
  const manual = page.credit.lines.find(item => item.id === 'triangle');
  for (const figure of [manual.paidToward, manual.paidBack, page.credit.totals.minimumsPaid]) {
    assert.equal(figure.amount, null);
    assert.equal(figure.trust, 'unavailable');
    assert.ok(figure.reasons.includes('payment-direction-unresolved'));
  }
  assert.equal(manual.minimumCovered.value, 'unknown');
});

for (const [source, field] of [['payee', 'cardPaymentDestination'], ['category', 'minimumCategoryDebt']]) {
  test('a ledger note contradicting the ' + source + ' destination pays neither card', async () => {
    const page = await render(FIRST, [payment(EXACT, { [field]: 'cashback' })]);
    const { totals, lines, unconfirmedPayments } = page.credit;
    for (const id of ['travelvisa', 'cashback']) {
      const line = lines.find(item => item.id === id);
      assert.equal(line.paidBack.amount, 0, 'the conflicting debit cannot pay ' + id);
      assert.notEqual(line.minimumCovered.value, true);
    }
    assert.equal(unconfirmedPayments.length, 1);
    assert.equal(unconfirmedPayments[0].date, FIRST);
    assert.equal(unconfirmedPayments[0].amount, 43);
    const shown = unconfirmedText(page, 'travelvisa');
    assert.match(shown, /Paying account · Conflicting card destinations/);
    assert.match(shown, /\$43(?:\.00)?\b/);
    const due = lines.find(item => item.id === 'travelvisa');
    assert.equal(due.paidBack.trust, 'estimated');
    assert.ok(due.paidBack.reasons.includes('card-payment-destination-conflict'));
    assert.equal(totals.minimumsPaid.amount, 0);
    assert.equal(totals.minimumsPaid.trust, 'estimated');
    assert.ok(totals.minimumsPaid.reasons.includes('card-payment-destination-conflict'));
    assert.equal(totals.minimumsCoveredCount, 0);
  });
}

test('a complete response without payer evidence cannot establish a zero, even with an issuer receipt', async () => {
  for (const rows of [[], [issuer]]) {
    const page = await render(THIRD, rows, packet => {
      packet.syncEvidence = packet.syncEvidence.filter(account => account.role !== 'household-cash');
    });
    checkWithheld(page, 'paying-account-not-observed');
    assert.equal(page.credit.totals.minimumsDueCount, 1);
    assert.equal(page.credit.totals.minimumsCoveredCount, 0);
    assert.equal(page.credit.totals.minimumsCoveredTrust, 'unavailable');
  }
});

test('a future due minimum keeps estimated coverage-count trust while payment is unobserved', async () => {
  const page = await loadStackPage({ data: world(THIRD, []) });
  assert.equal(page.status(), 'rendered');
  // The invented plan schedules its next monthly card minimum on September 22.
  const dueDate = '2026-09-22';
  const view = page.context().recommendation.payPeriodViews.find(v => v.start <= dueDate && dueDate <= v.end);
  assert.equal(view.timelineRole, 'future');
  const { lines, totals } = view.stackSummary.credit;
  const line = lines.find(item => item.id === 'travelvisa');
  assert.equal(line.minimum.amount, 20);
  assert.equal(line.minimum.trust, 'estimated');
  assert.equal(line.minimumCovered.value, 'unknown');
  assert.equal(line.minimumCovered.trust, 'unavailable');
  assert.equal(totals.minimumsDue.amount, 20);
  assert.equal(totals.minimumsDueCount, 1);
  assert.equal(totals.minimumsCoveredCount, 0);
  assert.equal(totals.minimumsPaid.amount, 0);
  assert.equal(totals.minimumsPaid.trust, 'estimated');
  assert.ok(totals.minimumsPaid.reasons.includes('future-not-observed'));
  assert.equal(totals.minimumsCoveredTrust, 'estimated');
});

test('a posted payer transfer sharing a native ID with a different ledger row cannot establish Paid back', async () => {
  const unrelated = { ...issuer, id: 'outgoing', kindHint: 'purchase', categoryLabel: 'Groceries',
    original_name: 'Invented grocer', amount: 7 };
  const page = await render(THIRD, [payment(EXACT), unrelated], packet => {
    // Different references rule out a reference collision: only the duplicate native ID conflicts.
    packet.transactions[1].coverageRef = 'invented-issuer-charge';
  });
  checkWithheld(page, 'duplicate-identity');
});

// Muse, #1628 7151767722 (bounded blocker; lead ATLAS LEAD 13): an unassigned payment or reversal qualifies a spend card
// whose target is positive OR unknown. Only a known $0 target (ruled intended) leaves the row unqualified. The invented
// Travel minimum is left unread (amount null), so the card's target is unknown.
const UNKNOWN_TARGET = (_packet, plan) => { plan.obligations.find(o => o.debtId === 'travelvisa').amount = null; };
const UNASSIGNED_CASES = [
  ['an unassigned payment', { id: 'unassigned', amount: 71 }],
  ['an unassigned reversal', { id: 'unassigned-return', date: THIRD, amount: -43 }],
];

function assertUnknownTargetQualified(page, label, reversal) {
  const line = page.credit.lines.find(item => item.id === 'travelvisa');
  assert.equal(line.target.amount, null, `${label}: the target is unknown`);
  for (const figure of [line.paidToward, line.paidBack]) {
    assert.equal(figure.amount, 43, `${label}: the named payment still shows`);
    assert.notEqual(figure.trust, 'calculated', `${label}: paid back is not calculated beside it`);
    assert.equal(figure.trust, 'estimated');
    assert.ok(figure.reasons.includes('card-payment-destination-unconfirmed'), `${label}: the unassigned reason`);
  }
  assert.equal(line.stillToPayBack.amount, null);
  assert.equal(line.targetCovered.value, 'unknown');
  if (reversal) assert.ok(line.stillToPayBack.reasons.includes('payment-direction-unresolved'), `${label}: progress is unresolved`);
}

for (const [label, extra] of UNASSIGNED_CASES) {
  test(`${label} qualifies paid back on a card whose target is unknown`, async () => {
    const page = await render(THIRD, [payment(EXACT), payment(undefined, extra)], UNKNOWN_TARGET);
    assertUnknownTargetQualified(page, label, extra.amount < 0);
  });

  test(`${label} leaves a known $0 target exactly as it was`, async () => {
    const page = await render(THIRD, [payment(EXACT),
      payment('card payment: TD Cash Back Visa', { id: 'other-payment', amount: 11 }), payment(undefined, extra)]);
    const line = page.credit.lines.find(item => item.id === 'cashback');
    assert.equal(line.target.amount, 0);
    for (const figure of [line.paidToward, line.paidBack]) {
      assert.equal(figure.amount, 11);
      assert.equal(figure.trust, 'calculated');
      assert.equal(figure.reasons.length, 0, 'no unassigned reason on a known $0 target');
    }
    assert.equal(line.stillToPayBack.amount, 0);
    assert.equal(line.targetCovered.value, false);
  });
}

test('a mutant qualifying only a positive target fails the unknown-target checks', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'public', 'forecast-card-period.js');
  const source = fs.readFileSync(file, 'utf8');
  const from = 'const targetOpen = cents(target.amount) === null || cents(target.amount) > 0;';
  assert.ok(source.includes(from), 'forecast-card-period.js carries the rule to mutate');
  const mutant = source.replace(from, 'const targetOpen = cents(target.amount) > 0;');
  // Serve the mutant to the page harness for these renders only; nothing is written to disk.
  const read = fs.readFileSync;
  fs.readFileSync = function (target, ...rest) {
    return path.resolve(String(target)) === file ? mutant : read.call(this, target, ...rest);
  };
  try {
    for (const [label, extra] of UNASSIGNED_CASES) {
      const page = await render(THIRD, [payment(EXACT), payment(undefined, extra)], UNKNOWN_TARGET);
      assert.throws(() => assertUnknownTargetQualified(page, label, extra.amount < 0), assert.AssertionError,
        `MUTANT (${label}): the > 0-only rule leaves paid back calculated beside it`);
    }
  } finally {
    fs.readFileSync = read;
  }
});

// Hand-derived on the invented fixture this file already uses: Travel's minimum is 20, the noted
// payment is 43, and the Cash Back purchase is 71 with no minimum. Still to pay back is
// max(0, target − paid): 0 on Travel (target 20) and 71 on Cash Back (target 71).
const PURCHASE = {
  id: 'invented-purchase', date: FIRST, atlasAccountId: 'cashback', accountRole: 'revolving-credit',
  categoryLabel: 'Groceries', displayedPayee: 'Invented shop', amount: 71, currency: 'cad', pending: false,
};
const GIFT_ROWS = [payment(EXACT), PURCHASE];

function publishedCredit(page) {
  const { credit } = page;
  return {
    head: credit.totals.minimumsPaid,
    coveredCount: credit.totals.minimumsCoveredCount,
    unconfirmed: credit.unconfirmedPayments.map(row => row.amount),
    lines: credit.lines.map(line => ({
      id: line.id,
      paidBack: line.paidBack,
      stillToPayBack: line.stillToPayBack,
      minimumCovered: line.minimumCovered,
      targetCovered: line.targetCovered,
    })),
    breakdown: (page.breakdown.rows).map(row => ({ debtId: row.debtId, amount: row.amount, trust: row.trust })),
  };
}

function creditLineHtml(page, id) {
  return page.card.split('<li>').find(item => item.includes('data-stack-sheet="card:' + id + '"'))?.split('</li>')[0] || '';
}

function assertMatchesWithoutRow(page, baseline) {
  // The page figures are created in the renderer sandbox. Compare their values, not the sandbox objects.
  assert.deepEqual(JSON.parse(JSON.stringify(publishedCredit(page))), JSON.parse(JSON.stringify(publishedCredit(baseline))));
  assert.equal(plain(page.card.match(/data-stack-credit-total>([\s\S]*?)<\/i>/)[1]),
    plain(baseline.card.match(/data-stack-credit-total>([\s\S]*?)<\/i>/)[1]));
  for (const id of ['travelvisa', 'cashback']) {
    assert.equal(creditLineHtml(page, id), creditLineHtml(baseline, id));
    assert.equal(waterfallCardRow(page.openWaterfall(), id), waterfallCardRow(baseline.openWaterfall(), id));
  }
}

function assertHandDerivedProgress(page) {
  const { credit } = page;
  const travel = credit.lines.find(line => line.id === 'travelvisa');
  const cashback = credit.lines.find(line => line.id === 'cashback');
  assert.equal(credit.totals.minimumsPaid.amount, 43);
  assert.equal(credit.totals.minimumsPaid.trust, 'calculated');
  assert.equal(credit.totals.minimumsPaid.reasons.length, 0);
  assert.equal(credit.totals.minimumsCoveredCount, 1);
  assert.equal(credit.unconfirmedPayments.length, 0);
  assert.equal(travel.paidBack.amount, 43);
  assert.equal(travel.paidBack.trust, 'calculated');
  assert.equal(travel.stillToPayBack.amount, 0);
  assert.equal(travel.minimumCovered.value, true);
  assert.equal(travel.targetCovered.value, true);
  assert.equal(cashback.paidBack.amount, 0);
  assert.equal(cashback.stillToPayBack.amount, 71);
  assert.equal(cashback.targetCovered.value, false);
  assert.equal(plain(page.card.match(/data-stack-credit-total>([\s\S]*?)<\/i>/)[1]), '$43 / $20');
  assert.match(creditLineHtml(page, 'travelvisa'), /stack-credit-tick is-on/);
  assert.match(waterfallCardRow(page.openWaterfall(), 'travelvisa'),
    /data-source="stackSummary\.creditBreakdown\.rows\.\d+\.amount">\$0<\/span>/);
  assert.match(waterfallCardRow(page.openWaterfall(), 'cashback'),
    /data-source="stackSummary\.creditBreakdown\.rows\.\d+\.amount">\$71<\/span>/);
  const breakdown = JSON.parse(JSON.stringify(publishedCredit(page).breakdown));
  assert.deepEqual(breakdown, [
    { debtId: 'travelvisa', amount: 0, trust: 'estimated' },
    { debtId: 'cashback', amount: 71, trust: 'estimated' },
  ]);
}

function assertReversalWithheld(page) {
  const { credit } = page;
  const travel = credit.lines.find(line => line.id === 'travelvisa');
  const cashback = credit.lines.find(line => line.id === 'cashback');
  assert.equal(credit.totals.minimumsPaid.amount, null);
  assert.equal(credit.totals.minimumsPaid.trust, 'unavailable');
  assert.ok(credit.totals.minimumsPaid.reasons.includes('payment-direction-unresolved'));
  assert.equal(credit.totals.minimumsCoveredCount, null);
  for (const line of [travel, cashback]) {
    assert.equal(line.stillToPayBack.amount, null);
    assert.equal(line.stillToPayBack.trust, 'unavailable');
    assert.ok(line.stillToPayBack.reasons.includes('payment-direction-unresolved'));
    assert.equal(line.targetCovered.value, 'unknown');
    assert.equal(line.minimumCovered.value, 'unknown');
  }
  assert.match(plain(page.card.match(/data-stack-credit-total>([\s\S]*?)<\/i>/)[1]), /^— \/ \$20$/);
  assert.doesNotMatch(creditLineHtml(page, 'travelvisa'), /stack-credit-tick is-on/);
  assert.doesNotMatch(creditLineHtml(page, 'cashback'), /stack-credit-tick is-on/);
  for (const id of ['travelvisa', 'cashback']) {
    const row = waterfallCardRow(page.openWaterfall(), id);
    assert.match(row, /data-source="stackSummary\.creditBreakdown\.rows\.\d+\.amount" data-unpublished="true"><\/span>/);
    assert.match(row, /—/);
  }
  const breakdown = publishedCredit(page).breakdown;
  assert.equal(breakdown.find(row => row.debtId === 'travelvisa').amount, null);
  assert.equal(breakdown.find(row => row.debtId === 'cashback').amount, null);
}

test('an incoming e-transfer deposit in Payment, Transfer does not hide card payment progress', async () => {
  const baseline = await render(FIRST, GIFT_ROWS);
  assertHandDerivedProgress(baseline);
  for (const payee of ['E-TRANSFER ***ab1', 'INTERAC e-Transfer from Invented giver']) {
    const deposit = {
      id: 'invented-etransfer-in', date: FIRST, atlasAccountId: 'chequing-a', accountRole: 'household-cash',
      categoryLabel: 'Payment, Transfer', kindHint: 'payment', amount: -80, currency: 'cad', pending: false,
      payee, original_name: payee,
    };
    const page = await render(FIRST, GIFT_ROWS.concat([deposit]));
    assertHandDerivedProgress(page);
    assertMatchesWithoutRow(page, baseline);
  }
});

test('a genuine incoming card reversal still withholds progress, ticks and still to pay back', async () => {
  const categoryReversal = payment(undefined, { id: 'unassigned-reversal', date: FIRST, amount: -43 });
  const descriptorReversal = payment(undefined, {
    id: 'cc-reversal', date: FIRST, amount: -43, categoryLabel: 'Payment, Transfer', kindHint: 'payment',
    payee: 'AB123 TFR-FR C/C', original_name: 'AB123 TFR-FR C/C', displayedPayee: 'AB123 TFR-FR C/C',
  });
  for (const reversal of [categoryReversal, descriptorReversal]) {
    const page = await render(FIRST, GIFT_ROWS.concat([reversal]));
    assertReversalWithheld(page);
    assert.ok(page.credit.unconfirmedPayments.some(row => row.amount === -43));
  }
});

test('a mutant that drops the card-identity check no longer withholds a genuine reversal', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'public', 'forecast-card-period.js');
  const source = fs.readFileSync(file, 'utf8');
  const from = 'if (value < 0 && typeof primitives.incomingCardReversal === \'function\' && !primitives.incomingCardReversal(tx)) continue;';
  assert.ok(source.includes(from), 'forecast-card-period.js carries the identity check to drop');
  const mutant = source.replace(from, 'if (value < 0) continue;');
  const read = fs.readFileSync;
  fs.readFileSync = function (target, ...rest) {
    return path.resolve(String(target)) === file ? mutant : read.call(this, target, ...rest);
  };
  try {
    const reversal = payment(undefined, { id: 'unassigned-reversal', date: FIRST, amount: -43 });
    const page = await render(FIRST, GIFT_ROWS.concat([reversal]));
    assert.throws(() => assertReversalWithheld(page), assert.AssertionError,
      'MUTANT: dropping the identity check lets the genuine reversal publish progress');
    assert.equal(page.credit.totals.minimumsPaid.amount, 43);
    assert.equal(page.credit.lines.find(line => line.id === 'travelvisa').stillToPayBack.amount, 0);
  } finally {
    fs.readFileSync = read;
  }
});
