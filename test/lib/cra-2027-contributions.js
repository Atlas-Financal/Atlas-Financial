'use strict';
// Authorized change (agent/cra-2027-statutory-limits, lead dispatch
// 2026-11-16): Dale's 2027 estimated payroll uses CRA's published 2027
// contribution limits (CPP, CPP2, EI); income tax keeps the 2026 table.
//
// Frozen-engine parity suites compare today's engine with an older merged
// engine loaded from git. This applies exactly that change to the frozen
// engine's source text, taking each piece verbatim from today's
// public/forecast.js: the CRA_2027_CONTRIBUTIONS table, the
// payrollStatutoryForDate selector, the three T4127 tax functions'
// `taxParams` read, and the trajectory's `statutory2027` provenance label. Every other line of the frozen engine is untouched, so
// every other field is still compared. Each splice point must occur exactly
// once in both sources, or this throws (no silent pass on a moved engine).
const fs = require('node:fs');
const path = require('node:path');

const CURRENT = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'forecast.js'), 'utf8');

function once(text, needle, where) {
  const at = text.indexOf(needle);
  if (at < 0 || text.indexOf(needle, at + needle.length) >= 0) {
    throw new Error(`cra-2027-contributions: expected exactly one "${needle.slice(0, 60)}" in ${where}`);
  }
  return at;
}
function slice(text, startNeedle, endNeedle, where) {
  const start = once(text, startNeedle, where);
  const end = text.indexOf(endNeedle, start);
  if (end < 0) throw new Error(`cra-2027-contributions: no end marker after "${startNeedle}" in ${where}`);
  return text.slice(start, end);
}

const TABLE_START = '  // CRA 2027 contribution limits, published';
const BC_H1 = '  const BC_BRACKETS_2026_H1 = [';
const SELECTOR_START = '  function payrollStatutoryForDate(date) {';
const SELECTOR_END = '  function taxBracket(table, amount) {';
const TAX_HEADS = [
  'function t4127AnnualTax(A, statutory, cppExhausted, eiExhausted) {\n    const p = statutory.params;',
  'function t4127RegularTax(gross, pension, statutory) {\n    const p = statutory.params;',
  'function t4127BonusTax(regularGross, regularPension, bonusGross, statutory) {\n    const p = statutory.params;',
];

const NEW_LABEL = "statutory2027: regimeReady ? 'cra-2027-published-contributions;tax-cra-2026-last-published-planning-assumption' : null,";
once(CURRENT, NEW_LABEL, 'today\'s forecast.js');
const table = slice(CURRENT, TABLE_START, BC_H1, 'today\'s forecast.js');
const selector = slice(CURRENT, SELECTOR_START, SELECTOR_END, 'today\'s forecast.js');

function withCra2027Contributions(frozenSource) {
  let s = frozenSource;
  if (s.includes('CRA_2027_CONTRIBUTIONS')) return s;
  const bc = once(s, BC_H1, 'the frozen engine');
  s = s.slice(0, bc) + table + s.slice(bc);
  const oldSelector = slice(s, SELECTOR_START, SELECTOR_END, 'the frozen engine');
  s = s.replace(oldSelector, selector);
  const OLD_LABEL = "statutory2027: regimeReady ? 'cra-2026-last-published-planning-assumption' : null,";
  once(s, OLD_LABEL, 'the frozen engine');
  s = s.replace(OLD_LABEL, NEW_LABEL);
  for (const head of TAX_HEADS) {
    once(s, head, 'the frozen engine');
    s = s.replace(head, head.replace('statutory.params;', 'statutory.taxParams || statutory.params;'));
  }
  return s;
}

module.exports = { withCra2027Contributions };
