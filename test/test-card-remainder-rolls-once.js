'use strict';
/* An unpaid card remainder rolls over to the next pay period, once (Dale, lead 13 item B; LEAD 14 #1620 7182740397 part
 * 3, mechanics 7194071146). The card ledger is the one authority: when the current pay period opens, a minimum of the
 * period just closed that its own payments met only in part (a known remainder) becomes one carried line in the current
 * period, "carried from" its original date, paid first by this period's payments. The walk and the Bills rows read
 * that same line.
 *   1. Partly paid (20 of 25): 5.00 is carried; the Bills row says "carried from", 5.00 still due, estimated; the cash
 *      walk deducts it once.
 *   2. Paid this period: a 5.00 payment clears it (no row); a 2.00 payment leaves 3.00. Either way cash counts the
 *      carry once.
 *   3. No carry: paid in full, or not paid at all (the remainder is not known).
 *   4. Once: two pay periods later nothing is carried.
 *   5. No carry onto a recorded statement this period (it already includes the past-due amount).
 *   6. Mutants: the carry removed; the carry ignoring this period's payments (a double count).
 * Invented world (test/fixtures/card-coverage-aggregate-world.js): pay periods 09-18..10-01, 10-02..10-15,
 * 10-16..10-29; Bills 500; one 25 card minimum due 2026-09-25. Every expectation is written by hand.
 * `node test/test-card-remainder-rolls-once.js` */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const F = require('../public/forecast');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => { checks++; if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ' — ' + detail : ''}`); };
const J = JSON.stringify;
const cents = x => Math.round(Number(x) * 100);
const pay = (amount, date) => [['bills', amount, date, 'cash'], ['card', -amount, date, 'credit']];
const OPTS = { asOf: '2026-10-05', minimumDate: '2026-09-25' };
const carriedLines = s => (s.coverage.minimumCoverage || []).filter(r => r.carriedFrom);
const carriedRows = s => (s.period.bills || []).filter(b => b.carriedRemainder);
// The cash walk's card-minimum outflow (the weekly allowance is solved around it, so the ending balance is not the test).
const walked = s => cents(s.advice.sim.totals.obligations);

function withEngine(engine, fn) {
  const real = { ...F };
  Object.assign(F, engine);
  try { return fn(); } finally { Object.assign(F, real); }
}

console.log('1. Partly paid (20 of 25): 5.00 rolls into the current pay period');
const partial = run(world(pay(20, '2026-09-26'), OPTS));
{
  const lines = carriedLines(partial);
  ok(lines.length === 1 && cents(lines[0].due) === 500 && cents(lines[0].covered) === 0 && lines[0].carriedFrom === '2026-09-25'
    && lines[0].carriedInto === '2026-10-02', 'the card ledger carries one 5.00 line from 2026-09-25 into the 10-02 period', J(lines));
  const original = (partial.coverage.minimumCoverage || []).filter(r => !r.carriedFrom);
  ok(original.length === 1 && cents(original[0].covered) === 2000 && original[0].status === 'partial',
    'the closed period keeps its own record (20 of 25, partial): history is unchanged', J(original));
  const rows = carriedRows(partial);
  ok(rows.length === 1 && cents(rows[0].remaining) === 500 && rows[0].status === 'still due' && /carried from 2026-09-25/.test(rows[0].label)
    && rows[0].confidence === 'estimated', 'the Bills row: "carried from 2026-09-25", 5.00 still due, estimated',
    J(rows.map(r => [r.label, r.remaining, r.status, r.confidence])));
  ok(walked(partial) === 500, 'the cash walk takes the 5.00 out once (it was dropped at payday before)', J(walked(partial)));
}

console.log('2. Paid this period: the carry is paid first, and cash counts it once');
{
  const cleared = run(world([...pay(20, '2026-09-26'), ...pay(5, '2026-10-03')], OPTS));
  const line = carriedLines(cleared)[0];
  ok(line && line.status === 'covered-by-payment' && carriedRows(cleared).length === 0,
    'a 5.00 payment on 10-03 covers the carried line; no carried row remains', J(line));
  const part = run(world([...pay(20, '2026-09-26'), ...pay(2, '2026-10-03')], OPTS));
  const rows = carriedRows(part);
  ok(rows.length === 1 && cents(rows[0].remaining) === 300, 'a 2.00 payment leaves 3.00 still due', J(rows.map(r => r.remaining)));
  // What was paid this period plus what the walk still takes out is the 5.00 carry, once: 5 + 0, 2 + 3, 0 + 5.
  ok(walked(cleared) === 0 && walked(part) === 300,
    'the walk takes out 0.00 after the 5.00 payment and 3.00 after the 2.00 one: the carry leaves cash exactly once',
    J([walked(cleared), walked(part)]));
}

console.log('3. No carry when there is no known remainder');
{
  const paid = run(world(pay(25, '2026-09-26'), OPTS));
  ok(carriedLines(paid).length === 0 && carriedRows(paid).length === 0, 'paid in full: nothing rolls');
  const none = run(world([], OPTS));
  ok(carriedLines(none).length === 0 && carriedRows(none).length === 0, 'not paid at all (remainder unknown): nothing rolls');
}

console.log('4. Once: two pay periods later nothing is carried');
{
  const later = run(world(pay(20, '2026-09-26'), { ...OPTS, asOf: '2026-10-20' }));
  ok(carriedLines(later).length === 0 && carriedRows(later).length === 0, 'as of 10-20 the 09-25 remainder does not roll again',
    J(carriedLines(later)));
}

console.log('5. No carry onto a recorded statement this period');
{
  const statement = run(world(pay(20, '2026-09-26'), { ...OPTS, edit: x => {
    const base = x.data.plan.obligations[0];
    x.data.plan.obligations.push({ ...base, id: 'travel-oct', date: '2026-10-10',
      statementOccurrences: [{ scheduledDate: '2026-10-10', dueDate: '2026-10-10', minimum: 30, currency: 'cad', confidence: 'confirmed' }] });
  } }));
  ok(carriedLines(statement).length === 0 && carriedRows(statement).length === 0,
    'the card\'s 10-10 statement (it already includes the past-due amount) takes no carry', J(carriedLines(statement)));
}

console.log('5b. The coupled debt and cash walks (Codex on #1663)');
{
  // The same obligation also due on the as-of (biweekly from 09-25: 09-25, then 10-09): its own 25 and the 5.00 carry
  // are two occurrences, so the debt walk keys them apart and the cash walk takes out 25 + 5 = 30.00.
  const biweekly = x => { const o = x.data.plan.obligations[0]; delete o.date; o.frequency = 'biweekly'; o.anchor = '2026-09-25'; };
  const sameDay = run(world(pay(20, '2026-09-26'), { ...OPTS, asOf: '2026-10-09', edit: biweekly }));
  const fullyPaid = run(world(pay(25, '2026-09-26'), { ...OPTS, asOf: '2026-10-09', edit: biweekly }));
  // The walk's own minimums (10-09 and 10-23, 25.00 each) are the same in both worlds; the carry adds exactly 5.00.
  ok(carriedRows(sameDay).length === 1 && walked(fullyPaid) === 5000 && walked(sameDay) === 5500,
    'a minimum due the same day keeps its own 25.00 beside the 5.00 carry: 50.00 + 5.00 against 50.00 fully paid',
    J([carriedRows(sameDay).length, walked(sameDay), walked(fullyPaid)]));
  // The card is observed nearly paid off (3.00 owing): a payment cannot exceed the debt it pays, so cash takes out
  // 3.00 of the carry, the same cap every other obligation gets from the debt walk.
  const owing3 = run(world(pay(20, '2026-09-26'), { ...OPTS, edit: x => { x.payload.accounts[3].balance = 3; } }));
  ok(walked(owing3) === 300, 'with 3.00 owing on the card, cash takes out 3.00 of the carry, not 5.00', J(walked(owing3)));
  const paidOff = run(world(pay(20, '2026-09-26'), { ...OPTS, edit: x => { x.payload.accounts[3].balance = 0; } }));
  ok(walked(paidOff) === 0, 'with the card paid off, the carry takes nothing out of cash', J(walked(paidOff)));
}

console.log('6. Mutants');
{
  const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
  const source = fs.readFileSync(FILE, 'utf8');
  const compile = (from, to, tag) => {
    if (source.split(from).length !== 2) throw new Error('mutant anchor not found exactly once: ' + tag);
    const mod = new Module(FILE, module);
    mod.filename = FILE;
    mod.paths = Module._nodeModulePaths(path.dirname(FILE));
    mod._compile(source.replace(from, to), FILE.replace(/\.js$/, '-' + tag + '.js'));
    return mod.exports;
  };
  const noCarry = compile("if (start === currentPeriodStart && previousPeriodStart && !(period.minimums || []).some(m => m.statement)) {",
    'if (false) {', 'no-carry');
  const m1 = withEngine(noCarry, () => run(world(pay(20, '2026-09-26'), OPTS)));
  ok(carriedRows(m1).length === 0 && walked(m1) === 0,
    'MUTANT (no carry): the 5.00 drops out of the walk and the Bills rows, which section 1 rejects', J([carriedRows(m1).length, walked(m1)]));
  const ignorePaid = compile('let left = (due - covered) / 100;', 'let left = due / 100;', 'ignore-paid');
  const m2 = withEngine(ignorePaid, () => run(world([...pay(20, '2026-09-26'), ...pay(2, '2026-10-03')], OPTS)));
  ok(walked(m2) === 500, 'MUTANT (carry ignores this period\'s payments): the walk still takes 5.00 after 2.00 was paid (7.00 counted), which section 2 rejects',
    J(walked(m2)));
}

{
  const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
  const source = fs.readFileSync(FILE, 'utf8');
  const compile = (from, to, tag) => {
    if (source.split(from).length !== 2) throw new Error('mutant anchor not found exactly once: ' + tag);
    const mod = new Module(FILE, module);
    mod.filename = FILE;
    mod.paths = Module._nodeModulePaths(path.dirname(FILE));
    mod._compile(source.replace(from, to), FILE.replace(/\.js$/, '-' + tag + '.js'));
    return mod.exports;
  };
  const biweekly = x => { const o = x.data.plan.obligations[0]; delete o.date; o.frequency = 'biweekly'; o.anchor = '2026-09-25'; };
  const sharedId = compile("const id = row.obligationId + '#carried@' + row.carriedFrom;", 'const id = row.obligationId;', 'shared-id');
  const m3 = withEngine(sharedId, () => run(world(pay(20, '2026-09-26'), { ...OPTS, asOf: '2026-10-09', edit: biweekly })));
  ok(walked(m3) !== 5500, 'MUTANT (carry shares the obligation\'s identity): the same-day walk no longer counts 25.00 + 5.00, which section 5b rejects',
    J(walked(m3)));
  const noCap = compile('      if (cap) {\n        const key = date + \':\' + id;', '      if (false) {\n        const key = date + \':\' + id;', 'no-cap');
  const m4 = withEngine(noCap, () => run(world(pay(20, '2026-09-26'), { ...OPTS, edit: x => { x.payload.accounts[3].balance = 3; } })));
  ok(walked(m4) === 500, 'MUTANT (no debt cap on the carry): cash takes out 5.00 with only 3.00 owing, which section 5b rejects', J(walked(m4)));
}

console.log(`\n${failures ? 'FAIL' : 'PASS'} card remainder rolls once (${checks - failures}/${checks})`);
if (failures) process.exit(1);
