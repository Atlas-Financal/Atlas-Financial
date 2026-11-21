'use strict';
/* The figures page capture observes the Stack page (C1 S1; lead rulings 2026-11-21; BACKLOG "The figures page capture should
 * also observe the Stack page's reads").
 *
 * The capture runs the default Budget page by its default route. The real Stack shell reads its inputs there but cannot
 * draw on the capture's recording DOM, so the capture drives the page's own block renderers (waterfall, cards, credit,
 * sheet) once per published pay period over the context the real shell built (StackBlocks.context, read-only), and
 * records every Forecast read the Stack page makes. This proves, on invented inputs only:
 *
 *   1. the capture's location is the default route (no ?view=classic), frozen;
 *   2. it really ran the Stack page: status 'rendered', every block 'ok' for every published pay period, the periods
 *      are exactly those of the shell's own recommend result, and every sheet item the periods list opens;
 *   3. the Forecast reads recorded are the Stack page's: the shell's input builder and recommend at boot, then the Credit
 *      block's cardPeriodMovements and stackCreditLines once per period, every route in a public/stack-*.js file, none from
 *      the previous page;
 *   4. what is recorded is what Forecast returns for those arguments (an independent recomputation on the host realm);
 *   5. NON-VACUITY: on copies of public/ where the Stack page would not run, the capture says so and never reads
 *      'rendered': the shell's own routing turned off, its context seam removed, its input step failing, a block failing;
 *   6. driving the Stack page leaves the previous page's evidence byte for byte what it was (stack: false);
 *   7. the evidence keys: present, deterministic, digests only, and moved by a change in how the Stack page asks.
 * `node test/test-stack-page-capture.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PageCapture = require('../scripts/figures-page-capture');
const Snapshot = require('../scripts/figures-snapshot');
const Forecast = require('../public/forecast.js');

const root = path.join(__dirname, '..');
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const inputs = Snapshot.loadInventedInputs();
const input = id => { const found = inputs.find(i => i.id === id); assert.ok(found, 'invented input ' + id); return found; };
const capture = (id, rootDir, options) => PageCapture.capturePages(input(id).doc.data, input(id).doc.periods, rootDir, options);

console.log('1. the capture location');
{
  const loc = PageCapture.CAPTURE_LOCATION;
  ok(loc.pathname === '/' && loc.search === '' && new URL(loc.href).search === '' && !/classic/.test(JSON.stringify(loc)),
    'the capture runs the default route /, not ?view=classic', JSON.stringify(loc));
  ok(Object.isFrozen(loc), 'the location is frozen');
}

console.log('2. the Stack page really ran');
const IDS = ['savings-fully-backed', 'stack-card-summary', 'card-paid-clear'];
const caps = Object.fromEntries(IDS.map(id => [id, capture(id)]));
for (const id of IDS) {
  const cap = caps[id], stack = cap.stack;
  ok(stack && stack.status === 'rendered', `${id}: status rendered`, stack && stack.status);
  ok(stack.states.length > 0 && stack.states.every(s => ['waterfall', 'cards', 'credit', 'sheet'].every(b => s.blocks[b] === 'ok')),
    `${id}: every block ok for every pay period (${stack.states.length})`, JSON.stringify(stack.states.find(s => Object.values(s.blocks).some(v => v !== 'ok'))));
  const shell = cap.stackCalls.find(c => c.fn === 'recommend');
  const views = shell && shell.result && Array.isArray(shell.result.payPeriodViews) ? shell.result.payPeriodViews.filter(v => v && typeof v.start === 'string') : [];
  ok(views.length === stack.states.length && views.every((v, i) => stack.states[i].id === 'stack:' + v.start),
    `${id}: the driven periods are exactly the shell's own recommend result's, in order`, views.map(v => v.start).join(','));
  const sheets = stack.states.flatMap(s => Object.entries(s.sheets));
  ok(sheets.length > 0 && sheets.every(([, v]) => Array.isArray(v) && v.length === 2 && v[0] === v[1]),
    `${id}: every sheet item a period lists opens`, JSON.stringify(sheets.filter(([, v]) => !Array.isArray(v) || v[0] !== v[1])));
}

console.log('3. the Forecast reads recorded are the Stack page\'s');
for (const id of IDS) {
  const cap = caps[id], calls = cap.stackCalls, n = cap.stack.states.length;
  ok(calls.every(c => /^public\/stack-[\w-]+\.js#/.test(c.route)), `${id}: every call is routed from a public/stack-*.js file`, calls.find(c => !/^public\/stack-/.test(c.route)) && calls.find(c => !/^public\/stack-/.test(c.route)).route);
  const boot = calls.filter(c => c.state === 'boot').map(c => c.fn);
  ok(JSON.stringify(boot) === JSON.stringify(['budgetRecommendInputs', 'recommend']) && calls.filter(c => c.state === 'boot').every(c => /^public\/stack-shell\.js#/.test(c.route)),
    `${id}: at boot the shell builds the inputs, then recommends`, boot.join(','));
  const per = fn => calls.filter(c => c.fn === fn && c.state.startsWith('stack:'));
  ok(per('cardPeriodMovements').length === n && per('stackCreditLines').length === n && calls.length === 2 + 2 * n
    && per('cardPeriodMovements').every(c => /^public\/stack-credit\.js#/.test(c.route)),
  `${id}: one cardPeriodMovements and one stackCreditLines per period, from the Credit block (sheet reads share them)`, `${calls.length} calls, ${n} periods`);
  ok(calls.every(c => c.error === null), `${id}: no read threw`);
}

console.log('4. what is recorded is what Forecast returns for those arguments');
{
  const plain = v => JSON.parse(JSON.stringify(v === undefined ? null : v));
  const cap = caps['stack-card-summary'];
  const lines = cap.stackCalls.filter(c => c.fn === 'stackCreditLines');
  ok(lines.length > 0 && lines.every(c => JSON.stringify(plain(Forecast.stackCreditLines(...c.args))) === JSON.stringify(plain(c.result))),
    'every recorded stackCreditLines result equals the host Forecast\'s for the same arguments');
  const moves = cap.stackCalls.filter(c => c.fn === 'cardPeriodMovements');
  ok(moves.length > 0 && moves.every(c => JSON.stringify(plain(Forecast.cardPeriodMovements(...c.args))) === JSON.stringify(plain(c.result))),
    'every recorded cardPeriodMovements result equals the host Forecast\'s for the same arguments');
}

console.log('5. non-vacuity: where the Stack page would not run, the capture says so');
function copyRoot(edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-capture-'));
  fs.cpSync(path.join(root, 'public'), path.join(dir, 'public'), { recursive: true });
  for (const [file, [from, to]] of Object.entries(edit)) {
    const target = path.join(dir, 'public', file);
    const text = fs.readFileSync(target, 'utf8');
    assert.ok(text.includes(from), 'the copy carries the text to mutate in ' + file + ': ' + from);
    fs.writeFileSync(target, text.replace(from, to));
  }
  return dir;
}
const MUTANTS = [
  ['the shell\'s routing turned off (as ?view=classic)', { 'stack-shell.js': ["new URLSearchParams(location.search).get('view') !== 'classic'", "new URLSearchParams(location.search).get('view') === 'stack'"] }, s => s === 'shell-off'],
  ['the shell\'s context seam removed', { 'stack-shell.js': ['StackBlocks.context = context;', ''] }, s => s === 'shell-off'],
  ['the shell\'s input step failing', { 'stack-shell.js': ['const settlement = typeof planSettlementOutcome', "throw new Error('input step'); const settlement = typeof planSettlementOutcome"] }, s => s === 'no-recommendation'],
  ['the Credit block failing', { 'stack-credit.js': ['function cardHtml(reading) {', "function cardHtml(reading) { throw new Error('credit');"] }, s => s === 'blocks-failed'],
  ['the Waterfall block not registered', { 'stack-waterfall.js': ["root.StackBlocks.register('waterfall'", "root.StackBlocks.registerOff('waterfall'"] }, s => s === 'block-missing:waterfall'],
];
for (const [label, edit, expectStatus] of MUTANTS) {
  const dir = (() => { try { return copyRoot(edit); } catch (error) { return null; } })();
  ok(dir !== null, `mutant prepared: ${label}`);
  try {
    const cap = capture('savings-fully-backed', dir);
    ok(cap.stack && cap.stack.status !== 'rendered' && expectStatus(cap.stack.status), `${label}: status is ${cap.stack && cap.stack.status}, never rendered`);
    const ev = {};
    Snapshot.__putStackCaptureEvidence(ev, '', cap);
    ok(ev['stack.capture.status'] === cap.stack.status && ev['stack.capture.status'] !== 'rendered', `${label}: the evidence carries that status`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('6. driving the Stack page leaves the previous page\'s evidence unchanged');
{
  const withStack = {}, without = {};
  Snapshot.__putCaptureEvidence(withStack, '', caps['savings-fully-backed']);
  Snapshot.__putCaptureEvidence(without, '', capture('savings-fully-backed', undefined, { stack: false }));
  const keys = Object.keys(withStack);
  ok(keys.length > 100 && JSON.stringify(withStack) === JSON.stringify(without),
    `savings.capture.* identical with and without the Stack drive (${keys.length} keys)`);
}

console.log('6b. the shell\'s own recommend is not one of the previous page\'s advices');
{
  // Baseline: a copy whose shell is off (as ?view=classic) makes no recommend of its own, so the previous page's evidence
  // is exactly what it was before the Stack page was the default. The default capture must equal it.
  const dir = copyRoot({ 'stack-shell.js': ["new URLSearchParams(location.search).get('view') !== 'classic'", "new URLSearchParams(location.search).get('view') === 'stack'"] });
  try {
    const base = {}, now = {};
    Snapshot.__putCaptureEvidence(base, '', capture('savings-fully-backed', dir));
    Snapshot.__putCaptureEvidence(now, '', caps['savings-fully-backed']);
    ok(Object.keys(base).length > 100 && JSON.stringify(base) === JSON.stringify(now),
      'the previous page\'s evidence (its advices numbered in order) equals the shell-off baseline: the Stack shell\'s recommend is not numbered as one');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('6c. listeners the Stack blocks register during the drive reach the source guard');
{
  const BLOCK_FILES = ['stack-waterfall.js', 'stack-cards.js', 'stack-credit.js', 'stack-sheet.js'];
  const withDrive = caps['stack-card-summary'], without = capture('stack-card-summary', undefined, { stack: false });
  for (const file of BLOCK_FILES) {
    const rel = 'public/' + file;
    const registers = /addEventListener\s*\(/.test(fs.readFileSync(path.join(root, rel), 'utf8'));
    const seen = withDrive.deferred.get(rel), seenWithout = without.deferred.get(rel);
    ok(registers && seen && seen.size > 0, `${rel}: the capture's deferred registrations include the listeners it registers during the drive`, seen && [...seen].join(','));
    ok(!seenWithout || seenWithout.size === 0, `${rel}: without the drive none were registered (the drive is what exposes them)`, seenWithout && [...seenWithout].join(','));
    const guard = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/savings-consumer-manifest/guard/modules', rel + '.guard', 'module.json'), 'utf8'));
    ok(guard.mode === 'module' && /never invokes/.test(guard.reason || ''),
      `${rel}: the guard pins it whole-module (it registers callbacks the capture never invokes)`, guard.mode + ' ' + guard.reason);
  }
}

console.log('7. the evidence keys');
{
  const ev = {};
  Snapshot.__putStackCaptureEvidence(ev, '', caps['stack-card-summary']);
  const keys = Object.keys(ev);
  ok(ev['stack.capture.version'] === 'atlas-stack-page-capture/v1+atlas-savings-publication/v1' && ev['stack.capture.status'] === 'rendered'
    && ev['stack.capture.states'] === caps['stack-card-summary'].stack.states.length && ev['stack.capture.count'] === caps['stack-card-summary'].stackCalls.length,
  'version, status, state and call counts', keys.slice(0, 4).join(','));
  const lines = keys.filter(k => /^stack\.capture\.o\d+$/.test(k)).map(k => ev[k].split('|'));
  ok(lines.length === ev['stack.capture.count'] && lines.every(p => p.length === 6 && p[3].length === 64 && /^[0-9a-f]{64}$/.test(p[3])
    && (p[1] === 'recommend' ? p[4] === 'object' : /^[0-9a-f]{64}$/.test(p[4]))),
  'every call line is state|function|route|args digest|result digest|error, digests only');
  ok(keys.every(k => typeof ev[k] === 'string' || Number.isSafeInteger(ev[k])) && !JSON.stringify(ev).match(/\$\d|amount|balance/i),
    'only words, counts and digests: no figure');
  const again = {};
  Snapshot.__putStackCaptureEvidence(again, '', capture('stack-card-summary'));
  ok(JSON.stringify(again) === JSON.stringify(ev), 'deterministic: a second capture of the same input gives the same keys');
  // A change in how the Credit block asks moves its arguments' digest (and only that).
  const dir = copyRoot({ 'stack-credit.js': ['d.meta && d.meta.asOf', "'2020-01-01'"] });
  try {
    const moved = {};
    Snapshot.__putStackCaptureEvidence(moved, '', capture('stack-card-summary', dir));
    const diff = Object.keys(ev).filter(k => ev[k] !== moved[k]);
    ok(diff.length > 0 && diff.every(k => /^stack\.capture\.o\d+$/.test(k) && ['cardPeriodMovements', 'stackCreditLines'].includes(ev[k].split('|')[1])),
      'asking cardPeriodMovements for another date moves the Credit reads\' digests and nothing else', diff.slice(0, 4).join(','));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\nPASS figures page capture observes the Stack page (${checks})`);
