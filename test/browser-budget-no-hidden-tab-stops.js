'use strict';
// Browser proof: on the Budget face, Tab never lands on a control nobody can see.
// The real page, fed by the real observer -> live overlay -> Forecast path with
// invented Lunch Money rows (acceptance harness). It walks the whole Tab order and
// records every stop whose box is smaller than 4x4 px, or whose centre is covered by
// another element. The one known exception is pinned by name: the "Current balance
// and funding details" (ⓘ) button, the only route to that evidence, left for the lead.
// Run by hand like the other browser proofs: `node test/browser-budget-no-hidden-tab-stops.js`
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
// Invented world with something for the attention section: a hydro bill past due
// with no payment row (to confirm) and a restaurants overspend.
const world = () => {
  const w = H.baseWorld();
  w.bills = [{ id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 10, confidence: 'confirmed', payee: 'Invented hydro' }];
  w.transactions = [
    H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ date: '2026-10-11', amount: 160, category: 'Restaurants', account: 'chequing-b', payee: 'Invented diner' }),
  ];
  return w;
};
const KNOWN = /Current balance and funding details|Dated balance and funding details/;

(async () => {
  try {
    for (const width of [1440, 390]) {
      await H.withBudget(world(), async p => {
        await p.page.setViewportSize({ width, height: 1000 });
        await p.page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); });
        const hidden = [], seen = new Set();
        let stops = 0;
        for (let i = 0; i < 250; i++) {
          await p.page.keyboard.press('Tab');
          const stop = await p.page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            if (!el.dataset.tabProbe) el.dataset.tabProbe = String(Math.random()).slice(2);
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            const covered = !hit || !(hit === el || el.contains(hit) || hit.contains(el));
            const name = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
            return { id: el.dataset.tabProbe, tag: el.tagName, name, w: Math.round(r.width), h: Math.round(r.height), covered };
          });
          if (!stop) continue;
          if (seen.has(stop.id)) break; // wrapped around
          seen.add(stop.id); stops++;
          if (stop.w < 4 || stop.h < 4 || stop.covered) hidden.push(stop);
        }
        ok(stops > 5, `${width}px: walked the Tab order`, `${stops} stops`);
        // Positive control: the world does put items in the off-stage attention section.
        const attention = await p.page.$$eval('[data-budget-browse="attention"] .budget-attention-item', els => els.map(e => e.tabIndex));
        ok(attention.length > 0 && attention.every(t => t === -1), `${width}px: off-stage attention items exist and are not Tab stops`, JSON.stringify(attention));
        const unexpected = hidden.filter(s => !KNOWN.test(s.name));
        ok(unexpected.length === 0, `${width}px: no Tab stop lands on an invisible control (apart from the pinned exception)`,
          JSON.stringify(unexpected));
        ok(p.errors.length === 0, `${width}px: no page errors`, p.errors.join('; '));
      });
    }
  } catch (e) {
    failures++; console.error(e);
  } finally {
    await H.closeBrowser();
  }
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nPASS no hidden Tab stops browser proof');
})();
