'use strict';
const assert = require('node:assert/strict');
const restoreLegacyBadFamily = require('./bad-full-load-legacy');

// Frozen engines predate this authorized addition. These probes have no
// actuals packet, so validate its concrete unavailable publication paths
// before comparing every incumbent field. Do not move a frozen baseline.
module.exports = function incumbentAdvice(value, asOf) {
  // Bills audit of 57cb421: prove the full-load BAD family, then restore it.
  value = restoreLegacyBadFamily(value);
  let publications = 0;
  let comparisons = 0;
  let etransferPublications = 0;
  // S1 supersession (authorized addition + authorized figure movement):
  // every period publication now carries Forecast's paydaySweep, and a
  // future Budget opening is the prior remainder minus the sweeps that
  // landed before it. Frozen engines predate both. Validate each sweep
  // concretely, restore the chain fields (opening, currentBalance,
  // leftover.currentBalance) by the cumulative sweep that precedes them —
  // the deepEqual against the frozen engine then verifies the restored
  // values exactly, so a wrong sweep still fails this comparison — and
  // exclude only the new field itself.
  const cents = v => Math.round(v * 100) / 100;
  const s1Chains = { '/payPeriodViews': { swept: 0 }, '/defaultView/calendarPeriods': { swept: 0 } };
  let s1Validated = 0;
  let s1NumericSweeps = 0;
  // PA-4 authorized addition (owner direction 2026-10-30; adopted packet
  // #787 6526949494): each period publication carries an opening-inclusive
  // planned close under its own name. Frozen engines predate it. Validate
  // each one concretely (identity reconciles to its published terms, trust
  // and reason are coherent, unknown is null) and exclude only these fields.
  let pa4Validated = 0;
  const PA4 = ['plannedPeriodClose', 'plannedPeriodCloseTrust', 'plannedPeriodCloseTerms', 'plannedPeriodCloseReason'];
  const visit = (row, path) => {
    if (Array.isArray(row)) return row.map((child, index) => visit(child, path + '/' + index));
    if (!row || typeof row !== 'object') return row;
    if (Object.hasOwn(row, 'plannedPeriodClose')) {
      assert(/^\/(payPeriodViews|defaultView\/calendarPeriods|pastPeriodViews)\/\d+$/.test(path),
        'plannedPeriodClose appears only on period publications: ' + path);
      const close = row.plannedPeriodClose, t = row.plannedPeriodCloseTerms;
      if (close === null) {
        assert.equal(row.plannedPeriodCloseTrust, 'unknown'); assert.equal(t, null);
        assert.equal(typeof row.plannedPeriodCloseReason, 'string');
      } else {
        assert(['calculated', 'estimated'].includes(row.plannedPeriodCloseTrust));
        const cc = v => Math.round(v * 100);
        assert.equal(cc(close), cc(t.opening) + cc(t.incomeAdded) - cc(t.periodBillLoad)
          - cc(t.budgetHold) - cc(t.annualSavingsNeed), 'planned close reconciles to its published terms');
        assert.equal(t.deficit, close < 0);
      }
      const rest = { ...row }; for (const key of PA4) delete rest[key];
      row = rest; pa4Validated++;
    }
    if (Object.hasOwn(row, 'paydaySweep')) {
      const chain = /^\/(payPeriodViews|defaultView\/calendarPeriods)\/\d+$/.exec(path);
      const past = /^\/pastPeriodViews\/\d+$/.exec(path);
      assert(chain || past, 'paydaySweep appears only on period publications: ' + path);
      const sweep = row.paydaySweep;
      assert(sweep === null || (typeof sweep === 'number' && Number.isFinite(sweep) && sweep >= 0
        && Math.abs(sweep * 100 - Math.round(sweep * 100)) < 1e-6),
        'S1 paydaySweep is null or a non-negative cent-exact amount');
      const { paydaySweep: _omitted, ...rest } = row;
      const copy = visit(rest, path);
      s1Validated++;
      if (past) {
        assert.equal(sweep, null, 'past periods never carry a payday sweep');
        return copy;
      }
      if (sweep !== null) {
        assert.equal(typeof copy.opening, 'number', 'a known sweep requires a known opening');
        s1NumericSweeps++;
      }
      const state = s1Chains['/' + chain[1]];
      if (typeof copy.opening === 'number') copy.opening = cents(copy.opening + state.swept);
      if (typeof copy.currentBalance === 'number') copy.currentBalance = cents(copy.currentBalance + state.swept);
      if (copy.leftover && typeof copy.leftover === 'object'
        && typeof copy.leftover.currentBalance === 'number') {
        copy.leftover.currentBalance = cents(copy.leftover.currentBalance + state.swept);
      }
      if (typeof sweep === 'number') state.swept = cents(state.swept + sweep);
      return copy;
    }
    const entries = [];
    for (const [key, child] of Object.entries(row)) {
      const childPath = path + '/' + key;
      assert.notEqual(key, 'paydaySweep', 'paydaySweep outside a period publication: ' + childPath);
      if (key === 'delta' && /\/budgetProgress\/household$/.test(path)) {
        assert.equal(row.actual.amount, null, 'these controls have no observed household spending');
        assert.deepEqual(child, { amount: null, trust: 'unavailable', completeness: 'unavailable',
          reason: 'Complete original plan and incurred spending are needed for the combined difference.',
          magnitude: null, direction: null }, 'validate only the new unavailable disclosure before excluding it from the frozen baseline');
        comparisons++; continue;
      }
      if (key === 'outgoingETransfers') {
        // Authorized addition (outgoing e-transfer review list): these
        // probes have no actuals packet, so the only honest publication is
        // the fail-closed unavailable one — no list, no count, never zero.
        assert.equal(childPath, '/currentPeriodAction/outgoingETransfers');
        assert(child && typeof child === 'object', 'the added publication is present');
        assert.equal(child.status, 'unavailable-missing',
          'absent actuals cannot publish an e-transfer list or all-clear');
        assert.equal(child.count, null); assert.equal(child.items, null);
        etransferPublications++;
        continue;
      }
      if (key !== 'billsAccountPeriodBalance') { entries.push([key, visit(child, childPath)]); continue; }
      assert.match(childPath, /^\/(?:defaultView|defaultView\/calendarPeriods\/\d+|payPeriodViews\/\d+)\/billsAccountPeriodBalance$/);
      assert(child && typeof child === 'object', 'the added publication is present');
      assert.equal(child.source, 'Forecast.billsAccountPeriodBalance');
      assert.equal(child.accountId, 'chequing-a'); assert.equal(child.scope, 'bills-only');
      assert.equal(child.currency, 'CAD'); assert.equal(child.asOf, asOf);
      assert.equal(child.status, 'unavailable', 'absent actuals cannot establish a closing estimate');
      assert.equal(child.trust, 'unknown'); assert.equal(child.amount, null);
      assert.equal(child.grantsSpendPermission, false);
      assert(child.issues.some(issue => issue.code === 'posted-window-incomplete'));
      assert.equal(typeof child.reason, 'string'); assert(child.reason.length > 0);
      publications++;
    }
    return Object.fromEntries(entries);
  };
  const copy = visit(value, '');
  assert.equal(publications, 3, 'validate the default, active calendar and current timeline publications');
  assert(comparisons > 0, 'new comparison paths were concretely checked; every existing field remains compared');
  assert.equal(etransferPublications, 1, 'validate the current-period outgoing e-transfer publication');
  assert(s1Validated > 0, 'S1 paydaySweep publications were concretely validated before exclusion');
  // PA-4a-2b C7 (Muse #812 6541361235 / 6541501158): a card-held control's
  // withheld close feeds no numeric carry, so it publishes no numeric sweep;
  // every card-clean control still publishes at least one.
  if (value.cardPurchaseCoverage && value.cardPurchaseCoverage.status === 'unavailable') {
    assert.equal(s1NumericSweeps, 0, 'a card-held control publishes no numeric S1 sweep');
  } else assert(s1NumericSweeps > 0, 'at least one future period publishes a numeric S1 sweep in these controls');
  assert(pa4Validated > 0, 'PA-4 planned closes were concretely validated before exclusion');
  return copy;
};
