'use strict';
// The current-period worksheet (#payday-answer, printed by plan.js
// paydayAnswerHtml) stays hidden from the household (lead ruling, option A,
// 2026-11-19, as #1365 did for #road-ahead). Several of its figures print
// without their own Forecast trust tag (BACKLOG, the payday-answer trust
// sweep), so the card is safe only while it is never shown. Unhiding it must
// fail here first:
//   S1 the section ships hidden, inert and aria-hidden in index.html;
//   S2 no page script refers to the section itself (only to its body mount),
//      so no script can unhide it;
//   S3 on the real page (harness world, 1280 and 390 wide) the section is
//      hidden, display:none and not visible, while its body is still rendered.
// Invented data only.
//
// `node test/test-payday-answer-stays-hidden.js`
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

console.log('=== S1 static markup ===');
const html = read('public/index.html');
const tag = (/<section id="payday-answer"[^>]*>/.exec(html) || [''])[0];
ok(/\shidden(\s|>)/.test(tag) && /\sinert(\s|>)/.test(tag) && /aria-hidden="true"/.test(tag),
  '#payday-answer ships hidden, inert and aria-hidden (its figures are not all trust-tagged)', tag);

console.log('\n=== S2 no script refers to the section ===');
const scripts = fs.readdirSync(path.join(__dirname, '../public')).filter(name => name.endsWith('.js'));
const referring = scripts.filter(name => /['"`#]payday-answer['"`\]\s)]/.test(read('public/' + name)));
ok(referring.length === 0, 'no public/*.js refers to #payday-answer itself (only to #payday-answer-body)', referring.join(', '));

function hasBrowser() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}

(async () => {
  console.log('\n=== S3 the real page ===');
  if (!hasBrowser() || process.env.ATLAS_SKIP_BROWSER === '1') {
    console.log('  SKIP  S3 page case: Playwright Chromium is not available here');
  } else {
    const H = require('./acceptance/harness.js');
    for (const width of [1280, 390]) {
      await H.withBudget(H.baseWorld(), async p => {
        const info = await p.page.evaluate(() => {
          const section = document.getElementById('payday-answer');
          const body = document.getElementById('payday-answer-body');
          return { hidden: !!(section && section.hidden), display: section ? getComputedStyle(section).display : null,
            rendered: body ? body.innerHTML.length : 0 };
        });
        const visible = await p.page.locator('#payday-answer').isVisible();
        ok(info.hidden && info.display === 'none' && !visible && info.rendered > 0,
          `at ${width}px #payday-answer is hidden and not visible, though its body is rendered`, JSON.stringify(info));
      }, { width });
    }
    await H.closeBrowser();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll payday-answer hidden checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
