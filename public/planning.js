'use strict';
/* Planning — "What are we preparing and saving for?"
 *
 * Every row is a Forecast.majorPlans result on the master plan, reached
 * through the same Forecast.recommend call the Plan page and the assistant
 * packet use. The verdict (ON TRACK / AT RISK / FUNDING GAP), the remaining
 * requirement, the funding order, the flexibility, the range or point
 * amount, and the timing text are all Forecast's. Any current-payday
 * set-aside or by-deadline projection comes from the Forecast.paydayAllocation
 * row for the same id, when Forecast assigned one.
 *
 * This file formats those outputs. It does not read plan.commitments, does
 * not grade or rank a cost, does not collapse a range to a midpoint, does not
 * turn "Sep 2026" or "timing TBD" into a day, does not total point estimates,
 * and does not invent a saved balance when Atlas does not know one. */

const PLANNING_VERDICT = {
  'ON TRACK': { cls: 'on-track', chip: 'v', remaining: 'Covered in the plan', remainingOpen: 'Still unfunded in the plan' },
  'AT RISK': { cls: 'at-risk', chip: 'w', remaining: 'At-risk amount' },
  'FUNDING GAP': { cls: 'funding-gap', chip: 'c', remaining: 'Funding gap' },
};
const PLANNING_FLEXIBILITY = { required: 'REQUIRED', 'bounded-flex': 'FLEXIBLE', optional: 'OPTIONAL' };

// Point stays a point; a range stays a range. No midpoint, no floor stand-in.
function planningRequirement(row) {
  if (row.need != null) return { amount: money2(row.need), label: 'Cost', kind: 'point' };
  if (row.amountMin != null && row.amountMax != null) {
    return { amount: `${money2(row.amountMin)}–${money2(row.amountMax)}`, label: 'Cost range', kind: 'range' };
  }
  if (row.amountMin != null) return { amount: `From ${money2(row.amountMin)}`, label: 'Cost range', kind: 'range' };
  if (row.amountMax != null) return { amount: `Up to ${money2(row.amountMax)}`, label: 'Cost range', kind: 'range' };
  return { amount: 'Unresolved', label: 'Cost amount', kind: 'unresolved' };
}

// Forecast calendar date wins when present. Approximate `when` is printed as
// given only when Forecast published no date. This helper does not invent a
// day from month or holiday wording.
function planningTiming(row) {
  if (row.date) return { text: fmtDateFull(row.date), kind: 'dated' };
  if (row.when) return { text: row.when, kind: 'approximate' };
  return { text: 'Timing unresolved', kind: 'unresolved' };
}

function planningRemainingLabel(row, state) {
  if (row.verdict === 'ON TRACK' && Number(row.remaining) > 0) return state.remainingOpen || state.remaining;
  return state.remaining;
}

// Current-payday facts exist only where Forecast.paydayAllocation produced a
// row for this id. Absent row → nothing is printed, not $0.
function planningPaydayFacts(row, payday, unresolved) {
  const facts = [];
  if (payday && payday.projectedByDeadline != null) {
    facts.push(`<div data-planning-fact="projected"><b>${money2(payday.projectedByDeadline)}</b><small>Projected available by deadline</small></div>`);
  }
  if (payday && Number(payday.allocated) > 0) {
    facts.push(`<div data-planning-fact="set-aside"><b>${money2(payday.allocated)}</b><small>Set aside this payday</small></div>`);
  } else if (unresolved) {
    facts.push('<div data-planning-fact="set-aside"><b>Not assigned</b><small>Exact date not set</small></div>');
  } else if (payday) {
    facts.push('<div data-planning-fact="set-aside"><b>None</b><small>No set-aside this payday</small></div>');
  }
  return facts.join('');
}

function planningRowHtml(row, payday, unresolved) {
  const state = PLANNING_VERDICT[row.verdict] || { cls: '', chip: 'e', remaining: 'Forecast remaining' };
  const requirement = planningRequirement(row);
  const timing = planningTiming(row);
  const confidence = row.confidence || 'unknown';
  const confidenceClass = confidence === 'confirmed' ? 'v' : confidence === 'estimated' ? 'w' : 'e';
  const flexibility = PLANNING_FLEXIBILITY[row.flexibility] || String(row.flexibility || 'UNRESOLVED').toUpperCase();
  return `<article class="planning-row ${state.cls}" data-planning-id="${row.id}" data-planning-verdict="${row.verdict || ''}" data-planning-amount="${requirement.kind}" data-planning-timing="${timing.kind}">
      <div class="planning-head">
        <h2>${row.label}</h2>
        <span class="chip ${state.chip}">${row.verdict || 'VERDICT UNAVAILABLE'}</span>
      </div>
      <div class="planning-facts">
        <div data-planning-fact="requirement"><b>${requirement.amount}</b><small>${requirement.label}</small></div>
        <div data-planning-fact="remaining"><b>${money2(row.remaining)}</b><small>${planningRemainingLabel(row, state)}</small></div>
        ${planningPaydayFacts(row, payday, unresolved)}
      </div>
      <div class="planning-meta">
        <span data-planning-when>${timing.text}</span>
        <span class="chip ${confidenceClass}">${confidence.toUpperCase()}</span>
        <span class="chip e">${flexibility}</span>
        ${row.deferred ? '<span class="chip w">MAY MOVE</span>' : ''}
        ${unresolved ? '<span class="chip w">EXACT DATE UNRESOLVED</span>' : ''}
      </div>
    </article>`;
}

function planningTrajectoryIsPartialMonth(month) {
  if (!month || !month.month || !month.start || !month.end) return false;
  const [y, m] = month.month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const monthEnd = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return month.start !== monthStart || month.end !== monthEnd;
}

function planningTrajectoryPeriodCell(month) {
  const partial = planningTrajectoryIsPartialMonth(month);
  const periodText = `${fmtDateFull(month.start)} – ${fmtDateFull(month.end)}`;
  const partialAttr = partial ? ' data-trajectory-partial="true"' : '';
  const partialNote = partial
    ? `<small class="planning-trajectory-partial">Partial period · ${periodText}</small>`
    : `<small class="planning-trajectory-period-dates">${periodText}</small>`;
  return `<button type="button" class="planning-trajectory-month-select" data-trajectory-month-select="${month.month}"><span class="planning-trajectory-period">${month.month}</span></button>${partialNote}`;
}

function planningTrajectoryChip(status) {
  const map = {
    calculated: { cls: 'v', label: 'CALCULATED' },
    estimated: { cls: 'w', label: 'ESTIMATED' },
    unavailable: { cls: 'c', label: 'UNAVAILABLE' },
  };
  const row = map[status] || { cls: 'e', label: String(status || 'UNKNOWN').toUpperCase() };
  return `<span class="chip ${row.cls}">${row.label}</span>`;
}

/** Road Ahead Fable trust chips — presentation only; status comes from Forecast fields.
 *  Calculated never reprints as Confirmed. Confirmed is only for Forecast status confirmed. */
function planningRoadTrustChip(status) {
  const map = {
    confirmed: { cls: 'planning-road-trust-confirmed', label: 'Confirmed' },
    calculated: { cls: 'planning-road-trust-calculated', label: 'Calculated' },
    estimated: { cls: 'planning-road-trust-estimated', label: 'Estimated' },
    unavailable: { cls: 'planning-road-trust-unavailable', label: 'Unavailable' },
    planned: { cls: 'planning-road-trust-planned', label: 'Planned' },
  };
  const row = map[status] || { cls: 'planning-road-trust-unknown', label: String(status || 'Unknown') };
  return `<span class="planning-road-trust-chip ${row.cls}">${row.label}</span>`;
}

/** Waterfall and hero omit Estimated/Calculated chips and the "about" prefix.
 *  Dale already knows those figures are estimated or calculated. Fail-closed
 *  Unavailable still reprints. Confirmed/Planned stay when Forecast publishes them. */
function planningRoadWaterfallTrustChip(status) {
  if (!status || status === 'estimated' || status === 'calculated') return '';
  return planningRoadTrustChip(status);
}

function planningRoadAmountReprint(result) {
  if (!result || result.status === 'unavailable') {
    return `<span class="planning-road-amount-unavailable" aria-label="Unavailable">—</span>${planningRoadTrustChip('unavailable')}`;
  }
  if (result.amount == null || !isFinite(Number(result.amount))) {
    return `<span class="planning-road-amount-unavailable" aria-label="Unavailable">—</span>${planningRoadTrustChip('unavailable')}`;
  }
  const chip = result.status ? planningRoadTrustChip(result.status) : '';
  return `<b class="planning-road-amount-value">${money2(result.amount)}</b>${chip}`;
}

/** Presentation sign only. Forecast already owns the amount; this prefixes
 *  a plus on a published surplus so the waterfall matches the Budget twin. */
function planningRoadSignedMoney(amount) {
  const n = Number(amount);
  if (!isFinite(n)) return '';
  if (n > 0) return '+' + money2(n);
  return money2(n);
}

/** Forecast-published line items only. Absent lines stay absent — this page
 *  does not invent Dale/Amanda labels or split a published total. */
function planningRoadPublishedLines(component) {
  if (!component) return [];
  const rows = Array.isArray(component.lines) ? component.lines
    : Array.isArray(component.items) ? component.items
    : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row.label !== 'string' || !row.label) continue;
    out.push(row);
  }
  return out;
}

function planningRoadPublishedLineDateHtml(row) {
  if (!row || typeof row.date !== 'string' || !row.date) return '';
  return `<small class="planning-road-line-date">${fmtDateFull(row.date)}</small>`;
}

function planningRoadLineIdAttr(row) {
  if (!row || typeof row.id !== 'string' || !row.id) return '';
  return ` data-planning-road-line-id="${row.id}"`;
}

function planningRoadWaterfallValueHtml(component, opts) {
  const asOutflow = !!(opts && opts.asOutflow);
  const signedResult = !!(opts && opts.signedResult);
  if (!component || component.status === 'unavailable') {
    return `<span class="planning-road-wf-amount">${planningRoadAmountReprint({ status: 'unavailable' })}</span>`;
  }
  if (component.amount == null || !isFinite(Number(component.amount))) {
    return `<span class="planning-road-wf-amount">${planningRoadAmountReprint({ status: 'unavailable' })}</span>`;
  }
  const amount = Number(component.amount);
  const chip = planningRoadWaterfallTrustChip(component.status);
  let shown;
  if (signedResult) {
    shown = planningRoadSignedMoney(amount);
  } else if (asOutflow) {
    shown = amount === 0 ? money2(0) : '−' + money2(amount);
  } else {
    shown = planningRoadSignedMoney(amount);
  }
  return `<span class="planning-road-wf-amount"><b class="planning-road-amount-value">${shown}</b>${chip}</span>`;
}

function planningRoadWaterfallLineRow(row, dataKey, asOutflow, sign) {
  const label = row.label;
  const date = planningRoadPublishedLineDateHtml(row);
  const idAttr = planningRoadLineIdAttr(row);
  const signAttr = sign ? ` data-road-result-sign="${sign}"` : '';
  return `<li class="planning-road-wf-row" data-planning-road-wf-row="${dataKey}"${idAttr}${signAttr}>
    <span class="planning-road-wf-label">${label}${date}</span>
    ${planningRoadWaterfallValueHtml(row, { asOutflow: !!asOutflow })}
  </li>`;
}

function planningRoadWaterfallTotalRow(label, component, dataKey, opts) {
  const asOutflow = !!(opts && opts.asOutflow);
  const signedResult = !!(opts && opts.signedResult);
  return `<li class="planning-road-wf-row planning-road-wf-total" data-planning-road-wf-row="${dataKey}">
    <span class="planning-road-wf-label">${label}</span>
    ${planningRoadWaterfallValueHtml(component, { asOutflow, signedResult })}
  </li>`;
}

function planningRoadWaterfallLinesList(component, dataKey, asOutflow) {
  const lines = planningRoadPublishedLines(component);
  if (!lines.length) return '';
  return `<ul class="planning-road-wf-lines" data-planning-road-wf-lines="${dataKey}">${
    lines.map((row, i) => planningRoadWaterfallLineRow(row, `${dataKey}-line-${i}`, asOutflow)).join('')
  }</ul>`;
}

function planningRoadWaterfallSummaryRow(label, component, dataKey, opts) {
  const asOutflow = !!(opts && opts.asOutflow);
  return `<span class="planning-road-wf-row planning-road-wf-total" data-planning-road-wf-row="${dataKey}">
    <span class="planning-road-wf-label">${label}</span>
    ${planningRoadWaterfallValueHtml(component, { asOutflow })}
  </span>`;
}

function planningRoadWaterfallExpandable(title, component, dataKey, opts) {
  const asOutflow = !!(opts && opts.asOutflow);
  const lines = planningRoadPublishedLines(component);
  const totalLabel = (opts && opts.totalLabel) || title;
  const kicker = `<h3 class="planning-road-wf-kicker"><span class="planning-road-wf-badge planning-road-wf-badge-${dataKey}" aria-hidden="true"></span> ${title}</h3>`;
  const body = lines.length
    ? planningRoadWaterfallLinesList(component, dataKey, asOutflow)
    : `<p class="planning-road-wf-empty" data-planning-road-wf-lines="unavailable">Forecast has not published these line items.</p>`;
  return `<div class="planning-road-wf-block" data-planning-road-wf="${dataKey}">
    ${kicker}
    <details class="planning-road-wf-expand" data-planning-road-wf-expand="${dataKey}">
      <summary class="planning-road-wf-summary"><span class="planning-road-wf-chevron" aria-hidden="true"></span>${planningRoadWaterfallSummaryRow(totalLabel, component, `${dataKey}-total`, { asOutflow })}</summary>
      ${body}
    </details>
  </div>`;
}

function planningRoadWaterfallInlineSection(title, component, dataKey, opts) {
  const asOutflow = !!(opts && opts.asOutflow);
  const lines = planningRoadPublishedLines(component);
  const named = lines.length > 0;
  // Named lines already list each spend. A second row using the section title
  // (e.g. "Planned spending" −$700) looks like a double-count even though
  // Forecast subtracted once. Keep the aggregate only when there are no named lines.
  const lineRows = named
    ? lines.map((row, i) => planningRoadWaterfallLineRow(row, `${dataKey}-line-${i}`, asOutflow)).join('')
    : '';
  const totalRow = named
    ? ''
    : planningRoadWaterfallTotalRow(title, component, `${dataKey}-total`, { asOutflow });
  return `<div class="planning-road-wf-block" data-planning-road-wf="${dataKey}" data-planning-road-planned="inline" data-planning-road-wf-lines="${named ? 'named' : 'total-only'}">
    <h3 class="planning-road-wf-kicker"><span class="planning-road-wf-badge planning-road-wf-badge-${dataKey}" aria-hidden="true"></span> ${title}</h3>
    <ul class="planning-road-wf-list">${lineRows}${totalRow}</ul>
  </div>`;
}

function planningRoadWaterfallResultRow(label, result, dataKey) {
  const phrase = planningRoadAheadResultPhrase(result);
  const amountHtml = result && result.status !== 'unavailable'
    && result.amount != null && isFinite(Number(result.amount))
    ? `<b class="planning-road-amount-value">${planningRoadSignedMoney(result.amount)}</b>${planningRoadWaterfallTrustChip(result.status)}`
    : planningRoadAmountReprint({ status: 'unavailable' });
  return `<div class="planning-road-wf-result planning-road-wf-result-${phrase.cls}" data-planning-road-wf="${dataKey}" data-road-result-sign="${phrase.cls}">
    <span class="planning-road-wf-result-label">${label}</span>
    <span class="planning-road-wf-result-value">${amountHtml}</span>
  </div>`;
}

/** Sign words already used on Road Ahead. Forecast publishes the amount;
 *  this only maps a negative figure to Shortfall, matching the existing
 *  funding-gap chrome. It does not invent a Deficit phrase contract. */
function planningRoadDecisionKind(result) {
  if (!result || result.status === 'unavailable'
    || result.amount == null || !isFinite(Number(result.amount))) {
    return { word: 'Result withheld', cls: 'withheld', lead: 'period-unavailable' };
  }
  const amount = Number(result.amount);
  if (amount < 0) return { word: 'Shortfall', cls: 'gap', lead: 'period-shortfall' };
  if (amount > 0) return { word: 'Surplus', cls: 'surplus', lead: 'period-surplus' };
  return { word: 'Break-even', cls: 'neutral', lead: 'period-even' };
}

function planningRoadStageResult(stage, granularity) {
  if (granularity === 'pay-period' || !stage || (!stage.commitments && !stage.extras)) {
    return stage && stage.result;
  }
  return stage.dateOrderResult || {
    status: 'unavailable',
    reason: 'Forecast did not publish date-order Month funding. It is not $0.',
  };
}

function planningRoadDecisionAmountHtml(result, mode) {
  if (!result || result.status === 'unavailable'
    || result.amount == null || !isFinite(Number(result.amount))) {
    return planningRoadAmountReprint({ status: 'unavailable' });
  }
  const amount = Number(result.amount);
  const shown = mode === 'outflow'
    ? (amount === 0 ? money2(0) : '−' + money2(amount))
    : planningRoadSignedMoney(amount);
  const chip = planningRoadWaterfallTrustChip(result.status);
  return `<b class="planning-road-amount-value">${shown}</b>${chip}`;
}

function planningRoadDecisionLinesHtml(component) {
  const lines = planningRoadPublishedLines(component);
  if (!lines.length) return '';
  return `<ul class="planning-road-decision-lines" data-planning-road-decision-lines="named">${
    lines.map((row, i) => {
      const date = planningRoadPublishedLineDateHtml(row);
      const idAttr = planningRoadLineIdAttr(row);
      return `<li class="planning-road-decision-line" data-planning-road-decision-line="${i}"${idAttr}><span class="planning-road-decision-line-label">${row.label}${date}</span><span class="planning-road-decision-line-amount">${planningRoadDecisionAmountHtml(row, 'outflow')}</span></li>`;
    }).join('')
  }</ul>`;
}

/** Primary selected-period story. Reprints Forecast stage1.result,
 *  stage2.commitments (amount + published lines only), and the published
 *  date-order Month result (or the unchanged pay-period stage2.result).
 *  No stage arithmetic on this page. */
