'use strict';
/* ATLAS-077 — a present-but-unparseable scheduled amount (null, NaN, a
 * comma-grouped string like "1,900", or a missing amount on a dated
 * protected point requirement) must fail closed through the EXISTING
 * issue/unavailable publication pattern. It must never vanish silently
 * (today: a malformed bill is dropped and the walk publishes a clean $0
 * load under a 'calculated' label) and never be emitted as a NaN cash
 * event (today: commitments/obligations poison simulate totals and
 * every daily balance from the event date onward).
 *
 * Atlas contract ruling 2026-10-16 (Slack thread 1791980813.524529,
 * ts 1792181415.429459) governs this suite:
 *   A — the loud surface is the existing issue/unavailable pattern, not
 *       a new uncaught throw. Unknown scheduled amounts withhold the
 *       affected totals AND dependent spending/funding claims, while
 *       independently known stocks are retained. Existing malformed
 *       statement-contract throws stay unchanged.
 *   B — a dated active protected point requirement with a missing or
 *       malformed amount and no valid range is unknown. Preserved:
 *       valid null-plus-range commitments, explicitly optional undated rows,
 *       optional/disabled/settled cases, and obligation or relief-derived zero. Not all dated
 *       nulls are defects and not all amount-less rows are controls:
 *       the split is requirement-based (dated + non-optional +
 *       unsettled + no valid range), read through the incumbent
 *       commitment helpers, not date/key presence alone. This refines
 *       the Oct-14 probe suite, whose dated amount-less commitment row
 *       was pinned as a control; under the ruling that row is a dated
 *       protected point requirement with a missing amount.
 *   C — detection is at effective-source selection: after statement
 *       replacement, before coercion/caps. A valid statement minimum
 *       supersedes a bad fallback for that occurrence; a later bad
 *       fallback still blocks. Supported finite numeric inputs and
 *       numeric strings are preserved; comma strings are never parsed
 *       partially; no cent restrictions.
 *
 * The named state is Forecast.scheduledAmountState(plan, start, end,
 * opts) -> { status: 'ready' | 'unavailable', unknowns, reason } and is
 * carried through simulate, recommendWeekly, recommend, majorPlans,
 * paydayAllocation (and with it currentPeriodAction), projectDebts and
 * baselineTrajectory. The calendar period waterfalls gate their bill
 * load on the same detector (§J): bills were already covered by the
 * incumbent S1 arm; obligations were not. Pins include mixed valid/invalid inputs and a
 * distant dated requirement that knowledgeHorizon does not extend for
 * (a malformed row carries no need and no range, so the horizon omits
 * it — the requirement is still unknown).
 *
 * Synthetic fixtures only.
 * `node test/test-malformed-amounts-fail-closed.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const AS_OF = '2026-01-01';
const WIN_START = '2026-01-01';
const WIN_END = '2026-02-28';

function planWith(carrier, amount, include) {
  const row = { id: 'probe', label: 'Probe', confidence: 'confirmed' };
  if (carrier === 'bill') Object.assign(row, { frequency: 'once', date: '2026-01-10' });
  if (carrier === 'commitment') Object.assign(row, { date: '2026-01-10' });
  if (carrier === 'obligation') Object.assign(row, { frequency: 'once', date: '2026-01-10' });
  if (include) row.amount = amount;
  const plan = {
    windowDays: 60,
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    startingCash: { breakdown: [
      { id: 'chequing-a', value: 5000 }, { id: 'chequing-b', value: 0 }, { id: 'savings', value: 0 },
    ] },
    opening: { asOf: AS_OF },
    budget: { basis: 'ytd', categories: [] },
    income: [], bills: [], obligations: [], commitments: [],
  };
  if (carrier === 'bill') plan.bills = [row];
  if (carrier === 'commitment') plan.commitments = [row];
  if (carrier === 'obligation') plan.obligations = [row];
  return plan;
}

const stateOf = (plan, start, end, opts) => typeof F.scheduledAmountState === 'function'
  ? F.scheduledAmountState(plan, start || WIN_START, end || WIN_END, opts || {})
  : null;
const isUnavailable = plan => {
  const s = stateOf(plan);
  return !!(s && s.status === 'unavailable');
};
const isReady = plan => {
  const s = stateOf(plan);
  return !!(s && s.status === 'ready');
};
const totalsField = carrier =>
  carrier === 'bill' ? 'bills' : carrier === 'commitment' ? 'commitments' : 'obligations';
const allFiniteOrNull = value => {
  if (value == null) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(allFiniteOrNull);
  if (typeof value === 'object') return Object.values(value).every(allFiniteOrNull);
  return true;
};

/* --- A. The named state detects every defect shape ------------------ */
ok(typeof F.scheduledAmountState === 'function',
  'Forecast.scheduledAmountState is exported');

const MALFORMED = [['null', null, true], ['NaN', NaN, true], ['"1,900"', '1,900', true]];
for (const carrier of ['bill', 'commitment', 'obligation']) {
  for (const [name, amount, include] of MALFORMED) {
    const plan = planWith(carrier, amount, include);
    const s = stateOf(plan);
    ok(s && s.status === 'unavailable'
      && s.unknowns.some(u => u.carrier === carrier && u.id === 'probe'),
      `${carrier} amount ${name}: scheduledAmountState is unavailable naming the row`,
      s ? `status=${s.status}` : 'no state');
  }
}
ok(isUnavailable(planWith('bill', undefined, false)),
  'bill amount missing: scheduledAmountState is unavailable');
ok(isUnavailable(planWith('obligation', undefined, false)),
  'obligation amount missing: scheduledAmountState is unavailable');
/* A dated protected point requirement with NO amount key is a missing
 * amount under Ruling B (requirement-based split), not a control. */
ok(isUnavailable(planWith('commitment', undefined, false)),
  'commitment amount missing on a dated protected point requirement: unavailable');

/* --- B. simulate withholds affected totals and dependent claims ----- */
for (const carrier of ['bill', 'commitment', 'obligation']) {
  const plan = planWith(carrier, null, true);
  const sim = F.simulate(plan, AS_OF, { weeklyVariable: 0 });
  ok(sim.status === 'unavailable' && sim.scheduledAmounts
    && sim.scheduledAmounts.status === 'unavailable',
    `${carrier} null: simulate publishes status unavailable with the named state`,
    `status=${sim.status}`);
  ok(sim.totals[totalsField(carrier)] === null && sim.ending === null
    && sim.min && sim.min.balance === null,
    `${carrier} null: affected total and dependent walk claims are withheld (null)`,
    `totals.${totalsField(carrier)}=${sim.totals[totalsField(carrier)]}`);
  const events = F.expandEvents(plan, WIN_START, WIN_END, {});
  ok(!events.some(e => !Number.isFinite(e.amount))
    && !events.some(e => e.id === 'probe')
    && sim.daily.every(d => d.balance == null || Number.isFinite(d.balance)),
    `${carrier} null: no NaN event is emitted and no daily balance is NaN`);
}

/* --- C. ACR / baseline trajectory ----------------------------------- */
{
  const stub = () => ({ periods: { ytd: { label: 'stub', months: 1, spending: [] } } });
  const mk = amount => {
    const plan = planWith('bill', amount, true);
    plan.startingCash = { breakdown: [
      { id: 'chequing-a', value: 1000 }, { id: 'chequing-b', value: 0 }, { id: 'savings', value: 0 }] };
    return plan;
  };
  for (const [name, amount] of [['null', null], ['"1,900"', '1,900']]) {
    const traj = F.baselineTrajectory(mk(amount), [], AS_OF, { periods: stub() });
    const packet = traj && traj.additionalCashRequired;
    ok(traj && traj.status === 'unavailable'
      && packet && packet.amount === null && packet.status === 'unavailable',
      `bill ${name}: baseline trajectory is unavailable; no trusted calculated $0 ACR`,
      packet ? `{amount:${packet.amount}, status:${packet.status}}` : 'no packet');
  }
  const validTraj = F.baselineTrajectory(mk(1900), [], AS_OF, { periods: stub() });
  const vp = validTraj && validTraj.additionalCashRequired;
  ok(vp && vp.amount === 900 && vp.status === 'calculated',
    'control: valid $1,900 bill still yields ACR {900, calculated}',
    vp ? `{amount:${vp.amount}, status:${vp.status}}` : 'none');
}

/* --- D. Valid controls keep firing ----------------------------------- */
for (const carrier of ['bill', 'commitment', 'obligation']) {
  for (const [name, amount] of [['1900', 1900], ['"1900"', '1900']]) {
    const plan = planWith(carrier, amount, true);
    const events = F.expandEvents(plan, WIN_START, WIN_END, {})
      .filter(e => e.id === 'probe');
    const sim = F.simulate(plan, AS_OF, { weeklyVariable: 0 });
    ok(isReady(plan) && events.length === 1 && events[0].amount === -1900
      && sim.status !== 'unavailable'
      && sim.totals[totalsField(carrier)] === 1900 && sim.min.balance === 3100,
      `${carrier} valid ${name}: state ready, event -1900, totals 1900, min 3100`,
      `events=${events.length} totals=${sim.totals[totalsField(carrier)]} min=${sim.min && sim.min.balance}`);
  }
}

/* --- E. Ruling B preserves ------------------------------------------- */
{
  // Valid null-plus-range commitment: preserved, and the funding
  // sequence still reads the range (no point amount is invented).
  const plan = planWith('commitment', null, true);
  Object.assign(plan.commitments[0], { amountMin: 100, amountMax: 200 });
  const seq = F.fundingSequence(plan, AS_OF, {});
  const row = seq.find(r => r.id === 'probe');
  ok(isReady(plan) && row && row.need === null
    && row.amountMin === 100 && row.amountMax === 200,
    'commitment null amount with a valid range: preserved as a range row');
}
{
  // A required row with neither date nor amount is Unknown, never information-only.
  const plan = planWith('commitment', null, true);
  delete plan.commitments[0].date;
  plan.commitments[0].when = 'TBD';
  const events = F.expandEvents(plan, WIN_START, WIN_END, {});
  ok(isUnavailable(plan) && !events.some(e => e.id === 'probe'),
    'undated required commitment with null amount: Unknown, no event');
}
{
  const plan = planWith('commitment', null, true);
  plan.commitments[0].flexibility = 'optional';
  ok(isReady(plan), 'optional dated commitment with null amount: preserved');
}
{
  const plan = planWith('commitment', null, true);
  const s = stateOf(plan, WIN_START, WIN_END, { disabled: ['probe'] });
  ok(s && s.status === 'ready',
    'disabled dated commitment with null amount: preserved');
}
{
  const plan = planWith('commitment', null, true);
  plan.commitments[0].settledOn = '2025-12-01';
  ok(isReady(plan), 'settled dated commitment with null amount: preserved');
}
for (const carrier of ['bill', 'commitment', 'obligation']) {
  const plan = planWith(carrier, 0, true);
  ok(carrier === 'obligation' ? isReady(plan) : isUnavailable(plan),
    `${carrier} authored zero: only the obligation domain retains known zero`);
}

/* --- F. Ruling C: statement replacement at effective-source selection  */
function statementPlan(windowEnd) {
  const plan = planWith('obligation', '1,900', true);
  Object.assign(plan.obligations[0], {
    frequency: 'monthly', day: 10, firstDue: '2026-01-10',
    effect: 'payment', debtId: 'card', payingAccount: 'chequing-a',
    confidence: 'estimated',
    statementOccurrences: [{ scheduledDate: '2026-01-10', dueDate: '2026-01-10',
      minimum: 123.45, currency: 'cad', confidence: 'confirmed' }],
  });
  delete plan.obligations[0].date;
  return { plan, windowEnd };
}
{
  const { plan } = statementPlan();
  const s = stateOf(plan, '2026-01-01', '2026-01-31');
  const events = F.expandEvents(plan, '2026-01-01', '2026-01-31', {})
    .filter(e => e.id === 'probe');
  ok(s && s.status === 'ready' && events.length === 1 && events[0].amount === -123.45,
    'valid statement minimum supersedes a bad fallback for that occurrence',
    `events=${events.length} amount=${events[0] && events[0].amount}`);
}
{
  const { plan } = statementPlan();
  const s = stateOf(plan, '2026-01-01', '2026-02-28');
  const events = F.expandEvents(plan, '2026-01-01', '2026-02-28', {})
    .filter(e => e.id === 'probe');
  ok(s && s.status === 'unavailable'
    && events.some(e => e.date === '2026-01-10' && e.amount === -123.45),
    'a later occurrence falling back to the bad amount still blocks');
}
{
  // Existing malformed statement-contract throws stay unchanged.
  const { plan } = statementPlan();
  plan.obligations[0].statementOccurrences[0].minimum = 'abc';
  let threw = false;
  try { F.expandEvents(plan, '2026-01-01', '2026-01-31', {}); } catch (e) { threw = true; }
  ok(threw, 'malformed statement contract still throws (incumbent contract)');
}

/* --- G. Mixed valid + invalid inputs ---------------------------------- */
{
  const plan = planWith('bill', 500, true);
  plan.commitments = [{ id: 'bad-commitment', label: 'Bad', date: '2026-01-12',
    amount: null, confidence: 'confirmed' }];
  const s = stateOf(plan);
  const sim = F.simulate(plan, AS_OF, { weeklyVariable: 0 });
  const events = F.expandEvents(plan, WIN_START, WIN_END, {});
  ok(s && s.status === 'unavailable'
    && s.unknowns.length === 1 && s.unknowns[0].carrier === 'commitment',
    'mixed plan: only the malformed carrier is named unknown');
  ok(sim.totals.bills === 500 && sim.totals.commitments === null
    && events.some(e => e.id === 'probe' && e.amount === -500),
    'mixed plan: independently known bill total retained, commitment total withheld',
    `bills=${sim.totals.bills} commitments=${sim.totals.commitments}`);
}

/* --- H. Distant dated requirement knowledgeHorizon would omit --------- */
{
  const plan = planWith('commitment', null, true);
  plan.commitments[0].date = '2027-06-15';
  const horizon = F.knowledgeHorizon(plan, AS_OF, {});
  ok(horizon.end < '2027-06-15',
    'distant malformed requirement does not extend the knowledge horizon (omission documented)',
    `horizon.end=${horizon.end}`);
  const s = stateOf(plan, horizon.start, horizon.end);
  ok(s && s.status === 'unavailable',
    'distant dated protected requirement is still unknown inside the horizon window');
  ok(F.recommendWeekly(plan, AS_OF, {}) === null,
    'distant malformed requirement withholds the weekly spending claim');
}

/* --- I. Consumer propagation ------------------------------------------ */
{
  const bad = planWith('bill', null, true);
  ok(F.recommendWeekly(bad, AS_OF, {}) === null,
    'recommendWeekly withholds (null) when a scheduled amount is unknown');
  const good = F.recommendWeekly(planWith('bill', 1900, true), AS_OF, {});
  ok(typeof good === 'number' && Number.isFinite(good),
    'recommendWeekly still publishes a number for a valid plan', `value=${good}`);
}
{
  const rec = F.recommend(planWith('bill', null, true), AS_OF, {});
  ok(rec.weekly === null
    && rec.scheduledAmounts && rec.scheduledAmounts.status === 'unavailable',
    'recommend withholds its weekly claim and carries the named state',
    `weekly=${rec.weekly}`);
}
{
  const plans = (() => {
    const p = planWith('commitment', 500, true);
    p.commitments.push({ id: 'bad', label: 'Bad', date: '2026-03-01',
      amount: null, confidence: 'confirmed' });
    return F.majorPlans(p, AS_OF, {});
  })();
  ok(plans.length > 0 && plans.every(r => r.verdict === null && r.funded === null),
    'majorPlans withholds verdicts when a scheduled amount is unknown');
}
{
  const alloc = F.paydayAllocation(planWith('bill', null, true), AS_OF, {});
  ok(alloc.status === 'unavailable' && alloc.spendPermission === null
    && alloc.weeklyCap === null,
    'paydayAllocation withholds spending claims when a scheduled amount is unknown',
    `status=${alloc.status}`);
  ok(alloc.currentBalancePublication
    && alloc.currentBalancePublication.amount === 5000,
    'paydayAllocation retains the independently known current-balance stock',
    `amount=${alloc.currentBalancePublication && alloc.currentBalancePublication.amount}`);
  const action = F.currentPeriodAction(planWith('bill', null, true), AS_OF, {});
  ok(action.spendPermission === null,
    'currentPeriodAction (calendar/period surface) withholds spend permission',
    `spendPermission=${action.spendPermission}`);
}
{
  const plan = planWith('obligation', null, true);
  plan.obligations[0].debtId = 'card';
  plan.obligations[0].effect = 'payment';
  const walked = F.projectDebts(plan,
    [{ id: 'card', label: 'Card', balance: 2000, limit: 5000, rate: 0.2 }], AS_OF, {});
  ok(walked.scheduledAmounts && walked.scheduledAmounts.status === 'unavailable',
    'projectDebts carries the named scheduled-amount state');
  ok(allFiniteOrNull(walked.marks),
    'projectDebts marks contain no NaN figure');
}

/* --- J. Calendar totals: the period waterfall bill load ---------------
 * calendarBillSections emits no row for an unknown amount, so a total
 * built from its rows is a row sum (disclosure), not a claim. The claim
 * is the waterfall's periodBillLoad and everything derived from it
 * (Balance After Deductions, predicted ending balance, the leftover and
 * sweep chain). For bills the incumbent S1 arm already nulls the load
 * when the amount is unavailable; obligations had no equivalent arm —
 * a null/"1,900"/NaN obligation published periodBillLoad 0 under a
 * 'calculated' trust label, indistinguishable from an empty plan. The
 * shared detector now gates the load for both carriers, per window. */
const WF_AS_OF = '2026-08-30';
function waterfallPlan(obligations, bills, commitments) {
  return {
    defaults: { targetBuffer: 500 },
    startingCash: { breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }] },
    opening: { asOf: WF_AS_OF },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [{ id: 'payroll', label: 'Payroll', frequency: 'biweekly',
      anchor: '2026-08-14', amount: 2000, confidence: 'confirmed' }],
    obligations: obligations || [], bills: bills || [], commitments: commitments || [],
    budget: { categories: [] },
  };
}
const wfObligation = amount => [{ id: 'wf-ob', label: 'WfOb', frequency: 'monthly', day: 7,
  firstDue: '2026-09-07', amount, confidence: 'confirmed', payingAccount: 'chequing-a' }];
