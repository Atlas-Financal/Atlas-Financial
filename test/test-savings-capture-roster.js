'use strict';
/* G1 adopted table r4 + r4.1 (PR #813 comments 6558578436 and 6558666715,
 * adopted by Muse 6558680563, with Atlas's details 6558692784): the per-state
 * Savings call roster (R-seq, R-pass, R-raw, R-unfunded) and the
 * same-execution gate facts (savings.capture.gate.<i>).
 * `node --test test/test-savings-capture-roster.js`
 *
 *  1. The pre-review's regression witnesses (6558436817): consistent edits of
 *     savings-live-ready evidence read INVALID; the legitimate current-view,
 *     null-packet (S3) and withheld (S4) forms read 0.
 *  2. Unfunded drop-all reads INVALID.
 *  3. The invalid-parent witness, on the page's parent-gated path.
 *  4. The S10 and inventory-gate prediction through the real anchors (the
 *     build's first acceptance check), 0 mismatches.
 *  5. Gate binding: neutrality with options.gates === false, omission and
 *     flip witnesses, trajectory participation and monthPayday identity.
 *  6. Gate and itemized bindings (the advisory pass): uniform every-state
 *     gate flips with their governed steps dropped, and one-key itemized
 *     coherence edits, read INVALID.
 *  7. The finite repair (rules 10-14), one test per row of the acceptance
 *     table (#813 6560714968 §6), every witness read by the formatter AND the
 *     posting step's workflow mirror: contradictory or malformed evidence
 *     reads nonzero on both; the repaired legitimate states 0/0; each coherent
 *     named limit its recorded outcome, by name; and the outcomes outside the
 *     adopted classification, recorded and reported. (The loading row, L1-L6,
 *     is test-savings-consumer-contract.js.)
 *
 * Inputs: every committed invented input (test/fixtures/figures-inputs and
 * test/fixtures/savings-capture, including s5, the operating plan withheld,
 * and s6, a funded input with no major plan) and four PERTURBATIONS of
 * savings-live-ready (S3, S4, INVNR, OPU-next), for which no frozen-fixture
 * coverage is claimed. No household input is read; nothing but test names
 * and counts is printed. A page capture takes up to about fifteen seconds:
 * each input's default capture is made once and shared by every test, and
 * only 5(a) and 5(c)-(d) add a run, for the inputs they name. Section 7 edits
 * those captures' evidence and adds none.
 *
 * Declared limits:
 *  - Outside R-unavail, every natural input's month surface calls
 *    budgetTrajectoryFor in the month state, so month 'none' on a reached
 *    surface is shown only by a capture state-list witness (no page edit).
 *    Under R-unavail (s5) neither the month nor the drilldown surface is
 *    reached, and both words read none (5(c)).
 *  - The omission witnesses edit the written evidence with fixed originals;
 *    with binding consistency they do not authenticate a coordinated
 *    replacement of every PR-written gate fact (the established limit).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const Snapshot = require('../scripts/figures-snapshot.js');
const Comment = require('../scripts/figures-comment.js');
const Capture = require('../scripts/figures-page-capture.js');

const ROOT = path.join(__dirname, '..');
const C = 'savings.capture.';
const clone = value => JSON.parse(JSON.stringify(value));

/* ---- inputs ---------------------------------------------------------------- */
const REPRO_DIR = path.join(__dirname, 'fixtures', 'savings-capture');
const COMMITTED = [
  ...Snapshot.loadInventedInputs().map(input => ({ id: input.id, doc: input.doc })),
  ...fs.readdirSync(REPRO_DIR).sort().map(file => {
    const doc = Snapshot.validateInventedInput(JSON.parse(fs.readFileSync(path.join(REPRO_DIR, file), 'utf8')), file);
    return { id: doc.id, doc };
  }),
];
const liveReady = COMMITTED.find(input => input.id === 'savings-live-ready').doc;
// S3 and S4 are the perturbations of test-savings-capture-fidelity.js: the
// engine's recommend output is corrupted so that the real selector withholds.
// S3: the next packet's planned requirements name another currency. S4: the
// top-level publication does, while every nested packet stays intact.
const withholdNextPacket = advice => {
  const views = advice && advice.savingsFunding && advice.savingsFunding.periodViews;
  const next = Array.isArray(views) ? views.find(view => view && view.role === 'next') : null;
  if (next && next.packet && next.packet.plannedRequirements) next.packet.plannedRequirements.currency = 'USD';
  return advice;
};
const withholdTopLevel = advice => {
  if (advice && advice.savingsFunding) advice.savingsFunding.currency = 'USD';
  return advice;
};
// INVNR and OPU-next are the advisory pass's legitimate-looking perturbations
// (#813 6560081927 §D, 6560657189): a present but non-ready Savings inventory,
// and the next pay period's operatingPlanUnavailable set.
const inventoryNotReady = advice => {
  if (advice && advice.savingsInventory) advice.savingsInventory = { ...advice.savingsInventory, status: 'unavailable' };
  return advice;
};
const nextPlanUnavailable = advice => {
  const view = advice && Array.isArray(advice.payPeriodViews) ? advice.payPeriodViews.find(v => v && v.timelineRole === 'next') : null;
  if (view) view.operatingPlanUnavailable = true;
  return advice;
};
const INPUTS = [...COMMITTED,
  { id: 'S3', doc: liveReady, corrupt: withholdNextPacket },
  { id: 'S4', doc: liveReady, corrupt: withholdTopLevel },
  { id: 'INVNR', doc: liveReady, corrupt: inventoryNotReady },
  { id: 'OPU-next', doc: liveReady, corrupt: nextPlanUnavailable }];
const spec = id => { const s = INPUTS.find(input => input.id === id); assert.ok(s, 'known input ' + id); return s; };
const pageInput = s => [clone(s.doc.data), s.doc.periods == null ? null : clone(s.doc.periods)];

// A perturbation corrupts recommend in both realms: the page realm's own
// Forecast (Capture.withPerturbations) and this process's Forecast (the
// itemized snapshot). An extra test observer wraps the page's own export
// first, so it receives the page realm's function.
function inRealms(s, extra, fn) {
  const perturbations = { ...(extra || {}) };
  const real = F.recommend;
  if (s.corrupt) {
    const inner = perturbations.recommend || (inPage => inPage);
    perturbations.recommend = inPage => {
      const observed = inner(inPage);
      return function perturbed(...args) { return s.corrupt(observed.apply(this, args)); };
    };
    F.recommend = function perturbed(...args) { return s.corrupt(real.apply(this, args)); };
  }
  try { return Object.keys(perturbations).length ? Capture.withPerturbations(perturbations, fn) : fn(); }
  finally { F.recommend = real; }
}

/* ---- captures, cached per input ------------------------------------------- */
const memo = new Map();
const once = (key, make) => { if (!memo.has(key)) memo.set(key, make()); return memo.get(key); };
// The rendered pages are recorded only where test 5(a) compares them.
const RENDERED = new Set(['savings-live-ready', 'card-paid-clear']);
const captureOf = id => once('capture|' + id, () => {
  const s = spec(id);
  return inRealms(s, null, () => Capture.capturePages(...pageInput(s), ROOT, RENDERED.has(id) ? { recordHtml: true } : {}));
});
const evidence = capture => { const out = {}; Snapshot.__putCaptureEvidence(out, '', capture); return out; };
const evidenceOf = id => once('evidence|' + id, () => evidence(captureOf(id)));
// The itemized snapshot (the collector's own engine run) beside the capture
// evidence, as the check snapshot carries them (undefined values omitted).
const headOf = id => once('head|' + id, () => {
  const s = spec(id);
  const itemized = inRealms(s, null, () => Snapshot.buildFiguresSnapshot(...pageInput(s)));
  const head = {};
  for (const [key, value] of Object.entries(itemized)) if (value !== undefined) head[key] = value;
  return { ...head, ...evidenceOf(id) };
});
const problems = head => Comment.captureEvidenceProblems(head, ['']);

/* ---- evidence editing ------------------------------------------------------ */
// Observation fields: page|state|route|source|context|ref|type|error.
const fieldsOf = head => Array.from({ length: head[C + 'count'] }, (_, n) => head[C + 'o' + n].split('|'));
// Rewrites the observation list consistently: edit() receives { n, f } (the
// original index and a copy of the fields) and returns the new list (drop,
// reorder, or insert a copy carrying the same n). o<n> and every result#k are
// renumbered, count and each state's calls= adjusted; a pass-through whose
// predecessor was dropped fails the edit (a consistent witness has none).
function rewrite(head, edit) {
  const out = { ...head };
  const entries = edit(fieldsOf(head).map((f, n) => ({ n, f: f.slice() })));
  const at = new Map();
  entries.forEach((e, i) => { if (!at.has(e.n)) at.set(e.n, i); });
  for (const e of entries) {
    const m = /^result#(\d+)$/.exec(e.f[3]);
    if (!m) continue;
    assert.ok(at.has(Number(m[1])), 'a renumbered pass-through keeps its predecessor');
    e.f[3] = 'result#' + at.get(Number(m[1]));
  }
  for (const key of Object.keys(out)) if (/^savings\.capture\.o\d+$/.test(key)) delete out[key];
  entries.forEach((e, i) => { out[C + 'o' + i] = e.f.join('|'); });
  out[C + 'count'] = entries.length;
  for (let i = 0; i < out[C + 'states']; i++) {
    const p = out[C + 'state.' + i].split('|');
    p[2] = 'calls=' + entries.filter(e => e.f[0] === p[0] && e.f[1] === p[1]).length;
    out[C + 'state.' + i] = p.join('|');
  }
  return out;
}
// The Budget advice lines' view anchors: id|role|start|end|byId|byView|rawPacket.
const VIEW_COLUMN = { byId: 4, byView: 5, rawPacket: 6 };
function viewAnchors(head, viewId) {
  const out = [];
  for (let i = 0; i < head[C + 'advices']; i++) {
    const line = head[C + 'advice.' + i].split('|');
    if (line[1] !== 'budget') continue;
    for (let j = 0; j < Number(line[5]); j++) {
      const key = C + 'advice.' + i + '.view.' + j;
      if (head[key].split('|')[0] === viewId) out.push(key);
    }
  }
  return out;
}
function setAnchor(head, viewId, column, value) {
  const out = { ...head };
  const keys = viewAnchors(head, viewId);
  assert.ok(keys.length > 0, 'the evidence anchors view ' + viewId);
  for (const key of keys) { const v = out[key].split('|'); v[VIEW_COLUMN[column]] = value; out[key] = v.join('|'); }
  return out;
}
const anchorColumn = (head, viewId, column) => viewAnchors(head, viewId).map(key => head[key].split('|')[VIEW_COLUMN[column]]);
const budgetAdviceLines = head => Array.from({ length: head[C + 'advices'] }, (_, i) => head[C + 'advice.' + i].split('|')).filter(a => a[1] === 'budget');

// The consumer routes (table r4 §1 step names).
const R = {
  q: 'public/savings-inventory.js#html<public/plan.js#q',
  dailyHtml: 'public/savings-inventory.js#html<public/plan.js#budgetDailySavingsHtml',
  goals: 'public/plan.js#budgetDailySavingsFor<public/plan.js#budgetSavingsGoalsHtml',
  upcoming: 'public/plan.js#budgetDailySavingsFor<public/plan.js#budgetUpcomingFundingHtml',
  month: 'public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetMonthSurfaceHtml',
  fundingPlan: 'public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetPayPeriodFundingPlanHtml',
  shortfall: 'public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetPayPeriodFundingShortfallHtml',
};
const NEXT = 'next-pay-period';
const inNext = f => f[0] === 'budget' && f[1].startsWith('period:' + NEXT + '/lens:');
const isCurrentState = f => f[0] === 'budget' && (f[1] === 'default' || f[1].startsWith('period:this-pay-period/lens:'));
const isRaw = f => f[2] === R.dailyHtml && f[3] === 'other-object';
const isPass = f => f[2] === R.dailyHtml && /^result#\d+$/.test(f[3]);
const nulled = f => Object.assign(f.slice(), { 5: 'null', 6: 'null' });
const stateKey = f => f[0] + '|' + f[1];

