'use strict';
// A2: a conflicting posted transaction id survives pagination merging.
// Independent invented ledger: two posted pages each carry id 5001, one for
// 10 and one for 20. The live fetch must hand both to the posted-duplicate
// guard, so transaction coverage is incomplete, exactly as it is when the
// same two rows are supplied directly. The transport is an in-process stub:
// no sockets, no live calls.
const assert = require('node:assert/strict');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const root = process.env.ATLAS_TEST_APP_ROOT || path.join(__dirname, '..');
const O = require(path.join(root, 'scripts/provider-observe'));
const Live = require(path.join(root, 'scripts/live-plan'));
const base = require('./fixtures/card-backfill-data');

let checks = 0;
function eq(a, b, why) { assert.deepEqual(a, b, why); checks++; }

const DAY = '2026-09-20';
const row = (id, amount, extra = {}) => ({ id, account_id: 3001, date: DAY, amount,
  is_pending: false, payee: 'Invented shop', currency: 'cad', ...extra });

// Serve `windowPages` (one row per page, offset-addressed) for the window
// query and `pendingRows` for the unbounded is_pending query.
function stubTransport(windowPages, pendingRows) {
  const originalHttps = https.request;
  const originalHttp = http.request;
  https.request = (url, options, cb) => {
    const u = new URL(url && url.href ? url.href : String(url));
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.end = () => process.nextTick(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      cb(res);
      let body = {};
      if (u.pathname.endsWith('/categories')) body = { categories: [] };
      else if (u.pathname.endsWith('/tags')) body = { tags: [] };
      else if (u.searchParams.get('is_pending') === 'true') {
        body = { has_more: false, transactions: pendingRows };
      } else if (u.pathname.endsWith('/transactions')) {
        const offset = Number(u.searchParams.get('offset') || 0);
        body = { has_more: offset < windowPages.length - 1, transactions: windowPages[offset] || [] };
      }
      res.emit('data', Buffer.from(JSON.stringify(body)));
      res.emit('end');
    });
    return req;
  };
  http.request = () => { throw new Error('no sockets in this test'); };
  return () => { https.request = originalHttps; http.request = originalHttp; };
}

async function fetched(windowPages, pendingRows = []) {
  const restore = stubTransport(windowPages, pendingRows);
  try {
    return await O.fetchLunchMoneyLive('invented-token', DAY + 'T18:00:00.000Z', 30, { limit: 1 });
  } finally {
    restore();
  }
}

function observeWith(transactions) {
  const x = base('invented-card', 'invented-min');
  x.payload.transactions = transactions;
  const report = O.observe({ provider: 'lunchmoney', ...x });
  const live = Live.fromObservation(x);
  return { report, live };
}

function evidenceFor(report, id) {
  return (report.identityEvidence || []).filter(r => r.providerTransactionId === String(id));
}

(async () => {
  // ── The defect: posted 10 and posted 20 for id 5001 on two pages. ──
  const conflict = await fetched([[row(5001, 10)], [row(5001, 20)]]);
  eq(conflict.transactionWindow.complete, true, 'conflict: transport pagination itself completed');
  eq(conflict.transactions.filter(t => t.id === 5001).map(t => t.amount), [10, 20],
    'conflict: both posted copies survive the merge');
  const viaFetch = observeWith(conflict.transactions);
  const direct = observeWith([row(5001, 10), row(5001, 20)]);
  for (const [label, run] of [['live fetch', viaFetch], ['direct input', direct]]) {
    const ev = evidenceFor(run.report, 5001);
    eq(ev.map(r => [r.transition, r.postedCount, r.dropped]), [['posted-duplicate-conflict', 2, true]],
      label + ': guard reports a posted-duplicate conflict');
    eq(ev[0].disagreeingFields, ['amount'], label + ': the copies disagree on amount');
    eq(run.report.currentPeriodActuals.transactionCoverage, 'incomplete',
      label + ': transaction coverage is incomplete, never complete');
    eq(run.live.data.liveOverlay.currentPeriodActuals.transactionCoverage, 'incomplete',
      label + ': the live plan carries incomplete transaction coverage');
    eq(run.live.data.refreshTrust.displayState === 'current', false,
      label + ': refresh trust is not current');
  }
  eq(JSON.stringify(viaFetch.report.identityEvidence), JSON.stringify(direct.report.identityEvidence),
    'conflict: live fetch and direct input reach the same guard verdict');

  // ── Controls that must stay as they were. ──
  // The same posted record delivered twice, byte for byte, is one record.
  const repeat = await fetched([[row(5002, 10)], [row(5002, 10)]]);
  eq(repeat.transactions.filter(t => t.id === 5002).length, 1, 'identical repeat: one copy kept');
  eq(observeWith(repeat.transactions).report.currentPeriodActuals.transactionCoverage, 'complete',
    'identical repeat: coverage stays complete');

  // A pending row seen by both the window and the pending universe is one row.
  const pending = row(5003, 15, { is_pending: true });
  const pendingBoth = await fetched([[pending]], [pending]);
  eq(pendingBoth.transactions.filter(t => t.id === 5003).length, 1, 'pending in both queries: one copy');

  // Posted/pending union: the window has it posted, the pending query still
  // has it pending. The first (posted) copy is kept, as before.
  const union = await fetched([[row(5004, 30)]], [row(5004, 30, { is_pending: true })]);
  eq(union.transactions.filter(t => t.id === 5004).map(t => t.is_pending), [false],
    'posted/pending union: one posted copy kept, never two');
  const unionRun = observeWith(union.transactions);
  eq(evidenceFor(unionRun.report, 5004), [], 'posted/pending union: no duplicate verdict');
  eq(unionRun.report.currentPeriodActuals.transactionCoverage, 'complete',
    'posted/pending union: coverage stays complete');

  // A pending copy never pairs with a posted copy into a duplicate, in either order.
  const pendingFirst = await fetched([[row(5005, 30, { is_pending: true })], [row(5005, 30)]]);
  eq(pendingFirst.transactions.filter(t => t.id === 5005).length, 1,
    'pending then posted in the window: one copy, no invented duplicate');

  // Different ids are never merged.
  const distinct = await fetched([[row(5006, 10)], [row(5007, 20)]]);
  eq(distinct.transactions.map(t => t.id), [5006, 5007], 'distinct ids: both kept');

  console.log('PASS conflicting posted ids survive pagination merging into the posted-duplicate guard: '
    + checks + ' independent checks');
})().catch(err => { console.error(err); process.exit(1); });
