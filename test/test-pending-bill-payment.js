'use strict';
// H3, invented ledger. Planned income 1,400 minus household hold 400 minus
// one 7 bill leaves 993. The 3 market purchase is inside the household hold.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const H = require('./acceptance/harness');
const Forecast = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Operating = require('../scripts/operating-answer');
const Assistant = require('../scripts/assistant-packet');

const PAYDAY = '2026-10-09';
const MIDWEEK = '2026-10-14';
const CLOUD = { id: 'invented-cloud', label: 'Invented cloud', frequency: 'monthly',
  amount: 7, confidence: 'confirmed', payingAccount: 'chequing-a', payee: 'INVENTED HOST STORAGE' };
const PHOTOS = { ...CLOUD, id: 'invented-photos', label: 'Invented photos', payee: 'INVENTED HOST PHOTOS' };
const authorization = (date, extra = {}) => H.lm({ id: 8001, date, category: 'Groceries',
  amount: 7, account: 'chequing-a', payee: 'Renamed host', originalName: CLOUD.payee,
  pending: true, raw: { plaid_metadata: { transaction_id: 'invented-authorization' } }, ...extra });
const posted = date => H.lm({ id: 8002, date, category: 'Groceries', amount: 7,
  account: 'chequing-a', payee: 'Renamed host', originalName: CLOUD.payee,
  raw: { plaid_metadata: { transaction_id: 'invented-posted', pending_transaction_id: 'invented-authorization' } } });

function observe(date, debits, bills = [CLOUD]) {
  const w = H.baseWorld(date);
  w.bills = bills.map(bill => ({ day: Number(date.slice(-2)), ...bill }));
  w.transactions = [
    H.lm({ id: 8010, date: PAYDAY, amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ id: 8011, date, amount: 3, category: 'Groceries', account: 'chequing-b', payee: 'Invented market' }),
    ...debits,
  ];
  H.productionOpening(w);
  const canonical = H.canonicalOf(w, H.planOf(w));
  if (date === MIDWEEK) {
    // A canonical opening taken mid-period has no payday-morning snapshot.
    canonical.meta.asOf = canonical.plan.opening.asOf = date;
    for (const cash of canonical.plan.startingCash.breakdown) cash.evidenceDate = date;
  }
  const { data } = Live.fromObservation({ data: canonical, periods: [],
    accountMap: H.accountMapOf(w), identity: H.identityOf(w), payload: H.rawPayload(w) });
  const opts = { ...Operating.recommendOpts(data, {}), periods: [] };
  const advice = Forecast.recommend(data.plan, date, opts);
  const period = advice.payPeriodViews.find(p => p.start <= date && p.end >= date);
  const packet = opts.currentPeriodActuals;
  const action = advice.currentPeriodAction;
  return { data, advice, period, action, packet, row: period.bills.find(b => b.id === CLOUD.id) };
}

function render(result) {
  const ctx = vm.createContext({ Forecast, document: { addEventListener() {}, getElementById() { return null; } },
    addEventListener() {}, localStorage: { getItem() { return null; } } });
  ctx.window = ctx;
  ctx.data = result.data;
  ctx.row = result.row;
  ctx.period = result.period;
  ctx.action = result.action;
  for (const src of ['app', 'bill-detail', 'plan']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', src + '.js'), 'utf8'), ctx);
    if (src === 'app') vm.runInContext("App.boot = App.once = App.register = () => {}; Object.defineProperty(App, 'data', { get: () => data });", ctx);
  }
  const run = expression => vm.runInContext(expression, ctx);
  return {
    list: run('budgetBillBrowseRowHtml(row)'),
    detail: run('periodBillLine(row)'),
    mustLeave: run('mustLeaveHtml(null, action)'),
    between: run('betweenPaydaysOperatingHtml(action)'),
  };
}

