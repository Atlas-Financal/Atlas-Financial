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

const { runSavedTrustBrowserProof } = require('../browser-savings-saved-trust');

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
  {
    id: '2.12', basis: 'audit', name: 'a dated Savings balance plus a later linked Savings purchase counts the purchase once',
    // Savings audit (lead dispatch): Savings reports 1,000 dated Oct 10. A
    // linked 500 trip purchase posts from Savings on Oct 12, so 500 is left.
    // Trip U = 600 - 500 = 100 -> A = 100; gift A = min(600, 500 - 100) = 400;
    // gift gap 600 - 400 = 200. Saved + Paid = 100 + 400 + 500 = 1,000.
    // The reported 1,000 stays visible as dated evidence.
    async run(H) {
      const w = savingsWorld(H);
      w.accounts.find(a => a.id === 'savings').balanceDate = '2026-10-10';
      w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20', effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 500, category: 'Trip', account: 'savings', payee: 'Invented airline' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectIncludes(s.savings, 'Reported combined savings: $1,000.00', 'the dated report stays visible');
        H.expectFigure(H.goal(s, 'Invented trip'), 'Paid', '$500.00', 'positive control: the purchase is the trip paid amount');
        H.expectMatch(H.goal(s, 'Invented trip'), /\$100\.00\s*Saved/, 'trip share is its remaining 100');
        H.expectMatch(H.goal(s, 'Invented gift'), /\$400\.00\s*Saved/, 'gift gets only the 400 still in Savings');
        H.expectFigure(H.goal(s, 'Invented gift'), 'Still to fund', '$200.00', 'gift gap is 200, not 0');
      });
    },
  },
  {
    id: '2.13', basis: 'audit', name: 'a card item charge paid from Savings after the balance date counts the payment once',
    // Card variant of 2.12: the 500 trip charge is on a card (Oct 11) and a
    // Savings->card payment of 500 posts Oct 12, after Savings reported 1,000
    // dated Oct 10. Same figures: trip 100 saved, gift 400 saved, gap 200.
    async run(H) {
      const w = savingsWorld(H);
      w.accounts.find(a => a.id === 'savings').balanceDate = '2026-10-10';
      w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20', effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
      w.accounts.push({ id: 'travelvisa', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: 0 });
      w.debts = [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false, balance: 0,
        pending: 0, rate: 0, limit: 2000, statementCloseDay: 17 }];
      w.planPatch = plan => { plan.cardPurchaseCoverage = { rule: 'aggregate-per-card-per-pay-period',
        opening: { asOf: '2026-10-09', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } }; };
      w.transactions.push(
        H.lm({ date: '2026-10-11', amount: 500, category: 'Trip', account: 'travelvisa', providerAccountId: 9004, payee: 'Invented airline' }),
        H.lm({ date: '2026-10-12', amount: 500, account: 'savings', payee: 'Invented card payment', category: 'Transfer',
          raw: { category_name: 'Credit Card Payment' } }),
        H.lm({ date: '2026-10-12', amount: -500, account: 'travelvisa', providerAccountId: 9004, payee: 'PAYMENT - THANK YOU',
          raw: { category_name: 'Credit Card Payment' } }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectFigure(H.goal(s, 'Invented trip'), 'Paid', '$500.00', 'positive control: the card charge is the trip paid amount');
        H.expectMatch(H.goal(s, 'Invented trip'), /\$100\.00\s*Saved/, 'trip share is its remaining 100');
        H.expectMatch(H.goal(s, 'Invented gift'), /\$400\.00\s*Saved/, 'gift gets only the 400 still in Savings');
        H.expectFigure(H.goal(s, 'Invented gift'), 'Still to fund', '$200.00', 'gift gap is 200, not 0');
      });
    },
  },
  {
    id: '2.14', basis: 'audit', name: 'a linked card refund paid net from Savings preserves every goal allocation (D2)',
    // #962 D2: 150 bought from Savings + 80 on the card - 20 refunded =
    // Trip Paid 210, Needed/Saved 390. The observed 790 pool then backs
    // Camp 300 and Christmas 100, leaving Christmas 400 still to fund.
    // Savings pays the net card 60, so Household is 400 + kiosk 18 = 418
    // and surplus is 1,400 - 418 = 982; no card charge is deducted again.
    // First prove the audit's no-refund control: pool 770, card payment 80,
    // Trip Paid 230 and Needed/Saved 370, with the same later shares/982.
    async run(H) {
      for (const e of [
        { refund: false, pool: 770, payment: 80, paid: '$230.00', need: '$370.00' },
        { refund: true, pool: 790, payment: 60, paid: '$210.00', need: '$390.00' },
      ]) {
        const w = savingsWorld(H, e.pool);
        w.commitments = [
          { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true },
          { id: 'camp', label: 'Invented camp', date: '2026-12-01', amount: 300, confidence: 'confirmed', sinkingFund: true },
          { id: 'christmas', label: 'Invented Christmas', date: '2026-12-20', amount: 500, confidence: 'confirmed', sinkingFund: true },
          { id: 'fees', label: 'Invented team fees', date: '2026-11-01', amount: 200, confidence: 'confirmed', sinkingFund: true, settledOn: '2026-10-12' },
        ];
        w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20',
          effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
        w.accounts.push({ id: 'travelvisa', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: 0 });
        w.debts = [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false, balance: 0,
          pending: 0, rate: 0, limit: 2000, statementCloseDay: 17 }];
        w.planPatch = plan => { plan.cardPurchaseCoverage = { rule: 'aggregate-per-card-per-pay-period',
          opening: { asOf: '2026-10-09', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } }; };
        w.transactions.push(
          H.lm({ date: '2026-10-10', amount: 150, category: 'Trip', account: 'savings', payee: 'Invented airline' }),
          H.lm({ date: '2026-10-11', amount: 80, category: 'Trip', account: 'travelvisa', providerAccountId: 9004, payee: 'Invented airline' }),
          H.lm({ date: '2026-10-13', amount: e.payment, account: 'savings', payee: 'Invented card payment', category: 'Transfer',
            raw: { category_name: 'Credit Card Payment' } }),
          H.lm({ date: '2026-10-13', amount: -e.payment, account: 'travelvisa', providerAccountId: 9004, payee: 'PAYMENT - THANK YOU',
            raw: { category_name: 'Credit Card Payment' } }),
          H.lm({ date: '2026-10-13', amount: 18, category: 'Uncategorised', payee: 'Invented kiosk' }));
        if (e.refund) w.transactions.push(H.lm({ date: '2026-10-12', amount: -20, category: 'Trip',
          account: 'travelvisa', providerAccountId: 9004, payee: 'Invented airline' }));
        await H.withBudget(H.productionOpening(w), async (p, packets, built) => {
          const result = built[0], opening = result.data.plan.opening;
          H.expect(!result.error && result.packet && result.data.liveOverlay.applied,
            `D2 live observation succeeds: ${result.error ? result.error.message : 'missing live packet'}`);
          H.expect(opening.asOf === '2026-10-14' && opening.priorAsOf === '2026-10-09',
            'D2 live-plan advances the canonical payday opening');
          const s = await H.snap(p), trip = H.goal(s, 'Invented trip');
          H.expectIncludes(s.savings, `Reported combined savings: ${H.money(e.pool)}`, 'D2 observed pool is rendered');
          H.expectFigure(trip, 'Paid', e.paid, 'D2 trip Paid nets the linked purchases and refund once');
          H.expectMatch(trip, new RegExp(H.esc(e.need) + '\\s*Needed'), 'D2 trip remaining need');
          const saved = (trip.match(/(\$[\d,]+\.\d\d|Unknown|Unavailable)\s*Saved/) || [])[1];
          H.expect(saved === e.need, `D2 trip Saved shows "${saved || 'nothing'}", expected "${e.need}" after Savings pays the net card balance`);
          H.expectMatch(H.goal(s, 'Invented camp'), /\$300\.00\s*Saved/, 'D2 Camp keeps its 300 backing');
          H.expectMatch(H.goal(s, 'Invented Christmas'), /\$100\.00\s*Saved/, 'D2 Christmas keeps its 100 backing');
          H.expectFigure(H.goal(s, 'Invented Christmas'), 'Still to fund', '$400.00', 'D2 Christmas gap is 500 - 100');
          const fees = H.goal(s, 'Invented team fees');
          H.expectMatch(fees, /\$200\.00\s*Planned/, 'D2 owner-paid fees retain the planned cost, not a fabricated payment');
          H.expectFigure(fees, 'Still to fund', '$0.00', 'D2 owner-paid fees need no further funding');
          H.expectMatch(fees, /\$0\.00\s*Saved/, 'D2 owner-paid fees remain known, with zero backing');
          const balance = (await p.rows('[data-operating-question="07"]')).join(' ');
          H.expectMatch(balance, /Balance After Deductions[^$]*\$982\.00/,
            `D2 Savings-funded card spending is not deducted again (got ${balance})`);
        });
      }
    },
  },
  {
    id: '2.15', basis: 'audit', name: 'Saved trust follows estimated needs on the real Budget page and every member/funding consumer',
    // Saved is hand-derived: 600/400, or grouped 550/450. Only the tag
    // changes when an earlier need is estimated. All-confirmed controls
    // keep calculated on goals, grouped members, inventory and funding.
    // Unmarked: a failure is a real hosted acceptance-gate failure.
    async run(H) {
      await runSavedTrustBrowserProof(H);
    },
  },
  {
    id: '2.16', basis: 'derived', name: 'clean goal row: name, bar and saved against needed; the wording opens on tap',
    // Owner direction 2026-11-09 (BACKLOG "Clean main view; explanations on
    // tap"). Figures are the hand ledger of 2.1 / 2.2: trip 600 of 600, gift
    // 400 of 600 with an estimated 200 gap. The visible row carries no Paid,
    // Still to fund or estimate sentence; the tap-to-explain window carries
    // them with the estimate mark and its word. An estimated figure keeps
    // its ≈ on the row, and an unavailable Saved stays visibly unavailable.
    async run(H) {
      const faceRows = p => p.page.evaluate(() => [...document.querySelectorAll('.blend-goal-legend > li')].map(li => {
        const button = li.querySelector('button.blend-goal-row');
        return { text: li.innerText.replace(/\s+/g, ' ').trim(), spoken: button ? button.getAttribute('aria-label') : null,
          bar: !!li.querySelector('.blend-g-bar'),
          // Saved / Needed are screen-reader words, not visible ones.
          wordsHidden: [...li.querySelectorAll('.blend-goal-word')].every(word => word.getBoundingClientRect().width <= 1) };
      }));
      const rowFor = (rows, label) => rows.find(row => row.text.startsWith(label)) || { text: '', spoken: null, bar: false, wordsHidden: false };
      await H.withBudget(savingsWorld(H), async p => {
        const gift = rowFor(await faceRows(p), 'Invented gift');
        H.expect(gift.text === 'Invented gift Saved $400.00 / Needed $600.00', `the row is the name and saved against needed only (got "${gift.text}")`);
        H.expect(gift.bar && gift.wordsHidden, 'the row keeps its bar and prints only the two amounts');
        H.expectNoMatch(gift.text, /Still to fund|Estimate:|planning gap|Paid|this period/, 'no explainer wording on the main view');
        H.expect(gift.spoken === 'Invented gift. Saved calculated $400.00. Needed calculated $600.00', `each figure keeps its trust word for screen readers (got "${gift.spoken}")`);
        H.expect(await p.page.evaluate(() => [...document.querySelectorAll('[data-budget-goal-open]')].every(source => source.tabIndex === -1
          && source.closest('ul')?.getAttribute('aria-hidden') === 'true')), 'the clipped source rows are out of the tab order and the accessibility tree');
        // Keyboard only: Enter opens the window, focus moves in, Escape
        // closes it and returns focus to the row.
        const row = p.page.locator('button.blend-goal-row').filter({ hasText: 'Invented gift' });
        await row.focus();
        await p.page.keyboard.press('Enter');
        const explain = p.page.locator('dialog[data-blend-explain][open]');
        await explain.waitFor({ timeout: 5000 });
        H.expect(await p.page.evaluate(() => !!document.activeElement?.closest('dialog[data-blend-explain]')), 'keyboard focus moves into the window');
        const explained = (await explain.innerText()).replace(/\s+/g, ' ').trim();
        H.expectIncludes(explained, 'Invented gift', 'the window is titled with the goal');
        H.expectIncludes(explained, 'Saved calculated $400.00', 'Saved is in the window with its trust word');
        H.expectIncludes(explained, 'Needed calculated $600.00', 'Needed is in the window with its trust word');
        H.expectIncludes(explained, 'Still to fund ≈ estimated $200.00', 'the gap keeps its estimate mark and word in the window');
        H.expectIncludes(explained, 'Estimate: Needed minus Saved. It is a planning gap, not an unpaid balance.', 'the estimate sentence is in the window');
        // Owner live walk (#821 6785886971 item 1): this period's top-up has
        // its own label, so it never runs on after another figure and is
        // never read as an unavailable Saved.
        H.expectMatch(explained, /Top-up this period (Unavailable|calculated \$[\d,]+\.\d\d|≈ estimated \$[\d,]+\.\d\d)/, 'the this-period top-up is a labelled fact');
        H.expectNoMatch(explained, /(Unavailable|Unknown|\$[\d,]+\.\d\d) this period/, 'no "<figure> this period" run-on wording');
        await p.page.keyboard.press('Escape');
        await p.page.waitForFunction(() => !document.querySelector('dialog[data-blend-explain]')?.open, null, { timeout: 5000 });
        H.expect(await row.evaluate(node => node === document.activeElement), 'Escape closes the window and returns focus to the row');
        // The window hands over to the existing evidence sheet, and focus
        // comes back to the visible row when that sheet closes.
        await row.click();
        await explain.waitFor({ timeout: 5000 });
        await explain.locator('[data-blend-explain-evidence]').click();
        await p.page.waitForFunction(() => document.querySelector('[data-budget-detail-sheet]')?.open
          && !document.querySelector('dialog[data-blend-explain]')?.open, null, { timeout: 5000 });
        await p.page.keyboard.press('Escape');
        await p.page.waitForFunction(() => !document.querySelector('[data-budget-detail-sheet]')?.open
          && document.activeElement?.matches('button.blend-goal-row'), null, { timeout: 5000 });
        H.expect(await row.evaluate(node => node === document.activeElement), 'closing the evidence sheet returns focus to the visible row');
        H.expect(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
      });
      // An estimated need marks its own figure and the Saved that follows it.
      const estimated = savingsWorld(H);
      estimated.commitments[0].confidence = 'estimated';
      await H.withBudget(estimated, async p => {
        const trip = rowFor(await faceRows(p), 'Invented trip');
        H.expect(trip.text === 'Invented trip Saved ≈ $600.00 / Needed ≈ $600.00', `an estimate keeps its ≈ on the row (got "${trip.text}")`);
        H.expectIncludes(trip.spoken || '', 'Needed ≈ estimated $600.00', 'the estimate is announced as estimated');
      });
      // A missing Savings balance stays visibly unavailable; never $0.00.
      const missing = savingsWorld(H);
      missing.accounts.find(a => a.id === 'savings').unobserved = true;
      missing.planPatch = plan => { delete plan.savingsPoolObservation; };
      await H.withBudget(missing, async p => {
        const trip = rowFor(await faceRows(p), 'Invented trip');
        H.expectMatch(trip.text, /^Invented trip (Unavailable|Unknown)( \/ Needed \$600\.00)?$/, 'a missing Saved prints its unavailable word');
        H.expectNoMatch(trip.text, /\$0\.00/, 'missing is never shown as zero');
      });
    },
  },
];

module.exports = { check: 2, title: 'One savings pool reconciles', scenarios };
