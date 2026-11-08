'use strict';
/* AF-OPERATE-06 — independent proof for the homepage debt answer. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const live = require('../data.json');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

function debtComposer() {
  const app = read('public/app.js');
  const plan = read('public/plan.js');
  const grab = (src, re, label) => {
    const match = re.exec(src);
    if (!match) throw new Error('missing ' + label);
    return match[0];
  };
  return vm.runInNewContext([
    grab(app, /^const money2 = .*$/m, 'money2'),
    grab(app, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(app, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(plan, /^function operatingDebtAnswerHtml\([\s\S]*?\n\}$/m, 'operatingDebtAnswerHtml'),
    '({ operatingDebtAnswerHtml, money2 })',
  ].join('\n'));
}

const policy = {
  policy: 'true-surplus-highest-interest',
  eligibleDebts: 'revolving-cards-and-heloc',
  provenance: 'owner-stated',
  provenanceDate: '2026-08-24',
};
const debts = [
  { id: 'mortgage', label: 'Mortgage', balance: 1000, pending: 0, rate: 4,
    secured: true, structure: 'Amortising', confidence: 'verified' },
  { id: 'high', label: 'High card', balance: 50, pending: 0, rate: 20,
    secured: false, structure: 'Revolving card', confidence: 'verified' },
  { id: 'low', label: 'Low card', balance: 40, pending: 0, rate: 10,
    secured: false, structure: 'Revolving card', confidence: 'estimated' },
  { id: 'heloc', label: 'HELOC', balance: 60, pending: 0, rate: 5,
    secured: true, structure: 'Interest-only revolving', confidence: 'verified' },
];
function fixture(opening) {
  return {
    windowDays: 60,
    defaults: { targetBuffer: 0 },
    startingCash: { amount: opening },
    income: [],
    obligations: [{ id: 'mortgage-pay', label: 'Mortgage payment', frequency: 'once',
      date: '2026-09-01', amount: 25, debtId: 'mortgage', effect: 'payment',
      confidence: 'estimated' }],
    bills: [],
    commitments: [{ id: 'optional-trip', label: 'Optional trip', date: '2026-09-20',
      amount: 100, flexibility: 'optional', confidence: 'estimated' }],
    nextDollar: policy,
  };
}
const opts = {
  targetBuffer: 0,
  paydayFloor: 100,
  debts,
  // Deliberately huge: revolving availability must never become cash.
  extraFacilities: [{ id: 'overdraft', limit: 100000, used: 0 }],
};

console.log('=== incumbent required-debt and true-surplus dollars ===');
const alloc = F.paydayAllocation(fixture(300), '2026-09-01', opts);
ok(alloc.requiredDebtPayments.items.length === 1
  && alloc.requiredDebtPayments.items[0].id === 'mortgage-pay'
  && near(alloc.requiredDebtPayments.items[0].amount, 25),
  'required debt is the incumbent Forecast obligation event, not extra principal');
ok(near(alloc.obligations.allocated, 25)
  && near(alloc.extraDebt.allocated, 150),
  'required debt and extra principal remain separate',
  `required ${alloc.obligations.allocated}; extra ${alloc.extraDebt.allocated}`);
ok(near(alloc.available, 300),
  'available credit is not included in household cash',
  `cash ${alloc.available}; credit 100000`);
ok(alloc.optional.length === 1 && near(alloc.optional[0].allocated, 100),
  'extra debt absorbs eligible balances before optional future cost residual');
ok(near(alloc.identity, alloc.available),
  'the incumbent payday identity still reconciles');

console.log('\n=== Forecast owns target and consequence ===');
const priority = F.debtPriority(fixture(300), debts);
ok(priority.status === 'ready' && priority.target.id === 'high',
  'Forecast selects the highest-interest eligible debt',
  `${priority.target.id} ${priority.target.rate}%`);
ok(priority.nextTarget && priority.nextTarget.id === 'low',
  'Forecast exposes the conditional next target');
ok(priority.order.some(row => row.id === 'heloc')
  && !priority.order.some(row => row.id === 'mortgage'),
  'the eligible order includes HELOC and excludes the amortising mortgage');

console.log('\n=== tie and unknown rates fail closed ===');
const tied = debts.map(d => Object.assign({}, d));
tied.find(d => d.id === 'low').rate = 20;
const tieResult = F.debtPriority(fixture(300), tied);
ok(tieResult.status === 'unavailable' && tieResult.target === null
  && /equal interest rates/.test(tieResult.reason),
  'an equal rate names no target without an owner tie-breaker');
const unknown = debts.map(d => Object.assign({}, d));
delete unknown.find(d => d.id === 'high').rate;
const unknownResult = F.debtPriority(fixture(300), unknown);
ok(unknownResult.status === 'unavailable' && unknownResult.target === null
  && /unknown interest rate/.test(unknownResult.reason),
  'an unavailable rate names no target');
const blockedAllocation = F.paydayAllocation(fixture(300), '2026-09-01',
  Object.assign({}, opts, { debts: tied }));
ok(near(blockedAllocation.extraDebt.allocated, 0),
  'the payday allocation sends no extra principal when target authority fails closed');

console.log('\n=== homepage renders Forecast answers without ranking ===');
const composer = debtComposer();
const zero = JSON.parse(JSON.stringify(alloc));
zero.extraDebt.allocated = 0;
const zeroHtml = composer.operatingDebtAnswerHtml(zero);
ok(zeroHtml.includes('Mortgage payment') && zeroHtml.includes('$25.00')
  && zeroHtml.includes('estimated'),
  'displayed required debt amount and trust state come from Forecast');
ok(zeroHtml.includes('No extra debt payment this payday.')
  && zeroHtml.includes('$0.00 extra principal allocated this payday'),
  'zero extra allocation is explicit');
ok(zeroHtml.includes('Debt target:</b> High card')
  && !zeroHtml.includes('Extra debt money this payday goes to High card'),
  'a zero allocation may show the authorized target but never says it received surplus');
const positiveHtml = composer.operatingDebtAnswerHtml(alloc);
ok(positiveHtml.includes('Extra debt money this payday goes to High card')
  && !positiveHtml.includes('Extra debt money this payday goes to Low card'),
  'a positive allocation names only Forecast\'s authorized target as receiving surplus');
ok(positiveHtml.includes('$150.00 extra principal allocated this payday'),
  'amount this payday is the direct Forecast.paydayAllocation value');
ok(positiveHtml.includes('extra money would next go to Low card'),
  'the displayed next consequence is the one Forecast returned');
ok(/not proof that a payment occurred/.test(positiveHtml),
  'allocation and target do not imply a payment occurred');

const page = read('public/plan.js');
const renderer = /function operatingDebtAnswerHtml\([\s\S]*?\n\}/.exec(page);
ok(renderer && !/\.sort\(|\.rate\s*[<>]=?|openingBalance|absorbable\s*[-+*/]/.test(renderer[0]),
  'the page performs no target ranking or debt-capacity arithmetic');
