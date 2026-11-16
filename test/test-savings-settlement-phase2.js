'use strict';
// Savings Phase 2 (ATLAS-080) — settlement evidence relief through Forecast.
// Owner rule: a Lunch Money transaction explicitly identified with a Savings
// commitment, recorded through the Phase 1 contract, subtracts its assigned
// amount from the commitment's remaining cost. Original cost, linked paid and
// remaining stay distinct; the linked payment is an observed transaction fact
// and is never deducted a second time. Tests first: the with-evidence cases
// below FAIL on unmodified main 77ee7e79 (Phase 1 is inert — evidence changes
// nothing) and pass once Phase 2 lands. Approved v1 policy (Dale via Atlas,
// 2026-10-19): exact fixed-cost relief only; ranges, over-assignment and
// reversal-bearing evidence are needs-review/uncertain with dependent figures
// withheld — never silently capped, never gross-as-net. Retracted links give
// no relief. Nothing writes settledOn.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(ROOT, 'public/forecast'));
const C = require(path.join(ROOT, 'scripts/planned-obligation-settlement-contract'));
const fx = require('./fixtures/savings-daily-allocation-contract');

const householdId = 'household-' + 'a'.repeat(32);
const actorId = 'session-' + 'c'.repeat(64);
const op = n => 'operation-' + n.toString(16).padStart(32, '0');
const tx = n => 'tx-' + n.toString(16).padStart(32, '0');
const T0 = Date.parse('2026-10-04T12:00:00Z');

// Record one ACTIVE link through the real Phase 1 contract and return the
// effectiveEvidence output Forecast consumes at the opts.settlementEvidence
// seam. assignedCents is in cents; the evidence debit is a posted 6000-cent
// transaction dated 2026-10-03 unless overridden.
function evidenceWithLink({ goalId = 'commitment:near', assignedCents = 2500, evidenceDate = '2026-10-03' } = {}) {
  let body = C.adopt({ householdId });
  const evidence = { accountId: 'acct-main', currency: 'cad', direction: 'debit', date: evidenceDate, cents: 6000, posted: true };
  const cmd = { version: 1, kind: 'link', goalId, txRef: tx(1), evidence, evidenceDigest: C.digest(evidence), assignedCents, asOf: '2026-10-04' };
  const prepared = C.prepare(body, { householdId, actorId, operationId: op(1), command: cmd, now: T0 });
  const confirmed = C.confirmCandidate(body, { householdId, actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest, now: T0 + 1 });
  assert.equal(confirmed.status, 'candidate', 'link recorded');
  body = confirmed.document;
  const state = JSON.parse(body.toString('utf8'));
  return C.effectiveEvidence({ householdId: state.householdId, revision: state.revision, operations: state.operations });
}

function input() {
  const x = fx.fixture();
  x.plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'commitment', id: 'near' }];
  return x;
}

function surfaces(x, opts) {
  const inventory = F.savingsInventory(x.plan, x.asOf, opts);
  const pool = (inventory.pools || []).find(p => p.id === 'club-pool');
  const goal = pool && pool.plannedGoals.find(g => g.key === 'commitment:near');
  const events = F.expandEvents(x.plan, x.asOf, '2026-11-30', opts)
    .filter(e => e.kind === 'commitment' && e.id === 'near');
  const advice = F.recommend(x.plan, x.asOf, { ...x.opts, ...opts, weeklyVariable: 0, debts: [] });
  const seq = (advice.fundingSequence || []).find(e => e.id === 'near');
  return { goal, events, seq };
}

test('control: without settlement evidence the commitment still requires its full cost', () => {
  const { goal, events, seq } = surfaces(input(), {});
  assert.equal(goal.target, 60);
  assert.equal(events.length, 1);
  assert.equal(events[0].amount, -60);
  assert.equal(seq.need, 60);
});

test('partial link: a confirmed 25 assignment against a 60 cost leaves remaining 35 everywhere', () => {
  const eff = evidenceWithLink({});
  const { goal, events, seq } = surfaces(input(), { settlementEvidence: eff });
  assert.equal(goal.target, 60, 'original cost preserved');
  assert.equal(goal.linkedPaid, 25, 'linked paid is its own figure');
  assert.equal(goal.remaining, 35, 'remaining = original - linked paid');
  assert.equal(events.length, 1);
  assert.equal(events[0].amount, -35, 'cash event carries the relieved amount, not the original');
  assert.equal(seq.need, 35, 'funding sequence needs only the remaining');
});

// --- Extended matrix --------------------------------------------------------
// Multi-command evidence built through the same real Phase 1 contract:
// prepare -> digest-pinned confirm per operation, non-decreasing recordedAt.
function buildEvidence(commands) {
  let body = C.adopt({ householdId });
  commands.forEach((command, i) => {
    const at = T0 + i * 10;
    const prepared = C.prepare(body, { householdId, actorId, operationId: op(i + 1), command, now: at });
    const confirmed = C.confirmCandidate(body, { householdId, actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest, now: at + 1 });
    assert.equal(confirmed.status, 'candidate', 'command ' + (i + 1) + ' recorded');
    body = confirmed.document;
  });
  const state = JSON.parse(body.toString('utf8'));
  return C.effectiveEvidence({ householdId: state.householdId, revision: state.revision, operations: state.operations });
}
const linkCmd = ({ goalId = 'commitment:near', txRef = tx(1), assignedCents = 2500, evidenceDate = '2026-10-03', evidenceCents = 6000, asOf = '2026-10-04' } = {}) => {
  const evidence = { accountId: 'acct-main', currency: 'cad', direction: 'debit', date: evidenceDate, cents: evidenceCents, posted: true };
  return { version: 1, kind: 'link', goalId, txRef, evidence, evidenceDigest: C.digest(evidence), assignedCents, asOf };
};
const reverseCmd = (targetOperationId, cents = 500) => {
  const counterEvidence = { accountId: 'acct-main', currency: 'cad', direction: 'credit', date: '2026-10-04', cents: 6000, posted: true };
  return { version: 1, kind: 'reverse', targetOperationId, counterTxRef: tx(9), counterEvidence, counterEvidenceDigest: C.digest(counterEvidence), cents };
};
const retractCmd = targetOperationId => ({ version: 1, kind: 'retract', targetOperationId });

