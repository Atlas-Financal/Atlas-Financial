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

module.exports = function verifyMutants(verifyCase, loadRenderers) {
  const card = fs.readFileSync(cardFile, 'utf8');
  const forecast = fs.readFileSync(forecastFile, 'utf8');
  function edit(name, source, from, to) {
    assert.equal(source.split(from).length, 2, 'exactly one restore site for ' + name);
    return source.replace(from, to);
  }
  function fails(name, testCase, failure, check) {
    assert.throws(check,
      error => error instanceof assert.AssertionError && error.message.split('\n')[0] === testCase + ' ' + failure,
      'the ' + name + ' mutant must fail the ' + failure + ' assertion');
  }
  function restore(name, testCase, failure, from, to, source = card) {
    const edited = edit(name, source, from, to);
    const authority = compile(cardFile, source === card ? edited : card);
    const engine = compile(forecastFile, source === forecast ? edited : forecast, authority);
    fails(name, testCase, failure, () => verifyCase(testCase, engine));
  }
  function restoreRenderer(name, testCase, failure, renderer, from, to) {
    const source = fs.readFileSync(require.resolve('../../public/' + renderer), 'utf8');
    const ui = loadRenderers({ [renderer]: edit(name, source, from, to) });
    fails(name, testCase, failure, () => verifyCase(testCase, undefined, ui));
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
  restore('overage ignores utilisation freshness', 'util-stale', 'target (utilisation only)',
    "row.balanceTrust === 'estimated' || balance.trust === 'estimated'", "balance.trust === 'estimated'");
  restore('explicit balance estimate is lost', 'estimated-balance', 'target',
    "...(debt.balanceTrust === 'estimated' ? { trust: 'estimated' } : {}), ", '');
  restore('coverage compares a lower bound', 'unknown-pending', 'withholds repayment progress',
    'const targetCovered = shortOf', 'const targetCovered = targetCents === null || towardCents === null');
  restore('withhold all progress when exposure is unresolved', 'pending-minimum-partial', 'publishes minimum remaining',
    "if (targetIncomplete && card.id !== 'heloc')", "if (false && card.id !== 'heloc')");
  restore('published minimum remaining is a dash', 'pending-minimum-partial', 'publishes minimum remaining',
    'amount: minimumCents === null ? null : Math.max(', 'amount: true ? null : Math.max(');
  restore('posted amount is compared with the unresolved full target', 'pending-minimum-partial', 'publishes minimum remaining',
    'minimumCents - (towardCents ?? 0)', 'targetCents - (towardCents ?? 0)');
  restore('an unavailable minimum becomes an exact zero owed', 'unavailable-minimum', 'publishes minimum remaining',
    'amount: minimumCents === null ? null :', 'amount: minimumCents === null ? 0 :');
  restore('unobserved manual payment counts as a confirmed zero', 'manual-unobserved-minimum', 'qualifies unknown payment',
    "towardCents === null || progress.reasons.includes('paid-unavailable-counted-as-zero')", 'towardCents === null');
  restore('zero lower bound closes the target to unassigned payments', 'zero-pending-bound', 'qualifies unassigned',
    'const targetOpen = target.overLimitUnresolved === true || ', 'const targetOpen = ');

  restore('unknown zero removes the waterfall row', 'zero-pending-bound', 'dropdown shows minimum remaining publication',
    'stackCents(line.target.amount) > 0 || line.target.overLimitUnresolved',
    'stackCents(line.target.amount) > 0', forecast);
  restore('published waterfall row loses its minimum basis', 'pending-minimum-partial', 'dropdown shows minimum remaining publication',
    "...(still.basis === 'minimum' ? { basis: 'minimum' } : {}),", '', forecast);
  restore('published waterfall amount loses its upper bound', 'unavailable-payer-minimum', 'dropdown shows minimum remaining publication',
    '...(still.upperBound ? { upperBound: true } : {}),', '', forecast);
  restore('unknown manual zero leaves Surplus calculated', 'zero-pending-bound', 'waterfall deductions and Surplus',
    '!line.target.overLimitUnresolved && (!held.has(id) || (manual.has(id) && noneDue))',
    '((!line.target.overLimitUnresolved && !held.has(id)) || (manual.has(id) && noneDue))', forecast);
  restore('missing facility removes an open zero floor from Surplus', 'payer-only', 'waterfall deductions and Surplus',
    '!line.target.overLimitUnresolved && (!held.has(id) || (manual.has(id) && noneDue))',
    '(!held.has(id) || (!line.target.overLimitUnresolved && manual.has(id) && noneDue))', forecast);

  restoreRenderer('Credit row drops its minimum label', 'pending-minimum-partial', 'row labels its minimum', 'stack-credit',
    'r.minimumBasis ? `<small class="stack-credit-min">', 'false ? `<small class="stack-credit-min">');
  restoreRenderer('Credit row divides paid by the estimated target', 'stale-minimum-met', 'row labels its minimum', 'stack-credit',
    'minimumBasis ? line.target?.minimum : amountOf(line.target)', 'amountOf(line.target)');
  restoreRenderer('a missing minimum prints as zero', 'unavailable-minimum', 'row labels its minimum', 'stack-credit',
    'minimumBasis ? line.target?.minimum :', 'minimumBasis ? (line.target?.minimum ?? 0) :');
  restoreRenderer('meeting only the minimum turns the target green', 'stale-minimum-met', 'prints no green target', 'stack-credit',
    '!minimumBasis && out.x != null && covered', 'out.x != null && (covered || (minimumBasis && cv === true))');
  restoreRenderer('sheet hides minimum remaining', 'pending-minimum-partial', 'sheet shows minimum remaining', 'stack-credit',
    "r.minimumBasis ? rowHtml('Minimum still owed'", "false ? rowHtml('Minimum still owed'");
  restoreRenderer('sheet turns known minimum remaining into a dash', 'pending-minimum-partial', 'sheet shows minimum remaining', 'stack-credit',
    'minimumOwed == null ? dash', 'true ? dash');
  restoreRenderer('waterfall drops its minimum label', 'pending-minimum-partial', 'dropdown shows minimum remaining', 'stack-waterfall',
    'const label = minimumBasis ?', 'const label = false ?');
  restoreRenderer('waterfall replaces minimum remaining with a dash', 'pending-minimum-partial', 'dropdown shows minimum remaining', 'stack-waterfall',
    'cell(row && row.amount,', "cell(row?.basis === 'minimum' ? null : row && row.amount,");
  restoreRenderer('sheet prints an upper bound as an exact amount', 'unavailable-payer-minimum', 'sheet shows minimum remaining', 'stack-credit',
    "line.stillToPayBack?.upperBound === true ? 'Up to '", "false ? 'Up to '");
  restoreRenderer('waterfall prints an upper bound as an exact amount', 'unavailable-payer-minimum', 'dropdown shows minimum remaining', 'stack-waterfall',
    "minimumBasis && row.upperBound === true && isAmount(row.amount) ? 'Up to '", "false ? 'Up to '");

  // Negative controls keep cautious handling from spreading to fully known amounts.
  restore('resolved target switches to minimum progress', 'resolved-minimum-control', 'reports repayment progress',
    "if (targetIncomplete && card.id !== 'heloc')", "if (card.id !== 'heloc')");
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
