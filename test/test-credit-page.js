'use strict';
/* Forecast.creditAccounts — "What do we owe?" `node test/test-credit-page.js`
 *
 * The Credit page that rendered these rows was removed under #822; the file
 * name is kept so the suite identity does not move. Each check the page
 * suite made on printed HTML is made here on the row Forecast returns, with
 * the same synthetic fixture and the same hand-computed expectations. The
 * live data.json is used only where the owner's required tests name the live
 * accounts, and there the expectation is derived from the debt inputs, not
 * from the function under test.
 *
 * The last section applies a real read-only live overlay in-process through
 * scripts/live-plan.js against a loopback provider mock with a changed card
 * balance, and proves the credit row carries the served balance. No
 * canonical file is written and no real token or provider id is used. */
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

const accountsOf = d => F.creditAccounts(d.plan, d.debts, d.meta.asOf, { extraFacilities: d.revolvingExtra });
const rowOf = (acc, id) => acc.secured.concat(acc.cards).find(r => r.id === id);

console.log('=== 1–3. Mortgage first, HELOC second, active cards underneath ===');
{
  const acc = accountsOf(fixture());
  const secured = acc.secured.map(r => r.id);
  const cards = acc.cards.map(r => r.id);
  ok(secured[0] === 'mortgage', 'the mortgage is the first secured row', secured.join(','));
  ok(secured[1] === 'heloc', 'the HELOC is the second secured row');
  ok(secured.length === 2, 'no third secured row');
  ok(JSON.stringify(cards) === JSON.stringify(['card-a', 'card-b', 'card-c', 'card-over']),
    'the active cards follow in data order, underneath, despite the fixture listing them first', cards.join(','));
  const liveAcc = accountsOf(live);
  ok(liveAcc.secured.map(r => r.id).join(',') === 'mortgage,heloc',
    'live data: secured order is mortgage, heloc');
  ok(liveAcc.secured.length + liveAcc.cards.length === live.debts.length,
    'live: mortgage, HELOC, then every remaining debt record as a card');
}

console.log('\n=== 4. Closed products are not active cards ===');
{
  const acc = accountsOf(fixture());
  ok(!rowOf(acc, 'bnpl-final') && !/BNPL/.test(JSON.stringify(acc)),
    'a once bill (a BNPL final instalment) is not a credit row');
  const liveAcc = accountsOf(live);
  ok(!/Flexiti|Amex|American Express|Affirm/i.test(JSON.stringify(liveAcc.secured.concat(liveAcc.cards).map(r => r.label))),
    'live rows name no Flexiti, Amex or Affirm card');
  const unsecured = live.debts.filter(d => !d.secured).map(d => d.id);
  ok(JSON.stringify(liveAcc.cards.map(r => r.id)) === JSON.stringify(unsecured),
    'live cards are exactly the unsecured debt records — no hardcoded card count', unsecured.join(','));
}

console.log('\n=== 5–7. Limits are canonical; available credit is Forecast.utilisation, pending included ===');
{
  const acc = accountsOf(fixture());
  const heloc = rowOf(acc, 'heloc');
  ok(heloc.limit === 100000, 'HELOC total credit is the canonical limit');
  // Independent arithmetic from the fixture inputs, not from Forecast.
  const helocAvail = round2(100000 - 90000 - 0);
  ok(near(heloc.available, helocAvail), `HELOC available is ${money2(helocAvail)} = limit − posted − pending`);
  const util = F.utilisation(fixture().debts, [], fixture().plan);
  ok(near(util.rows.find(r => r.id === 'heloc').available, helocAvail),
    'and Forecast.utilisation agrees with that hand arithmetic');
  const cardA = rowOf(acc, 'card-a');
  const cardAAvail = round2(5000 - 4200.10 - 300.55);   // 499.35
  ok(near(cardAAvail, 499.35), 'fixture card A: 5,000 − 4,200.10 − 300.55 = 499.35 by hand');
  ok(near(cardA.available, cardAAvail), 'card A available includes the pending exposure', String(cardA.available));
  ok(near(util.rows.find(r => r.id === 'card-a').available, cardAAvail),
    'Forecast.utilisation card A agrees with the hand arithmetic');
  ok(near(cardA.pending, 300.55) && cardA.pendingUnknown === false, 'card A carries its non-zero pending');
  const over = rowOf(acc, 'card-over');
  ok(over.pending === 0 && over.pendingUnknown === false, 'a card with proven $0 pending carries a known zero');
  const cardB = rowOf(acc, 'card-b');
  ok(cardB.pendingUnknown === true && cardB.pending === null && cardB.available === null,
    'unknown pending withholds headroom — the $1,500 of posted room is not published, and pending is not $0');
  ok(over.overLimit === true && near(over.overLimitBy, 50),
    'an over-limit card is over the limit by $50.00, not simply $0 available');
  // Live: the HELOC available equals limit − posted − pending from the debt record.
  const liveHeloc = live.debts.find(d => d.id === 'heloc');
  const liveRow = rowOf(accountsOf(live), 'heloc');
  ok(near(liveRow.available, round2(liveHeloc.limit - liveHeloc.balance - (liveHeloc.pending || 0))),
    'live HELOC available = canonical limit − posted − pending, computed from the record');
  ok(liveRow.limit === liveHeloc.limit, 'live HELOC limit is the canonical limit');
}

