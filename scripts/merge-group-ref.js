#!/usr/bin/env node
'use strict';
/* Identify the one pull request a GitHub merge-queue group was built for.
 *
 * Under a `merge_group` event there is no pull_request payload. GitHub names
 * each group's temporary branch
 *   refs/heads/gh-readonly-queue/<base>/pr-<number>-<pr head sha>
 * The PR-context gates (merge card, primary-risk label) read that number and
 * head from the ref, then re-check the LIVE pull request against them, so the
 * queue run re-evaluates the same card and labels the PR-level run judged.
 *
 * Only base `main` is accepted. Anything that does not parse is refused, and
 * every caller fails closed on a refusal: an unreadable group is never green.
 *
 *   node scripts/merge-group-ref.js <head_ref> <base_ref>
 *     prints "<number> <head sha>" and exits 0, or prints a reason and exits 1.
 */

const REF = /^refs\/heads\/gh-readonly-queue\/main\/pr-([1-9][0-9]{0,8})-([0-9a-f]{40})$/;

function parseMergeGroupRef(headRef, baseRef) {
  if (String(baseRef || '') !== 'refs/heads/main') {
    return { ok: false, reason: 'merge group base is not refs/heads/main' };
  }
  const match = REF.exec(String(headRef || ''));
  if (!match) {
    return { ok: false, reason: 'merge group head ref does not name exactly one pull request and head SHA' };
  }
  return { ok: true, number: Number(match[1]), headSha: match[2] };
}

module.exports = { parseMergeGroupRef };

if (require.main === module) {
  const parsed = parseMergeGroupRef(process.argv[2], process.argv[3]);
  if (!parsed.ok) {
    console.log(parsed.reason);
    process.exit(1);
  }
  console.log(`${parsed.number} ${parsed.headSha}`);
}
