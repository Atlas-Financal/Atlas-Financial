'use strict';
// Atlas 1.0 acceptance scoreboard harness.
//
// Every scenario drives the same path a household's Budget page takes:
//
//   invented raw Lunch Money payload
//     -> scripts/provider-observe.js normalizeLunchMoneyPayload
//     -> scripts/provider-observe.js sanitizedCurrentPeriodActuals
//     -> served /data.json liveOverlay.currentPeriodActuals
//     -> the real public/index.html boot (public/forecast.js, public/plan.js,
//        public/savings-inventory.js) in headless Chromium
//     -> the rendered Budget page text.
//
// Expected values live in each check file and are written by hand from the
// adopted acceptance spec. Nothing here computes an expected figure, and no
// scenario reads data.json or any household value: every account, amount,
// date and identity is invented.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const ORIGIN = 'http://acceptance.test';
const clone = x => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- world ---
// One invented household. Scenarios start from this and change only what
// their Given clause names.
//   Bills account  chequing-a  provider acct 9001
//   Spending acct  chequing-b  provider acct 9002
//   Savings        savings     provider acct 9003
//   Card           card-a      provider acct 9004 (revolving credit)
// Payroll 1,400 biweekly, anchored on a Friday so the current pay period is
// Oct 9 - Oct 22, 2026 for an as-of of Oct 14.
const ACCOUNTS = [
  { id: 'chequing-a', providerId: 9001, role: 'household-cash', collection: 'cash', label: 'Invented bills', value: 2000 },
  { id: 'chequing-b', providerId: 9002, role: 'household-cash', collection: 'cash', label: 'Invented spending', value: 500 },
  { id: 'savings', providerId: 9003, role: 'household-reserve', collection: 'cash', label: 'Invented savings', value: 1000, reserve: true },
  { id: 'savings-dont-touch', providerId: 9005, role: 'household-reserve', collection: 'cash', label: 'Invented reserve', value: 0, reserve: true, held: true },
];
const CATEGORIES = [
  { id: 101, name: 'Groceries' },
  { id: 102, name: 'Restaurants' },
  { id: 103, name: 'Fuel' },
  { id: 104, name: 'Utilities' },
  { id: 105, name: 'Internet' },
  { id: 106, name: 'Trip' },
  { id: 107, name: 'Gifts' },
  { id: 108, name: 'Payroll', is_income: true },
  { id: 109, name: 'Uncategorised' },
  { id: 110, name: 'Transfer', exclude_from_totals: true },
];

function baseWorld(asOf = '2026-10-14') {
  return {
    asOf,
    accounts: clone(ACCOUNTS),
    categories: clone(CATEGORIES),
    tags: [],
    income: [{ id: 'payroll', label: 'Invented salary', frequency: 'biweekly', anchor: '2026-10-09', amount: 1400, confidence: 'confirmed' }],
    bills: [],
    commitments: [],
    groups: [],
    budget: [
      { id: 'groceries', label: 'Groceries', class: 'essential', plannedPayday: 300, confidence: 'confirmed', from: ['Groceries'] },
      { id: 'restaurants', label: 'Restaurants', class: 'discretionary', plannedPayday: 100, confidence: 'confirmed', from: ['Restaurants'] },
    ],
    transactions: [], // raw Lunch Money shape
    // Payroll is identified by its employer payee on the Bills account.
    identityRules: [{ eventId: 'payroll', payeePattern: 'Invented employer', atlasAccountId: 'chequing-a', direction: 'credit' }],
    windowStart: '2026-09-01',
    coverage: { complete: true, hasMore: false }, // provider transaction window declaration
    pendingCoverage: { basis: 'is_pending-unbounded', complete: true, hasMore: false },
    savingsPool: null,
    links: null, // A4a item links: [{ categoryId | tagId, goalRef, occurrenceDate, effectiveFrom, effectiveThrough }]
    planPatch: null,
    dataPatch: null,
  };
}

// Raw Lunch Money transaction. Lunch Money publishes debits as positive
// strings and credits as negative strings.
let autoId = 500000;
function lm(fields) {
  const account = fields.account || 'chequing-b';
  const a = ACCOUNTS.find(x => x.id === account);
  const raw = {
    id: fields.id != null ? fields.id : ++autoId,
    date: fields.date,
    amount: typeof fields.amount === 'number' ? fields.amount.toFixed(2) : fields.amount,
    currency: 'cad',
    payee: fields.payee || 'Invented payee',
    original_name: fields.originalName || fields.payee || 'INVENTED PAYEE',
    notes: fields.notes || null,
    category_id: fields.category != null ? (CATEGORIES.find(c => c.name === fields.category) || { id: fields.category }).id : null,
    plaid_account_id: a ? a.providerId : fields.providerAccountId,
    is_pending: fields.pending === true,
    status: fields.pending ? 'pending' : 'cleared',
    tags: fields.tags || [],
    ...(fields.tagIds ? { tag_ids: fields.tagIds } : {}),
  };
  if (fields.omitId) delete raw.id;
  for (const k of Object.keys(fields.raw || {})) raw[k] = fields.raw[k];
  return raw;
}