// Publication prerequisite: independent synthetic cost/paid/unpaid expectations.
// These facts describe the eligible native roster at the opening, never Saved,
// feasibility shortfall, a projected payment, or additional money to save.
function costPublication(x, evidence) {
  const opts = { ...x.opts, weeklyVariable: 0, debts: [], settlementEvidence: evidence };
  const advice = F.recommend(x.plan, x.asOf, opts);
  const funding = advice.savingsFunding || F.savingsDailyFunding(x.plan, [], x.asOf, opts);
  return { advice, funding,
    goal: goalOf(x, opts, 'commitment:near'),
    sequence: advice.fundingSequence.find(r => r.id === 'near'),
    major: advice.majorPlans.find(r => r.id === 'near'),
    item: [...funding.backing.items, ...funding.unresolved].find(r => r.id === 'near'),
    row: funding.rows.find(r => r.members.includes('near@2026-10-21')) };
}
function combinedInput() {
  const x = require('./fixtures/chronological-savings-data').policy(fx.advance(input(), '2026-10-07'));
  x.plan.commitments = x.plan.commitments.filter(c => c.id === 'near');
  return x;
}
function knownCost(amount, range = null) { return { status: 'known', amount, range }; }
function unknownCost(status = 'unavailable') { return { status, amount: null, range: null }; }
function assertCost(row, asOf, original, paid, unpaid) {
  assert.ok(row, 'native publication row exists');
  assert.deepEqual(row.commitmentCost, { asOf, originalCost: original,
    confirmedLinkedPaid: paid, unpaidCost: unpaid });
}
for (const [name, cents, paid, unpaid] of [['partial', 2500, 25, 35], ['full', 6000, 60, 0]]) {
  test('publication facts: ' + name + ' 60 cost survives every current boundary', () => {
    const x = combinedInput(), before = JSON.stringify(x);
    const p = costPublication(x, buildEvidence([linkCmd({ assignedCents: cents })]));
    for (const row of [p.goal, p.sequence, p.major, p.item, p.row])
      assertCost(row, x.asOf, knownCost(60), knownCost(paid), knownCost(unpaid));
    assert.equal(p.sequence.need, unpaid);
    assert.equal(p.item.needed, unpaid);
    assert.equal(p.row.needed, unpaid);
    assert.equal(p.major.remaining, 0, 'feasibility shortfall keeps its separate incumbent meaning');
    assert.equal(p.funding.stock.amount, 119, 'reported stock is not payment history');
    assert.equal(JSON.stringify(x), before, 'publication does not mutate inputs');
  });
}
test('publication facts: unconfigured, empty, future-effective and retracted evidence remain distinct', () => {
  const x = combinedInput();
  const plain = costPublication(x);
  for (const row of [plain.goal, plain.sequence, plain.major, plain.item, plain.row])
    assertCost(row, x.asOf, knownCost(60), unknownCost('unconfigured'), unknownCost('unconfigured'));
  const cases = [buildEvidence([]), buildEvidence([linkCmd({ evidenceDate: '2026-10-09', asOf: '2026-10-09' })]),
    buildEvidence([linkCmd({}), retractCmd(op(1))])];
  for (const evidence of cases) {
    const p = costPublication(x, evidence);
    for (const row of [p.goal, p.sequence, p.major, p.item, p.row])
      assertCost(row, x.asOf, knownCost(60), knownCost(0), knownCost(60));
    assert.equal(p.sequence.need, 60);
  }
});
test('publication facts: uncertain settlement never becomes zero paid or unpaid', () => {
  for (const commands of [[linkCmd({}), reverseCmd(op(1))], [linkCmd({ assignedCents: 7000, evidenceCents: 9000 })]]) {
    const x = combinedInput(), p = costPublication(x, buildEvidence(commands));
    for (const row of [p.goal, p.sequence, p.major, p.item, p.row])
      assertCost(row, x.asOf, knownCost(60), unknownCost(), unknownCost());
    assert.equal(p.item.needed, null);
    assert.equal(p.major.remaining, null, 'existing unavailable feasibility publication stays withheld');
  }
});
test('publication facts: original ranges survive; a linked range withholds payment and unpaid facts', () => {
  const x = combinedInput(), c = x.plan.commitments.find(r => r.id === 'near');
  delete c.amount; c.amountMin = 50; c.amountMax = 70;
  for (const [evidence, paid, unpaid] of [[buildEvidence([]), knownCost(0), knownCost(null, { min: 50, max: 70 })],
    [buildEvidence([linkCmd({})]), unknownCost(), unknownCost()]]) {
    const p = costPublication(x, evidence);
    for (const row of [p.goal, p.sequence, p.major, p.item, p.row])
      assertCost(row, x.asOf, knownCost(null, { min: 50, max: 70 }), paid, unpaid);
    assert.equal(p.sequence.need, null, 'no point cost is invented');
  }
});
test('publication facts: native group totals reconcile 230 / 25 / 205 without label matching', () => {
  const x = combinedInput();
  x.plan.commitments.push(fx.fixture().plan.commitments[1]);
  x.plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'group', id: 'club' }];
  x.plan.commitments[1].label = x.plan.commitments[0].label;
  const evidence = buildEvidence([linkCmd({})]);
  const goal = goalOf(x, { settlementEvidence: evidence }, 'group:club');
  x.plan.savingsEarmarks.pools[0].goalRefs.push({ kind: 'commitment', id: 'near' });
  const p = costPublication(x, evidence);
  for (const row of [goal, p.row]) assertCost(row, x.asOf, knownCost(230), knownCost(25), knownCost(205));
  assert.deepEqual(p.row.members, ['near@2026-10-21', 'far@2026-10-28']);
  assert.equal(p.row.saved, 95, '119 stock funds 24 home cost and 95 club cost once');
  const members = p.funding.backing.items.filter(i => p.row.members.includes(i.key));
  for (const key of ['originalCost', 'confirmedLinkedPaid', 'unpaidCost'])
    assert.equal(p.row.commitmentCost[key].amount * 100,
      members.reduce((sum, i) => sum + Math.round(i.commitmentCost[key].amount * 100), 0));
});
test('publication facts: duplicate native identity withholds facts instead of counting twice or choosing a label', () => {
  const x = combinedInput();
  x.plan.commitments.push({ ...x.plan.commitments[0], label: 'Different invented label' });
  const evidence = buildEvidence([linkCmd({})]);
  const opts = { ...x.opts, settlementEvidence: evidence };
  for (const row of F.fundingSequence(x.plan, x.asOf, opts).filter(r => r.id === 'near'))
    assertCost(row, x.asOf, unknownCost(), unknownCost(), unknownCost());
  const goal = goalOf(x, opts, 'commitment:near');
  assertCost(goal, x.asOf, unknownCost(), unknownCost(), unknownCost());
  const p = costPublication(x, evidence);
  assertCost(p.item, x.asOf, unknownCost(), unknownCost(), unknownCost());
  assertCost(p.row, x.asOf, unknownCost(), unknownCost(), unknownCost());
});
test('publication facts: manual retirement is not lifetime original cost and cannot re-open a goal', () => {
  const x = combinedInput();
  x.plan.commitments.push(fx.fixture().plan.commitments[1]);
  x.plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'group', id: 'club' }];
  x.plan.commitments[0].settledOn = '2026-10-04';
  const evidence = buildEvidence([linkCmd({})]), p = costPublication(x, evidence);
  assert.equal(p.sequence, undefined);
  assert.equal(p.item, undefined);
  assertCost(goalOf(x, { settlementEvidence: evidence }, 'group:club'), x.asOf,
    knownCost(170), knownCost(0), knownCost(170));
  assertCost(p.funding.rows.find(r => r.key === 'group:club'), x.asOf, knownCost(170), knownCost(0), knownCost(170));
});
test('publication facts: historical pool policy also carries the opening facts', () => {
  const x = input(), p = costPublication(x, buildEvidence([linkCmd({})]));
  for (const row of [p.goal, p.sequence, p.major, p.item, p.row])
    assertCost(row, x.asOf, knownCost(60), knownCost(25), knownCost(35));
});
for (const [name, commands] of [['reversal', [linkCmd({}), reverseCmd(op(1))]],
  ['over-assignment', [linkCmd({ assignedCents: 7000, evidenceCents: 9000 })]]]) {
  test('review repair: recommendation inventory keeps historical eligibility under ' + name, () => {
    const x = input(), evidence = buildEvidence(commands);
    x.plan.savingsEarmarks.history = [{ revision: 1, confirmedAt: x.asOf, source: 'Invented confirmation', pools: [
      { poolId: 'club-pool', allocations: [{ goalRef: { kind: 'commitment', id: 'near' }, amount: 30 }] },
      { poolId: 'home-pool', allocations: [] } ] }];
    // The recommendation's incumbent inventory call supplied no funding opts.
    // Its exact eligibility contract must survive annotation with the new facts.
    const incumbent = F.savingsInventory(x.plan, x.asOf);
    const advice = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [], settlementEvidence: evidence });
    assert.equal(incumbent.incrementalInstructions, 'eligible');
    assert.equal(incumbent.instructionReason,
      'Funding proposals require matching payments and count backed assignments once. New contributions are proposals, not saved balances or transfers.');
    assert.equal(advice.savingsInventory.incrementalInstructions, incumbent.incrementalInstructions);
    assert.equal(advice.savingsInventory.instructionReason, incumbent.instructionReason);
    const oldFields = value => JSON.parse(JSON.stringify(value, (key, v) => key === 'commitmentCost' ? undefined : v));
    assert.deepEqual(oldFields(advice.savingsInventory), oldFields(incumbent), 'only new facts are annotated');
    for (const row of [advice.savingsInventory.pools[0].plannedGoals[0], advice.savingsInventory.goals[0]])
      assertCost(row, x.asOf, knownCost(60), unknownCost(), unknownCost());
    assert.equal(advice.fundingSequence.find(r => r.id === 'near').need, null,
      'the incumbent settlement-dependent funding need still withholds');
  });
}
test('review repair: historical group facts exclude retired members without changing the retained roster', () => {
  const x = fx.fixture(), evidence = buildEvidence([]);
  x.plan.commitments[0].settledOn = '2026-10-04';
  const opts = { ...x.opts, settlementEvidence: evidence };
  const before = JSON.stringify(x), p = F.savingsDailyFunding(x.plan, [], x.asOf, opts);
  const row = p.rows.find(r => r.key === 'group:club');
  const goal = goalOf(x, opts, 'group:club');
  assert.deepEqual(row.members, ['near@2026-10-21', 'far@2026-10-28'], 'retired intent remains in its incumbent roster');
  assert.equal(row.needed, 170); assert.equal(row.saved, 95);
  const retired = p.backing.items.find(i => i.id === 'near');
  assert.equal(retired.inactive, true); assert.equal(retired.needed, 0); assert.equal(retired.saved, 0);
  assertCost(retired, x.asOf, unknownCost(), unknownCost(), unknownCost());
  assertCost(goal, x.asOf, knownCost(170), knownCost(0), knownCost(170));
  assertCost(row, x.asOf, knownCost(170), knownCost(0), knownCost(170));
  assert.equal(JSON.stringify(x), before, 'no settlement, intent or financial input is changed');
});
test('review repair: historical disabled and all-retired rosters retain incumbent amounts and eligibility', () => {
  const x = fx.fixture(), evidence = buildEvidence([]);
  const opts = { ...x.opts, settlementEvidence: evidence, disabled: ['near'] };
  const disabled = F.savingsDailyFunding(x.plan, [], x.asOf, opts), row = disabled.rows.find(r => r.key === 'group:club');
  assert.deepEqual(row.members, ['near@2026-10-21', 'far@2026-10-28']);
  assert.equal(row.needed, 170); assert.equal(row.saved, 95);
  assertCost(row, x.asOf, knownCost(170), knownCost(0), knownCost(170));
  x.plan.commitments.forEach(c => { c.settledOn = '2026-10-04'; });
  const retired = F.savingsDailyFunding(x.plan, [], x.asOf, { ...opts, disabled: [] });
  const all = retired.rows.find(r => r.key === 'group:club');
  assert.equal(all.needed, 0); assert.equal(all.saved, 0);
  assert.deepEqual(all.members, ['near@2026-10-21', 'far@2026-10-28']);
  assertCost(all, x.asOf, unknownCost(), unknownCost(), unknownCost());
});
test('publication facts: future roster retirement recomputes group facts from exact survivors', () => {
  const x = require('./fixtures/savings-selected-roster-data')('card');
  const evidence = buildEvidence([linkCmd({ goalId: 'commitment:early' }),
    linkCmd({ goalId: 'commitment:next', txRef: tx(2), assignedCents: 1000 })]);
  const advice = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [], settlementEvidence: evidence });
  const current = advice.savingsFunding, before = JSON.stringify(current);
  const period = advice.payPeriodViews.find(p => p.start === '2026-10-16');
  const selected = F.savingsFundingPublication(current, { asOf: x.asOf, advice, periodId: period.id });
  const row = selected.plannedRequirements.rows.find(r => r.key === 'group:installments');
  assert.deepEqual(row.members, ['next@2026-10-30']);
  assertCost(row, x.asOf, knownCost(40), knownCost(10), knownCost(30));
  const item = selected.plannedRequirements.items.find(i => i.id === 'next');
  assertCost(item, x.asOf, knownCost(40), knownCost(10), knownCost(30));
  assert.equal(row.needed, 30);
  assert.equal(item.actualSaved, null);
  // Generic future wrappers do not promise these are future actual facts.
  assertCost(selected.rows.find(r => r.key === 'group:installments'), x.asOf,
    unknownCost(), unknownCost(), unknownCost());
  const last = advice.payPeriodViews.find(p => p.start === '2026-10-30');
  const retired = F.savingsFundingPublication(current, { asOf: x.asOf, advice, periodId: last.id });
  assert.ok(!retired.plannedRequirements.rows.some(r => r.key === 'group:installments'));
  assert.equal(JSON.stringify(current), before, 'navigation never mutates current actual facts');
});
test('publication facts: future-effective evidence stays future at projected publication', () => {
  const x = require('./fixtures/savings-selected-roster-data')('card');
  const evidence = buildEvidence([linkCmd({ goalId: 'commitment:next', evidenceDate: '2026-10-20', asOf: '2026-10-20' })]);
  const advice = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [], settlementEvidence: evidence });
  const period = advice.payPeriodViews.find(p => p.start === '2026-10-16');
  const p = F.savingsFundingPublication(advice.savingsFunding, { asOf: x.asOf, advice, periodId: period.id });
  assertCost(p.plannedRequirements.rows.find(r => r.key === 'group:installments'), x.asOf,
    knownCost(40), knownCost(0), knownCost(40));
});
test('publication facts: selected closing scenario withholds opening facts at every generic future wrapper', () => {
  const x = require('./fixtures/savings-selected-roster-data')();
  const advice = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [],
    settlementEvidence: buildEvidence([linkCmd({ goalId: 'commitment:next', assignedCents: 1000 })]) });
  const period = advice.payPeriodViews.find(p => p.start === '2026-10-16');
  const p = F.savingsFundingPublication(advice.savingsFunding, { asOf: x.asOf, advice, periodId: period.id });
  assert.equal(p.forecastClosing.status, 'ready', 'exercise the publishing closing branch');
  for (const row of [...p.rows, ...p.backing.items, ...p.unresolved, ...p.forecastClosing.items, ...p.forecastClosing.rows])
    if (row.commitmentCost) assertCost(row, x.asOf, unknownCost(), unknownCost(), unknownCost());
  assertCost(p.plannedRequirements.rows.find(r => r.key === 'group:installments'), x.asOf,
    knownCost(40), knownCost(10), knownCost(30));
});
test('publication facts: group ranges aggregate exact member endpoints without inventing a point', () => {
  const x = combinedInput(); x.plan.commitments.push(fx.fixture().plan.commitments[1]);
  const near = x.plan.commitments[0]; delete near.amount; near.amountMin = 50.01; near.amountMax = 70.03;
  x.plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'group', id: 'club' }];
  const evidence = buildEvidence([]), p = costPublication(x, evidence);
  const range = knownCost(null, { min: 220.01, max: 240.03 });
  for (const row of [goalOf(x, { settlementEvidence: evidence }, 'group:club'), p.row])
    assertCost(row, x.asOf, range, knownCost(0), range);
});
test('publication facts: disabled and fully retired requirements cannot supply a paid or original-cost claim', () => {
  const x = combinedInput(), evidence = buildEvidence([linkCmd({})]);
  const opts = { ...x.opts, disabled: ['near'], settlementEvidence: evidence };
  const goal = goalOf(x, opts, 'commitment:near');
  assertCost(goal, x.asOf, unknownCost(), unknownCost(), unknownCost());
  assert.ok(!F.fundingSequence(x.plan, x.asOf, opts).some(r => r.id === 'near'));
  const p = F.savingsDailyFunding(x.plan, [], x.asOf, opts);
  assert.ok(!p.backing.items.some(r => r.id === 'near'));
  x.plan.commitments[0].settledOn = '2026-10-04';
  const retired = goalOf(x, { settlementEvidence: evidence }, 'commitment:near');
  assert.equal(retired.target, 0, 'the existing retired target is preserved');
  assert.equal(retired.settled, true);
  assertCost(retired, x.asOf, unknownCost(), unknownCost(), unknownCost());
});
test('publication facts: colliding native carriers withhold commitment facts', () => {
  const x = combinedInput();
  x.plan.bills.push({ id: 'near', label: 'Invented colliding bill', frequency: 'once',
    date: '2026-10-21', amount: 60, confidence: 'confirmed' });
  const p = costPublication(x, buildEvidence([linkCmd({})]));
  for (const row of [p.goal, p.sequence, p.major, p.item, p.row])
    assertCost(row, x.asOf, unknownCost(), unknownCost(), unknownCost());
  x.plan.bills = [];
  x.plan.groups.push({ id: 'club', label: 'Conflicting invented group' });
  const ambiguous = costPublication(x, buildEvidence([linkCmd({})]));
  for (const row of [ambiguous.goal, ambiguous.sequence, ambiguous.major, ambiguous.item, ambiguous.row])
    assertCost(row, x.asOf, unknownCost(), unknownCost(), unknownCost());
});
test('publication facts: grouped major-plan rows and confirmed-intent inventory preserve the same native facts', () => {
  const x = combinedInput(), evidence = buildEvidence([linkCmd({})]);
  x.plan.savingsEarmarks.history = [{ revision: 1, confirmedAt: x.asOf, source: 'Invented confirmation', pools: [
    { poolId: 'club-pool', allocations: [{ goalRef: { kind: 'commitment', id: 'near' }, amount: 30 }] },
    { poolId: 'home-pool', allocations: [] } ] }];
  const p = costPublication(x, evidence);
  const inventory = F.savingsInventory(x.plan, x.asOf, { settlementEvidence: evidence });
  assertCost(inventory.goals.find(g => g.key === 'commitment:near'), x.asOf, knownCost(60), knownCost(25), knownCost(35));
  assertCost(p.advice.savingsInventory.pools[0].plannedGoals[0], x.asOf, knownCost(60), knownCost(25), knownCost(35));
  const member = p.advice.majorPlans.find(c => c.group === 'club');
  assertCost(member, x.asOf, knownCost(60), knownCost(25), knownCost(35));
});
test('publication facts: relieved chronological cash is conserved and actual stock never grows from payment evidence', () => {
  const x = require('./fixtures/chronological-savings-data').ledger();
  const p = costPublication(x, buildEvidence([linkCmd({})]));
  assert.equal(p.funding.timeline.status, 'ready');
  for (const [date, operating, reserve, combined] of [['2026-10-07', 80, 119, 199],
    ['2026-10-21', 80, 84, 164], ['2026-11-01', 80, 84, 164], ['2026-11-02', 157, 84, 241]]) {
    const day = p.funding.timeline.daily.find(d => d.date === date);
    assert.deepEqual([day.operatingCash, day.savingsCash, day.combinedHouseholdCash], [operating, reserve, combined]);
  }
  for (const day of p.funding.timeline.daily)
    assert.equal(BigInt(Math.round(day.operatingCash * 100)) + BigInt(Math.round(day.savingsCash * 100)),
      BigInt(Math.round(day.combinedHouseholdCash * 100)));
  assert.equal(p.funding.stock.amount, 119);
  assert.equal(p.item.saved, 35);
  assert.equal(p.funding.timeline.payments.filter(r => r.id === 'near').length, 1);
  assert.equal(p.funding.timeline.payments.find(r => r.id === 'near').amount, 35);
  assert.equal(p.advice.planSpendPaydayFunding.costs.find(r => r.id === 'near').stillToFund, 0,
    'the incumbent qualified shortfall is unchanged');
});

