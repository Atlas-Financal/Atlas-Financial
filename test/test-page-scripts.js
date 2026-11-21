'use strict';
/* The page-script scan the "page only prints" guards read (test/lib/page-scripts.js).
 * `node test/test-page-scripts.js`
 *
 * A "no page script does X" guard passes when the scan finds nothing, so the scan has to be
 * shown to find things: it must cover the Stack page and the classic page, leave the engine
 * out, and report a script that does contain a pattern.
 */
const assert = require('node:assert/strict');
const { pageScripts, pageScriptsMatching } = require('./lib/page-scripts');

let checks = 0;
const ok = (cond, label) => { assert.ok(cond, label); checks++; console.log('  PASS  ' + label); };

const files = pageScripts().map(s => s.file);
for (const must of ['public/app.js', 'public/stack-shell.js', 'public/stack-waterfall.js', 'public/stack-cards.js',
  'public/stack-credit.js', 'public/stack-sheet.js']) ok(files.includes(must), 'the scan covers ' + must);
ok(files.every(f => !/\/forecast(-[\w-]+)?\.js$/.test(f)), 'the engine (forecast.js and forecast-*.js) is not a page script');
ok(files.length >= 10, 'the scan reads at least ten scripts');
ok(pageScripts().every(s => s.source.length > 100), 'every script was read, none empty');
ok(JSON.stringify(pageScriptsMatching(/StackBlocks\.register/)) !== '[]'
  && pageScriptsMatching(/StackBlocks\.register/).includes('public/stack-waterfall.js'),
  'a pattern a Stack script contains is reported with its file');
ok(pageScriptsMatching(/zzz-no-script-contains-this-zzz/).length === 0, 'a pattern no script contains reports nothing');
ok(pageScriptsMatching(/zzz-no-script-contains-this-zzz/, /StackBlocks\.register/).length > 0,
  'several patterns report a script that matches any one');

console.log(`test-page-scripts: ${checks} checks passed`);