const activePeriodOf = rec => (rec.defaultView.calendarPeriods || [])
  .find(p => p && p.id === 'this-pay-period') || {};
{
  const rec = F.recommend(waterfallPlan(wfObligation(400)), WF_AS_OF, {});
  const p = activePeriodOf(rec);
  ok(p.periodBillLoad === 400 && p.periodBillLoadTrust === 'calculated'
    && p.balanceAfterDeductions === 1600 && p.predictedEndingBalance === 1600,
    'calendar waterfall control: valid obligation publishes its load and derived totals',
    `load=${p.periodBillLoad} balAfterDed=${p.balanceAfterDeductions}`);
}
for (const [name, amount] of [['null', null], ['"1,900"', '1,900'], ['NaN', NaN]]) {
  const rec = F.recommend(waterfallPlan(wfObligation(amount)), WF_AS_OF, {});
  const p = activePeriodOf(rec);
  const next = (rec.defaultView.calendarPeriods || [])
    .find(q => q && q.id === 'next-pay-period') || {};
  ok(p.periodBillLoad === null && p.periodBillLoadTrust === 'unavailable'
    && p.balanceAfterDeductions === null && p.predictedEndingBalance === null,
    `calendar waterfall: obligation amount ${name} makes the window's bill load unknown`,
    `load=${p.periodBillLoad} trust=${p.periodBillLoadTrust}`);
  ok(next.periodBillLoad === 0 && next.periodBillLoadTrust === 'calculated',
    `calendar waterfall: obligation amount ${name} leaves a window with no occurrence ready`,
    `next load=${next.periodBillLoad}`);
}
{
  const rec = F.recommend(waterfallPlan([], [{ id: 'wf-bill', label: 'WfBill',
    frequency: 'monthly', day: 7, amount: null, confidence: 'confirmed',
    payingAccount: 'chequing-a' }]), WF_AS_OF, {});
  const p = activePeriodOf(rec);
  ok(p.periodBillLoad === null && p.periodBillLoadTrust === 'unavailable',
    'calendar waterfall: bill amount null still nulls the load (incumbent S1 arm)',
    `load=${p.periodBillLoad}`);
}
{
  // Boundary: commitments never enter the bill load, so a commitment
  // unknown withholds the plan's spending claims (pinned in §I) but
  // does not null a load it was never part of.
  const rec = F.recommend(waterfallPlan(wfObligation(400), [],
    [{ id: 'wf-c', label: 'WfC', date: '2026-09-05', amount: null,
      confidence: 'confirmed' }]), WF_AS_OF, {});
  const p = activePeriodOf(rec);
  ok(p.periodBillLoad === 400 && p.periodBillLoadTrust === 'calculated',
    'calendar waterfall boundary: commitment unknown does not null the bill load',
    `load=${p.periodBillLoad}`);
}
{
  // Ruling C at the waterfall: the September occurrence is superseded
  // by a valid statement minimum, so the active window's load is the
  // statement figure even though the row fallback is unparseable (the
  // wider state stays unavailable on later fallback occurrences).
  const ob = wfObligation('1,900');
  Object.assign(ob[0], { effect: 'payment', debtId: 'card', confidence: 'estimated',
    statementOccurrences: [{ scheduledDate: '2026-09-07', dueDate: '2026-09-07',
      minimum: 123.45, currency: 'cad', confidence: 'confirmed' }] });
  const rec = F.recommend(waterfallPlan(ob), WF_AS_OF, {});
  const p = activePeriodOf(rec);
  ok(p.periodBillLoad === 123.45 && p.periodBillLoadTrust === 'calculated',
    'calendar waterfall: valid statement minimum supersedes the bad fallback in the load',
    `load=${p.periodBillLoad}`);
}
{
  const rec = F.recommend(waterfallPlan(wfObligation(null)), WF_AS_OF,
    { disabled: ['wf-ob'] });
  const p = activePeriodOf(rec);
  ok(p.periodBillLoad === 0 && p.periodBillLoadTrust === 'calculated',
    'calendar waterfall: a disabled obligation does not null the load (incumbent exclusion)',
    `load=${p.periodBillLoad}`);
}

/* --- K. Repair round (Systems Review BLOCKING on head 70cf0557, B1):
 * the unavailable state must withhold the affected claims at the
 * actual publication boundaries — recommend's sim/zero aliases are
 * raw simulateModel walks that never passed through simulate()'s
 * publication wrapper, the full-horizon knowledge walk nests behind
 * a sliced simulate, and projectDebts' marks reprint future debt
 * values beside the marker. Asserted as withheld VALUES (null), not
 * marker presence. Fixtures are the review's own: as-of 2027-02-01,
 * known opening cash 7200, no income, one once-only row due
 * 2027-02-06 with amount null. */
const K_AS_OF = '2027-02-01';
function plan2027(carrier, amount) {
  const plan = {
    windowDays: 60,
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    startingCash: { breakdown: [
      { id: 'chequing-a', value: 7200 }, { id: 'chequing-b', value: 0 }, { id: 'savings', value: 0 }] },
    opening: { asOf: K_AS_OF },
    budget: { basis: 'ytd', categories: [] },
    income: [], bills: [], obligations: [], commitments: [],
  };
  const row = { id: 'probe', label: 'Probe', confidence: 'confirmed', amount };
  if (carrier === 'bill') { Object.assign(row, { frequency: 'once', date: '2027-02-06' }); plan.bills = [row]; }
  if (carrier === 'commitment') { row.date = '2027-02-06'; plan.commitments = [row]; }
  if (carrier === 'obligation') { Object.assign(row, { frequency: 'once', date: '2027-02-06' }); plan.obligations = [row]; }
  return plan;
}
for (const carrier of ['bill', 'commitment', 'obligation']) {
  const rec = F.recommend(plan2027(carrier, null), K_AS_OF, {});
  ok(rec.scheduledAmounts && rec.scheduledAmounts.status === 'unavailable' && rec.weekly === null,
    `B1 recommend ${carrier} null: named state unavailable, weekly withheld (precondition)`);
  ok(rec.sim.totals[totalsField(carrier)] === null && rec.sim.ending === null
    && rec.zero.ending === null,
    `B1 recommend ${carrier} null: sim/zero walk claims withheld (affected total + endings null)`,
    `totals.${totalsField(carrier)}=${rec.sim.totals[totalsField(carrier)]} sim.ending=${rec.sim.ending} zero.ending=${rec.zero.ending}`);
  ok(rec.knowledge.ending === null && rec.knowledge.freeCash === null
    && rec.knowledge.min && rec.knowledge.min.balance === null && rec.holds === null,
    `B1 recommend ${carrier} null: knowledge ending/freeCash/min and holds withheld`,
    `ending=${rec.knowledge.ending} freeCash=${rec.knowledge.freeCash} holds=${rec.holds}`);
}
{
  // The leak reaches the real assistant projection: the packet's
  // horizon is reprinted from recommend's knowledge, so withholding
  // there must starve the packet's figures (not just its marker).
  const Assistant = require('../scripts/assistant-packet.js');
  const packet = Assistant.buildPacket({
    data: { plan: plan2027('obligation', null), debts: [], meta: { asOf: K_AS_OF } },
    periods: null, questionsMarkdown: '', now: '2027-02-01T12:00:00.000Z', env: {},
  });
  ok(packet.forecast.horizon && packet.forecast.horizon.minBalance === null
    && packet.forecast.horizon.minDate === null,
    'B1 buildPacket: unknown obligation withholds the packet horizon min balance/date',
    `minBalance=${packet.forecast.horizon && packet.forecast.horizon.minBalance}`);
  ok(!(packet.forecast.recommendation && packet.forecast.recommendation.holds === true),
    'B1 buildPacket: recommendation holds is not published as true');
}
{
  // Sliced simulate: the visible 3 days contain no unknown and stay
  // known; the nested 100-day knowledge walk contains the due date
  // and must withhold its own totals/ending/min.
  const sim = F.simulate(plan2027('bill', null), K_AS_OF,
    { weeklyVariable: 0, horizonDays: 100, viewDays: 3 });
  ok(sim.ending === 7200 && sim.totals.bills === 0,
    'B1 sliced simulate: the genuinely independent 3-day slice stays known',
    `ending=${sim.ending} bills=${sim.totals.bills}`);
  ok(sim.knowledge && sim.knowledge.totals.bills === null && sim.knowledge.ending === null
    && sim.knowledge.min && sim.knowledge.min.balance === null,
    'B1 sliced simulate: full-horizon knowledge behind the slice is withheld',
    `knowledge totals.bills=${sim.knowledge && sim.knowledge.totals.bills} ending=${sim.knowledge && sim.knowledge.ending}`);
  const simC = F.simulate(plan2027('commitment', null), K_AS_OF,
    { weeklyVariable: 0, horizonDays: 100, viewDays: 3 });
  ok(simC.knowledge && simC.knowledge.totals.commitments === null
    && simC.knowledge.ending === null,
    'B1 sliced simulate: a commitment unknown withholds the nested knowledge too',
    `knowledge totals.commitments=${simC.knowledge && simC.knowledge.totals.commitments}`);
}
{
  // projectDebts: day-zero stock is known; post-due future metrics
  // (balance 1200 / paid 0 / headroom 2800 when the payment is simply
  // deleted) are the affected claims and must be withheld.
  const mkDebtPlan = amount => {
    const plan = plan2027('obligation', amount);
    Object.assign(plan.obligations[0], { id: 'cardpay', debtId: 'card',
      effect: 'payment', payingAccount: 'chequing-a' });
    return plan;
  };
  const debts = () => [{ id: 'card', label: 'Card', balance: 1200, limit: 4000, rate: 0 }];
  const walked = F.projectDebts(mkDebtPlan(null), debts(), K_AS_OF, {});
  const day0 = walked.marks[0].debts.find(d => d.id === 'card');
  const finalMark = walked.marks[walked.marks.length - 1];
  const final = finalMark.debts.find(d => d.id === 'card');
  ok(walked.scheduledAmounts && walked.scheduledAmounts.status === 'unavailable',
    'B1 projectDebts: named state unavailable (precondition)');
  ok(day0.balance === 1200 && day0.paid === 0 && walked.byId.card.opening === 1200,
    'B1 projectDebts: day-zero stock stays known (opening balance 1200, paid 0 at day 0)');
  ok(final.balance === null && final.paid === null && final.available === null
    && finalMark.headroom === null,
    'B1 projectDebts: post-due balance/paid/headroom withheld (not reprinted 1200/0/2800)',
    `balance=${final.balance} paid=${final.paid} headroom=${finalMark.headroom}`);
  ok(walked.byId.card.balance === null && walked.byId.card.paid === null,
    'B1 projectDebts: byId future balance/paid withheld',
    `byId balance=${walked.byId.card.balance} paid=${walked.byId.card.paid}`);
  const control = F.projectDebts(mkDebtPlan(300), debts(), K_AS_OF, {});
  const cFinalMark = control.marks[control.marks.length - 1];
  const cFinal = cFinalMark.debts.find(d => d.id === 'card');
  ok(cFinal.balance === 900 && cFinal.paid === 300 && cFinalMark.headroom === 3100
    && control.byId.card.balance === 900,
    'B1 projectDebts control: valid payment still publishes balance 900 / paid 300 / headroom 3100',
    `balance=${cFinal.balance} paid=${cFinal.paid} headroom=${cFinalMark.headroom}`);
}
{
  // The affected-total map: a noncash/capitalising obligation feeds
  // totals.noncash, not totals.obligations — withholding must null
  // the field the missing event would actually have fed, and retain
  // the genuinely known cash-obligation total beside it.
  const noncashRow = { id: 'heloc-int', label: 'HELOC interest', confidence: 'confirmed',
    nonCash: true, effect: 'capitalise', frequency: 'monthly', day: 10,
    firstDue: '2026-01-10', amount: null, debtId: 'heloc' };
  const only = planWith('obligation', 200, true);
  only.obligations = [noncashRow];
  const simOnly = F.simulate(only, AS_OF, { weeklyVariable: 0 });
  ok(simOnly.totals.noncash === null && simOnly.totals.obligations === 0,
    'B1 totals map: unknown noncash obligation withholds totals.noncash (obligations stays a complete 0)',
    `noncash=${simOnly.totals.noncash} obligations=${simOnly.totals.obligations}`);
  const mixed = planWith('obligation', 200, true);
  mixed.obligations = [
    { id: 'cash-ob', label: 'Cash ob', confidence: 'confirmed', frequency: 'once',
      date: '2026-01-10', amount: 200 },
    noncashRow,
  ];
  const simMixed = F.simulate(mixed, AS_OF, { weeklyVariable: 0 });
  ok(simMixed.totals.noncash === null && simMixed.totals.obligations === 200,
    'B1 totals map: known cash-obligation total retained while noncash is withheld',
    `noncash=${simMixed.totals.noncash} obligations=${simMixed.totals.obligations}`);
}

/* --- L. Repair round B2: bill event construction classifies the
 * effective source before coercion — booleans, arrays and nonfinite
 * numbers fabricate no monetary event, even though the classifier
 * already names them unknown. */
for (const [name, amount] of [['true', true], ['[475]', [475]], ['Infinity', Infinity]]) {
  const plan = planWith('bill', amount, true);
  const events = F.expandEvents(plan, WIN_START, WIN_END, {});
  ok(isUnavailable(plan) && !events.some(e => e.id === 'probe')
    && events.every(e => Number.isFinite(e.amount)),
    `B2 bill amount ${name}: named unknown and NO bill event is emitted (no fabricated -1/-475/-Infinity)`,
    `probe events=${events.filter(e => e.id === 'probe').length}`);
  const sim = F.simulate(plan, AS_OF, { weeklyVariable: 0 });
  ok(sim.totals.bills === null && allFiniteOrNull(sim.totals)
    && sim.daily.every(d => d.balance == null || Number.isFinite(d.balance)),
    `B2 bill amount ${name}: simulate withholds the bills total and publishes no nonfinite figure`);
}
{
  const plan = planWith('bill', 10.005, true);
  const events = F.expandEvents(plan, WIN_START, WIN_END, {}).filter(e => e.id === 'probe');
  ok(events.length === 1 && events[0].amount === -10.005,
    'B2 control: valid subcent bill amount still emits its exact event',
    `events=${events.length} amount=${events[0] && events[0].amount}`);
}
{
  // A waived occurrence is a legitimate zero: classification must not
  // turn the no-payment control into an unknown or an event.
  const plan = planWith('bill', true, true);
  plan.bills[0].noPaymentRequiredOn = ['2026-01-10'];
  const events = F.expandEvents(plan, WIN_START, WIN_END, {});
  ok(isReady(plan) && !events.some(e => e.id === 'probe'),
    'B2 control: waived (no-payment) occurrence of a malformed bill stays ready, no event');
}

/* --- M. Repair round 3 (Systems Review BLOCKING on head 163959fa,
 * B1a): the packet is a public consumer too — an unknown dated BEFORE
 * a known bill makes the "next due" claim an ordering/completeness
 * claim the packet cannot certify, withheld crossings cannot be
 * republished as a complete empty set, and a null holds must stay
 * null (unknown), not collapse to boolean false. The qualification
 * is claim-scoped: the packet envelope is NOT rerouted through
 * operatingPlan, known stocks stay published, and claims dated
 * before the first unknown are unaffected. Talk verifies claims
 * path/equals against the packet, so a withheld claim must fail
 * verification there too (materializeExplainerAnswer is pure — no
 * provider call; @google/genai is only a lazy import inside ask()). */
const M_AS_OF = '2027-02-01';
function packetPlan(bills, obligations) {
  const plan = plan2027('bill', 0);
  plan.bills = bills || [];
  plan.obligations = obligations || [];
  return plan;
}
const buildPacketFor = (plan, debts) => require('../scripts/assistant-packet.js')
  .buildPacket({
    data: { plan, debts: debts || [], meta: { asOf: M_AS_OF } },
    periods: null, questionsMarkdown: '', now: '2027-02-01T12:00:00.000Z', env: {},
  });
const billRow = (id, label, date, amount) => ({ id, label, confidence: 'confirmed',
  frequency: 'once', date, amount });
{
  const packet = buildPacketFor(packetPlan([
    billRow('unknown-bill', 'Invented unknown bill', '2027-02-06', null),
    billRow('later-bill', 'Invented later bill', '2027-02-10', 125),
  ]));
  const nso = packet.current.nextSignificantObligations;
  ok(nso.nextDue === null && nso.nextPaymentOut === null,
    'B1a packet: unknown dated Feb 6 withholds the Feb 10 nextDue/nextPaymentOut claims (not published as confirmed)',
    `nextDue=${JSON.stringify(nso.nextDue)}`);
  ok(nso.scheduledAmounts && nso.scheduledAmounts.status === 'unavailable'
    && nso.scheduledAmounts.unknowns.some(u => u.carrier === 'bill' && u.date === '2027-02-06'),
    'B1a packet: the withheld next-obligation claim carries the named scheduled-amount state');
  ok(packet.uncertainty.scheduledAmounts
    && packet.uncertainty.scheduledAmounts.status === 'unavailable'
    && packet.uncertainty.scheduledAmounts.unknowns.some(u => u.date === '2027-02-06')
    && typeof packet.uncertainty.scheduledAmounts.reason === 'string'
    && packet.uncertainty.scheduledAmounts.reason.length > 0,
    'B1a packet: the unknown and its reason are present in packet uncertainty');
  ok(packet.forecast.recommendation.holds === null,
    'B1a packet: recommendation holds stays null (unknown), not boolean false',
    `holds=${packet.forecast.recommendation.holds}`);
  ok(packet.forecast.status === 'ok'
    && packet.current.spendableHouseholdCash.value === 7200,
    'B1a packet: no blanket reroute — envelope stays ok and the known cash stock 7200 is retained',
    `status=${packet.forecast.status} cash=${packet.current.spendableHouseholdCash.value}`);
  const Talk = require('../scripts/talk-gemini.js');
  const claimsText = JSON.stringify({ status: 'explained', claims: [
    { path: 'current.nextSignificantObligations.nextDue.label', equals: 'Invented later bill' },
    { path: 'current.nextSignificantObligations.nextDue.date', equals: '2027-02-10' },
    { path: 'current.nextSignificantObligations.nextDue.amount', equals: 125 }] });
  const materialized = Talk.materializeExplainerAnswer(claimsText, packet);
  ok(materialized.ok === false,
    'B1a Talk: the Feb 10 next-due claims no longer verify against the packet (no confirmed Talk statement)',
    `ok=${materialized.ok} answer=${materialized.answer || ''}`);
}
{
  // Controls: the same claims stay publishable when nothing earlier
  // is unknown, and an unknown dated AFTER the next claim leaves it
  // genuinely unaffected.
  const Talk = require('../scripts/talk-gemini.js');
  const claimsText = JSON.stringify({ status: 'explained', claims: [
    { path: 'current.nextSignificantObligations.nextDue.label', equals: 'Invented later bill' },
    { path: 'current.nextSignificantObligations.nextDue.date', equals: '2027-02-10' },
    { path: 'current.nextSignificantObligations.nextDue.amount', equals: 125 }] });
  const knownOnly = buildPacketFor(packetPlan([
    billRow('later-bill', 'Invented later bill', '2027-02-10', 125)]));
  const nsoK = knownOnly.current.nextSignificantObligations;
  ok(nsoK.nextDue && nsoK.nextDue.date === '2027-02-10' && nsoK.nextDue.amount === 125
    && nsoK.nextDue.confidence === 'confirmed'
    && !knownOnly.uncertainty.scheduledAmounts,
    'B1a control: known-only plan still publishes nextDue Feb 10 / 125 / confirmed, no uncertainty entry');
  ok(Talk.materializeExplainerAnswer(claimsText, knownOnly).ok === true,
    'B1a control: Talk still verifies the next-due claims for a known-only plan');
  const earlier = buildPacketFor(packetPlan([
    billRow('early-bill', 'Invented early bill', '2027-02-06', 50),
    billRow('later-bill', 'Invented later bill', '2027-02-10', 125)]));
  ok(earlier.current.nextSignificantObligations.nextDue
    && earlier.current.nextSignificantObligations.nextDue.date === '2027-02-06'
    && earlier.current.nextSignificantObligations.nextDue.amount === 50,
    'B1a control: known-earlier 50 is the published next due');
  const unknownLater = buildPacketFor(packetPlan([
    billRow('early-bill', 'Invented early bill', '2027-02-06', 125),
    billRow('unknown-bill', 'Invented unknown bill', '2027-02-10', null)]));
  const nsoU = unknownLater.current.nextSignificantObligations;
  ok(nsoU.nextDue && nsoU.nextDue.date === '2027-02-06' && nsoU.nextDue.amount === 125
    && unknownLater.uncertainty.scheduledAmounts
    && unknownLater.uncertainty.scheduledAmounts.status === 'unavailable',
    'B1a control: unknown dated AFTER the next claim leaves it published; the unknown is still named in uncertainty');
}
{
  // The packet qualification is carrier-agnostic: a commitment
  // unknown dated before the known bill withholds the claim too.
  const plan = packetPlan([billRow('later-bill', 'Invented later bill', '2027-02-10', 125)]);
  plan.commitments = [{ id: 'bad-commitment', label: 'Bad', date: '2027-02-06',
    amount: null, confidence: 'confirmed' }];
  const packet = buildPacketFor(plan);
  ok(packet.current.nextSignificantObligations.nextDue === null
    && packet.uncertainty.scheduledAmounts
    && packet.uncertainty.scheduledAmounts.unknowns.some(u => u.carrier === 'commitment'),
    'B1a packet: a commitment unknown dated Feb 6 also withholds the Feb 10 next-due claim');
}
{
  // Crossings: the debt projection withholds uncertain crossings
  // (empty list + named state); the packet must not promote that to
  // a complete {ok, []}. Replacing the unknown with 200 produces the
  // Feb 6 crossing and stays published.
  const capPlan = amount => {
    const plan = packetPlan([]);
    plan.obligations = [{ id: 'cap', label: 'Capitalised interest', confidence: 'confirmed',
      nonCash: true, effect: 'capitalise', frequency: 'once', date: '2027-02-06',
      amount, debtId: 'card' }];
    return plan;
  };
  const capDebts = () => [{ id: 'card', label: 'Card', balance: 1200, limit: 1300, rate: 0 }];
  const walked = F.projectDebts(capPlan(null), capDebts(), M_AS_OF, {});
  ok(walked.crossings.length === 0 && walked.scheduledAmounts.status === 'unavailable',
    'B1a crossings precondition: projection withholds the crossing and names the state');
  const packet = buildPacketFor(capPlan(null), capDebts());
  ok(packet.forecast.facilityCrossings.status === 'unavailable'
    && !(packet.forecast.facilityCrossings.status === 'ok'
      && Array.isArray(packet.forecast.facilityCrossings.items)
      && packet.forecast.facilityCrossings.items.length === 0),
    'B1a packet: facilityCrossings is unavailable, not a complete empty ok set',
    `facilityCrossings=${JSON.stringify(packet.forecast.facilityCrossings)}`);
  const control = buildPacketFor(capPlan(200), capDebts());
  ok(control.forecast.facilityCrossings.status === 'ok'
    && control.forecast.facilityCrossings.items.length === 1
    && control.forecast.facilityCrossings.items[0].date === '2027-02-06',
    'B1a control: known capitalisation 200 still publishes its Feb 6 crossing');
}

