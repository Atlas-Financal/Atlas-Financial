'use strict';
/* Synthetic observation -> real server overlay -> Forecast -> registered Credit
 * renderer. Monetary expectations are fixed independent fixture arithmetic.
 * The canonical prose deliberately contains amounts an overlay cannot refresh.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Forecast = require('../public/forecast.js');
const Live = require('../scripts/live-plan.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const OPENING = '2026-03-10';
const CURRENT = '2026-03-11';
const canonical = {
  meta: { asOf: OPENING }, revolvingExtra: [],
  debts: [{ id: 'card-a', label: 'Synthetic card', secured: false,
    balance: 100, pending: 0, pendingUnknown: false, limit: 1000,
    rate: 20, confidence: 'verified',
    structure: 'Revolving credit. Posted $100.00 + $0.00 pending. Activity: $123.45 in purchases.' }],
  plan: {
    windowDays: 91, opening: { asOf: OPENING },
    defaults: { scenario: 'expected', targetBuffer: 0, extraDebtMonthly: 0 },
    startingCash: { breakdown: [
      { id: 'chequing-a', label: 'Synthetic bills', value: 500 },
      { id: 'chequing-b', label: 'Synthetic weekly', value: 200 },
      { id: 'savings', label: 'Synthetic reserve', value: 50 },
    ] },
    income: [{ id: 'pay', label: 'Synthetic pay', frequency: 'biweekly',
      anchor: '2026-03-06', amount: 1000, confidence: 'confirmed' }],
    obligations: [{ id: 'card-a', debtId: 'card-a', effect: 'payment',
      label: 'Synthetic minimum', frequency: 'monthly', day: 15,
      amount: 10, confidence: 'estimated', payingAccount: 'chequing-a' }],
    bills: [], commitments: [],
  },
};
const map = {
  schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture',
  owns: 'Synthetic fixture identities only.', does_not_own: 'Financial facts or write authority.',
  mappings: [
    { providerAccountId: '9001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
    { providerAccountId: '9002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
    { providerAccountId: '9003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-cash' },
    { providerAccountId: '9004', canonical: { collection: 'debts', id: 'card-a' }, atlasRole: 'revolving-credit' },
  ],
};
function payload() {
  return {
    provider: 'lunchmoney', fetchedAt: CURRENT + 'T18:00:00.000Z',
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, startDate: null, endDate: null },
    accounts: [500, 200, 50, 140].map((balance, i) => ({
      id: 9001 + i, name: 'Synthetic account ' + i,
      type: i === 3 ? 'credit' : 'cash',
      subtype: i === 3 ? 'credit_card' : 'checking', balance,
      currency: 'cad', updated_at: CURRENT + 'T17:55:00.000Z', balance_last_update: CURRENT + 'T17:55:00.000Z',
      ...(i === 3 ? { credit_limit: 1000 } : {}),
    })),
    transactions: [{ id: 9901, account_id: 9004, date: CURRENT,
      amount: 25, payee: 'Synthetic purchase', is_pending: true }],
  };
}

function page() {
  const elements = {};
  const hooks = [];
  const app = read('public/app.js');
  const helpers = ['money', 'money2', 'escapeHtml', 'pct', 'fmtDate', 'fmtDateLong', 'fmtDateFull']
    .map(name => app.match(new RegExp('^const ' + name + ' = .*$', 'm'))[0]).join('\n');
  const ctx = { Forecast, elements, App: { register(fn) { hooks.push(fn); }, boot() {} } };
  vm.runInNewContext(helpers + '\nconst $ = id => elements[id] || (elements[id] = { innerHTML: "", textContent: "" });\n'
    + read('public/credit.js'), ctx, { filename: 'public/credit.js' });
  assert.equal(hooks.length, 1);
  return data => {
    const before = JSON.stringify(data);
    hooks[0](data);
    assert.equal(JSON.stringify(data), before, 'renderer must not mutate served state');
    return JSON.parse(JSON.stringify(elements));
  };
}
const render = page();
const strip = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const fact = (html, name) => strip(html.match(new RegExp('<div class="credit-fact" data-credit-fact="' + name + '"[^>]*>[\\s\\S]*?</div>'))[0]);
const description = html => strip(html.match(/<p class="credit-structure">([\s\S]*?)<\/p>/)[1]);
const dateText = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-CA', { day: 'numeric', month: 'long', year: 'numeric' });
function checkDescription(html) {
  const text = description(html);
  assert.match(text, /revolving credit/i, 'retain useful account structure');
  assert.match(text, /purchases.*interest.*balance.*payments/i, 'retain how revolving balances work');
  assert.doesNotMatch(text, /\$|\d|Activity|pending/i, 'no duplicated monetary or historical activity prose');
}
function checkDates(elements, asOf) {
  assert.ok(elements['credit-note'].textContent.includes(dateText(asOf)), 'note keeps served financial as-of');
  assert.ok(elements['credit-cards-lede'].textContent.includes(dateText(asOf)), 'lede keeps served opening date');
  assert.match(fact(elements['credit-cards'].innerHTML, 'due'), new RegExp(dateText('2026-03-15')));
  assert.match(fact(elements['credit-cards'].innerHTML, 'minimum'), /≈ \$10\.00.*ESTIMATED/);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-credit-description-'));
  const fixturePath = path.join(dir, 'payload.json');
  const mapPath = path.join(dir, 'map.json');
  const before = JSON.stringify(canonical);
  const canonicalBytes = fs.readFileSync(path.join(ROOT, 'data.json'));
  const snapshots = () => fs.readdirSync(path.join(ROOT, 'snapshots')).sort()
    .filter(file => file.endsWith('.json'))
    .map(file => [file, fs.readFileSync(path.join(ROOT, 'snapshots', file)).toString('base64')]);
  const snapshotBytes = snapshots();
  fs.writeFileSync(mapPath, JSON.stringify(map));
  const serve = async observation => {
    fs.writeFileSync(fixturePath, JSON.stringify(observation));
    return Live.applyForServer(canonical, {
      ATLAS_LIVE_OVERLAY: 'fixture', ATLAS_LIVE_OVERLAY_FIXTURE: fixturePath,
      ATLAS_LIVE_OVERLAY_MAP: mapPath,
    });
  };
  try {
    const served = await serve(payload());
    assert.equal(served.liveOverlay.applied, true, 'real server overlay must apply');
    assert.equal(served.meta.asOf, CURRENT);
    assert.equal(served.debts[0].balance, 140);
    assert.equal(served.debts[0].pending, 25);
    assert.equal(served.debts[0].structure, canonical.debts[0].structure, 'overlay leaves dated prose untouched');
    const output = render(served);
    const html = output['credit-cards'].innerHTML;
    assert.match(html, /<b>\$140\.00<\/b>/);
    assert.match(html, /\+ \$25\.00 pending, already incurred/);
    assert.match(fact(html, 'available'), /\$835\.00/, '1000 - 140 - 25 = 835 by hand');
    assert.match(html, /VERIFIED/);
    checkDates(output, CURRENT);
    // Fail-first regression: the old renderer prints stale 100 / zero pending
    // in structure directly beside these correctly overlaid 140 / 25 figures.
    assert.doesNotMatch(html, /\$100\.00|\$0\.00|\$123\.45/, 'live card must not repeat canonical monetary prose');
    checkDescription(html);
    const again = await serve(payload());
    assert.deepEqual(render(again), output, 'same refresh and same renderer are idempotent');
    const changed = payload();
    changed.accounts[3].balance = 160;
    changed.transactions[0].amount = 30;
    const refreshed = render(await serve(changed));
    assert.match(refreshed['credit-cards'].innerHTML, /<b>\$160\.00<\/b>/);
    assert.match(refreshed['credit-cards'].innerHTML, /\+ \$30\.00 pending/);
    assert.match(fact(refreshed['credit-cards'].innerHTML, 'available'), /\$810\.00/);
    checkDescription(refreshed['credit-cards'].innerHTML);

    // No overlay is still an explicitly dated opening, never fetchedAt-as-of.
    const dated = render(await Live.applyForServer(canonical, { ATLAS_LIVE_OVERLAY: 'off' }));
    assert.match(dated['credit-cards'].innerHTML, /<b>\$100\.00<\/b>/);
    assert.match(fact(dated['credit-cards'].innerHTML, 'available'), /\$900\.00/);
    checkDates(dated, OPENING);
    checkDescription(dated['credit-cards'].innerHTML);

    const stale = payload();
    stale.accounts.forEach(row => { row.updated_at = '2026-03-09T17:55:00.000Z'; row.balance_last_update = '2026-03-09T17:55:00.000Z'; });
    const missing = payload();
    missing.accounts = missing.accounts.filter(row => row.id !== 9001);
    const unknown = payload();
    unknown.pendingCoverage = null;
    unknown.transactions = [];
    for (const [label, observation, reason] of [
      ['stale', stale, /stale-live-cash-evidence/],
      ['missing', missing, /missing-live-cash-evidence/],
      ['unknown pending', unknown, /pending-freshness-unproven/],
    ]) {
      const fallback = await serve(observation);
      assert.equal(fallback.liveOverlay.applied, false, label + ' must fail closed');
      assert.match(fallback.liveOverlay.reason, reason);
      assert.equal(fallback.meta.asOf, OPENING, label + ' must keep dated as-of');
      assert.equal(fallback.debts[0].balance, 100);
      const output = render(fallback);
      assert.match(output['credit-cards'].innerHTML, /<b>\$100\.00<\/b>/);
      assert.doesNotMatch(output['credit-cards'].innerHTML, /\$140\.00|\$25\.00|\$123\.45/);
      checkDates(output, OPENING);
      checkDescription(output['credit-cards'].innerHTML);
    }

    const incomplete = JSON.parse(before);
    incomplete.debts[0].pending = null;
    incomplete.debts[0].pendingUnknown = true;
    const postedUnknownPending = render(incomplete)['credit-cards'].innerHTML;
    assert.match(postedUnknownPending, /<b>\$100\.00<\/b>/);
    assert.match(fact(postedUnknownPending, 'available'), /Not published/);
    assert.match(postedUnknownPending, /Pending not observed — not \$0/);
    checkDescription(postedUnknownPending);
    incomplete.debts[0].balance = null;
    const unknownHtml = render(incomplete)['credit-cards'].innerHTML;
    assert.match(unknownHtml, /<b><span class="credit-unknown">Unknown<\/span><\/b>/);
    assert.match(unknownHtml, /Pending not observed — not \$0/);
    assert.match(fact(unknownHtml, 'available'), /Not published/);
    assert.doesNotMatch(unknownHtml, /\$0\.00|\$100\.00|\$123\.45/);
    checkDescription(unknownHtml);
    delete incomplete.debts[0].structure;
    checkDescription(render(incomplete)['credit-cards'].innerHTML);

    // Non-card structural context remains the served record's explanation.
    const secured = JSON.parse(before);
    secured.debts = [{ id: 'term-a', label: 'Synthetic mortgage', secured: true,
      balance: 5000, confidence: 'verified', structure: 'Secured amortising term debt.' }];
    assert.match(render(secured)['credit-secured'].innerHTML, /Secured amortising term debt\./);
    assert.equal(JSON.stringify(canonical), before, 'refreshes must not mutate canonical input');
    assert.deepEqual(fs.readFileSync(path.join(ROOT, 'data.json')), canonicalBytes, 'canonical file bytes unchanged');
    assert.deepEqual(snapshots(), snapshotBytes, 'historical snapshot bytes unchanged');
    console.log('PASS Credit description authority: overlay, fallback, unknowns, dates, refresh, numeric authority and no mutation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
