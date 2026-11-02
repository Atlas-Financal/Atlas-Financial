# Savings category/tag attribution — FOUNDATION — NOT COMPLETION

Source: #820 PR1, Muse START on #821 comment 6577436081. Reviewer of record:
Claude Code under comment 6577508112. Financial consumption belongs to the
separate adopted PR2; #820 is not completed by this foundation.

The optional `savingsLinks` extension lives on the existing private
`atlas-provider-account-map/v1` document. Nothing configures or activates real
links here. The committed map remains empty. An invented example:

```json
{
  "savingsLinks": {
    "version": 3,
    "anchorRevision": 1,
    "links": [{
      "categoryId": "invented-category",
      "goalRef": { "kind": "commitment", "id": "invented-trip" },
      "occurrenceDate": "2027-03-12",
      "effectiveFrom": "2027-02-01",
      "effectiveThrough": "2027-03-31"
    }]
  }
}
```

Each link names exactly one category ID or tag ID, an existing native goal,
one exact native occurrence and an inclusive effective interval. The block
binds its mapping version to the latest confirmed allocation-history revision
at the observation date. Missing/stale anchors, ambiguous native goals and
unconfirmed occurrences stay unresolved. A group with multiple native items
cannot choose an instalment. No name, merchant resemblance or category-tree
inference can establish a link.

The observer resolves provider IDs before sanitation. Its transient actuals
packet carries only canonical targets, local transaction references, dates,
fixed reasons, mapping version and anchor revision. Exact category plus tag
hits for one occurrence produce one evidence entry. Conflicting targets,
split parents, transfers/nonconsumption and uncertain pending replacements
cannot earn posted attribution. Explicit pending evidence stays pending.
Forecast rechecks the native target and anchor before publishing the evidence
on the existing goal rows in its savings inventory/daily funding packet. The
governed packet roots and G1 capture grammar stay unchanged. The existing Budget
goal dialog and shared savings renderer print that publication.

This is descriptive evidence only: no household-budget exclusion, Saved
decrement, Paid promotion, settlement relief, encumbrance allocation, future
funding change, second inventory/store/allocator, provider call or write.
Neither source records nor confirmed anchors are modified. No-link packets
retain their old shape. Enabled foundation packets preserve all prior
financial outputs, compared against the independent pre-change engine.

Proof commands: `node test/test-savings-link-foundation.js` and
`node test/test-savings-link-capture.js` (both registered in `npm test`), plus
`node test/browser-savings-link-foundation.js` with the
existing Playwright/Chromium setup. The browser proof intercepts invented GET
responses and opens the real goal dialog at desktop, 390px and 320px for
posted, pending, conflict and no-link cases. It rejects external requests and
writes. Screenshots stay in the local temporary proof directory.
The enabled-foundation G1 regression rejects the earlier top-level metadata
placement and proves valid capture plus identical itemized financial fields
with evidence on the existing rows; no validator or manifest edit is used.

Remaining closure: independent exact-head review and green required checks;
then separately dispatch PR2's atomic financial treatment and its independent
conservation proof. Real link selection/private-map installation and activation
remain separate decisions. No merge, deployment or household acceptance is
claimed here. Muse owns the path-to-live/backlog record.
