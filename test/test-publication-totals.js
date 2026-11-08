'use strict';
/* Focused proof for Forecast.publicationTotals(). The correctness cases are
 * hand-computed from literal balances, annual-interest figures, asset values,
 * income line totals, unsettled plan.commitments and lacrosse sources — not the
 * function that now produces the answer.
 *
 * Until this move data.json independently stored Deep Dive headline totals,
 * Records net-worth totals, the income footer, the commitments total, the
 * lacrosse verified total, and a second HELOC limit. Those copies had
 * already drifted: the stored "Credit left, everywhere" tile was $1,415.95
 * against Forecast.utilisation's $1,415.98. Adding a balance and forgetting
 * the stored total left npm test green, because the suite reconciled the
 * stored copy against itself.
 */
const fs = require('fs');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const same = (a, b) => a === b;
const cents = n => Math.round(Number(n) * 100);
const sameCents = (a, b) => cents(a) === cents(b);
const read = p => sourceText(fs.readFileSync(p, 'utf8'));
const money2 = n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/* Independent fixture. The card is unsecured, so it is in total debt and
 * annual interest, and out of the mortgage-excluded interest only if it is
 * not the mortgage — which it is not. The overdraft is not a debt record;
 * credit-left follows utilisation, which is the incumbent headroom rule.
 *
 *   Mortgage  $100,000   annual $3,600   limit none
 *   HELOC      $50,000   annual $2,400   limit $55,000
 *   Card        $8,000   annual $1,200   limit $10,000, pending $500
 *   Overdraft   used $400 of $600
 *
 *   total debt     = 100,000 + 50,000 + 8,000 = 158,000
 *   annual         = 3,600 + 2,400 + 1,200 = 7,200
 *   annual ex-mtg  = 2,400 + 1,200 = 3,600
 *   assets         = 1,000 + 250 = 1,250
 *   financial      = 1,250 − 158,000 = −156,750
 *   credit left    = HELOC 5,000 + Card 1,500 + overdraft 200 = 6,700
 *   income         = 1,800 + 600 = 2,400 over 18 months → $133/month
 *   commitments    = 800 + 200 = 1,000
 *   lacrosse       = 300 + 50 = 350
 */
const FIX = {
  debts: [
    { id: 'mortgage', balance: 100000, annualInterest: 3600 },
    { id: 'heloc',    balance:  50000, annualInterest: 2400, limit: 55000 },
    { id: 'card',     balance:   8000, annualInterest: 1200, limit: 10000, pending: 500 },
  ],
  revolvingExtra: [{ id: 'overdraft', used: 400, limit: 600, pending: 0 }],
  assets: [
    { label: 'Chequing', value: 1000 },
    { label: 'Savings',  value:  250 },
  ],
  income: [
    { label: 'Pay',     total: 1800 },
    { label: 'Benefit', total:  600 },
  ],
  incomeCaptureMonths: 18,
  plan: { commitments: [{ id: 'a', amount: 800 }, { id: 'b', amount: 200 }] },
  lacrosse: { sources: [{ amount: 300, n: 2 }, { amount: 50, n: 1 }] },
};
const HAND_DEBT = 100000 + 50000 + 8000;
const HAND_ANNUAL = 3600 + 2400 + 1200;
const HAND_ANNUAL_EX = 2400 + 1200;
const HAND_ASSETS = 1000 + 250;
const HAND_FIN = HAND_ASSETS - HAND_DEBT;
const HAND_CREDIT = (55000 - 50000) + (10000 - (8000 + 500)) + (600 - 400);
const HAND_INCOME = 1800 + 600;
const HAND_INCOME_MONTHS = 18;
const HAND_INCOME_MONTHLY = Math.round(HAND_INCOME / HAND_INCOME_MONTHS);
const HAND_COMMIT = 800 + 200;
const HAND_LAX = 300 + 50;

console.log('=== hand-computed publication totals ===');
ok(HAND_DEBT === 158000, 'total debt is $100,000 + $50,000 + $8,000');
ok(HAND_ANNUAL === 7200 && HAND_ANNUAL_EX === 3600,
  'annual interest is $7,200, of which $3,600 is not the mortgage');
