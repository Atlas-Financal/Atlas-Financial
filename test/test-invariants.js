'use strict';
/* Data and authority invariants. `node test/test-invariants.js`

   ONE FACT, ONE HOME. This file is where that principle is enforced rather
   than merely stated. A contradiction between two parts of the repository is
   a TEST FAILURE, not a warning — a financial plan that disagrees with itself
   is worse than no plan, because it still looks authoritative.

   Every check here exists because the contradiction it tests for was real. */

const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');
const {
  containsCalendarDay,
  storedCrossingClaims,
} = require('./test-heloc-crossing-guard');
const data = require('../data.json');
const { openingFloor, gapAtBuffer, fundingById, representedEventKeys,
  independentlyRepresentedPrepaidDebtAbsorbed } = require('./test-helpers');
const periods = require('../public/periods.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const money = n => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const read = p => sourceText(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));

const plan = data.plan;
const asOf = data.meta.asOf;
const liveFunding = () => F.resolveFundingSources(
  plan.funding.options, data.revolvingExtra, plan, data.debts);

console.log('=== cash classification ===');
const cash = plan.startingCash;
const CLASSES = ['spendable', 'operational', 'staging', 'other-liquid', 'restricted', 'purpose-reserve'];
const purposeIds = new Set((plan.savingsEarmarks?.pools || [])
  .filter(pool => pool.role === 'purpose-reserve').map(pool => pool.accountId));
const chequingIds = ['chequing-a', 'chequing-b'];
const chequingSum = cash.breakdown
  .filter(b => chequingIds.includes(b.id))
  .reduce((s, b) => s + b.value, 0);
const breakdownSum = cash.breakdown.reduce((s, b) => s + b.value, 0);
const designatedSavings = cash.breakdown.find(b => b.id === 'savings');
ok(near(chequingSum, F.startingCashAmount(plan)),
  'Forecast spendable opening equals independently summed household chequing',
  `${money(chequingSum)} = ${money(F.startingCashAmount(plan))}`);
ok(designatedSavings && !near(breakdownSum, chequingSum),
  'designated savings remains on the breakdown as reserve evidence and is not spendable opening',
  designatedSavings ? money(designatedSavings.value) : 'missing');
ok(!Object.prototype.hasOwnProperty.call(cash, 'amount'),
  'the opening total is not stored beside the spendable accounts');
ok(cash.breakdown.every(b => b.class === 'spendable' && !purposeIds.has(b.id)
  || b.id === 'savings' && b.class === 'purpose-reserve' && purposeIds.has(b.id)),
  'opening rows are operating cash or the explicitly configured non-spendable savings reserve');
ok((cash.heldElsewhere || []).every(h => CLASSES.includes(h.class)),
  'every excluded pot carries a real classification',
  (cash.heldElsewhere || []).map(h => h.class).join(', '));
ok((cash.heldElsewhere || []).every(h => h.class !== 'spendable'),
  'nothing excluded from the plan is labelled spendable');

// Amanda's account is operational, not household money. This is the whole
// reason the plan opens at $79.84 rather than $2,771.69.
const amanda = (cash.heldElsewhere || []).find(h => h.id === 'amanda-debt-payments');
ok(amanda && amanda.class === 'operational',
  "Amanda's TENNIS INCOME account is operational / pass-through, not spendable",
  amanda ? money(amanda.value) : 'missing');

// The cash register is the numeric home. Matching `assets[]` rows carry a
// `cash` id and no stored value — a second stored balance is the defect.
const cashAccounts = cash.breakdown.concat(cash.heldElsewhere || []);
ok(cashAccounts.filter(row => row.class === 'purpose-reserve').every(row =>
  ['savings', 'savings-dont-touch'].includes(row.id) && purposeIds.has(row.id)),
  'purpose classification belongs only to the explicitly configured canonical savings identities');
const registerTotal = cashAccounts.reduce((s, a) => s + a.value, 0);
const assetCash = data.assets.filter(a => a.cash);
ok(assetCash.length === cashAccounts.length,
  'the balance sheet names exactly the cash-register accounts',
  `${assetCash.length} linked rows`);
ok(assetCash.every(a => a.value == null && cashAccounts.some(c => c.id === a.cash)),
  'linked asset rows store no balance of their own');
const publishedAssets = F.publicationTotals(data).assetRows;
const derivedCashTotal = publishedAssets
  .filter(a => a.cash)
  .reduce((s, a) => s + a.value, 0);
ok(near(registerTotal, derivedCashTotal),
  'derived balance-sheet cash follows the register, not a second stored copy',
  `${money(registerTotal)} vs ${money(derivedCashTotal)}`);

// The defect this replaced: a headline tile that added all six together.
ok(!data.headline,
  'stored headline totals are gone — Deep Dive derives them via Forecast.publicationTotals',
  'the undifferentiated "Cash on hand" tile summed spendable, pass-through, staging and US holiday money as one figure');
ok(/Forecast\.deepDive/.test(read('public/deepdive.js'))
  && /dive\.cashAmount/.test(read('public/deepdive.js')),
  'the Deep Dive cash tile derives from the plan cash register via Forecast.deepDive');
ok(/Forecast\.publicationTotals/.test(read('public/deepdive.js')),
  'and the remaining Deep Dive tiles derive from Forecast.publicationTotals');

console.log('\n=== assets and debts reconcile ===');
const cashById = {};
for (const row of cashAccounts) if (row.id) cashById[row.id] = row.value;
const assetTotal = data.assets.reduce((s, a) => s + (a.cash ? (cashById[a.cash] || 0) : (a.value || 0)), 0);
const debtTotal = data.debts.reduce((s, x) => s + (x.balance || 0), 0);
const published = F.publicationTotals(data);
ok(near(assetTotal, published.assets),
  'assets sum to the published net-worth asset figure',
  `${money(assetTotal)} vs ${money(published.assets)}`);
ok(near(debtTotal, published.totalDebt),
  'debts sum to the published total-debt figure',
  `${money(debtTotal)} vs ${money(published.totalDebt)}`);
ok(!Object.prototype.hasOwnProperty.call(data.netWorth || {}, 'assets')
  && !Object.prototype.hasOwnProperty.call(data.netWorth || {}, 'debts'),
  'those totals are no longer stored beside the rows they sum');
const secured = data.debts.filter(x => x.secured).reduce((s, x) => s + x.balance, 0);
const consumer = data.debts.filter(x => !x.secured).reduce((s, x) => s + x.balance, 0);
ok(near(secured + consumer, debtTotal),
  'secured plus consumer debt is the whole of it',
  `${money(secured)} + ${money(consumer)}`);
ok(data.debts.every(x => typeof x.secured === 'boolean'),
  'every debt declares whether it is secured');

// Every debt also declares the CONVENTION its quoted rate is charged under, and
// it has to, because the payoff modeller prices it. `Forecast.payoffDebts`
// throws on an undeclared one rather than guessing — a broken tile beats a
// plausible wrong figure — and this is what keeps that throw unreachable on the
// published data instead of a surprise the household finds first.
const PAYOFF_CONVENTIONS = ['card', 'variable'];
ok(data.debts.every(x => PAYOFF_CONVENTIONS.includes(x.rateConvention)),
  'every debt declares a rate convention the payoff modeller knows',
  data.debts.map(x => `${x.id}=${x.rateConvention}`).join(' '));
// Two homes for the same fact, so they are checked against each other. A
// facility priced off a Prime spread is a variable one; a card is not.
for (const x of data.debts) {
  ok(/prime/i.test(x.rateBasis || '') === (x.rateConvention === 'variable'),
    `${x.id}'s stated rate basis and its declared convention agree`,
    `${x.rateBasis} / ${x.rateConvention}`);
}
// And the modeller can actually run on all of it.
ok(F.payoffDebts(plan, data.debts).length
  === data.debts.filter(x => x.balance + (x.pending || 0) > 0).length,
'the payoff modeller can model every debt that owes something today');

console.log('\n=== HELOC semantics agree everywhere ===');
const heloc = plan.obligations.find(o => o.id === 'heloc');
ok(heloc && heloc.nonCash === true,
  'the plan marks HELOC interest as a non-cash charge');
const withHeloc = F.simulate(plan, asOf, { scenario: 'expected', weeklyVariable: 0, targetBuffer: 500 });
const noCashMin = JSON.parse(JSON.stringify(plan));
noCashMin.obligations.find(o => o.id === 'heloc').cashPayment = 0;
const withoutCash = F.simulate(noCashMin, asOf, { scenario: 'expected', weeklyVariable: 0, targetBuffer: 500 });
const wantHelocCash = (F.capitalisingCashMinimumOccurrences(heloc, asOf, withHeloc.end) || [])
  .filter(occ => occ && !representedEventKeys(plan).has('heloc@' + occ.date))
  .reduce((s, occ) => s + Number(occ.amount || 0), 0);
ok(wantHelocCash > 0 && near(withoutCash.ending - withHeloc.ending, wantHelocCash),
  'encoded HELOC cashPayment moves cash once', `${money(withoutCash.ending)} vs ${money(withHeloc.ending)}`);
ok(near(withHeloc.totals.noncash, withoutCash.totals.noncash) && withHeloc.totals.noncash > 0,
  'while capitalise is still tracked as a real economic cost', money(withHeloc.totals.noncash));
// The economic cost has to appear on the debt side, or it is being hidden.
ok(/capitalis/i.test(read('docs/ACCOUNT_FACTS.md')),
  'ACCOUNT_FACTS records the capitalisation');
ok(/capitalis/i.test(JSON.stringify(plan.assumptions)),
  'and the plan assumptions say so too');

// One canonical HELOC fact, and no page may contradict it.
const helocDebt = data.debts.find(x => x.id === 'heloc');
ok(helocDebt.interestTreatment === 'capitalised',
  'the debt record is the canonical home for how HELOC interest is treated',
  helocDebt.interestTreatment);
ok(helocDebt.cashPayment === 0,
  'the debt record cashPayment stays $0 because interest itself is still capitalised', money(helocDebt.cashPayment));
ok(helocDebt.monthlyInterest > 0,
  'while the economic cost is stated separately', money(helocDebt.monthlyInterest));
ok(heloc.nonCash === true && near(heloc.amount, helocDebt.monthlyInterest),
  'the plan obligation agrees with it on both counts', money(heloc.amount));

// The mortgage is stated in two live places, and both are read. The debt
// record is the balance `Forecast.renewal` and `Forecast.projectDebts` both
// run on, and the plan obligation is what the renewal annualises into today's
// household cash. The `mortgage` block keeps remaining amortisation, maturity
// and prepayment room — standing facts — and is no longer a second home for
// the balance, rate, or bi-weekly payment.
const mortgageDebt = data.debts.find(x => x.id === 'mortgage');
const mortgageObligation = plan.obligations.find(o => o.debtId === 'mortgage');
ok(data.mortgage.balance == null && data.mortgage.rate == null
  && data.mortgage.paymentBiweekly == null,
  'the mortgage block no longer republishes the debt record\'s balance, rate, or payment');
ok(near(mortgageDebt.rate, 3.64),
  'the debt record is the live rate the renewal slider opens on',
  `${mortgageDebt.rate}%`);
ok(near(mortgageDebt.payment, mortgageObligation.amount)
  && mortgageObligation.frequency === 'biweekly',
'and the plan schedules exactly that payment, at that cadence',
`${money(mortgageObligation.amount)} ${mortgageObligation.frequency}`);
ok(near(mortgageDebt.cashPayment, mortgageObligation.amount),
  'and the debt record agrees it is cash that leaves an account',
  money(mortgageDebt.cashPayment));

// The Modeller added the $814.18 to the mortgage and called the total "today",
// which invented a household bill that nobody pays. The renewal arithmetic is
// `Forecast.renewal`'s now, so this is where the split has to hold — and the
// engine derives the $0.00 from the obligation being non-cash rather than
// reading a field, which `test-renewal.js` proves by making it cash.
const modellers = read('public/modellers.js');
const forecast = read('public/forecast.js');
// Code, not prose. A comment explaining a defect must not read as the defect,
// and a comment naming a rule must not stand in for the rule.
const codeOnly = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const forecastCode = codeOnly(forecast), modellersCode = codeOnly(modellers);
ok(/o\.nonCash/.test(forecastCode) && /cashPayment/.test(forecastCode),
  'the engine counts only cash obligations as household cash, including a capitalising cashPayment');
ok(!/heloc\.payment/.test(forecastCode) && !/heloc\.payment/.test(modellersCode),
  'and neither it nor the Modeller treats the capitalised charge as a payment');
ok(/interestTreatment === 'capitalised'/.test(forecastCode),
  'it branches on the canonical fact rather than assuming');
ok(/economic/i.test(modellers) && /helocEconomic/.test(forecastCode),
  'and the economic cost is labelled separately from household cash');

// Deep Dive listed it among ordinary dated payments. After B74 that list is
// expandEvents, not a hand-kept upcoming calendar.
const helocEvents = F.expandEvents(plan, asOf, F.addDays(asOf, (plan.windowDays || 91) - 1))
  .filter(e => e.id === 'heloc' || /HELOC/i.test(e.label));
const helocNoncash = helocEvents.filter(e => e.kind === 'noncash');
const helocCash = helocEvents.filter(e => e.kind === 'obligation');
ok(helocEvents.length > 0, 'the HELOC charge still appears on the dated list');
ok(helocNoncash.length > 0 && helocNoncash.every(e => e.effect === 'capitalise'),
  'capitalise remains non-cash, not a chequing outflow',
  helocNoncash.map(e => e.kind).join(', '));
ok(helocCash.length > 0 && helocCash.every(e => e.effect === 'payment' && e.cashMinimum === true),
  'and the encoded cash minimum is a separate obligation',
  helocCash.map(e => `${e.date}:${e.kind}`).join(', '));
ok(helocNoncash.every(e => !/minimum/i.test(e.label)),
  'the capitalise row is not called a "minimum"', helocNoncash.map(e => e.label).join(', '));
ok(/noncash/.test(read('public/deepdive.js')),
  'Deep Dive renders a non-cash row differently from a payment');

// The stale cash figures in the note predated the $79.84 household-cash model.
ok(!/roughly \$874|nearer \$590/.test(data.upcomingNote),
  'the upcoming note no longer quotes cash figures from the pre-classification model');
ok(/spendable household cash|household accounts hold/i.test(data.upcomingNote),
  'and still describes the spendable household position');

console.log('\n=== positions.csv cannot disagree with canonical state ===');
// It is DERIVED reporting output for its computed rows. Running the generator
// in --check mode is the invariant: if data.json has moved and the CSV has not,
// this fails rather than quietly publishing two balance sheets.
const posGen = require('child_process').spawnSync(process.execPath,
  ['scripts/positions-summary.js', '--check'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
ok(posGen.status === 0, 'positions.csv computed rows reconcile with data.json',
  posGen.status === 0 ? 'in step' : (posGen.stderr || '').split('\n').slice(0, 3).join(' | '));

// And the detail rows, which are a captured record rather than generated.
const csv = read('docs/positions.csv').split(/\r?\n/).map(r => {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    if (c === '"') { if (q && r[i + 1] === '"') { cur += '"'; i++; } else q = !q; continue; }
    if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
});
const csvVal = label => {
  const row = csv.find(c => c[2] === label);
  return row ? Number(row[6]) : null;
};
ok(near(csvVal('Total visible assets'), assetTotal),
  'the CSV asset total equals data.json', money(csvVal('Total visible assets')));
ok(near(csvVal('Total known debt'), debtTotal),
  'and the debt total', money(csvVal('Total known debt')));
ok(near(csvVal('Financial-account net worth'), assetTotal - debtTotal),
  'and financial-account net worth, which still excludes the home',
  money(csvVal('Financial-account net worth')));
const csvNote = label => {
  const row = csv.find(c => c[2] === label);
  return row ? String(row[20] || '') : '';
};
const homeEstimate = csvVal('Home');
ok(near(homeEstimate, 1200000),
  'Home detail is the 2026-08-29 owner planning estimate', money(homeEstimate));
ok(!near(homeEstimate, 1300000),
  'Home detail is not the $1.3m optimistic high', money(homeEstimate));
const homeRow = csv.find(c => c[2] === 'Home') || [];
ok(homeRow[19] === '2026-08-29',
  'Home as-of is the owner-decision date', homeRow[19] || 'missing');
ok(/2026-08-29/.test(csvNote('Home')) && /planning estimate/i.test(csvNote('Home')),
  'Home notes name the dated owner planning estimate');
ok(/optimistic high/i.test(csvNote('Home')),
  'Home notes label $1.3m as optimistic high only');
ok(/not an appraisal/i.test(csvNote('Home'))
  && /independently verified market value/i.test(csvNote('Home')),
  'Home notes refuse appraisal and verified-market claims');
ok(/1\.1m/.test(csvNote('Home')) && /historical/i.test(csvNote('Home')),
  'the older $1.1m–$1.4m range is kept only as dated historical evidence');
ok(!/midpoint/i.test(csvNote('Home') + csvNote('Household net worth')
  + csvNote('Home equity') + csvNote('Loan-to-value')),
  'positions notes do not call the current home value a midpoint');
ok(csv.filter(c => c[2] === 'Home').length === 1,
  'positions.csv has exactly one Home row — no second live optimistic number');
// Independent of scripts/positions-summary.js. Do not re-run regenerateComputedRows
// and assert its own output. Canonical assets/debts/secured come from data.json;
// the Home detail row is the owner planning estimate.
const independentHousehold = assetTotal + homeEstimate - debtTotal;
ok(near(csvVal('Household net worth'), independentHousehold),
  'Household net worth = owner home estimate + canonical assets − canonical debt',
  money(csvVal('Household net worth')));
ok(near(csvVal('Home equity'), homeEstimate - secured),
  'Home equity = owner home estimate − canonical secured debt',
  money(csvVal('Home equity')));
const independentLtvPct = (secured / homeEstimate) * 100;
const independentLtv = Math.round(independentLtvPct * 10) / 10;
ok(near(csvVal('Loan-to-value'), independentLtv, 0.05),
  'Loan-to-value = canonical secured debt / owner home estimate',
  `${independentLtvPct.toFixed(2)}% → ${independentLtv}`);
ok(/owner-estimated home planning value/i.test(csvNote('Household net worth')),
  'generated household net worth names an owner-estimated planning value');
const csvAsOf = label => {
  const row = csv.find(c => c[2] === label);
  return row ? String(row[19] || '') : '';
};
ok(csvAsOf('Household net worth') >= homeRow[19],
  'household net-worth as-of is not earlier than the home estimate',
  csvAsOf('Household net worth'));
ok(csvAsOf('Home equity') >= homeRow[19],
  'home-equity as-of is not earlier than the home estimate',
  csvAsOf('Home equity'));
ok(csvAsOf('Loan-to-value') >= homeRow[19],
  'loan-to-value as-of is not earlier than the home estimate',
  csvAsOf('Loan-to-value'));
ok(csvAsOf('Financial-account net worth') === data.meta.asOf,
  'financial-account net worth keeps the opening as-of',
  csvAsOf('Financial-account net worth'));
ok(csvAsOf('Essential spending estimate') >= (periods.source && periods.source.coverageThrough || periods.asOf),
  'essential-spending as-of is not earlier than historical actuals',
  csvAsOf('Essential spending estimate'));
ok(csvAsOf('Weeks of essentials covered') >= (periods.source && periods.source.coverageThrough || periods.asOf),
  'weeks-of-essentials as-of is not earlier than historical actuals',
  csvAsOf('Weeks of essentials covered'));
ok(/historical actuals through 2026-08-24/.test(csvNote('Essential spending estimate')),
  'essential-spending notes the later historical-actuals input');
{
  const ownerTargetDates = (plan.budget.categories || [])
    .map(c => (/owner-stated-(\d{4}-\d{2}-\d{2})/.exec(String(c && c.targetSource || '')) || [])[1])
    .filter(Boolean)
    .sort();
  const latestOwnerTarget = ownerTargetDates[ownerTargetDates.length - 1] || '';
  ok(latestOwnerTarget >= '2026-10-04',
    'independent latest owner-stated date includes the Other instruction and later approved targets',
    latestOwnerTarget);
  ok(csvAsOf('Essential spending estimate') >= latestOwnerTarget,
    'essential-spending as-of is not earlier than the latest owner budget target',
    `${csvAsOf('Essential spending estimate')} vs ${latestOwnerTarget}`);
  ok(csvAsOf('Weeks of essentials covered') >= latestOwnerTarget,
    'weeks-of-essentials as-of is not earlier than the latest owner budget target',
    `${csvAsOf('Weeks of essentials covered')} vs ${latestOwnerTarget}`);
  ok(new RegExp(`owner budget target ${latestOwnerTarget}`).test(csvNote('Essential spending estimate'))
      && new RegExp(`owner budget target ${latestOwnerTarget}`).test(csvNote('Weeks of essentials covered')),
    'derived essentials notes name the later owner-target input');
}
ok(/2026-08-19/.test(csvNote('Household net worth'))
  && /2026-08-29/.test(csvNote('Household net worth')),
  'household net-worth notes preserve both input dates');
{
  const q3 = (/### Q3\.[\s\S]*?(?=\n### |\n## )/.exec(read('docs/01_OPEN_QUESTIONS.md')) || [''])[0];
  ok(!/currently unstateable/i.test(q3),
    'Q3 does not say household net worth is currently unstateable');
  ok(/planning estimate/i.test(q3) && /appraisal/i.test(q3),
    'Q3 distinguishes the planning estimate from the verified-value question');
  ok(/\*\*Status:\*\*\s*OPEN/.test(q3),
    'Q3 remains OPEN for a comparable sale or appraisal');
  ok(/1,200,000/.test(q3) && /2026-08-29/.test(q3),
    'Q3 records the 2026-08-29 $1,200,000 planning estimate');
  ok(/optimistic high/i.test(q3) && /1,300,000/.test(q3),
    'Q3 keeps $1,300,000 as optimistic high only');
  ok(/dated planning evidence/i.test(q3),
    'the 2026-08-21 $1.3m figure is dated planning evidence, not current authority');
}
{
  const caveat = String((data.netWorth && data.netWorth.caveat) || '');
  ok(/positions reporting path/i.test(caveat) && /2026-08-29/.test(caveat),
    'Records caveat routes the current point figure to the 2026-08-29 positions path');
  ok(/1,200,000/.test(caveat),
    'Records caveat names the $1,200,000 planning estimate');
  ok(/optimistic high/i.test(caveat) && /1,300,000/.test(caveat),
    'Records caveat labels $1,300,000 as optimistic high only');
  ok(/historical/i.test(caveat) && /1\.1m/.test(caveat),
    'Records caveat keeps the $1.1m–$1.4m range as historical only');
  ok(!/At the owner's estimate of \$1\.1m/i.test(caveat),
    'Records caveat does not present the old range as the current estimate');
}
ok(csvVal('Silver bullion') != null,
  'the silver has a position row — its absence was the drift',
  money(csvVal('Silver bullion') || 0));
// Every debt in data.json must have a matching CSV row at the same balance.
for (const x of data.debts) {
  const row = csv.find(c => c[4] === 'Liability' && Math.abs(Number(c[6]) - x.balance) < 0.01);
  ok(!!row, `debt "${x.label}" has a matching position row`, money(x.balance));
}

console.log('\n=== the page does not contradict itself ===');
// Three ways it did, all found by exact-head review of a84b7e9.
const planJs2 = read('public/plan.js');
// The same source with comments removed, for the assertions that prove an
// expression is GONE. A comment naming the defect it describes is the normal
// way this repository records what moved and why — and a bare regex cannot tell
// that record apart from the code it replaced, so it reports the page as still
// doing the thing the comment says it stopped doing. The page carries no `//`
// inside a string or template literal, which is what makes this safe.
const planJs2Code = planJs2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// 1. A funding source was chosen on `unusable` alone, so raising the buffer
//    knob past a source's balance still credited the full amount as a
//    debt-free transfer and declared the plan sound.
// Finish-line audit finding 12: the page's recommend inputs come from the one
// shared builder, which is where the ranked sources are handed over.
ok(/Forecast\.budgetRecommendInputs\(d,/.test(planJs2Code)
    && /fundingSources: plan\.funding && plan\.funding\.options/.test(read('public/forecast.js')),
  'the page hands the ranked sources to the engine rather than choosing one itself');
ok(/advice\.funding/.test(planJs2), 'and reads the allocation back');
{
  const SRC = { scenario: 'expected', incomeOverrides: {}, disabled: [], extraDebtMonthly: 0,
    fundingSources: plan.funding.options, debts: data.debts, extraFacilities: data.revolvingExtra };
  const amandaFund = liveFunding().find(o => o.id === 'amanda');
  ok(amandaFund && near(amandaFund.available, 0)
      && (cash.heldElsewhere || []).some(h => h.id === 'amanda-debt-payments' && h.value > 0),
    'Amanda\'s held-elsewhere locator is not household funding while Q25 is OPEN',
    amandaFund ? money(amandaFund.available) : 'missing');
  const ranked = liveFunding().slice().sort((a, b) => a.rank - b.rank)
    .filter(o => !o.unusable && !o.debtId && o.available > 0);
  const usable = ranked.reduce((s, o) => s + o.available, 0);
  const floorNow = openingFloor(plan, asOf);
  const unfundedBuf = usable + 2000 + floorNow;
  const defaultBuf = Math.max(plan.defaults.targetBuffer, Math.ceil(floorNow + 50));

  // A buffer just above the floor: Q25 keeps Amanda at 0, so no cash source
  // remains. HELOC headroom is not automatic permission to draw.
  const base = F.recommend(plan, asOf, Object.assign({}, SRC, { targetBuffer: defaultBuf }));
  ok(base.funding && base.funding.feasible === false && base.funding.borrowed === 0,
    'just above the floor, HELOC capacity alone does not fund the gap',
    base.funding ? `shortfall ${money(base.funding.shortfall)}` : 'no funding');
  ok(!(base.funding.parts || []).some(p => p.id === 'heloc' || p.debtId),
    'and no debtId source is injected',
    (base.funding.parts || []).map(p => p.id).join(' + ') || 'none');

  // Combination still works from explicit non-debt planning available.
  const overlay = plan.funding.options.map(o => {
    if (o.id === 'amanda') return Object.assign({}, o, { cash: undefined, available: 800 });
    if (o.id === 'heloc') return Object.assign({}, o, { debtId: null, available: 900 });
    return o;
  });
  const overlayRanked = F.resolveFundingSources(overlay, data.revolvingExtra, plan, data.debts)
    .filter(o => !o.unusable && !o.debtId && o.available > 0)
    .sort((a, b) => a.rank - b.rank);
  const combineBuf = overlayRanked[0].available + overlayRanked[1].available / 2 + floorNow;
  const big = F.recommend(plan, asOf, Object.assign({}, SRC, {
    fundingSources: overlay, targetBuffer: combineBuf }));
  ok(big.gap.amount > overlayRanked[0].available,
    'at a combination-sized buffer the gap exceeds the largest single cash source',
    `${money(big.gap.amount)} vs ${money(overlayRanked[0].available)}`);
  ok(big.funding.feasible && big.funding.needsCombination,
    'but two cash sources reach it, so the plan is feasible',
    big.funding.parts.map(p => `${p.short} ${money(p.amount)}`).join(' + '));
  ok(near(big.funding.borrowed, 0),
    'and none of that combination is borrowed', money(big.funding.borrowed));
  const bigProj = F.projectDebts(plan, data.debts, asOf,
    Object.assign({}, big.simOptions, { weeklyVariable: big.weekly, extraFacilities: data.revolvingExtra }));
  ok(near(bigProj.byId.heloc.drawn, 0),
    'the debt projection records no HELOC draw for a cash combination', money(bigProj.byId.heloc.drawn));

  // Beyond every source combined: infeasible, and modelled as such.
  const huge = F.recommend(plan, asOf, Object.assign({}, SRC, { targetBuffer: unfundedBuf }));
  ok(!huge.funding.feasible && huge.funding.shortfall > 0,
    'a gap beyond every source combined is reported unfunded, not silently filled',
    money(huge.funding.shortfall));
  const injected = huge.funding.parts.reduce((a, p) => a + p.amount, 0);
  ok(injected < huge.gap.amount,
    'and only what can actually be funded is injected',
    `${money(injected)} of ${money(huge.gap.amount)}`);
}
// These two asserted the page held its own `fundingShort` and
// `needsCombination` expressions. Both moved: `Forecast.planStatus` decides the
// unfundable verdict, `Forecast.nextMove` the unfundable outcome, and the
// combination is `recommend`'s funding result. Re-pointed rather than deleted —
// the demonstrated failure is the page having NO state for either, publishing
// success copy over a gap nothing can fund. `fundingShort` in fact still matched
// here, inside the comment recording that it moved, which is exactly the regex
// this repository already knows cannot tell a record from the code it replaced.
ok(/^  unfunded: \{/m.test(planJs2Code) && /^  unfunded: s =>/m.test(planJs2Code),
  'the page words an unfundable gap, in both the band and the next move');
ok(/^  combination: \{/m.test(planJs2Code) && /^  partial: s =>/m.test(planJs2Code),
  'and a gap that takes more than one source, in both');
// The funding cards judged sources against the day's payment while the band
// judged them against the gap, so they disagreed on screen.
ok(/const needed = fundingGap/.test(planJs2),
  'the funding cards are judged against the gap, not the day\'s payment');
ok(!/const enough = o\.available >= dueThatDay/.test(planJs2),
  'the old dueThatDay verdict is gone');

// 2. Two budget explanations on one page disagreed about provenance: the cap
//    section said nine owner targets, the detailed section said none.
ok(!/No owner-built budget has been supplied/.test(planJs2),
  'the detailed budget no longer claims no owner budget exists');
ok(!/every figure here is a historical actual/.test(planJs2),
  'nor that every figure is a historical actual');
ok(/ownerTargetCount/.test(planJs2),
  'both budget explanations count the owner targets from the same result');

// 3. Consumer debt appeared twice under one label, $247.18 apart, because the
//    compact snapshot summed raw balances while the tile used the projection.
ok(!/const consumer = d\.debts\.filter\(x => !x\.secured\)/.test(planJs2),
  'the compact snapshot no longer re-sums raw balances for consumer debt');
ok(/const consumer = today\.consumer/.test(planJs2),
  'it reuses the projected day-zero figure the tile shows');

// 4. Borrowing status was read from the single-source case, so a two-part
//    allocation containing an $851.31 HELOC draw reported "creates no debt".
//    The only thing that judgement still gated was whether to offer a facility
//    as an alternative funder, and that moved into `Forecast.counterfactuals`
//    with the alternative itself. It is now asked per facility against the
//    whole allocation — a stricter reading of the same rule, since another
//    facility's draw says nothing about this one. `test-counterfactuals.js`
//    proves it bites; this only holds the page out of the decision.
ok(/funding\.parts\.some\(p => p\.debtId === option\.debtId\)/.test(forecastCode),
  'borrowing status comes from the whole allocation, not just a lone source');
ok(!/fundingIsDraw/.test(planJs2Code),
  'and the page no longer decides it at all');

// 5. The Next move card promised a restored buffer even when the gap cannot be
//    fully funded and the window stays below it. The condition it is gated on
//    is now Forecast.planStatus's `unfunded` verdict rather than the page's own
//    `fundingShort`, so the gate is asserted where it now lives.
ok(/Forecast\.planPhases\(/.test(planJs2),
  'the opening phase body comes from the engine, gated on whether the gap is fundable');
ok(!/status\.id === 'unfunded'/.test(planJs2Code),
  'and the page no longer re-reads the status verdict to pick that body');
ok(/openingId = fundingShort \? 'unfunded'/.test(forecastCode),
  'the engine selects the unfunded opening phase from the funding result');

// 6. The Modeller charged SIMPLE interest on a balance the same page says
//    capitalises, then reported the opening balance as still owed. The fix
//    moved with the arithmetic into the engine. A declared cash minimum is
//    applied against that same monthly compounding; unpaid still uses
//    opening × (1+r)^n.
ok(/const helocMonthlyRate = RATE_BASIS\.variable\(heloc \? heloc\.rate : 0\)/.test(forecastCode),
  'the engine compounds capitalised HELOC interest at the monthly charge cadence');
ok(/Math\.pow\(1 \+ helocMonthlyRate, helocMonths\)/.test(forecastCode),
  'unpaid capitalise still uses monthly compounding, not an annual exponent');
ok(/owed \+= charge - helocCash/.test(forecastCode),
  'and a declared cash minimum is a payment against that compounding balance');
// The HELOC is prime-linked whatever the mortgage renews into. Pricing it on a
// fixed renewal convention would invent a rate the facility does not carry.
ok(/RATE_BASIS\.variable\(heloc \? heloc\.rate : 0\)/.test(forecastCode),
  'and on the HELOC\'s own variable convention, not the renewal\'s');
ok(!/Math\.pow\(/.test(/\nfunction setupRenewal\(d\) \{[\s\S]*?\n\}\n/.exec(modellersCode)[0]),
  'and the Modeller compounds nothing of its own');
// The benefit of stopping capitalisation only exists after consolidating; the
// row was shown in keep-separate mode, contradicting the note beneath it.
ok(/id: consolidate \? 'stopped' : 'continues'/.test(forecastCode),
  'the stopped-capitalisation row is gated on actually consolidating');
ok(/still capitalising/.test(modellers),
  'and the keep-separate case says the opposite, as it should');
{
  // At the default horizon the difference is not a rounding matter, and the
  // cadence matters too: monthly against annual is another $9,212.
  const h = data.debts.find(x => x.id === 'heloc');
  const r = h.rate / 100;
  const annual = h.balance * Math.pow(1 + r, 18);
  const monthly = h.balance * Math.pow(1 + r / 12, 12 * 18);
  ok(monthly > h.balance * 2,
    'over 18 years a capitalising HELOC more than doubles',
    `${money(h.balance)} → ${money(monthly)}`);
  ok(monthly - annual > 9000,
    'and compounding monthly rather than annually is worth another $9,212',
    money(monthly - annual));
  // The charge really is monthly — the cadence is not an assumption.
  const helocObl = plan.obligations.find(o => o.id === 'heloc');
  ok(helocObl.frequency === 'monthly',
    'the plan records the charge as monthly, which is the cadence used',
    helocObl.frequency);
}
// A boolean cannot describe a mixed funding plan.
ok(/fundingPlan\.parts\.map/.test(planJs2),
  'the scoreboard renders the allocated parts rather than a single source');
ok(!/'the top-ranked source'/.test(planJs2),
  'and no longer calls a two-part plan "the top-ranked source"');
ok(/drawn > 0 \? 'helocDrawn'/.test(forecastCode),
  'the HELOC risk says whether THIS plan draws on it');
ok(!/helocDrawn > 0/.test(planJs2Code),
  'and the page no longer decides that');
// The cap qualifier attached one simulation's condition to another's answer.
// The separate full-coverage evaluation belongs to `Forecast.counterfactuals`
// now; the page reads its result and composes no second scenario.
ok(/ifCovered\.applies/.test(planJs2) && /ifCovered\.weekly/.test(planJs2),
  'a partly-funded cap reports what full coverage would allow, separately');
ok(!/available: Infinity/.test(planJs2Code),
  'and no longer invents an infinite funding source to get it');
// Written once. The same sentence on the tile and the headline meant fixing
// one and leaving the other describing a different simulation.
ok((planJs2.match(/once the \$\{money\(fundingGap\)\} gap is covered/g) || []).length === 1,
  'the cap qualifier is composed in exactly one place',
  `${(planJs2.match(/once the \$\{money\(fundingGap\)\} gap is covered/g) || []).length} occurrence(s)`);
ok(/capQualifier/.test(planJs2) &&
   (planJs2.match(/\$\{capQualifier\}/g) || []).length >= 2,
  'and both the tile and the headline read that one value');
// The first action carries a fixed amount; claiming it restores the buffer is
// only true when that amount actually reaches the current gap. This asserted
// the page still held `actionCovers`, and that expression has moved into
// `Forecast.nextMove`. Re-pointed rather than deleted: the demonstrated failure
// it guarded — the outcome decided on feasibility rather than on the current
// gap — is now guarded at its new home, where `test-nextmove.js` proves it on
// the published plan at three buffers and breaks the comparison three ways to
// show it is load-bearing. What is left here is that the page asks rather than
// decides.
ok(/Forecast\.nextMove\(/.test(planJs2),
  'the Next move outcome comes from the engine, judged against the current gap');
ok(!/actionCovers/.test(planJs2Code) && !/actionLeaves/.test(planJs2Code),
  'and the page no longer compares the action amount with the gap, or subtracts them');
// An override that breaches must be reported as a breach, whatever else is
// true about the opening gap. The engine decides that now — the page reads the
// verdict, and `test-status-band.js` proves the selection and its ordering by
// running the engine rather than by reading the page. This asserted the
// next-move card re-read `status.id` to choose between its own five outcomes;
// that selection moved too, so what is asserted here is that the card no longer
// re-reads the verdict, and that the breach survives the move at every buffer
// the household can set — which is where it used to be lost.
ok(!/status\.id === 'overrideBreach'/.test(planJs2Code),
  'the next-move card no longer re-reads the status verdict to pick its own outcome');
ok(/NEXT_MOVE\[move\.id\]\(move\)/.test(planJs2Code),
  'it renders the one outcome the engine selected');
{
  const O = { scenario: 'expected', incomeOverrides: {}, disabled: [], extraDebtMonthly: 0,
    targetBuffer: 500, fundingSources: plan.funding.options };
  for (const targetBuffer of [0, 500, 1000, 1500, 2000, 3000]) {
    const a = F.recommend(plan, asOf, Object.assign({}, O, { targetBuffer }));
    const s = F.simulate(plan, asOf, Object.assign({}, a.simOptions, { weeklyVariable: 1500 }));
    const m = F.nextMove(plan, a, { weeklyOverride: 1500, sim: s });
    if (s.min.balance < targetBuffer - 0.005) {
      ok(m.id === 'overrideBreach' || (m.id === 'partial' && m.overrideUnsupported === true)
        || m.id === 'unfunded' || m.id === 'windowEnding',
        `a breaching $1,500/week is still said at a $${targetBuffer} buffer`,
        `${m.id}${m.id === 'partial' ? ` + override warning` : ''}`);
    } else {
      ok(m.id !== 'overrideBreach',
        `when $1,500/week holds a $${targetBuffer} buffer it is not reported as a breach`,
        m.id);
    }
  }
}
// The note named categories that stopped being $0 when sinking funds were split.
ok(/fullyDatedNames/.test(planJs2),
  'the fully-dated categories are derived, not named in prose');
ok(!/Insurance and children's sports show \$0/.test(planJs2),
  'and the stale sentence claiming sports shows $0 is gone');
// The ledger has to add up on the page, not just in the engine.
ok(/T\.injections > 0/.test(planJs2),
  'gap funding appears as its own ledger row so the rows reconcile');
ok(/T\.reserved > 0/.test(planJs2) && /anyReserved/.test(planJs2),
  'reserved current-regime is its own ledger row and weekly column, not the Budget cap');
ok(/Reserved current-regime/.test(planJs2) && /Budget \$\{money\(w\.variable\)\}/.test(planJs2)
  && /Reserved \$\{money\(w\.reserved\)\}/.test(planJs2),
  'the page labels Budget as the cap and Reserved as the undated drain');
// And in the weekly table and the mobile cards, which had the same problem one
// level down: week 1 opened at $79.84, its visible rows implied $1,695.58 and
// it displayed $2,738.74.
ok(/anyInjection/.test(planJs2), 'the weekly table gains a gap-funding column when there is one');
ok(/w\.injections \? ` \+ \$\{money\(w\.injections\)\} funding`/.test(planJs2),
  'and the mobile card includes it in the inflow line');
{
  const O = { scenario: 'expected', incomeOverrides: {}, disabled: [], extraDebtMonthly: 0,
    targetBuffer: 500, fundingSources: plan.funding.options };
  const adv = F.recommend(plan, asOf, O);
  for (const w of adv.sim.weeks) {
    const implied = w.opening + w.confirmedIncome + w.estimatedIncome + w.injections
      - w.obligations - w.bills - w.commitments - w.variable - (w.reserved || 0) - w.extra;
    if (!near(implied, w.closing, 0.02)) {
      ok(false, `week ${w.n} reconciles from its displayed columns`,
        `${implied.toFixed(2)} vs ${w.closing.toFixed(2)}`);
    }
  }
  // Asserted, not reported. Without this the summary passes over an empty week
  // list and claims every week reconciles when none was examined.
  ok(adv.sim.weeks.length >= 13,
    'every week reconciles from opening + inflows − outflows to its closing',
    `${adv.sim.weeks.length} weeks compared`);
}
// An unfunded gap outranks an override breach: at that buffer no weekly figure
// fixes it, so blaming spending points at the wrong thing.
//
// This was a source-order regex over public/plan.js, asserting that the string
// `if (gap && fundingShort)` appeared before `} else if (gap &&
// overrideBreaches)`. It is retired here rather than kept beside its
// replacement, because it protected the ordering of two strings and nothing
// about what either branch concluded — B73 recorded both band mutations passing
// under it. The ordering now lives in `Forecast.planStatus`, and
// `test-status-band.js` proves it by reordering the engine's own branches and
// requiring an unfundable gap under a breaching override to stop reading
// `unfunded`. The sentence itself is still asserted, on the page's wording map.
ok(/No weekly spending\s*\n?\s*figure fixes this/.test(planJs2),
  'and says plainly that no spending figure fixes it');
// The mission and the Next move must not instruct an unsafe override either.
// The mission is decided in the engine now, so this is asserted on what it
// returns rather than on the page's wording: a regex over plan.js could only
// ever prove a sentence exists somewhere in the file.
{
  const O = { scenario: 'expected', incomeOverrides: {}, disabled: [], extraDebtMonthly: 0,
    targetBuffer: plan.defaults.targetBuffer, fundingSources: plan.funding.options, debts: data.debts,
    extraDebtTarget: plan.nextDollar.target };
  const adv = F.recommend(plan, asOf, O);
  const walk = (o, weekly) => F.projectDebts(plan, data.debts, asOf,
    Object.assign({}, o.simOptions, { weeklyVariable: weekly,
      extraFacilities: data.revolvingExtra, extraDebtTarget: plan.nextDollar.target }));
  const overAmt = adv.weekly + 500;
  const over = F.simulate(plan, asOf, Object.assign({}, adv.simOptions, { weeklyVariable: overAmt }));
  const breached = F.mission(adv, walk(adv, overAmt), { weeklyOverride: overAmt, sim: over });
  const cut = breached.parts.find(p => p.id === 'cutSpending');
  ok(!!cut && cut.supported === adv.weekly && cut.unsupported === overAmt,
    'the mission stops instructing a weekly figure that breaches',
    cut ? `cut to $${cut.supported}, $${cut.unsupported} named as failing`
      : breached.parts.map(p => p.id).join(' → '));

  // A buffer no combination of sources can reach. Spending is not a remedy for
  // money that does not exist: at any weekly figure the floor stays under the
  // buffer, so no weekly figure may be instructed at all.
  const usable = liveFunding().filter(o => !o.unusable && !o.debtId)
    .reduce((s, o) => s + o.available, 0);
  const unfundedBuf = usable + 2000 + openingFloor(plan);
  const unreachable = F.recommend(plan, asOf, Object.assign({}, O, { targetBuffer: unfundedBuf }));
  const unfunded = F.mission(unreachable, walk(unreachable, unreachable.weekly),
    { weeklyOverride: null, sim: unreachable.sim });
  ok(unreachable.funding && !unreachable.funding.feasible,
    'and a buffer beyond every usable source really does outrun them',
    unreachable.funding ? money(unreachable.funding.shortfall) + ' unfunded' : 'no funding result');
  ok(!unfunded.parts.some(p => p.id === 'holdSpending' || p.id === 'cutSpending'),
    'so the mission offers no spending instruction at all when the gap cannot be funded',
    unfunded.parts.map(p => p.id).join(' → '));
}
// Split funding must not be measured half-applied.
{
  const overlay = plan.funding.options.map(o => {
    if (o.id === 'amanda') return Object.assign({}, o, { cash: undefined, available: 800 });
    if (o.id === 'heloc') return Object.assign({}, o, { debtId: null, available: 900 });
    return o;
  });
  const ranked = F.resolveFundingSources(overlay, data.revolvingExtra, plan, data.debts)
    .slice().sort((a, b) => a.rank - b.rank).filter(o => !o.unusable && !o.debtId && o.available > 0);
  const combineBuf = ranked[0].available + ranked[1].available / 2 + openingFloor(plan, asOf);
  const O = { scenario: 'expected', incomeOverrides: {}, disabled: [], extraDebtMonthly: 0,
    targetBuffer: combineBuf, fundingSources: overlay, debts: data.debts,
    extraFacilities: data.revolvingExtra };
  const adv = F.recommend(plan, asOf, O);
  const onDay = adv.sim.events.filter(e => e.date === adv.gap.date && e.kind === 'injection');
  ok(onDay.length === 1,
    'a top-up drawn from two cash sources is ONE cash event', `${onDay.length} injection event(s)`);
  ok(onDay[0].parts && onDay[0].parts.length === 2,
    'while still carrying both cash origins',
    onDay[0].parts.map(p => p.debtId || 'cash').join(' + '));
  ok(adv.holds && adv.weekly >= 0,
    'so the day closes on the buffer and the cap survives the split',
    `$${adv.weekly}/week, floor ${money(adv.sim.min.balance)}`);
  ok(near(adv.sim.min.balance, combineBuf),
    'the floor is the day’s close, not a figure from mid-transfer',
    money(adv.sim.min.balance));
  const pr = F.projectDebts(plan, data.debts, asOf,
    Object.assign({}, adv.simOptions, { weeklyVariable: adv.weekly, extraFacilities: data.revolvingExtra }));
  ok(near(pr.byId.heloc.drawn, 0) && near(adv.funding.borrowed, 0),
    'a cash combination does not land a HELOC draw', money(pr.byId.heloc.drawn));
}

// Money paid toward debt has to arrive somewhere. simulate() takes the whole
// payment out of cash before projectDebts() sees it, so clamping a balance at
// zero deletes the overshoot rather than saving it: at $2,000/month, $6,340.00
// left the account against $5,737.68 of Cash Back Visa and interest, and
// $602.32 reduced nothing at all. The identity below is the real guarantee —
// it is checked at payment sizes either side of clearing the target, and at
// one large enough to clear several cards.
{
  const sizes = [0, 500, 2000, 5000, 12000];
  for (const extra of sizes) {
    // `debts` passed, because that is how the page calls it and it is what lets
    // the engine size a payment against the debt that exists. Without it these
    // once passed for the wrong reason: nothing was discarded only because a
    // paid-off card's minimum was being cascaded onto another card, which is a
    // payment nobody makes. Capped properly, an uncapped run SHOULD report a
    // residual — so testing the uncapped path here was testing the defect.
    const adv = F.recommend(plan, asOf, { scenario: 'expected', incomeOverrides: {},
      disabled: [], extraDebtMonthly: extra, targetBuffer: plan.defaults.targetBuffer,
      fundingSources: plan.funding.options, debts: data.debts,
      extraDebtTarget: plan.nextDollar.target });
    const pr = F.projectDebts(plan, data.debts, asOf, Object.assign({}, adv.simOptions,
      { weeklyVariable: adv.weekly, extraFacilities: data.revolvingExtra,
        extraDebtTarget: plan.nextDollar.target }));
    let open = 0, close = 0, interest = 0, paid = 0, drawn = 0;
    for (const d of data.debts) {
      const s = pr.byId[d.id];
      open += d.balance + (d.pending || 0);
      close += s.balance; interest += s.interest; paid += s.paid; drawn += s.drawn;
    }
    ok(near(close, open + interest + drawn - paid),
      `at ${money(extra)}/month extra, every dollar paid reduces a balance`,
      `closing ${money(close)} vs opening+interest+drawn−paid ${money(open + interest + drawn - paid)}`);
    ok(Math.abs(pr.unabsorbed) < 0.005,
      `and nothing is discarded at ${money(extra)}/month`, money(pr.unabsorbed));
  }
  // The specific case Codex reported, and the cascade that now catches it.
  // A 16 August window contains two mid-month extras (15 Sep, 15 Oct).
  // $2,000 × 2 leaves Cash Back open; $3,000 × 2 clears the posted opening
  // plus interest, so the overshoot is a real remainder.
  const CLEAR_EXTRA = 3000;
  const adv = F.recommend(plan, asOf, { scenario: 'expected', incomeOverrides: {},
    disabled: [], extraDebtMonthly: CLEAR_EXTRA, targetBuffer: plan.defaults.targetBuffer,
    fundingSources: plan.funding.options });
  const pr = F.projectDebts(plan, data.debts, asOf, Object.assign({}, adv.simOptions,
    { weeklyVariable: adv.weekly, extraFacilities: data.revolvingExtra,
      extraDebtTarget: plan.nextDollar.target }));
  ok(pr.byId.cashback.balance < data.debts.find(x => x.id === 'cashback').balance,
    `at ${money(CLEAR_EXTRA)}/month the target card is paid down inside the window`,
    money(pr.byId.cashback.balance));
  const tdccOpen = data.debts.find(x => x.id === 'tdcc').balance + (data.debts.find(x => x.id === 'tdcc').pending || 0);
  ok(pr.byId.tdcc.balance < tdccOpen - 500,
    'and the overshoot moves to the next highest-rate consumer debt, not nowhere',
    `TD credit card ${money(tdccOpen)} → ${money(pr.byId.tdcc.balance)}`);
  // The order must stay inside Forecast rather than becoming a page ranking.
  // A payment cannot be larger than the debt left to receive it. Once the
  // cascade is exhausted the money must stay in the account — returning an
  // `unabsorbed` figure nobody reads does not make the projection right.
  // At $80,000/month the third payment had $7,584.05 with nowhere to go while
  // cash lost all of it.
  {
    const O = { scenario: 'expected', incomeOverrides: {}, disabled: [],
      extraDebtMonthly: 80000, targetBuffer: plan.defaults.targetBuffer,
      fundingSources: liveFunding(), extraDebtTarget: plan.nextDollar.target };
    const uncapped = F.recommend(plan, asOf, O);
    const capped = F.recommend(plan, asOf, Object.assign({}, O, { debts: data.debts }));
    const spent = s => s.sim.events.filter(e => e.kind === 'extra')
      .reduce((a, e) => a + Math.abs(e.amount), 0);
    ok(spent(capped) <= spent(uncapped),
      'an extra payment is not larger when debts are supplied for the cap',
      `${money(spent(uncapped))} asked, ${money(spent(capped))} spent`);
    ok(capped.sim.ending > uncapped.sim.ending,
      'so the remainder stays as cash instead of draining away',
      `${money(capped.sim.ending - uncapped.sim.ending)} kept`);
    // Capping must change the CASH side only. Measuring the caps before the gap
    // injection was known made them $956.81 too small, quietly paying the HELOC
    // down less than the household actually could.
    const walk = a => F.projectDebts(plan, data.debts, asOf, Object.assign({}, a.simOptions,
      { weeklyVariable: a.weekly, extraFacilities: data.revolvingExtra,
        extraDebtTarget: plan.nextDollar.target }));
    const pu = walk(uncapped), pc = walk(capped);
    ok(data.debts.every(d => near(pu.byId[d.id].balance, pc.byId[d.id].balance, 0.02)),
      'and every closing balance is identical with and without the cap',
      'capping is a cash correction, not a debt one');
    // What `unabsorbed` reports must be the real gap between cash out and debt
    // down, or it is just another number nobody can act on.
    const cashOut = capped.sim.events
      .filter(e => e.amount < 0 && (e.kind === 'extra' || e.kind === 'obligation'))
      .reduce((a, e) => a + Math.abs(e.amount), 0);
    const paidOn = data.debts.reduce((a, d) => a + pc.byId[d.id].paid, 0);
    const prepaidDebt = independentlyRepresentedPrepaidDebtAbsorbed(
      plan, data.debts, asOf, Object.assign({}, capped.simOptions, {
        weeklyVariable: capped.weekly, extraFacilities: data.revolvingExtra,
        extraDebtTarget: plan.nextDollar.target,
      }));
    ok(near(pc.unabsorbed, cashOut + prepaidDebt - paidOn),
      'and the reported unabsorbed figure is exactly the cash that reduced nothing',
      `${money(pc.unabsorbed)}`);
    ok(Math.abs(pc.unabsorbed) < 0.005,
      'nothing at all is left unabsorbed', money(pc.unabsorbed));
  }

  // The same rule has to hold for DATED MINIMUMS, not just extras. Capping one
  // and not the other left $693.11 leaving cash against balances already at
  // zero — the two projections still disagreeing, just by less. "A scheduled
  // minimum is contractual" was the wrong reason to leave it: the obligation is
  // to a BALANCE, and a bank does not take a minimum on a card that is paid off.
  // Checked at an input far past anything reachable, because that is where the
  // rule is tested rather than merely satisfied.
  for (const extra of [80000, 500000]) {
    const O = { scenario: 'expected', incomeOverrides: {}, disabled: [],
      extraDebtMonthly: extra, targetBuffer: plan.defaults.targetBuffer,
      fundingSources: plan.funding.options, extraDebtTarget: plan.nextDollar.target,
      debts: data.debts };
    const adv = F.recommend(plan, asOf, O);
    const pr = F.projectDebts(plan, data.debts, asOf, Object.assign({}, adv.simOptions,
      { weeklyVariable: adv.weekly, extraFacilities: data.revolvingExtra,
        extraDebtTarget: plan.nextDollar.target }));
    const cashOut = adv.sim.events
      .filter(e => e.amount < 0 && (e.kind === 'extra' || e.kind === 'obligation'))
      .reduce((a, e) => a + Math.abs(e.amount), 0);
    const landed = data.debts.reduce((a, d) => a + pr.byId[d.id].paid, 0);
    const prepaidDebt = independentlyRepresentedPrepaidDebtAbsorbed(
      plan, data.debts, asOf, Object.assign({}, adv.simOptions, {
        weeklyVariable: adv.weekly, extraFacilities: data.revolvingExtra,
        extraDebtTarget: plan.nextDollar.target,
      }));
    ok(near(cashOut + prepaidDebt, landed),
      `at ${money(extra)}/month, every dollar leaving cash for debt lands on one`,
      `${money(cashOut)} out + ${money(prepaidDebt)} prepaid, ${money(landed)} landed`);
    // Sub-cent, not exactly zero: subtracting a quarter-million dollars in
    // pieces leaves float residue (8.4e-11 here), which is arithmetic noise
    // rather than money. A cent is the smallest amount that could be one.
    ok(Math.abs(pr.unabsorbed) < 0.005,
      `and nothing is unabsorbed at ${money(extra)}/month`,
      pr.unabsorbed === 0 ? '$0.00 exactly' : `${pr.unabsorbed.toExponential(1)} — float residue`);
  }
  // A MINIMUM AND AN EXTRA PAYMENT ARE NOT THE SAME KIND OF THING, even though
  // they look alike in the ledger. A minimum is one lender's demand about one
  // account: when that account is paid off the bank does not take it, and it
  // certainly does not move it to a different card. An extra payment is the
  // household choosing to put surplus at debt, and `plan.nextDollar` says where
  // it goes next. Cascading the first paid $170 to the TD credit card on
  // 1 November for a Cash Back Visa at zero since 30 October — a decision
  // nobody made.
  {
    const O = { scenario: 'expected', incomeOverrides: {}, disabled: [],
      extraDebtMonthly: CLEAR_EXTRA, targetBuffer: plan.defaults.targetBuffer,
      fundingSources: plan.funding.options, extraDebtTarget: plan.nextDollar.target,
      debts: data.debts };
    const adv = F.recommend(plan, asOf, O);
    const pr = F.projectDebts(plan, data.debts, asOf, Object.assign({}, adv.simOptions,
      { weeklyVariable: adv.weekly, extraFacilities: data.revolvingExtra,
        extraDebtTarget: plan.nextDollar.target }));
    ok(near(pr.byId.cashback.balance, 0),
      `at ${money(CLEAR_EXTRA)}/month the Cash Back Visa clears inside the window`);
    const cardMinimums = adv.sim.events.filter(e => {
      const o = (plan.obligations || []).find(x => x.id === e.id);
      return e.kind === 'obligation' && o && o.debtId === 'cashback';
    });
    ok(cardMinimums.every(e => e.date <= '2026-10-01'),
      'and no minimum is charged to it after it is paid off',
      cardMinimums.map(e => e.date).join(', ') || 'none');
    ok(!cardMinimums.some(e => e.date === '2026-11-01'),
      'specifically, the 1 November $170 is not taken from cash at all');
    // The paid-off card's minimum must not turn up on another account either.
    // Extras may still cascade (they do — the next assertion); a redirected
    // $170 November minimum is what this forbids, not a lower close.
    ok(!adv.sim.events.some(e => {
      const o = (plan.obligations || []).find(x => x.id === e.id);
      return e.date === '2026-11-01' && e.kind === 'obligation' && o && o.debtId === 'cashback';
    }),
      'and the paid-off card minimum is not redirected onto another account in November');
    // The cascade still applies where it belongs — to explicit extra payments.
    ok(pr.byId.tdcc.balance < tdccOpen,
      'while an EXTRA payment still cascades once its target is clear',
      `${money(tdccOpen)} → ${money(pr.byId.tdcc.balance)}`);
  }

  // A capitalising charge must never be capped — it ADDS to a balance rather
  // than reducing one, so the rule that governs payments does not apply to it.
  {
    const O = { scenario: 'expected', incomeOverrides: {}, disabled: [],
      extraDebtMonthly: 500000, targetBuffer: plan.defaults.targetBuffer,
      fundingSources: plan.funding.options, extraDebtTarget: plan.nextDollar.target,
      debts: data.debts };
    const adv = F.recommend(plan, asOf, O);
    const charges = adv.sim.events.filter(e => e.kind === 'noncash');
    const declared = (plan.obligations || []).filter(o => o.nonCash);
    ok(charges.length > 0 && declared.length > 0,
      'the capitalising HELOC charge still appears when every debt is cleared',
      `${charges.length} charge(s)`);
  }

  // Passing the debt records through the page's knob state put financial data
  // one `JSON.stringify(state)` away from localStorage — balances and credit
  // limits written to the disk of whatever machine the page was opened on,
  // outside the authenticated gate that protects everything else.
  ok(!/JSON\.stringify\(state\)/.test(planJs2),
    'the page never serialises its whole state — that would persist balances',
    'localStorage sits outside the authenticated financial-data gate');
  // Finish-line audit finding 9 made this stricter: the knob controls are
  // hidden, so the page persists and restores nothing at all. The behaviour
  // (a stale or tampered key prints the clean page) is proved end to end in
  // test-hidden-knobs-ignored.js; these pin the source contract.
  const planCode2 = planJs2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/localStorage\.setItem/.test(planCode2),
    'nothing the page holds is written to localStorage — no knobs, no balances');
  ok(!/localStorage\.getItem/.test(planCode2) && /localStorage\.removeItem\(KNOB_KEY\)/.test(planCode2),
    'and nothing is restored from it (the old knob key is cleared), so a stale or tampered '
    + 'payload cannot supply its own knobs or balances for the plan to be built on');

  const forecastSrc = read('public/forecast.js');
  ok(/function debtPriority\(/.test(forecastSrc) && /sort\(\(a, b\) => b\.rate - a\.rate\)/.test(forecastSrc),
    'the cascade order is computed by Forecast.debtPriority');
  const priority = F.debtPriority(plan, data.debts);
  const eligible = data.debts
    .filter(d => d.id === 'heloc' || (!d.secured && /^Revolving\b/i.test(d.structure || '')))
    .sort((a, b) => b.rate - a.rate);
  ok(priority.target.id === eligible[0].id,
    'and Forecast selects the highest-rate eligible debt',
    `${eligible[0].id} at ${eligible[0].rate}%`);
}
// This matched the page's own ternary selecting the override sentence. The
// selection is `Forecast.nextMove`'s now, so what is asserted is that the
// wording still exists and still names the setting and where it takes the
// balance — the sentence, not the choice to use it.
ok(/^  overrideBreach: s =>[\s\S]*?\$\{money\(s\.dueOnGapDay\)\}[\s\S]*?\$\{money\(s\.weekly\)\}\/week setting[\s\S]*?\$\{money\(s\.low\)\}/m
  .test(planJs2Code),
'and the Next move outcome says what the override actually does');
ok(/still to find before/.test(planJs2),
  'and says what is left when the action alone is not enough');

console.log('\n=== provenance claims are supported ===');
const nd = plan.nextDollar;
ok(nd.provenance === 'owner-stated',
  'the next-dollar policy is labelled owner-stated', nd.provenance);
ok(nd.provenanceDate === '2026-08-24',
  'the owner policy carries its decision date', nd.provenanceDate);
ok(/after required payments, essential spending, incumbent liquidity protection/i.test(nd.provenanceNote),
  'the policy preserves incumbent protections before true surplus');
ok(/Equal or unavailable rates fail closed/i.test(nd.provenanceNote),
  'the missing tie-breaker is explicit and fails closed');
ok(nd.target === undefined && nd.order === undefined,
  'the policy record does not store a target or duplicate rate order');
// Where owner-stated IS used, it carries a date or a named source.
const budgetTargets = plan.budget.categories.filter(c => c.targetSource);
ok(budgetTargets.length > 0, 'the owner budget targets declare a source',
  `${budgetTargets.length} categories`);
ok(budgetTargets.every(c => /owner-stated-20\d\d-\d\d-\d\d/.test(c.targetSource)),
  'and each source is dated', budgetTargets[0].targetSource);

console.log('\n=== one authority per contested fact ===');
const accountFacts = read('docs/ACCOUNT_FACTS.md');
const master = read('docs/00_MASTER_PICTURE.md');
const dataStr = JSON.stringify(data);

// The exact HELOC crossing day is Forecast.projectDebts. A stored calendar
// day in the assumptions (30 September on this opening) drifted from the
// walk (31 October) and was published beside it.
const helocWalkAssumption = (plan.assumptions || [])
  .find(a => /encoded HELOC cash minimum from cashFirstDue/.test(a));
ok(!!helocWalkAssumption,
  'the HELOC cash-minimum-on-the-walk assumption remains, without a stored crossing day');
ok(helocWalkAssumption && !containsCalendarDay(helocWalkAssumption),
  'plan assumptions do not store an exact HELOC crossing calendar day');
ok(storedCrossingClaims({ nextDollar: plan.nextDollar }).length === 0,
  'nextDollar does not store an exact HELOC crossing calendar day');

// Amanda's pay cadence. ACCOUNT_FACTS once said both bi-weekly and
// semi-monthly, in the same file, 236 lines apart.
ok(/semi-monthly/i.test(accountFacts),
  'ACCOUNT_FACTS states the semi-monthly cadence');
ok(!/Tennis BC pay is also bi-weekly/i.test(accountFacts),
  'and no longer also claims it is bi-weekly');
ok(!/Seaspan and Tennis BC both land the same day/i.test(dataStr),
  'data.json no longer claims her pay lands on the Seaspan payday');
ok(!/\$?3,507/.test(master),
  'the stale $3,507/month Tennis BC figure is gone from the master picture');

// F-15: Q5's ended garage/lab stream is not Amanda's modelled household
// salary. Deep Dive must not make "the transfers stopped after May"
// sound like the owner-confirmed Tennis BC salary streams.
{
  const amanda15 = (plan.income || []).find(s => s.id === 'amandaSalary15');
  const amandaEom = (plan.income || []).find(s => s.id === 'amandaSalaryMonthEnd');
  const note = data.incomeNote || '';
  ok(!plan.income.some(s => s.id === 'amandaTransfer'),
    'retired amandaTransfer stream is not live household income');
  ok(amanda15 && amandaEom
      && Math.round((amanda15.amount + amandaEom.amount) * 100) === 455684,
    'the two Tennis BC salary streams total $4,556.84/month');
  ok(!/the transfers stopped after May 2026 while the income did not/.test(dataStr),
    'published data.json no longer claims the transfers stopped after May while the income did not');
  ok(/garage\/lab/i.test(note) && /amandaSalary15/.test(note) === false,
    'incomeNote still names the ended garage/lab stream');
  ok(/4,556\.84/.test(note) && /Tennis BC salary/.test(note),
    'incomeNote names the owner-confirmed Tennis BC salary total');
}

// BC Hydro. Three files disagreed about whether it still had a household route.
ok(!/no current route through chequing:\*\* BC Hydro/i.test(accountFacts),
  'ACCOUNT_FACTS no longer lists BC Hydro as an unknown route');
ok(/moved to Amanda's DEBT&PAYMENTS account in May 2026|moved here in May 2026/i.test(accountFacts),
  'and records that it moved to her account in May 2026');
ok(!/BC Hydro \(absent from chequing since April 2026/i.test(dataStr),
  'the stale HELOC-route claim is gone from the plan assumptions');
ok(!/They ride inside the variable budget's averages instead/.test(dataStr),
  'and BC Hydro is no longer said to ride inside the household variable budget');
ok(!/summary: 'BC Hydro/.test(read('scripts/calendar-ics.js')),
  'the household calendar no longer emits a BC Hydro reminder');
ok(require('../scripts/calendar-ics.js').buildHouseholdCalendar(plan, asOf)
  .payments.some(p => /BC Hydro/i.test(p.summary)),
  'derived ICS payments include the BILLS ACCOUNT Hydro due');

// Card-section current-state claims vs Forecast.utilisation / canonical
// opening. F-02: ACCOUNT_FACTS must not publish a competing current-state
// copy. Dated historical evidence may still mention those figures. Current
// posted / available / over-limit / leftover live in data.json,
// Forecast.utilisation, and positions.csv. Making copied cents agree
// today is not the proof.
const util = F.utilisation(data.debts, data.revolvingExtra, data.plan);
const utilById = Object.fromEntries(util.rows.map(r => [r.id, r]));
const obligationByDebt = {};
for (const o of plan.obligations || []) {
  if (o.debtId) obligationByDebt[o.debtId] = o;
}

function parseFactsMoney(s) {
  if (s == null) return null;
  const m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function headingLevel(line) {
  const m = /^(#{2,3}) /.exec(line);
  return m ? m[1].length : 0;
}

function extractCardSection(md, headingRe) {
  const lines = md.split('\n');
  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i]) && /^#{2,3} /.test(lines[i])) {
      start = i;
      startLevel = headingLevel(lines[i]);
      break;
    }
  }
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const lv = headingLevel(lines[i]);
    if (lv && lv <= startLevel) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function currentLead(section) {
  const cut = section.search(
    /\n### |\nThe 9 August account reading remains dated evidence|\nOther figures verified from the account|\nThe pending charges are /
  );
  return cut < 0 ? section : section.slice(0, cut);
}

function markdownTables(text) {
  return text.match(/(?:^|\n)((?:\|.*\n)+)/g) || [];
}

function tableValue(table, label) {
  const want = label.toLowerCase();
  for (const line of table.split('\n')) {
    if (!line.includes('|')) continue;
    const cells = line.split('|').map(c => c.replace(/\*/g, '').trim()).filter(Boolean);
    if (cells.length >= 2 && cells[0].toLowerCase() === want) return cells[1];
  }
  return null;
}

function cardSectionConflicts(section, row, obligation) {
  const conflicts = [];
  if (!section) {
    conflicts.push(`${row.id}: missing ACCOUNT_FACTS section`);
    return conflicts;
  }
  const lead = currentLead(section);
  for (const table of markdownTables(lead)) {
    const balance = tableValue(table, 'Balance');
    if (balance) {
      const claimsOver = /over the limit|\bOVER\b|\bover\b/i.test(balance)
        && !/under|not over/i.test(balance);
      if (claimsOver && row.overLimit !== true) {
        conflicts.push(`${row.id}: current table Balance claims over-limit; utilisation is not`);
      }
      if (/under/i.test(balance) && row.overLimit === true) {
        conflicts.push(`${row.id}: current table Balance claims under; utilisation is over`);
      }
    }
    const avail = tableValue(table, 'Available credit');
    if (avail && !/forecast-derived/i.test(avail)) {
      const amt = parseFactsMoney(avail);
      if (amt != null && Math.abs(amt - Number(row.available || 0)) > 0.009) {
        conflicts.push(
          `${row.id}: current table Available credit ${amt} vs utilisation ${row.available}`
        );
      }
    }
    const fee = tableValue(table, 'Over-limit fee') || tableValue(table, 'Recent charges');
    if (fee && /still accruing/i.test(fee) && row.overLimit !== true) {
      conflicts.push(`${row.id}: current table claims over-limit fee still accruing; utilisation is not over`);
    }
    const minCell = tableValue(table, 'Minimum payment') || tableValue(table, 'Next minimum');
    if (minCell && obligation && obligation.amount != null) {
      const amt = parseFactsMoney(minCell);
      if (amt != null && Math.abs(amt - Number(obligation.amount)) > 1) {
        conflicts.push(
          `${row.id}: current table minimum ${amt} vs canonical obligation ${obligation.amount}`
        );
      }
    }
  }
  if (/will\s+take it over|approaching (?:its |the )?limit/i.test(lead) && row.overLimit === true) {
    conflicts.push(`${row.id}: current lead says pending will take it over, but posted is already over`);
  }
  if (/still over the limit/i.test(lead) && row.overLimit !== true) {
    conflicts.push(`${row.id}: current lead says still over; utilisation is not`);
  }
  if (/posted balance itself is over|posted is over the/i.test(lead) && row.overLimit !== true) {
    conflicts.push(`${row.id}: current lead says posted is over; utilisation is not`);
  }
  if (/(?:posted is under|not over limit|the card is not over)/i.test(lead) && row.overLimit === true) {
    conflicts.push(`${row.id}: current lead says not over; utilisation is over`);
  }
  return conflicts;
}

function moneyPattern(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const [whole, frac] = n.toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return new RegExp('\\$?' + grouped.replace(/,/g, ',?') + '\\.' + frac);
}

function leftoverCopies(facts, heloc) {
  const conflicts = [];
  const re = /\$([0-9,.]+)\s+left/gi;
  let m;
  while ((m = re.exec(facts))) {
    const amt = parseFactsMoney(m[1]);
    const local = facts.slice(Math.max(0, m.index - 80), m.index + m[0].length + 50);
    if (!/HELOC/i.test(local)) continue;
    if (!/drawn|headroom|opening it has/i.test(local)) continue;
    if (/9 August snapshot had|historical Aug|2026-08-09/i.test(local)) continue;
    conflicts.push(`present-tense HELOC leftover ${amt} is a current-state copy`);
  }
  const copied = moneyPattern(heloc && heloc.available);
  if (copied && copied.test(facts)) {
    conflicts.push(
      `ACCOUNT_FACTS copies current HELOC leftover ${heloc.available}`
    );
  }
  return conflicts;
}

function competingCurrentState(section, row) {
  const conflicts = [];
  if (!section) {
    conflicts.push(`${row.id}: missing ACCOUNT_FACTS section`);
    return conflicts;
  }
  const lead = currentLead(section);
  if (!/data\.json/i.test(lead)
      || !/Forecast\.utilisation/i.test(lead)
      || !/positions\.csv/i.test(lead)) {
    conflicts.push(
      `${row.id}: current-voice does not route revolving state to data.json / Forecast.utilisation / positions.csv`
    );
  }
  const postedRe = moneyPattern(row.posted);
  if (postedRe && postedRe.test(lead)) {
    conflicts.push(`${row.id}: current-voice copies posted ${row.posted}`);
  }
  if (row.available != null && Number(row.available) !== 0) {
    const availRe = moneyPattern(row.available);
    if (availRe && availRe.test(lead)) {
      conflicts.push(`${row.id}: current-voice copies available ${row.available}`);
    }
  }
  if (/will\s+take it over|approaching (?:its |the )?limit/i.test(lead)
      || /still over the limit/i.test(lead)
      || /posted balance itself is over|posted is over the/i.test(lead)
      || /(?:posted is under|not over limit|the card is not over)/i.test(lead)) {
    conflicts.push(`${row.id}: current-voice asserts a current over/under-limit conclusion`);
  }
  for (const table of markdownTables(lead)) {
    if (tableValue(table, 'Balance')) {
      conflicts.push(`${row.id}: current-voice table publishes Balance`);
    }
    const avail = tableValue(table, 'Available credit');
    if (avail && parseFactsMoney(avail) != null) {
      conflicts.push(`${row.id}: current-voice table publishes Available credit`);
    }
  }
  return conflicts;
}

const CARD_SECTIONS = [
  { id: 'cashback', heading: /^### TD Cash Back Visa/ },
  { id: 'travelvisa', heading: /^### Travel Visa/ },
  { id: 'triangle', heading: /^## Triangle Mastercard/ },
  { id: 'mbna', heading: /^### MBNA/ },
  { id: 'tdcc', heading: /^## TD credit card/ },
];

const F02_SECTIONS = CARD_SECTIONS.filter(s => s.id === 'cashback' || s.id === 'travelvisa');
const OTHER_CARD_SECTIONS = CARD_SECTIONS.filter(s => s.id !== 'cashback' && s.id !== 'travelvisa');

const liveCopyConflicts = [];
for (const spec of F02_SECTIONS) {
  const row = utilById[spec.id];
  if (!row) continue;
  const section = extractCardSection(accountFacts, spec.heading);
  liveCopyConflicts.push(...competingCurrentState(section, row));
}
ok(liveCopyConflicts.length === 0,
  'Cash Back and Travel Visa current-voice do not publish a competing current-state copy',
  liveCopyConflicts.join('; ') || 'cashback + travelvisa route to utilisation');

const liveCardConflicts = [];
for (const spec of OTHER_CARD_SECTIONS) {
  const row = utilById[spec.id];
  if (!row) continue;
  const section = extractCardSection(accountFacts, spec.heading);
  liveCardConflicts.push(...cardSectionConflicts(section, row, obligationByDebt[spec.id]));
}
ok(liveCardConflicts.length === 0,
  'no other ACCOUNT_FACTS card section asserts over-limit or available-credit state that Forecast.utilisation contradicts',
  liveCardConflicts.join('; ') || 'triangle / mbna / tdcc');

const paymentCal = (accountFacts.match(/## Payment calendar[\s\S]*?(?=\n## )/) || [''])[0];
const cashbackCalRow = paymentCal.split('\n').find(l => /TD Cash Back Visa minimum/.test(l)) || '';
ok(!!cashbackCalRow, 'payment calendar still names the Cash Back Visa minimum');
ok(!/\$762\.36/.test(cashbackCalRow),
  'the retired $762.36 is not the current Cash Back calendar amount');
ok(/see note/i.test(cashbackCalRow),
  'the Cash Back calendar row uses the existing see-note pattern');
ok(!/\$\s*[\d,]/.test(cashbackCalRow),
  'the Cash Back calendar row does not pin a replacement monthly dollar amount');
ok(/plan\.obligations/i.test(cashbackCalRow),
  'the Cash Back calendar row points at plan.obligations for the current amount');

const helocLive = leftoverCopies(accountFacts, utilById.heloc);
ok(helocLive.length === 0,
  'ACCOUNT_FACTS does not copy current HELOC leftover from Forecast.utilisation',
  helocLive.join('; ') || 'dated 9 August leftover only');

// Bite proof: the pre-change current-voice text must fail these same checks.
const STALE_CASHBACK_LEAD = [
  '### TD Cash Back Visa *(…0726)* — **the household\'s second-largest card**',
  '',
  '| | |',
  '|---|---|',
  '| **Rate** | **26.99% purchases / 27.99% cash advances** — from the statement rate table |',
  '| Credit limit | **$5,000.00** |',
  '| Balance | $5,682.43 — **$682.43 OVER the limit** |',
  '| Available credit | **$0.00** |',
  '| Minimum payment | **$762.36**, due **1 Sep 2026** |',
  '| Statement cycle | 8th to 7th |',
  '| Recent charges | Interest **$158.55/month**, plus a **$29.00 over-limit fee** |',
  '| Cash Back Dollars | $47.21 |',
  '',
  '**Position after that payment:**',
  '',
  '| | |',
  '|---|---|',
  '| Balance | **~$5,612.43** [calculated, $5,682.43 − $70.00] |',
  '| Credit limit | $5,000.00 |',
  '| **Still over the limit by** | **~$612.43** |',
  '| Over-limit fee | **$29.00/month, still accruing** until the balance is under $5,000 |',
  '| Next minimum | **$762.36, due 1 Sep 2026** — unaffected by this payment |',
].join('\n');
const STALE_TRAVEL_LEAD = [
  '### Travel Visa *(…0870)* — **a Business Visa**',
  '',
  '| | |',
  '|---|---|',
  '| **Rate** | **19.99% purchases / 22.99% cash** — the lowest card rate in the household |',
  '| Balance | $1,078.31 · pending $165.13 |',
  '| Available credit | **$0.00** |',
  '| **Credit limit** | **$1,100.00** *(verified 2026-08-09 from the Manage tab)* |',
  '| Minimum payment | $17.00, due **26 Aug 2026** |',
  '',
  '**The limit is $1,100.00 — by far the smallest in the household**, and the card',
  'is at **98.0%** of it with $0.00 available. **The $165.13 of pending charges will',
  'take it over.** $1,078.31 + $165.13 = **$1,243.44 against a $1,100 limit**, or',
  '**$143.44 over** [calculated].',
].join('\n');
const staleCashbackHits = competingCurrentState(
  STALE_CASHBACK_LEAD, utilById.cashback);
const staleTravelHits = competingCurrentState(
  STALE_TRAVEL_LEAD, utilById.travelvisa);
ok(staleCashbackHits.length > 0,
  'stale Cash Back over-limit / $0 available / $762.36 minimum prose is a competing current-state copy',
  staleCashbackHits.join('; '));
ok(staleTravelHits.length > 0,
  'stale Travel Visa pending-will-take-it-over prose is a competing current-state copy',
  staleTravelHits.join('; '));

const COPIED_CURRENT_CASHBACK = [
  '### TD Cash Back Visa *(…0726)* — **the household\'s second-largest card**',
  '',
  '| | |',
  '|---|---|',
  '| **Rate** | **26.99% purchases / 27.99% cash advances** — from the statement rate table |',
  '| Credit limit | **$5,000.00** |',
  '| Statement cycle | 8th to 7th |',
  '| Due | 1st, monthly |',
  '',
  '**Canonical Forecast opening is the 2026-08-19 `data.json` record**,',
  `not the 9 August snapshot. Posted **${money(utilById.cashback.posted)}**, pending **$0.00**,`,
  'available credit is Forecast-derived (not household cash). Posted is',
  'under the $5,000 limit; the card is not over limit on this opening.',
].join('\n');
const copiedCurrentHits = competingCurrentState(
  COPIED_CURRENT_CASHBACK, utilById.cashback);
ok(copiedCurrentHits.length > 0,
  'copying today\'s matching posted cents is still a competing current-state copy',
  copiedCurrentHits.join('; '));
ok(leftoverCopies(
  'Consolidation into the HELOC is not available. It is 99.5% drawn with $1,067.84 left.',
  utilById.heloc
).length > 0,
  'stale present-tense HELOC $1,067.84 leftover is a current-state copy');
ok(leftoverCopies(
  `On the current 2026-08-19 opening it has ${money(utilById.heloc.available)} left (the 9 August snapshot had $1,067.84).`,
  utilById.heloc
).length > 0,
  'copying today\'s matching HELOC leftover is still a current-state copy');
ok(/\$762\.36/.test('| **1st** | TD Cash Back Visa minimum | $762.36 | TD |'),
  'the stale payment-calendar $762.36 row is the shape the live-row check would catch');
ok(/\$\s*[\d,]/.test('| **1st** | TD Cash Back Visa minimum | ~$170 | TD — **see note** |'),
  'a replacement Cash Back calendar dollar amount is the shape the live-row check would catch');

console.log('\n=== no financial event appears twice ===');
const window = F.simulate(plan, asOf, { scenario: 'expected', weeklyVariable: 0, targetBuffer: 500 });
const keys = new Map();
for (const e of window.events) keys.set(e.id + '@' + e.date, (keys.get(e.id + '@' + e.date) || 0) + 1);
const duplicated = [...keys].filter(([, n]) => n > 1);
ok(duplicated.length === 0, 'every scheduled event is unique on (id, date)',
  duplicated.length ? duplicated.map(([k]) => k).join(', ') : `${keys.size} events`);

const ids = plan.income.concat(plan.obligations, plan.bills || [], plan.commitments).map(x => x.id);
ok(new Set(ids).size === ids.length, 'every plan item has a unique id', `${ids.length} items`);

// A dated bill must not also be inside the variable budget for its category.
const budget = F.budgetBreakdown(plan, periods, { paypalPerMonth: data.paypal.perMonth });
const catIds = new Set(plan.budget.categories.map(c => c.id));
for (const b of (plan.bills || [])) {
  ok(b.budgetCategory === null || catIds.has(b.budgetCategory),
    `bill "${b.id}" resolves to a real budget category or explicitly to none`);
}
for (const c of budget.categories) {
  ok(c.planned <= c.historical + 0.01 || c.target != null,
    `category "${c.id}" never carries more than it has historically cost`,
    `${money(c.planned)} of ${money(c.historical)}`);
}

console.log('\n=== the plan derives from canonical state ===');
const advice = F.recommend(plan, asOf, {
  scenario: 'expected', incomeOverrides: {}, disabled: [], extraDebtMonthly: 0,
  targetBuffer: plan.defaults.targetBuffer,
});
ok(advice.sim.daily[0] !== undefined
  && advice.zero.daily[0].balance <= F.startingCashAmount(plan) + 0.01,
  'the forecast opens from the cash register, not a typed-in number',
  money(F.startingCashAmount(plan)));
// The page must not be able to show a different weekly figure from the engine.
const planJs = read('public/plan.js');
ok(/Forecast\.recommend\(/.test(planJs),
  'the Plan page calls the single recommendation authority');
ok(!/recommendWeekly\(/.test(planJs),
  'and does not solve the budget a second time by itself');
ok(!/postGapWeekly|shifted\.startingCash/.test(planJs),
  'the DOM-level re-slicing that double-counted the first payday is gone');

console.log('\n=== confidence, provenance and freshness ===');
const planItems = plan.income.concat(plan.obligations, plan.bills || [], plan.commitments);
const missingConfidence = planItems.filter(x => !x.confidence);
ok(missingConfidence.length === 0, 'every planning input carries a confidence tag',
  missingConfidence.map(x => x.id).join(', ') || `${planItems.length} items`);
ok(planItems.every(x => ['confirmed', 'estimated', 'planned'].includes(x.confidence)),
  'and the tags come from a closed vocabulary');
ok(/^\d{4}-\d{2}-\d{2}$/.test(data.meta.asOf), 'the as-of date is a real date', data.meta.asOf);
ok(periods.asOf === '2026-08-24' && periods.source.coverageThrough === periods.asOf,
  'generated spending history carries its complete provider coverage-through date',
  periods.asOf);
ok(periods.source.complete === true && periods.source.basis === 'lunchmoney-cleaned-history',
  'a history source newer than the dated Forecast opening declares its own complete authority',
  `${periods.asOf} vs ${data.meta.asOf}`);
{
  const helocFact = (data.helocUse || []).find(row => /interest charged/i.test(row.label));
  const publishedHeloc = ((periods.periods.all && periods.periods.all.interest) || [])
    .find(row => row.label === 'HELOC');
  ok(helocFact && publishedHeloc && near(publishedHeloc.total, helocFact.amount),
    'published HELOC interest matches the independent helocUse interest-charged fact',
    publishedHeloc && helocFact
      ? `${money(publishedHeloc.total)} vs ${money(helocFact.amount)}`
      : 'missing');
  ok((periods.source.fallbackHelocEvents || 0) > 0 || (periods.source.helocPostedCount || 0) > 0,
    'HELOC coverage is proven by provider history or fallback events',
    `fallback=${periods.source.fallbackHelocEvents} posted=${periods.source.helocPostedCount}`);
  ok(!(periods.periods.all.spending || []).some(row => row.label === 'Pets' && row.total > 0),
    'Lunch Money Pets is not canonized after failed GET-only validation');
  ok(Array.isArray(periods.source.accountCoverage)
    && periods.source.accountCoverage.some(row => row.role === 'heloc' || row.canonicalId === 'heloc'),
    'generated history publishes per-account coverage including HELOC');
  const coverageJson = JSON.stringify(periods.source.accountCoverage || []);
  ok(!/"providerAccountId"/i.test(coverageJson),
    'per-account coverage does not publish provider account ids');
}
ok(/function formatSiteAsOfChip/.test(read('public/app.js'))
    && /historical spending through/.test(read('public/app.js'))
    && /liveSpendingEvidenceDate/.test(read('public/app.js')),
  'Deep Dive header publishes the history source as-of separately when it differs from the plan');
ok(plan.budget.ownerTargets && plan.budget.ownerTargets.status,
  'the budget records whether an owner target exists',
  plan.budget.ownerTargets.status);

console.log('\n=== stale publication fails validation ===');
// The generated file must not be older than the hand-edited one, and must not
// be empty — a dashboard of $0.00s once shipped that way.
ok(periods.periods && Object.keys(periods.periods).length >= 3,
  'periods.json carries its period lenses', Object.keys(periods.periods).join(', '));
ok(periods.periods.ytd.spendingTotal > 0,
  'and real spending totals, not zeros', money(periods.periods.ytd.spendingTotal));
ok((periods.monthly || []).length > 0, 'and a monthly series', `${periods.monthly.length} months`);

// Every data.json key must be read by some page, or it is dead weight that
// will drift out of date unnoticed.
const allScripts = ['app', 'forecast', 'plan', 'modellers', 'deepdive', 'records']
  .map(f => read('public/' + f + '.js')).join('\n');
const orphans = Object.keys(data).filter(k => !new RegExp('\\.' + k + '\\b').test(allScripts));
ok(orphans.length === 0, 'no orphaned data.json keys', orphans.join(', ') || 'all keys rendered');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
