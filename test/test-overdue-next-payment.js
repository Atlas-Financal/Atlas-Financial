'use strict';
/* An unpaid or unverified past-due outflow that the cash walk still deducts
 * today is shown by the "next payment" lookups as due TODAY and overdue —
 * never skipped, and never as a confirmed later payment.
 *
 * Before this fix Forecast.nextPaymentOut, Forecast.nextDue and the
 * creditAccounts next-payment lookup skipped every event dated before
 * as-of, while onceOutflowDates / carriedUnresolvedJointCashOutflows kept
 * the same event on the walk and deducted it at as-of. Two invented worlds:
 *
 *   1. A one-off levy of 700 due Oct 12 is unpaid; as-of Oct 14. The walk
 *      takes it out of today's 2,500 (leaving 1,800), but the Plan tile
 *      said "Next cash-out total $60 — Invented internet, Oct 28".
 *   2. A card minimum of 50, monthly on the 12th, is unpaid. The Credit
 *      page said "Minimum payment $50.00 CONFIRMED · due November 12",
 *      exactly what it says when the October minimum WAS paid.
 *
 * Every expected value below is written by hand from those invented
 * inputs. The path is production's: an invented canonical document dated
 * at the previous opening (Oct 9), an invented raw Lunch Money payload,
 * scripts/live-plan.js fromObservation (which advances the opening to
 * Oct 14 with priorAsOf Oct 9, as server.js serves it), then the real
 * public/plan.js tile builder and public/credit.js renderer in a vm.
 * Each world has a paid twin, so the overdue answer cannot be produced
 * by always pointing at as-of.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const Live = require('../scripts/live-plan.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const strip = html => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const PRIOR = '2026-10-09';
const AS_OF = '2026-10-14';
// An advancing live overlay requires fresh posted evidence for both
// household chequing accounts and Savings. 2,000 + 500 + 0 = 2,500.
const ACCOUNTS = [
  { id: 'chequing-a', providerId: 7101, role: 'household-cash', label: 'Invented bills chequing', value: 2000 },
  { id: 'chequing-b', providerId: 7102, role: 'household-cash', label: 'Invented spending chequing', value: 500 },
  { id: 'savings', providerId: 7103, role: 'household-cash', label: 'Invented savings', value: 0 },
];

function lm(id, date, amount, payee, category) {
  return { id, date, amount: amount.toFixed(2), currency: 'cad', payee, original_name: payee.toUpperCase(),
    notes: null, category_id: category, plaid_account_id: 7101, is_pending: false, status: 'cleared', tags: [] };
}

// world: { bills, obligations, debts, transactions, rules }
function served(world) {
  const plan = {
    windowDays: 45,
    opening: { asOf: PRIOR, representedEvents: [] },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    startingCash: { breakdown: ACCOUNTS.map(a => ({ id: a.id, label: a.label, value: a.value, evidenceDate: PRIOR, confidence: 'confirmed' })) },
    income: [],
    bills: world.bills || [],
    obligations: world.obligations || [],
    commitments: [],
    groups: [],
    funding: { options: [] },
    budget: { categories: [] },
  };
  const data = { meta: { asOf: PRIOR, title: 'Invented household' }, accounts: [], debts: world.debts || [], revolvingExtra: [], plan };
  const payload = {
    categories: [{ id: 201, name: 'Utilities' }, { id: 202, name: 'Card payment' }],
    tags: [],
    plaid_accounts: ACCOUNTS.map(a => ({ id: a.providerId, name: a.label, type: 'depository', balance: String(a.value),
      currency: 'cad', balance_last_update: AS_OF + 'T12:00:00.000Z' })),
    transactions: world.transactions || [],
    transactionWindow: { startDate: '2026-09-01', endDate: AS_OF, complete: true, hasMore: false },
    pendingCoverage: { basis: 'is_pending-unbounded', complete: true, hasMore: false },
    fetchedAt: AS_OF + 'T18:00:00.000Z',
  };
  const accountMap = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'test',
    mappings: ACCOUNTS.map(a => ({ providerAccountId: String(a.providerId), atlasRole: a.role, canonical: { id: a.id, collection: 'cash' } })) };
  const identity = { rules: (world.rules || []).map(r => ({ atlasAccountId: 'chequing-a', direction: 'debit', ...r })) };
  return Live.fromObservation({ data, payload, accountMap, identity }).data;
}

// The real plan.js tile builder, loaded the way the browser loads it.
function planTiles() {
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = context;
  context.matchMedia = () => ({ matches: false, addEventListener() {} });
  vm.runInContext(read('public/app.js'), context);
  vm.runInContext('App.boot=()=>{};', context);
  for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(read(`public/${name}.js`), context);
  return (data) => {
    const plan = data.plan;
    context.__plan = plan;
    context.__asOf = plan.opening.asOf;
    context.__sim = F.simulate(plan, plan.opening.asOf, {});
    const tiles = vm.runInContext('currentOperatingCashHeroTiles(__plan, __asOf, __sim, {}, null)', context);
    return { tiles: JSON.parse(JSON.stringify(tiles)), sim: context.__sim };
  };
}

// The real credit.js renderer (same loader as test-credit-page.js).
function creditPage() {
  const appSrc = read('public/app.js');
  const grab = re => { const m = re.exec(appSrc); if (!m) throw new Error('missing ' + re); return m[0]; };
  const helpers = [
    grab(/^const money = .*$/m), grab(/^const money2 = .*$/m), grab(/^const pct = .*$/m),
    grab(/^const fmtDate = .*$/m), grab(/^const fmtDateLong = .*$/m), grab(/^const fmtDateFull = .*$/m),
  ].join('\n');
  const elements = {};
  const ctx = { Forecast: F, console, elements,
    App: { hooks: [], register(fn) { this.hooks.push(fn); }, boot() {} } };
  vm.runInNewContext(`${helpers}\nconst $ = id => elements[id] || (elements[id] = { innerHTML: '', textContent: '' });\n${read('public/credit.js')}`,
    ctx, { filename: 'public/credit.js' });
  return data => {
    for (const k of Object.keys(elements)) delete elements[k];
    for (const fn of ctx.App.hooks) fn(data, null, null);
    return elements;
  };
}
const fact = (html, name) => {
  const m = new RegExp(`<div class="credit-fact" data-credit-fact="${name}"[^>]*>[\\s\\S]*?</div>`).exec(html);
  return m ? m[0] : '';
};

const tilesOf = planTiles();
const renderCredit = creditPage();
const cashOut = tiles => tiles.find(t => t.lab === 'Next cash-out total') || null;

/* ---------------------------------------------------------- world 1 */
const LEVY = { id: 'levy', label: 'Invented levy', amount: 700, frequency: 'once', date: '2026-10-12', confidence: 'confirmed', payingAccount: 'chequing-a' };
const NET = { id: 'net', label: 'Invented internet', amount: 60, frequency: 'monthly', day: 28, confidence: 'confirmed', payingAccount: 'chequing-a' };
const levyRules = [{ eventId: 'levy', payeePattern: 'Invented strata' }, { eventId: 'net', payeePattern: 'Invented net co' }];

