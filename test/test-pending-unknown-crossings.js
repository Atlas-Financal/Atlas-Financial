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

console.log('\n=== 5. out of scope: no limit, or a secured line, is unchanged ===');
{
  const noLimit = F.projectDebts(plan(), [card(1480, true, { limit: null })], AS_OF, {});
  ok(noLimit.crossings.length === 0 && noLimit.crossingsUnknownFrom === undefined, 'a card with no limit names no crossing');
  const secured = F.projectDebts(plan(), [card(1480, true, { secured: true })], AS_OF, {});
  ok(secured.crossingsUnknownFrom === undefined, 'a secured line is not named (the opening-mark rule is unsecured only)');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
