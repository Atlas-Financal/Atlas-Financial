'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, demoPackage } = require('./lib/demo-process');
const fixture = require('./fixtures/figures-inputs/stack-card-summary.json');
const {
  ASSET_FILES, DIGESTS_REL, assetDigest, verifyAsset, loadApprovedAssets,
} = require('../scripts/demo-server');
const { packageDemo, prepareAsset, checkDemoPrivacy } = require('../scripts/package-demo');
const DemoDigests = require('../scripts/demo-asset-digests');
const { fingerprintOf, HOUSEHOLD_FINGERPRINTS } = require('../scripts/privacy-guard');

const ROOT = path.join(__dirname, '..');

const preload = ['--require', path.join(__dirname, 'lib', 'demo-preload.js')];
const refusalValue = 'invented-placeholder';
const secretNames = [
  'SITE_PASSWORD', 'SESSION_SECRET', 'LUNCHMONEY_ACCESS_TOKEN', 'LUNCH_MONEY_TOKEN',
  'ATLAS_ASSISTANT_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ATLAS_TALK_GEMINI_API_KEY',
  'SETTLEMENT_FINANCIAL_DB_PASSWORD', 'SETTLEMENT_AUTH_DB_PASSWORD', 'SETTLEMENT_CUSTODY_DB_PASSWORD',
  'DATABASE_URL', 'PGPASSWORD',
  'UNRECOGNIZED_FUTURE_CREDENTIAL',
];

async function expectRefusal(child, message) {
  try {
    const listening = child.ready.then(() => ({ code: 0, output: child.output }), () => child.closed);
    const result = await Promise.race([child.closed, listening]);
    assert.equal(result.code, 1, 'demo must refuse startup');
    assert.ok(result.output.includes(message), result.output);
    assert.doesNotMatch(result.output, /listening|invented-placeholder/);
  } finally { await child.stop(); }
}

async function withBytes(filename, bytes, check) {
  const original = fs.readFileSync(filename);
  fs.writeFileSync(filename, bytes);
  try { await check(); } finally { fs.writeFileSync(filename, original); }
}

async function checkAssetRefusal(directory) {
  const { label, id, balance } = fixture.data.debts[0];
  const cases = [
    ['public/plan.js', label + ' privacy canary', 'alphaspace'],
    ['public/budget-card-movements.js', id + 'privacycanary', 'alnum'],
    ['public/forecast.js', String(Math.round(balance * 100)).padEnd(9, '7'), 'digit'],
  ];
  for (const [name, canary, cls] of cases) {
    const filename = path.join(directory, name);
    const published = fs.readFileSync(filename);
    const changed = Buffer.concat([published, Buffer.from(`\nglobalThis.demoCanary = ${JSON.stringify(canary)};\n`)]);
    const fingerprints = [...HOUSEHOLD_FINGERPRINTS, { len: canary.length, cls, sha256: fingerprintOf(canary) }];
    assert.doesNotThrow(() => checkDemoPrivacy(name, published, fingerprints));
    assert.throws(() => checkDemoPrivacy(name, changed, fingerprints),
      { message: `Demo asset rejected by privacy guard: ${name}` });
    await withBytes(filename, changed, () => expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory),
      `Unexpected demo asset contents: ${name}`));
  }
  const entry = path.join(directory, 'scripts', 'demo-server.js');
  const source = fs.readFileSync(entry, 'utf8').replaceAll('\r\n', '\n');
  const mutant = source.replace('  verifyAsset(name, body);\n', '');
  assert.notEqual(mutant, source, 'mutation must remove asset verification');
  const name = cases[0][0];
  const filename = path.join(directory, name);
  const changed = Buffer.concat([fs.readFileSync(filename), Buffer.from(`\nglobalThis.demoCanary = ${JSON.stringify(label)};\n`)]);
  await withBytes(entry, mutant, () => withBytes(filename, changed, () =>
    assert.rejects(expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory), `Unexpected demo asset contents: ${name}`),
      { code: 'ERR_ASSERTION', actual: 0, expected: 1 })));
  console.log('PASS  invented label, account and figure canaries fail privacy and approved-asset checks, including the asset guard mutant');
}

