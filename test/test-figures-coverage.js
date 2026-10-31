'use strict';
/* G1 — the public "Which published figures moved" check observes what
 * figures-moved PRs move, and says INCOMPLETE instead of "unchanged" when a
 * declared field class is observed by no input. `node test/test-figures-coverage.js`
 *
 * Demonstrated failure: the pre-G1 snapshot compared a stale slice of the
 * household figures, so a Budget period losing its Balance After Deductions
 * trust tag, Budget dropping card-paid bills, or every Bills row turning
 * "confirmed" all moved 0 compared keys and read "unchanged". Each defect is
 * expressed here at the publication boundary, by wrapping Forecast's exported
 * functions in-process (no textual mutation), and the same wrappers are run
 * against the pinned pre-G1 script to show it stays blind to them.
 *
 * Every input in this file is invented or is the committed household dated
 * opening, which never leaves this process except as counts. No git writes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const F = require('../public/forecast.js');
const Snapshot = require('../scripts/figures-snapshot.js');
const Comment = require('../scripts/figures-comment.js');
const { CONTENT_PATTERNS } = require('../scripts/privacy-guard.js');

const ROOT = path.join(__dirname, '..');
const PRE_G1 = '007a127bd2051487571f1a6c97bcd8bbb57514b2';
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/figures-review.yml'), 'utf8');
const canonical = Snapshot.loadCanonicalInputs();
const inputs = Snapshot.loadInventedInputs();
const json = map => JSON.parse(JSON.stringify(map));
const check = (over = {}) => json(Snapshot.buildCheckSnapshot(over.canonical || canonical, over.inputs || inputs));
const BASE = check();

// A Forecast export wrapped for the duration of fn: the defect at the
// publication boundary the snapshot reads, never a source edit.
function perturb(name, transform, fn) {
  const original = F[name];
  F[name] = function wrapped(...args) { return transform(original.apply(this, args), ...args); };
  try { return fn(); } finally { F[name] = original; }
}
const DEFECTS = {
  // E19: pay periods stop publishing the Balance After Deductions trust tag.
  E19: fn => perturb('recommend', advice => {
    for (const view of advice.payPeriodViews || []) view.balanceAfterDeductionsTrust = null;
    return advice;
  }, fn),
  // E27: the Budget pay-period bill lists drop card-paid bills.
  E27: fn => perturb('recommend', advice => {
    for (const view of advice.payPeriodViews || []) view.bills = (view.bills || []).filter(bill => bill.cardPaid !== true);
    return advice;
  }, fn),
  // E28: every Bills row is published "confirmed".
  E28: fn => perturb('householdBills', view => ({ ...view,
    bills: (view.bills || []).map(row => ({ ...row, confidence: 'confirmed' })) }), fn),
  // A declared class going dark: projected Savings closes stop publishing stock.
  DARK: fn => perturb('savingsFundingPublication', packet => (packet && packet.forecastClosing
    ? { ...packet, forecastClosing: { ...packet.forecastClosing, stock: null } } : packet), fn),
};
const PERTURBED = Object.fromEntries(Object.entries(DEFECTS).map(([name, apply]) => [name, apply(() => check())]));

// The workflow's privileged posting step, extracted exactly as CI runs it, with
// only fs available. Returns what it posted and the failure annotations.
async function posting(body, base, head) {
  const script = WORKFLOW.slice(WORKFLOW.indexOf('          script: |') + '          script: |'.length)
    .trimStart().split(/\r?\n/).map(line => line.replace(/^ {12}/, '')).join('\n');
  const posted = [], annotations = [];
  const files = { readFileSync: file => (file.endsWith('/base.json') ? JSON.stringify(base)
    : file.endsWith('/head.json') ? JSON.stringify(head) : body), writeFileSync: () => {} };
  const sha = c => c.repeat(40);
  const github = { paginate: async () => [], rest: {
    pulls: { get: async () => ({ data: { head: { sha: sha('b') }, base: { sha: sha('a') } } }) },
    issues: { listComments() {}, updateComment: async a => posted.push(a.body), createComment: async a => posted.push(a.body) } } };
  await vm.runInNewContext('(async () => {' + script + '\n})()', {
    require: name => { assert.equal(name, 'fs', 'the posting step loads no module but fs'); return files; },
    process: { env: { RUNNER_TEMP: '/runner-temp' } }, github, core: { setFailed: text => annotations.push(text) },
    context: { repo: { owner: 'synthetic', repo: 'fixture' },
      payload: { pull_request: { number: 7, head: { sha: sha('b') }, base: { sha: sha('a') } } } } });
  return { posted, annotations };
}
const summary = (base, head) => Comment.formatPublicFiguresComment(base, head);
const line = (body, prefix) => body.split('\n').find(row => row.startsWith(prefix));
const familyRow = (body, name) => line(body, '| ' + name + ' |').split('|').slice(2, 6).map(s => Number(s.trim()));
const coverageOf = (map, id) => [map['coverage.' + id + '.household'], map['coverage.' + id + '.invented']];

test('the fixed vocabulary is mirrored exactly by the privileged posting step', () => {
  const start = WORKFLOW.indexOf('const CLASSES = [');
  const literal = WORKFLOW.slice(start + 'const CLASSES = '.length, WORKFLOW.indexOf('].map(', start) + 1);
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(vm.runInNewContext(literal)), Comment.FIELD_CLASSES.map(c => [c.id, c.pattern, c.kind]));
  const families = plain(vm.runInNewContext(/const FAMILIES = (\[[^\]]*\]);/.exec(WORKFLOW)[1]));
  assert.deepEqual(families, [...Comment.PUBLIC_FAMILIES]);
  assert.equal(new Set(Comment.FIELD_CLASSES.map(c => c.id)).size, Comment.FIELD_CLASSES.length, 'class ids are unique');
  for (const cls of Comment.FIELD_CLASSES) {
    assert.match(cls.id, /^[a-z][a-z0-9-]{0,63}$/);
    assert.ok(['money', 'tag', 'flag', 'true'].includes(cls.kind), cls.id);
    // The class's public family is the family its keys are counted under.
    assert.equal(Comment.figureFamily(cls.pattern.replace(/\*/g, 'x')), cls.family, cls.id);
  }
});

