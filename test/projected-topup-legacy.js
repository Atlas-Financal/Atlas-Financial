'use strict';
const assert = require('node:assert/strict');

// One authority (2026-11-19): a projected period's Savings top-up reprints the
// Budget's own period funding (view.funding), or is withheld. The frozen engine
// predates that, so its projected packets are rewritten here from its OWN
// published Budget funding, in cents; the caller's deepEqual then checks the
// current engine to the cent. Proved in test-savings-projected-topup-one-authority.js.
function budgetFundingTopUps(advice) {
  const cents = value => Math.round(Number(value) * 100);
  for (const view of advice?.savingsFunding?.periodViews || []) {
    const packet = view?.packet, f = view?.funding;
    // A packet the frozen engine already withheld keeps its own reason: a later
    // withholding pass (for example uncertain settlement evidence) owns it on both sides.
    if (packet?.period?.kind !== 'projected' || packet.period.status !== 'ready') continue;
    const published = f && (f.status === 'ready' || f.status === 'funding-gap')
      && f.start === view.start && f.end === view.end && Array.isArray(f.items);
    if (published) {
      const parts = f.items.filter(item => cents(item.contribution) > 0)
        .map(item => ({ id: item.id, label: item.label, amount: item.contribution }));
      assert.equal(parts.reduce((sum, part) => sum + cents(part.amount), 0), cents(f.contribution),
        'the frozen Budget funding closes to its contribution');
      const ids = row => [...(packet.backing?.items || []), ...(packet.unresolved || [])]
        .filter(item => row.members.includes(item.key)).map(item => item.id);
      for (const row of packet.rows) row.thisPeriod = parts.filter(part => ids(row).includes(part.id))
        .reduce((sum, part) => sum + cents(part.amount), 0) / 100;
      Object.assign(packet.period, { proposal: f.contribution, allocations: parts, cycleAllocations: parts });
    } else {
      assert.ok(typeof f?.reason === 'string' && f.reason, 'unpublished Budget funding carries its reason');
      packet.status = 'unavailable';
      for (const row of packet.rows) Object.assign(row, { thisPeriod: null, thisPeriodTrust: 'unknown' });
      Object.assign(packet.period, { status: 'unavailable', trust: 'unknown', proposal: null,
        allocations: [], cycleAllocations: [], reason: f.reason });
    }
  }
  // The payday lens reprints the next period's Budget funding the same way.
  const lens = (advice?.savingsFunding?.lenses || []).find(entry => entry?.key === 'payday');
  const next = (advice?.savingsFunding?.periodViews || []).find(view => view?.role === 'next');
  const f = next?.funding;
  if (lens && next && lens.ready === true) {
    const published = f && (f.status === 'ready' || f.status === 'funding-gap')
      && f.start === next.start && f.end === next.end && Array.isArray(f.items);
    const byId = new Map(published ? f.items.map(item => [item.id, item]) : []);
    Object.assign(lens, published
      ? { ready: true, payday: next.start, trust: f.trust, fundingTrust: f.trust, proposal: f.contribution,
        remaining: f.items.reduce((sum, item) => sum + Math.max(0, cents(item.remainingGap)), 0) / 100,
        gap: f.gap || null, reason: null }
      : { ready: false, payday: null, trust: 'unknown', fundingTrust: 'unknown', proposal: null,
        remaining: null, gap: null, reason: f?.reason });
    for (const item of lens.items || []) item.contribution = published
      ? (cents(byId.get(item.requirementId)?.contribution) > 0 ? byId.get(item.requirementId).contribution : 0) : null;
  }
  return advice;
}

module.exports = budgetFundingTopUps;
