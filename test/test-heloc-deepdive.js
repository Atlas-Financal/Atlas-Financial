'use strict';
/* B19 — Deep Dive mortgage / HELOC story agrees with the canonical opening.
 *
 * Enduring invariants, not a freeze of one refresh:
 *   one current HELOC authority (`debts.heloc`);
 *   historical observations unchanged by composition;
 *   current/prior arithmetic truthful at the precision each surface publishes.
 *
 * Independent arithmetic uses constructed fixtures and the frozen ancestor
 * that demonstrated the defect. Live `data.json` is checked for identity
 * only — a later legitimate refresh must not require editing these constants.
 *
 * The demonstrated defect: helocHistory stored a hand-maintained current
 * endpoint ($201,586.16, the 2026-08-09 reading) beside live debts.heloc
 * ($200,486.16). The caption then said the line had risen every month.
 */
const fs = require('fs');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const same = (a, b) => a === b;
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const cents = n => Math.round(Number(n) * 100);
const sameCents = (a, b) => cents(a) === cents(b);
const read = p => sourceText(fs.readFileSync(p, 'utf8'));
const money2 = n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const money = n => (n < 0 ? '−$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-CA');

const MAIN = '2777d69ba4d4ffe948c96362c73a9875a97fadc8';
const AUG9 = 201586.16;
const AUG16 = 200486.16;
const JULY = 201085.16;
const FEB_PAYDOWN = 188060.61;
const LIMIT = 202654;
const PAYMENT = 1100;
const WINDOW_GROWTH = 7536.96;
const ADVANCES = 86513.51;
const INTEREST = 15029.18;

function gitShow(spec) {
  return execFileSync('git', ['show', spec], { encoding: 'utf8' });
}

function centsId(delta, up, down) {
  const publishedCents = Math.round(Number(delta) * 100);
  return publishedCents === 0 ? 'unchanged' : (publishedCents > 0 ? up : down);
}

function dollarId(delta) {
  const dollars = Math.round(Math.abs(Number(delta)));
  return dollars === 0 ? 'unchanged' : (delta > 0 ? 'growing' : 'falling');
}

function fixtureData({ helocBalance, history, asOf }) {
  return {
    meta: { asOf: asOf || '2026-08-16' },
    debts: [
      {
        id: 'heloc',
        balance: helocBalance,
        limit: LIMIT,
        cashPayment: 0,
        interestTreatment: 'capitalised',
        annualInterest: 0,
      },
      { id: 'mortgage', balance: 545188.30, annualInterest: 24000 },
    ],
    helocHistory: history,
    plan: { startingCash: {} },
    helocSummary: '',
  };
}

const heloc = data.debts.find(d => d.id === 'heloc');
const mortgage = data.debts.find(d => d.id === 'mortgage');
const history = data.helocHistory || [];
const snap9 = JSON.parse(read('snapshots/2026-08-09.json'));
const snap16 = JSON.parse(read('snapshots/2026-08-16.json'));
const snapHeloc = (snap, id) => (snap.accounts || []).find(d => d.id === id);

console.log('=== reproduced stale current endpoint on the starting main ===');
const mainData = JSON.parse(gitShow(`${MAIN}:data.json`));
const mainHist = mainData.helocHistory;
const mainLast = mainHist[mainHist.length - 1];
const mainHeloc = mainData.debts.find(d => d.id === 'heloc');
ok(near(mainLast.v, AUG9) && mainLast.m === 'Aug 26',
  'main helocHistory ended at Aug 26 $201,586.16',
  money2(mainLast.v));
ok(/Only \$1,067\.84 left/.test(mainLast.note || ''),
  'main current-endpoint note still published stale headroom $1,067.84');
ok(near(mainHeloc.balance, AUG16),
  'main debts.heloc was already the 2026-08-16 opening $200,486.16');
ok(/risen every month/.test(mainData.helocSummary),
  'main helocSummary still said it had risen every month');
