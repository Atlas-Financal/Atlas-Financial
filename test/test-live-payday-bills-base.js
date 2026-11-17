'use strict';
/* Live-refresh Current Balance on a Dale/Seaspan payday.
 *
 * overlayLiveState stamps the fetch date onto the opening and replaces
 * the BILLS row before Forecast runs. The pre-payday base has to be
 * walked on the original plan first and kept only in memory.
 *
 * The numerical oracle adds the synthetic BILLS opening to the fixture's
 * posted movements, then adds planned payroll. It does not call
 * householdCurrentBalance or prePaydayBillsAccountCash. Opening, payroll,
 * and movements are chosen here. They are not read from data.json.
 *
 * `node test/test-live-payday-bills-base.js`
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const Forecast = require('../public/forecast.js');
const Live = require('../scripts/live-plan.js');
const { sourceText } = require('./test-source-text');
const LmGroups = require('./lm-groups-fixture.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');
const PAYDAY = '2026-09-25';
const OPENING_AS_OF = '2026-08-19';
const GAP_START = '2026-08-20';
const GAP_THROUGH = '2026-09-24';
const OPENING_BILLS = 1000;
const WEEKLY = 80;
const SAVINGS = 20;
const PAYROLL = 4000;
const MOVEMENT_A = 200;
const MOVEMENT_B = 50;
const SAME_DAY_DEBIT = 100;
const SAME_DAY_CREDIT = 40;
// Within 1% of the fixture payroll (window is 40). This is the 4,250-style
// near-payroll inflow, scaled to the fixture payroll of 4,000. It is not
// read from data.json.
const NEAR_PAYROLL = 4020;
const OFF_PLAN_DEPOSIT = 4310;
const SPLIT_A = 3000;
const SPLIT_B = 1274.98;

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const cents = n => Math.round(Number(n) * 100);
const fromCents = c => c / 100;
const add = (a, b) => fromCents(cents(a) + cents(b));
const clone = x => JSON.parse(JSON.stringify(x));
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));

function grab(src, re, label) {
  const match = re.exec(src);
  if (!match) throw new Error('missing ' + label);
  return match[0];
}

function loadComposer() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
    grab(planSrc, /^function paydayGlanceCashNote\([\s\S]*?\n\}$/m, 'paydayGlanceCashNote'),
    grab(planSrc, /^function providerBalanceDate\([\s\S]*?\n\}$/m, 'providerBalanceDate'),
    grab(planSrc, /^function glanceUpdatedNote\([\s\S]*?\n\}$/m, 'glanceUpdatedNote'),
    grab(planSrc, /^function liveCurrentBalanceHtml\([\s\S]*?\n\}$/m, 'liveCurrentBalanceHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({ liveCurrentBalanceHtml, money2 });`,
    { Forecast }
  );
}

function cashRow(data, id) {
  const rows = (data.plan && data.plan.startingCash && data.plan.startingCash.breakdown) || [];
  return rows.find(row => row && row.id === id) || null;
}

function round2(n) {
  return fromCents(cents(n));
}

const repoHash = crypto.createHash('sha256').update(fs.readFileSync(DATA)).digest('hex');
const movementDebit = add(MOVEMENT_A, MOVEMENT_B);
const walkedBase = add(OPENING_BILLS, -movementDebit);
const assumed = add(walkedBase, PAYROLL);
const doubled = add(assumed, PAYROLL);
const payrollNote = 'Includes planned Dale payday +$4,000.00 awaiting bank update';

function payrollStream() {
  return {
    id: 'payroll',
    label: 'Payroll — Seaspan',
    frequency: 'biweekly',
    anchor: '2026-08-14',
    amount: PAYROLL,
    confidence: 'confirmed',
  };
}

function paydayMovement(id, lmAmount, payee, extra) {
  const tx = {
    id,
    date: PAYDAY,
    amount: lmAmount,
    pending: false,
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
  };
  if (payee) tx.displayedPayee = payee;
  if (extra) Object.assign(tx, extra);
  return tx;
}

// Proven household-internal transfer into chequing-a. The pair is the
// existing TD TFR identity: opposite TO/FR, matching amount, two household
// cash accounts. The chequing-b leg is not a BILLS movement.
function householdTransferIntoBills(amount) {
  return [
    {
      id: 'tfr-bills-in',
      date: PAYDAY,
      amount: -amount,
      pending: false,
      accountRole: 'household-cash',
      atlasAccountId: 'chequing-a',
      tfrReference: 'AB101',
      tfrDirection: 'FR',
    },
    {
      id: 'tfr-weekly-out',
      date: PAYDAY,
      amount: amount,
      pending: false,
      accountRole: 'household-cash',
      atlasAccountId: 'chequing-b',
      tfrReference: 'AB101',
      tfrDirection: 'TO',
    },
  ];
}

function canonicalPlan() {
  return {
    meta: { asOf: OPENING_AS_OF },
    debts: [],
    plan: LmGroups.groupPlan({
      defaults: { targetBuffer: 500 },
      startingCash: {
        breakdown: [
          { id: 'chequing-a', value: OPENING_BILLS, label: 'BILLS ACCOUNT', class: 'spendable' },
          { id: 'chequing-b', value: WEEKLY, label: 'WEEKLY SPENDING', class: 'spendable' },
          { id: 'savings', value: SAVINGS, label: 'EMERGENCY SAVING', class: 'spendable' },
        ],
      },
      opening: { asOf: OPENING_AS_OF, representedEvents: [] },
      income: [payrollStream()],
      bills: [],
      obligations: [],
      commitments: [],
      budget: { categories: [] },
    }),
  };
}

function gapTransactions(extra) {
  return [
    {
      id: 'gap-a',
      date: '2026-08-21',
      amount: MOVEMENT_A,
      pending: false,
      accountRole: 'household-cash',
      atlasAccountId: 'chequing-a',
    },
    {
      id: 'gap-b',
      date: '2026-09-10',
      amount: MOVEMENT_B,
      pending: false,
      accountRole: 'household-cash',
      atlasAccountId: 'chequing-a',
    },
  ].concat(extra || []);
}

function actualsPacket(opts) {
  opts = opts || {};
  return LmGroups.groupPacket({
    schema: 'atlas-current-period-actuals/v1',
    coverageStart: opts.coverageStart || GAP_START,
    coverageThrough: opts.coverageThrough || PAYDAY,
    observationAsOf: opts.observationAsOf || PAYDAY,
    transactionCoverage: opts.transactionCoverage || 'complete',
    pendingCoverage: opts.pendingCoverage || 'complete',
    transactions: opts.transactions || gapTransactions(),
  }, canonicalPlan().plan);
}

function cashEvidence(id, canonicalValue, evidenceValue, evidenceDate) {
  const changed = !near(canonicalValue, evidenceValue);
  return {
    fact: 'posted-balance',
    status: changed ? 'CHANGE' : 'MATCH',
    canonicalTarget: 'cash:' + id,
    canonicalValue,
    evidenceValue,
    evidenceDate,
    dateRelation: changed ? 'canonical-older' : 'same-day',
    unknown: false,
  };
}

function reportFor(opts) {
  const observed = opts.observedBills;
  const asOf = opts.asOf;
  const fetchedAt = opts.fetchedAt;
  return {
    writesCanonicalState: false,
    fetchedAt,
    unmapped: [],
    mapped: [],
    representedEventCandidates: opts.represented || [],
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false },
    currentPeriodActuals: opts.actuals,
    reconciliation: {
      rows: [
        cashEvidence('chequing-a', OPENING_BILLS, observed, asOf),
        cashEvidence('chequing-b', WEEKLY, WEEKLY, asOf),
        cashEvidence('savings', SAVINGS, SAVINGS, asOf),
      ],
    },
  };
}

function overlay(opts) {
  const data = canonicalPlan();
  const before = JSON.stringify(data);
  const result = Live.overlayLiveState({
    data,
    report: reportFor(opts),
  });
  return { data, before, result };
}

function published(overlaid) {
  const plan = overlaid.plan;
  const asOf = overlaid.meta && overlaid.meta.asOf;
  const overlayMeta = overlaid.liveOverlay || {};
  const advice = Forecast.recommend(plan, asOf, {
    debts: [],
    targetBuffer: 500,
    currentPeriodActuals: overlayMeta.currentPeriodActuals || null,
    operatingPlan: overlayMeta.operatingPlan,
  });
  const alloc = advice && advice.paydayAllocation;
  const view = advice && advice.defaultView;
  const period = ((view && view.calendarPeriods) || []).find(row => row && row.role === 'active');
  return {
    advice,
    alloc: alloc && alloc.liveCurrentBalance,
    view: view && view.liveCurrentBalance,
    period: period && period.liveCurrentBalance,
    publication: (alloc && alloc.currentBalancePublication)
      || (view && view.currentBalancePublication),
    active: period || null,
  };
}

function handWalk(transactions) {
  let balance = OPENING_BILLS;
  for (const tx of transactions || []) {
    if (!tx || tx.pending === true) continue;
    if (tx.atlasAccountId !== 'chequing-a') continue;
    if (String(tx.date) < GAP_START || String(tx.date) > GAP_THROUGH) continue;
    const debit = Number(tx.amount);
    balance = add(balance, -debit);
  }
  return balance;
}

const composer = loadComposer();
const midnight = '2026-09-25T07:00:01.000Z';

console.log('=== 0. Fixture arithmetic is independent of Forecast ===');
{
  ok(near(movementDebit, 250), 'synthetic gap debits total 250', String(movementDebit));
  ok(near(walkedBase, 750), 'hand walk is the synthetic opening minus those debits', String(walkedBase));
  ok(near(assumed, 4750) && near(doubled, 8750),
    'hand assumption is 4750 and adding payroll again is 8750', String(assumed));
  ok(!/data\.json/.test(payrollStream().label) && payrollStream().amount === PAYROLL,
    'the payroll stream is the fixture value');
  ok(Forecast.financialDate(midnight) === PAYDAY,
    'payday midnight PT is the household payday');
  ok(Forecast.spendingCycle(canonicalPlan().plan, PAYDAY).start === PAYDAY,
    '2026-09-25 is the Seaspan cycle start for the synthetic anchor');
  const walked = Forecast.postedAccountMovements(canonicalPlan().plan, 'chequing-a', {
    start: GAP_START,
    through: GAP_THROUGH,
  }, { currentPeriodActuals: actualsPacket() });
  const movementSum = (walked.movements || []).reduce((s, row) => add(s, row.amount), 0);
  ok(walked.complete === true && near(add(OPENING_BILLS, movementSum), handWalk(gapTransactions())),
    'postedAccountMovements agrees with the hand walk', String(movementSum));
}

console.log('\n=== a. Payday midnight, deposit not yet posted ===');
{
  const txs = gapTransactions();
  const { data, before, result } = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: walkedBase,
    actuals: actualsPacket({ transactions: txs }),
  });
  const next = result.data;
  const base = next.plan.opening.prePaydayBillsBase;
  const pub = published(next);
  ok(JSON.stringify(data) === before, 'overlay does not mutate the canonical input');
  ok(repoHash === crypto.createHash('sha256').update(fs.readFileSync(DATA)).digest('hex'),
    'data.json bytes are unchanged');
  ok(base && near(base.amount, handWalk(txs)) && base.coverageComplete === true
      && base.fromAsOf === OPENING_AS_OF && base.through === GAP_THROUGH
      && base.payday === PAYDAY && base.accountId === 'chequing-a',
    'in-memory base is the walked pre-payday BILLS stock', JSON.stringify(base));
  ok(near(cashRow(next, 'chequing-a').value, walkedBase)
      && near(cashRow(data, 'chequing-a').value, OPENING_BILLS),
    'the BILLS row is the same-day observation; the synthetic opening stays');
  ok(next.plan.opening.asOf === PAYDAY && next.plan.opening.priorAsOf === OPENING_AS_OF,
    'live cutover still stamps the fetch date');
  ok(near(pub.alloc, assumed) && near(pub.view, assumed) && near(pub.period, assumed),
    'Current Balance is walked base plus planned payroll', String(pub.alloc));
  ok(pub.publication && pub.publication.status === 'planned-dale-payday'
      && near(pub.publication.prePaydayBills, walkedBase)
      && near(pub.publication.assumedDalePayroll, PAYROLL)
      && pub.publication.providerConfirmed === false
      && pub.publication.note === payrollNote,
    'the publication is the planned Dale payday result');
  ok(!near(pub.alloc, doubled) && near(pub.publication.prePaydayBills, walkedBase),
    'planned payroll is added once, to the walked base');
  const html = composer.liveCurrentBalanceHtml(
    { liveCurrentBalance: pub.view, currentBalancePublication: pub.publication },
    null,
    { liveCurrentBalance: pub.alloc, currentBalancePublication: pub.publication }
  );
  ok(html.includes(composer.money2(assumed)) && html.includes(pub.publication.note),
    'the Budget page reprints the Forecast figure and note');
  const active = pub.active || {};
  ok(near(active.incomeTotal, PAYROLL) && near(active.available, active.incomeTotal)
      && !near(active.available, assumed)
      && near(active.balanceAfterDeductions, active.incomeTotal),
    'Payday balance and Balance After Deductions stay the income identity',
    String(active.available) + ' / ' + String(active.balanceAfterDeductions));
  const notRelied = (next.plan.opening.notReliedUponEvents || [])
    .some(row => row && row.id === 'payroll' && row.date === PAYDAY);
  ok(notRelied, 'unrepresented Seaspan payroll stays on notReliedUponEvents');
  const stripped = clone(next);
  delete stripped.plan.opening.prePaydayBillsBase;
  const without = published(stripped);
  ok(without.alloc == null && without.publication.status === 'unavailable',
    'without the retain the same refresh still fails closed', String(without.alloc));
}

console.log('\n=== b. Deposit landed, not yet recognised as Seaspan payroll ===');
{
  const landed = assumed;
  const { result } = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: landed,
    actuals: actualsPacket(),
  });
  const next = result.data;
  const pub = published(next);
  ok(near(cashRow(next, 'chequing-a').value, landed),
    'the refreshed BILLS row already includes the deposit', String(cashRow(next, 'chequing-a').value));
  ok(near(next.plan.opening.prePaydayBillsBase.amount, walkedBase),
    'the retain is still the pre-deposit walk');
  ok(!(next.plan.opening.representedEvents || []).some(row => row && row.id === 'payroll' && row.date === PAYDAY),
    'payroll is not represented');
  ok(near(pub.alloc, assumed) && near(pub.view, assumed)
      && pub.publication.status === 'planned-dale-payday',
    'Current Balance stays walked base plus planned payroll', String(pub.alloc));
  ok(!near(pub.alloc, add(landed, PAYROLL)) && !near(pub.alloc, doubled),
    'planned payroll is not added to the refreshed balance');
}

console.log('\n=== c. Incomplete gap-day coverage fails closed ===');
{
  const { result } = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: walkedBase,
    actuals: actualsPacket({ coverageStart: '2026-08-21' }),
  });
  const next = result.data;
  const pub = published(next);
  ok(!next.plan.opening.prePaydayBillsBase,
    'incomplete coverage stores no pre-payday base');
  ok(pub.alloc == null && pub.view == null && pub.period == null
      && pub.publication.status === 'unavailable',
    'Current Balance is unavailable', String(pub.alloc));
  const html = composer.liveCurrentBalanceHtml(
    { liveCurrentBalance: pub.view, currentBalancePublication: pub.publication },
    null,
    { liveCurrentBalance: pub.alloc, currentBalancePublication: pub.publication }
  );
  ok(html.includes('—') && !html.includes(composer.money2(assumed))
      && !/awaiting bank update/.test(html),
    'the page prints an em dash');
  const truncated = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: walkedBase,
    actuals: actualsPacket({ transactionCoverage: 'incomplete' }),
  });
  const truncatedPub = published(truncated.result.data);
  ok(!truncated.result.data.plan.opening.prePaydayBillsBase
      && truncatedPub.alloc == null,
    'truncated posted coverage also stores nothing');
}

console.log('\n=== d. Recognised deposit is observed BILLS cash ===');
{
  const observed = 4500.15;
  const { result } = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: observed,
    represented: [{ id: 'payroll', date: PAYDAY }],
    actuals: actualsPacket(),
  });
  const next = result.data;
  const pub = published(next);
  ok((next.plan.opening.representedEvents || []).some(row => row && row.id === 'payroll' && row.date === PAYDAY),
    'payroll is represented');
  ok(near(pub.alloc, observed) && near(pub.view, observed)
      && pub.publication.status === 'provider-confirmed'
      && pub.publication.assumedDalePayroll == null
      && !pub.publication.note,
    'observed BILLS cash replaces the assumption', String(pub.alloc));
  ok(!near(pub.alloc, add(observed, PAYROLL)) && !near(pub.alloc, assumed),
    'planned payroll is not added to the recognised balance');
}

console.log('\n=== e. Non-payday behaviour is unchanged ===');
{
  const observed = 200.5;
  const cases = [
    ['2026-09-24', '2026-09-24T07:00:01.000Z', 'the day before payday'],
    ['2026-09-15', '2026-09-15T07:00:01.000Z', 'Amanda salary day'],
    ['2026-09-20', '2026-09-20T07:00:01.000Z', 'child-benefit day'],
  ];
  for (const [asOf, fetchedAt, label] of cases) {
    const { result } = overlay({
      asOf,
      fetchedAt,
      observedBills: observed,
      actuals: actualsPacket({
        coverageThrough: asOf,
        observationAsOf: asOf,
      }),
    });
    const next = result.data;
    const pub = published(next);
    ok(Forecast.financialDate(fetchedAt) === asOf, label + ' fetch date');
    ok(Forecast.spendingCycle(next.plan, asOf).start !== asOf, label + ' is not the cycle start');
    ok(!next.plan.opening.prePaydayBillsBase, label + ' does not retain a payday base');
    ok(near(pub.alloc, observed) && pub.publication.status === 'provider-confirmed'
        && pub.publication.assumedDalePayroll == null,
      label + ' publishes the posted BILLS row', String(pub.alloc));
  }
}

console.log('\n=== f. Adding payroll to the refreshed balance stays impossible ===');
{
  const landed = assumed;
  const { result } = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: landed,
    actuals: actualsPacket({
      transactions: gapTransactions([{
        id: 'unlisted-deposit',
        date: PAYDAY,
        amount: -PAYROLL,
        pending: false,
        accountRole: 'household-cash',
        atlasAccountId: 'chequing-a',
      }]),
    }),
  });
  const next = result.data;
  const pub = published(next);
  ok(near(pub.alloc, assumed) && !near(pub.alloc, doubled) && !near(pub.alloc, add(landed, PAYROLL)),
    'a payday deposit movement is not added again on top of the walk', String(pub.alloc));
  ok(near(pub.publication.prePaydayBills, walkedBase),
    'the base excludes the payday deposit');
  const forged = clone(next);
  forged.plan.opening.prePaydayBillsBase = {
    payday: PAYDAY,
    accountId: 'chequing-a',
    amount: landed,
    fromAsOf: PAYDAY,
    through: GAP_THROUGH,
    coverageComplete: true,
  };
  const forgedPub = published(forged);
  ok(forgedPub.alloc == null || !near(forgedPub.alloc, add(landed, PAYROLL)),
    'a same-day fromAsOf is not a pre-payday base');
  const incompleteFlag = clone(next);
  incompleteFlag.plan.opening.prePaydayBillsBase.coverageComplete = false;
  const flagged = published(incompleteFlag);
  ok(flagged.alloc == null, 'coverageComplete false fails closed');
}

console.log('\n=== g. Same-day non-payroll debit is in Current Balance ===');
{
  const expected = add(add(walkedBase, -SAME_DAY_DEBIT), PAYROLL);
  const observed = add(walkedBase, -SAME_DAY_DEBIT);
  const { result } = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: observed,
    actuals: actualsPacket({
      transactions: gapTransactions([
        paydayMovement('same-day-debit', SAME_DAY_DEBIT, 'CITY UTILITY'),
      ]),
    }),
  });
  const next = result.data;
  const pub = published(next);
  ok(near(next.plan.opening.prePaydayBillsBase.amount, walkedBase),
    'the retain still stops at the day before payday');
  ok(near(cashRow(next, 'chequing-a').value, observed),
    'the refreshed row includes the debit and not the planned payroll');
  ok(near(pub.alloc, expected) && near(pub.view, expected)
      && near(pub.publication.prePaydayBills, observed)
      && pub.publication.status === 'planned-dale-payday',
    'Current Balance is walked base plus the debit plus planned payroll', String(pub.alloc));
  ok(!near(pub.alloc, assumed) && !near(pub.alloc, observed)
      && !near(pub.alloc, add(expected, PAYROLL)),
    'the debit is not dropped and payroll is not added twice');
}

console.log('\n=== h. Same-day labelled refund is in Current Balance ===');
{
  // #426 counted an unlabelled 40 credit as ordinary and published
  // base + 40 + payroll. An unlabelled credit now fails closed. This
  // fixture keeps that counted result by setting categoryLabel Refund,
  // the existing REFUND_LABELS identity. displayedPayee is not that label.
  const expected = add(add(walkedBase, SAME_DAY_CREDIT), PAYROLL);
  const observed = add(walkedBase, SAME_DAY_CREDIT);
  const { result } = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: observed,
    actuals: actualsPacket({
      transactions: gapTransactions([
        paydayMovement('same-day-credit', -SAME_DAY_CREDIT, 'CITY REFUND', {
          categoryLabel: 'Refund',
        }),
      ]),
    }),
  });
  const pub = published(result.data);
  ok(near(pub.alloc, expected) && near(pub.publication.prePaydayBills, observed)
      && pub.publication.status === 'planned-dale-payday',
    'Current Balance is walked base plus the labelled refund plus planned payroll',
    String(pub.alloc));
  ok(!near(pub.alloc, assumed) && !near(pub.alloc, add(add(observed, PAYROLL), PAYROLL)),
    'the labelled refund is not dropped and payroll is not added twice');
}

console.log('\n=== i. Unclassifiable same-day credits fail closed ===');
{
  const hole = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: walkedBase,
    actuals: actualsPacket({ coverageThrough: GAP_THROUGH }),
  });
  const holePub = published(hole.result.data);
  ok(hole.result.data.plan.opening.prePaydayBillsBase
      && holePub.alloc == null && holePub.publication.status === 'unavailable',
    'a packet that does not cover payday fails closed', String(holePub.alloc));
  const two = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: assumed,
    actuals: actualsPacket({
      transactions: gapTransactions([
        paydayMovement('deposit-a', -PAYROLL, 'SEASPAN PAY'),
        paydayMovement('deposit-b', -(PAYROLL - 10), 'SEASPAN PAY'),
      ]),
    }),
  });
  const twoPub = published(two.result.data);
  ok(twoPub.alloc == null && !near(twoPub.alloc, add(assumed, PAYROLL)),
    'two Seaspan-like credits fail closed instead of being ordinary income');
}

console.log('\n=== j. Ambiguous same-day inflows fail closed ===');
{
  const offPlan = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: add(walkedBase, OFF_PLAN_DEPOSIT),
    actuals: actualsPacket({
      transactions: gapTransactions([
        paydayMovement('off-plan', -OFF_PLAN_DEPOSIT),
      ]),
    }),
  });
  const offPub = published(offPlan.result.data);
  const offDouble = add(add(walkedBase, OFF_PLAN_DEPOSIT), PAYROLL);
  ok(offPub.alloc == null && offPub.publication.status === 'unavailable'
      && !near(offPub.alloc, offDouble) && !near(offPub.alloc, assumed),
    'an off-plan unrecognised deposit fails closed', String(offPub.alloc));
  const offPlanText = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: add(walkedBase, OFF_PLAN_DEPOSIT),
    actuals: actualsPacket({
      transactions: gapTransactions([
        paydayMovement('off-plan-text', -OFF_PLAN_DEPOSIT, 'SEASPAN PAY'),
      ]),
    }),
  });
  const offTextPub = published(offPlanText.result.data);
  ok(offTextPub.alloc == null && offTextPub.publication.status === 'unavailable',
    'Seaspan text does not make an off-plan deposit the payroll', String(offTextPub.alloc));

  const split = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: add(add(walkedBase, SPLIT_A), SPLIT_B),
    actuals: actualsPacket({
      transactions: gapTransactions([
        paydayMovement('split-a', -SPLIT_A),
        paydayMovement('split-b', -SPLIT_B),
      ]),
    }),
  });
  const splitPub = published(split.result.data);
  const splitDouble = add(add(add(walkedBase, SPLIT_A), SPLIT_B), PAYROLL);
  ok(splitPub.alloc == null && splitPub.publication.status === 'unavailable'
      && !near(splitPub.alloc, splitDouble),
    'a split deposit fails closed', String(splitPub.alloc));

  const small = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: add(walkedBase, SAME_DAY_CREDIT),
    actuals: actualsPacket({
      transactions: gapTransactions([
        paydayMovement('unlabelled-small', -SAME_DAY_CREDIT, 'CITY CREDIT'),
      ]),
    }),
  });
  const smallPub = published(small.result.data);
  ok(smallPub.alloc == null && smallPub.publication.status === 'unavailable'
      && !near(smallPub.alloc, add(add(walkedBase, SAME_DAY_CREDIT), PAYROLL)),
    'an unlabelled small same-day credit fails closed', String(smallPub.alloc));
}

console.log('\n=== k. Proven household transfer is an ordinary credit ===');
{
  const expected = add(add(walkedBase, NEAR_PAYROLL), PAYROLL);
  const observed = add(walkedBase, NEAR_PAYROLL);
  const { result } = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: observed,
    actuals: actualsPacket({
      transactions: gapTransactions(householdTransferIntoBills(NEAR_PAYROLL)),
    }),
  });
  const next = result.data;
  const packet = next.liveOverlay && next.liveOverlay.currentPeriodActuals;
  const walked = Forecast.postedAccountMovements(next.plan, 'chequing-a', {
    start: PAYDAY, through: PAYDAY,
  }, { currentPeriodActuals: packet });
  const inflow = (walked.movements || []).find(row => row && row.id === 'tfr-bills-in');
  ok(inflow && inflow.internalTransfer === true
      && inflow.classification === 'internal-transfer'
      && inflow.counterpartAccountId === 'chequing-b'
      && near(inflow.amount, NEAR_PAYROLL),
    'the near-payroll inflow is a proven transfer from chequing-b',
    inflow ? inflow.classification : 'missing');
  const pub = published(next);
  ok(near(pub.alloc, expected) && near(pub.view, expected)
      && near(pub.publication.prePaydayBills, observed)
      && pub.publication.status === 'planned-dale-payday',
    'Current Balance counts the household transfer plus planned payroll',
    String(pub.alloc));
  ok(!near(pub.alloc, assumed) && !near(pub.alloc, add(expected, PAYROLL)),
    'the transfer is not dropped and payroll is not added twice');
}

console.log('\n=== l. Unlabelled near-payroll inflow is the residual deposit ===');
{
  // Same amount as k, with no TFR pair and no refund category. It is inside
  // the 1% window, so it is excluded and planned payroll is added once.
  // That understates the posted transfer until a positive non-income label
  // exists. It does not double-count.
  const dropped = assumed;
  const counted = add(add(walkedBase, NEAR_PAYROLL), PAYROLL);
  const { result } = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: add(walkedBase, NEAR_PAYROLL),
    actuals: actualsPacket({
      transactions: gapTransactions([
        paydayMovement('near-unlabelled', -NEAR_PAYROLL),
      ]),
    }),
  });
  const pub = published(result.data);
  ok(near(pub.alloc, dropped) && near(pub.publication.prePaydayBills, walkedBase)
      && pub.publication.status === 'planned-dale-payday',
    'an unlabelled near-payroll inflow is excluded as the deposit',
    String(pub.alloc));
  ok(!near(pub.alloc, counted) && !near(pub.alloc, add(dropped, PAYROLL)),
    'excluding it does not also add the inflow or a second payroll');
}

console.log('\n=== m. A retain with no transaction packet fails closed ===');
{
  const { result } = overlay({
    asOf: PAYDAY,
    fetchedAt: midnight,
    observedBills: walkedBase,
    actuals: actualsPacket(),
  });
  const next = result.data;
  ok(next.plan.opening.prePaydayBillsBase
      && near(next.plan.opening.prePaydayBillsBase.amount, walkedBase),
    'the retain is present before the packet is removed');
  const withPacket = published(next);
  ok(near(withPacket.alloc, assumed),
    'the same retain with its packet still publishes base plus payroll',
    String(withPacket.alloc));
  const bare = Forecast.recommend(next.plan, PAYDAY, {
    debts: [],
    targetBuffer: 500,
  });
  const bareAlloc = bare.paydayAllocation && bare.paydayAllocation.liveCurrentBalance;
  const bareView = bare.defaultView && bare.defaultView.liveCurrentBalance;
  const bareStatus = bare.paydayAllocation
    && bare.paydayAllocation.currentBalancePublication
    && bare.paydayAllocation.currentBalancePublication.status;
  ok(bareAlloc == null && bareView == null && bareStatus === 'unavailable'
      && !near(bareAlloc, assumed),
    'a retained base with no transaction packet is unavailable', String(bareAlloc));
}

console.log('\n=== n. Payroll-sized refund label fails closed ===');
{
  // A Refund category on a credit inside 1% of planned payroll is not an
  // ordinary credit. Counting it and adding payroll doubles that cash.
  // 4035 is 35 away from 4000; the window is 40. A small Refund stays
  // section h. A proven transfer inside the window stays section k.
  function refundCase(amount, id) {
    const run = overlay({
      asOf: PAYDAY,
      fetchedAt: midnight,
      observedBills: add(walkedBase, amount),
      actuals: actualsPacket({
        transactions: gapTransactions([
          paydayMovement(id, -amount, 'CITY REFUND', { categoryLabel: 'Refund' }),
        ]),
      }),
    });
    return published(run.result.data);
  }
  for (const amount of [PAYROLL, 4035]) {
    const pub = refundCase(amount, 'refund-near-' + amount);
    const doubled = add(add(walkedBase, amount), PAYROLL);
    ok(pub.alloc == null && pub.view == null && pub.publication.status === 'unavailable'
        && !near(pub.alloc, doubled) && !near(pub.alloc, assumed),
      'a refund-labelled credit of ' + amount + ' fails closed', String(pub.alloc));
  }
}

if (failures) {
  console.log('\nFAILED ' + failures);
  process.exit(1);
}
console.log('\nALL PASS');
