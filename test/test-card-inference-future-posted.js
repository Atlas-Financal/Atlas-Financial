'use strict';
/* The diagnostic card inference never uses a posted card balance the observer
 * marked unknown (dated after the request day). Invented fixture values only.
 * Before this fix the inference read that balance as posted evidence (#924).
 *
 * `node test/test-card-inference-future-posted.js`
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

const run = mutate => {
  const p = clone(payload);
  if (mutate) mutate(p.accounts.find(a => a.id === 2001), p);
  const report = O.observe({ provider: 'lunchmoney', payload: p, accountMap, data });
  return {
    report,
    posted: report.observations.find(o => o.observationId === 'lm-2001-debt'),
    inference: (report.cardInferences || []).find(c => c.cardId === 'tdcc'),
  };
};
const dayAfter = iso => new Date(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') + 2 * 86400000).toISOString();

console.log('=== control: a posted card balance dated on or before the request day ===');
{
  const { posted, inference } = run();
  ok(posted && !posted.unknown, 'the posted-balance observation is usable');
  ok(inference && inference.posted === posted.evidenceValue, 'the inference reads that posted balance',
    JSON.stringify(inference && [inference.posted, inference.unknown]));
}

console.log('\n=== a posted card balance dated after the request day ===');
{
  const { posted, inference } = run((acc, p) => {
    acc.balance_as_of = dayAfter(p.fetchedAt);
    delete acc.balance_last_update;
  });
  ok(posted && posted.unknown === true, 'precondition: the observer marks the posted balance unknown',
    JSON.stringify(posted && [posted.evidenceDate, posted.unknown]));
  ok(inference && inference.posted === null && inference.exposure === null && inference.overLimit === null
      && inference.unknown === true,
    'the inference does not use it: posted, exposure and over-limit are unknown',
    JSON.stringify(inference));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
