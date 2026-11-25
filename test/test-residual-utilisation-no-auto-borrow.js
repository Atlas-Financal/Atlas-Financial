'use strict';
/* B70, residual utilisation (Neon on #1624, #1607 7141215801): a funding option with no `debtId`, no `cash` and no
 * declared `available` resolves to the residual of unclaimed utilisation, which is borrowing room (unclaimed card
 * limits or extra facilities). It must never auto-cover an opening gap, even when it carries `unusable: false`.
 * Before this change only an extra-facility row marked it as borrowing headroom, so unclaimed card room could fund
 * the gap; the live cards aggregate was safe only because it carries `unusable: true`.
 *
 *   1. An invented world: a $104.89 opening gap and a cards residual option with `unusable: false` over $900 of card
 *      room. On main it covers the gap; on this head it contributes 0, the shortfall is the full gap and
 *      the weekly cap is 0. Its visible headroom is unchanged.
 *   2. Controls: an explicit cash source still funds the gap; the live shape (`unusable: true`) is unchanged.
 *   3. A mutant restoring the extra-facility-only mark is caught.
 *
 * Invented values only, worked by hand. `node test/test-residual-utilisation-no-auto-borrow.js`
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast.js');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.005;
const ROOT = path.join(__dirname, '..');
const BASE = '2ea0cc18a6cc02456bb2e73f08b66088dc507aa4'; // main before this change (#1630 merged)
function engine(source) {
  const c = { console };
  c.window = c;
  vm.createContext(c);
  const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const file of ['public/display-name.js', 'public/forecast-card-period.js']) vm.runInContext(read(file), c);
  vm.runInContext(source, c);
  return c.Forecast;
}
const mainSource = () => cp.execFileSync('git', ['show', BASE + ':public/forecast.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Hand-worked invented world: chequing 300.00 + 100.00 = 400.00 spendable; a 205.11 bill before the payday leaves
// 194.89 against a 300.00 buffer, so the opening gap is 300.00 − 194.89 = 105.11.
// One card: limit 1000.00, balance 100.00, so 900.00 of unclaimed room (well above the gap).
const AS_OF = '2031-04-10', BUFFER = 300, GAP = 105.11, ROOM = 900;
function world(cards) {
  const plan = {
    windowDays: 21, defaults: { targetBuffer: BUFFER },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 300 }, { id: 'chequing-b', value: 100 }], heldElsewhere: [] },
    opening: { asOf: AS_OF },
    income: [{ id: 'pay', label: 'Invented pay', frequency: 'once', date: '2031-04-17', amount: 2000, confidence: 'confirmed' }],
    bills: [{ id: 'pre', label: 'Invented bill', frequency: 'once', date: '2031-04-15', amount: 205.11, confidence: 'confirmed' }],
    obligations: [], commitments: [],
    funding: { options: [cards] },
  };
  const debts = [{ id: 'card', balance: 100, pending: 0, pendingUnknown: false, secured: false, limit: 1000 }];
  return { plan, debts, extraFacilities: [] };
}
const run = (E, data) => E.recommend(data.plan, AS_OF, { fundingSources: data.plan.funding.options, debts: data.debts,
  extraFacilities: data.extraFacilities, targetBuffer: BUFFER });
const usableCards = { id: 'cards', rank: 1, unusable: false, label: 'Invented cards', short: 'cards' };

console.log('1. A usable cards residual option over unclaimed card room');
{
  const data = world(usableCards);
  const zero = F.simulate(data.plan, AS_OF, { weeklyVariable: 0, targetBuffer: BUFFER });
  ok(near(BUFFER - zero.min.balance, GAP), 'the world: the opening gap is 105.11 (hand-worked)', String(BUFFER - zero.min.balance));
  const resolved = F.resolveFundingSources(data.plan.funding.options, data.extraFacilities, data.plan, data.debts);
  ok(near(resolved[0].available, ROOM), 'its visible headroom is the 900.00 of unclaimed card room', String(resolved[0].available));
  const OLD = engine(mainSource());
  const before = run(OLD, data);
  ok(before.funding && before.funding.feasible === true && before.funding.parts.some(p => p.id === 'cards'),
    'on main the card room funds the opening gap (the defect)', JSON.stringify(before.funding && before.funding.parts));
  const rec = run(F, data);
  const src = rec.funding.sources.find(s => s.id === 'cards');
  ok(rec.mode === 'openingGap' && rec.funding.feasible === false && near(rec.funding.shortfall, GAP),
    'on this head the gap stays unfunded: the shortfall is the full 105.11', JSON.stringify([rec.funding.feasible, rec.funding.shortfall]));
  ok(src && near(src.contributes, 0) && src.verdict === 'insufficient' && near(src.shortBy, GAP) && near(src.available, ROOM),
    'the cards source contributes 0, is short by the full gap, and keeps its 900.00 visible', JSON.stringify(src));
  ok(rec.funding.parts.length === 0 && !(rec.simOptions.injections || []).length, 'no recovery injection is made');
  ok(rec.weekly === 0, 'no weekly cap is published from borrowed room', String(rec.weekly));
}

console.log('2. Controls');
{
  const live = run(F, world({ id: 'cards', rank: 1, unusable: true }));
  const liveOld = run(engine(mainSource()), world({ id: 'cards', rank: 1, unusable: true }));
  ok(JSON.stringify(live.funding) === JSON.stringify(liveOld.funding) && live.weekly === liveOld.weekly,
    'the live shape (unusable: true) publishes exactly as on main');
  const cash = world(usableCards);
  cash.plan.funding.options = [{ id: 'cash-pot', label: 'Invented cash', short: 'cash', available: 200, rank: 1 }, { ...usableCards, rank: 2 }];
  const rec = run(F, cash);
  ok(rec.funding.feasible === true && rec.funding.parts.length === 1 && rec.funding.parts[0].id === 'cash-pot' && rec.weekly > 0,
    'an explicit cash source still funds the gap, ahead of the card room', JSON.stringify(rec.funding.parts));
}

console.log('3. Mutant');
{
  const src = fs.readFileSync(path.join(ROOT, 'public/forecast.js'), 'utf8');
  const from = 'if (available > 0) markExtraHeadroom();';
  assert.ok(src.includes(from));
  const mutant = engine(src.replace(from, 'if (available > 0 && byId.has(row.id)) markExtraHeadroom();'));
  ok(run(mutant, world(usableCards)).funding.feasible === true, 'mutant caught: the extra-facility-only mark lets card room fund the gap again');
}
console.log(`\n${checks} checks passed`);