console.log('=== 1. Unpaid one-off levy (700, due Oct 12), as-of Oct 14 ===');
{
  const data = served({ bills: [LEVY, NET], rules: levyRules });
  ok(data.plan.opening.asOf === AS_OF && data.plan.opening.priorAsOf === PRIOR,
    'the served opening advanced Oct 9 → Oct 14 (production shape)', JSON.stringify(data.plan.opening.priorAsOf));
  const { tiles, sim } = tilesOf(data);
  // Hand: opening 2,500 − levy 700 = 1,800 today. The walk deducts it.
  ok(sim.daily[0].date === AS_OF && sim.daily[0].balance === 1800, 'the walk deducts the levy today: 2,500 − 700 = 1,800',
    JSON.stringify(sim.daily[0]));
  const t = cashOut(tiles);
  ok(t && t.val === '$700', 'Next cash-out total is $700 (the levy), not $60', t && t.val);
  ok(t && /Invented levy/.test(t.note) && /overdue since/i.test(t.note) && /October 12/.test(t.note),
    'the tile names the levy as overdue since Oct 12', t && t.note);
  ok(t && /to confirm/i.test(t.note), 'the tile says it is still to confirm', t && t.note);
  ok(t && !/Invented internet/.test(t.note) && !/October 28/.test(t.note), 'the tile does not point at the Oct 28 internet bill');
  const out = F.nextPaymentOut(sim.events, AS_OF);
  ok(out && out.date === AS_OF && out.daysUntil === 0 && out.amount === 700 && out.overdueCount === 1 && out.overdueSince === '2026-10-12',
    'nextPaymentOut: due today, 700, one overdue since Oct 12', JSON.stringify(out));
  const due = F.nextDue(sim.events, AS_OF);
  ok(due && due.due === AS_OF && due.what === 'Invented levy' && due.amount === 700 && due.overdue === true && due.scheduledDate === '2026-10-12',
    'nextDue: the levy, due today, overdue from Oct 12', JSON.stringify(due));
}