ok(HAND_ASSETS === 1250 && HAND_FIN === -156750,
  'assets $1,250 less total debt is −$156,750');
ok(HAND_CREDIT === 6700,
  'credit left is HELOC $5,000 + card $1,500 + overdraft $200');
ok(HAND_INCOME === 2400 && HAND_INCOME_MONTHLY === 133,
  'income $2,400 over 18 months rounds to $133/month');
ok(HAND_COMMIT === 1000 && HAND_LAX === 350,
  'commitments $800 + $200; lacrosse $300 + $50');

const fixture = F.publicationTotals(FIX);
ok(!!fixture, 'a result is returned');
ok(fixture && same(fixture.totalDebt, HAND_DEBT),
  'fixture total debt is the three posted balances',
  fixture ? String(fixture.totalDebt) : 'none');
ok(fixture && same(fixture.annualInterest, HAND_ANNUAL)
  && same(fixture.annualInterestExMortgage, HAND_ANNUAL_EX),
  'fixture annual interest includes the card and excludes the mortgage from the subtotal');
ok(fixture && same(fixture.monthlyInterest, HAND_ANNUAL / 12)
  && same(fixture.monthlyInterestExMortgage, HAND_ANNUAL_EX / 12),
  'fixture monthly interest is those annuals divided by twelve');
ok(fixture && same(fixture.assets, HAND_ASSETS)
  && same(fixture.financialAccountsOnly, HAND_FIN),
  'fixture net-worth lines are assets and assets minus debts');
ok(fixture && same(fixture.creditLeft, HAND_CREDIT)
  && same(fixture.revolvingFacilityCount, 3),
  'fixture credit left matches utilisation on the same rows',
  fixture ? String(fixture.creditLeft) : 'none');
ok(fixture && same(fixture.incomeTotal, HAND_INCOME)
  && same(fixture.incomePerMonth, HAND_INCOME_MONTHLY)
  && same(fixture.incomeMonths, HAND_INCOME_MONTHS)
  && same(fixture.incomeMonths, FIX.incomeCaptureMonths),
  'fixture income total and rounded monthly figure follow the source-owned 18-month window');
ok(fixture && same(fixture.commitmentsTotal, HAND_COMMIT)
  && same(fixture.lacrosseVerified, HAND_LAX)
  && same(fixture.helocLimit, 55000),
  'fixture commitments, lacrosse verified total, and HELOC limit from the debt record');

console.log('\n=== credit-left is utilisation, not a second headroom rule ===');
const utilFix = F.utilisation(FIX.debts, FIX.revolvingExtra);
ok(same(fixture.creditLeft, utilFix.totalAvailable),
  'publication credit-left is Forecast.utilisation.totalAvailable on the same inputs');
ok(same(fixture.revolvingFacilityCount, utilFix.rows.length),
  'and the facility count is utilisation.rows.length');

console.log('\n=== live plan: publication follows the current rows ===');
/* Authority link, not a snapshot of today's cents. The FIX fixture above is
 * the independent arithmetic. Here the published totals must follow the
 * canonical rows; a legitimate balance refresh must not require rewriting
 * copied literals. */
const mortgageDebt = data.debts.find(d => d.id === 'mortgage');
const helocDebt = data.debts.find(d => d.id === 'heloc');
const tdccDebt = data.debts.find(d => d.id === 'tdcc');
const rowDebt = data.debts.reduce((s, d) => s + (d.balance || 0), 0);
const rowAnnual = data.debts.reduce((s, d) => s + (d.annualInterest || 0), 0);
const rowAnnualEx = rowAnnual - (mortgageDebt.annualInterest || 0);
const cashById = {};
for (const row of (data.plan.startingCash.breakdown || [])
  .concat(data.plan.startingCash.heldElsewhere || [])) {
  if (row.id) cashById[row.id] = row.value || 0;
}
const rowAssets = data.assets.reduce((s, a) => s + (a.cash ? (cashById[a.cash] || 0) : (a.value || 0)), 0);
const rowIncome = (data.income || []).reduce((s, r) => s + (r.total || 0), 0);
const asOf = data.meta && data.meta.asOf || null;
const rowCommit = ((data.plan && data.plan.commitments) || [])
  .filter(c => !F.commitmentSettledBy(c, asOf))
  .reduce((s, i) => s + (i.amount || 0), 0);
