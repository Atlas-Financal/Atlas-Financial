'use strict';
/* LEDGER B: an early or split salary credit is held To confirm over the run-up and its payday is counted once.
 * Invented world as test-amanda-pay-early-plain-credit (Dale 1400 biweekly from Fri Oct 9; Amanda 2000 on the 15th
 * and 2200 at month-end), via the acceptance harness and live-plan. Every expected figure is the control's own
 * published value or hand-derived above. `node test/test-early-salary-credit-counted-once.js`
 */
const fs = require('node:fs');
const path = require('node:path');
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const IDENTITY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'connectivity', 'transaction-identity.json'), 'utf8'));
const RULES = IDENTITY.rules.filter(rule => ['amandaSalary15', 'amandaSalaryMonthEnd'].includes(rule.eventId));
ok(RULES.length === 2 && RULES.every(rule => rule.settlesWhen === 'near-scheduled-amount-and-payday'
  && rule.amountToleranceDollars === 5 && rule.postingBusinessDays === 3), 'the shipped rules are the owner\'s: $5, 3 business days');

const TENNIS = 9010;
let nextId = 800000;
// A deposit into Bills: by default from the invented salary payee alias (a sign of salary) in the Payroll category, not a transfer.
const bills = (date, amount, extra = {}) => H.lm({ id: ++nextId, date, amount: -amount, category: extra.category || 'Payroll',
  account: 'chequing-a', payee: extra.payee || 'Invented Tennis PAY', pending: extra.pending, raw: extra.raw,
  notes: extra.notes, tagIds: extra.tagIds });

