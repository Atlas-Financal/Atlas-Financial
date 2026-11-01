'use strict';
/* 2026-08-16 household-evidence absorption.
 * `node test/test-aug16-evidence.js`
 *
 * Independent proofs for the authorised canonical cleanup. Does not invent a
 * second Forecast, and does not redo PR #79 pending-transaction logic.
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const data = require('./fixtures/retired-fuel-policy')(
  require('./fixtures/retired-other-policy')(require('../data.json')));
// The September minimum was confirmed after this historical evidence window.
// Isolate only that later override in the cloned fixture; retain all August assertions.
const historicalMbna = data.plan.obligations.find(row => row.id === 'mbna');
if (historicalMbna?.statementOccurrences) historicalMbna.statementOccurrences =
  historicalMbna.statementOccurrences.filter(record => record.scheduledDate !== '2026-09-30');
const { execFileSync } = require('child_process');
const AUG16_REV = '28d08a12a18691f34c32bc839d22cd526fc75111';
function gitJson(spec) {
  return JSON.parse(execFileSync('git', ['show', spec], { encoding: 'utf8', cwd: path.join(__dirname, '..') }));
}
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const money = n => Number(n).toFixed(2);

const questions = sourceText(fs.readFileSync(path.join(__dirname, '..', 'docs/01_OPEN_QUESTIONS.md'), 'utf8'));
const plan = data.plan;
const asOf = data.meta.asOf;
const aug16 = gitJson(`${AUG16_REV}:data.json`);
const windowEnd = F.addDays(asOf, (plan.windowDays || 91) - 1);
const tennis = (plan.startingCash.heldElsewhere || []).find(h => h.id === 'amanda-debt-payments');
const spendable = F.startingCashAmount(plan);
const independentSpendable = (plan.startingCash.breakdown || [])
  .filter(r => r && (r.id === 'chequing-a' || r.id === 'chequing-b'))
  .reduce((s, r) => s + Number(r.value || 0), 0);
const aug16Spendable = F.startingCashAmount(aug16.plan);
const aug16Independent = (aug16.plan.startingCash.breakdown || [])
  .filter(r => r && (r.id === 'chequing-a' || r.id === 'chequing-b'))
  .reduce((s, r) => s + Number(r.value || 0), 0);

function statusOf(id) {
  const re = new RegExp('### ' + id + '\\.[\\s\\S]*?\\*\\*Status:\\*\\*\\s*([^\\n]+)');
  const m = re.exec(questions);
  return m ? m[1].trim() : null;
}

console.log('=== 1. TENNIS INCOME does not inflate household starting cash ===');
{
  ok(!!tennis && tennis.id === 'amanda-debt-payments',
    'canonical identity remains amanda-debt-payments');
  ok(/TENNIS INCOME/.test(tennis.label),
    'display name is TENNIS INCOME', tennis.label);
  ok(tennis.class === 'operational' && near(tennis.value, 2691.85),
    'held-elsewhere operational balance is unchanged', money(tennis.value));
  ok(near(spendable, independentSpendable),
    'live starting cash is household chequing only', money(spendable));
  ok(near(aug16Spendable, aug16Independent) && near(aug16Spendable, 2252.18),
    'pinned 2026-08-16 opening chequing spendable remains independently $2,252.18', money(aug16Spendable));
  ok(Math.abs(spendable - (independentSpendable + tennis.value)) > 1,
    'adding TENNIS INCOME would inflate opening cash — and is not done');
}

console.log('\n=== 2. old garage/lab transfer is not forecast as ongoing income ===');
{
  const ids = (plan.income || []).map(s => s.id);
  ok(!ids.includes('garageRent') && !ids.includes('labRent') && !ids.includes('garageLab'),
    'no garage/lab income stream exists on the plan');
  const hay = JSON.stringify(plan.income);
  ok(!/1,?100/.test(hay),
    'no $1,100 garage/lab rent figure lives on plan.income');
  ok(ids.includes('amandaSalary15') && ids.includes('amandaSalaryMonthEnd'),
    'Amanda household income is the two Tennis BC salary streams');
  ok(!ids.includes('amandaTransfer'),
    'retired amandaTransfer stream is not the garage/lab stand-in');
  ok(/^ANSWERED\b/.test(statusOf('Q5')), 'Q5 is ANSWERED', statusOf('Q5'));
  ok(!plan.income.some(s => /garage|lab rent/i.test(s.label + (s.note || ''))),
    'no income row is labelled as garage/lab rent');
}

console.log('\n=== 3. School & clubs is consistently ESSENTIAL ===');
{
  const school = plan.budget.categories.find(c => c.id === 'school');
  ok(school && school.class === 'essential',
    'plan.budget school class is essential', school && school.class);
  ok(/^ANSWERED\b/.test(statusOf('Q24')), 'Q24 is ANSWERED', statusOf('Q24'));
  ok(/essential/i.test(statusOf('Q24') + questions),
    'canonical question records essential');
  const targets = plan.budget.categories.filter(c =>
    c.targetSource === 'owner-stated-2026-08-31'
    && ((c.plannedMonthly != null && c.plannedMonthly !== 0)
      || c.plannedWeekly != null || c.plannedPayday != null));
  ok(targets.length === 5, 'five remaining 2026-08-31 owner targets (payday holds other than Groceries)');
  const otherSpend = plan.budget.categories.find(c => c.id === 'other-spend');
  ok(otherSpend && otherSpend.plannedMonthly === 800
      && otherSpend.targetSource === 'owner-stated-2026-09-18',
    'Other spend $800/month is the later owner lock, not a sixth 2026-08-31 target');
  ok(school.plannedMonthly == null, 'school still has no owner monthly target');
}

console.log('\n=== 4. old Hydro arrears is not a future obligation ===');
{
  const hydro = (plan.bills || []).filter(b => /hydro/i.test(b.id + b.label));
  ok(!hydro.some(b => b.id === 'hydro-due-now' || near(b.amount, 213.79)),
    'no $213.79 / hydro-due-now future bill');
  ok(!hydro.some(b => near(b.amount, 451.24)),
    'the $451.24 account balance is not scheduled');
  const sep = hydro.find(b => b.id === 'hydro-due-sep1');
  ok(sep && near(sep.amount, 237.45) && sep.date === '2026-09-01',
    'Sep. 1 $237.45 Hydro remains');
  ok(/^ANSWERED\b/.test(statusOf('Q17')), 'Q17 arrears portion is ANSWERED', statusOf('Q17'));
}

console.log('\n=== 5. Telus does not recur after owner-confirmed closure ===');
{
  ok(!(plan.bills || []).some(b => /telus/i.test(b.id + b.label)),
    'no Telus plan.bills row');
  ok(/TELUS IS CLOSED/.test(plan.billsNote),
    'billsNote records Telus closed');
  ok(/^OPEN\b/.test(statusOf('Q18')),
    'Q18 remains open for Bell settlement state', statusOf('Q18'));
  ok(/second Bell\/watch account is still\s+active/i.test(questions),
    'Q18 keeps the owner-stated separate Bell/watch account');
  ok(/TELUS IS CLOSED/.test(questions),
    'open-questions file records Telus closed');
  ok(/not a telecom-cost question/i.test(questions)
    || /contributes \*\*\$0\*\* forward/i.test(questions),
    'Q18 no longer treats Telus as an open cost question');
  const facts = sourceText(fs.readFileSync(path.join(__dirname, '..', 'docs/ACCOUNT_FACTS.md'), 'utf8'));
  ok(/TELUS IS CLOSED/.test(facts),
    'ACCOUNT_FACTS records Telus closed');
  ok(/Future Telus cost is \*\*\$0\*\*/i.test(facts)
    || /Future Telus cost is \$0/i.test(facts),
    'ACCOUNT_FACTS records Telus $0 forward');
  ok(/no remaining Telus planning question/i.test(facts),
    'ACCOUNT_FACTS closes Telus as a planning question');
  ok(!/Do not zero the remainder/.test(facts),
    'ACCOUNT_FACTS no longer forbids replacing the historical remainder');
  ok(/\$104\.20/.test(facts) && /June/.test(facts),
    'ACCOUNT_FACTS records the June Bell baseline rather than leaving the remainder as Telus');
  const backlog = sourceText(fs.readFileSync(path.join(__dirname, '..', 'BACKLOG.md'), 'utf8'));
  const telusFollowUp = (backlog.match(
    /Historical Telus in the telecom remainder[\s\S]*?(?=Bell baseline vs card-paid)/,
  ) || [''])[0];
  ok(telusFollowUp.length > 0,
    'BACKLOG still has the Historical Telus remainder follow-up');
  ok(/\bCLOSED\b/.test(telusFollowUp) && /\$0/.test(telusFollowUp),
    'Telus remainder follow-up is CLOSED at $0 forward');
  ok(!/\bOPEN\b/.test(telusFollowUp),
    'Telus remainder follow-up is not left OPEN');
  const periods = require('../public/periods.json');
  const shaw = (plan.bills || []).find(b => b.id === 'shaw');
  const ytdTelecom = periods.periods.ytd.spending.find(s => s.label === 'Telecom');
  const lastTelecom = periods.periods.lastMonth.spending.find(s => s.label === 'Telecom');
  const allTelecom = periods.periods.all.spending.find(s => s.label === 'Telecom');
  const ytdAvg = ytdTelecom.total / periods.periods.ytd.months;
  ok(near(ytdTelecom.total, 2149.91) && periods.periods.ytd.months === 8,
    'cleaned YTD Telecom historical total is $2,149.91 over 8 months');
  ok(near(ytdAvg, 268.73875),
    'independent cleaned YTD Telecom average is $268.74/month', money(ytdAvg));
  ok(shaw && near(shaw.amount, 78.4) && shaw.budgetCategory === 'telecom',
    'current dated Shaw is $78.40 once', money(shaw.amount));
  ok(near(ytdAvg - shaw.amount, 190.33875),
    'independent cleaned historical remainder after Shaw is $190.34/month',
    money(ytdAvg - shaw.amount));
  ok(near(lastTelecom.total, 328.40),
    'July 2026 Telecom (after Telus closed) is $328.40', money(lastTelecom.total));
  ok(near(78.4 + 250, 328.40) && near(lastTelecom.total, shaw.amount + 250),
    'July independently equals Shaw $78.40 + $250.00 non-Shaw remainder');
  ok(near(allTelecom.total, 3916.38),
    'cleaned full-history Telecom is $3,916.38', money(allTelecom.total));
}