function planningRoadAheadDecisionHtml(period, granularity) {
  const s1 = (period && period.stage1) || {};
  const s2 = (period && period.stage2) || {};
  const beforeKind = planningRoadDecisionKind(s1.result);
  const monthView = granularity !== 'pay-period';
  const afterResult = planningRoadStageResult(s2, granularity);
  const afterKind = planningRoadDecisionKind(afterResult);
  const beforeLabel = beforeKind.lead === 'period-unavailable'
    ? 'Before planned spending'
    : monthView
      ? (beforeKind.word === 'Shortfall'
        ? 'Shortfall before deductions'
        : beforeKind.word === 'Surplus'
          ? 'Month-end available to allocate'
          : 'Break-even before deductions')
      : `${beforeKind.word} before planned spending`;
  const afterLabel = monthView
    ? (afterKind.lead === 'period-unavailable'
      ? 'After deductions'
      : afterKind.word === 'Shortfall'
        ? 'Shortfall after deductions'
        : afterKind.word === 'Surplus'
          ? 'Surplus after deductions'
          : 'Break-even after deductions')
    : (afterKind.lead === 'period-unavailable'
      ? 'After planned spending'
      : `${afterKind.word} after planned spending`);
  const lines = planningRoadPublishedLines(s2.commitments);
  const noun = planningRoadPayPeriodIsResidual(period)
    ? 'remainder through next payday'
    : planningRoadPeriodNoun(granularity);
  const caption = granularity === 'pay-period'
    ? `${planningRoadPayPeriodIdentity(period)} · from your Forecast plan`
    : `This ${noun} · from your Forecast plan`;
  const withheldNote = afterKind.lead === 'period-unavailable'
    ? ` Forecast has not published a result after planned spending for this ${noun}. It is not counted as $0.`
    : '';
  const afterAmount = afterKind.lead === 'period-unavailable'
    ? ''
    : ` data-road-lead-amount="${Number(afterResult.amount)}"`;
  return `<ol class="planning-road-decision" data-planning-road-decision="primary" data-planning-road-decision-granularity="${granularity || 'month'}">
    <li class="planning-road-decision-step planning-road-decision-${beforeKind.cls}" data-planning-road-decision-step="before" data-road-result-sign="${beforeKind.cls}">
      <span class="planning-road-decision-label">${beforeLabel}</span>
      <span class="planning-road-decision-amount">${planningRoadDecisionAmountHtml(s1.result, 'signed')}</span>
    </li>
    <li class="planning-road-decision-step" data-planning-road-decision-step="planned" data-planning-road-planned-lines="${lines.length ? 'named' : 'total-only'}">
      <span class="planning-road-decision-label">Planned spending</span>
      <span class="planning-road-decision-amount" data-planning-road-planned-amount="rollup">${planningRoadDecisionAmountHtml(s2.commitments, 'outflow')}</span>
      ${planningRoadDecisionLinesHtml(s2.commitments)}
    </li>
    <li class="planning-road-decision-step planning-road-decision-${afterKind.cls}" data-planning-road-decision-step="after" data-road-result-sign="${afterKind.cls}"${afterAmount}>
      <p class="planning-road-hero-kind">${afterKind.word}</p>
      <span class="planning-road-decision-label">${afterLabel}</span>
      <span class="planning-road-decision-amount">${planningRoadDecisionAmountHtml(afterResult, 'signed')}</span>
    </li>
  </ol>
  <p class="planning-road-hero-narrative">${caption}.${withheldNote ? ' ' + withheldNote.trim() : ''}</p>
  ${planningRoadStandaloneIdentityHtml(afterResult)}`;
}

/** Reprint Forecast's standalone identity. The phrase is included only when
 *  Forecast published one on this result. */
function planningRoadStandaloneIdentityHtml(result) {
  if (!result || result.identity !== 'standalone-period-surplus-deficit') return '';
  if (result.priorPeriodSurplus !== 'excluded') return '';
  const phrase = typeof result.phrase === 'string' ? result.phrase : '';
  return `<p class="planning-road-hero-narrative" data-road-standalone-phrase="${phrase ? 'forecast' : 'identity-only'}" data-road-surplus-deficit-identity="${result.identity}" data-road-prior-surplus="${result.priorPeriodSurplus}">${phrase}</p>`;
}

function planningRoadMonthIncomeTitle(period) {
  return period && period.start && period.end
    ? `Income received ${fmtDate(period.start)}–${fmtDate(period.end)}`
    : 'Income received in selected span';
}

function planningRoadMonthFundingLabel(result) {
  const kind = planningRoadDecisionKind(result);
  if (kind.cls === 'gap') return 'Shortfall before deductions';
  if (kind.cls === 'surplus') return 'Month-end available to allocate';
  if (kind.cls === 'neutral') return 'Break-even before deductions';
  return 'Before deductions';
}

function planningRoadAheadMonthIncomeHtml(income, period) {
  const lines = planningRoadPublishedLines(income);
  const rows = lines.length
    ? lines.map((row, i) => planningRoadWaterfallLineRow(row, `income-line-${i}`, false)).join('')
      + planningRoadWaterfallTotalRow('Total income', income, 'income-total', { signedResult: true })
    : planningRoadWaterfallTotalRow('Total income', income, 'income-total', { signedResult: true });
  return `<div class="planning-road-wf-block planning-road-wf-income" data-planning-road-wf="income" data-planning-road-income="calendar">
    <h3 class="planning-road-wf-kicker"><span class="planning-road-wf-badge planning-road-wf-badge-income" aria-hidden="true"></span> ${planningRoadMonthIncomeTitle(period)}</h3>
    <ul class="planning-road-wf-list">${rows}</ul>
  </div>`;
}

function planningRoadAheadMonthSurplusHtml(period) {
  const rows = Array.isArray(period.closingPayPeriods) ? period.closingPayPeriods : [];
  const lineRows = rows.map((row, i) => {
    const label = row.displayRange || row.payday || 'Pay period';
    const amount = Number(row.stage1);
    const sign = amount < 0 ? 'gap' : amount > 0 ? 'surplus' : 'neutral';
    return planningRoadWaterfallLineRow({
      label,
      amount: row.stage1,
      status: row.status || 'calculated',
      id: row.payday,
    }, `available-surplus-line-${i}`, false, sign);
  }).join('');
  const result = period.stage1 && period.stage1.result;
  const phrase = planningRoadAheadResultPhrase(result);
  return `<div class="planning-road-wf-block" data-planning-road-wf="available-surplus" data-road-result-sign="${phrase.cls}">
    <h3 class="planning-road-wf-kicker"><span class="planning-road-wf-badge planning-road-wf-badge-income" aria-hidden="true"></span> Pay periods closing this month</h3>
    ${lineRows ? `<ul class="planning-road-wf-list">${lineRows}</ul>` : ''}
  </div>`;
}

function planningRoadMonthCloseResultLabel(period, result) {
  const parts = planningRoadAheadMonthParts(period && period.month);
  const name = parts ? parts.long : 'This month';
  const kind = planningRoadDecisionKind(result);
  if (kind.lead === 'period-unavailable') return `${name} result after deductions`;
  if (kind.word === 'Shortfall') return `${name} shortfall after deductions`;
  if (kind.word === 'Surplus') return `${name} surplus after deductions`;
  return `${name} break-even after deductions`;
}

function planningRoadMonthBuildTitle(period, result) {
  const parts = planningRoadAheadMonthParts(period && period.month);
  const name = parts ? parts.long : 'this month';
  const kind = planningRoadDecisionKind(result);
  if (kind.lead === 'period-unavailable') return `How the ${name} result is built`;
  if (kind.word === 'Shortfall') return `How the ${name} shortfall is built`;
  if (kind.word === 'Break-even') return `How the ${name} break-even is built`;
  return `How the ${name} surplus is built`;
}

function planningRoadMonthTimingHtml(period) {
  const s2 = period.stage2 || {};
  const dateOrder = planningRoadStageResult(s2, 'month');
  const published = dateOrder && dateOrder.unavailableByDueDate;
  if (published && published.status !== 'unavailable'
      && published.amount != null && isFinite(Number(published.amount))
      && Number(published.amount) !== 0) {
    return `<ul class="planning-road-wf-list">${planningRoadWaterfallTotalRow(
      published.label || 'Not available by due date',
      published,
      'date-order-timing',
      { signedResult: true }
    )}</ul>`;
  }
  const arithmetic = s2.result;
  const both = dateOrder && arithmetic
    && dateOrder.status !== 'unavailable' && arithmetic.status !== 'unavailable'
    && dateOrder.amount != null && arithmetic.amount != null
    && isFinite(Number(dateOrder.amount)) && isFinite(Number(arithmetic.amount));
  if (both && Number(dateOrder.amount) !== Number(arithmetic.amount) && !published) {
    return `<p class="planning-road-wf-empty" data-planning-road-wf="date-order-timing" data-planning-road-timing="withheld">Forecast has not published how much later surplus was unavailable by the due date. These rows are not a straight subtraction.</p>`;
  }
  return '';
}

function planningRoadComponentApplies(component) {
  if (!component) return false;
  if (component.status === 'unavailable') return true;
  if (planningRoadPublishedLines(component).length) return true;
  return component.amount != null && isFinite(Number(component.amount)) && Number(component.amount) !== 0;
}

/** Close-month Stage 1 lines plus the published date-order result.
 *  Amounts are Forecast fields. This page does not sum them. */
function planningRoadAheadMonthReconciliationHtml(period) {
  const s1 = period.stage1 || {};
  const s2 = period.stage2 || {};
  const afterResult = planningRoadStageResult(s2, 'month');
  const incomeLines = planningRoadPublishedLines(s1.income);
  const incomeRows = incomeLines.length
    ? incomeLines.map((row, i) => planningRoadWaterfallLineRow(row, `close-income-line-${i}`, false)).join('')
      + planningRoadWaterfallTotalRow('Total income', s1.income, 'close-income-total', { signedResult: true })
    : planningRoadWaterfallTotalRow('Total income', s1.income, 'close-income-total', { signedResult: true });
  const billsBlock = planningRoadWaterfallExpandable('Bills', s1.bills, 'bills', {
    asOutflow: true, totalLabel: 'Total bills',
  });
  const obligationsBlock = planningRoadComponentApplies(s1.obligations)
    ? planningRoadWaterfallExpandable('Required debt payments', s1.obligations, 'obligations', {
      asOutflow: true, totalLabel: 'Total required debt payments',
    })
    : '';
  const budgetBlock = s1.householdBudget
    ? planningRoadWaterfallExpandable('Household budget', s1.householdBudget, 'household-budget', {
      asOutflow: true, totalLabel: 'Household Budget Total',
    })
    : '';
  const stage1Row = planningRoadWaterfallResultRow(
    planningRoadMonthFundingLabel(s1.result), s1.result, 'month-end-available');
  const plannedBlock = planningRoadWaterfallInlineSection(
    'Planned spending', s2.commitments, 'planned-spending', { asOutflow: true });
  const timing = planningRoadMonthTimingHtml(period);
  const afterRow = planningRoadWaterfallResultRow(
    planningRoadMonthCloseResultLabel(period, afterResult), afterResult, 'after-deductions');
  return `<div class="planning-road-wf-reconciliation" data-planning-road-wf="close-month-reconciliation">
    <h3 class="planning-road-wf-kicker">${planningRoadMonthBuildTitle(period, afterResult)}</h3>
    <div class="planning-road-wf-block planning-road-wf-income" data-planning-road-wf="close-income" data-planning-road-income="close-periods">
      <h3 class="planning-road-wf-kicker"><span class="planning-road-wf-badge planning-road-wf-badge-income" aria-hidden="true"></span> Income in closing pay periods</h3>
      <ul class="planning-road-wf-list">${incomeRows}</ul>
    </div>
    ${billsBlock}
    ${obligationsBlock}
    ${budgetBlock}
    ${stage1Row}
    ${plannedBlock}
    ${timing}
    ${afterRow}
  </div>`;
}

function planningRoadAheadMonthWaterfallHtml(period) {
  const s3 = period.stage3 || {};
  const finalResult = planningRoadStageResult(s3, 'month');
  const incomeBlock = planningRoadAheadMonthIncomeHtml(period.income, period);
  const surplusBlock = planningRoadAheadMonthSurplusHtml(period);
  const reconciliation = planningRoadAheadMonthReconciliationHtml(period);
  const extrasAmount = planningRoadFigure(s3.extras);
  const extrasUnavailable = s3.extras && (s3.extras.status === 'unavailable'
    || s3.extras.amount == null || !isFinite(Number(s3.extras.amount)));
  const extrasBlock = (extrasUnavailable || (extrasAmount != null && extrasAmount !== 0))
    ? planningRoadWaterfallInlineSection(
      'Extra debt payments', s3.extras, 'extra-debt', { asOutflow: true })
    : '';
  const finalPhrase = planningRoadAheadResultPhrase(finalResult);
  const finalLabel = finalPhrase.cls === 'gap' ? 'Final shortfall'
    : finalPhrase.cls === 'surplus' ? 'Final surplus'
    : 'Final result';
  const finalRow = planningRoadWaterfallResultRow(finalLabel, finalResult, 'final');
  const debtStrategy = `<div class="planning-road-debt-strategy" data-planning-road-wf="debt-strategy" data-planning-road-secondary="debt-strategy">
    <details>
    <summary>After debt strategy</summary>
    ${extrasBlock}
    ${finalRow}
    </details>
  </div>`;
  const key = planningRoadAheadPeriodKey(period, 'month') || '';
  return `<div class="planning-road-waterfall" data-planning-road-waterfall="ready" data-road-waterfall-period="${key}" data-road-waterfall-granularity="month">
    ${incomeBlock}
    ${surplusBlock}
    ${reconciliation}
    <p class="planning-road-wf-footnote">From your Forecast plan · this month.</p>
    ${debtStrategy}
  </div>`;
}

function planningRoadAheadWaterfallHtml(period, granularity) {
  if (!period) {
    return '<p class="lede" data-planning-road-waterfall="empty">Forecast published no funding lines for this period.</p>';
  }
  if (granularity !== 'pay-period') return planningRoadAheadMonthWaterfallHtml(period);
  const s1 = period.stage1 || {};
  const s2 = period.stage2 || {};
  const s3 = period.stage3 || {};
  const noun = planningRoadPeriodNoun(granularity);
  const incomeLines = planningRoadPublishedLines(s1.income);
  const incomeRows = incomeLines.length
    ? incomeLines.map((row, i) => planningRoadWaterfallLineRow(row, `income-line-${i}`, false)).join('')
      + planningRoadWaterfallTotalRow('Income total', s1.income, 'income-total', { signedResult: true })
    : planningRoadWaterfallTotalRow('Income total', s1.income, 'income-total', { signedResult: true });
  const incomeBlock = `<div class="planning-road-wf-block planning-road-wf-income" data-planning-road-wf="income">
    <h3 class="planning-road-wf-kicker"><span class="planning-road-wf-badge planning-road-wf-badge-income" aria-hidden="true"></span> Income</h3>
    <ul class="planning-road-wf-list">${incomeRows}</ul>
  </div>`;
  const billsBlock = planningRoadWaterfallExpandable('Bills', s1.bills, 'bills', { asOutflow: true });
  const obligationsBlock = s1.obligations
    ? planningRoadWaterfallExpandable('Required debt payments', s1.obligations, 'obligations', { asOutflow: true })
    : '';
  const budgetBlock = s1.householdBudget
    ? planningRoadWaterfallExpandable('Household budget', s1.householdBudget, 'household-budget', { asOutflow: true })
    : '';
  const afterPhrase = planningRoadAheadResultPhrase(s1.result);
  const afterLabel = afterPhrase.cls === 'gap' ? 'Shortfall after normal obligations'
    : afterPhrase.cls === 'surplus' ? 'Surplus after normal obligations'
    : (s1.result && s1.result.amount === 0) ? 'Break-even after normal obligations'
    : 'After normal obligations';
  const afterObligations = planningRoadWaterfallResultRow(afterLabel, s1.result, 'after-obligations');
  const plannedBlock = planningRoadWaterfallInlineSection(
    'Planned spending', s2.commitments, 'planned-spending', { asOutflow: true });
  const extrasAmount = planningRoadFigure(s3.extras);
  const extrasUnavailable = s3.extras && (s3.extras.status === 'unavailable'
    || s3.extras.amount == null || !isFinite(Number(s3.extras.amount)));
  const extrasBlock = (extrasUnavailable || (extrasAmount != null && extrasAmount !== 0))
    ? planningRoadWaterfallInlineSection(
      'Extra debt payments', s3.extras, 'extra-debt', { asOutflow: true })
    : '';
  const finalPhrase = planningRoadAheadResultPhrase(s3.result);
  const finalLabel = finalPhrase.cls === 'gap' ? 'Final shortfall'
    : finalPhrase.cls === 'surplus' ? 'Final surplus'
    : 'Final result';
  const finalRow = planningRoadWaterfallResultRow(finalLabel, s3.result, 'final');
  const standaloneNote = planningRoadStandalonePhraseHtml(s3.result);
  const debtStrategy = `<div class="planning-road-debt-strategy" data-planning-road-wf="debt-strategy" data-planning-road-secondary="debt-strategy">
    <details>
    <summary>After debt strategy</summary>
    ${extrasBlock}
    ${finalRow}
    ${standaloneNote}
    </details>
  </div>`;
  const key = planningRoadAheadPeriodKey(period, granularity) || '';
  return `<div class="planning-road-waterfall" data-planning-road-waterfall="ready" data-road-waterfall-period="${key}" data-road-waterfall-granularity="${granularity || 'month'}">
    ${incomeBlock}
    ${billsBlock}
    ${obligationsBlock}
    ${budgetBlock}
    ${afterObligations}
    ${plannedBlock}
    <p class="planning-road-wf-footnote">From your Forecast plan · this ${noun}.</p>
    ${debtStrategy}
  </div>`;
}

/** Reprint Forecast's standalone-period phrase. The page does not write it. */
function planningRoadStandalonePhraseHtml(result) {
  if (!result || result.identity !== 'standalone-period-surplus-deficit') return '';
  if (result.priorPeriodSurplus !== 'excluded') return '';
  if (typeof result.phrase !== 'string' || !result.phrase) return '';
  return `<p class="planning-road-hero-narrative" data-road-standalone-phrase="forecast" data-road-surplus-deficit-identity="${result.identity}" data-road-prior-surplus="${result.priorPeriodSurplus}">${result.phrase}</p>`;
}

function planningTrajectoryIncomeHtml(income) {
  if (!income || income.status === 'unavailable') {
    const reason = income && income.reason
      ? income.reason
      : 'Forecast unavailable.';
    return `<span class="chip c">Forecast unavailable</span><small class="planning-trajectory-reason">${reason}</small>`;
  }
  const amount = income.amount != null && isFinite(Number(income.amount))
    ? `<b>${money2(income.amount)}</b>` : '';
  return `${amount}${planningTrajectoryChip(income.status)}`;
}

