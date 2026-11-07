'use strict';
/* An unknown figure prints Unknown, never $0.00, $NaN, null or undefined,
 * and one malformed row degrades only itself.  `node test/test-unknown-never-zero.js`
 *
 * Every input here is invented. Each page script runs in a vm with the real
 * public/app.js formatters lifted verbatim, and the test reads the HTML the
 * household would read. The expected strings are written by hand; nothing is
 * computed by the code under test. Forecast is stubbed where the page only
 * prints what Forecast returned, so the proof is about the page's printing,
 * independent of the engine. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const appSrc = read('public/app.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const grab = (src, re, label) => {
  const m = re.exec(src);
  if (!m) throw new Error('missing ' + label);
  return m[0];
};
const helpers = [
  grab(appSrc, /^const money = .*$/m, 'money'),
  grab(appSrc, /^const money2 = .*$/m, 'money2'),
  grab(appSrc, /^const pct = .*$/m, 'pct'),
  grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
  grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
  grab(appSrc, /^const fmtDateFull = .*$/m, 'fmtDateFull'),
].join('\n');
// No unknown may leak as a figure or a JavaScript word.
const LEAKS = /\$NaN|NaN%|\bnull\b|\bundefined\b|\[object Object\]/;
const leak = html => (LEAKS.exec(html) || [null])[0];
// A section that throws is one failure, and the next section still runs.
const section = (name, fn) => {
  console.log('\n' + name);
  try { fn(); } catch (e) { ok(false, `${name} section completes`, e.message); }
};

/* ------------------------------------------------------------ formatters */
console.log('\nShared formatters');
const fmt = vm.runInNewContext(`${helpers}\n({ money, money2, pct })`);
for (const [value, name] of [[null, 'null'], [undefined, 'undefined'], ['', 'an empty string'],
  ['  ', 'a blank string'], ['n/a', 'a word'], [NaN, 'NaN'], [Infinity, 'Infinity'],
  [true, 'a boolean'], [{}, 'an object'], [[5], 'an array']]) {
  const shown = f => { try { return f(value); } catch (e) { return 'threw ' + e.message; } };
  ok(shown(fmt.money2) === 'Unknown' && shown(fmt.money) === 'Unknown' && shown(fmt.pct) === 'Unknown',
    `${name} prints Unknown in money2, money and pct`, `${shown(fmt.money2)} / ${shown(fmt.money)} / ${shown(fmt.pct)}`);
}
ok(fmt.money2(0) === '$0.00' && fmt.money(0) === '$0', 'a published zero is still $0.00 / $0');
ok(fmt.money2(-1234.5) === '−$1,234.50' && fmt.money(987.6) === '$988', 'finite numbers format as before');
ok(fmt.money2('42.10') === '$42.10' && (() => { try { return fmt.pct('19.99'); } catch (e) { return e.message; } })() === '19.99%',
  'a numeric string formats as its number');
ok(fmt.pct(7.5) === '7.50%', 'a numeric rate formats as before');

/* ---------------------------------------------------------------- page vm */
function pageContext(extra) {
  const elements = {};
  const ctx = Object.assign({
    console, elements,
    App: { hooks: [], once() {}, register(fn) { this.hooks.push(fn); }, boot() {} },
    css: () => '', hbarCalls: {},
    lineChart() {}, diverge() {}, grouped() {},
  }, extra);
  ctx.hbar = (mount, data) => { ctx.hbarCalls[mount.id] = data; };
  return ctx;
}
function runPage(script, ctx) {
  vm.runInNewContext(
    `${helpers}\nconst $ = id => elements[id] || (elements[id] = { id, innerHTML: '', textContent: '', hidden: true });\n${read(script)}`,
    ctx, { filename: script });
  return ctx;
}
const throwingRow = label => {
  const row = { label };
  Object.defineProperty(row, 'amount', { get() { throw new Error('invented malformed row'); } });
  Object.defineProperty(row, 'balance', { get() { throw new Error('invented malformed row'); } });
  Object.defineProperty(row, 'shape', { get() { throw new Error('invented malformed row'); } });
  return row;
};