test('invented inputs: closed schema, invented origin, own periods declaration, parity subset, no identifiers', () => {
  const dir = Snapshot.INPUT_DIR;
  const files = fs.readdirSync(dir).sort();
  assert.ok(files.length >= 8, 'a matrix of invented inputs exists');
  const re = new RegExp(CONTENT_PATTERNS, 'i');
  // Every household id, account reference, label and payee string anywhere in
  // data.json, except the engine's own conventions (account ids hard-coded in
  // public/forecast.js, the payroll stream id, generic facility ids and the
  // groceries category) that invented ledgers across the suite share.
  const CONVENTIONS = new Set(['chequing-a', 'chequing-b', 'savings', 'savings-dont-touch', 'payroll', 'heloc',
    'overdraft', 'groceries', 'Groceries']);
  const householdStrings = new Set();
  const collect = value => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /(^id$|Id$|^payingAccount$|^label$|Label$|^displayedPayee$|^originalMerchant$|^payee$)/.test(key)
        && !CONVENTIONS.has(item)) householdStrings.add(item);
      collect(item);
    }
  };
  collect(canonical.data);
  assert.ok(householdStrings.size > 100, 'the household identifier list is real');
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!re.test(text), file + ': the privacy guard patterns find nothing');
    const doc = JSON.parse(text);
    assert.equal(doc.invented, true, file);
    assert.equal(doc.id + '.json', file);
    assert.ok(doc.description.startsWith('Invented'), file + ' describes itself as invented');
    assert.ok(['test-builder', 'invented-ledger'].includes(doc.origin.kind), file);
    assert.match(doc.origin.source, /^test\/[a-z0-9/.-]+\.js /, file + ' names a repository builder or ledger');
    assert.ok(doc.periods === null && doc.limitations.includes('absent-periods'), file + ' declares its periods limitation');
    assert.deepEqual(Snapshot.parityExclusions(doc.data), [], file);
    for (const value of householdStrings) assert.ok(!text.includes(JSON.stringify(value)), file + ' carries no household id or label');
  }
  // The loader refuses rather than skips: unknown keys, a wrong id, a missing
  // invented flag, an overlay that was not applied, a settlement outcome, or a
  // periods payload declared absent but present.
  const good = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  const bad = [
    doc => { doc.extra = 1; }, doc => { doc.id = 'other'; }, doc => { doc.invented = 'yes'; },
    doc => { doc.description = ' '; }, doc => { delete doc.origin.transform; }, doc => { doc.limitations = []; },
    doc => { doc.periods = { asOf: doc.data.meta.asOf }; }, doc => { doc.limitations = ['absent-periods', 'unknown'];},
    doc => { doc.data.liveOverlay = { applied: false, operatingPlan: 'dated-opening', reason: 'refresh-failed' }; },
    doc => { doc.data.settlementEvidenceStatus = { status: 'unconfigured' }; },
    doc => { doc.schema = 'atlas-figures-input/v0'; },
  ];
  for (const mutate of bad) {
    const doc = JSON.parse(JSON.stringify(good));
    mutate(doc);
    assert.throws(() => Snapshot.validateInventedInput(doc, files[0]), /invalid figures input/);
  }
});

test('page options mirror the Budget page call as an engine-input parity subset', () => {
  const data = JSON.parse(JSON.stringify(inputs.find(i => i.doc.data.liveOverlay).doc.data));
  const applied = Snapshot.pageOptions(data, null);
  assert.equal(applied.currentPeriodActuals, data.liveOverlay.currentPeriodActuals);
  assert.equal(applied.operatingPlan, data.liveOverlay.operatingPlan);
  assert.equal(applied.observedCash, data.liveOverlay.observedCash);
  assert.equal(applied.debts, data.debts);
  assert.equal(applied.extraFacilities, data.revolvingExtra);
  // Only currentPeriodActuals is gated on applied === true (plan.js:8144-8157).
  data.liveOverlay.applied = false;
  data.liveOverlay.operatingPlanNote = 'Invented note';
  const unapplied = Snapshot.pageOptions(data, null);
  assert.equal(unapplied.currentPeriodActuals, null);
  assert.equal(unapplied.operatingPlan, data.liveOverlay.operatingPlan);
  assert.equal(unapplied.observedCash, data.liveOverlay.observedCash);
  assert.equal(unapplied.operatingPlanNote, 'Invented note');
  assert.deepEqual(Snapshot.parityExclusions(data), ['overlay-not-applied'], 'such an input is refused, never page-observed');
  // The plan.js source the mirror follows still reads the overlay this way.
  const planSrc = fs.readFileSync(path.join(ROOT, 'public/plan.js'), 'utf8');
  assert.match(planSrc, /const actuals = d\.liveOverlay && d\.liveOverlay\.applied === true\s*\? d\.liveOverlay\.currentPeriodActuals\s*: null;/);
  assert.match(planSrc, /observedCash: d\.liveOverlay && d\.liveOverlay\.observedCash,/);
  assert.match(planSrc, /operatingPlanNote: d\.liveOverlay && d\.liveOverlay\.operatingPlanNote,/);
});

test('collector-to-publication mapping: every input copies the page-equivalent recommend() publication', () => {
  // Options written here from public/plan.js, independently of pageOptions.
  const pageCall = (data, periods) => {
    const plan = data.plan, overlay = data.liveOverlay, priority = F.debtPriority(plan, data.debts);
    return F.recommend(plan, data.meta.asOf, { scenario: plan.defaults.scenario, targetBuffer: plan.defaults.targetBuffer,
      extraDebtMonthly: plan.defaults.extraDebtMonthly, incomeOverrides: {}, disabled: [], debts: data.debts,
      extraDebtTarget: priority.target && priority.target.id, extraFacilities: data.revolvingExtra,
      fundingSources: plan.funding && plan.funding.options, periods,
      currentPeriodActuals: overlay && overlay.applied === true ? overlay.currentPeriodActuals : null,
      operatingPlan: overlay && overlay.operatingPlan, observedCash: overlay && overlay.observedCash,
      operatingPlanNote: overlay && overlay.operatingPlanNote });
  };
  const cents = v => (typeof v === 'number' ? Math.round(v * 100) : v);
  for (const [prefix, data, periods] of [['', canonical.data, canonical.periods],
    ...inputs.map(i => ['fixture.' + i.id + '.', i.doc.data, i.doc.periods])]) {
    const advice = pageCall(data, periods);
    const views = advice.payPeriodViews || [];
    for (const view of views) {
      const p = prefix + 'period.' + view.start + '.';
      for (const field of ['opening', 'openingTrust', 'periodBillLoad', 'balanceAfterDeductions',
        'balanceAfterDeductionsTrust', 'paydaySweep', 'paydaySweepTrust', 'plannedPeriodClose', 'plannedPeriodCloseTrust']) {
        if (view[field] === undefined) assert.ok(!(p + field in BASE), p + field + ' stays absent');
        else assert.equal(cents(BASE[p + field]), cents(view[field]), p + field);
      }
      const billKeys = Object.keys(BASE).filter(k => k.startsWith(p + 'bill.') && k.endsWith('.amount'));
      assert.equal(billKeys.length, (view.bills || []).length, p + 'bill rows');
      if (advice.savingsFunding && view.timelineRole !== 'current') {
        const packet = F.savingsFundingPublication(advice.savingsFunding, { asOf: data.meta.asOf, advice, periodId: view.id });
        const s = prefix + 'savings.period.' + view.start + '.';
        assert.equal(BASE[s + 'publication'], packet ? 'published' : 'withheld', s);
        if (packet && packet.forecastClosing) assert.equal(cents(BASE[s + 'close.stock']), cents(packet.forecastClosing.stock), s);
      }
    }
    assert.equal(Object.keys(BASE).filter(k => k.startsWith(prefix + 'period.') && k.endsWith('.timelineRole')).length,
      views.length, prefix + ' every published pay period is captured');
  }
});

