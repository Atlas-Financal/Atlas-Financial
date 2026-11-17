'use strict';
/* An unknown pending cannot establish that a card's limit is crossed.
 *
 * Invented values only. Before this fix, a card whose pending was unknown
 * opened the debt walk at posted + the retained (stale) pending, so a card
 * posted under its limit could read "already over" in `projectDebts().crossings`
 * while the opening mark beside it correctly said the over-limit state was
 * unknown. The assistant packet then published that crossing under
 * facilityCrossings status "ok" with no pending-unknown qualifier.
 *
 * The oracle is the raw input: with posted 1480 and limit 1500, the card is
 * over only if its unknown pending is above 20, which nothing establishes.
 * Posted 1520 against limit 1500 is over whatever the pending is.
 *
 * `node test/test-pending-unknown-crossings.js`
 */
const path = require('path');
const F = require(path.join(__dirname, '..', 'public', 'forecast'));
const P = require(path.join(__dirname, '..', 'scripts', 'assistant-packet.js'));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const AS_OF = '2027-02-01';
function plan(obligations) {
  return {
    windowDays: 60,
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    startingCash: { breakdown: [
      { id: 'chequing-a', value: 7200 }, { id: 'chequing-b', value: 0 }, { id: 'savings', value: 0 }] },
    opening: { asOf: AS_OF },
    budget: { basis: 'ytd', categories: [] },
    income: [], bills: [], obligations: obligations || [], commitments: [],
  };
}
const card = (posted, unknown, extra) => Object.assign({ id: 'card', label: 'Synthetic card',
  balance: posted, pending: 40, rate: 0, secured: false, limit: 1500 },
unknown ? { pendingUnknown: true } : {}, extra || {});
const packetFor = (p, debts) => P.buildPacket({
  data: { plan: p, debts, meta: { asOf: AS_OF } },
  periods: null, questionsMarkdown: '', now: '2027-02-01T12:00:00.000Z', env: {},
}).forecast.facilityCrossings;
const show = x => JSON.stringify(x);

console.log('=== 1. posted under the limit, pending unknown: the crossing is unknown ===');
{
  const proj = F.projectDebts(plan(), [card(1480, true)], AS_OF, {});
  const opening = proj.marks.find(m => m.day === 0).debts.find(d => d.id === 'card');
  ok(opening.overLimit === null, 'precondition: the opening mark leaves over-limit unknown', show(opening.overLimit));
  ok(!proj.crossings.some(c => c.id === 'card'), 'no crossing is published for the card', show(proj.crossings));
  ok(show(proj.crossingsUnknownFrom) === show(['card']), 'the card is named as an unknown crossing',
    show(proj.crossingsUnknownFrom));
  ok(proj.marks.every(m => m.debts.filter(d => d.id === 'card').every(d => d.firstOver === null)),
    'no mark carries a first-over date for the card');
  const fc = packetFor(plan(), [card(1480, true)]);
  ok(fc.status === 'unavailable' && fc.reason === 'pending-unknown',
    'packet: facilityCrossings is unavailable with reason pending-unknown, not ok', show(fc));
  ok(show(fc.pendingUnknownFrom) === show(['card']), 'packet: the qualifier names the card', show(fc.pendingUnknownFrom));
  ok(!(Array.isArray(fc.items) && fc.items.some(i => i.alreadyOver)), 'packet: no "already over" claim is published');
}

console.log('\n=== 2. control: the same card with a known pending of 40 is already over ===');
{
  const proj = F.projectDebts(plan(), [card(1480, false)], AS_OF, {});
  const c = proj.crossings.find(x => x.id === 'card');
  ok(c && c.alreadyOver === true && c.day === 0, '1480 + 40 = 1520 > 1500: already over on day 0', show(c));
  ok(proj.crossingsUnknownFrom === undefined, 'no unknown crossing is named');
  const fc = packetFor(plan(), [card(1480, false)]);
  ok(fc.status === 'ok' && fc.items.length === 1 && fc.items[0].alreadyOver === true
    && fc.pendingUnknownFrom === undefined && fc.items[0].pendingUnknown === undefined,
  'packet: ok with the known already-over crossing and no qualifier', show(fc));
}

console.log('\n=== 3. posted over the limit, pending unknown: already over is known ===');
{
  const proj = F.projectDebts(plan(), [card(1520, true)], AS_OF, {});
  const c = proj.crossings.find(x => x.id === 'card');
  ok(c && c.alreadyOver === true && c.day === 0, 'posted 1520 > 1500: already over whatever the pending', show(c));
  ok(proj.crossingsUnknownFrom === undefined, 'no unknown crossing is named');
  const fc = packetFor(plan(), [card(1520, true)]);
  ok(fc.status === 'ok' && fc.items.length === 1 && fc.items[0].alreadyOver === true
    && fc.items[0].pendingUnknown === true, 'packet: ok, the item carries pendingUnknown', show(fc));
}

