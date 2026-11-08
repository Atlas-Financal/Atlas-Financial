'use strict';
/* The real Budget page (public/index.html boot: forecast.js, plan.js and
 * the rest, in headless Chromium) with a household chequing opening row
 * that carries no numeric evidence. The unavailable state must reach every
 * published total the cash walk seeds: no precise LEFT OVER, daily balance,
 * spendable cash or savings-funding figure may appear anywhere on the page.
 *
 * Invented acceptance-harness world only (test/acceptance/harness.js:
 * Chequing A 2000, Chequing B 500, Savings 1000, all invented). The known
 * control proves the assertion can fail: with both rows known the same page
 * prints the hand-computed "Money available" $2,500.00 (2000 + 500).
 *
 * `node test/browser-unknown-chequing-opening-budget.js`
 */
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const PRECISE = /[$]\s?\d/;
const REASON = 'A household chequing opening balance is unknown.';

async function render(patch) {
  const w = H.baseWorld();
  if (patch) w.dataPatch = d => patch(d.plan.startingCash.breakdown);
  const p = await H.openBudget(H.dataOf(w).data);
  try {
    // Visible page text plus every Budget-surface leaf's text (collapsed
    // disclosures included), one entry per line.
    const body = await p.page.evaluate(() => [document.body.innerText,
      ...[...document.querySelectorAll('[data-budget-surface] *')]
        .filter(e => !e.children.length).map(e => e.textContent.replace(/\s+/g, ' ').trim())]
      .join('\n'));
    const surface = await p.page.evaluate(() => [...document.querySelectorAll('[data-budget-surface]')]
      .map(e => e.textContent.replace(/\s+/g, ' ').trim()).join(' | '));
    return { body, surface, errors: p.errors.slice() };
  } finally { await p.close(); }
}

(async () => {
  try {
    console.log('Known control: Chequing A 2000, Chequing B 500');
    const known = await render(null);
    ok(!known.errors.length, 'page boots without errors', known.errors.join('; '));
    ok(/Money available\s*\$2,500\.00/.test(known.surface),
      'the page prints the hand-computed Money available $2,500.00');
    ok(PRECISE.test(known.body), 'precise figures are present when the opening is known');
    ok(!known.body.includes(REASON), 'no unknown-opening note when every row is known');

    // With only Chequing B unknown, the Bills account (Chequing A) balance is
    // still genuinely known and is its own publication (ATLAS-078): exactly
    // one line may print it, the hand value $2,000.00, and nothing else.
    const BILLS_ONLY = /^Latest recorded Bills balance: \$2,000\.00, dated October 14\./;
    for (const [name, patch, billsKnown] of [
      ['Chequing A value null', rows => { rows.find(r => r.id === 'chequing-a').value = null; }, false],
      ['Chequing A unknown:true (value kept)', rows => { rows.find(r => r.id === 'chequing-a').unknown = true; }, false],
      ['Chequing B value ""', rows => { rows.find(r => r.id === 'chequing-b').value = ''; }, true],
    ]) {
      console.log(`\n${name}`);
      const page = await render(patch);
      ok(!page.errors.length, 'page boots without errors', page.errors.join('; '));
      ok(page.body.includes(REASON), 'the page names the unknown chequing opening');
      ok(/Current plan unavailable/.test(page.body), 'the current plan reads unavailable');
      const precise = page.body.split('\n').filter(line => PRECISE.test(line)
        && !(billsKnown && BILLS_ONLY.test(line.trim())));
      if (billsKnown) ok(page.body.split('\n').some(line => BILLS_ONLY.test(line.trim())),
        'the known Bills account balance still prints its hand value $2,000.00');
      const surfacePrecise = (billsKnown ? page.surface.replace(/Latest recorded Bills balance: \$2,000\.00/g, '') : page.surface).match(/[$]\s?\d[\d,.]*/g) || [];
      ok(!surfacePrecise.length, 'the Budget surface text (hidden sections included) has no precise figure',
        surfacePrecise.slice(0, 3).join(' | '));
      ok(!precise.length,
        'no precise dollar figure anywhere on the page (LEFT OVER, daily balance, spendable cash, savings funding)',
        precise.slice(0, 3).join(' | '));
      const rest = billsKnown ? page.body.split('\n').filter(line => !BILLS_ONLY.test(line.trim())).join('\n') : page.body;
      ok(!/\$2,500|\$2,000|\$500|\$0\.00/.test(rest), 'neither the known pool, a partial pool nor $0.00 is printed');
    }
  } finally {
    await H.closeBrowser();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll unknown-chequing-opening Budget page checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
