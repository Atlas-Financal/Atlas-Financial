'use strict';
/* B91 D4+D5 — dated household obligation vs account balance / paying account.
 *
 * Acceptance corpus: docs/source_intake/PAYDAY_ACCEPTANCE_2026-08-14.md
 * Live Hydro: the 1 September dated due is now canonical; the 14 August
 * due is not. This suite still proves the mechanism on synthetic fixtures.
 *
 * Independent proof: hand arithmetic on the named dated amounts and the
 * paying-account / breakdown membership rule. That is not a second call
 * to expandEvents or simulate.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const F = require('../public/forecast.js');
const R = require('../scripts/reconcile.js');
const live = require('../data.json');
const utility = require('../docs/reconciliation/utility-observations.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const money = n => '$' + Number(n).toFixed(2);
const clone = x => JSON.parse(JSON.stringify(x));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const START = '2026-08-14';
const END = F.addDays(START, 27);
const OPENING = 2000;
const BALANCE = 451.24;
const DUE_NOW = 213.79;
const DUE_SEP = 237.45;
const DUE_NOW_DATE = '2026-08-14';
const DUE_SEP_DATE = '2026-09-01';
const AMANDA = 'amanda-debt-payments';
const JOINT = 'chequing-a';

function hydroBills(extra) {
  return [
    {
      id: 'hydro-due-now',
      label: 'BC Hydro current due',
      frequency: 'once',
      date: DUE_NOW_DATE,
      amount: DUE_NOW,
      confidence: 'confirmed',
      budgetCategory: null,
      householdObligation: true,
      payingAccount: AMANDA,
    },
    {
      id: 'hydro-due-sep1',
      label: 'BC Hydro due 1 September',
      frequency: 'once',
      date: DUE_SEP_DATE,
      amount: DUE_SEP,
      confidence: 'confirmed',
      budgetCategory: null,
      householdObligation: true,
      payingAccount: AMANDA,
    },
  ].map(b => Object.assign({}, b, extra || {}));
}

function fixture(billExtra) {
  return {
    windowDays: 28,
    defaults: { targetBuffer: 0 },
    startingCash: {
      breakdown: [{ id: JOINT, value: OPENING }],
      heldElsewhere: [{ id: AMANDA, value: 798.37 }],
    },
    income: [],
    obligations: [],
    bills: hydroBills(billExtra),
    commitments: [],
  };
}

function independentlyJoint(bill, plan) {
  if (!bill || bill.householdObligation === false) return false;
  if (!bill.payingAccount) return true;
  const cash = plan.startingCash || {};
  if ((cash.heldElsewhere || []).some(r => r.id === bill.payingAccount)) return false;
  return true;
}

function independentJointCash(plan, start, end) {
  return (plan.bills || [])
    .filter(b => independentlyJoint(b, plan))
    .filter(b => b.frequency === 'once' && b.date >= start && b.date <= end)
    .reduce((s, b) => s + Number(b.amount || 0), 0);
}

function independentObligations(plan, start, end) {
  return (plan.bills || [])
    .filter(b => b.householdObligation !== false)
    .filter(b => b.frequency === 'once' && b.date >= start && b.date <= end)
    .map(b => ({ id: b.id, amount: Number(b.amount), date: b.date }));
}

console.log('=== independent dated-due identity ===');
ok(near(DUE_NOW + DUE_SEP, BALANCE),
  'independent: $213.79 + $237.45 = $451.24',
  money(DUE_NOW + DUE_SEP));
ok(DUE_NOW_DATE === START, 'current due is dated as-of the Aug. 14 observation');
ok(DUE_SEP_DATE > START && DUE_SEP_DATE <= END,
  'Sep. 1 due falls later in the 28-day window');

console.log('\n=== A. $451.24 account balance does not create a cash event ===');
{
  const plan = fixture();
  ok(!plan.bills.some(b => near(b.amount, BALANCE)),
    'fixture has no $451.24 bill row');
  const events = F.expandEvents(plan, START, END, {});
  ok(!events.some(e => near(Math.abs(e.amount), BALANCE)),
    'expandEvents emits no $451.24 cash event');
  const sim = F.simulate(plan, START, { weeklyVariable: 0 });
  ok(!sim.events.some(e => near(Math.abs(e.amount), BALANCE)),
    'simulate stream has no $451.24 event');
}

console.log('\n=== B. $213.79 current due creates exactly one $213.79 obligation ===');
{
  const plan = fixture();
  const independent = independentObligations(plan, START, END)
    .filter(o => o.id === 'hydro-due-now');
  ok(independent.length === 1 && near(independent[0].amount, DUE_NOW)
    && independent[0].date === DUE_NOW_DATE,
    'independent walk: exactly one $213.79 due 2026-08-14');
  const events = F.expandEvents(plan, START, END, {});
  const due = events.filter(e => e.id === 'hydro-due-now');
  ok(due.length === 1 && near(due[0].amount, -DUE_NOW) && due[0].date === DUE_NOW_DATE,
    'expandEvents emits exactly one −$213.79 current-due event');
  ok(due[0].householdObligation === true && due[0].kind === 'bill',
    'current due is a household-obligation bill event');
}

console.log('\n=== C. $237.45 due 2026-09-01 creates exactly one later obligation ===');
{
  const plan = fixture();
  const independent = independentObligations(plan, START, END)
    .filter(o => o.id === 'hydro-due-sep1');
  ok(independent.length === 1 && near(independent[0].amount, DUE_SEP)
    && independent[0].date === DUE_SEP_DATE,
    'independent walk: exactly one $237.45 due 2026-09-01');
  const events = F.expandEvents(plan, START, END, {});
  const due = events.filter(e => e.id === 'hydro-due-sep1');
  ok(due.length === 1 && near(due[0].amount, -DUE_SEP) && due[0].date === DUE_SEP_DATE,
    'expandEvents emits exactly one −$237.45 Sep. 1 event');
}

console.log('\n=== D. dated obligations total $451.24 without scheduling the balance ===');
{
  const plan = fixture();
  const independent = independentObligations(plan, START, END);
  const independentSum = independent.reduce((s, o) => s + o.amount, 0);
  ok(independent.length === 2 && near(independentSum, BALANCE),
    'independent: two dated obligations sum to $451.24');
  const events = F.expandEvents(plan, START, END, {});
  const hydro = events.filter(e => /^hydro-/.test(e.id));
  const hydroSum = hydro.reduce((s, e) => s + -e.amount, 0);
  ok(hydro.length === 2 && near(hydroSum, BALANCE),
    'expandEvents: two Hydro events sum to $451.24', money(hydroSum));
  ok(!plan.bills.some(b => near(b.amount, BALANCE)),
    'the account balance is not a third scheduled row');
}

console.log('\n=== E. paying-account metadata does not erase household obligation ===');
{
  const plan = fixture();
  ok(plan.bills.every(b => F.billIsHouseholdObligation(b)),
    'Forecast helper: both Hydro bills are household obligations');
  ok(plan.bills.every(b => b.payingAccount === AMANDA),
    'both bills name Amanda / DEBT&PAYMENTS as paying account');
  const events = F.expandEvents(plan, START, END, {});
  ok(events.filter(e => /^hydro-/.test(e.id)).length === 2,
    'externally paid Hydro still appears on the expandEvents schedule');
  ok(events.filter(e => /^hydro-/.test(e.id)).every(e => e.householdObligation === true),
    'paying-account metadata left householdObligation true');

  const erased = fixture({ householdObligation: false });
  ok(erased.bills.every(b => b.payingAccount === AMANDA),
    'counterfactual still names the same paying account');
  ok(erased.bills.every(b => !F.billIsHouseholdObligation(b)),
    'only an explicit householdObligation: false drops the obligation');
  ok(F.expandEvents(erased, START, END, {}).filter(e => /^hydro-/.test(e.id)).length === 0,
    'the obligation disappears only when that separate field is false');
}

console.log('\n=== F. no duplicate Hydro amount when account-state and dues are both present ===');
{
  const plan = fixture();
  const events = F.expandEvents(plan, START, END, {});
  ok(events.filter(e => /^hydro-/.test(e.id)).length === 2,
    'account-state evidence does not add a third Hydro event');
  const result = R.reconcile({
    data: { meta: { asOf: START }, plan },
    map: { mappings: [] },
    observations: [],
    settlements: { observations: [] },
    utility,
  });
  const balanceRow = result.rows.find(r => r.observationId === 'payday-hydro-account-balance');
  const nowRow = result.rows.find(r => r.observationId === 'payday-hydro-due-now');
  const sepRow = result.rows.find(r => r.observationId === 'payday-hydro-due-sep1');
  ok(balanceRow && balanceRow.fact === 'account-balance'
    && balanceRow.status === 'MATCH' && balanceRow.scheduled === false,
    'account balance is informational / not scheduled');
  ok(nowRow && nowRow.fact === 'dated-due' && nowRow.status === 'MATCH'
    && near(nowRow.evidenceValue, DUE_NOW),
    'current due matches the modelled $213.79 bill');
  ok(sepRow && sepRow.fact === 'dated-due' && sepRow.status === 'MATCH'
    && near(sepRow.evidenceValue, DUE_SEP),
    'Sep. 1 due matches the modelled $237.45 bill');

  const unrelated = fixture();
  unrelated.bills.push({
    id: 'unrelated-once',
    label: 'Unrelated once-dated bill',
    frequency: 'once',
    date: START,
    amount: BALANCE,
    confidence: 'confirmed',
    householdObligation: true,
  });
  const unrelatedResult = R.reconcile({
    data: { meta: { asOf: START }, plan: unrelated },
    map: { mappings: [] },
    observations: [],
    settlements: { observations: [] },
    utility,
  });
  const unrelatedBalance = unrelatedResult.rows
    .find(r => r.observationId === 'payday-hydro-account-balance');
  ok(unrelatedBalance && unrelatedBalance.status === 'MATCH'
    && unrelatedBalance.scheduled === false,
    'A. unrelated $451.24 bill does not make Hydro account-balance CONFLICT');

  const conflicted = fixture();
  conflicted.bills.push({
    id: 'hydro-account-balance',
    label: 'BC Hydro account balance (wrong)',
    frequency: 'once',
    date: START,
    amount: BALANCE,
    confidence: 'confirmed',
    householdObligation: true,
    payingAccount: AMANDA,
  });
  const bad = R.reconcile({
    data: { meta: { asOf: START }, plan: conflicted },
    map: { mappings: [] },
    observations: [],
    settlements: { observations: [] },
    utility,
  });
  const badBalance = bad.rows.find(r => r.observationId === 'payday-hydro-account-balance');
  ok(badBalance && badBalance.status === 'CONFLICT' && badBalance.scheduled === true,
    'B. explicit hydro-account-balance $451.24 row is CONFLICT');
  ok(nowRow && nowRow.status === 'MATCH' && sepRow && sepRow.status === 'MATCH',
    'C. the two dated Hydro dues do not trigger the account-balance conflict');
}

console.log('\n=== joint-cash treatment: externally paid Hydro is not deducted ===');
{
  const plan = fixture();
  ok(F.startingCashAmount(plan) === OPENING,
    'held-elsewhere $798.37 is not joint spendable cash',
    money(F.startingCashAmount(plan)));
  ok(plan.bills.every(b => F.billAffectsJointCash(b, plan) === false),
    'A. amanda-debt-payments in heldElsewhere → no joint-cash deduction');
  ok(near(independentJointCash(plan, START, END), 0),
    'independent walk: joint-cash Hydro total is $0');

  const events = F.expandEvents(plan, START, END, {});
  ok(events.filter(e => /^hydro-/.test(e.id)).every(e => e.jointCash === false),
    'expandEvents tags both Hydro events jointCash: false');
  const sim = F.simulate(plan, START, { weeklyVariable: 0 });
  ok(near(sim.ending, OPENING),
    'simulate ending is still the $2,000 opening — Hydro is not deducted',
    money(sim.ending));
  ok(near(sim.totals.bills, 0),
    'week.bills cash total does not include the external Hydro');
  ok(sim.events.filter(e => /^hydro-/.test(e.id)).length === 2,
    'Hydro remains visible on the simulate event list');

  const nextPay = F.nextPaymentOut(sim.events, START);
  ok(!nextPay,
    'nextPaymentOut ignores externally paid Hydro — no joint-cash outflow');
  const nextDue = F.nextDue(sim.events, START);
  ok(nextDue && nextDue.what === 'BC Hydro current due' && near(nextDue.amount, DUE_NOW),
    'nextDue still names the household obligation', nextDue && nextDue.what);

  const asJoint = fixture({ payingAccount: JOINT });
  ok(asJoint.bills.every(b => F.billAffectsJointCash(b, asJoint) === true),
    'B. chequing-a in breakdown → joint-cash deduction');
  const jointSim = F.simulate(asJoint, START, { weeklyVariable: 0 });
  ok(near(jointSim.ending, OPENING - BALANCE),
    'counterfactual: joint-paid Hydro would deduct $451.24',
    money(jointSim.ending));
  ok(near(independentJointCash(asJoint, START, END), BALANCE),
    'independent walk agrees the joint-paid total is $451.24');

  const typo = fixture({ payingAccount: 'amanda-debt-paymentz' });
  ok(typo.bills.every(b => independentlyJoint(b, typo) === true),
    'independent walk: unknown/typo payer still reserves joint cash');
  ok(typo.bills.every(b => F.billAffectsJointCash(b, typo) === true),
    'C. typo amanda-debt-paymentz fails closed and deducts joint cash');
  const typoSim = F.simulate(typo, START, { weeklyVariable: 0 });
  ok(near(typoSim.ending, OPENING - BALANCE),
    'C. typo payer ending is opening minus $451.24', money(typoSim.ending));

  const unnamed = fixture({ payingAccount: undefined });
  unnamed.bills.forEach(b => { delete b.payingAccount; });
  ok(unnamed.bills.every(b => independentlyJoint(b, unnamed) === true),
    'independent walk: no payingAccount is incumbent joint cash');
  ok(unnamed.bills.every(b => F.billAffectsJointCash(b, unnamed) === true),
    'D. no payingAccount preserves incumbent joint-cash deduction');
  const unnamedSim = F.simulate(unnamed, START, { weeklyVariable: 0 });
  ok(near(unnamedSim.ending, OPENING - BALANCE),
    'D. unnamed payer ending is opening minus $451.24', money(unnamedSim.ending));
}

console.log('\n=== G. reconciliation remains non-writing ===');
{
  const before = hashFile(R.DEFAULT_DATA);
  const liveHydro = (live.plan.bills || []).filter(b => /hydro/i.test(b.id + b.label));
  ok(liveHydro.some(b => b.id === 'hydro-due-sep1'
      && near(b.amount, DUE_SEP) && b.date === DUE_SEP_DATE
      && b.payingAccount === JOINT
      && b.householdObligation === true),
    'live plan has the 1 September Hydro dated due, planned from BILLS ACCOUNT, still a household obligation');
  ok(liveHydro.some(b => b.id === 'hydro-equal-payment'
      && near(b.amount, 199) && b.frequency === 'monthly'
      && b.day === 30 && b.firstDue === '2026-10-30'
      && b.confidence === 'estimated'
      && b.payingAccount === JOINT),
    'live plan also has the $199 equal-payment series from estimated 2026-10-01');
  ok(liveHydro.length === 2,
    'live Hydro bills are the Sep. 1 once due and the equal-payment series');
  ok(!liveHydro.some(b => b.id === 'hydro-due-now'),
    'the 14 August Hydro due was not added — owner-confirmed settled');

  const result = R.reconcile({
    data: live,
    map: { mappings: [] },
    observations: [],
    settlements: { observations: [] },
    utility,
  });
  ok(result.writesCanonicalState === false, 'reconcile result declares no write');
  const balanceRow = result.rows.find(r => r.observationId === 'payday-hydro-account-balance');
  const nowRow = result.rows.find(r => r.observationId === 'payday-hydro-due-now');
  const sepRow = result.rows.find(r => r.observationId === 'payday-hydro-due-sep1');
  const payRow = result.rows.find(r => r.observationId === 'payday-hydro-paying-account');
  ok(balanceRow && balanceRow.status === 'MATCH'
    && /informational/.test(balanceRow.note || ''),
    'live account balance is informational / not scheduled');
  ok(nowRow && nowRow.status === 'MISSING',
    'live current due is still canonical missing — not guessed settled or still due');
  ok(sepRow && sepRow.status === 'MATCH' && near(sepRow.canonicalValue, DUE_SEP)
    && sepRow.canonicalDate === DUE_SEP_DATE,
    'live Sep. 1 due matches the Aug. 14 dated observation');
  ok(payRow && payRow.status === 'MISSING'
    && payRow.jointCashPool === false
    && payRow.payingAccountLabel === 'Amanda / DEBT&PAYMENTS',
    'paying-account observation still MISSING while hydro-due-now is absent (Aug. 14 observation label retained)');

  const after = hashFile(R.DEFAULT_DATA);
  ok(before === after, 'calling reconcile() does not change data.json');

  const cliBefore = hashFile(R.DEFAULT_DATA);
  const out = execFileSync(process.execPath, ['scripts/reconcile.js'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  ok(/does not write data\.json/.test(out),
    'CLI report repeats the no-write contract');
  ok(/informational \/ not scheduled amount/.test(out),
    'CLI distinguishes the account balance as informational');
  ok(/canonical missing\/change/.test(out),
    'CLI still distinguishes the unapplied 14 August due as canonical missing/change');
  ok(/Amanda \/ external-to-joint-pool/.test(out),
    'CLI distinguishes the paying account as external-to-joint-pool');
  ok(hashFile(R.DEFAULT_DATA) === cliBefore,
    'CLI reconcile does not write data.json');
}

console.log('\n=== Plan calendar and 14-day agenda: external vs cash outflow ===');
{
  const planSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8');
  const evHtml = /const evHtml = e => \{([\s\S]*?)\n  \};/.exec(planSrc);
  ok(!!evHtml, 'calendar evHtml helper is mechanically readable');
  const evBody = evHtml ? evHtml[1] : '';
  ok(/isExternalObligation\(e\)/.test(evBody) && /jointCash === false/.test(planSrc)
      && /!isCardPaidReserve\(e\)/.test(planSrc),
    'calendar presentation keys off jointCash === false, excluding card-paid reserves');
  ok(/cls =[\s\S]*external \? 'external'[\s\S]*: 'out'/.test(evBody)
    || /external \? 'external'/.test(evBody),
    'calendar uses class external, not out, for jointCash:false');
  ok(/external household obligation/.test(evBody),
    'calendar names an external household obligation, not a cash movement');
  ok(/does not reduce joint cash/.test(evBody),
    'calendar title says the obligation does not reduce joint cash');
  ok(!/external[\s\S]{0,80}−\$\{money/.test(evBody),
    'external calendar body does not use the − cash-outflow prefix');
  ok(/e\.kind === 'noncash' \? '' : e\.amount > 0 \? '\+' : '−'/.test(evBody),
    'ordinary joint-cash events still render with + / − cash prefixes');

  const agenda = /\$\('agenda-14'\)\.innerHTML = near\.length \? near\.map\(e => \{([\s\S]*?)\}\)\.join\(''\)/.exec(planSrc);
  ok(!!agenda, '14-day agenda renderer is mechanically readable');
  const agBody = agenda ? agenda[1] : '';
  ok(/isExternalObligation\(e\)/.test(agBody),
    '14-day agenda keys off the same jointCash === false helper');
  ok(/rowClass = external \? 'external' : \(e\.amount > 0 \? 'in' : 'out'\)/.test(agBody),
    '14-day agenda uses class external, not out, for jointCash:false');
  ok(/paid from \$\{externalPayerLabel\(plan, e\)\}/.test(agBody)
    && /not joint-cash/.test(agBody),
    '14-day agenda says paid from the paying account and not joint-cash');
  ok(/external\s*\n\s*\? money\(Math\.abs\(e\.amount\)\)/.test(agBody)
    || /external\s*\? money\(Math\.abs\(e\.amount\)\)/.test(agBody),
    '14-day external amount is not prefixed as a cash outflow');
  ok(/e\.amount > 0 \? '\+' : '−'/.test(agBody)
    && /e\.amount > 0 \? 'in' : 'out'/.test(agBody)
    && /e\.amount > 0 \? 'pos' : 'neg'/.test(agBody),
    'ordinary 14-day rows still render as in/out cash movements');
  ok(/Amanda \/ TENNIS INCOME/.test(planSrc),
    'Amanda / TENNIS INCOME is the held-elsewhere payer display label');
}

console.log('\n=== Deep Dive dated list: outflow vs external vs nonCash ===');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'deepdive.js'), 'utf8');
  const dated = /const datedRows = dated\.map\(e => \{([\s\S]*?)\}\);/.exec(src);
  ok(!!dated, 'Deep Dive dated-row renderer is mechanically readable');
  const body = dated ? dated[1] : '';
  ok(/e\.jointCash === false/.test(body),
    'Deep Dive keys external presentation off jointCash === false');
  ok(/Household obligation — paid from/.test(body) && /not joint-cash/.test(body),
    'jointCash:false is an externally paid household obligation, not a Dated payment');
  ok(/externalPayerLabel\(d\.plan, e\)/.test(body) && /event\.payingAccount/.test(src),
    'Deep Dive derives the external payer from event.payingAccount, not the bill note');
  ok(/chip">external</.test(body) && /not joint-cash/.test(body),
    'external rows carry a distinct external / not-joint-cash chip');
  ok(/noncash \|\| external/.test(body) && /mutedtext/.test(body),
    'external amounts use the muted non-cash presentation, not a joint-cash payment');
  ok(/soon = !noncash && !external/.test(body),
    'external rows are not highlighted as soon joint-cash dues');
  ok(/noteFor\(e\.id\) \|\| \(noncash \? 'No cash leaves'/.test(body)
    && /<strong>No cash leaves<\/strong>/.test(body)
    && /chip">non-cash</.test(body),
    'nonCash events keep their existing No cash leaves / non-cash semantics');
  ok(/: -e\.amount/.test(body) && /: 'Due'/.test(body),
    'ordinary joint-cash outflows still render as ordinary Dated payments');
  ok(/Forecast\.expandEvents\(d\.plan/.test(src),
    'Deep Dive still reads the dated list from Forecast.expandEvents');
}

console.log('\n=== paying-account report: one, shared, and conflicting payers ===');
{
  const payingObs = extra => Object.assign({
    observationId: 'payday-hydro-paying-account',
    fact: 'paying-account',
    payingAccount: AMANDA,
    payingAccountLabel: 'Amanda / DEBT&PAYMENTS',
    jointCashPool: false,
    billIds: ['hydro-due-now', 'hydro-due-sep1'],
    evidenceDate: START,
  }, extra || {});
  const runPay = (plan, obs) => R.reconcile({
    data: { meta: { asOf: START }, plan },
    map: { mappings: [] },
    observations: [],
    settlements: { observations: [] },
    utilityObservations: [obs],
  }).rows.find(r => r.fact === 'paying-account');

  const one = fixture();
  one.bills = one.bills.filter(b => b.id === 'hydro-due-now');
  const oneRow = runPay(one, payingObs({ billIds: ['hydro-due-now'] }));
  ok(oneRow && oneRow.status === 'MATCH' && oneRow.canonicalPayingAccount === AMANDA,
    '1. one canonical bill reports amanda-debt-payments');

  const shared = runPay(fixture(), payingObs());
  ok(shared && shared.status === 'MATCH' && shared.canonicalPayingAccount === AMANDA,
    '2. two dated Hydro dues with the same payer report amanda-debt-payments');
  ok(shared.canonicalPayingAccount !== null,
    '2. shared payer is not reported as —');

  const clash = fixture();
  clash.bills[1].payingAccount = JOINT;
  const clashRow = runPay(clash, payingObs());
  ok(clashRow && clashRow.status === 'CONFLICT',
    '3. disagreeing payingAccount values are CONFLICT');
  ok(clashRow.canonicalPayingAccount == null,
    '3. conflicting payers are not collapsed into one canonical payer');

  const partial = fixture();
  partial.bills = partial.bills.filter(b => b.id === 'hydro-due-now');
  const partialRow = runPay(partial, payingObs());
  ok(partialRow && partialRow.status !== 'MATCH',
    '4. one of two requested payer targets missing is not MATCH');
  ok(partialRow && partialRow.status === 'MISSING',
    '4. partial canonical presence is MISSING, not a completed payer match');
  ok(partialRow.canonicalPayingAccount == null,
    '4. a partial observation does not publish a canonical payer');
}

console.log('\n=== H. Forecast.expandEvents remains the schedule authority ===');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8');
  ok(/function expandEvents\(plan, start, end, opts\)/.test(src),
    'expandEvents is still the Plan schedule expander');
  ok(/billAffectsJointCash\(b, plan\)/.test(src)
    && /if \(!billIsHouseholdObligation\(b\)\) continue;/.test(src),
    'Hydro semantics are applied inside expandEvents, not a second calendar');
  ok(!/function expandHydro|hydroCalendar|utilityLedger/.test(src),
    'no second Hydro expander, calendar, or ledger was added');
  const ics = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'calendar-ics.js'), 'utf8');
  ok(/Forecast\.expandEvents/.test(ics),
    'the household calendar still derives from Forecast.expandEvents');
}

console.log('\n=== live Fusion / Amanda / HELOC / card surfaces ===');
{
  const camp = live.plan.commitments.find(c => c.id === 'fusioncamp');
  const tryouts = live.plan.commitments.find(c => c.id === 'tryouts');
  const instalments = (live.plan.commitments || [])
    .filter(c => /fusion/i.test(c.id + c.label) && near(c.amount, 500));
  ok(camp && near(camp.amount, 786) && camp.settledOn === START,
    'live Fusion camp is the $786 row with settledOn 2026-08-14');
  ok(tryouts && near(tryouts.amount, 140) && tryouts.settledOn === START,
    'live Fusion tryouts are the $140 row with settledOn 2026-08-14');
  ok(instalments.length === 0,
    'the three stale $500 Fusion season instalments are gone',
    String(instalments.length));
  const amanda15 = live.plan.income.find(s => s.id === 'amandaSalary15');
  const amandaEom = live.plan.income.find(s => s.id === 'amandaSalaryMonthEnd');
  ok(amanda15 && near(amanda15.amount, 2168.85) && amandaEom && near(amandaEom.amount, 2387.99),
    'Amanda Tennis BC salary streams are the owner-confirmed pair');
  ok(!live.plan.income.some(s => s.id === 'amandaTransfer'),
    'retired amandaTransfer stream is absent');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
