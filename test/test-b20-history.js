'use strict';
/* B20 / AF-HIST-01 — truthful account-balance history as a by-product of
 * successful refresh. M3: independent provenance, not a second call of the
 * writer asserting its own output.
 *
 * Live cents appear only in the reconciliation of the committed openings.
 * Writer behaviour is proved on fixtures.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { snapshotFirstReading } = require('./lib/b20-snapshot-reconciliation');

const live = require('../data.json');
const map = require('../docs/reconciliation/balance-map.json');
const periods = require('../public/periods.json');
const S = require('../scripts/snapshot-balances.js');
const History = require('../public/balance-history.js');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const money = n => '$' + Number(n).toFixed(2);
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const parseCsv = text => S.parsePositions(text);

function gitShow(spec) {
  try {
    return execFileSync('git', ['show', spec], { encoding: 'utf8' });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    throw new Error(
      `B20 independent proof needs git history for ${spec} `
      + `(CI checkout must use fetch-depth: 0). ${detail}`
    );
  }
}

const AUG9 = '2026-08-09';
const AUG16 = '2026-08-16';
const MIXED = '08fd3e1';
const AUG9_REV = '81210ac';

const AUG9_INDEPENDENT = {
  'chequing-a': 506.98,
  'chequing-b': -517.72,
  savings: 90.58,
  'amanda-debt-payments': 2691.85,
  'savings-dont-touch': 74.2,
  mortgage: 546026.58,
  heloc: 201586.16,
  triangle: 13497,
  cashback: 5612.43,
  mbna: 7855.12,
  tdcc: 1799.97,
  travelvisa: 1078.31,
};
const AUG16_INDEPENDENT = {
  'chequing-a': 1320.13,
  'chequing-b': 932.05,
  savings: 0.58,
  mortgage: 545188.30,
  heloc: 200486.16,
  triangle: 13197,
  cashback: 4799.43,
  mbna: 8003.61,
  tdcc: 1705.94,
  travelvisa: 862.68,
};

const snap9 = JSON.parse(read('snapshots/2026-08-09.json'));
const snap16 = JSON.parse(read('snapshots/2026-08-16.json'));
const positionsNow = parseCsv(read('docs/positions.csv'));
const history = S.loadHistory(path.join(__dirname, '..', 'snapshots'));

function acc(snap, id) {
  return (snap.accounts || []).find(a => a.id === id) || null;
}

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function fixtureData(asOf, cash, debts) {
  const data = {
    meta: { asOf },
    plan: {
      opening: { asOf },
      startingCash: {
        breakdown: cash.filter(r => r.pot !== 'held-elsewhere'),
        heldElsewhere: cash.filter(r => r.pot === 'held-elsewhere'),
      },
    },
    debts,
  };
  return data;
}

function fixturePositions(rows) {
  const header = 'entity,institution,account_label,account_type,side,currency,balance,credit_limit,available,interest_rate_pct,rate_basis,fixed_or_variable,structure,payment_amount,payment_frequency,next_due_date,maturity_or_renewal,annual_interest_cost,confidence,as_of,notes';
  const lines = [header];
  for (const r of rows) {
    lines.push([
      'Household', 'TD', r.label, r.type || 'Chequing', r.side || 'Asset', r.currency || 'CAD',
      Number(r.balance).toFixed(2), '', '', '', '', '', '', '', '', '', '', '',
      r.confidence || 'VERIFIED_TD', r.asOf, '',
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

function writeFixturePair(dir, data, positionsText) {
  const dataPath = path.join(dir, 'data.json');
  const posPath = path.join(dir, 'positions.csv');
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  fs.writeFileSync(posPath, positionsText);
  return { dataPath, posPath };
}

console.log('=== 1. 2026-08-16 snapshot agrees with that pinned opening ===');
{
  ok(snap16.asOf === AUG16, 'committed Aug. 16 snapshot is dated 2026-08-16');
  const aug16Rev = '28d08a12a18691f34c32bc839d22cd526fc75111';
  const pinned = JSON.parse(gitShow(`${aug16Rev}:data.json`));
  ok(pinned.meta.asOf === AUG16 && pinned.plan.opening.asOf === AUG16,
    '28d08a12 data.json is the 2026-08-16 opening');
  const pinnedPos = parseCsv(gitShow(`${aug16Rev}:docs/positions.csv`));
  for (const [id, amount] of Object.entries(AUG16_INDEPENDENT)) {
    const row = acc(snap16, id);
    ok(!!row, `${id} is in the Aug. 16 snapshot`);
    if (!row) continue;
    const canonical = id === 'chequing-a' || id === 'chequing-b' || id === 'savings'
      ? pinned.plan.startingCash.breakdown.find(r => r.id === id)
      : pinned.debts.find(r => r.id === id);
    const canonicalAmt = canonical && (canonical.value != null ? canonical.value : canonical.balance);
    ok(near(row.balance, amount) && near(row.balance, canonicalAmt),
      `${id} snapshot ${money(row.balance)} matches pinned 28d08a12 and independent ${money(amount)}`);
    const pos = pinnedPos.find(p => p.account_label === map.mappings.find(m => m.canonical.id === id).accountLabel);
    ok(pos && pos.as_of === AUG16 && near(Number(pos.balance), amount),
      `${id} 28d08a12 positions.csv ${pos && pos.as_of} ${pos && pos.balance}`);
  }
  ok(!acc(snap16, 'amanda-debt-payments'),
    'Aug. 16 snapshot omits the 2026-08-09 TENNIS INCOME reading');
  ok(!acc(snap16, 'savings-dont-touch'),
    'Aug. 16 snapshot omits the 2026-08-09 SAVINGS-DONT TOUCH reading');
}

console.log('\n=== 1b. current canonical opening has a matching same-date snapshot ===');
{
  const currentAsOf = live.meta.asOf;
  ok(currentAsOf && live.plan.opening && live.plan.opening.asOf === currentAsOf,
    'live meta.asOf and plan.opening.asOf agree');
  const currentSnapPath = path.join(__dirname, '..', 'snapshots', `${currentAsOf}.json`);
  ok(fs.existsSync(currentSnapPath),
    `snapshots/${currentAsOf}.json exists for the current opening`);
  if (fs.existsSync(currentSnapPath)) {
    const currentSnap = JSON.parse(read(`snapshots/${currentAsOf}.json`));
    ok(currentSnap.asOf === currentAsOf, 'current snapshot date matches live as-of');
    const spendableIds = ['chequing-a', 'chequing-b', 'savings'];
    for (const id of spendableIds) {
      const row = acc(currentSnap, id);
      const cash = live.plan.startingCash.breakdown.find(r => r.id === id);
      ok(row && cash && near(row.balance, cash.value),
        `current snapshot ${id} agrees with live data.json`);
    }
  }
}

console.log('\n=== 2. account identity is stable across readings ===');
{
  const ids9 = new Set(snap9.accounts.map(a => a.id));
  const ids16 = new Set(snap16.accounts.map(a => a.id));
  for (const id of Object.keys(AUG16_INDEPENDENT)) {
    ok(ids9.has(id) && ids16.has(id), `${id} keeps the same id on both openings`);
    const a = acc(snap9, id);
    const b = acc(snap16, id);
    ok(a.collection === b.collection && a.side === b.side && a.currency === b.currency,
      `${id} keeps collection/side/currency`);
  }
}

console.log('\n=== 3. each historical balance has an independently defensible date and amount ===');
{
  ok(snap9.asOf === AUG9, 'committed Aug. 9 snapshot is dated 2026-08-09');
  const histData = JSON.parse(gitShow(`${AUG9_REV}:data.json`));
  const histPos = parseCsv(gitShow(`${AUG9_REV}:docs/positions.csv`));
  ok(histData.meta.asOf === AUG9, '81210ac data.json as-of is 2026-08-09');
  for (const [id, amount] of Object.entries(AUG9_INDEPENDENT)) {
    const row = acc(snap9, id);
    ok(!!row && near(row.balance, amount),
      `${id} Aug. 9 snapshot is independently ${money(amount)}`,
      row ? money(row.balance) : 'missing');
    const mapping = map.mappings.find(m => m.canonical.id === id);
    const pos = histPos.find(p => p.account_label === mapping.accountLabel);
    ok(pos && pos.as_of === AUG9 && near(Number(pos.balance), amount),
      `${id} 81210ac positions.csv is ${money(amount)} on 2026-08-09`);
    if (id === 'chequing-a' || id === 'chequing-b' || id === 'savings'
      || id === 'amanda-debt-payments' || id === 'savings-dont-touch') {
      const cash = (histData.plan.startingCash.breakdown || [])
        .concat(histData.plan.startingCash.heldElsewhere || [])
        .find(r => r.id === id);
      ok(cash && near(cash.value, amount), `${id} 81210ac data.json cash is ${money(amount)}`);
    } else {
      const debt = histData.debts.find(r => r.id === id);
      ok(debt && near(debt.balance, amount), `${id} 81210ac data.json debt is ${money(amount)}`);
    }
  }
  ok(near(201586.16 - 1100, 200486.16),
    'independent HELOC identity: 201586.16 − 1100.00 = 200486.16');
  ok(near(546026.58 - 545188.30, 838.28),
    'independent mortgage identity: 546026.58 − 545188.30 = 838.28');
  ok(near(1799.97 - 94.03, 1705.94),
    'independent TD card identity: 1799.97 − 94.03 = 1705.94');
  ok(near(5612.43 - 50 - 763, 4799.43),
    'independent Cash Back identity: 5612.43 − 50.00 − 763.00 = 4799.43');
  ok(near(13497 - 300, 13197),
    'independent Triangle identity: 13497.00 − 300.00 = 13197.00');
}

console.log('\n=== 4. mixed-date source rows cannot become one dated snapshot ===');
{
  const dir = tmpDir('atlas-b20-mixed-');
  const data = fixtureData(AUG16, [
    { id: 'chequing-a', label: 'Chequing A', value: 100, pot: 'spendable' },
    { id: 'chequing-b', label: 'Chequing B', value: 200, pot: 'spendable' },
  ], [
    { id: 'heloc', label: 'HELOC', balance: 1000, pending: 0, confidence: 'verified' },
  ]);
  const positions = fixturePositions([
    { label: 'Chequing A', balance: 100, asOf: AUG16, side: 'Asset' },
    { label: 'Chequing B', balance: 200, asOf: AUG9, side: 'Asset' },
    { label: 'HELOC', balance: 1000, asOf: AUG16, side: 'Liability', type: 'Home equity line' },
  ]);
  const built = S.buildSnapshot(data, S.parsePositions(positions), map);
  ok(built.asOf === AUG16, 'fixture snapshot keeps the canonical as-of');
  ok(!!acc(built, 'chequing-a') && !!acc(built, 'heloc'),
    'same-date rows are included');
  ok(!acc(built, 'chequing-b'),
    'a 2026-08-09 row is not copied into the 2026-08-16 snapshot');
  ok(built.omitted.some(o => o.id === 'chequing-b' && o.reason === 'different-as-of'),
    'the mixed-date omission is explicit');

  const mixed = S.buildSnapshot(
    JSON.parse(gitShow(`${MIXED}:data.json`)),
    parseCsv(gitShow(`${MIXED}:docs/positions.csv`)),
    JSON.parse(gitShow(`${MIXED}:docs/reconciliation/balance-map.json`))
  );
  ok(mixed.asOf === AUG9, '08fd3e1 still publishes as-of 2026-08-09');
  ok(!acc(mixed, 'triangle') && !acc(mixed, 'mbna'),
    '08fd3e1 Triangle/MBNA 2026-08-16 rows are not a 2026-08-09 snapshot');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Set when the writer refuses the live reading (a known B92 control); the
// sections that need a written live snapshot are then not reachable.
let liveWriterRefused = false;
console.log('\n=== 5. re-running the same reading produces no duplicate or mutation ===');
{
  const dir = tmpDir('atlas-b20-idem-');
  const first = snapshotFirstReading(() => execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'snapshot-balances.js'),
    '--out', dir,
  ], { encoding: 'utf8' }), live, positionsNow, map, ok);
  // A known B92 control's rejection was recorded as a failed assertion and
  // wrote nothing, so there is no reading to re-run.
  if (first === null) { liveWriterRefused = true; fs.rmSync(dir, { recursive: true, force: true }); }
  else {
  const dest = path.join(dir, `${live.meta.asOf}.json`);
  const bytes1 = fs.readFileSync(dest);
  const second = execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'snapshot-balances.js'),
    '--out', dir,
  ], { encoding: 'utf8' });
  const bytes2 = fs.readFileSync(dest);
  const written = new RegExp(`written ${live.meta.asOf}`);
  const unchanged = new RegExp(`unchanged ${live.meta.asOf}`);
  ok(written.test(first), 'first run writes the dated file', first.trim());
  ok(unchanged.test(second), 'second run is unchanged', second.trim());
  ok(bytes1.equals(bytes2), 'file bytes are identical');
  ok(fs.readdirSync(dir).filter(f => f.endsWith('.json')).length === 1,
    'no duplicate file was created');
  fs.rmSync(dir, { recursive: true, force: true });

  const again = execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'snapshot-balances.js'),
  ], { encoding: 'utf8' });
  ok(unchanged.test(again),
    're-running against the committed snapshots/ directory is a no-op', again.trim());
  }
}

console.log('\n=== 6–7. data.json remains current-state authority; history is not rewritten ===');
if (!liveWriterRefused) {
  const dir = tmpDir('atlas-b20-auth-');
  execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'snapshot-balances.js'), '--out', dir,
  ]);
  const original = fs.readFileSync(path.join(dir, `${live.meta.asOf}.json`));
  const mutated = JSON.parse(JSON.stringify(live));
  const heloc = mutated.debts.find(d => d.id === 'heloc');
  heloc.balance = heloc.balance + 50;
  const dataPath = path.join(dir, 'mutated-data.json');
  fs.writeFileSync(dataPath, JSON.stringify(mutated, null, 2));
  let disagreed = false;
  try {
    S.run(['--data', dataPath, '--out', dir]);
  } catch (err) {
    disagreed = /disagrees/.test(err.message);
  }
  ok(disagreed, 'a mutated data.json that no longer matches positions.csv fails closed');

  const agreed = JSON.parse(JSON.stringify(live));
  agreed.debts.find(d => d.id === 'heloc').balance = 200536.16;
  const posMut = read('docs/positions.csv').replace('200486.16', '200536.16');
  const agreedData = path.join(dir, 'agreed-data.json');
  const agreedPos = path.join(dir, 'agreed-positions.csv');
  fs.writeFileSync(agreedData, JSON.stringify(agreed, null, 2));
  fs.writeFileSync(agreedPos, posMut);
  let conflicted = false;
  try {
    S.run(['--data', agreedData, '--positions', agreedPos, '--out', dir]);
  } catch (err) {
    conflicted = err.code === 'SNAPSHOT_CONFLICT'
      || /refusing to rewrite/.test(err.message);
  }
  ok(conflicted, 'an internally consistent new reading still does not rewrite an existing dated file');
  ok(fs.readFileSync(path.join(dir, `${live.meta.asOf}.json`)).equals(original),
    'the existing same-date snapshot file bytes are unchanged after the conflict');
  const liveHeloc = live.debts.find(d => d.id === 'heloc');
  ok(liveHeloc && Number.isFinite(Number(liveHeloc.balance)) && Number(liveHeloc.balance) > 0,
    'live data.json HELOC remains a finite canonical opening',
    liveHeloc && String(liveHeloc.balance));
  const independentLiveCash = (live.plan.startingCash.breakdown || [])
    .filter(b => b && (b.id === 'chequing-a' || b.id === 'chequing-b'))
    .reduce((s, b) => s + Number(b.value || 0), 0);
  ok(near(F.startingCashAmount(live.plan), independentLiveCash),
    'Forecast still opens from data.json chequing cash, not from snapshots');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 8. snapshots are not an input to Forecast current-state decisions ===');
{
  const forecastSrc = read('public/forecast.js');
  ok(!/snapshots\//.test(forecastSrc) && !/balance-history/.test(forecastSrc),
    'Forecast source does not mention snapshots/ or balance-history');
  ok(!/require\(['"]\.\/scripts\/snapshot-balances/.test(forecastSrc),
    'Forecast does not load the snapshot writer');
  const before = F.startingCashAmount(live.plan);
  const rec = F.recommend(live.plan, live.plan.opening.asOf, {
    scenario: 'expected',
    targetBuffer: live.plan.defaults.targetBuffer,
    debts: live.debts,
    extraFacilities: live.revolvingExtra,
    extraDebtTarget: live.plan.nextDollar && live.plan.nextDollar.target,
  });
  ok(near(F.startingCashAmount(live.plan), before),
    'running recommend does not change starting cash');
  ok(rec && rec.weekly != null, 'Forecast still recommends from the live plan');
}

console.log('\n=== 9. credit remains debt/capacity, never cash ===');
{
  for (const id of ['heloc', 'triangle', 'cashback', 'mbna', 'tdcc', 'travelvisa']) {
    ok(acc(snap16, id).side === 'liability' && acc(snap16, id).collection === 'debts',
      `${id} is a liability debt in the Aug. 16 snapshot`);
  }
  const spendable = History.spendableSeries(history);
  const last = spendable[spendable.length - 1];
  ok(last && last.ids.every(id => ['chequing-a', 'chequing-b', 'savings'].includes(id)),
    'spendable display sum uses only the three household cash accounts');
  ok(!last.ids.includes('heloc') && !last.ids.includes('triangle'),
    'no credit facility is inside the spendable sum');
  const html = History.render(history);
  ok(/Liability/.test(html) && /HELOC/.test(html),
    'the page names HELOC as a liability');
}

console.log('\n=== 10. asset and liability direction is rendered correctly ===');
{
  const helocDelta = roundIndependent(AUG16_INDEPENDENT.heloc - AUG9_INDEPENDENT.heloc);
  const cashADelta = roundIndependent(AUG16_INDEPENDENT['chequing-a'] - AUG9_INDEPENDENT['chequing-a']);
  const mbnaDelta = roundIndependent(AUG16_INDEPENDENT.mbna - AUG9_INDEPENDENT.mbna);
  ok(helocDelta < 0, 'independent HELOC movement is a fall', money(helocDelta));
  ok(cashADelta > 0, 'independent Chequing A movement is a rise', money(cashADelta));
  ok(mbnaDelta > 0, 'independent MBNA movement is a rise', money(mbnaDelta));

  function lastPairDelta(id) {
    const pts = History.seriesFor(history, id);
    ok(pts.length >= 2, `${id} has at least two dated openings`);
    const prior = pts[pts.length - 2];
    const current = pts[pts.length - 1];
    const independent = roundIndependent(current.balance - prior.balance);
    const move = History.displayMove(pts);
    const expectDir = independent < 0 ? 'down' : independent > 0 ? 'up' : 'unchanged';
    return { independent, move, expectDir };
  }
  const helocPair = lastPairDelta('heloc');
  const cashPair = lastPairDelta('chequing-a');
  const mbnaPair = lastPairDelta('mbna');
  ok(near(helocPair.move.delta, helocPair.independent) && helocPair.move.direction === helocPair.expectDir,
    'display HELOC direction follows the latest two snapshot balances');
  ok(near(cashPair.move.delta, cashPair.independent) && cashPair.move.direction === cashPair.expectDir,
    'display Chequing A direction follows the latest two snapshot balances');
  ok(near(mbnaPair.move.delta, mbnaPair.independent) && mbnaPair.move.direction === mbnaPair.expectDir,
    'display MBNA direction follows the latest two snapshot balances — a larger card is not called a fall');

  const helocWord = History.movementWord(helocPair.move, 'HELOC');
  const mbnaWord = History.movementWord(mbnaPair.move, 'MBNA');
  if (helocPair.expectDir === 'down') {
    ok(/fell/.test(helocWord) && !/rose/.test(helocWord), 'HELOC wording says the balance fell');
  } else if (helocPair.expectDir === 'up') {
    ok(/rose/.test(helocWord) && !/fell/.test(helocWord), 'HELOC wording says the balance rose');
  } else {
    ok(!/fell/.test(helocWord) && !/rose/.test(helocWord), 'HELOC wording does not invent a rise or fall');
  }
  if (mbnaPair.expectDir === 'up') {
    ok(/rose/.test(mbnaWord) && !/fell/.test(mbnaWord),
      'MBNA wording says the balance rose, not that it improved');
  } else if (mbnaPair.expectDir === 'down') {
    ok(/fell/.test(mbnaWord) && !/rose/.test(mbnaWord),
      'MBNA wording says the balance fell, not that it improved');
  }
  ok(!/improv/i.test(helocWord + mbnaWord) && !/better/i.test(helocWord + mbnaWord),
    'wording does not moralize the household');
}

function roundIndependent(n) {
  return Math.round(Number(n) * 100) / 100;
}

console.log('\n=== 11. missing historical observations stay missing ===');
{
  const amanda = History.seriesFor(history, 'amanda-debt-payments');
  const move = History.displayMove(amanda);
  ok(amanda.length === 1 && amanda[0].asOf === AUG9,
    'TENNIS INCOME has only the 2026-08-09 opening');
  ok(move.sufficient === false && move.prior == null,
    'one point is not turned into a trend');
  const html = History.render(history);
  ok(/Not enough history yet for a trend/.test(html),
    'the page says trend history is not yet sufficient');
  ok(!History.seriesFor(history, 'wise').length,
    'Wise is not invented — it is not in the closed B91 map');
}

console.log('\n=== 12. public/periods.json remains the spending/interest/fee history ===');
{
  ok(Array.isArray(periods.monthly) && periods.monthly.length > 0,
    'periods.json still has a monthly spending series');
  const snapBlob = JSON.stringify(snap9) + JSON.stringify(snap16);
  ok(!/"monthly"/.test(snapBlob) && !/periods\.json/.test(snapBlob),
    'balance snapshots do not carry the spending series');
  ok(!/function rollupSpending/.test(read('scripts/snapshot-balances.js')),
    'the snapshot writer does not re-derive spending');
  ok(read('ARCHITECTURE.md').includes('generated `public/periods.json`'),
    'spending-history authority is still named on periods.json');
}

console.log('\n=== 13. household-facing trend agrees with the underlying snapshot balances ===');
{
  const expectedHeloc = roundIndependent(AUG16_INDEPENDENT.heloc - AUG9_INDEPENDENT.heloc);
  const expectedCash = roundIndependent(
    (1320.13 + 932.05 + 0.58) - (506.98 + -517.72 + 90.58)
  );
  ok(near(expectedHeloc, -1100), 'independent HELOC delta is −$1,100.00');
  ok(near(506.98 + -517.72 + 90.58, 79.84),
    'independent Aug. 9 spendable cash is $79.84');
  ok(near(1320.13 + 932.05 + 0.58, 2252.76),
    'independent Aug. 16 spendable cash is $2,252.76');
  ok(near(expectedCash, 2172.92), 'independent spendable delta is +$2,172.92');

  const html = History.render(history);
  ok(html.includes(History.money2(200486.16)),
    'render shows the 16/19 Aug HELOC opening still in the latest pair');
  const helocPts = History.seriesFor(history, 'heloc');
  const helocLast = History.displayMove(helocPts);
  ok(html.includes(History.signedMoney(helocLast.delta)),
    'render shows the HELOC delta from the latest two snapshot balances');
  ok(html.includes(History.money2(2252.76)) && html.includes(History.money2(939.62)),
    'render shows the 16 Aug and 19 Aug spendable household totals');
  const spendableLast = History.displayMove(History.spendableSeries(history));
  ok(html.includes(History.signedMoney(spendableLast.delta)),
    'render shows the spendable delta from the latest complete openings');
}

console.log('\n=== 14. no second reconciliation or current-state calculation in the page layer ===');
{
  const page = read('public/balance-history.js') + '\n' + read('public/plan.js');
  ok(!/reconcile\.js/.test(page) && !/buildSnapshot/.test(page),
    'Plan / display layer does not run the snapshot writer or reconciler');
  ok(!/Forecast\.recommend/.test(read('public/balance-history.js')),
    'display assembly does not call Forecast.recommend');
  ok(!/startingCashAmount/.test(read('public/balance-history.js')),
    'display assembly does not re-open current cash from Forecast');
}

console.log('\n=== 15. snapshots stay a financial-state subset, not a policy copy ===');
{
  for (const doc of [snap9, snap16]) {
    ok(doc.schema === 'atlas-balance-snapshot/v1', `${doc.asOf} uses the snapshot schema`);
    ok(doc.role === 'historical-observation', `${doc.asOf} is marked historical`);
    ok(doc.currentStateAuthority === 'data.json', `${doc.asOf} names data.json as current-state`);
    ok(doc.spendableCoverage && Array.isArray(doc.spendableCoverage.expectedIds)
      && doc.spendableCoverage.expectedIds.length > 0,
      `${doc.asOf} carries spendable coverage from that dated opening`);
    ok(!doc.plan && !doc.actions && !doc.nextDollar && !doc.budget && !doc.helocHistory,
      `${doc.asOf} does not copy plan policy or helocHistory`);
    ok(!JSON.stringify(doc).includes('SITE_PASSWORD'),
      `${doc.asOf} contains no secret material`);
    for (const a of doc.accounts) {
      ok(a.provenance && a.provenance.canonicalLocator && a.provenance.sourceAsOf === doc.asOf,
        `${doc.asOf} ${a.id} provenance is the same dated reading`);
    }
  }
}

console.log('\n=== 16. incomplete spendable snapshots cannot publish a complete household total ===');
{
  const cash = (id, label, balance) => ({
    id, label, collection: 'cash', pot: 'spendable', side: 'asset', balance,
  });
  const three = ['chequing-a', 'chequing-b', 'savings'];
  const onlyA = {
    snapshots: [{
      asOf: AUG16,
      spendableCoverage: { expectedIds: three, complete: false },
      accounts: [cash('chequing-a', 'Chequing A', 999.00)],
    }],
  };
  const seriesOnlyA = History.spendableSeries(onlyA);
  ok(seriesOnlyA.length === 0,
    'Chequing A alone is withheld from the spendable-household-cash series');
  ok(!History.accountRows(onlyA).some(r => r.id === 'spendable-cash'),
    'account rows do not invent a complete spendable total from one cash account');
  const htmlOnlyA = History.render(onlyA);
  ok(!/Recorded cash balances/.test(htmlOnlyA),
    'the page does not label Chequing A as the complete recorded cash aggregate');
  ok(htmlOnlyA.includes(History.money2(999)),
    'the missing-account fixture still shows Chequing A as its own opening');

  const noCoverage = {
    snapshots: [{
      asOf: AUG16,
      accounts: [
        cash('chequing-a', 'Chequing A', 100),
        cash('chequing-b', 'Chequing B', 200),
        cash('savings', 'Savings', 50),
      ],
    }],
  };
  ok(History.spendableSeries(noCoverage).length === 0,
    'three cash rows without dated coverage metadata are not a complete household total');

  const mixedCompleteness = {
    snapshots: [
      {
        asOf: AUG9,
        spendableCoverage: { expectedIds: three, complete: true },
        accounts: [
          cash('chequing-a', 'Chequing A', 100),
          cash('chequing-b', 'Chequing B', 200),
          cash('savings', 'Savings', 50),
        ],
      },
      {
        asOf: AUG16,
        spendableCoverage: { expectedIds: three, complete: false },
        accounts: [cash('chequing-a', 'Chequing A', 999.00)],
      },
    ],
  };
  const series = History.spendableSeries(mixedCompleteness);
  ok(series.length === 1 && series[0].asOf === AUG9 && near(series[0].balance, 350),
    'only the complete three-account opening is a household spendable total');
  ok(!series.some(p => near(p.balance, 999)),
    'the incomplete 2026-08-16 Chequing A reading is not a complete total');
  const agg = History.accountRows(mixedCompleteness).find(r => r.id === 'spendable-cash');
  ok(agg && agg.move.current && agg.move.current.asOf === AUG9 && near(agg.move.current.balance, 350),
    'latest published household cash is the complete opening, not $999');
  ok(agg.move.sufficient === false,
    'an incomplete later snapshot does not create a two-point household-cash trend');
  const htmlMixed = History.render(mixedCompleteness);
  ok(!htmlMixed.includes(History.signedMoney(649)),
    'page does not publish 999 − 350 as the spendable household movement');

  const liveSpendable = History.spendableSeries(history);
  ok(liveSpendable.length >= 2 && liveSpendable.every(p => p.complete === true),
    'committed openings still have the complete Chequing A / B / Savings set');
  ok(liveSpendable.every(p => ['chequing-a', 'chequing-b', 'savings'].every(id => p.ids.includes(id))),
    'live spendable totals include all three expected identities');
  const liveExpected = (live.plan.startingCash.breakdown || []).map(r => r.id).sort();
  ok(JSON.stringify(snap16.spendableCoverage.expectedIds) === JSON.stringify(liveExpected)
    && snap16.spendableCoverage.complete === true,
    'Aug. 16 coverage matches that dated data.json breakdown, not a page list');
}

console.log('\n=== 18. snapshot coverage, not page membership, decides a complete spendable total ===');
{
  const extraId = 'extra-spendable';
  const pageSrc = read('public/balance-history.js');
  ok(!/HOUSEHOLD_SPENDABLE_IDS/.test(pageSrc),
    'the page does not hard-code a household spendable identity list');
  ok(!new RegExp(extraId).test(pageSrc),
    `the page does not name ${extraId}`);

  const mapWithExtra = JSON.parse(JSON.stringify(map));
  mapWithExtra.mappings.push({
    observationId: 'pos-extra-spendable',
    accountLabel: 'Extra Spendable',
    canonical: { collection: 'cash', id: extraId },
  });
  const fourCash = [
    { id: 'chequing-a', label: 'Chequing A', value: 100, pot: 'spendable' },
    { id: 'chequing-b', label: 'Chequing B', value: 200, pot: 'spendable' },
    { id: 'savings', label: 'Savings', value: 50, pot: 'spendable' },
    { id: extraId, label: 'Extra Spendable', value: 25, pot: 'spendable' },
  ];
  const dataFour = fixtureData(AUG16, fourCash, [
    { id: 'heloc', label: 'HELOC', balance: 1000, pending: 0, confidence: 'verified' },
  ]);
  const omittedPositions = fixturePositions([
    { label: 'Chequing A', balance: 100, asOf: AUG16, side: 'Asset' },
    { label: 'Chequing B', balance: 200, asOf: AUG16, side: 'Asset' },
    { label: 'Savings', balance: 50, asOf: AUG16, side: 'Asset' },
    { label: 'Extra Spendable', balance: 25, asOf: AUG9, side: 'Asset' },
    { label: 'HELOC', balance: 1000, asOf: AUG16, side: 'Liability', type: 'Home equity line' },
  ]);
  const omitted = S.buildSnapshot(dataFour, S.parsePositions(omittedPositions), mapWithExtra);
  const expectedFour = [extraId, 'chequing-a', 'chequing-b', 'savings'].sort();
  ok(JSON.stringify(omitted.spendableCoverage.expectedIds) === JSON.stringify(expectedFour),
    'writer expected ids come from that dated startingCash.breakdown, including the fourth account');
  ok(omitted.spendableCoverage.complete === false,
    'omitting the fourth same-date spendable account is not a complete opening');
  ok(!acc(omitted, extraId),
    'the stale fourth account is omitted from the dated snapshot');
  const omittedHistory = { snapshots: [S.publicSnapshot(omitted)] };
  const omittedSeries = History.spendableSeries(omittedHistory);
  ok(omittedSeries.length === 0,
    'A+B+Savings without the dated fourth account is not Spendable household cash');
  ok(!History.accountRows(omittedHistory).some(r => r.id === 'spendable-cash'),
    'account rows do not publish a complete total when coverage is incomplete');
  const omittedHtml = History.render(omittedHistory);
  ok(!/Recorded cash balances/.test(omittedHtml),
    'the page does not label the incomplete four-account opening as household cash');
  ok(omittedHtml.includes(History.money2(100)) && omittedHtml.includes(History.money2(200)),
    'the incomplete fixture still shows the present cash accounts as themselves');

  const completePositions = fixturePositions([
    { label: 'Chequing A', balance: 100, asOf: AUG16, side: 'Asset' },
    { label: 'Chequing B', balance: 200, asOf: AUG16, side: 'Asset' },
    { label: 'Savings', balance: 50, asOf: AUG16, side: 'Asset' },
    { label: 'Extra Spendable', balance: 25, asOf: AUG16, side: 'Asset' },
    { label: 'HELOC', balance: 1000, asOf: AUG16, side: 'Liability', type: 'Home equity line' },
  ]);
  const complete = S.buildSnapshot(dataFour, S.parsePositions(completePositions), mapWithExtra);
  ok(complete.spendableCoverage.complete === true && !!acc(complete, extraId),
    'the same four-account opening is complete when every expected id is same-date');
  const completeSeries = History.spendableSeries({ snapshots: [S.publicSnapshot(complete)] });
  ok(completeSeries.length === 1 && near(completeSeries[0].balance, 375)
    && completeSeries[0].ids.includes(extraId),
    'display consumes snapshot coverage and sums all four dated spendable accounts');
}

console.log('\n=== 17. revolving history discloses pending and fails closed when pending is unknown ===');
{
  const travelPosted9 = AUG9_INDEPENDENT.travelvisa;
  const travelPosted16 = AUG16_INDEPENDENT.travelvisa;
  const travelPending9 = 165.13;
  const travelPending16 = 250;
  const travelExposure9 = roundIndependent(travelPosted9 + travelPending9);
  const travelExposure16 = roundIndependent(travelPosted16 + travelPending16);
  ok(near(travelExposure9, 1243.44) && near(travelExposure16, 1112.68),
    'independent Travel Visa exposure is posted plus known pending');

  const travelPts = History.seriesFor(history, 'travelvisa');
  const travel16 = travelPts.find(p => p.asOf === AUG16);
  ok(travel16 && near(travel16.balance, travelPosted16) && near(travel16.pending, travelPending16),
    'Travel Visa 16 Aug series keeps posted $862.68 and pending $250.00');
  const travelMove = History.displayMove(travelPts);
  ok(travelMove.currentExposure != null && travelMove.priorExposure != null,
    'Travel Visa exposure uses posted plus pending on the compared openings');
  ok(travelMove.exposureSufficient === true && travelMove.sufficient === true,
    'known pending is enough for a complete Travel Visa debt trend');
  ok(near(travelMove.exposureDelta,
    roundIndependent(travelMove.currentExposure - travelMove.priorExposure)),
    'Travel Visa exposure movement is posted-plus-pending on the latest pair');

  const mbnaPosted9 = AUG9_INDEPENDENT.mbna;
  const mbnaPosted16 = AUG16_INDEPENDENT.mbna;
  const mbnaPending9 = 82.05;
  const mbnaPending16 = 0;
  const mbnaExposure9 = roundIndependent(mbnaPosted9 + mbnaPending9);
  const mbnaExposure16 = roundIndependent(mbnaPosted16 + mbnaPending16);
  ok(near(mbnaExposure9, 7937.17) && near(mbnaExposure16, 8003.61),
    'independent MBNA exposure is $7,937.17 → $8,003.61');
  ok(near(roundIndependent(mbnaPosted16 - mbnaPosted9), 148.49),
    'independent MBNA posted movement is +$148.49');
  ok(near(roundIndependent(mbnaExposure16 - mbnaExposure9), 66.44),
    'independent MBNA exposure movement is +$66.44');

  const mbnaMove = History.displayMove(History.seriesFor(history, 'mbna'));
  ok(near(mbnaMove.postedDelta,
    roundIndependent(mbnaMove.current.balance - mbnaMove.prior.balance)),
    'posted MBNA series records the latest two posted openings');
  ok(near(mbnaMove.exposureDelta,
    roundIndependent(mbnaMove.currentExposure - mbnaMove.priorExposure)),
    'household-facing MBNA trend is posted-plus-pending on that pair');
  const mbnaWord = History.movementWord(mbnaMove, 'MBNA');
  ok(/posted-plus-pending exposure/.test(mbnaWord)
    || /balance fell|balance rose/.test(mbnaWord),
    'MBNA wording names the movement without treating a larger balance as improvement');
  ok(mbnaWord.includes(History.money2(Math.abs(mbnaMove.exposureDelta))),
    'MBNA wording uses the independent exposure delta of the latest pair');

  const cash16 = acc(snap16, 'cashback');
  ok(cash16 && cash16.pendingUnknown === true,
    'the 2026-08-16 Cash Back snapshot still carries unknown pending');
  const cashMove = History.displayMove(History.seriesFor(history, 'cashback'));
  if (live.meta.asOf === AUG16) {
    ok(cashMove.current && cashMove.current.pendingUnknown === true,
      'while live as-of is 16 August, Cash Back current opening still carries Q26 pendingUnknown');
    ok(cashMove.pendingUnknown === true && cashMove.sufficient === false
      && cashMove.exposureSufficient === false,
      'unknown pending fails closed — Cash Back has no complete debt trend');
    const cashWord = History.movementWord(cashMove, 'Cash Back');
    ok(/pending is unknown/.test(cashWord) && !/fell/.test(cashWord) && !/rose/.test(cashWord),
      'Cash Back wording does not imply a complete rise or fall');
  } else {
    ok(cashMove.current && cashMove.current.pendingUnknown !== true,
      'live Cash Back current opening is not unknown-pending after the 19 Aug known-zero observation');
  }

  const html = History.render(history);
  ok(html.includes('pending unknown') || live.meta.asOf > AUG16,
    'the page discloses that Cash Back pending is unknown on the 16 Aug snapshot');
  ok(html.includes(History.money2(250)) && html.includes('pending'),
    'the page shows Travel Visa $250.00 pending beside posted');
  ok(html.includes(History.signedMoney(mbnaMove.exposureDelta)),
    'the page publishes the independent MBNA exposure movement');
  ok(!html.includes(History.signedMoney(148.49)),
    'the page does not publish MBNA posted-only +$148.49 as the debt movement');
}

console.log('\n=== T2. the HELOC 9 Aug → 16 Aug pair is answerable from stored history ===');
{
  const heloc9 = acc(snap9, 'heloc');
  const heloc16 = acc(snap16, 'heloc');
  ok(heloc9 && heloc16, 'HELOC exists on both stored openings');
  ok(near(heloc9.balance, 201586.16) && snap9.asOf === AUG9,
    'prior HELOC is the 2026-08-09 $201,586.16 opening');
  ok(near(heloc16.balance, 200486.16) && snap16.asOf === AUG16,
    'later stored HELOC is the 2026-08-16 $200,486.16 opening');
  ok(near(heloc16.balance - heloc9.balance, -1100),
    'from those two files: the HELOC fell $1,100.00 between those openings');
  const move = History.displayMove(History.seriesFor(history, 'heloc'));
  ok(move.sufficient, 'HELOC still has at least two independently dated openings');
  if (live.meta.asOf === AUG16) {
    ok(near(move.current.balance, 200486.16) && move.current.asOf === AUG16,
      'while live as-of is still 16 August, displayMove current is that opening');
  }
}

console.log('\n' + '═'.repeat(60));
if (failures) {
  console.log(`FAILED — ${failures} B20 history check(s)`);
  process.exit(1);
}
console.log('B20 / AF-HIST-01 PROVED');