function oneExpense(result) {
  const { period, packet } = result;
  const receipts = packet.representedActuals.filter(r => r.id === CLOUD.id);
  assert.equal(receipts.length, 1);
  const billDebits = packet.transactions.filter(t => t.representedBill && t.amount === 7);
  assert.equal(billDebits.length, 1);
  assert.equal(receipts[0].transactionId, billDebits[0].id);
  const groceries = period.householdBudget.find(c => c.id === 'groceries');
  assert.equal(groceries.spent, 3, 'only the market purchase belongs to Groceries');
  assert.equal(period.periodBillLoad, 7);
  assert.equal(period.balanceAfterDeductions, 1400 - 400 - 7);
}

test('a pending debit is in flight on Budget, the operating action, the glance and the assistant packet', () => {
  const result = observe(PAYDAY, [authorization(PAYDAY)]);
  const { row, period, action, packet, advice } = result;
  assert.equal(packet.representedActuals.find(r => r.id === CLOUD.id).pending, true);
  assert.equal(row.settlement, 'pending');
  assert.equal(row.status, 'pending');
  assert.equal(row.actual, null);
  assert.equal(row.remaining, 0);
  assert.equal(period.paidBills, 0);
  assert.equal(period.remainingBills, 0);
  assert.notEqual(period.budgetProgress.bills.actual.completeness, 'complete');
  const operatingBill = action.bills.find(b => b.id === CLOUD.id);
  assert.equal(operatingBill.settlement, 'pending');
  assert.equal(operatingBill.remaining, 7, 'cash is reserved while the authorization is in flight');
  assert.equal(action.todayActions.some(a => a.kind === 'pay' && a.id === CLOUD.id), false);
  const due = action.thisPaydayDue.find(b => b.id === CLOUD.id);
  assert.equal(due.settlement, 'pending');
  assert.equal(due.movement, -7);
  const week = advice.weekViews.flatMap(v => v.bills).find(b => b.id === CLOUD.id && b.date === PAYDAY);
  assert.equal(week.settlement, 'pending');
  assert.equal(week.status, 'pending');
  const assistant = Assistant.buildPacket({ data: result.data, periods: [], questionsMarkdown: '',
    now: PAYDAY + 'T18:30:00Z', env: {} });
  assert.equal(assistant.forecast.currentPeriodAction.bills.find(b => b.id === CLOUD.id).settlement, 'pending');
  const html = render(result);
  assert.match(html.list, />Payment pending</);
  assert.doesNotMatch(html.list, />Paid</);
  assert.match(html.detail, /payment pending/i);
  assert.doesNotMatch(html.detail, /marked PAID/i);
  assert.match(html.mustLeave, /Invented cloud[^<]*payment pending/i);
  assert.doesNotMatch(html.mustLeave, /Invented cloud[^<]*still due/i);
});

test('a pending authorization followed by its linked posting is one paid bill and never a grocery purchase', () => {
  for (const date of [PAYDAY, MIDWEEK]) {
    const pending = observe(date, [authorization(date)]);
    const settled = observe(date, [authorization(date), posted(date)]);
    oneExpense(pending);
    oneExpense(settled);
    assert.equal(pending.period.paidBills, 0);
    assert.equal(settled.period.paidBills, 7);
    assert.equal(settled.row.actual, 7);
    assert.equal(settled.row.settlement, 'represented');
    assert.equal(settled.row.status, 'PAID');
    assert.equal(settled.packet.representedActuals.find(r => r.id === CLOUD.id).pending, undefined);
    assert.match(render(settled).list, />Paid</);
    for (const { period } of [pending, settled]) {
      assert.equal(period.opening, 2000 + 500);
      if (date === PAYDAY) {
        assert.equal(period.openingSource, 'snapshot');
        assert.equal(period.plannedPeriodClose, 2000 + 500 + 1400 - 400 - 7);
      } else {
        assert.equal(period.openingSource, 'cutover-opening');
        assert.equal(period.plannedPeriodClose, null, 'mid-period cash does not establish the payday opening');
      }
    }
    if (date === MIDWEEK) {
      assert.match(render(pending).between, /payment pending/i);
    }
  }
});

