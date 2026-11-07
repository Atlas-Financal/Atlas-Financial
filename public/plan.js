'use strict';
/* The Plan page — the 90-day forecast, the budget solved from it, and the
   next actions. All amounts come from data.json's `plan` block; the maths is
   forecast.js, the same file the node test suite exercises.

   Estimated figures are marked ≈ and rendered in the .est style everywhere,
   so a confirmed dollar never looks the same as a modelled one. */

/* ----------------------------------------------------------- knob state */
// The user's planning knobs — not financial data, just their adjustments.
const KNOB_KEY = 'hfd-plan-knobs-v1';
const state = {
  scenario: null,          // conservative | expected | optimistic
  targetBuffer: null,
  extraDebtMonthly: null,
  weeklyVariable: null,    // null = follow the recommendation
  incomeOverrides: {},     // id -> monthly amount
  disabled: [],            // commitment ids toggled off
  // The debt records and the policy target, so the engine can size an extra
  // payment against the debt that exists. Without them it spends whatever is
  // typed in: at $80,000/month the third payment drained $7,584.05 of cash
  // against balances already at zero. Held here so every call is governed —
  // passing them at one call site and not another is how the page ends up
  // showing two answers to the same question.
  debts: null,
  extraDebtTarget: null,
};
let planLook = 'this-period';
let planCalendarShow = null;
let planPayPeriodId = null;
// Disclosure choices live only in this page session, never in financial data
// or localStorage. A shortfall does not make this choice for the reader.
const paydayDisclosuresOpen = new Set();
/* AMANDA SLICE 3 — Month <-> Pay Period consolidated planning view.
 * budgetGranularity selects which lens the Budget surface shows:
 * 'pay-period' is the existing payday/pay-period operating picture;
 * 'month' is the consolidated calendar-month picture from
 * Forecast.baselineTrajectory months[]. budgetSelectedMonth is the
 * 'YYYY-MM' key of the selected trajectory month. The trajectory is
 * computed lazily and cached per input key; the page never computes
 * financial figures itself. */
let budgetGranularity = 'pay-period';
let budgetFundingLens = 'today';
let budgetSelectedMonth = null;
/* AMANDA SLICE 9 — SAME-MONTH PAY-PERIOD DRILLDOWN.
 * Toggling Month -> Pay Period keeps the selected calendar month as the
 * drilldown anchor (budgetPayPeriodAnchorMonth, a 'YYYY-MM' key) instead of
 * falling back to the generic payday picture. budgetDrilldownPayPeriod is
 * the selected cycle's payday id; period selection never moves
 * budgetSelectedMonth. Null anchor = no drilldown context = the incumbent
 * current-payday operating shell, unchanged. */
let budgetPayPeriodAnchorMonth = null;
let budgetDrilldownPayPeriod = null;
let budgetTrajectoryCache = null;
let budgetTrajectoryCacheKey = null;
// The Month funding-detail schedule is cached on the same input key as
// the trajectory, so the two cannot drift apart when the active Budget
// inputs change (Systems Review P1 repair on the Slice 8 block, PR #446).
let budgetMonthScheduleCache = null;
let budgetMonthScheduleCacheKey = null;
// ONLY these are persisted or restored. `state` also carries the debt records
// so the engine can size a payment against real balances, and serialising the
// whole object would write account balances and credit limits into
// localStorage — financial data, out from behind the authenticated gate and
// onto the disk of whatever machine the page was opened on. The list is
// explicit so adding a field to `state` cannot silently start persisting it.
const KNOBS = ['scenario', 'targetBuffer', 'extraDebtMonthly', 'weeklyVariable',
  'incomeOverrides', 'disabled'];
function loadKnobs(defaults) {
  state.scenario = defaults.scenario;
  state.targetBuffer = defaults.targetBuffer;
  state.extraDebtMonthly = defaults.extraDebtMonthly;
  try {
    const saved = JSON.parse(localStorage.getItem(KNOB_KEY) || 'null');
    // Only the knobs are restored. An older payload — or a tampered one — must
    // not be able to inject its own `debts` and have the page plan against
    // balances that never came from data.json.
    if (saved && typeof saved === 'object') {
      for (const k of KNOBS) if (saved[k] !== undefined) state[k] = saved[k];
    }
  } catch { /* storage unavailable */ }
}
function saveKnobs() {
  const out = {};
  for (const k of KNOBS) out[k] = state[k];
  try { localStorage.setItem(KNOB_KEY, JSON.stringify(out)); } catch { /* ignore */ }
}

/* ATLAS-080 publication gating: the settlement evidence loader's
 * tri-state outcome reaches this page as a status carried ALONGSIDE
 * the evidence on the served data (d.settlementEvidenceStatus /
 * d.settlementEvidence) — never inside the evidence. The reason
 * vocabulary is the loader's stable set; anything outside it is
 * malformed. A malformed status, a qualified status without valid
 * effective evidence, or evidence under any non-qualified status
 * fails closed as unavailable('invalid-configuration') — never as
 * unconfigured, so a configured-but-broken store cannot masquerade
 * as "never configured" and publish settlement-dependent figures. */
const PLAN_SETTLEMENT_REASONS = new Set([
  'invalid-configuration', 'pin-unavailable', 'pin-invalid',
  'document-unavailable', 'document-missing', 'document-malformed',
  'household-mismatch', 'revision-mismatch', 'document-ahead-of-pin',
  'digest-mismatch', 'document-invalid', 'document-changed',
]);

// The effective projection's structural contract, mirrored from
// planned-obligation-settlement-contract.js (goalId, operation and
// txRef formats, positive safe-integer cents, real calendar dates,
// sha256 evidence digests, reversal records). Forecast's settlement
// index silently SKIPS entries and links that fail these shapes
// while still applying the rest — under a qualified label that
// would publish legacy figures as if the evidence were whole. The
// projection is keyed one entry per goal with unique operation
// identities, so duplicates are malformed too. A shared txRef
// across goals is NOT malformed: the contract budgets one payment
// across split assignments.
function planSettlementDateValid(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}

function planSettlementEvidenceValid(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
  if (!Array.isArray(evidence.commitments)) return false;
  const goals = new Set();
  const operations = new Set();
  for (const entry of evidence.commitments) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    if (typeof entry.goalId !== 'string'
      || !entry.goalId.startsWith('commitment:')
      || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(entry.goalId.slice('commitment:'.length))) return false;
    if (goals.has(entry.goalId)) return false;
    goals.add(entry.goalId);
    if (!Array.isArray(entry.links) || entry.links.length === 0) return false;
    for (const link of entry.links) {
      if (!link || typeof link !== 'object' || Array.isArray(link)) return false;
      if (typeof link.operationId !== 'string'
        || !/^operation-[a-f0-9]{32}$/.test(link.operationId)) return false;
      if (operations.has(link.operationId)) return false;
      operations.add(link.operationId);
      if (typeof link.txRef !== 'string' || !/^tx-[a-f0-9]{32}$/.test(link.txRef)) return false;
      if (!Number.isSafeInteger(link.assignedCents) || link.assignedCents <= 0) return false;
      if (!planSettlementDateValid(link.effectiveDate)
        || !planSettlementDateValid(link.asOf)) return false;
      if (typeof link.evidenceDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(link.evidenceDigest)) return false;
      if (!Array.isArray(link.reversals)) return false;
      for (const reversal of link.reversals) {
        if (!reversal || typeof reversal !== 'object' || Array.isArray(reversal)) return false;
        if (typeof reversal.operationId !== 'string'
          || !/^operation-[a-f0-9]{32}$/.test(reversal.operationId)) return false;
        if (operations.has(reversal.operationId)) return false;
        operations.add(reversal.operationId);
        if (typeof reversal.counterTxRef !== 'string'
          || !/^tx-[a-f0-9]{32}$/.test(reversal.counterTxRef)) return false;
        if (!Number.isSafeInteger(reversal.cents) || reversal.cents <= 0) return false;
        if (!planSettlementDateValid(reversal.date)) return false;
      }
    }
  }
  return true;
}

function planSettlementOutcome(d) {
  const status = d ? d.settlementEvidenceStatus : undefined;
  const evidence = d ? d.settlementEvidence : undefined;
  const invalid = { kind: 'unavailable', reason: 'invalid-configuration' };
  // A published null status is a malformed outcome, not an omitted
  // one: omitted (undefined) is the unconfigured seam, while null is
  // a configured outcome that failed to serialize — fail closed
  // rather than equate it with inactivity.
  if (status === null) return invalid;
  const hasStatus = status !== undefined;
  const hasEvidence = evidence !== undefined && evidence !== null;
  if (!hasStatus && !hasEvidence) return { kind: 'unconfigured' };
  if (!hasStatus || typeof status !== 'object' || Array.isArray(status)) return invalid;
  if (status.status === 'unconfigured') {
    return hasEvidence ? invalid : { kind: 'unconfigured' };
  }
  if (status.status === 'qualified') {
    return hasEvidence && planSettlementEvidenceValid(evidence)
      ? { kind: 'qualified', evidence }
      : invalid;
  }
  if (status.status === 'unavailable') {
    if (hasEvidence) return invalid;
    return PLAN_SETTLEMENT_REASONS.has(status.reason)
      ? { kind: 'unavailable', reason: status.reason }
      : invalid;
  }
  return invalid;
}

// The verified effective evidence for the render in progress, set by
// renderPlan from the served outcome. Threaded through simOpts so
// every Forecast call this page makes sees the same evidence; null
// (unconfigured) leaves every call byte-identical to before.
let planSettlementEvidence = null;

// The page's single debt-walk entry. Every render path that needs
// Forecast's debt projection goes through here, so plan.js keeps
// exactly one Forecast.projectDebts call site — the debt walk on
// screen has one authority, never a second walk (a source invariant
// the counterfactuals suite pins).
function planDebtProjection(plan, debts, asOf, opts) {
  return Forecast.projectDebts(plan, debts, asOf, opts);
}

function simOpts(extra = {}) {
  const base = {
    scenario: state.scenario,
    targetBuffer: state.targetBuffer,
    extraDebtMonthly: state.extraDebtMonthly,
    incomeOverrides: state.incomeOverrides,
    disabled: state.disabled,
    debts: state.debts,
    extraDebtTarget: state.extraDebtTarget,
    extraFacilities: state.extraFacilities,
  };
  if (planSettlementEvidence) base.settlementEvidence = planSettlementEvidence;
  return Object.assign(base, extra);
}

const addDays = (iso, n) => Forecast.addDays(iso, n);
const fmtMonth = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-CA', { month: 'long' });
const est = s => `<span class="est">≈ ${s}</span>`;
const fmtRange = (a, b) => {
  const s = new Date(a + 'T00:00:00'), e = new Date(b + 'T00:00:00');
  const sm = s.toLocaleDateString('en-CA', { month: 'short' }), em = e.toLocaleDateString('en-CA', { month: 'short' });
  return sm === em ? `${s.getDate()}–${e.getDate()} ${em}` : `${s.getDate()} ${sm} – ${e.getDate()} ${em}`;
};

/* --------------------------------------------------- the mission, in words */
// `Forecast.mission` decides WHICH instructions the household is given and in
// what order. This map is all that is left here: how each one reads. Every
// entry is handed the part the engine produced and returns one clause, and
// nothing in it may choose whether a clause applies — that is the engine's.
//
// Adding an instruction to the engine without adding its wording here is a
// rendering failure, so `test-mission.js` checks that the two sides still name
// the same set of instructions.
const MISSION_PART = {
  infeasible: p => {
    // Presentation fail-closed: a null / undefined / nonfinite shortfall is a
    // published verdict WITHOUT a published amount — money2(null) would print
    // $0.00 and invent a figure, so the amount stays explicitly unquantified.
    // A real numeric zero is a valid amount and still prints $0.00. The date
    // is validated before formatting: an invalid date prints no date clause,
    // never "Invalid Date" and never an invented day.
    const dateOk = (() => {
      if (typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return false;
      const [y, m, d] = p.date.split('-').map(Number);
      const dt = new Date(`${p.date}T00:00:00`);
      return !Number.isNaN(dt.getTime()) && dt.getFullYear() === y
        && dt.getMonth() === m - 1 && dt.getDate() === d;
    })();
    const by = Number.isFinite(p.shortfall)
      ? ` by ${money2(p.shortfall)}` : ' by an unquantified amount';
    return `the protected plan cannot work — ${p.label || 'a protected constraint'}
    fails${dateOk ? ` on ${fmtDateLong(p.date)}` : ''}${by}; a weekly spending
    figure does not fix this`;
  },
  fundingShortfall: p => `find ${money(p.shortfall)} beyond every account available, or lower the buffer`,
  coverGap: p => `cover the ${money(p.amount)} timing gap by ${fmtDateLong(p.by)}`,
  overLimit: p => `get the ${p.debts.map(x => x.label).join(' and ')} back under its limit`,
  cutSpending: p => `cut spending to ${money(p.supported)} a week — ${money(p.unsupported)} does not hold`,
  holdSpending: p => `hold spending to ${money(p.weekly)} a week`,
  helocLimit: p => `and stop the HELOC growing before it passes its own limit in ${fmtMonth(p.date)}`,
  nearBoundary: p => `and ${money2(p.total)} of named obligations (${p.items.map(x => x.label).join(', ')}) fall on or immediately after the next payday (${fmtDateLong(p.payday)})`,
  surplusToCard: () => 'and put the surplus against the most expensive card',
};

/* ------------------------------------------------- the status band, in words */
// `Forecast.planStatus` decides WHICH of the eight verdicts the household reads
// at the top of this page, and picks every figure and date inside it. This map
// is all that is left here: the tone class and how each one reads.
//
// Nothing in it may test a figure against a threshold, compare two balances or
// select a date — those are the decisions that moved. The one comparison left
// is between two dates the engine already chose, and it only stops the sentence
// naming the same day twice.
//
// A verdict the engine can emit without wording here is a rendering failure, so
// `test-status-band.js` checks that the two sides still name the same set.
//
// Each entry is handed the engine's verdict and the `plan` block, the second
// only so the opening-gap sentence can print `startingCash` — a published fact
// straight from data.json, exactly as the funding lede below prints it.
const STATUS_BAND = {
  unavailable: { tone: 'crit', text: s => `<b>Current plan unavailable.</b> ${s.reason}` },
  infeasible: { tone: 'crit', text: s => {
      // Same fail-closed presentation as the mission clause: a null /
      // undefined / nonfinite shortfall stays explicitly unquantified (never
      // $0.00), a real numeric zero still prints $0.00, an invalid date
      // prints no date clause (never "Invalid Date"), and a nonfinite buffer
      // prints no buffer clause rather than a fabricated figure.
      const dateOk = (() => {
        if (typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) return false;
        const [y, m, d] = s.date.split('-').map(Number);
        const dt = new Date(`${s.date}T00:00:00`);
        return !Number.isNaN(dt.getTime()) && dt.getFullYear() === y
          && dt.getMonth() === m - 1 && dt.getDate() === d;
      })();
      const by = Number.isFinite(s.shortfall)
        ? ` by ${money2(s.shortfall)}` : ' by an unquantified amount';
      const atBuffer = Number.isFinite(s.buffer) ? ` at the
       ${money(s.buffer)} model buffer` : '';
      return `<b>INFEASIBLE — the protected plan cannot work.</b> ${s.label || 'A protected constraint'}
       fails${dateOk ? ` on ${fmtDateLong(s.date)}` : ''}${by}${atBuffer}. A weekly spending figure does not fix this.`;
    } },

  unfunded: { tone: 'crit', text: s =>
    `<b>Short by ${money(s.gapAmount)} on ${fmtDateLong(s.floorDate)}, and there is not enough
       anywhere to cover it.</b> Every usable source combined reaches
       ${money2(s.allocated)}, leaving
       <b>${money2(s.shortfall)}</b> unfunded at a ${money(s.buffer)} buffer. No weekly spending
       figure fixes this — lower the buffer, move a commitment, or find money outside these accounts.` },

  overrideBreach: { tone: 'crit', text: s =>
    `<b>${money(s.weekly)}/week does not work${s.goesNegative ? ' — the account goes negative' : ''}.</b>
       Even with the ${money(s.gapAmount)} gap covered, spending at your setting takes the balance to
       ${money(s.low)} by ${fmtDateLong(s.lowDate)}${s.firstBelowBuffer && s.firstBelowBuffer !== s.lowDate
      ? `, first slipping below the buffer on ${fmtDateLong(s.firstBelowBuffer)}` : ''}.
       The forecast supports <b>${money(s.recommended)}/week</b>.` },

  // Two openings, and the engine decides which is true — the allocation taking
  // two sources does not prove that none could have covered the gap alone.
  // Claiming the stronger one put this band in contradiction with the source
  // card below it, which reads its verdict from the same funding result.
  combination: { tone: 'crit', text: s =>
    `<b>Short by ${money(s.gapAmount)} on ${fmtDateLong(s.floorDate)}, and ${s.noSingleSourceCovers
      ? 'no single source covers it' : 'the plan draws on more than one source'}.</b>
       It takes ${s.parts.map(p => `${money2(p.amount)} from ${p.short}`).join(' plus ')}.
       ${s.borrowed > 0
      ? `<b>${money2(s.borrowed)} of that is borrowed</b>, and the debt figures below carry it.`
      : 'None of it is borrowed.'}
       Hold spending to ${money(s.weekly)}/week from ${fmtDateLong(s.effectiveFrom)} and the window
       finishes with ${money(s.ending)}.` },

  gap: { tone: 'crit', text: (s, plan) =>
    `<b>Short by ${money(s.gapAmount)} on ${fmtDateLong(s.floorDate)} — before any spending at all.</b>
       The household accounts hold ${money2(Forecast.startingCashAmount(plan))} today and
       ${money(s.preIncomeOut)} of committed payments fall before the next payday.
       This is a timing gap, not a shortage across the 90 days: cover it, hold spending to
       ${money(s.weekly)}/week from ${fmtDateLong(s.effectiveFrom)}, and the window
       finishes with ${money(s.ending)}.` },

  negative: { tone: 'crit', text: s =>
    `<b>Shortfall expected around ${fmtDateLong(s.firstNegative)}.</b>
         At this spending level the account goes negative${s.firstNegative !== s.lowDate
      ? ` and keeps falling, reaching ${money(s.low)} by ${fmtDateLong(s.lowDate)}`
      : ` (${money(s.low)})`}.
         Cut the weekly budget, move a commitment, or bring income forward.` },

  belowBuffer: { tone: 'warn', text: s =>
    `<b>Tight — projected to dip to ${money(s.low)} on ${fmtDateLong(s.lowDate)}</b>,
      below the ${money(s.buffer)} target buffer, then recover to ${money(s.ending)} by ${fmtDate(s.end)}.` },

  onPlan: { tone: 'good', text: s =>
    `<b>On plan — projected to finish with ${money(s.ending)}.</b>
      The balance stays above the ${money(s.buffer)} buffer all the way through, with the low of
      ${money(s.low)} on ${fmtDateLong(s.lowDate)}.` },
};

/* ------------------------- the room against the household's own budget, said */
// Three outcomes, and `Forecast.budgetBreakdown` says which. The engine used to
// hand over a signed difference and this page rendered it as "short of it"
// whatever its sign, so a cap leaving MORE room than the household budgets
// published "the plan is −$28/wk short of it and something has to give".
// A magnitude and a verdict cannot be read the wrong way round.
const ROOM_VERSUS_HOUSEHOLD = {
  short: r => `so the plan is ${money(r.weekly)}/wk short of it and something has to give.`,
  meets: () => `which is what the plan leaves.`,
  exceeds: r => `and the plan leaves ${money(r.weekly)}/wk more than that.`,
};

/* ------------------------------- what the next move achieves, in words */
// `Forecast.nextMove` decides WHICH of the five outcomes the household reads
// under **What happens after**, and picks every figure inside it. This map is
// all that is left here: how each one reads.
//
// Nothing in it may compare the action's amount with the gap, subtract the two,
// or decide that a different outcome applies. Those are the decisions that
// moved — the page's `actionCovers` and `actionLeaves`, which carried their own
// copy of the engine's half-cent and chose between these five sentences where
// no test could reach them.
//
// An outcome the engine can emit without wording here is a rendering failure,
// so `test-nextmove.js` checks that the two sides still name the same set.
const NEXT_MOVE = {
  unavailable: s => s.reason,
  unfunded: s =>
    `Even with everything available moved across, ${money(s.shortfall)} of the
     ${money(s.gapAmount)} stays unfunded and the balance holds below the ${money(s.buffer)} buffer.
     This action helps; on its own it is not enough.`,

  partial: s =>
    `This covers ${money(s.actionAmount)} of the ${money(s.gapAmount)} needed, leaving
     ${money(s.remainder)} still to find before the ${money(s.buffer)} buffer is back.
     ${s.parts
    ? `The full plan is ${s.parts.map(p => `${money2(p.amount)} from ${p.short}`).join(' plus ')}.`
    : ''} With all of it in place the household can spend ${money(s.recommended)} a week from
     ${fmtDateLong(s.effectiveFrom)}${s.overrideUnsupported
      ? `, not the ${money(s.weekly)} currently set — that reaches ${money(s.low)}` : ''}.`,

  overrideBreach: s =>
    `The ${money(s.dueOnGapDay)} clears on ${fmtDateLong(s.gapDate)} and the buffer is restored — but
     at your ${money(s.weekly)}/week setting the balance still reaches ${money(s.low)} by
     ${fmtDateLong(s.lowDate)}. The forecast supports ${money(s.recommended)}/week.`,

  restored: s =>
    `The ${money(s.dueOnGapDay)} clears on ${fmtDateLong(s.gapDate)}, the buffer is restored, and from
     ${fmtDateLong(s.effectiveFrom)} the household can spend ${money(s.weekly)} a week.`,

  // Three clauses, and the engine decides which apply. The first said only
  // "instead of breaching the buffer", unconditionally, which is false of any
  // run that does breach — and a covering action that arrives too late now
  // lands here, so it has to say why the gap is not restored as well.
  windowEnding: s =>
    `${s.coversButLate
      ? `The ${money(s.actionAmount)} reaches the ${money(s.gapAmount)} needed, but it is not due until
         ${fmtDateLong(s.actionDue)} — after the ${money(s.dueOnGapDay)} has to clear on
         ${fmtDateLong(s.gapDate)}, so it does not restore the buffer in time. ` : ''
}The window finishes with ${money(s.ending)} ${s.breaches
    ? `after dipping to ${money(s.low)} on ${fmtDateLong(s.lowDate)}, below the ${money(s.buffer)} buffer`
    : `instead of breaching the ${money(s.buffer)} buffer`}.${s.overrideUnsupported
    ? ` That is at your ${money(s.weekly)}/week setting; the forecast supports ${money(s.recommended)}/week.`
    : ''}`,
};

/* ------------------------------------------- unallocated, in words */
// Forecast.unallocatedCash decides whether the ending cash leaves free cash
// or does not. This map is how each verdict reads. The leftover sentence is
// handed the next-dollar summary, which is plan.nextDollar's, not this
// authority's.
const UNALLOCATED_NOTE = {
  unavailable: () => 'Unallocated cash is unavailable until card-payment funding is confirmed.',
  none: () =>
    `There is no free cash at the end of this window. What looks like a surplus is the buffer and the money
       already owed to costs that fall outside the 90 days.`,
  leftover: summary =>
    `<b>This is not spending money.</b> It is what is left after the buffer and the reserves, and it is the only
       money available to reduce debt. ${summary || ''}`,
};

/* ------------------------------------------- the three phases, in words */
// Forecast.planPhases decides which heading each 30-day block gets, which
// body the opening block uses, which way consumer debt moved, and whether
// the HELOC sentence belongs in 31–60. This map is how each one reads.
const PHASE_RANGE = {
  '0-30': '0–30 days',
  '31-60': '31–60 days',
  '61-90': '61–90 days',
};
const PHASE_TITLE = {
  coverGap: 'Cover the gap and stabilise',
  holdBuffer: 'Hold the buffer',
  overLimit: 'Get back inside the limits',
  relievePressure: 'Relieve revolving pressure',
  surplusToPrincipal: 'Put the surplus against principal',
  stopGrowth: 'Stop the growth',
};
const PHASE_BODY = {
  '0-30': p => {
    if (p.id === 'unfunded') {
      return `Every usable source combined leaves ${money(p.shortfall)} of the ${money(p.gapAmount)}
           unfunded. Lower the buffer, move a commitment, or find money outside these accounts.`;
    }
    if (p.id === 'coverGap') {
      return `Get ${money(p.gapAmount)} across by ${fmtDateLong(p.gapDate)}, then hold ${money(p.weekly)}/week.
             Cash recovers to ${money(p.cashAt30)} by ${fmtDate(p.date30)}.`;
    }
    return `Hold ${money(p.weekly)}/week. Cash sits at ${money(p.cashAt30)} by ${fmtDate(p.date30)}.`;
  },
  '31-60': p =>
    `Consumer debt moves ${money(p.consumerMove)}
       ${p.consumerDirection} to ${money(p.consumer60)}, and credit left across every
       facility is ${money(p.headroom60)}.${p.helocInPhase
      ? ` The HELOC passes its own limit in this phase — its interest capitalises with nothing repaying it.` : ''}`,
  '61-90': p =>
    `Cash finishes at ${money(p.ending)} against a ${money(p.buffer)} buffer.
       ${p.nextDollarSummary || ''}`,
};

/* ------------------------------------------- the risk list, in words */
// Forecast.planPhases decides which risks appear and the figures inside
// them. This map is how each one reads. The cash-not-cards line is always
// shown: it is copy, not a comparison.
const RISK_WHAT = {
  amandaRequired: r => `Amanda's Tennis BC salary — ${money(r.amount)}/month is owner-confirmed (15th and month-end)`,
  amandaOptional: r => `Amanda's Tennis BC salary — ${money(r.amount)}/month is owner-confirmed (15th and month-end)`,
  estimatedCommitments: r => `${r.count} commitments totalling ${money(r.total)} are estimates`,
  helocDrawn: r => `The HELOC passes its own limit on ${fmtDateLong(r.date)}, and this plan draws ${money(r.drawn)} on it`,
  helocNoDraw: r => `The HELOC passes its own limit on ${fmtDateLong(r.date)} with no new borrowing`,
  facilityCrossing: r => `${r.label} goes over its limit on ${fmtDateLong(r.date)}`,
  telecomUnrouted: r => `Card-paid Bell ${money(r.planned)}/month sits inside the cap — Shaw is dated; Telus is $0 forward`,
};
const RISK_CHANGE = {
  amandaRequired: r =>
    `The plan needs the first one by ${fmtDateLong(r.neededBy)}. Without any of them the window ends
           ${money(r.windowImpact)} lower and breaches the buffer.`,
  amandaOptional: r =>
    `The window holds even without them, but the ending cash falls by about ${money(r.windowImpact)}.`,
  estimatedCommitments: r =>
    `${r.labels.join(', ')}. None is invoiced yet. If they land higher, or
               earlier than assumed, the weekly cap falls.`,
  helocDrawn: r =>
    `Its ${money(r.monthlyInterest)}/month interest capitalises and
               nothing repays it, so the balance grows on its own. The ${money(r.drawn)} this plan draws to cover the opening gap brings that date forward, and the
            crossing date shown already includes it.`,
  helocNoDraw: r =>
    `Its ${money(r.monthlyInterest)}/month interest capitalises and
               nothing repays it, so the balance grows on its own.${r.alternative
      ? ` Covering the opening gap from it instead of ${r.alternative.displaces.join(' and ')}
          brings that crossing forward to <b>${fmtDateLong(r.alternative.alternateDate)}</b>.` : ''}`,
  facilityCrossing: () =>
    `Its minimum barely exceeds its interest, so the balance sits against the limit and crosses it
               in the days before each payment. Each crossing risks an over-limit fee on top of the interest,
               which raises the card's effective rate above its headline one.`,
  telecomUnrouted: () =>
    `TELUS IS CLOSED. Forward telecom is the evidenced active services. This cap remainder is the two evidenced Bell bills (main June baseline plus the separate watch CSV), not a live Telus bill, not a second Shaw, and not a duplicate of the $15 watch line already inside the main Bell bill.`,
};

/* ------------------------------------------- HELOC month-on-month, in words */
// Forecast.compactSnapshot decides the direction. This map is how each
// verdict reads, and which sign the delta wears.
const HELOC_TREND = {
  growing: { note: 'still growing', sign: '+' },
  falling: { note: 'coming down', sign: '−' },
  unchanged: { note: 'no change from last month', sign: '+' },
};

/* --------------------------------------- the funding-source cards, in words */
// Whether a source covers the gap, contributes part of it, or cannot reach it
// is `Forecast.recommend`'s — it is the same allocation the plan is built on,
// seen per source. The page had its own `o.available >= needed` beside it, and
// the two disagreed on screen: these cards once read "Covers it" under a band
// saying nothing could. What is left here is the sentence and the class.
const FUND_VERDICT = {
  covers: { cls: 'fund-yes',
    text: (s, needed) => `<span class="ok">Covers the whole ${money(needed)}</span>` },
  contributes: { cls: 'fund-no',
    text: (s, needed) => `<span class="ok">Covers ${money2(s.contributes)} of the ${money(needed)}</span> <span class="mutedtext">— used in the plan, with the rest from elsewhere</span>` },
  insufficient: { cls: 'fund-no',
    text: (s, needed) => `<span class="no">Not enough — ${money(s.shortBy)} short of the ${money(needed)} needed</span>` },
};

/* ----------------------------------------------------------- the chart */
// Daily projected balance. Everything important is annotated on the chart
// itself — the lowest point, the buffer, paydays, large payments — because
// hover is not available on touch. The weekly table repeats every number.
function forecastChart(mount, sim) {
  if (!mount) return;
  const W = 760, H = 320, padL = 62, padR = 16, padT = 30, padB = 42;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const days = sim.daily;
  const vals = days.map(d => d.balance);
  const lo = Math.min(0, sim.buffer, ...vals) - 300;
  const hi = Math.max(...vals, sim.buffer) * 1.06;
  const x = i => padL + (i / (days.length - 1)) * plotW;
  const y = v => padT + plotH - ((v - lo) / (hi - lo)) * plotH;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `Projected cash balance, ${fmtDate(sim.start)} to ${fmtDate(sim.end)}. Lowest ${money(sim.min.balance)} on ${fmtDate(sim.min.date)}. Ending ${money(sim.ending)}.` });

  // gridlines + axis labels
  for (let t = 0; t <= 4; t++) {
    const v = lo + (hi - lo) * t / 4, yy = y(v);
    svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: css('--grid'), 'stroke-width': 1 }));
    const tx = el('text', { x: padL - 10, y: yy + 4, 'text-anchor': 'end', fill: css('--muted'), 'font-size': '11' });
    tx.textContent = (v < 0 ? '−$' : '$') + Math.abs(v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    svg.appendChild(tx);
  }

  // negative territory, tinted — visible only when the range dips below zero
  if (lo < 0) {
    svg.appendChild(el('rect', { x: padL, y: y(0), width: plotW, height: padT + plotH - y(0),
      fill: css('--critical'), opacity: 0.07 }));
    svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: y(0), y2: y(0), stroke: css('--critical'), 'stroke-width': 1.5 }));
  }

  // weeks that dip below the buffer, shaded
  sim.weeks.forEach((w, i) => {
    if (!w.belowBuffer) return;
    const x0 = x(i * 7), x1 = x(Math.min(days.length - 1, i * 7 + 6));
    svg.appendChild(el('rect', { x: x0, y: padT, width: x1 - x0, height: plotH,
      fill: w.negative ? css('--critical') : css('--serious'), opacity: 0.08 }));
  });

  // buffer line
  svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: y(sim.buffer), y2: y(sim.buffer),
    stroke: css('--serious'), 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }));
  const bl = el('text', { x: W - padR, y: y(sim.buffer) - 6, 'text-anchor': 'end', fill: css('--serious'), 'font-size': '11', 'font-weight': '600' });
  bl.textContent = `Buffer ${money(sim.buffer)}`; svg.appendChild(bl);

  // the balance line
  const d = days.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
  svg.appendChild(el('path', { d, fill: 'none', stroke: css('--s1'), 'stroke-width': 2.25, 'stroke-linejoin': 'round' }));

  // paydays (income ≥ $1,000) and large payments (≥ $500), marked on the line
  const byDate = new Map(days.map((p, i) => [p.date, i]));
  const marked = new Set();
  for (const e of sim.events) {
    const i = byDate.get(e.date);
    if (i == null) continue;
    if (e.kind === 'income' && e.amount >= 1000 && !marked.has('i' + e.date)) {
      marked.add('i' + e.date);
      const isEst = e.confidence !== 'confirmed';
      svg.appendChild(el('circle', { cx: x(i), cy: y(days[i].balance), r: 4.5,
        fill: isEst ? css('--surface-1') : css('--s1'), stroke: css('--s1'), 'stroke-width': 2 }));
    } else if (e.amount <= -500 && e.kind !== 'income' && !marked.has('o' + e.date)) {
      marked.add('o' + e.date);
      const xx = x(i), yy = y(days[i].balance);
      svg.appendChild(el('path', { d: `M${xx - 4.5},${yy + 8} L${xx + 4.5},${yy + 8} L${xx},${yy + 15} Z`, fill: css('--serious') }));
    }
  }

  // the lowest point, always labelled
  const mi = byDate.get(sim.min.date) ?? 0;
  const mx = x(mi), my = y(sim.min.balance);
  const bad = sim.min.balance < 0;
  svg.appendChild(el('circle', { cx: mx, cy: my, r: 5, fill: bad ? css('--critical') : css('--serious'), stroke: css('--surface-1'), 'stroke-width': 2 }));
  const anchor = mi < days.length * 0.2 ? 'start' : mi > days.length * 0.8 ? 'end' : 'middle';
  const lab = el('text', { x: mx, y: Math.max(14, my - 14), 'text-anchor': anchor,
    fill: bad ? css('--critical') : css('--text-primary'), 'font-size': '12.5', 'font-weight': '700' });
  lab.textContent = `Low ${money(sim.min.balance)} · ${fmtDate(sim.min.date)}`;
  svg.appendChild(lab);

  // month labels along the bottom
  let lastMonth = '';
  days.forEach((p, i) => {
    const m = p.date.slice(0, 7);
    if (m !== lastMonth && (i === 0 || p.date.slice(8) === '01')) {
      lastMonth = m;
      const t = el('text', { x: x(i), y: H - 14, 'text-anchor': i === 0 ? 'start' : 'middle', fill: css('--muted'), 'font-size': '11' });
      t.textContent = new Date(p.date + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: i === 0 ? 'numeric' : undefined });
      svg.appendChild(t);
    }
  });

  // touch/hover detail, additive only — nothing depends on it
  days.forEach((p, i) => {
    const hit = el('rect', { x: x(i) - plotW / days.length / 2, y: padT, width: plotW / days.length, height: plotH, fill: 'transparent' });
    const evts = sim.events.filter(e => e.date === p.date);
    hit.addEventListener('mousemove', e => showTip(e, `<b>${fmtDate(p.date)}</b><span class="m">Balance ${money2(p.balance)}` +
      (evts.length ? '<br>' + evts.map(ev => `${ev.amount > 0 ? '+' : '−'}${money(Math.abs(ev.amount)).slice(1)} ${ev.label}${ev.confidence === 'estimated' ? ' ≈' : ''}`).join('<br>') : '') + '</span>'));
    hit.addEventListener('mouseleave', hideTip);
    hit.addEventListener('click', e => showTip(e, `<b>${fmtDate(p.date)}</b><span class="m">Balance ${money2(p.balance)}</span>`));
    svg.appendChild(hit);
  });

  mount.innerHTML = '';
  mount.appendChild(svg);
}

/* ----------------------------------------------------------- calendar */
// Compact labels for calendar cells and agenda rows.
function shortLabel(label) {
  return label
    .replace(/ — .*$/, '')
    .replace(/Mastercard/i, 'MC').replace(/ minimum/i, ' min')
    .replace(/ registration/i, '').replace(/ instalment/i, '')
    .replace(/ membership/i, '').replace(/ \(two accounts\)/i, '')
    .replace(/Payroll.*/i, 'Payroll').replace(/Tennis BC.*/i, 'Tennis BC')
    .replace(/Coaching.*/i, 'Tennis transfer');
}

function isCardPaidReserve(e) {
  return !!(e && e.cardPaid === true);
}

function isExternalObligation(e) {
  return !!(e && e.jointCash === false && !isCardPaidReserve(e));
}

function externalPayerLabel(plan, event) {
  const id = event && event.payingAccount;
  if (id === 'amanda-debt-payments') return 'Amanda / TENNIS INCOME';
  const cash = (plan && plan.startingCash) || {};
  const row = (cash.breakdown || []).concat(cash.heldElsewhere || [])
    .find(r => r.id === id);
  return (row && row.label) || id || 'an account outside the joint-cash pool';
}

// Month-grid calendar (desktop) and agenda list (mobile) from the same
// simulation. Each is a real table/list, so screen readers get both.
function renderCalendar(sim, neededBy, plan) {
  // Commitments that must be paid together get a same-day marker, so the
  // calendar cannot suggest splitting them across a payday.
  const groupOf = {};
  for (const c of plan.commitments) if (c.group) groupOf[c.id] = c.group;
  const atomic = new Set((plan.groups || []).filter(g => g.atomic).map(g => g.id));
  const byDate = new Map();
  for (const e of sim.events) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const balance = new Map(sim.daily.map(p => [p.date, p.balance]));

  const evHtml = e => {
    const est = e.confidence === 'estimated' ? '<span class="est">≈</span>' : '';
    const cardPaid = isCardPaidReserve(e);
    const external = isExternalObligation(e);
    const cls = e.amount > 0 ? 'in'
      : e.kind === 'noncash' ? 'noncash'
      : external ? 'external'
      : e.kind === 'commitment' ? 'commit'
      : 'out';
    const tie = atomic.has(groupOf[e.id]) ? '<span class="tie" title="Must be paid together, same day">⛓</span>' : '';
    const title = cardPaid
      ? `${e.label} ${money2(Math.abs(e.amount))} — card-paid reserve; reduces projected joint cash`
      : external
      ? `${e.label} ${money2(Math.abs(e.amount))} — household obligation, paid externally, does not reduce joint cash`
      : `${e.label} ${money2(Math.abs(e.amount))}${e.kind === 'noncash' ? ' — capitalised, not paid' : ''}`;
    const body = cardPaid
      ? `−${money(Math.abs(e.amount)).slice(1)} ${est}${tie}${shortLabel(e.label)} — card reserve`
      : external
      ? `${money(Math.abs(e.amount)).slice(1)} ${est}${tie}${shortLabel(e.label)} — external household obligation`
      : `${e.kind === 'noncash' ? '' : e.amount > 0 ? '+' : '−'}${money(Math.abs(e.amount)).slice(1)} ${est}${tie}${shortLabel(e.label)}`;
    return `<span class="cal-ev ${cls}" title="${title}">${body}</span>`;
  };

  // ---- month grids ----
  const months = [];
  for (let m = sim.start.slice(0, 7); m <= sim.end.slice(0, 7);) {
    months.push(m);
    const [y, mo] = m.split('-').map(Number);
    m = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}`;
  }
  $('cal-months').innerHTML = months.map(m => {
    const [y, mo] = m.split('-').map(Number);
    const first = new Date(Date.UTC(y, mo - 1, 1));
    const daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const lead = first.getUTCDay(); // 0 = Sunday
    let cells = '<tr>' + '<td class="dim"></td>'.repeat(lead);
    let col = lead;
    for (let day = 1; day <= daysIn; day++) {
      if (col === 7) { cells += '</tr><tr>'; col = 0; }
      const iso = `${m}-${String(day).padStart(2, '0')}`;
      const inWin = iso >= sim.start && iso <= sim.end;
      const evs = inWin ? (byDate.get(iso) || []) : [];
      const bal = balance.get(iso);
      const below = inWin && bal < sim.buffer;
      const cls = [
        inWin ? '' : 'dim',
        below ? (bal < 0 ? 'neg-day' : 'low-day') : '',
        iso === sim.min.date ? 'min-day' : '',
        iso === sim.start ? 'today' : '',
        iso === neededBy ? 'need-day' : '',
      ].filter(Boolean).join(' ');
      cells += `<td class="${cls}"><div class="cal-n">${day}` +
        (iso === sim.start ? ' <span class="cal-badge">today</span>' : '') +
        (iso === sim.min.date ? ' <span class="cal-badge low">low</span>' : '') +
        (iso === neededBy ? ' <span class="cal-badge need">transfer needed</span>' : '') +
        `</div>${evs.map(evHtml).join('')}` +
        (inWin ? `<div class="cal-bal ${bal < 0 ? 'neg' : ''}">${money(bal)}</div>` : '') +
        '</td>';
      col++;
    }
    cells += '<td class="dim"></td>'.repeat(7 - col) + '</tr>';
    const monthName = first.toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return `<table class="cal"><caption>${monthName}</caption>
      <thead><tr>${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(dn => `<th>${dn}</th>`).join('')}</tr></thead>
      <tbody>${cells}</tbody></table>`;
  }).join('');

  // ---- agenda (mobile) ----
  let agenda = '', lastM = '';
  for (const p of sim.daily) {
    const evs = byDate.get(p.date) || [];
    const special = p.date === sim.min.date || p.date === neededBy;
    if (!evs.length && !special) continue;
    const mName = new Date(p.date + 'T00:00:00').toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
    if (mName !== lastM) { agenda += `<h4 class="cal-ag-month">${mName}</h4>`; lastM = mName; }
    const wd = new Date(p.date + 'T00:00:00').toLocaleDateString('en-CA', { weekday: 'short', day: 'numeric' });
    agenda += `<div class="cal-ag-day ${p.balance < 0 ? 'neg-day' : p.balance < sim.buffer ? 'low-day' : ''}">
      <div class="cal-ag-head"><span>${wd}</span>
        ${p.date === sim.min.date ? '<span class="cal-badge low">low point</span>' : ''}
        ${p.date === neededBy ? '<span class="cal-badge need">transfer needed by now</span>' : ''}
        <span class="cal-ag-bal ${p.balance < 0 ? 'neg' : ''}">${money(p.balance)}</span></div>
      <div class="cal-ag-evs">${evs.map(evHtml).join('')}</div>
    </div>`;
  }
  $('cal-agenda').innerHTML = agenda;
}

/* ------------------------------------------- payday answer, in words */
// Household-readable payday worksheet. Every figure is handed in from an
// existing Forecast authority. Forecast.paydayAllocation (attached on
// recommend) is the payday waterfall; this formats it. It does not
// recommend, sequence, grade, sum a payday budget, or invent a second
// payday plan.

/* Weekly-cap presentation. Forecast.recommend remains the decision:
 * `mode === 'infeasible'` or `funding.feasible === false` means there is no
 * feasible weekly cap. This formats that existing verdict; it does not
 * invent a second feasibility test. */
function liveOperatingPlanUnavailable(advice, liveOverlay) {
  return (advice && advice.operatingPlanUnavailable === true)
    || (liveOverlay && liveOverlay.operatingPlan === 'unavailable')
    // #775: a refresh was attempted and failed before any household date was
    // observed (cold process, provider unavailable). Only the dated opening
    // remains and nothing proves that period is still today's, so it is the
    // last-good dated baseline, never the current operating plan. A same-date
    // or later observed date keeps the incumbent live-plan verdict; an
    // overlay with no failure reason is unchanged.
    || (!!liveOverlay && liveOverlay.applied === false
      && liveOverlay.operatingPlan === 'dated-opening'
      && !liveOverlay.observedAsOf && !liveOverlay.effectiveAsOf
      && typeof liveOverlay.reason === 'string' && liveOverlay.reason.length > 0);
}

function liveOperatingPlanNote(advice, liveOverlay) {
  return (advice && advice.operatingPlanNote)
    || (liveOverlay && liveOverlay.operatingPlanNote)
    || 'Current plan unavailable. The dated opening is stale.';
}

function currentOperatingUnavailableHtml(advice, liveOverlay) {
  if (!liveOperatingPlanUnavailable(advice, liveOverlay)) return null;
  return `<div data-operating-plan="unavailable" data-current-operating="unavailable">
    <p class="operating-lead">${liveOperatingPlanNote(advice, liveOverlay)}</p>
  </div>`;
}

function currentOperatingCashHeroTiles(plan, asOf, sim, advice, liveOverlay) {
  if (liveOperatingPlanUnavailable(advice, liveOverlay)) {
    const note = liveOperatingPlanNote(advice, liveOverlay);
    return [
      { lab: 'Spendable household cash', val: 'unavailable', tone: 'alert', note },
      { lab: 'Next cash-out total', val: 'unavailable', tone: 'alert', note },
    ];
  }
  const nextOut = Forecast.nextPaymentOut(sim && sim.events, asOf);
  return [
    { lab: 'Spendable household cash', val: money(Forecast.startingCashAmount(plan)), tone: 'alert',
      note: 'Chequing A, B and Savings. Amanda’s account is a separate pot.' },
    (nextOut ? { lab: 'Next cash-out total', val: money(nextOut.amount),
      note: `${nextOut.label} on ${fmtDateLong(nextOut.date)} — all cash leaving household accounts that day`,
      tone: nextOut.date <= addDays(asOf, 3) ? 'warn' : '' } : null),
  ].filter(Boolean);
}

function currentOperatingConsumerDebtHeroTile(advice, liveOverlay, today) {
  if (liveOperatingPlanUnavailable(advice, liveOverlay)) {
    return {
      lab: 'Consumer debt',
      val: 'unavailable',
      tone: 'alert',
      note: liveOperatingPlanNote(advice, liveOverlay),
    };
  }
  const overToday = ((today && today.debts) || []).filter(x => x.overLimit);
  return {
    lab: 'Consumer debt',
    val: money(today.consumer),
    tone: overToday.length ? 'alert' : 'warn',
    note: `${money(today.headroom)} of credit left everywhere${overToday.length
      ? ` — ${overToday.length} facility over its limit` : ''}`,
  };
}

function currentOperatingTransferNoteHtml(advice, liveOverlay, transferMonthly, neededBy) {
  if (liveOperatingPlanUnavailable(advice, liveOverlay)) {
    return `<span data-operating-plan="unavailable">${liveOperatingPlanNote(advice, liveOverlay)}</span>`;
  }
  if (transferMonthly > 0) {
    return neededBy
      ? `The plan counts Amanda's Tennis BC salary of <b>${money(transferMonthly)}/month</b> (15th and month-end).
         Without those deposits the balance slips under the buffer on <b>${fmtDateLong(neededBy)}</b> — that is the date her next salary
         has to land by, marked on the calendar below.`
      : `At this spending level the window stays above the buffer <b>even without Amanda's Tennis BC salary</b> —
         her ${money(transferMonthly)}/month (15th and month-end) is counted, but nothing depends on its timing.`;
  }
  return `No Amanda Tennis BC salary is counted in this scenario — the plan stands on the remaining income.`;
}

function weeklyCapView(advice, weeklyOverride) {
  advice = advice || {};
  const recommended = advice.weekly;
  const override = weeklyOverride != null ? weeklyOverride : null;
  const permissionUnavailable = !Number.isFinite(recommended);
  const weekly = permissionUnavailable ? null : override != null ? override : recommended;
  const fail = advice.infeasible;
  const funding = advice.funding || null;
  const fundingBlocked = !!(funding && funding.feasible === false);
  const modeInfeasible = advice.mode === 'infeasible';
  const planUnavailable = advice.operatingPlanUnavailable === true;
  const infeasible = modeInfeasible;
  const hasFeasibleCap = !permissionUnavailable && !planUnavailable && !modeInfeasible && !fundingBlocked;
  let reason = '';
  if (planUnavailable) {
    reason = advice.operatingPlanNote
      || 'Current plan unavailable. The dated opening is stale.';
  } else if (permissionUnavailable && advice.operatingPlanNote) {
    reason = advice.operatingPlanNote;
  } else if (modeInfeasible && fail) {
    // Same fail-closed presentation as the status band and mission: a null /
    // nonfinite shortfall stays explicitly unquantified (never $0.00), a real
    // numeric zero still prints $0.00, and an invalid date prints no clause.
    const failDateOk = (() => {
      if (typeof fail.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fail.date)) return false;
      const [y, m, d] = fail.date.split('-').map(Number);
      const dt = new Date(`${fail.date}T00:00:00`);
      return !Number.isNaN(dt.getTime()) && dt.getFullYear() === y
        && dt.getMonth() === m - 1 && dt.getDate() === d;
    })();
    const failBy = Number.isFinite(fail.shortfall)
      ? ` by ${money2(fail.shortfall)}` : ' by an unquantified amount';
    reason = `There is no feasible weekly cap. ${fail.label || 'A protected constraint'} fails${
      failDateOk ? ` on ${fmtDateLong(fail.date)}` : ''}${failBy}; a weekly spending
          figure does not fix this.`;
  } else if (fundingBlocked) {
    reason = `There is no feasible weekly cap. ${money2(funding.shortfall)} stays unfunded after every usable source.
          No safe-to-spend figure exists until that protected shortfall is solved.`;
  } else if (modeInfeasible) {
    reason = 'There is no safe weekly spend until the protected bills are funded.';
  } else if (permissionUnavailable) {
    reason = advice.currentPeriodAction?.reason || advice.sim?.reason
      || 'Weekly spending permission is unavailable.';
  }
  const settingLine = override != null
    ? `your setting is ${money(override)}/wk — not a supported weekly cap.`
    : '';
  return {
    hasFeasibleCap, infeasible, fundingBlocked, permissionUnavailable,
    weekly, recommended, override, fail,
    shortfall: fundingBlocked ? funding.shortfall : null,
    reason, settingLine,
  };
}

function paydayActionRows(ctx) {
  const alloc = ctx.advice && ctx.advice.paydayAllocation;
  if (!alloc || !Array.isArray(alloc.lines)) return [];
  return alloc.lines
    .filter(line => Number(line.amount) > 0 && line.label)
    .map(line => ({ key: line.key, label: line.label, amount: line.amount }));
}

function paydayOtherActionRows(ctx) {
  return paydayActionRows(ctx).filter(row =>
    row.key !== 'obligations' && row.key !== 'essentials');
}

function paydayReservedIds(alloc) {
  const ids = new Set();
  const datedLabels = new Set();
  for (const item of (alloc && alloc.obligations && alloc.obligations.items) || []) {
    if (item && item.id) ids.add(item.id);
    if (item && item.label && item.date) datedLabels.add(item.label + '@' + item.date);
  }
  return { ids, datedLabels };
}

function paydayComingRows(ctx) {
  const near = (ctx.advice && ctx.advice.nearBoundary) || { items: [] };
  const alloc = ctx.advice && ctx.advice.paydayAllocation;
  const reserved = paydayReservedIds(alloc);
  const rows = [];
  const seen = new Set();
  const add = (key, label, date, amount, id) => {
    if (!label || amount == null || !(Number(amount) > 0)) return;
    if (id && reserved.ids.has(id)) return;
    if (label && date && reserved.datedLabels.has(label + '@' + date)) return;
    if (reserved.ids.has(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ key, label, date, amount });
  };
  for (const item of near.items || []) {
    add(item.id || `${item.label}:${item.date}`, item.label, item.date, item.amount, item.id);
  }
  const nextOut = ctx.nextOut;
  if (nextOut) {
    const already = (near.items || []).some(i =>
      i.date === nextOut.date && i.label === nextOut.label);
    if (!already) {
      add('next-out:' + nextOut.date + ':' + nextOut.label,
        nextOut.label, nextOut.date, nextOut.amount, nextOut.id);
    }
  }
  rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return rows.slice(0, 5);
}

function paydaySheet(headers, rowClass, rows, cell) {
  if (!rows.length) return '';
  const head = headers
    ? `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>`
    : '';
  return `<table class="payday-sheet">${head}
    <tbody>${rows.map(r => `<tr class="${rowClass}">${cell(r)}</tr>`).join('')}</tbody>
  </table>`;
}

function paydayCashNote(alloc, liveOverlay) {
  const asOf = alloc && (alloc.cashBasis && alloc.cashBasis.asOf || alloc.asOf);
  if (!asOf) return 'Spendable cash. Not credit.';
  const basis = alloc.cashBasis || {};
  const overlayOn = !!(liveOverlay && liveOverlay.applied === true);
  let source;
  if (overlayOn && basis.liveAdvanced && basis.priorAsOf) {
    source = `live overlay from the ${fmtDate(basis.priorAsOf)} opening`;
  } else if (overlayOn) {
    source = 'live Lunch Money overlay';
  } else {
    source = 'dated opening';
  }
  let note = `Spendable cash. Not credit. As at ${fmtDate(asOf)} — ${source}.`;
  if (liveOverlay && liveOverlay.operatingPlan === 'unavailable') {
    note += ' ' + (liveOverlay.operatingPlanNote
      || 'Current plan unavailable. The dated opening is stale.');
  } else if (liveOverlay && liveOverlay.applied === false) {
    note += ' Live overlay not applied.';
  }
  return note;
}

function paydayGlanceCashNote(alloc, liveOverlay) {
  const asOf = alloc && (alloc.cashBasis && alloc.cashBasis.asOf || alloc.asOf);
  return glanceUpdatedNote(asOf, liveOverlay);
}

function providerBalanceDate(liveOverlay) {
  const overlayTrusted = !!(liveOverlay && liveOverlay.applied === true
    && liveOverlay.operatingPlan !== 'unavailable');
  if (!overlayTrusted) return null;
  const dates = [];
  const accounts = liveOverlay.observedCash && liveOverlay.observedCash.accounts;
  if (Array.isArray(accounts)) {
    for (const row of accounts) {
      const d = row && (row.evidenceDate || row.observedAsOf);
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(String(d))) dates.push(String(d));
    }
  }
  const unique = [];
  for (const d of dates) {
    if (unique.indexOf(d) === -1) unique.push(d);
  }
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) return null;
  const overlayDate = liveOverlay.observedAsOf;
  if (overlayDate && /^\d{4}-\d{2}-\d{2}$/.test(String(overlayDate))) {
    return String(overlayDate);
  }
  return null;
}

function glanceUpdatedNote(asOf, liveOverlay) {
  const providerDate = providerBalanceDate(liveOverlay);
  const dated = liveOverlay && liveOverlay.balanceDating
    && liveOverlay.balanceDating.status === 'dated-latest-sync';
  if (providerDate && dated) {
    return `Latest bank sync balance. Not credit. As of ${fmtDateLong(providerDate)}; next bank sync pending.`;
  }
  if (providerDate) {
    return `Current Balance. Not credit. As of ${fmtDateLong(providerDate)}.`;
  }
  const overlayTrusted = !!(liveOverlay && liveOverlay.applied === true
    && liveOverlay.operatingPlan !== 'unavailable');
  // A trusted overlay with no unique provider cash-observation date must not
  // borrow the Forecast/as-of stamp. That would date an ambiguous balance.
  if (overlayTrusted || !asOf) return 'Current Balance. Not credit.';
  return `Current Balance. Not credit. Updated ${fmtDate(asOf)}.`;
}

function paydayObligationNote(item, asOf) {
  if (!item) return '';
  const when = item.date ? fmtDate(item.date) : '';
  const dateTrust = item.dateConfidence === 'estimated' ? ' · estimated' : '';
  const reserved = item.allocated != null
    && Number(item.allocated) > 0
    && Math.abs(Number(item.allocated) - Number(item.amount)) <= 0.02;
  if (item.settlement === 'unverified') {
    const opening = asOf ? ` on the ${fmtDate(asOf)} opening` : '';
    const reserveClause = reserved
      ? ' Reserved until current evidence confirms posting.'
      : '';
    return `${when ? when + dateTrust + ' · ' : ''}settlement unverified${opening}.${reserveClause}`;
  }
  if (item.date) return `Due ${fmtDate(item.date)}${dateTrust}.`;
  return '';
}

function paydayCoverageNote(action) {
  if (!action || !action.coverage) {
    return 'Transaction actuals were not supplied. Current remaining spend cannot be confirmed.';
  }
  const cov = action.coverage;
  const through = cov.coverageThrough ? fmtDate(cov.coverageThrough) : null;
  if (cov.remainingClaim === 'unavailable') {
    if (cov.status === 'stale' && through) {
      return `Transaction actuals only through ${through} — current remaining amounts unavailable.`;
    }
    if (cov.status === 'incomplete' && cov.coverageStart) {
      return `Transaction coverage starts ${fmtDate(cov.coverageStart)} — current remaining amounts unavailable.`;
    }
    if (cov.status === 'absent') {
      return 'Transaction actuals were not supplied. Current remaining spend cannot be confirmed.';
    }
    return cov.reason || 'Current remaining spend cannot be confirmed.';
  }
  const classifiedIncomplete = action.categoryRemainingClaim === 'classified-incomplete';
  if (cov.remainingClaim === 'posted-only') {
    const pendingNote = through
      ? `Posted and observed pending through ${through}. Pending coverage is not complete, so additional unknown pending may exist.`
      : 'Observed pending still constrains remaining. Pending coverage is not complete, so additional unknown pending may exist.';
    return classifiedIncomplete
      ? pendingNote.replace(/\.$/, '')
        + '. Category allocation incomplete — remaining shown with uncategorised spending outstanding.'
      : pendingNote;
  }
  if (classifiedIncomplete) {
    return through
      ? `Transaction coverage complete through ${through}. Category allocation incomplete — remaining shown with uncategorised spending outstanding.`
      : 'Transaction coverage complete; category allocation incomplete. Remaining shown with uncategorised spending outstanding.';
  }
  return through
    ? `Actual spending through ${through}.`
    : 'Actual spending is current through this as-of.';
}

function paydayBillStatusNote(item) {
  if (!item) return '';
  const dateTrust = item.dateConfidence === 'estimated' ? ' · estimated' : '';
  if (item.settlement === 'represented') {
    return item.date ? `Paid ${fmtDate(item.date)}${dateTrust}.` : 'Paid.';
  }
  if (item.settlement === 'unverified') {
    const when = item.date ? fmtDate(item.date) + dateTrust + ' · ' : '';
    return `${when}settlement not proven. Reserved until current evidence confirms posting.`;
  }
  if (item.date) return `Due ${fmtDate(item.date)}${dateTrust}.`;
  return '';
}

function applyPaydayHeading(action) {
  const kicker = $('payday-kicker');
  const heading = $('payday-heading');
  if (!kicker || !heading) return;
  if (action && action.mode === 'between-paydays') {
    kicker.textContent = 'Between paydays';
    heading.textContent = 'Between paydays';
    return;
  }
  kicker.textContent = 'Payday plan';
  heading.textContent = 'Payday plan';
}

const OPERATING_SURFACE_LEDE = 'Live Current Balance, then this payday’s income, bills and household budget.';

function applyUnavailableOperatingChrome(unavailable, asOf, liveOverlay, doc) {
  doc = doc || (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.getElementById !== 'function') return;
  const surface = doc.getElementById('operating-surface');
  // The active v3 header owns the selected published date range. Legacy
  // operating chrome must not relabel it as This payday after rendering.
  if (surface && typeof surface.querySelector === 'function'
    && surface.querySelector('[data-budget-window-header]')) return;
  const openingAsOf = (liveOverlay && liveOverlay.historicalOpeningAsOf) || asOf || null;
  if (surface && typeof surface.querySelector === 'function') {
    const kicker = surface.querySelector('.kicker');
    const heading = surface.querySelector('h1');
    const lede = surface.querySelector('.lede');
    if (unavailable) {
      if (kicker) kicker.textContent = 'Current plan unavailable';
      if (heading) heading.textContent = 'Current plan unavailable';
      if (lede) {
        let text = liveOperatingPlanNote(null, liveOverlay);
        if (openingAsOf) {
          text += ` Last trusted financial opening is ${fmtDateLong(openingAsOf)}.`;
        }
        if (liveOverlay && liveOverlay.applied === false) {
          text += ' A later live refresh could not safely advance the operating plan.';
        }
        lede.textContent = text;
      }
    } else {
      if (kicker) kicker.textContent = 'This payday';
      if (heading) heading.textContent = 'This payday';
      if (lede) lede.textContent = OPERATING_SURFACE_LEDE;
    }
  }
}

function paydayAmountCell(amount, confidence) {
  const value = amount != null ? money2(amount) : '—';
  if (confidence === 'estimated') return `<span class="est">${value}</span>`;
  return value;
}

const PAYDAY_ACTION_KIND = {
  obligations: 'Bills',
  essentials: 'Essentials',
  'future-path': 'Future cash',
  'future-cost': 'Future cost',
  'extra-debt': 'Debt',
  optional: 'Optional',
};

function paydayAllocationTrustNote(line, alloc) {
  const notes = ['Calculated by Forecast.paydayAllocation.'];
  if (line && line.kind === 'obligations') {
    const obligations = (alloc && alloc.obligations) || {};
    const items = obligations.items || [];
    const uncertain = items
      .filter(item => item && item.confidence && item.confidence !== 'confirmed')
      .map(item => `${item.label} · ${item.confidence}`);
    if (uncertain.length) notes.push(`Input trust retained: ${uncertain.join('; ')}.`);
    const unverified = items
      .filter(item => item && item.settlement === 'unverified')
      .map(item => item.label);
    if (unverified.length) notes.push(`Settlement unverified: ${unverified.join('; ')}.`);
    if (obligations.fundingAttribution === 'unattributed') {
      notes.push('This is an unattributed reserve pool; no individual bill priority is implied.');
    }
  }
  if (line && line.kind === 'essentials' && alloc && alloc.essentials
      && alloc.essentials.fundingAttribution === 'unattributed') {
    notes.push('This is an unattributed essential-spending hold; no category-level funding claim is implied.');
  }
  if (line && line.kind === 'future-cost' && line.confidence && line.confidence !== 'confirmed') {
    notes.push(`Input trust retained: ${line.confidence}.`);
  }
  return notes.join(' ');
}

/* Ordered action sheet for the default operating surface. Forecast has already
 * selected, ordered and totalled every allocation line. This function prints
 * those fields and the engine's reconciliation identity; it does not allocate,
 * sum, choose a debt target, or infer that any money movement occurred. */
function paydayAllocationSheetHtml(alloc) {
  if (!alloc || !Array.isArray(alloc.lines)) {
    return `<div class="allocation-unavailable">
      <p class="operating-lead">Payday allocation unavailable.</p>
      <p class="operating-note">No payment, transfer, debt action or other money movement is implied.</p>
    </div>`;
  }

  // Prepare Ahead reprints Forecast.paydayAllocation.protectedPath.allocated
  // only when status is calculated. wanted / movable are not household
  // reprint. Unknown, missing, or unavailable status fail closed — including
  // a leftover future-path line after withholdCurrentOperatingClaims.
  const path = alloc.protectedPath;
  const pathCalculated = !!(path
    && path.status === 'calculated'
    && path.allocated != null
    && Number.isFinite(Number(path.allocated)));
  const pathUnavailable = !pathCalculated;
  const pathAllocated = pathCalculated ? path.allocated : null;
  const pathHold = pathAllocated != null && Number(pathAllocated) > 0;
  const protectedLine = pathHold
    && alloc.lines.find(line => line && line.kind === 'future-path');

  const lines = alloc.lines.map((line, index) => {
    if (line && line.kind === 'future-path' && !protectedLine) return '';
    const amount = line && line.kind === 'future-path' ? pathAllocated : line.amount;
    return `
    <div class="allocation-line" data-allocation-key="${line.key}" data-allocation-order="${index + 1}">
      <div class="allocation-step">${index + 1}</div>
      <div class="allocation-copy">
        <div class="allocation-label"><span class="allocation-action">${PAYDAY_ACTION_KIND[line.kind] || 'Allocate'}</span>${line.label}${line.date ? ` <span class="payday-when${(line.dateConfidence || line.confidence) && (line.dateConfidence || line.confidence) !== 'confirmed' ? ' est' : ''}">${fmtDate(line.date)}${(line.dateConfidence || line.confidence) && (line.dateConfidence || line.confidence) !== 'confirmed' ? ` · ${line.dateConfidence || line.confidence}` : ''}</span>` : ''}</div>
        <div class="allocation-trust">${paydayAllocationTrustNote(line, alloc)}</div>
      </div>
      <div class="allocation-value">${money2(amount)}</div>
    </div>`;
  }).join('');

  const futureZero = (alloc.futureCosts || [])
    .filter(row => row && row.allocated != null && Number(row.allocated) === 0)
    .map(row => `<div class="allocation-state" data-allocation-state="future:${row.id}">
      <span><b>Set aside — ${row.label}</b>${row.date ? ` by ${fmtDate(row.date)}${row.confidence && row.confidence !== 'confirmed' ? ` · ${row.confidence}` : ''}` : (row.confidence && row.confidence !== 'confirmed' ? ` · ${row.confidence}` : '')}<small>${row.reason || row.verdict || ''}</small></span>
      <span>${money2(row.allocated)}</span>
    </div>`).join('');

  const unresolved = (alloc.unresolved || []).map(row => `
    <li data-allocation-unresolved="${row.id}"><b>${row.label}</b> — unresolved; no payday allocation${row.confidence && row.confidence !== 'confirmed' ? ` · ${row.confidence}` : ''}.
      <span>${row.reason}</span></li>`).join('');

  const protectedState = protectedLine ? '' : `<div class="allocation-state" data-allocation-state="untouched">
    <span><b>Leave untouched for the future cash path</b><small>${pathUnavailable
      ? (path && path.floor && path.floor.trust === 'calculated' && Number(path.floor.amount) > 0
        ? 'At least this much is held for pending debits; the rest of the hold is unknown until transactions catch up.'
        : 'Unavailable; no future-path cash hold is instructed.')
      : 'Forecast requires no separate future-path cash hold on this opening.'}</small></span>
    <span>${pathAllocated != null ? money2(pathAllocated)
      : (pathUnavailable && path && path.floor && path.floor.trust === 'calculated' && Number(path.floor.amount) > 0
        ? `At least ${money2(path.floor.amount)}` : '—')}</span>
  </div>`;

  const extraLine = alloc.lines.find(line => line && line.kind === 'extra-debt');
  const extraAmount = alloc.extraDebt && alloc.extraDebt.allocated != null
    ? alloc.extraDebt.allocated : null;
  const extraState = extraLine ? '' : `<div class="allocation-state" data-allocation-state="extra-debt">
    <span><b>Extra debt allocation</b><small>${extraAmount == null
      ? 'Unavailable; no debt action is instructed.'
      : 'No extra debt payment is allocated on this opening.'}</small></span>
    <span>${extraAmount != null ? money2(extraAmount) : '—'}</span>
  </div>`;

  const remainder = alloc.remainder != null ? alloc.remainder : alloc.unallocated;
  const remainderLabel = (alloc.unresolved || []).length
    ? 'Unallocated remainder · keep unassigned'
    : 'Unallocated / optional remainder';

  return `<div class="allocation-sheet">
    <div class="allocation-available">
      <span>Money available</span>
      <b data-allocation-available>${money2(alloc.available)}</b>
    </div>
    <p class="operating-note">Spendable cash only. Credit and unapproved borrowing are excluded.</p>
    <div class="allocation-list">${lines || `<p class="allocation-empty">No allocation lines. Forecast allocated ${money2(alloc.allocatedTotal)}; no movement is implied.</p>`}</div>
    ${futureZero}${protectedState}${extraState}
    <div class="allocation-remainder" data-allocation-remainder>
      <span>${remainderLabel}</span><b>${remainder != null ? money2(remainder) : '—'}</b>
    </div>
    <div class="allocation-reconcile" data-allocation-reconcile>
      <span>Forecast reconciliation</span>
      <span>${money2(alloc.allocatedTotal)} allocated + ${remainder != null ? money2(remainder) : '—'} remainder = ${money2(alloc.available)} available resources</span>
    </div>
    ${unresolved ? `<details class="allocation-unresolved"><summary>${alloc.unresolved.length} future cost${alloc.unresolved.length === 1 ? '' : 's'} unresolved</summary><ul>${unresolved}</ul></details>` : ''}
    <p class="allocation-safety">Actionable does not mean executed. This sheet records Forecast allocations only; it does not prove or initiate a payment, transfer or card action.</p>
  </div>`;
}

function currentPeriodConfidence(row) {
  return row && row.confidence && row.confidence !== 'confirmed'
    ? ` · ${row.confidence}`
    : '';
}

function currentPeriodBillGroup(title, state, rows) {
  const list = rows || [];
  const body = list.length
    ? list.map(row => {
      const actual = row.actual != null
        ? `<span>Observed ${money2(row.actual)}</span>`
        : '<span>Observed amount unavailable</span>';
      let amount;
      if (state === 'represented') {
        amount = `${actual}<span${row.confidence === 'estimated' ? ' class="est"' : ''}>Plan ${
          row.planned != null ? money2(row.planned) : '—'
        }${currentPeriodConfidence(row)}</span>`;
      } else if (state === 'unverified') {
        amount = `<span${row.confidence === 'estimated' ? ' class="est"' : ''}>Reserved ${
          row.remaining != null ? money2(row.remaining) : '—'
        }${currentPeriodConfidence(row)}</span>`;
      } else if (state === 'upcoming') {
        amount = `<span${row.confidence === 'estimated' ? ' class="est"' : ''}>Due ${
          row.remaining != null ? money2(row.remaining) : '—'
        }${currentPeriodConfidence(row)}</span>`;
      } else {
        amount = '<span>Amount unavailable</span>';
      }
      const status = state === 'represented'
        ? 'Forecast says this occurrence is represented / handled.'
        : state === 'unverified'
          ? 'Settlement unverified. This is not a claim that the bill is unpaid.'
          : state === 'upcoming'
            ? 'Forecast says this item is still due in the current period.'
            : 'Forecast returned an unresolved settlement state; no handled or due claim is made.';
      return `<div class="current-period-row" data-current-bill-id="${row.id}" data-current-bill-state="${state}">
        <div><b>${row.label}</b><span>${row.date ? fmtDate(row.date) : 'Date unavailable'} · ${status}</span></div>
        <div class="current-period-values">${amount}</div>
      </div>`;
    }).join('')
    : `<p class="current-period-empty">None reported by Forecast.currentPeriodAction.</p>`;
  return `<div class="current-period-block" data-current-bill-group="${state}">
    <h3>${title}</h3>${body}
  </div>`;
}

/* Daily operating renderer. Every bill state, category amount, permission,
 * decision date and limitation is a field on Forecast.currentPeriodAction.
 * This groups and labels those fields; it does not settle a bill, classify a
 * transaction, calculate remaining spend, or call another planning authority. */
function betweenPaydaysOperatingHtml(action, capView) {
  if (!action || action.mode !== 'between-paydays') {
    return `<div class="current-period-unavailable">
      <p class="operating-lead">Between-paydays action unavailable.</p>
      <p class="operating-note">No bill, spending or money-movement state is inferred.</p>
    </div>`;
  }

  const bills = Array.isArray(action.bills) ? action.bills : [];
  const represented = bills.filter(row => row && row.settlement === 'represented');
  const upcoming = bills.filter(row => row && row.settlement === 'upcoming');
  const unverified = bills.filter(row => row && row.settlement === 'unverified');
  const unresolved = bills.filter(row => row && !['represented', 'upcoming', 'unverified'].includes(row.settlement));
  const coverage = paydayCoverageNote(action);
  const coverageUnavailable = action.remainingClaim === 'unavailable';
  const postedOnly = action.remainingClaim === 'posted-only';
  const classificationIncomplete = action.categoryRemainingClaim === 'classified-incomplete';
  const categories = coverageUnavailable
    ? []
    : (action.categories || []).filter(row => row && row.committed != null);
  const remainingHeading = classificationIncomplete
    ? 'Remaining'
    : postedOnly ? 'Observed remaining' : 'Remaining';
  const categoryRows = categories.length
    ? categories.map(row => {
      const remaining = classificationIncomplete
        ? '<span class="current-period-withheld">Not precise</span>'
        : row.remaining != null ? money2(row.remaining) : 'Unavailable';
      const pending = Number(row.pending) > 0
        ? `<span>Includes observed pending ${money2(row.pending)}</span>`
        : '';
      return `<div class="current-period-category" data-current-category-id="${row.id}">
        <div><b>${row.label}</b>${pending}</div>
        <span data-current-category-used>${money2(row.committed)}</span>
        <span data-current-category-remaining>${remaining}</span>
      </div>`;
    }).join('')
    : '';
  const categoryState = coverageUnavailable
    ? `<p class="current-period-withheld">Exact category used and remaining amounts are unavailable. ${coverage}</p>`
    : classificationIncomplete
      ? `<p class="current-period-withheld">Named-category remaining is not precise while household spending is classification-incomplete. Used amounts remain observed; remaining amounts are withheld.</p>`
      : postedOnly
        ? `<p class="current-period-withheld">Remaining is based on posted and observed pending only. Additional unknown pending may exist.</p>`
        : '<p class="operating-note">Used and remaining values come directly from Forecast.currentPeriodAction.</p>';
  const unclassified = action.unclassified && Number(action.unclassified.count) > 0
    ? `<p class="current-period-withheld">${action.unclassified.count} household-spend transaction${
        action.unclassified.count === 1 ? '' : 's'
      } remain unclassified. Posted ${money2(action.unclassified.posted)}; pending ${money2(action.unclassified.pending)}.</p>`
    : '';
  const categoryTable = categoryRows
    ? `<div class="current-period-category-head"><span>Category</span><span>Used</span><span>${remainingHeading}</span></div>${categoryRows}`
    : '';
  const permission = capView && !capView.hasFeasibleCap
    ? `<p class="payday-refuse">${capView.infeasible ? '<b>INFEASIBLE. </b>' : ''}${capView.reason}</p>`
    : action.weeklyCap != null
      ? `<span class="operating-amount" data-current-weekly-permission>${money(action.weeklyCap)} / week</span>`
      : '<p class="current-period-withheld">Weekly spending permission unavailable.</p>';
  const movement = action.noMovementToday
    ? '<p class="operating-lead">No money movement is required today.</p>'
    : (action.todayActions || []).length
      ? `<div class="current-period-block"><h3>Do today</h3>${action.todayActions.map(row => `
          <div class="current-period-row" data-current-today-action="${row.id}">
            <div><b>${row.label}</b><span>${row.date ? fmtDate(row.date) : 'Date unavailable'} · Forecast current-day action.</span></div>
            <div class="current-period-values"><span${row.confidence === 'estimated' ? ' class="est"' : ''}>${
              row.amount != null ? money2(row.amount) : '—'
            }${currentPeriodConfidence(row)}</span></div>
          </div>`).join('')}</div>`
      : '<p class="current-period-withheld">Current-day action state unavailable; no movement is inferred.</p>';
  const shortfall = action.currentShortfall
    ? '<p class="operating-limit warn">Forecast reports a current-period constraint. The amounts below are not a promise that the period is fully funded.</p>'
    : '';
  const decision = action.nextPayday
    ? `<div class="current-period-quick-item"><span>Next decision point</span><b data-current-next-payday>${fmtDateLong(action.nextPayday)} payday</b></div>`
    : '<p class="current-period-withheld">Next payday / decision date unavailable.</p>';
  const periodRange = action.periodStart && action.periodEnd
    ? `${fmtDateLong(action.periodStart)} → ${fmtDateLong(action.periodEnd)}`
    : 'Current pay-period range unavailable';

  return `<div class="current-period-card" data-current-period-action>
    <div class="current-period-meta">
      <span>Current pay period</span>
      <b data-current-period-range>${periodRange}</b>
    </div>
    <div class="current-period-quick">
      <div class="current-period-quick-item"><span>Weekly permission</span>${permission}</div>
      ${decision}
    </div>
    <p class="operating-limit${coverageUnavailable || postedOnly || classificationIncomplete ? ' warn' : ''}" data-current-period-coverage>${coverage}</p>
    ${shortfall}${movement}
    ${currentPeriodBillGroup('Handled / represented', 'represented', represented)}
    ${currentPeriodBillGroup('Still due', 'upcoming', upcoming)}
    ${currentPeriodBillGroup('Settlement unverified', 'unverified', unverified)}
    ${unresolved.length ? currentPeriodBillGroup('Status unresolved', 'unknown', unresolved) : ''}
    <div class="current-period-block" data-current-category-block>
      <h3>Category spending this period</h3>${categoryState}${categoryTable}${unclassified}
    </div>
    <p class="allocation-safety">Forecast evidence may say an occurrence is represented; this view does not infer or initiate a payment, transfer or card action.</p>
  </div>`;
}

/* Compact future-cost publication. Forecast.majorPlans owns every verdict,
 * requirement, range, timing qualifier, remaining amount and flexibility.
 * The matching Forecast.paydayAllocation row owns any current-payday set-aside.
 * This page only formats those outputs; it does not read plan.commitments,
 * rank costs, compare dollars, or decide whether an item is funded. Optional
 * rows stay a residual group because Forecast already marked them optional. */
const FUTURE_PLAN_VERDICT = {
  'ON TRACK': { cls: 'on-track', chip: 'v', remaining: 'Covered in the plan', remainingOpen: 'Still unfunded in the plan' },
  'AT RISK': { cls: 'at-risk', chip: 'w', remaining: 'At-risk amount' },
  'FUNDING GAP': { cls: 'funding-gap', chip: 'c', remaining: 'Funding gap' },
};
const FUTURE_PLAN_FLEXIBILITY = {
  required: 'REQUIRED',
  'bounded-flex': 'FLEXIBLE',
  optional: 'OPTIONAL',
};

function futureCostNeedsAttention(row, payday) {
  if (!row || row.flexibility === 'optional') return false;
  if (row.verdict === 'AT RISK' || row.verdict === 'FUNDING GAP') return true;
  return !!(payday && Number(payday.allocated) > 0);
}

function futurePlanRemainingLabel(row, state) {
  if (row && row.verdict === 'ON TRACK' && Number(row.remaining) > 0) {
    return state.remainingOpen || state.remaining;
  }
  return state.remaining;
}

function futurePlanMeaning(row, payday, timingUnresolved) {
  const bits = [];
  if (row && row.verdict === 'ON TRACK' && (!payday || !(Number(payday.allocated) > 0))) {
    bits.push('No set-aside this payday. Still required. Forecast expects later cash to cover it.');
  } else if (row && row.verdict === 'AT RISK') {
    bits.push('The base plan still holds, but the high end of this cost is not covered.');
  } else if (row && row.verdict === 'FUNDING GAP') {
    bits.push('Forecast cannot fully cover this cost on the current path.');
  }
  if (timingUnresolved) bits.push('Exact date is not set yet, so this payday assigns no contribution.');
  return bits.join(' ');
}

function futurePlanRequirement(row) {
  if (row.need != null) return { amount: money2(row.need), label: 'Cost still required' };
  if (row.amountMin != null && row.amountMax != null) {
    return { amount: `${money2(row.amountMin)}–${money2(row.amountMax)}`, label: 'Cost range' };
  }
  if (row.amountMin != null) return { amount: `From ${money2(row.amountMin)}`, label: 'Cost range' };
  if (row.amountMax != null) return { amount: `Up to ${money2(row.amountMax)}`, label: 'Cost range' };
  return { amount: 'Unresolved', label: 'Cost amount' };
}

function futurePlanTiming(row) {
  if (row.when) return row.when;
  if (row.date) return fmtDateLong(row.date);
  return 'Timing unresolved';
}

function futurePlanCardHtml(row, payday, timingUnresolved) {
  const state = FUTURE_PLAN_VERDICT[row.verdict] || { cls: '', chip: 'e', remaining: 'Forecast remaining' };
  const requirement = futurePlanRequirement(row);
  const confidence = row.confidence || 'unknown';
  const confidenceClass = confidence === 'confirmed' ? 'v' : confidence === 'estimated' ? 'w' : 'e';
  const flexibility = FUTURE_PLAN_FLEXIBILITY[row.flexibility] || String(row.flexibility || 'UNRESOLVED').toUpperCase();
  const paydayFact = payday && Number(payday.allocated) > 0
    ? `<div><b>${money2(payday.allocated)}</b><small>Set aside this payday</small></div>`
    : timingUnresolved
      ? '<div><b>Not assigned</b><small>Exact date not set</small></div>'
      : '';
  const meaning = futurePlanMeaning(row, payday, timingUnresolved);
  const paydayNote = !payday ? ''
    : row.flexibility === 'optional'
      ? '<p>Allocated is not evidence that a payment or transfer occurred.</p>'
      : '<p>Protected / allocated is not evidence that a payment or transfer occurred.</p>';
  return `<div class="future-gravity-row ${state.cls}" data-future-gravity-id="${row.id}">
      <div class="future-gravity-head">
        <b>${row.label}</b>
        <span class="chip ${state.chip}"${row.verdictTrust === 'estimated' && row.estimateReason ? ` title="${String(row.estimateReason).replace(/"/g, '&quot;')}"` : ''}>${row.verdict ? (row.verdictTrust === 'estimated' ? `\u2248 ${row.verdict} (estimate)` : row.verdict) : 'VERDICT UNAVAILABLE'}</span>
      </div>
      <div class="future-gravity-facts">
        <div><b>${requirement.amount}</b><small>${requirement.label}</small></div>
        <div><b>${money2(row.remaining)}</b><small>${futurePlanRemainingLabel(row, state)}</small></div>
        ${paydayFact}
      </div>
      <div class="future-gravity-meta">
        <span>${futurePlanTiming(row)}</span>
        <span class="chip ${confidenceClass}">${confidence.toUpperCase()}</span>
        <span class="chip e">${flexibility}</span>
        ${timingUnresolved ? '<span class="chip w">EXACT DATE UNRESOLVED</span>' : ''}
      </div>
      ${meaning ? `<p class="future-gravity-meaning">${meaning}</p>` : ''}
      ${paydayNote}
    </div>`;
}

function futureGravityHtml(advice) {
  advice = advice || {};
  const plans = Array.isArray(advice.majorPlans) ? advice.majorPlans : [];
  const alloc = advice.paydayAllocation || {};
  const paydayCosts = Array.isArray(alloc.futureCosts) ? alloc.futureCosts : [];
  const paydayOptional = Array.isArray(alloc.optional) ? alloc.optional : [];
  const unresolved = Array.isArray(alloc.unresolved) ? alloc.unresolved : [];
  if (!plans.length) {
    return '<p class="operating-lead">No later bills or big purchases are on this payday.</p>';
  }

  const attentionItems = [];
  const shapingCards = [];
  const residualCards = [];
  for (const row of plans) {
    const payday = paydayCosts.find(item => item.id === row.id)
      || paydayOptional.find(item => item.id === row.id) || null;
    const timingUnresolved = unresolved.find(item => item.id === row.id) || null;
    const card = futurePlanCardHtml(row, payday, timingUnresolved);
    if (row.flexibility === 'optional') {
      residualCards.push(card);
      continue;
    }
    shapingCards.push(card);
    if (futureCostNeedsAttention(row, payday)) attentionItems.push({ row, payday, timingUnresolved });
  }

  const attention = attentionItems.length
    ? `<div class="future-gravity-heading">Needs attention now</div>
      <div class="future-gravity-attention" data-future-gravity-attention>${attentionItems.map(item => {
        const requirement = futurePlanRequirement(item.row);
        const allocated = item.payday ? money2(item.payday.allocated) : (item.timingUnresolved ? 'Not assigned' : '—');
        return `<div class="operating-line" data-future-gravity-id="${item.row.id}" data-future-gravity-compact="attention">
          <span><b>${item.row.label}</b> · ${item.row.verdict ? (item.row.verdictTrust === 'estimated' ? `\u2248 ${item.row.verdict} (estimate)` : item.row.verdict) : 'VERDICT UNAVAILABLE'} · ${futurePlanTiming(item.row)}</span>
          <span>${requirement.amount} still required · ${allocated} this payday</span>
        </div>`;
      }).join('')}</div>`
    : '';
  const shaping = shapingCards.length
    ? `<div class="future-gravity-heading">Future costs shaping today</div><div class="future-gravity" data-future-gravity-shaping>${shapingCards.join('')}</div>`
    : '';
  const residual = residualCards.length
    ? `<div class="future-gravity-optional"><div class="future-gravity-heading">Optional residual — does not constrain today's safe-to-spend</div><div class="future-gravity" data-future-gravity-optional>${residualCards.join('')}</div></div>`
    : '';
  const horizon = advice.knowledge && advice.knowledge.days != null
    ? `<p class="future-gravity-note">Later bills across the ${advice.knowledge.days}-day plan, including costs beyond the next few months.</p>`
    : '';
  const inventory = `${shaping}${residual}${horizon}`;
  return `${attention}${inventory}`;
}

function operatingDebtAnswerHtml(alloc) {
  if (!alloc) return '<p class="operating-lead">No debt allocation answer is available on this opening.</p>';
  const required = alloc.requiredDebtPayments || { items: [] };
  const extra = alloc.extraDebt || {};
  const requiredRows = (required.items || []).map(row => {
    const confidence = (row.dateConfidence || row.confidence) === 'estimated' ? ' · estimated' : '';
    const settlement = row.settlement === 'unverified'
      ? ' · unverified'
      : row.settlement === 'upcoming' ? ' · upcoming' : '';
    const when = row.date ? ` · ${fmtDate(row.date)}` : '';
    return `<div class="operating-line"><span>${row.label}${when}${confidence}${settlement}</span><span>${money2(row.amount)}</span></div>`;
  }).join('');
  const requiredAnswer = requiredRows
    ? `<div class="operating-lines">${requiredRows}</div>`
    : '<p class="operating-note">No required debt payment is due in this period.</p>';

  const allocated = extra.allocated;
  const target = extra.target || null;
  let surplusAnswer;
  if (allocated != null && Number(allocated) > 0 && target) {
    surplusAnswer = `<p class="operating-lead">Extra debt money this payday goes to ${target.label}.</p>`;
  } else if (allocated != null && Number(allocated) === 0) {
    surplusAnswer = '<p class="operating-lead">No extra debt payment this payday.</p>';
  } else {
    surplusAnswer = '<p class="operating-lead">Atlas can’t name an extra debt payment on this opening.</p>';
  }
  const amount = allocated != null
    ? `<span class="operating-amount">${money2(allocated)} extra principal allocated this payday</span>`
    : '';
  const targetAnswer = target
    ? `<p><b>Debt target:</b> ${target.label}${target.confidence === 'estimated' ? ' · estimated' : ''}.</p>`
    : `<p><b>Debt target:</b> unavailable.</p>
       <p class="operating-note">${extra.reason || 'Forecast has no authorized target on this opening.'}</p>`;
  const consequence = extra.consequence && extra.consequence.kind === 'next-target'
    ? `<p><b>After that:</b> If ${extra.consequence.target.label} is cleared, extra money would next go to ${extra.consequence.nextTarget.label}.</p>`
    : '<p><b>After that:</b> Forecast names no further debt target on this opening.</p>';

  return `<h3>Required payments</h3>
    ${requiredAnswer}
    <h3>Extra this payday</h3>
    ${surplusAnswer}${amount}
    ${targetAnswer}${consequence}
    <details class="household-inline-details">
      <summary>Debt details</summary>
      <p class="operating-note">Required rows are contractual or modeled obligations from Forecast, not extra principal and not proof of payment.</p>
      <p class="operating-note">Only true surplus allocated by Forecast.paydayAllocation appears as extra principal. A target or allocation is not proof that a payment occurred.</p>
      ${target
        ? '<p class="operating-note">Forecast named this target from owner-stated policy and current debt facts.</p>'
        : ''}
    </details>`;
}

const REFRESH_TRUST_STATE = {
  current: 'Current',
  'partially-current': 'Partially current',
  'attention-needed': 'Attention needed',
  'dated-latest-update': 'Latest update',
};

/* Household refresh-trust strip. Every verdict is a field on the incumbent
 * refresh-trust packet copied from observation, reconciliation, canonical
 * preview, overlay, and Forecast remaining-claim. This formats those fields
 * only: it does not invent freshness, settle a bill, or ask a new owner
 * question. */
function refreshTrustHtml(trust) {
  if (!trust || !trust.displayState) return '';
  const state = REFRESH_TRUST_STATE[trust.displayState] || 'Attention needed';
  const tone = trust.displayState === 'attention-needed' || trust.exactFiguresAvailable === false
    ? ' warn'
    : (trust.displayState === 'partially-current' ? ' caution' : '');
  const observed = trust.observedAsOf ? fmtDateLong(trust.observedAsOf) : null;
  const reconciled = trust.reconciledAsOf ? fmtDateLong(trust.reconciledAsOf) : null;
  let asOfLine = 'When this was last updated is unknown.';
  const dating = trust.displayState === 'dated-latest-update' && trust.balanceDating
    && trust.balanceDating.balanceAsOf ? trust.balanceDating : null;
  if (dating) {
    // Owner decision 2026-11-07: informational, never an error, and never
    // presented as today's balance.
    asOfLine = `Balances as of ${fmtDateLong(dating.balanceAsOf)} · next bank sync pending.`;
  } else if (trust.overlayApplied === false && observed) {
    asOfLine = reconciled && reconciled !== observed
      ? `Later refresh observed ${observed} was not applied. Reconciled ${reconciled}.`
      : `Later refresh observed ${observed} was not applied.`;
  } else if (observed && reconciled && observed !== reconciled) {
    asOfLine = `Updated ${observed}. Reconciled ${reconciled}.`;
  } else if (observed && reconciled) {
    asOfLine = `Updated ${observed}.`;
  } else if (observed) {
    asOfLine = `Updated ${observed}.`;
  }
  const limits = (trust.coverageLimits || [])
    .map(row => row && row.text)
    .filter(Boolean);
  const unresolved = (trust.unresolvedMaterial || [])
    .map(row => row && row.text)
    .filter(Boolean);
  const proposal = trust.canonicalProposalWaiting === true
    ? '<p class="refresh-trust-proposal" data-refresh-trust-proposal>A saved update is waiting for approval. Nothing is written until then.</p>'
    : '';
  const question = trust.ownerQuestion && trust.ownerQuestion.text
    ? `<p class="refresh-trust-question" data-refresh-trust-owner-question>${trust.ownerQuestion.text}</p>`
    : '';
  const path = dating
    ? 'This plan is built from the latest bank sync, not today\'s balances. It updates after the next sync. Nothing is paid or moved from here.'
    : trust.refreshPath === 'on-demand-reload'
    ? 'Reload this page to check again. Nothing is paid or moved from here.'
    : 'This is the last saved picture of the accounts. Live bank numbers are not on this page.';
  const limitHtml = limits.length
    ? `<ul class="refresh-trust-limits">${limits.map(text => `<li>${text}</li>`).join('')}</ul>`
    : '';
  const unresolvedHtml = unresolved.length
    ? `<ul class="refresh-trust-unresolved">${unresolved.map(text => `<li>${text}</li>`).join('')}</ul>`
    : '';
  const extras = `${limitHtml}${unresolvedHtml}${proposal}${question}`;
  const extraWrap = extras.trim()
    ? `<details class="household-trust-details"><summary>Notes behind these numbers</summary>${extras}</details>`
    : '';
  return `<aside class="refresh-trust${tone}" data-refresh-trust-state="${trust.displayState}"${
    dating ? ` data-balance-as-of="${dating.balanceAsOf}"` : ''} data-exact-figures="${
    trust.exactFiguresAvailable === true ? 'available' : 'unavailable'
  }">
    <p class="refresh-trust-state">${state}</p>
    <p class="refresh-trust-asof" data-refresh-trust-observed>${asOfLine}</p>
    <p class="refresh-trust-path">${path}</p>
    ${extraWrap}
  </aside>`;
}

function cashUnsafe(action, capView, alloc) {
  const noSafe = !!(capView && !capView.hasFeasibleCap);
  const currentShortfall = !!(action && action.currentShortfall);
  const obligationShort = !!(alloc && alloc.obligations && Number(alloc.obligations.shortfall) > 0);
  const essentialShort = !!(alloc && alloc.essentials && Number(alloc.essentials.shortfall) > 0);
  const negativeCash = !!(alloc && alloc.available != null && Number(alloc.available) < 0);
  return !!(noSafe || currentShortfall || obligationShort || essentialShort || negativeCash);
}

function todayActionRowsHtml(rows, attr) {
  if (!rows || !rows.length) return '';
  return rows.map(row => `
          <div class="current-period-row" ${attr}="${row.id}">
            <div><b>${row.label}</b><span>${row.date ? fmtDate(row.date) : 'Date unavailable'}</span></div>
            <div class="current-period-values"><span${row.confidence === 'estimated' ? ' class="est"' : ''}>${
              row.amount != null ? money2(row.amount) : '—'
            }${currentPeriodConfidence(row)}</span></div>
          </div>`).join('');
}

function todayDecisionHtml(action, capView, alloc) {
  const todayActions = (action && action.todayActions) || [];
  const payday = action && action.nextPayday ? fmtDateLong(action.nextPayday) : null;
  const extra = (alloc && alloc.extraDebt) || {};
  const extraAmount = extra.allocated;
  const extraTarget = extra.target;
  const setAside = ((alloc && alloc.futureCosts) || [])
    .find(row => row && Number(row.allocated) > 0);
  const weekly = capView && capView.hasFeasibleCap ? capView.recommended : null;
  const unsafe = cashUnsafe(action, capView, alloc);
  let kind = 'none';
  let headline = payday
    ? `Hold until ${payday}.`
    : 'Hold until payday.';
  if (todayActions.length === 1) {
    const row = todayActions[0];
    kind = 'pay-today';
    headline = row.date
      ? `Pay ${row.label}${row.amount != null ? ` (${money2(row.amount)})` : ''} by ${fmtDate(row.date)}.`
      : `Pay ${row.label}${row.amount != null ? ` (${money2(row.amount)})` : ''} today.`;
  } else if (todayActions.length > 1) {
    kind = 'pay-today';
    headline = 'Pay these today.';
  } else if (extraAmount != null && Number(extraAmount) > 0 && extraTarget) {
    kind = 'extra-debt';
    headline = `Put ${money2(extraAmount)} extra on ${extraTarget.label}.`;
  } else if (setAside) {
    kind = 'set-aside';
    headline = setAside.date
      ? `Set aside ${money2(setAside.allocated)} for ${setAside.label} by ${fmtDate(setAside.date)}.`
      : `Set aside ${money2(setAside.allocated)} for ${setAside.label} this payday.`;
  } else if (weekly != null) {
    kind = 'spend-cap';
    headline = payday
      ? `This week's spend is ${money(weekly)} until ${payday}.`
      : `This week's spend is ${money(weekly)}.`;
  } else if (unsafe) {
    kind = 'hold';
    headline = payday
      ? `Hold this week's spend until ${payday}.`
      : "Hold this week's spend.";
  }

  const tight = kind === 'hold' || kind === 'pay-today';
  const extraActions = todayActions.length
    ? `<div class="household-today-actions">${todayActionRowsHtml(todayActions, 'data-current-today-action')}</div>`
    : '';
  const facts = payday
    ? `<div class="household-facts"><div class="household-fact"><span>Next payday</span><b>${payday}</b></div></div>`
    : '';

  return `<div class="decision-today" data-today-decision="${kind}" data-payday-next-move>
    <p class="household-primary${tight ? ' household-tight' : ''}" data-today-headline>${headline}</p>
    ${extraActions}${facts}
  </div>`;
}

function spendDecisionHtml(capView, weeklyPermission, remainingUnavailable, weeklyAuthority, action) {
  const payday = action && action.nextPayday ? fmtDateLong(action.nextPayday) : 'payday';
  // Infeasible weekly = 0 is a sentinel, not a supported $0/week yes.
  if (capView.hasFeasibleCap && weeklyPermission != null && !capView.infeasible) {
    return `<span class="operating-amount" data-spend-decision="amount">${money(weeklyPermission)} / week</span>
       <p class="operating-note">${weeklyAuthority}${
         remainingUnavailable
           ? ' What is left to spend this week is not confirmed yet.'
           : ''
       }</p>`;
  }
  const short = capView.fundingBlocked
    ? `No safe amount for this week's spend until ${payday}.`
    : "No safe amount for this week's spend.";
  return `<p class="household-primary household-tight" data-spend-decision="none">${short}</p>
    <details class="household-inline-details">
      <summary>Why?</summary>
      <p class="payday-refuse">${capView.reason}</p>
    </details>`;
}

function cashGlanceHtml(alloc, liveOverlay, cashNote) {
  const available = alloc && alloc.available != null ? money2(alloc.available) : '—';
  return `<div class="payday-cash" data-payday-cash data-spendable-cash="${available}">
    <span class="operating-amount" data-spendable-cash-amount>${available}</span>
    <p class="operating-note">${cashNote || paydayGlanceCashNote(alloc, liveOverlay)}</p>
  </div>`;
}

function liveCurrentBalanceHtml(view, liveOverlay, alloc) {
  // Actionable Current Balance is the Forecast-owned posted planning-hub
  // figure (canonical chequing-a / BILLS ACCOUNT only). Weekly, Savings,
  // and pooled A+B stay out. The page reprints Forecast; it does not sum.

  const amount = view && view.liveCurrentBalance != null
    ? view.liveCurrentBalance
    : (alloc && alloc.liveCurrentBalance != null ? alloc.liveCurrentBalance : null);
  const liveAlloc = {
    available: amount,
    cashBasis: alloc && alloc.cashBasis,
    asOf: (alloc && alloc.cashBasis && alloc.cashBasis.asOf)
      || (alloc && alloc.asOf)
      || (view && view.asOf)
      || null,
  };
  const providerDate = providerBalanceDate(liveOverlay);
  const glanceNote = glanceUpdatedNote(liveAlloc.asOf, liveOverlay);
  let dateLine = '';
  if (providerDate) {
    dateLine = `as of ${fmtDateLong(providerDate)}`;
  } else if (/As of /.test(glanceNote)) {
    dateLine = glanceNote.replace(/^Current Balance\. Not credit\.\s*/i, '')
      .replace(/^As of /i, 'as of ');
  } else if (/Updated /.test(glanceNote)) {
    dateLine = glanceNote.replace(/^Current Balance\. Not credit\.\s*/i, '');
  }
  const publication = (view && view.currentBalancePublication)
    || (alloc && alloc.currentBalancePublication)
    || null;
  const assumptionNote = publication && publication.note ? String(publication.note) : '';
  const printed = amount != null ? money2(amount) : '—';
  return `<div class="live-current-balance" data-live-current-balance>
    <p class="live-current-balance-label">Current Balance</p>
    <p class="live-current-balance-amount" data-live-current-balance-amount>${printed}</p>
    <p class="live-current-balance-account">Bills account only</p>
    ${assumptionNote ? `<p class="live-current-balance-note" data-live-current-balance-note>${assumptionNote}</p>` : ''}
    ${dateLine ? `<p class="live-current-balance-date">${dateLine}</p>` : ''}
  </div>`;
}

function postedThisPeriodHtml(action) {
  return alreadyPaidRowsHtml(action);
}

function glanceSignedMoney(n) {
  if (n == null || !isFinite(Number(n))) return null;
  const v = Number(n);
  const abs = money2(Math.abs(v));
  if (v > 0) return '+' + abs;
  if (v < 0) return '−' + abs;
  return abs;
}

function glanceMoney(row, kind) {
  if (!row) return null;
  if (kind === 'in' && row.status === 'received') return Forecast.incomeReceivedAmount(row);
  if (row.movement != null && isFinite(Number(row.movement))) return Number(row.movement);
  let raw = null;
  if (kind === 'paid' || kind === 'in' || kind === 'planned') {
    if (row.actual != null) raw = row.actual;
    else if (row.planned != null) raw = row.planned;
    else if (row.amount != null) raw = row.amount;
  } else if (row.remaining != null && Number(row.remaining) > 0) raw = row.remaining;
  else if (row.amount != null && Number(row.amount) > 0) raw = row.amount;
  else if (row.allocated != null && Number(row.allocated) > 0) raw = row.allocated;
  else if (row.planned != null && Number(row.planned) > 0) raw = row.planned;
  else if (row.remaining != null) raw = row.remaining;
  else if (row.amount != null) raw = row.amount;
  else if (row.allocated != null) raw = row.allocated;
  else if (row.planned != null) raw = row.planned;
  if (raw == null || !isFinite(Number(raw))) return null;
  const mag = Math.abs(Number(raw));
  if (kind === 'in') return mag;
  if (kind === 'paid' || kind === 'still-due' || kind === 'planned') return -mag;
  return Number(raw);
}

function glanceLineLabel(row, tag) {
  let name = String(row && row.label || '').replace(/\s+/g, ' ').trim();
  name = name.replace(/\s*[—–-]\s*[^—–-]*posting unknown\s*$/i, '').trim();
  name = name.replace(/\s*posting unknown\s*/ig, '').trim();
  const bits = [name || (row && row.label) || ''];
  // Forecast still owns payerLabel; default Plan bill rows do not print it.
  if (row && row.needsDate) {
    bits.push(row.dateNote || 'needs confirmation');
  } else {
    if (row && row.date) {
      bits.push(fmtDate(row.date));
      if (row.dateConfidence === 'estimated') bits.push('estimated');
    }
    if (tag && tag !== 'needs-date') bits.push(tag);
  }
  return bits.join(' · ');
}

function alreadyPaidRowsHtml(action) {
  const paid = action && action.thisPaydayPaid;
  const inflows = (paid && paid.inflows) || [];
  const bills = (paid && paid.bills) || [];
  if (!inflows.length && !bills.length) return '';
  const rows = inflows.map(row => paydayBucketRow(
    glanceLineLabel(row, 'in'),
    glanceSignedMoney(glanceMoney(row, 'in')),
    null,
    null,
    { preformatted: true }
  )).concat(bills.map(row => paydayBucketRow(
    glanceLineLabel(row, 'paid'),
    glanceSignedMoney(glanceMoney(row, 'paid')),
    null,
    null,
    { preformatted: true }
  ))).join('');
  return `<div class="operating-lines payday-already-paid-lines">${rows}</div>`;
}

function alreadyPaidHtml(action) {
  const rows = alreadyPaidRowsHtml(action);
  if (!rows) {
    return `<div class="payday-already-paid" data-payday-already-paid>
      <p class="operating-lead">Nothing paid this payday yet.</p>
    </div>`;
  }
  return `<div class="payday-already-paid" data-payday-already-paid data-payday-posted-actuals>
    <p class="operating-lead">Already paid from this payday.</p>
    ${rows}
  </div>`;
}

function stillDueItems(alloc, action) {
  if (action && Array.isArray(action.thisPaydayDue)) return action.thisPaydayDue;
  return ((alloc && alloc.obligations && alloc.obligations.items) || [])
    .filter(item => item && item.settlement !== 'represented');
}

function mustLeaveHtml(alloc, action) {
  if (!alloc && !action) {
    return `<div class="payday-must-leave payday-still-due" data-payday-must-leave data-payday-still-due>
      <p class="operating-lead">Bills still due this payday are unavailable.</p>
    </div>`;
  }
  const items = stillDueItems(alloc, action);
  if (!items.length) {
    return `<div class="payday-must-leave payday-still-due" data-payday-must-leave data-payday-still-due>
      <p class="operating-lead">Nothing else has to leave this payday.</p>
    </div>`;
  }
  const rows = items.map(item => {
    const amount = glanceSignedMoney(glanceMoney(item, 'still-due'));
    const about = item.confidence === 'estimated' ? 'about ' : '';
    return `<div class="operating-line" data-still-due-bill="${item.id || ''}">
      <span>${glanceLineLabel(item, 'still due')}</span><span>${amount != null ? about + amount : '—'}</span>
    </div>`;
  }).join('');
  const obligations = (alloc && alloc.obligations) || {};
  const short = Number(obligations.shortfall) > 0
    ? `<p class="operating-limit warn">Still-due bills are short ${money2(obligations.shortfall)}.</p>`
    : '';
  const kept = obligations.allocated != null
    ? paydayBucketRow('Kept for these bills', obligations.allocated, obligations.wanted, obligations.shortfall)
    : '';
  return `<div class="payday-must-leave payday-still-due" data-payday-must-leave data-payday-still-due>
    <p class="operating-lead">Still needs to leave.</p>
    <div class="operating-lines payday-still-due-lines">${rows}</div>
    ${kept}
    ${short}
  </div>`;
}

function extraDebtGlanceHtml(alloc) {
  const extra = (alloc && alloc.extraDebt) || {};
  const allocated = extra.allocated;
  if (allocated != null && Number(allocated) > 0 && extra.target) {
    return `<div class="payday-extra-debt" data-payday-extra-debt="plus" data-extra-debt="plus">
      <p class="operating-lead">Put ${money2(allocated)} extra on ${extra.target.label}.</p>
      <span class="operating-amount">${money2(allocated)}</span>
    </div>`;
  }
  return '';
}

function runningLeftoverHtml(amount, trust) {
  const known = amount != null && isFinite(Number(amount));
  // Sign is presentation only: the same Forecast figure, coloured so a
  // negative running balance cannot be mistaken for a positive one.
  const sign = !known ? 'unknown' : Number(amount) < 0 ? 'negative' : 'non-negative';
  const estimated = trust === 'estimated' && known;
  const mark = estimated ? '<span class="est">≈ estimated</span> ' : '';
  return `<div class="payday-leftover" data-running-leftover data-sign="${sign}"${estimated ? ' data-balance-trust="estimated"' : ''}>
    <span class="operating-amount">${mark}${known ? money2(amount) : '—'}</span>
  </div>`;
}

function operatingCashExplanationHtml(explanation) {
  if (!explanation || explanation.sameContract === true) return '';
  const esc = v => String(v == null ? '' : v)
    .replace(/&/g, '\u0026amp;')
    .replace(/</g, '\u0026lt;')
    .replace(/>/g, '\u0026gt;')
    .replace(/"/g, '\u0026quot;');
  const leftoverKnown = explanation.leftover != null && isFinite(Number(explanation.leftover));
  const cashKnown = explanation.operatingCash != null && isFinite(Number(explanation.operatingCash));
  const billsKnown = explanation.billsCash != null && isFinite(Number(explanation.billsCash));
  const leftoverAmount = leftoverKnown
    ? `<span class="operating-amount">${esc(money2(explanation.leftover))}</span> `
    : '';
  const cashAmount = cashKnown
    ? `<span class="operating-amount">${esc(money2(explanation.operatingCash))}</span> `
    : '';
  const billsAmount = billsKnown
    ? `<span class="operating-amount">${esc(money2(explanation.billsCash))}</span> `
    : '';
  const leftoverNote = explanation.leftoverNote
    ? `<p class="operating-note" data-leftover-identity>${leftoverAmount}${esc(explanation.leftoverNote)}</p>`
    : '';
  const cashNote = explanation.operatingCashNote
    ? `<p class="operating-note" data-operating-cash-identity>${cashAmount}${esc(explanation.operatingCashNote)}</p>`
    : '';
  const billsNote = explanation.billsCashNote
    ? `<p class="operating-note" data-bills-cash-identity>${billsAmount}${esc(explanation.billsCashNote)}</p>`
    : '';
  const movements = Array.isArray(explanation.movements) ? explanation.movements : [];
  const items = movements.map(m => {
    if (!m || !m.operatingCashEffect) return '';
    const path = m.sourceLabel && m.destinationLabel
      ? `${esc(m.sourceLabel)} → ${esc(m.destinationLabel)}. `
      : '';
    const billsLocation = m.billsLocationEffectNote ? `${esc(m.billsLocationEffectNote)} ` : '';
    const note = m.operatingCashEffectNote ? esc(m.operatingCashEffectNote) : '';
    const amount = m.amount != null && isFinite(Number(m.amount))
      ? ` data-operating-cash-movement-amount="${esc(m.amount)}"` : '';
    const billsAttr = m.billsLocationEffect
      ? ` data-bills-location-effect="${esc(m.billsLocationEffect)}"` : '';
    return `<li data-operating-cash-movement="${esc(m.operatingCashEffect)}"${amount}${billsAttr}>${path}${billsLocation}${note}</li>`;
  }).join('');
  const list = items
    ? `<ul class="operating-cash-movements" data-operating-cash-movements>${items}</ul>`
    : '';
  const leftoverAttr = leftoverKnown
    ? ` data-leftover="${esc(explanation.leftover)}"` : '';
  const cashAttr = cashKnown
    ? ` data-operating-cash="${esc(explanation.operatingCash)}"` : '';
  const billsAttr = billsKnown
    ? ` data-bills-cash="${esc(explanation.billsCash)}"` : '';
  const leftoverVsBills = explanation.leftoverSameAsBillsCash === false
    ? ' data-leftover-same-as-bills-cash="false"' : '';
  return `<div class="operating-cash-explanation" data-operating-cash-explanation data-same-contract="false"${leftoverAttr}${cashAttr}${billsAttr}${leftoverVsBills}>
    ${cashNote}
    ${billsNote}
    ${leftoverNote}
    ${list}
  </div>`;
}

function periodBillLine(row) {
  const kind = row.glanceKind || (row.status === 'in' ? 'in'
    : (row.status === 'PAID' ? 'paid'
      : (row.status === 'planned' || row.status === 'unknown' ? 'planned' : 'still-due')));
  const status = row.status === 'in' ? 'in'
    : row.status === 'PAID' ? 'PAID'
    : row.status === 'planned' ? 'planned'
    : row.status === 'unknown' ? 'unknown'
    : row.status === 'pending' ? 'pending'
    : row.status === 'needs-date' ? 'needs confirmation'
    : row.settlement === 'unverified' ? 'to confirm'
    : 'still due';
  const amount = glanceSignedMoney(glanceMoney(row, kind));
  const amountTrust = row.displayAmountTrust === undefined
    ? (row.confidence === 'estimated' ? 'estimated' : null) : row.displayAmountTrust;
  const about = amountTrust === 'estimated' && amount != null ? 'about ' : '';
  if (typeof BillDetail !== 'undefined') {
    // App.data is this render's served packet, also used by renderPlan above.
    // The disclosure only reprints Forecast rows and exact sanitized links.
    return BillDetail.html(row, App.data, {
      label: glanceLineLabel(row, status),
      amount: amount != null ? about + amount : '—', status,
    });
  }
  const dateAttr = row.date && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date))
    ? ` data-bill-date="${row.date}"` : '';
  return `<div class="operating-line" data-period-bill="${row.id || ''}" data-bill-status="${status}" data-bill-settlement="${String(row.settlement || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}"${dateAttr}>
    <span>${glanceLineLabel(row, status)}</span><span>${amount != null ? about + amount : '—'}</span>
  </div>`;
}

function calendarCurrentUnavailableHtml(period) {
  const note = (period && period.operatingPlanNote)
    || 'Current plan unavailable. The dated opening is stale.';
  const dated = period && period.openingKnown && period.opening != null
    ? `<p class="operating-note">Dated balance — not current. ${money2(period.opening)}</p>`
    : '';
  return `<div data-operating-plan="unavailable" data-current-waterfall="unavailable">
    <p class="operating-lead">${note}</p>
    ${dated}
  </div>`;
}

function calendarIncomeHtml(period) {
  if (period && period.operatingPlanUnavailable) {
    return calendarCurrentUnavailableHtml(period);
  }
  const rows = (period && period.income) || [];
  const named = rows.filter(row => row && row.otherIncome !== true);
  const other = (period && period.otherIncome) || { amount: 0, items: [] };
  const otherItems = Array.isArray(other.items) ? other.items : [];
  if (!named.length && !otherItems.length && !(Number(other.amount) > 0)) {
    return `<div class="payday-period-income" data-calendar-income>
      <p class="operating-lead">No income in this period.</p>
    </div>`;
  }
  const line = (row, extra = '') => {
    const notRelied = row.notReliedUpon === true
      || row.settlement === 'not-relied-upon'
      || row.status === 'unresolved';
    // 2027 payroll trust is the stamp Forecast already put on the row
    // (status, settlement, incomeRegime). Confidence alone is not that
    // stamp, and neither is the selected period date.
    const estimatedTrust = !notRelied && (
      row.status === 'estimated'
      || row.settlement === 'estimated'
      || row.incomeRegime === '2027-estimated'
    );
    const status = notRelied ? 'not relied upon'
      : estimatedTrust ? 'estimated'
      : row.status === 'received' ? 'received'
      : row.status === 'relied-upon' ? 'relied upon'
      : row.status === 'planned' ? 'planned'
      : row.status === 'unknown' ? 'unknown'
      : row.alreadyInCash ? 'already in balance' : 'arriving';
    const amount = glanceSignedMoney(glanceMoney(row, 'in'));
    const cls = row && row.incomeClass;
    const id = String(row && row.id || '');
    const labelText = String(row && row.label || '');
    const daleSalary = cls === 'dale'
      || id === 'payroll'
      || /seaspan|c-?span/i.test(`${id} ${labelText}`);
    const amandaSalary = cls === 'amanda'
      || /amandaSalary|amanda-salary/i.test(id)
      || /amanda salary/i.test(labelText);
    // Budget income display only: Forecast labels and settlement stay on
    // the row; the printed name drops Seaspan / Tennis BC / not-relied copy.
    const displayName = daleSalary ? 'Dale salary'
      : amandaSalary ? 'Amanda salary'
      : glanceLineLabel(row, notRelied ? 'not relied upon'
        : row.status === 'relied-upon' ? 'relied upon'
        : row.alreadyInCash && row.status !== 'received' ? 'already in balance'
        : status);
    const about = !estimatedTrust && !daleSalary && row.confidence === 'estimated' && amount != null
      ? 'about ' : '';
    const estimateMark = estimatedTrust && amount != null
      ? '<span class="est">≈ estimated</span> ' : '';
    const statusAttr = notRelied ? 'not-relied-upon'
      : row.status === 'relied-upon' ? 'relied-upon'
      : status;
    // Other named receipts already include date/status in glanceLineLabel.
    // Salary names omit that metadata, so print it once beneath the name.
    const receiptStatus = notRelied ? 'deposit not confirmed' : status;
    const receiptDate = (daleSalary || amandaSalary) && row.date
      && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date))
      ? `<time class="budget-receipt-date" datetime="${row.date}">${fmtDate(row.date)} · ${receiptStatus}</time>` : '';
    const original = row.planned ?? row.amount;
    const originalPlan = row.status === 'received' && typeof original === 'number' && Number.isFinite(original)
      ? `<span class="budget-receipt-date" data-income-original-plan>Original plan ${money2(original)}</span>` : '';
    return `<div class="operating-line" data-period-income="${row.id || ''}" data-income-status="${statusAttr}"${extra}>
      <span>${displayName}${receiptDate}${originalPlan}</span><span data-income-line-amount>${amount != null ? estimateMark + about + amount : row.status === 'received' ? 'Unavailable' : '-'}</span>
    </div>`;
  };
  const namedLines = named.map(row => line(row)).join('');
  const esc = v => String(v == null ? '' : v)
    .replace(/&/g, '\u0026amp;')
    .replace(/</g, '\u0026lt;')
    .replace(/>/g, '\u0026gt;')
    .replace(/"/g, '\u0026quot;');
  const otherAmount = other.amount != null ? Number(other.amount) : 0;
  let otherHtml;
  if (!otherItems.length) {
    otherHtml = `<div class="operating-line" data-other-income data-other-income-amount="${esc(money2(otherAmount))}">
      <span>Other income</span><span>${money2(otherAmount)}</span>
    </div>`;
  } else {
    const itemLines = otherItems.map(row => {
      const recon = Array.isArray(row.recon) ? row.recon : [];
      const tx = recon[0] || {};
      const displayed = String(tx.displayedPayee || row.label || '').trim();
      const original = String(tx.originalMerchant || '').trim();
      const payeeRaw = displayed || original || 'Merchant unavailable';
      const isReceived = row.status === 'received';
      const pending = !isReceived && (tx.pending === true || row.confidence === 'estimated')
        ? '<span class="other-income-tx-pending">Expected</span>'
        : '';
      const received = isReceived
        ? '<span class="other-income-tx-received">Received</span>'
        : '';
      const dateAttr = row.date ? ` datetime="${esc(row.date)}"` : '';
      const dateText = row.date ? fmtDate(row.date) : '—';
      const idAttr = row.id ? ` data-other-income-item="${esc(row.id)}"` : '';
      const status = isReceived ? 'received'
        : row.status === 'planned' ? 'planned'
        : row.status === 'unknown' ? 'unknown'
        : row.alreadyInCash ? 'already in balance' : 'arriving';
      const about = !isReceived && row.confidence === 'estimated' ? 'about ' : '';
      const receiptAmount = isReceived ? Forecast.incomeReceivedAmount(row) : row.amount;
      return `<li class="other-income-tx"${idAttr} data-income-status="${status}">
        <time${dateAttr}>${esc(dateText)}</time>
        <span class="other-income-tx-payee">${esc(payeeRaw)}${received}${pending}</span>
        <span class="other-income-tx-amount" data-income-line-amount>${receiptAmount != null ? about + money2(receiptAmount) : 'Unavailable'}</span>
      </li>`;
    }).join('');
    otherHtml = `<div class="other-income-openable" data-other-income>
      <details class="other-income-detail">
        <summary class="other-income-summary">
          <span class="other-income-label">Other income</span>
          <span class="other-income-amount" data-other-income-amount>${money2(otherAmount)}</span>
        </summary>
        <div class="other-income-breakdown" data-other-income-detail>
          <ul class="other-income-txs">${itemLines}</ul>
          <p class="other-income-tx-total"><span>Total</span><span data-other-income-total>${money2(otherAmount)}</span></p>
        </div>
      </details>
    </div>`;
  }
  // Closing total is Forecast period.available (Payday balance identity).
  // Kept under the named/other income breakdown, parallel to bills:
  // line items, then a closing total. Do not invent a second calculator
  // field or relabel this as leftover-after-adding-income.
  const payday = period && period.available != null
    ? `<div class="payday-totals">
        <p class="payday-qual payday-total payday-total-strong" data-payday-balance>
          <span>Payday balance</span><span data-payday-balance-amount>${money2(period.available)}</span>
        </p>
      </div>`
    : '';
  return `<div class="payday-period-income" data-calendar-income>
    <div class="operating-lines">${namedLines}${otherHtml}</div>
    ${payday}
  </div>`;
}

function householdBudgetCycleText(period) {
  if (!period) return '';
  if (period.spendingCycle && period.spendingCycle.rangeLabel) {
    return period.spendingCycle.rangeLabel;
  }
  const label = String(period.spendingCycleLabel || '');
  return label.replace(/^Spending cycle:\s*/, '');
}

function householdBudgetMetric(label, amount, opts) {
  const remaining = !!(opts && opts.remaining);
  const cls = remaining
    ? 'household-budget-metric household-budget-remaining'
    : 'household-budget-metric';
  const knownAmount = amount != null && isFinite(Number(amount));
  const plain = knownAmount ? money2(amount) : (opts && opts.unavailableText) || '—';
  const estimated = !!(opts && opts.estimated) && knownAmount;
  const value = estimated
    ? `<span class="est">≈ estimated</span> ${plain}`
    : plain;
  const recon = opts && Array.isArray(opts.recon) ? opts.recon : null;
  if (label === 'Spent' && recon && recon.length) {
    const esc = v => String(v == null ? '' : v)
      .replace(/&/g, '\u0026amp;')
      .replace(/</g, '\u0026lt;')
      .replace(/>/g, '\u0026gt;')
      .replace(/"/g, '\u0026quot;');
    // Forecast already marks unresolved possible replacement. The page
    // hides only a pending row with that incumbent mark. It does not
    // infer identity from merchant, date, or amount.
    const txs = recon.filter(tx => {
      if (!tx) return false;
      if (tx.pendingPostedDuplicate === true && tx.pending === true) return false;
      return true;
    }).slice().sort((a, b) => {
      const dateCmp = String(a.date || '').localeCompare(String(b.date || ''));
      if (dateCmp) return dateCmp;
      const aLabel = String(a.displayedPayee || a.originalMerchant || '');
      const bLabel = String(b.displayedPayee || b.originalMerchant || '');
      const labelCmp = aLabel.localeCompare(bLabel);
      if (labelCmp) return labelCmp;
      const amtCmp = (Number(a.amount) || 0) - (Number(b.amount) || 0);
      if (amtCmp) return amtCmp;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    if (!txs.length) {
      return `<div class="${cls}"><dt>${label}</dt><dd>${value}</dd></div>`;
    }
    const lines = txs.map(tx => {
      const displayed = String(tx.displayedPayee || '').trim();
      const original = String(tx.originalMerchant || '').trim();
      const payeeRaw = displayed || original || 'Merchant unavailable';
      const pending = tx.pending === true
        ? '<span class="household-budget-tx-pending">Pending</span>'
        : '';
      const unexpected = tx.unexpectedStatus === 'cancelled-service-charge'
        ? `<span class="household-budget-tx-alert">Unexpected charge from cancelled service${tx.cancelledServiceLabel ? `: ${esc(tx.cancelledServiceLabel)}` : ''}</span>`
        : '';
      // Display-only deliberately marked note ("item: …"), already bounded
      // by the observer. Escaped here; never read for membership or math.
      const noteText = typeof tx.displayedNote === 'string' ? tx.displayedNote.trim() : '';
      const note = noteText ? `<span class="household-budget-tx-note" data-tx-note>${esc(noteText)}</span>` : '';
      const dateAttr = tx.date ? ` datetime="${esc(tx.date)}"` : '';
      const dateText = tx.date ? fmtDate(tx.date) : '—';
      const idAttr = tx.id ? ` data-tx-id="${esc(tx.id)}"` : '';
      // Forecast owns this marker and its cents. A payment or a similar-looking
      // transaction never lets the renderer infer household purchase coverage.
      const coverage = tx.cardPurchaseCoverage;
      const coverageKnown = coverage && ['awaiting-coverage', 'resolved'].includes(coverage.status)
        && typeof coverage.remaining === 'number' && Number.isFinite(coverage.remaining);
      const coverageState = coverage ? coverageKnown ? coverage.status : 'unconfirmed' : null;
      const cardText = coverageState === 'awaiting-coverage'
        ? `${money2(coverage.remaining)} still to cover`
        : coverageState === 'resolved' ? 'Coverage resolved' : 'Coverage unconfirmed';
      const card = coverageState ? `<span class="household-budget-tx-card"><svg aria-hidden="true" viewBox="0 0 20 16" focusable="false"><rect x="1" y="1" width="18" height="14" rx="2"/><path d="M1 5h18M4 11h4"/></svg>Card purchase${coverage.accountLabel ? ` · ${esc(coverage.accountLabel)}` : ''} · ${esc(cardText)}</span>` : '';
      return `<li class="household-budget-tx${coverageState && coverageState !== 'resolved' ? ' is-card-coverage-open' : ''}"${idAttr}${coverageState ? ` data-card-coverage="${coverageState}"` : ''} data-tx-pending="${tx.pending === true ? 'true' : 'false'}">
        <time${dateAttr}>${esc(dateText)}</time>
        <span class="household-budget-tx-payee">${esc(payeeRaw)}${pending}${unexpected}${note}${card}</span>
        <span class="household-budget-tx-amount">${money2(tx.amount)}</span>
      </li>`;
    }).join('');
    const spentId = opts && opts.id ? esc(opts.id) : '';
    const totalLine = knownAmount
      ? `<p class="household-budget-tx-total"><span>Total</span><span data-budget-spent-total="${spentId}">${value}</span></p>`
      : '';
    return `<div class="${cls} household-budget-spent-openable">
      <dt>Spent</dt>
      <dd>
        <details class="household-budget-spent-detail" data-budget-spent="${spentId}">
          <summary class="household-budget-spent-summary">
            <span class="household-budget-spent-label">Spent</span>
            <span class="household-budget-spent-amount">${value}</span>
          </summary>
          <div class="household-budget-breakdown" data-budget-spent-detail>
            <ul class="household-budget-txs">${lines}</ul>
            ${totalLine}
          </div>
        </details>
      </dd>
    </div>`;
  }
  return `<div class="${cls}"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function householdBudgetCategoryHtml(row, opts = {}) {
  if (!row) return '';
  if (row.informational) {
    return paydayBucketRow(
      row.label,
      row.note || 'included in Bills, remaining not deducted',
      null,
      null,
      { preformatted: true }
    );
  }
  const other = row.otherSpending === true || row.needsConfirmation === true;
  // Completed-period rows retain today's configured targets in sealed native
  // evidence. That is not a dated original plan. Carry the period context into
  // the same node that moves into an individual category/transaction sheet.
  const historicalPlanUnknown = opts.historicalOriginalPlanUnavailable === true;
  const datedOtherPlan = other && typeof row.targetEffectiveFrom === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(row.targetEffectiveFrom)
    && typeof row.planned === 'number' && Number.isFinite(row.planned);
  const estimated = (!other || datedOtherPlan) && (row.confidence === 'estimated' || row.trust === 'estimated');
  const name = row.label || '';
  const context = other
    ? (row.note || 'Not yet assigned to a budget category')
    : (!historicalPlanUnknown && row.plannedWeekly != null ? `${money2(row.plannedWeekly)}/week` : '');
  const contextHtml = context
    ? `<p class="household-budget-context">${context}</p>` : '';
  const recon = Array.isArray(row.recon) ? row.recon : [];
  const remainingUnavailable = opts.remainingEvidenceIncomplete === true;
  const metrics = [];
  if ((!other && !historicalPlanUnknown || datedOtherPlan) && row.planned != null) {
    if (historicalPlanUnknown) metrics.push(householdBudgetMetric('Configured target', row.planned, { estimated }));
    else metrics.push(householdBudgetMetric('Planned', row.planned, { estimated }));
  }
  if (row.spent != null || recon.length || datedOtherPlan) {
    metrics.push(householdBudgetMetric('Spent', row.spent, { recon, id: row.id, unavailableText: datedOtherPlan ? 'Unavailable' : null }));
  }
  if ((!other || datedOtherPlan) && !historicalPlanUnknown && (row.remaining != null || datedOtherPlan)) {
    metrics.push(householdBudgetMetric('Remaining', remainingUnavailable ? null : row.remaining, { remaining: true, estimated, unavailableText: datedOtherPlan || remainingUnavailable ? 'Unavailable' : null }));
  }
  const kind = other ? 'other' : 'category';
  const projected = (!other || datedOtherPlan) && !historicalPlanUnknown && row.projected && row.remaining != null
    ? '<p class="household-budget-context">Projected.</p>' : '';
  const trustAttr = estimated ? ' data-budget-trust="estimated"' : '';
  return `<div class="household-budget-${kind}" data-budget-category="${row.id || ''}"${other ? ' data-other-spending' : ''}${trustAttr}>
    <h3 class="household-budget-name">${name}</h3>
    ${contextHtml}
    ${historicalPlanUnknown && (!other || datedOtherPlan) ? '<p class="household-budget-context" data-budget-historical-original-plan="unavailable">Historical original plan unavailable. No dated plan snapshot confirms this period\'s target or remaining amount. Today\'s configured target does not establish the historical plan.</p>' : ''}
    <dl class="household-budget-metrics">${metrics.join('')}</dl>
    ${remainingUnavailable && !historicalPlanUnknown && (!other || datedOtherPlan) ? `<details class="household-budget-remaining-info" data-budget-remaining-info><summary>Info</summary><p>${budgetBrowseEscape(opts.remainingEvidenceReason || 'Exact remaining spending is unavailable because period evidence is incomplete.')}</p></details>` : ''}
    ${projected}
  </div>`;
}

function calendarBudgetHtml(period, liveOverlay, plan, opts = {}) {
  if (period && period.operatingPlanUnavailable) {
    return `<div class="payday-household-budget" data-payday-household-budget>
      ${calendarCurrentUnavailableHtml(period)}
    </div>`;
  }
  const rows = (period && period.householdBudget) || [];
  // Forecast has no original-category-plan snapshot for completed periods.
  // Context changes presentation only; never rewrite the sealed native rows.
  const categoryContext = { historicalOriginalPlanUnavailable:
    period?.timelineRole === 'past' || period?.lookback === true,
    remainingEvidenceIncomplete: opts.remainingEvidenceIncomplete === true,
    remainingEvidenceReason: opts.remainingEvidenceReason };
  const reserveRule = categoryContext.historicalOriginalPlanUnavailable ? ''
    : period && period.householdActualsUnavailable === true
      ? '<p class="operating-note" data-budget-reserve-rule>Reserve calculation: spending for this period is unknown, so each planned category is shown at its plan as a target only. The remainder is unavailable until spending is confirmed.</p>'
      : '<p class="operating-note" data-budget-reserve-rule>Reserve calculation: Each planned category, including Other when it has a dated target, counts at its plan or observed spending, whichever is higher. Any unassigned spending without a target counts once.</p>';
  const cycleText = householdBudgetCycleText(period);
  const cycle = period && period.cycleUnresolved
      ? `<p class="household-budget-cycle">Spending cycle unavailable. Household Budget reserve is held.</p>`
      : (cycleText ? `<p class="household-budget-cycle">${cycleText}</p>` : '');
  // Forecast already owns the payday deduction as period.budgetHold.
  // Print that incumbent value. Do not sum category rows here.
  // budgetHoldTrust is Forecast's stamp when the hold includes the
  // future Other Spend estimate. The page does not infer it.
  const estimatedHold = period && period.budgetHoldTrust === 'estimated';
  const holdMark = estimatedHold
    ? '<span class="est">≈ estimated</span> '
    : '';
  const amount = period && period.budgetHold != null
    ? `<span data-household-budget-total-amount>${money2(period.budgetHold)}</span>`
    : '';
  // The mark sits in the same flex child as the Forecast cents so the
  // total stays label | figure. Current rows omit the wrapper entirely.
  const value = estimatedHold ? `<span>${holdMark}${amount}</span>` : amount;
  const deductionLabel = categoryContext.historicalOriginalPlanUnavailable
    ? 'Completed-period spending deduction' : 'Protective spending reserve';
  const total = amount
    ? `<div class="payday-totals household-budget-total">
      <p class="payday-qual payday-total payday-total-strong" data-household-budget-total${estimatedHold ? ' data-budget-hold-trust="estimated"' : ''}>
        <span>${deductionLabel}</span>
        ${value}
      </p>
    </div>`
    : '';
  // The reserve is the unchanged Forecast deduction, not actual spending or
  // the original plan. Keep its amount and rule behind an explicit disclosure.
  const reserveInfo = total ? `<details class="household-budget-reserve-info" data-budget-reserve-info>
    <summary>Info: ${deductionLabel.toLowerCase()}</summary>${total}${reserveRule}
  </details>` : reserveRule;
  if (!rows.length) {
    return `<div class="payday-household-budget" data-payday-household-budget>
      ${cycle}
      <p class="operating-lead">No household budget lines on this plan.</p>
      ${reserveInfo}
    </div>`;
  }
  // Presentation only: when Forecast withheld Spent (`row.spent == null`)
  // and row.recon is empty, list overlay current-period txs in the
  // existing Spent details path. Membership reuses Forecast
  // classifyCurrentPeriodTransaction, householdBudgetSupportingSpendEligible,
  // and skipSplitParent. Do not recompute spent or remaining.
  const overlayPacket = liveOverlay && liveOverlay.currentPeriodActuals;
  const overlayTxs = overlayPacket && Array.isArray(overlayPacket.transactions)
    ? overlayPacket.transactions : [];
  const classify = (typeof Forecast !== 'undefined' && Forecast
    && typeof Forecast.classifyCurrentPeriodTransaction === 'function')
    ? Forecast.classifyCurrentPeriodTransaction : null;
  const eligible = classify && classify.householdBudgetSupportingSpendEligible;
  const skipSplitParent = classify && classify.skipSplitParent;
  const overlayReconForRow = row => {
    if (!row || (Array.isArray(row.recon) && row.recon.length)) {
      return Array.isArray(row.recon) ? row.recon : [];
    }
    // Overlay listing is withheld-Spent only. A published 0 (or any
    // known Spent) is Forecast's figure; do not attach overlay txs.
    if (row.spent != null) {
      return Array.isArray(row.recon) ? row.recon : [];
    }
    if (!period || period.role !== 'active' || !overlayTxs.length) return [];
    const windowStart = (period.spendingCycle && period.spendingCycle.start)
      || period.start || null;
    const through = period.end
      || (period.spendingCycle && period.spendingCycle.end)
      || null;
    const matched = [];
    for (let i = 0; i < overlayTxs.length; i++) {
      const tx = overlayTxs[i];
      if (!tx) continue;
      if (windowStart && tx.date && tx.date < windowStart) continue;
      if (through && tx.date && tx.date > through) continue;
      if (typeof skipSplitParent === 'function' && skipSplitParent(tx, overlayPacket)) {
        continue;
      }
      const amt = Number(tx.amount);
      if (!isFinite(amt) || amt === 0) continue;
      if (classify) {
        const cls = classify(tx, plan, {
          packet: overlayPacket,
          currentPeriodActuals: overlayPacket,
        });
        if (typeof eligible === 'function' && !eligible(cls)) continue;
        if (row.otherSpending === true || row.needsConfirmation === true) {
          if (!(cls && (cls.needsConfirmation || cls.kind === 'unclassified'))) continue;
        } else {
          const catId = cls && (cls.atlasRow || cls.categoryId);
          if (catId !== row.id) continue;
        }
      } else {
        const label = String(tx.categoryLabel || '').trim().toLowerCase();
        if (!label) continue;
        const rowLabel = String(row.label || '').trim().toLowerCase();
        const rowId = String(row.id || '').trim().toLowerCase();
        if (label !== rowLabel && label !== rowId) continue;
      }
      matched.push(tx);
    }
    return matched;
  };
  const blocks = rows.map(row => {
    const recon = overlayReconForRow(row);
    if (recon === row.recon || (Array.isArray(row.recon) && row.recon.length)) {
      return householdBudgetCategoryHtml(row, categoryContext);
    }
    if (!recon.length) return householdBudgetCategoryHtml(row, categoryContext);
    return householdBudgetCategoryHtml(Object.assign({}, row, { recon }), categoryContext);
  }).join('');
  return `<div class="payday-household-budget" data-payday-household-budget>
    ${cycle}
    <div class="household-budget-list">${blocks}</div>
    ${reserveInfo}
  </div>`;
}

function calendarPeriodBillsHtml(period) {
  if (period && period.operatingPlanUnavailable) {
    return `<div class="payday-period-bills" data-payday-period-bills>
      ${calendarCurrentUnavailableHtml(period)}
    </div>`;
  }
  const rows = (period && period.bills) || [];
  const visaPayments = typeof BillDetail !== 'undefined' && BillDetail.visaPaymentsHtml
    ? BillDetail.visaPaymentsHtml(period && period.visaPaymentBackfill, period && period.cardPurchaseCoverage)
    : '';
  if (!rows.length) {
    return `<div class="payday-period-bills" data-payday-period-bills>
      <p class="operating-lead">No bills in this period.</p>
      ${visaPayments}
    </div>`;
  }
  const feeAllowanceRetained = rows.some(row => row.scheduledFeeAllowance?.remainingAllowance > 0);
  const lines = rows.map(periodBillLine).join('');
  const totals = [];
  if (period && period.totalBillsThisPeriod != null) {
    totals.push(`<p class="payday-qual payday-total"><span>Total bills this period</span><span>${money2(period.totalBillsThisPeriod)}</span></p>`);
  }
  if (period && period.paidBills != null) {
    totals.push(`<p class="payday-qual payday-total"><span>Paid bills this period</span><span>${money2(period.paidBills)}</span></p>`);
  }
  if (period && period.remainingBills != null) {
    totals.push(`<p class="payday-qual payday-total payday-total-strong"><span>${feeAllowanceRetained ? 'Remaining bill reserve' : 'Remaining bills to pay'}</span><span>${money2(period.remainingBills)}</span></p>`);
  }
  return `<div class="payday-period-bills" data-payday-period-bills>
    <div class="operating-lines">${lines}</div>
    ${visaPayments}
    <p class="operating-note">The Bills deduction uses assigned amounts, excluding bills already settled in the opening. Paid bills shows the settled amounts displayed above.</p>
    ${totals.length ? `<div class="payday-totals">${totals.join('')}</div>` : ''}
    ${feeAllowanceRetained ? '<p class="operating-note" data-scheduled-fee-reserve>The unspent scheduled fee allowance stays reserved. The recorded fee is already settled; this is not another payment due.</p>' : ''}
  </div>`;
}

function extraRepaymentHtml(period) {
  if (period && period.operatingPlanUnavailable) {
    return `<div class="payday-extra-repay" data-calendar-extra data-operating-plan="unavailable">
      ${calendarCurrentUnavailableHtml(period)}
    </div>`;
  }
  const extra = (period && period.extraDebt) || {};
  if (extra.status === 'unavailable') {
    return `<div class="payday-extra-repay" data-calendar-extra data-extra-debt="unavailable">
      <p class="operating-lead">Extra credit-card repayment is unavailable until cash coverage is confirmed.</p>
    </div>`;
  }
  const card = period && period.firstCard;
  const allocated = extra.allocated != null ? Number(extra.allocated) : 0;
  const target = (extra.target && extra.target.label)
    || (card && card.label)
    || null;
  if (!(allocated > 0) || !target) {
    return `<div class="payday-extra-repay" data-calendar-extra>
      <p class="operating-lead">No extra credit-card repayment this period.</p>
    </div>`;
  }
  const tag = (period && period.extraLabel) || 'Extra';
  return `<div class="payday-extra-repay" data-calendar-extra>
    <p class="operating-lead">${tag} ${money2(allocated)} on ${target}.</p>
  </div>`;
}

// The Plan print stops at Balance After Deductions (Q07). That figure is
// copied from Forecast's selected pay-period row.
// Payday balance is the Income-block total from Forecast period.available.
// Forecast still computes the extra-debt / big-purchase chain and the
// cash projected ending on each period (the next period opens from cash,
// not from Balance After Deductions); those rows are not part of the
// household Plan surface.
function budgetPlanSpendEarmarkHtml(advice, period) {
  // The selected Budget publication supersedes this cap-basis banner, even
  // when unavailable. Falling back would publish competing funding amounts.
  // The Plan Spend route retains its incumbent cash/cap schedule and details.
  if (period && period.plannedCostFunding) return '';
  // Reprints Forecast's planSpendPaydayFunding contribution for the payday
  // starting this Budget period, so the household sees the Forecast earmark
  // for named future costs. Presentation only: the schedule is a Forecast
  // authority, the page does no arithmetic, and the Q01–Q07 waterfall is
  // unchanged (B98). Renders for any published schedule (including
  // funding-gap, which retains valid payday rows up to the first gap);
  // only unavailable schedules are suppressed, matching plan-spend.js.
  const schedule = advice && advice.planSpendPaydayFunding;
  if (!schedule || schedule.status === 'unavailable' || !Array.isArray(schedule.paydays)) return '';
  const start = period && period.start;
  if (!start) return '';
  const payday = schedule.paydays.find(row => row && row.payday === start);
  if (!payday) return '';
  const contribution = Number(payday.contribution) || 0;
  if (!(contribution > 0)) return '';
  const lines = (payday.allocations || [])
    .filter(row => row && Number(row.amount) > 0)
    .map(row => `<div class="operating-line"><span>${row.label}</span><span>${money2(row.amount)}</span></div>`)
    .join('');
  return `<div class="payday-plan-spend-earmark" data-plan-spend-earmark="${payday.payday}">
    <p class="operating-lead">Set aside ${money2(contribution)} for future costs</p>
    ${lines ? `<div class="operating-lines">${lines}</div>` : ''}
    <p class="operating-note">Forecast earmark for named planned costs on this payday — not extra money. The payment itself stays on its cash date.</p>
  </div>`;
}
/* ------------------------------------------------- AMANDA SLICE 3 ---
 * Month <-> Pay Period consolidated planning view on the Budget surface.
 *
 * The Month lens reprints Forecast.baselineTrajectory months[] only:
 * stage1 (income, bills, obligations, householdBudget), stage2
 * (commitments), stage3 (extras, result). The page selects the Forecast
 * row, formats values, labels them, and arranges them visually. It never
 * sums income, subtracts expenses, calculates surplus/deficit,
 * reconstructs stage totals, or carries surplus between months. The
 * monthly surplus/deficit is Forecast stage3.dateOrderResult, copied verbatim.
 * Unavailable is not $0. Trust tags are preserved from Forecast status.
 */
const BUDGET_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function budgetMonthName(monthKey) {
  if (!monthKey || String(monthKey).length < 7) return null;
  const year = String(monthKey).slice(0, 4);
  const mi = Number(String(monthKey).slice(5, 7)) - 1;
  if (!year || mi < 0 || mi > 11) return null;
  return `${BUDGET_MONTH_NAMES[mi]} ${year}`;
}

function budgetTrajectoryCacheKeyFor(asOf, plan, opts) {
  // AMANDA SLICE 3 repair (Systems Review BLOCKING on PR #441): the cache
  // identity must include every financial input that can change the
  // selected plan. A dates-only key serves a stale trajectory after the
  // household changes scenario, income, weekly spending, extra debt, or
  // adjustable commitments.
  const knob = key => {
    const v = opts ? opts[key] : undefined;
    if (v == null) return '';
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch (e) { return ''; }
    }
    return String(v);
  };
  return [
    asOf || '',
    (plan.opening && plan.opening.asOf) || '',
    knob('scenario'),
    knob('targetBuffer'),
    knob('extraDebtMonthly'),
    knob('weeklyVariable'),
    knob('weeklyVariableIsRecommendation'),
    knob('weeklyCapHolds'),
    knob('incomeOverrides'),
    knob('disabled'),
    knob('extraDebtTarget'),
    knob('currentPeriodActuals'),
    // ATLAS-080 repair (B1): simOpts now also supplies the verified
    // settlement evidence, and Forecast's trajectory/schedule move
    // with it. The cache identity must bind to that input or a
    // same-instance outcome change (unconfigured <-> qualified, or
    // qualified A -> qualified B) silently reuses the prior result.
    // Both Month caches share this key, so both follow the outcome.
    knob('settlementEvidence'),
  ].join('|');
}

// The selected Month trajectory's Forecast inputs, in one place. AMANDA
// SLICE 3 established these (Systems Review BLOCKING on PR #441): the
// Month lens must describe the same currently selected plan as the Pay
// Period lens, so the incumbent active control state (scenario, income
// overrides, weekly spending, extra debt, adjustable commitments) is fed
// through the existing Forecast authority via the same simOpts() the Pay
// Period lens uses. weeklyVariable is the adjacent Pay Period lens's
// selected value (src.weekly), with the Forecast cap verdict and explicit
// override identity. Forecast rejects an unsupported recommended zero;
// an owner-selected zero stays a setting. The Slice 8 funding-detail
// schedule is computed from these same inputs (P1 repair on PR #446) —
// the page selects and reprints; Forecast computes.
function budgetMonthKnobOpts(src) {
  const overlay = src.liveOverlay;
  const actuals = overlay && overlay.applied === true ? overlay.currentPeriodActuals : null;
  return simOpts({
    weeklyVariable: src.weekly,
    weeklyVariableIsRecommendation: src.weeklyOverride == null,
    weeklyCapHolds: src.advice && src.advice.holds,
    periods: src.periods || null,
    extraFacilities: src.revolvingExtra,
    currentPeriodActuals: actuals,
  });
}

function budgetTrajectoryFor(src) {
  if (!src || !src.plan) return null;
  const asOf = src.asOf || (src.meta && src.meta.asOf);
  const knobOpts = budgetMonthKnobOpts(src);
  const key = budgetTrajectoryCacheKeyFor(asOf, src.plan, knobOpts);
  if (budgetTrajectoryCache && budgetTrajectoryCacheKey === key) return budgetTrajectoryCache;
  let traj = null;
  try {
    traj = Forecast.baselineTrajectory(src.plan, src.debts, asOf, knobOpts);
  } catch (e) {
    traj = null;
  }
  budgetTrajectoryCache = traj;
  budgetTrajectoryCacheKey = key;
  return traj;
}

function budgetGranularityToggleHtml(payPeriodFirst = false) {
  const monthOn = budgetGranularity === 'month';
  const choices = payPeriodFirst ? [['pay-period', 'Pay period'], ['month', 'Month']]
    : [['month', 'Month'], ['pay-period', 'Pay Period']];
  return `<div class="budget-granularity" role="group" aria-label="Budget planning granularity">`
    + choices.map(([key, label]) => `<button type="button" class="budget-granularity-btn" data-budget-granularity="${key}" aria-pressed="${(key === 'month') === monthOn}">${label}</button>`).join('')
    + `</div>`;
}

function budgetMonthTrustTag(status) {
  if (status === 'estimated') return ' <span class="trust-tag trust-estimated">estimate</span>';
  if (status === 'calculated') return ' <span class="trust-tag">calculated</span>';
  return null;
}

function budgetMonthComponentRow(label, component, outflow = false) {
  if (!component || component.status === 'unavailable') {
    const reason = component && component.reason ? component.reason : 'Forecast did not publish this figure.';
    return `<div class="budget-month-row unavailable" data-budget-month-component="unavailable">`
      + `<span class="budget-month-label">${label}</span>`
      + `<span class="budget-month-unavailable">unavailable — ${reason} Not $0.</span></div>`;
  }
  const amount = component.amount;
  // Strict validation, no coercion: the amount must be a real finite
  // number (false/""/null are malformed data, never $0) and the trust
  // state must be explicitly published ('calculated' | 'estimated').
  // Anything else fails closed — currency never renders bare.
  if (typeof amount !== 'number' || !Number.isFinite(amount)
      || (component.status !== 'calculated' && component.status !== 'estimated')) {
    return `<div class="budget-month-row unavailable" data-budget-month-component="unavailable">`
      + `<span class="budget-month-label">${label}</span>`
      + `<span class="budget-month-unavailable">unavailable — Forecast did not publish a valid figure. Not $0.</span></div>`;
  }
  const tag = budgetMonthTrustTag(component.status) || '';
  return `<div class="budget-month-row" data-budget-month-component="${label}">`
    + `<span class="budget-month-label">${label}</span>`
    + `<span class="budget-month-amount">${outflow && amount >= 0 ? '<span aria-label="outflow">− </span>' : ''}${money2(amount)}${tag}</span></div>`;
}

/* AMANDA SLICE 7 — MONTHLY FUNDING LADDER.
 *
 * The Month lens shows the three-step Forecast-owned funding ladder:
 * Normal life (stage1.result), After planned spending
 * (stage2.dateOrderResult), After debt strategy
 * (stage3.dateOrderResult). Each rung reprints one Forecast-published
 * result verbatim. The page maps the sign of each result to a household
 * word (surplus / deficit / break-even) and keeps the published trust
 * tag. It never computes a transition between rungs, never blames a
 * stage for a change, and never recommends a remedy: the ladder exposes
 * the progression, it does not prescribe one.
 *
 * Stage 2 / Stage 3 read the incumbent date-order decision result — the
 * same semantics the Road Ahead consumer (planningRoadStageResult in
 * planning.js) and the Month verdict already use. The standalone
 * arithmetic identity must never stand in for the decision result, so
 * there is no fallback to stage.result. Missing results fail closed;
 * unavailable is never $0.
 */
function budgetMonthLadderStage(month, stageNum) {
  const stage = month ? month['stage' + stageNum] : null;
  const fallbackLabel = stageNum === 1 ? 'Normal life'
    : stageNum === 2 ? 'After planned spending' : 'After debt strategy';
  const label = (stage && stage.label) || fallbackLabel;
  const published = stage
    ? (stageNum === 1 ? stage.result : stage.dateOrderResult)
    : null;
  if (!published || published.status === 'unavailable'
      || published.amount == null || !isFinite(Number(published.amount))) {
    // Reprint Forecast's published reason wherever it lives: on the result
    // itself, or on the stage when the decision result was never published.
    const reason = (published && published.reason)
      || (stage && stage.reason)
      || 'Forecast did not publish this stage result.';
    return { label, result: null, reason };
  }
  return { label, result: published };
}

function budgetMonthLadderRungHtml(rung, index) {
  const stepWord = index === 0 ? '1' : index === 1 ? '2' : '3';
  const label = (rung && rung.label) || 'Stage result';
  if (!rung || !rung.result) {
    const reason = (rung && rung.reason) || 'Forecast did not publish this stage result.';
    return `<div class="budget-month-ladder-rung unavailable" data-budget-month-ladder="unavailable">`
      + `<span class="budget-month-ladder-step" aria-hidden="true">${stepWord}</span>`
      + `<span class="budget-month-ladder-label">${label}</span>`
      + `<span class="budget-month-unavailable">unavailable — ${reason} Not $0.</span></div>`;
  }
  const amount = Number(rung.result.amount);
  const word = amount > 0 ? 'projected surplus' : amount < 0 ? 'projected deficit' : 'break-even';
  const sign = amount > 0 ? 'surplus' : amount < 0 ? 'deficit' : 'neutral';
  const tag = budgetMonthTrustTag(rung.result.status) || '';
  // The sign prefix and word are presentation formatting of the
  // Forecast-published figure's sign — the page computes no transition
  // between rungs and no delta from any component.
  const displayAmount = amount > 0 ? `+${money2(amount)}`
    : amount < 0 ? `−${money2(Math.abs(amount))}` : money2(0);
  return `<div class="budget-month-ladder-rung" data-budget-month-ladder="${sign}">`
    + `<span class="budget-month-ladder-step" aria-hidden="true">${stepWord}</span>`
    + `<span class="budget-month-ladder-label">${label}</span>`
    + `<span class="budget-month-ladder-amount">${displayAmount} <span class="budget-month-ladder-word">${word}</span>${tag}</span></div>`;
}

function budgetMonthLadderHtml(month) {
  const monthLabel = (month && (budgetMonthName(month.month) || month.month)) || 'this month';
  const rungs = [1, 2, 3].map(n => budgetMonthLadderStage(month, n));
  return `<div class="budget-month-ladder" data-budget-month-ladder-view="${month && month.month ? month.month : 'unavailable'}">`
    + `<div class="budget-month-ladder-title">How ${monthLabel} holds together</div>`
    + rungs.map((rung, i) => budgetMonthLadderRungHtml(rung, i)).join('')
    + `<p class="operating-note">Each step is one Forecast-published monthly result, shown in order. This page does not add or compare the steps.</p></div>`;
}

function budgetMonthVerdictHtml(month) {
  const stage3 = month && month.stage3;
  // AMANDA SLICE 3 repair (Systems Review BLOCKING on PR #441): the Month
  // decision surface reads Forecast's household-facing date-order result,
  // not the standalone arithmetic identity. An earlier-in-month funding
  // shortfall can make the date-order result a deficit while the
  // arithmetic result is a surplus. Fail closed when Forecast did not
  // publish the decision result.
  const result = stage3 && stage3.dateOrderResult;
  if (!result || result.status === 'unavailable' || result.amount == null || !isFinite(Number(result.amount))) {
    const reason = result && result.reason ? result.reason : 'Forecast did not publish a monthly result.';
    return `<div class="budget-month-verdict unavailable" data-budget-month-verdict="unavailable">`
      + `<span class="budget-month-verdict-label">Monthly surplus / deficit</span>`
      + `<span class="budget-month-unavailable">unavailable — ${reason} Not $0.</span></div>`;
  }
  const amount = Number(result.amount);
  const isSurplus = amount > 0;
  const isDeficit = amount < 0;
  const label = isSurplus ? 'Monthly surplus' : isDeficit ? 'Monthly deficit' : 'Monthly balance';
  const sign = isSurplus ? 'surplus' : isDeficit ? 'deficit' : 'neutral';
  const tag = budgetMonthTrustTag(result.status) || '';
  // The amount is Forecast stage3.dateOrderResult copied verbatim — the
  // page does not calculate it. The sign prefix is presentation formatting
  // of that figure.
  const displayAmount = isSurplus ? `+${money2(amount)}` : isDeficit ? `−${money2(Math.abs(amount))}` : money2(0);
  return `<div class="budget-month-verdict" data-budget-month-verdict="${sign}">`
    + `<span class="budget-month-verdict-label">${label}</span>`
    + `<span class="budget-month-verdict-amount">${displayAmount}${tag}</span></div>`;
}

// AMANDA SLICE 8 — MONTHLY FUNDING PRESSURE DETAIL.
// Beneath the Forecast-owned monthly picture, the Month lens names the known
// planned costs with Forecast cash dates in the selected month. It reprints
// AMANDA SLICE 8 — MONTHLY FUNDING PRESSURE DETAIL. The Month lens names
// the known planned costs with Forecast cash dates in the selected month,
// reprinting Forecast's planSpendPaydayFunding publication — label,
// amount, cash date, funding state, next scheduled contribution, projected
// fully-funded date, trust — filtered to the selected calendar month.
//
// P1 REPAIR (Systems Review BLOCKING on PR #446): the detail is computed
// for the same active inputs as the selected Month trajectory. It is NOT
// read from the earlier advice/recommendation context: Forecast.recommend
// runs at the recommended weekly, while the Month trajectory (and the
// re-simulated pay-period sim) honour the active weekly override — so the
// advice publication can carry different inputs, and the month and its
// detail could disagree. budgetMonthPlanSpendSchedule runs the incumbent
// Forecast publication chain (simulate -> fundingSequence -> majorPlans ->
// planSpendPaydayFunding) on the trajectory's own knob inputs; the page
// passes inputs, Forecast computes. No page-side funding math. The
// schedule is cached on the same input key as the trajectory so the two
// cannot drift apart when the active inputs change.
//
// Month membership comes ONLY from each cost's Forecast-published cash date
// (cost.date sliced to YYYY-MM). The page invents no allocation rule and
// asserts no causal claim: the block describes these as costs cash-dated in
// the selected month, never as "the costs causing this month's pressure",
// and it states plainly that costs outside the month can also affect the
// month's funding result. Forecast's publication order is kept — the page
// does not rank, sort, score, or compute. Missing or untrusted publications
// fail closed; unavailable is never $0.
function budgetMonthPlanSpendSchedule(src, operatingRate = false) {
  if (!src || !src.plan) return null;
  const asOf = src.asOf || (src.meta && src.meta.asOf);
  if (!asOf) return null;
  if (src.plan.savingsEarmarks?.allocationPolicy != null || src.advice?.savingsFunding != null) {
    return Forecast.savingsFundingPublication(src.advice?.savingsFunding, { asOf, advice: src.advice })?.schedule || { status: 'unavailable', source: 'Forecast.planSpendPaydayFunding',
      reason: 'The shared Forecast savings publication is unavailable.', paydays: [], costs: [], gap: null };
  }
  // The trajectory's own inputs — the selected weekly override included.
  const knobOpts = budgetMonthKnobOpts(src);
  const key = budgetTrajectoryCacheKeyFor(asOf, src.plan, knobOpts)
    + (operatingRate ? '|operating-cap' : '');
  if (budgetMonthScheduleCache && budgetMonthScheduleCacheKey === key) return budgetMonthScheduleCache;
  let resolvedOpts = knobOpts;
  if (!operatingRate) {
    const trajectory = budgetTrajectoryFor(src);
    const spending = trajectory && trajectory.weeklyVariable;
    if (!trajectory || trajectory.status !== 'ready' || !spending
        || typeof spending.amount !== 'number' || !Number.isFinite(spending.amount)
        || spending.amount < 0
        || (spending.status !== 'calculated' && spending.status !== 'estimated')) {
      return { status: 'unavailable', source: 'Forecast.planSpendPaydayFunding',
        reason: (trajectory && trajectory.reason) || 'Forecast did not publish a spending basis. Not $0.',
        paydays: [], costs: [], gap: null };
    }
    // Copy the secondary trajectory's resolved rate. simulate defaults an
    // absent rate to zero, so raw cap inputs cannot be reused after Forecast
    // has rejected an unsupported recommendation. The main payday shell
    // keeps its incumbent selected-cap allocation path, with a separate key.
    resolvedOpts = Object.assign({}, knobOpts, {
      weeklyVariable: spending.amount, weeklyVariableBasis: spending,
    });
  }
  let schedule = null;
  try {
    // The walk runs over Forecast's knowledge horizon, mirroring how
    // recommend sizes the sim behind the advice publication.
    const horizon = Forecast.knowledgeHorizon(src.plan, asOf, resolvedOpts);
    const walkOpts = horizon && horizon.days > 0
      ? Object.assign({}, resolvedOpts, { horizonDays: horizon.days, viewDays: horizon.days })
      : resolvedOpts;
    const sim = Forecast.simulate(src.plan, asOf, walkOpts);
    const seq = Forecast.fundingSequence(src.plan, asOf, resolvedOpts);
    const plans = Forecast.majorPlans(src.plan, asOf, resolvedOpts);
    // P1 REPAIR (Systems Review BLOCKING on PR #446, second finding): the
    // live payday must reuse the incumbent paydayAllocation as the named
    // authority rather than a second FIFO attribution — the per-cost
    // nextContribution and projectedFullyFunded fields are produced from
    // those allocations. The allocation is computed here from the SAME
    // Month inputs (never the advice context's, which can carry the
    // recommended weekly instead of the selected override). Its
    // reconciliation checks fail the schedule closed when the two
    // authorities cannot agree — that is Forecast's own verdict, reprinted
    // as unavailable, never worked around page-side.
    const alloc = Forecast.paydayAllocation(src.plan, asOf,
      Object.assign({}, resolvedOpts, { majorPlans: plans }));
    schedule = Forecast.planSpendPaydayFunding(src.plan, asOf, sim, seq, plans, alloc);
    // Names remain evidence even when savings/funding calculations are withheld.
    // This is Forecast's original ordered roster, not a page-derived goal plan.
    if (schedule) schedule = Object.assign({}, schedule, { fundingRoster: seq });
    // Enrich only the schedule's own published undated roster with the
    // matching fundingSequence metadata. Today may be withheld independently;
    // its roster is not authority for the exact payday. No amount is summed,
    // allocated, or inferred, and an undated contribution remains unknown.
    if (schedule && Array.isArray(schedule.unscheduled)) schedule = Object.assign({}, schedule, {
      unscheduled: schedule.unscheduled.map(row => {
        const source = seq.find(cost => cost.id === row.id);
        return Object.assign({}, row, { reason: row.reason === 'cash-date-not-established'
          ? 'Planning date not established.' : row.reason, label: source?.label, cost: source?.need,
          confidence: source?.confidence, date: source?.date, contribution: null });
      }),
    });
  } catch (e) {
    schedule = null;
  }
  budgetMonthScheduleCache = schedule;
  budgetMonthScheduleCacheKey = key;
  return schedule;
}

// Pure reprint: renders one Forecast planSpendPaydayFunding publication
// for the selected month. The cost's own amount and date carry the cost's
// published confidence. P1 REPAIR (Systems Review BLOCKING on PR #446):
// the projected funding fields (next contribution, projected fully-funded
// date) are funding-path projections — a confirmed cost can still have an
// estimated funding path — so they carry Forecast's schedule-level
// fundingTrust, never the cost's confidence. Unpublished funding trust
// fails the projected fields closed: they are not shown untagged.
function budgetMonthFundingPressureHtml(month, schedule) {
  const monthKey = month && month.month;
  const monthLabel = (monthKey && (budgetMonthName(monthKey) || monthKey)) || 'the selected month';
  const open = key => `<div class="budget-month-funding-pressure" data-budget-month-funding-pressure="${key}">`
    + `<p class="operating-lead">Planned costs in view</p>`;
  const scopeNote = `<p class="operating-note">Known planned costs with Forecast cash dates in ${monthLabel}, `
    + `listed in Forecast's publication order. Only costs cash-dated in ${monthLabel} are listed — `
    + `costs outside this month can also affect the month's funding result.</p>`;
  if (!monthKey || !schedule || schedule.status === 'unavailable' || !Array.isArray(schedule.costs)) {
    return open('unavailable') + scopeNote
      + `<div class="operating-lines"><div class="operating-line"><span>Funding detail</span>`
      + `<span>unavailable — Forecast did not publish the planned-spending schedule. This is not $0.</span></div></div></div>`;
  }
  // Membership is the published cash date, nothing else. A cost is in view
  // exactly when its Forecast cash date falls in the selected calendar
  // month. No page-side date arithmetic: the YYYY-MM prefix is the
  // publication's own date string.
  const inView = schedule.costs.filter(cost =>
    cost && typeof cost.date === 'string' && cost.date.slice(0, 7) === monthKey);
  if (!inView.length) {
    return open(monthKey) + scopeNote
      + `<div class="operating-lines"><div class="operating-line"><span>Planned costs</span>`
      + `<span>Forecast published no planned costs with cash dates in ${monthLabel}.</span></div></div></div>`;
  }
  const fmtCashDate = iso => {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
    try { return fmtDateLong(iso); } catch (e) { return null; }
  };
  // Per-cost trust is the cost's published confidence, reprinted for the
  // cost's own amount and date — never promoted. Unpublished confidence
  // fails the cost's figures closed.
  const costTrustTag = confidence => confidence === 'estimated'
    ? ' <span class="trust-tag trust-estimated">estimate</span>'
    : confidence === 'confirmed'
      ? ' <span class="trust-tag">confirmed</span>' : null;
  // Projected-field trust (P1 repair): the funding-path projections carry
  // the schedule's fundingTrust, never the cost's confidence. Unpublished
  // funding trust fails the projected fields closed.
  const fundingTrustTag = schedule.fundingTrust === 'estimated'
    ? ' <span class="trust-tag trust-estimated">estimate</span>'
    : schedule.fundingTrust === 'calculated'
      ? ' <span class="trust-tag">calculated</span>' : null;
  const fundingStateWord = verdict => verdict === 'ON TRACK' ? 'On track'
    : verdict === 'AT RISK' ? 'At risk'
      : verdict === 'FUNDING GAP' ? 'Funding gap' : null;
  const lines = inView.map(cost => {
    const label = typeof cost.label === 'string' && cost.label.length ? cost.label : cost.id;
    const tag = costTrustTag(cost.confidence);
    const neededBy = fmtCashDate(cost.date);
    const head = `<div class="operating-line" data-budget-month-cost="${cost.id}">`
      + `<span>${label}</span><span>${neededBy ? `Needed by ${neededBy}` : 'Needed by — date not published'}</span></div>`;
    if (tag == null) {
      return head + `<div class="operating-line"><span>Funding detail</span>`
        + `<span>unavailable — trust not published. This is not $0.</span></div>`;
    }
    const amount = Number(cost.baseRequirement);
    const amountLine = !isFinite(amount)
      ? `<div class="operating-line"><span>Amount</span><span>unavailable — not published.</span></div>`
      : `<div class="operating-line"><span>Amount</span><span>${money2(amount)}${tag}</span></div>`;
    const stateWord = fundingStateWord(cost.verdict);
    const stateLine = stateWord == null
      ? `<div class="operating-line"><span>Funding state</span><span>unavailable — not published.</span></div>`
      : `<div class="operating-line"><span>Funding state</span><span>${stateWord}</span></div>`;
    // The page states only the reprintable fact about the funding path.
    // "none scheduled" is the honest wording when Forecast publishes no
    // next contribution: a future cost with no scheduled funding is not
    // "not required", and the publication carries no reason to assert.
    // The projected fields carry the schedule's funding trust — never the
    // cost's confidence (P1 repair): a confirmed cost can have an
    // estimated funding path. Without published funding trust the path
    // cannot be characterised, so the projected fields fail closed.
    const next = cost.nextContribution;
    const nextAmount = next ? Number(next.amount) : null;
    const nextWhen = next ? fmtCashDate(next.payday) : null;
    let nextLine;
    if (fundingTrustTag == null) {
      nextLine = `<div class="operating-line"><span>Next scheduled contribution</span><span>unavailable — trust not published. This is not $0.</span></div>`;
    } else if (next == null) {
      nextLine = `<div class="operating-line"><span>Next scheduled contribution</span><span>none scheduled</span></div>`;
    } else if (!isFinite(nextAmount) || nextWhen == null) {
      nextLine = `<div class="operating-line"><span>Next scheduled contribution</span><span>unavailable — not published.</span></div>`;
    } else {
      nextLine = `<div class="operating-line"><span>Next scheduled contribution</span><span>${money2(nextAmount)}${fundingTrustTag} on ${nextWhen}</span></div>`;
    }
    const fundedBy = fmtCashDate(cost.projectedFullyFunded);
    let fundedByLine;
    if (fundingTrustTag == null) {
      fundedByLine = `<div class="operating-line"><span>Projected funded by</span><span>unavailable — trust not published.</span></div>`;
    } else if (fundedBy == null) {
      fundedByLine = `<div class="operating-line"><span>Projected funded by</span><span>not published</span></div>`;
    } else {
      fundedByLine = `<div class="operating-line"><span>Forecast projects fully funded by</span><span>${fundedBy}${fundingTrustTag}</span></div>`;
    }
    return head + amountLine + stateLine + nextLine + fundedByLine;
  }).join('');
  return open(monthKey) + scopeNote + `<div class="operating-lines">${lines}</div></div>`;
}

function budgetMonthViewHtml(src, headerOwnsPicker = false) {
  const traj = budgetTrajectoryFor(src);
  if (!traj || traj.status !== 'ready') {
    const reason = (traj && traj.reason) || 'Forecast could not publish the baseline trajectory.';
    return `<div class="budget-month-view" data-budget-month-view="unavailable">`
      + `<div class="note-box crit">${reason}</div>`
      + `<p class="operating-note">Monthly planning is unavailable. This is not $0.</p></div>`;
  }
  const months = Array.isArray(traj.months) ? traj.months : [];
  if (!months.length) {
    return `<div class="budget-month-view" data-budget-month-view="unavailable">`
      + `<div class="note-box crit">Forecast published no calendar months in this projection.</div></div>`;
  }
  if (!budgetSelectedMonth || !months.some(m => m && m.month === budgetSelectedMonth)) {
    budgetSelectedMonth = months[0].month;
  }
  const month = months.find(m => m && m.month === budgetSelectedMonth) || months[0];
  const monthLabel = budgetMonthName(month.month) || month.month;
  const picker = `<label class="budget-month-picker"><span class="budget-month-picker-label">Month</span> `
    + `<select class="budget-month-select" data-budget-month-picker aria-label="Calendar month for Budget month view">`
    + months.map(m => {
      const label = budgetMonthName(m.month) || m.month;
      return `<option value="${m.month}"${m.month === month.month ? ' selected' : ''}>${label}</option>`;
    }).join('')
    + `</select></label>`;
  const s1 = month.stage1 || {};
  const s2 = month.stage2 || {};
  const s3 = month.stage3 || {};
  // Each row copies one Forecast-published component. Bills and required debt
  // payments stay separate rows — the page never sums them. Total income is
  // the Stage 1 funding-decomposition income (stage1.income), which belongs
  // to the same decomposition as the bills, obligations, household budget,
  // commitments, extras and verdict rows — not the separate calendar-window
  // month.income (Systems Review BLOCKING on PR #441).
  const rows = [
    budgetMonthComponentRow('Total income', s1.income),
    budgetMonthComponentRow('Regular household spending', s1.householdBudget),
    budgetMonthComponentRow('Bills', s1.bills),
    budgetMonthComponentRow('Required debt payments', s1.obligations),
    budgetMonthComponentRow('Planned spending', s2.commitments),
  ];
  // Extra debt payment appears only when Forecast actually publishes it.
  if (s3.extras && s3.extras.status !== 'unavailable') {
    rows.push(budgetMonthComponentRow('Planned extra debt payment', s3.extras));
  }
  const standaloneNote = 'Each month funds itself — Forecast does not carry a prior month\u2019s surplus into this month\u2019s result.';
  return `<div class="budget-month-view" data-budget-month-view="${month.month}">`
    + (headerOwnsPicker ? '' : `<div class="budget-month-head">${picker}</div>`)
    + `<p class="operating-note">How we are planning ${monthLabel}, copied from Forecast. This page does not calculate these figures.</p>`
    + `<div class="budget-month-rows">${rows.join('')}</div>`
    + budgetMonthLadderHtml(month)
    + budgetMonthVerdictHtml(month)
    + budgetMonthFundingPressureHtml(month, budgetMonthPlanSpendSchedule(src))
    + `<p class="operating-note">${standaloneNote}</p></div>`;
}

function budgetMonthSurfaceHtml(ctx) {
  const trajectory = budgetTrajectoryFor(ctx);
  const months = trajectory?.status === 'ready' && Array.isArray(trajectory.months) ? trajectory.months : [];
  if (!months.length) return budgetMonthViewHtml(ctx, true);
  if (!months.some(month => month.month === budgetSelectedMonth)) budgetSelectedMonth = months[0].month;
  const month = months.find(row => row.month === budgetSelectedMonth);
  const monthSchedule = budgetMonthPlanSpendSchedule(ctx);
  const monthPayday = monthSchedule?.asOf === ctx.asOf && isValidIsoCalendarDate(monthSchedule?.paydays?.[0]?.payday)
    && monthSchedule.paydays[0].payday >= ctx.asOf ? monthSchedule.paydays[0].payday : null;
  const label = budgetMonthName(month.month) || month.month;
  const result = month.stage3?.dateOrderResult;
  const known = budgetV3Known(result?.amount, result?.status);
  const signed = (amount, trust) => budgetV3Known(amount, trust)
    ? (amount > 0 ? '+' : '') + budgetV3Money(amount, trust) : budgetV3Money(null, trust);
  const components = [ ['Total income', month.stage1?.income], ['Regular household spending', month.stage1?.householdBudget],
    ['Bills', month.stage1?.bills], ['Required debt payments', month.stage1?.obligations], ['Planned spending', month.stage2?.commitments] ];
  if (month.stage3?.extras && month.stage3.extras.status !== 'unavailable') components.push(['Planned extra debt payment', month.stage3.extras]);
  const scale = month.stage1?.income;
  const scaleKnown = budgetV3Known(scale?.amount, scale?.status) && scale.amount > 0;
  const rungs = [1, 2, 3].map((stage, index) => {
    const rung = budgetMonthLadderStage(month, stage);
    const amount = rung.result?.amount, trust = rung.result?.status;
    const valid = budgetV3Known(amount, trust);
    const sign = valid ? amount < 0 ? 'deficit' : amount > 0 ? 'surplus' : 'neutral' : 'unavailable';
    return `<div class="budget-v3-month-rung" data-budget-month-ladder="${sign}"><span class="budget-v3-month-step">${stage}</span><div><div class="budget-v3-month-rung-head"><strong>${budgetV3Escape(rung.label)}</strong><b>${signed(amount, trust)}</b></div><p>${['Income less household spending, bills and required debt', "Then the month's named costs", 'Then any planned extra debt payment'][index]}</p><div class="budget-v3-month-axis${!valid || !scaleKnown ? ' is-unknown' : ''}" aria-hidden="true">${valid && scaleKnown ? `<i class="${sign}" style="width:${Math.min(50, Math.abs(amount) / scale.amount * 50)}%"></i>` : ''}</div><p>${valid ? amount < 0 ? 'Projected deficit' : amount > 0 ? 'Projected surplus' : 'Break-even' : budgetV3Escape(rung.reason || rung.result?.reason || 'Forecast did not publish a trusted result. Not $0.')}</p></div></div>`;
  }).join('');
  const current = (ctx.advice?.payPeriodViews || []).find(row => row?.timelineRole === 'current');
  // This incumbent field publishes explicit null for fully calculated results.
  // Missing/undefined trust still withholds; the generic money guard stays strict.
  const currentTrust = current?.balanceAfterDeductionsTrust === null
    ? 'calculated' : current?.balanceAfterDeductionsTrust;
  const compare = current ? `<div class="budget-v3-month-compare"><div><span>Current pay period · before funding</span><strong>${budgetV3Money(current.afterHouseholdBudget, currentTrust)}</strong><p>${budgetV3Escape(current.rangeLabel || `${current.start} — ${current.end}`)}</p></div><span aria-hidden="true">vs</span><div><span>${budgetV3Escape(label)} · after debt strategy</span><strong>${signed(result?.amount, result?.status)}</strong><p>${budgetV3Escape(month.start)} — ${budgetV3Escape(month.end)}</p></div></div><p>Separate windows and steps.</p>` : '';
  // Each outflow has its own ratio to published income. No combined outflow
  // total/denominator is calculated; overflow is visible rather than normalized.
  const flow = `<div class="budget-v3-month-flow" aria-hidden="true"><span>IN</span><div><i class="flow-0${!scaleKnown ? ' is-unknown' : ''}" style="width:${scaleKnown ? 100 : 0}%"></i></div><span>OUT</span><div>${components.slice(1).map(([name, component], index) => `<i class="flow-${index + 1}${!scaleKnown || !budgetV3Known(component?.amount, component?.status) ? ' is-unknown' : ''}" style="width:${scaleKnown && budgetV3Known(component?.amount, component?.status) ? Math.min(100, Math.max(0, component.amount) / Math.abs(scale.amount) * 100) : 0}%"></i>`).join('')}</div></div>`;
  const reading = [
    ['≈ Estimate', 'At least one input is estimated. Each amount keeps its published trust.'],
    ['Calculated', 'A Forecast label, not independent verification. No estimate mark is added.'],
    ['Pending', 'A payment in flight, not settled. Its evidence stays in the details.'],
    ['Not confirmed', 'Settlement is not established. It may already be paid; check before paying again.'],
    ['Unknown / unavailable', 'Forecast did not publish a trusted figure. Never shown as $0; bars are hatched.'],
    ['Withheld', 'The proposal waits for evidence. Open the complete funding evidence for reasons and next steps.'],
    ['Not set up', 'Starting savings assignments need household evidence. Unknown balances remain unknown.'],
    ['None scheduled', 'A published answer for that schedule, not permission to spend.'],
  ].map(([name, explanation]) => `<p><b>${budgetV3Escape(name)}</b><span>${budgetV3Escape(explanation)}</span></p>`).join('');
  return `<div class="budget-month-view budget-v3-month" data-budget-month-view="${month.month}">
    <nav class="budget-section-nav budget-month-shortcuts" aria-label="Month sections">
      <button type="button" data-budget-month-section="result" aria-controls="budget-month-result">Result</button>
      <button type="button" data-budget-month-section="flow" aria-controls="budget-month-flow">In &amp; out</button>
      <button type="button" data-budget-month-section="costs" aria-controls="budget-month-costs">Costs this month</button>
    </nav>
    <div class="budget-v3-month-top"><section class="budget-surface-card" data-budget-month-section-target="result"><p class="budget-surface-eyebrow">${budgetV3Escape(label)} · Published projection window</p><div class="budget-month-verdict" data-budget-month-verdict="${known ? result.amount < 0 ? 'deficit' : result.amount > 0 ? 'surplus' : 'neutral' : 'unavailable'}"><h2 id="budget-month-result" tabindex="-1" data-budget-month-section-heading="result">${known ? result.amount < 0 ? 'Monthly deficit' : result.amount > 0 ? 'Monthly surplus' : 'Monthly balance' : 'Monthly result unavailable'}</h2><p class="budget-v3-month-hero">${signed(result?.amount, result?.status)}</p></div><p>${known ? 'After planned spending and debt strategy.' : budgetV3Escape(result?.reason || 'Forecast did not publish a trusted result. This is not $0.')}</p>${compare}<p>Each month funds itself. No prior-month surplus carries into this result.</p></section>
    <section class="budget-surface-card" data-budget-month-ladder-view="${month.month}"><p class="budget-surface-eyebrow">How ${budgetV3Escape(label)} holds together</p><h2>Three steps, in order</h2>${rungs}<p>Three separate results published by Forecast.</p></section></div>
    <div class="budget-v3-month-bottom"><section class="budget-surface-card" data-budget-month-section-target="flow"><p class="budget-surface-eyebrow">${budgetV3Escape(label)}</p><h2 id="budget-month-flow" tabindex="-1" data-budget-month-section-heading="flow">Money in and out</h2><p>Bars are scaled to published income.</p>${flow}<div class="budget-month-rows">${components.map(([name, component], index) => `<div class="budget-v3-month-component flow-${index}">${budgetMonthComponentRow(name, component, index > 0)}</div>`).join('')}</div></section>
    <section class="budget-surface-card" data-budget-month-section-target="costs"><p class="budget-surface-eyebrow">Cash-dated in ${budgetV3Escape(label)}</p><h2 id="budget-month-costs" tabindex="-1" data-budget-month-section-heading="costs">Planned costs this month</h2>${budgetMonthFundingPressureHtml(month, monthSchedule)}<footer class="budget-month-funding-link"><p>The Month-input funding schedule starts at the current opening. It is separate from today's proposal.</p><button type="button" class="budget-surface-link" data-budget-month-funding-open aria-haspopup="dialog">${monthPayday ? 'See ' + budgetV3Escape(fmtDate(monthPayday)) + ' funding plan' : 'Complete Month funding evidence'}</button></footer><div data-budget-month-funding-evidence hidden>${budgetPayPeriodFundingPlanHtml(monthPayday ? { payday: monthPayday } : null, ctx)}</div></section></div>
    <details class="budget-v3-reading" data-budget-reading-info><summary>Reading the numbers <span aria-hidden="true">ⓘ</span></summary><div class="budget-surface-card">${reading}</div></details>
  </div>`;
}

/* AMANDA SLICE 9 — SAME-MONTH PAY-PERIOD DRILLDOWN.
 *
 * The household selected a calendar month to understand that month.
 * Switching to Pay Period keeps that context: the drilldown shows the
 * complete Forecast-published Seaspan pay-period cycles overlapping
 * the anchored month, in Forecast's publication order, each with its
 * published three-stage funding result reprinted verbatim.
 *
 * Authority boundary: the page selects (overlap on the published
 * full-cycle identity), labels, formats and reprints. It never clips a
 * cycle to month boundaries, never prorates, never sums cycles, never
 * derives stages, never recomputes surplus/deficit, and never implies
 * the cycles sum to the calendar-month total. Trust is reprinted:
 * estimated stays estimated, unavailable is never $0. */

// True only when the household reached Pay Period from the Month lens.
// The default landing (no anchor) keeps the incumbent generic payday
// operating picture, unchanged.
function budgetInPayPeriodDrilldown() {
  return budgetGranularity === 'pay-period' && !!budgetPayPeriodAnchorMonth;
}

// Last YYYY-MM-DD of the month key. Presentation date math for overlap
// selection only — no financial allocation.
function budgetMonthEndDay(monthKey) {
  const y = Number(String(monthKey).slice(0, 4));
  const m = Number(String(monthKey).slice(5, 7));
  if (!y || !(m >= 1 && m <= 12)) return null;
  const last = new Date(y, m, 0).getDate();
  return `${String(monthKey).slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

// The overlapping cycles, in Forecast publication order. Overlap is
// tested on the published full-cycle identity (cycleStart/cycleEnd), so
// a cycle that starts in the prior month or ends in the next month is
// selected whole — never clipped to the month.
function budgetDrilldownPeriods(traj, anchorMonth) {
  const periods = traj && Array.isArray(traj.payPeriods) ? traj.payPeriods : [];
  if (!anchorMonth || anchorMonth.length < 7) return [];
  const monthStart = `${anchorMonth.slice(0, 7)}-01`;
  const monthEnd = budgetMonthEndDay(anchorMonth);
  if (!monthEnd) return [];
  return periods.filter(p => {
    if (!p) return false;
    const s = p.cycleStart || p.start;
    const e = p.cycleEnd || p.end;
    return typeof s === 'string' && typeof e === 'string'
      && s <= monthEnd && e >= monthStart;
  });
}

function budgetDrilldownStageHtml(stage) {
  const label = (stage && stage.label) || 'Stage';
  const result = (stage && stage.result) || {};
  // Strict validation, no coercion: the result amount must be a real finite
  // number (false/""/null are malformed data, never $0) and the trust
  // state must be explicitly published. Anything else fails closed.
  if (!stage || stage.status === 'unavailable' || result.status === 'unavailable'
      || typeof result.amount !== 'number' || !Number.isFinite(result.amount)
      || (result.status !== 'calculated' && result.status !== 'estimated')) {
    const reason = result.reason || (stage && stage.reason)
      || 'Forecast did not publish this stage.';
    return `<div class="budget-month-row unavailable" data-budget-drilldown-stage="unavailable">`
      + `<span class="budget-month-label">${label}</span>`
      + `<span class="budget-month-unavailable">unavailable — ${reason} Not $0.</span></div>`;
  }
  const amount = result.amount;
  const tag = budgetMonthTrustTag(result.status) || '';
  // Sign prefix is presentation formatting of the reprinted figure.
  const display = amount > 0 ? `+${money2(amount)}`
    : amount < 0 ? `\u2212${money2(Math.abs(amount))}` : money2(0);
  const kind = amount > 0 ? 'surplus' : amount < 0 ? 'deficit' : 'balance';
  const kindLabel = amount > 0 ? 'projected surplus' : amount < 0 ? 'projected deficit' : 'projected balance';
  return `<div class="budget-month-row" data-budget-drilldown-stage="${kind}">`
    + `<span class="budget-month-label">${label}</span>`
    + `<span class="budget-month-amount">${display} ${kindLabel}${tag}</span></div>`;
}

// Forecast's truthful published window identity for one pay-period row.
// A complete cycle keeps its full-cycle label. A clipped row (as-of
// residual, horizon-clipped) is labelled with its actual published
// window (rangeLabel) — never the full-cycle range — so partial-window
// figures cannot read as whole-cycle figures. Returns null when the row
// carries no truthful identity; callers fail closed on null.
function budgetDrilldownPeriodLabel(period) {
  if (!period) return null;
  if (period.windowKind === 'full-cycle') {
    return period.cycleRangeLabel || period.rangeLabel
      || period.payday || period.id || null;
  }
  return period.rangeLabel || null;
}

function budgetDrilldownPeriodHtml(period, src) {
  const key = (period && (period.payday || period.id)) || 'unknown';
  const label = budgetDrilldownPeriodLabel(period);
  if (!label) {
    // Fail closed: figures without a truthful window identity are never
    // shown under a guessed label, and never as $0.
    return `<div class="budget-drilldown-period" data-budget-drilldown-period="${key}">`
      + `<p class="operating-lead">Pay period</p>`
      + `<div class="note-box crit">Forecast did not publish this period's window identity.</div>`
      + `<p class="operating-note">Pay-period detail is unavailable. This is not $0.</p></div>`;
  }
  const stages = [
    budgetDrilldownStageHtml(period.stage1),
    budgetDrilldownStageHtml(period.stage2),
    budgetDrilldownStageHtml(period.stage3),
  ];
  // The sub-note names the window kind Forecast published: a complete
  // cycle is a Seaspan pay cycle; a clipped row is its published window
  // identity (e.g. the as-of residual), never the whole cycle.
  const kindNote = period.windowKind === 'full-cycle'
    ? 'Three-stage funding for this Seaspan pay cycle, copied from Forecast.'
    : `Three-stage funding for this ${(period.displayIdentity || 'partial pay-period window').toLowerCase()} (${label}), copied from Forecast.`;
  return `<div class="budget-drilldown-period" data-budget-drilldown-period="${key}">`
    + `<p class="operating-lead">${label}</p>`
    + `<p class="operating-note">${kindNote} This page does not calculate these figures.</p>`
    + `<div class="budget-month-rows">${stages.join('')}</div>`
    + budgetPayPeriodMoneyMapHtml(period)
    + budgetPayPeriodFundingPlanHtml(period, src)
    + budgetPayPeriodFundingShortfallHtml(period, src)
    + `</div>`;
}

/* AMANDA SLICE 10 — SELECTED PAY-PERIOD MONEY MAP.
 *
 * The Slice 9 drilldown selects one Forecast-published pay-period row. The
 * money map explains what is inside that row's three-stage result: it
 * reprints the Forecast-published component totals (income, household
 * budget, bills, obligations, commitments, extras) and, when Forecast
 * publishes them, the component line items in Forecast publication order.
 *
 * Authority boundary: the page selects the exact row Slice 9 selected,
 * labels, formats and reprints. It never subtracts income from costs, never
 * sums line items to reproduce a component total, never derives a missing
 * total, never classifies a payment independently, never names a debt
 * target Forecast did not publish for this row (stage3.extras carries an
 * amount only), and never explains or prescribes: no causal language, no
 * recommendations. A clipped/residual row keeps its clipped identity —
 * every figure belongs to the row's published window, never the full cycle.
 * Trust is reprinted per figure: a line keeps its own status, never the
 * parent's. Unavailable is never $0.
 */

// One Forecast-published line item: its label, its amount, and its own
// trust tag. The line never inherits the parent component's trust.
// Present-but-malformed line data (wrong-type amount, missing trust)
// fails closed visibly: an incomplete breakdown must never look complete,
// and never $0. Genuinely absent lines (no lines array) render no rows.
function budgetDrilldownLineHtml(line) {
  const label = line && typeof line.label === 'string' && line.label ? line.label : null;
  const amount = line ? line.amount : undefined;
  const trustOk = !!line && (line.status === 'calculated' || line.status === 'estimated');
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !trustOk) {
    return `<div class="budget-month-row unavailable" data-budget-drilldown-line="unavailable">`
      + `<span class="budget-month-label">${label || 'Line item'}</span>`
      + `<span class="budget-month-unavailable">unavailable — Forecast did not publish this line item. Not $0.</span></div>`;
  }
  const tag = budgetMonthTrustTag(line.status) || '';
  return `<div class="budget-month-row budget-drilldown-line" data-budget-drilldown-line="named">`
    + `<span class="budget-month-label">${line.label}</span>`
    + `<span class="budget-month-amount">${money2(amount)}${tag}</span></div>`;
}

// One Forecast-published component: its total reprinted by the incumbent
// component row (which fails closed on unavailable), followed by its
// published line items in Forecast publication order. The page never sums
// the lines — the total shown is always the published component total.
function budgetDrilldownComponentHtml(label, component) {
  const total = budgetMonthComponentRow(label, component);
  const lines = component && Array.isArray(component.lines) ? component.lines : [];
  return total + lines.map(budgetDrilldownLineHtml).join('');
}

/* AMANDA SLICE 13 — SELECTED PAY-PERIOD DEBT TARGET ATTRIBUTION.
 *
 * The money map answers "where does this pay period's extra debt payment
 * go?" for the exact selected Forecast pay-period row. Forecast owns the
 * answer: the coupled debt walk records the ordered per-debt split from
 * the same payDown cascade that moves the balances, and publishes it on
 * stage3.extras.allocations with a nextTarget continuity conclusion.
 * This renderer is a pure reprint layer:
 *
 * - The published extras amount stays authoritative. The page never sums
 *   allocation lines into the total — a deliberately non-reconciling
 *   publication still shows the published total unchanged.
 * - Allocation lines reprint in Forecast publication order. The page never
 *   ranks, filters, or reorders them, never resolves a debt id itself
 *   (the label is Forecast's own), and never borrows a target from the
 *   current-payday Slice 6 publication or any other period.
 * - Known $0 is "No extra debt payment planned in this pay period" and
 *   never invents a debt target. Unknown/unavailable is never $0.
 * - A missing, non-array, empty, or partially invalid allocations
 *   publication fails the attribution closed as a whole: one explicit
 *   unavailable line, never a partial target list that looks complete.
 */
function budgetExtraDebtAllocationsValid(allocations) {
  if (!Array.isArray(allocations) || !allocations.length) return false;
  const seen = {};
  for (const line of allocations) {
    if (!line || typeof line.debtId !== 'string' || !line.debtId
        || typeof line.label !== 'string' || !line.label
        || typeof line.amount !== 'number' || !Number.isFinite(line.amount)
        || (line.status !== 'calculated' && line.status !== 'estimated')) {
      return false;
    }
    // One entry per debt per payment, by the Forecast publication contract.
    if (seen[line.debtId]) return false;
    seen[line.debtId] = true;
  }
  return true;
}

function budgetExtraDebtNextTargetHtml(extras, allocations) {
  const nt = extras && extras.nextTarget;
  if (!nt || typeof nt !== 'object'
      || typeof nt.debtId !== 'string' || !nt.debtId
      || typeof nt.label !== 'string' || !nt.label
      || (nt.status !== 'calculated' && nt.status !== 'estimated')) {
    return '';
  }
  const lastLabel = allocations[allocations.length - 1].label;
  const tag = budgetMonthTrustTag(nt.status) || '';
  return `<div class="budget-month-row" data-budget-extra-debt-next-target="named">`
    + `<span class="budget-month-label">After ${lastLabel} clears</span>`
    + `<span class="budget-month-amount">${nt.label}${tag}</span></div>`;
}

function budgetDrilldownExtraDebtHtml(extras) {
  const total = budgetDrilldownComponentHtml('Planned extra debt payment', extras);
  // The attribution below only applies when the total rendered as a real
  // published figure. Unavailable stays unavailable; the component row
  // above already said so.
  if (!extras || (extras.status !== 'calculated' && extras.status !== 'estimated')) {
    return total;
  }
  const amount = extras.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return total;
  if (amount === 0) {
    // Known zero: no extra debt payment planned — never invent a target.
    return total
      + `<p class="operating-note" data-budget-extra-debt-target="none">No extra debt payment planned in this pay period.</p>`;
  }
  if (amount < 0) return total;
  const allocations = extras.allocations;
  if (!budgetExtraDebtAllocationsValid(allocations)) {
    return total
      + `<div class="budget-month-row unavailable" data-budget-extra-debt-target="unavailable">`
      + `<span class="budget-month-label">Going to</span>`
      + `<span class="budget-month-unavailable">unavailable — Forecast did not publish which debt this payment goes to. Not $0.</span></div>`;
  }
  return total
    + `<p class="operating-lead">Going to</p>`
    + `<div class="budget-month-rows">`
    + allocations.map(budgetDrilldownLineHtml).join('')
    + budgetExtraDebtNextTargetHtml(extras, allocations)
    + `</div>`;
}

// The money map for the exact selected Forecast pay-period row. `period`
// must be the row object Slice 9 selected — never a re-lookup by cycle
// dates, so a residual row's figures can never be swapped for the
// full-cycle row's figures.
function budgetPayPeriodMoneyMapHtml(period) {
  if (!period) return '';
  const s1 = period.stage1 || {};
  const s2 = period.stage2 || {};
  const s3 = period.stage3 || {};
  const windowLabel = budgetDrilldownPeriodLabel(period) || 'this pay period';
  const groups = [];
  // Money coming in — the Stage 1 income publication, lines when published.
  groups.push(
    `<p class="operating-lead">Money coming in</p>`
    + `<div class="budget-month-rows">`
    + budgetDrilldownComponentHtml('Total income', s1.income)
    + `</div>`
  );
  // Normal life — the Stage 1 outflow components, then the published result.
  groups.push(
    `<p class="operating-lead">${s1.label || 'Normal life'}</p>`
    + `<div class="budget-month-rows">`
    + budgetDrilldownComponentHtml('Regular household spending', s1.householdBudget)
    + budgetDrilldownComponentHtml('Bills', s1.bills)
    + budgetDrilldownComponentHtml('Required debt payments', s1.obligations)
    + budgetDrilldownStageHtml(s1)
    + `</div>`
  );
  // Planned spending — the Stage 2 commitments publication, then the result.
  groups.push(
    `<p class="operating-lead">${s2.label || 'After planned spending'}</p>`
    + `<div class="budget-month-rows">`
    + budgetDrilldownComponentHtml('Planned spending', s2.commitments)
    + budgetDrilldownStageHtml(s2)
    + `</div>`
  );
  // Extra debt strategy — the published extras amount, plus the
  // Forecast-owned debt attribution (Slice 13): which debt(s) this pay
  // period's extra payment actually goes to, in Forecast order, with
  // Forecast's own continuity conclusion when published. The amount stays
  // authoritative; the page never derives it from the allocations.
  const extrasRows = budgetDrilldownExtraDebtHtml(s3.extras);
  groups.push(
    `<p class="operating-lead">${s3.label || 'After debt strategy'}</p>`
    + `<div class="budget-month-rows">`
    + extrasRows
    + budgetDrilldownStageHtml(s3)
    + `</div>`
  );
  return `<div class="budget-drilldown-money-map" data-budget-drilldown-money-map="${(period.payday || period.id || 'unknown')}">`
    + `<p class="operating-lead">What is inside ${windowLabel}</p>`
    + `<p class="operating-note">Each figure below is copied from Forecast for this pay period. This page does not calculate these figures.</p>`
    + groups.join('')
    + `</div>`;
}

/* AMANDA SLICE 11 — SELECTED PAY-PERIOD FUNDING PLAN.
 *
 * Slice 9 selects one Forecast-published pay-period row; Slice 10 maps what
 * happens inside it. Slice 11 answers a different question: what does
 * Forecast plan to earmark FROM this payday toward future planned costs?
 *
 * Authority boundary: the page selects the exact row Slice 9 selected and
 * consumes Forecast.planSpendPaydayFunding through the incumbent Slice 8
 * helper (budgetMonthPlanSpendSchedule), which regenerates the schedule
 * from the SAME active inputs as the selected Month, the Slice 9 pay
 * period, and the Slice 10 money map. The incumbent Forecast chain is
 * never duplicated and no page-side funding arithmetic exists: the
 * contribution is reprinted exactly (never summed from allocations),
 * allocations reprint in Forecast publication order, and every funding
 * figure carries the schedule-level fundingTrust — the row-level trust tag
 * is null for future paydays by Forecast's own contract (only the live
 * payday carries one for the payday instruction shell), and this page
 * never borrows trajectory, cost, Slice 10, or advice-shell trust.
 *
 * Matching is by exact payday only: a funding row renders only when
 * schedule.paydays[] publishes a row whose payday exactly equals the
 * selected pay-period row's payday. There is no nearest-payday fallback,
 * no substitution, no reconstruction. A residual window whose underlying
 * cycle payday predates the current Forecast opening (e.g. Sep 28–Oct 8
 * with cycle payday Sep 25 when the schedule starts Oct 9) fails closed
 * with truthful copy — never $0, never another payday's plan.
 *
 * Wording is planning/earmark only ("Funding plan", "Earmarked in
 * Forecast", "this payday's share of the funding plan"). Never transfer,
 * set-aside, balance, or reserve language: Atlas still has no
 * authoritative prior Nest Money transfer/balance state (Slice 2
 * boundary).
 */

// Exact-payday funding-row lookup. Returns the Forecast-published
// paydays[] row whose payday exactly equals the selected pay-period
// row's payday, or null when Forecast published no such row. Never
// substitutes, interpolates, or falls back to a neighbouring payday.
function budgetPayPeriodFundingRow(schedule, period) {
  const payday = period && (period.payday || period.id);
  if (!payday || !schedule || !Array.isArray(schedule.paydays)) return null;
  return schedule.paydays.find(row => row && row.payday === payday) || null;
}

// One named allocation: reprints label and amount in Forecast publication
// order, each figure carrying the schedule-level fundingTrust tag. A
// present-but-malformed allocation fails closed visibly — an incomplete
// breakdown must never look complete, and never $0. The contribution is
// independent of the lines and is still reprinted exactly.
function budgetPayPeriodFundingLineHtml(allocation, trustTag) {
  const label = allocation && typeof allocation.label === 'string' && allocation.label
    ? allocation.label : null;
  const amount = allocation ? allocation.amount : undefined;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !label) {
    return `<div class="budget-month-row unavailable" data-budget-funding-allocation="unavailable">`
      + `<span class="budget-month-label">${label || 'Planned-cost allocation'}</span>`
      + `<span class="budget-month-unavailable">unavailable — Forecast did not publish this allocation. Not $0.</span></div>`;
  }
  return `<div class="budget-month-row budget-funding-allocation" data-budget-funding-allocation="named">`
    + `<span class="budget-month-label">${label}</span>`
    + `<span class="budget-month-amount">${money2(amount)}${trustTag || ''}</span></div>`;
}

// The funding plan for the exact selected pay-period row. `src` feeds the
// incumbent Slice 8 same-input schedule; `period` is the exact row Slice 9
// selected. Fails closed whenever the schedule is unavailable, the
// schedule's status is not a published one, no exact-payday funding row
// exists, or the contribution/trust is not validly published. A published
// $0 contribution is a known zero — it renders as $0 with its trust tag,
// never as unavailable.
function budgetPayPeriodFundingPlanHtml(period, src) {
  const payday = period && (period.payday || period.id);
  const failClosed = `<div class="budget-drilldown-funding-plan" data-budget-drilldown-funding-plan="unavailable">`
    + `<p class="operating-lead">Future-cost funding</p>`
    + `<p class="operating-note">Funding plan for this payday is unavailable from the current Forecast opening. This is not $0.</p></div>`;
  if (!period || !payday) return failClosed;
  let schedule = null;
  try {
    schedule = budgetMonthPlanSpendSchedule(src);
  } catch (e) {
    schedule = null;
  }
  // Only a genuinely published schedule may render: 'ready' or
  // 'funding-gap' with an explicitly published fundingTrust. Anything
  // else — missing, unavailable, or untrusted — fails closed.
  const trustTag = schedule ? budgetMonthTrustTag(schedule.fundingTrust) : null;
  if (!schedule || (schedule.status !== 'ready' && schedule.status !== 'funding-gap') || !trustTag) return failClosed;
  const row = budgetPayPeriodFundingRow(schedule, period);
  const contribution = row ? row.contribution : undefined;
  // Strict validation, no coercion: the contribution must be a real finite
  // number. false/""/null/strings are malformed data, never $0.
  if (!row || typeof contribution !== 'number' || !Number.isFinite(contribution)) return failClosed;
  // The allocations collection is part of the published contract:
  // Forecast always publishes it as an array on each payday row. A
  // missing or non-array collection is bad publication state — showing
  // the trusted contribution with no named purposes and no warning would
  // make an incomplete answer look complete. Fail closed, visibly. We
  // never sum or reconcile the collection against the contribution.
  if (!Array.isArray(row.allocations)) return failClosed;
  const paydayLabel = fmtDateLong(payday);
  const allocations = row.allocations;
  return `<div class="budget-drilldown-funding-plan" data-budget-drilldown-funding-plan="${payday}">`
    + `<p class="operating-lead">Future-cost funding from the ${paydayLabel} payday</p>`
    + `<p class="operating-note">This payday's share of the funding plan, earmarked in Forecast toward future planned costs. `
    + `This is a planning figure only — it does not move money, and it is not an account balance.</p>`
    + `<div class="budget-month-rows">`
    + `<div class="budget-month-row budget-funding-contribution" data-budget-funding-contribution="published">`
    + `<span class="budget-month-label">Earmarked in Forecast</span>`
    + `<span class="budget-month-amount">${money2(contribution)}${trustTag}</span></div>`
    + allocations.map(a => budgetPayPeriodFundingLineHtml(a, trustTag)).join('')
    + `</div></div>`;
}

/* AMANDA SLICE 12 — SELECTED PAY-PERIOD FUNDING SHORTFALL DETAIL.
 *
 * Slices 9–11 let Amanda select a pay period and understand what happens
 * inside it, the three-stage result, the money map, and what that payday
 * is supposed to fund for future planned costs. Slice 12 closes the
 * failure-state gap: when Forecast's planned-cost funding schedule says
 * the selected payday cannot meet everything, Amanda can answer how
 * short it is, when the money is needed, and which planned costs
 * Forecast's funding schedule names in the shortfall.
 *
 * The block renders only when schedule.status === 'funding-gap' AND
 * schedule.gap.payday exactly equals the selected pay-period row's
 * payday. Exact equality only: never a future gap on an earlier payday,
 * never the first global gap on every pay period, never cashDate as the
 * payday match, never nearest-payday. A pre-opening gap
 * (gap.payday === null) is a different identity and never attaches to a
 * visible payday; a residual period whose cycle payday predates the
 * Forecast opening cannot borrow a future gap. With no exact-match gap
 * the block is omitted — no shortfall for this payday is not an
 * unavailable figure.
 *
 * Every figure is a Forecast reprint: shortBy is never derived from
 * required - available page-side, affected costs are never totaled, and
 * affected IDs resolve only through the same schedule publication's
 * costs[], in gap.affected[] order. Affected is Forecast's
 * funding-schedule attribution, not a causal or prescriptive conclusion:
 * neutral language only, no cause, no recommendation, no borrow/defer/
 * cancel wording. All funding figures carry schedule.fundingTrust —
 * never Slice 10 component trust, Slice 11 row trust, cost confidence,
 * or advice-shell trust. Unknown/unrecognized trust fails closed;
 * unavailable is never $0.
 */

// Slice 12 cashDate guard: the publication contract is ISO date strings,
// but only an exact valid ISO calendar date may render. Manual
// days-in-month arithmetic (no Date parsing quirks, no timezone shifts)
// rejects impossible months/days and trailing junk deterministically.
function isValidIsoCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const dim = month === 2 ? (leap ? 29 : 28)
    : ([4, 6, 9, 11].includes(month) ? 30 : 31);
  return day <= dim;
}

// Selected-payday funding shortfall, reprinted from the Forecast
// planSpendPaydayFunding gap publication. Returns '' when Forecast
// publishes no shortfall for the exact selected payday. Fails closed
// visibly when Forecast does publish one but its publication is
// malformed or untrusted.
function budgetPayPeriodFundingShortfallHtml(period, src) {
  const payday = period && (period.payday || period.id);
  if (!period || !payday) return '';
  let schedule = null;
  try {
    schedule = budgetMonthPlanSpendSchedule(src);
  } catch (e) {
    schedule = null;
  }
  const trustTag = schedule ? budgetMonthTrustTag(schedule.fundingTrust) : null;
  if (!schedule || schedule.status !== 'funding-gap') return '';
  const gap = schedule.gap;
  // Exact-payday identity: the shortfall belongs to the selected payday
  // only. gap.payday === null (a pre-opening shortfall) never attaches
  // to a visible payday.
  if (!gap || gap.payday !== payday) return '';
  const failClosed = `<div class="budget-drilldown-funding-shortfall" data-budget-drilldown-funding-shortfall="unavailable">`
    + `<p class="operating-lead">Funding shortfall</p>`
    + `<p class="operating-note">Forecast published a funding shortfall for this payday, but the shortfall detail is unavailable from the current Forecast opening. This is not $0.</p></div>`;
  // An exact-match gap with unrecognized trust is malformed publication
  // state: the shortfall is real, but nothing about it may render
  // untagged. Fail closed visibly — never omit a published shortfall.
  if (!trustTag) return failClosed;
  // Strict validation, no coercion: shortBy must be a real finite
  // number. false/""/null/numeric strings/NaN/Infinity are malformed
  // publication state — never $0, and never derived from
  // required - available page-side.
  const shortBy = gap.shortBy;
  if (typeof shortBy !== 'number' || !Number.isFinite(shortBy)) return failClosed;
  // cashDate reprint under the incumbent contract (ISO date strings). The
  // guard requires an exact valid ISO calendar date: a prefix-only match
  // let impossible dates (2027-99-99) and trailing junk (2027-01-08junk)
  // through and rendered "Needed by Invalid Date" as a trusted figure. A
  // malformed cashDate fails that line closed visibly — the shortfall
  // amount is still Forecast's published figure, and no date is ever
  // substituted.
  const cashDateLabel = isValidIsoCalendarDate(gap.cashDate) ? fmtDateLong(gap.cashDate) : null;
  // Affected costs: Forecast-owned IDs resolved through the same
  // schedule publication's costs[], in gap.affected[] order. A
  // missing/non-array collection, an unresolvable ID, or a malformed
  // label is malformed publication state — the affected detail fails
  // closed visibly rather than silently dropping an ID and looking
  // complete.
  let affectedHtml = '';
  if (!Array.isArray(gap.affected) || !Array.isArray(schedule.costs)) {
    affectedHtml = `<div class="operating-line"><span>Affected planned costs</span><span>unavailable — Forecast did not publish this detail in a usable form.</span></div>`;
  } else {
    const labelById = new Map();
    for (const cost of schedule.costs) {
      if (cost && cost.id != null && typeof cost.label === 'string' && cost.label.length > 0
        && !labelById.has(cost.id)) {
        labelById.set(cost.id, cost.label);
      }
    }
    const labels = [];
    let affectedOk = true;
    for (const id of gap.affected) {
      const label = labelById.get(id);
      if (typeof label !== 'string' || label.length === 0) { affectedOk = false; break; }
      labels.push(label);
    }
    if (!affectedOk) {
      affectedHtml = `<div class="operating-line"><span>Affected planned costs</span><span>unavailable — Forecast did not publish this detail in a usable form.</span></div>`;
    } else if (labels.length) {
      affectedHtml = `<div class="operating-line operating-line-stack"><span>Affected planned costs</span>`
        + `<span>${labels.map(label => `<span class="affected-cost">${label}</span>`).join('')}</span></div>`
        + `<p class="operating-note">Attribution only: Forecast's funding schedule names these planned costs in this payday's shortfall.</p>`;
    } else {
      affectedHtml = `<div class="operating-line"><span>Affected planned costs</span><span>none named in this Forecast publication</span></div>`;
    }
  }
  // Optional Forecast context, reprinted only — never used to derive
  // the shortfall. required - available is NOT computed page-side.
  const knownAmount = value => (typeof value === 'number' && Number.isFinite(value)) ? money2(value) : null;
  const requiredLine = knownAmount(gap.required);
  const availableLine = knownAmount(gap.available);
  return `<div class="budget-drilldown-funding-shortfall" data-budget-drilldown-funding-shortfall="${payday}">`
    + `<p class="operating-lead">Funding shortfall</p>`
    + `<div class="operating-lines">`
    + `<div class="operating-line"><span>Short by</span><span>${money2(shortBy)}${trustTag}</span></div>`
    + (cashDateLabel
      ? `<div class="operating-line"><span>Needed by</span><span>${cashDateLabel}${trustTag}</span></div>`
      : `<div class="operating-line"><span>Needed by</span><span>unavailable — Forecast did not publish this date.</span></div>`)
    + (requiredLine != null
      ? `<div class="operating-line"><span>Forecast required</span><span>${requiredLine}${trustTag}</span></div>`
      : `<div class="operating-line"><span>Forecast required</span><span>unavailable — Forecast did not publish this figure. Not $0.</span></div>`)
    + (availableLine != null
      ? `<div class="operating-line"><span>Forecast available</span><span>${availableLine}${trustTag}</span></div>`
      : `<div class="operating-line"><span>Forecast available</span><span>unavailable — Forecast did not publish this figure. Not $0.</span></div>`)
    + affectedHtml
    + `</div></div>`;
}

function budgetPayPeriodDrilldownHtml(src) {
  const anchor = budgetPayPeriodAnchorMonth;
  const monthLabel = (anchor && budgetMonthName(anchor)) || anchor || 'the selected month';
  const open = `<div class="budget-pay-period-drilldown" data-budget-drilldown="${anchor || 'unavailable'}">`
    + `<p class="operating-lead">Pay Period</p>`;
  // The month and its overlapping cycles are different window identities.
  // Stated plainly so the household never reads the cycles as month parts.
  const scopeNote = `<p class="operating-note">Forecast-published Seaspan pay periods overlapping ${monthLabel}, `
    + `in Forecast's publication order. Complete cycles are shown in full — never clipped to month boundaries. `
    + `A period that covers only part of a cycle is labelled with its actual published window, never the whole cycle. `
    + `These periods answer payday-cycle questions; they are not expected to sum to the calendar-month total.</p>`;
  const traj = budgetTrajectoryFor(src);
  if (!traj || traj.status !== 'ready') {
    const reason = (traj && traj.reason) || 'Forecast could not publish the baseline trajectory.';
    return open + scopeNote
      + `<div class="note-box crit">${reason}</div>`
      + `<p class="operating-note">Pay-period detail is unavailable. This is not $0.</p></div>`;
  }
  // Fail closed: a row Forecast did not give a truthful window identity
  // cannot be shown — its figures must never appear under a guessed label.
  const periods = budgetDrilldownPeriods(traj, anchor)
    .filter(p => budgetDrilldownPeriodLabel(p));
  if (!periods.length) {
    return open + scopeNote
      + `<div class="note-box crit">Forecast published no Seaspan pay periods overlapping ${monthLabel}.</div></div>`;
  }
  const selected = periods.find(p => p && (p.payday || p.id) === budgetDrilldownPayPeriod) || periods[0];
  const selectedId = selected.payday || selected.id;
  const picker = `<label class="budget-month-picker"><span class="budget-month-picker-label">Pay period</span> `
    + `<select class="budget-month-select" data-budget-drilldown-picker aria-label="Seaspan pay period overlapping ${monthLabel}">`
    + periods.map(p => {
        const id = p.payday || p.id;
        const label = budgetDrilldownPeriodLabel(p) || id;
        return `<option value="${id}"${id === selectedId ? ' selected' : ''}>${label}</option>`;
      }).join('')
    + `</select></label>`;
  return open + scopeNote + picker + budgetDrilldownPeriodHtml(selected, src) + `</div>`;
}

function paydayInstructionShellHtml(advice, period, schedule) {
  // AMANDA SLICE 14 — PAYDAY ACTION IDENTITY & FUNDING PARITY.
  // The shell now keeps three identities visibly separate:
  //   1. Current position (today) — the paydayAllocation current-cash
  //      chain: what today's cash must do.
  //   2. Selected pay period — the pay-period waterfall below the shell
  //      (Payday balance, bills, Balance After Deductions). The shell
  //      names it and points at it; it never duplicates its figures.
  //   3. Exact payday plan — the schedule's first payday row, labelled
  //      with its exact date.
  // The planned-cost funding block shows the EXACT payday's plan: the
  // first payday row in the Forecast publication. The
  // schedule arrives on the Budget's active inputs (the caller
  // regenerates it through the incumbent Forecast chain via
  // budgetMonthPlanSpendSchedule, so knob changes recompute it; the
  // advice publication alone would stay on the recommended weekly).
  // Exact identity only: never period.start (the selected pay period's
  // opening, which can predate the forecast's first payday), never a
  // nearest-payday substitution. The row is labelled with its exact
  // date so it can never be read as the period's money. A trusted $0
  // contribution renders $0.00; unknown fails closed, never $0. Named
  // allocations are reprinted in Forecast order — never summed.
  //
  // AMANDA SLICE 2 — NEST MONEY EARMARK (P1 4117851665 repair).
  // The planned-spending block is the Nest Money funding plan: the exact
  // payday's Plan-Spend-attributable contribution, with its named
  // purposes, is rendered as an earmark/funding-plan amount only.
  // Everything else stays in the BILLS/chequing account. The block is
  // not a transfer or set-aside instruction, and the household is not
  // asked to subtract prior moves to make it safe — the engine
  // publishes no prior Nest Money move state, so neither a move
  // directive nor a subtract-to-be-safe instruction can be reconciled
  // against a later payday. The earmark carries an explicit blindness
  // qualifier instead. The earmark is a planning amount; it never
  // claims a transfer occurred.
  //
  // AMANDA SLICE 1 — PAYDAY INSTRUCTION SHELL.
  // One concise household-readable shell answering "where does this money
  // need to go?" Every figure is reprinted from Forecast-owned output; the
  // page does no financial arithmetic. In particular the shell never
  // subtracts a Plan-Spend-attributable portion from the protectedPath
  // hold: Forecast publishes the non-overlapping decomposition itself
  // (schedule contribution + nonPlanSpendProtected) and the page reprints
  // both. Unknown is not $0 — anything Forecast did not publish renders
  // as unavailable. Nothing here is a transfer or a payment made.
  //
  // Trust tags (AMANDA SLICE 1 repair): every figure the shell reprints
  // carries its Forecast-published trust state ('calculated' | 'estimated'),
  // rendered with the figure so estimated state is never flattened into
  // indistinguishable bare currency. The page renders only that published
  // state — never a page-side inference — and fails closed when Forecast
  // did not publish it.
  const alloc = advice && advice.paydayAllocation;
  if (!alloc || !alloc.lines) return '';
  const shellTrust = (advice && advice.paydayShellTrust) || {};
  const trustTag = key => {
    const trust = shellTrust[key];
    if (trust === 'estimated') return ' <span class="trust-tag trust-estimated">estimate</span>';
    if (trust === 'calculated') return ' <span class="trust-tag">calculated</span>';
    return null;
  };
  const known = value => value != null && isFinite(Number(value)) ? Number(value) : null;
  const unavailableNote = label =>
    `<p class="operating-note">${label}: unavailable — this figure was not published.</p>`;
  const block = (title, bodyHtml, options = {}) => {
    // Move the already-rendered headline into a compact native summary.
    // This is HTML presentation, not selection or arithmetic on money.
    const amount = bodyHtml.match(/<p class="instruction-amount">([\s\S]*?)<\/p>/);
    const headline = amount ? amount[1] : (options.headline || 'Unavailable');
    const attention = options.attention || '';
    const detail = bodyHtml.replace(amount ? amount[0] : '', '').replace(attention, '');
    const attentionText = attention.replace(/^<p[^>]*>/, '').replace(/<\/p>$/, '');
    const key = options.key || title;
    const escapedKey = key.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return `<details class="instruction-block" data-payday-breakdown="${escapedKey}"${options.attrs || ''}${typeof paydayDisclosuresOpen !== 'undefined' && paydayDisclosuresOpen.has(key) ? ' open' : ''}>
      <summary><h3>${title}</h3><span class="${amount ? 'instruction-amount' : 'instruction-state'}">${headline}</span>${attentionText ? `<span class="instruction-warning">${attentionText}</span>` : ''}</summary>
      <div class="instruction-detail">${detail}</div>
    </details>`;
  };

  const available = known(alloc.available);
  const availableTag = trustTag('available');
  const availableBlock = block('Money available',
    available == null || availableTag == null ? unavailableNote('Money available')
      : `<p class="instruction-amount">${money2(available)}${availableTag}</p>`);

  const obligations = alloc.obligations || {};
  const billsValue = known(obligations.allocated);
  const billsShortfall = known(obligations.shortfall);
  const billsTag = trustTag('obligations');
  const billsAttention = billsShortfall != null && billsShortfall > 0
    ? `<p class="operating-note">Shortfall of ${money2(billsShortfall)} — bills are not fully covered.</p>` : '';
  const billsBlock = block('Bills & required minimums',
    (billsValue == null || billsTag == null ? unavailableNote('Bills & required minimums')
      : `<p class="instruction-amount">${money2(billsValue)}${billsTag}</p>`)
    + `<p class="operating-note">Required debt minimums are inside this figure — they are not separate. This is today's position for bills; the period's total bills are in the pay-period detail above.</p>`
    + billsAttention, { attention: billsAttention });

  const essentials = alloc.essentials || {};
  const householdValue = known(essentials.allocated);
  const householdTag = trustTag('household');
  const householdBlock = block('Current household spending',
    (householdValue == null || householdTag == null ? unavailableNote('Current household spending')
      : `<p class="instruction-amount">${money2(householdValue)}${householdTag}</p>`)
    + `<p class="operating-note">Today's household spending hold — not the whole period's Household Budget Total, which is in the pay-period detail below.</p>`);

  const start = period && period.start;
  // AMANDA SLICE 14 — EXACT-PAYDAY ROW SELECTION.
  // The schedule is the caller's same-input regeneration (never the
  // advice publication's copy here). The exact payday is the first
  // payday row in the Forecast publication. Never
  // period.start (the selected pay period's opening, which can predate
  // the forecast's first payday), never a nearest-payday substitution.
  const paydays = schedule && schedule.status !== 'unavailable' && Array.isArray(schedule.paydays)
    ? schedule.paydays : null;
  const row = paydays && paydays.length ? paydays[0] : null;
  const exactPayday = row && typeof row.payday === 'string' && isValidIsoCalendarDate(row.payday)
    ? row.payday : null;
  const exactPaydayLabel = exactPayday ? fmtDateLong(exactPayday) : null;
  // Trust tag for the live row's figures (contribution, named lines,
  // other protected cash). Forecast publishes it on the row; the page
  // renders only that published state and fails closed when it is absent.
  const rowTrustTag = row && row.trust === 'estimated'
    ? ' <span class="trust-tag trust-estimated">estimate</span>'
    : row && row.trust === 'calculated' ? ' <span class="trust-tag">calculated</span>' : null;
  // Trust tag for the funding-status figures (AMANDA SLICE 4 P1 repair).
  // Forecast publishes schedule.fundingTrust as the authority for
  // protectedAfterPayday, stillToFund, and the funding-gap shortfall/
  // status path. The live row's Slice 1 stamp must not be reused for
  // them: a future estimated planned cost can drive those figures while
  // the live row stays calculated. Unpublished trust fails closed — the
  // funding-status figures are omitted, never shown untagged.
  const fundingTrustTag = schedule && schedule.fundingTrust === 'estimated'
    ? ' <span class="trust-tag trust-estimated">estimate</span>'
    : schedule && schedule.fundingTrust === 'calculated'
      ? ' <span class="trust-tag">calculated</span>' : null;
  // AMANDA SLICE 14 — trust for the exact-payday funding figures
  // (contribution, named allocations). The live row carries its own
  // Forecast-published row trust (AMANDA SLICE 1); any other payday
  // carries only the schedule-level fundingTrust by Forecast's contract
  // (AMANDA SLICE 11) — the page never borrows another figure's stamp,
  // and unpublished trust fails the block closed, never untagged.
  const isLiveRow = !!(exactPayday && schedule && exactPayday === schedule.asOf);
  const plannedTrustTag = isLiveRow ? rowTrustTag : fundingTrustTag;
  // AMANDA SLICE 2 — NEST MONEY EARMARK (P1 4117851665 repair).
  // The exact payday's Plan-Spend-attributable part (schedule contribution
  // with its named allocations) is the money Forecast specifically
  // attributes to known future planned costs — that, and only that, is
  // the Nest Money earmark. The block presents the figure as an
  // earmark/funding-plan amount only: NOT a transfer or set-aside-into-
  // a-bucket instruction, and NOT a directive the household must
  // subtract prior moves to make safe. The engine publishes no prior-move
  // state (planSpendPaydayFunding.projectionOpeningProtected is a
  // hardcoded 0; startingCashAmount excludes designated savings), so a
  // displayed headline can still be the stale/full funding amount and
  // cannot be proved correct as an actionable instruction. General
  // protected cash (nonPlanSpendProtected), the buffer floor, bills,
  // household spending, extra debt, optional plans and unassigned money
  // stay in the BILLS/chequing account. The earmark is a planning
  // amount; Atlas moves nothing and claims no transfer occurred.
  let plannedBody;
  if (!paydays || !row || exactPayday == null) {
    // No schedule, an unavailable schedule, or no exact-payday row:
    // unknown is not $0, so the block fails closed.
    plannedBody = unavailableNote('Nest Money funding plan');
  } else {
    // AMANDA SLICE 14 (P1 repair, Systems Review 5361317547) — strict
    // funding validation, no coercion. Slice 11's contract is real finite
    // numbers only: Number() coercion would turn false/"" into $0.00 and
    // "50" into $50.00 — malformed data rendered as real-looking money.
    // The shared known() helper stays as-is for the incumbent shell
    // figures (out of this repair's bounds); the funding path validates
    // strictly and fails closed.
    const strictMoney = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const contribution = strictMoney(row.contribution);
    if (contribution == null || plannedTrustTag == null || !Array.isArray(row.allocations)) {
      // Null contribution (Forecast publishes null only with estimated
      // trust), unpublished trust, or a malformed allocations collection:
      // fail closed — never $0, never a partial named list.
      plannedBody = unavailableNote('Nest Money funding plan');
    } else {
      // AMANDA SLICE 4 — PLANNED-SPENDING FUNDING STATUS.
      // The funding-status figures are Forecast reprints from the live
      // payday row and the schedule: the projected protected amount after
      // following this payday's plan, the amount still to fund, and the
      // overall funding status. The page selects and reprints; Forecast
      // computes. Each figure carries schedule.fundingTrust — the live
      // row's Slice 1 stamp is not reused (P1 repair). A projection is
      // not proof of money moved or saved — the copy says so explicitly,
      // and the Slice 2 blindness qualifier is preserved. The subsection
      // renders only when Forecast published both figures and their
      // trust; otherwise it is omitted (never invented, never $0).
      const protectedAfter = known(row.protectedAfterPayday);
      const stillToFund = known(row.stillToFund);
      let fundingStatusHtml = '';
      if (protectedAfter != null && stillToFund != null && fundingTrustTag != null) {
        const statusLabel = schedule.status === 'ready' ? 'On track' : null;
        fundingStatusHtml = `<p class="operating-note">If this plan is followed — a projection, not money already moved or saved.</p>
          <div class="operating-lines">
            <div class="operating-line"><span>Projected protected</span><span>${money2(protectedAfter)}${fundingTrustTag}</span></div>
            <div class="operating-line"><span>Still to fund</span><span>${money2(stillToFund)}${fundingTrustTag}</span></div>
            ${statusLabel ? `<div class="operating-line"><span>Status</span><span>${statusLabel}${fundingTrustTag}</span></div>` : ''}
          </div>`;
      }
      // A Forecast-published funding gap is exposed with its shortfall,
      // date, and affected named costs — whenever Forecast publishes it,
      // including a shortfall in a future payday. The shortfall figure
      // carries schedule.fundingTrust, not the live row's stamp. The
      // affected labels are a Forecast id-to-label lookup from
      // schedule.costs, not page-side assembly. Nothing is invented:
      // unknown parts are omitted, and an unknown shortfall is labelled
      // unavailable, never $0. Without published funding trust the block
      // is omitted rather than shown untagged.
      let gapHtml = '';
      const fundingGap = schedule.gap;
      if (schedule.status === 'funding-gap' && fundingGap && fundingTrustTag != null) {
        const shortBy = known(fundingGap.shortBy);
        const labelById = new Map((schedule.costs || [])
          .filter(cost => cost && cost.id != null)
          .map(cost => [cost.id, cost.label]));
        const affectedLabels = (Array.isArray(fundingGap.affected) ? fundingGap.affected : [])
          .map(id => labelById.get(id))
          .filter(label => typeof label === 'string' && label.length > 0);
        const fmtGapDate = iso => {
          if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
          try { return fmtDateLong(iso); } catch (e) { return null; }
        };
        const cashDateLabel = fmtGapDate(fundingGap.cashDate);
        const gapPaydayLabel = fmtGapDate(fundingGap.payday);
        const whenValue = cashDateLabel
          ? `${cashDateLabel}${fundingGap.payday == null ? ' — already due' : ''}`
          : (gapPaydayLabel ? `payday of ${gapPaydayLabel}` : null);
        gapHtml = `<p class="operating-lead">Funding shortfall ahead</p>
          <div class="operating-lines">
            ${shortBy == null
              ? `<div class="operating-line"><span>Short by</span><span>unavailable — this figure was not published.</span></div>`
              : `<div class="operating-line"><span>Short by</span><span>${money2(shortBy)}${fundingTrustTag}</span></div>`}
            ${whenValue ? `<div class="operating-line"><span>When</span><span>${whenValue}</span></div>` : ''}
            ${affectedLabels.length ? `<div class="operating-line"><span>Affected</span><span>${affectedLabels.join(', ')}</span></div>` : ''}
          </div>`;
      }
      // AMANDA SLICE 5 — UPCOMING FUNDING PRESSURE.
      // For every dated planned cost Forecast publishes in schedule.costs,
      // the shell shows whether this payday funds it now or later. Costs
      // with a live-payday allocation are "funding now": the named lines
      // gain their Forecast cash date ("Needed by"). Costs with no
      // allocation this payday are "still in the plan": the shell reprints
      // Forecast's next scheduled contribution and projected fully-funded
      // date. $0 today never means forgotten, complete, or cancelled — the
      // published future path is shown, and anything unpublished renders
      // unavailable, never $0. Overdue costs (cash date before this payday)
      // are not listed as "nothing required": the Slice 4 gap block already
      // names them as already due. The page keeps Forecast's publication
      // order; it does not rank, score, sort, or compute.
      const costById = new Map((schedule.costs || [])
        .filter(cost => cost && cost.id != null)
        .map(cost => [cost.id, cost]));
      // A malformed allocation amount (non-number, NaN, Infinity, coerced
      // string) never counts as funding now: only a real finite number > 0
      // puts the cost in the funded-now set.
      const fundedNowIds = new Set((row.allocations || [])
        .filter(item => item && strictMoney(item.amount) != null && item.amount > 0)
        .map(item => item.id));
      // AMANDA SLICE 14 (re-repair, Systems Review 5361504621) — ids
      // referenced by malformed allocation lines: the funded-now list
      // already renders a visible unavailable line for each of these, so
      // the same cost must not fall through into "No funding from this
      // payday" — that would convert malformed/unknown into a
      // zero-funding claim (unknown is never $0). Malformed here matches
      // the funded-now definition exactly: non-number/NaN/Infinity
      // amount, or a missing/empty/non-string label. A valid known-$0
      // allocation is NOT malformed and keeps its existing contract.
      const malformedAllocationIds = new Set((row.allocations || [])
        .filter(item => item && item.id != null
          && (typeof item.amount !== 'number' || !Number.isFinite(item.amount)
            || !(typeof item.label === 'string' && item.label.length)))
        .map(item => item.id));
      const fmtUpcomingDate = iso => {
        if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
        try { return fmtDateLong(iso); } catch (e) { return null; }
      };
      // Per-cost trust is the cost's published confidence, reprinted — never
      // promoted. Unpublished confidence fails closed (null).
      const costTrustTag = confidence => confidence === 'estimated'
        ? ' <span class="trust-tag trust-estimated">estimate</span>'
        : confidence === 'confirmed'
          ? ' <span class="trust-tag">confirmed</span>' : null;
      // "Funding now": the incumbent named allocations plus the Forecast
      // cash date reprinted from schedule.costs. An unpublished or
      // unparseable date is omitted, never invented. Malformed allocation
      // lines (non-number/NaN/Infinity amount, bad label) are never
      // silently dropped and never rendered as dollars — they render as a
      // visible unavailable line (Slice 11 precedent). A valid known-$0
      // line stays out of the funded-now list, as before.
      const fundedNowLines = (row.allocations || [])
        .map(item => {
          const rawAmount = item ? item.amount : undefined;
          const label = item && typeof item.label === 'string' && item.label.length ? item.label : null;
          if (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount) || !label) {
            return `<div class="operating-line"><span>${label || 'Planned-cost allocation'}</span><span>unavailable — Forecast did not publish this allocation. Not $0.</span></div>`;
          }
          if (!(rawAmount > 0)) return '';
          const cost = costById.get(item.id);
          const tag = cost ? costTrustTag(cost.confidence) : null;
          const neededBy = tag ? fmtUpcomingDate(cost.date) : null;
          return `<div class="operating-line"><span>${label}</span><span>${money2(rawAmount)}${plannedTrustTag}</span></div>`
            + (neededBy ? `<div class="operating-line"><span>Needed by</span><span>${neededBy}${tag}</span></div>` : '');
        }).join('');
      // "Still in the plan": dated costs with no allocation this payday and
      // a cash date not before this payday, in Forecast's publication order.
      const stillPlannedLines = (schedule.costs || [])
        .filter(cost => cost && cost.id != null && !fundedNowIds.has(cost.id)
          && !malformedAllocationIds.has(cost.id)
          && typeof cost.date === 'string' && cost.date >= row.payday)
        .map(cost => {
          const label = typeof cost.label === 'string' && cost.label.length ? cost.label : cost.id;
          const tag = costTrustTag(cost.confidence);
          // The page states only the reprintable fact — "No funding from this
          // payday" — never the reason. The publication does not distinguish
          // "not yet scheduled" from "crowded out by nearer costs" or "the
          // payday could not fund what was required", so asserting a reason
          // (e.g. "nothing required") would misdescribe the $0.
          const head = `<div class="operating-line"><span>${label}</span><span>No funding from this payday</span></div>`;
          if (tag == null) {
            return head + `<div class="operating-line"><span>Future funding details</span><span>unavailable — trust not published.</span></div>`;
          }
          const next = cost.nextContribution;
          const nextAmount = next ? known(next.amount) : null;
          const nextPayday = next ? fmtUpcomingDate(next.payday) : null;
          const nextLine = next == null
            ? `<div class="operating-line"><span>Next scheduled contribution</span><span>none scheduled</span></div>`
            : nextAmount == null || nextPayday == null
              ? `<div class="operating-line"><span>Next scheduled contribution</span><span>unavailable — not published.</span></div>`
              : `<div class="operating-line"><span>Next scheduled contribution</span><span>${money2(nextAmount)}${tag} on ${nextPayday}</span></div>`;
          const fundedBy = fmtUpcomingDate(cost.projectedFullyFunded);
          const fundedByLine = fundedBy == null
            ? `<div class="operating-line"><span>Projected funded by</span><span>not published</span></div>`
            : `<div class="operating-line"><span>Projected funded by</span><span>${fundedBy}${tag}</span></div>`;
          return head + nextLine + fundedByLine;
        }).join('');
      const stillPlannedHtml = stillPlannedLines
        ? `<p class="operating-lead">Still in the plan</p><div class="operating-lines">${stillPlannedLines}</div>` : '';
      if (!(contribution > 0)) {
        // A $0 contribution does not mean fully funded: Forecast may still
        // carry remaining funding, so the funding status renders alongside
        // the $0 earmark instead of replacing it.
        plannedBody = `<p class="instruction-amount">${money2(0)}${plannedTrustTag}</p>
          <p class="operating-note">No Nest Money earmark this payday.</p>
          ${stillPlannedHtml}
          ${fundingStatusHtml}${gapHtml}`;
      } else {
        plannedBody = `<p class="instruction-amount">${money2(contribution)}${plannedTrustTag}</p>
          ${fundedNowLines ? `<div class="operating-lines">${fundedNowLines}</div>` : ''}
          <p class="operating-note">This payday's share of the funding plan for these named planned costs. Atlas can't see money you've already moved to your Nest Money bucket, so this is a planning amount only — not an instruction to transfer or move money into a separate bucket. No transfer has happened, and the payment itself stays on its cash date.</p>
          ${stillPlannedHtml}
          ${fundingStatusHtml}${gapHtml}`;
      }
    }
  }
  // AMANDA SLICE 14 — the planned block carries the exact payday's
  // identity in its title, so it can never be read as the selected
  // period's money.
  const periodRangeLabel = (period && (period.rangeLabel || period.label)) || 'selected';
  const plannedTitle = exactPaydayLabel
    ? `Nest Money funding plan — ${exactPaydayLabel} payday`
    : 'Nest Money funding plan';
  const plannedIdentityNote = exactPaydayLabel
    ? `<p class="operating-note">Forecast's planned-cost funding for the ${exactPaydayLabel} payday. This is that payday's plan, not the ${periodRangeLabel} period's.</p>`
    : '';
  const plannedBlock = block(plannedTitle, `${plannedIdentityNote}${plannedBody}`, {
    key: 'planned-cost-funding', attrs: ` data-exact-payday-plan="${exactPayday || ''}"`,
    attention: plannedBody.includes('<p class="operating-lead">Funding shortfall ahead</p>')
      ? '<p class="operating-lead">Funding shortfall ahead</p>' : '',
  });

  const bufferValue = known(advice.buffer);
  const bufferTag = trustTag('buffer');
  const otherProtected = row ? known(row.nonPlanSpendProtected) : null;
  const protectedBlock = block('Protected cash',
    (bufferValue == null || bufferTag == null ? unavailableNote('Minimum cash floor')
      : `<p class="instruction-amount">Keep at least ${money2(bufferValue)}${bufferTag}</p>
        <p class="operating-note">A cash floor, not a transfer and not extra spending money.</p>`)
    + (otherProtected == null || rowTrustTag == null ? unavailableNote('Other protected cash — keep in chequing')
      : `<p class="instruction-amount">${money2(otherProtected)}${rowTrustTag}</p>
        <p class="operating-note">Other protected cash — keep in chequing. Protection beyond planned spending, not a savings transfer.</p>`));

  // AMANDA SLICE 6 — FOCUS DEBT CONTINUITY.
  // The focus debt stays visible even when this payday allocates $0 extra
  // principal: the page reprints Forecast's published target, never a
  // reason for the $0 (a zero allocation is a fact, not automatically a
  // reason — the publication carries the fact, not the reason). When
  // Forecast publishes the next-target consequence, the shell reprints it
  // as conditional ("after this debt clears"), never as a current
  // payment. No published next target is silence, never "debt free".
  // Forecast's published strategy state (e.g. unknown pending exposure)
  // is reprinted verbatim as a separate strategy note whenever a focus
  // debt exists — uncertainty stays visible, never converted to $0 or
  // safe surplus, and never presented as the reason an allocation is $0.
  // With no target, the published strategy state (reason) renders as
  // published — no debt is invented, and the $0 figure keeps its trust
  // tag. The page does not choose, compare, rank, or reorder debts and
  // does no payoff or balance arithmetic; it reprints the publication
  // in place.
  const extra = alloc.extraDebt || {};
  const extraValue = known(extra.allocated);
  const extraTag = trustTag('extraDebt');
  // Incumbent convention (plan.js renderers): the target is the
  // debtPriority object; the household name is target.label. Never
  // interpolate the raw object. Tolerate a plain string defensively.
  const debtLabel = raw => raw == null ? null
    : (typeof raw === 'string' ? raw : (raw.label || null));
  const focusLabel = debtLabel(extra.target);
  // Next target only from Forecast's published consequence, kept
  // conditional. Reading any other field for it would be page-side
  // target selection.
  const nextConsequence = extra.consequence && extra.consequence.kind === 'next-target'
    ? extra.consequence : null;
  const nextLabel = nextConsequence ? debtLabel(nextConsequence.nextTarget) : null;
  const afterClearsLine = nextLabel
    ? `<p class="operating-note">After this debt clears: ${nextLabel}.</p>` : '';
  // Forecast's published strategy state (e.g. unknown pending exposure),
  // reprinted verbatim and separately. It is the strategy's uncertainty /
  // state — never the reason an allocation is $0, and the page never
  // derives from or interprets it. Shown whenever a focus debt exists and
  // the publication carries it (in the $0 branch with no target the
  // reason already renders as the state line, so it is not repeated).
  const reasonText = typeof extra.reason === 'string' && extra.reason ? extra.reason : null;
  const strategyNote = reasonText && (extraValue > 0 || focusLabel)
    ? `<p class="operating-note">Strategy note: ${reasonText}</p>` : '';
  let extraBody;
  if (extraValue == null || extraTag == null) {
    extraBody = unavailableNote('Extra on focus debt');
  } else if (!(extraValue > 0)) {
    // $0 extra: the focus stays visible. No reason is given for the $0 —
    // the strategy note is Forecast's published state, shown separately,
    // not a causal claim about the zero.
    const stateLine = focusLabel
      ? `<p class="operating-note">Focus debt: ${focusLabel}. No extra principal this payday — Required minimums are already in bills above.</p>`
      : (reasonText
        ? `<p class="operating-note">${reasonText}</p>`
        : `<p class="operating-note">No extra principal this payday. Required minimums are already in bills above.</p>`);
    extraBody = `<p class="instruction-amount">${money2(0)}${extraTag}</p>
      ${stateLine}
      ${strategyNote}
      ${afterClearsLine}`;
  } else {
    const target = focusLabel ? ` on ${focusLabel}` : ' on the focus debt';
    extraBody = `<p class="instruction-amount">${money2(extraValue)}${extraTag}</p>
      <p class="operating-note">Optional extra${target} — only after everything above is covered.</p>
      ${strategyNote}
      ${afterClearsLine}`;
  }
  const extraBlock = block('Extra on focus debt', extraBody, {
    attention: strategyNote || (!focusLabel && reasonText ? `<p class="operating-note">${reasonText}</p>` : ''),
  });

  // Funded optional plans are Forecast allocations taken from the same
  // remaining pool as the remainder. The shell must name them: otherwise a
  // funded optional destination disappears from "where does this money need
  // to go?" while the remainder still calls itself truly unassigned.
  // Reprint only — one line per Forecast row, no page-side total.
  const optionalRows = (Array.isArray(alloc.optional) ? alloc.optional : [])
    .filter(item => item && Number(item.allocated) > 0);
  const optionalTag = trustTag('optional');
  const optionalBlock = optionalRows.length ? block('Optional plans',
    optionalTag == null ? unavailableNote('Optional plans')
    : `<div class="operating-lines">${optionalRows
      .map(item => `<div class="operating-line"><span>${item.label}</span><span>${money2(item.allocated)}${optionalTag}</span></div>`)
      .join('')}</div>
      <p class="operating-note">Nice-to-have plans — funded only after everything above is covered.</p>`,
    { headline: optionalTag == null ? 'Unavailable' : 'Funded plans' }) : '';

  const remainderValue = known(alloc.remainder);
  const remainderTag = trustTag('remainder');
  const unresolved = Array.isArray(alloc.unresolved) ? alloc.unresolved : [];
  const remainderAttention = unresolved.length
    ? `<p class="operating-note">${unresolved.length} planned cost${unresolved.length === 1 ? ' is' : 's are'} still unresolved — this is not free money.</p>` : '';
  const remainderBlock = block('Truly unassigned',
    (remainderValue == null || remainderTag == null ? unavailableNote('Truly unassigned')
      : `<p class="instruction-amount">${money2(remainderValue)}${remainderTag}</p>`)
    + (remainderAttention || `<p class="operating-note">Genuinely unassigned. Nothing else claims it.</p>`),
    { attention: remainderAttention });

  const paydayAttr = alloc.payday || start || '';
  return `<section class="payday-instruction-shell" data-payday-instruction-shell="${paydayAttr}">
    <h2>Today's money — current position</h2>
    <p class="operating-note">What today's cash must do. This is the current position — not the full pay period, and nothing here is a transfer or a payment made.</p>
    <div class="instruction-blocks">
      ${availableBlock}${billsBlock}${householdBlock}${plannedBlock}${protectedBlock}${extraBlock}${optionalBlock}${remainderBlock}
    </div>
    <details class="instruction-context" data-payday-breakdown="current-cash-context"${typeof paydayDisclosuresOpen !== 'undefined' && paydayDisclosuresOpen.has('current-cash-context') ? ' open' : ''}>
    <summary>How to read these amounts</summary>
    <p class="operating-note">The exact payday's plan — the Nest Money funding plan, with the rest staying in chequing. Nothing here is a transfer or a payment made.</p>
    <p class="operating-note">The Nest Money amount below is the exact payday's funding plan for the named planned costs — a planning amount, not an instruction to transfer or move money. Everything else below stays in your BILLS/chequing account until it is spent or paid.</p>
    <p class="operating-note">Every figure carries its trust tag: calculated means the inputs were confirmed; estimate means an input was estimated (for example a projected paycheck).</p>
    </details>
    <p class="operating-note">The ${periodRangeLabel} pay-period detail above shows this period's Payday balance, bills, and Balance After Deductions — a different window from today's position here.</p>
  </section>`;
}
function calendarFromTodayEvidenceHtml(period, plan) {
  if (!period) return '';
  const confirmedSavings = plan && Forecast.savingsEarmarksState(plan, period.start).status !== 'setup-unknown';
  const planUnavailable = period.operatingPlanUnavailable === true;
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const costMoney = row => numeric(row.cost) && row.confidence === 'confirmed' ? money2(row.cost)
    : numeric(row.cost) && row.confidence === 'estimated' ? money2(row.cost) + ' · estimated' : 'Unavailable';
  const today = period.fromTodayFunding;
  const todayKnown = !planUnavailable && today && today.basis === 'Budget-from-today'
    && (today.status === 'ready' || today.status === 'funding-gap')
    && (today.trust === 'calculated' || today.trust === 'estimated') && numeric(today.contribution);
  const todayMoney = amount => todayKnown && numeric(amount)
    ? money2(amount) + (today.trust === 'estimated' ? ' ≈ estimated' : '') : 'Unavailable';
  const forwardItems = rows => (rows || []).map(row => `<div class="budget-funding-item" data-from-today-cost="${escape(row.id)}">
    <h3>${escape(row.label)}</h3>
    <div class="operating-line"><span>Proposed contribution</span><span>${todayMoney(row.contribution)}</span></div>
    <div class="operating-line"><span>Cumulative proposed / cost</span><span>${todayMoney(row.cumulativeProposed)} / ${costMoney(row)}</span></div>
    <div class="operating-line"><span>Remaining requirement</span><span>${todayMoney(row.remainingGap)}</span></div>
    <p class="operating-note">Planning date: ${escape(row.date || 'Unknown')}${row.confidence === 'estimated' ? ' · estimated' : ''}${numeric(row.ceiling) && row.ceiling > row.cost ? ` · upper estimate ${money2(row.ceiling)}` : ''}. ${numeric(row.actualSaved) ? 'Actual saved: ' + money2(row.actualSaved) + ' calculated backing. Destination account: ' + (row.reserveParts && row.reserveParts.length ? row.reserveParts.map(part => escape(part.label || part.accountId)).join(' · ') : 'unknown') + '.' : 'Actual saved and destination account: unknown.'}</p>
  </div>`).join('');
  const fromTodayBody = today ? `<div data-from-today="${escape(today.asOf)}">
    <p class="operating-note">${todayKnown ? 'A new proposal dated' : 'Evidence checked for'} ${escape(today.asOf)}. ${confirmedSavings ? todayKnown ? 'Backed assignments are included once; additional contributions remain proposals.' : 'Additional contributions are withheld. Confirmed assignments and backing are shown in the savings inventory.' : todayKnown ? 'Separate from the original payday allocation; no starting snapshot or actual saved balance has been reconstructed.' : 'No savings proposal is available. The original payday allocation and actual saved balance have not been reconstructed.'}</p>
    ${todayKnown ? `<p class="operating-note">Chequing evidence: ${escape(today.cashAsOf)}. Spending observed through ${escape(today.observationAsOf)}. Budget targets and actuals supply the remaining household needs.</p>
      <div class="operating-line"><span>Current chequing cash</span><span>${todayMoney(today.currentCash)}</span></div>
      <div class="operating-line"><span>Remaining bills and debt payments</span><span>${todayMoney(today.operatingBills)}</span></div>
      <div class="operating-line"><span>Remaining household needs</span><span>${todayMoney(today.remainingHousehold)}</span></div>
      ${Object.prototype.hasOwnProperty.call(today, 'cardPurchaseCoverageReserve') ? `<div class="operating-line" data-from-today-card-coverage><span>Uncovered card purchases - keep in Bills</span><span>${todayMoney(today.cardPurchaseCoverageReserve)}</span></div>` : ''}
      <div class="operating-line"><span>Required operating cash through ${escape(today.currentThrough)}, including the existing cash floor</span><span>${todayMoney(today.requiredOperatingCash)}</span></div>
      <div class="operating-line"><span>Capacity for proposed funding now</span><span>${todayMoney(today.availableNow)}</span></div>
      <div class="operating-line"><span>Proposed to set aside now</span><span>${todayMoney(today.contribution)}</span></div>
      <div class="operating-line"><span>Chequing left after this proposal</span><span>${todayMoney(today.cashAfterProposal)}</span></div>
      ${today.operatingShortfall > 0 ? `<p class="operating-note crit">Current cash is ${todayMoney(today.operatingShortfall)} short of remaining operating needs.</p>` : ''}
      <p class="operating-note">Future receipts in this period: ${todayMoney(today.futureIncomeThisPeriod)}. They are not money available to set aside now. Remaining chequing may be needed later; it is not spending permission.</p>
      ${forwardItems(today.items)}
      ${today.reason ? `<p class="operating-note crit">${escape(today.reason)}</p>` : ''}
      <details><summary>Forward proposals through ${escape(today.through)}</summary>
      ${(today.periods || []).map(row => `<details data-from-today-period="${escape(row.payday)}"><summary>${escape(row.payday)} · ${todayMoney(row.contribution)} proposed</summary>
        ${row.status === 'unavailable' ? `<p class="operating-note">${escape(row.reason)}</p>` : `${forwardItems(row.items)}<p class="operating-note">Proposed funds still held after scheduled payments: ${todayMoney(row.protectedAfterPayments)}. Remaining requirement: ${todayMoney(row.stillToFund)}.</p>`}
      </details>`).join('')}</details>
      ${(today.unscheduled || []).map(row => `<p class="operating-note">${escape(row.label)} · ${costMoney(row)} · ${escape(row.date || 'Date unknown')}. ${escape(row.reason)} Contribution unavailable.</p>`).join('')}`
      : Array.isArray(today.evidenceFailures) && today.evidenceFailures.length
        ? `<p class="operating-note">Forecast is withholding the proposal for the following reasons. Each needs to be resolved before an amount can be shown.</p>
          <ul class="from-today-evidence">${today.evidenceFailures.map(issue => `<li data-savings-evidence-reason="${escape(issue.code)}">
            <p>${escape(issue.message)}</p>
            ${issue.accountLabel || issue.categoryLabel || issue.date ? `<p class="operating-note">${[issue.accountLabel, issue.categoryLabel, issue.date].filter(Boolean).map(escape).join(' · ')}</p>` : ''}
            ${issue.periodStart || issue.requiredThrough ? `<p class="operating-note">Needed: ${escape(issue.periodStart || today.asOf)} through ${escape(issue.requiredThrough || today.asOf)}.${issue.coverageStart || issue.coverageThrough ? ` Coverage supplied: ${escape(issue.coverageStart || 'unknown start')} through ${escape(issue.coverageThrough || 'unknown end')}.` : ''}</p>` : ''}
            <p class="operating-note">${escape(issue.action)}</p>
          </li>`).join('')}</ul>`
        : `<p class="operating-note">${escape(today.reason || 'Current funding evidence is unavailable.')}</p>`}
    <p class="operating-note">${confirmedSavings ? 'The savings inventory is a breakdown of pool cash, not extra chequing cash. No silver purpose is inferred.' : 'These are proposed earmarks, not transfers or balances already saved. Shared savings and silver are not added to chequing cash. Bucket ownership, silver attribution and actual saved balances remain unknown.'}</p>
  </div>` : '';
  const todayHtml = today && !planUnavailable ? `<div class="budget-step" data-from-today-proposal>
    <details class="budget-step-details"><summary class="budget-step-summary">
      <span class="operating-number" aria-hidden="true">↳</span>
      <span class="budget-step-title"><span class="operating-prompt" role="heading" aria-level="2">From today · ${escape(today.asOf)}</span><span class="budget-step-caption">${todayKnown ? 'Current cash proposal · open for needs, costs and the forward schedule' : 'Proposal unavailable · open for the evidence needed'}</span></span>
      <span class="budget-step-value">${todayMoney(today.contribution)}</span><span class="budget-step-chevron" aria-hidden="true">⌄</span>
    </summary><div class="operating-answer budget-step-body">${fromTodayBody}</div></details>
  </div>` : '';
  return todayHtml;
}

// Print-only, hidden from layout and assistive tech (hidden + aria-hidden):
// Forecast's published Balance After Deductions
// (predictedEndingBalanceTerms.balanceAfterDeductions, before savings funding)
// for EVERY advice.payPeriodViews row in order, for renderers that need the
// whole timeline while the Budget page shows one period. Trust, face, the
// ≈ mark and the amount are decided exactly as the selected period's terms
// block in calendarWaterfallHtml decides them (#549/#550): the same tests,
// repeated here because suites load calendarWaterfallHtml on its own.
// test-bad-terms-print.js locks the two to the same output for every row.
function badTimelineHtml(advice, compactOverview, savingsContext) {
  const rows = Array.isArray(advice && advice.payPeriodViews) ? advice.payPeriodViews.filter(Boolean) : [];
  if (!rows.length) return '';
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const items = rows.map(period => {
    // Terms block: badTermsKnown + badTermRow('balanceAfterDeductions', …, period.balanceAfterDeductionsTrust, true).
    const badTerms = period.predictedEndingBalanceTerms;
    const badTermsKnown = !!badTerms && badTerms.identity === 'balance-after-deductions' && badTerms.closes === true;
    const value = badTermsKnown ? badTerms.balanceAfterDeductions : null;
    const trust = period.balanceAfterDeductionsTrust;
    const stamp = trust == null ? 'calculated' : trust;
    const history = period.budgetProgress;
    const historical = period.timelineRole === 'past' || period.lookback === true;
    // Forecast owns the completeness of each historical component. A closing
    // equation or Household-only coverage cannot qualify the whole period.
    const historicalBadWithheld = historical && !(badTermsKnown && numeric(value)
      && ['calculated', 'estimated'].includes(stamp)
      && history?.source === 'Forecast.budgetPeriodProgress'
      && history.start === period.start && history.end === period.end
      && [history.income?.actual, history.bills?.actual, history.household?.actual].every(part =>
        part?.completeness === 'complete' && numeric(part.amount)
        && ['calculated', 'estimated'].includes(part.trust)));
    const known = !historicalBadWithheld && numeric(value)
      && (stamp === 'calculated' || stamp === 'estimated');
    const mark = known && stamp === 'estimated' ? compactOverview
      ? '<span class="est">≈<span class="budget-cash-sr"> estimated</span></span> ' : '<span class="est">≈ estimated</span> ' : '';
    // Terms block face: dailySavings and fundedBalanceKnown, as calendarWaterfallHtml derives them.
    const dailySavings = compactOverview
      && ['Forecast.savingsDailyFunding', 'Budget.savingsDailyFundingUnavailable'].includes(savingsContext?.daily?.source)
      && savingsContext.daily.asOf === savingsContext.asOf ? (savingsContext.daily.periodViews?.find(view => view.id === period.id)?.packet
        || (period.timelineRole === 'current' ? savingsContext.daily : null)) : null;
    const funding = period.plannedCostFunding;
    const fundingKnown = funding && (funding.status === 'ready' || funding.status === 'funding-gap')
      && funding.start === period.start && funding.end === period.end
      && numeric(funding.contribution) && funding.contribution >= 0 && numeric(funding.afterProposedFunding)
      && (funding.trust === 'calculated' || funding.trust === 'estimated');
    const fundedBalanceKnown = !historicalBadWithheld && fundingKnown && numeric(funding.afterProposedFunding);
    const face = !dailySavings && fundedBalanceKnown ? 'after-proposed-funding' : 'balance-after-deductions';
    const role = period.timelineRole === 'past' || period.timelineRole === 'current' ? period.timelineRole : 'future';
    // Print-only. Forecast already published this; no coverage math here.
    // Missing, null or empty claim omits the attribute so a reader can
    // treat "no attribute" as skip.
    const claim = period.budgetProgress?.coverage?.remainingClaim;
    const coverage = typeof claim === 'string' && claim
      ? ` data-bad-timeline-coverage="${escape(claim)}"` : '';
    return `<li data-bad-timeline-period="${escape(period.id || period.start || '')}" data-bad-timeline-role="${role}" data-bad-timeline-start="${escape(period.start || '')}" data-bad-timeline-end="${escape(period.end || '')}" data-bad-timeline-range-label="${escape(payPeriodRangeLabel(period).replace(/<[^>]*>/g, ''))}"${coverage} data-bad-term-trust="${known ? stamp : 'unavailable'}" data-bad-terms-face="${face}"${known && value < 0 ? ' data-sign="negative"' : ''}>${known ? mark : 'Unavailable'}<span data-bad-term-amount>${known ? money2(value) : ''}</span></li>`;
  }).join('');
  return `<ol data-bad-timeline hidden aria-hidden="true">${items}</ol>`;
}

function calendarWaterfallHtml(period, liveOverlay, alloc, plan, compactOverview = false, savingsContext = null) {
  if (!period) return '';
  const dailySavings = compactOverview
    && ['Forecast.savingsDailyFunding', 'Budget.savingsDailyFundingUnavailable'].includes(savingsContext?.daily?.source)
    && savingsContext.daily.asOf === savingsContext.asOf ? (savingsContext.daily.periodViews?.find(view => view.id === period.id)?.packet
      || (period.timelineRole === 'current' ? savingsContext.daily : null)) : null;
  const confirmedSavings = plan && Forecast.savingsEarmarksState(plan, period.start).status !== 'setup-unknown';
  const planUnavailable = period.operatingPlanUnavailable === true;
  const inventoryCandidate = savingsContext?.inventory;
  const savingsInventory = inventoryCandidate?.source === 'Forecast.savingsInventory'
    && inventoryCandidate.status === 'ready' && inventoryCandidate.nonAdditive === true
    && inventoryCandidate.currency === 'CAD' && Array.isArray(inventoryCandidate.goals)
    && Array.isArray(inventoryCandidate.pools) && isValidIsoCalendarDate(savingsContext.asOf)
    && inventoryCandidate.asOf === savingsContext.asOf ? inventoryCandidate : null;
  // Forecast owns dated reported stock separately from today's backing and
  // contribution. Neither a held daily packet nor old balance evidence may
  // grant funding permission or erase a valid, truthfully dated report.
  const stock = compactOverview ? savingsInventory?.reportedStock : dailySavings?.stock ?? savingsInventory?.observedStock;
  const stockPools = savingsInventory?.pools?.length === 2 ? savingsInventory.pools : dailySavings?.backing?.pools;
  const stockKnown = stock?.status === 'ready' && stock.basis === (compactOverview ? 'reported-savings-stock' : 'observed-savings-stock')
    && stock.nonAdditive === true && stock.currency === 'CAD' && stock.asOf === savingsContext.asOf
    && stock.trust === 'calculated' && stock.evidenceTrust === (compactOverview ? 'provider-reported' : 'verified')
    && Array.isArray(stock.accountIds) && stock.accountIds.length === 2
    && stock.accountIds.every(id => typeof id === 'string')
    && new Set(stock.accountIds).size === 2
    && (!compactOverview || isValidIsoCalendarDate(stock.balanceFrom) && isValidIsoCalendarDate(stock.balanceThrough)
      && stock.balanceFrom <= stock.balanceThrough && stock.balanceThrough <= savingsContext.asOf
      && Array.isArray(stock.balanceDates) && stock.balanceDates.length === 2
      && new Set(stock.balanceDates.map(row => row?.accountId)).size === 2
      && stock.balanceDates.every(row => isValidIsoCalendarDate(row?.date)
        && row.date >= stock.balanceFrom && row.date <= stock.balanceThrough && stock.accountIds?.includes(row.accountId)))
    && typeof stock.amount === 'number' && Number.isFinite(stock.amount)
    && stockPools?.length === 2
    && new Set(stockPools.map(pool => pool?.accountId)).size === 2
    && stockPools.every(pool => stock.accountIds.includes(pool.accountId));
  const stockDateLabel = stockKnown && compactOverview ? 'Observed ' + stock.balanceFrom
    + (stock.balanceFrom === stock.balanceThrough ? '' : ' – ' + stock.balanceThrough) : '';
  const stockEvidence = `<p class="operating-note" data-budget-savings-stock-evidence>${stockKnown
    ? (compactOverview ? 'Combined provider-reported savings balance. ' + budgetBrowseEscape(stockDateLabel)
      + '. Balance dates are separate from the observation check date.' : 'Combined observed savings balance as of ' + budgetBrowseEscape(stock.asOf) + '.')
      + ' This is not spendable cash, a period deduction or a confirmed allocation.'
      + (stock.pendingState !== 'clear' ? ' Pending movement evidence is unresolved; item backing remains separately qualified.' : '')
    : 'Both savings accounts require valid dated reported balances. No partial balance or zero is assumed.'}</p>`;
  // Active period: Current Balance at the top is the hub. Opening is not
  // a Balance After Deductions term, so it is not printed on this
  // household waterfall. Next / lookback periods still show their cash
  // opening.
  const showSnapshotOpening = period.role !== 'active';

  // Every opening branch below already prints period.cashNote once (as the
  // glance note or as the lead), so it is not appended a second time.
  const projectedNote = period.projected
    ? '<p class="operating-note">Projected.</p>' : '';
  const lookbackNote = period.lookback
    ? '<p class="operating-note">Lookback.</p>' : '';
  const openingUnknownNote = period.role === 'active' && !period.openingKnown && period.cashNote
    ? `<p class="operating-note">${period.cashNote}</p>` : '';
  // `kind` is a presentation hint only (opening / balance) so the
  // running-balance thread can be styled as one sequence.
  const q = (number, prompt, answer, kind, summary) => {
    if (summary && (!planUnavailable || compactOverview && number === 'savings')) {
      // Overview values are published Forecast fields, never sums of details.
      const known = (summary.stock === true || !planUnavailable) && typeof summary.amount === 'number' && Number.isFinite(summary.amount)
        && (summary.trust === 'calculated' || summary.trust === 'estimated'
          || (!summary.trustRequired && summary.trust == null));
      const estimate = summary.trust === 'estimated' ? compactOverview
        ? '<span class="est">≈<span class="budget-cash-sr"> estimated</span></span> '
        : '<span class="est">≈ estimated</span> ' : '';
      // Geometry only: size each already-published step against period income.
      // Never derive another financial total or read a formatted HTML value.
      const scaleKnown = typeof period.available === 'number' && Number.isFinite(period.available)
        && period.available >= 0 && ['calculated', 'estimated'].includes(period.incomeTrust);
      const positionKnown = typeof summary.barStart === 'number' && Number.isFinite(summary.barStart);
      // Every row shares the same income units and zero. Deficit periods get
      // an equal negative half; signed dollars remain published Forecast values.
      const signedScale = scaleKnown && period.available > 0 && [
        [period.afterBills, period.afterBillsTrust],
        [period.afterHouseholdBudget, period.balanceAfterDeductionsTrust],
        [finalAmount, finalTrust],
      ].some(([value, trust]) => typeof value === 'number' && Number.isFinite(value)
        && value < 0 && (trust == null || ['calculated', 'estimated'].includes(trust)));
      const barKnown = known && positionKnown && scaleKnown && period.available > 0;
      const zero = signedScale ? 50 : 0;
      const units = signedScale ? 50 : 100;
      const start = barKnown ? zero + summary.barStart / period.available * units : zero;
      const end = barKnown ? start + summary.amount / period.available * units : zero;
      const low = Math.min(start, end), high = Math.max(start, end);
      const deficit = known && positionKnown && (summary.barStart < 0
        || (summary.amount < 0 && (kind === 'balance' || number === '02')));
      const state = !known ? 'unknown' : scaleKnown && period.available === 0 ? 'zero-income'
        : !barKnown ? 'unscaled' : deficit ? 'deficit' : 'known';
      const segment = (left, right, negative) => right > left
        ? `<span class="budget-waterfall-bar${negative ? ' is-negative' : ''}" style="left:${left}%;width:${right - left}%"></span>` : '';
      const bars = barKnown
        ? segment(Math.max(0, low), Math.min(zero, high), true)
          + segment(Math.max(zero, low), Math.min(100, high), false) : '';
      const overflowStart = barKnown && low < -1e-9, overflowEnd = barKnown && high > 100 + 1e-9;
      const classes = `${state === 'unknown' ? ' is-unknown' : deficit ? ' is-deficit'
        : state === 'zero-income' || state === 'unscaled' ? ' is-noscale' : ''}${signedScale ? ' is-signed' : ''}`
        + `${overflowStart ? ' is-overflow-start' : ''}${overflowEnd ? ' is-overflow-end' : ''}`;
      const ratioKey = compactOverview ? ({ '02': 'income', '04': 'bills', '06': 'household', savings: 'savings' })[number] : null;
      const progress = ratioKey ? (ratioKey === 'savings'
        ? budgetProgressFor(period, savingsContext?.asOf ?? period.budgetProgressAsOf)
        : budgetProgressFor(period))?.[ratioKey] : null;
      const evidence = ratioKey ? budgetProgressEvidenceHtml(progress, ratioKey, period) : '';
      // appendix prints even when the step total is unavailable (print-only rows).
      let detail = `${known || summary.discloseUnknown ? answer : '<p class="operating-note">Forecast did not publish a valid total for this period.</p>'}${evidence}${summary.appendix || ''}`;
      if (ratioKey === 'savings') {
        // Pool-backed totals and this payday's proposals have distinct sources.
        // No grouping, allocation or financial total is calculated in the page.
        const inventory = savingsInventory;
        const proposedKnown = !planUnavailable && savingsFundingKnown;
        const seen = new Set();
        const goals = inventory ? [...inventory.goals, ...inventory.pools.flatMap(pool => pool.plannedGoals || [])]
          .filter(goal => goal?.key && !seen.has(goal.key) && seen.add(goal.key)) : [];
        const amount = (value, trust) => typeof value === 'number' && Number.isFinite(value) && value >= 0
          && ['calculated', 'estimated'].includes(trust)
          ? budgetBrowseMoney(value, trust) : '<span class="budget-v3-unknown">Unknown</span>';
        const proposed = field => field?.completeness === 'proposal'
          && typeof field.amount === 'number' && Number.isFinite(field.amount) && field.amount >= 0
          && ['calculated', 'estimated'].includes(field.trust)
          ? budgetBrowseMoney(field.amount, field.trust) : '<span class="budget-v3-unknown">Unknown</span>';
        // Select an existing Forecast window; never reconstruct contribution
        // totals, assign observed pool cash, or substitute this projection for
        // the Savings deduction. A clipped current cycle stays explicitly remaining.
        const timeline = savingsContext?.timeline;
        const projectionKnown = !planUnavailable && !period.lookback && period.timelineRole !== 'past'
          && inventory && timeline?.source === 'Forecast.savingsFundingTimeline'
          && timeline.status === 'ready' && timeline.currency === 'CAD' && timeline.asOf === savingsContext.asOf
          && timeline.nature === 'hypothetical-projection' && timeline.trust === 'estimated'
          && timeline.actionPermission === 'not-granted' && timeline.incrementalInstructions === 'withheld'
          && timeline.actualContributions === null && Array.isArray(timeline.payPeriods) && Array.isArray(timeline.fundingGaps)
          && inventory.revision === null && inventory.pools.every(pool => pool.observedTrust === 'verified'
            && pool.observedAsOf === savingsContext.asOf && pool.status === 'intent-unknown');
        const matches = projectionKnown ? timeline.payPeriods.filter(row =>
          row?.cycleStart === period.start && row.cycleEnd === period.end
          && row.end === period.end && row.nature === 'hypothetical-projection' && row.trust === 'estimated'
          && Array.isArray(row.goals) && (row.windowKind === 'full-cycle' && row.start === period.start
            || row.windowKind === 'as-of-residual' && row.start === timeline.asOf && row.start > period.start
              && row.start <= period.end && period.timelineRole === 'current')) : [];
        const projection = matches.length === 1 ? matches[0] : null;
        const projectionGaps = projection ? timeline.fundingGaps.filter(row => isValidIsoCalendarDate(row.date)
          && row.date >= projection.start && row.date <= projection.end) : [];
        const projectionLabel = projection?.windowKind === 'as-of-residual'
          ? 'Remaining this period' : 'This period';
        const projectionWindow = projection ? '<p class="operating-note" data-budget-savings-projection-window>Hypothetical projection · '
          + budgetBrowseEscape(fmtDate(projection.start)) + ' – ' + budgetBrowseEscape(fmtDate(projection.end))
          + '. Actual contributions unknown.</p>' : '';
        const rows = goals.map(goal => {
          const ref = goal.goalRef || goal.ref;
          const contribution = proposedKnown && ref?.kind !== 'group' && goal.resolved !== false
            ? progress?.goals?.find(row => row.id === ref?.id)?.proposal : null;
          const projectedGoals = projection?.goals.filter(row => row.key === goal.key) || [];
          const projectedGoal = projectedGoals.length === 1 && goal.resolved !== false
            ? projectedGoals[0] : null;
          const projectedAmount = projectedGoal?.actualSaved === null && projectedGoal.actualContribution === null
            && projectedGoal.trust === 'estimated' ? projectedGoal.projectedContribution : null;
          const needed = typeof goal.targetMax === 'number' && Number.isFinite(goal.targetMax) && goal.targetMax >= goal.target
            ? amount(goal.target, goal.targetTrust) + (goal.targetMax > goal.target ? ' – ' + amount(goal.targetMax, goal.targetTrust) : '')
            : '<span class="budget-v3-unknown">Unknown</span>';
          return `<li data-budget-savings-total-goal="${budgetBrowseEscape(goal.key)}">
            <span>${budgetBrowseEscape(goal.label || 'Goal name not confirmed')}</span>
            <span><span data-budget-savings-total-saved>${amount(goal.backedTrust === 'calculated' ? goal.backed : null, goal.backedTrust)}</span> / <span data-budget-savings-total-needed>${needed}</span><small>Saved / needed</small></span>
            <span><span data-budget-savings-proposed${projection ? ' data-budget-savings-projection' : ''}>${projection ? amount(projectedAmount, 'estimated') : proposed(contribution)}</span><small>${projection ? projectionLabel : 'This period'}</small></span>
          </li>`;
        }).join('');
        const gap = proposedKnown && period.plannedCostFunding?.gap;
        detail = `<section data-budget-planned-savings-summary>
          ${!proposedKnown ? '<p data-budget-savings-unconfirmed>Funding plan not confirmed</p>' : ''}
          ${projectionGaps.length ? '<p class="crit" data-budget-savings-projection-gap>Funding shortfall · see Info</p>' : ''}
          ${rows ? '<ul class="budget-savings-contributions">' + rows + '</ul>' : ''}
          ${!rows ? '<p>Total goal savings not confirmed</p>' : ''}
          ${gap ? '<p class="crit">Funding shortfall: ' + budgetBrowseMoney(gap.shortBy, period.plannedCostFunding.trust) + '.</p>' : ''}
          <details class="budget-savings-info" data-budget-savings-info><summary>Info</summary><div>${stockEvidence}${projectionWindow}${projection ? '<p class="operating-note">This period and Remaining this period show projected contributions. They are proposals, not money already saved, confirmed assignments or instructions to transfer. Unknown dated requirements remain unknown.</p>' : ''}${projectionGaps.map(row => '<p class="operating-note crit" data-budget-savings-projection-gap-detail>' + budgetBrowseEscape(fmtDate(row.date)) + ' · ' + budgetBrowseEscape(row.poolId === null ? 'Operating cash' : timeline.pools?.find(pool => pool.id === row.poolId)?.label || 'Pool name unknown') + ' · projected shortfall ' + amount(row.amount, 'estimated') + '</p>').join('')}${inventory && typeof SavingsInventory !== 'undefined' ? SavingsInventory.html(savingsContext?.daily || inventory, { asOf: savingsContext?.asOf, period }) : ''}${answer}${evidence}</div></details>
        </section>`;
        if (dailySavings) detail = budgetDailySavingsHtml(dailySavings, `${stockEvidence}${answer}${evidence}`, inventory, { asOf: savingsContext?.asOf, period });
      }
      const graph = summary.stock ? '' : ratioKey && ratioKey !== 'savings' ? budgetProgressBarHtml(progress, ratioKey) : `<span class="budget-waterfall-track${classes}" data-budget-bar-state="${state}" aria-hidden="true">
        ${bars}${signedScale ? '<span class="budget-waterfall-zero">0</span>' : ''}${state === 'zero-income'
          ? '<span class="budget-waterfall-scale-note">Zero income</span>' : state === 'unscaled'
            ? '<span class="budget-waterfall-scale-note">Scale unavailable</span>' : ''}
        ${overflowStart ? '<span class="budget-waterfall-overflow at-start">←</span>' : ''}${overflowEnd ? '<span class="budget-waterfall-overflow at-end">→</span>' : ''}
      </span>`;
      // Print-only Q07 hooks: data-budget-result-trust (null stamp = calculated)
      // and [data-budget-result-amount], the same money2 text without the ≈
      // prefix, empty when unavailable. Visible text is unchanged.
      const resultHook = number === '07' && !(ratioKey && ratioKey !== 'savings');
      const resultTrust = known ? summary.trust === 'estimated' ? 'estimated' : 'calculated' : 'unavailable';
      return `<div class="operating-question budget-step${kind ? ` budget-step-${kind}` : ''}" data-operating-question="${number}" data-operating-prompt="${prompt}"${compactOverview && number === '07' ? ' data-budget-period-result' : ''}${resultHook ? ` data-budget-result-trust="${resultTrust}"` : ''}${summary.stock ? ' data-budget-savings-stock' : ''}>
        <details class="budget-step-details">
          <summary class="budget-step-summary">
            <span class="operating-number" aria-hidden="true">${summary.stock ? '•' : number === '02' || kind === 'credit' ? '+' : (number === '04' || number === '06' || number === 'savings' ? '−' : '=')}</span>
            <span class="budget-step-title"><span class="operating-prompt" role="heading" aria-level="2">${prompt}</span>${compactOverview ? summary.stock && stockDateLabel ? `<span class="budget-step-caption" data-budget-savings-observed-date>${budgetBrowseEscape(stockDateLabel)}</span>` : '' : `<span class="budget-step-caption">${summary.note}</span>`}</span>
            ${graph}
            <span class="budget-step-value"${known && summary.amount < 0 ? ' data-sign="negative"' : ''}>${ratioKey && ratioKey !== 'savings' ? budgetProgressValueHtml(progress, ratioKey) : resultHook
              ? `${known ? estimate : 'Unavailable'}<span data-budget-result-amount>${known ? money2(summary.amount) : ''}</span>`
              : known ? estimate + money2(summary.amount) : 'Unavailable'}</span>
            <span class="budget-step-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="operating-answer budget-step-body">${detail}</div>
        </details>
      </div>`;
    }
    return `<div class="operating-question${kind ? ` operating-${kind}` : ''}" data-operating-question="${number}" data-operating-prompt="${prompt}">
      <div class="operating-number">${number}</div>
      <h2 class="operating-prompt">${prompt}</h2>
      <div class="operating-answer">${answer}${summary?.appendix || ''}</div>
    </div>`;
  };
  const unavailable = planUnavailable ? calendarCurrentUnavailableHtml(period) : null;
  let opening = '';
  if (showSnapshotOpening) {
    if (period.openingKnown) {
      const openingAlloc = {
        available: period.opening != null ? period.opening : period.currentBalance,
        cashBasis: null,
        asOf: period.start,
      };
      opening = q('01', 'Opening balance',
        cashGlanceHtml(openingAlloc, null, period.cashNote), 'opening');
    } else {
      opening = q('01', 'Opening balance',
        `<div class="payday-cash" data-payday-cash>
          <p class="operating-lead">${period.cashNote || 'Opening is not today\'s balance.'}</p>
        </div>`, 'opening');
    }
  }
  const funding = period.plannedCostFunding;
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const fundingKnown = funding && (funding.status === 'ready' || funding.status === 'funding-gap')
    && funding.start === period.start && funding.end === period.end
    && numeric(funding.contribution) && funding.contribution >= 0 && numeric(funding.afterProposedFunding)
    && (funding.trust === 'calculated' || funding.trust === 'estimated');
  const savingsPublication = compactOverview
    ? budgetProgressFor(period, savingsContext?.asOf ?? period.budgetProgressAsOf) : null;
  const savingsFundingKnown = fundingKnown && (!compactOverview
    || savingsPublication && funding.source === 'Forecast.planSpendPaydayFunding' && funding.basis === 'selected-Budget-period'
      && funding.asOf === savingsPublication?.asOf);
  const fundingEstimate = fundingKnown && funding.trust === 'estimated' ? ' ≈ estimated' : '';
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fundMoney = value => fundingKnown && numeric(value) ? money2(value) + fundingEstimate : 'Unavailable';
  const costMoney = row => numeric(row.cost) && row.confidence === 'confirmed' ? money2(row.cost)
    : numeric(row.cost) && row.confidence === 'estimated' ? money2(row.cost) + ' ≈ estimated' : 'Unavailable';
  const costRows = funding && Array.isArray(funding.items) ? funding.items : [];
  const unscheduled = fundingKnown && Array.isArray(funding.unscheduled) ? funding.unscheduled : [];
  const itemDetails = `${costRows.map(row => `<div class="budget-funding-item" data-budget-funding-item="${escape(row.id)}">
      <h3>${escape(row.label)}</h3>
      <div class="operating-line"><span>This period — proposed</span><span>${fundMoney(row.contribution)}</span></div>
      <div class="operating-line"><span>Cumulative proposed / cost</span><span>${fundMoney(row.cumulativeProposed)} / ${costMoney(row)}</span></div>
      <div class="operating-line"><span>Still to set aside after this period</span><span>${fundMoney(row.remainingGap)}</span></div>
      ${numeric(row.ceiling) && numeric(row.cost) && row.ceiling > row.cost ? `<p class="operating-note">Estimated cost range: ${costMoney(row)}–${money2(row.ceiling)}. The upper estimate remains additional uncertainty.</p>` : ''}
      <p class="operating-note">Planning date: ${escape(row.date || 'Unavailable')} · Destination account: ${row.reserveParts && row.reserveParts.length ? row.reserveParts.map(part => escape(part.label || part.accountId)).join(' · ') : 'unavailable'} · Actual saved: ${numeric(row.actualSaved) ? money2(row.actualSaved) + ' calculated backing' : 'unavailable'}.</p>
    </div>`).join('')}`;
  const fundingBody = fundingKnown ? `<p class="operating-note">Proposed earmarks from this Budget period's income, bills and household allowance. They are not transfers or money already saved.</p>
    ${itemDetails}
    ${unscheduled.map(row => `<div class="budget-funding-item" data-budget-funding-item="${escape(row.id)}"><h3>${escape(row.label)}</h3>
      <p>${costMoney(row)} · ${escape(row.date || row.when || 'Date unknown')}</p><p class="operating-note">${escape(row.reason)} Proposed contribution and saved balance: unavailable.</p></div>`).join('')}
    ${funding.gap ? `<p class="operating-note crit">Funding shortfall: ${fundMoney(funding.gap.shortBy)}. This projection does not fully cover the protected plan.</p>` : ''}
    ${numeric(funding.proposedFundingForBillPayments) && funding.proposedFundingForBillPayments > 0 ? `<p class="operating-note">${fundMoney(funding.proposedFundingForBillPayments)} of this period's bill deduction is paid from earlier proposed funding. Forecast adds that protection back once in the final proposed balance, so the payment and contribution are not deducted twice.</p>` : ''}
    <p class="operating-note">DEFICIT PLANNING is for Fusion and related sports; SAVINGS-DONT TOUCH is for property tax and home insurance. Account funding and silver draws are not assigned by this projection.</p>`
    : `<p class="operating-note">${escape(funding && funding.reason || 'Forecast has not published a funding schedule for this period.')} ${confirmedSavings ? 'See the savings inventory for confirmed assignments and observed backing.' : 'Actual saved balances and the original payday plan remain unavailable.'}</p>${itemDetails}`;
  // A closing arithmetic identity does not qualify historical income, bill
  // settlement and Household evidence as a whole-period BAD publication.
  // Withhold only the aggregate presentation; keep each published source term.
  const history = period.budgetProgress;
  const historical = period.timelineRole === 'past' || period.lookback === true;
  const historicalBadWithheld = historical && !(period.predictedEndingBalanceTerms?.identity === 'balance-after-deductions'
    && period.predictedEndingBalanceTerms.closes === true
    && numeric(period.predictedEndingBalanceTerms.balanceAfterDeductions)
    && ['calculated', 'estimated'].includes(period.balanceAfterDeductionsTrust ?? 'calculated')
    && history?.source === 'Forecast.budgetPeriodProgress'
    && history.start === period.start && history.end === period.end
    && [history.income?.actual, history.bills?.actual, history.household?.actual].every(part =>
      part?.completeness === 'complete' && numeric(part.amount)
      && ['calculated', 'estimated'].includes(part.trust)));
  const historicalBadNote = 'Historical Balance After Deductions is unavailable. Whole-period income, bill settlement and Household evidence have not been qualified together. Household transaction coverage alone does not qualify this balance.';
  const fundedBalanceKnown = !historicalBadWithheld && fundingKnown && numeric(funding.afterProposedFunding);
  const finalAmount = historicalBadWithheld ? null : dailySavings ? period.afterHouseholdBudget : fundedBalanceKnown ? funding.afterProposedFunding
    : (period.predictedEndingBalance != null ? period.predictedEndingBalance : period.afterHouseholdBudget);
  const finalTrust = historicalBadWithheld ? 'unavailable' : dailySavings ? period.balanceAfterDeductionsTrust : fundedBalanceKnown ? funding.trust : period.balanceAfterDeductionsTrust;
  // Forecast's optional household/final trust stamp is null for calculated
  // values; explicit unavailable/unknown/untrusted stamps still fail closed.
  const finalKnown = numeric(finalAmount) && (finalTrust == null || ['calculated', 'estimated'].includes(finalTrust));
  const finalCaption = dailySavings ? 'After bills and household budget, before unsent savings top-ups' : fundedBalanceKnown
    ? 'After bills, household and proposed funding — retain any future carry'
    : 'Before savings — the funding deduction is unavailable';
  // Same print-only result hooks as Q07 on the non-compact hero.
  const finalHero = !planUnavailable ? `<div class="budget-period-result" data-budget-period-result data-budget-result-trust="${finalKnown ? finalTrust === 'estimated' ? 'estimated' : 'calculated' : 'unavailable'}">
    <h2>Balance After Deductions</h2>
    <p class="budget-period-result-value"${finalKnown && finalAmount < 0 ? ' data-sign="negative"' : ''}>${finalKnown
      ? `${finalTrust === 'estimated' ? compactOverview ? '<span class="est">≈<span class="budget-cash-sr"> estimated</span></span> ' : '<span class="est">≈ estimated</span> ' : ''}<span data-budget-result-amount>${money2(finalAmount)}</span>` : 'Unavailable<span data-budget-result-amount></span>'}</p>
    <p class="budget-period-result-caption">${historicalBadWithheld ? historicalBadNote : compactOverview ? fundedBalanceKnown ? 'Depends on staying on budget.' : 'Before savings · funding unavailable' : finalCaption}</p>
  </div>` : '';
  // Print-only: Forecast's published Balance After Deductions terms for this
  // pay period (advice.payPeriodViews[i].predictedEndingBalanceTerms). Every
  // amount is read from that one object; nothing is added, subtracted or
  // substituted here. A missing, non-closing or untrusted term is Unavailable;
  // there is no fallback to afterHouseholdBudget, funding or plan strings.
  // Stable hooks for other renderers: [data-bad-terms] per period, then
  // [data-bad-term="<key>"] [data-bad-term-value] with data-bad-term-trust.
  // [data-bad-term-amount] sits inside the value: the same money2 text with
  // no ≈ prefix (the trust attribute carries estimated); empty when unavailable.
  const badTerms = period.predictedEndingBalanceTerms;
  const badTermsKnown = !!badTerms && badTerms.identity === 'balance-after-deductions' && badTerms.closes === true;
  const badTermRow = (key, label, trust, nullIsCalculated) => {
    const value = badTermsKnown ? badTerms[key] : null;
    const stamp = trust == null && nullIsCalculated ? 'calculated' : trust;
    const known = !(historicalBadWithheld && key === 'balanceAfterDeductions')
      && numeric(value) && (stamp === 'calculated' || stamp === 'estimated');
    const mark = known && stamp === 'estimated' ? compactOverview
      ? '<span class="est">≈<span class="budget-cash-sr"> estimated</span></span> ' : '<span class="est">≈ estimated</span> ' : '';
    return `<div class="operating-line" data-bad-term="${key}" data-bad-term-trust="${known ? stamp : 'unavailable'}"><span data-bad-term-label>${label}</span><span data-bad-term-value>${known ? mark : 'Unavailable'}<span data-bad-term-amount>${known ? money2(value) : ''}</span></span></div>`;
  };
  // When the Q07 figure is the after-proposed-funding balance, say so: the
  // published term is before savings funding, so the two are not one figure.
  const badTermsFace = !dailySavings && fundedBalanceKnown ? 'after-proposed-funding' : 'balance-after-deductions';
  const badTermsHtml = `<div class="operating-lines budget-bad-terms" data-bad-terms data-bad-terms-period="${escape(period.id || period.start || '')}" data-bad-terms-status="${badTermsKnown ? 'published' : 'unavailable'}" data-bad-terms-face="${badTermsFace}">
    ${historicalBadWithheld ? `<p class="operating-note" data-bad-historical-withheld>${historicalBadNote} The source terms below retain their individual published qualifications.</p>` : ''}
    <p class="operating-note">Forecast's published terms for this period. Balance After Deductions is period income less assigned bills and the household amount.${badTermsFace === 'after-proposed-funding' ? ' These terms are before proposed savings funding; the period result above is after it.' : ''}</p>
    ${badTermRow('periodIncome', 'Period income', period.incomeTrust, false)}
    ${badTermRow('assignedBills', 'Assigned bills (incl. required debt minimums)', period.periodBillLoadTrust, false)}
    ${badTermRow('householdBudgetHold', 'Household (greater of plan or spent, incl. Other)', period.budgetHoldTrust, true)}
    ${badTermRow('balanceAfterDeductions', 'Balance After Deductions', period.balanceAfterDeductionsTrust, true)}
  </div>`;
  const today = period.fromTodayFunding;
  const todayHtml = calendarFromTodayEvidenceHtml(period, plan);
  const savingsRow = () => q('savings', compactOverview ? 'Planned Savings' : 'Proposed savings', planUnavailable ? unavailable : fundingBody, null,
    compactOverview ? { stock: true, amount: stockKnown ? stock.amount : null,
      trust: stockKnown ? stock.trust : 'unavailable', trustRequired: true, discloseUnknown: true,
      note: 'Combined observed savings balance; item funding is separate' }
    : { amount: savingsFundingKnown ? funding.contribution : null, trust: savingsFundingKnown ? funding.trust : 'unavailable',
      trustRequired: true, discloseUnknown: true, barStart: savingsFundingKnown && fundedBalanceKnown ? funding.afterProposedFunding : null,
      note: 'Named costs - proposed funding, separate from actual saved cash' });
  return `${compactOverview ? "" : todayHtml}<section class="calendar-waterfall" data-calendar-waterfall="${period.id || ''}" data-calendar-role="${period.role || ''}"${planUnavailable ? ' data-operating-plan="unavailable"' : ''}>
    <div class="payday-group calendar-waterfall-head">${period.label}${period.rangeLabel ? ` · ${period.rangeLabel}` : ''}</div>
    ${compactOverview ? `<p class="budget-period-flow-heading">Full-period projection</p><details class="budget-period-info"><summary aria-label="About the selected period figures">ⓘ</summary><div data-budget-period-info-body>
      ${today ? '<p class="operating-note">This view uses full period income. The dated current-cash proposal is separate.</p>' : ''}${lookbackNote}${projectedNote}${openingUnknownNote}
      <p class="operating-note">Values marked ≈ are estimates. Opening and current balances are context, not extra income. Period results include Forecast's household spending reserve and any recorded overspending. Future funding and required protection are planning amounts; they are not transfers already made.</p>${opening}${todayHtml}</div></details>`
      : `${today ? '<p class="operating-note">The pay-period view below uses the full period income. It is separate from the dated current-cash proposal above.</p>' : ''}${lookbackNote}${projectedNote}${openingUnknownNote}`}
    ${compactOverview ? '' : finalHero}
    ${compactOverview ? '' : opening}
    ${q('02', 'Income', planUnavailable ? unavailable : calendarIncomeHtml(period), null,
      { amount: period.available, trust: period.incomeTrust, trustRequired: true, barStart: 0, note: 'Receipts and dates — planned or received' })}
    ${q('04', 'Bills', planUnavailable ? unavailable : calendarPeriodBillsHtml(period), null,
      { amount: period.periodBillLoad, trust: period.periodBillLoadTrust, trustRequired: true, barStart: period.afterBills, note: 'Period deduction, including required debt minimums' })}
    ${q('05', 'Balance after bills', planUnavailable ? unavailable : runningLeftoverHtml(period.afterBills != null ? period.afterBills : period.afterRemainingBills), 'balance',
      { amount: period.afterBills != null ? period.afterBills : period.afterRemainingBills, trust: period.afterBillsTrust, trustRequired: true, barStart: 0, note: 'Period income after the bill deduction' })}
    ${q('06', 'Household budget', planUnavailable ? unavailable : calendarBudgetHtml(period, liveOverlay, plan,
      compactOverview ? budgetRemainingEvidenceContext(period) : {}), null,
      { amount: period.budgetHold, trust: period.budgetHoldTrust, barStart: period.afterHouseholdBudget, note: 'Targets, actual spending and the period reserve' })}
    ${compactOverview ? '' : savingsRow()}
    ${!dailySavings && fundingKnown && numeric(funding.proposedFundingForBillPayments) && funding.proposedFundingForBillPayments > 0
      ? q('reserve-use', 'Earlier proposed funding for bills',
        '<p class="operating-note">Projected use of earlier earmarks for costs already included in Bills above. This offsets that bill deduction once; it is not extra income, observed saved cash or an actual withdrawal.</p>', 'credit',
        { amount: funding.proposedFundingForBillPayments, trust: funding.trust, trustRequired: true, barStart: 0,
          note: 'Planning only — bill payment offset, not new income' }) : ''}
    ${q('07', 'Balance After Deductions', planUnavailable ? unavailable : (compactOverview
      ? `<p class="operating-note">${historicalBadWithheld ? historicalBadNote : `Full-period projection: ${finalCaption}. Current Bills cash is context and is not added to period income.`}</p>`
      : runningLeftoverHtml(finalAmount, finalTrust))
      + '<p class="operating-note">A positive period balance may be needed for a later short period. It is not permission to spend.</p>', 'balance',
      { amount: finalAmount, trust: finalTrust, discloseUnknown: true, barStart: 0, appendix: badTermsHtml, note: historicalBadWithheld ? historicalBadNote : fundedBalanceKnown
        ? 'After bills, household and proposed funding — retain any future carry'
        : 'Before savings — the funding deduction is unavailable' })}
    ${compactOverview ? savingsRow() : ''}
  </section>`;

}

function paydayCarryoverHtml(period) {
  if (!period || period.paydayCarryoverKnown !== true || period.paydayCarryover == null) {
    return '';
  }
  const asOf = period.paydayCarryoverAsOf || period.paydayCarryoverPayday;
  const when = asOf ? `Cash carried to ${fmtDateLong(asOf)}. ` : '';
  return `<div class="operating-question operating-ending" data-operating-question="carryover" data-payday-carryover>
    <h2 class="operating-prompt">Payday carryover</h2>
    <div class="operating-answer">
      <div class="payday-cash">
        <span class="operating-amount" data-payday-carryover-amount>${money2(period.paydayCarryover)}</span>
        <p class="operating-note">${when}Carried forward, not income.</p>
      </div>
    </div>
  </div>`;
}

function paydayCarryoverTrendHtml(trend) {
  const points = (trend && trend.points) || [];
  if (!points.length) {
    return `<section class="calendar-waterfall" data-payday-carryover-trend>
      <div class="payday-group calendar-waterfall-head">Payday carryover</div>
      <p class="operating-note">No completed pay periods to show.</p>
    </section>`;
  }
  const knownAbs = points
    .filter(p => p && p.known === true && p.amount != null && Number.isFinite(Number(p.amount)))
    .map(p => Math.abs(Number(p.amount)));
  const max = knownAbs.length ? Math.max(...knownAbs) : 0;
  const rows = points.map(p => {
    if (!p || !p.payday) return '';
    const when = fmtDate(p.payday);
    const known = p.known === true
      && p.amount != null
      && Number.isFinite(Number(p.amount));
    if (!known) {
      return `<li class="carryover-row" data-carryover-known="false" data-carryover-payday="${p.payday}">
        <span class="carryover-when">${when}</span>
        <span class="carryover-track carryover-track-unknown" aria-hidden="true"></span>
        <span class="carryover-amount carryover-unknown">Unknown</span>
      </li>`;
    }
    const amt = Number(p.amount);
    const zero = amt === 0;
    const sign = amt < 0 ? 'negative' : (zero ? 'zero' : 'positive');
    // Length uses abs vs the largest known magnitude. Direction keeps the
    // sign: leftover grows right of center, a deficit grows left. A known
    // negative must not share the leftover-direction bar.
    const halfPct = max > 0 ? Math.min(50, (Math.abs(amt) / max) * 50) : 0;
    const bar = zero
      ? ''
      : `<span class="carryover-bar carryover-bar-${sign}" style="width:${halfPct.toFixed(1)}%"></span>`;
    return `<li class="carryover-row" data-carryover-known="true" data-carryover-sign="${sign}"${zero ? ' data-carryover-zero="true"' : ''} data-carryover-payday="${p.payday}">
      <span class="carryover-when">${when}</span>
      <span class="carryover-track" aria-hidden="true"><span class="carryover-spine"></span>${bar}</span>
      <span class="carryover-amount" data-payday-carryover-amount>${money2(amt)}</span>
    </li>`;
  }).join('');
  return `<section class="calendar-waterfall" data-payday-carryover-trend>
    <div class="payday-group calendar-waterfall-head">Payday carryover</div>
    <p class="operating-note">Spendable cash remaining at payday. Not savings, not income, not extra money to spend.</p>
    <ol class="carryover-list">${rows}</ol>
  </section>`;
}

function historicalPeriodHtml(period) {
  if (!period) return '';
  const q = (number, prompt, answer) => `
    <div class="operating-question" data-operating-question="${number}" data-operating-prompt="${prompt}">
      <div class="operating-number">${number}</div>
      <h2 class="operating-prompt">${prompt}</h2>
      <div class="operating-answer">${answer}</div>
    </div>`;
  return `<section class="calendar-waterfall" data-calendar-waterfall="${period.id || ''}" data-calendar-role="lookback" data-historical-period>
    <div class="payday-group calendar-waterfall-head">${period.label || 'Completed pay period'}${period.rangeLabel ? ` · ${period.rangeLabel}` : ''}</div>
    <p class="operating-note">Completed pay period. Not today's balance.</p>
    ${q('02', 'Income', calendarIncomeHtml(period))}
    ${q('04', 'Bills', calendarPeriodBillsHtml(period))}
    ${q('06', 'Household budget', calendarBudgetHtml(period))}
    ${paydayCarryoverHtml(period)}
  </section>`;
}

function calendarPickerHtml(view, show, extraControls) {
  const periods = (view && view.calendarPeriods) || [];
  if (periods.length < 2) return extraControls || '';
  const activeId = (view && view.activeCalendarPeriodId) || (periods[0] && periods[0].id);
  const current = show || activeId;
  const btn = (value, label, cls) => {
    const on = current === value ? ' aria-pressed="true"' : ' aria-pressed="false"';
    return `<button type="button" class="calendar-period-btn${cls ? ` ${cls}` : ''}" data-calendar-show="${value}"${on}>${label}</button>`;
  };
  // Period name on one line, its dates on the next: the two planning windows
  // read as a switch, and the range is visible without a caption.
  const caption = p => p.rangeLabel
    ? `<span class="calendar-period-name">${p.label}</span><span class="calendar-period-dates">${p.rangeLabel}</span>`
    : `<span class="calendar-period-name">${p.label}</span>`;
  return `<div class="calendar-period-picker" data-calendar-period-picker>
    <p class="operating-lead calendar-period-label" id="calendar-period-label">Pay periods</p>
    <div class="calendar-period-switch" role="group" aria-labelledby="calendar-period-label">
      ${btn(periods[0].id, caption(periods[0]))}
      ${btn(periods[1].id, caption(periods[1]))}
    </div>
    ${btn('both', 'Show both', 'calendar-period-both')}
    ${extraControls || ''}
  </div>`;
}

function calendarWaterfallsHtml(view, show, liveOverlay, alloc, extraControls, plan) {
  const periods = (view && view.calendarPeriods) || [];
  if (!periods.length) return '';
  const activeId = (view && view.activeCalendarPeriodId) || (periods[0] && periods[0].id);
  const pick = show || activeId;
  const visible = pick === 'both' ? periods : periods.filter(p => p.id === pick);
  const shown = visible.length ? visible : periods.filter(p => p.id === activeId);
  const undated = (view && view.undatedBills) || [];
  const undatedLines = undated.map(periodBillLine).join('');
  const undatedBlock = undatedLines
    ? `<div data-bill-section="needs-date" class="calendar-undated">
        <div class="payday-group">Needs a date</div>
        <div class="operating-lines">${undatedLines}</div>
        <p class="operating-note">Not included in either period's remaining bills.</p>
      </div>`
    : '';
  const asOf = (view && view.asOf) || (alloc && alloc.asOf) || '';
  const asOfAttr = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf))
    ? ` data-household-as-of="${asOf}"` : '';
  return `<div class="calendar-waterfalls" data-calendar-waterfalls${asOfAttr}>
    ${liveCurrentBalanceHtml(view, liveOverlay, alloc)}
    ${calendarPickerHtml(view, pick, extraControls)}
    ${shown.map(period => calendarWaterfallHtml(period, liveOverlay, alloc, plan)).join('')}
    ${undatedBlock}
  </div>`;
}

function payPeriodSelection(advice, requestedId) {
  const rows = Array.isArray(advice && advice.payPeriodViews)
    ? advice.payPeriodViews.filter(Boolean)
    : [];
  if (!rows.length) return { rows, index: -1, period: null };
  const rowId = row => String((row && (row.id || row.start)) || '');
  let index = requestedId == null
    ? -1
    : rows.findIndex(row => rowId(row) === String(requestedId));
  if (index < 0) index = rows.findIndex(row => row.timelineRole === 'current');
  if (index < 0) index = 0;
  return { rows, index, period: rows[index] };
}

function payPeriodMoveSelection(advice, requestedId, step) {
  const selection = payPeriodSelection(advice, requestedId);
  const nextIndex = selection.index + step;
  if (step !== -1 && step !== 1) return selection;
  if (nextIndex < 0 || nextIndex >= selection.rows.length) return selection;
  return {
    rows: selection.rows,
    index: nextIndex,
    period: selection.rows[nextIndex],
  };
}

function payPeriodRangeLabel(period) {
  if (!period) return 'Pay period unavailable';
  if (period.rangeLabel) return period.rangeLabel;
  if (period.start && period.end) return `${fmtDate(period.start)} – ${fmtDate(period.end)}`;
  return period.start ? fmtDate(period.start) : 'Pay period unavailable';
}

function payPeriodStatusLabel(period) {
  if (!period) return 'Pay period unavailable';
  if (period.timelineRole === 'current') return 'Current pay period';
  if (period.timelineRole === 'past') return 'Completed pay period';
  return 'Projected pay period';
}

function payPeriodSwipeStep(start, end, slotPx) {
  if (!start || !end) return 0;
  const dx = Number(end.x) - Number(start.x);
  const dy = Number(end.y) - Number(start.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  const slot = Number(slotPx);
  const slotKnown = Number.isFinite(slot) && slot >= 24;
  // Callers that have not measured a slot keep the one-step pixel contract.
  if (!slotKnown) {
    if (horizontal < 44 || horizontal <= vertical * 1.35) return 0;
    return dx < 0 ? 1 : -1;
  }
  // Vertical page scrolling wins over a slanted drag.
  if (vertical >= 8 && vertical >= horizontal) return 0;
  if (horizontal < 10 || horizontal < vertical * 1.15) return 0;
  const traveled = -dx / slot;
  // Half a slot rounds away from zero. Math.round(-0.5) is 0, which would
  // make a backward swipe stick while the same forward swipe moves.
  let steps = Math.sign(traveled) * Math.round(Math.abs(traveled));
  const dt = Number(end.t) - Number(start.t);
  // A flick promotes only a drag that has not already reached the next slot,
  // and never adds items past the positional nearest.
  if (steps === 0 && Number.isFinite(dt) && dt >= 16 && dt <= 260 && horizontal >= 16) {
    const velocity = -dx / dt;
    if (Math.abs(velocity) >= 0.55) steps = velocity > 0 ? 1 : -1;
  }
  return steps;
}

// Rubber-band past the first and last centered items. Inside the row the
// track matches the finger one-to-one so the next label can reach center.
function payPeriodDragPixels(dx, index, count, slotPx) {
  if (!(slotPx > 0) || !Number.isFinite(dx)) return dx;
  const min = (index - (count - 1)) * slotPx;
  const max = index * slotPx;
  if (dx > max) return max + (dx - max) * 0.3;
  if (dx < min) return min + (dx - min) * 0.3;
  return dx;
}

function payPeriodNavigatorHtml(selection) {
  if (!selection.period) return '';
  // Reuse only a locale formatter object. Keep the renderer self-contained
  // for the incumbent standalone composers; no dates or figures are cached.
  const periodDateFormat = payPeriodNavigatorHtml.dateFormatter
    || (payPeriodNavigatorHtml.dateFormatter = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }));
  const fullDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
    ? periodDateFormat.format(new Date(`${value}T12:00:00`)) : null;
  const startDate = fullDate(selection.period.start);
  const endDate = fullDate(selection.period.end);
  const fullRange = startDate && endDate ? `${startDate} – ${endDate}` : payPeriodRangeLabel(selection.period);
  const months = payPeriodMonths(selection);
  const closeMonth = payPeriodCloseMonth(selection.period);
  const monthIndex = months.findIndex(month => month.key === closeMonth);
  const wheel = (kind, items, index, slot) => `<div class="budget-wheel budget-wheel-${kind}" data-budget-wheel="${kind}" role="group"
      aria-label="${kind === 'month' ? 'Close month' : 'Pay period'} navigation. Swipe, tap an item, or use left and right arrow keys.">
      <div class="budget-wheel-track" style="--wheel-slot:${slot}%;--wheel-offset:${50 - (index + 0.5) * slot}%">
        ${items.map((item, i) => `<button type="button" class="budget-wheel-item" data-wheel-index="${i}"
          tabindex="${i === index ? 0 : -1}"${i === index ? ' aria-current="true"' : ''}
          aria-label="${item.name}">${item.label}</button>`).join('')}
      </div>
    </div>`;
  return `<div class="pay-period-navigator" data-pay-period-navigator data-selected-close-month="${closeMonth}">
    ${wheel('month', months.map(month => ({
      label: `${month.label}<span class="budget-wheel-year">${month.key.slice(0, 4)}</span>`,
      name: month.name,
    })), monthIndex, 36)}
    ${wheel('period', selection.rows.map(row => ({
      label: payPeriodRangeLabel(row),
      name: `${payPeriodRangeLabel(row).replace(/<[^>]*>/g, '')}, ${payPeriodStatusLabel(row)}`,
    })), selection.index, 40)}
    <p role="status" aria-live="polite" aria-atomic="true" data-selected-pay-period-status>
      <span class="budget-period-full-dates" data-selected-pay-period-range>${fullRange}</span>${payPeriodStatusLabel(selection.period)}
    </p>
  </div>`;
}

// Navigation context only: no reconstructed dates, calendar, or monthly money.
function payPeriodCloseMonth(period) {
  return String((period && period.end) || '').slice(0, 7);
}

function payPeriodMonths(selection) {
  const monthFormat = payPeriodMonths.monthFormatter
    || (payPeriodMonths.monthFormatter = new Intl.DateTimeFormat('en-CA', { month: 'long' }));
  const monthYearFormat = payPeriodMonths.monthYearFormatter
    || (payPeriodMonths.monthYearFormatter = new Intl.DateTimeFormat('en-CA', { month: 'long', year: 'numeric' }));
  const months = [];
  for (const row of selection.rows) {
    const key = payPeriodCloseMonth(row);
    if (months.some(month => month.key === key)) continue;
    const date = new Date(`${row.end}T12:00:00`);
    months.push({
      key,
      id: String(row.id || row.start || ''),
      label: monthFormat.format(date),
      name: monthYearFormat.format(date),
    });
  }
  return months;
}

function payPeriodWheelSelection(advice, requestedId, kind, index) {
  const selection = payPeriodSelection(advice, requestedId);
  if (!Number.isInteger(index)) return selection;
  const items = kind === 'month' ? payPeriodMonths(selection) : selection.rows;
  const item = items[index];
  if (!item) return selection;
  // Re-selecting the current month keeps its period; entering another month
  // resolves to the first published row closing there.
  if (kind === 'month' && item.key === payPeriodCloseMonth(selection.period)) return selection;
  if (kind === 'period' && Math.abs(index - selection.index) === 1) {
    return payPeriodMoveSelection(advice, requestedId, index - selection.index);
  }
  return payPeriodSelection(advice, item.id || item.start);
}

function payPeriodTimelineHtml(advice, requestedId, liveOverlay, alloc, extraControls, plan, compactOverview = false, savingsTimeline = null, dailySavings = null) {
  const selection = payPeriodSelection(advice, requestedId);
  const period = selection.period;
  if (!period) return '';
  const periodId = String(period.id || period.start || '');
  const current = period.timelineRole === 'current';
  const defaultView = (advice && advice.defaultView) || {};
  // Budget polish uses the household financial as-of to age bill trust
  // chrome. Keep the same Forecast/alloc authority as the legacy waterfall;
  // a selected period date (or browser time) is not that authority.
  const asOf = defaultView.asOf || (alloc && alloc.asOf) || '';
  const asOfAttr = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf))
    ? ` data-household-as-of="${asOf}"` : '';
  const savingsContext = { inventory: advice?.savingsInventory, timeline: savingsTimeline, daily: dailySavings, asOf };
  const undated = current ? (defaultView.undatedBills || []) : [];
  const undatedLines = undated.map(periodBillLine).join('');
  const undatedBlock = undatedLines
    ? `<div data-bill-section="needs-date" class="calendar-undated">
        <div class="payday-group">Needs a date</div>
        <div class="operating-lines">${undatedLines}</div>
        <p class="operating-note">Not included in this period's remaining bills.</p>
      </div>`
    : '';
  return `<div class="calendar-waterfalls pay-period-timeline" data-calendar-waterfalls${asOfAttr} data-pay-period-swipe
      data-selected-pay-period="${periodId}" data-pay-period-index="${selection.index}"
      aria-label="Pay-period navigation">
    ${current && !compactOverview ? liveCurrentBalanceHtml(defaultView, liveOverlay, alloc) : ''}
    ${compactOverview ? '' : payPeriodNavigatorHtml(selection)}
    ${extraControls || ''}
    ${calendarWaterfallHtml(period, liveOverlay, alloc, plan, compactOverview, savingsContext)}
    ${typeof badTimelineHtml === 'function' ? badTimelineHtml(advice, compactOverview, savingsContext) : ''}
    ${budgetPlanSpendEarmarkHtml(advice, period)}
    ${undatedBlock}
  </div>`;
}

function budgetSavingsTimelineFor(ctx) {
  if (ctx.plan?.savingsEarmarks?.allocationPolicy != null || ctx.advice?.savingsFunding != null)
    return Forecast.savingsFundingPublication(ctx.advice?.savingsFunding,
      { asOf: ctx.asOf || ctx.advice?.defaultView?.asOf, advice: ctx.advice })?.timeline || null;
  // Pre-policy evidence retains its incumbent native timeline. Current
  // canonical policy can never fall back here, including a missing packet.
  const asOf = ctx.advice?.defaultView?.asOf || ctx.asOf;
  try { return Forecast.savingsFundingTimeline(ctx.plan, ctx.debts, asOf, budgetMonthKnobOpts(ctx)); }
  catch (e) { return null; }
}

// Select only the sealed Forecast packet. No page policy or calculation fallback.
function budgetDailySavingsFor(ctx, periodId = null) {
  const asOf = ctx.asOf || ctx.advice?.defaultView?.asOf;
  const packet = Forecast.savingsFundingPublication(ctx.advice?.savingsFunding,
    { asOf, advice: ctx.advice, periodId });
  if (packet) return packet;
  return { source: 'Budget.savingsDailyFundingUnavailable', asOf, currency: 'CAD', status: 'unavailable',
    reason: 'The shared Forecast savings publication is unavailable.', rows: [], backing: { status: 'unavailable', items: [] },
    period: { status: 'unavailable', proposal: null, actualSaved: null } };
}

// periodContext 'estimate' (Decision 1): a projected period whose Forecast
// close is a reported-balance estimate. Saved and contribution figures keep
// the visible estimated marker instead of the plain period-context money.
function budgetSavingsMoney(amount, trust, periodContext = false) {
  if (periodContext === 'estimate') return budgetV3Money(amount, budgetV3Known(amount, trust) ? 'estimated' : 'unknown');
  return periodContext ? budgetV3Known(amount, trust) ? money2(amount)
    : budgetV3Money(null, 'unknown') : budgetV3Money(amount, trust);
}
const budgetSavingsEstimateClose = packet => packet?.period?.kind === 'projected'
  && packet.forecastClosing?.status === 'ready' && packet.forecastClosing.nature === 'reported-balance-estimate';
const budgetSavingsPeriodContext = packet => budgetSavingsEstimateClose(packet) ? 'estimate'
  : packet?.period?.kind === 'projected';
function budgetSavingsEstimateBasisHtml(packet) {
  if (!budgetSavingsEstimateClose(packet)) return '';
  const c = packet.forecastClosing;
  return '<p data-budget-savings-estimate-basis>' + budgetV3Escape('Estimated from the reported Savings balance dated '
    + c.balanceAsOf + '. ' + (c.assumptions || []).join(' ') + ' Verified backing is withheld: ' + c.verifiedReason) + '</p>';
}

// Needed is a requirement, never the estimate, so 'estimate' renders as the
// ordinary projected context here.
function budgetDailyNeededHtml(row, periodContext = false) {
  if (periodContext === 'estimate') periodContext = true;
  return row.neededRange ? budgetSavingsMoney(row.neededRange.min, row.trust, periodContext)
    + ' - ' + budgetSavingsMoney(row.neededRange.max, row.trust, periodContext)
    : budgetSavingsMoney(row.needed, row.neededTrust ?? row.trust, periodContext);
}

// ATLAS-024 Paid / Still to fund. Paid is Forecast's published
// commitmentCost fact on the goal row (confirmedLinkedPaid). Still to fund
// is Forecast's row-owned publication (PA-2a, Decision 2): stillToFund with
// its trust and reason on the same row the period packet serves, so a
// historical or projected row carries that period's own figure (or Unknown)
// and never borrows today's gap. Nothing is subtracted or recomputed here;
// the figure prints only as published, with its ESTIMATED mark and reason on
// the figure itself, and Unknown (with the published reason) otherwise —
// never 0, and the row is never hidden. The legacy funding-schedule
// stillToFund join (missing Saved read as 0) is retired. Fill geometry is
// ratio-only against the published original cost and draws nothing when a
// point fact it needs is not published. A row that carries no published
// commitmentCost at all keeps its prior face.
const budgetGoalCostFact = fact => fact && fact.status === 'known'
  ? (typeof fact.amount === 'number' && Number.isFinite(fact.amount) ? { amount: fact.amount }
    : fact.range && Number.isFinite(fact.range.min) && Number.isFinite(fact.range.max) ? { range: fact.range } : null)
  : null;
const budgetGoalCostText = fact => !fact ? '<span class="budget-v3-unknown">Unknown</span>'
  : fact.range ? `${money2(fact.range.min)} - ${money2(fact.range.max)}` : money2(fact.amount);
const budgetGoalRatio = (part, whole) => Math.max(0, Math.min(1, part / whole)).toFixed(4);

// Decision 2 copy, shown beside every estimated Still to fund figure.
const BUDGET_GOAL_STILL_TO_FUND_ESTIMATE = 'Estimate: Needed minus Saved. It is a planning gap, not an unpaid balance.';
function budgetGoalStillToFundHtml(row) {
  const known = row?.stillToFundTrust === 'estimated' && typeof row.stillToFund === 'number'
    && Number.isFinite(row.stillToFund) && row.stillToFund >= 0;
  const reason = known ? BUDGET_GOAL_STILL_TO_FUND_ESTIMATE
    : (typeof row?.stillToFundReason === 'string' && row.stillToFundReason) || 'Still to fund is unavailable.';
  return { known, amount: known ? row.stillToFund : null,
    html: (known ? budgetV3Money(row.stillToFund, 'estimated') : '<span class="budget-v3-unknown">Unknown</span>')
      + ` <small class="budget-goal-still-to-fund-reason" data-budget-goal-still-to-fund-reason>${budgetV3Escape(reason)}</small>` };
}

// A5 (R1): the owner's word is proof and is labelled as owner-confirmed,
// never as transaction-verified. Its date is the confirmation date and is
// never printed as a payment date. A full confirmation with no stated amount
// keeps the actual amount and date Unknown. Display only: every figure is
// Forecast's published commitmentCost fact.
function budgetGoalOwnerConfirmationHtml(owner, observed) {
  if (!owner || !['full', 'partial', 'members'].includes(owner.status)) return '';
  const date = typeof owner.confirmedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(owner.confirmedOn)
    ? ` · Confirmed ${budgetV3Escape(fmtDate(owner.confirmedOn))}` : '';
  const actual = owner.status === 'full' ? ' · Actual amount and date <span class="budget-v3-unknown">Unknown</span>' : '';
  const seen = budgetGoalCostFact(observed);
  const spending = seen?.amount != null ? ` · Observed linked spending ${money2(seen.amount)}` : '';
  return ` <small class="budget-goal-owner-confirmation" data-budget-goal-owner-confirmation="${budgetV3Escape(owner.status)}">owner-confirmed${date}${actual}${spending}</small>`;
}
function budgetGoalPaidProgressHtml(row) {
  const cost = row?.commitmentCost;
  if (!cost) return '';
  const owner = cost.ownerConfirmation || null;
  const ownerFull = owner?.status === 'full';
  const paid = budgetGoalCostFact(owner ? cost.paid : cost?.confirmedLinkedPaid);
  const unpaid = budgetGoalCostFact(cost?.unpaidCost);
  const original = budgetGoalCostFact(cost?.originalCost);
  const stillToFund = budgetGoalStillToFundHtml(row);
  const geometry = paid?.amount != null && original?.amount > 0;
  const fullyPaid = ownerFull && unpaid?.amount === 0 || geometry && unpaid?.amount === 0 && paid.amount > 0 && !owner;
  const state = fullyPaid ? 'paid' : geometry ? 'funding' : 'unknown';
  const paidText = ownerFull && !paid ? '—' : budgetGoalCostText(paid);
  const saved = budgetV3Known(row.saved, row.savedTrust) ? row.saved : null;
  const fill = state === 'paid'
    ? '<span class="budget-goal-bar-paid" data-budget-goal-bar-paid style="--goal-paid:1"></span>'
    : state === 'funding'
      ? `${paid.amount > 0 ? `<span class="budget-goal-bar-paid" data-budget-goal-bar-paid style="--goal-paid:${budgetGoalRatio(paid.amount, original.amount)}"></span>` : ''}${saved > 0 ? `<span class="budget-goal-bar-saved" data-budget-goal-bar-saved style="--goal-saved:${budgetGoalRatio(saved, original.amount)}"></span>` : ''}`
      : '';
  const stamp = (name, fact) => fact?.amount != null ? ` data-budget-goal-${name}-amount="${fact.amount}"` : '';
  const gapStamp = stillToFund.known ? ` data-budget-goal-still-to-fund-amount="${stillToFund.amount}"` : '';
  return `<div class="budget-goal-paid is-${state}" data-budget-goal-paid-progress="${state}"${stamp('paid', paid)}${stamp('original', original)}${gapStamp}>
        <span class="budget-goal-bar" data-budget-goal-bar aria-hidden="true">${fill}</span>
        <span class="budget-goal-paid-figures" data-budget-goal-paid-figures><span><small>Paid</small> <span class="budget-goal-paid-amount" data-budget-goal-paid>${paidText}</span>${budgetGoalOwnerConfirmationHtml(owner, cost.observedLinked)}</span><span><small>Still to fund</small> <span class="budget-goal-paid-amount" data-budget-goal-still-to-fund>${stillToFund.html}</span></span></span>
      </div>`;
}


// The Travel Visa annual fee is a bill, not a savings goal. Forecast still
// publishes its yearly-bill funding row (the reserve protection is unchanged),
// but the Savings lists do not print it: it is shown under Bills as an
// upcoming annual bill (budgetUpcomingAnnualBill). Display-only — the
// packet, its funding and its totals are never altered here. Identity is
// the published row key, which Forecast derives from the backing item's
// source + id; the label, amount and date are never matched.
const BUDGET_SAVINGS_ANNUAL_BILL_ROW = 'yearly-bill:travelvisa-annual-fee-2027';
const BUDGET_SAVINGS_ANNUAL_BILL_ID = 'travelvisa-annual-fee-2027';
// One neutral note in every state — normal publication, unavailable-
// publication fallback (bare or prefixed identity), historical period and
// the occurrence's own period (Atlas, Slack 1791764127.160729, superseding
// the destination-claiming copy of 4243785333): it states only that the fee
// is treated as a bill and that its funding is unchanged, and never claims
// anything about the Bills destination the current view happens to render.
const BUDGET_SAVINGS_ANNUAL_BILL_NOTE = 'Travel Visa annual fee is treated as a bill; its funding is unchanged.';

function budgetDailySavingsRows(packet, inventory, roster = []) {
  let rows;
  if (packet?.rows?.length) {
    rows = packet.period?.kind === 'projected' && packet.forecastClosing != null
      ? (packet.forecastClosing?.status === 'ready' ? packet.forecastClosing.rows : packet.forecastClosing?.gap ? [] : packet.plannedRequirements?.rows || []).map(row => ({ ...row,
        saved: row.forecastSaved ?? null, savedTrust: row.forecastSaved == null ? 'unknown' : 'estimated',
        thisPeriod: row.forecastContribution ?? null, thisPeriodTrust: row.forecastContribution == null ? 'unknown' : 'estimated' }))
      : packet.rows;
  } else {
    // Preserve published goal names even when policy/evidence withholds amounts.
    // This roster supplies labels only; no old proposal/backing is substituted.
    const seen = new Set();
    rows = [...(inventory?.goals || []), ...(inventory?.pools || []).flatMap(pool => pool.plannedGoals || []),
      ...roster.map(row => ({ key: row.id, label: row.label }))]
      .filter(row => row?.key && !seen.has(row.key) && seen.add(row.key))
      .map(row => ({ key: row.key, label: row.label, saved: null, needed: null, thisPeriod: null }));
  }
  // The unavailable-publication fallback above names roster items by their
  // bare item id, not the published row key, so the exclusion must match
  // both canonical identity forms of this one fee — never its label.
  const visible = rows.filter(row => row?.key !== BUDGET_SAVINGS_ANNUAL_BILL_ROW
    && row?.key !== BUDGET_SAVINGS_ANNUAL_BILL_ID);
  if (visible.length !== rows.length) visible.annualBillExcluded = true;
  return visible;
}

function budgetSavingsAnnualBillNoteHtml(listed) {
  if (!listed?.annualBillExcluded) return '';
  return `<p class="budget-savings-bill-note" data-budget-savings-annual-bill-note>${BUDGET_SAVINGS_ANNUAL_BILL_NOTE}</p>`;
}

// Presentation join only. A grouped row's members are already published by
// Forecast (backing.items, plus unresolved for withheld members) and its
// this-period components already published in period.cycleAllocations —
// the same entries Forecast itself sums into the row's thisPeriod. Nothing
// here computes a figure: a member prints only when its key matches exactly
// one published item, and a member allocation prints only when exactly one
// published allocation names it; otherwise the figure stays unavailable and
// the group-level published value stands. Settled members are absent from
// the publication and are never reconstructed here.
//
// The allocation identity follows the period kind Forecast publishes:
// current packets name allocations by occurrence key (item.key), projected
// packets by bare requirement id (item.id) — the same split Forecast's own
// row sums use. Only the applicable form is consulted (never a dual-alias
// fallback), and it must be unique across the published items and the
// allocations alike; an ambiguous identity fails closed. Historical packets
// withhold the group's figures (rows publish needed=null /
// neededTrust=unknown while backing items retain current requirement
// metadata), so member figures withhold identically: names and dates are
// the published roster, never today's numbers under a historical group.
function budgetSavingsRowMembers(packet, row) {
  const keys = Array.isArray(row?.members) ? row.members : [];
  if (keys.length < 2) return null;
  const closing = packet?.period?.kind === 'projected' && packet.forecastClosing?.status === 'ready';
  const published = closing ? packet.forecastClosing.items.map(item => ({ ...item,
      saved: item.forecastSaved, trust: item.forecastTrust })) : packet?.period?.kind === 'projected' && packet.plannedRequirements
      ? packet.plannedRequirements.items : [...(packet?.backing?.items || []), ...(packet?.unresolved || [])];
  const byKey = new Map();
  for (const item of published) {
    if (!item?.key) continue;
    byKey.set(item.key, byKey.has(item.key) ? null : item);
  }
  const projected = packet?.period?.kind === 'projected';
  const identityOf = item => projected && !closing ? item?.id : item?.key;
  const identityCounts = new Map();
  for (const item of published) {
    const identity = identityOf(item);
    if (typeof identity === 'string' && identity)
      identityCounts.set(identity, (identityCounts.get(identity) || 0) + 1);
  }
  const allocations = new Map();
  for (const part of (closing ? packet.forecastClosing.allocations : projected && packet.plannedRequirements ? [] : packet?.period?.cycleAllocations) || []) {
    if (typeof part?.id !== 'string') continue;
    allocations.set(part.id, allocations.has(part.id) ? null : part);
  }
  const seen = new Set(), members = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const item = byKey.get(key) || null;
    const identity = item ? identityOf(item) : null;
    const allocation = typeof identity === 'string' && identityCounts.get(identity) === 1
      ? allocations.get(identity) : undefined;
    members.push({ key, item, thisPeriod: allocation ? allocation.amount : null });
  }
  const found = members.filter(member => member.item);
  const groupLabels = [...new Set(found.map(member => member.item.groupLabel).filter(Boolean))];
  const groups = [...new Set(found.map(member => member.item.group).filter(Boolean))];
  const title = groupLabels.length === 1 ? groupLabels[0]
    : groups.length === 1 && groups[0] === 'burrards-team-fees' ? 'Burrards team fees' : row.label;
  return { title, members, historical: packet?.period?.kind === 'historical' };
}

function budgetSavingsMemberFigures(member, thisPeriodTrust, historical = false, periodContext = false) {
  const item = member.item;
  const withheld = budgetV3Money(null, 'unknown');
  return {
    name: item ? item.label : 'Member name unavailable',
    date: item?.date || null,
    saved: historical ? withheld
      : item ? budgetSavingsMoney(item.saved, item.saved == null ? 'unknown' : item.trust, periodContext) : withheld,
    needed: historical ? withheld
      : item ? budgetDailyNeededHtml(item, periodContext) : withheld,
    proposed: historical ? withheld
      : budgetSavingsMoney(member.thisPeriod, member.thisPeriod == null ? 'unknown' : thisPeriodTrust, periodContext),
  };
}

function budgetSavingsCostHtml(packet, row, withheld = false) {
  if (typeof SavingsInventory === 'undefined') return '';
  const projected = packet.period?.kind === 'projected';
  const cost = SavingsInventory.commitmentCostHtml(row, { withheld: withheld || packet.period?.kind === 'historical' || projected,
    withholdSaved: packet.period?.kind === 'historical',
    savedLabel: projected ? 'Saved at period close'
      : packet.goalAllocation?.status === 'ready' && packet.backing?.status !== 'ready' ? 'Saved allocation' : 'Currently backed' });
  return (cost ? '<details class="budget-savings-members"><summary>Cost breakdown</summary>' + cost + '</details>' : '')
    + (!withheld && SavingsInventory.linkEvidenceHtml ? SavingsInventory.linkEvidenceHtml(packet, row) : '');
}

function budgetDailySavingsHtml(packet, retainedEvidence = '', inventory = null, context = {}) {
  const projected = packet.period?.kind === 'projected';
  const periodMode = budgetSavingsPeriodContext(packet);
  const value = (amount, trust) => budgetSavingsMoney(amount, trust, periodMode);
  const listed = budgetDailySavingsRows(packet, inventory);
  const annualBillNote = budgetSavingsAnnualBillNoteHtml(listed);
  const rows = listed.map(row => {
    const needed = budgetDailyNeededHtml(row, projected);
    const group = budgetSavingsRowMembers(packet, row);
    const members = group ? `<ul class="budget-savings-members">${group.members.map(member => {
      const figures = budgetSavingsMemberFigures(member, row.thisPeriodTrust, group.historical, periodMode);
      return `<li data-budget-savings-member="${budgetV3Escape(member.key)}">
      <span>${budgetV3Escape(figures.name)}${figures.date ? ` <small>${budgetV3Escape(fmtDate(figures.date))}</small>` : ''}</span>
      <span><span data-budget-savings-member-saved>${figures.saved}</span> / <span data-budget-savings-member-needed>${figures.needed}</span><small>Saved / needed</small></span>
      <span><span data-budget-savings-member-proposed>${figures.proposed}</span><small>This period</small></span>
      ${budgetSavingsCostHtml(packet, member.item)}
    </li>`;
    }).join('')}</ul>` : '';
    return `<li data-budget-savings-total-goal="${budgetV3Escape(row.key)}">
      <span>${budgetV3Escape(group ? group.title : row.label)}</span>
      <span><span data-budget-savings-total-saved>${value(row.saved, row.savedTrust)}</span> / <span data-budget-savings-total-needed>${needed}</span><small>Saved / needed</small></span>
      <span><span data-budget-savings-proposed>${value(row.thisPeriod, row.thisPeriodTrust)}</span><small>This period</small></span>${budgetSavingsCostHtml(packet, row, listed.filter(other => other.key === row.key).length !== 1)}${members}
    </li>`;
  }).join('');
  const period = projected ? { ...packet.period, proposal: packet.forecastClosing?.contribution ?? null,
    trust: packet.forecastClosing?.trust || 'unknown' } : packet.period;
  const projectedReasons = projected ? [...new Set([
    packet.forecastClosing?.status !== 'ready'
      ? packet.forecastClosing?.reason || 'Closing Savings data is unavailable.' : null,
    packet.period?.status === 'unavailable' ? packet.period.reason : null,
  ].filter(reason => typeof reason === 'string' && reason))] : [];
  // Opening facts belong to Forecast's surviving roster, never to the closing
  // row/member roster. Keep their actual asOf visible inside the disclosure.
  const openingRows = projected && !packet.forecastClosing?.gap ? packet.plannedRequirements?.rows || [] : [];
  const openingCosts = typeof SavingsInventory === 'undefined' ? '' : openingRows.map(row => {
    const cost = SavingsInventory.commitmentCostHtml(row, { savedLabel: 'Saved allocation',
      withheld: openingRows.filter(other => other.key === row.key).length !== 1 });
    return cost ? '<li><b>' + budgetV3Escape(row.label) + '</b>' + cost + '</li>' : '';
  }).join('');
  return `<section data-budget-planned-savings-summary data-budget-daily-savings${projected ? ' data-budget-savings-forecast-evidence' : ''}>
    <ul class="budget-savings-contributions">${rows || (projected && (packet.forecastClosing?.status === 'ready' || packet.plannedRequirements?.rows.length === 0 && !packet.forecastClosing?.gap) ? '<li>No remaining Savings requirements.</li>' : '<li>Named savings unavailable.</li>')}</ul>${annualBillNote}
    <p class="operating-line"><span>${projected ? 'Added this period' : 'Unsent top-up today'}</span><strong data-budget-daily-proposal>${value(period?.proposal, period?.trust)}</strong></p>
    <details class="budget-savings-info" data-budget-savings-info><summary>Info</summary><div>
      ${projected ? projectedReasons.map(reason => '<p>' + budgetV3Escape(reason) + '</p>').join('')
        : '<p>' + budgetV3Escape(packet.allocationDescription || 'Savings allocation evidence is unavailable.') + ' These figures are replaced on refresh. Saved amounts are reported earmarks, not money moved or bills paid. New Bills contributions are qualified separately.</p>'}
      ${!projected && (packet.period?.reason || packet.backing?.reason) ? '<p>' + budgetV3Escape(packet.period?.reason || packet.backing?.reason) + '</p>' : ''}
      ${openingCosts ? '<details data-savings-opening-costs><summary>Opening costs for surviving requirements</summary><ul>' + openingCosts + '</ul></details>' : ''}
      ${projected ? `<div class="operating-line"><span>Savings at period close</span><span>${value(packet.forecastClosing?.stock, packet.forecastClosing?.trust)}</span></div>
      ${packet.forecastClosing?.status === 'ready' ? `<div class="operating-line"><span>Bills at period close</span><span>${value(packet.forecastClosing?.operatingCash, packet.forecastClosing?.trust)}</span></div>` : ''}
      <div class="operating-line"><span>Added since this opening</span><span>${value(packet.forecastClosing?.projectedContributions, packet.forecastClosing?.trust)}</span></div>
      <div class="operating-line"><span>Goal costs</span><span>${value(packet.forecastClosing?.projectedDraws, packet.forecastClosing?.trust)}</span></div>
      ${packet.forecastClosing?.projectedDeficitCoverage > 0 ? `<div class="operating-line"><span>Deficit coverage</span><span>${value(packet.forecastClosing.projectedDeficitCoverage, packet.forecastClosing.trust)}</span></div>` : ''}
      <div class="operating-line"><span>Unallocated Savings</span><span>${value(packet.forecastClosing?.unallocated, packet.forecastClosing?.trust)}</span></div>
      ${packet.forecastClosing?.status === 'ready' && packet.forecastClosing?.gap ? `<div class="operating-line"><span>Uncovered Bills gap · ${budgetV3Escape(fmtDate(packet.forecastClosing.gap.date))}</span><span>${value(packet.forecastClosing.gap.shortBy, packet.forecastClosing.gap.trust)}</span></div>` : ''}` : `<div class="operating-line"><span>Period balance before proposals</span><span>${value(period?.nativePeriodSurplus, period?.trust)}</span></div>
      <div class="operating-line"><span>Funding entitlement</span><span>${value(period?.entitlement, period?.trust)}</span></div>
      <p>Income proved already deposited into Savings is excluded from entitlement. These two figures can differ.</p>
      <div class="operating-line"><span>Proved transfers this cycle</span><span>${value(period?.transferred, period?.trust)}</span></div>
      <div class="operating-line"><span>Remaining entitlement</span><span>${value(period?.remainingEntitlement, period?.trust)}</span></div>
      <div class="operating-line"><span>Unassigned capacity</span><span>${value(period?.unassigned, period?.trust)}</span></div>
      <p>Only matched settled transfers count. Pending or unmatched movement stays unresolved. Proposals grant no permission to move money.</p>`}
      ${inventory && typeof SavingsInventory !== 'undefined' ? SavingsInventory.html(packet, context) : ''}
      ${!projected || retainedEvidence ? `<details data-budget-savings-legacy-evidence><summary>Earlier planning calculation &amp; obligation evidence</summary>${retainedEvidence}</details>` : ''}
    </div></details></section>`;
}

function periodBillsHtml(view) {
  const sections = (view && view.billSections) || [];
  const undated = (view && view.undatedBills) || [];
  if (sections.length) {
    const blocks = sections.map(section => {
      const lines = (section.rows || []).map(periodBillLine).join('');
      const body = lines
        ? `<div class="operating-lines">${lines}</div>`
        : '<p class="operating-lead">No bills in this period.</p>';
      const total = section.total != null && isFinite(Number(section.total))
        ? `<p class="payday-qual">${section.label} total ${money2(section.total)}</p>`
        : '';
      return `<div data-bill-section="${section.id || ''}">
        <div class="payday-group">${section.label}</div>
        ${body}
        ${total}
      </div>`;
    }).join('');
    const undatedLines = undated.map(periodBillLine).join('');
    const undatedBlock = undatedLines
      ? `<div data-bill-section="needs-date"><div class="operating-lines">${undatedLines}</div></div>`
      : '';
    return `<div class="payday-period-bills" data-payday-period-bills>
      ${blocks}
      ${undatedBlock}
    </div>`;
  }
  const rows = (view && view.bills) || [];
  const empty = view && view.billsHeading === 'Bills this week'
    ? 'No bills this week.'
    : 'No bills this pay period.';
  if (!rows.length) {
    return `<div class="payday-period-bills" data-payday-period-bills>
      <p class="operating-lead">${empty}</p>
    </div>`;
  }
  const lines = rows.map(periodBillLine).join('');
  return `<div class="payday-period-bills" data-payday-period-bills>
    <div class="operating-lines">${lines}</div>
  </div>`;
}

function householdBudgetHtml(view) {
  const rows = (view && view.householdBudget) || [];
  if (!rows.length) {
    return `<div class="payday-household-budget" data-payday-household-budget>
      <p class="operating-lead">No household budget lines on this plan.</p>
    </div>`;
  }
  const lines = rows.map(row => paydayBucketRow(
    row.label,
    glanceSignedMoney(row.amount != null ? -Math.abs(Number(row.amount)) : null),
    null,
    null,
    { preformatted: true }
  )).join('');
  return `<div class="payday-household-budget" data-payday-household-budget>
    <div class="operating-lines">${lines}</div>
  </div>`;
}

function budgetDigestHtml(digest) {
  const rows = (digest && digest.rows) || [];
  if (!rows.length) return '';
  const notes = [];
  if (digest.actualsIncomplete) notes.push('Not all spending is in yet.');
  if (digest.historyThrough) {
    notes.push(`Spending history only goes through ${fmtDate(digest.historyThrough)}.`);
  }
  const noteHtml = notes.map(text => `<p class="operating-note">${text}</p>`).join('');
  const lines = rows.map(row => {
    const amount = row.spent != null && row.planned != null
      ? `spent ${money2(row.spent)} of ${money2(row.planned)}`
      : (row.planned != null ? `planned ${money2(row.planned)}` : '—');
    return paydayBucketRow(row.label, amount, null, null, { preformatted: true });
  }).join('');
  return `<div class="payday-budget-digest" data-payday-budget-digest>
    <p class="operating-lead">Spent against the budget</p>
    ${noteHtml}
    <div class="operating-lines">${lines}</div>
  </div>`;
}

function firstCardHtml(view) {
  const card = view && view.firstCard;
  if (!card) {
    return `<div class="payday-first-card" data-payday-first-card>
      <p class="operating-lead">No revolving card is next for extra payment.</p>
    </div>`;
  }
  const extra = card.extraThisPayday != null ? Number(card.extraThisPayday) : 0;
  const extraLead = (view && view.extraLabel) || 'Extra this payday';
  const extraLine = extra > 0
    ? `${extraLead} ${money2(extra)}`
    : `${extraLead} $0.00`;
  const bits = [];
  if (card.balance != null) bits.push(`Balance ${money2(card.balance)}`);
  if (card.rate != null && isFinite(Number(card.rate))) bits.push(`${Number(card.rate).toFixed(2)}%`);
  if (card.minimum != null) bits.push(`min ${money2(card.minimum)}`);
  return `<div class="payday-first-card" data-payday-first-card data-first-card="${card.id || ''}" data-card-id="${card.id || ''}" data-extra="${extra > 0 ? 'plus' : 'zero'}">
    <p class="operating-lead">${card.label}</p>
    <p class="operating-note">${bits.join(' · ')}</p>
    <p class="operating-note payday-extra-line">${extraLine}</p>
  </div>`;
}

function otherCardsHtml(view) {
  const rows = (view && view.otherCards) || [];
  if (!rows.length) {
    return `<div class="payday-other-cards" data-payday-other-cards>
      <p class="operating-lead">No other revolving cards.</p>
    </div>`;
  }
  const lines = rows.map(row => {
    const bits = [];
    if (row.balance != null) bits.push(money2(row.balance));
    if (row.rate != null && isFinite(Number(row.rate))) bits.push(`${Number(row.rate).toFixed(2)}%`);
    if (row.minimum != null) bits.push(`min ${money2(row.minimum)}`);
    return `<div class="operating-line" data-card-id="${row.id || ''}"><span>${row.label}</span><span>${bits.join(' · ') || '—'}</span></div>`;
  }).join('');
  return `<div class="payday-other-cards" data-payday-other-cards>
    <div class="operating-lines">${lines}</div>
  </div>`;
}

function bigPurchasesHtml(view) {
  const rows = (view && view.bigPurchases) || [];
  if (!rows.length) {
    return `<div class="payday-big-purchases" data-payday-big-purchases>
      <p class="operating-lead">No big purchases on the horizon.</p>
    </div>`;
  }
  const lines = rows.map(row => {
    const when = row.date ? fmtDate(row.date) : (row.when || 'date unset');
    const cost = row.cost != null ? money2(row.cost) : '—';
    const saved = money2(row.savedSoFar != null ? row.savedSoFar : 0);
    const taken = row.allocation != null ? Number(row.allocation)
      : Number(row.setAsideThisPayday);
    const takenLabel = row.allocation != null ? 'this period' : 'this payday';
    const setAside = Number(taken) > 0
      ? ` · set aside ${takenLabel} ${money2(taken)}`
      : '';
    return paydayBucketRow(
      `${row.label} · ${when}`,
      `cost ${cost} · saved ${saved}${setAside}`,
      null, null, { preformatted: true }
    );
  }).join('');
  return `<div class="payday-big-purchases" data-payday-big-purchases>
    <div class="operating-lines">${lines}</div>
  </div>`;
}

function paydayBucketRow(label, allocated, wanted, shortfall, opts) {
  const bits = [];
  const preformatted = !!(opts && opts.preformatted);
  if (allocated != null) bits.push(preformatted ? allocated : money2(allocated));
  if (wanted != null && (allocated == null || Number(allocated) !== Number(wanted))) {
    bits.push(`of ${money2(wanted)}`);
  }
  if (shortfall != null && Number(shortfall) > 0) bits.push(`short ${money2(shortfall)}`);
  return `<div class="operating-line"><span>${label}</span><span>${bits.join(' · ') || '—'}</span></div>`;
}

function paydayAllocationSummaryHtml(alloc, action) {
  if (!alloc || !Array.isArray(alloc.lines)) {
    return `<div class="allocation-unavailable">
      <p class="operating-lead">Payday allocation unavailable.</p>
      <p class="operating-note">Forecast does not name transfers or account movements here.</p>
    </div>`;
  }
  const payday = (action && action.nextPayday) || alloc.payday;
  const paydayLabel = payday ? fmtDateLong(payday) : 'the next payday';
  const between = (action && action.mode === 'between-paydays') || alloc.mode === 'between-paydays';
  const lead = between
    ? `Forecast does not yet name transfers for ${paydayLabel}. Until then, current spendable cash is reserved like this.`
    : `This payday, current spendable cash is reserved in this order.`;
  const obligations = alloc.obligations || {};
  const essentials = alloc.essentials || {};
  const extra = alloc.extraDebt || {};
  const futureRows = (alloc.futureCosts || []).filter(row => row && Number(row.allocated) > 0)
    .map(row => paydayBucketRow(row.label, row.allocated, row.need, row.shortfall)).join('');
  const remainder = alloc.remainder != null ? alloc.remainder : alloc.unallocated;
  return `<div class="payday-decision" data-payday-decision>
    <p class="operating-lead">${lead}</p>
    <p class="operating-note">Atlas names the amounts, not the account to move them from.</p>
    <div class="operating-lines">
      ${paydayBucketRow('Required bills', obligations.allocated, obligations.wanted, obligations.shortfall)}
      ${paydayBucketRow('Everyday essentials', essentials.allocated, essentials.wanted, essentials.shortfall)}
      ${futureRows}
      ${paydayBucketRow('Extra debt', extra.allocated, null, null)}
      ${postedThisPeriodHtml(action)}
      ${paydayBucketRow('Left after that', remainder, null, null)}
    </div>
    <details class="household-inline-details">
      <summary>See how payday is allocated</summary>
      ${paydayAllocationSheetHtml(alloc)}
    </details>
  </div>`;
}

function selectedPlanView(advice, look) {
  if (!advice) return null;
  if (look === 'next-period') return advice.nextPeriodView || advice.defaultView || null;
  if (look === 'payday-carryover') return null;
  if (look && look.slice(0, 5) === 'week:') {
    const start = look.slice(5);
    const found = (advice.weekViews || []).find(row => row && row.periodStart === start);
    return found || advice.defaultView || null;
  }
  if (look && look.slice(0, 5) === 'past:') {
    const start = look.slice(5);
    const found = (advice.pastPeriodViews || []).find(row => row && row.start === start);
    return found || advice.defaultView || null;
  }
  return advice.defaultView || null;
}

/* AMANDA SLICE 3 — wire the Month <-> Pay Period toggle and the month
 * picker. Switching granularity re-renders the Budget surface; it never
 * recomputes Forecast figures. */
// One native modal owns the displayed evidence node. No copied HTML, parsed
// amount, duplicate renderer or cached financial packet is introduced.
function budgetDetailSheetController(mount) {
  if (!mount || typeof mount.querySelector !== 'function') return null;
  const dialog = mount.querySelector('[data-budget-detail-sheet]');
  if (!dialog || typeof dialog.showModal !== 'function') return null;
  if (dialog.budgetSheet) return dialog.budgetSheet;
  if (!dialog.id) dialog.id = 'budget-detail-sheet';
  const body = dialog.querySelector('[data-budget-detail-body]');
  const title = dialog.querySelector('[data-budget-detail-title]');
  const closeButton = dialog.querySelector('[data-budget-detail-close]');
  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.setAttribute('data-budget-detail-back', '');
  backButton.setAttribute('aria-label', 'Go back');
  backButton.textContent = '< Back';
  backButton.hidden = true;
  closeButton.textContent = '\u00d7';
  closeButton.before(backButton);
  const parents = [];
  let held = null;
  let pendingRestore = null;
  // Fixed presentation identities only. The review source and its opener
  // live in the header while closed; no transaction reference is resolved here.
  const headerIdentities = ['[data-transaction-review]', '[data-transaction-review-open]'];
  const reviewFocusSelectors = ['[data-review-previous]', '[data-review-next]', '[data-review-return]', '[data-budget-detail-close]'];
  const identity = (node, source) => {
    if (node.hasAttribute(source ? 'data-transaction-review' : 'data-transaction-review-open'))
      return headerIdentities[source ? 0 : 1];
    if (!source && node.matches('.blend-income')) return '.blend-income';
    for (const key of source ? [] : ['data-blend-cat', 'data-blend-bill']) {
      if (node.hasAttribute(key)) return '[' + key + '="' + CSS.escape(node.getAttribute(key)) + '"]';
    }
    if (source && node.matches('[data-bill-detail]')) {
      const summary = node.querySelector('[data-period-bill]');
      if (!summary) return null;
      return `[data-bill-detail]:has(> summary[data-period-bill="${CSS.escape(summary.getAttribute('data-period-bill'))}"]${summary.hasAttribute('data-bill-date') ? `[data-bill-date="${CSS.escape(summary.getAttribute('data-bill-date'))}"]` : ':not([data-bill-date])'})`;
    }
    if (!source && (node.hasAttribute('data-budget-category-open') || node.hasAttribute('data-budget-bill-open'))) {
      const key = node.hasAttribute('data-budget-category-open') ? 'data-budget-category-open' : 'data-budget-bill-open';
      return `[${key}="${CSS.escape(node.getAttribute(key))}"][data-budget-browse-origin="${CSS.escape(node.getAttribute('data-budget-browse-origin') || '')}"]${node.hasAttribute('data-budget-bill-date') ? `[data-budget-bill-date="${CSS.escape(node.getAttribute('data-budget-bill-date'))}"]` : ''}`;
    }
    if (source && node.hasAttribute('data-budget-category')) return `[data-budget-category="${CSS.escape(node.getAttribute('data-budget-category'))}"]`;
    for (const key of source ? ['data-blend-bills-panel', 'data-budget-card-panel', 'data-budget-goal-fulfillment-evidence', 'data-budget-month-funding-evidence', 'data-budget-funding-savings', 'data-budget-daily-funding-evidence', 'data-from-today-proposal', 'data-budget-today-evidence', 'data-budget-window-picker', 'data-budget-period-info-body', 'data-payday-breakdown']
      : ['data-blend-bills-open', 'data-budget-card-toggle', 'data-budget-card-close', 'data-budget-month-funding-open', 'data-budget-funding-evidence', 'data-budget-funding-how', 'data-budget-funding-inventory', 'data-budget-goal-open', 'data-budget-cash-how', 'data-budget-cash-next', 'data-budget-window-choose', 'data-budget-section', 'data-budget-browse-evidence', 'data-budget-bill-filter', 'data-budget-funding-tab', 'data-budget-month-picker', 'data-budget-month-section', 'data-budget-month-section-heading', 'data-budget-granularity', 'data-budget-window-step']) {
      if (node.hasAttribute(key)) return `[${key}${node.getAttribute(key) ? `="${CSS.escape(node.getAttribute(key))}"` : ''}]`;
    }
    if (!source && node.matches('.budget-period-info > summary')) return '.budget-period-info > summary';
    const question = node.closest('[data-operating-question]');
    return question ? `[data-operating-question="${CSS.escape(question.getAttribute('data-operating-question'))}"] ${source ? '.budget-step-body' : '.budget-step-summary'}` : null;
  };
  const motion = (method, ...args) => {
    try { return typeof BudgetSheetMotion !== 'undefined' ? BudgetSheetMotion[method]?.(...args) : null; }
    catch (_) { return null; } // Decoration must never prevent evidence or dismissal.
  };
  const openerFor = item => {
    const replacement = item.openerSelector && item.openerSelector !== item.triggerSelector
      ? mount.querySelector(item.openerSelector) : null;
    return replacement || (item.opener?.isConnected ? item.opener : null);
  };
  const release = item => {
    item.parent.insertBefore(item.source, item.next?.parentNode === item.parent ? item.next : null);
    item.source.hidden = item.hidden;
    item.source.inert = item.inert;
    if (item.forecastClipped) item.source.classList.add('blend-goals-source');
    if (item.expanded != null || item.trigger.hasAttribute('aria-expanded'))
      item.trigger.setAttribute('aria-expanded', item.expanded ?? 'false');
    const opener = openerFor(item);
    if (opener && opener !== item.trigger) opener.setAttribute('aria-expanded', 'false');
  };
  const focus = node => {
    if (!node?.isConnected || !node.getClientRects().length) return false;
    node.focus({ preventScroll: true });
    if (document.activeElement !== node) return false;
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  };
  const present = item => {
    title.textContent = item.label;
    dialog.classList.toggle('transaction-review-sheet', item.source.hasAttribute('data-transaction-review'));
    dialog.classList.toggle('budget-surface-today', item.today);
    dialog.classList.toggle('budget-surface-period', !item.today);
    item.source.hidden = false;
    item.source.inert = item.inert;
    if (item.forecastClipped) item.source.classList.remove('blend-goals-source');
    backButton.hidden = parents.length === 0;
  };
  const close = (restoreFocus = true) => {
    pendingRestore = null;
    if (!held) { motion('cancel', dialog); return; }
    const root = parents[0] || held;
    const departure = restoreFocus ? motion('departure', dialog) : null;
    motion('cancel', dialog);
    const items = [...parents, held];
    held = null;
    parents.length = 0;
    items.reverse().forEach(release);
    backButton.hidden = true;
    dialog.close();
    dialog.classList.remove('transaction-review-sheet');
    document.body.classList.remove('budget-detail-open');
    const returnTo = openerFor(root) || root.trigger;
    if (restoreFocus && !focus(returnTo) && !focus(root.trigger)) {
      mount.tabIndex = -1;
      mount.focus({ preventScroll: true });
    }
    if (restoreFocus) motion('leave', departure, motion('origin', returnTo) || root.origin);
  };
  const open = (source, trigger, label, focusSelector, options = {}) => {
    pendingRestore = null;
    if (!source || !trigger || !source.parentNode) return false;
    if (held?.source === source && held.trigger === trigger) return true;
    motion('cancel', dialog);
    // Only Bills -> bill evidence adds a Back level. Other incumbent open()
    // callers retain replacement behavior and cannot accidentally form a stack.
    const visibleOpener = options.opener || motion('opener') || trigger;
    const nested = held && held.source.hasAttribute('data-blend-bills-panel')
      && held.source.contains(trigger) && source !== held.source && !source.contains(held.source);
    const replacing = !!held && !nested;
    if (nested) {
      held.scrollTop = body.scrollTop;
      held.source.hidden = true;
      held.source.inert = true;
      parents.push(held);
    } else {
      close(false);
    }
    held = { source, trigger, sourceSelector: identity(source, true), triggerSelector: identity(trigger, false),
      opener: visibleOpener, openerSelector: options.openerSelector || identity(visibleOpener, false),
      label, focusSelector, parent: source.parentNode, next: source.nextSibling,
      hidden: source.hidden, inert: source.inert, expanded: trigger.getAttribute('aria-expanded'),
      forecastClipped: source.hasAttribute('data-budget-funding-savings')
        && source.classList.contains('blend-goals-source')
        && !!source.querySelector('[data-budget-savings-forecast-evidence], [data-settlement-assignment]'),
      today: !!source.closest('.budget-surface-today'), scrollTop: 0,
      origin: nested ? parents[0].origin : motion('origin', visibleOpener) };
    body.appendChild(source);
    present(held);
    if (source.matches('[data-bill-detail]')) source.open = true;
    if (source.hasAttribute('data-budget-category')) {
      const spending = source.querySelector('[data-budget-spent]');
      if (spending) spending.open = true;
    }
    if (held.expanded != null) trigger.setAttribute('aria-expanded', 'true');
    if (visibleOpener !== trigger) {
      visibleOpener.setAttribute('aria-haspopup', 'dialog');
      visibleOpener.setAttribute('aria-controls', dialog.id);
      visibleOpener.setAttribute('aria-expanded', 'true');
    }
    document.body.classList.add('budget-detail-open');
    if (!dialog.open) dialog.showModal();
    const first = focusSelector ? source.querySelector(focusSelector) : null;
    body.scrollTop = 0;
    (first || closeButton).focus({ preventScroll: true });
    if (first) first.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (!options.instant) {
      if (nested || replacing) motion('detail', dialog, nested ? 1 : 0);
      else motion('enter', dialog, held.origin);
    }
    return true;
  };
  const back = () => {
    if (!held || !parents.length) return;
    motion('cancel', dialog);
    const child = held;
    release(child);
    held = parents.pop();
    present(held);
    body.scrollTop = held.scrollTop;
    if (!focus(openerFor(child) || child.trigger)) closeButton.focus({ preventScroll: true });
    motion('detail', dialog, -1);
  };
  closeButton.addEventListener('click', () => close());
  backButton.addEventListener('click', back);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { if (!dialog.open && held) close(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const nodes = [...dialog.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex="0"]')]
      .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length && !node.closest('[inert]'));
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  const readBillsFilter = source => {
    const selected = [...source.querySelectorAll('[data-budget-bill-filter][aria-pressed="true"]')];
    const choice = selected.length === 1 ? selected[0].getAttribute('data-budget-bill-filter') : null;
    return ['all', 'check', 'due', 'paid', 'pending', 'unknown'].includes(choice) ? choice : null;
  };
  const restoreBillsFilter = (source, choice) => {
    budgetApplyBillFilter(source, choice);
  };
  const descriptor = item => ({
    sourceSelector: item.sourceSelector, triggerSelector: item.triggerSelector,
    openerSelector: item.openerSelector, label: item.label, focusSelector: item.focusSelector,
    scrollTop: Number.isFinite(item.scrollTop) && item.scrollTop >= 0 ? item.scrollTop : 0,
    billsFilter: ['all', 'check', 'due', 'paid', 'pending', 'unknown'].includes(item.billsFilter) ? item.billsFilter : null,
    billsDay: typeof item.billsDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.billsDay) ? item.billsDay : null,
    ...(reviewFocusSelectors.includes(item.reviewFocusSelector) ? { reviewFocusSelector: item.reviewFocusSelector } : {}),
  });
  const copyState = state => {
    const frames = (state?.frames || (state ? [state] : [])).map(descriptor);
    return frames.length ? { ...frames[frames.length - 1], frames } : null;
  };
  const snapshot = () => {
    if (pendingRestore) return copyState(pendingRestore);
    if (!held) return null;
    const frames = [...parents, { ...held, scrollTop: body.scrollTop }].map(item => ({ ...item,
      billsFilter: item.source.hasAttribute('data-blend-bills-panel') ? readBillsFilter(item.source) : null,
      billsDay: item.source.hasAttribute('data-blend-bills-panel') ? item.source.getAttribute('data-budget-bill-day') : null,
      reviewFocusSelector: item.source.hasAttribute('data-transaction-review') && dialog.contains?.(mount.ownerDocument?.activeElement)
        ? reviewFocusSelectors.find(selector => mount.ownerDocument?.activeElement?.matches?.(selector)) : null }));
    return frames.every(item => item.sourceSelector && item.triggerSelector)
      ? copyState({ frames }) : null;
  };
  const matches = selector => {
    if (typeof selector !== 'string' || !selector) return [];
    const nodes = [...mount.querySelectorAll(selector)];
    if (headerIdentities.includes(selector)) {
      nodes.push(...(mount.ownerDocument?.querySelectorAll?.('.site-head ' + selector) || []));
    }
    return [...new Set(nodes)];
  };
  const unique = selector => {
    const nodes = matches(selector);
    return nodes.length === 1 ? nodes[0] : null;
  };
  const sourceForIdentity = selector => {
    const owned = [...parents, held].find(item => item?.sourceSelector === selector);
    return owned?.source.isConnected ? owned.source : unique(selector);
  };
  const restore = (state, { deferBlend = false } = {}) => {
    close(false);
    const saved = copyState(state);
    const frames = (saved?.frames || []).map(item => {
      const sources = matches(item.sourceSelector), triggers = matches(item.triggerSelector);
      return { ...item, source: sources[0], trigger: triggers[0],
        sourceCount: sources.length, triggerCount: triggers.length };
    });
    const isBillsFrame = item => item.sourceSelector === '[data-blend-bills-panel]'
      && (item.triggerSelector === '[data-blend-bills-open]'
        || item.triggerSelector === `[data-operating-question="${CSS.escape('04')}"] .budget-step-summary`
        || item.billsDay && item.triggerSelector === `[data-blend-bill="${CSS.escape('day:' + item.billsDay)}"]`);
    const incomplete = frames.some(item => item.sourceCount !== 1 || item.triggerCount !== 1);
    if (incomplete && deferBlend) {
      const bento = mount.querySelector('[data-budget-bento]');
      const canWait = frames.length > 0 && frames.some(isBillsFrame)
        && bento && bento.getAttribute('data-blend-ready') !== '1'
        && mount.querySelector('[data-budget-browse="bills"]')
        && frames.every(item => item.sourceCount === 1 && item.triggerCount === 1
          || isBillsFrame(item) && item.sourceCount <= 1 && item.triggerCount <= 1);
      // Only known skin-created Bills identities may wait. Every native child
      // must already resolve uniquely; no missing publication is manufactured.
      if (canWait) { pendingRestore = saved; return 'pending'; }
    }
    if (!frames.length || incomplete
      || new Set(frames.map(item => item.source)).size !== frames.length) return false;
    if (frames.some((item, index) => index > 0
      && (!frames[index - 1].source.hasAttribute('data-blend-bills-panel')
        || !frames[index - 1].source.contains(item.trigger)
        || item.source.contains(frames[index - 1].source)))) return false;
    for (const item of frames) {
      open(item.source, item.trigger, item.label, item.focusSelector, { instant: true,
        opener: unique(item.openerSelector), openerSelector: item.openerSelector });
      if (item.source.hasAttribute('data-blend-bills-panel')) {
        if (item.billsDay) item.source.setAttribute('data-budget-bill-day', item.billsDay);
        else item.source.removeAttribute('data-budget-bill-day');
        restoreBillsFilter(item.source, item.billsFilter);
      }
      body.scrollTop = item.scrollTop;
      if (item.source.hasAttribute('data-transaction-review') && item.reviewFocusSelector) {
        const control = dialog.querySelector(item.reviewFocusSelector);
        if (control && !control.disabled) focus(control);
      }
    }
    if (parents.length !== frames.length - 1) { close(false); return false; }
    return true;
  };
  const completeDeferredRestore = () => {
    const state = pendingRestore;
    pendingRestore = null; // One attempt; subsequent paints must not replay it.
    if (!state || !dialog.isConnected
      || mount.querySelector('[data-budget-detail-sheet]') !== dialog) return false;
    if (restore(state)) return true;
    const root = state.frames[0];
    if (!focus(unique(root.openerSelector)) && !focus(unique(root.triggerSelector))) {
      mount.tabIndex = -1;
      mount.focus({ preventScroll: true });
    }
    return false;
  };
  dialog.budgetSheet = { open, close, back, snapshot, restore, completeDeferredRestore, sourceForIdentity,
    focusIdentity: node => identity(node, false) };
  return dialog.budgetSheet;
}

function budgetRemount(mount, ctx) {
  const sheet = budgetDetailSheetController(mount);
  const restore = sheet?.snapshot();
  const focused = mount.ownerDocument?.activeElement;
  const attentionBottom = mount.ownerDocument?.getElementById('budget-attention-bottom');
  const focusRestore = !restore && focused && (mount.contains?.(focused) || attentionBottom?.contains(focused))
    ? sheet?.focusIdentity(focused) : null;
  sheet?.close(false);
  attentionBottom?.replaceChildren();
  // Presentation controllers may retain their connected gesture/animation
  // nodes. The new financial HTML is still rebuilt from the current context.
  if (typeof mount.dispatchEvent === 'function') mount.dispatchEvent(new Event('budget-before-remount'));
  mount.innerHTML = budgetSurfaceHtml(ctx);
  mount.budgetSheetRestore = restore;
  mount.budgetFocusRestore = focusRestore;
}

function wireBudgetWindow(mount, ctx, sheet) {
  if (!sheet) return;
  mount.querySelectorAll('[data-budget-month-section]').forEach(button => {
    const section = button.getAttribute('data-budget-month-section');
    if (!['result', 'flow', 'costs'].includes(section)) return;
    const target = mount.querySelector(`[data-budget-month-section-target="${section}"]`);
    const heading = target?.querySelector('[data-budget-month-section-heading]');
    if (!heading) return;
    heading.addEventListener('focus', () => {
      mount.querySelectorAll('[data-budget-month-section]').forEach(control => {
        if (control === button) control.setAttribute('aria-current', 'location');
        else control.removeAttribute('aria-current');
      });
    });
    button.addEventListener('click', () => {
      heading.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start' });
    });
  });
  const choose = mount.querySelector('[data-budget-window-choose]');
  const picker = mount.querySelector('[data-budget-window-picker]');
  if (choose && picker) choose.addEventListener('click', () =>
    sheet.open(picker, choose, 'Choose pay period', '[data-budget-wheel="period"] [aria-current="true"]'));
  mount.querySelectorAll('[data-budget-window-step]').forEach(button => {
    const step = Number(button.getAttribute('data-budget-window-step'));
    if (step !== -1 && step !== 1) return;
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      if (budgetGranularity === 'month') {
        const months = budgetTrajectoryFor(ctx)?.months || [];
        const index = months.findIndex(month => month.month === budgetSelectedMonth);
        const next = months[index + step];
        if (!next) return;
        budgetSelectedMonth = next.month;
      } else {
        const selection = payPeriodMoveSelection(ctx.advice, planPayPeriodId, step);
        if (!selection.period) return;
        planPayPeriodId = selection.period.id || selection.period.start;
      }
      const nextCtx = Object.assign({}, ctx, { planPayPeriodId });
      budgetRemount(mount, nextCtx);
      wirePlanLookPicker(mount, nextCtx);
      mount.querySelector(`[data-budget-window-step="${step}"]`)?.focus({ preventScroll: true });
    });
  });
  mount.querySelectorAll('[data-budget-section]').forEach(button => {
    const section = button.getAttribute('data-budget-section');
    if (!['overview', 'spending', 'bills', 'upcoming'].includes(section)) return;
    button.addEventListener('click', () => {
      const target = mount.querySelector(section === 'upcoming' ? '[data-budget-funding-section]'
        : `[data-budget-browse="${CSS.escape(section)}"]`);
      if (target || section === 'overview') mount.querySelectorAll('[data-budget-section]').forEach(control => {
        if (control === button) control.setAttribute('aria-current', 'location');
        else control.removeAttribute('aria-current');
      });
      if (target) {
        target.querySelector('h2').focus({ preventScroll: true });
        target.scrollIntoView({ block: 'start' });
        return;
      }
      if (section === 'overview') {
        mount.querySelector('.budget-surface-grid')?.scrollIntoView({ block: 'start' });
        return;
      }
      const selector = section === 'spending' ? '[data-operating-question="06"] .budget-step-body'
        : section === 'bills' ? '[data-operating-question="04"] .budget-step-body'
          : '[data-payday-breakdown="planned-cost-funding"]';
      const source = mount.querySelector(selector);
      if (!source) return;
      const range = mount.querySelector('[data-budget-window-range]')?.textContent || '';
      const title = section === 'upcoming' ? 'Upcoming costs — exact payday plan'
        : `${section === 'spending' ? 'Spending' : 'Bills'} · ${range}`;
      if (section === 'upcoming') source.open = true;
      sheet.open(source, button, title);
    });
  });
}

// Display-only filtering of the Forecast states already printed on each
// bucket. Pending and unknown stay distinct; no settlement is inferred.
function budgetApplyBillFilter(section, choice) {
  const controls = [...section.querySelectorAll('[data-budget-bill-filter]')];
  const selected = ['all', 'check', 'due', 'paid', 'pending', 'unknown'].includes(choice)
    && controls.filter(control => control.getAttribute('data-budget-bill-filter') === choice).length === 1
    ? choice : 'all';
  controls.forEach(control => control.setAttribute('aria-pressed',
    String(control.getAttribute('data-budget-bill-filter') === selected)));
  const buckets = [...section.querySelectorAll('[data-budget-bill-bucket]')];
  const day = section.getAttribute('data-budget-bill-day');
  buckets.forEach(bucket => {
    const rows = [...bucket.querySelectorAll('[data-budget-bill-open]')];
    rows.forEach(row => { row.hidden = !!day && row.getAttribute('data-budget-bill-date') !== day; });
    bucket.hidden = selected !== 'all' && bucket.getAttribute('data-budget-bill-bucket') !== selected
      || !!day && !rows.some(row => !row.hidden);
  });
  const empty = section.querySelector('[data-budget-bill-filter-empty]');
  if (empty) empty.hidden = selected === 'all' || buckets.some(bucket => !bucket.hidden);
  const status = section.querySelector('[data-budget-bill-filter-status]');
  if (status) status.textContent = day ? `Showing bills on ${day}.` : ({ all: 'Showing all bills.',
    check: 'Showing bills to confirm. They may already be paid; check the evidence before paying again.',
    due: 'Showing bills published as due.', paid: 'Showing paid bills: money sent or settlement confirmed.',
    pending: 'Showing pending bills. Settlement is not confirmed.',
    unknown: 'Showing bills with unavailable status.' })[selected];
}

function wireBudgetBrowse(mount, ctx, sheet) {
  if (!sheet) return;
  mount.querySelectorAll('[data-budget-bill-filter]').forEach(button => button.addEventListener('click', () => {
    const section = button.closest('[data-blend-bills-panel], [data-budget-browse="bills"]');
    if (!section) return;
    const choice = button.getAttribute('data-budget-bill-filter');
    budgetApplyBillFilter(section, choice);
  }));
  mount.querySelectorAll('[data-budget-category-open]').forEach(button => button.addEventListener('click', () => {
    const source = mount.querySelector(`[data-budget-category="${CSS.escape(button.getAttribute('data-budget-category-open'))}"]`);
    if (source) sheet.open(source, button, source.querySelector('h3')?.textContent || 'Category evidence', '.household-budget-spent-summary');
  }));
  mount.querySelectorAll('[data-budget-bill-open]').forEach(button => button.addEventListener('click', () => {
    const date = button.getAttribute('data-budget-bill-date');
    const selector = `[data-period-bill="${CSS.escape(button.getAttribute('data-budget-bill-open'))}"]${date ? `[data-bill-date="${CSS.escape(date)}"]` : ':not([data-bill-date])'}`;
    const matches = mount.querySelectorAll(selector);
    // A missing/ambiguous occurrence must still expose the complete incumbent
    // evidence; never choose an arbitrary payment or turn the button into a no-op.
    const source = matches.length === 1 ? matches[0].closest('[data-bill-detail]') || matches[0]
      : mount.querySelector('[data-operating-question="04"] .budget-step-body');
    sheet.open(source, button, button.querySelector('strong')?.textContent || 'Bill evidence');
  }));
  mount.querySelectorAll('[data-budget-browse-evidence]').forEach(button => button.addEventListener('click', () => {
    const question = button.getAttribute('data-budget-browse-evidence');
    const source = mount.querySelector(`[data-operating-question="${CSS.escape(question)}"] .budget-step-body`);
    if (source) sheet.open(source, button, question === '06' ? 'Household budget evidence' : 'Bills deduction evidence');
  }));
}

function wireBudgetGranularity(mount, ctx) {
  if (!mount || typeof mount.querySelector !== 'function') return;
  mount.querySelectorAll('[data-budget-granularity]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-budget-granularity');
      if (next !== 'month' && next !== 'pay-period') return;
      if (next === budgetGranularity) return;
      if (next === 'pay-period' && budgetGranularity === 'month') {
        // AMANDA SLICE 9: entering Pay Period from the Month lens keeps
        // the selected calendar month as the drilldown anchor.
        budgetPayPeriodAnchorMonth = budgetSelectedMonth;
      }
      budgetGranularity = next;
      budgetRemount(mount, ctx);
      wirePlanLookPicker(mount, ctx);
      mount.querySelector(`[data-budget-granularity="${next}"]`)?.focus({ preventScroll: true });
    });
  });
  const picker = mount.querySelector('[data-budget-month-picker]');
  if (picker) {
    picker.addEventListener('change', () => {
      budgetSelectedMonth = picker.value || budgetSelectedMonth;
      budgetRemount(mount, ctx);
      wirePlanLookPicker(mount, ctx);
      mount.querySelector('[data-budget-month-picker]')?.focus({ preventScroll: true });
    });
  }
  // AMANDA SLICE 9: the drilldown cycle picker. Period selection never
  // moves the selected calendar month.
  const drilldown = mount.querySelector('[data-budget-drilldown-picker]');
  if (drilldown) {
    drilldown.addEventListener('change', () => {
      budgetDrilldownPayPeriod = drilldown.value || null;
      budgetRemount(mount, ctx);
      wirePlanLookPicker(mount, ctx);
      mount.querySelector('[data-budget-drilldown-picker]')?.focus({ preventScroll: true });
    });
  }
  // Leaving the month-anchored drilldown returns to the current pay period.
  mount.querySelectorAll('[data-budget-drilldown-exit]').forEach(btn => {
    btn.addEventListener('click', () => {
      budgetPayPeriodAnchorMonth = null;
      budgetDrilldownPayPeriod = null;
      budgetRemount(mount, ctx);
      wirePlanLookPicker(mount, ctx);
      const focus = mount.querySelector('[data-budget-granularity="pay-period"]');
      if (focus) focus.focus({ preventScroll: true });
    });
  });
}

function wirePlanLookPicker(mount, ctx) {
  // Own one delegated focus handler across picker rerenders. Minimal financial
  // mounts can carry this property without implementing EventTarget methods.
  mount.onfocusin = event => {
    if (event.target.matches('.budget-step-summary')) {
      event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };
  const sheet = budgetDetailSheetController(mount);
  if (typeof TransactionReview !== 'undefined') {
    const selected = payPeriodSelection(ctx.advice || {}, ctx.planPayPeriodId).period;
    TransactionReview.wire(mount, sheet, {
      current: budgetGranularity === 'pay-period' && selected?.timelineRole === 'current',
      publication: selected?.operatingPlanUnavailable ? null : ctx.advice?.currentPeriodAction?.outgoingETransfers,
    });
  }
  wireBudgetWindow(mount, ctx, sheet);
  wireBudgetBrowse(mount, ctx, sheet);
  wireBudgetFunding(mount, sheet);
  if (typeof BudgetCardMovements !== 'undefined') BudgetCardMovements.wire(mount, sheet);
  mount.querySelectorAll('.budget-period-info').forEach(info => {
    if (sheet) {
      const summary = info.querySelector('summary');
      summary.setAttribute('aria-haspopup', 'dialog');
      summary.addEventListener('click', event => {
        event.preventDefault();
        sheet.open(info.querySelector('[data-budget-period-info-body]'), summary, 'Selected period figures');
      });
    }
    info.addEventListener('keydown', event => {
      if (event.key === 'Escape' && info.open) {
        event.preventDefault();
        event.stopPropagation();
        info.open = false;
        info.querySelector('summary').focus();
      }
    });
  });
  // Preserve the incumbent minimal-mount boundary: financial VM consumers can
  // render with querySelectorAll only. Native disclosures require a real DOM.
  const evidence = typeof mount.querySelector === 'function'
    ? mount.querySelector('[data-budget-today-evidence]') : null;
  const how = evidence ? mount.querySelector('[data-budget-cash-how]') : null;
  const nextPayday = evidence ? mount.querySelector('[data-budget-cash-next]') : null;
  if (evidence && how && sheet) {
    how.setAttribute('aria-haspopup', 'dialog');
    how.addEventListener('click', () => sheet.open(evidence, how, 'Current balance and funding'));
    nextPayday?.addEventListener('click', () => {
      const plan = evidence.querySelector('[data-payday-breakdown="planned-cost-funding"]');
      if (plan) plan.open = true;
      sheet.open(evidence, nextPayday, 'Exact payday funding plan', '[data-payday-breakdown="planned-cost-funding"] > summary');
    });
    evidence.querySelector('[data-budget-cash-back]')?.addEventListener('click', () => sheet.close());
  } else if (evidence && how) {
    let returnFocus = how;
    const close = () => {
      evidence.hidden = true;
      how.setAttribute('aria-expanded', 'false');
      paydayDisclosuresOpen.delete('today-evidence');
      returnFocus.focus();
    };
    const open = trigger => {
      returnFocus = trigger;
      evidence.hidden = false;
      how.setAttribute('aria-expanded', 'true');
      paydayDisclosuresOpen.add('today-evidence');
    };
    how.addEventListener('click', () => {
      returnFocus = how;
      if (!evidence.hidden) close();
      else { open(how); evidence.querySelector('[data-budget-cash-back]').focus(); }
    });
    nextPayday?.addEventListener('click', () => {
      open(nextPayday);
      const plan = evidence.querySelector('[data-payday-breakdown="planned-cost-funding"]');
      if (plan) { plan.open = true; plan.querySelector('summary').focus(); }
      else evidence.querySelector('[data-budget-cash-back]').focus();
    });
    evidence.querySelector('[data-budget-cash-back]')?.addEventListener('click', close);
    evidence.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    evidence.addEventListener('focusin', event => {
      // Native Tab/focus scrolling must keep long evidence summaries clear of
      // the mobile navigation dock. CSS supplies the safe scroll margin.
      if (event.target.matches('button, summary, input, select, a')) {
        event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });
  }
  if (sheet) mount.querySelectorAll('.budget-step-details').forEach(details => {
    // The dated proposal lives inside period info. Keep its native disclosure
    // inside that sheet rather than opening a second sheet over hidden info.
    if (details.closest('[data-from-today-proposal]')) return;
    const summary = details.querySelector('summary');
    summary.setAttribute('aria-haspopup', 'dialog');
    summary.addEventListener('click', event => {
      event.preventDefault();
      const prompt = summary.querySelector('.operating-prompt')?.textContent || 'Period evidence';
      sheet.open(details.querySelector('.budget-step-body'), summary, prompt);
    });
  });
  mount.querySelectorAll('[data-current-payday-details], [data-payday-breakdown]').forEach(details => {
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      const key = details.hasAttribute('data-current-payday-details')
        ? 'current-payday' : details.getAttribute('data-payday-breakdown');
      if (details.open) paydayDisclosuresOpen.add(key);
      else paydayDisclosuresOpen.delete(key);
    });
  });
  mount.querySelectorAll('[data-bills-closing-details]').forEach(details => {
    const close = () => { details.open = false; details.querySelector('summary').focus({ preventScroll: true }); };
    details.querySelector('[data-bills-closing-close]')?.addEventListener('click', close);
    details.addEventListener('keydown', event => {
      if (event.key === 'Escape' && details.open) { event.preventDefault(); close(); }
    });
  });
  if (!mount || typeof mount.querySelector !== 'function') return;
  wireBudgetGranularity(mount, ctx);
  const sel = mount.querySelector('[data-plan-look]');
  if (sel) {
    sel.value = planLook;
    sel.addEventListener('change', () => {
      planLook = sel.value || 'this-period';
      const nextCtx = Object.assign({}, ctx, {
        planLook,
        planCalendarShow,
        planView: selectedPlanView(ctx.advice, planLook),
      });
      budgetRemount(mount, nextCtx);
      wirePlanLookPicker(mount, nextCtx);
    });
  }
  const picker = mount.querySelector('[data-calendar-period-picker]');
  if (picker) {
    picker.addEventListener('click', event => {
      const btn = event.target && event.target.closest
        ? event.target.closest('[data-calendar-show]') : null;
      if (!btn) return;
      planCalendarShow = btn.getAttribute('data-calendar-show') || null;
      const nextCtx = Object.assign({}, ctx, {
        planLook,
        planCalendarShow,
        planView: selectedPlanView(ctx.advice, planLook),
      });
      budgetRemount(mount, nextCtx);
      wirePlanLookPicker(mount, nextCtx);
    });
  }
  const timeline = mount.querySelector('[data-pay-period-swipe]');
  if (timeline) {
    const wheelScope = mount.querySelector('[data-budget-window-picker]') || timeline;
    const selectPeriod = (moved, kind, focus) => {
      const selection = payPeriodSelection(ctx.advice, planPayPeriodId);
      if (moved.index === selection.index) return;
      const offsets = {};
      wheelScope.querySelectorAll('[data-budget-wheel]').forEach(wheel => {
        const track = wheel.querySelector('.budget-wheel-track');
        const offset = track.style.getPropertyValue('--wheel-offset');
        const drag = track.style.getPropertyValue('--wheel-drag');
        offsets[wheel.getAttribute('data-budget-wheel')] = drag
          ? `calc(${offset} + ${drag})` : offset;
      });
      planPayPeriodId = String(moved.period.id || moved.period.start || '');
      const nextCtx = Object.assign({}, ctx, {
        planLook,
        planPayPeriodId,
        planView: selectedPlanView(ctx.advice, planLook),
      });
      budgetRemount(mount, nextCtx);
      mount.querySelectorAll('[data-budget-wheel]').forEach(wheel => {
        const track = wheel.querySelector('.budget-wheel-track');
        const from = offsets[wheel.getAttribute('data-budget-wheel')];
        if (from !== track.style.getPropertyValue('--wheel-offset')) {
          track.style.setProperty('--wheel-from', from);
          track.classList.add('is-moving');
        }
      });
      wirePlanLookPicker(mount, nextCtx);
      if (focus) {
        const target = mount.querySelector(`[data-budget-wheel="${kind}"] [aria-current="true"]`);
        if (target) target.focus({ preventScroll: true });
      }
    };
    wheelScope.querySelectorAll('[data-budget-wheel]').forEach(wheel => {
      const kind = wheel.getAttribute('data-budget-wheel');
      const selection = payPeriodSelection(ctx.advice, planPayPeriodId);
      const index = kind === 'month'
        ? payPeriodMonths(selection).findIndex(month => month.key === payPeriodCloseMonth(selection.period))
        : selection.index;
      const choose = (targetIndex, focus) => selectPeriod(
        payPeriodWheelSelection(ctx.advice, planPayPeriodId, kind, targetIndex), kind, focus
      );
      // The visible river uses this same native selection path. Retain its
      // focus rather than focusing the hidden wheel on every held movement.
      wheel.addEventListener('budget-period-select', event => {
        const targetIndex = event.detail?.index;
        if (kind !== 'period' || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= selection.rows.length) return;
        event.preventDefault(); choose(targetIndex, false);
      });
      let suppressClick = false;
      wheel.addEventListener('click', event => {
        // A pointer-generated click after a drag must not select a second item.
        if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
        const button = event.target && event.target.closest('[data-wheel-index]');
        if (button) choose(Number(button.getAttribute('data-wheel-index')), true);
      });
      wheel.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        choose(index + (event.key === 'ArrowRight' ? 1 : -1), true);
      });
      const track = wheel.querySelector('.budget-wheel-track');
      // Percentage is the layout authority. Pixel width is read when the
      // gesture starts, so a later resize cannot leave snap math stale.
      const slotPercent = parseFloat(track.style.getPropertyValue('--wheel-slot'));
      const slotPxNow = () => {
        const width = Number(wheel.clientWidth);
        return width > 0 && slotPercent > 0 ? width * slotPercent / 100 : 0;
      };
      const count = kind === 'month' ? payPeriodMonths(selection).length : selection.rows.length;
      let start = null;
      const reset = () => {
        start = null;
        track.style.transform = '';
        track.style.setProperty('--wheel-drag', '');
        track.classList.remove('is-dragging');
      };
      const settle = () => {
        const dragged = track.classList.contains('is-dragging');
        start = null;
        track.style.setProperty('--wheel-drag', '');
        track.classList.remove('is-dragging');
        if (!dragged) {
          track.style.transform = '';
          return;
        }
        if (typeof track.getBoundingClientRect === 'function') track.getBoundingClientRect();
        track.style.transform = 'translateX(var(--wheel-offset))';
      };
      wheel.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        suppressClick = false;
        start = {
          x: event.clientX,
          y: event.clientY,
          t: event.timeStamp,
          id: event.pointerId,
          axis: '',
          slotPx: slotPxNow(),
        };
      });
      wheel.addEventListener('pointermove', event => {
        if (!start || event.pointerId !== start.id || start.axis === 'y') return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (start.axis !== 'x') {
          const adx = Math.abs(dx);
          const ady = Math.abs(dy);
          if (adx < 8 && ady < 8) return;
          // Lock the first clear axis so a vertical scroll never drags the wheel.
          if (ady >= adx) { start.axis = 'y'; return; }
          start.axis = 'x';
          wheel.setPointerCapture(event.pointerId);
          suppressClick = true;
        }
        track.classList.remove('is-moving');
        track.classList.add('is-dragging');
        const drag = payPeriodDragPixels(dx, index, count, start.slotPx);
        track.style.setProperty('--wheel-drag', `${drag}px`);
        track.style.transform = `translateX(calc(var(--wheel-offset) + ${drag}px))`;
        if (event.cancelable) event.preventDefault();
      });
      wheel.addEventListener('pointerup', event => {
        if (!start || event.pointerId !== start.id) return;
        const origin = start;
        const dragged = suppressClick;
        const step = origin.axis === 'x'
          ? payPeriodSwipeStep(origin, {
            x: event.clientX,
            y: event.clientY,
            t: event.timeStamp,
          }, origin.slotPx)
          : 0;
        if (step) {
          const target = Math.max(0, Math.min(count - 1, index + step));
          if (target !== index) {
            // Stop the compatibility click before remounting, including at bounds.
            event.preventDefault();
            choose(target, false);
            reset();
            return;
          }
        }
        if (dragged && event.cancelable) event.preventDefault();
        settle();
      });
      wheel.addEventListener('pointercancel', reset);
      wheel.addEventListener('lostpointercapture', event => {
        // Touch starts with implicit capture on the hit button. Its loss
        // bubbles when the wheel takes capture; that handoff is not a cancel.
        // pointerup already settled. Losing this wheel's capture mid-drag is.
        if (event.target === wheel && start) reset();
      });
      wheel.addEventListener('pointerleave', event => {
        if (start && !wheel.hasPointerCapture(event.pointerId)) reset();
      });
    });
  }
  const restore = mount.budgetSheetRestore;
  mount.budgetSheetRestore = null;
  const focusRestore = mount.budgetFocusRestore;
  mount.budgetFocusRestore = null;
  if (restore) {
    const result = sheet?.restore(restore, { deferBlend: true });
    if (result !== true && result !== 'pending') {
      const root = restore.frames?.[0] || restore;
      const outerTrigger = mount.querySelector(root.openerSelector || root.triggerSelector);
      if (outerTrigger?.getClientRects().length) outerTrigger.focus({ preventScroll: true });
      else if (typeof mount.focus === 'function') { mount.tabIndex = -1; mount.focus({ preventScroll: true }); }
    }
  } else if (focusRestore) {
    const trigger = mount.querySelector(focusRestore);
    if (trigger) {
      trigger.focus({ preventScroll: true });
      trigger.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  // Move the wired incumbent controls after the page's lower disclosures.
  // Keep the same nodes: sheet dismissal must return to the exact trigger.
  const attentionBottom = mount.ownerDocument?.getElementById('budget-attention-bottom');
  if (attentionBottom) {
    const attention = mount.querySelector('[data-budget-browse="attention"]');
    const focused = mount.ownerDocument.activeElement;
    const restoreAttentionFocus = attention?.contains(focused);
    attentionBottom.replaceChildren(...(attention ? [attention] : []));
    if (restoreAttentionFocus) {
      focused.focus({ preventScroll: true });
      focused.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
}

/* Payday operating sheet. Every financial value and verdict is already on the
 * incumbent Forecast result passed in by renderPlan. This formats those
 * fields only: it does not call Forecast, add an allocation, choose a debt
 * target, total a bucket, invent freshness, or decide feasibility. */
function unavailableOperatingSurfaceHtml(ctx) {
  const advice = ctx.advice || {};
  const liveOverlay = ctx.liveOverlay || null;
  const view = ctx.planView || advice.defaultView || {};
  const alloc = advice.paydayAllocation || null;
  const note = liveOperatingPlanNote(advice, liveOverlay);
  const incomeUnknown = advice.incomeReconciliation?.status === 'unavailable';
  const posted = incomeUnknown && alloc && alloc.currentBalancePublication;
  const openingAsOf = (liveOverlay && liveOverlay.historicalOpeningAsOf)
    || view.asOf
    || (alloc && ((alloc.cashBasis && alloc.cashBasis.asOf) || alloc.asOf))
    || ctx.asOf
    || null;
  const datedCash = view.currentBalance != null
    ? view.currentBalance
    : (alloc && alloc.available != null ? alloc.available : null);
  const observedAsOf = (liveOverlay && liveOverlay.observedAsOf)
    || (ctx.refreshTrust && ctx.refreshTrust.observedAsOf)
    || null;
  let explanation = note;
  if (openingAsOf && !incomeUnknown) {
    explanation += ` Last trusted financial opening is ${fmtDateLong(openingAsOf)}.`;
  }
  if (liveOverlay && liveOverlay.applied === false) {
    if (observedAsOf && observedAsOf !== openingAsOf) {
      explanation += ` A later live refresh on ${fmtDateLong(observedAsOf)} could not safely advance the operating plan.`;
    } else {
      explanation += ' A later live refresh could not safely advance the operating plan.';
    }
  }
  const openingHtml = posted && posted.providerConfirmed && posted.amount != null
    ? `<div class="live-current-balance" data-live-current-balance>
        <p class="live-current-balance-label">Current Balance</p>
        <p class="live-current-balance-amount" data-live-current-balance-amount>${money2(posted.amount)}</p>
        <p class="live-current-balance-account">Bills account only</p>
        <p class="operating-note">Posted balance${posted.effectiveDate ? `. As of ${fmtDateLong(posted.effectiveDate)}` : ''}. Spending permission is unavailable.</p>
      </div>`
    : !incomeUnknown && datedCash != null
    ? `<div class="payday-cash" data-last-trusted-opening data-spendable-cash="${money2(datedCash)}">
        <p class="operating-note">Last trusted opening</p>
        <span data-last-trusted-opening-amount>${money2(datedCash)}</span>
        <p class="operating-note">Dated balance — not current${openingAsOf ? `. As at ${fmtDateLong(openingAsOf)}` : ''}.</p>
      </div>`
    : '';
  const undated = view.undatedBills || [];
  let undatedLines = '';
  for (let i = 0; i < undated.length; i++) undatedLines += periodBillLine(undated[i]);
  const actionsHtml = undatedLines
    ? `<div data-unavailable-actions data-bill-section="needs-date">
        <p class="operating-lead">Still needs confirmation</p>
        <div class="operating-lines">${undatedLines}</div>
        <p class="operating-note">Not part of a current operating plan.</p>
      </div>`
    : '';
  const datedAccess = openingAsOf && !incomeUnknown
    ? `<details class="household-inline-details" data-dated-plan>
        <summary>View dated ${fmtDateLong(openingAsOf)} plan</summary>
        <p class="operating-note">This is the last trusted dated opening, not today's operating plan.</p>
      </details>`
    : '';
  return `<div class="payday-operating-sheet" data-payday-sheet data-operating-plan="unavailable" data-current-operating="unavailable">
    ${refreshTrustHtml(ctx.refreshTrust)}
    <div data-unavailable-primary>
      <p class="operating-lead">Current plan unavailable</p>
      <p class="operating-note">${explanation}</p>
    </div>
    ${openingHtml}
    ${actionsHtml}
    ${datedAccess}
  </div>`;
}

/* The selected pay-period sheet: the pay-period timeline by default, or the
 * week / lookback / carryover printouts when a caller sets planLook. Shared
 * by the active Budget surface and the retained operatingSurfaceHtml. */
function budgetPayPeriodContentHtml(ctx) {
  const advice = ctx.advice || {};
  const alloc = advice.paydayAllocation || null;

  const question = (number, prompt, answer, kind) => `
    <div class="operating-question${kind ? ` operating-${kind}` : ''}" data-operating-question="${number}" data-operating-prompt="${prompt}">
      <div class="operating-number">${number}</div>
      <h2 class="operating-prompt">${prompt}</h2>
      <div class="operating-answer">${answer}</div>
    </div>`;

  const view = ctx.planView || advice.defaultView || {};
  const billsHeading = view.billsHeading || 'Bills';
  const look = ctx.planLook || 'this-period';
  // Week, carryover, and historical sheets stay renderable when a caller
  // sets planLook. Forecast still publishes those views. This page does
  // not offer a second view control between the selector and the cards.
  const picker = '';
  const cashAlloc = {
    available: view.currentBalance != null ? view.currentBalance : (alloc && alloc.available),
    cashBasis: view.cashNote ? null : (alloc && alloc.cashBasis),
    asOf: view.asOf || (alloc && alloc.asOf),
  };
  const cash = cashGlanceHtml(cashAlloc, view.cashNote ? null : ctx.liveOverlay, view.cashNote);
  const bills = periodBillsHtml(view);
  const pastLook = look && look.slice(0, 5) === 'past:';
  const carryLook = look === 'payday-carryover';
  const timelineAvailable = typeof payPeriodTimelineHtml === 'function'
    && Array.isArray(advice.payPeriodViews)
    && advice.payPeriodViews.length > 0;
  const defaultWaterfalls = look === 'this-period' && timelineAvailable
    ? payPeriodTimelineHtml(
      advice,
      ctx.planPayPeriodId,
      ctx.liveOverlay,
      alloc,
      picker,
      ctx.plan,
      ctx.budgetCompactOverview === true,
      ctx.budgetCompactOverview === true ? budgetSavingsTimelineFor(ctx) : null,
      ctx.budgetCompactOverview === true ? budgetDailySavingsFor(ctx) : null
    )
    : (look === 'this-period' && view.calendarPeriods && view.calendarPeriods.length
      ? calendarWaterfallsHtml(
        view,
        ctx.planCalendarShow,
        ctx.liveOverlay,
        alloc,
        picker,
        ctx.plan
      )
      : '');
  const historical = pastLook && view && view.start
    ? `${picker}<div class="plan-sheet" data-historical-plan>${historicalPeriodHtml(view)}</div>`
    : '';
  const carryoverTrend = carryLook
    ? `${picker}<div class="plan-sheet" data-payday-carryover-trend-sheet>${paydayCarryoverTrendHtml(advice.paydayCarryoverTrend)}</div>`
    : '';
  // Week / next-period lookahead stops at Balance after household budget,
  // matching the household Plan waterfall. Forecast still publishes the
  // extra-debt / big-purchase chain on the view; those rows are not printed
  // on lookahead spans. Budget digest stays after the boundary.
  const tenBlock = defaultWaterfalls || historical || carryoverTrend ? '' : `
    ${question('01', 'Current Balance', cash, 'opening')}
    ${question('02', billsHeading, bills)}
    ${question('03', 'Balance after bills', runningLeftoverHtml(view.afterBills), 'balance')}
    ${question('04', 'Household budget', householdBudgetHtml(view))}
    ${question('05', 'Balance after household budget', runningLeftoverHtml(view.afterHouseholdBudget), 'ending')}
    ${budgetDigestHtml(view.budgetDigest)}`;
  return defaultWaterfalls || historical || carryoverTrend || `${picker}<div class="plan-sheet">${tenBlock}</div>`;
}

/* Today's money: the payday instruction shell for the current payday. It
 * always describes the current payday, never a selected lookback/future
 * period. AMANDA SLICE 14: its planned-cost funding block reads the
 * same-input regenerated schedule (active knobs included) — never the
 * advice copy alone. */
function currentPaydayShellHtml(ctx) {
  const advice = ctx.advice || {};
  const payPeriodViews = Array.isArray(advice.payPeriodViews) ? advice.payPeriodViews : [];
  const currentPeriod = payPeriodViews.find(entry => entry && entry.timelineRole === 'current') || null;
  return paydayInstructionShellHtml(advice, currentPeriod, budgetMonthPlanSpendSchedule(ctx, true));
}

// Compact #480 Today overview. Reprint Forecast's dated current-cash proposal,
// never add payday income to observed cash or substitute the selected period.
// All current-position instructions remain whole in the native disclosure.
function budgetTodayCashCardHtml(ctx) {
  const advice = ctx.advice || {};
  const alloc = advice.paydayAllocation || {};
  const current = (advice.payPeriodViews || []).find(row => row && row.timelineRole === 'current');
  const today = current && current.fromTodayFunding;
  const selected = payPeriodSelection(advice, ctx.planPayPeriodId).period;
  const strict = value => typeof value === 'number' && Number.isFinite(value);
  const trusted = trust => trust === 'calculated' || trust === 'estimated';
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ready = !!(today && today.basis === 'Budget-from-today'
    && ['ready', 'funding-gap'].includes(today.status) && trusted(today.trust)
    && strict(today.contribution));
  // BILLS_ACCOUNT_ID is chequing-a (Forecast and ACCOUNT_FACTS authority).
  // A deliberate null is never refilled from an aggregate or another account.
  const publication = Object.prototype.hasOwnProperty.call(advice.defaultView || {}, 'currentBalancePublication')
    ? advice.defaultView.currentBalancePublication : alloc.currentBalancePublication;
  const balanceKnown = publication?.accountId === 'chequing-a' && strict(publication.amount)
    && ['posted', 'planned-unconfirmed'].includes(publication.trust);
  const cash = ready ? today.currentCash : null; // chart scale, never Current Balance
  const cashTrust = today?.trust;
  const asOf = publication?.effectiveDate || alloc.cashBasis?.asOf || advice.defaultView?.asOf;
  const print = (value, trust) => strict(value) && trusted(trust)
    ? `<span data-budget-cash-trust="${trust}">${trust === 'estimated' ? '<span class="budget-cash-est" aria-hidden="true">≈</span> ' : ''}<span class="budget-cash-sr">${trust} </span>${money2(value)}</span>`
    : '<span class="budget-cash-unknown">Unavailable</span>';
  const floorTrust = advice.paydayShellTrust?.buffer;
  const parts = [
    { key: 'bills', label: 'Bills & debt payments',
      value: ready ? today.operatingBills : null, trust: today?.trust },
    { key: 'household', label: 'Household spending remaining', value: ready ? today.remainingHousehold : null, trust: today?.trust },
    ...(Object.prototype.hasOwnProperty.call(today || {}, 'cardPurchaseCoverageReserve')
      ? [{ key: 'card-coverage', label: 'Uncovered card purchases - keep in Bills',
        value: ready ? today.cardPurchaseCoverageReserve : null, trust: today?.trust }] : []),
    { key: 'floor', label: 'Cash floor', value: advice.buffer, trust: floorTrust },
    { key: 'proposed', label: 'Upcoming costs · proposed', value: ready ? today.contribution : null, trust: today?.trust },
  ];
  // Dimensionless geometry only. No new financial total, remainder, or deduction.
  const chartKnown = ready && strict(cash) && cash > 0 && trusted(cashTrust)
    && today.operatingShortfall === 0
    && parts.every(part => strict(part.value) && part.value >= 0 && trusted(part.trust));
  const chart = chartKnown ? `<div class="budget-cash-chart" aria-hidden="true">${parts.map(part =>
    `<span class="budget-cash-segment budget-cash-${part.key}" style="width:${Math.min(100, part.value / cash * 100)}%"></span>`).join('')}</div>` : '';
  const legend = ready ? `<div class="budget-cash-legend">${parts.map(part =>
    `<div class="budget-cash-leg" data-budget-cash-part="${part.key}"><span class="budget-cash-swatch budget-cash-${part.key}" aria-hidden="true"></span><div><span>${escape(part.label)}</span><strong>${print(part.value, part.trust)}</strong></div></div>`).join('')}</div>` : '';
  const status = ready ? `<div class="budget-cash-answer${today.operatingShortfall > 0 || today.reason ? ' has-gap' : ''}" data-budget-cash-answer>
      <div><span>Cash needed</span><strong>${print(today.requiredOperatingCash, today.trust)}</strong></div>
      <div><span>Available to fund now</span><strong>${print(today.availableNow, today.trust)}</strong></div>
      ${today.operatingShortfall > 0 ? `<div class="budget-cash-warning"><span>Operating cash shortfall</span><strong>${print(today.operatingShortfall, today.trust)}</strong></div>` : ''}
      ${today.gap && strict(today.gap.shortBy) ? `<div class="budget-cash-warning"><span>Funding gap · ${escape(fmtDate(today.gap.payday))}</span><strong>${print(today.gap.shortBy, today.trust)}</strong></div>` : ''}
    </div>` : '';
  const notice = !ready ? '' : today.operatingShortfall > 0
    ? '<p class="budget-cash-notice has-gap">Operating cash shortfall ' + print(today.operatingShortfall, today.trust) + '</p>'
    : today.gap && strict(today.gap.shortBy) && today.gap.shortBy > 0
      ? '<p class="budget-cash-notice has-gap">Funding gap ' + print(today.gap.shortBy, today.trust) + '</p>'
      : today.reason ? '<p class="budget-cash-notice">Funding needs attention</p>' : '';
  const schedule = budgetMonthPlanSpendSchedule(ctx, true);
  const row = schedule && schedule.status !== 'unavailable' && Array.isArray(schedule.paydays) ? schedule.paydays[0] : null;
  const nextDate = row && isValidIsoCalendarDate(row.payday) ? row.payday : null;
  const next = nextDate ? `<button type="button" class="budget-cash-next" data-budget-cash-next>
    <span class="budget-cash-date" aria-hidden="true"><small>${escape(new Date(nextDate + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short' }))}</small><b>${Number(nextDate.slice(8))}</b></span>
    <span><strong>${nextDate > asOf ? 'Next payday' : 'Payday plan'} · ${escape(fmtDateLong(nextDate))}</strong><small>Funding details</small></span><span aria-hidden="true">›</span>
  </button>` : '';
  const evidenceOpen = paydayDisclosuresOpen.has('today-evidence');
  // Incumbent Prepare Ahead publication: this is current protection left
  // after obligations/essentials, not a newly calculated period carryover.
  const protection = alloc.protectedPath;
  const protectionKnown = protection?.status === 'calculated' && strict(protection.allocated) && protection.allocated >= 0;
  const keep = `<div class="budget-cash-keep" data-budget-cash-keep><span>Keep for later</span><strong>${!protectionKnown && protection?.floor?.trust === 'calculated' && strict(protection.floor.amount) && protection.floor.amount > 0
    ? `At least ${money2(protection.floor.amount)}`
    : print(protectionKnown ? protection.allocated : null, protectionKnown ? 'calculated' : 'unavailable')}</strong><small>${!protectionKnown && protection?.floor?.trust === 'calculated' && strict(protection.floor.amount) && protection.floor.amount > 0
    ? 'Pending debits only; the rest is unknown until transactions catch up'
    : 'After bills &amp; essentials · across chequing'}</small></div>`;
  // Owner decision 2026-11-07: a plan built from the latest bank sync names
  // that sync's day and never calls it today's balance.
  const dating = ctx.liveOverlay && ctx.liveOverlay.applied === true && ctx.liveOverlay.balanceDating
    && ctx.liveOverlay.balanceDating.status === 'dated-latest-sync'
    && isValidIsoCalendarDate(ctx.liveOverlay.balanceDating.balanceAsOf)
    ? ctx.liveOverlay.balanceDating.balanceAsOf : null;
  const eyebrow = dating
    ? `Balances as of ${escape(fmtDateLong(dating))} · next bank sync pending`
    : `Today${asOf ? ' · ' + escape(fmtDateLong(asOf)) : ''}`;
  return `<div class="budget-today-cash" data-budget-today-cash data-live-current-balance${dating ? ` data-balance-as-of="${dating}"` : ''}>
    <header><p class="budget-cash-eyebrow">${eyebrow}</p>
      <button type="button" class="budget-cash-how" data-budget-cash-how aria-controls="budget-today-evidence" aria-expanded="${evidenceOpen}"><span aria-hidden="true">ⓘ</span><span class="budget-cash-sr">Current balance and funding details</span></button><h2>${dating ? 'Balance at latest bank sync' : 'Current balance'}</h2></header>
    <p class="budget-cash-hero" data-budget-cash-hero data-live-current-balance-amount${balanceKnown && publication.amount < 0 ? ' data-sign="negative"' : ''}>${balanceKnown ? `${publication.trust === 'planned-unconfirmed' ? '<span class="budget-cash-est" aria-hidden="true">≈</span> ' : ''}${money2(publication.amount)}` : 'Unavailable'}</p>
    <p class="budget-cash-sub">Bills account only${balanceKnown && publication.trust === 'planned-unconfirmed' ? ' · payday receipt unconfirmed' : ''}${selected && selected.timelineRole !== 'current' ? ' · current position, not the selected period opening' : ''}</p>
    ${notice}${next}
    <section class="budget-today-evidence" id="budget-today-evidence" data-budget-today-evidence aria-label="Current balance and funding evidence"${evidenceOpen ? '' : ' hidden'}>
      <button type="button" class="budget-cash-back" data-budget-cash-back>‹ Back to overview</button>
      <div class="budget-cash-plan" data-budget-cash-detail><h3>Cash needed${today?.currentThrough ? " through " + escape(fmtDate(today.currentThrough)) : ""}</h3><p class="budget-cash-plan-scope">Across chequing accounts</p>${chart}${legend}${ready ? status : ""}</div>
      ${keep}
      <p>This is the current allocation's future cash protection after bills and essential spending. It is not a Bills-account-only balance or the selected period's required carryover.</p>
      ${publication?.note ? `<p>${escape(publication.note)}</p>` : ''}
      <p>This funding plan uses both chequing accounts. Cash needed protects remaining bills, household spending${Object.prototype.hasOwnProperty.call(today || {}, 'cardPurchaseCoverageReserve') ? ', uncovered card purchases' : ''} and the existing floor. Available to fund is capacity, separate from the proposed contribution for upcoming costs. Savings and credit are excluded.</p>
      ${ready && strict(today.futureIncomeThisPeriod) ? `<p>Future receipts in this period: ${print(today.futureIncomeThisPeriod, today.trust)}. These are not cash available now.</p>` : ''}
      ${today?.evidenceFailures?.length ? `<ul>${today.evidenceFailures.map(issue => `<li data-budget-cash-reason="${escape(issue.code)}">${escape(issue.message)}${issue.action ? `<small>${escape(issue.action)}</small>` : ''}</li>`).join('')}</ul>` : !ready ? `<p>${escape(today?.reason || 'Current funding evidence is unavailable.')}</p>` : ''}
      <div class="budget-today-evidence-body">${paydayInstructionShellHtml(advice, current, schedule)}</div>
    </section>
  </div>`;
}

function operatingSurfaceHtml(ctx) {
  const advice = ctx.advice || {};
  if (liveOperatingPlanUnavailable(advice, ctx.liveOverlay)) {
    return unavailableOperatingSurfaceHtml(ctx);
  }
  const alloc = advice.paydayAllocation || null;
  const look = ctx.planLook || 'this-period';

  // The usable Plan print stops at Balance After Deductions. Forecast

  // still computes infeasible / unfunded / remaining-claim / paydayAllocation.risks
  // and weeklyCapView still composes that copy for folded diagnostics. The
  // large refresh-trust card remains on the fail-closed unavailable surface.
  // Do not reintroduce an advisory block, a replacement warning, or a
  // parallel warning authority on this sheet.

  // In the default view the picker rides inside the pay-period switch row;
  // the week and next-period printouts carry it at the top, held open.
  // The payday instruction shell remains available below the selected
  // period waterfall. It always describes the current payday
  // (never a selected lookback/future period) and reprints Forecast-owned
  // figures only.
  // AMANDA SLICE 3: Month <-> Pay Period granularity toggle on the default
  // Budget surface. Month shows the consolidated calendar-month picture
  // from Forecast.baselineTrajectory months[]; Pay Period shows the
  // existing payday/pay-period operating picture. One dashboard, two
  // lenses — the toggle changes granularity, never the Forecast values.
  const granularityToggle = look === 'this-period' ? budgetGranularityToggleHtml() : '';
  const monthView = look === 'this-period' && budgetGranularity === 'month'
    ? budgetMonthViewHtml(ctx)
    : '';
  // AMANDA SLICE 9: month-anchored pay-period drilldown. Only when the
  // household reached Pay Period from the Month lens — otherwise the
  // incumbent generic payday operating picture below is unchanged.
  const drilldownView = look === 'this-period' && budgetInPayPeriodDrilldown()
    ? budgetPayPeriodDrilldownHtml(ctx)
    : '';
  const instructionShell = look === 'this-period' && budgetGranularity !== 'month' && !drilldownView
    ? currentPaydayShellHtml(ctx) : '';
  const payPeriodContent = budgetPayPeriodContentHtml(ctx);
  const reportedShortfall = [alloc && alloc.obligations, alloc && alloc.essentials]
    .some(bucket => bucket && typeof bucket.shortfall === 'number' && bucket.shortfall > 0);
  const paydayDetails = instructionShell
    ? `<details class="budget-secondary-details" data-current-payday-details${reportedShortfall ? ' data-shortfall-reported' : ''}${typeof paydayDisclosuresOpen !== 'undefined' && paydayDisclosuresOpen.has('current-payday') ? ' open' : ''}><summary>Current payday details${reportedShortfall ? '<span class="budget-shortfall-summary"> — shortfall reported</span>' : ''}</summary>${instructionShell}</details>` : '';
  return `<div class="payday-operating-sheet budget-stepped-sheet" data-payday-sheet>
    ${monthView || drilldownView || `${payPeriodContent}${paydayDetails}`}
    ${granularityToggle ? `<details class="budget-secondary-details" data-budget-more-views><summary>More Budget views</summary>${granularityToggle}</details>` : ''}
  </div>`;
}

/* The one active Budget renderer for #operating-surface-body. Layout lives
 * in public/budget-surface.js; every section is an incumbent component
 * here, rendered whole. operatingSurfaceHtml above is retained only until
 * its helper tests move to this surface. */
function budgetWindowModel(ctx) {
  const advice = ctx.advice || {};
  const asOf = advice.defaultView && Object.prototype.hasOwnProperty.call(advice.defaultView, 'asOf')
    ? advice.defaultView.asOf : ctx.asOf;
  if (budgetGranularity === 'month') {
    const months = budgetTrajectoryFor(ctx)?.months || [];
    const index = months.findIndex(month => month.month === budgetSelectedMonth);
    const month = months[index];
    return { kind: 'month', rows: months, index, start: month?.start, end: month?.end,
      label: budgetMonthName(month?.month) || 'Month unavailable', asOf,
      current: !!month && String(asOf).slice(0, 7) === month.month };
  }
  if (budgetInPayPeriodDrilldown()) {
    return { kind: 'drilldown', rows: [], index: -1, label: `Pay periods in ${budgetMonthName(budgetPayPeriodAnchorMonth) || 'the selected month'}`, asOf };
  }
  const selection = payPeriodSelection(advice, ctx.planPayPeriodId);
  const period = selection.period;
  return { kind: 'pay-period', ...selection, start: period?.start, end: period?.end,
    label: isValidIsoCalendarDate(period?.start) && isValidIsoCalendarDate(period?.end)
      ? `${fmtDate(period.start)} – ${fmtDate(period.end)}${period.start.slice(0, 4) !== period.end.slice(0, 4) ? ` · ${period.start.slice(0, 4)}–${period.end.slice(0, 4)}` : ''}`
      : 'Pay period dates unavailable', asOf, current: period?.timelineRole === 'current',
    past: period?.timelineRole === 'past' };
}

function budgetWindowProgressHtml(model, advice) {
  // Date chrome only: use Forecast's published bounds and shared date helper.
  // Browser time, income dates reconstructed from recurrence and money are absent.
  if (!isValidIsoCalendarDate(model.start) || !isValidIsoCalendarDate(model.end)
    || !isValidIsoCalendarDate(model.asOf)) return '<p class="budget-window-note">Date progress unavailable</p>';
  const count = Forecast.diffDays(model.start, model.end) + 1;
  if (!Number.isInteger(count) || count < 1 || count > 366) return '<p class="budget-window-note">Date progress unavailable</p>';
  const inside = model.asOf >= model.start && model.asOf <= model.end;
  const day = inside ? Forecast.diffDays(model.start, model.asOf) + 1 : null;
  const line = inside ? `<b>Day ${day}</b> of ${count}`
    : `${model.end < model.asOf ? 'Completed' : 'Upcoming'} · ${count} days`;
  const action = advice.currentPeriodAction;
  const payday = action && Object.prototype.hasOwnProperty.call(action, 'nextPayday')
    ? action.nextPayday : advice.nearBoundary?.payday;
  const next = model.kind === 'pay-period' && model.current && isValidIsoCalendarDate(payday) && payday >= model.asOf
    ? `Next payday <b>${fmtDate(payday)}</b> · in ${Forecast.diffDays(model.asOf, payday)} days`
    : model.kind === 'month' ? 'Published projection window'
      : model.past ? 'Completed pay period' : 'Selected pay period';
  return `<div class="budget-window-progress" data-budget-window-progress data-start="${model.start}" data-end="${model.end}" data-as-of="${model.asOf}">
    <p><span>${line}</span><span>${next}</span></p>
    <div class="budget-window-days" style="--budget-day-count:${count}" aria-hidden="true">${Array.from({ length: count }, (_, index) =>
      `<span class="${inside && index + 1 === day ? 'is-today' : model.end < model.asOf || inside && index + 1 < day ? 'is-past' : ''}"></span>`).join('')}</div>
  </div>`;
}

function budgetWindowHeaderHtml(ctx) {
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const model = budgetWindowModel(ctx);
  const month = model.kind === 'month';
  const picker = month ? `<label class="budget-window-month-picker"><span class="budget-cash-sr">Calendar month for Budget month view</span>
      <select data-budget-month-picker aria-label="Calendar month for Budget month view">${model.rows.map(row =>
        `<option value="${escape(row.month)}"${row.month === budgetSelectedMonth ? ' selected' : ''}>${escape(budgetMonthName(row.month))}</option>`).join('')}</select></label>`
    : model.period ? `<button type="button" class="budget-window-choose" data-budget-window-choose aria-haspopup="dialog" aria-expanded="false">Choose period <span aria-hidden="true">⌄</span></button>` : '';
  const arrow = step => `<button type="button" class="budget-window-arrow" data-budget-window-step="${step}" aria-label="${step < 0 ? 'Previous' : 'Next'} ${month ? 'calendar month' : 'pay period'}" aria-disabled="${model.index < 0 || model.index + step < 0 || model.index + step >= model.rows.length}"><span aria-hidden="true">${step < 0 ? '‹' : '›'}</span></button>`;
  const chooser = model.period ? `<div data-budget-window-picker hidden>${payPeriodNavigatorHtml(model)}</div>` : '';
  const shortcuts = model.kind === 'pay-period' && model.period ? `<nav class="budget-section-nav" aria-label="Budget sections">
      ${[['overview', 'Overview'], ['spending', 'Spending'], ['bills', 'Bills'], ['upcoming', 'Upcoming']].map(([key, label]) =>
        `<button type="button" data-budget-section="${key}"${key === 'overview' ? ' aria-current="location"' : key === 'upcoming' ? ' aria-haspopup="dialog"' : ''}>${label}</button>`).join('')}
    </nav>` : '';
  return `<header class="budget-window-header" data-budget-window-header>
    <div class="budget-window-left">${budgetGranularityToggleHtml(true)}
      <div class="budget-window-switch">${arrow(-1)}<div class="budget-window-title">
        <p class="budget-window-eyebrow">${month ? 'Calendar month' : model.kind === 'drilldown' ? 'Calendar month · full pay periods' : 'Pay period'}${model.current ? '<span>Current</span>' : ''}</p>
        <h1 data-budget-window-range>${escape(model.label)}</h1>${picker}
      </div>${arrow(1)}</div>
    </div>${budgetWindowProgressHtml(model, ctx.advice || {})}${chooser}
  </header>${shortcuts}`;
}

function budgetDetailSheetHtml() {
  return `<dialog class="budget-detail-sheet" data-budget-detail-sheet aria-labelledby="budget-detail-title">
    <header><button type="button" data-budget-detail-close aria-label="Close details">‹ Back</button><h2 id="budget-detail-title" data-budget-detail-title>Details</h2></header>
    <div class="budget-detail-body" data-budget-detail-body></div>
  </dialog>`;
}

const budgetBrowseKnown = value => typeof value === 'number' && Number.isFinite(value);
const budgetBrowseEscape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function budgetBrowseMoney(value, trust) {
  return budgetBrowseKnown(value) && !['unavailable', 'unknown', 'untrusted'].includes(trust)
    ? `${trust === 'estimated' ? '<span class="est"><span aria-hidden="true">≈</span><span class="budget-cash-sr">estimated </span></span> ' : ''}${money2(value)}`
    : '<span class="budget-browse-unknown">Unavailable</span>';
}

function budgetCategoryPresentation(row) {
  const spentKnown = budgetBrowseKnown(row.spent) && !['unavailable', 'unknown', 'untrusted'].includes(row.trust);
  const other = row.otherSpending === true || row.needsConfirmation === true;
  const trust = row.confidence === 'estimated' || row.trust === 'estimated' ? 'estimated' : null;
  if (other && !budgetBrowseKnown(row.planned)) return { kind: 'unassigned', label: budgetBrowseMoney(row.spent, row.trust), spentKnown, other, trust };
  if (!spentKnown) return { kind: 'unknown', label: row.projected ? 'Not observed' : 'Spending unavailable', spentKnown, other, trust };
  if (budgetBrowseKnown(row.overspend) && row.overspend > 0)
    return { kind: 'over', label: `${budgetBrowseMoney(row.overspend, trust)} over`, spentKnown, other, trust };
  if (budgetBrowseKnown(row.remaining)) return { kind: row.remaining > 0 ? 'left' : row.remaining === 0 ? 'used' : 'over',
    label: row.remaining === 0 ? 'All used' : `${budgetBrowseMoney(row.remaining, trust)} ${row.remaining > 0 ? 'left' : 'remaining'}`,
    spentKnown, other, trust };
  return { kind: 'observed', label: 'Observed spending', spentKnown, other, trust };
}

function budgetBrowseHistorical(period) {
  return !!(period && (period.timelineRole === 'past' || period.lookback === true));
}

function budgetHistoricalSpendingEvidence(period) {
  // Published historical holds omit unproven observations. Evidence counts
  // include Other spending; an incomplete hold is never a zero-spend claim.
  const planned = (period.householdBudget || []).filter(row =>
    row && !row.informational);
  const known = planned.filter(row => budgetCategoryPresentation(row).spentKnown).length;
  if (!planned.length || known === 0) return 'unavailable';
  if (known < planned.length) return 'partial';
  return 'observed';
}

function budgetSpendingHistoryLabel(period) {
  if (period.projected) return 'Projected plan · spending not observed';
  if (!budgetBrowseHistorical(period)) return 'Observed spending · completed period';
  const evidence = budgetHistoricalSpendingEvidence(period);
  if (evidence === 'unavailable') return 'Spending unavailable · completed period';
  if (evidence === 'partial') return 'Incomplete spending evidence · completed period';
  return 'Observed spending · completed period';
}

function budgetCategoryBarHtml(row, state, pace) {
  // Dimensionless geometry from published amounts; never a new money total.
  const scale = state.spentKnown && budgetBrowseKnown(row.planned) && row.planned >= 0
    ? row.planned : null;
  const numeric = scale > 0;
  const fill = numeric ? Math.max(0, Math.min(row.spent, row.planned)) / scale * 100 : 0;
  const overPlan = scale != null && row.spent > row.planned;
  const unavailable = !state.spentKnown || !budgetBrowseKnown(row.planned);
  return `<span class="budget-category-bar${unavailable ? ' is-hatched' : ''}${overPlan ? ' is-over-plan' : ''}" aria-hidden="true" data-budget-category-scale="${numeric ? 'numeric' : unavailable ? 'unavailable' : 'no-scale'}">
    ${numeric ? `<span class="budget-category-fill" style="width:${fill}%"></span>` : ''}
    ${overPlan ? '<span class="budget-category-over-limit">!</span>' : ''}
    ${numeric && pace != null ? `<span class="budget-category-pace" style="left:${pace * 100}%"></span>` : ''}
  </span>`;
}

function budgetProgressFor(period, asOf) {
  const pub = period?.budgetProgress;
  const expectedAsOf = arguments.length > 1 ? asOf : period?.budgetProgressAsOf;
  return pub?.source === 'Forecast.budgetPeriodProgress' && isValidIsoCalendarDate(pub.asOf)
    && pub.currency === 'CAD' && pub.asOf === expectedAsOf
    && isValidIsoCalendarDate(pub.start) && isValidIsoCalendarDate(pub.end) && pub.start <= pub.end
    && pub.start === period.start && pub.end === period.end ? pub : null;
}

function budgetProgressAmountKnown(field) {
  return field && ['complete', 'partial'].includes(field.completeness)
    && ['calculated', 'estimated'].includes(field.trust)
    && typeof field.amount === 'number' && Number.isFinite(field.amount);
}

function budgetGoalContributionKnown(field) {
  return budgetProgressAmountKnown(field) && field.completeness === 'complete' && field.amount >= 0;
}

function budgetGoalPresentation(goal) {
  const confirmed = goal && ['funded', 'still-to-fund'].includes(goal.status)
    && [goal.required, goal.fulfilled].every(budgetGoalContributionKnown)
    && budgetProgressAmountKnown(goal.remaining) && goal.remaining.completeness === 'complete';
  return { confirmed, kind: confirmed ? goal.status : 'not-confirmed',
    label: confirmed ? goal.status === 'funded' ? 'Funded' : 'Still to fund' : 'Not confirmed' };
}

function budgetRemainingEvidenceContext(period, asOf) {
  // A projected allowance is labeled as such, and historical original plans
  // are already withheld. Current Remaining requires complete actual evidence.
  if (period?.projected || budgetBrowseHistorical(period)) return {};
  const publication = arguments.length > 1 ? budgetProgressFor(period, asOf) : budgetProgressFor(period);
  const actual = publication?.household?.actual;
  return { remainingEvidenceIncomplete: !budgetProgressAmountKnown(actual) || actual.completeness !== 'complete',
    remainingEvidenceReason: actual?.reason || 'Exact remaining spending is unavailable because period evidence is incomplete.' };
}

function budgetProgressValueHtml(pair, key) {
  const amount = (field, planned = false) => budgetProgressAmountKnown(field) && (!planned || field.amount >= 0)
    ? budgetBrowseMoney(field.amount, field.trust) : '<span class="budget-v3-unknown">Unknown</span>';
  // Canonical amounts stamped on the outer span under exactly the
  // predicates that print them (Household whole-dollar face, Option B):
  // the blend tile reads these typed values instead of re-parsing the
  // printed cents. Unknown sides omit the attribute. Inert everywhere
  // else — the printed strings are byte-identical.
  const actualStamp = budgetProgressAmountKnown(pair?.actual) ? ` data-budget-actual-amount="${pair.actual.amount}"` : '';
  const plannedStamp = budgetProgressAmountKnown(pair?.planned) && pair.planned.amount >= 0 ? ` data-budget-planned-amount="${pair.planned.amount}"` : '';
  const partial = pair?.actual?.completeness === 'partial';
  const actualKnown = budgetProgressAmountKnown(pair?.actual), plannedKnown = budgetProgressAmountKnown(pair?.planned);
  if (!actualKnown && !plannedKnown) return `<span data-budget-ratio="${key}"${actualStamp}${plannedStamp}><span data-budget-ratio-actual>${amount(null)}</span><span class="budget-cash-sr" data-budget-ratio-plan>Actual and plan unknown</span></span>`;
  return `<span data-budget-ratio="${key}"${actualStamp}${plannedStamp}><span data-budget-ratio-actual>${amount(pair?.actual)}${partial && actualKnown ? '<span data-budget-progress-partial aria-hidden="true">*</span><span class="budget-cash-sr"> partial evidence</span>' : ''}</span><span aria-hidden="true"> / </span><span class="budget-cash-sr"> of planned </span><span data-budget-ratio-plan>${amount(pair?.planned, true)}</span></span>`;
}

function budgetProgressBarHtml(pair, key) {
  const known = budgetProgressAmountKnown(pair?.actual) && pair.actual.completeness === 'complete'
    && budgetProgressAmountKnown(pair?.planned) && pair.planned.completeness === 'complete' && pair.planned.amount >= 0;
  const positiveScale = known && pair.planned.amount > 0 && pair.actual.amount >= 0;
  const over = known && pair.planned.amount >= 0 && pair.actual.amount > pair.planned.amount;
  const state = !known ? 'unknown' : pair.actual.amount < 0 ? 'deficit' : pair.planned.amount === 0 ? 'zero-plan' : 'known';
  return `<span class="budget-waterfall-track${!known ? ' is-unknown' : state === 'deficit' ? ' is-deficit' : !positiveScale ? ' is-noscale' : ''} budget-progress-track${over ? ' is-over-plan' : ''}" data-budget-bar-state="${state}" data-budget-progress-kind="${key}" aria-hidden="true">${positiveScale ? `<span class="budget-waterfall-bar" style="left:0%;width:${Math.min(100, pair.actual.amount / pair.planned.amount * 100)}%"></span>` : ''}${over ? '<span class="budget-progress-over">!</span>' : ''}</span>`;
}

function budgetHouseholdDeltaHtml(delta) {
  const known = budgetProgressAmountKnown(delta) && delta.completeness === 'complete'
    && budgetBrowseKnown(delta.magnitude) && delta.magnitude >= 0 && ['left', 'over'].includes(delta.direction);
  return `<span data-budget-household-delta hidden${known ? ` data-budget-delta-amount="${delta.magnitude}" data-budget-delta-direction="${delta.direction}"` : ''}><span aria-hidden="true"> · </span><span class="budget-cash-sr">Budget comparison: </span>${known ? `<span data-budget-delta-value>${budgetBrowseMoney(delta.magnitude, delta.trust)}</span> ${delta.direction}` : 'Remaining unavailable'}</span>`;
}

function budgetProgressEvidenceHtml(pair, key, period) {
  const line = (label, field) => `<p>${label}: ${budgetProgressAmountKnown(field) ? budgetBrowseMoney(field.amount, field.trust) : 'Unavailable'}${field?.completeness === 'partial' ? ' - partial evidence' : ''}.</p>${field?.reason ? `<p>${budgetBrowseEscape(field.reason)}</p>` : ''}`;
  if (key === 'household') {
    // The sealed progress publication owns actual spending and original plan.
    // Neither is the protective reserve used by the deduction waterfall.
    return `<section class="budget-progress-evidence budget-household-total" data-budget-progress-evidence="household">
      <h3>Household Budget Total</h3><p class="budget-household-total-label">Actual / Planned</p>
      <strong data-household-budget-progress-total>${budgetProgressValueHtml(pair, key)}</strong>
      <p>${budgetBrowseEscape(pair?.semantics || 'Exact-period amounts and their evidence are unavailable.')}</p>
      ${pair?.planned?.reason ? `<p>${budgetBrowseEscape(pair.planned.reason)}</p>` : ''}
      ${pair?.actual?.reason ? `<p>${budgetBrowseEscape(pair.actual.reason)}</p>` : ''}
      ${pair?.actual?.includesPending ? '<p>Incurred spending includes observed pending transactions. Their settlement remains pending.</p>' : ''}
    </section>`;
  }
  const goals = key === 'savings' && Array.isArray(pair?.goals) ? pair.goals.map(row => {
    const state = budgetGoalPresentation(row);
    const contribution = (field, signed = false) => budgetProgressAmountKnown(field) && (signed || field.amount >= 0)
      ? field : { ...field, amount: null, completeness: 'unavailable' };
    return `<section data-budget-goal-fulfillment-evidence="${budgetBrowseEscape(row.id)}"><h3>${budgetBrowseEscape(row.label || 'Goal name not confirmed')}</h3><p>${period ? budgetBrowseEscape(payPeriodRangeLabel(period)) : 'Selected pay period'}. Required is the current Forecast requirement, not an original payday snapshot.</p>${line('Required this period', contribution(row.required))}${line('Confirmed fulfilled this period', contribution(row.fulfilled))}${line('Remaining this period', contribution(row.remaining, true))}<p>${state.label}. ${budgetBrowseEscape(row.reason || '')}</p></section>`;
  }).join('') : '';
  return `<section class="budget-progress-evidence" data-budget-progress-evidence="${key}"><h3>${key === 'savings' ? 'Period contribution evidence' : 'Actual and original plan'}</h3>${line(key === 'savings' ? 'Current Forecast requirement' : 'Original plan', pair?.planned)}${line('Actual', pair?.actual)}<p>${budgetBrowseEscape(pair?.semantics || 'Exact-period amounts and their evidence are unavailable.')}</p>${pair?.actual?.includesPending ? '<p>Incurred spending includes observed pending transactions. Their settlement remains pending.</p>' : ''}${goals}</section>`;
}

function budgetSpendingSectionHtml(period, ctx) {
  const rows = (period.householdBudget || []).filter(Boolean);
  const remainingEvidence = budgetRemainingEvidenceContext(period, ctx.asOf);
  const planned = rows.filter(row => !row.informational && ((!row.otherSpending && !row.needsConfirmation)
    || (row.otherSpending && isValidIsoCalendarDate(row.targetEffectiveFrom) && budgetBrowseKnown(row.planned))));
  const classified = planned.filter(row => !remainingEvidence.remainingEvidenceIncomplete
    && budgetCategoryPresentation(row).spentKnown && budgetBrowseKnown(row.remaining));
  const over = classified.filter(row => budgetBrowseKnown(row.overspend) && row.overspend > 0);
  const model = budgetWindowModel(ctx), cycle = period.spendingCycle;
  const datesKnown = cycle && isValidIsoCalendarDate(cycle.start) && isValidIsoCalendarDate(cycle.end)
    && isValidIsoCalendarDate(model.asOf) && model.asOf >= cycle.start && model.asOf <= cycle.end;
  const days = datesKnown ? Forecast.diffDays(cycle.start, cycle.end) + 1 : null;
  const pace = days > 0 ? (Forecast.diffDays(cycle.start, model.asOf) + 1) / days : null;
  const funding = period.timelineRole === 'current' ? period.fromTodayFunding : null;
  const remainingKnown = funding?.basis === 'Budget-from-today' && ['ready', 'funding-gap'].includes(funding.status)
    && ['estimated', 'calculated'].includes(funding.trust) && isValidIsoCalendarDate(model.asOf) && funding.asOf === model.asOf
    && funding.currentThrough === period.end && budgetBrowseKnown(funding.remainingHousehold);
  const historical = budgetBrowseHistorical(period);
  const progress = budgetProgressFor(period, ctx.asOf)?.household;
  const spendingUnavailable = !budgetProgressAmountKnown(progress?.actual) ? progress?.actual?.reason : null;
  const historicalPlanUnknown = historical && !budgetProgressAmountKnown(progress?.planned);
  const historyEvidence = historical ? budgetHistoricalSpendingEvidence(period) : (period.projected ? 'projected' : 'current');
  const observedHold = !historical || historyEvidence === 'observed';
  const count = period.timelineRole === 'current'
    ? `<span class="budget-browse-pill${over.length ? ' is-warn' : !classified.length ? ' is-muted' : ''}">${over.length} of ${classified.length} known categories over plan</span>${planned.length > classified.length ? `<span class="budget-browse-pill is-muted">${planned.length - classified.length} without a remaining estimate</span>` : ''}`
    : `<span class="budget-browse-pill is-muted">${budgetSpendingHistoryLabel(period)}</span>`;
  const cards = rows.map(row => {
    if (row.informational) return `<p class="budget-browse-note">${budgetBrowseEscape(row.label)} · ${budgetBrowseEscape(row.note || 'Included in Bills')}</p>`;
    // Forecast withholds the historical original-plan denominator. Keep the
    // native row/evidence intact, but do not relabel today's category targets
    // as historical plans, remaining amounts or progress geometry here.
    const displayRow = historicalPlanUnknown && (!row.otherSpending || budgetBrowseKnown(row.planned))
      ? { ...row, planned: null, plannedTrust: 'unavailable', remaining: null, overspend: null }
      : remainingEvidence.remainingEvidenceIncomplete ? { ...row, remaining: null, overspend: null } : row;
    const state = budgetCategoryPresentation(displayRow);
    if (remainingEvidence.remainingEvidenceIncomplete && state.spentKnown) state.label = 'Remaining unavailable';
    const meta = state.other && !budgetBrowseKnown(displayRow.planned) ? budgetBrowseEscape(row.note || 'Not yet assigned to a category')
      : `<span class="budget-cash-sr">Spent </span>${budgetBrowseMoney(row.spent, row.trust)}<span aria-hidden="true"> / </span><span class="budget-cash-sr"> of planned </span>${budgetBrowseMoney(displayRow.planned, state.trust)}`;
    // Canonical pair amounts stamped under exactly the predicates that
    // print the meta tokens above (Household whole-dollar face,
    // Option B): the blend tile reads these typed values instead of
    // re-parsing the printed cents. An unknown side omits its
    // attribute. The printed meta is byte-identical.
    const pairActualStamp = state.spentKnown ? ` data-budget-pair-actual="${row.spent}"` : '';
    const pairPlannedStamp = budgetBrowseKnown(displayRow.planned) && !['unavailable', 'unknown', 'untrusted'].includes(state.trust)
      ? ` data-budget-pair-planned="${displayRow.planned}"` : '';
    return `<button type="button" class="budget-category-row is-${state.kind}"${pairActualStamp}${pairPlannedStamp} data-budget-category-open="${budgetBrowseEscape(row.id)}" data-budget-browse-origin="spending" aria-haspopup="dialog">
      <span class="budget-category-name">${budgetBrowseEscape(row.label || 'Category')}</span><span class="budget-category-status">${state.label}</span>
      <span class="budget-category-meta">${meta}</span><span class="budget-category-link">Transactions <span aria-hidden="true">›</span></span>
      ${budgetCategoryBarHtml(displayRow, state, pace)}
    </button>`;
  }).join('');
  return `<section class="budget-browse-card budget-browse-spending" data-budget-browse="spending" data-budget-spending-evidence="${historyEvidence}" aria-labelledby="budget-spending-heading">
    <header><div><p class="budget-browse-eyebrow">Spending this period</p><h2 id="budget-spending-heading" tabindex="-1">Household budget</h2><p class="budget-browse-sub">Tap a category to see its transactions.</p></div>${pace != null ? '<span class="budget-pace-key">│ Today</span>' : ''}</header>
    ${householdBudgetCycleText(period) ? `<p class="budget-browse-cycle">${budgetBrowseEscape(householdBudgetCycleText(period))}</p>` : ''}
    <div class="budget-browse-stats"><div><strong data-budget-browse-hold>${budgetProgressValueHtml(progress, 'household')}</strong>${budgetHouseholdDeltaHtml(progress?.delta)}</div>
      ${period.timelineRole === 'current' ? `<div><span>Still planned</span><strong data-budget-browse-remaining>${budgetBrowseMoney(remainingKnown ? funding.remainingHousehold : null, remainingKnown ? funding.trust : null)}</strong><small>From today</small></div>` : ''}</div>
    ${spendingUnavailable ? `<p class="budget-browse-note blend-house-unavailable" data-budget-spending-unavailable>${budgetBrowseEscape(spendingUnavailable)}</p>` : ''}
    <div class="budget-browse-counts">${count}</div><div class="budget-category-list">${cards || '<p class="budget-browse-note">Category data unavailable.</p>'}</div>
    <footer>${historical ? `<p>${observedHold ? 'Completed periods show observed spending, not a spending reserve.' : 'Missing or incomplete history is not treated as observed spending. Missing amounts are unavailable, not zero; open Info for the published evidence.'}</p>` : ''}<button type="button" data-budget-browse-evidence="06" aria-label="Household spending and reserve evidence">Info</button></footer>
  </section>`;
}

function budgetBillPresentation(row) {
  if (row.status === 'pending' || row.settlement === 'pending') return { kind: 'pending', label: 'Payment pending' };
  if (row.status === 'planned' && row.settlement === 'upcoming'
      && row.cashPaymentStatus === 'sent' && row.householdPaymentStatus === 'paid') {
    return { kind: 'due', label: 'Planned', qualifier: 'Money sent' };
  }
  const settled = row.status === 'PAID' || row.settlement === 'represented';
  if (row.cashPaymentStatus === 'sent' && row.householdPaymentStatus === 'unconfirmed') {
    return { kind: settled ? 'paid' : 'check', label: settled ? 'Paid' : 'To confirm', qualifier: 'Payment allocation unconfirmed' };
  }
  if (row.cashPaymentStatus === 'sent' && row.householdPaymentStatus === 'paid') return { kind: 'paid', label: 'Paid', qualifier: 'Money sent' };
  if (row.cashPaymentStatus === 'sent' && row.householdPaymentStatus === 'partial') return { kind: settled ? 'paid' : 'check', label: settled ? 'Paid' : 'Not paid', qualifier: 'Partial payment sent' };
  if (row.cashPaymentStatus === 'sent' && row.householdPaymentStatus === 'sent') return { kind: settled ? 'paid' : 'check', label: settled ? 'Paid' : 'To confirm', qualifier: 'Money sent; minimum amount unconfirmed' };
  if (row.settlement === 'unverified') return { kind: 'check', label: 'To confirm' };
  if (row.settlement === 'unknown' || row.status === 'unknown') return { kind: 'unknown', label: 'Status unavailable' };
  if (row.status === 'PAID' || row.settlement === 'represented') return { kind: 'paid', label: 'Paid' };
  if (row.needsDate || row.status === 'needs-date') return { kind: 'check', label: 'Needs a date' };
  if (row.settlement === 'upcoming') {
    // Forecast's upcoming settlement already qualifies the dated occurrence.
    // Keep explicit payment qualifiers and contradictory statuses distinct.
    const scheduled = isValidIsoCalendarDate(row.date) && ['still due', 'planned'].includes(row.status)
      && !row.cashPaymentStatus && !row.householdPaymentStatus;
    return { kind: 'due', label: scheduled ? 'Due' : 'Not paid' };
  }
  return { kind: 'unknown', label: 'Status unavailable' };
}

function budgetBillDisplayLabel(row) {
  if (row.id === 'mbna-aug31') return 'Amazon Mastercard — earlier August statement';
  if (row.id === 'mbna' && isValidIsoCalendarDate(row.date)) {
    const cycle = new Date(row.date + 'T12:00:00Z').toLocaleDateString('en-CA', { month: 'long', timeZone: 'UTC' });
    return `Amazon Mastercard — ${cycle} minimum`;
  }
  return row.label || 'Bill';
}

function budgetBillBrowseRowHtml(row) {
  const state = budgetBillPresentation(row);
  const amountTrust = row.displayAmountTrust === undefined
    ? (row.confidence === 'estimated' ? 'estimated' : null) : row.displayAmountTrust;
  const knownDate = isValidIsoCalendarDate(row.date);
  const amount = budgetBrowseKnown(row.movement) ? Math.abs(row.movement) : null;
  const month = knownDate ? new Date(row.date + 'T12:00:00Z').toLocaleDateString('en-CA', { month: 'short', timeZone: 'UTC' }) : '?';
  const dateEstimated = row.dateConfidence === 'estimated';
  return `<button type="button" class="budget-bill-row is-${state.kind}${state.label === 'Due' ? ' is-upcoming-due' : ''}" data-budget-bill-open="${budgetBrowseEscape(row.id)}" data-budget-bill-date="${budgetBrowseEscape(knownDate ? row.date : '')}" data-budget-browse-origin="bills" aria-haspopup="dialog">
    <span class="budget-bill-date${dateEstimated ? ' est' : ''}" aria-hidden="true"><small>${budgetBrowseEscape(month)}</small><b>${knownDate ? Number(row.date.slice(8)) : '—'}</b></span>
    <span class="budget-bill-label"><strong>${budgetBrowseEscape(budgetBillDisplayLabel(row))}</strong><span class="budget-bill-when">${knownDate ? budgetBrowseEscape(fmtDateLong(row.date)) + (dateEstimated ? ' · estimated' : '') : 'Date unavailable'}</span></span>
    <span class="budget-bill-value"><span class="budget-bill-amount">${budgetBrowseMoney(amount, amountTrust)}</span><span class="budget-bill-state"><i aria-hidden="true"></i>${state.label}${state.qualifier ? ` · ${budgetBrowseEscape(state.qualifier)}` : ''}</span></span><span class="budget-bill-chevron" aria-hidden="true">›</span>
  </button>`;
}

// The Bills counterpart of the Savings exclusion: the Travel Visa annual
// fee, read from the CURRENT Forecast savings publication — never the
// selected period's packet; the occurrence is a future commitment and the
// current packet is the one guaranteed to carry its backing item. Identity
// is the backing item's published source + id, never its label. Only the
// label, the published amount and the published occurrence date print,
// with the publication's own trust qualifications; the published saved
// figure never prints here — this is a bill, shown as a bill. The entry
// carries no period figure, so it cannot enter the period's published due
// totals or calendar, which are read from period fields only.
function budgetUpcomingAnnualBill(period, ctx) {
  if (budgetBrowseHistorical(period)) return null;
  const packet = budgetDailySavingsFor(ctx);
  const published = [...(packet?.backing?.items || []), ...(packet?.unresolved || [])];
  const matches = published.filter(item => item?.source === 'yearly-card-paid-bill'
    && item?.id === 'travelvisa-annual-fee-2027');
  if (!matches.length) return null;
  // A duplicated identity fails closed, exactly like the savings member
  // join: no occurrence is picked and no figure is invented.
  if (matches.length > 1) return { label: matches[0].label || 'Annual bill',
    amount: budgetV3Money(null, 'unknown'), when: 'Date unavailable' };
  const item = matches[0];
  const date = isValidIsoCalendarDate(item.date) ? item.date : null;
  // When the occurrence belongs to the selected period it already prints
  // once in that period's native bill buckets; the upcoming entry steps aside.
  if (date && period?.start && period?.end && date >= period.start && date <= period.end) return null;
  return { label: item.label || 'Annual bill', amount: budgetDailyNeededHtml(item),
    when: date ? fmtDateFull(date) + (item.trust === 'estimated' ? ' · estimated' : '') : 'Date unavailable' };
}

function budgetUpcomingAnnualBillRowHtml(entry) {
  // Plain markup only — never a data-budget-bill-open row and never the
  // shared .budget-bill-row class: the bucket then hides under any day
  // filter, the row never opens the bill sheet, and the blend layer's
  // bill-row scans (calendar hits, confirm counts) never see it.
  return `<div class="budget-annual-bill-row" data-budget-annual-bill="travelvisa-annual-fee-2027">
    <span class="budget-bill-label"><strong>${budgetBrowseEscape(entry.label)}</strong><span class="budget-bill-when">${budgetBrowseEscape(entry.when)}</span></span>
    <span class="budget-bill-value"><span class="budget-bill-amount">${entry.amount}</span></span></div>`;
}

function budgetBillsSectionHtml(period, ctx) {
  const progress = budgetProgressFor(period, ctx.asOf)?.bills;
  const rows = (period.bills || []).filter(Boolean);
  const feeAllowanceRetained = rows.some(row => row.scheduledFeeAllowance?.remainingAllowance > 0);
  const groups = { due: [], pending: [], check: [], paid: [], unknown: [] };
  rows.forEach(row => groups[budgetBillPresentation(row).kind].push(row));
  const section = (key, title, list, note = '', render = budgetBillBrowseRowHtml) => list.length ? `<div id="budget-bill-bucket-${key}" class="budget-bill-group${key === 'paid' ? ' budget-browse-paid' : ''}" data-budget-bill-bucket="${key}"><h3>${title} <span aria-label="Group total unavailable">Unavailable</span></h3>${list.map(render).join('')}${note ? `<p>${note}</p>` : ''}</div>` : '';
  const upcomingAnnualBill = budgetUpcomingAnnualBill(period, ctx);
  const historical = budgetBrowseHistorical(period);
  const withholdActionableRemaining = historical
    && (groups.check.length > 0 || groups.unknown.length > 0);
  const remainingHeading = historical
    ? 'Completed-period bills'
    : `<span data-budget-browse-bills-remaining>${budgetBrowseMoney(period.remainingBills)}</span> ${feeAllowanceRetained ? 'still reserved for bills' : 'left to pay or confirm'}`;
  return `<section class="budget-browse-card budget-browse-bills" data-budget-browse="bills" data-budget-bills-remaining-scope="${historical ? withholdActionableRemaining ? 'historical-unconfirmed' : 'historical-settlement' : 'actionable'}" aria-labelledby="budget-bills-heading">
    <header><div><p class="budget-browse-eyebrow">Bills this period${period.projected ? ' · projected' : historical ? ' · completed' : ''}</p><h2 id="budget-bills-heading" tabindex="-1">${budgetProgressValueHtml(progress, 'bills')}</h2><p class="budget-browse-sub">${remainingHeading}</p>${historical ? `<p class="budget-browse-sub">${withholdActionableRemaining ? 'Settlement not fully confirmed. ' : ''}Historical settlement evidence, not an amount due now. Unconfirmed entries may already be paid.</p>` : ''}</div></header>
    ${feeAllowanceRetained ? '<p class="budget-browse-sub" data-scheduled-fee-reserve>The unspent scheduled fee allowance stays reserved. The recorded fee is already settled; this is not another payment due.</p>' : ''}
    <div class="budget-browse-counts budget-bill-filters" role="group" aria-label="Filter bills by recorded household payment">
      ${[['all', 'All', rows.length], ['check', 'To confirm', groups.check.length], ['due', 'Due', groups.due.length], ['paid', 'Paid', groups.paid.length], ...groups.pending.length ? [['pending', 'Pending', groups.pending.length]] : [], ...groups.unknown.length ? [['unknown', 'Unknown', groups.unknown.length]] : []].map(([key, label, count]) => `<button type="button" class="budget-browse-pill is-${key}" data-budget-bill-filter="${key}" aria-pressed="${key === 'all'}"${key !== 'all' && count ? ` aria-controls="budget-bill-bucket-${key}"` : ''} aria-label="${label} bills: ${count}">${label}<span>${count}</span></button>`).join('')}
    </div><p class="budget-cash-sr" data-budget-bill-filter-status role="status">Showing all bills.</p>
    ${section('check', 'To confirm', groups.check, 'The bill may already be paid. Check its evidence before paying again.')}
    ${section('due', 'Due', groups.due)}${section('pending', 'Pending', groups.pending)}
    ${section('paid', 'Paid', groups.paid)}${section('unknown', 'Status unavailable', groups.unknown)}
    ${section('upcoming', 'Upcoming annual bills', upcomingAnnualBill ? [upcomingAnnualBill] : [], '', budgetUpcomingAnnualBillRowHtml)}
    <p class="budget-browse-note" data-budget-bill-filter-empty hidden>No published bills in this filter.</p>
    <details class="budget-bill-period-evidence"><summary>Period evidence</summary><div class="budget-bills-progress-wrapper">${budgetProgressBarHtml(progress, 'bills')}</div>
      <div class="budget-bills-figures"><span>${budgetBrowseMoney(period.paidBills)} confirmed settled or included in opening</span><span>${budgetBrowseMoney(period.totalBillsThisPeriod)} this period</span></div></details>
    ${!rows.length ? '<p class="budget-browse-note">No bill occurrences published for this period.</p>' : ''}
    <footer><p>The plan deducts ${budgetBrowseMoney(period.periodBillLoad, period.periodBillLoadTrust)} — assigned amounts, excluding bills settled in the opening. Payment evidence remains available for each bill.</p><button type="button" data-budget-browse-evidence="04">Why</button></footer>
  </section>`;
}

function budgetBrowseAttentionHtml(period) {
  const items = [];
  const historicalPlanUnknown = budgetBrowseHistorical(period)
    && !budgetProgressAmountKnown(budgetProgressFor(period)?.household?.planned);
  (period.householdBudget || []).filter(Boolean).forEach(row => {
    const unassigned = row.otherSpending === true || row.needsConfirmation === true;
    const over = !historicalPlanUnknown && budgetBrowseKnown(row.spent) && budgetBrowseKnown(row.overspend) && row.overspend > 0;
    if (!unassigned && !over) return;
    items.push(`<button type="button" class="budget-attention-item" data-budget-category-open="${budgetBrowseEscape(row.id)}" data-budget-browse-origin="attention" aria-haspopup="dialog"><span aria-hidden="true">${over ? '!' : '?'}</span><span><strong>${budgetBrowseEscape(row.label)} · ${over ? `${budgetBrowseMoney(row.overspend, budgetCategoryPresentation(row).trust)} over plan` : 'needs a category'}</strong><small>${over ? 'The published reserve includes the overrun.' : 'Open the included transactions, including any pending evidence.'}</small></span></button>`);
  });
  (period.bills || []).filter(row => row && budgetBillPresentation(row).kind === 'check').forEach(row => {
    items.push(`<button type="button" class="budget-attention-item" data-budget-bill-open="${budgetBrowseEscape(row.id)}" data-budget-bill-date="${budgetBrowseEscape(isValidIsoCalendarDate(row.date) ? row.date : '')}" data-budget-browse-origin="attention" aria-haspopup="dialog"><span aria-hidden="true">?</span><span><strong>${budgetBrowseEscape(row.label)} · to confirm</strong><small>It may already be paid. Check the evidence before paying again.</small></span></button>`);
  });
  return items.length ? `<section class="budget-browse-card budget-browse-attention" data-budget-browse="attention" aria-labelledby="budget-attention-heading"><header><h2 id="budget-attention-heading">Worth a look</h2><span class="budget-browse-pill is-muted">${items.length} items</span></header><div>${items.join('')}</div></section>` : '';
}

// Outgoing e-transfer review list. Renders only what Forecast publishes on
// currentPeriodAction.outgoingETransfers: the generic label, date, amount
// and canonical account — never a descriptor, payee or purpose. The
// coverage state is Forecast's; this formats it only and never invents a
// count, a total, or an all-clear.
function budgetOutgoingETransfersSectionHtml(pub) {
  const status = pub && typeof pub.status === 'string' ? pub.status : 'unavailable-missing';
  const coverage = (pub && pub.coverage) || {};
  const items = status !== 'unavailable-stale' && status !== 'unavailable-missing'
    && Array.isArray(pub && pub.items) ? pub.items : [];
  const rows = items.map(item => {
    const dateLabel = isValidIsoCalendarDate(item && item.date) ? fmtDate(item.date) : 'Date unavailable';
    const amount = Number(item && item.amount);
    // Existing household account names are display labels only. The
    // Forecast publication still owns the account identity and all values.
    const account = item && item.account;
    const accountLabel = account === 'chequing-a' ? 'Bills account' : account === 'chequing-b' ? 'Weekly spending account' : account === 'savings' ? 'Savings' : 'Account unavailable';
    return `<div class="budget-etransfer-row" data-etransfer-item>
      <span class="budget-etransfer-label">Outgoing e-transfer</span>
      <span class="budget-etransfer-amount">${Number.isFinite(amount) ? money2(amount) : 'Unavailable'}</span>
      <span class="budget-etransfer-meta">${budgetBrowseEscape(dateLabel)} &middot; ${budgetBrowseEscape(accountLabel)}${item && item.pending ? ' &middot; Pending' : ''}</span>
    </div>`;
  }).join('');
  let note = '';
  if (status === 'available-complete') {
    note = items.length
      ? `<p class="budget-browse-note">${items.length} unresolved outgoing e-transfer${items.length === 1 ? '' : 's'} from household cash accounts ${items.length === 1 ? 'is' : 'are'} listed for review this period.</p>`
      : '<p class="budget-browse-note">No unresolved outgoing e-transfers from household cash accounts are listed for review this period.</p>';
  } else if (status === 'available-posted-only') {
    note = `<p class="budget-browse-note">${items.length ? `Showing ${items.length} observed outgoing e-transfer${items.length === 1 ? '' : 's'}. ` : 'None observed yet. '}Pending coverage is incomplete, so additional outgoing e-transfers may exist.</p>`;
  } else if (status === 'available-incomplete') {
    note = `<p class="budget-browse-note">${items.length ? `Showing ${items.length} observed outgoing e-transfer${items.length === 1 ? '' : 's'} as an observed subset. ` : ''}Coverage is incomplete, so this list may be missing items.${coverage.reason ? ` ${budgetBrowseEscape(coverage.reason)}` : ''}</p>`;
  } else if (status === 'unavailable-stale') {
    note = `<p class="budget-browse-note">Transaction evidence is not current${coverage.coverageThrough && isValidIsoCalendarDate(coverage.coverageThrough) ? ` (through ${budgetBrowseEscape(fmtDate(coverage.coverageThrough))})` : ''}, so outgoing e-transfers can't be confirmed for this period.</p>`;
  } else {
    note = `<p class="budget-browse-note">Outgoing e-transfer evidence is unavailable, so outgoing e-transfers can't be confirmed for this period.</p>`;
  }
  const summary = status === 'available-complete' ? (items.length ? `${items.length} to review` : 'None listed')
    : status === 'available-posted-only' || status === 'available-incomplete' ? `${items.length ? `${items.length} observed · ` : ''}Coverage incomplete`
    : status === 'unavailable-stale' ? 'Evidence not current' : 'Evidence unavailable';
  return `<section class="budget-browse-card budget-browse-etransfers" data-budget-browse="e-transfers" data-etransfer-state="${budgetBrowseEscape(status)}" aria-labelledby="budget-etransfers-heading">
    <details class="budget-etransfers-review"><summary><span id="budget-etransfers-heading" role="heading" aria-level="2">Outgoing e-transfers</span><span class="budget-etransfers-status">${budgetBrowseEscape(summary)}</span></summary>
      <div class="budget-etransfers-content"><p class="budget-browse-sub">Current pay period · Purpose not yet confirmed</p>${note}${rows}</div>
    </details>
  </section>`;
}

function budgetOutgoingETransfersHtml(period, ctx) {
  // currentPeriodAction always describes the current period, while this
  // renderer follows the selected period: gate on the current role so a
  // past or future selection never shows the current list under its name.
  if (!period || period.timelineRole !== 'current') return '';
  const pub = ctx && ctx.advice && ctx.advice.currentPeriodAction
    ? ctx.advice.currentPeriodAction.outgoingETransfers : null;
  return budgetOutgoingETransfersSectionHtml(pub);
}

// Plan-unavailable path: BudgetSurface skips browseHtml there, so without
// this contribution the section would vanish and read as "none found".
// Notice only — no items are ever resurrected as current-period fact.
// Same current-period gate as budgetOutgoingETransfersHtml: the publication
// always describes the current period, so when the selected period is a
// past or future one the notice must not render under that selection.
// Pay-period view only: BudgetSurface renders the unavailable card under
// either granularity, so the period gate alone would leak this notice
// into the month view whenever a current-period selection is retained.
function budgetOutgoingETransfersUnavailableHtml(ctx) {
  if (budgetGranularity !== 'pay-period') return '';
  const period = payPeriodSelection(ctx && ctx.advice || {}, ctx && ctx.planPayPeriodId).period;
  if (!period || period.timelineRole !== 'current') return '';
  const pub = ctx && ctx.advice && ctx.advice.currentPeriodAction
    ? ctx.advice.currentPeriodAction.outgoingETransfers : null;
  const status = pub && pub.status === 'unavailable-stale' ? 'unavailable-stale' : 'unavailable-missing';
  return budgetOutgoingETransfersSectionHtml({
    status, coverage: pub ? pub.coverage : null, count: null, items: null,
  });
}

function budgetBrowseSectionsHtml(ctx) {
  const period = payPeriodSelection(ctx.advice || {}, ctx.planPayPeriodId).period;
  if (!period || period.operatingPlanUnavailable) return '';
  return `${budgetBrowseAttentionHtml(period)}<div class="budget-browse-grid">${budgetSpendingSectionHtml(period, ctx)}${budgetBillsSectionHtml(period, ctx)}</div>${budgetOutgoingETransfersHtml(period, ctx)}`;
}

// Approved v3 presentation. The incumbents are publishBudgetPeriodFunding
// (dated Today proposal), planSpendPaydayFunding (exact payday schedule),
// and its exact payday schedule. Geometry uses ratios only; no money totals.
const budgetV3Escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const budgetV3Known = (amount, trust) => typeof amount === 'number' && Number.isFinite(amount)
  && ['calculated', 'estimated'].includes(trust);
const budgetV3Money = (amount, trust) => budgetV3Known(amount, trust)
  ? `${trust === 'estimated' ? '<span class="budget-v3-est">≈<span class="budget-cash-sr"> estimated</span></span> ' : '<span class="budget-cash-sr">calculated </span>'}${money2(amount)}`
  : '<span class="budget-v3-unknown">Unavailable</span>';

function budgetSavingsGoalsHtml(ctx, period, schedule) {
  if (period?.timelineRole === 'current' || ctx.plan?.savingsEarmarks?.allocationPolicy != null
      || ctx.advice?.savingsFunding != null) {
    const daily = budgetDailySavingsFor(ctx, period.id);
    const projected = daily.period?.kind === 'projected';
    const periodMode = budgetSavingsPeriodContext(daily);
    const value = (amount, trust) => budgetSavingsMoney(amount, trust, periodMode);
    const roster = [...(period.plannedCostFunding?.items || []), ...(period.plannedCostFunding?.unscheduled || [])];
    const listed = budgetDailySavingsRows(daily, ctx.advice?.savingsInventory, roster);
    const annualBillNote = budgetSavingsAnnualBillNoteHtml(listed);
    const named = listed.map(row => {
      // Canonical typed amounts stamped on the goal <li> under exactly the
      // predicates that print them (funding-bar bands): the blend tile reads
      // these typed values instead of re-parsing printed text. Unknown or
      // ranged sides omit the attribute. Printed strings are byte-identical.
      const savedStamp = budgetV3Known(row.saved, row.savedTrust)
        ? ` data-budget-goal-saved-amount="${row.saved}"` : '';
      const requiredStamp = !row.neededRange && budgetV3Known(row.needed, row.neededTrust ?? row.trust)
        ? ` data-budget-goal-required-amount="${row.needed}"` : '';
      const group = budgetSavingsRowMembers(daily, row);
      const members = group ? `<div class="budget-goal-members">${group.members.map(member => {
        const figures = budgetSavingsMemberFigures(member, row.thisPeriodTrust, group.historical, periodMode);
        return `<div class="budget-goal-member" data-budget-savings-member="${budgetV3Escape(member.key)}"><span>${budgetV3Escape(figures.name)}${figures.date ? ` <small>${budgetV3Escape(fmtDate(figures.date))}</small>` : ''}</span><span><span data-budget-savings-member-saved>${figures.saved}</span> / <span data-budget-savings-member-needed>${figures.needed}</span><small>Saved / needed</small></span><span><span data-budget-savings-member-proposed>${figures.proposed}</span><small>This period</small></span></div>`;
      }).join('')}</div>` : '';
      return `<li data-budget-savings-goal="${budgetV3Escape(row.key)}"${savedStamp}${requiredStamp}><button type="button" class="budget-goal-row" data-budget-goal-open="${budgetV3Escape(row.key)}" aria-haspopup="dialog">
      <div class="budget-goal-heading"><strong>${budgetV3Escape(group ? group.title : row.label)}</strong></div>
      <div class="budget-goal-amounts"><span><span class="budget-goal-amount">${value(row.saved, row.savedTrust)}</span><small>Saved</small></span><span aria-hidden="true">/</span><span><span class="budget-goal-amount">${budgetDailyNeededHtml(row, projected)}</span><small>Needed</small></span></div>
      ${budgetGoalPaidProgressHtml(row)}
      <p class="budget-goal-context">${value(row.thisPeriod, row.thisPeriodTrust)} this period<span class="budget-goal-evidence">Info <span aria-hidden="true">></span></span></p>${members}
    </button></li>`;
    }).join('');
    return `<div class="budget-surface-card budget-savings-goals" data-budget-savings-goals><p class="budget-surface-eyebrow">${budgetV3Escape(payPeriodRangeLabel(period))}</p><h3>Saving for</h3>${projected ? '<p data-budget-savings-forecast-stock>Savings at period close: ' + value(daily.forecastClosing?.stock, daily.forecastClosing?.trust) + '.</p>' + budgetSavingsEstimateBasisHtml(daily) : ''}${projected && daily.forecastClosing?.status === 'ready' ? '<p data-budget-savings-forecast-bills>Bills at period close: ' + value(daily.forecastClosing.operatingCash, daily.forecastClosing.trust) + '.</p>' : ''}${daily.forecastClosing?.gap ? daily.forecastClosing?.status === 'ready' ? '<p data-budget-savings-forecast-gap>Bills shortfall of ' + value(daily.forecastClosing.gap.shortBy, daily.forecastClosing.gap.trust) + ' on ' + budgetV3Escape(fmtDate(daily.forecastClosing.gap.date)) + '.</p>' : '<p>' + budgetV3Escape(daily.forecastClosing.reason) + '</p>' : ''}<ul>${named || (projected && (daily.plannedRequirements?.rows.length === 0 && !daily.forecastClosing?.gap || daily.forecastClosing?.status === 'ready') ? '<li>No remaining Savings requirements.</li>' : '<li>Named savings unavailable.</li>')}</ul>${annualBillNote}
      <button type="button" class="budget-surface-link" data-budget-funding-inventory aria-haspopup="dialog">Accounts &amp; evidence</button>
      <div data-budget-funding-savings hidden>${daily ? budgetDailySavingsHtml(daily, '', ctx.advice?.savingsInventory, { asOf: ctx.asOf || ctx.advice?.defaultView?.asOf, period }) : 'Daily savings unavailable.'}</div></div>`;
  }
  const legacy = ctx.plan?.savingsEarmarks?.allocationPolicy == null && ctx.advice?.savingsFunding == null;
  const funding = legacy ? period?.plannedCostFunding : null;
  const fulfillment = legacy ? budgetProgressFor(period, ctx.asOf)?.savings : null;
  // A proposal is not fulfillment. Incumbent actualSaved is a balance, not
  // a confirmed contribution for this period. Until Forecast publishes that
  // distinction, every goal's fulfillment remains explicitly not confirmed.
  const published = [...(Array.isArray(funding?.items) ? funding.items : []),
    ...(Array.isArray(funding?.unscheduled) ? funding.unscheduled : [])];
  const fallback = [...(Array.isArray(schedule?.fundingRoster) ? schedule.fundingRoster : []),
    ...(Array.isArray(schedule?.costs) ? schedule.costs : []),
    ...(Array.isArray(schedule?.unscheduled) ? schedule.unscheduled : [])];
  const seen = new Set();
  const rows = [...(Array.isArray(fulfillment?.goals) ? fulfillment.goals : []), ...published, ...fallback]
    .filter(row => row && row.id && !seen.has(row.id) && seen.add(row.id));
  const named = rows.map(row => {
    const goal = Array.isArray(fulfillment?.goals) ? fulfillment.goals.find(goal => goal.id === row.id) : null;
    const label = typeof row.label === 'string' && row.label.trim() && row.label !== row.id
      ? row.label : 'Goal name not confirmed';
    const state = budgetGoalPresentation(goal);
    const proposal = goal?.proposal?.completeness === 'proposal' && budgetV3Known(goal.proposal.amount, goal.proposal.trust)
      && goal.proposal.amount >= 0;
    const required = budgetGoalContributionKnown(goal?.required);
    const fulfilled = budgetGoalContributionKnown(goal?.fulfilled);
    const remaining = budgetProgressAmountKnown(goal?.remaining) && goal.remaining.completeness === 'complete';
    const unknown = '<span class="budget-v3-unknown">Unknown</span>';
    // Same typed stamps as the current branch, under this branch's exact
    // print predicates (budgetGoalContributionKnown, as the booleans above):
    // fulfilled is the saved side, required the total requirement side.
    const savedStamp = fulfilled ? ` data-budget-goal-saved-amount="${goal.fulfilled.amount}"` : '';
    const requiredStamp = required ? ` data-budget-goal-required-amount="${goal.required.amount}"` : '';
    return `<li data-budget-savings-goal="${budgetV3Escape(row.id)}"${savedStamp}${requiredStamp}><button type="button" class="budget-goal-row is-${state.kind}" data-budget-goal-open="${budgetV3Escape(row.id)}" aria-haspopup="dialog">
      <div class="budget-goal-heading"><strong>${budgetV3Escape(goal?.label || label)}</strong><span class="budget-goal-state">${state.label}</span></div>
      <div class="budget-goal-amounts"><span><span class="budget-goal-amount" data-budget-goal-fulfilled>${fulfilled ? budgetV3Money(goal.fulfilled.amount, goal.fulfilled.trust) : unknown}</span><small>Fulfilled</small></span><span aria-hidden="true">/</span><span><span class="budget-goal-amount" data-budget-goal-required>${required ? budgetV3Money(goal.required.amount, goal.required.trust) : unknown}</span><small>Required this period</small></span></div>
      <p class="budget-goal-context">${remaining ? `${budgetV3Money(goal.remaining.amount, goal.remaining.trust)} remaining` : required ? 'Current Forecast requirement' : proposal ? `${budgetV3Money(goal.proposal.amount, goal.proposal.trust)} proposed; requirement unavailable` : 'Required contribution unavailable'}<span class="budget-goal-evidence">Evidence <span aria-hidden="true">></span></span></p>
    </button></li>`;
  }).join('');
  return `<div class="budget-surface-card budget-savings-goals" data-budget-savings-goals><p class="budget-surface-eyebrow">${budgetV3Escape(payPeriodRangeLabel(period))}</p><h3>Saving for</h3>
    <ul>${named || '<li>Goal contributions unavailable for this period.</li>'}</ul>
    <p class="budget-goal-notice">Balances and proposals do not confirm period contributions.</p>
    <button type="button" class="budget-surface-link" data-budget-funding-inventory aria-haspopup="dialog">Accounts &amp; evidence</button>
    <div data-budget-funding-savings hidden>${typeof SavingsInventory !== 'undefined' ? SavingsInventory.html(ctx.advice?.savingsFunding || (ctx.plan?.savingsEarmarks?.allocationPolicy == null ? ctx.advice?.savingsInventory : null), { asOf: ctx.asOf || ctx.advice?.defaultView?.asOf, advice: ctx.advice, plan: ctx.plan }) : '<p>Savings inventory unavailable. Saved balances and assignments are unknown.</p>'}</div></div>`;
}

function budgetUpcomingFundingHtml(ctx) {
  const current = (ctx.advice?.payPeriodViews || []).find(row => row?.timelineRole === 'current');
  const daily = budgetDailySavingsFor(ctx);
  const today = current?.fromTodayFunding;
  const selected = payPeriodSelection(ctx.advice, ctx.planPayPeriodId).period;
  const currentEvidence = selected?.id === current?.id && today ? ''
    : `<div hidden data-budget-funding-current-evidence>${calendarFromTodayEvidenceHtml(current, ctx.plan)
      || '<div data-from-today-proposal><p>Current-period funding evidence is unavailable. No proposal or saved balance has been established.</p></div>'}</div>`;
  const schedule = budgetMonthPlanSpendSchedule(ctx, true);
  const payday = schedule?.status !== 'unavailable' && Array.isArray(schedule?.paydays) ? schedule.paydays[0] : null;
  const exact = isValidIsoCalendarDate(payday?.payday) ? payday.payday : null;
  const todayReady = today?.basis === 'Budget-from-today' && ['ready', 'funding-gap'].includes(today.status)
    && today.asOf === ctx.asOf && today.currentThrough === current?.end
    && budgetV3Known(today.contribution, today.trust) && Array.isArray(today.items);
  const paydayTrust = exact === schedule?.asOf ? payday?.trust : schedule?.fundingTrust;
  const paydayReady = !!exact && schedule?.asOf === ctx.asOf && exact >= ctx.asOf
    && ['ready', 'funding-gap'].includes(schedule?.status)
    && budgetV3Known(payday?.contribution, paydayTrust) && Array.isArray(payday.allocations);
  const nextWord = exact && exact > ctx.asOf ? 'Next payday plan' : 'Payday plan';
  const dailyReady = daily?.status === 'ready' && daily.period?.status === 'ready';
  const legacy = ctx.plan?.savingsEarmarks?.allocationPolicy == null && ctx.advice?.savingsFunding == null;
  // Earlier inputs retain native requirement evidence and the separately
  // qualified payday projection. They do not acquire combined-policy backing
  // or a confirmed daily offer. The current policy selects sealed lenses only.
  const earlierLenses = legacy ? [
    { key: 'today', ready: false, trust: today?.trust, fundingTrust: today?.trust,
      proposal: null, remaining: null,
      items: Array.isArray(today?.items) ? today.items : [],
      unscheduled: Array.isArray(today?.unscheduled) ? today.unscheduled : [],
      reason: daily?.period?.reason || daily?.reason, when: 'unsent top-up today' },
    { key: 'payday', payday: exact, ready: paydayReady, trust: paydayTrust,
      fundingTrust: schedule?.fundingTrust, proposal: payday?.contribution,
      remaining: payday?.stillToFund, gap: schedule?.gap, reason: schedule?.reason,
      items: (Array.isArray(schedule?.costs) ? schedule.costs : []).map(cost => {
        const allocation = paydayReady ? payday.allocations.find(part => part.id === cost.id) : null;
        return { ...cost, cost: cost.baseRequirement,
          contribution: paydayReady ? allocation ? allocation.amount : 0 : null };
      }),
      unscheduled: Array.isArray(schedule?.unscheduled) ? schedule.unscheduled : [], when: 'proposed this payday' },
  ] : null;
  const lenses = (daily?.lenses || earlierLenses || [
    { key: 'today', ready: false, items: [], unscheduled: [], reason: daily?.reason },
    { key: 'payday', ready: false, items: [], unscheduled: [], reason: daily?.reason },
  ]).map(lens => ({ ...lens, label: lens.key === 'today' ? "From today's cash"
    : (lens.payday ? 'Next payday plan - ' + fmtDate(lens.payday) : 'Next payday plan') }));
  const costHtml = (item, lens, undated = false) => {
    const costTrust = item.confidence === 'confirmed' ? 'calculated' : item.confidence;
    const costKnown = budgetV3Known(item.cost, costTrust);
    const contributionKnown = lens.ready && budgetV3Known(item.contribution, lens.trust) && !undated;
    const scaled = costKnown && item.cost > 0 && contributionKnown && item.contribution >= 0;
    const gap = lens.ready && ['calculated', 'estimated'].includes(lens.fundingTrust)
      && Array.isArray(lens.gap?.affected) && lens.gap.affected.includes(item.id);
    return `<div class="budget-funding-cost${gap ? ' has-gap' : ''}" data-budget-funding-cost="${budgetV3Escape(item.id)}">
      <div class="budget-funding-cost-head"><strong>${budgetV3Escape(item.label || item.id)}</strong><b>${budgetV3Money(item.cost, costTrust)}</b></div>
      <p>${isValidIsoCalendarDate(item.date) ? budgetV3Escape(fmtDate(item.date)) : 'Date not established'}${item.confidence === 'estimated' ? ' · estimated date' : ''}${undated ? ' · ' + budgetV3Escape(item.reason || 'Contribution unavailable') : ''}</p>
      <p data-budget-funding-saved>Currently backed: ${budgetV3Money(item.saved, item.savedTrust)}</p>
      <div class="budget-funding-progress"><span class="budget-funding-track${!scaled && !(costKnown && item.cost === 0 && contributionKnown) ? ' is-unknown' : ''}" aria-hidden="true">${scaled ? `<i style="width:${Math.min(100, item.contribution / item.cost * 100)}%"></i>` : ''}</span><span>${contributionKnown ? budgetV3Money(item.contribution, lens.trust) + ' ' + lens.when : '<span class="budget-v3-unknown">Contribution unknown</span>'}</span></div>
      ${lens.ready && item.nextContribution && lens.key === 'payday' && budgetV3Known(item.nextContribution.amount, lens.fundingTrust) && isValidIsoCalendarDate(item.nextContribution.payday) && item.nextContribution.payday > exact ? `<p>Next scheduled: ${budgetV3Money(item.nextContribution.amount, lens.fundingTrust)} on ${budgetV3Escape(fmtDate(item.nextContribution.payday))}</p>` : ''}
    </div>`;
  };
  const panelHtml = lens => {
    // Preserve publication order. A heading marks each published month boundary;
    // the page never sorts, ranks, adds costs, or manufactures a funding gap.
    let prior = null;
    const items = lens.items.map(item => {
      const month = isValidIsoCalendarDate(item.date) ? item.date.slice(0, 7) : null;
      const heading = month !== prior || prior === null;
      prior = month;
      return `<div class="budget-funding-timeline-row${heading ? ' is-month-boundary' : ''}"><div class="budget-funding-month">${heading ? budgetV3Escape(month ? budgetMonthName(month) : 'Date unknown') : ''}</div>${costHtml(item, lens)}</div>`;
    }).join('');
    const gapKnown = lens.ready && budgetV3Known(lens.gap?.shortBy, lens.fundingTrust);
    const names = gapKnown && Array.isArray(lens.gap.affected) ? lens.gap.affected.map(id => lens.items.find(item => item.id === id)?.label || id) : [];
    return `<div id="budget-funding-${lens.key}" data-budget-funding-panel="${lens.key}" role="tabpanel" aria-labelledby="budget-funding-tab-${lens.key}"${lens.key === budgetFundingLens ? '' : ' hidden'}>
      <p class="budget-funding-scope">${lens.key === 'today' ? 'Unsent top-ups from current chequing.' : "Future payday projection. Keep it separate from today's offer."}</p>
      <div class="budget-funding-totals"><div><span>${lens.key === 'today' ? 'Unsent top-up today' : 'Proposed this payday'}</span><strong data-budget-funding-proposal>${budgetV3Money(lens.ready ? lens.proposal : null, lens.trust)}</strong></div><div><span>${lens.key === 'today' ? 'Remaining cycle entitlement' : 'Still to fund after this proposal'}</span><strong>${budgetV3Money(lens.ready ? lens.remaining : null, lens.fundingTrust)}</strong></div></div>
      ${gapKnown ? `<div class="budget-funding-gap">${budgetV3Money(lens.gap.shortBy, lens.fundingTrust)} short${isValidIsoCalendarDate(lens.gap.payday) ? ' on ' + budgetV3Escape(fmtDate(lens.gap.payday)) : ''}.${names.length ? '<p>Affected: ' + names.map(budgetV3Escape).join(', ') + '.</p>' : ''}<p>Later proposals pause at this published gap. Earmarks only — not transfers or saved money.</p></div>` : ''}
      ${!lens.ready || lens.reason ? `<p class="budget-funding-notice">${budgetV3Escape(lens.reason || 'Funding evidence is unavailable. Open the complete evidence for the reasons and next steps.')}</p>` : ''}
      ${items || `<p>${lens.ready ? 'No dated costs published for this proposal.' : 'Dated cost roster unavailable for this proposal.'}</p>`}
      ${lens.unscheduled.length ? `<div class="budget-funding-timeline-row"><div class="budget-funding-month">No scheduled contribution</div><div>${lens.unscheduled.map(item => costHtml(item, lens, true)).join('')}</div></div>` : lens.key === 'payday' && !Array.isArray(schedule?.unscheduled) ? '<p>Undated cost roster unavailable for this payday proposal.</p>' : ''}
      <button type="button" class="budget-surface-link" data-budget-funding-evidence="${lens.key}" aria-haspopup="dialog">${lens.key === 'today' ? 'Today: needs, costs and forward evidence' : 'Complete exact payday funding plan'}</button>
    </div>`;
  };
  return `<section class="budget-funding-section" data-budget-funding-section aria-labelledby="budget-funding-heading">
    <header class="budget-v3-section-heading"><h2 id="budget-funding-heading" tabindex="-1">Upcoming costs &amp; savings</h2><p>Named costs the plan is proposing to fund.</p></header>
    <div class="budget-funding-grid"><div class="budget-surface-card budget-funding-card"><p class="budget-surface-eyebrow">Funding proposal</p><h3>Costs ahead</h3>
      <div class="budget-funding-tabs" role="tablist" aria-label="Upcoming-cost funding proposal">${lenses.map(lens => `<button type="button" id="budget-funding-tab-${lens.key}" data-budget-funding-tab="${lens.key}" role="tab" aria-selected="${lens.key === budgetFundingLens}" aria-controls="budget-funding-${lens.key}" tabindex="${lens.key === budgetFundingLens ? 0 : -1}">${budgetV3Escape(lens.label)}</button>`).join('')}</div>
      ${lenses.map(panelHtml).join('')}</div>
      <aside class="budget-funding-sidebar"><div class="budget-surface-card"><p class="budget-surface-eyebrow">Separate funding scopes</p><h3>Where it comes from</h3><p>Today uses current chequing after bills, household needs and the floor. Payday uses projected funding.</p>
        <div class="budget-funding-context" data-budget-funding-context="today"${budgetFundingLens === 'today' ? '' : ' hidden'}><div><span>Capacity to propose now</span><strong>${budgetV3Money(dailyReady ? daily.period.availableNow : null, daily?.period?.trust)}</strong></div><p>Capacity is separate from the proposed contribution. Future receipts are not current cash.</p></div>
        <div class="budget-funding-context" data-budget-funding-context="payday"${budgetFundingLens === 'payday' ? '' : ' hidden'}><div><span>Projected protected after payday</span><strong>${budgetV3Money(paydayReady ? payday.protectedAfterPayday : null, schedule?.fundingTrust)}</strong></div><p>This is projected protection for the funding schedule, not a Bills-only period carryover or a saved balance.</p></div>
        <p>Proposals do not mean money is saved or moved.</p><button type="button" class="budget-surface-link" data-budget-funding-how aria-haspopup="dialog">How this works</button></div>
        ${budgetSavingsGoalsHtml(ctx, selected, schedule)}</aside>
    </div><div hidden data-budget-daily-funding-evidence>${daily ? budgetDailySavingsHtml(daily, '', ctx.advice?.savingsInventory, { asOf: ctx.asOf || ctx.advice?.defaultView?.asOf, advice: ctx.advice }) : '<p>Daily savings funding unavailable.</p>'}</div>${currentEvidence}</section>`;
}

function wireBudgetFunding(mount, sheet) {
  const tabs = [...mount.querySelectorAll('[data-budget-funding-tab]')];
  const select = (button, focus = false) => {
    const key = button.getAttribute('data-budget-funding-tab');
    budgetFundingLens = key;
    tabs.forEach(tab => {
      const chosen = tab === button;
      tab.setAttribute('aria-selected', String(chosen));
      tab.tabIndex = chosen ? 0 : -1;
    });
    mount.querySelectorAll('[data-budget-funding-panel]').forEach(panel => {
      panel.hidden = panel.getAttribute('data-budget-funding-panel') !== key;
    });
    mount.querySelectorAll('[data-budget-funding-context]').forEach(panel => {
      panel.hidden = panel.getAttribute('data-budget-funding-context') !== key;
    });
    if (focus) button.focus({ preventScroll: true });
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      select(tabs[next], true);
    });
  });
  if (!sheet) return;
  mount.querySelectorAll('[data-budget-funding-evidence], [data-budget-funding-how], [data-budget-funding-inventory], [data-budget-month-funding-open], [data-budget-goal-open]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.getAttribute('data-budget-funding-evidence');
      const selector = button.hasAttribute('data-budget-goal-open') ? '[data-operating-question="savings"] .budget-step-body'
        : button.hasAttribute('data-budget-month-funding-open') ? '[data-budget-month-funding-evidence]'
        : button.hasAttribute('data-budget-funding-inventory') ? '[data-budget-funding-savings]'
        : key === 'today' ? '[data-budget-daily-funding-evidence]' : key === 'payday'
          ? '[data-payday-breakdown="planned-cost-funding"]' : '[data-budget-today-evidence]';
      const periodSource = mount.querySelector(selector);
      const goalId = button.getAttribute('data-budget-goal-open');
      const linkedRow = goalId && periodSource?.querySelector(`[data-budget-savings-total-goal="${CSS.escape(goalId)}"]`);
      const goalSource = linkedRow?.querySelector('[data-savings-link-evidence]') ? linkedRow
        : goalId && periodSource?.querySelector(`[data-budget-goal-fulfillment-evidence="${CSS.escape(goalId)}"]`);
      const source = goalSource || periodSource;
      if (!source) return;
      if (button.hasAttribute('data-budget-funding-inventory') && typeof SettlementSave !== 'undefined')
        SettlementSave.mount(source);
      const disclosure = source.matches('details') ? source : source.querySelector('details');
      if (disclosure) disclosure.open = true;
      sheet.open(source, button, button.hasAttribute('data-budget-goal-open') ? goalSource ? button.querySelector('strong')?.textContent || 'Goal contribution evidence' : 'Period contribution evidence'
        : button.hasAttribute('data-budget-month-funding-open') ? 'Month-input exact funding plan' : key === 'today' ? 'Today: complete funding evidence'
        : key === 'payday' ? 'Exact payday funding plan' : button.hasAttribute('data-budget-funding-inventory')
          ? source.querySelector('[data-budget-savings-forecast-evidence]') ? 'Savings at period close' : 'Savings assignments and backing'
          : 'Current cash and funding scopes');
    });
  });
}

// Render only: Forecast owns every term and the unavailable/estimate stamp.
function billsAccountPeriodBalanceHtml(ctx) {
  const publication = ctx.advice?.defaultView?.billsAccountPeriodBalance;
  if (!publication || publication.source !== 'Forecast.billsAccountPeriodBalance'
    || publication.accountId !== 'chequing-a' || publication.scope !== 'bills-only') return '';
  // Forecast publishes this card for the active pay period only. When the
  // surface has another period selected, the card must not ride into that
  // period's figures carrying the active period's label and value: beside a
  // different period's dates it would read as that period's own closing
  // balance. The selected row is the publication's own period when it is the
  // current row or its dates match the publication's exactly.
  const selected = payPeriodSelection(ctx.advice || {}, ctx.planPayPeriodId).period;
  if (selected && selected.timelineRole !== 'current'
    && !(publication.start && selected.start === publication.start
      && selected.end === publication.end)) return '';
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const ready = publication.status === 'ready' && publication.trust === 'estimated' && numeric(publication.amount);
  const print = value => numeric(value) ? money2(value) : 'Unavailable';
  const household = publication.household || {};
  const rows = ready ? [
    ['Posted Bills cash', publication.observedCash],
    ['Income still to reach Bills', publication.futureIncome],
    ['Remaining bills', publication.remainingBills],
    ['Remaining household funding — estimate', household.remaining],
    ['Other planned Bills outflows', publication.otherOutflows],
    ['Earlier or nonbudget card purchases', publication.additionalCardCash],
  ].map(([label, amount]) => `<div class="operating-line"><span>${escape(label)}</span><strong>${print(amount)}</strong></div>`).join('') : '';
  const open = paydayDisclosuresOpen.has('bills-closing');
  return `<section class="budget-bills-closing" data-bills-closing data-bills-closing-state="${ready ? 'estimated' : 'unavailable'}" aria-label="Expected Bills balance at period end">
    <h2>Expected Bills balance at period end</h2>
    <p class="budget-bills-closing-value" data-bills-closing-amount${ready && publication.amount < 0 ? ' data-sign="negative"' : ''}>${ready ? '<span class="budget-bills-closing-estimate">Estimated</span> ' + print(publication.amount) : 'Unavailable'}</p>
    <p class="operating-note">After remaining bills and household funding${publication.end ? ', through ' + escape(fmtDateLong(publication.end)) : ''}. Bills account only.</p>
    ${!ready ? `<p class="operating-note" data-bills-closing-reason>${escape(publication.reason || 'Remaining cash requirements are unconfirmed.')}</p>` : ''}
    <p class="operating-note">Latest recorded Bills balance: ${print(publication.observedCash)}${publication.observedAsOf ? ', dated ' + escape(fmtDateLong(publication.observedAsOf)) : ''}. The bank may have a newer balance.</p>
    <details data-payday-breakdown="bills-closing" data-bills-closing-details${open ? ' open' : ''}>
      <summary>${ready ? 'How this estimate works' : 'What needs confirmation'}</summary>
      <div class="budget-bills-closing-evidence">${rows}
        ${ready ? `<p class="operating-note">Household target ${print(household.target)}; already funded from Bills ${print(household.funded)}. Remaining funding is estimated from the period target and observed Bills funding, with required pending and card cash protected. Category allocations are not established.</p>`
          : `<ul>${(publication.issues || []).map(row => `<li>${escape(row.message)}</li>`).join('')}</ul>`}
        ${publication.accountAssumption ? `<p class="operating-note">${escape(publication.accountAssumption)}</p>` : ''}
        <p class="operating-note">Weekly transactions itemize household spending. Transfers already made count once. Weekly's balance and overdraft are excluded. This estimate grants no spending or transfer permission.</p>
        <p class="operating-note">Balance After Deductions below remains this period's income after assigned bills and the household hold. It measures period income, separately from this Bills balance.</p>
        <button type="button" class="budget-surface-link" data-bills-closing-close>Close details</button>
      </div>
    </details>
  </section>`;
}

function budgetSurfaceParts() {
  return {
    planUnavailable: ctx => liveOperatingPlanUnavailable(ctx.advice || {}, ctx.liveOverlay),
    unavailableHtml: ctx => unavailableOperatingSurfaceHtml(ctx) + billsAccountPeriodBalanceHtml(ctx) + budgetOutgoingETransfersUnavailableHtml(ctx),
    granularity: () => budgetGranularity,
      granularityToggleHtml: () => budgetGranularityToggleHtml(),
      headerHtml: ctx => budgetWindowHeaderHtml(ctx),
      detailSheetHtml: () => budgetDetailSheetHtml(),
    inDrilldown: () => budgetInPayPeriodDrilldown(),
    todayHtml: ctx => budgetTodayCashCardHtml(ctx) + billsAccountPeriodBalanceHtml(ctx),
    periodHtml: ctx => budgetPayPeriodContentHtml(Object.assign({}, ctx, { budgetCompactOverview: true })),
    cardMovementsHtml: ctx => budgetCardMovementsHtml(ctx),
    browseHtml: ctx => budgetBrowseSectionsHtml(ctx),
    monthHtml: ctx => budgetMonthSurfaceHtml(ctx),
    fundingHtml: ctx => budgetUpcomingFundingHtml(ctx),
    selectedMonthLabel: () => (budgetSelectedMonth && budgetMonthName(budgetSelectedMonth)) || null,
    drilldownHtml: ctx => budgetPayPeriodDrilldownHtml(ctx),
  };
}

function budgetCardMovementsHtml(ctx) {
  if (typeof BudgetCardMovements === 'undefined' || typeof Forecast.cardPeriodMovements !== 'function') return '';
  const period = payPeriodSelection(ctx.advice || {}, ctx.planPayPeriodId).period;
  const overlay = ctx.liveOverlay?.applied === true ? ctx.liveOverlay : null;
  const publication = Forecast.cardPeriodMovements(ctx.plan, ctx.debts, ctx.asOf,
    period ? { start: period.start, end: period.end } : null,
    { currentPeriodActuals: overlay?.currentPeriodActuals || null,
      cardPeriodBalanceEvidence: overlay?.cardPeriodBalanceEvidence || null, liveOverlay: overlay });
  return BudgetCardMovements.html(publication, { money: money2, date: fmtDate });
}

function budgetSurfaceHtml(ctx) {
  return BudgetSurface.html(ctx, budgetSurfaceParts());
}

function paydayAnswerHtml(ctx) {
  const advice = ctx.advice;
  const liveOverlay = ctx.liveOverlay || null;
  if (liveOperatingPlanUnavailable(advice, liveOverlay)) {
    return currentOperatingUnavailableHtml(advice, liveOverlay);
  }
  const plan = ctx.plan;
  const alloc = advice && advice.paydayAllocation;
  const action = (advice && advice.currentPeriodAction) || null;
  const mode = (action && action.mode) || 'payday';
  const spendable = alloc && alloc.available != null
    ? alloc.available
    : Forecast.startingCashAmount(plan);
  const near = (advice && advice.nearBoundary) || { items: [], payday: null };
  const recommended = ctx.recommended != null ? ctx.recommended : advice.weekly;
  const weekly = ctx.weekly != null ? ctx.weekly : advice.weekly;
  const capView = ctx.capView || weeklyCapView(advice, ctx.weeklyOverride);
  const asOf = ctx.asOf || (alloc && alloc.asOf);
  const paydayDate = (action && action.nextPayday)
    || near.payday
    || (alloc && alloc.payday)
    || null;
  const basisAsOf = alloc && alloc.cashBasis && alloc.cashBasis.asOf
    ? alloc.cashBasis.asOf
    : asOf;
  const overlayOn = !!(liveOverlay && liveOverlay.applied === true);
  const periodEndLabel = paydayDate
    ? fmtDateLong(paydayDate)
    : (basisAsOf ? fmtDateLong(basisAsOf) : '');
  const periodLine = !basisAsOf
    ? 'Planning span is not available on this opening.'
    : overlayOn
      ? `Live as at ${fmtDateLong(basisAsOf)} → ${periodEndLabel}`
      : `As at ${fmtDateLong(basisAsOf)} → ${periodEndLabel}`;
  const coverageNote = paydayCoverageNote(action);
  const remainingClaim = action && action.remainingClaim;
  const categoryClaim = action && action.categoryRemainingClaim;
  const hasRemaining = remainingClaim === 'precise' || remainingClaim === 'posted-only';
  const remainingLabel = !hasRemaining
    ? 'Period need'
    : (categoryClaim === 'classified-incomplete' ? 'Observed remaining' : 'Remaining');
  const coverageClass = remainingClaim === 'unavailable' || !action
    ? 'payday-status warn'
    : 'payday-status';
  const unclassifiedNote = action && action.unclassified && Number(action.unclassified.count) > 0
    ? `<p class="payday-qual">${action.unclassified.count} transaction${
        action.unclassified.count === 1 ? '' : 's'
      } could not be classified and ${
        hasRemaining
          ? `are counted as uncategorised (${money2(
              (Number(action.unclassified.posted) || 0) + (Number(action.unclassified.pending) || 0)
            )})`
          : 'were not guessed into a spending category'
      }.</p>`
    : '';

  const obligationItems = (alloc && alloc.obligations && alloc.obligations.items) || [];
  const essentialItems = (alloc && alloc.essentials && alloc.essentials.items) || [];
  const otherRows = paydayOtherActionRows(ctx);
  const comingRows = paydayComingRows(ctx);
  const unresolvedCount = ((alloc && alloc.unresolved) || [])
    .filter(r => r && r.flexibility !== 'optional').length;
  const unresolvedNote = unresolvedCount
    ? '<p class="payday-qual">Required future costs with no exact date stay unresolved — this payday assigns them no contribution.</p>'
    : '';

  const spendInner = liveOperatingPlanUnavailable(advice, liveOverlay)
    ? `<p class="payday-refuse" data-operating-plan="unavailable" data-spend-decision="unavailable">${
        liveOperatingPlanNote(advice, liveOverlay)
      }</p>`
    : !capView.hasFeasibleCap
    ? `<p class="payday-refuse">${capView.infeasible ? '<b>INFEASIBLE. </b>' : ''}${capView.reason}</p>`
    : `<p class="payday-hero">${money(recommended)}<span class="payday-hero-unit">/ week</span></p>
       <p class="payday-qual">Stay under this and the protected plan holds. This is the spending permission, not the essential cash reserve.${
         weekly !== recommended ? ` ${capView.settingLine}` : ''
       }</p>`;

  const riskRows = ((advice && advice.paydayAllocation && advice.paydayAllocation.risks) || [])
    .filter(r => r && (r.verdict === 'FUNDING GAP' || Number(r.shortfall) > 0));
  const riskSheet = paydaySheet(
    ['Risk', 'Gap'],
    'payday-risk',
    riskRows,
    r => `<td>${r.label}${r.date ? ` <span class="payday-when">${fmtDate(r.date)}</span>` : ''}</td>
      <td>${money2(r.shortfall)}</td>`);

  if (mode === 'between-paydays') {
    const bills = (action && action.bills) || [];
    const done = bills.filter(b => b.settlement === 'represented');
    const verify = bills.filter(b => b.settlement === 'unverified');
    const due = bills.filter(b => b.settlement === 'upcoming');
    const doneSheet = paydaySheet(
      ['Already done', ''],
      'payday-done',
      done,
      r => `<td><div>✓ ${r.label}</div><div class="payday-item-note">${paydayBillStatusNote(r)}</div></td>
        <td>${money2(r.planned)}</td>`);
    const verifySheet = paydaySheet(
      ['Verify', 'Reserved'],
      'payday-obligation',
      verify,
      r => `<td><div>? ${r.label}</div><div class="payday-item-note">${paydayBillStatusNote(r)}</div></td>
        <td>${money2(r.remaining)}</td>`);
    const dueSheet = paydaySheet(
      ['Still due', 'Amount'],
      'payday-obligation',
      due,
      r => `<td><div>${r.label}</div><div class="payday-item-note">${paydayBillStatusNote(r)}</div></td>
        <td>${paydayAmountCell(r.remaining, r.confidence)}</td>`);
    const spendCats = ((action && action.categories) || [])
      .filter(c => c && c.class === 'essential' && (
        Number(c.planned) > 0 || Number(c.remaining) !== 0 || Number(c.posted) > 0
      ));
    const spendSheet = hasRemaining
      ? paydaySheet(
        ['Category', remainingLabel],
        'payday-essential',
        spendCats,
        r => `<td>${r.label}${
          r.posted != null
            ? `<div class="payday-item-note">Posted ${money2(r.posted)}${
                Number(r.pending) > 0 ? ` · pending ${money2(r.pending)}` : ''
              } of ${money2(r.planned)} planned</div>`
            : ''
        }${r.overage > 0 ? `<div class="payday-item-note">Overage ${money2(r.overage)}</div>` : ''}
        </td><td>${r.remaining != null ? money2(r.remaining) : '—'}</td>`)
      : paydaySheet(
        ['Category', remainingLabel],
        'payday-essential',
        essentialItems.filter(r => r && Number(r.required) > 0),
        r => `<td>${r.label}</td><td>${money2(r.required)}</td>`);
    const essentialTotal = hasRemaining && action.essentialRemaining != null
      ? `<p class="payday-qual">Total essential room remaining: ${money2(action.essentialRemaining)}${
          categoryClaim === 'classified-incomplete'
            ? ' — observed; uncategorised spending outstanding'
            : ''
        }</p>`
      : '';
    const unclassified = unclassifiedNote;
    const movement = action && action.noMovementToday
      ? '<p class="payday-action-empty">No money movement is required today.</p>'
      : '';
    const nextPoint = paydayDate
      ? `<div class="payday-group">Next decision point</div>
         <p class="payday-qual">${fmtDateLong(paydayDate)} payday</p>`
      : '';
    const shortfall = action && action.currentShortfall
      ? '<p class="payday-status warn">Current-period action is constrained. This is not the 90-day outlook.</p>'
      : '';
    return `<p class="payday-span">${periodLine}</p>
      <p class="${coverageClass}">${coverageNote}</p>
      ${shortfall}
      <div class="payday-list">
        <div class="payday-group">What to do now</div>
        ${movement}
        ${doneSheet}
        ${verifySheet}
        ${dueSheet}
        <div class="payday-group">Everyday spending left</div>
        ${spendSheet}${essentialTotal}${unclassified}
        ${!hasRemaining ? `<p class="payday-qual">${coverageNote}</p>` : ''}
        <div class="payday-group">Household spending permission</div>
        <div class="payday-spend">${spendInner}</div>
        ${nextPoint}
        ${riskSheet ? `<div class="payday-group">Funding risks</div>${riskSheet}` : ''}
      </div>`;
  }

  const obligationSheet = paydaySheet(
    ['Bill', 'Amount'],
    'payday-obligation',
    obligationItems.filter(r => r && Number(r.amount) > 0),
    r => `<td><div>${r.label}</div>${
      paydayObligationNote(r, asOf)
        ? `<div class="payday-item-note">${paydayObligationNote(r, asOf)}</div>`
        : ''
    }</td><td>${paydayAmountCell(r.amount, r.confidence)}</td>`);
  const billsReserved = alloc && alloc.obligations ? alloc.obligations.allocated : 0;
  const billsWanted = alloc && alloc.obligations ? alloc.obligations.wanted : 0;
  const billsShort = alloc && alloc.obligations ? alloc.obligations.shortfall : 0;
  const billsAttribution = alloc && alloc.obligations
    ? alloc.obligations.fundingAttribution
    : null;
  const billsTotal = obligationItems.length
    ? `<p class="payday-qual">Bills currently reserved: ${money2(billsReserved)}${
        billsShort > 0 ? ` · shortfall ${money2(billsShort)} of ${money2(billsWanted)} required` : ''
      }</p>${
        billsAttribution === 'unattributed'
          ? '<p class="payday-qual">Atlas does not choose which required bill is underfunded.</p>'
          : ''
      }`
    : '';

  const essentialSheet = paydaySheet(
    ['Category', remainingLabel],
    'payday-essential',
    essentialItems.filter(r => r && (
      Number(r.required) > 0 || Number(r.remaining) < 0 || Number(r.planned) > 0
    )),
    r => `<td>${r.label}${
      r.source ? `<div class="payday-item-note">${
        r.source === 'owner-target' ? 'Owner target'
          : r.source === 'current-regime' ? 'Current-regime'
            : r.source === 'historical-actual' ? 'Historical actual'
              : r.source
      } · ${money2(r.monthly)}/month</div>` : ''
    }${
      hasRemaining && r.posted != null
        ? `<div class="payday-item-note">Posted ${money2(r.posted)}${
            Number(r.pending) > 0 ? ` · pending ${money2(r.pending)}` : ''
          }</div>`
        : ''
    }</td><td>${money2(hasRemaining && r.remaining != null ? r.remaining : r.required)}</td>`);
  const ess = alloc && alloc.essentials;
  let essentialSummary = '';
  if (ess && (Number(ess.wanted) > 0 || essentialItems.length)) {
    const short = Number(ess.shortfall) || 0;
    const attributed = ess.fundingAttribution;
    essentialSummary = `<p class="payday-qual">Required for period: ${money2(ess.wanted)}</p>
      <p class="payday-qual">Cash available for essentials: ${money2(ess.allocated)}</p>${
        short > 0
          ? `<p class="payday-qual">Essential shortfall: ${money2(short)}. This is not the full amount needed, and it is not a spending allowance.</p>`
          : ''
      }${
        attributed === 'unattributed'
          ? '<p class="payday-qual">Atlas does not choose which essential category is underfunded.</p>'
          : ''
      }`;
  }
  const periodEnd = alloc && alloc.periodEnd;
  const periodStart = alloc && (
    (hasRemaining && alloc.planPeriodStart) || alloc.periodStart || alloc.asOf || asOf
  );
  const essentialHeading = periodStart && periodEnd
    ? `Essential costs from ${fmtDate(periodStart)} through ${fmtDate(periodEnd)}`
    : periodEnd
      ? `Essential costs through ${fmtDate(periodEnd)}`
      : 'Essential costs until next payday';

  const otherSheet = paydaySheet(
    ['Action', 'Amount'],
    'payday-action',
    otherRows,
    r => `<td>${r.label}</td><td>${r.amount != null ? money2(r.amount) : '—'}</td>`);

  const comingSheet = paydaySheet(
    null,
    'payday-coming-row',
    comingRows,
    r => `<td>${r.label}${r.date ? ` <span class="payday-when">${fmtDate(r.date)}</span>` : ''}</td>
      <td>${money2(r.amount)}</td>`);

  const billsBlock = obligationSheet
    ? `<div class="payday-group">Bills / required payments</div>${obligationSheet}${billsTotal}`
    : '';
  const essentialsBlock = (essentialSheet || essentialSummary)
    ? `<div class="payday-group">${essentialHeading}</div>${essentialSheet}${essentialSummary}`
    : '';
  const otherBlock = otherSheet
    ? `<div class="payday-group">What else this paycheque funds</div>${otherSheet}`
    : '';

  return `<p class="payday-span">${periodLine}</p>
    <p class="${coverageClass}">${coverageNote}</p>
    <div class="payday-list">
      <div class="payday-group">Money available</div>
      <p class="payday-hero" data-fig="spendable">${money2(spendable)}</p>
      <p class="payday-qual">${paydayCashNote(alloc, ctx.liveOverlay)}</p>
      <div class="payday-group">What to do with this paycheque</div>
      ${billsBlock}
      ${essentialsBlock}
      ${unclassifiedNote}
      ${otherBlock}
      ${unresolvedNote}
      <div class="payday-group">Household spending permission</div>
      <div class="payday-spend">${spendInner}</div>
      ${comingSheet ? `<div class="payday-group">Coming before next payday</div>${comingSheet}` : ''}
      ${riskSheet ? `<div class="payday-group">Funding risks</div>${riskSheet}` : ''}
    </div>`;
}

/* ----------------------------------------------------------- rendering */
// Current planning copy follows Forecast's chequing-only spendable scope.
// Keep the stored dated observations and external-account evidence unchanged.
function currentCashScopeNote(note) {
  return String(note || '').replace(/Chequing A, Chequing B and Savings/g,
    'Chequing A and Chequing B (designated Savings is reserve evidence, excluded from spendable cash)');
}

function renderBalanceHistory(history) {
  const mount = $('balance-history');
  if (!mount) return;
  if (typeof BalanceHistory === 'undefined' || !BalanceHistory.render) {
    mount.textContent = 'Balance history could not be loaded.';
    return;
  }
  if (!history || !Array.isArray(history.snapshots)) {
    mount.innerHTML = '<p class="lede">Dated openings are not available on this load.</p>';
    return;
  }
  mount.innerHTML = BalanceHistory.render(history);
}

/* ATLAS-080: the configured-unavailable render. Every mount the
 * full render would fill with a settlement-dependent figure is
 * overwritten with one fixed withheld notice (or emptied), so no
 * dependent figure survives — including on a re-render over a page
 * that previously showed them (no stale fallback). The only figures
 * still published are the reported debt stocks on the snapshot
 * tiles, which are Forecast stock readings of the debt records
 * themselves and do not depend on settlement evidence.
 *
 * B4 containment invariant: index.html places the structural mounts
 * (#status-band, #plan-window, #c-forecast, #snapshot-tiles and the
 * section containers) INSIDE #road-ahead, so #road-ahead itself must
 * never be emptied — clearing it would delete the mounts this render
 * publishes into and the mounts the next normal render writes
 * unconditionally, making same-instance recovery impossible. Only
 * dependent LEAF publications are cleared, each by its own id —
 * including the chart mount, whose SVG aria-label carries dependent
 * figures. Static controls inside the section (scenario presets,
 * calendar legend, budget inputs) are not publications and stay. */
function renderPlanSettlementUnavailable(d, reason) {
  const notice = `<div class="note-box crit" data-settlement-evidence="unavailable" data-settlement-reason="${reason}">Settlement evidence is unavailable (${reason}). Savings, funding, cap and transfer figures that depend on settlement evidence are withheld rather than shown as if no settlement existed.</div>`;
  const setHtml = (id, html) => { const node = $(id); if (node) node.innerHTML = html; };
  const setText = (id, text) => { const node = $(id); if (node) node.textContent = text; };

  // ATLAS-080 repair (B2): externally moved dependent content. The
  // normal render's wiring moves the attention card OUT of the
  // operating mount into #budget-attention-bottom, so replacing the
  // mount's HTML cannot reach it — the card would survive with its
  // Forecast figures and bill actions under an unavailable page.
  // Mirror budgetRemount's teardown: clear the external mount and
  // notify presentation controllers that retained nodes must drop.
  const attentionBottom = document.getElementById('budget-attention-bottom');
  if (attentionBottom && typeof attentionBottom.replaceChildren === 'function') {
    attentionBottom.replaceChildren();
  }
  const operatingMountEl = $('operating-surface-body');
  if (operatingMountEl && typeof operatingMountEl.dispatchEvent === 'function') {
    operatingMountEl.dispatchEvent(new Event('budget-before-remount'));
  }

  setText('plan-window', 'Settlement evidence unavailable — the plan is withheld.');

  const band = $('status-band');
  if (band) {
    band.setAttribute('data-plan-status', 'unavailable');
    if (band.dataset) band.dataset.planStatus = 'unavailable';
    band.className = 'statusband warn';
    band.innerHTML = `<b>Plan unavailable.</b> ${notice}`;
  }

  const fund = $('funding');
  if (fund) fund.hidden = true;
  for (const id of ['funding-head', 'funding-lede', 'funding-options', 'funding-note',
    'hero-tiles', 'hero-ledger', 'cap-headline', 'cap-split', 'cap-basis',
    'major-plans-list', 'agenda-14', 'score-table', 'score-cards', 'phases',
    'priorities-ledger', 'risk-list', 'assumption-list', 'nextmove-card',
    'plan-mission', 'wk-table', 'wk-cards', 'budget-out', 'budget-cats',
    'actions-list', 'cal-agenda', 'cal-months', 'balance-history',
    'c-forecast', 'forecast-caption']) {
    setHtml(id, '');
  }
  for (const id of ['hero-note', 'major-plans-note', 'agenda-14-note', 'score-note',
    'priorities-note', 'cal-note', 'budget-basis', 'budget-cats-note', 'actions-note']) {
    setText(id, '');
  }
  setHtml('savings-inventory', notice);
  setHtml('operating-surface-body', notice);
  setHtml('payday-answer-body', notice);
  const transferNote = $('transfer-note');
  if (transferNote) { transferNote.innerHTML = ''; transferNote.hidden = true; }

  // Reported debt stocks — independent of settlement evidence, still
  // published with their existing labels. Every figure here is a
  // Forecast stock reading (compactSnapshot / utilisation / the
  // debt walk's opening mark); the page computes none of them.
  const plan = d.plan;
  const asOf = d.meta.asOf;
  const snap = Forecast.compactSnapshot(d.debts, d.helocHistory);
  const revolving = Forecast.utilisation(d.debts, d.revolvingExtra, plan).totalAvailable;
  let consumer = null;
  try {
    const opening = planDebtProjection(plan, d.debts, asOf, {
      extraFacilities: d.revolvingExtra,
    });
    if (opening && Array.isArray(opening.marks) && opening.marks[0]) {
      consumer = opening.marks[0].consumer;
    }
  } catch { consumer = null; }
  const helocTrend = snap.heloc ? HELOC_TREND[snap.heloc.id] : null;
  setHtml('snapshot-tiles', [
    { lab: 'Consumer debt', val: consumer == null ? 'unavailable' : money(consumer), note: 'cards and revolving, excluding the house' },
    { lab: 'Mortgage + HELOC', val: money(snap.secured), note: 'secured on the home' },
    { lab: 'Interest cost / month', val: money(snap.monthlyInterest), note: 'across every debt, at current rates' },
    { lab: 'Credit left, everywhere', val: money(revolving), note: 'across all revolving facilities combined' },
    ...(helocTrend ? [{ lab: 'HELOC vs last month',
      val: helocTrend.sign + money(Math.abs(snap.heloc.delta)).slice(1),
      note: helocTrend.note }] : []),
  ].map(t => `
    <div class="tile small">
      <div class="lab">${t.lab}</div><div class="val">${t.val}</div><div class="note">${t.note}</div>
    </div>`).join(''));
}

function renderPlan(d, periods, history) {
  // ATLAS-080: normalize the served settlement outcome before any
  // figure is produced. Qualified threads the verified evidence
  // through simOpts for the whole render; unavailable short-circuits
  // to the withheld render above.
  const settlement = planSettlementOutcome(d);
  planSettlementEvidence = settlement.kind === 'qualified' ? settlement.evidence : null;
  if (settlement.kind === 'unavailable') {
    renderPlanSettlementUnavailable(d, settlement.reason);
    return;
  }
  const plan = d.plan;
  const asOf = d.meta.asOf;

  // ONE call, ONE answer. The weekly household cap, the simulation behind it
  // and the opening-gap analysis all come from the same engine result, so the
  // headline figure and the budget breakdown below cannot disagree — they
  // used to, showing $1,650/wk at the top and $0/wk in the budget block.
  // Which source covers the opening gap decides whether it costs anything.
  // The top-ranked usable option wins by default — Amanda releasing money the
  // household already owns, which creates no debt. A HELOC draw would, and the
  // projection has to see that rather than silently modelling the free path.
  // Two passes, because the gap has to be known before a source can be judged
  // against it. The size of the gap does not depend on who funds it, so the
  // first pass is safe to run with no source at all.
  // The engine allocates the gap across the ranked sources and tells us what
  // that costs. Choosing a single source here and passing only its debtId
  // modelled the whole gap as debt-free even when no source could reach it.
  const actuals = d.liveOverlay && d.liveOverlay.applied === true
    ? d.liveOverlay.currentPeriodActuals
    : null;
  const advice = Forecast.recommend(plan, asOf, simOpts({
    fundingSources: plan.funding && plan.funding.options,
    periods,
    currentPeriodActuals: actuals,
    // PA-5 (#775): the incumbent Forecast call gets the same effective verdict
    // as the presentation, so a cold failed refresh is never shown unavailable
    // while Forecast was told 'dated-opening'. Forecast stays the calculator.
    operatingPlan: d.liveOverlay && (liveOperatingPlanUnavailable(null, d.liveOverlay)
      ? 'unavailable' : d.liveOverlay.operatingPlan),
    observedCash: d.liveOverlay && d.liveOverlay.observedCash,
    operatingPlanNote: d.liveOverlay && d.liveOverlay.operatingPlanNote,
  }));
  const fundingPlan = advice.funding || null;
  const inventoryMount = $('savings-inventory');
  if (inventoryMount && typeof SavingsInventory !== 'undefined') inventoryMount.innerHTML = SavingsInventory.html(advice.savingsFunding || (d.plan.savingsEarmarks?.allocationPolicy == null ? advice.savingsInventory : null), { asOf: d.meta.asOf, advice, plan: d.plan });
  const recommended = advice.weekly;
  const capView = weeklyCapView(advice, state.weeklyVariable);
  const weekly = capView.weekly;
  // The plan being drawn is the recovery path: gap covered, spending from the
  // first payday. Overriding the weekly figure re-simulates on those same
  // assumptions rather than inventing a second set.
  const sim = weekly === recommended ? advice.sim
    : Forecast.simulate(plan, asOf, Object.assign({}, advice.simOptions, { weeklyVariable: weekly }));
  const gap = advice.gap;                 // null when there is no opening gap
  const zeroSim = advice.zero;            // the unfunded window — the problem
  const fundingGap = gap ? gap.amount : 0;

  // The engine owns the counterfactual deadline. The page only renders the
  // amount and date it is given; it no longer runs a second simulation or
  // decides which short day becomes a household deadline.
  const transferDependency = Forecast.amandaHouseholdIncomeDeadline(plan, asOf,
    Object.assign({}, advice.simOptions, {
      weeklyVariable: weekly,
      incomeOverrides: state.incomeOverrides,
      notBefore: gap ? gap.date : asOf,
    }));
  const transferMonthly = transferDependency.amount;
  const neededBy = transferDependency.neededBy;

  const knowledgeEnd = advice.knowledge && advice.knowledge.end
    ? advice.knowledge.end : sim.end;
  $('plan-window').textContent =
    `The ${sim.weeks.length}-week view from ${fmtDateLong(asOf)} to ${fmtDateLong(sim.end)} of the master plan through ${fmtDateLong(knowledgeEnd)}. The weekly cap is set from the full plan, not this window alone.`;

  /* ---- status band ---- */
  // WHICH of the eight verdicts the household reads, and every figure and date
  // inside it, is a financial decision and belongs to Forecast.planStatus —
  // where the node suite can reach it. This page looks the wording up and
  // renders it. It no longer re-derives `fundingShort`, hand-copies the
  // engine's buffer comparison and epsilon, walks the daily balances for a
  // first-breach or first-negative date, or totals the funding parts.
  const planUnavailable = liveOperatingPlanUnavailable(advice, d.liveOverlay);
  const unavailableNote = liveOperatingPlanNote(advice, d.liveOverlay);
  const band = $('status-band');
  const status = planUnavailable
    ? null
    : Forecast.planStatus(advice, { weeklyOverride: state.weeklyVariable, sim });
  // Print-only hook: data-plan-status (dataset.planStatus) is the engine's
  // verdict id, or 'unavailable' on the live-unavailable path. It is set on
  // every paint so a stale value cannot survive a re-render. Text and class
  // are unchanged.
  band.setAttribute('data-plan-status', planUnavailable ? 'unavailable' : status.id);
  if (planUnavailable) {
    band.className = 'statusband warn';
    band.innerHTML = `<b>Current plan unavailable.</b> ${unavailableNote}`;
  } else {
    band.className = 'statusband ' + STATUS_BAND[status.id].tone;
    band.innerHTML = STATUS_BAND[status.id].text(status, plan);
  }

  /* ---- covering the gap ---- */
  // Only shown when there is one. The point is not "here are your options" but
  // "here is what can actually cover it" — a source that cannot reach the
  // amount needed on the day is not an option, and is shown struck out.
  const fund = $('funding');
  if (gap && plan.funding && !planUnavailable) {
    // What must be in the account on the worst day, not the gap to the buffer.
    const shortDate = gap.date;
    const dueThatDay = gap.dueOnGapDay;
    // Judge each source against the GAP, not against the day's payment. The
    // gap includes restoring the buffer, so at a raised buffer a source can
    // clear the $623 due and still not close the hole — which is how these
    // cards came to read "Covers it" beside a band saying nothing could.
    const needed = fundingGap;
    const group = (plan.groups || []).find(g =>
      zeroSim.events.some(e => e.date === shortDate && (plan.commitments.find(c => c.id === e.id) || {}).group === g.id));

    fund.hidden = false;
    $('funding-head').textContent = plan.funding.heading;
    $('funding-lede').innerHTML =
      `<b>${money2(dueThatDay)} has to be in the account on ${fmtDateLong(shortDate)}</b>, against the
       ${money2(Forecast.startingCashAmount(plan))} the household accounts hold. Restoring the
       ${money(sim.buffer)} buffer as well makes the amount to find <b>${money2(needed)}</b>, and that is
       what each source below is measured against.` +
      (group && group.atomic ? ` ${group.note}` : '');

    // The engine ranked the sources and judged each one against the gap, as
    // part of the same allocation the plan is built on. The page joins each
    // verdict back to its own label, rate and note — copy that lives in
    // data.json — and renders. It decides nothing: no comparison against the
    // amount needed, no per-source shortfall arithmetic, no second sort.
    const copyFor = new Map(plan.funding.options.map(o => [o.id, o]));
    $('funding-options').innerHTML = fundingPlan.sources
      .map(s => {
        const o = copyFor.get(s.id);
        const verdict = FUND_VERDICT[s.verdict];
        return `<div class="fund ${verdict.cls}">
          <div class="fund-top">
            <span class="fund-lab">${o.label}</span>
            <span class="fund-amt">${money2(s.available)}${o.rate ? ` <span class="mutedtext">at ${pct(o.rate)}</span>` : ''}</span>
          </div>
          <div class="fund-verdict">${verdict.text(s, needed)}</div>
          <p class="fund-note">${o.note}</p>
        </div>`;
      }).join('');
    $('funding-note').textContent = plan.funding.note;
  } else {
    fund.hidden = true;
  }

  /* ---- the Amanda salary deadline ---- */
  const tn = $('transfer-note');
  tn.hidden = false;
  tn.innerHTML = currentOperatingTransferNoteHtml(
    advice, d.liveOverlay, transferMonthly, neededBy);

  /* ---- cash and debt, walked together ---- */
  // The same event stream that moves the cash moves the balances. A minimum
  // that leaves the chequing account has to arrive on a card.
  const debtProj = planDebtProjection(plan, d.debts, asOf,
    Object.assign({}, advice.simOptions, { weeklyVariable: weekly,
      extraFacilities: d.revolvingExtra }));

  // The alternative assumptions, decided and evaluated by the engine. This page
  // used to build both: a funding source holding `available: Infinity` for "if
  // the gap were covered", and `fundingDebtId: 'heloc'` plus its own second
  // `recommend` and `projectDebts` for the HELOC fallback. It now asks once and
  // renders what comes back. It does not choose a source, name a facility,
  // restate the scenario, or decide whether either answer is worth showing.
  // Only an explicitly hidden root suppresses diagnostics. An absent root
  // preserves the existing diagnostic render path.
  const diagnosticsVisible = $('road-ahead')?.hidden !== true;
  const alternatives = diagnosticsVisible ? Forecast.counterfactuals(plan, asOf, advice, debtProj, {
    debts: d.debts, extraFacilities: d.revolvingExtra, weekly }) : null;
  const ifCovered = alternatives?.fullGapCoverage;

  const cashOn = date => {
    const p = sim.daily.find(x => x.date === date);
    return p ? p.balance : Forecast.startingCashAmount(plan);
  };
  const mark = n => debtProj.marks.find(m => m.day === n) || debtProj.marks[debtProj.marks.length - 1];
  const today = mark(0);

  // The engine owns every weekly↔monthly conversion and the cap-versus-need
  // conclusion. It is told which weekly figure is actually on screen — the
  // household's own setting when there is one, the recommendation otherwise —
  // because measuring the budget against a figure the page is not showing
  // describes a plan nobody is looking at. This page divides nothing.
  const budget = Forecast.budgetBreakdown(plan, periods, {
    paypalPerMonth: d.paypal ? d.paypal.perMonth : 0,
    disabled: state.disabled,
    weeklyCap: weekly,
    recommendedWeekly: recommended,
    asOf,
  });
  const cap = budget ? budget.cap : null;
  const capMonthly = Forecast.monthlyFromWeekly(weekly);

  // A missing cap is not a zero or an unfunded-gap verdict. Refresh active
  // cap mounts; the diagnostic headline obeys its explicit visibility gate.
  if (!budget || !cap || capView.permissionUnavailable) {
    const reason = capView.reason || 'The weekly cap split is unavailable.';
    for (const id of ['cap-headline', 'cap-split', 'cap-basis', 'budget-out', 'budget-basis']) {
      if (id === 'cap-headline' && !diagnosticsVisible) continue;
      const node = $(id);
      if (node) { node.innerHTML = ''; node.textContent = reason; }
    }
  }

  /* ---- the mission, in one sentence ---- */
  // WHICH instructions apply, and in what order, is a financial decision and
  // belongs to Forecast.mission — where the node suite can reach it. This page
  // renders the parts it is given, in the order it is given them.
  const missionResult = planUnavailable
    ? { parts: [] }
    : Forecast.mission(advice, debtProj,
      { weeklyOverride: state.weeklyVariable, sim });
  $('plan-mission').textContent = planUnavailable
    ? unavailableNote
    : missionResult.status === 'unavailable' ? missionResult.reason
    : missionResult.parts
      .map(p => MISSION_PART[p.id](p)).join(', ')
      .replace(/^./, c => c.toUpperCase()) + '.';

  /* ---- NEXT MOVE — the one thing to do ---- */
  // WHICH of the five outcomes the household reads under "What happens after",
  // and every figure inside it, is a financial decision and belongs to
  // Forecast.nextMove — where the node suite can reach it. This page looks the
  // wording up and renders it. It no longer compares the action's fixed amount
  // against the current gap with its own copy of the engine's half-cent,
  // subtracts the two for the uncovered remainder, or selects a different
  // outcome from the status verdict, the due date or the funding plan.
  const move = planUnavailable
    ? null
    : Forecast.nextMove(plan, advice,
      { weeklyOverride: state.weeklyVariable, sim, debts: state.debts,
        extraFacilities: state.extraFacilities });
  if (planUnavailable || move?.id === 'unavailable') {
    // Forecast's unavailable outcome has no action to head the card; say why.
    const nextmoveCard = $('nextmove-card');
    if (nextmoveCard) {
      nextmoveCard.innerHTML = `<p class="operating-lead" data-operating-plan="unavailable">${planUnavailable ? unavailableNote : move.reason}</p>`;
    }
  } else if (move) {
    // The action the engine measured, so the head and the outcome below it
    // cannot describe different actions.
    const first = move.action;
    // Presentation: which of two chip colours the due date wears. It moves no
    // figure and selects no sentence.
    const overdue = first.due && first.due < asOf && first.status !== 'done';
    const after = NEXT_MOVE[move.id](move);
    $('nextmove-card').innerHTML = `
      <div class="nm-head">
        <span class="nm-what">${first.what}</span>
        <span class="nm-amt">${first.amount != null ? money2(first.amount) : ''}</span>
      </div>
      <div class="nm-meta">
        ${first.due ? `<span class="chip ${overdue ? 'c' : 'w'}">due ${fmtDateLong(first.due)}</span>` : ''}
        ${first.owner ? `<span class="chip">${first.owner}</span>` : ''}
        <span class="chip ${first.status === 'done' ? 'v' : 'e'}">${first.status}</span>
      </div>
      <div class="nm-why"><b>Why</b><p>${first.why}</p></div>
      <div class="nm-after"><b>What happens after</b><p>${after}</p></div>`;
  }

  // The condition attached to the weekly cap, written ONCE. It appeared on
  // both the Today tile and the cap headline, and fixing the headline alone
  // left the tile describing a simulation that was not the one it showed.
  const capQualifier = !diagnosticsVisible ? '' : !gap
    ? 'under the expected scenario'
    : ifCovered && ifCovered.applies
      ? `from ${fmtDateLong(advice.effectiveFrom)}, with only `
        + `${money(ifCovered.fundable)} of the ${money(ifCovered.gapAmount)} gap fundable. `
        + `Cover the whole gap and it becomes ${money(ifCovered.weekly)}/week`
      : `from ${fmtDateLong(advice.effectiveFrom)}, once the ${money(fundingGap)} gap is covered`;

  /* ---- the numbers that matter today ---- */
  // WHICH day cash leaves next, and the total that has to be there, is a
  // financial decision and belongs to Forecast.nextPaymentOut — where the
  // node suite can reach it. This page prints the date, the amount and the
  // label it is given. The 3-day chip is presentation: it moves no figure
  // and selects no day.
  const nextOut = Forecast.nextPaymentOut(sim.events, asOf);
  if (diagnosticsVisible) $('hero-tiles').innerHTML = [
    ...currentOperatingCashHeroTiles(plan, asOf, sim, advice, d.liveOverlay),
    (planUnavailable
      ? { lab: 'Weekly household cap', val: 'unavailable', tone: 'alert',
          note: unavailableNote }
      : capView.hasFeasibleCap
      ? { lab: 'Weekly household cap', val: money(weekly) + '/wk', tone: gap ? 'warn' : '',
          note: state.weeklyVariable != null && state.weeklyVariable !== recommended
            ? `your setting — the forecast supports ${money(recommended)}/wk`
            : gap
              ? `${capQualifier}. Food and fuel come out of this first.`
              : `≈ ${money(capMonthly)} a month. Food and fuel come out of this first.` }
      : { lab: 'Weekly household cap', val: 'unavailable', tone: 'alert',
          note: [capView.settingLine, capView.reason, ifCovered && ifCovered.applies ? capQualifier : '']
            .filter(Boolean).join(' ') }),
    { lab: 'Essential variable need', val: planUnavailable || !cap
      ? 'unavailable'
      : money(cap.essentialWeekly) + '/wk', tone: '',
      note: planUnavailable
        ? unavailableNote
        : !cap ? capView.reason || 'The weekly cap split is unavailable.'
        : `groceries, fuel, phones and medical — ${money(cap.foodFuelPlannedWeekly)}/wk of it food and fuel` },
    currentOperatingConsumerDebtHeroTile(advice, d.liveOverlay, today),
  ].filter(Boolean).map(t => `
    <div class="tile ${t.tone}">
      <div class="lab">${t.lab}</div>
      <div class="val">${t.val}</div>
      <div class="note">${t.note}</div>
    </div>`).join('');

  const row = (label, val, cls = '', chip = '') =>
    `<div class="ledger-row ${cls}"><span>${label}${chip}</span><span>${val}</span></div>`;
  const chipC = ' <span class="chip v">confirmed</span>';
  const chipE = ' <span class="chip w">estimated</span>';

  /* ---- the weekly household cap, broken into what it is actually for ---- */
  if (budget && cap && !capView.permissionUnavailable) {
    // Monthly grocery and fuel figures, and whether the grocery line is an
    // owner target, are Forecast.budgetBreakdown's cap block. This page prints
    // them. The per-week split beside them already came from that block.
    // When the gap can only be partly funded, this figure is the cap for THAT
    // situation — not for a covered gap. Saying "once the gap is covered"
    // beside it attached the condition of one simulation to the answer of
    // another, so the full-coverage figure is computed and shown separately.
    if (diagnosticsVisible) $('cap-headline').innerHTML = capView.hasFeasibleCap
      ? `<span class="cap-amt">${money(weekly)}</span><span class="cap-per">/ week</span>
       <span class="cap-qual">${capQualifier}</span>`
      : `<span class="cap-amt">unavailable</span>
       <span class="cap-qual">${[capView.settingLine, capView.reason, ifCovered && ifCovered.applies ? capQualifier : '']
         .filter(Boolean).join(' ')}</span>`;
    // Every amount here arrives per week from the engine. The page adds the
    // dollar sign and the /wk label and divides nothing.
    const part = (lab, weeklyAmount, kind, note) => `
      <div class="cap-part ${kind}">
        <div class="cap-part-lab">${lab}</div>
        <div class="cap-part-amt">${est(money(weeklyAmount))}<span>/wk</span></div>
        <div class="cap-part-note">${note}</div>
      </div>`;
    const capTotal = capView.hasFeasibleCap
      ? `<div class="cap-part total">
        <div class="cap-part-lab">Total</div>
        <div class="cap-part-amt">${money(weekly)}<span>/wk</span></div>
        <div class="cap-part-note">≈ ${money(cap.monthly)} a month</div>
      </div>`
      : `<div class="cap-part total">
        <div class="cap-part-lab">Total</div>
        <div class="cap-part-amt">unavailable</div>
        <div class="cap-part-note">No feasible weekly cap until the protected funding shortfall is solved.</div>
      </div>`;
    $('cap-split').innerHTML =
      part('Essential variable need', cap.essentialWeekly, 'essential',
        `Groceries ${money(cap.groceriesPlannedWeekly)}, fuel ${money(cap.fuelPlannedWeekly)}` +
        `${cap.groceriesHasOwnerTarget ? ' <span class="chip v">owner budget</span>' : ''}, plus phones, ` +
        `household supplies, medical and the uncategorised remainder. <b>This comes out first.</b>`) +
      (capView.hasFeasibleCap
        ? part('Discretionary room', cap.discretionaryRoomWeekly, 'optional',
          !cap.hasDiscretionaryRoom
            ? `<b class="neg">Nothing.</b> The cap is below what normal life costs.`
            : `Everything else — dining out, personal, subscriptions, sports and online spending. The household's ` +
              `own budget for those comes to ${money(cap.householdDiscretionaryWeekly)}/wk, ` +
              ROOM_VERSUS_HOUSEHOLD[cap.roomVersusHousehold.verdict](cap.roomVersusHousehold))
        : '') +
      capTotal;
    const owned = budget.ownerTargetCount;
    const ownedNames = budget.categories
      .filter(c => c.target != null)
      .map(c => String(c.ownerLine || c.label || '').toLowerCase())
      .filter(Boolean);
    const ownedList = ownedNames.length === 0 ? ''
      : ownedNames.length === 1 ? ownedNames[0]
      : ownedNames.length === 2 ? `${ownedNames[0]} and ${ownedNames[1]}`
      : `${ownedNames.slice(0, -1).join(', ')}, and ${ownedNames[ownedNames.length - 1]}`;
    $('cap-basis').innerHTML = capView.hasFeasibleCap
      ? `Solved from the forecast: the largest weekly spend that keeps every day at or above the ${money(sim.buffer)} ` +
      `buffer. The split below it uses the <b>household's own budget targets</b> for ${owned} categories` +
      (ownedList ? ` — ${ownedList}` : '') +
      ` — and ${budget.months} months of actual spending for the rest, with anything already dated on the calendar ` +
      `removed from its own category. <b>Food and fuel come out of this number first</b>: the household budgets ` +
      `${money(cap.groceriesMonthly)} and ${money(cap.fuelMonthly)} a month for them. ` +
      `The ${money(budget.sinkingMonthly)}/month of lacrosse fees is dated on the calendar and saved for separately, ` +
      `so it is not inside this cap and does not reduce the ordinary sports line.`
      : `No feasible weekly cap until the protected funding shortfall is solved. The essential line above is ` +
      `the household's own budget need, not a supported weekly spend. Food and fuel still have to be funded ` +
      `from somewhere: the household budgets ${money(cap.groceriesMonthly)} and ${money(cap.fuelMonthly)} a month for them.`;
  }

  /* ---- major future plans — verdicts from Forecast, wording only ---- */
  const major = planUnavailable
    ? []
    : Forecast.majorPlans(plan, asOf,
      Object.assign({}, advice.planOptions || {}, { weeklyVariable: weekly }));
  const majorAmount = p => {
    if (p.need != null) return money2(p.need);
    if (p.amountMin != null && p.amountMax != null) return `${money2(p.amountMin)}–${money2(p.amountMax)}`;
    if (p.amountMin != null) return `from ${money2(p.amountMin)}`;
    if (p.amountMax != null) return `up to ${money2(p.amountMax)}`;
    return 'range';
  };
  const majorMargin = p => p.margin == null ? ''
    : p.margin >= 0 ? ` Margin ${money2(p.margin)}.`
    : ` Gap ${money2(-p.margin)}.`;
  const MAJOR_VERDICT = {
    'ON TRACK': p => `<span class="chip v">ON TRACK</span> The authoritative path funds ${p.label}.${majorMargin(p)}`,
    'AT RISK': p => `<span class="chip w">AT RISK</span> The base case for ${p.label} remains feasible; the protected uncertainty case (the range ceiling) does not.${majorMargin(p)}`,
    'FUNDING GAP': p => `<span class="chip c">FUNDING GAP</span> The authoritative plan cannot fund ${p.label} on this path.${majorMargin(p)}`,
  };
  const majorHtml = (major || []).map(p => `
    <div class="fund">
      <div class="fund-top">
        <div class="fund-lab">${p.label}${p.date ? ` <span class="mutedtext">${fmtDate(p.date)}</span>` : ''}${p.deferred ? ' <span class="chip w">may move</span>' : ''}</div>
        <div class="fund-amt">${majorAmount(p)}</div>
      </div>
      <div class="fund-note">${MAJOR_VERDICT[p.verdict] ? MAJOR_VERDICT[p.verdict](p) : (p.verdict || '')}</div>
    </div>`).join('');
  $('major-plans-list').innerHTML = majorHtml || '<p class="lede">No unsettled major future plans on this opening.</p>';
  const knowledgeDays = advice.knowledge ? advice.knowledge.days : (plan.windowDays || 91);
  $('major-plans-note').textContent =
    `Verdicts are Forecast.majorPlans on the ${knowledgeDays}-day master plan. Ordinary transactions and categories are not individually graded. The $${sim.buffer} figure is the model buffer, not an owner-approved emergency reserve.`;

  /* ---- the next fourteen days ---- */
  const horizon = addDays(asOf, 13);
  const near = sim.events
    .filter(e => e.date >= asOf && e.date <= horizon && Math.abs(e.amount) >= 50)
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (b.amount > 0 ? 1 : 0) - (a.amount > 0 ? 1 : 0));
  $('agenda-14').innerHTML = near.length ? near.map(e => {
    const cardPaid = isCardPaidReserve(e);
    const external = isExternalObligation(e);
    const rowClass = external ? 'external' : (e.amount > 0 ? 'in' : 'out');
    const amtClass = external ? '' : (e.amount > 0 ? 'pos' : 'neg');
    const amt = external
      ? money(Math.abs(e.amount))
      : `${e.amount > 0 ? '+' : '−'}${money(Math.abs(e.amount)).slice(1)}`;
    const lab = cardPaid
      ? `${e.label} — card-paid reserve<br><span class="mutedtext">reduces projected joint cash</span>`
      : external
      ? `${e.label} — paid from ${externalPayerLabel(plan, e)}<br><span class="mutedtext">not joint-cash</span>`
      : e.label;
    return `
    <div class="ag14 ${rowClass}${e.date === (gap && gap.date) ? ' ag14-key' : ''}">
      <span class="ag14-date">${fmtDate(e.date)}</span>
      <span class="ag14-amt ${amtClass}">${amt}</span>
      <span class="ag14-lab">${lab}</span>
      <span class="ag14-conf"><span class="chip ${e.confidence === 'confirmed' ? 'v'
        : e.confidence === 'estimated' ? 'w' : ''}">${e.confidence}</span></span>
    </div>`;
  }).join('') : '<p class="lede">Nothing of $50 or more falls in the next fortnight.</p>';
  $('agenda-14-note').innerHTML =
    `Movements of $50 or more only. ${gap ? `The highlighted row is the day the gap has to be covered by. ` : ''}` +
    `The rest of the window is behind <b>View full 90-day calendar</b> below.`;

  /* ---- the 90-day scoreboard ---- */
  const scoreCols = debtProj.marks.filter(m => [0, 30, 60, 90].includes(m.day));
  const scoreRow = (label, get, fmt, tone) => `<tr>
      <td>${label}</td>${scoreCols.map(m => {
    const v = get(m);
    return `<td class="num ${tone ? tone(v, m) : ''}">${fmt(v, m)}</td>`;
  }).join('')}</tr>`;
  $('score-table').innerHTML = `<thead><tr>
      <th>Measure</th>${scoreCols.map(m =>
    `<th class="num">${m.day === 0 ? 'Today' : 'Day ' + m.day}<div class="mutedtext">${fmtDate(m.date)}</div></th>`).join('')}
    </tr></thead><tbody>
    ${scoreRow('Spendable cash', m => cashOn(m.date), v => money(v), v => v < sim.buffer ? 'neg' : '')}
    ${scoreRow('Consumer card debt', m => m.consumer, v => money(v))}
    ${scoreRow('HELOC', m => m.heloc, v => money(v))}
    ${scoreRow('Revolving credit left', m => m.headroom, v => money(v), v => v < 500 ? 'neg' : '')}
    ${scoreRow('Facilities over limit', m => m.overLimitCount, v => v === 0 ? '—' : String(v), v => v > 0 ? 'neg' : '')}
    ${scoreRow('Interest incurred', m => m.interestToDate, v => v === 0 ? '—' : money(v))}
    </tbody>`;
  // Same figures, stacked, for a screen too narrow to hold four columns.
  $('score-cards').innerHTML = scoreCols.map(m => {
    const cash = cashOn(m.date);
    const line = (lab, val, neg) =>
      `<div class="score-row ${neg ? 'neg' : ''}"><span>${lab}</span><span>${val}</span></div>`;
    return `<div class="score-card">
      <div class="score-card-head">
        <span class="score-card-when">${m.day === 0 ? 'Today' : 'Day ' + m.day}</span>
        <span class="score-card-date">${fmtDateLong(m.date)}</span>
      </div>
      ${line('Spendable cash', money(cash), cash < sim.buffer)}
      ${line('Consumer card debt', money(m.consumer))}
      ${line('HELOC', money(m.heloc))}
      ${line('Revolving credit left', money(m.headroom), m.headroom < 500)}
      ${line('Facilities over limit', m.overLimitCount === 0 ? 'none' : String(m.overLimitCount), m.overLimitCount > 0)}
      ${line('Interest incurred', m.interestToDate === 0 ? '—' : money(m.interestToDate))}
    </div>`;
  }).join('');

  $('score-note').innerHTML =
    (gap && fundingPlan ? `Assumes the opening gap is covered by ` +
      `<b>${fundingPlan.parts.map(p => `${money2(p.amount)} from ${p.short}`).join(' plus ')}</b>` +
      (fundingPlan.borrowed > 0
        ? `, of which <b>${money2(fundingPlan.borrowed)} is borrowed</b> and is carried on the debt lines below`
        : `, none of which is borrowed`) +
      (fundingPlan.shortfall > 0
        ? `. ${money2(fundingPlan.shortfall)} of it could not be funded at all, so these figures are the best
           case available rather than a plan that holds` : '') + `. ` : '') +
    (capView.hasFeasibleCap
      ? `Cash is <b>projected</b> under the ${state.scenario} scenario at ${money(weekly)}/week; debt balances are ` +
        `projected from today's rates with minimums paid and <b>no new card spending</b> — the cap is a cash instruction, ` +
        `and these lines only fall if it is honoured in cash. `
      : `Cash is <b>projected</b> under the ${state.scenario} scenario at ${money(weekly)}/week of variable spending; debt balances are ` +
        `projected from today's rates with minimums paid and <b>no new card spending</b>. That weekly figure is a simulation assumption, ` +
        `not a supported household cap — no feasible weekly cap exists until the protected funding shortfall is solved. `) +
    `None of these is a target: no aspirational payoff figure ` +
    `is assumed anywhere. Interest incurred is cumulative across every debt including the mortgage.`;

  /* ---- the three phases, derived from what the numbers do ---- */
  // WHICH heading each block gets, which opening body applies, which way
  // consumer debt moved, and whether the HELOC sentence belongs in 31–60,
  // is a financial decision and belongs to Forecast.planPhases — where the
  // node suite can reach it. This page looks the wording up. It no longer
  // compares debt marks, tests the gap, or selects a risk state.
  const outlook = diagnosticsVisible ? Forecast.planPhases(plan, advice, debtProj, {
    weeklyOverride: state.weeklyVariable, sim,
    budget, transfer: transferDependency, alternatives,
    disabled: state.disabled,
  }) : null;
  const phase = (range, title, body) =>
    `<div class="phase"><div class="phase-range">${range}</div>
      <div class="phase-title">${title}</div><p>${body}</p></div>`;
  if (diagnosticsVisible) $('phases').innerHTML = outlook.phases.map(p => {
    const body = p.rangeId === '61-90'
      ? PHASE_BODY[p.rangeId](Object.assign({}, p, {
          nextDollarSummary: plan.nextDollar ? plan.nextDollar.summary : '',
        }))
      : PHASE_BODY[p.rangeId](p);
    return phase(PHASE_RANGE[p.rangeId], PHASE_TITLE[p.titleId], body);
  }).join('');

  /* ---- what the ending cash is actually for ---- */
  // HOW MUCH of the ending cash is unallocated, and whether that is free cash
  // or is not spending money, is a financial decision and belongs to
  // Forecast.unallocatedCash — where the node suite can reach it. This page
  // prints the ledger lines and looks the sentence up. It no longer converts
  // the monthly reserve over the window, subtracts buffer and reserves, or
  // picks the verdict from the unrounded remainder.
  const free = Forecast.unallocatedCash(sim, budget, plan);
  $('priorities-ledger').innerHTML =
    row('Projected cash on ' + fmtDateLong(sim.end), free.ending == null ? 'Not established' : money2(free.ending), 'sum') +
    row('− Target buffer', '− ' + money2(free.buffer)) +
    row('− Reserves accrued but not yet due <span class="mutedtext">property tax, CRA</span>',
      free.reserves == null ? 'Not established' : '- ' + est(money2(free.reserves)), '', chipE) +
    row('<b>= Unallocated</b>', `<b class="${free.negative ? 'neg' : ''}">${free.amount == null ? 'Not established' : money2(free.amount)}</b>`, 'sum');
  $('priorities-note').innerHTML = UNALLOCATED_NOTE[free.id](
    plan.nextDollar ? plan.nextDollar.summary : '');

  /* ---- what could break the plan ---- */
  // WHICH risks appear, and the figures inside them, is Forecast.planPhases.
  // The cash-not-cards line is always shown — it is copy, not a comparison.
  if (diagnosticsVisible) {
    const risks = outlook.risks.map(r => ({
      what: RISK_WHAT[r.id](r),
      change: RISK_CHANGE[r.id](r),
    }));
    risks.push({ what: 'The cap assumes spending is paid in cash, not put on the cards',
      change: `The historical averages behind the split include card purchases. Spending at the same rate on the cards
             would leave the cash line looking healthy while the balances grew — the projection above assumes no new
             card spending at all.` });
    $('risk-list').innerHTML = risks.map(r => `
    <div class="risk">
      <div class="risk-what">${r.what}</div>
      <p class="risk-change">${r.change}</p>
    </div>`).join('');
  }

  /* ---- how this was calculated ---- */
  if ($('assumption-list')) {
    $('assumption-list').innerHTML = (plan.assumptions || []).map(a => `<li>${currentCashScopeNote(a)}</li>`).join('');
  }

  /* ---- the ledger ---- */
  const T = sim.totals;
  $('hero-ledger').innerHTML =
    row('Starting available cash <span class="mutedtext">household accounts only</span>',
      money2(Forecast.startingCashAmount(plan)), '', chipC) +
    (plan.startingCash.heldElsewhere
      ? `<div class="ledger-sub">${plan.startingCash.heldElsewhere.map(h =>
          `<div class="ledger-row sub"><span>${h.label}</span><span>${money2(h.value)} <span class="mutedtext">not counted</span></span></div>`).join('')}</div>`
      : '') +
    row('Income — confirmed', '+ ' + money2(T.confirmedIncome), 'in', chipC) +
    row('Income — estimated', est('+ ' + money2(T.estimatedIncome)), 'in', chipE) +
    // Without this row the rows below do not add up to the ending balance —
    // they reconciled to $3,946.04 against an ending of $4,989.20, the
    // difference being gap funding that was in the arithmetic and not on the
    // page. It is not income: it is money moved in to cover the opening gap.
    (T.injections > 0
      ? row(`Gap funding <span class="mutedtext">${fundingPlan
          ? fundingPlan.parts.map(p => p.short).join(' + ') : 'moved in'}</span>`,
        '+ ' + money2(T.injections), 'in', ' <span class="chip">not income</span>')
      : '') +
    row('Debt minimums & mortgage', '− ' + money2(T.obligations), 'out') +
    row('Recurring bills — utilities, insurance, gym', '− ' + money2(T.bills), 'out') +
    row('Committed expenses', '− ' + money2(T.commitments), 'out') +
    row('Variable-spending budget', '− ' + money2(T.variable), 'out', ' <span class="chip">budget</span>') +
    (T.reserved > 0
      ? row('Reserved current-regime', '− ' + money2(T.reserved), 'out', ' <span class="chip">reserved</span>')
      : '') +
    (T.extra > 0 ? row('Planned extra debt payments', '− ' + money2(T.extra), 'out', ' <span class="chip">planned</span>') : '') +
    (T.noncash ? row('HELOC interest — capitalised, not paid',
      money2(T.noncash) + ' <span class="mutedtext">added to the balance</span>', '', ' <span class="chip">non-cash</span>') : '') +
    row('<b>Projected ending cash</b>', `<b>${money2(sim.ending)}</b>`, 'sum') +
    row('Lowest projected balance', `${money2(sim.min.balance)} <span class="mutedtext">on ${fmtDate(sim.min.date)}</span>`,
      sim.min.balance < 0 ? 'neg' : '') +
    row('Target emergency buffer', money2(sim.buffer)) +
    row('Room for extra debt repayment', money2(sim.extraDebtCapacity) + ' <span class="mutedtext">at the end of the window</span>');
  $('hero-note').textContent = currentCashScopeNote(plan.startingCash.note);

  /* ---- scenario buttons ---- */
  for (const b of document.querySelectorAll('#scenario-bar .preset')) {
    b.setAttribute('aria-pressed', String(b.dataset.scenario === state.scenario));
  }

  /* ---- chart ---- */
  forecastChart($('c-forecast'), sim);
  $('forecast-caption').innerHTML =
    `Filled dots are confirmed paydays, hollow dots estimated income, triangles payments of $500 or more. ` +
    `Shaded weeks dip below the buffer${sim.daily.some(p => p.balance < 0) ? '; the red zone is a negative balance' : ''}. ` +
    `Every number is repeated in the table below — nothing here needs a hover.`;

  /* ---- weekly table (desktop) and cards (mobile) ---- */
  const anyInjection = sim.weeks.some(w => w.injections > 0);
  const anyReserved = sim.weeks.some(w => w.reserved > 0);
  const wkRow = w => {
    const cls = w.negative ? 'wk-neg' : w.belowBuffer ? 'wk-low' : '';
    const fixed = w.obligations + w.bills;
    return `<tr class="${cls}">
      <td>W${w.n}<div class="mutedtext">${fmtRange(w.start, w.end)}</div></td>
      <td class="num">${money(w.opening)}</td>
      <td class="num">${w.confirmedIncome ? '+' + money(w.confirmedIncome).slice(1) : '—'}</td>
      <td class="num">${w.estimatedIncome ? est('+' + money(w.estimatedIncome).slice(1)) : '—'}</td>
      ${anyInjection ? `<td class="num">${w.injections
        ? '+' + money(w.injections).slice(1) : '—'}</td>` : ''}
      <td class="num">${fixed ? money(fixed) : '—'}</td>
      <td class="num">${w.commitments ? money(w.commitments) : '—'}</td>
      <td class="num">${money(w.variable)}</td>
      ${anyReserved ? `<td class="num">${w.reserved ? money(w.reserved) : '—'}</td>` : ''}
      ${w.extra ? `<td class="num">${money(w.extra)}</td>` : (sim.totals.extra > 0 ? '<td class="num">—</td>' : '')}
      <td class="num ${w.closing < 0 ? 'neg' : ''}"><b>${money(w.closing)}</b>` +
      `<div class="mutedtext ${w.closing < w.requiredClosing ? 'neg' : ''}">keep ≥ ${money(w.requiredClosing)}</div>` +
      `${w.belowBuffer ? `<div class="mutedtext">low ${money(w.low)}</div>` : ''}</td>
    </tr>`;
  };
  const extraCol = sim.totals.extra > 0 ? '<th class="num">Extra debt</th>' : '';
  // Without this column week 1 opens at $79.84, its visible rows imply a
  // $1,695.58 close and it displays $2,738.74 — the same unreconcilable gap
  // the aggregate ledger had, one level down.
  const fundCol = anyInjection ? '<th class="num">Gap funding</th>' : '';
  const reservedCol = anyReserved ? '<th class="num">Reserved</th>' : '';
  $('wk-table').innerHTML = `<thead><tr>
      <th>Week</th><th class="num">Opening</th><th class="num">Confirmed in</th><th class="num">Estimated in</th>${fundCol}
      <th class="num">Bills &amp; minimums</th><th class="num">Committed</th><th class="num">Budget</th>${reservedCol}${extraCol}<th class="num">Closing</th>
    </tr></thead><tbody>${sim.weeks.map(wkRow).join('')}</tbody>`;

  /* ---- the calendar ---- */
  renderCalendar(sim, neededBy, plan);
  $('cal-note').textContent = plan.billsNote || '';

  $('wk-cards').innerHTML = sim.weeks.map(w => {
    const notable = w.events.filter(e => Math.abs(e.amount) >= 250)
      .map(e => `<li>${e.amount > 0 ? '+' : '−'}${money(Math.abs(e.amount)).slice(1)} ${e.label}${e.confidence === 'estimated' ? ' <span class="est">≈</span>' : ''}</li>`).join('');
    return `<div class="wk-card ${w.negative ? 'wk-neg' : w.belowBuffer ? 'wk-low' : ''}">
      <div class="wk-card-head">
        <span><b>Week ${w.n}</b> · ${fmtRange(w.start, w.end)}</span>
        <span class="wk-close ${w.closing < 0 ? 'neg' : ''}">${money(w.closing)}</span>
      </div>
      <div class="wk-card-grid">
        <span>Opening ${money(w.opening)}</span>
        <span>In ${money(w.confirmedIncome)}${w.estimatedIncome ? ` <span class="est">+ ≈${money(w.estimatedIncome).slice(1)}</span>` : ''}${w.injections ? ` + ${money(w.injections)} funding` : ''}</span>
        <span>Out ${money(w.obligations + w.bills + w.commitments + w.extra)}</span>
        <span>Budget ${money(w.variable)}</span>
        ${w.reserved ? `<span>Reserved ${money(w.reserved)}</span>` : ''}
      </div>
      <div class="wk-track ${w.closing < w.requiredClosing ? 'neg' : ''}">Keep ≥ ${money(w.requiredClosing)} to stay on plan</div>
      ${w.belowBuffer ? `<div class="wk-flag ${w.negative ? 'neg' : ''}">${w.negative ? 'Goes negative' : 'Dips below the buffer'} — low ${money(w.low)}</div>` : ''}
      ${notable ? `<ul class="wk-events">${notable}</ul>` : ''}
    </div>`;
  }).join('');

  /* ---- what the cap has to cover ---- */
  // The cap is one number, but it is not one kind of money. Food and fuel come
  // out of it before anything optional does, and the page has to say so or the
  // household will read it as spending money.
  if (budget && cap && !capView.permissionUnavailable) {
    $('budget-out').innerHTML =
      row('<b>Weekly household cap</b>',
        capView.hasFeasibleCap ? `<b>${money(weekly)} / week</b>` : '<b>unavailable</b>') +
      (capView.hasFeasibleCap
        ? row('&nbsp;&nbsp;— as a monthly figure', `${money(cap.monthly)} / month`)
        : (capView.settingLine ? row('&nbsp;&nbsp;— your setting', capView.settingLine) : '')) +
      row('Essential variable need <span class="mutedtext">groceries, fuel, phones, medical</span>',
        est(money(cap.essentialWeekly) + ' / week'), 'out', chipE) +
      (capView.hasFeasibleCap
        ? row(cap.hasDiscretionaryRoom ? 'Discretionary room' : '<b class="neg">Discretionary room</b>',
          cap.hasDiscretionaryRoom
            ? money(cap.discretionaryRoomWeekly) + ' / week'
            : '<b class="neg">nothing left</b>')
        : '') +
      row('&nbsp;&nbsp;— of which groceries and fuel',
        est(money(cap.foodFuelPlannedWeekly) + ' / week'), '', chipE) +
      row('Planned extra debt payment', money(state.extraDebtMonthly) + ' / month') +
      row('Required buffer at the end', money(sim.buffer)) +
      (!capView.hasFeasibleCap
        ? `<p class="warnline">No feasible weekly cap until the protected funding shortfall is solved.
           The essential need above is the household's own budget, not a supported weekly spend.</p>`
        : (!cap.hasDiscretionaryRoom
          ? `<p class="warnline">The cap is ${money(cap.essentialShortfallWeekly)}/week <b>below</b> what normal life has been costing.
           Groceries and fuel alone have run ${money(cap.foodFuelHistoricalWeekly)}/week. At this income the
           window only works by cutting essentials, moving a commitment, or borrowing — that is the real message of this number.</p>`
          : `<p class="warnline">Read this as: <b>${money(cap.essentialWeekly)}/week is spoken for</b> before anything optional —
           ${money(cap.foodFuelPlannedWeekly)} of it groceries and fuel. The remaining
           ${money(cap.discretionaryRoomWeekly)}/week is the whole of dining out, shopping, entertainment and online spending, against the
           ${money(cap.householdDiscretionaryWeekly)}/week those have actually been running at.</p>`));

    $('budget-basis').textContent = capView.hasFeasibleCap
      ? `Solved from the forecast, not from a category template: the largest weekly spend that keeps every day of the ` +
      `projection at or above the ${money(sim.buffer)} buffer under the ${state.scenario} income scenario. ` +
      `The split below it comes from ${budget.basisLabel.toLowerCase()} of actual spending — ` +
      `${budget.months} months — with the ${money(budget.datedMonthly)}/month of bills and commitments that already sit ` +
      `on the calendar subtracted from their own categories, so nothing is counted twice. ` +
      `${budget.ownerTargetCount} of these categories use the household's own budget target and the rest are ` +
      `historical actuals; each row shows which, and the average it is being measured against.`
      : `No feasible weekly cap until the protected funding shortfall is solved. The category split below is ` +
      `the household's own budget need, not a supported weekly spend.`;
  }

  /* ---- category breakdown ---- */
  // Every category, in one table, showing the three things that matter:
  // what it has actually cost, what is already dated on the calendar, and what
  // therefore has to come out of the weekly cap. An even percentage cut across
  // everything is the wrong instruction, so the essential rows are marked and
  // the discretionary ones carry the reduction.
  if (budget) {
    const cats = budget.categories.filter(c =>
      c.historical > 0 || c.dated > 0 || c.target != null || c.planned > 0);
    const max = Math.max(0, ...cats.map(c => c.historical));
    const chipFor = c =>
      c.class === 'essential' ? '<span class="chip">essential</span>'
      : c.class === 'reserve' ? '<span class="chip w">reserve</span>'
      : c.class === 'unknown' ? '<span class="chip e">unknown</span>' : '';
    $('budget-cats').innerHTML = cats.map(c => `
      <div class="cat-row">
        <span class="cat-lab">${c.label} ${chipFor(c)}${c.target != null
          ? ' <span class="chip v">owner budget</span>' : ''}${c.fullyDated
          ? ' <span class="chip v">on the calendar</span>' : ''}${c.sinking > 0
          ? ' <span class="chip w">sinking fund</span>' : ''}</span>
        <span class="cat-bar"><span style="width:${max > 0 ? (c.historical / max) * 100 : 0}%"></span></span>
        <span class="cat-amt">${c.class === 'reserve'
          ? '<span class="mutedtext">reserve</span>'
          : c.planned > 0 ? est(money(c.planned)) : '<span class="mutedtext">$0</span>'}</span>
        <span class="cat-hist">${c.target != null
          ? `budgeted ${money(c.target)}, has been ${money(c.historical)}`
          : `has been ${money(c.historical)}`}/mo${c.dated > 0
          ? ` · ${money(c.dated)} dated` : ''}${c.current != null && c.current > 0
          ? ` · ${money(c.current)} current-regime` : ''}${c.sinking > 0
          ? ` · ${money(c.sinking)} saved for separately` : ''}</span>
      </div>`).join('');

    // Derived, not named in prose — the sentence used to say "insurance and
    // children's sports", and sports stopped being $0 when sinking funds were
    // separated out.
    const fullyDatedNames = budget.categories.filter(c => c.fullyDated).map(c => c.label);
    $('budget-cats-note').textContent = capView.hasFeasibleCap && cap
      ? `The right-hand figure is what each category has averaged; the amount before it is what has to come out of the ` +
      `weekly cap once anything already dated on the calendar is removed. Those add to ${money(cap.inCapMonthly)}/month against a ` +
      `cap of ${money(cap.monthly)}/month, so ${money(cap.overCapMonthly)}/month has to come off — and it ` +
      `cannot come off the essential rows, which are ${money(cap.essentialMonthly)}/month on their own. ` +
      (fullyDatedNames.length
        ? `${fullyDatedNames.join(' and ')} show${fullyDatedNames.length === 1 ? 's' : ''} $0 because ` +
          `${fullyDatedNames.length === 1 ? 'it is' : 'they are'} fully dated on the calendar, not because ` +
          `${fullyDatedNames.length === 1 ? 'it is' : 'they are'} free.`
        : '') +
      (budget.sinkingMonthly > 0
        ? ` The ${money(budget.sinkingMonthly)}/month of season fees is saved for separately and is not ` +
          `netted off the ordinary sports line, which still carries its own budget.`
        : '')
      : `The right-hand figure is what each category has averaged. ${capView.reason || 'The weekly cap split is unavailable.'} ` +
      `These amounts are household budget need, not a supported cap split.` +
      (budget.sinkingMonthly > 0
        ? ` The ${money(budget.sinkingMonthly)}/month of season fees is saved for separately and is not ` +
          `netted off the ordinary sports line, which still carries its own budget.`
        : '');
  }

  /* ---- next actions ---- */
  // The first action is the next move and is rendered separately, above.
  // Balance-dependent status (a debtId on the row) is Forecast-derived;
  // owner-policy status stays on the stored row.
  const actions = Forecast.resolveActions(plan, state.debts, state.extraFacilities);
  if (plan.actionsNote) $('actions-note').textContent = plan.actionsNote;
  $('actions-list').innerHTML = actions.slice(1, 5).map((a, i) => {
    const overdue = a.due && a.due < asOf && a.status !== 'done';
    return `<div class="action ${a.status === 'done' ? 'done' : ''}">
      <div class="action-n">${i + 2}</div>
      <div class="action-body">
        <div class="action-top">
          <span class="action-what">${a.what}</span>
          <span class="action-amt">${a.amount != null ? money2(a.amount) : ''}</span>
        </div>
        <div class="action-meta">
          ${a.due ? `<span class="chip ${overdue ? 'c' : 'w'}">due ${fmtDate(a.due)}</span>` : '<span class="chip">no deadline</span>'}
          <span class="chip ${a.status === 'done' ? 'v' : 'e'}">${a.status}</span>
          ${a.owner ? `<span class="chip">${a.owner}</span>` : ''}
        </div>
        <p class="action-why">${a.why}</p>
      </div>
    </div>`;
  }).join('');

  /* ---- compact snapshot ---- */
  // The same day-zero figure the tile above shows. Summing raw balances here
  // reported $29,842.83 under the identical "Consumer debt" label while the
  // tile said $30,090.01 — the $247.18 of pending charges, twice on one page.
  // Secured debt, monthly interest and the HELOC month-on-month direction are
  // Forecast.compactSnapshot's — this page prints the tiles. Revolving
  // headroom already belongs to Forecast.utilisation.
  const consumer = today.consumer;
  const snap = Forecast.compactSnapshot(d.debts, d.helocHistory);
  // Pending charges have already spent the credit they are charged against,
  // so headroom is derived with them included rather than from posted
  // balances alone — the Travel Visa reads $21.69 of room the other way.
  const revolving = Forecast.utilisation(d.debts, d.revolvingExtra, plan).totalAvailable;
  const helocTrend = snap.heloc ? HELOC_TREND[snap.heloc.id] : null;
  $('snapshot-tiles').innerHTML = [
    { lab: 'Consumer debt', val: money(consumer), note: 'cards and revolving, excluding the house' },
    { lab: 'Mortgage + HELOC', val: money(snap.secured), note: 'secured on the home' },
    { lab: 'Interest cost / month', val: money(snap.monthlyInterest), note: 'across every debt, at current rates' },
    { lab: 'Credit left, everywhere', val: money(revolving), note: 'across all revolving facilities combined' },
    ...(helocTrend ? [{ lab: 'HELOC vs last month',
      val: helocTrend.sign + money(Math.abs(snap.heloc.delta)).slice(1),
      note: helocTrend.note }] : []),
  ].map(t => `
    <div class="tile small">
      <div class="lab">${t.lab}</div><div class="val">${t.val}</div><div class="note">${t.note}</div>
    </div>`).join('');

  /* ---- dated openings: display-only deltas from stored snapshots ---- */
  renderBalanceHistory(history);

  /* ---- payday answer: format existing Forecast results, decide nothing ---- */
  const operatingMount = $('operating-surface-body');
  if (operatingMount) {
    if (planLook === 'next-period' && !advice.nextPeriodView) planLook = 'this-period';
    if (planLook && planLook.slice(0, 5) === 'week:') {
      const start = planLook.slice(5);
      const found = (advice.weekViews || []).some(row => row && row.periodStart === start);
      if (!found) planLook = 'this-period';
    }
    if (planLook && planLook.slice(0, 5) === 'past:') {
      const start = planLook.slice(5);
      const found = (advice.pastPeriodViews || []).some(row => row && row.start === start);
      if (!found) planLook = 'this-period';
    }
    if (planLook === 'payday-carryover') {
      const points = advice.paydayCarryoverTrend && advice.paydayCarryoverTrend.points;
      if (!points || !points.length) planLook = 'this-period';
    }
    const planView = selectedPlanView(advice, planLook);
    const surfaceCtx = {
      plan, asOf, advice, status, mission: missionResult, nextMove: move,
      nextOut, nextDue: Forecast.nextDue(sim.events, asOf),
      unallocated: free, budget, creditAvailable: revolving,
      weekly, recommended, weeklyOverride: state.weeklyVariable,
      capView, debts: state.debts, liveOverlay: d.liveOverlay,
      refreshTrust: d.refreshTrust, periods,
      revolvingExtra: d.revolvingExtra,
      planLook, planCalendarShow, planPayPeriodId, planView,
    };
    budgetRemount(operatingMount, surfaceCtx);
    wirePlanLookPicker(operatingMount, surfaceCtx);
    applyUnavailableOperatingChrome(planUnavailable, asOf, d.liveOverlay);
  }
  const paydayMount = $('payday-answer-body');
  if (paydayMount) {
    applyPaydayHeading(advice.currentPeriodAction);
    paydayMount.innerHTML = paydayAnswerHtml({
      plan, asOf, advice, status,
      mission: missionResult,
      nextMove: move,
      nextOut,
      nextDue: Forecast.nextDue(sim.events, asOf),
      unallocated: free,
      budget,
      creditAvailable: revolving,
      weekly,
      recommended,
      weeklyOverride: state.weeklyVariable,
      capView,
      debts: d.debts,
      liveOverlay: d.liveOverlay || null,
    });
  }
}

/* ----------------------------------------------------------- controls */
function wireControls(d) {
  const plan = d.plan;
  loadKnobs(plan.defaults);
  // Not knobs — canonical facts the engine needs to size a payment against the
  // debt that exists. Set after loadKnobs so a stale localStorage payload
  // cannot supply its own idea of what the household owes.
  state.debts = d.debts;
  const priority = Forecast.debtPriority(plan, d.debts);
  state.extraDebtTarget = priority.target && priority.target.id;
  state.extraFacilities = d.revolvingExtra;

  // Scenario buttons
  for (const b of document.querySelectorAll('#scenario-bar .preset')) {
    b.addEventListener('click', () => {
      state.scenario = b.dataset.scenario;
      state.incomeOverrides = {}; // scenario switch resets per-stream overrides
      syncInputs();
      saveKnobs(); App.rerender();
    });
  }

  const num = (id, get, set) => {
    const inp = $(id);
    if (!inp) return;
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (isFinite(v) && v >= 0) { set(v); saveKnobs(); App.rerender(); }
      else syncInputs();
    });
  };
  num('in-buffer', () => state.targetBuffer, v => { state.targetBuffer = v; });
  num('in-extra', () => state.extraDebtMonthly, v => { state.extraDebtMonthly = v; });
  num('in-weekly', () => state.weeklyVariable, v => { state.weeklyVariable = v; });
  $('btn-weekly-auto').addEventListener('click', () => {
    state.weeklyVariable = null; saveKnobs(); syncInputs(); App.rerender();
  });

  // Per-stream income overrides — only the estimated streams are editable.
  const streams = plan.income.filter(s => s.scenarioMonthly);
  $('income-inputs').innerHTML = streams.map(s => `
    <div class="control">
      <label for="inc-${s.id}">${s.label} <span class="chip w">estimated, monthly</span></label>
      <input type="number" id="inc-${s.id}" class="numin" min="0" step="50" inputmode="decimal">
    </div>`).join('');
  for (const s of streams) {
    $(`inc-${s.id}`).addEventListener('change', () => {
      const v = Number($(`inc-${s.id}`).value);
      if (isFinite(v) && v >= 0) { state.incomeOverrides[s.id] = v; saveKnobs(); App.rerender(); }
    });
  }

  // Optional commitments
  const adjustable = plan.commitments.filter(c => c.adjustable);
  $('commit-toggles').innerHTML = adjustable.map(c => `
    <label class="toggle">
      <input type="checkbox" id="ct-${c.id}" ${state.disabled.includes(c.id) ? '' : 'checked'}>
      <span>${c.label} — ${money2(c.amount)} <span class="mutedtext">${fmtDate(c.date)}</span></span>
    </label>`).join('');
  for (const c of adjustable) {
    $(`ct-${c.id}`).addEventListener('change', ev => {
      state.disabled = state.disabled.filter(id => id !== c.id);
      if (!ev.target.checked) state.disabled.push(c.id);
      saveKnobs(); App.rerender();
    });
  }

  function syncInputs() {
    $('in-buffer').value = state.targetBuffer;
    $('in-extra').value = state.extraDebtMonthly;
    $('in-weekly').value = state.weeklyVariable != null ? state.weeklyVariable : '';
    $('in-weekly').placeholder = 'recommended';
    for (const s of streams) {
      const ov = state.incomeOverrides[s.id];
      $(`inc-${s.id}`).value = ov != null ? ov : s.scenarioMonthly[state.scenario];
    }
    for (const c of adjustable) $(`ct-${c.id}`).checked = !state.disabled.includes(c.id);
  }
  syncInputs();

  $('btn-reset').addEventListener('click', () => {
    state.scenario = plan.defaults.scenario;
    state.targetBuffer = plan.defaults.targetBuffer;
    state.extraDebtMonthly = plan.defaults.extraDebtMonthly;
    state.weeklyVariable = null;
    state.incomeOverrides = {};
    state.disabled = [];
    saveKnobs(); syncInputs(); App.rerender();
  });
}

if (typeof App !== 'undefined') {
  App.once(wireControls);
  App.register(renderPlan);
  App.boot({ periods: true, history: true });
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    operatingSurfaceHtml, unavailableOperatingSurfaceHtml, betweenPaydaysOperatingHtml, paydayAnswerHtml, paydayActionRows, paydayOtherActionRows, paydayComingRows,
    paydayCashNote, currentCashScopeNote, weeklyCapView, futurePlanRequirement, futurePlanTiming, futureGravityHtml,
    refreshTrustHtml, applyUnavailableOperatingChrome,
    MISSION_PART, NEXT_MOVE, STATUS_BAND,
  };
}
