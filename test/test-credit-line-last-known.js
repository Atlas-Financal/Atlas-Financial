'use strict';
/* BUILD 7 amendment (#1611 7176284777): the waterfall Credit line's total still to pay back is withheld only subject to
 * "last known stands" (OD-045, #821 7175039667). It reuses #1669's dated card publication: when a refresh has less
 * evidence than the household's last coherent reading for the same period, Forecast shows that retained line, and the
 * Credit line's left figure and the head sum the lines actually shown. The cash deduction, Surplus and decision evidence
 * stay on the current observation.
 *
 * Invented world (test/fixtures/card-coverage-aggregate-world): Travel has $80 + $37 of charges, and $25 left the Bills
 * account for it with a card-payment note. By hand: target 117, paid back 25, still to pay back 92.
 *
 *   1. Warm, then a newer same-household, same-period refresh whose card feed is thin (charges withheld): the retained
 *      Travel line shows; the Credit line is 92, estimated, the sum of the rows shown; the head is $25 / $117; deduction,
 *      Surplus and the payday decision equal the thin observation read cold.
 *   2. Cold (never known): the row and the Credit line are withheld (a dash), never $0.
 *   3. Genuinely newer evidence (a $12 charge): the current reading wins (104), nothing retained.
 *   4. Contradictory evidence (a reversal): withheld even with a warm reading.
 *   5. Characterization, pending the lead's choice: the paying account's sync fails while charges stay known. Paid back is
 *      withheld by the paying-side rule and #1669 retains only lines whose charges are withheld, so the Credit line is a
 *      dash. (Reported on #1671; not changed here.)
 *   6. A completed period never takes a retained line (the gate in publishStackSummary): its row keeps Forecast's
 *      published remainder (5 of the 25 minimum), with a mutant that removes the gate.
 *   7. Mutant: the breakdown reading the observation's own lines instead of the lines shown leaves case 1's Credit line
 *      withheld, so the left figure would disagree with the rows.
 *
 * Invented data only. The household history file is replaced with an empty one before any module reads it.
 * `node test/test-credit-line-last-known.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const periodsPath = path.resolve(__dirname, '../public/periods.json');
const readFile = fs.readFileSync;
fs.readFileSync = (file, ...args) => (file === periodsPath ? JSON.stringify({ monthly: [] }) : readFile(file, ...args));

const Forecast = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Memory = require('../scripts/server-observation-memory');
const { world } = require('./fixtures/card-coverage-aggregate-world');
const { loadStackPage } = require('./lib/budget-page-harness');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const cents = v => Math.round(v * 100);
const ROOT = path.join(__dirname, '..');
const context = { accountMap: 'invented map', categoryMapping: [] };
const household = 4021;
const day = '2026-09-20';

function observation(hour, { cardSync = true, extra = false, reversal = false, payerSyncFailed = false } = {}) {
  const input = world([['card', 80, '2026-09-18', 'purchase', { id: 88101 }], ['card', 37, '2026-09-19', 'purchase', { id: 88102 }],
    ['bills', 25, day, 'cash', { id: 88103, notes: 'card payment: Travel Visa' }],
    ...(reversal ? [['bills', -25, day, 'cash', { id: 88106, notes: 'card payment: Travel Visa' }]] : []),
    ...(extra ? [['card', 12, day, 'purchase', { id: 88105 }]] : [])], { asOf: day, windowStart: '2026-09-18' });
  const { payload } = input;
  Object.assign(payload, { categories: [], tags: [], fetchedAt: `${day}T${hour}:00:00Z` });
  payload.pendingCoverage.truncated = false;
  for (const account of payload.accounts) account.last_fetch = payload.fetchedAt;
  if (!cardSync) delete payload.accounts.find(account => account.id === 3004).last_fetch;
  const { data } = Live.fromObservation(input);
  if (payerSyncFailed) {
    for (const row of data.liveOverlay.currentPeriodActuals.syncEvidence) if (row.role === 'household-cash') row.syncEvidence = 'failed';
  }
  return { data, evidence: { schema: Memory.SCHEMA, payload }, checkedAt: payload.fetchedAt };
}
const publish = (memory, o) => memory.publish('latest-source', o.evidence, { context, householdAccountId: household,
  lastBudgetAccountId: household, credentialSource: 'env', data: o.data, checkedAt: o.checkedAt }, undefined, Forecast.cardActivityForDisplay(o.data));
const served = (memory, o) => memory.withLastKnownCardActivity(context, household, o.checkedAt, o.data);
function read(data, F = Forecast) {
  const result = F.recommend(data.plan, F.budgetAsOf(data), F.budgetRecommendInputs(data));
  const view = result.payPeriodViews.find(row => row.timelineRole === 'current' || row.role === 'active');
  const s = view.stackSummary;
  return { result, view, s, line: s.credit.lines.find(l => l.id === 'travelvisa') };
}
// Warm memory, then the given newer refresh, served as the page reads it.
function warmThen(options) {
  const memory = Memory.create();
  publish(memory, observation('18'));
  const thin = observation('19', options);
  publish(memory, thin);
  return { thin, data: served(memory, thin) };
}
// Every displayed deduction member, checked against the rows: each line with a target above $0 (or withheld) is a row at
// its shown Still to pay back; the left figure is the rows' sum, withheld when any is; the head sums the shown lines.
function membersAgree(r, label) {
  const b = r.s.creditBreakdown;
  const open = r.s.credit.lines.filter(l => l.target.amount === null || cents(l.target.amount) > 0);
  for (const l of open) {
    const row = b.rows.find(x => x.debtId === l.id);
    ok(row && row.amount === l.stillToPayBack.amount && row.trust === l.stillToPayBack.trust, `${label}: ${l.id}'s row is its shown Still to pay back`);
  }
  const held = b.rows.some(x => x.amount === null);
  ok(held ? b.stillToPayBack.amount === null : cents(b.stillToPayBack.amount) === b.rows.reduce((s, x) => s + cents(x.amount), 0),
    `${label}: the Credit line's left figure is the sum of the rows shown`, JSON.stringify([b.stillToPayBack, b.rows]));
  const sum = (ls, key) => (ls.some(l => l[key].amount === null) ? null : ls.reduce((s, l) => s + cents(l[key].amount), 0) / 100);
  ok(r.s.credit.totals.target.amount === sum(r.s.credit.lines, 'target')
    && (r.s.credit.totals.paidBack.amount === null || r.s.credit.totals.paidBack.amount === sum(open, 'paidBack')),
    `${label}: the head sums the lines shown`);
}

(async () => {
  console.log('0. The warm reading, by hand');
  const warm = read(observation('18').data);
  ok(warm.line.spent.amount === 117 && warm.line.paidBack.amount === 25 && warm.line.stillToPayBack.amount === 92,
    'Travel: charges 117, paid back 25, still 92', JSON.stringify([warm.line.spent, warm.line.paidBack, warm.line.stillToPayBack]));
  ok(warm.s.creditBreakdown.stillToPayBack.amount === 92, 'the Credit line\'s left figure is 92');

  console.log('1. Warm, then a thin card feed: the retained line, and the Credit line agrees with it');
  const thinCase = warmThen({ cardSync: false });
  const held = read(thinCase.data), cold = read(thinCase.thin.data);
  ok(held.line.activityObservedAt === `${day}T18:00:00Z` && held.line.spent.amount === 117 && held.line.stillToPayBack.amount === 92,
    'the retained Travel line shows the warm reading (117 charges, 92 still), dated', JSON.stringify([held.line.activityObservedAt, held.line.stillToPayBack]));
  ok(held.s.creditBreakdown.stillToPayBack.amount === 92 && held.s.creditBreakdown.stillToPayBack.trust === 'estimated',
    'the Credit line\'s left figure is the retained 92, estimated', JSON.stringify(held.s.creditBreakdown.stillToPayBack));
  ok(held.s.credit.totals.paidBack.amount === 25 && held.s.credit.totals.target.amount === 117 && held.s.credit.totals.target.trust === 'estimated',
    'the head is $25 / $117 over the line shown, estimated');
  membersAgree(held, 'retained');
  ok(cents(held.s.creditBreakdown.total) === cents(cold.s.creditBreakdown.total)
    && JSON.stringify(held.s.surplus) === JSON.stringify(cold.s.surplus),
    'the cash deduction and Surplus are the thin observation\'s own (current), not the retained reading\'s',
    JSON.stringify([held.s.creditBreakdown.total, cold.s.creditBreakdown.total]));
  ok(JSON.stringify(held.result.paydayAllocation) === JSON.stringify(cold.result.paydayAllocation)
    && JSON.stringify(held.result.currentPeriodAction) === JSON.stringify(cold.result.currentPeriodAction),
    'the payday decision and the current action are the current observation\'s');
  const page = await loadStackPage({ data: thinCase.data });
  ok(page.status() === 'rendered', 'the Stack page renders the served data');
  ok(/data-stack-credit-total><span class="stack-credit-x">\$25<\/span><i> \/ \$117<\/i>/.test(page.blockHtml('credit')), 'the page head reads $25 / $117');
  const wf = page.sandbox.StackWaterfall.html(page.context(), { creditOpen: true });
  ok(/data-source="stackSummary\.creditBreakdown\.stillToPayBack\.amount">\$92</.test(wf)
    && /data-debt-id="travelvisa"[\s\S]*?stackSummary\.creditBreakdown\.rows\.\d+\.amount">\$92</.test(wf),
    'the page\'s Credit line and its Travel row both read $92');

  console.log('2. Cold: never known, so withheld');
  ok(cold.line.stillToPayBack.amount === null && cold.s.creditBreakdown.stillToPayBack.amount === null
    && cold.s.creditBreakdown.stillToPayBack.trust === 'unavailable', 'the row and the Credit line are withheld, never $0');
  membersAgree(cold, 'cold');

  console.log('3. Genuinely newer evidence wins');
  const newer = read(warmThen({ extra: true }).data);
  ok(!newer.line.activityObservedAt && newer.line.stillToPayBack.amount === 104 && newer.s.creditBreakdown.stillToPayBack.amount === 104,
    'a new $12 charge: the current 104, nothing retained', JSON.stringify(newer.line.stillToPayBack));
  membersAgree(newer, 'newer');

  console.log('4. Contradictory evidence is not papered over');
  const reversed = read(warmThen({ reversal: true }).data);
  ok(!reversed.line.activityObservedAt && reversed.line.paidBack.reasons.includes('payment-direction-unresolved')
    && reversed.s.creditBreakdown.stillToPayBack.amount === null, 'a reversal withholds the line and the Credit line, even after a warm reading');
  membersAgree(reversed, 'reversal');

  console.log('5. Characterization (lead\'s choice pending): a failed payer sync with charges known');
  const payer = read(warmThen({ payerSyncFailed: true }).data);
  ok(payer.line.spent.amount === 117 && payer.line.paidBack.amount === null && !payer.line.activityObservedAt
    && payer.s.creditBreakdown.stillToPayBack.amount === null,
    'Paid back is withheld by the paying-side rule; #1669 does not retain a line whose charges are known; the Credit line is a dash',
    JSON.stringify(payer.line.paidBack.reasons));
  membersAgree(payer, 'payer sync failed');

  console.log('6. A completed period never takes a retained line');
  const read2 = file => readFile(path.join(ROOT, file), 'utf8');
  const engine = sources => { const c = { console }; c.window = c; vm.createContext(c);
    for (const f of ['public/display-name.js', 'public/forecast-card-period.js', 'public/forecast.js']) vm.runInContext(sources(f), c); return c.Forecast; };
  const pay = (amount, date) => [['bills', amount, date, 'cash'], ['card', -amount, date, 'credit']];
  const rolled = world(pay(20, '2026-09-26'), { asOf: '2026-10-05', minimumDate: '2026-09-25' });
  const o = Live.fromObservation(rolled).data;
  const completedOf = F => {
    const base = { debts: o.debts, currentPeriodActuals: o.liveOverlay.currentPeriodActuals };
    const line = F.recommend(o.plan, rolled.asOf, base).payPeriodViews.find(v => v.start === '2026-09-18').stackSummary.credit.lines.find(l => l.id === 'travelvisa');
    const fig = amount => ({ amount, trust: 'calculated', reasons: [] });
    // A formerly retained reading for that period, with different figures (invented): 117 charged, nothing paid back.
    const { deduction, ...shape } = line;
    const card = { ...shape, spent: fig(117), target: { ...line.target, amount: 117 }, paidBack: fig(0), paidToward: fig(0), stillToPayBack: fig(117),
      asOf: '2026-09-30', observedAt: '2026-09-30T18:00:00Z' };
    const rec = F.recommend(o.plan, rolled.asOf, { ...base, lastKnownCardActivity: { start: '2026-09-18', end: '2026-10-01', cards: [card] } });
    const v = rec.payPeriodViews.find(x => x.start === '2026-09-18');
    return { line: v.stackSummary.credit.lines.find(l => l.id === 'travelvisa'), b: v.stackSummary.creditBreakdown, v, before: line };
  };
  const real = completedOf(engine(read2));
  ok(real.before.spent.amount === null && real.v.role === 'lookback', 'control: the completed period\'s Travel charges are withheld, so a swap would apply without the gate');
  ok(!real.line.activityObservedAt && real.line.stillToPayBack.amount === 5 && real.b.basis === 'minimums'
    && real.b.rows.find(r => r.debtId === 'travelvisa').amount === 5 && real.b.stillToPayBack.amount === 5 && cents(real.b.total) === 2500,
    'the completed row keeps Forecast\'s published 5 (25 − 20), the Credit line 5 over the 25 minimum', JSON.stringify([real.b.rows, real.b.total]));
  const fsrc = read2('public/forecast.js');
  const ungated = fsrc.replace("creditBreakdown && creditBreakdown.basis === 'targets' && activity?.start", 'creditBreakdown && activity?.start');
  const mut = completedOf(engine(file => (file === 'public/forecast.js' ? ungated : read2(file))));
  ok(ungated !== fsrc && mut.line.activityObservedAt && mut.b.rows.find(r => r.debtId === 'travelvisa').amount === 117,
    'MUTANT: without the gate the completed period takes the retained 117, which the check above rejects');

  console.log('7. Mutant: the breakdown reading the observation\'s own lines');
  const ownLines = fsrc.replace('    const lines = displayCredit.lines;\n', '    const lines = entry.credit.lines;\n');
  const F2 = engine(file => (file === 'public/forecast.js' ? ownLines : read2(file)));
  const m = read(thinCase.data, F2);
  ok(ownLines !== fsrc && m.line.stillToPayBack.amount === 92 && m.s.creditBreakdown.stillToPayBack.amount === null,
    'MUTANT: the Credit line goes to a dash while the Travel line still shows 92, which section 1 rejects');

  console.log(`\nPASS The Credit line follows the last known lines shown (${checks})`);
})().catch(error => { console.error(error); process.exitCode = 1; });
