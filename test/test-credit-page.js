'use strict';
/* Credit page — "What do we owe?" `node test/test-credit-page.js`
 *
 * The page renders Forecast.creditAccounts on the served /data.json. This
 * suite runs the real credit.js in a vm with the real app.js formatters and a
 * stub App, then reads the HTML the household would read. Behaviour uses a
 * synthetic fixture with hand-computed expectations; the live data.json is
 * used only where the owner's required tests name the live accounts, and
 * there the expectation is derived from the debt inputs, not from the
 * function under test.
 *
 * The last section applies a real read-only live overlay in-process through
 * scripts/live-plan.js against a loopback provider mock with a changed card
 * balance, and proves the page prints the served balance. No canonical file
 * is written and no real token or provider id is used. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const LivePlan = require('../scripts/live-plan.js');
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

/* ---------------------------------------------------------------- harness */
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

function account(html, id) {
  const re = new RegExp(`<article class="credit-account[^"]*" data-credit-id="${id}"[\\s\\S]*?<\\/article>`);
  const m = re.exec(html);
  return m ? m[0] : null;
}
function fact(cardHtml, name) {
  const re = new RegExp(`<div class="credit-fact" data-credit-fact="${name}"[^>]*>[\\s\\S]*?<\\/div>`);
  const m = re.exec(cardHtml || '');
  return m ? m[0] : null;
}
const strip = html => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ids = html => [...String(html || '').matchAll(/data-credit-id="([^"]+)"/g)].map(m => m[1]);

/* ---------------------------------------------------------------- fixture */
// Deliberately out of display order: cards first, then HELOC, then mortgage.
const AS_OF = '2026-03-10';
function fixture() {
  return {
    meta: { asOf: AS_OF },
    revolvingExtra: [],
    debts: [
      { id: 'card-a', label: 'Card A', secured: false, balance: 4200.10, pending: 300.55, pendingUnknown: false,
        limit: 5000, rate: 21.99, rateBasis: 'Purchases 21.99%', payment: 120, frequency: 'Monthly minimum',
        nextDue: '2026-02-15', confidence: 'verified', structure: 'Revolving' },
      { id: 'card-b', label: 'Card B', secured: false, balance: 500, pendingUnknown: true,
        limit: 2000, rate: 19.99, payment: 25, frequency: 'Monthly minimum', nextDue: '2026-03-20', confidence: 'verified' },
      { id: 'card-c', label: 'Card C', secured: false, balance: 300, pending: 0, pendingUnknown: false,
        limit: null, rate: null, payment: null, confidence: 'estimated' },
      { id: 'card-over', label: 'Card Over', secured: false, balance: 1050, pending: 0, pendingUnknown: false,
        limit: 1000, rate: 24.99, payment: 10, frequency: 'Monthly minimum', nextDue: '2026-03-05', confidence: 'verified' },
      { id: 'heloc', label: 'HELOC', secured: true, balance: 90000, pending: 0, limit: 100000, rate: 4.9,
        rateBasis: 'Prime + 0.45%', payment: 400, interestTreatment: 'capitalised', cashPayment: 0,
        monthlyInterest: 400, frequency: 'Monthly interest charge — not a payment', nextDue: '2026-02-21', confidence: 'verified' },
      { id: 'mortgage', label: 'Mortgage', secured: true, balance: 500000, pending: 0, limit: null, rate: 3.64,
        rateBasis: 'Prime − 0.96%', payment: 1600, frequency: 'Bi-weekly', nextDue: '2026-03-06', confidence: 'verified',
        structure: 'Amortising' },
    ],
    plan: {
      windowDays: 91,
      defaults: { scenario: 'expected', targetBuffer: 0, extraDebtMonthly: 0 },
      opening: { asOf: AS_OF },
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'Chequing A', value: 5000 }] },
      income: [{ id: 'pay', label: 'Pay', frequency: 'biweekly', anchor: '2026-03-06', amount: 2000, confidence: 'confirmed' }],
      obligations: [
        { id: 'mortgage', debtId: 'mortgage', effect: 'payment', label: 'Mortgage', frequency: 'biweekly',
          anchor: '2026-03-06', amount: 1600, confidence: 'confirmed', payingAccount: 'chequing-a' },
        { id: 'heloc', debtId: 'heloc', effect: 'capitalise', label: 'HELOC interest', frequency: 'monthly', day: 31,
          amount: 400, confidence: 'confirmed', nonCash: true, payingAccount: 'chequing-a',
          cashPayment: 400, cashDay: 21, cashFirstDue: '2026-03-21', cashLabel: 'HELOC minimum', cashConfidence: 'estimated' },
        { id: 'card-a', debtId: 'card-a', effect: 'payment', label: 'Card A minimum', frequency: 'monthly', day: 15,
          amount: 120, confidence: 'estimated', payingAccount: 'chequing-a' },
        { id: 'card-b-mar', debtId: 'card-b', effect: 'payment', label: 'Card B — March statement minimum', frequency: 'once',
          date: '2026-03-20', amount: 25, confidence: 'confirmed', payingAccount: 'chequing-a' },
        { id: 'card-over', debtId: 'card-over', effect: 'payment', label: 'Card Over minimum', frequency: 'monthly', day: 5,
          amount: 10, confidence: 'estimated', payingAccount: 'chequing-a' },
      ],
      bills: [
        // A closed BNPL-style final instalment: a bill, not a card, and not a debt record.
        { id: 'bnpl-final', label: 'BNPL — final payment', frequency: 'once', date: '2026-03-21', amount: 32.53,
          confidence: 'confirmed', payingAccount: 'chequing-a' },
      ],
      commitments: [],
    },
  };
}

