'use strict';
/* Grok Bot's "bill verified" note confirms a differing posted bill payment (owner, Dale, 2026-11-20, #821 7046237901:
 * "it's up grok bot... To confirm or not confirm"; Grok Bot, Plan #6 thread, ts 1795188508.458429: "Use a note on the
 * payment transaction itself, in this exact form: bill verified").
 *
 *   - The marker: exactly "bill verified" at the start of any line of the posted payment's note, then the end of the
 *     line or a comment starting " - " or " (". Case-sensitive. Read by the observer, which emits only a boolean on posted
 *     rows (billVerifiedNote), never the note text.
 *   - A verified posted payment is the occurrence's amount (lead ruling (A)): billAssignedAmount counts it, above or below
 *     the plan, so the check always stands beside what was paid. Balance After Deductions moves by exactly the difference.
 *   - The payment evidence is 'posted-verified' and paidConfirmed is true: the Stack Bills card and the bill sheet show the
 *     check. Posted-equal still confirms; pending never does; an unverified differing payment stays at the plan, unchecked.
 *   - The note is append-only (Grok Bot, Plan #6 thread, after ts 1795212883.667279), so "bill not verified", with the
 *     same line grammar, withdraws it: the LAST marker line in the note decides.
 *   - Only the occurrence's own fully posted link counts: a note on a pending row, on a row linked to another occurrence,
 *     or an occurrence with a pending linked row, verifies nothing.
 *
 * Proof, independent of the code under test: hand-derived expectations on invented Lunch Money rows driven through the
 * observer, Forecast and the rendered Stack Bills card and the bill history (paidConfirmed, which the bill sheet reads); then mutants. Invented names and amounts only.
 * `node test/test-bill-verified-note.js`
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const vm = require('vm');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const H = require('./acceptance/harness.js');

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ' — ' + detail : ''}`);
};
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
const SOURCE = read('public/forecast.js');
function compile(text, name, file = FILE) {
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(text, file.replace(/\.js$/, '-' + name + '.js'));
  return mod.exports;
}
const OBSERVE_FILE = path.join(__dirname, '..', 'scripts', 'provider-observe.js');
const OBSERVE_SOURCE = read('scripts/provider-observe.js');
const swap = (text, from, to, label) => {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error('anchor not found exactly once: ' + label);
  return parts.join(to);
};

// The cards, loaded as test-stack-bill-parts loads them.
const cards = (() => {
  const sandbox = { window: {}, location: { search: '' }, URLSearchParams, Intl, Map, Number, String, Object, Array, JSON, Math, console };
  vm.runInNewContext(read('public/stack-shell.js'), sandbox);
  const shell = sandbox.window.StackBlocks;
  globalThis.StackBlocks = { register: () => {}, isEstimated: shell.isEstimated, estClass: shell.estClass, budgetTrust: shell.budgetTrust, barWidth: shell.barWidth, money: shell.money };
  return require('../public/stack-cards.js');
})();
// An invented 90 monthly hydro bill due on the 12th; as of 2026-10-14. September paid 90 (posted). October's payment varies.
const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' };
const pay = (date, amount, extra = {}) => H.lm({ date, amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro', ...extra });
function observe(october, { september = pay('2026-09-12', 90), packet = p => p } = {}) {
  const w = H.baseWorld();
  w.bills = [HYDRO];
  w.transactions = [september, ...october];
  const o = H.observe(w);
  if (o.error) throw o.error;
  return { w, plan: o.plan, packet: packet(JSON.parse(JSON.stringify(o.packet))) };
}
function run(october, opts = {}, Fx = F) {
  const { w, plan, packet } = observe(october, opts);
  return Fx.recommend(plan, w.asOf, { currentPeriodActuals: packet });
}
// The October occurrence as published and as rendered.
function october(rec) {
  const view = rec.payPeriodViews.find(v => (v.bills || []).some(b => b.id === 'hydro' && b.date === '2026-10-12'));
  const row = view.bills.find(b => b.id === 'hydro' && b.date === '2026-10-12');
  const html = cards.buildCardsHTML({ data: {}, plan: {}, recommendation: { payPeriodViews: [view] }, selectedPeriodKey: view.start, Forecast: {} });
  const bills = html.split('data-stack-card="bills"')[1] || '';
  const li = bills.split('<li class="sc-row sc-bill').slice(1).map(x => x.split('</li>')[0]).find(x => x.includes('Invented hydro')) || '';
  const entry = (rec.billHistory.hydro || []).find(e => e.date === '2026-10-12');
  return { view, row, evidence: row.stackBillPaymentEvidence, counted: row.stackBillAmount, cardCheck: li.includes('sc-check'),
    cardName: (li.match(/class="sc-a[^"]*" aria-label="([^"]*)"/) || [])[1] || null,
    paidConfirmed: entry && entry.paidConfirmed, bad: view.balanceAfterDeductions, other: view.stackSummary.bills.other };
}
const sumOther = view => (view.bills || []).filter(r => r.stackBillPart === 'other').reduce((s, r) => s + Math.round(r.stackBillAmount * 100), 0);

console.log('1. The marker (observer)');
{
  const m = O.billVerifiedMarker;
  const yes = ['bill verified', 'bill verified - short by the fee', 'bill verified (Grok)', 'ref 1\nsecond line\nbill verified', 'a\r\nbill verified'];
  const no = ['Bill verified', 'BILL VERIFIED', 'bill verified?', 'not bill verified', ' bill verified', 'bill verifiedx', 'bill verified.', 'bill verified-',
    'bill  verified', '', null, undefined, 42];
  ok(yes.every(m), 'the marker on line 1, line 3, with " - " or " (" comment, after a CRLF', JSON.stringify(yes.filter(s => !m(s))));
  ok(no.every(s => !m(s)), 'near misses do not count: case, "?", "not", a leading space, a suffix, a full stop, a non-string', JSON.stringify(no.filter(m)));
  // Append-only withdrawal: the last marker line decides.
  const last = [['bill verified\nbill not verified', false], ['bill not verified\nbill verified', true], ['bill not verified', false],
    ['bill verified\nbill not verified - amount to be corrected\nbill verified (re-checked)', true], ['bill verified\nbill not verified (was 40)', false],
    ['bill verified\nref 9', true], ['bill verified\nbill not verified?', true], ['bill verified\nBill not verified', true],
    ['bill verified\nnot bill not verified', true], ['bill verified\n bill not verified', true], ['bill verified\nbill not verifiedx', true],
    ['bill verified\nbill  not verified', true]];
  ok(last.every(([n, want]) => m(n) === want), 'the last marker line decides; "bill not verified" near misses (?, case, prefix, leading space, suffix, double space) do not withdraw',
    JSON.stringify(last.filter(([n, want]) => m(n) !== want)));
}

console.log('2. Hand-derived worlds through the Stack Bills card and the bill sheet (plan 90, October)');
const NOTE = 'bill verified';
{
  // Posted 90, no note: posted-equal, counted 90, checked.
  const a = october(run([pay('2026-10-12', 90)]));
  ok(a.evidence === 'posted-equal' && a.counted === 90 && a.cardCheck && a.paidConfirmed === true,
    'posted equal to the plan: confirmed, counted 90, check on the card, paid on the bill sheet', JSON.stringify([a.evidence, a.counted, a.cardCheck, a.paidConfirmed]));
  // Posted 40, no note: posted-differs, counted at the plan 90, no check.
  const b = october(run([pay('2026-10-12', 40)]));
  ok(b.evidence === 'posted-differs' && b.counted === 90 && !b.cardCheck && b.paidConfirmed === false,
    'posted 40, no note: not confirmed, counted at the plan 90, no check', JSON.stringify([b.evidence, b.counted, b.cardCheck, b.paidConfirmed]));
  // Posted 40 with the note: verified, counted 40, checked; Balance After Deductions up by exactly 90 - 40 = 50.
  const c = october(run([pay('2026-10-12', 40, { notes: NOTE })]));
  ok(c.evidence === 'posted-verified' && c.counted === 40 && c.cardCheck && c.paidConfirmed === true,
    'posted 40 with "bill verified": confirmed, counted 40 (what was paid), check on the card, paid on the bill sheet',
    JSON.stringify([c.evidence, c.counted, c.cardCheck, c.paidConfirmed]));
  ok(Math.round((c.bad - b.bad) * 100) === 5000, 'Balance After Deductions moves by exactly the plan minus the posted payment, 50.00',
    JSON.stringify([b.bad, c.bad]));
  ok(sumOther(c.view) === Math.round(c.other * 100) && Math.round((b.other - c.other) * 100) === 5000,
    'the Bills rows still add up to the head, which is 50.00 lower', JSON.stringify([b.other, c.other]));
  ok(/Paid \$40/.test(c.cardName || ''), 'the card names what was paid, "Paid $40"', c.cardName);
  // The note on line 3, and with a comment.
  for (const [label, notes] of [['on line 3', 'ref 7\nchecked statement\nbill verified'], ['with a " - " comment', 'bill verified - short by the waived fee'],
    ['with a " (" comment', 'bill verified (Grok)']]) {
    const d = october(run([pay('2026-10-12', 40, { notes })]));
    ok(d.evidence === 'posted-verified' && d.counted === 40 && d.cardCheck, `the marker ${label}: confirmed at 40`, JSON.stringify([d.evidence, d.counted]));
  }
  // Withdrawn and re-verified, appended as Grok Bot appends: the last marker decides.
  const w = october(run([pay('2026-10-12', 40, { notes: 'bill verified\nbill not verified - amount under correction' })]));
  ok(w.evidence === 'posted-differs' && w.counted === 90 && !w.cardCheck && w.paidConfirmed === false,
    'verified then "bill not verified": no check, counted at the plan 90', JSON.stringify([w.evidence, w.counted]));
  const rv = october(run([pay('2026-10-12', 40, { notes: 'bill not verified\nbill verified' })]));
  ok(rv.evidence === 'posted-verified' && rv.counted === 40 && rv.cardCheck, 'not verified then "bill verified": confirmed at 40', JSON.stringify([rv.evidence, rv.counted]));
  const it = october(run([pay('2026-10-12', 40, { notes: 'item: invented widget\nbill verified' })]));
  ok(it.evidence === 'posted-verified' && it.counted === 40 && it.cardCheck, 'a marker appended after an "item:" line still reads', JSON.stringify([it.evidence, it.counted]));
  // Near misses: as if no note.
  for (const notes of ['bill verified?', 'Bill verified', 'not bill verified']) {
    const e = october(run([pay('2026-10-12', 40, { notes })]));
    ok(e.evidence === 'posted-differs' && e.counted === 90 && !e.cardCheck, `near miss ${JSON.stringify(notes)}: not confirmed, counted at the plan`);
  }
  // Overpaid and verified: counted at the posted 120, as an overpayment already was, now checked.
  const f = october(run([pay('2026-10-12', 120, { notes: NOTE })]));
  const g = october(run([pay('2026-10-12', 120)]));
  ok(f.evidence === 'posted-verified' && f.counted === 120 && f.cardCheck && g.evidence === 'posted-differs' && g.counted === 120 && !g.cardCheck
    && Math.round(f.bad * 100) === Math.round(g.bad * 100),
  'overpaid 120: counted 120 either way; the note adds only the check, and Balance After Deductions does not move', JSON.stringify([f.evidence, g.evidence, f.bad, g.bad]));
}

console.log('3. What verifies nothing');
{
  // The note on a pending payment: pending, plan, no check.
  const p = october(run([pay('2026-10-12', 40, { pending: true, notes: NOTE })]));
  ok(p.evidence === 'pending' && p.counted === 90 && !p.cardCheck && p.paidConfirmed === false,
    'the note on a pending payment: not confirmed, counted at the plan', JSON.stringify([p.evidence, p.counted]));
  // The note on September's payment (another occurrence): October stays unverified.
  const q = october(run([pay('2026-10-12', 40)], { september: pay('2026-09-12', 90, { notes: NOTE }) }));
  ok(q.evidence === 'posted-differs' && q.counted === 90 && !q.cardCheck, 'the note on another occurrence\'s payment: October not confirmed, at the plan');
  // October's occurrence linked to its posted, noted row AND a pending row: not fully posted, so nothing verifies.
  const withPending = packet => {
    const claim = packet.representedActuals.find(item => item.id === 'hydro' && item.date === '2026-10-12');
    const posted = packet.transactions.find(tx => tx.id === (claim.transactionId || claim.transactionIds[0]));
    packet.transactions.push({ ...posted, id: posted.id + '-pending', pending: true });
    claim.transactionIds = [...new Set([...(claim.transactionIds || []), claim.transactionId, posted.id + '-pending'].filter(Boolean))];
    return packet;
  };
  const r = october(run([pay('2026-10-12', 40, { notes: NOTE })], { packet: withPending }));
  ok(r.evidence !== 'posted-verified' && r.counted === 90 && !r.cardCheck && r.paidConfirmed === false,
    'one posted noted row plus one pending linked row: not confirmed, counted at the plan', JSON.stringify([r.evidence, r.counted]));
  // The packet never carries the note text.
  const { packet } = observe([pay('2026-10-12', 40, { notes: 'bill verified - private comment xyz' })]);
  ok(!JSON.stringify(packet).includes('private comment xyz') && packet.transactions.some(tx => tx.billVerifiedNote === true),
    'the packet carries the boolean, never the note text');
}

console.log('4. Mutants are caught');
{
  const noCount = compile(swap(SOURCE, '    if (actual != null && billPaymentVerified(row, asOf, opts)) return actual;\n', '', 'count'), 'no-count');
  const m1 = october(run([pay('2026-10-12', 40, { notes: NOTE })], {}, noCount));
  ok(!(m1.evidence === 'posted-verified' && m1.counted === 40 && m1.cardCheck), 'counting the plan for a verified payment is caught (no check beside the plan)');
  const noConfirm = compile(swap(SOURCE, ' || row.billPaymentVerified === true);', ');', 'paidConfirmed'), 'no-confirm');
  ok(october(run([pay('2026-10-12', 40, { notes: NOTE })], {}, noConfirm)).paidConfirmed === false, 'dropping the verified clause from paidConfirmed is caught');
  const anyRow = compile(swap(SOURCE, '      if (found.some(row => row.billVerifiedNote === true)) verified = true;',
    "      if (packet.transactions.some(row => row.billVerifiedNote === true)) verified = true;", 'any row'), 'any-row');
  ok(october(run([pay('2026-10-12', 40)], { september: pay('2026-09-12', 90, { notes: NOTE }) }, anyRow)).evidence === 'posted-verified',
    'reading the marker from any packet row (not the occurrence\'s own link) is caught');
  const observeMutant = (from, to, label) => compile(swap(OBSERVE_SOURCE, from, to, label), label, OBSERVE_FILE).billVerifiedMarker;
  const DECIDE = '    if (m) verified = m[1] === undefined;';
  const first = observeMutant(DECIDE, '    if (m) { verified = m[1] === undefined; break; }', 'first-wins');
  ok(first('bill verified\nbill not verified') === true && O.billVerifiedMarker('bill verified\nbill not verified') === false, 'the first marker line winning is caught');
  const anyPos = observeMutant(DECIDE, '    if (m && m[1] === undefined) verified = true;', 'any-positive');
  ok(anyPos('bill verified\nbill not verified') === true && O.billVerifiedMarker('bill verified\nbill not verified') === false, 'any positive line winning is caught');
  const caseless = observeMutant('const BILL_VERIFIED_LINE = /^bill (not )?verified(?:$| - | \\()/;', 'const BILL_VERIFIED_LINE = /^bill (not )?verified(?:$| - | \\()/i;', 'caseless');
  ok(caseless('Bill verified') === true && O.billVerifiedMarker('Bill verified') === false, 'a case-insensitive marker (production regex with /i) is caught');
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} bill verified note checks passed`);
process.exit(failures ? 1 : 0);
