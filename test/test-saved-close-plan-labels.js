'use strict';
// A saved (closed) pay period never says its plan is "Unavailable" beside plan
// amounts it shows. Invented data only
// (test/fixtures/private-period-history-input.js; cycle Feb 1-14 2030:
// groceries 40, fuel 15, income 200, plus an invented $30 bill). Every
// expectation below is written by hand from those authored numbers.
//
// The bug on main: the saved close keeps each row's planned amount and its
// period totals, but not the comparison of actual against plan. The page read
// that missing comparison as the whole plan and printed "Historical original plan unavailable", "Original plan:
// Unavailable" and "Actual and plan unknown" on the same screen that prints
// the saved planned amounts.
//
//   L1 the saved close holds the planned amounts and its period totals, and
//      no actual-against-plan comparison
//   L2 Household sheet: every saved category prints its saved Planned amount,
//      and none says the plan is unavailable
//   L3 a tag is never upgraded: no saved trust word is said out loud, a saved
//      "estimated" prints the estimate mark, a saved "confirmed" prints plain
//   L4 a category whose planned amount the close did not keep says exactly
//      that, for that category only
//   L5 Income, Bills and Household name the missing comparison, never the
//      plan and never a total the close saved and prints, on the compact page,
//      the closed-period page and the Household tile
//   L6 no dollar amount changes: every amount on the saved-close page is a
//      number the close saved, and today's different groceries target (80)
//      appears nowhere on it
//   L7 control: an uncaptured completed period keeps its wording
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { START, END, NEXT, input } = require('./fixtures/private-period-history-input');

let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
const bill = () => [{ id: 'invented-bill', label: 'Invented bill', frequency: 'monthly', day: 10, amount: 30,
  confidence: 'confirmed', payingAccount: 'chequing-a' }];
const at = raw => { const clean = JSON.parse(JSON.stringify(raw)); const time = clean.capturedAt; delete clean.capturedAt; return [clean, () => new Date(time)]; };

// The close is saved on Feb 16 under groceries 40. Today is Feb 20 and the
// groceries target has since been raised to 80, so a saved amount and today's
// can be told apart.
const closeRaw = input({ day: '2030-02-16', kind: 'closing', periodStart: START, bills: bill() });
delete closeRaw.kind; delete closeRaw.periodStart;
const [late, lateNow] = at(closeRaw);
const record = Pg.project(History.captureClosing(late, { now: lateNow }));
const saved = record.content.publication;
const today = input({ day: '2030-02-20', kind: 'first-observed', periodStart: NEXT, bills: bill() }).data.plan;
today.budget.categories.find(row => row.id === 'groceries').plannedPayday = 80;
const advise = history => F.recommend(today, '2030-02-20', { debts: [], periods: [], ...(history ? { periodHistory: history } : {}) });
const viewOf = advice => advice.payPeriodViews.find(row => row.start === START && row.end === END);
const savedAdvice = advise([record]), past = viewOf(savedAdvice);
const plainAdvice = advise(null), plain = viewOf(plainAdvice);