console.log('\n=== 6. Noble quarterly garbage without duplicating history ===');
{
  const noble = (plan.bills || []).find(b => b.id === 'noble-garbage');
  ok(noble && near(noble.amount, 95.85) && noble.day === 18
    && noble.frequency === 'quarterly' && noble.firstDue === '2026-09-18'
    && noble.anchor === '2026-03-18' && noble.budgetCategory === 'household'
    && noble.date == null,
    'Noble is the quarterly $95.85 household bill, firstDue 2026-09-18');
  const events = F.expandEvents(plan, asOf, windowEnd, { keepRepresented: true });
  const nobleEvents = events.filter(e => e.id === 'noble-garbage');
  ok(nobleEvents.length === 1 && nobleEvents[0].date === '2026-09-18'
    && near(nobleEvents[0].amount, -95.85),
    'exactly one Noble cash event in the 91-day window');
  ok(!F.expandEvents(plan, asOf, windowEnd, {}).some(e => e.id === 'noble-garbage'),
    'Dale-gated representedEvents omits that September due from the cash walk');
  ok(!events.some(e => e.id === 'noble-garbage' && e.date === '2026-03-18'),
    'March 18 history is not duplicated as a future event');
  ok(!events.some(e => e.id === 'noble-garbage' && e.date === '2026-06-18'),
    'June 18 is not invented as arrears');
}