function goalOf(x, opts, key, poolId = 'club-pool') {
  const inventory = F.savingsInventory(x.plan, x.asOf, opts);
  const pool = (inventory.pools || []).find(p => p.id === poolId);
  return pool && pool.plannedGoals.find(g => g.key === key);
}

test('full link: remaining 0, no cash event, and the goal is NOT settled', () => {
  const eff = buildEvidence([linkCmd({ assignedCents: 6000 })]);
  const { goal, events, seq } = surfaces(input(), { settlementEvidence: eff });
  assert.equal(goal.target, 60, 'original cost preserved');
  assert.equal(goal.linkedPaid, 60);
  assert.equal(goal.remaining, 0, 'fully relieved');
  assert.equal(goal.settled, false, 'a link is not settledOn settlement; history is retained');
  assert.equal(events.length, 0, 'no future cash event for a fully relieved commitment');
  assert.equal(seq.need, 0, 'funding sequence requires nothing further');
});

test('absent or null evidence is byte-identical to no evidence at all', () => {
  const x = input();
  const base = { ...x.opts, weeklyVariable: 0, debts: [] };
  // recommend echoes the caller's own opts back in its assumptions record
  // (true on unmodified main for any opt key); delete that echo of the seam
  // key itself, then every computed figure must match byte for byte.
  const stripEcho = value => JSON.parse(JSON.stringify(value, (key, v) => key === 'settlementEvidence' ? undefined : v));
  const plain = F.recommend(x.plan, x.asOf, base);
  const withNull = F.recommend(x.plan, x.asOf, { ...base, settlementEvidence: null });
  const withUndefined = F.recommend(x.plan, x.asOf, { ...base, settlementEvidence: undefined });
  assert.deepEqual(stripEcho(withNull), stripEcho(plain), 'null evidence changes no computed figure');
  assert.deepEqual(stripEcho(withUndefined), stripEcho(plain), 'undefined evidence changes no computed figure');
  const invPlain = F.savingsInventory(x.plan, x.asOf);
  const invNull = F.savingsInventory(x.plan, x.asOf, { settlementEvidence: null });
  assert.equal(JSON.stringify(invNull), JSON.stringify(invPlain), 'inventory is unchanged without evidence');
});

