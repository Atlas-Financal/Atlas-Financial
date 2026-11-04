'use strict';
// Exact sanitized-link contract; Budget wiring is covered separately.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Detail = require('../public/bill-detail');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const asOf = '2026-08-20';
  return {
    meta: { asOf }, debts: [], revolvingExtra: [],
    plan: {
      windowDays: 28, opening: { asOf, representedEvents: [{ id: 'bill', date: '2026-08-19' }] },
      defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'Synthetic bills account', value: 1000 }] },
      income: [{ id: 'payroll', label: 'Synthetic pay', frequency: 'biweekly',
        anchor: '2026-08-14', amount: 1000, confidence: 'confirmed' }],
      obligations: [], commitments: [], budget: { categories: [] },
      bills: [{ id: 'bill', label: 'Synthetic bill', frequency: 'biweekly', anchor: '2026-08-19',
        amount: 100, confidence: 'estimated', payingAccount: 'chequing-a' }],
    },
    liveOverlay: {
      applied: true, effectiveAsOf: asOf, observedAsOf: asOf, operatingPlan: 'live',
      currentPeriodActuals: { schema: 'atlas-current-period-actuals/v1', observationAsOf: asOf,
        coverageStart: '2026-08-14', coverageThrough: asOf,
        transactionCoverage: 'complete', pendingCoverage: 'complete',
        // The issued invented invoice is 97.50; 100 is its estimated allowance.
        representedActuals: [{ id: 'bill', date: '2026-08-19', actual: 97.5,
          postedOn: '2026-08-18', transactionId: 'tx-1', due: 97.5, amountRule: 'variable-amount' }],
        transactions: [{ id: 'tx-1', date: '2026-08-18', amount: 97.5, pending: false,
          atlasAccountId: 'chequing-a', account: 'chequing-a', accountRole: 'household-cash' }],
      },
    },
  };
}
function publication(data) {
  return F.recommend(data.plan, data.meta.asOf, {
    debts: data.debts, liveOverlay: data.liveOverlay,
    currentPeriodActuals: data.liveOverlay.currentPeriodActuals,
    preservePaydayPeriodOrigin: true,
  });
}
function publishedRow(data) {
  return publication(data).defaultView.calendarPeriods[0].bills.find(row => row.id === 'bill');
}
function cardObservation(mode = 'posted') {
  // Invented card payment through the actual observer/reconciler/overlay.
  // Provider credit sign remains negative; Forecast owns the bill row.
  const data = fixture();
  delete data.liveOverlay;
  data.plan.opening.representedEvents = [];
  data.plan.bills[0].amount = 250;
  data.debts = [{ id: 'travelvisa', label: 'Synthetic payment card', balance: 750,
    limit: 2000, apr: 0, minPayment: 0 }];
  const asOf = data.meta.asOf;
  const accountMap = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture',
    owns: 'Synthetic identities only.', does_not_own: 'Financial facts or write authority.', mappings: [
      { providerAccountId: '8001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
      { providerAccountId: '8002', canonical: { collection: 'debts', id: 'travelvisa' }, atlasRole: 'revolving-credit' },
    ] };
  const tx = { id: 8101, account_id: 8002, date: '2026-08-19', amount: -250, currency: 'cad',
    is_pending: mode === 'pending', payee: 'Synthetic card payment', notes: 'Synthetic private note' };
  if (mode === 'refund' || mode === 'reversal') tx.payee += ' ' + mode.toUpperCase();
  const rule = { eventId: 'bill', payeePattern: 'Synthetic card payment', atlasAccountId: 'travelvisa',
    direction: 'credit', payeeExcludePatterns: ['REFUND', 'REVERSAL'] };
  if (mode === 'unknown') delete rule.direction;
  if (mode === 'split') { tx.amount = -125; rule.settlesWhen = 'two-leg-sum'; rule.sameAccountSplitLegs = true; }
  const payload = { provider: 'lunchmoney', fetchedAt: asOf + 'T18:00:00Z',
    transactionWindow: { startDate: '2026-08-14', endDate: asOf, complete: true, hasMore: false },
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false }, accounts: [
      { id: 8001, type: 'cash', name: 'Synthetic bills', balance: 1000, updated_at: asOf + 'T17:55:00Z' },
      { id: 8002, type: 'credit', subtype: 'credit_card', name: 'Synthetic card', balance: 750,
        credit_limit: 2000, updated_at: asOf + 'T17:55:00Z' },
    ], transactions: mode === 'split' ? [tx, { ...tx, id: 8102 }] : [tx] };
  const before = JSON.stringify({ data, payload, accountMap });
  const result = Live.fromObservation({ data, payload, accountMap, identity: { rules: [rule] } });
  assert.equal(JSON.stringify({ data, payload, accountMap }), before, 'observation inputs unchanged');
  assert.equal(result.data.liveOverlay.applied, true);
  return result.data;
}
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function observationContract() {
  // Exercise the incumbent observer/reconciler/overlay with invented input.
  // These fixture rules invoke existing identity code; the disclosure gets
  // only the resulting sanitized packet and never sees provider fields.
  const canonical = fixture();
  delete canonical.liveOverlay;
  canonical.plan.opening.representedEvents = [];
  const before = JSON.stringify(canonical);
  const asOf = canonical.meta.asOf;
  const map = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture',
    owns: 'Synthetic identities only.', does_not_own: 'Financial facts or write authority.',
    mappings: [{ providerAccountId: '8001', canonical: { collection: 'cash', id: 'chequing-a' },
      atlasRole: 'household-cash' }] };
  const rule = { eventId: 'bill', payeePattern: 'Synthetic bill',
    atlasAccountId: 'chequing-a', direction: 'debit', settlesWhen: 'partial' };
  for (const mode of ['single', 'multiple', 'pending', 'unlinked']) {
    const tx = { id: 8101, account_id: 8001, date: '2026-08-19', amount: 97.5,
      currency: 'cad', is_pending: mode === 'pending', payee: 'Synthetic bill', notes: 'Synthetic private note' };
    const payload = { provider: 'lunchmoney', fetchedAt: asOf + 'T18:00:00Z',
      transactionWindow: { startDate: '2026-08-14', endDate: asOf, complete: true, hasMore: false },
      pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false },
      accounts: [{ id: 8001, type: 'cash', name: 'Synthetic bills', balance: 1000,
        updated_at: asOf + 'T17:55:00Z' }],
      transactions: mode === 'multiple' ? [tx, { ...tx, id: 8102, amount: 2.5 }] : [tx] };
    const identity = { rules: mode === 'unlinked' ? [] : [mode === 'multiple'
      ? { ...rule, settlesWhen: 'two-leg-sum', sameAccountSplitLegs: true } : rule] };
    const payloadBefore = JSON.stringify(payload), mapBefore = JSON.stringify(map);
    const result = Live.fromObservation({ data: canonical, payload, accountMap: map, identity });
    assert.equal(result.data.liveOverlay.applied, true);
    const row = publishedRow(result.data), proof = Detail.evidence(row, result.data);
    const amounts = mode === 'unlinked' ? [] : mode === 'multiple' ? [97.5, 2.5] : [97.5];
    assert.deepEqual(proof.payments.map(p => p.amount), amounts, mode + ' real packet links');
    if (mode === 'pending') assert.equal(proof.payments[0].pending, true);
    assert.doesNotMatch(Detail.html(row, result.data), /Synthetic private note|8101|8102|8001/);
    const publicationBefore = JSON.stringify(publication(result.data));
    freeze(result.data); freeze(row);
    Detail.html(row, result.data);
    assert.equal(JSON.stringify(publication(result.data)), publicationBefore);
    assert.equal(JSON.stringify(payload), payloadBefore);
    assert.equal(JSON.stringify(map), mapBefore);
    assert.equal(JSON.stringify(canonical), before);
  }
}

