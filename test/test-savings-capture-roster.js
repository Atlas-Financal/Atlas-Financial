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
 *
 * Inputs: every committed invented input (test/fixtures/figures-inputs and
 * test/fixtures/savings-capture) and two PERTURBATIONS of savings-live-ready
 * (S3, S4), for which no frozen-fixture coverage is claimed. No household
 * input is read; nothing but test names and counts is printed. A page capture
 * takes up to about fifteen seconds: each input's default capture is made once
 * and shared by every test, and only 5(a) and 5(c)-(d) add a run, for the
 * inputs they name.
 *
 * Declared limits:
 *  - In every natural input the month surface calls budgetTrajectoryFor in
 *    the month state, so month 'none' (no call in this state) is shown only by
 *    a capture state-list witness (no page edit), not by a page state.
 *  - The omission witnesses edit the written evidence with fixed originals;
 *    with binding consistency they do not authenticate a coordinated
 *    replacement of every PR-written gate fact (the established limit).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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
const INPUTS = [...COMMITTED,
  { id: 'S3', doc: liveReady, corrupt: withholdNextPacket },
  { id: 'S4', doc: liveReady, corrupt: withholdTopLevel }];
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
// state only (Plan spend has a default state too).
test('S10 and inventory-gate prediction through the real anchors: 0 mismatches over every committed invented input, S3 and S4', () => {
  const mismatches = [];
  const wants = new Map();
  for (const s of INPUTS) {
    const cap = captureOf(s.id);
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
        check('R-M', has(R.month), funded && g.month === 'y');
        check('R-M2', has(R.fundingPlan), has(R.month) && g.monthPayday === 'y');
        const rm = obs.find(o => o.route === R.month);
        if (rm) check('monthId', g.monthId, rm.result && typeof rm.result === 'object' ? 'pub' : 'fallback');
      } else if (st.id === 'drilldown') {
        const gate = funded && g.drilldown === 'yyyy';
        check('R-N1', has(R.fundingPlan), gate);
        check('R-N2', has(R.shortfall), gate);
      } else {
        const top = !!a && a.top === 'object';
        const cal = g.calendar === 'yyyyyyyy';
        const sel = (/^period:(.+)\/lens:/.exec(st.id) || [])[1] || 'this-pay-period';
        const v = a && a.views.find(x => x.id === sel);
        const cur = !!v && v.role === 'current';
        const views = obs.filter(o => o.route === R.dailyHtml && /(?:^|,)period=view:/.test(o.context));
        check('D', has(R.q), top && cal);
        // Step 6: current, the first period=view call on the top-level
        // result; non-current, the raw packet (other-object).
        const step6 = cur ? views.length > 0 && /\.savingsFunding$/.test(views[0].source) : views.some(o => o.source === 'other-object');
        check('E', step6, cal && g.dailyAsOf === 'y' && (cur ? top : !!v && v.rawPacket !== 'none'));
        const ri = obs.find(o => o.route === R.goals);
        const step11 = cur ? views.length > 1 : views.some(o => /^result#\d+$/.test(o.source));
        check('J', step11, !!(ri && ri.result) && g.inventory === 'y');
        const rg = obs.find(o => o.route === R.upcoming && /(?:^|,)periodId=null/.test(o.context));
        check('K', obs.some(o => o.route === R.dailyHtml && /(?:^|,)advice=/.test(o.context)), !!(rg && rg.result) && g.inventory === 'y');
      }
    }
  }
  assert.deepEqual(mismatches, [], 'every route is present exactly when its gate facts predict it');
  for (const name of ['R-M', 'R-M2', 'R-N1', 'R-N2', 'D', 'E', 'J', 'K']) {
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
  for (const [what, head] of [
    ['one gate line deleted (renumbered, count adjusted)', withoutGate(base, 'default')],
    ['calendar flipped to n... where D and E are observed', withGate(base, 'default', 'calendar', 'n' + g.calendar.slice(1))],
    ['dailyAsOf flipped where E is observed (step 6\'s own equality)', withGate(base, 'default', 'dailyAsOf', 'n')],
    ['inventory flipped y→n where J and K are observed', withGate(base, 'default', 'inventory', 'n')],
    ['month flipped y→n with R-M observed', withGate(base, 'granularity:month', 'month', 'n')],
    ['monthPayday flipped y→n with R-M2 observed', withGate(base, 'granularity:month', 'monthPayday', 'n')],
    ['drilldown yyyn with N1/N2 observed', withGate(base, 'drilldown', 'drilldown', 'yyyn')],
    ['monthId other with R-M present', withGate(base, 'granularity:month', 'monthId', 'other')],
  ]) assert.ok(problems(head) > 0, what);
});

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
  const hooked = new Set();
  const realmOf = value => (value && typeof value === 'object' ? Object.getPrototypeOf(value) : null);
  const extra = {
    recommend: inPage => function observedRecommend(...args) {
      if (budgetRealm === null) budgetRealm = realmOf(args[0]);
      if (realmOf(args[0]) === budgetRealm) rec.budgetStates++;
      const pageGlobal = inPage.constructor('return this')();
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
  const capture = inRealms(s, extra, () => Capture.capturePages(...pageInput(s), ROOT, states ? { states } : {}));
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
// without it, with no overlapping period, and with no pay periods at all.
const RECORDED = ['savings-live-ready', 's1-historical-pools', 'savings-deficit-cover', 'S4',
  'card-paid-clear', 'card-paid-held', 'opening-gap-funded', 'opening-gap-unfunded'];
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
    // Every natural input reaches both surfaces (no natural 'none' case).
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
  const isJ = (f, list) => f[2] === R.dailyHtml && /period=view/.test(f[4]) && !isE(f, list);
  for (const [what, head] of [
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
  ]) assert.ok(problems(head) > 0, what);
  // Itemized coherence, each edit isolated on an otherwise valid record.
  const legacy = headOf('card-paid-clear');
  assert.equal(typeof legacy['savings.funding.status'], 'undefined', 'card-paid-clear is unfunded');
  const pastDate = Object.keys(legacy).map(k => /^period\.(\d{4}-\d{2}-\d{2})\.timelineRole$/.exec(k)).find(m => m && legacy[m[0]] === 'past')[1];
  const funded = base, s3 = headOf('S3');
  const pubDate = Object.keys(funded).map(k => /^savings\.period\.(\d{4}-\d{2}-\d{2})\.publication$/.exec(k)).find(m => m && funded[m[0]] === 'published')[1];
  const withheld = Object.keys(s3).find(k => /^savings\.period\.[^.]+\.publication$/.test(k) && s3[k] === 'withheld');
  assert.ok(withheld, 'S3 withholds one period');
  const without = (h, k) => { const o = { ...h }; assert.ok(k in o, k); delete o[k]; return o; };
  for (const [what, head] of [
    ['unfunded with a Savings publication key', { ...legacy, ['savings.period.' + pastDate + '.publication']: 'withheld' }],
    ['a period without its role', without(legacy, 'period.' + pastDate + '.role')],
    ['a period whose role and timelineRole disagree', { ...legacy, ['period.' + pastDate + '.role']: 'future' }],
    ['a funded period without its publication', without(funded, 'savings.period.' + pubDate + '.publication')],
    ['a publication for no itemized period', { ...funded, 'savings.period.1999-01-01.publication': 'withheld' }],
    ['a published packet without its status', without(funded, 'savings.period.' + pubDate + '.status')],
    ['a withheld publication carrying a packet key', { ...s3, [withheld.replace(/publication$/, 'status')]: 'ready' }],
    ['an unknown publication word', { ...funded, ['savings.period.' + pubDate + '.publication']: 'partial' }],
  ]) assert.ok(problems(head) > 0, what);
});
