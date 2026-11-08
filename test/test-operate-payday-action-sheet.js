'use strict';
/* AF-OPERATE-03 — the default homepage renders Forecast.paydayAllocation as
 * an ordered, reconciled action sheet. Forecast remains the sole allocator.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const data = require('../data.json');
const periods = require('../public/periods.json');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

function loadSheet() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const grab = (src, re, label) => {
    const match = re.exec(src);
    if (!match) throw new Error('missing ' + label);
    return match[0];
  };
  const source = [
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(planSrc, /^const PAYDAY_ACTION_KIND = \{[\s\S]*?^\};$/m, 'PAYDAY_ACTION_KIND'),
    grab(planSrc, /^function paydayAllocationTrustNote\([\s\S]*?\n\}$/m, 'paydayAllocationTrustNote'),
    grab(planSrc, /^function paydayAllocationSheetHtml\([\s\S]*?\n\}$/m, 'paydayAllocationSheetHtml'),
  ].join('\n');
  return vm.runInNewContext(`${source}\n({ paydayAllocationSheetHtml, money2 });`);
}

function currentAllocation() {
  const plan = data.plan;
  const asOf = data.meta.asOf;
  return F.recommend(plan, asOf, {
    scenario: 'expected',
    targetBuffer: plan.defaults.targetBuffer,
    extraDebtMonthly: 0,
    disabled: [],
    fundingSources: plan.funding && plan.funding.options,
    debts: data.debts,
    extraFacilities: data.revolvingExtra,
    extraDebtTarget: plan.nextDollar && plan.nextDollar.target,
    periods,
    paypalPerMonth: data.paypal && data.paypal.perMonth,
  }).paydayAllocation;
}

console.log('=== available resources are independently grounded ===');
{
  const alloc = currentAllocation();
  const opening = (data.plan.startingCash.breakdown || [])
    .filter(row => row && (row.id === 'chequing-a' || row.id === 'chequing-b'))
    .reduce((sum, row) => sum + Number(row.value || 0), 0);
  let sameDayIncome = 0;
  for (const row of data.plan.income || []) {
    if (row.frequency === 'once' && row.date === data.meta.asOf) {
      sameDayIncome += Number(row.amount || 0);
    }
  }
  const independentAvailable = opening + sameDayIncome;
  const sheet = loadSheet();
  const html = sheet.paydayAllocationSheetHtml(alloc);
  ok(near(alloc.available, independentAvailable),
    'Forecast available equals spendable opening plus independently enumerated same-day income');
  ok(html.includes(`data-allocation-available>${sheet.money2(alloc.available)}`),
    'the rendered available amount is Forecast.paydayAllocation.available');
}

console.log('\n=== allocation lines preserve Forecast order and amounts ===');
{
  const alloc = currentAllocation();
  const sheet = loadSheet();
  const html = sheet.paydayAllocationSheetHtml(alloc);
  let previous = -1;
  for (const [index, line] of alloc.lines.entries()) {
    if (line && line.kind === 'future-path') {
      const path = alloc.protectedPath || {};
      if (path.status !== 'calculated' || path.allocated == null || !(Number(path.allocated) > 0)) {
        ok(!html.includes(`data-allocation-key="${line.key}"`),
          'a withheld or zero future-path line is not printed as an actionable amount');
        continue;
      }
      const marker = `data-allocation-key="${line.key}" data-allocation-order="${index + 1}"`;
      const at = html.indexOf(marker);
      ok(at > previous, `line ${line.key} stays in Forecast order`);
      ok(at >= 0 && html.slice(at).includes(line.label)
        && html.slice(at).includes(sheet.money2(path.allocated)),
      'future-path amount is copied from protectedPath.allocated');
      previous = at;
      continue;
    }
    const marker = `data-allocation-key="${line.key}" data-allocation-order="${index + 1}"`;
    const at = html.indexOf(marker);
    ok(at > previous, `line ${line.key} stays in Forecast order`);
    ok(at >= 0 && html.slice(at).includes(line.label)
      && html.slice(at).includes(sheet.money2(line.amount)),
    `line ${line.key} label and amount come from Forecast.paydayAllocation`);
    previous = at;
  }
  const printed = alloc.lines.filter(line => {
    if (!(line && line.kind === 'future-path')) return true;
    const path = alloc.protectedPath || {};
    return path.status === 'calculated' && Number(path.allocated) > 0;
  });
  ok((html.match(/data-allocation-key=/g) || []).length === printed.length,
    'the sheet adds no allocation line outside Forecast.paydayAllocation.lines');
  const unverified = alloc.obligations.items.filter(item => item.settlement === 'unverified');
  for (const item of unverified) {
    ok(html.includes(item.label) && /Settlement unverified:/.test(html),
      `bill reserve retains Forecast settlement state for ${item.id}`);
  }
  if (alloc.essentials.fundingAttribution === 'unattributed') {
    ok(/unattributed essential-spending hold/.test(html),
      'a partial essential pool does not imply category-level funding');
  }
}

console.log('\n=== displayed totals reconcile independently ===');
{
  const alloc = currentAllocation();
  const sheet = loadSheet();
  const html = sheet.paydayAllocationSheetHtml(alloc);
  const independentAllocated = alloc.lines.reduce((sum, line) => sum + Number(line.amount), 0);
  ok(near(independentAllocated, alloc.allocatedTotal),
    'independent line sum equals Forecast allocatedTotal');
  ok(near(independentAllocated + alloc.remainder, alloc.available),
    'independent allocation total plus remainder equals Forecast available');
  ok(near(alloc.identity, alloc.available),
    'Forecast identity equals its available resources');
  const reconciliation = `${sheet.money2(alloc.allocatedTotal)} allocated + ${sheet.money2(alloc.remainder)} remainder = ${sheet.money2(alloc.available)} available resources`;
  ok(html.includes(reconciliation),
    'the page displays Forecast reconciliation fields without recalculating them');
}

console.log('\n=== untouched, future, extra-debt and remainder states are explicit ===');
{
  const alloc = currentAllocation();
  const html = loadSheet().paydayAllocationSheetHtml(alloc);
  ok(/Leave untouched/.test(html) && /data-allocation-state="untouched"|future-path/.test(html),
    'cash that must remain untouched is explicitly identified from protectedPath/future-path output');
  for (const row of alloc.futureCosts || []) {
    ok(html.includes(row.label) && html.includes(loadSheet().money2(row.allocated)),
      `future-cost state ${row.id} retains its Forecast allocation`);
  }
  ok(/Extra debt allocation/.test(html) && html.includes(loadSheet().money2(alloc.extraDebt.allocated)),
    'zero extra debt remains an explicit zero, not an implied payment');
  ok(/Unallocated remainder|Unallocated \/ optional remainder/.test(html)
    && html.includes(loadSheet().money2(alloc.remainder)),
  'the Forecast remainder is displayed explicitly');
}

console.log('\n=== trust, unresolved and unavailable states fail closed ===');
{
  const sheet = loadSheet();
  const synthetic = {
    available: 100,
    allocatedTotal: 100,
    remainder: 0,
    identity: 100,
    lines: [{ key: 'obligations', kind: 'obligations', label: 'Keep for bills', amount: 100 }],
    obligations: { fundingAttribution: 'unattributed', items: [
      { label: 'Estimated minimum', confidence: 'estimated', settlement: 'unverified' },
      { label: 'Unknown settlement', confidence: 'unknown' },
    ] },
    essentials: { fundingAttribution: 'complete' },
    protectedPath: { status: 'calculated', allocated: 0 },
    futureCosts: [],
    extraDebt: { allocated: 0 },
    unresolved: [{ id: 'undated', label: 'Undated required cost',
      reason: 'Required, but no exact date — no payday contribution assigned.' }],
  };
  const html = sheet.paydayAllocationSheetHtml(synthetic);
  ok(/Estimated minimum · estimated/.test(html) && /Unknown settlement · unknown/.test(html),
    'estimated and unknown obligation inputs keep their trust treatment');
  ok(/Settlement unverified: Estimated minimum/.test(html)
    && /unattributed reserve pool/.test(html),
  'settlement and partial-pool attribution stay qualified rather than implying a bill priority');
  ok(/Undated required cost/.test(html) && /unresolved; no payday allocation/.test(html),
    'an unresolved future cost is not fabricated into an allocation');
  ok(/\$0\.00/.test(html) && /No extra debt payment is allocated/.test(html),
    'zero output explicitly says no extra payment is allocated');
  const unavailable = sheet.paydayAllocationSheetHtml(null);
  ok(/allocation unavailable/i.test(unavailable) && /No payment, transfer, debt action/.test(unavailable),
    'unavailable output implies no money movement');
  ok(/does not prove or initiate a payment, transfer or card action/.test(html),
    'the actionable sheet explicitly remains non-executable');
}

console.log('\n=== estimated future-cost timing stays qualified ===');
{
  const sheet = loadSheet();
  const dated = {
    id: 'camp',
    label: 'Estimated camp',
    date: '2026-09-15',
    allocated: 40,
    confidence: 'estimated',
    reason: 'Required current funding from the master Forecast is met.',
  };
  const zeroDated = {
    id: 'later',
    label: 'Estimated later cost',
    date: '2026-11-01',
    allocated: 0,
    confidence: 'estimated',
    reason: 'Required current funding from the master Forecast is met.',
  };
  const undated = {
    id: 'undated',
    label: 'Estimated undated cost',
    date: null,
    confidence: 'estimated',
    reason: 'Required, but no exact date — no payday contribution assigned.',
  };
  const html = sheet.paydayAllocationSheetHtml({
    available: 40,
    allocatedTotal: 40,
    remainder: 0,
    identity: 40,
    lines: [{
      key: 'future:camp',
      kind: 'future-cost',
      label: 'Set aside — Estimated camp',
      amount: 40,
      id: dated.id,
      date: dated.date,
      confidence: dated.confidence,
    }],
    obligations: { items: [] },
    essentials: { fundingAttribution: 'complete' },
    protectedPath: { status: 'calculated', allocated: 0 },
    futureCosts: [dated, zeroDated],
    extraDebt: { allocated: 0 },
    unresolved: [undated],
  });
  ok(/Sep 15 · estimated/.test(html) && /Input trust retained: estimated/.test(html),
    'a positive future-cost line does not present an estimated date as confirmed');
  ok(!/>Sep 15</.test(html),
    'the estimated dated line does not print an unqualified exact date');
  ok(/by Nov 1 · estimated/.test(html),
    'a zero future-cost state keeps estimated timing on the printed date');
  ok(!/by Nov 1</.test(html),
    'the estimated zero-state date is not printed as an unqualified deadline');
  ok(/Estimated undated cost/.test(html) && /unresolved; no payday allocation · estimated/.test(html),
    'an estimated undated commitment stays unresolved and visibly estimated');

  const alloc = currentAllocation();
  const liveHtml = sheet.paydayAllocationSheetHtml(alloc);
  for (const row of alloc.futureCosts || []) {
    if (!(row && row.confidence && row.confidence !== 'confirmed')) continue;
    ok(liveHtml.includes(row.label) && liveHtml.includes(` · ${row.confidence}`),
      `live future-cost ${row.id} keeps Forecast ${row.confidence} visible`);
  }
  for (const row of alloc.unresolved || []) {
    if (!(row && row.confidence && row.confidence !== 'confirmed')) continue;
    ok(liveHtml.includes(row.label) && liveHtml.includes(` · ${row.confidence}`),
      `live unresolved ${row.id} keeps Forecast ${row.confidence} visible`);
  }
}

console.log('\n=== Prepare Ahead reprints protectedPath.allocated and fail-closes ===');
{
  const sheet = loadSheet();
  const money = sheet.money2;
  const base = {
    available: 1234.56,
    allocatedTotal: 1222.22,
    remainder: 12.34,
    identity: 1234.56,
    obligations: { items: [] },
    essentials: { fundingAttribution: 'complete' },
    futureCosts: [],
    extraDebt: { allocated: 3.21 },
    unresolved: [],
  };
  const obligationLine = {
    key: 'obligations',
    kind: 'obligations',
    label: 'Keep for bills',
    amount: 200,
  };
  const stalePathLine = {
    key: 'future-path',
    kind: 'future-path',
    label: 'Keep for future cash path',
    amount: 999.99,
  };
  const calculatedPath = (allocated, extra) => Object.assign({
    wanted: 888.88,
    allocated,
    movable: 17.17,
    status: 'calculated',
    identity: 'keep-in-chequing leftover after obligations and essentials that cannot be removed while protectedPlanCheck holds',
    source: 'Forecast.paydayAllocation',
    designatedSavingsBacking: 'not-used',
  }, extra || {});
  const unavailablePath = {
    wanted: null,
    allocated: null,
    movable: null,
    status: 'unavailable',
    reason: 'Current plan unavailable. The dated opening is stale.',
    identity: 'keep-in-chequing leftover after obligations and essentials that cannot be removed while protectedPlanCheck holds',
    source: 'Forecast.paydayAllocation',
    designatedSavingsBacking: 'not-used',
  };

  const positive = sheet.paydayAllocationSheetHtml(Object.assign({}, base, {
    lines: [obligationLine, stalePathLine],
    protectedPath: calculatedPath(250.25),
  }));
  ok(/data-allocation-key="future-path"/.test(positive)
    && /Future cash/.test(positive)
    && /Keep for future cash path/.test(positive)
    && positive.includes(money(250.25)),
    'calculated positive Prepare Ahead copies protectedPath.allocated onto the future-path line');
  ok(!positive.includes(money(999.99)) && !positive.includes(money(888.88))
      && !positive.includes(money(17.17)),
    'calculated reprint does not use the stale line amount, wanted, or movable');
  ok(!/Leave untouched for the future cash path/.test(positive),
    'a required hold is the future-path line, not the zero-state');

  const zero = sheet.paydayAllocationSheetHtml(Object.assign({}, base, {
    lines: [obligationLine],
    protectedPath: calculatedPath(0),
  }));
  ok(/Leave untouched for the future cash path/.test(zero)
      && /Forecast requires no separate future-path cash hold/.test(zero)
      && /data-allocation-state="untouched"/.test(zero)
      && zero.includes(money(0))
      && !/Unavailable; no future-path cash hold/.test(zero)
      && !/data-allocation-key="future-path"/.test(zero),
    'calculated $0 is the zero-state hold, not unavailable');

  const zeroStaleLine = sheet.paydayAllocationSheetHtml(Object.assign({}, base, {
    lines: [obligationLine, Object.assign({}, stalePathLine, { amount: 400 })],
    protectedPath: calculatedPath(0),
  }));
  ok(/Leave untouched for the future cash path/.test(zeroStaleLine)
      && zeroStaleLine.includes(money(0))
      && !/data-allocation-key="future-path"/.test(zeroStaleLine)
      && !zeroStaleLine.includes(money(400)),
    'calculated $0 suppresses a leftover future-path line rather than printing it');

  const withheld = sheet.paydayAllocationSheetHtml(Object.assign({}, base, {
    lines: [obligationLine, stalePathLine],
    protectedPath: unavailablePath,
  }));
  const untouched = withheld.match(/data-allocation-state="untouched"[\s\S]*?<\/div>/);
  ok(/Unavailable; no future-path cash hold is instructed/.test(withheld)
      && /Leave untouched for the future cash path/.test(withheld)
      && untouched && /—/.test(untouched[0]) && !untouched[0].includes(money(0)),
    'unavailable Prepare Ahead matches extra-debt fail-closed: amount is —, not $0');
  ok(!/data-allocation-key="future-path"/.test(withheld)
      && !withheld.includes(money(999.99)),
    'unavailable Prepare Ahead does not reprint a stale future-path line amount');
  ok(!withheld.includes(money(888.88)) && !withheld.includes(money(17.17)),
    'unavailable markup does not print wanted or movable');

  const estimated = sheet.paydayAllocationSheetHtml(Object.assign({}, base, {
    lines: [obligationLine, Object.assign({}, stalePathLine, { amount: 250.25 })],
    protectedPath: calculatedPath(250.25, { status: 'estimated' }),
  }));
  const estimatedUntouched = estimated.match(/data-allocation-state="untouched"[\s\S]*?<\/div>/);
  ok(!/data-allocation-key="future-path"/.test(estimated)
      && !estimated.includes(money(250.25))
      && /Unavailable; no future-path cash hold is instructed/.test(estimated)
      && estimatedUntouched && /—/.test(estimatedUntouched[0]),
    'non-calculated status with a numeric allocated does not print that amount');
  const unknownStatus = sheet.paydayAllocationSheetHtml(Object.assign({}, base, {
    lines: [obligationLine, stalePathLine],
    protectedPath: { allocated: 999.99, wanted: 888.88, movable: 17.17 },
  }));
  ok(!/data-allocation-key="future-path"/.test(unknownStatus)
      && !unknownStatus.includes(money(999.99))
      && /Unavailable; no future-path cash hold is instructed/.test(unknownStatus),
    'missing status with a numeric allocated fail-closes rather than publishing Prepare Ahead');

  ok(positive.includes(`data-allocation-available>${money(base.available)}`)
      && zero.includes(`data-allocation-available>${money(base.available)}`)
      && withheld.includes(`data-allocation-available>${money(base.available)}`)
      && positive.includes('Keep for bills') && positive.includes(money(obligationLine.amount))
      && withheld.includes('Keep for bills') && withheld.includes(money(obligationLine.amount))
      && withheld.includes(money(base.extraDebt.allocated))
      && withheld.includes(money(base.remainder)),
    'sibling payday figures still render from Forecast when Prepare Ahead fail-closes');

  const primary = [positive, zero, withheld].join('\n');
  ok(!/transfer to savings/i.test(primary) && !/move(?:ment)? to savings/i.test(primary)
      && !/into designated savings/i.test(primary),
    'the sheet does not instruct a transfer to Savings');
  ok(!/\bwanted\b/i.test(primary) && !/\bmovable\b/i.test(primary),
    'wanted and movable are not printed in the primary Prepare Ahead markup');

  const withheldLive = F.recommend({
    windowDays: 200,
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    startingCash: {
      breakdown: [
        { id: 'chequing-a', label: 'BILLS ACCOUNT', value: 4000, class: 'spendable' },
        { id: 'chequing-b', label: 'WEEKLY SPENDING', value: 0, class: 'spendable' },
        { id: 'savings', label: 'EMERGENCY SAVING', value: 0, class: 'spendable' },
      ],
    },
    opening: { asOf: '2026-09-01' },
    budget: { basis: 'ytd', categories: [] },
    income: [],
    bills: [{
      id: 'later',
      label: 'later',
      frequency: 'once',
      date: '2026-10-16',
      amount: 1500,
      confidence: 'confirmed',
    }],
    obligations: [],
    commitments: [],
  }, '2026-09-01', {
    paydayFloor: 10000,
    targetBuffer: 0,
    weeklyVariable: 0,
    debts: [{ id: 'card', label: 'Card', balance: 8000, rate: 19.99, limit: 10000, secured: false }],
    extraFacilities: [],
    extraDebtMonthly: 0,
    operatingPlan: 'unavailable',
    operatingPlanNote: 'Current plan unavailable. The dated opening is stale.',
  }).paydayAllocation;
  const stale = (withheldLive.lines || []).find(line => line && line.kind === 'future-path');
  const withheldHtml = sheet.paydayAllocationSheetHtml(withheldLive);
  ok(withheldLive.protectedPath && withheldLive.protectedPath.status === 'unavailable'
      && withheldLive.protectedPath.allocated == null
      && stale && Number(stale.amount) > 0,
    'withholdCurrentOperatingClaims still leaves a future-path line after protectedPath is unavailable');
  ok(!/data-allocation-key="future-path"/.test(withheldHtml)
      && !withheldHtml.includes(money(stale.amount))
      && /Unavailable; no future-path cash hold is instructed/.test(withheldHtml)
      && /—/.test(withheldHtml),
    'the page fail-closes that withheld Forecast packet instead of reprinting the leftover line');
}

console.log('\n=== the page remains a renderer, not a calculator ===');
{
  const src = read('public/plan.js');
  const fn = /function paydayAllocationSheetHtml\([\s\S]*?\n\}/m.exec(src);
  ok(!!fn, 'the action-sheet renderer is a bounded function');
  ok(fn && !/\bForecast\.[A-Za-z]+\s*\(/.test(fn[0]),
    'the action sheet calls no Forecast function');
  ok(fn && !/\.reduce\(|allocatedTotal\s*[+\-*/]=?|remainder\s*[+\-*/]=?|available\s*[+\-*/]=?/.test(fn[0]),
    'the action sheet contains no allocation or reconciliation arithmetic');
  ok(fn && /alloc\.lines\.map/.test(fn[0]) && /alloc\.allocatedTotal/.test(fn[0])
    && /alloc\.remainder/.test(fn[0]) && /alloc\.available/.test(fn[0]),
  'the renderer consumes Forecast lines and reconciliation fields directly');
  ok(fn && /protectedPath/.test(fn[0]) && /status === 'calculated'/.test(fn[0])
      && /pathAllocated/.test(fn[0]),
    'Prepare Ahead display reprints only when protectedPath.status is calculated');
  ok(fn && !/\.wanted/.test(fn[0]) && !/\.movable/.test(fn[0]),
    'the action sheet does not read protectedPath wanted or movable');
  ok(fn && !/pathAllocated\s*[+\-*/]|allocatedPath\s*[+\-*/]/.test(fn[0]),
    'the sheet copies allocated; it does not compute Prepare Ahead');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
