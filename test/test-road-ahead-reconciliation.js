'use strict';
// Test-only reconciliation: expected dates, membership and cents never come
// from Forecast's schedule, budget, spendingCycle, cash or debt helpers.
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const F = require('../public/forecast');
const cents = n => Math.round(n * 100);
const clone = x => JSON.parse(JSON.stringify(x));
const day = s => Date.parse(s + 'T00:00:00Z') / 86400000;
const iso = n => new Date(n * 86400000).toISOString().slice(0, 10);
const add = (s, n) => iso(day(s) + n);
const sum = xs => xs.reduce((a, b) => a + b, 0);
const periods = { periods: { ytd: { months: 1, spending: [] } } };
let checks = 0;
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label); checks++;
}
const paths = {
  income: ['stage1', 'income'], bills: ['stage1', 'bills'],
  obligations: ['stage1', 'obligations'], budget: ['stage1', 'householdBudget'],
  commitments: ['stage2', 'commitments'], extras: ['stage3', 'extras'],
};
const component = (p, k) => p[paths[k][0]][paths[k][1]];

// An integer remainder allocator, one daily penny stream, independent of
// floating-point span multiplication. Seed 7/14 is nearest-cent rounding.
function spendingLedger(start, end, fortnightCents) {
  let remainder = 7;
  const out = [];
  for (let d = start; d <= end; d = add(d, 1)) {
    remainder += fortnightCents;
    const amount = Math.floor(remainder / 14);
    remainder %= 14;
    out.push({ date: d, apply: d, kind: 'budget', cents: amount, status: 'calculated' });
  }
  return out;
}
// Test calendar scans dates, unlike Forecast's recurrence expansion.
function dates(row, start, end) {
  if (row.frequency === 'once') return row.date <= end ? [row.date] : [];
  const out = [];
  for (let d = start; d <= end; d = add(d, 1)) {
    if (row.firstDue && d < row.firstDue) continue;
    const [y, m, dom] = d.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let match = false;
    if (row.frequency === 'biweekly') match = (day(d) - day(row.anchor)) % 14 === 0;
    else if (row.frequency === 'monthly') match = dom === Math.min(row.day, last);
    else if (row.frequency === 'quarterly') {
      const [ay, am] = row.anchor.split('-').map(Number);
      match = ((y - ay) * 12 + m - am) % 3 === 0 && dom === Math.min(row.day, last);
    } else if (row.frequency === 'yearly') match = m === row.month && dom === Math.min(row.day, last);
    else assert.fail('Uncovered oracle recurrence: ' + row.frequency);
    if (match) out.push(d);
  }
  return out;
}
function confirmedAtOpening(record, opening) {
  if (record.effectiveAsOf == null) return true;
  const value = record.effectiveAsOf;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(day(value)) && iso(day(value)) === value && value <= opening;
}
function event(row, date, kind, start, amount = row.amount) {
  return { id: row.id, label: row.label, date, apply: date < start ? start : date,
    kind, cents: cents(amount), status: row.confidence === 'confirmed' ? 'calculated' : 'estimated' };
}
function expectedWindows(start, end, anchor, monthly) {
  const groups = new Map();
  for (let d = start; d <= end; d = add(d, 1)) {
    const key = monthly ? d.slice(0, 7) : iso(day(anchor) + 14 * Math.floor((day(d) - day(anchor)) / 14));
    if (!groups.has(key)) groups.set(key, { key, start: d, end: d });
    groups.get(key).end = d;
  }
  return [...groups.values()];
}
function assertPartition(t, ledger, anchor, { incomeThrough = '9999-12-31', budgetStatus = 'calculated' } = {}) {
  for (const [series, monthly] of [[t.months, true], [t.payPeriods, false]]) {
    const spans = expectedWindows(t.horizon.start, t.horizon.end, anchor, monthly);
    eq(series.map(p => ({ key: monthly ? p.month : p.payday, start: p.start, end: p.end })), spans,
      'exact calendar partition, with no overlaps or missing days');
    for (const p of series) {
      // Month stages are pay-period-close funding, not a calendar slice.
      // Cash, debt, and the month start/end window stay on the calendar.
      if (monthly) continue;
      const inSpan = ledger.filter(e => e.apply >= p.start && e.apply <= p.end);
      if (p.stage1.status === 'unavailable') continue;
      const expected = {};
      for (const k of Object.keys(paths)) {
        if (k === 'income' && p.end > incomeThrough) continue;
        const rows = inSpan.filter(e => e.kind === k);
        expected[k] = sum(rows.map(e => e.cents));
        const actual = component(p, k);
        eq(cents(actual.amount), expected[k], `${p.start} ${k}: independent dated ledger`);
        const status = k === 'budget' ? budgetStatus : k === 'extras' ? 'calculated'
          : rows.some(e => e.status === 'estimated') ? 'estimated' : 'calculated';
        eq(actual.status, status, `${p.start} ${k}: weakest constituent trust`);
        if (actual.lines) eq(sum(actual.lines.map(l => cents(l.amount))), expected[k], `${k} lines close in cents`);
        if (k === 'budget' && actual.lines) {
          for (const line of actual.lines) {
            if (line.label === 'Normal spending estimate') continue;
            eq(line.amount >= 0, true, `${p.start} ${line.label}: positive targets stay non-negative`);
          }
        }
        if (['bills', 'obligations', 'commitments'].includes(k)) {
          const ids = [...new Set(rows.map(e => e.id))].sort();
          eq((actual.lines || []).map(l => l.id).sort(), ids, `${k} exact named membership`);
          for (const id of ids) {
            const selected = rows.filter(e => e.id === id);
            const line = actual.lines.find(l => l.id === id);
            eq(cents(line.amount), sum(selected.map(e => e.cents)), `${id}: counted exactly once`);
            const scheduled = [...new Set(selected.map(e => e.date))];
            eq(line.date, scheduled.length === 1 ? scheduled[0] : undefined, `${id}: original scheduled date survives`);
          }
        }
      }
      if (p.end > incomeThrough) continue;
      let result = expected.income - expected.bills - expected.obligations - expected.budget;
      let status = ['income', 'bills', 'obligations', 'budget'].some(k => component(p, k).status === 'estimated')
        ? 'estimated' : 'calculated';
      for (const n of [1, 2, 3]) {
        if (n === 2) { result -= expected.commitments; if (p.stage2.commitments.status === 'estimated') status = 'estimated'; }
        if (n === 3) result -= expected.extras;
        eq(cents(p['stage' + n].result.amount), result, `${p.start} standalone stage ${n}`);
        eq(p['stage' + n].result.status, status, 'result never promotes trust');
        eq(p['stage' + n].result.priorPeriodSurplus, 'excluded', 'no prior surplus');
      }
      eq(p.cash.identity, 'cumulative-walk-close', 'cash is a different identity');
      eq(p.cash.roadAheadFunding, false, 'cash cannot replace standalone funding');
    }
  }
  // Compare whole-cent outputs, not a loose floating-point tolerance.
  if ([...t.months, ...t.payPeriods].every(p => p.stage1.status !== 'unavailable')) {
    const closed = t.payPeriods.filter(p => p.windowKind !== 'horizon-clipped' && p.end === p.cycleEnd);
    for (const k of ['income', 'bills', 'obligations', 'budget', 'extras']) eq(
      sum(t.months.map(p => cents(component(p, k).amount))),
      sum(closed.map(p => cents(component(p, k).amount))), `${k}: each closed pay period belongs to one month`);
    eq(sum(t.months.map(p => cents(p.stage1.result.amount))),
      sum(closed.map(p => cents(p.stage1.result.amount))), 'stage 1: close-month conservation');
    const seen = new Set();
    for (const month of t.months) {
      for (const row of month.closingPayPeriods || []) {
        eq(seen.has(row.payday), false, 'pay period surplus is not counted twice');
        seen.add(row.payday);
        eq(String(row.close).slice(0, 7), month.month, 'close lands in the published month');
      }
    }
    eq(seen.size, closed.length, 'every closed pay period is published in one month');
  }
}

