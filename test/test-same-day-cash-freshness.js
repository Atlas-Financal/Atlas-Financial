'use strict';
/*
 * Hunt 5 findings 1, 3 and 5: live cash freshness is one rule.
 * 1. A same-day refresh with one required cash balance lagging (a transfer
 *    seen on one side only) is withheld, never published with a caution.
 * 3. A stale savings balance cannot move the schedule-trust household date
 *    and switch off the early-income check.
 * 5. Mortgage / HELOC are dated by their balance date, never updated_at.
 * Plus a period-close capture judged against its own closing day.
 * Invented values only; expected outcomes are stated by hand.
 */
const Live = require('../scripts/live-plan');
const O = require('../scripts/provider-observe');
const F = require('../public/forecast');
const base = require('./fixtures/card-backfill-data');
let failures = 0;
const ok = (c, m, d) => { console.log((c ? 'ok   ' : 'FAIL ') + m + (c || d === undefined ? '' : ' :: ' + JSON.stringify(d))); if (!c) failures++; };
const TODAY = '2026-09-20', YESTERDAY = '2026-09-19', OLD = '2026-09-05';
const attempt = fn => { try { return { value: fn() }; } catch (e) { return { error: e.message }; } };

function world({ bDate = TODAY, savingsDate = TODAY, opening = TODAY } = {}) {
  const x = base('invented-card', 'invented-min');
  x.data.meta.asOf = x.data.plan.opening.asOf = opening;
  x.data.plan.startingCash.breakdown[0].value = 100; x.data.plan.startingCash.breakdown[1].value = 500;
  x.data.plan.obligations = []; x.data.plan.budget.categories = []; x.data.plan.income[0].amount = 0; x.data.debts = [];
  x.accountMap.mappings = x.accountMap.mappings.slice(0, 3); x.payload.accounts = x.payload.accounts.slice(0, 3);
  x.payload.transactions = [];
  const [a, b, s] = x.payload.accounts;
  a.balance = 600; a.balance_last_update = a.updated_at = TODAY + 'T17:00:00Z';   // received 500 from b
  b.balance = bDate === TODAY ? 0 : 500; b.balance_last_update = b.updated_at = bDate + 'T17:00:00Z';
  s.balance = 0; s.balance_last_update = s.updated_at = savingsDate + 'T17:00:00Z';
  x.payload.fetchedAt = TODAY + 'T18:00:00Z';
  return x;
}

console.log('\n=== 1. same-day refresh: one lagging required balance is withheld ===');
{
  const lag = attempt(() => Live.fromObservation(world({ bDate: YESTERDAY })));
  ok(lag.error && /stale-live-cash-evidence: cash:chequing-b dated 2026-09-19/.test(lag.error),
    'a lagging chequing-b on a same-day refresh is withheld (no 500 counted twice)', lag.error || 'published');
  const fresh = attempt(() => Live.fromObservation(world()));
  ok(fresh.value && fresh.value.data.liveOverlay.applied === true
    && F.startingCashAmount(fresh.value.data.plan) === 600, 'control: all balances dated today overlay (600, not 1100)',
    fresh.error || (fresh.value && F.startingCashAmount(fresh.value.data.plan)));
  const advancing = attempt(() => Live.fromObservation(world({ bDate: YESTERDAY, opening: YESTERDAY })));
  ok(advancing.error && /stale-live-cash-evidence/.test(advancing.error), 'advancing refresh: unchanged (already withheld)');
}

