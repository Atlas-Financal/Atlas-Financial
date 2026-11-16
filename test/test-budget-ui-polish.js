'use strict';
/* Approved Budget UI presentation contract.
 *
 * This is deliberately a presentation test. Forecast and plan.js still own
 * every amount and settlement state; budget-polish.js may only translate an
 * already-rendered status into visual language and rearrange existing DOM.
 */
const fs = require('fs');
const path = require('path');
const UI = require('../public/budget-polish.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

console.log('=== Budget polish stays downstream of Forecast ===');
{
  const src = read('public/budget-polish.js');
  ok(!/Forecast\s*\./.test(src), 'presentation layer does not call Forecast');
  ok(!/data\.json|periods\.json|fetch\s*\(/.test(src),
    'presentation layer does not read canonical financial sources');
  ok(!/reduce\s*\(|\.amount\s*[+\-*/]/.test(src),
    'presentation layer does not total or recalculate money');
  ok(/data-live-current-balance/.test(src)
    && /data-payday-balance/.test(src)
    && /data-operating-question/.test(src),
    'presentation reads the incumbent rendered semantic DOM');
  ok(!/Rollover balance/.test(src),
    'presentation no longer prints Rollover balance');
}

console.log('\n=== approved bill status language is calm and explicit ===');
{
  const paid = UI.billStatePresentation('PAID');
  const toPay = UI.billStatePresentation('still due', 'upcoming');
  const pending = UI.billStatePresentation('pending');
  const check = UI.billStatePresentation('needs confirmation');
  ok(paid && paid.label === 'Paid' && paid.kind === 'paid',
    'settled bill maps to Paid');
  ok(toPay && toPay.label === 'Not paid' && toPay.kind === 'to-pay',
    'published unpaid bill maps to Not paid');
  ok(UI.billStatePresentation('planned', 'upcoming').label === 'Not paid'
    && UI.billStatePresentation('planned', 'upcoming').kind === 'to-pay',
    'future planned/upcoming matches browse Not paid without date inference');
  ok(UI.billStatePresentation('planned', 'unverified').kind === 'check'
    && UI.billStatePresentation('planned', 'unknown').kind === 'unknown'
    && UI.billStatePresentation('planned', null).kind === 'unknown',
    'planned status alone cannot promote absent, unknown or unverified settlement');
  ok(pending && pending.label === 'Payment pending',
    'pending keeps its incumbent meaning rather than being relabelled paid/unpaid');
  ok(check && check.label === 'To confirm',
    'needs-confirmation remains distinct from unpaid');
  ok(!/[!]/.test([paid, toPay, pending, check].map(x => x.label).join(' ')),
    'normal bill states use no alarm icon or exclamation wording');
  ok(UI.cleanBillLabel('Mortgage · Aug 28 · PAID', 'PAID') === 'Mortgage · Aug 28',
    'inline PAID suffix is removed when a status pill will replace it');
  ok(UI.cleanBillLabel('BC Hydro · Sep 1 · still due', 'still due') === 'BC Hydro · Sep 1',
    'inline still-due suffix is removed when TO PAY pill will replace it');
}

console.log('\n=== approved hierarchy and app navigation are present ===');
{
  const html = read('public/index.html');
  const css = read('public/budget-polish.css');
  const polishJs = read('public/budget-polish.js');
  const shared = read('public/styles.css');
  ok(/budget-polish\.css/.test(html) && /budget-polish\.js/.test(html),
    'Budget page loads the approved visual layer');
  ok(/atlas-current-balance-card/.test(css)
    && /atlas-income-card \[data-payday-balance\]/.test(css)
    && /atlas-income-closing/.test(css),
    'Current Balance and income closing total have dedicated hierarchy');
  ok(/atlas-income-card/.test(css)
    && /atlas-bills-card/.test(css)
    && /atlas-household-budget-card/.test(css),
    'Income, Bills and Household Budget remain first-class distinct cards');
  ok(/atlas-bill-row-paid/.test(css)
    && /atlas-bill-row-to-pay/.test(css)
    && /atlas-bill-row-pending/.test(css)
    && /atlas-bill-row-check/.test(css)
    && /atlas-bill-row-unknown/.test(css),
    'paid, not-paid, pending, unconfirmed and unknown rows retain distinct status classes');
  ok(!/atlas-period-summary/.test(polishJs) && !/atlas-payday-summary/.test(polishJs)
      && !/atlas-period-summary/.test(css),
    'polish no longer lifts Payday balance into a top-glance summary');
  ok(/atlas-income-closing/.test(polishJs)
      && /classList\.add\('atlas-income-closing'\)/.test(polishJs),
    'polish marks Payday balance as the income-card closing total in place');
  ok(/--atlas-purple:\s*color-mix\([^;]*var\(--text-primary\)[^;]*\);/.test(css),
    'Bills accent adapts against the current theme text token instead of using a dark-only low-contrast fixed purple');
  ok(/--nav-icon-budget/.test(shared)
    && /--nav-icon-bills/.test(shared)
    && /--nav-icon-subscriptions/.test(shared)
    && /--nav-icon-credit/.test(shared)
    && /--nav-icon-planning/.test(shared)
    && /--nav-icon-plan-spend/.test(shared)
    && /data-nav="forecast"/.test(shared)
    && /data-nav="plan-spend"/.test(shared)
    && !/--nav-icon-talk/.test(shared),
    'all six household tab icons remain defined');
  ok(/\.sitenav-household \.sitenav-icon[\s\S]*display:block/.test(shared),
    'phone tab selector renders icons');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
