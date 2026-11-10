'use strict';
/* Plan Spend leads with Forecast's serial payday funding schedule and then
 * renders Forecast.majorPlans in Forecast.planSpendCards order. This page
 * does not allocate savings or calculate household figures. */

const PLAN_SPEND_VERDICT = {
  'ON TRACK': { cls: 'on-track', chip: 'v', label: 'FEASIBLE IN CURRENT PLAN' },
  'AT RISK': { cls: 'at-risk', chip: 'w', label: 'AT RISK' },
  'FUNDING GAP': { cls: 'funding-gap', chip: 'c', label: 'FUNDING SHORTFALL' },
};

/* ATLAS-080 publication gating, Plan Spend mirror. The settlement
 * evidence loader's tri-state outcome reaches this page as a status
 * carried ALONGSIDE the evidence on the served data
 * (d.settlementEvidenceStatus / d.settlementEvidence). This is the
 * incumbent Planning/Plan validation verbatim (planningSettlementOutcome,
 * planSettlementOutcome) — same reason vocabulary, same structural
 * contract, same fail-closed rules; parity is pinned by
 * test-settlement-evidence-publication-gating.js. A malformed status,
 * a qualified status without valid effective evidence, or evidence
 * under any non-qualified status fails closed as
 * unavailable('invalid-configuration'), never as unconfigured. */
const PLAN_SPEND_SETTLEMENT_REASONS = new Set([
  'invalid-configuration', 'pin-unavailable', 'pin-invalid',
  'document-unavailable', 'document-missing', 'document-malformed',
  'household-mismatch', 'revision-mismatch', 'document-ahead-of-pin',
  'digest-mismatch', 'document-invalid', 'document-changed',
]);

function planSpendSettlementDateValid(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}

// Structural validation only; amounts are checked for shape, never
// summed or applied here. Forecast is the sole calculator of relief.
function planSpendSettlementEvidenceValid(evidence) {
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
      if (!planSpendSettlementDateValid(link.effectiveDate)
        || !planSpendSettlementDateValid(link.asOf)) return false;
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
        if (!planSpendSettlementDateValid(reversal.date)) return false;
      }
    }
  }
  return true;
}

function planSpendSettlementOutcome(d) {
  const status = d ? d.settlementEvidenceStatus : undefined;
  const evidence = d ? d.settlementEvidence : undefined;
  const invalid = { kind: 'unavailable', reason: 'invalid-configuration' };
  // Explicit null is a configured outcome that failed to serialize.
  if (status === null) return invalid;
  const hasStatus = status !== undefined;
  const hasEvidence = evidence !== undefined && evidence !== null;
  if (!hasStatus && !hasEvidence) return { kind: 'unconfigured' };
  if (!hasStatus || typeof status !== 'object' || Array.isArray(status)) return invalid;
  if (status.status === 'unconfigured') {
    return hasEvidence ? invalid : { kind: 'unconfigured' };
  }
  if (status.status === 'qualified') {
    return hasEvidence && planSpendSettlementEvidenceValid(evidence)
      ? { kind: 'qualified', evidence }
      : invalid;
  }
  if (status.status === 'unavailable') {
    if (hasEvidence) return invalid;
    return PLAN_SPEND_SETTLEMENT_REASONS.has(status.reason)
      ? { kind: 'unavailable', reason: status.reason }
      : invalid;
  }
  return invalid;
}

function planSpendSettlementNotice(reason) {
  return `<div class="note-box crit" data-settlement-evidence="unavailable" data-settlement-reason="${reason}">Settlement evidence is unavailable (${reason}). Savings and planned-spending funding figures that depend on settlement evidence are withheld rather than shown as if no settlement existed.</div>`;
}

function planSpendMoney(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'Not established';
  return money2(value);
}

// Still to fund is a nonnegative Forecast publication, never a signed
// balance. Reject malformed values without inventing a zero or recomputing it.
function planSpendStillToFund(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Not established';
  return money2(value);
}

