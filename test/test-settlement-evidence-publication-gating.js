'use strict';
// ATLAS-080 — configured-unavailable publication gating at the serving
// surfaces (assistant packet, Planning page, Plan page).
//
// The settlement evidence loader returns a tri-state outcome —
// unconfigured / qualified / unavailable(reason) — but Forecast's only
// input channel is the evidence value itself, so before this slice a
// configured-but-unavailable store had no downstream representation:
// it collapsed into the same null that means "never configured", and
// settlement-dependent Savings / funding / transfer-guidance /
// assistant figures were published as though no settlement existed.
//
// These tests pin the surface contract over synthetic served-data
// outcomes (a status carried ALONGSIDE the evidence on the served
// object the surfaces already consume — never inside the evidence):
//   unconfigured  -> behaviour and output identical to no status at all
//   qualified     -> the verified effective evidence reaches every
//                    dependent Forecast call the surface makes
//   unavailable   -> every settlement-dependent claim is withheld with
//                    the loader's reason named; genuinely independent
//                    reported facts stay published; no zero, no stale
//                    fallback, no badge over legacy figures
//   malformed status / qualified-without-evidence / evidence without a
//   qualified status -> fail closed as unavailable
//   ('invalid-configuration'), never as unconfigured.
//
// The three surfaces are exercised the way production loads them:
// the packet through its Node builder, the two browser pages through
// a vm harness that loads the real classic scripts with a recording
// fake DOM (the same globals mechanism index.html uses).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(ROOT, 'public/forecast.js'));
const C = require(path.join(ROOT, 'scripts/planned-obligation-settlement-contract.js'));
const Assistant = require(path.join(ROOT, 'scripts/assistant-packet.js'));
const fx = require('./fixtures/savings-daily-allocation-contract');

const householdId = 'household-' + 'a'.repeat(32);
const actorId = 'session-' + 'c'.repeat(64);
const op = n => 'operation-' + n.toString(16).padStart(32, '0');
const tx = n => 'tx-' + n.toString(16).padStart(32, '0');
const T0 = Date.parse('2026-10-04T12:00:00Z');
const REASONS = ['pin-unavailable', 'document-missing', 'digest-mismatch'];

// A real Phase 1 link (25 of a 60-cent assignment) projected through
// the contract's effectiveEvidence — the exact shape the loader
// returns as outcome.evidence on a qualified read.
function linkEvidence(assignedCents = 2500) {
  let body = C.adopt({ householdId });
  const evidence = { accountId: 'acct-main', currency: 'cad', direction: 'debit', date: '2026-10-03', cents: 6000, posted: true };
  const cmd = { version: 1, kind: 'link', goalId: 'commitment:near', txRef: tx(1), evidence, evidenceDigest: C.digest(evidence), assignedCents, asOf: '2026-10-04' };
  const prepared = C.prepare(body, { householdId, actorId, operationId: op(1), command: cmd, now: T0 });
  const confirmed = C.confirmCandidate(body, { householdId, actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest, now: T0 + 1 });
  assert.equal(confirmed.status, 'candidate', 'link recorded through the contract');
  body = confirmed.document;
  const state = JSON.parse(body.toString('utf8'));
  return C.effectiveEvidence({ householdId: state.householdId, revision: state.revision, operations: state.operations });
}

function fixtureInput(commitmentAmount) {
  const x = fx.fixture();
  x.plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'commitment', id: 'near' }];
  if (commitmentAmount != null) x.plan.commitments[0].amount = commitmentAmount;
  return x;
}

// The served-data object the three surfaces already consume, with the
// settlement outcome fields attached the way the composition point
// will attach them (status alongside, never inside, the evidence).
function servedData(x, settlement) {
  const data = {
    plan: x.plan,
    debts: [],
    revolvingExtra: undefined,
    meta: { asOf: x.asOf },
    liveOverlay: null,
    coverage: [],
  };
  if (settlement) {
    if (settlement.status !== undefined) data.settlementEvidenceStatus = settlement.status;
    if (settlement.evidence !== undefined) data.settlementEvidence = settlement.evidence;
  }
  return data;
}

const periods = () => Assistant.loadPeriods();
const UNCONFIGURED = { status: { status: 'unconfigured' } };
const QUALIFIED = () => ({ status: { status: 'qualified' }, evidence: linkEvidence() });
const UNAVAILABLE = reason => ({ status: { status: 'unavailable', reason } });

function numbersIn(value, out = []) {
  if (typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => numbersIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => numbersIn(v, out));
  return out;
}

/* ------------------------------------------------ assistant packet */

function buildFor(x, settlement) {
  return Assistant.buildPacket({
    data: servedData(x, settlement),
    periods: periods(),
    questionsMarkdown: '',
    now: '2026-10-05T12:00:00.000Z',
    env: {},
  });
}

function directRecommend(x, eff) {
  const plan = x.plan;
  return F.recommend(plan, x.asOf, {
    fundingSources: plan.funding && plan.funding.options,
    debts: [],
    revolvingExtra: undefined,
    periods: periods(),
    currentPeriodActuals: null,
    operatingPlan: null,
    operatingPlanNote: null,
    ...(eff ? { settlementEvidence: eff } : {}),
  });
}

test('packet: absent status and explicit unconfigured are identical', () => {
  const a = buildFor(fixtureInput(), null);
  const b = buildFor(fixtureInput(), UNCONFIGURED);
  assert.deepEqual(b, a);
  assert.equal(a.metadata.settlementEvidence, undefined,
    'unconfigured packet carries no settlement metadata');
});

test('packet: qualified threads the verified evidence into recommend', () => {
  const x = fixtureInput();
  const packet = buildFor(x, QUALIFIED());
  const expected = directRecommend(fixtureInput(), linkEvidence());
  const baseline = directRecommend(fixtureInput(), null);
  assert.notEqual(expected.weekly, baseline.weekly,
    'fixture sanity: evidence moves the recommendation on this plan');
  assert.equal(packet.forecast.recommendation.weekly, expected.weekly,
    'packet weekly is the with-evidence Forecast recommendation');
  assert.deepEqual(packet.metadata.settlementEvidence, { status: 'qualified', reason: null });
  const major = (packet.forecast.majorPlanFunding.items || [])
    .find(item => item.id === 'near' || /first club/.test(item.label || ''));
  assert.ok(major, 'major plan funding includes the linked commitment');
  assert.equal(major.need, 35, 'funding need is the relieved remaining, not the original cost');
});

test('packet: configured-unavailable withholds the forecast block with the reason named', () => {
  for (const reason of REASONS) {
    const packet = buildFor(fixtureInput(), UNAVAILABLE(reason));
    assert.deepEqual(packet.metadata.settlementEvidence, { status: 'unavailable', reason });
    assert.equal(packet.forecast.status, 'unavailable');
    assert.equal(packet.forecast.reason, reason);
    for (const key of ['recommendation', 'horizon', 'upcomingModeledCommitments',
      'facilityCrossings', 'majorPlanFunding', 'currentPeriodAction', 'budgetCap',
      'paydayAllocation', 'predictedEndingBalance']) {
      assert.deepEqual(packet.forecast[key], { status: 'unavailable', reason },
        `${key} withheld with the settlement reason (${reason})`);
    }
    assert.deepEqual(numbersIn(packet.forecast), [],
      'no figure at all survives inside the withheld forecast block');
    assert.deepEqual(packet.planning.trajectory,
      { status: 'unavailable', source: 'settlement-evidence', reason });
    assert.deepEqual(packet.current.nextSignificantObligations,
      { status: 'unavailable', reason });
    // Independent reported facts stay published, unchanged.
    const baseline = buildFor(fixtureInput(), null);
    assert.deepEqual(packet.current.spendableHouseholdCash, baseline.current.spendableHouseholdCash,
      'spendable cash (startingCashAmount) is evidence-independent and preserved');
    assert.deepEqual(packet.current.pending, baseline.current.pending);
    assert.deepEqual(packet.current.debts, baseline.current.debts);
    assert.deepEqual(packet.actuals.window, baseline.actuals.window,
      'periods.json reported window is preserved');
    assert.deepEqual(packet.actuals.spendingTotal, baseline.actuals.spendingTotal);
    assert.deepEqual(packet.actuals.budgetCategories, { status: 'unavailable', reason });
    assert.deepEqual(packet.actuals.currentPeriodCategories, { status: 'unavailable', reason });
  }
});

test('packet: the three loader reasons produce distinctly withheld packets', () => {
  const packets = REASONS.map(r => buildFor(fixtureInput(), UNAVAILABLE(r)));
  for (let i = 0; i < packets.length; i++) {
    for (let j = i + 1; j < packets.length; j++) {
      assert.notDeepEqual(packets[i], packets[j],
        `${REASONS[i]} output is distinguishable from ${REASONS[j]}`);
    }
  }
});

test('packet: withheld output does not depend on the settlement-dependent figures', () => {
  // Same plan, different commitment cost: under unavailable the packet
  // must be identical — nothing about the withheld figures may leak
  // through aggregates, counts or ordering.
  const a = buildFor(fixtureInput(60), UNAVAILABLE('pin-unavailable'));
  const b = buildFor(fixtureInput(97), UNAVAILABLE('pin-unavailable'));
  assert.deepEqual(b, a);
  // …while unconfigured output DOES move with the cost (control).
  const c = buildFor(fixtureInput(60), null);
  const d = buildFor(fixtureInput(97), null);
  assert.notDeepEqual(d, c, 'control: unconfigured packet tracks the plan');
});

test('packet: malformed status and qualified-without-evidence fail closed', () => {
  const cases = [
    { status: { status: 'bogus' } },
    { status: { status: 'qualified' } },
    { status: { status: 'qualified' }, evidence: null },
    { status: { status: 'qualified' }, evidence: { nope: true } },
    { status: { status: 'unavailable' } },
    { status: { status: 'unavailable' }, },
    { status: { status: 'unavailable', reason: 42 } },
    { status: { status: 'unavailable', reason: 'Not A Reason!' } },
    { status: 'qualified' },
    { status: { status: 'unconfigured' }, evidence: linkEvidence() },
    { evidence: linkEvidence() },
  ];
  for (const settlement of cases) {
    const packet = buildFor(fixtureInput(), settlement);
    assert.deepEqual(packet.metadata.settlementEvidence,
      { status: 'unavailable', reason: 'invalid-configuration' },
      `fails closed: ${JSON.stringify(settlement.status)}`);
    assert.equal(packet.forecast.status, 'unavailable');
    assert.equal(packet.forecast.reason, 'invalid-configuration');
    assert.deepEqual(numbersIn(packet.forecast), [], 'no figures on the fail-closed path');
  }
});

