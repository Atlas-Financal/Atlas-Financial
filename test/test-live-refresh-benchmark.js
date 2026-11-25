'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { CASE_NAMES, runCase } = require('../scripts/live-refresh-benchmark');

// SHA-256 of each entire JSON document produced by the offline provider run
// on 619ddcf84c710729916d1d92b3db549b61c7fff8, including field order.
// Keeping only digests here avoids checking in megabytes of generated output.
// Re-pinned for #1624: the recommendation options echo extraFacilities instead of revolvingExtra (both empty here).
// Renaming that key back in simOptions and planOptions reproduces all three previous digests exactly; no figure moved.
// These invented cases have no qualifying paying-side transfer. Removing the empty unconfirmedPayments list
// and restoring the prior reasons on paidToward, paidBack, stillToPayBack, targetCovered and minimumCovered
// reproduces the d70784b1 Forecast digests. The budget case also requires the previous totals.minimumsPaid.reasons
// and totals.minimumsCoveredTrust (now unavailable where payer evidence is missing). No amount or data digest changed.
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
    // Future covered counts use the due minimum's trust while payment coverage is unknown. Resetting only
    // totals.minimumsCoveredTrust on four future payPeriodViews to unavailable reproduces the d2d9e062 digest.
    // Re-pinned for the HELOC's paying-side Paid back (Dale, #821 7161929211): these invented cases have no HELOC account, so
    // only each HELOC line's minimumCovered.reasons change (from not-a-spend-card to its paid figure's reasons; the value stays
    // unknown). Restoring those reasons on every HELOC line reproduces the previous digest exactly; no amount or trust moved.
    forecast: '88ac55ceb27f000a6ed3582d42fba040c5ae8cf7ca77f8d964750838018c8704',
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
    // Re-pinned for the HELOC's paying-side Paid back (Dale, #821 7161929211): these invented cases have no HELOC account, so
    // only each HELOC line's minimumCovered.reasons change (from not-a-spend-card to its paid figure's reasons; the value stays
    // unknown). Restoring those reasons on every HELOC line reproduces the previous digest exactly; no amount or trust moved.
    forecast: '91f87064464d2a77111e9a8c49088ec0ef8de2b62ce7659d06d187b8256d1083',
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
    // Re-pinned for the HELOC's paying-side Paid back (Dale, #821 7161929211): these invented cases have no HELOC account, so
    // only each HELOC line's minimumCovered.reasons change (from not-a-spend-card to its paid figure's reasons; the value stays
    // unknown). Restoring those reasons on every HELOC line reproduces the previous digest exactly; no amount or trust moved.
    forecast: 'dc8b1bbcb79024063775d5e0a70ea7a23293060a387e9b3b3af0deb6ca7eaed7',
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
