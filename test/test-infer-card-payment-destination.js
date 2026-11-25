'use strict';
/* Atlas infers a Bills payment's destination card when it carries no `card payment:` note (owner, Dale, #821 7174658128,
 * amending rule 17 for this case). The paying side's one reader (periodPayerPayments) now names the line for an un-noted
 * debit when exactly one line fits:
 *   1. Two-sided: a row of the opposite amount on exactly one card or HELOC account within ±3 days. Posted landing:
 *      calculated; pending landing: estimated. One to one; a note-tied payment's landing is reserved for it first.
 *   2. Expected amount: otherwise, within the larger of $1 and 1% of a minimum the plan schedules for exactly one line in
 *      the period: estimated.
 *   3. Ambiguity (two lines, two debits for one landing, two debits for one line's minimum) attributes nothing.
 *   4. A note always wins; internal household movements stay excluded.
 * The Credit line's Paid back, its minimum check and (through the same reading) the HELOC settlement all follow.
 * Invented data only: the #1641 fixture world (test/fixtures/card-posted-period-movement-data.js), as of 2026-08-20, a
 * HELOC minimum of 210 and a Travel card minimum of 20, both due 2026-08-22. Expectations are written by hand. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const Forecast = require('../public/forecast');
const { fixture } = require('./fixtures/card-posted-period-movement-data');
const { loadStackPage } = require('./lib/budget-page-harness');

const FIRST = '2026-08-18';
const THIRD = '2026-08-20';
const debit = (amount, extra = {}) => ({ id: 'to-' + (extra.id || 'line'), date: FIRST, atlasAccountId: 'chequing-a', accountRole: 'household-cash',
  categoryLabel: 'Payment, Transfer', amount, currency: 'cad', pending: false,
  original_name: 'EF789 TFR-TO 7654321', displayedPayee: 'EF789 TFR-TO 7654321', ...extra });
const landing = (account, amount, extra = {}) => ({ id: 'land-' + account + '-' + (extra.id || amount), date: FIRST, atlasAccountId: account,
  accountRole: account === 'heloc' ? 'heloc' : 'revolving-credit', categoryLabel: 'Payment, Transfer', amount: -amount,
  currency: 'cad', pending: false, original_name: 'PAYMENT RECEIVED', displayedPayee: 'Payment received', ...extra });

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
    const { notes, original_name, ...row } = raw;
    return { ...row, ...Forecast.classifyCurrentPeriodTransaction.derivedFlags(raw, plan),
      coverageRef: 'invented-' + row.id, savingsPostingEvidence: row.pending ? 'pending' : 'posted' };
  });
  overlay.overlays = overlay.overlays.map(item => ({ ...item, evidenceDate: THIRD }));
  overlay.overlays.push({ locator: 'debts:heloc', field: 'balance', proposedValue: 42025.35, evidenceDate: THIRD });
  return { meta: { asOf: THIRD }, accounts: [], revolvingExtra: [], plan, debts,
    liveOverlay: { ...overlay, operatingPlan: 'live', currentPeriodActuals: packet } };
}

async function read(rows, Engine) {
  const page = await loadStackPage({ data: world(rows), ...(Engine ? { Forecast: Engine } : {}) });
  assert.equal(page.status(), 'rendered');
  const view = page.context().recommendation.payPeriodViews.find(v => v.start === page.selectedKey());
  const credit = view.stackSummary.credit;
  const line = id => credit.lines.find(l => l.id === id);
  return { credit, heloc: line('heloc'), travel: line('travelvisa'), unassigned: JSON.stringify(credit.unconfirmedPayments.map(p => p.amount)) };
}

test('1. two-sided: an un-noted debit with one HELOC landing counts toward the HELOC', async () => {
  const posted = await read([debit(300), landing('heloc', 300)]);
  assert.equal(posted.heloc.paidBack.amount, 300, 'posted landing: counted');
  assert.equal(posted.heloc.paidBack.trust, 'calculated', 'posted landing: calculated');
  assert.equal(posted.heloc.minimumCovered.value, true, 'and it covers the 210 minimum');
  assert.equal(posted.unassigned, '[]', 'nothing left unassigned');
  const pending = await read([debit(300), landing('heloc', 300, { pending: true })]);
  assert.equal(pending.heloc.paidBack.amount, 300, 'pending landing: counted');
  assert.equal(pending.heloc.paidBack.trust, 'estimated', 'pending landing: estimated');
  assert.ok(pending.heloc.paidBack.reasons.includes('card-payment-inferred-pending-landing'));
  const card = await read([debit(75), landing('travelvisa', 75)]);
  assert.equal(card.travel.paidBack.amount, 75, 'a spend card the same way');
});

test('1b. the window is ±3 days: day 3 counts, day 4 does not', async () => {
  const three = await read([debit(300), landing('heloc', 300, { date: '2026-08-15' })]);
  assert.equal(three.heloc.paidBack.amount, 300, '3 days before: counted');
  const four = await read([debit(300), landing('heloc', 300, { date: '2026-08-14' })]);
  assert.equal(four.heloc.paidBack.amount, 0, '4 days before: not counted');
  assert.equal(four.unassigned, '[300]');
});

test('2. expected amount: no landing, within the tolerance of exactly one line\'s minimum, counts at estimated', async () => {
  const heloc = await read([debit(210)]);
  assert.equal(heloc.heloc.paidBack.amount, 210, 'the HELOC minimum 210');
  assert.equal(heloc.heloc.paidBack.trust, 'estimated');
  assert.ok(heloc.heloc.paidBack.reasons.includes('card-payment-inferred-by-minimum'));
  const edge = await read([debit(212.1)]);
  assert.equal(edge.heloc.paidBack.amount, 212.1, '1% of 210 is 2.10: 212.10 counts');
  const past = await read([debit(212.11)]);
  assert.equal(past.heloc.paidBack.amount, 0, '212.11 does not');
  assert.equal(past.unassigned, '[212.11]');
  const travel = await read([debit(21)]);
  assert.equal(travel.travel.paidBack.amount, 21, 'the Travel minimum 20: $1 tolerance, 21 counts');
  const travelPast = await read([debit(21.01)]);
  assert.equal(travelPast.travel.paidBack.amount, 0, '21.01 does not');
});

test('3. ambiguity attributes nothing', async () => {
  const twoLines = await read([debit(80), landing('heloc', 80), landing('travelvisa', 80)]);
  assert.equal(twoLines.heloc.paidBack.amount, 0, 'two lines with a landing: neither');
  assert.equal(twoLines.travel.paidBack.amount, 0);
  assert.equal(twoLines.unassigned, '[80]');
  const twoDebits = await read([debit(300, { id: 'a' }), debit(300, { id: 'b' }), landing('heloc', 300)]);
  assert.equal(twoDebits.heloc.paidBack.amount, 0, 'two debits for one landing: neither');
  assert.equal(twoDebits.unassigned, '[300,300]');
  const twoForMinimum = await read([debit(210, { id: 'a' }), debit(210, { id: 'b' })]);
  assert.equal(twoForMinimum.heloc.paidBack.amount, 0, 'two debits for one line\'s minimum: neither');
});

test('4. a note wins, and a note-tied payment keeps its landing', async () => {
  const noted = await read([debit(80, { notes: 'card payment: HELOC' }), landing('travelvisa', 80)]);
  assert.equal(noted.heloc.paidBack.amount, 80, 'the note names the HELOC: counted there');
  assert.equal(noted.travel.paidBack.amount, 0, 'not on the card the landing suggests');
  const reserved = await read([debit(300, { id: 'n', notes: 'card payment: HELOC' }), debit(300, { id: 'u' }), landing('heloc', 300)]);
  assert.equal(reserved.heloc.paidBack.amount, 300, 'the noted payment counts once');
  assert.equal(reserved.unassigned, '[300]', 'the un-noted twin cannot reuse the noted payment\'s landing');
});

test('4b. an internal household transfer (a TFR-TO / TFR-FR pair between the chequing accounts, #1640) is never inferred', async () => {
  const out = debit(210, { id: 'tfr-out', original_name: 'EF901 TFR-TO 2223334', displayedPayee: 'EF901 TFR-TO 2223334' });
  const back = { ...debit(-210, { id: 'tfr-in', atlasAccountId: 'chequing-b', original_name: 'EF901 TFR-FR 1112223', displayedPayee: 'EF901 TFR-FR 1112223' }) };
  const r = await read([out, back]);
  assert.equal(r.heloc.paidBack.amount, 0, 'the 210 transfer matches the HELOC minimum but is an internal movement: not counted');
});

test('5. the HELOC settlement follows: an inferred payment settles the HELOC minimum row too (#1646)', async () => {
  const page = await loadStackPage({ data: world([debit(300), landing('heloc', 300)]) });
  const rec = page.context().recommendation;
  const view = rec.payPeriodViews.find(v => v.start === page.selectedKey());
  const row = (view.bills || []).find(b => b.id === 'heloc-minimum');
  assert.ok(row, 'the HELOC minimum row is listed');
  assert.equal(row.status, 'PAID', 'settled on the bills side as on the Credit side');
});

test('6. mutants: landing reuse and the window edge are caught', async () => {
  const FILE = path.join(__dirname, '..', 'public', 'forecast-card-period.js');
  const source = fs.readFileSync(FILE, 'utf8');
  const compile = (from, to, name) => {
    assert.equal(source.split(from).length, 2, 'anchor found exactly once: ' + name);
    const mod = new Module(FILE, module);
    mod.filename = FILE;
    mod.paths = Module._nodeModulePaths(path.dirname(FILE));
    mod._compile(source.replace(from, to), FILE.replace(/\.js$/, '-' + name + '.js'));
    return mod.exports;
  };
  // Forecast loads the card module through require, so each mutant swaps the cached module for one run.
  const resolved = require.resolve('../public/forecast-card-period.js');
  const withModule = async (mutant, rows) => {
    const real = require.cache[resolved].exports, keep = { ...real };
    Object.assign(real, mutant);
    try { return await read(rows, Forecast); } finally { Object.assign(real, keep); }
  };
  const noReserve = compile('      if (own.length === 1) own[0].used = true;\n', '', 'no-reserve');
  const r = await withModule(noReserve, [debit(300, { id: 'n', notes: 'card payment: HELOC' }), debit(300, { id: 'u' }), landing('heloc', 300)]);
  assert.equal(r.heloc.paidBack.amount, 600, 'MUTANT (no reservation): the landing is used twice and 600 is counted, which test 4 rejects');
  const wide = compile('  const INFER_WINDOW_DAYS = 3;', '  const INFER_WINDOW_DAYS = 4;', 'wide-window');
  const w = await withModule(wide, [debit(300), landing('heloc', 300, { date: '2026-08-14' })]);
  assert.equal(w.heloc.paidBack.amount, 300, 'MUTANT (±4 days): the day-4 landing counts, which test 1b rejects');
});
