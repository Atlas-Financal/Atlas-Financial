'use strict';
/* B91 D7 — schedule is not proof of posting.
 *
 * Acceptance corpus: docs/source_intake/PAYDAY_ACCEPTANCE_2026-08-14.md
 * Live canonical state is unchanged. Synthetic amounts prove the cutover
 * arithmetic; they are not household evidence and are not written to
 * data.json.
 *
 * Independent proof: occurrence dates from Forecast.occurrences, plus a
 * hand walk of opening ± named amounts. That is not a second call to
 * the representedEvents filter.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const F = require('../public/forecast.js');
const R = require('../scripts/reconcile.js');
const live = require('../data.json');
// Snapshot before any code under test sees it: R.reconcile() receives this
// exact object below, and the end of the file proves it was not mutated.
const liveBefore = JSON.stringify(live);
const posting = require('../docs/reconciliation/posting-observations.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const money = n => '$' + Number(n).toFixed(2);
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const AS_OF = '2026-08-14';
const NEXT_DAY = '2026-08-15';
const END = F.addDays(AS_OF, 27);
const PAYROLL = 1000;
const MORTGAGE = 200;
const OPENING = 800;
const OTHER_BILL = 50;
const FIT = 11.54;

function emptySide() {
  return { observations: [] };
}

function fixture(extraOpening) {
  return {
    meta: { asOf: AS_OF },
    plan: {
      windowDays: 28,
      defaults: { targetBuffer: 0 },
      startingCash: { amount: OPENING },
      opening: Object.assign({
        asOf: AS_OF,
        representedEvents: [{ id: 'payroll', date: AS_OF }],
      }, extraOpening || {}),
      income: [{
        id: 'payroll',
        label: 'Payroll',
        frequency: 'biweekly',
        anchor: AS_OF,
        amount: PAYROLL,
        confidence: 'confirmed',
      }],
      obligations: [{
        id: 'mortgage',
        label: 'Mortgage',
        frequency: 'biweekly',
        anchor: AS_OF,
        amount: MORTGAGE,
        confidence: 'confirmed',
      }],
      bills: [
        {
          id: 'other-same-day',
          label: 'Unsettled same-day bill',
          frequency: 'once',
          date: AS_OF,
          amount: OTHER_BILL,
          confidence: 'confirmed',
        },
        {
          id: 'fit4less',
          label: 'Fit4Less membership',
          frequency: 'biweekly',
          anchor: AS_OF,
          amount: FIT,
          confidence: 'confirmed',
        },
        {
          id: 'bcaa',
          label: 'BCAA insurance',
          frequency: 'monthly',
          day: 15,
          amount: 82.96,
          confidence: 'confirmed',
        },
      ],
      commitments: [],
    },
  };
}

function runPosting(data, observations) {
  return R.reconcile({
    data,
    map: { mappings: [] },
    observations: [],
    settlements: emptySide(),
    utility: emptySide(),
    amanda: emptySide(),
    cards: emptySide(),
    posting: { observations },
  });
}

function postingObs(extra) {
  return Object.assign({
    fact: 'posting',
    observedAsOf: AS_OF,
  }, extra);
}

console.log('=== A. independent schedule still names payroll and mortgage on Aug. 14 ===');
{
  const plan = fixture().plan;
  const payrollDates = F.occurrences(plan.income[0], AS_OF, END);
  const mortgageDates = F.occurrences(plan.obligations[0], AS_OF, END);
  ok(payrollDates[0] === AS_OF, 'independent occurrences: payroll is scheduled on Aug. 14');
  ok(mortgageDates[0] === AS_OF, 'independent occurrences: mortgage is scheduled on Aug. 14');
  ok(payrollDates.includes(F.addDays(AS_OF, 14)),
    'later payroll remains on the biweekly grid');
}

console.log('\n=== B. posted payroll named on representedEvents → MATCH ===');
{
  const data = fixture();
  const result = runPosting(data, [postingObs({
    observationId: 'synth-payroll-posted',
    eventId: 'payroll',
    scheduledDate: AS_OF,
    posted: true,
  })]);
  const row = result.rows.find(r => r.observationId === 'synth-payroll-posted');
  ok(row && row.status === 'MATCH', 'posted payroll that is represented is MATCH');
  ok(row && row.represented === true && row.derivedStatus === 'posted-represented',
    'derived status is posted-represented, not a lifecycle state machine');
  ok(row && row.canonicalTarget === 'representedEvents:payroll@' + AS_OF,
    'canonical pointer is representedEvents, not a second calendar');

  const events = F.expandEvents(data.plan, AS_OF, END, {});
  const day0 = events.filter(e => e.date === AS_OF);
  ok(!day0.some(e => e.id === 'payroll'),
    'Forecast does not replay the represented Aug. 14 payroll');
}

console.log('\n=== C. unposted mortgage absent from representedEvents → MATCH ===');
{
  const data = fixture();
  const result = runPosting(data, [postingObs({
    observationId: 'synth-mortgage-unposted',
    eventId: 'mortgage',
    scheduledDate: AS_OF,
    posted: false,
  })]);
  const row = result.rows.find(r => r.observationId === 'synth-mortgage-unposted');
  ok(row && row.status === 'MATCH', 'unposted mortgage that is not represented is MATCH');
  ok(row && row.represented === false && row.derivedStatus === 'scheduled-unposted',
    'derived status is scheduled-unposted — schedule is not proof of posting');

  const events = F.expandEvents(data.plan, AS_OF, END, {});
  const mortgage = events.find(e => e.id === 'mortgage' && e.date === AS_OF);
  ok(!!mortgage && near(mortgage.amount, -MORTGAGE),
    'Forecast still deducts the unposted Aug. 14 mortgage');
}

console.log('\n=== D. posted payroll missing from representedEvents → CHANGE + double-count ===');
{
  const data = fixture({ representedEvents: [] });
  const result = runPosting(data, [postingObs({
    observationId: 'synth-payroll-missing-cutover',
    eventId: 'payroll',
    scheduledDate: AS_OF,
    posted: true,
  })]);
  const row = result.rows.find(r => r.observationId === 'synth-payroll-missing-cutover');
  ok(row && row.status === 'CHANGE',
    'posted same-day payroll not named on representedEvents is CHANGE');
  ok(row && row.derivedStatus === 'posted-not-represented',
    'derived status names the double-count risk');

  const events = F.expandEvents(data.plan, AS_OF, END, {});
  const payroll = events.find(e => e.id === 'payroll' && e.date === AS_OF);
  ok(!!payroll && near(payroll.amount, PAYROLL),
    'Forecast still emits the unrepresented payroll — the defect the CHANGE is about');
  const independentOldNet = PAYROLL - MORTGAGE - OTHER_BILL - FIT;
  const day0Net = events.filter(e => e.date === AS_OF).reduce((s, e) => s + e.amount, 0);
  ok(near(day0Net, independentOldNet),
    'independent day-0 net adds payroll again when cutover is missing',
    money(day0Net));
}

console.log('\n=== E. unposted mortgage wrongly represented → CONFLICT + skipped cash ===');
{
  const data = fixture({
    representedEvents: [
      { id: 'payroll', date: AS_OF },
      { id: 'mortgage', date: AS_OF },
    ],
  });
  const result = runPosting(data, [postingObs({
    observationId: 'synth-mortgage-false-cutover',
    eventId: 'mortgage',
    scheduledDate: AS_OF,
    posted: false,
  })]);
  const row = result.rows.find(r => r.observationId === 'synth-mortgage-false-cutover');
  ok(row && row.status === 'CONFLICT',
    'unposted mortgage named on representedEvents is CONFLICT');
  ok(row && row.derivedStatus === 'unposted-but-represented',
    'derived status names the skipped-obligation risk');

  const events = F.expandEvents(data.plan, AS_OF, END, {});
  ok(!events.some(e => e.id === 'mortgage' && e.date === AS_OF),
    'Forecast would skip the unposted mortgage — the defect the CONFLICT is about');
  const independentSkipped = OPENING - OTHER_BILL - FIT;
  const sim = F.simulate(data.plan, AS_OF, { weeklyVariable: 0 });
  ok(near(sim.daily[0].balance, independentSkipped),
    'independent first-day close is opening minus the non-mortgage same-day bills',
    money(sim.daily[0].balance));
}

console.log('\n=== F. unknown posting is not posted and is not unposted ===');
{
  const data = fixture();
  const unknown = runPosting(data, [postingObs({
    observationId: 'synth-fit-unknown',
    eventId: 'fit4less',
    scheduledDate: AS_OF,
    unknown: true,
  })]);
  const row = unknown.rows.find(r => r.observationId === 'synth-fit-unknown');
  ok(row && row.status === 'MISSING' && row.unknown === true,
    'unknown posting with no representedEvents entry is MISSING');
  ok(row && row.derivedStatus === 'posting-unknown',
    'unknown is its own derived status, not guessed unposted');

  const events = F.expandEvents(data.plan, AS_OF, END, {});
  const fit = events.find(e => e.id === 'fit4less' && e.date === AS_OF);
  ok(!!fit && near(fit.amount, -FIT),
    'fail closed: unknown posting still reserves the scheduled cash');

  const invented = runPosting(fixture({
    representedEvents: [
      { id: 'payroll', date: AS_OF },
      { id: 'fit4less', date: AS_OF },
    ],
  }), [postingObs({
    observationId: 'synth-fit-invented',
    eventId: 'fit4less',
    scheduledDate: AS_OF,
    unknown: true,
  })]);
  const inventedRow = invented.rows.find(r => r.observationId === 'synth-fit-invented');
  ok(inventedRow && inventedRow.status === 'CONFLICT',
    'unknown posting named on representedEvents is CONFLICT — posting was invented');
}

console.log('\n=== G. same-time posted vs unposted is CONFLICT, not guessed ===');
{
  const result = runPosting(fixture(), [
    postingObs({
      observationId: 'synth-payroll-a',
      eventId: 'payroll',
      scheduledDate: AS_OF,
      posted: true,
    }),
    postingObs({
      observationId: 'synth-payroll-b',
      eventId: 'payroll',
      scheduledDate: AS_OF,
      posted: false,
    }),
  ]);
  const rows = result.rows.filter(r => r.eventId === 'payroll');
  ok(rows.length === 2 && rows.every(r => r.status === 'CONFLICT'),
    'disagreeing posting facts for one occurrence are CONFLICT');
  ok(rows.every(r => r.derivedStatus === 'conflicted-posting'),
    'the conflict is not collapsed into posted or unposted');
}

console.log('\n=== H. missing scheduled event is MISSING, not invented ===');
{
  const result = runPosting(fixture(), [postingObs({
    observationId: 'synth-ghost',
    eventId: 'does-not-exist',
    scheduledDate: AS_OF,
    posted: true,
  })]);
  const row = result.rows[0];
  ok(row && row.status === 'MISSING' && row.scheduledExists === false,
    'a posting observation with no scheduled event is MISSING');
}

console.log('\n=== I. Aug. 14 corpus observations against a payday opening ===');
{
  const data = fixture();
  data.plan.bills.push(
    { id: 'icbc', label: 'ICBC insurance', frequency: 'monthly', day: 15, amount: 99.91 },
    { id: 'resp', label: 'RESP contribution', frequency: 'monthly', day: 15, amount: 100 }
  );
  const result = runPosting(data, posting.observations);
  const byId = id => result.rows.find(r => r.observationId === id);
  ok(byId('payday-payroll-posted') && byId('payday-payroll-posted').status === 'MATCH',
    'corpus payroll posted + represented is MATCH');
  ok(byId('payday-mortgage-posted') && byId('payday-mortgage-posted').status === 'CHANGE',
    'later mortgage posted evidence vs empty representedEvents is CHANGE');
  ok(byId('payday-fit4less-posted') && byId('payday-fit4less-posted').status === 'CHANGE',
    'later Fit4Less posted evidence vs empty representedEvents is CHANGE');
  ok(byId('payday-bcaa-posting-unknown')
    && byId('payday-bcaa-posting-unknown').status === 'MISSING',
    'corpus BCAA next-day unknown posting is MISSING');
  ok(byId('payday-icbc-posting-unknown')
    && byId('payday-icbc-posting-unknown').status === 'MISSING',
    'corpus ICBC next-day unknown posting is MISSING');
  ok(byId('payday-resp-posting-unknown')
    && byId('payday-resp-posting-unknown').status === 'MISSING',
    'corpus RESP next-day unknown posting is MISSING');
  ok(byId('payday-bcaa-posting-unknown').scheduledDate === NEXT_DAY
    && byId('payday-icbc-posting-unknown').scheduledDate === NEXT_DAY
    && byId('payday-resp-posting-unknown').scheduledDate === NEXT_DAY,
    'BCAA / ICBC / RESP are dated 15 Aug, not guessed as Aug. 14 postings');
}

console.log('\n=== J. live 16 August opening does not invent representedEvents ===');
{
  const liveResult = R.reconcile({
    data: live,
    map: { mappings: [] },
    observations: [],
    settlements: emptySide(),
    utility: emptySide(),
    amanda: emptySide(),
    cards: emptySide(),
    posting,
  });
  const byId = id => liveResult.rows.find(r => r.observationId === id);
  const gated = new Set((live.plan.opening.representedEvents || [])
    .filter(row => row && (!row.effectiveAsOf || row.effectiveAsOf <= live.plan.opening.asOf))
    .map(row => row && `${row.id}@${row.date}`));
  ok(live.plan.opening && gated.has('noble-garbage@2026-09-18')
      && gated.has('heloc@2026-09-21') && gated.has('tdcc@2026-09-17')
      && gated.size === 3
      && live.meta.asOf !== '2026-08-14',
    'live representedEvents are the Dale-gated prepaid settles and as-of is not the 14 August payday');
  ok(live.meta.asOf === live.plan.opening.asOf, 'live canonical as-of agrees with the opening');
  ok(byId('payday-payroll-posted') && byId('payday-payroll-posted').status === 'CHANGE',
    '14 August payroll posting vs empty representedEvents is CHANGE — asOf is not that date');
  ok(byId('payday-mortgage-posted') && byId('payday-mortgage-posted').status === 'CHANGE',
    '14 August mortgage posting vs empty representedEvents is CHANGE — asOf is not that date');
  ok(byId('payday-bcaa-posting-unknown').status === 'MISSING'
    && byId('payday-icbc-posting-unknown').status === 'MISSING'
    && byId('payday-resp-posting-unknown').status === 'MISSING'
    && byId('payday-uniondues-posting-unknown').status === 'MISSING',
    'live unknown 15 August postings stay MISSING');
  ok(liveResult.writesCanonicalState === false, 'reconciler still reports non-writing');
  ok(liveResult.staleAssigned === false && liveResult.counts.STALE === 0,
    'STALE is still not assigned');

  const heloc = (live.plan.obligations || []).find(o => o.id === 'heloc');
  ok(heloc && heloc.nonCash === true,
    'Q19 HELOC cash treatment is untouched — still nonCash, not claimed zero');
}

console.log('\n=== K. no-write CLI + Forecast remains the schedule authority ===');
{
  const before = hashFile(R.DEFAULT_DATA);
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'reconcile.js'), 'utf8');
  ok(!/writeFileSync?\s*\(\s*DEFAULT_DATA/.test(src),
    'reconcile.js source does not write DEFAULT_DATA');
  ok(/Posting source: docs\/reconciliation\/posting-observations/.test(src)
    || /posting-observations\.json/.test(src),
    'the posting observation file is the D7 source');

  const out = execFileSync(process.execPath, ['scripts/reconcile.js'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
  });
  const after = hashFile(R.DEFAULT_DATA);
  ok(before === after, 'running the CLI leaves data.json bytes unchanged');
  ok(/Schedule vs posted/.test(out), 'the printed report includes posting distinctions');
  ok(/payday-payroll-posted/.test(out) && /payday-mortgage-posted/.test(out),
    'the live CLI names the Aug. 14 payroll and mortgage posting observations');
  ok(!/\b600(\.00)?\/wk/.test(out) && !/"weekly":\s*600/.test(JSON.stringify(posting)),
    '$600/week is not encoded as posting or payday policy');

  const forecastSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8');
  ok(/function expandEvents\(plan, start, end, opts\)/.test(forecastSrc),
    'expandEvents is still the Plan schedule expander');
  ok(/representedEvents/.test(forecastSrc)
    && /date === start/.test(forecastSrc),
    'posting still consumes the existing representedEvents cutover');
  ok(!/function postingEngine|function postingStateMachine|function postingLifecycle/.test(src + forecastSrc),
    'no posting engine, state machine, or lifecycle layer was added');
}

console.log('\n=== L. live Fusion / Hydro / Amanda / weekly policy ===');
{
  const camp = live.plan.commitments.find(c => c.id === 'fusioncamp');
  const tryouts = live.plan.commitments.find(c => c.id === 'tryouts');
  ok(camp && near(camp.amount, 786) && camp.settledOn === AS_OF,
    'live Fusion camp is the $786 row with settledOn 2026-08-14');
  ok(tryouts && near(tryouts.amount, 140) && tryouts.settledOn === AS_OF,
    'live Fusion tryouts are the $140 row with settledOn 2026-08-14');
  const hydro = (live.plan.bills || []).filter(b => /hydro/i.test(b.id + b.label));
  ok(hydro.some(b => b.id === 'hydro-due-sep1')
      && hydro.some(b => b.id === 'hydro-equal-payment')
      && hydro.length === 2,
    'live Hydro canonical bills are the 1 September dated due and the equal-payment series');
  ok(!hydro.some(b => b.id === 'hydro-due-now'),
    'the 14 August Hydro due was not invented as still unpaid');
  const amanda15 = live.plan.income.find(s => s.id === 'amandaSalary15');
  const amandaEom = live.plan.income.find(s => s.id === 'amandaSalaryMonthEnd');
  ok(amanda15 && near(amanda15.amount, 2168.85) && amandaEom && near(amandaEom.amount, 2387.99),
    'Amanda Tennis BC salary streams are the owner-confirmed pair');
  ok(!live.plan.income.some(s => s.id === 'amandaTransfer'),
    'retired amandaTransfer stream is absent');
  ok(JSON.stringify(live) === liveBefore,
    'the live object was not mutated by the posting compare');
}

console.log('\n=== M. Forecast occurrence is date-aware; nonCash/settled are not cash postings ===');
{
  const WRONG = '2026-08-13';
  const NEXT_PAY = F.addDays(AS_OF, 14);
  const CAMP = '2026-08-16';
  const HELOC_DAY = '2026-08-31';
  const plan = fixture().plan;
  ok(!F.occurrences(plan.income[0], WRONG, WRONG).includes(WRONG),
    'independent occurrences: payroll is not scheduled on Aug. 13');
  ok(F.occurrences(plan.income[0], NEXT_PAY, NEXT_PAY).includes(NEXT_PAY),
    'independent occurrences: next payroll is 28 Aug');

  const wrongPosted = runPosting(fixture(), [postingObs({
    observationId: 'synth-payroll-wrong-date',
    eventId: 'payroll',
    scheduledDate: WRONG,
    posted: true,
  })]);
  const wrongRow = wrongPosted.rows.find(r => r.observationId === 'synth-payroll-wrong-date');
  ok(wrongRow && wrongRow.status === 'MISSING' && wrongRow.scheduledExists === false,
    'posted payroll on a date Forecast never scheduled is MISSING, not CHANGE');

  const wrongUnposted = runPosting(fixture(), [postingObs({
    observationId: 'synth-mortgage-wrong-date',
    eventId: 'mortgage',
    scheduledDate: WRONG,
    posted: false,
  })]);
  const wrongMortgage = wrongUnposted.rows.find(r => r.observationId === 'synth-mortgage-wrong-date');
  ok(wrongMortgage && wrongMortgage.status === 'MISSING' && wrongMortgage.scheduledExists === false,
    'unposted mortgage on a date Forecast never scheduled is MISSING, not MATCH');

  const later = runPosting(fixture(), [postingObs({
    observationId: 'synth-payroll-next',
    eventId: 'payroll',
    scheduledDate: NEXT_PAY,
    posted: true,
  })]);
  const laterRow = later.rows.find(r => r.observationId === 'synth-payroll-next');
  ok(laterRow && laterRow.status === 'CHANGE' && laterRow.scheduledExists === true,
    'posted payroll on a later Forecast date is still CHANGE, not dropped');

  const helocData = fixture();
  helocData.plan.obligations.push({
    id: 'heloc',
    label: 'HELOC interest',
    frequency: 'monthly',
    day: 31,
    amount: 814.18,
    nonCash: true,
    confidence: 'confirmed',
  });
  const helocEvents = F.expandEvents(helocData.plan, HELOC_DAY, HELOC_DAY, {});
  ok(helocEvents.some(e => e.id === 'heloc' && e.kind === 'noncash'),
    'Forecast emits HELOC as noncash on the 31st');
  ok(!helocEvents.some(e => e.id === 'heloc' && e.kind !== 'noncash'),
    'Forecast does not emit HELOC as a cash occurrence');
  const helocPosted = runPosting(helocData, [postingObs({
    observationId: 'synth-heloc-posted',
    eventId: 'heloc',
    scheduledDate: HELOC_DAY,
    posted: true,
  })]);
  const helocRow = helocPosted.rows.find(r => r.observationId === 'synth-heloc-posted');
  ok(helocRow && helocRow.status === 'MISSING' && helocRow.scheduledExists === false,
    'nonCash HELOC is not a cash posting occurrence — MISSING, not CHANGE');

  const settledData = fixture();
  settledData.plan.commitments.push({
    id: 'fusioncamp',
    label: 'Fusion camp',
    date: CAMP,
    amount: 786,
    settledOn: AS_OF,
    confidence: 'confirmed',
  });
  const campEvents = F.expandEvents(settledData.plan, CAMP, CAMP, {});
  ok(!campEvents.some(e => e.id === 'fusioncamp'),
    'Forecast does not emit a settled commitment as a cash occurrence');
  const campPosted = runPosting(settledData, [postingObs({
    observationId: 'synth-camp-posted',
    eventId: 'fusioncamp',
    scheduledDate: CAMP,
    posted: true,
  })]);
  const campRow = campPosted.rows.find(r => r.observationId === 'synth-camp-posted');
  ok(campRow && campRow.status === 'MISSING' && campRow.scheduledExists === false,
    'settled commitment is not a scheduled cash occurrence — MISSING, not CHANGE');

  const openData = fixture();
  openData.plan.commitments.push({
    id: 'tryouts',
    label: 'Fusion tryouts',
    date: CAMP,
    amount: 140,
    confidence: 'confirmed',
  });
  const tryoutEvents = F.expandEvents(openData.plan, CAMP, CAMP, {});
  ok(tryoutEvents.some(e => e.id === 'tryouts' && e.kind === 'commitment'),
    'Forecast still emits an unsettled commitment');
  const tryoutUnposted = runPosting(openData, [postingObs({
    observationId: 'synth-tryouts-unposted',
    eventId: 'tryouts',
    scheduledDate: CAMP,
    posted: false,
  })]);
  const tryoutRow = tryoutUnposted.rows.find(r => r.observationId === 'synth-tryouts-unposted');
  ok(tryoutRow && tryoutRow.status === 'MATCH' && tryoutRow.scheduledExists === true,
    'unsettled commitment on its Forecast date remains a scheduled unposted MATCH');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
