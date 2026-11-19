'use strict';
/* The bill detail's "Last 6 months" Unavailable reasons have two homes: the
 * observer emits them (scripts/provider-observe.js billPaymentHistory) and
 * the page explains them (public/bill-detail.js HISTORY_REASONS, plus its
 * literal list of per-bill reasons). A reason the observer adds and the page
 * doesn't know is not dropped: the page silently prints a wrong explanation
 * ("could not be read" or "could not be summarised"). A page entry with no
 * producer is dead text. This test keeps the two equal.
 *
 * Failure it detects: an observer reason the page has no text for, a page
 * reason nothing produces, or the page's per-bill list drifting from the
 * observer's per-bill reasons. Release decision: any failure blocks.
 *
 * Source only (no change to either file); invented series only.
 *   node test/test-bill-history-reason-parity.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

// 1. What the observer emits, read from billPaymentHistory's source.
const observerSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'provider-observe.js'), 'utf8');
const start = observerSrc.indexOf('function billPaymentHistory(');
check(start >= 0, 'billPaymentHistory is in provider-observe.js');
const end = observerSrc.indexOf('\nfunction ', start + 1);
const historySrc = observerSrc.slice(start, end);
// Series-level reasons: the default `reason: '...'` on `out` and every
// `out.reason = '...'`. Per-bill reasons: `reason: '...'` on pushed bill rows.
const seriesReasons = new Set([
  ...[...historySrc.matchAll(/out\.reason = '([^']+)'/g)].map(m => m[1]),
  ...[...historySrc.matchAll(/const out = \{[^}]*reason: '([^']+)'/g)].map(m => m[1]),
]);
const perBillReasons = new Set([...historySrc.matchAll(/out\.bills\.push\(\{[^}]*reason: '([^']+)'/g)].map(m => m[1]));
check(seriesReasons.size >= 1 && perBillReasons.size >= 1, 'the observer emits series and per-bill reasons');
// Every `reason` literal in the function is one of the two kinds, so nothing is missed.
const allLiterals = new Set([...historySrc.matchAll(/reason(?: =|:) '([^']+)'/g)].map(m => m[1]));
check([...allLiterals].every(r => seriesReasons.has(r) || perBillReasons.has(r)),
  `every reason literal in billPaymentHistory is classified (${[...allLiterals].join(', ')})`);

// 2. What the page explains, read from bill-detail.js.
const pageSrc = fs.readFileSync(path.join(ROOT, 'public', 'bill-detail.js'), 'utf8');
const mapMatch = /const HISTORY_REASONS = \{([\s\S]*?)\n  \};/.exec(pageSrc);
check(mapMatch, 'bill-detail.js has HISTORY_REASONS');
const pageKeys = new Set([...mapMatch[1].matchAll(/^\s*'?([a-z][a-z-]*)'?:/gm)].map(m => m[1]));
const listMatch = /entries\[0\]\.status === 'unavailable'\) return historyUnavailable\(\[([^\]]*)\]\.includes\(entries\[0\]\.reason\)/.exec(pageSrc);
check(listMatch, "bill-detail.js names the per-bill reasons it explains");
const pagePerBill = new Set([...listMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
// The page's own reasons, produced in historyHtml itself (not by the observer).
const PAGE_LOCAL = ['observation', 'no-identity', 'summary'];
for (const local of PAGE_LOCAL) {
  check(new RegExp(`historyUnavailable\\('${local}'\\)`).test(pageSrc), `the page itself produces '${local}'`);
}

for (const r of seriesReasons) check(pageKeys.has(r), `the page has its own text for the observer's series reason '${r}'`);
for (const r of perBillReasons) check(pageKeys.has(r), `the page has its own text for the observer's per-bill reason '${r}'`);
assert.deepEqual([...pagePerBill].sort(), [...perBillReasons].sort(), "the page's per-bill list equals the observer's per-bill reasons");
checks++;
for (const k of pageKeys) {
  check(seriesReasons.has(k) || perBillReasons.has(k) || PAGE_LOCAL.includes(k), `page reason '${k}' has a producer`);
}

// 3. Behaviour: the page prints each reason's own text. Wording written out
// here, not read from the page.
const Detail = require('../public/bill-detail.js');
const AS_OF = '2026-10-17';
const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
const dataWith = series => ({ meta: { asOf: AS_OF }, plan: { opening: { asOf: AS_OF } },
  liveOverlay: { applied: true, effectiveAsOf: AS_OF, observedAsOf: AS_OF, billPaymentHistory: series } });
const expected = {
  'history-unavailable': 'the Lunch Money payment history could not be read',
  'history-incomplete': 'the Lunch Money payment history read was incomplete',
  'history-too-short': 'the payment history read does not reach back six months',
  'paid-in-parts': 'this bill is paid in parts, so one debit is not one payment',
  'duplicate-record': 'Lunch Money returned one of this bill’s payments more than once',
  'no-identity': 'this bill has no payment identity to find its payments by',
  observation: 'the live Lunch Money read is not current',
  summary: 'the payment history could not be summarised',
};
const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const shows = (html, reason) => html.includes(`data-bill-history-reason="${reason}"`)
  && (html.includes(expected[reason]) || html.includes(escape(expected[reason])));
const base = { source: 'lunchmoney-payment-history', asOf: AS_OF, months: MONTHS };
for (const r of seriesReasons) {
  const html = Detail.historyHtml({ id: 'hydro' }, dataWith({ ...base, status: 'unavailable', reason: r, bills: [] }));
  check(expected[r] && shows(html, r), `series reason '${r}' prints its own text`);
}
for (const r of perBillReasons) {
  const html = Detail.historyHtml({ id: 'hydro' }, dataWith({ ...base, status: 'complete',
    bills: [{ billId: 'hydro', status: 'unavailable', reason: r, payments: [] }] }));
  check(expected[r] && shows(html, r), `per-bill reason '${r}' prints its own text`);
}
check(shows(Detail.historyHtml({ id: 'hydro' }, dataWith({ ...base, status: 'complete', bills: [] })), 'no-identity'),
  "a bill with no series entry prints 'no-identity'");
check(shows(Detail.historyHtml({ id: 'hydro' }, { ...dataWith(null), meta: { asOf: '2026-10-16' } }), 'observation'),
  "an observation for another day prints 'observation'");
// The fallbacks for a reason the page doesn't know (what a drift would print).
check(shows(Detail.historyHtml({ id: 'hydro' }, dataWith({ ...base, status: 'unavailable', reason: 'not-a-reason', bills: [] })),
  'history-unavailable'), "an unknown series reason falls back to 'history-unavailable'");
check(shows(Detail.historyHtml({ id: 'hydro' }, dataWith({ ...base, status: 'complete',
  bills: [{ billId: 'hydro', status: 'unavailable', reason: 'not-a-reason', payments: [] }] })), 'summary'),
"an unknown per-bill reason falls back to 'summary'");

console.log(`bill history reason parity: ${checks} checks passed (series: ${[...seriesReasons].join(', ')}; per bill: ${[...perBillReasons].join(', ')})`);