test('future-dated link: effective after asOf gives no relief anywhere', () => {
  const eff = buildEvidence([linkCmd({ evidenceDate: '2026-10-06', asOf: '2026-10-06' })]);
  const { goal, events, seq } = surfaces(input(), { settlementEvidence: eff });
  assert.equal(goal.linkedPaid, 0, 'a link not yet effective pays nothing yet');
  assert.equal(goal.remaining, 60);
  assert.equal(events.length, 1);
  assert.equal(events[0].amount, -60);
  assert.equal(seq.need, 60);
});

test('reversal-bearing link: no relief, remaining uncertain and withheld, never gross-as-net', () => {
  const eff = buildEvidence([linkCmd({}), reverseCmd(op(1))]);
  const { goal, events, seq } = surfaces(input(), { settlementEvidence: eff });
  assert.equal(goal.target, 60, 'original cost still known');
  assert.equal(goal.settlementUncertain, true, 'the reversal makes the remaining figure uncertain');
  assert.equal(goal.remaining, null, 'remaining is withheld, not the gross assignment netted');
  assert.equal(goal.linkedPaid, null, 'gross assigned is not published as paid');
  assert.equal(events.length, 0, 'no cash event is fabricated from uncertain evidence');
  assert.equal(seq.need, null, 'funding sequence withholds the need');
  assert.equal(seq.settlementUncertain, true);
});

test('retracted link: absent from effective evidence, so it relieves nothing', () => {
  const eff = buildEvidence([linkCmd({}), retractCmd(op(1))]);
  assert.deepEqual(eff.commitments, [], 'retraction removes the link from effective evidence');
  const { goal, events, seq } = surfaces(input(), { settlementEvidence: eff });
  assert.equal(goal.linkedPaid, 0);
  assert.equal(goal.remaining, 60);
  assert.equal(events.length, 1);
  assert.equal(events[0].amount, -60);
  assert.equal(seq.need, 60);
});

test('ranged commitment with a link: relief withheld as uncertain in v1, range itself preserved', () => {
  const x = input();
  const row = x.plan.commitments.find(c => c.id === 'near');
  delete row.amount; row.amountMin = 50; row.amountMax = 70;
  const eff = buildEvidence([linkCmd({})]);
  const goal = goalOf(x, { settlementEvidence: eff }, 'commitment:near');
  assert.equal(goal.target, 50, 'range floor stays the published target');
  assert.equal(goal.targetMax, 70, 'range ceiling stays published');
  assert.equal(goal.settlementUncertain, true, 'v1 does not relieve a range');
  assert.equal(goal.remaining, null, 'remaining withheld for a ranged row');
  assert.equal(goal.remainingMax, null);
  const seq = F.fundingSequence(x.plan, x.asOf, { settlementEvidence: eff }).find(e => e.id === 'near');
  assert.equal(seq.settlementUncertain, true, 'funding sequence flags the same uncertainty');
});

test('over-assignment: sum assigned above the row amount is uncertain, never silently capped', () => {
  const eff = buildEvidence([linkCmd({ assignedCents: 7000, evidenceCents: 9000 })]);
  const { goal, events, seq } = surfaces(input(), { settlementEvidence: eff });
  assert.equal(goal.settlementUncertain, true);
  assert.equal(goal.remaining, null, 'withheld — not capped to a fabricated 0 remaining');
  assert.equal(goal.linkedPaid, null, 'the over-assigned gross is not published as paid');
  assert.equal(events.length, 0, 'no cash event from over-assigned evidence');
  assert.equal(seq.need, null);
});

