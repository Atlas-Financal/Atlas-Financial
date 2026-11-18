'use strict';
/* B93 — one observed financial fact has one stored numeric home.
 *
 * Independent arithmetic: parent-row sums and max(0, −balance) identities,
 * not a second call to the helper that now derives the copy.
 */
const F = require('../public/forecast.js');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const clone = x => JSON.parse(JSON.stringify(x));
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) <= eps;
const money = n => '$' + Number(n).toFixed(2);

function cashRows(d) {
  const cash = d.plan.startingCash;
  return (cash.breakdown || []).concat(cash.heldElsewhere || []);
}
function cashById(d, id) {
  return cashRows(d).find(r => r.id === id);
}
function independentSpendable(d) {
  return (d.plan.startingCash.breakdown || []).reduce((s, b) => s + Number(b.value || 0), 0);
}
function independentAssets(d) {
  const byId = {};
  for (const row of cashRows(d)) if (row.id) byId[row.id] = Number(row.value || 0);
  return (d.assets || []).reduce((s, a) => s + (a.cash ? (byId[a.cash] || 0) : Number(a.value || 0)), 0);
}
function independentDebt(d) {
  return (d.debts || []).reduce((s, x) => s + Number(x.balance || 0), 0);
}
function independentOverdraftUsed(d) {
  const row = cashById(d, 'chequing-b');
  return Math.max(0, -((row && Number(row.value)) || 0));
}
function incomeTotal(d) {
  return (d.income || []).reduce((s, r) => s + Number(r.total || 0), 0);
}

console.log('=== A. cash — one edit of Chequing A ===');
{
  const before = clone(data);
  const after = clone(data);
  cashById(after, 'chequing-a').value += 1000;

  const spendableDelta = independentSpendable(after) - independentSpendable(before);
  const assetDelta = independentAssets(after) - independentAssets(before);
  const pubBefore = F.publicationTotals(before);
  const pubAfter = F.publicationTotals(after);

  ok(near(spendableDelta, 1000), 'independent spendable sum rises $1,000');
  ok(assetDelta === 1000, 'independent asset sum rises $1,000');
  ok(near(F.startingCashAmount(after.plan) - F.startingCashAmount(before.plan), 1000),
    'derived opening cash rises $1,000');
  ok(near(pubAfter.assets - pubBefore.assets, 1000),
    'published asset total rises $1,000');
  ok(near(pubAfter.financialAccountsOnly - pubBefore.financialAccountsOnly, 1000),
    'financial-account net worth rises $1,000');
  ok(after.assets.find(a => a.cash === 'chequing-a').value == null,
    'the linked Chequing A asset row was not edited');
  ok(!Object.prototype.hasOwnProperty.call(after.plan.startingCash, 'amount'),
    'no second startingCash.amount edit exists or is required');
}