/* --- N. Repair round 3 (B1b): the debt wrapper's taint must follow
 * the routing dependency — an unknown payment on card A decides how
 * much of a later extra payment reaches card B, so the allocation
 * record and B's downstream metrics are dependent unknowns too —
 * and the day-zero mark is a PRE-EVENT snapshot: an unknown due on
 * the as-of date must not null the known opening stock. Fixtures are
 * the review's: A/B open 1000 each, rates 12/6, limits 4000,
 * interestByEvent, owner next-dollar policy ready, extra 1500 on
 * Feb 15; unknown case is byte-identical to the zero-payment control
 * for B and the allocation on the unrepaired tree. */
const N_AS_OF = '2027-02-01';
function cascadePlan(aAmount) {
  const plan = plan2027('bill', 1);
  plan.bills[0].noPaymentRequiredOn = [plan.bills[0].date];
  plan.windowDays = 20;
  plan.nextDollar = { policy: 'true-surplus-highest-interest',
    eligibleDebts: 'revolving-cards-and-heloc', provenance: 'owner-stated' };
  plan.obligations = [{ id: 'a-pay', label: 'Card A payment', confidence: 'confirmed',
    frequency: 'once', date: '2027-02-06', amount: aAmount, debtId: 'card-a',
    effect: 'payment', payingAccount: 'chequing-a' }];
  return plan;
}
const cascadeDebts = () => ([
  { id: 'card-a', label: 'Card A', structure: 'Revolving card', balance: 1000,
    pending: 0, rate: 12, limit: 4000, interestByEvent: true, confidence: 'verified' },
  { id: 'card-b', label: 'Card B', structure: 'Revolving card', balance: 1000,
    pending: 0, rate: 6, limit: 4000, interestByEvent: true, confidence: 'verified' },
  { id: 'loan', label: 'Secured loan', structure: 'Secured loan', secured: true,
    balance: 5000, pending: 0, rate: 0, confidence: 'verified' },
]);
const cascadeWalk = aAmount => F.projectDebts(cascadePlan(aAmount), cascadeDebts(),
  N_AS_OF, { extraDebtMonthly: 1500, debtHorizonDays: 20 });
{
  const w = cascadeWalk(null);
  const final = w.marks[w.marks.length - 1];
  const rowA0 = w.marks[0].debts.find(d => d.id === 'card-a');
  const rowB0 = w.marks[0].debts.find(d => d.id === 'card-b');
  const rowA = final.debts.find(d => d.id === 'card-a');
  const rowB = final.debts.find(d => d.id === 'card-b');
  const rowLoan = final.debts.find(d => d.id === 'loan');
  ok(w.scheduledAmounts && w.scheduledAmounts.status === 'unavailable',
    'B1b cascade: named state unavailable (precondition)');
  ok(w.extraDebtAllocation['2027-02-15'] === undefined,
    'B1b cascade: the Feb 15 extra allocation is withheld (its split depends on A\u2019s unknown payment)',
    `allocation=${JSON.stringify(w.extraDebtAllocation['2027-02-15'] || null)}`);
  ok(rowB.balance === null && rowB.paid === null && rowB.available === null,
    'B1b cascade: downstream card B future balance/paid/credit-left are withheld (not 500/500/3500)',
    `B balance=${rowB.balance} paid=${rowB.paid} available=${rowB.available}`);
  ok(rowA.balance === null && rowA0.balance === 1000 && rowB0.balance === 1000,
    'B1b cascade: A post-due balance stays withheld; day-zero stocks for A and B stay known (1000)');
  ok(rowLoan.balance === 5000,
    'B1b cascade: a genuinely unaffected debt (secured loan, outside the chain) still publishes 5000',
    `loan balance=${rowLoan.balance}`);
}
{
  const w = cascadeWalk(500);
  const alloc = w.extraDebtAllocation['2027-02-15'];
  const line = id => alloc && alloc.allocations.find(l => l.debtId === id);
  ok(alloc && line('card-a') && line('card-a').amount === 500
    && line('card-a').status === 'calculated'
    && line('card-b') && line('card-b').amount === 1000
    && line('card-b').status === 'calculated',
    'B1b control: known A payment 500 publishes the allocation A 500 / B 1000, calculated',
    `allocation=${JSON.stringify(alloc || null)}`);
  const final = w.marks[w.marks.length - 1];
  const rowA = final.debts.find(d => d.id === 'card-a');
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(rowB.balance === 0 && rowB.paid === 1000 && rowB.available === 4000
    && rowA.balance === 0 && rowA.paid === 1000,
    'B1b control: B future metrics publish 0 / 1000 / 4000 and A publishes 0 / paid 1000',
    `B=${rowB.balance}/${rowB.paid}/${rowB.available} A=${rowA.balance}/${rowA.paid}`);
}
{
  // A genuine zero is a KNOWN amount: the zero-payment plan publishes
  // the very figures the unknown plan must withhold.
  const w = cascadeWalk(0);
  const alloc = w.extraDebtAllocation['2027-02-15'];
  const line = id => alloc && alloc.allocations.find(l => l.debtId === id);
  ok(w.scheduledAmounts.status === 'ready' && alloc
    && line('card-a') && line('card-a').amount === 1000
    && line('card-b') && line('card-b').amount === 500,
    'B1b control: genuine zero A payment is known — allocation A 1000 / B 500 stays published (unknown is not zero)');
}
{
  // Due-today regression: the opening snapshot is taken before any
  // event applies, so an unknown due ON the as-of date leaves the
  // day-zero stock known; only post-due claims withhold.
  const mkPlan = amount => {
    const plan = plan2027('obligation', amount);
    Object.assign(plan.obligations[0], { id: 'today-pay', debtId: 'card',
      effect: 'payment', payingAccount: 'chequing-a' });
    plan.obligations[0].date = '2027-02-01';
    return plan;
  };
  const debts = () => [{ id: 'card', label: 'Card', balance: 1200, limit: 4000, rate: 0 }];
  const w = F.projectDebts(mkPlan(null), debts(), N_AS_OF, {});
  const day0 = w.marks[0].debts.find(d => d.id === 'card');
  const final = w.marks[w.marks.length - 1].debts.find(d => d.id === 'card');
  ok(day0.balance === 1200 && day0.paid === 0 && day0.available === 2800
    && w.marks[0].headroom === 2800 && w.marks[0].consumer === 1200,
    'B1b due-today: day-zero pre-event stock stays known (balance 1200, available/headroom 2800)',
    `day0 balance=${day0.balance} available=${day0.available} headroom=${w.marks[0].headroom}`);
  ok(final.balance === null && w.byId.card.opening === 1200,
    'B1b due-today: post-due balance still withheld and byId opening stays 1200',
    `final balance=${final.balance} opening=${w.byId.card.opening}`);
  const control = F.projectDebts(mkPlan(300), debts(), N_AS_OF, {});
  const cDay0 = control.marks[0].debts.find(d => d.id === 'card');
  const cFinal = control.marks[control.marks.length - 1].debts.find(d => d.id === 'card');
  ok(cDay0.balance === 1200 && cFinal.balance === 900,
    'B1b due-today control: valid payment due today — day-zero 1200 known, final balance 900',
    `day0=${cDay0.balance} final=${cFinal.balance}`);
}

/* --- O. Repair round 4 (B1a, probe-confirmed on head 9b9e616c): a
 * once outflow dated BEFORE the as-of is still owed — Forecast
 * carries it at the opening (onceOutflowDates) and the named state
 * names it unresolved — so it qualifies the packet's next-obligation
 * claims exactly like an in-range unknown. The round-3 predicate
 * required unknown.date >= asOf, so the overdue row never qualified:
 * the packet published the later known bill as the confirmed next
 * due / next payment out and Talk verified it, while recommend.holds
 * was already null on the same state. Controls: a known overdue
 * amount and a waived (noPaymentRequiredOn) overdue occurrence are
 * resolved by construction — the state is ready and the claims MUST
 * keep publishing. */
{
  const claimsText = JSON.stringify({ status: 'explained', claims: [
    { path: 'current.nextSignificantObligations.nextDue.label', equals: 'Invented later bill' },
    { path: 'current.nextSignificantObligations.nextDue.date', equals: '2027-02-10' },
    { path: 'current.nextSignificantObligations.nextDue.amount', equals: 125 }] });
  const Talk = require('../scripts/talk-gemini.js');
  const overduePlan = bill => packetPlan([
    bill, billRow('later-bill', 'Invented later bill', '2027-02-10', 125)]);
  const unknown = buildPacketFor(overduePlan(
    billRow('overdue-bill', 'Invented overdue bill', '2027-01-31', null)));
  const nsoO = unknown.current.nextSignificantObligations;
  ok(unknown.uncertainty.scheduledAmounts
    && unknown.uncertainty.scheduledAmounts.unknowns.some(u => u.date === '2027-01-31')
    && unknown.forecast.recommendation.holds === null,
    'B1a overdue precondition: the named state names the Jan 31 unknown and holds is already null',
    `holds=${unknown.forecast.recommendation.holds}`);
  ok(nsoO.nextDue === null && nsoO.nextPaymentOut === null,
    'B1a overdue: pre-asOf unknown withholds the Feb 10 nextDue/nextPaymentOut claims (not published as confirmed)',
    `nextDue=${JSON.stringify(nsoO.nextDue)}`);
  ok(nsoO.scheduledAmounts && nsoO.scheduledAmounts.status === 'unavailable'
    && nsoO.scheduledAmounts.unknowns.some(u => u.carrier === 'bill' && u.date === '2027-01-31'),
    'B1a overdue: the withheld claim carries the named scheduled-amount state');
  ok(unknown.forecast.status === 'ok'
    && unknown.current.spendableHouseholdCash.value === 7200,
    'B1a overdue: no blanket reroute — envelope stays ok and the known cash stock 7200 is retained',
    `status=${unknown.forecast.status} cash=${unknown.current.spendableHouseholdCash.value}`);
  ok(Talk.materializeExplainerAnswer(claimsText, unknown).ok === false,
    'B1a overdue Talk: the Feb 10 next-due claims no longer verify against the packet');
  // A KNOWN overdue amount is resolved for the scheduled-amount state, but
  // it is still owed: the walk deducts it at the opening, so the next due
  // claim is that overdue bill, due today and marked overdue from Jan 31 —
  // never the later Feb 10 bill as if Jan 31 had been paid.
  const known = buildPacketFor(overduePlan(
    billRow('overdue-bill', 'Invented overdue bill', '2027-01-31', 300)));
  const knownDue = known.current.nextSignificantObligations.nextDue;
  ok(knownDue
    && knownDue.label === 'Invented overdue bill'
    && knownDue.date === K_AS_OF && knownDue.daysUntil === 0
    && knownDue.amount === 300
    && knownDue.overdue === true && knownDue.scheduledDate === '2027-01-31'
    && !known.uncertainty.scheduledAmounts
    && Talk.materializeExplainerAnswer(claimsText, known).ok === false,
    'B1a overdue control: known overdue amount 300 — state ready; the carried overdue bill is next due today, the Feb 10 claim does not verify',
    `nextDue=${JSON.stringify(knownDue)}`);
  const waivedRow = billRow('overdue-bill', 'Invented overdue bill', '2027-01-31', null);
  waivedRow.noPaymentRequiredOn = ['2027-01-31'];
  const waived = buildPacketFor(overduePlan(waivedRow));
  ok(waived.current.nextSignificantObligations.nextDue
    && waived.current.nextSignificantObligations.nextDue.date === '2027-02-10'
    && !waived.uncertainty.scheduledAmounts
    && Talk.materializeExplainerAnswer(claimsText, waived).ok === true,
    'B1a overdue control: waived overdue occurrence (noPaymentRequiredOn) — state ready, Feb 10 claim publishes');
}

/* --- P. Repair round 4 (B1b, probe-confirmed on head 9b9e616c):
 * the round-3 fixpoint tainted EVERY member of an extra payment's
 * chain once any member was tainted, but a payDown cascade moves in
 * chain order: a member's take depends on the balances at-or-before
 * its own position, never on members after it. §N mirrored with the
 * unknown on card B (the downstream member) and extra 500: upstream
 * card A's receipt, balance, paid and credit-left are provably
 * invariant (the known-500 and genuine-zero controls agree byte for
 * byte) and must publish; B stays withheld, and the allocation
 * entry — whose only take is A's determined one — publishes with
 * its nextTarget conclusion withheld (it turns on B's unknown
 * balance). §N's direction (unknown upstream) is pinned above and
 * must not regress. */
function cascadePlanB(bAmount) {
  const plan = plan2027('bill', 1);
  plan.bills[0].noPaymentRequiredOn = [plan.bills[0].date];
  plan.windowDays = 20;
  plan.nextDollar = { policy: 'true-surplus-highest-interest',
    eligibleDebts: 'revolving-cards-and-heloc', provenance: 'owner-stated' };
  plan.obligations = [{ id: 'b-pay', label: 'Card B payment', confidence: 'confirmed',
    frequency: 'once', date: '2027-02-06', amount: bAmount, debtId: 'card-b',
    effect: 'payment', payingAccount: 'chequing-a' }];
  return plan;
}
const cascadeWalkB = bAmount => F.projectDebts(cascadePlanB(bAmount), cascadeDebts(),
  N_AS_OF, { extraDebtMonthly: 500, debtHorizonDays: 20 });
{
  const w = cascadeWalkB(null);
  const alloc = w.extraDebtAllocation['2027-02-15'];
  ok(w.scheduledAmounts && w.scheduledAmounts.status === 'unavailable',
    'B1b reversed precondition: named state unavailable (unknown on card B)');
  ok(alloc && Array.isArray(alloc.allocations) && alloc.allocations.length === 1
    && alloc.allocations[0].debtId === 'card-a' && alloc.allocations[0].amount === 500
    && alloc.allocations[0].status === 'calculated' && alloc.nextTarget === null,
    'B1b reversed: the Feb 15 allocation publishes its determined take (A 500, calculated); nextTarget withheld',
    `allocation=${JSON.stringify(alloc || null)}`);
  const final = w.marks[w.marks.length - 1];
  const rowA = final.debts.find(d => d.id === 'card-a');
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(rowA.balance === 500 && rowA.paid === 500 && rowA.available === 3500,
    'B1b reversed: upstream card A retains balance 500 / paid 500 / credit-left 3500',
    `A balance=${rowA.balance} paid=${rowA.paid} available=${rowA.available}`);
  ok(rowB.balance === null && rowB.paid === null && rowB.available === null,
    'B1b reversed: downstream card B future metrics stay withheld',
    `B balance=${rowB.balance} paid=${rowB.paid} available=${rowB.available}`);
  ok(w.byId['card-a'].balance === 500 && w.byId['card-a'].paid === 500
    && w.byId['card-a'].interest === 0 && w.byId['card-b'].balance === null,
    'B1b reversed: byId A publishes 500 / paid 500 / interest 0; byId B stays withheld',
    `byId A=${w.byId['card-a'].balance}/${w.byId['card-a'].paid}/${w.byId['card-a'].interest}`);
  const day0A = w.marks[0].debts.find(d => d.id === 'card-a');
  const day0B = w.marks[0].debts.find(d => d.id === 'card-b');
  ok(day0A.balance === 1000 && day0B.balance === 1000,
    'B1b reversed: day-zero stocks for A and B stay known (1000)');
}
{
  const w = cascadeWalkB(500);
  const alloc = w.extraDebtAllocation['2027-02-15'];
  const final = w.marks[w.marks.length - 1];
  const rowA = final.debts.find(d => d.id === 'card-a');
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(alloc && alloc.allocations.length === 1 && alloc.allocations[0].amount === 500
    && alloc.nextTarget && alloc.nextTarget.debtId === 'card-b'
    && rowA.balance === 500 && rowA.paid === 500 && rowA.available === 3500
    && rowB.balance === 500 && rowB.paid === 500 && rowB.available === 3500,
    'B1b reversed control: B payment known 500 — allocation A 500 with nextTarget B; A and B publish 500/500/3500',
    `A=${rowA.balance}/${rowA.paid}/${rowA.available} B=${rowB.balance}/${rowB.paid}/${rowB.available}`);
}
{
  const w = cascadeWalkB(0);
  const alloc = w.extraDebtAllocation['2027-02-15'];
  const final = w.marks[w.marks.length - 1];
  const rowA = final.debts.find(d => d.id === 'card-a');
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts.status === 'ready' && alloc
    && alloc.allocations.length === 1 && alloc.allocations[0].amount === 500
    && rowA.balance === 500 && rowA.paid === 500 && rowA.available === 3500
    && rowB.balance === 1000 && rowB.paid === 0 && rowB.available === 3000,
    'B1b reversed control: B payment genuine zero is known — A 500/500/3500 and B 1000/0/3000 publish (unknown is not zero)');
}

