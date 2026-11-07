'use strict';
// Check 7 — Transactions appear once, correctly sorted, with item-only notes.
// Spec: #787 6622324225 (check 7 scenarios), the bills/sorting blueprint #787
// 6595179923 ("Other" holds only positively established, unassigned
// spending; refunds inherit their original bucket), the A4/A5 blueprint
// #787 6620986508 §1 (pending replaced by posted successor, split parents
// excluded), and audit C1 (#787 6621636966 finding 1). "Item-only notes":
// only a note the household deliberately marks "item:" is displayed (the
// #840 displayed-note contract); every other note stays private.
// Invented numbers only; expectations hand-derived from those rules.
//
// 7.4, 7.5, 7.8 and 7.10 are the adopted spec scenarios on this calendar;
// the rest are derived from the blueprints, plus audit repros C1/C2.

function txWorld(H) {
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}
// Dates of the transaction rows in one category's detail sheet, in page order.
async function detailDates(p, id) {
  const text = await p.openDetail(`[data-budget-category-open="${id}"]`);
  return { text, dates: (text.match(/\b(Sep|Oct) \d{1,2}\b/g) || []) };
}
const dayOf = d => (d.startsWith('Sep') ? 900 : 1000) + Number(d.split(' ')[1]);

const scenarios = [
  {
    id: '7.1', basis: 'derived', name: 'each transaction is listed once across the Budget page',
    async run(H) {
      const w = txWorld(H);
      w.bills = [{ id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' }];
      w.transactions.push(
        H.lm({ date: '2026-10-10', amount: 40, category: 'Groceries', payee: 'Invented grocer A' }),
        H.lm({ date: '2026-10-11', amount: 25.5, category: 'Restaurants', payee: 'Invented diner' }),
        H.lm({ date: '2026-10-12', amount: 90, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro' }),
        H.lm({ date: '2026-10-13', amount: 18, category: 'Uncategorised', payee: 'Invented kiosk' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        for (const payee of ['Invented grocer A', 'Invented diner', 'Invented kiosk'])
          H.expect(H.occurrences(s.household, payee) === 1, `${payee} is listed exactly once in Household (got ${H.occurrences(s.household, payee)})`);
        H.expectExcludes(s.household, 'Invented hydro', 'the matched bill payment is not also spending');
        H.expectMatch(s.household, /Household Budget TotalActual \/ Planned \$83\.50/, 'household actual is 40 + 25.50 + 18 = 83.50');
      });
    },
  },
  {
    id: '7.2', basis: 'blueprint', name: 'a pending row replaced by its posted successor counts once',
    async run(H) {
      const w = txWorld(H);
      w.transactions.push(
        H.lm({ id: 700, date: '2026-10-11', amount: 30, category: 'Groceries', payee: 'Invented bakery', pending: true }),
        H.lm({ id: 701, date: '2026-10-12', amount: 30, category: 'Groceries', payee: 'Invented bakery',
          raw: { pending_transaction_id: 700, plaid_metadata: { pending_transaction_id: 'invented-plaid-700' } } }));
      w.transactions[1].plaid_metadata = { transaction_id: 'invented-plaid-700' };
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expect(H.occurrences(s.household, 'Invented bakery') === 1, `bakery listed once (got ${H.occurrences(s.household, 'Invented bakery')})`);
        H.expectMatch(H.category(s, 'Groceries'), /Spent \$30\.00/, 'groceries spent is 30, not 60');
      });
    },
  },
  {
    id: '7.3', basis: 'derived', name: 'transactions in a category are listed in date order',
    // Provider order is shuffled (Oct 13, Oct 9, Oct 11, Oct 10); the page
    // lists them in one consistent chronological direction.
    async run(H) {
      const w = txWorld(H);
      for (const [d, a, n] of [['2026-10-13', 5, 'D'], ['2026-10-09', 6, 'A'], ['2026-10-11', 7, 'C'], ['2026-10-10', 8, 'B']])
        w.transactions.push(H.lm({ date: d, amount: a, category: 'Groceries', payee: 'Invented grocer ' + n }));
      await H.withBudget(w, async p => {
        const { dates } = await detailDates(p, 'groceries');
        const days = dates.map(dayOf);
        H.expect(days.length >= 4, `four dated rows are listed (got ${days.length})`);
        const up = days.every((d, i) => !i || d >= days[i - 1]), down = days.every((d, i) => !i || d <= days[i - 1]);
        H.expect(up || down, `rows are in date order (got ${dates.join(', ')})`);
      });
    },
  },
  {
    id: '7.4', basis: 'spec', name: 'a note with "item: book" plus other lines shows only "book", on its own row',
    async run(H) {
      const w = txWorld(H);
      w.transactions.push(
        H.lm({ date: '2026-10-10', amount: 40, category: 'Groceries', payee: 'Invented grocer A', notes: 'item: book\ninvented other line' }),
        H.lm({ date: '2026-10-11', amount: 12, category: 'Groceries', payee: 'Invented grocer B' }));
      await H.withBudget(w, async p => {
        const { text } = await detailDates(p, 'groceries');
        H.expectMatch(text, /\bbook\b/, 'the item line is displayed');
        H.expectExcludes(text, 'invented other line', 'the other note lines stay private');
        const a = text.indexOf('Invented grocer A'), b = text.indexOf('Invented grocer B'), n = text.search(/\bbook\b/);
        H.expect(n > a && (b < a || n < b), 'the note sits under its own transaction');
      });
    },
  },
  {
    id: '7.5', basis: 'spec', name: 'an unmarked private note is never displayed',
    async run(H) {
      const w = txWorld(H);
      w.transactions.push(H.lm({ date: '2026-10-10', amount: 40, category: 'Groceries', payee: 'Invented grocer A', notes: 'invented private memo' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        const { text } = await detailDates(p, 'groceries');
        H.expectIncludes(text, 'Invented grocer A', 'positive control: the noted transaction is listed');
        H.expectExcludes(s.all + text, 'invented private memo', 'unmarked notes stay private');
      });
    },
  },
  {
    id: '7.6', basis: 'audit', name: 'a dropped household row makes dependent totals Unknown, never precise (C1)',
    // A Groceries row arrives with an unreadable amount. Groceries spent and
    // remaining, and the Household total, must be Unknown; the other
    // independently known category (Eating out 25.50 of 100) stays visible.
    async run(H) {
      const w = txWorld(H);
      w.transactions.push(
        H.lm({ date: '2026-10-10', amount: 40, category: 'Groceries', payee: 'Invented grocer A' }),
        H.lm({ date: '2026-10-11', amount: 'unavailable', category: 'Groceries', payee: 'Invented grocer B' }),
        H.lm({ date: '2026-10-12', amount: 25.5, category: 'Restaurants', payee: 'Invented diner' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expect(H.category(s, 'Groceries'), 'positive control: the Groceries row is listed');
        H.expectNoMatch(H.category(s, 'Groceries'), /\$260\.00 left/, 'no precise remaining after a dropped row');
        H.expectMatch(H.category(s, 'Groceries'), /Unknown|Unavailable/, 'groceries is Unknown');
        H.expectMatch(H.category(s, 'Eating out'), /Spent \$25\.50/, 'independent known category stays visible');
      });
    },
  },
  {
    id: '7.7', basis: 'audit', name: 'a missing coverage stamp is not completeness (C2)',
    // Audit C2: with no transaction coverage stamp at all, an empty list must
    // read "Spending unavailable", never "$300.00 left / Spent $0.00".
    async run(H) {
      const w = txWorld(H);
      w.dataPatch = (data, packet) => { if (packet) delete packet.transactionCoverage; };
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expect(H.category(s, 'Groceries'), 'positive control: the Groceries row is listed');
        H.expectNoMatch(H.category(s, 'Groceries'), /\$300\.00 left/, 'absence of a stamp is not complete coverage');
      });
    },
  },
  {
    id: '7.8', basis: 'spec', name: 'a 10 refund on 40 of groceries nets to 30, never income or Other',
    async run(H) {
      const w = txWorld(H);
      w.transactions.push(
        H.lm({ date: '2026-10-10', amount: 40, category: 'Groceries', payee: 'Invented grocer A' }),
        H.lm({ date: '2026-10-12', amount: -10, category: 'Groceries', payee: 'Invented grocer A' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.category(s, 'Groceries'), /Spent \$30\.00/, 'groceries spent is 40 - 10');
        H.expectMatch(s.income, /^\W*Income/, 'positive control: the Income step is rendered');
        H.expectExcludes(s.income, 'Invented grocer A', 'a refund is not income');
        H.expectNoMatch(s.categories.join(' | '), /Other spending/, 'a refund is not Other');
      });
    },
  },
  {
    id: '7.9', basis: 'blueprint', name: 'a split parent is not counted alongside its children',
    async run(H) {
      const w = txWorld(H);
      w.transactions.push(
        H.lm({ id: 801, date: '2026-10-10', amount: 50, category: 'Groceries', payee: 'Invented market', raw: { has_children: true } }),
        H.lm({ id: 802, date: '2026-10-10', amount: 30, category: 'Groceries', payee: 'Invented market', raw: { parent_id: 801 } }),
        H.lm({ id: 803, date: '2026-10-10', amount: 20, category: 'Restaurants', payee: 'Invented market', raw: { parent_id: 801 } }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.category(s, 'Groceries'), /Spent \$30\.00/, 'groceries holds the 30 child only');
        H.expectMatch(H.category(s, 'Eating out'), /Spent \$20\.00/, 'eating out holds the 20 child');
      });
    },
  },
  {
    id: '7.10', basis: 'spec', name: 'groceries 40, fuel 20 and eating out 10 land in their own buckets',
    async run(H) {
      const w = txWorld(H);
      w.budget.push({ id: 'fuel', label: 'Fuel', class: 'essential', plannedPayday: 80, confidence: 'confirmed', from: ['Fuel'] });
      w.transactions.push(
        H.lm({ date: '2026-10-10', amount: 40, category: 'Groceries', payee: 'Invented grocer A' }),
        H.lm({ date: '2026-10-10', amount: 20, category: 'Fuel', payee: 'Invented fuel stop' }),
        H.lm({ date: '2026-10-10', amount: 10, category: 'Restaurants', payee: 'Invented diner' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.category(s, 'Groceries'), /Spent \$40\.00/, 'groceries 40');
        H.expectMatch(H.category(s, 'Fuel'), /Spent \$20\.00/, 'fuel 20');
        H.expectMatch(H.category(s, 'Eating out'), /Spent \$10\.00/, 'eating out 10');
        H.expectNoMatch(s.categories.join(' | '), /Other spending/, 'nothing left over for Other');
      });
    },
  },
];

module.exports = { check: 7, title: 'Transactions appear once, sorted, item-only notes', scenarios };