function undatedFixture(start = '2026-01-01') {
  return {
    opening: { asOf: start }, startingCash: { amount: 50000 }, windowDays: 91,
    defaults: { extraDebtMonthly: 5.03, targetBuffer: 0, scenario: 'expected' },
    income: [{ id: 'payroll', label: 'Synthetic salary', frequency: 'biweekly', anchor: '2026-01-30', amount: 1000.01, confidence: 'confirmed' },
      { id: 'amandaSalary15', label: 'Amanda salary 15th', frequency: 'monthly', day: 15, amount: 300.03, confidence: 'confirmed' },
      { id: 'amandaSalaryMonthEnd', label: 'Amanda month end', frequency: 'monthly', day: 31, amount: 400.07, confidence: 'confirmed' },
      { id: 'benefit', label: 'Benefit', frequency: 'monthly', day: 20, amount: 20.01, confidence: 'confirmed' }],
    bills: [
      { id: 'before', label: 'Day before payday', frequency: 'once', date: '2026-02-12', amount: 11.03, confidence: 'confirmed' },
      { id: 'on', label: 'On payday', frequency: 'once', date: '2026-02-13', amount: 13.07, confidence: 'estimated' },
      { id: 'monthly', label: 'Month end bill', frequency: 'monthly', day: 31, amount: 19.09, confidence: 'confirmed' },
      { id: 'quarterly', label: 'Quarterly bill', frequency: 'quarterly', anchor: '2026-01-31', day: 31, amount: 23.11, confidence: 'confirmed' },
      { id: 'annual', label: 'Annual bill', frequency: 'yearly', month: 2, day: 28, amount: 29.13, confidence: 'confirmed' },
      { id: 'overdue', label: 'Unresolved old bill', frequency: 'once', date: '2025-12-15', amount: 31.17, confidence: 'estimated' },
      { id: 'card-paid', label: 'Reserved card service', frequency: 'monthly', day: 4, amount: 41.19, jointCash: false, confidence: 'confirmed' },
      { id: 'external', label: 'Paid elsewhere', frequency: 'monthly', day: 6, amount: 43.21, payingAccount: 'elsewhere', confidence: 'confirmed' },
    ],
    obligations: [{ id: 'minimum', label: 'Required debt', debtId: 'card', effect: 'payment', frequency: 'monthly', day: 31, amount: 7.23, confidence: 'confirmed' },
      { id: 'old-debt', label: 'Unresolved required debt', debtId: 'card', effect: 'payment', frequency: 'once', date: '2025-12-16', amount: 17.31, confidence: 'confirmed' }],
    commitments: [
      { id: 'laptop', label: 'Named laptop', date: '2026-02-13', amount: 501.27, flexibility: 'required', confidence: 'confirmed' },
      { id: 'camp', label: 'Named camp', date: '2026-02-28', amount: 701.29, flexibility: 'adjustable', confidence: 'estimated' },
      { id: 'paid', label: 'Settled purchase', date: '2026-02-13', amount: 99, settledOn: '2025-12-20' },
      { id: 'optional', label: 'Optional purchase', date: '2026-02-13', amount: 999, flexibility: 'optional' },
      { id: 'undated', label: 'Unresolved date', when: 'TBD', amount: 999 },
    ],
    budget: { basis: 'ytd', categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 70.01 },
      { id: 'fuel', label: 'Fuel', class: 'essential', from: ['Fuel'], plannedWeekly: 30.01 },
    ] },
  };
}
// Numeric partition controls have an independently invented year-end date.
// Preserve the original required-undated fixture as a strict negative control.
function fixture(start = '2026-01-01') {
  const plan = undatedFixture(start);
  Object.assign(plan.commitments.find(row => row.id === 'undated'),
    { date: '2026-12-31', label: 'Invented dated ledger cost' });
  return plan;
}
{
  const plan = undatedFixture(), before = JSON.stringify(plan);
  const held = F.baselineTrajectory(plan, [], plan.opening.asOf, { periods });
  eq(held.status, 'unavailable', 'original required-undated fixture cannot publish a trajectory');
  const source = F.fundingSequence(plan, plan.opening.asOf, {}).find(row => row.id === 'undated');
  eq([source.need, source.date], [999, null], 'known source price survives without an invented date');
  eq(JSON.stringify(plan), before, 'negative control never edits its source');
}
const debt = [{ id: 'card', label: 'Synthetic card', balance: 100000, pending: 0, rate: 0,
  rateConvention: 'card', structure: 'Revolving', secured: false, limit: 200000 }];