console.log('\n=== B. overdraft — one edit of Chequing B ===');
{
  const before = clone(data);
  const after = clone(data);
  const odLimit = Number((after.revolvingExtra.find(e => e.id === 'overdraft') || {}).limit || 0);
  const beforeB = Number(cashById(after, 'chequing-b').value || 0);
  // Drive Chequing B to exactly −limit so the facility is fully used. A
  // flat −$1,000 no longer exhausts it once the account opens positive.
  const exhaustBy = beforeB + odLimit;
  cashById(after, 'chequing-b').value -= exhaustBy;

  const usedBefore = independentOverdraftUsed(before);
  const usedAfter = independentOverdraftUsed(after);
  const od = after.revolvingExtra.find(e => e.id === 'overdraft');
  const utilBefore = F.utilisation(before.debts, before.revolvingExtra, before.plan);
  const utilAfter = F.utilisation(after.debts, after.revolvingExtra, after.plan);
  const odBefore = utilBefore.rows.find(r => r.id === 'overdraft');
  const odAfter = utilAfter.rows.find(r => r.id === 'overdraft');
  const pubBefore = F.publicationTotals(before);
  const pubAfter = F.publicationTotals(after);
  const projBefore = F.projectDebts(before.plan, before.debts, before.meta.asOf,
    { extraFacilities: before.revolvingExtra });
  const projAfter = F.projectDebts(after.plan, after.debts, after.meta.asOf,
    { extraFacilities: after.revolvingExtra });
  const fundBefore = F.resolveFundingSources(
    before.plan.funding.options, before.revolvingExtra, before.plan, before.debts);
  const fundAfter = F.resolveFundingSources(
    after.plan.funding.options, after.revolvingExtra, after.plan, after.debts);
  const odFundBefore = fundBefore.find(o => o.id === 'overdraft');
  const odFundAfter = fundAfter.find(o => o.id === 'overdraft');
  const recOpts = d => ({
    scenario: d.plan.defaults.scenario,
    targetBuffer: Math.max(d.plan.defaults.targetBuffer, Math.ceil(independentSpendable(d) + 50)),
    extraDebtMonthly: d.plan.defaults.extraDebtMonthly || 0,
    incomeOverrides: {},
    disabled: [],
    debts: d.debts,
    extraDebtTarget: d.plan.nextDollar && d.plan.nextDollar.target,
    fundingSources: d.plan.funding.options,
    extraFacilities: d.revolvingExtra,
  });
  const recBefore = F.recommend(before.plan, before.meta.asOf, recOpts(before));
  const recAfter = F.recommend(after.plan, after.meta.asOf, recOpts(after));
  const recOdBefore = recBefore.funding.sources.find(s => s.id === 'overdraft');
  const recOdAfter = recAfter.funding.sources.find(s => s.id === 'overdraft');
  const staleAvailable = 82.28;

  ok(near(independentSpendable(after) - independentSpendable(before), -exhaustBy),
    `Plan starting cash falls ${money(exhaustBy)}`);
  ok(near(independentAssets(after) - independentAssets(before), -exhaustBy),
    `asset value falls ${money(exhaustBy)}`);
  ok(usedAfter > usedBefore,
    'independent overdraft used = max(0, −Chequing B) rises once the account is overdrawn');
  ok(odAfter.used > odBefore.used,
    'utilisation used rises once the account is overdrawn');
  ok(odAfter.available < odBefore.available,
    'live overdraft available falls after Chequing B is driven overdrawn');
  ok(near(pubAfter.creditLeft - pubBefore.creditLeft, -odBefore.available),
    'published credit-left falls by the remaining overdraft room');
  ok(near(projAfter.marks[0].headroom - projBefore.marks[0].headroom, -odBefore.available),
    'day-0 extra-facility headroom falls by that same remaining room');
  ok(od.used == null, 'no revolvingExtra.used edit exists or is required');
  ok(near(odFundAfter.available, 0) && odFundBefore.available > 0,
    'funding-option availability follows Chequing B — the remaining room cannot absorb $100');
  ok(near(odFundAfter.available, odAfter.available)
    && near(odFundBefore.available, odBefore.available),
    'funding-option availability matches utilisation availability');
  ok(after.plan.funding.options.find(o => o.id === 'overdraft').available == null,
    'no funding-option available edit exists or is required');
  ok(near(recOdAfter.available, 0) && !near(recOdAfter.available, staleAvailable),
    'Forecast.recommend does not retain stale $82.28 after the Chequing B edit');
  ok(near(recOdBefore.available, odBefore.available)
    && near(recOdAfter.available, odAfter.available),
    'recommend funding input follows the same derived availability');

  const roomy = clone(data);
  cashById(roomy, 'chequing-b').value = -200;
  const roomyDeeper = clone(roomy);
  cashById(roomyDeeper, 'chequing-b').value = -300;
  const u0 = F.utilisation(roomy.debts, roomy.revolvingExtra, roomy.plan).rows.find(r => r.id === 'overdraft');
  const u1 = F.utilisation(roomyDeeper.debts, roomyDeeper.revolvingExtra, roomyDeeper.plan).rows.find(r => r.id === 'overdraft');
  ok(near(u0.used, 200) && near(u0.available, 400)
    && near(u1.used, 300) && near(u1.available, 300),
    'when the overdraft still has room, used +$100 drops available $100');
  const f0 = F.resolveFundingSources(roomy.plan.funding.options, roomy.revolvingExtra, roomy.plan, roomy.debts)
    .find(o => o.id === 'overdraft');
  const f1 = F.resolveFundingSources(roomyDeeper.plan.funding.options, roomyDeeper.revolvingExtra, roomyDeeper.plan, roomyDeeper.debts)
    .find(o => o.id === 'overdraft');
  ok(near(f0.available, 400) && near(f1.available, 300),
    'and the funding-option view drops that same $100');
}