ok(!/plan\.nextDollar\s*&&\s*plan\.nextDollar\.target/.test(page),
  'the production page does not read a stored policy target');

console.log('\n=== current household answer ===');
const currentPriority = F.debtPriority(live.plan, live.debts);
ok(currentPriority.status === 'ready' && currentPriority.target.id === 'cashback'
  && currentPriority.nextTarget.id === 'tdcc',
  'current known, distinct rates authorize Cash Back now and TD credit card next');
ok(!currentPriority.order.some(row => row.pendingUnknown),
  'no current eligible balance has unknown pending state');

console.log('\n=== null/missing eligible balances fail closed before coercion ===');
ok(Number(null) === 0,
  'Number(null) is 0 — the coercion trap that must not omit an eligible debt');
const nullBalanceDebts = debts.map(d => Object.assign({}, d));
nullBalanceDebts.find(d => d.id === 'high').balance = null;
const independentlyOmitted = nullBalanceDebts.filter(d =>
  (d.id === 'heloc' || (!d.secured && /^Revolving/.test(d.structure || '')))
  && isFinite(Number(d.balance)) && Number(d.balance) > 0);
ok(independentlyOmitted.some(d => d.id === 'low')
  && independentlyOmitted.some(d => d.id === 'heloc')
  && !independentlyOmitted.some(d => d.id === 'high'),
  'coercing null to 0 would drop High card and leave Low card and HELOC owing');
