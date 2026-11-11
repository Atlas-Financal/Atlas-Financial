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
  {
    id: '6.17', basis: 'audit', name: 'a default-rule payment of 40 on a 100 bill is not fully Paid (D4)',
    fixedBy: '6.4 default-rule partial-payment follow-up (#962 D4)',
    // #962 D4: unlike 6.4, there is NO settlesWhen override. Identity and
    // date match, but 100 - 40 = 60 is still owed. The row must say partial
    // with that remainder, or honestly stay To confirm. Existing 6.16
    // covers the early/late payment scenario from #965 (D3).
    async run(H) {
      const w = billsWorld(H);
      w.bills = [{ id: 'phone', label: 'Invented phone', amount: 100, frequency: 'monthly', day: 11,
        confidence: 'confirmed', payee: 'Invented phone' }];
      w.transactions.push(H.lm({ date: '2026-10-11', amount: 40, category: 'Utilities',
        account: 'chequing-a', payee: 'Invented phone' }));
      await H.withBudget(H.productionOpening(w), async (p, packets, built) => {
        const { data, packet, error } = built[0];
        H.expect(!error, `D4: the live overlay must succeed (${error && error.message})`);
        H.expect(packet && data.liveOverlay.applied, 'D4: posted payment evidence reaches the page');
        H.expect(packet.transactions.some(t => t.date === '2026-10-11' && t.amount === 40 && t.account === 'chequing-a'),
          'D4: the observer preserves the posted 40 payment');
        H.expect(data.plan.opening.asOf === '2026-10-14' && data.plan.opening.priorAsOf === '2026-10-09',
          'D4: live-plan advances the production opening from payday');
        const s = await H.snap(p);
        const row = H.bill(s, 'Invented phone');
        H.present(row, 'D4: the phone bill is listed');
        H.expect(/partial|partly paid|part paid|to confirm/i.test(row),
          `D4: a 40 payment cannot fully settle a 100 bill; expected partial or To confirm, got "${row}"`);
        if (!/to confirm/i.test(row)) {
          H.expectIncludes(row + ' ' + H.section(s, 'Bills'), '$60.00', 'D4: 100 - 40 = 60 remains owed');
        }
        H.expect(!/Paid\b/.test(row) || /\b(?:partially|partly|part)\s+paid\b/i.test(row),
          `D4: the partial payment must not read fully Paid (got "${row}")`);
      });
    },
  },
  {
    id: '6.18', basis: 'audit', name: 'a one-off bill beside a recurring bill is counted once, in the pay period that holds its real date',
    // Bills audit (#887). Internet is 60 on the 20th. A one-off install fee
    // of 45 is filed beside it (id "net-install") and dated Oct 16, four
    // days before the recurring day. By hand, on this calendar:
    //   Oct 9 - Oct 22  hydro Oct 12 (90) + fee Oct 16 (45) + internet Oct 20 (60) = 195
    //                   Balance After Deductions 1,400 - 195 - 400 household = 805
    //   Sep 11 - Sep 24 hydro Sep 12 (90) + internet Sep 20 (60) = 150, no fee
    //   Sep 25 - Oct 8 and Oct 23 - Nov 5 hold no bill at all.
    // Control: the same household without the fee plans 150 and leaves 850.
    async run(H) {
      const world = fee => {
        const w = billsWorld(H);
        if (fee) w.bills.push({ id: 'net-install', label: 'Invented install fee', amount: 45, frequency: 'once',
          date: '2026-10-16', confidence: 'confirmed', payee: 'Invented installer' });
        return w;
      };
      const bad = async p => ((await p.rows('[data-operating-question="07"]')).join(' ')
        .match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1];
      let control;
      await H.withBudget(world(false), async p => {
        const s = await H.snap(p);
        H.expectIncludes(H.section(s, 'Bills'), 'of planned $150.00', 'control: without the fee the period plans 150');
        H.expect(await bad(p) === '$850.00', 'control: 1,400 - 150 - 400 = 850');
        control = { hydro: H.bill(s, 'Invented hydro'), net: H.bill(s, 'Invented internet') };
      });
      await H.withBudget(world(true), async p => {
        const s = await H.snap(p);
        H.expectMatch(s.range, /Oct 9/, 'the current period');
        const fee = s.bills.filter(t => t.includes('Invented install fee'));
        H.expect(fee.length === 1, `the fee is listed exactly once in its own period (listed ${fee.length} times)`);
        H.expectMatch(fee[0], /^Oct\s*16/, 'printed on its real date, Oct 16');
        H.expectIncludes(fee[0], '$45.00', 'for its 45');
        H.expectIncludes(H.section(s, 'Bills'), 'of planned $195.00', 'the bill load is 90 + 45 + 60 = 195');
        H.expect(await bad(p) === '$805.00', `Balance After Deductions is 1,400 - 195 - 400 = 805 (got ${await bad(p)})`);
        H.expect(H.bill(s, 'Invented hydro') === control.hydro && H.bill(s, 'Invented internet') === control.net,
          'every other bill reads exactly as it does without the fee');
        const blend = await p.rows('[data-blend-bill]');
        H.expect(blend.filter(t => t.includes('Invented install fee')).length === 1
          && /^Oct 16/.test(blend.find(t => t.includes('Invented install fee'))),
          'the at-a-glance list names it once, on Oct 16');
        await p.step(1);
        const next = await H.snap(p);
        H.expectMatch(next.range, /Oct 23/, 'next period');
        H.expectIncludes(H.section(next, 'Bills'), 'of planned $0.00', 'the next period holds no copy');
        H.expectExcludes(H.section(next, 'Bills'), 'Invented install fee', 'the fee is not in the next period');
        await p.step(-2);
        const prior = await H.snap(p);
        H.expectMatch(prior.range, /Sep 25/, 'the period before');
        H.expectIncludes(H.section(prior, 'Bills'), 'of planned $0.00', 'the period before holds no copy');
        await p.step(-1);
        const older = await H.snap(p);
        H.expectMatch(older.range, /Sep 11/, 'the period holding Sep 20');
        H.expect(H.bill(older, 'Invented internet'), 'positive control: September lists its internet bill');
        H.expectIncludes(H.section(older, 'Bills'), 'of planned $150.00', 'September plans its own 90 + 60 only');
        H.expectExcludes(older.bills.join(' '), 'Invented install fee', 'the fee is not moved back to September');
      });
    },
  },
  {
    id: '6.19', basis: 'audit', name: 'one-off bills on the first and last day of a pay period stay in that period, in any timezone',
    // #887 adversarial cases. Four one-offs filed beside the internet bill
    // (day 20), and the same four filed standalone as the control:
    //   setup 30  dated Oct 9  (payday, first day), paid Oct 9 by its payee
    //   dup   45  dated Oct 13, paid Oct 13; the bank also shows the same
    //             debit once more as pending
    //   last  25  dated Oct 22 (last day of the period)
    //   next  15  dated Oct 23 (first day of the next period)
    // By hand: Oct 9 - Oct 22 plans 30 + 90 + 45 + 60 + 25 = 250, of which
    // 30 + 45 = 75 is paid and 175 remains; 1,400 - 250 - 400 = 750.
    // Oct 23 - Nov 5 plans the 15 only; 1,400 - 15 - 400 = 985.
    // Sep 25 - Oct 8 holds nothing. Dates are calendar days: the viewer's
    // timezone (UTC+14 and UTC-11 below) moves none of them.
    async run(H) {
      const world = prefix => {
        const w = billsWorld(H);
        const once = (id, label, amount, date, payee) => ({ id: prefix + id, label, amount, frequency: 'once', date,
          confidence: 'confirmed', payee });
        w.bills.push(once('setup', 'Invented setup fee', 30, '2026-10-09', 'Invented setup co'),
          once('dup', 'Invented duplicate fee', 45, '2026-10-13', 'Invented dup co'),
          once('last', 'Invented last-day fee', 25, '2026-10-22', 'Invented last co'),
          once('next', 'Invented next-period fee', 15, '2026-10-23', 'Invented next co'));
        w.transactions.push(pay(H, '2026-10-09', 30, 'Invented setup co'), pay(H, '2026-10-13', 45, 'Invented dup co'),
          H.lm({ date: '2026-10-13', amount: 45, category: 'Utilities', account: 'chequing-a', payee: 'Invented dup co', pending: true }));
        return w;
      };
      const bad = async p => ((await p.rows('[data-operating-question="07"]')).join(' ')
        .match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1];
      const read = async (prefix, timezoneId) => {
        const out = {};
        await H.withBudget(world(prefix), async p => {
          const now = await H.snap(p);
          out.now = { range: now.range, bills: now.bills.slice().sort(), section: H.section(now, 'Bills'), bad: await bad(p) };
          await p.step(1);
          const next = await H.snap(p);
          out.next = { range: next.range, bills: next.bills.slice().sort(), section: H.section(next, 'Bills'), bad: await bad(p) };
          await p.step(-2);
          const prior = await H.snap(p);
          out.prior = { range: prior.range, bills: prior.bills.slice().sort(), section: H.section(prior, 'Bills') };
        }, timezoneId ? { timezoneId } : undefined);
        return out;
      };
      const control = await read('solo-');
      for (const zone of [null, 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
        const got = await read('net-', zone);
        const at = zone ? ` (${zone})` : '';
        H.expectMatch(got.now.range, /Oct 9/, 'the current period' + at);
        const one = (list, label) => list.filter(t => t.includes(label));
        for (const [label, day] of [['Invented setup fee', 'Oct\\s*9'], ['Invented duplicate fee', 'Oct\\s*13'],
          ['Invented last-day fee', 'Oct\\s*22']]) {
          H.expect(one(got.now.bills, label).length === 1, `${label} is listed once in the current period${at}`);
          H.expectMatch(one(got.now.bills, label)[0], new RegExp('^' + day + '\\D'), `${label} keeps its real date${at}`);
          H.expect(one(got.next.bills, label).length === 0 && one(got.prior.bills, label).length === 0,
            `${label} is in no other period${at}`);
        }
        H.expectMatch(one(got.now.bills, 'Invented setup fee')[0], /\$30\.00\s*Paid/, 'paid on payday: Paid for 30' + at);
        H.expectMatch(one(got.now.bills, 'Invented duplicate fee')[0], /\$45\.00\s*Paid/,
          'the posted debit pays it once; the pending copy adds nothing' + at);
        H.expect(one(got.now.bills, 'Invented next-period fee').length === 0, 'the Oct 23 fee is not in the current period' + at);
        H.expectIncludes(got.now.section, 'of planned $250.00', 'the period plans 30 + 90 + 45 + 60 + 25 = 250' + at);
        H.expectIncludes(got.now.section, 'Paid bills this period$75.00', 'paid is 30 + 45 = 75, each once' + at);
        H.expectIncludes(got.now.section, 'Remaining bills to pay$175.00', 'remaining is 250 - 75 = 175' + at);
        H.expect(got.now.bad === '$750.00', `Balance After Deductions is 1,400 - 250 - 400 = 750${at} (got ${got.now.bad})`);
        H.expectMatch(got.next.range, /Oct 23/, 'next period' + at);
        H.expect(one(got.next.bills, 'Invented next-period fee').length === 1, 'the Oct 23 fee is listed once in the next period' + at);
        H.expectMatch(one(got.next.bills, 'Invented next-period fee')[0], /^Oct\s*23\D/, 'on its real date, Oct 23' + at);
        H.expectIncludes(got.next.section, 'of planned $15.00', 'the next period plans the 15 only' + at);
        H.expect(got.next.bad === '$985.00', `next period: 1,400 - 15 - 400 = 985${at} (got ${got.next.bad})`);
        H.expectMatch(got.prior.range, /Sep 25/, 'the period before' + at);
        H.expectIncludes(got.prior.section, 'of planned $0.00', 'the period before holds none of them' + at);
        H.expect(JSON.stringify(got) === JSON.stringify(control),
          'filed beside the recurring bill, every period reads exactly as when filed standalone' + at);
      }
    },
  },
];

module.exports = { check: 6, title: 'Bills match dates, amounts and payment evidence', scenarios };