console.log('\n=== 1b. Same world, levy paid on Oct 12 ===');
{
  const data = served({ bills: [LEVY, NET], rules: levyRules,
    transactions: [lm(801, '2026-10-12', 700, 'Invented strata', 201)] });
  const { tiles, sim } = tilesOf(data);
  // Hand: paid before the observation, so the 2,500 opening already
  // excludes it; nothing leaves until internet 60 on Oct 28 (14 days).
  ok(sim.daily[0].balance === 2500, 'the walk no longer deducts the paid levy', JSON.stringify(sim.daily[0]));
  const t = cashOut(tiles);
  ok(t && t.val === '$60' && /Invented internet/.test(t.note) && /October 28/.test(t.note) && !/overdue/i.test(t.note),
    'Next cash-out total is $60 internet on Oct 28, not overdue', t && `${t.val} ${t.note}`);
  const due = F.nextDue(sim.events, AS_OF);
  ok(due && due.due === '2026-10-28' && due.daysUntil === 14 && !due.overdue, 'nextDue: internet, Oct 28, 14 days', JSON.stringify(due));
}

/* ---------------------------------------------------------- world 2 */
const DEBT = { id: 'card-a', label: 'Invented card', secured: false, balance: 1000, pending: 0, pendingUnknown: false, limit: 3000,
  rate: 20, payment: 50, frequency: 'Monthly minimum', confidence: 'verified', structure: 'Revolving' };
const MIN = { id: 'card-a-min', debtId: 'card-a', effect: 'payment', label: 'Invented card minimum', frequency: 'monthly', day: 12,
  amount: 50, confidence: 'confirmed', payingAccount: 'chequing-a' };
const minRules = [{ eventId: 'card-a-min', payeePattern: 'Invented card co' }];

