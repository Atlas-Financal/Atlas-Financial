'use strict';
/* Known major future costs live on plan.commitments (or the property-tax
 * reserve), once each, and are not Deep Dive prose. Undated rows do not
 * become cash events and are not smeared across the 91-day sinking line.
 * They do encumber protected principal on the B94 master walk.
 *
 * Deliberate current-input reconciliation: amounts below are the owner
 * instructions, including the approved Oct 1 team-fee replacement, written
 * independently of the rows they prove. Engine behaviour uses synthetic data
 * in test-burrards-team-fee-inputs.js.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const plan = data.plan;
const asOf = data.meta.asOf;
const windowEnd = F.addDays(asOf, (plan.windowDays || 91) - 1);
const rows = plan.commitments || [];
const byId = Object.fromEntries(rows.map(r => [r.id, r]));

const NEW_IDS = [
  'burrards-logan-team-fee-oct',
  'burrards-logan-team-fee-nov',
  'burrards-linden-team-fee',
  'seattle-nov',
  'seattle-dec',
  'linden-birthday',
  'christmas-2026',
  'san-diego',
];
const RETIRED_IDS = [
  'burrards-team-fees',
  'downstairs-couch',
  'exterior-painting',
  'vehicle-maintenance',
  'indio-tournament',
  // Retired by owner decision (Dale, 2026-11-11).
  'provincials',
];
const POINT = {
  'burrards-logan-team-fee-oct': 202.88,
  'burrards-logan-team-fee-nov': 202.87,
  'burrards-linden-team-fee': 340,
  'seattle-nov': 1500,
  'seattle-dec': 1500,
  'linden-birthday': 500,
  'christmas-2026': 3500,
  'san-diego': 3000,
};
const OWNER_EXPLICIT_DATES = {
  'burrards-logan-team-fee-oct': '2026-10-16',
  'burrards-logan-team-fee-nov': '2026-11-01',
  'burrards-linden-team-fee': '2026-10-20',
  'seattle-dec': '2026-12-09',
  'linden-birthday': '2026-12-09',
  'christmas-2026': '2026-12-25',
};
const OWNER_DAY15_DATES = {
  'seattle-nov': '2026-11-15',
  'san-diego': '2027-01-15',
};
const STILL_UNDATED = [];
const RANGES = {};
const FLEXIBLE = [];
const PREEXISTING = ['burrard1', 'burrard2', 'fusioncamp', 'tryouts', 'warriors'];

console.log('=== each known major cost has one plan home ===');
for (const id of NEW_IDS.concat(['warriors'])) {
  const hits = rows.filter(r => r.id === id);
  ok(hits.length === 1, `exactly one plan.commitments row ${id}`);
}
ok(!(plan.bills || []).some(b => NEW_IDS.includes(b.id)),
  'none of the new costs is also a dated bill');
ok(!(plan.commitments || []).some(c => c.id === 'home-insurance'),
  'Square One is not a second plan.commitments home-insurance row');
ok((plan.bills || []).some(b => b.id === 'square-one'),
  'Square One lives on plan.bills, not as an undated commitment');
ok(!rows.some(r => r.id === 'property-tax' || r.id === 'propertytax'),
  'property tax is not a second plan.commitments row');
const property = (plan.budget.categories || []).find(c => c.id === 'propertytax');
ok(property && property.class === 'reserve' && property.plannedMonthly == null
  && near(property.plannedAmount, 6000) && property.planningDate === '2027-07-01'
  && property.confidence === 'estimated'
  && /5,639\.67|5639\.67/.test(property.why)
  && /2027-07-01/.test(property.why)
  && !/\$5,600–\$6,000\/year/.test(property.why),
  'property tax stays the reserve, with exact $6,000 on 2027-07-01 and the Jul 2026 actual');

console.log('\n=== owner estimates are on the rows, not invented midpoints ===');
const OWNER_CONFIRMED = new Set(['seattle-nov', 'seattle-dec', 'linden-birthday', 'san-diego',
  'burrards-logan-team-fee-oct', 'burrards-logan-team-fee-nov']);
for (const [id, amount] of Object.entries(POINT)) {
  const row = byId[id];
  const confidence = OWNER_CONFIRMED.has(id) ? 'confirmed' : 'estimated';
  ok(row && near(row.amount, amount) && row.confidence === confidence,
    `${id} is the owner ${confidence} amount $${amount}`,
    row ? `${row.amount} ${row.confidence}` : 'missing');
}
for (const [id, date] of Object.entries(OWNER_EXPLICIT_DATES)) {
  ok(byId[id] && byId[id].date === date,
    `${id} keeps the owner-assigned cash date ${date}`,
    byId[id] ? String(byId[id].date) : 'missing');
}
for (const [id, date] of Object.entries(OWNER_DAY15_DATES)) {
  ok(byId[id] && byId[id].date === date,
    `${id} materializes the owner month-only 15th as ${date}`,
    byId[id] ? String(byId[id].date) : 'missing');
}
for (const id of STILL_UNDATED) {
  ok(byId[id] && byId[id].date == null, `${id} stays undated — month/year not clear`);
}
for (const [id, [lo, hi]] of Object.entries(RANGES)) {
  const row = byId[id];
  ok(row && row.amount == null && near(row.amountMin, lo) && near(row.amountMax, hi),
    `${id} keeps the range $${lo}–$${hi} and invents no midpoint`);
}
for (const id of RETIRED_IDS) {
  ok(!byId[id], `${id} is retired from active plan.commitments`);
}
ok(byId['san-diego'] && byId['san-diego'].tripWindow === 'Jan 9–10, 2027'
    && byId['san-diego'].amountMin == null,
  'san-diego is a $3,000 point with the owner trip window and no range');
for (const id of FLEXIBLE) {
  ok(byId[id] && byId[id].adjustable === true, `${id} is marked flexible`);
}
ok(byId.warriors && byId.warriors.date === '2026-09-23'
  && near(byId.warriors.amount, 895) && byId.warriors.amountMin == null
  && byId.warriors.settledOn === '2026-09-21',
  'Warriors is Logan U13 due 23 Sep at exact $895, settled 21 Sep');
ok(byId['fusion-household-paid'] && near(byId['fusion-household-paid'].amount, 1200)
  && byId['fusion-household-paid'].settledOn === '2026-09-10',
  'Fusion paid is settled on 2026-09-10 Interac evidence date');
ok(!byId['fusion-season'], 'fusion-season stale estimate is removed');

console.log('\n=== not merely prose ===');
ok(data.commitments.items == null && data.commitments.schedule == null,
  'data.commitments.items is gone — not a second list');
const pub = F.publicationTotals(data);
ok(Array.isArray(pub.commitmentItems)
  && NEW_IDS.every(id => pub.commitmentItems.some(i => i.id === id)),
  'Forecast.publicationTotals lists every absorbed cost from plan.commitments');
ok(!PREEXISTING.every(id => (data.commitments.note || '').includes(id)),
  'the Deep Dive note is chrome, not the row authority');

console.log('\n=== unclear-month rows do not become 91-day cash ===');
const events = F.expandEvents(plan, asOf, windowEnd, {});
const unclearCash = events.filter(e => STILL_UNDATED.includes(e.id));
ok(unclearCash.length === 0,
  'expandEvents emits no cash event for a still-undated absorbed cost',
  unclearCash.map(e => e.id).join(',') || 'none');
for (const [id, date, amount] of [
  ['burrards-logan-team-fee-oct', '2026-10-16', 202.88],
  ['burrards-logan-team-fee-nov', '2026-11-01', 202.87],
  ['burrards-linden-team-fee', '2026-10-20', 340],
]) {
  const hits = events.filter(e => e.id === id);
  ok(hits.length === 1 && hits[0].date === date && near(hits[0].amount, -amount),
    `91-day expandEvents includes ${id} once on the notice date`);
}
ok(events.some(e => e.id === 'seattle-nov' && e.date === '2026-11-15'
    && near(e.amount, -1500)),
  '91-day expandEvents includes Seattle November on the owner 15th');
ok(events.some(e => e.id === 'warriors' && e.date === '2026-09-23'
    && near(e.amount, -895)),
  '91-day expandEvents reserves Warriors once at -$895 because settledOn is after this opening');
const seq = F.fundingSequence(plan, asOf, {});
ok(seq.some(c => c.id === 'warriors' && c.date === '2026-09-23' && near(c.need, 895)
    && c.amountMin == null),
  'Warriors stays a $895 point in fundingSequence on the 19 Aug opening');
const later = F.expandEvents(plan, asOf, '2027-12-31', {});
ok(!later.some(e => STILL_UNDATED.includes(e.id)),
  'a longer expander walk still invents no day for unclear-month rows');
ok(later.some(e => e.id === 'seattle-dec' && e.date === '2026-12-09'
    && near(e.amount, -1500)),
  'longer walk includes seattle-dec on the owner Dec 9 date');
ok(later.filter(e => e.id === 'linden-birthday').length === 1
    && later.some(e => e.id === 'linden-birthday' && e.date === '2026-12-09'
      && near(e.amount, -500)),
  'longer walk includes linden-birthday once on 2026-12-09 at −500');
ok(later.filter(e => e.id === 'seattle-dec').length === 1,
  'seattle-dec still emits once beside Linden on the longer walk');
ok(later.some(e => e.id === 'christmas-2026' && e.date === '2026-12-25'
    && near(e.amount, -3500)),
  'longer walk includes christmas-2026 on the owner Dec 25 date');
ok(!later.some(e => RETIRED_IDS.includes(e.id)),
  'retired commitments emit no cash event on the longer walk');
ok(later.filter(e => e.id === 'san-diego').length === 1
    && later.some(e => e.id === 'san-diego' && e.date === '2027-01-15' && near(e.amount, -3000)),
  'san-diego emits exactly once, on 2027-01-15, at −3000');

console.log('\n=== the approved target replaces the last undated principal hold ===');
const recOpts = {
  scenario: 'expected', incomeOverrides: {}, disabled: [], extraDebtMonthly: 0,
  targetBuffer: plan.defaults.targetBuffer,
};
const withNew = F.recommend(plan, asOf, recOpts);
const withoutNew = F.recommend(plan, asOf, Object.assign({}, recOpts, { disabled: NEW_IDS }));
ok(withNew.knowledge.encumbered === 0 && withoutNew.knowledge.encumbered === 0,
  'all current point costs are dated; no undated principal hold remains',
  `$${withNew.knowledge.encumbered} vs $${withoutNew.knowledge.encumbered}`);
ok(withNew.weekly <= withoutNew.weekly,
  'encumbering those rows cannot raise today\'s cap',
  `$${withNew.weekly} vs $${withoutNew.weekly}`);
const budget = F.budgetBreakdown(plan, require('../public/periods.json'), {
  paypalPerMonth: data.paypal ? data.paypal.perMonth : 0,
  asOf,
});
ok(!(budget.sinkingItems || []).some(s =>
  /Downstairs couch|Exterior painting|Home insurance|Vehicle maintenance/.test(s.label)),
  'retired or separately housed costs are not smeared into sinkingMonthly');
ok(!(budget.sinkingItems || []).some(s => s.label === 'Provincials'),
  'retired Provincials is not in the sinking breakdown');
const fusionSinking = (budget.sinkingItems || []).filter(s => /Fusion season — household/.test(s.label));
ok(fusionSinking.length >= 3,
  'dated Fusion household rows within the window may appear in sinkingMonthly',
  String(fusionSinking.length));

console.log('\n=== published point-estimate total is independently summed ===');
const fusionHouseholdUnsettled = ['fusion-household-paid', 'fusion-household-oct',
  'fusion-household-nov', 'fusion-household-dec']
  .map(id => byId[id])
  .filter(c => c && c.amount != null && !F.commitmentSettledBy(c, asOf))
  .reduce((s, c) => s + c.amount, 0);
ok(near(fusionHouseholdUnsettled, 4500),
  'at Aug. 19 opening, paid row is not yet settledOn-relative — Fusion sums to $4,500',
  String(fusionHouseholdUnsettled));
const pubSep11 = F.publicationTotals(Object.assign({}, data, {
  meta: Object.assign({}, data.meta, { asOf: '2026-09-11' }),
}));
const fusionAfterSettled = (pubSep11.commitmentItems || [])
  .filter(i => /^fusion-household-/.test(i.id))
  .reduce((s, i) => s + (i.amount || 0), 0);
ok(near(fusionAfterSettled, 3300),
  'after settledOn, publication encumbers remaining Fusion instalments only',
  String(fusionAfterSettled));
const fusionRemainingOnly = ['fusion-household-oct', 'fusion-household-nov', 'fusion-household-dec']
  .reduce((s, id) => s + (byId[id] ? byId[id].amount : 0), 0);
ok(near(fusionRemainingOnly, 3300),
  'remaining instalments alone are $3,300, independent of owner-stated paid row',
  String(fusionRemainingOnly));
const preexistingPoints = 895;
const absorbedPoints = 202.88 + 202.87 + 340 + 1500 + 1500 + 500 + 3500 + 3000;
const HAND_TOTAL = preexistingPoints + absorbedPoints + fusionHouseholdUnsettled;
ok(near(absorbedPoints, 10745.75) && near(HAND_TOTAL, 16140.75),
  'hand total at Aug. 19 opening includes Warriors $895 plus paid + remaining Fusion until each settledOn');
ok(near(pub.commitmentsTotal, HAND_TOTAL),
  'publicationTotals matches that independent sum',
  String(pub.commitmentsTotal));
ok(RETIRED_IDS.every(id => !pub.commitmentItems.some(i => i.id === id)),
  'retired commitments contribute nothing to publicationTotals');
ok(!pub.commitmentItems.some(i => i.amountMin != null && i.amount == null
    && RETIRED_IDS.includes(i.id)),
  'no retired range is published as a live commitment');

console.log('\n=== ON TRACK / AT RISK / FUNDING GAP is not invented here ===');
ok(!NEW_IDS.some(id => /ON TRACK|AT RISK|FUNDING GAP/.test(JSON.stringify(byId[id]))),
  'no absorbed row carries a B94 verdict');
ok(!/ON TRACK|AT RISK|FUNDING GAP/.test(JSON.stringify(pub.commitmentItems)),
  'publicationTotals does not publish those verdicts');

function independentlySettled(c) {
  return typeof c.settledOn === 'string'
    && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(c.settledOn);
}

ok(independentlySettled(byId.burrard1)
  && independentlySettled(byId.burrard2)
  && independentlySettled(byId.fusioncamp)
  && independentlySettled(byId.tryouts),
  'the four Aug-settled rows are still settled on plan inputs');

console.log('\n=== 2027 property tax is one reserve planning lump ===');
{
  const PLAN_DATE = '2027-07-01';
  const PLAN_AMOUNT = 6000;
  const HISTORICAL = 5639.67;
  function utcAdd(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }
  function periodContaining(anchor, date) {
    let payday = anchor;
    while (utcAdd(payday, 14) <= date) payday = utcAdd(payday, 14);
    while (payday > date) payday = utcAdd(payday, -14);
    const cycleEnd = utcAdd(payday, 13);
    return { payday, cycleEnd };
  }
  ok(!rows.some(r => /property/i.test(`${r.id} ${r.label}`)),
    'no plan.commitments row is property tax');
  const facts = fs.readFileSync(path.join(__dirname, '..', 'docs/ACCOUNT_FACTS.md'), 'utf8');
  ok(/2 Jul 2026/.test(facts) && /\$5,639\.67/.test(facts),
    'ACCOUNT_FACTS still records the 2 Jul 2026 historical $5,639.67');
  const events = F.expandEvents(plan, asOf, '2027-08-18', {})
    .filter(e => e.id === 'propertytax' || /property tax/i.test(e.label || ''));
  ok(events.length === 1 && events[0].date === PLAN_DATE && near(events[0].amount, -PLAN_AMOUNT)
      && events[0].kind === 'reserve' && events[0].planningLump === true,
    'expandEvents emits one reserve planning lump of −$6,000 on 2027-07-01',
    events.map(e => `${e.kind} ${e.date} ${e.amount}`).join(', ') || 'none');
  ok(!events.some(e => near(Math.abs(e.amount), HISTORICAL)),
    'the Jul 2026 historical amount is not a future cash event');
  const plans = F.majorPlans(plan, asOf, {});
  const cards = F.planSpendCards(plans).filter(c =>
    c.id === 'propertytax' || /property tax/i.test(c.label || ''));
  ok(cards.length === 1 && cards[0].kind === 'row' && cards[0].date === PLAN_DATE
      && near(cards[0].need, PLAN_AMOUNT),
    'Plan Spend reprints one property-tax card at $6,000 on 2027-07-01',
    cards[0] ? `${cards[0].kind} ${cards[0].date} ${cards[0].need}` : 'missing');
  const traj = F.baselineTrajectory(plan, data.debts, asOf, {
    periods: require('../public/periods.json'),
  });
  const july = (traj.months || []).find(m => m.month === '2027-07');
  const julyLines = ((july && july.stage2 && july.stage2.commitments && july.stage2.commitments.lines) || [])
    .filter(l => l.id === 'propertytax');
  ok(julyLines.length === 1 && julyLines[0].date === PLAN_DATE && near(julyLines[0].amount, PLAN_AMOUNT),
    'July 2027 Road Ahead Month counts $6,000 once',
    julyLines[0] ? `${julyLines[0].date} ${julyLines[0].amount}` : 'missing');
  ok(!(traj.months || []).some(m => m.month !== '2027-07'
      && ((m.stage2 && m.stage2.commitments && m.stage2.commitments.lines) || [])
        .some(l => l.id === 'propertytax')),
    'no other Road Ahead month lists property tax');
  const anchor = (plan.income || []).find(r => r.id === 'payroll').anchor;
  const wanted = periodContaining(anchor, PLAN_DATE);
  const payHits = (traj.payPeriods || []).filter(p =>
    ((p.stage2 && p.stage2.commitments && p.stage2.commitments.lines) || [])
      .some(l => l.id === 'propertytax'));
  ok(payHits.length === 1 && wanted && payHits[0].start <= PLAN_DATE && PLAN_DATE <= payHits[0].end
      && payHits[0].payday === wanted.payday,
    'the pay period containing 2027-07-01 counts property tax once',
    payHits[0] ? `${payHits[0].payday} ${payHits[0].start}–${payHits[0].end}` : 'missing');
  const payLine = ((payHits[0] && payHits[0].stage2.commitments.lines) || [])
    .filter(l => l.id === 'propertytax');
  ok(payLine.length === 1 && near(payLine[0].amount, PLAN_AMOUNT),
    'that pay period lists $6,000 once');
  const without = JSON.parse(JSON.stringify(plan));
  const cat = without.budget.categories.find(c => c.id === 'propertytax');
  cat.plannedAmount = null;
  cat.planningDate = null;
  const trajWithout = F.baselineTrajectory(without, data.debts, asOf, {
    periods: require('../public/periods.json'),
  });
  const julyWithout = (trajWithout.months || []).find(m => m.month === '2027-07');
  ok(julyWithout && near(july.stage2.commitments.amount - julyWithout.stage2.commitments.amount, PLAN_AMOUNT)
      && near(julyWithout.stage2.result.amount - july.stage2.result.amount, PLAN_AMOUNT),
    'removing the reserve lump moves July stage2 by $6,000 once');
  const budget = F.budgetBreakdown(plan, require('../public/periods.json'), { asOf });
  const taxRow = (budget.categories || []).find(c => c.id === 'propertytax');
  ok(taxRow && taxRow.class === 'reserve' && !(taxRow.planned > 0),
    'the $6,000 lump is not smeared into the weekly-cap planned amount');
}
ok(byId['fusion-household-paid'] && byId['fusion-household-paid'].settledOn === '2026-09-10',
  'Fusion paid row settledOn matches Interac evidence date');

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll major-future-cost checks passed.');