function planningTrajectoryCashHtml(cash) {
  if (!cash || cash.status === 'unavailable') {
    const reason = cash && cash.reason
      ? cash.reason
      : 'Forecast unavailable.';
    return `<span class="chip c">Forecast unavailable</span><small class="planning-trajectory-reason">${reason}</small>`;
  }
  const amount = cash.amount != null && isFinite(Number(cash.amount))
    ? `<b>${money2(cash.amount)}</b>` : '';
  const asOf = cash.asOf
    ? `<small data-trajectory-cash-asof="${cash.asOf}">at period end · ${fmtDateFull(cash.asOf)}</small>`
    : '';
  return `${amount}${planningTrajectoryChip(cash.status)}${asOf}`;
}

const PLANNING_PRESSURE_KIND = {
  'lowest-projected-cash': 'Lowest projected cash on this walk',
  'cash-trough': 'Lowest cash within the month',
  'cash-sign-change': 'Cash turns negative after being positive',
  'month-cash-decline': 'Month-end cash falls versus the prior month',
  'outflow-exceeds-inflow': 'Outflows exceed inflows in the month',
  'dated-commitment': 'Dated commitment on the walk',
  'debt-increase': 'Total modelled debt increases',
  'debt-not-declining-after-payment': 'Debt does not fall after a payment',
  'debt-limit-crossing': 'Credit limit crossing on the walk',
};

const PLANNING_ATTRIBUTION_DRIVER = {
  'income-timing': 'Income timing',
  'bonus-timing': 'Bonus timing',
  'household-budget': 'Household budget spending',
  'recurring-bills': 'Recurring bills',
  'debt-payment': 'Debt payment',
  'debt-interest': 'Debt interest',
  'dated-commitment': 'Dated commitment',
  'mortgage-or-major-obligation': 'Mortgage or major obligation',
};

const PLANNING_ATTRIBUTION_FACT = {
  'income-timing': 'Income timing',
  'payroll-deduction-regime': 'Payroll deduction change',
};

const PLANNING_PAY_CADENCE = {
  'two-pay-month': 'Two-pay month',
  'three-pay-month': 'Three-pay month',
};

function planningTrajectoryPressureAmountField(label, amount) {
  if (amount == null || !isFinite(Number(amount))) return '';
  return `<small class="planning-trajectory-pressure-field"><span>${label}</span> <b>${money2(amount)}</b></small>`;
}

function planningTrajectoryPressureTextField(label, value) {
  if (value == null || value === '') return '';
  return `<small class="planning-trajectory-pressure-field"><span>${label}</span> ${value}</small>`;
}

function planningAttributionDriverLabel(className) {
  return PLANNING_ATTRIBUTION_DRIVER[className] || className || '';
}

function planningAttributionFactLabel(className) {
  return PLANNING_ATTRIBUTION_FACT[className] || className || '';
}

function planningTrajectoryAttributionDriverHtml(driver, index) {
  if (!driver || !driver.class) return '';
  const label = planningAttributionDriverLabel(driver.class);
  const parts = [`<span class="planning-trajectory-attribution-driver-kind">${label}</span>`];
  if (driver.amount != null && isFinite(Number(driver.amount))) {
    parts.push(`<b>${money2(driver.amount)}</b>`);
  }
  const meta = [];
  if (driver.count != null && isFinite(Number(driver.count))) {
    meta.push(planningTrajectoryPressureTextField('Count', String(driver.count)));
  }
  if (driver.id) meta.push(planningTrajectoryPressureTextField('Id', driver.id));
  if (driver.label) meta.push(planningTrajectoryPressureTextField('Label', driver.label));
  if (driver.date) meta.push(planningTrajectoryPressureTextField('Date', fmtDateFull(driver.date)));
  return `<li class="planning-trajectory-attribution-driver" data-trajectory-attribution-driver-index="${index}" data-trajectory-attribution-driver-class="${driver.class}">${parts.join(' ')}${meta.join('')}</li>`;
}

function planningTrajectoryAttributionFactHtml(fact, index) {
  if (!fact || !fact.class) return '';
  const label = planningAttributionFactLabel(fact.class);
  const parts = [`<span class="planning-trajectory-attribution-fact-kind">${label}</span>`];
  const meta = [];
  if (fact.class === 'income-timing') {
    if (fact.cadence && PLANNING_PAY_CADENCE[fact.cadence]) {
      meta.push(planningTrajectoryPressureTextField('Cadence', PLANNING_PAY_CADENCE[fact.cadence]));
    } else if (fact.cadence) {
      meta.push(planningTrajectoryPressureTextField('Cadence', fact.cadence));
    }
    if (fact.count != null && isFinite(Number(fact.count))) {
      meta.push(planningTrajectoryPressureTextField('Pay count', String(fact.count)));
    }
    if (fact.id) meta.push(planningTrajectoryPressureTextField('Id', fact.id));
    if (fact.label) meta.push(planningTrajectoryPressureTextField('Label', fact.label));
  }
  if (fact.class === 'payroll-deduction-regime') {
    if (fact.date) meta.push(planningTrajectoryPressureTextField('Date', fmtDateFull(fact.date)));
    if (fact.priorDate) meta.push(planningTrajectoryPressureTextField('Prior date', fmtDateFull(fact.priorDate)));
    meta.push(planningTrajectoryPressureAmountField('Gross', fact.gross));
    meta.push(planningTrajectoryPressureAmountField('Net', fact.net));
    meta.push(planningTrajectoryPressureAmountField('Prior net', fact.priorNet));
    meta.push(planningTrajectoryPressureAmountField('Deduction change', fact.deductionDelta));
  }
  return `<li class="planning-trajectory-attribution-fact" data-trajectory-attribution-fact-index="${index}" data-trajectory-attribution-fact-class="${fact.class}">${parts.join(' ')}${meta.join('')}</li>`;
}

function planningTrajectoryAttributionHtml(attribution) {
  if (!attribution || typeof attribution !== 'object') {
    return `<div class="planning-trajectory-pressure-attribution" data-trajectory-pressure-attribution="unavailable"><small class="planning-trajectory-reason">Forecast did not publish attribution for this signal.</small></div>`;
  }
  if (attribution.status === 'ready') {
    const change = attribution.change != null && isFinite(Number(attribution.change))
      ? `<small class="planning-trajectory-attribution-change"><span>Attributed change</span> <b>${money2(attribution.change)}</b></small>`
      : '';
    const drivers = Array.isArray(attribution.drivers) ? attribution.drivers : [];
    const driverList = drivers.length
      ? `<ul class="planning-trajectory-attribution-drivers">${drivers.map((d, i) => planningTrajectoryAttributionDriverHtml(d, i)).join('')}</ul>`
      : '';
    const facts = Array.isArray(attribution.facts) ? attribution.facts : [];
    const factList = facts.length
      ? `<ul class="planning-trajectory-attribution-facts">${facts.map((f, i) => planningTrajectoryAttributionFactHtml(f, i)).join('')}</ul>`
      : '';
    return `<div class="planning-trajectory-pressure-attribution" data-trajectory-pressure-attribution="ready">${change}${driverList}${factList}</div>`;
  }
  const reason = attribution.reason || 'Walk-derived drivers could not be established.';
  return `<div class="planning-trajectory-pressure-attribution" data-trajectory-pressure-attribution="unavailable"><small class="planning-trajectory-reason">${reason}</small></div>`;
}

function planningTrajectoryPressureSignalHtml(signal, index) {
  if (!signal || !signal.kind) return '';
  const kindLabel = PLANNING_PRESSURE_KIND[signal.kind] || signal.kind;
  const attrs = [
    `data-trajectory-pressure-index="${index}"`,
    `data-trajectory-pressure-kind="${signal.kind}"`,
  ];
  if (signal.month) attrs.push(`data-trajectory-pressure-month="${signal.month}"`);
  if (signal.date) attrs.push(`data-trajectory-pressure-date="${signal.date}"`);
  if (signal.trust) attrs.push(`data-trajectory-pressure-trust="${signal.trust}"`);
  if (signal.id) attrs.push(`data-trajectory-pressure-id="${signal.id}"`);
  if (signal.asOf) attrs.push(`data-trajectory-pressure-asof="${signal.asOf}"`);
  if (signal.debtId) attrs.push(`data-trajectory-pressure-debt-id="${signal.debtId}"`);
  const fields = [];
  if (signal.date) fields.push(planningTrajectoryPressureTextField('Date', fmtDateFull(signal.date)));
  if (signal.month) fields.push(planningTrajectoryPressureTextField('Month', signal.month));
  fields.push(planningTrajectoryPressureAmountField('Amount', signal.amount));
  fields.push(planningTrajectoryPressureAmountField('From amount', signal.fromAmount));
  fields.push(planningTrajectoryPressureAmountField('To amount', signal.toAmount));
  fields.push(planningTrajectoryPressureAmountField('Change', signal.delta));
  fields.push(planningTrajectoryPressureAmountField('Inflow', signal.inflow));
  fields.push(planningTrajectoryPressureAmountField('Outflow', signal.outflow));
  fields.push(planningTrajectoryPressureAmountField('Net', signal.net));
  fields.push(planningTrajectoryPressureAmountField('Cash after', signal.cashAfter));
  fields.push(planningTrajectoryPressureAmountField('From total', signal.fromTotal));
  fields.push(planningTrajectoryPressureAmountField('To total', signal.toTotal));
  fields.push(planningTrajectoryPressureAmountField('Paid', signal.paidDelta));
  fields.push(planningTrajectoryPressureAmountField('Consumer change', signal.consumerDelta));
  fields.push(planningTrajectoryPressureAmountField('Secured change', signal.securedDelta));
  fields.push(planningTrajectoryPressureAmountField('HELOC change', signal.helocDelta));
  fields.push(planningTrajectoryPressureAmountField('Limit', signal.limit));
  if (signal.fromMonth) fields.push(planningTrajectoryPressureTextField('From month', signal.fromMonth));
  if (signal.fromAsOf) fields.push(planningTrajectoryPressureTextField('From as-of', fmtDateFull(signal.fromAsOf)));
  if (signal.asOf) fields.push(planningTrajectoryPressureTextField('As-of', fmtDateFull(signal.asOf)));
  if (signal.start && signal.end) {
    fields.push(planningTrajectoryPressureTextField('Period', `${fmtDateFull(signal.start)} – ${fmtDateFull(signal.end)}`));
  }
  if (signal.id) fields.push(planningTrajectoryPressureTextField('Id', signal.id));
  if (signal.debtId) fields.push(planningTrajectoryPressureTextField('Debt id', signal.debtId));
  if (signal.label) fields.push(planningTrajectoryPressureTextField('Label', signal.label));
  if (signal.alreadyOver === true) fields.push('<small class="planning-trajectory-pressure-field"><span>Already over limit</span> yes</small>');
  if (signal.trust === 'calculated' || signal.trust === 'estimated') {
    fields.push(planningTrajectoryChip(signal.trust));
  }
  const attribution = planningTrajectoryAttributionHtml(signal.attribution);
  return `<li class="planning-trajectory-pressure-item"${attrs.length ? ' ' + attrs.join(' ') : ''}><span class="planning-trajectory-pressure-kind">${kindLabel}</span>${fields.join('')}${attribution}</li>`;
}

function planningTrajectoryPressureHtml(traj) {
  const note = 'Pressure signals and their cause attribution are Forecast.baselineTrajectory.pressure only — mechanical facts and walk-derived drivers from the Forecast projection. This page copies them in Forecast order; it does not score, rank, or compute pressure or attribution.';
  const pressure = traj && traj.pressure;
  if (!pressure || pressure.status !== 'ready') {
    const reason = (pressure && pressure.reason) || (traj && traj.reason) || 'Baseline trajectory pressure unavailable.';
    return {
      lede: '',
      list: `<div class="note-box crit" data-trajectory-pressure="unavailable">${reason}</div>`,
      note,
    };
  }
  const signals = Array.isArray(pressure.signals) ? pressure.signals : [];
  if (!signals.length) {
    return {
      lede: 'Forecast published no pressure signals in this projection.',
      list: '<p class="lede" data-trajectory-pressure="empty">No pressure signals on this walk.</p>',
      note,
    };
  }
  const items = signals.map((signal, index) => planningTrajectoryPressureSignalHtml(signal, index)).join('');
  return {
    lede: `${signals.length} pressure signal${signals.length === 1 ? '' : 's'} in this projection, in Forecast order.`,
    list: `<ol class="planning-trajectory-pressure-list" data-trajectory-pressure="ready">${items}</ol>`,
    note,
  };
}

const PLANNING_DEBT_DIRECTION_LABEL = {
  declining: 'Declining',
  persistent: 'Persistent',
  increasing: 'Increasing',
};

function planningTrajectoryDebtDirectionInterestHtml(interest) {
  if (!interest || typeof interest !== 'object') {
    return '<small class="planning-trajectory-reason">Interest was not published.</small>';
  }
  if (interest.status === 'calculated' && interest.amount != null && isFinite(Number(interest.amount))) {
    return `${planningTrajectoryPressureAmountField('Interest', interest.amount)}${planningTrajectoryChip('calculated')}`;
  }
  const reason = interest.reason || 'Interest was not established on the coupled walk.';
  return `<span class="chip c">Forecast unavailable</span><small class="planning-trajectory-reason">${reason}</small>`;
}

function planningTrajectoryDebtDirectionBalanceHtml(label, balance) {
  if (!balance || balance.direction == null) return '';
  const dirLabel = PLANNING_DEBT_DIRECTION_LABEL[balance.direction] || balance.direction;
  const fields = [
    planningTrajectoryPressureTextField('Direction', dirLabel),
    planningTrajectoryPressureAmountField('Opening', balance.opening),
    planningTrajectoryPressureAmountField('Ending', balance.ending),
    planningTrajectoryPressureAmountField('Change', balance.delta),
  ].filter(Boolean).join('');
  return `<div class="planning-trajectory-debt-direction-balance" data-trajectory-debt-direction-balance="${label}">${fields}</div>`;
}

function planningTrajectoryDebtDirectionIdListHtml(kind, ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!list.length) {
    return `<p class="lede planning-trajectory-debt-direction-idlist" data-trajectory-debt-direction-${kind}="none">No ${kind} debts.</p>`;
  }
  const items = list.map(id => `<li data-trajectory-debt-direction-debt-id="${id}">${id}</li>`).join('');
  return `<ul class="planning-trajectory-debt-direction-idlist" data-trajectory-debt-direction-${kind}="ready">${items}</ul>`;
}

function planningTrajectoryDebtDirectionDebtHtml(debt, index) {
  if (!debt || !debt.id) return '';
  const dirLabel = PLANNING_DEBT_DIRECTION_LABEL[debt.direction] || debt.direction || '';
  const attrs = [
    `data-trajectory-debt-direction-index="${index}"`,
    `data-trajectory-debt-direction-debt-id="${debt.id}"`,
    debt.direction ? `data-trajectory-debt-direction-direction="${debt.direction}"` : '',
  ].filter(Boolean);
  const fields = [
    planningTrajectoryPressureTextField('Label', debt.label || debt.id),
    planningTrajectoryPressureTextField('Direction', dirLabel),
    planningTrajectoryPressureAmountField('Opening', debt.opening),
    planningTrajectoryPressureAmountField('Ending', debt.ending),
    planningTrajectoryPressureAmountField('Change', debt.delta),
    planningTrajectoryPressureAmountField('Paid on walk', debt.paid),
  ].filter(Boolean).join('');
  const interest = planningTrajectoryDebtDirectionInterestHtml(debt.interest);
  let milestone = '';
  if (debt.milestone && debt.milestone.kind === 'cleared-within-published-horizon') {
    const m = debt.milestone;
    milestone = `<div class="planning-trajectory-debt-direction-milestone" data-trajectory-debt-direction-milestone="${m.kind}"${m.month ? ` data-trajectory-debt-direction-milestone-month="${m.month}"` : ''}${m.asOf ? ` data-trajectory-debt-direction-milestone-asof="${m.asOf}"` : ''}>`
      + '<small class="planning-trajectory-pressure-field"><span>Cleared within projection window</span> '
      + `${m.month ? `month ${m.month}` : 'month unknown'}`
      + `${m.asOf ? ` (as-of ${fmtDateFull(m.asOf)})` : ''}`
      + '</small></div>';
  }
  const title = debt.label ? `${debt.label} (${debt.id})` : debt.id;
  return `<li class="planning-trajectory-debt-direction-item"${attrs.length ? ' ' + attrs.join(' ') : ''}><span class="planning-trajectory-debt-direction-debt-title">${title}</span>${fields}${interest}${milestone}</li>`;
}

function planningTrajectoryDebtDirectionHtml(traj) {
  const note = 'Debt direction is Forecast.baselineTrajectory.debtDirection only — as-of opening versus the last published month-end on the coupled walk. This page copies the household picture, per-debt facts, and id lists in Forecast order; it does not rank debts, recommend which debt to pay first, or compute direction. Persistent means unchanged at whole-cent identity only. When Forecast publishes availableCreditIsNotCash, available credit is not cash.';
  const dd = traj && traj.debtDirection;
  if (!dd || dd.status !== 'ready') {
    const reason = (dd && dd.reason) || (traj && traj.reason) || 'Baseline trajectory debt direction unavailable.';
    return {
      lede: '',
      list: `<div class="note-box crit" data-trajectory-debt-direction="unavailable">${reason}</div>`,
      note,
    };
  }
  const household = dd.household || {};
  const householdDir = PLANNING_DEBT_DIRECTION_LABEL[household.direction] || household.direction || '';
  const householdBlock = `<div class="planning-trajectory-debt-direction-household" data-trajectory-debt-direction-household-direction="${household.direction || ''}">`
    + `<p class="lede"><strong>Household total</strong> — ${householdDir || 'direction withheld'} from opening to last published month-end.</p>`
    + planningTrajectoryDebtDirectionBalanceHtml('total', household)
    + planningTrajectoryDebtDirectionBalanceHtml('consumer', household.consumer)
    + planningTrajectoryDebtDirectionBalanceHtml('secured', household.secured)
    + planningTrajectoryDebtDirectionBalanceHtml('heloc', household.heloc)
    + (household.paid != null && isFinite(Number(household.paid))
      ? planningTrajectoryPressureAmountField('Paid on walk (household)', household.paid) : '')
    + planningTrajectoryDebtDirectionInterestHtml(household.interest)
    + '</div>';
  const flags = [];
  if (dd.anySupportedIncrease === true) {
    flags.push('<small class="planning-trajectory-pressure-field"><span>Any supported increase</span> yes</small>');
  } else if (dd.anySupportedIncrease === false) {
    flags.push('<small class="planning-trajectory-pressure-field"><span>Any supported increase</span> no</small>');
  }
  if (dd.inventedBorrowing === false) {
    flags.push('<small class="planning-trajectory-pressure-field"><span>Invented borrowing</span> no (Forecast)</small>');
  }
  if (dd.availableCreditIsNotCash === true) {
    flags.push('<small class="planning-trajectory-pressure-field"><span>Available credit is not cash</span> yes (Forecast)</small>');
  }
  const span = (dd.from && dd.through)
    ? `From ${fmtDateFull(dd.from)} through ${fmtDateFull(dd.through)}.`
    : '';
  const idLists = `<div class="planning-trajectory-debt-direction-groups">`
    + '<p class="subhead">Declining</p>' + planningTrajectoryDebtDirectionIdListHtml('declining', dd.declining)
    + '<p class="subhead">Persistent</p>' + planningTrajectoryDebtDirectionIdListHtml('persistent', dd.persistent)
    + '<p class="subhead">Increasing</p>' + planningTrajectoryDebtDirectionIdListHtml('increasing', dd.increasing)
    + '</div>';
  const debts = Array.isArray(dd.debts) ? dd.debts : [];
  const debtItems = debts.map((debt, index) => planningTrajectoryDebtDirectionDebtHtml(debt, index)).join('');
  const debtList = debtItems
    ? `<ol class="planning-trajectory-debt-direction-list" data-trajectory-debt-direction-debts="ready">${debtItems}</ol>`
    : '<p class="lede" data-trajectory-debt-direction-debts="empty">Forecast published no per-debt direction rows.</p>';
  return {
    lede: span + (debts.length
      ? ` ${debts.length} modelled debt${debts.length === 1 ? '' : 's'} with direction across the projection window.`
      : ' Household direction with no per-debt rows.'),
    list: `<div class="planning-trajectory-debt-direction" data-trajectory-debt-direction="ready">${flags.join('')}${householdBlock}${idLists}${debtList}</div>`,
    note,
  };
}

