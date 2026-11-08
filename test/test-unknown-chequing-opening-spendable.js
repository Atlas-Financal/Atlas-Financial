'use strict';
/* A household chequing opening row with no numeric evidence (`value: null`,
 * a blank string, or `unknown: true`) is Unknown for Current Balance
 * (ATLAS-078). It must make "Spendable household cash" Unknown too, never
 * count as $0 (or as its flagged value) beside an unavailable Current
 * Balance. ATLAS-078 rulings A/B apply: `unknown: true` is unknown before
 * conversion; null/blank/boolean/object/non-numeric values are not
 * evidence; finite numbers and numeric strings (0 and negatives) are.
 *
 * Invented fixtures only. Every expected figure is a hand-written literal
 * (Chequing A 250 + Chequing B 300 = 550; Savings 1000 never counts), not
 * a value computed by the code under test.
 *
 * Measured through the engine (Forecast.spendableHouseholdCash,
 * paydayAllocation, recommend, simulate, deepDive, chequingAvailability)
 * and the page paths that print it: the Budget hero tile and payday
 * "Money available" (public/plan.js), the Deep Dive cash tile
 * (public/deepdive.js) and the chequing headline adapter
 * (public/chequing-headline.js).
 *
 * `node test/test-unknown-chequing-opening-spendable.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const C = require('../public/forecast-chequing.js');
const H = require('../public/chequing-headline.js');

const ROOT = path.join(__dirname, '..');
const read = p => sourceText(fs.readFileSync(path.join(ROOT, p), 'utf8'));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const AS_OF = '2026-01-01';
const OVERDRAFT = [{ id: 'od', cash: 'chequing-b', limit: 100, balance: 0 }];

function fixture(aRow, bRow) {
  return {
    windowDays: 30,
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    startingCash: { breakdown: [aRow, bRow || { id: 'chequing-b', value: 300 }, { id: 'savings', value: 1000 }] },
    opening: { asOf: AS_OF },
    budget: { basis: 'ytd', categories: [] },
    income: [{ id: 'pay', label: 'Payday', frequency: 'once', date: '2026-01-15', amount: 2000, confidence: 'confirmed' }],
    bills: [], obligations: [], commitments: [],
  };
}

/* ---- page renderers, extracted from their exact source ---- */
const planSrc = read('public/plan.js');
function grab(src, re, label) {
  const m = re.exec(src);
  if (!m) throw new Error('missing ' + label);
  return m[0];
}
const appSrc = read('public/app.js');
const planPage = vm.runInNewContext([
  grab(appSrc, /^const money = .*$/m, 'money'),
  grab(appSrc, /^const money2 = .*$/m, 'money2'),
  'const fmtDateLong = d => String(d);',
  'const addDays = (d, n) => d;',
  grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
  grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
  grab(planSrc, /^function currentOperatingUnavailableHtml\([\s\S]*?\n\}$/m, 'currentOperatingUnavailableHtml'),
  grab(planSrc, /^function currentOperatingCashHeroTiles\([\s\S]*?\n\}$/m, 'currentOperatingCashHeroTiles'),
  '({ currentOperatingCashHeroTiles, money, money2 });',
].join('\n'), { Forecast: F });

// The payday "Money available" figure: the exact spendable expression and
// hero markup from paydayAnswerHtml, evaluated against the real engine.
const SPENDABLE_EXPR = grab(planSrc,
  /const spendable = alloc && alloc\.available != null\n\s+\? alloc\.available\n\s+: Forecast\.spendableHouseholdCash\(plan\);/,
  'paydayAnswerHtml spendable');
const HERO_MARKUP = grab(planSrc, /<p class="payday-hero" data-fig="spendable">\$\{[^\n]*\}<\/p>/, 'payday hero');
const paydayHero = (plan, alloc) => vm.runInNewContext(
  `${SPENDABLE_EXPR}\n\`${HERO_MARKUP}\`;`,
  { Forecast: F, plan, alloc, money2: planPage.money2 });

// Deep Dive cash tile: the page's exact tile `val` template.
const diveSrc = read('public/deepdive.js');
const DIVE_VAL = grab(diveSrc, /<div class="val">\$\{[^\n]*\}<\/div>/, 'deep dive tile val');
const diveTile = value => vm.runInNewContext(`\`${DIVE_VAL}\`;`,
  { t: { value }, money: planPage.money });