const page = loadPage('public/credit.js');

console.log('=== 1–3. Mortgage first, HELOC second, active cards underneath ===');
{
  const el = page.render(fixture());
  const secured = ids(el['credit-secured'].innerHTML);
  const cards = ids(el['credit-cards'].innerHTML);
  ok(secured[0] === 'mortgage', 'the mortgage is the first secured card', secured.join(','));
  ok(secured[1] === 'heloc', 'the HELOC is the second secured card');
  ok(secured.length === 2, 'no third secured card');
  ok(JSON.stringify(cards) === JSON.stringify(['card-a', 'card-b', 'card-c', 'card-over']),
    'the active cards follow in data order, underneath, despite the fixture listing them first', cards.join(','));
  const liveAcc = F.creditAccounts(live.plan, live.debts, live.meta.asOf, { extraFacilities: live.revolvingExtra });
  ok(liveAcc.secured.map(r => r.id).join(',') === 'mortgage,heloc',
    'live data: secured order is mortgage, heloc');
  const liveEl = page.render(live);
  const liveHtml = liveEl['credit-secured'].innerHTML + liveEl['credit-cards'].innerHTML;
  const order = ids(liveHtml);
  ok(order[0] === 'mortgage' && order[1] === 'heloc' && order.length === live.debts.length,
    'live page prints mortgage, HELOC, then every remaining debt record as a card', order.join(','));
  ok(/<h2[^>]*>Credit cards<\/h2>/.test(read('public/credit.html')), 'the cards section is headed Credit cards');
}

