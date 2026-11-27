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

// ── Budget consumer-debt tile. Since #951, Forecast publishes consumer debt
// as unknown for any card whose pending is unknown, and the real Budget
// renderer prints Unknown, never a dollar figure. For the same card state,
// the tile from today's observation equals the tile for a dated canonical
// card already marked pendingUnknown with no observation at all, and both
// read Unknown. The assistant packet records the unknown card. ──
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
    return (tiles.match(/Consumer debt<\/div><div class="val">([^<]*)/) || [])[1] || null;
  };
  // Same card state with no observation: the dated canonical card is already
  // pendingUnknown (main can reach this state without this PR).
  const canonicalUnknown = world([]).data;
  canonicalUnknown.debts[0].pendingUnknown = true;
  const mainTile = page(canonicalUnknown);
  eq(mainTile, 'Unknown', 'canonical pendingUnknown card: Budget tile reads Unknown, never a dollar figure');
  const Packet = require(path.join(root, 'scripts/assistant-packet'));
  for (const [label, rows, unknown] of [
    ['valid 30 (control)', [pendingRow(7001, 30)], false],
    ['bad', [pendingRow(7001, 'bad')], true],
    ['valid 30 beside bad', [pendingRow(7001, 30), pendingRow(7002, 'bad')], true],
  ]) {
    const d = run(rows).live.data;
    const tile = page(d);
    if (unknown) {
      eq(tile, mainTile, label + ': Budget tile matches the canonical pendingUnknown card');
      eq(tile, 'Unknown', label + ': Budget tile reads Unknown, never posted + retained pending or $0');
    } else {
      eq(tile, '$430', label + ': Budget tile prints posted 400 + pending 30 = $430');
    }
    const packet = Packet.buildPacket({ data: d, periods: [] });
    const pending = packet.current.pending;
    if (unknown) {
      eq(pending.unknownFacilityCount > 0, true, label + ': packet records an unknown card');
    }
  }
}