test('a 9 authorization on a planned 7 bill cannot publish a posted actual or change the assigned bill deduction', () => {
  const result = observe(PAYDAY, [authorization(PAYDAY, { amount: 9 })]);
  const receipt = result.packet.representedActuals.find(r => r.id === CLOUD.id);
  assert.equal(receipt.actual, 9, 'the observed authorization differs from the plan');
  assert.equal(result.row.settlement, 'pending');
  assert.equal(result.row.actual, null);
  assert.equal(result.period.paidBills, 0);
  assert.equal(result.period.periodBillLoad, 7);
  assert.equal(result.period.balanceAfterDeductions, 1400 - 400 - 7);
  assert.equal(result.period.householdBudget.find(c => c.id === 'groceries').spent, 3);
});

test('a later posting inherits the authorization identity only when the posted debit still qualifies', () => {
  const dayAfter = '2026-10-10';
  const after = (changes, bills = [CLOUD]) => {
    const survivor = { ...posted(dayAfter), payee: 'Cleared debit', original_name: 'Cleared debit', ...changes };
    return observe(dayAfter, [authorization(PAYDAY), survivor], bills.map(bill => ({ ...bill, day: 9 })));
  };
  const allowed = after({ amount: '9.00' });
  assert.equal(allowed.row.settlement, 'represented');
  assert.equal(allowed.row.actual, 9);
  assert.equal(allowed.period.paidBills, 9);
  const operating = allowed.action.bills.find(b => b.id === CLOUD.id && b.date === PAYDAY);
  assert.equal(operating.settlement, 'represented');
  assert.equal(operating.actual, 9);
  assert.equal(operating.remaining, 0);
  assert.equal(allowed.period.householdBudget.find(c => c.id === 'groceries').spent, 3);
  assert.equal(allowed.action.todayActions.some(a => a.id === CLOUD.id && a.kind === 'pay'), false);
  const unexpected = after({ amount: '10.51' }); // One cent above 1.5 times the 7 bill.
  assert.equal(unexpected.packet.representedActuals.some(r => r.id === CLOUD.id), false);
  assert.equal(unexpected.period.paidBills, 0);
  assert.equal(unexpected.period.householdBudget.find(c => c.id === 'groceries').spent, 3 + 10.51);
  const competing = { ...PHOTOS, payee: CLOUD.payee, amount: 9, rule: { settlesWhen: 'exact-scheduled-amount' } };
  assert.equal(observe(PAYDAY, [authorization(PAYDAY)], [CLOUD, competing]).row.settlement, 'pending');
  const ambiguous = after({ amount: '9.00' }, [CLOUD, competing]);
  assert.equal(ambiguous.packet.representedActuals.some(r => [CLOUD.id, PHOTOS.id].includes(r.id)), false);
  assert.equal(ambiguous.period.householdBudget.find(c => c.id === 'groceries').spent, 3 + 9);
  for (const changes of [{ amount: '-7.00' }, { currency: 'usd' }, { is_pending: undefined }, { plaid_account_id: null }]) {
    const refused = after(changes);
    assert.equal(refused.packet.representedActuals.some(r => r.id === CLOUD.id), false);
    assert.equal(refused.period.paidBills, 0);
  }
});

test('a pending authorization that vanishes restores the due amount and pay action', () => {
  const before = observe(PAYDAY, [authorization(PAYDAY)]);
  const after = observe(PAYDAY, []);
  assert.equal(before.row.settlement, 'pending');
  assert.equal(before.action.todayActions.some(a => a.id === CLOUD.id), false);
  assert.equal(after.packet.representedActuals.some(r => r.id === CLOUD.id), false);
  assert.equal(after.row.settlement, 'upcoming');
  assert.equal(after.row.remaining, 7);
  assert.equal(after.period.remainingBills, 7);
  assert.equal(after.period.paidBills, 0);
  assert.ok(after.action.todayActions.some(a => a.id === CLOUD.id && a.kind === 'pay'));
  assert.match(render(after).list, />Due</);
});

