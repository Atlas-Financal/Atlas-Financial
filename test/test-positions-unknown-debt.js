'use strict';
// A missing debt balance or annual interest is Unknown in docs/positions.csv,
// never $0. Every amount here is invented. Expected values are worked by hand
// below, not taken from positions-summary.js.
//   node test/test-positions-unknown-debt.js
const S = require('../scripts/positions-summary');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const clone = (x) => JSON.parse(JSON.stringify(x));

const DEBTS = [
  { id: 'inv-mortgage', label: 'Invented mortgage', institution: 'TD', secured: true, balance: 1000, limit: null, annualInterest: 40 },
  { id: 'inv-card-a', label: 'Invented card A', institution: 'TD', secured: false, balance: 200, limit: 1000, pending: 0, annualInterest: 30 },
  { id: 'inv-card-b', label: 'Invented card B', institution: 'Other', secured: false, balance: 50, limit: 500, pending: 0, annualInterest: 10 },
];
const base = {
  meta: { asOf: '2026-08-19' }, accounts: [], assets: [{ label: 'Invented savings', value: 500 }],
  debts: DEBTS, revolvingExtra: [],
  plan: { opening: { asOf: '2026-08-19' }, defaults: {}, income: [], bills: [], obligations: [], commitments: [],
    startingCash: { breakdown: [{ id: 'chequing-a', value: 70 }, { id: 'chequing-b', value: 30 }] } },
};
const row = (type, label, value, date) => { const c = Array(21).fill(''); c[0] = type; c[2] = label; c[6] = String(value); c[19] = date; return S.line(c); };
const LABELS = ['Total TD debt', 'Total known debt', 'Total credit-card debt', 'Financial-account net worth',
  'Household net worth', 'Home equity', 'Loan-to-value'];
const csv = [row('Type', 'Label', 'Value', 'AsOf'), row('Household', 'Home', 2000, '2026-08-01'),
  ...LABELS.map((l) => row('SUMMARY', l, '999.99', '2026-08-01'))].join('\n');
const run = (data) => {
  const text = S.regenerateComputedRows(data, csv, { periods: null }).text;
  const rows = text.split('\n').map(S.parse);
  return (label) => rows.find((c) => c[2] === label);
};

console.log('=== control: every balance and interest known ===');
{
  const r = run(clone(base));
  // TD: 1000 + 200 = 1200, interest 40 + 30 = 70. All: 1250, interest 80.
  // Cards: 200 + 50 = 250, interest 40. Net: 500 - 1250 = -750.
  // Household: 500 + 2000 - 1250 = 1250. Equity: 2000 - 1000 = 1000. LTV 50.0.
  const want = { 'Total TD debt': ['1200.00', '70.00'], 'Total known debt': ['1250.00', '80.00'],
    'Total credit-card debt': ['250.00', '40.00'], 'Financial-account net worth': ['-750.00', ''],
    'Household net worth': ['1250.00', ''], 'Home equity': ['1000.00', ''], 'Loan-to-value': ['50.0', ''] };
  for (const [label, [value, interest]] of Object.entries(want)) {
    const c = r(label);
    ok(c && c[6] === value && c[17] === interest && c[18] !== 'UNKNOWN', `${label} = ${value}${interest ? `, interest ${interest}` : ''}`,
      c && `${c[6]} ${c[17]} ${c[18]}`);
  }
}

console.log('\n=== a missing card balance is Unknown, not $0 ===');
for (const missing of [undefined, null, '', 'n/a', NaN]) {
  const data = clone(base);
  data.debts[2].balance = missing;
  if (Number.isNaN(missing)) data.debts[2].balance = NaN;
  const r = run(data);
  for (const label of ['Total known debt', 'Total credit-card debt', 'Financial-account net worth', 'Household net worth']) {
    const c = r(label);
    ok(c && c[6] === '' && c[17] === '' && c[18] === 'UNKNOWN' && /Not \$0/.test(c[20]) && /Invented card B/.test(c[20]),
      `${label} withholds when card B balance is ${JSON.stringify(missing)}`, c && `${c[6]} ${c[18]}`);
  }
  // Rows that do not include card B stay known: TD 1200, equity 1000, LTV 50.0.
  ok(r('Total TD debt')[6] === '1200.00', 'Total TD debt (no card B) stays known');
  ok(r('Home equity')[6] === '1000.00' && r('Loan-to-value')[6] === '50.0', 'secured-only rows stay known');
}

console.log('\n=== a missing secured balance makes the home rows Unknown ===');
{
  const data = clone(base);
  delete data.debts[0].balance;
  const r = run(data);
  for (const label of ['Total TD debt', 'Total known debt', 'Financial-account net worth', 'Household net worth', 'Home equity', 'Loan-to-value']) {
    const c = r(label);
    ok(c && c[6] === '' && c[18] === 'UNKNOWN', `${label} withholds`, c && `${c[6]} ${c[18]}`);
  }
  const cards = r('Total credit-card debt');
  ok(cards[6] === '250.00' && /secured debt is unknown separately/.test(cards[20]),
    'Total credit-card debt stays 250.00 and names secured debt as unknown', `${cards[6]}`);
}

console.log('\n=== a missing annual interest leaves the interest total blank, not $0 ===');
for (const missing of [undefined, null, '12']) {
  const data = clone(base);
  data.debts[1].annualInterest = missing;
  const r = run(data);
  for (const label of ['Total TD debt', 'Total known debt', 'Total credit-card debt']) {
    const c = r(label);
    ok(c && c[6] !== '' && c[17] === '' && /annual interest unknown for Invented card A/.test(c[20]),
      `${label} keeps its balance but writes no interest total (card A interest ${JSON.stringify(missing)})`, c && `${c[6]} '${c[17]}'`);
  }
  ok(run(data)('Total TD debt')[6] === '1200.00', 'the balance total is unchanged');
}
{
  const data = clone(base);
  data.debts[1].annualInterest = 0;
  ok(run(data)('Total TD debt')[17] === '40.00', 'a recorded 0 interest is a known 0: TD interest 40.00');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
