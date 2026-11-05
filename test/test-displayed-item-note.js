'use strict';
/* Budget Spent breakdown shows a deliberately marked Lunch Money note.
 * `node test/test-displayed-item-note.js`
 *
 * One outcome: a note that starts with "item:" is published as the bounded,
 * display-only field `displayedNote` and rendered under the payee. Every other
 * note stays hidden, raw notes are still stripped and rejected by the
 * sanitization guards, and no Forecast figure or classification reads the
 * field. Synthetic fixtures only; no household data, no provider calls.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function grab(src, re, label) {
  const match = re.exec(src);
  if (!match) throw new Error('missing ' + label);
  return match[0];
}

// ---- Observer fixture -------------------------------------------------
const MAP = JSON.parse(read('docs/connectivity/fixtures/provider-account-map.json'));
const DATA = JSON.parse(read('data.json'));
function observeWithNotes(notesById) {
  const txs = Object.keys(notesById).map((key, i) => {
    const tx = {
      id: 100 + i, account_id: 1001, date: '2026-09-02', amount: 10 + i,
      category_id: 11, is_pending: false,
      payee: 'SYNTHETIC MERCHANT ' + key, original_name: 'SYNTHETIC MERCHANT ' + key,
    };
    if (notesById[key] !== undefined) tx.notes = notesById[key];
    return tx;
  });
  const payload = {
    provider: 'lunchmoney',
    fetchedAt: '2026-09-08T18:00:00.000Z',
    transactionWindow: { startDate: '2026-09-01', endDate: '2026-09-08' },
    pendingCoverage: { complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false },
    accounts: [{ id: 1001, name: 'Cheq', type: 'cash', balance: 100, updated_at: '2026-09-08T17:00:00.000Z' }],
    categories: [
      { id: 11, name: 'Groceries', is_income: false, exclude_from_totals: false },
      { id: 82, name: 'Transfer', is_income: false, exclude_from_totals: true },
    ],
    transactions: txs,
  };
  const report = O.observe({ provider: 'lunchmoney', payload, accountMap: MAP, data: DATA });
  const rows = report.currentPeriodActuals.transactions;
  const byKey = {};
  Object.keys(notesById).forEach((key, i) => {
    byKey[key] = rows.find(r => r.amount === 10 + i);
  });
  return { report, rows, byKey };
}
const noteOf = row => (row ? row.displayedNote : undefined);
const hasNote = row => !!row && Object.prototype.hasOwnProperty.call(row, 'displayedNote');

console.log('\n=== 1. named constants ===');
{
  ok(O.DISPLAYED_NOTE_PREFIX === 'item:', 'prefix is the named constant "item:"');
  ok(O.DISPLAYED_NOTE_MAX_CHARS === 60, 'cap is the named constant 60');
}

console.log('\n=== 2. an item: note is shown, prefix stripped ===');
{
  const long = 'item: ' + 'x'.repeat(100);
  const exact = 'item: ' + 'y'.repeat(60);
  const over = 'item: ' + 'z'.repeat(61);
  const { byKey } = observeWithNotes({
    plain: 'item: Disney+',
    upper: 'ITEM: Disney+',
    mixed: 'iTeM:Netflix',
    lead: '   \t item:   Spotify  ',
    inner: 'item:  A \t  B  \u0001 C ',
    long, exact, over,
    empty: 'item:',
    blank: 'item:   \n\t ',
    stray: 'weekly shop',
    dale: 'dale',
    amanda: 'amanda',
    items: 'items: nope',
    mid: 'gift item: nope',
    spaced: 'item : nope',
    tagged: 'Dale item: nope',
    none: undefined,
    numeric: 12345,
    object: { text: 'item: nope' },
  });
  ok(noteOf(byKey.plain) === 'Disney+', "'item: Disney+' shows 'Disney+'");
  ok(noteOf(byKey.upper) === 'Disney+', 'prefix is case-insensitive (ITEM:)');
  ok(noteOf(byKey.mixed) === 'Netflix', 'case-insensitive, no space after colon (iTeM:)');
  ok(noteOf(byKey.lead) === 'Spotify', 'leading whitespace allowed, result trimmed');
  ok(noteOf(byKey.inner) === 'A B C', 'inner whitespace and control characters collapse to single spaces');
  ok(noteOf(byKey.long) === 'x'.repeat(59) + '\u2026' && noteOf(byKey.long).length === 60,
    'over-long note is capped at 60 characters including the ellipsis');
  ok(noteOf(byKey.exact) === 'y'.repeat(60), 'exactly 60 characters is not truncated');
  ok(noteOf(byKey.over) === 'z'.repeat(59) + '\u2026', '61 characters is truncated with an ellipsis');
  ok(!hasNote(byKey.empty) && !hasNote(byKey.blank), "'item:' and whitespace-only after the prefix give no note");
  ok(!hasNote(byKey.stray), 'an unprefixed note stays hidden');
  ok(!hasNote(byKey.dale) && !hasNote(byKey.amanda), 'owner-tag notes (dale, amanda) stay hidden');
  ok(!hasNote(byKey.items) && !hasNote(byKey.mid) && !hasNote(byKey.spaced) && !hasNote(byKey.tagged),
    'near-miss prefixes (items:, mid-text, "item :", other text first) stay hidden');
  ok(!hasNote(byKey.none), 'a row with no note has no displayedNote key');
  ok(!hasNote(byKey.numeric) && !hasNote(byKey.object), 'non-string notes give no note');
}

console.log('\n=== 2b. only the first line of a marked note publishes ===');
{
  const longLater = 'L'.repeat(80);
  const { report, byKey } = observeWithNotes({
    lf: 'item: Synthetic Film\nSECONDLINE text',
    crlf: 'item: Synthetic Stream\r\nSECONDLINE text\r\nTHIRDLINE',
    cr: 'item: Synthetic Show\rSECONDLINE text',
    unicode: 'item: Synthetic App\u2028SECONDLINE\u2029THIRDLINE\u0085FOURTHLINE',
    vtff: 'item: Synthetic Game\u000bSECONDLINE\u000cTHIRDLINE',
    longLater: 'item: Short\n' + longLater,
    capFirst: 'item: ' + 'f'.repeat(70) + '\nSECONDLINE',
    blankFirst: 'item:\nSECONDLINE text',
    spacesFirst: 'item:   \t \r\nSECONDLINE text',
    laterMarked: 'weekly shop\nitem: SECONDLINE',
    laterMarkedCrlf: 'dale\r\nitem: SECONDLINE',
    leadingBreak: '\nitem: SECONDLINE',
  });
  ok(noteOf(byKey.lf) === 'Synthetic Film', 'LF: only the item: line publishes');
  ok(noteOf(byKey.crlf) === 'Synthetic Stream', 'CRLF: only the item: line publishes');
  ok(noteOf(byKey.cr) === 'Synthetic Show', 'CR: only the item: line publishes');
  ok(noteOf(byKey.unicode) === 'Synthetic App', 'U+2028 / U+2029 / U+0085 end the first line');
  ok(noteOf(byKey.vtff) === 'Synthetic Game', 'vertical tab and form feed end the first line');
  ok(noteOf(byKey.longLater) === 'Short', 'a later line longer than the cap is still excluded');
  ok(noteOf(byKey.capFirst) === 'f'.repeat(59) + '\u2026', 'the cap applies to the first line alone');
  ok(!hasNote(byKey.blankFirst) && !hasNote(byKey.spacesFirst),
    'an empty item: line gives no note even when a later line has text');
  ok(!hasNote(byKey.laterMarked) && !hasNote(byKey.laterMarkedCrlf),
    'a note whose marked line is not the first line stays unpublished');
  ok(!hasNote(byKey.leadingBreak), 'a note starting with a line break has an empty first line and stays unpublished');
  const blob = JSON.stringify(report.currentPeriodActuals);
  ok(!/SECONDLINE|THIRDLINE|FOURTHLINE|LLLL/.test(blob), 'no later-line text appears anywhere in the published packet');
  ok(O.displayedItemNote('item: A\nB') === 'A' && O.displayedItemNote('x\nitem: B') === null,
    'exported displayedItemNote agrees with the observe() path');
}

console.log('\n=== 3. raw notes are still stripped and the guards still reject them ===');
{
  const { report, rows } = observeWithNotes({
    a: 'item: Disney+', b: 'weekly shop SECRETWORD', c: 'dale',
  });
  const blob = JSON.stringify(report.currentPeriodActuals);
  ok(rows.every(t => !('notes' in t) && !('note' in t) && !('tags' in t) && !('payee' in t)),
    'published rows carry no notes, note, tags or payee keys');
  ok(!/SECRETWORD/.test(blob) && !/"notes"\s*:/.test(blob) && !/"note"\s*:/.test(blob),
    'raw note text never appears in the published packet');
  ok(O.currentPeriodActualsLooksSanitized(report.currentPeriodActuals),
    'packet carrying only displayedNote passes the sanitizer');
  ok(O.transactionLooksSanitized({ id: 'x', date: '2026-09-02', amount: 1, displayedNote: 'Disney+' }),
    'transactionLooksSanitized accepts the bounded field');
  for (const key of ['notes', 'note']) {
    const leaked = { schema: 'atlas-current-period-actuals/v1',
      transactions: [{ id: 'x', date: '2026-09-02', amount: 1, displayedNote: 'Disney+', [key]: 'item: Disney+' }] };
    ok(!O.currentPeriodActualsLooksSanitized(leaked), `sanitizer still rejects raw ${key} next to displayedNote`);
  }
  const stripped = O.transactionLooksSanitized(
    { id: 'x', date: '2026-09-02', amount: 1, displayedNote: 'Disney+', notes: 'item: Disney+' });
  ok(stripped === false, 'transactionLooksSanitized still rejects a raw notes key');
}

console.log('\n=== 4. note follows displayedPayee eligibility ===');
{
  const { byKey } = observeWithNotes({ keep: 'item: Disney+' });
  ok(noteOf(byKey.keep) === 'Disney+' && byKey.keep.displayedPayee,
    'an eligible spend row publishes payee and note together');
  const src = read('scripts/provider-observe.js');
  ok(/delete row\.displayedPayee;\s*delete row\.originalMerchant;\s*delete row\.displayedNote;/.test(src),
    'displayedNote is deleted wherever displayedPayee is withheld');
}

console.log('\n=== 5. Forecast carries the field display-only; figures and classification do not move ===');
{
  const plan = {
    defaults: { targetBuffer: 500 },
    startingCash: { breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }] },
    opening: { asOf: '2026-08-28', representedEvents: [] },
    income: [{ id: 'payroll', label: 'Payroll', frequency: 'biweekly', anchor: '2026-08-14', amount: 4264, confidence: 'confirmed' }],
    bills: [], obligations: [], commitments: [],
    budget: { categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential', plannedWeekly: 450, ownerLine: 'Groceries' },
      { id: 'dale-guilt-free', label: 'Dale guilt-free spending', class: 'discretionary', plannedPayday: 150, ownerLine: 'Dale guilt-free spending' },
      { id: 'amanda-guilt-free', label: 'Amanda guilt-free spending', class: 'discretionary', plannedPayday: 150, ownerLine: 'Amanda guilt-free spending' },
      { id: 'shopping', label: 'Shopping', class: 'discretionary', from: ['Shopping', 'Personal'] },
    ] },
  };
  const mk = note => [
    { id: 'tx-a', date: '2026-08-29', amount: 84.32, pending: false, categoryLabel: 'Groceries',
      accountRole: 'household-cash', displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods', ...(note ? { displayedNote: note } : {}) },
    { id: 'tx-b', date: '2026-08-30', amount: 19.99, pending: false, categoryLabel: 'Shopping',
      accountRole: 'household-cash', displayedPayee: 'Disney', originalMerchant: 'Disney', ...(note ? { displayedNote: note } : {}) },
  ];
  const run = txs => F.recommend(plan, '2026-09-01', {
    targetBuffer: 500, debts: [],
    currentPeriodActuals: { schema: 'atlas-current-period-actuals/v1', observationAsOf: '2026-09-01',
      coverageStart: '2026-07-01', coverageThrough: '2026-09-01', pendingCoverage: 'complete', transactionCoverage: 'complete', transactions: txs },
  });
  const strip = value => JSON.stringify(value, (k, v) => (k === 'displayedNote' ? undefined : v));
  const base = run(mk(null));
  for (const note of ['Disney+', 'amanda', 'dale', 'groceries', 'Dale and Amanda']) {
    ok(strip(run(mk(note))) === strip(base),
      `Forecast output is byte-identical with displayedNote '${note}' once the display field is removed`);
  }
  const period = (base.defaultView.calendarPeriods || []).find(p => p.id === 'this-pay-period');
  const groceryRow = ((period && period.householdBudget) || []).find(r => r.id === 'groceries');
  ok(groceryRow && groceryRow.spent > 0, 'fixture publishes a Groceries Spent figure');
  const withNote = run(mk('Disney+'));
  const p2 = (withNote.defaultView.calendarPeriods || []).find(q => q.id === 'this-pay-period');
  const r2 = ((p2 && p2.householdBudget) || []).find(r => r.id === 'groceries');
  ok(r2 && r2.recon && r2.recon[0] && r2.recon[0].displayedNote === 'Disney+', 'recon row carries displayedNote through reconTxFrom');
  ok(groceryRow && groceryRow.recon[0] && !('displayedNote' in groceryRow.recon[0]),
    'recon row without a note has no displayedNote key');
  const cls = n => F.classifyCurrentPeriodTransaction(mk(n)[0], plan);
  ok(JSON.stringify(cls(null)) === JSON.stringify(cls('amanda')) && JSON.stringify(cls(null)) === JSON.stringify(cls('Disney+')),
    'classification is unchanged by displayedNote, including an owner-tag value');
  const fsrc = read('public/forecast.js');
  const uses = fsrc.split('\n').filter(l => /displayedNote/.test(l));
  const reconFn = grab(fsrc, /function reconTxFrom\([\s\S]*?\n  \}\n/, 'reconTxFrom');
  ok(uses.length > 0 && uses.length === reconFn.split('\n').filter(l => /displayedNote/.test(l)).length,
    'displayedNote is referenced only inside reconTxFrom in forecast.js');
}

console.log('\n=== 6. rendering under the payee, escaped ===');
{
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^function paydayBucketRow\([\s\S]*?\n\}$/m, 'paydayBucketRow'),
    grab(planSrc, /^function householdBudgetCycleText\([\s\S]*?\n\}$/m, 'householdBudgetCycleText'),
    grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
    grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml'),
    grab(planSrc, /^function calendarCurrentUnavailableHtml\([\s\S]*?\n\}$/m, 'calendarCurrentUnavailableHtml'),
    grab(planSrc, /^function calendarBudgetHtml\([\s\S]*?\n\}$/m, 'calendarBudgetHtml'),
  ].join('\n');
  const composer = vm.runInNewContext(`${source}\n({ calendarBudgetHtml });`, { Forecast: F });
  const plan = { defaults: { targetBuffer: 500 }, budget: { categories: [
    { id: 'groceries', label: 'Groceries', class: 'essential', plannedWeekly: 450, ownerLine: 'Groceries' } ] } };
  const period = recon => ({
    id: 'this-pay-period', role: 'active', start: '2026-08-28', end: '2026-09-10',
    spendingCycle: { start: '2026-08-28', end: '2026-09-10', rangeLabel: '28 Aug – 10 Sep' },
    householdBudget: [{ id: 'groceries', label: 'Groceries', planned: 900, spent: recon.reduce((s, t) => s + t.amount, 0),
      remaining: 500, recon }],
    budgetHold: 900,
  });
  const tx = (id, extra) => Object.assign({ id, date: '2026-08-29', amount: 20, pending: false,
    categoryLabel: 'Groceries', displayedPayee: 'Disney', originalMerchant: 'Disney' }, extra);
  const html = composer.calendarBudgetHtml(period([
    tx('tx-note', { displayedNote: 'Disney+' }),
    tx('tx-plain', {}),
    tx('tx-xss', { displayedNote: '<img src=x onerror=alert(1)> & "q"' }),
    tx('tx-nonstring', { displayedNote: { a: 1 } }),
  ]), null, plan);
  const li = id => { const at = html.indexOf(`data-tx-id="${id}"`); const end = html.indexOf('</li>', at); return html.slice(at, end); };
  ok(/<span class="household-budget-tx-note" data-tx-note>Disney\+<\/span>/.test(li('tx-note')),
    'a note renders in a marked span');
  ok(li('tx-note').indexOf('household-budget-tx-payee') < li('tx-note').indexOf('household-budget-tx-note')
      && li('tx-note').indexOf('household-budget-tx-note') < li('tx-note').indexOf('household-budget-tx-amount'),
    'the note sits under the payee, before the amount');
  ok(!/data-tx-note/.test(li('tx-plain')), 'a row without a note renders no note element');
  ok(!/<img/.test(li('tx-xss')) && /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;q&quot;/.test(li('tx-xss')),
    'HTML in a note is escaped');
  ok(!/data-tx-note/.test(li('tx-nonstring')) && !/\[object/.test(li('tx-nonstring')),
    'a non-string note renders nothing');
  // overlay path (Forecast withheld Spent) lists the same packet rows
  const overlayPeriod = period([]);
  overlayPeriod.householdBudget[0].spent = null;
  overlayPeriod.householdBudget[0].recon = [];
  const overlayHtml = composer.calendarBudgetHtml(overlayPeriod,
    { applied: true, currentPeriodActuals: { transactions: [tx('tx-ov', { displayedNote: 'Disney+' })] } }, plan);
  ok(/data-tx-note>Disney\+<\/span>/.test(overlayHtml), 'overlay Spent drill-down renders the note too');
  const css = read('public/styles.css');
  ok(/\.household-budget-tx-note\s*\{/.test(css), 'styles.css has a rule for the note');
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nAll displayed item note checks passed.');