async function withStatementDirectory(directory, name, check) {
  const folder = path.join(directory, name);
  const canary = path.join(folder, 'invented-statement.txt');
  fs.mkdirSync(folder);
  fs.writeFileSync(canary, refusalValue, { flag: 'wx' });
  try { await check(); } finally {
    fs.unlinkSync(canary);
    fs.rmdirSync(folder);
  }
}

async function checkDemo(directory) {
  const refusedEnv = 'FATAL: demo requires an isolated startup environment.';
  const refusedFile = 'FATAL: demo requires a checkout without local credential files.';
  const refusedHousehold = 'FATAL: demo requires a checkout without household data paths.';
  for (const name of secretNames) {
    // Presence is enough, even when the runtime supplies an empty value.
    const value = name === 'UNRECOGNIZED_FUTURE_CREDENTIAL' ? '' : refusalValue;
    await expectRefusal(launch({ ATLAS_DEMO: '1', [name]: value }, preload, directory), refusedEnv);
    console.log(`PASS  demo refuses ${name}`);
  }

  for (const name of ['.env', '.env.local', '.env.production.local', '.env-test', '.envrc', 'public/.env.local', 'secrets.json', 'lunchmoney.dat',
    'scripts/local-config.json', 'docs/connectivity/provider-account-map.local.json']) {
    const filename = path.join(directory, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, name === '.env' ? '' : `DEMO_CANARY=${refusalValue}`, { flag: 'wx' });
    try {
      await expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory), refusedFile);
    } finally { fs.unlinkSync(filename); }
    console.log(`PASS  demo refuses a checkout containing ${name}`);
  }
  await checkAssetRefusal(directory);
  for (const name of ['data.json', 'public/periods.json', 'raw', 'derived', 'snapshots']) {
    const filename = path.join(directory, name);
    const file = name.endsWith('.json');
    if (file) fs.writeFileSync(filename, 'forbidden invented canary', { flag: 'wx' });
    else fs.mkdirSync(filename);
    try {
      await expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory), refusedHousehold);
    } finally {
      if (file) fs.unlinkSync(filename);
      else fs.rmdirSync(filename);
    }
    console.log(`PASS  demo refuses a checkout containing ${name}`);
  }
  for (const name of ['statements', 'statements-invented', 'public/statements-invented']) {
    await withStatementDirectory(directory, name, () =>
      expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory), refusedHousehold));
    console.log(`PASS  demo refuses ${name} without opening it or listing its contents`);
  }

  const demo = launch({ ATLAS_DEMO: '1' }, preload, directory);
  try {
    const base = await demo.ready;
    for (const route of ['/', '/index.html']) {
      const r = await fetch(base + route);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('set-cookie'), null);
      assert.match(await r.text(), /Demo — made-up numbers, not a real household\./);
    }
    for (const route of ['/data.json', '/data.json?refresh=force&fixture=other']) {
      assert.deepEqual(await (await fetch(base + route)).json(), fixture.data);
    }
    assert.equal(await (await fetch(base + '/periods.json')).json(), fixture.periods);
    const forecast = await (await fetch(base + '/forecast.js')).text();
    assert.match(forecast, /const SEASPAN_CURRENT_ANNUAL = NaN;/);
    assert.match(forecast, /SEASPAN_OBSERVED_SALARY_REGIMES = \[\], SEASPAN_OBSERVED_BONUS_GROSS = \{\}/);
    assert.match(forecast, /isOwnerConfirmedFuelTransaction\(tx\) \{ return tx\?\.ownerConfirmedFuel === true; \}/);
    assert.match(forecast, /isOwnerConfirmedSpotifyTransaction\(tx\) \{ return tx\?\.ownerConfirmedSpotify === true; \}/);
    assert.match(forecast, /isOwnerConfirmedNobleOccurrence\(tx\) \{ return tx\?\.ownerConfirmedNobleOccurrence === true; \}/);
    assert.doesNotMatch(await (await fetch(base + '/plan.js')).text(), /TELUS IS CLOSED/);
    for (const route of ['/login', '/public/periods.json', '/%70eriods.json', '/data.json::%24DATA',
      '/raw/', '/derived/', '/snapshots/', '/balance-history.json', '/test/fixtures/figures-inputs/card-paid-clear.json',
      '/settlement/capability', '/assistant/current', '/assistant/mcp', '/talk/context']) {
      assert.equal((await fetch(base + route)).status, 404, route);
    }
    for (const route of ['/data.json', '/login', '/assistant/mcp', '/settlement/confirm', '/talk/ask', '/client-timing']) {
      const r = await fetch(base + route, { method: 'POST', body: '{}' });
      assert.equal(r.status, 405, route);
    }
    assert.doesNotMatch(demo.output, /Unexpected I\/O/);
    console.log('PASS  demo returns only the fixed invented data, skips login, and refuses write and provider routes');
  } finally { await demo.stop(); }

  const sourcePath = path.join(directory, 'scripts', 'demo-server.js');
  const source = fs.readFileSync(sourcePath, 'utf8').replaceAll('\r\n', '\n');
  const fileMutant = source.replace("if (privatePath === 'credential')", 'if (false)');
  assert.notEqual(fileMutant, source, 'mutation must remove the credential-file refusal');
  const dotenv = path.join(directory, '.env');
  fs.writeFileSync(dotenv, `DEMO_CANARY=${refusalValue}`, { flag: 'wx' });
  try {
    await withBytes(sourcePath, fileMutant, () =>
      assert.rejects(expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory), refusedFile),
        { code: 'ERR_ASSERTION', actual: 0, expected: 1 }));
  } finally { fs.unlinkSync(dotenv); }
  console.log('PASS  dotenv guard mutant is caught by the same refusal assertion');
  const statementMutant = source.replace("if (/^statements(?:$|-)/i.test(entry.name)) return 'household';",
    'if (/^statements(?:$|-)/i.test(entry.name)) continue;');
  assert.notEqual(statementMutant, source, 'mutation must skip the statement directory refusal');
  await withBytes(sourcePath, statementMutant, () => withStatementDirectory(directory, 'statements-invented', () =>
    assert.rejects(expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory), refusedHousehold),
      { code: 'ERR_ASSERTION', actual: 0, expected: 1 })));
  console.log('PASS  statement directory guard mutant is caught by the same refusal assertion');
  const listMutant = source.replace("if (/^statements(?:$|-)/i.test(entry.name)) return 'household';",
    "if (/^statements(?:$|-)/i.test(entry.name)) { fs.readdirSync(path.join(directory, entry.name)); return 'household'; }");
  assert.notEqual(listMutant, source, 'mutation must list a statement directory before refusing');
  await withBytes(sourcePath, listMutant, () => withStatementDirectory(directory, 'statements-invented', () =>
    expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory), 'Unexpected I/O in demo proof')));
  console.log('PASS  the I/O tripwire catches a mutant that lists statement contents before refusing');
  const mutant = source.replace(' || Object.keys(environment).some(key => !BOOT_ENV.has(key.toUpperCase()))', '');
  assert.notEqual(mutant, source, 'mutation must remove the environment refusal');
  fs.writeFileSync(sourcePath, mutant);
  await assert.rejects(expectRefusal(launch({ ATLAS_DEMO: '1', SITE_PASSWORD: refusalValue }, preload, directory),
    refusedEnv), { code: 'ERR_ASSERTION', actual: 0, expected: 1 });
  console.log('PASS  environment guard mutant is caught by the same refusal assertion');
}

