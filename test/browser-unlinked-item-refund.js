'use strict';
// An untagged refund of a tag-linked item purchase is not netted into a
// household category, and the item's Paid evidence becomes Unknown, through
// the Budget page a household reads. Real page, invented household from
// test/acceptance/harness.js (income 1,400; Groceries 300 + Eating out 100;
// one 500 trip); no household figure enters this file.
//
//   node test/browser-unlinked-item-refund.js
//
// Expectations are hand-derived from the rule, not read from the code:
//   1. trip linked by tag; an 80 Restaurants purchase carries the tag; a -80
//      refund at the same merchant on the same account carries no tag; a 30
//      household diner. Eating out shows Spent 30, 70 left (never -50 / 150);
//      the trip's Paid is Unknown (never a precise 80).
//   2. a fully refunded 200 tag-linked purchase in category Trip, refund
//      untagged: Paid is Unknown (never a precise 200).
//   3. controls: the same untagged refund at a different merchant, or at the
//      same merchant on a different account, still nets into Eating out as
//      before (G3a), and the trip keeps its precise Paid 80.
//   4. control: a refund carrying the trip tag still nets against the trip
//      (Paid 0, Needed 500), not against Eating out.
const H = require('./acceptance/harness.js');

const TRIP = '2026-12-01';
const tagLink = { tagId: 201, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: TRIP,
  effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' };
function world() {
  const w = H.baseWorld();
  w.commitments = [{ id: 'trip', label: 'Invented trip', date: TRIP, amount: 500, confidence: 'confirmed', sinkingFund: true }];
  w.savingsPool = {};
  w.tags = [{ id: 201, name: 'invented-trip-tag' }];
  w.links = [tagLink];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}
const eatingOut = s => H.category(s, 'Eating out');
const trip = s => H.goal(s, 'Invented trip');

const cases = [
  ['an untagged refund of a tagged Restaurants trip purchase stays out of Eating out; trip Paid is Unknown', async () => {
    const w = world();
    w.transactions.push(
      H.lm({ date: '2026-10-10', amount: 80, category: 'Restaurants', tagIds: [201], payee: 'Invented trip diner' }),
      H.lm({ date: '2026-10-12', amount: -80, category: 'Restaurants', payee: 'Invented trip diner' }),
      H.lm({ date: '2026-10-11', amount: 30, category: 'Restaurants', payee: 'Invented home diner' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(eatingOut(s), /Spent \$30\.00/, 'Eating out spent is the household diner only');
      H.expectMatch(eatingOut(s), /\$70\.00 left/, 'Eating out remaining is 100 - 30');
      H.expectNoMatch(eatingOut(s), /[−-]\$/, 'no category goes negative from a foreign refund');
      H.expectMatch(s.household, /Household Budget TotalActual \/ Planned \$30\.00/, 'the household total agrees with the rows');
      H.expectFigure(trip(s), 'Paid', 'Unknown', 'trip Paid is Unknown, never a precise 80');
    });
  }],
  ['a fully refunded tag-linked Trip purchase with an untagged refund: trip Paid is Unknown', async () => {
    const w = world();
    w.transactions.push(
      H.lm({ date: '2026-10-10', amount: 200, category: 'Trip', tagIds: [201], payee: 'Invented airline' }),
      H.lm({ date: '2026-10-12', amount: -200, category: 'Trip', payee: 'Invented airline' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectFigure(trip(s), 'Paid', 'Unknown', 'trip Paid is Unknown, never a precise 200');
      H.expectNoMatch(trip(s), /\$300\.00/, 'no calculated Needed 300 from the unrefunded charge');
    });
  }],
  ['control: a refund at a different merchant, or on a different account, still nets into Eating out', async () => {
    for (const [refund, why] of [
      [{ payee: 'Invented home diner' }, 'different merchant'],
      [{ payee: 'Invented trip diner', account: 'chequing-a' }, 'different account'],
    ]) {
      const w = world();
      w.transactions.push(
        H.lm({ date: '2026-10-10', amount: 80, category: 'Restaurants', tagIds: [201], payee: 'Invented trip diner' }),
        H.lm({ date: '2026-10-11', amount: 30, category: 'Restaurants', payee: 'Invented home diner' }),
        H.lm({ date: '2026-10-12', amount: -10, category: 'Restaurants', ...refund }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(eatingOut(s), /Spent \$20\.00/, why + ': the refund nets, 30 - 10');
        H.expectFigure(trip(s), 'Paid', '$80.00', why + ': the trip keeps its precise Paid 80');
      });
    }
  }],
  ['control: a refund carrying the trip tag nets against the trip', async () => {
    const w = world();
    w.transactions.push(
      H.lm({ date: '2026-10-10', amount: 80, category: 'Restaurants', tagIds: [201], payee: 'Invented trip diner' }),
      H.lm({ date: '2026-10-12', amount: -80, category: 'Restaurants', tagIds: [201], payee: 'Invented trip diner' }),
      H.lm({ date: '2026-10-11', amount: 30, category: 'Restaurants', payee: 'Invented home diner' }));
    await H.withBudget(w, async p => {
      const s = await H.snap(p);
      H.expectMatch(eatingOut(s), /Spent \$30\.00/, 'Eating out spent is the household diner only');
      H.expectFigure(trip(s), 'Paid', '$0.00', 'the tagged refund nets the trip to Paid 0');
      H.expectMatch(trip(s), /\$500\.00/, 'trip Needed is the full 500');
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