console.log('\n=== 4. mixed: a known card still crosses, the unknown one is named ===');
{
  const cap = [{ id: 'cap', label: 'Capitalised interest', confidence: 'confirmed', nonCash: true,
    effect: 'capitalise', frequency: 'once', date: '2027-02-06', amount: 200, debtId: 'other' }];
  const other = { id: 'other', label: 'Other card', balance: 1200, limit: 1300, rate: 0, secured: false };
  const proj = F.projectDebts(plan(cap), [card(1480, true), other], AS_OF, {});
  const c = proj.crossings.find(x => x.id === 'other');
  ok(c && c.date === '2027-02-06' && c.alreadyOver === false, '1200 + 200 = 1400 > 1300 on Feb 6', show(c));
  ok(!proj.crossings.some(x => x.id === 'card') && show(proj.crossingsUnknownFrom) === show(['card']),
    'the unknown card is withheld and named');
  const fc = packetFor(plan(cap), [card(1480, true), other]);
  ok(fc.status === 'ok' && fc.items.length === 1 && fc.items[0].id === 'other'
    && show(fc.pendingUnknownFrom) === show(['card']), 'packet: ok with the known crossing and the qualifier', show(fc));
}

console.log('\n=== 5. a crossing the posted balance alone reaches is kept, dated on-or-before ===');
{
  // Pending only adds, so a card the posted position alone takes over its
  // limit is over by that day whatever the pending is; only the exact day
  // is unsure. Posted 500 + capitalised 2000 = 2500 > 1500 on Feb 11.
  const cap = (id, date, amount) => ({ id, label: 'Capitalised interest', confidence: 'confirmed',
    nonCash: true, effect: 'capitalise', frequency: 'once', date, amount, debtId: 'card' });
  const p1 = plan([cap('cap', '2027-02-11', 2000)]);
  const d1 = [card(500, true, { pending: 0 })];
  const proj = F.projectDebts(p1, d1, AS_OF, {});
  const c = proj.crossings.find(x => x.id === 'card');
  ok(c && c.date === '2027-02-11' && c.day === 10 && c.onOrBefore === true && c.alreadyOver === false
    && c.pendingUnknown === true, 'kept: on or before Feb 11 (day 10), not already over', show(c));
  ok(proj.crossingsUnknownFrom === undefined, 'the card is not named unknown: its crossing is established');
  const advice = F.recommend(p1, AS_OF, {});
  const risk = F.planPhases(p1, advice, proj, { sim: advice.sim }).risks
    .find(r => r.id === 'facilityCrossing' && r.debtId === 'card');
  ok(risk && risk.date === '2027-02-11' && risk.onOrBefore === true,
    'the Plan risk list still carries the crossing, flagged on-or-before', show(risk));
  const fc = packetFor(p1, d1);
  ok(fc.status === 'ok' && fc.items.length === 1 && fc.items[0].onOrBefore === true
    && fc.items[0].pendingUnknown === true && fc.pendingUnknownFrom === undefined,
  'packet: ok with the on-or-before item', show(fc));

  // Retained pending 40 would cross earlier (1300 + 40 + 180 = 1520 on Feb 5),
  // but posted alone reaches the limit only on Feb 11 (1300 + 180 + 50 = 1530):
  // the published day is the posted one, flagged on-or-before.
  const p2 = plan([cap('cap1', '2027-02-05', 180), cap('cap2', '2027-02-11', 50)]);
  const proj2 = F.projectDebts(p2, [card(1300, true)], AS_OF, {});
  const c2 = proj2.crossings.find(x => x.id === 'card');
  ok(c2 && c2.date === '2027-02-11' && c2.onOrBefore === true,
    'the retained pending\'s earlier Feb 5 day is not published; posted reaches Feb 11', show(c2));
  const control = F.projectDebts(p2, [card(1300, false)], AS_OF, {});
  const c3 = control.crossings.find(x => x.id === 'card');
  ok(c3 && c3.date === '2027-02-05' && !c3.onOrBefore, 'control: a known pending of 40 crosses exactly on Feb 5', show(c3));
}

console.log('\n=== 6. out of scope: no limit, or a secured line, is unchanged ===');
{
  const noLimit = F.projectDebts(plan(), [card(1480, true, { limit: null })], AS_OF, {});
  ok(noLimit.crossings.length === 0 && noLimit.crossingsUnknownFrom === undefined, 'a card with no limit names no crossing');
  const secured = F.projectDebts(plan(), [card(1480, true, { secured: true })], AS_OF, {});
  ok(secured.crossingsUnknownFrom === undefined, 'a secured line is not named (the opening-mark rule is unsecured only)');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