function serve({ asOf = '2026-10-22', txs = [], monthEndDay = 31, monthEndAmount = 2200, categories = [], tags = [], shippedPatterns = false, monthEndFirstDue = null, snapshot = null }) {
  const w = H.baseWorld(asOf);
  w.categories = w.categories.concat(categories);
  w.tags = tags;
  w.windowStart = '2026-08-02';
  w.accounts.push({ id: 'tennis', providerId: TENNIS, role: 'household-external', collection: 'cash',
    label: 'Invented tennis income', value: 0, held: true, externalId: 'tennis-income' });
  w.income.push(
    { id: 'amandaSalary15', label: 'Invented salary (15th)', frequency: 'monthly', day: 15, firstDue: '2026-08-15', amount: 2000, confidence: 'confirmed' },
    { id: 'amandaSalaryMonthEnd', label: 'Invented salary (month-end)', frequency: 'monthly', day: monthEndDay, amount: monthEndAmount, confidence: 'confirmed', ...(monthEndFirstDue ? { firstDue: monthEndFirstDue } : {}) });
  // The shipped rules, with an invented employer alias for the early-receipt hold's salary source.
  w.identityRules = w.identityRules.concat(JSON.parse(JSON.stringify(RULES))
    .map(rule => shippedPatterns ? rule : ({ ...rule, salaryReceiptPayeePatterns: ['Invented Tennis PAY'] })));
  w.transactions = [H.lm({ id: 799999, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' }), ...txs];
  // An explicit payday snapshot (the dated opening production reads), when a case needs one.
  if (snapshot) w.planPatch = plan => { plan.opening = { ...(plan.opening || {}), paydaySnapshot: { ...snapshot } }; };
  H.productionOpening(w);
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload: H.rawPayload(w),
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  if (r.error) throw r.error;
  const packet = r.data.liveOverlay.currentPeriodActuals;
  const adv = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: packet, debts: r.data.debts });
  const current = adv.defaultView.calendarPeriods.find(p => p.start <= asOf && p.end >= asOf);
  const rowOf = (id, date) => adv.defaultView.calendarPeriods.flatMap(p => p.income || [])
    .find(row => row.id === id && row.date === date) || null;
  const views = adv.payPeriodViews || [];
  const next = views.find(v => v.timelineRole === 'next') || null;
  return {
    current, next,
    bad: current.balanceAfterDeductions, close: current.plannedPeriodClose,
    live: r.data.liveOverlay.operatingPlan === 'live',
    held: r.data.liveOverlay.operatingPlan === 'unavailable',
    settled: (packet.representedActuals || []).filter(x => /^amandaSalary/.test(x.id))
      .map(x => x.id.replace('amandaSalary', '') + '@' + x.date + ':' + Math.abs(x.actual)).sort(),
    rowOf,
    income: current.incomeTotal,
    incomeTrust: current.incomeTrust,
    otherIncome: current.otherIncome && current.otherIncome.amount,
    future: F.expandEvents(r.data.plan, asOf, '2026-12-31', {}).filter(e => /^amandaSalary/.test(e.id)).map(e => e.date + ':' + e.amount),
    served: r.data,
  };
}

// ----------------------------------------------------------------------------------------------------------------
// LEDGER B (ATLAS LEAD 11, 2026-11-19; BACKLOG "Amanda's early pay can still count twice when it carries no sign of
// salary or arrives split"). Forecast's own hold (calendarIncomeSections, scheduledIncomeHeldIds) keeps a credit that
// could be an unproven salary occurrence To confirm, not relied on, so the occurrence is counted once. It read only 3
// calendar days either side; her pay can arrive earlier in the run-up, and Tue Oct 27 is 3 business days but 4
// calendar days before Sat Oct 31, so an early or split pay counted twice. The hold now starts the day after the
// income's previous occurrence (one cadence interval back for a first occurrence); the late side is unchanged. Each
// credit belongs to its nearest unproven occurrence only. Hand-derived control for the current period (Oct 23 to Nov
// 5, as of Wed Oct 28): income 1400 (Dale Oct 23) + 2200 (Oct 31) = 3600; BAD 3200 and planned close 7700 as the
// shipped control publishes them, and every case below must read exactly those.
const oct15 = () => bills('2026-10-15', 2000);
const payroll = (date, amount, payee = 'Invented deposit') => H.lm({ id: ++nextId, date, amount: -amount, category: 'Payroll',
  account: 'chequing-a', payee });
const once = (s, control, why) => ok(s.live && s.income === control.income && s.bad === control.bad && s.close === control.close,
  why + ': counted once (income ' + control.income + ', BAD ' + control.bad + ', close ' + control.close + ')',
  JSON.stringify([s.live, s.income, s.bad, s.close]));
const heldRow = (s, amount) => (s.current.income || []).find(row => /^other-income:/.test(row.id) && row.amount === amount
  && row.notReliedUpon === true && row.notReliedUponReason === 'possible-scheduled-income-receipt' && row.status === 'unresolved');

console.log('1. (a) an early pay with no sign of salary, outside the owner window');
const control = serve({ asOf: '2026-10-28', txs: [oct15()] });
ok(control.live && control.income === 3600, 'control: income 3600 (1400 + 2200)', JSON.stringify([control.income, control.bad, control.close]));
{
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), payroll('2026-10-27', 2190)] });
  once(s, control, 'a Payroll-filed 2190 from a non-salary payee, Tue Oct 27 ($10 off, 3 business days early)');
  ok(!!heldRow(s, 2190), 'it is listed To confirm, not relied on, as a possible receipt of Oct 31');
  ok(!!s.rowOf('amandaSalaryMonthEnd', '2026-10-31') && s.rowOf('amandaSalaryMonthEnd', '2026-10-31').amount === 2200,
    'Oct 31 is still projected once at 2200');
}
// A credit before the current period (Oct 23) is already inside its opening cash. With Dale's Oct 23 received, only
// Oct 31's run-up (from Oct 16) holds it, so Oct 31 is not added again at the close.
const dale = () => payroll('2026-10-23', 1400, 'Invented employer');
const paid = serve({ asOf: '2026-10-28', txs: [oct15(), dale()] });
ok(paid.live, 'control with Dale\'s Oct 23 received', JSON.stringify([paid.income, paid.bad, paid.close]));
{
  const earlier = serve({ asOf: '2026-10-28', txs: [oct15(), dale(), payroll('2026-10-20', 2200)] });
  ok(earlier.live && earlier.income === paid.income && earlier.bad === paid.bad && earlier.close === paid.close,
    'the same pay on Tue Oct 20, 8 business days early, before the period: income and BAD as the control; the close does '
    + 'not add Oct 31 again (its cash is in the opening, so the close is the control\'s)',
    JSON.stringify([earlier.income, earlier.bad, earlier.close, paid.close]));
}

