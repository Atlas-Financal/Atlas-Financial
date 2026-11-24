'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { CASE_NAMES, runCase } = require('../scripts/live-refresh-benchmark');

// SHA-256 of each entire JSON document produced by the offline provider run
// on 619ddcf84c710729916d1d92b3db549b61c7fff8, including field order.
// Keeping only digests here avoids checking in megabytes of generated output.
// Re-pinned for #1624: the recommendation options echo extraFacilities instead of revolvingExtra (both empty here).
// Renaming that key back in simOptions and planOptions reproduces all three previous digests exactly; no figure moved.
const snapshots = {
  budget: {
    data: '05b6f393c7b83e81d8bba130f9d6d7834b7c850e9b0dc942093834e60a8cf8bd',
    // Re-pinned for desk ruling (E) (#1573): each view adds stackSummary.credit / creditBreakdown and the options carry the
    // card publication's evidence; a whole-document diff against main shows only those additions (no figure moved).
    // Re-pinned again for review 7106640633 (option (c)): a whole-document diff against 4bbaf67e shows only three periods'
    // balanceAfterDeductionsTrust null -> estimated and stackSummary.surplus.trust calculated -> estimated (toward caution).
    // Re-pinned for the desk's over-limit ruling (Neon 7113251603 item 2): a whole-document diff against b68bd89e shows only
    // one card target's reasons gaining over-limit-payments-unproven in two views; no figure or trust word moved.
    // Re-pinned for OD-033 (the Credit rows): a whole-document diff against e4c7b1a3 shows each Credit line gaining
    // stillToPayBack, targetCovered and its deduction's countedOffset / beyondNetted, and the dropdown's card rows reading
    // Still to pay back (display only); the data publication, Credit, Balance After Deductions and Surplus are unchanged.
    // Re-pinned for ChatGPT's #1617 blocker (7120269248): each Credit line adds paidBack (paidToward qualified for display);
    // removing paidBack from the output reproduces the previous digest exactly, so nothing else moved.
    // Re-pinned for Dale's removal of the "Already counted above" row (#1617 7121410691): main b2a821eb's output with only
    // each view's creditBreakdown.alreadyCounted removed reproduces this digest exactly; the data publication is unchanged.
    // Re-pinned for the Bills account stack card (lead dispatch 2026-11-24): the active view adds stackSummary.billsAccount
    // (display only); removing it reproduces the previous digest exactly.
    forecast: '53a5553c3fbf152c671bd57a6ec48542a9928d9b19692c738044202578ffc3f3',
  },
  cards: {
    data: 'a94fdc3c78fb627a805f6dd90c23cbb578d5dddc26d0badc09057ec449185e4a',
    // Re-pinned for desk ruling (E) (#1573): each view adds stackSummary.credit / creditBreakdown and the options carry the
    // card publication's evidence; a whole-document diff against main shows only those additions (no figure moved).
    // Re-pinned for OD-033 (the Credit rows): a whole-document diff against e4c7b1a3 shows each Credit line gaining
    // stillToPayBack, targetCovered and its deduction's countedOffset / beyondNetted, and the dropdown's card rows reading
    // Still to pay back (display only); the data publication, Credit, Balance After Deductions and Surplus are unchanged.
    // Re-pinned for ChatGPT's #1617 blocker (7120269248): each Credit line adds paidBack (paidToward qualified for display);
    // removing paidBack from the output reproduces the previous digest exactly, so nothing else moved.
    // Re-pinned for Dale's removal of the "Already counted above" row (#1617 7121410691): main b2a821eb's output with only
    // each view's creditBreakdown.alreadyCounted removed reproduces this digest exactly; the data publication is unchanged.
    // Re-pinned for the Bills account stack card (lead dispatch 2026-11-24): the active view adds stackSummary.billsAccount
    // (display only); removing it reproduces the previous digest exactly.
    forecast: 'f6b6bd4a362d45dd216feeeaa43f4af4cfbcbeb92d93a21a29687932ca760f65',
  },
  history: {
    data: 'c04e408eb8bcd7566e10fc0dbe71f3f09330a7d587070cd008a9829db93b3ba7',
    // Re-pinned for desk ruling (E) (#1573): each view adds stackSummary.credit / creditBreakdown and the options carry the
    // card publication's evidence; a whole-document diff against main shows only those additions (no figure moved).
    // Re-pinned for OD-033 (the Credit rows): a whole-document diff against e4c7b1a3 shows each Credit line gaining
    // stillToPayBack, targetCovered and its deduction's countedOffset / beyondNetted, and the dropdown's card rows reading
    // Still to pay back (display only); the data publication, Credit, Balance After Deductions and Surplus are unchanged.
    // Re-pinned for ChatGPT's #1617 blocker (7120269248): each Credit line adds paidBack (paidToward qualified for display);
    // removing paidBack from the output reproduces the previous digest exactly, so nothing else moved.
    // Re-pinned for Dale's removal of the "Already counted above" row (#1617 7121410691): main b2a821eb's output with only
    // each view's creditBreakdown.alreadyCounted removed reproduces this digest exactly; the data publication is unchanged.
    // Re-pinned for the Bills account stack card (lead dispatch 2026-11-24): the active view adds stackSummary.billsAccount
    // (display only); removing it reproduces the previous digest exactly.
    forecast: 'fffaf220eb748ffc326c45725930fdc3d0cbabf7b072a2ed2e0fd97470c715ba',
  },
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function main() {
  assert.deepStrictEqual(CASE_NAMES.slice().sort(), Object.keys(snapshots).sort());
  for (const name of CASE_NAMES) {
    const { data, forecast } = await runCase(name);
    assert.equal(digest(data), snapshots[name].data, name + ' full refresh publication changed');
    assert.equal(digest(forecast), snapshots[name].forecast, name + ' full Forecast recommendation changed');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
