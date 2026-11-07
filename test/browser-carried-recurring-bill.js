'use strict';
// Lead decision 2026-11-07: an unproven recurring bill from the immediately
// preceding closed pay period is carried into the current pay period as
// "to pay or confirm", once, like an unproven one-off. Through the real Budget
// page (public/index.html) a household reads. Invented household from
// test/acceptance/harness.js (current Oct 9 - Oct 22, 2026, as-of Oct 14);
// no household figure enters this file.
//
//   node test/browser-carried-recurring-bill.js
//
// Cases:
//   1. unpaid monthly water 120 due Oct 1: one "To confirm" row in the current
//      period, Bills shows 120 left to pay or confirm, cash needed counts it;
//   2. a posted matching debit on Oct 1: no current row, Paid in history;
//   3. the owner's represented record for Oct 1: no current row;
//   4. due Sep 15 (two periods back, dated opening Sep 1): only Oct 15 is
//      listed in the current period;
//   5. a same-date pending matching debit (it reaches the packet): still one
//      "To confirm" row (the funding
//      proposal is withheld until it settles, as for a pending one-off).
const H = require('./acceptance/harness.js');

const WATER = { id: 'water', label: 'Invented water', amount: 120, frequency: 'monthly', day: 1,
  confidence: 'confirmed', payee: 'Invented water co' };
// Production shape: a dated opening on Sep 20 and a live observation on
// Oct 14, so the real live overlay rolls the opening forward (priorAsOf).
function world(patch) {
  const w = H.baseWorld();
  w.bills = [Object.assign({}, WATER)];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  w.savingsPool = true; // Savings is a required live-cash identity; the pool maps it.
  w.datedOpening = '2026-09-20';
  w.ownerRepresented = [];
  if (patch) patch(w);
  w.planPatch = p => {
    p.opening.asOf = w.datedOpening;
    delete p.opening.priorAsOf;
    p.opening.representedEvents.push(...w.ownerRepresented);
  };
  return w;
}
const waterRows = s => s.bills.filter(t => t.includes('Invented water'));

const cases = [
  ['unpaid recurring bill carried once', world(), async (p, s) => {
    H.expect(s.range.startsWith('Oct 9'), 'positive control: the current period is shown');
    const rows = waterRows(s);
    H.expect(rows.length === 1, `one current water row, found ${rows.length}`);
    H.expectIncludes(rows[0], 'October 1', 'keeps its real due date');
    H.expectIncludes(rows[0], '$120.00', 'carried at 120');
    H.expectIncludes(rows[0], 'To confirm', 'to pay or confirm');
    H.expectIncludes(H.section(s, 'Bills'), 'of planned $120.00', 'counted once in the period bills');
    H.expectMatch(s.hero, /Bills & debt payments\s*calculated \$120\.00/, 'cash needed counts it once');
    const browse = await p.text('[data-budget-browse-bills-remaining]');
    H.expectIncludes(browse, '$120.00', 'Bills left to pay or confirm');
  }],
  ['posted matching debit clears it', world(w => w.transactions.push(H.lm({ date: '2026-10-01', amount: 120,
    payee: 'Invented water co', account: 'chequing-a', category: 'Utilities' }))), async (p, s) => {
    H.present(H.section(s, 'Bills'), 'positive control: Bills is rendered');
    H.expect(waterRows(s).length === 0, 'no current water row');
    H.expectMatch(s.hero, /Bills & debt payments\s*calculated \$0\.00/, 'not in cash needed');
    await p.step(-1);
    const t = await H.snap(p);
    H.expect(t.range.startsWith('Sep 25'), 'positive control: the previous period is shown');
    H.expectIncludes(waterRows(t).join(' | '), 'Paid', 'paid in its own history');
  }],
  ['owner-confirmed paid is not carried', world(w => { w.ownerRepresented = [{ id: 'water', date: '2026-10-01' }]; }), async (p, s) => {
    H.present(H.section(s, 'Bills'), 'positive control: Bills is rendered');
    H.expect(waterRows(s).length === 0, 'no current water row');
    H.expectMatch(s.hero, /Bills & debt payments\s*calculated \$0\.00/, 'not in cash needed');
  }],
  ['two periods old is not carried', world(w => { w.bills[0].day = 15; w.datedOpening = '2026-09-01'; }), async (p, s) => {
    const rows = waterRows(s);
    H.expect(rows.length === 1, `one current water row, found ${rows.length}`);
    H.expectIncludes(rows[0], 'October 15', 'only the current occurrence');
    H.expectExcludes(rows[0], 'September 15', 'Sep 15 is not carried');
  }],
  ['pending matching debit keeps it carried', world(w => w.transactions.push(H.lm({ date: '2026-10-01', amount: 120,
    payee: 'Invented water co', account: 'chequing-a', category: 'Utilities', pending: true }))), async (p, s, packet) => {
    H.expect(((packet && packet.representedActuals) || []).some(a => a.id === 'water' && a.date === '2026-10-01'),
      'positive control: the same-date pending debit matched the Oct 1 bill');
    const rows = waterRows(s);
    H.expect(rows.length === 1, `one current water row, found ${rows.length}`);
    H.expectIncludes(rows[0], 'October 1', 'the Oct 1 occurrence');
    H.expectIncludes(rows[0], 'To confirm', 'still to pay or confirm');
    H.expectIncludes(H.section(s, 'Bills'), 'of planned $120.00', 'counted once in the period bills');
    // Same as a pending one-off: the pending debit withholds the funding
    // proposal until it settles; it never clears the bill.
    H.expectNoMatch(s.hero, /Bills & debt payments\s*calculated \$0\.00/, 'never shown as nothing owed');
  }],
];

(async () => {
  let failed = 0;
  for (const [name, w, fn] of cases) {
    try {
      await H.withBudget(w, async (p, packets) => {
        const s = await H.snap(p);
        await fn(p, s, packets[0]);
        H.expect(!p.errors.length, 'no page errors: ' + p.errors.join('; '));
      });
      console.log('  ok ' + name);
    } catch (e) {
      failed += 1;
      console.log('  FAIL ' + name + ': ' + (e && e.message));
    }
  }
  await H.closeBrowser();
  console.log(failed ? `${failed} failed` : `${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