console.log('\n=== 7–9. Aug. 16 Triangle/MBNA screenshots are that opening ===');
{
  ok(aug16.meta.asOf === '2026-08-16', 'pinned 28d08a12 canonical asOf is 2026-08-16');
  const tri = aug16.debts.find(d => d.id === 'triangle');
  const mbna = aug16.debts.find(d => d.id === 'mbna');
  ok(tri && near(tri.balance, 13197) && near(tri.pending, 15.62),
    'Triangle opening is the 16 August posted $13,197.00 + pending $15.62',
    `${money(tri.balance)} + ${money(tri.pending)}`);
  ok(mbna && near(mbna.balance, 8003.61) && near(mbna.pending, 0),
    'MBNA opening is 16 August posted $8,003.61 + pending $0.00',
    `${money(mbna.balance)} + ${money(mbna.pending)}`);
  ok(!near(tri.balance, 13497) && !near(mbna.balance, 7855.12),
    'the stale 9 August posted figures are not this opening');

  const obs = require(path.join(__dirname, '..', 'docs/reconciliation/card-state-observations.json')).observations;
  const triPosted = obs.find(o => o.observationId === 'card-triangle-posted-2026-08-16');
  const triPend = obs.find(o => o.observationId === 'card-triangle-pending-2026-08-16');
  const mbPosted = obs.find(o => o.observationId === 'card-mbna-posted-2026-08-16');
  const mbPend = obs.find(o => o.observationId === 'card-mbna-pending-2026-08-16');
  ok(triPosted && near(triPosted.amount, 13197) && triPend && near(triPend.amount, 15.62),
    'Aug. 16 Triangle observation keeps posted $13,197.00 and pending $15.62 separate');
  const obsExposure = Math.round((triPosted.amount + triPend.amount) * 100) / 100;
  ok(near(obsExposure, 13212.62) && !near(triPosted.amount, obsExposure),
    'independent observed exposure is posted+pending $13,212.62', money(obsExposure));
  ok(mbPosted && near(mbPosted.amount, 8003.61) && mbPend && near(mbPend.amount, 0)
    && !near(mbPosted.amount, 7855.12),
    'Aug. 16 MBNA observation is $8,003.61 pending $0, not rounded to the statement');

  const hay = [
    tri.note,
    (plan.obligations.find(o => o.id === 'triangle') || {}).note,
    JSON.stringify(obs.filter(o => /triangle.*2026-08-1[06]/.test(o.observationId))),
  ].join(' ');
  ok(/2026-08-10|Aug\. 10/.test(hay) && /\$300/.test(hay),
    'Aug. 10 $300 payment is recorded');
  ok(/on-time/i.test(hay) && /not proven/i.test(hay),
    'on-time status is not invented');
  ok(/287\.38/.test(hay) && /not household cash|never cash|not cash/i.test(hay),
    'available credit is not converted to household cash');

  const once = plan.obligations.find(o => o.id === 'mbna-aug31');
  const monthly = plan.obligations.find(o => o.id === 'mbna');
  ok(once && once.frequency === 'once' && once.date === '2026-08-31'
    && once.confidence === 'confirmed' && near(once.amount, 158.27),
    'Aug. 31 MBNA statement minimum is a confirmed one-time row');
  ok(monthly && monthly.frequency === 'monthly' && monthly.firstDue === '2026-09-30'
    && monthly.confidence === 'estimated' && near(monthly.amount, 158.27),
    'later MBNA minimums remain estimated from 2026-09-30');
  const events = F.expandEvents(plan, asOf, windowEnd, {});
  const mbnaEvents = events.filter(e => e.id === 'mbna' || e.id === 'mbna-aug31');
  const aug31 = mbnaEvents.find(e => e.date === '2026-08-31');
  ok(aug31 && aug31.confidence === 'confirmed' && near(Math.abs(aug31.amount), 158.27),
    'Forecast emits the Aug. 31 minimum as confirmed');
  ok(mbnaEvents.filter(e => e.date > '2026-08-31')
    .every(e => e.confidence === 'estimated' && e.id === 'mbna'),
    'later MBNA cash events are the estimated recurrence, not confirmed');
  ok(!mbnaEvents.some(e => e.date === '2026-08-31' && e.id === 'mbna'),
    'the monthly row does not double-count August');
  ok(/21\.74/.test(mbna.rateBasis) && near(mbna.rate, 21.74),
    'purchase APR 21.74% comes from the statement');
  ok(/22\.99/.test(mbna.rateBasis),
    'cash advance / BT APR 22.99% comes from the statement');
  ok(mbna.nextDue === '2026-08-31', 'due date 2026-08-31');
  ok(near(mbna.annualInterest, 1779.24),
    'annualInterest remains $148.27 × 12', money(mbna.annualInterest));
}