function planningTrajectoryFundingUnavailableHtml(stageOrResult) {
  const reason = (stageOrResult && stageOrResult.reason)
    ? stageOrResult.reason
    : 'Forecast unavailable.';
  return `<span class="chip c">Forecast unavailable</span><small class="planning-trajectory-reason">${reason}</small>`;
}

function planningTrajectoryFundingComponentHtml(label, component, dataKey) {
  if (!component || component.status === 'unavailable') {
    if (!component || !component.reason) return '';
    return `<div class="planning-trajectory-funding-component unavailable" data-trajectory-funding-component="${dataKey || label}">${planningTrajectoryFundingUnavailableHtml(component)}</div>`;
  }
  if (component.amount == null || !isFinite(Number(component.amount))) return '';
  const chip = component.status ? planningTrajectoryChip(component.status) : '';
  return `<div class="planning-trajectory-funding-component" data-trajectory-funding-component="${dataKey || label}"><span class="planning-trajectory-funding-component-label">${label}</span> <b>${money2(component.amount)}</b>${chip}</div>`;
}

function planningTrajectoryFundingResultHtml(result) {
  if (!result || result.status === 'unavailable') {
    return `<div class="planning-trajectory-funding-result unavailable" data-trajectory-funding-result="unavailable">${planningTrajectoryFundingUnavailableHtml(result || {})}</div>`;
  }
  if (result.amount == null || !isFinite(Number(result.amount))) {
    return `<div class="planning-trajectory-funding-result unavailable" data-trajectory-funding-result="unavailable">${planningTrajectoryFundingUnavailableHtml({ reason: 'Forecast did not publish a result for this stage.' })}</div>`;
  }
  const chip = result.status ? planningTrajectoryChip(result.status) : '';
  const sign = Number(result.amount) < 0 ? 'gap' : Number(result.amount) > 0 ? 'surplus' : 'neutral';
  return `<div class="planning-trajectory-funding-result" data-trajectory-funding-result="ready" data-trajectory-funding-result-sign="${sign}"><b>${money2(result.amount)}</b>${chip}</div>`;
}

/** Forecast's published figure for one stage result or component, or null when
 *  Forecast withheld it. Null stays null — it is never read as $0. */
function planningRoadFigure(node) {
  if (!node || node.status === 'unavailable') return null;
  if (node.amount == null || !isFinite(Number(node.amount))) return null;
  return Number(node.amount);
}

function planningRoadPeriodNoun(granularity) {
  return granularity === 'pay-period' ? 'pay period' : 'month';
}

function planningRoadPayPeriodIsResidual(period) {
  return !!(period && period.windowKind === 'as-of-residual');
}

function planningRoadPayPeriodIdentity(period) {
  return (period && period.displayIdentity) || 'Pay period';
}

/** DESIGN §4 "what's included" line — the household wording for the inputs
 *  Forecast already folded into this stage. */
function planningRoadStageIncludes(stageNum, granularity, monthName, period) {
  if (stageNum === 1) {
    return 'Income minus bills, required debt payments and your household budget';
  }
  if (stageNum === 2) {
    const when = monthName
      ? monthName
      : (planningRoadPayPeriodIsResidual(period)
        ? 'the remainder through next payday'
        : ('this ' + planningRoadPeriodNoun(granularity)));
    return `Adds the dated spending you have planned for ${when}`;
  }
  return 'Adds the extra debt payment in your current plan';
}

/** Frame 03 plain-language note. Every branch is chosen from the sign of a
 *  figure Forecast published and reprints that figure; nothing is derived. */
function planningRoadStageNarrative(period, stageNum, granularity, monthName) {
  const residual = planningRoadPayPeriodIsResidual(period);
  const noun = residual ? 'remainder through next payday' : planningRoadPeriodNoun(granularity);
  const subject = monthName ? `${monthName}'s` : (residual ? 'This remainder through next payday\'s' : `this ${noun}'s`);
  const coveredWhere = residual ? 'through next payday' : `this ${noun}`;
  const s1 = planningRoadFigure(period.stage1 && period.stage1.result);
  const s2 = planningRoadFigure(planningRoadStageResult(period.stage2, granularity));
  const s3 = planningRoadFigure(planningRoadStageResult(period.stage3, granularity));
  if (stageNum === 1) {
    if (s1 == null) {
      return `Forecast has not published a normal-life result for this ${noun}. It is not counted as $0.`;
    }
    if (s1 > 0) {
      return `Your regular household costs are covered ${coveredWhere}, with ${money2(s1)} left over.`;
    }
    if (s1 === 0) {
      return `Your regular household costs use exactly the income Forecast projects for this ${noun}.`;
    }
    return `Your regular household costs are more than the income Forecast projects for this ${noun}.`;
  }
  if (stageNum === 2) {
    const commitments = planningRoadFigure(period.stage2 && period.stage2.commitments);
    if (commitments == null) {
      return `Forecast has not published planned spending for this ${noun}. It is not counted as $0.`;
    }
    if (commitments === 0) {
      return `Forecast has no dated spending planned for this ${noun}.`;
    }
    if (s2 == null) {
      return `${subject} planned spending of ${money2(commitments)} is counted here; Forecast has not published the running total.`;
    }
    if (s2 < 0 && s1 != null && s1 >= 0) {
      return `${subject} planned spending of ${money2(commitments)} is more than the normal-life surplus.`;
    }
    if (s2 < 0) {
      return `${subject} planned spending of ${money2(commitments)} adds to the shortfall already in normal life.`;
    }
    if (s2 === 0) {
      return `${subject} planned spending of ${money2(commitments)} lands at break-even, leaving ${money2(0)}.`;
    }
    return `${subject} planned spending of ${money2(commitments)} still leaves a projected surplus.`;
  }
  const extras = planningRoadFigure(period.stage3 && period.stage3.extras);
  if (extras == null) {
    return `Forecast has not published the extra debt payment for this ${noun}. It is not counted as $0.`;
  }
  if (extras === 0) {
    return `Your current plan has no extra debt payment in this ${noun}.`;
  }
  if (s3 == null) {
    return `The planned ${money2(extras)} extra payment is counted here; Forecast has not published the running total.`;
  }
  if (s3 < 0 && s2 != null && s2 < 0) {
    return `The planned ${money2(extras)} extra payment widens ${subject} gap.`;
  }
  if (s3 < 0) {
    return `The planned ${money2(extras)} extra payment turns this ${noun} into a funding gap.`;
  }
  if (s3 === 0) {
    return `The planned ${money2(extras)} extra payment lands at break-even, leaving ${money2(0)}.`;
  }
  return `The planned ${money2(extras)} extra payment still leaves a projected surplus.`;
}

/** Frame 03 delta pill. The leading minus is the direction Forecast published
 *  the component in — stage 2 and stage 3 subtract it — not page arithmetic. */
function planningRoadStageDeltaPill(stage, stageNum) {
  if (stageNum === 2) {
    const commitments = stage && stage.commitments;
    const amount = planningRoadFigure(commitments);
    if (commitments && amount == null) {
      return `<span class="planning-road-stage-pill unavailable" data-road-stage-delta="commitments">${planningRoadAmountReprint({ status: 'unavailable' })} planned spending</span>`;
    }
    if (amount == null || amount === 0) return '';
    return `<span class="planning-road-stage-pill" data-road-stage-delta="commitments">−${money2(amount)} planned spending</span>`;
  }
  if (stageNum === 3) {
    const extras = stage && stage.extras;
    const amount = planningRoadFigure(extras);
    if (extras && amount == null) {
      return `<span class="planning-road-stage-pill unavailable" data-road-stage-delta="extras">${planningRoadAmountReprint({ status: 'unavailable' })} extra debt payment</span>`;
    }
    if (amount == null || amount === 0) return '';
    return `<span class="planning-road-stage-pill" data-road-stage-delta="extras">−${money2(amount)} extra debt payment</span>`;
  }
  return '';
}

function planningTrajectoryFundingStageHtml(stage, stageNum, stageOpts) {
  if (!stage) return '';
  const omitComponentDetails = stageOpts && stageOpts.omitComponentDetails === true;
  const label = stage.label || (stageNum === 1 ? 'Normal life' : stageNum === 2 ? 'After planned spending' : 'After debt strategy');
  const fableStage = stageOpts && stageOpts.fableStage === true;
  const fableCls = fableStage ? ` planning-road-fable-stage planning-road-fable-stage-${stageNum} planning-road-spine-step` : '';
  const tag = fableStage ? 'li' : 'article';
  const stageIndex = fableStage
    ? `<span class="planning-road-stage-index planning-road-spine-index" aria-hidden="true">${stageNum}</span>`
    : '';
  const attrs = [
    `data-trajectory-funding-stage="${stageNum}"`,
    stage.id ? `data-trajectory-funding-stage-id="${stage.id}"` : '',
    stage.status ? `data-trajectory-funding-stage-status="${stage.status}"` : '',
  ].filter(Boolean).join(' ');
  if (stage.status === 'unavailable') {
    const body = fableStage
      ? `${stageIndex}<div class="planning-road-spine-body"><div class="planning-road-stage-card">
        <div class="planning-road-stage-headrow">
          <h3 class="planning-trajectory-funding-stage-title">${label}</h3>
          <div class="planning-trajectory-funding-result" data-trajectory-funding-result="unavailable">${planningRoadAmountReprint({ status: 'unavailable' })}</div>
        </div>
        <p class="planning-road-stage-note">${stage.reason || 'Forecast has not published this stage. It is not counted as $0.'}</p>
      </div></div>`
      : `<h3 class="planning-trajectory-funding-stage-title">${label}</h3>${planningTrajectoryFundingUnavailableHtml(stage)}`;
    return `<${tag} class="planning-trajectory-funding-stage unavailable${fableCls}"${attrs.length ? ' ' + attrs : ''}>${body}</${tag}>`;
  }
  const componentParts = [];
  if (stageNum === 1) {
    componentParts.push(planningTrajectoryFundingComponentHtml('Income', stage.income, 'income'));
    componentParts.push(planningTrajectoryFundingComponentHtml('Bills', stage.bills, 'bills'));
    componentParts.push(planningTrajectoryFundingComponentHtml('Debt obligations', stage.obligations, 'obligations'));
    if (stage.householdBudget) {
      let hb = planningTrajectoryFundingComponentHtml('Household Budget', stage.householdBudget, 'household-budget');
      if (stage.householdBudget.weeklyVariable != null && isFinite(Number(stage.householdBudget.weeklyVariable))) {
        hb += planningTrajectoryPressureTextField('Weekly variable', money2(stage.householdBudget.weeklyVariable));
      }
      if (stage.householdBudget.walkDays != null && isFinite(Number(stage.householdBudget.walkDays))) {
        const walkDaysLabel = stage.householdBudget.identity
          && /pay-period/i.test(stage.householdBudget.identity)
          ? 'Walk days in pay period'
          : 'Walk days in month';
        hb += planningTrajectoryPressureTextField(walkDaysLabel, String(stage.householdBudget.walkDays));
      }
      if (hb) componentParts.push(hb);
    }
  } else if (stageNum === 2) {
    componentParts.push(planningTrajectoryFundingComponentHtml('Dated commitments', stage.commitments, 'commitments'));
  } else if (stageNum === 3 && stage.extras) {
    let extras = planningTrajectoryFundingComponentHtml('Extra debt payments', stage.extras, 'extras');
    if (stage.extras.source) {
      extras += planningTrajectoryPressureTextField('Source', stage.extras.source);
    }
    if (extras) componentParts.push(extras);
  }
  const components = componentParts.filter(Boolean).join('');
  const details = !omitComponentDetails && components
    ? `<details class="planning-trajectory-funding-components"><summary>Component totals</summary>${components}</details>`
    : '';
  let roadResult;
  if (stageOpts && stageOpts.roadTrustChips) {
    const result = planningRoadStageResult(stage, stageOpts.granularity);
    if (!result || result.status === 'unavailable'
      || result.amount == null || !isFinite(Number(result.amount))) {
      roadResult = `<div class="planning-trajectory-funding-result unavailable" data-trajectory-funding-result="unavailable">${planningRoadAmountReprint({ status: 'unavailable' })}</div>`;
    } else {
      const sign = Number(result.amount) < 0 ? 'gap' : Number(result.amount) > 0 ? 'surplus' : 'neutral';
      roadResult = `<div class="planning-trajectory-funding-result" data-trajectory-funding-result="ready" data-trajectory-funding-result-sign="${sign}">${planningRoadAmountReprint(result)}</div>`;
    }
  } else {
    roadResult = planningTrajectoryFundingResultHtml(planningRoadStageResult(
      stage, stageOpts && stageOpts.granularity));
  }
  if (fableStage) {
    const granularity = (stageOpts && stageOpts.granularity) || 'month';
    const monthName = (stageOpts && stageOpts.monthName) || null;
    const period = stageOpts && stageOpts.period;
    const includes = planningRoadStageIncludes(stageNum, granularity, monthName, period);
    const narrative = period
      ? planningRoadStageNarrative(period, stageNum, granularity, monthName) : '';
    const pill = planningRoadStageDeltaPill(stage, stageNum);
    return `<${tag} class="planning-trajectory-funding-stage${fableCls}"${attrs.length ? ' ' + attrs : ''}>
    ${stageIndex}
    <div class="planning-road-spine-body">
      <div class="planning-road-stage-card">
        <div class="planning-road-stage-headrow">
          <h3 class="planning-trajectory-funding-stage-title">${label}</h3>
          ${roadResult}
        </div>
        <p class="planning-road-stage-includes">${includes}</p>
        ${narrative ? `<p class="planning-road-stage-note">${narrative}</p>` : ''}
        ${pill}
      </div>
    </div>
  </${tag}>`;
  }
  return `<article class="planning-trajectory-funding-stage${fableCls}"${attrs.length ? ' ' + attrs : ''}>
    <h3 class="planning-trajectory-funding-stage-title">${label}</h3>
    ${roadResult}
    ${details}
  </article>`;
}

function planningRoadAheadStageOpts(period, granularity) {
  const parts = period && granularity !== 'pay-period'
    ? planningRoadAheadMonthParts(period.month) : null;
  return {
    omitComponentDetails: true,
    roadTrustChips: true,
    fableStage: true,
    granularity: granularity || 'month',
    monthName: parts ? parts.long : null,
    period: period || null,
  };
}

function planningRoadAheadFundingStagesHtml(period, granularity) {
  if (!period) return '';
  const stageOpts = planningRoadAheadStageOpts(period, granularity);
  const stages = `<ol class="planning-trajectory-funding-stages planning-road-spine" data-planning-road-stages="ready">
      ${planningTrajectoryFundingStageHtml(period.stage1, 1, stageOpts)}
      ${planningTrajectoryFundingStageHtml(period.stage2, 2, stageOpts)}
      ${planningTrajectoryFundingStageHtml(period.stage3, 3, stageOpts)}
    </ol>`;
  if (granularity === 'pay-period') {
    const key = period.payday || period.id;
    if (!key) return '';
    const kind = period.windowKind || '';
    const identity = planningRoadPayPeriodIdentity(period);
    // The pay-period header already names the span; repeating it above the
    // spine reads as two different labels for one period.
    return `<div class="planning-trajectory-funding-period" data-trajectory-funding-granularity="pay-period" data-trajectory-funding-pay-period="${key}"${kind ? ` data-road-pay-period-window-kind="${kind}"` : ''} data-road-pay-period-display-identity="${identity}">
    ${stages}
  </div>`;
  }
  if (!period.month) return '';
  return `<div class="planning-trajectory-funding-period" data-trajectory-funding-granularity="month" data-trajectory-funding-month="${period.month}">
    ${stages}
  </div>`;
}

function planningRoadBreakdownComponentRow(label, component, dataKey) {
  if (!component) return '';
  const idAttr = planningRoadLineIdAttr(component);
  const date = planningRoadPublishedLineDateHtml(component);
  const labelHtml = `<span class="planning-road-breakdown-label">${label}${date}</span>`;
  if (component.status === 'unavailable') {
    const reason = component.reason
      || 'Atlas cannot see this amount yet. It is not counted as $0.';
    return `<li class="planning-road-breakdown-row unavailable" data-planning-road-breakdown="${dataKey || label}"${idAttr}>
      ${labelHtml}
      <span class="planning-road-breakdown-value">${planningRoadAmountReprint(component)}</span>
      <small class="planning-trajectory-reason">${reason}</small>
    </li>`;
  }
  if (component.amount == null || !isFinite(Number(component.amount))) {
    return `<li class="planning-road-breakdown-row unavailable" data-planning-road-breakdown="${dataKey || label}"${idAttr}>
      ${labelHtml}
      <span class="planning-road-breakdown-value">${planningRoadAmountReprint({ status: 'unavailable' })}</span>
    </li>`;
  }
  const chip = component.status ? planningRoadTrustChip(component.status) : '';
  const plannedNote = component.status === 'planned'
    ? '<span class="planning-road-breakdown-planned-note">Planned item — not counted as $0 when withheld.</span>' : '';
  return `<li class="planning-road-breakdown-row" data-planning-road-breakdown="${dataKey || label}"${idAttr}>
    ${labelHtml}
    <span class="planning-road-breakdown-value"><b>${money2(component.amount)}</b>${chip}${plannedNote}</span>
  </li>`;
}

