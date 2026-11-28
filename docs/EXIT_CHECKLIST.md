# Exit checklist: done building

For Dale. This is the finish line for "the team can stop building and Atlas
runs with occasional repairs". Tick a box only when its evidence exists. A
green set of checks is not, by itself, a reason to tick anything.

It is a checklist, not a rule. [`CLAUDE.md`](../CLAUDE.md) still holds every
rule, and this page changes none of them. Adapted from the steady-state audit,
Part 5 (#1611 7233208352) and Part 4 (#1611 7233194768), with the facts since
then: your model lineup, OD-065 (any model may build) and OD-045 (last known
stands).

**Proposed, not policy:** the 30-morning streak and the "two closes" in this
list are the audit's suggested thresholds. They are not owner decisions until
you say so.

**Privacy for every box:** keep the evidence private. Record only the day, the
build, the kind of source, the result and the reason. No amounts, transaction
rows or account details on GitHub.

## 1. The money checks catch known mistakes

- [ ] The five required checks pass on the exact version being released and in
      the merge queue.
- [ ] The six known problem families the simulator found (#1683) each have a
      small pass/fail test, with the expected answer worked out separately, or
      an explicit hold backed by evidence.
- [ ] Breaking one expected answer on purpose, or skipping a required case,
      turns the check red.
- [ ] Running the same inputs twice gives the same results.

## 2. Atlas works on ordinary mornings

- [ ] For 30 mornings in a row, covering at least two pay-period changeovers,
      your normal sign-in shows a current plan in Budget → This pay period.
      A page that loads with old data, a whole-plan hold, or a missed day breaks
      the streak. Count only days actually observed.
- [ ] For each figure that drives a decision, you can find its date and how
      sure Atlas is of it (verified, calculated, estimated or unknown).
- [ ] A figure Atlas knew keeps its last known value, marked no stronger than
      estimated, when an input goes stale (OD-045). It does not turn into a
      dash.
- [ ] A cold start and a forced refresh both work.

## 3. You can change things without a builder

On invented inputs, through the normal screens, with no script and no code
change. After each change, refresh Budget and compare with a sheet prepared in
advance.

- [ ] Bills: change amount, day and payer; add and cancel a bill.
- [ ] Subscriptions: start, stop and move one, including cash to card.
- [ ] Savings items: add, rename, re-date, finish; change a target; post a
      spend, part payment and refund.
- [ ] Pay: enter a raise, bonus, deduction and new pay schedule.
- [ ] Budget targets: change one (including to zero), add and retire a line,
      add, rename or archive a category or tag.
- [ ] Cards: open and close one, change limit and statement day, enter a
      statement and minimum. Available credit never shows as cash.
- [ ] Bank accounts: open, close, replace one and update the account map.
      A bad mapping is refused and the last good one stays.
- [ ] One-offs: plan a tax bill, refund, large card purchase and trip; apply
      the actual once.
- [ ] Loans: change terms, reserve and buffer. A past close stays as it was.
- [ ] One save, rename, cancel and retry repeated after a restart. Past periods
      keep their original versions.

## 4. History survives time and failure

Whether Atlas is saving each period's close today has **not** been checked.
These boxes are how it gets checked.

- [ ] Two periods in a row have a saved close, confirmed privately.
- [ ] A missed close in an invented test shows as a visible gap, not a made-up
      figure.
- [ ] A private backup restores to a separate private place and matches.
- [ ] Card coverage keeps working past day 120 after its starting point. Today
      it stops on day 121 (pinned by the test in #1686). This needs the
      rolling starting-point fix first.

## 5. Dates and renewals are covered

- [ ] Every dated item (year-end pay, dated links, contract terms, software
      support dates, rotating access grants, the free host going to sleep) has
      an owner and either rolls over automatically under test, has a private
      reminder that was tested, or has been retired.
- [ ] In invented tests, an expired rule, a revoked token, a missed close and an
      unavailable provider each show the expected visible result or notice.

## 6. Grok Bot's half works

- [ ] Each morning in the streak has a private record from Grok Bot: source
      checked, items handled, edits you confirmed, and anything left open (or
      "none").
- [ ] Grok Bot has handled, at least once: a changed bill, an unclear
      repayment, a shared purchase, a combined charge, pending to posted, a
      refund, a missing sync and an edit it refused.
- [ ] One missed morning produces a private notice.
- [ ] Grok Bot's schedule and permissions were checked privately, not assumed.
- [ ] Grok Bot still writes no code, and every ledger edit still needs your yes.

## 7. A repair can be done without the team

- [ ] You have approved, by a direct decision, the rules for occasional
      repairs. Until then the current rules apply, and they expect a lead.
- [ ] Your lineup gives three different models for each repair: a builder, a
      reviewer on a different model, and a merger different from both. For
      example: Muse reviews; you, or a model that neither built nor reviewed,
      merges. Grok Bot is not in this lineup.
- [ ] Drill: using [`docs/REPAIR_GUIDE.md`](REPAIR_GUIDE.md) and only your normal
      accounts, a fresh session reproduces an invented problem and opens one
      small pull request. The required checks reject a broken version. You can
      see which build is live, accept the fix, and roll back.
- [ ] No password, token or bank login entered any chat during the drill.

## 8. Retire the team

Only after every box above is ticked.

- [ ] Stop the standing lead, monitor and reviewer sessions, the mailbox
      timers and the weekly build report.
- [ ] Keep: the required checks, the privacy hook, the merge queue and the
      private figures check.
- [ ] Any feature dropped on the way out has had its one-time check, and its
      private history is kept where needed.

## Quick summary

This is the list to tick before the team stops. The big open pieces are: the
money checks for the six known mistakes, 30 good mornings in a row, being able
to change bills and plans without a builder, proof that past periods are being
saved, and one practice repair done with only your normal accounts. Nothing
here is ticked yet.