console.log('\n=== 2. Unpaid card minimum (50 on the 12th), as-of Oct 14 ===');
{
  const data = served({ debts: [DEBT], obligations: [MIN], rules: minRules });
  ok(data.plan.opening.priorAsOf === PRIOR, 'served opening carries priorAsOf Oct 9');
  const { sim } = tilesOf(data);
  ok(sim.daily[0].balance === 2450, 'the walk deducts the Oct 12 minimum today: 2,500 − 50 = 2,450', JSON.stringify(sim.daily[0]));
  const el = renderCredit(data);
  const card = el['credit-cards'].innerHTML;
  const minimum = fact(card, 'minimum');
  const dueFact = fact(card, 'due');
  ok(/\$50\.00/.test(minimum), 'Minimum payment prints $50.00', strip(minimum));
  ok(!/CONFIRMED/.test(strip(minimum)), 'the minimum is NOT labelled confirmed', strip(minimum));
  ok(/OVERDUE/.test(strip(minimum)) && /TO CONFIRM/.test(strip(minimum)), 'it is labelled overdue · to confirm', strip(minimum));
  ok(/Overdue/.test(strip(dueFact)) && /October 12/.test(strip(dueFact)) && !/November 12/.test(strip(dueFact)),
    'the due date reads overdue, due October 12 — not November 12', strip(dueFact));
  const row = F.creditAccounts(data.plan, data.debts, AS_OF, {}).cards[0];
  ok(row.nextPayment && row.nextPayment.date === AS_OF && row.nextPayment.overdue === true
    && row.nextPayment.overdueSince === '2026-10-12' && row.nextPayment.paymentStatus === 'to-confirm',
    'creditAccounts: due today, overdue since Oct 12, to confirm', JSON.stringify(row.nextPayment));
  const out = F.nextPaymentOut(sim.events, AS_OF);
  ok(out && out.date === AS_OF && out.amount === 50 && out.overdueCount === 1, 'nextPaymentOut: 50 leaves today, overdue', JSON.stringify(out));
}

console.log('\n=== 2b. Same world, October minimum settled ===');
{
  // A settled recurring occurrence is encoded as firstDue on the row
  // (see onceOutflowDates' header): the next owed minimum is Nov 12.
  const data = served({ debts: [DEBT], obligations: [{ ...MIN, firstDue: '2026-11-12' }], rules: minRules });
  const { sim } = tilesOf(data);
  ok(sim.daily[0].balance === 2500, 'the walk no longer deducts the paid minimum', JSON.stringify(sim.daily[0]));
  const card = renderCredit(data)['credit-cards'].innerHTML;
  ok(/CONFIRMED/.test(strip(fact(card, 'minimum'))) && !/OVERDUE/.test(strip(fact(card, 'minimum'))),
    'the next minimum is the confirmed November one', strip(fact(card, 'minimum')));
  ok(/November 12/.test(strip(fact(card, 'due'))) && !/Overdue/.test(strip(fact(card, 'due'))),
    'due November 12, not overdue', strip(fact(card, 'due')));
}

console.log('\n=== 3. Not carried by the walk: still skipped ===');
{
  // A non-cash once charge before as-of is never on the walk; a future
  // inflow is not a payment. Hand: next cash-out is internet 60 on Oct 28.
  const events = [
    { id: 'old-noncash', date: '2026-10-12', amount: -40, kind: 'noncash', label: 'Invented interest' },
    { id: 'old-external', date: '2026-10-12', amount: -30, kind: 'bill', jointCash: false, label: 'Invented external' },
    { id: 'pay', date: '2026-10-23', amount: 900, kind: 'income', label: 'Invented pay' },
    { id: 'net', date: '2026-10-28', amount: -60, kind: 'bill', label: 'Invented internet' },
  ];
  const out = F.nextPaymentOut(events, AS_OF);
  ok(out && out.date === '2026-10-28' && out.amount === 60 && !out.overdueCount, 'nextPaymentOut skips what the walk does not carry', JSON.stringify(out));
  const due = F.nextDue(events, AS_OF);
  ok(due && due.due === '2026-10-28' && !due.overdue, 'nextDue skips what the walk does not carry', JSON.stringify(due));
}