/* ------------------------------------------------------- fake DOM */

// Id containment of the real Plan page, parsed from public/index.html:
// for each id-bearing element, the set of id-bearing descendants. The
// B4 proof needs this because the defect is structural — a renderer
// that assigns innerHTML on a container deletes the mounts inside it
// in a real DOM, and lookups for those mounts then return null. The
// original harness kept every id in a flat registry forever, so that
// class of failure was invisible to it.
function idDescendantsById() {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    .replace(/<style\b[\s\S]*?<\/style>/g, '');
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
    'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const parentOf = new Map();
  const stack = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const raw = m[0], tag = m[1].toLowerCase();
    if (raw.startsWith('</')) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const idm = /\bid="([^"]+)"/.exec(m[2]);
    const id = idm ? idm[1] : null;
    if (id && !parentOf.has(id)) {
      let parent = null;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].id) { parent = stack[i].id; break; }
      }
      parentOf.set(id, parent);
    }
    if (!VOID.has(tag) && !raw.endsWith('/>')) stack.push({ tag, id });
  }
  const childrenOf = new Map();
  for (const [id, parent] of parentOf) {
    if (parent) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(id);
    }
  }
  const descendantsOf = new Map();
  const collect = (id, into) => {
    for (const c of childrenOf.get(id) || []) { into.add(c); collect(c, into); }
  };
  for (const id of parentOf.keys()) {
    const set = new Set();
    collect(id, set);
    descendantsOf.set(id, set);
  }
  return descendantsOf;
}

function makeFakeDom() {
  const elements = new Map();
  // Descendant-removal and lookup semantics (B4): assigning innerHTML
  // or textContent on an element replaces its children in a real DOM,
  // so every id-bearing descendant (per the real index.html
  // containment above) is removed from the document and
  // document.getElementById returns null for it from then on.
  // Re-attachment is deliberately NOT modelled: no render path
  // re-creates a structural mount from markup — recovery after an
  // unavailable render works precisely because the mounts are never
  // destroyed, which is the invariant the B4 tests pin. Ids that are
  // not part of the static page (other pages' mounts, harness-created
  // nodes) have no containment entry and keep the original
  // always-present behaviour.
  const descendantsOf = idDescendantsById();
  const detached = new Set();
  const detachDescendants = id => {
    const set = descendantsOf.get(id);
    if (set) for (const d of set) detached.add(d);
  };
  const drawStub = new Proxy({}, {
    get(target, prop) {
      if (prop === 'measureText') return () => ({ width: 0 });
      if (typeof prop === 'symbol') return undefined;
      return (...args) => drawStub;
    },
    set() { return true; },
  });
  function element(id) {
    if (!elements.has(id)) {
      const el = {
        id, _html: '', _text: '', className: '', hidden: false,
        dataset: {}, style: {}, attrs: {}, children: [], value: '',
        checked: false, disabled: false, offsetWidth: 120, offsetHeight: 40,
        offsetLeft: 0, offsetTop: 0, scrollWidth: 240, clientWidth: 240, scrollLeft: 0,
        // The Plan page's wiring reaches external mounts through
        // mount.ownerDocument (the #budget-attention-bottom move and
        // its remount teardown); the fake document is the registry
        // below, resolved lazily so element creation order is free.
        get ownerDocument() { return document; },
        // data-* attributes and dataset are reflections of the same
        // attribute in a real DOM; renderPlan relies on that ("set on
        // every paint so a stale value cannot survive a re-render")
        // when it writes data-plan-status via setAttribute only.
        setAttribute(k, v) {
          this.attrs[k] = String(v);
          if (k.startsWith('data-')) {
            const prop = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            this.dataset[prop] = String(v);
          }
        },
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
        removeAttribute(k) {
          delete this.attrs[k];
          if (k.startsWith('data-')) {
            const prop = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            delete this.dataset[prop];
          }
        },
        addEventListener() {}, removeEventListener() {},
        dispatchEvent(evt) { (this.events ||= []).push(evt && evt.type); return true; },
        appendChild(c) { this.children.push(c); return c; },
        append(...kids) { this.children.push(...kids); },
        contains(node) { return node != null && this.children.includes(node); },
        // Move/clear semantics for the one externally moved card:
        // adopting an attention slice node removes its HTML from
        // the origin element (a move, not a copy); calling with no
        // nodes clears the mount, as budgetRemount's teardown does.
        replaceChildren(...nodes) {
          for (const node of nodes) {
            if (node && node._attentionSlice && node._origin) {
              node._origin.innerHTML = node._origin.innerHTML.replace(node._attentionSlice, '');
            }
          }
          this.children = nodes.slice();
          this.innerHTML = nodes.map(n => (n && n._attentionSlice) || '').join('');
        },
        querySelector(sel) {
          // The attention card is produced as HTML inside the
          // operating mount; model finding it as a node whose HTML
          // slice can then be moved by replaceChildren above.
          if (sel === '[data-budget-browse="attention"]') {
            const marker = this.innerHTML.indexOf('data-budget-browse="attention"');
            if (marker < 0) return null;
            const start = this.innerHTML.lastIndexOf('<section', marker);
            const close = this.innerHTML.indexOf('</section>', marker);
            if (start < 0 || close < 0) return null;
            const slice = this.innerHTML.slice(start, close + '</section>'.length);
            return {
              _attentionSlice: slice, _origin: this,
              contains: () => false,
              getAttribute: () => null,
              querySelector: () => null, querySelectorAll: () => [],
            };
          }
          return element(id + '>q');
        },
        querySelectorAll() { return []; },
        closest() { return null; },
        getContext() { return drawStub; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 120, height: 40 }; },
        scrollTo() {}, focus() {}, click() {},
        remove() { detached.add(id); detachDescendants(id); },
      };
      // innerHTML / textContent assignment replaces an element's
      // children in a real DOM: id-bearing descendants are removed
      // from the document (see the containment note above makeFakeDom).
      Object.defineProperty(el, 'innerHTML', {
        get() { return this._html; },
        set(v) { this._html = String(v); this.children = []; detachDescendants(id); },
      });
      Object.defineProperty(el, 'textContent', {
        get() { return this._text; },
        set(v) { this._text = String(v); this.children = []; detachDescendants(id); },
      });
      elements.set(id, el);
    }
    return elements.get(id);
  }
  const document = {
    getElementById: id => (detached.has(id) ? null : element(id)),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: tag => element('created:' + tag),
    // app.js builds chart SVG through document.createElementNS.
    createElementNS: (ns, tag) => element('createdNS:' + tag),
    addEventListener() {},
    activeElement: null,
    body: element('body'),
    documentElement: element('html'),
  };
  return { document, element, elements };
}