async function checkLosslessAssetProtection(directory) {
  const approved = loadApprovedAssets(path.join(directory, DIGESTS_REL));
  const textAsset = 'public/forecast.js';
  const textPath = path.join(directory, textAsset);
  const original = fs.readFileSync(textPath);
  const text = original.toString('utf8');
  const lines = text.split('\n');
  assert.ok(lines.length > 50, 'prepared forecast.js must have multiple lines');
  const pivot = lines.findIndex((line, i) => i > 10 && line.trim().length > 5);
  assert.ok(pivot > 10, 'must find a non-empty line to mutate');
  const swapped = [...lines];
  [swapped[pivot], swapped[pivot + 1]] = [swapped[pivot + 1], swapped[pivot]];
  const mutations = [
    ['edited byte', Buffer.from(text.replace(lines[pivot], lines[pivot] + ' '))],
    ['added line', Buffer.from([...lines.slice(0, pivot), 'void 0;', ...lines.slice(pivot)].join('\n'))],
    ['deleted line', Buffer.from([...lines.slice(0, pivot), ...lines.slice(pivot + 1)].join('\n'))],
    ['reordered lines', Buffer.from(swapped.join('\n'))],
    ['duplicated line', Buffer.from([...lines.slice(0, pivot + 1), lines[pivot], ...lines.slice(pivot + 1)].join('\n'))],
    ['trailing newline flip', text.endsWith('\n') ? original.subarray(0, original.length - 1) : Buffer.concat([original, Buffer.from('\n')])],
    ['CRLF injection', Buffer.from(text.replace('\n', '\r\n'))],
  ];
  for (const [label, mutated] of mutations) {
    assert.notDeepEqual(mutated, original, `${label} must change bytes`);
    assert.throws(() => verifyAsset(textAsset, mutated, approved),
      { message: `Unexpected demo asset contents: ${textAsset}` }, label);
  }
  await withBytes(textPath, mutations[0][1], () => expectRefusal(
    launch({ ATLAS_DEMO: '1' }, preload, directory), `Unexpected demo asset contents: ${textAsset}`));

  const binaryAsset = 'public/icon-192.png';
  const binaryPath = path.join(directory, binaryAsset);
  const binaryOriginal = fs.readFileSync(binaryPath);
  const binaryMutated = Buffer.from(binaryOriginal);
  binaryMutated[binaryMutated.length - 1] ^= 0xff;
  assert.throws(() => verifyAsset(binaryAsset, binaryMutated, approved),
    { message: `Unexpected demo asset contents: ${binaryAsset}` });
  await withBytes(binaryPath, binaryMutated, () => expectRefusal(
    launch({ ATLAS_DEMO: '1' }, preload, directory), `Unexpected demo asset contents: ${binaryAsset}`));
  console.log('PASS  whole-file SHA-256 digests catch every text and binary byte mutation');
}

