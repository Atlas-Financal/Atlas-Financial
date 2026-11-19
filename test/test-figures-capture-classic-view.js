'use strict';
/* The figures page capture runs the previous Budget page by its explicit route, ?view=classic (lead ruling, option A,
 * 2026-11-19), so making the Stack page the default Budget page (B7) does not change what the Savings capture observes.
 *
 *   1. The capture's location is /?view=classic (search and href agree).
 *   2. Behaviour: on a copy of public/ whose stack-shell.js draws the Stack page for every view but ?view=classic
 *      (B7's routing rule), the capture's evidence equals the evidence on today's public/, on an invented input.
 *   3. Control: on that copy, an empty search would draw the Stack page (the shell's routing line is the one B7
 *      ships), so check 2 is not vacuous.
 * Temporary: retarget at C1, when the previous page retires.
 * `node test/test-figures-capture-classic-view.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PageCapture = require('../scripts/figures-page-capture');
const Snapshot = require('../scripts/figures-snapshot');

const root = path.join(__dirname, '..');
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

console.log('1. the capture location');
{
  const loc = PageCapture.CAPTURE_LOCATION;
  ok(new URLSearchParams(loc.search).get('view') === 'classic' && new URL(loc.href).search === loc.search && loc.pathname === '/',
    'the capture runs /?view=classic', JSON.stringify(loc));
  ok(Object.isFrozen(loc), 'the location is frozen');
}

// A copy of the repository's public/ (and the files the capture reads) whose shell uses B7's routing rule.
const B7_RULE = "new URLSearchParams(location.search).get('view') !== 'classic'";
function b7Root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-b7-'));
  fs.cpSync(path.join(root, 'public'), path.join(dir, 'public'), { recursive: true });
  const shell = path.join(dir, 'public', 'stack-shell.js');
  const src = fs.readFileSync(shell, 'utf8');
  const today = "new URLSearchParams(location.search).get('view') === 'stack'";
  const next = src.includes(B7_RULE) ? src : src.replace(today, B7_RULE);
  assert.ok(next.includes(B7_RULE), 'the shell carries B7\'s routing rule in the copy');
  fs.writeFileSync(shell, next);
  return dir;
}

console.log('2. behaviour: the evidence is unchanged when the Stack page is the default');
const input = Snapshot.loadInventedInputs().find(i => i.id === 'savings-fully-backed');
assert.ok(input, 'invented input savings-fully-backed exists');
const evidence = rootDir => {
  const out = {};
  Snapshot.__putCaptureEvidence(out, '', PageCapture.capturePages(input.doc.data, input.doc.periods, rootDir));
  return out;
};
const dir = b7Root();
try {
  const today = evidence(root), b7 = evidence(dir);
  const keys = Object.keys(today);
  const changed = keys.filter(k => JSON.stringify(today[k]) !== JSON.stringify(b7[k]));
  ok(keys.length > 100 && Object.keys(b7).length === keys.length && changed.length === 0,
    `capture evidence identical on the B7 copy (${keys.length} keys)`, changed.slice(0, 5).join(', '));

  console.log('3. control: on the B7 copy an empty search draws the Stack page');
  const shell = fs.readFileSync(path.join(dir, 'public', 'stack-shell.js'), 'utf8');
  const line = shell.split('\n').find(l => l.includes(B7_RULE));
  // eslint-disable-next-line no-new-func
  const decide = search => new Function('location', 'URLSearchParams', `return ${B7_RULE};`)({ search }, URLSearchParams);
  ok(line && decide('') === true && decide('?view=classic') === false,
    'B7\'s rule draws the Stack page for an empty search and not for ?view=classic');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nPASS figures capture runs ?view=classic (${checks})`);