// Only these synthetic exclusions are intended; no schedule/eligibility helper
// under test determines which entries the expected ledger includes.
function syntheticLedger(p, end, fortnightCents) {
  const start = p.opening.asOf;
  const out = spendingLedger(start, end, fortnightCents);
  for (const [kind, rows] of [['income', p.income], ['bills', p.bills.filter(r => !['card-paid', 'external'].includes(r.id))],
    ['obligations', p.obligations]]) {
    for (const r of rows) for (const d of dates(r, start, end)) {
      if (kind === 'income' && d < start) continue;
      if ((p.opening.representedEvents || []).some(x => x.id === r.id && x.date === d
          && confirmedAtOpening(x, start))) continue;
      out.push(event(r, d, kind, start));
    }
  }
  for (const r of p.commitments.filter(r => ['laptop', 'camp', 'undated'].includes(r.id))) {
    if (r.date >= start && r.date <= end) out.push(event(r, r.date, 'commitments', start));
  }
  for (const d of dates({ frequency: 'monthly', day: 15 }, start, end)) {
    out.push(event({ id: 'extra', amount: p.defaults.extraDebtMonthly }, d, 'extras', start));
  }
  return out;
}
function ask(p, ds = debt, extra = {}) {
  return F.baselineTrajectory(p, ds, p.opening.asOf, { periods, extraDebtTarget: 'card', ...extra });
}

// Explicit scalar proof catches the current-main defect before broad assertions.
{
  const p = fixture(); p.startingCash.heldElsewhere = [{ id: 'elsewhere', amount: 100 }];
  const t = ask(p);
  eq(t.horizon, { start: '2026-01-01', end: '2026-12-31', days: 365 }, '365-day fixture horizon');
  eq(t.weeklyVariable.amount, 100.02, 'two independent owner weekly targets');
  const total = Math.floor((20004 * 365 + 7) / 14);
  eq(sum(t.months.map(p => cents(p.stage1.householdBudget.amount))), total, 'Month conserves integer daily spending');
  eq(sum(t.payPeriods.map(p => cents(p.stage1.householdBudget.amount))), total, 'Pay Period conserves integer daily spending');
  assertPartition(t, syntheticLedger(p, t.horizon.end, 20004), '2026-01-30');
}

function categoryThroughDays(fortnightCents, days, weightCents) {
  const W = sum(weightCents);
  const seats = weightCents.map(() => 0);
  if (!(days > 0) || !(W > 0)) return seats;
  let remainder = 7;
  for (let d = 0; d < days; d++) {
    remainder += fortnightCents;
    const pennies = Math.floor(remainder / 14);
    remainder %= 14;
    if (pennies <= 0) continue;
    let given = 0;
    const parts = weightCents.map((w, i) => {
      const num = pennies * w;
      const floor = Math.floor(num / W);
      seats[i] += floor;
      given += floor;
      return { i, rem: num % W };
    });
    parts.sort((a, b) => b.rem - a.rem || a.i - b.i);
    for (let k = 0; k < pennies - given; k++) seats[parts[k].i] += 1;
  }
  return seats;
}

