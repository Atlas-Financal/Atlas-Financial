'use strict';
// B92's known negative controls reach B20's snapshot CLI before any failed
// balance assertion: the MBNA +500 debt control (case B) and the Chequing A
// +1,000 cash control (case A). The writer rightly refuses each reading.
// Report that exact reconciliation rejection as a real failed assertion and
// let the suite finish (B92 requires every allowed suite to reach its own
// completion line). Any other error is rethrown unchanged, so it stays an
// execution failure and never manufactures an assertion.
const KNOWN_CONTROLS = Object.freeze([
  { id: 'mbna', label: 'MBNA', delta: 500, collection: 'debts',
    rows: data => (data.debts || []).filter(row => row.id === 'mbna'),
    balance: row => Number(row.balance) },
  { id: 'chequing-a', label: 'Chequing A', delta: 1000, collection: 'cash',
    rows: data => ((((data.plan || {}).startingCash || {}).breakdown) || []).filter(row => row && row.id === 'chequing-a'),
    balance: row => Number(row.value) },
]);

function knownReconciliationRejection(error, data, positions, map) {
  if (!error || error.status !== 1 || error.signal || error.code) return null;
  if (String(error.stdout || '') !== '') return null;
  const asOf = data && data.meta && data.meta.asOf;
  if (!asOf || !data.plan || !data.plan.opening || data.plan.opening.asOf !== asOf) return null;
  const stderr = String(error.stderr || '').replace(/\r\n/g, '\n');
  for (const control of KNOWN_CONTROLS) {
    const canonicalRows = control.rows(data);
    const mappings = ((map && map.mappings) || []).filter(row =>
      row.canonical && row.canonical.collection === control.collection && row.canonical.id === control.id);
    if (canonicalRows.length !== 1 || mappings.length !== 1) continue;
    const rows = (positions || []).filter(row => row.account_label === mappings[0].accountLabel && row.as_of === asOf);
    if (rows.length !== 1) continue;
    const canonical = control.balance(canonicalRows[0]), position = Number(rows[0].balance);
    if (!Number.isFinite(canonical) || !Number.isFinite(position) || canonical !== position + control.delta) continue;
    const expected = `${control.id}: canonical ${canonical} disagrees with positions.csv ${rows[0].balance} on ${asOf}`;
    if (stderr === expected || stderr === expected + '\n') return control;
  }
  return null;
}

// Kept for callers that ask about the MBNA control specifically.
function isKnownMbnaReconciliationRejection(error, data, positions, map) {
  const control = knownReconciliationRejection(error, data, positions, map);
  return !!control && control.id === 'mbna';
}

// Returns the command output, or null after reporting a known control's
// rejection as a failed assertion. Every other error is rethrown unchanged.
function snapshotFirstReading(execute, data, positions, map, assertReading) {
  try { return execute(); }
  catch (error) {
    const control = knownReconciliationRejection(error, data, positions, map);
    if (!control) throw error;
    assertReading(false, `current canonical ${control.label} reading agrees with same-date positions.csv`,
      `snapshot writer rejected the intentionally divergent +${control.delta} reading`);
    return null;
  }
}
module.exports = { KNOWN_CONTROLS, knownReconciliationRejection, isKnownMbnaReconciliationRejection, snapshotFirstReading };
