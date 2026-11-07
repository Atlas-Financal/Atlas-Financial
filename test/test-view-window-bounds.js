'use strict';
/* A shortened view counts only events inside its own window (audit C7,
 * acceptance scenario 1.10).
 *
 * Forecast.simulate with a viewDays shorter than the horizon used to keep the
 * whole 7-day week's income, bills and household spending when the cut fell
 * mid-week. Invented numbers only. Every expectation is derived here from the
 * fixture list (date filter + sum), never from Forecast's own totals.
 *
 * `node test/test-view-window-bounds.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.005;

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const AS_OF = '2026-10-14';
const HORIZON = 28;
const WEEKLY = 70; // 10 a day of invented household spending
const INCOME = [
  { id: 'first-day', date: '2026-10-14', amount: 100 },
  { id: 'last-day', date: '2026-10-18', amount: 25 },
  { id: 'just-after', date: '2026-10-19', amount: 300 },
  { id: 'later', date: '2026-11-02', amount: 50 },
];
const BILLS = [
  { id: 'b-first', date: '2026-10-14', amount: 15 },
  { id: 'b-last', date: '2026-10-18', amount: 40 },
  { id: 'b-after', date: '2026-10-20', amount: 200 },
  { id: 'b-later', date: '2026-11-09', amount: 60 },
];

function plan() {
  return {
    windowDays: HORIZON,
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 1000 },
    income: INCOME.map(i => ({ id: i.id, label: i.id, frequency: 'once', date: i.date,
      amount: i.amount, confidence: 'confirmed' })),
    obligations: [],
    bills: BILLS.map(b => ({ id: b.id, label: b.id, frequency: 'once', date: b.date,
      amount: b.amount, confidence: 'confirmed' })),
    commitments: [],
  };
}

// Independent oracle: what a window [start, end] must count.
function oracle(start, end) {
  const inside = d => d >= start && d <= end;
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  return {
    income: INCOME.filter(i => inside(i.date)).reduce((s, i) => s + i.amount, 0),
    bills: BILLS.filter(b => inside(b.date)).reduce((s, b) => s + b.amount, 0),
    variable: WEEKLY / 7 * days,
  };
}

function view(days, viewStart) {
  const opts = { weeklyVariable: WEEKLY, horizonDays: HORIZON, viewDays: days };
  if (viewStart) opts.viewStart = viewStart;
  return F.simulate(plan(), AS_OF, opts);
}

console.log('\n=== C7: a 5-day view from as-of counts only its own days ===');
{
  const v = view(5);
  const want = oracle(AS_OF, '2026-10-18');
  ok(v.start === AS_OF && v.end === '2026-10-18', 'the view runs Oct 14 - Oct 18', `${v.start} - ${v.end}`);
  ok(near(v.totals.income, want.income), `view income is ${want.income} (first and last day once, Oct 19 excluded)`, String(v.totals.income));
  ok(near(v.totals.bills, want.bills), `view bills are ${want.bills} (first and last day once, Oct 20 excluded)`, String(v.totals.bills));
  ok(near(v.totals.variable, want.variable), `view household spending is ${want.variable} (5 days, not 7)`, String(v.totals.variable));
  const week = v.weeks[v.weeks.length - 1];
  ok(week.end === '2026-10-18' && week.events.every(e => e.date <= '2026-10-18'),
    'the clipped week lists no event after the view end');
  ok(near(week.confirmedIncome, want.income) && near(week.bills, want.bills),
    'the clipped week totals match the view totals');
}

console.log('\n=== edges: every cut from 1 to 27 days matches the oracle ===');
for (let days = 1; days < HORIZON; days++) {
  const v = view(days);
  const want = oracle(AS_OF, addDays(AS_OF, days - 1));
  const good = near(v.totals.income, want.income) && near(v.totals.bills, want.bills)
    && near(v.totals.variable, want.variable);
  if (!good || days % 7 === 5 || days % 7 === 6) {
    ok(good, `${days}-day view: income ${want.income}, bills ${want.bills}, spending ${want.variable}`,
      `${v.totals.income} / ${v.totals.bills} / ${v.totals.variable}`);
  } else ok(true, `${days}-day view matches the oracle`);
}

console.log('\n=== full-period view is unchanged ===');
{
  const full = view(HORIZON);
  const plain = F.simulate(plan(), AS_OF, { weeklyVariable: WEEKLY, horizonDays: HORIZON });
  const want = oracle(AS_OF, addDays(AS_OF, HORIZON - 1));
  ok(JSON.stringify(full.totals) === JSON.stringify(plain.totals)
      && JSON.stringify(full.weeks) === JSON.stringify(plain.weeks),
    'a view as long as the horizon is the whole walk');
  ok(near(full.totals.income, want.income) && near(full.totals.bills, want.bills),
    `full income ${want.income} and bills ${want.bills}`, `${full.totals.income} / ${full.totals.bills}`);
}

console.log('\n=== conservation: no event lands in two views ===');
for (let cut = 1; cut < HORIZON; cut++) {
  const head = view(cut);
  const tail = view(HORIZON - cut, addDays(AS_OF, cut));
  const full = view(HORIZON);
  const ids = v => v.events.filter(e => e.kind === 'income' || e.kind === 'bill').map(e => e.id);
  const a = ids(head), b = ids(tail), all = ids(full);
  const both = a.filter(id => b.includes(id));
  const sum = (k) => head.totals[k] + tail.totals[k];
  const good = both.length === 0 && a.length + b.length === all.length
    && near(sum('income'), full.totals.income) && near(sum('bills'), full.totals.bills)
    && near(sum('variable'), full.totals.variable)
    && near(head.weeks.reduce((s, w) => s + w.confirmedIncome, 0), head.totals.confirmedIncome);
  if (!good || cut === 5) {
    ok(good, `split after day ${cut}: each event in exactly one view, totals add to the whole`,
      `shared [${both}] income ${sum('income')}/${full.totals.income} bills ${sum('bills')}/${full.totals.bills}`);
  } else ok(true, `split after day ${cut} conserves every event`);
}

console.log('\n=== Atlas review 585c6b5 #1: the clipped week low and flags cover only its days ===');
{
  // Opening 1,000, buffer 500, no spending; a 1,400 bill falls one day after
  // a 5-day view ends (Oct 19), so the whole walk dips to -400 on Oct 19 but
  // nothing inside the view moves the balance.
  const p = { windowDays: HORIZON, defaults: { targetBuffer: 500 }, startingCash: { amount: 1000 },
    income: [], obligations: [], commitments: [],
    bills: [{ id: 'after', label: 'after', frequency: 'once', date: '2026-10-19', amount: 1400, confidence: 'confirmed' }] };
  const v = F.simulate(p, AS_OF, { weeklyVariable: 0, horizonDays: HORIZON, viewDays: 5 });
  const w = v.weeks[v.weeks.length - 1];
  ok(v.min.balance === 1000, 'the view headline lowest balance is 1,000', String(v.min.balance));
  ok(w.low === 1000 && w.negative === false && w.belowBuffer === false,
    'the clipped week low is 1,000, not negative and not below buffer', `${w.low} / ${w.negative} / ${w.belowBuffer}`);
  const fullWalk = F.simulate(p, AS_OF, { weeklyVariable: 0, horizonDays: HORIZON });
  ok(fullWalk.weeks[0].low === -400 && fullWalk.weeks[0].negative === true,
    'positive control: the unsliced week still sees the -400 dip', String(fullWalk.weeks[0].low));
}

console.log('\n=== headline, daily chart and weekly low agree for every cut ===');
for (let days = 1; days < HORIZON; days++) {
  const v = view(days);
  const opening = v.knowledge ? plan().startingCash.amount : plan().startingCash.amount;
  let good = true;
  for (const w of v.weeks) {
    const retained = v.daily.filter(d => d.date >= w.start && d.date <= w.end).map(d => d.balance);
    const low = Math.min(w.opening, ...retained);
    good = good && near(w.low, low) && w.negative === (low < 0) && w.belowBuffer === (low < v.buffer)
      && w.end <= v.end;
  }
  const weekLow = Math.min(...v.weeks.map(w => w.low));
  good = good && near(weekLow, Math.min(opening, v.min.balance));
  if (!good || days === 5) ok(good, `${days}-day view: each week's low/flags come from its own days and match the headline`);
  else ok(true, `${days}-day view low and flags agree`);
}

console.log(failures ? `\n${failures} FAILED` : '\nAll view-window checks passed.');
process.exit(failures ? 1 : 0);
