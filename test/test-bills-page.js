'use strict';
/* Bills page — "What recurring household bills does the household carry?"
 * `node test/test-bills-page.js`
 *
 * The page renders Forecast.householdBills on the served /data.json. This
 * suite runs the real bills.js in a vm with the real app.js formatters and a
 * stub App, then reads the HTML the household would read. Behaviour uses a
 * synthetic fixture with hand-computed expectations; the live data.json is
 * reconciled by independent arithmetic on the published plan.bills rows, not
 * by treating Forecast.householdBills as the specification.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const round2 = v => Math.round(Number(v) * 100) / 100;
const money2 = n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const longDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-CA', { day: 'numeric', month: 'long', year: 'numeric' });
const strip = html => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function loadPage(script) {
  const appSrc = read('public/app.js');
  const grab = re => { const m = re.exec(appSrc); if (!m) throw new Error('missing ' + re); return m[0]; };
  const helpers = [
    grab(/^const money = .*$/m), grab(/^const money2 = .*$/m), grab(/^const escapeHtml = .*$/m), grab(/^const pct = .*$/m),
    grab(/^const fmtDate = .*$/m), grab(/^const fmtDateLong = .*$/m), grab(/^const fmtDateFull = .*$/m),
  ].join('\n');
  const elements = {};
  const ctx = {
    Forecast: F, console,
    elements,
    App: { hooks: [], bootOpts: null, register(fn) { this.hooks.push(fn); }, boot(opts) { this.bootOpts = opts || {}; } },
  };
  vm.runInNewContext(
    `${helpers}\nconst $ = id => elements[id] || (elements[id] = { innerHTML: '', textContent: '' });\n${read(script)}`,
    ctx, { filename: script });
  return {
    ctx,
    render(data, periods) {
      for (const k of Object.keys(elements)) delete elements[k];
      for (const fn of ctx.App.hooks) fn(data, periods || null, null);
      return elements;
    },
  };
}

function rowHtml(html, id) {
  const re = new RegExp(`<article class="fact-card"[^>]*data-bill-id="${id}"[\\s\\S]*?<\\/article>`);
  const m = re.exec(html);
  return m ? m[0] : null;
}
function fact(row, name) {
  const re = new RegExp(`<div[^>]*data-bills-fact="${name}"[^>]*>[\\s\\S]*?<\\/div>`);
  const m = re.exec(row || '');
  return m ? m[0] : null;
}
const ids = html => [...String(html || '').matchAll(/data-bill-id="([^"]+)"/g)].map(m => m[1]);

function independentMonthly(bill) {
  if (!bill || bill.amount == null || !isFinite(Number(bill.amount))) return null;
  if (bill.frequency === 'monthly') return round2(bill.amount);
  if (bill.frequency === 'biweekly') return round2(bill.amount * 26 / 12);
  if (bill.frequency === 'quarterly') return round2(bill.amount / 3);
  if (bill.frequency === 'yearly') return round2(bill.amount / 12);
  return null;
}

function isOccurrenceStub(plan, bill) {
  if (!bill || bill.frequency !== 'once' || !bill.id) return false;
  return ((plan && plan.bills) || []).some(rec =>
    rec && rec.id && rec.frequency !== 'once' && rec.day != null
    && rec.id !== bill.id && bill.id.startsWith(rec.id + '-'));
}

function independentSubscription(bill) {
  if (!bill) return false;
  if (bill.subscription === true) return true;
  if (bill.subscription === false) return false;
  return bill.budgetCategory === 'subscriptions';
}

function independentRoster(plan) {
  return ((plan && plan.bills) || []).filter(bill =>
    bill
    && bill.householdObligation !== false
    && !independentSubscription(bill)
    && !isOccurrenceStub(plan, bill));
}

function nextMonthlyDay(day, asOf, firstDue) {
  const [y0, m0] = String(asOf).split('-').map(Number);
  let y = y0;
  let m = m0;
  for (let i = 0; i < 24; i++) {
    const dim = new Date(y, m, 0).getDate();
    const d = Math.min(day, dim);
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (iso >= asOf && (!firstDue || iso >= firstDue)) return iso;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return null;
}

function nextBiweekly(anchor, asOf) {
  const addDays = (iso, n) => {
    const dt = new Date(iso + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  };
  const diff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  let t = anchor;
  while (diff(asOf, t) > 0) t = addDays(t, -14);
  while (t < asOf) t = addDays(t, 14);
  return t;
}

const AS_OF = '2026-08-19';
function fixture() {
  return {
    meta: { asOf: AS_OF },
    plan: {
      windowDays: 91,
      defaults: { scenario: 'expected', targetBuffer: 0, extraDebtMonthly: 0 },
      opening: { asOf: AS_OF },
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'Chequing A', value: 5000 }] },
      income: [],
      obligations: [],
      commitments: [],
      bills: [
        { id: 'gas', label: 'Utility gas', frequency: 'monthly', day: 3, amount: 124,
          confidence: 'confirmed', budgetCategory: 'household', payingAccount: 'chequing-a' },
        { id: 'power', label: 'Utility power — dated due', frequency: 'once', date: '2026-09-01',
          amount: 237.45, confidence: 'confirmed', householdObligation: true, payingAccount: 'chequing-a' },
        { id: 'net', label: 'Internet', frequency: 'monthly', day: 14, amount: 78.4,
          confidence: 'confirmed', budgetCategory: 'telecom', payingAccount: 'chequing-a' },
        { id: 'phone', label: 'Phone', frequency: 'monthly', day: 15, amount: 121,
          confidence: 'estimated', budgetCategory: 'telecom', payingAccount: 'travelvisa', jointCash: false },
        { id: 'garbage', label: 'Garbage', frequency: 'quarterly', day: 18, anchor: '2026-03-18',
          firstDue: '2026-09-18', amount: 95.85, confidence: 'confirmed', budgetCategory: 'household' },
        { id: 'gym', label: 'Gym', frequency: 'biweekly', anchor: '2026-08-14', amount: 11.54,
          confidence: 'confirmed', budgetCategory: 'sport' },
        { id: 'club', label: 'Club membership', frequency: 'monthly', day: 10, amount: 20,
          confidence: 'confirmed', budgetCategory: 'sport', subscription: true },
        { id: 'annual-fee', label: 'Annual club', frequency: 'yearly', month: 5, day: 8, amount: 120,
          confidence: 'confirmed', budgetCategory: 'household' },
        { id: 'stream', label: 'Streaming', frequency: 'monthly', day: 17, amount: 26.87,
          confidence: 'confirmed', budgetCategory: 'subscriptions' },
        { id: 'gas-aug3-outstanding', label: 'Utility gas — August posting unknown',
          frequency: 'once', date: '2026-08-16', amount: 124, confidence: 'confirmed',
          budgetCategory: 'household' },
        { id: 'once-past', label: 'Past dated due', frequency: 'once', date: '2026-08-10',
          amount: 50, confidence: 'confirmed' },
        { id: 'mystery', label: 'Uncadenced bill', amount: 40, confidence: 'estimated' },
      ],
    },
  };
}

const page = loadPage('public/bills.js');

console.log('=== 1. Roster is household bills, not subscriptions or occurrence stubs ===');
{
  const fx = fixture();
  const view = F.householdBills(fx.plan, AS_OF);
  const got = view.bills.map(r => r.id);
  const expectIds = ['gas', 'power', 'net', 'phone', 'garbage', 'gym', 'annual-fee', 'once-past', 'mystery'];
  ok(expectIds.every(id => got.includes(id)), 'fixture roster includes the household bills', got.join(','));
  ok(!got.includes('stream'), 'subscription budgetCategory is not on the Bills roster');
  ok(!got.includes('club'),
    'explicit subscription stays off Bills even when spending category is not subscriptions');
  ok(got.includes('gym'),
    'a sport-category bill without subscription: true is not excluded as a membership');
  ok(!got.includes('gas-aug3-outstanding'), 'once stub of a recurring sibling is not a second bill');
  const el = page.render(fx);
  const html = el['bills-list'].innerHTML;
  ok(!/Streaming|stream/.test(html), 'page does not print the subscription');
  ok(!/Club membership/.test(html),
    'page does not print a membership whose spending category is sport');
  ok(!/August posting unknown/.test(html), 'page does not print the occurrence stub');
  ok(/Utility gas/.test(html) && /Utility power/.test(html) && /Garbage/.test(html),
    'page prints the household utility and quarterly rows');
}

console.log('\n=== 2. Cadence is preserved; monthly-equivalent is derived only when authorised ===');
{
  const fx = fixture();
  const view = F.householdBills(fx.plan, AS_OF);
  const byId = Object.fromEntries(view.bills.map(r => [r.id, r]));
  ok(byId.gas.frequency === 'monthly' && byId.gas.frequencyLabel === 'Monthly'
    && near(byId.gas.monthlyEquivalent, 124),
    'monthly bill keeps monthly cadence and uses the amount as monthly equivalent');
  ok(byId.garbage.frequency === 'quarterly' && byId.garbage.frequencyLabel === 'Every 3 months'
    && near(byId.garbage.monthlyEquivalent, round2(95.85 / 3)),
    'quarterly bill stays quarterly; monthly equivalent is amount / 3', String(byId.garbage.monthlyEquivalent));
  ok(byId.gym.frequency === 'biweekly' && byId.gym.frequencyLabel === 'Every 2 weeks'
    && near(byId.gym.monthlyEquivalent, round2(11.54 * 26 / 12)),
    'biweekly bill stays every 2 weeks; monthly equivalent is amount × 26 / 12');
  ok(byId['annual-fee'].frequency === 'yearly' && byId['annual-fee'].frequencyLabel === 'Yearly'
    && near(byId['annual-fee'].monthlyEquivalent, round2(120 / 12)),
    'yearly bill stays yearly; monthly equivalent is amount / 12');
  ok(byId.power.frequency === 'once' && byId.power.frequencyLabel === 'Dated due'
    && byId.power.monthlyEquivalent == null
    && /not on the plan/.test(byId.power.cadenceNote || ''),
    'once utility is a dated due with no invented monthly equivalent');
  ok(byId.mystery.frequency == null && byId.mystery.monthlyEquivalent == null,
    'missing cadence is unknown, not monthly');
  const el = page.render(fx);
  const html = el['bills-list'].innerHTML;
  const garbage = rowHtml(html, 'garbage');
  const power = rowHtml(html, 'power');
  ok(garbage && /Every 3 months/.test(garbage) && !/Monthly/.test(strip(fact(garbage, 'cadence'))),
    'page does not relabel the quarterly bill as monthly');
  ok(power && /Dated due/.test(power) && /Unknown/.test(fact(power, 'monthly'))
    && /Recurring cadence is not on the plan/.test(power),
    'page prints the once utility as dated due with Unknown monthly equivalent');
  ok(!/PAID|UNPAID|OVERDUE/.test(html),
    'page does not infer paid/unpaid state from a passed date');
}

console.log('\n=== 3. Next dates are the schedule, including a passed once due ===');
{
  const fx = fixture();
  const view = F.householdBills(fx.plan, AS_OF);
  const byId = Object.fromEntries(view.bills.map(r => [r.id, r]));
  ok(byId.gas.nextDate === nextMonthlyDay(3, AS_OF),
    'monthly next date is the next day-of-month on or after as-of', byId.gas.nextDate);
  ok(byId.net.nextDate === nextMonthlyDay(14, AS_OF), 'internet next date is 14 September');
  ok(byId.phone.nextDate === nextMonthlyDay(15, AS_OF), 'phone next date is 15 September');
  ok(byId.garbage.nextDate === '2026-09-18', 'quarterly next date is firstDue, not invented as monthly');
  ok(byId.gym.nextDate === nextBiweekly('2026-08-14', AS_OF),
    'biweekly next date walks the 14-day anchor', byId.gym.nextDate);
  ok(byId.power.nextDate === '2026-09-01', 'once future due keeps its scheduled date');
  ok(byId['once-past'].nextDate === '2026-08-10',
    'passed once due keeps its scheduled date; as-of is not settlement');
  const el = page.render(fx);
  const html = el['bills-list'].innerHTML;
  ok(strip(fact(rowHtml(html, 'once-past'), 'next')).includes(longDate('2026-08-10')),
    'page still prints the passed once date');
}

console.log('\n=== 4. Monthly total is the sum of known equivalents, not page constants ===');
{
  const fx = fixture();
  const roster = independentRoster(fx.plan);
  const expectedTotal = round2(roster.reduce((s, b) => {
    const m = independentMonthly(b);
    return m == null ? s : s + m;
  }, 0));
  const view = F.householdBills(fx.plan, AS_OF);
  ok(near(view.monthlyEquivalentTotal, expectedTotal),
    'Forecast total matches independent 26/12, /3, /12 arithmetic',
    `${view.monthlyEquivalentTotal} vs ${expectedTotal}`);
  ok(view.monthlyEquivalentExcludedCount === 3,
    'once power, passed once, and uncadenced bill are excluded from the total',
    String(view.monthlyEquivalentExcludedCount));
  const el = page.render(fx);
  const total = el['bills-total'].innerHTML;
  ok(strip(total).includes('Total monthly equivalent') && strip(total).includes(money2(expectedTotal)),
    'page prints Forecast total monthly equivalent, not a hardcoded sum');
  ok(/not the amount that will leave/.test(strip(total)),
    'page says the total is a comparison figure, not the monthly withdrawal');
  const src = stripComments(read('public/bills.js'));
  ok(!/\*\s*26\s*\/\s*12|\/\s*3|\/\s*12/.test(src),
    'bills.js does not compute a monthly equivalent');
  ok(!/budgetCategory === ['"]subscriptions['"]/.test(src),
    'bills.js does not filter the roster; Forecast does');
  ok(!/\.subscription\b/.test(src) && !/fit4less/i.test(src),
    'bills.js has no subscription classifier and no Fit4Less exception');
}

console.log('\n=== 5. Page follows a mutated amount; HTML hardcodes no figure ===');
{
  const fx = fixture();
  fx.plan.bills.find(b => b.id === 'gas').amount = 200;
  const el = page.render(fx);
  const gas = rowHtml(el['bills-list'].innerHTML, 'gas');
  ok(gas && strip(fact(gas, 'amount')).includes('$200.00')
    && strip(fact(gas, 'monthly')).includes('$200.00'),
    'changing the plan amount changes the printed amount and monthly equivalent');
  const html = read('public/bills.html');
  ok(!/\$\d|\d\.\d\d\b/.test(html.replace(/<meta[^>]*>/g, '')),
    'bills.html hardcodes no figure');
  const idsInHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  ok(['bills-lede', 'bills-list', 'bills-total', 'bills-note'].every(id => idsInHtml.has(id)),
    'bills.html has every element bills.js writes to');
  ok(/<script src="\/forecast.js"><\/script>\s*<script src="\/bills.js">/.test(html),
    'bills.html loads forecast.js before bills.js');
}

console.log('\n=== 6. Live plan.bills reconcile independently ===');
{
  const asOf = live.meta.asOf;
  const roster = independentRoster(live.plan);
  const expectedTotal = roster.reduce((s, b) => {
    const m = independentMonthly(b);
    return m == null ? s : round2(s + m);
  }, 0);
  const view = F.householdBills(live.plan, asOf);
  const viewIds = view.bills.map(r => r.id);
  ok(roster.every(b => viewIds.includes(b.id)) && viewIds.length === roster.length,
    'live roster is the non-subscription household bills minus occurrence stubs',
    viewIds.join(','));
  ok(!viewIds.some(id => /netflix|spotify|icloud|youtube|chatgpt|google-storage|ultimate-guitar/.test(id)),
    'live page authority excludes the subscription rows');
  ok(!viewIds.includes('fit4less'),
    'live Fit4Less membership stays off Bills though its spending category is sport');
  ok(!viewIds.includes('bcaa-aug15-outstanding')
    && !viewIds.includes('icbc-aug15-outstanding')
    && !viewIds.includes('resp-aug15-outstanding'),
    'live August posting-unknown stubs are not second bills');
  ok(viewIds.includes('hydro-due-sep1'), 'live Hydro dated due remains on the roster');
  ok(viewIds.includes('hydro-equal-payment'), 'live Hydro equal-payment series is on the roster');
  ok(viewIds.includes('fortis') && viewIds.includes('noble-garbage') && viewIds.includes('bell'),
    'live Fortis, Noble and Bell are on the roster');
  const hydro = view.bills.find(r => r.id === 'hydro-due-sep1');
  ok(hydro && hydro.frequency === 'once' && hydro.monthlyEquivalent == null
    && hydro.nextDate === '2026-09-01' && near(hydro.amount, 237.45),
    'live Hydro Sep. 1 stays a dated $237.45 due with no invented monthly equivalent on that once row');
  const hydroEq = view.bills.find(r => r.id === 'hydro-equal-payment');
  ok(hydroEq && hydroEq.frequency === 'monthly' && near(hydroEq.amount, 199)
    && hydroEq.nextDate === '2026-10-30' && hydroEq.confidence === 'estimated'
    && near(hydroEq.monthlyEquivalent, 199),
    'live Hydro equal-payment is monthly $199, next estimated 30 October');
  const noble = view.bills.find(r => r.id === 'noble-garbage');
  ok(noble && noble.frequency === 'quarterly' && noble.nextDate === '2026-09-18'
    && near(noble.monthlyEquivalent, round2(95.85 / 3)),
    'live Noble stays quarterly $95.85, next 18 September, monthly equivalent $31.95');
  const fortis = view.bills.find(r => r.id === 'fortis');
  ok(fortis && fortis.frequency === 'monthly' && near(fortis.amount, 124)
    && fortis.nextDate === nextMonthlyDay(3, asOf),
    'live Fortis stays monthly $124; next date is the next day 3 on or after as-of',
    fortis && fortis.nextDate);
  ok(near(view.monthlyEquivalentTotal, expectedTotal),
    'live total matches independent arithmetic on plan.bills',
    `${view.monthlyEquivalentTotal} vs ${expectedTotal}`);
  const el = page.render(live);
  const html = el['bills-list'].innerHTML + el['bills-total'].innerHTML;
  ok(strip(el['bills-total'].innerHTML).includes(money2(expectedTotal)),
    'live page prints the independently computed total');
  ok(/BC Hydro/.test(html) && /Dated due/.test(rowHtml(html, 'hydro-due-sep1') || ''),
    'live page names Hydro and keeps Dated due visible');
  ok(/Every 3 months/.test(rowHtml(html, 'noble-garbage') || ''),
    'live page keeps Noble quarterly');
  ok(!/Netflix|Spotify|YouTube|ChatGPT|iCloud|Ultimate Guitar|Google storage|Fit4Less/.test(html),
    'live page does not print subscription or membership names');
}

console.log('\n=== 7. Cards use the Credit fact-card language; page code stays presentation-only ===');
{
  const fx = fixture();
  const el = page.render(fx);
  const html = el['bills-list'].innerHTML;
  const cards = [...html.matchAll(/<article class="fact-card"/g)];
  ok(cards.length === 9, 'fixture renders one fact-card article per household bill', String(cards.length));
  ok(!/<table|<tr|<td/.test(html), 'Bills no longer renders a compact table');
  const gas = rowHtml(html, 'gas');
  ok(gas && /<div class="fact-card-head">/.test(gas) && /<h2>Utility gas<\/h2>/.test(gas)
    && /<div class="fact-card-amount" data-bills-fact="amount">/.test(gas)
    && /<dl class="fact-card-facts">/.test(gas)
    && /<dt>Cadence<\/dt>/.test(gas) && /<dt>Next due<\/dt>/.test(gas)
    && /<dt>Monthly equivalent<\/dt>/.test(gas),
    'each bill card has heading, prominent amount, and labelled facts');
  ok(/class="chip v">CONFIRMED/.test(gas), 'confidence chip stays on the card heading');
  const mystery = rowHtml(html, 'mystery');
  ok(mystery && /<span class="fact-unknown">Unknown<\/span>/.test(fact(mystery, 'cadence'))
    && /<span class="fact-unknown">Unknown<\/span>/.test(fact(mystery, 'monthly')),
    'Unknown facts stay the shared Unknown treatment');
  const src = stripComments(read('public/bills.js'));
  ok(/Forecast\.householdBills\(d\.plan, d\.meta\.asOf\)/.test(src),
    'bills.js consumes Forecast.householdBills on the served plan');
  ok(!/Forecast\.householdSubscriptions|Forecast\.billIsSubscription|Forecast\.creditAccounts/.test(src),
    'bills.js does not classify subscriptions or compose Credit');
  const creditSrc = stripComments(read('public/credit.js'));
  ok(/Forecast\.creditAccounts\(/.test(creditSrc)
    && /<article class="credit-account/.test(creditSrc)
    && /class="credit-facts"/.test(creditSrc),
    'Credit still renders Forecast.creditAccounts through credit-account cards');
  const css = read('public/styles.css');
  ok(/\.fact-card,\s*\.credit-account/.test(css)
    && /\.fact-card-facts,\s*\.credit-facts/.test(css)
    && /\.fact-unknown,\s*\.credit-unknown/.test(css),
    'shared CSS binds the fact-card vocabulary to the incumbent Credit selectors');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