function planOf(w) {
  const plan = {
    opening: { asOf: w.asOf, priorAsOf: '2026-10-09', representedEvents: [] },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    startingCash: { breakdown: w.accounts.filter(a => !a.held).map(a => ({ id: a.id, label: a.label, value: a.value, evidenceDate: w.asOf, confidence: a.confidence || 'confirmed' })) },
    income: clone(w.income),
    bills: clone(w.bills),
    obligations: [],
    commitments: clone(w.commitments),
    groups: clone(w.groups),
    funding: { options: [] },
    budget: { categories: clone(w.budget) },
  };
  if (w.savingsPool) {
    // One combined Savings pool backing every listed commitment in
    // need-date order (owner rule R2). Savings stock is provider-observed.
    const sav = w.accounts.find(a => a.id === 'savings');
    const sdt = w.accounts.find(a => a.id === 'savings-dont-touch').value;
    plan.startingCash.heldElsewhere = [{ id: 'savings-dont-touch', value: sdt, class: 'purpose-reserve' }];
    plan.savingsEarmarks = { version: 1, currency: 'CAD', history: [],
      allocationPolicy: { order: 'due-date-first-combined-pool', effectiveFrom: '2026-10-01', source: 'Invented owner policy' },
      pools: [{ id: 'pool', accountId: 'savings', label: 'Invented pool', role: 'purpose-reserve', purpose: 'Invented items',
        goalRefs: w.commitments.map(c => ({ kind: 'commitment', id: c.id })) },
        { id: 'reserve', accountId: 'savings-dont-touch', label: 'Invented reserve', role: 'purpose-reserve', purpose: 'Invented reserve',
          reconciledOn: w.asOf, goalRefs: [] }] };
    // A4a item links name a confirmed anchor revision (PR #840 shape).
    if (w.links) plan.savingsEarmarks.history = [{ revision: 1, confirmedAt: '2026-10-01', source: 'Invented anchor confirmation',
      pools: [{ poolId: 'pool', allocations: [] }] }];
    plan.savingsPoolObservation = { asOf: w.asOf, accounts: [
      { accountId: 'savings', value: sav.value, currency: 'CAD', source: 'provider-observe:lunchmoney', evidenceDate: w.asOf, pendingState: 'clear' },
      { accountId: 'savings-dont-touch', value: sdt, currency: 'CAD', source: 'provider-observe:lunchmoney', evidenceDate: w.asOf, pendingState: 'clear' }] };
  }
  if (typeof w.planPatch === 'function') w.planPatch(plan);
  return plan;
}

function accountMapOf(w) {
  return {
    schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'acceptance',
    ...(w.links ? { savingsLinks: { version: 1, anchorRevision: 1, links: w.links } } : {}),
    // Reserve accounts are mapped only when a Savings pool is configured:
    // the observer refuses a reserve role without one.
    mappings: w.accounts.filter(a => !a.reserve || w.savingsPool).map(a => ({ providerAccountId: String(a.providerId), atlasRole: a.role,
      canonical: { id: a.id, collection: a.collection } })),
  };
}

function rawPayload(w) {
  return {
    categories: w.categories,
    tags: w.tags,
    plaid_accounts: w.accounts.filter(a => !a.reserve || w.savingsPool).filter(a => !a.unobserved).map(a => ({ id: a.providerId, name: a.label, type: a.role === 'revolving-credit' ? 'credit' : 'depository',
      balance: String(a.value), currency: 'cad', balance_last_update: w.asOf + 'T12:00:00.000Z' })),
    transactions: w.transactions,
    transactionWindow: { startDate: w.windowStart, endDate: w.asOf, ...w.coverage },
    pendingCoverage: w.pendingCoverage,
    fetchedAt: w.asOf + 'T18:00:00.000Z',
  };
}

// Bill identity rules: a bill is matched by its payee identity on its own
// account, never by amount alone (bills blueprint 6595179923).
function identityOf(w) {
  const rules = w.bills.filter(b => b.payee).map(b => ({ eventId: b.id, payeePattern: b.payee,
    atlasAccountId: b.account || 'chequing-a', direction: 'debit', ...(b.rule || {}) }));
  return { rules: rules.concat(w.identityRules || []) };
}