// Atlas 6547632560 finding 1: the Savings figures the Budget card renders
// beyond the group totals. Each edit is applied to the published packet, at
// the selector boundary, and must move exactly the keys that carry it.
const inputById = id => inputs.find(i => i.id === id);
// The edit applies to the per-period invocations (the p<i> roster the itemized
// map reads); the default and re-selection invocations see their own inputs.
const figuresOf = (input, edit) => json(perturb('savingsFundingPublication', (packet, funding, context) => {
  if (!packet || !edit || !context || context.periodId == null) return packet;
  const copy = structuredClone(packet);
  edit(copy, context);
  return copy;
}, () => Snapshot.buildFiguresSnapshot(input.doc.data, input.doc.periods)));
// Itemized keys only; the publication evidence (savings.publication.*) is the
// safety net and is asserted separately.
const isEvidence = k => /^savings\.publication\./.test(k);
const allMovedKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
  .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
const movedKeys = (a, b) => allMovedKeys(a, b).filter(k => !isEvidence(k));
const evidenceMoved = (a, b) => allMovedKeys(a, b).filter(isEvidence);
// Apply an edit to the first packet that satisfies `when`, once per snapshot.
const once = (when, edit) => {
  let done = false;
  return (packet, context) => { if (!done && when(packet)) { done = true; edit(packet, context); } };
};
const readyClose = p => p.period && p.period.kind === 'projected' && p.forecastClosing
  && p.forecastClosing.status === 'ready';

test('Savings member distribution, Needed ranges and trust-only changes move captured keys', () => {
  const input = inputById('savings-estimated-close');
  const before = figuresOf(input);
  // Member distribution: two published allocations trade 10 cents. Every row,
  // item and group total is untouched, so only the distribution moves.
  const shifted = figuresOf(input, once(p => readyClose(p) && p.forecastClosing.allocations.length >= 2, p => {
    const [a, b] = p.forecastClosing.allocations;
    if (b.amount >= 0.1) { a.amount += 0.1; b.amount -= 0.1; } else { a.amount -= 0.1; b.amount += 0.1; }
  }));
  const distribution = movedKeys(before, shifted);
  assert.equal(distribution.length, 2, 'two member allocations move: ' + distribution.length);
  for (const key of distribution) assert.match(key, /^savings\.period\.[^.]+\.close\.allocation\.[^.]+\.amount$/);

  // Trust only: a projected row's Needed trust goes estimated -> unknown with
  // Needed unchanged; the page prints Unavailable instead of an amount.
  const trustOnly = figuresOf(input, once(p => readyClose(p) && p.forecastClosing.rows.length > 0, p => {
    const row = p.forecastClosing.rows[0];
    assert.notEqual(row.needed, null);
    row.neededTrust = row.neededTrust === 'unknown' ? 'estimated' : 'unknown';
  }));
  const trustMoved = movedKeys(before, trustOnly);
  assert.equal(trustMoved.length, 1);
  assert.match(trustMoved[0], /^savings\.period\.[^.]+\.close\.row\.[^.]+\.neededTrust$/);
  // The trust the page falls back to (row.trust) is captured too.
  const fallback = figuresOf(input, once(p => readyClose(p) && p.forecastClosing.rows.length > 0, p => {
    const row = p.forecastClosing.rows[0];
    delete row.neededTrust;
    row.trust = 'unknown';
  }));
  assert.ok(movedKeys(before, fallback).some(k => /\.close\.row\.[^.]+\.trust$/.test(k)), 'trust fallback captured');

  // Needed range endpoints, on a row and on a member item: only the max moves.
  const ranged = max => figuresOf(input, once(readyClose, p => {
    const row = p.forecastClosing.rows[0], item = p.forecastClosing.items[0];
    for (const target of [row, item]) { target.needed = null; target.neededRange = { min: 100, max }; }
  }));
  const rangeMoved = movedKeys(ranged(250), ranged(300));
  assert.equal(rangeMoved.length, 2, 'row and member range max');
  for (const key of rangeMoved) assert.match(key, /^savings\.period\.[^.]+\.close\.(row|item)\.[^.]+\.neededRange\.max$/);
  assert.throws(() => figuresOf(input, once(readyClose, p => { p.forecastClosing.rows[0].neededRange = 5; })),
    /malformed snapshot value/);

  // A member item's own trust (the page's Saved mark) is captured.
  const memberTrust = figuresOf(input, once(p => readyClose(p) && p.forecastClosing.items.length > 0, p => {
    p.forecastClosing.items[0].forecastTrust = 'unknown';
  }));
  assert.ok(movedKeys(before, memberTrust).every(k => /\.close\.item\.[^.]+\.forecastTrust$/.test(k)));
  assert.equal(movedKeys(before, memberTrust).length, 1);
});

