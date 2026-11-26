'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { launch, demoPackage } = require('./lib/demo-process');
const fixture = require('./fixtures/figures-inputs/stack-card-summary.json');
const { checkDemoPrivacy } = require('../scripts/package-demo');
const { fingerprintOf, HOUSEHOLD_FINGERPRINTS } = require('../scripts/privacy-guard');

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

async function main() {
  const { directory, clean } = demoPackage();
  try { await checkDemo(directory); } finally { clean(); }

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
