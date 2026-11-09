'use strict';
// Controlled response metadata and incumbent trust publications. All financial
// data comes from the invented Budget fixture; this proves presentation only.
const CHECKED_AT = '2038-06-06T18:00:00.000Z';
const headers = (qualified = true, source = 'provider', checkedAt = CHECKED_AT) => ({
  'X-Atlas-Observation-Source': source,
  'X-Atlas-Observation-Qualified': String(qualified),
  'X-Atlas-Observation-Checked-At': checkedAt,
});
const cases = [
  { name: 'current', headers: headers(), trust: { displayState: 'current', exactFiguresAvailable: true },
    includes: ['Provider checked:', 'Financial coverage: current.'] },
  { name: 'partial', headers: headers(), trust: { displayState: 'partially-current', exactFiguresAvailable: true },
    includes: ['Provider checked:', 'Financial coverage: partial.'] },
  { name: 'unavailable', headers: headers(), trust: { displayState: 'attention-needed', exactFiguresAvailable: false,
      remainingClaim: 'unavailable', coverageLimits: [] },
    includes: ['Provider checked:', 'Unavailable figures: remaining spending.'] },
  { name: 'card-coverage', headers: headers(), trust: { displayState: 'attention-needed', exactFiguresAvailable: false,
    remainingClaim: 'precise', coverageLimits: [{ id: 'card-purchase-coverage-unconfirmed' }] },
    includes: ['Provider checked:', 'Unavailable figures: cash reserved for card purchases.'] },
  { name: 'both-unavailable', headers: headers(), trust: { displayState: 'attention-needed', exactFiguresAvailable: false,
    remainingClaim: 'unavailable', coverageLimits: [{ id: 'card-purchase-coverage-unconfirmed' },
      { id: 'card-purchase-coverage-unconfirmed' }] },
    includes: ['Provider checked:', 'Unavailable figures: remaining spending; cash reserved for card purchases.'] },
  { name: 'unavailable-unspecified', headers: headers(), trust: { displayState: 'attention-needed', exactFiguresAvailable: false,
    remainingClaim: null, coverageLimits: [{ id: '<unrecognised>', text: 'Do not display this external prose' }] },
    includes: ['Provider checked:', 'Financial figures unavailable; details not provided.'] },
  { name: 'unqualified', headers: headers(false), trust: { displayState: 'partially-current', exactFiguresAvailable: true },
    includes: ['Provider observation received:', 'Source check not fully qualified.', 'Financial coverage: partial.'] },
  { name: 'metadata-absent', headers: {}, trust: { displayState: 'partially-current', exactFiguresAvailable: true },
    includes: ['Provider check details unavailable.', 'Financial coverage: partial.'] },
  { name: 'metadata-invalid', headers: headers(true, 'provider', 'invalid'), trust: {},
    includes: ['Provider check details unavailable.', 'Financial coverage details unavailable.'] },
  { name: 'warm', headers: headers(true, 'memory'), trust: { displayState: 'partially-current', exactFiguresAvailable: true },
    includes: ['Using last successful check:', 'Financial coverage: partial.'] },
];
function dataFor(testCase) {
  const data = require('./budget-surface-data').served();
  data.refreshTrust = { ...data.refreshTrust, ...testCase.trust };
  if (testCase.name === 'metadata-invalid') delete data.refreshTrust;
  return data;
}
module.exports = { CHECKED_AT, cases, dataFor };