/* --- Q. Probe-3 controls (nearBoundary does NOT reproduce a
 * defect; pinned so the round-4 predicate split cannot drift it):
 * an in-range unknown on or before a dated boundary withholds the
 * boundary claim, and the no-payday shell keeps publishing as a
 * null boundary with confidence 'unknown' — it asserts no dated
 * completeness and is not qualified by the overdue rule either:
 * the shell's window is empty by construction. */
{
  const paydayIncome = () => [{ id: 'pay-1', label: 'Invented payday',
    frequency: 'once', date: '2027-02-12', amount: 2000, confidence: 'confirmed' }];
  const dated = packetPlan([billRow('payday-bill', 'Invented payday bill', '2027-02-12', 300)]);
  dated.income = paydayIncome();
  const datedPacket = buildPacketFor(dated);
  ok(datedPacket.current.nextSignificantObligations.nearBoundary
    && datedPacket.current.nextSignificantObligations.nearBoundary.until === '2027-02-13'
    && datedPacket.current.nextSignificantObligations.nearBoundary.total === 300,
    'Probe-3 control: dated payday boundary publishes total 300 until 2027-02-13 when nothing is unknown');
  const datedUnknown = packetPlan([
    billRow('unknown-bill', 'Invented unknown bill', '2027-02-06', null),
    billRow('payday-bill', 'Invented payday bill', '2027-02-12', 300)]);
  datedUnknown.income = paydayIncome();
  ok(buildPacketFor(datedUnknown).current.nextSignificantObligations.nearBoundary === null,
    'Probe-3 control: in-range unknown on/before the boundary withholds the dated nearBoundary claim');
  const shell = buildPacketFor(packetPlan([
    billRow('unknown-bill', 'Invented unknown bill', '2027-02-06', null),
    billRow('later-bill', 'Invented later bill', '2027-02-10', 125)]));
  const shellBoundary = shell.current.nextSignificantObligations.nearBoundary;
  ok(shellBoundary && shellBoundary.payday === null && shellBoundary.until === null
    && shellBoundary.total === 0 && shellBoundary.confidence === 'unknown',
    'Probe-3 control: no-payday shell stays a published null boundary with confidence unknown (no completeness claim)');
}

/* --- R. Repair round 5 (B1b, Atlas ruling ts 1792241495.391439 on
 * the round-4 head cbfd1d1f; probe R4-1 reproduced the hypothesis
 * PARTIAL there): splitDetermined published an allocation record
 * whenever every RECORDED take preceded the first tainted chain
 * position, without checking whether those takes exhausted the
 * fixed extra. Fixture (the probe's, exactly): asOf 2027-02-01,
 * cards A/B open 1000, APR 12/6, limits 4000, interestByEvent,
 * owner highest-interest policy; known B payment 1000 on Feb 5;
 * B noncash capitalisation on Feb 6 (null vs genuine 0 vs 200);
 * extra 1500 on Feb 15. Null variant on the unrepaired tree: the
 * record {A 1000, calculated}, extraAbsorbed {Feb 15: 1000} and
 * unabsorbed 500 are byte-identical to the GENUINELY COMPLETE
 * genuine-zero control, while the 200 control proves B could have
 * taken a further 200 of the same extra — the split is incomplete,
 * its remainder is unknown, and nothing marks it. The repair
 * qualifies the remainder-dependent claims while preserving every
 * determined figure: A's take line keeps publishing and the record
 * is stamped status 'partial'; extraAbsorbed keeps its numeric
 * value — the caps consumers (expandEvents via capsFor/applyCaps)
 * spend exactly that value, so nulling or deleting the entry
 * would erase A's known 1000 outflow from the cash walk behind a
 * defaulted zero — and the dates whose absorbed total is not
 * exactly known are named in extraAbsorbedUnknown; the aggregate
 * unabsorbed, a single total carrying an unknown component, is
 * withheld (null). A split whose determined takes EXHAUST the
 * extra is complete in every resolution (§P: remainder 0) and is
 * NOT qualified. */
const R_AS_OF = '2027-02-01';
function remainderPlan(capAmount) {
  const plan = plan2027('bill', 0);
  plan.bills = [];
  plan.windowDays = 20;
  plan.nextDollar = { policy: 'true-surplus-highest-interest',
    eligibleDebts: 'revolving-cards-and-heloc', provenance: 'owner-stated' };
  plan.obligations = [
    { id: 'b-pay', label: 'Card B payment', confidence: 'confirmed',
      frequency: 'once', date: '2027-02-05', amount: 1000, debtId: 'card-b',
      effect: 'payment', payingAccount: 'chequing-a' },
    { id: 'b-cap', label: 'Card B capitalised interest', confidence: 'confirmed',
      nonCash: true, effect: 'capitalise', frequency: 'once', date: '2027-02-06',
      amount: capAmount, debtId: 'card-b' },
  ];
  return plan;
}
const remainderWalk = capAmount => F.projectDebts(remainderPlan(capAmount),
  cascadeDebts(), R_AS_OF, { extraDebtMonthly: 1500, debtHorizonDays: 20 });
{
  const w = remainderWalk(null);
  const rec = w.extraDebtAllocation['2027-02-15'];
  const final = w.marks[w.marks.length - 1];
  const rowA = final.debts.find(d => d.id === 'card-a');
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts && w.scheduledAmounts.status === 'unavailable'
    && w.scheduledAmounts.unknowns.some(u => u.id === 'b-cap'),
    'B1b remainder precondition: named state unavailable naming the Feb 6 capitalisation');
  ok(rec && rec.allocations.length === 1 && rec.allocations[0].debtId === 'card-a'
    && rec.allocations[0].amount === 1000 && rec.allocations[0].status === 'calculated'
    && rec.nextTarget === null && rec.status === 'partial',
    'B1b remainder: A\u2019s determined take (1000, calculated) still publishes, and the record is stamped partial \u2014 not a complete split',
    `record=${JSON.stringify(rec || null)}`);
  ok(w.extraAbsorbed['2027-02-15'] === 1000,
    'B1b remainder: extraAbsorbed keeps the determined 1000 (the caps value \u2014 not erased, not a defaulted zero)',
    `extraAbsorbed=${JSON.stringify(w.extraAbsorbed)}`);
  ok(w.extraAbsorbedUnknown && w.extraAbsorbedUnknown['2027-02-15'] === true,
    'B1b remainder: the Feb 15 absorbed total is named not-exactly-known in extraAbsorbedUnknown',
    `extraAbsorbedUnknown=${JSON.stringify(w.extraAbsorbedUnknown || null)}`);
  ok(w.unabsorbed === null,
    'B1b remainder: aggregate unabsorbed is withheld (its 500 remainder is unknown, not a published exact 500)',
    `unabsorbed=${w.unabsorbed}`);
  ok(rowA.balance === 0 && rowA.paid === 1000 && rowA.available === 4000
    && w.byId['card-a'].balance === 0 && w.byId['card-a'].paid === 1000,
    'B1b remainder: upstream card A metrics retained (0 / paid 1000 / credit-left 4000)',
    `A=${rowA.balance}/${rowA.paid}/${rowA.available}`);
  ok(rowB.balance === null && rowB.paid === null && rowB.available === null
    && w.byId['card-b'].balance === null && w.byId['card-b'].capitalised === null,
    'B1b remainder: card B future metrics stay withheld');
  // Consumer preservation, caps path: capsFor hands this walk's
  // extraAbsorbed to expandEvents, which spends exactly the capped
  // value \u2014 the cash walk must still spend A's known 1000 outflow
  // on Feb 15 (not 0 by default, not the full 1500 asked for).
  const capsEvents = F.expandEvents(remainderPlan(null), R_AS_OF, '2027-02-28',
    { extraDebtMonthly: 1500, extraAbsorbed: w.extraAbsorbed });
  const extraEv = capsEvents.find(e => e.kind === 'extra' && e.date === '2027-02-15');
  ok(extraEv && extraEv.amount === -1000,
    'B1b remainder consumer: the caps-fed cash walk still spends exactly the known 1000 outflow on Feb 15',
    `extra event=${extraEv ? extraEv.amount : 'missing'}`);
}
{
  // Genuine zero: the split IS complete (B's balance is known to be
  // 0 after its payment, so the 500 remainder is genuinely
  // unabsorbed) \u2014 every allocation-facing figure stays
  // byte-identical to the round-4 shape. Unknown is not zero, and
  // known zero is not qualified.
  const w = remainderWalk(0);
  const rec = w.extraDebtAllocation['2027-02-15'];
  const final = w.marks[w.marks.length - 1];
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts.status === 'ready' && rec
    && rec.allocations.length === 1 && rec.allocations[0].amount === 1000
    && rec.allocations[0].status === 'calculated' && rec.nextTarget === null
    && !('status' in rec) && w.extraAbsorbed['2027-02-15'] === 1000
    && w.unabsorbed === 500
    && !(w.extraAbsorbedUnknown && w.extraAbsorbedUnknown['2027-02-15']),
    'B1b remainder control: genuine zero capitalisation \u2014 complete split publishes unmarked (record/A 1000/absorbed 1000/unabsorbed 500, as round 4)',
    `record=${JSON.stringify(rec || null)} unabsorbed=${w.unabsorbed}`);
  ok(rowB.balance === 0 && rowB.paid === 1000 && rowB.available === 4000,
    'B1b remainder control: genuine zero \u2014 B metrics publish 0 / 1000 / 4000',
    `B=${rowB.balance}/${rowB.paid}/${rowB.available}`);
}
{
  // 200 control: the downstream take the null variant could not
  // rule out is real \u2014 with the capitalisation known, B takes a
  // further 200 and the split completes. Nothing is qualified.
  const w = remainderWalk(200);
  const rec = w.extraDebtAllocation['2027-02-15'];
  const line = id => rec && rec.allocations.find(l => l.debtId === id);
  ok(rec && line('card-a') && line('card-a').amount === 1000
    && line('card-b') && line('card-b').amount === 200
    && !('status' in rec) && w.extraAbsorbed['2027-02-15'] === 1200
    && w.unabsorbed === 300
    && !(w.extraAbsorbedUnknown && w.extraAbsorbedUnknown['2027-02-15']),
    'B1b remainder control: capitalisation 200 \u2014 complete split A 1000 / B 200, absorbed 1200, unabsorbed 300, unmarked',
    `record=${JSON.stringify(rec || null)}`);
}
{
  // \u00a7N direction under the same rule: the record is already
  // withheld (a take sits at the tainted position), and the
  // remainder-dependent claims are qualified identically \u2014 the
  // absorbed total is named unknown and the aggregate unabsorbed
  // withheld, while the caps value itself stays numeric.
  const w = cascadeWalk(null);
  ok(w.extraAbsorbedUnknown && w.extraAbsorbedUnknown['2027-02-15'] === true
    && w.unabsorbed === null
    && typeof w.extraAbsorbed['2027-02-15'] === 'number',
    'B1b remainder (\u00a7N direction): absorbed total named unknown and unabsorbed withheld; caps value stays numeric',
    `extraAbsorbedUnknown=${JSON.stringify(w.extraAbsorbedUnknown || null)} unabsorbed=${w.unabsorbed}`);
}
{
  // \u00a7P direction under the same rule: determined takes EXHAUST
  // the 500 extra (remainder 0 in every resolution), so the split
  // is complete \u2014 no partial stamp, no unknown mark on the extra
  // arm. The aggregate scalar is a separate claim: this fixture's
  // own B repayment is an omitted unknown repayment against a
  // live 1000 balance (\u00a7T's defect, round 7), so the aggregate
  // withholds on the obligation arm \u2014 not on the extra arm.
  const w = cascadeWalkB(null);
  const rec = w.extraDebtAllocation['2027-02-15'];
  ok(rec && !('status' in rec) && w.extraAbsorbed['2027-02-15'] === 500
    && !(w.extraAbsorbedUnknown && w.extraAbsorbedUnknown['2027-02-15']),
    'B1b remainder (\u00a7P direction): exhaustive determined split stays complete \u2014 no extra-arm qualification',
    `record=${JSON.stringify(rec || null)} unabsorbed=${w.unabsorbed}`);
  ok(w.unabsorbed === null,
    'B1b remainder (\u00a7P direction): the aggregate still withholds \u2014 the fixture\u2019s own omitted B repayment (\u00a7T) leaves its remainder unknown',
    `unabsorbed=${w.unabsorbed}`);
}
{
  // Consumer preservation, trajectory: the prepared trajectory
  // walk gates on the same named state, so the null variant stays
  // wholly unavailable and the controls stay ready \u2014 the partial
  // record never reaches stage-3 attribution.
  const trajStub = () => ({ periods: { ytd: { label: 'stub', months: 1, spending: [] } } });
  const trajPlan = capAmount => {
    const plan = remainderPlan(capAmount);
    plan.windowDays = 60;
    plan.defaults.extraDebtMonthly = 1500;
    return plan;
  };
  const trajNull = F.baselineTrajectory(trajPlan(null), cascadeDebts(), R_AS_OF,
    { periods: trajStub() });
  const trajZero = F.baselineTrajectory(trajPlan(0), cascadeDebts(), R_AS_OF,
    { periods: trajStub() });
  const traj200 = F.baselineTrajectory(trajPlan(200), cascadeDebts(), R_AS_OF,
    { periods: trajStub() });
  ok(trajNull.status === 'unavailable' && trajZero.status === 'ready'
    && traj200.status === 'ready',
    'B1b remainder consumer: baselineTrajectory stays unavailable on the null variant and ready on both controls',
    `null=${trajNull.status} zero=${trajZero.status} 200=${traj200.status}`);
}

/* --- S. Repair round 6 (B1b, Systems Review BLOCKING on head
 * 168dd151, issuecomment 6235731569): round 5 qualified the
 * published unabsorbed aggregate only for REAL extras. The same
 * aggregate is a sum of leftovers from three walk arms, and the
 * obligation and planned-debt arms feed it too: a leftover there
 * is computed from the named debt's balance on the day it applied,
 * so when that balance depends on a named scheduled unknown, the
 * aggregate carries an unknown component exactly as the extra
 * remainder did. Fixture (the review's, exactly): asOf 2027-02-01,
 * cash 7200, no income, A/B open 1000, APR 12/6, limits 4000,
 * interestByEvent, owner highest-interest policy, no monthly extra
 * (extraDebtMonthly 0, debtHorizonDays 31); B noncash capitalisation
 * Feb 6 (null vs genuine 0 vs 200); B known payment 1200 on Feb 10.
 * On the blocked head the null variant publishes unabsorbed 200 —
 * byte-identical to the genuine-zero control — while the 200
 * control proves a valid resolution makes it 0: the published 200
 * silently assumes the unknown capitalisation is 0. The repair
 * withholds the aggregate (null — the same representation round 5
 * gave this scalar) whenever an obligation/planned-debt remainder
 * component was computed from a balance tainted at-or-before its
 * application day, and leaves it published when every component is
 * determined: a remainder on an untainted debt, or dated before
 * its debt's first unknown, is exact in every resolution. The
 * obligation cap map keeps its numeric values in all variants —
 * the cash walk spends those caps, and a missing/null cap defaults
 * to zero and would erase the known outflow. */
const S_AS_OF = '2027-02-01';
function remainderSourcePlan(capAmount) {
  const plan = plan2027('bill', 0);
  plan.bills = [];
  plan.windowDays = 31;
  plan.nextDollar = { policy: 'true-surplus-highest-interest',
    eligibleDebts: 'revolving-cards-and-heloc', provenance: 'owner-stated' };
  plan.obligations = [
    { id: 'b-cap', label: 'Card B capitalised interest', confidence: 'confirmed',
      nonCash: true, effect: 'capitalise', frequency: 'once', date: '2027-02-06',
      amount: capAmount, debtId: 'card-b' },
    { id: 'b-pay', label: 'Card B payment', confidence: 'confirmed',
      frequency: 'once', date: '2027-02-10', amount: 1200, debtId: 'card-b',
      effect: 'payment', payingAccount: 'chequing-a' },
  ];
  return plan;
}
const obligationRemainderWalk = capAmount => F.projectDebts(
  remainderSourcePlan(capAmount), cascadeDebts(), S_AS_OF,
  { extraDebtMonthly: 0, debtHorizonDays: 31 });
