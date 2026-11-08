'use strict';
/* Forecast.paydayAllocation itemization — independent proof.
 *
 * Synthetic fixtures only. Live household cents are not the specification
 * (L-006). Obligation sums are reconciled against Forecast.expandEvents;
 * essential sums against Forecast.budgetBreakdown. Represented/paid uses
 * the incumbent representedEvents + priorAsOf path, not a new settler.
 *
 * `node test/test-payday-reserve-detail.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) <= eps;
const MONTH = 365.25 / 12;
const AS_OF = '2026-09-10';
const NEXT_PAY = '2026-09-24';

function paydayComposer() {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const planSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8');
  const grab = (src, re, label) => {
    const m = re.exec(src);
    if (!m) throw new Error('missing ' + label);
    return m[0];
  };
  return vm.runInNewContext(
    [
      grab(appSrc, /^const money = .*$/m, 'money'),
      grab(appSrc, /^const money2 = .*$/m, 'money2'),
      grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
      grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
      grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
      grab(planSrc, /^const fmtMonth = .*$/m, 'fmtMonth'),
      grab(planSrc, /^function weeklyCapView\([\s\S]*?\n\}$/m, 'weeklyCapView'),
      grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
      grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
      grab(planSrc, /^function currentOperatingUnavailableHtml\([\s\S]*?\n\}$/m, 'currentOperatingUnavailableHtml'),
      grab(planSrc, /^function paydayActionRows\([\s\S]*?\n\}$/m, 'paydayActionRows'),
      grab(planSrc, /^function paydayOtherActionRows\([\s\S]*?\n\}$/m, 'paydayOtherActionRows'),
      grab(planSrc, /^function paydayReservedIds\([\s\S]*?\n\}$/m, 'paydayReservedIds'),
      grab(planSrc, /^function paydayComingRows\([\s\S]*?\n\}$/m, 'paydayComingRows'),
      grab(planSrc, /^function paydaySheet\([\s\S]*?\n\}$/m, 'paydaySheet'),
      grab(planSrc, /^function paydayCashNote\([\s\S]*?\n\}$/m, 'paydayCashNote'),
      grab(planSrc, /^function paydayObligationNote\([\s\S]*?\n\}$/m, 'paydayObligationNote'),
      grab(planSrc, /^function paydayCoverageNote\([\s\S]*?\n\}$/m, 'paydayCoverageNote'),
      grab(planSrc, /^function paydayBillStatusNote\([\s\S]*?\n\}$/m, 'paydayBillStatusNote'),
      grab(planSrc, /^function paydayAmountCell\([\s\S]*?\n\}$/m, 'paydayAmountCell'),
      grab(planSrc, /^function paydayAnswerHtml\([\s\S]*?\n\}$/m, 'paydayAnswerHtml'),
      '({ paydayAnswerHtml, paydayComingRows, paydayCashNote, money2 })',
    ].join('\n'),
    { Forecast: F }
  );
}

function miniPeriods(spending) {
  return {
    periods: {
      ytd: { label: 'YTD', months: 1, spending: spending || [] },
    },
  };
}

function basePlan(extra) {
  return Object.assign({
    windowDays: 40,
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 2000 },
    opening: { asOf: AS_OF, representedEvents: [] },
    income: [{
      id: 'pay', label: 'Pay', frequency: 'once', date: NEXT_PAY,
      amount: 2000, confidence: 'confirmed',
    }],
    obligations: [],
    bills: [],
    commitments: [],
    budget: { categories: [] },
  }, extra || {});
}

function o(extra) {
  return Object.assign({
    paydayFloor: 1000,
    targetBuffer: 0,
    debts: [],
    weeklyVariable: 180,
    periods: miniPeriods(),
  }, extra || {});
}

function periodLast(alloc) {
  return alloc.periodEnd;
}

function independentObligationSum(plan, asOf, end, opts) {
  let sum = 0;
  const events = F.expandEvents(plan, asOf, end, opts || {});
  for (const e of events) {
    if (!(e && e.amount < 0 && e.kind !== 'noncash' && e.jointCash !== false)) continue;
    if (e.kind === 'extra' || e.kind === 'injection' || e.kind === 'planned-debt') continue;
    if (e.kind !== 'obligation' && e.kind !== 'bill' && e.kind !== 'commitment') continue;
    sum += -e.amount;
  }
  return Math.round(sum * 100) / 100;
}

function dollarIdentity(alloc) {
  const future = (alloc.futureCosts || []).reduce((s, r) => s + (r.allocated || 0), 0);
  const optional = (alloc.optional || []).reduce((s, r) => s + (r.allocated || 0), 0);
  const path = alloc.protectedPath && alloc.protectedPath.allocated || 0;
  const extra = alloc.extraDebt && alloc.extraDebt.allocated || 0;
  return Math.round((
    (alloc.obligations && alloc.obligations.allocated || 0)
    + (alloc.essentials && alloc.essentials.allocated || 0)
    + path + future + extra + optional + alloc.unallocated
  ) * 100) / 100;
}

function htmlOf(plan, alloc, extra) {
  const composed = paydayComposer();
  return {
    composed,
    html: composed.paydayAnswerHtml(Object.assign({
      plan,
      asOf: alloc.asOf,
      advice: { weekly: alloc.weeklyCap, paydayAllocation: alloc, mode: 'normal' },
      recommended: alloc.weeklyCap,
      weekly: alloc.weeklyCap,
    }, extra || {})),
  };
}

console.log('=== A. itemized obligation reconciliation ===');
{
  const plan = basePlan({
    bills: [
      { id: 'past-a', label: 'Past A', frequency: 'once', date: '2026-09-05', amount: 40, confidence: 'confirmed' },
      { id: 'past-b', label: 'Past B', frequency: 'once', date: '2026-09-06', amount: 25, confidence: 'confirmed' },
      { id: 'soon', label: 'Soon bill', frequency: 'once', date: '2026-09-18', amount: 70, confidence: 'confirmed' },
    ],
  });
  const opts = o();
  const alloc = F.paydayAllocation(plan, AS_OF, opts);
  const items = alloc.obligations.items || [];
  const itemAmount = items.reduce((s, i) => s + i.amount, 0);
  const itemAlloc = items.reduce((s, i) => s + i.allocated, 0);
  const independent = independentObligationSum(plan, AS_OF, periodLast(alloc), opts);
  ok(items.length === 3, 'three obligation items are returned', String(items.length));
  ok(near(itemAmount, alloc.obligations.wanted) && near(itemAmount, independent),
    'sum of item amounts equals obligations.wanted and the expandEvents sum',
    `${itemAmount} vs wanted ${alloc.obligations.wanted} vs events ${independent}`);
  ok(near(itemAlloc, alloc.obligations.allocated),
    'sum of item allocations equals obligations.allocated',
    `${itemAlloc} vs ${alloc.obligations.allocated}`);
  ok(near(alloc.obligations.wanted, alloc.obligations.allocated),
    'this fixture fully funds the bills reserve');
  ok(alloc.obligations.fundingAttribution === 'complete',
    'a fully funded bills bucket may attribute each item its required amount');
}

console.log('\n=== B. unverified past-due is reserved, not called unpaid ===');
{
  const plan = basePlan({
    opening: { asOf: AS_OF, priorAsOf: '2026-09-01', representedEvents: [] },
    bills: [{
      id: 'bcaa', label: 'BCAA insurance', frequency: 'once',
      date: '2026-09-05', amount: 82.96, confidence: 'confirmed',
    }],
  });
  const alloc = F.paydayAllocation(plan, AS_OF, o());
  const item = (alloc.obligations.items || []).find(i => i.id === 'bcaa');
  ok(item && near(item.amount, 82.96) && near(item.allocated, 82.96),
    'Forecast still reserves the unverified occurrence fail-closed');
  ok(item && item.settlement === 'unverified',
    'its settlement state is unverified / reserved',
    item && item.settlement);
  ok(item && item.settlement !== 'unpaid' && item.settlement !== 'due',
    'it is not labelled confirmed unpaid');
  const { html } = htmlOf(plan, alloc);
  ok(/settlement unverified/i.test(html),
    'the page says settlement unverified');
  ok(!/confirmed unpaid|definitely unpaid|unpaid bill/i.test(html),
    'the page does not call it unpaid');
  ok(!/\bBCAA insurance\b[\s\S]{0,80}\bunpaid\b/i.test(html),
    'BCAA is not described as unpaid next to the amount');
}

console.log('\n=== C. represented / paid live event is not reserved again ===');
{
  const unpaid = basePlan({
    opening: { asOf: AS_OF, priorAsOf: '2026-09-01', representedEvents: [] },
    bills: [{
      id: 'bcaa', label: 'BCAA insurance', frequency: 'once',
      date: '2026-09-05', amount: 82.96, confidence: 'confirmed',
    }],
  });
  const paid = basePlan({
    opening: {
      asOf: AS_OF,
      priorAsOf: '2026-09-01',
      representedEvents: [{ id: 'bcaa', date: '2026-09-05' }],
    },
    bills: [{
      id: 'bcaa', label: 'BCAA insurance', frequency: 'once',
      date: '2026-09-05', amount: 82.96, confidence: 'confirmed',
    }],
  });
  const before = F.paydayAllocation(unpaid, AS_OF, o());
  const after = F.paydayAllocation(paid, AS_OF, o());
  const emitted = F.expandEvents(paid, AS_OF, AS_OF, {});
  ok(!(emitted || []).some(e => e.id === 'bcaa' && e.date === '2026-09-05'),
    'incumbent expandEvents omits the represented occurrence');
  ok((before.obligations.items || []).some(i => i.id === 'bcaa'),
    'without representation the item is still reserved');
  ok(!(after.obligations.items || []).some(i => i.id === 'bcaa'),
    'with representedEvents the item is not a required cash reserve');
  ok(near(after.obligations.wanted, 0) && near(after.obligations.allocated, 0),
    'bills-required total no longer includes the represented payment');
  ok(near(before.obligations.allocated - after.obligations.allocated, 82.96),
    'the represented path does not double-count — it drops exactly that reserve',
    String(before.obligations.allocated - after.obligations.allocated));
}

console.log('\n=== D. genuine upcoming bill ===');
{
  const plan = basePlan({
    obligations: [{
      id: 'travel', label: 'Travel Visa minimum', debtId: 'tv',
      frequency: 'once', date: '2026-09-20', amount: 17, confidence: 'estimated',
    }],
  });
  const alloc = F.paydayAllocation(plan, AS_OF, o());
  const item = (alloc.obligations.items || []).find(i => i.id === 'travel');
  ok(item && item.settlement === 'upcoming' && item.date === '2026-09-20',
    'a payment after as-of and before next payday is upcoming',
    item && item.settlement + ' ' + item.date);
  ok(item && near(item.amount, 17),
    'with its modeled amount', item && String(item.amount));
  const { html } = htmlOf(plan, alloc);
  ok(/Travel Visa minimum/.test(html) && /Due/.test(html),
    'the page names the upcoming bill and its due date');
  ok(/settlement unverified/.test(html) === false,
    'an upcoming bill is not described as settlement unverified');
}

console.log('\n=== E. essential breakdown reconciles; dated bills are not duplicated ===');
{
  const plan = basePlan({
    bills: [{
      id: 'ins-bill', label: 'Dated insurance', frequency: 'once',
      date: '2026-09-18', amount: 80, confidence: 'confirmed',
      budgetCategory: 'insurance',
    }],
    budget: {
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', plannedMonthly: 700, from: ['Groceries'] },
        { id: 'fuel', label: 'Fuel & transport', class: 'essential', plannedMonthly: 400, from: ['Fuel'] },
        { id: 'insurance', label: 'Insurance', class: 'essential', plannedMonthly: null, from: ['Insurance'] },
      ],
    },
  });
  const periods = miniPeriods([
    { label: 'Groceries', total: 0 },
    { label: 'Fuel', total: 0 },
    { label: 'Insurance', total: 0 },
  ]);
  const opts = o({ periods });
  const alloc = F.paydayAllocation(plan, AS_OF, opts);
  const bd = F.budgetBreakdown(plan, periods, opts);
  const independentWanted = bd.essentialMonthly * alloc.periodDays / MONTH;
  const requiredSum = (alloc.essentials.items || []).reduce((s, i) => s + i.required, 0);
  ok(near(alloc.essentials.wanted, independentWanted),
    'essentials.wanted matches budgetBreakdown essentialMonthly scaled to the period',
    `${alloc.essentials.wanted} vs ${independentWanted.toFixed(2)}`);
  ok(near(requiredSum, alloc.essentials.wanted),
    'sum of essential period requirements equals essentials.wanted',
    `${requiredSum} vs ${alloc.essentials.wanted}`);
  ok((alloc.obligations.items || []).some(i => i.id === 'ins-bill'),
    'the dated insurance bill is handled under obligations');
  ok(!(alloc.essentials.items || []).some(i => i.id === 'ins-bill'),
    'that bill is not a second essential requirement line');
  ok(!(alloc.essentials.items || []).some(i => i.id === 'insurance' && i.required > 0),
    'the insurance category does not carry leftover need after the dated bill');
  ok((alloc.essentials.items || []).some(i => i.id === 'groceries' && i.required > 0),
    'groceries still appear as an essential period requirement');
}

console.log('\n=== F. partial essential funding ===');
{
  const plan = basePlan({
    startingCash: { amount: 400 },
    bills: [{
      id: 'soon', label: 'Soon bill', frequency: 'once', date: '2026-09-18',
      amount: 100, confidence: 'confirmed',
    }],
    budget: {
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', plannedMonthly: 1800, from: ['Groceries'] },
        { id: 'fuel', label: 'Fuel & transport', class: 'essential', plannedMonthly: 1300, from: ['Fuel'] },
      ],
    },
  });
  const opts = o({ periods: miniPeriods() });
  const alloc = F.paydayAllocation(plan, AS_OF, opts);
  const leftover = Math.round((alloc.available - alloc.obligations.allocated) * 100) / 100;
  ok(alloc.essentials.wanted > leftover && leftover > 0,
    'period essential need exceeds cash left after obligations',
    `wanted ${alloc.essentials.wanted} leftover ${leftover}`);
  ok(near(alloc.essentials.allocated, leftover),
    'essentials.allocated is the cash left after obligations',
    String(alloc.essentials.allocated));
  ok(near(alloc.essentials.shortfall, alloc.essentials.wanted - alloc.essentials.allocated),
    'shortfall = wanted − allocated',
    String(alloc.essentials.shortfall));
  ok(alloc.essentials.fundingAttribution === 'unattributed',
    'partial funding is unattributed — no invented category priority');
  ok((alloc.essentials.items || []).every(i => i.funded == null && i.unfunded == null),
    'no category is pretended to lose first');
  const { html } = htmlOf(plan, alloc);
  ok(/Required for period/.test(html) && /Cash available for essentials/.test(html),
    'the page publishes the full required amount and the cash currently available');
  ok(/Essential shortfall/.test(html) && /not the full amount needed/.test(html),
    'and states the shortfall rather than implying allocated is the full need');
  ok(/does not choose which essential category is underfunded/.test(html),
    'and does not invent a category-level cut');
}

console.log('\n=== G. reserve is not spend permission ===');
{
  const WEEKLY = 50;
  const plan = basePlan({
    startingCash: { amount: 8000 },
    budget: {
      categories: [{
        id: 'groceries', label: 'Groceries', class: 'essential',
        plannedMonthly: 2500, from: ['Groceries'],
      }],
    },
  });
  const alloc = F.paydayAllocation(plan, AS_OF, o({ weeklyVariable: WEEKLY }));
  ok(alloc.essentials.allocated > alloc.spendPermission,
    'essential reserve exceeds the weekly-cap permission on this fixture',
    `${alloc.essentials.allocated} vs ${alloc.spendPermission}`);
  ok(near(alloc.supportedAllowance, alloc.spendPermission)
    && near(alloc.weeklyCap, WEEKLY),
    'supportedAllowance remains the weekly-cap permission');
  const { html } = htmlOf(plan, alloc);
  ok(/Household spending permission/.test(html) && html.includes(String(WEEKLY)),
    'the page publishes Forecast.spendPermission / weekly cap as the spending instruction');
  ok(/spending permission, not the essential cash reserve/.test(html),
    'and says that instruction is not the essential reserve');
  const spendCell = /Household spending permission[\s\S]*?(<div class="payday-spend">[\s\S]*?<\/div>)/.exec(html);
  ok(spendCell && spendCell[1].includes(String(WEEKLY)),
    'the spending cell carries the weekly cap');
  ok(spendCell && !spendCell[1].includes(alloc.essentials.allocated.toFixed(2)),
    'the spending cell does not publish the essential reserve as the permission');
}

console.log('\n=== H. freshness fails closed ===');
{
  const plan = basePlan({
    bills: [{
      id: 'bcaa', label: 'BCAA insurance', frequency: 'once',
      date: '2026-09-05', amount: 50, confidence: 'confirmed',
    }],
    budget: {
      categories: [{
        id: 'groceries', label: 'Groceries', class: 'essential',
        plannedMonthly: 300, from: ['Groceries'],
      }],
    },
  });
  const alloc = F.paydayAllocation(plan, AS_OF, o());
  ok(alloc.cashBasis && alloc.cashBasis.datedOpening === true
    && alloc.cashBasis.liveAdvanced === false
    && alloc.cashBasis.representedCount === 0,
    'without live overlay evidence the cash basis is the dated opening');
  const { html, composed } = htmlOf(plan, alloc, { liveOverlay: null });
  ok(/dated opening/.test(html),
    'the page identifies the dated opening');
  ok(/settlement unverified/.test(html),
    'and the unverified settlement state');
  ok(!/live Lunch Money overlay/.test(html),
    'it does not pretend bills are current from live evidence');
  const failed = composed.paydayAnswerHtml({
    plan, asOf: AS_OF,
    advice: { weekly: 180, paydayAllocation: alloc, mode: 'normal' },
    recommended: 180, weekly: 180,
    liveOverlay: { applied: false, reason: 'stale-live-cash-evidence' },
  });
  ok(/dated opening/.test(failed) && /Live overlay not applied/.test(failed),
    'a failed overlay is reported rather than faked');
  const asOfLong = new Date(AS_OF + 'T00:00:00').toLocaleDateString('en-CA', {
    day: 'numeric', month: 'long',
  });
  const asOfShort = new Date(AS_OF + 'T00:00:00').toLocaleDateString('en-CA', {
    day: 'numeric', month: 'short',
  });
  const periodEndShort = new Date(alloc.periodEnd + 'T00:00:00').toLocaleDateString('en-CA', {
    day: 'numeric', month: 'short',
  });
  ok(!/Now →/.test(html) && !/Now →/.test(failed),
    'a dated opening is not labelled Now');
  ok(html.includes(`As at ${asOfLong}`),
    'the period line names the dated as-of', asOfLong);
  ok(html.includes(`Essential costs from ${asOfShort} through ${periodEndShort}`),
    'essential wording names the Forecast period, not wall-clock now',
    `Essential costs from ${asOfShort} through ${periodEndShort}`);
  const liveHtml = composed.paydayAnswerHtml({
    plan, asOf: AS_OF,
    advice: { weekly: 180, paydayAllocation: alloc, mode: 'normal' },
    recommended: 180, weekly: 180,
    liveOverlay: { applied: true },
  });
  ok(!/Now →/.test(liveHtml),
    'a live overlay does not invent wall-clock Now');
  ok(liveHtml.includes(`Live as at ${asOfLong}`),
    'live overlay wording uses the authoritative financial date');
}

console.log('\n=== I. complete render — no truncation ===');
{
  const cats = [1, 2, 3, 4, 5, 6, 7].map(i => ({
    id: 'cat' + i, label: 'Essential ' + i, class: 'essential',
    plannedMonthly: 100 * i, from: ['E' + i],
  }));
  const bills = [1, 2, 3, 4, 5, 6].map(i => ({
    id: 'bill' + i, label: 'Bill ' + i, frequency: 'once',
    date: '2026-09-1' + (i % 8), amount: 10 + i, confidence: 'confirmed',
  }));
  const plan = basePlan({
    startingCash: { amount: 20000 },
    bills,
    budget: { categories: cats },
  });
  const alloc = F.paydayAllocation(plan, AS_OF, o({ periods: miniPeriods() }));
  const { html } = htmlOf(plan, alloc);
  for (const item of alloc.obligations.items) {
    ok(html.includes(item.label), 'obligation ' + item.id + ' is rendered');
  }
  for (const item of alloc.essentials.items) {
    ok(html.includes(item.label), 'essential ' + item.id + ' is rendered');
  }
  ok((alloc.obligations.items || []).length >= 6
    && (html.match(/class="payday-obligation"/g) || []).length === alloc.obligations.items.length,
    'no obligation item is truncated');
  ok((alloc.essentials.items || []).length >= 7
    && (html.match(/class="payday-essential"/g) || []).length === alloc.essentials.items.length,
    'no essential requirement line is truncated');
  const planSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8');
  const htmlFn = /function paydayAnswerHtml\([\s\S]*?\n\}$/m.exec(planSrc)[0];
  ok(!/obligationItems\.slice\(/.test(htmlFn) && !/essentialItems\.slice\(/.test(htmlFn),
    'paydayAnswerHtml does not slice obligation or essential rows');
}

console.log('\n=== J. dollar reconciliation — no dollar twice ===');
{
  const plan = basePlan({
    startingCash: { amount: 2500 },
    bills: [
      { id: 'past', label: 'Past', frequency: 'once', date: '2026-09-05', amount: 40, confidence: 'confirmed' },
      { id: 'soon', label: 'Soon', frequency: 'once', date: '2026-09-18', amount: 60, confidence: 'confirmed' },
    ],
    budget: {
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', plannedMonthly: 300, from: ['Groceries'] },
      ],
    },
    commitments: [
      { id: 'later', label: 'Later cost', date: '2026-11-01', amount: 400, confidence: 'confirmed' },
    ],
  });
  const alloc = F.paydayAllocation(plan, AS_OF, o({ periods: miniPeriods() }));
  const sumItems = (alloc.obligations.items || []).reduce((s, i) => s + i.allocated, 0);
  const sumRequired = (alloc.essentials.items || []).reduce((s, i) => s + i.required, 0);
  ok(near(sumItems, alloc.obligations.allocated),
    'obligation item allocations do not hide an aggregate-only remainder');
  ok(near(sumRequired, alloc.essentials.wanted),
    'essential requirements do not hide an aggregate-only remainder');
  ok(near(dollarIdentity(alloc), alloc.available),
    'available = obligations + essentials + path + future costs + extra debt + optional + unallocated',
    `${dollarIdentity(alloc)} vs ${alloc.available}`);
  ok(near(alloc.identity, alloc.available),
    'the waterfall identity still holds');
  const coming = paydayComposer().paydayComingRows({
    advice: {
      nearBoundary: { items: alloc.obligations.items.map(i => ({
        id: i.id, label: i.label, date: i.date, amount: i.amount,
      })) },
      paydayAllocation: alloc,
    },
    nextOut: alloc.obligations.items[0]
      ? { id: alloc.obligations.items[0].id, label: alloc.obligations.items[0].label,
          date: alloc.obligations.items[0].date, amount: alloc.obligations.items[0].amount }
      : null,
  });
  ok(coming.length === 0,
    'Coming before next payday does not repeat already-reserved obligation amounts');
  const comingByLabel = paydayComposer().paydayComingRows({
    advice: { nearBoundary: { items: [] }, paydayAllocation: alloc },
    nextOut: alloc.obligations.items[0]
      ? { label: alloc.obligations.items[0].label,
          date: alloc.obligations.items[0].date, amount: alloc.obligations.items[0].amount }
      : null,
  });
  ok(comingByLabel.length === 0,
    'a nextPaymentOut without an id is still not a second reserve');
}

console.log('\n=== K. partial bill funding is unattributed — no invented priority ===');
{
  const first = {
    id: 'first', label: 'First bill', frequency: 'once',
    date: '2026-09-12', amount: 80, confidence: 'confirmed',
  };
  const second = {
    id: 'second', label: 'Second bill', frequency: 'once',
    date: '2026-09-18', amount: 70, confidence: 'confirmed',
  };
  const cash = 90;
  const run = bills => {
    const plan = basePlan({
      startingCash: { amount: cash },
      bills,
      budget: { categories: [] },
    });
    return { plan, alloc: F.paydayAllocation(plan, AS_OF, o({ weeklyVariable: 0 })) };
  };
  const forward = run([first, second]);
  const reversed = run([second, first]);
  const wanted = first.amount + second.amount;
  ok(near(forward.alloc.obligations.wanted, wanted)
    && forward.alloc.obligations.allocated > 0
    && forward.alloc.obligations.allocated + 0.02 < wanted,
    'cash covers some but not all required bills',
    `${forward.alloc.obligations.allocated} of ${forward.alloc.obligations.wanted}`);
  ok(forward.alloc.obligations.fundingAttribution === 'unattributed'
    && reversed.alloc.obligations.fundingAttribution === 'unattributed',
    'partial bill funding is unattributed — no invented payment priority');
  ok((forward.alloc.obligations.items || []).every(i => i.allocated == null)
    && (reversed.alloc.obligations.items || []).every(i => i.allocated == null),
    'no item is assigned reserved cash by array or calendar order');
  ok(near(forward.alloc.obligations.allocated, reversed.alloc.obligations.allocated)
    && near(forward.alloc.obligations.wanted, reversed.alloc.obligations.wanted),
    'reversing bill order does not change the reserved pool');
  const firstFwd = (forward.alloc.obligations.items || []).find(i => i.id === 'first');
  const firstRev = (reversed.alloc.obligations.items || []).find(i => i.id === 'first');
  ok(firstFwd && firstRev && firstFwd.allocated === firstRev.allocated,
    'the same bill does not receive different reserved cash because it appeared first');
  const { html } = htmlOf(forward.plan, forward.alloc);
  ok(/First bill/.test(html) && /Second bill/.test(html),
    'both required bills remain visible as required amounts');
  ok(/Bills currently reserved/.test(html) && /shortfall/.test(html),
    'the page publishes the aggregate reserved cash and shortfall');
  ok(/does not choose which required bill is underfunded/.test(html),
    'and does not invent a bill-level cut');
  ok(!/Reserved until current evidence confirms posting/.test(html),
    'no row claims an individual bill is reserved when attribution is unattributed');
  const empty = run([first, second]);
  empty.alloc = F.paydayAllocation(basePlan({
    startingCash: { amount: 0 },
    bills: [first, second],
    budget: { categories: [] },
  }), AS_OF, o({ weeklyVariable: 0 }));
  ok(empty.alloc.obligations.fundingAttribution === 'none'
    && (empty.alloc.obligations.items || []).every(i => i.allocated === 0),
    'an unfunded bills bucket may mark every item zero without inventing order');
  const { html: noneHtml } = htmlOf(basePlan({
    startingCash: { amount: 0 },
    bills: [first, second],
    budget: { categories: [] },
  }), empty.alloc);
  ok(!/Reserved until current evidence confirms posting/.test(noneHtml),
    'an unfunded bucket does not claim any bill is reserved');
}

console.log('\n=== live opening observation (not a specification) ===');
{
  const live = require('../data.json');
  const periods = require('../public/periods.json');
  const asOf = live.meta.asOf;
  const rec = F.recommend(live.plan, asOf, {
    paydayFloor: 1000,
    targetBuffer: live.plan.defaults.targetBuffer,
    periods,
    paypalPerMonth: live.paypal && live.paypal.perMonth,
    debts: live.debts,
    extraFacilities: live.revolvingExtra,
    fundingSources: live.plan.funding && live.plan.funding.options,
  });
  const alloc = rec.paydayAllocation;
  const oncePast = (live.plan.bills || []).filter(b =>
    b && b.frequency === 'once' && b.date && b.date < asOf
    && b.householdObligation !== false);
  for (const bill of oncePast) {
    const item = (alloc.obligations.items || []).find(i => i.id === bill.id);
    if (!item) continue;
    ok(item.settlement === 'unverified',
      `live ${bill.id} is settlement-unverified, not proven unpaid`,
      item.settlement);
  }
  const travel = (alloc.obligations.items || []).find(i => i.id === 'travel');
  if (travel) {
    ok(travel.settlement === 'upcoming' && travel.date > asOf,
      'live Travel Visa minimum is the modeled upcoming obligation',
      travel.date);
  }
  ok(alloc.cashBasis && alloc.cashBasis.datedOpening === true,
    'canonical payload without a live overlay is a dated opening');
  const { html } = htmlOf(live.plan, alloc, { liveOverlay: live.liveOverlay || null });
  ok(/dated opening/.test(html),
    'live composed HTML names the dated opening');
  const liveAsOfLong = new Date(asOf + 'T00:00:00').toLocaleDateString('en-CA', {
    day: 'numeric', month: 'long',
  });
  ok(!/Now →/.test(html) && html.includes(`As at ${liveAsOfLong}`),
    'live dated opening is labelled from as-of, not Now');
  // Labels are escaped text in the HTML: compare the escaped form.
  const escapeHtml = require('./app-escape-html');
  ok((alloc.obligations.items || []).every(i => html.includes(escapeHtml(i.label))),
    'every live obligation item is rendered');
  ok((alloc.essentials.items || []).filter(i => Number(i.required) > 0)
      .every(i => html.includes(escapeHtml(i.label))),
    'every live essential requirement is rendered');
  ok(alloc.essentials.wanted >= alloc.essentials.allocated - 0.02,
    'live essential wanted is at least the funded hold');
  console.log('    available', alloc.available.toFixed(2),
    'bills', alloc.obligations.allocated.toFixed(2),
    'essentials wanted/allocated/shortfall',
    alloc.essentials.wanted.toFixed(2),
    alloc.essentials.allocated.toFixed(2),
    alloc.essentials.shortfall.toFixed(2));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll payday-reserve-detail proofs passed.');