test('current, historical, planned and close-less packets capture the rows and members the page renders', () => {
  for (const id of ['savings-chained-closes', 'savings-live-partial']) {
    const input = inputById(id);
    const before = figuresOf(input);
    // Current period: the cycle allocations the members print as This period.
    const current = figuresOf(input, once(p => p.period && p.period.kind === undefined
      && (p.period.cycleAllocations || []).length > 0, p => { p.period.cycleAllocations[0].amount += 1; }));
    const moved = movedKeys(before, current);
    assert.equal(moved.length, 1, id);
    assert.match(moved[0], /^savings\.current\.allocation\.[^.]+\.amount$/);
    // Current member Saved and Paid facts.
    const member = figuresOf(input, once(p => p.period && p.period.kind === undefined
      && (p.backing.items || []).length > 0, p => { p.backing.items[0].saved = (p.backing.items[0].saved || 0) + 1; }));
    assert.deepEqual(movedKeys(before, member).map(k => k.replace(/item\.[^.]+/, 'item.*')), ['savings.current.item.*.saved']);
  }
  // A historical packet renders its own rows; their figures are captured, its
  // members are withheld on the page and are not.
  const chained = inputById('savings-chained-closes');
  const base = figuresOf(chained);
  const historical = figuresOf(chained, once(p => p.period && p.period.kind === 'historical' && p.rows.length > 0,
    p => { p.rows[0].thisPeriodTrust = p.rows[0].thisPeriodTrust === 'unknown' ? 'estimated' : 'unknown'; }));
  assert.deepEqual(movedKeys(base, historical).map(k => k.replace(/^savings\.period\.[^.]+\.row\.[^.]+/, 'H')),
    ['H.thisPeriodTrust']);
  assert.ok(!Object.keys(base).some(k => /^savings\.period\.[^.]+\.(item|allocation)\./.test(k)
    && !/\.(close|planned)\./.test(k)), 'no historical member figures');
  // Paid facts on a row the page renders.
  const paid = amount => figuresOf(chained, once(p => p.period && p.period.kind === undefined
    && p.rows.some(r => r.commitmentCost), p => {
    const row = p.rows.find(r => r.commitmentCost);
    row.commitmentCost.confirmedLinkedPaid = { status: 'known', amount, range: null };
  }));
  const paidMoved = movedKeys(paid(7), paid(8));
  assert.equal(paidMoved.length, 1, 'only the Paid amount moves');
  assert.match(paidMoved[0], /^savings\.current\.row\.[^.]+\.cost\.confirmedLinkedPaid\.amount$/);
  // Planned requirements: member items and a row's Needed trust.
  const plannedInput = inputs.find(i => Object.keys(figuresOf(i)).some(k => /\.planned\.item\./.test(k)));
  assert.ok(plannedInput, 'an invented input publishes planned member items');
  const plannedBase = figuresOf(plannedInput);
  const planned = figuresOf(plannedInput, once(p => p.plannedRequirements && p.plannedRequirements.items.length > 0,
    p => { p.plannedRequirements.items[0].neededTrust = 'unknown'; p.plannedRequirements.rows.forEach(r => { r.neededTrust = 'unknown'; }); }));
  const plannedMoved = movedKeys(plannedBase, planned);
  assert.ok(plannedMoved.some(k => /\.planned\.item\.[^.]+\.neededTrust$/.test(k)), 'planned member trust');
  assert.ok(plannedMoved.every(k => /\.planned\.(item|row)\.[^.]+\.neededTrust$/.test(k)));
});

test('the evidence sheet funding lines and the remaining row and member trust captures move their own keys', () => {
  // Pre-review 1a85f5e6 finding 1: the current packet's sheet prints Unsent
  // top-up today, entitlement, proved transfers, remaining entitlement and
  // unassigned capacity. Each edit at the selector boundary moves its key.
  const currentPacket = p => p.period && p.period.kind === undefined && p.period.status === 'ready';
  for (const id of ['savings-fully-backed', 'savings-live-partial', 'savings-live-ready']) {
    const input = inputById(id);
    const before = figuresOf(input);
    for (const field of ['proposal', 'entitlement', 'transferred', 'remainingEntitlement', 'unassigned']) {
      const moved = movedKeys(before, figuresOf(input, once(currentPacket, p => { p.period[field] += 80; })));
      assert.deepEqual(moved, ['savings.current.' + field], id + ' ' + field);
    }
  }
  const pick = (input, pattern) => Object.keys(figuresOf(input)).find(k => pattern.test(k));
  const shapeOf = key => key.replace(/\.(row|item)\.[^.]+/, '.$1.*').replace(/^savings\.period\.[^.]+/, 'savings.period.*');
  // Trust captures the page falls back to or marks members with, and the
  // current member's Needed: one edit, one key.
  const cases = [
    ['savings-live-partial', currentPacket, p => { p.rows[0].trust = 'unknown'; }, 'savings.current.row.*.trust'],
    ['savings-live-partial', currentPacket, p => { p.backing.items[0].trust = 'unknown'; }, 'savings.current.item.*.trust'],
    ['savings-live-partial', currentPacket, p => { p.backing.items[0].needed += 1; }, 'savings.current.item.*.needed'],
    ['savings-estimated-close', p => readyClose(p) && p.forecastClosing.items.length > 0,
      p => { p.forecastClosing.items[0].trust = 'unknown'; }, 'savings.period.*.close.item.*.trust'],
  ];
  for (const [id, when, edit, shape] of cases) {
    const input = inputById(id);
    const moved = movedKeys(figuresOf(input), figuresOf(input, once(when, edit)));
    assert.deepEqual(moved.map(shapeOf), [shape], shape);
  }
  const plannedInput = inputs.find(i => pick(i, /\.planned\.row\.[^.]+\.trust$/));
  assert.ok(plannedInput, 'an invented input publishes a planned row trust');
  const plannedTrust = figuresOf(plannedInput, once(p => p.plannedRequirements && p.plannedRequirements.rows.length > 0,
    p => { p.plannedRequirements.rows[0].trust = p.plannedRequirements.rows[0].trust === 'unknown' ? 'estimated' : 'unknown'; }));
  assert.deepEqual(movedKeys(figuresOf(plannedInput), plannedTrust).map(shapeOf), ['savings.period.*.planned.row.*.trust']);
  // Cost facts: range endpoints and the as-of gate that decides whether they print.
  const chained = inputById('savings-chained-closes');
  const costed = p => p.period && p.period.kind === undefined && p.rows.some(r => r.commitmentCost);
  const ranged = max => figuresOf(chained, once(costed, p => {
    p.rows.find(r => r.commitmentCost).commitmentCost.originalCost = { status: 'known', amount: null, range: { min: 10, max } };
  }));
  assert.deepEqual(movedKeys(ranged(20), ranged(30)).map(shapeOf), ['savings.current.row.*.cost.originalCost.range.max']);
  const dated = asOf => figuresOf(chained, once(costed, p => { p.rows.find(r => r.commitmentCost).commitmentCost.asOf = asOf; }));
  assert.deepEqual(movedKeys(dated('2026-01-01'), dated('2026-01-02')).map(shapeOf), ['savings.current.row.*.cost.asOf']);
});