console.log('\n=== 10–11. stale Fusion 3 × $500 gone; future estimate is not a confirmed invoice ===');
{
  const ids = (plan.commitments || []).map(c => c.id);
  ok(!ids.includes('fusion-sep') && !ids.includes('fusion-oct') && !ids.includes('fusion-nov'),
    'the three live-plan $500 Fusion rows are gone');
  const events = F.expandEvents(plan, asOf, windowEnd, {});
  ok(!events.some(e => /fusion-sep|fusion-oct|fusion-nov/.test(e.id)
    || (e.label && /Fusion season —/.test(e.label) && near(Math.abs(e.amount), 500))),
    'Forecast emits no confirmed $500 Fusion season cash events');
  ok(!(plan.commitments || []).some(c => c.id === 'fusion-season'),
    'stale fusion-season $2,000 row is gone');
  const fusionRemaining = (plan.commitments || [])
    .filter(c => /^fusion-household-(oct|nov|dec)$/.test(c.id))
    .reduce((s, c) => s + (c.amount || 0), 0);
  ok(near(fusionRemaining, 3300),
    'remaining Fusion schedule is $3,300 (Oct/Nov/Dec), independent of paid portion',
    money(fusionRemaining));
  const fusionPaid = (plan.commitments || []).find(c => c.id === 'fusion-household-paid');
  ok(fusionPaid && near(fusionPaid.amount, 1200) && fusionPaid.settledOn === '2026-09-10',
    'paid $1,200 settledOn 2026-09-10 (Interac); remaining instalments separate');
  ok(/^ANSWERED\b/.test(statusOf('Q23')), 'Q23 is ANSWERED', statusOf('Q23'));
}

