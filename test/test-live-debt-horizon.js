'use strict';
/* Deliberately live reconciliation of the committed canonical plan.
 * Household amounts come from data.json; they are not behaviour fixtures.
 * Expected dates are counted by inspecting each UTC calendar day, without
 * Forecast's recurrence, absorption, simulation, or test-helper arithmetic.
 * The synthetic horizon suite separately proves behaviour and cap optimality.
 */
const assert = require('assert/strict');
const F = require('../public/forecast.js');
const data = require('../data.json');
const periods = require('../public/periods.json');

const DAY = 86400000;
const time = date => Date.parse(`${date}T00:00:00Z`);
const iso = stamp => new Date(stamp).toISOString().slice(0, 10);
const total = rows => rows.reduce((sum, row) => sum + row.amount, 0);
let checks = 0;
function near(actual, expected, label) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) < 0.005,
  `${label}: expected ${expected}, got ${actual}`);
  checks++;
}
function scope(condition, message) {
  assert.ok(condition, `Independent live reconciliation needs an explicit extension: ${message}`);
}

const plan = data.plan;
const start = data.meta.asOf;
const opening = plan.opening || {};
scope(opening.asOf === start && !opening.priorAsOf,
  'this suite proves the canonical opening, not an observation overlay');
const representedKeys = new Set((opening.representedEvents || [])
  .filter(row => row && row.id && row.date && (!row.effectiveAsOf || row.effectiveAsOf <= start))
  .map(row => `${row.id}@${row.date}`));
scope(representedKeys.has('noble-garbage@2026-09-18')
  && representedKeys.has('heloc@2026-09-21')
  && representedKeys.has('tdcc@2026-09-17')
  && representedKeys.size === 3
  && !(opening.notReliedUponEvents || []).length,
  'Dale-gated prepaid representedEvents must be reconciled independently');
scope((plan.defaults.extraDebtMonthly || 0) === 0,
  'extra-debt payments require an independent absorption ledger');

const unsettled = (plan.commitments || []).filter(row => !(row.settledOn && row.settledOn <= start));
const fullDays = Math.max(365, ...unsettled.filter(row => row.date)
  .map(row => (time(row.date) - time(start)) / DAY + 1));
scope(Number.isInteger(fullDays), 'the authoritative horizon contains an invalid date');

// This oracle checks calendar-day properties rather than advancing the
// production recurrence. A past once cash debt/bill is still due; income and
// noncash charges never acquire invented historical occurrences.
function datesFor(row, days, carryOnce) {
  const end = iso(time(start) + (days - 1) * DAY);
  scope(!row.until && !row.endDate && !row.end && !row.lastDue,
    `${row.id}: new ending-cadence semantics`);
  if (row.frequency === 'once') {
    scope(Number.isFinite(time(row.date)), `${row.id}: invalid once date`);
    return row.date <= end && (row.date >= start || carryOnce) ? [row.date] : [];
  }
  scope(['monthly', 'biweekly', 'quarterly', 'yearly'].includes(row.frequency),
    `${row.id}: unsupported cadence ${row.frequency}`);
  const result = [];
  for (let n = 0; n < days; n++) {
    const stamp = time(start) + n * DAY;
    const day = new Date(stamp);
    const date = iso(stamp);
    if (row.firstDue && date < row.firstDue) continue;
    if (row.frequency === 'biweekly') {
      scope(Number.isFinite(time(row.anchor)), `${row.id}: missing biweekly anchor`);
      if ((stamp - time(row.anchor)) / DAY % 14 === 0) result.push(date);
      continue;
    }
    scope(Number.isInteger(row.day) && row.day > 0 && row.day <= 31,
      `${row.id}: missing day of month`);
    const lastDay = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
    if (day.getUTCDate() !== Math.min(row.day, lastDay)) continue;
    if (row.frequency === 'yearly' && day.getUTCMonth() + 1 !== row.month) continue;
    if (row.frequency === 'quarterly') {
      scope(Number.isFinite(time(row.anchor)), `${row.id}: missing quarterly anchor`);
      const anchor = new Date(time(row.anchor));
      const months = (day.getUTCFullYear() - anchor.getUTCFullYear()) * 12
        + day.getUTCMonth() - anchor.getUTCMonth();
      if (months % 3 !== 0) continue;
    }
    result.push(date);
  }
  return result;
}

