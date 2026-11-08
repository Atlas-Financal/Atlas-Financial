'use strict';
/* AMANDA SLICE 7 — MONTHLY FUNDING LADDER.
 *
 * The Budget Month lens shows a three-step Forecast-owned funding ladder:
 *   1. Normal life            -> month.stage1.result
 *   2. After planned spending -> month.stage2.dateOrderResult
 *   3. After debt strategy    -> month.stage3.dateOrderResult
 *
 * Each rung reprints one Forecast-published result verbatim. The page maps
 * the sign to a household word (surplus / deficit / break-even) and keeps
 * the published trust tag. It never computes a transition between rungs,
 * never blames a stage, and never recommends a remedy. Stage 2 / Stage 3
 * read the incumbent date-order decision result (the same semantics the
 * Road Ahead consumer and the Month verdict use) — never the standalone
 * arithmetic identity. Missing results fail closed; unavailable is never
 * $0.
 *
 * Proof map (owner brief section 5):
 *   L1  healthy through all stages
 *   L2  planned spending crosses the line
 *   L3  debt strategy crosses the line
 *   L4  already short before planned spending
 *   L5  zero / break-even
 *   L6a unit date-order truth (stage2/stage3)
 *   L6b end-to-end date-order truth on the real Forecast walk
 *   L7  estimated trust
 *   L8  unavailable fails closed
 *   L9  no page arithmetic (source guard)
 *   L10 no recommendation engine
 *   L11 regression (verdict reconciled, rows/toggle intact)
 *
 * `node test/test-budget-month-ladder.js`
 */
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let checks = 0;
function check(label, run) { run(); checks++; console.log('  PASS  ' + label); }