/** Reprint Forecast-published named lines, then the unchanged rollup.
 *  No lines means the current aggregate-only row. This page does not split. */
function planningRoadBreakdownPublishedRows(label, component, dataKey) {
  const lines = planningRoadPublishedLines(component);
  if (!lines.length) {
    return [planningRoadBreakdownComponentRow(label, component, dataKey)];
  }
  return lines.map((row, i) =>
    planningRoadBreakdownComponentRow(row.label, row, `${dataKey}-line-${i}`)
  ).concat([planningRoadBreakdownComponentRow(label, component, `${dataKey}-total`)]);
}

function planningRoadBreakdownGroup(title, rows) {
  const list = rows.filter(Boolean).join('');
  if (!list) return '';
  return `<div class="planning-road-breakdown-group">
      <p class="planning-road-breakdown-group-title">${title}</p>
      <ul class="planning-road-breakdown-list">${list}</ul>
    </div>`;
}

/* Frame 06 — progressive disclosure of exactly what Forecast counted, grouped
 * money in / required costs / planned spending / debt strategy / stage results.
 * Every row keeps its trust badge; withheld rows stay em-dashes. */
function planningRoadAheadBreakdownSheetHtml(period, granularity) {
  if (!period) return '';
  const s1 = period.stage1;
  const s2 = period.stage2;
  const s3 = period.stage3;
  const monthParts = granularity === 'pay-period'
    ? null : planningRoadAheadMonthParts(period.month);
  const plannedTitle = monthParts
    ? `Planned spending · ${monthParts.long}`
    : 'Planned spending';
  const calendarIncome = granularity === 'pay-period' ? null : period.income;
  const surplusRows = granularity === 'pay-period' ? [] : (Array.isArray(period.closingPayPeriods)
    ? period.closingPayPeriods.map((row, i) => planningRoadBreakdownComponentRow(
      row.displayRange || row.payday || 'Pay period',
      { amount: row.stage1, status: row.status || 'calculated', id: row.payday },
      `available-surplus-line-${i}`))
    : []);
  if (granularity !== 'pay-period' && s1 && s1.result) {
    surplusRows.push(planningRoadBreakdownComponentRow(
      planningRoadMonthFundingLabel(s1.result), s1.result, 'available-to-allocate'));
  }
  const groups = [
    granularity === 'pay-period'
      ? planningRoadBreakdownGroup('Money in', [
        s1 ? planningRoadBreakdownComponentRow('Income', s1.income, 'income') : '',
      ])
      : planningRoadBreakdownGroup(planningRoadMonthIncomeTitle(period), calendarIncome
        ? planningRoadBreakdownPublishedRows('Total income', calendarIncome, 'calendar-income') : []),
    granularity === 'pay-period' ? '' : planningRoadBreakdownGroup('Pay periods closing this month', surplusRows),
    granularity === 'pay-period'
      ? planningRoadBreakdownGroup('Bills & required costs', s1 ? [
        planningRoadBreakdownComponentRow('Bills', s1.bills, 'bills'),
        planningRoadBreakdownComponentRow('Required debt payments', s1.obligations, 'obligations'),
        s1.householdBudget
          ? planningRoadBreakdownComponentRow('Household budget', s1.householdBudget, 'household-budget') : '',
      ] : [])
      : '',
    planningRoadBreakdownGroup(plannedTitle,
      s2 ? planningRoadBreakdownPublishedRows('Dated commitments', s2.commitments, 'commitments') : []),
    planningRoadBreakdownGroup('Debt strategy', [
      s3 && s3.extras
        ? planningRoadBreakdownComponentRow('Extra debt payments', s3.extras, 'extras') : '',
    ]),
    planningRoadBreakdownGroup('Stage results', [
      { label: 'Normal life', result: s1 && s1.result },
      { label: 'After planned spending', result: planningRoadStageResult(s2, granularity) },
      { label: 'After debt strategy', result: planningRoadStageResult(s3, granularity) },
    ].map(row => (row.result
      ? `<li class="planning-road-breakdown-row planning-road-breakdown-stage-result" data-planning-road-breakdown="${row.label}">
      <span class="planning-road-breakdown-label">${row.label}</span>
      <span class="planning-road-breakdown-value">${planningRoadAmountReprint(row.result)}</span>
    </li>`
      : ''))),
  ].filter(Boolean).join('');
  if (!groups) {
    return `<p class="lede" data-planning-road-breakdown="empty">Forecast published no line items for this period.</p>`;
  }
  const summary = monthParts
    ? `Full ${monthParts.long} breakdown`
    : (planningRoadPayPeriodIsResidual(period)
      ? 'Full remaining-through-next-payday breakdown'
      : 'Full pay-period breakdown');
  const countedFor = monthParts
    ? 'this period'
    : (planningRoadPayPeriodIsResidual(period)
      ? 'remaining through next payday'
      : 'this pay period');
  return `<details class="planning-road-breakdown-sheet" data-planning-road-breakdown="sheet">
    <summary><span class="planning-road-breakdown-summary-label">${summary}</span><span class="planning-road-breakdown-summary-chevron" aria-hidden="true">›</span></summary>
    <p class="lede planning-road-breakdown-intro">Everything counted for ${countedFor}, copied from Forecast. Unavailable figures show — and are not counted as $0.</p>
    ${groups}
  </details>`;
}

function planningRoadAheadHorizonCountsHtml(traj, granularity, asOf) {
  const horizon = planningRoadAheadHorizonLabel(traj);
  const caption = horizon
    ? `${horizon}, as far as Forecast can currently project.`
    : 'As far as Forecast can currently project.';
  return `<p class="planning-road-horizon-caption" data-planning-road-horizon="caption">${caption}</p>`;
}

function planningTrajectoryFundingPeriodPanelHtml(period, granularity) {
  if (!period) return '';
  if (granularity === 'pay-period') {
    const key = period.payday || period.id;
    if (!key) return '';
    const identity = planningRoadPayPeriodIdentity(period);
    const range = period.rangeLabel
      || (period.start && period.end ? `${fmtDateFull(period.start)} – ${fmtDateFull(period.end)}` : '');
    const rangeNote = range
      ? `<small class="planning-trajectory-period-dates">${identity} · ${range}</small>` : '';
    const identityNote = planningRoadAheadPayPeriodIdentityNoteHtml(period);
    const kind = period.windowKind || '';
    return `<div class="planning-trajectory-funding-period" data-trajectory-funding-granularity="pay-period" data-trajectory-funding-pay-period="${key}"${kind ? ` data-road-pay-period-window-kind="${kind}"` : ''} data-road-pay-period-display-identity="${identity}">
    ${rangeNote}
    ${identityNote}
    <div class="planning-trajectory-funding-stages">
      ${planningTrajectoryFundingStageHtml(period.stage1, 1)}
      ${planningTrajectoryFundingStageHtml(period.stage2, 2)}
      ${planningTrajectoryFundingStageHtml(period.stage3, 3)}
    </div>
  </div>`;
  }
  if (!period.month) return '';
  return `<div class="planning-trajectory-funding-period" data-trajectory-funding-granularity="month" data-trajectory-funding-month="${period.month}">
    <div class="planning-trajectory-funding-stages">
      ${planningTrajectoryFundingStageHtml(period.stage1, 1)}
      ${planningTrajectoryFundingStageHtml(period.stage2, 2)}
      ${planningTrajectoryFundingStageHtml(period.stage3, 3)}
    </div>
  </div>`;
}

const PLANNING_TRAJECTORY_FUNDING_GRANULARITY = {
  month: { id: 'month', label: 'Month' },
  'pay-period': { id: 'pay-period', label: 'Pay period' },
};

function planningTrajectoryFundingRegionAriaLabel(granularity) {
  return granularity === 'pay-period'
    ? 'Three-stage funding for selected Seaspan pay period'
    : 'Three-stage funding for selected trajectory month';
}

function planningTrajectoryFundingGranularityBtn(granularity, current) {
  const row = PLANNING_TRAJECTORY_FUNDING_GRANULARITY[granularity];
  if (!row) return '';
  const pressed = current === granularity ? 'true' : 'false';
  return `<button type="button" class="planning-trajectory-granularity-btn" data-trajectory-funding-granularity="${row.id}" aria-pressed="${pressed}">${row.label}</button>`;
}

/* DESIGN §8 — iOS-style segmented control with tablist semantics. It swaps the
 * bucketing of one Forecast trajectory; it never selects a different walk. */
function planningRoadAheadSegmentedHtml(current) {
  const monthOn = current === 'month';
  const payOn = current === 'pay-period';
  return `<div class="planning-road-segmented planning-trajectory-granularity planning-road-granularity" role="tablist" aria-label="Month or pay period view">
    <button type="button" role="tab" class="planning-road-segmented-btn planning-trajectory-granularity-btn" data-trajectory-funding-granularity="month" aria-selected="${monthOn ? 'true' : 'false'}" aria-controls="planning-road-view-panel" tabindex="${monthOn ? '0' : '-1'}">Month</button>
    <button type="button" role="tab" class="planning-road-segmented-btn planning-trajectory-granularity-btn" data-trajectory-funding-granularity="pay-period" aria-selected="${payOn ? 'true' : 'false'}" aria-controls="planning-road-view-panel" tabindex="${payOn ? '0' : '-1'}">Pay period</button>
  </div>`;
}

const PLANNING_ROAD_MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PLANNING_ROAD_MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function planningRoadAheadMonthParts(monthKey) {
  if (!monthKey || String(monthKey).length < 7) return null;
  const year = String(monthKey).slice(0, 4);
  const mi = Number(String(monthKey).slice(5, 7)) - 1;
  if (!year || mi < 0 || mi > 11) return null;
  return { year, short: PLANNING_ROAD_MONTH_SHORT[mi], long: PLANNING_ROAD_MONTH_LONG[mi] };
}

function planningRoadAheadPeriodYear(period, granularity) {
  if (!period) return null;
  if (granularity === 'pay-period') {
    const iso = period.payday || period.start || period.id || '';
    return String(iso).length >= 4 ? String(iso).slice(0, 4) : null;
  }
  const parts = planningRoadAheadMonthParts(period.month);
  return parts ? parts.year : null;
}

/** Frame 01/05 trajectory chip: a short period line over a year line. Every
 *  chip carries its own year, so two chips for the same month in different
 *  calendar years never read as the same period on the strip. */
function planningRoadAheadChipLabel(period, granularity) {
  if (!period) return '';
  if (granularity === 'pay-period') {
    let dates = '';
    if (period.start && period.end) dates = `${fmtDate(period.start)} – ${fmtDate(period.end)}`;
    else {
      const payday = period.payday || period.id || '';
      dates = payday.length >= 10 ? fmtDate(payday) : payday;
    }
    if (planningRoadPayPeriodIsResidual(period) && dates) return `${dates} remaining`;
    return dates;
  }
  const parts = planningRoadAheadMonthParts(period.month);
  if (!parts) return period.month || '';
  return parts.short;
}

function planningRoadAheadChipYear(period, granularity) {
  return planningRoadAheadPeriodYear(period, granularity) || '';
}

/** VoiceOver reads the whole period, never the abbreviated chip line. */
function planningRoadAheadChipAccessibleLabel(period, granularity) {
  if (!period) return '';
  if (granularity === 'pay-period') {
    const identity = planningRoadPayPeriodIdentity(period);
    let dates = '';
    if (period.start && period.end) {
      dates = `${fmtDateFull(period.start)} to ${fmtDateFull(period.end)}`;
    } else {
      const payday = period.payday || period.id || '';
      dates = payday.length >= 10 ? fmtDateFull(payday) : payday;
    }
    if (planningRoadPayPeriodIsResidual(period) && period.cycleRangeLabel) {
      return `${identity}, ${dates}, remainder of the Seaspan cycle ${period.cycleRangeLabel}`;
    }
    return dates ? `${identity}, ${dates}` : identity;
  }
  const parts = planningRoadAheadMonthParts(period.month);
  return parts ? `${parts.long} ${parts.year}` : (period.month || '');
}

function planningRoadAheadPeriodDisplayLabel(period, granularity) {
  if (!period) return '';
  if (granularity === 'pay-period') {
    const identity = planningRoadPayPeriodIdentity(period);
    const range = period.rangeLabel
      || (period.start && period.end ? `${fmtDateFull(period.start)} – ${fmtDateFull(period.end)}` : '');
    return range ? `${identity} · ${range}` : identity;
  }
  const parts = planningRoadAheadMonthParts(period.month);
  return parts ? `${parts.long} ${parts.year}` : (period.month || '');
}

function planningRoadAheadPeriodKey(period, granularity) {
  if (!period) return null;
  if (granularity === 'pay-period') return period.payday || period.id || null;
  return period.month || null;
}

function planningRoadAheadStage3Result(period, granularity) {
  if (!period || !period.stage3) return null;
  const result = planningRoadStageResult(period.stage3, granularity);
  if (!result) return null;
  if (result.status === 'unavailable') return null;
  if (result.amount == null || !isFinite(Number(result.amount))) return null;
  return result;
}

function planningRoadAheadResultPhrase(result) {
  if (!result || result.amount == null || !isFinite(Number(result.amount))) {
    return { label: 'Projected result withheld', cls: 'neutral' };
  }
  const amount = Number(result.amount);
  if (amount < 0) return { label: 'Projected funding gap', cls: 'gap' };
  if (amount > 0) return { label: 'Projected surplus', cls: 'surplus' };
  return { label: 'Projected result', cls: 'neutral' };
}

function planningRoadAheadPeriods(traj, granularity) {
  if (!traj || traj.status !== 'ready') return [];
  if (granularity === 'pay-period') {
    return Array.isArray(traj.payPeriods) ? traj.payPeriods : [];
  }
  return Array.isArray(traj.months) ? traj.months : [];
}

// Same fail-closed series gate as planningTrajectoryFundingHtml — road-ahead lead/timeline
// must not fall through to monthly pressure or stage3 when the requested granularity has no series.
function planningRoadAheadGranularitySeriesGate(traj, granularity) {
  if (!traj || traj.status !== 'ready') {
    return {
      available: false,
      reason: (traj && traj.reason) || 'Baseline trajectory unavailable.',
    };
  }
  if (granularity === 'pay-period') {
    const payPeriods = Array.isArray(traj.payPeriods) ? traj.payPeriods : [];
    if (!payPeriods.length) {
      const prov = traj.provenance && traj.provenance.payPeriodSeries;
      const reason = prov === 'unavailable'
        ? 'Forecast could not publish pay-period spans on this opening (Seaspan payroll calendar missing or clipped empty). Monthly funding remains available in Month view.'
        : 'Forecast published no pay periods in this projection.';
      return { available: false, reason };
    }
    return { available: true, reason: null };
  }
  const months = Array.isArray(traj.months) ? traj.months : [];
  if (!months.length) {
    return {
      available: false,
      reason: (traj && traj.reason) || 'Baseline trajectory unavailable.',
    };
  }
  return { available: true, reason: null };
}

function planningRoadAheadIsForwardPeriod(period, granularity, asOf) {
  if (!asOf) return true;
  const asOfMonth = asOf.length >= 7 ? asOf.slice(0, 7) : null;
  if (granularity === 'pay-period') {
    if (period.end && period.end < asOf) return false;
    if (period.start && period.start >= asOf) return true;
    return !(period.end && period.end < asOf);
  }
  if (period.month && asOfMonth) return period.month >= asOfMonth;
  return true;
}

function planningRoadAheadForwardPressureSignals(traj, asOf) {
  const pressure = traj && traj.pressure;
  if (!pressure || pressure.status !== 'ready') {
    return {
      status: 'unavailable',
      reason: (pressure && pressure.reason) || (traj && traj.reason) || 'Baseline trajectory pressure unavailable.',
      signals: [],
    };
  }
  const signals = Array.isArray(pressure.signals) ? pressure.signals : [];
  const asOfMonth = asOf && asOf.length >= 7 ? asOf.slice(0, 7) : null;
  const forward = signals.filter(signal => {
    if (signal.date && signal.date >= asOf) return true;
    if (signal.month && asOfMonth && signal.month >= asOfMonth) return true;
    return false;
  });
  return { status: 'ready', signals: forward, all: signals };
}

function planningRoadAheadFindFundingGapLead(traj, granularity, asOf) {
  const periods = planningRoadAheadPeriods(traj, granularity);
  for (const period of periods) {
    if (!planningRoadAheadIsForwardPeriod(period, granularity, asOf)) continue;
    const result = planningRoadAheadStage3Result(period, granularity);
    if (!result || Number(result.amount) >= 0) continue;
    return {
      kind: 'funding-gap',
      period,
      key: planningRoadAheadPeriodKey(period, granularity),
      result,
    };
  }
  return null;
}

function planningRoadAheadFindPressureLead(traj, asOf) {
  const forward = planningRoadAheadForwardPressureSignals(traj, asOf);
  if (forward.status !== 'ready') return forward;
  if (!forward.signals.length) {
    return { status: 'empty', signals: forward.all };
  }
  const signal = forward.signals[0];
  return { status: 'ready', signal, index: forward.all.indexOf(signal) };
}

function planningRoadAheadSignalsForPeriod(traj, period, granularity) {
  const pressure = traj && traj.pressure;
  if (!pressure || pressure.status !== 'ready') return [];
  const all = Array.isArray(pressure.signals) ? pressure.signals : [];
  const month = granularity === 'month' ? period.month : null;
  const start = period.start;
  const end = period.end;
  return all.filter(signal => {
    if (month && signal.month === month) return true;
    if (signal.date && start && end && signal.date >= start && signal.date <= end) return true;
    return false;
  });
}

/* DESIGN §4 — household wording for the pressure kinds Forecast publishes.
 * The hero reprints Forecast's signal; these strings only translate its kind
 * out of implementation vocabulary. */
const PLANNING_ROAD_PRESSURE_HEADLINE = {
  'lowest-projected-cash': 'Lowest projected cash in this projection',
  'cash-trough': 'Lowest projected cash inside the month',
  'cash-sign-change': 'Projected cash turns negative',
  'month-cash-decline': 'Projected cash falls from the month before',
  'outflow-exceeds-inflow': 'More is projected to go out than to come in',
  'dated-commitment': 'A dated cost you have planned falls due',
  'debt-increase': 'Total modelled debt is projected to increase',
  'debt-not-declining-after-payment': 'Debt is not projected to fall after a payment',
  'debt-limit-crossing': 'A credit limit is projected to be crossed',
};

