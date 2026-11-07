'use strict';
/* Focused proof for the fail-closed PRESENTATION of Forecast.planStatus /
 * Forecast.mission verdicts in `public/plan.js`. `node test/test-plan-status-unquantified.js`
 *
 * The bug (originally on main a439a20; this branch is rebased onto main
 * 4583691, after #554): when Forecast publishes planStatus 'infeasible'
 * with a null shortfall, the status band and the mission clause format the
 * null through money2 (public/app.js) and print "fails on October 8 by
 * $0.00" — an invented figure attached to a real verdict.
 *
 * The related withheld-cash-walk path is NOT covered here: since #554,
 * Forecast.planStatus / mission / nextMove return their 'unavailable'
 * shape (with Forecast's reason) for a withheld walk instead of a
 * belowBuffer verdict, so the page prints that neutral unavailable output.
 * That guard lives in Forecast and is proved by
 * test-sim-unavailable-guard.js; the earlier below-buffer presentation
 * fallback in this PR was redundant with it and was dropped in the rebase.
 *
 * This suite hands the page's own wording maps SYNTHETIC verdict objects —
 * null / undefined / nonfinite / zero / invalid-date inputs — lifted from the
 * production sources, never copied. It proves:
 *   1. unknown or nonfinite amounts stay explicitly unquantified (never
 *      $0.00, never $NaN), while the verdict and its label/reason survive;
 *   2. dates are validated before formatting (never "Invalid Date", never
 *      an invented day), while valid dates print unchanged;
 *   3. a real numeric zero is a valid amount and still prints $0.00;
 *   4. valid inputs render byte-for-byte the wording they rendered before.
 *
 * Nothing here touches Forecast: verdict selection and every figure remain
 * the engine's. This is a rendering proof only.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const read = p => sourceText(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const grab = (src, re, what) => {
  const m = re.exec(src);
  ok(!!m, `${what} is readable from its source`);
  return m ? m[0] : '';
};
const flat = s => String(s).replace(/\s+/g, ' ').trim();

const planSrc = read('public/plan.js');
const appSrc = read('public/app.js');
const FORMATTERS = [
  grab(appSrc, /^const money = .*$/m, 'money()'),
  grab(appSrc, /^const money2 = .*$/m, 'money2()'),
  grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate()'),
  grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong()'),
  grab(planSrc, /^const fmtMonth = .*$/m, 'fmtMonth()'),
].join('\n');
const BAND_SRC = grab(planSrc, /^const STATUS_BAND = \{[\s\S]*?^\};$/m, 'the band wording map');
const MAP_SRC = grab(planSrc, /^const MISSION_PART = \{[\s\S]*?^\};$/m, 'the mission wording map');
const CAP_SRC = grab(planSrc, /^function weeklyCapView\([\s\S]*?\n\}$/m, 'weeklyCapView');
const [STATUS_BAND, MISSION_PART, weeklyCapView] = vm.runInNewContext(
  `${FORMATTERS}\n${BAND_SRC}\n${MAP_SRC}\n${CAP_SRC}\n[STATUS_BAND, MISSION_PART, weeklyCapView];`,
  { Forecast: {}, escapeHtml: require('./app-escape-html') });

const BAD_AMOUNTS = [null, undefined, NaN, Infinity, -Infinity];
const BAD_DATES = [null, undefined, '', 'not-a-date', '2026-13-40', '2026-02-30'];
const noInventedFigure = html => !/\$0\.00|\$NaN|NaN|Invalid Date/.test(html);

console.log('=== 1. status band: infeasible with an unquantified shortfall ===');
for (const bad of BAD_AMOUNTS) {
  const html = flat(STATUS_BAND.infeasible.text(
    { label: 'Christmas 2026', date: '2026-10-08', shortfall: bad, buffer: 500 }));
  ok(html.includes('INFEASIBLE') && html.includes('Christmas 2026')
    && html.includes('fails on October 8') && html.includes('by an unquantified amount')
    && html.includes('$500 model buffer') && noInventedFigure(html),
  `shortfall ${String(bad)} stays unquantified; verdict, label, date and buffer survive`, html);
}
{
  const zero = flat(STATUS_BAND.infeasible.text(
    { label: 'Christmas 2026', date: '2026-10-08', shortfall: 0, buffer: 500 }));
  ok(zero.includes('by $0.00') && !zero.includes('unquantified'),
    'a real numeric zero shortfall still prints $0.00', zero);
  const valid = flat(STATUS_BAND.infeasible.text(
    { label: 'Christmas 2026', date: '2026-10-08', shortfall: 1200, buffer: 500 }));
  ok(valid === '<b>INFEASIBLE — the protected plan cannot work.</b> Christmas 2026 fails on October 8 by $1,200.00 at the $500 model buffer. A weekly spending figure does not fix this.',
    'valid inputs render the band exactly as before', valid);
  const noBuffer = flat(STATUS_BAND.infeasible.text(
    { label: 'Christmas 2026', date: '2026-10-08', shortfall: 1200, buffer: undefined }));
  ok(noBuffer.includes('by $1,200.00') && !noBuffer.includes('model buffer') && noInventedFigure(noBuffer),
    'a missing buffer prints no buffer clause and no invented figure', noBuffer);
}
for (const bad of BAD_DATES) {
  const html = flat(STATUS_BAND.infeasible.text(
    { label: 'Christmas 2026', date: bad, shortfall: 1200, buffer: 500 }));
  ok(!html.includes('Invalid Date') && !/fails on /.test(html) && html.includes('by $1,200.00'),
    `band date ${JSON.stringify(bad)} prints no date clause and keeps the amount`, html);
}

console.log('\n=== 2. mission: infeasible with an unquantified shortfall ===');
for (const bad of BAD_AMOUNTS) {
  const clause = flat(MISSION_PART.infeasible(
    { label: 'Christmas 2026', date: '2026-10-08', shortfall: bad }));
  ok(clause.includes('the protected plan cannot work') && clause.includes('Christmas 2026')
    && clause.includes('fails on October 8') && clause.includes('by an unquantified amount')
    && noInventedFigure(clause),
  `mission shortfall ${String(bad)} stays unquantified; verdict and label survive`, clause);
}
{
  const zero = flat(MISSION_PART.infeasible({ label: 'Christmas 2026', date: '2026-10-08', shortfall: 0 }));
  ok(zero.includes('by $0.00') && !zero.includes('unquantified'),
    'mission: a real numeric zero still prints $0.00', zero);
  const valid = flat(MISSION_PART.infeasible({ label: 'Christmas 2026', date: '2026-10-08', shortfall: 1200 }));
  ok(valid === 'the protected plan cannot work — Christmas 2026 fails on October 8 by $1,200.00; a weekly spending figure does not fix this',
    'mission: valid inputs render the clause exactly as before', valid);
}
for (const bad of BAD_DATES) {
  const clause = flat(MISSION_PART.infeasible({ label: 'Christmas 2026', date: bad, shortfall: 1200 }));
  ok(!clause.includes('Invalid Date') && !/fails on /.test(clause) && clause.includes('by $1,200.00'),
    `mission date ${JSON.stringify(bad)} prints no date clause and keeps the amount`, clause);
}

console.log('\n=== 3. weekly-cap reason: the same infeasible presentation ===');
for (const bad of BAD_AMOUNTS) {
  const view = weeklyCapView(
    { mode: 'infeasible', infeasible: { label: 'Christmas 2026', date: '2026-10-08', shortfall: bad } }, null);
  ok(view.reason.includes('by an unquantified amount') && noInventedFigure(view.reason),
    `weekly-cap shortfall ${String(bad)} stays unquantified`, flat(view.reason));
}
{
  const zero = weeklyCapView(
    { mode: 'infeasible', infeasible: { label: 'Christmas 2026', date: '2026-10-08', shortfall: 0 } }, null);
  ok(zero.reason.includes('by $0.00'), 'weekly-cap: a real numeric zero still prints $0.00', flat(zero.reason));
  const badDate = weeklyCapView(
    { mode: 'infeasible', infeasible: { label: 'Christmas 2026', date: 'not-a-date', shortfall: 1200 } }, null);
  ok(!badDate.reason.includes('Invalid Date') && badDate.reason.includes('by $1,200.00'),
    'weekly-cap: an invalid date prints no date clause', flat(badDate.reason));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