const planSource = sourceText(fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8'));
const context = vm.createContext({
  escapeHtml: require('./app-escape-html'),
  Forecast: F,
  money2: n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
});
vm.runInContext(planSource, context);
const P = context;

function evalInPage(js) { return vm.runInContext(js, context); }
function setGranularity(g) { evalInPage(`budgetGranularity = ${JSON.stringify(g)};`); }
function setSelectedMonth(m) { evalInPage(`budgetSelectedMonth = ${JSON.stringify(m)};`); }
function setKnobs(knobs) {
  evalInPage(Object.entries(knobs)
    .map(([k, v]) => `state[${JSON.stringify(k)}] = ${JSON.stringify(v)};`)
    .join('\n'));
}
function resetKnobs() {
  setKnobs({
    scenario: null, targetBuffer: null, extraDebtMonthly: null,
    weeklyVariable: null, incomeOverrides: {}, disabled: [],
    extraDebtTarget: null,
  });
}
function resetState() {
  setGranularity('pay-period');
  setSelectedMonth(null);
  evalInPage('budgetTrajectoryCache = null; budgetTrajectoryCacheKey = null;');
  resetKnobs();
}

// A deterministic Forecast-shaped month. s2order/s3order are the published
// date-order decision results; s2arith/s3arith are the standalone arithmetic
// identities Forecast also publishes (and the page must never show as rungs).
function monthFixture(s1, s2order, s3order, opts) {
  opts = opts || {};
  const res = (amount, status) => ({ amount, status: status || 'calculated' });
  const dateOrder = (amount, status) => amount == null ? undefined
    : Object.assign(res(amount, status), { identity: 'date-order-month-funding' });
  return {
    month: '2026-10',
    stage1: {
      id: 'normal-life', label: 'Normal life', status: opts.s1status || 'calculated',
      result: res(s1, opts.s1status),
    },
    stage2: {
      id: 'after-planned-spending', label: 'After planned spending',
      status: opts.s2status || 'calculated',
      result: res(opts.s2arith != null ? opts.s2arith : s2order, opts.s2status),
      dateOrderResult: dateOrder(s2order, opts.s2status),
    },
    stage3: {
      id: 'after-debt-strategy', label: 'After debt strategy',
      status: opts.s3status || 'calculated',
      result: res(opts.s3arith != null ? opts.s3arith : s3order, opts.s3status),
      dateOrderResult: dateOrder(s3order, opts.s3status),
    },
  };
}

check('L1: healthy through all stages — exact Forecast figures reprinted', () => {
  const html = P.budgetMonthLadderHtml(monthFixture(1200, 300, 50, { s2status: 'estimated' }));
  assert.ok(html.includes('How October 2026 holds together'), 'ladder title names the month');
  assert.ok(html.includes('Normal life'), 'rung 1 label');
  assert.ok(html.includes('After planned spending'), 'rung 2 label');
  assert.ok(html.includes('After debt strategy'), 'rung 3 label');
  assert.ok(html.includes('+$1,200.00'), 'stage1 figure reprinted exactly');
  assert.ok(html.includes('+$300.00'), 'stage2 figure reprinted exactly');
  assert.ok(html.includes('+$50.00'), 'stage3 figure reprinted exactly');
  assert.equal(html.split('projected surplus').length - 1, 3, 'all three rungs read surplus');
  assert.equal(html.split('data-budget-month-ladder="surplus"').length - 1, 3, 'all three rungs marked surplus');
  assert.ok(html.includes('trust-estimated'), 'estimated stage keeps its estimate tag');
});

check('L2: planned spending crosses the line — surplus visibly becomes deficit', () => {
  // Arithmetic identity (+300) diverges from the date-order decision (-400).
  const html = P.budgetMonthLadderHtml(monthFixture(1200, -400, -400, { s2arith: 300, s3arith: 250 }));
  assert.ok(html.includes('data-budget-month-ladder="surplus"'), 'rung 1 is surplus');
  assert.ok(html.includes('+$1,200.00'), 'rung 1 figure');
  const deficits = html.split('data-budget-month-ladder="deficit"').length - 1;
  assert.equal(deficits, 2, 'rungs 2 and 3 read deficit');
  assert.ok(html.includes('−$400.00'), 'rung 2 shows the date-order deficit amount');
  assert.ok(html.includes('projected deficit'), 'deficit word present');
  assert.ok(!html.includes('+$300.00'), 'the arithmetic identity is never shown as a rung');
  assert.ok(!html.includes('+$250.00'), 'the stage3 arithmetic identity is never shown as a rung');
});

check('L3: debt strategy crosses the line — extra-debt stage shows the published result', () => {
  const html = P.budgetMonthLadderHtml(monthFixture(1200, 100, -150, { s2arith: 400, s3arith: 50 }));
  assert.ok(html.includes('+$100.00'), 'rung 2 non-negative date-order result');
  assert.ok(html.includes('−$150.00'), 'rung 3 shows the Forecast-published debt-strategy deficit');
  assert.ok(html.includes('projected deficit'), 'rung 3 word is deficit');
  assert.ok(!html.includes('+$50.00'), 'stage3 arithmetic identity not substituted');
});

check('L4: already short before planned spending — no blame assigned', () => {
  const html = P.budgetMonthLadderHtml(monthFixture(-200, -600, -650));
  assert.ok(html.includes('−$200.00'), 'rung 1 deficit shown');
  assert.ok(html.includes('−$600.00'), 'rung 2 deficit shown');
  assert.ok(!/caus|blame|because|due to|led to/i.test(html),
    'the page never blames planned spending for a shortfall that already existed');
});

check('L5: published zero renders as genuine break-even, not unavailable', () => {
  const html = P.budgetMonthLadderHtml(monthFixture(0, 0, 0));
  assert.ok(html.includes('$0.00'), 'the published zero is shown');
  assert.ok(html.includes('break-even'), 'zero reads as break-even');
  assert.equal(html.split('data-budget-month-ladder="neutral"').length - 1, 3, 'all rungs neutral');
  assert.ok(!html.includes('unavailable'), 'zero is not failed closed');
});

check('L6a: date-order truth — arithmetic identities never stand in for decision results', () => {
  const html = P.budgetMonthLadderHtml(monthFixture(1200, -400, -450, { s2arith: 800, s3arith: 750 }));
  assert.ok(html.includes('−$400.00'), 'rung 2 is the date-order result');
  assert.ok(html.includes('−$450.00'), 'rung 3 is the date-order result');
  assert.ok(!html.includes('+$800.00'), 'stage2 arithmetic surplus not shown');
  assert.ok(!html.includes('+$750.00'), 'stage3 arithmetic surplus not shown');
});

check('L6b: end-to-end — ladder reprints the real Forecast date-order result', () => {
  // The incumbent divergence fixture: a $2,000 commitment due 2026-10-05
  // cannot use the 10-08 / 10-22 pay-period closes, so the date-order
  // result is a deficit while the arithmetic identity is a surplus.
  resetState();
  setGranularity('month');
  const plan = {
    windowDays: 91,
    defaults: { targetBuffer: 0, extraDebtMonthly: 50, scenario: 'expected' },
    opening: { asOf: '2026-09-25' },
    startingCash: { amount: 10000 },
    income: [
      { id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
        anchor: '2026-09-11', amount: 2500, confidence: 'confirmed' },
    ],
    obligations: [],
    bills: [
      { id: 'rent', label: 'Rent', frequency: 'monthly', day: 1,
        amount: 1200, confidence: 'confirmed' },
    ],
    budget: {
      basis: 'ytd',
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedWeekly: 140 },
      ],
    },
    commitments: [
      { id: 'roof', label: 'Roof repair', date: '2026-10-05', amount: 2000, confidence: 'confirmed' },
    ],
  };
  const src = {
    plan, debts: [], asOf: '2026-09-25', meta: { asOf: '2026-09-25' },
    liveOverlay: null, revolvingExtra: null,
    periods: { periods: { ytd: { label: 'YTD fixture', months: 1, spending: [{ label: 'Groceries', total: 50000 }] } } },
  };
  setSelectedMonth('2026-10');
  const month = P.budgetTrajectoryFor(src).months.find(m => m.month === '2026-10');
  assert.ok(month && month.stage2.dateOrderResult, 'real month publishes a stage2 date-order result');
  assert.ok(Number(month.stage2.result.amount) > 0, 'fixture: stage2 arithmetic identity is a surplus');
  assert.ok(Number(month.stage2.dateOrderResult.amount) < 0, 'fixture: stage2 date-order result is a deficit');
  const html = P.budgetMonthLadderHtml(month);
  assert.ok(html.includes(P.money2(Math.abs(Number(month.stage2.dateOrderResult.amount)))),
    'ladder rung 2 reprints the Forecast date-order amount');
  assert.ok(html.includes('data-budget-month-ladder="deficit"'), 'rung 2 reads deficit');
  assert.ok(!html.includes('+' + P.money2(Number(month.stage2.result.amount))),
    'the arithmetic surplus is not rendered as a rung');
});

