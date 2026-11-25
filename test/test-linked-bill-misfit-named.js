'use strict';
// A payment linked to a bill that doesn't fit it (Grok, Plan #6,
// 2026-11-17). A posted row whose Lunch Money recurring link, or single
// "item:" note, names one bill whose rule rejects the row (account, date,
// amount, ...) is kept cautious: no payee fallback, neither bill settles, the
// payment counts once as money out to confirm, and its row carries one
// neutral line "Linked to <bill> but doesn't fit (<check>)".
//
// Invented household from test/acceptance/harness.js, through the real
// observer and Forecast, then the real Budget page in headless Chromium when
// available. Expectations are stated per case from the invented inputs: the
// row's amount, which bill it is linked to, and which gate the invented
// world breaks. Nothing here computes an expectation with Atlas code.
//
//   Base: income 1,400; plan Groceries 300 + Restaurants 100.
//   Two planned bills, both 63.21 due Oct 12 on chequing-a:
//     power: payee "Invented power co" (payee rule only)
//     water: payee "Invented water co", recurring id 7001, item "Invented water"
//   The misfit row: 63.21 on Oct 12, payee "Invented power co", linked to
//   water by recurring id (or note), but breaking one water gate.
//
//   node test/test-linked-bill-misfit-named.js
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');

const WATER_LINK = '7001';
function world({ waterRule = {}, row = {}, noRow = false, asOf } = {}) {
  const w = H.baseWorld(asOf);
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  w.bills = [
    { id: 'power', label: 'Invented power', frequency: 'monthly', day: 12, amount: 63.21, confidence: 'confirmed',
      payee: 'Invented power co' },
    { id: 'water', label: 'Invented water', frequency: 'monthly', day: 12, amount: 63.21, confidence: 'confirmed',
      payee: 'Invented water co', rule: Object.assign({ lunchMoneyRecurringIds: [WATER_LINK],
        lunchMoneyItemNames: ['Invented water'] }, waterRule) },
  ];
  if (!noRow) {
    const { raw, ...fields } = row;
    w.transactions.push(H.lm(Object.assign({ date: '2026-10-12', amount: 63.21, account: 'chequing-a',
      payee: 'Invented power co', raw: Object.assign({ recurring_id: Number(WATER_LINK) }, raw || {}) }, fields)));
  }
  return w;
}

function engine(w) {
  const { data, packet, error } = H.dataOf(w);
  H.expect(error == null, 'the observation is applied');
  const view = F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: packet })
    .payPeriodViews.find(r => r.start === '2026-10-09');
  const rows = (view.householdBudget || []).flatMap(r => (r.recon || []).map(t => ({ ...t, budgetRow: r.id })));
  const settled = ((packet && packet.representedActuals) || []).filter(r => r.id === 'power' || r.id === 'water');
  const txs = ((packet && packet.transactions) || []).filter(t => t.date !== '2026-10-09');
  return { bad: view.balanceAfterDeductions, rows, settled, txs };
}
const near = (a, b) => Math.abs(a - b) < 0.005;
const powerRow = r => r.rows.filter(t => t.displayedPayee === 'Invented power co');

// The misfit cases: which water gate the row breaks, and the check named.
const MISFITS = [
  { name: 'linked by recurring id, other account', check: 'account', world: () => world({ waterRule: { atlasAccountId: 'savings' } }) },
  // Six days after the due date: past the due-day window and past the three
  // near-due days (which name a row on its bill instead).
  { name: 'linked by recurring id, posted outside the due window', check: 'date', asOf: '2026-10-20',
    world: () => world({ asOf: '2026-10-20', row: { date: '2026-10-18' } }) },
  { name: 'linked by recurring id, far above the bill amount', check: 'amount', world: () => world({ row: { amount: 500 } }) },
  { name: 'linked by item note, other account', check: 'account',
    world: () => world({ waterRule: { atlasAccountId: 'savings' }, row: { notes: 'item: Invented water', raw: { recurring_id: null } } }) },
];