console.log('\n=== 4. Closed products are not active cards ===');
{
  const el = page.render(fixture());
  const html = el['credit-secured'].innerHTML + el['credit-cards'].innerHTML;
  ok(!/BNPL|bnpl-final/.test(html), 'a once bill (a BNPL final instalment) is not printed as a card');
  const liveEl = page.render(live);
  const liveHtml = liveEl['credit-secured'].innerHTML + liveEl['credit-cards'].innerHTML;
  ok(!/Flexiti|Amex|American Express|Affirm/i.test(liveHtml),
    'live page names no Flexiti, Amex or Affirm card');
  const unsecured = live.debts.filter(d => !d.secured).map(d => d.id);
  ok(JSON.stringify(ids(liveEl['credit-cards'].innerHTML)) === JSON.stringify(unsecured),
    'live cards are exactly the unsecured debt records — no hardcoded card count', unsecured.join(','));
  const src = read('public/credit.js');
  ok(!/triangle|cashback|mbna|tdcc|travelvisa|['"]heloc['"]|['"]mortgage['"]/.test(src),
    'credit.js hardcodes no debt id');
}

console.log('\n=== 5–7. Limits are canonical; available credit is Forecast.utilisation, pending included ===');
{
  const el = page.render(fixture());
  const heloc = account(el['credit-secured'].innerHTML, 'heloc');
  ok(strip(fact(heloc, 'limit')).includes('$100,000.00'), 'HELOC total credit is the canonical limit');
  // Independent arithmetic from the fixture inputs, not from Forecast.
  const helocAvail = round2(100000 - 90000 - 0);
  ok(strip(fact(heloc, 'available')).includes(money2(helocAvail)),
    `HELOC available prints ${money2(helocAvail)} = limit − posted − pending`);
  const util = F.utilisation(fixture().debts, [], fixture().plan);
  ok(near(util.rows.find(r => r.id === 'heloc').available, helocAvail),
    'and Forecast.utilisation agrees with that hand arithmetic');
  const cardA = account(el['credit-cards'].innerHTML, 'card-a');
  const cardAAvail = round2(5000 - 4200.10 - 300.55);   // 499.35
  ok(near(cardAAvail, 499.35), 'fixture card A: 5,000 − 4,200.10 − 300.55 = 499.35 by hand');
  ok(strip(fact(cardA, 'available')).includes(money2(cardAAvail)),
    'card A available includes the pending exposure', strip(fact(cardA, 'available')));
  ok(near(util.rows.find(r => r.id === 'card-a').available, cardAAvail),
    'Forecast.utilisation card A agrees with the hand arithmetic');
  ok(/\+ \$300\.55 pending, already incurred/.test(cardA), 'card A prints its non-zero pending');
  ok(!/pending/.test(strip(account(el['credit-cards'].innerHTML, 'card-over')).replace(/Over the limit/, '')),
    'a card with proven $0 pending prints no pending line');
  const cardB = account(el['credit-cards'].innerHTML, 'card-b');
  ok(/data-credit-pending-unknown="true"/.test(fact(cardB, 'available')) && /Not published/.test(fact(cardB, 'available'))
      && !/\$1,500/.test(cardB),
    'unknown pending withholds headroom — $1,500 of posted room is not printed');
  ok(/Pending not observed — not \$0/.test(cardB), 'unknown pending says so rather than $0');
  const over = account(el['credit-cards'].innerHTML, 'card-over');
  ok(/data-credit-over-limit="true"/.test(fact(over, 'available')) && /Over the limit by \$50\.00/.test(over),
    'an over-limit card says over the limit by $50.00, not simply $0 available');
  // Live: the page's HELOC available equals limit − posted − pending from the debt record.
  const liveHeloc = live.debts.find(d => d.id === 'heloc');
  const liveEl = page.render(live);
  const liveHelocCard = account(liveEl['credit-secured'].innerHTML, 'heloc');
  ok(strip(fact(liveHelocCard, 'available')).includes(money2(round2(liveHeloc.limit - liveHeloc.balance - (liveHeloc.pending || 0)))),
    'live HELOC available = canonical limit − posted − pending, computed from the record');
  ok(strip(fact(liveHelocCard, 'limit')).includes(money2(liveHeloc.limit)), 'live HELOC limit is the canonical limit');
  const src = read('public/credit.js');
  ok(!/limit\s*-|-\s*(row|d|x)\.(balance|pending|used)|\.balance\s*[-+]|Math\.max\(0/.test(src),
    'credit.js performs no headroom arithmetic of its own');
}

console.log('\n=== 8–9. Minimum and due date come from the Forecast schedule, not the stored nextDue ===');
{
  const fx = fixture();
  const el = page.render(fx);
  const mortgage = account(el['credit-secured'].innerHTML, 'mortgage');
  // Bi-weekly from 2026-03-06; as-of 2026-03-10 → next occurrence 2026-03-20.
  ok(/data-credit-due="2026-03-20"/.test(fact(mortgage, 'due')) && strip(fact(mortgage, 'due')).includes(longDate('2026-03-20')),
    'mortgage next due is the schedule occurrence 20 March, not the stale stored 6 March');
  ok(!strip(mortgage).includes(longDate('2026-03-06')), 'the stale nextDue date is not printed');
  ok(strip(fact(mortgage, 'minimum')).includes('$1,600.00'), 'mortgage next payment is the schedule amount');
  const cardA = account(el['credit-cards'].innerHTML, 'card-a');
  ok(/data-credit-due="2026-03-15"/.test(fact(cardA, 'due')), 'card A due is the monthly day-15 occurrence on/after as-of');
  ok(!strip(cardA).includes(longDate('2026-02-15')), 'card A stale February nextDue is not printed');
  ok(strip(fact(cardA, 'minimum')).includes('$120.00'), 'card A minimum is the schedule amount');
  const over = account(el['credit-cards'].innerHTML, 'card-over');
  ok(/data-credit-due="2026-04-05"/.test(fact(over, 'due')), 'a day-5 minimum whose March date has passed prints 5 April');
  const cardB = account(el['credit-cards'].innerHTML, 'card-b');
  ok(/data-credit-due="2026-03-20"/.test(fact(cardB, 'due')) && strip(fact(cardB, 'minimum')).includes('$25.00'),
    'a confirmed once statement row is the next occurrence');
  // Same schedule the Plan calendar reads: expandEvents on/after as-of.
  const events = F.expandEvents(fx.plan, AS_OF, F.knowledgeHorizon(fx.plan, AS_OF, {}).end, {});
  const firstMortgage = events.find(e => e.debtId === 'mortgage' && e.kind === 'obligation');
  ok(firstMortgage && firstMortgage.date === '2026-03-20', 'Forecast.expandEvents names the same mortgage occurrence');
  // Live: every card's printed due date equals the first expandEvents payment for that debt.
  const liveEl = page.render(live);
  const liveEvents = F.expandEvents(live.plan, live.meta.asOf, F.knowledgeHorizon(live.plan, live.meta.asOf, {}).end, {});
  let agree = true;
  for (const d of live.debts.filter(x => !x.secured)) {
    const first = liveEvents.find(e => e.debtId === d.id && e.kind === 'obligation' && e.effect === 'payment' && e.date >= live.meta.asOf);
    const card = account(liveEl['credit-cards'].innerHTML, d.id);
    const due = fact(card, 'due');
    const printed = due && /data-credit-due="([^"]+)"/.exec(due);
    if (!first || !printed || printed[1] !== first.date || !strip(fact(card, 'minimum')).includes(money2(-first.amount))) agree = false;
  }
  ok(agree, 'live: every card prints the first Forecast.expandEvents payment on/after as-of, amount and date');
  const src = read('public/credit.js');
  ok(!/nextDue/.test(src) && !/new Date\(\)|Date\.now/.test(src),
    'credit.js never reads the stored nextDue and never consults the browser clock');
}