test('Forecast can read an older unflagged receipt linked to native pending evidence', () => {
  const { data, packet } = observe(PAYDAY, [authorization(PAYDAY)]);
  const legacy = structuredClone(packet);
  const receipt = legacy.representedActuals.find(r => r.id === CLOUD.id);
  delete receipt.pending;
  const linked = legacy.transactions.find(tx => tx.id === receipt.transactionId);
  assert.equal(linked.pending, true);
  const result = Forecast.recommend(data.plan, PAYDAY, { periods: [], currentPeriodActuals: legacy });
  const row = result.payPeriodViews.find(p => p.start === PAYDAY).bills.find(r => r.id === CLOUD.id);
  assert.equal(row.settlement, 'pending');
  assert.equal(row.actual, null);
});

test('two same-day bills with the same displayed payee and amount can use only a unique original descriptor', () => {
  const date = PAYDAY;
  const onlyCloud = observe(date, [authorization(date)], [CLOUD, PHOTOS]);
  const sibling = onlyCloud.period.bills.find(b => b.id === PHOTOS.id);
  assert.equal(onlyCloud.row.settlement, 'pending');
  assert.equal(sibling.settlement, 'upcoming');
  assert.equal(sibling.remaining, 7);
  assert.equal(onlyCloud.period.remainingBills, 7);
  assert.equal(onlyCloud.period.paidBills, 0);
  assert.deepEqual(onlyCloud.packet.representedActuals.filter(r => [CLOUD.id, PHOTOS.id].includes(r.id)).map(r => r.id), [CLOUD.id]);
  for (const rule of [{}, { settlesWhen: 'exact-scheduled-amount' }]) {
    const ambiguous = observe(date, [authorization(date)], [CLOUD, { ...PHOTOS, payee: CLOUD.payee, rule }]);
    assert.equal(ambiguous.packet.representedActuals.some(r => [CLOUD.id, PHOTOS.id].includes(r.id)), false);
    assert.deepEqual(ambiguous.period.bills.filter(b => [CLOUD.id, PHOTOS.id].includes(b.id)).map(b => b.settlement),
      ['upcoming', 'upcoming']);
    assert.equal(ambiguous.period.remainingBills, 14);
  }
});

test('a displayed payee rename and equal amount cannot claim a purchase from an unrelated original descriptor', () => {
  const unrelated = authorization(PAYDAY, { originalName: 'INVENTED MARKET', payee: CLOUD.payee });
  const result = observe(PAYDAY, [unrelated]);
  assert.equal(result.packet.representedActuals.some(r => r.id === CLOUD.id), false);
  assert.equal(result.row.settlement, 'upcoming');
  assert.equal(result.row.remaining, 7);
  assert.equal(result.period.householdBudget.find(c => c.id === 'groceries').spent, 3 + 7);
});

test('split payments count each child once and never assign the same money through its parent', () => {
  for (const pending of [true, false]) {
    const split = (id, amount, originalName, raw) => H.lm({ id, date: PAYDAY, amount, pending,
      payee: 'Invented market', originalName, account: 'chequing-a', category: 'Groceries', raw });
    const market = 'INVENTED MARKET';
    const unrelatedChildren = observe(PAYDAY, [
      split(8100, 7, CLOUD.payee, { is_group: true }),
      split(8101, 4, market, { parent_id: 8100 }),
      split(8102, 3, market, { parent_id: 8100 }),
    ]);
    assert.equal(unrelatedChildren.row.settlement, 'upcoming');
    assert.equal(unrelatedChildren.packet.representedActuals.some(r => r.id === CLOUD.id), false);
    assert.equal(unrelatedChildren.period.householdBudget.find(c => c.id === 'groceries').spent, 3 + 4 + 3);
    const billChild = observe(PAYDAY, [
      split(8100, 9, CLOUD.payee, { is_group: true }),
      split(8101, 7, CLOUD.payee, { parent_id: 8100 }),
      split(8102, 2, market, { parent_id: 8100 }),
    ]);
    const receipts = billChild.packet.representedActuals.filter(r => r.id === CLOUD.id);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].actual, 7);
    assert.equal(billChild.row.settlement, pending ? 'pending' : 'represented');
    assert.equal(billChild.period.paidBills, pending ? 0 : 7);
    assert.equal(billChild.period.householdBudget.find(c => c.id === 'groceries').spent, 3 + 2);
  }
});