console.log('2. (b) a pay split into two credits, each under half');
for (const [why, txs] of [
  ['salary-alias 1000 + 1050, Tue Oct 27', () => [bills('2026-10-27', 1000), bills('2026-10-27', 1050)]],
  ['Payroll-filed non-salary 1100 + 1100, Tue Oct 27', () => [payroll('2026-10-27', 1100), payroll('2026-10-27', 1100)]],
]) {
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), ...txs()] });
  once(s, control, why);
}
{
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), dale(), payroll('2026-10-19', 1000), payroll('2026-10-27', 1200)] });
  ok(s.live && s.income === paid.income && s.bad === paid.bad && s.close === paid.close,
    'Payroll-filed non-salary 1000 Mon Oct 19 (before the period) + 1200 Tue Oct 27: counted once; the close does not '
    + 'add Oct 31 again, and the 1000 already in the opening is not added either',
    JSON.stringify([s.income, s.bad, s.close, paid.close]));
}

console.log('3. The Mon Oct 26 case, for the right reason');
{
  // With Dale's Oct 23 pay received, nothing else is near Oct 26: Amanda's run-up holds it.
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), dale(), payroll('2026-10-26', 2200)] });
  once(s, paid, 'a Payroll-filed 2200 on Mon Oct 26 with Dale\'s Oct 23 already received');
  ok(!!heldRow(s, 2200), 'held To confirm as a possible receipt of Oct 31, not of Dale\'s Oct 23');
}

console.log('4. Unchanged: an on-time pay, a credit under half, and two incomes keep their own credits');
{
  const onTime = serve({ asOf: '2026-10-30', txs: [oct15(), bills('2026-10-30', 2200)] });
  ok(onTime.live && onTime.settled.includes('MonthEnd@2026-10-31:2200') && onTime.income === 3600,
    'a salary-payee 2200 on Fri Oct 30 settles Oct 31 once (received), income 3600', JSON.stringify([onTime.settled, onTime.income]));
  const small = serve({ asOf: '2026-10-28', txs: [oct15(), bills('2026-10-27', 1050)] });
  ok(small.live && small.income === 3600 + 1050 && !heldRow(small, 1050),
    'a single 1050 (under half of 2200) is ordinary Other income, counted; Dale\'s Nov 6 (1050 is over half of 1400) does not take it',
    JSON.stringify([small.income, small.otherIncome]));
}

{
  // Dale's Oct 23 also unproven: the Oct 20 2200 is nearest Dale's Oct 23, which takes 1400 of it at the close; the
  // 800 excess counts against Oct 31 (its run-up holds Oct 20 too), never added again. Close = the control's (7700),
  // the reading if the credit was Amanda's; if it was Dale's (a 2200 pay on a 1400 plan) this understates by 800.
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), payroll('2026-10-20', 2200)] });
  ok(s.live && s.income === control.income && s.bad === control.bad && s.close === control.close,
    'Dale\'s Oct 23 and Oct 31 both unproven, one 2200 credit on Oct 20 before the period: neither occurrence adds '
    + 'it again at the close (close = the control\'s; never above it)', JSON.stringify([s.income, s.bad, s.close, control.close]));
}

{
  // A PENDING early credit before the opening is not in the opening snapshot: it stays held (counted once, not
  // relied on), and the close still adds Oct 31 in full (Codex P1 on #1405; lead blocker 2026-11-19).
  const pendingPay = () => H.lm({ id: ++nextId, date: '2026-10-20', amount: -2200, category: 'Payroll',
    account: 'chequing-a', payee: 'Invented deposit', pending: true });
  const snapshot = { periodStart: '2026-10-23', asOf: '2026-10-23', opening: 4500 };
  const snapControl = serve({ asOf: '2026-10-28', snapshot, txs: [oct15(), dale()] });
  const s = serve({ asOf: '2026-10-28', snapshot, txs: [oct15(), dale(), pendingPay()] });
  ok(snapControl.close === 7700, 'control with a 4500 Oct 23 snapshot: close 7700', String(snapControl.close));
  ok(s.live && s.income === snapControl.income && s.bad === snapControl.bad && s.close === 7700,
    'a pending 2200 on Oct 20, before the period: income and BAD as the control, and the close stays 7700 (pending '
    + 'cash is not in the opening, so Oct 31 is not taken out)', JSON.stringify([s.income, s.bad, s.close]));
}

console.log('5. A first occurrence holds over one cadence interval back');
{
  // Oct 31 is the stream's first occurrence (firstDue), so no previous one is in the data: one month back (Oct 1).
  const first = serve({ asOf: '2026-10-28', monthEndFirstDue: '2026-10-31', txs: [oct15(), dale()] });
  const s = serve({ asOf: '2026-10-28', monthEndFirstDue: '2026-10-31', txs: [oct15(), dale(), payroll('2026-10-20', 2200)] });
  ok(s.live && s.income === first.income && s.bad === first.bad && s.close === first.close,
    'a Payroll-filed 2200 on Tue Oct 20 before the stream\'s first occurrence (a 3-day window would miss it): held, '
    + 'and Oct 31 is not added again at the close', JSON.stringify([s.income, s.bad, s.close, first.close]));
}

