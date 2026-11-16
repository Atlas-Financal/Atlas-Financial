'use strict';
/* Regenerate the computed rows of docs/positions.csv from canonical state.
 *
 *   node scripts/positions-summary.js          rewrite the file
 *   node scripts/positions-summary.js --check  exit 1 if it is stale
 *
 * AUTHORITY DECISION (2026-08-10): positions.csv is DERIVED REPORTING OUTPUT
 * for every computed row. data.json is canonical for balances, and this script
 * is the only thing allowed to write a SUMMARY / CREDIT / LIQUIDITY row.
 *
 * The alternative was to make positions.csv canonical and derive data.json
 * from it. That was rejected because data.json is what the engine reads and
 * the site publishes, so making it the derivative would put a hand-edited CSV
 * on the critical path of every published figure.
 *
 * The cost of the old arrangement was two hand-maintained balance sheets, and
 * they had already diverged: the silver was added to data.json on 10 August
 * and never reached the CSV, so "total visible assets" read $34,607.66 against
 * a true $43,454.66, and both net-worth lines were wrong by the same $8,847.
 *
 * The `Household` detail rows are NOT generated. They carry rate basis,
 * structure, confidence and capture notes that data.json does not hold, so
 * they remain a captured record — but test-invariants.js reconciles every one
 * of them against data.json, and a drift there fails the suite.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSV = path.join(ROOT, 'docs', 'positions.csv');
const DEFAULT_DATA = path.join(ROOT, 'data.json');
const DEFAULT_PERIODS = path.join(ROOT, 'public', 'periods.json');
const F = require(path.join(ROOT, 'public', 'forecast.js'));

const n2 = v => (Math.round(v * 100) / 100).toFixed(2);

/* ---------------------------------------------------------------- csv io */
function parse(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; continue; }
    if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
}
const cell = v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
const line = cols => cols.map(cell).join(',');

function loadPeriods(periodsPath) {
  const dest = periodsPath || DEFAULT_PERIODS;
  try { return JSON.parse(fs.readFileSync(dest, 'utf8')); } catch { return null; }
}