// Small positive tail: last-line residual at each boundary published -0.01
// in August 2026 for $2000 + $0.01. Daily weighted splits stay non-negative
// and conserve the same component total in both partitions.
{
  const p = fixture();
  p.budget.categories = [
    { id: 'big', label: 'Big', class: 'essential', from: ['X'], plannedMonthly: 2000 },
    { id: 'tiny', label: 'Tiny tail', class: 'essential', from: ['Y'], plannedMonthly: 0.01 },
  ];
  p.bills = []; p.obligations = []; p.commitments = []; p.defaults.extraDebtMonthly = 0;
  p.income = [{ ...p.income[0], amount: 5000 }];
  const t = ask(p, []);
  const weeklyCents = Math.round(200001 * 336 / 1461);
  eq(cents(t.weeklyVariable.amount), weeklyCents, 'tiny-tail weekly independently annualized');
  const ledger = syntheticLedger(p, t.horizon.end, weeklyCents * 2);
  assertPartition(t, ledger, '2026-01-30');
  const weights = [200000, 1];
  const labels = ['Big', 'Tiny tail'];
  for (const period of t.payPeriods) {
    if (period.stage1.status === 'unavailable') continue;
    const prior = ledger.filter(e => e.kind === 'budget' && e.apply < period.start).length;
    const walk = ledger.filter(e =>
      e.kind === 'budget' && e.apply >= period.start && e.apply <= period.end).length;
    const expected = categoryThroughDays(weeklyCents * 2, prior + walk, weights)
      .map((n, i) => n - categoryThroughDays(weeklyCents * 2, prior, weights)[i]);
    const lines = period.stage1.householdBudget.lines || [];
    eq(lines.map(l => l.label), labels, `${period.start}: named tail membership`);
    eq(lines.map(l => cents(l.amount)), expected, `${period.start}: independent monotonic category cents`);
    eq(expected.every(n => n >= 0), true, `${period.start}: independent tail split stays non-negative`);
  }
  for (const month of t.months) {
    if (month.stage1.status === 'unavailable') continue;
    const parts = t.payPeriods.filter(p =>
      p.cycleEnd && p.cycleEnd.slice(0, 7) === month.month
      && p.windowKind !== 'horizon-clipped' && p.end === p.cycleEnd
      && p.stage1.status !== 'unavailable');
    const totals = {};
    for (const part of parts) for (const line of part.stage1.householdBudget.lines || []) {
      totals[line.label] = (totals[line.label] || 0) + cents(line.amount);
    }
    const lines = month.stage1.householdBudget.lines || [];
    for (const line of lines) {
      eq(cents(line.amount), totals[line.label] || 0,
        `${month.month} ${line.label}: month cents sum the closing pay periods`);
    }
    eq(sum(lines.map(l => cents(l.amount))), sum(Object.values(totals)),
      `${month.month}: category cents are not created by the month card`);
  }
  const aug = t.months.find(m => m.month === '2026-08');
  eq(aug && aug.stage1.householdBudget.lines.find(l => l.label === 'Tiny tail').amount >= 0, true,
    'August tiny tail is not the former -0.01 last-line residual');
}

// Payday, preceding day, month end, partial first month/cycle, leap day.
// Moving the opening does not manufacture settlement of an old once debit.
for (const start of ['2025-01-30', '2025-01-31', '2025-02-01', '2025-02-12', '2025-02-13', '2024-02-29']) {
  const p = fixture(start);
  p.income = [{ ...p.income[0], anchor: '2025-01-30' }];
  p.bills = [{ ...p.bills.find(b => b.id === 'overdue'), date: '2024-01-15' },
    { ...p.bills.find(b => b.id === 'monthly') }];
  p.obligations = []; p.commitments = []; p.defaults.extraDebtMonthly = 0;
  const t = ask(p, []);
  assertPartition(t, syntheticLedger(p, t.horizon.end, 20004), '2025-01-30');
}

// A pre-paid exact occurrence is omitted, never its neighbour; historical
// income is not carried into the opening. Live lookback retains recurring dues.
{
  const p = fixture(); p.startingCash.heldElsewhere = [{ id: 'elsewhere', amount: 100 }];
  p.opening.representedEvents = [{ id: 'before', date: '2026-02-12' }, { id: 'old-debt', date: '2025-12-16' }];
  p.income.push({ id: 'old-income', label: 'Old income', frequency: 'once', date: '2025-12-16', amount: 9999, confidence: 'confirmed' });
  const t = ask(p);
  assertPartition(t, syntheticLedger(p, t.horizon.end, 20004), '2026-01-30');

  const live = fixture('2026-02-14');
  live.opening.priorAsOf = '2026-01-29';
  live.opening.representedEvents = [{ id: 'monthly', date: '2026-01-31' }];
  live.income = [live.income[0]];
  live.bills = live.bills.filter(r => ['monthly', 'annual'].includes(r.id));
  live.obligations = []; live.commitments = []; live.defaults.extraDebtMonthly = 0;
  const lt = ask(live, []);
  const held = lt.payPeriods[0];
  eq(held.start, '2026-02-14', 'first window is residual, not full payday');
  eq(held.end, '2026-02-26', 'residual ends day before next payday');
  eq(held.stage1.bills.amount, 0, 'represented Jan 31 is not replayed');
  live.opening.representedEvents = [{ id: 'monthly', date: '2026-01-31', effectiveAsOf: '2026-02-20' }];
  const deferred = ask(live, []);
  eq(deferred.payPeriods[0].stage1.bills.amount, 19.09, 'future-qualified confirmation cannot erase an earlier opening debit');
  eq(deferred.payPeriods[0].stage1.bills.lines[0].date, '2026-01-31', 'deferred confirmation retains the one original carried occurrence');
  const qualified = clone(live); qualified.opening.asOf = '2026-02-20';
  eq(ask(qualified, []).payPeriods[0].stage1.bills.amount, 0, 'qualification becomes effective only at its bounded opening');
  live.opening.representedEvents = [];
  const unresolved = ask(live, []);
  eq(unresolved.payPeriods[0].stage1.bills.amount, 19.09, 'unresolved Jan 31 applies once at opening');
  eq(unresolved.payPeriods[0].stage1.bills.lines[0].date, '2026-01-31', 'carry retains original date');
  eq(cents(unresolved.months[0].stage1.bills.amount) - cents(lt.months[0].stage1.bills.amount), 1909, 'same carry in clipped month');
}

