'use strict';

// No application imports. All expected money below comes from journal entries,
// independently added detail rows, or the same household with just one fault removed.
const { account, date, offset, terms, anchor } = require('./household');
const { faults } = require('./transport');
const checks = [
  'purchase-once',
  'internal-neutral',
  'lists',
  'figures',
  'fault-isolation',
  'last-known',
  'refresh',
  'no-move',
];
const known = ['topup', 'line-payment', 'equal-card', 'bill', 'shopping', 'false-minimum'];
const sum = (list, f) => list.reduce((n, item) => n + f(item), 0);
const numeric = Number.isSafeInteger;

function inspect({ seed, day, events, view: v, clean, prior, fault, baseline, knownOnly = false }) {
  const failures = [],
    exercised = new Set();
  function finding(cause, figure, expected, actual, habit, check) {
    failures.push({ cause, figure, expected, actual, habit, check });
  }
  const active = events.filter((e) => e.start <= day);
  const startDay = day - (day % 14);
  const inPeriod = (when) => when >= startDay && when <= day;
  const current = v.qualified && v.sourceDay === day;
  // The six consensus signatures are deliberately conjunctive. An unknown
  // figure alone cannot rediscover a claim about double charging or zero.
  if (current && baseline?.qualified && active.length === 1) {
    const e = active[0],
      n = e.habit;
    const rows = e.rows.filter((r) => r.sync <= day && (r.until == null || r.until > day));
    const posted = rows.filter((r) => !r.pending && inPeriod(r.when));
    const debits = posted.filter((r) => r.cents > 0),
      debit = debits[0];
    const amount = debit?.cents,
      delta = baseline.amounts.bad - v.amounts.bad;
    const heldIds = new Set(v.heldRows.map((r) => r.id));
    const inOther = (id) => v.budgets.find((b) => b.id === 'other-spending')?.rows.find((r) => r.id === id);
    const t = terms(seed);
    if (
      n.startsWith('topup') &&
      (n !== 'topup-pending' ||
        rows.some(
          (r) =>
            r.pending &&
            r.key === 'weekly' &&
            debits.some((d) => d.cents === -r.cents && d.payee.slice(0, 5) === r.payee.slice(0, 5))
        )) &&
      debits.length &&
      debits.every((r) => heldIds.has(r.id)) &&
      delta === sum(debits, (r) => r.cents) &&
      numeric(baseline.amounts.billsEnd) &&
      v.amounts.billsEnd === null &&
      v.tileIssues.includes('unpaired-bills-transfer')
    ) {
      finding(
        'topup',
        'Balance After Deductions / Bills period end',
        { deduction: 0, billsEnd: 'published' },
        { deduction: delta, billsEnd: null },
        n,
        'internal-neutral'
      );
    }
    if (
      n === 'line-payment' &&
      debit &&
      v.amounts.linePaid === t.lineMin &&
      amount === t.lineMin &&
      heldIds.has(debit.id) &&
      v.amounts.billLoad === baseline.amounts.billLoad &&
      delta === amount &&
      v.bills.some((b) => b.id === 'sim-line-minimum' && b.amount === amount)
    ) {
      finding(
        'line-payment',
        'line minimum and held outflows',
        { extraDeduction: 0 },
        { paid: amount, extraDeduction: delta },
        n,
        'figures'
      );
    }
    if (
      n === 'equal-card' &&
      e.transfers.length === 2 &&
      e.transfers.every(
        (m) =>
          m.to === 'card' && posted.some((r) => r.id === m.debit) && posted.some((r) => r.id === m.receipt)
      ) &&
      e.transfers[0].cents === e.transfers[1].cents &&
      e.transfers[1].at - e.transfers[0].at === 2 &&
      v.amounts.cardPaid === 0 &&
      baseline.amounts.cardPaid === 0
    ) {
      finding(
        'equal-card',
        'card Paid back',
        sum(e.transfers, (m) => m.cents),
        0,
        n,
        'figures'
      );
    }
    const sub = n === 'subscription-paypal';
    if (
      (['bill-renamed', 'bill-weekly', 'bill-above'].includes(n) || sub) &&
      debit &&
      inOther(debit.id)?.cents === amount
    ) {
      const bill = v.bills.find((b) => b.id === (sub ? 'bell' : 'kiln') && b.date === date(e.start));
      if (
        bill &&
        (sub
          ? bill.paid && bill.basis === 'schedule-trust-on-due' && debit.payee.startsWith('PAYPAL')
          : bill.remaining === t.bill && !bill.paid)
      ) {
        finding(
          'bill',
          sub ? 'schedule-settled subscription and Other' : 'bill still due and Other',
          { other: 0 },
          { other: amount, remaining: bill.remaining, scheduledPaid: bill.paid },
          n,
          'purchase-once'
        );
      }
    }
    if (
      n === 'shopping' &&
      debit?.label === 'Shopping' &&
      inOther(debit.id)?.reason === 'personal-unassigned'
    ) {
      finding('shopping', 'ownerless Shopping in Other', 0, inOther(debit.id).cents, n, 'figures');
    }
    if (
      n === 'near-minimum' &&
      posted.length === 1 &&
      !debit.notes &&
      debit.key === 'bills' &&
      v.cardReasons.includes('card-payment-inferred-by-minimum') &&
      baseline.amounts.cardPaid === 0 &&
      v.amounts.cardPaid === t.min
    ) {
      finding('false-minimum', 'card Paid back', 0, v.amounts.cardPaid, n, 'figures');
    }
  }
  if (knownOnly) return { failures, exercised: [] };
  exercised.add('refresh');
  if (v.exception)
    finding(
      'refresh/' + (fault || v.exception.code),
      'refresh exception',
      'completed',
      v.exception.message,
      fault || 'mixed',
      'refresh'
    );
  if (current) {
    exercised.add('purchase-once');
    exercised.add('internal-neutral');
    exercised.add('lists');
    exercised.add('figures');
    if (v.start !== date(startDay) || v.end !== date(startDay + 13))
      finding(
        'figures/period',
        'active pay period',
        [date(startDay), date(startDay + 13)],
        [v.start, v.end],
        'payday',
        'figures'
      );
    // The journal represents the same purchase across versions. Compare all
    // published owners in the period views, including the tagged Savings tally.
    for (const e of active)
      for (const buy of e.purchases) {
        const versions = buy.versions.filter((r) => r.day <= day);
        if (!versions.length || !inPeriod(versions.at(-1).when)) continue;
        const relevant = v.buys.filter((r) => buy.ids.includes(r.id));
        const expected = versions.at(-1).cents,
          actual = sum(relevant, (r) => r.cents);
        if (actual !== expected)
          finding(
            'purchase/' + e.habit,
            'purchase across periods and owners',
            expected,
            actual,
            e.habit,
            'purchase-once'
          );
      }
    for (const e of active)
      for (const move of e.transfers) {
        if (
          !inPeriod(move.at) ||
          !['bills', 'weekly', 'pool', 'reserve'].includes(move.from) ||
          !['bills', 'weekly', 'pool', 'reserve'].includes(move.to)
        )
          continue;
        const legs = [move.debit, move.receipt];
        const spent = sum(
          v.spendingRows.filter((r) => legs.includes(r.id)),
          (r) => r.cents
        );
        const income = sum(
          v.incomeRows.filter((r) => legs.includes(r.id)),
          (r) => r.cents
        );
        if (spent || income)
          finding(
            'internal/' + e.habit,
            'spending / other income',
            [0, 0],
            [spent, income],
            e.habit,
            'internal-neutral'
          );
      }
    for (const b of v.budgets) {
      const total = sum(b.rows, (r) => r.cents);
      if (b.listAvailable && numeric(b.spent) && total !== b.spent)
        finding('list/budget', 'category list / Spent', total, b.spent, b.id, 'lists');
    }
    const paid = v.bills.filter((b) => b.checked && b.part === 'other');
    const paidSum = sum(paid, (b) => b.amount);
    if (
      numeric(v.amounts.billPaid) &&
      v.bills.every((b) => b.part !== 'mortgage') &&
      paidSum !== v.amounts.billPaid
    )
      finding('list/bills', 'Bills paid list / total', paidSum, v.amounts.billPaid, 'bill-list', 'lists');
    if (numeric(v.amounts.bad) && numeric(v.amounts.surplus) && v.amounts.bad !== v.amounts.surplus)
      finding(
        'figures/remainder',
        'Stack Surplus / Balance After Deductions',
        v.amounts.surplus,
        v.amounts.bad,
        'mixed',
        'figures'
      );
    // Independent control purchases prevent an empty category/list from passing
    // the exactly-once and list checks simultaneously.
    for (let d = Math.max(0, offset(v.start)); d <= day; d++) {
      const count = v.buys.filter((r) => r.id === 410000 + d && r.owner === 'groceries');
      if (count.length !== 1 || count[0].cents !== anchor(d))
        finding(
          'purchase/control',
          'posted grocery counted once',
          anchor(d),
          sum(count, (r) => r.cents),
          'daily-grocery',
          'purchase-once'
        );
    }
  }
  if (baseline?.qualified && active.length === 1 && !knownOnly) {
    const n = active[0].habit;
    exercised.add('fault-isolation');
    // These independent goals have distinct tag identities. A purchase or a
    // transfer on a different item does not spend the loom's money. Cash and
    // liabilities can change; the independent tagged purchase tally cannot.
    const e = active[0];
    const tallyHabits = [
      'savings-purchase',
      'savings-card',
      'savings-covered',
      'savings-overspend',
      'savings-refund',
      'savings-refund-pending',
      'savings-refund-later',
      'savings-pending-twin',
    ];
    if (tallyHabits.includes(n) && e.purchases.length) {
      // The first kite is due on day 12. Its documented grace is 14 days.
      // A later posted refund reduces the same goal exactly once; a pending
      // credit has not entered the economic journal yet.
      const charges = sum(e.purchases, (p) => {
        const last = p.versions.filter((r) => r.day <= day).at(-1);
        return last && last.when <= 26 ? last.cents : 0;
      });
      const refunds = n.startsWith('savings-refund')
        ? sum(
            e.entries.filter((r) => r.cents < 0 && r.day <= day && r.day <= 26),
            (r) => r.cents
          )
        : 0;
      const expected = charges + refunds;
      if (expected >= 0 && v.amounts.goalKiteSpent !== expected)
        finding('savings/goal-tally', 'kite Spent', expected, v.amounts.goalKiteSpent, n, 'purchase-once');
    }
    if (
      !['savings-conflict', 'savings-overlap', 'savings-group-goal'].includes(n) &&
      numeric(baseline.amounts.goalLoomSpent) &&
      v.amounts.goalLoomSpent !== baseline.amounts.goalLoomSpent
    ) {
      finding(
        'isolation/unrelated-goal',
        'unrelated goal Spent',
        baseline.amounts.goalLoomSpent,
        v.amounts.goalLoomSpent,
        n,
        'fault-isolation'
      );
    }
  }
  if (fault && clean?.qualified) {
    exercised.add('fault-isolation');
    const dependent = new Set(faults[fault].fields);
    for (const field of Object.keys(clean.amounts)) {
      if (dependent.has(field) || !numeric(clean.amounts[field])) continue;
      // An uncertain purchase can legitimately affect every total downstream.
      if (dependent.has('spending') && ['bad', 'surplus', 'billsEnd', 'householdHold'].includes(field))
        continue;
      if (dependent.has('cash') && ['billsEnd'].includes(field)) continue;
      if (dependent.has('cardSpent') && ['bad', 'surplus', 'billsEnd', 'householdHold'].includes(field))
        continue;
      if (v.amounts[field] !== clean.amounts[field])
        finding(
          'isolation/' + fault,
          field,
          clean.amounts[field],
          v.amounts[field],
          fault,
          'fault-isolation'
        );
    }
  }
  // A new card transaction, payment claim or statement can legitimately
  // supersede the prior reading. A thin feed by itself cannot. Decide that
  // from arrival/withdrawal times in the invented evidence journal.
  const changedCardEvidence = active.some(
    (e) =>
      (e.start === day && e.habit.startsWith('statement-')) ||
      e.rows.some(
        (r) =>
          (r.key === 'card' || e.transfers.some((m) => m.to === 'card' && m.debit === r.id)) &&
          (r.sync === day || r.until === day)
      )
  );
  if (
    fault &&
    prior?.qualified &&
    prior.sourceDay === day - 1 &&
    prior.start === v.start &&
    numeric(prior.amounts.cardSpent) &&
    !prior.cardObservedAt &&
    ((fault === 'thin-card' && !changedCardEvidence) || v.retained)
  ) {
    exercised.add('last-known');
    const old = prior.amounts.cardSpent;
    if (
      v.amounts.cardSpent !== old ||
      v.cardTrust !== 'estimated' ||
      (!v.retained && v.cardObservedAt !== date(day - 1) + 'T18:00:00.000Z')
    )
      finding(
        'last-known/' + (v.retained ? 'retained' : 'thin-card'),
        'last qualified card Spent / trust',
        [old, 'estimated'],
        [v.amounts.cardSpent, v.cardTrust],
        fault,
        'last-known'
      );
  }
  if (v.retained && prior?.qualified && prior.sourceDay === day - 1 && prior.start === v.start) {
    exercised.add('last-known');
    // One mismatch records all comparable retained figure fields and preserves
    // which one failed without turning a whole previous snapshot into N faults.
    const mismatch = Object.keys(v.trust || {}).filter(
      (k) =>
        k !== 'cardSpent' &&
        numeric(prior.amounts[k]) &&
        (v.amounts[k] !== prior.amounts[k] || !['estimated', 'unknown', 'unavailable'].includes(v.trust[k]))
    );
    if (mismatch.length)
      finding(
        'last-known/retained-block',
        'retained figure values and trust',
        'prior cents at estimated trust',
        mismatch.map((k) => ({ field: k, cents: v.amounts[k], trust: v.trust[k] })),
        fault,
        'last-known'
      );
  }
  exercised.add('no-move');
  const unresolvedEvidence = active.some((e) => {
    const visible = e.rows.filter(
      (r) => r.sync <= day && (r.until == null || r.until > day) && inPeriod(r.when)
    );
    if (e.habit === 'near-minimum' && visible.some((r) => !r.notes)) return true;
    if (visible.some((r) => r.tags?.length > 1) && e.habit === 'savings-conflict') return true;
    return e.transfers.some(
      (m) =>
        visible.some((r) => r.id === m.debit && !r.notes) &&
        !visible.some((r) => r.id === m.receipt && !r.pending)
    );
  });
  if ((v.unresolved || unresolvedEvidence || fault) && v.moves.length)
    finding('advice/unresolved', 'current money-move instructions', [], v.moves, fault || 'mixed', 'no-move');
  return { failures, exercised: [...exercised] };
}
module.exports = { inspect, checks, known };