console.log('\n=== 3. a stale savings balance does not move the household date ===');
{
  const obs = (id, date) => ({ canonical: { collection: 'cash', id }, evidenceValue: 1, evidenceDate: date });
  const observations = [obs('chequing-a', TODAY), obs('chequing-b', TODAY), obs('savings', '2026-09-17')];
  ok(O.householdDateFromProviderEvidence(observations, null) === '2026-09-17',
    'savings required (no plan / earmarks not set up): its date counts, so the refresh is withheld by the freshness gate');
  const setUp = { savingsEarmarks: {} };
  const earmarked = F.savingsEarmarksState(setUp, TODAY).status !== 'setup-unknown';
  if (earmarked) ok(O.householdDateFromProviderEvidence(observations, setUp) === TODAY,
    'savings not required (earmarks set up): a stale savings date cannot pull the household date back');
  const unknownRow = [obs('chequing-a', TODAY), { ...obs('chequing-b', '2026-09-10'), unknown: true }];
  ok(O.householdDateFromProviderEvidence(unknownRow, null) === TODAY, 'an unknown balance row does not date the household');
  const stale = attempt(() => Live.fromObservation(world({ savingsDate: '2026-09-17' })));
  ok(stale.error && /stale-live-cash-evidence: cash:savings/.test(stale.error), 'same-day refresh with stale required savings is withheld', stale.error || 'published');
}

console.log('\n=== 5. a loan is dated by its balance date, never updated_at ===');
{
  const loan = extra => O.loanBalanceEvidenceInstant(O.normalizeLunchMoneyAccount(Object.assign({ id: 1, type: 'loan' }, extra)));
  ok(loan({ updated_at: TODAY + 'T17:00:00Z', balance_last_update: OLD + 'T17:00:00Z' }) === OLD + 'T17:00:00Z',
    'HELOC touched today with a 15-day-old balance is dated by the balance');
  ok(loan({ updated_at: TODAY + 'T17:00:00Z', date_last_fetched: TODAY + 'T17:00:00Z' }) === null, 'no genuine balance date: undated (unknown)');
  const helocWorld = balanceDate => {
    const x = world();
    x.data.debts = [{ id: 'heloc', label: 'Invented HELOC', structure: 'Revolving', secured: true, balance: 900, rate: 0 }];
    x.accountMap.mappings.push({ providerAccountId: '3008', canonical: { collection: 'debts', id: 'heloc' }, atlasRole: 'heloc' });
    x.payload.accounts.push({ id: 3008, name: 'Invented heloc', type: 'loan', subtype: 'line_of_credit', institution_name: 'Invented',
      currency: 'cad', balance: 800, updated_at: TODAY + 'T17:00:00Z', balance_last_update: balanceDate + 'T17:00:00Z' });
    return Live.fromObservation(x);
  };
  const staleLoan = helocWorld(OLD);
  ok(staleLoan.data.debts[0].balance === 900 && !staleLoan.overlays.some(r => r.locator === 'debts:heloc'),
    'a stale HELOC balance does not overlay as current (900 stands)');
  const freshLoan = helocWorld(TODAY);
  ok(freshLoan.data.debts[0].balance === 800, 'control: a HELOC dated today overlays (800)');
}

console.log('\n=== closing capture: judged against its closing day ===');
{
  // Direct gate: a same-day report whose balances are dated the closing day passes for that close.
  const x = world({ bDate: YESTERDAY });
  const r = O.observe({ provider: 'lunchmoney', payload: x.payload, accountMap: x.accountMap, data: x.data,
    identity: { rules: [], billPaymentPayees: [] }, fetchedAt: x.payload.fetchedAt });
  ok(/stale-live-cash-evidence: cash:chequing-b/.test(attempt(() => Live.overlayLiveState({ data: x.data, report: r })).error || ''),
    'without a closing day, the lagging account is withheld');
  ok(!attempt(() => Live.overlayLiveState({ data: x.data, report: r, closingDay: YESTERDAY })).error,
    'a close of YESTERDAY accepts a balance dated its closing day');
  const y = world({ bDate: '2026-09-18' });
  const r2 = O.observe({ provider: 'lunchmoney', payload: y.payload, accountMap: y.accountMap, data: y.data,
    identity: { rules: [], billPaymentPayees: [] }, fetchedAt: y.payload.fetchedAt });
  ok(/stale-live-cash-evidence: cash:chequing-b dated 2026-09-18/.test(attempt(() => Live.overlayLiveState({ data: y.data, report: r2, closingDay: YESTERDAY })).error || ''),
    'a close of YESTERDAY still withholds an account dated the day before the close');
}
console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