check('L7: estimated trust is never promoted to calculated', () => {
  const html = P.budgetMonthLadderHtml(
    monthFixture(1200, 300, 50, { s1status: 'estimated', s2status: 'estimated', s3status: 'estimated' }));
  assert.equal(html.split('trust-estimated').length - 1, 3, 'all three rungs keep the estimate tag');
  assert.ok(!html.includes('>calculated</span>'), 'no rung is promoted to calculated');
});

check('L8: unavailable stage fails closed — unknown is never $0', () => {
  const html = P.budgetMonthLadderHtml({
    month: '2026-10',
    stage1: {
      id: 'normal-life', label: 'Normal life', status: 'calculated',
      result: { amount: 1200, status: 'calculated' },
    },
    stage2: {
      id: 'after-planned-spending', label: 'After planned spending',
      status: 'unavailable', reason: 'Forecast could not read month-end cash. Not $0.',
    },
    stage3: {
      id: 'after-debt-strategy', label: 'After debt strategy',
      status: 'unavailable', reason: 'No coupled debt walk was available for this month. Not $0.',
    },
  });
  assert.equal(html.split('data-budget-month-ladder="unavailable"').length - 1, 2, 'rungs 2 and 3 fail closed');
  assert.ok(html.includes('Not $0'), 'unavailable is never presented as $0');
  assert.ok(!/\$0\.00/.test(html), 'no invented zero figure');
  assert.ok(html.includes('Forecast could not read month-end cash'), 'published reason reprinted');
});

check('L8b: a present arithmetic identity never stands in for a missing date-order result', () => {
  const html = P.budgetMonthLadderHtml(monthFixture(1200, null, 50, { s2arith: 300 }));
  assert.ok(html.includes('data-budget-month-ladder="unavailable"'), 'rung 2 fails closed');
  assert.ok(!html.includes('+$300.00'), 'the arithmetic identity is not substituted');
});