function loadBrowserScripts(files) {
  const dom = makeFakeDom();
  const sandbox = {
    console,
    // Inert timers: app.js boot arms long abort timers (60s/180s)
    // around its data fetch; with real timers those would hold the
    // suite's process open long after the tests finish, and no render
    // path in these surfaces waits on a timer callback.
    setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    // app.js boot constructs an AbortController for its (here inert)
    // data fetch; the vm global does not inherit Node's web globals.
    AbortController, AbortSignal,
    // budgetRemount dispatches a real Event on the operating mount.
    Event,
    getComputedStyle: () => ({
      getPropertyValue: () => '',
      visibility: 'visible',
      borderRadius: '0px',
    }),
    document: dom.document,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    CSS: {
      escape: s => String(s).replace(/"/g, '\\"'),
      // budget-sheet-motion.js probes CSS.supports at load and takes
      // its no-animation fallback when the answer is false; without a
      // supports function the load itself throws in the harness.
      supports: () => false,
    },
    // The App framework (app.js) boots by fetching served data; a fetch
    // that never resolves keeps boot inert so the tests can drive the
    // registered render functions directly with synthetic served data.
    fetch: () => new Promise(() => {}),
    location: { href: 'http://localhost/', search: '', pathname: '/', reload() {} },
    history: { pushState() {}, replaceState() {} },
    navigator: { userAgent: 'node-test' },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    requestAnimationFrame: () => 0,
    addEventListener() {}, removeEventListener() {},
    isSecureContext: false,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  }
  return { sandbox, dom };
}

function snapshotMounts(dom) {
  const out = {};
  for (const [id, el] of dom.elements) {
    out[id] = {
      innerHTML: el.innerHTML, textContent: el.textContent,
      className: el.className, hidden: el.hidden, attrs: { ...el.attrs },
      planStatus: el.dataset && el.dataset.planStatus,
    };
  }
  return out;
}

/* ---------------------------------------------------- planning page */

function loadPlanning() {
  return loadBrowserScripts([
    'public/app.js',
    'public/forecast-card-period.js',
    'public/forecast.js',
    'public/planning.js',
  ]);
}

test('planning: qualified threads evidence into trajectory and advice calls', () => {
  const { sandbox } = loadPlanning();
  const x = fixtureInput();
  const qualified = sandbox.planningTrajectory(servedData(x, QUALIFIED()), periods());
  assert.equal(qualified.status, 'ready');
  const goal = (qualified.savingsFundingTimeline.goals || [])[0];
  assert.ok(goal, 'trajectory embeds the funding timeline');
  assert.equal(goal.requirement, 35, 'timeline requirement is the relieved remaining');
  const plain = sandbox.planningTrajectory(servedData(fixtureInput(), null), periods());
  assert.equal((plain.savingsFundingTimeline.goals || [])[0].requirement, 60,
    'control: without evidence the full cost is required');
  const advice = sandbox.planningAdvice(servedData(fixtureInput(), QUALIFIED()), periods());
  const seq = (advice.fundingSequence || []).find(e => e.id === 'near');
  assert.ok(seq, 'funding sequence includes the linked commitment');
  assert.equal(seq.need, 35, 'advice funding need is the relieved remaining');
});

test('planning: renderPlanning withholds the Road Ahead under unavailable, distinctly per reason', () => {
  const renders = REASONS.map(reason => {
    const { sandbox, dom } = loadPlanning();
    sandbox.renderPlanning(servedData(fixtureInput(), UNAVAILABLE(reason)), periods());
    return dom.element('planning-road-ahead').innerHTML;
  });
  for (let i = 0; i < renders.length; i++) {
    assert.match(renders[i], /data-settlement-evidence="unavailable"/);
    assert.ok(renders[i].includes(REASONS[i]), `reason ${REASONS[i]} is named in the withheld output`);
    assert.doesNotMatch(renders[i], /planning-road-timeline|data-planning-road-shell="ready"/,
      'no ready Road Ahead shell leaks through');
    for (let j = i + 1; j < renders.length; j++) assert.notEqual(renders[i], renders[j]);
  }
});

test('planning: withheld render does not depend on the settlement-dependent figures', () => {
  const render = amount => {
    const { sandbox, dom } = loadPlanning();
    sandbox.renderPlanning(servedData(fixtureInput(amount), UNAVAILABLE('document-missing')), periods());
    return dom.element('planning-road-ahead').innerHTML;
  };
  assert.equal(render(97), render(60),
    'withheld Road Ahead is identical whatever the withheld figures are');
  const ready = (() => {
    const { sandbox, dom } = loadPlanning();
    sandbox.renderPlanning(servedData(fixtureInput(60), null), periods());
    return dom.element('planning-road-ahead').innerHTML;
  })();
  assert.notEqual(ready, render(60), 'control: unconfigured render publishes the Road Ahead');
});

test('planning: malformed status fails closed in renderPlanning', () => {
  const { sandbox, dom } = loadPlanning();
  sandbox.renderPlanning(servedData(fixtureInput(), { status: { status: 'qualified' } }), periods());
  const html = dom.element('planning-road-ahead').innerHTML;
  assert.match(html, /data-settlement-evidence="unavailable"/);
  assert.ok(html.includes('invalid-configuration'));
});

/* -------------------------------------------------------- plan page */

function loadPlan() {
  return loadBrowserScripts([
    'public/app.js',
    'public/forecast-card-period.js',
    'public/forecast.js',
    'public/forecast-chequing.js',
    'public/balance-history.js',
    'public/bill-detail.js',
    'public/savings-inventory.js',
    'public/budget-surface.js',
    'public/budget-card-movements.js',
    'public/budget-sheet-motion.js',
    'public/plan.js',
  ]);
}

function renderPlanPage(loaded, x, settlement) {
  const { sandbox } = loaded;
  const data = servedData(x, settlement);
  vm.runInContext(`state.debts = []; state.extraFacilities = undefined;`, sandbox);
  vm.runInContext(`loadKnobs({ scenario: 'expected', targetBuffer: 20, extraDebtMonthly: 0 });`, sandbox);
  sandbox.renderPlan(data, periods(), []);
  return snapshotMounts(loaded.dom);
}

test('plan: absent status and explicit unconfigured render identically', () => {
  const a = renderPlanPage(loadPlan(), fixtureInput(), null);
  const b = renderPlanPage(loadPlan(), fixtureInput(), UNCONFIGURED);
  assert.deepEqual(b, a);
});

test('plan: qualified render differs from unconfigured and shows relieved savings figures', () => {
  const plain = renderPlanPage(loadPlan(), fixtureInput(), null);
  const qualified = renderPlanPage(loadPlan(), fixtureInput(), QUALIFIED());
  assert.notDeepEqual(qualified, plain, 'qualified evidence changes the rendered plan');
  const surface = qualified['operating-surface-body'].innerHTML;
  assert.ok(surface.includes('Invented first club cost'), 'savings section names the commitment');
  // The evidence reaches the operating surface's own Forecast walk
  // (its cash figures move under qualified) even though this
  // fixture's daily-allocation amounts stay Unavailable: the fixture
  // plan carries no allocation policy and no payday snapshot, so the
  // sheet prints no per-goal needed figure in either state. The
  // relieved remaining itself is published by the page's major-plan
  // funding section, which is the settlement-dependent publication
  // this slice gates: $60.00 unrelieved, $35.00 under qualified.
  assert.notEqual(surface, plain['operating-surface-body'].innerHTML,
    'qualified evidence moves the operating surface figures');
  assert.ok(plain['major-plans-list'].innerHTML.includes('$60.00'),
    'control: unconfigured major plans publish the unrelieved cost');
  assert.ok(qualified['major-plans-list'].innerHTML.includes('Invented first club cost'),
    'major plans name the commitment');
  assert.ok(qualified['major-plans-list'].innerHTML.includes('$35.00'),
    'relieved remaining (35) is published under qualified');
  assert.ok(!plain['operating-surface-body'].innerHTML.includes('linked'),
    'control marker: unconfigured surface has no link publication');
});

test('plan: unavailable withholds every settlement-dependent mount, distinctly per reason', () => {
  const renders = REASONS.map(reason => renderPlanPage(loadPlan(), fixtureInput(), UNAVAILABLE(reason)));
  for (let i = 0; i < renders.length; i++) {
    const mounts = renders[i];
    const band = mounts['status-band'];
    assert.equal(band.planStatus, 'unavailable', 'status band carries the unavailable print hook');
    assert.ok(band.innerHTML.includes(REASONS[i]), 'status band names the reason');
    const allHtml = Object.values(mounts).map(m => m.innerHTML + m.textContent).join('\n');
    assert.ok(allHtml.includes('data-settlement-evidence="unavailable"'),
      'the settlement unavailable notice is rendered');
    assert.ok(allHtml.includes(REASONS[i]), 'the reason reaches the page');
    // The debt snapshot tiles are evidence-independent reported stocks:
    assert.ok(mounts['snapshot-tiles'].innerHTML.includes('Consumer debt'),
      'independent debt snapshot stays published');
    for (let j = i + 1; j < renders.length; j++) assert.notDeepEqual(renders[i], renders[j]);
  }
});

test('plan: withheld render does not depend on the settlement-dependent figures', () => {
  const a = renderPlanPage(loadPlan(), fixtureInput(60), UNAVAILABLE('digest-mismatch'));
  const b = renderPlanPage(loadPlan(), fixtureInput(97), UNAVAILABLE('digest-mismatch'));
  assert.deepEqual(b, a,
    'every mount is identical whatever the withheld figures would have been');
});

test('plan: no stale fallback — re-rendering unavailable after unconfigured clears dependent figures', () => {
  const loaded = loadPlan();
  const first = renderPlanPage(loaded, fixtureInput(), null);
  assert.ok(first['operating-surface-body'].innerHTML.length > 0, 'first render published');
  const second = renderPlanPage(loaded, fixtureInput(), UNAVAILABLE('pin-unavailable'));
  const allHtml = Object.values(second).map(m => m.innerHTML + m.textContent).join('\n');
  assert.ok(allHtml.includes('data-settlement-evidence="unavailable"'));
  assert.equal(second['status-band'].planStatus, 'unavailable');
  // The relieved/unrelieved savings figures from the first render must
  // not survive anywhere as stale content.
  assert.ok(!second['operating-surface-body'].innerHTML.includes('Invented first club cost'),
    'operating surface no longer publishes the savings figures');
  assert.ok(!second['savings-inventory'].innerHTML.includes('Invented first club cost'),
    'savings mount no longer publishes the inventory');
});

test('plan: malformed status fails closed', () => {
  const mounts = renderPlanPage(loadPlan(), fixtureInput(), { status: { status: 'unavailable' } });
  assert.equal(mounts['status-band'].planStatus, 'unavailable');
  const allHtml = Object.values(mounts).map(m => m.innerHTML + m.textContent).join('\n');
  assert.ok(allHtml.includes('invalid-configuration'));
});

/* ------------------------- Systems Review repair round (B1–B3) */
/* Added for the consolidated BLOCKING review of head bf3eb47b
 * (PR #661, comment 6296256340). Each test was first run against
 * that head's production files and failed for the stated reason. */

// B3: the validators must enforce the effective projection's
// structural contract (planned-obligation-settlement-contract.js
// effectiveEvidence): contract-shaped identities, positive safe
// integer cents, real calendar dates, sha256 digests, array
// reversals of contract-shaped records, one entry per goal, unique
// operation identities. Anything Forecast's settlement index would
// silently skip or misread must fail closed at the surface.
test('packet: malformed effective evidence fails closed, contract-shaped evidence stays qualified (B3)', () => {
  const malformed = {
    'link is null': ev => { ev.commitments[0].links = [null]; },
    'link assignedCents is a string': ev => { ev.commitments[0].links[0].assignedCents = '2500'; },
    'link assignedCents is zero': ev => { ev.commitments[0].links[0].assignedCents = 0; },
    'link assignedCents is negative': ev => { ev.commitments[0].links[0].assignedCents = -100; },
    'link assignedCents is fractional': ev => { ev.commitments[0].links[0].assignedCents = 2500.5; },
    'link operationId is not the contract format': ev => { ev.commitments[0].links[0].operationId = 'operation-1'; },
    'link txRef is not the contract format': ev => { ev.commitments[0].links[0].txRef = 'tx-1'; },
    'link evidenceDigest is not a sha256 hex': ev => { ev.commitments[0].links[0].evidenceDigest = 'abc'; },
    'link effectiveDate is not a real date': ev => { ev.commitments[0].links[0].effectiveDate = '2026-13-40'; },
    'link asOf is not a real date': ev => { ev.commitments[0].links[0].asOf = 'yesterday'; },
    'entry goalId has an empty commitment id': ev => { ev.commitments[0].goalId = 'commitment:'; },
    'entry goalId is not a commitment goal': ev => { ev.commitments[0].goalId = 'group:near'; },
    'entry goalId id is not an identifier': ev => { ev.commitments[0].goalId = 'commitment:Near'; },
    'entry links is empty': ev => { ev.commitments[0].links = []; },
    'duplicate goal entry': ev => {
      ev.commitments.push({ goalId: 'commitment:near', links: [{ ...ev.commitments[0].links[0], operationId: op(7) }] });
    },
    'duplicate operation identity across goals': ev => {
      ev.commitments.push({ goalId: 'commitment:far', links: [{ ...ev.commitments[0].links[0] }] });
    },
    'reversals is not an array': ev => { ev.commitments[0].links[0].reversals = {}; },
    'reversal entry is null': ev => { ev.commitments[0].links[0].reversals = [null]; },
    'reversal cents is not positive': ev => {
      ev.commitments[0].links[0].reversals = [{ operationId: op(8), counterTxRef: tx(8), cents: -1, date: '2026-10-04' }];
    },
  };
  for (const [name, mutate] of Object.entries(malformed)) {
    const evidence = linkEvidence();
    mutate(evidence);
    const packet = buildFor(fixtureInput(), { status: { status: 'qualified' }, evidence });
    assert.deepEqual(packet.metadata.settlementEvidence,
      { status: 'unavailable', reason: 'invalid-configuration' }, `fails closed: ${name}`);
    assert.equal(packet.forecast.status, 'unavailable', `forecast withheld: ${name}`);
    assert.equal(packet.forecast.reason, 'invalid-configuration', `reason named: ${name}`);
  }
  // Controls: contract-shaped variations stay qualified.
  const empty = buildFor(fixtureInput(), { status: { status: 'qualified' }, evidence: { commitments: [] } });
  assert.deepEqual(empty.metadata.settlementEvidence, { status: 'qualified', reason: null },
    'a qualified store with no active links is valid evidence');
  const nearEmpty = (empty.forecast.majorPlanFunding.items || []).find(i => i.id === 'near');
  assert.equal(nearEmpty.need, 60, 'no links, no relief — full cost under a qualified label');
  const withReversal = linkEvidence();
  withReversal.commitments[0].links[0].reversals = [
    { operationId: op(2), counterTxRef: tx(2), cents: 500, date: '2026-10-04' },
  ];
  const reversed = buildFor(fixtureInput(), { status: { status: 'qualified' }, evidence: withReversal });
  assert.deepEqual(reversed.metadata.settlementEvidence, { status: 'qualified', reason: null },
    'a contract-shaped reversal record stays qualified (Forecast judges it uncertain)');
  const nearReversed = (reversed.forecast.majorPlanFunding.items || []).find(i => i.id === 'near');
  assert.equal(nearReversed.need, null, 'Forecast withholds the reversed row itself');
  const split = linkEvidence();
  split.commitments.push({
    goalId: 'commitment:far',
    links: [{ ...split.commitments[0].links[0], operationId: op(3), assignedCents: 500 }],
  });
  const splitPacket = buildFor(fixtureInput(), { status: { status: 'qualified' }, evidence: split });
  assert.deepEqual(splitPacket.metadata.settlementEvidence, { status: 'qualified', reason: null },
    'one payment split across two goals (shared txRef, distinct operations) is contract-shaped');
});

// B3 (continued): an explicit null served status is a published
// outcome that is malformed — distinct from an omitted status,
// which is the unconfigured seam. Null must fail closed, never
// read as "never configured".
test('packet: explicit null status fails closed and is not omitted status (B3)', () => {
  const omitted = buildFor(fixtureInput(), null);
  assert.equal(omitted.metadata.settlementEvidence, undefined, 'omitted status stays unconfigured');
  const explicitNull = buildFor(fixtureInput(), { status: null });
  assert.deepEqual(explicitNull.metadata.settlementEvidence,
    { status: 'unavailable', reason: 'invalid-configuration' },
    'explicit null status is malformed, not unconfigured');
  assert.equal(explicitNull.forecast.status, 'unavailable');
  const nullWithEvidence = buildFor(fixtureInput(), { status: null, evidence: linkEvidence() });
  assert.deepEqual(nullWithEvidence.metadata.settlementEvidence,
    { status: 'unavailable', reason: 'invalid-configuration' },
    'null status with evidence also fails closed');
});

test('planning + plan: malformed effective evidence fails closed at the page surfaces (B3)', () => {
  const badEvidence = () => {
    const ev = linkEvidence();
    ev.commitments[0].links = [null];
    return { status: { status: 'qualified' }, evidence: ev };
  };
  const { sandbox, dom } = loadPlanning();
  sandbox.renderPlanning(servedData(fixtureInput(), badEvidence()), periods());
  const road = dom.element('planning-road-ahead').innerHTML;
  assert.match(road, /data-settlement-evidence="unavailable"/, 'planning withholds on malformed evidence');
  assert.ok(road.includes('invalid-configuration'), 'planning names invalid-configuration');
  const mounts = renderPlanPage(loadPlan(), fixtureInput(), badEvidence());
  assert.equal(mounts['status-band'].planStatus, 'unavailable', 'plan withholds on malformed evidence');
  const allHtml = Object.values(mounts).map(m => m.innerHTML + m.textContent).join('\n');
  assert.ok(allHtml.includes('invalid-configuration'), 'plan names invalid-configuration');
  const nullMounts = renderPlanPage(loadPlan(), fixtureInput(), { status: null });
  assert.equal(nullMounts['status-band'].planStatus, 'unavailable',
    'explicit null status fails closed on the plan page too');
});

// B1: the Month trajectory and funding-schedule caches must follow
// the settlement outcome on the SAME page instance. Other inputs —
// including an explicit weekly override — are held constant; the
// expected figures are the fresh Forecast output for each outcome.
test('plan: month caches follow the settlement outcome on the same page instance (B1)', () => {
  const x = fixtureInput();
  const renderMonth = (loaded, settlement) => {
    const { sandbox } = loaded;
    vm.runInContext(`state.debts = []; state.extraFacilities = undefined;`, sandbox);
    vm.runInContext(`loadKnobs({ scenario: 'expected', targetBuffer: 20, extraDebtMonthly: 0 });`, sandbox);
    vm.runInContext(`state.weeklyVariable = 300; budgetGranularity = 'month'; budgetSelectedMonth = '2026-10';`, sandbox);
    sandbox.renderPlan(servedData(x, settlement), periods(), []);
    return snapshotMounts(loaded.dom)['operating-surface-body'].innerHTML;
  };
  const UNRELIEVED = '−$1,205.43'; // October result with no relief
  const RELIEVED = '−$1,180.43';   // October result with the $25.00 link relief
  const freshQualified = renderMonth(loadPlan(), QUALIFIED());
  assert.ok(freshQualified.includes(RELIEVED), 'oracle: fresh qualified month render is relieved');
  // unconfigured -> qualified on one instance
  const pg = loadPlan();
  assert.ok(renderMonth(pg, null).includes(UNRELIEVED), 'prime: unconfigured month render');
  const bSame = renderMonth(pg, QUALIFIED());
  assert.ok(bSame.includes(RELIEVED) && !bSame.includes(UNRELIEVED),
    'same-instance qualified render must not reuse the unconfigured trajectory');
  assert.equal(bSame, freshQualified, 'same-instance qualified render matches fresh Forecast output');
  // qualified -> unconfigured on the same instance
  const back = renderMonth(pg, null);
  assert.ok(back.includes(UNRELIEVED) && !back.includes(RELIEVED),
    'same-instance unconfigured render must not reuse the qualified trajectory');
  // withheld -> qualified (prime, withhold, then qualify)
  const pg2 = loadPlan();
  renderMonth(pg2, null);
  renderMonth(pg2, UNAVAILABLE('pin-unavailable'));
  const afterWithheld = renderMonth(pg2, QUALIFIED());
  assert.ok(afterWithheld.includes(RELIEVED),
    'qualified render after a withheld render uses the qualified trajectory');
  // qualified A -> qualified B with different relief, same instance
  const evA = { status: { status: 'qualified' }, evidence: linkEvidence(1000) };
  const freshA = renderMonth(loadPlan(), evA);
  const pg3 = loadPlan();
  renderMonth(pg3, evA);
  const bAfterA = renderMonth(pg3, QUALIFIED());
  assert.equal(bAfterA, freshQualified, 'qualified B after qualified A matches fresh B output');
  assert.notEqual(bAfterA, freshA, 'qualified B differs from qualified A');
});

// B2: the wired attention card is moved OUT of the operating mount
// into #budget-attention-bottom by the normal render. The
// unavailable transition must tear that external mount down too,
// or its Forecast figures survive under an unavailable page. The
// budget-surface fixture produces a nonempty card; the harness
// models the move with real state (see makeFakeDom).
test('plan: unavailable transition tears down the moved attention card (B2)', () => {
  const bsFixture = require('./fixtures/budget-surface-data');
  const loaded = loadPlan();
  const { sandbox, dom } = loaded;
  const render = data => {
    vm.runInContext(`state.debts = []; state.extraFacilities = undefined;`, sandbox);
    vm.runInContext(`loadKnobs({ scenario: 'expected', targetBuffer: 20, extraDebtMonthly: 0 });`, sandbox);
    sandbox.renderPlan(data, periods(), []);
    return snapshotMounts(dom);
  };
  const first = render(bsFixture.served());
  const bottom = first['budget-attention-bottom'];
  assert.ok(bottom && bottom.innerHTML.includes('Worth a look'),
    'the nonempty attention card was moved into the external mount');
  assert.ok(bottom.innerHTML.includes('budget-attention-item')
    && bottom.innerHTML.includes('to confirm'),
    'the moved card carries its dependent bill/category actions');
  assert.ok(!first['operating-surface-body'].innerHTML.includes('data-budget-browse="attention"'),
    'the card no longer lives inside the operating mount (it was moved, not copied)');
  const second = render({
    ...bsFixture.served(),
    settlementEvidenceStatus: { status: 'unavailable', reason: 'pin-unavailable' },
  });
  assert.equal(second['status-band'].planStatus, 'unavailable');
  const bottomAfter = second['budget-attention-bottom'];
  assert.ok(!bottomAfter || bottomAfter.innerHTML === '',
    'the external attention mount is empty after the unavailable transition');
  assert.ok(!bottomAfter || !bottomAfter.innerHTML.includes('Worth a look'),
    'no stale attention card survives the unavailable transition');
});

/* ------------------------- Systems Review repair round (B4) */
/* Added for the Systems Review BLOCK of head d7054184 (PR #661,
 * comment 6297530699). public/index.html places the structural
 * mounts #status-band, #plan-window, #c-forecast and #snapshot-tiles
 * INSIDE #road-ahead; the unavailable renderer cleared #road-ahead
 * itself, deleting every mount inside it — the status band it had
 * just filled, the snapshot mount it was about to republish, and the
 * mounts the next normal render writes unconditionally
 * ($('plan-window').textContent throws on the deleted node). The
 * harness now models descendant removal and lookup semantics from
 * the real index.html containment (see makeFakeDom), so these tests
 * exercise the actual failure. Each was first run against d7054184
 * production files and failed for the stated reason. */

test('plan: unavailable render preserves structural mounts and independent publications (B4)', () => {
  const loaded = loadPlan();
  const { dom } = loaded;
  renderPlanPage(loaded, fixtureInput(), null);
  assert.ok(dom.element('c-forecast').children.length > 0,
    'prime render published the forecast chart');
  const un = renderPlanPage(loaded, fixtureInput(), UNAVAILABLE('pin-unavailable'));
  // The structural mounts inside #road-ahead survive the unavailable
  // render — in a real DOM they are the renderer's own scaffolding.
  for (const id of ['road-ahead', 'status-band', 'plan-window', 'c-forecast', 'snapshot-tiles']) {
    assert.ok(dom.document.getElementById(id),
      `${id} is still in the document after the unavailable render`);
  }
  // The unavailable indication is retained on the status band, and
  // the plan window carries the withheld line.
  assert.equal(un['status-band'].planStatus, 'unavailable');
  assert.ok(un['status-band'].innerHTML.includes('Plan unavailable'),
    'status band carries the unavailable notice');
  assert.ok(un['plan-window'].textContent.includes('Settlement evidence unavailable'),
    'plan window carries the withheld line');
  // The independent reported debt stocks are still published.
  assert.ok(un['snapshot-tiles'].innerHTML.includes('Consumer debt'),
    'independent snapshot tiles stay published under unavailable');
  // Dependent leaf publications are cleared, including the chart.
  assert.equal(dom.element('c-forecast').children.length, 0,
    'chart content is removed under unavailable');
  assert.equal(un['c-forecast'].innerHTML, '', 'chart mount is emptied under unavailable');
  assert.ok(!un['major-plans-list'].innerHTML.includes('Invented first club cost'),
    'no stale dependent figures survive in the major plans list');
});

test('plan: same-instance recovery from unavailable to qualified restores publication (B4)', () => {
  const loaded = loadPlan();
  renderPlanPage(loaded, fixtureInput(), null);
  renderPlanPage(loaded, fixtureInput(), UNAVAILABLE('digest-mismatch'));
  let recovered;
  assert.doesNotThrow(() => {
    recovered = renderPlanPage(loaded, fixtureInput(), QUALIFIED());
  }, 'qualified render after an unavailable render must not throw');
  assert.ok(recovered['major-plans-list'].innerHTML.includes('$35.00'),
    'relieved remaining is republished after recovery');
  assert.notEqual(recovered['status-band'].planStatus, 'unavailable',
    'status band returns to a real verdict after recovery');
  assert.ok(recovered['plan-window'].textContent.includes('week view'),
    'plan window is republished after recovery');
  assert.ok(loaded.dom.element('c-forecast').children.length > 0,
    'chart is redrawn after recovery');
  assert.ok(recovered['snapshot-tiles'].innerHTML.includes('Consumer debt'),
    'snapshot tiles are still published after recovery');
  const fresh = renderPlanPage(loadPlan(), fixtureInput(), QUALIFIED());
  assert.equal(recovered['major-plans-list'].innerHTML, fresh['major-plans-list'].innerHTML,
    'recovered render matches a fresh qualified render');
  assert.equal(recovered['plan-window'].textContent, fresh['plan-window'].textContent);
});

test('plan: same-instance recovery from unavailable to unconfigured restores publication (B4)', () => {
  const loaded = loadPlan();
  renderPlanPage(loaded, fixtureInput(), QUALIFIED());
  renderPlanPage(loaded, fixtureInput(), UNAVAILABLE('document-missing'));
  let recovered;
  assert.doesNotThrow(() => {
    recovered = renderPlanPage(loaded, fixtureInput(), null);
  }, 'unconfigured render after an unavailable render must not throw');
  assert.ok(recovered['major-plans-list'].innerHTML.includes('$60.00'),
    'unrelieved cost is republished after recovery');
  assert.ok(recovered['plan-window'].textContent.includes('week view'),
    'plan window is republished after recovery');
  assert.ok(loaded.dom.element('c-forecast').children.length > 0,
    'chart is redrawn after recovery');
  const fresh = renderPlanPage(loadPlan(), fixtureInput(), null);
  assert.equal(recovered['major-plans-list'].innerHTML, fresh['major-plans-list'].innerHTML,
    'recovered render matches a fresh unconfigured render');
  assert.equal(recovered['plan-window'].textContent, fresh['plan-window'].textContent);
});

/* --------------------------------------------------- plan spend page */
// Plan Spend settlement publication gap (Dale's launch audit). Plan Spend
// renders Forecast.recommend output — the savings inventory, payday funding
// lede, planned-spending cards and note — but never read the served
// settlement outcome: qualified relief was dropped and a configured-
// unavailable store published legacy figures. These tests drive the real
// plan-spend.js script and its registered renderer with synthetic data.

const PLAN_SPEND_MOUNTS = ['savings-inventory', 'plan-spend-lede', 'plan-spend-list', 'plan-spend-note'];

function loadPlanSpend() {
  const loaded = loadBrowserScripts([
    'public/app.js',
    'public/forecast.js',
    'public/savings-inventory.js',
    'public/plan-spend.js',
  ]);
  // Record every Forecast.recommend call the page makes; the real
  // Forecast still computes every figure.
  const calls = [];
  const real = loaded.sandbox.Forecast.recommend;
  loaded.sandbox.Forecast.recommend = function (...args) { calls.push(args); return real.apply(this, args); };
  loaded.calls = calls;
  return loaded;
}

function renderPlanSpendPage(loaded, x, settlement) {
  loaded.sandbox.renderPlanSpend(servedData(x, settlement), periods());
  const out = {};
  for (const id of PLAN_SPEND_MOUNTS) {
    const el = loaded.dom.element(id);
    out[id] = { innerHTML: el.innerHTML, textContent: el.textContent };
  }
  return out;
}

const planSpendText = mounts => Object.values(mounts).map(m => m.innerHTML + m.textContent).join('\n');

// Outcome corpus shared by the parity test: every status shape the two
// incumbent mirrors distinguish.
function settlementCorpus() {
  const valid = linkEvidence();
  const bad = mutate => { const e = structuredClone(valid); mutate(e); return e; };
  const reasons = ['invalid-configuration', 'pin-unavailable', 'pin-invalid',
    'document-unavailable', 'document-missing', 'document-malformed',
    'household-mismatch', 'revision-mismatch', 'document-ahead-of-pin',
    'digest-mismatch', 'document-invalid', 'document-changed'];
  return [
    {},
    { settlementEvidenceStatus: { status: 'unconfigured' } },
    { settlementEvidenceStatus: { status: 'unconfigured' }, settlementEvidence: valid },
    { settlementEvidenceStatus: { status: 'qualified' }, settlementEvidence: valid },
    { settlementEvidenceStatus: { status: 'qualified' } },
    { settlementEvidenceStatus: { status: 'qualified' }, settlementEvidence: bad(e => { e.commitments[0].links[0].assignedCents = 0; }) },
    { settlementEvidenceStatus: { status: 'qualified' }, settlementEvidence: bad(e => { e.commitments[0].links[0].txRef = 'tx-1'; }) },
    { settlementEvidenceStatus: { status: 'qualified' }, settlementEvidence: bad(e => { e.commitments.push(structuredClone(e.commitments[0])); }) },
    { settlementEvidenceStatus: { status: 'qualified' }, settlementEvidence: bad(e => { e.commitments[0].links[0].effectiveDate = '2026-02-30'; }) },
    { settlementEvidenceStatus: { status: 'qualified' }, settlementEvidence: [] },
    ...reasons.map(reason => ({ settlementEvidenceStatus: { status: 'unavailable', reason } })),
    { settlementEvidenceStatus: { status: 'unavailable', reason: 'not-a-loader-reason' } },
    { settlementEvidenceStatus: { status: 'unavailable' } },
    { settlementEvidenceStatus: { status: 'unavailable', reason: 'pin-unavailable' }, settlementEvidence: valid },
    { settlementEvidenceStatus: { status: 'bogus' } },
    { settlementEvidenceStatus: null },
    { settlementEvidenceStatus: 'qualified', settlementEvidence: valid },
    { settlementEvidenceStatus: ['qualified'] },
    { settlementEvidence: valid },
  ];
}

test('plan spend: settlement outcome is in parity with the Planning and Plan mirrors', () => {
  const ps = loadPlanSpend().sandbox;
  assert.equal(typeof ps.planSpendSettlementOutcome, 'function', 'Plan Spend reads the served settlement outcome');
  const planning = loadPlanning().sandbox;
  const plan = loadPlan().sandbox;
  assert.deepEqual(
    [...vm.runInContext('PLAN_SPEND_SETTLEMENT_REASONS', ps)].sort(),
    [...vm.runInContext('PLANNING_SETTLEMENT_REASONS', planning)].sort(),
    'reason vocabulary matches Planning');
  assert.deepEqual(
    [...vm.runInContext('PLAN_SPEND_SETTLEMENT_REASONS', ps)].sort(),
    [...vm.runInContext('PLAN_SETTLEMENT_REASONS', plan)].sort(),
    'reason vocabulary matches Plan');
  const corpus = settlementCorpus();
  for (let i = 0; i < corpus.length; i++) {
    const d = corpus[i];
    const mine = JSON.stringify(ps.planSpendSettlementOutcome(d));
    assert.equal(mine, JSON.stringify(planning.planningSettlementOutcome(d)), `case ${i}: parity with Planning`);
    assert.equal(mine, JSON.stringify(plan.planSettlementOutcome(d)), `case ${i}: parity with Plan`);
  }
});

test('plan spend: absent status and explicit unconfigured render identically and call Forecast without evidence', () => {
  const a = loadPlanSpend(), b = loadPlanSpend();
  const ra = renderPlanSpendPage(a, fixtureInput(), null);
  const rb = renderPlanSpendPage(b, fixtureInput(), UNCONFIGURED);
  assert.deepEqual(rb, ra);
  assert.equal(a.calls.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(a.calls[0][2], 'settlementEvidence'), false,
    'unconfigured (default-inactive) recommend options carry no settlement evidence key');
  assert.ok(ra['plan-spend-list'].innerHTML.includes('$60.00'), 'legacy output publishes the unrelieved cost');
});

test('plan spend: qualified evidence reaches Forecast.recommend unchanged and its relieved figures are published', () => {
  const loaded = loadPlanSpend();
  const served = QUALIFIED();
  const supplied = structuredClone(served.evidence);
  loaded.sandbox.renderPlanSpend(servedData(fixtureInput(), served), periods());
  assert.equal(loaded.calls.length, 1, 'one dependent Forecast call');
  assert.equal(loaded.calls[0][2].settlementEvidence, served.evidence,
    'the served evidence object itself is passed (no copy, no transformation)');
  assert.deepEqual(served.evidence, supplied, 'the page does not mutate the evidence');
  // Compare supplied evidence with Forecast's own numbers (the test does
  // the arithmetic; the page never does).
  const direct = directRecommend(fixtureInput(), linkEvidence());
  const seq = (direct.fundingSequence || []).find(e => e.id === 'near');
  const assigned = supplied.commitments[0].links[0].assignedCents;
  assert.equal(seq.need, 60 - assigned / 100, 'Forecast relieves the cost by the assigned evidence');
  const list = loaded.dom.element('plan-spend-list').innerHTML;
  assert.ok(list.includes('$35.00'), 'relieved remaining published on Plan Spend');
  const plain = renderPlanSpendPage(loadPlanSpend(), fixtureInput(), null);
  assert.notEqual(list, plain['plan-spend-list'].innerHTML, 'qualified render differs from legacy');
  // Evidence amounts are read only by the structural validator (shape
  // checks, as in the incumbent mirrors); nothing else in the page
  // touches them, so relief can only come from Forecast.
  const src = fs.readFileSync(path.join(ROOT, 'public/plan-spend.js'), 'utf8');
  const start = src.indexOf('function planSpendSettlementEvidenceValid(');
  const end = src.indexOf('\nfunction planSpendSettlementOutcome(');
  assert.ok(start > 0 && end > start, 'validator located');
  const outside = src.slice(0, start) + src.slice(end);
  assert.doesNotMatch(outside, /assignedCents|\.cents\b|\.links\b|\.reversals\b/,
    'Plan Spend never reads evidence amounts outside validation');
});

test('plan spend: unavailable withholds every dependent mount, distinctly per reason, with no Forecast call', () => {
  const renders = REASONS.map(reason => {
    const loaded = loadPlanSpend();
    const mounts = renderPlanSpendPage(loaded, fixtureInput(), UNAVAILABLE(reason));
    assert.equal(loaded.calls.length, 0, `${reason}: no dependent Forecast.recommend call`);
    return mounts;
  });
  for (let i = 0; i < renders.length; i++) {
    const m = renders[i];
    assert.match(m['plan-spend-list'].innerHTML, /data-settlement-evidence="unavailable"/);
    assert.ok(m['plan-spend-list'].innerHTML.includes(REASONS[i]), 'reason named');
    assert.match(m['savings-inventory'].innerHTML, /data-settlement-evidence="unavailable"/,
      'savings inventory replaced by the withheld notice');
    assert.equal(m['plan-spend-lede'].innerHTML, '', 'funding lede cleared');
    assert.equal(m['plan-spend-note'].textContent, '', 'note cleared');
    assert.doesNotMatch(planSpendText(m), /\$\s?\d/, 'no amount (and no substituted zero) is published');
    assert.ok(!planSpendText(m).includes('Invented first club cost'), 'no dependent claim names the cost');
    for (let j = i + 1; j < renders.length; j++) assert.notDeepEqual(renders[i], renders[j]);
  }
});

test('plan spend: withheld output does not depend on the withheld amounts', () => {
  const a = renderPlanSpendPage(loadPlanSpend(), fixtureInput(60), UNAVAILABLE('digest-mismatch'));
  const b = renderPlanSpendPage(loadPlanSpend(), fixtureInput(97), UNAVAILABLE('digest-mismatch'));
  assert.deepEqual(b, a);
  const ready = renderPlanSpendPage(loadPlanSpend(), fixtureInput(97), null);
  assert.notDeepEqual(ready, a, 'control: unconfigured publishes');
});

test('plan spend: malformed or unknown statuses fail closed as invalid-configuration', () => {
  const valid = linkEvidence();
  for (const s of [
    { status: { status: 'qualified' } },
    { status: { status: 'bogus' } },
    { status: { status: 'unavailable', reason: 'not-a-loader-reason' } },
    { status: null },
    { status: { status: 'unavailable', reason: 'pin-unavailable' }, evidence: valid },
    { status: { status: 'qualified' }, evidence: { commitments: [{ goalId: 'commitment:near', links: [] }] } },
  ]) {
    const loaded = loadPlanSpend();
    const data = servedData(fixtureInput(), null);
    data.settlementEvidenceStatus = s.status;
    if (s.evidence !== undefined) data.settlementEvidence = s.evidence;
    loaded.sandbox.renderPlanSpend(data, periods());
    const list = loaded.dom.element('plan-spend-list').innerHTML;
    assert.match(list, /data-settlement-evidence="unavailable"/, JSON.stringify(s.status));
    assert.ok(list.includes('invalid-configuration'));
    assert.equal(loaded.calls.length, 0, 'no Forecast call when malformed');
  }
});

test('plan spend: same-instance transitions never leave stale amounts and recover fully', () => {
  const stale = m => /\$\s?\d/.test(planSpendText(m)) || planSpendText(m).includes('Invented first club cost');
  // legacy -> unavailable
  let loaded = loadPlanSpend();
  assert.ok(stale(renderPlanSpendPage(loaded, fixtureInput(), null)), 'control: legacy publishes amounts');
  assert.ok(!stale(renderPlanSpendPage(loaded, fixtureInput(), UNAVAILABLE('pin-unavailable'))), 'legacy -> unavailable');
  // unavailable -> unconfigured recovery
  const recovered = renderPlanSpendPage(loaded, fixtureInput(), null);
  assert.deepEqual(recovered, renderPlanSpendPage(loadPlanSpend(), fixtureInput(), null), 'unconfigured recovery');
  // qualified -> unavailable
  loaded = loadPlanSpend();
  renderPlanSpendPage(loaded, fixtureInput(), QUALIFIED());
  assert.ok(!stale(renderPlanSpendPage(loaded, fixtureInput(), UNAVAILABLE('document-missing'))), 'qualified -> unavailable');
  // unavailable -> qualified
  const requal = renderPlanSpendPage(loaded, fixtureInput(), QUALIFIED());
  assert.deepEqual(requal, renderPlanSpendPage(loadPlanSpend(), fixtureInput(), QUALIFIED()), 'unavailable -> qualified');
  assert.ok(requal['plan-spend-list'].innerHTML.includes('$35.00'));
});

test('plan spend: operating-plan unavailable gate and empty state are preserved', () => {
  const loaded = loadPlanSpend();
  const data = servedData(fixtureInput(), null);
  data.liveOverlay = { applied: false, operatingPlan: 'unavailable', operatingPlanNote: 'Synthetic stale opening.' };
  loaded.sandbox.renderPlanSpend(data, periods());
  assert.match(loaded.dom.element('plan-spend-list').innerHTML, /data-operating-plan="unavailable"/);
  assert.ok(loaded.dom.element('plan-spend-list').innerHTML.includes('Synthetic stale opening.'));
  const empty = loadPlanSpend().sandbox.planSpendPageHtml({ majorPlans: [] }, null);
  assert.match(empty.list, /data-plan-spend="empty"/);
});

// Savings display closure after #675: cost explanations use Forecast's
// attached facts while all four mounts retain the incumbent publication gate.
const displayFact = (html, name) => html.split(`data-savings-cost-${name}>`)[1]?.split('</dd>')[0];
function displayInput(grouped = false) {
  const x = require('./fixtures/chronological-savings-data').policy(fx.advance(fx.fixture(), '2026-10-07'));
  if (!grouped) {
    x.plan.commitments = x.plan.commitments.filter(c => c.id === 'near');
    delete x.plan.commitments[0].group;
  } else x.plan.commitments[1].label = x.plan.commitments[0].label;
  return x;
}
test('plan spend: native disclosure separates original, assigned and unpaid cost from funding need', () => {
  for (const [cents, paid, unpaid] of [[2500, 25, 35], [6000, 60, 0]]) {
    const loaded = loadPlanSpend(), x = displayInput();
    const mounts = renderPlanSpendPage(loaded, x, { status: { status: 'qualified' }, evidence: linkEvidence(cents) });
    const list = mounts['plan-spend-list'].innerHTML;
    assert.match(displayFact(list, 'original'), /60\.00/);
    assert.ok(displayFact(list, 'paid').includes(paid.toFixed(2)));
    assert.ok(displayFact(list, 'unpaid').includes(unpaid.toFixed(2)));
    assert.match(list, /Funding requirement<\/small>/, 'relieved need is never labelled original Cost');
    assert.match(list, /<details[^>]*>[\s\S]*Original cost/, 'cost explanation remains in the disclosure');
    assert.match(list, /Known means published, not bank-verified/);
  }
});
test('plan spend: group and same-label members print their own attached facts and independent backing', () => {
  const loaded = loadPlanSpend(), x = displayInput(true);
  const list = renderPlanSpendPage(loaded, x, QUALIFIED())['plan-spend-list'].innerHTML;
  assert.match(displayFact(list, 'original'), /230\.00/);
  assert.match(displayFact(list, 'paid'), /25\.00/);
  assert.match(displayFact(list, 'unpaid'), /205\.00/);
  for (const [id, original, paid, unpaid] of [['near', 60, 25, 35], ['far', 170, 0, 170]]) {
    const member = list.split(`data-plan-spend-member="${id}"`)[1].split('</li>')[0];
    assert.ok(displayFact(member, 'original').includes(original.toFixed(2)));
    assert.ok(displayFact(member, 'paid').includes(paid.toFixed(2)));
    assert.ok(displayFact(member, 'unpaid').includes(unpaid.toFixed(2)));
  }
  const before = structuredClone(x);
  x.plan.commitments[0].settledOn = '2026-10-04';
  const retired = renderPlanSpendPage(loadPlanSpend(), x, QUALIFIED())['plan-spend-list'].innerHTML;
  assert.match(displayFact(retired, 'original'), /170\.00/);
  assert.doesNotMatch(retired, /data-plan-spend-member="near"/);
  assert.equal(before.plan.commitments.length, 2, 'synthetic group has exactly two native commitments');
});
test('plan spend: cost markup is replaced across qualified/unavailable/qualified on the same instance', () => {
  const loaded = loadPlanSpend(), x = displayInput();
  const first = renderPlanSpendPage(loaded, x, QUALIFIED());
  assert.match(first['plan-spend-list'].innerHTML, /data-savings-cost-original/);
  const calls = loaded.calls.length;
  const withheld = renderPlanSpendPage(loaded, x, UNAVAILABLE('pin-unavailable'));
  assert.equal(loaded.calls.length, calls, 'unavailable makes no dependent Forecast call');
  assert.doesNotMatch(planSpendText(withheld), /data-savings-cost-|Original cost|Confirmed payment assignments|\$\s?\d/);
  const recovered = renderPlanSpendPage(loaded, x, QUALIFIED());
  assert.deepEqual(recovered, first, 'no stale markup after recovery');
});
test('plan: cost disclosure markup clears on unavailable and returns only from the new qualified publication', () => {
  const loaded = loadPlan(), x = displayInput(true);
  const first = renderPlanPage(loaded, x, QUALIFIED());
  assert.match(first['savings-inventory'].innerHTML, /data-savings-cost-original/);
  const withheld = renderPlanPage(loaded, x, UNAVAILABLE('digest-mismatch'));
  for (const id of ['savings-inventory', 'operating-surface-body'])
    assert.doesNotMatch(withheld[id].innerHTML, /data-savings-cost-|Original cost|Confirmed payment assignments/);
  const recovered = renderPlanPage(loaded, x, QUALIFIED());
  assert.equal(recovered['savings-inventory'].innerHTML, first['savings-inventory'].innerHTML);
});

/* ----------------- renderer-seam composition (real stack) ------ */
// Renderer-seam composition coverage: the join the sections above
// cannot express. Every pin above hands the surfaces a settlement
// outcome built in this file — linkEvidence() runs the Phase 1
// contract directly and servedData() attaches its projection by
// hand. Here the outcome is produced by the real read composition:
// the confirmation controller (scripts/settlement-evidence-
// confirmation.js) commits through the real store over the merged
// file + object adapters in a temp directory, and the serving bridge
// (scripts/settlement-evidence-serving.js) runs the loader over that
// durable state and projects the outcome onto the served object —
// the same fields, produced the production way. The receipt-bound
// read rides as an independent oracle only: it must include the
// controller's own receipt against the same snapshot attach
// publishes; its output is never fed to a renderer and never written
// into a served object. Renderers are fed only JSON-round-tripped
// attach output (the /data.json byte shape).
//
// Synthetic authority/transport, explicitly: the controller's
// authorize and selection resolver are synthetic trusted fixtures
// (the resolver invokes the controller-owned classify closure
// exactly once, so the verdict comes from the real Forecast
// classifier); the object transport is a file-backed double in a
// temp directory; encryption is a synthetic double. This is
// renderer-seam coverage in the vm harness the sections above use —
// NOT browser acceptance, NOT theme or App.rerender acceptance, and
// NOT an implemented whole-view replacement: no production wiring
// performs this composition while the serving is default-inactive.
//
// On base b7280dde this coverage does not exist: this suite imported
// no serving, loader, controller, store or adapter module. That is
// missing coverage, not a failing-before claim — every production
// module below is exercised unchanged.
const rsOs = require('node:os');
const rsCrypto = require('node:crypto');
const rsStoreModule = require(path.join(ROOT, 'scripts/settlement-evidence-store.js'));
const rsFileAdapterModule = require(path.join(ROOT, 'scripts/settlement-evidence-file-adapter.js'));
const rsObjectAdapterModule = require(path.join(ROOT, 'scripts/settlement-evidence-object-adapter.js'));
const rsConfirmationModule = require(path.join(ROOT, 'scripts/settlement-evidence-confirmation.js'));
const rsServingModule = require(path.join(ROOT, 'scripts/settlement-evidence-serving.js'));

const RS_NS = 'gating-composition-fixture';
const rsSha256 = bytes => rsCrypto.createHash('sha256').update(bytes).digest('hex');
const rsEvidence = (over = {}) => ({
  accountId: 'acct-main', currency: 'cad', direction: 'debit',
  date: '2026-10-03', cents: 6000, posted: true, ...over,
});

// Minimal file-backed object transport implementing the object
// adapter's contract (conditional create/replace with version +
// integrity acks, paged list) — the server-seam suite's double,
// layout-compatible: objects are JSON records under
// <root>/objects/<base64url(key)>.json.
function rsMakeFileTransport(root) {
  const dir = path.join(root, 'objects');
  fs.mkdirSync(dir, { recursive: true });
  const fileFor = key => path.join(dir, Buffer.from(key, 'utf8').toString('base64url') + '.json');
  const readRec = key => {
    try { return JSON.parse(fs.readFileSync(fileFor(key), 'utf8')); } catch { return null; }
  };
  const conflict = () => { const e = new Error('synthetic transport: conditional write conflict'); e.code = 'conflict'; return e; };
  return {
    dir,
    fileFor,
    readRaw(key) {
      const rec = readRec(key);
      return rec ? Buffer.from(rec.bytesB64, 'base64') : null;
    },
    async read(key) {
      const rec = readRec(key);
      return rec ? { bytes: Buffer.from(rec.bytesB64, 'base64'), version: rec.version, metadata: { ...rec.metadata } } : null;
    },
    async create(key, bytes, metadata) {
      if (readRec(key)) throw conflict();
      fs.writeFileSync(fileFor(key), JSON.stringify({
        bytesB64: Buffer.from(bytes).toString('base64'), version: 'v1', metadata,
      }));
      return { version: 'v1', integrity: rsSha256(bytes) };
    },
    async replace(key, bytes, version, metadata) {
      const rec = readRec(key);
      if (!rec || rec.version !== version) throw conflict();
      const next = 'v' + (Number.parseInt(version.slice(1), 10) + 1);
      fs.writeFileSync(fileFor(key), JSON.stringify({
        bytesB64: Buffer.from(bytes).toString('base64'), version: next, metadata,
      }));
      return { version: next, integrity: rsSha256(bytes) };
    },
    async list(prefix, cursor) {
      const keys = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
        .map(f => Buffer.from(f.slice(0, -'.json'.length), 'base64url').toString('utf8'))
        .filter(k => k.startsWith(prefix)).sort();
      const offset = cursor === null ? 0 : Number.parseInt(cursor, 10);
      const page = keys.slice(offset, offset + 2);
      return {
        entries: page.map(k => ({ key: k, metadata: { ...readRec(k).metadata } })),
        nextCursor: offset + 2 < keys.length ? String(offset + 2) : null,
      };
    },
  };
}

// Synthetic encryption double (the adapter never decrypts; backups
// are owner-recovery-only by design). Output always differs from
// plaintext.
const rsSyntheticEncrypt = async bytes => Buffer.concat([
  Buffer.from('synthetic-enc:'), Buffer.from(bytes).reverse(),
]);

const rsTreeHash = root => {
  const out = [];
  const walk = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out.push(path.relative(root, p) + ':' + rsSha256(fs.readFileSync(p)));
    }
  };
  walk(root);
  return out.join('\n');
};