function regenerateComputedRows(data, csvText, opts) {
  opts = opts || {};
  const pub = F.publicationTotals(data);
  const assetRows = pub.assetRows;
  const assets = pub.assets;
  // An Unknown asset value makes the asset total Unknown. This file writes
  // numbers only, so it stops rather than writing a total with a hole in it.
  if (assets === null) {
    throw new Error(`positions-summary: ${pub.unknownAssetCount} asset value(s) unknown; refusing to write a partial asset total`);
  }
  // A missing or non-numeric balance or annual interest is Unknown, never
  // $0: a total over a set with one Unknown member is itself Unknown (null).
  const known = v => typeof v === 'number' && Number.isFinite(v);
  const sumOrNull = (list, key) => (list.every(x => x && known(x[key]))
    ? list.reduce((s, x) => s + x[key], 0) : null);
  const debtRows = data.debts || [];
  const isTD = x => x.institution === 'TD';
  const unsecuredRows = debtRows.filter(x => !x.secured);
  const securedRows = debtRows.filter(x => x.secured);
  const tdRows = debtRows.filter(isTD);
  const debts = sumOrNull(debtRows, 'balance');
  const cards = sumOrNull(unsecuredRows, 'balance');
  const secured = sumOrNull(securedRows, 'balance');
  const tdDebt = sumOrNull(tdRows, 'balance');
  const util = F.utilisation(data.debts, data.revolvingExtra, data.plan);
  // Null (Unknown) when a household chequing opening row has no evidence.
  const spendable = F.spendableHouseholdCash(data.plan);

  const rows = String(csvText).split(/\r?\n/);
  const homeRow = rows.find(r => parse(r)[2] === 'Home');
  const homeCols = homeRow ? parse(homeRow) : null;
  const homeValue = homeCols ? Number(homeCols[6]) : null;
  const homeAsOf = homeCols ? String(homeCols[19] || '') : '';
  const laterIsoDate = (a, b) => {
    if (!a) return b || '';
    if (!b) return a;
    return a >= b ? a : b;
  };
  const homeDerivedAsOf = laterIsoDate(data.meta.asOf, homeAsOf);

  const periods = opts.periods !== undefined ? opts.periods : loadPeriods(opts.periodsPath);
  const periodsAsOf = periods && (periods.source && periods.source.coverageThrough || periods.asOf) || '';
  const ownerTargetAsOf = ((data.plan && data.plan.budget && data.plan.budget.categories) || [])
    .reduce((latest, c) => {
      const m = String(c && c.targetSource || '').match(/owner-stated-(\d{4}-\d{2}-\d{2})/);
      return laterIsoDate(latest, m ? m[1] : '');
    }, '');
  const essentialsAsOf = laterIsoDate(laterIsoDate(data.meta.asOf, periodsAsOf), ownerTargetAsOf);
  // These planning rows disclose the latest input date. Evaluate owner
  // targets on that same date, keeping the financial opening/settlement
  // context separate so a newer policy does not rewrite historical evidence.
  const budget = periods ? F.budgetBreakdown(data.plan, periods,
    { paypalPerMonth: data.paypal ? data.paypal.perMonth : 0,
      asOf: data.meta.asOf, budgetTargetAsOf: essentialsAsOf }) : null;
  const essentialsMonthly = budget ? budget.requiredMonthly : null;

  const W = (type, label, side, ccy, value, extra) => {
    const c = new Array(21).fill('');
    c[0] = type; c[2] = label; c[4] = side; c[5] = ccy; c[6] = value;
    c[18] = extra.confidence || 'CALCULATED';
    c[19] = extra.asOf || data.meta.asOf;
    c[20] = extra.note || '';
    if (extra.annualInterest) c[17] = extra.annualInterest;
    if (extra.renewal) c[16] = extra.renewal;
    return c;
  };

  const financialNetWorth = debts == null ? null : assets - debts;
  const householdNetWorth = homeValue != null && debts != null ? assets + homeValue - debts : null;
  const immediateLiquidity = spendable == null || util.totalAvailable == null ? null : spendable + util.totalAvailable;

  const generated = new Map();
  const put = (label, cols) => generated.set(label, cols);

  put('Total visible assets', W('SUMMARY', 'Total visible assets', 'Asset', 'CAD', n2(assets), {
    note: `Derived from data.json assets by scripts/positions-summary.js. ${assetRows.length} lines: `
      + assetRows.filter(a => a.value).map(a => `${a.label.replace(/ —.*$/, '')} ${n2(a.value)}`).join(' + ')
      + '; excludes home vehicles pensions business' }));

  const unknownDebtNote = (list) => 'Unknown: a debt balance is missing for '
    + list.filter(x => !(x && known(x.balance))).map(x => (x && (x.label || x.id)) || 'a facility').join(', ')
    + ', so this total is unavailable until it is known. Not $0.';
  const unknownInterestNote = (list) => '; annual interest unknown for '
    + list.filter(x => !(x && known(x.annualInterest))).map(x => (x && (x.label || x.id)) || 'a facility').join(', ')
    + ', so no interest total is written (not $0)';
  // A debt row: value and interest when known; an empty UNKNOWN row when a
  // balance is missing, so a calculated row from an earlier run is replaced.
  const debtRow = (label, list, total, note) => {
    if (total == null) return W('SUMMARY', label, 'Liability', 'CAD', '', { confidence: 'UNKNOWN', note: unknownDebtNote(list) });
    const interest = sumOrNull(list, 'annualInterest');
    return W('SUMMARY', label, 'Liability', 'CAD', n2(total), {
      annualInterest: interest == null ? '' : n2(interest),
      note: note + (interest == null ? unknownInterestNote(list) : '') });
  };

  put('Total TD debt', debtRow('Total TD debt', tdRows, tdDebt, 'Derived, by institution. '
    + tdRows.map(x => `${x.label} ${n2(x.balance)}`).join(' + ')));

  put('Total known debt', debtRow('Total known debt', debtRows, debts,
    'Derived from data.json verified debt balances; Affirm final 32.53 cash obligation is scheduled '
      + 'in Forecast but excluded here because its contractual balance is not independently known; Flexiti closed; Amex closed'));

  put('Total credit-card debt', debtRow('Total credit-card debt', unsecuredRows, cards,
    `Derived. ${unsecuredRows.length} unsecured facilities; `
      + `secured debt is ${secured == null ? 'unknown' : n2(secured)} separately`));

  put('Financial-account net worth', financialNetWorth == null
    ? W('SUMMARY', 'Financial-account net worth', 'Net', 'CAD', '', { confidence: 'UNKNOWN', note: unknownDebtNote(debtRows) })
    : W('SUMMARY', 'Financial-account net worth', 'Net', 'CAD',
      n2(financialNetWorth), { note: `Derived: assets ${n2(assets)} less known debt ${n2(debts)}; NOT household net worth` }));

  const roomUnknownNote = 'Unknown: a card\'s pending charges are unknown, so its room is not published and '
    + 'the revolving total is unavailable until that pending is observed. Not $0.';
  if (util.totalAvailable == null) {
    put('Total revolving credit available', W('CREDIT', 'Total revolving credit available', 'Net', 'CAD', '',
      { confidence: 'UNKNOWN', note: roomUnknownNote }));
  } else put('Total revolving credit available', W('CREDIT', 'Total revolving credit available', 'Net', 'CAD',
    n2(util.totalAvailable), {
      note: 'Derived by Forecast.utilisation from the debt records plus the chequing overdraft. '
        + util.rows.map(r => `${r.label.replace(/ \(.*$/, '')} ${r.available == null ? 'unknown' : n2(r.available)}`).join(' + ')
        + `. Includes ${n2(util.totalPending)} of pending charges as credit already spent; `
        + `${util.overLimitCount} facilities are over their limit`
        + (util.rows.some(r => r.pendingUnknown) ? '; facilities with unknown pending contribute no published headroom' : '') }));

  if (homeValue != null) {
    const homeInputDates = `Financial-account opening ${data.meta.asOf}; home planning estimate ${homeAsOf || 'missing'}.`;
    // Each home-based row is Unknown when a debt balance it uses is missing.
    const unknownHomeRow = (label, ccy, list) => W('SUMMARY', label, 'Net', ccy, '', {
      confidence: 'UNKNOWN', asOf: homeDerivedAsOf, note: unknownDebtNote(list) });
    put('Household net worth', householdNetWorth == null ? unknownHomeRow('Household net worth', 'CAD', debtRows)
      : W('SUMMARY', 'Household net worth', 'Net', 'CAD', n2(householdNetWorth), {
        confidence: 'ESTIMATE',
        asOf: homeDerivedAsOf,
        note: `Derived: financial assets ${n2(assets)} plus the owner-estimated home planning value `
          + `${n2(homeValue)} less all debt ${n2(debts)}; not an appraisal or verified market valuation. `
          + homeInputDates }));
    if (secured == null) {
      put('Home equity', unknownHomeRow('Home equity', 'CAD', securedRows));
      put('Loan-to-value', unknownHomeRow('Loan-to-value', '', securedRows));
    } else {
      put('Home equity', W('SUMMARY', 'Home equity', 'Net', 'CAD', n2(homeValue - secured), {
        confidence: 'ESTIMATE',
        asOf: homeDerivedAsOf,
        note: `Derived: owner-estimated home ${n2(homeValue)} less secured debt ${n2(secured)}. `
          + homeInputDates }));
      const ltv = (secured / homeValue) * 100;
      put('Loan-to-value', Object.assign(W('SUMMARY', 'Loan-to-value', 'Net', '', (Math.round(ltv * 10) / 10).toFixed(1), {
        confidence: 'ESTIMATE', asOf: homeDerivedAsOf, renewal: '2027-05-01',
        note: `Derived: ${n2(secured)} secured against the owner-estimated home planning value ${n2(homeValue)}; under the 80% that matters at renewal. `
          + homeInputDates })));
    }
  }

  // Unknown spendable cash (a household chequing opening row with no numeric
  // evidence) makes immediate liquidity, and every row derived from it,
  // Unknown. Both rows are still generated, empty and tagged UNKNOWN, so a
  // calculated row from an earlier run is replaced rather than kept.
  const unknownCashNote = 'Unknown: a household chequing opening balance is unknown, so spendable household '
    + 'cash and this derived figure are unavailable until that balance is known. Not $0.';
  if (immediateLiquidity == null) {
    const note = spendable == null ? unknownCashNote : roomUnknownNote;
    put('Immediate liquidity total', W('LIQUIDITY', 'Immediate liquidity total', 'Net', 'CAD', '',
      { confidence: 'UNKNOWN', note }));
    put('Weeks of essentials covered', W('LIQUIDITY', 'Weeks of essentials covered', 'Net', '', '',
      { confidence: 'UNKNOWN', note }));
  } else put('Immediate liquidity total', W('LIQUIDITY', 'Immediate liquidity total', 'Net', 'CAD',
    n2(immediateLiquidity), {
      note: `Derived: SPENDABLE household cash ${n2(spendable)} plus revolving credit ${n2(util.totalAvailable)}. `
        + `Spendable means Chequing A and Chequing B only — designated Savings / EMERGENCY SAVING stays as reserve `
        + `evidence, not this spendable total. Amanda's pass-through account, the staging `
        + `account and the US holiday accounts are excluded, which is why this is far below the old figure that `
        + `summed all five TD accounts. Most of what is left is borrowed` }));

  if (essentialsMonthly != null) {
    const mixedBits = [];
    if (data.meta.asOf) mixedBits.push(`Financial-account opening ${data.meta.asOf}`);
    if (periodsAsOf) mixedBits.push(`historical actuals through ${periodsAsOf}`);
    if (ownerTargetAsOf) mixedBits.push(`owner budget target ${ownerTargetAsOf}`);
    const mixedInputs = mixedBits.length ? ` ${mixedBits.join('; ')}.` : '';
    put('Essential spending estimate', W('LIQUIDITY', 'Essential spending estimate', 'Net', 'CAD',
      n2(essentialsMonthly), {
        asOf: essentialsAsOf,
        note: 'Derived from plan.budget by Forecast.budgetBreakdown: essential categories plus the '
          + 'uncategorised remainder, with anything already dated on the calendar removed from its own '
          + 'category. Replaces the retired essentialsPerMonth scalar.'
          + mixedInputs }));
    if (immediateLiquidity != null) put('Weeks of essentials covered', W('LIQUIDITY', 'Weeks of essentials covered', 'Net', '',
      (Math.round((immediateLiquidity / (essentialsMonthly * 12 / 52)) * 10) / 10).toFixed(1), {
        asOf: essentialsAsOf,
        note: `Derived: immediate liquidity ${n2(immediateLiquidity)} over essentials of `
          + `${n2(essentialsMonthly * 12 / 52)} a week.`
          + mixedInputs }));
  }

  const SILVER = (data.assets || []).find(a => /silver/i.test(a.label));
  const out = [];
  let sawSilver = false;
  for (const raw of rows) {
    if (!raw.trim()) { out.push(raw); continue; }
    const c = parse(raw);
    if (/silver/i.test(c[2] || '')) sawSilver = true;
    const gen = generated.get(c[2]);
    if (gen && ['SUMMARY', 'CREDIT', 'LIQUIDITY'].includes(c[0])) { out.push(line(gen)); continue; }
    out.push(raw);
  }
  if (!sawSilver && SILVER) {
    const idx = out.findIndex(r => parse(r)[2] === 'RESP');
    const row = new Array(21).fill('');
    row[0] = 'Household'; row[1] = 'Physical'; row[2] = 'Silver bullion'; row[3] = 'Precious metal';
    row[4] = 'Asset'; row[5] = 'CAD'; row[6] = n2(SILVER.value); row[12] = 'Physical holding - no counterparty';
    row[18] = 'ESTIMATE'; row[19] = data.meta.asOf;
    row[20] = '100 oz owner-stated 10 August 2026 valued at the C$88.47/oz spot price that day; a market price '
      + 'not a quote and dealers buy under spot; any gain over cost is a taxable capital gain';
    out.splice(idx >= 0 ? idx : out.length - 1, 0, line(row));
  }

  return {
    text: out.join('\n'),
    generatedCount: generated.size,
    sawSilver,
    addedSilver: !sawSilver && !!SILVER,
  };
}

