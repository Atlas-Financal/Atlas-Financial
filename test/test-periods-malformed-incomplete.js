'use strict';
// A posted Lunch Money row whose amount or date cannot be read is dropped
// from history totals, so the period holding it is never published as
// complete or precise. Invented rows only; expected totals come from the
// inputs below, not from scripts/periods.js.
//   node test/test-periods-malformed-incomplete.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Periods = require('../scripts/periods.js');
const Assistant = require('../scripts/assistant-packet.js');

const data = {
  plan: { startingCash: { breakdown: [{ id: 'chequing-a' }, { id: 'chequing-b' }, { id: 'savings' }] } },
  debts: [{ id: 'cashback', label: 'Synthetic card' }],
};
const accountMap = {
  schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'live',
  mappings: [
    { providerAccountId: 'cash-a', atlasRole: 'household-cash', canonical: { collection: 'cash', id: 'chequing-a' } },
    { providerAccountId: 'cash-b', atlasRole: 'household-cash', canonical: { collection: 'cash', id: 'chequing-b' } },
    { providerAccountId: 'sav', atlasRole: 'household-cash', canonical: { collection: 'cash', id: 'savings' } },
    { providerAccountId: 'card', atlasRole: 'revolving-credit', canonical: { collection: 'debts', id: 'cashback' } },
  ],
};
const tx = (id, date, amount) => ({ providerTransactionId: id, providerAccountId: 'cash-a', date, amount,
  categoryLabel: 'Groceries', pending: false, isIncome: false, excludeFromTotals: false });

function build(rows) {
  const normalized = { transactionWindow: { startDate: '2026-01-01', endDate: '2026-03-31', complete: true }, transactions: rows };
  const built = Periods.buildLunchMoneyEvents({ normalized, accountMap, data, spendingRows: [], transactionRows: [] });
  return { built, out: Periods.buildPeriods(built.events, '2026-03-15', built.metadata) };
}

// Invented history: Feb 100 + 25 readable, Mar 40 readable. as-of Mar 15,
// so lastMonth = Feb, thisMonth = Mar.
const clean = [tx('a', '2026-02-01', 100), tx('b', '2026-02-03', 25), tx('c', '2026-03-01', 40)];

// 1. Clean history keeps its existing claims and adds no new fields.
{
  const { built, out } = build(clean);
  assert.equal(built.metadata.complete, true);
  assert.equal(built.metadata.coverageComplete, true);
  assert.equal(built.metadata.categoryClaim, 'precise');
  assert.equal(built.metadata.malformedTransactions, 0);
  assert.equal(out.periods.lastMonth.spendingTotal, 125);
  for (const id of ['thisMonth', 'lastMonth', 'ytd', 'all']) {
    assert.equal(out.periods[id].complete, undefined, id + ' clean period carries no incomplete mark');
    assert.equal(out.periods[id].categoryClaim, undefined);
  }
}

// 2. Each malformed amount shape in February marks February (and the
// windows containing it) incomplete, and leaves March alone.
for (const bad of ['not-a-number', NaN, Infinity, -Infinity, null, undefined, '', {}]) {
  const { built, out } = build(clean.concat([tx('bad', '2026-02-10', bad)]));
  const label = 'amount ' + String(bad);
  assert.equal(built.metadata.complete, false, label + ': history not complete');
  assert.equal(built.metadata.coverageComplete, true, label + ': coverage itself is whole');
  assert.equal(built.metadata.categoryClaim, 'incomplete', label + ': history not precise');
  assert.equal(built.metadata.malformedTransactions, 1, label);
  assert.deepEqual(built.metadata.malformedByMonth, { '2026-02': 1 }, label);
  assert.equal(out.periods.lastMonth.spendingTotal, 125, label + ': readable rows still total');
  for (const id of ['lastMonth', 'ytd', 'all']) {
    assert.equal(out.periods[id].complete, false, label + ': ' + id + ' incomplete');
    assert.equal(out.periods[id].categoryClaim, 'incomplete', label + ': ' + id + ' not precise');
    assert.equal(out.periods[id].malformedTransactions, 1, label + ': ' + id);
  }
  assert.equal(out.periods.thisMonth.complete, undefined, label + ': March is untouched');
  assert.equal(out.monthly.find(m => m.m === '2026-02').complete, false, label + ': Feb monthly row');
  assert.equal(out.monthly.find(m => m.m === '2026-03').complete, undefined, label + ': Mar monthly row');
}

