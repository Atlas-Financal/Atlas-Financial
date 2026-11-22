'use strict';
/* The page-script scan the "page only prints" guards read (test/lib/page-scripts.js).
 * `node test/test-page-scripts.js`
 *
 * A "no page script does X" guard passes when the scan finds nothing, so the scan has to be
 * shown to find things. It is pinned: the exact list of scripts it reads is written out below,
 * so dropping plan.js, a Stack script or any other page script, or adding one without
 * deciding whether it is a page or the engine, fails here. When a script is removed on
 * purpose (C1 S7 removes plan.js and the classic scripts), this list changes in the same PR.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pageScripts, pageScriptsMatching, indexScripts, ENGINE } = require('./lib/page-scripts');

let checks = 0;
const ok = (cond, label) => { assert.ok(cond, label); checks++; console.log('  PASS  ' + label); };

const PAGE_SCRIPTS = [
  'app.js', 'aurora.js', 'balance-history.js', 'bill-detail.js', 'budget-blend.js', 'budget-card-movements.js',
  'budget-polish.js', 'budget-river.js', 'budget-sheet-motion.js', 'budget-surface.js', 'client-timing.js', 'display-name.js',
  'household-view.js', 'plan.js', 'savings-inventory.js', 'stack-cards.js', 'stack-credit.js', 'stack-sheet.js',
  'stack-shell.js', 'stack-waterfall.js',
].map(name => 'public/' + name);

const files = pageScripts().map(s => s.file);
assert.deepEqual(files, PAGE_SCRIPTS, 'the scan reads exactly the pinned page scripts');
ok(true, 'the scan reads exactly the ' + PAGE_SCRIPTS.length + ' pinned page scripts (index.html\'s list minus the engine)');
ok(JSON.stringify(ENGINE) === JSON.stringify(['forecast.js', 'forecast-card-period.js', 'forecast-chequing.js']),
  'the engine is the explicit list forecast.js, forecast-card-period.js, forecast-chequing.js');
ok(files.every(f => !ENGINE.includes(path.basename(f))), 'no engine module is a page script');
ok(pageScripts().every(s => s.source.length > 100), 'every script was read, none empty');
ok(indexScripts().length === files.length + ENGINE.length, 'index.html loads exactly the page scripts and the engine');
ok(pageScriptsMatching(/StackBlocks\.register/).includes('public/stack-waterfall.js'),
  'a pattern a Stack script contains is reported with its file');
ok(pageScriptsMatching(/zzz-no-script-contains-this-zzz/).length === 0, 'a pattern no script contains reports nothing');
ok(pageScriptsMatching(/zzz-no-script-contains-this-zzz/, /StackBlocks\.register/).length > 0,
  'several patterns report a script that matches any one');

// The scan fails loudly, on a copy of the public folder, when it could pass a guard vacuously.
const os = require('os');
function withPublic(mutate, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-scripts-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test', 'lib'), { recursive: true });
  for (const f of ['lib/page-scripts.js', 'test-source-text.js']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(root, 'test', f));
  }
  mutate(root);
  try { return run(require(path.join(root, 'test', 'lib', 'page-scripts.js'))); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const throwsOn = (mutate, re) => { try { withPublic(mutate, lib => lib.pageScripts()); return false; } catch (e) { return re.test(e.message); } };
const edit = (root, fn) => { const p = path.join(root, 'public', 'index.html'); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); };
ok(throwsOn(root => edit(root, h => h.replace('<script src="/plan.js"></script>', '')), /index\.html does not load/),
  'a public script index.html no longer loads fails the scan (plan.js dropped from the page)');
ok(throwsOn(root => fs.writeFileSync(path.join(root, 'public', 'extra-page.js'), '// x\n'), /index\.html does not load/),
  'a new public script no guard would scan fails the scan');
ok(throwsOn(root => edit(root, h => h.replace('<script src="/plan.js"></script>', '<script src="/plan.js?v=2"></script>')), /cannot read as a plain/),
  'a script tag the scan cannot read as a plain /name.js source fails (query string)');
ok(throwsOn(root => edit(root, h => h.replace('<script src="/plan.js"></script>', '<script>var x = 1;</script>')), /cannot read as a plain/),
  'an inline script fails the scan');
ok(throwsOn(root => edit(root, h => h.replace('<script src="/forecast.js"></script>', '')), /ENGINE names forecast\.js/),
  'an ENGINE entry index.html does not load fails the scan');
ok(throwsOn(root => { fs.mkdirSync(path.join(root, 'public', 'more')); fs.writeFileSync(path.join(root, 'public', 'more', 'x.js'), '// x\n'); }, /subfolder/),
  'a script in a public/ subfolder fails the scan');
ok(!throwsOn(() => {}, /./), 'the unmodified folder scans clean');

console.log(`test-page-scripts: ${checks} checks passed`);