// The real read stack over one durable fixture: merged adapters,
// real store (bootstrapped genesis), real controller, and servings
// over the adapters' real async read methods — the server-seam §9
// composition, rebuilt here because neither suite exports helpers.
async function rsMakeStack() {
  const dir = fs.mkdtempSync(path.join(rsOs.tmpdir(), 'atlas-gating-rs-'));
  const transport = rsMakeFileTransport(path.join(dir, 'vault'));
  const clock = { t: T0 };
  const now = () => (clock.t += 1);
  const openAdapters = () => {
    const fileAdapter = rsFileAdapterModule.createSettlementEvidenceFileAdapter(dir);
    const objectAdapter = rsObjectAdapterModule.createSettlementEvidenceObjectAdapter({
      householdId, namespace: RS_NS, transport, encrypt: rsSyntheticEncrypt,
    });
    return { fileAdapter, objectAdapter };
  };
  const openStore = ({ fileAdapter, objectAdapter }) => rsStoreModule.createSettlementEvidenceStore({
    householdId,
    documentStore: fileAdapter.documentStore, journalStore: fileAdapter.journalStore,
    pinStore: objectAdapter.pinStore, backupStore: objectAdapter.backupStore,
    quarantine: fileAdapter.quarantine, lock: fileAdapter.lock, now,
  });
  const adapters = openAdapters();
  const store = openStore(adapters);
  assert.equal((await store.bootstrap()).status, 'bootstrapped', 'composition store bootstraps genesis');
  const authorize = async ctx => (ctx.ticket === 'synthetic-seam-session' ? { householdId, actorId } : null);
  // Synthetic trusted resolver: one stable provider identity -> tx(1),
  // the 6000-cent posted CAD debit on 2026-10-03, goal commitment:near
  // — the same commitment the gating fixtures render, so the real
  // controller links the very goal these pages publish.
  const resolveSelection = async input => {
    const transactionId = 'synthetic-provider-transaction';
    input.classify(
      { id: transactionId, date: '2026-10-03', amount: 60, categoryLabel: 'Groceries', merchantKnown: true },
      { budget: { categories: [{ id: 'groceries', label: 'Groceries' }], excluded: [] } },
      { currentPeriodActuals: { representedActuals: [], transactions: [] } });
    return {
      matchCount: 1,
      identity: { householdId, source: 'lunchmoney', providerAccountId: 'synthetic-provider-account', transactionId },
      txRef: tx(1), selectionBinding: 'synthetic-private-selection-v1',
      goalId: 'commitment:near', goalBinding: 'synthetic-plan-goal-v1', asOf: '2026-10-04',
      evidence: rsEvidence(),
    };
  };
  const controllerFor = st => rsConfirmationModule.createSettlementEvidenceConfirmation({
    householdId, authorize, resolveSelection, store: st, now,
  });
  const servingFor = (a, over = {}) => rsServingModule.createSettlementEvidenceServing({
    householdId,
    readDocument: over.readDocument || (() => a.fileAdapter.documentStore.read()),
    readPin: over.readPin || (() => a.objectAdapter.pinStore.read()),
  });
  return {
    dir, transport, adapters, store, openAdapters, openStore, controllerFor, servingFor,
    documentFile: adapters.fileAdapter.paths.documentFile,
    ctl: controllerFor(store),
  };
}