console.log('\n=== 4. A past-due minimum already sent: paid, not overdue ===');
{
  // The Oct 12 minimum of 50 was sent Oct 11 (a validated posted
  // minimum-intent payment). The walk deducts $0 for it, so it is not
  // carried: the next cash-out is internet 60 on Oct 28, and the Credit
  // page's next minimum is November 12 — not "overdue, to confirm", and
  // not a $0 cash-out today.
  const plan = { windowDays: 45, opening: { asOf: AS_OF, priorAsOf: PRIOR, representedEvents: [] },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented chequing', value: 2500, confidence: 'confirmed' }] },
    income: [], bills: [NET], commitments: [],
    obligations: [{ ...MIN, sentPayments: [{ scheduledDate: '2026-10-12', confirmed: true, intent: 'minimum', debitId: 'invented-debit',
      postedOn: '2026-10-11', amount: 50, currency: 'cad', fundingAccountId: 'chequing-a', pending: false, cashIncludedAsOf: AS_OF }] }] };
  const sim = F.simulate(plan, AS_OF, {});
  const out = F.nextPaymentOut(sim.events, AS_OF);
  ok(out && out.date === '2026-10-28' && out.amount === 60 && !out.overdueCount,
    'nextPaymentOut: internet 60 on Oct 28, the sent minimum is not a $0 overdue cash-out', JSON.stringify(out));
  const row = F.creditAccounts(plan, [DEBT], AS_OF, {}).cards[0];
  ok(row.nextPayment && row.nextPayment.date === '2026-11-12' && !row.nextPayment.overdue,
    'creditAccounts: next minimum November 12, not overdue', JSON.stringify(row.nextPayment));
  const card = renderCredit({ meta: { asOf: AS_OF }, debts: [DEBT], revolvingExtra: [], plan })['credit-cards'].innerHTML;
  ok(!/OVERDUE/.test(strip(fact(card, 'minimum'))) && /November 12/.test(strip(fact(card, 'due'))),
    'the Credit page does not call the sent minimum overdue', strip(fact(card, 'minimum')) + ' / ' + strip(fact(card, 'due')));
}

console.log('\n=== 5. A past-due minimum the card ledger covered: paid, not overdue ===');
{
  // Shared invented card-coverage world (test/fixtures/card-coverage-aggregate-world.js):
  // a 25 card minimum due Sep 19, as-of Sep 20. Twin A: unpaid, still owed.
  // Twin B: a posted 25 card payment on Sep 19 covers it (card ledger
  // minimumCoverage). The Credit page reads the served /data.json, live
  // overlay applied, the same evidence the Plan walk reads.
  const { world, run } = require('./fixtures/card-coverage-aggregate-world');
  const purchase = ['card', 80, '2026-09-19', 'purchase'];
  const pay = [['bills', 25, '2026-09-19', 'cash'], ['card', -25, '2026-09-19', 'credit']];
  const minimumFact = data => fact(renderCredit(data)['credit-cards'].innerHTML + renderCredit(data)['credit-secured'].innerHTML, 'minimum');
  const unpaid = run(world([purchase], { minimumDate: '2026-09-19' }));
  ok(/OVERDUE/.test(strip(minimumFact(unpaid.observed.data))), 'unpaid twin: the Sep 19 minimum is overdue · to confirm',
    strip(minimumFact(unpaid.observed.data)));
  const covered = run(world([purchase, ...pay], { minimumDate: '2026-09-19' }));
  ok(covered.coverage.minimumCoverage[0].status === 'covered-by-payment', 'precondition: the card ledger covers the minimum',
    covered.coverage.minimumCoverage[0].status);
  ok(!/OVERDUE/.test(strip(minimumFact(covered.observed.data))), 'covered twin: the Credit page does not call it overdue',
    strip(minimumFact(covered.observed.data)));
  const d = covered.observed.data;
  const sim = F.simulate(d.plan, '2026-09-20', { debts: d.debts, currentPeriodActuals: d.liveOverlay.currentPeriodActuals });
  const out = F.nextPaymentOut(sim.events, '2026-09-20');
  ok(!(out && out.overdueCount), 'covered twin: the walk carries no overdue cash-out', JSON.stringify(out));
}