console.log('\n=== 10–11. Estimated stays estimated; unknown stays unknown ===');
{
  const el = page.render(fixture());
  const cardA = account(el['credit-cards'].innerHTML, 'card-a');
  ok(/data-credit-confidence="estimated"/.test(fact(cardA, 'minimum')) && /≈ \$120\.00/.test(fact(cardA, 'minimum'))
      && /ESTIMATED/.test(fact(cardA, 'minimum')),
    'an estimated minimum keeps ≈ and its ESTIMATED chip');
  const cardB = account(el['credit-cards'].innerHTML, 'card-b');
  ok(/data-credit-confidence="confirmed"/.test(fact(cardB, 'minimum')) && !/≈/.test(fact(cardB, 'minimum')),
    'a confirmed minimum has no ≈');
  const cardC = account(el['credit-cards'].innerHTML, 'card-c');
  ok(/Unknown/.test(fact(cardC, 'minimum')) && /Unknown/.test(fact(cardC, 'due')),
    'no schedule occurrence → minimum and due date are Unknown');
  ok(/Unknown/.test(fact(cardC, 'rate')) && /Unknown/.test(fact(cardC, 'limit')) && /Unknown/.test(fact(cardC, 'available')),
    'no rate, no limit → rate, limit and available are Unknown');
  const text = strip(cardC);
  ok(!/\$0\.00|0\.00%|no payment due|unlimited/i.test(text),
    'unknown is never printed as $0.00, 0.00%, no payment due, or unlimited', text);
  const liveEl = page.render(live);
  const liveHtml = liveEl['credit-secured'].innerHTML + liveEl['credit-cards'].innerHTML;
  const liveEvents = F.expandEvents(live.plan, live.meta.asOf, F.knowledgeHorizon(live.plan, live.meta.asOf, {}).end, {});
  const firstByDebt = new Map();
  for (const e of liveEvents) {
    if (e.kind !== 'obligation' || e.effect !== 'payment' || e.date < live.meta.asOf || firstByDebt.has(e.debtId)) continue;
    firstByDebt.set(e.debtId, e);
  }
  const cardsLive = live.debts.filter(d => !d.secured);
  ok(cardsLive.length > 0 && cardsLive.every(d => {
    const first = firstByDebt.get(d.id);
    const min = fact(account(liveHtml, d.id), 'minimum');
    return first && new RegExp(`data-credit-confidence="${first.confidence}"`).test(min)
      && (/≈/.test(min) === (first.confidence === 'estimated'));
  }), 'live: each card\'s minimum carries the confidence of its first schedule occurrence, ≈ only when estimated');
}

