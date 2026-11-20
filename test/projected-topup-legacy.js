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
  // The published payday schedule (the payday panel's linked detail) keeps
  // its payday rows only where its first payday reprints that same Budget
  // top-up: the same payday, total and named amounts, in cents. Otherwise its
  // payday rows and gap are withheld with the engine's reason; costs, groups,
  // status and as-of are compared unchanged.
  const schedule = advice?.savingsFunding?.schedule;
  if (schedule && schedule.status !== 'unavailable' && next) {
    const published = f && (f.status === 'ready' || f.status === 'funding-gap')
      && f.start === next.start && f.end === next.end && Array.isArray(f.items);
    const first = Array.isArray(schedule.paydays) ? schedule.paydays[0] : null;
    const parts = list => new Map((list || []).filter(part => part && cents(part.amount) > 0)
      .map(part => [part.id, cents(part.amount)]));
    const budget = published ? new Map(f.items.filter(item => cents(item.contribution) > 0)
      .map(item => [item.id, cents(item.contribution)])) : null;
    const mine = first ? parts(first.allocations) : null;
    const agrees = published && first && first.payday === next.start
      && cents(first.contribution) === cents(f.contribution)
      && mine.size === budget.size && [...mine].every(([id, value]) => budget.get(id) === value);
    if (!agrees) advice.savingsFunding.schedule = { ...schedule, paydays: [], gap: null,
      paydayReason: 'The payday schedule does not reprint the Budget\'s period funding for this payday, so its detail is withheld.' };
  }
  return advice;
}

module.exports = budgetFundingTopUps;
