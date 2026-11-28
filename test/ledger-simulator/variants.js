'use strict';

// Variants of the twenty pre-mortem habits that change the evidence (not just
// the purchase price). All amounts and names are local to this household.
const { date, offset, account } = require('./household');
module.exports = function variants(register) {
  register(
    'card-pending-posted-receipt card-return card-reversal manual-payment noted-equal-payments competing-minimum minimum-paid-early',
    0.007,
    (b, n) => {
      if (n === 'competing-minimum') {
        b.out('bills', b.t.min, 'Payment, Transfer', { payee: 'INTERAC E-TRANSFER SENT' });
        b.move('weekly', 'card', b.t.min);
        return;
      }
      if (n === 'manual-payment') {
        b.out('bills', b.amount, 'Credit Card Payment', { payee: 'Invented manual issuer' });
        return;
      }
      if (n === 'card-return' || n === 'card-reversal') {
        b.purchase('card', b.amount, 'Groceries');
        b.out('card', -b.amount, 'Groceries', {
          at: 2,
          payee: n === 'card-return' ? 'Invented market refund' : 'PAYMENT REVERSAL',
        });
        return;
      }
      b.move('bills', 'card', n === 'minimum-paid-early' ? b.t.min : b.amount, {
        noted: n !== 'card-pending-posted-receipt',
      });
      if (n === 'noted-equal-payments') b.move('weekly', 'card', b.amount, { at: 1, noted: true });
      if (n === 'card-pending-posted-receipt')
        b.row('card', -b.amount, 'Payment, Transfer', {
          at: -1,
          pending: true,
          payee: 'PAYMENT - THANK YOU',
        });
    },
    (d, n) => n !== 'minimum-paid-early' || date(d).endsWith('-03')
  );
  register(
    'topup-one-only topup-next-date topup-studio topup-no-reference topup-reversed parked-purchase',
    0.008,
    (b, n) => {
      if (n === 'parked-purchase') {
        b.move('pool', 'bills', b.amount);
        b.purchase('bills', b.amount, 'Groceries', { at: 1 });
        return;
      }
      b.move(
        n === 'topup-reversed' ? 'weekly' : 'bills',
        n === 'topup-studio' ? 'studio' : n === 'topup-reversed' ? 'bills' : 'weekly',
        b.amount,
        {
          lag: n === 'topup-one-only' ? 9 : 0,
          receiptAt: n === 'topup-next-date' ? 1 : 0,
          ref: n === 'topup-no-reference' ? 'NO REFERENCE' : undefined,
        }
      );
    }
  );
  register(
    'salary-lookalike salary-transit e-transfer-gift bill-recurring-id bill-no-rule bill-full-refund',
    0.009,
    (b, n) => {
      if (n.startsWith('salary')) {
        if (n === 'salary-transit') b.move('studio', 'bills', b.t.pay - 113);
        else b.out('bills', -Math.round(b.t.pay * 0.63), 'Income', { payee: 'Invented unscheduled deposit' });
        b.configure((w) => {
          w.income.push({
            id: 'amandaSalary15',
            label: 'Invented monthly salary',
            frequency: 'monthly',
            day: 15,
            amount: b.t.pay / 100,
            confidence: 'confirmed',
          });
          w.identityRules.push({
            eventId: 'amandaSalary15',
            transactionKind: 'transfer',
            counterpartExternalId: 'sim-studio',
            atlasAccountId: 'chequing-a',
            direction: 'credit',
            salaryReceiptPayeePatterns: ['Invented studio payroll'],
          });
        });
        return;
      }
      if (n === 'e-transfer-gift') {
        b.out('bills', -b.amount, 'Gifts', { payee: 'INTERAC E-TRANSFER RECEIVED' });
        return;
      }
      if (n === 'bill-no-rule')
        b.configure((w) => {
          delete w.bills[0].payee;
        });
      b.out('weekly', b.t.bill, 'Utilities', {
        payee: 'Invented kiln',
        raw: n === 'bill-recurring-id' ? { recurring_id: 97231 } : {},
      });
      if (n === 'bill-recurring-id')
        b.configure((w) => {
          w.bills[0].rule = { lunchMoneyRecurringIds: ['97231'] };
        });
      if (n === 'bill-full-refund')
        b.out('weekly', -b.t.bill, 'Utilities', { at: 2, payee: 'Invented kiln refund' });
    },
    (d, n) => !n.startsWith('salary') || Number(date(d).slice(-2)) === 10
  );
  register(
    'savings-same-goal-tags savings-recreated-tag savings-old-year savings-unlinked-other-payee savings-refund-cross-period savings-bill-untagged savings-group-goal',
    0.006,
    (b, n) => {
      if (n === 'savings-bill-untagged') {
        b.out('bills', b.amount, 'Utilities', { payee: 'Invented annual kiln' });
      } else
        b.purchase('weekly', b.amount, 'Household', {
          tags:
            n === 'savings-same-goal-tags' ? [72101, 72103] : [n === 'savings-recreated-tag' ? 72103 : 72101],
          payee: 'PAYPAL *INVENTED WORKSHOP',
        });
      if (n === 'savings-unlinked-other-payee' || n === 'savings-refund-cross-period')
        b.out('weekly', -b.amount, 'Household', {
          at: n === 'savings-refund-cross-period' ? 15 : 1,
          tags: n === 'savings-refund-cross-period' ? [72101] : [],
          payee: 'Invented clearing house',
        });
      b.configure((w) => {
        if (n === 'savings-same-goal-tags') w.links.push({ ...w.links[0], tagId: 72103 });
        if (n === 'savings-group-goal') {
          w.groups = [{ id: 'invented-group', label: 'Invented shared items', members: ['kite', 'loom'] }];
          w.links[0].goalRef = { kind: 'group', id: 'invented-group' };
        }
        if (n === 'savings-bill-untagged' || n === 'savings-old-year') {
          const occurrence = date(b.start);
          w.bills.push({
            id: 'annual-kiln',
            label: 'Invented annual kiln',
            payee: 'Invented annual kiln',
            amount: b.amount / 100,
            frequency: 'yearly',
            month: Number(occurrence.slice(5, 7)),
            day: Number(occurrence.slice(-2)),
            jointCash: true,
            confidence: 'confirmed',
          });
          const annual = { kind: 'yearly-bill', id: 'annual-kiln' };
          w.links[0] = { ...w.links[0], goalRef: annual, occurrenceDate: occurrence };
          const original = w.planPatch;
          w.planPatch = (plan) => {
            original(plan);
            plan.savingsEarmarks.pools[0].goalRefs.push(annual);
          };
          if (n === 'savings-old-year')
            w.links.push({
              ...w.links[0],
              occurrenceDate: date(offset(occurrence) - 365),
              effectiveFrom: date(-365),
            });
        }
      });
    }
  );
  register(
    'shopping-one-person shopping-two-people cash-pending-same-id tagged-lookalike manual-over-limit new-period-refund',
    0.009,
    (b, n) => {
      if (n === 'cash-pending-same-id') {
        b.pending('weekly', b.amount, b.amount, 'Groceries', { lag: 1, sameId: true });
        return;
      }
      if (n === 'manual-over-limit') {
        b.configure((w) => {
          const d = w.debts.find((x) => x.id === account.manual);
          d.balance = d.limit + 148.59;
          d.evidenceDate = date(-25);
        });
        return;
      }
      if (n === 'new-period-refund') {
        b.purchase('weekly', b.amount, 'Groceries');
        b.out('weekly', -b.amount, 'Groceries', { at: 15, payee: 'Invented market refund' });
        return;
      }
      b.purchase('weekly', b.amount, 'Shopping', {
        notes:
          n === 'shopping-two-people' ? 'Indigo and Ochre' : n === 'shopping-one-person' ? 'Indigo' : null,
        tags: n === 'tagged-lookalike' ? [72103] : [],
      });
    }
  );
};