check('L9: no page arithmetic in the ladder (source guard)', () => {
  // The ladder selects, formats, labels and arranges — it never combines
  // financial values. Single-operand formatting (money2, Number,
  // Math.abs) is presentation, not arithmetic.
  const slice7 = planSource.slice(
    planSource.indexOf('AMANDA SLICE 7'),
    planSource.indexOf('function paydayInstructionShellHtml')
  );
  assert.ok(slice7.includes('function budgetMonthLadderHtml'), 'ladder section located');
  const lines = slice7.split('\n');
  const bad = lines.filter(line => {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
    if (/\bamount\s*[-+*/]\s*[^=]/.test(t) && !/money2|Math\.abs|Number\(/.test(t)) return true;
    if (/\b(delta|variance|difference|reconcile|cumulative)\b/i.test(t)) return true;
    return false;
  });
  assert.deepEqual(bad, [], `no amount arithmetic in ladder, found: ${bad.join(' | ')}`);
});

check('L10: no recommendation engine — the ladder never prescribes', () => {
  const html = P.budgetMonthLadderHtml(monthFixture(1200, -400, -150, { s2arith: 300, s3arith: 250 }));
  const banned = [
    /you should/i, /\bcut\b/i, /\breduce\b/i, /\bskip\b/i, /\bafford\b/i,
    /\bsafel?y\b/i, /recommend/i, /\bscore\b/i, /\brating\b/i, /fix this/i,
    /caused/i, /\bblame\b/i, /because/i,
  ];
  for (const re of banned) {
    assert.ok(!re.test(html), `ladder contains no recommendation language (${re})`);
  }
  assert.ok(!/red|yellow|green/i.test(html), 'no red/yellow/green scoring');
});

check('L11: regression — ladder rung 3 reconciles to the existing Month verdict', () => {
  const month = monthFixture(1200, -400, -150, { s2arith: 300, s3arith: 250 });
  const ladderHtml = P.budgetMonthLadderHtml(month);
  const verdictHtml = P.budgetMonthVerdictHtml(month);
  assert.ok(ladderHtml.includes('−$150.00'), 'ladder rung 3 shows the date-order result');
  assert.ok(verdictHtml.includes('−$150.00'), 'verdict shows the same date-order result');
  assert.ok(verdictHtml.includes('Monthly deficit'), 'verdict label unchanged');
});

check('L11b: regression — month rows and granularity toggle intact', () => {
  resetState();
  setGranularity('month');
  const toggle = P.budgetGranularityToggleHtml();
  assert.ok(toggle.includes('Month') && toggle.includes('Pay Period'), 'Month <-> Pay Period toggle intact');
});

check('L12: P2 repair — phone widths stack the rung and free the amount to wrap', () => {
  // Systems Review BLOCKING on PR #445: the ladder amount was nowrap and
  // could overflow ~320px viewports. The existing phone-width media query
  // must stack the rung and no longer require the amount phrase to stay on
  // one line. Desktop treatment is unchanged.
  const css = fs.readFileSync(path.join(__dirname, '../public/budget-polish.css'), 'utf8');
  const mediaStart = css.indexOf('@media (max-width: 520px)');
  assert.ok(mediaStart !== -1, 'existing phone-width media query present');
  let depth = 0, end = -1;
  const openIdx = css.indexOf('{', mediaStart);
  for (let i = openIdx; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end !== -1, 'media query body extracted');
  const body = css.slice(openIdx, end + 1);
  const amountRule = body.match(/\.budget-month-ladder-amount\s*\{([^}]*)\}/);
  assert.ok(amountRule, 'media query styles the ladder amount');
  assert.ok(/white-space\s*:\s*normal/.test(amountRule[1]),
    'phone widths no longer force the amount phrase onto one line');
  assert.ok(/flex-basis\s*:\s*100%/.test(amountRule[1]),
    'amount takes its own row on phones');
  const rungRule = body.match(/\.budget-month-ladder-rung\s*\{([^}]*)\}/);
  assert.ok(rungRule && /flex-wrap\s*:\s*wrap/.test(rungRule[1]),
    'rung wraps on phones');
  // Desktop treatment is unchanged: strip the media block and confirm the
  // base rule still keeps the single-line amount outside phone widths.
  const desktop = css.slice(0, mediaStart) + css.slice(end + 1);
  const desktopAmount = desktop.match(/\.budget-month-ladder-amount\s*\{([^}]*)\}/);
  assert.ok(desktopAmount && /white-space\s*:\s*nowrap/.test(desktopAmount[1]),
    'desktop single-line treatment untouched');
});

console.log(`\nAll ${checks} ladder checks passed.`);
