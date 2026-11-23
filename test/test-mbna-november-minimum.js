'use strict';
/* Amazon.ca Mastercard (MBNA) November minimum — owner 2026-11-23 (Dale).
 *
 * The issuer's app shows the minimum still owing for the 2026-11-30 due
 * date after two November payments had already posted. That issuer figure
 * is recorded as a statement occurrence on `mbna-auto30` (the automatic
 * payment from Bills on the 30th), which now starts 2026-11-30; `mbna`
 * still ends at 2026-10-31. No sent-payment records: Forecast does not
 * subtract a part payment from a statement minimum, and a part-paying sent
 * record would make every card minimum unavailable (BACKLOG B107).
 *
 * Production data is checked for shape only: no household amount is typed
 * here or printed. The amount behaviour is proved on an invented minimum.
 *
 * Retire when the 2026-11-30 occurrence leaves the plan's dated history.
 *
 * `node test/test-mbna-november-minimum.js`
 */
const F = require('../public/forecast.js');
const data = require('../data.json');

let failures = 0;
// Details are dates, ids, counts and statuses only, never an amount.
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const cents = x => Math.round(Number(x) * 100);
const clone = x => JSON.parse(JSON.stringify(x));
const NOW = '2026-11-23';
const OCC = '2026-11-30';

function novemberRow(plan) {
  const r = F.recommend(plan, NOW, { debts: data.debts });
  const all = r.payPeriodViews.flatMap(v => v.bills.map(b => ({ v, b })));
  return { r, all, hit: all.filter(({ b }) => b.id === 'mbna-auto30' && b.date === OCC) };
}

console.log('Production shape (no amounts)');
const rows = id => data.plan.obligations.filter(o => o && o.id === id);
const [mbna] = rows('mbna'), [auto] = rows('mbna-auto30');
ok(!!mbna && mbna.lastDue === '2026-10-31', 'mbna still ends at its 2026-10-31 occurrence');
ok(!!auto && auto.firstDue === OCC, 'mbna-auto30 starts at 2026-11-30', auto && auto.firstDue);
const nov = ((auto && auto.statementOccurrences) || []).filter(s => s.scheduledDate === OCC);
ok(nov.length === 1 && nov[0].dueDate === OCC && cents(nov[0].minimum) > 0
  && nov[0].confidence === 'confirmed' && nov[0].currency === 'cad', 'one confirmed issuer statement row for 2026-11-30');
ok(nov.length === 1 && nov[0].paymentsReflectedThrough === NOW,
  'it reflects payments through 2026-11-23, the date of the issuer screen (no November payment is credited again)');
ok(![mbna, auto].some(r => r && (r.sentPayments || []).some(p => p && p.scheduledDate === OCC)),
  'no sent-payment record against the November occurrence');

const state = F.cardMinimumState(data.plan, NOW, {});
ok(state.status !== 'unavailable', 'card minimum state stays available', state.status);
ok(Array.isArray(state.issues) && state.issues.length === 0, 'no card minimum issue codes', JSON.stringify(state.issues));

const prod = novemberRow(data.plan);
ok(prod.r.weekly != null, 'the weekly figure is still published');
ok(prod.hit.length === 1, 'one mbna-auto30 bill row on 2026-11-30', String(prod.hit.length));
if (prod.hit.length === 1) {
  const { v, b } = prod.hit[0];
  ok(v.timelineRole === 'current', 'it sits in the current pay period', v.timelineRole);
  ok(nov.length === 1 && cents(b.planned) === cents(nov[0].minimum) && cents(b.remaining) === cents(nov[0].minimum),
    'planned and remaining are the recorded issuer minimum still owing');
  ok(b.status === 'still due', 'it reads still due', b.status);
}
const novRows = prod.all.map(({ b }) => b).filter(b => /^mbna/.test(b.id) && b.date >= '2026-11-01' && b.date <= OCC);
ok(novRows.length === 1, 'exactly one minimum for this card in November', novRows.map(b => b.id + '@' + b.date).join(','));

console.log('Invented minimum (behaviour)');
{
  const plan = clone(data.plan);
  const row = plan.obligations.find(o => o.id === 'mbna-auto30');
  const occ = ((row && row.statementOccurrences) || []).find(s => s.scheduledDate === OCC);
  if (occ) occ.minimum = 123.45; // invented
  const { hit } = novemberRow(plan);
  ok(hit.length === 1 && cents(hit[0].b.planned) === 12345 && cents(hit[0].b.remaining) === 12345,
    'an invented 123.45 issuer minimum is planned and still owing as 123.45');
  ok(hit.length === 1 && hit[0].b.status === 'still due', 'and reads still due');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