console.log('\n=== 6. A carried capitalising-facility cash minimum: overdue on Credit too ===');
{
  // Atlas finding on 72fbd26. An invented HELOC whose interest capitalises
  // (non-cash) and whose household cash minimum is 40 on the 12th,
  // confirmed. Opening advanced Oct 9 -> Oct 14, no payment evidence: the
  // walk deducts the Oct 12 cash minimum today (2,500 - 40 = 2,460). The
  // Credit page's "Household cash minimum" must say overdue / to confirm,
  // due Oct 12 — not CONFIRMED, due November 12. Settled twin: the October
  // cash minimum encoded as settled (cashFirstDue Nov 12) reads CONFIRMED,
  // November 12, and the walk deducts nothing today.
  const HELOC = { id: 'heloc', label: 'Invented HELOC', secured: true, balance: 20000, pending: 0, pendingUnknown: false,
    limit: 30000, rate: 6, interestTreatment: 'capitalised', monthlyInterest: 100, confidence: 'verified' };
  const capPlan = cashFirstDue => ({ windowDays: 45, opening: { asOf: AS_OF, priorAsOf: PRIOR, representedEvents: [] },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented chequing', value: 2500, confidence: 'confirmed' }] },
    income: [], bills: [], commitments: [],
    obligations: [{ id: 'heloc', debtId: 'heloc', effect: 'capitalise', label: 'Invented HELOC interest', frequency: 'monthly',
      day: 31, amount: 100, confidence: 'confirmed', nonCash: true, payingAccount: 'chequing-a',
      cashPayment: 40, cashDay: 12, cashLabel: 'Invented HELOC minimum', cashConfidence: 'confirmed',
      ...(cashFirstDue ? { cashFirstDue } : {}) }] });
  const page = plan => renderCredit({ meta: { asOf: AS_OF }, debts: [HELOC], revolvingExtra: [], plan })['credit-secured'].innerHTML;

  const unpaid = capPlan(null);
  const sim = F.simulate(unpaid, AS_OF, {});
  ok(sim.daily[0].balance === 2460, 'unpaid: the walk deducts the Oct 12 cash minimum today, 2,500 - 40 = 2,460', JSON.stringify(sim.daily[0]));
  const row = F.creditAccounts(unpaid, [HELOC], AS_OF, {}).secured[0];
  ok(row.nextCashMinimum && row.nextCashMinimum.date === AS_OF && row.nextCashMinimum.amount === 40
    && row.nextCashMinimum.overdue === true && row.nextCashMinimum.overdueSince === '2026-10-12'
    && row.nextCashMinimum.paymentStatus === 'to-confirm',
    'unpaid: creditAccounts.nextCashMinimum is due today, overdue since Oct 12, to confirm', JSON.stringify(row.nextCashMinimum));
  const html = page(unpaid);
  ok(!/CONFIRMED/.test(strip(fact(html, 'cash-minimum'))) && /OVERDUE/.test(strip(fact(html, 'cash-minimum')))
    && /TO CONFIRM/.test(strip(fact(html, 'cash-minimum'))),
    'unpaid: the Credit page cash minimum reads OVERDUE · TO CONFIRM, not CONFIRMED', strip(fact(html, 'cash-minimum')));
  ok(/October 12/.test(strip(fact(html, 'cash-minimum-due'))) && !/November 12/.test(strip(fact(html, 'cash-minimum-due'))),
    'unpaid: cash minimum due reads October 12, not November 12', strip(fact(html, 'cash-minimum-due')));
  ok(/data-credit-noncash="true"/.test(html), 'capitalised interest stays non-cash on the page');

  const settled = capPlan('2026-11-12');
  ok(F.simulate(settled, AS_OF, {}).daily[0].balance === 2500, 'settled: the walk deducts nothing today');
  const shtml = page(settled);
  ok(/CONFIRMED/.test(strip(fact(shtml, 'cash-minimum'))) && !/OVERDUE/.test(strip(fact(shtml, 'cash-minimum')))
    && /November 12/.test(strip(fact(shtml, 'cash-minimum-due'))),
    'settled: CONFIRMED, due November 12, not overdue', strip(fact(shtml, 'cash-minimum')) + ' / ' + strip(fact(shtml, 'cash-minimum-due')));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall overdue next-payment checks pass');
process.exit(failures ? 1 : 0);
