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
 *   5. The paying account's sync fails while charges stay the same (lead disposition on #1671): the earlier coherent line
 *      stands, estimated, and the head and Credit line sum it; the deduction, Surplus, payment evidence and decisions stay
 *      current. Not carried across changed charges, a reversal seen under the gap (the walk's veto), an unreadable payer
 *      row (fail closed), a cold start or another household; newer complete data replaces it.
 *   6. A completed period never takes a retained line (the gate in publishStackSummary): its row keeps Forecast's
 *      published remainder (5 of the 25 minimum), with a mutant that removes the gate.
 *   7. Mutant: the breakdown reading the observation's own lines instead of the lines shown leaves case 1's Credit line
 *      withheld, so the left figure would disagree with the rows.
 *   8. Mutants for case 5: the display swap without the payer-gap rule, the gap's veto walk removed, and a memory that lets
 *      the gap reading evict the held line.
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

function observation(hour, { cardSync = true, extra = false, reversal = false, payerSyncFailed = false, unreadablePayerRow = false,
  payerNote = 'card payment: Travel Visa', payerEdit = null, unassignedReversal = false, minimum = null, transactionsNull = false } = {}) {
  const input = world([['card', 80, '2026-09-18', 'purchase', { id: 88101 }], ['card', 37, '2026-09-19', 'purchase', { id: 88102 }],
    ['bills', 25, day, 'cash', { id: 88103, notes: payerNote }],
    ...(reversal ? [['bills', -25, day, 'cash', { id: 88106, notes: 'card payment: Travel Visa' }]] : []),
    ...(unassignedReversal ? [['bills', -25, day, 'cash', { id: 88107 }]] : []),
    ...(extra ? [['card', 12, day, 'purchase', { id: 88105 }]] : [])], { asOf: day, windowStart: '2026-09-18' });
  if (minimum != null) input.data.plan.obligations[0].amount = minimum;
  const { payload } = input;
  Object.assign(payload, { categories: [], tags: [], fetchedAt: `${day}T${hour}:00:00Z` });
  payload.pendingCoverage.truncated = false;
  for (const account of payload.accounts) account.last_fetch = payload.fetchedAt;
  if (!cardSync) delete payload.accounts.find(account => account.id === 3004).last_fetch;
  const { data } = Live.fromObservation(input);
  if (payerEdit) {
    const rows = data.liveOverlay.currentPeriodActuals.transactions;
    const payment = rows.find(tx => tx.amount === 25 && tx.atlasAccountId === 'chequing-a');
    assert.ok(payment, 'the invented payer row is in the packet');
    payerEdit(payment, rows);
  }
  if (transactionsNull) data.liveOverlay.currentPeriodActuals.transactions = null;
  if (unreadablePayerRow) {
    // A copy of the noted $25 payer row with an unreadable date (invented): the walk cannot read it.
    const rows = data.liveOverlay.currentPeriodActuals.transactions;
    const payment = rows.find(tx => tx.amount === 25 && tx.atlasAccountId === 'chequing-a');
    assert.ok(payment, 'the invented payer row is in the packet');
    rows.push({ ...payment, id: 'invented-unreadable', coverageRef: undefined, date: 'not-a-date' });
  }
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

  console.log('5. A failed payer sync with the same charges: the earlier line stands (OD-045; lead disposition on #1671)');
  const payerCase = warmThen({ payerSyncFailed: true });
  const payer = read(payerCase.data), payerCold = read(payerCase.thin.data);
  ok(payerCold.line.spent.amount === 117 && payerCold.line.paidBack.amount === null
    && payerCold.line.paidBack.reasons.includes('paying-side-coverage-incomplete') && payerCold.s.creditBreakdown.stillToPayBack.amount === null,
    'control: read cold, the gap reading withholds Paid back for payer coverage and the Credit line is a dash', JSON.stringify(payerCold.line.paidBack.reasons));
  ok(payer.line.activityObservedAt === `${day}T18:00:00Z` && payer.line.paidBack.amount === 25 && payer.line.stillToPayBack.amount === 92
    && payer.line.paidBack.trust === 'estimated', 'warm: the earlier coherent line (25 paid back, 92 still) shows, dated and estimated');
  ok(payer.s.creditBreakdown.stillToPayBack.amount === 92 && payer.s.creditBreakdown.stillToPayBack.trust === 'estimated'
    && payer.s.credit.totals.paidBack.amount === 25 && payer.s.credit.totals.target.amount === 117,
    'the Credit line reads 92 and the head $25 / $117, estimated, over the line shown');
  membersAgree(payer, 'payer gap');
  ok(cents(payer.s.creditBreakdown.total) === cents(payerCold.s.creditBreakdown.total) && JSON.stringify(payer.s.surplus) === JSON.stringify(payerCold.s.surplus)
    && JSON.stringify(payer.result.paydayAllocation) === JSON.stringify(payerCold.result.paydayAllocation)
    && JSON.stringify(payer.result.currentPeriodAction) === JSON.stringify(payerCold.result.currentPeriodAction)
    && JSON.stringify(payer.s.credit.unconfirmedPayments) === JSON.stringify(payerCold.s.credit.unconfirmedPayments),
    'the deduction, Surplus, payment evidence and decisions stay on the current (gap) observation');
  const payerPage = await loadStackPage({ data: payerCase.data });
  const payerWf = payerPage.sandbox.StackWaterfall.html(payerPage.context(), { creditOpen: true });
  ok(/data-stack-credit-total><span class="stack-credit-x">\$25<\/span><i> \/ \$117<\/i>/.test(payerPage.blockHtml('credit'))
    && /data-source="stackSummary\.creditBreakdown\.stillToPayBack\.amount">\$92</.test(payerWf), 'the page reads $25 / $117 and a $92 Credit line');
  // Never carried across changed charges, a reversal, a cold start or another household; newer complete data replaces it.
  const changed = read(warmThen({ payerSyncFailed: true, extra: true }).data);
  ok(!changed.line.activityObservedAt && changed.s.creditBreakdown.stillToPayBack.amount === null, 'a payer gap with changed charges (129): not carried, a dash');
  const reversedGap = read(warmThen({ payerSyncFailed: true, reversal: true }).data);
  ok(!reversedGap.line.activityObservedAt && reversedGap.s.creditBreakdown.stillToPayBack.amount === null, 'a payer gap with a reversal: not carried, a dash');
  ok(reversedGap.line.paidBack.amount === null && reversedGap.line.paidBack.reasons.includes('paying-side-coverage-incomplete')
    && reversedGap.line.paidBack.reasons.includes('payment-direction-unresolved') && reversedGap.s.credit.unconfirmedPayments.length === 0,
    'under the gap the partial rows only veto: the gap stays, the reversal is named, and no amount or unconfirmed entry is supplied',
    JSON.stringify([reversedGap.line.paidBack, reversedGap.s.credit.unconfirmedPayments]));
  const unreadable = read(warmThen({ payerSyncFailed: true, unreadablePayerRow: true }).data);
  ok(!unreadable.line.activityObservedAt && unreadable.line.paidBack.reasons.includes('transaction-date-unqualified')
    && unreadable.s.creditBreakdown.stillToPayBack.amount === null, 'an unreadable paying-side row under the gap fails closed: not carried',
    JSON.stringify(unreadable.line.paidBack.reasons));
  ok(payerCold.line.activityObservedAt === undefined, 'cold (never known): a dash, as the control above');
  {
    const memory = Memory.create();
    publish(memory, observation('18'));
    const gap = observation('19', { payerSyncFailed: true });
    publish(memory, gap);
    const other = memory.withLastKnownCardActivity(context, household + 1, gap.checkedAt, gap.data);
    ok(!read(other).line.activityObservedAt, 'another household: not served');
    const fresh = observation('20', { extra: true });
    publish(memory, fresh);
    const after = read(served(memory, fresh));
    ok(!after.line.activityObservedAt && after.line.stillToPayBack.amount === 104, 'newer complete data replaces the held line (104)');
    const gapAgain = observation('21', { payerSyncFailed: true });
    publish(memory, gapAgain);
    ok(!read(served(memory, gapAgain)).line.activityObservedAt, 'a later gap whose charges differ from the held 129 line is not carried');
  }

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

  console.log('8. Mutants: each restores the payer-gap dash');
  const noSwap = fsrc.replace('    if (line.spent.amount !== null) return heldCardLineCoversPayerGap(line, held);', '    if (line.spent.amount !== null) return false;');
  const swapLess = read(payerCase.data, engine(file => (file === 'public/forecast.js' ? noSwap : read2(file))));
  ok(noSwap !== fsrc && swapLess.s.creditBreakdown.stillToPayBack.amount === null && !swapLess.line.activityObservedAt,
    'MUTANT: the display swap without the payer-gap rule restores the dash, which section 5 rejects');
  // The gap's veto walk removed: a reversal observed under the gap no longer beats the held line.
  const msrcCard = read2('public/forecast-card-period.js');
  const noVeto = msrcCard.replace('        const { unassigned } = walk(shadow, outside);', '        const unassigned = [];');
  // The held warm line handed to the display directly (as a memory holding it would serve it), so the display's own veto
  // is what decides.
  const warmObs = observation('18'), act = Forecast.cardActivityForDisplay(warmObs.data);
  const gapRev = observation('19', { payerSyncFailed: true, reversal: true });
  const handed = { ...gapRev.data, liveOverlay: { ...gapRev.data.liveOverlay, lastKnownCardActivity: { start: act.start, end: act.end,
    cards: act.cards.map(card => ({ ...card, asOf: day, observedAt: warmObs.checkedAt })) } } };
  const vetoed = read(handed, engine(read2));
  ok(!vetoed.line.activityObservedAt && vetoed.s.creditBreakdown.stillToPayBack.amount === null, 'control: the real display refuses the held line under a reversal');
  const vetoLess = read(handed, engine(file => (file === 'public/forecast-card-period.js' ? noVeto : read2(file))));
  ok(noVeto !== msrcCard && vetoLess.line.activityObservedAt && vetoLess.s.creditBreakdown.stillToPayBack.amount === 92,
    'MUTANT: without the veto walk the reversal under the gap carries the held 92, which section 5 rejects');
  // The memory evicting the held line on any newer reading (#1669's rule before this change).
  const memSrc = read2('scripts/server-observation-memory.js');
  const evicting = memSrc.replace('\n      && !Forecast.heldCardLineCoversPayerGap(card, held))) {', ')) {');
  ok(evicting !== memSrc, 'the memory mutant targets the eviction rule');
  const memPath = path.join(ROOT, 'scripts', 'server-observation-memory.js');
  const Module = require('node:module');
  const mod = new Module(memPath, module);
  mod.filename = memPath; mod.paths = Module._nodeModulePaths(path.dirname(memPath));
  mod._compile(evicting, memPath);
  const EvictMemory = mod.exports;
  {
    const memory = EvictMemory.create();
    const w = observation('18'), gap = observation('19', { payerSyncFailed: true });
    const put = o => memory.publish('latest-source', o.evidence, { context, householdAccountId: household, lastBudgetAccountId: household,
      credentialSource: 'env', data: o.data, checkedAt: o.checkedAt }, undefined, Forecast.cardActivityForDisplay(o.data));
    put(w); put(gap);
    const r = read(memory.withLastKnownCardActivity(context, household, gap.checkedAt, gap.data));
    ok(r.s.creditBreakdown.stillToPayBack.amount === null && !r.line.activityObservedAt,
      'MUTANT: a memory that lets the gap reading evict the held line restores the dash, which section 5 rejects');
  }

  console.log('9. Review blockers on 8125066b (Gemini 4 Neon): conflicts, a changed minimum, thin feed contradictions, completed trust');
  // A held line must never stand in over current contradicting evidence; each case below is a warm reading (Travel 117
  // charged, 25 paid back, 92 still) followed by the named newer refresh. The page's head, card row and Credit line are read
  // from the one publication and must agree with the current figures.
  const refused = (label, options, extraCheck) => {
    const r = read(warmThen(options).data);
    const b = r.s.creditBreakdown;
    ok(!r.line.activityObservedAt, `${label}: the held line is refused; the head, row and Credit line read the current publication`,
      JSON.stringify([r.line.paidBack, r.line.stillToPayBack, b.stillToPayBack, r.s.credit.totals.paidBack]));
    membersAgree(r, label);
    if (extraCheck) extraCheck(r);
    return r;
  };
  // 1. Destination conflicts under the payer gap (positive debits): each refuses, with the conflict named and no amount.
  const conflictNamed = r => ok(r.line.paidBack.amount === null && r.line.paidBack.reasons.some(x => x === 'card-payment-destination-conflict'
    || x === 'card-payment-destination-unconfirmed') && r.s.credit.unconfirmedPayments.length === 0,
    'the conflict is named in the withheld Paid back, and no amount or unconfirmed entry is supplied', JSON.stringify(r.line.paidBack.reasons));
  refused('payer gap, payee destination names another card', { payerSyncFailed: true, payerEdit: tx => { tx.cardPaymentDestination = 'cashback'; } }, conflictNamed);
  refused('payer gap, minimum category names another card', { payerSyncFailed: true, payerEdit: tx => { tx.minimumCategoryDebt = 'cashback'; } }, conflictNamed);
  refused('payer gap, a two-card note', { payerSyncFailed: true, payerNote: 'card payment: Travel Visa; card payment: Cash Back' }, conflictNamed);
  refused('payer gap, a HELOC note against a card destination', { payerSyncFailed: true, payerNote: 'card payment: HELOC',
    payerEdit: tx => { tx.cardPaymentDestination = 'travelvisa'; } }, conflictNamed);
  {
    const warmRows = observation('18').data.liveOverlay.currentPeriodActuals.transactions;
    const proof = Forecast.nextProvedPayerReceipts(warmRows, []).find(p => p.cardId === 'travelvisa' && p.amountCents === 2500);
    ok(!!proof, 'control: the warm payer debit is a proved Travel receipt');
    refused('payer gap, a proved Travel receipt whose current note names another card', { payerSyncFailed: true,
      payerNote: 'card payment: Cash Back', payerEdit: tx => { tx.provedPayerReceipt = proof; } }, conflictNamed);
  }
  // 2. A changed minimum with the same charges and target: never the stale minimum or tick.
  refused('payer gap, the minimum changed from 25 to 50', { payerSyncFailed: true, minimum: 50 }, r => ok(r.line.minimum.amount === 50
    && r.line.minimumCovered.value !== true && cents(r.s.bills.cardMinimums.find(m => m.debtId === 'travelvisa').amount) === 5000,
    'the line shows the current 50 minimum and no stale minimum tick, matching the bills split', JSON.stringify([r.line.minimum.amount, r.line.minimumCovered])));
  refused('thin card feed, the minimum changed from 25 to 50', { cardSync: false, minimum: 50 }, r => ok(r.line.minimum.amount === 50
    && r.line.minimumCovered.value !== true, 'the thin-feed line shows the current minimum, never the held one'));
  // 3. Thin card feed with a current contradiction or an uninspected ledger.
  refused('thin card feed with an unassigned reversal', { cardSync: false, unassignedReversal: true }, r => ok(r.s.credit.totals.paidBack.amount === null
    && r.s.creditBreakdown.stillToPayBack.amount === null && r.line.stillToPayBack.amount === null,
    'the head\'s paid side, the row and the Credit line are all withheld together (no stale 25 or 92)'));
  refused('thin card feed with a named reversal', { cardSync: false, reversal: true }, r => ok(r.line.paidBack.reasons.includes('payment-direction-unresolved')
    && r.s.creditBreakdown.stillToPayBack.amount === null, 'the named reversal withholds the row and the Credit line'));
  refused('thin card feed with an uninspected ledger (transactions: null)', { cardSync: false, transactionsNull: true }, r => ok(r.line.paidBack.amount === null
    && r.s.creditBreakdown.stillToPayBack.amount === null, 'the uninspected ledger withholds Paid back and the Credit line', JSON.stringify(r.line.paidBack.reasons)));
  // Control: a thin card feed with a clean current payer reading keeps #1669's one coherent dated reading.
  const clean = read(warmThen({ cardSync: false }).data);
  ok(clean.line.activityObservedAt && clean.s.creditBreakdown.stillToPayBack.amount === 92, 'control: a clean thin card feed still shows the held line');
  // 4. A completed view with no minimum due and unobserved charges: its zero is no more certain than the targets behind it.
  const quiet = world([], { asOf: '2026-10-05', minimumDate: '2026-10-10' });
  const qd = Live.fromObservation(quiet).data;
  const qRec = engine(read2).recommend(qd.plan, quiet.asOf, { debts: qd.debts, currentPeriodActuals: qd.liveOverlay.currentPeriodActuals });
  const qv = qRec.payPeriodViews.find(v => v.start === '2026-09-18');
  const qb = qv.stackSummary.creditBreakdown;
  ok(qv.role === 'lookback' && qb.basis === 'minimums' && qb.rows.length === 0
    && qv.stackSummary.credit.lines.some(l => l.target.amount === 0 && l.target.trust === 'estimated'),
    'control: a completed view with no row and estimated zero targets', JSON.stringify(qv.stackSummary.credit.lines.map(l => [l.id, l.target.amount, l.target.trust])));
  ok(qb.stillToPayBack.amount === 0 && qb.stillToPayBack.trust === 'estimated', 'its Credit line zero is estimated, never calculated', JSON.stringify(qb.stillToPayBack));

  console.log('10. Mutants for the review blockers');
  const cardSrc = read2('public/forecast-card-period.js');
  const noUnattributed = cardSrc.replace('...outside, ...unattributed]) bucket.gaps.add(gap);', '...outside]) bucket.gaps.add(gap);');
  const fsNow = read2('public/forecast.js');
  // The memory (real rule) would refuse to keep the held line; hand it to the display as a memory holding it would serve it.
  const handedOf = (options, base = observation('18')) => {
    const act = Forecast.cardActivityForDisplay(base.data);
    const cur = observation('19', options);
    return { ...cur.data, liveOverlay: { ...cur.data.liveOverlay, lastKnownCardActivity: { start: act.start, end: act.end,
      cards: act.cards.map(card => ({ ...card, asOf: day, observedAt: base.checkedAt })) } } };
  };
  const conflictGap = handedOf({ payerSyncFailed: true, payerEdit: tx => { tx.cardPaymentDestination = 'cashback'; } });
  const c1 = read(conflictGap, engine(read2)), m1 = read(conflictGap, engine(file => (file === 'public/forecast-card-period.js' ? noUnattributed : read2(file))));
  ok(noUnattributed !== cardSrc && !c1.line.activityObservedAt && m1.line.activityObservedAt && m1.s.creditBreakdown.stillToPayBack.amount === 92,
    'MUTANT: without the unattributed-row veto a destination conflict under the gap carries the held 92 (the reviewed defect)');
  const noMinimum = fsNow.replace('      && heldCents(line && line.minimum) === heldCents(held.minimum);', ';');
  const gapMin = { payerSyncFailed: true, minimum: 50 };
  const minReal = read(handedOf(gapMin), engine(read2)), minMut = read(handedOf(gapMin), engine(file => (file === 'public/forecast.js' ? noMinimum : read2(file))));
  ok(noMinimum !== fsNow && !minReal.line.activityObservedAt && minMut.line.activityObservedAt && minMut.line.minimum.amount === 25,
    'MUTANT: without the minimum check the held 25 minimum (and its tick) is shown beside a current 50');
  const noContradiction = fsNow.replace("    if (reasons.some(reason => PAYING_SIDE_CONTRADICTIONS.has(reason))\n      || (unconfirmedPayments || []).some(payment => payment && (payment.amount < 0 || payment.reason === 'card-payment-destination-conflict'))) return false;\n", '');
  const thinRev = handedOf({ cardSync: false, unassignedReversal: true });
  const revReal = read(thinRev, engine(read2)), revMut = read(thinRev, engine(file => (file === 'public/forecast.js' ? noContradiction : read2(file))));
  ok(noContradiction !== fsNow && !revReal.line.activityObservedAt && revMut.line.activityObservedAt
    && revMut.s.credit.totals.paidBack.amount === null && revMut.line.paidBack.amount === 25,
    'MUTANT: without the contradiction check a thin feed with an unassigned reversal shows the held 25 under a withheld head (the reviewed defect)');
  const noTrust = fsNow.replace("rows.map(row => row.trust).concat(trust, lines.map(line => (line.target && line.target.trust) || 'unavailable'))",
    'rows.map(row => row.trust).concat(trust)');
  const qMut = engine(file => (file === 'public/forecast.js' ? noTrust : read2(file))).recommend(qd.plan, quiet.asOf,
    { debts: qd.debts, currentPeriodActuals: qd.liveOverlay.currentPeriodActuals }).payPeriodViews.find(v => v.start === '2026-09-18');
  ok(noTrust !== fsNow && qMut.stackSummary.creditBreakdown.stillToPayBack.trust === 'calculated',
    'MUTANT: without the targets\' trust the completed zero is promoted to calculated (the reviewed defect)');

  console.log(`\nPASS The Credit line follows the last known lines shown (${checks})`);
})().catch(error => { console.error(error); process.exitCode = 1; });
