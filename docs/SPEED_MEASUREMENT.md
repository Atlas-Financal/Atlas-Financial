# Budget page speed: measurement and inventory

Phase 2 ("make the app faster"), issue #822 steps 1–2. Measured 2026-11-16 on
`main` at `e2edfda`. This file holds timings, byte sizes and file/field
names only. It holds no household figure. Local timings use invented data
(`test/acceptance/harness.js`); the live timings are durations read from the
Render application log, which records only durations.

## Summary

- **Forecast is the slow part.** On the live server a refresh spends a median
  of about 27 seconds in Forecast out of about 35 seconds in total. Getting
  the bank data takes about 3 seconds, and sending the answer to the browser
  takes about 0.1 seconds.
- **About two-thirds of Forecast's time is one step:** the "held other income"
  check (`computeHeldOtherIncomeKeys`, the hold-set computation). Its cost
  grows with the number of transactions. This is queued item (a), and it
  should go first.
- **A load served from memory still pays the full Forecast cost.** The 17
  completed "memory" refreshes took as long in Forecast as the provider ones
  (median about 27.5 s). Serving the computed result to later loads (item c)
  is the second-largest saving.
- **The browser's own work is small by comparison.** With 1,000 invented
  transactions the page blocks its main thread for about 0.6 seconds (item b).
- **Page download:** about 3.0 MB on every load. The server sends no
  compression and tells the browser not to cache anything. With gzip the same
  files would be about 0.8 MB. Two files, `forecast.js` (1.6 MB) and `plan.js`
  (0.5 MB), make up 70% of it.
- **No unused files.** Once #1155 removes the switched-off pages, every file
  left in `public/` is loaded by the Budget page. Step 3 (remove unused files)
  has no file group to remove.

## 1. Live refresh timing (Render log)

Source: the `live-refresh-stages` lines that `scripts/server-live-refresh.js`
writes. These were the most recent 100 such lines, from 2026-11-09 13:37Z to
2026-11-16 04:55Z. 76 of them completed (59 provider and 17 memory) and 24
were cancelled. Stage times nest: `overlayMs` includes `forecastMs`.

Completed refreshes, in milliseconds:

| Stage | Source | n | median | p90 | max |
|---|---|---|---|---|---|
| providerAcquireMs | provider | 59 | 3,284 | 4,634 | 9,499 |
| normalizeMs | provider | 59 | 4,043 | 5,708 | 6,370 |
| overlayMs | provider | 59 | 27,712 | 38,544 | 44,776 |
| **forecastMs** | provider | 59 | **26,783** | 37,442 | 43,817 |
| sourceReplayMs | provider | 48 | 2,272 | 18,599 | 19,905 |
| publicationMs | provider | 59 | 102 | 201 | 307 |
| normalizeMs | memory | 17 | 2,606 | 4,096 | 4,603 |
| **forecastMs** | memory | 17 | **27,510** | 36,819 | 37,116 |
| publicationMs | memory | 17 | 86 | 102 | 108 |

Since 2026-11-14 the median `forecastMs` is about 14 s (n = 15, p90 about
27 s). It is lower but still dominant. The request log holds no `/data.json`
entries, so the live packet size and the end-to-end response time could not
be read there.

## 2. Forecast compute time (local, invented data)

Script: an invented world from `baseWorld()`, with N invented transactions
spread over the window, run through `dataOf()` (the production
`live-plan.fromObservation` path) inside `refresh-stage-timing.run`. One
machine, one run per size.

| Invented transactions | forecastMs | Forecast.recommend calls per refresh | Total |
|---|---|---|---|
| 0 | 424 | 8 | 1,265 |
| 100 | 915 | 8 | 1,573 |
| 250 | 1,106 | 8 | 2,018 |
| 500 | 1,608 | 8 | 3,239 |
| 1,000 | 3,102 | 8 | 5,789 |

The cost is roughly linear: about 2.7 ms per transaction per refresh, across
8 Forecast runs. The live server is a 0.5-CPU instance working on a larger
real ledger, which fits the slower live figures.

**CPU profile** (1,000 invented transactions; inclusive time inside
`recommend`, 4.1 s in total):

| Function (public/forecast.js) | Inclusive | Share of recommend |
|---|---|---|
| `heldOtherIncomeKeys` → `computeHeldOtherIncomeKeys` | 2.6 s | ~64% |
| └ via `omitRepresented` → `expandEventsInternal` | 2.7 s | (same path) |
| `simulateModel` | 2.3 s | nests the above |
| `protectedPlanCheck` | 1.7 s | |
| `carriedUnresolvedJointCashOutflows` | 1.5 s | |
| `recommendWeekly` / `fits` | 1.3 s | |
| `calendarIncomeSections` | 1.1 s | called by the hold-set |
| `pendingPostedDuplicateIdSet` | 0.8 s | per-transaction keys |