function planSpendRequirement(row) {
  if (row.need != null && Number.isFinite(Number(row.need))) {
    return { amount: money2(row.need), label: 'Funding requirement', kind: 'point' };
  }
  if (row.amountMin != null && row.amountMax != null
      && Number.isFinite(Number(row.amountMin)) && Number.isFinite(Number(row.amountMax))) {
    return { amount: `${money2(row.amountMin)}–${money2(row.amountMax)}`, label: 'Cost range', kind: 'range' };
  }
  if (row.amountMin != null && Number.isFinite(Number(row.amountMin))) {
    return { amount: `From ${money2(row.amountMin)}`, label: 'Cost range', kind: 'range' };
  }
  if (row.amountMax != null && Number.isFinite(Number(row.amountMax))) {
    return { amount: `Up to ${money2(row.amountMax)}`, label: 'Cost range', kind: 'range' };
  }
  return { amount: 'Not established', label: 'Cost', kind: 'unresolved' };
}

function planSpendTiming(row) {
  // Forecast `date` is a cash-planning date, not a payment due date
  // unless a separate authoritative due-date fact exists. Month-only
  // cash dates (15th of a clear month) stay distinct from trip windows.
  if (row.tripWindow && row.date) {
    return { text: `${row.tripWindow} trip · Cash date ${fmtDateFull(row.date)}`, kind: 'trip-window' };
  }
  if (row.date) return { text: `Cash date ${fmtDateFull(row.date)}`, kind: 'dated' };
  if (row.tripWindow) return { text: row.tripWindow, kind: 'trip-window' };
  if (row.when) return { text: row.when, kind: 'approximate' };
  return { text: 'Date not established', kind: 'unresolved' };
}