console.log('\n=== 8–9. Minimum and due date come from the Forecast schedule, not the stored nextDue ===');
{
  const fx = fixture();
  const acc = accountsOf(fx);
  const mortgage = rowOf(acc, 'mortgage');
  // Bi-weekly from 2026-03-06; as-of 2026-03-10 → next occurrence 2026-03-20.
  ok(mortgage.nextPayment.date === '2026-03-20',
    'mortgage next due is the schedule occurrence 20 March, not the stale stored 6 March');
  ok(near(mortgage.nextPayment.amount, 1600), 'mortgage next payment is the schedule amount');
  const cardA = rowOf(acc, 'card-a');
  ok(cardA.nextPayment.date === '2026-03-15', 'card A due is the monthly day-15 occurrence on/after as-of, not the stale February nextDue');
  ok(near(cardA.nextPayment.amount, 120), 'card A minimum is the schedule amount');
  ok(rowOf(acc, 'card-over').nextPayment.date === '2026-04-05', 'a day-5 minimum whose March date has passed is 5 April');
  const cardB = rowOf(acc, 'card-b');
  ok(cardB.nextPayment.date === '2026-03-20' && near(cardB.nextPayment.amount, 25),
    'a confirmed once statement row is the next occurrence');
  // Same schedule the Plan calendar reads: expandEvents on/after as-of.
  const events = F.expandEvents(fx.plan, AS_OF, F.knowledgeHorizon(fx.plan, AS_OF, {}).end, {});
  const firstMortgage = events.find(e => e.debtId === 'mortgage' && e.kind === 'obligation');
  ok(firstMortgage && firstMortgage.date === '2026-03-20', 'Forecast.expandEvents names the same mortgage occurrence');
  // Live: every card's next payment equals the first expandEvents payment for that debt.
  const liveAcc = accountsOf(live);
  const liveEvents = F.expandEvents(live.plan, live.meta.asOf, F.knowledgeHorizon(live.plan, live.meta.asOf, {}).end, {});
  let agree = true;
  for (const d of live.debts.filter(x => !x.secured)) {
    const first = liveEvents.find(e => e.debtId === d.id && e.kind === 'obligation' && e.effect === 'payment' && e.date >= live.meta.asOf);
    const next = rowOf(liveAcc, d.id).nextPayment;
    if (!first || !next || next.date !== first.date || !near(next.amount, -first.amount)) agree = false;
  }
  ok(agree, 'live: every card carries the first Forecast.expandEvents payment on/after as-of, amount and date');
}

console.log('\n=== 10–11. Estimated stays estimated; unknown stays unknown ===');
{
  const acc = accountsOf(fixture());
  ok(rowOf(acc, 'card-a').nextPayment.confidence === 'estimated', 'an estimated minimum stays estimated');
  ok(rowOf(acc, 'card-b').nextPayment.confidence === 'confirmed', 'a confirmed minimum stays confirmed');
  const cardC = rowOf(acc, 'card-c');
  ok(cardC.nextPayment === null, 'no schedule occurrence → minimum and due date are Unknown');
  ok(cardC.rate === null && cardC.limit === null && cardC.available === null,
    'no rate, no limit → rate, limit and available are Unknown, never 0');
  const liveAcc = accountsOf(live);
  const liveEvents = F.expandEvents(live.plan, live.meta.asOf, F.knowledgeHorizon(live.plan, live.meta.asOf, {}).end, {});
  const firstByDebt = new Map();
  for (const e of liveEvents) {
    if (e.kind !== 'obligation' || e.effect !== 'payment' || e.date < live.meta.asOf || firstByDebt.has(e.debtId)) continue;
    firstByDebt.set(e.debtId, e);
  }
  const cardsLive = live.debts.filter(d => !d.secured);
  ok(cardsLive.length > 0 && cardsLive.every(d => {
    const first = firstByDebt.get(d.id);
    const next = rowOf(liveAcc, d.id).nextPayment;
    return first && next && next.confidence === first.confidence;
  }), 'live: each card\'s minimum carries the confidence of its first schedule occurrence');
}