const plannedRemainderWalk = capAmount => {
  const plan = remainderSourcePlan(capAmount);
  plan.obligations = plan.obligations.filter(o => o.id === 'b-cap');
  return F.projectDebts(plan, cascadeDebts(), S_AS_OF,
    { extraDebtMonthly: 0, debtHorizonDays: 31,
      plannedFlows: [{ id: 'repay', date: '2027-02-10', amount: -1200, debtId: 'card-b' }] });
};
{
  const w = obligationRemainderWalk(null);
  const final = w.marks[w.marks.length - 1];
  const rowA = final.debts.find(d => d.id === 'card-a');
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts && w.scheduledAmounts.status === 'unavailable'
    && w.scheduledAmounts.unknowns.some(u => u.id === 'b-cap'),
    'B1b obligation remainder precondition: named state unavailable naming the Feb 6 capitalisation');
  ok(w.unabsorbed === null,
    'B1b obligation remainder: aggregate unabsorbed is withheld (its 200 remainder depends on the unknown capitalisation, not a published exact 200)',
    `unabsorbed=${w.unabsorbed}`);
  ok(w.obligationAbsorbed['2027-02-10:b-pay'] === 1000,
    'B1b obligation remainder: the internal obligation cap keeps its numeric 1000 (cash-walk cap intact, not erased to a defaulted zero)',
    `obligationAbsorbed=${JSON.stringify(w.obligationAbsorbed)}`);
  ok(rowA.balance === 1000 && rowA.paid === 0 && rowA.available === 3000
    && rowB.balance === null && rowB.paid === null && w.byId['card-b'].balance === null
    && w.marks[0].debts.find(d => d.id === 'card-b').balance === 1000,
    'B1b obligation remainder: card A metrics and day-zero stocks retained (1000/0/3000); card B future metrics stay withheld',
    `A=${rowA.balance}/${rowA.paid}/${rowA.available} B=${rowB.balance}`);
  ok(w.extraAbsorbedUnknown && Object.keys(w.extraAbsorbedUnknown).length === 0
    && Object.keys(w.extraAbsorbed).length === 0,
    'B1b obligation remainder: no extra dates exist to name — the qualification is on the aggregate scalar itself',
    `extraAbsorbedUnknown=${JSON.stringify(w.extraAbsorbedUnknown || null)}`);
}
{
  const w = obligationRemainderWalk(0);
  const final = w.marks[w.marks.length - 1];
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts.status === 'ready' && w.unabsorbed === 200
    && w.obligationAbsorbed['2027-02-10:b-pay'] === 1000
    && rowB.balance === 0 && rowB.paid === 1000 && rowB.available === 4000,
    'B1b obligation remainder control: genuine zero capitalisation — unabsorbed 200, cap 1000 and B 0/1000/4000 publish exactly (unknown is not zero)',
    `unabsorbed=${w.unabsorbed} B=${rowB.balance}/${rowB.paid}/${rowB.available}`);
}
{
  const w = obligationRemainderWalk(200);
  const final = w.marks[w.marks.length - 1];
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts.status === 'ready' && w.unabsorbed === 0
    && w.obligationAbsorbed['2027-02-10:b-pay'] === 1200
    && rowB.balance === 0 && rowB.paid === 1200 && rowB.available === 4000,
    'B1b obligation remainder control: capitalisation 200 — the payment is fully absorbed (unabsorbed 0, cap 1200, B 0/1200/4000)',
    `unabsorbed=${w.unabsorbed} B=${rowB.balance}/${rowB.paid}/${rowB.available}`);
}
{
  const w = plannedRemainderWalk(null);
  const final = w.marks[w.marks.length - 1];
  const rowA = final.debts.find(d => d.id === 'card-a');
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts && w.scheduledAmounts.status === 'unavailable'
    && w.scheduledAmounts.unknowns.some(u => u.id === 'b-cap'),
    'B1b planned remainder precondition: named state unavailable naming the Feb 6 capitalisation');
  ok(w.unabsorbed === null,
    'B1b planned remainder: aggregate unabsorbed is withheld (the planned repayment\u2019s 200 leftover depends on the unknown capitalisation)',
    `unabsorbed=${w.unabsorbed}`);
  ok(rowA.balance === 1000 && rowA.paid === 0 && rowA.available === 3000
    && rowB.balance === null && w.byId['card-b'].balance === null,
    'B1b planned remainder: card A metrics retained (1000/0/3000); card B future metrics stay withheld',
    `A=${rowA.balance}/${rowA.paid}/${rowA.available} B=${rowB.balance}`);
}
{
  const w = plannedRemainderWalk(0);
  const final = w.marks[w.marks.length - 1];
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts.status === 'ready' && w.unabsorbed === 200
    && rowB.balance === 0 && rowB.paid === 1000 && rowB.available === 4000,
    'B1b planned remainder control: genuine zero capitalisation — unabsorbed 200 and B 0/1000/4000 publish exactly',
    `unabsorbed=${w.unabsorbed} B=${rowB.balance}/${rowB.paid}/${rowB.available}`);
}
{
  const w = plannedRemainderWalk(200);
  const final = w.marks[w.marks.length - 1];
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts.status === 'ready' && w.unabsorbed === 0
    && rowB.balance === 0 && rowB.paid === 1200 && rowB.available === 4000,
    'B1b planned remainder control: capitalisation 200 — the planned repayment is fully absorbed (unabsorbed 0, B 0/1200/4000)',
    `unabsorbed=${w.unabsorbed} B=${rowB.balance}/${rowB.paid}/${rowB.available}`);
}
{
  // Direction control (the §P mirror): dependence follows the
  // balance the remainder was computed from. The unknown sits on
  // card B; the only remainder comes from a payment obligation on
  // upstream card A, whose balance path no event ties to B's
  // unknown — the aggregate is exact in every resolution and
  // stays published, while B's own metrics stay withheld.
  const plan = remainderSourcePlan(null);
  plan.obligations = plan.obligations.filter(o => o.id === 'b-cap');
  plan.obligations.push({ id: 'a-pay', label: 'Card A payment', confidence: 'confirmed',
    frequency: 'once', date: '2027-02-10', amount: 1200, debtId: 'card-a',
    effect: 'payment', payingAccount: 'chequing-a' });
  const w = F.projectDebts(plan, cascadeDebts(), S_AS_OF,
    { extraDebtMonthly: 0, debtHorizonDays: 31 });
  const final = w.marks[w.marks.length - 1];
  const rowA = final.debts.find(d => d.id === 'card-a');
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts.status === 'unavailable' && w.unabsorbed === 200
    && w.obligationAbsorbed['2027-02-10:a-pay'] === 1000
    && rowA.balance === 0 && rowA.paid === 1000 && rowA.available === 4000
    && rowB.balance === null,
    'B1b obligation remainder (direction): an unaffected upstream debt\u2019s remainder stays published exactly (unabsorbed 200, A 0/1000/4000); B stays withheld',
    `unabsorbed=${w.unabsorbed} A=${rowA.balance}/${rowA.paid}/${rowA.available} B=${rowB.balance}`);
}
{
  // Direction control, dated: a remainder computed BEFORE its own
  // debt's first unknown is determined by data upstream of the
  // unknown — the same at-or-before rule the marks use. B's
  // payment lands Feb 3, the unknown capitalisation is Feb 6, so
  // the 200 leftover is exact and stays published; B's post-Feb 6
  // metrics still withhold.
  const plan = remainderSourcePlan(null);
  plan.obligations = plan.obligations.map(o => o.id === 'b-pay'
    ? { ...o, date: '2027-02-03' } : o);
  const w = F.projectDebts(plan, cascadeDebts(), S_AS_OF,
    { extraDebtMonthly: 0, debtHorizonDays: 31 });
  const final = w.marks[w.marks.length - 1];
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts.status === 'unavailable' && w.unabsorbed === 200
    && w.obligationAbsorbed['2027-02-03:b-pay'] === 1000
    && rowB.balance === null && w.byId['card-b'].balance === null,
    'B1b obligation remainder (direction, dated): a remainder computed before its debt\u2019s first unknown stays published exactly (unabsorbed 200); later B metrics withhold',
    `unabsorbed=${w.unabsorbed} B=${rowB.balance}`);
}

/* --- T. Repair round 7 (B1b, Systems Review BLOCKING on head
 * 2c228150, issuecomment 6238162671): round 6 qualified the
 * aggregate for remainders the walk computed, but a scheduled
 * repayment whose OWN amount is unknown never becomes an event
 * (expandEvents excludes it at source selection), so it leaves no
 * remainder source at all — and the aggregate publishes the
 * genuine-zero figure for a component nobody can state. Fixture
 * (the review's, exactly): asOf 2027-02-01, cash 7200, no income,
 * A/B open 1000/100, APR 12/6, limits 4000, interestByEvent, owner
 * highest-interest policy, extraDebtMonthly 0, debtHorizonDays 31;
 * one ordinary B repayment on Feb 6. On the blocked head the null
 * variant publishes unabsorbed 0 — identical to the genuine-zero
 * control — while a known 200 repayment proves a valid resolution
 * carries a 100 remainder. The repair records the omission itself
 * (same occurrence helpers, same effective-amount test — no
 * fabricated event, no coerced amount, no guessed replay) with
 * the balance the payment would have faced entering its date,
 * and withholds the aggregate whenever that target was live: a
 * known balance above zero (the walk's own zero-balance bypass
 * makes a payment against a known-gone balance a non-event, so a
 * known-zero or already-cleared target endangers nothing), or a
 * balance unknowable at that date (an earlier unknown on the
 * debt, or a same-day unknown capitalisation). Caps and every
 * other numeric field stay untouched in all variants. */
const T_AS_OF = '2027-02-01';
const omittedDebts = (bOpen = 100) => ([
  { id: 'card-a', label: 'Card A', structure: 'Revolving card', balance: 1000,
    pending: 0, rate: 12, limit: 4000, interestByEvent: true, confidence: 'verified' },
  { id: 'card-b', label: 'Card B', structure: 'Revolving card', balance: bOpen,
    pending: 0, rate: 6, limit: 4000, interestByEvent: true, confidence: 'verified' },
]);
function omittedPlan(obligations) {
  const plan = plan2027('bill', 0);
  plan.bills = [];
  plan.windowDays = 31;
  plan.nextDollar = { policy: 'true-surplus-highest-interest',
    eligibleDebts: 'revolving-cards-and-heloc', provenance: 'owner-stated' };
  plan.obligations = obligations;
  return plan;
}
const bRepayment = (amount, include = true, date = '2027-02-06') => {
  const o = { id: 'pay', label: 'Card B repayment', confidence: 'confirmed',
    frequency: 'once', date, debtId: 'card-b', effect: 'payment',
    payingAccount: 'chequing-a' };
  if (include) o.amount = amount;
  return o;
};
const omittedWalk = (obligations, debts) => F.projectDebts(
  omittedPlan(obligations), debts || omittedDebts(), T_AS_OF,
  { extraDebtMonthly: 0, debtHorizonDays: 31 });
{
  const w = omittedWalk([bRepayment(null)]);
  const final = w.marks[w.marks.length - 1];
  const rowA = final.debts.find(d => d.id === 'card-a');
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts && w.scheduledAmounts.status === 'unavailable'
    && w.scheduledAmounts.unknowns.some(u => u.id === 'pay'),
    'B1b omitted repayment precondition: named state unavailable naming the Feb 6 repayment');
  ok(w.unabsorbed === null,
    'B1b omitted repayment: aggregate unabsorbed is withheld (the omitted repayment\u2019s possible remainder is not a published exact 0)',
    `unabsorbed=${w.unabsorbed}`);
  ok(!('2027-02-06:pay' in w.obligationAbsorbed)
    && rowB.balance === null && rowA.balance === 1000
    && w.marks[0].debts.find(d => d.id === 'card-b').balance === 100,
    'B1b omitted repayment: no numeric B cap is invented, B future balance stays withheld, A and the day-zero B stock (100) stay known',
    `obligationAbsorbed=${JSON.stringify(w.obligationAbsorbed)} B=${rowB.balance}`);
}
{
  const w = omittedWalk([bRepayment(0)]);
  const final = w.marks[w.marks.length - 1];
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts.status === 'ready' && w.unabsorbed === 0
    && !('2027-02-06:pay' in w.obligationAbsorbed) && rowB.balance === 100,
    'B1b omitted repayment control: genuine zero repayment — unabsorbed 0, no cap, B 100 publish exactly (unknown is not zero)',
    `unabsorbed=${w.unabsorbed} B=${rowB.balance}`);
}
{
  const w = omittedWalk([bRepayment(200)]);
  const final = w.marks[w.marks.length - 1];
  const rowB = final.debts.find(d => d.id === 'card-b');
  ok(w.scheduledAmounts.status === 'ready' && w.unabsorbed === 100
    && w.obligationAbsorbed['2027-02-06:pay'] === 100 && rowB.balance === 0,
    'B1b omitted repayment control: known 200 repayment — unabsorbed 100 and cap 100 publish exactly',
    `unabsorbed=${w.unabsorbed} B=${rowB.balance}`);
}
for (const [name, amount, include] of [['missing', undefined, false],
    ['NaN', NaN, true], ['comma string "1,900"', '1,900', true]]) {
  const w = omittedWalk([bRepayment(amount, include)]);
  ok(w.scheduledAmounts.status === 'unavailable' && w.unabsorbed === null,
    `B1b omitted repayment (${name} amount): aggregate unabsorbed is withheld`,
    `unabsorbed=${w.unabsorbed}`);
}
{
  const w = omittedWalk([bRepayment(null, true, '2027-02-01')]);
  ok(w.scheduledAmounts.status === 'unavailable' && w.unabsorbed === null,
    'B1b omitted repayment (due today): the repayment faces the known opening 100, so the aggregate is withheld',
    `unabsorbed=${w.unabsorbed}`);
}
{
  // Mixed source: an independent known A remainder (1200 against
  // A\u2019s 1000 on Feb 10) publishes 200 when B\u2019s repayment is a
  // genuine zero and 300 when it is a known 200 — the unknown-B
  // variant must not silently pick the zero figure.
  const aPay = { id: 'a-pay', label: 'Card A repayment', confidence: 'confirmed',
    frequency: 'once', date: '2027-02-10', amount: 1200, debtId: 'card-a',
    effect: 'payment', payingAccount: 'chequing-a' };
  const wNull = omittedWalk([bRepayment(null), aPay]);
  ok(wNull.unabsorbed === null && wNull.obligationAbsorbed['2027-02-10:a-pay'] === 1000,
    'B1b omitted repayment (mixed): aggregate withheld; A\u2019s known take and cap (1000) stay exact',
    `unabsorbed=${wNull.unabsorbed}`);
  const wZero = omittedWalk([bRepayment(0), aPay]);
  ok(wZero.scheduledAmounts.status === 'ready' && wZero.unabsorbed === 200,
    'B1b omitted repayment (mixed) control: genuine zero B repayment — A\u2019s 200 remainder publishes exactly',
    `unabsorbed=${wZero.unabsorbed}`);
  const w200 = omittedWalk([bRepayment(200), aPay]);
  ok(w200.scheduledAmounts.status === 'ready' && w200.unabsorbed === 300
    && w200.obligationAbsorbed['2027-02-06:pay'] === 100,
    'B1b omitted repayment (mixed) control: known 200 B repayment — aggregate 300 (A 200 + B 100) publishes exactly',
    `unabsorbed=${w200.unabsorbed}`);
}
{
  // Negative space (the review\u2019s scope controls): none of these
  // may reroute the aggregate. The known A remainder (200) is the
  // published figure in each.
  const aPay = { id: 'a-pay', label: 'Card A repayment', confidence: 'confirmed',
    frequency: 'once', date: '2027-02-10', amount: 1200, debtId: 'card-a',
    effect: 'payment', payingAccount: 'chequing-a' };
  const bCap = { id: 'b-cap', label: 'Card B capitalised interest', confidence: 'confirmed',
    nonCash: true, effect: 'capitalise', frequency: 'once', date: '2027-02-06',
    amount: null, debtId: 'card-b' };
  const wCap = omittedWalk([bCap, aPay]);
  ok(wCap.scheduledAmounts.status === 'unavailable'
    && wCap.scheduledAmounts.unknowns.some(u => u.id === 'b-cap')
    && wCap.unabsorbed === 200,
    'B1b omitted repayment (scope): unknown capitalisation with no repayment event does not reroute the aggregate (200 stays published)',
    `unabsorbed=${wCap.unabsorbed}`);
  const billPlan = omittedPlan([aPay]);
  billPlan.bills = [{ id: 'bill-x', label: 'Bill', confidence: 'confirmed',
    frequency: 'once', date: '2027-02-06', amount: null }];
  const wBill = F.projectDebts(billPlan, omittedDebts(), T_AS_OF,
    { extraDebtMonthly: 0, debtHorizonDays: 31 });
  ok(wBill.scheduledAmounts.status === 'unavailable' && wBill.unabsorbed === 200,
    'B1b omitted repayment (scope): an unrelated unknown bill does not reroute the aggregate (200 stays published)',
    `unabsorbed=${wBill.unabsorbed}`);
  const stray = { ...bRepayment(null), id: 'stray', debtId: 'card-zzz' };
  const wStray = omittedWalk([stray, aPay]);
  ok(wStray.scheduledAmounts.status === 'unavailable' && wStray.unabsorbed === 200,
    'B1b omitted repayment (scope): a repayment naming no projected debt does not reroute the aggregate (200 stays published)',
    `unabsorbed=${wStray.unabsorbed}`);
}
{
  // Settled-target controls (the review\u2019s nine additional
  // controls): a payment against a balance the walk knows is gone
  // is not made at all, so its unknown size contributes nothing.
  const wZero = omittedWalk([bRepayment(null)], omittedDebts(0));
  ok(wZero.scheduledAmounts.status === 'unavailable' && wZero.unabsorbed === 0,
    'B1b omitted repayment (settled): a known-zero target keeps the aggregate at its exact 0',
    `unabsorbed=${wZero.unabsorbed}`);
  const clear = { id: 'clear', label: 'Card B clearing payment', confidence: 'confirmed',
    frequency: 'once', date: '2027-02-03', amount: 100, debtId: 'card-b',
    effect: 'payment', payingAccount: 'chequing-a' };
  const wCleared = omittedWalk([clear, bRepayment(null)]);
  ok(wCleared.scheduledAmounts.status === 'unavailable' && wCleared.unabsorbed === 0,
    'B1b omitted repayment (settled): a target cleared by an earlier known payment keeps the aggregate at its exact 0',
    `unabsorbed=${wCleared.unabsorbed}`);
  const big = { ...clear, id: 'big', amount: 200 };
  const wEarlier = omittedWalk([big, bRepayment(null)]);
  ok(wEarlier.scheduledAmounts.status === 'unavailable' && wEarlier.unabsorbed === 100,
    'B1b omitted repayment (settled): an earlier known remainder (100) stays published exactly when the later omitted repayment\u2019s target is already cleared',
    `unabsorbed=${wEarlier.unabsorbed}`);
}
{
  // Balance unknowable at the repayment\u2019s date: an earlier unknown
  // capitalisation (Feb 3) leaves B\u2019s Feb 6 balance itself
  // unknown, so even the walk\u2019s bypass question cannot be
  // answered — the aggregate withholds.
  const earlyCap = { id: 'b-cap', label: 'Card B capitalised interest', confidence: 'confirmed',
    nonCash: true, effect: 'capitalise', frequency: 'once', date: '2027-02-03',
    amount: null, debtId: 'card-b' };
  const w = omittedWalk([earlyCap, bRepayment(null)]);
  ok(w.scheduledAmounts.status === 'unavailable' && w.unabsorbed === null,
    'B1b omitted repayment (tainted balance): an earlier unknown on the same debt makes the repayment-date balance unknowable — aggregate withheld',
    `unabsorbed=${w.unabsorbed}`);
}

/* --- U. Consolidated closure family 1 (Atlas ts 1792268485.644529):
 * effective occurrence selection. The cash/debt walk carries
 * unresolved recurring occurrences from (opening.priorAsOf, asOf)
 * into the opening (carriedUnresolvedJointCashOutflows: they are
 * applied at the opening via cashWalkDate), but the detector
 * scanned only [start, end] — a monthly Jan 31 unknown payment
 * disappeared from a Feb 1–3 scan while the finite-200 control
 * provably carries, and Packet/Talk could confirm a later Feb 10
 * payment over it. The classification window now matches the
 * walk's carry window, with the walk's own exclusions: exactly
 * represented (settled) occurrences are omitted, noncash
 * occurrences are never carried, and a plan with no priorAsOf has
 * no lookback. The unknown keeps its real scheduled date — it is
 * named 2027-01-31, never shifted into the scan window. Statement
 * supersession and the no-payment waiver keep working over the
 * widened window because the lookback enumerates occurrences
 * through the same helpers as the in-window scan. */
