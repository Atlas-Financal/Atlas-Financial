'use strict';
/* N1 — an old cash balance must not get today's evidence date.
 *
 * Invented balances only. A household-cash account that carries the v2 semantic
 * balance_last_update is dated by that field alone: not by the object update
 * time and not by the request time. An invalid or null v2 date is unknown
 * (fail closed). Credit and Savings dating, and accounts that do not carry the
 * field, keep their incumbent behaviour.
 *
 * `node test/test-cash-balance-evidence-date.js`
 */
const P = require('../scripts/provider-observe.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const FETCHED = '2026-08-20T15:00:00Z';
const CASH = { atlasRole: 'household-cash', canonical: { collection: 'cash', id: 'chequing-a' } };
const SAVINGS = { atlasRole: 'household-cash', canonical: { collection: 'cash', id: 'savings' } };
const CREDIT = { atlasRole: 'revolving-credit', canonical: { collection: 'debts', id: 'synthetic-card' } };
const observe = (raw, mapping) => P.observationsFromMappedAccount(
  P.normalizeLunchMoneyAccount({ id: 1, name: 'Synthetic', balance: '100.00', ...raw }), mapping || CASH, FETCHED);
const first = (raw, mapping) => observe(raw, mapping)[0];

console.log('=== 1. semantic balance date wins over update and fetch time ===');
{
  const row = first({ balance_last_update: '2026-08-17T10:00:00Z', updated_at: '2026-08-20T09:00:00Z' });
  ok(row.evidenceDate === '2026-08-17' && row.observedAsOf === '2026-08-17' && !row.unknown,
    'balance dated Aug 17, object updated and fetched Aug 20, dates Aug 17', JSON.stringify([row.evidenceDate, row.unknown]));
  const only = first({ balance_last_update: '2026-08-17' });
  ok(only.evidenceDate === '2026-08-17' && !only.unknown, 'a balance date with no other timestamp dates Aug 17, not the fetch day');
  const sav = first({ balance_last_update: '2026-08-17', updated_at: '2026-08-20T09:00:00Z' }, SAVINGS);
  ok(sav.evidenceDate === '2026-08-17', 'the Savings cash identity uses the same semantic date');
}

console.log('\n=== 2. unsupported dating is unknown, never the fetch day ===');
{
  for (const [label, raw] of [
    ['null v2 date', { balance_last_update: null, updated_at: '2026-08-20T09:00:00Z' }],
    ['malformed v2 date', { balance_last_update: 'garbage', updated_at: '2026-08-20T09:00:00Z' }],
    ['impossible calendar date', { balance_last_update: '2026-02-30', updated_at: '2026-08-20T09:00:00Z' }],
  ]) {
    const row = first(raw);
    ok(row.unknown === true && row.evidenceDate === null, `${label} withholds the evidence`, JSON.stringify([row.evidenceDate, row.unknown]));
  }
  const future = first({ balance_last_update: '2026-08-25' });
  ok(future.unknown === true, 'a balance dated after the request day is unqualified (unknown)');
}

console.log('\n=== 3. unchanged behaviour ===');
{
  const legacy = first({ updated_at: '2026-08-19T09:00:00Z' });
  ok(legacy.evidenceDate === '2026-08-19' && !legacy.unknown,
    'an account without the v2 field keeps incumbent object-update dating');
  const credit = first({ balance_last_update: '2026-08-17', updated_at: '2026-08-20T09:00:00Z' }, CREDIT);
  ok(credit.evidenceDate === '2026-08-17', 'credit dating is unchanged');
  const creditBad = first({ balance_last_update: null, updated_at: '2026-08-20T09:00:00Z' }, CREDIT);
  ok(creditBad.unknown === true && creditBad.evidenceDate === null, 'credit with a null v2 date stays unknown');
  ok(P.genericAccountEvidenceInstant(P.normalizeLunchMoneyAccount({ id: 1, updated_at: '2026-08-20T09:00:00Z',
    balance_last_update: '2026-08-17' })) === '2026-08-20T09:00:00Z',
    'genericAccountEvidenceInstant itself is unchanged (still used for mortgage and HELOC)');
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'ALL CHECKS PASSED'));
process.exit(failures === 0 ? 0 : 1);