const PLANNING_ROAD_PRESSURE_NARRATIVE = {
  'lowest-projected-cash': 'This is the lowest point projected cash reaches anywhere in this projection.',
  'cash-trough': 'Projected cash dips to its lowest point inside this month before recovering.',
  'cash-sign-change': 'Projected cash was positive and is projected to turn negative here.',
  'month-cash-decline': 'Projected month-end cash is lower than the month before it.',
  'outflow-exceeds-inflow': 'More money is projected to leave than to arrive in this month.',
  'dated-commitment': 'A cost with a date on it comes due in this period.',
  'debt-increase': 'Total modelled debt is higher at the end of this step than at the start.',
  'debt-not-declining-after-payment': 'A payment is projected but total debt does not fall.',
  'debt-limit-crossing': 'The projection crosses a credit limit on one facility.',
};

/** DESIGN §4 — "the next 18 months" / "as far as Forecast can currently
 *  project", taken from the horizon Forecast published for this walk. */
function planningRoadAheadHorizonLabel(traj) {
  const end = traj && traj.horizon && traj.horizon.end;
  if (!end) return '';
  return `Through ${fmtDateFull(end)}`;
}

/** DESIGN §4 — relative time next to the absolute period, in whole calendar
 *  months from the opening date. Calendar distance only; no financial figure. */
function planningRoadAheadRelativePhrase(asOf, period, granularity) {
  if (!asOf || String(asOf).length < 7 || !period) return '';
  const anchor = granularity === 'pay-period'
    ? String(period.start || period.payday || period.id || '')
    : String(period.month || '');
  if (anchor.length < 7) return '';
  const fromY = Number(String(asOf).slice(0, 4));
  const fromM = Number(String(asOf).slice(5, 7));
  const toY = Number(anchor.slice(0, 4));
  const toM = Number(anchor.slice(5, 7));
  if (![fromY, fromM, toY, toM].every(n => isFinite(n) && n > 0)) return '';
  const months = (toY - fromY) * 12 + (toM - fromM);
  if (months <= 0) return 'this month';
  if (months === 1) return 'next month';
  return `in ${months} months`;
}

/** Hero when-line and relative phrase follow the published pressure period,
 *  never the currently selected chip. */
function planningRoadAheadPressureWhen(signal) {
  if (!signal) return 'date withheld';
  const monthParts = signal.month ? planningRoadAheadMonthParts(signal.month) : null;
  if (monthParts) return `${monthParts.long} ${monthParts.year}`;
  if (signal.date) return fmtDateFull(signal.date);
  return 'date withheld';
}

function planningRoadAheadPressureRelative(asOf, signal) {
  if (!signal) return '';
  if (signal.month) return planningRoadAheadRelativePhrase(asOf, { month: signal.month }, 'month');
  if (signal.date) return planningRoadAheadRelativePhrase(asOf, { start: signal.date }, 'pay-period');
  return '';
}

/** CTA may select a period only when that period is the published pressure
 *  period in the current granularity. Month-only signals have no pay-period
 *  identity, so Pay period view fails closed rather than selecting the
 *  currently highlighted chip. */
function planningRoadAheadPressureCtaTarget(traj, granularity, signal) {
  if (!signal) return null;
  const periods = planningRoadAheadPeriods(traj, granularity);
  if (!periods.length) return null;
  if (granularity === 'month') {
    if (!signal.month) return null;
    const period = periods.find(p => p.month === signal.month);
    return period ? { period, key: planningRoadAheadPeriodKey(period, granularity) } : null;
  }
  if (granularity === 'pay-period') {
    if (!signal.date) return null;
    const period = periods.find(p => (
      p.start && p.end && signal.date >= p.start && signal.date <= p.end
    ));
    return period ? { period, key: planningRoadAheadPeriodKey(period, granularity) } : null;
  }
  return null;
}

function planningRoadAheadWhenLine(label, relative) {
  const rel = relative
    ? `<span class="planning-road-hero-relative"> · ${relative}</span>` : '';
  return `<p class="planning-road-hero-when"><span class="planning-road-hero-period">${label}</span>${rel}</p>`;
}

function planningRoadAheadHeroHead(eyebrow, label, relative, kind) {
  return `<div class="planning-road-hero-top">
      <span class="planning-road-hero-icon planning-road-hero-icon-${kind}" aria-hidden="true"></span>
      <div class="planning-road-hero-heading">
        <p class="planning-road-hero-eyebrow">${eyebrow}</p>
        ${planningRoadAheadWhenLine(label, relative)}
      </div>
    </div>`;
}

/** Frame 01 hero attribution. Which stage turned the period negative is read
 *  from the signs Forecast published for stage1 / stage2 / stage3. */
function planningRoadAheadHeroAttribution(period, granularity) {
  const residual = planningRoadPayPeriodIsResidual(period);
  const noun = residual ? 'remainder through next payday' : planningRoadPeriodNoun(granularity);
  const parts = granularity === 'pay-period'
    ? null : planningRoadAheadMonthParts(period.month);
  const subject = parts ? `${parts.long}'s` : (residual ? 'This remainder through next payday\'s' : `This ${noun}'s`);
  const thatWhere = residual ? 'through next payday' : `that ${noun}`;
  const s1 = planningRoadFigure(period.stage1 && period.stage1.result);
  const s2 = planningRoadFigure(planningRoadStageResult(period.stage2, granularity));
  const extras = planningRoadFigure(period.stage3 && period.stage3.extras);
  const hasExtra = extras != null && extras > 0;
  if (s1 == null || s2 == null) {
    return `Forecast published this result without a full stage story for that ${noun}.`;
  }
  if (s1 < 0) {
    return `${subject} regular household costs are more than the income Forecast projects for that ${noun}.`;
  }
  if (s2 < 0) {
    return hasExtra
      ? `Your regular household costs are covered ${thatWhere}. ${subject} planned spending and the extra debt payment create this gap.`
      : `Your regular household costs are covered ${thatWhere}. ${subject} planned spending creates this gap.`;
  }
  if (hasExtra) {
    return `Your regular household costs and planned spending are covered ${thatWhere}. The extra debt payment creates this gap.`;
  }
  return `Forecast published this result without naming a stage that creates the gap.`;
}

function planningRoadAheadHeroCta(period, granularity, key) {
  if (!key) return '';
  const parts = granularity === 'pay-period'
    ? null : planningRoadAheadMonthParts(period && period.month);
  const label = parts
    ? parts.long
    : planningRoadAheadPeriodDisplayLabel(period, granularity);
  if (!label) return '';
  return `<button type="button" class="planning-road-hero-cta" data-road-select-period="${key}" data-road-focus-period="${key}">
      <span>See what's behind ${label}</span>
      <span class="planning-road-hero-cta-chevron" aria-hidden="true">›</span>
    </button>`;
}

function planningRoadAheadLeadHtml(traj, granularity, asOf, selectedKey) {
  if (!traj || traj.status !== 'ready') {
    const reason = (traj && traj.reason) || 'Baseline trajectory unavailable.';
    return {
      html: `<div class="planning-road-lead planning-road-lead-unavailable" data-road-lead="unavailable"><div class="note-box crit">${reason}</div></div>`,
      focusKey: null,
    };
  }
  const seriesGate = planningRoadAheadGranularitySeriesGate(traj, granularity);
  if (!seriesGate.available) {
    return {
      html: `<div class="planning-road-lead planning-road-lead-unavailable" data-road-lead="series-unavailable" data-road-lead-granularity="${granularity}"><div class="note-box crit">${seriesGate.reason}</div></div>`,
      focusKey: selectedKey,
    };
  }
  const periods = planningRoadAheadPeriods(traj, granularity);
  const period = periods.find(p => planningRoadAheadPeriodKey(p, granularity) === selectedKey)
    || periods[0];
  if (!period) {
    return {
      html: `<div class="planning-road-lead planning-road-lead-unavailable" data-road-lead="unavailable"><div class="note-box crit">Forecast published no period on this view.</div></div>`,
      focusKey: selectedKey,
    };
  }
  const key = planningRoadAheadPeriodKey(period, granularity);
  const afterKind = planningRoadDecisionKind(planningRoadStageResult(period.stage2, granularity));
  const cardTone = granularity === 'pay-period' ? afterKind.cls : 'neutral';
  return {
    html: `<article class="planning-road-lead planning-road-lead-${cardTone} planning-road-hero-card" data-road-lead="${afterKind.lead}" data-road-lead-period="${key || ''}" data-road-result-sign="${afterKind.cls}">
      ${planningRoadAheadDecisionHtml(period, granularity)}
    </article>`,
    focusKey: key,
  };
}

function planningRoadAheadTimelineHtml(traj, granularity, selectedKey) {
  const seriesGate = planningRoadAheadGranularitySeriesGate(traj, granularity);
  if (!seriesGate.available) {
    return `<div class="note-box crit" data-road-timeline="unavailable" data-road-timeline-granularity="${granularity}">${seriesGate.reason}</div>`;
  }
  const periods = planningRoadAheadPeriods(traj, granularity);
  if (!periods.length) {
    const reason = (traj && traj.reason) || 'Baseline trajectory unavailable.';
    return `<div class="note-box crit" data-road-timeline="unavailable">${reason}</div>`;
  }
  const chips = periods.map(period => {
    const key = planningRoadAheadPeriodKey(period, granularity);
    const result = planningRoadAheadStage3Result(period, granularity);
    const phrase = result ? planningRoadAheadResultPhrase(result) : { label: 'Projected result withheld', cls: 'withheld' };
    const selected = key === selectedKey;
    const shortLabel = planningRoadAheadChipLabel(period, granularity) || key || '';
    const year = planningRoadAheadChipYear(period, granularity);
    const fullLabel = planningRoadAheadChipAccessibleLabel(period, granularity)
      || shortLabel || key || '';
    return `<li class="planning-road-timeline-item${selected ? ' is-selected' : ''} planning-road-timeline-item-${phrase.cls}" data-road-timeline-period="${key || ''}" data-road-timeline-sign="${phrase.cls}"${granularity === 'pay-period' && period.windowKind ? ` data-road-pay-period-window-kind="${period.windowKind}"` : ''}>
      <button type="button" class="planning-road-timeline-btn" data-road-select-period="${key || ''}" aria-pressed="${selected ? 'true' : 'false'}" aria-label="${fullLabel} — ${phrase.label}">
        <span class="planning-road-timeline-label">${shortLabel}</span>
        <span class="planning-road-timeline-year">${year}</span>
        <span class="planning-road-horizon-chip-dot planning-road-horizon-chip-dot-${phrase.cls}" aria-hidden="true"></span>
      </button>
    </li>`;
  }).join('');
  return `<ol class="planning-road-timeline planning-road-horizon-chips" data-road-timeline="ready" data-road-timeline-granularity="${granularity}" data-planning-road-horizon="chips">${chips}</ol>`;
}

/* Frame 03 pager — chevrons that step periods without returning to the strip.
 * The accessible name is the real period name, never "next". */
function planningRoadAheadSelectedNavHtml(traj, granularity, selectedKey) {
  const periods = planningRoadAheadPeriods(traj, granularity);
  const idx = periods.findIndex(p => planningRoadAheadPeriodKey(p, granularity) === selectedKey);
  if (idx < 0) return '';
  const prev = idx > 0 ? periods[idx - 1] : null;
  const next = idx < periods.length - 1 ? periods[idx + 1] : null;
  const btn = (period, dir, glyph) => {
    if (!period) {
      return `<span class="planning-road-nav-btn is-disabled" aria-hidden="true">${glyph}</span>`;
    }
    const name = planningRoadAheadChipAccessibleLabel(period, granularity);
    return `<button type="button" class="planning-road-nav-btn" data-road-select-period="${planningRoadAheadPeriodKey(period, granularity)}" data-road-pager="${dir}" aria-label="${name}"><span aria-hidden="true">${glyph}</span></button>`;
  };
  return `<div class="planning-road-selected-nav planning-road-pager" role="group" aria-label="Selected period navigation">${btn(prev, 'previous', '‹')}${btn(next, 'next', '›')}</div>`;
}

function planningRoadAheadSelectedHeaderHtml(traj, granularity, selectedKey) {
  const periods = planningRoadAheadPeriods(traj, granularity);
  const period = periods.find(p => planningRoadAheadPeriodKey(p, granularity) === selectedKey)
    || periods[0];
  if (!period) return '';
  const label = planningRoadAheadPeriodDisplayLabel(period, granularity);
  const picker = planningRoadAheadSegmentedHtml(granularity);
  const kind = granularity === 'pay-period' ? (period.windowKind || '') : '';
  const identity = granularity === 'pay-period' ? planningRoadPayPeriodIdentity(period) : '';
  const kindAttr = kind ? ` data-road-pay-period-window-kind="${kind}"` : '';
  const identityAttr = identity ? ` data-road-pay-period-display-identity="${identity}"` : '';
  return `<header class="planning-road-selected-head"${kindAttr}${identityAttr}>
      <h2 class="planning-road-selected-title" id="planning-road-period-title" tabindex="-1">${label}</h2>
      ${picker}
    </header>`;
}

function planningRoadAheadStagesHtml(traj, granularity, selectedKey) {
  const periods = planningRoadAheadPeriods(traj, granularity);
  const period = periods.find(p => planningRoadAheadPeriodKey(p, granularity) === selectedKey)
    || periods[0];
  if (!period) {
    return '<p class="lede" data-road-stages="empty">Select a period on the horizon strip.</p>';
  }
  const key = planningRoadAheadPeriodKey(period, granularity);
  const view = granularity === 'pay-period' ? 'pay-period' : 'month';
  const waterfall = planningRoadAheadWaterfallHtml(period, view);
  return `<article class="planning-road-stages" data-road-stages-period="${key || ''}" data-planning-road-stages="waterfall">
    ${waterfall}
  </article>`;
}

function planningRoadAheadBreakdownHtml(traj, granularity, selectedKey) {
  const periods = planningRoadAheadPeriods(traj, granularity);
  const period = periods.find(p => planningRoadAheadPeriodKey(p, granularity) === selectedKey)
    || periods[0];
  if (!period) return '';
  const sheet = planningRoadAheadBreakdownSheetHtml(period, granularity);
  if (!sheet) return '';
  return `<section class="planning-road-breakdown" data-planning-road-breakdown="region" aria-label="Selected period breakdown">
    ${sheet}
  </section>`;
}

function planningRoadAheadSelectedHtml(traj, granularity, selectedKey, asOf) {
  const header = planningRoadAheadSelectedHeaderHtml(traj, granularity, selectedKey);
  const stages = planningRoadAheadStagesHtml(traj, granularity, selectedKey);
  const breakdown = planningRoadAheadBreakdownHtml(traj, granularity, selectedKey);
  const periods = planningRoadAheadPeriods(traj, granularity);
  const period = periods.find(p => planningRoadAheadPeriodKey(p, granularity) === selectedKey)
    || periods[0];
  const key = period ? planningRoadAheadPeriodKey(period, granularity) : '';
  const identityNote = granularity === 'pay-period'
    ? planningRoadAheadPayPeriodIdentityNoteHtml(period)
    : '';
  return `<article class="planning-road-selected" data-road-selected-period="${key || ''}">
    ${header}
    ${identityNote}
    ${stages}
    ${breakdown}
  </article>`;
}

/* Frame 05 guardrail — the two views are one projection, split differently.
 * The copy says so on the surface where the split appears. */
function planningRoadAheadViewNoteHtml(granularity) {
  if (granularity !== 'pay-period') return '';
  return `<p class="planning-road-view-note" data-road-view-note="pay-period"><b>Same projection, split by your pay dates.</b> When this Forecast date is already inside a Seaspan cycle, the first block is remaining through next payday — not Budget’s This Pay Period. Later blocks run from one payday to the next.</p>`;
}

function planningRoadAheadPayPeriodIdentityNoteHtml(period) {
  if (!planningRoadPayPeriodIsResidual(period)) return '';
  const cycle = period.cycleRangeLabel || '';
  const cycleBit = cycle
    ? `Remainder of the Seaspan cycle ${cycle}. `
    : 'Remainder of the current Seaspan cycle. ';
  return `<p class="planning-road-view-note" data-road-pay-period-identity="as-of-residual">${cycleBit}Not Budget’s This Pay Period. An unpaid bill dated earlier in this Seaspan cycle can still appear here if Forecast is still carrying it. That does not make these dates the full This Pay Period.</p>`;
}

function planningRoadAheadHtml(traj, granularity, selectedKey, asOf) {
  const copied = planningNormalSpendingNote(traj);
  const intro = 'Expected income, bills, household budget, and planned spending — copied from Forecast for one month or pay period.'
    + (copied ? ' ' + copied : '')
    + ' This page does not calculate them.';
  const lead = planningRoadAheadLeadHtml(traj, granularity, asOf, selectedKey);
  const selected = planningRoadAheadSelectedHtml(traj, granularity, selectedKey, asOf);
  return {
    intro,
    subtitle: 'From your Forecast plan',
    stripTitle: granularity === 'pay-period'
      ? 'Pay periods ahead' : 'Months ahead',
    viewNote: planningRoadAheadViewNoteHtml(granularity),
    lead: lead.html,
    focusKey: lead.focusKey,
    horizonCounts: planningRoadAheadHorizonCountsHtml(traj, granularity, asOf),
    picker: '',
    timeline: planningRoadAheadTimelineHtml(traj, granularity, selectedKey),
    periodHeader: planningRoadAheadSelectedHeaderHtml(traj, granularity, selectedKey),
    stages: planningRoadAheadStagesHtml(traj, granularity, selectedKey),
    breakdown: planningRoadAheadBreakdownHtml(traj, granularity, selectedKey),
    selected,
  };
}