/* ---- 1. the pre-review regression witnesses ------------------------------ */
test('pre-review regression witnesses (6558436817): each consistent edit reads INVALID; the current, null and withheld forms read 0', async t => {
  const base = headOf('savings-live-ready');
  const all = fieldsOf(base);
  // Preconditions on the unedited evidence: the next packet is published and
  // anchored object/object in every Budget advice line; each next state reads
  // it raw once and passes its own step I result through once.
  const nextStart = Object.keys(base).map(k => /^period\.(\d{4}-\d{2}-\d{2})\.timelineRole$/.exec(k)).find(m => m && base[m[0]] === 'next')[1];
  assert.equal(base['savings.period.' + nextStart + '.publication'], 'published');
  assert.ok(anchorColumn(base, NEXT, 'byId').every(v => v === 'object') && anchorColumn(base, NEXT, 'rawPacket').every(v => v === 'object'));
  assert.equal(anchorColumn(base, NEXT, 'byId').length, budgetAdviceLines(base).length, 'every Budget advice line anchors the next view');
  assert.equal(all.filter(f => inNext(f) && isRaw(f) && f[6] === 'object').length, 2);
  assert.equal(all.filter(f => inNext(f) && isPass(f) && f[6] === 'object').length, 2);
  // R-pass at capture: every pass-through names this state's own step I.
  const goalsAt = new Map();
  all.forEach((f, n) => { if (f[2] === R.goals) goalsAt.set(stateKey(f), n); });
  const passes = all.filter(isPass);
  assert.ok(passes.length > 0 && passes.every(f => f[3] === 'result#' + goalsAt.get(stateKey(f))), 'each result#k names the same-state step I observation');

  await t.test('controls read 0: the unedited evidence, the current view (rawPacket none, byId object), S3 and S4', () => {
    assert.equal(problems(base), 0, 'the unedited evidence');
    assert.ok(anchorColumn(base, 'this-pay-period', 'byId').every(v => v === 'object'), 'current view: byId object');
    assert.ok(anchorColumn(base, 'this-pay-period', 'rawPacket').every(v => v === 'none'), 'current view: rawPacket none');
    const current = all.filter(f => isCurrentState(f) && f[2] === R.dailyHtml && /(?:^|,)period=view:/.test(f[4]));
    assert.ok(current.length === 6 && current.every(f => /\.savingsFunding$/.test(f[3])), 'current states read the top-level result, never a raw packet');
    const s3 = headOf('S3');
    assert.ok(anchorColumn(s3, NEXT, 'byId').every(v => v === 'null') && anchorColumn(s3, NEXT, 'rawPacket').every(v => v === 'null'), 'S3: the next view anchors byId and rawPacket null');
    const s3next = fieldsOf(s3).filter(inNext);
    assert.ok(s3next.filter(isRaw).length === 2 && s3next.filter(isRaw).every(f => f[6] === 'null'), 'S3: the raw read is observed and null');
    assert.ok(s3next.filter(f => f[2] === R.goals).every(f => f[6] === 'null') && !s3next.some(isPass), 'S3: step I null, no pass-through');
    assert.equal(problems(s3), 0, 'S3 (a withheld next packet)');
    const s4 = headOf('S4');
    assert.ok(budgetAdviceLines(s4).every(a => a[6] === 'null'), 'S4: the top-level anchor is null');
    assert.equal(problems(s4), 0, 'S4 (a withheld top-level result)');
  });

  await t.test('(a) next view rawPacket object→none, its raw-packet and pass-through calls removed, renumbered', () => {
    const edited = setAnchor(rewrite(base, list => list.filter(e => !(inNext(e.f) && (isRaw(e.f) || isPass(e.f))))), NEXT, 'rawPacket', 'none');
    assert.equal(edited[C + 'count'], all.length - 4);
    assert.ok(problems(edited) > 0, 'formatter refuses');
  });

  await t.test('(b) rawPacket object→null with the raw-packet outcomes nulled (pass-through dropped, as the repro did; and kept)', () => {
    const nullRaw = list => list.map(e => (inNext(e.f) && isRaw(e.f) ? { n: e.n, f: nulled(e.f) } : e));
    const dropped = setAnchor(rewrite(base, list => nullRaw(list.filter(e => !(inNext(e.f) && isPass(e.f))))), NEXT, 'rawPacket', 'null');
    assert.ok(problems(dropped) > 0, 'formatter refuses (pass-through dropped)');
    const kept = setAnchor(rewrite(base, nullRaw), NEXT, 'rawPacket', 'null');
    assert.ok(problems(kept) > 0, 'formatter refuses (pass-through kept: R-raw alone)');
  });

  await t.test('(c) the raw-packet call deleted with the anchor untouched', () => {
    const one = rewrite(base, list => list.filter(e => !(inNext(e.f) && isRaw(e.f))));
    assert.equal(one[C + 'count'], all.length - 2);
    assert.ok(problems(one) > 0, 'formatter refuses (next view)');
    // The receipt's R3 form: every raw-packet call dropped, each pass-through
    // repointed at its state's step I observation.
    const every = rewrite(base, list => list.filter(e => !isRaw(e.f))
      .map(e => (isPass(e.f) ? { n: e.n, f: Object.assign(e.f.slice(), { 3: 'result#' + goalsAt.get(stateKey(e.f)) }) } : e)));
    assert.ok(every[C + 'count'] < all.length - 2 && problems(every) > 0, 'formatter refuses (every non-current view)');
  });

  await t.test('(d) every pass-through call deleted', () => {
    const edited = rewrite(base, list => list.filter(e => !isPass(e.f)));
    assert.equal(edited[C + 'count'], all.length - passes.length);
    assert.ok(problems(edited) > 0, 'formatter refuses');
  });

  await t.test('(e) the de-duplication form: repeated (state, route, context) calls dropped', () => {
    const seen = new Set();
    const edited = rewrite(base, list => list.filter(e => {
      const key = [e.f[0], e.f[1], e.f[2], e.f[4]].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }));
    assert.equal(all.length - edited[C + 'count'], 25, 'one goals-sheet call per pay-period state is a repeat');
    assert.ok(problems(edited) > 0, 'formatter refuses');
  });

  await t.test('(f) a duplicated identical observation, calls adjusted', () => {
    const twice = n => rewrite(base, list => list.flatMap(e => (e.n === n ? [e, { n: e.n, f: e.f.slice() }] : [e])));
    const upcoming = all.findIndex(f => f[1] === 'default' && f[2] === R.upcoming);
    const pass = all.findIndex(f => inNext(f) && isPass(f));
    for (const [what, n] of [['the default state\'s step G', upcoming], ['a next-period pass-through', pass]]) {
      assert.ok(n >= 0);
      const edited = twice(n);
      assert.equal(edited[C + 'count'], all.length + 1);
      assert.ok(problems(edited) > 0, 'formatter refuses: ' + what);
    }
  });
});

/* ---- 2. unfunded drop-all --------------------------------------------------- */
test('unfunded drop-all: every observation and advice line removed reads INVALID; the unedited capture reads 0', () => {
  for (const id of ['card-paid-clear', 'opening-gap-unfunded']) {
    const head = headOf(id);
    assert.equal(head['savings.funding.status'], undefined, id + ': the itemized funding is absent');
    assert.equal(problems(head), 0, id + ': unedited');
    assert.ok(head[C + 'count'] > 0 && head[C + 'advices'] > 0);
    const dropped = rewrite(head, () => []);
    for (const key of Object.keys(dropped)) if (/^savings\.capture\.advice\./.test(key)) delete dropped[key];
    dropped[C + 'advices'] = 0;
    assert.ok(problems(dropped) > 0, id + ': every observation and anchor dropped is INVALID (R-unfunded)');
  }
});