/* ----------------------------------------------------------------- Credit */
section('Credit', () => {
  const accounts = {
    asOf: '2026-03-01',
    secured: [],
    cards: [
      { id: 'card-a', label: 'Invented Card A', shape: 'card', confidence: 'verified', balance: 500,
        limit: 2000, available: 1500, rate: 20.5, rateBasis: 'Purchase APR',
        nextPayment: { amount: null, confidence: 'verified', date: '2026-03-20', label: 'Invented minimum' } },
      { id: 'card-b', label: 'Invented Card B', shape: 'card', confidence: 'verified', balance: 1234.56,
        limit: 3000, available: 1765.44, rate: 'about twenty', rateBasis: 'Purchase APR',
        nextPayment: { amount: 25, confidence: 'verified', date: '2026-03-21', label: 'Invented minimum' } },
      { id: 'card-c', label: 'Invented Card C', shape: 'card', confidence: 'verified', balance: 10,
        limit: 1000, available: 990, rate: '12.25', rateBasis: 'Purchase APR',
        nextPayment: { amount: 10, confidence: 'verified', date: '2026-03-22', label: 'Invented minimum' } },
      throwingRow('Invented Card D'),
    ],
  };
  const ctx = runPage('public/credit.js', pageContext({ Forecast: { creditAccounts: () => accounts } }));
  let threw = null;
  try { ctx.App.hooks.forEach(fn => fn({ plan: {}, debts: [], meta: { asOf: '2026-03-01' } })); } catch (e) { threw = e; }
  ok(!threw, 'a string rate and a malformed account do not crash the Credit render', threw && threw.message);
  const html = ctx.elements['credit-cards'].innerHTML;
  const cardA = html.slice(html.indexOf('data-credit-id="card-a"'), html.indexOf('data-credit-id="card-b"'));
  const minA = cardA.slice(cardA.indexOf('data-credit-fact="minimum"'), cardA.indexOf('data-credit-fact="due"'));
  ok(/Unknown/.test(minA) && !/\$0\.00/.test(minA), 'a null next payment prints Unknown, not $0.00');
  ok(/>UNKNOWN</.test(minA) && !/VERIFIED/.test(minA), 'the chip beside an unknown next payment is UNKNOWN, not VERIFIED');
  ok(/data-credit-confidence="unknown"/.test(minA), 'the unknown next payment carries unknown trust');
  const cardB = html.slice(html.indexOf('data-credit-id="card-b"'), html.indexOf('data-credit-id="card-c"'));
  ok(/Rate not readable/.test(cardB) && /\$1,234\.56/.test(cardB), 'an unreadable rate is Unknown and the rest of that card still prints');
  ok(/12\.25%/.test(html), 'a numeric-string rate still prints as its rate');
  ok(/Invented Card D/.test(html) && /data-credit-unavailable="true"/.test(html),
    'a malformed account prints as Unavailable under its own name');
  ok(!leak(html), 'Credit prints no $NaN, null or undefined', leak(html));
});

/* ---------------------------------------------------------------- Records */
section('Records', () => {
  const d = {
    meta: { coverage: 'Invented coverage', transactions: 10, statements: 2, disclaimer: '' },
    netWorth: { caveat: '' }, coverage: [],
    plan: {
      assumptions: [],
      income: [{ label: 'Invented pay', amount: 1000, frequency: 'biweekly', confidence: 'confirmed' },
        { label: 'Invented side income', amount: null, confidence: 'estimated' }],
      obligations: [{ label: 'Invented loan', amount: null, frequency: 'monthly', confidence: 'confirmed' },
        { label: 'Invented mortgage', amount: 1500, frequency: 'monthly', confidence: 'confirmed' }],
      bills: [{ label: 'Invented phone', amount: undefined, frequency: 'monthly', confidence: 'confirmed' }],
      commitments: [],
    },
  };
  const Forecast = {
    publicationTotals: () => ({ assetRows: [], assets: 0, totalDebt: 0, financialAccountsOnly: 0,
      commitmentItems: [{ what: 'Invented trip', when: 'Summer', amount: null, confidence: 'confirmed' }] }),
    commitmentStatus: () => 'open',
  };
  const ctx = runPage('public/records.js', pageContext({ Forecast }));
  let threw = null;
  try { ctx.App.hooks.forEach(fn => fn(d)); } catch (e) { threw = e; }
  ok(!threw, 'Records renders with unknown amounts', threw && threw.message);
  const html = ctx.elements.derivations.innerHTML;
  const row = label => html.slice(html.indexOf(label), html.indexOf('</div>', html.indexOf('deriv-amt', html.indexOf(label))));
  const loan = row('Invented loan');
  ok(/Unknown/.test(loan) && !/\$0\.00/.test(loan), 'a null obligation prints Unknown, not $0.00');
  ok(/>unknown</.test(loan) && !/>confirmed</.test(loan), 'the chip beside an unknown obligation is unknown, not confirmed');
  ok(/\$1,500\.00/.test(row('Invented mortgage')) && />confirmed</.test(row('Invented mortgage')),
    'a known obligation keeps its amount and its confirmed chip');
  ok(/Unknown/.test(row('Invented phone')) && />unknown</.test(row('Invented phone')), 'an undefined bill prints Unknown with an unknown chip');
  ok(/Unknown/.test(row('Invented side income')), 'an income with no amount and no scenarios prints Unknown');
  ok(/Unknown/.test(row('Invented trip')) && />unknown</.test(row('Invented trip')), 'an unknown commitment prints Unknown with an unknown chip');
  ok(!leak(html) && !/\$0\.00/.test(html), 'Records prints no $0.00, $NaN, null or undefined', leak(html));
});

