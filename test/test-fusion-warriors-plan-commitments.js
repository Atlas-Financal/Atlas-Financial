'use strict';
/* Owner + Interac Fusion $1,200 paid row; remaining instalments $3,300 only
 * after settledOn relative to opening. */
const F = require('../public/forecast.js');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const plan = data.plan;
const rows = plan.commitments || [];
const byId = Object.fromEntries(rows.map(r => [r.id, r]));
const OWNER_PAID = 1200;
const REMAINING = 3300;
const HOUSEHOLD_TOTAL = 4500;

console.log('=== stale rows retired (owner supersedes) ===');
ok(!byId['fusion-season'], 'fusion-season ~$2,000 row removed — not open beside new rows');
ok(!rows.some(c => c.id === 'warriors' && c.amount != null && near(c.amount, 800)
  && c.date === '2026-09-15'),
  'warriors ~$800 / Sep 15 stale row replaced — not left open');

console.log('\n=== Fusion paid settled on Interac evidence ===');
const paid = byId['fusion-household-paid'];
ok(paid && near(paid.amount, OWNER_PAID) && paid.settledOn === '2026-09-10',
  'paid row is $1,200 settledOn 2026-09-10');
ok(paid && /2482361282/.test(paid.note || '') && /C1AkZfteDgMe|logan and lindens first payment/i.test(paid.note || ''),
  'note cites live LM id 2482361282 and Interac ref/memo');
ok(paid && /2482361281/.test(paid.note || '') && /IQ255|1,925|1925/.test(paid.note || ''),
  'Sep-10 chain context cites coaching LM id and tennis remainder only in note');
ok(paid && /never plan\.income|do not encode \$3,125 or \$1,925 as plan income/i.test(paid.note || ''),
  'coaching and tennis remainder are not plan income');
ok(!(plan.income || []).some(s => /3125|1925|2482361281|2482361282/i.test(JSON.stringify(s))),
  'plan.income has no Sep-10 coaching or Fusion LM rows');
ok(!!paid && !paid.lmId && !paid.lunchMoneyId,
  'LM ids live in note only — no schema field on commitment row');

const remainingSum = ['fusion-household-oct', 'fusion-household-nov', 'fusion-household-dec']
  .reduce((s, id) => s + byId[id].amount, 0);
ok(near(remainingSum, REMAINING), 'remaining instalments sum to $3,300', String(remainingSum));
ok(near(OWNER_PAID + remainingSum, HOUSEHOLD_TOTAL),
  'paid + remaining = $4,500 household total');

const pubAfter = F.publicationTotals(Object.assign({}, data, {
  meta: Object.assign({}, data.meta, { asOf: '2026-09-11' }),
}));
const fusionAfter = pubAfter.commitmentItems
  .filter(i => /^fusion-household-/.test(i.id))
  .reduce((s, i) => s + (i.amount || 0), 0);
ok(near(fusionAfter, REMAINING),
  'after 2026-09-11 opening, publication encumbers remaining Fusion only',
  String(fusionAfter));
ok(!pubAfter.commitmentItems.some(i => i.id === 'fusion-household-paid'),
  'paid Fusion row drops from publication after settledOn');

console.log('\n=== Warriors exact $895 settled on the Travel Visa posting ===');
ok(byId.warriors.date === '2026-09-23' && near(byId.warriors.amount, 895)
  && byId.warriors.amountMin == null && byId.warriors.settledOn === '2026-09-21',
  'Warriors due 23 Sep is an exact $895 settled on 21 Sep');
const pubWarriorsOpen = F.publicationTotals(data);
ok(pubWarriorsOpen.commitmentItems.some(i => i.id === 'warriors' && near(i.amount, 895)
    && i.amountMin == null),
  'the 19 Aug opening still publishes the unpaid-relative $895 point');
const pubWarriorsSettled = F.publicationTotals(Object.assign({}, data, {
  meta: Object.assign({}, data.meta, { asOf: '2026-09-23' }),
}));
ok(!pubWarriorsSettled.commitmentItems.some(i => i.id === 'warriors'),
  'after settledOn, publication no longer encumbers Warriors');

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nFusion/Warriors plan commitment checks passed.');