// ── A pending row that may already be a posted row the card balance holds
// (a surface twin, or several candidates, with no provider link to say which)
// is neither added to the card's pending exposure nor dropped. Real observer
// -> reconcile -> live plan -> Forecast, on the invented aggregate world.
// Hand-computed expectations (nothing here is read back from the code under
// test). Posted balance = the card's opening balance plus its posted purchases
// (pending rows are never in the posted balance); room = limit - posted -
// known pending; the Stack target balance = posted + known pending. A twin
// counted twice would add its amount again: the card would read over its limit
// and the Stack target would grow by the twin's amount (the defect). ──
{
  const aggregate = require('./fixtures/card-coverage-aggregate-world');
  const LIMIT = 500;
  const POLICY = { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' };
  const pendingOf = (amount, id, extra, account = 'card') => [account, amount, null, 'purchase',
    { is_pending: true, status: 'pending', plaid_metadata: { transaction_id: id }, ...(extra || {}) }];
  const postedOf = (amount, predecessor, postedId = 'tx-post') => ['card', amount, null, 'purchase',
    predecessor ? { plaid_metadata: { transaction_id: postedId, pending_transaction_id: predecessor } } : {}];
  const cafe = { payee: 'Invented cafe' };

  function ledger(rows, opts = {}) {
    const x = aggregate.world(rows, { twoCards: opts.twoCards, edit: xx => {
      // The posted balance never holds a pending row.
      for (const [index, accountId] of [[3, 3004], [4, 3005]]) {
        if (!xx.payload.accounts[index]) continue;
        xx.payload.accounts[index].balance -= xx.payload.transactions
          .filter(t => t.account_id === accountId && t.is_pending).reduce((s, t) => s + t.amount, 0);
      }
      // An advance leaves the canonical opening earlier than the live day.
      if (!opts.advance) xx.data.meta.asOf = xx.data.plan.opening.asOf = xx.asOf;
      xx.data.debts[0].limit = opts.limit || LIMIT;
      xx.data.debts[0].rate = 19.99;
    } });
    const report = O.observe({ provider: 'lunchmoney', ...x });
    const out = aggregate.run(x);
    const debts = out.observed.data.debts;
    const plan = Object.assign({}, out.observed.data.plan, { nextDollar: POLICY });
    const util = F.utilisation(debts, [], plan);
    const pendingFor = id => report.observations.find(o => o.fact === 'pending' && o.cardId === id);
    return {
      obs: pendingFor('travelvisa'),
      obs2: pendingFor('mbna'),
      posted: report.observations.find(o => o.fact === 'posted-balance' && o.cardId === 'travelvisa'),
      debts, card: debts.find(d => d.id === 'travelvisa'), util, row: util.rows.find(r => r.id === 'travelvisa'),
      target: F.debtPriority(plan, debts).target,
      issues: ((out.coverage && out.coverage.issues) || []).map(i => i.code),
      coverage: out.coverage,
    };
  }
  const unknownLane = (r, count, label) => {
    eq([r.obs.unknown, r.obs.evidenceValue, r.obs.unknownReason, r.obs.unresolvedReplacementCount],
      [true, null, 'pending-replacement-unresolved', count], label + ': pending exposure unknown, not a sum');
    eq(r.card.pendingUnknown, true, label + ': live plan marks the card pending unknown');
  };
  const noExactOverage = (r, label) => {
    eq([r.row.available, r.row.overLimit, r.row.overLimitBy, r.row.pendingUnknown], [null, null, null, true],
      label + ': no exact room or overage is published');
    eq(r.util.totalAvailable, null, label + ': credit left is unknown');
    eq([r.target.balance, r.target.pendingUnknown], [460, true],
      label + ': Stack target is the posted balance held as unknown pending, never posted plus the twin');
  };

  // Posted only, and the directed twin counted once, read the same.
  for (const [label, rows] of [
    ['posted only', [postedOf(60)]],
    ['directed twin counted once', [postedOf(60, 'tx-pend'), pendingOf(60, 'tx-pend')]],
  ]) {
    const r = ledger(rows);
    eq([r.obs.unknown, r.obs.evidenceValue], [false, 0], label + ': pending exposure is a known zero');
    eq([r.posted.evidenceValue, r.card.balance, !!r.card.pendingUnknown], [460, 460, false], label + ': posted balance is the opening plus the posted purchase, pending known');
    eq([r.row.available, r.row.overLimit, r.target.balance], [40, false, 460], label + ': room is the limit less posted, not over, target is the posted balance');
    eq(r.coverage.status, 'ready', label + ': card coverage is ready');
  }

  // A lone surface twin with no identity: unknown, never 520 and never dropped.
  {
    const r = ledger([postedOf(60), pendingOf(60, 'tx-pend')]);
    unknownLane(r, 1, 'unresolved twin');
    eq(r.posted.evidenceValue, 460, 'unresolved twin: the posted balance is still observed unchanged');
    eq(r.obs.components.length, 1, 'unresolved twin: the pending row is kept, not collapsed');
    noExactOverage(r, 'unresolved twin');
    eq([r.coverage.status, r.issues.includes('coverage-replacement-ambiguous')], ['unavailable', true],
      'unresolved twin: card coverage keeps coverage-replacement-ambiguous');
    // The same twin on a card already over its limit on posted alone stays a known over-limit.
    const over = ledger([postedOf(60), pendingOf(60, 'tx-pend')], { limit: 450 });
    eq([over.row.overLimit, over.row.overLimitBy, over.row.available], [true, 10, 0],
      'unresolved twin on a card over its limit on posted alone: the posted overage is still known');
  }

  // Genuinely separate pending is retained and counted: posted + that pending.
  {
    const r = ledger([postedOf(60), pendingOf(35, 'tx-cafe', cafe)]);
    eq([r.obs.unknown, r.obs.evidenceValue, !!r.card.pendingUnknown], [false, 35, false], 'separate pending: counted, known');
    eq([r.row.available, r.row.overLimit, r.target.balance], [5, false, 495], 'separate pending: room is the limit less posted less that pending, target includes it');
    eq(r.obs.components.some(c => c.possibleReplacement), false, 'separate pending: not flagged as a possible replacement');
    eq(r.issues.includes('coverage-replacement-ambiguous'), false, 'separate pending: no replacement ambiguity');
  }

  // Known pending beside an unresolved twin: the card total is unknown, and
  // the known row stays listed and unflagged.
  {
    const r = ledger([postedOf(60), pendingOf(60, 'tx-pend'), pendingOf(35, 'tx-cafe', cafe)]);
    unknownLane(r, 1, 'known pending beside an unresolved twin');
    noExactOverage(r, 'known pending beside an unresolved twin');
    const flagged = r.obs.components.filter(c => c.possibleReplacement === true);
    const known = r.obs.components.filter(c => c.possibleReplacement !== true);
    eq([r.obs.components.length, flagged.length, known.length, known[0].amount, known[0].contributesToCurrentPending],
      [2, 1, 1, 35, true],
      'known pending beside an unresolved twin: both rows listed, only the twin flagged, the other still contributes');
  }

  // Several candidates: two posted rows both name the one pending, or two
  // pending rows both claim the one posted row. Neither resolves.
  {
    const r = ledger([postedOf(60, 'tx-pend', 'tx-post-1'), postedOf(60, 'tx-pend', 'tx-post-2'), pendingOf(60, 'tx-pend')],
      { limit: 600 });
    unknownLane(r, 1, 'two posted candidates for one pending');
    eq([r.posted.evidenceValue, r.row.available, r.row.overLimit], [520, null, null],
      'two posted candidates for one pending: both posted purchases observed, room unknown (never limit less posted less the pending)');
    const r2 = ledger([postedOf(60, 'tx-pend'), pendingOf(60, 'tx-pend'), pendingOf(60, 'tx-pend')], { limit: 600 });
    unknownLane(r2, 2, 'two pending rows claiming one posted');
    eq([r2.obs.components.length, r2.row.available], [2, null], 'two pending rows claiming one posted: both kept, room unknown');
  }

  // A second same-amount pending the provider says is a different transaction
  // (the posted row's predecessor is the first) is separate and still counted.
  {
    const r = ledger([postedOf(60, 'tx-pend-1'), pendingOf(60, 'tx-pend-1'), pendingOf(60, 'tx-pend-2')], { limit: 600 });
    eq([r.obs.unknown, r.obs.evidenceValue, r.obs.components.length], [false, 60, 1],
      'directed twin counted once, a different-identity pending retained and counted, known');
    eq([r.row.available, r.row.overLimit, r.target.balance], [80, false, 520], 'that pending is counted: room and target include it');
  }

  // The live day is later than the canonical opening (the normal live refresh).
  // The unresolved replacement is fresh and explicitly unknown, so the advance
  // is not refused: posted facts stay current, the card is pending-unknown,
  // and nothing exact is published. An unusable pending row on an advance is
  // still refused (pinned above).
  {
    for (const [label, rows, count] of [
      ['unresolved twin', [postedOf(60), pendingOf(60, 'tx-pend')], 1],
      ['known pending beside an unresolved twin', [postedOf(60), pendingOf(60, 'tx-pend'), pendingOf(35, 'tx-cafe', cafe)], 1],
      ['two pending rows claiming one posted', [postedOf(60, 'tx-pend'), pendingOf(60, 'tx-pend'), pendingOf(60, 'tx-pend')], 2],
    ]) {
      const r = ledger(rows, { advance: true, limit: 600 });
      unknownLane(r, count, 'advance, ' + label);
      eq([r.row.available, r.row.overLimit, r.row.overLimitBy], [null, null, null], 'advance, ' + label + ': no exact room or overage');
      eq(r.posted.evidenceValue, 460, 'advance, ' + label + ': the observed posted balance is current');
    }
    // Controls on an advance: a posted-only card and a genuinely separate
    // pending are unaffected, and a twin on another card marks only that card.
    const posted = ledger([postedOf(60)], { advance: true });
    eq([posted.obs.unknown, posted.obs.evidenceValue, !!posted.card.pendingUnknown], [false, 0, false], 'advance, posted only: known zero');
    const separate = ledger([postedOf(60), pendingOf(35, 'tx-cafe', cafe)], { advance: true });
    eq([separate.obs.evidenceValue, separate.row.available, separate.target.balance], [35, 5, 495], 'advance, separate pending: counted');
    const two = ledger([postedOf(60), ['card2', 40, null, 'purchase'], pendingOf(40, 'tx-two', {}, 'card2')], { twoCards: true, advance: true });
    eq([!!two.card.pendingUnknown, two.debts.find(d => d.id === 'mbna').pendingUnknown], [false, true], 'advance, twin on a second card: only that card unknown');
  }

  // The unknown is the affected card only.
  {
    const r = ledger([postedOf(60), ['card2', 40, null, 'purchase'], pendingOf(40, 'tx-two', {}, 'card2')], { twoCards: true });
    eq([r.obs.unknown, r.obs.evidenceValue, !!r.card.pendingUnknown], [false, 0, false], 'other card: its own pending stays a known zero');
    eq([r.obs2.unknown, r.obs2.evidenceValue, r.obs2.unknownReason], [true, null, 'pending-replacement-unresolved'],
      'twin on the second card: only that card is unknown');
    eq(r.debts.find(d => d.id === 'mbna').pendingUnknown, true, 'the second card is marked unknown in the live plan');
  }
}

console.log('PASS an invalid pending amount keeps card pending unknown through observe -> reconcile -> live plan -> Forecast: '
  + checks + ' independent checks');
