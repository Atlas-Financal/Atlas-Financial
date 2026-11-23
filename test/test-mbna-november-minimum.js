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
 * The expected amount is the owner-supplied issuer figure, typed here by
 * hand, not read back from data.json.
 *
 * `node test/test-mbna-november-minimum.js`
 */
const F = require('../public/forecast.js');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const cents = x => Math.round(Number(x) * 100);
const NOW = '2026-11-23';
const ISSUER_MINIMUM_CENTS = 14072; // issuer app, owner screen 2026-11-23

const rows = id => data.plan.obligations.filter(o => o && o.id === id);
const [mbna] = rows('mbna'), [auto] = rows('mbna-auto30');
ok(!!mbna && mbna.lastDue === '2026-10-31', 'mbna still ends at its 2026-10-31 occurrence');
ok(!!auto && auto.firstDue === '2026-11-30', 'mbna-auto30 starts at 2026-11-30', auto && auto.firstDue);
const nov = ((auto && auto.statementOccurrences) || []).filter(s => s.scheduledDate === '2026-11-30');
ok(nov.length === 1 && nov[0].dueDate === '2026-11-30' && cents(nov[0].minimum) === ISSUER_MINIMUM_CENTS
  && nov[0].confidence === 'confirmed' && nov[0].currency === 'cad', 'one confirmed issuer statement row for 2026-11-30');
ok(![mbna, auto].some(r => r && (r.sentPayments || []).some(p => p && p.scheduledDate === '2026-11-30')),
  'no sent-payment record against the November occurrence');

const state = F.cardMinimumState(data.plan, NOW, {});
ok(state.status !== 'unavailable', 'card minimum state stays available', state.status);
ok(!state.issues.some(code => /sent-payment|issuer-minimum/.test(code)), 'no sent-payment issue codes', JSON.stringify(state.issues));

const r = F.recommend(data.plan, NOW, { debts: data.debts });
ok(r.weekly != null, 'the weekly figure is still published');
const all = r.payPeriodViews.flatMap(v => v.bills.map(b => ({ v, b })));
const hit = all.filter(({ b }) => b.id === 'mbna-auto30' && b.date === '2026-11-30');
ok(hit.length === 1, 'one mbna-auto30 bill row on 2026-11-30', String(hit.length));
if (hit.length === 1) {
  const { v, b } = hit[0];
  ok(v.timelineRole === 'current', 'it sits in the current pay period', v.timelineRole);
  ok(cents(b.planned) === ISSUER_MINIMUM_CENTS, 'planned is the issuer minimum still owing', String(b.planned));
  ok(cents(b.remaining) === ISSUER_MINIMUM_CENTS, 'remaining resolves to the issuer minimum still owing', String(b.remaining));
  ok(b.status === 'still due', 'it reads still due', b.status);
}
// One November minimum for this card.
const novRows = all.map(({ b }) => b).filter(b => /^mbna/.test(b.id) && b.date >= '2026-11-01' && b.date <= '2026-11-30');
ok(novRows.length === 1, 'exactly one minimum for this card in November', novRows.map(b => b.id + '@' + b.date).join(','));

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