function runCli(argv) {
  const check = argv.includes('--check');
  const data = JSON.parse(fs.readFileSync(DEFAULT_DATA, 'utf8'));
  const currentRaw = fs.readFileSync(CSV, 'utf8');
  const result = regenerateComputedRows(data, currentRaw);
  const next = result.text;
  const current = currentRaw.replace(/\r\n?/g, '\n');
  if (check) {
    if (next !== current) {
      console.error('positions.csv is STALE — its computed rows do not match canonical state.\n' +
        'Regenerate with:  node scripts/positions-summary.js');
      const a = current.split('\n'), b = next.split('\n');
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) console.error(`  line ${i + 1}:\n    is:     ${(a[i] || '').slice(0, 150)}\n    should: ${(b[i] || '').slice(0, 150)}`);
      }
      process.exit(1);
    }
    console.log('positions.csv computed rows reconcile with canonical state.');
    return;
  }
  fs.writeFileSync(CSV, next);
  console.log(`positions.csv regenerated — ${result.generatedCount} computed rows${result.sawSilver ? '' : ' + silver row added'}.`);
}

if (require.main === module) {
  runCli(process.argv);
} else {
  module.exports = {
    parse,
    cell,
    line,
    regenerateComputedRows,
    runCli,
    DEFAULT_CSV: CSV,
    DEFAULT_DATA,
  };
}