// The saved-close rule has one reader, budgetSavedClose, and is spelled inline
// in the two renderers that suites load without the rest of plan.js. All
// three must be the same rule, and those two must not need the reader.
const planSource = fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8');
const body = name => (planSource.match(new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}$', 'm')) || [''])[0];
const RULE = "capturedClose?.source === 'period-history'";
for (const name of ['budgetSavedClose', 'calendarBudgetHtml', 'calendarWaterfallHtml']) {
  ok(body(name).includes(RULE), 'the saved-close rule is spelled in ' + name);
}
for (const name of ['calendarBudgetHtml', 'calendarWaterfallHtml', 'householdBudgetCategoryHtml']) {
  ok(!/budgetSavedClose\(/.test(body(name)), name + ' loads on its own: it does not call budgetSavedClose');
}

// L1 what the close holds.
const savedRow = id => saved.householdBudget.find(row => row.id === id);
ok(past.capturedClose && past.capturedClose.source === 'period-history' && past.lookback === true, 'L1 the period is a saved close');
ok(savedRow('groceries').planned === 40 && savedRow('fuel').planned === 15, 'L1 the close saved the category plans (groceries 40, fuel 15)');
ok(saved.income[0].planned === 200 && saved.bills[0].planned === 30, 'L1 the close saved the income plan (200) and the bill plan (30)');
ok(past.budgetProgress === null, 'L1 the close saved no actual-against-plan comparison (no progress publication)');
ok(saved.incomeTotal === 200 && saved.totalBillsThisPeriod === 30 && saved.budgetHold === 12.34,
  'L1 the close saved its period totals (income 200, bills 30, spending deduction 12.34)');
ok(plain.householdBudget.find(row => row.id === 'groceries').planned === 80, "L1 control: today's groceries target is 80, not the saved 40");
// The store keeps each category row's trust tag for saved-period trends
// (untagged at the close, so 'calculated'); the reprint does not carry it, so
// the page below reads exactly as before.
ok(saved.householdBudget.every(row => row.trust === 'calculated' && !['plannedTrust', 'confidence'].some(key => Object.hasOwn(row, key))),
  'L1 the close saved each untagged household category row as calculated, and no other trust word');
ok(past.householdBudget.every(row => !['plannedTrust', 'confidence', 'trust'].some(key => Object.hasOwn(row, key))),
  'L1 the reprinted saved period carries no trust word on a household category row');
ok(!plain.capturedClose, 'L1 control: without the archive the period is an uncaptured completed period');

// The page, as the browser builds it.
const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
context.plan = today;
const compact = period => { context.p = period; return vm.runInContext('calendarWaterfallHtml(p,null,null,plan,true)', context); };
const closedPage = period => { context.p = period; return vm.runInContext('historicalPeriodHtml(p)', context); };
const tile = (period, advice) => { context.p = period; context.ctx = { asOf: '2030-02-20', advice };
  return vm.runInContext('budgetSpendingSectionHtml(p,ctx)', context); };
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// One block of the page: a waterfall step, a category in the Household sheet.
const step = (html, number) => html.split('data-operating-question="' + number + '"')[1].split('data-operating-question="')[0];
const category = (html, id) => html.split('data-budget-category="' + id + '"')[1].split('data-budget-category="')[0].split('</dl>')[0];

const WHOLE_PLAN_UNAVAILABLE = /Historical original plan unavailable|Original plan: Unavailable|Actual and plan unknown/;
// The Savings step is outside this outcome: a close saves no savings amounts,
// so none is printed beside its own "unavailable" wording.
const EVERY_AMOUNT_UNAVAILABLE = /Exact-period amounts and their evidence are unavailable/;
const pages = { compact: compact(past), 'closed-period': closedPage(past) };

for (const [name, html] of Object.entries(pages)) {
  // L2 Household sheet.
  const household = step(html, '06');
  for (const [id, planned] of [['groceries', '$40.00'], ['fuel', '$15.00'], ['restaurants', '$10.00'], ['pets', '$5.00']]) {
    const block = category(household, id);
    ok(new RegExp('<dt>Planned</dt><dd>' + planned.replace('$', '\\$') + '</dd>').test(block),
      'L2 ' + name + ': ' + id + ' prints its saved Planned ' + planned);
    ok(!/unavailable/i.test(text(block)), 'L2 ' + name + ': ' + id + ' says nothing is unavailable');
    // L3 the close kept no trust word for this row, and the row says so.
    ok(/data-budget-saved-close-plan="tag-not-saved"/.test(block) && /Whether it was an estimate was not saved\./.test(block),
      'L3 ' + name + ': ' + id + ' says its trust word was not saved');
    ok(!/class="est"/.test(block), 'L3 ' + name + ': ' + id + ' invents no estimate mark');
  }
  ok(/<dt>Spent<\/dt><dd>\$12\.34<\/dd>/.test(category(household, 'groceries')), 'L2 ' + name + ': groceries still prints its saved Spent $12.34');
  ok(!/data-budget-historical-original-plan/.test(html), 'L2 ' + name + ': no category is marked "historical original plan unavailable"');
  // L5 the whole page.
  ok(!WHOLE_PLAN_UNAVAILABLE.test(text(html)), 'L5 ' + name + ': the page never calls the plan unavailable or unknown');
  for (const number of ['02', '04', '06']) {
    ok(!EVERY_AMOUNT_UNAVAILABLE.test(step(html, number)), 'L5 ' + name + ' step ' + number + ': never says every amount is unavailable');
  }
}

// L5 compact page: each step names the missing comparison beside its saved
// amounts, and never says a total is missing: the close saved its totals.
const income = step(pages.compact, '02'), bills = step(pages.compact, '04'), household = step(pages.compact, '06');
// The invented deposit is planned and never observed, so the close saved its income as estimated (the
// completed-period income trust rule): the drawer total carries that saved tag, and the amount is unchanged.
ok(/\+\$200\.00/.test(income) && /Payday balance ≈ estimated \$200\.00/.test(text(income)), 'L5 the saved income line and total (200.00, tagged as saved) are on the page');
ok(/Total bills this period \$30\.00/.test(text(bills)) && /Paid bills this period \$0\.00/.test(text(bills)),
  'L5 the saved bill totals (30.00 this period, 0.00 paid) are on the page');
ok(/Completed-period spending deduction \$12\.34/.test(text(household)), 'L5 the saved spending deduction (12.34) is on the page');
for (const [name, block] of [['Income', income], ['Bills', bills]]) {
  ok(/data-budget-progress-evidence="(income|bills)" data-budget-saved-close-comparison="not-saved"/.test(block)
    && /<h3>Actual against plan<\/h3><p>Comparison: Not saved with this close\.<\/p>/.test(block),
    'L5 ' + name + ': the evidence says the actual-against-plan comparison was not saved');
}
for (const [name, block] of [['Income', income], ['Bills', bills], ['Household budget', household]]) {
  ok(/Comparison not saved/.test(text(block)) && /The comparison of actual against plan was not saved with this close/.test(text(block)),
    'L5 ' + name + ': the step value reads "Comparison not saved"');
  ok(/It did not save the comparison of actual against plan\./.test(block), 'L5 ' + name + ': the note names the comparison as the missing piece');
  ok(!/data-budget-(actual|planned)-amount=/.test(block), 'L5 ' + name + ': no comparison amount is stamped for the face');
}
ok(/<h3>Household Budget Total<\/h3>/.test(household) && /data-household-budget-progress-total>[\s\S]{0,200}Comparison not saved/.test(household),
  'L5 the Household Budget Total reads "Comparison not saved"');
// L5 the Household tile and the Bills card (the cards beside the hero).
const savedTile = tile(past, savedAdvice);
ok(/data-budget-browse-hold>[\s\S]{0,200}Comparison not saved/.test(savedTile) && !/Actual and plan unknown/.test(savedTile),
  'L5 tile: the household comparison reads "Comparison not saved"');
ok(/\$40\.00/.test(savedTile) && /\$12\.34/.test(savedTile), 'L5 tile: the saved groceries pair (12.34 / 40.00) is unchanged');
context.p = past; context.ctx = { asOf: '2030-02-20', advice: savedAdvice };
const savedBills = vm.runInContext('budgetBillsSectionHtml(p,ctx)', context);
ok(/id="budget-bills-heading"[^>]*>[\s\S]{0,200}Comparison not saved/.test(savedBills) && /\$30\.00 this period/.test(text(savedBills)),
  'L5 Bills card: "Comparison not saved" sits above the saved "$30.00 this period"');
// L5 no surface says a total is missing, or is unknown, while it prints saved totals.
const TOTAL_MISSING = /Total not saved|no period totals|Plan total: Not saved|Actual total: Not saved|Actual and plan unknown/;
for (const [name, html] of Object.entries({ ...pages, tile: savedTile, 'Bills card': savedBills })) {
  ok(!TOTAL_MISSING.test(text(html)), 'L5 ' + name + ': never says a total was not saved, or is unknown');
}

// L3 a saved trust word stands, and is never upgraded.
const withRow = change => { const copy = JSON.parse(JSON.stringify(record));
  change(copy.content.publication.householdBudget.find(row => row.id === 'groceries')); return compact(viewOf(advise([copy]))); };
const estimated = step(withRow(row => { row.confidence = 'estimated'; }), '06');
ok(/<dt>Planned<\/dt><dd><span class="est">≈ estimated<\/span> \$40\.00<\/dd>/.test(category(estimated, 'groceries')),
  'L3 a plan saved as estimated prints the estimate mark');
ok(/data-budget-saved-close-plan="saved"/.test(category(estimated, 'groceries')) && !/was not saved/.test(category(estimated, 'groceries')),
  'L3 and is not said to lack its trust word');
ok(/data-budget-saved-close-plan="tag-not-saved"/.test(category(estimated, 'fuel')), 'L3 while an untagged row beside it still says so');
const confirmed = category(step(withRow(row => { row.confidence = 'confirmed'; }), '06'), 'groceries');
ok(/<dt>Planned<\/dt><dd>\$40\.00<\/dd>/.test(confirmed) && /data-budget-saved-close-plan="saved"/.test(confirmed),
  'L3 a plan saved as confirmed prints plain');
const unrecognised = category(step(withRow(row => { row.confidence = 'invented-word'; }), '06'), 'groceries');
ok(/data-budget-saved-close-plan="tag-not-saved"/.test(unrecognised) && !/data-budget-saved-close-plan="saved"/.test(unrecognised),
  'L3 an unrecognised saved word is not treated as a tag');

// L4 a planned amount the close did not keep.
const missing = step(withRow(row => { row.planned = null; }), '06');
ok(/data-budget-saved-close-plan="amount-not-saved"/.test(category(missing, 'groceries'))
  && /Planned amount not saved with this close\./.test(category(missing, 'groceries'))
  && !/<dt>Planned<\/dt>/.test(category(missing, 'groceries')), 'L4 groceries says its planned amount was not saved, and prints none');
ok(/<dt>Spent<\/dt><dd>\$12\.34<\/dd>/.test(category(missing, 'groceries')), 'L4 its saved Spent still prints');
ok(/<dt>Planned<\/dt><dd>\$15\.00<\/dd>/.test(category(missing, 'fuel')) && !/amount-not-saved/.test(category(missing, 'fuel')),
  'L4 fuel, whose plan was saved, is untouched');

// L6 no dollar amount changes: every amount on the saved-close page is a
// number the close saved (walked from the stored record, not from the page).
const savedNumbers = new Set();
(function walk(value) {
  if (typeof value === 'number') savedNumbers.add(Math.abs(value).toFixed(2));
  else if (value && typeof value === 'object') Object.values(value).forEach(walk);
})(saved);
for (const [name, html] of Object.entries({ ...pages, tile: savedTile, 'Bills card': savedBills })) {
  ok(!/\$80(\.00)?\b/.test(text(html)), "L6 " + name + ": today's groceries target (80) appears nowhere on the saved close");
  const printed = (text(html).match(/\$[\d,]+\.\d\d/g) || []).map(token => token.replace(/[$,]/g, ''));
  ok(printed.length > 0 && printed.every(amount => savedNumbers.has(amount)),
    'L6 ' + name + ': every printed amount is one the close saved (' + printed.filter(amount => !savedNumbers.has(amount)).join(', ') + ')');
}

// L7 control: an uncaptured completed period is today's rebuild, so its
// category targets are not that period's plan and the wording stands.
const plainCompact = compact(plain), plainHousehold = step(plainCompact, '06');
ok(/Historical original plan unavailable\./.test(category(plainHousehold, 'groceries'))
  && !/<dt>Planned<\/dt>/.test(category(plainHousehold, 'groceries')), 'L7 uncaptured: groceries keeps "Historical original plan unavailable" and prints no Planned');
ok(/Actual and plan unknown/.test(text(plainHousehold)) && !/data-budget-saved-close/.test(plainCompact)
  && !/Comparison not saved|not saved with this close|was not saved\./.test(text(plainCompact)),
  'L7 uncaptured: the household total keeps "Actual and plan unknown", and no saved-close wording appears');
ok(!/\$80\.00/.test(category(plainHousehold, 'groceries')), "L7 uncaptured: today's groceries target (80) is not printed as that period's plan");
ok(/Original plan: \$200\.00\./.test(text(step(plainCompact, '02'))), 'L7 uncaptured: Income keeps its published original plan (200.00)');
ok(/Actual and plan unknown/.test(tile(plain, plainAdvice)), 'L7 uncaptured tile: the household total keeps "Actual and plan unknown"');

console.log('PASS saved close plan labels: ' + checks + ' checks');
