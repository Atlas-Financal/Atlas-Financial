'use strict';
// Check 1 — Future periods reconcile.
// Spec: #787 6593395684 (check 1 and the trust rule: missing is never zero),
// audit C3 and C7 (#787 6621636966 findings 3 and 7). Invented numbers only;
// expectations hand-derived from the invented schedule, never from Atlas.
//
// 1.1-1.4 are the adopted spec scenarios (#787 6622324225, check 1), moved
// onto this invented calendar. 1.5-1.8 are derived from the check and the
// trust rule; 1.9-1.10 are audit repros.
//
// Invented schedule (as-of Wed Oct 14, 2026; biweekly payday Fridays):
//   payroll 1,400 every period; Household plan 300 + 100 = 400 per period;
//   hydro 90 on the 12th; internet 60 on the 28th.
//   Oct 23 - Nov 5: bills 60 (Oct 28)   Nov 6 - Nov 19: bills 90 (Nov 12)
//   Nov 20 - Dec 3: bills 60 (Nov 28)

function futureWorld(H, asOf) {
  const w = H.baseWorld(asOf);
  w.bills = [
    { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' },
    { id: 'net', label: 'Invented internet', amount: 60, frequency: 'monthly', day: 28, confidence: 'confirmed', payee: 'Invented net co' },
  ];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ date: '2026-10-12', amount: 90, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro' })];
  return w;
}
const planned = (sec) => (String(sec).match(/of planned\s*(\$[\d,]+\.\d\d|Unknown)/) || [])[1] || '';
// Trailing figure after "of planned $X": the amount that section carries
// into the period's chain (payday balance for Income, deduction otherwise).
const carried = (sec) => (String(sec).match(/of planned\s*(?:\$[\d,]+\.\d\d|Unknown)\s*(\$[\d,]+\.\d\d|Unknown|Unavailable)/) || [])[1] || '';
const cents = m => Math.round(Number(String(m).replace(/[$,]/g, '')) * 100);

const EXPECT = [
  { range: /Oct 23/, bills: '$60.00' },
  { range: /Nov 6/, bills: '$90.00' },
  { range: /Nov 20/, bills: '$60.00' },
];

const scenarios = [
  // Spec calendar mapping: the spec's "Jan 1-14" is the Oct 23 - Nov 5 pay
  // period here and "Jan 15" is the next payday, Nov 6.
  {
    id: '1.1', basis: 'spec', name: 'income 2,000 - bills 500 - household 400 leaves a surplus of 1,100',
    async run(H) {
      const w = futureWorld(H);
      w.income[0].amount = 2000;
      w.bills = [{ id: 'levy', label: 'Invented levy', amount: 500, frequency: 'once', date: '2026-10-28', confidence: 'confirmed' }];
      w.transactions = w.transactions.filter(t => t.payee !== 'Invented hydro');
      await H.withBudget(w, async p => {
        await p.step(1);
        const s = await H.snap(p);
        H.expectMatch(s.range, /Oct 23/, 'viewing Oct 23 - Nov 5');
        H.expect(planned(H.section(s, 'Income')) === '$2,000.00', `income is 2,000 (got ${planned(H.section(s, 'Income'))})`);
        H.expect(planned(H.section(s, 'Bills')) === '$500.00', `bills are 500 (got ${planned(H.section(s, 'Bills'))})`);
        const bad = ((await p.rows('[data-operating-question="07"]')).join(' ').match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1];
        H.expect(bad === '$1,100.00', `surplus is 2,000 - 500 - 400 = 1,100 (got ${bad})`);
      });
    },
  },
  {
    id: '1.2', basis: 'spec', name: 'a 300 bonus on the next payday lands only in the later period',
    async run(H) {
      const w = futureWorld(H);
      w.income.push({ id: 'bonus', label: 'Invented bonus', frequency: 'once', date: '2026-11-06', amount: 300, confidence: 'confirmed' });
      await H.withBudget(w, async p => {
        await p.step(1);
        const a = await H.snap(p);
        await p.step(1);
        const b = await H.snap(p);
        H.expectMatch(a.range, /Oct 23/, 'first period');
        H.expectMatch(b.range, /Nov 6/, 'second period');
        H.expect(planned(H.section(a, 'Income')) === '$1,400.00', `Oct 23 period income stays 1,400 (got ${planned(H.section(a, 'Income'))})`);
        H.expect(planned(H.section(b, 'Income')) === '$1,700.00', `Nov 6 period income is 1,400 + 300 (got ${planned(H.section(b, 'Income'))})`);
      });
    },
  },
  {
    id: '1.3', basis: 'spec', name: 'payrolls on Nov 5 and Nov 6 each land in their own period once',
    async run(H) {
      const w = futureWorld(H);
      // The biweekly 1,400 payroll stays (it defines the pay periods); the two
      // 1,000 payrolls are a second, invented employer on adjacent days.
      w.income.push(
        { id: 'pay-a', label: 'Invented pay A', frequency: 'once', date: '2026-11-05', amount: 1000, confidence: 'confirmed' },
        { id: 'pay-b', label: 'Invented pay B', frequency: 'once', date: '2026-11-06', amount: 1000, confidence: 'confirmed' });
      await H.withBudget(w, async p => {
        await p.step(1);
        const a = await H.snap(p);
        await p.step(1);
        const b = await H.snap(p);
        H.expect(planned(H.section(a, 'Income')) === '$2,400.00', `Oct 23 - Nov 5 is 1,400 + its own Nov 5 1,000 (got ${planned(H.section(a, 'Income'))})`);
        H.expect(planned(H.section(b, 'Income')) === '$2,400.00', `Nov 6 - Nov 19 is 1,400 + its own Nov 6 1,000 (got ${planned(H.section(b, 'Income'))})`);
      });
    },
  },
  {
    id: '1.4', basis: 'spec', name: 'a bill with an unknown amount makes the bill and the surplus Unknown',
    async run(H) {
      const w = futureWorld(H);
      w.bills.push({ id: 'repair', label: 'Invented repair', frequency: 'once', date: '2026-10-28', confidence: 'estimated' });
      await H.withBudget(w, async p => {
        await p.step(1);
        const s = await H.snap(p);
        H.expect(H.bill(s, 'Invented repair'), 'the bill is listed');
        H.expectMatch(H.bill(s, 'Invented repair'), /Unknown|Unavailable/, 'the bill amount says Unknown');
        const bad = (await p.rows('[data-operating-question="07"]')).join(' ');
        H.expectMatch(bad, /Balance After Deductions[^$]*?(Unknown|Unavailable)/, 'the dependent surplus says Unknown');
      });
    },
  },
  {
    id: '1.5', basis: 'derived', name: 'next three periods carry their own planned income, bills and household',
    async run(H) {
      await H.withBudget(futureWorld(H), async p => {
        for (const e of EXPECT) {
          await p.step(1);
          const s = await H.snap(p);
          H.expectMatch(s.range, e.range, 'stepped to the expected period');
          H.expect(planned(H.section(s, 'Income')) === '$1,400.00', `${s.range}: planned income is 1,400 (got ${planned(H.section(s, 'Income'))})`);
          H.expect(planned(H.section(s, 'Bills')) === e.bills, `${s.range}: planned bills are ${e.bills} (got ${planned(H.section(s, 'Bills'))})`);
          H.expect(planned(H.section(s, 'Household budget')) === '$400.00', `${s.range}: planned household is 400`);
        }
      });
    },
  },
  {
    id: '1.6', basis: 'derived', name: 'each future period adds up: payday balance - bills - household = balance after deductions',
    async run(H) {
      await H.withBudget(futureWorld(H), async p => {
        for (const e of EXPECT) {
          await p.step(1);
          const s = await H.snap(p);
          const pay = carried(H.section(s, 'Income')), bills = carried(H.section(s, 'Bills')), hh = carried(H.section(s, 'Household budget'));
          const bad = ((await p.rows('[data-operating-question="07"]')).join(' ').match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1] || '';
          H.expect(pay && bills && hh && bad, `${s.range}: every link of the chain is shown (${pay} / ${bills} / ${hh} / ${bad})`);
          H.expect(cents(pay) - cents(bills) - cents(hh) === cents(bad),
            `${s.range}: ${pay} - ${bills} - ${hh} must equal ${bad}`);
        }
      });
    },
  },
  {
    id: '1.7', basis: 'derived', name: 'future actuals are Unknown, never $0.00',
    async run(H) {
      await H.withBudget(futureWorld(H), async p => {
        await p.step(1);
        const s = await H.snap(p);
        for (const label of ['Income', 'Bills', 'Household budget'])
          H.expectMatch(H.section(s, label), new RegExp(label + '\\s*Unknown'), `${label} actual for a future period is Unknown`);
      });
    },
  },
  {
    id: '1.8', basis: 'derived', name: 'the same future period plans the same whether viewed before or on its payday',
    // Spans a pay period boundary: from Oct 22 the Oct 23 period is next;
    // from Oct 23 it is current. Planned income, bills and household agree.
    async run(H) {
      const before = futureWorld(H, '2026-10-22'), on = futureWorld(H, '2026-10-23');
      on.transactions.push(H.lm({ date: '2026-10-23', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }));
      let a, b;
      await H.withBudget(before, async p => { await p.step(1); a = await H.snap(p); });
      await H.withBudget(on, async p => { b = await H.snap(p); });
      H.expectMatch(a.range, /Oct 23/, 'viewed as next period');
      H.expectMatch(b.range, /Oct 23/, 'viewed as current period');
      for (const label of ['Income', 'Bills', 'Household budget'])
        H.expect(planned(H.section(a, label)) && planned(H.section(a, label)) === planned(H.section(b, label)),
          `${label}: planned ${planned(H.section(a, label))} before payday vs ${planned(H.section(b, label))} on payday`);
      H.expect(planned(H.section(b, 'Bills')) === '$60.00', 'the period holds the Oct 28 internet bill only');
    },
  },
  {
    id: '1.9', basis: 'audit', name: 'an unrelated receipt does not settle an expected one-off income (C3)',
    // Expected one-off rebate 200 on Oct 13 (other income), not yet seen by
    // the Oct 14 observation. An unrelated 50 gift arrived Oct 11. The rebate stays expected for 200; planned period
    // income is 1,400 + 200 = 1,600; the gift is never the rebate.
    async run(H) {
      const w = futureWorld(H);
      w.categories.push({ id: 111, name: 'Other income', is_income: true });
      w.income.push({ id: 'rebate', label: 'Invented rebate', frequency: 'once', date: '2026-10-13', amount: 200, incomeClass: 'other', confidence: 'confirmed' });
      w.transactions.push(H.lm({ date: '2026-10-11', amount: -50, category: 111, account: 'chequing-a', payee: 'Invented gift' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        const income = H.section(s, 'Income');
        H.expect(planned(income) === '$1,600.00', `planned income is 1,600 (got ${planned(income)})`);
        const rebate = (income.match(/Invented rebate[^$]*(\$[\d,]+\.\d\d)/) || [])[1];
        H.expect(rebate === '$200.00', `the rebate row still reads 200, not the unrelated 50 (got ${rebate})`);
        H.expectIncludes(income, 'Invented rebate', 'positive control: the rebate row is listed');
        H.expectNoMatch(income, /Invented rebate\s*Received/, 'the rebate is not received');
      });
    },
  },
  {
    id: '1.10', basis: 'audit', name: 'a shortened view counts only events inside it (C7)',
    // Engine-level: no Budget control reaches the cut view today, so this
    // runs the page's own Forecast in the page. As-of Oct 14, a 5-day view
    // ends Oct 18; the Oct 19 rebate and Oct 20 bill fall outside it, so the
    // view's totals are 0 income and 0 bills.
    async run(H) {
      const w = futureWorld(H);
      w.bills = []; // nothing due before or inside the view
      w.transactions = w.transactions.filter(t => t.payee !== 'Invented hydro');
      w.bills.push({ id: 'water', label: 'Invented water', amount: 200, frequency: 'once', date: '2026-10-20', confidence: 'confirmed' });
      w.income.push({ id: 'rebate', label: 'Invented rebate', frequency: 'once', date: '2026-10-19', amount: 300, incomeClass: 'other', confidence: 'confirmed' });
      await H.withBudget(w, async p => {
        const t = await p.page.evaluate(() => {
          const F = window.Forecast, d = window.__atlasAcceptanceData;
          return F && d ? F.simulate(d.plan, d.meta.asOf, { horizonDays: 28, viewDays: 5 }).totals : null;
        });
        H.expect(t, 'the page exposes its Forecast');
        H.expect(t.income === 0, `view income is 0 (got ${t.income})`);
        H.expect(t.bills === 0, `view bills are 0 (got ${t.bills})`);
      }, { exposeData: true });
    },
  },
  {
    id: '1.11', basis: 'audit', name: 'posted payday deposit is received: 1,400 of planned 2,400 (#962 D5)',
    // Oct 9 payroll is posted and identity-matched; partner pay is due Oct 15.
    // As-of Oct 14: received 1,400, planned 1,400 + 1,000 = 2,400.
    // These expectations do not come from Forecast or the receipt matcher.
    async run(H) {
      const w = H.baseWorld();
      w.income.push({ id: 'partner', label: 'Invented partner pay', frequency: 'monthly', day: 15,
        amount: 1000, confidence: 'confirmed' });
      w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll',
        account: 'chequing-a', payee: 'Invented employer' })];
      await H.withBudget(H.productionOpening(w), async (p, packets, built) => {
        const r = built[0];
        H.expect(!r.error && r.data.liveOverlay?.applied && packets[0],
          `D5 setup: production observation must apply (${r.error?.message || 'no live packet'})`);
        H.expect(r.data.plan.opening.asOf === '2026-10-14' && r.data.plan.opening.priorAsOf === '2026-10-09',
          'D5 setup: live-plan advances the canonical payday opening itself');
        H.expect(packets[0].representedActuals.some(a => a.id === 'payroll' && a.date === '2026-10-09'
          && a.actual === -1400 && a.postedOn === '2026-10-09'),
          'D5 setup: the posted 1,400 payroll is identity-matched before rendering');
        const s = await H.snap(p);
        H.expectMatch(s.range, /Oct 9/, 'D5 views the current pay period');
        H.expect(planned(s.income) === '$2,400.00', `D5 planned income is 2,400 (got ${planned(s.income)})`);
        H.expectFigure(s.income, 'Income', '$1,400.00', 'D5 posted payday deposit must count as received');
        H.expectNoMatch(s.income, /partial evidence|relied upon|Unknown/, 'D5 matched payday receipt is known');
      });
    },
  },
  {
    id: '1.12', basis: 'derived', name: 'a one-off bonus moves only its own period; the neighbours keep their figures (#823)',
    // Hand-worked on the invented schedule in the header (payroll 1,400,
    // household 400): balance after deductions = 1,400 - bills - 400.
    //   Oct 23 - Nov 5:  1,400 - 60 - 400 = 940   (unchanged)
    //   Nov 6 - Nov 19: (1,400 + 300) - 90 - 400 = 1,210   (bonus lands here)
    //   Nov 20 - Dec 3:  1,400 - 60 - 400 = 940   (unchanged)
    async run(H) {
      const w = futureWorld(H);
      w.income.push({ id: 'bonus', label: 'Invented bonus', frequency: 'once', date: '2026-11-06', amount: 300, confidence: 'confirmed' });
      const want = [
        { range: /Oct 23/, income: '$1,400.00', bills: '$60.00', bad: '$940.00' },
        { range: /Nov 6/, income: '$1,700.00', bills: '$90.00', bad: '$1,210.00' },
        { range: /Nov 20/, income: '$1,400.00', bills: '$60.00', bad: '$940.00' },
      ];
      await H.withBudget(w, async p => {
        for (const e of want) {
          await p.step(1);
          const s = await H.snap(p);
          H.expectMatch(s.range, e.range, `viewing ${e.range}`);
          H.expect(planned(H.section(s, 'Income')) === e.income, `${e.range} income is ${e.income} (got ${planned(H.section(s, 'Income'))})`);
          H.expect(planned(H.section(s, 'Bills')) === e.bills, `${e.range} bills are ${e.bills} (got ${planned(H.section(s, 'Bills'))})`);
          const bad = ((await p.rows('[data-operating-question="07"]')).join(' ').match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1];
          H.expect(bad === e.bad, `${e.range} balance after deductions is ${e.bad} (got ${bad})`);
        }
      });
    },
  },
  {
    id: '1.13', basis: 'derived', name: 'removing the one-off bonus restores every period exactly (#823)',
    // The same three periods with the bonus entry removed: the Nov 6 period
    // goes back to 1,400 income and 910 balance after deductions
    // (1,400 - 90 - 400); the neighbours are 940 as in 1.12.
    async run(H) {
      const w = futureWorld(H);
      // futureWorld carries no bonus entry: this is the world after removal.
      H.expect(!w.income.some(i => i.id === 'bonus'), 'setup: no bonus entry');
      const want = [
        { range: /Oct 23/, income: '$1,400.00', bad: '$940.00' },
        { range: /Nov 6/, income: '$1,400.00', bad: '$910.00' },
        { range: /Nov 20/, income: '$1,400.00', bad: '$940.00' },
      ];
      await H.withBudget(w, async p => {
        for (const e of want) {
          await p.step(1);
          const s = await H.snap(p);
          H.expectMatch(s.range, e.range, `viewing ${e.range}`);
          H.expect(planned(H.section(s, 'Income')) === e.income, `${e.range} income is ${e.income} (got ${planned(H.section(s, 'Income'))})`);
          const bad = ((await p.rows('[data-operating-question="07"]')).join(' ').match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1];
          H.expect(bad === e.bad, `${e.range} balance after deductions is ${e.bad} (got ${bad})`);
        }
      });
    },
  },
  {
    id: '1.14', basis: 'audit', name: 'the Household face figure is the greater-of-plan-or-spent term (660, not the 600 planned total) and carries no sub-label',
    // Owner walk (current period): the top card's Household figure read
    // 60 higher than the Household budget card's planned total. The face
    // prints Balance After Deductions' household term, the per-category
    // greater of plan or spent; the card prints the planned total. One
    // category 60 over plan makes them differ by 60, so the face must say
    // which figure it is.
    // Invented current period Oct 9 - Oct 22 (as-of Oct 14): groceries 300,
    // restaurants 100, Other spending target 200 (dated Sep 25, before this
    // period), and a fuel target of 60 that starts mid-period (Oct 12, no
    // earlier target), so fuel has no target this period. Groceries spent 360.
    //   planned total = 300 + 100 + 200 = 600 (fuel omitted)
    //   household term = max(300, 360) + max(100, 0) + max(200, 0) = 660
    async run(H) {
      const w = H.baseWorld('2026-10-14');
      w.budget.push(
        { id: 'fuel', label: 'Fuel', class: 'essential', plannedPayday: 60, confidence: 'confirmed', from: ['Fuel'], targetEffectiveFrom: '2026-10-12', targetHistory: [] },
        { id: 'other-spend', label: 'Other spend', class: 'discretionary', plannedMonthly: 0, plannedPayday: 200, targetEffectiveFrom: '2026-09-25', targetHistory: [], confidence: 'confirmed' });
      w.transactions.push(H.lm({ date: '2026-10-13', amount: 360, category: 'Groceries', payee: 'Invented grocer' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(s.range, /Oct 9/, 'viewing the current period Oct 9 - Oct 22');
        H.expect(!H.category(s, 'Fuel'), 'fuel has no target this period, so no fuel row');
        H.expectMatch(H.category(s, 'Other spending'), /of planned\s*\$200\b/, 'the Other spending target 200 is planned this period');
        const f = await p.page.evaluate(() => {
          const one = sel => (document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
          return {
            faceLabel: one('[data-operating-question="06"] .budget-step-value > [data-blend-term-label]'),
            faceFigure: one('[data-operating-question="06"] .budget-step-value > [data-blend-term]'),
            facePlanned: one('[data-operating-question="06"] [data-budget-ratio-plan]'),
            cardPlanned: one('[data-budget-browse="spending"] [data-budget-browse-hold] [data-budget-ratio-plan]'),
            badTerm: one('[data-bad-term="householdBudgetHold"] [data-bad-term-amount]'),
            badLabel: one('[data-bad-term="householdBudgetHold"] [data-bad-term-label]'),
          };
        });
        H.expect(f.facePlanned === '$600.00', `top card planned total is 600 (got ${f.facePlanned || 'nothing'})`);
        H.expect(f.cardPlanned === '$600', `Household budget card planned total is 600 (got ${f.cardPlanned || 'nothing'})`);
        H.expect(f.badTerm === '$660.00', `Balance After Deductions household term is 360 + 100 + 200 = 660 (got ${f.badTerm || 'nothing'})`);
        H.expectMatch(f.badLabel, /greater of plan or spent/i, 'the deduction term is labelled greater of plan or spent');
        H.expect(f.faceFigure === f.badTerm, `the face figure is that same term (face ${f.faceFigure || 'nothing'}, term ${f.badTerm})`);
        // One word, one meaning: a face figure that is not the planned total
        // never stands under a bare "Household budget" heading.
        // Display tidy-up (owner screenshots): the face no longer carries the
        // "Greater of plan or spent" sub-label; the figure, and the detail
        // label above, are unchanged.
        H.expect(f.faceLabel === '', `the face carries no sub-label under the Household figure (label "${f.faceLabel}")`);
      });
    },
  },
  {
    id: '1.15', basis: 'derived', name: 'control: every category within plan, steady targets; face, card and term all read the planned total',
    // Same invented targets with every target in force all period and
    // nothing over plan (groceries spent 50). planned total = 300 + 100 +
    // 200 = 600; household term = max(300, 50) + 100 + 200 = 600.
    async run(H) {
      const w = H.baseWorld('2026-10-14');
      w.budget.push({ id: 'other-spend', label: 'Other spend', class: 'discretionary', plannedMonthly: 0, plannedPayday: 200, targetEffectiveFrom: '2026-09-25', targetHistory: [], confidence: 'confirmed' });
      w.transactions.push(H.lm({ date: '2026-10-13', amount: 50, category: 'Groceries', payee: 'Invented grocer' }));
      await H.withBudget(w, async p => {
        const f = await p.page.evaluate(() => {
          const one = sel => (document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
          return {
            faceFigure: one('[data-operating-question="06"] .budget-step-value > [data-blend-term]'),
            facePlanned: one('[data-operating-question="06"] [data-budget-ratio-plan]'),
            cardPlanned: one('[data-budget-browse="spending"] [data-budget-browse-hold] [data-budget-ratio-plan]'),
            badTerm: one('[data-bad-term="householdBudgetHold"] [data-bad-term-amount]'),
          };
        });
        H.expect(f.facePlanned === '$600.00', `top card planned total is 600 (got ${f.facePlanned || 'nothing'})`);
        H.expect(f.cardPlanned === '$600', `Household budget card planned total is 600 (got ${f.cardPlanned || 'nothing'})`);
        H.expect(f.badTerm === '$600.00', `household term is 600 (got ${f.badTerm || 'nothing'})`);
        H.expect(f.faceFigure === '$600.00', `face figure is 600 (got ${f.faceFigure || 'nothing'})`);
      });
    },
  },
  {
    id: '1.16', basis: 'audit', name: 'a completed period under plan labels its Household figure as spending observed, never greater of plan or spent',
    // Atlas review 6787038868: a completed period deducts observed spending
    // only, so a "greater of plan or spent" face label would misstate it.
    // Invented completed period Sep 25 - Oct 8: groceries 300, restaurants
    // 100, Other target 200 (dated Sep 25); groceries spent 80, nothing else.
    //   completed household term = observed spending = 80 (not max with 600)
    // The current period (Oct 9 - Oct 22, nothing spent) and the next one
    // (Oct 23 - Nov 5) hold the plan: 300 + 100 + 200 = 600.
    async run(H) {
      const w = H.baseWorld('2026-10-14');
      w.budget.push({ id: 'other-spend', label: 'Other spend', class: 'discretionary', plannedMonthly: 0, plannedPayday: 200, targetEffectiveFrom: '2026-09-25', targetHistory: [], confidence: 'confirmed' });
      w.transactions.push(H.lm({ date: '2026-09-28', amount: 80, category: 'Groceries', payee: 'Invented grocer' }));
      const read = p => p.page.evaluate(() => {
        const one = sel => (document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
        return {
          face: one('[data-operating-question="06"] .budget-step-value > [data-blend-term]'),
          label: one('[data-operating-question="06"] .budget-step-value > [data-blend-term-label]'),
          term: one('[data-bad-term="householdBudgetHold"] [data-bad-term-amount]'),
          termLabel: one('[data-bad-term="householdBudgetHold"] [data-bad-term-label]'),
        };
      });
      await H.withBudget(w, async p => {
        const want = [
          { step: 0, range: /Oct 9/, amount: '$600.00', words: /^$/ },
          { step: -1, range: /Sep 25/, amount: '$80.00', words: /^Spending observed$/ },
          { step: 2, range: /Oct 23/, amount: '$600.00', words: /^$/ },
        ];
        for (const e of want) {
          if (e.step) await p.step(e.step);
          H.expectMatch(await p.range(), e.range, `viewing ${e.range}`);
          const f = await read(p);
          H.expect(f.term === e.amount, `${e.range} household term is ${e.amount} (got ${f.term || 'nothing'})`);
          H.expect(f.face === f.term, `${e.range} face figure is that term (face ${f.face || 'nothing'})`);
          H.expectMatch(f.label, e.words, `${e.range} face label (got "${f.label}")`);
          H.expect(f.termLabel.toLowerCase().includes(f.label.toLowerCase()), `${e.range} face label matches the term label "${f.termLabel}"`);
        }
      });
    },
  },
];

module.exports = { check: 1, title: 'Future periods reconcile', scenarios };