// Debt capacity is proved by a separate zero-interest principal ledger.
// Required and scheduled-extra dollars stop at payoff, including partial cents.
{
  const p = fixture(); p.bills = []; p.commitments = [];
  p.obligations = [{ ...p.obligations[0], day: 14, amount: 7.23 }];
  p.defaults.extraDebtMonthly = 5.03;
  const smallDebt = [{ ...debt[0], balance: 25.01 }];
  const t = ask(p, smallDebt);
  let principal = 2501;
  const ledger = syntheticLedger(p, t.horizon.end, 20004);
  for (const e of ledger.filter(e => ['obligations', 'extras'].includes(e.kind)).sort((a, b) => a.date.localeCompare(b.date))) {
    const applied = Math.min(principal, e.cents); principal -= applied; e.cents = applied;
  }
  assertPartition(t, ledger.filter(e => !['obligations', 'extras'].includes(e.kind) || e.cents > 0), '2026-01-30');
  eq(sum(t.months.map(p => cents(p.stage1.obligations.amount) + cents(p.stage3.extras.amount))), 2501, 'cash debt service equals independent principal reduction');
}

// Two independently amortized tiny debts pay off in the SAME month but
// DIFFERENT pay periods. Six-percent daily interest leaves fractions of a
// cent at payoff. A dated payment is rounded once, not after grouping.
{
  const p = fixture(); p.income = [{ ...p.income[0], amount: 0, anchor: '2026-01-02' }];
  p.bills = []; p.commitments = []; p.budget.categories = []; p.defaults.extraDebtMonthly = 0;
  p.obligations = [2, 30].map((dom, i) => ({ id: 'tiny' + i, debtId: 'tiny' + i, label: 'Tiny debt ' + i,
    effect: 'payment', frequency: 'monthly', day: dom, amount: 10, confidence: 'confirmed' }));
  const ds = p.obligations.map(r => ({ ...debt[0], id: r.debtId, balance: 1.01, rate: 6 }));
  const ledger = [];
  for (const r of p.obligations) {
    let balance = 1.01;
    for (let n = 0; n < r.day; n++) balance += balance * 0.06 / 365;
    ledger.push(event(r, `2026-01-${String(r.day).padStart(2, '0')}`, 'obligations', '2026-01-01', cents(balance) / 100));
  }
  const t = ask(p, ds);
  assertPartition(t, ledger, '2026-01-02');
  const payoffCents = sum(t.payPeriods.map(p => cents(p.stage1.obligations.amount)));
  eq(payoffCents, 202, 'two rounded payoff amounts total 2.02, not 2.03');
  eq(sum(t.months.map(p => cents(p.stage1.obligations.amount))), payoffCents,
    'each rounded payoff is kept in the month its pay period closes');
}

// Two fractional payoffs in ONE pay period distinguish rounding each dated
// payment from rounding their grouped total. Each independently accrued $1
// principal pays $1.01 on Jan 31; their raw sum would round to $2.01, not $2.02.
{
  const p = fixture(); p.income = [{ ...p.income[0], amount: 0, anchor: '2026-01-02' }];
  p.bills = []; p.commitments = []; p.budget.categories = []; p.defaults.extraDebtMonthly = 0;
  p.obligations = [0, 1].map(i => ({ id: 'same-period' + i, debtId: 'same-period' + i,
    label: 'Same-period debt ' + i, effect: 'payment', frequency: 'monthly', day: 31,
    amount: 10, confidence: 'confirmed' }));
  const ds = p.obligations.map(r => ({ ...debt[0], id: r.debtId, balance: 1, rate: 6 }));
  const ledger = [];
  for (const r of p.obligations) {
    let balance = 1;
    for (let n = 0; n < 31; n++) balance += balance * 0.06 / 365;
    eq(cents(balance), 101, 'independent daily interest rounds each payoff to 1.01');
    ledger.push(event(r, '2026-01-31', 'obligations', '2026-01-01', cents(balance) / 100));
  }
  const t = ask(p, ds);
  assertPartition(t, ledger, '2026-01-02');
  const period = t.payPeriods.find(r => r.payday === '2026-01-30');
  eq({ start: period.start, end: period.end }, { start: '2026-01-30', end: '2026-02-12' },
    'both fractional payments belong to one closing pay period');
  eq(period.stage1.obligations.amount, 2.02, 'same-period payoffs total exactly 2.02, not 2.01');
  eq(period.stage1.obligations.lines.map(l => ({ id: l.id, amount: l.amount })),
    p.obligations.map(r => ({ id: r.id, amount: 1.01 })), 'exact named payoff amounts remain whole cents');
  eq(t.months.find(m => m.month === '2026-02').stage1.obligations.amount, 2.02,
    'February close-month preserves both individually rounded payoffs');
}