console.log('\n=== Amount confirmation retains a separately estimated planning date ===');
{
  const fx = fixture();
  const statement = { scheduledDate: '2026-03-15', dueDate: '2026-03-15',
    minimum: 91.37, currency: 'cad', confidence: 'confirmed', dateConfidence: 'estimated' };
  fx.plan.obligations.find(row => row.id === 'card-a').statementOccurrences = [statement];
  const before = JSON.stringify(fx);
  const el = page.render(fx);
  const card = account(el['credit-cards'].innerHTML, 'card-a');
  const minimum = fact(card, 'minimum'), due = fact(card, 'due');
  ok(strip(minimum).includes('$91.37') && /CONFIRMED/.test(minimum) && !/ESTIMATED/.test(minimum),
    'invented confirmed minimum keeps its amount and confirmed chip');
  ok(strip(due).includes(longDate('2026-03-15')) && /ESTIMATED/.test(due),
    'actual Credit renderer visibly qualifies the separate planning date');
  ok(/data-credit-date-confidence="estimated"/.test(due),
    'due-date fact retains Forecast date trust separately from amount trust');
  ok(JSON.stringify(fx) === before, 'rendering date trust does not mutate input');
  for (const legacy of [true, false]) {
    if (legacy) delete statement.dateConfidence;
    else statement.dateConfidence = 'confirmed';
    const confirmed = account(page.render(fx)['credit-cards'].innerHTML, 'card-a');
    ok(strip(fact(confirmed, 'due')).includes(longDate('2026-03-15'))
        && !/ESTIMATED/.test(fact(confirmed, 'due')),
      `${legacy ? 'omitted legacy' : 'explicit confirmed'} date trust does not acquire an estimated qualifier`);
    ok(strip(fact(confirmed, 'minimum')).includes('$91.37') && /CONFIRMED/.test(fact(confirmed, 'minimum')),
      'confirmed statement amount remains unchanged');
  }
}