const rowLax = ((data.lacrosse && data.lacrosse.sources) || [])
  .reduce((s, r) => s + (r.amount || 0), 0);
const rowIncomeMonthly = Math.round(rowIncome / data.incomeCaptureMonths);

ok(data.debts.length === 7, 'seven posted debt rows');
ok(data.assets.length === 10, 'ten asset rows, including Cash Back Dollars');
ok((data.income || []).length === 5, 'five income-line rows');

const live = F.publicationTotals(data);
ok(live && sameCents(live.totalDebt, rowDebt),
  'live total debt follows the posted balances',
  live ? money2(live.totalDebt) : 'none');
ok(live && same(live.annualInterest, rowAnnual)
  && same(live.annualInterestExMortgage, rowAnnualEx),
  'live annual interest follows the debt-record literals');
ok(live && sameCents(live.assets, rowAssets)
  && sameCents(live.financialAccountsOnly, rowAssets - rowDebt),
  'live net-worth lines follow the asset and debt rows');
ok(data.incomeCaptureMonths === 18,
  'live historical income evidence names its own 18-month capture window');
ok(live && sameCents(live.incomeTotal, rowIncome)
  && same(live.incomePerMonth, rowIncomeMonthly)
  && same(live.incomeMonths, 18)
  && same(live.incomeMonths, data.incomeCaptureMonths),
  'live income total and monthly round follow the source-owned window');
ok(live && same(live.commitmentsTotal, rowCommit)
  && sameCents(live.lacrosseVerified, rowLax),
  'live commitments and lacrosse verified totals follow the item rows');

const liveUtil = F.utilisation(data.debts, data.revolvingExtra, data.plan);
ok(live && same(live.creditLeft, liveUtil.totalAvailable),
  'live credit left is utilisation on the same rows, not a stored copy',
  live ? money2(live.creditLeft) : 'none');
ok(live && same(live.helocLimit, helocDebt.limit),
  'live HELOC limit is the debt record\'s limit');
ok(live && same(live.revolvingFacilityCount, liveUtil.rows.length),
  'revolving facility count is utilisation.rows.length');

const snap = F.compactSnapshot(data.debts, data.helocHistory);
ok(live && snap && same(live.monthlyInterest, snap.monthlyInterest),
  'Deep Dive annual/12 and the Plan compact snapshot are one twelfth');
ok(live && sameCents(live.creditLeft, F.utilisation(data.debts, data.revolvingExtra, data.plan).totalAvailable),
  'Deep Dive credit-left and the Plan revolving tile are one utilisation figure');

console.log('\n=== stored duplicate authorities are gone ===');
ok(!Object.prototype.hasOwnProperty.call(data, 'headline'),
  'data.json no longer stores a headline totals array');
ok(!Object.prototype.hasOwnProperty.call(data, 'incomeTotal'),
  'data.json no longer stores incomeTotal');
ok(!Object.prototype.hasOwnProperty.call(data, 'helocLimit'),
  'data.json no longer stores a second HELOC limit');
ok(!Object.prototype.hasOwnProperty.call(data.netWorth || {}, 'assets')
  && !Object.prototype.hasOwnProperty.call(data.netWorth || {}, 'debts')
  && !Object.prototype.hasOwnProperty.call(data.netWorth || {}, 'financialAccountsOnly'),
  'netWorth no longer stores assets / debts / financialAccountsOnly');
ok(!!(data.netWorth && data.netWorth.caveat),
  'the net-worth estimate caveat remains stored prose');
ok(data.mortgage.balance == null && data.mortgage.rate == null
  && data.mortgage.paymentBiweekly == null,
  'the mortgage block no longer stores balance, rate, or bi-weekly payment');
ok(data.mortgage.remainingYears != null && data.mortgage.maturity
  && data.mortgage.prepaymentRoom != null,
  'and still holds the renewal standing facts');
ok(data.commitments.total == null,
  'commitments no longer store a separate total');
ok(data.commitments.items == null && data.commitments.schedule == null,
  'Deep Dive no longer keeps a second commitments list');
