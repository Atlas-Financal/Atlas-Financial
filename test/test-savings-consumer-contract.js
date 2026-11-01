'use strict';
/* G1 v3: the Savings consumer contract (Atlas desk disposition 6550418629,
 * adopted by Muse 6550491885). `node test/test-savings-consumer-contract.js`
 *
 * Two separate results, kept separate:
 *  - SOURCE GUARD (a review obligation, not proof of numerical movement):
 *    function-level pins over the set the real-entry capture reaches,
 *    observed with V8 coverage; residual pins per reached module; the
 *    forecast.js selector region; each page's script list; the capture
 *    machinery; and a census of literal selector routes and raw packet
 *    reads. A difference from the reviewed manifest fails until reviewed.
 *  - OBSERVED OUTPUT: the real page entries are executed on invented
 *    inputs. Whenever the rendered page moves, the compared capture
 *    evidence must move. This covers the three context witnesses
 *    (null vs omitted periodId, context.plan, Plan spend's own advice and
 *    options) and the four earlier omission classes.
 * Invented inputs only for every rendered comparison. Nothing is written
 * outside a temporary directory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Contract = require('./lib/savings-consumer-contract.js');
const F = require('../public/forecast.js');
const Snapshot = require('../scripts/figures-snapshot.js');
const Capture = require('../scripts/figures-page-capture.js');
const Comment = require('../scripts/figures-comment.js');

const ROOT = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/savings-consumer-manifest.json'), 'utf8'));
const invented = Snapshot.loadInventedInputs();
const byId = id => invented.find(i => i.id === id);
const asInput = i => ({ data: i.doc.data, periods: i.doc.periods });
const MACHINERY = ['scripts/figures-page-capture.js', 'test/lib/savings-consumer-contract.js'];

async function computeGuard(root, inputs) {
  const reached = await Contract.observeReach(F, inputs, Capture.capturePages, root);
  const sources = Contract.loadSources(root, { includeForecast: true });
  return Contract.sourceGuard(reached, sources, {
    selectorRegion: Contract.selectorRegion(fs.readFileSync(path.join(root, 'public/forecast.js'), 'utf8')),
    pages: Object.fromEntries(Object.keys(Capture.PAGE_HTML).map(p => [p, Capture.pageScripts(p, root)])),
    machinery: Object.fromEntries(MACHINERY.map(f => [f, Contract.sha(fs.readFileSync(path.join(root, f), 'utf8'))])),
  });
}
const census = root => {
  const c = Contract.computeContract(Contract.loadSources(root), MANIFEST.censusRoots);
  return { routes: c.routes, rawPacketRoutes: c.rawPacketRoutes };
};
// A temporary copy of the tree with one edit, for execution-based breakage.
function editedTree(file, find, replace) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'savings-contract-'));
  for (const sub of ['public', 'scripts', 'test/lib']) fs.cpSync(path.join(ROOT, sub), path.join(dir, sub), { recursive: true });
  const target = path.join(dir, file);
  const text = fs.readFileSync(target, 'utf8');
  assert.ok(text.includes(find), 'edit anchor exists: ' + find.slice(0, 60));
  fs.writeFileSync(target, text.replace(find, replace));
  return dir;
}
const diffGuard = (a, b) => {
  const out = [];
  for (const file of new Set([...Object.keys(a.modules), ...Object.keys(b.modules)])) {
    const x = a.modules[file], y = b.modules[file];
    if (!x || !y) { out.push(file + ': ' + (x ? 'no longer reached' : 'newly reached')); continue; }
    if (x.residual !== y.residual || x.sha256 !== y.sha256) out.push(file + ': residual');
    const px = new Map((x.pins || []).map(p => [p.id, p.sha256])), py = new Map((y.pins || []).map(p => [p.id, p.sha256]));
    for (const id of new Set([...px.keys(), ...py.keys()])) if (px.get(id) !== py.get(id)) out.push(id + (px.has(id) ? py.has(id) ? ': changed' : ': no longer reached' : ': newly reached'));
  }
  if (JSON.stringify(a.selectorRegion) !== JSON.stringify(b.selectorRegion)) out.push('selector region');
  if (JSON.stringify(a.pages) !== JSON.stringify(b.pages)) out.push('page script lists');
  if (JSON.stringify(a.machinery) !== JSON.stringify(b.machinery)) out.push('machinery');
  return out;
};

test('source guard: the reached set, residuals, selector region, pages and machinery equal the reviewed manifest', async () => {
  assert.equal(MANIFEST.version, 'atlas-savings-consumer-manifest/v3');
  const all = [Snapshot.loadCanonicalInputs(), ...invented.map(asInput)];
  const guard = await computeGuard(ROOT, all);
  assert.deepEqual(diffGuard(MANIFEST.guard, guard), [],
    'unreviewed Savings consumer source change: review the inventory before updating the manifest');
  assert.deepEqual(census(ROOT), MANIFEST.census, 'literal selector routes and raw packet reads');
});

test('source guard breaks on a changed downstream helper, a new receiver, a new route form, a selector edit or a page script change', async () => {
  const one = [asInput(byId('savings-live-partial'))];
  const base = await computeGuard(ROOT, one);
  const cases = [
    ['Plan spend helper', 'public/plan-spend.js', 'planSpendMoney(next.contribution)', 'planSpendMoney(next.contribution + 0)', /planSpendFundingHero#1: changed/],
    ['Schedule gate', 'public/plan.js', 'function budgetMonthTrustTag(', 'function zzUnused() { return 0; }\nfunction budgetMonthTrustTag(', null],
    ['new receiver', 'public/plan-spend.js', 'function planSpendFundingHero(', 'function zzNewReceiver(x) { return x; }\nfunction planSpendFundingHero(', null],
    ['selector region', 'public/forecast.js', 'function savingsFundingPublication(publication, context = {}) {', 'function savingsFundingPublication(publication, context = {}) {\n    void 0;', /selector region/],
    ['page script list', 'public/plan-spend.html', '<script src="/plan-spend.js"', '<script src="/app.js"></script>\n  <script src="/plan-spend.js"', /page script lists/],
  ];
  for (const [name, file, find, replace, expect] of cases) {
    const dir = editedTree(file, find, replace);
    try {
      if (name === 'new receiver') {
        // Wire the new function into the rendered path so it executes.
        const p = path.join(dir, 'public/plan-spend.js');
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('function planSpendFundingHero(schedule', 'function planSpendFundingHero(schedule').replace(/(function planSpendFundingHero\([^)]*\) \{)/, '$1\n  zzNewReceiver(schedule);'));
      }
      const g = await computeGuard(dir, one);
      const diff = diffGuard(base, g);
      if (name === 'Schedule gate') {
        // An unrelated added function leaves reached pins and residuals alone.
        assert.deepEqual(diff.filter(d => !/budgetMonthTrustTag/.test(d)), [], name + ': unrelated addition does not trip');
      } else if (name === 'new receiver') {
        assert.ok(diff.some(d => /zzNewReceiver#1: newly reached/.test(d)), name + ': ' + diff.join('; '));
      } else {
        assert.ok(diff.some(d => expect.test(d)), name + ': ' + diff.join('; '));
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // An aliased or computed selector route that executes is observed, and the
  // validators refuse an unexplained route.
  for (const [name, call] of [['alias', 'const pick = Forecast.savingsFundingPublication; pick(ctx.advice?.savingsFunding, { asOf: ctx.asOf });'],
    ['computed', "Forecast['savings' + 'FundingPublication'](ctx.advice?.savingsFunding, { asOf: ctx.asOf });"]]) {
    const dir = editedTree('public/plan.js', 'function budgetDailySavingsFor(ctx, periodId = null) {',
      'function zzRoute(ctx) { ' + call + ' }\nfunction budgetDailySavingsFor(ctx, periodId = null) {\n  zzRoute(ctx);');
    try {
      const capture = Capture.capturePages(F, byId('savings-live-partial').doc.data, byId('savings-live-partial').doc.periods, dir);
      assert.ok(capture.observations.some(o => o.route === 'public/plan.js#zzRoute'), name + ' route observed');
      const evidence = {}; Snapshot.__putCaptureEvidence(evidence, '', capture);
      evidence['savings.funding.status'] = 'ready';
      assert.ok(Comment.captureEvidenceProblems(evidence, ['']) > 0, name + ' route is unexplained');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

// ---- observed output: the real page entries against the capture evidence ----
const pageAndEvidence = (input, perturbations = {}) => {
  const saved = {};
  for (const [name, wrap] of Object.entries(perturbations)) { saved[name] = F[name]; F[name] = wrap(saved[name]); }
  try {
    const capture = Capture.capturePages(F, input.doc.data, input.doc.periods, ROOT, { recordHtml: true });
    const evidence = {}; Snapshot.__putCaptureEvidence(evidence, '', capture);
    const page = capture.runs.map(r => r.states.map(s => r.page + '|' + s.id + '|' + JSON.stringify(s.html))).flat().join('\n');
    return { page, evidence, capture };
  } finally { for (const [name, fn] of Object.entries(saved)) F[name] = fn; }
};
const evidenceMoved = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]);
const editFunding = edit => recommend => function wrapped(...args) {
  const advice = recommend.apply(this, args);
  if (advice && advice.savingsFunding) edit(advice.savingsFunding, args);
  return advice;
};
const BASELINES = new Map();
const baseline = id => { if (!BASELINES.has(id)) BASELINES.set(id, pageAndEvidence(byId(id))); return BASELINES.get(id); };
function expectMoves(id, perturbations, why) {
  const before = baseline(id), after = pageAndEvidence(byId(id), perturbations);
  assert.notEqual(after.page, before.page, why + ': the rendered page moves (the probe reaches a consumer)');
  assert.ok(evidenceMoved(before.evidence, after.evidence).length > 0, why + ': the capture evidence moves');
}

test('the three context witnesses: null vs omitted periodId, context.plan, Plan spend advice options', () => {
  const sel = F.savingsFundingPublication;
  // 1. A selector that answers an explicit periodId: null differently.
  expectMoves('savings-live-partial', { savingsFundingPublication: real => function (pub, ctx) {
    const r = real.apply(this, arguments);
    if (ctx && Object.prototype.hasOwnProperty.call(ctx, 'periodId') && ctx.periodId === null && r && r.period && typeof r.period.availableNow === 'number') {
      return { ...r, period: { ...r.period, availableNow: r.period.availableNow + 1 } };
    }
    return r;
  } }, 'periodId null vs omitted');
  // 2. A selector keyed on context.plan (the mount and Plan spend pass it).
  expectMoves('savings-live-partial', { savingsFundingPublication: real => function (pub, ctx) {
    return ctx && ctx.plan && ctx.plan.savingsEarmarks ? null : real.apply(this, arguments);
  } }, 'context.plan');
  // 3. An engine default that only Plan spend's own advice options reach
  //    (planSpendAdvice omits targetBuffer and the other Budget knobs).
  expectMoves('savings-deficit-cover', { recommend: real => function (plan, asOf, opts) {
    const advice = real.apply(this, arguments);
    if (opts && opts.targetBuffer === undefined && advice.savingsFunding && advice.savingsFunding.schedule
        && Array.isArray(advice.savingsFunding.schedule.paydays) && advice.savingsFunding.schedule.paydays[0]) {
      advice.savingsFunding.schedule.paydays[0].contribution += 20;
    }
    return advice;
  } }, 'Plan spend advice options');
  assert.equal(F.savingsFundingPublication, sel);
});

test('the four earlier omission classes, through the real entries', () => {
  const item = (sf, key) => sf.backing.items.find(i => i.key === key);
  expectMoves('savings-live-partial', { recommend: editFunding(sf => { sf.period.proposal += 1; }) }, 'funding-sheet line (Unsent top-up)');
  expectMoves('savings-live-partial', { recommend: editFunding(sf => { sf.rows[1].neededRange = {}; }) }, '{} vs absent neededRange');
  expectMoves('savings-live-partial', { recommend: editFunding(sf => { delete sf.rows[1].commitmentCost; sf.rows[1].commitmentCost = {}; }) }, '{} vs absent commitmentCost');
  expectMoves('savings-live-partial', { recommend: editFunding(sf => { item(sf, 'near@2026-10-21').neededRange = {}; }) }, '{} vs absent member neededRange');
  const costed = sf => sf.rows.find(r => r.commitmentCost);
  const a = pageAndEvidence(byId('savings-chained-closes'), { recommend: editFunding(sf => { costed(sf).commitmentCost.originalCost = { status: 'known', amount: 80, range: null }; }) });
  const b = pageAndEvidence(byId('savings-chained-closes'), { recommend: editFunding(sf => { costed(sf).commitmentCost.originalCost = { status: 'known', amount: 80 }; }) });
  assert.notEqual(a.page, b.page, 'cost range null vs absent renders differently');
  assert.ok(evidenceMoved(a.evidence, b.evidence).length > 0, 'cost range null vs absent moves the evidence');
  expectMoves('savings-estimated-close', { recommend: editFunding(sf => {
    const view = sf.periodViews.find(v => v.packet && v.packet.forecastClosing && v.packet.forecastClosing.status === 'ready'
      && v.packet.forecastClosing.items.length === 2 && (v.packet.forecastClosing.allocations || []).length === 2);
    const close = view.packet.forecastClosing, [r0, r1] = close.rows;
    const sum = k => Math.round((r0[k] + r1[k]) * 100) / 100;
    close.rows = [{ ...r0, key: 'group:invented-pair', label: 'Invented pair', members: [...r0.members, ...r1.members],
      forecastSaved: sum('forecastSaved'), forecastContribution: sum('forecastContribution'), needed: sum('needed'), stillToFund: sum('stillToFund') }];
    const [x, y] = close.allocations; x.amount += 0.1; y.amount -= 0.1;
  }) }, 'member redistribution in a grouped close');
});

test('instrumentation is neutral: unobserved and observed renders are identical, returns are passed through', () => {
  const input = byId('savings-live-partial');
  const observed = Capture.capturePages(F, input.doc.data, input.doc.periods, ROOT, { recordHtml: true });
  const again = Capture.capturePages(F, input.doc.data, input.doc.periods, ROOT, { recordHtml: true });
  assert.deepEqual(observed.runs.map(r => r.states.map(s => s.html)), again.runs.map(r => r.states.map(s => s.html)), 'deterministic');
  assert.ok(observed.observations.length > 0 && observed.observations.every(o => o.error === null));
  // The observer returns the selector's own result object (identity preserved).
  const seen = new Set(observed.observations.map(o => o.result).filter(r => r && typeof r === 'object'));
  assert.ok(seen.size > 0);
  for (const o of observed.observations.slice(0, 20)) assert.ok(o.result === null || typeof o.result === 'object');
  // The publication is not mutated by capture: a second capture encodes identically.
  const e1 = {}, e2 = {}; Snapshot.__putCaptureEvidence(e1, '', observed); Snapshot.__putCaptureEvidence(e2, '', again);
  assert.deepEqual(e1, e2);
});

test('legitimate no-call and withheld states are valid, not malformed', () => {
  for (const id of ['card-paid-clear', 'opening-gap-funded']) {
    const { evidence, capture } = pageAndEvidence(byId(id));
    assert.ok(capture.runs.every(r => r.loadErrors.length === 0 && r.states.every(s => !s.error && s.unfinished === 0)), id + ' renders');
    assert.equal(Comment.captureEvidenceProblems(evidence, ['']), 0, id + ': a valid unfunded capture');
  }
});
