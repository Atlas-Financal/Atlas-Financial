'use strict';
/* Every script the household's pages run, as source text (line endings normalised the way
 * the other source guards do, test/test-source-text.js).
 *
 * "The page only prints" guards used to read public/plan.js alone, the classic page. The
 * Stack page (stack-*.js) and every script the shell loads print figures too, so a guard
 * that a page never re-derives a Forecast figure, never special-cases a payee and never
 * hardcodes a fact has to read all of them (C1 S4, docs/C1_TEST_DISPOSITIONS.md).
 *
 * The engine is not a page: forecast.js and its forecast-*.js modules are excluded, since
 * those guards are about what the page may not do next to the engine.
 */
const fs = require('fs');
const path = require('path');
const { sourceText } = require('../test-source-text');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const isEngine = name => name === 'forecast.js' || /^forecast-[\w-]+\.js$/.test(name);

function pageScripts() {
  const files = fs.readdirSync(PUBLIC).filter(name => /\.js$/.test(name) && !isEngine(name)).sort();
  // A scan that read nothing, or lost the Stack page, would pass every "never" guard vacuously.
  for (const must of ['app.js', 'stack-shell.js', 'stack-waterfall.js']) {
    if (!files.includes(must)) throw new Error('page script scan lost ' + must);
  }
  return files.map(name => ({ file: 'public/' + name, source: sourceText(fs.readFileSync(path.join(PUBLIC, name), 'utf8')) }));
}

// The page scripts whose source matches any pattern, as file names ([] means the "never" guard holds).
const pageScriptsMatching = (...patterns) => pageScripts()
  .filter(s => patterns.some(pattern => pattern.test(s.source))).map(s => s.file);

module.exports = { pageScripts, pageScriptsMatching };
