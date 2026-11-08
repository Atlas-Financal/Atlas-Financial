'use strict';
/* Rendered proof: early income is settled once on the page a household reads.
 *
 * Invented worlds from test/fixtures/early-income-settlement-worlds.js run
 * through scripts/live-plan.js fromObservation and the real public/index.html
 * boot in headless Chromium, every request intercepted. Expected text is hand
 * arithmetic in that fixture. Not part of `npm test` (needs Chromium).
 *
 * `node test/browser-early-income-settlement.js`
 */
const { H, childBenefit, rent } = require('./fixtures/early-income-settlement-worlds');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

async function page(w) {
  const p = await H.openBudget(H.dataOf(w).data);
  try {
    return await p.page.evaluate(() => {
      const flat = el => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
      const all = flat(document.body);
      const next14 = (all.match(/The next 14 days(.*?)(?:Target ending buffer|$)/) || [])[1] || '';
      return {
        hero: [...document.querySelectorAll('#payday-answer-body .payday-hero')].map(flat),
        income: flat([...document.querySelectorAll('[data-operating-question]')]
          .find(e => /^[^A-Za-z]*Income/.test(flat(e)))),
        next14,
        errors: [],
      };
    }).then(r => Object.assign(r, { errors: p.errors.slice() }));
  } finally { await p.close(); }
}

(async () => {
  try {
    console.log('=== 1. Child benefit posted Fri Oct 16 for Sun Oct 18 ===');
    const cbControl = await page(childBenefit('control'));
    const cb = await page(childBenefit('early'));
    ok(cbControl.hero.includes('$405/ week'), 'control prints $405/week', cbControl.hero.join('|'));
    ok(/Oct 18 \+250/.test(cbControl.next14), 'control: the next 14 days still expect Oct 18 +250');
    ok(cb.hero.includes('$405/ week'), 'early prints $405/week (main printed $700)', cb.hero.join('|'));
    ok(cb.next14.length > 0 && !/Oct 18 \+250/.test(cb.next14), 'early: the next 14 days no longer show Oct 18 +250', cb.next14.slice(0, 160));
    ok(/Invented child benefit · Oct 18 · received/.test(cb.income), 'early: Budget income row says received', cb.income.slice(0, 200));
    ok(!cb.errors.length, 'no page errors', cb.errors.join('|'));

    console.log('=== 2. Rent posted Fri Oct 30 for Sun Nov 1 (identity rule) ===');
    const rentControl = await page(rent('control'));
    const re = await page(rent('early'));
    ok(rentControl.hero.includes('$465/ week'), 'control prints $465/week', rentControl.hero.join('|'));
    ok(re.hero.includes('$465/ week'), 'early prints $465/week (main printed $855)', re.hero.join('|'));
    ok(/Invented rent · Nov 1 · received/.test(re.income), 'early: Budget income row says received', re.income.slice(0, 200));
    ok(!/Nov 1 \+800/.test(re.next14), 'early: the next 14 days do not show Nov 1 +800');

    console.log('=== 3. Ambiguous early receipts are withheld, never received ===');
    const cbAmb = await page(childBenefit('ambiguous'));
    const rentAmb = await page(rent('ambiguous'));
    ok(cbAmb.hero.includes('$405/ week'), 'ambiguous child benefit prints $405/week', cbAmb.hero.join('|'));
    ok(/Invented child benefit · Oct 18/.test(cbAmb.income) && !/Invented child benefit · Oct 18 · received/.test(cbAmb.income),
      'ambiguous child benefit row is listed and not received', cbAmb.income.slice(0, 200));
    ok(rentAmb.hero.includes('$465/ week'), 'ambiguous rent prints $465/week', rentAmb.hero.join('|'));
    ok(/Invented rent · Nov 1/.test(rentAmb.income) && !/Invented rent · Nov 1 · received/.test(rentAmb.income),
      'ambiguous rent row is listed and not received', rentAmb.income.slice(0, 200));
  } finally { await H.closeBrowser(); }
  if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nAll rendered early-income checks passed.');
})().catch(e => { console.error(e); process.exit(1); });