Self-time hot spots: `savingsDate` (0.9 s; a regex and a `Date` round trip for
every date check), `normalizeMerchantKey` (0.4 s), `toUTC` / `fromUTC`
(0.8 s together), `spendDuplicateKey` (0.2 s). Each runs once per
transaction, again inside every hold-set computation.

## 3. Budget page load

Files the page loads (`index.html`, plus `nav-glass.css` through `@import`,
the second font through `fonts.css`, the manifest and the touch icon; the manifest icons are fetched only on install and are not counted). Sizes in
bytes:

| File | Raw | gzip -9 |
|---|---|---|
| forecast.js | 1,637,497 | 424,018 |
| plan.js | 526,576 | 136,439 |
| budget-blend.js | 154,838 | 40,509 |
| styles.css | 148,905 | 28,120 |
| budget-blend.css | 76,888 | 13,314 |
| budget-gface.css | 57,604 | 11,449 |
| app.js | 56,199 | 15,950 |
| budget-surface.css | 52,907 | 9,825 |
| fonts (2 woff2) | 39,896 | ~39,900 |
| 24 other files | ~242,000 | ~77,000 |
| **Total (34 files + index.html)** | **~3.0 MB** | **~0.8 MB** |

- `express.static` sends `Cache-Control: no-store` with no ETag and no
  Last-Modified, and the server does not compress. So every load downloads
  the full 3.0 MB.
- Data the page fetches: `/data.json`, `/periods.json` (9 KB committed) and
  `/balance-history.json`. The committed `data.json` is 171 KB. The live
  overlay adds about **1.24 KB per current-period transaction** (invented
  packet: 200 transactions add 250 KB, and 1,000 make the document 1.4 MB).
  The live size could not be measured without the password.
- Browser main thread (headless Chromium, invented data, reload): with 0 /
  500 / 1,000 transactions, the Budget surface appears in 0.40 / 0.66 /
  0.93 s, and the main thread is blocked for 0.17 / 0.42 / 0.64 s.

## 4. Inventory

### public/ files

| Group | Files | Status |
|---|---|---|
| Loaded by the Budget page | the 32 `index.html` references, `nav-glass.css` (`@import` in household-view.css), `fonts/GeistMono.woff2` (fonts.css), `icon-192.png`, `icon-512.png`, `icon.svg` (manifest), `periods.json` (fetched by app.js) | used by the page |
| Licence | `fonts/Geist-LICENSE.txt` | kept: the font licence requires it |
| Switched-off pages | bills, credit, modellers, plan-spend, planning, subscriptions (`.html` + `.js`) | being deleted in #1155; not touched |
| Used only by tests or proofs | none | — |
| Unused | none | — |

### Packet fields (`/data.json`)

A field counts as read by the page when its name appears as a property in a
script the page loads. That is a name match, so a "read" can be a false
positive, but a "not read" is reliable.

- **`plan.*`:** every field is read by the page except `decisionPosture`
  (1.5 KB). That one is read only by scripts and tests.
- **Top level, read by the page:** `meta`, `plan`, `settled`, `commitments`,
  `debts`, `assets`, `helocHistory`, `income`, `incomeCaptureMonths`,
  `interestCheck`, `paypal`, `lacrosse`, `unexplained`, `coverage`,
  `mortgage`, `revolvingExtra`.
- **Top level, not read by the page (scripts, tests or notes only):**
  `upcomingNote`, `debtsNote`, `utilisationNote`, `assetsNote`, `netWorth`,
  `helocSummary`, `helocUse`, `helocUseNote`, `helocChains`, `cashflow`,
  `cashflowNote`, `incomeWarning`, `incomeNote`, `spendingNote`,
  `counterparties`, `coachPayment`, `questions`. Together they are about
  23 KB of the 171 KB document.
- **`liveOverlay.currentPeriodActuals.transactions[]`:** this is most of the
  live document. Of its 49 fields per transaction, 48 are read by the page;
  only `excludeFromBudget` is not.

Trimming fields would save at most a few tens of KB, and changing the packet
changes what the page and the assistant read. That is not proposed here.

## 5. Recommended order

1. **(a) Hold-set per-transaction cost.** It is about 64% of Forecast and
   grows with the ledger. Work out the per-transaction values (`savingsDate`,
   cycle lookup, merchant and duplicate keys) once per computation instead of
   once per probe. Full lane: every figure must stay the same.
2. **(c) Serve the computed refresh result to later loads.** A load served
   from memory currently pays the full ~27 s Forecast cost again.
3. **(b) Assistant packet off the page's main thread.** This blocks the
   browser for under 1 s at 1,000 invented transactions. Last.

Outside the three queued items (observation only, not proposed here): turning
on compression and allowing static files to be cached would cut a repeat load
from 3.0 MB to near zero. Both change response headers and the
security-header path, so they would need the owner's decision first (owner stop
4) before anyone builds them.