const cashIds = new Set(plan.startingCash.breakdown.map(row => row.id));
const heldIds = new Set((plan.startingCash.heldElsewhere || []).map(row => row.id));
const debtIds = new Set(data.debts.map(row => row.id));
const startingCash = plan.startingCash.breakdown.reduce((sum, row) => {
  scope(Number.isFinite(row.value), `${row.id}: unknown opening cash`);
  if (row.id !== 'chequing-a' && row.id !== 'chequing-b') return sum;
  return sum + row.value;
}, 0);

// Owner Dale, 2026-09-25: 2027 Dale pay periods use the 2027 estimated
// payroll, marked estimated. That amount is the statutory calculator's,
// exposed as F.projectedDalePayroll and proved by its own suites; this
// ledger still counts the calendar dates itself and only takes the
// per-date net for in-regime Dale cheques from that one shared source
// (dates with no deposit are omitted; a deposit no stream schedules is
// added once). 2026 dates and dates after the authorized year keep the
// declared stream amount.
// Identification as the Budget timeline rows use it: the canonical
// payrollBonus id is a Dale bonus whatever its label says.
const isDale = row => row.id === 'payroll' || row.id === 'payrollBonus'
  || /seaspan/i.test(`${row.id || ''} ${row.label || ''}`);
const isDaleBonus = row => row.id === 'payrollBonus'
  || (isDale(row) && /bonus/i.test(`${row.id || ''} ${row.label || ''}`));
const daleRegime = (() => {
  const a = plan.payrollPlanningAssumptions;
  if (!a || !Number.isInteger(Number(a.authorizedThroughYear))) return null;
  const through = `${Number(a.authorizedThroughYear)}-12-31`;
  if (through < '2027-01-01') return null;
  const projected = F.projectedDalePayroll(plan, '2027-01-01', through, { asOf: start });
  if (!projected || projected.status !== 'ready') return null;
  const byKey = new Map();
  for (const dep of projected.deposits || []) {
    scope(Number.isFinite(Number(dep.net)), `${dep.id}: nonnumeric projected payroll`);
    byKey.set(`${dep.kind}:${dep.date}`, dep);
  }
  return { through: projected.estimatedThrough || through, byKey };
})();
const inDaleRegime = date => !!daleRegime && date >= '2027-01-01' && date <= daleRegime.through;