const RS_CONTEXT = { ticket: 'synthetic-seam-session' };
const RS_SELECTION = { transaction: 'selection-' + '1'.repeat(32), commitment: 'choice-' + '2'.repeat(32) };

async function rsConfirm(stack, cents) {
  const prepared = await stack.ctl.prepare(RS_CONTEXT, { operationId: op(1), selection: RS_SELECTION, assignedCents: cents });
  assert.equal(prepared.status, 'prepared', 'controller prepares');
  const receipt = await stack.ctl.confirm(RS_CONTEXT, { operationId: op(1), confirmed: true, previewToken: prepared.previewToken });
  assert.equal(receipt.status, 'committed', 'controller commits');
  return receipt;
}

// The durable bytes the two separate reads (oracle, then attach)
// must leave untouched: document bytes, pin bytes, and a hash of
// every file in the fixture tree (journal, backups, vault included).
function rsDurableBytes(stack) {
  return {
    document: fs.readFileSync(stack.documentFile),
    pin: stack.transport.readRaw(RS_NS + '/pin.json'),
    tree: rsTreeHash(stack.dir),
  };
}
function rsAssertBytesUnchanged(stack, before, label) {
  const after = rsDurableBytes(stack);
  assert.ok(after.document.equals(before.document), `${label}: document bytes unchanged`);
  assert.ok(after.pin.equals(before.pin), `${label}: pin bytes unchanged`);
  assert.equal(after.tree, before.tree, `${label}: no durable write anywhere in the fixture tree`);
}