test('group goalRef: relief aggregates per member into the group remaining', () => {
  const x = fx.fixture(); // club-pool refs the whole club group (near 60 + far 170)
  const eff = buildEvidence([linkCmd({})]); // 25 against near only
  const goal = goalOf(x, { settlementEvidence: eff }, 'group:club');
  assert.equal(goal.target, 230, 'group original cost is both members');
  assert.equal(goal.linkedPaid, 25, 'only the linked member contributes paid');
  assert.equal(goal.remaining, 205, 'group remaining is the sum of member remainings');
});

test('two links with different transaction identities sum their assignments', () => {
  const eff = buildEvidence([linkCmd({ txRef: tx(1), assignedCents: 2500 }), linkCmd({ txRef: tx(2), assignedCents: 1000 })]);
  const { goal, events, seq } = surfaces(input(), { settlementEvidence: eff });
  assert.equal(goal.linkedPaid, 35);
  assert.equal(goal.remaining, 25);
  assert.equal(events[0].amount, -25);
  assert.equal(seq.need, 25);
});

test('one transaction split across two commitments relieves each by its own assignment only', () => {
  const x = input();
  x.plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'commitment', id: 'near' }, { kind: 'commitment', id: 'far' }];
  const eff = buildEvidence([
    linkCmd({ goalId: 'commitment:near', txRef: tx(1), assignedCents: 2500 }),
    linkCmd({ goalId: 'commitment:far', txRef: tx(1), assignedCents: 3500 }),
  ]);
  const near = goalOf(x, { settlementEvidence: eff }, 'commitment:near');
  const far = goalOf(x, { settlementEvidence: eff }, 'commitment:far');
  assert.equal(near.linkedPaid, 25, 'near keeps only its own assignment');
  assert.equal(near.remaining, 35);
  assert.equal(far.linkedPaid, 35, 'far keeps only its own assignment');
  assert.equal(far.remaining, 135);
});

test('fully relieved member flows through the combined backing without becoming unresolved', () => {
  const chrono = require('./fixtures/chronological-savings-data');
  const x = chrono.ledger(); // combined-pool allocation policy, near 60 due 2026-10-21, asOf 2026-10-07
  const eff = buildEvidence([linkCmd({ assignedCents: 6000 })]);
  const advice = F.recommend(x.plan, x.asOf, { ...x.opts, settlementEvidence: eff, weeklyVariable: 0, debts: [] });
  const funding = advice.savingsFunding;
  assert.equal(funding.backing.status, 'ready', 'combined backing stays ready');
  const item = (funding.backing.items || []).find(i => i.id === 'near');
  assert.ok(item, 'the relieved member is still a known item');
  assert.equal(item.needed, 0, 'combined backing needs nothing further for it');
  assert.ok(!(funding.unresolved || []).some(i => i.id === 'near'), 'full relief is not an unresolved requirement');
  assert.ok(!(advice.sim.events || []).some(e => e.kind === 'commitment' && e.id === 'near'),
    'no cash event is walked for the relieved commitment');
  const control = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] });
  const controlItem = (control.savingsFunding.backing.items || []).find(i => i.id === 'near');
  assert.equal(controlItem.needed, 60, 'control: without evidence the full cost is still needed');
});

test('current-period bills: planned stays the original cost while remaining takes the relief', () => {
  const x = input();
  x.plan.commitments.find(c => c.id === 'near').date = '2026-10-14'; // inside the current pay period
  const action = opts => F.currentPeriodAction(x.plan, x.asOf, { ...x.opts, ...opts });
  const billOf = a => (a.bills || []).find(b => b.id === 'near');
  const control = billOf(action({}));
  assert.equal(control.planned, 60, 'control planned is the full cost');
  assert.equal(control.remaining, 60, 'control remaining is the full cost');
  // Link effective 2026-10-04: after the period origin (2026-10-02) but on or
  // before asOf (2026-10-05). The walk-start cutoff inside expandEvents cannot
  // see it; this action list is pinned to asOf and must still relieve.
  const eff = buildEvidence([linkCmd({})]);
  const relieved = billOf(action({ settlementEvidence: eff }));
  assert.equal(relieved.planned, 60, 'planned remains the original cost, not the relieved amount');
  assert.equal(relieved.remaining, 35, 'remaining is relieved at the asOf cutoff');
  assert.equal(relieved.linkedPaid, 25, 'linked paid is published as its own figure');
});

test('original-cost publications keep the stated amounts under relief', () => {
  const x = input();
  const eff = buildEvidence([linkCmd({})]);
  const totals = F.publicationTotals({ plan: x.plan, debts: [], income: [], meta: { asOf: x.asOf } });
  assert.equal(totals.commitmentsTotal, 230, 'publication totals list original plan cost');
  assert.equal(totals.commitmentItems.find(i => i.id === 'near').amount, 60);
  const est = input();
  est.plan.commitments.find(c => c.id === 'near').confidence = 'estimated';
  const advice = F.recommend(est.plan, est.asOf, { ...est.opts, settlementEvidence: eff, weeklyVariable: 0, debts: [] });
  const phases = F.planPhases(est.plan, advice, {}, { ...est.opts, settlementEvidence: eff });
  const risk = (phases.risks || []).find(r => r.id === 'estimatedCommitments');
  assert.ok(risk, 'estimated-commitments risk is published');
  assert.equal(risk.total, 60, 'estimation exposure stays the original stated amount');
});

test('no input or evidence mutation across every relieved surface', () => {
  const x = input();
  const eff = buildEvidence([linkCmd({})]);
  const before = JSON.stringify({ x, eff });
  surfaces(x, { settlementEvidence: eff });
  F.savingsDailyFunding(x.plan, [], x.asOf, { ...x.opts, settlementEvidence: eff });
  F.currentPeriodAction(x.plan, x.asOf, { ...x.opts, settlementEvidence: eff });
  assert.equal(JSON.stringify({ x, eff }), before, 'plan, opts and evidence are read-only inputs');
});

test('backed allocation stays coherent: need and floor move together under relief', () => {
  const x = input();
  x.plan.savingsEarmarks.history = [{ revision: 1, confirmedAt: '2026-10-02', source: 'Invented confirmation', pools: [
    { poolId: 'club-pool', allocations: [{ goalRef: { kind: 'commitment', id: 'near' }, amount: 35 }] },
    { poolId: 'home-pool', allocations: [{ goalRef: { kind: 'yearly-bill', id: 'home-cost' }, amount: 24 }] },
  ] }];
  const eff = buildEvidence([linkCmd({})]); // remaining 35, exactly the backed allocation
  const inventory = F.savingsInventory(x.plan, x.asOf, { settlementEvidence: eff });
  assert.equal(inventory.incrementalInstructions, 'eligible',
    'reserve funding stays ready: relieved need and relieved floor still agree');
  const pool = inventory.pools.find(p => p.id === 'club-pool');
  const entry = pool.allocations.find(a => a.goalKey === 'commitment:near');
  assert.equal(entry.backed, 35, 'the confirmed allocation itself is untouched by relief');
});

// --- Repair round 2 (Systems Review BLOCKING 6267256478 on head 0e085808) ---
// Round 1 published goal/sequence uncertainty but let the same commitment
// drop out of the cash consumers as though its remaining cost were zero,
// and let the funding timeline resurrect the original cost from an
// explicitly-null remainingMax. The pins below assert the publication
// level: the scheduled-amount gate names the unknown, the cash walk
// withholds, the timeline withholds with its reason, the budget breakdown
// withholds the aggregates the uncertain row feeds while retaining its
// identity, and the current-period action list keeps the commitment
// visible with an unknown remaining — for BOTH uncertainty sources.
function budgetOf(x, opts) {
  return F.budgetBreakdown(x.plan, { periods: { ytd: { months: 3, spending: [] } } },
    { ...opts, asOf: x.asOf });
}

