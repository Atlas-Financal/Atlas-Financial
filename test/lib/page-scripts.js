'use strict';
/* Every script the household's pages run, as source text (line endings normalised the way
 * the other source guards do, test/test-source-text.js).
 *
 * "The page only prints" guards used to read public/plan.js alone, the classic page. The
 * Stack page (stack-*.js) and every script index.html loads print figures too, so a guard
 * that a page never re-derives a Forecast figure, never special-cases a payee and never
 * hardcodes a fact has to read all of them (C1 S4, docs/C1_TEST_DISPOSITIONS.md).
 *
 * The set is what public/index.html loads, minus ENGINE, the engine modules a page may
 * not duplicate. ENGINE is an explicit list, not a name rule, so a page script that
 * happens to be named forecast-* cannot slip out of the scan. A script tag the scan cannot
 * read as a plain /name.js source, or a public/*.js file index.html does not load, fails
 * loudly: either would pass every "never" guard unscanned.
 */
const fs = require('fs');
const path = require('path');
const { sourceText } = require('../test-source-text');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const ENGINE = ['forecast.js', 'forecast-card-period.js', 'forecast-chequing.js'];

function indexScripts() {
  const html = sourceText(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'));
  const names = [];
  for (const tag of html.match(/<script\b[^>]*>/gi) || []) {
    const src = /\ssrc\s*=\s*"\/([\w-]+\.js)"/i.exec(tag);
    if (!src) throw new Error('index.html script tag the scan cannot read as a plain /name.js source: ' + tag);
    names.push(src[1]);
  }
  return names;
}

function pageScripts() {
  const loaded = indexScripts();
  if (new Set(loaded).size !== loaded.length) throw new Error('index.html loads a script twice');
  for (const name of ENGINE) {
    if (!loaded.includes(name)) throw new Error('ENGINE names ' + name + ', which index.html does not load');
  }
  const onDisk = fs.readdirSync(PUBLIC).filter(name => /\.js$/.test(name));
  // The scan reads public/ itself: a script in a subfolder would be missed by every guard.
  const nested = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (dir !== PUBLIC && /\.m?js$/.test(entry.name)) nested.push(path.relative(PUBLIC, full));
    }
  })(PUBLIC);
  if (nested.length) throw new Error('script in a public/ subfolder, which the scan does not read: ' + nested.join(', '));
  const unloaded = onDisk.filter(name => !loaded.includes(name));
  if (unloaded.length) throw new Error('public script index.html does not load, so no guard would scan it: ' + unloaded.join(', '));
  const missing = loaded.filter(name => !onDisk.includes(name));
  if (missing.length) throw new Error('index.html loads a script that is not in public/: ' + missing.join(', '));
  return loaded.filter(name => !ENGINE.includes(name)).sort()
    .map(name => {
      const source = sourceText(fs.readFileSync(path.join(PUBLIC, name), 'utf8'));
      // code: the same source with block and line comments removed, for guards about what the script does
      // rather than what it says (the "page is a renderer" blocks always read it this way).
      return { file: 'public/' + name, source, code: source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '') };
    });
}

// The page scripts whose source matches any pattern, as file names ([] means the "never" guard holds).
const pageScriptsMatching = (...patterns) => pageScripts()
  .filter(s => patterns.some(pattern => pattern.test(s.source))).map(s => s.file);

// The same, over the code with comments removed.
const pageCodeMatching = (...patterns) => pageScripts()
  .filter(s => patterns.some(pattern => pattern.test(s.code))).map(s => s.file);

module.exports = { pageScripts, pageScriptsMatching, pageCodeMatching, indexScripts, ENGINE };
