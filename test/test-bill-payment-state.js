'use strict';
// Invented fixtures. Expected cents are hand-enumerated from #787 6595179923.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), vm = require('node:vm');
const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(root, 'public/forecast'));
const O = require(path.join(root, 'scripts/provider-observe'));
const fixture = require('./fixtures/shaw-posted-identity');
const occurrence = (id = 'invoice', date = '2031-04-14', due = 100) => ({ id, date, due, frequency: 'once' });
const identity = (eventId = 'invoice', extra = {}) => ({ eventId, qualified: true,
  accountId: 'chequing-a', currency: 'cad', postingDateRule: 'covers-early-or-due-on-or-before-posting', ...extra });
const payment = (id = 'invented-payment', amount = 100, extra = {}) => ({ id, amount, date: '2031-04-12',
  accountId: 'chequing-a', currency: 'cad', direction: 'debit', state: 'posted', identities: [identity()], ...extra });
const match = (occurrences, payments) => F.matchBillPayments({ occurrences, payments, asOf: '2031-04-20' });
const state = (actuals, extra = {}) => F.billPaymentState({ due: 100, date: '2031-04-14',
  asOf: '2031-04-13', actuals, ...extra });
const receipt = (amount, id = 'tx-1', extra = {}) => ({ actual: amount, transactionId: id,
  postedOn: '2031-04-12', ...extra });