function independentLedger(days) {
  const rows = [];
  const add = (row, kind, carryOnce) => {
    scope(Number.isFinite(row.amount) && row.amount >= 0, `${row.id}: nonnumeric amount`);
    for (const date of datesFor(row, days, carryOnce)) {
      if (representedKeys.has(`${row.id}@${date}`)) continue;
      if ((row.statementOccurrences || []).some(statement => statement.scheduledDate === date)) continue;
      rows.push({ id: row.id, date, kind, amount: row.amount, debtId: row.debtId });
    }
    // Dated statement facts are a separate source ledger replacing the
    // corresponding calendar-generated estimate, independently of Forecast.
    const end = iso(time(start) + (days - 1) * DAY);
    for (const statement of row.statementOccurrences || []) {
      scope(statement.confidence === 'confirmed' && statement.currency === 'cad'
        && Number.isFinite(statement.minimum), row.id + ': unsupported statement fact');
      if (statement.dueDate < start || statement.dueDate > end
        || representedKeys.has(row.id + '@' + statement.scheduledDate)) continue;
      rows.push({ id: row.id, date: statement.dueDate, kind, amount: statement.minimum, debtId: row.debtId });
    }
  };
  const daleSeen = new Set();
  for (const row of plan.income) {
    scope(!row.scenarioMonthly, `${row.id}: scenario income needs independent conversion`);
    if (!daleRegime || !isDale(row)) { add(row, 'income', false); continue; }
    scope(Number.isFinite(row.amount) && row.amount >= 0, `${row.id}: nonnumeric amount`);
    const kind = isDaleBonus(row) ? 'bonus' : 'regular';
    for (const date of datesFor(row, days, false)) {
      if (representedKeys.has(`${row.id}@${date}`)) continue;
      if (!inDaleRegime(date)) {
        rows.push({ id: row.id, date, kind: 'income', amount: row.amount });
        continue;
      }
      daleSeen.add(`${kind}:${date}`);
      const dep = daleRegime.byKey.get(`${kind}:${date}`);
      if (dep) rows.push({ id: row.id, date, kind: 'income', amount: Math.round(Number(dep.net) * 100) / 100 });
    }
  }
  if (daleRegime) {
    const end = iso(time(start) + (days - 1) * DAY);
    for (const [key, dep] of daleRegime.byKey) {
      if (daleSeen.has(key) || dep.date < start || dep.date > end) continue;
      if (representedKeys.has(`${dep.id}@${dep.date}`)) continue;
      rows.push({ id: dep.id, date: dep.date, kind: 'income', amount: Math.round(Number(dep.net) * 100) / 100 });
    }
  }
  for (const row of plan.obligations) {
    scope(debtIds.has(row.debtId), `${row.id}: obligation has no known debt`);
    scope(row.nonCash ? row.effect === 'capitalise' : row.effect === 'payment',
      `${row.id}: new debt effect`);
    add(row, row.nonCash ? 'noncash' : 'obligation', !row.nonCash);
    const cashPayment = Number(row.cashPayment) || 0;
    if (row.nonCash && cashPayment > 0) {
      scope(Number.isInteger(row.cashDay) && row.cashDay > 0 && row.cashDay <= 31,
        `${row.id}: capitalising cashPayment needs cashDay`);
      add({
        id: row.id,
        frequency: row.frequency,
        day: row.cashDay,
        firstDue: row.cashFirstDue || null,
        amount: cashPayment,
        debtId: row.debtId,
      }, 'obligation', true);
    }
  }
  for (const row of plan.bills || []) {
    if (row.householdObligation === false) continue;
    scope(!row.needsDate, `${row.id}: undated bill needs independent evidence handling`);
    // Held-elsewhere bills without Bills funding do not withdraw joint cash. A known card payer
    // reserves the service cost without creating another chequing payment.
    const held = heldIds.has(row.payingAccount);
    const funded = row.fundingAccount === 'chequing-a';
    if (funded) scope(held && cashIds.has(row.fundingAccount), `${row.id}: supported cash funding source`);
    const card = !held && (debtIds.has(row.payingAccount) || row.jointCash === false);
    scope(!row.payingAccount || cashIds.has(row.payingAccount) || held || card,
      `${row.id}: unknown paying-account attribution`);
    const kind = funded ? 'bill' : held ? 'external' : card ? 'reserved' : 'bill';
    const dates = datesFor(row, days, !row.nonCash);
    const rawCredit = row.utilityAccountCredit;
    const credit = typeof rawCredit === 'number' ? rawCredit
      : rawCredit && typeof rawCredit === 'object' ? Number(rawCredit.amount) : 0;
    if (rawCredit != null) {
      scope(Number.isFinite(credit) && credit > 0,
        `${row.id}: invalid utility-account credit`);
      // A recorded credit may remain unapplied while the next invoice date is
      // unknown. Only a separately dated firstDue authorizes cash netting.
      if (row.firstDue) scope(typeof row.firstDue === 'string' && Number.isFinite(time(row.firstDue)),
        `${row.id}: invalid utility-account credit application date`);
      if (rawCredit && typeof rawCredit === 'object' && rawCredit.asOf) {
        scope(Number.isFinite(time(rawCredit.asOf)) && (!row.firstDue || rawCredit.asOf <= row.firstDue),
          `${row.id}: utility-account credit evidence post-dates firstDue`);
      }
    }
    for (const date of dates) {
      if (representedKeys.has(`${row.id}@${date}`)) continue;
      if (Array.isArray(row.noPaymentRequiredOn)
          && row.noPaymentRequiredOn.some(noPayDate => noPayDate === date)) continue;
      const amount = date === row.firstDue && credit > 0
        ? Math.max(0, row.amount - credit)
        : row.amount;
      if (amount <= 0) continue;
      rows.push({ id: row.id, date, kind, amount, debtId: row.debtId });
    }
  }
  const end = iso(time(start) + (days - 1) * DAY);
  for (const row of unsettled) {
    if (!row.date || row.date > end || row.amount == null) continue;
    scope(Number.isFinite(row.amount) && row.amount >= 0, `${row.id}: invalid point commitment`);
    rows.push({ id: row.id, date: row.date, kind: 'commitment', amount: row.amount });
  }
  const commitmentIds = new Set((plan.commitments || []).map(row => row && row.id));
  const billIds = new Set((plan.bills || []).map(row => row && row.id));
  for (const row of (plan.budget && plan.budget.categories) || []) {
    if (!row || row.class !== 'reserve' || !row.id) continue;
    if (commitmentIds.has(row.id) || billIds.has(row.id)) continue;
    const amount = Number(row.plannedAmount);
    const date = row.planningDate;
    if (!Number.isFinite(amount) || !(amount > 0) || typeof date !== 'string') continue;
    scope(Number.isFinite(time(date)), `${row.id}: invalid reserve planning date`);
    if (date < start || date > end) continue;
    rows.push({ id: row.id, date, kind: 'reserve', amount });
  }
  return rows;
}

