'use strict';
// H2-1b (Gemini hunt 2, #821 7091517953): a payroll credit that posts one business day early (the Thursday before a
// Friday holiday) is held To confirm (H2-1a, by design) and attached to its occurrence as an early-receipt leg. The
// period close already reads that leg as inside the opening. The current savings planning basis
// (currentSavingsPlanningBasis) counted the same occurrence as still unreceived, so the boundary credit added it
// again: the next opening, its sweep and the savings schedule each carried one paycheque twice.
// `node test/test-early-payroll-leg-counted-once.js`
//
// Failure it detects: identical bank cash producing different next-period openings, sweeps or savings-schedule
// totals solely because the paycheque posted a day early; the To confirm hold being lifted. Release decision: any
// failure blocks.
//
// Invented input (the hunt's repro, invented payee and ids): biweekly 1000 payroll anchored 2026-09-18, opening
// 2026-09-17 with Bills 500, Weekly 0, Savings 500, viewed 2026-10-06 through the real observer
// (Live.fromObservation) and Forecast.recommend. Hand arithmetic: on 2026-10-06 Bills holds 2500 (500 + two
// paycheques) and Savings 500, so the household total is 3000; P3 and P4 each add 1000, so the savings schedule's
// total at P4's close is 5000, with P3 opening at 1500 after the 1000 boundary sweep.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
let checks = 0;
function ok(condition, label, detail) {
  assert.ok(condition, label + (detail ? ' — ' + detail : ''));
  checks++; console.log('  PASS  ' + label);
}
function run(pay2Date, { bills = 2500, pending = false, account = 3001, amount = 1000 } = {}) {
  const pay1 = { id: 9101, account_id: 3001, date: '2026-09-18', amount: -1000, payee: 'INVENTED PAYROLL CO', category_name: 'Income', is_income: true, is_pending: false, status: 'reviewed', currency: 'cad', notes: null };
  const pay2 = pay2Date && { id: 9102, account_id: account, date: pay2Date, amount: -amount, payee: 'INVENTED PAYROLL CO', category_name: 'Income', is_income: true, is_pending: pending, status: 'reviewed', currency: 'cad', notes: null };
  const obs = Live.fromObservation({
    asOf: '2026-10-06',
    data: {
      meta: { asOf: '2026-09-17' },
      debts: [],
      plan: {
        opening: { asOf: '2026-09-17' },
        startingCash: {
          asOf: '2026-09-17',
          breakdown: [
            { id: 'chequing-a', label: 'Bills', value: 500 },
            { id: 'chequing-b', label: 'Weekly', value: 0 },
            { id: 'savings', label: 'Savings', value: 500 },
          ],
          heldElsewhere: [{ id: 'savings-dont-touch', value: 0, class: 'purpose-reserve' }],
        },
        savingsEarmarks: {
          version: 1, currency: 'CAD',
          history: [{ revision: 1, confirmedAt: '2026-09-01', source: 'Invented', pools: [{ poolId: 'pool', allocations: [] }, { poolId: 'res', allocations: [] }] }],
          allocationPolicy: { order: 'due-date-first-combined-pool', effectiveFrom: '2026-09-01', source: 'Invented' },
          pools: [
            { id: 'pool', accountId: 'savings', label: 'Pool', role: 'purpose-reserve', purpose: 'Goals', goalRefs: [] },
            { id: 'res', accountId: 'savings-dont-touch', label: 'Res', role: 'purpose-reserve', purpose: 'Res', reconciledOn: '2026-10-06', goalRefs: [] },
          ],
        },
        savingsPoolObservation: {
          asOf: '2026-10-06',
          accounts: [
            { accountId: 'savings', value: 500, currency: 'CAD', source: 'provider-observe:lunchmoney', evidenceDate: '2026-10-06', pendingState: 'clear' },
            { accountId: 'savings-dont-touch', value: 0, currency: 'CAD', source: 'provider-observe:lunchmoney', evidenceDate: '2026-10-06', pendingState: 'clear' },
          ],
        },
        income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: '2026-09-18', amount: 1000, confidence: 'confirmed', depositAccount: 'chequing-a' }],
        obligations: [], bills: [], commitments: [], budget: { categories: [] },
      },
    },
    accountMap: {
      version: 1, provider: 'lunchmoney',
      mappings: [
        { providerAccountId: '3001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
        { providerAccountId: '3002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
        { providerAccountId: '3003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-reserve' },
        { providerAccountId: '3006', canonical: { collection: 'cash', id: 'savings-dont-touch' }, atlasRole: 'household-reserve' },
      ],
    },
    identity: {
      version: 1,
      rules: [{ eventId: 'payroll', atlasAccountId: 'chequing-a', direction: 'credit', requiredCurrency: 'cad', requiredPostingEvidence: 'posted', payeePatterns: ['INVENTED PAYROLL'] }],
    },
    payload: {
      provider: 'lunchmoney', fetchedAt: '2026-10-06T18:00:00Z',
      pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, startDate: null, endDate: null },
      transactionWindow: { startDate: '2026-09-17', endDate: '2026-10-06', complete: true, hasMore: false, truncated: false },
      accounts: [
        { id: 3001, name: 'Bills', type: 'cash', subtype: 'checking', currency: 'cad', balance: bills, updated_at: '2026-10-06T17:00:00Z', balance_last_update: '2026-10-06T17:00:00Z' },
        { id: 3002, name: 'Weekly', type: 'cash', subtype: 'checking', currency: 'cad', balance: 0, updated_at: '2026-10-06T17:00:00Z', balance_last_update: '2026-10-06T17:00:00Z' },
        { id: 3003, name: 'Savings', type: 'cash', subtype: 'savings', currency: 'cad', balance: 500, updated_at: '2026-10-06T17:00:00Z', balance_last_update: '2026-10-06T17:00:00Z' },
        { id: 3006, name: 'Reserve', type: 'cash', subtype: 'savings', currency: 'cad', balance: 0, updated_at: '2026-10-06T17:00:00Z', balance_last_update: '2026-10-06T17:00:00Z' },
      ],
      transactions: [pay1, ...(pay2 ? [pay2] : [])],
    },
  });
  const a = F.recommend(obs.data.plan, '2026-10-06', { debts: [], currentPeriodActuals: obs.data.liveOverlay.currentPeriodActuals, weeklyVariable: 0 });
  const p2 = a.payPeriodViews.find(v => v.start === '2026-10-02');
  const p3 = a.payPeriodViews.find(v => v.start === '2026-10-16');
  const closing = s => F.savingsFundingPublication(a.savingsFunding, { asOf: '2026-10-06', advice: a, periodId: a.savingsFunding.periodViews.find(v => v.start === s).id }).forecastClosing;
  const c3 = closing('2026-10-16'), c4 = closing('2026-10-30');
  return { p2DepositStatus: p2.income[0].depositStatus || 'ok', p2SurplusTrust: p2.stackSummary.surplus.trust, p3Opening: p3.opening, p3Sweep: p3.paydaySweep, c3Stock: c3.stock, c3OpCash: c3.operatingCash, c4Stock: c4.stock, c4Total: c4.stock + c4.operatingCash };
}