// Recent baseline: completed posted 101.01; current groceries actual 40.01,
// reserve 59.99, Other 3.01 => full estimate 103.01; mean 102.01.
// Pending old consumption, income, a transfer, a debt payment and a represented
// bill are explicit non-members. Neither view treats the estimate as verified.
{
  const p = fixture('2025-01-16'); p.defaults.extraDebtMonthly = 0;
  p.income = [{ ...p.income[0], anchor: '2025-01-02' }];
  p.bills = []; p.obligations = []; p.commitments = [];
  p.budget.categories = [{ id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedPayday: 100 }];
  const tx = (id, date, amount, extra = {}) => ({ id, date, amount, atlasAccountId: 'chequing-a', account: 'chequing-a',
    pending: false, categoryLabel: 'Groceries', payee: 'MERIDIAN FARM', originalMerchant: 'MERIDIAN FARM', ...extra });
  const packet = { schema: 'atlas-current-period-actuals/v1', coverageStart: '2025-01-02', coverageThrough: '2025-01-16',
    observationAsOf: '2025-01-16', pendingCoverage: 'complete', transactionCoverage: 'complete',
    transactions: [tx('done', '2025-01-15', 101.01), tx('now', '2025-01-16', 40.01),
      tx('other', '2025-01-16', 3.01, { categoryLabel: 'Uncategorised', payee: 'SYNTHETIC UNKNOWN', originalMerchant: 'SYNTHETIC UNKNOWN' }),
      tx('pending-old', '2025-01-14', 99, { pending: true }),
      tx('income', '2025-01-16', -500, { isIncome: true }),
      tx('transfer', '2025-01-16', 500, { categoryLabel: 'Transfer' }),
      tx('payment', '2025-01-16', 500, { categoryLabel: 'Credit Card Payment', payee: 'CAN TIRE MC' })] };
  const t = ask(p, [], { currentPeriodActuals: packet });
  eq(t.normalSpending.completedPeriod.amount, 101.01, 'completed actual is posted only');
  eq(t.normalSpending.currentPeriod.actualToDate, 43.02, 'current normal actual excludes nonconsumption');
  eq(t.normalSpending.currentPeriod.remainingExpected, 59.99, 'unspent reserve only');
  eq(t.normalSpending.payPeriodAmount, 102.01, 'independent odd-cent mean');
  eq(t.weeklyVariable.amount, 51.005, 'half-cent weekly rate remains exact');
  assertPartition(t, syntheticLedger(p, t.horizon.end, 10201), '2025-01-02', { budgetStatus: 'estimated' });
  for (const period of t.payPeriods.filter(r => day(r.end) - day(r.start) === 13 && r.stage1.status !== 'unavailable')) {
    eq(period.stage1.householdBudget.amount, 102.01, 'every full cycle keeps the odd-cent baseline');
  }
  for (const bad of [null, { ...packet, coverageStart: '2025-01-03' }, { ...packet, transactionCoverage: 'incomplete' }]) {
    const fallback = ask(p, [], { currentPeriodActuals: bad });
    eq(fallback.normalSpending.status, 'unavailable', 'incomplete baseline fails closed');
    eq(fallback.normalSpending.payPeriodAmount, null, 'unavailable is not zero');
    // 100 per fortnight -> rounded monthly 217.41 -> rounded weekly 50.00.
    eq(fallback.weeklyVariable.amount, 50, 'same independent planned fallback');
    assertPartition(fallback, syntheticLedger(p, fallback.horizon.end, 10000), '2025-01-02');
  }
}

// Explicit unavailable payroll boundary and genuine calculated zero stay
// distinct. A month crossing a trust boundary can be withheld while the
// earlier pay period remains usable: differing dates, same trust rule.
{
  const p = fixture('2026-12-20'); p.bills = []; p.obligations = []; p.commitments = [];
  p.income = [{ ...p.income[0], label: 'Dale Seaspan', anchor: '2026-12-18' }];
  p.defaults.extraDebtMonthly = 0;
  const t = ask(p, []);
  for (const row of [...t.months, ...t.payPeriods].filter(r => r.end >= '2027-01-01')) {
    eq(row.stage3.status, 'unavailable', 'unmodelled salary withholds both series');
    eq(row.stage3.result, undefined, 'withheld result never becomes zero');
  }
  p.income[0].amount = 0; p.budget.categories = [];
  const zero = ask(p, []);
  eq(zero.months[0].stage3.result.amount, 0, 'real calculated zero remains zero');
  eq(zero.payPeriods[0].stage3.result.status, 'calculated', 'zero is not unavailable');
}

