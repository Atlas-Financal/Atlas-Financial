'use strict';
/* The page prints Forecast's stale-card verdict beside figures built from a
 * stale card balance (#1305), and nothing when the balance is current.
 *
 * Real public/app.js + public/plan.js loaded through the Budget page harness;
 * the inputs are Forecast's own projectDebts / utilisation output on invented
 * debts. Invented card, statement close day 17, as-of 2026-09-20 (cycle from
 * 2026-09-17): dated 2026-09-10 is stale, 2026-09-18 is current.
 *
 * `node test/test-page-stale-card-balance-note.js`
 */
const F = require('../public/forecast.js');
const { loadBudgetPage } = require('./lib/budget-page-harness');

let failures = 0;
const ok = (cond, label, detail) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' — ' + detail : ''}`);
};

const AS_OF = '2026-09-20';
const plan = { opening: { asOf: AS_OF }, windowDays: 60, startingCash: { amount: 2500 },
  income: [], bills: [], obligations: [], commitments: [], budget: { categories: [] },
  defaults: { targetBuffer: 0 } };
const debts = balanceAsOf => [{ id: 'invented-card', label: 'Invented card', structure: 'Revolving', secured: false,
  balance: 400, pending: 0, rate: 19.99, limit: 2000, payment: 25, statementCloseDay: 17, confidence: 'confirmed', balanceAsOf }];
const page = loadBudgetPage({ globals: { BudgetCardMovements: require('../public/budget-card-movements.js') } });
const note = page.get('staleCardBalanceNote');
const utilRows = page.get('staleUtilisationRows');
const heroTile = page.get('currentOperatingConsumerDebtHeroTile');

console.log('=== a stale card balance ===');
{
  const ds = debts('2026-09-10');
  const walk = F.projectDebts(plan, ds, AS_OF, { debtHorizonDays: 30 });
  ok(walk.trust === 'estimated', 'Forecast marks the debt walk estimated');
  const text = note(walk.staleBalances, ds);
  ok(text === 'estimate — Invented card balance as of September 10, before this statement cycle',
    'the note names the card, its balance date and the reason', text);
  const util = F.utilisation(ds, [], plan);
  ok(note(utilRows(util), ds) === text, 'credit left reads the same note from utilisation');
  const tile = heroTile({}, null, walk.marks[0], text);
  ok(tile && / · estimate — Invented card balance as of /.test(tile.note) && /credit left everywhere/.test(tile.note),
    'the Consumer debt tile keeps its figure note and adds the estimate note', tile && tile.note);
}

console.log('\n=== a current card balance ===');
{
  const ds = debts('2026-09-18');
  const walk = F.projectDebts(plan, ds, AS_OF, { debtHorizonDays: 30 });
  ok(walk.trust === undefined && note(walk.staleBalances, ds) === '', 'no note when the balance is current');
  ok(note(utilRows(F.utilisation(ds, [], plan)), ds) === '', 'utilisation gives no note either');
  const tile = heroTile({}, null, walk.marks[0], '');
  ok(!/estimate/.test(tile.note), 'the Consumer debt tile is unchanged', tile.note);
}

console.log('\n=== the note is printed escaped ===');
{
  const text = note([{ id: 'x', balanceAsOf: null }], [{ id: 'x', label: '<b>Card & co</b>' }]);
  ok(/undated/.test(text), 'an undated stale balance says undated', text);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'plan.js'), 'utf8');
  ok(/escapeHtml\(debtStaleNote\.replace/.test(src) && /<div class="note">\$\{escapeHtml\(t\.note\)\}<\/div>/.test(src),
    'the score note and tile notes pass the note through escapeHtml');
}

console.log('\n=== the visible Credit cards strip tags a stale reported balance ===');
{
  const strip = page.get('budgetCardMovementsHtml');
  // The strip lists the household's known card identities for the current
  // pay period, so the invented card takes a strip id and the plan an
  // invented biweekly income that makes a current period.
  const stripPlan = Object.assign({}, plan, { income: [{ id: 'payroll', label: 'Invented payroll',
    frequency: 'biweekly', anchor: '2026-09-18', amount: 3000, confidence: 'confirmed' }] });
  const render = asOfDate => {
    const ds = debts(asOfDate).map(d => Object.assign({}, d, { id: 'travelvisa' }));
    const advice = F.recommend(stripPlan, AS_OF, { targetBuffer: 0, debts: ds });
    return strip({ advice, plan: stripPlan, asOf: AS_OF, debts: ds, liveOverlay: null });
  };
  const stale = render('2026-09-10');
  const trigger = (/<button type="button" class="card-movement-trigger" data-budget-card-toggle="travelvisa"[\s\S]*?<\/button>/.exec(stale) || [''])[0];
  ok(/data-card-movement-estimate>estimate · as of [^<]+<\/small>/.test(trigger),
    'stale: the card row prints "estimate · as of <date>" beside the reported balance', trigger.slice(0, 400));
  ok(!/data-card-movement-asof/.test(trigger), 'stale: the estimate replaces the plain as-of note');
  ok(/card-movement-lead[^>]*>[^<]*· <span data-card-movement-estimate>estimate — /.test(stale),
    'stale: the card panel lead line carries the estimate and its reason');
  const current = render('2026-09-18');
  ok(/data-budget-card-toggle="travelvisa"/.test(current) && !/data-card-movement-estimate/.test(current),
    'current: the strip shows the card with no estimate tag');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll page stale-card note checks passed.');
