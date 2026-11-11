'use strict';

// AF-REFRESH-01 — retire the cancelled CMAW recurrence.
// Independent of Forecast.monthlyDates / recommend: calendar 15ths are
// enumerated here; historical actuals are read from periods.json and from
// the pre-change main snapshot; settlement traces to posting-observations,
// not to the recurrence edit.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Forecast = require('../public/forecast.js');
const icsMod = require('../scripts/calendar-ics.js');

const ROOT = path.join(__dirname, '..');
const BEFORE_SHA = '14296286cde64ab35cf577d5055766a67b56fc12';
const DATA_PATH = path.join(ROOT, 'data.json');
const PERIODS_PATH = path.join(ROOT, 'public/periods.json');
const POSTING_PATH = path.join(ROOT, 'docs/reconciliation/posting-observations.json');
const FACTS_PATH = path.join(ROOT, 'docs/ACCOUNT_FACTS.md');
const REFRESH_JS = path.join(ROOT, 'scripts/canonical-refresh.js');
const LIVE_JS = path.join(ROOT, 'scripts/live-plan.js');

let failures = 0;
function ok(condition, label, detail) {
  if (condition) {
    console.log('\x1b[32m✓\x1b[0m ' + label);
    return;
  }
  failures += 1;
  console.log('\x1b[31m✗\x1b[0m ' + label + (detail ? ' — ' + detail : ''));
}
function near(actual, expected) {
  return Math.abs(Number(actual) - Number(expected)) < 0.005;
}
function load(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function gitShow(shaPath) {
  return JSON.parse(execFileSync('git', ['show', shaPath], {
    cwd: ROOT, encoding: 'utf8',
  }));
}
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function pad(n) { return String(n).padStart(2, '0'); }
function monthlyFifteenths(startIso, endIso) {
  const out = [];
  let [year, month] = startIso.split('-').map(Number);
  for (;;) {
    const iso = year + '-' + pad(month) + '-' + pad(Math.min(15, daysInMonth(year, month)));
    if (iso > endIso) break;
    if (iso >= startIso) out.push(iso);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return out;
}

const data = load(DATA_PATH);
const before = gitShow(BEFORE_SHA + ':data.json');
const periods = load(PERIODS_PATH);
const beforePeriods = gitShow(BEFORE_SHA + ':public/periods.json');
const posting = load(POSTING_PATH);
const facts = fs.readFileSync(FACTS_PATH, 'utf8');
const plan = data.plan;
const asOf = data.meta.asOf;
const outstandingId = 'uniondues-aug15-outstanding';

console.log('=== cancellation authority is the recorded owner statement ===');
ok(/owner-confirmed 2026-08-24/i.test(facts)
    && /recurring \$25\/month payment cancelled/i.test(facts)
    && /stop tracking/i.test(facts),
  'ACCOUNT_FACTS records owner-confirmed cancellation and the 2026-08-30 stop-tracking instruction');
ok(!(plan.bills || []).some(bill => bill.id === 'uniondues' || bill.id === outstandingId
    || /cmaw/i.test(bill.label || '')),
  'canonical plan no longer carries a monthly uniondues bill or an August posting-unknown stub');
const outstanding = (plan.bills || []).find(bill => bill.id === outstandingId);
ok(!outstanding, 'the 15 August posting-unknown once row is gone');
const cancel = (plan.actions || []).find(action => /CMAW Local 1995/i.test(action.what));
ok(cancel && cancel.status === 'done',
  'the cancel-dues action is done rather than left open');

console.log('\n=== independently enumerated 15ths are not future CMAW obligations ===');
const unauthorizedFifteenths = monthlyFifteenths('2026-09-15', '2027-08-15');
ok(unauthorizedFifteenths.length === 12
    && unauthorizedFifteenths[0] === '2026-09-15'
    && unauthorizedFifteenths[11] === '2027-08-15',
  'independent calendar lists twelve 15ths from September 2026 through August 2027',
  unauthorizedFifteenths.join(','));
ok(near(unauthorizedFifteenths.length * 25, 300),
  'independent unauthorized recurrence total is 12 × $25 = $300');
const horizonEvents = Forecast.expandEvents(plan, asOf, '2027-08-15', {});
const cmawEvents = horizonEvents.filter(event => event.id === 'uniondues'
  || event.id === outstandingId
  || /cmaw|union dues/i.test(event.label || ''));
ok(!cmawEvents.some(event => event.id === 'uniondues'),
  'Forecast expansion emits no monthly uniondues events',
  cmawEvents.map(event => event.id + '@' + event.date).join(','));
ok(!unauthorizedFifteenths.some(iso => cmawEvents.some(event => event.date === iso
      && near(-event.amount, 25))),
  'none of the independently listed 15ths is a $25 CMAW cash event');
ok(cmawEvents.length === 0,
  'Forecast emits no CMAW cash event, including August');
const ics = icsMod.buildHouseholdCalendar(plan, asOf, icsMod.ICS_HORIZON_END);
ok(!(ics.payments || []).some(payment => payment.sourceId === 'uniondues'),
  'ICS payment VEVENTs do not expand a monthly CMAW recurrence');

console.log('\n=== historical Union dues actuals are unchanged ===');
function unionTotal(source, bucket) {
  return ((source.periods[bucket] || {}).spending || [])
    .find(row => row.label === 'Union dues');
}
const beforeUnion = {
  thisMonth: unionTotal(beforePeriods, 'thisMonth'),
  lastMonth: unionTotal(beforePeriods, 'lastMonth'),
  ytd: unionTotal(beforePeriods, 'ytd'),
  all: unionTotal(beforePeriods, 'all'),
};
const afterUnion = {
  thisMonth: unionTotal(periods, 'thisMonth'),
  lastMonth: unionTotal(periods, 'lastMonth'),
  ytd: unionTotal(periods, 'ytd'),
  all: unionTotal(periods, 'all'),
};
ok(near(beforeUnion.thisMonth.total, 25) && near(afterUnion.thisMonth.total, 25)
    && near(beforeUnion.lastMonth.total, 25) && near(afterUnion.lastMonth.total, 25)
    && near(beforeUnion.ytd.total, 200) && near(afterUnion.ytd.total, 200)
    && near(beforeUnion.all.total, 475) && near(afterUnion.all.total, 475),
  'periods.json Union dues thisMonth $25 / lastMonth $25 / YTD $200 / all $475 are unchanged');
ok(JSON.stringify(beforePeriods.periods.thisMonth.spending.find(s => s.label === 'Union dues'))
    === JSON.stringify(afterUnion.thisMonth),
  'August historical Union dues row is byte-identical to pre-change main');
ok(JSON.stringify(beforePeriods) === JSON.stringify(periods),
  'the historical actuals file as a whole is unchanged');

console.log('\n=== current-cycle settlement traces to posting evidence, not cancellation ===');
const postingRow = (posting.observations || [])
  .find(row => row.observationId === 'payday-uniondues-posting-unknown');
ok(postingRow && postingRow.unknown === true && postingRow.posted !== true
    && postingRow.scheduledDate === '2026-08-15',
  'incumbent posting observation still records 15 August CMAW as unknown');
ok(!/Reserved on the live plan as uniondues-aug15-outstanding/i.test(postingRow.note || ''),
  'the historical observation no longer claims a live Forecast CMAW stub');
ok(!(plan.opening.representedEvents || [])
    .some(row => row.id === 'uniondues' || row.id === outstandingId),
  'representedEvents still does not claim the August occurrence posted');
ok(!outstanding,
  'there is no once-row note because the cancelled dues are not tracked');
ok(near(afterUnion.thisMonth.total, 25) && postingRow.unknown === true,
  'August historical $25 actuals exist and do not restore a Forecast CMAW row');

console.log('\n=== no unrelated obligation or household policy changed ===');
function billKey(bill) {
  return JSON.stringify({
    id: bill.id,
    label: bill.label,
    frequency: bill.frequency,
    day: bill.day,
    amount: bill.amount,
    date: bill.date,
    firstDue: bill.firstDue,
    anchor: bill.anchor,
    confidence: bill.confidence,
    budgetCategory: bill.budgetCategory,
    householdObligation: bill.householdObligation,
  });
}
const beforeOther = (before.plan.bills || [])
  .filter(bill => bill.id !== 'uniondues' && bill.id !== outstandingId)
  .map(billKey);
const afterById = new Map((plan.bills || [])
  .filter(bill => bill.id !== outstandingId)
  .map(bill => [bill.id, billKey(bill)]));
ok(beforeOther.every(key => {
  const parsed = JSON.parse(key);
  if (parsed.id === 'fortis') {
    // Authorized later: retained Fortis placeholders stay 124/monthly/day 3,
    // but publish estimated trust after the annual-review evidence.
    parsed.confidence = 'estimated';
    return afterById.get('fortis') === JSON.stringify(parsed);
  }
  return afterById.get(parsed.id) === key;
}),
  'every pre-existing non-CMAW bill identity/amount/cadence is unchanged');
function obligationKey(row) {
  return JSON.stringify({
    id: row.id,
    label: row.label,
    frequency: row.frequency,
    day: row.day,
    amount: row.amount,
    date: row.date,
    firstDue: row.firstDue,
    anchor: row.anchor,
    confidence: row.confidence,
    debtId: row.debtId,
    effect: row.effect,
    nonCash: row.nonCash,
  });
}
ok(JSON.stringify((before.plan.obligations || []).map(obligationKey))
    === JSON.stringify((plan.obligations || []).map(obligationKey)),
  'plan.obligations identity, amount and cadence are unchanged');
const OWNER_SETTLED_COMMITMENT_IDS = new Set(['seattle-nov']);
function commitmentKey(row) {
  const copy = Object.assign({}, row);
  if (copy.id === 'home-insurance' || copy.id === 'tryouts') delete copy.note;
  // Owner month-only / explicit cash dates and the notes that record them
  // are this dating outcome, not a CMAW side-effect. Identity and amounts
  // still have to match.
  if (OWNER_DATED_COMMITMENT_IDS.has(copy.id)) {
    delete copy.date;
    delete copy.note;
    // Provincials' owner-approved funding-ready description changed with its date.
    if (copy.id === 'provincials') delete copy.when;
  }
  // Owner-confirmed settlement (Dale, 2026-11-08) adds settledOn and a note
  // sentence; that is not a CMAW side-effect. Identity and amounts still match.
  if (OWNER_SETTLED_COMMITMENT_IDS.has(copy.id)) {
    delete copy.settledOn;
    delete copy.note;
  }
  if (OWNER_2026_09_23_AMOUNT.has(copy.id)) {
    delete copy.amount;
    delete copy.confidence;
    delete copy.label;
    delete copy.note;
  }
  return JSON.stringify(copy);
}
// Oct 1 team-fee replacement has its own exact-input/synthetic regression;
// that authorized replacement is not a union-dues side effect.
const SUPERSEDED_COMMITMENT_IDS = new Set(['fusion-season', 'warriors', 'home-insurance', 'burrards-team-fees']);
const OWNER_2026_09_23_RETIRED = new Set([
  'downstairs-couch',
  'exterior-painting',
  'vehicle-maintenance',
  'indio-tournament',
]);
const OWNER_2026_09_23_AMOUNT = new Set(['seattle-nov', 'seattle-dec', 'provincials']);
const OWNER_DATED_COMMITMENT_IDS = new Set([
  'burrards-team-fees',
  'seattle-nov',
  'seattle-dec',
  'provincials',
  'christmas-2026',
  'indio-tournament',
]);
// Retired by owner decision (Dale, 2026-11-11): a separate owner outcome,
// not a union-dues side effect.
const OWNER_2026_11_11_RETIRED = new Set(['provincials']);
ok(Array.from(OWNER_2026_11_11_RETIRED).every(id =>
  !(plan.commitments || []).some(row => row.id === id)),
  '2026-11-11 retired commitments are absent from the live plan');
ok(Array.from(OWNER_2026_09_23_RETIRED).every(id =>
  !(plan.commitments || []).some(row => row.id === id)),
  '2026-09-23 retired commitments are absent from the live plan');
ok((before.plan.commitments || [])
  .filter(row => !SUPERSEDED_COMMITMENT_IDS.has(row.id)
    && !OWNER_2026_09_23_RETIRED.has(row.id)
    && !OWNER_2026_11_11_RETIRED.has(row.id))
  .every((row) => {
    const afterRow = (plan.commitments || []).find(c => c.id === row.id);
    return afterRow && commitmentKey(row) === commitmentKey(afterRow);
  }),
  'pre-existing commitments (except explicitly superseded rows) keep identity and amounts');
function incomeKey(stream) {
  const copy = {
    id: stream.id,
    label: stream.label,
    frequency: stream.frequency,
    day: stream.day,
    amount: stream.amount,
    date: stream.date,
    firstDue: stream.firstDue,
    anchor: stream.anchor,
    confidence: stream.confidence,
  };
  // Child-benefit amount restated 2026-09-18 from evidenced CCB deposits.
  // That restatement is not a CMAW side-effect. Identity, cadence, and
  // confidence still have to match.
  if (copy.id === 'childBenefit') delete copy.amount;
  return JSON.stringify(copy);
}
ok(JSON.stringify((before.plan.income || []).map(incomeKey))
    === JSON.stringify((plan.income || []).map(incomeKey)),
  'plan.income identity, cadence and confidence are unchanged (childBenefit amount restated separately)');
function debtOpening(row) {
  const copy = JSON.parse(JSON.stringify(row || {}));
  delete copy.statementCloseDay;
  delete copy.note; // narrative, not a posted opening
  return copy;
}
ok(JSON.stringify((before.debts || []).map(debtOpening))
    === JSON.stringify((data.debts || []).map(debtOpening)),
  'debt posted openings are unchanged aside from statementCloseDay');
function cashKey(row) {
  return JSON.stringify({
    id: row.id,
    label: row.label,
    value: row.value,
      // The later owner-authorized purpose cutover changes only these two
      // classes; this cancellation proof still reconciles IDs/labels/amounts.
      class: ['savings', 'savings-dont-touch'].includes(row.id) ? undefined : row.class,
  });
}
ok(JSON.stringify((before.plan.startingCash.breakdown || []).map(cashKey))
    === JSON.stringify((plan.startingCash.breakdown || []).map(cashKey))
    && JSON.stringify((before.plan.startingCash.heldElsewhere || []).map(cashKey))
      === JSON.stringify((plan.startingCash.heldElsewhere || []).map(cashKey)),
  'starting cash identity and amounts are unchanged');
ok(JSON.stringify(before.plan.nextDollar) === JSON.stringify(plan.nextDollar),
  'surplus-debt policy is unchanged');

console.log('\n=== Forecast consumes the canonical plan; refresh code does not calculate it ===');
ok(!/CMAW|uniondues/.test(fs.readFileSync(REFRESH_JS, 'utf8')),
  'canonical-refresh.js does not special-case CMAW or calculate a dues answer');
ok(!/CMAW|uniondues/.test(fs.readFileSync(LIVE_JS, 'utf8')),
  'live-plan.js does not special-case CMAW or calculate a dues answer');
const beforeHorizon = Forecast.expandEvents(before.plan, before.meta.asOf, '2027-08-15', {})
  .filter(event => event.id === 'uniondues');
ok(beforeHorizon.length === 12
    && beforeHorizon.every(event => near(-event.amount, 25) && event.date >= '2026-09-15'),
  'pre-change main still expands twelve monthly $25 CMAW events from firstDue 2026-09-15',
  String(beforeHorizon.length));
ok(beforeHorizon.length * 25 === unauthorizedFifteenths.length * 25,
  'removed future cash equals the independently enumerated 15ths × $25');

if (failures) {
  console.log('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nAF-REFRESH-01 union-dues proofs passed.');