// Consumer proof executes the real rendering functions. The same packet is
// switched repeatedly; poisoned cumulative cash must never replace stage3.
{
  const ctx = { Forecast: F, App: { register() {}, boot() {} }, console };
  const app = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  const helpers = ['money', 'money2', 'pct', 'fmtDate', 'fmtDateLong', 'fmtDateFull']
    .map(name => app.match(new RegExp('^const ' + name + ' = .*$', 'm'))[0]).join('\n');
  vm.runInNewContext(helpers + '\n' + fs.readFileSync(require.resolve('../public/planning.js'), 'utf8'), ctx);
  const p = fixture(); p.startingCash.heldElsewhere = [{ id: 'elsewhere', amount: 100 }];
  const t = ask(p); const before = JSON.stringify(t);
  let calls = 0;
  const actuals = { marker: 'sanitized synthetic packet' };
  ctx.Forecast = { baselineTrajectory(plan, debts, asOf, options) {
    calls++;
    eq(plan, p, 'page forwards the original plan');
    eq(debts, debt, 'page forwards the original debts');
    eq(asOf, p.opening.asOf, 'page forwards the financial opening');
    eq(options.currentPeriodActuals, actuals, 'page forwards the applied overlay actuals');
    return t;
  } };
  eq(ctx.planningTrajectory({ plan: p, debts: debt, meta: { asOf: p.opening.asOf },
    liveOverlay: { applied: true, currentPeriodActuals: actuals } }, periods), t, 'page reprints Forecast authority');
  eq(calls, 1, 'one Forecast call obtains both series');
  ctx.Forecast = F;
  for (const mode of ['month', 'pay-period', 'month', 'pay-period']) {
    const series = ctx.planningRoadAheadPeriods(t, mode);
    eq(series, mode === 'month' ? t.months : t.payPeriods, 'toggle consumes existing Forecast array');
    for (const row of series.slice(0, 3)) {
      const poisoned = { ...row, cash: { status: 'calculated', amount: 987654321.23 } };
      eq(ctx.planningRoadAheadStage3Result(poisoned, mode),
        mode === 'month' ? row.stage3.dateOrderResult : row.stage3.result,
        'renderer selects the Forecast result for the chosen view');
      const packet = clone(t);
      (mode === 'month' ? packet.months : packet.payPeriods).forEach(r => { r.cash = poisoned.cash; });
      const html = ctx.planningRoadAheadHtml(packet, mode, mode === 'month' ? row.month : row.payday, t.asOf);
      eq(JSON.stringify(html).includes('987,654,321'), false, 'cumulative cash absent from visible Road Ahead');
    }
  }
  eq(JSON.stringify(t), before, 'toggling does not mutate financial state');
  eq(ctx.planningRoadAheadStage3Result({ stage3: { status: 'unavailable' }, cash: { amount: 999 } }), null,
    'unavailable stage never falls back to cumulative cash');
  const rich = clone(p); rich.startingCash.amount += 10000;
  const rt = ask(rich);
  eq(rt.months.map(r => r.stage3), t.months.map(r => r.stage3), 'opening cash does not enter monthly result');
  eq(rt.payPeriods.map(r => r.stage3), t.payPeriods.map(r => r.stage3), 'opening cash does not enter payday result');
}