function assertUncertainEverywhere(eff) {
  const x = input();
  const { goal, events, seq } = surfaces(x, { settlementEvidence: eff });
  assert.equal(goal.target, 60, 'original cost still known');
  assert.equal(goal.settlementUncertain, true);
  assert.equal(goal.remaining, null, 'remaining withheld');
  assert.equal(goal.linkedPaid, null, 'gross assigned not published as paid');
  assert.equal(events.length, 0, 'no cash event is fabricated from uncertain evidence');
  assert.equal(seq.need, null, 'funding sequence withholds the need');
  assert.equal(seq.settlementUncertain, true);
  // The scheduled-amount gate names the commitment as an unknown even
  // though its original amount is finite.
  const state = F.scheduledAmountState(x.plan, x.asOf, '2026-12-31', { settlementEvidence: eff });
  assert.equal(state.status, 'unavailable', 'the scheduled-amount gate withholds');
  assert.ok(state.unknowns.some(u => u.carrier === 'commitment' && u.id === 'near'
    && u.reason === 'settlement-remaining-unknown'), 'the uncertain commitment is named an unknown');
  // The cash walk withholds: no numeric ending publishes as though the
  // remaining cost were zero. Withholding follows the established
  // scheduled-amount semantics — the whole walk's ending/minimum claims
  // are unavailable and the affected carrier total is nulled, while
  // unaffected carrier totals stay published.
  const sim = F.simulate(x.plan, x.asOf, { ...x.opts, settlementEvidence: eff });
  assert.equal(sim.status, 'unavailable', 'the cash walk withholds');
  assert.equal(sim.ending, null);
  assert.equal(sim.min.balance, null);
  assert.equal(sim.totals.commitments, null, 'the affected carrier total is withheld');
  assert.equal(typeof sim.totals.bills, 'number', 'unaffected carrier totals stay published');
  const advice = F.recommend(x.plan, x.asOf, { ...x.opts, settlementEvidence: eff, weeklyVariable: 0, debts: [] });
  assert.equal(advice.sim.status, 'unavailable', 'recommend carries the withheld walk');
  // The funding timeline withholds the projection rather than converting
  // the explicit unknown back into the original known cost.
  const gx = fx.fixture();
  const group = goalOf(gx, { settlementEvidence: eff }, 'group:club');
  assert.equal(group.settlementUncertain, true);
  assert.equal(group.remainingMax, null, 'uncertainty publishes remainingMax as an explicit null');
  const tl = F.savingsFundingTimeline(gx.plan, [], gx.asOf, { ...gx.opts, settlementEvidence: eff });
  assert.equal(tl.status, 'unavailable', 'the timeline withholds instead of resurrecting the original cost');
  assert.deepEqual(tl.goals, [], 'no timeline goal publishes a resurrected requirement');
  assert.match(tl.reason, /uncertain|unknown/, 'the withholding publishes its reason');
  // The budget breakdown retains the uncertain row's identity and
  // withholds the aggregate it feeds: the sinking total is unknown,
  // never the unaffected member's subtotal presented as the total.
  // Independent figures (the dated aggregate, which no sinking item
  // composes) stay published.
  const bd = budgetOf(gx, { settlementEvidence: eff });
  const retained = bd.sinkingItems.find(i => i.label === 'Invented first club cost');
  assert.ok(retained, 'the uncertain row keeps its identity in the sinking items');
  assert.equal(retained.amount, null, 'its amount is unknown — not zero, not dropped');
  assert.equal(bd.sinkingMonthly, null, 'the sinking aggregate is withheld, not a partial total');
  assert.equal(typeof bd.datedMonthly, 'number', 'the independent dated aggregate stays published');
}

test('over-assignment: unknown remaining withholds the walk, the timeline and the budget figures', () => {
  assertUncertainEverywhere(buildEvidence([linkCmd({ assignedCents: 7000, evidenceCents: 9000 })]));
});

test('reversal-bearing link: unknown remaining withholds the walk, the timeline and the budget figures', () => {
  assertUncertainEverywhere(buildEvidence([linkCmd({}), reverseCmd(op(1))]));
});

function periodInput() {
  const x = fx.fixture();
  x.plan.commitments.find(c => c.id === 'near').date = '2026-10-14'; // inside the current pay period
  return x;
}
function obligationBills(x, opts) {
  return F.currentPeriodObligationStates(x.plan, x.asOf, { ...x.opts, ...opts }).bills || [];
}

test('current-period bills: uncertain link effective before the walk origin stays visible with unknown remaining', () => {
  // Origin 2026-10-02; the link is already effective on 2026-10-01, so
  // expandEvents withholds its event at the walk pin — the row must not
  // vanish from the action list as though nothing were owed.
  for (const eff of [
    buildEvidence([linkCmd({ assignedCents: 7000, evidenceCents: 9000, evidenceDate: '2026-10-01', asOf: '2026-10-02' })]),
    buildEvidence([linkCmd({ evidenceDate: '2026-10-01', asOf: '2026-10-02' }), reverseCmd(op(1))]),
  ]) {
    const x = periodInput();
    const row = obligationBills(x, { periodOrigin: '2026-10-02', settlementEvidence: eff }).find(b => b.id === 'near');
    assert.ok(row, 'the commitment does not vanish from the action list');
    assert.equal(row.planned, 60, 'planned stays the original cost');
    assert.equal(row.remaining, null, 'remaining is unknown, not absent-as-zero');
    assert.equal(row.linkedPaid, null);
    const action = F.currentPeriodAction(x.plan, x.asOf, { ...x.opts, settlementEvidence: eff });
    const actionRow = (action.bills || []).find(b => b.id === 'near');
    assert.ok(actionRow, 'the default action surface keeps the row too');
    assert.equal(actionRow.remaining, null);
  }
});

test('current-period bills: uncertain link effective between origin and asOf stays visible with unknown remaining', () => {
  const x = periodInput();
  const eff = buildEvidence([linkCmd({ assignedCents: 7000, evidenceCents: 9000, evidenceDate: '2026-10-04' })]);
  const row = obligationBills(x, { periodOrigin: '2026-10-02', settlementEvidence: eff }).find(b => b.id === 'near');
  assert.ok(row, 'the commitment is on the action list');
  assert.equal(row.planned, 60);
  assert.equal(row.remaining, null, 'the asOf recheck withholds the remaining');
  assert.equal(row.linkedPaid, null);
});

test('current-period bills: full relief effective before the origin stays absent, like settled', () => {
  const x = periodInput();
  const eff = buildEvidence([linkCmd({ assignedCents: 6000, evidenceDate: '2026-10-01', asOf: '2026-10-02' })]);
  assert.ok(!obligationBills(x, { periodOrigin: '2026-10-02', settlementEvidence: eff }).some(b => b.id === 'near'),
    'a known-zero remaining does not reappear');
});

test('funding timeline: known relief publishes relieved requirements; absent evidence keeps the original', () => {
  const gx = fx.fixture();
  const control = F.savingsFundingTimeline(gx.plan, [], gx.asOf, { ...gx.opts });
  assert.equal(control.status, 'ready');
  assert.equal(control.goals.find(g => g.key === 'group:club').requirement, 230,
    'no evidence: the settlement fields are absent and the original requirement stands');
  const partial = F.savingsFundingTimeline(gx.plan, [], gx.asOf,
    { ...gx.opts, settlementEvidence: buildEvidence([linkCmd({})]) });
  assert.equal(partial.status, 'ready');
  const pg = partial.goals.find(g => g.key === 'group:club');
  assert.equal(pg.requirement, 205, 'partial relief publishes the relieved requirement');
  assert.equal(pg.requirementMax, 205);
  const full = F.savingsFundingTimeline(gx.plan, [], gx.asOf,
    { ...gx.opts, settlementEvidence: buildEvidence([linkCmd({ assignedCents: 6000 })]) });
  assert.equal(full.status, 'ready');
  assert.equal(full.goals.find(g => g.key === 'group:club').requirement, 170,
    'full relief on one member leaves only the other member\u2019s requirement');
});

test('funding timeline: an uncertain goal outside the cash walk withholds at the goal gate itself', () => {
  // An optional commitment is excused from the scheduled-amount gate and
  // emits no cash event, so the trajectory walk stays ready and the
  // timeline reaches its own goal-requirement gate. There the explicit
  // null remainingMax must withhold — the targetMax fallback is valid
  // only when the settlement fields are absent, not null-by-uncertainty.
  const gx = fx.fixture();
  gx.plan.commitments.find(c => c.id === 'near').optional = true;
  const eff = buildEvidence([linkCmd({ assignedCents: 7000, evidenceCents: 9000 })]);
  const group = goalOf(gx, { settlementEvidence: eff }, 'group:club');
  assert.equal(group.settlementUncertain, true);
  assert.equal(group.remainingMax, null);
  const tl = F.savingsFundingTimeline(gx.plan, [], gx.asOf, { ...gx.opts, settlementEvidence: eff });
  assert.equal(tl.status, 'unavailable', 'the goal gate withholds the projection');
  assert.match(tl.reason, /goal requirement is unknown/);
  assert.deepEqual(tl.goals, []);
});