/* --------------------------------------------------------------- Deep Dive */
section('Deep Dive', () => {
  const d = {
    meta: { coverage: 'Invented coverage', transactions: 10, statements: 2, disclaimer: '', asOf: '2026-03-01' },
    plan: { windowDays: 30, obligations: [], bills: [], commitments: [] },
    settled: [],
    commitments: { heading: 'Invented costs', note: '', totalNote: '' },
    debts: [
      { label: 'Invented card', balance: 800, rate: 19.99, structure: 'Revolving', annualInterest: 160 },
      throwingRow('Invented broken debt'),
      { label: 'Invented loan', balance: null, rate: null, structure: null, annualInterest: null },
    ],
    income: [], paypal: { categories: [], perMonth: 10, crossCheck: 10, note: 'Invented.' },
    unexplained: [], questions: [{ q: 'Invented question', detail: 'Invented.', changes: 'Invented.', owner: undefined }],
  };
  const Forecast = {
    deepDive: () => ({ cashAmount: 100, elsewhere: 50, classes: [], heloc: { history: [] }, interest: null }),
    publicationTotals: () => ({
      totalDebt: 800, annualInterest: 160, annualInterestExMortgage: 160, monthlyInterest: 13,
      monthlyInterestExMortgage: 13, creditLeft: 200, revolvingFacilityCount: 1,
      incomeTotal: 5000, incomeMonths: 5, incomePerMonth: null,
      incomeLines: [{ label: 'Invented pay', total: 5000, perMonth: null, stability: 'steady' }],
      commitmentItems: [
        { what: 'Invented roof', when: 'Autumn', amount: 9000, confidence: undefined, note: null, adjustable: false },
        { what: 'Invented car', when: 'Spring', amount: null, confidence: 'confirmed', note: 'Invented.', adjustable: false },
      ],
      commitmentsTotal: 9000,
    }),
    addDays: (iso) => iso,
    expandEvents: () => [],
    nextDue: () => null,
    utilisation: () => ({ rows: [
      { label: 'Invented card', pct: 40, used: 400, limit: 1000, available: 600 },
      { label: 'Invented odd card', pct: null, used: 50, limit: 1000, available: 950 },
    ] }),
  };
  const ctx = runPage('public/deepdive.js', pageContext({ Forecast }));
  let threw = null;
  try { ctx.App.hooks[0](d); } catch (e) { threw = e; }
  ok(!threw, 'a pct:null utilisation row and a malformed debt row do not crash Deep Dive', threw && threw.message);
  const util = ctx.hbarCalls['c-util'] || [];
  ok(util.length === 2 && util[0].v === 40 && util[1].v === 0 && util[1].vlabel === 'Unknown',
    'the pct:null bar is drawn empty and labelled Unknown; the good bar is untouched', JSON.stringify(util.map(u => [u.v, u.vlabel])));
  ok(!/NaN/.test(String(util[1] && util[1].tip)), 'the pct:null bar tip prints no NaN', util[1] && util[1].tip);
  const table = ctx.elements['debt-table'].innerHTML;
  ok(/Invented card/.test(table) && /\$800\.00/.test(table), 'the good debt row still renders');
  ok(/Invented broken debt/.test(table) && /data-deepdive-row="unavailable"/.test(table), 'the malformed debt row prints as Unavailable');
  ok(!leak(table), 'the debt table prints no null or undefined', leak(table));
  const income = ctx.elements['income-note'].textContent;
  ok(/monthly rate unknown/.test(income) && !/\$0\/month/.test(income), 'an unknown income rate is "monthly rate unknown", not $0/month', income);
  const incomeBars = ctx.hbarCalls['c-income'] || [];
  ok(incomeBars.length === 1 && !/\$0/.test(incomeBars[0].tip), 'an unknown per-month rate is not printed in the income tip');
  const commits = ctx.elements['commit-list'].innerHTML;
  ok(!leak(commits), 'commitments print no "null" note and no "undefined" chip', leak(commits));
  ok(/Invented car[\s\S]*?Unknown[\s\S]*?>unknown</.test(commits), 'an unknown commitment amount is Unknown with an unknown chip');
  const questions = ctx.elements.questions.innerHTML;
  ok(!leak(questions), 'a question with no owner prints no "undefined" chip', leak(questions));
});

