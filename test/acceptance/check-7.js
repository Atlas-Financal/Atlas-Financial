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
// H.lm resolves category names against the base catalog only; Health is added
// to the world's catalog (id 111), so its purchases carry that id explicitly.
const HEALTH = { category_id: 111 };
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
  {
    id: '7.11', basis: 'audit', name: 'an unplanned Insurance charge stays visible and is deducted once (D7)',
    // #962 D7: no planned bill matches this 85 debit. Insurance is a stock
    // bill-type category, not evidence of a planned bill. The 85 belongs
    // in Other; household hold = 300 + 100 + 85 = 485 and the remainder
    // is 1,400 - 0 - 485 = 915. Every expected amount is hand-derived.
    async run(H) {
      const w = txWorld(H);
      w.categories.push({ id: 111, name: 'Insurance' });
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 85, category: 111,
        account: 'chequing-b', payee: 'Invented insurer' }));
      await H.withBudget(H.productionOpening(w), async (p, packets, built) => {
        const { data, packet, error } = built[0];
        H.expect(!error, `D7: the live overlay must succeed (${error && error.message})`);
        H.expect(packet && data.liveOverlay.applied, 'D7: posted insurance evidence reaches the page');
        H.expect(packet.transactions.some(t => t.categoryLabel === 'Insurance' && t.amount === 85 && !t.pending),
          'D7: the observer preserves the posted Insurance debit of 85');
        H.expect(data.plan.opening.asOf === '2026-10-14' && data.plan.opening.priorAsOf === '2026-10-09',
          'D7: live-plan advances the production opening from payday');
        const s = await H.snap(p);
        H.expectIncludes(s.household, 'Household Budget Total', 'D7: the spending section is rendered');
        const remainder = ((await p.rows('[data-operating-question="07"]')).join(' ')
          .match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1];
        const listed = H.occurrences(s.household, 'Invented insurer');
        H.expect(listed === 1,
          `D7: unplanned Insurance debit 85 must be visible once (listed ${listed}; surplus ${remainder}, expected $915.00)`);
        H.expectFigure(H.category(s, 'Other spending'), 'Other spending', '$85.00', 'D7: the unassigned debit remains Other spending');
        H.expectMatch(s.household, /Household Budget TotalActual \/ Planned \$85\.00/, 'D7: actual spending includes 85 once');
        H.expect(remainder === '$915.00', `D7: 1,400 - 0 - 485 = 915, got ${remainder}`);
      });
    },
  },
  {
    id: '7.12', basis: 'audit', name: 'a debit in an income category is never counted as income (D6)',
    // #962 D6. A 50 debit out of chequing in the income category "Payroll"
    // is money leaving, not income received. Income stays the 1,400 salary,
    // the 50 sits in Other spending (needs a category), and the remainder is
    // 1,400 - 400 planned household - 50 = 950, never 1,050.
    async run(H) {
      const w = txWorld(H);
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 50, category: 'Payroll', account: 'chequing-a', payee: 'Invented clawback' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(s.income, /^\W*Income/, 'D6: positive control: the Income step is rendered');
        const payday = (s.income.match(/Payday balance\s*([−-]?\$[\d,]+\.\d\d)/) || [])[1];
        H.expect(payday === '$1,400.00', `D6: income stays 1,400 (got ${payday || 'nothing'})`);
        H.expectNoMatch(s.income, /Other income\s*\$50\.00/, 'D6: the debit is not other income');
        H.expectNoMatch(s.income, /Received\s*\$50\.00/, 'D6: the debit is not received income');
        H.expectMatch(H.category(s, 'Other spending'), /Other spending\$50\.00/, 'D6: the debit is Other spending of 50');
        const m = s.all.match(/Balance After Deductions\s*(?:0\s*)?([−-]?\$[\d,]+\.\d\d)/);
        const bad = m ? m[1].replace('−', '-') : '';
        H.expect(bad === '$950.00', `D6: 1,400 - 400 - 50 = 950 (got ${bad || 'nothing'})`);
      });
    },
  },
  {
    id: '7.13', basis: 'derived', name: 'two Amazon purchases each match their posted charge and are listed once (#744)',
    // Two pending Amazon card purchases (40 and 25) are each replaced by
    // their own posted charge, linked by the provider's pending/posted ids
    // (posted amounts equal the pending ones, a day later). Each purchase is
    // listed exactly once (two rows, no pending leftovers) and Household
    // actual is 40 + 25 = 65, never 130. Card purchases land in Other
    // spending with coverage unconfirmed, so Other holds the 65.
    async run(H) {
      const w = txWorld(H);
      w.accounts.push({ id: 'mbna', providerId: 9006, role: 'revolving-credit', collection: 'debts', label: 'Invented Amazon card', value: 0 });
      w.debts = [{ id: 'mbna', label: 'Invented Amazon card', structure: 'Revolving', secured: false, balance: 0,
        pending: 0, rate: 0, limit: 2000, statementCloseDay: 17 }];
      const card = { category: 'Gifts', account: 'mbna', providerAccountId: 9006, payee: 'Amazon.ca' };
      w.transactions.push(
        H.lm({ ...card, id: 910, date: '2026-10-10', amount: 40, pending: true, raw: { plaid_metadata: { transaction_id: 'invented-plaid-910' } } }),
        H.lm({ ...card, id: 911, date: '2026-10-11', amount: 25, pending: true, raw: { plaid_metadata: { transaction_id: 'invented-plaid-911' } } }),
        H.lm({ ...card, id: 912, date: '2026-10-11', amount: 40, raw: { pending_transaction_id: 910, plaid_metadata: { pending_transaction_id: 'invented-plaid-910' } } }),
        H.lm({ ...card, id: 913, date: '2026-10-12', amount: 25, raw: { pending_transaction_id: 911, plaid_metadata: { pending_transaction_id: 'invented-plaid-911' } } }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expect(H.occurrences(s.household, 'Amazon.ca') === 2, `7.13: two Amazon rows, listed once each (got ${H.occurrences(s.household, 'Amazon.ca')})`);
        H.expectExcludes(s.household, 'Pending', '7.13: no pending row is left beside its posted charge');
        H.expectMatch(H.category(s, 'Other spending'), /Other spending\$65\.00/, '7.13: Other spending holds 40 + 25 = 65, once');
        H.expectMatch(s.household, /Household budget\s*\$65\.00 \/ of planned/, '7.13: household actual is 65, not 130');
      });
    },
  },
  {
    id: '7.14', basis: 'audit', name: 'spend in a category whose target starts next period lands in Other, counted once (#888)',
    // Fuel's target takes effect Oct 23, the NEXT pay period, so Fuel has no
    // target in this one (Oct 9 - Oct 22). Owner (Dale, 2026-11-11): what
    // fits no budget category lands in Other spending and counts as spend. A
    // 45 fuel purchase on Oct 12 shows once in Other spending and is
    // deducted once: hold = 300 groceries + 100 eating out + 45 Other = 445,
    // remainder 1,400 - 445 = 955. On main the 45 appears nowhere and the
    // remainder is 1,000.
    async run(H) {
      const w = txWorld(H);
      w.budget.push({ id: 'fuel', label: 'Fuel', class: 'essential', plannedPayday: 80, targetEffectiveFrom: '2026-10-23', confidence: 'confirmed', from: ['Fuel'] });
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 45, category: 'Fuel', payee: 'Invented fuel stop' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.category(s, 'Other spending'), /Other spending\$45\.00/, '7.14: Other spending holds the 45');
        H.expect(H.category(s, 'Fuel') === '', '7.14: Fuel prints no row of its own this period');
        H.expect(H.occurrences(s.household, 'Invented fuel stop') === 1, `7.14: the purchase is listed once (got ${H.occurrences(s.household, 'Invented fuel stop')})`);
        H.expectMatch(s.household, /Household Budget TotalActual \/ Planned \$45\.00/, '7.14: household actual includes the 45');
        const m = s.all.match(/Balance After Deductions\s*(?:0\s*)?([−-]?\$[\d,]+\.\d\d)/);
        const got = m ? m[1].replace('−', '-') : '';
        H.expect(got === '$955.00', `7.14: 1,400 - 300 - 100 - 45 = 955 (got ${got || 'nothing'})`);
      });
    },
  },
  {
    id: '7.15', basis: 'audit', name: 'an untargeted category with a purchase and a refund nets once in Other (#888)',
    // Fuel has an explicit zero monthly target. Purchase 45 and a posted
    // refund of 15 in Fuel: the refund inherits the purchase's bucket, so
    // Other spending nets to 30 and the remainder is 1,400 - 400 - 30 = 970.
    async run(H) {
      const w = txWorld(H);
      w.budget.push({ id: 'fuel', label: 'Fuel', class: 'essential', plannedMonthly: 0, confidence: 'confirmed', from: ['Fuel'] });
      w.transactions.push(
        H.lm({ date: '2026-10-12', amount: 45, category: 'Fuel', payee: 'Invented fuel stop' }),
        H.lm({ date: '2026-10-13', amount: -15, category: 'Fuel', payee: 'Invented fuel stop' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.category(s, 'Other spending'), /Other spending\$30\.00/, '7.15: Other spending nets 45 - 15 = 30');
        const m = s.all.match(/Balance After Deductions\s*(?:0\s*)?([−-]?\$[\d,]+\.\d\d)/);
        const got = m ? m[1].replace('−', '-') : '';
        H.expect(got === '$970.00', `7.15: 1,400 - 300 - 100 - 30 = 970 (got ${got || 'nothing'})`);
      });
    },
  },
  {
    id: '7.16', basis: 'audit', name: 'two untargeted categories land in Other and are each counted once (#888)',
    // Fuel (target starts next period) 45 and Eating out (explicit zero
    // monthly target) 25: both land in Other spending, 45 + 25 = 70, each
    // purchase listed once. hold = 300 groceries + 70 = 370, remainder
    // 1,400 - 370 = 1,030.
    async run(H) {
      const w = txWorld(H);
      w.budget[1] = { id: 'restaurants', label: 'Restaurants', class: 'discretionary', plannedMonthly: 0, confidence: 'confirmed', from: ['Restaurants'] };
      w.budget.push({ id: 'fuel', label: 'Fuel', class: 'essential', plannedPayday: 80, targetEffectiveFrom: '2026-10-23', confidence: 'confirmed', from: ['Fuel'] });
      w.transactions.push(
        H.lm({ date: '2026-10-12', amount: 45, category: 'Fuel', payee: 'Invented fuel stop' }),
        H.lm({ date: '2026-10-13', amount: 25, category: 'Restaurants', payee: 'Invented diner' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.category(s, 'Other spending'), /Other spending\$70\.00/, '7.16: Other spending holds 45 + 25 = 70');
        H.expect(H.category(s, 'Fuel') === '' && H.category(s, 'Eating out') === '', '7.16: neither category prints a row');
        H.expect(H.occurrences(s.household, 'Invented fuel stop') === 1 && H.occurrences(s.household, 'Invented diner') === 1, '7.16: each purchase is listed once');
        H.expectMatch(s.household, /Household Budget TotalActual \/ Planned \$70\.00/, '7.16: household actual is 45 + 25 = 70');
        const m = s.all.match(/Balance After Deductions\s*(?:0\s*)?([−-]?\$[\d,]+\.\d\d)/);
        const got = m ? m[1].replace('−', '-') : '';
        H.expect(got === '$1,030.00', `7.16: 1,400 - 300 - 70 = 1,030 (got ${got || 'nothing'})`);
      });
    },
  },
  {
    id: '7.17', basis: 'audit', name: 'an untargeted category with no spend prints no row and moves nothing (#888)',
    // Fuel has an explicit zero monthly target and nothing was spent: no
    // Fuel row, remainder 1,400 - 300 - 100 = 1,000.
    async run(H) {
      const w = txWorld(H);
      w.budget.push({ id: 'fuel', label: 'Fuel', class: 'essential', plannedMonthly: 0, confidence: 'confirmed', from: ['Fuel'] });
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expect(H.category(s, 'Fuel') === '', '7.17: no Fuel row without spend');
        const m = s.all.match(/Balance After Deductions\s*(?:0\s*)?([−-]?\$[\d,]+\.\d\d)/);
        const got = m ? m[1].replace('−', '-') : '';
        H.expect(got === '$1,000.00', `7.17: 1,400 - 300 - 100 = 1,000 (got ${got || 'nothing'})`);
      });
    },
  },
  {
    id: '7.18', basis: 'audit', name: 'control: when every category has a target, spend and the remainder are unchanged (#888)',
    // Fuel carries a 80 target this period; the 45 purchase sits under it.
    // hold = 300 + 100 + max(80, 45) = 480, remainder 920. This is the world
    // the fix must leave byte-identical.
    async run(H) {
      const w = txWorld(H);
      w.budget.push({ id: 'fuel', label: 'Fuel', class: 'essential', plannedPayday: 80, confidence: 'confirmed', from: ['Fuel'] });
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 45, category: 'Fuel', payee: 'Invented fuel stop' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.category(s, 'Fuel'), /Spent \$45\.00/, '7.18: Fuel spent 45 of its 80');
        const m = s.all.match(/Balance After Deductions\s*(?:0\s*)?([−-]?\$[\d,]+\.\d\d)/);
        const got = m ? m[1].replace('−', '-') : '';
        H.expect(got === '$920.00', `7.18: 1,400 - 300 - 100 - 80 = 920 (got ${got || 'nothing'})`);
      });
    },
  },
  {
    id: '7.19', basis: 'audit', name: 'spend in a named non-calendar category lands in Other, counted once (#821)',
    // Owner (Dale, 2026-11-11): what fits no budget category lands in Other
    // and counts as spend. Health is a named category in the plan but has no
    // calendar Budget row. A 40 Health purchase on Oct 12 shows once in Other
    // spending: hold = 300 groceries + 100 eating out + 40 Other = 440,
    // remainder 1,400 - 440 = 960. On main the 40 appears nowhere and the
    // remainder is 1,000.
    async run(H) {
      const w = txWorld(H);
      w.categories.push({ id: 111, name: 'Health' });
      w.budget.push({ id: 'health', label: 'Health', class: 'essential', from: ['Health'] });
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 40, payee: 'Invented clinic', raw: HEALTH }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.category(s, 'Other spending'), /Other spending\$40\.00/, '7.19: Other spending holds the 40');
        H.expect(H.occurrences(s.household, 'Oct 12') === 1, `7.19: the purchase is listed once, on its date (got ${H.occurrences(s.household, 'Oct 12')})`);
        H.expectMatch(s.household, /Household Budget TotalActual \/ Planned \$40\.00/, '7.19: household actual includes the 40');
        const m = s.all.match(/Balance After Deductions\s*(?:0\s*)?([−-]?\$[\d,]+\.\d\d)/);
        const got = m ? m[1].replace('−', '-') : '';
        H.expect(got === '$960.00', `7.19: 1,400 - 300 - 100 - 40 = 960 (got ${got || 'nothing'})`);
      });
    },
  },
  {
    id: '7.20', basis: 'audit', name: 'a named non-calendar purchase and its refund net once in Other (#821)',
    // Health 40 purchase and a posted 10 refund in Health: Other nets to 30,
    // remainder 1,400 - 400 - 30 = 970.
    async run(H) {
      const w = txWorld(H);
      w.categories.push({ id: 111, name: 'Health' });
      w.budget.push({ id: 'health', label: 'Health', class: 'essential', from: ['Health'] });
      w.transactions.push(
        H.lm({ date: '2026-10-12', amount: 40, payee: 'Invented clinic', raw: HEALTH }),
        H.lm({ date: '2026-10-13', amount: -10, payee: 'Invented clinic', raw: HEALTH }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.category(s, 'Other spending'), /Other spending\$30\.00/, '7.20: Other spending nets 40 - 10 = 30');
        const m = s.all.match(/Balance After Deductions\s*(?:0\s*)?([−-]?\$[\d,]+\.\d\d)/);
        const got = m ? m[1].replace('−', '-') : '';
        H.expect(got === '$970.00', `7.20: 1,400 - 300 - 100 - 30 = 970 (got ${got || 'nothing'})`);
      });
    },
  },
  {
    id: '7.21', basis: 'audit', name: 'control: a category absent from the plan already lands in Other once, unchanged (#821)',
    // Gifts is a Lunch Money category the plan does not mention. A 25 Gifts
    // purchase is Other spending of 25, remainder 1,400 - 400 - 25 = 975.
    // This path is the same before and after the change.
    async run(H) {
      const w = txWorld(H);
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 25, category: 'Gifts', payee: 'Invented gift shop' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.category(s, 'Other spending'), /Other spending\$25\.00/, '7.21: Other spending holds the 25');
        H.expect(H.occurrences(s.household, 'Invented gift shop') === 1, '7.21: listed once');
        const m = s.all.match(/Balance After Deductions\s*(?:0\s*)?([−-]?\$[\d,]+\.\d\d)/);
        const got = m ? m[1].replace('−', '-') : '';
        H.expect(got === '$975.00', `7.21: 1,400 - 300 - 100 - 25 = 975 (got ${got || 'nothing'})`);
      });
    },
  },
];

module.exports = { check: 7, title: 'Transactions appear once, sorted, item-only notes', scenarios };