const PRECISE = /\$\s?\d/;

/* ---- defect cases: Chequing A carries no numeric evidence ---- */
const UNKNOWN_ROWS = [
  ['value null', { id: 'chequing-a', value: null }],
  ['value "" (blank)', { id: 'chequing-a', value: '' }],
  ['value "  " (whitespace)', { id: 'chequing-a', value: '  ' }],
  ['value absent', { id: 'chequing-a' }],
  ['value true (boolean)', { id: 'chequing-a', value: true }],
  ['value "250abc" (partial string)', { id: 'chequing-a', value: '250abc' }],
  ['unknown:true with numeric 250 (ruling A)', { id: 'chequing-a', value: 250, unknown: true }],
];
for (const [name, row] of UNKNOWN_ROWS) {
  console.log(`\nChequing A ${name}, Chequing B 300, Savings 1000`);
  const plan = fixture(row);
  ok(F.householdChequingRowValue(row) === null, 'shared reader: no evidence -> null');
  ok(F.spendableHouseholdCash(plan) === null, 'engine: spendable household cash is Unknown (null), not 300 or 550',
    `got ${F.spendableHouseholdCash(plan)}`);
  const alloc = F.paydayAllocation(plan, AS_OF, {});
  ok(alloc.currentBalancePublication.amount === null
    && alloc.currentBalancePublication.status === 'unavailable',
  'Current Balance publication stays unavailable (ATLAS-078 unchanged)');
  ok(alloc.available === null && alloc.opening === null && alloc.status === 'unavailable',
    'paydayAllocation: available and opening withheld', `available=${alloc.available} opening=${alloc.opening}`);
  ok(alloc.runningLeftover === null && alloc.spendPermission === null && alloc.weeklyCap === null,
    'paydayAllocation: downstream leftover / permission / cap withheld');
  ok(alloc.openingCash && alloc.openingCash.status === 'unavailable'
    && alloc.openingCash.accounts.join() === 'chequing-a', 'paydayAllocation names the unknown account');
  const sim = F.simulate(plan, AS_OF, {});
  ok(sim.status === 'unavailable' && sim.ending === null && sim.min.balance === null
    && sim.daily.length > 0 && sim.daily.every(d => d.balance === null),
  'simulate: the walk seeded from the unknown opening is withheld, not $0-seeded');
  let rec = null, threw = null;
  try { rec = F.recommend(plan, AS_OF, {}); } catch (e) { threw = e.message; }
  ok(!threw, 'recommend does not crash', threw || '');
  if (rec) {
    ok(rec.operatingPlanUnavailable === true && /chequing opening balance is unknown/.test(rec.operatingPlanNote),
      'recommend: current operating plan is unavailable with the named reason');
    ok(rec.paydayAllocation.available === null, 'recommend: paydayAllocation.available withheld');
    ok(rec.sim.status === 'unavailable' && rec.sim.ending === null
      && rec.sim.daily.every(d => d.balance === null), 'recommend: published sim withheld');
    ok(rec.weekly === null && rec.funding === null && rec.knowledge.ending === null,
      'recommend: weekly cap, funding and knowledge ending withheld');
    const views = [rec.defaultView, ...(rec.payPeriodViews || [])].filter(Boolean);
    ok(views.length > 0 && views.every(v => v.available === null && v.predictedEndingBalance === null),
      'recommend: period views carry no walk-derived available / ending figure');
    // Budget hero tile, through the real gate with the real advice.
    const tiles = planPage.currentOperatingCashHeroTiles(plan, AS_OF, rec.sim, rec, null);
    const tile = tiles.find(t => t.lab === 'Spendable household cash');
    ok(tile && tile.val === 'unavailable', 'Budget hero tile prints unavailable', tile && tile.val);
  }
  // Even without the recommend gate, the hero tile reads the Unknown figure.
  const ungated = planPage.currentOperatingCashHeroTiles(plan, AS_OF, { events: [] }, {}, null)
    .find(t => t.lab === 'Spendable household cash');
  ok(ungated && ungated.val === 'unavailable' && !PRECISE.test(ungated.val),
    'Budget hero tile reader prints unavailable even outside the operating gate', ungated && ungated.val);
  const hero = paydayHero(plan, alloc);
  ok(/>unavailable</.test(hero) && !PRECISE.test(hero), 'payday "Money available" prints unavailable', hero);
  const dive = F.deepDive({ plan });
  ok(dive.cashAmount === null, 'deepDive.cashAmount is Unknown', `got ${dive.cashAmount}`);
  const diveHtml = diveTile(dive.cashAmount);
  ok(/>(unavailable|Unknown)</.test(diveHtml) && !PRECISE.test(diveHtml), 'Deep Dive cash tile prints Unknown, not a figure', diveHtml);
  const cheq = C.chequingAvailability(plan, OVERDRAFT, null);
  ok(cheq.status === 'unavailable' && cheq.available === null,
    'chequingAvailability is unavailable', `status=${cheq.status} available=${cheq.available}`);
  ok(H.headlineModel(cheq) === null, 'chequing headline renders no precise number');
}

