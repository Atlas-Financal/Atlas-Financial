'use strict';
/* 2026-08-29 Q1 planning-policy write.
 * `node test/test-q1-planning-policy.js`
 *
 * Proves Forecast does not treat coaching as household income, Q1 stays OPEN
 * with the owner 2026-08-29 note, Q12 and Q25 stay OPEN, and TENNIS INCOME
 * stays out of spendable starting cash. Does not invent a coaching stream,
 * a margin, or a second income engine.
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const data = require('../data.json');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const money = n => Number(n).toFixed(2);

const questions = sourceText(fs.readFileSync(path.join(__dirname, '..', 'docs/01_OPEN_QUESTIONS.md'), 'utf8'));
const facts = fs.readFileSync(path.join(__dirname, '..', 'docs/ACCOUNT_FACTS.md'), 'utf8');
const context = fs.readFileSync(path.join(__dirname, '..', 'CONTEXT.md'), 'utf8');
const interview = fs.readFileSync(
  path.join(__dirname, '..', 'docs/household_interviews/DALE_2026-08-29_COACHING_PLANNING.md'),
  'utf8'
);
const plan = data.plan;

function statusOf(id) {
  const re = new RegExp('### ' + id + '\\.[\\s\\S]*?\\*\\*Status:\\*\\*\\s*([^\\n]+)');
  const m = re.exec(questions);
  return m ? m[1].trim() : null;
}

function qBody(id) {
  const re = new RegExp('### ' + id + '\\.[\\s\\S]*?(?=\\n### |$)');
  const m = re.exec(questions);
  return m ? m[0] : '';
}

const PLAN_INCOME_IDS = ['amandaSalary15', 'amandaSalaryMonthEnd', 'childBenefit', 'payroll'];

console.log('=== Q1 stays OPEN with the 2026-08-29 owner facts ===');
{
  ok(/^OPEN\b/.test(statusOf('Q1')), 'Q1 status is OPEN', statusOf('Q1'));
  const body = qBody('Q1');
  ok(/2026-08-29/.test(body), 'Q1 records the 2026-08-29 owner statement');
  ok(/no shop\s*\/\s*resale\s*\/\s*inventory business/i.test(body),
    'Q1 kills the inventory/resale theory for current planning');
  ok(/gravy/i.test(body) && /not a recurring income line/i.test(body),
    'Q1 records leftover coaching as gravy, not a Forecast income line');
  ok(/do not invent a margin/i.test(body),
    'Q1 forbids inventing a margin, COGS, or split');
  ok(/\$19,700/.test(body) && /may be\s+coach pay/i.test(body),
    'Q1 keeps unmatched outbound as maybe-coach-pay, not fact');
  ok(/Planning settlement does not\s+close this question/i.test(body),
    'Q1 is not closed because planning is settled');
  ok(!/\*\*Status:\*\*\s*ANSWERED/i.test(body),
    'Q1 heading status is not ANSWERED');
}

console.log('\n=== Q12 and Q25 stay OPEN ===');
{
  ok(/^OPEN\b/.test(statusOf('Q12')), 'Q12 status is OPEN', statusOf('Q12'));
  ok(/no inventory\s*\/\s*resale\s*\/\s*shop business\s+going forward/i.test(qBody('Q12')),
    'Q12 notes there is no inventory business going forward');
  ok(/does not close this question/i.test(qBody('Q12')),
    'Q12 is not closed without a spending reclass');
  ok(/^OPEN\b/.test(statusOf('Q25')), 'Q25 status is OPEN', statusOf('Q25'));
  ok(/gravy/i.test(qBody('Q25')) && /does not make this mixed remainder\s+spendable/i.test(qBody('Q25')),
    'Q25 records leftover as gravy and keeps the mixed remainder non-spendable');
}

console.log('\n=== standing facts and chat context do not describe resale as current planning ===');
{
  ok(/Household income the plan uses/i.test(facts) && /2026-08-29/.test(facts),
    'ACCOUNT_FACTS has the 2026-08-29 planning-income section');
  ok(/no shop\s*\/\s*resale\s*\/\s*inventory business/i.test(facts),
    'ACCOUNT_FACTS records no shop/resale/inventory business');
  ok(/gravy when it actually arrives/i.test(facts),
    'ACCOUNT_FACTS records leftover as gravy');
  ok(/historical coaching P&L \(Q1 stays OPEN/i.test(context),
    'CONTEXT distinguishes historical Q1 from settled planning');
  ok(/no shop\/resale\/inventory business/i.test(context),
    'CONTEXT does not describe a resale business as current planning');
  ok(/OWNER-STATED 2026-08-29/i.test(interview) && /No shop \/ resale \/ inventory business/i.test(interview),
    'attributed 2026-08-29 source is filed');
}

console.log('\n=== live plan.income has no coaching stream ===');
{
  const ids = (plan.income || []).map(s => s.id).sort();
  ok(ids.join(',') === PLAN_INCOME_IDS.slice().sort().join(','),
    'plan.income ids are payroll, child benefit, and Tennis BC salary only',
    ids.join(','));
  ok(!(plan.income || []).some(s => /coach/i.test((s.id || '') + (s.label || ''))),
    'no plan.income row is labelled or id-ed as coaching');
  ok(!(plan.income || []).some(s => s.id === 'amandaTransfer'),
    'retired amandaTransfer stream stays gone');
}

console.log('\n=== independent: a coaching stream would count; live plan has none ===');
{
  const start = '2026-08-31';
  const fixture = {
    windowDays: 30,
    defaults: { targetBuffer: 0 },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 100, class: 'spendable' }, { id: 'chequing-b', value: 0 }] },
    income: [
      { id: 'payroll', label: 'Pay', frequency: 'once', date: '2026-09-01', amount: 1000, confidence: 'confirmed' },
      { id: 'coaching', label: 'Coaching leftover', frequency: 'once', date: '2026-09-01', amount: 400, confidence: 'estimated' },
    ],
    obligations: [],
    bills: [],
    commitments: [],
  };
  const withCoach = F.simulate(fixture, start, { weeklyVariable: 0, targetBuffer: 0 });
  const without = JSON.parse(JSON.stringify(fixture));
  without.income = fixture.income.filter(s => s.id !== 'coaching');
  const noCoach = F.simulate(without, start, { weeklyVariable: 0, targetBuffer: 0 });
  ok(near(withCoach.totals.income, 1400),
    'if a coaching stream were on the plan, Forecast would count $400',
    money(withCoach.totals.income));
  ok(near(noCoach.totals.income, 1000),
    'without that stream, Forecast income is payroll only',
    money(noCoach.totals.income));
  ok(near(withCoach.ending - noCoach.ending, 400),
    'the $400 is the independent difference in ending cash');
}

console.log('\n=== TENNIS INCOME stays out of spendable starting cash ===');
{
  const breakdown = plan.startingCash.breakdown || [];
  const held = plan.startingCash.heldElsewhere || [];
  const spendable = breakdown
    .filter(r => r && (r.id === 'chequing-a' || r.id === 'chequing-b'))
    .reduce((s, b) => s + Number(b.value || 0), 0);
  ok(!breakdown.some(r => r.id === 'amanda-debt-payments'),
    'TENNIS INCOME is not in the spendable breakdown');
  ok(held.some(r => r.id === 'amanda-debt-payments'),
    'TENNIS INCOME remains held-elsewhere');
  ok(near(F.startingCashAmount(plan), spendable),
    'Forecast opening cash is the independently summed household chequing accounts',
    money(F.startingCashAmount(plan)));
}

console.log('\n=== Deep Dive does not publish a current monthly coaching net ===');
{
  const warning = String(data.incomeWarning || '');
  const coaching = (data.income || []).find(r => /coach/i.test(r.label || ''));
  ok(/historical inbound receipts/i.test(warning) && /2026-08-29/.test(warning),
    'incomeWarning is the 2026-08-29 planning caveat');
  ok(!/overstated by (?:up to |about |roughly )?(?:~)?\$[\d,]+(?:\.\d+)?\/month/i.test(warning),
    'incomeWarning does not publish a current monthly overstatement');
  ok(!/\$1,?700\/month of (?:genuine |real )?coaching income/i.test(warning),
    'incomeWarning does not present $1,700/month as current coaching income');
  ok(coaching && /REVENUE/i.test(coaching.stability || ''),
    'historical coaching receipts stay labelled REVENUE, not income');
  ok(coaching && !/about 72%/i.test(coaching.stability || ''),
    'Deep Dive coaching stability does not invent a 72% split');
  ok(/Q1 stays OPEN/i.test((data.questions || [])[0].detail || ''),
    'Deep Dive Q1 card does not independently close the question');
}

if (failures) {
  console.log('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nAll checks passed.');
