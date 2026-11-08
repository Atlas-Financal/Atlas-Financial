'use strict';
const assert = require('node:assert/strict');

// Expected members are supplied as independent fixture literals, never read
// from Forecast or inferred from a rendered bucket/status.
async function assertTypedBillFilters(page, bills, expected) {
  const keys = ['check', 'due', 'paid', 'pending', 'unknown'];
  assert.deepEqual(Object.keys(expected).sort(), keys.slice().sort());
  const all = keys.flatMap(key => expected[key]).sort();
  assert.equal(new Set(all).size, all.length, 'each expected occurrence has one state');
  const members = locator => locator.evaluateAll(rows => rows.map(row =>
    row.getAttribute('data-budget-bill-open') + '@' + row.getAttribute('data-budget-bill-date')).sort());
  const rows = bills.locator('[data-budget-bill-open]');
  assert.deepEqual(await members(rows), all, 'every original occurrence exists exactly once');
  const controls = ['all', 'check', 'due', 'paid', ...keys.filter(key =>
    ['pending', 'unknown'].includes(key) && expected[key].length)];
  assert.deepEqual(await bills.locator('[data-budget-bill-filter]').evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('data-budget-bill-filter')).sort()), controls.slice().sort());
  for (const key of keys) {
    assert.deepEqual(await members(bills.locator(`[data-budget-bill-bucket="${key}"] [data-budget-bill-open]`)),
      expected[key].slice().sort(), key + ' preserves its exact independent members');
  }
  const input = await page.evaluate(() => JSON.stringify(App.data));
  for (const key of controls) {
    const control = bills.locator(`[data-budget-bill-filter="${key}"]`);
    const wanted = key === 'all' ? all : expected[key].slice().sort();
    assert.equal(await control.locator('span').innerText(), String(wanted.length), key + ' count');
    assert.equal(await control.isVisible(), true, key + ' control is visible');
    await control.focus(); await page.keyboard.press('Enter');
    assert.deepEqual(await bills.locator('[data-budget-bill-filter][aria-pressed="true"]').evaluateAll(nodes =>
      nodes.map(node => node.getAttribute('data-budget-bill-filter'))), [key], 'selection is exclusive');
    assert.deepEqual(await members(bills.locator('[data-budget-bill-open]:visible')), wanted,
      key + ' shows exactly its members; other states never leak into Paid');
    assert.equal(await bills.locator('[data-budget-bill-filter-empty]').isVisible(), key !== 'all' && !wanted.length);
    assert.equal(await control.evaluate(node => node === document.activeElement), true, key + ' retains keyboard focus');
    // #548 makes selection explicit: a second activation does not mean All.
    await page.keyboard.press('Enter');
    assert.equal(await control.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await members(bills.locator('[data-budget-bill-open]:visible')), wanted);
  }
  const restore = bills.locator('[data-budget-bill-filter="all"]');
  await restore.focus(); await page.keyboard.press('Enter');
  assert.deepEqual(await members(bills.locator('[data-budget-bill-open]:visible')), all,
    'All restores every occurrence after every typed filter');
  assert.equal(await page.evaluate(() => JSON.stringify(App.data)), input,
    'filter interactions never mutate the served financial packet');
}

// Additional display-only publication proof. Actual renderer and filter event
// wiring consume fixed invented rows; expected membership below is independent.
// This supplements, and never replaces, the real App/Forecast occurrence cases.
async function assertPublishedFilterStates(page) {
  const rows = [
    { id: 'invented-paid', status: 'PAID', settlement: 'represented', date: '2026-08-15' },
    { id: 'invented-due', status: 'still due', settlement: 'upcoming', date: '2026-08-21' },
    { id: 'invented-pending', status: 'pending', settlement: 'pending', date: '2026-08-19' },
    { id: 'invented-check', status: 'still due', settlement: 'unverified', date: '2026-08-18' },
    { id: 'invented-unknown', status: 'unknown', settlement: 'unknown', date: '2026-08-17' },
    { id: 'invented-contradiction', status: 'PAID', settlement: 'unverified', date: '2026-08-16' },
  ];
  await page.evaluate(rows => {
    const mount = document.createElement('div');
    mount.setAttribute('data-invented-filter-proof', '');
    const before = JSON.stringify(rows), ctx = { asOf: '2026-08-20' };
    mount.innerHTML = budgetBillsSectionHtml({ bills: rows }, ctx);
    if (JSON.stringify(rows) !== before) throw Error('Rendering rewrote the invented publication');
    document.body.append(mount);
    wireBudgetBrowse(mount, ctx, { open() { throw Error('Filter interaction opened unrelated evidence'); } });
  }, rows);
  const mount = page.locator('[data-invented-filter-proof]');
  try {
    await assertTypedBillFilters(page, mount, {
      paid: ['invented-paid@2026-08-15'], due: ['invented-due@2026-08-21'],
      pending: ['invented-pending@2026-08-19'], unknown: ['invented-unknown@2026-08-17'],
      check: ['invented-check@2026-08-18', 'invented-contradiction@2026-08-16'],
    });
  } finally { await mount.evaluate(node => node.remove()); }
}
module.exports = { assertTypedBillFilters, assertPublishedFilterStates };
