'use strict';
/* Plan Spend funding figures carry Forecast's funding trust.
 * `node test/test-plan-spend-funding-trust.js`
 *
 * "Set aside", "Protected when set aside", "Still to fund", the shortfall,
 * the next contribution and the projected fully-funded date are funding-path
 * projections. Forecast tags them with schedule.fundingTrust. This suite runs
 * the real public/plan-spend.js in a vm with the real app.js formatters and
 * reads the HTML the household would read. The schedule, the cards and every
 * amount are invented; the expected strings are written by hand. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const appSrc = read('public/app.js');
const grab = re => { const m = re.exec(appSrc); if (!m) throw new Error('missing ' + re); return m[0]; };
const helpers = [grab(/^const money = .*$/m), grab(/^const money2 = .*$/m), grab(/^const pct = .*$/m),
  grab(/^const fmtDate = .*$/m), grab(/^const fmtDateLong = .*$/m), grab(/^const fmtDateFull = .*$/m)].join('\n');

const ESTIMATE = ' <span class="trust-tag trust-estimated">estimate</span>';
const CALCULATED = ' <span class="trust-tag">calculated</span>';

// Invented: one confirmed cost, two paydays, one shortfall.
function schedule(fundingTrust) {
  const s = {
    source: 'Forecast.planSpendPaydayFunding', asOf: '2026-03-01',
    costs: [{ id: 'roof', label: 'Invented roof', date: '2026-06-15', confidence: 'confirmed',
      protectedNow: 45, stillToFund: 860, nextContribution: { amount: 120, payday: '2026-03-06' },
      projectedFullyFunded: '2026-05-29', contributions: [{ payday: '2026-03-06', amount: 120 }] }],
    groups: [],
    paydays: [{ payday: '2026-03-06', contribution: 120, protectedAfterPayday: 160, stillToFund: 860,
      allocations: [{ id: 'roof', label: 'Invented roof', amount: 120 }], payments: [] }],
    gap: { payday: '2026-03-06', required: 300, available: 260, shortBy: 40, affected: ['roof'] },
  };
  if (fundingTrust !== undefined) s.fundingTrust = fundingTrust;
  return s;
}
function render(fundingTrust) {
  const ctx = {
    console,
    App: { register() {}, boot() {} },
    Forecast: { planSpendCards: () => [{ kind: 'row', id: 'roof', label: 'Invented roof', need: 1000,
      date: '2026-06-15', confidence: 'confirmed', verdict: 'ON TRACK', flexibility: 'required' }] },
  };
  vm.runInNewContext(`${helpers}\n${read('public/plan-spend.js')}`, ctx, { filename: 'plan-spend.js' });
  const advice = { majorPlans: [{ id: 'roof' }], planSpendPaydayFunding: schedule(fundingTrust) };
  const page = ctx.planSpendPageHtml(advice, null, {});
  return page.lede + page.list;
}

console.log('\nEstimated funding trust');
{
  const html = render('estimated');
  ok(html.includes('Set aside: ≈ $120.00' + ESTIMATE), 'Set aside reads ≈ $120.00 estimate');
  ok(html.includes('<dt>Protected when set aside</dt><dd>≈ $160.00' + ESTIMATE), 'protected when set aside is tagged estimate');
  ok(html.includes('<dt>Still to fund</dt><dd>≈ $860.00' + ESTIMATE), 'still to fund (hero) is tagged estimate');
  ok(html.includes('short by ≈ $40.00' + ESTIMATE), 'the shortfall is tagged estimate');
  ok(html.includes('<dt>Still to fund in this plan</dt><dd>≈ $860.00' + ESTIMATE), 'still to fund (card) is tagged estimate');
  ok(html.includes('<dt>Next contribution</dt><dd>≈ $120.00' + ESTIMATE + ' on March 6, 2026'), 'next contribution is tagged estimate');
  ok(html.includes('<dt>Projected fully funded</dt><dd>≈ May 29, 2026' + ESTIMATE), 'projected fully funded is tagged estimate, not the cost’s confirmed');
  ok(!/Set aside: \$/.test(html) && !/<dd>\$860\.00<\/dd>/.test(html), 'no funding figure prints bare');
  ok(html.includes('data-plan-spend-funding-trust="estimated"'), 'the funding block names its trust');
}

console.log('\nCalculated funding trust');
{
  const html = render('calculated');
  ok(html.includes('Set aside: $120.00' + CALCULATED), 'Set aside reads $120.00 calculated');
  ok(html.includes('<dt>Projected fully funded</dt><dd>May 29, 2026' + CALCULATED), 'projected fully funded is tagged calculated');
  ok(!/≈/.test(html), 'calculated funding figures carry no ≈');
}

for (const [trust, name] of [[undefined, 'missing'], ['unknown', 'unknown'], ['unavailable', 'unavailable'], ['confirmed', 'a promoted word']]) {
  console.log(`\nFunding trust ${name}`);
  const html = render(trust);
  ok(html.includes('Set aside: Not established'), `Set aside is Not established when funding trust is ${name}`);
  ok(!/\$120\.00|\$160\.00|\$860\.00|\$40\.00/.test(html), `no funding figure prints when funding trust is ${name}`);
  ok(html.includes('<dt>Projected fully funded</dt><dd>Not established'), `projected fully funded is Not established when funding trust is ${name}`);
  ok(html.includes('data-plan-spend-funding-trust="unpublished"'), `the page says the funding trust is unpublished (${name})`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