console.log('\n=== Amount confirmation retains a separately estimated planning date ===');
{
  const fx = fixture();
  const statement = { scheduledDate: '2026-03-15', dueDate: '2026-03-15',
    minimum: 91.37, currency: 'cad', confidence: 'confirmed', dateConfidence: 'estimated' };
  fx.plan.obligations.find(row => row.id === 'card-a').statementOccurrences = [statement];
  const before = JSON.stringify(fx);
  const next = rowOf(accountsOf(fx), 'card-a').nextPayment;
  ok(near(next.amount, 91.37) && next.confidence === 'confirmed',
    'invented confirmed minimum keeps its amount and confirmed trust');
  ok(next.date === '2026-03-15' && next.dateConfidence === 'estimated',
    'the due date keeps its own estimated trust, separately from the amount');
  ok(JSON.stringify(fx) === before, 'reading date trust does not mutate input');
  for (const legacy of [true, false]) {
    if (legacy) delete statement.dateConfidence;
    else statement.dateConfidence = 'confirmed';
    const confirmed = rowOf(accountsOf(fx), 'card-a').nextPayment;
    ok(confirmed.date === '2026-03-15' && confirmed.dateConfidence !== 'estimated',
      `${legacy ? 'omitted legacy' : 'explicit confirmed'} date trust does not acquire an estimated qualifier`);
    ok(near(confirmed.amount, 91.37) && confirmed.confidence === 'confirmed',
      'confirmed statement amount remains unchanged');
  }
}

console.log('\n=== 12. HELOC capitalised interest is not a second household cash minimum ===');
{
  const fx = fixture();
  const acc = F.creditAccounts(fx.plan, fx.debts, AS_OF, {});
  const row = acc.secured.find(r => r.id === 'heloc');
  ok(row.nextPayment === null && row.nextCapitalise && row.nextCapitalise.date === '2026-03-31'
      && row.nextCashMinimum && row.nextCashMinimum.date === '2026-03-21' && near(row.nextCashMinimum.amount, 400),
    'Forecast.creditAccounts keeps capitalise and cash minimum as two facts and no payment event');
  ok(near(row.nextCapitalise.amount, 400) && row.nextCashMinimum.confidence === 'estimated',
    'the interest charge capitalises $400.00 on 31 March; the cash minimum is an estimated $400.00 due 21 March');
  const occ = F.capitalisingCashMinimumOccurrences(fx.plan.obligations.find(o => o.id === 'heloc'), AS_OF, '2026-06-30');
  ok(occ.map(o => o.date).join(',') === '2026-03-21,2026-04-21,2026-05-21,2026-06-21',
    'the shared cash-minimum rule yields the 21st each month from cashFirstDue');
  ok(F.capitalisingCashMinimumOccurrences({ id: 'x', nonCash: true, frequency: 'monthly', day: 31, amount: 400 }, AS_OF, '2026-06-30').length === 0,
    'a capitalising obligation with no cash minimum yields nothing');
  // Live: the same two facts, and the Plan bills list rule is the same function.
  const liveRow = rowOf(accountsOf(live), 'heloc');
  const liveObl = live.plan.obligations.find(o => o.id === 'heloc');
  ok(liveRow && liveObl && liveObl.cashFirstDue >= live.meta.asOf
      && liveRow.nextCashMinimum && liveRow.nextCashMinimum.date === liveObl.cashFirstDue
      && near(liveRow.nextCashMinimum.amount, liveObl.cashPayment),
    'live HELOC cash minimum comes from the obligation\'s cash fields, amount and date');
  const capDates = F.expandEvents(live.plan, live.meta.asOf, F.knowledgeHorizon(live.plan, live.meta.asOf, {}).end, {})
    .filter(e => e.debtId === 'heloc' && e.kind === 'noncash');
  ok(capDates.length && liveRow.nextCapitalise && liveRow.nextCapitalise.date === capDates[0].date,
    'live HELOC interest date is the first noncash capitalise event');
  const forecastSrc = read('public/forecast.js');
  ok((forecastSrc.match(/capitalisingCashMinimumOccurrences\(/g) || []).length >= 3
      && !/cashFirstDue \|\| o\.firstDue \|\| null,\n\s*\}, span\.start/.test(forecastSrc),
    'calendarBillSections and creditAccounts read the one capitalisingCashMinimumOccurrences rule');
}

console.log('\n=== 13. A trusted live debt-balance overlay on served /data.json reaches Forecast.creditAccounts ===');
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
    const servedAcc = accountsOf(served);
    const card = rowOf(servedAcc, target);
    ok(card && near(card.balance, overlaid) && !near(card.balance, debt(target).balance),
      'the credit row carries the served live balance, not the old canonical balance');
    const availExpected = round2(debt(target).limit - overlaid - (debt(target).pending || 0));
    ok(card && near(card.available, availExpected),
      `available follows the served balance: ${money2(availExpected)} = limit − served posted − pending`);
    ok(servedAcc.asOf === served.meta.asOf && served.meta.asOf === served.liveOverlay.effectiveAsOf,
      'the as-of is the served effective as-of, not the repo opening');
    ok(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8') === before, 'data.json bytes unchanged');
    ok(!/synthetic-readonly-token-not-real|providerAccountId/.test(JSON.stringify(servedAcc)),
      'no token or provider id reaches the credit rows');
  }

  console.log('\n' + '═'.repeat(60));
  if (failures) { console.log(`\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`); process.exit(1); }
  console.log('\x1b[32mALL CHECKS PASSED\x1b[0m');
})().catch(err => { console.error(err); process.exit(1); });
