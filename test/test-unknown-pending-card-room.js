'use strict';
/* A card whose pending is unknown: its room and its own balance are unknown,
 * never posted + retained pending, and never its room counted as $0.
 *
 * Invented case, hand-computed here and not by the engine:
 *   card A   posted 600, retained (stale) pending 40, pending UNKNOWN, limit 1500
 *   card B   posted 200, pending 0 (known),                       limit 1000
 *   HELOC    secured, no limit in this fixture
 * Control (card A's pending known at 40): room A 1500 - 640 = 860, room B 800,
 * credit left 1660. With A unknown, A's room is unpublished, so the total is
 * unknown (before this fix it read 800: A's room counted as 0). A's own mark
 * balance is unknown (before: 640 = posted + stale pending). B is untouched.
 * A card already over its limit on posted alone has a known room of 0, so the
 * total stays known.
 *
 * `node test/test-unknown-pending-card-room.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.005;
const START = '2026-06-15';

const plan = {
  windowDays: 91, defaults: { targetBuffer: 0 }, startingCash: { amount: 2000 },
  opening: { asOf: START }, income: [], obligations: [], bills: [], commitments: [],
  budget: { basis: 'ytd', categories: [{ id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 0 }] },
};
const debts = unknown => [
  { id: 'card-a', label: 'Invented card A', balance: 600, pending: 40, rate: 19.99, rateConvention: 'card',
    structure: 'Revolving — invented', secured: false, limit: 1500, ...(unknown ? { pendingUnknown: true } : {}) },
  { id: 'card-b', label: 'Invented card B', balance: 200, pending: 0, rate: 19.99, rateConvention: 'card',
    structure: 'Revolving — invented', secured: false, limit: 1000 },
  { id: 'heloc', label: 'Invented HELOC', balance: 5000, rate: 6, secured: true },
];

// Posted and pending are bank amounts in cents. One cent posted and five
// cents pending exactly fill a six-cent limit, so the cure action is done.
for (const [limit, overLimit] of [[0.05, true], [0.06, false], [0.07, false]]) {
  const card = { id: 'boundary-card', label: 'Invented card', balance: 0.01, pending: 0.05, limit, rate: 0 };
  const extra = { id: 'boundary-line', label: 'Invented line', used: 0.01, pending: 0.05, limit };
  const actions = [card, extra].map(debt => ({ debtId: debt.id }));
  const publication = F.utilisation([card], [extra], plan);
  ok(publication.rows.every(row => row.overLimit === overLimit),
    `card and line agree with the cent-exact limit ${limit}`);
  ok(F.resolveActions({ ...plan, actions }, [card], [extra]).every(action => action.status === (overLimit ? 'open' : 'done')),
    'the limit action stays open only while the facility is over');
  const projection = F.projectDebts(plan, [card], START, { horizonDays: 1 });
  ok(projection.marks[0].overLimitCount === Number(overLimit) && projection.crossings.length === Number(overLimit),
    'the current debt timeline and crossing warning agree with the limit action');
}

console.log('=== 1. utilisation: credit left ===');
{
  const known = F.utilisation(debts(false), [], plan);
  ok(near(known.totalAvailable, 1660), 'control: known pending gives 1660 of credit left', String(known.totalAvailable));
  const unknown = F.utilisation(debts(true), [], plan);
  ok(unknown.totalAvailable === null, 'unknown pending: credit left is unknown, not 800', String(unknown.totalAvailable));
  const rowB = unknown.rows.find(r => r.id === 'card-b');
  ok(rowB && near(rowB.available, 800), 'card B keeps its own known room');
  const over = debts(true); over[0].balance = 1600;
  const overUtil = F.utilisation(over, [], plan);
  ok(near(overUtil.totalAvailable, 800), 'a card over its limit on posted alone has known room 0; the total stays known (800)',
    String(overUtil.totalAvailable));
}

console.log('\n=== 2. projectDebts marks: headroom and the card\'s own balance ===');
{
  const known = F.projectDebts(plan, debts(false), START, {});
  const k0 = known.marks[0];
  ok(near(k0.headroom, 1660) && near(k0.debts.find(d => d.id === 'card-a').balance, 640),
    'control: day-zero headroom 1660 and card A balance 640');
  const unknown = F.projectDebts(plan, debts(true), START, {});
  ok(unknown.marks.length > 1 && unknown.marks.every(m => m.headroom === null),
    'unknown pending: headroom is unknown on every mark, day zero included',
    JSON.stringify(unknown.marks.map(m => m.headroom)));
  ok(unknown.marks.every(m => m.debts.find(d => d.id === 'card-a').balance === null),
    'card A\'s own balance is unknown on every mark (not posted + retained pending)',
    JSON.stringify(unknown.marks.map(m => m.debts.find(d => d.id === 'card-a').balance)));
  ok(unknown.marks.every((m, i) => {
    const b = m.debts.find(d => d.id === 'card-b'), kb = known.marks[i].debts.find(d => d.id === 'card-b');
    return near(b.balance, kb.balance);
  }), 'card B\'s balance is unchanged on every mark');
  ok(unknown.marks.every((m, i) => near(m.secured, known.marks[i].secured)), 'secured debt is unchanged');
  ok(unknown.marks.every(m => m.consumer === null), 'consumer debt stays unknown (#951)');
  const over = debts(true); over[0].balance = 1600;
  const overProj = F.projectDebts(plan, over, START, {});
  ok(near(overProj.marks[0].headroom, 800), 'over-limit card: day-zero headroom stays known (800)',
    String(overProj.marks[0].headroom));
}

console.log('\n=== 2b. posted under the limit, posted + retained pending over it ===');
{
  // Card A posted 1480, retained pending 40, limit 1500: the walk opens at 1520
  // (over), but on posted alone the card is under its limit by an unknown
  // margin once its real pending is counted. Its room is unknown, so the
  // headroom is unknown, and it is not counted as over its limit.
  const edge = debts(true); edge[0].balance = 1480;
  const proj = F.projectDebts(plan, edge, START, {});
  ok(F.utilisation(edge, [], plan).totalAvailable === null, 'credit left is unknown');
  ok(proj.marks[0].headroom === null, 'day-zero headroom is unknown (not 800)', String(proj.marks[0].headroom));
  // Later marks: interest walks card A's posted position past its limit, which
  // is a known over-limit (room 0). Headroom is unknown exactly while card A's
  // room is unknown, and never counts an unknown room as 0.
  ok(proj.marks.every(m => {
    const a = m.debts.find(d => d.id === 'card-a');
    return a.available === null ? m.headroom === null : a.available === 0 && a.overLimit === true;
  }), 'every mark: headroom unknown while card A\'s room is unknown; known only once A is over on posted',
    JSON.stringify(proj.marks.map(m => [m.headroom, m.debts.find(d => d.id === 'card-a').available])));
  const a0 = proj.marks[0].debts.find(d => d.id === 'card-a');
  ok(a0.available === null && a0.overLimit === null && a0.balance === null,
    'card A: room, over-limit and balance unknown, never "over by 20" from the stale pending', JSON.stringify(a0));
  ok(proj.marks[0].overLimitCount === 0, 'card A is not counted as over its limit');
}

console.log('\n=== 2c. the unknown is named by card; an unknown count stays unknown ===');
{
  const util = F.utilisation(debts(true), [], plan);
  ok(JSON.stringify(util.totalAvailableUnknownFrom) === JSON.stringify(['card-a']), 'credit left names card A as the unknown');
  ok(F.utilisation(debts(false), [], plan).totalAvailableUnknownFrom === undefined, 'control: nothing is named when all room is known');
  const proj = F.projectDebts(plan, debts(true), START, {});
  ok(proj.marks.every(m => JSON.stringify(m.headroomUnknownFrom) === JSON.stringify(['card-a'])),
    'every mark names card A as the source of the unknown headroom');
  const known = F.projectDebts(plan, debts(false), START, {});
  ok(proj.marks.every((m, i) => {
    const b = m.debts.find(d => d.id === 'card-b'), kb = known.marks[i].debts.find(d => d.id === 'card-b');
    return JSON.stringify(b) === JSON.stringify(kb);
  }), 'card B\'s whole mark row (balance, room, over-limit, paid, interest) is identical to the control');
  // A scheduled payment with no amount on card B (limit 1000) leaves the
  // over-limit count unknown from its date; card A's unknown pending must not
  // turn that back into a known count.
  const taintPlan = { ...plan, obligations: [{ id: 'b-pay', label: 'Invented card B payment', debtId: 'card-b',
    effect: 'payment', frequency: 'once', date: '2026-07-01', amount: null, confidence: 'estimated' }] };
  const tainted = F.projectDebts(taintPlan, debts(true), START, {});
  const later = tainted.marks.filter(m => m.date >= '2026-07-01');
  ok(later.length > 0 && later.every(m => m.overLimitCount === null),
    'with card B\'s payment unknown, the over-limit count stays unknown on every later mark',
    JSON.stringify(tainted.marks.map(m => [m.date, m.overLimitCount])));
}

console.log('\n=== 3. publicationTotals: creditLeft ===');
{
  const data = unknown => ({ plan, debts: debts(unknown), revolvingExtra: [], income: [], assets: [], commitments: [] });
  let kn = null, un = null;
  try { kn = F.publicationTotals(data(false)); un = F.publicationTotals(data(true)); } catch (e) { /* reported below */ }
  ok(kn && near(kn.creditLeft, 1660) && un && un.creditLeft === null,
    'creditLeft is 1660 known, unknown (null) with card A pending unknown', JSON.stringify([kn && kn.creditLeft, un && un.creditLeft]));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
