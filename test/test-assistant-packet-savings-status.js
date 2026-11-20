'use strict';
/* The assistant packet's forecast.savingsStatus (lead, 2026-11-20): why
 * Savings is or is not published, so the live reason can be read privately.
 * Statuses and reason codes only, copied from Forecast's savingsFunding and the
 * current period's Stack Savings: no amount, date, name or account id. A
 * Forecast reason sentence with any digit is replaced by a code.
 * Invented data only. `node test/test-assistant-packet-savings-status.js` */
const assert = require('node:assert/strict');
const A = require('../scripts/assistant-packet');
const F = require('../public/forecast.js');
const Snap = require('../scripts/figures-snapshot.js');

let checks = 0;
const ok = (cond, label) => { assert.ok(cond, label); checks++; console.log('  PASS  ' + label); };
const INPUTS = Snap.loadInventedInputs();
const build = (data, periods, now) => A.buildPacket({ data, periods: periods || { periods: {} }, questionsMarkdown: '', env: {},
  now: now || data.meta.asOf + 'T19:00:00Z' });
const numbersIn = (v, out = []) => {
  if (typeof v === 'number') out.push(v);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) numbersIn(x, out);
  return out;
};
const WORD = /^[a-z][a-z-]*$/;

console.log('1. Every invented input: codes only, copied from Forecast');
let withheld = 0;
for (const inp of INPUTS) {
  const data = structuredClone(inp.doc.data);
  const packet = build(data, inp.doc.periods == null ? null : structuredClone(inp.doc.periods));
  const s = packet.forecast.savingsStatus;
  assert.ok(s && typeof s.status === 'string', inp.id + ': savingsStatus present');
  if (s.status !== 'ok') { withheld++; continue; }
  assert.deepEqual(numbersIn({ ...s, stackSavings: s.stackSavings && { ...s.stackSavings, goals: 'n' } }), [], inp.id + ': no number but the goal count');
  for (const part of ['funding', 'period', 'backing', 'goalAllocation', 'stock', 'reportedStock']) {
    const p = s[part];
    if (p === null) continue;
    assert.ok(p.status === null || WORD.test(p.status), inp.id + ' ' + part + ': status is a word');
    assert.ok(p.reason === null || !/\d/.test(p.reason), inp.id + ' ' + part + ': no digit in a reason');
  }
  assert.ok(!/savings-dont-touch|"accountId"|"amount"|"date"/.test(JSON.stringify(s)), inp.id + ': no account id, amount or date field');
}
ok(INPUTS.length > 10, `every invented input publishes savingsStatus with codes only (${INPUTS.length} inputs, ${withheld} whole-block withheld)`);
{
  const inp = INPUTS.find(x => x.id === 'savings-live-ready');
  const s = build(structuredClone(inp.doc.data), inp.doc.periods == null ? null : structuredClone(inp.doc.periods)).forecast.savingsStatus;
  ok(s.status === 'ok' && s.source === 'Forecast.savingsFunding' && s.reportedStock && s.reportedStock.status === 'ready'
    && s.reportedStock.freshness === 'current', 'a ready savings world: the reported stock reads ready and current');
  const gone = structuredClone(inp.doc.data);
  gone.plan.savingsPoolObservation.accounts.pop();
  const g = build(gone, inp.doc.periods == null ? null : structuredClone(inp.doc.periods)).forecast.savingsStatus;
  ok(g.status === 'ok' && g.funding.status === 'unavailable' && typeof g.funding.reason === 'string' && g.reportedStock.status === 'unavailable',
    'one savings balance missing: the packet names the withheld funding and stock, with Forecast\'s reason');
}

console.log('2. A reason holding a digit is replaced; odd words are dropped');
{
  const inp = INPUTS.find(x => x.id === 'savings-live-ready');
  const data = structuredClone(inp.doc.data);
  // The packet's own Forecast call, with its savings result altered (invented text).
  const real = F.recommend;
  F.recommend = (...args) => {
    const r = real(...args);
    r.savingsFunding = { ...r.savingsFunding, status: 'unavailable', reason: 'Needs 1,234.56 by 2026-12-01.',
      period: { status: 'Weird Word', reason: 'Plain words.' } };
    const cur = r.payPeriodViews.find(v => v.timelineRole === 'current');
    if (cur && cur.stackSummary && cur.stackSummary.savings) cur.stackSummary.savings.totals.reasons.push('Has 12 dollars', 'balance-current');
    return r;
  };
  let s;
  try { s = build(data, inp.doc.periods == null ? null : structuredClone(inp.doc.periods)).forecast.savingsStatus; } finally { F.recommend = real; }
  ok(s.funding.reason === 'reason-withheld-contains-digits', 'a reason with a figure or date is replaced by a code');
  ok(s.period.status === null && s.period.reason === 'Plain words.', 'a status that is not a plain word is dropped; a digit-free reason is kept');
  ok(!s.stackSavings || !s.stackSavings.reasons.includes('Has 12 dollars'), 'a Stack Savings reason that is not a code is dropped');
}

// A withheld forecast block withholds savingsStatus with the block's reason: test-settlement-evidence-publication-gating.

console.log(`\nAll ${checks} assistant-packet savings-status checks passed`);
