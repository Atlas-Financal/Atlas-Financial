'use strict';
// Acceptance audit #962 D5: the current period's "income received" counts a
// posted, identity-matched payday deposit. Real page, invented household from
// test/acceptance/harness.js; no household figure enters this file. Expected
// figures are written by hand from the invented inputs.
//
//   node test/browser-payday-income-received.js
//
// Every case runs through two opening shapes:
//   - "harness": test/acceptance/harness.js as on main (canonical opening on
//     the live day Oct 14, priorAsOf Oct 9);
//   - "production": the shape #884 says production uses: the canonical
//     opening is dated at the Oct 9 payday with no priorAsOf, live-plan
//     advances it to Oct 14 and writes priorAsOf / matched postings itself,
//     and an unconfigured Savings account is observed as household cash.
//
// Invented world: payroll 1,400 biweekly from Fri Oct 9, as-of Oct 14; plan
// Groceries 300 + Eating out 100.
//
// Cases:
//   1. the 1,400 deposit posted Oct 9 and matched by its identity rule, plus
//      partner pay 1,000 due Oct 15: received 1,400 of planned 2,400; the
//      salary row reads received, the partner row arriving;
//   2. the same with one stream: received 1,400 of planned 1,400;
//   3. for a deposit at the planned amount, Balance After Deductions is
//      unchanged by the fix: 1,400 - 400 = 1,000;
//   4. negative: no deposit posted yet: the salary is not "received";
//   5. negative: the deposit is still pending: the salary is not "received";
//   6. a matched deposit of 1,350 (not 1,400) is received at 1,350: Payday
//      balance 1,350, BAD 950 (the represented-receipt rule follows actuals);
//   7. negative: two identical deposits: neither settles the salary;
//   8. negative: a deposit dated Oct 8, before the pay period: not received.
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const clone = x => JSON.parse(JSON.stringify(x));

// #884's production opening shape, built here from the same world.
function productionData(w) {
  const canonicalAsOf = w.asOf < '2026-10-09' ? w.asOf : '2026-10-09';
  const plan = H.planOf(w);
  plan.opening = { asOf: canonicalAsOf, representedEvents: [] };
  for (const row of plan.startingCash.breakdown) row.evidenceDate = canonicalAsOf;
  const observed = w.accounts.filter(a => !a.reserve || w.savingsPool || (a.id === 'savings' && !a.held));
  const role = a => a.id === 'savings' && !w.savingsPool ? 'household-cash' : a.role;
  const accountMap = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'acceptance',
    mappings: observed.map(a => ({ providerAccountId: String(a.providerId), atlasRole: role(a),
      canonical: { id: a.id, collection: a.collection } })) };
  const payload = H.rawPayload(w);
  payload.plaid_accounts = observed.map(a => ({ id: a.providerId, name: a.label, type: 'depository',
    balance: String(a.value), currency: 'cad', balance_last_update: w.asOf + 'T12:00:00.000Z' }));
  const canonical = { meta: { asOf: canonicalAsOf, title: 'Invented acceptance household' },
    accounts: [], debts: clone(w.debts || []), revolvingExtra: [], plan };
  return Live.fromObservation({ data: canonical, payload, accountMap, identity: H.identityOf(w) }).data;
}
const SHAPES = {
  harness: w => H.dataOf(w).data,
  production: productionData,
};

function world({ partner = false, deposit = 'posted', amount = 1400, date = '2026-10-09', copies = 1 } = {}) {
  const w = H.baseWorld();
  if (partner) w.income.push({ id: 'partner', label: 'Invented partner pay', frequency: 'once', date: '2026-10-15', amount: 1000, confidence: 'confirmed' });
  w.transactions = deposit === 'none' ? [] : Array.from({ length: copies }, () => H.lm({ date, amount: -amount,
    category: 'Payroll', account: 'chequing-a', payee: 'Invented employer', pending: deposit === 'pending' }));
  return w;
}
const payday = s => (s.income.match(/Payday balance\s*([−-]?\$[\d,]+\.\d\d)/) || [])[1] || '';
async function incomeOf(shape, w) {
  const data = SHAPES[shape](w);
  H.expect(data.liveOverlay && data.liveOverlay.currentPeriodActuals, `${shape}: positive control: the live overlay is served`);
  const p = await H.openBudget(data);
  try {
    const s = await H.snap(p);
    H.expectMatch(s.income, /^\W*Income/, `${shape}: positive control: the Income step is rendered`);
    return s;
  } finally { await p.close(); }
}
const received = s => (s.income.match(/^\W*Income\s*([^/]*?)\s*\/ of planned/) || [])[1] || '';
const bad = s => ((s.all.match(/Balance After Deductions\s*(?:0\s*)?([−-]?\$[\d,]+\.\d\d)/) || [])[1] || '').replace('−', '-');

