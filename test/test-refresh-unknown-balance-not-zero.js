'use strict';
/* A missing canonical balance is unknown, never a zero (A13 follow-up).
 *
 * Number(null) and Number('') are both 0. In scripts/canonical-refresh.js
 * that made a missing canonical cash value or debt balance read as 0:
 *   - the post-apply guard (validateApplied) could not see an unapproved
 *     rewrite from "missing" to 0 (null and 0 both compared as 0);
 *   - the recovery precondition accepted a canonical null as a MATCH of an
 *     observed 0;
 *   - a blank stored debt balance was reconciled as a known 0.
 * (The blank same-date positions.csv cell is covered end to end in
 * test-b81-opening-recovery.js section 11b.)
 *
 * Invented accounts and numbers only; temp files only.
 * `node test/test-refresh-unknown-balance-not-zero.js`
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../scripts/canonical-refresh.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const clone = x => JSON.parse(JSON.stringify(x));
const throwsWith = (fn, re) => {
  try { fn(); return { threw: false, message: '' }; } catch (err) {
    const message = String(err && err.message || err);
    return { threw: re.test(message), message };
  }
};

function invented(extra) {
  return Object.assign({
    meta: { asOf: '2031-03-14' },
    plan: {
      windowDays: 28,
      defaults: { targetBuffer: 0 },
      startingCash: { breakdown: [
        { id: 'chequing-a', value: 412.37 },
        { id: 'chequing-b', value: 88.15 },
        { id: 'savings', value: 23.4 },
      ] },
      opening: { asOf: '2031-03-14', representedEvents: [] },
      income: [], obligations: [], bills: [], commitments: [],
    },
    debts: [
      { id: 'invented-card', label: 'Invented Card', balance: 317.62, pending: 0, limit: 900, revolving: true },
    ],
  }, extra || {});
}
const cash = (data, id) => data.plan.startingCash.breakdown.find(r => r.id === id);
const debt = (data, id) => data.debts.find(d => d.id === id);

console.log('=== 1. the post-apply guard sees an unapproved rewrite of a missing balance ===');
{
  const before = invented();
  cash(before, 'chequing-b').value = null;
  const approved = { proposed: [{ locator: 'cash:chequing-a', proposedValue: 450.01 }] };
  const after = clone(before);
  cash(after, 'chequing-a').value = 450.01;
  cash(after, 'chequing-b').value = 0;
  const r = throwsWith(() => C.validateApplied(before, after, approved), /Unapproved locator changed: cash:chequing-b/);
  ok(r.threw, 'missing -> 0 on an unapproved cash locator is refused', r.message || 'did not throw');

  const beforeDebt = invented();
  debt(beforeDebt, 'invented-card').balance = null;
  const afterDebt = clone(beforeDebt);
  cash(afterDebt, 'chequing-a').value = 450.01;
  debt(afterDebt, 'invented-card').balance = 0;
  const d = throwsWith(() => C.validateApplied(beforeDebt, afterDebt, approved), /Unapproved locator changed: debts:invented-card/);
  ok(d.threw, 'missing -> 0 on an unapproved debt balance is refused', d.message || 'did not throw');

  const k = throwsWith(() => {
    const a2 = clone(before);
    cash(a2, 'chequing-b').value = 12.5;
    cash(a2, 'chequing-a').value = 450.01;
    C.validateApplied(before, a2, approved);
  }, /Unapproved locator changed: cash:chequing-b/);
  ok(k.threw, 'missing -> 12.50 is refused too', k.message || 'did not throw');

  // Controls: a missing value left missing, and an approved change, pass.
  const same = clone(before);
  cash(same, 'chequing-a').value = 450.01;
  let threw = null;
  try { C.validateApplied(before, same, approved); } catch (err) { threw = err.message; }
  ok(threw === null, 'control: an unapproved missing value left missing passes', threw || '');
}

console.log('\n=== 2. recovery never accepts a missing canonical balance as a MATCH of 0 ===');
{
  // Invented surviving opening; Chequing B is missing in data.json and the
  // observation says 0.00. The recovery precondition must refuse it before
  // any artifact is built.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-unknown-'));
  const data = invented();
  cash(data, 'chequing-b').value = null;
  const bytes = Buffer.from(`${JSON.stringify(data, null, 4)}\n`);
  const dataPath = path.join(dir, 'data.json');
  fs.writeFileSync(dataPath, bytes);
  const balanceMapPath = path.join(dir, 'balance-map.json');
  fs.writeFileSync(balanceMapPath, JSON.stringify({ schema: 'atlas-balance-reconciliation-map/v1', excluded: [], mappings: [] }));
  const preview = {
    schema: C.SCHEMA,
    openingCutover: {
      status: 'READY_FOR_OWNER_REVIEW',
      blockers: [],
      requestedAsOf: '2031-03-14',
      currentOpeningAsOf: '2031-03-14',
      currentMetaAsOf: '2031-03-14',
      proposedOpening: {
        posted: [
          { locator: 'cash:chequing-b', reconcileStatus: 'MATCH', freshnessBasis: 'exact-day', proposedValue: 0 },
        ],
        pending: [],
      },
      artifactRecovery: {
        supported: true, status: 'READY_FOR_OWNER_REVIEW', blockers: [],
        recoveryApprovalId: 'a'.repeat(64), canonicalSha256: null,
      },
    },
  };
  const opts = { positionsPath: path.join(dir, 'positions.csv'), snapshotDir: path.join(dir, 'snapshots'), balanceMapPath };
  const r = throwsWith(() => C.applyRecoveryPreview(data, preview, dataPath, bytes, opts),
    /canonical cash:chequing-b does not MATCH observed 0/);
  ok(r.threw, 'a missing canonical cash value does not MATCH an observed 0', r.message || 'did not throw');
  ok(Buffer.compare(fs.readFileSync(dataPath), bytes) === 0 && !fs.existsSync(opts.positionsPath),
    'nothing was written');

  // Control: a recorded 0.00 passes this precondition (it fails later, on
  // the deliberately empty fixture, for a different reason).
  const zero = invented();
  cash(zero, 'chequing-b').value = 0;
  const zeroBytes = Buffer.from(`${JSON.stringify(zero, null, 4)}\n`);
  fs.writeFileSync(dataPath, zeroBytes);
  const c = throwsWith(() => C.applyRecoveryPreview(zero, preview, dataPath, zeroBytes, opts), /does not MATCH/);
  ok(!c.threw, 'control: a recorded 0.00 is a MATCH of an observed 0', c.message);
}

console.log('\n=== 3. a blank stored balance is not reconciled as a known 0 ===');
{
  const data = invented();
  debt(data, 'invented-card').balance = '';
  cash(data, 'chequing-b').value = '';
  const req = C.requiredPostedLocators(data);
  const card = req.find(r => r.locator === 'debts:invented-card');
  const chequing = req.find(r => r.locator === 'cash:chequing-b');
  ok(!card, 'a blank debt balance is not a required locator with a 0 canonical value', JSON.stringify(card || null));
  ok(chequing && chequing.canonicalValue === null, 'a blank cash value is reconciled as unknown (null)', JSON.stringify(chequing));
  const known = C.requiredPostedLocators(invented()).find(r => r.locator === 'debts:invented-card');
  ok(known && known.canonicalValue === 317.62, 'control: a known balance is unchanged', JSON.stringify(known));
}

console.log('\n=== 4. the stale-preview guard never applies a change over a missing balance ===');
{
  // A preview built when the card read 0.00 must not apply once the stored
  // balance is missing: missing is not 0, so the preview is stale.
  for (const stored of [null, '']) {
    const data = invented();
    debt(data, 'invented-card').balance = stored;
    const r = throwsWith(() => C.applyChange(data, {
      locator: 'debts:invented-card', field: 'balance', currentValue: 0, proposedValue: 12.34,
    }), /Stale preview for debts:invented-card/);
    ok(r.threw && debt(data, 'invented-card').balance === stored,
      `stored ${JSON.stringify(stored)} debt balance: a 0 -> 12.34 preview is stale and not applied`, r.message || 'applied');
    const c = invented();
    cash(c, 'chequing-b').value = stored;
    const rc = throwsWith(() => C.applyChange(c, {
      locator: 'cash:chequing-b', field: 'value', currentValue: 0, proposedValue: 12.34,
    }), /Stale preview for cash:chequing-b/);
    ok(rc.threw && cash(c, 'chequing-b').value === stored,
      `stored ${JSON.stringify(stored)} cash value: a 0 -> 12.34 preview is stale and not applied`, rc.message || 'applied');
  }
  const zero = invented();
  debt(zero, 'invented-card').balance = 0;
  let threw = null;
  try {
    C.applyChange(zero, { locator: 'debts:invented-card', field: 'balance', currentValue: 0, proposedValue: 12.34 });
  } catch (err) { threw = err.message; }
  ok(threw === null && debt(zero, 'invented-card').balance === 12.34,
    'control: a recorded 0.00 takes the approved 12.34', threw || '');
}

console.log('\n=== 5. the pending-write guard sees a posted missing -> 0 rewrite ===');
{
  const before = invented();
  debt(before, 'invented-card').balance = null;
  const after = clone(before);
  debt(after, 'invented-card').balance = 0;
  const r = throwsWith(() => C.validatePendingApplied(before, after, { openingCutover: { pendingTransitions: [] } }),
    /Unapproved locator changed: debts:invented-card/);
  ok(r.threw, 'a pending write cannot turn a missing posted balance into 0', r.message || 'did not throw');
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All unknown-balance-not-zero checks passed'));
process.exit(failures ? 1 : 0);
