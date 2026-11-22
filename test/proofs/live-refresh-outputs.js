'use strict';
// Full private comparison for a refresh change (Node version must match).
// In a clean worktree of the base, copy in scripts/live-refresh-benchmark.js
// if absent, make dependencies available, then run this same script from each
// revision's repository root. Use a new directory under a private parent.
//   (cd "$base" && node "$head/test/proofs/live-refresh-outputs.js" --capture "$private/before")
//   (cd "$head" && node test/proofs/live-refresh-outputs.js --compare "$private/before")
// Only completion counts go to the terminal. Keep the captures out of git.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { isDeepStrictEqual } = require('node:util');
const { serialize, deserialize } = require('node:v8');

async function serveBody(createApplication, data) {
  const env = {
    SITE_PASSWORD: crypto.randomBytes(24).toString('hex'),
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  };
  const app = createApplication(data === undefined ? { env } : { env, baseSource: async () => data });
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const login = await fetch(base + '/login', {
      method: 'POST', body: new URLSearchParams({ password: env.SITE_PASSWORD }), redirect: 'manual',
    });
    assert.equal(login.status, 302);
    const response = await fetch(base + '/data.json', {
      headers: { cookie: login.headers.get('set-cookie').split(';')[0], 'accept-encoding': 'identity' },
    });
    assert.equal(response.status, 200);
    return await response.text();
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  const [mode, directory] = process.argv.slice(2);
  assert(['--capture', '--compare'].includes(mode) && path.isAbsolute(directory));
  const outsideRepo = path.relative(process.cwd(), fs.realpathSync(path.dirname(directory))).split(path.sep)[0] === '..';
  assert(outsideRepo, 'private outputs must be outside the checkout');
  if (mode === '--capture') fs.mkdirSync(directory, { mode: 0o700 });
  const load = createRequire(path.resolve('package.json'));
  const figures = load('./scripts/figures-snapshot');
  const Benchmark = load('./scripts/live-refresh-benchmark');
  const F = load('./public/forecast');
  const { createPreactivationApplication } = load('./server');
  const names = [];
  function snapshot(name, value) {
    const file = path.join(directory, name + '.v8');
    names.push(path.basename(file));
    if (mode === '--capture') {
      fs.writeFileSync(file, serialize(value), { flag: 'wx', mode: 0o600 });
    } else if (!isDeepStrictEqual(deserialize(fs.readFileSync(file)), value)) {
      throw new Error('Full output changed for ' + name);
    }
  }
  async function capturePage(name, data, periods) {
    const body = await serveBody(createPreactivationApplication, data);
    const served = JSON.parse(body);
    const forecast = F.recommend(served.plan, served.meta.asOf, figures.pageOptions(served, periods));
    // The raw JSON also guards object key order. The full object includes
    // fields (e.g. undefined) that JSON serialization can discard.
    snapshot(name, { body, forecast, forecastJson: JSON.stringify(forecast) });
  }
  const opening = figures.loadCanonicalInputs();
  const invented = figures.loadInventedInputs();
  snapshot('figures-check', JSON.stringify(figures.buildCheckSnapshot(opening, invented), null, 2) + '\n');
  await capturePage('dated-opening', undefined, opening.periods);
  for (const { id, doc } of invented) await capturePage('fixture-' + id, doc.data, doc.periods);
  for (const name of Benchmark.CASE_NAMES) {
    const input = Benchmark.buildCase(name);
    const { data, forecast } = await Benchmark.runCase(input);
    // On a cold qualified/complete read the worker supplies the published
    // base document. Exercise the real browser route with that base source.
    assert(load('./scripts/server-observation-memory').completeTransactionCohort(data));
    snapshot('worker-' + name, { forecast, forecastJson: JSON.stringify(forecast), data: JSON.stringify(data) });
    await capturePage('served-' + name, data, input.periods);
  }
  assert(isDeepStrictEqual(fs.readdirSync(directory).sort(), names.sort()));
  console.log(mode.slice(2) + ' completed for ' + names.length + ' complete snapshots.');
}

main().catch(error => {
  // Assertion and dependency errors can carry household values.
  const failure = /^Full output changed for [a-z0-9-]+$/.test(error.message)
    ? error.message : 'Could not complete private output comparison.';
  console.error(failure);
  process.exitCode = 1;
});
