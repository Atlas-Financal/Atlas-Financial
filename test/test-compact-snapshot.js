'use strict';
/* Focused proof for Forecast.compactSnapshot(). The correctness cases are
 * hand-computed from literal balances, annual-interest figures and HELOC
 * history points — not the function that now produces the answer.
 *
 * Until this move public/plan.js summed secured debt, divided annual interest
 * by 12, and took helocDelta >= 0 as "still growing", where no test could
 * reach it. B73 recorded the mutation: / 12 → / 6 left npm test green.
 */
const fs = require('fs');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const same = (a, b) => a === b;
const read = p => sourceText(fs.readFileSync(p, 'utf8'));
const money = n => (n < 0 ? '−$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-CA');

/* Independent fixture. Amex is unsecured, so it is in the interest total and
 * out of the secured total.
 *
 *   Mortgage  $100,000   annual interest $3,600   secured
 *   HELOC         $110   annual interest $2,400   secured  (current opening)
 *   Amex        $8,000   annual interest $1,200   unsecured
 *
 *   secured = 100,000 + 110 = 100,110
 *   annual  = 3,600 + 2,400 + 1,200 = 7,200
 *   monthly = 7,200 / 12 = 600
 *   HELOC   current − last monthly observation
 */
const FIX_DEBTS = [
  { id: 'mortgage', name: 'Mortgage', balance: 100000, annualInterest: 3600, secured: true },
  { id: 'heloc',    name: 'HELOC',    balance:  110,   annualInterest: 2400, secured: true },
  { id: 'amex',     name: 'Amex',     balance:   8000, annualInterest: 1200, secured: false },
];
const HAND_SECURED = 100000 + 110;
const HAND_ANNUAL = 3600 + 2400 + 1200;
const HAND_MONTHLY = HAND_ANNUAL / 12;
const GROW_DELTA = 110 - 100;
const FALL_DELTA = 100 - 110;

console.log('=== hand-computed compact snapshot ===');
ok(HAND_SECURED === 100110, 'secured is $100,000 + $110, Amex excluded');
ok(HAND_ANNUAL === 7200 && HAND_MONTHLY === 600,
  'monthly interest is $7,200 / 12 = $600, including the unsecured card');

const growing = F.compactSnapshot(FIX_DEBTS, [{ m: 'Jul', v: 100 }]);
ok(!!growing, 'a result is returned');
ok(growing && same(growing.secured, HAND_SECURED),
  'secured total is the two home facilities',
  growing ? String(growing.secured) : 'none');
ok(growing && same(growing.monthlyInterest, HAND_MONTHLY),
  'monthly interest is the annual total divided by twelve',
  growing ? String(growing.monthlyInterest) : 'none');
ok(growing && growing.heloc && same(growing.heloc.delta, GROW_DELTA)
  && growing.heloc.id === 'growing',
  'HELOC current 110 − July 100 = +10 and is still growing');

const fallingDebts = FIX_DEBTS.map(d =>
  d.id === 'heloc' ? Object.assign({}, d, { balance: 100 }) : d);
const falling = F.compactSnapshot(fallingDebts, [{ m: 'Jul', v: 110 }]);
ok(falling && falling.heloc && same(falling.heloc.delta, FALL_DELTA)
  && falling.heloc.id === 'falling',
  'HELOC current 100 − July 110 = −10 and is coming down');

console.log('\n=== equality / no-change boundary the tile can reach ===');
/* money() rounds the absolute delta to whole dollars. The old page used
 * `helocDelta >= 0` on the raw float, so a published $0 still read
 * "still growing". The verdict has to be the verdict of that printed
 * dollar, or the household reads growth beside $0. */
ok(money(0) === '$0', 'a zero delta prints $0');
const equalDebts = FIX_DEBTS.map(d =>
  d.id === 'heloc' ? Object.assign({}, d, { balance: 100 }) : d);
const equal = F.compactSnapshot(equalDebts, [{ m: 'Jul', v: 100 }]);
ok(equal && equal.heloc && same(equal.heloc.delta, 0) && equal.heloc.id === 'unchanged',
  'exact zero is unchanged — the old `>= 0` would have said still growing beside $0');

ok(money(0.4) === '$0', 'a $0.40 move prints $0');
const subUpDebts = FIX_DEBTS.map(d =>
  d.id === 'heloc' ? Object.assign({}, d, { balance: 100.4 }) : d);
const subDollarUp = F.compactSnapshot(subUpDebts, [{ v: 100 }]);
ok(subDollarUp && subDollarUp.heloc && subDollarUp.heloc.id === 'unchanged'
  && same(Math.round(Math.abs(subDollarUp.heloc.delta)), 0),
  'and is not growth');

ok(money(-0.4) === '−$0', 'a $0.40 fall prints $0');
const subDownDebts = FIX_DEBTS.map(d =>
  d.id === 'heloc' ? Object.assign({}, d, { balance: 99.6 }) : d);
const subDollarDown = F.compactSnapshot(subDownDebts, [{ v: 100 }]);
ok(subDollarDown && subDollarDown.heloc && subDollarDown.heloc.id === 'unchanged',
  'a sub-dollar fall that prints $0 is also unchanged, not coming down');

ok(money(0.5) === '$1', 'half a dollar prints $1');
const halfUpDebts = FIX_DEBTS.map(d =>
  d.id === 'heloc' ? Object.assign({}, d, { balance: 100.5 }) : d);