test('a cost fact whose range turns from explicit null to absent cannot read unchanged', () => {
  // Atlas 6548797610: SavingsInventory.commitmentCostHtml prints a point cost
  // only when `range === null`, so { amount: 80, range: null } prints $80.00
  // and the same fact without `range` prints Unknown.
  const chained = inputById('savings-chained-closes');
  const costed = p => p.period && p.period.kind === undefined && p.rows.some(r => r.commitmentCost);
  const withFact = fact => figuresOf(chained, once(costed, p => {
    p.rows.find(r => r.commitmentCost).commitmentCost.originalCost = fact;
  }));
  const point = withFact({ status: 'known', amount: 80, range: null });
  const noRange = withFact({ status: 'known', amount: 80 });
  const moved = movedKeys(point, noRange);
  assert.equal(moved.length, 1, 'exactly the range shape moves');
  assert.match(moved[0], /^savings\.current\.row\.[^.]+\.cost\.originalCost\.range$/);
  const key = moved[0];
  assert.equal(point[key], null, 'an explicit null range is captured as null');
  assert.ok(!(key in noRange), 'an absent range stays absent');
  // The comparison reads it as a change, so the public check cannot say unchanged.
  const compared = Comment.compareFigures(point, noRange).moved;
  assert.deepEqual(compared.filter(k => !isEvidence(k)), [key]);
  assert.ok(compared.some(k => /^savings\.publication\.p\d+\.digest$/.test(k)), 'the safety net moves too');
  // A null fact and a null cost are captured as null too; absent stays absent.
  const nullFact = withFact(null);
  assert.ok(Object.keys(nullFact).some(k => /\.cost\.originalCost$/.test(k) && nullFact[k] === null));
  // Range endpoints still copy when the range is an object.
  const ranged = withFact({ status: 'known', amount: null, range: { min: 10, max: 20 } });
  assert.equal(ranged[key + '.min'], 10);
  assert.ok(!(key in ranged), 'an object range has no null shape key');
});

// Atlas 6549108431 closure evidence 2: encoder vectors written here from the
// encoding contract, independently of the implementation's own walk.
test('the publication encoding keeps every distinction the contract names and rejects what it cannot represent', () => {
  const E = v => Snapshot.encodePublication(v, 'vector');
  const distinct = (a, b, why) => assert.notEqual(E(a), E(b), why);
  // absent / own undefined / null / empty / populated
  distinct({}, { a: undefined }, 'absent vs own undefined');
  distinct({ a: undefined }, { a: null }, 'own undefined vs null');
  distinct({ a: null }, { a: {} }, 'null vs empty object');
  distinct({ a: {} }, { a: [] }, 'empty object vs empty array');
  distinct({ a: [] }, { a: [null] }, 'empty vs populated array');
  distinct({ a: {} }, { a: { min: 1 } }, 'member-less vs populated object');
  // scalar values and types
  distinct({ a: 80 }, { a: 90 }, 'same-shape scalar value');
  distinct({ a: 1 }, { a: '1' }, 'number vs string');
  distinct({ a: 0 }, { a: false }, 'zero vs false');
  distinct({ a: 0 }, { a: -0 }, 'zero vs negative zero');
  distinct({ t: 'estimated' }, { t: 'unknown' }, 'trust tag');
  distinct({ a: 0.1 + 0.2 }, { a: 0.3 }, 'exact number, no rounding');
  // array membership and order, object key presence and order
  distinct({ a: [1, 2] }, { a: [2, 1] }, 'array order');
  distinct({ a: [1] }, { a: [1, 1] }, 'array length');
  distinct({ a: 1, b: 2 }, { b: 2, a: 1 }, 'key order is kept (consumers may enumerate)');
  // escaping: a crafted string cannot impersonate structure
  distinct({ a: 's"x":1' }, { a: 's', x: 1 }, 'escaping');
  distinct({ 'a,b': 1 }, { a: 1, b: 1 }, 'key escaping');
  // deterministic
  assert.equal(E({ a: [1, { b: null }] }), E({ a: [1, { b: null }] }));
  // symbol-keyed private data is kept by description, not dropped
  const sym = o => { Object.defineProperty(o, Symbol('private-cents'), { value: 5 }); return o; };
  distinct({ a: 1 }, sym({ a: 1 }), 'symbol data kept');
  distinct(sym({ a: 1 }), (() => { const o = { a: 1 }; Object.defineProperty(o, Symbol('private-cents'), { value: 6 }); return o; })(), 'symbol value');
  // rejected, never normalized
  const rejects = (v, why) => assert.throws(() => E(v), /unencodable savings publication/, why);
  rejects({ a: NaN }, 'NaN'); rejects({ a: Infinity }, 'Infinity');
  rejects({ a: () => 1 }, 'function'); rejects({ a: 1n }, 'bigint'); rejects({ a: Symbol('x') }, 'symbol value');
  const cyc = {}; cyc.self = cyc; rejects(cyc, 'cycle');
  rejects(Object.defineProperty({}, 'a', { get: () => 1, enumerable: true }), 'accessor');
  rejects(Object.defineProperty({}, 'a', { value: 1, enumerable: false }), 'non-enumerable string key');
  rejects([1, , 3], 'sparse array'); // eslint-disable-line no-sparse-arrays
  rejects(Object.assign([1], { extra: 2 }), 'extra-property array');
  rejects(new Date(0), 'prototype'); rejects(new Map(), 'prototype');
  const twoSyms = { a: 1 };
  Object.defineProperty(twoSyms, Symbol('x'), { value: 1 }); Object.defineProperty(twoSyms, Symbol('x'), { value: 2 });
  rejects(twoSyms, 'ambiguous symbol descriptions');
  // a shared (non-cyclic) reference is fine
  const shared = { v: 1 }; assert.doesNotThrow(() => E({ a: shared, b: shared }));
  // resource limits fail closed, no truncation
  let deep = {}; for (let i = 0; i < 60; i++) deep = { d: deep };
  rejects(deep, 'depth limit');
  rejects({ a: 'x'.repeat(70000) }, 'string limit');
});

// Atlas 6549108431 closure evidence 4: a same-shape scalar the itemized map
// deliberately omits is still detected; deleting, misclassifying or
// corrupting the evidence cannot read unchanged.
test('the publication evidence detects an omitted same-shape scalar and cannot be deleted, misfiled or corrupted silently', async () => {
  const input = inputById('savings-live-partial');
  const before = figuresOf(input);
  // A field no itemized capture reads, changed with its shape kept.
  const omitted = figuresOf(input, once(p => p.period && p.period.kind === undefined, p => {
    p.period.projectedRemainingCapacity = (p.period.projectedRemainingCapacity || 0) + 1;
  }));
  assert.deepEqual(movedKeys(before, omitted), [], 'the itemized map does not carry this field');
  const ev = evidenceMoved(before, omitted);
  assert.ok(ev.some(k => /^savings\.publication\.p\d+\.digest$/.test(k)), 'the packet digest moves');
  assert.ok(ev.some(k => /^savings\.publication\.p\d+\.part\.period$/.test(k)), 'the period part digest locates it');
  // Through the public check: changed and WITHHELD, never unchanged.
  const head = json(BASE);
  for (const k of ev) head['fixture.' + input.id + '.' + k] = omitted[k];
  assert.equal(line(summary(BASE, head), 'Comparison:'), 'Comparison: changed.');
  // Deleting the evidence from both revisions.
  const strip = map => Object.fromEntries(Object.entries(map).filter(([k]) => !/(^|\.)savings\.publication\./.test(k)));
  const bothGone = summary(strip(BASE), strip(BASE));
  assert.equal(line(bothGone, 'Coverage:'), 'Coverage: INCOMPLETE.');
  assert.match(line(bothGone, 'Figures acceptance:'), /INCOMPLETE/);
  // Deleting one input's roster entry, misfiling the evidence as metadata,
  // corrupting the version, or a malformed digest.
  const variants = {
    'one invocation removed': m => { for (const k of Object.keys(m)) if (k.startsWith('fixture.' + input.id + '.savings.publication.p2.')) delete m[k]; },
    'misfiled under check.': m => { m['check.savings.publication.version'] = m['savings.publication.version']; delete m['savings.publication.version']; },
    'version corrupted': m => { m['savings.publication.version'] = 'atlas-savings-publication/v0'; },
    'version retyped': m => { m['savings.publication.version'] = 1; },
    'digest malformed': m => { m['savings.publication.p0.digest'] = 'zz'; },
    'out-of-roster entry': m => { m['savings.publication.p999.digest'] = 'a'.repeat(64); },
    'count shrunk': m => { m['savings.publication.count'] = 0; },
  };
  for (const [name, edit] of Object.entries(variants)) {
    const forged = json(BASE); edit(forged);
    const body = summary(BASE, forged);
    assert.equal(line(body, 'Coverage:'), 'Coverage: INCOMPLETE.', name);
    const result = await posting(body, BASE, forged);
    assert.equal(result.posted.length, 1, name + ' posts');
    assert.ok(result.annotations.length >= 1 && /incomplete/i.test(result.annotations.join(' ')), name + ' fails as incomplete');
  }
});