async function checkDigestDirectoryFailClosed(directory) {
  const digestsDir = path.join(directory, DIGESTS_REL);
  const sampleName = 'public/display-name.js';
  const sampleDigestPath = path.join(digestsDir, sampleName + '.sha256');
  const sampleOriginal = fs.readFileSync(sampleDigestPath);

  // Missing digest file fails startup.
  fs.unlinkSync(sampleDigestPath);
  try {
    await expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory), `Missing demo asset digest: ${sampleName}`);
  } finally { fs.writeFileSync(sampleDigestPath, sampleOriginal); }

  // Stray non-digest file fails startup.
  const strayText = path.join(digestsDir, 'stray.txt');
  fs.writeFileSync(strayText, 'invented\n', { flag: 'wx' });
  try {
    await expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory), 'Unexpected demo digest file: stray.txt');
  } finally { fs.unlinkSync(strayText); }

  // Stray unknown asset digest file fails startup.
  const strayDigest = path.join(digestsDir, 'public', 'unknown.js.sha256');
  fs.writeFileSync(strayDigest, 'a'.repeat(64) + '\n', { flag: 'wx' });
  try {
    await expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory),
      'Unexpected demo digest file: public/unknown.js.sha256');
  } finally { fs.unlinkSync(strayDigest); }

  // Malformed hash fails startup.
  await withBytes(sampleDigestPath, Buffer.from('not-a-sha256\n'), () =>
    expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory),
      `Malformed demo asset digest: ${sampleName}.sha256`));

  // Multi-line digest files (text and binary alike) fail startup.
  for (const name of [sampleName, 'public/icon-192.png']) {
    const digestPath = path.join(digestsDir, name + '.sha256');
    const originalText = fs.readFileSync(digestPath, 'utf8');
    await withBytes(digestPath, Buffer.from(originalText + originalText), () =>
      expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory),
        `Malformed demo asset digest: ${name}.sha256`));
  }

  // Tampered hash fails startup.
  const tampered = sampleOriginal.toString('utf8').replace(/^[0-9a-f]{64}/, '0'.repeat(64));
  await withBytes(sampleDigestPath, Buffer.from(tampered), () =>
    expectRefusal(launch({ ATLAS_DEMO: '1' }, preload, directory),
      `Unexpected demo asset contents: ${sampleName}`));
  console.log('PASS  missing, stray, malformed, multi-line and tampered digest files fail closed at startup');
}