const rsRoundTrip = value => JSON.parse(JSON.stringify(value));
const rsBaseServed = () => servedData(fixtureInput(), null);

// renderPlanPage's preamble, but over an already-built served object
// (the round-tripped attach output), with B1's selected-month state
// as an option.
function rsRenderPlanData(loaded, data, month) {
  const { sandbox } = loaded;
  vm.runInContext(`state.debts = []; state.extraFacilities = undefined;`, sandbox);
  vm.runInContext(`loadKnobs({ scenario: 'expected', targetBuffer: 20, extraDebtMonthly: 0 });`, sandbox);
  if (month) vm.runInContext(`budgetGranularity = 'month'; budgetSelectedMonth = '${month}';`, sandbox);
  sandbox.renderPlan(data, periods(), []);
  return snapshotMounts(loaded.dom);
}

// Same-instance snapshot comparison for the Plan page. The fake DOM
// registers an element only when a render touches it, so a later
// snapshot on one instance can list a mount the first snapshot never
// registered (the unavailable path touches mounts the qualified path
// leaves alone). Every mount the first render DID publish must match
// exactly; a mount registered only later must be in the untouched
// default state — no content may hide in the registry gap.
function rsAssertSameMounts(actual, expected, label) {
  for (const [id, mount] of Object.entries(expected)) {
    assert.deepEqual(actual[id], mount, `${label}: mount ${id} matches`);
  }
  for (const [id, mount] of Object.entries(actual)) {
    if (!(id in expected)) {
      assert.deepEqual(mount, {
        innerHTML: '', textContent: '', className: '', hidden: false, attrs: {}, planStatus: undefined,
      }, `${label}: mount ${id} was only registered, never published to`);
    }
  }
}

