'use strict';
/* #962 D3: a bill payment a day or two off its due date is not household
 * spending.
 *
 * A debit carrying a bill's full identity except its date is a probable
 * payment of that bill. These conditions must all hold:
 *   - explicit payee identity;
 *   - the rule's own mapped account;
 *   - debit direction;
 *   - a posted debit (pending cash keeps its incumbent path);
 *   - a household cash account;
 *   - within 3 days of exactly one scheduled occurrence, capped below half of
 *     the bill's own interval.
 *
 * Such a debit is held out of Household / Other and named on the bill as a
 * to-confirm candidate. It never settles the bill: date and amount never
 * identify, so the bill stays To confirm and reserved. Same-day matching (the
 * default) and every rule are unchanged.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js
 * fromObservation -> the packet transaction flag, Forecast's classification of
 * that transaction, and Forecast.recommend's current-period Other spending and
 * bill rows. Every expected value is hand-written. Invented numbers only.
 *
 * `node test/test-bill-near-due-not-household.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12,
  confidence: 'confirmed', payee: 'Invented hydro' };
const NET = { id: 'net', label: 'Invented internet', amount: 60, frequency: 'monthly', day: 11,
  confidence: 'confirmed', payee: 'Invented net co' };
const payroll = () => H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
  payee: 'Invented employer' });
const debit = (date, amount, payee, category = 'Utilities', account = 'chequing-a') =>
  H.lm({ date, amount, category, account, payee });

function run(bills, txs, asOf, planPatch) {
  const w = H.baseWorld(asOf);
  w.bills = bills;
  if (planPatch) w.planPatch = planPatch;
  w.transactions = [payroll()].concat(txs);
  const r = H.observe(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
  const periods = (rec.defaultView && rec.defaultView.calendarPeriods) || [];
  const current = periods.find(p => p.start <= w.asOf && p.end >= w.asOf) || periods[0];
  const other = ((current && current.householdBudget) || []).find(row => row && row.otherSpending) || null;
  // Packet transactions carry no payee text: find the invented debit by its
  // own date and amount, which each case makes unique.
  const byPayee = new Map(txs.map(t => [t.payee, t]));
  const txOf = payee => {
    const raw = byPayee.get(payee);
    if (!raw) return null;
    return (r.packet.transactions || []).find(t => t.date === raw.date
      && Math.abs(Number(t.amount)) === Math.abs(Number(raw.amount))) || null;
  };
  return { packet: r.packet, periods, period: current, other, txOf,
    bill: id => ((current && current.bills) || []).find(b => b.id === id) || null,
    classify: tx => F.classifyCurrentPeriodTransaction(tx, r.plan, { packet: r.packet, currentPeriodActuals: r.packet }) };
}
const otherSpent = res => (res.other && typeof res.other.spent === 'number') ? res.other.spent : 0;
const candidateOf = (res, payee) => { const t = res.txOf(payee); return t && t.nearDueBillCandidate || null; };

console.log('#962 D3 repro: hydro paid 2 days early, internet paid 2 days late (stock LM categories)');
{
  const res = run([{ ...HYDRO }, { ...NET }], [debit('2026-10-10', 90, 'Invented hydro', 'Utilities'),
    debit('2026-10-13', 60, 'Invented net co', 'Internet')]);
  ok(JSON.stringify(candidateOf(res, 'Invented hydro')) === JSON.stringify({ id: 'hydro', date: '2026-10-12', offsetDays: -2 }),
    'hydro Oct 10 is held as a candidate for its Oct 12 occurrence', JSON.stringify(candidateOf(res, 'Invented hydro')));
  ok(JSON.stringify(candidateOf(res, 'Invented net co')) === JSON.stringify({ id: 'net', date: '2026-10-11', offsetDays: 2 }),
    'internet Oct 13 is held as a candidate for its Oct 11 occurrence', JSON.stringify(candidateOf(res, 'Invented net co')));
  const cls = res.classify(res.txOf('Invented hydro'));
  ok(cls.householdSpending === false && cls.reason === 'near-due-bill-unconfirmed',
    'the held debit is not household spending', JSON.stringify({ hs: cls.householdSpending, reason: cls.reason }));
  ok(otherSpent(res) === 0, 'Other spending holds neither payment (was 150)', String(otherSpent(res)));
  for (const id of ['hydro', 'net']) {
    const b = res.bill(id);
    ok(b && b.status !== 'PAID' && b.settlement === 'unverified' && b.remaining === (id === 'hydro' ? 90 : 60),
      `${id} stays To confirm and fully reserved (nothing settles)`, b && `${b.status}/${b.settlement}/${b.remaining}`);
  }
  ok(!(res.packet.representedActuals || []).some(a => a.id === 'hydro' || a.id === 'net'),
    'no represented actual is created for either bill');
}

console.log('Window bounds (monthly bill due Oct 12)');
for (const [date, held, label] of [
  ['2026-10-11', true, '1 day early is held'],
  ['2026-10-13', true, '1 day late is held'],
  ['2026-10-15', true, '3 days late is held'],
  ['2026-10-08', false, '4 days early is not held'],
  ['2026-10-16', false, '4 days late stays Other'],
]) {
  const res = run([{ ...HYDRO }], [debit(date, 90, 'Invented hydro')], date > '2026-10-14' ? date : undefined);
  const c = candidateOf(res, 'Invented hydro');
  ok(held ? (c && c.id === 'hydro' && c.date === '2026-10-12') : c === null, label, JSON.stringify(c));
  // Oct 8 sits in the previous pay period, so only in-period cases check Other.
  if (date >= '2026-10-09') {
    ok(held ? otherSpent(res) === 0 : otherSpent(res) === 90, `${label}: Other spending ${held ? 0 : 90}`, String(otherSpent(res)));
  }
}

console.log('Identity is required: payee, mapped account, debit');
{
  const res = run([{ ...HYDRO }], [debit('2026-10-10', 90, 'Invented florist')]);
  ok(candidateOf(res, 'Invented florist') === null && otherSpent(res) === 90,
    'another payee near the due date stays Other', String(otherSpent(res)));
}
{
  const res = run([{ ...HYDRO }], [debit('2026-10-10', 90, 'Invented hydro', 'Utilities', 'chequing-b')]);
  ok(candidateOf(res, 'Invented hydro') === null, 'the right payee on another account is not held',
    JSON.stringify(candidateOf(res, 'Invented hydro')));
}
{
  const res = run([{ ...HYDRO }], [H.lm({ date: '2026-10-10', amount: -90, category: 'Utilities', account: 'chequing-a',
    payee: 'Invented hydro' })]);
  ok(candidateOf(res, 'Invented hydro') === null, 'a credit from the bill payee is not held',
    JSON.stringify(candidateOf(res, 'Invented hydro')));
}

console.log('Pending cash keeps its incumbent path');
{
  const res = run([{ ...HYDRO }], [H.lm({ date: '2026-10-13', amount: 90, category: 'Utilities', account: 'chequing-a',
    payee: 'Invented hydro', pending: true })]);
  ok(candidateOf(res, 'Invented hydro') === null, 'a pending identity debit near the due date is not held',
    JSON.stringify(candidateOf(res, 'Invented hydro')));
}

console.log('Same-day matching is unchanged');
{
  const res = run([{ ...HYDRO }], [debit('2026-10-12', 90, 'Invented hydro')]);
  const b = res.bill('hydro');
  ok(b && b.status === 'PAID' && candidateOf(res, 'Invented hydro') === null,
    'a same-day payment still settles Paid and is not a candidate', b && b.status);
}

console.log('Second-charge edge');
{
  // The occurrence is already settled by its own same-day payment: a second
  // charge from the payee two days later is ordinary spending, not hidden.
  const res = run([{ ...HYDRO }], [debit('2026-10-12', 90, 'Invented hydro'),
    H.lm({ date: '2026-10-14', amount: 25, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro' })]);
  const b = res.bill('hydro');
  ok(b && b.status === 'PAID', 'positive control: the bill is Paid by its same-day payment', b && b.status);
  ok(otherSpent(res) === 25, 'a second charge near a settled occurrence stays visible in Other', String(otherSpent(res)));
}
{
  // Two charges near an unsettled occurrence: both are held and both are
  // listed on the bill as candidates; neither is hidden.
  const res = run([{ ...HYDRO }], [debit('2026-10-10', 90, 'Invented hydro'),
    H.lm({ date: '2026-10-13', amount: 25, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro' })]);
  const held = (res.packet.transactions || []).filter(t => t.nearDueBillCandidate
    && t.nearDueBillCandidate.id === 'hydro').map(t => t.amount).sort((a, b) => a - b);
  ok(JSON.stringify(held) === JSON.stringify([25, 90]), 'both near-due charges are held for the unsettled bill', JSON.stringify(held));
  const b = res.bill('hydro');
  ok(b && b.status !== 'PAID' && b.remaining === 90, 'the bill stays To confirm with 90 reserved', b && `${b.status}/${b.remaining}`);
}

{
  // The plan opening already names the Oct 12 occurrence as represented (no
  // matched payment in this observation). A $25 same-payee debit on Oct 13
  // stays visible in Other; it is not hidden behind a Paid bill (Codex
  // finding on a1a3ed6).
  const res = run([{ ...HYDRO }], [H.lm({ date: '2026-10-13', amount: 25, category: 'Utilities', account: 'chequing-a',
    payee: 'Invented hydro' })], undefined, plan => {
    plan.opening.representedEvents = [{ id: 'hydro', date: '2026-10-12' }];
  });
  const b = res.bill('hydro');
  ok(b && b.status === 'PAID', 'positive control: the opening-represented bill is Paid', b && b.status);
  ok(candidateOf(res, 'Invented hydro') === null && otherSpent(res) === 25,
    'a charge near an opening-represented occurrence stays in Other', `${JSON.stringify(candidateOf(res, 'Invented hydro'))} ${otherSpent(res)}`);
}
{
  // Due Oct 8, before the opening boundary (priorAsOf Oct 9): the recurring
  // occurrence is already inside the opening cash and prints Paid. A same-
  // payee debit on Oct 10 is not held for it.
  const res = run([{ ...HYDRO, day: 8 }], [H.lm({ date: '2026-10-10', amount: 25, category: 'Utilities',
    account: 'chequing-a', payee: 'Invented hydro' })]);
  ok(candidateOf(res, 'Invented hydro') === null && otherSpent(res) === 25,
    'a charge near an occurrence inside the opening stays in Other', `${JSON.stringify(candidateOf(res, 'Invented hydro'))} ${otherSpent(res)}`);
}

console.log('Short-cycle cap: a bill never claims its neighbour');
{
  // Biweekly from Fri Oct 9: occurrences Oct 9 and Oct 23. Oct 12 is +3 from
  // Oct 9 and is held for it; Oct 20 is -3 from Oct 23 and is held for that;
  // Oct 16 is 7 days from both and is claimed by neither.
  const bi = { id: 'gym', label: 'Invented gym', amount: 20, frequency: 'biweekly', anchor: '2026-10-09',
    confidence: 'confirmed', payee: 'Invented gym' };
  const a = run([bi], [debit('2026-10-12', 20, 'Invented gym', 'Fitness')]);
  ok(JSON.stringify(candidateOf(a, 'Invented gym')) === JSON.stringify({ id: 'gym', date: '2026-10-09', offsetDays: 3 }),
    'Oct 12 is held for the Oct 9 occurrence', JSON.stringify(candidateOf(a, 'Invented gym')));
  const b = run([bi], [debit('2026-10-20', 20, 'Invented gym', 'Fitness')], '2026-10-21');
  ok(JSON.stringify(candidateOf(b, 'Invented gym')) === JSON.stringify({ id: 'gym', date: '2026-10-23', offsetDays: -3 }),
    'Oct 20 is held for the Oct 23 occurrence, not Oct 9', JSON.stringify(candidateOf(b, 'Invented gym')));
  const c = run([bi], [debit('2026-10-16', 20, 'Invented gym', 'Fitness')], '2026-10-17');
  ok(candidateOf(c, 'Invented gym') === null, 'Oct 16, a week from both, is claimed by neither',
    JSON.stringify(candidateOf(c, 'Invented gym')));
}
{
  // An every-4-days cadence (interval 4) caps the reach at 1 day.
  const short = { id: 'bin', label: 'Invented bin', amount: 5, frequency: 'once', date: '2026-10-12',
    confidence: 'confirmed', payee: 'Invented bin co' };
  const short2 = { ...short, id: 'bin', date: '2026-10-16' };
  // Two once rows sharing one id model a 4-day cadence for the cap check.
  const at1 = run([short, short2], [debit('2026-10-13', 5, 'Invented bin co', 'Fees')]);
  ok(candidateOf(at1, 'Invented bin co') && candidateOf(at1, 'Invented bin co').date === '2026-10-12',
    'interval 4: 1 day off is held', JSON.stringify(candidateOf(at1, 'Invented bin co')));
  const at2 = run([short, short2], [debit('2026-10-14', 5, 'Invented bin co', 'Fees')]);
  ok(candidateOf(at2, 'Invented bin co') === null, 'interval 4: 2 days off (the midpoint) is never claimed',
    JSON.stringify(candidateOf(at2, 'Invented bin co')));
}

console.log('The bill detail names the held debit as a to-confirm candidate');
{
  const ctx = { console, Intl, Number, Math, String, Object, Array, JSON, Date };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'bill-detail.js'), 'utf8'), ctx);
  const data = { meta: { asOf: '2026-10-14' }, plan: { opening: { asOf: '2026-10-14' } },
    liveOverlay: { applied: true, effectiveAsOf: '2026-10-14', observedAsOf: '2026-10-14', currentPeriodActuals: {
      schema: 'atlas-current-period-actuals/v1', observationAsOf: '2026-10-14', representedActuals: [],
      transactions: [{ id: 'tx-9', date: '2026-10-10', amount: 90, account: 'chequing-a', atlasAccountId: 'chequing-a',
        pending: false, nearDueBillCandidate: { id: 'hydro', date: '2026-10-12', offsetDays: -2 } }] } } };
  const html = ctx.BillDetail.html({ id: 'hydro', label: 'Invented hydro', status: 'still due', settlement: 'unverified',
    date: '2026-10-12', planned: 90, remaining: 90 }, data, {});
  ok(/data-bill-payment-candidate>Possible payment — to confirm/.test(html) && /2026-10-10/.test(html),
    'the detail shows "Possible payment — to confirm" with the debit date');
  const stale = JSON.parse(JSON.stringify(data));
  stale.liveOverlay.observedAsOf = '2026-10-13';
  ok(!/Possible payment/.test(ctx.BillDetail.html({ id: 'hydro', label: 'Invented hydro', status: 'still due',
    settlement: 'unverified', date: '2026-10-12', planned: 90, remaining: 90 }, stale, {})),
  'a stale overlay names no candidate');
  const paid = ctx.BillDetail.html({ id: 'hydro', label: 'Invented hydro', status: 'PAID', settlement: 'represented',
    date: '2026-10-12', planned: 90, remaining: 0 }, data, {});
  ok(!/Possible payment/.test(paid), 'a Paid bill shows no candidate block');
}

console.log('Across a payday the debit is held only where a reserve stands in its own period (#965 review 6717183500; #953)');
{
  // Pay periods Oct 9-22 and Oct 23-Nov 5 (biweekly from the Oct 9 payroll).
  const bad = res => res.period && res.period.balanceAfterDeductions;
  const otherPeriodBill = (res, id, date) => {
    const p = (res.periods || []).find(x => x.start <= date && x.end >= date);
    return p && (p.bills || []).find(b => b.id === id && b.date === date) || null;
  };
  // Reviewer's case: debit Oct 20, occurrence due Oct 23 (next period).
  const early = { ...HYDRO, day: 23 };
  const held = run([early], [debit('2026-10-20', 90, 'Invented hydro')], '2026-10-21');
  const control = run([early], [debit('2026-10-20', 90, 'Invented other payee')], '2026-10-21');
  ok(JSON.stringify(candidateOf(held, 'Invented hydro')) === JSON.stringify({ id: 'hydro', date: '2026-10-23', offsetDays: -3 }),
    'positive control: the observer still names the Oct 23 occurrence', JSON.stringify(candidateOf(held, 'Invented hydro')));
  const cls = held.classify(held.txOf('Invented hydro'));
  ok(cls.householdSpending === true && cls.reason !== 'near-due-bill-unconfirmed',
    'the Oct 20 debit is household spending (occurrence is in the next period)', JSON.stringify({ hs: cls.householdSpending, reason: cls.reason }));
  ok(otherSpent(held) === 90, 'Oct 9-22 Other spending deducts the 90', String(otherSpent(held)));
  ok(otherSpent(control) === 90, 'control: the same debit from a non-bill payee is 90 Other spending', String(otherSpent(control)));
  ok(typeof bad(held) === 'number' && bad(held) === bad(control),
    'Oct 9-22 Balance After Deductions equals the non-bill control (not overstated by 90)', `${bad(held)} vs ${bad(control)}`);
  const next = otherPeriodBill(held, 'hydro', '2026-10-23');
  ok(next && next.status !== 'PAID' && next.remaining === 90, 'the Oct 23 occurrence stays unpaid and reserved',
    next && `${next.status}/${next.remaining}`);

  // Mirror: occurrence due Oct 21 (earlier period), debit Oct 23 (this period).
  // Since #953 the unproven Oct 21 occurrence is carried into Oct 23-Nov 5
  // and reserved there "to confirm". Its reserve now stands in the debit's
  // own period, so the debit is held against it: deducted once, as the
  // reserve, and still never nowhere. By hand: 1,400 - 90 - 400 = 910. The
  // non-bill control owes the same bill and also spent 90: 820.
  const late = { ...HYDRO, day: 21 };
  const heldLate = run([late], [debit('2026-10-23', 90, 'Invented hydro')], '2026-10-24');
  const controlLate = run([late], [debit('2026-10-23', 90, 'Invented other payee')], '2026-10-24');
  ok(JSON.stringify(candidateOf(heldLate, 'Invented hydro')) === JSON.stringify({ id: 'hydro', date: '2026-10-21', offsetDays: 2 }),
    'positive control: the observer still names the Oct 21 occurrence', JSON.stringify(candidateOf(heldLate, 'Invented hydro')));
  const carriedRow = heldLate.bill('hydro');
  ok(carriedRow && carriedRow.date === '2026-10-21' && carriedRow.status !== 'PAID' && carriedRow.remaining === 90,
    'the Oct 21 occurrence is carried into Oct 23-Nov 5, unpaid and reserved',
    carriedRow && `${carriedRow.date}/${carriedRow.status}/${carriedRow.remaining}`);
  const clsLate = heldLate.classify(heldLate.txOf('Invented hydro'));
  ok(clsLate.householdSpending === false && clsLate.reason === 'near-due-bill-unconfirmed',
    'the Oct 23 debit is held against the carried reserve, not also counted as spending', JSON.stringify({ hs: clsLate.householdSpending, reason: clsLate.reason }));
  ok(otherSpent(heldLate) === 0 && otherSpent(controlLate) === 90, 'Oct 23-Nov 5 Other spending: 0 for the held debit, 90 for the non-bill control',
    `${otherSpent(heldLate)} / ${otherSpent(controlLate)}`);
  ok(bad(heldLate) === 910 && bad(controlLate) === 820,
    'Oct 23-Nov 5 Balance After Deductions deducts the 90 once (910); the control owes the bill and spent 90 (820)', `${bad(heldLate)} vs ${bad(controlLate)}`);
  const prior = otherPeriodBill(heldLate, 'hydro', '2026-10-21');
  ok(!prior || prior.status !== 'PAID', 'the Oct 21 occurrence is not marked Paid by the cross-period debit',
    prior && prior.status);
  // No reserve in the debit's period, no hold: a debt-linked bill is not
  // carried by that rule, so its late debit stays household spending.
  const unreserved = run([{ ...late, debtId: 'invented-debt' }], [debit('2026-10-23', 90, 'Invented hydro')], '2026-10-24');
  const clsUnreserved = unreserved.classify(unreserved.txOf('Invented hydro'));
  ok(!unreserved.bill('hydro') && clsUnreserved.householdSpending === true && otherSpent(unreserved) === 90,
    'with no carried reserve the Oct 23 debit stays household spending (never deducted nowhere)',
    JSON.stringify({ row: !!unreserved.bill('hydro'), hs: clsUnreserved.householdSpending, other: otherSpent(unreserved) }));

  // In-period hold unchanged: debit Oct 20, occurrence Oct 22, both in Oct 9-22.
  const inPeriod = run([{ ...HYDRO, day: 22 }], [debit('2026-10-20', 90, 'Invented hydro')], '2026-10-21');
  const clsIn = inPeriod.classify(inPeriod.txOf('Invented hydro'));
  ok(clsIn.householdSpending === false && clsIn.reason === 'near-due-bill-unconfirmed' && otherSpent(inPeriod) === 0,
    'in-period: the debit is still held out of Other spending', JSON.stringify({ hs: clsIn.householdSpending, other: otherSpent(inPeriod) }));
  const inBill = inPeriod.bill('hydro');
  ok(inBill && inBill.status !== 'PAID' && inBill.remaining === 90, 'in-period: the occurrence stays reserved, not Paid',
    inBill && `${inBill.status}/${inBill.remaining}`);
}

console.log('The bill detail never claims a counted debit is kept out of household spending');
{
  const ctx = { console, Intl, Number, Math, String, Object, Array, JSON, Date };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'bill-detail.js'), 'utf8'), ctx);
  const detail = (res, bill) => {
    const asOf = res.packet.observationAsOf;
    const data = { meta: { asOf }, plan: { opening: { asOf } }, liveOverlay: { applied: true, effectiveAsOf: asOf,
      observedAsOf: asOf, currentPeriodActuals: res.packet } };
    return ctx.BillDetail.html({ id: bill.id, label: bill.label, status: 'still due', settlement: 'unverified',
      date: bill.date, planned: 90, remaining: 90 }, data, {});
  };
  // Cross-period: the Oct 20 debit is household spending in Oct 9-22.
  const cross = run([{ ...HYDRO, day: 23 }], [debit('2026-10-20', 90, 'Invented hydro')], '2026-10-21');
  const crossCls = cross.classify(cross.txOf('Invented hydro'));
  const crossHtml = detail(cross, { id: 'hydro', label: 'Invented hydro', date: '2026-10-23' });
  ok(crossCls.householdSpending === true && /data-bill-payment-candidate/.test(crossHtml)
    && !/kept out of household spending/i.test(crossHtml),
  'cross-period: the counted debit is listed as a candidate without a kept-out claim',
  JSON.stringify({ hs: crossCls.householdSpending, block: /data-bill-payment-candidate/.test(crossHtml) }));
  // Merchant identity (D3 follow-up): the in-period hold is kept by H1's
  // label rule, so the debit is held on the bill, not counted twice. The
  // block still makes no kept-out claim; its wording holds in every case.
  const h1 = run([{ ...HYDRO, day: 22 }], [debit('2026-10-20', 90, 'Invented hydro')], '2026-10-21');
  const h1Tx = { ...h1.txOf('Invented hydro'), confirmedGrocery: true };
  const h1Cls = h1.classify(h1Tx);
  const h1Packet = { ...h1.packet, transactions: h1.packet.transactions.map(t => t === h1.txOf('Invented hydro') ? h1Tx : t) };
  const h1Html = detail({ packet: h1Packet }, { id: 'hydro', label: 'Invented hydro', date: '2026-10-22' });
  ok(h1Cls.householdSpending === false && h1Cls.reason === 'near-due-bill-unconfirmed'
    && /data-bill-payment-candidate/.test(h1Html) && !/kept out of household spending/i.test(h1Html),
  'merchant identity: the in-period debit is held on the bill and listed without a kept-out claim',
  JSON.stringify({ hs: h1Cls.householdSpending, reason: h1Cls.reason }));
  ok(/does not settle this bill, which stays reserved/.test(h1Html), 'the block states only what holds in every case');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll near-due bill payment checks passed.');
