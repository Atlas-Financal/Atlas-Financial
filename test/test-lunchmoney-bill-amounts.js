'use strict';
/* Amounts from Lunch Money (owner, Dale 2026-11-21; lead plan approved 2026-11-21): a bill linked by
 * lunchMoneyRecurringIds is served at its reviewed item's amount when that amount is a positive whole-cent CAD
 * amount; otherwise the plan's amount stands with a closed reason. Served plan only; the amount tag stays the plan's;
 * card/obligation rows and Bell never take an item amount.
 *
 * Invented world (test/acceptance/harness.js): payday anchor 2026-10-09, as of 2026-10-14; periods Oct 9-22 and
 * Oct 23-Nov 5. An invented $80 band-room bill, monthly on the 20th, estimated, from Bills; its item, also on the
 * 20th, carries an invented amount. Hand-derived: Oct 20 is in the current period; the served amount is the item's
 * (e.g. 64.25), the plan document still says 80, and the amount tag stays estimated. */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const O = require('../scripts/provider-observe.js');
const F = require('../public/forecast.js');
let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => { checks++; if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); };
const J = JSON.stringify;
const ID = '7123460';
const BILL = { id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 20, firstDue: '2026-10-01',
  confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true };
const item = (id, amount, extra = {}) => ({ providerId: id, status: 'reviewed', unavailableFields: [],
  criteria: { startDate: '2026-01-20', endDate: null, granularity: 'month', quantity: 1, anchorDate: '2026-01-20',
    currency: 'CAD', plaidAccountId: '9001', manualAccountId: null, ...(amount === undefined ? {} : { amount }), ...(extra.criteria || {}) },
  matches: { expectedOccurrenceDates: ['2026-10-20'], foundTransactions: [] } });
const read = items => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-09-30', endDate: '2026-10-14' }, items } });
const rule = (eventId, rid) => ({ eventId, lunchMoneyRecurringIds: [rid], linkedFrom: '2026-10-01', atlasAccountId: 'chequing-a', direction: 'debit',
  requiredCurrency: 'cad', requiredPostingEvidence: 'posted', postingDateRule: 'covers-early-or-due-on-or-before-posting' });

