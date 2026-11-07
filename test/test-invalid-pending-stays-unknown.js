'use strict';
// A19: an invalid pending amount (or an undated pending row) never becomes a proven zero.
// Independent invented ledger: one card, posted 400, dated pending 50. The
// complete is_pending query holds one pending row whose amount is 'bad'.
// Expected values are written by hand, not computed by the code under test.
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.env.ATLAS_TEST_APP_ROOT || path.join(__dirname, '..');
const O = require(path.join(root, 'scripts/provider-observe'));
const Live = require(path.join(root, 'scripts/live-plan'));
const F = require(path.join(root, 'public/forecast'));
const base = require('./fixtures/card-backfill-data');

let checks = 0;
function eq(a, b, why) { assert.deepEqual(a, b, why); checks++; }
function yes(v, why) { assert.ok(v, why); checks++; }

const CARD = 'invented-card';
const DAY = '2026-09-20';
const pendingRow = (id, amount, date = DAY) => ({ id, account_id: 3004, date, amount,
  is_pending: true, payee: 'Invented cafe', status: 'pending', currency: 'cad' });

function world(pendingRows, opts = {}) {
  const x = base(CARD, 'invented-min');
  x.data.meta.asOf = x.data.plan.opening.asOf = opts.openingAsOf || DAY;
  x.data.plan.obligations = [];
  x.data.plan.budget.categories = [];
  x.data.plan.income[0].amount = 0;
  x.data.plan.startingCash.breakdown[0].value = 420;
  x.data.debts[0].pending = 50;
  x.payload.transactions = pendingRows;
  return x;
}

function run(pendingRows, opts) {
  const x = world(pendingRows, opts);
  const before = JSON.stringify(x);
  const report = O.observe({ provider: 'lunchmoney', ...x });
  const live = Live.fromObservation(x);
  eq(JSON.stringify(x), before, 'inputs unchanged');
  return {
    obs: report.observations.find(o => o.fact === 'pending' && o.cardId === CARD),
    recon: report.reconciliation.rows.find(r => r.fact === 'pending' && r.cardId === CARD),
    summary: report.reconciliation.cardSummaries.find(c => c.id === CARD || c.cardId === CARD),
    live,
    debt: live.data.debts.find(d => d.id === CARD),
  };
}

// ── Controls: a valid pending 30 and a proven-empty pending query. ──
{
  const valid = run([pendingRow(7001, 30)]);
  eq([valid.obs.evidenceValue, valid.obs.unknown], [30, false], 'control: valid pending observed as 30');
  eq([valid.debt.pending, valid.debt.pendingUnknown], [30, false], 'control: live pending is 30, known');
  const empty = run([]);
  eq([empty.obs.evidenceValue, empty.obs.unknown], [0, false], 'control: complete empty query proves 0');
  eq([empty.debt.pending, empty.debt.pendingUnknown], [0, false], 'control: proven zero stays a proven zero');
}

// ── The defect class: unusable amounts, alone or beside a valid row. ──
for (const [label, rows] of [
  ['bad string', [pendingRow(7001, 'bad')]],
  ['null amount', [pendingRow(7001, null)]],
  ['empty amount', [pendingRow(7001, '')]],
  ['valid 30 beside bad', [pendingRow(7001, 30), pendingRow(7002, 'bad')]],
  ['undated bad', [pendingRow(7001, 'bad', null)]],
  ['undated valid 30', [pendingRow(7001, 30, null)]],
  ['valid 30 beside undated 20', [pendingRow(7001, 30), pendingRow(7002, 20, null)]],
]) {
  const r = run(rows);
  eq(r.obs.unknown, true, label + ': observer marks pending unknown');
  eq(r.obs.evidenceValue, null, label + ': observer carries no pending value (never 0, never 30)');
  eq(r.obs.unknownReason, 'invalid-pending-row', label + ': reason is the unusable pending row');
  eq([r.recon.status, r.recon.unknown, r.recon.evidenceValue], ['MISSING', true, null],
    label + ': reconciliation keeps it unknown');
  eq(r.summary.pendingUnknown, true, label + ': card summary pending is unknown');
  eq(r.summary.exposureUnknown, true, label + ': card summary exposure is unknown');
  eq(r.live.overlays.some(o => o.locator === 'debts:' + CARD + '#pending'), false,
    label + ': no pending overlay is proposed');
  eq(r.debt.pendingUnknown, true, label + ': live plan marks pending unknown');
  yes(r.debt.pending !== 0, label + ': live pending is not a zero');
  const card = F.creditAccounts(r.live.data.plan, r.live.data.debts, r.live.data.meta.asOf)
    .cards.find(c => c.id === CARD);
  eq(card.pendingUnknown, true, label + ': Forecast credit publisher reads pending as unknown');
  eq(r.live.data.refreshTrust.remainingClaim === 'precise', false,
    label + ': refresh trust never claims a precise remaining figure');
  eq(r.live.data.refreshTrust.displayState === 'current', false, label + ': not current');
}

// ── An as-of advance with an invalid pending amount fails closed. ──
{
  let threw = null;
  let r = null;
  try { r = run([pendingRow(7001, 'bad')], { openingAsOf: '2026-09-19' }); } catch (e) { threw = e; }
  yes(threw ? /pending-freshness-unproven/.test(threw.message) : r.debt.pendingUnknown === true,
    'advance: invalid pending never becomes the advanced pending figure');
}