function planningTrajectoryFundingHtml(traj, granularity, selectedKey) {
  const note = 'Three-stage funding is Forecast.baselineTrajectory stage1 / stage2 / stage3 only — Normal life, After planned spending, After debt strategy. Month view copies months[]; Pay period view copies payPeriods[] from the same Forecast projection. This page copies component totals and results when Forecast publishes them; it does not subtract stages, recompute funding, or treat unavailable as $0.';
  const view = granularity === 'pay-period' ? 'pay-period' : 'month';
  const granularitySwitch = `<div class="planning-trajectory-granularity" role="group" aria-label="Trajectory period granularity">
    ${planningTrajectoryFundingGranularityBtn('month', view)}
    ${planningTrajectoryFundingGranularityBtn('pay-period', view)}
  </div>`;
  if (!traj || traj.status !== 'ready') {
    const reason = (traj && traj.reason) || 'Baseline trajectory unavailable.';
    return {
      lede: '',
      picker: granularitySwitch,
      panel: `<div class="note-box crit" data-trajectory-funding="unavailable">${reason}</div>`,
      note,
      granularity: view,
      selectedMonth: null,
      selectedPayPeriod: null,
    };
  }
  if (view === 'pay-period') {
    const payPeriods = Array.isArray(traj.payPeriods) ? traj.payPeriods : [];
    if (!payPeriods.length) {
      const prov = traj.provenance && traj.provenance.payPeriodSeries;
      const reason = prov === 'unavailable'
        ? 'Forecast could not publish pay-period spans on this opening (Seaspan payroll calendar missing or clipped empty). Monthly funding remains available in Month view.'
        : 'Forecast published no pay periods in this projection.';
      return {
        lede: '',
        picker: granularitySwitch,
        panel: `<div class="note-box crit" data-trajectory-funding="unavailable" data-trajectory-funding-granularity="pay-period">${reason}</div>`,
        note,
        granularity: view,
        selectedMonth: null,
        selectedPayPeriod: null,
      };
    }
    const selected = payPeriods.find(p => (p.payday || p.id) === selectedKey) || payPeriods[0];
    const selectedId = selected.payday || selected.id;
    const lede = 'Compare Normal life, After planned spending, and After debt strategy for one Seaspan pay period — the same three stages Forecast publishes for this opening. A first block that starts after payday is remaining through next payday, not Budget’s This Pay Period. Pick a pay period below.';
    const picker = `${granularitySwitch}<label class="planning-trajectory-funding-picker"><span class="planning-trajectory-funding-picker-label">Trajectory pay period</span> `
      + `<select class="planning-trajectory-funding-select" data-trajectory-funding-picker="select" aria-label="Trajectory pay period for three-stage funding">`
      + payPeriods.map(p => {
        const id = p.payday || p.id;
        const identity = planningRoadPayPeriodIdentity(p);
        const range = p.rangeLabel || '';
        const label = range ? `${identity} · ${range}` : `${identity} · ${id}`;
        return `<option value="${id}"${id === selectedId ? ' selected' : ''}>${label}</option>`;
      }).join('')
      + '</select></label>';
    return {
      lede,
      picker,
      panel: planningTrajectoryFundingPeriodPanelHtml(selected, 'pay-period'),
      note,
      granularity: view,
      selectedMonth: null,
      selectedPayPeriod: selectedId,
    };
  }
  const months = Array.isArray(traj.months) ? traj.months : [];
  if (!months.length) {
    const reason = (traj && traj.reason) || 'Baseline trajectory unavailable.';
    return {
      lede: '',
      picker: granularitySwitch,
      panel: `<div class="note-box crit" data-trajectory-funding="unavailable">${reason}</div>`,
      note,
      granularity: view,
      selectedMonth: null,
      selectedPayPeriod: null,
    };
  }
  const selected = months.find(m => m.month === selectedKey) || months[0];
  const lede = 'Compare Normal life, After planned spending, and After debt strategy for one trajectory month — the same three stages Forecast publishes for this opening. Select a month in the detailed view above or the picker below.';
  const picker = `${granularitySwitch}<label class="planning-trajectory-funding-picker"><span class="planning-trajectory-funding-picker-label">Trajectory month</span> `
    + `<select class="planning-trajectory-funding-select" data-trajectory-funding-picker="select" aria-label="Trajectory month for three-stage funding">`
    + months.map(m => `<option value="${m.month}"${m.month === selected.month ? ' selected' : ''}>${m.month}</option>`).join('')
    + '</select></label>';
  return {
    lede,
    picker,
    panel: planningTrajectoryFundingPeriodPanelHtml(selected, 'month'),
    note,
    granularity: view,
    selectedMonth: selected.month,
    selectedPayPeriod: null,
  };
}

let planningTrajectorySelectedMonth = null;
let planningTrajectorySelectedPayPeriod = null;
let planningTrajectoryFundingGranularity = 'month';

function planningTrajectoryDebtHtml(debt) {
  if (!debt || debt.status === 'unavailable') {
    const reason = debt && debt.reason
      ? debt.reason
      : 'Forecast unavailable.';
    return `<span class="chip c">Forecast unavailable</span><small class="planning-trajectory-reason">${reason}</small>`;
  }
  if (debt.status !== 'calculated') {
    return planningTrajectoryChip(debt.status);
  }
  const asOf = debt.asOf ? `<small data-trajectory-debt-asof="${debt.asOf}">as-of ${fmtDateFull(debt.asOf)}</small>` : '';
  return `<div data-trajectory-debt="consumer"><b>${money2(debt.consumer)}</b><small>Consumer</small></div>
    <div data-trajectory-debt="secured"><b>${money2(debt.secured)}</b><small>Secured incl. HELOC</small></div>
    <div data-trajectory-debt="heloc"><b>${money2(debt.heloc)}</b><small>of which HELOC</small></div>
    ${planningTrajectoryChip(debt.status)}${asOf}`;
}

function planningNormalSpendingNote(traj) {
  const ns = traj && traj.normalSpending;
  if (ns && ns.status === 'ready' && ns.phrase) return ns.phrase;
  if (ns && ns.status === 'unavailable' && ns.reason) return ns.reason;
  return '';
}

function planningTrajectoryHtml(traj) {
  const copied = planningNormalSpendingNote(traj);
  const note = copied
    ? 'Monthly cash and debt are Forecast.baselineTrajectory only. ' + copied + ' This page copies status, amounts, and notes; it does not walk cash or debt itself.'
    : 'Monthly cash and debt are Forecast.baselineTrajectory only — planned weekly variable, not historical actuals and not the payday weekly cap. This page copies status, amounts, and notes; it does not walk cash or debt itself.';
  if (!traj || traj.status !== 'ready' || !Array.isArray(traj.months) || !traj.months.length) {
    const reason = (traj && traj.reason) || 'Baseline trajectory unavailable.';
    return {
      lede: '',
      table: `<div class="note-box crit" data-trajectory="unavailable">${reason}</div>`,
      note,
    };
  }
  const horizon = traj.horizon && traj.horizon.end
    ? `Forecast baseline cash and debt by calendar month through ${fmtDateFull(traj.horizon.end)}.`
    : 'Forecast baseline cash and debt by calendar month over the knowledge horizon.';
  const weekly = traj.weeklyVariable && traj.weeklyVariable.amount != null
    ? ` Planned weekly variable: ${money2(traj.weeklyVariable.amount)} (${traj.weeklyVariable.source || 'budgetBreakdown.planned'}).`
    : '';
  const regimeNotes = Array.isArray(traj.incomeRegimes)
    ? traj.incomeRegimes.filter(r => r && (r.note || r.reason)).map(r => r.note || r.reason).join(' ')
    : '';
  const rows = traj.months.map(month => {
    const income = month.income || {};
    const cash = month.cash || {};
    const partial = planningTrajectoryIsPartialMonth(month);
    return `<tr class="planning-trajectory-month-row" data-trajectory-month="${month.month}" data-trajectory-period-start="${month.start}" data-trajectory-period-end="${month.end}"${partial ? ' data-trajectory-partial="true"' : ''} data-trajectory-income-status="${income.status || ''}" data-trajectory-cash-status="${cash.status || ''}">
      <th scope="row">${planningTrajectoryPeriodCell(month)}</th>
      <td class="planning-trajectory-income">${planningTrajectoryIncomeHtml(income)}</td>
      <td class="planning-trajectory-cash">${planningTrajectoryCashHtml(cash)}</td>
      <td class="planning-trajectory-debt">${planningTrajectoryDebtHtml(month.debt)}</td>
    </tr>`;
  }).join('');
  return {
    lede: horizon + weekly + (regimeNotes ? ` ${regimeNotes}` : ''),
    table: `<div class="scroll"><table class="stackable planning-trajectory-table" aria-label="Baseline cash and debt by month">
      <thead><tr><th scope="col">Period</th><th scope="col">Income</th><th scope="col">Cash (period end)</th><th scope="col">Debt</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`,
    note,
  };
}

// ATLAS-080 publication gating: the settlement evidence loader's
// tri-state outcome reaches this page as a status carried ALONGSIDE
// the evidence on the served data (d.settlementEvidenceStatus /
// d.settlementEvidence) — never inside the evidence. The reason
// vocabulary is the loader's stable set; anything outside it is
// malformed. A malformed status, a qualified status without valid
// effective evidence, or evidence under any non-qualified status
// fails closed as unavailable('invalid-configuration') — never as
// unconfigured, so a configured-but-broken store cannot masquerade
// as "never configured" and publish settlement-dependent figures.
const PLANNING_SETTLEMENT_REASONS = new Set([
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
function planningSettlementDateValid(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}

function planningSettlementEvidenceValid(evidence) {
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
      if (!planningSettlementDateValid(link.effectiveDate)
        || !planningSettlementDateValid(link.asOf)) return false;
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
        if (!planningSettlementDateValid(reversal.date)) return false;
      }
    }
  }
  return true;
}

function planningSettlementOutcome(d) {
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
    return hasEvidence && planningSettlementEvidenceValid(evidence)
      ? { kind: 'qualified', evidence }
      : invalid;
  }
  if (status.status === 'unavailable') {
    if (hasEvidence) return invalid;
    return PLANNING_SETTLEMENT_REASONS.has(status.reason)
      ? { kind: 'unavailable', reason: status.reason }
      : invalid;
  }
  return invalid;
}

function planningTrajectory(d, periods) {
  const settlement = planningSettlementOutcome(d);
  if (settlement.kind === 'unavailable') {
    return { status: 'unavailable', source: 'settlement-evidence', reason: settlement.reason };
  }
  const overlay = d.liveOverlay;
  const actuals = overlay && overlay.applied === true ? overlay.currentPeriodActuals : null;
  return Forecast.baselineTrajectory(d.plan, d.debts, d.meta.asOf, {
    periods: periods || null,
    extraFacilities: d.revolvingExtra,
    currentPeriodActuals: actuals,
    ...(settlement.kind === 'qualified' ? { settlementEvidence: settlement.evidence } : {}),
  });
}

// Slice 6 eligibility mirror — must stay aligned with Forecast.hypotheticalExtraEligible.
function planningScenarioEligibleDebt(debt) {
  if (!debt || typeof debt.id !== 'string' || !debt.id) return false;
  if (debt.id === 'heloc') return true;
  return !debt.secured && /^Revolving\b/i.test(debt.structure || '');
}

function planningScenarioEligibleDebts(debts) {
  if (!Array.isArray(debts)) return [];
  return debts.filter(planningScenarioEligibleDebt);
}

function planningScenarioParseAmount(raw) {
  if (raw == null || String(raw).trim() === '') {
    return { ok: false, reason: 'Enter an additional payment amount.' };
  }
  const n = Number(String(raw).replace(/,/g, ''));
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return { ok: false, reason: 'The amount is not a finite number Atlas can apply.' };
  }
  if (n <= 0) {
    return { ok: false, reason: 'The amount must be greater than zero.' };
  }
  const cents = Math.round(n * 100) / 100;
  if (Math.abs(n - cents) > 1e-9) {
    return { ok: false, reason: 'The amount must be a whole-cent figure.' };
  }
  return { ok: true, amount: cents };
}

function planningTrajectoryScenario(d, periods, input) {
  const overlay = d.liveOverlay;
  const actuals = overlay && overlay.applied === true ? overlay.currentPeriodActuals : null;
  const base = {
    periods: periods || null,
    currentPeriodActuals: actuals,
    extraFacilities: d.revolvingExtra,
    nature: 'additional-debt-payment',
  };
  return Forecast.baselineTrajectoryScenario(d.plan, d.debts, d.meta.asOf, Object.assign(base, input || {}));
}

function planningTrajectoryScenarioCashReprint(cash) {
  if (!cash || cash.status === 'unavailable') {
    const reason = cash && cash.reason
      ? cash.reason
      : 'Forecast unavailable.';
    return `<span class="chip c">Forecast unavailable</span><small class="planning-trajectory-reason">${reason}</small>`;
  }
  const amount = cash.ending != null && isFinite(Number(cash.ending))
    ? `<b>${money2(cash.ending)}</b>` : '';
  const asOf = cash.asOf
    ? `<small data-trajectory-scenario-cash-asof="${cash.asOf}">at ${fmtDateFull(cash.asOf)}</small>`
    : '';
  return `${amount}${planningTrajectoryChip(cash.status)}${asOf}`;
}

function planningTrajectoryScenarioDebtReprint(debt) {
  if (!debt) {
    return '<span class="chip c">Forecast unavailable</span>';
  }
  const label = debt.label ? `<span class="planning-trajectory-scenario-debt-label">${debt.label}</span>` : '';
  return `${label}
    <div data-trajectory-scenario-debt="ending"><b>${money2(debt.ending)}</b><small>Ending balance</small></div>
    <div data-trajectory-scenario-debt="paid"><b>${money2(debt.paid)}</b><small>Paid on walk</small></div>
    <div data-trajectory-scenario-debt="interest"><b>${money2(debt.interest)}</b><small>Interest on walk</small></div>`;
}

function planningTrajectoryScenarioDeltaRow(label, value, dataKey) {
  if (value == null || !isFinite(Number(value))) return '';
  return `<tr data-trajectory-scenario-delta="${dataKey || ''}">
    <th scope="row">${label}</th>
    <td colspan="2"><b>${money2(value)}</b><small>Forecast delta (scenario − baseline)</small></td>
  </tr>`;
}

function planningTrajectoryScenarioIdlePreviewHtml() {
  const dash = '<span class="planning-road-amount-unavailable" aria-label="Unavailable">—</span>';
  return `<div class="planning-trajectory-scenario-preview planning-road-whatif-preview" data-trajectory-scenario="idle" data-trajectory-scenario-preview="idle">
    <p class="subhead planning-road-whatif-preview-title">Preview</p>
    <div class="planning-road-whatif-preview-grid" aria-label="Hypothetical preview (inactive)">
      <div class="planning-road-whatif-preview-row planning-road-whatif-preview-head" aria-hidden="true">
        <span></span><span>Plan</span><span>Preview</span>
      </div>
      <div class="planning-road-whatif-preview-row"><span>Projected cash</span><span>${dash}</span><span>${dash}</span></div>
      <div class="planning-road-whatif-preview-row"><span>Named debt ending</span><span>${dash}</span><span>${dash}</span></div>
    </div>
    <p class="lede planning-road-whatif-preview-hint">Change debt or amount above, then choose Show scenario. Until then, preview stays — (not $0).</p>
  </div>`;
}

function planningTrajectoryScenarioCompareHtml(result, scenarioRequested) {
  const note = 'Additional-debt-payment scenario is Forecast.baselineTrajectoryScenario only — one caller-supplied extra on the identical planned Household Budget opening. Baseline and scenario columns copy Forecast; deltas copy Forecast.delta. This is hypothetical exploration, not a payment instruction. Atlas does not infer the amount, rank debts, or write household evidence.';
  if (!scenarioRequested) {
    return {
      panel: planningTrajectoryScenarioIdlePreviewHtml(),
      note,
    };
  }
  if (!result || result.status !== 'ready') {
    const reason = (result && result.reason) || 'Forecast scenario unavailable.';
    return {
      panel: `<div class="note-box crit" data-trajectory-scenario="unavailable">${reason}</div>`,
      note,
    };
  }
  const debtLabel = result.input && result.input.debtLabel ? result.input.debtLabel : result.input.debtId;
  const amount = result.input && result.input.amount != null ? money2(result.input.amount) : '';
  const absorbed = result.absorbed && result.absorbed.amount != null && isFinite(Number(result.absorbed.amount))
    ? `<p class="lede planning-trajectory-scenario-absorbed" data-trajectory-scenario-absorbed="${result.absorbed.amount}">Forecast absorbed <b>${money2(result.absorbed.amount)}</b> of the ${amount} extra toward <b>${debtLabel}</b> on ${fmtDateFull(result.input.asOf)}.</p>`
    : '';
  const deltaRows = [
    planningTrajectoryScenarioDeltaRow('Projected cash (published close)', result.delta && result.delta.cash ? result.delta.cash.ending : null, 'cash-ending'),
    planningTrajectoryScenarioDeltaRow('Named debt ending', result.delta && result.delta.debt ? result.delta.debt.ending : null, 'debt-ending'),
    planningTrajectoryScenarioDeltaRow('Named debt paid', result.delta && result.delta.debt ? result.delta.debt.paid : null, 'debt-paid'),
    planningTrajectoryScenarioDeltaRow('Named debt interest', result.delta && result.delta.debt ? result.delta.debt.interest : null, 'debt-interest'),
  ].join('');
  const panel = `<div class="planning-trajectory-scenario-compare" data-trajectory-scenario="ready" data-trajectory-scenario-nature="${result.nature || ''}">
    <p class="subhead">Baseline vs scenario — ${amount} extra toward ${debtLabel}</p>
    ${absorbed}
    <div class="scroll"><table class="stackable planning-trajectory-scenario-table" aria-label="Baseline versus scenario trajectory consequences">
      <thead><tr><th scope="col">Measure</th><th scope="col">Baseline</th><th scope="col">Scenario</th></tr></thead>
      <tbody>
        <tr data-trajectory-scenario-row="cash">
          <th scope="row">Projected cash (published close)</th>
          <td data-trajectory-scenario-baseline="cash">${planningTrajectoryScenarioCashReprint(result.baseline && result.baseline.cash)}</td>
          <td data-trajectory-scenario-scenario="cash">${planningTrajectoryScenarioCashReprint(result.scenario && result.scenario.cash)}</td>
        </tr>
        <tr data-trajectory-scenario-row="debt">
          <th scope="row">Named debt on walk</th>
          <td data-trajectory-scenario-baseline="debt">${planningTrajectoryScenarioDebtReprint(result.baseline && result.baseline.debt)}</td>
          <td data-trajectory-scenario-scenario="debt">${planningTrajectoryScenarioDebtReprint(result.scenario && result.scenario.debt)}</td>
        </tr>
        ${deltaRows}
      </tbody>
    </table></div>
    <p class="lede footnote planning-trajectory-scenario-disclaimer">Hypothetical only — not affordable, safe, or an instruction to pay. No money moves. Amount is not spendable cash; available credit is not cash.</p>
  </div>`;
  return { panel, note };
}