console.log('6. Known cautious limit: a payday that passes unproven, beside a held credit, is counted by neither');
{
  // As of Mon Nov 2 the Oct 27 credit is still held (Oct 31 never proven) and Oct 31 itself is To confirm.
  const s = serve({ asOf: '2026-11-02', txs: [oct15(), payroll('2026-10-27', 2190)] });
  const row = s.rowOf('amandaSalaryMonthEnd', '2026-10-31');
  ok(s.live && !!heldRow(s, 2190) && row && row.status !== 'received' && row.alreadyInCash !== true,
    'the credit stays To confirm and Oct 31 is not received: neither is relied on (understates, never overstates)',
    JSON.stringify([s.live, row && row.status]));
}

console.log('7. The next period carries the same cash as the control');
{
  const s = serve({ asOf: '2026-10-28', txs: [oct15(), payroll('2026-10-27', 2190)] });
  ok(s.next && control.next && s.next.balanceAfterDeductions === control.next.balanceAfterDeductions
    && s.next.plannedPeriodClose === control.next.plannedPeriodClose,
    'next period BAD and close equal the control\'s', JSON.stringify([s.next && s.next.balanceAfterDeductions, control.next && control.next.balanceAfterDeductions]));
}

console.log('8. Each held leg against the cash that seeds the close: inside, outside or unproven');
// Atlas ruling (Plan #6) on #1405: a leg the seed provably holds is not added again (inside); a leg it provably does
// not hold leaves the occurrence added in full and the close known (outside); anything else withholds the close and
// every carry from it (unproven, early-receipt-membership-unproven). Every expected close is the matching control's.
const UNPROVEN = /early-receipt-membership-unproven/;
const World = require('./fixtures/held-other-income-search-world');
{
  // Invented household (held-other-income-search-world): an unproven 450 benefit on the 20th holds a 450 Other Income
  // credit. The period runs Nov 13 to 26. bump models a posted balance that holds the credit.
  const seeded = ({ asOf = '2026-11-16', snapshot = null, base = null, gap = null, receipt = null, bump = 0, account = null }) => {
    const d = World.build({ asOf, receipts: receipt ? [{ id: 'r', date: receipt, amount: 450 }] : [] });
    if (snapshot) d.plan.opening.paydaySnapshot = { periodStart: '2026-11-13', asOf: '2026-11-13', opening: snapshot };
    else delete d.plan.opening.paydaySnapshot;
    if (base) d.plan.opening.asOf = base;
    d.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value += bump;
    for (const tx of d.liveOverlay.currentPeriodActuals.transactions) {
      if (tx.categoryLabel !== 'Other Income' || !account) continue;
      if (account === 'savings') { tx.accountRole = 'household-reserve'; tx.atlasAccountId = tx.account = 'savings'; }
      if (account === 'ambiguous') { tx.account = 'chequing-b'; }
    }
    const options = World.recommendOptions(d);
    if (gap) options.paydayGapCash = gap;
    const p = F.recommend(d.plan, asOf, options).defaultView.calendarPeriods.find(x => x.start <= asOf && x.end >= asOf);
    return { source: p.openingSource, close: p.plannedPeriodClose, reason: p.plannedPeriodCloseReason || '' };
  };
  const same = (got, ctl, why) => ok(got.source === ctl.source && Number.isFinite(ctl.close) && got.close === ctl.close,
    why + ' (= control ' + ctl.close + ')', JSON.stringify([got.source, got.close, ctl.close]));
  const withheld = (got, source, why) => ok(got.source === source && got.close === null && UNPROVEN.test(got.reason),
    why + ': close withheld (early-receipt-membership-unproven)', JSON.stringify([got.source, got.close]));
  // Frozen morning snapshot (Nov 13): before = inside; same day and after = outside.
  const snapCtl = seeded({ snapshot: 900 });
  same(seeded({ snapshot: 900 + 450, receipt: '2026-11-10' }), snapCtl, 'snapshot, posted 450 on chequing before it: inside, not added again');
  same(seeded({ snapshot: 900, receipt: '2026-11-13' }), snapCtl, 'snapshot, posted 450 on the snapshot day: outside (a morning snapshot holds none of that day)');
  same(seeded({ snapshot: 900, receipt: '2026-11-14' }), snapCtl, 'snapshot, posted 450 after it: outside');
  same(seeded({ snapshot: 900, receipt: '2026-11-10', account: 'savings' }), snapCtl, 'snapshot, the 450 on Savings before it: outside (not in the chequing opening)');
  withheld(seeded({ snapshot: 900, receipt: '2026-11-10', account: 'ambiguous' }), 'snapshot', 'snapshot, a leg whose account aliases disagree');
  // Payday-morning posted balance (as of Nov 13): before = inside; same day = unproven.
  const pmCtl = seeded({ asOf: '2026-11-13' });
  same(seeded({ asOf: '2026-11-13', receipt: '2026-11-11', bump: 450 }), pmCtl, 'payday-morning posted cash, posted 450 before it: inside');
  withheld(seeded({ asOf: '2026-11-13', receipt: '2026-11-13', bump: 450 }), 'payday-morning',
    'payday-morning posted cash, a same-day posted 450 (may or may not be in that balance)');
  // Zero-gap cutover-walk (dated opening = the period start): a posted balance, so the same rules.
  const zeroCtl = seeded({ base: '2026-11-13' });
  same(seeded({ base: '2026-11-13', receipt: '2026-11-11', bump: 450 }), zeroCtl, 'zero-gap walk, posted 450 before it: inside');
  withheld(seeded({ base: '2026-11-13', receipt: '2026-11-13', bump: 450 }), 'cutover-walk', 'zero-gap walk, a same-day posted 450');
  // Reconstructing cutover-walk (posted cash Nov 10 walked to the Nov 13 morning): before the base = inside; on the
  // base or in the gap = unproven (its gap movements carry no transaction identity); the morning on = outside.
  const gap = { complete: true, coverageStart: '2026-11-11', coverageThrough: '2026-11-16', movements: [] };
  const walkCtl = seeded({ base: '2026-11-10', gap });
  ok(walkCtl.source === 'cutover-walk' && Number.isFinite(walkCtl.close), 'reconstructing walk control has a known close', JSON.stringify(walkCtl));
  same(seeded({ base: '2026-11-10', gap, receipt: '2026-11-09', bump: 450 }), walkCtl, 'reconstructing walk, posted 450 before its base: inside');
  withheld(seeded({ base: '2026-11-10', gap, receipt: '2026-11-10', bump: 450 }), 'cutover-walk', 'reconstructing walk, a 450 on its base day');
  withheld(seeded({ base: '2026-11-10', gap, receipt: '2026-11-11' }), 'cutover-walk', 'reconstructing walk, a 450 in its gap');
  same(seeded({ base: '2026-11-10', gap, receipt: '2026-11-13' }), walkCtl, 'reconstructing walk, a 450 on the morning it reaches: outside');
}