// 3. A zero amount is a readable row with no spend: not malformed.
{
  const { built } = build(clean.concat([tx('zero', '2026-02-10', 0)]));
  assert.equal(built.metadata.malformedTransactions, 0);
  assert.equal(built.metadata.complete, true);
}

// 4. A row with no readable date could be in any period: every period and
// month is incomplete.
for (const badDate of ['2026-2-10', '', null, 'garbage']) {
  const { built, out } = build(clean.concat([tx('undated', badDate, 30)]));
  assert.equal(built.metadata.malformedUndated, 1, 'date ' + badDate);
  assert.equal(built.metadata.complete, false);
  for (const id of ['thisMonth', 'lastMonth', 'ytd', 'all']) {
    assert.equal(out.periods[id].complete, false, 'date ' + badDate + ': ' + id);
  }
  assert.ok(out.monthly.every(m => m.complete === false), 'date ' + badDate + ': every month');
}

// 5. The assistant packet's actuals window carries the incomplete mark.
const packetData = {
  meta: { asOf: '2026-03-15' },
  plan: {
    windowDays: 60, defaults: { targetBuffer: 0 }, opening: { asOf: '2026-03-15' },
    startingCash: { amount: 1000 },
    income: [{ id: 'p', label: 'Pay', frequency: 'once', date: '2026-03-20', amount: 500, confidence: 'confirmed' }],
    obligations: [], bills: [], commitments: [],
    budget: { basis: 'lastMonth', categories: [{ id: 'g', label: 'Groceries', class: 'essential', plannedMonthly: 0, ownerLine: 'Groceries' }] },
    nextDollar: { policy: 'highest-interest', provenance: 'owner-stated' },
  },
  debts: [{ id: 'card', label: 'Synthetic card', secured: false, structure: 'Revolving — test', balance: 100, rate: 19.99, limit: 1000, pending: 0 }],
};
const packetFor = periods => Assistant.buildPacket({ data: packetData, periods, now: '2026-03-15T12:00:00.000Z', env: {}, questionsMarkdown: '' });
{
  const bad = build(clean.concat([tx('bad', '2026-02-10', 'not-a-number')])).out;
  const win = packetFor(bad).actuals.window;
  assert.equal(win.basis, 'lastMonth');
  assert.equal(win.complete, false, 'packet window is not complete');
  assert.equal(win.categoryClaim, 'incomplete');
  assert.equal(win.malformedTransactions, 1);
  const good = packetFor(build(clean).out).actuals.window;
  assert.equal(good.complete, true);
  assert.equal(good.categoryClaim, 'precise');
  assert.equal(good.malformedTransactions, 0);

  // A malformed row outside the window (March) leaves the Feb window whole.
  const elsewhere = packetFor(build(clean.concat([tx('bad', '2026-03-02', 'x')])).out).actuals.window;
  assert.equal(elsewhere.complete, true, 'malformed row outside the window');
  assert.equal(elsewhere.categoryClaim, 'precise');

  // The window never claims more than the source: an incomplete source
  // (e.g. HELOC interest not covered) is not a complete window.
  const sourceIncomplete = build(clean).out;
  sourceIncomplete.source = Object.assign({}, sourceIncomplete.source, { complete: false, coverageComplete: false });
  assert.equal(packetFor(sourceIncomplete).actuals.window.complete, false, 'incomplete source');
  const legacy = build(clean).out;
  legacy.source = Object.assign({}, legacy.source, { complete: false });
  delete legacy.source.coverageComplete;
  assert.equal(packetFor(legacy).actuals.window.complete, false, 'source without coverage field stays incomplete');

  // Uncategorised rows keep the source's incomplete category claim.
  const uncategorised = build(clean.concat([Object.assign(tx('u', '2026-02-05', 9), { categoryLabel: 'Owner Review Needed' })])).out;
  assert.equal(uncategorised.source.categoryClaim, 'incomplete');
  assert.equal(packetFor(uncategorised).actuals.window.categoryClaim, 'incomplete', 'uncategorised');

  // A basis that reports no malformed rows (the local file fallback) is unknown.
  const local = build(clean).out;
  local.source = { basis: 'local-file-evidence', complete: true, categoryClaim: 'merchant-library' };
  const localWin = packetFor(local).actuals.window;
  assert.equal(localWin.complete, null, 'local basis completeness unknown');
  assert.equal(localWin.categoryClaim, 'merchant-library');
  assert.equal(localWin.malformedTransactions, null);
  // The fetched window must span the selected period: a March-only fetch
  // cannot call February (lastMonth) complete, even with zero spending.
  const marchOnly = (() => {
    const normalized = { transactionWindow: { startDate: '2026-03-01', endDate: '2026-03-31', complete: true },
      transactions: [tx('c', '2026-03-01', 40)] };
    const built = Periods.buildLunchMoneyEvents({ normalized, accountMap, data, spendingRows: [], transactionRows: [] });
    return Periods.buildPeriods(built.events, '2026-03-15', built.metadata);
  })();
  assert.equal(marchOnly.periods.lastMonth.coverageComplete, false, 'Feb not fetched');
  assert.equal(marchOnly.periods.ytd.coverageComplete, false, 'Jan-Feb not fetched');
  assert.equal(marchOnly.periods.thisMonth.coverageComplete, true, 'March fetched through as-of');
  assert.equal(marchOnly.periods.all.coverageComplete, true);
  const marchWin = packetFor(marchOnly).actuals.window;
  assert.equal(marchWin.basis, 'lastMonth');
  assert.equal(marchWin.complete, false, 'unfetched window is not complete');
  // A fetch that ends before as-of does not cover this month.
  const early = (() => {
    const normalized = { transactionWindow: { startDate: '2026-01-01', endDate: '2026-03-10', complete: true }, transactions: clean };
    const built = Periods.buildLunchMoneyEvents({ normalized, accountMap, data, spendingRows: [], transactionRows: [] });
    return Periods.buildPeriods(built.events, '2026-03-15', built.metadata);
  })();
  assert.equal(early.periods.thisMonth.coverageComplete, false, 'fetch ends before as-of');
  assert.equal(early.periods.lastMonth.coverageComplete, true);
  // A window without the per-period coverage field (older output) is unknown.
  const olderOut = build(clean).out;
  delete olderOut.periods.lastMonth.coverageComplete;
  assert.equal(packetFor(olderOut).actuals.window.complete, null, 'no per-period coverage is unknown');

  const noSource = build(clean).out;
  noSource.source = null;
  assert.equal(packetFor(noSource).actuals.window.complete, null, 'no source is unknown');
}

// 6. The site chip (public/app.js) says the history is incomplete.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const grab = re => { const m = re.exec(src); if (!m) throw new Error('missing ' + re); return m[0]; };
  const chip = vm.runInNewContext([
    grab(/^const fmtDateLong = .*$/m),
    grab(/^function chipIsoDate\([\s\S]*?\n\}$/m),
    grab(/^function liveSpendingEvidenceDate\([\s\S]*?\n\}$/m),
    grab(/^function formatSiteAsOfChip\([\s\S]*?\n\}$/m),
    '\nformatSiteAsOfChip;',
  ].join('\n'), {});
  const d = { meta: { asOf: '2026-03-15' } };
  const bad = build(clean.concat([tx('bad', '2026-02-10', 'x'), tx('bad2', 'nope', 5)])).out;
  const text = chip(d, bad);
  assert.ok(/historical spending incomplete \(2 transactions could not be read\)/.test(text), text);
  assert.ok(!/incomplete/.test(chip(d, build(clean).out)), 'clean history shows no incomplete note');
}

console.log('malformed posted rows make their history period incomplete: ok');
