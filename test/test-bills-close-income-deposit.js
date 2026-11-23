'use strict';
// H2-8a (Gemini hunt 2, #821 7091517953): the Bills-only ending balance counts only income that lands in Bills.
// Forecast's one home for which household account a scheduled income stream lands in is incomeDepositAccountId: the
// Canada Child Benefit lands in Weekly (chequing-b, CHILD_BENEFIT_ACCOUNT_ID); every other stream lands in Bills, as
// Forecast has always assumed for scheduled income. Proved through the published packet figure
// (forecast.payPeriodTotals.periods[0].billsEndingBalance), not only the engine function.
// `node test/test-bills-close-income-deposit.js`
//
// Failure it detects: the Bills-only close (billsAccountPeriodBalance / the packet's billsEndingBalance) adding child
// benefit that lands in Weekly; a CCB amount it never counts withholding it; Bills-landing income dropped.
// Release decision: any failure blocks.
//
// World: test/fixtures/bills-period-end-balance-data.js (invented). Hand-derived there: closing = 1373.29 + 643.17
// - 93.41 - 27.19 - 160.51 = 1735.35, future income 643.17 (the partner salary on the 25th; the period is
// 2026-08-14..2026-08-27, viewed 2026-08-20).
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const Assistant = require('../scripts/assistant-packet');
const fx = require('./fixtures/bills-period-end-balance-data');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const cents = v => Math.round(Number(v) * 100);
const stream = (id, amount) => ({ id, label: 'Invented ' + id, frequency: 'monthly', day: 25, amount, confidence: 'confirmed' });
const world = extra => { const data = fx.served(); if (extra) data.plan.income.push(extra); return data; };
const engine = data => F.billsAccountPeriodBalance(data.plan, fx.AS_OF, { currentPeriodActuals: data.liveOverlay.currentPeriodActuals,
  debts: data.debts, observedCash: data.liveOverlay.observedCash });
const published = data => {
  const section = Assistant.buildPacket({ data, periods: null, questionsMarkdown: '' }).forecast.payPeriodTotals;
  return section && section.status === 'ok' ? section.periods[0].billsEndingBalance : null;
};

console.log('1. Control: the world as built');
const base = published(world());
ok(base && base.status === 'ok' && cents(base.amount) === cents(1735.35) && cents(base.terms.futureIncome) === cents(643.17),
  'the published Bills ending balance is 1735.35 with future income 643.17 (hand-derived)', JSON.stringify(base));

console.log('2. A child benefit on the 25th lands in Weekly, not Bills');
const ccb = published(world(stream('childBenefit', 437.61)));
ok(ccb && ccb.status === 'ok' && cents(ccb.amount) === cents(1735.35) && cents(ccb.terms.futureIncome) === cents(643.17),
  'published: the Bills ending balance stays 1735.35 and future income 643.17 (the 437.61 child benefit is not Bills cash)',
  JSON.stringify(ccb));
const ccbEngine = engine(world(stream('childBenefit', 437.61)));
ok(ccbEngine.status === 'ready' && cents(ccbEngine.futureIncome) === cents(643.17) && cents(ccbEngine.amount) === cents(1735.35),
  'engine: billsAccountPeriodBalance agrees', JSON.stringify({ s: ccbEngine.status, f: ccbEngine.futureIncome, a: ccbEngine.amount }));
const unknown = published(world(stream('childBenefit', null)));
ok(unknown && unknown.status === 'ok' && cents(unknown.amount) === cents(1735.35),
  'a child benefit of unknown amount does not withhold the Bills close it never enters', JSON.stringify(unknown));

console.log('3. Control: the same income on a Bills-landing stream still counts');
const other = published(world(stream('invented-bonus', 437.61)));
ok(other && other.status === 'ok' && cents(other.terms.futureIncome) === cents(643.17 + 437.61) && cents(other.amount) === cents(1735.35 + 437.61),
  'an otherwise identical stream that lands in Bills adds 437.61: future income 1080.78, closing 2172.96', JSON.stringify(other));

console.log('4. On the benefit\'s scheduled day (review 7093681543): routed by account before the same-day guard');
{
  const sameDay = (id, amount) => ({ ...stream(id, amount), day: 20 });
  const ccbToday = published(world(sameDay('childBenefit', 437.61)));
  ok(ccbToday && ccbToday.status === 'ok' && cents(ccbToday.amount) === cents(1735.35),
    'published: a child benefit dated the as-of day neither adds to nor withholds the Bills close', JSON.stringify(ccbToday));
  const billsToday = engine(world(sameDay('invented-bonus', 437.61)));
  ok(billsToday.status === 'unavailable' && billsToday.issues.some(i => i.code === 'same-day-income-unconfirmed'),
    'control: Bills-landing income dated the as-of day still withholds (the incumbent same-day guard)', JSON.stringify(billsToday.issues));
  const billsTodayPublished = published(world(sameDay('invented-bonus', 437.61)));
  ok(!billsTodayPublished || billsTodayPublished.status !== 'ok', 'control, published: that Bills close is not published as ok', JSON.stringify(billsTodayPublished));
}

console.log('5. Supplemental income events follow the same account boundary');
{
  const extraOpts = id => { const data = world(); return F.billsAccountPeriodBalance(data.plan, fx.AS_OF, {
    currentPeriodActuals: data.liveOverlay.currentPeriodActuals, debts: data.debts, observedCash: data.liveOverlay.observedCash,
    additionalIncomeEvents: [{ kind: 'income', id, date: '2026-08-25', amount: null }] }); };
  const ccbExtra = extraOpts('childBenefit');
  ok(ccbExtra.status === 'ready' && cents(ccbExtra.amount) === cents(1735.35),
    'a supplemental child-benefit event of unknown amount does not withhold the Bills close', JSON.stringify(ccbExtra.issues));
  const billsExtra = extraOpts('invented-bonus');
  ok(billsExtra.status === 'unavailable' && billsExtra.issues.some(i => i.code === 'income-unavailable'),
    'control: a supplemental Bills-landing event of unknown amount still withholds', JSON.stringify(billsExtra.issues));
}

console.log(`Bills close income deposit account: ${checks} checks passed`);
