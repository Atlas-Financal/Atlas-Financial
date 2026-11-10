'use strict';
// Source-kind boundaries use invented credentials only. A child-only preload
// substitutes the trusted resolver result, never reads or creates a real file.
const threads = require('node:worker_threads');
if (!threads.isMainThread && process.env.ATLAS_SYNTHETIC_FILE_CREDENTIAL === '1') {
  require('../scripts/provider-observe').resolveLiveCredential = async () => ({
    token: 'SYNTHETIC-FILE-CREDENTIAL', source: 'windows-dpapi',
  });
} else if (require.main === module) {
  const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os');
  const path = require('node:path'), { execFileSync } = require('node:child_process');
  const kind = process.argv[2];
  if (!kind) {
    for (const scenario of ['file-capture', 'env-capture-file-read', 'map-file', 'map-env']) {
      execFileSync(process.execPath, [__filename, scenario], { stdio: 'inherit' });
    }
    console.log('Latest complete source kind: capture/read ENV-only and current map content checks passed.');
  } else (async () => {
    const Fixture = require('./fixtures/budget-surface-data'), helpers = require('./test-server-observation-memory');
    const Provider = require('../scripts/provider-observe');
    const exits = [], Real = threads.Worker;
    threads.Worker = class extends Real { constructor(...args) { super(...args); exits.push(new Promise(r => this.once('exit', r))); } };
    const Refresh = require('../scripts/server-live-refresh');
    const originalNow = Date.now; Date.now = () => Date.parse(helpers.CLOCK);
    const mock = await helpers.provider({ accountId: 501 }), env = helpers.environment(mock.base);
    const fileEnv = { ...env, NODE_OPTIONS: '--require "' + __filename.replace(/\\/g, '/') + '"', ATLAS_SYNTHETIC_FILE_CREDENTIAL: '1' };
    delete fileEnv.LUNCHMONEY_ACCESS_TOKEN;
    const canonical = Fixture.canonical(), drain = () => Promise.all(exits);
    const read = async source => { const data = await Refresh.serve(canonical, source); await drain(); return data; };
    let directory;
    try {
      if (kind === 'file-capture') {
        const fileComplete = await read(fileEnv); assert.equal(fileComplete.liveOverlay.applied, true);
        mock.mode('failure'); const switchedEnvFailure = await read(env);
        assert.equal(switchedEnvFailure.liveOverlay.retainedRefresh, undefined, 'file-origin complete never unlocked by later ENV /me failure');
        assert.equal(switchedEnvFailure.liveOverlay.operatingPlan, 'unavailable');
      } else if (kind === 'env-capture-file-read') {
        const complete = await read(env); mock.mode('failure');
        assert.equal((await read(fileEnv)).liveOverlay.retainedRefresh, undefined, 'ENV-origin refuses current file credential source');
        let release; const writing = Refresh.withProviderWrite(() => new Promise(r => { release = r; }));
        try { await assert.rejects(Refresh.serve(canonical, fileEnv, { forceRefresh: true }), e => e.code === 'live-refresh-invalidated'); }
        finally { release(); await writing; }
        const returnedToEnv = await read(env);
        assert.deepEqual(returnedToEnv.plan, complete.plan); assert.ok(returnedToEnv.liveOverlay.retainedRefresh);
      } else {
        const map = { ...Fixture.map, scope: 'live' };
        const source = { ...env };
        if (kind === 'map-file') {
          directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-synthetic-map-content-'));
          fs.chmodSync(directory, 0o700); source[Provider.MAP_PATH_ENV] = path.join(directory, 'map.json');
          delete source.ATLAS_PROVIDER_ACCOUNT_MAP_JSON;
          fs.writeFileSync(source[Provider.MAP_PATH_ENV], JSON.stringify(map), { mode: 0o600 });
        }
        await read(source); mock.mode('failure');
        const changed = { ...map, owns: 'Synthetic content changed, same identity tuples' };
        if (kind === 'map-file') fs.writeFileSync(source[Provider.MAP_PATH_ENV], JSON.stringify(changed));
        else source.ATLAS_PROVIDER_ACCOUNT_MAP_JSON = JSON.stringify(changed);
        const failed = await read(source);
        assert.equal(failed.liveOverlay.retainedRefresh, undefined, 'every request compares CURRENT ' + kind + ' content');
        assert.equal(failed.liveOverlay.operatingPlan, 'unavailable');
      }
      console.log('PASS latest-complete source boundary: ' + kind);
    } finally {
      await mock.close(); await drain(); Date.now = originalNow; threads.Worker = Real;
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
