'use strict';

// Invented provider payloads travel through the live overlay and the same
// Forecast entry point Budget uses. The expected cents below are independent
// of both the Savings tally and the Budget classifier.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const H = require('./acceptance/harness');
const Live = require('../scripts/live-plan');
const { world: cardWorld } = require('./fixtures/card-coverage-aggregate-world');

const date = '2026-11-20';
const trip = { id: 'trip', label: 'Invented trip', date, amount: 500, confidence: 'confirmed', sinkingFund: true };
const link = (id = 'trip', tagId = 201) => ({ tagId, goalRef: { kind: 'commitment', id },
  occurrenceDate: date, effectiveFrom: '2026-09-18', effectiveThrough: '2026-12-04' });
const tag = { tagIds: [201] };
const purchase = extra => H.lm({ date: '2026-10-10', amount: 100, category: 'Trip', payee: 'Invented shop', ...extra });
const income = () => H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' });

function cashWorld(transactions, { links = [link()], pool = true, window } = {}) {
  const w = H.baseWorld();
  if (pool) w.savingsPool = {};
  if (window) w.coverage = window;
  w.commitments = [trip, { ...trip, id: 'gift', label: 'Invented gift' }];
  w.bills = [{ id: 'ordinary-bill', label: 'Invented bill', payee: 'Invented utility', amount: 40,
    frequency: 'biweekly', anchor: '2026-10-12', confidence: 'confirmed' }];
  w.links = links;
  w.tags = [{ id: 201, name: 'Invented trip' }, { id: 202, name: 'Invented gift' }];
  w.transactions = [income(), ...transactions];
  w.planPatch = plan => {
    // The confirmed revision the link names is unavailable. The observed
    // Savings balances still exist, while the tag supplies no Paid proof.
    if (plan.savingsEarmarks) plan.savingsEarmarks.history = [];
    plan.opening.paydaySnapshot = { periodStart: '2026-10-09', asOf: '2026-10-09', opening: 2000 };
    plan.opening.representedEvents = [{ id: 'payroll', date: '2026-10-09' }];
  };
  const result = H.dataOf(w);
  if (result.error) throw result.error;
  return result.data;
}

function read(data, qualifiedAmounts, unresolvedAmounts = []) {
  const { plan } = data;
  const asOf = F.budgetAsOf(data);
  const opts = F.budgetRecommendInputs(data);
  const source = F.savingsLinkTarget.taggedEvidence;
  // A fresh packet prevents the earlier live overlay calculation from
  // caching the base branch's empty membership for this consumer fixture.
  const packet = source ? opts.currentPeriodActuals : structuredClone(opts.currentPeriodActuals);
  opts.currentPeriodActuals = packet;
  // The display PR supplies the source. Until it lands, drive the accounting
  // consumer with explicit observer-local refs for these invented rows.
  if (!source) F.savingsLinkTarget.taggedEvidence = (selectedPlan, selectedAsOf, selectedPacket) => {
    if (selectedPacket !== packet || selectedAsOf !== asOf) return null;
    assert.ok(selectedPlan);
    return { links: [], evidence: [...qualifiedAmounts, ...unresolvedAmounts].map(amount => {
      const tx = packet.transactions.find(row => row.amount === amount);
      assert.ok(tx, 'the invented row survived the live overlay');
      const unresolved = unresolvedAmounts.includes(amount);
      return { transactionRef: tx.id, occurrenceKey: unresolved ? null : 'trip@' + date, direction: amount > 0 ? 'charge' : 'refund',
        date: tx.date, state: unresolved ? 'unresolved' : (tx.pending ? 'pending' : 'posted'), linkRefs: ['link-1'] };
    }) };
  };
  try {
    if (source) {
      const amounts = (source(plan, asOf, packet)?.evidence || [])
        .filter(item => item.state === 'posted' || item.state === 'pending')
        .map(item => packet.transactions.find(row => row.id === item.transactionRef)?.amount);
      assert.deepEqual(amounts.sort((a, b) => a - b), [...qualifiedAmounts].sort((a, b) => a - b));
    }
    const advice = F.recommend(plan, asOf, opts);
    const period = advice.payPeriodViews.find(row => row.role === 'active');
    const pub = F.savingsFundingPublication(advice.savingsFunding, { asOf, advice });
    return { advice, period, pub, classOf(amount) {
      const tx = packet.transactions.find(row => row.amount === amount);
      return F.classifyCurrentPeriodTransaction(tx, plan, { packet });
    }, packet };
  } finally {
    if (!source) delete F.savingsLinkTarget.taggedEvidence;
  }
}

const budgetRow = (result, id) => result.period.householdBudget.find(row => row.id === id);
const householdAmounts = result => result.period.householdBudget.flatMap(row => row.recon.map(tx => tx.amount));
const cost = result => result.pub.rows.find(row => row.key === 'commitment:trip').commitmentCost;

