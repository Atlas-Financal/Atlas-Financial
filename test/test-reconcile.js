'use strict';
/* B91 first slice — non-writing observation → canonical compare.
 *
 * Independent arithmetic: CSV / fixture values minus the parent cash or
 * debt figure, not a second call that merely echoes reconcile().
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const R = require('../scripts/reconcile.js');
const map = require('../docs/reconciliation/balance-map.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const clone = x => JSON.parse(JSON.stringify(x));
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function cashById(d, id) {
  const cash = d.plan.startingCash;
  return (cash.breakdown || []).concat(cash.heldElsewhere || []).find(r => r.id === id);
}

function fixtureState() {
  return {
    meta: { asOf: '2026-08-09' },
    plan: {
      startingCash: {
        breakdown: [
          { id: 'chequing-a', value: 100.25 },
          { id: 'chequing-b', value: -20 },
        ],
        heldElsewhere: [{ id: 'amanda-debt-payments', value: 50 }],
      },
    },
    debts: [
      { id: 'mortgage', balance: 1600.5 },
      { id: 'mbna', balance: 80 },
    ],
  };
}

console.log('=== A. unchanged balance → MATCH (independent parents) ===');
{
  const d = fixtureState();
  const evidenceA = 100.25;
  const evidenceM = 1600.5;
  ok(near(evidenceA, cashById(d, 'chequing-a').value),
    'independent observation equals plan.startingCash[id=chequing-a]');
  ok(near(evidenceM, d.debts.find(x => x.id === 'mortgage').balance),
    'independent observation equals debts[id=mortgage].balance');

  const result = R.reconcile({
    data: d,
    map,
    observations: [
      {
        observationId: 'pos-chequing-a',
        accountLabel: 'Chequing A',
        evidenceValue: evidenceA,
        evidenceDate: '2026-08-09',
        canonical: { collection: 'cash', id: 'chequing-a' },
      },
      {
        observationId: 'pos-mortgage',
        accountLabel: 'Mortgage',
        evidenceValue: evidenceM,
        evidenceDate: '2026-08-09',
        canonical: { collection: 'debts', id: 'mortgage' },
      },
    ],
  });
  const rowA = result.rows.find(r => r.observationId === 'pos-chequing-a');
  const rowM = result.rows.find(r => r.observationId === 'pos-mortgage');
  ok(rowA && rowA.status === 'MATCH' && near(rowA.difference, 0),
    'reconciler reports MATCH for the unchanged Chequing A pair');
  ok(rowM && rowM.status === 'MATCH' && near(rowM.difference, 0),
    'reconciler reports MATCH for the unchanged mortgage pair');
  ok(rowA.canonicalTarget === 'cash:chequing-a',
    'canonical target is the id locator, not an array-index pointer');
  ok(result.staleAssigned === false && result.counts.STALE === 0,
    'STALE is not assigned — no owner-defined age threshold');
}

console.log('\n=== B. newer observed balance differing from canonical → CHANGE ===');
{
  const d = fixtureState();
  const canon = cashById(d, 'chequing-a').value;
  const observed = canon + 123.45;
  const independentDiff = Math.round((observed - canon) * 100) / 100;
  const result = R.reconcile({
    data: d,
    map,
    observations: [{
      observationId: 'pos-chequing-a',
      accountLabel: 'Chequing A',
      evidenceValue: observed,
      evidenceDate: '2026-08-14',
      canonical: { collection: 'cash', id: 'chequing-a' },
    }],
  });
  const row = result.rows[0];
  ok(near(independentDiff, 123.45), 'independent difference is $123.45');
  ok(row.status === 'CHANGE', 'differing newer observation is CHANGE');
  ok(near(row.difference, independentDiff),
    'reported difference equals the independent subtraction');
  ok(row.evidenceDate === '2026-08-14' && result.canonicalAsOf === '2026-08-09',
    'both dates are reported so freshness stays an owner decision');
  ok(row.dateRelation === 'canonical-older',
    'the row names that canonical as-of is older than this evidence');
  ok(result.staleAssigned === false && result.counts.STALE === 0,
    'that older relationship is not assigned STALE');
}

console.log('\n=== C. missing canonical target → MISSING ===');
{
  const result = R.reconcile({
    data: fixtureState(),
    map,
    observations: [{
      observationId: 'pos-ghost',
      accountLabel: 'Ghost account',
      evidenceValue: 10,
      evidenceDate: '2026-08-14',
      canonical: { collection: 'cash', id: 'does-not-exist' },
    }],
  });
  ok(result.rows[0].status === 'MISSING', 'unknown cash id is MISSING');
  ok(result.rows[0].canonicalValue == null, 'no invented canonical value');
  ok(result.rows[0].canonicalTarget === 'cash:does-not-exist',
    'the missing locator is still named');
}

console.log('\n=== D. conflicting observations of one target → CONFLICT ===');
{
  const d = fixtureState();
  const canon = cashById(d, 'chequing-a').value;
  const result = R.reconcile({
    data: d,
    map,
    observations: [
      {
        observationId: 'pos-chequing-a',
        accountLabel: 'Chequing A',
        evidenceValue: canon,
        evidenceDate: '2026-08-14',
        canonical: { collection: 'cash', id: 'chequing-a' },
      },
      {
        observationId: 'pos-chequing-a',
        accountLabel: 'Chequing A',
        evidenceValue: canon + 50,
        evidenceDate: '2026-08-14',
        canonical: { collection: 'cash', id: 'chequing-a' },
      },
    ],
  });
  ok(result.rows.every(r => r.status === 'CONFLICT'),
    'two disagreeing observations of one id are CONFLICT');
  ok(!near(result.rows[0].evidenceValue, result.rows[1].evidenceValue),
    'the conflict is a real value disagreement, not a duplicate of one number');
}

console.log('\n=== E. no-write guarantee ===');
{
  const before = hashFile(R.DEFAULT_DATA);
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'reconcile.js'), 'utf8');
  ok(!/writeFileSync?\s*\(\s*DEFAULT_DATA/.test(src),
    'reconcile.js source does not write DEFAULT_DATA');
  ok(!/writeFileSync?\s*\([^)]*data\.json/.test(src),
    'reconcile.js source does not write data.json by path');
  ok(/NEVER writes data\.json/.test(src),
    'the no-write contract is stated in the command');

  const out = execFileSync(process.execPath, ['scripts/reconcile.js'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
  });
  const after = hashFile(R.DEFAULT_DATA);
  ok(before === after, 'running the CLI leaves data.json bytes unchanged');
  ok(/does not write data\.json/.test(out),
    'the printed report repeats the no-write contract');
  ok(/MATCH/.test(out), 'the live CLI report includes MATCH rows');
  ok(/canonical-older means this observation time is newer than a comparable canonical freshness date/.test(out),
    'the CLI reports the date relation without assigning STALE');
  ok(/Due, settlement, and scheduled dates are not observation times/.test(out),
    'the CLI refuses to treat due or settlement dates as observation time');
  ok(/Date relation \(not a STALE assignment\)/.test(out),
    'the CLI names date relation as not a STALE assignment');

  const copy = path.join(__dirname, '..', 'data.json');
  const live = JSON.parse(fs.readFileSync(copy, 'utf8'));
  const mutated = clone(live);
  cashById(mutated, 'chequing-a').value += 1;
  const afterRun = JSON.parse(fs.readFileSync(copy, 'utf8'));
  ok(near(cashById(afterRun, 'chequing-a').value, cashById(live, 'chequing-a').value),
    'canonical Chequing A is unchanged after reconcile ran');
}

console.log('\n=== F. locator is id-stable, not array position ===');
{
  const shuffled = fixtureState();
  shuffled.plan.startingCash.breakdown = shuffled.plan.startingCash.breakdown.slice().reverse();
  shuffled.debts = shuffled.debts.slice().reverse();
  const result = R.reconcile({
    data: shuffled,
    map,
    observations: [{
      observationId: 'pos-chequing-a',
      accountLabel: 'Chequing A',
      evidenceValue: 100.25,
      evidenceDate: '2026-08-09',
      canonical: { collection: 'cash', id: 'chequing-a' },
    }],
  });
  const rowA = result.rows[0];
  ok(rowA.status === 'MATCH' && rowA.canonicalTarget === 'cash:chequing-a',
    'reversing cash/debt arrays does not lose the Chequing A locator');
}

console.log('\n=== G. due/settlement/scheduled dates are not observation times ===');
{
  const utility = require('../docs/reconciliation/utility-observations.json');
  const sepObs = R.observationsFromUtility(utility)
    .find(o => o.observationId === 'payday-hydro-due-sep1');
  ok(sepObs && sepObs.dueDate === '2026-09-01',
    'adapter keeps the Sept. 1 due date as the effective date');
  ok(sepObs.observedAsOf === '2026-08-14' && sepObs.evidenceDate === '2026-08-14',
    'adapter uses observedAsOf 14 Aug, not the due date, as observation time');
  ok(sepObs.evidenceDate !== sepObs.dueDate,
    'due date does not masquerade as observedAsOf');

  const live = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const hydro = R.reconcile({
    data: live,
    map: { mappings: [] },
    observations: [],
    settlements: { observations: [] },
    utility,
  });
  const sepRow = hydro.rows.find(r => r.observationId === 'payday-hydro-due-sep1');
  ok(sepRow && sepRow.status === 'MATCH' && sepRow.dueDate === '2026-09-01',
    'live Sept. 1 Hydro bill MATCHES the Aug. 14 observation');
  ok(sepRow.dateRelation === 'incomparable',
    'Sept. 1 Hydro MATCH is not canonical-older merely because the due date is after 9 Aug');
  ok(R.dateRelation(sepRow.dueDate, live.meta.asOf) === 'canonical-older',
    'comparing the due date to meta.asOf would have overclaimed freshness — that path is closed');

  const posting = R.observationsFromPosting({
    observations: [{
      observationId: 'synth-scheduled-only',
      fact: 'posting',
      eventId: 'payroll',
      scheduledDate: '2026-08-15',
    }],
  })[0];
  ok(posting.scheduledDate === '2026-08-15' && posting.evidenceDate == null,
    'scheduledDate does not fill in as observedAsOf when observation time is missing');

  const settlement = R.observationsFromSettlements({
    observations: [{
      observationId: 'synth-settled',
      fact: 'settlement',
      commitmentId: 'fusioncamp',
      settledOn: '2026-08-14',
      amount: 786,
    }],
  })[0];
  ok(settlement.settledOn === '2026-08-14' && settlement.evidenceDate == null,
    'settledOn does not masquerade as observedAsOf');

  const d = fixtureState();
  const balance = R.reconcile({
    data: d,
    map,
    observations: [{
      observationId: 'pos-chequing-a',
      accountLabel: 'Chequing A',
      evidenceValue: 100.25,
      evidenceDate: '2026-08-14',
      canonical: { collection: 'cash', id: 'chequing-a' },
    }],
  }).rows[0];
  ok(balance.dateRelation === 'canonical-older',
    'balance rows with a comparable observation timestamp still report canonical-older');

  const card = R.reconcile({
    data: {
      meta: { asOf: '2026-08-09' },
      plan: { startingCash: { breakdown: [], heldElsewhere: [] } },
      debts: [{ id: 'cashback', balance: 5070, limit: 5000, pending: 0 }],
    },
    map: { mappings: [] },
    observations: [],
    settlements: { observations: [] },
    cards: { observations: [
      {
        observationId: 'card-cashback-posted-2026-08-09',
        fact: 'posted-balance',
        cardId: 'cashback',
        amount: 5070,
        observedAsOf: '2026-08-09',
        canonical: { collection: 'debts', id: 'cashback', field: 'balance' },
      },
      {
        observationId: 'card-cashback-pending-2026-08-14',
        fact: 'pending',
        cardId: 'cashback',
        amount: null,
        unknown: true,
        observedAsOf: '2026-08-14',
        canonical: { collection: 'debts', id: 'cashback', field: 'pending' },
      },
    ] },
  });
  const posted = card.rows.find(r => r.observationId === 'card-cashback-posted-2026-08-09');
  const pending = card.rows.find(r => r.observationId === 'card-cashback-pending-2026-08-14');
  ok(posted && posted.dateRelation === 'same-day',
    '9 Aug card posted-balance still reports same-day against meta.asOf');
  ok(pending && pending.dateRelation === 'canonical-older',
    '14 Aug card pending still reports canonical-older against meta.asOf');

  ok(R.freshnessOwnedByMetaAsOf({ fact: 'limit' }) === false,
    'limit is a standing fact, not a meta.asOf snapshot-freshness fact');
  ok(R.freshnessOwnedByMetaAsOf({ fact: 'posted-balance' }) === true,
    'posted-balance freshness remains owned by meta.asOf');
  const limit = R.reconcile({
    data: {
      meta: { asOf: '2026-08-09' },
      plan: { startingCash: { breakdown: [], heldElsewhere: [] } },
      debts: [{ id: 'cashback', balance: 5070, limit: 5000, pending: 0 }],
    },
    map: { mappings: [] },
    observations: [],
    settlements: { observations: [] },
    cards: { observations: [
      {
        observationId: 'card-cashback-limit-2026-08-14',
        fact: 'limit',
        cardId: 'cashback',
        amount: 5000,
        observedAsOf: '2026-08-14',
        canonical: { collection: 'debts', id: 'cashback', field: 'limit' },
      },
    ] },
  });
  const limitRow = limit.rows.find(r => r.observationId === 'card-cashback-limit-2026-08-14');
  ok(limitRow && limitRow.status === 'MATCH',
    'later observed matching limit still MATCHES the canonical ceiling');
  ok(limitRow && limitRow.dateRelation === 'incomparable',
    'a later observed card limit is incomparable — meta.asOf is not a standing-fact verification timestamp');
  ok(R.dateRelation(limitRow.evidenceDate, '2026-08-09') === 'canonical-older',
    'comparing the later limit observation to meta.asOf would have overclaimed freshness — that path is closed');
}

console.log('\n=== settledOn must be a real calendar day (A8 parity, #934) ===');
{
  // Expected validity is written by hand from the calendar, not derived
  // from reconcile.js: 2024 is a leap year, 2026 and 2100 are not.
  const run = (evidence, canonical) => R.reconcile({
    data: {
      meta: { asOf: '2026-08-09' },
      plan: { startingCash: { breakdown: [], heldElsewhere: [] },
        commitments: [{ id: 'synth-camp', amount: 100, settledOn: canonical }] },
      debts: [],
    },
    map: { mappings: [] },
    observations: [],
    settlements: { observations: [{ observationId: 'synth-camp-paid', fact: 'settlement',
      commitmentId: 'synth-camp', settledOn: evidence, amount: 100 }] },
  }).rows.find(r => r.observationId === 'synth-camp-paid');

  for (const bad of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-06-31', '2026-09-31', '2026-11-31', '2100-02-29']) {
    const row = run(bad, '2026-08-01');
    ok(row && row.evidenceSettledOn === null && row.sourceMissing === true && row.status === 'MISSING',
      `evidence settledOn ${bad} is not a date: MISSING, not compared`, row && `${row.status} ${row.evidenceSettledOn}`);
    const canon = run('2026-08-01', bad);
    ok(canon && canon.canonicalSettledOn === null && canon.status === 'CHANGE',
      `canonical settledOn ${bad} reads as unset, so a real evidence date is a CHANGE`, canon && `${canon.status} ${canon.canonicalSettledOn}`);
  }
  const both = run('2026-02-30', '2026-02-30');
  ok(both && both.status !== 'MATCH', 'the same impossible date on both sides never MATCHES', both && both.status);
  for (const good of ['2024-02-29', '2026-02-28', '2026-04-30', '2026-12-31', '2000-02-29']) {
    const row = run(good, good);
    ok(row && row.evidenceSettledOn === good && row.canonicalSettledOn === good && row.status === 'MATCH',
      `real day ${good} still MATCHES`, row && row.status);
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