test('pristine: head against head reads unchanged with every declared class observed, and posts green', async () => {
  const body = summary(BASE, BASE);
  assert.equal(line(body, 'Comparison:'), 'Comparison: unchanged.');
  assert.equal(line(body, 'Coverage:'), 'Coverage: complete.');
  const declared = Comment.FIELD_CLASSES.length;
  assert.equal(line(body, 'Field classes:'), `Field classes: ${declared} declared; ${declared} observed by at least one `
    + `input; ${Comment.coverageReport(BASE).byHousehold} observed by the household dated opening; `
    + `${Comment.coverageReport(BASE).byInvented} observed by invented inputs; 0 observed by no input.`);
  for (const cls of Comment.FIELD_CLASSES) {
    const [h, i] = coverageOf(BASE, cls.id);
    assert.ok(h + i > 0, cls.id + ' is observed');
  }
  assert.match(line(body, 'Invented inputs:'), new RegExp('^Invented inputs: ' + inputs.length + ' compared like for like; 0 added;'));
  assert.match(body, /^Figures acceptance: no compared field moved on the household dated opening or the invented inputs;/m);
  const result = await posting(body, BASE, BASE);
  assert.equal(result.posted.length, 1);
  assert.ok(result.posted[0].startsWith(body) && result.posted[0].endsWith('head `' + 'b'.repeat(40) + '`.\n'));
  assert.deepEqual(result.annotations, []);
});

test('E19, E27 and E28 read changed on this check and move 0 keys on the pre-G1 snapshot', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'figures-pre-g1-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.writeFileSync(path.join(tmp, 'scripts/figures-snapshot.js'),
      execFileSync('git', ['show', PRE_G1 + ':scripts/figures-snapshot.js'], { cwd: ROOT, encoding: 'utf8' }));
    fs.symlinkSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), process.platform === 'win32' ? 'junction' : 'dir');
    const pre = require(path.join(tmp, 'scripts/figures-snapshot.js'));
    const preBase = json(pre.buildFiguresSnapshot(canonical.data, canonical.periods));
    for (const [name, family] of [['E19', 'Trust'], ['E27', 'Budget'], ['E28', 'Trust']]) {
      const preHead = DEFECTS[name](() => json(pre.buildFiguresSnapshot(canonical.data, canonical.periods)));
      assert.deepEqual(Comment.compareFigures(preBase, preHead).moved, [], name + ': the pre-G1 snapshot is blind to it');
      const body = summary(BASE, PERTURBED[name]);
      assert.equal(line(body, 'Comparison:'), 'Comparison: changed.', name);
      // Invented inputs observe each defect too, so this holds whatever the
      // household's own shape is on a later data.json.
      const row = familyRow(body, family);
      assert.ok(row[1] + row[3] > 0 && row[3] > 0, name + ': the ' + family + ' row moves, on an invented input too');
      const result = await posting(body, BASE, PERTURBED[name]);
      assert.equal(result.posted.length, 1, name + ' posts');
      assert.equal(result.annotations.length, 1, name + ' fails the job');
      assert.match(result.annotations[0], /acceptance withheld/);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // E27 also moves the invented card-paid inputs; E28 keeps every class observed.
  assert.ok(familyRow(summary(BASE, PERTURBED.E27), 'Budget')[3] > 0);
  assert.equal(line(summary(BASE, PERTURBED.E28), 'Coverage:'), 'Coverage: complete.');
});

test('a declared class going dark reads INCOMPLETE, never unchanged, even when values also changed', async () => {
  assert.deepEqual(coverageOf(PERTURBED.DARK, 'savings-close-stock'), [0, 0]);
  const moved = summary(BASE, PERTURBED.DARK);
  assert.equal(line(moved, 'Comparison:'), 'Comparison: changed.');
  assert.equal(line(moved, 'Coverage:'), 'Coverage: INCOMPLETE.');
  assert.match(moved, /^Figures acceptance: WITHHELD and INCOMPLETE until/m);
  // Once dark on both revisions the comparison is unchanged, and still INCOMPLETE.
  const dark = summary(PERTURBED.DARK, PERTURBED.DARK);
  assert.equal(line(dark, 'Comparison:'), 'Comparison: unchanged.');
  assert.equal(line(dark, 'Coverage:'), 'Coverage: INCOMPLETE.');
  assert.match(line(dark, 'Field classes:'), /; 1 observed by no input\.$/);
  assert.match(dark, /^Figures acceptance: INCOMPLETE until every declared field class is observed/m);
  assert.ok(!/no compared field moved/.test(dark));
  const result = await posting(dark, PERTURBED.DARK, PERTURBED.DARK);
  assert.equal(result.posted.length, 1);
  assert.deepEqual(result.annotations.map(a => a.split(':')[0]), ['Figures coverage incomplete']);
  // E19 removes the only Balance After Deductions trust observers too.
  assert.equal(line(summary(BASE, PERTURBED.E19), 'Coverage:'), 'Coverage: INCOMPLETE.');
  assert.deepEqual(coverageOf(PERTURBED.E19, 'budget-period-bad-trust'), [0, 0]);
});