console.log('\n=== C. debt — one edit of MBNA balance ===');
{
  const before = clone(data);
  const after = clone(data);
  const mb = after.debts.find(d => d.id === 'mbna');
  mb.balance += 500;

  const pubBefore = F.publicationTotals(before);
  const pubAfter = F.publicationTotals(after);
  const utilBefore = F.utilisation(before.debts, before.revolvingExtra, before.plan);
  const utilAfter = F.utilisation(after.debts, after.revolvingExtra, after.plan);
  const mbBefore = utilBefore.rows.find(r => r.id === 'mbna');
  const mbAfter = utilAfter.rows.find(r => r.id === 'mbna');
  const projBefore = F.projectDebts(before.plan, before.debts, before.meta.asOf, {});
  const projAfter = F.projectDebts(after.plan, after.debts, after.meta.asOf, {});
  const mbProj = projAfter.marks[0].debts.find(x => x.id === 'mbna');

  ok(near(independentDebt(after) - independentDebt(before), 500),
    'independent posted-debt sum rises $500');
  ok(near(mbAfter.posted - mbBefore.posted, 500),
    'posted debt display rises $500');
  ok(near(mbProj.postedBalance, mb.balance),
    'projection postedBalance is derived from the stored balance');
  ok(near(mbProj.balance - (projBefore.marks[0].debts.find(x => x.id === 'mbna').balance), 500),
    'opening debt rises $500 before pending is the only addend');
  ok(near(pubAfter.totalDebt - pubBefore.totalDebt, 500),
    'total debt rises $500');
  ok(near(pubAfter.financialAccountsOnly - pubBefore.financialAccountsOnly, -500),
    'net worth falls $500');
  ok(mb.postedBalance == null,
    'no postedBalance edit is required');
}

console.log('\n=== D. historical income — one edit of a recurring total ===');
{
  const before = clone(data);
  const after = clone(data);
  const months = after.incomeCaptureMonths;
  const row = after.income.find(r => r.label === 'Child benefit');
  row.total += 1800;
  const pubBefore = F.publicationTotals(before);
  const pubAfter = F.publicationTotals(after);
  const line = pubAfter.incomeLines.find(r => r.label === 'Child benefit');
  const wantMonthly = Math.round(row.total / months);
  const wantAggregateMonthly = Math.round(incomeTotal(after) / months);

  ok(line.perMonth === wantMonthly,
    'row monthly figure follows total / capture window',
    `${line.perMonth} vs ${wantMonthly}`);
  ok(near(pubAfter.incomeTotal - pubBefore.incomeTotal, 1800),
    'aggregate income total follows the parent total');
  ok(pubAfter.incomePerMonth === wantAggregateMonthly,
    'aggregate monthly income is round(sum(total) / window)');
  ok(row.perMonth == null,
    'no stored numeric perMonth edit is required');
}

console.log('\n=== E. one-off reimbursement is not recurring monthly income ===');
{
  const pub = F.publicationTotals(data);
  const row = (data.income || []).find(r => /Insurance reimbursement/i.test(r.label));
  const line = pub.incomeLines.find(r => /Insurance reimbursement/i.test(r.label));
  ok(row && row.perMonth === null && row.stability === 'One-off',
    'the insurance row keeps the explicit one-off marker');
  ok(line && line.perMonth === null,
    'and is not presented as recurring monthly income');
  ok(Math.round(row.total / data.incomeCaptureMonths) === 28,
    'dividing the receipt by the window would invent $28/month — that path is refused');
}

console.log('\n=== F. pending charges still apply exactly once ===');
{
  const tv = data.debts.find(d => d.id === 'travelvisa');
  const mb = data.debts.find(d => d.id === 'mbna');
  const proj = F.projectDebts(data.plan, data.debts, data.meta.asOf, {});
  const d0 = proj.marks[0];
  const tvProj = d0.debts.find(x => x.id === 'travelvisa');
  const mbProj = d0.debts.find(x => x.id === 'mbna');
  ok(near(tvProj.balance, tv.balance + tv.pending)
    && near(tvProj.postedBalance, tv.balance)
    && near(tvProj.pending, tv.pending),
    'Travel Visa opens at posted + pending, reported apart',
    money(tvProj.balance));
  ok(near(mbProj.balance, mb.balance + mb.pending)
    && near(mbProj.postedBalance, mb.balance)
    && near(mbProj.pending, mb.pending),
    'MBNA opens at posted + pending, reported apart',
    money(mbProj.balance));
  const events = F.expandEvents(data.plan, data.meta.asOf, proj.end, {});
  const settle = events.filter(e =>
    (tv.pending > 0 && Math.abs(Math.abs(e.amount) - tv.pending) < 0.01)
    || (mb.pending > 0 && Math.abs(Math.abs(e.amount) - mb.pending) < 0.01));
  ok(settle.length === 0,
    'no scheduled event re-applies either pending charge',
    `${settle.length} matching events`);
}

