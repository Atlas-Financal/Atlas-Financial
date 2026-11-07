#!/usr/bin/env node
'use strict';
// Atlas 1.0 acceptance scoreboard.  `npm run scoreboard`
//
// Runs every end-to-end scenario in test/acceptance/check-*.js against the
// current build and prints, for each of the seven Budget checks, how many
// scenarios pass. It is a scoreboard, not a gate: it always exits 0 and is
// not part of `npm test` or any required CI check.
//
// A scenario marked with `fixedBy` is expected to fail until that PR or work
// slot lands. It still runs; the table shows it as failing with its slot so
// a pass is noticed the day it happens.
//
//   node scripts/acceptance-scoreboard.js [--json <path>] [--check <n>] [--verbose]
//
// The JSON (counts, scenario ids, pass/fail and short failure reasons) goes
// to --json, or to the OS temp directory. It holds invented scenario text
// only: no household figure enters any scenario.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'test', 'acceptance');
const TIMEOUT_MS = 90000;

function args(argv) {
  const out = { json: path.join(os.tmpdir(), 'atlas-acceptance-scoreboard.json'), check: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') out.json = argv[++i];
    else if (argv[i] === '--check') out.check = Number(argv[++i]);
    else if (argv[i] === '--verbose') out.verbose = true;
  }
  return out;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
  })]).finally(() => clearTimeout(timer));
}

function short(err) {
  const msg = String(err && err.message || err).split('\n')[0];
  return msg.length > 220 ? msg.slice(0, 217) + '...' : msg;
}

async function runCheck(mod, H, opts) {
  const results = [];
  for (const sc of mod.scenarios) {
    const started = Date.now();
    let pass = false, reason = null;
    try {
      // Period-history captures belong to one scenario (#818).
      if (typeof H.resetCaptures === 'function') H.resetCaptures();
      await withTimeout(Promise.resolve().then(() => sc.run(H)), TIMEOUT_MS);
      pass = true;
    } catch (err) {
      reason = (err instanceof H.ScenarioFailure ? '' : 'error: ') + short(err);
    }
    const row = { id: sc.id, name: sc.name, basis: sc.basis || 'derived', pass, fixedBy: sc.fixedBy || null, reason, ms: Date.now() - started };
    if (pass && sc.fixedBy) row.note = `passes although marked for ${sc.fixedBy}: remove the mark`;
    results.push(row);
    if (opts.verbose) console.error(`${pass ? 'PASS' : 'FAIL'} ${sc.id} ${sc.name}${reason ? ' -- ' + reason : ''}`);
  }
  return results;
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

async function main() {
  const opts = args(process.argv.slice(2));
  const H = require(path.join(DIR, 'harness.js'));
  const files = fs.readdirSync(DIR).filter(f => /^check-\d+\.js$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const checks = [];
  try {
    for (const file of files) {
      const number = Number(file.match(/\d+/)[0]);
      if (opts.check && number !== opts.check) continue;
      let mod, scenarios;
      try {
        mod = require(path.join(DIR, file));
        scenarios = await runCheck(mod, H, opts);
      } catch (err) {
        // One broken check file must not hide the others.
        mod = mod || { check: number, title: file };
        scenarios = [{ id: `${number}.?`, name: 'check failed to load or run', pass: false, fixedBy: null, reason: 'error: ' + short(err) }];
      }
      const adopted = scenarios.filter(s => ['spec', 'blueprint'].includes(s.basis));
      checks.push({ check: mod.check, title: mod.title, passing: scenarios.filter(s => s.pass).length,
        total: scenarios.length, specPassing: adopted.filter(s => s.pass).length, specTotal: adopted.length, scenarios });
    }
  } finally {
    await H.closeBrowser().catch(() => {});
  }

  let headSha = null;
  try { headSha = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a checkout */ }

  console.log('Atlas 1.0 acceptance scoreboard' + (headSha ? ` @ ${headSha.slice(0, 12)}` : ''));
  console.log('');
  console.log(pad('Check', 6) + pad('Outcome', 56) + pad('All', 8) + 'Adopted spec');
  console.log('-'.repeat(82));
  for (const c of checks) console.log(pad(c.check, 6) + pad(c.title, 56) + pad(`${c.passing}/${c.total}`, 8) + `${c.specPassing}/${c.specTotal}`);
  const sum = key => checks.reduce((n, c) => n + c[key], 0);
  const passing = sum('passing'), total = sum('total'), specPassing = sum('specPassing'), specTotal = sum('specTotal');
  console.log('-'.repeat(82));
  console.log(pad('', 6) + pad('All scenarios', 56) + pad(`${passing}/${total}`, 8) + `${specPassing}/${specTotal}`);
  console.log('');
  console.log('Adopted spec = scenarios taken from the adopted spec (#787 6622324225) or its blueprints;');
  console.log('the rest are derived guards and audit repros.');
  console.log('');
  for (const c of checks) {
    const failing = c.scenarios.filter(s => !s.pass);
    if (!failing.length) continue;
    console.log(`Check ${c.check} failing:`);
    for (const s of failing) console.log(`  ${pad(s.id, 5)} ${s.name}${s.fixedBy ? `  [${s.fixedBy}]` : '  [no slot]'}`);
  }
  const surprises = checks.flatMap(c => c.scenarios.filter(s => s.note));
  if (surprises.length) {
    console.log('');
    console.log('Now passing although marked as expected to fail:');
    for (const s of surprises) console.log(`  ${s.id} ${s.name} [${s.fixedBy}]`);
  }

  const report = { schema: 'atlas-acceptance-scoreboard/v1', generatedAt: new Date().toISOString(), head: headSha,
    passing, total, specPassing, specTotal, checks };
  try {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify(report, null, 2) + '\n');
    console.log('');
    console.log('JSON: ' + opts.json);
  } catch (err) {
    console.log('JSON not written: ' + short(err));
  }
}

main().catch(err => { console.error('scoreboard error: ' + short(err)); }).finally(() => { process.exitCode = 0; });
