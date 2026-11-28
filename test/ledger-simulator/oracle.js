'use strict';

// No application imports. All expected money below comes from journal entries,
// independently added detail rows, or the same household with just one fault removed.
const { date, offset, terms, anchor, world } = require('./household');
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
const ownedCash = new Set(['bills', 'weekly', 'pool', 'reserve', 'pocket']);
const nonSpending = new Set(['Payment, Transfer', 'Transfer', 'Credit Card Payment', 'Payroll', 'Income']);
// These faults remove evidence required for the entire current publication.
// Known cash admission errors are distinct from an arbitrary refresh exception.
const requiredRefusals = {
  'missing-balance': 'missing-live-cash-evidence',
  'account-behind': 'stale-live-cash-evidence',
  'unmapped-account': null,
  'malformed-amount': null,
  'foreign-currency': null,
  'foreign-card': null,
  'edit-between-pages': null,
};
function savingsExpectations(seed, day, events) {
  const input = world(seed, day, events),
    links = input.accountMap.savingsLinks?.links || [];
  const rows = input.payload.transactions,
    goals = new Map();
  const occurrence = (link) => link.goalRef.kind + ':' + link.goalRef.id + '@' + link.occurrenceDate;
  for (const link of links) {
    const key = occurrence(link);
    if (!goals.has(key)) goals.set(key, { ids: new Set(), reasons: new Set(), net: 0 });
    if (link.effectiveFrom < input.payload.transactionWindow.startDate) goals.get(key).reasons.add('history');
  }
  for (const r of rows) {
    const matches = links.filter(
      (l) => r.tag_ids?.includes(l.tagId) && r.date >= l.effectiveFrom && r.date <= l.effectiveThrough
    );
    const keys = new Set(matches.map(occurrence));
    for (const key of keys) {
      const g = goals.get(key);
      g.ids.add(r.id);
      if (keys.size > 1) g.reasons.add('conflicting links');
      const due = matches.find((l) => occurrence(l) === key).occurrenceDate;
      if (offset(r.date) <= offset(due) + 14 && (!r.is_pending || Number(r.amount) > 0))
        g.net += Math.round(Number(r.amount) * 100);
    }
  }
  for (const g of goals.values()) {
    const charges = rows.filter((r) => g.ids.has(r.id) && Number(r.amount) > 0);
    if (
      rows.some(
        (r) =>
          !r.tag_ids?.length &&
          Number(r.amount) < 0 &&
          !r.is_pending &&
          charges.some(
            (c) => c.payee === r.payee && c.plaid_account_id === r.plaid_account_id && c.date <= r.date
          )
      )
    )
      g.reasons.add('unlinked same-merchant refund');
  }
  for (const g of goals.values()) if (g.net < 0) g.reasons.add('refund exceeds charges');
  return goals;
}

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
      e.transfers.length > 0 &&
      e.transfers.every((m) => ownedCash.has(m.from) && ownedCash.has(m.to)) &&
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
  const mandatory = Object.hasOwn(requiredRefusals, fault);
  const expectedCashRefusal =
    mandatory &&
    requiredRefusals[fault] &&
    v.exception?.code === 'live-plan-failed' &&
    v.exception.message.split(':')[0] === requiredRefusals[fault] &&
    !v.exception.stage;
  if (v.exception && !expectedCashRefusal)
    finding(
      'refresh/' + (fault || v.exception.code),
      'refresh exception',
      'completed',
      v.exception.message,
      fault || 'mixed',
      'refresh'
    );
  if (mandatory && clean?.qualified) {
    exercised.add('fault-isolation');
    const hasPrior = prior?.qualified || prior?.retained || false;
    if (v.qualified || v.retained !== hasPrior || (hasPrior && v.sourceDay !== prior.sourceDay)) {
      finding(
        'admission/' + fault,
        'current admission and dated fallback',
        [false, hasPrior, hasPrior ? prior.sourceDay : null],
        [v.qualified, v.retained, v.retained ? v.sourceDay : null],
        fault,
        'fault-isolation'
      );
    } else if (hasPrior) {
      const expectedDate = date(prior.sourceDay),
        expectedReceipt = [
          expectedDate,
          expectedDate,
          expectedDate + 'T18:00:00.000Z',
          date(day) + 'T18:00:00.000Z',
        ];
      const receipt = [
        v.publishedAsOf,
        v.retainedReceipt?.asOf,
        v.retainedReceipt?.observedAt,
        v.retainedReceipt?.attempt?.attemptedAt,
      ];
      if (JSON.stringify(receipt) !== JSON.stringify(expectedReceipt))
        finding(
          'retention/' + fault,
          'publication date and attempt receipt',
          expectedReceipt,
          receipt,
          fault,
          'last-known'
        );
      for (const field of Object.keys(prior.amounts))
        if (v.amounts[field] !== prior.amounts[field])
          finding('retention/' + fault, field, prior.amounts[field], v.amounts[field], fault, 'last-known');
      exercised.add('last-known');
    }
  }
  const goals =
    current && active.some((e) => e.rows.some((r) => r.tags?.length))
      ? savingsExpectations(seed, day, active)
      : new Map();
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
        const amount = versions.at(-1).cents;
        const excluded = nonSpending.has(buy.label) || buy.key === 'studio';
        const expected = excluded ? 0 : amount;
        const counted = sum(relevant, (r) => r.cents);
        // Withheld tagged spending has no published number. Only accept an
        // unknown when the independently observed evidence cannot price it.
        const withheld = (v.withheldPurchases || []).filter((x) => buy.ids.includes(x.id));
        const authorizedUnknown = withheld.some((row) => {
          const g = goals.get(row.goal + '@' + row.needDate);
          return g?.reasons.size && g.ids.has(row.id);
        });
        if (!counted && authorizedUnknown && withheld.length) continue;
        const actual = !counted && withheld.length ? null : counted;
        if (
          excluded &&
          buy.key !== 'studio' &&
          active.length === 1 &&
          baseline?.qualified &&
          ['weekly', 'bills'].includes(buy.key) &&
          sum(
            v.heldRows.filter((r) => buy.ids.includes(r.id)),
            (r) => r.cents
          ) !== amount
        )
          finding(
            'classification/hold',
            'excluded cash debit held once',
            amount,
            sum(
              v.heldRows.filter((r) => buy.ids.includes(r.id)),
              (r) => r.cents
            ),
            e.habit,
            'purchase-once'
          );
        if (buy.key === 'studio' && v.heldRows.some((r) => buy.ids.includes(r.id)))
          finding(
            'classification/external-held',
            'external debit held in household',
            0,
            sum(
              v.heldRows.filter((r) => buy.ids.includes(r.id)),
              (r) => r.cents
            ),
            e.habit,
            'purchase-once'
          );
        if (actual !== expected)
          finding(
            (excluded ? 'classification/forbidden-spending/' : 'purchase/') + e.habit,
            'purchase across periods and owners',
            expected,
            actual,
            e.habit,
            'purchase-once'
          );
      }
    for (const [key, g] of goals) {
      const published = v.goalFigures.find((x) => x.id + '@' + x.needDate === key);
      if (g.reasons.size && published && numeric(published.spent))
        finding(
          'savings/unprovable',
          'unsupported ' + key + ' Spent',
          null,
          published.spent,
          'tagged evidence',
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
  if (current && baseline?.qualified && active.length === 1 && !knownOnly) {
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
      if (
        expected >= 0 &&
        !goals.get('commitment:kite@' + date(12))?.reasons.size &&
        v.amounts.goalKiteSpent !== expected
      )
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
  if (clean?.qualified && ['thin-card', 'thin-payer'].includes(fault) && !current) {
    exercised.add('fault-isolation');
    finding('isolation/' + fault, 'fresh unrelated cohort', 'current', 'withheld', fault, 'fault-isolation');
  }
  if (fault && !mandatory && current && clean?.qualified) {
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
    fault === 'thin-card' &&
    current &&
    !changedCardEvidence
  ) {
    exercised.add('last-known');
    const old = prior.amounts.cardSpent;
    if (
      v.amounts.cardSpent !== old ||
      v.cardTrust !== 'estimated' ||
      v.cardObservedAt !== date(day - 1) + 'T18:00:00.000Z'
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
  const gap = v.payerGap;
  if (
    fault === 'thin-payer' &&
    current &&
    prior?.qualified &&
    prior.start === v.start &&
    gap &&
    !gap.unconfirmed &&
    gap.amounts.cardPaid === null &&
    gap.reasons.includes('paying-account-not-observed') &&
    gap.reasons.every((r) =>
      ['paid-unavailable', 'paying-account-not-observed', 'paying-side-coverage-incomplete'].includes(r)
    ) &&
    ['cardMinimum', 'cardSpent', 'cardTarget'].every(
      (k) => numeric(prior.amounts[k]) && prior.amounts[k] === gap.amounts[k]
    ) &&
    ['cardPaid', 'cardRemainder'].every((k) => numeric(prior.amounts[k]))
  ) {
    exercised.add('last-known');
    const expectedStamp = prior.cardObservedAt || date(prior.sourceDay) + 'T18:00:00.000Z';
    for (const field of ['cardPaid', 'cardTarget', 'cardRemainder']) {
      if (
        v.amounts[field] !== prior.amounts[field] ||
        v.trust[field] !== 'estimated' ||
        v.cardObservedAt !== expectedStamp
      )
        finding(
          'last-known/thin-payer',
          field,
          [prior.amounts[field], 'estimated', expectedStamp],
          [v.amounts[field], v.trust[field], v.cardObservedAt],
          fault,
          'last-known'
        );
    }
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
  const datedActions =
    v.retained && prior?.sourceDay === v.sourceDay && JSON.stringify(v.moves) === JSON.stringify(prior.moves);
  if ((v.unresolved || unresolvedEvidence) && v.moves.length && !datedActions)
    finding('advice/unresolved', 'current money-move instructions', [], v.moves, fault || 'mixed', 'no-move');
  return { failures, exercised: [...exercised] };
}
module.exports = { inspect, checks, known };
