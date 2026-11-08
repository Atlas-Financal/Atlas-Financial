#!/usr/bin/env node
'use strict';
/* Identify the one pull request a GitHub merge-queue group was built for, and
 * that pull request's head, from the group itself.
 *
 * Under a `merge_group` event there is no pull_request payload. GitHub names
 * each group's temporary branch
 *   refs/heads/gh-readonly-queue/<base>/pr-<number>-<sha>
 * The <sha> in that name is NOT the pull request's head: on the first live
 * queue run (#977) it was the group's base (main's tip). So the ref supplies
 * only the PR number. The PR head comes from the group commit: a queue commit
 * for exactly one PR merged onto main has exactly two parents, the group's
 * base_sha first and the PR head second. The PR-context gates (merge card,
 * primary-risk label) then re-check the LIVE pull request against that head,
 * so the queue run re-evaluates the same card and labels the PR-level run
 * judged.
 *
 * Only base `main` is accepted. One PR per group: a group stacked on another
 * queued PR has a first parent that is not base_sha and is refused, as is a
 * squash or rebase group (one parent). Anything that does not parse is
 * refused, and every caller fails closed on a refusal: an unreadable group is
 * never green.
 *
 *   node scripts/merge-group-ref.js <head_ref> <base_ref> <group head sha> \
 *     <group base sha> "<parent sha> <parent sha>"
 *     prints "<number> <pr head sha>" and exits 0, or prints a reason and exits 1.
 */

const REF = /^refs\/heads\/gh-readonly-queue\/main\/pr-([1-9][0-9]{0,8})-([0-9a-f]{40})$/;
const SHA = /^[0-9a-f]{40}$/;

// The ref's trailing sha is returned as `refSha` and deliberately used for
// nothing: it is not the pull request head.
function parseMergeGroupRef(headRef, baseRef) {
  if (String(baseRef || '') !== 'refs/heads/main') {
    return { ok: false, reason: 'merge group base is not refs/heads/main' };
  }
  const match = REF.exec(String(headRef || ''));
  if (!match) {
    return { ok: false, reason: 'merge group head ref does not name exactly one pull request' };
  }
  return { ok: true, number: Number(match[1]), refSha: match[2] };
}

// groupHeadSha / groupBaseSha: merge_group.head_sha / base_sha from the event.
// parents: the parent SHAs of the group head commit, in order, from the API.
function resolveMergeGroup({ headRef, baseRef, groupHeadSha, groupBaseSha, parents } = {}) {
  const parsed = parseMergeGroupRef(headRef, baseRef);
  if (!parsed.ok) return parsed;
  if (!SHA.test(String(groupHeadSha || ''))) {
    return { ok: false, reason: 'merge group does not identify a 40-character group head SHA' };
  }
  if (!SHA.test(String(groupBaseSha || ''))) {
    return { ok: false, reason: 'merge group does not identify a 40-character base SHA' };
  }
  if (!Array.isArray(parents) || parents.length !== 2 || !parents.every(p => SHA.test(String(p || '')))) {
    return { ok: false, reason: 'merge group commit does not have exactly two parents' };
  }
  if (parents[0] !== groupBaseSha) {
    return { ok: false, reason: 'merge group commit is not built directly on its base (more than one pull request?)' };
  }
  if (parents[1] === groupBaseSha) {
    return { ok: false, reason: 'merge group commit does not merge a pull request head' };
  }
  return { ok: true, number: parsed.number, prHead: parents[1] };
}

module.exports = { parseMergeGroupRef, resolveMergeGroup };

if (require.main === module) {
  const [headRef, baseRef, groupHeadSha, groupBaseSha, parentList] = process.argv.slice(2);
  const parents = String(parentList || '').split(/\s+/).filter(Boolean);
  const resolved = resolveMergeGroup({ headRef, baseRef, groupHeadSha, groupBaseSha, parents });
  if (!resolved.ok) {
    console.log(resolved.reason);
    process.exit(1);
  }
  console.log(`${resolved.number} ${resolved.prHead}`);
}
