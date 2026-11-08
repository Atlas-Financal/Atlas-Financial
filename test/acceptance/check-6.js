'use strict';
// Check 6 — Bills match dates, amounts and payment evidence.
// Spec: #787 6622324225 (check 6 scenarios) and the adopted bills/sorting blueprint
// #787 6595179923: integer cents, zero tolerance; amount alone never
// identifies a bill; explicit identity windows (#827: two days); genuine
// ambiguity stays "to confirm" with no nearest-match tie-break; each payment
// cent is consumed once. C5 from the audit record #787 6621646116.
// Invented numbers only; expectations hand-derived from those rules.
//
// 6.12-6.16 are the adopted spec scenarios on this calendar. 6.4 and 6.6
// follow the spec numbers too; the rest are derived from the blueprint.

function billsWorld(H) {
  const w = H.baseWorld();
  w.bills = [
    { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' },
    { id: 'net', label: 'Invented internet', amount: 60, frequency: 'monthly', day: 20, confidence: 'confirmed', payee: 'Invented net co' },
  ];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}
const pay = (H, date, amount, payee = 'Invented hydro') => H.lm({ date, amount, category: 'Utilities', account: 'chequing-a', payee });

const scenarios = [
  {
    id: '6.1', basis: 'derived', name: 'bill paid on its due date by its own payee shows Paid and leaves Other',
    async run(H) {
      const w = billsWorld(H);
      w.transactions.push(pay(H, '2026-10-12', 90));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.bill(s, 'Invented hydro'), /\$90\.00\s*Paid/, 'hydro is Paid for 90');
        H.expectIncludes(s.household, 'Household Budget Total', 'positive control: the household budget is rendered');
        H.expectExcludes(s.household, 'Invented hydro', 'a bill payment is not household spending');
      });
    },
  },
  {
    id: '6.2', basis: 'derived', name: 'Bills header: paid 90 of planned 150, 60 still to pay',
    async run(H) {
      const w = billsWorld(H);
      w.transactions.push(pay(H, '2026-10-12', 90));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        const bills = H.section(s, 'Bills');
        H.expectIncludes(bills, 'Paid bills this period$90.00', 'paid total is the one matched payment');
        H.expectIncludes(bills, 'Remaining bills to pay$60.00', 'remaining is 150 - 90');
      });
    },
  },
  {
    id: '6.3', basis: 'blueprint', name: 'amount alone never identifies a bill',
    // A 90 debit to an unrelated payee on the due date does not pay hydro.
    async run(H) {
      const w = billsWorld(H);
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 90, category: 'Gifts', account: 'chequing-a', payee: 'Invented florist' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expect(H.bill(s, 'Invented hydro'), 'hydro is listed');
        H.expectNoMatch(H.bill(s, 'Invented hydro'), /Paid/, 'hydro is not Paid by an unrelated 90');
        H.expectIncludes(s.household, 'Invented florist', 'the unrelated 90 stays visible as spending');
      });
    },
  },
  {
    id: '6.4', basis: 'spec', name: 'a 100 bill with 40 allocated: partial, 60 remaining',
    fixedBy: 'A7a #841',
    async run(H) {
      const w = billsWorld(H);
      w.bills[0].amount = 100;
      // Explicit allocation (bills blueprint): the identity rule declares that a
      // payment may settle part of this bill, so the 40 is allocated, not guessed.
      w.bills[0].rule = { settlesWhen: 'partial' };
      w.transactions.push(pay(H, '2026-10-12', 40));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        const row = H.bill(s, 'Invented hydro');
        H.expectMatch(row, /[Pp]art/, 'the bill reads as partly paid');
        H.expectNoMatch(row, /\$100\.00\s*Paid\b/, 'not shown as fully paid');
        H.expectIncludes(H.section(s, 'Bills'), '$60.00', 'the 60 still owed is shown');
      });
    },
  },
  {
    id: '6.5', basis: 'blueprint', name: 'payment of 100 on a 90 bill: Paid, with the 10 excess disclosed',
    async run(H) {
      const w = billsWorld(H);
      // Explicit allocation: this bill's rule accepts a payment of at least
      // its amount, so the 100 settles it and the 10 is excess, not guessed.
      w.bills[0].rule = { settlesWhen: 'amount-at-least' };
      w.transactions.push(pay(H, '2026-10-12', 100));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.bill(s, 'Invented hydro'), /Paid/, 'the bill is paid');
        H.expectMatch(H.section(s, 'Bills'), /\$10\.00[^$]{0,40}(excess|over|more than)|(excess|over|more than)[^$]{0,40}\$10\.00/i, 'the 10 excess is disclosed');
      });
    },
  },
  {
    id: '6.6', basis: 'spec', name: 'two 50 bills, one ambiguous 50 payment: neither shown settled',
    // Genuine ambiguity: no nearest-match tie-break; nothing is Paid.
    async run(H) {
      const w = billsWorld(H);
      w.bills = [
        { id: 'water', label: 'Invented water', amount: 50, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented city utility' },
        { id: 'waste', label: 'Invented waste', amount: 50, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented city utility' },
      ];
      w.transactions.push(pay(H, '2026-10-12', 50, 'Invented city utility'));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expect(H.bill(s, 'Invented water'), 'positive control: the water bill is listed');
        H.expect(H.bill(s, 'Invented waste'), 'positive control: the waste bill is listed');
        H.expectNoMatch(H.bill(s, 'Invented water'), /Paid/, 'water not guessed paid');
        H.expectNoMatch(H.bill(s, 'Invented waste'), /Paid/, 'waste not guessed paid');
        H.expectMatch(H.bill(s, 'Invented water'), /To confirm/, 'water stays to confirm');
        H.expectMatch(H.bill(s, 'Invented waste'), /To confirm/, 'waste stays to confirm');
      });
    },
  },
  {
    id: '6.7', basis: 'blueprint', name: 'paid two days after the due date: still matched (two-day window)',
    async run(H) {
      const w = billsWorld(H);
      // Explicit identity window (bills blueprint 6595179923; spec clarified
      // by the lead): this bill's rule accepts payment up to 2 days after the
      // due date. Rules without a window stay same-day.
      w.bills[0].rule = { postingDateRule: 'due-or-up-to-two-days-after' };
      w.transactions.push(pay(H, '2026-10-14', 90));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.bill(s, 'Invented hydro'), /\$90\.00\s*Paid/, 'two days late is inside the identity window');
      });
    },
  },
  {
    id: '6.8', basis: 'blueprint', name: 'one payment pays one occurrence: last month stays unpaid',
    // Sep 12 and Oct 12 occurrences; a single Oct 12 payment of 90. The
    // September occurrence must not also be marked Paid by it.
    async run(H) {
      const w = billsWorld(H);
      w.transactions.push(pay(H, '2026-10-12', 90));
      await H.withBudget(w, async p => {
        await p.step(-2);
        const s = await H.snap(p);
        H.expectMatch(s.range, /Sep 11/, 'stepped back to the period holding Sep 12');
        H.expect(H.bill(s, 'Invented hydro'), 'the September occurrence is listed');
        H.expectNoMatch(H.bill(s, 'Invented hydro'), /Paid/, 'the Oct payment is consumed once, by Oct');
      });
    },
  },
  {
    id: '6.9', basis: 'derived', name: 'a day-31 bill falls on Nov 30 in a 30-day month',
    async run(H) {
      const w = billsWorld(H);
      w.bills.push({ id: 'rent', label: 'Invented storage', amount: 120, frequency: 'monthly', day: 31, confidence: 'confirmed', payee: 'Invented storage co' });
      await H.withBudget(w, async p => {
        await p.step(3);
        const s = await H.snap(p);
        H.expectMatch(s.range, /Nov 20/, 'stepped to Nov 20 - Dec 3');
        H.expectMatch(H.bill(s, 'Invented storage'), /^Nov\s*30/, 'dated Nov 30');
        H.expectIncludes(H.bill(s, 'Invented storage'), '$120.00', 'for its planned 120');
      });
    },
  },
  {
    id: '6.10', basis: 'derived', name: 'missing payment evidence is "to confirm", never "not paid"',
    // Transaction coverage is truncated: a bill due Oct 12 with no observed
    // payment must not be declared unpaid.
    async run(H) {
      const w = billsWorld(H);
      w.coverage = { complete: false, hasMore: true };
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        const row = H.bill(s, 'Invented hydro');
        H.expect(row, 'hydro is listed');
        H.expectNoMatch(row, /Not paid|Missed|Overdue/, 'absence of evidence is not non-payment');
      });
    },
  },
  {
    id: '6.11', basis: 'audit', name: 'an estimated Bills balance is never shown as provider-confirmed (C5)',
    fixedBy: 'C5 (A7b; owner gate)',
    // The provider returns no Bills account, so the opening row is the
    // owner-entered estimate. The hero balance must carry the estimate mark.
    async run(H) {
      const w = billsWorld(H);
      const a = w.accounts.find(x => x.id === 'chequing-a');
      a.unobserved = true;
      a.confidence = 'estimated';
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(s.all, /Current balance[\s\S]{0,80}(≈|estimated|Estimated)/, 'the hero balance is marked as an estimate');
      });
    },
  },
  {
    id: '6.12', basis: 'spec', name: 'paid two days early: paid once, due date stays Oct 12',
    async run(H) {
      const w = billsWorld(H);
      // Explicit early-window qualifier (bills blueprint): this bill's rule
      // accepts payment up to 2 days before the due date.
      w.bills[0].rule = { postingDateRule: 'covers-early-or-due-on-or-before-posting', earlyPayLookaheadDays: 2 };
      w.transactions.push(pay(H, '2026-10-10', 90));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        const row = H.bill(s, 'Invented hydro');
        H.expectMatch(row, /^Oct\s*12/, 'keeps Oct 12 as the due date');
        H.expectMatch(row, /\$90\.00\s*Paid/, 'paid by the early payment');
        H.expectIncludes(H.section(s, 'Bills'), 'Paid bills this period$90.00', 'paid once, not twice');
      });
    },
  },
  {
    id: '6.13', basis: 'spec', name: 'a bill corrected from 90 to 95 for Oct 23 appears only in the Oct 23 period, at 95',
    async run(H) {
      const w = billsWorld(H);
      w.bills.push({ id: 'water', label: 'Invented water', amount: 95, frequency: 'once', date: '2026-10-23', confidence: 'confirmed',
        note: 'Invented correction from 90' });
      await H.withBudget(w, async p => {
        const now = await H.snap(p);
        H.expect(H.bill(now, 'Invented hydro'), 'positive control: the current period lists its bills');
        H.expectExcludes(now.bills.join(' '), 'Invented water', 'the current period does not hold it');
        await p.step(1);
        const s = await H.snap(p);
        H.expectMatch(s.range, /Oct 23/, 'next period');
        H.expectIncludes(H.bill(s, 'Invented water'), '$95.00', 'carried at the corrected 95');
        H.expectExcludes(H.bill(s, 'Invented water'), '$90.00', 'never the old 90');
      });
    },
  },
  {
    id: '6.14', basis: 'spec', name: 'a bill without an amount: the amount and dependent totals say Unknown',
    fixedBy: 'A6 #726',
    // Today the amount-less bill is not listed and its planned total reads
    // $0.00: missing shown as zero.
    async run(H) {
      const w = billsWorld(H);
      w.bills.push({ id: 'repair', label: 'Invented repair', frequency: 'once', date: '2026-10-19', confidence: 'estimated' });
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        const bills = H.section(s, 'Bills');
        H.expect(H.bill(s, 'Invented repair'), 'the bill is listed');
        H.expectMatch(H.bill(s, 'Invented repair'), /Unknown|Unavailable/, 'its amount says Unknown');
        H.expectIncludes(bills, 'of planned', 'positive control: the bills plan is shown');
        H.expectNoMatch(bills, /of planned \$150\.00/, 'the planned bills total does not quietly drop it');
      });
    },
  },
  {
    id: '6.15', basis: 'spec', name: 'a bill without a date: the date and dependent totals say Unknown',
    fixedBy: 'A6 #726',
    async run(H) {
      const w = billsWorld(H);
      w.bills.push({ id: 'licence', label: 'Invented licence', amount: 80, frequency: 'once', confidence: 'estimated' });
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(s.all, /Invented licence[\s\S]{0,160}(Unknown|Unavailable|no date|undated)/i, 'the undated bill is shown with an unknown date');
      });
    },
  },
  {
    id: '6.16', basis: 'audit', name: 'bill payments a day or two off the due date are not household spending (D3)',
    // #962 D3: hydro 90 due Oct 12 paid Oct 10, internet 60 due Oct 11 paid
    // Oct 13, stock LM categories. Neither settles (same-day identity), so
    // both bills stay To confirm and reserved; neither payment may also be
    // deducted as Other household spending.
    async run(H) {
      const w = billsWorld(H);
      w.bills[1].day = 11;
      w.transactions.push(pay(H, '2026-10-10', 90),
        H.lm({ date: '2026-10-13', amount: 60, category: 'Internet', account: 'chequing-a', payee: 'Invented net co' }));
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.bill(s, 'Invented hydro'), /To confirm/, 'hydro stays to confirm (nothing settles)');
        H.expectMatch(H.bill(s, 'Invented internet'), /To confirm/, 'internet stays to confirm (nothing settles)');
        H.expectIncludes(s.household, 'Household budget', 'positive control: the household budget is rendered');
        H.expectExcludes(s.household, 'Invented hydro', 'the hydro payment is not household spending');
        H.expectExcludes(s.household, 'Invented net co', 'the internet payment is not household spending');
        H.expectMatch(H.section(s, 'Bills'), /Possible payment/, 'the held payment is named on its bill');
      });
    },
  },
];

module.exports = { check: 6, title: 'Bills match dates, amounts and payment evidence', scenarios };