console.log('9. Carries: a carried opening holds what the seed it was built from held, no more');
const Snap = require('../scripts/figures-snapshot.js');
const inventedInput = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'figures-inputs', name + '.json'), 'utf8'));
const otherIncome = (date, amount, account = 'chequing-a') => ({ currency: 'CAD', id: 'early-1', date, amount: -amount,
  pending: false, isIncome: true, savingsPostingEvidence: 'posted', categoryLabel: 'Other Income', excludeFromTotals: false,
  excludeFromBudget: false, accountRole: 'household-cash', atlasAccountId: account, account, payee: 'Invented payer',
  displayedPayee: 'Invented payer', merchantKnown: true, isGroup: false, parentId: null });
// Both inputs: payroll biweekly from Oct 2, as of Oct 7, a frozen Oct 2 snapshot, plus an unproven 400 side income on
// the 20th (in the next period, Oct 16 to 29). A credit before the snapshot is in the snapshot and in posted cash.
const carried = (name, { tx = null, inSnapshot = false, observed = false, sideDay = 20, firstDue = null, bill = 0, billDate = '2026-10-20', views = false }) => {
  const doc = structuredClone(inventedInput(name)), d = doc.data;
  d.plan.income.push({ id: 'side', label: 'Invented side income', frequency: 'monthly', day: sideDay, amount: 400,
    confidence: 'confirmed', ...(firstDue ? { firstDue } : {}) });
  if (bill) d.plan.bills.push({ id: 'invented-big', label: 'Invented big bill', frequency: 'once', date: billDate, amount: bill, confidence: 'confirmed' });
  if (tx) {
    d.liveOverlay.currentPeriodActuals.transactions.push(tx);
    const amount = -tx.amount;
    const rows = [d.plan.startingCash.breakdown, ...(observed ? [d.liveOverlay.observedCash.accounts] : [])];
    // Posted cash only, on an account the input lists (a pending credit is in no balance).
    if (tx.pending === false) {
      for (const list of rows) { const row = list.find(r => r.id === tx.atlasAccountId); if (row) row.value = roundTo(row.value + amount); }
    }
    if (inSnapshot) d.plan.opening.paydaySnapshot.opening = roundTo(d.plan.opening.paydaySnapshot.opening + amount);
  }
  const advice = F.recommend(d.plan, d.meta.asOf, Snap.pageOptions(d, doc.periods == null ? null : structuredClone(doc.periods)));
  const ps = (views ? advice.payPeriodViews : advice.defaultView.calendarPeriods).filter(p => p.end >= d.meta.asOf);
  return { current: ps[0].plannedPeriodClose, next: ps[1].plannedPeriodClose, nextSource: ps[1].openingSource,
    nextReason: ps[1].plannedPeriodCloseReason || '', nextSweep: ps[1].paydaySweep,
    third: ps[2] ? ps[2].plannedPeriodClose : undefined, thirdReason: ps[2] ? ps[2].plannedPeriodCloseReason || '' : '' };
};
function roundTo(v) { return Math.round(v * 100) / 100; }
{
  // Noncombined carry (card-paid-clear: the next opening carries the active close).
  const ctl = carried('card-paid-clear', {});
  ok(ctl.nextSource === 'carry-forward' && Number.isFinite(ctl.next), 'noncombined control: the next period carries a known close', JSON.stringify(ctl));
  // A posted 1400 on Oct 1 (inside the snapshot): Oct 2's payroll takes 1000 at the close, the 400 excess is held for
  // Oct 20. The carry holds that 400, so the next period does not add it again.
  const pre = carried('card-paid-clear', { tx: otherIncome('2026-10-01', 1400), inSnapshot: true });
  ok(pre.current === ctl.current + 400 && pre.next === ctl.next,
    'noncombined carry, a posted 1400 inside the snapshot: current = control + 400, next = control', JSON.stringify([pre, ctl]));
  // A posted 2400 on Oct 5, after the snapshot: held, so in neither close nor the carry (outside).
  const after = carried('card-paid-clear', { tx: otherIncome('2026-10-05', 2400) });
  ok(after.current === ctl.current && after.next === ctl.next,
    'noncombined carry, a posted 2400 after the snapshot: outside the carry, next = control', JSON.stringify([after, ctl]));
  // Pooled-to-Bills split: the same 1400 on Weekly (chequing-b), inside the pooled snapshot. The current close counts
  // it as for Bills (current = control + 400), but the carry keeps only the Bills share, so the Weekly 1400 leaves the
  // chain: carry = control carry + 400 - 1400. The 400 side leg is on Weekly, outside that Bills-only carry, so the next
  // period adds the side income in full: next = control - 1000.
  // Unproven withholds the chain: the same 1400 with account aliases that disagree. The current close is withheld
  // and the next period gets no opening at all (no carry, no fallback walk from the same unresolved cash).
  const unknownAccount = carried('card-paid-clear', { tx: { ...otherIncome('2026-10-01', 1400), account: 'chequing-b' }, inSnapshot: true });
  ok(unknownAccount.current === null && unknownAccount.next === null && unknownAccount.nextSource === null,
    'an unproven leg withholds the current close and every later opening (no carry, no fallback walk)',
    JSON.stringify(unknownAccount));
  const weekly = carried('card-paid-clear', { tx: otherIncome('2026-10-01', 1400, 'chequing-b'), inSnapshot: true });
  ok(weekly.current === ctl.current + 400 && weekly.next === ctl.next - 1000,
    'noncombined pooled-to-Bills split, the 1400 on Weekly: its side leg is outside the Bills-only carry (next = control - 1000)',
    JSON.stringify([weekly, ctl]));
}
{
  // Combined Savings (savings-chained-closes: the next opening is seeded from current qualified Bills stock, reconciled
  // through Oct 7). The Oct 2 payroll is a linked receipt, so it claims no credit.
  const ctl = carried('savings-chained-closes', {});
  ok(ctl.nextSource === 'carry-forward' && Number.isFinite(ctl.next), 'combined control: the next period carries the Bills-stock seed', JSON.stringify(ctl));
  // A posted 600 on Bills before the snapshot: the side income's 400 leg is inside the Bills stock, so the next period
  // adds it once (next = control + 200, the unclaimed rest); the current close keeps all 600 (current = control + 600).
  // This seed subtracts a positive boundary credit (its sweep to Savings), so membership is not inherited across it:
  // a posted 600 inside the Bills stock, held 400 for the next period's side income, withholds the next close.
  const bills = carried('savings-chained-closes', { tx: otherIncome('2026-09-30', 600), inSnapshot: true, observed: true });
  ok(bills.current === ctl.current + 600 && bills.next === null && UNPROVEN.test(bills.nextReason),
    'combined, a posted 600 on Bills carried across the seed\'s positive sweep: the next close is withheld, not subtracted',
    JSON.stringify([bills, ctl]));
  // The same 600 on Weekly is chequing too: after the sweep its membership is unproven as well.
  const weekly = carried('savings-chained-closes', { tx: otherIncome('2026-09-30', 600, 'chequing-b'), inSnapshot: true, observed: true });
  ok(weekly.current === ctl.current + 600 && weekly.next === null && UNPROVEN.test(weekly.nextReason),
    'combined, the 600 on Weekly across the positive sweep: withheld', JSON.stringify([weekly, ctl]));
  // A zero boundary credit (a 150 bill on Oct 12 leaves no surplus to sweep) keeps the Bills-stock seed. A 600 on Bills
  // before the snapshot is inside it: the next period adds the 400 leg once (next = control + 200). The same 600 on
  // Weekly is outside the Bills-only stock, though it is inside the pooled snapshot: the next close is the control's.
  const noSweep = { bill: 150, billDate: '2026-10-12' };
  const ctlNoSweep = carried('savings-chained-closes', noSweep);
  ok(ctlNoSweep.nextSweep > 0 && Number.isFinite(ctlNoSweep.next), 'combined zero-credit control: a known next close', JSON.stringify(ctlNoSweep));
  const billsKept = carried('savings-chained-closes', { ...noSweep, tx: otherIncome('2026-09-30', 600), inSnapshot: true, observed: true });
  ok(billsKept.next === ctlNoSweep.next + 200,
    'combined, zero boundary credit, a 600 on Bills inside the stock: next adds the 400 leg once (next = control + 200)',
    JSON.stringify([billsKept, ctlNoSweep]));
  const weeklyKept = carried('savings-chained-closes', { ...noSweep, tx: otherIncome('2026-09-30', 600, 'chequing-b'), inSnapshot: true, observed: true });
  ok(weeklyKept.next === ctlNoSweep.next,
    'combined, zero boundary credit, the 600 on Weekly: outside the Bills-only stock seed (next = control)',
    JSON.stringify([weeklyKept, ctlNoSweep]));
  // The side income on the 12th instead: later in THIS period (after the Oct 7 as-of), so the seed's own future-income
  // term reads the leg. The 400 leg is inside the Bills stock, so the seed adds it once: next = control + 200; the
  // current close (snapshot) also holds it: current = control + 200.
  const ctl12 = carried('savings-chained-closes', { sideDay: 12 });
  const later = carried('savings-chained-closes', { tx: otherIncome('2026-09-30', 600), inSnapshot: true, observed: true, sideDay: 12 });
  ok(Number.isFinite(ctl12.next) && later.current === ctl12.current + 200 && later.next === ctl12.next + 200,
    'combined, a 600 on Bills for a payday later this period: the Bills-stock seed adds its 400 leg once (next = control + 200)',
    JSON.stringify([later, ctl12]));
}

