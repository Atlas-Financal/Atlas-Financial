'use strict';
// Confirmed spend in a household category that has no target this pay
// period is never dropped from the Budget. Real page, invented household
// from test/acceptance/harness.js (raw Lunch Money payload -> provider-observe
// -> live-plan -> real public/index.html boot); no household figure enters
// this file, and every expectation is hand-derived from the invented inputs.
//
//   node test/browser-budget-untargeted-category-spend.js
//
// Invented household: income 1,400 on Oct 9; Groceries 300 + Eating out 100
// per payday, so with nothing else Balance After Deductions is 1,400 - 400 =
// 1,000. A Household category is added and one $45 Household purchase posts
// Oct 12, inside the Oct 9 - Oct 22 pay period.
//
// A category has no target this period in three ways (the three null
// sources of the payday-cycle planned amount):
//   1. every-other-payday cadence anchored Sep 25, so the Oct 9 period is OFF;
//   2. an explicit $0 monthly target;
//   3. a $100 per-payday target that only takes effect Oct 23.
// Each must show the purchase in a Household row (planned $0.00, spent
// $45.00), lift the household total to 45 actual and 445 deducted, and
// leave Balance After Deductions at 1,000 - 45 = 955.
//
// Controls:
//   4. ON cycle (anchor Oct 9): planned 100, spent 45, 55 left; the hold is
//      max(100, 45) = 100, so Balance After Deductions is 1,400 - 500 = 900.
//   5. OFF cycle with no Household purchase: no Household row is added and
//      Balance After Deductions stays 1,000.
const H = require('./acceptance/harness.js');

const HOUSEHOLD_LM_CATEGORY = 111;
const PAYEE = 'Invented hardware store';

function world(target, withPurchase = true) {
  const w = H.baseWorld();
  w.categories.push({ id: HOUSEHOLD_LM_CATEGORY, name: 'Household' });
  w.budget.push(Object.assign({ id: 'household', label: 'Household', class: 'essential',
    confidence: 'confirmed', from: ['Household'] }, target));
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  if (withPurchase) w.transactions.push(H.lm({ date: '2026-10-12', amount: 45, category: HOUSEHOLD_LM_CATEGORY, payee: PAYEE }));
  return w;
}

async function read(p) {
  const s = await H.snap(p);
  s.bad = (await p.rows('[data-operating-question="07"]')).join(' ');
  return s;
}

function expectUntargetedSpendCounted(s, why) {
  H.expectMatch(s.range, /Oct 9/, why + ': positive control, the Oct 9 - Oct 22 period is open');
  const row = H.category(s, 'Household');
  H.expect(row, why + ': the Household category row is on the page');
  H.expectMatch(row, /Spent \$45\.00/, why + ': the purchase is spent in Household');
  H.expectMatch(row, /of planned \$0\.00/, why + ': no target this period is planned $0, not hidden');
  H.expectIncludes(s.household, PAYEE, why + ': the purchase is listed in the household budget');
  H.expectMatch(s.household, /Household budget \$45\.00 \/ of planned \$400\.00\$445\.00/,
    why + ': actual 0 + 0 + 45 against planned 300 + 100 + 0; deducted 300 + 100 + 45');
  H.expectMatch(s.bad, /Balance After Deductions \$955\.00/, why + ': 1,400 - 445');
  H.expect(!/Other spending/.test(s.categories.join(' | ')), why + ': counted once, in Household, not again in Other');
}

const OFF_CYCLE = { plannedPayday: 100, paydayCadence: 'every-other-seaspan', paydayCadenceAnchor: '2026-09-25' };

const cases = [
  ['OFF cycle of an every-other-payday category', async () => {
    await H.withBudget(world(OFF_CYCLE), async p => expectUntargetedSpendCounted(await read(p), 'OFF cycle'));
  }],
  ['explicit $0 monthly target', async () => {
    await H.withBudget(world({ plannedMonthly: 0 }), async p => expectUntargetedSpendCounted(await read(p), '$0 monthly'));
  }],
  ['target not yet in effect', async () => {
    await H.withBudget(world({ plannedPayday: 100, targetEffectiveFrom: '2026-10-23' }),
      async p => expectUntargetedSpendCounted(await read(p), 'target effective Oct 23'));
  }],
  ['control: ON cycle keeps its planned hold', async () => {
    await H.withBudget(world({ plannedPayday: 100, paydayCadence: 'every-other-seaspan', paydayCadenceAnchor: '2026-10-09' }), async p => {
      const s = await read(p);
      const row = H.category(s, 'Household');
      H.expectMatch(row, /\$55\.00 left Spent \$45\.00 \/ of planned \$100\.00/, 'ON cycle: 100 planned, 45 spent, 55 left');
      H.expectMatch(s.household, /Household budget \$45\.00 \/ of planned \$500\.00\$500\.00/, 'ON cycle: deducted max(100, 45) = 100 for Household');
      H.expectMatch(s.bad, /Balance After Deductions \$900\.00/, 'ON cycle: 1,400 - 500');
    });
  }],
  ['control: no spend, no untargeted row', async () => {
    await H.withBudget(world(OFF_CYCLE, false), async p => {
      const s = await read(p);
      H.expectMatch(H.category(s, 'Groceries'), /of planned \$300\.00/, 'positive control: the category rows are rendered');
      H.expect(!H.category(s, 'Household'), 'OFF cycle with nothing spent prints no Household row');
      H.expectMatch(s.bad, /Balance After Deductions \$1,000\.00/, 'OFF cycle with nothing spent: 1,400 - 400');
    });
  }],
];

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
