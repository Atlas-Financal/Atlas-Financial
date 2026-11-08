'use strict';
/* Trajectory weakest-link trust combiner fails closed (owner 2026-11-08).
 *
 * trajectoryWeakerStatus accepts exactly 'calculated', 'estimated' and
 * 'unavailable'. Any other input (unknown, undefined, blank, an
 * unrecognised word) yields 'unavailable' — never 'calculated'. The
 * expected words below are written by hand from that rule, not read back
 * from the function under test.
 *
 * The probe loads the real public/forecast.js in a sandbox and exposes the
 * two internal functions, so this exercises the shipped code.
 * `node test/test-trajectory-trust-fails-closed.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'forecast.js'), 'utf8');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const ANCHOR = '  const Forecast = {';
ok(SRC.split(ANCHOR).length === 2, 'probe anchor is present exactly once');
const probed = SRC.replace(ANCHOR,
  '  root.__trustProbe = { trajectoryWeakerStatus, trajectoryMergedComponent };\n' + ANCHOR);
const sandbox = { module: { exports: {} }, console };
sandbox.require = name => require(name.startsWith('.') ? path.join(ROOT, 'public', name) : name);
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(probed, sandbox, { filename: 'forecast.js' });
const probe = sandbox.__trustProbe || (sandbox.module.exports && null);
ok(probe && typeof probe.trajectoryWeakerStatus === 'function', 'probe reached the shipped combiner');
const weaker = probe.trajectoryWeakerStatus;
const merged = probe.trajectoryMergedComponent;

console.log('\n— Unit: trajectoryWeakerStatus');
const cases = [
  [['calculated', 'unknown'], 'unavailable'],
  [['calculated', undefined], 'unavailable'],
  [['calculated', null], 'unavailable'],
  [['calculated', ''], 'unavailable'],
  [['calculated', 'verified'], 'unavailable'],
  [['estimated', 'guessed'], 'unavailable'],
  [['calculated', 'estimated'], 'estimated'],
  [['calculated', 'calculated'], 'calculated'],
  [['estimated', 'unavailable'], 'unavailable'],
  [['calculated'], 'calculated'],
  [['estimated'], 'estimated'],
  [[], 'calculated'],
];
for (const [args, want] of cases) {
  const got = weaker.apply(null, args);
  ok(got === want, `(${args.map(a => JSON.stringify(a)).join(', ')}) → ${want}`, got === want ? '' : 'got ' + got);
}

console.log('\n— Trajectory: a month stage merged from pay-period stages');
// A Road Ahead month stage is the weakest of its pay-period parts.
const good = [
  { amount: 100, status: 'calculated' },
  { amount: 50, status: 'estimated' },
];
const legit = merged(good, 'month');
ok(legit.status === 'estimated' && legit.amount === 150,
  'legitimate parts keep today\'s word and amount', JSON.stringify(legit));
const withUnknown = merged([{ amount: 100, status: 'calculated' }, { amount: 50, status: 'unknown' }], 'month');
ok(withUnknown.status === 'unavailable' && !('amount' in withUnknown),
  'a stage input carrying unknown publishes the stage as unavailable, with no amount', JSON.stringify(withUnknown));
const withMissing = merged([{ amount: 100, status: 'calculated' }, { amount: 50 }], 'month');
ok(withMissing.status === 'unavailable' && !('amount' in withMissing),
  'a stage input with no trust word publishes the stage as unavailable', JSON.stringify(withMissing));
const lineNoWord = merged([{ amount: 100, status: 'calculated',
  lines: [{ id: 'x', label: 'X', amount: 100 }] }], 'month');
ok(lineNoWord.lines && lineNoWord.lines[0].status === 'unavailable',
  'a funding line with no trust word is unavailable, not defaulted to calculated',
  JSON.stringify(lineNoWord.lines));
const lineOk = merged([{ amount: 100, status: 'calculated',
  lines: [{ id: 'x', label: 'X', amount: 60, status: 'calculated' }, { id: 'x', label: 'X', amount: 40, status: 'estimated' }] }], 'month');
ok(lineOk.lines && lineOk.lines[0].status === 'estimated',
  'merged funding lines with real words keep the weaker real word', JSON.stringify(lineOk.lines));

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'All trajectory trust fail-closed checks pass.'}`);
process.exit(failures ? 1 : 0);