const U_AS_OF = '2027-02-01';
const U_PRIOR = '2027-01-25';
function lookbackPlan() {
  const plan = plan2027('bill', 0);
  plan.bills = []; plan.obligations = []; plan.commitments = [];
  plan.opening = { asOf: U_AS_OF, priorAsOf: U_PRIOR };
  return plan;
}
const monthlyObligationU = amount => ({ id: 'm-pay', label: 'Monthly card payment',
  confidence: 'confirmed', frequency: 'monthly', day: 31, firstDue: '2027-01-31',
  amount, debtId: 'card-b', effect: 'payment', payingAccount: 'chequing-a' });
const scanU = plan => F.scheduledAmountState(plan, U_AS_OF, '2027-02-03', {});
{
  const plan = lookbackPlan();
  plan.obligations = [monthlyObligationU(null)];
  const s = scanU(plan);
  ok(s.status === 'unavailable'
    && s.unknowns.some(u => u.carrier === 'obligation' && u.id === 'm-pay'
      && u.date === '2027-01-31'),
    'Family 1: monthly Jan 31 unknown payment is classified in a Feb 1–3 scan, naming its real date 2027-01-31',
    `status=${s.status} unknowns=${JSON.stringify(s.unknowns)}`);
  ok(s.unknowns.length > 0 && s.unknowns.every(u => u.date === '2027-01-31'),
    'Family 1: the lookback unknown is not shifted into the scan window — every named date is 2027-01-31',
    `unknowns=${JSON.stringify(s.unknowns)}`);
  const sim = F.simulate(plan, U_AS_OF, { weeklyVariable: 0, horizonDays: 3, viewDays: 3 });
  ok(sim.ending === null && sim.totals.obligations === null,
    'Family 1: simulate withholds its ending and obligation total over the carried Jan 31 unknown',
    `ending=${sim.ending} obligations=${sim.totals.obligations}`);
}
{
  const plan = lookbackPlan();
  plan.obligations = [monthlyObligationU(200)];
  const s = scanU(plan);
  const carried = F.expandEvents(plan, U_AS_OF, '2027-02-03', {})
    .filter(e => e.id === 'm-pay');
  ok(s.status === 'ready' && carried.length === 1
    && carried[0].date === '2027-01-31' && carried[0].amount === -200,
    'Family 1 control: finite 200 Jan 31 payment carries into the walk (event dated 2027-01-31, -200) and the state is ready',
    `status=${s.status} carried=${JSON.stringify(carried.map(e => [e.date, e.amount]))}`);
}
{
  const plan = lookbackPlan();
  plan.bills = [{ id: 'm-bill', label: 'Monthly bill', confidence: 'confirmed',
    frequency: 'monthly', day: 31, firstDue: '2027-01-31', amount: null }];
  const s = scanU(plan);
  ok(s.status === 'unavailable'
    && s.unknowns.some(u => u.carrier === 'bill' && u.id === 'm-bill' && u.date === '2027-01-31'),
    'Family 1: monthly bill Jan 31 unknown is classified in the lookback, naming 2027-01-31',
    `status=${s.status} unknowns=${JSON.stringify(s.unknowns)}`);
  const known = lookbackPlan();
  known.bills = [{ id: 'm-bill', label: 'Monthly bill', confidence: 'confirmed',
    frequency: 'monthly', day: 31, firstDue: '2027-01-31', amount: 200 }];
  const carried = F.expandEvents(known, U_AS_OF, '2027-02-03', {})
    .filter(e => e.id === 'm-bill');
  ok(scanU(known).status === 'ready' && carried.length === 1
    && carried[0].date === '2027-01-31' && carried[0].amount === -200,
    'Family 1 control: monthly bill finite 200 carries and the state is ready');
}
{
  const plan = lookbackPlan();
  plan.obligations = [{ id: 'q-pay', label: 'Quarterly payment', confidence: 'confirmed',
    frequency: 'quarterly', day: 31, firstDue: '2026-10-31', amount: null,
    debtId: 'card-b', effect: 'payment', payingAccount: 'chequing-a' }];
  const s = scanU(plan);
  ok(s.status === 'unavailable'
    && s.unknowns.some(u => u.carrier === 'obligation' && u.id === 'q-pay' && u.date === '2027-01-31'),
    'Family 1: quarterly Jan 31 unknown is classified in the lookback',
    `status=${s.status} unknowns=${JSON.stringify(s.unknowns)}`);
  const planY = lookbackPlan();
  planY.bills = [{ id: 'y-bill', label: 'Yearly bill', confidence: 'confirmed',
    frequency: 'yearly', month: 1, day: 31, firstDue: '2026-01-31', amount: null }];
  const sY = scanU(planY);
  ok(sY.status === 'unavailable'
    && sY.unknowns.some(u => u.carrier === 'bill' && u.id === 'y-bill' && u.date === '2027-01-31'),
    'Family 1: yearly Jan 31 unknown is classified in the lookback',
    `status=${sY.status} unknowns=${JSON.stringify(sY.unknowns)}`);
}
{
  // Exactly represented (settled) occurrences are excluded: the
  // walk omits them, so the state must not classify them either.
  const plan = lookbackPlan();
  plan.obligations = [monthlyObligationU(null)];
  plan.opening.representedEvents = [{ id: 'm-pay', date: '2027-01-31' }];
  ok(scanU(plan).status === 'ready',
    'Family 1 control: Jan 31 occurrence exactly represented as settled — state ready (excluded)');
  const known = lookbackPlan();
  known.obligations = [monthlyObligationU(200)];
  known.opening.representedEvents = [{ id: 'm-pay', date: '2027-01-31' }];
  const carried = F.expandEvents(known, U_AS_OF, '2027-02-03', {})
    .filter(e => e.id === 'm-pay');
  ok(scanU(known).status === 'ready' && carried.length === 0,
    'Family 1 control: represented finite occurrence is not carried by the walk and not classified');
  const waived = lookbackPlan();
  const waivedRow = { id: 'm-bill', label: 'Monthly bill', confidence: 'confirmed',
    frequency: 'monthly', day: 31, firstDue: '2027-01-31', amount: null };
  waivedRow.noPaymentRequiredOn = ['2027-01-31'];
  waived.bills = [waivedRow];
  ok(scanU(waived).status === 'ready',
    'Family 1 control: waived Jan 31 occurrence (noPaymentRequiredOn) — state ready over the widened window');
}
{
  // Noncash lookback occurrences are never carried (the carry
  // helper excludes kind 'noncash'), so they are not classified.
  const plan = lookbackPlan();
  plan.obligations = [{ id: 'm-cap', label: 'Capitalised interest', confidence: 'confirmed',
    nonCash: true, effect: 'capitalise', frequency: 'monthly', day: 31,
    firstDue: '2027-01-31', amount: null, debtId: 'card-b' }];
  ok(scanU(plan).status === 'ready',
    'Family 1 control: noncash Jan 31 unknown in the lookback is excluded — state ready');
  const known = lookbackPlan();
  known.obligations = [{ id: 'm-cap', label: 'Capitalised interest', confidence: 'confirmed',
    nonCash: true, effect: 'capitalise', frequency: 'monthly', day: 31,
    firstDue: '2027-01-31', amount: 200, debtId: 'card-b' }];
  const carried = F.expandEvents(known, U_AS_OF, '2027-02-03', {})
    .filter(e => e.id === 'm-cap' && e.date === '2027-01-31');
  ok(scanU(known).status === 'ready' && carried.length === 0,
    'Family 1 control: noncash Jan 31 occurrence is not carried by the walk');
}
{
  // No priorAsOf — no lookback at all (the walk carries nothing).
  const plan = lookbackPlan();
  plan.opening = { asOf: U_AS_OF };
  plan.obligations = [monthlyObligationU(null)];
  ok(scanU(plan).status === 'ready',
    'Family 1 control: no priorAsOf — the Jan 31 occurrence is not classified');
  const degenerate = lookbackPlan();
  degenerate.opening = { asOf: U_AS_OF, priorAsOf: U_AS_OF };
  degenerate.obligations = [monthlyObligationU(null)];
  ok(scanU(degenerate).status === 'ready',
    'Family 1 control: priorAsOf not before the opening — no lookback');
  // An occurrence before priorAsOf is outside the carry window.
  const before = lookbackPlan();
  before.obligations = [{ id: 'm-pay', label: 'Monthly card payment', confidence: 'confirmed',
    frequency: 'monthly', day: 20, firstDue: '2027-01-20', amount: null,
    debtId: 'card-b', effect: 'payment', payingAccount: 'chequing-a' }];
  ok(scanU(before).status === 'ready',
    'Family 1 control: a Jan 20 occurrence (before priorAsOf Jan 25) is outside the carry window — not classified');
  // A same-window unknown behaves identically, named once, unshifted.
  const inWindow = lookbackPlan();
  inWindow.obligations = [{ id: 'm-pay', label: 'Monthly card payment', confidence: 'confirmed',
    frequency: 'monthly', day: 2, firstDue: '2027-01-02', amount: null,
    debtId: 'card-b', effect: 'payment', payingAccount: 'chequing-a' }];
  const sIn = scanU(inWindow);
  ok(sIn.status === 'unavailable' && sIn.unknowns.length === 1
    && sIn.unknowns[0].date === '2027-02-02',
    'Family 1 control: same-window unknown (Feb 2) is named exactly once with its real date',
    `unknowns=${JSON.stringify(sIn.unknowns)}`);
}
{
  // Packet consequence: the monthly obligation's later occurrences
  // are statement-covered at a known 200 minimum, so only the
  // Jan 31 fallback occurrence is unknown. Before this repair the
  // packet confirmed the later Feb 10 bill as the next due / next
  // payment out; with the Jan 31 occurrence classified, the claim
  // is withheld (the packet's on-or-before predicate has no as-of
  // lower bound: an earlier unresolved obligation is one a "next"
  // claim cannot skip).
  const Talk = require('../scripts/talk-gemini.js');
  const claimsText = JSON.stringify({ status: 'explained', claims: [
    { path: 'current.nextSignificantObligations.nextDue.label', equals: 'Invented later bill' },
    { path: 'current.nextSignificantObligations.nextDue.date', equals: '2027-02-10' },
    { path: 'current.nextSignificantObligations.nextDue.amount', equals: 125 }] });
  const stmtObligation = coverJan31 => {
    const row = { id: 'm-pay', label: 'Monthly card payment', confidence: 'estimated',
      frequency: 'monthly', day: 31, firstDue: '2027-01-31', amount: null,
      debtId: 'card-b', effect: 'payment', payingAccount: 'chequing-a' };
    const dates = F.occurrences(row, '2027-02-01', '2029-06-30');
    row.statementOccurrences = dates.map(d => ({ scheduledDate: d, dueDate: d,
      minimum: 200, currency: 'cad', confidence: 'confirmed' }));
    if (coverJan31) row.statementOccurrences.unshift({ scheduledDate: '2027-01-31',
      dueDate: '2027-01-31', minimum: 200, currency: 'cad', confidence: 'confirmed' });
    return row;
  };
  const packetPlanU = coverJan31 => {
    const plan = packetPlan([billRow('later-bill', 'Invented later bill', '2027-02-10', 125)]);
    plan.opening = { asOf: U_AS_OF, priorAsOf: U_PRIOR };
    plan.obligations = [stmtObligation(coverJan31)];
    return plan;
  };
  const packet = buildPacketFor(packetPlanU(false));
  const nso = packet.current.nextSignificantObligations;
  ok(nso.nextDue === null && nso.nextPaymentOut === null,
    'Family 1 packet: the carried Jan 31 unknown withholds the Feb 10 nextDue/nextPaymentOut claims',
    `nextDue=${JSON.stringify(nso.nextDue)}`);
  ok(packet.uncertainty.scheduledAmounts
    && packet.uncertainty.scheduledAmounts.status === 'unavailable'
    && packet.uncertainty.scheduledAmounts.unknowns.some(u => u.date === '2027-01-31')
    && packet.forecast.recommendation.holds === null,
    'Family 1 packet: packet uncertainty names the Jan 31 unknown and holds stays null');
  ok(Talk.materializeExplainerAnswer(claimsText, packet).ok === false,
    'Family 1 Talk: the Feb 10 next-due claims no longer verify against the packet');
  const control = buildPacketFor(packetPlanU(true));
  ok(control.current.nextSignificantObligations.nextDue
    && control.current.nextSignificantObligations.nextDue.date === '2027-02-10'
    && control.current.nextSignificantObligations.nextDue.amount === 125
    && control.current.nextSignificantObligations.nextDue.confidence === 'confirmed'
    && !control.uncertainty.scheduledAmounts
    && Talk.materializeExplainerAnswer(claimsText, control).ok === true,
    'Family 1 control: statement covers the Jan 31 occurrence too — Feb 10 claim publishes and Talk verifies');
}

/* --- V. Consolidated closure family 2b (Atlas ts 1792268485.644529):
 * remainder provenance — rounded-allocation completeness. Round 5's
 * completeness decision compared the ROUNDED remainder
 * (roundCent(extraTotal − sum of cent-rounded line amounts)) against
 * EPSILON, so a sub-cent remainder read as zero: real extra 1000.004
 * in the §R shape (A known, absorbs exactly 1000; B's balance
 * unknown behind a null capitalisation) published a record
 * byte-identical to the genuinely complete genuine-zero control —
 * no partial stamp, no extraAbsorbedUnknown mark, and unabsorbed
 * published as an exact 0.004 — while the 200 control proves B
 * would have taken the 0.004 tail. The tail's destination is
 * uncertain, so completeness is now decided on the walk's
 * UNROUNDED leftover: any nonzero remainder that could route into
 * a tainted position qualifies the split exactly as round 5 does
 * for larger remainders. Genuine 1000 stays complete, 1500 stays
 * partial for the ordinary reason, and a sub-cent tail whose every
 * destination is known stays complete with exact values. */
const roundedWalk = (capAmount, extra) => F.projectDebts(remainderPlan(capAmount),
  cascadeDebts(), R_AS_OF, { extraDebtMonthly: extra, debtHorizonDays: 20 });
{
  const w = roundedWalk(null, 1000.004);
  const rec = w.extraDebtAllocation['2027-02-15'];
  ok(w.scheduledAmounts && w.scheduledAmounts.status === 'unavailable'
    && w.scheduledAmounts.unknowns.some(u => u.id === 'b-cap'),
    'Family 2b precondition: named state unavailable naming the Feb 6 capitalisation (extra 1000.004)');
  ok(rec && rec.allocations.length === 1 && rec.allocations[0].debtId === 'card-a'
    && rec.allocations[0].amount === 1000 && rec.allocations[0].status === 'calculated'
    && rec.nextTarget === null && rec.status === 'partial',
    'Family 2b: extra 1000.004 — A’s determined take (1000, calculated) still publishes, and the record is stamped partial — the 0.004 tail is not a complete split',
    `record=${JSON.stringify(rec || null)}`);
  ok(w.extraAbsorbed['2027-02-15'] === 1000,
    'Family 2b: extraAbsorbed keeps the determined 1000 exactly (the caps value — not the 1000.004 asked, not erased)',
    `extraAbsorbed=${JSON.stringify(w.extraAbsorbed)}`);
  ok(w.extraAbsorbedUnknown && w.extraAbsorbedUnknown['2027-02-15'] === true,
    'Family 2b: the Feb 15 absorbed total is named not-exactly-known in extraAbsorbedUnknown',
    `extraAbsorbedUnknown=${JSON.stringify(w.extraAbsorbedUnknown || null)}`);
  ok(w.unabsorbed === null,
    'Family 2b: aggregate unabsorbed is withheld (the 0.004 remainder is uncertain, not a published exact 0.004)',
    `unabsorbed=${w.unabsorbed}`);
  const final = w.marks[w.marks.length - 1];
  const rowA = final.debts.find(d => d.id === 'card-a');
  ok(rowA.balance === 0 && rowA.paid === 1000 && w.byId['card-a'].balance === 0,
    'Family 2b: upstream card A metrics retained (balance 0 / paid 1000)',
    `A=${rowA.balance}/${rowA.paid}`);
}
{
  // However small: a 0.0001 tail is a real remainder, not dust —
  // it qualifies identically.
  const w = roundedWalk(null, 1000.0001);
  const rec = w.extraDebtAllocation['2027-02-15'];
  ok(rec && rec.status === 'partial'
    && w.extraAbsorbedUnknown && w.extraAbsorbedUnknown['2027-02-15'] === true
    && w.unabsorbed === null && w.extraAbsorbed['2027-02-15'] === 1000,
    'Family 2b: extra 1000.0001 — the 0.0001 tail qualifies identically (partial stamp, mark, withheld aggregate)',
    `record=${JSON.stringify(rec || null)} unabsorbed=${w.unabsorbed}`);
}
{
  // Genuine 1000: A's determined take exhausts the extra exactly —
  // the split is complete in every resolution and is NOT qualified
  // (the aggregate still publishes: this fixture's only unknown is
  // the noncash capitalisation, which leaves no remainder source).
  const w = roundedWalk(null, 1000);
  const rec = w.extraDebtAllocation['2027-02-15'];
  ok(rec && !('status' in rec) && rec.allocations.length === 1
    && rec.allocations[0].amount === 1000
    && w.extraAbsorbed['2027-02-15'] === 1000 && w.unabsorbed === 0
    && !(w.extraAbsorbedUnknown && w.extraAbsorbedUnknown['2027-02-15']),
    'Family 2b control: genuine extra 1000 — exhaustive split stays complete and unmarked, unabsorbed publishes 0',
    `record=${JSON.stringify(rec || null)} unabsorbed=${w.unabsorbed}`);
}
{
  // 1500 stays partial for the ordinary (round-5) reason.
  const w = roundedWalk(null, 1500);
  const rec = w.extraDebtAllocation['2027-02-15'];
  ok(rec && rec.status === 'partial'
    && w.extraAbsorbedUnknown && w.extraAbsorbedUnknown['2027-02-15'] === true
    && w.unabsorbed === null && w.extraAbsorbed['2027-02-15'] === 1000,
    'Family 2b control: extra 1500 — still partial with mark and withheld aggregate (ordinary 500 remainder)',
    `record=${JSON.stringify(rec || null)}`);
}
{
  // Sub-cent tail, every destination known: capitalisation a known
  // 200, so B's balance is known and B takes the 0.004 tail — the
  // split is complete, the absorbed total is the exact 1000.004
  // asked, and nothing is qualified. (B's line publishes in cents,
  // as all lines do: 0.)
  const w = roundedWalk(200, 1000.004);
  const rec = w.extraDebtAllocation['2027-02-15'];
  const line = id => rec && rec.allocations.find(l => l.debtId === id);
  ok(w.scheduledAmounts.status === 'ready' && rec && !('status' in rec)
    && line('card-a') && line('card-a').amount === 1000
    && line('card-b') && line('card-b').amount === 0
    && w.extraAbsorbed['2027-02-15'] === 1000.004 && w.unabsorbed === 0
    && !(w.extraAbsorbedUnknown && w.extraAbsorbedUnknown['2027-02-15']),
    'Family 2b control: extra 1000.004 with B known (cap 200) — tail lands on B, split complete, absorbed exactly 1000.004, unabsorbed 0',
    `record=${JSON.stringify(rec || null)} extraAbsorbed=${JSON.stringify(w.extraAbsorbed)}`);
}
{
  // Genuine zero capitalisation with the same sub-cent tail: B's
  // balance is known to be 0, so the 0.004 remainder is genuinely
  // unabsorbed — it publishes (to float precision), unmarked.
  const w = roundedWalk(0, 1000.004);
  const rec = w.extraDebtAllocation['2027-02-15'];
  ok(w.scheduledAmounts.status === 'ready' && rec && !('status' in rec)
    && w.extraAbsorbed['2027-02-15'] === 1000
    && typeof w.unabsorbed === 'number' && Math.abs(w.unabsorbed - 0.004) < 1e-9
    && !(w.extraAbsorbedUnknown && w.extraAbsorbedUnknown['2027-02-15']),
    'Family 2b control: genuine zero capitalisation, extra 1000.004 — complete split publishes the true 0.004 remainder, unmarked',
    `record=${JSON.stringify(rec || null)} unabsorbed=${w.unabsorbed}`);
}