function hasBrowser() {
  if (process.env.CHROME_PATH) return true;
  try { require.resolve('playwright'); return true; } catch { return false; }
}

(async () => {
  let failures = 0;
  const report = (name, fn) => fn().then(() => console.log('  PASS  ' + name),
    err => { failures++; console.log('  FAIL  ' + name + ' -- ' + String(err && err.message || err).split('\n')[0]); });

  for (const c of MISFITS) {
    const none = engine(world({ noRow: true, asOf: c.asOf }));
    await report(`engine: ${c.name}: counted once, neither bill settled, named (${c.check})`, async () => {
      const w = c.world();
      const amount = Number(w.transactions[w.transactions.length - 1].amount);
      const r = engine(w);
      H.expect(r.settled.length === 0, `neither bill settles (got ${JSON.stringify(r.settled)})`);
      const shown = powerRow(r);
      H.expect(shown.length === 1, `the payment is listed once (got ${shown.length})`);
      H.expect(near(none.bad - r.bad, amount), `Balance After Deductions drops by the row's ${amount} exactly once (${none.bad} -> ${r.bad})`);
      const m = shown[0].linkedBillMisfit;
      H.expect(m && m.id === 'water' && m.label === 'Invented water' && m.check === c.check,
        `the row names water and the ${c.check} check (got ${JSON.stringify(m)})`);
    });
  }

  await report('engine: control: the same row fitting water settles water, with no line', async () => {
    const r = engine(world());
    H.expect(r.settled.length === 1 && r.settled[0].id === 'water', `water settles (got ${JSON.stringify(r.settled)})`);
    H.expect(powerRow(r).every(t => !t.linkedBillMisfit), 'no misfit line');
    H.expect(r.txs.every(t => !t.linkedBillMisfit), 'no misfit marker on the packet row');
  });
  await report('engine: control: with no link the payee rule settles power, with no line', async () => {
    const r = engine(world({ row: { raw: { recurring_id: null } } }));
    H.expect(r.settled.length === 1 && r.settled[0].id === 'power', `power settles (got ${JSON.stringify(r.settled)})`);
    H.expect(r.txs.every(t => !t.linkedBillMisfit), 'no misfit marker');
  });
  // Grok Bot (after #1265) changed this case: it still settles neither bill (the consumed-twice
  // path), and its line now names both bills instead of none.
  await report('engine: links naming different bills stay the consumed-twice path, and the line names both', async () => {
    const w = world({ waterRule: { lunchMoneyItemNames: [] } });
    w.bills[0].rule = { lunchMoneyItemNames: ['Invented power'] };
    w.transactions[w.transactions.length - 1].notes = 'item: Invented power';
    const r = engine(w);
    H.expect(r.settled.length === 0, `neither bill settles (got ${JSON.stringify(r.settled)})`);
    H.expect(r.txs.some(t => t.linkedBillMisfit && t.linkedBillMisfit.check === 'links disagree'), 'a links-disagree marker');
  });
  await report('engine: a near-due linked row is named on its bill, not given a misfit line', async () => {
    const r = engine(world({ row: { date: '2026-10-14' } }));
    H.expect(r.txs.length === 1 && r.txs[0].nearDueBillCandidate && r.txs[0].nearDueBillCandidate.id === 'water',
      `held as water's to-confirm candidate (got ${JSON.stringify(r.txs.map(t => t.nearDueBillCandidate))})`);
    H.expect(r.txs.every(t => !t.linkedBillMisfit), 'no misfit marker');
  });
  // Grok Bot (after #1265): disagreeing links settle neither; the payment is money out to confirm,
  // and its one line names both bills.
  const crossLinked = () => {
    const w = world({ waterRule: { lunchMoneyItemNames: [] }, row: { notes: 'item: Invented power' } });
    w.bills[0].rule = { lunchMoneyItemNames: ['Invented power'] };
    return w;
  };
  await report('engine: a recurring link and an item note naming different bills: counted once, neither settled, both named', async () => {
    const w = crossLinked();
    const none = engine(world({ noRow: true }));
    const r = engine(w);
    H.expect(r.settled.length === 0, `neither bill settles (got ${JSON.stringify(r.settled)})`);
    const shown = powerRow(r);
    H.expect(shown.length === 1, `the payment is listed once (got ${shown.length})`);
    H.expect(near(none.bad - r.bad, 63.21), `the remainder drops by 63.21 exactly once (${none.bad} -> ${r.bad})`);
    const m = shown[0].linkedBillMisfit;
    H.expect(m && m.check === 'links disagree' && m.label === 'Invented water' && m.otherLabel === 'Invented power',
      `the line names both bills (got ${JSON.stringify(m)})`);
  });
  // Grok Bot (after #1264): a renamed claimed category links nothing (no payee fallback) and its line names it.
  const renamedCategory = () => {
    const w = world({ noRow: true });
    w.categories.push({ id: 9301, name: 'Invented utilities renamed' });
    w.bills[0].rule = { lunchMoneyCategoryIds: [{ id: '9301', name: 'Invented utilities' }] };
    w.transactions.push(H.lm({ date: '2026-10-12', amount: 63.21, account: 'chequing-a', payee: 'Invented power co', category: 9301 }));
    return w;
  };
  await report('engine: a renamed claimed category: no link, no payee fallback, counted once, the category named', async () => {
    const r = engine(renamedCategory());
    const none = engine(world({ noRow: true }));
    H.expect(r.settled.length === 0, `no bill settles (got ${JSON.stringify(r.settled)})`);
    const shown = powerRow(r);
    H.expect(shown.length === 1 && near(none.bad - r.bad, 63.21), `listed and counted once (${shown.length}; ${none.bad} -> ${r.bad})`);
    const m = shown[0].linkedBillMisfit;
    H.expect(m && m.check === 'category' && m.label === 'Invented power' && m.categoryName === 'Invented utilities renamed',
      `the line names the category (got ${JSON.stringify(m)})`);
  });
  // Lead (rule 13, after Grok Bot's answer): a removed claimed category names the last confirmed name.
  const removedCategory = entry => {
    const w = world({ noRow: true });
    w.bills[0].rule = { lunchMoneyCategoryIds: [entry] };
    w.transactions.push(H.lm({ date: '2026-10-12', amount: 63.21, account: 'chequing-a', payee: 'Invented power co', category: 9302 }));
    return w;
  };
  await report('engine: a removed claimed category: no link, counted once, the last confirmed name carried', async () => {
    const r = engine(removedCategory({ id: '9302', name: 'Invented natural gas' }));
    const none = engine(world({ noRow: true }));
    H.expect(r.settled.length === 0, `no bill settles (got ${JSON.stringify(r.settled)})`);
    const shown = powerRow(r);
    H.expect(shown.length === 1 && near(none.bad - r.bad, 63.21), `listed and counted once (${shown.length}; ${none.bad} -> ${r.bad})`);
    const m = shown[0].linkedBillMisfit;
    H.expect(m && m.check === 'category' && m.categoryName === null && m.confirmedCategoryName === 'Invented natural gas',
      `the line carries the confirmed name (got ${JSON.stringify(m)})`);
  });
  await report('engine: a removed claimed category with no confirmed name carries none', async () => {
    const r = engine(removedCategory('9302'));
    const m = (powerRow(r)[0] || {}).linkedBillMisfit;
    H.expect(m && m.check === 'category' && m.categoryName === null && m.confirmedCategoryName == null,
      `no confirmed name (got ${JSON.stringify(m)})`);
  });
  // Lead (on #1267): the naming notes are for money out only; a refund on either path gets no line.
  await report('engine: a refund on the cross-linked or removed-category path carries no line', async () => {
    const cross = crossLinked();
    cross.transactions[cross.transactions.length - 1].amount = '-63.21';
    const removed = removedCategory({ id: '9302', name: 'Invented natural gas' });
    removed.transactions[removed.transactions.length - 1].amount = '-63.21';
    const renamed = renamedCategory();
    renamed.transactions[renamed.transactions.length - 1].amount = '-63.21';
    for (const [what, w] of [['cross-linked', cross], ['removed category', removed], ['renamed category', renamed]]) {
      const r = engine(w);
      H.expect(r.settled.length === 0, `${what}: nothing settles (got ${JSON.stringify(r.settled)})`);
      H.expect(r.txs.length === 1 && r.txs.every(t => !t.linkedBillMisfit),
        `${what}: the refund is observed with no line (got ${JSON.stringify(r.txs.map(t => [t.amount, t.linkedBillMisfit]))})`);
    }
  });
  await report('engine: control: the confirmed category name links power, with no line', async () => {
    const w = renamedCategory();
    w.bills[0].rule = { lunchMoneyCategoryIds: [{ id: '9301', name: 'Invented utilities renamed' }] };
    const r = engine(w);
    H.expect(r.settled.length === 1 && r.settled[0].id === 'power', `power settles (got ${JSON.stringify(r.settled)})`);
    H.expect(r.txs.every(t => !t.linkedBillMisfit), 'no line');
  });
  await report('engine: a pending linked row carries no misfit line', async () => {
    const r = engine(world({ waterRule: { atlasAccountId: 'savings' }, row: { pending: true } }));
    H.expect(r.txs.every(t => !t.linkedBillMisfit), `no misfit marker (got ${JSON.stringify(r.txs.map(t => t.linkedBillMisfit))})`);
  });

  if (!hasBrowser() || process.env.ATLAS_SKIP_BROWSER === '1') {
    console.log('  SKIP  rendered-page cases: Playwright Chromium is not available here');
  } else {
    await report('page: the misfit row prints one neutral line naming the bill and the check', () =>
      H.withBudget(MISFITS[0].world(), async p => {
        const s = await H.snap(p);
        H.expect(H.occurrences(s.household, "Linked to Invented water but doesn't fit (account)") === 1,
          'one neutral line on the row');
        H.expect(await p.page.locator('[data-tx-linked-misfit="water"]').evaluate(e => e.className) === 'household-budget-tx-note',
          'the line uses the neutral note style, not the alert style');
        // Grok condition 2: both bills read To confirm while the misfit stands.
        for (const label of ['Invented water', 'Invented power']) {
          H.expectMatch(H.bill(s, label), /To confirm/, `${label} reads To confirm`);
          H.expectNoMatch(H.bill(s, label), /\bPaid\b/, `${label} is not Paid`);
        }
      }));
    await report('page: the cross-linked payment names both bills in the same note', () =>
      H.withBudget(crossLinked(), async p => {
        const s = await H.snap(p);
        H.expect(H.occurrences(s.household, "Linked to Invented water and Invented power but doesn't fit (links disagree)") === 1,
          'one note naming both bills');
      }));
    await report('page: the renamed category is named in the same note', () =>
      H.withBudget(renamedCategory(), async p => {
        const s = await H.snap(p);
        H.expect(H.occurrences(s.household, "Linked to Invented power but doesn't fit (category \u201cInvented utilities renamed\u201d)") === 1,
          'one note naming the category');
      }));
    await report('page: a removed category names the last confirmed name, else reads plainly removed', async () => {
      await H.withBudget(removedCategory({ id: '9302', name: 'Invented natural gas' }), async p => {
        const s = await H.snap(p);
        H.expect(H.occurrences(s.household, "Linked to Invented power but doesn't fit (category \u201cInvented natural gas\u201d removed)") === 1,
          'one note naming the removed category');
      });
      await H.withBudget(removedCategory('9302'), async p => {
        const s = await H.snap(p);
        H.expect(H.occurrences(s.household, "Linked to Invented power but doesn't fit (category removed)") === 1,
          'one plain removed note');
      });
    });
    await report('page: control: a fitting row prints no misfit line', () =>
      H.withBudget(world(), async p => {
        const s = await H.snap(p);
        H.expectExcludes(s.all, "but doesn't fit", 'no misfit line');
      }));
    await H.closeBrowser();
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
  process.exit(failures ? 1 : 0);
})();
