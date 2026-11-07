'use strict';
// Check 3 — Trip spending belongs only to its trip.
// Spec: #787 6622324225 (check 3 scenarios), the adopted A4/A5 blueprint
// #787 6620986508 §3 edge cases, §5 traps. Owner rule R3: category spending
// counts against the item, whichever account paid; refunds net against it.
// Invented numbers only; expectations hand-derived from those rules.
//
// Item links use the A4a (#840) private account-map shape:
// { categoryId | tagId, goalRef, occurrenceDate, effectiveFrom, effectiveThrough }.

const TRIP_DATE = '2026-12-01';
function link(kind, id, goalId = 'trip', date = TRIP_DATE) {
  return { [kind === 'tag' ? 'tagId' : 'categoryId']: id, goalRef: { kind: 'commitment', id: goalId },
    occurrenceDate: date, effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' };
}

function tripWorld(H) {
  const w = H.baseWorld();
  w.commitments = [{ id: 'trip', label: 'Invented trip', date: TRIP_DATE, amount: 500, confidence: 'confirmed', sinkingFund: true }];
  w.savingsPool = {};
  w.tags = [{ id: 201, name: 'invented-trip-tag' }, { id: 202, name: 'invented-camp-tag' }];
  w.links = [link('category', 106)];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}

const scenarios = [
  {
    id: '3.1', basis: 'spec', name: 'prepaid 100 from chequing counts against the trip: Paid 100, need 400, Savings not withdrawn',
    async run(H) {
      const w = tripWorld(H);
      w.transactions.push(H.lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectFigure(H.goal(s, 'Invented trip'), 'Paid', '$100.00', 'trip Paid is 100');
        H.expectMatch(H.goal(s, 'Invented trip'), /\$400\.00/, 'remaining need is 400');
        H.expectIncludes(s.savings, 'Reported combined savings: $1,000.00', 'Savings cash is not fictitiously withdrawn');
      });
    },
  },
  {
    id: '3.2', basis: 'blueprint', name: 'the trip purchase is not also in Household or Other',
    async run(H) {
      const w = tripWorld(H);
      w.transactions.push(H.lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expect(H.goal(s, 'Invented trip'), 'positive control: the trip goal row is listed');
        H.expectIncludes(s.household, 'Household Budget Total', 'positive control: the household budget is rendered');
        H.expect(H.category(s, 'Groceries'), 'positive control: the category rows are listed');
        H.expectExcludes(s.household, 'Invented airline', 'trip purchase must not appear in the household budget');
        H.expectNoMatch(s.categories.join(' '), /Other spending/, 'no Other spending row for an item purchase');
      });
    },
  },
  {
    id: '3.3', basis: 'spec', name: 'refund of 30 nets against the trip: Paid 70, need and allocation adjust once',
    async run(H) {
      const w = tripWorld(H);
      w.transactions.push(H.lm({ date: '2026-10-10', amount: 100, category: 'Trip', payee: 'Invented airline' }),
        H.lm({ date: '2026-10-12', amount: -30, category: 'Trip', payee: 'Invented airline' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectFigure(H.goal(s, 'Invented trip'), 'Paid', '$70.00', 'net paid is 100 - 30');
        H.expectMatch(H.goal(s, 'Invented trip'), /\$430\.00\s*Saved/, 'allocation is the 430 remaining need, adjusted once');
        H.expectMatch(s.income, /^\W*Income/, 'positive control: the Income step is rendered');
        H.expectNoMatch(s.income, /Invented airline/, 'a refund is never income');
      });
    },
  },
  {
    id: '3.4', basis: 'blueprint', name: 'identified reversal of 100 returns the need to 500',
    async run(H) {
      const w = tripWorld(H);
      w.transactions.push(H.lm({ date: '2026-10-10', amount: 100, category: 'Trip', payee: 'Invented airline' }),
        H.lm({ date: '2026-10-11', amount: -100, category: 'Trip', payee: 'Invented airline' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectFigure(H.goal(s, 'Invented trip'), 'Paid', '$0.00', 'net paid is 0');
        H.expectMatch(H.goal(s, 'Invented trip'), /\$500\.00/, 'need is back to 500');
      });
    },
  },
  {
    id: '3.5', basis: 'blueprint', name: 'purchase made before the item period still counts (no creation cutoff)',
    // A Sep 5 purchase inside covered history with an explicit link: Paid 100.
    async run(H) {
      const w = tripWorld(H);
      w.transactions.push(H.lm({ date: '2026-09-05', amount: 100, category: 'Trip', payee: 'Invented early booking' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectFigure(H.goal(s, 'Invented trip'), 'Paid', '$100.00', 'pre-period purchase counts');
        H.expectMatch(H.goal(s, 'Invented trip'), /\$400\.00/, 'need is 400');
      });
    },
  },
  {
    id: '3.6', basis: 'blueprint', name: 'one category on two items: neither gets the 80, purchase stays visible once',
    // Category alone matches both items -> attribution Unknown.
    async run(H) {
      const w = tripWorld(H);
      w.commitments.push({ id: 'camp', label: 'Invented camp', date: TRIP_DATE, amount: 300, confidence: 'confirmed', sinkingFund: true });
      w.commitments[0].amount = 300;
      w.links = [link('category', 106, 'trip'), link('category', 106, 'camp')];
      w.transactions.push(H.lm({ date: '2026-10-11', amount: 80, category: 'Trip', payee: 'Invented outfitter' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.figure(H.goal(s, 'Invented trip'), 'Paid'), /Unknown|Unavailable/, 'trip attribution is Unknown');
        H.expectMatch(H.figure(H.goal(s, 'Invented camp'), 'Paid'), /Unknown|Unavailable/, 'camp attribution is Unknown');
        H.expect(H.occurrences(s.household + s.savings, 'Invented outfitter') <= 1, 'the purchase is listed at most once');
        H.expectIncludes(s.all, 'Invented outfitter', 'the purchase stays visible for review');
      });
    },
  },
  {
    id: '3.7', basis: 'blueprint', name: 'a unique item tag picks exactly one item for the 80',
    async run(H) {
      const w = tripWorld(H);
      w.commitments.push({ id: 'camp', label: 'Invented camp', date: TRIP_DATE, amount: 300, confidence: 'confirmed', sinkingFund: true });
      w.commitments[0].amount = 300;
      w.links = [link('category', 106, 'trip'), link('category', 106, 'camp'), link('tag', 202, 'camp')];
      w.transactions.push(H.lm({ date: '2026-10-11', amount: 80, category: 'Trip', tagIds: [202], payee: 'Invented outfitter' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectFigure(H.goal(s, 'Invented camp'), 'Paid', '$80.00', 'camp gets the 80');
        H.expect(H.goal(s, 'Invented trip'), 'positive control: the trip goal row is listed');
        H.expectFigure(H.goal(s, 'Invented trip'), 'Paid', '$80.00', 'trip does not', true);
      });
    },
  },
  {
    id: '3.8', basis: 'blueprint', name: 'category says A and tag says B: no allocation, no duplicate',
    async run(H) {
      const w = tripWorld(H);
      w.commitments.push({ id: 'camp', label: 'Invented camp', date: TRIP_DATE, amount: 300, confidence: 'confirmed', sinkingFund: true });
      w.links = [link('category', 106, 'trip'), link('tag', 202, 'camp')];
      w.transactions.push(H.lm({ date: '2026-10-11', amount: 60, category: 'Trip', tagIds: [202], payee: 'Invented outfitter' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.figure(H.goal(s, 'Invented trip'), 'Paid'), /Unknown|Unavailable/, 'trip attribution is Unknown');
        H.expectMatch(H.figure(H.goal(s, 'Invented camp'), 'Paid'), /Unknown|Unavailable/, 'camp attribution is Unknown');
        H.expect(H.occurrences(s.household + s.savings, 'Invented outfitter') <= 1, 'no duplicate Household and item total');
        H.expectIncludes(s.all, 'Invented outfitter', 'the purchase stays visible');
      });
    },
  },
  {
    id: '3.9', basis: 'blueprint', name: 'a purchase without a stable id earns no credit; the pool stays visible',
    // The observer refuses an id-less row. Dependent totals are Unknown; the
    // independently known pool (1,000 Savings) stays on the page.
    async run(H) {
      const w = tripWorld(H);
      w.transactions.push(H.lm({ date: '2026-10-11', amount: 40, category: 'Trip', payee: 'Invented anonymous', omitId: true }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.figure(H.goal(s, 'Invented trip'), 'Paid'), /Unknown|Unavailable/, 'no credit for an unidentified row');
        H.expectMatch(s.savings, /Invented pool: \$1,000\.00|combined savings: \$1,000\.00/, 'the independently known pool stays visible');
        H.expect(H.category(s, 'Groceries'), 'the Groceries row is listed');
        H.expectNoMatch(H.category(s, 'Groceries'), /\$300\.00 left/, 'dependent household totals are not precise');
      });
    },
  },
  {
    id: '3.10', basis: 'blueprint', name: 'the trip purchase from Savings does not reduce the pool twice',
    // Trap §5 "a balance debit plus an N debit": Savings is observed at 900
    // after a linked 100 Savings purchase. Trip need 400, backed 400 of 900.
    async run(H) {
      const w = tripWorld(H);
      w.accounts.find(a => a.id === 'savings').value = 900;
      w.transactions.push(H.lm({ date: '2026-10-11', amount: 100, category: 'Trip', account: 'savings', payee: 'Invented airline' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectIncludes(s.savings, 'Reported combined savings: $900.00', 'observed stock is the only debit');
        H.expectMatch(H.goal(s, 'Invented trip'), /\$400\.00\s*Saved/, 'trip backed for its remaining 400');
        H.expectFigure(H.goal(s, 'Invented trip'), 'Paid', '$100.00', 'paid 100');
      });
    },
  },
  {
    id: '3.11', basis: 'spec', name: 'a 60 purchase matching the trip by category and tag counts 60, never 120',
    async run(H) {
      const w = tripWorld(H);
      w.links = [link('category', 106), link('tag', 201)];
      w.transactions.push(H.lm({ date: '2026-10-11', amount: 60, category: 'Trip', tagIds: [201], payee: 'Invented ferry' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectFigure(H.goal(s, 'Invented trip'), 'Paid', '$60.00', 'counted once');
        H.expectNoMatch(s.all, /\$120\.00/, 'never doubled to 120');
      });
    },
  },
  {
    id: '3.12', basis: 'spec', name: 'a trip card charge paid from Savings leaves Balance After Deductions once',
    // #843 finding 11 (owner: Savings pays item card charges). The 100 trip
    // charge on the card is paid by a Savings→card payment. The pool is
    // observed at 900 (debited once). Bills never pays the charge, so Balance
    // After Deductions is income 1,400 - household hold 400 = 1,000, not 900.
    async run(H) {
      const w = tripWorld(H);
      w.accounts.find(a => a.id === 'savings').value = 900;
      w.accounts.push({ id: 'travelvisa', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: 0 });
      w.debts = [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false, balance: 0,
        pending: 0, rate: 0, limit: 2000, statementCloseDay: 17 }];
      w.planPatch = plan => { plan.cardPurchaseCoverage = { rule: 'aggregate-per-card-per-pay-period',
        opening: { asOf: '2026-10-09', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } }; };
      w.transactions.push(
        H.lm({ date: '2026-10-11', amount: 100, category: 'Trip', account: 'travelvisa', providerAccountId: 9004, payee: 'Invented airline' }),
        H.lm({ date: '2026-10-12', amount: 100, account: 'savings', payee: 'Invented card payment', category: 'Transfer',
          raw: { category_name: 'Credit Card Payment' } }),
        H.lm({ date: '2026-10-12', amount: -100, account: 'travelvisa', providerAccountId: 9004, payee: 'PAYMENT - THANK YOU',
          raw: { category_name: 'Credit Card Payment' } }));
      await H.withBudget(w, async (p, packets) => {
        const s = await H.snap(p);
        H.expectIncludes(s.savings, 'Reported combined savings: $900.00', 'the pool is debited once, by observation');
        H.expectFigure(H.goal(s, 'Invented trip'), 'Paid', '$100.00', 'the trip is paid 100');
        H.expectIncludes(s.all, 'Balance After Deductions', 'positive control: the remainder is rendered');
        H.expectMatch(s.all, /Balance After Deductions[^$]*\$1,000\.00/, 'Bills never pays the Savings-funded charge');
      });
    },
  },
];

module.exports = { check: 3, title: 'Trip spending belongs only to its trip', scenarios };