test('the coverage manifest is reconciled: missing, renamed, malformed, forged or orphaned entries cannot turn green', async () => {
  const id = 'savings-close-stock';
  const variants = {
    missing: map => { delete map['coverage.' + id + '.invented']; },
    renamed: map => { map['coverage.savings-close-stocks.invented'] = map['coverage.' + id + '.invented'];
      delete map['coverage.' + id + '.invented']; },
    malformed: map => { map['coverage.' + id + '.household'] = '1'; },
    forged: map => { map['coverage.plan-opening-gap.household'] = 1; },
    beyond: map => { map['coverage.' + id + '.invented'] = inputs.length + 1; },
    orphan: map => { map['fixture.unlisted.plan.weeklyCap'] = 1; },
    extraCheck: map => { map['check.note'] = 'x'; },
    schema: map => { delete map['check.schema']; },
    badDigest: map => { map['fixture.' + inputs[0].id + '.input.sha256'] = 'not-a-digest'; },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const head = json(BASE);
    mutate(head);
    const report = Comment.coverageReport(head);
    assert.ok(report.invalid > 0 && !report.complete, name);
    const body = summary(head, head);
    assert.equal(line(body, 'Coverage:'), 'Coverage: INCOMPLETE.', name);
    assert.match(line(body, 'Coverage manifest:'), /^Coverage manifest: INVALID; [1-9]\d* entries are missing/, name);
    const result = await posting(body, head, head);
    assert.equal(result.posted.length, 1, name + ': the posting step computes the same INCOMPLETE body');
    assert.equal(result.annotations.length, 1, name);
  }
  // A pre-G1 snapshot as the head has no manifest at all.
  const legacy = Object.fromEntries(Object.entries(BASE).filter(([k]) => !/^(check|coverage|fixture)\./.test(k)));
  assert.equal(line(summary(legacy, legacy), 'Coverage:'), 'Coverage: INCOMPLETE.');
});

test('input accounting keeps added, edited and removed inputs apart from like-for-like comparisons', async () => {
  const edited = inputs.map(input => (input.id !== inputs[0].id ? input : (() => {
    const doc = JSON.parse(JSON.stringify(input.doc));
    doc.data.plan.windowDays += 7;
    return { id: input.id, doc, digest: 'f'.repeat(64) };
  })()));
  const head = check({ inputs: edited });
  const body = summary(BASE, head);
  assert.equal(line(body, 'Invented inputs:'), `Invented inputs: ${inputs.length - 1} compared like for like; 0 added; `
    + '1 edited; 0 removed; 0 fields moved on unedited inputs.');
  assert.match(body, /^Figures acceptance: WITHHELD until/m, 'an edited input withholds acceptance');
  const removed = check({ inputs: inputs.slice(1) });
  assert.match(line(summary(BASE, removed), 'Invented inputs:'), /; 0 added; 0 edited; 1 removed;/);
  assert.match(line(summary(removed, BASE), 'Invented inputs:'), /; 1 added; 0 edited; 0 removed;/);
  for (const [a, b] of [[BASE, head], [BASE, removed], [removed, BASE]]) {
    const result = await posting(summary(a, b), a, b);
    assert.equal(result.posted.length, 1);
    assert.match(result.annotations[0], /acceptance withheld/);
  }
});

test('the posting step posts nothing it did not compute: smuggled, forged and stale bodies are refused', async () => {
  const body = summary(BASE, PERTURBED.E28);
  const forged = [body + 'CANARY 947.31 2041-07-09\n', body.replace('Comparison: changed.', 'Comparison: unchanged.'),
    body.replace(/\| Trust \| (\d+) \| (\d+) \|/, (m, a, b) => `| Trust | ${a} | ${Number(b) + 1} |`),
    body.replace(/^Total: (\d+) compared;/m, (m, n) => `Total: ${Number(n) + 947} compared;`),
    summary(BASE, BASE), Comment.formatFiguresComment(BASE, PERTURBED.E28, 'main')];
  for (const candidate of forged) {
    const result = await posting(candidate, BASE, PERTURBED.E28);
    assert.equal(result.posted.length, 0);
    assert.deepEqual(result.annotations, ['Published figures summary failed; raw diagnostics withheld.']);
  }
  const malformed = await posting(body, BASE, { ...PERTURBED.E28, 'plan.weeklyCap': { amount: 1 } });
  assert.equal(malformed.posted.length, 0, 'a structured value is never a figure');
});

test('the public body carries counts and fixed vocabulary only', () => {
  const householdIds = [...canonical.data.plan.bills, ...canonical.data.plan.commitments, ...canonical.data.debts]
    .map(row => row.id).filter(Boolean);
  for (const [base, head] of [[BASE, BASE], [BASE, PERTURBED.E19], [BASE, PERTURBED.E27], [BASE, PERTURBED.DARK],
    [Snapshot.buildFiguresSnapshot(canonical.data, canonical.periods), BASE], [null, BASE]]) {
    const body = summary(json(base), head);
    assert.ok(!/\$/.test(body), 'no dollar sign');
    assert.ok(!/\d\.\d/.test(body), 'no decimal');
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(body), 'no ISO date');
    for (const id of householdIds) assert.ok(!new RegExp('\\b' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(body), 'no household id');
    for (const input of inputs) assert.ok(!body.includes(input.id), 'no input id');
    for (const cls of Comment.FIELD_CLASSES) assert.ok(!body.includes(cls.id), 'no class name');
  }
});

test('independence: a decoy data.json leaves every invented-input key byte-identical', () => {
  const decoy = { data: JSON.parse(JSON.stringify(inputs[0].doc.data)), periods: null };
  const swapped = check({ canonical: decoy });
  const invented = map => Object.fromEntries(Object.entries(map).filter(([k]) => k.startsWith('fixture.')
    || /^coverage\.[^.]+\.invented$/.test(k)));
  assert.equal(JSON.stringify(invented(swapped)), JSON.stringify(invented(BASE)));
  assert.ok(Object.keys(invented(BASE)).length > 3000);
  const householdKeys = Object.keys(BASE).filter(k => !/^(check|coverage|fixture)\./.test(k));
  assert.ok(householdKeys.some(k => JSON.stringify(swapped[k]) !== JSON.stringify(BASE[k])), 'household keys do move');
});