console.log('\n=== 12. HELOC capitalised interest is not a second household cash minimum ===');
{
  const fx = fixture();
  const el = page.render(fx);
  const heloc = account(el['credit-secured'].innerHTML, 'heloc');
  const cap = fact(heloc, 'capitalise');
  ok(cap && /data-credit-noncash="true"/.test(cap) && /adds to the balance; no cash leaves/.test(cap)
      && strip(cap).includes('$400.00') && strip(cap).includes(longDate('2026-03-31')),
    'the interest charge is printed as capitalising onto the balance on 31 March, no cash leaving');
  const min = fact(heloc, 'cash-minimum');
  const minDue = fact(heloc, 'cash-minimum-due');
  ok(min && /≈ \$400\.00/.test(min) && /ESTIMATED/.test(min), 'the household cash minimum is ≈ $400.00 estimated');
  ok(minDue && /data-credit-due="2026-03-21"/.test(minDue), 'the cash minimum is due 21 March (cashDay / cashFirstDue), not 31 March');
  ok((heloc.match(/data-credit-fact="cash-minimum"/g) || []).length === 1
      && !fact(heloc, 'minimum') && !fact(heloc, 'due'),
    'exactly one cash minimum; no card-style "Minimum payment" row on the HELOC');
  ok(!/Regular payment/.test(heloc), 'the HELOC prints no "Regular payment" row that would restate the interest as a payment');
  const acc = F.creditAccounts(fx.plan, fx.debts, AS_OF, {});
  const row = acc.secured.find(r => r.id === 'heloc');
  ok(row.nextPayment === null && row.nextCapitalise && row.nextCapitalise.date === '2026-03-31'
      && row.nextCashMinimum && row.nextCashMinimum.date === '2026-03-21' && near(row.nextCashMinimum.amount, 400),
    'Forecast.creditAccounts keeps capitalise and cash minimum as two facts and no payment event');
  const occ = F.capitalisingCashMinimumOccurrences(fx.plan.obligations.find(o => o.id === 'heloc'), AS_OF, '2026-06-30');
  ok(occ.map(o => o.date).join(',') === '2026-03-21,2026-04-21,2026-05-21,2026-06-21',
    'the shared cash-minimum rule yields the 21st each month from cashFirstDue');
  ok(F.capitalisingCashMinimumOccurrences({ id: 'x', nonCash: true, frequency: 'monthly', day: 31, amount: 400 }, AS_OF, '2026-06-30').length === 0,
    'a capitalising obligation with no cash minimum yields nothing');
  // Live: the same two facts, and the Plan bills list rule is the same function.
  const liveEl = page.render(live);
  const liveHeloc = account(liveEl['credit-secured'].innerHTML, 'heloc');
  const liveObl = live.plan.obligations.find(o => o.id === 'heloc');
  ok(liveHeloc && liveObl && liveObl.cashFirstDue >= live.meta.asOf
      && new RegExp(`data-credit-due="${liveObl.cashFirstDue}"`).test(fact(liveHeloc, 'cash-minimum-due'))
      && strip(fact(liveHeloc, 'cash-minimum')).includes(money2(liveObl.cashPayment)),
    `live HELOC cash minimum is ${money2(liveObl.cashPayment)} due ${liveObl.cashFirstDue} from the obligation's cash fields`);
  const capDates = F.expandEvents(live.plan, live.meta.asOf, F.knowledgeHorizon(live.plan, live.meta.asOf, {}).end, {})
    .filter(e => e.debtId === 'heloc' && e.kind === 'noncash');
  ok(capDates.length && new RegExp(longDate(capDates[0].date)).test(strip(fact(liveHeloc, 'capitalise'))),
    'live HELOC interest date is the first noncash capitalise event');
  const forecastSrc = read('public/forecast.js');
  ok((forecastSrc.match(/capitalisingCashMinimumOccurrences\(/g) || []).length >= 3
      && !/cashFirstDue \|\| o\.firstDue \|\| null,\n\s*\}, span\.start/.test(forecastSrc),
    'calendarBillSections and creditAccounts read the one capitalisingCashMinimumOccurrences rule');
}