function copyDemoSourceTree(destination) {
  const files = [
    'server.js', 'package.json', 'package-lock.json', 'scripts/demo-server.js',
    ...ASSET_FILES,
    ...ASSET_FILES.map(name => `${DIGESTS_REL}/${name}.sha256`),
  ];
  for (const name of files) {
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, name), target);
  }
}

function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  return env;
}

function runDemoDigests(root, args, extraDeps = {}) {
  const lines = [];
  const code = DemoDigests.main(args, { root, ...extraDeps }, line => lines.push(line));
  return { code, out: lines.join('\n') };
}

function checkDigestScriptAndGitMerges() {
  assert.ok(!fs.existsSync(path.join(ROOT, 'scripts/demo-asset-digests.json')),
    'retired single-file scripts/demo-asset-digests.json must not exist');
  for (const file of fs.readdirSync(path.join(ROOT, '.github/workflows'))) {
    const body = fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
    assert.doesNotMatch(body, /demo-asset-digests\.js.*--write/, `${file} must never auto-write demo digests`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), /demo-asset-digests\.js.*--write/);

  const repoCheck = runDemoDigests(ROOT, ['--check']);
  assert.equal(repoCheck.code, 0, repoCheck.out);
  for (const name of ASSET_FILES) {
    const raw = fs.readFileSync(path.join(ROOT, DIGESTS_REL, name + '.sha256'), 'utf8').replaceAll('\r\n', '\n');
    assert.match(raw, /^[0-9a-f]{64}\n$/, `${name}.sha256 must hold one whole-file SHA-256`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-demo-digests-'));
  try {
    const tree = path.join(tmp, 'repo');
    fs.mkdirSync(tree);
    copyDemoSourceTree(tree);
    const gitEnv = cleanGitEnv();
    const git = (...args) => spawnSync('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false',
      '-c', 'user.name=invented', '-c', 'user.email=invented@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main',
      ...args,
    ], { cwd: tree, env: gitEnv, encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    assert.equal(git('add', '-A').status, 0);
    assert.equal(git('commit', '-q', '-m', 'base').status, 0);

    // 1. Unapproved edit fails --check and packageDemo without writing; privacy hit blocks --write.
    const displayPath = path.join(tree, 'public/display-name.js');
    const displayBefore = fs.readFileSync(displayPath, 'utf8');
    const digestBefore = fs.readFileSync(path.join(tree, DIGESTS_REL, 'public/display-name.js.sha256'), 'utf8');
    const canary = 'invented privacy canary';
    fs.writeFileSync(displayPath, displayBefore + `\nconst demoCheckNote = ${JSON.stringify(canary)};\n`);
    const unapprovedCheck = runDemoDigests(tree, ['--check']);
    assert.equal(unapprovedCheck.code, 1, 'unapproved edit must fail --check');
    assert.match(unapprovedCheck.out, /CHANGED {2}public\/display-name\.js/);
    assert.equal(fs.readFileSync(path.join(tree, DIGESTS_REL, 'public/display-name.js.sha256'), 'utf8'),
      digestBefore, '--check must not write');
    assert.throws(() => packageDemo(path.join(tmp, 'pkg-unapproved'), tree),
      { message: 'Unexpected demo asset contents: public/display-name.js' });
    const blockedFingerprints = [...HOUSEHOLD_FINGERPRINTS,
      { len: canary.length, cls: 'alphaspace', sha256: fingerprintOf(canary) }];
    assert.throws(() => runDemoDigests(tree, ['--write'], { fingerprints: blockedFingerprints }),
      { message: 'Demo asset rejected by privacy guard: public/display-name.js' });
    assert.equal(fs.readFileSync(path.join(tree, DIGESTS_REL, 'public/display-name.js.sha256'), 'utf8'),
      digestBefore, 'privacy failure must leave digest files untouched');
    fs.writeFileSync(displayPath, displayBefore);

    // 2. Two PRs touching different demo assets merge cleanly and pass --check and packageDemo.
    assert.equal(git('checkout', '-q', '-b', 'diff-a', 'main').status, 0);
    fs.writeFileSync(displayPath, displayBefore + '\nconst demoBranchA = 1;\n');
    const writeA = runDemoDigests(tree, ['--write']);
    assert.equal(writeA.code, 0, writeA.out);
    assert.match(writeA.out, /CHANGED {2}public\/display-name\.js/);
    assert.match(writeA.out, /Wrote 1 file under scripts\/demo-asset-digests\/: public\/display-name\.js\./);
    assert.equal(git('add', '-A').status, 0);
    assert.equal(git('commit', '-q', '-m', 'diff-a').status, 0);

    assert.equal(git('checkout', '-q', '-b', 'diff-b', 'main').status, 0);
    const cssPath = path.join(tree, 'public/atlas-toolbar.css');
    fs.writeFileSync(cssPath, fs.readFileSync(cssPath, 'utf8') + '\n.demo-branch-b { opacity: 1; }\n');
    const writeB = runDemoDigests(tree, ['--write']);
    assert.equal(writeB.code, 0, writeB.out);
    assert.match(writeB.out, /CHANGED {2}public\/atlas-toolbar\.css/);
    assert.match(writeB.out, /Wrote 1 file under scripts\/demo-asset-digests\/: public\/atlas-toolbar\.css\./);
    assert.equal(git('add', '-A').status, 0);
    assert.equal(git('commit', '-q', '-m', 'diff-b').status, 0);

    assert.equal(git('checkout', '-q', 'diff-a').status, 0);
    const mergeDiff = git('merge', '-q', '--no-edit', 'diff-b');
    assert.equal(mergeDiff.status, 0, 'different demo assets must merge cleanly: ' + mergeDiff.stderr);
    assert.equal(runDemoDigests(tree, ['--check']).code, 0);
    packageDemo(path.join(tmp, 'pkg-diff-merged'), tree);

    // Negative control: the retired single-file JSON manifest conflicts when two PRs edit adjacent assets.
    const control = path.join(tmp, 'old-manifest');
    fs.mkdirSync(control);
    const gitOld = (...args) => spawnSync('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false',
      '-c', 'user.name=invented', '-c', 'user.email=invented@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main',
      ...args,
    ], { cwd: control, env: gitEnv, encoding: 'utf8' });
    const writeSingleManifest = (cardHash, forecastHash) => {
      fs.writeFileSync(path.join(control, 'demo-asset-digests.json'), JSON.stringify({
        'public/forecast-card-period.js': cardHash,
        'public/forecast.js': forecastHash,
      }, null, 2) + '\n');
    };
    assert.equal(gitOld('init', '-q').status, 0);
    writeSingleManifest('1'.repeat(64), '2'.repeat(64));
    assert.equal(gitOld('add', '-A').status, 0);
    assert.equal(gitOld('commit', '-q', '-m', 'base').status, 0);
    assert.equal(gitOld('checkout', '-q', '-b', 'a').status, 0);
    writeSingleManifest('a'.repeat(64), '2'.repeat(64));
    assert.equal(gitOld('add', '-A').status, 0);
    assert.equal(gitOld('commit', '-q', '-m', 'a').status, 0);
    assert.equal(gitOld('checkout', '-q', '-b', 'b', 'main').status, 0);
    writeSingleManifest('1'.repeat(64), 'b'.repeat(64));
    assert.equal(gitOld('add', '-A').status, 0);
    assert.equal(gitOld('commit', '-q', '-m', 'b').status, 0);
    assert.equal(gitOld('checkout', '-q', 'a').status, 0);
    const oldMerge = gitOld('merge', '-q', '--no-edit', 'b');
    assert.notEqual(oldMerge.status, 0, 'control: old single-file manifest conflicts on adjacent asset edits');
    assert.equal(gitOld('diff', '--name-only', '--diff-filter=U').stdout.trim(), 'demo-asset-digests.json');

    // 3. Reviewer's regression case: two branches making non-adjacent edits to public/forecast.js,
    // each refreshed on its own branch, must NOT pass when merged without whole-file re-approval.
    assert.equal(git('checkout', '-q', 'main').status, 0);
    const forecastPath = path.join(tree, 'public/forecast.js');
    const forecastDigestPath = path.join(tree, DIGESTS_REL, 'public/forecast.js.sha256');
    const forecastBase = fs.readFileSync(forecastPath, 'utf8').replaceAll('\r\n', '\n');
    const forecastLines = forecastBase.split('\n');
    assert.ok(forecastLines.length > 8200, 'forecast.js must span both reviewer edit sites');
    const insertBefore = (text, lineNumber, added) => {
      const l = text.split('\n');
      l.splice(lineNumber - 1, 0, added);
      return l.join('\n');
    };

    assert.equal(git('checkout', '-q', '-b', 'same-a', 'main').status, 0);
    fs.writeFileSync(forecastPath, insertBefore(forecastBase, 601, '  '));
    assert.equal(runDemoDigests(tree, ['--check']).code, 1);
    const writeSameA = runDemoDigests(tree, ['--write']);
    assert.equal(writeSameA.code, 0, writeSameA.out);
    assert.match(writeSameA.out, /CHANGED {2}public\/forecast\.js/);
    const digestSameA = fs.readFileSync(forecastDigestPath, 'utf8');
    assert.equal(git('add', '-A').status, 0);
    assert.equal(git('commit', '-q', '-m', 'same-a').status, 0);

    assert.equal(git('checkout', '-q', '-b', 'same-b', 'main').status, 0);
    fs.writeFileSync(forecastPath, insertBefore(forecastBase, 8101, '  '));
    assert.equal(runDemoDigests(tree, ['--check']).code, 1);
    const writeSameB = runDemoDigests(tree, ['--write']);
    assert.equal(writeSameB.code, 0, writeSameB.out);
    assert.match(writeSameB.out, /CHANGED {2}public\/forecast\.js/);
    const digestSameB = fs.readFileSync(forecastDigestPath, 'utf8');
    assert.equal(git('add', '-A').status, 0);
    assert.equal(git('commit', '-q', '-m', 'same-b').status, 0);

    assert.equal(git('checkout', '-q', 'same-a').status, 0);
    const mergeSame = git('merge', '-q', '--no-edit', 'same-b');
    assert.notEqual(mergeSame.status, 0, 'merging two branches that edited forecast.js must conflict on its digest');
    assert.equal(git('diff', '--name-only', '--diff-filter=U').stdout.trim(),
      `${DIGESTS_REL}/public/forecast.js.sha256`,
      'source merges cleanly while the single whole-file forecast.js digest conflicts');
    // Leaving conflict markers fails --check and packageDemo closed.
    assert.throws(() => runDemoDigests(tree, ['--check']), /Malformed demo asset digest/);
    assert.throws(() => packageDemo(path.join(tmp, 'pkg-conflict-markers'), tree), /Malformed demo asset digest/);
    // Keeping either parent's approved whole-file digest without re-approval MUST fail --check and packageDemo.
    const combinedPrepared = prepareAsset('public/forecast.js', fs.readFileSync(forecastPath), fixture);
    const combinedHash = assetDigest(combinedPrepared);
    assert.notEqual(combinedHash + '\n', digestSameA);
    assert.notEqual(combinedHash + '\n', digestSameB);
    for (const kept of [digestSameA, digestSameB]) {
      fs.writeFileSync(forecastDigestPath, kept);
      const staleCheck = runDemoDigests(tree, ['--check']);
      assert.equal(staleCheck.code, 1, 'combined forecast.js must fail --check against either parent digest');
      assert.match(staleCheck.out, /CHANGED {2}public\/forecast\.js/);
      assert.throws(() => packageDemo(path.join(tmp, 'pkg-kept-side-' + randomUUID()), tree),
        { message: 'Unexpected demo asset contents: public/forecast.js' });
    }
    // One-command refresh explicitly re-approves the combined file and reports exactly which asset changed.
    const writeCombined = runDemoDigests(tree, ['--write']);
    assert.equal(writeCombined.code, 0, writeCombined.out);
    assert.match(writeCombined.out, /CHANGED {2}public\/forecast\.js/);
    assert.match(writeCombined.out, /Wrote 1 file under scripts\/demo-asset-digests\/: public\/forecast\.js\./);
    assert.equal(fs.readFileSync(forecastDigestPath, 'utf8'), combinedHash + '\n');
    assert.equal(runDemoDigests(tree, ['--check']).code, 0);
    packageDemo(path.join(tmp, 'pkg-same-reapproved'), tree);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('PASS  per-asset whole-file digests merge cleanly across assets and require explicit re-approval for a combined asset');
}

async function main() {
  checkDigestScriptAndGitMerges();
  const { directory, clean } = demoPackage();
  try {
    await checkLosslessAssetProtection(directory);
    await checkDigestDirectoryFailClosed(directory);
    await checkDemo(directory);
  } finally { clean(); }

  // Real composition, isolated with invented test login values. No request
  // in this test authenticates or reads canonical household data.
  const password = randomUUID();
  const sessionSecret = randomUUID();
  const production = launch({ ATLAS_DEMO: 'true', SITE_PASSWORD: password, SESSION_SECRET: sessionSecret }, preload);
  try {
    const base = await production.ready;
    const headers = { 'X-Atlas-Demo': '1', ATLAS_DEMO: '1',
      Cookie: 'ATLAS_DEMO=1; atlas_demo=1; demo=1; hfd_session=invented-invalid' };
    const query = '?ATLAS_DEMO=1&atlas_demo=1&demo=1';
    let r = await fetch(base + '/' + query, { headers, redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');
    r = await fetch(base + '/data.json' + query, { headers, redirect: 'manual' });
    assert.equal(r.status, 401);
    assert.doesNotMatch(await r.text(), /stack-card-summary|Synthetic Budget surface/);
    r = await fetch(base + '/login' + query, { headers });
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    const login = await r.text();
    assert.match(login, /Password/);
    assert.doesNotMatch(login, /made-up numbers/);
    console.log('PASS  an inexact startup flag and request query, headers and cookies leave production gated');
  } finally { await production.stop(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