function planSpendFact(name, label, value) {
  return `<div data-plan-spend-fact="${name}"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function planSpendConfidence(row) {
  const confidence = row.confidence || '';
  if (!confidence) return '';
  const cls = confidence === 'confirmed' ? 'v' : confidence === 'estimated' ? 'w' : 'e';
  return `<span class="chip ${cls}">${confidence.toUpperCase()}</span>`;
}

function planSpendStatus(row, schedule) {
  const withheld = !row || row.verdict == null || row.verdict === ''
    || (schedule && schedule.status === 'unavailable');
  const state = withheld
    ? { cls: '', chip: 'e', label: 'STATUS UNAVAILABLE' }
    : (PLAN_SPEND_VERDICT[row.verdict] || { cls: '', chip: 'e', label: 'STATUS UNAVAILABLE' });
  return `<div class="plan-spend-status"><span class="chip ${state.chip}">${state.label}</span>${planSpendConfidence(row)}</div>`;
}

// All figures below are direct Forecast.planSpendPaydayFunding fields. This
// surface formats them; it never totals contributions or walks cash.
function planSpendActionLines(rows) {
  return rows.length ? `<ul class="plan-spend-action-lines">${rows.map(row =>
    `<li><span>${row.label}</span><b>${planSpendMoney(row.amount)}</b></li>`).join('')}</ul>`
    : '<p>No new protection needed from this payday.</p>';
}

function planSpendFundingHero(schedule) {
  if (!schedule || schedule.status === 'unavailable' || !Array.isArray(schedule.paydays)) {
    return `<div class="note-box crit" data-plan-spend-funding="unavailable">${schedule && schedule.reason || 'Payday funding plan unavailable.'}</div>`;
  }
  const next = schedule.paydays[0];
  if (!next) return '<div class="note-box crit">No future Seaspan payday is available for this funding plan.</div>';
  const gap = schedule.gap;
  const gapHtml = gap ? `<div class="note-box crit" data-plan-spend-funding="gap">
    <b>Funding shortfall</b><p>${fmtDateFull(gap.payday || gap.cashDate)}:
    required ${planSpendMoney(gap.required)}, available ${planSpendMoney(gap.available)}, short by ${planSpendMoney(gap.shortBy)}.</p>
    <p>Affected: ${gap.affected.map(id => {
      const cost = (schedule.costs || []).find(row => row.id === id);
      return cost ? cost.label : id;
    }).join(' · ')}</p></div>` : '';
  return `<section class="plan-spend-funding" aria-label="Payday funding action">
    <div class="plan-spend-action" data-plan-spend-next-payday="${next.payday}">
      <span class="kicker">Next Seaspan payday in this forecast</span><h2>${fmtDateFull(next.payday)}</h2>
      <small>Projected from the ${fmtDateFull(schedule.asOf)} opening</small>
      <strong class="plan-spend-action-amount">Set aside: ${planSpendMoney(next.contribution)}</strong>
      ${planSpendActionLines(next.allocations)}
      <dl class="plan-spend-action-totals"><div><dt>Protected when set aside</dt><dd>${planSpendMoney(next.protectedAfterPayday)}</dd></div>
        <div><dt>Still to fund</dt><dd>${planSpendStillToFund(next.stillToFund)}</dd></div></dl>
    </div>${gapHtml}
    <details class="plan-spend-payday-plan"><summary>Show payday funding plan</summary>
      <p>These amounts earmark cash for named costs. The payment itself stays on its cash date.</p>
      <div class="plan-spend-payday-grid">${schedule.paydays.map(row =>
        `<article class="plan-spend-payday" data-plan-spend-payday="${row.payday}"><h3>${fmtDateFull(row.payday)}</h3>
          <strong>Protect ${planSpendMoney(row.contribution)}</strong>${planSpendActionLines(row.allocations)}
          <p>Protected when set aside: ${planSpendMoney(row.protectedAfterPayday)}</p>
          ${row.payments.length ? `<p>Paid before next payday: ${row.payments.map(payment =>
            `${payment.label} ${planSpendMoney(payment.protectedConsumed)}`).join(' · ')}</p>` : ''}</article>`).join('')}</div>
    </details></section>`;
}

function planSpendScheduledFacts(cost) {
  if (!cost) return '<p>Funding schedule unavailable for this cost.</p>';
  return `<dl class="plan-spend-facts">
    ${planSpendFact('protected', cost.backingBasis === 'policy-derived-observed-backing' ? 'Currently backed for this cost' : 'Already saved for this cost', planSpendMoney(cost.protectedNow))}
    ${planSpendFact('remaining', 'Still to fund in this plan', planSpendStillToFund(cost.stillToFund))}
    ${planSpendFact('next', 'Next contribution', cost.nextContribution
      ? `${planSpendMoney(cost.nextContribution.amount)} on ${fmtDateFull(cost.nextContribution.payday)}` : 'No contribution scheduled')}
    ${planSpendFact('fully-funded', 'Projected fully funded', cost.projectedFullyFunded
      ? fmtDateFull(cost.projectedFullyFunded) : 'Not established')}
  </dl>${cost.uncertaintyAdditional > 0
    ? `<p>Base floor scheduled; ${planSpendMoney(cost.uncertaintyAdditional)} above it remains uncertain.</p>` : ''}`;
}

// The card/member already carries its exact native cost packet. Backing and
// contribution figures stay the independent incumbent schedule publication.
function planSpendCostHtml(row, cost, withheld = false) {
  if (typeof SavingsInventory === 'undefined') return '';
  const facts = SavingsInventory.commitmentCostHtml(row, { includeSaved: false, withheld });
  return facts ? facts + planSpendScheduledFacts(cost) : '';
}

function planSpendScheduledCard(card, cost, schedule, byId, ambiguous = false) {
  const group = card.kind === 'summary';
  const costs = (group ? schedule?.groups : schedule?.costs) || [];
  const detailCost = costs.filter(row => row.id === card.id).length === 1 ? cost : null;
  const costHtml = planSpendCostHtml(card, detailCost, ambiguous);
  if (card.kind === 'summary') {
    const ids = (card.members || []).map(member => member.id);
    const affected = schedule && schedule.gap && ids.some(id => schedule.gap.affected.includes(id));
    const status = affected ? '<span class="chip c">PAYDAY FUNDING GAP</span>' : planSpendStatus(card, schedule);
    const lines = (card.members || []).map(member => {
      const row = byId.get(member.id);
      const memberCost = planSpendCostHtml(member,
        (schedule?.costs || []).filter(cost => cost.id === member.id).length === 1 ? row : null,
        ambiguous || card.members.filter(other => other.id === member.id).length !== 1);
      return `<li data-plan-spend-member="${member.id}"><span>${member.label}</span><b>${planSpendMoney(member.need)}</b>
        <time>${member.date ? `Cash date ${fmtDateFull(member.date)}` : member.when || 'Cash date not established'}</time>
        ${row && row.nextContribution ? `<small>Next protect ${planSpendMoney(row.nextContribution.amount)} on ${fmtDateFull(row.nextContribution.payday)}</small>` : ''}
        ${planSpendConfidence(member)}${memberCost ? '<details><summary>Cost breakdown</summary>' + memberCost + '</details>' : ''}</li>`;
    }).join('');
    return `<article class="planning-row plan-spend-card ${(PLAN_SPEND_VERDICT[card.verdict] || {}).cls || ''}" data-plan-spend-id="${card.id}" data-plan-spend-card="summary" data-plan-spend-verdict="${card.verdict || ''}" data-plan-spend-members="${ids.join(' ')}">
      <div class="plan-spend-glance"><h2>${card.label}</h2><div data-plan-spend-fact="schedule-remaining"><b>${planSpendMoney(card.scheduleRemaining)}</b><small>remaining schedule</small></div>
      <div class="plan-spend-status">${status}${planSpendConfidence(card)}</div>${planSpendScheduledFacts(cost)}</div>
      <details class="plan-spend-more"><summary>Show payment schedule</summary>${costHtml}<ul class="plan-spend-schedule">${lines}</ul></details></article>`;
  }
  const requirement = planSpendRequirement(card);
  const affected = schedule && schedule.gap && schedule.gap.affected.includes(card.id);
  const status = affected ? '<span class="chip c">PAYDAY FUNDING GAP</span>' : planSpendStatus(card, schedule);
  const facts = !card.date ? '<p>Funding schedule unavailable — cash date not established.</p>'
    : card.flexibility === 'optional' ? '<p>Optional cost; outside the current protected funding plan.</p>'
      : planSpendScheduledFacts(cost);
  const contributions = cost && cost.contributions && cost.contributions.length
    ? `<ul class="plan-spend-schedule">${cost.contributions.map(row =>
      `<li><time>${fmtDateFull(row.payday)}</time><b>${planSpendMoney(row.amount)}</b></li>`).join('')}</ul>` : '';
  const details = costHtml || contributions ? `<details class="plan-spend-more"><summary>${contributions ? 'Show funding schedule' : 'Cost breakdown'}</summary>${costHtml}${contributions}</details>` : '';
  return `<article class="planning-row plan-spend-card" data-plan-spend-id="${card.id}" data-plan-spend-card="row" data-plan-spend-verdict="${card.verdict || ''}" data-plan-spend-amount="${requirement.kind}">
    <div class="plan-spend-glance"><h2>${card.label}</h2><div data-plan-spend-fact="requirement"><b>${requirement.amount}</b><small>${requirement.label}</small></div>
      <span data-plan-spend-when>${planSpendTiming(card).text}</span><div class="plan-spend-status">${status}${planSpendConfidence(card)}</div>${facts}</div>${details}</article>`;
}

// Select the shared Forecast publication. A malformed current packet cannot
// silently fall back to the older publication alias.
function planSpendFundingSchedule(advice, context = {}) {
  if (advice.savingsFunding == null && context.plan?.savingsEarmarks?.allocationPolicy == null)
    return advice.planSpendPaydayFunding;
  const packet = Forecast.savingsFundingPublication(advice.savingsFunding, { ...context, advice });
  const schedule = packet?.schedule;
  if (!schedule || schedule.source !== 'Forecast.planSpendPaydayFunding' || schedule.asOf !== packet.asOf
      || !Array.isArray(schedule.costs) || !Array.isArray(schedule.groups)
      || !Array.isArray(schedule.paydays)) {
    return { status: 'unavailable', reason: 'Shared savings funding publication is unavailable.',
      costs: [], groups: [], paydays: [] };
  }
  return schedule;
}

function planSpendPageHtml(advice, liveOverlay, context = {}) {
  advice = advice || {};
  const unavailable = advice.operatingPlanUnavailable === true
    || (liveOverlay && liveOverlay.operatingPlan === 'unavailable');
  if (unavailable) {
    const note = advice.operatingPlanNote || (liveOverlay && liveOverlay.operatingPlanNote)
      || 'Current plan unavailable. The dated opening is stale.';
    return { lede: '', list: `<div class="note-box crit" data-operating-plan="unavailable">${note} Forecast verdicts for planned spending are withheld until a trusted current opening exists.</div>`, note: '' };
  }
  const plans = Array.isArray(advice.majorPlans) ? advice.majorPlans : [];
  if (!plans.length) {
    return { lede: '', list: '<p class="lede" data-plan-spend="empty">No unsettled planned spending is published on this opening.</p>', note: '' };
  }
  if (typeof Forecast === 'undefined' || typeof Forecast.planSpendCards !== 'function') {
    return { lede: '', list: '<div class="note-box crit" data-plan-spend="cards-unavailable">Plan spend cards are unavailable.</div>', note: '' };
  }
  const cards = Forecast.planSpendCards(plans);
  const schedule = planSpendFundingSchedule(advice, context);
  const costById = new Map((schedule && schedule.costs || []).map(cost => [cost.id, cost]));
  const groupById = new Map((schedule && schedule.groups || []).map(group => [group.id, group]));
  const list = cards.map(card => planSpendScheduledCard(card,
    card.kind === 'summary' ? groupById.get(card.id) : costById.get(card.id),
    schedule, costById, cards.filter(other => other.kind === card.kind && other.id === card.id).length !== 1)).join('');
  return {
    lede: planSpendFundingHero(schedule),
    note: 'Forecast projects these amounts from the served opening. Protecting cash earmarks it; paying a planned cost is the one cash outflow.',
    list,
  };
}

function planSpendAdvice(d, periods) {
  const settlement = planSpendSettlementOutcome(d);
  if (settlement.kind === 'unavailable') {
    // Withheld: no dependent Forecast call and no derived figure.
    return {
      status: 'unavailable',
      source: 'settlement-evidence',
      reason: settlement.reason,
      operatingPlanUnavailable: true,
      operatingPlanNote: `Settlement evidence is unavailable (${settlement.reason}); settlement-dependent verdicts are withheld.`,
    };
  }
  const overlay = d.liveOverlay;
  const actuals = overlay && overlay.applied === true ? overlay.currentPeriodActuals : null;
  return Forecast.recommend(d.plan, d.meta.asOf, {
    fundingSources: d.plan.funding && d.plan.funding.options,
    debts: d.debts,
    extraFacilities: d.revolvingExtra,
    periods: periods || null,
    currentPeriodActuals: actuals,
    operatingPlan: overlay && overlay.operatingPlan,
    operatingPlanNote: overlay && overlay.operatingPlanNote,
    observedCash: overlay && overlay.observedCash,
    ...(settlement.kind === 'qualified' ? { settlementEvidence: settlement.evidence } : {}),
  });
}

function renderPlanSpend(d, periods) {
  const advice = planSpendAdvice(d, periods);
  if (advice.source === 'settlement-evidence' && advice.status === 'unavailable') {
    // Replace every dependent mount so no earlier render's amounts survive.
    const notice = planSpendSettlementNotice(advice.reason);
    const inventory = $('savings-inventory');
    if (inventory) inventory.innerHTML = notice;
    const ledeMount = $('plan-spend-lede');
    if (ledeMount) ledeMount.innerHTML = '';
    const listMount = $('plan-spend-list');
    if (listMount) listMount.innerHTML = `<div class="note-box crit" data-operating-plan="unavailable" data-settlement-evidence="unavailable" data-settlement-reason="${advice.reason}">${advice.operatingPlanNote} Forecast verdicts for planned spending are withheld.</div>`;
    const noteMount = $('plan-spend-note');
    if (noteMount) noteMount.textContent = '';
    return;
  }
  const context = { advice, plan: d.plan, asOf: d.meta.asOf };
  const html = planSpendPageHtml(advice, d.liveOverlay, context);
  const inventoryMount = $('savings-inventory');
  if (inventoryMount && typeof SavingsInventory !== 'undefined') inventoryMount.innerHTML = SavingsInventory.html(
    advice.savingsFunding || (d.plan.savingsEarmarks?.allocationPolicy == null ? advice.savingsInventory : null), context);
  const lede = $('plan-spend-lede');
  const list = $('plan-spend-list');
  const note = $('plan-spend-note');
  if (lede) lede.innerHTML = html.lede;
  if (list) list.innerHTML = html.list;
  if (note) note.textContent = html.note;
}

App.register(renderPlanSpend);
App.boot({ periods: true });