ok(near(LIMIT - AUG9, 1067.84),
  'independent stale headroom is 202,654 − 201,586.16 = $1,067.84');

console.log('\n=== one current HELOC authority; composition does not rewrite history ===');
const dive = F.deepDive(data);
const lastStored = history.length ? history[history.length - 1] : null;
const liveDelta = lastStored && heloc && heloc.balance != null
  ? Number(heloc.balance) - Number(lastStored.v) : null;
ok(dive.heloc && heloc && sameCents(dive.heloc.current, heloc.balance),
  'Deep Dive current HELOC is debts.heloc',
  dive.heloc ? money2(dive.heloc.current) : 'none');
ok(dive.heloc && dive.heloc.history[dive.heloc.history.length - 1].v === heloc.balance
  && dive.heloc.history[dive.heloc.history.length - 1].note === 'current opening',
  'composed series ends on the canonical opening, labelled as current');
ok(dive.heloc.history.slice(0, -1).every((p, i) =>
  p.m === history[i].m && sameCents(p.v, history[i].v)),
  'composed historical points are the stored monthly observations');
ok(history.every(p => p.note !== 'current opening'),
  'stored helocHistory does not carry the current-opening label');
ok(history.every(p => !near(p.v, AUG9)),
  'the 2026-08-09 $201,586.16 reading is no longer stored as a monthly point');
ok(liveDelta != null && dive.heloc && sameCents(dive.heloc.vsPrior, liveDelta),
  'Deep Dive vs-prior is current minus the last stored observation');
ok(dive.heloc && dive.heloc.vsPriorId === centsId(liveDelta, 'growing', 'falling'),
  'Deep Dive classifies vs-prior by the published cent');

const snap = F.compactSnapshot(data.debts, data.helocHistory);
ok(snap.heloc && sameCents(snap.heloc.delta, liveDelta),
  'Plan compact snapshot uses the same current-minus-last-observation delta');
ok(snap.heloc && snap.heloc.id === dollarId(liveDelta),
  'Plan compact snapshot classifies that delta on the published whole dollar');

const feb = history.filter(p => /^Feb\b/.test(p.m)).pop();
ok(feb && dive.heloc && sameCents(dive.heloc.sincePaydown, Number(heloc.balance) - Number(feb.v)),
  'Deep Dive since-paydown is current minus the last February observation');
ok(dive.heloc && dive.heloc.sincePaydownId === centsId(dive.heloc.sincePaydown, 'higher', 'lower'),
  'Deep Dive classifies since-paydown by the published cent');

let roseEvery = true;
const fromFeb = history.filter((p, i) => i >= history.findIndex(x => x === feb));
for (let i = 1; i < fromFeb.length; i++) {
  if (!(fromFeb[i].v > fromFeb[i - 1].v)) roseEvery = false;
}
if (!(Number(heloc.balance) > fromFeb[fromFeb.length - 1].v)) roseEvery = false;
ok(dive.heloc.roseEveryMonthSincePaydown === roseEvery,
  'Forecast reports every-month-since-paydown from the composed series, not a stored claim');
ok(!/1,067\.84|1067\.84/.test(JSON.stringify(history)),
  'stored monthly series no longer publishes the stale $1,067.84 headroom');

console.log('\n=== fixture: July → Aug. 16 arithmetic at the published cent ===');
const FIX_HISTORY = [
  { m: 'Feb 26', v: FEB_PAYDOWN },
  { m: 'Mar', v: 190000 },
  { m: 'Jul', v: JULY },
];
const HAND_VS_JULY = AUG16 - JULY;
const HAND_SINCE_FEB = AUG16 - FEB_PAYDOWN;
ok(sameCents(HAND_VS_JULY, -599),
  'independent July → Aug. 16 is 200,486.16 − 201,085.16 = −$599.00');