function canonicalOf(w, plan) {
  return { meta: { asOf: w.asOf, title: 'Invented acceptance household' },
    accounts: [], debts: clone(w.debts || []), revolvingExtra: [], plan };
}

// The production path: scripts/live-plan.js fromObservation runs
// provider-observe's observe() over the raw payload and overlays the result
// onto the canonical document exactly as server.js serves /data.json.
// A failure is what a failed refresh is: the page gets the canonical
// document without a live overlay.
function dataOf(w) {
  const Live = require('../../scripts/live-plan');
  const plan = planOf(w);
  let data, packet = null, error = null;
  try {
    if (w.failRefresh) throw new Error('Invented refresh failure');
    const result = Live.fromObservation({ data: canonicalOf(w, plan), payload: rawPayload(w),
      accountMap: accountMapOf(w), identity: identityOf(w) });
    data = result.data;
    packet = data.liveOverlay && data.liveOverlay.currentPeriodActuals || null;
  } catch (e) {
    error = e;
    data = canonicalOf(w, plan);
  }
  // Captured period history (A11 #818). No capture format exists on main;
  // A11 defines how `w.capturedHistory` reaches the served document here.
  if (w.capturedHistory != null && typeof w.attachCapturedHistory === 'function') w.attachCapturedHistory(data, w.capturedHistory);
  if (typeof w.dataPatch === 'function') w.dataPatch(data, packet);
  return { data, packet, error };
}
function observe(w) { const r = dataOf(w); return { plan: r.data.plan, packet: r.packet, error: r.error }; }

// ------------------------------------------------------------- browser ---
let browserPromise = null;
function browser() {
  if (!browserPromise) {
    const { chromium } = require('playwright');
    browserPromise = chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  }
  return browserPromise;
}
async function closeBrowser() {
  if (browserPromise) { const b = await browserPromise; browserPromise = null; await b.close(); }
}

function contentType(file) {
  return file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css'
    : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
}

// Serve one data document (or a sequence: a reload serves the next one) to
// the real page, intercepting every request. Nothing leaves the process.
async function openBudget(dataDocs, opts = {}) {
  const docs = Array.isArray(dataDocs) ? dataDocs : [dataDocs];
  let served = 0;
  const b = await browser();
  const page = await b.newPage({ viewport: { width: opts.width || 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== ORIGIN) return route.abort();
    if (route.request().method() !== 'GET') return route.fulfill({ status: 405, body: '' });
    if (u.pathname === '/data.json') { const d = docs[Math.min(served, docs.length - 1)]; served += 1; return route.fulfill({ json: d }); }
    if (opts.periods && u.pathname === '/periods.json') return route.fulfill({ json: opts.periods });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
    const file = path.join(PUBLIC, u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file), contentType: contentType(file) });
  });
  if (opts.exposeData) await page.addInitScript(d => { window.__atlasAcceptanceData = d; }, docs[0]);
  await page.goto(ORIGIN + '/');
  await page.locator('[data-budget-surface]').waitFor({ timeout: 20000 });
  const api = {
    page, errors,
    async text(selector = '[data-budget-surface]') {
      const loc = page.locator(selector);
      if (!(await loc.count())) return '';
      return (await loc.allInnerTexts()).join('\n');
    },
    // textContent of every match, including collapsed sections; one entry
    // per element, whitespace collapsed.
    async rows(selector) {
      return page.evaluate(sel => [...document.querySelectorAll(sel)].map(e => e.textContent.replace(/\s+/g, ' ').trim()), selector);
    },
    async step(n) {
      const dir = n > 0 ? '1' : '-1';
      for (let i = 0; i < Math.abs(n); i++) {
        const before = await page.evaluate(() => [...document.querySelectorAll('[data-budget-window-range]')].map(e => e.innerText).join('|'));
        await page.evaluate(d => { const b = [...document.querySelectorAll(`[data-budget-window-step="${d}"]`)].find(x => x.getAttribute('aria-disabled') !== 'true'); if (b) b.click(); }, dir);
        await page.waitForFunction(b4 => [...document.querySelectorAll('[data-budget-window-range]')].map(e => e.innerText).join('|') !== b4, before, { timeout: 5000 }).catch(() => {});
      }
    },
    async range() { return page.locator('[data-budget-window-range]:visible').first().innerText().catch(() => ''); },
    async reload() {
      await page.reload();
      await page.locator('[data-budget-surface]').waitFor({ timeout: 20000 });
    },
    async openDetail(selector) {
      const clicked = await page.evaluate(sel => {
        const all = [...document.querySelectorAll(sel)];
        const el = all.find(e => e.getClientRects().length) || all[0];
        if (!el) return false;
        el.click();
        return true;
      }, selector);
      if (!clicked) return '';
      await page.waitForFunction(() => document.querySelector('[data-budget-detail-sheet]')?.open, null, { timeout: 5000 }).catch(() => {});
      const t = await api.text('[data-budget-detail-body]');
      await page.keyboard.press('Escape');
      return t;
    },
    close: () => page.close(),
  };
  return api;
}