/* --- W. Consolidated closure family 3 (Atlas ts 1792268485.644529):
 * dependency precision. The round-4 fixpoint spread taint through an
 * extra payment's chain by POSITION alone: once any member was
 * tainted at-or-before the extra's date, every later position was
 * tainted from that date — whether or not the extra's value could
 * actually reach the tainted position. Fixture: A/B/C each open
 * 1000, APR 12/6/3, limits 4000, interestByEvent, owner
 * highest-interest policy (chain A -> B -> C); B noncash
 * capitalisation Feb 6 (null vs genuine 0 vs 200); real extra 500
 * on Feb 15, wholly absorbed by A (arrival at B is zero in every
 * resolution); known C repayment 1200 on Feb 20 against C's own
 * untouched 1000 balance. On the unrepaired tree the null variant
 * withholds C's final metrics (null/null/null), C's byId figures
 * and the aggregate unabsorbed — byte-identical withholding to the
 * extra-1500 case, where the flow genuinely passes B — while the
 * genuine-zero and 200 controls publish C 0/1000/4000 and
 * unabsorbed 200. Taint may cross a chain position only when value
 * actually arrives there: the walk's own recorded takes decide
 * arrival, never a replay. True dependency is preserved: extra
 * 1500 reaches B with 500, so everything downstream of B — the
 * allocation record, C's metrics, the aggregate — stays qualified
 * exactly as rounds 4–6 pinned it. */
const W_AS_OF = '2027-02-01';
function precisionPlan(capAmount) {
  const plan = plan2027('bill', 0);
  plan.bills = [];
  plan.windowDays = 31;
  plan.nextDollar = { policy: 'true-surplus-highest-interest',
    eligibleDebts: 'revolving-cards-and-heloc', provenance: 'owner-stated' };
  plan.obligations = [
    { id: 'b-cap', label: 'Card B capitalised interest', confidence: 'confirmed',
      nonCash: true, effect: 'capitalise', frequency: 'once', date: '2027-02-06',
      amount: capAmount, debtId: 'card-b' },
    { id: 'c-pay', label: 'Card C payment', confidence: 'confirmed',
      frequency: 'once', date: '2027-02-20', amount: 1200, debtId: 'card-c',
      effect: 'payment', payingAccount: 'chequing-a' },
  ];
  return plan;
}
const precisionDebts = () => ([
  { id: 'card-a', label: 'Card A', structure: 'Revolving card', balance: 1000,
    pending: 0, rate: 12, limit: 4000, interestByEvent: true, confidence: 'verified' },
  { id: 'card-b', label: 'Card B', structure: 'Revolving card', balance: 1000,
    pending: 0, rate: 6, limit: 4000, interestByEvent: true, confidence: 'verified' },
  { id: 'card-c', label: 'Card C', structure: 'Revolving card', balance: 1000,
    pending: 0, rate: 3, limit: 4000, interestByEvent: true, confidence: 'verified' },
]);
const precisionWalk = (capAmount, extra) => F.projectDebts(
  precisionPlan(capAmount), precisionDebts(), W_AS_OF,
  { extraDebtMonthly: extra, debtHorizonDays: 31 });
{
  const w = precisionWalk(null, 500);
  const final = w.marks[w.marks.length - 1];
  const rowA = final.debts.find(d => d.id === 'card-a');
  const rowB = final.debts.find(d => d.id === 'card-b');
  const rowC = final.debts.find(d => d.id === 'card-c');
  ok(w.scheduledAmounts && w.scheduledAmounts.status === 'unavailable'
    && w.scheduledAmounts.unknowns.some(u => u.id === 'b-cap'),
    'Family 3 precondition: named state unavailable naming the Feb 6 capitalisation on B');
  ok(rowC.balance === 0 && rowC.paid === 1000 && rowC.available === 4000
    && w.byId['card-c'].balance === 0 && w.byId['card-c'].paid === 1000,
    'Family 3: the extra wholly absorbed by A never reaches B, so C is NOT tainted — final metrics publish 0 / paid 1000 / credit-left 4000',
    `C=${rowC.balance}/${rowC.paid}/${rowC.available} byId C=${w.byId['card-c'].balance}/${w.byId['card-c'].paid}`);
  ok(w.obligationAbsorbed['2027-02-20:c-pay'] === 1000 && w.unabsorbed === 200,
    'Family 3: C\u2019s later known repayment keeps its invariant — take exactly 1000, remainder exactly 200 published in the aggregate',
    `obligationAbsorbed=${JSON.stringify(w.obligationAbsorbed)} unabsorbed=${w.unabsorbed}`);
  const rec = w.extraDebtAllocation['2027-02-15'];
  ok(rec && rec.allocations.length === 1 && rec.allocations[0].debtId === 'card-a'
    && rec.allocations[0].amount === 500 && rec.allocations[0].status === 'calculated'
    && !('status' in rec)
    && !(w.extraAbsorbedUnknown && w.extraAbsorbedUnknown['2027-02-15']),
    'Family 3: the Feb 15 split is complete in every resolution (A takes all 500) — record publishes unmarked, no partial stamp',
    `record=${JSON.stringify(rec || null)}`);
  ok(rowA.balance === 500 && rowA.paid === 500 && rowA.available === 3500
    && rowB.balance === null && rowB.paid === null && w.byId['card-b'].balance === null
    && w.byId['card-b'].capitalised === null,
    'Family 3: A\u2019s determined metrics retained (500/500/3500); B \u2014 the debt the unknown is actually on \u2014 stays withheld',
    `A=${rowA.balance}/${rowA.paid}/${rowA.available} B=${rowB.balance}`);
  const day0 = id => w.marks[0].debts.find(d => d.id === id).balance;
  ok(day0('card-a') === 1000 && day0('card-b') === 1000 && day0('card-c') === 1000,
    'Family 3: day-zero stocks publish exactly for all three cards (1000 each), B included');
}
{
  // Precision is equality, not approximation: in the null variant
  // C's published figures are byte-identical to the genuine-zero
  // control's, because no resolution of B's capitalisation can
  // change any of them.
  const wNull = precisionWalk(null, 500);
  const wZero = precisionWalk(0, 500);
  const cOf = w => w.marks[w.marks.length - 1].debts.find(d => d.id === 'card-c');
  const cNull = cOf(wNull);
  const cZero = cOf(wZero);
  ok(wZero.scheduledAmounts.status === 'ready'
    && cNull.balance === cZero.balance && cNull.paid === cZero.paid
    && cNull.available === cZero.available
    && wNull.unabsorbed === wZero.unabsorbed && wZero.unabsorbed === 200,
    'Family 3 control: genuine zero capitalisation — C publishes identically (0/1000/4000, unabsorbed 200) in the known and unknown variants',
    `null C=${cNull.balance}/${cNull.paid}/${cNull.available} zero C=${cZero.balance}/${cZero.paid}/${cZero.available}`);
  const w200 = precisionWalk(200, 500);
  const c200 = cOf(w200);
  ok(w200.scheduledAmounts.status === 'ready' && c200.balance === 0
    && c200.paid === 1000 && c200.available === 4000 && w200.unabsorbed === 200,
    'Family 3 control: capitalisation known 200 — state ready, C 0/1000/4000 and unabsorbed 200 publish',
    `C=${c200.balance}/${c200.paid}/${c200.available} unabsorbed=${w200.unabsorbed}`);
}
{
  // True dependency preserved: extra 1500 exhausts A (1000) and
  // arrives at the tainted position B with 500, so the flow past B
  // is genuinely unknown — the record withholds (a take sits at the
  // tainted position), the date is marked, C's downstream metrics
  // withhold, and C's remainder qualifies the aggregate, exactly
  // the rounds 4–6 behaviour.
  const w = precisionWalk(null, 1500);
  const final = w.marks[w.marks.length - 1];
  const rowC = final.debts.find(d => d.id === 'card-c');
  ok(w.extraDebtAllocation['2027-02-15'] === undefined
    && w.extraAbsorbedUnknown && w.extraAbsorbedUnknown['2027-02-15'] === true
    && w.extraAbsorbed['2027-02-15'] === 1500,
    'Family 3 (true dependency): extra 1500 reaches B — the allocation record withholds, the date is marked, the caps value stays numeric (1500)',
    `extraAbsorbed=${JSON.stringify(w.extraAbsorbed)}`);
  ok(rowC.balance === null && rowC.paid === null && w.byId['card-c'].balance === null
    && w.unabsorbed === null,
    'Family 3 (true dependency): C IS downstream of a reached unknown — its metrics and its remainder stay withheld',
    `C=${rowC.balance}/${rowC.paid} unabsorbed=${w.unabsorbed}`);
}

/* --- X. Consolidated closure family 4 (Atlas ts 1792268485.644529):
 * consumers — two publication boundaries still assert claims that
 * depend on an unknown the earlier families classified.
 *
 * 4a, credit nextPayment ordering: creditAccounts selects a debt's
 * next payment as the earliest KNOWN payment event on/after the
 * as-of. A scheduled repayment on the SAME debt whose own amount is
 * unknown is omitted at event construction (the round-7 shape), so
 * the selection silently steps over it and presents a LATER known
 * payment as the confirmed next payment — false ordering: an
 * unknown payment comes first and its size is unknown. Fixture:
 * card B, omitted unknown repayment Feb 6, known repayment Feb 10
 * of 125. On the unrepaired tree nextPayment publishes the Feb 10
 * payment with confidence 'confirmed'. The repair withholds the
 * claim (nextPayment null — the shape the credit page already
 * renders as Unknown) when an omitted unknown repayment on that
 * debt sits at-or-before the candidate's date. Precision controls:
 * an earlier KNOWN payment still selects; an omitted unknown on a
 * DIFFERENT debt does not reach this debt's claim; an omitted
 * unknown AFTER the candidate does not displace it (the candidate
 * is genuinely next); an unknown CAPITALISATION is not a repayment
 * and does not gate the payment claim; the debt's opening balance,
 * rate and limit are independent stocks and stay exact.
 *
 * 4b, plannedDebt feasibility: plannedDebt computes a facility's
 * ending balance through projectDebts, whose publication already
 * withholds a tainted debt's balance/interest as null. The planner
 * then derived its verdicts from the withheld fields as if they
 * were numbers: interest published null − null = 0, and the limit
 * test read a null balance as never crossing, so feasible came out
 * true. Fixture (Atlas's): facility opening 1000 / limit 4000,
 * unknown capitalisation Feb 6, opted-in draw 100 on Feb 20,
 * monthly repay 50. On the unrepaired tree the direct output and
 * recommend.plannedDebt both publish feasible:true and interest:0
 * beside endingBalance:null. The verdict genuinely straddles the
 * unknown — capitalisation known 0 publishes feasible with ending
 * 950; known 5000 publishes feasible:false with ending 5950 — so
 * both dependent claims qualify to null (the representation this
 * function already uses when a planned-debt answer is unknowable),
 * on both surfaces, while every known input and independent output
 * (permitted, borrowed, capacity, draws, repayment cadence) stays
 * published exactly. */
const X_AS_OF = '2027-02-01';
const creditDebts = () => ([
  { id: 'card-a', label: 'Card A', balance: 500, pending: 0, rate: 12, limit: 4000, confidence: 'verified' },
  { id: 'card-b', label: 'Card B', balance: 1000, pending: 0, rate: 6, limit: 4000, confidence: 'verified' },
]);
function creditPlan(obligations) {
  const plan = plan2027('bill', 0);
  plan.bills = [];
  plan.windowDays = 60;
  plan.obligations = obligations;
  return plan;
}
const debtPay = (id, date, amount, debtId) => ({ id, label: 'Payment ' + id,
  confidence: 'confirmed', frequency: 'once', date, amount, debtId,
  effect: 'payment', payingAccount: 'chequing-a' });
const creditRow = (plan, id) => {
  const acc = F.creditAccounts(plan, creditDebts(), X_AS_OF, {});
  return [...(acc.secured || []), ...(acc.cards || [])].find(r => r.id === id);
};
{
  const plan = creditPlan([debtPay('b-early', '2027-02-06', null, 'card-b'),
    debtPay('b-late', '2027-02-10', 125, 'card-b')]);
  const st = F.scheduledAmountState(plan, X_AS_OF, '2027-04-02', {});
  ok(st.status === 'unavailable' && st.unknowns.some(u => u.id === 'b-early'),
    'Family 4a precondition: named state unavailable naming the omitted Feb 6 repayment');
  const row = creditRow(plan, 'card-b');
  ok(row.nextPayment === null,
    'Family 4a: an omitted unknown repayment (Feb 6) precedes the known Feb 10 payment on the same debt — nextPayment is withheld, not presented as the confirmed Feb 10 / 125 payment',
    `nextPayment=${JSON.stringify(row.nextPayment)}`);
  ok(row.balance === 1000 && row.rate === 6 && row.limit === 4000,
    'Family 4a: the same debt\u2019s opening balance / rate / limit stay exact (1000 / 6 / 4000) — they do not depend on the payment schedule',
    `balance=${row.balance} rate=${row.rate} limit=${row.limit}`);
}
{
  const row = creditRow(creditPlan([debtPay('b-early', '2027-02-10', null, 'card-b'),
    debtPay('b-late', '2027-02-10', 125, 'card-b')]), 'card-b');
  ok(row.nextPayment === null,
    'Family 4a: an omitted unknown repayment ON the candidate\u2019s own date (Feb 10) also withholds the claim — at-or-before, not only strictly before',
    `nextPayment=${JSON.stringify(row.nextPayment)}`);
}
{
  const row = creditRow(creditPlan([debtPay('b-early', '2027-02-06', 125, 'card-b'),
    debtPay('b-late', '2027-02-10', 200, 'card-b')]), 'card-b');
  ok(row.nextPayment && row.nextPayment.date === '2027-02-06'
    && row.nextPayment.amount === 125 && row.nextPayment.confidence === 'confirmed',
    'Family 4a control: an earlier KNOWN payment still selects normally — nextPayment is the Feb 6 / 125 confirmed payment',
    `nextPayment=${JSON.stringify(row.nextPayment)}`);
}
{
  const plan = creditPlan([debtPay('b-early', '2027-02-06', null, 'card-b'),
    debtPay('a-late', '2027-02-10', 125, 'card-a')]);
  const rowA = creditRow(plan, 'card-a');
  ok(rowA.nextPayment && rowA.nextPayment.date === '2027-02-10'
    && rowA.nextPayment.amount === 125 && rowA.nextPayment.confidence === 'confirmed',
    'Family 4a control: an omitted unknown on a DIFFERENT debt does not reach this debt\u2019s nextPayment — card A publishes Feb 10 / 125 confirmed',
    `nextPayment=${JSON.stringify(rowA.nextPayment)}`);
}
{
  const row = creditRow(creditPlan([debtPay('b-late', '2027-02-10', 125, 'card-b'),
    debtPay('b-later', '2027-02-20', null, 'card-b')]), 'card-b');
  ok(row.nextPayment && row.nextPayment.date === '2027-02-10'
    && row.nextPayment.amount === 125 && row.nextPayment.confidence === 'confirmed',
    'Family 4a control: an omitted unknown AFTER the candidate does not displace it — the Feb 10 / 125 payment is genuinely next and stays confirmed',
    `nextPayment=${JSON.stringify(row.nextPayment)}`);
}
{
  const bCap = { id: 'b-cap', label: 'Card B capitalised interest', confidence: 'confirmed',
    nonCash: true, effect: 'capitalise', frequency: 'once', date: '2027-02-06',
    amount: null, debtId: 'card-b' };
  const row = creditRow(creditPlan([bCap,
    debtPay('b-late', '2027-02-10', 125, 'card-b')]), 'card-b');
  ok(row.nextPayment && row.nextPayment.date === '2027-02-10'
    && row.nextPayment.amount === 125 && row.nextPayment.confidence === 'confirmed',
    'Family 4a control: an unknown CAPITALISATION on the same debt is not a repayment — the known Feb 10 / 125 payment claim stays confirmed',
    `nextPayment=${JSON.stringify(row.nextPayment)}`);
}
function plannedFixture(capAmount) {
  const plan = plan2027('bill', 0);
  plan.bills = [];
  plan.windowDays = 60;
  plan.obligations = [
    { id: 'f-cap', label: 'Facility capitalised interest', confidence: 'confirmed',
      nonCash: true, effect: 'capitalise', frequency: 'once', date: '2027-02-06',
      amount: capAmount, debtId: 'card-f' },
  ];
  plan.commitments = [
    { id: 'gap-item', label: 'Unfunded', date: '2027-02-20', amount: 2000, confidence: 'confirmed' },
  ];
  return plan;
}
const facilityDebt = () => ({ id: 'card-f', label: 'Facility', balance: 1000,
  pending: 0, rate: 12, limit: 4000, interestByEvent: true, confidence: 'verified' });
