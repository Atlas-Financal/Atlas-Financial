'use strict';
/* The Stack page honours Forecast's savedHistoryUnavailable marker (C1, DISPLAY handover, Plan #6 thread 2026-11-21).
 *
 * After a server restart the first page is served with periodHistoryStatus unavailable (history not yet loaded). Forecast
 * then marks every completed period savedHistoryUnavailable but keeps today's rebuild figures on it. The classic page
 * withholds on that marker; the Stack page used to print the rebuild as if it were the period, and after the reload the
 * saved close instead (different figures for the same period). Now a marked period prints no figure: a dash on its chip,
 * nothing in the waterfall, cards or credit block (F8: unpublished prints nothing, never $0). No explanatory text (owner).
 *
 * Runs the real shell and blocks in the vm harness (no browser) on an invented document:
 *   1. with the status unavailable, every completed period carries the marker, and each prints no amount anywhere;
 *   2. the current and future periods are unaffected: they print their published figures;
 *   3. control: without the status the same completed periods print their figures (so the dashes are the marker's doing);
 *   4. the shell does no arithmetic on the withheld period (it keeps identity keys only);
 *   5. mutants of public/stack-shell.js (the withholding not applied; a figure key kept on the withheld period) each fail a
 *      scenario. A completed period that carries a saved close is never marked by Forecast (applyCapturedPeriodHistory), and
 *      the shell's guard on capturedClose is defence in depth, not separately tested here.
 *
 * `node test/test-stack-saved-history.js` */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = require('./fixtures/savings-daily-consumer-data');
const { loadStackPage } = require('./lib/budget-page-harness');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const MONEY = /[−+-]?\$[\d,]+(?:\.\d+)?/;
const UNAVAILABLE = { status: 'unavailable', reason: 'history-not-loaded' };

async function scenario(lib, { status } = {}) {
  const data = fixture();
  if (status) data.periodHistoryStatus = status;
  const page = await lib.loadStackPage({ data });
  if (page.status() !== 'rendered') throw new Error('the Stack page did not render: ' + page.status());
  const views = page.context().recommendation.payPeriodViews;
  const out = { views, periods: {} };
  const chips = page.blockHtml('timeline');
  for (const view of views) {
    const key = view.start;
    page.selectPeriod(key);
    const chip = new RegExp('<button[^>]*data-stack-period="' + key + '"[^>]*>([\\s\\S]*?)</button>').exec(chips);
    out.periods[key] = {
      role: view.role, timelineRole: view.timelineRole,
      marked: !!(view.savedHistoryUnavailable && view.savedHistoryUnavailable.status === 'unavailable'),
      chip: chip ? chip[1] : null,
      printed: ['waterfall', 'cards', 'credit'].map(b => page.blockHtml(b)).join('\n'),
    };
  }
  return out;
}
const completed = s => Object.entries(s.periods).filter(([, p]) => p.timelineRole === 'past' || p.role === 'lookback');
const others = s => Object.entries(s.periods).filter(([, p]) => !(p.timelineRole === 'past' || p.role === 'lookback'));
const holds = s => completed(s).length >= 3
  && completed(s).every(([, p]) => p.marked && !MONEY.test(p.printed) && /not available/.test(p.chip || '') && !MONEY.test((p.chip || '').replace(/<[^>]+>/g, '')))
  && others(s).some(([, p]) => MONEY.test(p.printed));