// Render a world on the Budget page and hand the page to `fn`.
async function withBudget(worlds, fn, opts) {
  const list = Array.isArray(worlds) ? worlds : [worlds];
  const built = list.map(dataOf);
  const p = await openBudget(built.map(x => x.data), opts);
  try { return await fn(p, built.map(x => x.packet), built); } finally { await p.close(); }
}

// Everything a scenario usually reads, as whitespace-collapsed text.
async function snap(p) {
  const one = async sel => (await p.rows(sel)).join(' | ');
  const out = {
    range: await p.range(),
    all: await one('[data-budget-surface]'),
    sections: await p.rows('[data-operating-question]'),
    household: await one('[data-operating-question="06"]'),
    savings: await one('[data-operating-question="savings"]'),
    goals: await p.rows('[data-budget-savings-goal]'),
    bills: await p.rows('[data-budget-bill-open][data-budget-browse-origin="bills"]'),
    categories: await p.rows('[data-budget-category-open][data-budget-browse-origin="spending"]'),
    hero: await one('[data-budget-today-evidence], .budget-today, [data-budget-cash-how]'),
  };
  // The Income step is found by its label, not by a question number.
  out.income = section(out, 'Income');
  return out;
}
function section(s, label) { return s.sections.find(t => t.replace(/^[^A-Za-z]*/, '').startsWith(label)) || ''; }
function goal(s, label) { return s.goals.find(t => t.startsWith(label)) || ''; }
function category(s, label) { return s.categories.find(t => t.startsWith(label)) || ''; }
function bill(s, label) { return s.bills.find(t => t.includes(label)) || ''; }
// The figure printed right after a goal-row label ("Paid", "Still to fund"),
// skipping trust words; '' when the label is absent.
function figure(text, label) {
  const m = String(text).match(new RegExp(esc(label) + '\\s*(?:≈\\s*)?(?:(?:estimated|calculated|confirmed|verified)\\s*)?(\\$[\\d,]+\\.\\d\\d|Unknown|Unavailable)'));
  return m ? m[1] : '';
}
// Count how many times one invented payee appears as a listed transaction.
function occurrences(hay, needle) { return String(hay).split(needle).length - 1; }

// ------------------------------------------------------------- assertions -
class ScenarioFailure extends Error {}
function money(n) { return '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function expectIncludes(hay, needle, why) {
  if (!String(hay).includes(needle)) throw new ScenarioFailure(`${why}: expected the page to show "${needle}"`);
}
// Positive control for every negative assertion: absence over a section that
// is not on the page proves nothing, so an empty haystack fails.
function present(hay, why) {
  if (!String(hay == null ? '' : hay).trim()) throw new ScenarioFailure(`${why}: positive control failed, the checked text is not on the page`);
}
function expectExcludes(hay, needle, why) {
  present(hay, why);
  if (String(hay).includes(needle)) throw new ScenarioFailure(`${why}: the page must not show "${needle}"`);
}
function expectMatch(hay, re, why) {
  if (!re.test(String(hay))) throw new ScenarioFailure(`${why}: expected ${re}`);
}
function expectNoMatch(hay, re, why) {
  present(hay, why);
  if (re.test(String(hay))) throw new ScenarioFailure(`${why}: must not match ${re}`);
}
function expect(cond, why) { if (!cond) throw new ScenarioFailure(why); }
// The figure after `label` in `text` equals `amount` (or, with `not`, does not).
function expectFigure(text, label, amount, why, not) {
  if (not) present(text, why);
  const got = figure(text, label);
  if (not ? got === amount : got !== amount) throw new ScenarioFailure(`${why}: ${label} shows "${got || 'nothing'}"${not ? '' : `, expected "${amount}"`}`);
}
// A labelled amount: "<label> ... $N" within one line of rendered text.
function lineWith(hay, label) {
  return String(hay).split('\n').filter(l => l.includes(label));
}

module.exports = {
  ROOT, clone, baseWorld, lm, planOf, accountMapOf, rawPayload, identityOf, observe, dataOf,
  openBudget, withBudget, closeBrowser, money, esc, snap, section, goal, category, bill, occurrences, figure,
  expect, present, expectFigure, expectIncludes, expectExcludes, expectMatch, expectNoMatch, lineWith, ScenarioFailure,
};