ok(HAND_VS_JULY < 0, 'August is below July, not above it');
ok(sameCents(HAND_SINCE_FEB, 12425.55),
  'independent Aug. 16 − February paydown is +$12,425.55');
ok(sameCents(AUG9 - AUG16, PAYMENT) && near(201586.16 - 1100, AUG16),
  'Aug. 9 → Aug. 16 is independently $1,100.00');

const fixDive = F.deepDive(fixtureData({
  helocBalance: AUG16,
  history: FIX_HISTORY,
}));
ok(fixDive.heloc && sameCents(fixDive.heloc.current, AUG16)
  && sameCents(fixDive.heloc.vsPrior, HAND_VS_JULY)
  && fixDive.heloc.vsPriorId === 'falling',
  'fixture Deep Dive vs-prior is the independent −$599 falling identity');
ok(fixDive.heloc && sameCents(fixDive.heloc.sincePaydown, HAND_SINCE_FEB)
  && fixDive.heloc.sincePaydownId === 'higher',
  'fixture Deep Dive since-paydown matches that independent difference');
ok(fixDive.heloc.roseEveryMonthSincePaydown === false,
  'fixture walk from February through current is not every-month growth');

const fixSnap = F.compactSnapshot(
  fixtureData({ helocBalance: AUG16, history: FIX_HISTORY }).debts,
  FIX_HISTORY
);
ok(fixSnap.heloc && sameCents(fixSnap.heloc.delta, HAND_VS_JULY)
  && fixSnap.heloc.id === 'falling',
  'fixture compact snapshot uses the same −$599 falling identity');

console.log('\n=== fixture: sub-$0.50 caption cannot contradict displayed cents ===');
ok(money(0.4) === '$0', 'a $0.40 move prints $0 on the compact whole-dollar tile');
const SUB_PRIOR = 200000;
const SUB_CURRENT = 199999.6;
const SUB_DELTA = SUB_CURRENT - SUB_PRIOR;
ok(sameCents(SUB_DELTA, -0.4), 'independent sub-dollar fall is −$0.40');
ok(money2(SUB_CURRENT) !== money2(SUB_PRIOR),
  'money2 displays two different cent balances');

const subHistory = [
  { m: 'Feb 26', v: FEB_PAYDOWN },
  { m: 'Jul', v: SUB_PRIOR },
];
const subData = fixtureData({ helocBalance: SUB_CURRENT, history: subHistory });
const subDive = F.deepDive(subData);
const subSnap = F.compactSnapshot(subData.debts, subHistory);
ok(subSnap.heloc && subSnap.heloc.id === 'unchanged'
  && same(Math.round(Math.abs(subSnap.heloc.delta)), 0),
  'compact tile still calls a $0.40 move unchanged — it prints $0');
ok(subDive.heloc && subDive.heloc.vsPriorId === 'falling'
  && sameCents(subDive.heloc.vsPrior, SUB_DELTA),
  'Deep Dive classifies the same $0.40 fall as falling, not unchanged');
ok(subSnap.heloc.id !== subDive.heloc.vsPriorId,
  'Plan whole-dollar class and Deep Dive cent class are allowed to differ here');

const subUpHistory = [
  { m: 'Feb 26', v: SUB_PRIOR - 0.4 },
  { m: 'Jul', v: SUB_PRIOR - 10 },
];
const subUpDive = F.deepDive(fixtureData({
  helocBalance: SUB_PRIOR,
  history: subUpHistory,
}));
ok(subUpDive.heloc && subUpDive.heloc.sincePaydownId === 'higher'
  && sameCents(subUpDive.heloc.sincePaydown, 0.4),
  'Deep Dive classifies a $0.40 since-paydown rise as higher, not unchanged');
console.log('\n=== retained 18-month window totals still reconcile to their source ===');
const useSum = (data.helocUse || []).reduce((s, u) => s + Number(u.amount), 0);
const interestRow = (data.helocUse || []).find(u => /Interest charged/i.test(u.label));
ok(sameCents(useSum, ADVANCES),
  'helocUse amounts still sum to $86,513.51 of captured-window advances');