console.log('10. A two-hop carry across a sweep: membership is not inherited across a positive sweep');
{
  // card-paid-clear plus a 400 side income first due Oct 30 (its run-up starts Oct 1; the Oct 16 payroll's starts Oct 3).
  // A posted 1400 on Oct 1, inside the Oct 2 snapshot: Oct 2's payroll takes 1000, the 400 excess is held for Oct 30.
  // The Oct 16 period sweeps its remainder (positive), so the Oct 30 opening no longer proves what the old seed held.
  const opts = { sideDay: 30, firstDue: '2026-10-30', views: true };
  const ctl = carried('card-paid-clear', opts);
  ok(ctl.nextSweep > 0 && Number.isFinite(ctl.third), 'control: Oct 16 sweeps a positive amount and Oct 30 has a known close',
    JSON.stringify(ctl));
  const swept = carried('card-paid-clear', { ...opts, tx: otherIncome('2026-10-01', 1400), inSnapshot: true });
  ok(swept.current === ctl.current + 400 && swept.third === null && UNPROVEN.test(swept.thirdReason),
    'a held leg carried across a positive sweep: Oct 30 is withheld (early-receipt-membership-unproven), not subtracted',
    JSON.stringify([swept, ctl]));
  // A pending leg, and a Savings leg, are outside on their own: the same carry stays known.
  const pending = carried('card-paid-clear', { ...opts, tx: { ...otherIncome('2026-10-01', 1400), pending: true, savingsPostingEvidence: 'pending' } });
  ok(pending.third === ctl.third, 'the same 1400 pending: outside on its own, Oct 30 stays known (= control)', JSON.stringify([pending, ctl]));
  const savings = carried('card-paid-clear', { ...opts, tx: { ...otherIncome('2026-10-01', 1400, 'savings'), accountRole: 'household-reserve' } });
  ok(savings.third === ctl.third, 'the same 1400 on Savings: outside every chequing seed, Oct 30 stays known (= control)', JSON.stringify([savings, ctl]));
  // Zero sweep: a 5000 bill on Oct 20 leaves Oct 16 below zero, so nothing is swept and the seed is inherited. The 400
  // leg is inside it, so Oct 30 adds the side income once: Oct 30 = its control's.
  const ctl0 = carried('card-paid-clear', { ...opts, bill: 5000 });
  const kept = carried('card-paid-clear', { ...opts, bill: 5000, tx: otherIncome('2026-10-01', 1400), inSnapshot: true });
  ok(ctl0.nextSweep === 0 && Number.isFinite(ctl0.third) && kept.third === ctl0.third,
    'a zero sweep keeps the seed: the Oct 1 leg is inside, Oct 30 adds the side income once (= control)', JSON.stringify([kept, ctl0]));
}

