'use strict';
// Both surfaces print the same Forecast inventory. No totals, allocation,
// backing, freshness or target arithmetic belongs to this renderer.
(function (root) {
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = value => typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(value) : 'Unknown';
  const stateNames = { backed: 'Backed by observed cash', deficit: 'Pool deficit', stale: 'Stale balance',
    'cash-unknown': 'Cash unknown', 'intent-unknown': 'Assignments unknown',
    'pending-evidence': 'Pending evidence', 'goal-unresolved': 'Goal needs reconciliation' };
  const amount = (label, value, trust, attr, periodContext = false) => `<div class="savings-inventory-fact"${attr ? ` data-savings-${attr}` : ''}><dt>${label}</dt><dd>${money(value)}${periodContext ? '' : ` <small>${escape(trust || 'unknown')}</small>`}</dd></div>`;
  // Format the exact attached publication only. Each fact is independent:
  // no subtraction, member aggregation, raw commitment lookup or need fallback.
  // The caller withholds historical/closing facts and ambiguous row identities.
  function commitmentCostHtml(row, options = {}) {
    if (!row || !(row.commitmentCost || row.source === 'commitment'
        || /^(commitment|group):/.test(row.key))) return '';
    const cost = row.commitmentCost;
    const date = cost?.asOf;
    const dated = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
    const numeric = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    const fact = value => {
      if (options.withheld || !dated || value?.status !== 'known') return 'Unknown';
      if (numeric(value.amount) && value.range === null) return money(value.amount);
      if (value.amount === null && numeric(value.range?.min) && numeric(value.range?.max)
          && value.range.min <= value.range.max)
        return money(value.range.min) + ' - ' + money(value.range.max);
      return 'Unknown';
    };
    const savedTrust = row.savedTrust ?? row.trust;
    const saved = !options.withholdSaved && numeric(row.saved) && ['verified', 'calculated', 'estimated'].includes(savedTrust)
      ? money(row.saved) + ' <small>' + escape(savedTrust) + '</small>' : 'Unknown';
    const field = (name, label, value) => `<div class="savings-inventory-fact" data-savings-cost-${name}><dt>${label}</dt><dd>${value}</dd></div>`;
    return `<div data-savings-cost-breakdown>${dated && !options.withheld ? '<p>Cost facts as of ' + escape(date) + '</p>' : ''}<dl>${field('original', 'Original cost', fact(cost?.originalCost))}${field('paid', 'Confirmed payment assignments', fact(cost?.confirmedLinkedPaid))}${field('unpaid', 'Unpaid cost', fact(cost?.unpaidCost))}${options.includeSaved === false ? '' : field('saved', escape(options.savedLabel || 'Currently backed'), saved)}</dl><p>Known means published, not bank-verified. Payment assignments are separate from Saved. Unpaid cost is not additional savings needed or a funding shortfall.</p></div>`;
  }
  // Presentation join only, mirroring the Budget savings surfaces: a grouped
  // row's members are already published by Forecast (backing.items, plus
  // unresolved for withheld members) and its this-period components already
  // published in period.cycleAllocations. No figure is computed here: a
  // member prints only when its key matches exactly one published item, and
  // a member allocation prints only when exactly one published allocation
  // names it; otherwise the figure stays unknown and the group-level
  // published value stands. Settled members are absent from the publication
  // and are never reconstructed here. The allocation identity follows the
  // period kind Forecast publishes (current: occurrence key item.key;
  // projected: bare requirement id item.id), must be unique across the
  // published items and allocations, and is never dual-alias matched.
  // Historical packets withhold the group's figures, so member figures
  // withhold identically — names and dates print, today's numbers do not.
  // Evidence display only (A4a): signed direction, history coverage and the
  // unresolved list. No amount and no arithmetic; Saved, Paid and household
  // spending are unchanged until A4b.
  function linkEvidenceHtml(packet, row) {
    const links = row?.savingsLinks;
    if (links?.source !== 'Forecast.savingsLinks' || links.status !== 'available'
        || links.mode !== 'foundation' || packet.period?.kind === 'historical' || packet.period?.kind === 'projected') return '';
    const relevant = links.links.filter(link => link.goalKey === row?.key
      || link.occurrenceKey && row?.members?.includes(link.occurrenceKey));
    const unresolved = links.unresolved || { links: [], evidence: [], total: 0 };
    if (!relevant.length && !unresolved.total) return '';
    const refs = new Set(relevant.map(link => link.ref));
    const reasons = { 'conflicting-links': 'Conflicting item, occurrence or anchor links',
      nonconsumption: 'Transfer or other nonconsumption evidence', 'replacement-unresolved': 'Pending replacement unresolved',
      'posting-unconfirmed': 'Posting status unconfirmed' };
    const linkReasons = { 'native-target-unresolved': 'Item not found', 'anchor-unconfirmed': 'Anchor revision unconfirmed',
      'occurrence-unresolved': 'Occurrence not found' };
    const entries = links.evidence.filter(item => item.linkRefs.some(ref => refs.has(ref)));
    const state = item => item.state === 'posted' ? (item.direction === 'refund' ? 'Posted refund evidence' : 'Posted evidence')
      : item.state === 'pending' ? 'Pending evidence — not posted' : 'Unresolved: ' + escape(reasons[item.reason] || 'Identity unconfirmed');
    const linked = relevant.length ? `<ul>${relevant.map(link => `<li>${link.type === 'category' ? 'Category link' : 'Tag link'}: ${escape(link.occurrenceKey || 'Unresolved occurrence')} · ${escape(link.effectiveFrom)} through ${escape(link.effectiveThrough)}${link.status === 'linked' ? '' : ' · Unresolved'}${link.history === 'complete' ? '' : ' · History not fully covered'}</li>`).join('')}</ul><ul>${entries.map(item => `<li data-savings-linked-transaction="${escape(item.transactionRef)}">${escape(item.date)} · ${escape(item.transactionRef)} · ${state(item)}</li>`).join('') || '<li>No matching evidence in this observation window.</li>'}</ul>` : '';
    const open = unresolved.total ? `<div data-savings-link-unresolved="${escape(unresolved.total)}"><p>Unresolved links and evidence: ${escape(unresolved.total)}</p><ul>${unresolved.links.map(link => `<li>${link.type === 'category' ? 'Category link' : 'Tag link'} ${escape(link.ref)} · ${escape(linkReasons[link.reason] || 'Unresolved')}</li>`).join('')}${unresolved.evidence.map(item => `<li data-savings-unresolved-transaction="${escape(item.transactionRef)}">${escape(item.date)} · ${escape(item.transactionRef)} · ${escape(reasons[item.reason] || 'Identity unconfirmed')}</li>`).join('')}</ul></div>` : '';
    return `<details data-savings-link-evidence><summary>Category / tag links &amp; evidence</summary><p>Foundation: linked evidence only. Saved, Paid and household spending are unchanged.</p><p>Mapping version ${escape(links.version)}; anchor revision ${escape(links.anchorRevision)}.</p>${linked}${open}</details>`;
  }
  function groupMembers(packet, row) {
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
  function memberHtml(packet, row) {
    const group = groupMembers(packet, row);
    if (!group) return { title: row.label, html: '' };
    const members = group.members.map(member => {
      const item = member.item;
      const projected = packet.period?.kind === 'projected';
      if (group.historical) return `<li data-savings-member="${escape(member.key)}"><b>${escape(item ? item.label : 'Member name unavailable')}</b> <span>${escape(item?.date || 'Date unavailable')}</span><dl>${amount('Currently backed', null, 'unknown', 'member-backed')}${amount('Needed', null, 'unknown', 'member-needed')}${amount('Projected this period', null, 'unknown', 'member-period')}</dl></li>`;
      const needed = item && item.needed == null && item.neededRange
        && (item.trust === 'calculated' || item.trust === 'estimated')
        ? `<div class="savings-inventory-fact" data-savings-member-needed><dt>Needed</dt><dd>${money(item.neededRange.min)} - ${money(item.neededRange.max)}${projected ? '' : ` <small>${escape(item.trust || 'unknown')}</small>`}</dd></div>`
        : amount('Needed', item ? item.needed : null, item ? item.trust : 'unknown', 'member-needed', projected);
      const savedLabel = projected ? 'Saved'
        : packet.goalAllocation?.status === 'ready' && packet.backing?.status !== 'ready'
        ? 'Saved allocation' : 'Currently backed';
      const cost = commitmentCostHtml(item, { withheld: projected, savedLabel: projected ? 'Saved at period close' : savedLabel });
      return `<li data-savings-member="${escape(member.key)}"><b>${escape(item ? item.label : 'Member name unavailable')}</b> <span>${escape(item?.date || 'Date unavailable')}</span><dl>${amount(savedLabel, item ? item.saved : null, item ? item.trust : 'unknown', 'member-backed', projected)}${needed}${amount(projected ? 'This period' : 'Projected this period', member.thisPeriod, member.thisPeriod == null ? 'unknown' : row.thisPeriodTrust, 'member-period', projected)}</dl>${cost ? '<details><summary>Cost breakdown</summary>' + cost + '</details>' : ''}</li>`;
    }).join('');
    return { title: group.title, html: `<ul class="savings-inventory-members">${members}</ul>` };
  }
  function html(inventory, context = {}) {
    if (inventory?.source === 'Forecast.savingsDailyFunding' || context.plan?.savingsEarmarks?.allocationPolicy != null) {
      const forecast = root.Forecast || (typeof require === 'function' ? require('./forecast') : null);
      const packet = forecast?.savingsFundingPublication(inventory, context);
      if (!packet) {
        return '<section class="savings-inventory" data-savings-inventory="unavailable"><h2>One savings pot</h2><p>Shared savings evidence is unavailable. No zero saved balance has been assumed.</p></section>';
      }
      if (packet.allocationMode === 'historical-pools' && packet.manualInventory)
        return html(packet.manualInventory);
      // The Travel Visa annual fee is a bill, not a savings goal: its
      // published yearly-bill funding row is not printed here (it is shown
      // under Bills as an upcoming annual bill). Display-only — the packet,
      // its funding and its totals are never altered. Identity is the
      // published row key, derived by Forecast from the backing item's
      // source + id; the label is never matched.
      const annualBillRow = 'yearly-bill:travelvisa-annual-fee-2027';
      const projected = packet.period?.kind === 'projected';
      const closing = projected && packet.forecastClosing?.status === 'ready';
      const publishedRows = projected && packet.forecastClosing != null
        ? (closing ? packet.forecastClosing.rows : packet.forecastClosing?.gap ? [] : packet.plannedRequirements?.rows || []).map(row => ({ ...row,
          saved: row.forecastSaved ?? null, savedTrust: row.forecastSaved == null ? 'unknown' : 'estimated',
          thisPeriod: row.forecastContribution ?? null, thisPeriodTrust: row.forecastContribution == null ? 'unknown' : 'estimated' }))
        : packet.rows || [];
      const annualBillExcluded = publishedRows.some(row => row?.key === annualBillRow);
      const reported = packet.stock?.reportedStock;
      // Current packets omit kind; selected historical/projected packets
      // retain source evidence but explicitly withhold actual stock.
      const currentStock = packet.period?.kind == null || packet.period.kind === 'current';
      const reportedKnown = currentStock && reported?.status === 'ready' && reported.basis === 'reported-savings-stock'
        && reported.evidenceTrust === 'provider-reported' && reported.trust === 'calculated'
        && reported.currency === 'CAD' && reported.nonAdditive === true && reported.asOf === packet.asOf
        && typeof reported.amount === 'number' && Number.isFinite(reported.amount)
        && Array.isArray(reported.balanceDates) && reported.balanceDates.length === 2
        && new Set(reported.balanceDates.map(row => row?.accountId)).size === 2;
      // Decision 1 (owner 2026-10-29): a reported-balance estimate is tagged
      // and explains its basis; it never reads as verified backing.
      const estimate = closing && packet.forecastClosing.nature === 'reported-balance-estimate';
      const estimateCopy = estimate ? '<p data-savings-closing-estimate>Estimated from the reported Savings balance dated '
        + escape(packet.forecastClosing.balanceAsOf) + '. ' + (packet.forecastClosing.assumptions || []).map(escape).join(' ')
        + ' Verified backing is withheld: ' + escape(packet.forecastClosing.verifiedReason) + '</p>' : '';
      const stockCopy = projected ? 'Savings at period close: ' + (estimate ? '≈ ' : '') + money(packet.forecastClosing?.stock)
        + (estimate ? ' (estimated)' : '') + '.' : reportedKnown
        ? 'Reported combined savings: ' + money(reported.amount) + '. Balance dates '
          + escape(reported.balanceFrom) + (reported.balanceFrom === reported.balanceThrough ? '' : ' - ' + escape(reported.balanceThrough)) + '.'
        : currentStock ? 'Observed stock as of ' + escape(packet.asOf) + ': ' + money(packet.stock?.amount) + '.'
        : 'Stock for this selected period: Unknown.';
      const savedLabel = projected ? 'Saved' : packet.goalAllocation?.status === 'ready' && packet.backing?.status !== 'ready'
        ? 'Saved allocation' : 'Currently backed';
      const rows = publishedRows.filter(row => row?.key !== annualBillRow).map(row => {
        const members = memberHtml(packet, row);
        const cost = commitmentCostHtml(row, { withheld: projected || packet.period?.kind === 'historical'
          || publishedRows.filter(other => other.key === row.key).length !== 1,
          savedLabel: projected ? 'Saved at period close' : savedLabel });
        return `<article data-savings-goal="${escape(row.key)}"><h3>${escape(members.title)}</h3><dl>${amount(savedLabel, row.saved, row.savedTrust, 'backed', projected)}${amount('Needed', row.needed, row.neededTrust, 'needed', projected)}${amount(projected ? 'This period' : 'Projected this period', row.thisPeriod, row.thisPeriodTrust, null, projected)}</dl>${cost ? '<details><summary>Cost breakdown</summary>' + cost + '</details>' : ''}${linkEvidenceHtml(packet, row)}${members.html}</article>`;
      }).join('');
      const pools = (packet.backing?.pools || []).map(pool => `<li>${escape(pool.label || pool.accountId)}: ${money(pool.observedCash)} <small>${escape(pool.observedAsOf || 'Date unavailable')}</small></li>`).join('');
      return `<section class="savings-inventory" data-savings-inventory="${escape(projected ? packet.forecastClosing?.status || 'unavailable' : packet.backing?.status || 'unavailable')}"><h2>One savings pot</h2><p>${stockCopy}${projected ? '' : ' ' + savedLabel + ' amounts follow unpaid planning dates across both reserves.'}</p>${projected ? !closing ? '<p>'+escape(packet.forecastClosing?.reason || 'Closing Savings data is unavailable.')+'</p>' : estimateCopy : '<p>'+escape(packet.goalAllocation?.status === 'ready' ? packet.allocationDescription : 'Calculated backing is separate from manual assignments, actual transfers and future projected top-ups.')+'</p>'}${!projected && packet.backing?.reason ? '<p>'+escape(packet.backing.reason)+'</p>' : ''}${rows}${annualBillExcluded ? '<p class="operating-note" data-savings-annual-bill-note>Travel Visa annual fee is treated as a bill; its funding is unchanged.</p>' : ''}<details><summary>Accounts &amp; evidence</summary><ul>${pools}</ul>${projected ? '' : '<p>Saved allocation is a reported earmark, not money moved or a bill paid. Physical withdrawal routing and money movement are not authorized by this view.</p>'}</details></section>`;
    }
    const packet = inventory || { status: 'setup-unknown', reason: 'Savings setup is unknown.' };
    const head = '<h2>Savings assigned to goals</h2>';
    if (packet.status !== 'ready') return `<section class="savings-inventory" data-savings-inventory="${escape(packet.status)}">${head}<p>${escape(packet.reason)}</p><p class="operating-note">Starting assignments are unknown. No zero saved balance has been assumed.</p>${packet.instructionReason ? `<p>${escape(packet.instructionReason)}</p>` : ''}</section>`;
    const pools = (packet.pools || []).map(pool => `<article class="savings-inventory-pool" data-savings-pool="${escape(pool.id)}" data-savings-state="${escape(pool.status)}">
      <div class="savings-inventory-heading"><h3>${escape(pool.label)}</h3><span class="chip ${pool.status === 'backed' ? 'v' : 'w'}">${escape(stateNames[pool.status] || 'Unknown')}</span></div>
      <p>${escape(pool.reason)}</p><p class="operating-note">Balance evidence: ${escape(pool.observedAsOf || 'Unknown')} · ${escape(pool.currency)}</p>
      ${pool.purpose ? `<p>${escape(pool.purpose)}</p>` : ''}
      ${!pool.intentKnown && (pool.plannedGoals || []).length ? `<ul>${pool.plannedGoals.map(goal => `<li>${escape(goal.label)} — assignment and backing await confirmation</li>`).join('')}</ul>` : ''}
      <dl>${amount('Observed pool cash', pool.observedCash, pool.observedTrust, 'cash')}${amount('Confirmed assigned', pool.intent, pool.intentTrust, 'intent')}${amount('Unallocated cash', pool.unallocated, pool.unallocatedTrust, 'unallocated')}${pool.deficit > 0 ? amount('Pool deficit', pool.deficit, pool.deficitTrust, 'deficit') : ''}</dl>
      ${pool.intentKnown ? `<p class="operating-note">Confirmed ${escape(pool.confirmedAt)}, revision ${escape(pool.revision)} · ${escape(pool.confirmationSource)}</p>` : ''}
      ${pool.allocations.length ? `<ul class="savings-inventory-allocations">${pool.allocations.map(row => `<li data-savings-allocation="${escape(row.goalKey)}"><b>${escape(row.label)}</b><span>Confirmed: ${money(row.intent)}</span><span>Currently backed: ${money(row.backed)} <small>${escape(row.backedTrust)}</small></span></li>`).join('')}</ul>` : `<p class="operating-note">${pool.intentKnown ? 'No goal assignments in this confirmed snapshot.' : 'Starting goal assignments have not been supplied.'}</p>`}
    </article>`).join('');
    const goals = (packet.goals || []).map(goal => `<article class="savings-inventory-goal" data-savings-goal="${escape(goal.key)}"><h3>${escape(goal.label)}</h3>
      <dl>${amount('Confirmed across pools', goal.intent, 'calculated')}${amount('Currently backed', goal.backed, goal.backedTrust)}${amount('Existing goal requirement', goal.target, goal.targetTrust)}${goal.targetMax != null && goal.targetMax !== goal.target ? amount('Upper requirement', goal.targetMax, goal.targetTrust) : ''}</dl>
      ${commitmentCostHtml({ ...goal, saved: goal.backed, savedTrust: goal.backedTrust })}${linkEvidenceHtml(packet, goal)}${goal.settled ? '<p>Goal is settled. Its earmark remains assigned.</p>' : ''}<p class="operating-note">${escape(goal.release)}</p></article>`).join('');
    return `<section class="savings-inventory" data-savings-inventory="ready">${head}<p class="operating-note">These assignments divide the same observed cash. They are not extra cash to add to balances or reserve backing. Deposits remain unallocated; settled withdrawals use that residual first. Silver already in a pool is included once, with no inferred purpose.</p>
      <div class="savings-inventory-pools">${pools}</div>${goals ? `<details class="savings-inventory-goals"><summary>Goal requirements and assignments</summary>${goals}</details>` : ''}
      <p class="operating-note" data-savings-instructions="withheld">${escape(packet.instructionReason)}</p></section>`;
  }
  root.SavingsInventory = { html, commitmentCostHtml, linkEvidenceHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SavingsInventory;
})(typeof window !== 'undefined' ? window : globalThis);