function run() {
  observationContract();
  for (const mode of ['posted', 'pending', 'split', 'unknown', 'refund', 'reversal']) {
    const card = cardObservation(mode), row = publishedRow(card);
    const before = JSON.stringify({ data: card, publication: publication(card) });
    const payments = Detail.evidence(row, card).payments;
    const output = Detail.html(row, card);
    if (mode === 'refund' || mode === 'reversal' || mode === 'pending') {
      assert.deepEqual(payments, [], mode + ' has no incumbent exact link');
      assert.match(output, /Transaction evidence is unavailable/);
      assert.doesNotMatch(output, /Transaction amount<|\(credit\)/);
    } else {
      assert.deepEqual(payments.map(p => p.amount), mode === 'split' ? [-125, -125] : [-250]);
      assert.match(output, mode === 'split' ? /\$-125\.00 \(credit\)/ : /\$-250\.00 \(credit\)/);
      assert.match(output, /Debits are positive and credits negative for the transaction account/);
      assert.match(output, /sign alone does not identify a payment, refund or reversal/);
      assert.match(output, /Actual<\/dt><dd>\$-250\.00/, 'Forecast signed actual is untouched');
      if (mode === 'split') assert.equal((output.match(/\(credit\)/g) || []).length, 2);
      assert.doesNotMatch(output, /Synthetic private note|8101|8102|8002/);
      freeze(card); freeze(row); Detail.html(row, card);
    }
    assert.equal(JSON.stringify({ data: card, publication: publication(card) }), before);
  }
  const data = fixture(), row = publishedRow(data), packet = data.liveOverlay.currentPeriodActuals;
  // Independent supplied-dollar facts: planned $100, observed $97.50, remaining
  // $0 because Forecast already marked the exact occurrence represented.
  assert.deepEqual([row.id, row.date, row.status, row.planned, row.actual, row.remaining],
    ['bill', '2026-08-19', 'PAID', 100, 97.5, 0]);
  assert.deepEqual(Detail.evidence(row, data).payments,
    [{ date: '2026-08-18', amount: 97.5, account: 'chequing-a', pending: false }]);
  const html = Detail.html(row, data, { label: 'Synthetic bill · PAID', amount: '−$97.50' });
  assert.match(html, /Transaction amount<\/dt><dd>\$97\.50 \(debit\)/);
  // Direction explains the signed amount, never its cause. Unknown metadata
  // and refund/reversal hints cannot turn a linked credit into a payment claim.
  for (const kindHint of [null, 'refund', 'reversal', '<img src=x onerror=bad>']) {
    for (const amount of [-250, 250, 0]) {
      const signed = clone(data);
      Object.assign(signed.liveOverlay.currentPeriodActuals.transactions[0], { amount, kindHint,
        direction: '<svg onload=bad>', accountRole: '<img src=x onerror=bad>' });
      const output = Detail.html(row, signed);
      assert.match(output, amount < 0 ? /\$-250\.00 \(credit\)/ : amount > 0
        ? /\$250\.00 \(debit\)/ : /\$0\.00 \(direction unavailable\)/);
      assert.match(output, /sign alone does not identify a payment, refund or reversal/);
      assert.doesNotMatch(output, /<img|<svg|onerror|onload|Payment credited|Refund credited|Reversal posted/);
      assert.equal(Detail.evidence(row, signed).payments[0].amount, amount);
      assert.deepEqual([row.planned, row.actual, row.remaining], [100, 97.5, 0]);
    }
  }
  for (const expected of ['<details', '<summary class="operating-line"', 'data-period-bill="bill"',
    'data-bill-status="PAID"', 'data-bill-date="2026-08-19"', 'Due date', '2026-08-19', '$100.00', '$97.50',
    '$0.00', row.payerLabel, 'Synthetic bills account', 'estimated', 'Posted', '2026-08-18']) {
    assert.ok(html.includes(expected), expected);
  }
  assert.ok(!html.includes('open='), 'disclosure starts closed');
  const multi = clone(data), mp = multi.liveOverlay.currentPeriodActuals;
  mp.representedActuals[0].transactionIds = ['tx-1', 'tx-2', 'tx-1'];
  mp.transactions.push({ ...mp.transactions[0], id: 'tx-2', amount: 2.5, date: '2026-08-19' });
  mp.transactions.push(clone(mp.transactions[0]));
  mp.representedActuals.push(clone(mp.representedActuals[0]));
  assert.deepEqual(Detail.evidence(row, multi).payments.map(p => p.amount), [97.5, 2.5]);
  assert.equal((Detail.html(row, multi).match(/<li>/g) || []).length, 2, 'duplicate links/rows print once');
  const noSingle = clone(multi);
  delete noSingle.liveOverlay.currentPeriodActuals.representedActuals[0].transactionId;
  delete noSingle.liveOverlay.currentPeriodActuals.representedActuals[1].transactionId;
  assert.equal(Detail.evidence(row, noSingle).payments.length, 2, 'plural-only link is supported');

  const pending = clone(data);
  pending.liveOverlay.currentPeriodActuals.transactions[0].pending = true;
  pending.liveOverlay.currentPeriodActuals.representedActuals[0].postedOn = '2026-08-19';
  assert.match(Detail.html(row, pending), /Pending — not a posted payment/);
  pending.liveOverlay.currentPeriodActuals.transactions[0].amount = -250;
  assert.match(Detail.html(row, pending), /\$-250\.00 \(credit\)/);
  assert.match(Detail.html(row, pending), /Pending — not a posted payment/);
  assert.match(Detail.html(row, pending), /Published status<\/dt><dd>PAID/);
  assert.match(Detail.html(row, pending), /Transaction date<\/dt><dd>2026-08-18/,
    'date is the transaction date, never represented postedOn or due date');
  const mixed = clone(multi);
  mixed.liveOverlay.currentPeriodActuals.transactions[1].pending = true;
  assert.deepEqual(Detail.evidence(row, mixed).payments.map(p => p.pending), [false, true]);

  const unavailableCases = [
    ['no applied overlay', d => { d.liveOverlay.applied = false; }],
    ['unavailable operating plan', d => { d.liveOverlay.operatingPlan = 'unavailable'; }],
    ['old packet', d => { d.liveOverlay.currentPeriodActuals.observationAsOf = '2026-08-19'; }],
    ['old applied observation', d => { d.liveOverlay.observedAsOf = '2026-08-19'; }],
    ['different opening', d => { d.plan.opening.asOf = '2026-08-21'; }],
    ['different served date', d => { d.meta.asOf = '2026-08-21'; }],
    ['unrelated matching amount/date', d => { d.liveOverlay.currentPeriodActuals.representedActuals = []; }],
    ['different bill', d => { d.liveOverlay.currentPeriodActuals.representedActuals[0].id = 'other'; }],
    ['different occurrence', d => { d.liveOverlay.currentPeriodActuals.representedActuals[0].date = '2026-09-02'; }],
    ['missing transaction', d => { d.liveOverlay.currentPeriodActuals.transactions = []; }],
    ['missing link', d => { delete d.liveOverlay.currentPeriodActuals.representedActuals[0].transactionId; }],
    ['missing one of several links', d => { d.liveOverlay.currentPeriodActuals.representedActuals[0].transactionIds = ['tx-1', 'absent']; }],
    ['single/plural conflict', d => { d.liveOverlay.currentPeriodActuals.representedActuals[0].transactionIds = ['tx-2']; }],
    ['conflicting duplicate transaction', d => { d.liveOverlay.currentPeriodActuals.transactions.push({ ...packet.transactions[0], amount: 2 }); }],
    ['conflicting duplicate occurrence', d => { d.liveOverlay.currentPeriodActuals.representedActuals.push({ ...packet.representedActuals[0], actual: 2 }); }],
    ['link reused by another occurrence', d => { d.liveOverlay.currentPeriodActuals.representedActuals.push({ ...packet.representedActuals[0], date: '2026-09-02' }); }],
    ['ambiguous pending/posting', d => { d.liveOverlay.currentPeriodActuals.transactions[0].pendingPostedAmbiguous = true; }],
    ['superseded pending', d => { d.liveOverlay.currentPeriodActuals.transactions[0].pendingPostedDuplicate = true; }],
    ['conflicting accounts', d => { d.liveOverlay.currentPeriodActuals.transactions[0].account = 'other'; }],
    ['unknown amount', d => { d.liveOverlay.currentPeriodActuals.transactions[0].amount = null; }],
    ['coerced amount', d => { d.liveOverlay.currentPeriodActuals.transactions[0].amount = '97.5'; }],
    ['unknown pending', d => { delete d.liveOverlay.currentPeriodActuals.transactions[0].pending; }],
    ['future transaction', d => { d.liveOverlay.currentPeriodActuals.transactions[0].date = '2026-08-21'; }],
    ['invalid transaction date', d => { d.liveOverlay.currentPeriodActuals.transactions[0].date = '2026-02-30'; }],
  ];
  for (const [name, change] of unavailableCases) {
    const edited = clone(data); change(edited);
    assert.equal(Detail.evidence(row, edited).payments.length, 0, name);
    const output = Detail.html(row, edited);
    assert.match(output, /marked PAID by Forecast\. Transaction evidence is unavailable/, name);
    assert.match(output, /Missing evidence does not mean unpaid/, name);
    assert.doesNotMatch(output, /Transaction date<|Transaction amount</, name);
  }
  const future = { ...row, date: '2026-09-02', actual: 0, remaining: 100, status: 'still-due', settlement: 'upcoming' };
  const late = { ...future, status: 'unverified', settlement: 'unverified' };
  for (const bill of [future, late, { ...row, date: null, needsDate: true }]) {
    assert.equal(Detail.evidence(bill, data).payments.length, 0);
    assert.match(Detail.html(bill, data), /Missing evidence does not mean unpaid/);
  }
  const schedulePaid = clone(data);
  schedulePaid.liveOverlay.currentPeriodActuals.representedActuals[0] = { id: row.id, date: row.date, actual: 100 };
  assert.match(Detail.html(row, schedulePaid), /Transaction evidence is unavailable/);

  // Local sanitized identities may be reassigned on refresh; only this packet
  // can resolve them. Removing a link must never keep an earlier payment.
  const refreshed = clone(data);
  refreshed.liveOverlay.currentPeriodActuals.transactions[0].amount = 83;
  assert.equal(Detail.evidence(row, refreshed).payments[0].amount, 83);
  refreshed.liveOverlay.currentPeriodActuals.representedActuals = [];
  assert.equal(Detail.evidence(row, refreshed).payments.length, 0);
  assert.equal(Detail.evidence(row, data).payments[0].amount, 97.5);

  const hostile = '<img src=x onerror="globalThis.hacked=true">&\'"';
  const hostileData = clone(data);
  hostileData.plan.startingCash.breakdown[0].label = hostile;
  Object.assign(hostileData.liveOverlay.currentPeriodActuals.transactions[0], {
    payee: 'PRIVATE PAYEE', notes: 'PRIVATE NOTES', providerTransactionId: 'PRIVATE ID',
    plaid_metadata: { anything: 'PRIVATE METADATA' }, tags: ['PRIVATE TAG'],
  });
  const safe = Detail.html({ ...row, label: hostile, payerLabel: hostile, confidence: hostile, status: hostile },
    hostileData, { label: hostile, amount: hostile });
  assert.doesNotMatch(safe, /<img|PRIVATE|plaid_metadata|providerTransactionId|tx-1/);
  assert.match(safe, /&lt;img/);
  assert.match(safe, /&quot;/);
  const unknown = Detail.html({ ...row, actual: null, remaining: null, planned: null }, data);
  assert.match(unknown, /Actual<\/dt><dd>Unavailable/);
  assert.match(unknown, /Remaining<\/dt><dd>Unavailable/);

  const inputs = JSON.stringify(data), answer = JSON.stringify(publication(data));
  freeze(data); freeze(row);
  for (let i = 0; i < 3; i++) Detail.html(row, data);
  assert.equal(JSON.stringify(data), inputs, 'all input packet bytes remain unchanged');
  assert.equal(JSON.stringify(publication(data)), answer, 'entire Forecast publication remains unchanged');
  const root = path.join(__dirname, '..');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'public/bill-detail.js'), 'utf8'),
    /\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage)\s*[.(]/, 'no fetch/write/cache seam');
  console.log('PASS isolated bill detail: exact links, single/multiple, periods, pending, unavailable/conflicts, hostile text, immutable inputs and all Forecast outputs');
}
module.exports = { fixture, cardObservation, publishedRow, publication };
if (require.main === module) run();