const nullPriority = F.debtPriority(fixture(300), nullBalanceDebts);
ok(nullPriority.status === 'unavailable' && nullPriority.target === null
  && /unknown balance/.test(nullPriority.reason),
  'an eligible null balance names no target');
const nullAlloc = F.paydayAllocation(fixture(300), '2026-09-01',
  Object.assign({}, opts, { debts: nullBalanceDebts }));
ok(near(nullAlloc.extraDebt.allocated, 0) && nullAlloc.extraDebt.target === null,
  'null-balance fail-closed allocates no extra principal and names no target');
ok(near(nullAlloc.identity, nullAlloc.available),
  'the payday identity still reconciles when a null balance fails closed');
const missingBalanceDebts = debts.map(d => Object.assign({}, d));
delete missingBalanceDebts.find(d => d.id === 'high').balance;
const missingPriority = F.debtPriority(fixture(300), missingBalanceDebts);
ok(missingPriority.status === 'unavailable' && missingPriority.target === null
  && /unknown balance/.test(missingPriority.reason),
  'a missing eligible balance names no target');
const nonFiniteDebts = debts.map(d => Object.assign({}, d));
nonFiniteDebts.find(d => d.id === 'high').balance = Number.NaN;
const nonFinitePriority = F.debtPriority(fixture(300), nonFiniteDebts);
ok(nonFinitePriority.status === 'unavailable' && nonFinitePriority.target === null,
  'a non-finite eligible balance names no target');

console.log('\n=== unknown pending holds residual beyond proven posted exposure ===');
const unknownPendingDebts = debts.map(d => Object.assign({}, d));
const highCard = unknownPendingDebts.find(d => d.id === 'high');
highCard.pendingUnknown = true;
highCard.pending = null;
const provenPosted = Number(highCard.balance); // 50 — pending is unknown, not $0
const lowerPriorityPosted = unknownPendingDebts
  .filter(d => d.id === 'low' || d.id === 'heloc')
  .reduce((sum, d) => sum + Number(d.balance), 0); // 40 + 60
const optionalNeed = 100;
ok(provenPosted === 50 && lowerPriorityPosted === 100 && optionalNeed === 100,
  'independent fixture: High posted $50; Low+HELOC $100; optional $100');
const pendingPriority = F.debtPriority(fixture(300), unknownPendingDebts);
ok(pendingPriority.status === 'ready' && pendingPriority.target.id === 'high'
  && /unknown pending/.test(pendingPriority.reason),
  'positive posted still names the highest-interest target and surfaces the trust reason');
const pendingAlloc = F.paydayAllocation(fixture(300), '2026-09-01',
  Object.assign({}, opts, { debts: unknownPendingDebts }));
ok(near(pendingAlloc.extraDebt.allocated, provenPosted)
  && pendingAlloc.extraDebt.target && pendingAlloc.extraDebt.target.id === 'high'
  && pendingAlloc.extraDebt.target.id !== 'low',
  'extra principal stops at proven posted exposure and does not assert a later target',
  `extra ${pendingAlloc.extraDebt.allocated}; proven posted ${provenPosted}`);
ok(!(pendingAlloc.optional || []).some(row => row.allocated > 0),
  'unproven leftover is not released to optional residual');
ok(near(pendingAlloc.unallocated,
    alloc.unallocated + (alloc.extraDebt.allocated - provenPosted) + optionalNeed),
  'the withheld lower-priority extra and optional residual remain unallocated',
  `held ${pendingAlloc.unallocated}; baseline unallocated ${alloc.unallocated}`);
ok(near(pendingAlloc.identity, pendingAlloc.available),
  'the payday identity still reconciles when residual is held');
ok((pendingAlloc.risks || []).some(row =>
    row.id === 'extra-debt-pending-unknown' && /unknown pending/.test(row.reason)),
  'the held residual surfaces the unknown-pending trust reason');

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
