'use strict';
/* A card balance older than the card's current statement cycle is estimated.
 *
 * Lead dispatch T2 (2026-11-18): a stale manual card balance (Triangle and
 * MBNA are hand-entered Lunch Money accounts) was used as if current. Rule,
 * stated once in Forecast.cardBalanceFreshness: the card's current statement
 * cycle starts on its latest statement close day on or before the as-of day;
 * a balance dated before that start is stale. A stale balance is still the
 * best figure known, so it stays, tagged estimated with its date, wherever it
 * feeds a figure. Nothing becomes more certain. A current balance is untouched.
 *
 * Invented data only. Hand-derived cycle starts:
 *   as-of 2026-11-18, close day 17 -> 2026-11-17 (this month's close has passed)
 *   as-of 2026-11-18, close day 20 -> 2026-10-20 (previous month)
 *   as-of 2026-03-01, close day 31 -> 2026-02-28 (short month clamps)
 *   as-of 2026-01-05, close day 10 -> 2025-12-10 (across the year)
 *
 * `node test/test-stale-card-balance-estimated.js`
 */
const F = require('../public/forecast.js');
const Live = require('../scripts/live-plan');
const source = require('./fixtures/card-backfill-data');

let failures = 0;
const ok = (cond, label, detail) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' — ' + detail : ''}`);
};

console.log('=== the rule: statement cycle start and stale ===');
{
  const card = (balanceAsOf, statementCloseDay) => ({ id: 'c', label: 'Invented card', balance: 100, secured: false,
    statementCloseDay, ...(balanceAsOf ? { balanceAsOf } : {}) });
  const cases = [
    ['2026-11-18', 17, '2026-11-17'], ['2026-11-18', 20, '2026-10-20'],
    ['2026-03-01', 31, '2026-02-28'], ['2026-01-05', 10, '2025-12-10'],
  ];
  for (const [asOf, day, start] of cases) {
    const before = F.cardBalanceFreshness(card('2000-01-01', day), {}, asOf);
    ok(before && before.cycleStart === start, `as-of ${asOf}, close day ${day}: the cycle starts ${start}`, before && before.cycleStart);
  }
  const stale = F.cardBalanceFreshness(card('2026-11-16', 17), {}, '2026-11-18');
  ok(stale && stale.status === 'stale' && stale.trust === 'estimated' && stale.balanceAsOf === '2026-11-16',
    'a balance dated the day before the close is stale, estimated, with its date');
  ok(F.cardBalanceFreshness(card('2026-11-17', 17), {}, '2026-11-18') === null,
    'a balance dated on the close day is current: no tag');
  ok(F.cardBalanceFreshness(card(null, 17), { opening: { asOf: '2026-11-18' } }, '2026-11-18') === null,
    'an undated card balance takes the plan opening date (current here)');
  ok(F.cardBalanceFreshness(card(null, 17), { opening: { asOf: '2026-11-01' } }, '2026-11-18')?.balanceAsOf === '2026-11-01',
    'an undated card balance recorded at an older opening is stale, with the opening date');
  ok(F.cardBalanceFreshness({ id: 'm', balance: 1, secured: true, statementCloseDay: 17, balanceAsOf: '2020-01-01' }, {}, '2026-11-18') === null
    && F.cardBalanceFreshness({ id: 'h', balance: 1, balanceAsOf: '2020-01-01' }, {}, '2026-11-18') === null,
    'a secured debt, or one with no statement close day, is not assessed');
}

console.log('\n=== the live refresh stamps each card balance date; a stale manual balance is estimated ===');
{
  // card-backfill-data: invented card, statement close day 17, live as-of 2026-09-20,
  // so the current cycle started 2026-09-17.
  const world = stale => {
    const x = source();
    if (stale) {
      // Canonical opening 2026-09-15; the hand-entered card balance says 450 as of 2026-09-16:
      // newer than the opening, so the refresh applies it, but older than this cycle.
      x.data.meta.asOf = x.data.plan.opening.asOf = '2026-09-15';
      x.payload.transactionWindow.startDate = '2026-09-15';
      const card = x.payload.accounts[3];
      card.balance = 450;
      delete card.balance_last_update;
      card.balance_as_of = card.updated_at = '2026-09-16T12:00:00Z';
    }
    return Live.fromObservation(x);
  };
  const current = world(false);
  const cardNow = current.data.debts[0];
  ok(current.data.liveOverlay.applied === true && cardNow.balanceAsOf === '2026-09-20',
    'current: the card balance is stamped with its same-day evidence date', cardNow.balanceAsOf);
  const utilNow = F.utilisation(current.data.debts, [], current.data.plan);
  ok(!Object.hasOwn(utilNow.rows[0], 'balanceTrust') && !Object.hasOwn(utilNow, 'totalAvailableTrust'),
    'current: credit used and available carry no estimate tag');

  const stale = world(true);
  const cardOld = stale.data.debts[0];
  ok(stale.data.liveOverlay.applied === true && cardOld.balance === 450 && cardOld.balanceAsOf === '2026-09-16'
    && stale.data.plan.opening.asOf === '2026-09-20',
    'stale: the overlaid manual balance keeps its own date, not the advanced opening', `${cardOld.balance} @ ${cardOld.balanceAsOf}`);
  const util = F.utilisation(stale.data.debts, [], stale.data.plan);
  const row = util.rows[0];
  ok(row.posted === 450 && row.used === 450 && row.available === 1550,
    'stale: the figure is still the best known balance (2000 limit − 450 used = 1550 available)', row.available);
  ok(row.balanceTrust === 'estimated' && row.balanceAsOf === '2026-09-16' && /2026-09-16/.test(row.balanceReason),
    'stale: that card row is tagged estimated and shows its date');
  ok(util.totalAvailableTrust === 'estimated' && util.totalAvailableEstimatedFrom.join() === 'travelvisa',
    'stale: credit left everywhere is estimated, naming the stale card');
  ok(!/"(verified|confirmed)"/.test(JSON.stringify(row)), 'stale: nothing on the row claims more certainty');

  // The assistant packet reprints the same tag and date; it never says calculated for it.
  const Assistant = require('../scripts/assistant-packet');
  const packet = d => Assistant.buildPacket({ data: d, periods: { periods: {} }, questionsMarkdown: '',
    env: {}, now: '2026-09-20T19:00:00Z' });
  const text = JSON.stringify(packet(stale.data));
  ok(/"id":"travelvisa"[^}]*"trust":"estimated","balanceAsOf":"2026-09-16"/.test(text)
    && !/"id":"travelvisa"[^}]*"posted":450[^}]*"trust":"calculated"/.test(text),
    'stale: the assistant packet card row is estimated with its date');
  ok(/"kind":"stale-balance","balanceAsOf":"2026-09-16","trust":"estimated"/.test(text),
    'stale: the packet lists the card among stale or manual accounts');
  const nowText = JSON.stringify(packet(current.data));
  ok(!/stale-balance/.test(nowText) && /"id":"travelvisa"[^}]*"trust":"calculated"/.test(nowText),
    'current: the packet card row stays calculated and is not listed as stale');
}

console.log('\n=== Forecast: the card list, the extra-debt lines and the Road Ahead debt picture ===');
{
  // Invented world (from test-baseline-trajectory-extra-debt-attribution.js): Triangle
  // $200 at 19.99% and MBNA $5,000 at 12.99%, $1,000 a month extra, both verified.
  const plan = () => ({
    windowDays: 91, startingCash: { amount: 20000 },
    defaults: { targetBuffer: 0, extraDebtMonthly: 1000 },
    income: [{ id: 'payroll', label: 'Seaspan', frequency: 'biweekly', anchor: '2026-01-02', amount: 2600, confidence: 'confirmed' }],
    obligations: [], bills: [], commitments: [],
    budget: { basis: 'ytd', categories: [{ id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 140 }] },
    opening: { asOf: '2026-01-01' },
    nextDollar: { policy: 'true-surplus-highest-interest', eligibleDebts: 'revolving-cards-and-heloc', provenance: 'owner-stated' },
  });
  // Triangle closes on the 17th: as-of 2026-01-01 its cycle started 2025-12-17.
  const debts = triangleAsOf => [
    { id: 'tri', label: 'Triangle Mastercard', structure: 'Revolving card', balance: 200, pending: 0, rate: 19.99,
      minimumPayment: 25, paymentDay: 15, confidence: 'verified', statementCloseDay: 17, balanceAsOf: triangleAsOf },
    { id: 'mbna', label: 'MBNA Mastercard', structure: 'Revolving card', balance: 5000, pending: 0, rate: 12.99,
      minimumPayment: 100, paymentDay: 15, confidence: 'verified', statementCloseDay: 8, balanceAsOf: '2026-01-01' },
  ];
  const run = asOf => F.baselineTrajectory(plan(), debts(asOf), '2026-01-01', { weeklyVariable: 400 });
  const firstExtra = t => t.payPeriods.find(pp => pp.stage3 && pp.stage3.extras && pp.stage3.extras.amount > 0);
  const firstDebtMonth = t => (t.months || []).find(m => m && m.debt);

  const control = run('2025-12-20');
  ok(control.status === 'ready', 'control: the Road Ahead is ready');
  const cLines = firstExtra(control).stage3.extras.allocations;
  ok(cLines.length === 2 && cLines.every(l => l.status === 'calculated'),
    'control (both balances current): extra-debt lines stay calculated', JSON.stringify(cLines.map(l => l.status)));
  ok(firstDebtMonth(control).debt.status === 'calculated' && !Object.hasOwn(firstDebtMonth(control).debt, 'staleBalances'),
    'control: the monthly debt picture stays calculated');

  const stale = run('2025-12-10');
  const sLines = firstExtra(stale).stage3.extras.allocations;
  ok(sLines.map(l => l.amount).join() === cLines.map(l => l.amount).join(),
    'stale: the amounts are unchanged; only the tags move', JSON.stringify(sLines.map(l => l.amount)));
  ok(sLines.find(l => l.debtId === 'tri').status === 'estimated' && sLines.find(l => l.debtId === 'mbna').status === 'estimated',
    'stale Triangle: its line, and MBNA reached through it, are estimated');
  const month = firstDebtMonth(stale).debt;
  ok(month.status === 'estimated' && month.staleBalances.length === 1 && month.staleBalances[0].id === 'tri'
    && month.staleBalances[0].balanceAsOf === '2025-12-10',
    'stale Triangle: the monthly debt picture is estimated and names the balance date');

  const advice = asOf => F.recommend(plan(), '2026-01-01', { debts: debts(asOf), targetBuffer: 0 });
  const cards = a => (a.payPeriodViews || []).find(p => p && p.firstCard) || {};
  const nowCards = cards(advice('2025-12-20'));
  ok(nowCards.firstCard && !Object.hasOwn(nowCards.firstCard, 'balanceTrust')
    && (nowCards.otherCards || []).every(c => !Object.hasOwn(c, 'balanceTrust')),
    'control: the card list carries no estimate tag');
  const oldCards = cards(advice('2025-12-10'));
  const all = [oldCards.firstCard, ...(oldCards.otherCards || [])];
  const tri = all.find(c => c && c.id === 'tri');
  const mbna = all.find(c => c && c.id === 'mbna');
  ok(tri && tri.balance === 200 && tri.balanceTrust === 'estimated' && tri.balanceAsOf === '2025-12-10',
    'stale Triangle: the card list shows it estimated, with its date');
  ok(mbna && !Object.hasOwn(mbna, 'balanceTrust'), 'current MBNA stays untagged');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll stale-card-balance checks passed.');
