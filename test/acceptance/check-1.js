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
    fixedBy: 'A6 #726',
    // Today the surplus is Unknown but the bill itself is not listed.
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
];

module.exports = { check: 1, title: 'Future periods reconcile', scenarios };