const pick = r => [r.p3Opening, r.p3Sweep, r.c3Stock, r.c3OpCash, r.c4Stock, r.c4Total];
const show = r => JSON.stringify(pick(r));

console.log('1. The early Thursday paycheque is counted once');
const early = run('2026-10-01'), onTime = run('2026-10-02'), late = run('2026-10-05');
ok(JSON.stringify(pick(onTime)) === JSON.stringify([1500, 2500, 1500, 2500, 4000, 5000]),
  'control: the on-time Friday paycheque reads the hand-derived chain (opening 1500, sweep 2500, P4 total 5000)', show(onTime));
ok(JSON.stringify(pick(early)) === JSON.stringify(pick(onTime)),
  'the early Thursday paycheque gives the same next opening, sweep and savings schedule as on time', show(early));
ok(JSON.stringify(pick(late)) === JSON.stringify(pick(onTime)), 'control: a late Monday paycheque is unchanged', show(late));

console.log('2. The To confirm hold (H2-1a) is unchanged');
ok(early.p2DepositStatus === 'to-confirm' && early.p2SurplusTrust === 'estimated',
  'the early credit is still held To confirm, and the Surplus is still estimated', JSON.stringify([early.p2DepositStatus, early.p2SurplusTrust]));
ok(onTime.p2DepositStatus === 'ok' && onTime.p2SurplusTrust === 'calculated', 'control: on time stays confirmed and calculated');

console.log('3. Controls: cash the leg does not prove is still counted as unreceived');
{
  // No second paycheque at all: Bills holds 1500, so P2's 1000 is genuinely still to come and is added once.
  const none = run(null, { bills: 1500 });
  ok(none.c4Total === 5000 && none.p3Opening === 1500,
    'a paycheque not yet received is still expected once (P4 total 5000, P3 opening 1500)', show(none));
  // An early credit still pending is not in posted Bills (1500), so its leg proves nothing inside the stock. The
  // chain is withheld exactly as on main (fail closed), never counted twice and never taken as received.
  const pend = run('2026-10-01', { bills: 1500, pending: true });
  ok(pick(pend).every(v => !Number.isFinite(v)) && pend.p2DepositStatus === 'to-confirm',
    'an early credit still pending leaves the chain withheld (unchanged from main), never doubled', show(pend) + ' ' + pend.p2DepositStatus);
}

console.log(`early payroll leg counted once: ${checks} checks passed`);