const halfUp = F.compactSnapshot(halfUpDebts, [{ v: 100 }]);
ok(halfUp && halfUp.heloc && halfUp.heloc.id === 'growing',
  'and is still growing');

ok(money(-0.5) === '−$1', 'half a dollar down prints $1');
const halfDownDebts = FIX_DEBTS.map(d =>
  d.id === 'heloc' ? Object.assign({}, d, { balance: 99.5 }) : d);
const halfDown = F.compactSnapshot(halfDownDebts, [{ v: 100 }]);
ok(halfDown && halfDown.heloc && halfDown.heloc.id === 'falling',
  'and is coming down');

const tooShort = F.compactSnapshot(FIX_DEBTS, []);
ok(tooShort && tooShort.heloc === null,
  'no prior monthly observation omits the HELOC tile');
const noHeloc = F.compactSnapshot(
  FIX_DEBTS.filter(d => d.id !== 'heloc'),
  [{ m: 'Jul', v: 100 }, { m: 'Aug', v: 110 }]
);
ok(noHeloc && noHeloc.heloc === null,
  'a stored history pair is not a current opening when no HELOC debt exists');

console.log('\n=== live plan: identity independent of the engine function ===');
/* Posted home balances and annual-interest figures from the debt rows.
 * Current HELOC vs last monthly observation, added here. Not a copy of
 * compactSnapshot's own subtract. */
const mortgage = data.debts.find(d => d.id === 'mortgage');
const helocRow = data.debts.find(d => d.id === 'heloc');
const LIVE_SECURED = Number(mortgage.balance) + Number(helocRow.balance);
const LIVE_ANNUAL = data.debts.reduce((s, d) => s + Number(d.annualInterest || 0), 0);
const LIVE_MONTHLY = LIVE_ANNUAL / 12;
const helocHist = data.helocHistory || [];
const LIVE_HELOC_DELTA = Number(helocRow.balance) - Number(helocHist[helocHist.length - 1].v);

const live = F.compactSnapshot(data.debts, data.helocHistory);
ok(live && same(live.secured, LIVE_SECURED),
  'live secured matches the two posted home balances',
  live ? String(live.secured) : 'none');
ok(live && same(live.monthlyInterest, LIVE_MONTHLY),
  'live monthly interest is the debt-row annual total / 12',
  live ? String(live.monthlyInterest) : 'none');
ok(live && live.heloc && same(live.heloc.delta, LIVE_HELOC_DELTA)
  && live.heloc.id === (Math.round(Math.abs(LIVE_HELOC_DELTA)) === 0
    ? 'unchanged'
    : (LIVE_HELOC_DELTA > 0 ? 'growing' : 'falling')),
  'live HELOC direction is current posted opening minus last monthly observation');

console.log('\n=== page is a renderer ===');
const page = read('public/plan.js');
const pageCode = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(/Forecast\.compactSnapshot\(d\.debts, d\.helocHistory\)/.test(page),
  'the Plan page reads the snapshot from Forecast.compactSnapshot');
ok(/HELOC_TREND/.test(page),
  'the page looks the HELOC sentence and sign up from a wording map');
ok(/still growing/.test(page) && /coming down/.test(page),
  'the published growing / falling sentences are unchanged');
ok(!/helocDelta\s*>=\s*0/.test(pageCode),
  'the page no longer decides the HELOC direction from helocDelta >= 0');
ok(!/annualInterest[\s\S]{0,80}\/\s*12/.test(pageCode)
  && !/\/\s*12[\s\S]{0,80}annualInterest/.test(pageCode),
  'the page no longer converts annual interest / 12');
const snapBlock = pageCode.slice(
  pageCode.indexOf('Forecast.compactSnapshot'),
  pageCode.indexOf('snapshot-tiles')
);
ok(!/\.reduce\(/.test(snapBlock) && !/filter\s*\(\s*x\s*=>\s*x\.secured/.test(snapBlock),
  'the snapshot block no longer sums secured debt');
ok(/const consumer = today\.consumer/.test(page),
  'consumer debt on the same strip is still the projected day-zero figure');

console.log('\n=== mutation: annual / 12 → / 6 now fails ===');
const FORECAST_SRC = read('public/forecast.js');
const FROM = '    return annual === null || annual === undefined ? null : annual / 12;';
const TO = '    return annual === null || annual === undefined ? null : annual / 6;';
ok(FORECAST_SRC.split(FROM).length - 1 === 1,
  'the / 12 conversion appears once in the engine, so the mutation is aimed');
const sandbox = { module: { exports: {} } };
try {
  vm.runInNewContext(FORECAST_SRC.replace(FROM, TO), sandbox, { filename: 'forecast-mutant.js' });
} catch (e) {
  ok(false, 'mutant engine loads', e.message);
}
const mutant = sandbox.module.exports;
const broken = mutant && mutant.compactSnapshot(
  FIX_DEBTS, [{ m: 'Jul', v: 100 }]
);
const MUTATED_MONTHLY = HAND_ANNUAL / 6;
ok(mutant && broken && same(broken.monthlyInterest, MUTATED_MONTHLY)
  && !same(broken.monthlyInterest, HAND_MONTHLY),
  'dividing by 6 doubles fixture monthly interest from $600 to $1,200',
  broken ? String(broken.monthlyInterest) : 'mutant missing');
ok(growing && same(growing.monthlyInterest, HAND_MONTHLY),
  'the real engine still answers the hand-computed twelfth on the same fixture');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
