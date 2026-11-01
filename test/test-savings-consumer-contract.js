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
    // Design 6554987596 §8: handler attributes in any tag spelling, and
    // scripts inside a template.
    ['handler after a quoted value', tag + '\n<img src="x"onerror="void 0">'],
    ['handler after a slash', tag + '\n<img/onerror="void 0">'],
    ['handler after a quoted >', tag + '\n<img alt=">" onerror="void 0">'],
    ['upper-case handler', tag + '\n<IMG SRC="x" ONERROR="void 0">'],
    ['unquoted handler on svg', tag + '\n<svg onload=void(0)></svg>'],
    ['script inside a template', tag + '\n<template><script src="/zz-template.js"></script></template>'],
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
    // Design 6554987596 §8: the masked forms and the runtime loaders.
    ['import split by a comment', "try { import /*x*/ ('/zz-module.js').catch(() => {}); } catch (e) {}", /dynamic import is unsupported/],
    ['import split by a line break', "try { import\n('/zz-module.js').catch(() => {}); } catch (e) {}", /dynamic import is unsupported/],
    ['eval', "try { eval('1'); } catch (e) {}", /eval is unsupported/],
    ['Function constructor', "try { Function('return 1')(); } catch (e) {}", /Function constructor is unsupported/],
    ['new Function', "try { new Function('return 1'); } catch (e) {}", /Function constructor is unsupported/],
    ['string-argument timer', "setTimeout('void 0', 1);", /string-argument timer is unsupported/],
    ['string timer through a variable', "const zzCode = 'void 0'; setTimeout(zzCode, 1);", /runtime load: string-argument timeout/],
    ['runtime iframe', "try { document.createElement('IFRAME'); } catch (e) {}", /runtime load: iframe element/],
    ['runtime frame', "try { document.createElementNS('x', 'frame'); } catch (e) {}", /runtime load: frame element/],
    ['document.write', "try { document.write('<p>'); } catch (e) {}", /runtime load: document\.write/],
    ['document.writeln', "try { document.writeln('<p>'); } catch (e) {}", /runtime load: document\.writeln/],
    ['Worker', "try { new Worker('/zz.js'); } catch (e) {}", /runtime load: Worker/],
    ['SharedWorker', "try { new SharedWorker('/zz.js'); } catch (e) {}", /runtime load: SharedWorker/],
    ['importScripts', "try { importScripts('/zz.js'); } catch (e) {}", /runtime load: importScripts/],
    ['service worker', "try { navigator.serviceWorker.register('/zz.js'); } catch (e) {}", /runtime load: service worker registration/],
  ]) {
    const dir = editedTree('public/plan-spend.js', "'use strict';", "'use strict';\n" + code);
    try {
      const capture = Capture.capturePages(byId('savings-live-partial').doc.data, byId('savings-live-partial').doc.periods, dir);
      assert.ok(capture.runs.find(r => r.page === 'planSpend').loadErrors.some(e => expect.test(e)), name + ' is a load error');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // Table r4 §5 and r4.1 §3 (pre-review 6558436817 R6), on a three-state
  // input (the loading boundary does not depend on it). A comment ends at
  // <!-->, <!---> or --!>, so a handler after one is markup (the trailing -->
  // hid it from the earlier scanner). The raw-text scan refuses an import the
  // masked scan's regex-after-) heuristic hides, and, the disclosed
  // conservative cost, every inert mention of import(, eval or Function( in a
  // string literal, a comment or a regex literal.
  const quick = byId('opening-gap-unfunded').doc;
  for (const [name, replacement] of [
    ['handler after <!-->', tag + '\n<!--> <img src="x" onerror="void 0"> -->'],
    ['handler after <!--->', tag + '\n<!---> <img src="x" onerror="void 0"> -->'],
    ['handler after a comment closed by --!>', tag + '\n<!-- x --!><img src=x onerror="void 0"> -->'],
  ]) {
    const dir = editedTree('public/plan-spend.html', tag, replacement);
    try {
      assert.throws(() => Capture.pageScripts('planSpend', dir), /unsupported inline event handler/, name + ' fails closed');
      assert.throws(() => Capture.capturePages(quick.data, quick.periods, dir), /page capture/, name + ': the capture refuses to run');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const mentions = [['import(', "import('/zz.js')", 'import()', /dynamic import is unsupported/],
    ['eval', "eval('x')", 'eval', /eval is unsupported/], ['Function(', "Function('x')", 'Function()', /Function constructor is unsupported/]];
  for (const [name, code, expect] of [
    ['import hidden by the regex-after-) heuristic', "if (typeof zz !== 'undefined') /'/.test(zz); import('/zz-module.js').catch(() => {}); var zzRe = /'/;", /dynamic import is unsupported \(raw text\)/],
    ...mentions.flatMap(([what, text, pattern, error]) => [['a string literal mention of ' + what, 'const zzText = ' + JSON.stringify(text) + ';', error],
      ['a comment mention of ' + what, '// ' + text, error], ['a regex literal mention of ' + what, 'const zzRe = /' + pattern + '/;', error]]),
  ]) {
    const dir = editedTree('public/plan-spend.js', "'use strict';", "'use strict';\n" + code);
    try {
      const capture = Capture.capturePages(quick.data, quick.periods, dir);
      assert.ok(capture.runs.find(r => r.page === 'planSpend').loadErrors.some(e => expect.test(e)), name + ' is refused (a load error)');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // Astra MEDIUM 4 (adopted addendum 6560714968 §5): escaped identifiers are
  // the enumerated forms to the engine, so the scan also runs on the text
  // with every \uHHHH and \u{H+} decoded; L1-L6 are the byte-exact witnesses
  // (each passes both the raw and the masked scan undecoded). An escape that
  // cannot be decoded fails closed; malformed syntax stays a load error; a
  // legitimate string escape loads.
  for (const [name, code, expect] of [
    ['L1 \\u0065val', 'try { \\u0065val("1"); } catch (e) {}', /eval is unsupported \(decoded escapes\)/],
    ['L2 \\u{65}val', 'try { \\u{65}val("1"); } catch (e) {}', /eval is unsupported \(decoded escapes\)/],
    ['L3 ev\\u0061l', 'try { ev\\u0061l("1"); } catch (e) {}', /eval is unsupported \(decoded escapes\)/],
    ['L4 \\u0046unction', 'try { \\u0046unction("1")(); } catch (e) {}', /Function constructor is unsupported \(decoded escapes\)/],
    ['L5 new \\u0046unction', 'try { new \\u0046unction("1"); } catch (e) {}', /Function constructor is unsupported \(decoded escapes\)/],
    ['L6 set\\u0054imeout', 'set\\u0054imeout("1");', /string-argument timer is unsupported \(decoded escapes\)/],
    ['an escape above U+10FFFF', 'const zzText = "\\u{110000}";', /invalid unicode escape/],
    ['a truncated escape', 'const zzText = "\\u12";', /invalid unicode escape/],
    ['malformed syntax after decoding', 'const zz\\u0020x = 1;', /SyntaxError|Invalid|Unexpected/],
  ]) {
    const dir = editedTree('public/plan-spend.js', "'use strict';", "'use strict';\n" + code);
    try {
      const capture = Capture.capturePages(quick.data, quick.periods, dir);
      assert.ok(capture.runs.find(r => r.page === 'planSpend').loadErrors.some(e => expect.test(e)), name + ' is refused (a load error)');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  {
    const dir = editedTree('public/plan-spend.js', "'use strict';", "'use strict';\nconst zzText = '\\u00b7\\u2212\\u{1F600}';");
    try {
      const capture = Capture.capturePages(quick.data, quick.periods, dir);
      assert.deepEqual(capture.runs.find(r => r.page === 'planSpend').loadErrors, [], 'a legitimate string escape loads');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // Deferred registrations the capture never invokes are recorded: any on*
  // name on the document, the window's named list, and setAttribute.
  for (const [name, code, kind] of [
    ['document handler, any name', "document.onzzcustom = () => {};", 'document-handler:onzzcustom'],
    ['window handler from the list', "window.onscrollend = () => {};", 'window-handler:onscrollend'],
    ['handler through setAttribute', "document.getElementById('zz').setAttribute('onclick', 'void 0');", 'attribute-handler:onclick'],
  ]) {
    const dir = editedTree('public/plan-spend.js', "'use strict';", "'use strict';\n" + code);
    try {
      const capture = Capture.capturePages(byId('savings-live-partial').doc.data, byId('savings-live-partial').doc.periods, dir);
      const kinds = capture.deferred.get('public/plan-spend.js');
      assert.ok(kinds && kinds.has(kind), name + ' is recorded as a deferred registration');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  assert.ok(Capture.WINDOW_HANDLER_EVENTS.includes('scrollend') && Object.isFrozen(Capture.WINDOW_HANDLER_EVENTS), 'the finite window list is a pinned constant');
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

// Adopted design 6555036724: each exact-context anchor is computed by its own
// call; the discriminating witnesses move the observation and its own anchor
// together, and substituting another anchor reads INVALID.
const adviceLines = evidence => Object.keys(evidence).filter(k => /^savings\.capture\.advice\.\d+$/.test(k)).map(k => [k, evidence[k].split('|')]);
const observationsOf = evidence => Object.keys(evidence).filter(k => /^savings\.capture\.o\d+$/.test(k)).map(k => evidence[k].split('|'));
test('the per-advice anchors move with the context witnesses; another anchor substituted reads INVALID', () => {
  const input = byId('savings-live-partial');
  const itemized = Snapshot.buildFiguresSnapshot(input.doc.data, input.doc.periods);
  assert.equal(Comment.captureEvidenceProblems({ ...itemized, ...baseline('savings-live-partial').evidence }, ['']), 0, 'the unedited capture is valid');
  for (const [why, selector, field, predicts] of [
    ['null-only witness', real => function (pub, ctx) {
      return ctx && Object.prototype.hasOwnProperty.call(ctx, 'periodId') && ctx.periodId === null ? null : real.apply(this, arguments);
    }, 7, ctx => /periodId=null/.test(ctx)],
    ['plan-key-only witness', real => function (pub, ctx) {
      return ctx && ctx.plan && ctx.plan.savingsEarmarks ? null : real.apply(this, arguments);
    }, 8, ctx => /plan=entry-plan/.test(ctx)],
  ]) {
    const run = pageAndEvidence(input, { savingsFundingPublication: selector });
    const anchors = adviceLines(run.evidence);
    assert.ok(anchors.length > 0, why + ': anchors recorded');
    for (const [, a] of anchors) {
      if (a[1] === 'budget') {
        assert.equal(a[6], 'object', why + ': the omitted-periodId anchor is unchanged');
        assert.equal(a[field], 'null', why + ': its own anchor moved');
      } else if (field === 8) assert.equal(a[8], 'null', why + ': the Plan spend plan-bearing anchor moved');
    }
    const routed = observationsOf(run.evidence).filter(o => predicts(o[4]));
    assert.ok(routed.length > 0 && routed.every(o => o[6] === 'null'), why + ': the observations moved with it');
    const head = { ...itemized, ...run.evidence };
    assert.ok(Comment.captureEvidenceProblems(head, ['']) > 0, why + ': the versioned anchor invariant fails closed');
    // Substitute the omitted-periodId anchor for the witness's own anchor:
    // the observations then disagree with the anchor that predicts them.
    const swapped = { ...head };
    for (const [k, a] of anchors) if (a[1] === 'budget') swapped[k] = [...a.slice(0, field), a[6], ...a.slice(field + 1)].join('|');
    const disagree = observationsOf(swapped).filter(o => o[0] === 'budget' && predicts(o[4])).length;
    assert.ok(disagree > 0 && Comment.captureEvidenceProblems(swapped, ['']) >= disagree, why + ': another anchor substituted reads INVALID');
  }
  assert.equal(Capture.perturbed(), false, 'perturbations are cleared after each run');
});

// The state-equality invariant (6554987596 §4): no declared Budget state
// variable is an input of recommend, so every Budget state's advice is built
// from identical arguments.
test('state-equality invariant: every Budget state calls recommend with identical arguments', () => {
  const serial = value => JSON.stringify(value, (key, v) => (typeof v === 'function' ? 'fn:' + v.name : v === undefined ? '<undefined>' : v));
  for (const id of ['savings-live-partial', 'card-paid-clear']) {
    const input = byId(id);
    const calls = [];
    const capture = Capture.withPerturbations({ recommend: real => function (...args) {
      // The plan argument is the page's own parsed object: its prototype
      // tells the Budget realm from the Plan spend realm.
      calls.push({ realm: Object.getPrototypeOf(args[0]), args: serial(args) });
      return real.apply(this, args);
    } }, () => Capture.capturePages(input.doc.data, input.doc.periods, ROOT));
    const budgetRealm = calls[0].realm;
    const budget = calls.filter(c => c.realm === budgetRealm).map(c => c.args);
    const states = capture.runs.find(r => r.page === 'budget').states.length;
    assert.ok(states > 3 && budget.length >= states && budget.length % states === 0, id + ': recommend runs equally in every Budget state');
    const per = budget.length / states;
    for (let s = 1; s < states; s++) {
      assert.deepEqual(budget.slice(s * per, (s + 1) * per), budget.slice(0, per), id + ': state ' + s + ' calls recommend with the default state\'s arguments');
    }
    assert.ok(calls.some(c => c.realm !== budgetRealm) || id === 'card-paid-clear', id + ': Plan spend builds its own advice');
  }
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
    // The supplementary anchor calls are neutral (6555018088 §2): a run
    // without them renders, observes and encodes identically, the anchor
    // lines aside.
    const unanchored = Capture.capturePages(input.doc.data, input.doc.periods, ROOT, { recordHtml: true, anchors: false });
    assert.deepEqual(unanchored.runs.map(r => r.states.map(s => [s.id, s.error, s.calls, s.html])),
      observed.runs.map(r => r.states.map(s => [s.id, s.error, s.calls, s.html])), id + ': anchors leave every render unchanged');
    const e3 = {};
    Snapshot.__putCaptureEvidence(e3, '', unanchored);
    const strip = m => Object.fromEntries(Object.entries(m).filter(([k]) => !/^savings\.capture\.advice/.test(k)));
    assert.deepEqual(strip(e3), strip(e1), id + ': anchors leave every observation and result unchanged');
    assert.equal(e3['savings.capture.advices'], 0);
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