ok(data.lacrosse.verified == null,
  'lacrosse no longer stores a separate verified total');

console.log('\n=== pages are renderers ===');
const dive = read('public/deepdive.js');
const diveCode = dive.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const records = read('public/records.js');
const recordsCode = records.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const modellers = read('public/modellers.js');
const modellersCode = modellers.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(/Forecast\.publicationTotals\(d\)/.test(dive),
  'Deep Dive reads publication totals from Forecast.publicationTotals');
ok(/Forecast\.publicationTotals\(d\)/.test(records),
  'Records reads net-worth totals from Forecast.publicationTotals');
ok(/forecast\.js/.test(read('public/records.html')),
  'Records loads the engine so those totals are not page arithmetic');
ok(!/d\.headline/.test(diveCode),
  'Deep Dive no longer reads a stored headline array');
ok(!/d\.incomeTotal/.test(diveCode) && !/incomeTotal\.total/.test(diveCode),
  'Deep Dive no longer reads a stored incomeTotal');
ok(!/d\.helocLimit/.test(diveCode),
  'Deep Dive no longer reads a stored helocLimit');
ok(!/c\.total\b/.test(diveCode) || /pub\.commitmentsTotal/.test(diveCode),
  'Deep Dive prints the returned commitments total');
ok(/pub\.lacrosseVerified/.test(diveCode) && !/L\.verified/.test(diveCode),
  'Deep Dive prints the returned lacrosse verified total');
ok(!/netWorth\.assets/.test(recordsCode) && !/netWorth\.debts/.test(recordsCode)
  && !/financialAccountsOnly/.test(recordsCode) || /pub\.financialAccountsOnly/.test(recordsCode),
  'Records no longer reads stored net-worth scalars');
ok(/pub\.assets/.test(recordsCode) && /pub\.totalDebt/.test(recordsCode),
  'Records prints the returned asset and debt totals');
