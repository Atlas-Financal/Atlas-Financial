# Skill: forecast-runtime

**Load when** changing `public/forecast.js`, `data.json` plan policy
(`actions`, `nextDollar`, `decisionPosture`, `budget`, obligations, bills, commitments,
opening), or a page script that currently renders a household-facing
figure (`public/plan.js`, `app.js` and the other scripts `public/index.html` loads).

**Do not load for** copy edits that cannot move a figure, or for
evidence intake that does not touch the engine.

**This is procedure, not authority.**
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) owns the incumbent table,
the engine-decides / pages-render rule, and the one-master-plan rule.
This file does not compute, and must not become, a second planner. It
is not household truth and not owner policy.

Relevant lessons — search [`../lessons/TECHNICAL.md`](../lessons/TECHNICAL.md)
for **L-001**, **L-002**, and **L-006**. Do not load the whole store.

## Procedure

1. Name the incumbent in `ARCHITECTURE.md`'s table before editing. An
   unnamed page-side decision is a defect (L-001).
2. Prove the change independently of the function under change. Do not
   copy live `data.json` cents into a behaviour test as the
   specification (L-006).
3. Run `npm test`. Engine or plan-block changes need the Forecast and
   authority-coverage suites.
4. This class almost always fires a `CLAUDE.md` high-risk trigger.
   Request Atlas Contract / Systems Review only on a stable merge
   candidate.

## What this skill does not authorize

A weekly cap, a payday number, a budget split, a debt walk, a trust
label, a production write, or a schema. Those stay with Forecast,
`data.json`, the owner, or the closed gates.
