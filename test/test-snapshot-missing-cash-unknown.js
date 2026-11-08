'use strict';
/* A13 — the snapshot CLI never turns a missing balance into complete $0
 * evidence. Number(null) and Number('') are both 0, so before this fix a
 * canonical cash value:null plus a same-date positions.csv blank balance
 * passed the agreement check and published balance 0 with
 * spendableCoverage.complete = true.
 *
 * Invented accounts and amounts only. Every case runs the real CLI
 * (node scripts/snapshot-balances.js --data --positions --map --out) on
 * temp files; expectations are stated by hand, not recomputed by the
 * code under test.
 *
 * `node test/test-snapshot-missing-cash-unknown.js`
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'snapshot-balances.js');
const AS_OF = '2031-03-03';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const MAP = { mappings: [
  { accountLabel: 'Invented Chequing', observationId: 'inv-a', canonical: { collection: 'cash', id: 'inv-chequing' } },
  { accountLabel: 'Invented Spending', observationId: 'inv-b', canonical: { collection: 'cash', id: 'inv-spending' } },
  { accountLabel: 'Invented Card', observationId: 'inv-z', canonical: { collection: 'debts', id: 'inv-card' } },
] };

function scenario({ chequing = 120, spending = 45, spendingCsv = '45', card = 300, cardCsv = '300', cardPending = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-a13-'));
  const data = {
    meta: { asOf: AS_OF },
    plan: { opening: { asOf: AS_OF }, startingCash: { breakdown: [
      { id: 'inv-chequing', label: 'Invented Chequing', value: chequing },
      { id: 'inv-spending', label: 'Invented Spending', value: spending },
    ] } },
    debts: [{ id: 'inv-card', label: 'Invented Card', balance: card, pending: cardPending }],
  };
  const csv = [
    'entity,account_label,as_of,balance,side,currency',
    `Household,Invented Chequing,${AS_OF},${chequing},asset,CAD`,
    `Household,Invented Spending,${AS_OF},${spendingCsv},asset,CAD`,
    `Household,Invented Card,${AS_OF},${cardCsv},liability,CAD`,
  ].join('\n') + '\n';
  const files = {
    data: path.join(dir, 'data.json'),
    positions: path.join(dir, 'positions.csv'),
    map: path.join(dir, 'balance-map.json'),
    out: path.join(dir, 'snapshots'),
  };
  fs.writeFileSync(files.data, JSON.stringify(data, null, 2));
  fs.writeFileSync(files.positions, csv);
  fs.writeFileSync(files.map, JSON.stringify(MAP, null, 2));
  const res = spawnSync(process.execPath, [SCRIPT,
    '--data', files.data, '--positions', files.positions, '--map', files.map, '--out', files.out,
  ], { encoding: 'utf8' });
  const snapFile = path.join(files.out, `${AS_OF}.json`);
  const snap = fs.existsSync(snapFile) ? JSON.parse(fs.readFileSync(snapFile, 'utf8')) : null;
  const account = id => snap && snap.accounts.find(a => a.id === id);
  return { code: res.status, stderr: res.stderr, snap, account };
}

console.log('=== 1. canonical value:null + same-date blank positions balance stays unknown ===');
{
  const r = scenario({ spending: null, spendingCsv: '' });
  ok(r.code === 0 && !!r.snap, 'the snapshot is still written for the known accounts', r.stderr.trim());
  ok(!r.account('inv-spending'), 'the missing account is not published (no $0 balance)');
  ok(r.snap && r.snap.spendableCoverage.complete === false,
    'spendable coverage is incomplete, not complete');
  ok(r.account('inv-chequing') && r.account('inv-chequing').balance === 120,
    'the known invented 120 account is unchanged');
}

console.log('\n=== 2. a blank debt balance is unknown, not a $0 card ===');
{
  const r = scenario({ card: '', cardCsv: '' });
  ok(r.code === 0 && !r.account('inv-card'), 'the blank card balance is not published as 0', r.stderr.trim());
  ok(r.snap && r.snap.spendableCoverage.complete === true,
    'cash coverage is unaffected by a liability row');
}

console.log('\n=== 3. a blank pending stays unknown (null), never 0 ===');
{
  const r = scenario({ cardPending: '' });
  const card = r.account('inv-card');
  ok(card && card.balance === 300 && card.pending === null, 'pending "" publishes as null with the invented 300 balance');
}

console.log('\n=== 4. a known canonical balance with a blank positions cell is refused ===');
{
  const r = scenario({ spending: 45, spendingCsv: '' });
  ok(r.code !== 0 && !r.snap, 'disagreeing evidence writes no snapshot');
  ok(/disagrees with positions\.csv/.test(r.stderr), 'refusal names the disagreement', r.stderr.trim());
}

console.log('\n=== 5. a genuine recorded $0 is still a known zero ===');
{
  const r = scenario({ spending: 0, spendingCsv: '0', cardPending: 0 });
  ok(r.code === 0 && r.account('inv-spending') && r.account('inv-spending').balance === 0,
    'a numeric 0 on both sides publishes 0', r.stderr.trim());
  ok(r.snap && r.snap.spendableCoverage.complete === true, 'coverage is complete when every account is known');
  ok(r.account('inv-card') && r.account('inv-card').pending === 0, 'a numeric pending 0 stays 0');
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All A13 snapshot missing-cash checks passed'));
process.exit(failures ? 1 : 0);