console.log('\n=== 12–13. Burrards registrations settled; team fees follow the approved current roster ===');
{
  const b1 = plan.commitments.find(c => c.id === 'burrard1');
  const b2 = plan.commitments.find(c => c.id === 'burrard2');
  ok(b1 && b1.settledOn === '2026-08-16' && b2 && b2.settledOn === '2026-08-16',
    'both Burrards registrations are settledOn 2026-08-16');
  const events9 = F.expandEvents(plan, asOf, windowEnd, {});
  const eventsBefore = F.expandEvents(plan, '2026-08-09', F.addDays('2026-08-09', 90), {});
  ok(eventsBefore.some(e => e.id === 'burrard1') && eventsBefore.some(e => e.id === 'burrard2'),
    'an Aug. 9 start still reserves them (settledOn is after that start)');
  const events16 = F.expandEvents(plan, '2026-08-16', F.addDays('2026-08-16', 90), {});
  ok(!events16.some(e => e.id === 'burrard1' || e.id === 'burrard2'),
    'an Aug. 16 opening omits the paid registrations');
  const feeIds = ['burrards-logan-team-fee-oct', 'burrards-logan-team-fee-nov', 'burrards-linden-team-fee'];
  ok(feeIds.every(id => plan.commitments.some(c => c.id === id && c.settledOn === '2026-10-31')),
    'owner-approved Oct 1 team fees are owner-confirmed PAID, settledOn 2026-10-31 (evidence date); separate input regression proves amounts/dates');
  ok(!plan.commitments.some(c => c.id === 'burrards-team-fees'),
    'the superseded September estimate is not retained beside the settled replacements');
}

console.log('\n=== 14–15. Bell baseline is not $356.62; pending $250 is not double-counted ===');
{
  ok((plan.bills || []).some(b => b.id === 'bell' && b.day === 15
      && b.needsDate !== true && near(b.amount, 160)
      && b.firstDue === '2026-10-15'
      && b.payingAccount === 'chequing-a' && b.jointCash !== false),
    'Bell is dated $160 from BILLS ACCOUNT on the 15th from October');
  ok(!(plan.bills || []).some(b => near(b.amount, 356.62)
      || near(b.amount, 104.20) || near(b.amount, 16.80)),
    'neither $356.62, $104.20, nor $16.80 is a separate cash bill');
  const facts = fs.readFileSync(path.join(__dirname, '..', 'docs/ACCOUNT_FACTS.md'), 'utf8');
  ok(/\$356\.62/.test(facts) && /104\.20/.test(facts),
    'ACCOUNT_FACTS records the Aug bill and the June baseline separately');
  ok(/inferred residual/i.test(facts) && /\$250/.test(facts),
    'the $250 pending payment is recorded without marking Bell fully settled');
  ok(!/second Bell \$250 expense/i.test(JSON.stringify(plan.bills)),
    'plan.bills does not invent a second Bell $250 expense');
}