const cases = [];
for (const shape of Object.keys(SHAPES)) {
  cases.push([`${shape}: 1. a posted matched deposit is received (two streams)`, async () => {
    const s = await incomeOf(shape, world({ partner: true }));
    H.expect(received(s) === '$1,400.00', `${shape}: received is 1,400 (got "${received(s)}")`);
    H.expectIncludes(s.income, 'of planned $2,400.00', `${shape}: planned is 1,400 + 1,000`);
    H.expectMatch(s.income, /Dale salaryOct 9 · received/, `${shape}: the salary row reads received`);
    H.expectMatch(s.income, /Invented partner pay · Oct 15 · arriving/, `${shape}: the partner pay is still arriving`);
  }]);
  cases.push([`${shape}: 2. a posted matched deposit is received (one stream)`, async () => {
    const s = await incomeOf(shape, world());
    H.expect(received(s) === '$1,400.00', `${shape}: received is 1,400 (got "${received(s)}")`);
    H.expectIncludes(s.income, 'of planned $1,400.00', `${shape}: planned is 1,400`);
  }]);
  cases.push([`${shape}: 3. Balance After Deductions is unchanged for an exact-amount deposit`, async () => {
    const s = await incomeOf(shape, world());
    H.expect(bad(s) === '$1,000.00', `${shape}: BAD is 1,400 - 400 = 1,000 (got ${bad(s) || 'nothing'})`);
  }]);
  cases.push([`${shape}: 4. no deposit posted yet: not received`, async () => {
    const s = await incomeOf(shape, world({ deposit: 'none' }));
    H.expectNoMatch(s.income, /Dale salaryOct 9 · received/, `${shape}: the salary is not received without a deposit`);
    H.expect(received(s) !== '$1,400.00', `${shape}: received is not 1,400 (got "${received(s)}")`);
  }]);
  cases.push([`${shape}: 5. a pending deposit: not received`, async () => {
    const s = await incomeOf(shape, world({ deposit: 'pending' }));
    H.expectNoMatch(s.income, /Dale salaryOct 9 · received/, `${shape}: a pending deposit is not received`);
  }]);
  cases.push([`${shape}: 6. a matched deposit of a different amount is received at its actual amount`, async () => {
    // The paycheque came in at 1,350, not the planned 1,400. Received and the
    // payday balance follow the posted actual (the incumbent rule for a
    // represented receipt): Payday balance 1,350; BAD 1,350 - 400 = 950.
    const s = await incomeOf(shape, world({ amount: 1350 }));
    H.expect(received(s) === '$1,350.00', `${shape}: received is the posted 1,350 (got "${received(s)}")`);
    H.expect(payday(s) === '$1,350.00', `${shape}: payday balance is 1,350 (got "${payday(s)}")`);
    H.expect(bad(s) === '$950.00', `${shape}: BAD is 1,350 - 400 = 950 (got ${bad(s) || 'nothing'})`);
  }]);
  cases.push([`${shape}: 7. two identical deposits: neither settles the salary`, async () => {
    const s = await incomeOf(shape, world({ copies: 2 }));
    H.expectNoMatch(s.income, /Dale salaryOct 9 · received/, `${shape}: an ambiguous pair is not received`);
  }]);
  cases.push([`${shape}: 8. a deposit dated before the pay period: not received`, async () => {
    const s = await incomeOf(shape, world({ date: '2026-10-08' }));
    H.expectNoMatch(s.income, /Dale salaryOct 9 · received/, `${shape}: an out-of-cycle deposit is not received`);
  }]);
}

(async () => {
  let failures = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log('  PASS  ' + name); }
    catch (err) { failures++; console.log('  FAIL  ' + name + ' -- ' + String(err && err.message || err).split('\n')[0]); }
  }
  if (H.closeBrowser) await H.closeBrowser();
  console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
  process.exit(failures ? 1 : 0);
})();