test('partial 40 of 100 leaves 60; each payment is accumulated once', () => {
  const result = match([occurrence()], [payment('a', 40, { identities: [identity('invoice', { settlesWhen: 'partial' })] })]);
  assert.equal(result.matches[0].allocatedCents, 4000);
  assert.equal(result.matches[0].remainingCents, 6000);
  assert.equal(result.matches[0].status, 'partial');
  const paid = state([receipt(40), receipt(60, 'tx-2'), receipt(40)]);
  assert.equal(paid.allocated, 100); assert.equal(paid.remaining, 0); assert.equal(paid.status, 'paid');
});
test('two equal bills are ambiguous in every input order; amount alone has no identity', () => {
  const bills = [occurrence('a', '2031-04-14', 50), occurrence('b', '2031-04-14', 50)];
  const p = payment('p', 50, { identities: [identity('a'), identity('b')] });
  for (const occurrences of [bills, bills.slice().reverse()]) {
    const r = match(occurrences, [p]); assert.equal(r.matches.length, 0);
    assert.equal(r.unresolved[0].reason, 'ambiguous-occurrence');
  }
  assert.equal(match(bills, [payment('p', 50, { identities: [] })]).matches.length, 0);
});
test('all recurring eligible occurrences compete, without nearest or outstanding preference', () => {
  const bills = [occurrence('invoice', '2031-03-14'), occurrence('invoice', '2031-04-14')]
    .map(o => ({ ...o, frequency: 'monthly' }));
  assert.equal(match(bills, [payment()]).matches.length, 0);
});
test('an explicit occurrence-window start applies before ambiguity and cannot be malformed', () => {
  const bills = [occurrence('invoice', '2031-03-14'), occurrence('invoice', '2031-04-14')]
    .map(row => ({ ...row, frequency: 'monthly' }));
  const p = payment('p', 100, { identities: [identity('invoice', { windowStartDate: '2031-04-04' })] });
  assert.equal(match(bills, [p]).matches[0].date, '2031-04-14');
  p.identities[0].windowStartDate = '2031-02-30';
  assert.equal(match(bills, [p]).matches.length, 0);
});
test('early payment keeps the future occurrence paid without inventing its payment date', () => {
  const r = match([occurrence('invoice', '2031-04-14', 90)], [payment('p', 90)]);
  assert.equal(r.matches[0].date, '2031-04-14'); assert.equal(r.matches[0].remainingCents, 0);
  const s = state([receipt(90)], { due: 90 });
  assert.equal(s.status, 'paid'); assert.equal(s.evidenceDate, '2031-04-12');
});
test('explicit two-day override, same-day default, weekend rule, once seven-day grace', () => {
  const two = p => payment('p', 100, { date: p, identities: [identity('invoice', { earlyPayLookaheadDays: 2 })] });
  assert.equal(match([occurrence()], [two('2031-04-12')]).matches.length, 1);
  assert.equal(match([occurrence()], [two('2031-04-11')]).matches.length, 0);
  assert.equal(match([occurrence()], [payment('p', 100, { identities: [identity('invoice', { postingDateRule: null })] })]).matches.length, 0);
  const weekend = payment('p', 100, { date: '2031-04-14', identities: [identity('invoice', { postingDateRule: 'same-day-or-weekend-next-business-day' })] });
  assert.equal(match([occurrence('invoice', '2031-04-12')], [weekend]).matches.length, 1);
  assert.equal(match([occurrence('invoice', '2031-04-04')], [payment()]).matches.length, 0);
});
test('explicit occurrence assignment can resolve out-of-window; heuristic flag cannot', () => {
  const bills = [occurrence('invoice', '2031-01-14')];
  const i = identity('invoice', { occurrenceDate: '2031-01-14', explicitOccurrence: true });
  assert.equal(match(bills, [payment('p', 100, { identities: [i] })]).matches.length, 1);
  assert.equal(match(bills, [payment('p', 100, { identities: [{ ...i, explicitOccurrence: false }] })]).matches.length, 0);
});
for (const [name, change] of [
  ['missing id', { id: null }], ['missing account', { accountId: null }],
  ['missing currency', { currency: null }], ['foreign currency', { currency: 'usd' }],
  ['credit', { direction: 'credit' }], ['unknown posting', { state: 'unknown' }],
  ['fractional cent', { amount: 100.001 }], ['unsafe cents', { amount: Number.MAX_SAFE_INTEGER }],
]) test('matching refuses ' + name, () => assert.equal(match([occurrence()], [payment('p', 100, change)]).matches.length, 0));
test('different amount needs documented allocation; cents have zero tolerance', () => {
  assert.equal(match([occurrence()], [payment('p', 99.99)]).matches.length, 0);
  const r = match([occurrence()], [payment('p', 120, { identities: [identity('invoice', { settlesWhen: 'partial' })] })]);
  assert.equal(r.matches[0].excessCents, 2000); assert.equal(r.matches[0].allocatedCents, 12000);
  assert.equal(r.matches[0].remainingCents, 0);
  assert.equal(match([occurrence('invoice', '2031-04-14', '12oops')], [payment()]).matches.length, 0);
});
test('pending remains pending through JSON; partial plus legacy cannot become Paid', () => {
  const row = JSON.parse(JSON.stringify(receipt(100, 'p', { postingState: 'pending', pending: true })));
  assert.equal(state([row], { represented: true }).status, 'pending');
  const partial = state([receipt(40)], { represented: true });
  assert.equal(partial.status, 'partial'); assert.equal(partial.remaining, 60);
  assert.equal(state([receipt(40)], { transactions: [{ id: 'tx-1', pending: true }] }).allocated, 0);
});
test('conflicting duplicate identity withholds; repeated identical payment consumes once', () => {
  const p = payment();
  assert.equal(match([occurrence()], [p, { ...p }]).matches[0].allocatedCents, 10000);
  assert.equal(match([occurrence()], [p, { ...p, amount: 20 }]).matches.length, 0);
  assert.equal(state([receipt(40), receipt(50)], { represented: true }).status, 'to-confirm');
});
test('unknown amount/date remains unknown; full legacy confirmation has no invented actual/date', () => {
  assert.equal(state([], { due: '12oops' }).remaining, null);
  assert.equal(state([], { date: null }).status, 'unknown');
  assert.equal(state([], { asOf: null }).remaining, null);
  assert.equal(state([receipt(100, 'a', { postedOn: null })]).evidenceDate, null);
  const legacy = state([], { represented: true });
  assert.equal(legacy.status, 'paid'); assert.equal(legacy.allocated, null); assert.equal(legacy.evidenceDate, null);
});