function planningTrajectoryScenarioControlsHtml(debts, draftDebtId, draftAmount, formError) {
  const eligible = planningScenarioEligibleDebts(debts);
  const intro = 'Ask what happens if you put an explicit extra payment toward one eligible debt on today\'s opening. Enter the amount and debt — Atlas does not suggest either.';
  if (!eligible.length) {
    return {
      intro,
      controls: '<div class="note-box crit" data-trajectory-scenario="no-eligible-debts">Forecast published no eligible revolving or HELOC debt for an additional-debt-payment scenario on this opening.</div>',
    };
  }
  const options = eligible.map(d => {
    const label = d.label || d.id;
    const selected = d.id === draftDebtId ? ' selected' : '';
    return `<option value="${d.id}"${selected}>${label}</option>`;
  }).join('');
  const amountAttr = draftAmount != null && draftAmount !== '' ? ` value="${String(draftAmount).replace(/"/g, '&quot;')}"` : '';
  const err = formError
    ? `<div class="note-box crit" data-trajectory-scenario="form-error">${formError}</div>` : '';
  const controls = `<form class="planning-trajectory-scenario-form" data-trajectory-scenario-form="ready">
    ${err}
    <label class="planning-trajectory-scenario-field">
      <span class="planning-trajectory-scenario-label">Debt</span>
      <select name="debtId" data-trajectory-scenario-debt="select" aria-label="Debt for additional payment scenario" required>
        <option value=""${draftDebtId ? '' : ' selected'} disabled>Select a debt</option>
        ${options}
      </select>
    </label>
    <label class="planning-trajectory-scenario-field">
      <span class="planning-trajectory-scenario-label">Extra payment amount</span>
      <input type="text" name="amount" inputmode="decimal" autocomplete="off" data-trajectory-scenario-amount="input" aria-label="Extra debt payment amount" placeholder="e.g. 100.00"${amountAttr} required>
    </label>
    <div class="planning-trajectory-scenario-actions">
      <button type="submit" class="planning-trajectory-scenario-apply" data-trajectory-scenario-action="apply">Show scenario</button>
      <button type="button" class="planning-trajectory-scenario-clear" data-trajectory-scenario-action="clear">Reset</button>
    </div>
  </form>`;
  return { intro, controls };
}

var planningScenarioActive = null;
var planningScenarioDraftDebtId = '';
var planningScenarioDraftAmount = '';
var planningScenarioFormError = '';
var planningScenarioDrawerOpen = false;

function planningScenarioSetActive(input) {
  planningScenarioActive = input;
  if (input) planningScenarioDrawerOpen = true;
}

function planningRoadAheadScenarioRequested() {
  return !!(planningScenarioActive
    && planningScenarioActive.debtId
    && typeof planningScenarioActive.amount === 'number'
    && Number.isFinite(planningScenarioActive.amount));
}

function planningRoadAheadScenarioHtml(d, periods) {
  const controls = planningTrajectoryScenarioControlsHtml(
    d && d.debts,
    planningScenarioDraftDebtId,
    planningScenarioDraftAmount,
    planningScenarioFormError);
  const requested = planningRoadAheadScenarioRequested();
  const result = requested
    ? planningTrajectoryScenario(d, periods, {
        debtId: planningScenarioActive.debtId,
        amount: planningScenarioActive.amount,
      })
    : null;
  const compare = planningTrajectoryScenarioCompareHtml(result, requested);
  const keepOpen = requested || !!planningScenarioFormError || planningScenarioDrawerOpen;
  const openAttr = keepOpen ? ' open' : '';
  return `<details class="planning-road-scenario-sheet"${openAttr} data-planning-road-secondary="scenario" data-trajectory-scenario-section="controls">
    <summary>
      <span class="planning-road-scenario-summary-label">Extra debt payment</span>
      <span class="planning-road-scenario-summary-chevron" aria-hidden="true">›</span>
    </summary>
    <p class="lede planning-road-scenario-intro">${controls.intro}</p>
    ${controls.controls}
    <div class="planning-trajectory-scenario-result" data-trajectory-scenario-result="panel">${compare.panel}</div>
    <p class="lede footnote planning-road-scenario-note" data-trajectory-scenario-note="footnote">${compare.note}</p>
  </details>`;
}

function planningRoadScenarioWire(root, d, periods) {
  if (!root) return;
  const drawer = root.querySelector('[data-trajectory-scenario-section="controls"]');
  if (drawer) {
    drawer.ontoggle = () => {
      planningScenarioDrawerOpen = !!drawer.open;
    };
  }
  const form = root.querySelector('[data-trajectory-scenario-form="ready"]');
  if (form) {
    form.onsubmit = ev => {
      ev.preventDefault();
      const debtEl = form.querySelector('[data-trajectory-scenario-debt="select"]');
      const amountEl = form.querySelector('[data-trajectory-scenario-amount="input"]');
      const debtId = debtEl ? debtEl.value : '';
      const parsed = planningScenarioParseAmount(amountEl ? amountEl.value : '');
      planningScenarioDraftDebtId = debtId;
      planningScenarioDraftAmount = amountEl ? amountEl.value : '';
      planningScenarioDrawerOpen = true;
      if (!debtId) {
        planningScenarioFormError = 'Select a debt.';
        planningScenarioActive = null;
        renderPlanning(d, periods);
        return;
      }
      if (!parsed.ok) {
        planningScenarioFormError = parsed.reason;
        planningScenarioActive = null;
        renderPlanning(d, periods);
        return;
      }
      planningScenarioFormError = '';
      planningScenarioActive = { debtId, amount: parsed.amount };
      renderPlanning(d, periods);
    };
  }
  const clearBtn = root.querySelector('[data-trajectory-scenario-action="clear"]');
  if (clearBtn) {
    clearBtn.onclick = () => {
      planningScenarioActive = null;
      planningScenarioDraftDebtId = '';
      planningScenarioDraftAmount = '';
      planningScenarioFormError = '';
      planningScenarioDrawerOpen = true;
      renderPlanning(d, periods);
    };
  }
}

function planningPageHtml(advice, liveOverlay) {
  advice = advice || {};
  const unavailable = advice.operatingPlanUnavailable === true
    || (liveOverlay && liveOverlay.operatingPlan === 'unavailable');
  if (unavailable) {
    const note = advice.operatingPlanNote || (liveOverlay && liveOverlay.operatingPlanNote)
      || 'Current plan unavailable. The dated opening is stale.';
    return {
      lede: '',
      list: `<div class="note-box crit" data-operating-plan="unavailable">${note} Forecast verdicts for future costs are withheld until a trusted current opening exists.</div>`,
      note: '',
    };
  }
  const plans = Array.isArray(advice.majorPlans) ? advice.majorPlans : [];
  const alloc = advice.paydayAllocation || {};
  const paydayCosts = Array.isArray(alloc.futureCosts) ? alloc.futureCosts : [];
  const paydayOptional = Array.isArray(alloc.optional) ? alloc.optional : [];
  const unresolvedRows = Array.isArray(alloc.unresolved) ? alloc.unresolved : [];
  if (!plans.length) {
    return {
      lede: '',
      list: '<p class="lede">No unsettled future costs are on this opening.</p>',
      note: '',
    };
  }
  const list = plans.map(row => {
    const payday = paydayCosts.find(item => item.id === row.id)
      || paydayOptional.find(item => item.id === row.id) || null;
    const unresolved = unresolvedRows.find(item => item.id === row.id) || null;
    return planningRowHtml(row, payday, unresolved);
  }).join('');
  const knowledge = advice.knowledge || {};
  const horizon = knowledge.end
    ? `${plans.length} cost${plans.length === 1 ? '' : 's'} on the Forecast master plan through ${fmtDateFull(knowledge.end)}, in Forecast's funding order.`
    : `${plans.length} cost${plans.length === 1 ? '' : 's'} on the Forecast master plan, in Forecast's funding order.`;
  const floor = knowledge.encumbered != null && isFinite(Number(knowledge.encumbered))
    ? ` Forecast protects a floor of ${money2(knowledge.encumbered)} across the required and flexible costs — ranges count at their low end, optional costs and dated costs already in the cash walk are not in that figure. It is a protected floor, not a total.`
    : '';
  return {
    lede: horizon + floor,
    note: 'Verdicts, remaining amounts and any set-aside are Forecast.majorPlans and Forecast.paydayAllocation. A range is printed as a range. Approximate timing is printed as the household stated it. Atlas does not track a dedicated saved balance for these costs, so none is shown. Nothing here ranks costs or moves money.',
    list,
  };
}

function planningAdvice(d, periods) {
  const settlement = planningSettlementOutcome(d);
  if (settlement.kind === 'unavailable') {
    // The withheld verdict reuses the page's existing operating-plan
    // unavailable gate (planningPageHtml) with the settlement reason
    // as the note; no Forecast call is made and no figure is derived.
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
    ...(settlement.kind === 'qualified' ? { settlementEvidence: settlement.evidence } : {}),
  });
}

function planningRoadAheadScrollSelectedTimeline(root, selectedKey) {
  if (!root || !selectedKey) return;
  const esc = typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(selectedKey)
    : String(selectedKey).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const item = root.querySelector(`[data-road-timeline-period="${esc}"]`);
  if (!item) return;
  const strip = item.closest('.planning-road-timeline')
    || root.querySelector('[data-road-timeline="ready"]');
  if (!strip || typeof strip.scrollLeft !== 'number') return;
  const maxScroll = strip.scrollWidth - strip.clientWidth;
  if (maxScroll <= 0) return;
  const target = item.offsetLeft + (item.offsetWidth * 0.5) - (strip.clientWidth * 0.5);
  const left = Math.max(0, Math.min(maxScroll, target));
  try {
    strip.scrollTo({ left, behavior: 'instant' });
  } catch (_) {
    try {
      strip.scrollTo({ left, behavior: 'auto' });
    } catch (_2) {
      strip.scrollLeft = left;
    }
  }
}

/** The hero's "See what's behind …" is layer 1 → layer 3 in one tap: it selects
 *  that period and moves reading position to its story. */
let planningRoadPendingStoryFocus = false;
let planningRoadPendingTabFocus = false;

function planningRoadAheadTablistNextGranularity(tabs, key) {
  if (!tabs) return null;
  const rows = [];
  const n = typeof tabs.length === 'number' ? tabs.length : 0;
  for (let i = 0; i < n; i++) {
    const tab = tabs[i];
    const id = tab && typeof tab.getAttribute === 'function'
      ? tab.getAttribute('data-trajectory-funding-granularity')
      : null;
    if (id) rows.push({ tab, id });
  }
  if (!rows.length) return null;
  const selectedAt = rows.findIndex(row => row.tab.getAttribute('aria-selected') === 'true');
  const current = selectedAt >= 0 ? selectedAt : 0;
  let next = current;
  if (key === 'ArrowRight') next = (current + 1) % rows.length;
  else if (key === 'ArrowLeft') next = (current - 1 + rows.length) % rows.length;
  else if (key === 'Home') next = 0;
  else if (key === 'End') next = rows.length - 1;
  else return null;
  return rows[next].id;
}

function planningRoadAheadFocusSelectedTab(root) {
  if (!planningRoadPendingTabFocus) return;
  planningRoadPendingTabFocus = false;
  if (!root || typeof root.querySelector !== 'function') return;
  const selected = root.querySelector(
    '.planning-road-segmented[role="tablist"] [role="tab"][aria-selected="true"]');
  if (!selected || typeof selected.focus !== 'function') return;
  try {
    selected.focus();
  } catch (_) { /* ignore */ }
}

function planningRoadAheadFocusPeriodStory(root) {
  if (!planningRoadPendingStoryFocus) return;
  planningRoadPendingStoryFocus = false;
  if (!root || typeof root.querySelector !== 'function') return;
  const title = root.querySelector('#planning-road-period-title');
  if (!title || typeof title.focus !== 'function') return;
  try {
    title.focus({ preventScroll: true });
  } catch (_) {
    title.focus();
  }
  if (typeof title.scrollIntoView === 'function') {
    try {
      title.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (_2) {
      title.scrollIntoView();
    }
  }
}

function planningRoadAheadWireSelection(root, d, periods) {
  if (!root) return;
  const buttons = root.querySelectorAll('[data-road-select-period]');
  for (const btn of buttons) {
    btn.onclick = () => {
      const key = btn.getAttribute('data-road-select-period');
      if (!key) return;
      if (btn.getAttribute('data-road-focus-period')) planningRoadPendingStoryFocus = true;
      if (planningTrajectoryFundingGranularity === 'pay-period') {
        planningTrajectorySelectedPayPeriod = key;
      } else {
        planningTrajectorySelectedMonth = key;
      }
      renderPlanning(d, periods);
    };
  }
  const granBtns = root.querySelectorAll('[data-trajectory-funding-granularity]');
  for (const btn of granBtns) {
    btn.onclick = () => {
      const next = btn.getAttribute('data-trajectory-funding-granularity');
      if (!next || next === planningTrajectoryFundingGranularity) return;
      planningTrajectoryFundingGranularity = next;
      renderPlanning(d, periods);
    };
  }
  const tablist = typeof root.querySelector === 'function'
    ? root.querySelector('.planning-road-segmented[role="tablist"]')
    : null;
  if (tablist) {
    tablist.onkeydown = (event) => {
      if (!event || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight'
        && event.key !== 'Home' && event.key !== 'End')) {
        return;
      }
      const tabs = typeof tablist.querySelectorAll === 'function'
        ? tablist.querySelectorAll('[role="tab"][data-trajectory-funding-granularity]')
        : [];
      const next = planningRoadAheadTablistNextGranularity(tabs, event.key);
      if (!next || next === planningTrajectoryFundingGranularity) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      planningTrajectoryFundingGranularity = next;
      planningRoadPendingTabFocus = true;
      renderPlanning(d, periods);
    };
  }
}

function renderPlanning(d, periods) {
  // ATLAS-080: configured-but-unavailable settlement evidence
  // withholds the Road Ahead wholesale — a fixed notice naming the
  // loader's reason replaces the shell, so no settlement-dependent
  // figure, timeline, waterfall or scenario output can leak through
  // this mount, and the withheld output cannot vary with the figures
  // it withholds.
  const settlement = planningSettlementOutcome(d);
  if (settlement.kind === 'unavailable') {
    const roadRoot = $('planning-road-ahead');
    if (roadRoot) {
      roadRoot.innerHTML = `<div class="planning-road-shell" data-planning-road-shell="unavailable" data-settlement-evidence="unavailable" data-settlement-reason="${settlement.reason}">
      <header class="planning-road-app-head" aria-label="Road Ahead">
        <div class="planning-road-app-head-row">
          <div class="planning-road-app-identity">
            <p class="planning-road-app-eyebrow">FORECAST</p>
            <h2 class="planning-road-app-title">Road Ahead</h2>
          </div>
        </div>
      </header>
      <div class="note-box crit" data-road-ahead="unavailable">Road Ahead is withheld: settlement evidence is unavailable (${settlement.reason}). Savings, funding and transfer figures that depend on settlement evidence are not shown, rather than shown as if no settlement existed.</div>
    </div>`;
    }
    return;
  }
  const traj = planningTrajectory(d, periods);
  const asOf = d && d.meta && d.meta.asOf ? d.meta.asOf : null;
  if (traj && traj.status === 'ready' && Array.isArray(traj.months) && traj.months.length) {
    if (!planningTrajectorySelectedMonth
      || !traj.months.some(m => m.month === planningTrajectorySelectedMonth)) {
      planningTrajectorySelectedMonth = traj.months[0].month;
    }
  } else {
    planningTrajectorySelectedMonth = null;
  }
  if (traj && traj.status === 'ready' && Array.isArray(traj.payPeriods) && traj.payPeriods.length) {
    if (!planningTrajectorySelectedPayPeriod
      || !traj.payPeriods.some(p => (p.payday || p.id) === planningTrajectorySelectedPayPeriod)) {
      const first = traj.payPeriods[0];
      planningTrajectorySelectedPayPeriod = first.payday || first.id;
    }
  } else if (planningTrajectoryFundingGranularity === 'pay-period') {
    planningTrajectorySelectedPayPeriod = null;
  }
  if (planningTrajectoryFundingGranularity !== 'month'
    && planningTrajectoryFundingGranularity !== 'pay-period') {
    planningTrajectoryFundingGranularity = 'month';
  }
  const roadSelectedKey = planningTrajectoryFundingGranularity === 'pay-period'
    ? planningTrajectorySelectedPayPeriod
    : planningTrajectorySelectedMonth;
  const roadHtml = planningRoadAheadHtml(traj, planningTrajectoryFundingGranularity, roadSelectedKey, asOf);
  const roadRoot = $('planning-road-ahead');
  if (roadRoot) {
    const freshness = asOf
      ? `<p class="planning-road-freshness" data-road-freshness="as-at"><span class="planning-road-freshness-icon" aria-hidden="true"></span>As at ${fmtDateLong(asOf)}</p>`
      : '';
    roadRoot.innerHTML = `<div class="planning-road-shell" data-planning-road-shell="ready" data-planning-road-waterfall="primary">
      <header class="planning-road-app-head" aria-label="Road Ahead">
        <div class="planning-road-app-head-row">
          <div class="planning-road-app-identity">
            <p class="planning-road-app-eyebrow">FORECAST</p>
            <h2 class="planning-road-app-title">Road Ahead</h2>
          </div>
          ${freshness}
        </div>
        <p class="planning-road-app-sub">${roadHtml.subtitle}</p>
      </header>
      <p class="lede planning-road-intro planning-road-intro-inline">${roadHtml.intro}</p>
      <section class="planning-road-horizon-band" aria-label="Horizon" data-planning-road-primary="horizon">
        ${roadHtml.horizonCounts}
        <div class="planning-road-period-nav" data-planning-road-primary="strip-controls" aria-label="Horizon period navigation">
          <div class="planning-road-timeline-wrap" data-planning-road-primary="strip">
            ${roadHtml.timeline}
          </div>
        </div>
      </section>
      <section class="planning-road-period-detail" aria-label="Selected period waterfall" data-planning-road-primary="waterfall">
        ${roadHtml.periodHeader}
        <div id="planning-road-view-panel" role="tabpanel">
          <div class="planning-road-primary" data-planning-road-primary="lead">
            ${roadHtml.lead}
          </div>
          ${roadHtml.stages}
        </div>
      </section>
      <div class="planning-road-breakdown-band" data-planning-road-primary="breakdown">
        ${roadHtml.breakdown}
      </div>
      ${planningRoadAheadScenarioHtml(d, periods)}
    </div>`;
    planningRoadAheadWireSelection(roadRoot, d, periods);
    planningRoadScenarioWire(roadRoot, d, periods);
    planningRoadAheadScrollSelectedTimeline(roadRoot, roadSelectedKey);
    planningRoadAheadFocusPeriodStory(roadRoot);
    planningRoadAheadFocusSelectedTab(roadRoot);
  }
}

App.register(renderPlanning);
App.boot({ periods: true });