{
  const bill = H.lm({ date: '2026-10-12', amount: 40, account: 'chequing-a', payee: 'Invented utility', ...tag });
  const txs = [
    purchase({ ...tag, pending: true, raw: { plaid_metadata: { transaction_id: 'invented-authorization' } } }),
    purchase({ ...tag, raw: { plaid_metadata: { transaction_id: 'invented-posting', pending_transaction_id: 'invented-authorization' } } }),
    purchase({ ...tag, amount: -30, date: '2026-10-12', payee: 'Invented refund' }),
    purchase({ amount: 20 }),
    purchase({ ...tag, amount: 55, category: 'Groceries', payee: 'Invented market' }),
    purchase({ amount: 15, category: 'Groceries', payee: 'Invented market' }),
    bill,
  ];
  const attributed = read(cashWorld(txs), [100, -30, 55]);
  const unlinked = read(cashWorld(txs, { links: null }), []);
  assert.equal(attributed.packet.transactions.filter(tx => tx.amount === 100).length, 1,
    'provider-confirmed pending replacement leaves one posting');
  for (const amount of [100, -30, 55]) assert.equal(attributed.classOf(amount).kind, 'savings-item');
  assert.equal(attributed.classOf(40).kind, 'bill', 'a tagged bill retains its existing settlement identity');
  assert.deepEqual([budgetRow(attributed, 'groceries').spent, budgetRow(attributed, 'other-spending').spent], [15, 20]);
  assert.deepEqual([budgetRow(unlinked, 'groceries').spent, budgetRow(unlinked, 'other-spending').spent], [70, 120]);
  assert.deepEqual(householdAmounts(attributed).sort((a, b) => a - b), [15, 20], 'the similar untagged purchases still appear');
  // Independent cash proof: 100 - 30 + 55 = 125; budget holds 300 + 100 + 20.
  // The current-period close is 2,000 + 1,400 - 40 - 420 - 125 = 2,815.
  const terms = attributed.period.plannedPeriodCloseTerms;
  assert.deepEqual([terms.periodBillLoad, terms.budgetHold, terms.savingsItemSpending, attributed.period.plannedPeriodClose],
    [40, 420, 125, 2815]);
  assert.equal(attributed.period.balanceAfterDeductions, 815);
  assert.equal(attributed.advice.savingsFunding.stock.reportedStock.amount, 1000);
  assert.equal(cost(attributed).confirmedLinkedPaid.amount, null, 'tag evidence supplies no proof of Paid');
  if (F.savingsLinkTarget.taggedEvidence) assert.equal(cost(attributed).taggedSpend.amount, 125);
}

{
  const tx = purchase({ tagIds: [201, 202] });
  const conflict = read(cashWorld([tx], { links: [link(), link('gift', 202)] }), [], [100]);
  const missing = read(cashWorld([tx], { links: null }), []);
  for (const result of [conflict, missing]) {
    assert.equal(budgetRow(result, 'other-spending')?.spent, 100, 'an unresolved or absent exact link leaves the purchase in Budget');
    assert.equal(result.period.plannedPeriodCloseTerms.savingsItemSpending, undefined);
  }
}

{
  const tx = purchase({ ...tag, pending: true });
  const pending = read(cashWorld([tx]), [100]);
  assert.equal(pending.classOf(100).kind, 'savings-item');
  assert.equal(pending.period.plannedPeriodCloseTerms.savingsItemSpending, 100, 'the pending charge still encumbers cash');
  assert.equal(cost(pending).confirmedLinkedPaid.amount, null);
  if (F.savingsLinkTarget.taggedEvidence) assert.equal(cost(pending).taggedSpend.pendingAmount, 100);

  const partial = read(cashWorld([purchase(tag)], { pool: false, window: { complete: false, hasMore: true } }), [100]);
  assert.equal(partial.period.balanceAfterDeductions, null, 'coverage loss still withholds the actuals-dependent remainder');
  assert.equal(partial.period.plannedPeriodCloseTerms.savingsItemSpending, 100, 'the dated charge still enters the estimated close');
  assert.equal(partial.period.plannedPeriodClose, null, 'coverage loss does not publish an exact close from partial inputs');
}

{
  const input = cardWorld([['card', 100, null, 'purchase', { tag_ids: [201] }]], { reserveSavings: true,
    savingsOpening: 250, edit(x) {
      x.data.plan.commitments = [trip];
      x.data.plan.savingsEarmarks.pools[0].goalRefs = [link().goalRef];
      x.accountMap.savingsLinks = { version: 1, anchorRevision: 2, links: [link()] };
      x.payload.tags = [{ id: 201, name: 'Invented trip' }];
      x.payload.accounts[3].last_fetch = x.asOf + 'T17:00:00Z';
    } });
  const withTag = read(Live.fromObservation(input).data, [100]);
  const withoutTag = read(Live.fromObservation({ ...input, accountMap: { ...input.accountMap, savingsLinks: undefined } }).data, []);
  assert.equal(withTag.classOf(100).kind, 'savings-item');
  assert.equal(withTag.advice.cardPurchaseCoverage.reservedCash, 100, 'the card ledger still protects the unpaid charge');
  assert.equal(withoutTag.advice.cardPurchaseCoverage.reservedCash, 100);
  const card = withTag.period.stackSummary.credit.lines.find(row => row.id === 'travelvisa');
  assert.deepEqual([card.balance.amount, card.spent.amount, card.deduction.alreadyCounted, card.deduction.amount], [500, 100, 100, 0],
    'the $100 stays in card debt and Spent, and Credit credits the item deduction once');
  assert.equal(withTag.period.plannedPeriodCloseTerms.savingsItemSpending, 100);
  assert.equal(withTag.period.plannedPeriodCloseTerms.earlierCardPurchaseReserve, undefined, 'card liability is deducted from the close once');
  assert.equal(withTag.period.plannedPeriodClose, 1225, '500 opening + 1,000 payroll - 25 minimum - 150 budget - 100 Savings item');
  assert.equal(withTag.advice.savingsFunding.stock.reportedStock.amount, 250, 'tag evidence cannot draw the Savings reserve');
  assert.equal(cost(withTag).confirmedLinkedPaid.amount, null);
}

console.log('Savings tag spending routes once through Budget and the cash close, while the card and Savings evidence retain their authorities.');