test('cash walk: known partial and full relief stay numeric and ready', () => {
  const x = input();
  const control = F.simulate(x.plan, x.asOf, { ...x.opts });
  const partial = F.simulate(x.plan, x.asOf, { ...x.opts, settlementEvidence: buildEvidence([linkCmd({})]) });
  assert.notEqual(partial.status, 'unavailable', 'known relief does not withhold the walk');
  assert.equal(partial.totals.commitments, 205, 'the walk carries the relieved commitment total');
  assert.equal(Math.round(partial.ending * 100), Math.round((control.ending + 25) * 100),
    'the ending rises by exactly the relieved amount');
  const full = F.simulate(x.plan, x.asOf, { ...x.opts, settlementEvidence: buildEvidence([linkCmd({ assignedCents: 6000 })]) });
  assert.notEqual(full.status, 'unavailable');
  assert.equal(full.totals.commitments, 170, 'a fully relieved commitment contributes no cash event');
  assert.equal(F.scheduledAmountState(x.plan, x.asOf, '2026-12-31',
    { settlementEvidence: buildEvidence([linkCmd({})]) }).status, 'ready',
    'the gate stays ready for known relief');
});

test('an uncertain sibling does not disturb a known commitment\u2019s goal or sequence need', () => {
  const x = input();
  x.plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'commitment', id: 'near' }, { kind: 'commitment', id: 'far' }];
  const eff = buildEvidence([linkCmd({ goalId: 'commitment:far', assignedCents: 20000, evidenceCents: 20000 })]);
  const near = goalOf(x, { settlementEvidence: eff }, 'commitment:near');
  assert.equal(near.settlementUncertain, false, 'the unlinked commitment is untouched');
  assert.equal(near.remaining, 60);
  const far = goalOf(x, { settlementEvidence: eff }, 'commitment:far');
  assert.equal(far.settlementUncertain, true);
  assert.equal(far.remaining, null);
  const seq = F.fundingSequence(x.plan, x.asOf, { settlementEvidence: eff });
  assert.equal(seq.find(e => e.id === 'near').need, 60, 'the known need stands');
  assert.equal(seq.find(e => e.id === 'far').need, null, 'only the uncertain need withholds');
});

// --- Repair round 3 (Systems Review BLOCKING 6267789614 on head 521dbff4) ---
// Round 2 withheld the walk, the timeline and the action list for FINITE
// fixed-cost uncertainty, but three gaps remained: the budget breakdown
// still dropped the uncertain row and published the known subtotal as
// the aggregate (and a round-2 pin encoded that defect — corrected in
// assertUncertainEverywhere above: the test was wrong, not the contract);
// a valid RANGED commitment with an effective link bypassed the cash
// gate through the incumbent range exemption and vanished from the
// action list on its absent fixed amount; and the action-list fallback
// resurrected DISABLED commitments expansion had omitted. The pins below
// assert the approved uncertainty contract at each surface, with the
// no-evidence behaviour of ranges and disabled rows preserved exactly.

test('budget breakdown: an uncertain dated commitment withholds the dated aggregate and keeps its identity', () => {
  const x = fx.fixture();
  x.plan.commitments.push({ id: 'hall', label: 'Invented hall rental', date: '2026-10-24',
    amount: 120, confidence: 'confirmed', adjustable: false, budgetCategory: 'groceries' });
  const months = 91 / (365.25 / 12);
  const control = budgetOf(x, {});
  const gControl = control.categories.find(c => c.id === 'groceries');
  assert.equal(Math.round(control.datedMonthly * 100), Math.round(120 / months * 100),
    'control: the dated aggregate is the known dated draw');
  assert.equal(Math.round(gControl.dated * 100), Math.round(120 / months * 100),
    'control: the category dated total is known');
  const eff = buildEvidence([linkCmd({ goalId: 'commitment:hall', assignedCents: 15000, evidenceCents: 20000 })]);
  const bd = budgetOf(x, { settlementEvidence: eff });
  const g = bd.categories.find(c => c.id === 'groceries');
  const retained = g.datedItems.find(i => i.label === 'Invented hall rental');
  assert.ok(retained, 'the uncertain dated row keeps its identity in the category items');
  assert.equal(retained.amount, null, 'its amount is unknown — not zero, not dropped');
  assert.equal(g.dated, null, 'the category dated aggregate is withheld');
  assert.equal(bd.datedMonthly, null, 'the dated publication is withheld, not a partial total');
  assert.equal(g.planned, null, 'the planned figure withholds with the dated amount it nets off');
  assert.equal(Math.round(bd.sinkingMonthly * 100), Math.round(230 / months * 100),
    'the independent sinking aggregate stays published in full');
});

test('ranged commitment with an effective link: the walk withholds and the action list retains the item', () => {
  const rangedInput = () => {
    const x = periodInput();
    const row = x.plan.commitments.find(c => c.id === 'near');
    delete row.amount; row.amountMin = 50; row.amountMax = 70;
    return x;
  };
  const eff = buildEvidence([linkCmd({ evidenceDate: '2026-10-01', asOf: '2026-10-02' })]);
  const x = rangedInput();
  // The scheduled-amount gate judges settlement uncertainty BEFORE the
  // incumbent range exemption: a valid ranged commitment carrying an
  // effective link has an uncertain remaining under v1.
  const state = F.scheduledAmountState(x.plan, x.asOf, '2026-12-31', { settlementEvidence: eff });
  assert.equal(state.status, 'unavailable', 'the gate withholds for a linked range');
  assert.ok(state.unknowns.some(u => u.carrier === 'commitment' && u.id === 'near'
    && u.reason === 'settlement-remaining-unknown'), 'the linked range is named an unknown');
  const sim = F.simulate(x.plan, x.asOf, { ...x.opts, settlementEvidence: eff });
  assert.equal(sim.status, 'unavailable', 'the cash walk withholds');
  assert.equal(sim.ending, null);
  assert.equal(sim.totals.commitments, null, 'the affected carrier total is withheld');
  // The action list retains the item with an unknown remaining rather
  // than dropping it with its absent fixed amount.
  const row = obligationBills(x, { periodOrigin: '2026-10-02', settlementEvidence: eff }).find(b => b.id === 'near');
  assert.ok(row, 'the linked range stays on the action list');
  assert.equal(row.remaining, null, 'remaining is unknown');
  assert.equal(row.linkedPaid, null);
  assert.equal(row.planned, null, 'a range has no single stated cost to publish as planned');
  // Preservation: with NO evidence the incumbent range behaviour is
  // exact — the gate excuses the range, the walk publishes, and the
  // action list carries no row for it, exactly as before Phase 2.
  const plain = rangedInput();
  assert.equal(F.scheduledAmountState(plain.plan, plain.asOf, '2026-12-31', {}).status, 'ready',
    'no evidence: the range exemption stands');
  const plainSim = F.simulate(plain.plan, plain.asOf, { ...plain.opts });
  assert.equal(typeof plainSim.ending, 'number', 'no evidence: the walk publishes');
  assert.ok(!obligationBills(plain, { periodOrigin: '2026-10-02' }).some(b => b.id === 'near'),
    'no evidence: a ranged commitment is not an action-list row');
  // And a link not yet effective at the walk opening changes nothing.
  const future = rangedInput();
  const futureEff = buildEvidence([linkCmd({ evidenceDate: '2026-10-06', asOf: '2026-10-06' })]);
  assert.equal(F.scheduledAmountState(future.plan, future.asOf, '2026-12-31',
    { settlementEvidence: futureEff }).status, 'ready',
    'a link effective after the walk opens does not reach it');
  assert.ok(!obligationBills(future, { periodOrigin: '2026-10-02', settlementEvidence: futureEff })
    .some(b => b.id === 'near'), 'a not-yet-effective link adds no action-list row');
});

