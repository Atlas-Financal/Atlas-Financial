# Repair guide: something broke

For Dale. Use this when no lead session is running and you want to get one
problem fixed. It is a guide, not a rule: [`CLAUDE.md`](../CLAUDE.md) still
holds every rule, and this page changes none of them. Until you adopt simpler
rules by a direct decision, the steps below follow the current ones.

Adapted from the steady-state audit, Part 6 (#1611 7233219217), with the
facts since then: your model lineup, OD-065 (any model may build) and OD-045
(last known stands).

## 1. Look first

Open **Budget → This pay period**.

1. Read the "as of" time. Check which pay period is selected.
2. Press the round **Refresh** button once.
3. Note three things: did the time move; is the problem one row, the whole
   plan, or a past period; and is it on the current or a past period.

What the page is telling you:

- A dash means Atlas has no figure for that spot.
- Under OD-045, a figure Atlas once knew should keep its last known value,
  marked no stronger than estimated, until new data arrives. So a dash where a
  number used to be can itself be the problem.
- An estimate can look just like a confirmed amount on this screen. If you
  are about to pay something based on it, check Lunch Money or the bank first.

## 2. The five likely problems

| What you see | Check this yourself | Ask Grok Bot |
|---|---|---|
| **1. The site won't open, the time is old, or there is no plan today.** | Sign in again if asked. Open Lunch Money: is it up to date? If the site won't open at all, open Render and look at the latest deploy. A green health check only means the server answers; it does not prove the plan is current. | "Did today's update finish? Which part is stale, missing or held? Tell me privately and make no edits." |
| **2. A bill, subscription or card payment looks unpaid, paid twice, or on the wrong card.** | Open Bills or Credit and pick the item and period. Compare what was due with the payment that posted, who paid, and the payment note. A pending charge, a statement minimum and a card payment are three different things. | "Check the recurring link, payer, posted status, card note and any split or reversal. Is there exactly one payment? Show me any fix before you apply it." |
| **3. A budget target or savings item disappeared or changed.** | In Lunch Money, check the month's target (zero counts as a real target) and the goal's date, amount and tag. A tag alone does not make a goal. | "Did the target, group or tag change? Is the purchase or refund linked to exactly one active goal? Does the missing piece belong in Lunch Money or in the plan?" |
| **4. A new period's pay, a manual card, or the available amount looks wrong.** | Check pay date against deposit date, and the statement date, minimum and due date. Look for a new account, an expired pay assumption or a missing starting balance. One recent deposit is not proof of regular income. | "Check the deposit date, where it landed, pending items and the latest statement. Tell me anything that needs my input. Leave estimates as estimates." |
| **5. An old period shows dashes but today looks fine.** | Pick that past period again after a refresh. Atlas may not have saved that period's close, or the saved history may be out of reach. Whether closes are being saved every period has not been checked; treat that as unknown. | "Was the ledger complete around that changeover? Tell me only whether the records were there. Change nothing." |

**Grok Bot rules, unchanged:** Grok Bot looks after the ledger (sorting,
naming, Lunch Money rules, bill and income confirmation). It writes no code.
Every ledger edit it makes needs your yes first. If Grok Bot fixes the ledger
and Refresh then shows the right answer, you are done; no code repair is
needed.

## 3. If it needs code: start a builder

Open a fresh session on any model you have (OD-065: any model may build).
Pick one that will **not** also review or merge this repair. Paste this, and
replace the brackets with your symptom, for example "past period blank;
current period works":

> I need one Atlas Financial repair. Read AGENTS.md and the current CLAUDE.md
> on the latest main of Atlas-Financal/Atlas-Financial, and tell me the
> revision you read. My symptom is [plain symptom, which page, whether Refresh
> changed it, current or past period]. Start read-only. Trace the page, its
> Forecast result, the ledger or plan input, and the saved close if it is a
> past period. Tell me the first place it goes wrong, and what would tell a
> data problem apart from a code problem. Ask me only yes/no questions or for
> a plain status. Never ask me to paste a statement, a figure, an account
> number, a token, a password or a raw log. For a ledger problem, give me the
> question to ask Grok Bot. For a hosting problem, tell me the exact screen
> and setting to check myself. For missing history, keep the gap if the
> original cannot be recovered. If code is needed: reproduce it with invented
> data, show the failing test and the expected answer worked out
> independently, then open the smallest one-outcome pull request under the
> current rules. Forecast stays the only calculator. Keep rule 17, the
> verified/estimated tags, history and every existing check. Add no new labels
> or explanatory words to Atlas pages. No money movement, no production
> writes, no setting changes, no weakened tests, and never merge your own
> work. Tell me the passing checks, what I should check privately, and the
> rollback point. Keep all household information out of GitHub.

## 4. Review and merge with your lineup

Three different models, every time:

1. **Builder** — the model you started above.
2. **Reviewer** — a different model reads the pull request at its exact
   latest version and posts `NO BLOCKERS FOUND` or `BLOCKERS FOUND`. Muse
   (Muse Code or Meta Muse) is the usual pick. Ask it: "Review Atlas pull
   request #[number] at head [the long code shown on the pull request] under
   CLAUDE.md's review contract."
3. **Merger** — neither the builder's model nor the reviewer's. Muse cannot
   merge a pull request it reviewed. Atlas never merges. A Grok coding model
   can be the merger when it neither built nor reviewed (the lead assigned
   one on #1686). You may always merge yourself.

Grok Bot, the ledger app, is never a reviewer or a merger. Grok Build and
other Grok coding models are separate from it and may build like any other
model.

Before anyone merges, the pull request needs:

- all five required checks green on its latest version (`standard`,
  `refresh-isolation`, `Merge card mechanical fields`,
  `Exactly one primary risk label`, `Incumbent privacy guard`);
- the reviewer's `NO BLOCKERS FOUND` on that same version;
- if the card says `figures-moved`: your own private look at which figures
  moved ([`docs/PRIVATE_FIGURES_REVIEW.md`](PRIVATE_FIGURES_REVIEW.md)),
  unless that check shows no household figure moved and someone other than
  the builder records that on the pull request;
- no new push after the review. If the builder pushes again, the review has
  to be redone for the new version.

The current rules also expect a lead to list the pull request on the
"Merge line" (#821). With no lead, ask the merger to post that line
before merging.

## 5. After it merges: check, and undo if needed

Render deploys automatically a few minutes after a merge.

1. In Render, open the service and check that the latest deploy is live and
   names the merge you expect.
2. Open Budget → This pay period, press Refresh, and check the thing that was
   broken. If figures were meant to move, compare them with the bank.
3. Optional: a builder can run `node verify-live.js`. It checks, from
   outside, that the site still refuses to show data without a sign-in. It
   does not check your figures.

**If the fix made things worse:**

- **Fastest:** in Render, roll back to the previous deploy. This puts the old
  version back within minutes. It is temporary: the next merge deploys again.
- **Lasting:** on GitHub, open the merged pull request and press **Revert**.
  That makes a new pull request that undoes it. It goes through the same
  three-model review and merge.
- Tell the builder what you saw, in plain words, with no figures.

## Quick summary

Look at Budget, press Refresh, and match what you see to one of the five
problems. Ask Grok Bot first, since many problems are ledger problems and
need no code. If code is needed, paste the message above into a fresh
session, then have a different model review it and a third merge it; check
the live page afterwards, and roll back in Render if it got worse.