/* ---- 3. the invalid-parent witness ---------------------------------------- */
// S4 is this witness: its top-level publication fails the selector (currency)
// while the next packet stays intact (table r4 §4).
test('invalid parent: the parent-gated path reads byId null, rawPacket none and no raw, q or pass-through call; a direct nested-packet call is an object', () => {
  const capture = captureOf('S4');
  const budget = capture.advices.filter(a => a.page === 'budget');
  assert.ok(budget.length > 0);
  for (const a of budget) {
    assert.equal(a.top, 'null', a.state + ': top null');
    assert.ok(a.views.length > 0 && a.views.every(v => v.byId === 'null' && v.rawPacket === 'none'), a.state + ': every view byId null, rawPacket none');
  }
  const observed = capture.observations.filter(o => o.page === 'budget');
  assert.ok(!observed.some(o => o.route === R.q), 'no html<q');
  assert.ok(!observed.some(o => o.source === 'other-object'), 'no raw-packet call');
  assert.ok(!observed.some(o => /^result#/.test(o.source)), 'no pass-through call');
  assert.ok(!observed.some(o => o.route === R.dailyHtml), 'steps 6, 11 and 12 absent');
  assert.ok(observed.length > 0 && observed.every(o => o.result === null), 'every observed Budget call reads null');
  assert.equal(problems(headOf('S4')), 0, 'formatter: 0');
  // A different invocation the page never makes, in this process's realm and
  // never observed: the selector on the nested next packet itself.
  const s = spec('S4');
  const [data, periods] = pageInput(s);
  const advice = inRealms(s, null, () => F.recommend(data.plan, data.meta.asOf, Snapshot.pageOptions(data, periods)));
  const asOf = data.meta.asOf;
  const view = advice.payPeriodViews.find(v => v.timelineRole === 'next');
  const entry = advice.savingsFunding.periodViews.find(e => e && e.id === view.id);
  assert.equal(F.savingsFundingPublication(advice.savingsFunding, { asOf, advice }), null, 'the parent fails the selector');
  assert.equal(F.savingsFundingPublication(advice.savingsFunding, { asOf, advice, periodId: view.id }), null, 'byId is null under the invalid parent');
  const direct = F.savingsFundingPublication(entry.packet, { asOf, period: view });
  assert.ok(direct && typeof direct === 'object' && direct === entry.packet, 'the nested packet validates on its own');
  assert.equal(Capture.perturbed(), false);
});

/* ---- 4. the S10 and inventory-gate prediction ----------------------------- */
// The port of the build's acceptance check (gatecheck.js), through the real
// anchors (capture.gates and capture.advices). Advices are keyed by Budget
// state only (Plan spend has a default state too). R-unavail is the adopted
// binding, the itemized planning.operatingPlan key (rules v5, rule 11): the
// plan-unavailable card returns before every predicted route, and the month
// and drilldown words read none exactly then.
test('S10 and inventory-gate prediction through the real anchors: 0 mismatches over every committed invented input and the perturbations', () => {
  const mismatches = [];
  const wants = new Map();
  for (const s of INPUTS) {
    const cap = captureOf(s.id);
    const unavail = Object.prototype.hasOwnProperty.call(headOf(s.id), 'planning.operatingPlan');
    const run = cap.runs.find(r => r.page === 'budget');
    const adv = new Map(cap.advices.filter(a => a.page === 'budget').map(a => [a.state, a]));
    for (const st of run.states) {
      const check = (name, got, want) => {
        const key = name + '=' + want;
        wants.set(key, (wants.get(key) || 0) + 1);
        if (got !== want) mismatches.push([s.id, st.id, name, 'got', got, 'want', want].join(' '));
      };
      const obs = cap.observations.filter(o => o.page === 'budget' && o.state === st.id);
      assert.equal(obs.length, st.calls, s.id + ' ' + st.id + ': calls');
      const g = cap.gates.find(x => x.page === 'budget' && x.state === st.id);
      assert.ok(g, s.id + ' ' + st.id + ': a gate line');
      const a = adv.get(st.id);
      const funded = !!a && a.funding !== 'absent';
      const has = route => obs.some(o => o.route === route);
      if (st.id === 'granularity:month') {
        check('month none', g.month === 'none', unavail);
        check('R-M', has(R.month), !unavail && funded && g.month === 'y');
        check('R-M2', has(R.fundingPlan), has(R.month) && g.monthPayday === 'y');
        const rm = obs.find(o => o.route === R.month);
        if (rm) check('monthId', g.monthId, rm.result && typeof rm.result === 'object' ? 'pub' : 'fallback');
      } else if (st.id === 'drilldown') {
        check('drilldown none', g.drilldown === 'none', unavail);
        const gate = !unavail && funded && g.drilldown === 'yyyy';
        check('R-N1', has(R.fundingPlan), gate);
        check('R-N2', has(R.shortfall), gate);
      } else {
        const top = !!a && a.top === 'object';
        const cal = g.calendar === 'yyyyyyyy';
        const sel = (/^period:(.+)\/lens:/.exec(st.id) || [])[1] || 'this-pay-period';
        const v = a && a.views.find(x => x.id === sel);
        const cur = !!v && v.role === 'current';
        const views = obs.filter(o => o.route === R.dailyHtml && /(?:^|,)period=view:/.test(o.context));
        // In the roster's fixed order step 6 precedes G and step 11 follows it,
        // so a current state's lone period=view call (INVNR: no step 6) is told
        // apart by position, not by count.
        const gAt = obs.findIndex(o => o.route === R.upcoming);
        const beforeG = views.filter(o => obs.indexOf(o) < gAt), afterG = views.filter(o => obs.indexOf(o) > gAt);
        check('D', has(R.q), !unavail && top && cal);
        // Step 6: current, the period=view call on the top-level result before
        // G; non-current, the raw packet (other-object).
        const step6 = cur ? beforeG.length > 0 && /\.savingsFunding$/.test(beforeG[0].source) : views.some(o => o.source === 'other-object');
        check('E', step6, !unavail && cal && g.dailyAsOf === 'y' && (cur ? top : !!v && v.rawPacket !== 'none'));
        const ri = obs.find(o => o.route === R.goals);
        const step11 = cur ? afterG.length > 0 : views.some(o => /^result#\d+$/.test(o.source));
        check('J', step11, !unavail && !!(ri && ri.result) && g.inventory === 'y');
        const rg = obs.find(o => o.route === R.upcoming && /(?:^|,)periodId=null/.test(o.context));
        check('K', obs.some(o => o.route === R.dailyHtml && /(?:^|,)advice=/.test(o.context)), !unavail && !!(rg && rg.result) && g.inventory === 'y');
      }
    }
  }
  assert.deepEqual(mismatches, [], 'every route is present exactly when its gate facts predict it');
  for (const name of ['R-M', 'R-M2', 'R-N1', 'R-N2', 'D', 'E', 'J', 'K', 'month none', 'drilldown none']) {
    assert.ok(wants.get(name + '=true') > 0 && wants.get(name + '=false') > 0, name + ' is exercised both ways');
  }
  assert.ok(wants.get('monthId=pub') > 0 && wants.get('monthId=fallback') > 0, 'monthId pub and fallback are both exercised');
  assert.equal(captureOf('S4').gates.find(g => g.state === 'granularity:month').monthId, 'fallback', 'S4: the helper\'s unavailable fallback');
});

/* ---- 5. gate binding, omission and neutrality ----------------------------- */
const MONTH_STATES = ['granularity:month', 'drilldown'];
const stripGates = e => Object.fromEntries(Object.entries(e).filter(([k]) => k !== C + 'gates' && !/^savings\.capture\.gate\.\d+$/.test(k)));
const observationLines = e => Object.keys(e).filter(k => /^savings\.capture\.o\d+$/.test(k)).sort().map(k => [k, e[k]]);
const rendered = capture => capture.runs.map(r => [r.page, r.loadErrors, r.states.map(s => [s.id, s.calls, s.error, s.unfinished, s.html])]);

test('gate binding (a): with options.gates === false the renders, observations and every other evidence key are identical (the wrappers are pass-through)', () => {
  for (const id of RENDERED) {
    const s = spec(id);
    const on = captureOf(id);
    const off = inRealms(s, null, () => Capture.capturePages(...pageInput(s), ROOT, { recordHtml: true, gates: false }));
    assert.equal(on.gates.length, on.runs.find(r => r.page === 'budget').states.length, id + ': one gate line per Budget state by default');
    assert.equal(off.gates.length, 0, id + ': no gate facts when disabled');
    assert.deepEqual(rendered(off), rendered(on), id + ': identical rendered pages, state by state');
    const eOn = evidenceOf(id), eOff = evidence(off);
    assert.deepEqual(observationLines(eOff), observationLines(eOn), id + ': identical observation lines');
    assert.deepEqual(stripGates(eOff), stripGates(eOn), id + ': identical evidence apart from the gate lines');
    assert.equal(eOff[C + 'gates'], 0);
  }
});

const GATE_FIELDS = ['page', 'state', 'calendar', 'dailyAsOf', 'inventory', 'month', 'monthPayday', 'monthId', 'drilldown'];
const gateIndex = (head, state) => {
  for (let i = 0; i < head[C + 'gates']; i++) if (head[C + 'gate.' + i].split('|')[1] === state) return i;
  return -1;
};
const gateOf = (head, state) => Object.fromEntries(head[C + 'gate.' + gateIndex(head, state)].split('|').map((v, i) => [GATE_FIELDS[i], v]));
function withGate(head, state, field, value) {
  const out = { ...head };
  const i = gateIndex(head, state);
  assert.ok(i >= 0, 'a gate line for ' + state);
  const p = out[C + 'gate.' + i].split('|');
  assert.notEqual(p[GATE_FIELDS.indexOf(field)], value, 'the witness changes ' + field);
  p[GATE_FIELDS.indexOf(field)] = value;
  out[C + 'gate.' + i] = p.join('|');
  return out;
}
// One gate line deleted, the later lines renumbered and the count adjusted.
function withoutGate(head, state) {
  const out = { ...head };
  const i = gateIndex(head, state), count = head[C + 'gates'];
  assert.ok(i >= 0);
  for (let j = i; j < count - 1; j++) out[C + 'gate.' + j] = head[C + 'gate.' + (j + 1)];
  delete out[C + 'gate.' + (count - 1)];
  out[C + 'gates'] = count - 1;
  return out;
}

test('gate binding (b): an omitted or flipped gate fact reads INVALID', () => {
  const base = headOf('savings-live-ready');
  assert.equal(problems(base), 0);
  const all = fieldsOf(base);
  const observed = (state, match) => all.some(f => f[0] === 'budget' && f[1] === state && match(f));
  // Preconditions: the steps each flip governs are observed.
  assert.ok(observed('default', f => f[2] === R.q) && observed('default', f => f[2] === R.dailyHtml && /period=view/.test(f[4])), 'default: D and E observed');
  assert.ok(observed('default', f => f[2] === R.dailyHtml && /advice=/.test(f[4])), 'default: K observed');
  assert.equal(all.filter(f => f[1] === 'default' && f[2] === R.dailyHtml && /period=view/.test(f[4])).length, 2, 'default: E and J observed');
  assert.ok(observed('granularity:month', f => f[2] === R.month) && observed('granularity:month', f => f[2] === R.fundingPlan), 'month: R-M and R-M2 observed');
  assert.ok(observed('drilldown', f => f[2] === R.fundingPlan) && observed('drilldown', f => f[2] === R.shortfall), 'drilldown: R-N1 and R-N2 observed');
  const g = gateOf(base, 'default');
  assert.deepEqual([g.calendar, g.dailyAsOf, g.inventory], ['yyyyyyyy', 'y', 'y']);
  const m = gateOf(base, 'granularity:month');
  assert.deepEqual([m.month, m.monthPayday, m.monthId], ['y', 'y', 'pub']);
  assert.equal(gateOf(base, 'drilldown').drilldown, 'yyyy');
  for (const [what, head] of gateBindingWitnesses(base)) assert.ok(problems(head) > 0, what);
});
// The witnesses of 5(b), on savings-live-ready (section 7 reads them again
// through both validators).
function gateBindingWitnesses(base) {
  const g = gateOf(base, 'default');
  return [
    ['one gate line deleted (renumbered, count adjusted)', withoutGate(base, 'default')],
    ['calendar flipped to n... where D and E are observed', withGate(base, 'default', 'calendar', 'n' + g.calendar.slice(1))],
    ['dailyAsOf flipped where E is observed (step 6\'s own equality)', withGate(base, 'default', 'dailyAsOf', 'n')],
    ['inventory flipped y→n where J and K are observed', withGate(base, 'default', 'inventory', 'n')],
    ['month flipped y→n with R-M observed', withGate(base, 'granularity:month', 'month', 'n')],
    ['monthPayday flipped y→n with R-M2 observed', withGate(base, 'granularity:month', 'monthPayday', 'n')],
    ['drilldown yyyn with N1/N2 observed', withGate(base, 'drilldown', 'drilldown', 'yyyn')],
    ['monthId other with R-M present', withGate(base, 'granularity:month', 'monthId', 'other')],
  ];
}

// Test-side observers for 5(c) and 5(d), all pass-through. Through
// Capture.withPerturbations, the page realm's own baselineTrajectory records
// each return, and recommend counts the Budget states: each Budget state
// renders through exactly one recommend call (asserted), so the count dates
// every record to its state. From inside that recommend wrapper, the page
// realm's own global (through the realm's own Function) gets pass-through
// observers on budgetTrajectoryFor and budgetMonthPlanSpendSchedule during the
// default render; the capture's gate wrappers, installed after load, then
// wrap these. The evidence is asserted identical to the default capture's.
const PAGE_FRAME = /at (?:new )?(?:(?:Object|Proxy)\.)?([\w$.<>]+)? ?\(?(public\/[\w.-]+\.js):\d+:\d+/;
const pageCaller = () => {
  for (const line of String(new Error().stack).split('\n').slice(2)) {
    const m = PAGE_FRAME.exec(line);
    if (m) return m[2] + '#' + (m[1] || '<anonymous>');
  }
  return '<none>';
};
function recordedRun(id, states) {
  const s = spec(id);
  const rec = { budgetStates: 0, trajectories: [], calls: [] };
  let budgetRealm = null;
  let currentPageGlobal = null;
  const hooked = new Set();
  const realmOf = value => (value && typeof value === 'object' ? Object.getPrototypeOf(value) : null);
  const extra = {
    recommend: inPage => function observedRecommend(...args) {
      if (budgetRealm === null) budgetRealm = realmOf(args[0]);
      if (realmOf(args[0]) === budgetRealm) rec.budgetStates++;
      // Trusted access to the page realm (the capture's own context, via its
      // test hook), never a page constructor call (Atlas 6565803810 §5).
      const pageGlobal = currentPageGlobal;
      if (!hooked.has(pageGlobal) && typeof pageGlobal.budgetTrajectoryFor === 'function') {
        hooked.add(pageGlobal);
        for (const name of ['budgetTrajectoryFor', 'budgetMonthPlanSpendSchedule']) {
          const real = pageGlobal[name];
          pageGlobal[name] = function (...a) {
            const before = rec.trajectories.length;
            const ret = real.apply(this, a);
            rec.calls.push({ name, state: rec.budgetStates - 1, caller: pageCaller(), ctx: a[0], ret,
              fresh: rec.trajectories.length > before,
              computed: rec.trajectories.length > before ? rec.trajectories[rec.trajectories.length - 1].ret : undefined,
              cached: before > 0 ? rec.trajectories[before - 1].ret : undefined });
            return ret;
          };
        }
      }
      return inPage.apply(this, args);
    },
    baselineTrajectory: inPage => function observedTrajectory(...args) {
      const ret = inPage.apply(this, args);
      if (realmOf(args[0]) === budgetRealm) rec.trajectories.push({ state: rec.budgetStates - 1, ret });
      return ret;
    },
  };
  const onPageContext = c => { currentPageGlobal = c; };
  const capture = inRealms(s, extra, () => Capture.capturePages(...pageInput(s), ROOT, states ? { states, onPageContext } : { onPageContext }));
  assert.equal(Capture.perturbed(), false);
  return { capture, rec, stateIds: capture.runs.find(r => r.page === 'budget').states.map(st => st.id) };
}
const recordedOf = id => once('recorded|' + id, () => {
  const run = recordedRun(id);
  assert.deepEqual(evidence(run.capture), evidenceOf(id), id + ': the test observers change no evidence');
  assert.equal(run.rec.budgetStates, run.stateIds.length, id + ': one recommend call per Budget state');
  return run;
});
// The recorded runs cost a second capture each, so they cover one input per
// distinct funded/unfunded month and drilldown gate pattern (asserted below
// against every input): funded with payday, without it, with the trajectory
// not ready, and the S4 fallback; unfunded (the legacy schedule) with payday,
// without it, with no overlapping period, and with no pay periods at all; and
// R-unavail (s5), where neither surface is reached.
const RECORDED = ['savings-live-ready', 's1-historical-pools', 'savings-deficit-cover', 'S4',
  'card-paid-clear', 'card-paid-held', 'opening-gap-funded', 'opening-gap-unfunded', 's5-operating-plan-withheld'];
const s10Pattern = capture => [capture.advices.find(a => a.page === 'budget').funding === 'absent' ? 'unfunded' : 'funded',
  ...MONTH_STATES.map(state => {
    const g = capture.gates.find(x => x.state === state);
    return [g.month, g.monthPayday, g.monthId, g.drilldown].join('/');
  })].join(' ');
const yn = v => (v ? 'y' : 'n');
// Mirrors of the page's gate predicates (public/plan.js), written for this
// test: the month surface (3185-3187), the drilldown periods and labels
// (3267-3291, 3336-3345), the selected period (3846) and the payday check
// (3191-3192, with isValidIsoCalendarDate 3709-3719).
const monthFact = t => yn(t && t.status === 'ready' && Array.isArray(t.months) && t.months.length > 0);
const monthEndDay = key => {
  const y = Number(String(key).slice(0, 4)), m = Number(String(key).slice(5, 7));
  if (!y || !(m >= 1 && m <= 12)) return null;
  return String(key).slice(0, 7) + '-' + String(new Date(y, m, 0).getDate()).padStart(2, '0');
};
const periodLabel = p => (!p ? null : p.windowKind === 'full-cycle' ? p.cycleRangeLabel || p.rangeLabel || p.payday || p.id || null : p.rangeLabel || null);
function drilldownFacts(t, anchorMonth, want = null) {
  const ready = !!(t && t.status === 'ready');
  const monthStart = anchorMonth.slice(0, 7) + '-01', monthEnd = monthEndDay(anchorMonth);
  const list = !ready || !Array.isArray(t.payPeriods) ? [] : t.payPeriods.filter(p => {
    if (!p) return false;
    const s = p.cycleStart || p.start, e = p.cycleEnd || p.end;
    return typeof s === 'string' && typeof e === 'string' && s <= monthEnd && e >= monthStart;
  }).filter(periodLabel);
  const sel = list.find(p => p && (p.payday || p.id) === want) || list[0];
  return [ready, list.length > 0, !!(sel && periodLabel(sel)), !!(sel && (sel.payday || sel.id))].map(yn).join('');
}
const isoDate = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = Number(v.slice(0, 4)), m = Number(v.slice(5, 7)), d = Number(v.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= (m === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);
};
const paydayFact = (schedule, ctx) => {
  const asOf = ctx && (ctx.asOf || (ctx.meta && ctx.meta.asOf));
  const pd = schedule && Array.isArray(schedule.paydays) && schedule.paydays[0] ? schedule.paydays[0].payday : undefined;
  return yn(schedule && schedule.asOf === asOf && isoDate(pd) && pd >= asOf);
};
const lastCall = (rec, name, state, caller) => rec.calls.filter(c => c.name === name && c.state === state && c.caller === caller).pop();

test('gate binding (c): month and drilldown facts come from the trajectory this state\'s own budgetTrajectoryFor call returned; cache hits return the same object', async t => {
  for (const s of INPUTS) {
    for (const g of captureOf(s.id).gates) {
      if (!MONTH_STATES.includes(g.state)) assert.deepEqual([g.month, g.monthPayday, g.monthId, g.drilldown], ['-', '-', '-', '-'], s.id + ' ' + g.state + ': a pay-period state has no S10 facts');
    }
  }
  const patterns = new Set(INPUTS.map(s => s10Pattern(captureOf(s.id))));
  assert.deepEqual(new Set(RECORDED.map(id => s10Pattern(captureOf(id)))), patterns, 'the recorded inputs cover every month/drilldown gate pattern');
  assert.equal(patterns.size, RECORDED.length, 'one recorded input per pattern');
  let fresh = 0, hits = 0, hitAcrossStates = 0;
  for (const id of RECORDED) {
    const { capture, rec, stateIds } = recordedOf(id);
    const asOf = spec(id).doc.data.meta.asOf;
    for (const c of rec.calls.filter(x => x.name === 'budgetTrajectoryFor')) {
      if (c.fresh) { fresh++; assert.equal(c.ret, c.computed, id + ': a computed trajectory is returned as computed'); }
      else if (c.ret !== null) {
        hits++;
        assert.equal(c.ret, c.cached, id + ' ' + stateIds[c.state] + ' (' + c.caller + '): a cache hit returns the same object');
        if (rec.trajectories.every(x => x.state !== c.state)) hitAcrossStates++;
      }
    }
    const gate = state => capture.gates.find(g => g.state === state);
    const month = lastCall(rec, 'budgetTrajectoryFor', stateIds.indexOf('granularity:month'), 'public/plan.js#budgetMonthSurfaceHtml');
    const drill = lastCall(rec, 'budgetTrajectoryFor', stateIds.indexOf('drilldown'), 'public/plan.js#budgetPayPeriodDrilldownHtml');
    if (Object.prototype.hasOwnProperty.call(headOf(id), 'planning.operatingPlan')) {
      // R-unavail: the plan-unavailable card returns before either surface
      // calls the trajectory, so both words read none (#813 6560714968 §2).
      const surfaceStates = [stateIds.indexOf('granularity:month'), stateIds.indexOf('drilldown')];
      assert.ok(!rec.calls.some(c => c.name === 'budgetTrajectoryFor' && surfaceStates.includes(c.state)), id + ': no budgetTrajectoryFor call in the month or drilldown state');
      assert.deepEqual([gate('granularity:month').month, gate('drilldown').drilldown], ['none', 'none'], id + ': both words read none');
      continue;
    }
    // Every other natural input reaches both surfaces (no natural 'none' case
    // on a reached surface).
    assert.ok(month && drill, id + ': the month and drilldown surfaces call budgetTrajectoryFor');
    assert.equal(gate('granularity:month').month, monthFact(month.ret), id + ': month from this state\'s own trajectory');
    assert.equal(gate('drilldown').drilldown, drilldownFacts(drill.ret, asOf.slice(0, 7)), id + ': drilldown from this state\'s own trajectory');
  }
  assert.ok(fresh > 0 && hits > 0 && hitAcrossStates > 0, 'computed and cached trajectories (including a hit on an earlier state\'s object) are both exercised');
  await t.test('a month-labelled state whose render makes no budgetTrajectoryFor call reads none, with the cache filled (capture state-list witness, not a page state)', () => {
    const states = [{ id: 'default', set: {} },
      { id: 'drilldown', set: { budgetGranularity: 'pay-period', budgetPayPeriodAnchorMonth: '@asOfMonth' } },
      { id: 'granularity:month', set: {} }];
    const { capture, rec, stateIds } = recordedRun('savings-live-ready', states);
    assert.deepEqual(stateIds, states.map(x => x.id));
    assert.ok(rec.trajectories.some(x => x.state === 1 && x.ret && x.ret.status === 'ready'), 'the drilldown state filled the page\'s trajectory cache');
    assert.ok(!rec.calls.some(c => c.name === 'budgetTrajectoryFor' && c.state === 2), 'the month-labelled state made no budgetTrajectoryFor call');
    const g = capture.gates.find(x => x.state === 'granularity:month');
    assert.deepEqual([g.month, g.monthPayday, g.monthId], ['none', '-', '-']);
  });
});

test('gate binding (d): monthPayday and monthId use the helper\'s own returned schedule (R-M\'s result schedule, or the unavailable fallback)', () => {
  const seen = { pub: 0, fallback: 0, other: 0 };
  for (const id of RECORDED) {
    const { capture, rec, stateIds } = recordedOf(id);
    const g = capture.gates.find(x => x.state === 'granularity:month');
    const helper = lastCall(rec, 'budgetMonthPlanSpendSchedule', stateIds.indexOf('granularity:month'), 'public/plan.js#budgetMonthSurfaceHtml');
    const rm = capture.observations.find(o => o.page === 'budget' && o.state === 'granularity:month' && o.route === R.month);
    if (!helper) {
      assert.ok(!rm, id + ': no R-M without the helper');
      assert.deepEqual([g.monthPayday, g.monthId], ['-', '-'], id + ': no helper, no payday facts');
      continue;
    }
    assert.equal(g.monthPayday, paydayFact(helper.ret, helper.ctx), id + ': monthPayday from the helper\'s own schedule');
    if (rm && rm.result) {
      assert.ok(rm.result.schedule && helper.ret === rm.result.schedule, id + ': the helper returned R-M\'s own result schedule');
      assert.equal(g.monthId, 'pub', id);
      seen.pub++;
    } else if (rm) {
      assert.ok(helper.ret && helper.ret.status === 'unavailable' && helper.ret.source === 'Forecast.planSpendPaydayFunding'
        && Array.isArray(helper.ret.paydays) && helper.ret.paydays.length === 0, id + ': the unavailable fallback');
      assert.equal(g.monthId, 'fallback', id);
      seen.fallback++;
    } else {
      assert.equal(capture.advices.find(a => a.page === 'budget').funding, 'absent', id + ': only a legacy helper computes its own schedule');
      assert.equal(g.monthId, 'other', id);
      seen.other++;
    }
  }
  assert.ok(seen.pub > 0 && seen.fallback > 0 && seen.other > 0, 'pub, fallback and the legacy schedule are each exercised');
});

/* ---- 6. gate and itemized bindings (advisory findings 1-3) ---------------- */
// Every gate fact agrees with evidence the record already holds, so a UNIFORM
// flip in every pay-period state (which state-equality cannot see) with its
// governed steps dropped reads INVALID; and the collector's itemized periods
// and publication agree with themselves, so one itemized key cannot remove a
// period, a publication or the funded roster without a contradiction.
const payState = f => f[0] === 'budget' && (f[1] === 'default' || f[1].startsWith('period:'));
const isE = (f, list) => f[2] === R.dailyHtml && /period=view/.test(f[4]) && list.indexOf(f) === list.findIndex(g => g[1] === f[1] && g[2] === R.dailyHtml && /period=view/.test(g[4]));
function everyPayState(head, field, value, drop) {
  let out = { ...head };
  for (let i = 0; i < head[C + 'gates']; i++) {
    const p = out[C + 'gate.' + i].split('|');
    if (p[1] !== 'default' && !p[1].startsWith('period:')) continue;
    p[GATE_FIELDS.indexOf(field)] = value;
    out[C + 'gate.' + i] = p.join('|');
  }
  return rewrite(out, list => {
    const fs_ = list.map(e => e.f);
    return list.filter(e => !(payState(e.f) && drop(e.f, fs_)));
  });
}
test('gate and itemized bindings: uniform every-state flips and one-key itemized edits read INVALID; every input reads 0', () => {
  for (const s of INPUTS) assert.equal(problems(headOf(s.id)), 0, s.id + ': the unedited capture reads 0');
  const base = headOf('savings-live-ready');
  const all = fieldsOf(base);
  assert.ok(all.some(f => payState(f) && f[2] === R.q) && all.some(f => payState(f) && f[2] === R.dailyHtml && /advice=/.test(f[4])), 'D and K observed');
  for (const [what, head] of advisoryGateWitnesses(base)) assert.ok(problems(head) > 0, what);
  // Itemized coherence, each edit isolated on an otherwise valid record.
  assert.equal(typeof headOf('card-paid-clear')['savings.funding.status'], 'undefined', 'card-paid-clear is unfunded');
  for (const [what, head] of advisoryItemizedWitnesses()) assert.ok(problems(head) > 0, what);
});
// The witnesses of test 6 (section 7 reads them again through both validators).
function advisoryGateWitnesses(base) {
  const isJ = (f, list) => f[2] === R.dailyHtml && /period=view/.test(f[4]) && !isE(f, list);
  return [
    ['calendar fact 1 flipped to n in every pay-period state, D and E dropped', everyPayState(base, 'calendar', 'nyyyyyyy', (f, l) => f[2] === R.q || isE(f, l))],
    ['calendar fact 2 (ready) flipped in every pay-period state, D and E dropped', everyPayState(base, 'calendar', 'ynyyyyyy', (f, l) => f[2] === R.q || isE(f, l))],
    ['calendar uu in every pay-period state, D and E dropped', everyPayState(base, 'calendar', 'yyyyyyuu', (f, l) => f[2] === R.q || isE(f, l))],
    ['calendar - in every pay-period state, D and E dropped', everyPayState(base, 'calendar', '-', (f, l) => f[2] === R.q || isE(f, l))],
    ['dailyAsOf n in every pay-period state, E dropped', everyPayState(base, 'dailyAsOf', 'n', (f, l) => isE(f, l))],
    ['dailyAsOf - in every pay-period state, E dropped', everyPayState(base, 'dailyAsOf', '-', (f, l) => isE(f, l))],
    ['inventory n in every pay-period state, J and K dropped', everyPayState(base, 'inventory', 'n', (f, l) => isJ(f, l) || (f[2] === R.dailyHtml && /advice=/.test(f[4])))],
    ['inventory - in every pay-period state, J and K dropped', everyPayState(base, 'inventory', '-', (f, l) => isJ(f, l) || (f[2] === R.dailyHtml && /advice=/.test(f[4])))],
    ['month - in the month state, M and M2 dropped', rewrite(withGate(withGate(withGate(base, 'granularity:month', 'month', '-'), 'granularity:month', 'monthPayday', '-'), 'granularity:month', 'monthId', '-'),
      list => list.filter(e => !(e.f[1] === 'granularity:month' && (e.f[2] === R.month || e.f[2] === R.fundingPlan))))],
    ['monthPayday - with month y, M2 dropped', rewrite(withGate(base, 'granularity:month', 'monthPayday', '-'), list => list.filter(e => !(e.f[1] === 'granularity:month' && e.f[2] === R.fundingPlan)))],
    ['drilldown - in the drilldown state, N1 and N2 dropped', rewrite(withGate(base, 'drilldown', 'drilldown', '-'), list => list.filter(e => !(e.f[1] === 'drilldown' && (e.f[2] === R.fundingPlan || e.f[2] === R.shortfall))))],
  ];
}
function advisoryItemizedWitnesses() {
  const legacy = headOf('card-paid-clear');
  const pastDate = Object.keys(legacy).map(k => /^period\.(\d{4}-\d{2}-\d{2})\.timelineRole$/.exec(k)).find(m => m && legacy[m[0]] === 'past')[1];
  const funded = headOf('savings-live-ready'), s3 = headOf('S3');
  const pubDate = Object.keys(funded).map(k => /^savings\.period\.(\d{4}-\d{2}-\d{2})\.publication$/.exec(k)).find(m => m && funded[m[0]] === 'published')[1];
  const withheld = Object.keys(s3).find(k => /^savings\.period\.[^.]+\.publication$/.test(k) && s3[k] === 'withheld');
  assert.ok(withheld, 'S3 withholds one period');
  const without = (h, k) => { const o = { ...h }; assert.ok(k in o, k); delete o[k]; return o; };
  return [
    ['unfunded with a Savings publication key', { ...legacy, ['savings.period.' + pastDate + '.publication']: 'withheld' }],
    ['a period without its role', without(legacy, 'period.' + pastDate + '.role')],
    ['a period whose role and timelineRole disagree', { ...legacy, ['period.' + pastDate + '.role']: 'future' }],
    ['a funded period without its publication', without(funded, 'savings.period.' + pubDate + '.publication')],
    ['a publication for no itemized period', { ...funded, 'savings.period.1999-01-01.publication': 'withheld' }],
    ['a published packet without its status', without(funded, 'savings.period.' + pubDate + '.status')],
    ['a withheld publication carrying a packet key', { ...s3, [withheld.replace(/publication$/, 'status')]: 'ready' }],
    ['an unknown publication word', { ...funded, ['savings.period.' + pubDate + '.publication']: 'partial' }],
  ];
}

/* ---- 7. the finite repair's witnesses, through both validators ------------ */
// Muse START (#787 6560753655) on Atlas ruling #813 6560691831; adoption
// record #813 6560081927 (part 1), 6560657189 (part 2, the frozen checklist),
// 6560714968 (addendum; §6 is the acceptance table) and 6560749340 (Atlas's
// corrections). One test per §6 row: contradictory or malformed evidence reads
// nonzero on BOTH validators; the repaired legitimate states read 0/0; each
// coherent named-limit witness reads its stated outcome, recorded by name as a
// limit and never as proof of completeness. The loading row (L1-L6 and the
// invalid escapes) is test-savings-consumer-contract.js. A last test records
// the outcomes no adopted disposition covers, for the desk.
//
// "Consistently" (part 1): after an edit the observations are renumbered,
// every result#k follows its predecessor, count and each state's calls= are
// adjusted (rewrite), and results no observation references are pruned and
// renumbered in first-reference order, the capture's own numbering.

// The posting step's independent validator (.github/workflows/figures-review.yml),
// extracted under test-savings-capture-fidelity.js's contract: from the comment
// line naming "Savings capture evidence" to just before `const digestState`,
// the script's 12-space indentation stripped, run with the posting step's own
// `has` and `DIGEST` over an empty headInputs Map, so it evaluates exactly the
// household prefix '' where this file writes the evidence. Whatever mirror
// the checkout holds is the one read.
const MIRROR_HAS = 'const has = (map, key) => map !== null && Object.prototype.hasOwnProperty.call(map, key);';
let mirrorMemo = null;
function workflowMirror() {
  if (mirrorMemo) return mirrorMemo;
  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'figures-review.yml'), 'utf8');
  const all = text.split(/\r?\n/);
  const start = all.findIndex(line => /^\s*\/\//.test(line) && line.includes('Savings capture evidence'));
  const end = start < 0 ? -1 : all.findIndex((line, i) => i > start && /^\s*const digestState\b/.test(line));
  assert.ok(start >= 0 && end > start, 'the workflow mirror block is found');
  const body = all.slice(start, end);
  assert.ok(body.every(line => line.trim() === '' || line.startsWith(' '.repeat(12))), 'the block sits at the posting script\'s indentation');
  assert.ok(text.includes(MIRROR_HAS) && text.includes('DIGEST = /^[a-f0-9]{64}$/'), 'the wrapper passes the posting step\'s own has and DIGEST');
  const block = body.map(line => (line.trim() === '' ? '' : line.slice(12))).join('\n');
  const source = '(function (head, headInputs, has, DIGEST) { let invalid = 0;\n' + block + '\nreturn invalid; })';
  const sandbox = { require: name => {
    if (name !== 'crypto' && name !== 'fs') throw new Error('the workflow mirror may load only crypto and fs, not ' + name);
    return require(name);
  } };
  const fn = vm.runInNewContext(source, sandbox, { filename: 'figures-review.yml#savings-capture-evidence' });
  const has = (map, key) => map !== null && Object.prototype.hasOwnProperty.call(map, key);
  const run = head => fn(head, new Map(), has, /^[a-f0-9]{64}$/);
  const smoke = run({});
  assert.ok(Number.isSafeInteger(smoke) && smoke > 0, 'the extracted mirror evaluates, and refuses an empty head');
  mirrorMemo = run;
  return run;
}
const mirrorProblems = head => workflowMirror()(head);
// Each witness read by both validators, its counts reported as a diagnostic
// (names and counts only).
function readBoth(t, witnesses, { quiet = false } = {}) {
  return witnesses.map(([name, head]) => {
    const row = { name, formatter: problems(head), mirror: mirrorProblems(head) };
    if (!quiet) t.diagnostic(name + ': formatter ' + row.formatter + ', workflow mirror ' + row.mirror);
    return row;
  });
}
// Both columns are compared at once, so a failure names every witness and the
// validator that read it otherwise; a zero/nonzero split between the two
// validators is listed on its own.
function expectBoth(rows, want, what) {
  const off = column => rows.filter(r => !want(r[column])).map(r => r.name + ' (' + r[column] + ')');
  const split = rows.filter(r => (r.formatter > 0) !== (r.mirror > 0)).map(r => r.name + ' (' + r.formatter + '/' + r.mirror + ')');
  assert.deepEqual({ formatter: off('formatter'), mirror: off('mirror'), zeroNonzeroSplit: split },
    { formatter: [], mirror: [], zeroNonzeroSplit: [] }, what);
}
const NONZERO = n => n > 0;
const ZERO = n => n === 0;

// Every observation's roster step (table r4 §1). html<budgetDailySavingsHtml is
// E before its state's G and J after it (K with advice=); the schedule helper
// under budgetPayPeriodFundingPlanHtml is M2 in month view and N1 in drilldown.
const STEP_OF_ROUTE = {
  'public/savings-inventory.js#html<public/plan.js#renderPlan': 'B0',
  'public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetTodayCashCardHtml': 'A',
  'public/plan.js#budgetSavingsTimelineFor<public/plan.js#budgetPayPeriodContentHtml': 'B',
  'public/plan.js#budgetDailySavingsFor<public/plan.js#budgetPayPeriodContentHtml': 'C',
  [R.q]: 'D',
  'public/plan.js#budgetDailySavingsFor<public/plan.js#budgetUpcomingAnnualBill': 'F',
  [R.upcoming]: 'G',
  'public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetUpcomingFundingHtml': 'H',
  [R.goals]: 'I',
  [R.month]: 'M',
  [R.shortfall]: 'N2',
  'public/plan-spend.js#planSpendFundingSchedule<public/plan-spend.js#planSpendPageHtml': 'P1',
  'public/savings-inventory.js#html<public/plan-spend.js#renderPlanSpend': 'P2',
};
const ROUTE_OF_STEP = Object.fromEntries(Object.entries(STEP_OF_ROUTE).map(([route, step]) => [step, route]));
function stepLabels(list) {
  const afterG = new Set();
  return list.map(f => {
    if (f[2] === R.dailyHtml) return /(?:^|,)advice=/.test(f[4]) ? 'K' : afterG.has(stateKey(f)) ? 'J' : 'E';
    if (f[2] === R.fundingPlan) return f[1] === 'drilldown' ? 'N1' : 'M2';
    if (f[2] === R.upcoming) afterG.add(stateKey(f));
    return STEP_OF_ROUTE[f[2]] || '?';
  });
}
const PAY = state => state === 'default' || state.startsWith('period:');
const payObs = f => f[0] === 'budget' && PAY(f[1]);
const isMonth = state => state === 'granularity:month';
const isDrill = state => state === 'drilldown';
const owns = (head, key) => Object.prototype.hasOwnProperty.call(head, key);
const isFunded = head => typeof head['savings.funding.status'] === 'string';
const withoutKeys = (head, drop) => Object.fromEntries(Object.entries(head).filter(([key]) => !drop(key)));
// Results no observation references any more are removed; the rest are
// renumbered in first-reference order with every observation's ref adjusted.
function pruneResults(head) {
  const out = { ...head };
  const list = fieldsOf(head);
  const order = [];
  for (const f of list) if (/^r\d+$/.test(f[5]) && !order.includes(f[5])) order.push(f[5]);
  const to = new Map(order.map((r, k) => [r, 'r' + k]));
  const moved = {};
  for (const key of Object.keys(out)) {
    const m = /^savings\.capture\.(r\d+)\.(.+)$/.exec(key);
    if (!m) continue;
    if (to.has(m[1])) moved[C + to.get(m[1]) + '.' + m[2]] = out[key];
    delete out[key];
  }
  Object.assign(out, moved);
  list.forEach((f, n) => { if (to.has(f[5])) { f[5] = to.get(f[5]); out[C + 'o' + n] = f.join('|'); } });
  out[C + 'results'] = order.length;
  return out;
}
// Drops every observation whose step passes drop(step, fields); at least one.
function dropSteps(head, drop) {
  const out = rewrite(head, list => {
    const steps = stepLabels(list.map(e => e.f));
    return list.filter((e, i) => !drop(steps[i], e.f));
  });
  assert.ok(out[C + 'count'] < head[C + 'count'], 'the witness drops an observed step');
  return pruneResults(out);
}
// Sets gate fields on every gate line whose state passes which(state); at
// least one fact changes.
function setGates(head, which, values) {
  const out = { ...head };
  let changed = 0;
  for (let i = 0; i < head[C + 'gates']; i++) {
    const p = out[C + 'gate.' + i].split('|');
    if (!which(p[1])) continue;
    for (const [field, value] of Object.entries(values)) {
      const j = GATE_FIELDS.indexOf(field);
      if (p[j] !== value) { p[j] = value; changed++; }
    }
    out[C + 'gate.' + i] = p.join('|');
  }
  assert.ok(changed > 0, 'the witness changes a gate fact');
  return out;
}
const gateLines = (head, which) => Array.from({ length: head[C + 'gates'] }, (_, i) => head[C + 'gate.' + i].split('|')).filter(p => which(p[1]));
// The itemized starts of a timeline role, and a view's page id and states.
const startsOf = (head, role) => Object.keys(head).map(k => /^period\.(\d{4}-\d{2}-\d{2})\.timelineRole$/.exec(k))
  .filter(m => m && head[m[0]] === role).map(m => m[1]).sort();
const viewIdOf = (role, start) => (role === 'current' ? 'this-pay-period' : role === 'next' ? NEXT : role + ':' + start);
const viewStates = viewId => ['period:' + viewId + '/lens:today', 'period:' + viewId + '/lens:payday'];
const inView = (f, viewId) => f[0] === 'budget' && viewStates(viewId).includes(f[1]);
// Removes Budget states with their state, gate and advice lines (the advice's
// view lines with it) and their observations, renumbered, counts adjusted.
function removeStates(head, ids) {
  const gone = new Set(ids);
  const out = { ...rewrite(head, list => list.filter(e => !(e.f[0] === 'budget' && gone.has(e.f[1])))) };
  const relist = (countKey, lineKey, keep, subs) => {
    const lines = Array.from({ length: out[C + countKey] }, (_, i) => {
      const item = { line: out[C + lineKey + '.' + i], subs: subs ? subs(i) : [] };
      delete out[C + lineKey + '.' + i];
      item.subs.forEach((_, j) => delete out[C + lineKey + '.' + i + '.view.' + j]);
      return item;
    });
    const kept = lines.filter(item => keep(item.line.split('|')));
    kept.forEach((item, i) => {
      out[C + lineKey + '.' + i] = item.line;
      item.subs.forEach((v, j) => { out[C + lineKey + '.' + i + '.view.' + j] = v; });
    });
    out[C + countKey] = kept.length;
  };
  relist('states', 'state', p => !(p[0] === 'budget' && gone.has(p[1])));
  relist('gates', 'gate', p => !gone.has(p[1]));
  relist('advices', 'advice', p => !(p[1] === 'budget' && gone.has(p[2])),
    i => Array.from({ length: Number(out[C + 'advice.' + i].split('|')[5]) }, (_, j) => out[C + 'advice.' + i + '.view.' + j]));
  assert.equal(out[C + 'states'], head[C + 'states'] - ids.length, 'the declared states are removed');
  return pruneResults(out);
}
// Removes one view from every advice line of both pages, renumbering the rest.
function withoutViewAnchor(head, viewId) {
  const out = { ...head };
  for (let i = 0; i < out[C + 'advices']; i++) {
    const p = out[C + 'advice.' + i].split('|');
    const views = Array.from({ length: Number(p[5]) }, (_, j) => out[C + 'advice.' + i + '.view.' + j]);
    views.forEach((_, j) => delete out[C + 'advice.' + i + '.view.' + j]);
    const kept = views.filter(v => v.split('|')[0] !== viewId);
    assert.equal(kept.length, views.length - 1, 'each advice line anchors the view once');
    kept.forEach((v, j) => { out[C + 'advice.' + i + '.view.' + j] = v; });
    p[5] = String(kept.length);
    if (p[4] === viewId) p[4] = 'none';
    out[C + 'advice.' + i] = p.join('|');
  }
  return out;
}
const removeView = (head, viewId) => removeStates(withoutViewAnchor(head, viewId), viewStates(viewId));
// Renames a view across the capture: its id and role in every anchor, its two
// states (state, gate and advice lines) and the view identities in their
// observations' contexts. A renamed current view leaves no current view.
function renameView(head, from, to, role) {
  const out = { ...head };
  const state = s => (viewStates(from).includes(s) ? s.replace('period:' + from + '/', 'period:' + to + '/') : s);
  for (let i = 0; i < out[C + 'states']; i++) { const p = out[C + 'state.' + i].split('|'); p[1] = state(p[1]); out[C + 'state.' + i] = p.join('|'); }
  for (let i = 0; i < out[C + 'gates']; i++) { const p = out[C + 'gate.' + i].split('|'); p[1] = state(p[1]); out[C + 'gate.' + i] = p.join('|'); }
  for (let i = 0; i < out[C + 'advices']; i++) {
    const p = out[C + 'advice.' + i].split('|');
    p[2] = state(p[2]);
    if (p[4] === from) p[4] = 'none';
    out[C + 'advice.' + i] = p.join('|');
    for (let j = 0; j < Number(p[5]); j++) {
      const v = out[C + 'advice.' + i + '.view.' + j].split('|');
      if (v[0] === from) { v[0] = to; v[1] = role; }
      out[C + 'advice.' + i + '.view.' + j] = v.join('|');
    }
  }
  return rewrite(out, list => list.map(e => {
    if (!inView(e.f, from)) return e;
    const f = e.f.slice();
    f[1] = state(f[1]);
    f[4] = f[4].split('periodId="' + from + '"').join('periodId="' + to + '"').split('period=view:' + from).join('period=view:' + to);
    return { n: e.n, f };
  }));
}

// Part 1 A1-A6 and Astra's H1a/H1b: gate words flipped in every pay-period
// state (A6: one state) with the steps they govern dropped.
const ONE_STATE = 'period:' + NEXT + '/lens:today';
const A_WITNESSES = [
  ['A1 calendar ynyyyyyy in every pay-period state, D and E dropped (the current-view E included)',
    h => dropSteps(setGates(h, PAY, { calendar: 'ynyyyyyy' }), (s, f) => payObs(f) && (s === 'D' || s === 'E'))],
  ['A2 calendar - in every pay-period state, D and E dropped',
    h => dropSteps(setGates(h, PAY, { calendar: '-' }), (s, f) => payObs(f) && (s === 'D' || s === 'E'))],
  ['A3 dailyAsOf - in every pay-period state, E dropped',
    h => dropSteps(setGates(h, PAY, { dailyAsOf: '-' }), (s, f) => payObs(f) && s === 'E')],
  ['A3/H1a dailyAsOf null in every pay-period state, E dropped (each state\'s C kept, an object)',
    h => dropSteps(setGates(h, PAY, { dailyAsOf: 'null' }), (s, f) => payObs(f) && s === 'E')],
  ['A4/H1b inventory n in every pay-period state, J and K dropped',
    h => dropSteps(setGates(h, PAY, { inventory: 'n' }), (s, f) => payObs(f) && (s === 'J' || s === 'K'))],
  ['A4 inventory - in every pay-period state, J and K dropped',
    h => dropSteps(setGates(h, PAY, { inventory: '-' }), (s, f) => payObs(f) && (s === 'J' || s === 'K'))],
  ['A5 inventory n and calendar nnnnnnnn in every pay-period state, D, E, J and K dropped',
    h => dropSteps(setGates(h, PAY, { inventory: 'n', calendar: 'nnnnnnnn' }), (s, f) => payObs(f) && ['D', 'E', 'J', 'K'].includes(s))],
  ['A6 inventory n in ' + ONE_STATE + ' only, its J and K dropped',
    h => dropSteps(setGates(h, s => s === ONE_STATE, { inventory: 'n' }), (s, f) => f[0] === 'budget' && f[1] === ONE_STATE && (s === 'J' || s === 'K'))],
];
// An input carries them when it is funded, not R-unavail, and every pay-period
// gate line reads calendar yyyyyyyy, dailyAsOf y and inventory y.
const aEligible = head => isFunded(head) && !owns(head, 'planning.operatingPlan')
  && gateLines(head, PAY).every(p => p[2] === 'yyyyyyyy' && p[3] === 'y' && p[4] === 'y');
// Part 1 B: S10 single-state substitutions in the month and drilldown states.
const monthWitness = (h, values, steps) => dropSteps(setGates(h, isMonth, values), (s, f) => f[0] === 'budget' && isMonth(f[1]) && steps.includes(s));
const drillWitness = (h, word) => dropSteps(word === 'yyyy' ? h : setGates(h, isDrill, { drilldown: word }),
  (s, f) => f[0] === 'budget' && isDrill(f[1]) && (s === 'N1' || s === 'N2'));
const DRILL_WORDS = Array.from({ length: 16 }, (_, k) => k.toString(2).padStart(4, '0').replace(/0/g, 'y').replace(/1/g, 'n'));
// The words the declared selection can produce (capture 694-702).
const REACHABLE_DRILL = ['nnnn', 'ynnn', 'yyyy', 'yyyn'];
// C1 and D(d): the capture converted to the unfunded roster (part 1 C1): every
// advice absent with null verdicts and rawPacket none; only C, F, G and the
// current-view I remain, with source undefined and null outcomes; the month
// and drilldown states carry no advice (calendar and inventory -), the month
// id is -, and every pay-period daily asOf reads null (C returned null).
function unfundedCapture(head) {
  let out = { ...head };
  for (let i = 0; i < out[C + 'advices']; i++) {
    const p = out[C + 'advice.' + i].split('|');
    p[3] = 'absent';
    if (p[1] === 'budget') { p[6] = 'null'; p[7] = 'null'; p[8] = 'null'; } else p[8] = 'null';
    out[C + 'advice.' + i] = p.join('|');
    if (p[1] !== 'budget') continue;
    for (let j = 0; j < Number(p[5]); j++) {
      const v = out[C + 'advice.' + i + '.view.' + j].split('|');
      v[4] = 'null'; v[5] = 'null'; v[6] = 'none';
      out[C + 'advice.' + i + '.view.' + j] = v.join('|');
    }
  }
  out = rewrite(out, list => {
    const steps = stepLabels(list.map(e => e.f));
    return list.filter((e, i) => payObs(e.f) && (['C', 'F', 'G'].includes(steps[i]) || (steps[i] === 'I' && isCurrentState(e.f))))
      .map(e => ({ n: e.n, f: Object.assign(e.f.slice(), { 3: 'undefined', 5: 'null', 6: 'null' }) }));
  });
  out = setGates(out, PAY, { dailyAsOf: 'null' });
  out = setGates(out, s => !PAY(s), { calendar: '-', inventory: '-' });
  out = setGates(out, isMonth, { monthId: '-' });
  return pruneResults(out);
}
const PUBLICATION_KEY = /^savings\.(?:current(?:#\d+)?|period\.[^.]+)\./;
// C2: one period's timelineRole deleted, with its two states, its anchor view
// and their observations.
function timelineRoleDeleted(head, role) {
  const d = startsOf(head, role)[0];
  return withoutKeys(removeView(head, viewIdOf(role, d)), k => k === 'period.' + d + '.timelineRole');
}
// Whole-period substitution: every itemized and capture key of one period.
function wholePeriod(head, role) {
  const d = startsOf(head, role)[0];
  const pub = role === 'current' ? 'savings.current.' : 'savings.period.' + d + '.';
  return withoutKeys(removeView(head, viewIdOf(role, d)), k => k.startsWith('period.' + d + '.') || k.startsWith(pub));
}
// C3: a period retimed past: a past view has no F; unfunded, I is current
// only; with no current view the default state selects none (no F, no I).
function retimeToPast(head, role) {
  const d = startsOf(head, role)[0];
  const from = viewIdOf(role, d), to = 'past:' + d, funded = isFunded(head);
  const out = { ...renameView(head, from, to, 'past'), ['period.' + d + '.timelineRole']: 'past' };
  return dropSteps(out, (s, f) => (inView(f, to) && (s === 'F' || (s === 'I' && !funded)))
    || (role === 'current' && f[0] === 'budget' && f[1] === 'default' && (s === 'F' || s === 'I')));
}
// C4: a published packet withheld (next/future: close.status deleted), byId
// null and rawPacket none for its view, I nulled, E and J dropped in its two
// states; the packet's other keys left.
function withheldPublication(head, role) {
  const d = startsOf(head, role)[0], v = viewIdOf(role, d);
  let out = { ...head, ['savings.period.' + d + '.publication']: 'withheld' };
  if (role === 'next' || role === 'future') out = withoutKeys(out, k => k === 'savings.period.' + d + '.close.status');
  out = setAnchor(setAnchor(out, v, 'byId', 'null'), v, 'rawPacket', 'none');
  out = rewrite(out, list => {
    const steps = stepLabels(list.map(e => e.f));
    return list.filter((e, i) => !(inView(e.f, v) && (steps[i] === 'E' || steps[i] === 'J')))
      .map(e => (inView(e.f, v) && e.f[2] === R.goals ? { n: e.n, f: nulled(e.f) } : e));
  });
  return pruneResults(out);
}
// C5: a period's operatingPlanUnavailable set true, F dropped in its states.
function planUnavailableOn(head, role) {
  const d = startsOf(head, role)[0];
  return { ...dropSteps(head, (s, f) => s === 'F' && inView(f, viewIdOf(role, d))), ['period.' + d + '.operatingPlanUnavailable']: true };
}
// R-unavail faked: the one binding key added, every Budget state reduced to B0
// and Plan spend to P2, the unavailable branch's gate words.
function fakeUnavailable(head) {
  let out = { ...head, 'planning.operatingPlan': 'unavailable' };
  out = rewrite(out, list => {
    const steps = stepLabels(list.map(e => e.f));
    return list.filter((e, i) => steps[i] === (e.f[0] === 'budget' ? 'B0' : 'P2'));
  });
  out = setGates(out, PAY, { dailyAsOf: '-' });
  out = setGates(out, isMonth, { month: 'none', monthPayday: '-', monthId: '-' });
  out = setGates(out, isDrill, { drilldown: 'none' });
  return pruneResults(out);
}
// ... and moved past K1-K5: no planning key but the binding and the
// trajectory's (K2, K3), every current group flagged (K4), no weekly cap (K5).
function pastK(head) {
  const out = withoutKeys(fakeUnavailable(head), k => k.startsWith('planning.') && k !== 'planning.operatingPlan' && !k.startsWith('planning.trajectory.'));
  for (const d of startsOf(head, 'current')) out['period.' + d + '.operatingPlanUnavailable'] = true;
  out['plan.weeklyCap'] = null;
  return out;
}
// The 082e pre-review repros of test 1 (the same edits; test 1 keeps their
// per-edit preconditions).
function preReviewWitnesses(base) {
  const all = fieldsOf(base);
  const goalsAt = new Map();
  all.forEach((f, n) => { if (f[2] === R.goals) goalsAt.set(stateKey(f), n); });
  const nullRaw = list => list.map(e => (inNext(e.f) && isRaw(e.f) ? { n: e.n, f: nulled(e.f) } : e));
  const twice = n => rewrite(base, list => list.flatMap(e => (e.n === n ? [e, { n: e.n, f: e.f.slice() }] : [e])));
  const seen = new Set();
  return [
    ['082e (a) next view rawPacket object→none, its raw-packet and pass-through calls removed', setAnchor(rewrite(base, list => list.filter(e => !(inNext(e.f) && (isRaw(e.f) || isPass(e.f))))), NEXT, 'rawPacket', 'none')],
    ['082e (b) rawPacket object→null, raw outcomes nulled, pass-through dropped', setAnchor(rewrite(base, list => nullRaw(list.filter(e => !(inNext(e.f) && isPass(e.f))))), NEXT, 'rawPacket', 'null')],
    ['082e (b) rawPacket object→null, raw outcomes nulled, pass-through kept', setAnchor(rewrite(base, nullRaw), NEXT, 'rawPacket', 'null')],
    ['082e (c) the next view\'s raw-packet calls deleted, anchor untouched', rewrite(base, list => list.filter(e => !(inNext(e.f) && isRaw(e.f))))],
    ['082e (c) every raw-packet call deleted, each pass-through repointed at its step I', rewrite(base, list => list.filter(e => !isRaw(e.f))
      .map(e => (isPass(e.f) ? { n: e.n, f: Object.assign(e.f.slice(), { 3: 'result#' + goalsAt.get(stateKey(e.f)) }) } : e)))],
    ['082e (d) every pass-through call deleted', rewrite(base, list => list.filter(e => !isPass(e.f)))],
    ['082e (e) repeated (state, route, context) calls dropped', rewrite(base, list => list.filter(e => {
      const key = [e.f[0], e.f[1], e.f[2], e.f[4]].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }))],
    ['082e (f) the default state\'s step G observed twice', twice(all.findIndex(f => f[1] === 'default' && f[2] === R.upcoming))],
    ['082e (f) a next-period pass-through observed twice', twice(all.findIndex(f => inNext(f) && isPass(f)))],
  ];
}
const stepsIn = (head, which) => { const list = fieldsOf(head); const steps = stepLabels(list); return list.map((f, i) => [f, steps[i]]).filter(([f]) => which(f)).map(([, s]) => s); };

test('finite repair §6 row 1: contradictory or malformed evidence reads nonzero on both validators', async t => {
  const base = headOf('savings-live-ready');
  assert.equal(problems(base), 0, 'savings-live-ready: formatter 0');
  assert.equal(mirrorProblems(base), 0, 'savings-live-ready: workflow mirror 0');

  await t.test('A1-A6, H1a and H1b: gate words flipped in every pay-period state (A6: one state), their governed steps dropped, on every eligible funded input', t2 => {
    const eligible = INPUTS.filter(s => aEligible(headOf(s.id))).map(s => s.id);
    // Part 1 ran these on every funded input (six committed, S1, S2) and S3.
    for (const id of ['savings-chained-closes', 'savings-deficit-cover', 'savings-estimated-close', 'savings-fully-backed',
      'savings-live-partial', 'savings-live-ready', 's1-historical-pools', 's2-ready-withheld', 'S3']) assert.ok(eligible.includes(id), id + ' carries the A witnesses');
    t2.diagnostic('inputs: ' + eligible.join(', '));
    const rows = [];
    for (const [name, make] of A_WITNESSES) {
      const per = readBoth(t2, eligible.map(id => [name + ' @' + id, make(headOf(id))]), { quiet: true });
      t2.diagnostic(name + ': formatter ' + per.map(r => r.formatter).join(',') + '; workflow mirror ' + per.map(r => r.mirror).join(','));
      rows.push(...per);
    }
    expectBoth(rows, NONZERO, 'A1-A6, H1a, H1b');
  });

  await t.test('B2 and B4 (the month state), and every unreachable drilldown word, with the steps their words govern dropped', t2 => {
    const m = gateOf(base, 'granularity:month');
    assert.deepEqual([m.month, m.monthPayday, m.monthId, gateOf(base, 'drilldown').drilldown], ['y', 'y', 'pub', 'yyyy'], 'a ready month with its payday fact; drilldown yyyy');
    const unreachable = DRILL_WORDS.filter(w => !REACHABLE_DRILL.includes(w));
    assert.equal(unreachable.length, 12);
    const rows = readBoth(t2, [
      ['B2 month none on a reached month surface (payday -, id -), M and M2 dropped', monthWitness(base, { month: 'none', monthPayday: '-', monthId: '-' }, ['M', 'M2'])],
      ['B4 a ready month with payday - (the rule-7 payday line), M2 dropped', monthWitness(base, { monthPayday: '-' }, ['M2'])],
      ['drilldown yyyy with N1 and N2 dropped (the omission alone)', drillWitness(base, 'yyyy')],
      ...unreachable.map(w => ['drilldown ' + w + ' (unreachable), N1 and N2 dropped', drillWitness(base, w)]),
      ['drilldown none on a reached surface (not R-unavail), N1 and N2 dropped', drillWitness(base, 'none')],
    ]);
    expectBoth(rows, NONZERO, 'B2, B4 and the unreachable drilldown words');
  });

  await t.test('C1-C4: itemized edits with their matching capture edits, contradicted by the sibling keys left intact', t2 => {
    const unfunded = unfundedCapture(base);
    assert.ok(Object.keys(base).filter(k => PUBLICATION_KEY.test(k)).length > 0, 'savings-live-ready publishes its periods');
    assert.equal(isFunded(headOf('card-paid-clear')), false, 'card-paid-clear is a legacy unfunded input');
    const rows = readBoth(t2, [
      ['C1 savings.funding.status deleted, the capture unfunded, the publication keys intact', withoutKeys(unfunded, k => k === 'savings.funding.status')],
      ['C1 savings.funding.status null, the capture unfunded, the publication keys intact', { ...unfunded, 'savings.funding.status': null }],
      ...['past', 'next', 'future'].map(role => ['C2 the ' + role + ' period\'s timelineRole deleted with its two states, its anchor view and their observations (its role kept)', timelineRoleDeleted(base, role)]),
      ...[['card-paid-clear', 'next'], ['card-paid-clear', 'future'], ['card-paid-clear', 'current'], ['S3', 'next']].map(([id, role]) =>
        ['C3 ' + id + ': the ' + role + ' period retimed past across the capture (its role kept)', retimeToPast(headOf(id), role)]),
      ...['past', 'next', 'future'].map(role => ['C4 the ' + role + ' publication published→withheld with byId null, rawPacket none, I nulled, E and J dropped (its packet keys left)', withheldPublication(base, role)]),
    ]);
    expectBoth(rows, NONZERO, 'C1-C4');
  });

  await t.test('R-unavail faked by its one key with consistent call drops fails by K2-K5; K1, a wrong value, fails on its own', t2 => {
    const fake = fakeUnavailable(base), moved = pastK(base);
    const [cur] = startsOf(base, 'current');
    const flag = 'period.' + cur + '.operatingPlanUnavailable';
    assert.ok(owns(base, 'planning.horizonEnd') && owns(base, 'planning.encumbered') && base['plan.weeklyCap'] != null && base[flag] !== true,
      'savings-live-ready: the available plan\'s keys (horizon, encumbered, weekly cap; the current period unflagged)');
    assert.deepEqual([...new Set(stepsIn(fake, f => f[0] === 'budget'))], ['B0']);
    assert.deepEqual(stepsIn(fake, f => f[0] === 'planSpend'), ['P2']);
    const rows = readBoth(t2, [
      ['R-unavail faked: planning.operatingPlan added, every Budget state reduced to B0, Plan spend to P2, the unavailable gate words', fake],
      ['K1: the fake moved past K2-K5, planning.operatingPlan live (a wrong value)', { ...moved, 'planning.operatingPlan': 'live' }],
      ['K2: the fake moved past K1-K5 but planning.horizonEnd kept (also a K3 key)', { ...moved, 'planning.horizonEnd': base['planning.horizonEnd'] }],
      ['K3: the fake moved past K1-K5 but planning.encumbered kept', { ...moved, 'planning.encumbered': base['planning.encumbered'] }],
      ['K4: the fake moved past K1-K5 but the current period\'s operatingPlanUnavailable as collected', owns(base, flag) ? { ...moved, [flag]: base[flag] } : withoutKeys(moved, k => k === flag)],
      ['K5: the fake moved past K1-K5 but plan.weeklyCap as collected', { ...moved, 'plan.weeklyCap': base['plan.weeklyCap'] }],
      // Atlas 6562644400 §1: the consequent is an explicit null, so a deleted
      // cap does not satisfy K5 (the collector always writes the key).
      ['K5: the fake moved past K1-K5 but plan.weeklyCap deleted (absent, not null)', withoutKeys(moved, k => k === 'plan.weeklyCap')],
    ]);
    {
      // On the legitimate withheld input (s5) itself: an explicit null cap reads
      // 0/0; the same record with the key deleted reads nonzero on both.
      const s5 = headOf('s5-operating-plan-withheld');
      assert.ok(owns(s5, 'plan.weeklyCap') && s5['plan.weeklyCap'] === null, 's5 carries an explicit null cap');
      assert.deepEqual([problems(s5), mirrorProblems(s5)], [0, 0], 's5 reads 0/0');
      const deleted = withoutKeys(s5, k => k === 'plan.weeklyCap');
      assert.ok(problems(deleted) > 0 && mirrorProblems(deleted) > 0, 's5 with plan.weeklyCap deleted reads nonzero on both');
    }
    expectBoth(rows, NONZERO, 'R-unavail faked');
    // With K2-K5 all moved the same fake reads 0 on both (row 3's named limit):
    // its nonzero count is K2-K5 alone.
    assert.deepEqual([problems(moved), mirrorProblems(moved)], [0, 0], 'the fake past K1-K5');
  });

  await t.test('R-noplans (plan-spend.js:294-297): P1 dropped where plans exist, and fabricated on the funded input with none', t2 => {
    const s6 = headOf('s6-no-major-plans');
    assert.ok(Object.keys(base).some(k => /^planning\.(.+)\.verdict$/.test(k)), 'savings-live-ready publishes major plans');
    assert.deepEqual(stepsIn(base, f => f[0] === 'planSpend'), ['P1', 'P2']);
    const p2 = fieldsOf(s6).findIndex(f => f[0] === 'planSpend');
    const fabricated = rewrite(s6, list => list.flatMap(e => (e.n === p2 ? [{ n: e.n, f: Object.assign(e.f.slice(), { 2: ROUTE_OF_STEP.P1 }) }, e] : [e])));
    assert.deepEqual(stepsIn(fabricated, f => f[0] === 'planSpend'), ['P1', 'P2']);
    const rows = readBoth(t2, [
      ['savings-live-ready (plans exist) with P1 dropped', dropSteps(base, s => s === 'P1')],
      ['s6 (no plan) with P1 fabricated before P2', fabricated],
    ]);
    expectBoth(rows, NONZERO, 'R-noplans');
  });

  await t.test('D(d), option (i): a funded input whose anchors say funding=absent and byId null against its published periods', t2 => {
    const rows = readBoth(t2, [['savings-live-ready: savings.funding.status kept, the capture converted to the unfunded roster (part 2\'s C1 control)', unfundedCapture(base)]]);
    expectBoth(rows, NONZERO, 'D(d)');
    // Option (i) was adopted so that the two validators count this case alike.
    assert.equal(rows[0].mirror, rows[0].formatter, 'equal counts under option (i)');
  });

  await t.test('D5 counter mapping: duplicate identities numbered by each prefix\'s own counter (Atlas correction 4)', t2 => {
    const [d0] = startsOf(base, 'current'), [dn] = startsOf(base, 'next');
    // Itemized-only: the capture's views are keyed by start date and do not
    // show a #n group, so each edit isolates the counter mapping.
    const curNext = { ...base, ['period.' + d0 + '#2.role']: 'future', ['period.' + d0 + '#2.timelineRole']: 'next' };
    const twoNext = { ...base, ['period.' + dn + '#2.role']: 'future', ['period.' + dn + '#2.timelineRole']: 'future' };
    const twoCurrent = { ...base, ['period.' + d0 + '#2.role']: 'active', ['period.' + d0 + '#2.timelineRole']: 'current' };
    const rows = readBoth(t2, [
      ['a current and a non-current group share a start; publications keyed by equated counters (savings.period.<start>#2)', { ...curNext, ['savings.period.' + d0 + '#2.publication']: 'withheld' }],
      ['two non-current groups share a start; savings.period.<start>#2 missing', twoNext],
      ['two current groups; savings.current#2 missing', twoCurrent],
    ]);
    expectBoth(rows, NONZERO, 'D5 duplicate identities');
    // Controls: the same groups keyed by each prefix's own counter read 0, so it
    // is the counter mapping that rejects the rows above.
    const controls = readBoth(t2, [
      ['control: the current/non-current pair keyed per prefix (savings.period.<start>)', { ...curNext, ['savings.period.' + d0 + '.publication']: 'withheld' }],
      ['control: two non-current groups, savings.period.<start>#2 withheld', { ...twoNext, ['savings.period.' + dn + '#2.publication']: 'withheld' }],
      ['control: two current groups, savings.current#2 withheld', { ...twoCurrent, 'savings.current#2.publication': 'withheld' }],
    ]);
    expectBoth(controls, ZERO, 'D5 per-prefix controls');
  });

  await t.test('the recorded regression witnesses (tests 1, 5(b) and 6: the 082e pre-review repros and the advisory pass), through both validators', t2 => {
    const rows = readBoth(t2, [...preReviewWitnesses(base), ...gateBindingWitnesses(base), ...advisoryGateWitnesses(base), ...advisoryItemizedWitnesses()]);
    expectBoth(rows, NONZERO, 'the recorded regression witnesses');
  });
});

test('finite repair §6 row 2: the repaired legitimate states read 0/0 on both validators', async t => {
  await t.test('s5: the operating plan withheld (overlay applied), inside the parity subset, observes the R-unavail roster', () => {
    const doc = spec('s5-operating-plan-withheld').doc, head = headOf('s5-operating-plan-withheld');
    assert.deepEqual(Snapshot.parityExclusions(doc.data), [], 'inside the engine-input parity subset');
    assert.deepEqual([doc.data.liveOverlay.applied, doc.data.liveOverlay.operatingPlan], [true, 'unavailable']);
    assert.equal(head['planning.operatingPlan'], 'unavailable', 'the R-unavail binding (figures-snapshot.js:511-512)');
    assert.ok(isFunded(head), 'funded');
    for (let i = 0; i < head[C + 'states']; i++) {
      const [page, state] = head[C + 'state.' + i].split('|');
      assert.deepEqual(stepsIn(head, f => f[0] === page && f[1] === state), [page === 'budget' ? 'B0' : 'P2'], page + ' ' + state + ': the unavailable card only');
    }
    for (const p of gateLines(head, () => true)) {
      assert.equal(p[3], '-', p[1] + ': no daily call');
      if (isMonth(p[1])) assert.deepEqual(p.slice(5, 8), ['none', '-', '-'], 'month none');
      if (isDrill(p[1])) assert.equal(p[8], 'none', 'drilldown none');
    }
  });
  await t.test('s6: a funded input with no major plan, inside the parity subset; Plan spend observes exactly [P2]', () => {
    const doc = spec('s6-no-major-plans').doc, head = headOf('s6-no-major-plans');
    assert.deepEqual(Snapshot.parityExclusions(doc.data), [], 'inside the engine-input parity subset');
    assert.ok(isFunded(head), 'funded: savings.funding.status is a string');
    assert.equal(Object.keys(head).filter(k => /^planning\.(.+)\.verdict$/.test(k)).length, 0, 'no planning.<id>.verdict key');
    assert.ok(!owns(head, 'planning.operatingPlan'), 'the operating plan is available');
    assert.deepEqual(stepsIn(head, f => f[0] === 'planSpend'), ['P2']);
    // Its source input, with both commitments unsettled, publishes plans and P1.
    const source = headOf('savings-deficit-cover');
    assert.ok(Object.keys(source).some(k => /^planning\.(.+)\.verdict$/.test(k)));
    assert.deepEqual(stepsIn(source, f => f[0] === 'planSpend'), ['P1', 'P2']);
  });
  await t.test('every committed invented input (the card-paid inputs carry the legacy no-call states), S3, S4, INVNR and OPU-next', t2 => {
    const ids = INPUTS.map(s => s.id);
    for (const id of ['s5-operating-plan-withheld', 's6-no-major-plans', 'S3', 'S4', 'INVNR', 'OPU-next', 'card-paid-clear']) assert.ok(ids.includes(id), id);
    expectBoth(readBoth(t2, INPUTS.map(s => [s.id, headOf(s.id)])), ZERO, 'every legitimate state');
  });
});

test('finite repair §6 row 3: each coherent named-limit witness reads its stated outcome, recorded by name', t => {
  // Each row is a NAMED LIMIT only because it reads 0 on both validators under
  // every adopted relationship (6560714968 §2): a coherent substitution that
  // no surviving record contradicts. The assertion records that outcome; it is
  // not proof of completeness. A nonzero reading would make the row BLOCKS.
  const base = headOf('savings-live-ready');
  const moved = pastK(base);
  const changed = Object.keys({ ...base, ...moved }).filter(k => !k.startsWith(C) && moved[k] !== base[k]).length;
  const rows = readBoth(t, [
    ['B1, the S10 limit (6559760944): month n, payday -, id -; M and M2 dropped', monthWitness(base, { month: 'n', monthPayday: '-', monthId: '-' }, ['M', 'M2'])],
    ['B3, the S10 limit: payday n; M2 dropped', monthWitness(base, { monthPayday: 'n' }, ['M2'])],
    ...['nnnn', 'ynnn', 'yyyn'].map(w => ['drilldown ' + w + ', the S10 limit (a reachable word); N1 and N2 dropped', drillWitness(base, w)]),
    ['C5: the next period\'s operatingPlanUnavailable set true, F dropped in its two states (no converse-F rule, per the ruling)', planUnavailableOn(base, 'next')],
    ...['past', 'next', 'future'].map(role => ['whole-period substitution: every itemized and capture key of the ' + role + ' period removed', wholePeriod(base, role)]),
    ['R-unavail past K1-K5: the one-key fake with the horizon, the plan keys, the current flag and the weekly cap also moved (' + changed + ' itemized keys)', moved],
    ['S3, R-raw one-directional: the withheld next view\'s rawPacket null→none, its null E dropped', setAnchor(dropSteps(headOf('S3'), (s, f) => s === 'E' && inNext(f)), NEXT, 'rawPacket', 'none')],
  ]);
  expectBoth(rows, ZERO, 'the named limits');
});

test('finite repair: outcomes no adopted disposition covers, recorded and reported to the desk (neither limits nor proofs)', t => {
  const base = headOf('savings-live-ready');
  // R-noplans binds plans by key presence (Atlas correction 3). Deleting every
  // planning.<id>.verdict key, and nothing else, with P1 dropped leaves the
  // other planning.<id>.* keys the collector emits beside each verdict
  // (figures-snapshot.js:522-541); no adopted rule binds them.
  const verdicts = Object.keys(base).filter(k => /^planning\.(.+)\.verdict$/.test(k));
  const noPlans = dropSteps(withoutKeys(base, k => verdicts.includes(k)), s => s === 'P1');
  const left = Object.keys(noPlans).filter(k => /^planning\.(?!trajectory\.)[^.]+\./.test(k)).length;
  // The C1 conversion with every Savings publication key also removed: the
  // whole funded record substituted (1 + the publication keys move).
  const pubs = Object.keys(base).filter(k => PUBLICATION_KEY.test(k)).length;
  const rows = readBoth(t, [
    ['R-noplans faked: the ' + verdicts.length + ' planning.<id>.verdict keys deleted and P1 dropped (' + left + ' other planning.<id>.* keys remain)', noPlans],
    ['whole-funding substitution: savings.funding.status and the ' + pubs + ' publication keys removed, the capture converted to the unfunded roster', withoutKeys(unfundedCapture(base), k => k === 'savings.funding.status' || PUBLICATION_KEY.test(k))],
  ]);
  // Recorded outcome, reported rather than hidden: both read 0 on both
  // validators.
  expectBoth(rows, ZERO, 'recorded outcomes');
});
