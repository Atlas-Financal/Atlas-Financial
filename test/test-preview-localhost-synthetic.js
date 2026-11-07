'use strict';
// The dev preview (scripts/preview.ps1) is an unauthenticated static server.
// It must bind to 127.0.0.1 only and stage only invented data: never the
// canonical data.json and never a published JSON aggregate from public/.
//
// The script is PowerShell; this suite reads its command lines as text and
// runs the Node staging helper against a temporary directory. It never reads
// the canonical data.json or any public/*.json value.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'preview.ps1');
const source = fs.readFileSync(SCRIPT, 'utf8');

// Code lines only: drop the comment-based help block and # comments.
function codeLines(text) {
  return text.replace(/<#[\s\S]*?#>/g, '').split(/\r?\n/)
    .map(line => line.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean);
}

function tokens(line) {
  return line.match(/'[^']*'|"[^"]*"|\S+/g) || [];
}

// Every http-server invocation must carry exactly one `-a 127.0.0.1` (or
// `--address 127.0.0.1`) and no other bind address.
function serverBindProblems(text) {
  const problems = [];
  const lines = codeLines(text).filter(line => /\bhttp-server\b/.test(line));
  if (!lines.length) problems.push('no http-server invocation found');
  for (const line of lines) {
    const t = tokens(line).map(x => x.replace(/^['"]|['"]$/g, ''));
    const binds = [];
    t.forEach((tok, i) => {
      if (tok === '-a' || tok === '--address') binds.push(t[i + 1]);
      const eq = /^--?(?:a|address)=(.*)$/.exec(tok);
      if (eq) binds.push(eq[1]);
    });
    if (binds.length !== 1 || binds[0] !== '127.0.0.1') {
      problems.push('http-server bind is not exactly 127.0.0.1: ' + line);
    }
  }
  return problems;
}

// The script must not name the canonical data.json as a source, and must not
// bulk-copy public/ (which holds published aggregates such as periods.json).
function stagingProblems(text) {
  const problems = [];
  for (const line of codeLines(text)) {
    if (/Join-Path\s+\$src\s+['"]data\.json['"]/i.test(line)) problems.push('names repo data.json: ' + line);
    if (/Copy-Item\b.*data\.json/i.test(line)) problems.push('copies a data.json: ' + line);
    if (/Copy-Item\s+\(Join-Path\s+\$publicDir\s+['"]\*['"]\)/i.test(line)) problems.push('bulk-copies public/: ' + line);
    if (/\.json['"]/i.test(line) && /StaticExtensions\s*=/.test(line)) problems.push('allowlists .json: ' + line);
  }
  if (!/&\s+node\s+\$syntheticData\s+\$StageDir/.test(text)) {
    problems.push('does not stage the synthetic data helper');
  }
  return problems;
}

function staticExtensions(text) {
  const line = codeLines(text).find(l => /^\$StaticExtensions\s*=/.test(l));
  assert.ok(line, 'static extension allowlist present');
  return (line.match(/'(\.[a-z0-9]+)'/gi) || []).map(x => x.slice(1, -1).toLowerCase());
}

// 1. Bind address.
assert.deepEqual(serverBindProblems(source), [], 'preview binds to 127.0.0.1 only');
assert.ok(!/localhost:\$Port/.test(source), 'printed URL is not localhost (it says what is bound)');
assert.ok(/http:\/\/127\.0\.0\.1:\$Port/.test(source), 'printed URL names 127.0.0.1');

// The predicate fails on the shipped defect and on near misses.
const defect = 'x\n& npx --yes http-server $StageDir -p $Port -c-1\n';
assert.equal(serverBindProblems(defect).length, 1, 'old command line (no -a) is caught');
assert.equal(serverBindProblems('& npx http-server $d -a 0.0.0.0 -p 1\n').length, 1, 'all-interfaces bind is caught');
assert.equal(serverBindProblems('& npx http-server $d -a 127.0.0.1 -a 0.0.0.0\n').length, 1, 'second bind is caught');
assert.equal(serverBindProblems('# & npx http-server $d -a 127.0.0.1\n& npx http-server $d -p 1\n').length, 1,
  'a commented-out bind does not count');
assert.deepEqual(serverBindProblems('& npx http-server $d --address=127.0.0.1\n'), [], 'long form accepted');

// 2. Staging: no canonical data.json, no bulk copy of public/, no .json asset.
assert.deepEqual(stagingProblems(source), [], 'preview stages synthetic data only');
const oldStaging = [
  "$dataFile = Join-Path $src 'data.json'",
  "Copy-Item (Join-Path $publicDir '*') -Destination $StageDir -Recurse -Force",
  'Copy-Item $dataFile -Destination $StageDir -Force',
].join('\n');
assert.ok(stagingProblems(oldStaging).length >= 3, 'old staging lines are caught');

const exts = staticExtensions(source);
assert.ok(exts.length > 0 && !exts.includes('.json'), 'allowlist holds no .json');
// Simulate the copy against the real public/ file names (names only).
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const publicFiles = walk(path.join(ROOT, 'public'));
const staged = publicFiles.filter(file => exts.includes(path.extname(file).toLowerCase()));
assert.ok(staged.some(f => f.endsWith(path.join('public', 'index.html'))), 'index.html is staged');
assert.ok(staged.some(f => f.endsWith(path.join('public', 'app.js'))), 'app.js is staged');
assert.deepEqual(staged.filter(f => /\.json$/i.test(f)), [], 'no public JSON aggregate is staged');
if (publicFiles.some(f => path.basename(f) === 'periods.json')) {
  assert.ok(!staged.some(f => path.basename(f) === 'periods.json'), 'public/periods.json is not staged');
}

// The in-repository stage refusal comes before any cleanup or copy.
const lines = codeLines(source);
const refuseAt = lines.findIndex(l => /throw "Refusing to stage the preview inside the repository/.test(l));
const firstRemove = lines.findIndex(l => /Remove-Item/.test(l));
const firstCopy = lines.findIndex(l => /Copy-Item/.test(l));
assert.ok(refuseAt >= 0 && refuseAt < firstRemove && refuseAt < firstCopy, 'refusal precedes cleanup and copy');
// The stage path is resolved the way Remove-Item resolves it, before the check.
const resolveAt = lines.findIndex(l => /GetUnresolvedProviderPathFromPSPath\(\$StageDir\)/.test(l));
assert.ok(resolveAt >= 0 && resolveAt < refuseAt, 'stage path is resolved against the PowerShell location first');
// Only a new, empty or marked stage is ever emptied.
const markerAt = lines.findIndex(l => /throw \(?"Refusing to empty \$StageDir/.test(l));
assert.ok(markerAt >= 0 && markerAt < firstRemove, 'unmarked non-empty folder is refused before any delete');
assert.ok(lines.some(l => /\$StageMarker = '\.atlas-preview-stage'/.test(l)), 'stage marker is named');

// 3. The Node helper writes the invented household and opens no real data.
const helper = require('../scripts/preview-synthetic-data');
const forbidden = [path.join(ROOT, 'data.json')].concat(
  publicFiles.filter(f => /\.json$/i.test(f))).map(f => path.resolve(f));
const opened = [];
const realRead = fs.readFileSync;
const realOpen = fs.openSync;
fs.readFileSync = function (file, ...rest) { opened.push(String(file)); return realRead.call(fs, file, ...rest); };
fs.openSync = function (file, ...rest) { opened.push(String(file)); return realOpen.call(fs, file, ...rest); };
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-preview-test-'));
let written;
try {
  written = helper.writeSyntheticData(stage);
} finally {
  fs.readFileSync = realRead;
  fs.openSync = realOpen;
}
const touched = opened.map(f => path.resolve(f)).filter(f => forbidden.includes(f));
assert.deepEqual(touched, [], 'helper never opens canonical data.json or a public JSON aggregate');
assert.equal(written, path.join(stage, 'data.json'));
const packet = JSON.parse(realRead(written, 'utf8'));
assert.equal(packet.meta.title, 'Synthetic Budget surface', 'staged packet is the invented household');
assert.ok(Array.isArray(packet.debts) && packet.debts.length > 0
  && packet.debts.every(d => /^Synthetic /.test(d.label)), 'every staged debt is an invented one');
assert.ok(helper.isHouseholdJson(path.join(ROOT, 'data.json')), 'canonical data.json is household JSON');
assert.ok(helper.isHouseholdJson(path.join(ROOT, 'public', 'periods.json')), 'public aggregates are household JSON');
assert.ok(!helper.isHouseholdJson(path.join(ROOT, 'test', 'fixtures', 'cardcov-probe-inputs.json')), 'fixtures are not');
assert.deepEqual(fs.readdirSync(stage), ['data.json'], 'helper stages one file');
fs.rmSync(stage, { recursive: true, force: true });

// Refuses a stage inside the repository; accepts one outside it.
for (const inside of [ROOT, path.join(ROOT, 'public'), path.join(ROOT, 'tmp', 'stage')]) {
  assert.throws(() => helper.assertStageDir(inside), /inside the repository/, inside);
}
assert.throws(() => helper.assertStageDir(''), /usage/);
// A path outside the repository that reaches it through a symlink is refused,
// including a not-yet-existing folder under such a link, and a data.json in
// an outside stage that is itself a link into the repository.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-preview-alias-'));
  try {
    fs.symlinkSync(ROOT, path.join(tmp, 'to-root'), 'dir');
    assert.throws(() => helper.assertStageDir(path.join(tmp, 'to-root')), /inside the repository/, 'alias to root');
    assert.throws(() => helper.assertStageDir(path.join(tmp, 'to-root', 'not-yet', 'stage')), /inside the repository/,
      'new folder under an alias');
    assert.throws(() => helper.writeSyntheticData(path.join(tmp, 'to-root')), /inside the repository/, 'write via alias');
    const outside = path.join(tmp, 'stage');
    fs.mkdirSync(outside);
    fs.symlinkSync(path.join(ROOT, 'data.json'), path.join(outside, 'data.json'));
    assert.throws(() => helper.writeSyntheticData(outside), /inside the repository/, 'data.json link into the repository');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
assert.equal(helper.assertStageDir(path.join(os.tmpdir(), 'atlas-preview')), path.join(os.tmpdir(), 'atlas-preview'));

console.log('preview binds 127.0.0.1 and stages synthetic data only: ok');