/* ---------------------------------------------------------------- Planning */
section('Planning', () => {
  const ctx = runPage('public/planning.js', pageContext({ Forecast: {} }));
  const row = ctx.planningRowHtml({ id: 'x', label: 'Invented fund', verdict: 'FUNDING GAP', remaining: null,
    need: 500, confidence: 'calculated', flexibility: 'required', date: '2026-06-01' }, null, null);
  const remaining = row.slice(row.indexOf('data-planning-fact="remaining"'), row.indexOf('</div>', row.indexOf('data-planning-fact="remaining"')));
  ok(/Unknown/.test(remaining) && !/\$0\.00/.test(remaining), 'a withheld remaining is Unknown, not a $0.00 funding gap', remaining);
  ok(/not published, not \$0/.test(remaining), 'the withheld remaining says it is not $0');
  const debt = ctx.planningTrajectoryDebtHtml({ status: 'calculated', consumer: 1200, secured: undefined, heloc: 300 });
  ok(!/\$NaN/.test(debt) && /Unknown/.test(debt), 'an undefined trajectory debt figure prints Unknown, not $NaN');
  ok(!/CALCULATED/.test(debt) && />UNKNOWN</.test(debt), 'the tag over an unknown debt figure is UNKNOWN, not CALCULATED');
  const goodDebt = ctx.planningTrajectoryDebtHtml({ status: 'calculated', consumer: 1200, secured: 2000, heloc: 300 });
  ok(/CALCULATED/.test(goodDebt) && /\$2,000\.00/.test(goodDebt), 'all-known trajectory debt keeps its CALCULATED tag');
  const cash = ctx.planningTrajectoryCashHtml({ status: 'calculated', amount: null });
  ok(/Unknown/.test(cash) && !/CALCULATED/.test(cash), 'an unknown trajectory cash prints Unknown, not a bare CALCULATED tag');
});

/* -------------------------------------------------------------------- Plan */
section('Plan debt answer', () => {
  const planSrc = read('public/plan.js');
  const fn = grab(planSrc, /^function operatingDebtAnswerHtml\([\s\S]*?\n\}$/m, 'operatingDebtAnswerHtml');
  const plan = vm.runInNewContext(`${helpers}\n${fn}\n({ operatingDebtAnswerHtml })`);
  const html = plan.operatingDebtAnswerHtml({
    requiredDebtPayments: { items: [
      { label: 'Invented loan', date: '2026-03-10', amount: null, confidence: 'confirmed' },
      { label: 'Invented card', date: '2026-03-12', amount: 35, confidence: 'confirmed' },
    ] },
    extraDebt: { allocated: 0 },
  });
  const loan = html.slice(html.indexOf('Invented loan'), html.indexOf('Invented card'));
  ok(/Unknown/.test(loan) && !/\$0\.00/.test(loan), 'a null required debt payment prints Unknown, not $0.00');
  ok(/data-debt-payment-amount="unknown"/.test(html) && /\$35\.00/.test(html), 'the unknown row is marked and the known row is unchanged');
});

/* ------------------------------------------------------ Card movements */
section('Budget card movements', () => {
  const CM = require('../public/budget-card-movements.js');
  const fmtMoney = vm.runInNewContext(`${helpers}\n({ money: money2, date: fmtDate })`);
  const goodCard = {
    id: 'card-a', label: 'Invented Card A', reportedBalance: { amount: 321.5, date: '2026-03-01' },
    opening: { date: '2026-02-01', amount: 100 }, closing: { date: '2026-03-01', amount: 321.5 }, reasons: [],
    postedCoverage: 'complete-provider-response', pendingCoverage: 'complete-provider-response',
    posted: [
      { id: 't1', date: '2026-02-10', payee: 'Invented shop', kind: 'charge', direction: 'up', magnitude: 20 },
      null,
      { id: 't3', date: '2026-02-11', payee: 'Invented cafe', kind: 'charge', direction: 'up', magnitude: NaN },
    ],
    pending: [],
  };
  const brokenCard = { id: 'card-b', label: 'Invented Card B', reportedBalance: null, reasons: undefined, posted: undefined, pending: [] };
  const pub = { schema: 'atlas-card-period-movements/v1', source: 'Forecast.cardPeriodMovements', currency: 'CAD',
    start: '2026-02-01', end: '2026-03-01', through: '2026-03-01', cards: [goodCard, brokenCard] };
  let html = '', threw = null;
  try { html = CM.html(pub, fmtMoney); } catch (e) { threw = e; }
  ok(!threw, 'a null transaction and a card with no reasons do not crash the card strip', threw && threw.message);
  ok(/\$321\.50/.test(html) && /Invented shop/.test(html) && /\$20\.00/.test(html), 'the good card and its good row still render');
  ok(/data-card-movement-transaction="unavailable"/.test(html), 'the null transaction prints one Unavailable row');
  ok(/data-budget-card-panel="card-b"[^>]*data-card-movement-unavailable="true"/.test(html), 'the malformed card panel prints as Unavailable');
  ok(!/\$NaN/.test(html) && !leak(html.replace(/data-[a-z-]+="[^"]*"/g, '')), 'the card strip prints no $NaN, null or undefined');
});

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
