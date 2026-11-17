'use strict';
/* A provider balance that is blank, false or non-numeric is unknown, never $0.
 *
 * Invented values only. Before this fix `firstNumber` returned Number(value)
 * for any present value, so `false` and a whitespace string became 0 and a
 * non-numeric string became NaN; both passed the `!= null` gates and reached
 * reconciliation as balance evidence. The oracle here is the raw input itself:
 * a value that is not a finite number or a numeric string carries no amount,
 * so no observation may carry an amount for it.
 *
 * `node test/test-provider-balance-unknown-not-zero.js`
 */
const fs = require('fs');
const path = require('path');
const O = require('../scripts/provider-observe.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const ROOT = path.join(__dirname, '..');
const clone = x => JSON.parse(JSON.stringify(x));
const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'lunchmoney-sample.json'), 'utf8'));
const accountMap = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'provider-account-map.json'), 'utf8'));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));

const BAD = [
  ['false', false],
  ['true', true],
  ['empty string', ''],
  ['whitespace string', '   '],
  ['non-numeric string', 'n/a'],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['object', {}],
  ['array', []],
];
const norm = raw => O.normalizeLunchMoneyAccount(Object.assign({ id: 1, name: 'Synthetic', type: 'credit' }, raw));

console.log('=== 1. normalization: a bad balance, available or limit is null ===');
for (const [label, value] of BAD) {
  const acc = norm({ balance: value, available_balance: value, credit_limit: value });
  ok(acc.balance === null && acc.available === null && acc.limit === null,
    `${label} → balance, available and limit are unknown (null)`, JSON.stringify([acc.balance, acc.available, acc.limit]));
}

console.log('\n=== 2. normalization: real amounts are unchanged ===');
{
  const acc = norm({ balance: '1234.5600', available_balance: 0, credit_limit: -50.25 });
  ok(acc.balance === 1234.56 && acc.available === 0 && acc.limit === -50.25,
    'numeric string, a real 0 and a negative number keep their value', JSON.stringify([acc.balance, acc.available, acc.limit]));
  const zeroStr = norm({ balance: '0' });
  ok(zeroStr.balance === 0, 'the string "0" is a real zero');
  const absent = norm({});
  ok(absent.balance === null && absent.available === null && absent.limit === null, 'absent fields stay null');
  const alias = norm({ available: '12.50' });
  ok(alias.available === 12.5, 'the legacy available alias is read when available_balance is absent');
  const badFirst = norm({ available_balance: 'n/a', available: '12.50' });
  ok(badFirst.available === null, 'a present but malformed first field is unknown; it does not borrow the alias');
}

console.log('\n=== 3. observation: no amount is published for a bad balance ===');
for (const [label, value] of BAD) {
  const bad = clone(payload);
  bad.accounts = bad.accounts.map(a => (a.id === 1001 || a.id === 2001)
    ? Object.assign({}, a, { balance: value, available_balance: value, credit_limit: value }) : a);
  const report = O.observe({ provider: 'lunchmoney', payload: bad, accountMap, data });
  const amounts = report.observations.filter(o => o.providerAccountId === '1001' || o.providerAccountId === '2001');
  ok(amounts.length === 0, `${label}: the cash and card accounts publish no balance evidence (no $0, no NaN)`,
    JSON.stringify(amounts.map(o => [o.observationId, o.evidenceValue])));
}

console.log('\n=== 4. observation: the untouched fixture still observes both accounts ===');
{
  const report = O.observe({ provider: 'lunchmoney', payload, accountMap, data });
  const cash = report.observations.find(o => o.observationId === 'lm-1001-cash');
  const card = report.observations.find(o => o.observationId === 'lm-2001-debt');
  const zero = report.observations.find(o => o.observationId === 'lm-1002-cash');
  ok(cash && cash.evidenceValue === 79.84, 'cash balance observed');
  ok(card && card.evidenceValue === 4500.11, 'card balance observed');
  ok(zero && zero.evidenceValue === 0, 'a provider-reported numeric 0 is still a real 0');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