/* Chequing B unknown, Chequing A known: same gate, either account. */
console.log('\nChequing A 250, Chequing B unknown:true 300');
{
  const plan = fixture({ id: 'chequing-a', value: 250 }, { id: 'chequing-b', value: 300, unknown: true });
  ok(F.spendableHouseholdCash(plan) === null, 'spendable household cash is Unknown');
  ok(F.paydayAllocation(plan, AS_OF, {}).available === null, 'paydayAllocation.available withheld');
  ok(F.deepDive({ plan }).cashAmount === null, 'deepDive.cashAmount Unknown');
  ok(C.chequingAvailability(plan, OVERDRAFT, null).status === 'unavailable', 'chequingAvailability unavailable');
}

/* Savings row unknown: out of this gate; chequing is fully known. */
console.log('\nChequing A 250, Chequing B 300, Savings unknown');
{
  const plan = fixture({ id: 'chequing-a', value: 250 });
  plan.startingCash.breakdown[2] = { id: 'savings', value: null };
  ok(F.spendableHouseholdCash(plan) === 550, 'a Savings row does not enter the chequing gate', `got ${F.spendableHouseholdCash(plan)}`);
}

/* ---- known rows are unchanged ---- */
for (const [name, aValue, expected] of [
  ['number 250', 250, 550],
  ['numeric string "250"', '250', 550],
  ['evidenced zero', 0, 300],
  ['negative -50', -50, 250],
]) {
  console.log(`\nKnown Chequing A ${name}, Chequing B 300`);
  const plan = fixture({ id: 'chequing-a', value: aValue });
  ok(F.spendableHouseholdCash(plan) === expected, `spendable household cash = ${expected}`,
    `got ${F.spendableHouseholdCash(plan)}`);
  ok(F.startingCashAmount(plan) === expected, `walk seed = ${expected}`);
  const alloc = F.paydayAllocation(plan, AS_OF, {});
  ok(alloc.available === expected && alloc.opening === expected && !alloc.openingCash,
    `paydayAllocation.available = ${expected}`, `got ${alloc.available}`);
  ok(F.deepDive({ plan }).cashAmount === expected, `deepDive.cashAmount = ${expected}`);
  const sim = F.simulate(plan, AS_OF, {});
  ok(sim.status !== 'unavailable' && typeof sim.ending === 'number', 'simulate publishes its walk');
  const tile = planPage.currentOperatingCashHeroTiles(plan, AS_OF, { events: [] }, {}, null)
    .find(t => t.lab === 'Spendable household cash');
  ok(tile && tile.val === planPage.money(expected), `Budget hero tile prints ${planPage.money(expected)}`, tile && tile.val);
  ok(/\$\d/.test(paydayHero(plan, alloc)), 'payday "Money available" prints a figure');
  const cheq = C.chequingAvailability(plan, OVERDRAFT, null);
  // Hand identity: max(0,A) + max(0,B) + unused overdraft 100.
  const handAvail = Math.max(0, Number(aValue)) + 300 + 100;
  ok(cheq.status === 'available' && cheq.available === handAvail,
    `chequingAvailability = ${handAvail}`, `status=${cheq.status} available=${cheq.available}`);
}

/* The headline adapter's observed-cash packet uses the same reader. */
console.log('\nObserved cash packet with an unknown Chequing A falls back, never counts $0');
{
  const plan = fixture({ id: 'chequing-a', value: 250 });
  const overlay = { observedCash: { complete: true, asOf: AS_OF,
    accounts: [{ id: 'chequing-a', value: '' }, { id: 'chequing-b', value: 40 }] } };
  const cheq = C.chequingAvailability(plan, OVERDRAFT, overlay);
  ok(cheq.cashSource === 'opening' && cheq.available === 250 + 300 + 100,
    'blank observed Chequing A is not $0; the known opening is used', `source=${cheq.cashSource} available=${cheq.available}`);
}

