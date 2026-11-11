'use strict';
/* Static sanity. `node test/test-static.js`
 *
 * Cheap checks that must pass before any numeric result is worth reading: the
 * JSON parses, every script compiles, every element the page writes to exists
 * in its HTML, and no secret or personal identifier has reached a tracked file.
 *
 * The element check earns its place: adding a figure to data.json does not put
 * it on the page, and six keys once sat unrendered — including the whole income
 * section — because a script wrote to an id no HTML had. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

console.log('=== data files parse ===');
let data = null, periods = null;
try { data = JSON.parse(read('data.json')); ok(true, 'data.json parses'); }
catch (e) { ok(false, 'data.json parses', e.message); }
try { periods = JSON.parse(read('public/periods.json')); ok(true, 'periods.json parses'); }
catch (e) { ok(false, 'periods.json parses', e.message); }

console.log('\n=== every script compiles ===');
const scripts = fs.readdirSync(path.join(__dirname, '..', 'public')).filter(f => f.endsWith('.js'));
for (const f of scripts) {
  try { new vm.Script(read('public/' + f), { filename: f }); ok(true, `public/${f}`); }
  catch (e) { ok(false, `public/${f}`, e.message); }
}
for (const f of ['server.js', 'test/test-forecast.js', 'test/test-budget.js', 'test/test-debt.js', 'test/test-invariants.js', 'test/test-mergecard.js']) {
  try { new vm.Script(read(f), { filename: f }); ok(true, f); }
  catch (e) { ok(false, f, e.message); }
}

console.log('\n=== the page has somewhere to put every figure ===');
// Each page script writes to ids via $('...'). Every one must exist in its HTML.
const pages = [
  ['index.html', ['plan.js']],
  ['plan-spend.html', ['plan-spend.js']],
];
for (const [html, jsFiles] of pages) {
  const markup = read('public/' + html);
  const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const missing = [];
  for (const js of jsFiles) {
    for (const m of read('public/' + js).matchAll(/\$\('([^']+)'\)/g)) {
      if (!ids.has(m[1]) && !missing.includes(m[1])) missing.push(m[1]);
    }
  }
  ok(missing.length === 0, `${html} has every element ${jsFiles.join(', ')} writes to`,
    missing.length ? 'missing: ' + missing.join(', ') : `${ids.size} ids`);
}

console.log('\n=== no secret or identifier has reached a tracked file ===');
// Generic card / SIN / quoted-secret shapes. The incumbent household
// identifier list lives only in scripts/privacy-guard.js; CI applies that
// engine from the trusted default branch (B77). Do not copy that list here.
const tracked = [];
const walk = dir => {
  for (const e of fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true })) {
    const rel = dir ? dir + '/' + e.name : e.name;
    if (/^(\.git|node_modules|raw|derived)$/.test(e.name)) continue;
    if (e.isDirectory()) walk(rel);
    else if (/\.(js|json|md|csv|html|yaml|yml)$/.test(e.name)) tracked.push(rel);
  }
};
walk('');
const PATTERNS = [
  [/\bSITE_PASSWORD\s*[:=]\s*['"][^'"]+['"]/, 'a literal SITE_PASSWORD'],
  [/\bSESSION_SECRET\s*[:=]\s*['"][^'"]+['"]/, 'a literal SESSION_SECRET'],
  [/\bLUNCHMONEY_ACCESS_TOKEN\s*=\s*['"][^'"]+['"]/, 'a literal LUNCHMONEY_ACCESS_TOKEN'],
  [/\bATLAS_PROVIDER_ACCOUNT_MAP_JSON\s*=\s*['"][^'"]+['"]/, 'a literal ATLAS_PROVIDER_ACCOUNT_MAP_JSON'],
  [/\bATLAS_ASSISTANT_TOKEN\s*=\s*['"][^'"]+['"]/, 'a literal ATLAS_ASSISTANT_TOKEN'],
  [/\bATLAS_TALK_GEMINI_API_KEY\s*=\s*['"][^'"]+['"]/, 'a literal ATLAS_TALK_GEMINI_API_KEY'],
  [/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/, 'a 16-digit card number'],
  [/\b\d{3}[ -]\d{3}[ -]\d{3}\b/, 'a SIN-shaped number'],
];
let hits = 0;
for (const f of tracked) {
  const body = read(f);
  for (const [re, what] of PATTERNS) {
    // package-lock hashes and the test file itself are not account data.
    if (f === 'package-lock.json' || f === 'test-static.js' || f === 'test/test-static.js') continue;
    const m = body.match(re);
    if (m) { hits++; console.log(`        ${f}: ${what} — ${m[0].slice(0, 24)}`); }
  }
}
ok(hits === 0, 'no credentials, card numbers or SIN-shaped identifiers in tracked files',
  `${tracked.length} files scanned`);
ok(!fs.existsSync(path.join(__dirname, '..', 'raw')), 'no raw/ directory is present in the checkout');
ok(read('.gitignore').includes('raw/'), 'raw/ is gitignored');
const hookPath = path.join(__dirname, '..', '.githooks/pre-commit');
ok(fs.existsSync(hookPath), 'the pre-commit hook is present');
ok(/privacy-guard\.js/.test(read('.githooks/pre-commit')),
  'and delegates to the sole privacy-guard engine');
ok(!/^patterns=/m.test(read('.githooks/pre-commit')),
  'and does not keep a second identifier list');
ok(fs.existsSync(path.join(__dirname, '..', 'scripts/privacy-guard.js')),
  'the privacy-guard engine is present');
// A hook without the executable bit is silently ignored by git — it prints a
// hint and commits anyway. Windows does not expose POSIX execute bits in
// fs.statSync, so use the executable mode recorded in Git's index there.
const hookIndexMode = (execFileSync('git', ['ls-files', '-s', '--', '.githooks/pre-commit'], {
  cwd: path.join(__dirname, '..'), encoding: 'utf8',
}).match(/^(\d{6})/) || [])[1];
const hookExecutable = process.platform === 'win32'
  ? hookIndexMode === '100755'
  : fs.existsSync(hookPath) && (fs.statSync(hookPath).mode & 0o111) !== 0;
ok(hookExecutable,
  'and is executable, so git will actually run it',
  process.platform === 'win32'
    ? `index mode ${hookIndexMode || 'missing'}`
    : (fs.existsSync(hookPath) ? '0' + (fs.statSync(hookPath).mode & 0o777).toString(8) : 'missing'));

console.log('\n=== the review gates agree with each other ===');
// The gates are three files that have to name the same things. If the template
// renames a field, the merge-card check fails every PR until someone notices;
// if the manifest and the gate disagree about the primary labels, the gate is
// unsatisfiable. Both are silent failures, so they are checked here.
const template = read('.github/PULL_REQUEST_TEMPLATE.md');
const mergeCard = read('.github/workflows/merge-card-check.yml');
const gate = read('.github/workflows/risk-label-gate.yml');
const manifest = read('.github/labels.yml');
const labelerCfg = read('.github/labeler.yml');
const primaryRiskHelper = read('scripts/atlas-primary-risk.js');

// Every field the check requires must exist in the template it points people at.
const fieldsBlock = (/const FIELDS = \[([\s\S]*?)\n\s*\];/.exec(mergeCard) || [, ''])[1];
const reviewFieldsBlock = (/const REVIEW_FIELDS = \[([\s\S]*?)\n\s*\];/.exec(mergeCard) || [, ''])[1];
const required = [...`${fieldsBlock}\n${reviewFieldsBlock}`.matchAll(/'([^']+)'/g)].map(m => m[1]);
ok(required.length >= 8, 'the merge-card check declares its required fields', `${required.length} fields`);
const missingFromTemplate = required.filter(f => !template.includes(`**${f}**`));
ok(missingFromTemplate.length === 0,
  'every field the check requires exists in the PR template',
  missingFromTemplate.join(', ') || 'all present');
ok(/^### Atlas Contract \/ Systems Review$/m.test(template),
  'the template carries the review section the mechanical check requires');

// And every prose heading it requires.
const headings = [...mergeCard.matchAll(/^\s*for \(const heading of \[([^\]]+)\]/gms)]
  .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
const missingHeadings = headings.filter(h => !new RegExp(`^#{2,4}\\s*${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(template));
ok(missingHeadings.length === 0,
  'every prose section the check requires exists in the template',
  missingHeadings.join(', ') || `${headings.length} sections`);

// The helper's primary list, the merge-card closed vocabulary, and the
// manifest must describe the same four labels. The workflow must not keep a
// second copy.
const helperPrimary = (/const PRIMARY = Object\.freeze\(\[([^\]]+)\]\)/.exec(primaryRiskHelper) || [, ''])[1]
  .match(/'([^']+)'/g) || [];
const gateNames = helperPrimary.map(s => s.replace(/'/g, ''));
ok(gateNames.length === 4, 'the primary-risk helper names four primary labels', gateNames.join(', '));
ok(/scripts\/atlas-primary-risk\.js/.test(gate), 'the risk gate derives the GitHub label from the helper');
ok(!/const PRIMARY = \[/.test(gate), 'the risk-gate workflow does not keep a second PRIMARY list');
ok(/scripts\/atlas-primary-risk\.js/.test(mergeCard), 'merge-card-check consumes the helper for Primary risk');
ok(/parsePrimaryRisk/.test(mergeCard), 'merge-card-check calls parsePrimaryRisk rather than a second enum regex');
ok(!/const PRIMARY_RISK = \[/.test(mergeCard), 'merge-card-check does not keep a second PRIMARY list');
const mergeCardCheckout = mergeCard.search(
  /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/,
);
const mergeCardHelper = mergeCard.search(/atlas-primary-risk\.js/);
ok(mergeCardCheckout >= 0 && mergeCardHelper > mergeCardCheckout,
  'merge-card-check checks out the trusted default branch before requiring the helper');
ok(/persist-credentials:\s*false/.test(mergeCard)
  && !/ref:\s*\$\{\{\s*github\.event\.pull_request\.head/.test(mergeCard),
  'merge-card-check helper checkout disables credentials and is not the PR head');
const notInManifest = gateNames.filter(n => !new RegExp(`^- name: ${n}$`, 'm').test(manifest));
ok(notInManifest.length === 0,
  'and every one of them exists in the label manifest', notInManifest.join(', ') || 'all present');

// Every category the labeller can apply must exist too, or PRs get labelled
// with names the repo does not have.
const labelerNames = [...labelerCfg.matchAll(/^([a-z][a-z-]*):$/gm)].map(m => m[1]);
const unknown = labelerNames.filter(n => !new RegExp(`^- name: ${n}$`, 'm').test(manifest));
ok(unknown.length === 0, 'every auto-applied category label is in the manifest',
  unknown.join(', ') || `${labelerNames.length} categories`);
ok(labelerNames.every(n => !gateNames.includes(n)),
  'and no primary label is applied automatically by path',
  'the primary label is projected from the Merge Card, not from paths');

// The snapshot the figures review diffs must actually run.
ok(fs.existsSync(path.join(__dirname, '..', 'scripts/figures-snapshot.js')),
  'the published-figures snapshot script exists');
ok(/figures-snapshot\.js/.test(read('.github/workflows/figures-review.yml')),
  'and the figures review runs it');

console.log('\n=== the security gate is intact ===');
const server = read('server.js');
ok(/SITE_PASSWORD/.test(server) && /process\.exit|throw/.test(server),
  'the server refuses to start without SITE_PASSWORD');
ok(/no-store/.test(server), 'financial responses are sent no-store');
ok(/noindex/i.test(server), 'and noindex');
ok(/Content-Security-Policy/i.test(server), 'a CSP is set');
ok(/httpOnly/i.test(server), 'the session cookie is httpOnly');

console.log('\n=== production code never requires a devDependency ===');
// CI installs dev dependencies for the test groups (property tests need
// fast-check), after the runtime-only install. This is what keeps the
// production guarantee: nothing outside test/ may import a devDependency.
  // A textual heuristic (require/from/import forms), not proof of every form.
{
  const pkg = JSON.parse(read('package.json'));
  const dev = Object.keys(pkg.devDependencies || {}).filter(n => !(pkg.dependencies || {})[n]);
  const walk = d => fs.readdirSync(path.join(__dirname, '..', d), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (['node_modules', 'test', '.git', 'raw', 'derived', 'snapshots'].includes(e.name) ? [] : walk(path.join(d, e.name)))
      : /\.(c|m)?js$/.test(e.name) ? [path.join(d, e.name)] : []);
  const files = walk('.');
  const offenders = [];
  for (const f of files) {
    const text = read(f).replace(/\/\*[\s\S]*?\*\//g, ' ');   // block comments cannot hide an import
    for (const n of dev) {
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?:require\\s*\\(|from\\s+|import\\s*\\(?)\\s*['"]${esc}(?:/[^'"]*)?['"]`).test(text)) offenders.push(`${f} -> ${n}`);
    }
  }
  ok(offenders.length === 0, `no non-test file requires a devDependency (${dev.join(', ') || 'none'}; ${files.length} files scanned)`, offenders.join('; '));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