ok(!/\.reduce\(\(s, x\) => s \+ \(x\.balance/.test(diveCode)
  && !/\.reduce\(\(s, a\) => s \+ a\.value/.test(recordsCode),
  'neither page re-sums debt balances or asset values');
ok(/mortgageDebt\.rate/.test(modellersCode) && !/\bm\.rate\b/.test(modellersCode),
  'the renewal slider opens on the debt record\'s rate, not a stored mortgage.rate');

console.log('\n=== mutation: a canonical input moves every consumer ===');
const mutatedDebts = data.debts.map(x =>
  x.id === 'triangle' ? Object.assign({}, x, { balance: x.balance + 100 }) : x);
const afterBalance = F.publicationTotals(Object.assign({}, data, { debts: mutatedDebts }));
ok(sameCents(afterBalance.totalDebt, rowDebt + 100),
  'raising Triangle\'s posted balance by $100 raises total debt by $100',
  money2(afterBalance.totalDebt));
ok(sameCents(afterBalance.financialAccountsOnly, rowAssets - rowDebt - 100),
  'and financial-accounts-only falls by the same $100');
ok(sameCents(live.totalDebt, rowDebt),
  'the live engine is unmoved by that fixture');

const withoutCard = F.publicationTotals(Object.assign({}, data, {
  debts: data.debts.filter(x => x.id !== 'tdcc'),
}));
ok(sameCents(withoutCard.totalDebt, rowDebt - tdccDebt.balance)
  && sameCents(withoutCard.annualInterest, rowAnnual - (tdccDebt.annualInterest || 0)),
  'removing the TD credit card drops that card\'s posted balance and annual interest');

const extraIncome = (data.income || []).concat([{ label: 'Bonus', total: 1800 }]);
const afterIncome = F.publicationTotals(Object.assign({}, data, { income: extraIncome }));
ok(sameCents(afterIncome.incomeTotal, rowIncome + 1800)
  && afterIncome.incomePerMonth === Math.round((rowIncome + 1800) / data.incomeCaptureMonths),
  'an extra $1,800 income line moves the footer total and its monthly round');

console.log('\n=== mutation: source-owned capture window, not a code constant ===');
const HAND_INCOME_MONTHLY_19 = Math.round(HAND_INCOME / 19);
ok(HAND_INCOME_MONTHLY_19 === 126 && HAND_INCOME_MONTHLY_19 !== HAND_INCOME_MONTHLY,
  'independent round($2,400 / 19) is $126, distinct from the 18-month $133');
const afterWindow = F.publicationTotals(Object.assign({}, FIX, { incomeCaptureMonths: 19 }));
ok(same(afterWindow.incomeTotal, HAND_INCOME)
  && same(afterWindow.incomeMonths, 19)
  && same(afterWindow.incomePerMonth, HAND_INCOME_MONTHLY_19),
  'changing only incomeCaptureMonths to 19 republishes round(total / 19); forecast.js is unedited');
ok(same(fixture.incomePerMonth, HAND_INCOME_MONTHLY)
  && same(fixture.incomeMonths, 18),
  'the 18-month fixture is unmoved by that copy');

const liveWindow19 = F.publicationTotals(Object.assign({}, data, { incomeCaptureMonths: 19 }));
ok(sameCents(liveWindow19.incomeTotal, rowIncome)
  && same(liveWindow19.incomePerMonth, Math.round(rowIncome / 19))
  && liveWindow19.incomePerMonth !== rowIncomeMonthly,
  'live monthly footer follows a 19-month source window');
ok(same(live.incomePerMonth, rowIncomeMonthly) && same(live.incomeMonths, 18),
  'the live 18-month monthly result is unmoved by that copy');

const missingInput = Object.assign({}, FIX);
delete missingInput.incomeCaptureMonths;
const missing = F.publicationTotals(missingInput);
ok(missing.incomeMonths === null && missing.incomePerMonth === null,
  'a missing capture window does not invent 18 months');
const zero = F.publicationTotals(Object.assign({}, FIX, { incomeCaptureMonths: 0 }));
ok(zero.incomeMonths === null && zero.incomePerMonth === null,
  'a zero capture window does not invent 18 months');

ok(!/\bINCOME_CAPTURE_MONTHS\b/.test(read('public/forecast.js')),
  'forecast.js no longer declares INCOME_CAPTURE_MONTHS');
ok(!/incomeTotal\s*\/\s*18\b/.test(read('public/forecast.js')),
  'forecast.js does not hardcode incomeTotal / 18');
ok(!/\/\s*18\b/.test(read('public/deepdive.js')) && !/\/\s*18\b/.test(read('public/records.js')),
  'Deep Dive and Records do not divide by a hardcoded 18');

const extraPlan = {
  plan: Object.assign({}, data.plan, {
    commitments: (data.plan.commitments || []).concat([{ id: 'extra-commit', amount: 150 }]),
  }),
};
const afterCommit = F.publicationTotals(Object.assign({}, data, extraPlan));
ok(afterCommit.commitmentsTotal === rowCommit + 150,
  'an extra $150 plan.commitments row moves the published total');

console.log('\n=== B28: dollar Cash Back rewards enter assets; points do not ===');
/* Synthetic $47.21 is a fixture for publication arithmetic — not a live
 * ACCOUNT_FACTS pin. The live row is reconciled to the dated positions.csv
 * Household evidence (2026-08-09), not treated as a 2026-08-19 opening
 * balance. Points stay out of every dollar total. */
const CASH_BACK_DOLLARS = 47.21;
const TD_REWARDS_POINTS = 57968;
ok(sameCents(CASH_BACK_DOLLARS, 47 + 21 / 100),
  'the dollar reward fixture is independently $47 + 21 cents');

const HAND_ASSETS_WITH_REWARD = HAND_ASSETS + CASH_BACK_DOLLARS;
ok(sameCents(HAND_ASSETS_WITH_REWARD, 1250 + 47.21),
  'FIX assets $1,250 plus $47.21 is $1,297.21 by hand',
  money2(HAND_ASSETS_WITH_REWARD));

const fixWithReward = Object.assign({}, FIX, {
  assets: FIX.assets.concat([{ label: 'Cash Back Dollars', value: CASH_BACK_DOLLARS }]),
});
const pubWithReward = F.publicationTotals(fixWithReward);
const pubWithoutReward = F.publicationTotals(FIX);
ok(sameCents(pubWithReward.assets, HAND_ASSETS_WITH_REWARD)
  && sameCents(pubWithReward.assets - pubWithoutReward.assets, CASH_BACK_DOLLARS),
  'adding the dollar reward raises published assets by exactly $47.21');
ok(sameCents(pubWithReward.financialAccountsOnly - pubWithoutReward.financialAccountsOnly,
  CASH_BACK_DOLLARS),
  'and financial-account net worth by the same $47.21');
ok(same(pubWithReward.totalDebt, pubWithoutReward.totalDebt)
  && same(pubWithReward.creditLeft, pubWithoutReward.creditLeft)
  && same(pubWithReward.annualInterest, pubWithoutReward.annualInterest),
  'debt totals, credit left, and interest are unchanged');

const pubRewardRemoved = F.publicationTotals(Object.assign({}, FIX, { assets: FIX.assets }));
ok(sameCents(pubRewardRemoved.assets, HAND_ASSETS)
  && sameCents(pubWithReward.assets - pubRewardRemoved.assets, CASH_BACK_DOLLARS),
  'removing that reward drops the published total by the same $47.21');

const pubRewardChanged = F.publicationTotals(Object.assign({}, FIX, {
  assets: FIX.assets.concat([{ label: 'Cash Back Dollars', value: 40 }]),
}));
ok(sameCents(pubRewardChanged.assets, HAND_ASSETS + 40)
  && sameCents(pubWithReward.assets - pubRewardChanged.assets, CASH_BACK_DOLLARS - 40),
  'changing the reward to $40 moves the published total by the $7.21 difference');

const pubWithPointsField = F.publicationTotals(Object.assign({}, FIX, {
  assets: FIX.assets.concat([
    { label: 'Cash Back Dollars', value: CASH_BACK_DOLLARS },
    { label: 'TD Rewards points', points: TD_REWARDS_POINTS },
  ]),
}));
// A points-only row has no dollar value, so it is an Unknown asset value:
// the dollar total is Unknown (null), and the points never become dollars.
ok(pubWithPointsField.assets === null && pubWithPointsField.unknownAssetCount === 1
  && !sameCents(pubWithPointsField.assets, HAND_ASSETS_WITH_REWARD + TD_REWARDS_POINTS),
  'a points field does not enter the dollar asset total (the row has no dollar value, so the total is Unknown)');
ok(!sameCents(pubWithPointsField.assets, HAND_ASSETS + TD_REWARDS_POINTS)
  && !sameCents(pubWithPointsField.assets, HAND_ASSETS_WITH_REWARD + TD_REWARDS_POINTS),
  'and 57,968 is not treated as dollars');

function parseCsvLine(r) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    if (c === '"') { if (q && r[i + 1] === '"') { cur += '"'; i++; } else q = !q; continue; }
    if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
}
const posReward = read('docs/positions.csv').split(/\r?\n/).map(parseCsvLine)
  .find(c => c[0] === 'Household' && c[2] === 'Cash Back Dollars');
const liveReward = (data.assets || []).find(a => a.label === 'TD Cash Back Dollars');
const liveRewardCents = liveReward ? Number(liveReward.value) : NaN;
ok(posReward && posReward[19] === '2026-08-09',
  'positions.csv dates Cash Back Dollars to the 2026-08-09 account reading');
ok(posReward && posReward[19] !== asOf,
  'that evidence date is not the current opening as-of');
ok(/^VERIFIED/.test(String(posReward && posReward[18] || '')),
  'the dated row keeps verified-account confidence, not an opening observation');
ok(liveReward && liveReward.cash == null && sameCents(liveRewardCents, Number(posReward[6])),
  'live data.json matches the dated positions.csv Cash Back Dollars row');
ok(new RegExp(posReward[19].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(data.assetsNote)
  && new RegExp('not this ' + String(asOf).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(data.assetsNote),
  'assetsNote labels the live row as that dated reading, not this cutover');
ok(!/ACCOUNT_FACTS/.test(data.assetsNote),
  'assetsNote does not treat ACCOUNT_FACTS as the current-balance authority');
ok(!(data.assets || []).some(a => /rewards points/i.test(String(a.label || '')) && a.value),
  'live assets do not assign a dollar value to TD Rewards points');
ok(!(data.assets || []).some(a => a.points != null),
  'live assets do not carry a valued points field');
const liveWithoutReward = F.publicationTotals(Object.assign({}, data, {
  assets: (data.assets || []).filter(a => a.label !== 'TD Cash Back Dollars'),
}));
ok(sameCents(live.assets - liveWithoutReward.assets, liveRewardCents)
  && sameCents(live.financialAccountsOnly - liveWithoutReward.financialAccountsOnly,
    liveRewardCents),
  'removing the live Cash Back Dollars row drops published net-worth assets by that dated balance');
ok(sameCents(live.totalDebt, liveWithoutReward.totalDebt)
  && same(live.creditLeft, liveWithoutReward.creditLeft),
  'live debt total and funding-capacity headroom do not move with that row');

const spendable = F.startingCashAmount(data.plan);
const spendableHand = (data.plan.startingCash.breakdown || [])
  .filter(b => b && (b.id === 'chequing-a' || b.id === 'chequing-b'))
  .reduce((s, b) => s + (Number(b.value) || 0), 0);
ok(sameCents(spendable, spendableHand),
  'spendable cash is independently summed household chequing, independently of assets');
ok(!(data.plan.startingCash.breakdown || []).concat(data.plan.startingCash.heldElsewhere || [])
  .some(b => /cash back dollars/i.test(String(b.label || b.id || ''))),
  'Cash Back Dollars is not a cash-register identity');

const recOpts = {
  scenario: data.plan.defaults.scenario,
  incomeOverrides: {}, disabled: [],
  extraDebtMonthly: data.plan.defaults.extraDebtMonthly,
  targetBuffer: data.plan.defaults.targetBuffer,
  debts: data.debts,
  extraDebtTarget: data.plan.nextDollar && data.plan.nextDollar.target,
  fundingSources: data.plan.funding && data.plan.funding.options,
  extraFacilities: data.revolvingExtra,
};
const advice = F.recommend(data.plan, data.meta.asOf, recOpts);
ok(advice && advice.weekly != null,
  'Forecast.recommend still returns a weekly cap on this plan');
const forecastSrc = read('public/forecast.js');
const recMark = 'function recommend(plan, asOf, opts)';
const recStart = forecastSrc.indexOf(recMark);
const recEnd = forecastSrc.indexOf('function incomeDeadline(', recStart);
const recommendSrc = recStart >= 0 && recEnd > recStart
  ? forecastSrc.slice(recStart, recEnd) : '';
ok(recommendSrc.indexOf(recMark) === 0 && !/\bassets\b/.test(recommendSrc),
  'recommend does not read the assets list, so safe-to-spend cannot move with this row');

console.log('\n=== mutation: breaking the engine formula fails ===');
const FORECAST_SRC = read('public/forecast.js');
const FROM = '      else totalDebt += balance;';
const TO = '      else if (debt.id !== \'mortgage\') totalDebt += balance;';
ok(FORECAST_SRC.split(FROM).length - 1 === 1,
  'the total-debt accumulation appears once, so the mutation is aimed');
const sandbox = { module: { exports: {} } };
try {
  vm.runInNewContext(FORECAST_SRC.replace(FROM, TO), sandbox, { filename: 'forecast-mutant.js' });
} catch (e) {
  ok(false, 'mutant engine loads', e.message);
}
const mutant = sandbox.module.exports;
const broken = mutant && mutant.publicationTotals(data);
ok(mutant && broken && sameCents(broken.totalDebt, rowDebt - mortgageDebt.balance)
  && !sameCents(broken.totalDebt, rowDebt),
  'omitting the mortgage from the sum understates live total debt by that posted balance',
  broken ? money2(broken.totalDebt) : 'mutant missing');
ok(live && sameCents(live.totalDebt, rowDebt),
  'the real engine still answers the posted-balance total');

console.log('\n=== mutation: reintroducing a stored scalar is detected ===');
ok(!data.headline && !data.incomeTotal && data.helocLimit == null,
  'reintroducing headline, incomeTotal, or helocLimit fails the deletion checks above');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