// renderPlanSpendPage's mount capture, over an already-built served
// object.
function rsRenderPlanSpendData(loaded, data) {
  loaded.sandbox.renderPlanSpend(data, periods());
  const out = {};
  for (const id of PLAN_SPEND_MOUNTS) {
    const el = loaded.dom.element(id);
    out[id] = { innerHTML: el.innerHTML, textContent: el.textContent };
  }
  return out;
}

test('renderer-seam composition: a real controller commit publishes through attach to Plan Spend and Plan', async () => {
  const stack = await rsMakeStack();
  const receipt = await rsConfirm(stack, 2500);
  assert.deepEqual(Object.keys(receipt).sort(), ['digest', 'operationId', 'revision', 'status'],
    'the controller receipt is exactly the four-field public shape');
  assert.ok(!Object.hasOwn(receipt, 'actorId'), 'no embedded actor is projected');
  assert.deepEqual(await stack.ctl.outcome(RS_CONTEXT, { operationId: op(1) }), receipt,
    'controller outcome returns the original receipt');
  const serving = stack.servingFor(stack.adapters);
  const beforeReads = rsDurableBytes(stack);
  // Oracle (independent): the receipt-bound read includes the
  // controller's own receipt against this snapshot. Its output is
  // asserted here and never fed to a renderer.
  const oracle = await serving.receiptBoundPublication(receipt, actorId);
  assert.equal(oracle.status, 'included', 'receipt-bound oracle includes the controller receipt');
  assert.deepEqual(Object.keys(oracle).sort(), ['evidence', 'status']);
  const attached = await serving.attach(rsBaseServed());
  rsAssertBytesUnchanged(stack, beforeReads, 'oracle + attach reads');
  assert.deepEqual(attached.settlementEvidenceStatus, { status: 'qualified' });
  assert.deepEqual(attached.settlementEvidence, linkEvidence(2500),
    'the real stack publishes the same effective evidence the contract builds directly');
  assert.deepEqual(oracle.evidence, attached.settlementEvidence,
    'the oracle publication is the same snapshot attach publishes');
  // Plan Spend, from attach output only: identical mounts to the
  // incumbent hand-built qualified render, with the relieved figure.
  const spend = rsRenderPlanSpendData(loadPlanSpend(), rsRoundTrip(attached));
  assert.deepEqual(spend, renderPlanSpendPage(loadPlanSpend(), fixtureInput(), QUALIFIED()),
    'attach-driven Plan Spend render matches the incumbent qualified render');
  assert.ok(spend['plan-spend-list'].innerHTML.includes('$35.00'),
    'relieved remaining is published on Plan Spend');
  // Named cost facts on the disclosure fixture: the original cost
  // may stand at 60.00; what relief moves is paid / unpaid.
  const displayAttached = await serving.attach(servedData(displayInput(), null));
  const displaySpend = rsRenderPlanSpendData(loadPlanSpend(), rsRoundTrip(displayAttached));
  const list = displaySpend['plan-spend-list'].innerHTML;
  assert.match(displayFact(list, 'original'), /60\.00/, 'original cost stands at 60.00');
  assert.ok(displayFact(list, 'paid').includes('25.00'), 'linked paid is 25.00');
  assert.ok(displayFact(list, 'unpaid').includes('35.00'),
    'unpaid remaining is 35.00, not the original 60.00');
  // Plan, from attach output only.
  const plan = rsRenderPlanData(loadPlan(), rsRoundTrip(await serving.attach(rsBaseServed())));
  assert.deepEqual(plan, renderPlanPage(loadPlan(), fixtureInput(), QUALIFIED()),
    'attach-driven Plan render matches the incumbent qualified render');
  assert.ok(plan['major-plans-list'].innerHTML.includes('Invented first club cost'),
    'major plans name the commitment');
  assert.ok(plan['major-plans-list'].innerHTML.includes('$35.00'),
    'relieved remaining is published on Plan');
  assert.deepEqual(await stack.ctl.outcome(RS_CONTEXT, { operationId: op(1) }), receipt,
    'the original receipt is unchanged after every read');
});

