# Credit-card movement under the balance

All values and activity in these images are invented. The screenshots render
the real `App.boot` Budget path with intercepted synthetic data; no live data
or credentials are used by the browser proof.

The before images were captured on main
`d7be69e29acec49cff0ef3eeb1edcecbe8127d49`, before runtime edits. The after
images show the separate Forecast posted-movement publication. The fixture
supplies no saved balance endpoints. Travel increases, Cash Back decreases,
Emerald is an evidenced zero, and the two manual cards have no positive
transaction-sync evidence, so their movement is Unavailable. Their reported
balances and original dates remain visible.

| View | Before | After |
|---|---|---|
| 390px light | [before](before-light-390.png) | [after](after-light-390.png) |
| 390px dark | [before](before-dark-390.png) | [after](after-dark-390.png) |
| 1440px light | [before](before-light-1440.png) | [after](after-light-1440.png) |

`before.json` and `after.json` bind each capture to source and image SHA-256
digests. Run the proof with:

```
CHROME_PATH=/usr/bin/chromium node test/browser-card-posted-period-movement.js
```

The proof checks exact line text, geometry below the balance, the shared right
edge, clipping, light/dark contrast, and the real Travel drawer. The drawer
retains its original posted rows and separate pending authorization. It checks
that no external call or write occurs.

The live prerequisite was checked separately on the authenticated deployed
Budget page at the same base: canonical card drawers receive their own period
rows, with pending separate. Private financial details are not reproduced here.
The deliberately smaller assistant packet omits those rows; that is not a gap
in the Budget producer. Local live replay lacks the private provider map, so
the implementation is verified through synthetic observer/overlay integration
and rendered Budget proofs, with that live access limitation kept explicit.

The new figure uses the existing account sync qualifier. Sync age alone remains
informational under the owner's Nov 10 policy; this change adds no age cutoff.
A stale observation, incomplete declared query, missing/failed own-account
evidence, or malformed/ambiguous contributing row withholds movement. An empty
manual-card list or an account balance date cannot prove transaction coverage.
The previous endpoint reconciliation and drawer evidence keep their meaning.