console.log('\n=== Page contract: served data only, formatting only ===');
{
  const src = stripComments(read('public/credit.js'));
  ok(/App\.register\(renderCredit\)/.test(src) && /App\.boot\(\)/.test(src), 'credit.js registers on the shared boot');
  ok(!/fetch\(|XMLHttpRequest|require\(|data\.json|localStorage/.test(src), 'credit.js fetches nothing itself — the served /data.json is the one source');
  ok(/Forecast\.creditAccounts\(/.test(src) && !/Forecast\.utilisation\(|Forecast\.expandEvents\(/.test(src),
    'credit.js composes through Forecast.creditAccounts only');
  ok(!/payoff|avalanche|snowball|pay (this|it) first|pay first|suggested transfer|move .* to|could borrow|may borrow/i.test(src),
    'no payoff order, pay-first, suggested transfer, or borrowing permission in the render');
  ok(!/\$\d|\d\.\d\d\b/.test(read('public/credit.html').replace(/<meta[^>]*>/g, '')), 'credit.html hardcodes no figure');
  const ids = new Set([...read('public/credit.html').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  ok(['credit-secured', 'credit-cards', 'credit-cards-lede', 'credit-note'].every(id => ids.has(id)),
    'credit.html has every element credit.js writes to');
  ok(/<script src="\/forecast.js"><\/script>\s*<script src="\/credit.js">/.test(read('public/credit.html')),
    'credit.html loads forecast.js before credit.js');
  ok(!/fact-card/.test(read('public/credit.js')) && !/fact-card/.test(read('public/credit.html')),
    'Credit markup keeps credit-* class names; Bills/Subscriptions reuse them via CSS only');
  const el = page.render(live);
  const note = el['credit-note'].textContent;
  ok(/Available credit is never household cash/.test(note) && /Nothing here ranks debts/.test(note),
    'the page states available credit is not cash and that nothing is ranked');
}

console.log('\n=== 13. A trusted live debt-balance overlay on served /data.json is what Credit prints ===');
function mockProvider(accounts) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (status, body) => {
        res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
      };
      if (req.method !== 'GET') return send(405, {});
      if (url.pathname === '/v2/me') return send(200, { user_id: 1 });
      if (url.pathname === '/v2/plaid_accounts') return send(200, { plaid_accounts: accounts });
      if (url.pathname === '/v2/manual_accounts' || url.pathname === '/v2/assets') return send(200, { manual_accounts: [] });
      if (url.pathname === '/v2/categories') return send(200, { categories: [] });
      if (url.pathname === '/v2/tags') return send(200, { tags: [] });
      if (url.pathname === '/v2/transactions') return send(200, { has_more: false, transactions: [] });
      return send(404, {});
    });
    server.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}/v2`,
      close: () => new Promise(done => server.close(() => done())),
    }));
    server.on('error', reject);
  });
}

(async function overlaySection() {
  const OBSERVED = '2026-08-21T17:55:00.000Z';
  const FETCHED_AT = '2026-08-21T18:00:00.000Z';
  const DELTA = 100;
  const canonical = JSON.parse(JSON.stringify(live));
  const debt = id => canonical.debts.find(d => d.id === id);
  const cash = id => canonical.plan.startingCash.breakdown.find(r => r.id === id).value;
  const target = 'tdcc';
  const overlaid = round2(debt(target).balance - DELTA);
  const accounts = [
    { id: 3001, name: 'BILLS ACCOUNT', type: 'cash', subtype: 'checking', balance: cash('chequing-a'), updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
    { id: 3002, name: 'WEEKLY SPENDING', type: 'cash', subtype: 'checking', balance: cash('chequing-b'), updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
    { id: 3003, name: 'EMERGENCY SAVING', type: 'cash', subtype: 'savings', balance: cash('savings'), updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
    { id: 3004, name: 'PERSONAL CREDIT CARD', type: 'credit', subtype: 'credit_card', balance: overlaid, credit_limit: debt('tdcc').limit, updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
    { id: 3005, name: 'TD CASH BACK VISA* CARD', type: 'credit', subtype: 'credit_card', balance: debt('cashback').balance, credit_limit: debt('cashback').limit, updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
    { id: 3006, name: 'TRAVEL VISA', type: 'credit', subtype: 'credit_card', balance: debt('travelvisa').balance, credit_limit: debt('travelvisa').limit, updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
    { id: 3007, name: 'LINE OF CREDIT - HOME EQUITY', type: 'loan', subtype: 'line_of_credit', balance: debt('heloc').balance, updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
    { id: 3008, name: 'MORTGAGE', type: 'loan', subtype: 'mortgage', balance: debt('mortgage').balance, updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
    { id: 3010, name: 'TRIANGLE MASTERCARD', type: 'credit', subtype: 'credit_card', balance: debt('triangle').balance, credit_limit: debt('triangle').limit, updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
  ];
  const map = {
    schema: 'atlas-provider-account-map/v1',
    owns: 'Synthetic loopback map. Fixture IDs 3001–3010 are not live provider IDs.',
    does_not_own: 'Financial values, permission to write data.json, Forecast, or live owner-observed IDs.',
    provider: 'lunchmoney', scope: 'live',
    mappings: [
      { providerAccountId: '3001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
      { providerAccountId: '3002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
      { providerAccountId: '3003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-reserve' },
      { providerAccountId: '3004', canonical: { collection: 'debts', id: 'tdcc' }, atlasRole: 'revolving-credit' },
      { providerAccountId: '3005', canonical: { collection: 'debts', id: 'cashback' }, atlasRole: 'revolving-credit' },
      { providerAccountId: '3006', canonical: { collection: 'debts', id: 'travelvisa' }, atlasRole: 'revolving-credit' },
      { providerAccountId: '3007', canonical: { collection: 'debts', id: 'heloc' }, atlasRole: 'heloc' },
      { providerAccountId: '3008', canonical: { collection: 'debts', id: 'mortgage' }, atlasRole: 'mortgage' },
      { providerAccountId: '3010', canonical: { collection: 'debts', id: 'triangle' }, atlasRole: 'revolving-credit' },
    ],
  };
  const before = fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8');
  const mock = await mockProvider(accounts);
  let served = null;
  try {
    served = await LivePlan.applyForServer(canonical, {
      ATLAS_LIVE_OVERLAY: 'live',
      ATLAS_LIVE_OVERLAY_NOW: FETCHED_AT,
      [O.API_BASE_ENV]: mock.base,
      [O.TOKEN_ENV]: 'synthetic-readonly-token-not-real',
      [O.MAP_JSON_ENV]: JSON.stringify(map),
    });
  } catch (err) {
    ok(false, 'live overlay applied in-process', err.message);
  } finally {
    await mock.close();
  }
  if (served) {
    ok(served.liveOverlay && served.liveOverlay.applied === true, 'the read-only overlay applied (trusted current observation)');
    ok(near(served.debts.find(d => d.id === target).balance, overlaid) && !near(overlaid, debt(target).balance),
      `served ${target} balance is the observed ${money2(overlaid)}, not the canonical ${money2(debt(target).balance)}`);
    const el = page.render(served);
    const card = account(el['credit-cards'].innerHTML, target);
    ok(card && strip(card).includes(money2(overlaid)), 'Credit prints the served live balance');
    ok(card && !strip(card).includes(money2(debt(target).balance)), 'Credit does not print the old canonical balance');
    const availExpected = round2(debt(target).limit - overlaid - (debt(target).pending || 0));
    ok(strip(fact(card, 'available')).includes(money2(availExpected)),
      `available follows the served balance: ${money2(availExpected)} = limit − served posted − pending`);
    ok(el['credit-note'].textContent.includes(longDate(served.meta.asOf))
        && served.meta.asOf === served.liveOverlay.effectiveAsOf,
      'the page as-of is the served effective as-of, not the repo opening');
    ok(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8') === before, 'data.json bytes unchanged');
    ok(!/synthetic-readonly-token-not-real|providerAccountId/.test(el['credit-cards'].innerHTML + el['credit-secured'].innerHTML),
      'no token or provider id reaches the page');
  }

  console.log('\n' + '═'.repeat(60));
  if (failures) { console.log(`\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`); process.exit(1); }
  console.log('\x1b[32mALL CHECKS PASSED\x1b[0m');
})().catch(err => { console.error(err); process.exit(1); });
