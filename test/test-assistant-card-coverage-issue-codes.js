'use strict';
/* When card coverage withholds the operating answer, the assistant packet names
 * the card-coverage issue codes beside the withheld reason, so a reader can see
 * which check is holding without reconstructing it (lead, 2026-11-18).
 *
 * Only the closed code vocabulary passes: `coverage-` plus lowercase words
 * joined by hyphens. No transaction ref, amount, date, account or note can
 * leak, even if an upstream issue carried one.
 *
 * Invented data only (test/fixtures/card-purchase-coverage-data.js).
 * `node test/test-assistant-card-coverage-issue-codes.js`
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Assistant = require('../scripts/assistant-packet');
const fixture = require('./fixtures/card-purchase-coverage-data');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  PASS  ${label}`); } catch (err) { failures++; console.log(`  FAIL  ${label} — ${err.message}`); }
};
const CODE = /^coverage-[a-z]+(?:-[a-z]+)*$/;
const packetOf = x => Assistant.buildPacket({ data: Live.fromObservation(x).data, periods: null, questionsMarkdown: '' });

// A foreign-currency card purchase leaves card coverage unknown.
const withheld = fixture();
withheld.payload.transactions[0].currency = 'usd';
const held = packetOf(withheld);

check('a withheld answer names the issue codes on spendable cash and the forecast block', () => {
  const spend = held.current.spendableHouseholdCash;
  assert.equal(spend.status, 'unavailable');
  assert.ok(Array.isArray(spend.cardCoverageIssues) && spend.cardCoverageIssues.length > 0, JSON.stringify(spend));
  assert.ok(spend.cardCoverageIssues.includes('coverage-currency-or-amount-unconfirmed'), spend.cardCoverageIssues.join(','));
  assert.equal(held.forecast.status, 'unavailable');
  assert.deepEqual(held.forecast.cardCoverageIssues, spend.cardCoverageIssues);
});

check('every published code is a closed code string, sorted and unique', () => {
  const codes = held.current.spendableHouseholdCash.cardCoverageIssues;
  assert.ok(codes.every(code => typeof code === 'string' && CODE.test(code)), codes.join(','));
  assert.deepEqual(codes, [...new Set(codes)].sort());
});

check('the codes match the issues Forecast itself reports', () => {
  const r = Live.fromObservation(withheld);
  const advice = F.recommend(r.data.plan, withheld.asOf, { debts: r.data.debts,
    currentPeriodActuals: r.data.liveOverlay.currentPeriodActuals });
  const expected = [...new Set(advice.cardPurchaseCoverage.issues.map(i => i.code))].sort();
  assert.deepEqual(held.current.spendableHouseholdCash.cardCoverageIssues, expected);
});

check('a planted ref, amount, date or note never reaches the packet', () => {
  const realRecommend = F.recommend;
  F.recommend = (...args) => {
    const out = realRecommend(...args);
    if (out && out.cardPurchaseCoverage && Array.isArray(out.cardPurchaseCoverage.issues)) {
      out.cardPurchaseCoverage.issues = out.cardPurchaseCoverage.issues.concat([
        { code: 'coverage-payment-destination-unconfirmed', ref: 'pc-0123456789abcdef01234567' },
        { code: 'pc-0123456789abcdef01234567' },
        { code: 'coverage-payment 100.00' },
        { code: 'coverage-2026-11-16' },
        { code: 'coverage-Travel-Visa' },
        { code: 'coverage-note: card payment' },
        { code: 'coverage-' + 'x'.repeat(120) },
        { code: 42 }, null,
      ]);
    }
    return out;
  };
  let packet;
  try { packet = packetOf(withheld); } finally { F.recommend = realRecommend; }
  for (const field of [packet.current.spendableHouseholdCash.cardCoverageIssues, packet.forecast.cardCoverageIssues]) {
    assert.ok(Array.isArray(field), 'codes still published');
    assert.ok(field.every(code => CODE.test(code) && code.length <= 80), field.join(','));
    const text = JSON.stringify(field);
    assert.ok(!/\d/.test(text), 'no digit (amount, date or ref) in ' + text);
    assert.ok(!/pc-|[A-Z ]|:/.test(text), 'no ref, capital, space or colon in ' + text);
    assert.ok(field.includes('coverage-payment-destination-unconfirmed'), 'the clean code survives');
  }
});

check('control: with card coverage confirmed there is no issue-code field', () => {
  const ready = packetOf(fixture('before'));
  assert.equal(ready.current.spendableHouseholdCash.cardCoverageIssues, undefined);
  assert.equal((ready.forecast || {}).cardCoverageIssues, undefined);
});

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll assistant card-coverage issue-code checks passed.');