console.log('\n=== G. published coaching-income overstatement is not a current monthly figure ===');
{
  // B93: one live fact, one home. The 2026-08-29 planning policy retired the
  // Deep Dive current monthly coaching-net / overstatement. incomeWarning is
  // the planning caveat. A second published data.json string must not invent
  // a competing current monthly overstatement (the old Deep Dive $1,650 vs
  // $650 defect) if a current figure is ever reintroduced.
  // "$1,650 previously feared" / "not the $X" is historical, not current.
  function walkStrings(value, out) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(v => walkStrings(v, out));
    else if (value && typeof value === 'object') {
      Object.values(value).forEach(v => walkStrings(v, out));
    }
  }
  const OVERSTATEMENT = /overstated by (?:up to |about |roughly )?(?:~)?\$([\d,]+)(?:\.\d+)?\/month/gi;
  function isHistoricalOverstatement(s, matchIndex, matchText) {
    const before = s.slice(Math.max(0, matchIndex - 16), matchIndex);
    if (/not the\s*$/i.test(before)) return true;
    const after = s.slice(matchIndex + matchText.length, matchIndex + matchText.length + 48);
    return /^\s*,?\s*(previously feared|upper bound(?: feared)?)/i.test(after);
  }
  function currentOverstatementMonthlies(d) {
    const strings = [];
    walkStrings(d, strings);
    const amounts = [];
    for (const s of strings) {
      OVERSTATEMENT.lastIndex = 0;
      let m;
      while ((m = OVERSTATEMENT.exec(s))) {
        if (isHistoricalOverstatement(s, m.index, m[0])) continue;
        amounts.push(Number(m[1].replace(/,/g, '')));
      }
    }
    return amounts;
  }

  const warningAmounts = currentOverstatementMonthlies({ incomeWarning: data.incomeWarning });
  const published = currentOverstatementMonthlies(data);
  ok(warningAmounts.length === 0,
    'incomeWarning does not state a current monthly coaching-income overstatement',
    warningAmounts.join(',') || 'none');
  ok(published.length === 0,
    'published data.json strings do not state a current monthly coaching-income overstatement',
    published.join(',') || 'none');

  const restoredWarning = clone(data);
  restoredWarning.incomeWarning =
    'So this total is overstated by about $650/month, not the $1,650 previously feared.';
  const restoredAmounts = currentOverstatementMonthlies({ incomeWarning: restoredWarning.incomeWarning });
  ok(restoredAmounts.length === 1 && restoredAmounts[0] === 650,
    'the detector still sees a restored current $650/month overstatement',
    restoredAmounts.join(','));

  const staleQ = clone(restoredWarning);
  staleQ.questions[0].changes =
    'Household income is currently overstated by up to $1,650/month. Every conclusion resting on income is provisional until this is split. Amanda\'s bookkeeping settles it.';
  const stalePublished = currentOverstatementMonthlies(staleQ);
  ok(new Set(stalePublished).size > 1,
    'a competing current $1,650/month on questions[0].changes still fails this check',
    stalePublished.join(','));
}

console.log('\n=== H. duplicate authorities cannot quietly return ===');
ok(data.debts.every(d => d.postedBalance == null),
  'no debt stores postedBalance beside balance');
ok((data.revolvingExtra || []).every(e => e.used == null && e.cash),
  'cash-linked extra facilities store no used balance');
ok((data.assets || []).filter(a => a.cash).every(a => a.value == null),
  'linked cash asset rows store no numeric value');
ok(!Object.prototype.hasOwnProperty.call(data.plan.startingCash, 'amount'),
  'plan.startingCash.amount is not stored beside the account rows');
ok((data.income || []).every(r => r.perMonth == null || r.perMonth === null),
  'historical income stores no numeric perMonth');
ok((data.income || []).some(r => r.perMonth === null && /One-off/i.test(r.stability || '')),
  'the one-off row is the only perMonth: null marker');
{
  const odOpt = (data.plan.funding.options || []).find(o => o.id === 'overdraft');
  ok(odOpt && odOpt.cash === 'chequing-b' && typeof odOpt.available !== 'number',
    'overdraft funding option names Chequing B and stores no numeric availability');
  ok((data.plan.funding.options || []).every(o => typeof o.available !== 'number'),
    'no funding option stores a numeric current availability');
  ok(!JSON.stringify(data).includes('82.28'),
    'data.json stores no hard-coded $82.28 current overdraft availability');
}

console.log('\n=== synthetic fixtures still accept explicit amount / used ===');
{
  const fixture = {
    windowDays: 3,
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 200 },
    income: [], obligations: [], commitments: [],
  };
  const sim = F.simulate(fixture, '2026-01-01', { weeklyVariable: 0 });
  ok(near(sim.daily[0].balance, 200),
    'a fixture with only startingCash.amount still opens on that amount');
  const util = F.utilisation(
    [{ id: 'card', balance: 100, limit: 500, pending: 0 }],
    [{ id: 'overdraft', used: 40, limit: 100, pending: 0 }]);
  ok(near(util.rows.find(r => r.id === 'overdraft').used, 40)
    && near(util.totalAvailable, 400 + 60),
    'a fixture extra facility may still declare used directly');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
