'use strict';
/* The Budget face split bar shows the extra deduction terms (#1323 card,
 * NEXT PR). When an extra term slot is on the face (To confirm, Savings
 * items), the bar gets one segment per term between household and Balance
 * After Deductions, read from that slot's printed figure. Each segment's
 * share is its printed term over the printed total. With no extra term the
 * bar is the three segments it always was.
 *
 * Invented world only (test/acceptance/harness.js): biweekly salary 1,400
 * received Oct 9, plan Groceries 300 + Eating out 100 (household hold 400),
 * no bills, as-of Oct 14. Hand arithmetic for the printed face:
 *   control:        bills 0, household 400, BAD 1,400 - 400 = 1,000
 *   400 mortgage:   To confirm 400, BAD 1,000 - 400 = 600
 *   + linked 200:   Savings items 200, BAD 600 - 200 = 400
 * The shares below are computed here from the printed text, not from the
 * page's own --w, and must agree to the hundredth of a percent.
 *
 * `node test/test-budget-split-extra-terms.js`
 */
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const MORTGAGE = 116;
function world({ held = false, item = false } = {}) {
  const w = H.baseWorld();
  w.categories.push({ id: MORTGAGE, name: 'Mortgage' });
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  if (held) w.transactions.push(H.lm({ date: '2026-10-12', amount: 400, category: MORTGAGE, account: 'chequing-a', payee: 'Invented lender' }));
  if (item) {
    w.commitments = [{ id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true }];
    w.savingsPool = { value: 1000 };
    w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20',
      effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
    w.transactions.push(H.lm({ date: '2026-10-12', amount: 200, category: 106, account: 'chequing-a', payee: 'Invented outfitter' }));
  }
  return w;
}

// The printed figure of each face term, and the bar's segments, as the page
// shows them. A printed figure is read as text; the share is computed here.
const readFace = () => {
  const money = sel => {
    const el = document.querySelector(sel);
    const m = el && el.textContent.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? Math.abs(Number(m[0])) : null;
  };
  const split = document.querySelector('.blend-split');
  return {
    printed: {
      's-bills': money('[data-operating-question="04"] .blend-term'),
      's-house': money('[data-operating-question="06"] .blend-term'),
      's-held': money('[data-blend-extra-term="heldOutflowSpending"] [data-blend-term="heldOutflowSpending"]'),
      's-item': money('[data-blend-extra-term="savingsItemSpending"] [data-blend-term="savingsItemSpending"]'),
      's-bad': money('[data-blend-term="balanceAfterDeductions"]'),
    },
    segments: split ? [...split.children].map(i => ({ cls: i.className, w: i.style.getPropertyValue('--w') })) : null,
  };
};

function shares(face, expectOrder) {
  const total = expectOrder.reduce((sum, k) => sum + (face.printed[k] > 0 ? face.printed[k] : 0), 0);
  return expectOrder.map(k => (face.printed[k] / total * 100).toFixed(2) + '%');
}

function hasBrowser() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}

(async () => {
  if (!hasBrowser() || process.env.ATLAS_SKIP_BROWSER === '1') {
    console.log('  SKIP  page cases: Playwright Chromium is not available here');
    process.exit(0);
  }
  const cases = [
    ['control: no extra term', world(), ['s-bills', 's-house', 's-bad'], { 's-bills': 0, 's-house': 400, 's-bad': 1000 }],
    ['To confirm on the face', world({ held: true }), ['s-bills', 's-house', 's-held', 's-bad'],
      { 's-bills': 0, 's-house': 400, 's-held': 400, 's-bad': 600 }],
    ['To confirm and Savings items on the face', world({ held: true, item: true }), ['s-bills', 's-house', 's-held', 's-item', 's-bad'],
      { 's-bills': 0, 's-house': 400, 's-held': 400, 's-item': 200, 's-bad': 400 }],
  ];
  for (const [label, w, order, hand] of cases) {
    console.log(`\n=== ${label} ===`);
    const face = await H.withBudget(w, async p => {
      const f = await p.page.evaluate(readFace);
      f.errors = p.errors.slice();
      return f;
    });
    ok(face.errors.length === 0, 'no page errors', face.errors.join('; '));
    for (const k of order) ok(face.printed[k] === hand[k], `printed ${k} is the hand figure ${hand[k]}`, String(face.printed[k]));
    ok(face.segments && face.segments.map(s => s.cls).join(' ') === order.join(' '),
      `the bar has one segment per face term, in order: ${order.join(', ')}`, JSON.stringify(face.segments && face.segments.map(s => s.cls)));
    const want = shares(face, order);
    ok(face.segments && face.segments.every((s, i) => s.w === want[i]),
      'each segment\'s share is its printed term over the printed total', JSON.stringify({ page: face.segments && face.segments.map(s => s.w), want }));
  }
  await H.closeBrowser();
  console.log(failures ? `\n${failures} FAILED` : '\nAll split-bar extra-term checks passed');
  process.exit(failures ? 1 : 0);
})();