function observed(amounts = [40], pending = false, ambiguous = false, asOf = null, configure = null) {
  const x = fixture();
  if (asOf) {
    x.asOf = asOf; x.payload.fetchedAt = asOf + 'T18:00:00Z';
    x.payload.transactionWindow.endDate = asOf;
    x.payload.accounts.forEach(row => { row.updated_at = asOf + 'T17:00:00Z'; });
  }
  x.data.plan.bills = [{ ...x.data.plan.bills[0], amount: 100, frequency: 'once', date: '2031-04-14' }];
  if (ambiguous) x.data.plan.bills.push({ ...x.data.plan.bills[0], id: 'other-invoice' });
  x.payload.transactions = amounts.map((amount, i) => ({ ...x.payload.transactions[0], id: 'invented-bill-' + i,
    amount, is_pending: pending, date: '2031-04-12', payee: 'INVENTED INVOICE' }));
  x.identity = { rules: x.data.plan.bills.map(b => ({ eventId: b.id, payeePatterns: ['INVENTED INVOICE'],
    atlasAccountId: 'chequing-a', direction: 'debit', requiredCurrency: 'cad',
    postingDateRule: 'covers-early-or-due-on-or-before-posting', earlyPayLookaheadDays: 2, settlesWhen: 'partial' })) };
  if (configure) configure(x);
  const report = O.observe({ provider: 'lunchmoney', payload: x.payload, accountMap: x.accountMap,
    data: x.data, identity: x.identity, fetchedAt: x.payload.fetchedAt });
  const plan = { ...x.data.plan, debts: [] };
  const packet = O.sanitizedCurrentPeriodActuals(report, { plan, planForIdentity: plan,
    accountMap: x.accountMap, identityRules: x.identity.rules, asOf: x.asOf });
  return { x, report, plan, packet };
}
test('observer → sanitizer → Forecast retains partial, all IDs and cents', () => {
  const { packet, report, plan, x } = observed([20, 20]);
  assert.equal(packet.representedActuals.length, 1);
  assert.equal(packet.representedActuals[0].transactionIds.length, 2);
  assert.equal(report.representedEventCandidates.length, 0, 'partial never becomes a cash-omit event');
  assert.equal(packet.representedActuals.reduce((s, row) => s + row.actual, 0), 40);
  assert.equal(O.currentPeriodActualsLooksSanitized(packet), true);
  assert(!JSON.stringify(packet).includes('invented-bill-'), 'private provider IDs do not publish');
  const opts = { debts: [], currentPeriodActuals: packet, weeklyVariable: 0 };
  const r = F.recommend(plan, x.asOf, opts);
  const bill = r.payPeriodViews.flatMap(p => p.bills).find(b => b.id === 'shaw');
  assert.equal(bill.remaining, 60); assert.equal(bill.status, 'partial'); assert.equal(bill.actual, 40);
});
test('ordinary unpaid bill keeps the incumbent action packet shape without payment issues', () => {
  const { packet, plan, x } = observed([], false, false, '2031-04-13', x => { x.identity.rules = []; });
  assert.equal(Object.hasOwn(packet, 'billPaymentIssues'), false);
  const r = F.recommend(plan, x.asOf, { debts: [], currentPeriodActuals: packet });
  const row = r.currentPeriodAction.bills.find(row => row.id === 'shaw');
  assert(row); assert.equal(row.actual, 0); assert.equal(row.remaining, 100);
  assert.equal(row.settlement, 'upcoming');
  assert.equal(Object.hasOwn(row, 'status'), false);
  assert.equal(Object.hasOwn(row, 'glanceKind'), false);
});
test('observer pending serialization and equal-bill ambiguity cannot settle', () => {
  const pending = observed([100], true);
  assert.equal(pending.report.representedEventCandidates.length, 0);
  assert.equal(pending.packet.representedActuals[0].pending, true);
  const s = state(pending.packet.representedActuals, { transactions: pending.packet.transactions });
  assert.equal(s.status, 'pending'); assert.equal(s.remaining, 100);
  const ambiguous = observed([100], false, true);
  assert.equal(ambiguous.packet.representedActuals.length, 0);
  assert.equal(ambiguous.report.representedEventCandidates.length, 0);
  const r = F.recommend(ambiguous.plan, ambiguous.x.asOf, { debts: [], currentPeriodActuals: ambiguous.packet });
  const rows = r.payPeriodViews.flatMap(p => p.bills).filter(row => ['shaw','other-invoice'].includes(row.id));
  assert.equal(rows.length, 2);
  for (const row of rows) { assert.notEqual(row.status, 'PAID'); assert.equal(row.remaining, null); }

});

