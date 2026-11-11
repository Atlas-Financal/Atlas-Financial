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
    id: '6.20', basis: 'audit', name: 'an unproven recurring bill from the last closed pay period is listed once, to confirm, on the current period',
    // #953. Production's opening shape: the plan is dated Sep 20 and the
    // observation is Oct 14, so the cash walk still deducts every unproven
    // bill since Sep 20. Water is 120 on the 1st: Oct 1 sits in the closed
    // period Sep 25 - Oct 8. Hydro is 90 on the 12th. By hand, Oct 9 - Oct 22:
    //   no water payment    90 + 120 carried = 210 planned, 210 remaining;
    //                       Balance After Deductions 1,400 - 210 - 400 = 790
    //   pending debit only  the same: a pending debit is not posted evidence
    //   paid Oct 1          90 planned; 1,400 - 90 - 400 = 910; Paid in its own period
    // Control: without the water bill the period plans 90 and leaves 910.
    async run(H) {
      const world = (water, extra) => {
        const w = billsWorld(H);
        w.bills = [w.bills[0]].concat(water ? [{ id: 'water', label: 'Invented water', amount: 120, frequency: 'monthly',
          day: 1, confidence: 'confirmed', payee: 'Invented water co' }] : []);
        if (extra) w.transactions.push(extra);
        H.productionOpening(w);
        const patch = w.planPatch;
        w.canonicalAsOf = '2026-09-20';
        w.planPatch = plan => {
          patch(plan);
          plan.opening = { asOf: '2026-09-20', representedEvents: [] };
          for (const row of plan.startingCash.breakdown) row.evidenceDate = '2026-09-20';
        };
        return w;
      };
      const debit = pending => H.lm({ date: '2026-10-01', amount: 120, category: 'Utilities', account: 'chequing-a',
        payee: 'Invented water co', pending });
      const bad = async p => ((await p.rows('[data-operating-question="07"]')).join(' ')
        .match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1];
      const opened = built => {
        const { data, error } = built[0];
        H.expect(!error, `the live overlay must succeed (${error && error.message})`);
        H.expect(data.plan.opening.asOf === '2026-10-14' && data.plan.opening.priorAsOf === '2026-09-20',
          'live-plan advances the opening from the dated Sep 20 plan');
      };
      let hydro;
      await H.withBudget(world(false), async (p, packets, built) => {
        opened(built);
        const s = await H.snap(p);
        hydro = H.bill(s, 'Invented hydro');
        H.expect(hydro, 'control: hydro is listed');
        H.expectIncludes(H.section(s, 'Bills'), 'of planned $90.00', 'control: without water the period plans 90');
        H.expect(await bad(p) === '$910.00', 'control: 1,400 - 90 - 400 = 910');
      });
      for (const [state, extra] of [['no payment', null], ['a pending debit', debit(true)]]) {
        await H.withBudget(world(true, extra), async (p, packets, built) => {
          opened(built);
          const s = await H.snap(p);
          H.expectMatch(s.range, /Oct 9/, 'the current period');
          const water = s.bills.filter(t => t.includes('Invented water'));
          H.expect(water.length === 1, `${state}: the water bill is listed exactly once on the current period (listed ${water.length} times)`);
          H.expectMatch(water[0], /^Oct\s*1\D/, `${state}: it keeps its real due date, Oct 1`);
          H.expectMatch(water[0], /\$120\.00\s*To confirm/, `${state}: 120, to confirm`);
          H.expectNoMatch(water[0], /Paid/, `${state}: never shown as paid`);
          const bills = H.section(s, 'Bills');
          H.expectIncludes(bills, 'of planned $210.00', `${state}: the period plans 90 + 120 = 210`);
          H.expectIncludes(bills, 'Remaining bills to pay$210.00', `${state}: 210 is still to pay or confirm`);
          H.expect(await bad(p) === '$790.00', `${state}: Balance After Deductions is 1,400 - 210 - 400 = 790 (got ${await bad(p)})`);
          H.expect(H.bill(s, 'Invented hydro') === hydro, `${state}: the hydro row reads exactly as it does without water`);
          await p.step(1);
          const next = await H.snap(p);
          H.expectMatch(next.range, /Oct 23/, 'next period');
          const later = next.bills.filter(t => t.includes('Invented water'));
          H.expect(later.length === 1 && /^Nov\s*1\D/.test(later[0]), `${state}: the next period holds only its own Nov 1 water bill`);
        });
      }
      await H.withBudget(world(true, debit(false)), async (p, packets, built) => {
        opened(built);
        const s = await H.snap(p);
        H.expect(H.bill(s, 'Invented hydro') === hydro, 'paid: positive control, the current period lists hydro');
        H.expectExcludes(s.bills.join(' '), 'Invented water', 'paid: the water bill is not asked for again');
        H.expectIncludes(H.section(s, 'Bills'), 'of planned $90.00', 'paid: the period plans 90 only');
        H.expect(await bad(p) === '$910.00', 'paid: 1,400 - 90 - 400 = 910');
        await p.step(-1);
        const previous = await H.snap(p);
        H.expectMatch(previous.range, /Sep 25/, 'the closed period');
        H.expectMatch(H.bill(previous, 'Invented water'), /^Oct\s*1\D[\s\S]*\$120\.00\s*Paid/, 'paid: its own period shows it Paid for 120');
      });
    },
  },
  {
    id: '6.21', basis: 'audit', name: 'a bill from the last closed pay period paid late in the new one is counted once',
    // #953 review repair. Same opening as 6.20: plan dated Sep 20, observed
    // Oct 14. Water 120 was due Oct 1, in the closed period Sep 25 - Oct 8,
    // and nothing posted on that date, so it is carried "to confirm". A
    // posted debit from the water payee then lands in the new period. It
    // settles nothing (identity is payee + date), so the bill stays reserved
    // and the debit must not also be deducted as household spending.
    // By hand, Oct 9 - Oct 22, in every case below:
    //   90 hydro + 120 carried = 210 planned; 1,400 - 210 - 400 = 790.
    //   paid Oct 10 (120)   the reviewer's case
    //   paid Oct 9 (120)    the first day of the new period, the boundary
    //   paid Oct 10 (80)    a different amount: amount never identifies
    // Control: the same 120 debit from another payee is real spending on top
    // of the unpaid bill: 1,400 - 210 - 520 = 670.
    // Paid Oct 8, late but inside the closed period: not carried at all,
    // 90 planned, 1,400 - 90 - 400 = 910.
    async run(H) {
      const world = extra => {
        const w = billsWorld(H);
        w.bills = [w.bills[0], { id: 'water', label: 'Invented water', amount: 120, frequency: 'monthly',
          day: 1, confidence: 'confirmed', payee: 'Invented water co' }];
        if (extra) w.transactions.push(extra);
        H.productionOpening(w);
        const patch = w.planPatch;
        w.canonicalAsOf = '2026-09-20';
        w.planPatch = plan => {
          patch(plan);
          plan.opening = { asOf: '2026-09-20', representedEvents: [] };
          for (const row of plan.startingCash.breakdown) row.evidenceDate = '2026-09-20';
        };
        return w;
      };
      const debit = (date, amount, payee = 'Invented water co') => H.lm({ date, amount, category: 'Utilities',
        account: 'chequing-a', payee });
      const bad = async p => ((await p.rows('[data-operating-question="07"]')).join(' ')
        .match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1];
      let unpaidWater;
      await H.withBudget(world(null), async p => {
        const s = await H.snap(p);
        unpaidWater = H.bill(s, 'Invented water');
        H.expectMatch(unpaidWater, /^Oct\s*1\D[\s\S]*\$120\.00\s*To confirm/, 'control: unpaid, water is carried to confirm');
        H.expect(await bad(p) === '$790.00', 'control: unpaid, 1,400 - 210 - 400 = 790');
      });
      for (const [state, extra] of [['paid Oct 10', debit('2026-10-10', 120)], ['paid Oct 9, the first day of the period', debit('2026-10-09', 120)],
        ['paid Oct 10 for 80', debit('2026-10-10', 80)]]) {
        await H.withBudget(world(extra), async p => {
          const s = await H.snap(p);
          H.expectMatch(s.range, /Oct 9/, 'the current period');
          const water = s.bills.filter(t => t.includes('Invented water'));
          H.expect(water.length === 1, `${state}: the water bill is listed exactly once (listed ${water.length} times)`);
          H.expectMatch(water[0], /^Oct\s*1\D[\s\S]*\$120\.00\s*To confirm/, `${state}: Oct 1, 120, to confirm`);
          H.expectNoMatch(water[0], /Paid/, `${state}: a late debit never marks it paid`);
          const bills = H.section(s, 'Bills');
          H.expectIncludes(bills, 'of planned $210.00', `${state}: the period plans 90 + 120 = 210`);
          H.expectIncludes(s.household, 'Household budget', `${state}: positive control, the household budget is rendered`);
          H.expectExcludes(s.household, 'Invented water', `${state}: the payment is not also household spending`);
          H.expect(await bad(p) === '$790.00', `${state}: Balance After Deductions is 1,400 - 210 - 400 = 790, once (got ${await bad(p)})`);
          H.expectMatch(bills, /Possible payment/, `${state}: the held payment is named on its bill`);
        });
      }
      await H.withBudget(world(debit('2026-10-10', 120, 'Invented florist')), async p => {
        const s = await H.snap(p);
        H.expect(H.bill(s, 'Invented water') === unpaidWater, 'another payee: the water row reads exactly as unpaid');
        H.expect(await bad(p) === '$670.00', `another payee: real spending on top of the unpaid bill, 1,400 - 210 - 520 = 670 (got ${await bad(p)})`);
      });
      // Final review round: paid Oct 8, seven days late but still inside the
      // closed period. That debit is the closed period's own spending, so the
      // bill is not carried as well: Oct 9 - Oct 22 plans hydro only, 90, and
      // 1,400 - 90 - 400 = 910, exactly as before this change.
      await H.withBudget(world(debit('2026-10-08', 120)), async p => {
        const s = await H.snap(p);
        H.expectMatch(s.range, /Oct 9/, 'the current period');
        H.expectMatch(H.bill(s, 'Invented hydro') || '', /Invented hydro/, 'paid Oct 8: positive control, hydro is listed');
        H.expectExcludes(s.bills.join(' '), 'Invented water', 'paid Oct 8: the water bill is not carried into the new period');
        H.expectIncludes(H.section(s, 'Bills'), 'of planned $90.00', 'paid Oct 8: the period plans 90 only');
        H.expect(await bad(p) === '$910.00', `paid Oct 8: Balance After Deductions is 1,400 - 90 - 400 = 910 (got ${await bad(p)})`);
        await p.step(-1);
        const previous = await H.snap(p);
        H.expectMatch(previous.range, /Sep 25/, 'the closed period');
        const own = previous.bills.filter(t => t.includes('Invented water'));
        H.expect(own.length === 1 && /^Oct\s*1\D/.test(own[0]) && !/Paid/.test(own[0]),
          'paid Oct 8: its own period keeps the Oct 1 row, never Paid on a late debit');
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
    // owner-entered estimate. Production's live overlay refuses to advance a
    // stale opening without a fresh provider reading of the Bills account
    // (missing-live-cash-evidence), so no reachable path shows an estimated
    // Bills figure through it: the cautious outcome is that the hero shows
    // Unavailable. If a figure is ever shown, it must carry the estimate
    // mark; a bare dollar figure is never allowed.
    async run(H) {
      const w = billsWorld(H);
      const a = w.accounts.find(x => x.id === 'chequing-a');
      a.unobserved = true;
      a.confidence = 'estimated';
      await H.withBudget(w, async p => {
        const hero = (await p.text('[data-budget-cash-hero]')).replace(/\s+/g, ' ').trim();
        H.expect(hero.length > 0, 'the hero balance is rendered');
        H.expect(/^Unavailable$/.test(hero) || /(≈|estimated)/i.test(hero),
          'the hero shows Unavailable or an estimate-marked figure, never a bare confirmed number: ' + (/\d/.test(hero) ? '[a figure]' : hero));
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
];

module.exports = { check: 6, title: 'Bills match dates, amounts and payment evidence', scenarios };