test('legitimate zero is observed money; explicit null and missing are not; transitions read as changes', () => {
  const cls = Comment.FIELD_CLASSES.find(c => c.id === 'plan-opening-gap');
  assert.equal(Comment.snapshotObserves({ 'plan.gapAmount': 0 }, cls), true, 'a legitimate zero is observed');
  assert.equal(Comment.snapshotObserves({ 'plan.gapAmount': null }, cls), false, 'explicit null is withheld, not coverage');
  assert.equal(Comment.snapshotObserves({}, cls), false);
  const tag = Comment.FIELD_CLASSES.find(c => c.id === 'bills-row-confidence');
  assert.equal(Comment.snapshotObserves({ 'bills.x.confidence': '' }, tag), false);
  assert.equal(Comment.snapshotObserves({ 'bills.x.y.confidence': 'estimated' }, tag), false, 'a pattern segment is exactly one key segment');
  const moved = (a, b) => Comment.compareFigures(a, b).moved;
  assert.deepEqual(moved({ k: 0 }, { k: null }), ['k']);
  assert.deepEqual(moved({ k: null }, {}), ['k']);
  assert.deepEqual(moved({}, { k: null }), ['k']);
  assert.deepEqual(moved({ k: 10 }, { k: -10 }), ['k']);
  assert.deepEqual(moved({ k: 10 }, { k: 10.004 }), []);
  assert.deepEqual(moved({ 'period.2026-10-02.opening': 5 }, { 'period.2026-10-16.opening': 5 }).length, 2, 'a period moving is two changes');
  // A trust-only change is counted in the Trust family.
  const head = json(BASE);
  const key = Object.keys(head).find(k => /^period\.[^.]+\.balanceAfterDeductionsTrust$/.test(k) && typeof head[k] === 'string');
  head[key] = head[key] === 'estimated' ? 'calculated' : 'estimated';
  const body = summary(BASE, head);
  assert.deepEqual(familyRow(body, 'Trust').slice(1, 2), [1]);
  assert.match(line(body, 'Total:'), /; 1 changed\.$/);
  // A nonfinite or structured published value is a failure, not a null.
  assert.throws(() => perturb('recommend', advice => { advice.payPeriodViews[0].opening = NaN; return advice; },
    () => Snapshot.buildFiguresSnapshot(inputs[0].doc.data, null)), /nonfinite snapshot value/);
  // A summed term that is nonfinite fails too; it is not coerced to zero.
  assert.throws(() => perturb('recommend', advice => {
    const risks = advice.paydayAllocation && advice.paydayAllocation.risks;
    if (risks && risks.length) risks[0].shortfall = NaN;
    else if (advice.paydayAllocation) advice.paydayAllocation.risks = [{ shortfall: NaN }];
    return advice;
  }, () => Snapshot.buildFiguresSnapshot(inputs[0].doc.data, null)), /nonfinite snapshot value: payday\.riskShortfall/);
  assert.throws(() => perturb('recommend', advice => { advice.payPeriodViews[0].opening = { amount: 1 }; return advice; },
    () => Snapshot.buildFiguresSnapshot(inputs[0].doc.data, null)), /structured snapshot value/);
  // Atlas 6547632560 finding 2: a present encumbered figure must be finite; it
  // is never filtered out. Absent stays absent and is not a failure.
  for (const bad of [NaN, Infinity, 'twelve', '12']) {
    assert.throws(() => perturb('recommend', advice => { advice.knowledge = { ...(advice.knowledge || {}), encumbered: bad }; return advice; },
      () => Snapshot.buildFiguresSnapshot(inputs[0].doc.data, null)), /nonfinite snapshot value: planning\.encumbered/, String(bad));
  }
  const absent = json(perturb('recommend', advice => { if (advice.knowledge) delete advice.knowledge.encumbered; return advice; },
    () => Snapshot.buildFiguresSnapshot(inputs[0].doc.data, null)));
  assert.ok(!('planning.encumbered' in absent), 'absent encumbered stays absent');
  const zero = json(perturb('recommend', advice => { advice.knowledge = { ...(advice.knowledge || {}), encumbered: 0 }; return advice; },
    () => Snapshot.buildFiguresSnapshot(inputs[0].doc.data, null)));
  assert.equal(zero['planning.encumbered'], 0, 'a legitimate zero is kept');
  // A finite value whose cents overflow, or are not a safe integer, is corrupt
  // output: it fails rather than serializing as null.
  for (const huge of [1e308, -1e308, 1e14]) {
    assert.throws(() => perturb('recommend', advice => { advice.payPeriodViews[0].opening = huge; return advice; },
      () => Snapshot.buildFiguresSnapshot(inputs[0].doc.data, null)), /unrepresentable snapshot value/, String(huge));
  }
  // Summed input terms: a non-numeric balance or held-elsewhere value fails
  // instead of concatenating into a string or reading as zero.
  const withData = edit => () => {
    const data = structuredClone(inputs[0].doc.data);
    edit(data);
    return Snapshot.buildFiguresSnapshot(data, inputs[0].doc.periods);
  };
  assert.throws(withData(d => { d.debts.find(x => !x.secured).balance = true; }),
    /nonfinite snapshot value: balance\.debts/);
  assert.throws(withData(d => { d.debts.find(x => !x.secured).pending = NaN; }),
    /nonfinite snapshot value: balance\.consumerDebtPending/);
  // A missing balance is unknown, not zero: the totals it enters read null.
  const missing = json(withData(d => { d.debts.find(x => !x.secured).balance = null; })());
  assert.equal(missing['balance.debts'], null);
  assert.equal(missing['balance.consumerDebtPosted'], null);
  assert.equal(missing['balance.consumerDebtEffective'], null);
  assert.throws(withData(d => { d.plan.startingCash.heldElsewhere = [{ class: 'other', value: '5' }]; }),
    /nonfinite snapshot value: cash\.elsewhere\.other/);
});

test('deterministic across runs and time zones, and the CLI emits exactly the check snapshot', () => {
  assert.equal(JSON.stringify(check()), JSON.stringify(BASE));
  for (const tz of ['UTC', 'Pacific/Kiritimati']) {
    const env = { ...process.env, TZ: tz };
    for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) delete env[key];
    const cli = execFileSync(process.execPath, [path.join(ROOT, 'scripts/figures-snapshot.js')],
      { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(cli, JSON.stringify(BASE, null, 2) + '\n', 'TZ=' + tz);
  }
});

test('the private detail separates household, invented and metadata rows and formats counters as counts', () => {
  const detail = Comment.formatFiguresComment(BASE, PERTURBED.DARK, 'main');
  assert.match(detail, /#### Invented inputs — synthetic fields, not household figures \(\d+ moved\)/);
  assert.match(detail, /#### Coverage manifest and input metadata — counts and digests, not figures \(\d+ moved\)/);
  assert.match(detail, /\| `coverage\.savings-close-stock\.invented` \| \d+ \| \*\*0\*\* \| −\d+ \|/);
  assert.ok(!/coverage\.[^`]*` \| \$/.test(detail), 'coverage counters are never money');
  assert.ok(!/Every one of the \d+ figures the household can read/.test(Comment.formatFiguresComment(BASE, BASE, 'main')));
  assert.match(Comment.formatFiguresComment(BASE, BASE, 'main'), /That covers only the captured fields on those inputs/);
});
