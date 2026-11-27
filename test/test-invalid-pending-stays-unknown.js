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

  // The advancing-day exception qualifies the exact card, fact, date and
  // observation reference. Each counterexample below is a crafted copy of a
  // real observer report on an advancing live day; every one must still be
  // refused as stale pending evidence, as on the base.
  {
    const REFUSED = /pending-freshness-unproven: debts:/;
    function advance(rows, mutate, opts = {}) {
      const x = aggregate.world(rows, { twoCards: opts.twoCards, edit: xx => {
        for (const [index, accountId] of [[3, 3004], [4, 3005]]) {
          if (!xx.payload.accounts[index]) continue;
          xx.payload.accounts[index].balance -= xx.payload.transactions
            .filter(t => t.account_id === accountId && t.is_pending).reduce((s, t) => s + t.amount, 0);
        }
        xx.data.debts[0].limit = LIMIT;
      } });
      const report = JSON.parse(JSON.stringify(O.observe({ provider: 'lunchmoney', ...x })));
      const view = {
        row: id => report.reconciliation.rows.find(r => r.fact === 'pending' && r.cardId === id),
        obs: id => report.observations.find(o => o.fact === 'pending' && o.cardId === id),
        report,
      };
      if (mutate) mutate(view);
      try { return { out: Live.overlayLiveState({ data: x.data, report }) }; } catch (error) { return { error: String(error.message) }; }
    }
    const twin = [postedOf(60), pendingOf(60, 'tx-pend')];
    const accepted = advance(twin);
    yes(accepted.out && accepted.out.data.debts.find(d => d.id === 'travelvisa').pendingUnknown === true,
      'advance exception: the exact unresolved replacement is accepted and the card is pending-unknown');
    for (const [label, mutate] of [
      ['no observation reference on the row or the observation', v => { delete v.row('travelvisa').observationId; delete v.obs('travelvisa').observationId; }],
      ['empty observation reference', v => { v.row('travelvisa').observationId = ''; v.obs('travelvisa').observationId = ''; }],
      ['row dated before the live day', v => { v.row('travelvisa').evidenceDate = '2026-09-19'; }],
      ['observation dated before the live day', v => { v.obs('travelvisa').evidenceDate = '2026-09-19'; v.obs('travelvisa').observedAsOf = '2026-09-19'; }],
      ['observation without a date', v => { delete v.obs('travelvisa').evidenceDate; delete v.obs('travelvisa').observedAsOf; }],
      ['row status other than MISSING', v => { v.row('travelvisa').status = 'CHANGE'; }],
      ['row carrying a value', v => { v.row('travelvisa').evidenceValue = 5; }],
      ['observation carrying a value', v => { v.obs('travelvisa').evidenceValue = 5; }],
      ['another reason', v => { v.obs('travelvisa').unknownReason = 'invalid-pending-row'; }],
      ['no reason', v => { delete v.obs('travelvisa').unknownReason; }],
      ['observation for another fact', v => { v.obs('travelvisa').fact = 'posted-balance'; }],
      ['observation for another card', v => { v.obs('travelvisa').cardId = 'mbna'; }],
      ['observation targeting another debt', v => { v.obs('travelvisa').canonical = { collection: 'debts', id: 'mbna', field: 'pending' }; }],
      ['a second observation for the card carrying an unusable row', v => {
        v.report.observations.push({ ...v.obs('travelvisa'), unknownReason: 'invalid-pending-row', invalidPendingCount: 1 }); }],
      ['a second same-day pending row for the card', v => {
        v.report.reconciliation.rows.push({ ...v.row('travelvisa'), observationId: 'lm-other-pending' }); }],
      ['incomplete pending coverage', v => {
        v.report.pendingCoverage = { complete: false, hasMore: true, truncated: true, basis: null };
        v.report.observations.forEach(o => { if (o.fact === 'pending') o.pendingCoverage = 'incomplete'; }); }],
    ]) {
      const r = advance(twin, mutate);
      yes(r.error && REFUSED.test(r.error), 'advance exception refused: ' + label + (r.error ? '' : ' (was accepted)'));
    }
    // Another card's pending row cannot borrow the first card's observation.
    const borrowed = advance([postedOf(60), pendingOf(60, 'tx-pend'), ['card2', 40, null, 'purchase']], v => {
      Object.assign(v.row('mbna'), { unknown: true, status: 'MISSING', evidenceValue: null, observationId: v.obs('travelvisa').observationId });
    }, { twoCards: true });
    yes(borrowed.error && REFUSED.test(borrowed.error) && /mbna/.test(borrowed.error), 'advance exception refused: a second card borrowing the first card\'s observation');
    // Base controls: an unusable pending row and a zero-net unresolved set under
    // incomplete coverage were refused on an advance before this change too.
    const unusable = advance([postedOf(60), ['card', 'bad', null, 'purchase', { is_pending: true, status: 'pending' }]]);
    yes(unusable.error && REFUSED.test(unusable.error), 'base control: an unusable pending row stays refused on an advance');
    // The valid advance and the unaffected lanes are kept: the twin card is
    // pending-unknown while the other card keeps its known pending and both
    // keep the fresh observed posted balances.
    const mixed = advance([postedOf(60), pendingOf(60, 'tx-pend'), ['card2', 40, null, 'purchase'],
      pendingOf(35, 'tx-two', { payee: 'Invented cafe' }, 'card2')], null, { twoCards: true });
    yes(mixed.out, 'advance, twin on one card and known pending on another: the live day applies');
    const cards = Object.fromEntries(mixed.out.data.debts.map(d => [d.id, d]));
    eq([cards.travelvisa.pendingUnknown === true, cards.travelvisa.balance], [true, 460], 'advance: the twin card is pending-unknown with its fresh posted balance');
    eq([cards.mbna.pendingUnknown === true, cards.mbna.pending, cards.mbna.balance], [false, 35, 40], 'advance: the other card keeps its known pending and fresh posted balance');
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

// ── A stale dated canonical pending amount is never a known exposure, and an
// unknown card pending never publishes an exact overage or a covered flag.
// Invented ledgers, hand-computed. Posted balance = opening plus the posted
// purchases (a pending twin is never in it). The canonical pending left from an
// earlier refresh is nonzero: it must not be added to any published balance.
// Posted alone is the true floor. ──
async function proveStaleAndLimitCases() {
  const aggregate = require('./fixtures/card-coverage-aggregate-world');
  const { loadStackPage } = require('./lib/budget-page-harness');
  const POLICY = { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' };
  const purchase = (extra = {}) => ['card', 37, null, 'purchase', { payee: 'Invented merchant', category_name: null, ...extra }];
  const twinRow = () => purchase({ is_pending: true, status: 'pending', plaid_metadata: { transaction_id: 'tx-twin' } });
  const settle = (xx, limit, canonicalPending) => {
    xx.payload.accounts[3].balance -= xx.payload.transactions
      .filter(t => t.account_id === 3004 && t.is_pending).reduce((s, t) => s + t.amount, 0);
    xx.data.debts[0].limit = limit; xx.payload.accounts[3].credit_limit = limit;
    xx.data.debts[0].pending = canonicalPending;
  };
  async function stack(rows, { limit, pay, canonicalPending }) {
    const x = aggregate.world([['card', 80, null, 'purchase'], ...rows,
      ['bills', pay, null, 'cash', { notes: 'card payment: Travel Visa' }]], { edit(xx) {
      xx.data.plan.budget.excluded = [{ from: 'Invented business' }];
      for (const a of xx.payload.accounts) a.last_fetch = xx.asOf + 'T17:00:00Z';
      settle(xx, limit, canonicalPending);
      xx.data.meta.asOf = xx.data.plan.opening.asOf = xx.asOf;
    } });
    const { data } = Live.fromObservation(x);
    const page = await loadStackPage({ data });
    const ctx = page.context();
    const view = ctx.recommendation.payPeriodViews.find(v => v.start === page.selectedKey());
    const waterfall = page.sandbox.StackWaterfall.html(ctx, { creditOpen: true })
      .match(/<li[^>]*data-debt-id="travelvisa"[\s\S]*?<\/li>/)?.[0] || '';
    return { card: data.debts.find(d => d.id === 'travelvisa'), line: view.stackSummary.credit.lines.find(l => l.id === 'travelvisa'),
      breakdown: view.stackSummary.creditBreakdown.rows.find(row => row.debtId === 'travelvisa'), waterfall };
  }
  // The row, the head's remainder and the dropdown say one thing: a withheld remainder is shown as not available.
  const coherent = (r, why) => {
    eq(r.breakdown.amount, r.line.stillToPayBack.amount, why + ': the breakdown row carries the line remainder');
    if (r.line.stillToPayBack.amount === null) yes(/data-unpublished="true"/.test(r.waterfall) && /aria-label="not available"/.test(r.waterfall) && !/\$0\b/.test(r.waterfall), why + ': the dropdown shows the remainder as not available, never zero');
  };
  const unknownLowerBound = (r, why) => {
    eq([r.card.pendingUnknown, r.card.balance], [true, 517], why + ': pending unknown, posted balance observed');
    eq([r.line.target.amount, r.line.target.trust, r.line.target.overLimitBy], [117, 'estimated', null],
      why + ': the target is the lower bound, estimated, with no exact overage');
    yes(r.line.target.reasons.includes('over-limit-unknown'), why + ': the target says the over-limit is unknown');
  };

  // Control: nothing unknown, so the exact overage and the covered flag stand.
  const control = await stack([purchase()], { limit: 400, pay: 25, canonicalPending: 0 });
  eq([!!control.card.pendingUnknown, control.line.target.overLimitBy, control.line.target.reasons.includes('over-limit-unknown')],
    [false, 117, false], 'control: a known card publishes its exact posted overage');
  eq([control.line.targetCovered.value, control.line.stillToPayBack.amount], [false, 92], 'control: not covered, the unpaid remainder is known');

  // Posted alone is already over the limit: the overage is only a lower bound.
  const above = await stack([purchase(), twinRow()], { limit: 400, pay: 25, canonicalPending: 15 });
  unknownLowerBound(above, 'over the limit on posted alone');
  eq([above.line.targetCovered.value, above.line.stillToPayBack.amount, above.line.paidBack.amount], [false, 92, 25],
    'over the limit on posted alone: paid is below the lower bound, so not covered is still known');
  const aboveCovered = await stack([purchase(), twinRow()], { limit: 400, pay: 130, canonicalPending: 15 });
  unknownLowerBound(aboveCovered, 'over the limit on posted alone, paid past the lower bound');
  eq([aboveCovered.line.targetCovered.value, aboveCovered.line.targetCovered.trust, aboveCovered.line.stillToPayBack.amount, aboveCovered.line.paidBack.amount,
    aboveCovered.line.minimumCovered.value], ['unknown', 'unavailable', null, 130, true],
    'paid past the lower bound is never published as covered; the payer and minimum facts stay');
  coherent(aboveCovered, 'over the limit on posted alone, paid past the lower bound');

  // Posted is under the limit but the unknown pending could push it over.
  const below = await stack([purchase(), twinRow()], { limit: 550, pay: 130, canonicalPending: 15 });
  unknownLowerBound(below, 'under the limit on posted alone');
  eq([below.line.targetCovered.value, below.line.stillToPayBack.amount, below.line.paidBack.amount], ['unknown', null, 130],
    'under the limit on posted alone: paid past the lower bound is not published as covered');
  coherent(below, 'under the limit on posted alone, paid past the lower bound');
  coherent(above, 'over the limit on posted alone, paid short');
  const belowShort = await stack([purchase(), twinRow()], { limit: 550, pay: 25, canonicalPending: 15 });
  eq([belowShort.line.targetCovered.value, belowShort.line.stillToPayBack.amount], [false, 92],
    'under the limit on posted alone: paid below the lower bound is still known to be uncovered');

  // A genuinely separate pending is known and counted, so the exact overage is published.
  const separate = await stack([purchase(), ['card', 35, null, 'purchase', { is_pending: true, status: 'pending', payee: 'Invented cafe',
    plaid_metadata: { transaction_id: 'tx-cafe' } }]], { limit: 550, pay: 25, canonicalPending: 0 });
  eq([!!separate.card.pendingUnknown, separate.card.pending, separate.line.target.reasons.includes('over-limit-unknown')], [false, 35, false],
    'a separate pending stays known and counted');
  eq(separate.line.target.overLimitBy, 2, 'its exact overage is still published');


  // The earlier-period pair can push a card over its limit even when this
  // period has neither new charges nor a minimum on that card.
  async function zeroFloor({ twin, sibling }) {
    const old = '2026-09-10';
    const rows = [['card', 73, old, 'purchase', { payee: 'Invented old charge' }]];
    if (twin) rows.push(['card', 73, old, 'purchase', {
      payee: 'Invented old charge', is_pending: true, status: 'pending',
      plaid_metadata: { transaction_id: 'tx-zero-floor-twin' },
    }]);
    if (sibling) rows.push(
      ['card2', 70, null, 'purchase'],
      ['bills', 70, null, 'cash', { notes: 'card payment: MBNA' }]
    );
    const x = aggregate.world(rows, { twoCards: sibling, windowStart: '2026-09-01', edit(xx) {
      settle(xx, 500, twin ? 85 : 0);
      xx.data.plan.obligations = sibling ? [{
        ...xx.data.plan.obligations[0], id: 'invented-other-minimum', debtId: 'mbna',
      }] : [];
      for (const account of xx.payload.accounts) account.last_fetch = xx.asOf + 'T17:00:00Z';
    } });
    const { data } = Live.fromObservation(x);
    const page = await loadStackPage({ data });
    const ctx = page.context();
    const view = ctx.recommendation.payPeriodViews.find(v => v.start === page.selectedKey());
    const { credit, creditBreakdown, surplus } = view.stackSummary;
    const waterfall = page.sandbox.StackWaterfall.html(ctx, { creditOpen: true });
    const dropdown = waterfall.match(/<li[^>]*data-debt-id="travelvisa"[\s\S]*?<\/li>/)?.[0] || '';
    const header = page.blockHtml('credit').match(/<button class="stack-credit-head"[\s\S]*?<\/button>/)?.[0] || '';
    return { credit, creditBreakdown, surplus, dropdown, header,
      card: data.debts.find(debt => debt.id === 'travelvisa') };
  }

  for (const sibling of [false, true]) {
    const why = sibling ? 'zero floor beside a covered card' : 'zero floor on the only card';
    const unresolved = await zeroFloor({ twin: true, sibling });
    const quiet = await zeroFloor({ twin: false, sibling });
    const line = unresolved.credit.lines.find(card => card.id === 'travelvisa');
    eq([unresolved.card.pendingUnknown, unresolved.card.balance, line.spent.amount, line.target.minimum],
      [true, 473, 0, 0], why + ': the only unknown is the earlier pending exposure');
    eq([line.target.amount, line.target.overLimitBy, line.stillToPayBack.amount, line.targetCovered.value],
      [0, null, null, 'unknown'], why + ': the card already withholds its remainder and coverage');
    const coverage = unresolved.credit.totals.targetCovered;
    eq([coverage.value, coverage.trust, ...coverage.reasons],
      ['unknown', 'unavailable', 'over-limit-unknown'],
      why + ': the credit head cannot claim the zero lower bound is covered');
    const remainder = unresolved.creditBreakdown.stillToPayBack;
    eq([remainder.amount, remainder.trust], [null, 'unavailable'],
      why + ': the waterfall cannot publish a zero remainder');
    const row = unresolved.creditBreakdown.rows.find(row => row.debtId === 'travelvisa');
    eq([row?.amount, row?.trust], [null, 'unavailable'], why + ': the dropdown includes the unknown card');
    yes(/data-unpublished="true"/.test(unresolved.dropdown) && /aria-label="not available"/.test(unresolved.dropdown),
      why + ': the real waterfall renders a dash for the unknown card');
    yes(unresolved.header.includes('data-stack-credit-total') && !unresolved.header.includes('stack-credit-x is-good'),
      why + ': the real Credit head never draws a covered total');
    eq(quiet.header.includes('stack-credit-x is-good'), sibling,
      why + ': the backed sibling retains a green total when the other card truly owes nothing');
    eq(quiet.credit.totals.targetCovered.value, sibling, why + ': a genuine zero still leaves coverage to active cards');
    eq(quiet.creditBreakdown.stillToPayBack.amount, 0, why + ': the known zero control has no remaining payment');
    yes(!quiet.creditBreakdown.rows.some(row => row.debtId === 'travelvisa'),
      why + ': a truly quiet card adds no dropdown row');
    eq(unresolved.credit.totals.paidBack.amount, quiet.credit.totals.paidBack.amount,
      why + ': independently qualified payer amounts stay unchanged');
    eq(unresolved.surplus.terms?.credit, quiet.surplus.terms?.credit,
      why + ': cash deduction is unaffected by display membership');
  }

  // Payoff and extra-debt targets read posted alone, never posted plus a stale amount.
  const ready = async (twin, canonicalPending) => {
    const old = '2026-09-10';
    const x = aggregate.world([['card', 60, old, 'purchase'], ...(twin ? [['card', 60, old, 'purchase',
      { is_pending: true, status: 'pending', plaid_metadata: { transaction_id: 'tx-old-twin' } }]] : [])],
    { windowStart: '2026-09-01', edit(xx) {
      settle(xx, 1000, canonicalPending);
      xx.data.debts[0].rate = 19.99;
      xx.data.plan.nextDollar = POLICY;
    } });
    const out = aggregate.run(x);
    const debts = out.observed.data.debts;
    return { debt: debts.find(d => d.id === 'travelvisa'), coverage: out.coverage.status,
      priority: F.debtPriority(Object.assign({}, out.observed.data.plan, { nextDollar: POLICY }), debts),
      extra: out.advice.paydayAllocation.extraDebt };
  };
  const clean = await ready(false, 0), unresolved = await ready(true, 15);
  eq([clean.debt.pendingUnknown === true, clean.priority.target.balance, clean.extra.absorbable], [false, 460, 460], 'control: payoff and extra-debt balance is posted');
  eq([unresolved.debt.pendingUnknown, unresolved.debt.pending, unresolved.coverage], [true, 15, 'ready'],
    'an earlier-period unresolved pair leaves pending unknown with the stale amount stored and card coverage ready');
  eq([unresolved.priority.target.balance, unresolved.priority.target.pendingUnknown, unresolved.extra.status, unresolved.extra.absorbable, unresolved.extra.target.balance],
    [460, true, 'ready', 460, 460], 'payoff target and absorbable read posted alone, not posted plus the stale amount');
  // Known pending is still added: a facility with a known pending reads posted plus pending.
  const knownDebt = [{ id: 'k', label: 'Invented card', balance: 460, pending: 35, rate: 19.99, secured: false, structure: 'Revolving', limit: 1000 }];
  eq(F.debtPriority({ nextDollar: POLICY }, knownDebt).target.balance, 495, 'a known pending is still part of the payoff balance');
}

proveStaleAndLimitCases().then(() => {
console.log('PASS an invalid pending amount keeps card pending unknown through observe -> reconcile -> live plan -> Forecast: '
    + checks + ' independent checks');
}).catch(error => { console.error(error); process.exitCode = 1; });