const expectedFull = independentLedger(fullDays);
// A simple lower bound proves every scheduled payment is absorbed: even
// ignoring all positive interest, the opening exceeds all scheduled cash.
// This avoids claiming that the production debt ledger proves itself.
for (const debt of data.debts) {
  const due = total(expectedFull.filter(row => row.kind === 'obligation' && row.debtId === debt.id));
  scope(Number.isFinite(debt.balance) && !debt.pendingUnknown
    && Number.isFinite(debt.pending) && debt.pending >= 0 && debt.rate >= 0,
  `${debt.id}: unknown balance/pending or negative interest invalidates the bound`);
  scope(debt.balance + debt.pending > due,
    `${debt.id}: payoff may cap payments; a separate independent payoff proof is needed`);
}

const undatedMonthly = (plan.budget.categories || []).reduce((sum, row) => {
  const targeted = ['plannedMonthly', 'plannedWeekly', 'plannedPayday']
    .some(key => Number.isFinite(row[key]));
  return sum + (!targeted && Number.isFinite(row.currentMonthly) ? row.currentMonthly : 0);
}, 0);
const opts = { debts: data.debts, periods, extraFacilities: data.revolvingExtra };
const recommendation = F.recommend(plan, start, opts);
scope(recommendation.mode === 'normal' && !recommendation.simOptions.variableFrom
  && !(recommendation.simOptions.injections || []).length,
  'opening-gap recovery requires a separate independently reconciled cash source');
near(recommendation.knowledge.days, fullDays, 'source-derived master horizon');
const full = F.simulate(plan, start, Object.assign({}, recommendation.simOptions, {
  weeklyVariable: recommendation.weekly, viewDays: fullDays,
}));

for (const [days, sim] of [[plan.windowDays, recommendation.sim], [fullDays, full]]) {
  const expected = days === fullDays ? expectedFull : independentLedger(days);
  for (const [kind, key] of [['income', 'income'], ['obligation', 'obligations'],
    ['bill', 'bills'], ['noncash', 'noncash'], ['commitment', 'commitments']]) {
    near(sim.totals[key], total(expected.filter(row => row.kind === kind)), `${days}-day ${key}`);
  }
  const reserved = total(expected.filter(row => row.kind === 'reserved'))
    + undatedMonthly * 12 / 365.25 * days;
  // The published weekly amount is the selected spend input to this cash
  // identity, not an independently proved optimum. Synthetic tests prove that.
  const variable = recommendation.weekly * days / 7;
  near(sim.totals.reserved, reserved, `${days}-day service reserves counted once`);
  near(sim.totals.variable, variable, `${days}-day selected weekly spending`);
  near(sim.totals.extra, 0, `${days}-day no unsolicited extra debt payment`);
  near(sim.totals.injections, 0, `${days}-day no invented funding`);
  const reservePlanning = total(expected.filter(row => row.kind === 'reserve'));
  near(sim.totals.reservePlanning || 0, reservePlanning, `${days}-day dated reserve planning counted once`);
  const expectedEnding = startingCash + total(expected.filter(row => row.kind === 'income'))
    - total(expected.filter(row => ['obligation', 'bill', 'commitment'].includes(row.kind)))
    - reservePlanning - reserved - variable;
  near(sim.ending, expectedEnding, `${days}-day complete independent ending cash`);

  // Identity comparison catches a missing final/once payment, duplicate MBNA
  // stub, invented future occurrence, and omitted mortgage/minimum dates even
  // if another erroneous event happens to compensate for the total.
  const expectedPayments = expected.filter(row => row.kind === 'obligation')
    .map(row => `${row.date}:${row.id}:${row.amount.toFixed(2)}`).sort();
  const actualPayments = sim.events.filter(row => row.kind === 'obligation')
    .map(row => `${row.date}:${row.id}:${(-row.amount).toFixed(2)}`).sort();
  assert.deepEqual(actualPayments, expectedPayments, `${days}-day exact debt occurrence identities`);
  checks++;
  for (const bill of (plan.bills || []).filter(row => row.frequency === 'once')) {
    const expectedCount = expected.filter(row => row.id === bill.id).length;
    const actual = sim.events.filter(row => row.id === bill.id);
    assert.equal(actual.length, expectedCount, `${days}-day ${bill.id} final/once count`);
    if (actual.length) assert.equal(actual[0].date, bill.date, `${bill.id} retains its source date`);
    checks++;
  }
}
near(recommendation.knowledge.ending, full.ending, 'published master ending copies the reconciled walk');
console.log(`PASS ${checks} independent live debt-horizon reconciliations`);