/* The multi-month trajectory (Planning Road Ahead cash cell and the Budget
 * month lens) reads the same walk. Its withheld null balances must never
 * read as a calculated $0.00 month. Fixture shape follows
 * test/test-baseline-trajectory.js; invented numbers only. */
console.log('\nBaseline trajectory and the Planning cash cell');
{
  const T_START = '2026-06-15';
  const tPlan = aRow => ({
    windowDays: 91,
    startingCash: { breakdown: [aRow, { id: 'chequing-b', value: 300 }] },
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: T_START },
    budget: { basis: 'ytd', categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 140 },
    ] },
    income: [{ id: 'payroll', label: 'Synthetic payroll', frequency: 'biweekly', anchor: '2026-06-12',
      amount: 2000, confidence: 'estimated' }],
    obligations: [{ id: 'card-min', debtId: 'card', effect: 'payment', label: 'Card minimum',
      frequency: 'monthly', day: 20, amount: 80, confidence: 'confirmed' }],
    bills: [], commitments: [],
  });
  const tDebts = [{ id: 'card', label: 'Synthetic card', balance: 600, pending: 0, rate: 19.99,
    rateConvention: 'card', structure: 'Revolving — synthetic', secured: false, limit: 1500 }];
  const tAsk = aRow => F.baselineTrajectory(tPlan(aRow), tDebts, T_START,
    { periods: { periods: { ytd: { label: 'YTD fixture', months: 1,
      spending: [{ label: 'Groceries', total: 50000 }] } } } });
  const planningSrc = read('public/planning.js');
  const cell = vm.runInNewContext([
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    'const fmtDateFull = d => String(d);',
    'const planningTrajectoryChip = s => "<i>" + s + "</i>";',
    grab(planningSrc, /^function planningTrajectoryCashHtml\([\s\S]*?\n\}$/m, 'planningTrajectoryCashHtml'),
    'planningTrajectoryCashHtml;',
  ].join('\n'), {});
  const known = tAsk({ id: 'chequing-a', value: 2200 });
  ok(known.status === 'ready' && (known.months || []).some(m => m.cash && typeof m.cash.amount === 'number' && m.cash.amount !== 0),
    'control: a known opening publishes trajectory cash figures', `status=${known.status}`);
  for (const [name, row] of [
    ['unknown:true 2200', { id: 'chequing-a', value: 2200, unknown: true }],
    ['value null', { id: 'chequing-a', value: null }],
  ]) {
    const t = tAsk(row);
    const cells = [...(t.months || []), ...(t.payPeriods || [])].map(m => m && m.cash).filter(Boolean);
    ok(t.status === 'unavailable' && cells.every(c => c.amount == null),
      `${name}: trajectory is unavailable and publishes no cash amount`,
      `status=${t.status} amounts=${cells.map(c => c.amount).slice(0, 3).join(',')}`);
    const html = cell(t.status === 'unavailable' ? { status: 'unavailable', reason: t.reason }
      : (t.months && t.months[0] && t.months[0].cash));
    ok(/Forecast unavailable/.test(html) && !PRECISE.test(html), `${name}: Planning cash cell prints unavailable`, html);
  }
}

/* Savings funding schedule: every contribution is measured against the
 * opening-seeded walk, so an unknown opening makes it unavailable. */
console.log('\nSavings funding schedule');
{
  const plan = fixture({ id: 'chequing-a', value: 250, unknown: true });
  const sim = F.simulate(plan, AS_OF, {});
  const schedule = F.planSpendPaydayFunding(plan, AS_OF, sim, [], [], null, new Map());
  ok(schedule.status === 'unavailable' && /chequing opening balance is unknown/.test(schedule.reason),
    'planSpendPaydayFunding is unavailable with the named reason', `status=${schedule.status} reason=${schedule.reason}`);
}

/* Assistant / Talk packet (Atlas review on 2f1ea3f, blocker 1): the
 * server-side packet must publish the same Unknown, never the surviving
 * Chequing B subtotal as a "dated opening". Acceptance-harness world
 * (invented: Chequing A 2000, Chequing B 500). */