test('renderer-seam composition: same-instance qualified → unavailable → recovered, no second commit', async () => {
  const stack = await rsMakeStack();
  const receipt = await rsConfirm(stack, 2500);
  const serving = stack.servingFor(stack.adapters);
  const oracle = await serving.receiptBoundPublication(receipt, actorId);
  assert.equal(oracle.status, 'included', 'receipt-bound oracle includes the controller receipt');
  const afterCommit = rsDurableBytes(stack);
  const qualifiedData = async () => rsRoundTrip(await serving.attach(rsBaseServed()));
  // Plan Spend on one page instance.
  const spendLoaded = loadPlanSpend();
  const spendFirst = rsRenderPlanSpendData(spendLoaded, await qualifiedData());
  assert.ok(spendFirst['plan-spend-list'].innerHTML.includes('$35.00'),
    'prime: the qualified attach output publishes the relieved remaining');
  const callsAfterPrime = spendLoaded.calls.length;
  // Wholesale replacement of the served object with a fresh attach
  // output taken while the pin reader fails (the C6 idiom).
  const downServing = stack.servingFor(stack.adapters, {
    readPin: () => Promise.reject(new Error('synthetic pin transport down')),
  });
  const downAttached = await downServing.attach(rsBaseServed());
  assert.deepEqual(downAttached.settlementEvidenceStatus, { status: 'unavailable', reason: 'pin-unavailable' });
  assert.ok(!('settlementEvidence' in downAttached), 'unavailable attach carries no evidence');
  const spendWithheld = rsRenderPlanSpendData(spendLoaded, rsRoundTrip(downAttached));
  assert.equal(spendLoaded.calls.length, callsAfterPrime,
    'the unavailable replacement makes no dependent Forecast call');
  assert.match(spendWithheld['plan-spend-list'].innerHTML, /data-settlement-evidence="unavailable"/,
    'the withheld notice replaces the dependent list');
  assert.doesNotMatch(planSpendText(spendWithheld), /\$\s?\d/,
    'no amount survives the unavailable replacement');
  assert.ok(!planSpendText(spendWithheld).includes('Invented first club cost'),
    'no dependent claim names the commitment under unavailable');
  // Read-only recovery on the same instance: a fresh attach over the
  // restored readers republishes exactly the first render.
  const spendRecovered = rsRenderPlanSpendData(spendLoaded, await qualifiedData());
  assert.deepEqual(spendRecovered, spendFirst,
    'recovered Plan Spend render matches the first qualified render');
  // Plan on one page instance.
  const planLoaded = loadPlan();
  const planFirst = rsRenderPlanData(planLoaded, await qualifiedData());
  const planWithheld = rsRenderPlanData(planLoaded, rsRoundTrip(await downServing.attach(rsBaseServed())));
  assert.equal(planWithheld['status-band'].planStatus, 'unavailable',
    'status band carries the unavailable verdict');
  assert.ok(!planWithheld['major-plans-list'].innerHTML.includes('Invented first club cost'),
    'dependent major-plan claims clear under unavailable');
  assert.ok(planWithheld['snapshot-tiles'].innerHTML.includes('Consumer debt'),
    'independent reported debt stocks stay published under unavailable');
  const planRecovered = rsRenderPlanData(planLoaded, await qualifiedData());
  rsAssertSameMounts(planRecovered, planFirst,
    'recovered Plan render matches the first qualified render');
  // Nothing above committed again: durable bytes, the recorded
  // revision / operation count and the original receipt are all
  // unchanged by the failure + recovery sequence.
  rsAssertBytesUnchanged(stack, afterCommit, 'failure + recovery sequence');
  const parsed = JSON.parse(fs.readFileSync(stack.documentFile, 'utf8'));
  assert.equal(parsed.revision, 1, 'still the original revision — no second commit');
  assert.equal(parsed.operations.length, 1, 'still the original single operation');
  assert.deepEqual(await stack.ctl.outcome(RS_CONTEXT, { operationId: op(1) }), receipt,
    'the original receipt is unchanged after failure and recovery');
});

test('renderer-seam composition: selected-month change and repeated renders follow Forecast semantics', async () => {
  const stack = await rsMakeStack();
  const receipt = await rsConfirm(stack, 2500);
  const serving = stack.servingFor(stack.adapters);
  assert.equal((await serving.receiptBoundPublication(receipt, actorId)).status, 'included',
    'receipt-bound oracle includes the controller receipt');
  const data = rsRoundTrip(await serving.attach(rsBaseServed()));
  // Repeated renders of the same qualified object are identical.
  const planLoaded = loadPlan();
  const first = rsRenderPlanData(planLoaded, data);
  assert.deepEqual(rsRenderPlanData(planLoaded, data), first,
    'repeated Plan renders of the same object are identical');
  const spendLoaded = loadPlanSpend();
  const spendFirst = rsRenderPlanSpendData(spendLoaded, data);
  assert.deepEqual(rsRenderPlanSpendData(spendLoaded, data), spendFirst,
    'repeated Plan Spend renders of the same object are identical');
  // Selected-month change on the used instance: the render must be
  // exactly what a fresh instance produces for that month over the
  // same qualified object — Forecast semantics decide the figures,
  // and no stale remaining-need state may survive the change.
  const monthSame = rsRenderPlanData(planLoaded, data, '2026-10');
  const monthFresh = rsRenderPlanData(loadPlan(), data, '2026-10');
  assert.deepEqual(monthSame, monthFresh,
    'month render on the used instance matches a fresh instance at that month');
  assert.deepEqual(rsRenderPlanData(planLoaded, data, '2026-10'), monthFresh,
    'repeated month renders are identical');
  assert.ok(monthFresh['major-plans-list'].innerHTML.includes('$35.00'),
    'the relieved remaining is the published need in the changed month');
  assert.deepEqual(await stack.ctl.outcome(RS_CONTEXT, { operationId: op(1) }), receipt,
    'the original receipt is unchanged');
});
