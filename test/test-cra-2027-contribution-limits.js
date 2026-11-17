'use strict';
// Dale's 2027 estimated payroll uses CRA's published 2027 contribution limits
// (CPP, CPP2, EI); 2026 is unchanged, income tax is unchanged in every year,
// and a year with no published table (2028) keeps exactly its previous
// behaviour. Lead verification from the CRA pages, 2026-11-16:
//   CPP 2027:  YMPE 76,700, basic exemption 3,500, rate 5.75%, max 4,209.00
//   CPP2 2027: YAMPE 87,400, rate 4%, max 428.00
//   EI 2027 (outside Quebec): MIE 70,800, rate 1.64%, max 1,161.12
// The maxima are recomputed here from the published parameters, not read
// from Forecast:
//   (76,700 - 3,500) x 5.75% = 4,209.00
//   (87,400 - 76,700) x 4%   =   428.00
//   70,800 x 1.64%           = 1,161.12
// Each cumulative cap is checked against the deposits Forecast publishes:
// the year's contributions sum exactly to the maximum, the cap is reached on
// one deposit, and every later deposit that year contributes nothing. The
// cheque on which a cap is reached is computed here at run time, never
// written into this file. Planning assumptions are invented.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast.js');

// Main at the time this change was built: the reference for every field this
// change must leave alone (gross, pension, tax; all of 2026 and 2028).
const BASE = '33b367c231377cae1b8814e1f742f958e35ec87b';
const prior = { module: { exports: {} }, console };
vm.runInNewContext(cp.execFileSync('git', ['show', BASE + ':public/forecast.js'],
  { encoding: 'utf8', cwd: path.join(__dirname, '..'), maxBuffer: 64 * 1024 * 1024 }), prior);
const OLD = prior.module.exports;

const plan = {
  income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: '2026-08-14',
    amount: 1000, confidence: 'estimated' }],
  payrollPlanningAssumptions: { salaryRaiseFactor: 1.03, bonusRate: 0.1, authorizedThroughYear: 2028,
    trust: 'estimated', provenance: 'invented' },
};
const cents = n => Math.round(Number(n) * 100);
const PUBLISHED = {
  2027: { cpp: cents((76700 - 3500) * 0.0575), cpp2: cents((87400 - 76700) * 0.04), ei: cents(70800 * 0.0164) },
};
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

check(PUBLISHED[2027].cpp === 420900 && PUBLISHED[2027].cpp2 === 42800 && PUBLISHED[2027].ei === 116112,
  'the 2027 maxima recompute to 4,209.00 / 428.00 / 1,161.12 from the published parameters');

const run = engine => engine.daleEstimatedPayrollDeposits(plan, '2026-01-01', '2028-12-31');
const now = run(F), then = run(OLD);
check(now.status === 'ready' && then.status === 'ready', 'the regime is ready on both engines');
const byYear = (r, y) => (r.allDeposits || r.deposits).filter(d => d.date.slice(0, 4) === String(y));

// 1. The 2027 cumulative caps, against the published maxima. (2026 is proved
// unchanged from main in section 2; its per-cheque cent rounding leaves EI a
// few cents under its maximum, a pre-existing behaviour this change keeps.)
for (const year of [2027]) {
  const rows = byYear(now, year);
  check(rows.length > 20, `${year}: a full year of deposits`);
  for (const field of ['cpp', 'cpp2', 'ei']) {
    let running = 0, reachedAt = -1;
    rows.forEach((d, i) => {
      running += cents(d[field]);
      if (reachedAt < 0 && running === PUBLISHED[year][field]) reachedAt = i;
    });
    check(running === PUBLISHED[year][field],
      `${year} ${field}: the year's contributions sum exactly to the published maximum (${running / 100} vs ${PUBLISHED[year][field] / 100})`);
    check(reachedAt >= 0 && rows.slice(reachedAt + 1).every(d => cents(d[field]) === 0),
      `${year} ${field}: once the maximum is reached, no later deposit that year contributes`);
    check(rows.every(d => cents(d[field]) >= 0), `${year} ${field}: no negative contribution`);
  }
}

// 2. Everything this change must leave alone.
const key = d => d.date + '|' + d.kind;
const oldByKey = new Map((then.allDeposits || then.deposits).map(d => [key(d), d]));
const nowAll = now.allDeposits || now.deposits;
check(nowAll.length === oldByKey.size, 'the same deposits are published');
for (const d of nowAll) {
  const o = oldByKey.get(key(d));
  check(o && cents(o.gross) === cents(d.gross) && cents(o.pension) === cents(d.pension) && cents(o.tax) === cents(d.tax),
    `${d.date} ${d.kind}: gross, pension and income tax are unchanged`);
  if (d.date.slice(0, 4) !== '2027') {
    check(['cpp', 'cpp2', 'ei', 'net'].every(f => cents(o[f]) === cents(d[f])),
      `${d.date} ${d.kind}: ${d.date.slice(0, 4)} contributions and net are unchanged`);
  }
  check(d.trust === 'estimated' && d.confidence === 'estimated', `${d.date}: still estimated`);
}
check(byYear(now, 2027).some(d => ['cpp', 'cpp2', 'ei'].some(f => cents(d[f]) !== cents(oldByKey.get(key(d))[f]))),
  'positive control: 2027 contributions do move from the 2026 planning assumption');
check(byYear(now, 2027).every(d => d.statutorySource === 'cra-2027-published-contributions;tax-cra-2026-last-published-planning-assumption'),
  '2027 deposits name the published 2027 contribution table and the 2026 tax planning assumption');
check(byYear(now, 2028).every(d => d.statutorySource === 'cra-2026-last-published-planning-assumption'),
  '2028 (no published table) keeps its previous source');

console.log(`  PASS  2027 payroll uses CRA's published 2027 contribution limits (${checks} checks)`);