console.log('\nAssistant packet and Talk presentation');
{
  const H = require('./acceptance/harness.js');
  const Packet = require('../scripts/assistant-packet.js');
  const Talk = require('../scripts/talk-presentation.js');
  const rule = Talk.ruleFor('current.spendableHouseholdCash.value');
  const build = patch => {
    const w = H.baseWorld();
    if (patch) w.dataPatch = d => patch(d.plan.startingCash.breakdown);
    const data = H.dataOf(w).data;
    return { data, packet: Packet.buildPacket({ data, periods: { periods: {} }, questionsMarkdown: '' }) };
  };
  const known = build(null);
  const kc = known.packet.current.spendableHouseholdCash;
  ok(kc.value === 2500 && kc.status !== 'unavailable', 'control: known chequing publishes 2500 (2000 + 500)',
    JSON.stringify(kc));
  ok(/\$2,500/.test(rule.present(kc.value, known.packet).text), 'control: Talk prints the known $2,500');
  for (const [name, patch] of [
    ['Chequing A value null', rows => { rows.find(r => r.id === 'chequing-a').value = null; }],
    ['Chequing A blank', rows => { rows.find(r => r.id === 'chequing-a').value = ''; }],
    ['Chequing A unknown:true', rows => { rows.find(r => r.id === 'chequing-a').unknown = true; }],
  ]) {
    const { packet } = build(patch);
    const c = packet.current.spendableHouseholdCash;
    ok(c.value === null && c.status === 'unavailable' && c.status !== 'dated-opening'
      && /chequing opening balance is unknown/.test(c.reason || ''),
    `${name}: packet spendable cash is unavailable, not the 500 subtotal`, JSON.stringify(c));
    const text = rule.present(c.value, packet).text;
    ok(/unavailable/i.test(text) && !PRECISE.test(text) && !/Dated opening cash is/.test(text),
      `${name}: Talk says unavailable, never a dated opening amount`, text);
  }
}

/* startingCashAmount is the internal walk seed only: no page file calls it.
 * Comments are stripped first; forecast.js (the engine that owns it) is
 * the one file allowed to. */
console.log('\nNo page file calls the internal walk seed');
{
  const dir = path.join(ROOT, 'public');
  const callers = fs.readdirSync(dir)
    .filter(f => f.endsWith('.js') && f !== 'forecast.js')
    .filter(f => /\bstartingCashAmount\s*\(/.test(read('public/' + f)
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')));
  ok(callers.length === 0, 'no public/*.js page file calls startingCashAmount', callers.join(', '));
  // Server-side publishers (assistant/Talk packet, refresh result, positions
  // CSV, figures snapshot) read spendableHouseholdCash too. The only scripts
  // still calling the seed are internal writer/acceptance consistency checks
  // that publish nothing: each is named here, so a new caller fails.
  const INTERNAL_SEED_CHECKS = {
    'canonical-refresh.js': 'writer preview delta and finite-cash consumability checks',
    'live-plan.js': 'overlay finite-cash consumability check',
    'refresh-loop-acceptance.js': 'acceptance comparison against an independent chequing sum',
  };
  const sdir = path.join(ROOT, 'scripts');
  const scriptCallers = fs.readdirSync(sdir).filter(f => f.endsWith('.js'))
    .filter(f => /\bstartingCashAmount\s*\(/.test(read('scripts/' + f)
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')));
  ok(scriptCallers.every(f => INTERNAL_SEED_CHECKS[f]),
    'only named internal consistency checks in scripts/ call startingCashAmount',
    scriptCallers.filter(f => !INTERNAL_SEED_CHECKS[f]).join(', '));
  ok(!/\bstartingCashAmount\s*\(/.test(read('server.js')), 'server.js does not call startingCashAmount');
  ok(/INTERNAL WALK SEED ONLY[\s\S]{0,200}function startingCashAmount\(/.test(read('public/forecast.js')),
    'startingCashAmount carries the internal-seed-only marker');
  // The check can fail: a page call is detected.
  ok(/\bstartingCashAmount\s*\(/.test('val: money(Forecast.startingCashAmount(plan))'),
    'the detector matches a page-style call');
}

console.log(failures ? `\n${failures} FAILED` : '\nAll unknown-chequing-opening spendable checks passed.');
process.exit(failures ? 1 : 0);
