'use strict';
/* Owner standing Forecast rule: a commitment with a stored YYYY-MM-DD
 * keeps that day; a single clear Mon YYYY / by Mon YYYY `when` is the
 * 15th; spans, seasons, missing years, TBD, and annual fail closed.
 *
 * Explicit owner dates win over day-15. Canonical plan rows for the
 * authorized ids are materialized; Forecast still dates future
 * when-only rows at expand time. Pages do not invent a day.
 *
 * Hand-listed dates and amounts below are the owner instruction, not
 * values read back from expandEvents.
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const HAND_MONTH = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
// Independent of Forecast.commitmentCashDate: whole-string Mon YYYY or
// by Mon YYYY → YYYY-MM-15. Anything else is not a date.
function independentMonth15(when) {
  if (typeof when !== 'string') return null;
  const match = /^(?:by\s+)?([a-z]+)\s+(\d{4})$/i.exec(when.trim());
  if (!match) return null;
  const month = HAND_MONTH[match[1].toLowerCase()];
  if (!month) return null;
  const year = Number(match[2]);
  if (!Number.isInteger(year) || year < 1000) return null;
  return `${year}-${String(month).padStart(2, '0')}-15`;
}

const OWNER_EXPLICIT = {
  'burrards-logan-team-fee-oct': { date: '2026-10-16', amount: 202.88, when: null },
  'burrards-logan-team-fee-nov': { date: '2026-11-01', amount: 202.87, when: null },
  'seattle-dec': { date: '2026-12-09', amount: 1500, when: 'Dec 2026' },
  'linden-birthday': { date: '2026-12-09', amount: 500, when: 'Dec 2026' },
  'christmas-2026': { date: '2026-12-25', amount: 3500, when: 'by Christmas 2026' },
  'provincials': { date: '2027-02-12', amount: 1500, when: 'February 12, 2027 funding-ready planning target' },
};
const OWNER_DAY15 = {
  'seattle-nov': { date: '2026-11-15', amount: 1500, when: 'Nov 2026' },
  'san-diego': { date: '2027-01-15', amount: 3000, when: 'Jan 2027' },
};
const LEFT_UNDATED = {};
const RETIRED = ['downstairs-couch', 'exterior-painting', 'vehicle-maintenance', 'indio-tournament', 'burrards-team-fees'];
// fusion-household-dec is NOT December cash: the whole Fusion season was
// owner-confirmed paid, settledOn 2026-11-02 (confirmation date, not a payment date), so the December instalment
// is settled history and emits no December occurrence.
const HAND_DEC_CASH = [
  { id: 'seattle-dec', date: '2026-12-09', amount: -1500 },
  { id: 'linden-birthday', date: '2026-12-09', amount: -500 },
  { id: 'christmas-2026', date: '2026-12-25', amount: -3500 },
];
// The Stage2 total below is planned spending from the data's asOf
// (2026-08-19), a vantage BEFORE the 2026-11-02 settlement, so the December
// Fusion instalment is still a planned commitment there. The two totals
// legitimately diverged when the season was settled.
const HAND_DEC_COMMITMENTS_OUT = 1500 + 500 + 3500 + 900;

const plan = data.plan;
const rows = plan.commitments || [];
const byId = Object.fromEntries(rows.map(r => [r.id, r]));

console.log('=== canonical rows: explicit owner dates vs day-15 vs left undated ===');
for (const [id, expected] of Object.entries(OWNER_EXPLICIT)) {
  const row = byId[id];
  ok(row && row.date === expected.date && (row.when || null) === expected.when
      && (expected.amount == null ? row.amount == null : near(row.amount, expected.amount)),
    `${id} stores owner date ${expected.date} and keeps when "${expected.when}"`,
    row ? `${row.date} amount=${row.amount}` : 'missing');
  ok(independentMonth15(row && row.when) !== expected.date
      || expected.date.endsWith('-15'),
    `${id} owner day is not the month-only 15th`);
}
ok(OWNER_EXPLICIT['seattle-dec'].date !== '2026-12-15'
    && OWNER_EXPLICIT['linden-birthday'].date !== '2026-12-15'
    && OWNER_EXPLICIT['christmas-2026'].date !== '2026-12-15',
  'hand-listed Seattle/Linden/Christmas dates are Dec 9, Dec 9, and Dec 25, not the 15th');
ok(OWNER_EXPLICIT['seattle-dec'].amount !== OWNER_EXPLICIT['linden-birthday'].amount
    && OWNER_EXPLICIT['seattle-dec'].date === OWNER_EXPLICIT['linden-birthday'].date,
  'Linden birthday shares Seattle December cash date and is a different $500 amount');
for (const [id, expected] of Object.entries(OWNER_DAY15)) {
  const row = byId[id];
  const independent = independentMonth15(expected.when);
  ok(independent === expected.date,
    `independent month-15 of "${expected.when}" is ${expected.date}`,
    String(independent));
  ok(row && row.date === expected.date && row.when === expected.when
      && (expected.amount == null
        ? row.amount == null
        : near(row.amount, expected.amount)),
    `${id} materializes ${expected.date} and keeps when "${expected.when}"`,
    row ? `${row.date} amount=${row.amount}` : 'missing');
}
for (const id of RETIRED) {
  ok(!byId[id], `${id} is not an active commitment`);
}
ok(byId['san-diego'] && byId['san-diego'].tripWindow === 'Jan 9–10, 2027'
    && byId['san-diego'].amountMin == null,
  'san-diego keeps the owner trip window and is a point amount');
ok(byId.provincials && near(byId.provincials.amount, 1500) && byId.provincials.date === '2027-02-12'
    && byId.provincials.confidence === 'confirmed' && byId.provincials.settledOn == null
    && byId.provincials.paid !== true && /planning target, not an issuer payment deadline/.test(byId.provincials.note),
  'Provincials keeps the owner planning amount and unpaid status on the approved funding-ready target');
const lindenTeam = byId['burrards-linden-team-fee'];
ok(lindenTeam && lindenTeam.date === '2026-10-20' && near(lindenTeam.amount, 340)
    && lindenTeam.confidence === 'estimated' && lindenTeam.paid !== true
    && /approval, payment instructions and invoice due date pending/i.test(lindenTeam.when),
  'owner October 20 planning date preserves the estimated amount and unknown invoice/approval');
for (const [id, when] of Object.entries(LEFT_UNDATED)) {
  const row = byId[id];
  ok(row && row.date == null && row.when === when && independentMonth15(when) == null,
    `${id} stays undated; independent parser rejects "${when}"`,
    row ? String(row.date) : 'missing');
}

console.log('\n=== Forecast.commitmentCashDate: explicit wins; when-only is day-15; fail closed ===');
ok(typeof F.commitmentCashDate === 'function',
  'commitmentCashDate is the exported Forecast cash-date helper');
ok(F.commitmentCashDate({ date: '2026-12-09', when: 'Dec 2026' }) === '2026-12-09',
  'explicit Dec 9 wins over a Dec 2026 when that would otherwise be the 15th');
ok(F.commitmentCashDate({ date: '2026-12-25', when: 'by Christmas 2026' }) === '2026-12-25',
  'explicit Dec 25 wins; by Christmas 2026 is not a month');
ok(F.commitmentCashDate({ when: 'Sep 2026' }) === independentMonth15('Sep 2026')
    && F.commitmentCashDate({ when: 'Sep 2026' }) === '2026-09-15',
  'undated Sep 2026 is independently 2026-09-15 at expand-policy time');
ok(F.commitmentCashDate({ when: 'by Jan 2027' }) === '2027-01-15',
  'by Jan 2027 is the 15th');
ok(F.commitmentCashDate({ when: 'September 2026' }) === '2026-09-15'
    && F.commitmentCashDate({ when: 'Sept 2026' }) === '2026-09-15',
  'full September and Sept both resolve to 2026-09-15');
const failClosed = [
  'Nov–Dec 2026', 'Fall 2026', 'timing TBD', 'around Feb', 'annual',
  'by Christmas 2026', 'late Sep 2026', 'early Nov 2026', 'Nov to Dec 2026',
  'Jan 7–11, 2027',
  'Jan 9–10, 2027',
];
for (const when of failClosed) {
  ok(independentMonth15(when) == null && F.commitmentCashDate({ when }) == null,
    `fail closed: "${when}" is not a cash date`);
}
ok(F.commitmentCashDate({ date: 'not-a-date', when: 'Sep 2026' }) == null,
  'garbage date does not fall through to when');
ok(F.commitmentCashDate({ date: '', when: 'Sep 2026' }) === '2026-09-15',
  'empty date still allows a clear month-only when');

console.log('\n=== expandEvents dates the occurrences (synthetic when-only + live Dec) ===');
{
  const fixture = {
    income: [],
    obligations: [],
    bills: [],
    commitments: [
      { id: 'when-only', label: 'When only', amount: 80, when: 'Sep 2026', confidence: 'estimated' },
      { id: 'explicit', label: 'Explicit', amount: 1200, date: '2026-12-09', when: 'Dec 2026', confidence: 'estimated' },
      { id: 'span', label: 'Span', amount: 1700, when: 'Nov–Dec 2026', confidence: 'estimated' },
      { id: 'range-month', label: 'Range month', amount: null, amountMin: 10, amountMax: 20, when: 'Jan 2027', confidence: 'estimated' },
    ],
  };
  const sep = F.expandEvents(fixture, '2026-09-01', '2026-09-30', {});
  const whenOnly = sep.filter(e => e.id === 'when-only');
  ok(whenOnly.length === 1 && whenOnly[0].date === '2026-09-15'
      && near(whenOnly[0].amount, -80) && whenOnly[0].kind === 'commitment',
    'expandEvents emits the when-only row on the independent 15th',
    whenOnly[0] ? `${whenOnly[0].date} ${whenOnly[0].amount}` : 'missing');
  const dec = F.expandEvents(fixture, '2026-12-01', '2026-12-31', {});
  ok(dec.some(e => e.id === 'explicit' && e.date === '2026-12-09' && near(e.amount, -1200))
      && !dec.some(e => e.id === 'explicit' && e.date === '2026-12-15'),
    'expandEvents uses explicit Dec 9, not the month-only 15th');
  ok(!F.expandEvents(fixture, '2026-11-01', '2026-12-31', {}).some(e => e.id === 'span'),
    'two-month span emits no cash event');
  ok(!F.expandEvents(fixture, '2027-01-01', '2027-01-31', {}).some(e => e.id === 'range-month'),
    'month-dated range emits no cash midpoint');
}

{
  const decEvents = F.expandEvents(plan, '2026-12-01', '2026-12-31', {})
    .filter(e => e && e.kind === 'commitment');
  const got = decEvents.map(e => `${e.id}|${e.date}|${e.amount}`).sort();
  const expected = HAND_DEC_CASH.map(e => `${e.id}|${e.date}|${e.amount}`).sort();
  ok(got.length === expected.length && got.every((row, i) => row === expected[i]),
    'Dec 2026 expandEvents commitment cash matches the hand-listed occurrences',
    got.join(' ; '));
  const seattle = decEvents.find(e => e.id === 'seattle-dec');
  const linden = decEvents.find(e => e.id === 'linden-birthday');
  const xmas = decEvents.find(e => e.id === 'christmas-2026');
  ok(seattle && seattle.date === '2026-12-09' && near(seattle.amount, -1500),
    'seattle-dec cash is −1500 on 2026-12-09');
  ok(linden && linden.date === '2026-12-09' && near(linden.amount, -500),
    'linden-birthday cash is −500 on 2026-12-09');
  ok(decEvents.filter(e => e.id === 'linden-birthday').length === 1
      && decEvents.filter(e => e.id === 'seattle-dec').length === 1,
    'December emits Linden birthday once and seattle-dec once');
  ok(xmas && xmas.date === '2026-12-25' && near(xmas.amount, -3500),
    'christmas-2026 cash is −3500 on 2026-12-25');
}

{
  // seattle-nov is NOT November cash: owner-confirmed paid, settledOn
  // 2026-11-08 (confirmation date, not a payment date), so it is settled
  // history and emits no occurrence on its 15th. Settlement is
  // opening-relative, so this is read from a window opening on the 15th.
  const seattleNov = F.expandEvents(plan, '2026-11-15', '2026-11-30', {})
    .filter(e => e.id === 'seattle-nov');
  ok(plan.commitments.find(c => c.id === 'seattle-nov').settledOn === '2026-11-08'
      && seattleNov.length === 0,
    'settled seattle-nov emits no November cash',
    seattleNov.map(e => `${e.date} ${e.amount}`).join(','));
  const day15Cash = [
    { id: 'san-diego', date: '2027-01-15', amount: -3000 },
  ];
  for (const hand of day15Cash) {
    const hit = F.expandEvents(plan, hand.date, hand.date, {})
      .find(e => e.id === hand.id);
    ok(hit && hit.date === hand.date && near(hit.amount, hand.amount)
        && hit.kind === 'commitment',
      `${hand.id} emits on the hand-listed 15th`,
      hit ? `${hit.date} ${hit.amount}` : 'missing');
  }
  const january = F.expandEvents(plan, '2027-01-01', '2027-01-31', {});
  const sanDiego = january.filter(e => e.id === 'san-diego');
  ok(sanDiego.length === 1 && sanDiego[0].date === '2027-01-15' && near(sanDiego[0].amount, -3000),
    'san-diego emits once on the clear-month 15th',
    sanDiego.map(e => `${e.date} ${e.amount}`).join(','));
  ok(!january.some(e => e.id === 'indio-tournament'),
    'indio-tournament emits no January cash event');
  ok(!january.some(e => e.id === 'san-diego' && e.date !== '2027-01-15'),
    'san-diego does not also emit on a trip-window day');
}

console.log('\n=== December Stage2 planned-spending includes the hand-listed commitments ===');
{
  const periods = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/periods.json'), 'utf8'));
  const asOf = data.meta.asOf;
  const traj = F.baselineTrajectory(plan, data.debts, asOf, { periods });
  const dec = (traj.months || []).find(m => m.month === '2026-12');
  ok(traj.status === 'ready' && dec && dec.stage2 && dec.stage2.commitments,
    'December 2026 Stage2 is published');
  ok(near(dec.stage2.commitments.amount, HAND_DEC_COMMITMENTS_OUT),
    'December Stage2 commitments equal the hand total $6,400 planned from the 2026-08-19 asOf',
    dec && dec.stage2 && String(dec.stage2.commitments.amount));
  const independentStage2 = (dec.stage1.result.amount || 0) - HAND_DEC_COMMITMENTS_OUT;
  ok(near(dec.stage2.result.amount, independentStage2)
      && near(dec.stage2.result.amount,
        dec.stage1.result.amount - dec.stage2.commitments.amount),
    'December Stage2 result is Stage1 minus the independent Dec commitment total',
    dec.stage2.result && String(dec.stage2.result.amount));
}

console.log('\n=== pages still do not parse month-only when into a day ===');
{
  const planning = fs.readFileSync(path.join(__dirname, '..', 'public/planning.js'), 'utf8');
  const spend = fs.readFileSync(path.join(__dirname, '..', 'public/plan-spend.js'), 'utf8');
  const planPage = fs.readFileSync(path.join(__dirname, '..', 'public/plan.js'), 'utf8');
  ok(!/commitmentCashDate|commitmentMonthDay15FromWhen/.test(planning + spend + planPage),
    'Plan / Forecast / Plan spend pages do not implement the cash-date parser');
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nCommitment month-day-15 checks passed.');