function renderer() {
  const context = vm.createContext({ Forecast: F, console, addEventListener() {},
    document: { addEventListener() {}, querySelectorAll() { return []; }, getElementById() { return null; },
      documentElement: { dataset: {}, style: {} } },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/' } });
  vm.runInContext(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'), context);
  vm.runInContext('App.boot = () => {};', context);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/plan.js'), 'utf8'), context);
  return (name, row) => { context.row = row; return vm.runInContext(name + '(row)', context); };
}
test('Plan partial plus legacy represented never prints Paid', () => {
  const render = renderer();
  const row = { id: 'invoice', date: '2031-04-14', label: 'Invented invoice', status: 'PAID',
    settlement: 'represented', movement: -100, actual: 40, remaining: 60,
    cashPaymentStatus: 'sent', householdPaymentStatus: 'partial' };
  assert.doesNotMatch(render('budgetBillBrowseRowHtml', row), />Paid(?:[< ·])/);
  assert.doesNotMatch(render('periodBillLine', row), /data-bill-status="PAID"/);
});


test('early-paid future bill remains paid through the published Plan period', () => {
  const { x, plan, packet } = observed([100], false, false, '2031-04-13');
  const r = F.recommend(plan, x.asOf, { debts: [], currentPeriodActuals: packet });
  const bill = r.payPeriodViews.flatMap(p => p.bills).find(row => row.id === 'shaw');
  assert.equal(bill.date, '2031-04-14'); assert.equal(bill.status, 'PAID');
  assert.equal(bill.remaining, 0); assert.equal(bill.billPaymentState.evidenceDate, '2031-04-12');
  assert.equal(F.expandEvents(plan, x.asOf, '2031-04-14', { currentPeriodActuals: packet })
    .filter(e => e.id === 'shaw').length, 0, 'future liability does not resurrect');
});
test('a wider transaction history does not add a prior-opening monthly competitor to an early payment', () => {
  const { x, plan, packet, report } = observed([100], false, false, '2031-04-13', x => {
    x.data.plan.opening = { asOf: x.asOf, priorAsOf: '2031-04-04' };
    Object.assign(x.data.plan.bills[0], { frequency: 'monthly', day: 14, firstDue: '2031-03-14' });
    delete x.data.plan.bills[0].date;
    x.payload.transactionWindow.startDate = '2031-03-01';
  });
  const hit = report.representedEventCandidates.filter(row => row.id === 'shaw');
  assert.equal(hit.length, 1); assert.equal(hit[0].date, '2031-04-14');
  assert.equal(packet.representedActuals.find(row => row.id === 'shaw').postedOn, '2031-04-12');
  const rows = F.recommend(plan, x.asOf, { debts: [], currentPeriodActuals: packet })
    .payPeriodViews.flatMap(period => period.bills).filter(row => row.id === 'shaw' && row.date === '2031-04-14');
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'PAID'); assert.equal(rows[0].remaining, 0);
});
test('the explicit two-day early bound stays closed beyond its boundary with a wider history', () => {
  const { packet } = observed([100], false, false, '2031-04-13', x => {
    x.data.plan.opening = { asOf: x.asOf, priorAsOf: '2031-04-04' };
    Object.assign(x.data.plan.bills[0], { frequency: 'monthly', day: 14, firstDue: '2031-03-14' });
    delete x.data.plan.bills[0].date;
    x.payload.transactionWindow.startDate = '2031-03-01';
    x.payload.transactions[0].date = '2031-04-11';
  });
  assert.equal(packet.representedActuals.filter(row => row.id === 'shaw').length, 0);
});
test('covered historical and current receipts each keep their own occurrence window', () => {
  const { packet, report, plan, x } = observed([100], false, false, '2031-04-13', x => {
    x.data.plan.opening = { asOf: x.asOf, priorAsOf: '2031-04-04' };
    Object.assign(x.data.plan.bills[0], { frequency: 'monthly', day: 14, firstDue: '2031-03-14' });
    delete x.data.plan.bills[0].date;
    x.payload.transactionWindow.startDate = '2031-03-01';
    x.payload.transactions.push({ ...x.payload.transactions[0], id: 'invented-prior-receipt', date: '2031-03-14' });
  });
  const hits = report.representedEventCandidates.filter(row => row.id === 'shaw');
  assert.deepEqual(hits.map(row => row.date).sort(), ['2031-03-14', '2031-04-14']);
  const linked = packet.representedActuals.filter(row => row.id === 'shaw');
  assert.deepEqual(linked.map(row => row.actual), [100, 100]);
  const r = F.recommend(plan, x.asOf, { debts: [], currentPeriodActuals: packet });
  for (const date of ['2031-03-14', '2031-04-14']) {
    const row = r.payPeriodViews.flatMap(period => period.bills).find(row => row.id === 'shaw' && row.date === date);
    assert(row); assert.equal(row.status, 'PAID'); assert.equal(row.remaining, 0);
  }
});
test('Plan discloses engine-computed unapplied excess on a fully paid bill', () => {
  const payment = state([receipt(100)], { due: 90 });
  const row = { id: 'invoice', label: 'Invented invoice', date: '2031-04-14', movement: -100,
    status: 'PAID', settlement: 'represented', billPaymentState: payment };
  const render = renderer();
  const html = render('budgetBillBrowseRowHtml', row);
  assert.match(html, /Paid/); assert.match(html, /\$10\.00[^<]{0,40}excess/i);
  assert.match(render('periodBillLine', row), /\$10\.00[^<]{0,40}excess/i);
  assert.equal(payment.remaining, 0); assert.equal(payment.excess, 10);
});
test('sanitized represented amounts reject numeric strings even beside legacy representation', () => {
  const invalid = state([receipt('40.00')], { represented: true });
  assert.equal(invalid.status, 'to-confirm'); assert.equal(invalid.allocated, null);
  assert.equal(invalid.remaining, null);
});
test('a pending card bill retains pending evidence without becoming represented settlement', () => {
  const x = require('./fixtures/pending-card-bill-data')('pending', true);
  const report = O.observe({ provider: 'lunchmoney', ...x });
  const packet = report.currentPeriodActuals;
  const tx = packet.transactions.find(tx => tx.pending && tx.atlasAccountId === 'travelvisa');
  assert(tx); assert.equal(tx.representedBill, false); assert.equal(tx.pendingMatchingCardPaidBill, true);
  const pending = packet.pendingBillActuals.find(row => row.id === 'invented-card-service');
  assert(pending); assert.equal(pending.postingState, 'pending');
  assert.equal(packet.representedActuals.some(row => row.transactionId === tx.id), false);
  const s = F.billPaymentState({ due: 73.21, date: '2034-11-03', asOf: x.asOf,
    actuals: [pending], transactions: packet.transactions });
  assert.equal(s.status, 'pending'); assert.equal(s.allocated, 0); assert.equal(s.remaining, 73.21);
  const row = F.recommend(x.data.plan, x.asOf, { debts: x.data.debts, currentPeriodActuals: packet })
    .payPeriodViews.flatMap(period => period.bills).find(row => row.id === 'invented-card-service'
      && row.date === '2034-11-03');
  assert(row); assert.equal(row.billPaymentState.status, 'pending'); assert.notEqual(row.status, 'PAID');
  assert(O.currentPeriodActualsLooksSanitized(packet));
});
test('legacy signed issuer credit keeps its qualified minimum and actual payday movement', () => {
  const plan = fixture().data.plan;
  const id = 'invented-card-minimum', due = '2031-04-16', posted = '2031-04-18', asOf = '2031-04-19';
  plan.bills = [];
  plan.opening = { asOf, priorAsOf: '2031-04-04', representedEvents: [{ id, date: due }] };
  plan.obligations = [{ id, label: 'Invented card minimum', frequency: 'once', date: due,
    amount: 18, debtId: 'invented-card', effect: 'payment', confidence: 'confirmed' }];
  const opts = { debts: [], representedEvents: plan.opening.representedEvents, currentPeriodActuals: {
    representedActuals: [{ id, date: due, actual: -40, postedOn: posted }], transactions: [],
    pendingCoverage: 'complete', transactionCoverage: 'complete' } };
  const action = F.currentPeriodAction(plan, asOf, opts);
  const paid = action.thisPaydayPaid.bills.find(row => row.id === id);
  assert(paid); assert.equal(paid.date, posted); assert.equal(paid.movement, -40);
  assert.equal(paid.planned, 18); assert.equal(paid.remaining, 0);
  assert.equal(Object.hasOwn(paid, 'billPaymentState'), false, 'issuer credit stays with incumbent authority');
  assert.equal(F.expandEvents(plan, due, due, opts).filter(row => row.id === id).length, 0);
});
test('partial plus legacy cash-omit keeps exactly 60 in the cash walk', () => {
  const { plan, packet } = observed([40]);
  const events = F.expandEvents(plan, '2031-04-13', '2031-04-14', {
    currentPeriodActuals: packet, representedEvents: [{ id: 'shaw', date: '2031-04-14' }] });
  assert.equal(events.filter(e => e.id === 'shaw').reduce((s,e) => s + Math.round(e.amount*100),0), -6000);
});
test('unapplied excess never settles a second bill', () => {
  const r = match([occurrence('a'), occurrence('b', '2031-04-14', 20)], [payment('p',120,
    { identities: [identity('a', { settlesWhen: 'partial' })] })]);
  assert.equal(r.matches.length, 1); assert.equal(r.matches[0].id, 'a'); assert.equal(r.matches[0].excessCents, 2000);
});
test('two-leg variable fees preserve the authored allowance and accept the observed total', () => {
  const p = payment('p', 8, { identities: [identity('invoice', { settlesWhen: 'two-leg-sum' })] });
  const q = payment('q', 8, { accountId: 'chequing-b', identities: [identity('invoice',
    { settlesWhen: 'two-leg-sum', accountId: 'chequing-b' })] });
  const m = match([occurrence('invoice', '2031-04-14', 24)], [p,q]).matches[0];
  assert.equal(m.plannedCents,2400);assert.equal(m.dueCents,1600);assert.equal(m.allocatedCents,1600);assert.equal(m.status,'paid');
});


// #842 check 6.1/6.2/6.8: a refreshed cash opening is neither a cutoff
// for older receipts in the covered window nor proof that old bills paid.
function refreshedRecurring() {
  return observed([100], false, false, null, x => {
    x.data.plan.opening = { asOf: x.asOf, priorAsOf: '2031-04-04' };
    x.data.plan.bills[0].frequency = 'monthly';
    delete x.data.plan.bills[0].date;
    x.data.plan.bills.push({ id: 'invented-unpaid', label: 'Invented next bill',
      frequency: 'monthly', day: 16, amount: 60, confidence: 'confirmed', payingAccount: 'chequing-a' });
    x.payload.transactions[0].date = '2031-04-14';
    delete x.identity.rules[0].postingDateRule;
    delete x.identity.rules[0].earlyPayLookaheadDays;
    delete x.identity.rules[0].settlesWhen;
  });
}
test('covered due-date receipt before the refreshed opening retains its recurring identity', () => {
  const { report, packet } = refreshedRecurring();
  const hits = report.representedEventCandidates.filter(row => row.id === 'shaw');
  assert.equal(hits.length, 1); assert.equal(hits[0].date, '2031-04-14');
  const actuals = packet.representedActuals.filter(row => row.id === 'shaw');
  assert.equal(actuals.length, 1); assert.equal(actuals[0].actual, 100);
  assert.equal(actuals[0].postedOn, '2031-04-14');
});
test('the current Bills header counts the matched 100 once and leaves the other 60', () => {
  const { x, plan, packet } = refreshedRecurring();
  const r = F.recommend(plan, x.asOf, { debts: [], currentPeriodActuals: packet });
  const period = r.payPeriodViews.find(p => p.start <= x.asOf && p.end >= x.asOf);
  assert(period); assert.equal(period.paidBills, 100); assert.equal(period.remainingBills, 60);
  const bill = period.bills.find(row => row.id === 'shaw');
  assert.equal(bill.status, 'PAID'); assert.equal(bill.actual, 100); assert.equal(bill.remaining, 0);
});
test('a current payment and opening inclusion never prove an unpaid prior recurring occurrence', () => {
  const { x, plan, packet } = refreshedRecurring();
  const r = F.recommend(plan, x.asOf, { debts: [], currentPeriodActuals: packet });
  const rows = r.pastPeriodViews.flatMap(p => p.bills).filter(row => row.id === 'shaw' && row.date === '2031-03-14');
  assert.equal(rows.length, 1, 'the historical occurrence stays visible');
  const row = rows[0];
  assert.notEqual(row.status, 'PAID'); assert.notEqual(row.settlement, 'represented');
  assert.equal(row.actual, null);
  assert.equal(renderer()('budgetBillPresentation', row).label, 'To confirm');
});