test('current-period bills: the uncertain fallback honours the disabled exclusion and the represented/settled guards', () => {
  const eff = buildEvidence([linkCmd({ assignedCents: 7000, evidenceCents: 9000, evidenceDate: '2026-10-01', asOf: '2026-10-02' })]);
  // Disabled: expansion omits the commitment, and the fallback must not
  // resurrect it — the established disabled exclusion binds both passes.
  const disabled = periodInput();
  assert.ok(!obligationBills(disabled, { periodOrigin: '2026-10-02', disabled: ['near'], settlementEvidence: eff })
    .some(b => b.id === 'near'), 'a disabled uncertain commitment stays absent');
  // Enabled: the same evidence keeps the row visible, remaining unknown.
  const enabled = periodInput();
  const row = obligationBills(enabled, { periodOrigin: '2026-10-02', settlementEvidence: eff }).find(b => b.id === 'near');
  assert.ok(row, 'an enabled uncertain commitment stays visible');
  assert.equal(row.remaining, null);
  assert.equal(row.planned, 60, 'planned stays the original cost');
  // Settled: settledOn remains the commitment's settlement fact; the
  // fallback does not re-open a settled row as uncertain.
  const settled = periodInput();
  settled.plan.commitments.find(c => c.id === 'near').settledOn = '2026-10-03';
  assert.ok(!obligationBills(settled, { periodOrigin: '2026-10-02', settlementEvidence: eff })
    .some(b => b.id === 'near'), 'a settled uncertain commitment stays absent');
  // Represented: a commitment already represented at its date is not
  // re-opened as an uncertain fallback row either.
  const represented = fx.fixture();
  represented.plan.commitments.find(c => c.id === 'near').date = '2026-10-05';
  represented.plan.opening.representedEvents.push({ id: 'near', date: '2026-10-05' });
  assert.ok(!obligationBills(represented, { periodOrigin: '2026-10-02', settlementEvidence: eff })
    .some(b => b.id === 'near'), 'a represented uncertain commitment is not resurrected');
  const named = fx.fixture();
  named.plan.commitments.find(c => c.id === 'near').date = '2026-10-05';
  const namedRow = obligationBills(named, { periodOrigin: '2026-10-02', settlementEvidence: eff }).find(b => b.id === 'near');
  assert.ok(namedRow && namedRow.remaining === null,
    'control: the same row without the represented name is the uncertain fallback row');
});

// --- Repair round 4 (Systems Review BLOCKING 6268532833 on head 9b449ad8) ---
// Round 3 taught the budget breakdown to retain an uncertain row, but its
// commitment loop still applied the incumbent absent-amount exclusion
// BEFORE the relief judgment: a valid ranged commitment has no fixed
// amount, so a linked range never reached the uncertainty handling and
// vanished from the aggregates — the sinking publication printed the
// known members' subtotal as the total, and a dated range left its
// category figures numeric. The pins below assert the judgment-first
// ordering at both budget shapes, with the incumbent range exclusion
// preserved exactly when evidence is absent or not yet effective.

test('budget breakdown: a linked ranged sinking commitment is retained as uncertain and withholds the sinking total', () => {
  const rangedSinking = () => {
    const x = fx.fixture();
    const row = x.plan.commitments.find(c => c.id === 'near');
    delete row.amount; row.amountMin = 50; row.amountMax = 70;
    return x;
  };
  const months = 91 / (365.25 / 12);
  // Effective 25 link against the ranged near commitment; the known far
  // commitment (170, fixed) remains.
  const eff = buildEvidence([linkCmd({})]);
  const bd = budgetOf(rangedSinking(), { settlementEvidence: eff });
  const retained = bd.sinkingItems.find(i => i.label === 'Invented first club cost');
  assert.ok(retained, 'the linked ranged row keeps its identity in the sinking items');
  assert.equal(retained.amount, null, 'its amount is unknown — not zero, not dropped');
  const farItem = bd.sinkingItems.find(i => i.label === 'Invented second club cost');
  assert.ok(farItem, 'the known member stays in the sinking items');
  assert.equal(Math.round(farItem.amount * 100), Math.round(170 / months * 100),
    'the known member keeps its own figure beside the unknown one');
  assert.equal(bd.sinkingMonthly, null,
    'the sinking aggregate is withheld, not the known member\u2019s subtotal');
  assert.equal(typeof bd.datedMonthly, 'number',
    'the independent dated aggregate stays published');
  // Preservation: with NO evidence the incumbent range exclusion is
  // exact — the ranged row is not a sinking item and the total is the
  // known member alone, exactly as before Phase 2.
  const plain = budgetOf(rangedSinking(), {});
  assert.ok(!plain.sinkingItems.some(i => i.label === 'Invented first club cost'),
    'no evidence: the ranged row stays excluded');
  assert.equal(Math.round(plain.sinkingMonthly * 100), Math.round(170 / months * 100),
    'no evidence: the sinking total is the known member alone');
  // And a link not yet effective at the breakdown's asOf excludes the
  // row exactly as no evidence does.
  const futureEff = buildEvidence([linkCmd({ evidenceDate: '2026-10-06', asOf: '2026-10-06' })]);
  const future = budgetOf(rangedSinking(), { settlementEvidence: futureEff });
  assert.ok(!future.sinkingItems.some(i => i.label === 'Invented first club cost'),
    'not yet effective: the ranged row stays excluded');
  assert.equal(Math.round(future.sinkingMonthly * 100), Math.round(170 / months * 100),
    'not yet effective: the sinking total is unchanged');
});

test('budget breakdown: a linked ranged dated commitment withholds its category dated and planned figures', () => {
  const rangedDated = () => {
    const x = fx.fixture();
    x.plan.commitments.push({ id: 'market', label: 'Invented market restock', date: '2026-10-24',
      amountMin: 100, amountMax: 140, confidence: 'confirmed', adjustable: false, budgetCategory: 'groceries' });
    return x;
  };
  const months = 91 / (365.25 / 12);
  const eff = buildEvidence([linkCmd({ goalId: 'commitment:market' })]);
  const bd = budgetOf(rangedDated(), { settlementEvidence: eff });
  const g = bd.categories.find(c => c.id === 'groceries');
  const retained = g.datedItems.find(i => i.label === 'Invented market restock');
  assert.ok(retained, 'the linked ranged row keeps its identity in the category items');
  assert.equal(retained.amount, null, 'its amount is unknown — not zero, not dropped');
  assert.equal(g.dated, null, 'the category dated aggregate is withheld');
  assert.equal(bd.datedMonthly, null, 'the dated publication is withheld, not a partial total');
  assert.equal(g.planned, null, 'the planned figure withholds with the dated amount it nets off');
  assert.equal(typeof g.historical, 'number', 'the independent historical basis stays known');
  assert.equal(Math.round(bd.sinkingMonthly * 100), Math.round(230 / months * 100),
    'the independent sinking aggregate stays published in full');
  // Preservation: with NO evidence the incumbent range exclusion is
  // exact — no dated item, and the category figures stay numeric.
  const plain = budgetOf(rangedDated(), {});
  const gp = plain.categories.find(c => c.id === 'groceries');
  assert.ok(!gp.datedItems.some(i => i.label === 'Invented market restock'),
    'no evidence: the ranged row stays excluded');
  assert.equal(gp.dated, 0, 'no evidence: the category dated total is its known zero');
  assert.equal(plain.datedMonthly, 0, 'no evidence: the dated publication stays numeric');
  assert.equal(typeof gp.planned, 'number', 'no evidence: the planned figure stays numeric');
  // And a link not yet effective at the breakdown's asOf changes nothing.
  const futureEff = buildEvidence([linkCmd({ goalId: 'commitment:market', evidenceDate: '2026-10-06', asOf: '2026-10-06' })]);
  const future = budgetOf(rangedDated(), { settlementEvidence: futureEff });
  const gf = future.categories.find(c => c.id === 'groceries');
  assert.ok(!gf.datedItems.some(i => i.label === 'Invented market restock'),
    'not yet effective: the ranged row stays excluded');
  assert.equal(gf.dated, 0, 'not yet effective: the category dated total is unchanged');
  assert.equal(future.datedMonthly, 0, 'not yet effective: the dated publication stays numeric');
});