console.log('11. Bank-anchor production path: a pending leg alone, or a Savings leg alone, leaves the known close known');
{
  // The invented bank end-of-day anchor fixture (live path, which earns the payday snapshot from the anchor), plus an
  // unproven 400 side income on the 12th.
  const Live2 = require('../scripts/live-plan');
  const { fixture } = require('./fixtures/payday-bank-eod-anchor');
  const base = fixture();
  const live = Live2.fromObservation({ data: base.data, payload: base.payload, accountMap: base.accountMap });
  const leg = extra => ({ id: 'early-1', date: '2026-10-10', amount: -400, currency: 'CAD', pending: false,
    savingsPostingEvidence: 'posted', categoryLabel: 'Other Income', isIncome: true, atlasAccountId: 'chequing-a',
    account: 'chequing-a', accountRole: 'household-cash', payee: 'Invented payer', displayedPayee: 'Invented payer', ...extra });
  const active = tx => {
    const plan = structuredClone(live.data.plan);
    plan.income.push({ id: 'side', label: 'Invented side income', frequency: 'monthly', day: 12, amount: 400, confidence: 'confirmed' });
    const overlay = structuredClone(live.data.liveOverlay);
    if (tx) overlay.currentPeriodActuals.transactions.push(tx);
    const views = F.recommend(plan, base.asOf, { ...base.x.opts, weeklyVariable: 0, debts: [], ...overlay }).payPeriodViews
      .filter(p => p.end >= base.asOf);
    return { source: views[0].openingSource, close: views[0].plannedPeriodClose,
      membership: views.some(p => UNPROVEN.test(p.plannedPeriodCloseReason || '')) };
  };
  const ctl = active(null);
  ok(Number.isFinite(ctl.close), 'bank-anchor control: a known close', JSON.stringify(ctl));
  for (const [why, tx] of [['a pending 400 alone', leg({ pending: true, savingsPostingEvidence: 'pending' })],
    ['a 400 on Savings alone', leg({ date: '2026-09-30', atlasAccountId: 'savings', account: 'savings', accountRole: 'household-reserve' })]]) {
    const got = active(tx);
    ok(got.source === ctl.source && got.close === ctl.close && !got.membership,
      'bank anchor, ' + why + ': the close stays known (= control) and no close is withheld for membership', JSON.stringify([got, ctl]));
  }
}

if (failures) { console.log(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll early salary credit run-up checks passed.');
