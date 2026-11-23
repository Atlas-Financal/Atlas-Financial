'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../public/forecast.js'), 'utf8');
let checks = 0, parseCalls = 0;
const maps = [];
class ObservedMap extends Map { constructor(...args) { super(...args); maps.push(this); } }
class ObservedDate extends Date { static parse(value) { parseCalls++; return Date.parse(value); } }
// Expose the private validator in this VM only; production exports stay intact.
const anchor = 'return { resolveOccurrences, mappedDate, originalDate, state, ownedDebits, statementRows };';
assert.equal(source.split(anchor).length, 2);
const exportAnchor = 'const Forecast = {';
assert.equal(source.split(exportAnchor).length, 2, 'private test hook has one export object target');
const testSource = source.replace(anchor, 'return { resolveOccurrences, mappedDate, originalDate, state, ownedDebits, statementRows, date };')
  .replace(exportAnchor, exportAnchor + ' privateDate: CardMinimumContract.date,');
const context = { module: { exports: {} }, Date: ObservedDate, Map: ObservedMap };
vm.runInNewContext(testSource, context, { filename: 'forecast-date-test.js' });
const date = context.module.exports.privateDate;
assert.equal(typeof date, 'function', 'private validator was actually exposed in this VM'); checks++;
assert.equal(maps.length, 1); checks++;
const cache = maps[0];
// Gregorian arithmetic is independent of the incumbent Date.parse/round-trip predicate.
function calendar(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month >= 1 && month <= 12 && day >= 1
    && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function check(value) { assert.equal(date(value), calendar(value)); assert(cache.size <= 256); checks += 2; }
for (const year of [0, 1, 99, 1900, 1999, 2000, 2024, 2026, 2100, 9999]) {
  for (let month = 0; month <= 13; month++) for (let day = 0; day <= 33; day++) {
    check(String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0'));
  }
}
let conversions = 0;
const hostile = { toString() { conversions++; throw new Error('must not coerce'); } };
const malformed = [null, undefined, 0, NaN, Infinity, true, {}, [], new String('2026-10-07'), hostile,
  new Proxy({}, { get() { throw new Error('must not inspect object'); } }), () => {}, Symbol('date'), 1n,
  '', '2026-2-03', '2026-02-30', '2026-10-07T00:00:00Z', ' 2026-10-07', '2026-10-07 ',
  '2026-10-07\n', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'toString__', 'x'.repeat(10000)];
for (const value of malformed) check(value);
assert.equal(conversions, 0); checks++;
cache.clear();
for (const value of ['2024-02-29', '1900-02-29', 'toString__']) {
  check(value); const calls = parseCalls;
  for (let i = 0; i < 100; i++) check(value);
  assert.equal(parseCalls, calls, 'true and false cached values must be hits'); checks++;
}
cache.clear(); check('2024-02-29');
for (let i = 0; i < 256; i++) check('bad' + String(i).padStart(7, '0'));
assert.equal(cache.size, 256); assert.equal(cache.has('2024-02-29'), false); checks += 2;
const calls = parseCalls; check('2024-02-29');
assert.equal(parseCalls, calls + 1, 'eviction revalidates the original predicate'); checks++;
assert.equal(cache.size, 256); checks++;
const size = cache.size;
for (let i = 0; i < 100; i++) check('oversize-invalid-key-' + i);
assert.equal(cache.size, size, 'oversize input does not consume cache entries'); checks++;
if (!process.argv.includes('--calendar-only')) {
  const safe = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) if (process.env[key]) safe[key] = process.env[key];
  for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    const result = spawnSync(process.execPath, [__filename, '--calendar-only'], { env: { ...safe, TZ: zone }, encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, zone + ': ' + result.stderr); checks++;
  }
}
console.log('PASS card minimum date cache: ' + checks + ' independent calendar, malformed-type, inherited-key, false-hit, eviction, bound and timezone checks');