const plannedOpts = () => ({ allowPlannedDebt: true, plannedDebtFacility: 'card-f',
  plannedDebtPurposes: ['gap-item'], plannedDebtAmounts: { 'gap-item': 100 },
  plannedDebtPayment: 50, debts: [facilityDebt()], weeklyVariable: 0 });
{
  const r = F.plannedDebt(plannedFixture(null), X_AS_OF, plannedOpts());
  ok(r.endingBalance === null && r.feasible === null && r.interest === null,
    'Family 4b: unknown capitalisation — the ending balance is withheld and the dependent verdicts qualify with it (feasible not true, interest not 0)',
    `feasible=${r.feasible} interest=${r.interest} endingBalance=${r.endingBalance}`);
  ok(r.permitted === true && r.borrowed === 100 && r.capacity === 3000
    && r.draws.length === 1 && r.draws[0].amount === 100 && r.draws[0].date === '2027-02-20'
    && r.repayment && r.repayment.monthlyPayment === 50,
    'Family 4b: the known claims of the same answer stay published exactly (permitted, borrowed 100, capacity 3000, the Feb 20 draw, repay 50 cadence)',
    `borrowed=${r.borrowed} capacity=${r.capacity} draws=${JSON.stringify(r.draws)}`);
}
{
  const rec = F.recommend(plannedFixture(null), X_AS_OF, plannedOpts());
  ok(rec.plannedDebt && rec.plannedDebt.endingBalance === null
    && rec.plannedDebt.feasible === null && rec.plannedDebt.interest === null,
    'Family 4b: recommend.plannedDebt agrees with the direct surface — feasible and interest qualify with the unknown ending balance',
    `plannedDebt=${JSON.stringify(rec.plannedDebt && { feasible: rec.plannedDebt.feasible, interest: rec.plannedDebt.interest, endingBalance: rec.plannedDebt.endingBalance })}`);
  ok(rec.plannedDebt.borrowed === 100 && rec.plannedDebt.capacity === 3000
    && rec.plannedDebt.items.length === 1 && rec.plannedDebt.items[0].remaining === 100
    && rec.majorPlans.some(p => p.id === 'gap-item' && p.need === 2000),
    'Family 4b: unrelated outputs of the same recommend call stay published (borrowed 100, capacity 3000, the financed item, the commitment\u2019s contractual need 2000) — no blanket reroute',
    `borrowed=${rec.plannedDebt.borrowed} items=${JSON.stringify(rec.plannedDebt.items)}`);
}
{
  const r0 = F.plannedDebt(plannedFixture(0), X_AS_OF, plannedOpts());
  ok(r0.feasible === true && r0.interest === 0 && r0.endingBalance === 950,
    'Family 4b control: capitalisation known 0 — feasible true, interest 0 and ending 950 publish exactly (the zero resolution of the straddle)',
    `feasible=${r0.feasible} interest=${r0.interest} ending=${r0.endingBalance}`);
  const r500 = F.plannedDebt(plannedFixture(500), X_AS_OF, plannedOpts());
  ok(r500.feasible === true && r500.interest === 0 && r500.endingBalance === 1450,
    'Family 4b control: capitalisation known 500 — feasible true, interest 0 and ending 1450 publish exactly',
    `feasible=${r500.feasible} interest=${r500.interest} ending=${r500.endingBalance}`);
  const r5000 = F.plannedDebt(plannedFixture(5000), X_AS_OF, plannedOpts());
  ok(r5000.feasible === false && r5000.endingBalance === 5950,
    'Family 4b control: capitalisation known 5000 — the plan publishes feasible FALSE with ending 5950 (the other resolution of the straddle: the unknown case can state neither verdict)',
    `feasible=${r5000.feasible} ending=${r5000.endingBalance}`);
  const rec0 = F.recommend(plannedFixture(0), X_AS_OF, plannedOpts());
  ok(rec0.plannedDebt && rec0.plannedDebt.feasible === true
    && rec0.plannedDebt.endingBalance === 950,
    'Family 4b control: recommend.plannedDebt publishes the known-zero case exactly (feasible true, ending 950)',
    `plannedDebt=${JSON.stringify(rec0.plannedDebt && { feasible: rec0.plannedDebt.feasible, endingBalance: rec0.plannedDebt.endingBalance })}`);
}

/* --- Y. Takeover verification, families 1 and 2: omitted repayment
 * provenance follows the effective carry and the actual event position.
 * Independent arithmetic: a 200 payment against 100 leaves 100; a 500
 * payment after a 200 charge leaves 300. Before that charge, a payment
 * against zero is bypassed and leaves zero. No guessed unknown amount
 * may select one of those outcomes. All fixtures are synthetic. */
const carryRemainderWalk = (amount, modify = () => {}, openingBalance = 100) => {
  const plan = lookbackPlan();
  plan.obligations = [monthlyObligationU(amount)];
  modify(plan);
  return F.projectDebts(plan, omittedDebts(openingBalance), U_AS_OF,
    { extraDebtMonthly: 0, debtHorizonDays: 3 });
};
{
  const unknown = carryRemainderWalk(null);
  const zero = carryRemainderWalk(0);
  const finite = carryRemainderWalk(200);
  ok(unknown.scheduledAmounts.unknowns.length === 1
    && unknown.scheduledAmounts.unknowns[0].date === '2027-01-31'
    && unknown.unabsorbed === null
    && !('2027-01-31:m-pay' in unknown.obligationAbsorbed)
    && unknown.marks[0].debts.find(d => d.id === 'card-b').balance === 100,
    'Family 2 carry: Jan 31 unknown repayment applies at the Feb 1 opening; remainder withheld without an invented cap or changed opening');
  ok(zero.scheduledAmounts.status === 'ready' && zero.unabsorbed === 0
    && zero.byId['card-b'].balance === 100
    && finite.unabsorbed === 100 && finite.byId['card-b'].balance === 0
    && finite.obligationAbsorbed['2027-01-31:m-pay'] === 100,
    'Family 2 carry controls: zero leaves balance 100; known 200 leaves remainder 100 and original-date cap 100');
  const gone = carryRemainderWalk(null, () => {}, 0);
  ok(gone.unabsorbed === 0 && Object.keys(gone.obligationAbsorbed).length === 0,
    'Family 2 carry control: a known-zero target still bypasses the omitted repayment');
  const noCarry = carryRemainderWalk(null, p => { delete p.opening.priorAsOf; });
  const settled = carryRemainderWalk(null, p => {
    p.opening.representedEvents = [{ id: 'm-pay', date: '2027-01-31' }];
  });
  ok(noCarry.scheduledAmounts.status === 'ready' && noCarry.unabsorbed === 0
    && settled.scheduledAmounts.status === 'ready' && settled.unabsorbed === 0,
    'Family 2 carry controls: absent lookback and exactly represented monthly occurrence introduce no omitted remainder');
  const sent = carryRemainderWalk(null, p => {
    p.obligations[0].sentPayments = [{ scheduledDate: '2027-01-31',
      confirmed: true, intent: 'minimum', pending: false,
      debitId: 'synthetic-sent', postedOn: '2027-01-30', amount: 100,
      currency: 'cad', fundingAccountId: 'chequing-a', cashIncludedAsOf: U_AS_OF }];
  });
  ok(sent.scheduledAmounts.status === 'unavailable' && sent.unabsorbed === 0,
    'Family 2 carry control: a send posted after the lookback origin is rechecked at the current opening, not recorded as an omitted repayment');
}
const sameDayCharge = { id: 'b-charge', label: 'Synthetic card charge',
  confidence: 'confirmed', frequency: 'once', date: '2027-02-06',
  amount: 200, debtId: 'card-b', nonCash: true, effect: 'capitalise' };
for (const chargeFirst of [true, false]) {
  const rows = amount => chargeFirst
    ? [sameDayCharge, bRepayment(amount)] : [bRepayment(amount), sameDayCharge];
  const unknown = omittedWalk(rows(null), omittedDebts(0));
  const zero = omittedWalk(rows(0), omittedDebts(0));
  const finite = omittedWalk(rows(500), omittedDebts(0));
  ok(unknown.unabsorbed === (chargeFirst ? null : 0)
    && !('2027-02-06:pay' in unknown.obligationAbsorbed)
    && unknown.marks[0].debts.find(d => d.id === 'card-b').balance === 0,
    `Family 2 order: known charge ${chargeFirst ? 'before' : 'after'} omitted payment ${chargeFirst ? 'withholds possible remainder' : 'preserves zero-balance bypass'}`);
  ok(zero.unabsorbed === 0 && zero.byId['card-b'].balance === 200
    && finite.unabsorbed === (chargeFirst ? 300 : 0)
    && finite.byId['card-b'].balance === (chargeFirst ? 0 : 200)
    && finite.obligationAbsorbed['2027-02-06:pay'] === (chargeFirst ? 200 : 0),
    `Family 2 order controls: charge ${chargeFirst ? 'before' : 'after'} known 500 payment preserves exact arithmetic and cash cap`);
}
{
  const clear = { ...bRepayment(100), id: 'clear' };
  const unknown = omittedWalk([clear, bRepayment(null)]);
  const finite = omittedWalk([clear, bRepayment(500)]);
  ok(unknown.unabsorbed === 0 && finite.unabsorbed === 0
    && unknown.obligationAbsorbed['2027-02-06:clear'] === 100
    && finite.obligationAbsorbed['2027-02-06:pay'] === 0,
    'Family 2 order control: earlier same-day clearing preserves the independently known zero remainder and caps');
}
{
  // Both carried dates apply at opening. Original date outranks row order;
  // all positive injections apply before either carried payment.
  const plan = lookbackPlan();
  plan.obligations = [bRepayment(null, true, '2027-01-31'),
    { ...bRepayment(100, true, '2027-01-30'), id: 'earlier-clear' },
    { ...sameDayCharge, date: U_AS_OF }];
  const carried = F.projectDebts(plan, omittedDebts(), U_AS_OF,
    { extraDebtMonthly: 0, debtHorizonDays: 3 });
  ok(carried.unabsorbed === 0 && carried.obligationAbsorbed['2027-01-30:earlier-clear'] === 100,
    'Family 2 carry order control: earlier-date clearing preserves the independently known zero remainder and cap 100');
  plan.obligations = [bRepayment(null, true, '2027-01-31')];
  const drawn = F.projectDebts(plan, omittedDebts(0), U_AS_OF,
    { extraDebtMonthly: 0, debtHorizonDays: 3,
      injections: [{ date: U_AS_OF, amount: 200, debtId: 'card-b' }] });
  ok(drawn.unabsorbed === null
    && drawn.marks[0].debts.find(d => d.id === 'card-b').balance === 0,
    'Family 2 carry order: opening-date positive draw precedes carried omission; opening stock stays known zero');
}
for (const carrier of ['obligation', 'bill']) {
 for (const hasPrior of [true, false]) {
  const plan = lookbackPlan();
  if (!hasPrior) delete plan.opening.priorAsOf;
  const row = { ...bRepayment(null, true, '2027-01-31'), id: 'settled-once' };
  plan[carrier === 'obligation' ? 'obligations' : 'bills'] = [row];
  plan.opening.representedEvents = [{ id: row.id, date: row.date }];
  ok(scanU(plan).status === 'ready',
    `Family 1 represented once ${carrier} (${hasPrior ? 'with' : 'without'} priorAsOf): exact settled occurrence is excluded`);
  ok(F.scheduledAmountState(plan, U_AS_OF, '2027-02-03', { keepRepresented: true }).status === 'unavailable',
    `Family 1 represented once ${carrier} control: explicit keepRepresented preserves the unknown occurrence`);
  plan.opening.representedEvents = [{ id: row.id, date: '2027-01-30' }];
  ok(scanU(plan).status === 'unavailable',
    `Family 1 represented once ${carrier} control: a different represented date cannot settle the unknown occurrence`);
 }
}

/* --- Z. Earlier determined remainders are not retroactively qualified
 * by a later cash omission, including multiple dates carried to opening.
 * Independent proof: 150 - 100 = 50, then the named balance is zero.
 * Every later payment resolution is bypassed against that known zero. */
for (const carried of [false, true]) {
  for (const laterAmount of [null, 0, 500]) {
    const plan = carried ? lookbackPlan() : omittedPlan([]);
    const clear = { ...bRepayment(150, true, carried ? '2027-01-30' : '2027-02-06'), id: 'clear' };
    const later = bRepayment(laterAmount, true, carried ? '2027-01-31' : '2027-02-06');
    plan.obligations = carried
      ? [later, clear, { ...sameDayCharge, date: U_AS_OF }]
      : [clear, later];
    const w = F.projectDebts(plan, omittedDebts(), U_AS_OF,
      { extraDebtMonthly: 0, debtHorizonDays: 8 });
    ok(w.unabsorbed === 50 && w.obligationAbsorbed[clear.date + ':clear'] === 100,
      `Family 2 preservation: ${carried ? 'carried Jan30/Jan31' : 'same-day source order'}, later amount ${laterAmount}, earlier remainder stays exactly 50`);
    if (laterAmount === null) {
      ok(w.scheduledAmounts.status === 'unavailable' && w.byId['card-b'].balance === null
        && w.marks[0].debts.find(d => d.id === 'card-b').balance === 100,
        'Family 2 preservation: precise remainder publication does not rewrite date-based balance qualification or opening stocks');
    }
  }
}
{
  const unknownFirst = omittedWalk([bRepayment(null), { ...bRepayment(150), id: 'later' }]);
  ok(unknownFirst.unabsorbed === null,
    'Family 2 reversed-order control: an omitted payment against a live balance precedes the known payment, so aggregate remains unknown');
  const rows = amount => [bRepayment(150), { ...sameDayCharge, amount }];
  const unknown = omittedWalk(rows(null));
  const zero = omittedWalk(rows(0));
  const charge = omittedWalk(rows(200));
  const credit = omittedWalk(rows(-50));
  ok(unknown.unabsorbed === null && zero.unabsorbed === 50
    && charge.unabsorbed === 50 && credit.unabsorbed === 100,
    'Family 2 noncash sign control: a later-row unknown charge can resolve to a credit sorted before payment; aggregate must withhold');
}
{
  const rows = [bRepayment(null), sameDayCharge,
    { ...bRepayment(300, true, '2027-02-07'), id: 'later' }];
  const w = omittedWalk(rows, omittedDebts(0));
  ok(w.unabsorbed === 100 && w.obligationAbsorbed['2027-02-07:later'] === 200,
    'Family 2 zero-balance bypass: an omitted payment against zero cannot taint a later known charge and its known 100 remainder');
}
{
  const rows = amount => {
    const charge = { ...sameDayCharge, amount };
    delete charge.id;
    return [charge, bRepayment(150)];
  };
  const unknown = omittedWalk(rows(null));
  const zero = omittedWalk(rows(0));
  const charge = omittedWalk(rows(200));
  const credit = omittedWalk(rows(-50));
  ok(unknown.scheduledAmounts.unknowns.some(u => u.id === null)
    && unknown.unabsorbed === null && zero.unabsorbed === 50
    && charge.unabsorbed === 0 && credit.unabsorbed === 100,
    'Family 2 unnamed source control: null-normalized unknown identity still qualifies the noncash dependency and cannot certify remainder 50');
  const unnamedPayment = bRepayment(null);
  delete unnamedPayment.id;
  ok(omittedWalk([unnamedPayment]).unabsorbed === null,
    'Family 2 unnamed cash omission: source identity normalization does not drop an unknown live-balance repayment');
}

// ---------------------------------------------------------------------------
// ATLAS-075 (additive): a malformed bill.amountSchedule fails closed through
// this same scheduledAmountState issue/unavailable pattern. An invalid
// schedule makes that bill's in-window occurrences unknown (no regular
// fallback); an unknown term amount makes only its own occurrences unknown.
// Synthetic fixtures only. Existing ATLAS-077 checks above are unchanged (M07).
{
  const W075 = ['2027-01-01', '2027-04-30'];
  const bill075 = schedule => ({ id: 'sched', label: 'Synthetic Schedule', amount: 20, day: 10,
    frequency: 'monthly', confidence: 'confirmed', amountSchedule: schedule });
  const plan075 = bill => ({ windowDays: 91, opening: { asOf: W075[0] }, commitments: [], obligations: [],
    income: [], bills: [bill], budget: { basis: 'ytd', categories: [] } });
  const probe075 = schedule => {
    const plan = plan075(bill075(schedule));
    const state = F.scheduledAmountState(plan, ...W075);
    const events = F.expandEvents(plan, ...W075).filter(e => e.id === 'sched');
    return { state, events, dates: state.unknowns.map(u => u.date), reasons: [...new Set(state.unknowns.map(u => u.reason))] };
  };
  const ALL = ['2027-01-10', '2027-02-10', '2027-03-10', '2027-04-10'];
  const invalidAll = (r) => r.state.status === 'unavailable' && JSON.stringify(r.dates) === JSON.stringify(ALL)
    && r.reasons.length === 1 && r.reasons[0] === 'amount-schedule-invalid' && r.events.length === 0;
  const t = (from, until, amount, extra) => Object.assign({ from, until, amount }, extra || {});
  const m01 = probe075([t('2027-01-01', '2027-03-01', 5), t('2027-02-01', '2027-04-01', 6)]);
  ok(invalidAll(m01), 'M01 ATLAS-075 overlapping terms: every in-window occurrence is unknown, no regular fallback, totals withheld',
    JSON.stringify({ status: m01.state.status, dates: m01.dates, reasons: m01.reasons, events: m01.events.length }));
  const m02 = [probe075([t('2027-02-01', '2027-02-01', 5)]), probe075([t('2027-03-01', '2027-02-01', 5)])];
  ok(m02.every(invalidAll), 'M02 ATLAS-075 from >= until: schedule invalid',
    JSON.stringify(m02.map(r => [r.state.status, r.reasons])));
  const m03 = [probe075([t('2027-02-30', '2027-03-10', 5)]), probe075([t('2027/02/01', '2027-03-01', 5)]),
    probe075([t('2027-02-01', 20270301, 5)])];
  ok(m03.every(invalidAll), 'M03 ATLAS-075 non-calendar or non-ISO dates: schedule invalid',
    JSON.stringify(m03.map(r => [r.state.status, r.reasons])));
  const many = Array.from({ length: 25 }, (_, i) => t(`2030-01-${String(i + 1).padStart(2, '0')}`, `2030-01-${String(i + 2).padStart(2, '0')}`, 1));
  const m04 = [probe075({}), probe075([]), probe075(null), probe075(many),
    probe075([t('2027-02-01', '2027-03-01', 5, { note: 'x' })]), probe075(['2027-02-01'])];
  ok(m04.every(invalidAll), 'M04 ATLAS-075 non-array, empty, null, >24 terms, unknown key or non-object term: schedule invalid',
    JSON.stringify(m04.map(r => [r.state.status, r.reasons])));
  const m05 = ['1,900', NaN, true, [5], -1, null, ''].map(amount => probe075([t('2027-02-01', '2027-03-01', amount)]));
  ok(m05.every(r => r.state.status === 'unavailable' && JSON.stringify(r.dates) === JSON.stringify(['2027-02-10'])
      && r.reasons[0] === 'scheduled-amount-unknown'
      && JSON.stringify(r.events.map(e => [e.date, e.amount])) === JSON.stringify([['2027-01-10', -20], ['2027-03-10', -20], ['2027-04-10', -20]])),
    'M05 ATLAS-075 unknown or negative term amount: only that term\u2019s occurrence is unknown; no regular fallback; others known',
    JSON.stringify(m05.map(r => [r.state.status, r.dates, r.events.length])));
  const badRegular = bill075([t('2027-02-01', '2027-04-01', 5)]);
  badRegular.amount = '1,900';
  const m06plan = plan075(badRegular);
  const m06state = F.scheduledAmountState(m06plan, ...W075);
  const m06events = F.expandEvents(m06plan, ...W075).filter(e => e.id === 'sched').map(e => [e.date, e.amount]);
  ok(JSON.stringify(m06state.unknowns.map(u => u.date)) === JSON.stringify(['2027-01-10', '2027-04-10'])
    && JSON.stringify(m06events) === JSON.stringify([['2027-02-10', -5], ['2027-03-10', -5]]),
    'M06 ATLAS-075 malformed regular + valid term: in-term occurrences known, out-of-term unknown',
    JSON.stringify({ unknowns: m06state.unknowns.map(u => u.date), m06events }));
  const m08 = [null, '', 'Confirmed', 'high', 1].map(confidence => probe075([t('2027-02-01', '2027-03-01', 5, { confidence })]));
  ok(m08.every(invalidAll), 'M08 ATLAS-075 invalid term confidence (null, \'\', \'Confirmed\', \'high\', 1): schedule invalid, never promotes trust',
    JSON.stringify(m08.map(r => [r.state.status, r.reasons])));
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All ATLAS-077 malformed-amount checks passed'));
process.exit(failures === 0 ? 0 : 1);