console.log('\n=== 16–18. HELOC interest posting and cash payment stay distinct; Aug. 1 not silently paid ===');
{
  const heloc = plan.obligations.find(o => o.id === 'heloc');
  const debt = data.debts.find(d => d.id === 'heloc');
  ok(heloc && heloc.nonCash === true && near(heloc.amount, 814.18),
    'HELOC obligation remains non-cash $814.18');
  ok(debt && near(debt.cashPayment, 0) && debt.interestTreatment === 'capitalised',
    'cashPayment stays $0; interest is capitalised');
  const events = F.expandEvents(plan, asOf, windowEnd, {});
  ok(!events.some(e => e.id === 'heloc' && e.kind === 'obligation'
      && e.date < (heloc.cashFirstDue || '2026-09-21')),
    'no HELOC chequing outflow before cashFirstDue');
  ok(events.some(e => e.id === 'heloc' && e.kind === 'obligation'
      && e.date >= heloc.cashFirstDue && near(-e.amount, heloc.cashPayment)),
    'from cashFirstDue the encoded cash minimum is one chequing obligation');
  ok(!events.some(e => e.id === 'heloc' && e.date === '2026-08-01'),
    'Aug. 1 PAD is not fabricated as a cash event');
  ok(/^ANSWERED\b/.test(statusOf('Q19')), 'Q19 is ANSWERED', statusOf('Q19'));
  ok(/\$0 additional/i.test(questions) && /14 August/i.test(questions),
    'Q19 records $0 additional August HELOC cash after the 14 August payment');
  ok(!/no cash leaves any account for it/i.test(data.upcomingNote),
    'upcomingNote does not claim interest is free');
  ok(/Forecast opening|2026-08-19|2026-08-16/i.test(data.upcomingNote)
    && /settled/i.test(data.upcomingNote),
    'upcomingNote is the current Forecast opening and records settled Burrards/Fusion');
  const util = F.utilisation(data.debts, data.revolvingExtra, data.plan);
  ok(typeof util.totalAvailable === 'number' && util.totalAvailable > 0,
    'upcomingNote credit headroom is derived from this opening',
    money(util.totalAvailable));
  const pinnedPending = aug16.debts
    .filter(d => !d.pendingUnknown)
    .reduce((s, d) => s + Number(d.pending || 0), 0);
  ok(aug16.debts.find(d => d.id === 'cashback').pendingUnknown === true,
    'pinned 16 Aug Cash Back pending is unknown, not $0');
  ok(near(pinnedPending, 15.62 + 250),
    'pinned 16 Aug known pending is Triangle $15.62 + Travel Visa Bell $250.00',
    money(pinnedPending));
}

console.log('\n=== 19. Q20 and Q21 remain unresolved ===');
{
  ok(/^OPEN\b/.test(statusOf('Q20')), 'Q20 emergency reserve remains OPEN', statusOf('Q20'));
  ok(/^OPEN\b/.test(statusOf('Q21')), 'Q21 $527.80 remains OPEN', statusOf('Q21'));
  ok(/does \*\*not\*\* currently know|does not currently know/i.test(questions),
    'Q20 records that the owner does not know the emergency-cash target');
}

console.log('\n=== 2026-08-31 owner budget targets ===');
{
  const want = {
    fuel: 325, restaurants: 200,
    'dale-guilt-free': 150, 'amanda-guilt-free': 150,
  };
  for (const [id, amt] of Object.entries(want)) {
    const c = plan.budget.categories.find(x => x.id === id);
    ok(c && near(c.plannedPayday, amt) && c.plannedMonthly == null,
      `${id} plannedPayday still ${amt}`);
  }
  {
    const g = plan.budget.categories.find(x => x.id === 'groceries');
    ok(g && g.plannedPayday === 900 && g.plannedMonthly == null
        && g.plannedWeekly == null
        && g.targetSource === 'owner-stated-2026-09-22',
      'groceries plannedPayday is 900 per Seaspan pay period; plannedMonthly is not a second target');
  }
  {
    const p = plan.budget.categories.find(x => x.id === 'pets');
    ok(p && p.plannedPayday === 100 && p.plannedMonthly == null,
      'dog food plannedPayday is 100, plannedMonthly is not 55');
  }
  {
    const h = plan.budget.categories.find(x => x.id === 'household');
    ok(h && h.plannedMonthly === 0 && h.plannedPayday == null,
      'household explicit planning baseline is $0 monthly, not a payday hold');
  }
  for (const id of ['health', 'sport', 'shopping', 'subscriptions']) {
    const c = plan.budget.categories.find(x => x.id === id);
    ok(c && c.plannedMonthly == null && c.plannedPayday == null,
      `${id} is not a household-budget owner target`);
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