// Deliberately current-household reconciliation. Reads committed sanitized
// inputs; no raw data, live GET, new opening, or invented recent actuals.
// The 2027 net-pay model has independent paystub/statutory tests in
// test-dale-payroll-regime.js. Here 2026 income is independently enumerated;
// all-year income is additionally conserved across partitions, not claimed
// independently verified future income.
{
  const data = require('../data.json');
  const history = require('../public/periods.json');
  const before = JSON.stringify(data);
  const p = data.plan, start = data.meta.asOf;
  const t = F.baselineTrajectory(p, data.debts, start, { periods: history });
  eq(t.normalSpending.status, 'unavailable', 'repository has no recent transaction packet');
  eq(t.weeklyVariable.source, 'budgetBreakdown.planned', 'dated household uses disclosed fallback');
  // Reconcile this committed Aug 19 opening against its explicitly bounded
  // retired policies, rather than annualizing the October restatements backwards.
  // Forecast still receives the actual canonical plan above. The oracle's
  // integer arithmetic and every dated ledger assertion stay unchanged.
  const oraclePlan = require('./fixtures/retired-fuel-policy')(
    require('./fixtures/retired-other-policy')(data)).plan;
  const monthlyCents = oraclePlan.budget.categories.filter(c => c.class !== 'reserve').map(c => {
    if (c.plannedWeekly != null) return Math.round(c.plannedWeekly * 100 * 1461 / 336);
    if (c.plannedMonthly != null) return cents(c.plannedMonthly);
    if (c.plannedPayday != null) return c.paydayCadence ? cents(c.plannedPayday)
      : Math.round(c.plannedPayday * 100 * 1461 / 672);
    assert.ok(c.currentMonthly == null, 'new currentMonthly needs explicit oracle treatment');
    return 0; // Historical actuals are deliberately not a planned fallback target.
  });
  const weeklyCents = Math.round(sum(monthlyCents) * 336 / 1461);
  eq(cents(t.weeklyVariable.amount), weeklyCents, 'household fallback independently annualized from owner targets');
  const ledger = spendingLedger(start, t.horizon.end, weeklyCents * 2);
  const represented = (p.opening.representedEvents || []).filter(r => confirmedAtOpening(r, start));
  const prepaid = (id, date) => represented.some(r => r.id === id && r.date === date);
  const scheduledDebt = new Map();
  for (const r of p.income) for (const date of dates(r, start, t.horizon.end)) {
    if (date >= start) ledger.push(event(r, date, 'income', start));
  }
  const heldElsewhere = (p.startingCash.heldElsewhere || []).map(r => r.id);
  const debtIds = data.debts.map(r => r.id);
  for (const r of p.bills) {
    const funded = r.fundingAccount === 'chequing-a';
    if (r.householdObligation === false || r.needsDate || !funded && (r.jointCash === false
      || heldElsewhere.includes(r.payingAccount) || debtIds.includes(r.payingAccount))) continue;
    for (const date of dates(r, start, t.horizon.end)) {
      if (prepaid(r.id, date)) continue;
      // An explicitly confirmed no-pay occurrence has no cash ledger leg.
      // Other dates keep their nominal/credit arithmetic independently below.
      if (Array.isArray(r.noPaymentRequiredOn)
          && r.noPaymentRequiredOn.some(noPayDate => noPayDate === date)) continue;
      const credit = date === r.firstDue && r.utilityAccountCredit
        ? Number(r.utilityAccountCredit.amount ?? r.utilityAccountCredit) : 0;
      ledger.push(event(r, date, 'bills', start, Math.max(0, r.amount - credit)));
    }
  }
  for (const original of p.obligations) {
    let r = original;
    if (r.nonCash) {
      if (!(r.cashPayment > 0)) continue;
      r = { ...r, frequency: 'monthly', day: r.cashDay, firstDue: r.cashFirstDue,
        amount: r.cashPayment, confidence: r.cashConfidence };
    }
    // Primary dated statement facts replace their one estimated ledger row.
    // Membership comes from the independent calendar scan above, never a
    // Forecast occurrence, settlement or amount helper.
    const statements = new Map();
    for (const statement of r.statementOccurrences || []) {
      assert.ok(statement.currency === 'cad' && statement.confidence === 'confirmed'
        && Number.isFinite(statement.minimum) && statement.minimum >= 0
        && dates(r, statement.scheduledDate, statement.scheduledDate).includes(statement.scheduledDate)
        && !statements.has(statement.scheduledDate), 'unsupported primary statement in independent ledger');
      statements.set(statement.scheduledDate, statement);
    }
    const candidates = new Set(dates(r, start, t.horizon.end));
    for (const statement of statements.values()) {
      if (statement.dueDate >= start && statement.dueDate <= t.horizon.end) candidates.add(statement.scheduledDate);
    }
    for (const scheduledDate of candidates) {
      const statement = statements.get(scheduledDate);
      const date = statement ? statement.dueDate : scheduledDate;
      if (date > t.horizon.end || date < start && r.frequency !== 'once'
          || prepaid(r.id, scheduledDate) || prepaid(r.id, date)) continue;
      const occurrence = statement ? { ...r, amount: statement.minimum, confidence: statement.confidence } : r;
      if (!(occurrence.amount > 0)) continue;
      ledger.push(event(occurrence, date, 'obligations', start));
      scheduledDebt.set(r.debtId, (scheduledDebt.get(r.debtId) || 0) + cents(occurrence.amount));
    }
  }
  eq(p.defaults.extraDebtMonthly, 0, 'current household has no scheduled extra; synthetic proof exercises nonzero');
  for (const [id, payments] of scheduledDebt) {
    const d = data.debts.find(d => d.id === id);
    assert.ok(payments < cents(d.balance) && d.rate >= 0,
      id + ': even zero-interest full payment principal cannot exhaust opening debt, so no absorption cap can alter expected payments');
  }
  const notDated = [];
  for (const r of p.commitments) {
    if (r.settledOn && r.settledOn <= start || r.flexibility === 'optional') continue;
    if (r.amount == null || !r.date) { notDated.push(r.id); continue; }
    if (r.date >= start && r.date <= t.horizon.end) ledger.push(event(r, r.date, 'commitments', start));
  }
  // Yearly card-paid bills already expand once as kind:'bill' and stay
  // out of Stage 1 (the bills loop above skips jointCash false / debt
  // payers). Road Ahead Stage 2 now counts that same cash event with
  // commitments. This oracle dates them from the calendar scan, not
  // Forecast's expander, and does not invent a plan.commitments row.
  const commitmentIds = new Set((p.commitments || []).map(c => c && c.id));
  for (const r of p.bills) {
    if (r.frequency !== 'yearly') continue;
    if (r.householdObligation === false || r.needsDate) continue;
    if (heldElsewhere.includes(r.payingAccount)) continue;
    if (!(r.jointCash === false || debtIds.includes(r.payingAccount))) continue;
    if (commitmentIds.has(r.id)) continue;
    for (const date of dates(r, start, t.horizon.end)) {
      if (prepaid(r.id, date)) continue;
      ledger.push(event(r, date, 'commitments', start));
    }
  }
  // Dated reserve planning lumps are one cash outflow on planningDate.
  // They join Stage 2 planned spending. They are not a plan.commitments row
  // and not a monthly budget smear. The amount and date are read from the
  // reserve category, not from Forecast.expandEvents.
  for (const row of (p.budget && p.budget.categories) || []) {
    if (!row || row.class !== 'reserve' || !row.id) continue;
    if (commitmentIds.has(row.id)) continue;
    if ((p.bills || []).some(b => b && b.id === row.id)) continue;
    const amount = Number(row.plannedAmount);
    const date = row.planningDate;
    if (!(amount > 0) || typeof date !== 'string') continue;
    if (date < start || date > t.horizon.end) continue;
    ledger.push(event(row, date, 'commitments', start, amount));
  }
  assertPartition(t, ledger, p.income.find(r => r.id === 'payroll').anchor, { incomeThrough: '2026-12-31' });
  const summary = {};
  for (const k of Object.keys(paths)) summary[k] = sum(t.months.map(p => cents(component(p, k).amount))) / 100;
  summary.standaloneNet = sum(t.months.map(p => cents(p.stage3.result.amount))) / 100;
  summary.unresolvedCommitmentsWithoutPointEvent = notDated;
  console.log('Committed household reconciliation (dated opening, not live): ' + JSON.stringify(summary));
  eq(JSON.stringify(data), before, 'household source facts never mutated');
}

console.log(`Road Ahead independent reconciliation: ${checks} assertions passed.`);
