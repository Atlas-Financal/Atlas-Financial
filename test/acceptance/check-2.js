'use strict';
// Check 2 — One savings pool reconciles.
// Spec: #787 6622324225 (check 2 scenarios), the adopted A4/A5 blueprint
// #787 6620986508 §2 (ledger) and §4 (A4b check-2 cases); C6 from the audit
// record #787 6621636966. Every amount is invented; the expected figures
// below are written by hand from those rules, never computed by Atlas code.
//
// Pool rule (R2, §2): one pool funds items in need-date order; the last item
// may be partly funded. Ai = min(Ui, max(F - earlier A, 0)).

function savingsWorld(H, savings = 1000) {
  const w = H.baseWorld();
  w.accounts.find(a => a.id === 'savings').value = savings;
  w.commitments = [
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true },
    { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: 600, confidence: 'confirmed', sinkingFund: true },
  ];
  w.savingsPool = {};
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}

const scenarios = [
  {
    id: '2.1', basis: 'spec', name: 'pool of 1,000 backs 600 then 400 in need-date order',
    // Given Savings 1,000 and two 600 needs (Nov 20, Dec 10).
    // Then Saved shows 600 for the trip and 400 for the gift.
    async run(H) {
      await H.withBudget(savingsWorld(H), async p => {
        const s = await H.snap(p);
        H.expectMatch(H.goal(s, 'Invented trip'), /\$600\.00\s*Saved/, 'first need is fully backed');
        H.expectMatch(H.goal(s, 'Invented gift'), /\$400\.00\s*Saved/, 'second need gets the remaining 400');
      });
    },
  },
  {
    id: '2.2', basis: 'spec', name: 'last item is partly funded: the later gap is 200',
    // Still to fund = max(U - A, 0): gift 600 - 400 = 200; trip 600 - 600 = 0.
    async run(H) {
      await H.withBudget(savingsWorld(H), async p => {
        const s = await H.snap(p);
        H.expectFigure(H.goal(s, 'Invented gift'), 'Still to fund', '$200.00', 'gift gap is 200');
        H.expectFigure(H.goal(s, 'Invented trip'), 'Still to fund', '$0.00', 'trip gap is 0');
      });
    },
  },
  {
    id: '2.3', basis: 'derived', name: 'the pool total shown equals the observed Savings balance',
    // B + deficit = E + sum(A) + unallocated: 1,000 = 600 + 400 + 0.
    async run(H) {
      await H.withBudget(savingsWorld(H), async p => {
        const s = await H.snap(p);
        H.expectIncludes(s.savings, 'Reported combined savings: $1,000.00', 'one pool, one observed balance');
      });
    },
  },
  {
    id: '2.4', basis: 'spec', name: 'verified zero Savings shows $0.00 saved, not Unknown',
    // Given an observed Savings balance of exactly 0: every share is 0 and
    // every still-to-fund equals its need (600, 600).
    async run(H) {
      await H.withBudget(savingsWorld(H, 0), async p => {
        const s = await H.snap(p);
        H.expectMatch(H.goal(s, 'Invented trip'), /\$0\.00\s*Saved/, 'verified zero is a real zero');
        H.expectFigure(H.goal(s, 'Invented trip'), 'Still to fund', '$600.00', 'whole trip need remains');
        H.expectFigure(H.goal(s, 'Invented gift'), 'Still to fund', '$600.00', 'whole gift need remains');
      });
    },
  },
  {
    id: '2.5', basis: 'spec', name: 'missing Savings balance is Unknown, never $0.00',
    // Given no dated Savings observation at all. Missing is never zero.
    async run(H) {
      const w = savingsWorld(H);
      w.accounts.find(a => a.id === 'savings').unobserved = true; // provider returns no Savings account
      w.planPatch = plan => { delete plan.savingsPoolObservation; };
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expect(H.goal(s, 'Invented trip'), 'positive control: the trip goal row is listed');
        H.expectNoMatch(H.goal(s, 'Invented trip'), /\$0\.00\s*Saved/, 'missing balance must not read as zero saved');
        H.expectFigure(H.goal(s, 'Invented trip'), 'Still to fund', '$600.00', 'missing balance must not produce a precise gap', true);
        H.expectMatch(H.goal(s, 'Invented trip'), /Unavailable|Unknown/, 'the dependent figure is Unknown');
      });
    },
  },
  {
    id: '2.6', basis: 'spec', name: 'item completed from Savings for 500: 500 is left in the pool',
    fixedBy: 'A4b + A5',
    // Given B = 1,000 and one planned 600 trip. When it is completed from
    // Savings for 500 (a linked 500 Savings debit, owner-confirmed on Oct 12),
    // Then Savings shows 500, the trip shows Paid 500 and needs nothing more.
    async run(H) {
      const w = savingsWorld(H);
      w.accounts.find(a => a.id === 'savings').value = 500;
      w.commitments = [{ ...w.commitments[0], settledOn: '2026-10-12' }];
      w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20', effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 500, category: 'Trip', account: 'savings', payee: 'Invented airline' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectIncludes(s.savings, 'Reported combined savings: $500.00', 'observed cash after the purchase');
        H.expectFigure(H.goal(s, 'Invented trip'), 'Paid', '$500.00', 'actual 500 is the paid amount');
        H.expect(H.goal(s, 'Invented trip'), 'positive control: the completed trip stays listed');
        H.expectFigure(H.goal(s, 'Invented trip'), 'Still to fund', '$100.00', 'no phantom 100 still to fund after completion', true);
      });
    },
  },
  {
    id: '2.7', basis: 'spec', name: 'item completed from Savings for 700: 300 is left in the pool',
    fixedBy: 'A4b + A5',
    // Same as 2.6 with a 700 actual: Savings 300, Paid 700, overspend 100 is
    // a disclosure, not another debit.
    async run(H) {
      const w = savingsWorld(H);
      w.accounts.find(a => a.id === 'savings').value = 300;
      w.commitments = [{ ...w.commitments[0], settledOn: '2026-10-12' }];
      w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20', effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 700, category: 'Trip', account: 'savings', payee: 'Invented airline' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectIncludes(s.savings, 'Reported combined savings: $300.00', 'observed cash after the purchase');
        H.expectFigure(H.goal(s, 'Invented trip'), 'Paid', '$700.00', 'actual 700 is the paid amount');
      });
    },
  },
  {
    id: '2.8', basis: 'blueprint', name: 'prepaid 100 from chequing: shares 400/600, later gap 100, Savings stays 1,000',
    fixedBy: 'A4b',
    // Blueprint §3 "Prepaid from chequing": pool 1,000, needs 500 then 700, a
    // linked 100 purchase from chequing. Trip need 400 -> A=400; gift A=600;
    // gift gap 100. Household excludes the 100.
    async run(H) {
      const w = savingsWorld(H);
      w.commitments[0].amount = 500;
      w.commitments[1].amount = 700; // blueprint inputs: needs 500 then 700
      w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20', effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
      w.transactions.push(H.lm({ date: '2026-10-11', amount: 100, category: 'Trip', account: 'chequing-b', payee: 'Invented airline' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectIncludes(s.savings, 'Reported combined savings: $1,000.00', 'Savings cash unchanged by a chequing purchase');
        H.expectMatch(H.goal(s, 'Invented trip'), /\$400\.00\s*Saved/, 'trip share is its remaining 400');
        H.expectMatch(H.goal(s, 'Invented gift'), /\$600\.00\s*Saved/, 'gift gets the freed 600');
        H.expectFigure(H.goal(s, 'Invented gift'), 'Still to fund', '$100.00', 'gift gap is 100');
        H.expectIncludes(s.household, 'Household Budget Total', 'positive control: the household budget is rendered');
        H.expectExcludes(s.household, 'Invented airline', 'Household/Other exclude the item purchase');
      });
    },
  },
  {
    id: '2.9', basis: 'audit', name: 'contribution lines are tagged from funding trust, never "confirmed" (C6)',
    fixedBy: 'C6 (A5; owner gate)',
    // Audit C6: payday funding trust is estimated; the cost itself is
    // confirmed. "Next scheduled contribution" and "Projected funded by" must
    // carry the funding trust (estimated), not the cost's confirmed tag.
    async run(H) {
      await H.withBudget(savingsWorld(H), async p => {
        const s = await H.snap(p);
        H.expectMatch(s.all, /Next scheduled contribution/, 'the contribution line is shown');
        H.expectNoMatch(s.all, /Next scheduled contribution[^.]{0,40}confirmed/, 'contribution is not tagged confirmed');
        H.expectMatch(s.all, /Projected funded by/, 'positive control: the funded-by line is shown');
        H.expectNoMatch(s.all, /Projected funded by[^.]{0,40}confirmed/, 'funded-by date is not tagged confirmed');
      });
    },
  },
  {
    id: '2.10', basis: 'derived', name: 'reload shows the same pool and shares (idempotent)',
    // Serving the same observation twice must not move any figure.
    async run(H) {
      const w = savingsWorld(H);
      await H.withBudget([w, w], async p => {
        const a = await H.snap(p);
        await p.reload();
        const b = await H.snap(p);
        H.expect(JSON.stringify(a.goals) === JSON.stringify(b.goals), 'goal rows changed across a reload');
        H.expectMatch(H.goal(b, 'Invented gift'), /\$400\.00\s*Saved/, 'shares unchanged after reload');
      });
    },
  },
  {
    id: '2.11', basis: 'spec', name: 'a failed refresh keeps the dated Savings evidence; unsupported backing is Unknown (G2)',
    fixedBy: 'G2 #725',
    // Given a good Oct 14 observation, When the next refresh fails, Then the
    // page still shows the dated evidence (1,000 as of 2026-10-14), and the
    // current backing it can no longer support is Unknown, not 600/400.
    async run(H) {
      const good = savingsWorld(H);
      const failed = savingsWorld(H);
      failed.planPatch = plan => { delete plan.savingsPoolObservation; };
      failed.failRefresh = true;
      await H.withBudget([good, failed], async p => {
        await p.reload();
        const s = await H.snap(p);
        H.expectMatch(s.savings, /\$1,000\.00[^|]{0,200}2026-10-14|2026-10-14[^|]{0,200}\$1,000\.00/, 'the dated evidence stays visible');
        H.expect(H.goal(s, 'Invented trip'), 'positive control: the trip goal row is listed');
        H.expectNoMatch(H.goal(s, 'Invented trip'), /\$600\.00\s*Saved/, 'unsupported current backing is not presented as known');
      });
    },
  },
];

module.exports = { check: 2, title: 'One savings pool reconciles', scenarios };
