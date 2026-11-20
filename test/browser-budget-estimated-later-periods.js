'use strict';
/* Browser proof: the live Budget page shows later pay periods, estimated,
 * while today's cash is unconfirmed (owner decision #821 6964438984).
 *
 * Invented data only, served to the real public/ page. An unknown chequing
 * opening makes Forecast withhold today's plan; later periods are released as
 * estimates. The page must keep "Current plan unavailable" for today and show
 * each later period's four figures, every one with the estimate tag. With a
 * known opening the page is the normal Budget and shows no such card.
 *
 * CHROME_PATH=<Chromium> node test/browser-budget-estimated-later-periods.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {
  console.log('SKIP browser-budget-estimated-later-periods: playwright is not installed.');
  process.exit(0);
}
const root = path.join(__dirname, '..');
const out = process.env.ATLAS_BUDGET_SCREENSHOTS_DIR || path.join(os.tmpdir(), 'budget-estimated-later-periods');
fs.mkdirSync(out, { recursive: true });

const AS_OF = '2026-10-09';
const data = openingKnown => ({
  meta: { asOf: AS_OF },
  debts: [], accounts: [], revolvingExtra: [],
  plan: {
    defaults: { targetBuffer: 500 }, windowDays: 91,
    startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented chequing', value: openingKnown ? 2500 : null, class: 'spendable' }] },
    opening: { asOf: AS_OF },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [{ id: 'payroll', label: 'Invented payroll', frequency: 'biweekly', anchor: '2026-10-09', amount: 3000, confidence: 'confirmed' }],
    bills: [{ id: 'rent', label: 'Invented rent', amount: 1200, frequency: 'monthly', day: 1, confidence: 'confirmed', payingAccount: 'chequing-a' }],
    obligations: [], commitments: [],
    budget: { categories: [{ id: 'groceries', label: 'Invented groceries', plannedWeekly: 100 }] },
  },
});

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const shots = [];
  try {
    for (const width of [1280, 390]) {
      for (const known of [false, true]) {
        const page = await browser.newPage({ viewport: { width, height: 1100 }, colorScheme: 'light', reducedMotion: 'reduce' });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', route => {
          const u = new URL(route.request().url());
          if (u.origin !== 'http://budget.test') return route.abort();
          if (u.pathname === '/data.json') return route.fulfill({ json: data(known) });
          if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
          const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
          if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
          return route.fulfill({ body: fs.readFileSync(file),
            contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
        });
        await page.goto('http://budget.test/?view=classic');
        await page.locator('[data-budget-surface]').first().waitFor();
        const label = `${known ? 'known' : 'unknown'}-opening ${width}px`;
        if (!known) {
          assert.equal(await page.locator('[data-budget-surface="unavailable"]').count(), 1, `${label}: today's plan is unavailable`);
          const card = page.locator('[data-estimated-later-periods]');
          await card.waitFor();
          assert.equal(await card.isVisible(), true, `${label}: the Later pay periods card is visible`);
          const periods = card.locator('[data-estimated-later-period]');
          assert.equal(await periods.count(), 5, `${label}: five later periods are listed`);
          const first = periods.first();
          assert.equal(await first.locator('.estimated-later-range').innerText(), 'Oct 23–Nov 5');
          const text = await first.innerText();
          for (const want of [/Income\s*\$3,000\.00\s*estimate/, /Bills\s*\$1,200\.00\s*estimate/,
            /Household budget\s*\$200\.00\s*estimate/, /Balance After Deductions\s*\$1,600\.00\s*estimate/]) {
            assert.match(text, want, `${label}: first later period shows ${want}`);
          }
          assert.equal(await card.locator('.trust-tag.trust-estimated:visible').count(), 20,
            `${label}: all twenty figures carry a visible estimate tag`);
          await card.scrollIntoViewIfNeeded();
        } else {
          assert.equal(await page.locator('[data-budget-surface="unavailable"]').count(), 0, `${label}: the normal Budget`);
          assert.equal(await page.locator('[data-estimated-later-periods]').count(), 0, `${label}: no estimate card`);
        }
        assert.deepEqual(errors, [], `${label}: no page errors`);
        const shot = path.join(out, `budget-later-${known ? 'known' : 'unknown'}-${width}.png`);
        await page.screenshot({ path: shot, fullPage: true, animations: 'disabled' });
        shots.push(shot);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log('Budget estimated later periods: browser checks passed.');
  for (const shot of shots) console.log('  ' + shot);
})().catch(err => { console.error(err); process.exit(1); });