function serve(items, opts = {}) {
  const w = H.baseWorld();
  if (opts.asOf) w.asOf = opts.asOf;
  if (opts.postedCash !== undefined) w.accounts.find(a => a.id === 'chequing-a').value = opts.postedCash;
  w.bills = [{ ...BILL, ...(opts.bill || {}) }, ...(opts.extraBills || [])];
  w.identityRules = w.identityRules.concat(opts.rules || [rule(opts.bill && opts.bill.id || 'band', ID)]);
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    ...(opts.transactions || [])];
  H.productionOpening(w);
  const canonical = H.canonicalOf(w, H.planOf(w));
  if (opts.opening) canonical.plan.opening = opts.opening;
  const before = J(canonical);
  const r = Live.fromObservation({ data: canonical, payload: { ...H.rawPayload(w), recurringItems: read(items) },
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const plan = r.data.plan;
  const adv = F.recommend(plan, w.asOf, { currentPeriodActuals: r.data.liveOverlay.currentPeriodActuals, debts: r.data.debts });
  const cur = (adv.defaultView.calendarPeriods.find(p => p.start === '2026-10-09').bills || []).filter(b => b.id === (opts.bill && opts.bill.id || 'band'));
  return { opening: plan.opening, billsBalance: adv.defaultView.billsAccountPeriodBalance, bill: plan.bills.find(b => b.id === (opts.bill && opts.bill.id || 'band')), cur, unchanged: J(canonical) === before,
    schedules: r.report.recurringBillSchedules || [] };
}

console.log('1. A whole-cent CAD item amount is the served amount; the plan document and the tag stay');
{
  const s = serve([item(ID, '64.2500')]);
  ok(s.bill.amount === 64.25, 'served amount 64.25 (the item\'s), not the plan\'s 80', String(s.bill.amount));
  ok(s.bill.confidence === 'estimated', 'the amount tag stays the plan\'s estimated (no promotion)');
  ok(s.unchanged, 'the canonical document is not written');
  ok(s.cur.length === 1 && s.cur[0].amount === 64.25, 'the Oct 20 occurrence carries 64.25', J(s.cur.map(b => [b.date, b.amount])));
}

console.log('2. Anything else keeps the plan\'s 80, with a closed reason');
for (const [label, items, opts, reason] of [
  ['no amount', [item(ID, undefined)], {}, 'amount-unavailable'],
  ['zero', [item(ID, '0.00')], {}, 'amount-unavailable'],
  ['negative', [item(ID, '-5.00')], {}, 'amount-unavailable'],
  ['fraction of a cent', [item(ID, '12.345')], {}, 'amount-unavailable'],
  ['not a number', [item(ID, 'twelve')], {}, 'amount-unavailable'],
  ['owner promotional terms', [item(ID, '64.25')], { bill: { amountSchedule: [{ from: '2026-11-01', until: '2027-01-01', amount: 50 }] } }, 'amount-schedule-present'],
]) {
  const s = serve(items, opts);
  const sched = s.schedules.find(x => x.billId === 'band');
  ok(s.bill.amount === 80 && sched && sched.amountReason === reason, `${label}: plan 80 stands (${reason})`, J([s.bill.amount, sched && sched.amountReason]));
}

console.log('3. Bell never takes an item amount (two payments, one item)');
{
  const s = serve([item(ID, '75.00')], { bill: { id: 'bell', label: 'Invented phone', amount: 160 } });
  const sched = s.schedules.find(x => x.billId === 'bell');
  ok(s.bill.amount === 160 && sched && sched.amountReason === 'amount-excluded', 'bell stays 160 (amount-excluded)', J([s.bill.amount, sched && sched.amountReason]));
  ok(O.RECURRING_AMOUNT_EXCLUDED_BILL_IDS.has('bell') && O.RECURRING_AMOUNT_EXCLUDED_BILL_IDS.size === 1, 'the excluded list is exactly bell');
}

console.log('4. Removing the link restores the plan amount');
{
  const s = serve([item(ID, '64.25')], { rules: [] });
  ok(s.bill.amount === 80 && !s.schedules.some(x => x.billId === 'band'), 'unlinked: no schedule, plan 80');
}

console.log('5. A settled occurrence keeps what was paid');
{
  const paid = H.lm({ date: '2026-10-14', amount: 79.5, account: 'chequing-a', payee: 'Invented band', raw: { recurring_id: Number(ID) } });
  const s = serve([item(ID, '64.25')], { transactions: [paid] });
  const row = s.cur[0];
  ok(row && /paid/i.test(row.status || row.householdPaymentStatus || '') && Math.abs(Number(row.cashPaid ?? row.actual) - 79.5) < 0.005,
    'the linked posted 79.50 on Oct 14 (inside the 7-day early window) settles Oct 20 at what was paid, not the item amount', J(row && { status: row.status, cashPaid: row.cashPaid, actual: row.actual }));
}


console.log('5b. Stated behaviour (lead, 2026-11-21): an unsettled occurrence already past still owed shows the item\'s current amount');
{
  // As of Oct 21 the Oct 20 occurrence is past and unpaid; it is still owed in the Oct 9-22 period at 64.25, not 80
  // ("change it in Lunch Money and it appears in Atlas").
  const s = serve([item(ID, '64.25')], { asOf: '2026-10-21' });
  const row = s.cur.find(b => b.date === '2026-10-20');
  ok(row && row.amount === 64.25 && !/paid/i.test(row.status || ''), 'past, unpaid Oct 20 is owed at the item amount 64.25',
    J(row && { date: row.date, amount: row.amount, status: row.status }));
}


console.log('5c. First-seen posted payments qualify against the served price');
const posted = (amount, date = '2026-10-20') => H.lm({ id: 78123, date, amount, account: 'chequing-a',
  payee: 'Invented band', raw: { recurring_id: Number(ID) } });
const pairedRule = { ...rule('band', ID), settlementFrom: 'lunchmoney-matched-occurrences' };
const pairedItem = (price, payment) => ({
  ...item(ID, price),
  matches: { expectedOccurrenceDates: ['2026-10-20'], missingTransactionDates: [],
    foundTransactions: [{ transactionId: String(payment.id), date: payment.date }] },
});
// The invented Bills account starts with 1,400. Its posted balance already includes the debit.
// The household budget reserves 400. A settled bill takes nothing further. An unmatched bill
// reserves the full current item amount. The variable bill accepts an underpayment at actual.
for (const [price, payment, expectedPaid, expectedRemaining, expectedBalance] of [
  ['130.00', 130, 130, 0, 870],      // full price above 1.5 times the stale plan's 80
  ['130.00', 125, 125, 0, 875],      // below the served price, above the stale cap
  ['130.00', 195, 195, 0, 805],      // exactly the served 1.5x upper bound
  ['40.00', 60.01, null, 40, 899.99], // one cent above the served cap, inside the stale cap
]) {
  const tx = posted(payment);
  for (const pairing of [false, true]) {
    const s = serve([pairing ? pairedItem(price, tx) : item(ID, price)], {
      asOf: '2026-10-21', transactions: [tx], rules: [pairing ? pairedRule : rule('band', ID)],
      postedCash: 1400 - payment,
    });
    const row = s.cur[0];
    const qualified = expectedPaid !== null;
    ok(row?.amount === Number(price) && row.status === (qualified ? 'PAID' : 'still due')
      && (row.actual ?? null) === expectedPaid && row.remaining === expectedRemaining
      && s.billsBalance.remainingBills === expectedRemaining && s.billsBalance.amount === expectedBalance,
      `payment ${payment}, served price ${price}, ${pairing ? 'provider-paired' : 'date-qualified'}: paid, remaining, Bills balance`,
      J([row?.status, row?.actual, row?.remaining, s.billsBalance.amount]));
  }
}

console.log('5d. A recorded opening keeps its occurrence settled across a price drop; with no receipt bound to it, no actual is published (review 7073788253)');
{
  // An opening's representedEvents row names the bill and the date only (no receipt id, no actual), so no later
  // receipt can claim the opening's settlement as its actual: one contract on both matching paths.
  const tx = posted(79.5, '2026-10-14');
  for (const pairing of [false, true]) {
    const route = pairing ? 'provider-paired' : 'date-qualified';
    const r = pairing ? pairedRule : rule('band', ID);
    const it = (price, payment) => pairing ? pairedItem(price, payment) : item(ID, price);
    const prior = serve([it('80.00', tx)], { asOf: '2026-10-14', transactions: [tx], rules: [r], postedCash: 1320.5 });
    ok(prior.cur[0]?.status === 'PAID' && prior.cur[0].actual === 79.5
      && prior.opening.representedEvents.some(e => e.id === 'band' && e.date === '2026-10-20'),
      `${route}: the prior observation settled the 79.50 payment and represented its occurrence`, J(prior.cur[0]));
    const opening = JSON.parse(J(prior.opening));
    ok(opening.representedEvents.every(e => J(Object.keys(e).sort()) === J(['date', 'id']) || J(Object.keys(e).sort()) === J(['date', 'effectiveAsOf', 'id'])),
      `${route}: the opening row carries no receipt id or actual to bind`, J(opening.representedEvents));
    for (const [label, receipt, cash] of [
      ['unchanged receipt', tx, 1320.5],
      ['same-date replacement with a different provider id', H.lm({ id: 78999, date: '2026-10-14', amount: 93.25, account: 'chequing-a',
        payee: 'Invented band', raw: { recurring_id: Number(ID) } }), 1306.75],
      ['edited amount on the same provider id', H.lm({ id: 78123, date: '2026-10-14', amount: 93.25, account: 'chequing-a',
        payee: 'Invented band', raw: { recurring_id: Number(ID) } }), 1306.75],
    ]) {
      const s = serve([it('40.00', receipt)], { asOf: '2026-10-21', transactions: [receipt], rules: [r], postedCash: cash, opening });
      const row = s.cur[0];
      ok(row?.status === 'PAID' && row.amount === 40 && (row.actual ?? null) === null && row.remaining === 0
        && s.billsBalance.remainingBills === 0 && s.billsBalance.amount === cash - 400,
        `${route}, ${label}: still settled by the opening, nothing reserved twice, no actual published`,
        J([row?.status, row?.actual, row?.remaining, s.billsBalance.amount]));
    }
  }
}

console.log('5e. Trusted-on-due settlements use the served price as their actual');
{
  const s = serve([item(ID, '20.00')], { asOf: '2026-10-21', postedCash: 1380,
    bill: { amount: 12 }, rules: [{ ...rule('band', ID), settlesWhen: 'schedule-trust-on-due' }] });
  const row = s.cur[0];
  ok(row?.settlementBasis === 'schedule-trust-on-due' && row.status === 'PAID'
    && row.amount === 20 && row.actual === 20 && row.remaining === 0 && s.billsBalance.amount === 980,
    'trusted actual equals the served price and the Bills balance retains only the budget reserve');
}

console.log('6. Card and obligation rows never take an item amount');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../scripts/provider-observe.js'), 'utf8');
  const obl = src.slice(src.indexOf('function recurringObligationSchedule'), src.indexOf('function applyRecurringObligationSchedule'));
  ok(!/recurringBillAmount|amounts/.test(obl), 'the card/obligation schedule path reads no item amount');
}
// Each fresh observation qualifies against the current price. A prior live view
// never writes an opening or a close. Both reads use the same posted transaction.
async function verifyRepeatRefresh() {
  const fs = require('node:fs');
  const { mock } = require('node:test');
  const w = H.baseWorld('2026-10-21');
  w.bills = [{ ...BILL }];
  w.identityRules.push(pairedRule);
  const tx = posted(79.5, '2026-10-14');
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll',
    account: 'chequing-a', payee: 'Invented employer' }), tx];
  w.accounts.find(a => a.id === 'chequing-a').value = 1320.5;
  H.productionOpening(w);
  const canonical = H.canonicalOf(w, H.planOf(w));
  const baseline = J(canonical);
  const identity = J(H.identityOf(w));
  const originalRead = fs.readFileSync;
  let price;
  try {
    mock.method(fs, 'readFileSync', function(file, ...args) {
      return file === O.DEFAULT_IDENTITY ? identity : originalRead.call(this, file, ...args);
    });
    mock.method(O, 'loadLiveAccountMap', () => H.accountMapOf(w));
    mock.method(O, 'resolveLiveCredential', async () => ({ source: 'environment', token: 'synthetic' }));
    mock.method(O, 'fetchLunchMoneyLive', async () => {
      const raw = H.rawPayload(w);
      return { ...raw, provider: 'lunchmoney', accounts: raw.plaid_accounts,
        transactionWindow: { ...raw.transactionWindow, truncated: false },
        pendingCoverage: { ...raw.pendingCoverage, truncated: false },
        recurringItems: read([pairedItem(price, tx)]) };
    });
    for (const [itemPrice, status, actual, remaining, balance] of [
      ['80.00', 'PAID', 79.5, 0, 920.5],
      ['40.00', 'still due', null, 40, 880.5],
    ]) {
      price = itemPrice;
      let observation;
      const data = await Live.applyForServer(canonical, { ATLAS_LIVE_OVERLAY: 'live' },
        { onObservation(value) { observation = value; } });
      const view = F.recommend(data.plan, w.asOf, { currentPeriodActuals: data.liveOverlay.currentPeriodActuals,
        debts: data.debts }).defaultView;
      const row = view.calendarPeriods.find(period => period.start === '2026-10-09').bills.find(b => b.id === 'band');
      ok(observation?.qualified === true && !!observation.evidence && data.liveOverlay.applied === true
        && J(canonical) === baseline, 'complete replay-proven provider refresh, same canonical opening');
      ok(row.status === status && row.amount === Number(price) && (row.actual ?? null) === actual
        && row.remaining === remaining && view.billsAccountPeriodBalance.amount === balance,
        `an unrecorded debit is judged at the current price ${price} on each fresh read`,
        J([row.status, row.actual, row.remaining, view.billsAccountPeriodBalance.amount]));
    }
    // A saved close is read from its captured publication, even when the
    // live rebuilt period would now withhold that debit at the lower price.
    const History = require('../scripts/private-period-history');
    const Pg = require('../scripts/private-period-history-postgres');
    w.asOf = '2026-10-24';
    price = '80.00';
    const raw = await O.fetchLunchMoneyLive();
    const captured = History.captureClosing({ data: canonical, payload: raw, accountMap: H.accountMapOf(w),
      identity: H.identityOf(w), periods: [] }, { now: () => new Date('2026-10-24T18:01:00Z') });
    const record = Pg.project(captured);
    price = '40.00';
    const current = await Live.applyForServer(canonical, { ATLAS_LIVE_OVERLAY: 'live' });
    const views = F.recommend(current.plan, w.asOf, { currentPeriodActuals: current.liveOverlay.currentPeriodActuals,
      debts: current.debts, periods: [], periodHistory: [record] }).payPeriodViews;
    const closed = views.find(period => period.start === '2026-10-09');
    const saved = closed?.bills.find(bill => bill.id === 'band');
    ok(current.plan.bills.find(bill => bill.id === 'band')?.amount === 40
      && closed?.capturedClose?.kind === 'closing' && saved?.status === 'PAID'
      && saved.actual === 79.5 && saved.planned === 80 && saved.remaining === 0,
      'the previous period prints the saved close and its original paid amount after the price drops',
      J([closed?.capturedClose?.kind, saved?.status, saved?.planned, saved?.actual, saved?.remaining]));
  } finally {
    mock.restoreAll();
  }
}
async function finish() {
  await verifyRepeatRefresh();
  console.log(`\n${checks - failures}/${checks} passed`);
  if (failures) process.exitCode = 1;
}
finish().catch(error => { console.error(error); process.exitCode = 1; });
