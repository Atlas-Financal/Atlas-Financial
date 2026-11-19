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

console.log('8. A held leg counts as already in the opening only when the opening holds it');
{
  // Atlas BLOCKERS on #1405 at 58d5c26b: one rule, the opening's own membership (earlyReceiptLegInOpening). Invented
  // household of realistic size (held-other-income-search-world): an unproven 450 benefit on the 20th; a 450 Other
  // Income credit is held for it. Each case models the opening's real content and must read its control's close.
  const World = require('./fixtures/held-other-income-search-world');
  const close = ({ asOf, snapshot = null, receipt = null, chequingBump = 0, toSavings = false }) => {
    const d = World.build({ asOf, receipts: receipt ? [{ id: 'r', date: receipt, amount: 450 }] : [] });
    if (snapshot) d.plan.opening.paydaySnapshot = { ...snapshot };
    else delete d.plan.opening.paydaySnapshot;
    d.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value += chequingBump;
    if (toSavings) {
      for (const tx of d.liveOverlay.currentPeriodActuals.transactions) {
        if (tx.categoryLabel === 'Other Income') { tx.accountRole = 'household-reserve'; tx.atlasAccountId = tx.account = 'savings'; }
      }
    }
    const advice = F.recommend(d.plan, asOf, World.recommendOptions(d));
    const p = advice.defaultView.calendarPeriods.find(period => period.start <= asOf && period.end >= asOf);
    return { source: p.openingSource, close: p.plannedPeriodClose };
  };
  const snap = opening => ({ periodStart: '2026-11-13', asOf: '2026-11-13', opening });
  // (1) Same-day leg, two opening sources side by side.
  const pmControl = close({ asOf: '2026-11-13' });
  const pm = close({ asOf: '2026-11-13', receipt: '2026-11-13', chequingBump: 450 });
  ok(pmControl.source === 'payday-morning' && pm.source === 'payday-morning' && pm.close === pmControl.close,
    'payday-morning posted cash holding a same-day posted 450: the close does not add the benefit again (= control)',
    JSON.stringify([pm.close, pmControl.close]));
  const snapControl = close({ asOf: '2026-11-16', snapshot: snap(900) });
  const sameDay = close({ asOf: '2026-11-16', snapshot: snap(900), receipt: '2026-11-13' });
  ok(snapControl.source === 'snapshot' && sameDay.close === snapControl.close,
    'a frozen morning snapshot never holds that day\'s 450: the benefit is still added in full (= control)',
    JSON.stringify([sameDay.close, snapControl.close]));
  // (2) Account membership: a pre-opening posted credit on Bills (chequing) is in the opening; on Savings it is not.
  const bills = close({ asOf: '2026-11-16', snapshot: snap(900 + 450), receipt: '2026-11-10' });
  ok(bills.close === snapControl.close, 'a posted 450 on chequing before the snapshot (inside it): the close does not add it again (= control)',
    JSON.stringify([bills.close, snapControl.close]));
  const savings = close({ asOf: '2026-11-16', snapshot: snap(900), receipt: '2026-11-10', toSavings: true });
  ok(savings.close === snapControl.close,
    'the same 450 posted to Savings is not in the chequing opening: nothing is taken out of the close (= control)',
    JSON.stringify([savings.close, snapControl.close]));
}

console.log('9. Next-period carry: a carried opening holds what its source period held, no more');
{
  // Invented figures input card-paid-clear (payroll 1000 biweekly from Oct 2, snapshot 500 on Oct 2, as of Oct 7),
  // plus an unproven 400 side income on the 20th, which falls in the next period (Oct 16 to 29, carried forward).
  const Snap = require('../scripts/figures-snapshot.js');
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'figures-inputs', 'card-paid-clear.json'), 'utf8'));
  const credit = (date, amount) => ({ currency: 'cad', id: 'early-1', date, amount: -amount, pending: false,
    categoryLabel: 'Other Income', isIncome: true, excludeFromTotals: false, excludeFromBudget: false,
    accountRole: 'household-cash', atlasAccountId: 'chequing-a', account: 'chequing-a', payee: 'Invented payer',
    merchantKnown: true, isGroup: false, parentId: null });
  const closes = ({ tx = null, snapshotBump = 0 }) => {
    const doc = structuredClone(base), d = doc.data;
    d.plan.income.push({ id: 'side', label: 'Invented side income', frequency: 'monthly', day: 20, amount: 400, confidence: 'confirmed' });
    d.plan.opening.paydaySnapshot.opening += snapshotBump;
    d.liveOverlay.currentPeriodActuals.transactions = tx ? [tx] : [];
    const advice = F.recommend(d.plan, d.meta.asOf, Snap.pageOptions(d, doc.periods == null ? null : structuredClone(doc.periods)));
    const [current, next] = advice.defaultView.calendarPeriods.filter(p => p.end >= d.meta.asOf);
    return { current: current.plannedPeriodClose, next: next.plannedPeriodClose, nextSource: next.openingSource };
  };
  const ctl = closes({});
  ok(ctl.nextSource === 'carry-forward' && Number.isFinite(ctl.next), 'control: the next period carries a known close',
    JSON.stringify(ctl));
  // A posted 1400 on Oct 1, inside the Oct 2 snapshot: 1000 against Oct 2's payroll, the 400 excess against Oct 20.
  const pre = closes({ tx: credit('2026-10-01', 1400), snapshotBump: 1400 });
  ok(pre.current === ctl.current + 400 && pre.next === ctl.next,
    'a posted 1400 before the opening: the current close keeps the 400 for Oct 20, and the next period does not add it '
    + 'again (next close = control)', JSON.stringify([pre, ctl]));
  // A posted 2400 on Oct 5, after the opening: held (not relied on), so it is in neither close nor the carry, and the
  // next period still adds its occurrences in full.
  const inPeriod = closes({ tx: credit('2026-10-05', 2400) });
  ok(inPeriod.current === ctl.current && inPeriod.next === ctl.next,
    'a posted 2400 after the opening is not in the carried opening: the next period still adds its paydays (= control)',
    JSON.stringify([inPeriod, ctl]));
}

if (failures) { console.log(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll early salary credit run-up checks passed.');