// ── Rows a collapse would replace still count. A pending copy whose provider
// id also arrives as posted (pending-to-posted) is dropped by the provider-id
// collapse; an unusable pending copy must still keep pending unknown, both
// when it would leave zero and when a valid row would leave a partial sum. ──
const postedRow = (id, amount) => ({ id, account_id: 3004, date: DAY, amount,
  is_pending: false, payee: 'Invented cafe', status: 'cleared', currency: 'cad' });
for (const [label, rows] of [
  ['undated pending beside its posted twin (zero)', [pendingRow(7101, 20, null), postedRow(7101, 20)]],
  ['bad pending beside its posted twin (zero)', [pendingRow(7102, 'bad'), postedRow(7102, 20)]],
  ['undated pending beside its posted twin, plus valid 30 (partial sum)',
    [pendingRow(7101, 20, null), postedRow(7101, 20), pendingRow(7103, 30)]],
]) {
  const r = run(rows);
  eq([r.obs.unknown, r.obs.evidenceValue], [true, null], label + ': pending unknown, never 0 or 30');
  eq(r.debt.pendingUnknown, true, label + ': live plan marks pending unknown');
}

// ── Every publication of the dependent exposure honours the unknown. Posted
// 400 is known; dated pending 50 is retained but no longer current; today's
// pending is unknown. Consumer debt is 400 + unknown: neither 450 nor 400. ──
{
  const fs = require('node:fs');
  const vm = require('node:vm');
  const page = (d) => {
    const els = {};
    const el = id => new Proxy({ id, innerHTML: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
    { get(t, k) { return k in t ? t[k] : () => null; } });
    const ctx = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
      getComputedStyle() { return { getPropertyValue() { return ''; } }; },
      requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
      ResizeObserver: class { observe() {} disconnect() {} },
      IntersectionObserver: class { observe() {} disconnect() {} },
      document: { addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
        getElementById(id) { return els[id] || (els[id] = el(id)); },
        createElement() { return el('x'); }, createElementNS() { return el('x'); },
        createTextNode() { return el('t'); }, documentElement: { dataset: {}, style: {} }, body: el('body') },
      window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
      localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/' } });
    vm.runInContext(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'), ctx);
    vm.runInContext('App.boot = () => {};', ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'public/plan.js'), 'utf8'), ctx);
    ctx.served = d;
    vm.runInContext('Object.assign(state, served.plan.defaults, { debts: served.debts });', ctx);
    // The real Budget renderer; later DOM-only steps may stop on the stub
    // after the snapshot tiles are written.
    try { vm.runInContext('renderPlan(served, null, null)', ctx); } catch (e) { /* DOM stub limit */ }
    const tiles = (els['snapshot-tiles'] || {}).innerHTML || '';
    const tile = (tiles.match(/Consumer debt<\/div><div class="val">([^<]*)/) || [])[1] || null;
    return { ctx, tile };
  };
  for (const [label, rows, expected] of [
    ['valid 30 (control)', [pendingRow(7001, 30)], { consumer: 430, tile: '$430' }],
    ['bad', [pendingRow(7001, 'bad')], { consumer: null, tile: 'unavailable' }],
    ['valid 30 beside bad', [pendingRow(7001, 30), pendingRow(7002, 'bad')], { consumer: null, tile: 'unavailable' }],
  ]) {
    const r = run(rows);
    const d = r.live.data;
    const proj = F.projectDebts(d.plan, d.debts, d.meta.asOf);
    eq(proj.marks[0].consumer, expected.consumer, label + ': Forecast day-zero consumer debt');
    if (expected.consumer == null) {
      eq(proj.marks.every(m => m.consumer === null), true, label + ': consumer debt unknown on every mark');
    }
    const { ctx, tile } = page(d);
    eq(tile, expected.tile, label + ': real Budget snapshot tile prints ' + expected.tile);
    ctx.today = proj.marks[0];
    const hero = vm.runInContext('currentOperatingConsumerDebtHeroTile({}, null, today)', ctx);
    eq(hero.val, expected.consumer == null ? 'unavailable' : '$430', label + ': consumer debt hero tile');
    if (expected.consumer == null) {
      const phase = vm.runInContext("PHASE_BODY['31-60']({ consumerMove: null, consumerDirection: null, consumer60: null, headroom60: 0 })", ctx);
      yes(/unavailable/.test(phase) && !/moves \$0/.test(phase), label + ': phase copy says unavailable, never "moves $0"');
    }
    // Talk never states a pending total while a card's pending is unknown.
    const Packet = require(path.join(root, 'scripts/assistant-packet'));
    const Talk = require(path.join(root, 'scripts/talk-presentation'));
    const packet = Packet.buildPacket({ data: d, periods: [] });
    const pending = packet.current.pending;
    const said = Talk.ruleFor('current.pending.totalKnownPending')
      .present(pending.totalKnownPending, packet);
    if (expected.consumer == null) {
      eq(pending.unknownFacilityCount > 0, true, label + ': packet records an unknown card');
      eq(said.trust, 'unavailable', label + ': Talk withholds the pending total');
      yes(!/\$/.test(said.text), label + ': Talk states no pending figure');
    } else {
      yes(/\$30/.test(said.text), label + ': Talk states the known pending total');
    }
  }
}

console.log('PASS an invalid pending amount keeps card pending unknown through observe -> reconcile -> live plan -> Forecast: '
  + checks + ' independent checks');