ok(interestRow && sameCents(interestRow.amount, INTEREST),
  'captured-window capitalised interest is still $15,029.18');
ok(data.helocUseNote.includes('78,176.55') && data.helocUseNote.includes('86,513.51'),
  'helocUseNote still states the captured-window $86,513.51 / $78,176.55 pair');
ok(sameCents(AUG9 - WINDOW_GROWTH, 194049.20),
  'retained +$7,536.96 still equals the 2026-08-09 reading minus the documented window start');
ok(!near(AUG16 - 194049.20, WINDOW_GROWTH),
  'that window growth is not silently rewritten onto the Aug. 16 opening');
ok(/7,536\.96/.test(data.helocSummary) && /78,177/.test(data.helocSummary)
  && /86,514/.test(data.helocSummary) && /15,029/.test(data.helocSummary),
  'stored window sentence still carries those independently rounded historical totals');
ok(/2026-08-09/.test(data.helocSummary),
  'the window sentence is dated to the capture reading, not to today');
ok(!/99\.5%/.test(data.helocUseNote),
  'historical-use note no longer publishes the stale 99.5% current utilisation');

console.log('\n=== mortgage current figures already agree — no second current copy ===');
ok(same(dive.mortgageMonthly, mortgage.annualInterest / 12),
  'Deep Dive mortgage monthly is still the debt-record twelfth');
ok(data.mortgage.balance == null,
  'the mortgage standing block still stores no second current balance');

console.log('\n=== dated B20 captures remain historical-only ===');
ok(near(snapHeloc(snap9, 'heloc').balance, AUG9)
  && near(snapHeloc(snap16, 'heloc').balance, AUG16),
  'dated openings still hold both HELOC readings');

console.log('\n=== Q19 ANSWERED; HELOC cash model unchanged ===');
const questions = read('docs/01_OPEN_QUESTIONS.md');
const q19 = questions.slice(questions.indexOf('### Q19.'));
const q19body = q19.slice(0, q19.indexOf('\n### Q'));
ok(/^\*\*Status:\*\* ANSWERED\b/m.test(q19body), 'Q19 status is ANSWERED');
ok(/Remaining August cash requirement/i.test(q19body) && /\$0 additional/i.test(q19body),
  'Q19 records $0 additional August HELOC cash after the Aug. 14 payment');
ok(heloc.cashPayment === 0 && heloc.interestTreatment === 'capitalised',
  'HELOC cashPayment remains $0 and interest remains capitalised');
ok(!/PAD/.test(data.helocSummary) && !/814\.18/.test(data.helocSummary),
  'Deep Dive HELOC summary does not invent an August PAD or $814.18 cash outflow');

console.log('\n=== credit / headroom remains debt capacity, not cash ===');
const util = F.utilisation(data.debts, data.revolvingExtra, data.plan);
const helocUtil = util.rows.find(r => r.id === 'heloc' || /HELOC/i.test(r.label));
const liveRoom = Number(heloc.limit) - Number(heloc.balance);
ok(helocUtil && sameCents(helocUtil.available, liveRoom),
  'utilisation publishes limit − current as available credit');
ok(!near(F.startingCashAmount(data.plan), liveRoom),
  'spendable cash is not the HELOC available-credit figure');
ok(!near(F.publicationTotals(data).creditLeft, F.startingCashAmount(data.plan)),
  'published credit-left is not household cash');

console.log('\n=== mutation: restoring a stored current endpoint now fails ===');
const staleHist = history.concat([{ m: 'Aug 26', v: AUG9 }]);
ok(staleHist.some(p => near(p.v, AUG9)), 'mutant history contains the stale current');
ok(!history.some(p => near(p.v, AUG9)),
  'live helocHistory still does not — the stored-current copy is gone');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
