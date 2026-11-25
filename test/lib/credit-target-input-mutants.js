'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');

const cardFile = require.resolve('../../public/forecast-card-period');
const forecastFile = require.resolve('../../public/forecast');

// Give Forecast a private copy of the card authority for each mutation. All other modules load normally.
function compile(file, source, cardAuthority) {
  const m = new Module(file, module);
  m.filename = file;
  if (cardAuthority) {
    const load = m.require.bind(m);
    m.require = name => name === './forecast-card-period' ? cardAuthority : load(name);
  }
  m._compile(source, file);
  return m.exports;
}

module.exports = function verifyMutants(verifyCase) {
  const card = fs.readFileSync(cardFile, 'utf8');
  const forecast = fs.readFileSync(forecastFile, 'utf8');
  function restore(name, testCase, failure, from, to, source = card) {
    assert.equal(source.split(from).length, 2, 'exactly one restore site for ' + name);
    const edited = source.replace(from, to);
    const authority = compile(cardFile, source === card ? edited : card);
    const engine = compile(forecastFile, source === forecast ? edited : forecast, authority);
    assert.throws(() => verifyCase(testCase, engine),
      error => error instanceof assert.AssertionError && error.message.startsWith(testCase + ' ' + failure),
      'the ' + name + ' mutant must fail the ' + failure + ' assertion');
  }

  restore('absent limit reads as zero', 'unknown-limit', 'target',
    "return unknown('over-limit-unknown');\n      }", 'return zero;\n      }');
  restore('absent roster hides observed activity', 'absent-with-activity', 'target',
    'if (absent && balance.amount === null && !minimumIsDue(minimum) && !hasActivity)', 'if (absent)');
  restore('absent roster hides known payer debit', 'payer-only', 'target',
    ' || (Number.isFinite(payerAmount) && payerAmount !== 0)', '');
  restore('absent roster hides a card posting', 'card-only', 'target',
    'card.transactions.length > 0 || (Number.isFinite(payerAmount)', '(Number.isFinite(payerAmount)');
  restore('missing pending exposure reads as zero', 'unknown-pending', 'target',
    'if (by === null || cents(row.used)', 'if (by === null) return zero;\n      if (cents(row.used)');
  restore('posted overage earns calculated trust', 'pending-bound', 'target',
    'const unresolved = row.pendingUnknown === true;', 'const unresolved = false;');
  restore('absent balance reads as posted zero', 'missing-balance', 'target',
    " || (Object.hasOwn(row, 'posted') && cents(row.posted) === null)", '');
  restore('withhold the last observed positive overage', 'stale-balance', 'target',
    "unknown('over-limit-balance-estimated', by > 0 ? by : null)", "unknown('over-limit-balance-estimated')");
  restore('publish an old zero overage', 'stale-zero-overage', 'target',
    "unknown('over-limit-balance-estimated', by > 0 ? by : null)", "unknown('over-limit-balance-estimated', by)");
  restore('last observed positive overage resolves repayment progress', 'stale-balance', 'withholds repayment progress',
    "cents: lastObservedCents, trust: 'estimated', unresolved: true", "cents: lastObservedCents, trust: 'estimated', unresolved: lastObservedCents === null");
  restore('overage ignores snapshot freshness', 'stale-balance', 'target',
    "row.balanceTrust === 'estimated' || balance.trust === 'estimated'", "row.balanceTrust === 'estimated'");
  restore('overage ignores utilisation freshness', 'util-stale', 'target',
    "row.balanceTrust === 'estimated' || balance.trust === 'estimated'", "balance.trust === 'estimated'");
  restore('explicit balance estimate is lost', 'estimated-balance', 'target',
    "...(debt.balanceTrust === 'estimated' ? { trust: 'estimated' } : {}), ", '');
  restore('coverage compares a lower bound', 'unknown-pending', 'withholds repayment progress',
    'const targetCovered = shortOf', 'const targetCovered = targetCents === null || towardCents === null');
  restore('posted amount clears an unknown remainder', 'unknown-pending', 'withholds repayment progress',
    'const stillToPayBack = shortOf', 'const stillToPayBack = targetCents === null || towardCents === null');
  restore('zero lower bound closes the target to unassigned payments', 'zero-pending-bound', 'qualifies unassigned',
    'const targetOpen = target.overLimitUnresolved === true || ', 'const targetOpen = ');

  restore('unknown zero removes the waterfall row', 'zero-pending-bound', 'dropdown prints a dash',
    'stackCents(line.target.amount) > 0 || line.target.overLimitUnresolved',
    'stackCents(line.target.amount) > 0', forecast);
  restore('unknown manual zero leaves Surplus calculated', 'zero-pending-bound', 'waterfall deductions and Surplus',
    '!line.target.overLimitUnresolved && (!held.has(id) || (manual.has(id) && noneDue))',
    '((!line.target.overLimitUnresolved && !held.has(id)) || (manual.has(id) && noneDue))', forecast);
  restore('missing facility removes an open zero floor from Surplus', 'payer-only', 'waterfall deductions and Surplus',
    '!line.target.overLimitUnresolved && (!held.has(id) || (manual.has(id) && noneDue))',
    '(!held.has(id) || (!line.target.overLimitUnresolved && manual.has(id) && noneDue))', forecast);

  // Negative controls keep cautious handling from spreading to fully known amounts.
  restore('overage always zero', 'positive-pending-control', 'target',
    'cents: Math.max(0, by)', 'cents: 0');
  restore('known overage is estimated', 'known-control', 'target',
    "trust: unresolved ? 'estimated' : 'calculated'", "trust: 'estimated'");
  restore('a covered target stays unchecked', 'covered-control', 'reports repayment progress',
    'value: targetCents > 0 && towardCents >= targetCents', 'value: false');
  restore('known zero treated as missing', 'zero-control', 'target',
    'if (by === null || cents(row.used)', 'if (!by || cents(row.used)');
  restore('a proven absent facility is unresolved', 'unheld-control', 'target',
    '&& !hasActivity) return zero;', "&& !hasActivity) return unknown('over-limit-unknown');");
};