(async () => {
  const lib = { loadStackPage };
  console.log('1-2. status unavailable');
  const withheld = await scenario(lib, { status: UNAVAILABLE });
  const done = completed(withheld);
  ok(done.length >= 3 && done.every(([, p]) => p.marked), 'Forecast marks every completed period savedHistoryUnavailable (' + done.length + ' periods)');
  ok(done.every(([k, p]) => !MONEY.test(p.printed)), 'a marked period prints no amount in the waterfall, cards or credit block', done.filter(([, p]) => MONEY.test(p.printed)).map(([k]) => k).join());
  ok(done.every(([, p]) => /not available/.test(p.chip || '') && !MONEY.test((p.chip || '').replace(/<[^>]+>/g, ''))),
    'a marked period\'s chip shows a dash, never an amount');
  ok(done.every(([, p]) => !/\$0(?![\d.,])/.test(p.printed + (p.chip || ''))), 'and nothing reads $0');
  const live = others(withheld);
  ok(live.some(([, p]) => p.role === 'active') && live.some(([, p]) => MONEY.test(p.printed)),
    'the current and future periods are unaffected: they print their published figures');
  ok(live.every(([, p]) => !p.marked), 'the marker is not on a current or future period');

  console.log('3. control: no status');
  const control = await scenario(lib, {});
  ok(completed(control).length === done.length && completed(control).every(([, p]) => !p.marked), 'without the status no completed period is marked');
  ok(completed(control).some(([, p]) => MONEY.test(p.printed)), 'and the same completed periods print their figures, so the dashes above are the marker\'s doing');
  ok(holds(withheld) && !holds(control), 'the withholding holds with the status and not without it');

  console.log('4. no arithmetic; identity only');
  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-shell.js'), 'utf8');
  const keys = /HISTORY_IDENTITY_KEYS = \[([^\]]*)\]/.exec(shell);
  const kept = keys ? keys[1].split(',').map(k => k.replace(/['\s]/g, '')).filter(Boolean) : [];
  const IDENTITY = ['id', 'label', 'rangeLabel', 'start', 'end', 'role', 'timelineRole', 'lookback', 'evidenceState', 'savedHistoryUnavailable'];
  ok(kept.length === IDENTITY.length && kept.every((k, i) => k === IDENTITY[i]), 'the keys kept on a withheld period are exactly the identity keys', kept.join());

  console.log('5. mutants of the shell');
  const mutants = [
    ['the withholding is not applied', '    state.recommendation = withholdUnavailableHistory(state.recommendation);\n', ''],
    ['a figure key (stackSummary) is kept on the withheld period', "'evidenceState',\n    'savedHistoryUnavailable']", "'evidenceState',\n    'savedHistoryUnavailable', 'stackSummary']"],
  ];
  const harnessSource = fs.readFileSync(path.join(__dirname, 'lib', 'budget-page-harness.js'), 'utf8');
  for (const [what, from, to] of mutants) {
    assert.ok(shell.split(from).length === 2, 'the mutation target appears once: ' + what);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-history-'));
    try {
      fs.mkdirSync(path.join(tmp, 'test', 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'public'));
      for (const f of fs.readdirSync(path.join(__dirname, '..', 'public'))) {
        const src = path.join(__dirname, '..', 'public', f);
        if (fs.statSync(src).isFile() && f !== 'stack-shell.js') fs.symlinkSync(src, path.join(tmp, 'public', f));
      }
      fs.writeFileSync(path.join(tmp, 'public', 'stack-shell.js'), shell.replace(from, to));
      fs.writeFileSync(path.join(tmp, 'test', 'lib', 'budget-page-harness.js'), harnessSource);
      const mutated = require(path.join(tmp, 'test', 'lib', 'budget-page-harness.js'));
      // The mutated page must RENDER (scenario throws otherwise, which fails this test loudly: a broken harness is not a
      // catch), and then the withholding checks must fail on what it printed.
      const printed = await scenario(mutated, { status: UNAVAILABLE });
      ok(completed(printed).length >= 3 && others(printed).some(([, p]) => MONEY.test(p.printed)), 'mutant: ' + what + ' still renders the page (so a catch below is the assertions, not a broken harness)');
      const caught = !holds(printed);
      ok(caught, 'mutant: ' + what + ' fails a scenario');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  console.log(`\ntest-stack-saved-history: ${checks} checks passed`);
})().catch(error => { console.error(error); process.exit(1); });
