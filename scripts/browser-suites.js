#!/usr/bin/env node
'use strict';
/* Advisory browser-suite runner.  `node scripts/browser-suites.js`
 *
 * The test/browser-*.js suites drive the real pages in headless Chromium with
 * invented data. None of them ran in any workflow, although node suites cite
 * several as end-to-end proof. This runs the ones that pass on main, serially,
 * in the advisory `browser suites` workflow. It is not a required check.
 *
 * Every browser-*.js file on disk is classified exactly once: in RUN (must
 * pass) or in NOT_RUN with a category. test/test-browser-suites.js enforces
 * that, so a new browser suite cannot be silently left out. A suite moves from
 * NOT_RUN to RUN in the PR that repairs it. NOT_RUN was measured on main by
 * running every suite, then re-running each failure alone (all reproduced).
 *
 * Each suite's stdout and stderr go to owner-only files in a private temporary
 * directory; only "<suite> pass|fail" lines and a summary are printed.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUN = Object.freeze([
  'browser-a9-expanded-panel-visibility.js',
  'browser-a9-future-period-retirement.js',
  'browser-a9-unknown-operation.js',
  'browser-absent-funding-sources-acceptance.js',
  'browser-bill-detail.js',
  'browser-bills-closing-period-identity.js',
  'browser-bills-opening-source-transition.js',
  'browser-bills-usability.js',
  'browser-budget-bad-red.js',
  'browser-budget-other-ring.js',
  'browser-budget-panel-repairs.js',
  'browser-budget-release-reopen.js',
  'browser-budget-river-port.js',
  'browser-card-panel-lead.js',
  'browser-card-payment-diagnostics.js',
  'browser-card-period-movements.js',
  'browser-household-panel-viewport.js',
  'browser-malformed-scheduled-amounts-acceptance.js',
  'browser-observation-memory.js',
  'browser-private-comparison-download.js',
  'browser-provider-v2-credit-date.js',
  'browser-refund-nets-category.js',
  'browser-river-geometry-proof.js',
  'browser-routes-render.js',
  'browser-savings-group-members.js',
  'browser-savings-link-foundation.js',
  'browser-savings-selected-roster.js',
  'browser-savings-source-qualification.js',
  'browser-settlement-save-view.js',
  'browser-source-check-status.js',
  'browser-startup-feedback.js',
  'browser-transaction-edit.js',
  'browser-travel-visa-annual-estimate.js',
  'browser-travel-visa-annual-fee.js',
]);

const NOT_RUN = Object.freeze({
  // needs-webkit: launches WebKit, which this job does not install
  'browser-app-release-resume.js': 'needs-webkit',
  'browser-transaction-review-rerender.js': 'needs-webkit',
  // needs-proof-setup: manual proof: needs an evidence directory, base checkout or DevTools endpoint this job does not provide
  'browser-budget-month-contrast.js': 'needs-proof-setup',
  'browser-budget-river-readability.js': 'needs-proof-setup',
  'browser-budget-signed-cents.js': 'needs-proof-setup',
  'browser-card-purchase-coverage.js': 'needs-proof-setup',
  'browser-payday-bank-eod-anchor.js': 'needs-proof-setup',
  'browser-payday-gap-cash-identity.js': 'needs-proof-setup',
  // timeout: times out on main waiting for a page element (selector likely out of date, or a real regression; reported to the lead)
  'browser-bills-header-payments.js': 'timeout',
  'browser-bills-period-end-balance.js': 'timeout',
  'browser-bills-recorded-payment.js': 'timeout',
  'browser-boot-treatment.js': 'timeout',
  'browser-budget-compact-details.js': 'timeout',
  'browser-budget-income-receipts.js': 'timeout',
  'browser-budget-routed-layout.js': 'timeout',
  'browser-budget-unknown-ring.js': 'timeout',
  'browser-budget-v3-funding-month.js': 'timeout',
  'browser-chronological-savings.js': 'timeout',
  'browser-other-period-target.js': 'timeout',
  'browser-paid-actual-display-trust.js': 'timeout',
  'browser-planned-savings-clarity.js': 'timeout',
  'browser-provider-v2-savings-stock.js': 'timeout',
  'browser-savings-daily-consumer.js': 'timeout',
  'browser-savings-earmarks.js': 'timeout',
  'browser-savings-evidence.js': 'timeout',
  'browser-savings-stock-pending.js': 'timeout',
  'browser-scheduled-fee-routing.js': 'timeout',
  // assertion-failure: an assertion fails on main (out-of-date expectation or a real regression; reported to the lead)
  'browser-bill-detail-budget.js': 'assertion-failure',
  'browser-budget-attention-order.js': 'assertion-failure',
  'browser-budget-bill-status.js': 'assertion-failure',
  'browser-budget-blend-proof.js': 'assertion-failure',
  'browser-budget-etransfers.js': 'assertion-failure',
  'browser-budget-household-total.js': 'assertion-failure',
  'browser-budget-stepped-layout.js': 'assertion-failure',
  'browser-budget-v3-period.js': 'assertion-failure',
  'browser-card-purchase-markers.js': 'assertion-failure',
  'browser-household-path.js': 'assertion-failure',
  'browser-household-total-delta.js': 'assertion-failure',
  'browser-savings-card-recipient.js': 'assertion-failure',
  'browser-savings-contribution-display.js': 'assertion-failure',
  'browser-savings-future-closing.js': 'assertion-failure',
  'browser-savings-goal-paid-progress.js': 'assertion-failure',
  'browser-savings-latest-known-allocation.js': 'assertion-failure',
  'browser-theme-control.js': 'assertion-failure',
  'browser-transaction-review.js': 'assertion-failure',
  // other-failure: exits non-zero on main without an assertion message (reported to the lead)
  'browser-chronological-savings-review-boundaries.js': 'other-failure',
  'browser-tile-separation.js': 'other-failure',
});

const CATEGORIES = Object.freeze(["needs-webkit", "needs-proof-setup", "timeout", "assertion-failure", "other-failure"]);
const TIMEOUT_MS = 420000;

function classify(diskFiles) {
  const browser = diskFiles.filter(f => /^browser-.*\.js$/.test(f));
  const run = new Set(RUN);
  return {
    unclassified: browser.filter(f => !run.has(f) && !Object.prototype.hasOwnProperty.call(NOT_RUN, f)).sort(),
    stale: [...RUN, ...Object.keys(NOT_RUN)].filter(f => !browser.includes(f)).sort(),
    both: RUN.filter(f => Object.prototype.hasOwnProperty.call(NOT_RUN, f)).sort(),
    badCategory: Object.entries(NOT_RUN).filter(([, c]) => !CATEGORIES.includes(c)).map(([f]) => f).sort(),
  };
}

function privateDir() {
  const root = process.env.RUNNER_TEMP || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(root, 'atlas-browser-suites-'));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// Runs the given suites one at a time and returns the failed names. `spawn`
// is injectable so the contract can be tested without a browser.
function runSuites(list, { root = path.join(__dirname, '..'), log = console.log, spawn = spawnSync,
  dir = privateDir() } = {}) {
  const failed = [];
  for (const file of list) {
    const out = path.join(dir, file + '.log');
    const fd = fs.openSync(out, 'w', 0o600);
    let status = 1;
    try {
      const r = spawn(process.execPath, [path.join(root, 'test', file)],
        { cwd: root, stdio: ['ignore', fd, fd], timeout: TIMEOUT_MS, env: process.env });
      status = r && r.status === 0 && !r.signal && !r.error ? 0 : 1;
    } catch { status = 1; } finally { fs.closeSync(fd); }
    log(`${file} ${status === 0 ? 'pass' : 'fail'}`);
    if (status !== 0) failed.push(file);
  }
  log(`browser suites: ${list.length - failed.length}/${list.length} passed; ${Object.keys(NOT_RUN).length} not run (see scripts/browser-suites.js)`);
  return failed;
}

module.exports = { RUN, NOT_RUN, CATEGORIES, classify, runSuites };

if (require.main === module) {
  const c = classify(fs.readdirSync(path.join(__dirname, '..', 'test')));
  if (Object.values(c).some(list => list.length)) {
    console.log('browser suite classification is out of date: ' + JSON.stringify(c));
    process.exitCode = 1;
  } else {
    process.exitCode = runSuites(RUN).length ? 1 : 0;
  }
}
