'use strict';
/* G1 v3: the Savings consumer contract (Atlas desk disposition 6550418629,
 * adopted by Muse 6550491885; guard rule Muse 6550973450; model repairs Atlas
 * 6552087494, adopted by Muse 6552134028).
 * `node test/test-savings-consumer-contract.js`
 *
 * Two separate results, kept separate:
 *  - SOURCE GUARD (a review obligation, not proof of numerical movement):
 *    the forecast.js selector region plus function-level pins over the
 *    execution-reached set of every module (V8 coverage of the real-entry
 *    capture), a residual pin per reached module, whole-module pins where
 *    reach cannot be established, each page's script list and HTML bytes,
 *    the serving, capture, collector, writer, validator, poster and guard
 *    machinery (including server.js and this comparator), and a census of
 *    literal selector routes and raw packet reads (routes and rawPacketRoutes). A difference from the
 *    reviewed manifest fails until reviewed. It also replays the loading,
 *    wrapper-syntax, export, literal and declared-limit witnesses.
 *  - OBSERVED OUTPUT: the real page entries are executed on invented
 *    inputs, with the page's own Forecast in the page realm. Whenever the
 *    rendered page moves, the compared capture evidence must move. This
 *    covers the three context witnesses, the four earlier omission classes
 *    and the scheduled-amount realm witness; instrumented and uninstrumented
 *    same-realm renders are identical.
 * Invented inputs only for every rendered comparison. Nothing is written
 * outside a temporary directory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Contract = require('./lib/savings-consumer-contract.js');
const Snapshot = require('../scripts/figures-snapshot.js');
const Capture = require('../scripts/figures-page-capture.js');
const Comment = require('../scripts/figures-comment.js');

const ROOT = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/savings-consumer-manifest.json'), 'utf8'));
const invented = Snapshot.loadInventedInputs();
const byId = id => invented.find(i => i.id === id);
const asInput = i => ({ data: i.doc.data, periods: i.doc.periods });
const computeGuard = (root, inputs) => Contract.computeGuard(root, inputs);
const census = root => {
  const c = Contract.computeContract(Contract.loadSources(root), MANIFEST.censusRoots);
  return { routes: c.routes, rawPacketRoutes: c.rawPacketRoutes };
};
// A temporary copy of the tree with one edit, for execution-based breakage.
function editedTree(file, find, replace) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'savings-contract-'));
  for (const sub of ['public', 'scripts', 'test/lib', '.github/workflows', 'server.js', 'test/test-savings-consumer-contract.js']) {
    fs.cpSync(path.join(ROOT, sub), path.join(dir, sub), { recursive: true });
  }
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
    if (x.mode !== y.mode) out.push(file + ': mode ' + x.mode + ' -> ' + y.mode);
    if (x.residual !== y.residual || x.sha256 !== y.sha256) out.push(file + ': ' + (x.mode === 'module' ? 'module' : 'residual'));
    if (JSON.stringify(x.deferred || []) !== JSON.stringify(y.deferred || [])) out.push(file + ': deferred callbacks');
    const px = new Map((x.pins || []).map(p => [p.id, p.sha256])), py = new Map((y.pins || []).map(p => [p.id, p.sha256]));
    for (const id of new Set([...px.keys(), ...py.keys()])) if (px.get(id) !== py.get(id)) out.push(id + (px.has(id) ? py.has(id) ? ': changed' : ': no longer reached' : ': newly reached'));
  }
  if (JSON.stringify(a.selectorRegion) !== JSON.stringify(b.selectorRegion)) out.push('selector region');
  for (const page of new Set([...Object.keys(a.pages || {}), ...Object.keys(b.pages || {})])) {
    const x = (a.pages || {})[page] || {}, y = (b.pages || {})[page] || {};
    if (JSON.stringify(x.scripts) !== JSON.stringify(y.scripts)) out.push(page + ': page script list');
    if (x.html !== y.html) out.push(page + ': page HTML');
  }
  for (const f of new Set([...Object.keys(a.machinery || {}), ...Object.keys(b.machinery || {})])) {
    if ((a.machinery || {})[f] !== (b.machinery || {})[f]) out.push('machinery: ' + f);
  }
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
  // Each case runs on an input whose declared executions reach the edited
  // code (the withheld From-today producer runs on savings-estimated-close).
  const bases = new Map();
  const baseFor = async id => { if (!bases.has(id)) bases.set(id, await computeGuard(ROOT, [asInput(byId(id))])); return bases.get(id); };
  const cases = [
    ['Plan spend helper', 'public/plan-spend.js', 'planSpendMoney(next.contribution)', 'planSpendMoney(next.contribution + 0)', /planSpendFundingHero#1: changed/],
    ['Schedule gate', 'public/plan.js', 'function budgetMonthTrustTag(', 'function zzUnused() { return 0; }\nfunction budgetMonthTrustTag(', null],
    ['new receiver', 'public/plan-spend.js', 'function planSpendFundingHero(', 'function zzNewReceiver(x) { return x; }\nfunction planSpendFundingHero(', null],
    ['selector region', 'public/forecast.js', 'function savingsFundingPublication(publication, context = {}) {', 'function savingsFundingPublication(publication, context = {}) {\n    void 0;', /selector region/],
    ['page script list', 'public/plan-spend.html', '<script src="/plan-spend.js"', '<script src="/budget-polish.js"></script>\n  <script src="/plan-spend.js"', /planSpend: page script list/],
    ['page HTML bytes', 'public/plan-spend.html', '<title>Household finances — plan spend</title>', '<title>Household finances  — plan spend</title>', /planSpend: page HTML/],
    // The export table and a module-scope binding are outside every function
    // definition: the residual pin covers them (Atlas 6552087494 item 5).
    ['export table', 'public/forecast.js', '    recommendWeekly, recommend, incomeDeadline,', '    recommendWeekly, recommend, zzExportAlias: recommend, incomeDeadline,', /public\/forecast\.js: residual/],
    // A DOM-driven module the capture cannot execute is pinned whole, so an
    // edit inside its unexecuted painter is caught (pre-review F6).
    ['DOM-driven painter', 'public/budget-blend.js', "    card.classList.add('tile', 't-goals');", "    card.classList.add('tile', 't-goals', 'zz');", /public\/budget-blend\.js: module/],
    ['DOM-driven anonymous wrapper', 'public/budget-blend.js', '(function blendBudget() {', '(function () {', /public\/budget-blend\.js: module/],
    // Declared limits (Atlas 6552087494; Muse 6552134028): their producer and
    // consumer source is guarded even though their values are not captured.
    ['F1 producer (current fromTodayFunding)', 'public/forecast.js', 'current.fromTodayFunding = { status: forward.status, asOf,', 'current.fromTodayFunding = { status: forward.status, asOf, zzWitness: 1,', /forecast\.js#publishBudgetPeriodFundingCore#1: changed/],
    ['F1 producer (withheld fromTodayFunding)', 'public/forecast.js', 'if (period.start <= asOf && period.end >= asOf) period.fromTodayFunding = {', 'if (period.start <= asOf && period.end >= asOf) period.fromTodayFunding = { zzWitness: 1,', /forecast\.js#withholdBudgetPeriodFunding#1: changed/, 'savings-estimated-close'],
    ['F1 consumer (From-today evidence)', 'public/plan.js', 'function calendarFromTodayEvidenceHtml(period, plan) {', 'function calendarFromTodayEvidenceHtml(period, plan) {\n  void 0;', /plan\.js#calendarFromTodayEvidenceHtml#1: changed/],
    ['F1 consumer (Today card)', 'public/plan.js', 'const today = current && current.fromTodayFunding;', 'const today = current && current.fromTodayFunding || undefined;', /plan\.js#budgetTodayCashCardHtml#1: changed/],
    ['F1 consumer (Costs ahead)', 'public/plan.js', 'const today = current?.fromTodayFunding;', 'const today = current?.fromTodayFunding || undefined;', /plan\.js#budgetUpcomingFundingHtml#1: changed/],
    ['F5 producer (afterProposedFunding)', 'public/forecast.js', 'afterProposedFunding: roundCent(b.period.balanceAfterDeductions - row.contribution', 'afterProposedFunding: roundCent(b.period.balanceAfterDeductions + 7 - row.contribution', /forecast\.js#publishBudgetPeriodFundingCore#1: changed/],
    ['F5 consumer (Balance After Deductions)', 'public/plan.js', 'fundedBalanceKnown ? funding.afterProposedFunding', 'fundedBalanceKnown ? funding.afterProposedFunding + 0', /plan\.js#calendarWaterfallHtml#1: changed/],
    ['pools gate consumer (compact stock)', 'public/plan.js', 'savingsInventory?.pools?.length === 2', 'savingsInventory?.pools?.length >= 2', /plan\.js#calendarWaterfallHtml#1: changed/],
    ['F1 consumer (spending section)', 'public/plan.js', "funding = period.timelineRole === 'current' ? period.fromTodayFunding : null;", "funding = period.timelineRole === 'current' ? period.fromTodayFunding || undefined : null;", /plan\.js#budgetSpendingSectionHtml#1: changed/],
    ['F1 consumer (calendar waterfall)', 'public/plan.js', '  </div>`;\n  const today = period.fromTodayFunding;\n  const todayHtml', '  </div>`;\n  const today = period.fromTodayFunding || undefined;\n  const todayHtml', /plan\.js#calendarWaterfallHtml#1: changed/],
    ['F5 consumer (Balance After Deductions timeline)', 'public/plan.js', 'function badTimelineHtml(advice, compactOverview, savingsContext) {', 'function badTimelineHtml(advice, compactOverview, savingsContext) {\n  void 0;', /plan\.js#badTimelineHtml#1: changed/],
    // The served page and the evidence writer are machinery (pre-review
    // 6553590628 B-2, S-5): an edit to either is a guard change.
    ['served-page transform', 'server.js', "  .replace('Running build unavailable', RunningBuild.label(__dirname, runningBuildSha));", "  .replace('Running build unavailable', RunningBuild.label(__dirname, runningBuildSha)).replace('</body>', '</body>');", /machinery: server\.js/],
    ['evidence writer', 'scripts/ci-output.js', "'use strict';", "'use strict';\nvoid 0;", /machinery: scripts\/ci-output\.js/],
    // An assigned property handler is a deferred registration too (S-4).
    ['property handler', 'public/budget-surface.js', "'use strict';", "'use strict';\nif (typeof document !== 'undefined' && document.body) document.body.onclick = function zzPaint() { return 1; };", /public\/budget-surface\.js: (mode|deferred)/],
  ];
  for (const [name, file, find, replace, expect, inputId = 'savings-live-partial'] of cases) {
    const one = [asInput(byId(inputId))];
    const base = await baseFor(inputId);
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
      const capture = Capture.capturePages(byId('savings-live-partial').doc.data, byId('savings-live-partial').doc.periods, dir);
      assert.ok(capture.observations.some(o => o.route === 'public/plan.js#zzRoute<public/plan.js#budgetDailySavingsFor'), name + ' route observed');
      const input = byId('savings-live-partial').doc;
      const head = { ...Snapshot.buildFiguresSnapshot(input.data, input.periods) };
      Snapshot.__putCaptureEvidence(head, '', capture);
      const clean = { ...Snapshot.buildFiguresSnapshot(input.data, input.periods) };
      Snapshot.__putCaptureEvidence(clean, '', Capture.capturePages(input.data, input.periods, ROOT));
      assert.equal(Comment.captureEvidenceProblems(clean, ['']), 0, 'the unedited capture is valid');
      assert.ok(Comment.captureEvidenceProblems(head, ['']) > 0, name + ' route is unexplained');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // Every script element is accounted for: an unsupported form fails closed
  // instead of silently loading less than the browser (pre-review F2).
  const tag = '<script src="/plan-spend.js"></script>';
  for (const [name, replacement] of [
    ['query string', '<script src="/plan-spend.js?v=2"></script>'],
    ['single quotes', "<script src='/plan-spend.js'></script>"],
    ['relative path', '<script src="plan-spend.js"></script>'],
    ['extra attribute', '<script defer src="/plan-spend.js"></script>'],
    ['module', '<script type="module" src="/plan-spend.js"></script>'],
    ['added versioned script', tag + '\n<script src="/zz-extra.js?v=1"></script>'],
    ['inline script', tag + '\n<script>window.zz = 1;</script>'],
    ['unterminated', tag + '\n<script src="/zz.js">'],
    ['commented script', tag + '\n<!-- <script src="/zz-hidden.js"></script> -->'],
    ['inline event handler', tag + '\n<img src="x" onerror="void 0">'],
  ]) {
    const dir = editedTree('public/plan-spend.html', tag, replacement);
    try {
      assert.throws(() => Capture.pageScripts('planSpend', dir), /unsupported|unterminated/, name + ' fails closed');
      assert.throws(() => Capture.capturePages(byId('savings-live-partial').doc.data, byId('savings-live-partial').doc.periods, dir), /page capture/, name + ': the capture refuses to run');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // A script the page creates or imports at runtime is a load error, even
  // when the page catches the failure itself (pre-review 6553590628 S-3).
  for (const [name, code, expect] of [
    ['runtime script element', "try { document.createElement('script'); } catch (e) {}", /runtime load: script element/],
    ['runtime import', "import('/zz-module.js').catch(() => {});", /dynamic import is unsupported/],
  ]) {
    const dir = editedTree('public/plan-spend.js', "'use strict';", "'use strict';\n" + code);
    try {
      const capture = Capture.capturePages(byId('savings-live-partial').doc.data, byId('savings-live-partial').doc.periods, dir);
      assert.ok(capture.runs.find(r => r.page === 'planSpend').loadErrors.some(e => expect.test(e)), name + ' is a load error');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('source guard: protection does not depend on wrapper syntax; literals are exact; data and exports are residual', () => {
  const guardOf = (src, reachedNames, deferred) => {
    const ranges = [[0, src.length]];
    const wrapperStart = src.indexOf('function');
    ranges.push([wrapperStart, src.lastIndexOf('}') + 1]);
    for (const name of reachedNames) {
      const at = src.indexOf('function ' + name + '(');
      ranges.push([at, src.indexOf('}', at) + 1]);
    }
    const reach = { reached: new Map([['public/zz.js', ranges]]), deferred: new Map(deferred ? [['public/zz.js', new Set(deferred)]] : []) };
    return Contract.sourceGuard(reach, { 'public/zz.js': src }, {}).modules['public/zz.js'];
  };
  const body = "\n  const LIMIT = 0.5;\n  function paint(x) { return x > LIMIT ? 'a  b' : 'c'; }\n  function boot() { return 1; }\n  const Api = { boot };\n  root.Api = Api;\n  boot();\n";
  const named = '(function blend(root) {' + body + '})(this);\n';
  const anonymous = '(function (root) {' + body + '})(this);\n';
  const a = guardOf(named, ['boot']), b = guardOf(anonymous, ['boot']);
  // The wrapper's own header text differs, so the residual digests differ;
  // what is pinned, and every verdict below, is the same for both.
  assert.equal(a.mode, b.mode); assert.deepEqual(a.pins, b.pins, 'named and anonymous wrappers pin the same definitions');
  assert.deepEqual(a.pins.map(p => p.id), ['public/zz.js#boot#1']);
  const edit = (src, find, repl) => src.replace(find, repl);
  for (const src of [named, anonymous]) {
    const base = guardOf(src, ['boot']);
    assert.notEqual(guardOf(edit(src, 'const Api = { boot };', 'const Api = { boot, zz: boot };'), ['boot']).residual, base.residual, 'export table edit');
    assert.notEqual(guardOf(edit(src, 'const LIMIT = 0.5;', 'const LIMIT = 0.6;'), ['boot']).residual, base.residual, 'module-scope data edit');
    assert.notEqual(guardOf(edit(src, '  boot();', '  boot ()\n;'), ['boot']).residual, base.residual, 'a line break in code is significant');
    assert.equal(guardOf(edit(src, '  boot();', '      boot();'), ['boot']).residual, base.residual, 'indentation in code is not');
    assert.equal(guardOf(edit(src, 'root.Api = Api;', 'root.Api  =  Api;'), ['boot']).residual, base.residual, 'nor is a run of spaces');
    // The unexecuted painter is the declared unexecuted-path limit in a
    // function-level module, identically for both wrappers...
    assert.deepEqual(guardOf(edit(src, "'a  b'", "'a b'"), ['boot']), base, 'unexecuted helper: declared limit');
    // ...and a whole-module pin once the module registers callbacks the
    // capture never invokes, again identically for both wrappers.
    const whole = guardOf(src, ['boot'], ['mutation-observer']);
    assert.equal(whole.mode, 'module');
    assert.notEqual(guardOf(edit(src, "'a  b'", "'a b'"), ['boot'], ['mutation-observer']).sha256, whole.sha256, 'string edit in a DOM-driven module');
  }
  // Whitespace inside a literal is exact; outside it is normalised.
  const lit = t => { const l = new Uint8Array(t.length); Contract.mask(t, l); return Contract.normaliseCode(t, l); };
  assert.notEqual(lit("x = 'a  b';"), lit("x = 'a b';"));
  assert.equal(lit('x  =  1;'), lit('x = 1;'));
  assert.notEqual(lit('a\n(b)'), lit('a (b)'));
  // A module with no executed function has no established reach.
  assert.equal(guardOf(named, []).mode, 'module');
});

// ---- observed output: the real page entries against the capture evidence ----
const pageAndEvidence = (input, perturbations = {}, options = {}) => Capture.withPerturbations(perturbations, () => {
  const capture = Capture.capturePages(input.doc.data, input.doc.periods, ROOT, { recordHtml: true, ...options });
  const evidence = {}; Snapshot.__putCaptureEvidence(evidence, '', capture);
  const page = capture.runs.map(r => r.states.map(s => r.page + '|' + s.id + '|' + JSON.stringify(s.html))).flat().join('\n');
  return { page, evidence, capture };
});
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
  assert.equal(Capture.perturbed(), false, 'perturbations are cleared after each run');
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

test('instrumentation is neutral: same-realm uninstrumented and instrumented renders are identical; the wrapper preserves receiver, arguments, results and exceptions', () => {
  // The page's own Forecast runs in the page realm in both runs; only the
  // observer differs (Atlas 6552087494 item 4).
  for (const id of ['savings-live-partial', 'savings-chained-closes', 'card-paid-clear']) {
    const input = byId(id);
    const observed = Capture.capturePages(input.doc.data, input.doc.periods, ROOT, { recordHtml: true });
    const plain = Capture.capturePages(input.doc.data, input.doc.periods, ROOT,
      { recordHtml: true, instrument: false, states: observed.stateList });
    assert.equal(plain.observations.length, 0, id + ': the uninstrumented run observes nothing');
    assert.deepEqual(plain.runs.map(r => r.states.map(s => [s.id, s.error, s.html])),
      observed.runs.map(r => r.states.map(s => [s.id, s.error, s.html])), id + ': identical rendered pages, state by state');
    assert.ok(observed.observations.every(o => o.error === null), id + ': no observed call threw');
    const e1 = {}, e2 = {};
    Snapshot.__putCaptureEvidence(e1, '', observed);
    Snapshot.__putCaptureEvidence(e2, '', Capture.capturePages(input.doc.data, input.doc.periods, ROOT));
    assert.deepEqual(e1, e2, id + ': repeat captures encode identically (deterministic)');
  }
  // The wrapper itself, against a sentinel: same receiver, the same argument
  // values by identity, the same result object, the same thrown object.
  const arg = {}, result = {}, failure = new Error('sentinel');
  let seen = null;
  const fn = function (a, b) { seen = { self: this, a, b, n: arguments.length }; if (b === 'throw') throw failure; return result; };
  const calls = [];
  const wrapped = Capture.observed(fn, args => { calls.push(args); return calls.length; }, (token, r, e) => calls.push([token, r, e]));
  const self = { wrapped };
  assert.equal(self.wrapped(arg, 'x'), result);
  assert.ok(seen.self === self && seen.a === arg && seen.b === 'x' && seen.n === 2);
  assert.throws(() => self.wrapped(arg, 'throw'), e => e === failure);
  assert.equal(calls[3][2], failure);
});

test('realm fidelity: a scheduled bill amount (a page-parsed object the engine prototype-checks) reaches the capture', () => {
  // Pre-review F4: with the page JSON parsed in the vm and the engine in
  // Node's realm, every amountSchedule term failed forecast.js's prototype
  // check, so this edit moved the browser's publication but not the capture.
  // Invented input only; the schedule is added for this witness.
  const variant = amount => {
    const doc = JSON.parse(JSON.stringify(byId('savings-live-partial').doc));
    const bill = doc.data.plan.bills.find(b => b.id === 'routine');
    assert.ok(bill, 'the invented routine bill exists');
    bill.amountSchedule = [{ from: '2026-10-01', until: '2027-03-01', amount, confidence: 'confirmed' }];
    return { id: 'savings-live-partial', doc };
  };
  const low = pageAndEvidence(variant(55)), high = pageAndEvidence(variant(95));
  assert.notEqual(low.page, high.page, 'the rendered page moves with the schedule amount');
  assert.ok(evidenceMoved(low.evidence, high.evidence).length > 0, 'the capture evidence moves with it');
  for (const run of [low, high]) assert.ok(run.capture.runs.every(r => r.loadErrors.length === 0 && r.states.every(st => !st.error)));
});

test('legitimate no-call and withheld states are valid, not malformed', () => {
  for (const id of ['card-paid-clear', 'opening-gap-funded']) {
    const { evidence: captured, capture } = pageAndEvidence(byId(id));
    // The validator rebuilds the expected states from the input's own
    // itemized pay periods, so it reads them beside the evidence.
    const evidence = { ...Snapshot.buildFiguresSnapshot(byId(id).doc.data, byId(id).doc.periods), ...captured };
    assert.ok(capture.runs.every(r => r.loadErrors.length === 0 && r.states.every(s => !s.error && s.unfinished === 0)), id + ' renders');
    assert.equal(Comment.captureEvidenceProblems(evidence, ['']), 0, id + ': a valid unfunded capture');
  }
});
