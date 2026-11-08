'use strict';
/* Non-writing reconciliation: observation → canonical compare.
 *
 *   node scripts/reconcile.js
 *
 * First B91 closed set: Household cash and debt rows in docs/positions.csv
 * that have a stable id locator in docs/reconciliation/balance-map.json.
 *
 * D3 settlement slice: commitment settlement observations in
 * docs/reconciliation/commitment-settlements.json compare a paid/settled
 * date against plan.commitments[].settledOn. They do not go through
 * positions.csv or the balance map.
 *
 * D4/D5 Hydro slice: utility observations in
 * docs/reconciliation/utility-observations.json compare an account
 * balance (informational, not a scheduled amount), dated dues against
 * plan.bills, and paying-account attribution. They do not go through
 * positions.csv. They do not write data.json.
 *
 * D2 Amanda slice: observations in
 * docs/reconciliation/amanda-income-observations.json distinguish
 * Tennis BC salary deposits, coaching/business inflows, business
 * obligations, household transfers, and household-available remainder.
 * They do not write data.json. Owner-confirmed 2026-08-22: the two
 * fixed Tennis BC salary deposits match canonical Forecast income.
 * Owner-clarified 2026-08-31: they first land in TENNIS INCOME; the
 * household-visible posting proof is the later BILLS transfer. A later
 * transfer of those same dollars is not a second income line. Coaching
 * is not promoted. The raw TENNIS INCOME balance is not spendable
 * coaching/business remainder.
 *
 * D8 card-state slice: observations in
 * docs/reconciliation/card-state-observations.json distinguish posted
 * balance, pending, limit, available credit, and confirmed payment.
 * They do not write data.json, do not treat limit or available credit
 * as household cash, and do not invent pending from
 * limit − posted − available unless that identity is proven for that
 * card and timestamp. Unknown pending is not $0.
 *
 * D7 posting slice: observations in
 * docs/reconciliation/posting-observations.json compare whether a
 * scheduled occurrence has posted against plan.opening.representedEvents.
 * Forecast remains authority for what should happen. Posting evidence
 * is authority for what has happened. Unknown posting is not posted
 * and is not unposted. They do not write data.json and are not a
 * lifecycle state machine.
 *
 * This command NEVER writes data.json. An owner-approved canonical edit
 * remains a separate explicit action. Evidence that a commitment was
 * paid does not mutate the commitment. Hydro observations do not
 * promote Aug. 14 amounts into live canonical state. Amanda salary
 * observations match the owner-confirmed canonical salary streams; they
 * do not invent coaching income, a standing salary transfer, or a
 * spendable mixed-account remainder. Card observations
 * are not a second financial authority. Posting evidence does not
 * write representedEvents.
 *
 * Statuses actually assigned here: MATCH / CHANGE / CONFLICT / MISSING.
 * STALE is not assigned. The owner 90-day rule applies only to unresolved
 * pending bill/payment transaction effects for current cash forecasting
 * inside scripts/provider-observe.js; it does not assign STALE here and
 * does not rewrite historical provider status. Observation time is distinct
 * from due, settlement, and scheduled dates. A date relation is reported
 * only where those timestamps are comparable.
 */

const fs = require('fs');
const path = require('path');
const Forecast = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DATA = path.join(ROOT, 'data.json');
const DEFAULT_CSV = path.join(ROOT, 'docs', 'positions.csv');
const DEFAULT_MAP = path.join(ROOT, 'docs', 'reconciliation', 'balance-map.json');
const DEFAULT_SETTLEMENTS = path.join(ROOT, 'docs', 'reconciliation', 'commitment-settlements.json');
const DEFAULT_UTILITY = path.join(ROOT, 'docs', 'reconciliation', 'utility-observations.json');
const DEFAULT_AMANDA = path.join(ROOT, 'docs', 'reconciliation', 'amanda-income-observations.json');
const DEFAULT_CARDS = path.join(ROOT, 'docs', 'reconciliation', 'card-state-observations.json');
const DEFAULT_POSTING = path.join(ROOT, 'docs', 'reconciliation', 'posting-observations.json');
const SETTLED_ON = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const UTILITY_FACTS = new Set(['account-balance', 'dated-due', 'paying-account']);
const AMANDA_FACTS = new Set([
  'employment-deposit',
  'coaching-receipt',
  'business-obligation',
  'internal-transfer',
  'household-transfer',
  'household-available',
]);
const AMANDA_OPERATING_ID = 'amanda-debt-payments';
const AMANDA_TRANSFER_ID = 'amandaTransfer';
const CARD_FACTS = new Set([
  'posted-balance',
  'pending',
  'limit',
  'available-credit',
  'confirmed-payment',
  'scheduled-payment',
]);
const CARD_IDS = new Set(['triangle', 'cashback', 'mbna', 'tdcc', 'travelvisa']);
const POSTING_FACTS = new Set(['posting']);
// Snapshot facts whose published freshness is owned by data.meta.asOf.
// Standing facts (rates, limits, due dates, renewal dates), dated-due,
// settlement, posting, Amanda, and paying-account facts are not: they
// have no canonical freshness date to substitute with the cash snapshot.
const META_ASOF_FRESHNESS_FACTS = new Set([
  'posted-balance',
  'pending',
  'available-credit',
]);

const EPSILON = 0.005;
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= EPSILON;
const n2 = v => (Math.round(Number(v) * 100) / 100).toFixed(2);
const STATUSES = ['MATCH', 'STALE', 'CHANGE', 'CONFLICT', 'MISSING'];

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; continue; }
    if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function cashRows(data) {
  const cash = (data.plan && data.plan.startingCash) || {};
  return (cash.breakdown || []).concat(cash.heldElsewhere || []);
}

function readCanonical(data, target) {
  const locator = target && target.collection && target.id
    ? `${target.collection}:${target.id}`
    : '(unspecified)';
  if (!target || !target.collection || !target.id) {
    return { found: false, value: null, locator };
  }
  if (target.collection === 'cash') {
    const row = cashRows(data).find(r => r.id === target.id);
    return row
      ? { found: true, value: Number(row.value), locator }
      : { found: false, value: null, locator };
  }
  if (target.collection === 'debts') {
    const row = (data.debts || []).find(r => r.id === target.id);
    return row
      ? { found: true, value: Number(row.balance), locator }
      : { found: false, value: null, locator };
  }
  if (target.collection === 'commitments') {
    const row = (((data.plan || {}).commitments) || []).find(r => r.id === target.id);
    if (!row) return { found: false, value: null, settledOn: null, locator };
    const settledOn = typeof row.settledOn === 'string' && SETTLED_ON.test(row.settledOn)
      ? row.settledOn : null;
    return { found: true, value: Number(row.amount), settledOn, locator };
  }
  if (target.collection === 'bills') {
    const row = (((data.plan || {}).bills) || []).find(r => r.id === target.id);
    if (!row) {
      return {
        found: false, value: null, date: null, payingAccount: null,
        householdObligation: null, locator,
      };
    }
    return {
      found: true,
      value: Number(row.amount),
      date: row.date || row.firstDue || null,
      payingAccount: row.payingAccount || null,
      householdObligation: row.householdObligation !== false,
      locator,
    };
  }
  if (target.collection === 'obligations') {
    const row = (((data.plan || {}).obligations) || []).find(r => r.id === target.id);
    return row
      ? { found: true, value: Number(row.amount), debtId: row.debtId || null, locator }
      : { found: false, value: null, debtId: null, locator };
  }
  if (target.collection === 'income') {
    const row = ((((data || {}).plan) || {}).income || []).find(r => r.id === target.id);
    if (!row) return { found: false, value: null, scenarioMonthly: null, locator };
    const expected = row.scenarioMonthly && row.scenarioMonthly.expected != null
      ? Number(row.scenarioMonthly.expected)
      : Number(row.amount);
    return {
      found: true,
      value: isFinite(expected) ? expected : null,
      scenarioMonthly: row.scenarioMonthly || null,
      locator,
    };
  }
  if (target.collection === 'representedEvents') {
    const opening = (((data || {}).plan) || {}).opening || null;
    const date = target.date || null;
    // Membership still requires the opening as-of and id/date class match.
    // representedOnOpening adds Forecast.representedEventEffectiveBy so a
    // later or invalid effectiveAsOf cannot preview as represented.
    const represented = representedOnOpening(data, target.id, date);
    return {
      found: !!(opening && opening.asOf),
      value: represented ? 1 : 0,
      represented,
      openingAsOf: opening && opening.asOf ? opening.asOf : null,
      locator,
    };
  }
  return { found: false, value: null, locator };
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}

function incomeStreams(data) {
  return ((((data || {}).plan) || {}).income) || [];
}

function isAmandaSalaryStream(stream) {
  if (!stream || stream.id === AMANDA_TRANSFER_ID) return false;
  const blob = `${stream.id || ''} ${stream.label || ''}`;
  return /tennis\s*bc|amandaSalary|amanda-salary|amandaEmployment|amanda-employment|amanda.?pay/i.test(blob);
}

function isCoachingIncomeStream(stream) {
  if (!stream || stream.id === AMANDA_TRANSFER_ID) return false;
  const blob = `${stream.id || ''} ${stream.label || ''}`;
  return /coach|business.?receipt|coaching/i.test(blob);
}

function amandaTransferStream(data) {
  return incomeStreams(data).find(s => s.id === AMANDA_TRANSFER_ID) || null;
}

function forecastHasAmandaDoubleCount(data) {
  const income = incomeStreams(data);
  return income.some(s => s.id === AMANDA_TRANSFER_ID) && income.some(isAmandaSalaryStream);
}

function classifyAmandaMovement(m) {
  const fact = (m && (m.kind || m.fact)) || null;
  const unknown = !m || m.unknown === true || m.amount == null || !isFinite(Number(m.amount));
  const amount = unknown ? 0 : Number(m.amount);
  const base = {
    fact,
    amandaOperatingIncome: 0,
    coachingInflow: 0,
    businessObligation: 0,
    householdCashInflow: 0,
    newIncome: 0,
  };
  if (fact === 'employment-deposit') {
    // Owner-confirmed: fixed Tennis BC salary is Forecast household income.
    // First landing is TENNIS INCOME; household-visible proof is the BILLS
    // transfer. It is not mixed-account operating income and not spendable
    // TENNIS INCOME cash.
    return Object.assign({}, base, { newIncome: amount, householdCashInflow: amount });
  }
  if (fact === 'coaching-receipt') {
    return Object.assign({}, base, { coachingInflow: amount });
  }
  if (fact === 'business-obligation') {
    return Object.assign({}, base, { businessObligation: amount });
  }
  if (fact === 'internal-transfer') return base;
  if (fact === 'household-transfer') {
    // Movement of already-counted salary, or of unforecast coaching surplus.
    // Neither is a second Forecast income line.
    return base;
  }
  return base;
}

function householdCashFromAmandaMovements(movements) {
  return round2((movements || []).reduce(
    (s, m) => s + classifyAmandaMovement(m).householdCashInflow, 0));
}

function finiteNumber(v) {
  return typeof v === 'number' && isFinite(v);
}

function amandaHouseholdAvailable(input) {
  if (!input || input.obligationsKnown !== true) {
    return {
      established: false,
      amount: null,
      reason: 'unknown-business-obligations',
    };
  }
  if (!finiteNumber(input.employment)
    || !finiteNumber(input.coaching)
    || !finiteNumber(input.obligations)) {
    return {
      established: false,
      amount: null,
      reason: 'incomplete-known-inputs',
    };
  }
  return {
    established: true,
    amount: round2(input.coaching - input.obligations),
    reason: null,
  };
}

function matchingAmandaSalaryStream(row, data) {
  const streams = incomeStreams(data).filter(isAmandaSalaryStream);
  const hint = row && row.cadenceHint;
  if (hint === 'semi-monthly-15th') {
    return streams.find(s => Number(s.day) === 15) || null;
  }
  if (hint === 'semi-monthly-month-end') {
    return streams.find(s => Number(s.day) === 31) || null;
  }
  if (row && row.evidenceValue != null && isFinite(Number(row.evidenceValue))) {
    return streams.find(s => near(Number(s.amount), Number(row.evidenceValue))) || null;
  }
  return null;
}

function amandaTransferAuthorityContext(data) {
  const transfer = amandaTransferStream(data);
  const salary = incomeStreams(data).filter(isAmandaSalaryStream);
  const doubleCount = forecastHasAmandaDoubleCount(data);
  const salaryTotal = salary.reduce((sum, s) => {
    const v = s.scenarioMonthly && s.scenarioMonthly.expected != null
      ? Number(s.scenarioMonthly.expected)
      : Number(s.amount);
    return sum + (finiteNumber(v) ? v : 0);
  }, 0);
  const transferExpected = transfer && transfer.scenarioMonthly && transfer.scenarioMonthly.expected != null
    ? Number(transfer.scenarioMonthly.expected)
    : (transfer && transfer.amount != null ? Number(transfer.amount) : null);
  const present = salary.length > 0;
  return {
    present,
    transferPresent: !!transfer,
    salaryPresent: salary.length > 0,
    doubleCount,
    locator: salary.length
      ? salary.map(s => `income:${s.id}`).join(',')
      : (transfer ? `income:${AMANDA_TRANSFER_ID}` : null),
    streams: salary.map(s => ({
      id: s.id,
      day: s.day == null ? null : Number(s.day),
      amount: finiteNumber(Number(s.amount)) ? Number(s.amount) : null,
    })),
    canonicalExpected: salary.length
      ? round2(salaryTotal)
      : (finiteNumber(transferExpected) ? transferExpected : null),
    independentlyVerifiedByPaydayEvidence: salary.length > 0 && !doubleCount && !transfer,
    note: doubleCount
      ? 'Salary plus amandaTransfer would double-count household income.'
      : (salary.length
        ? 'Owner-confirmed Tennis BC salary is Forecast household income. It first lands in TENNIS INCOME; household-visible posting proof is the later BILLS transfer. Later transfers of those dollars are not a second income line. Coaching surplus is not forecast. The retired amandaTransfer stream is not a second income line.'
        : 'Incumbent Forecast household-cash authority. The Aug. 14 session did not independently observe or verify its scenarioMonthly values.'),
  };
}

function spendableAmandaAccount(data, id) {
  const cash = (((data || {}).plan || {}).startingCash) || {};
  return (cash.breakdown || []).some(r => r.id === (id || AMANDA_OPERATING_ID)
    && r.class === 'spendable');
}

function heldElsewhereOperational(data, id) {
  const cash = (((data || {}).plan || {}).startingCash) || {};
  const row = (cash.heldElsewhere || []).find(r => r.id === (id || AMANDA_OPERATING_ID));
  return !!(row && row.class === 'operational');
}

function householdPositionRows(csvText) {
  const lines = String(csvText).replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    if (c[0] !== 'Household') continue;
    const label = c[2];
    const raw = c[6];
    if (raw === '' || raw == null) continue;
    const value = Number(raw);
    if (!isFinite(value)) continue;
    rows.push({
      accountLabel: label,
      evidenceValue: value,
      evidenceDate: c[19] || null,
    });
  }
  return rows;
}

function observationsFromPositions(positionRows, map) {
  const byLabel = new Map();
  for (const row of positionRows) {
    const list = byLabel.get(row.accountLabel) || [];
    list.push(row);
    byLabel.set(row.accountLabel, list);
  }
  const observations = [];
  for (const mapping of map.mappings || []) {
    const hits = byLabel.get(mapping.accountLabel) || [];
    if (!hits.length) {
      observations.push({
        observationId: mapping.observationId,
        accountLabel: mapping.accountLabel,
        evidenceValue: null,
        evidenceDate: null,
        canonical: mapping.canonical,
        sourceMissing: true,
      });
      continue;
    }
    for (const hit of hits) {
      observations.push({
        observationId: mapping.observationId,
        accountLabel: mapping.accountLabel,
        evidenceValue: hit.evidenceValue,
        evidenceDate: hit.evidenceDate,
        canonical: mapping.canonical,
      });
    }
  }
  return observations;
}

function validSettledOn(value) {
  return typeof value === 'string' && SETTLED_ON.test(value) ? value : null;
}

function observationsFromSettlements(doc) {
  return ((doc && doc.observations) || []).map(item => ({
    observationId: item.observationId,
    fact: 'settlement',
    accountLabel: item.label || item.commitmentId,
    commitmentId: item.commitmentId,
    settledOn: item.settledOn,
    evidenceValue: item.amount != null ? Number(item.amount) : null,
    observedAsOf: item.observedAsOf || null,
    evidenceDate: item.observedAsOf || null,
    canonical: item.canonical || { collection: 'commitments', id: item.commitmentId },
    source: item.source || null,
    note: item.note || null,
  }));
}

function compareSettlementGroup(rows, data) {
  const first = rows[0];
  const target = first.canonical || { collection: 'commitments', id: first.commitmentId };
  const canonical = readCanonical(data, target);
  const evidenceDates = [];
  for (const row of rows) {
    const d = validSettledOn(row.settledOn);
    if (d && !evidenceDates.some(x => x === d)) evidenceDates.push(d);
  }
  const evidenceAmounts = rows
    .filter(r => r.evidenceValue != null && isFinite(r.evidenceValue))
    .map(r => r.evidenceValue);
  const distinctAmounts = [];
  for (const v of evidenceAmounts) {
    if (!distinctAmounts.some(x => near(x, v))) distinctAmounts.push(v);
  }

  let status;
  if (!canonical.found) status = 'MISSING';
  else if (evidenceDates.length > 1 || distinctAmounts.length > 1) status = 'CONFLICT';
  else if (!evidenceDates.length) status = 'MISSING';
  else if (distinctAmounts.length === 1 && !near(distinctAmounts[0], canonical.value)) status = 'CONFLICT';
  else if (canonical.settledOn === evidenceDates[0]) status = 'MATCH';
  else status = 'CHANGE';

  return rows.map(row => ({
    observationId: row.observationId,
    fact: 'settlement',
    accountLabel: row.accountLabel,
    commitmentId: row.commitmentId || target.id,
    evidenceValue: row.evidenceValue,
    observedAsOf: row.observedAsOf || null,
    evidenceDate: row.evidenceDate,
    evidenceSettledOn: validSettledOn(row.settledOn),
    canonicalValue: canonical.found ? canonical.value : null,
    canonicalSettledOn: canonical.found ? canonical.settledOn : null,
    canonicalTarget: canonical.locator,
    difference: null,
    status,
    sourceMissing: !validSettledOn(row.settledOn),
    note: row.note || null,
  }));
}

function observationsFromUtility(doc) {
  return ((doc && doc.observations) || []).map(item => ({
    observationId: item.observationId,
    fact: item.fact,
    utility: item.utility || null,
    accountLabel: item.label || item.utility,
    evidenceValue: item.amount != null ? Number(item.amount) : null,
    observedAsOf: item.observedAsOf || null,
    evidenceDate: item.observedAsOf || null,
    dueDate: item.dueDate || null,
    payingAccount: item.payingAccount || null,
    payingAccountLabel: item.payingAccountLabel || null,
    jointCashPool: item.jointCashPool,
    billIds: item.billIds || null,
    forbiddenBillIds: item.forbiddenBillIds || null,
    canonical: item.canonical || null,
    source: item.source || null,
    note: item.note || null,
    role: item.role || null,
  }));
}

function scheduledBills(data) {
  return (((data || {}).plan || {}).bills) || [];
}

function compareAccountBalance(row, data) {
  const amount = row.evidenceValue;
  const forbidden = row.forbiddenBillIds || [];
  const scheduled = scheduledBills(data).filter(b =>
    forbidden.includes(b.id)
    && amount != null && isFinite(amount) && near(Number(b.amount), amount));
  const scheduledWrongly = scheduled.length > 0;
  return {
    observationId: row.observationId,
    fact: 'account-balance',
    role: 'informational',
    accountLabel: row.accountLabel,
    evidenceValue: amount,
    observedAsOf: row.observedAsOf || null,
    evidenceDate: row.evidenceDate,
    canonicalValue: null,
    canonicalTarget: '(informational — not a scheduled amount)',
    difference: null,
    status: scheduledWrongly ? 'CONFLICT' : 'MATCH',
    scheduled: scheduledWrongly,
    scheduledIds: scheduled.map(b => b.id),
    note: scheduledWrongly
      ? 'account balance must not be scheduled as a cash event'
      : 'informational / not scheduled amount',
  };
}

function compareDatedDueGroup(rows, data) {
  const first = rows[0];
  const target = first.canonical || { collection: 'bills', id: first.observationId };
  const canonical = readCanonical(data, target);
  const amounts = rows
    .filter(r => r.evidenceValue != null && isFinite(r.evidenceValue))
    .map(r => r.evidenceValue);
  const dates = [];
  for (const row of rows) {
    const d = row.dueDate || null;
    if (d && !dates.some(x => x === d)) dates.push(d);
  }
  const distinctAmounts = [];
  for (const v of amounts) {
    if (!distinctAmounts.some(x => near(x, v))) distinctAmounts.push(v);
  }

  let status;
  if (!canonical.found) status = 'MISSING';
  else if (distinctAmounts.length > 1 || dates.length > 1) status = 'CONFLICT';
  else if (!distinctAmounts.length || !dates.length) status = 'MISSING';
  else if (near(distinctAmounts[0], canonical.value) && dates[0] === canonical.date) {
    status = 'MATCH';
  } else status = 'CHANGE';

  return rows.map(row => ({
    observationId: row.observationId,
    fact: 'dated-due',
    accountLabel: row.accountLabel,
    evidenceValue: row.evidenceValue,
    observedAsOf: row.observedAsOf || null,
    evidenceDate: row.evidenceDate,
    dueDate: row.dueDate || null,
    canonicalValue: canonical.found ? canonical.value : null,
    canonicalDate: canonical.found ? canonical.date : null,
    canonicalTarget: canonical.locator,
    difference: canonical.found && row.evidenceValue != null
      ? Math.round((row.evidenceValue - canonical.value) * 100) / 100
      : null,
    status,
    householdObligation: canonical.found ? canonical.householdObligation : null,
    payingAccount: canonical.found ? canonical.payingAccount : null,
    note: row.note || (status === 'MISSING'
      ? 'canonical missing/change — dated household cash requirement'
      : null),
  }));
}

function comparePayingAccount(row, data) {
  const ids = row.billIds
    || (row.canonical && row.canonical.id ? [row.canonical.id] : []);
  const bills = scheduledBills(data).filter(b => ids.includes(b.id));
  const complete = ids.length > 0 && bills.length === ids.length;
  const payers = [];
  for (const b of bills) {
    const p = b.payingAccount || null;
    if (!payers.some(x => x === p)) payers.push(p);
  }
  let status;
  if (!bills.length) status = 'MISSING';
  else if (payers.length > 1) status = 'CONFLICT';
  else if (!complete) status = 'MISSING';
  else if (payers[0] === row.payingAccount) status = 'MATCH';
  else status = 'CHANGE';

  const householdObligation = bills.length
    ? bills.every(b => b.householdObligation !== false)
    : null;

  return {
    observationId: row.observationId,
    fact: 'paying-account',
    accountLabel: row.accountLabel,
    evidenceValue: null,
    observedAsOf: row.observedAsOf || null,
    evidenceDate: row.evidenceDate,
    payingAccount: row.payingAccount || null,
    payingAccountLabel: row.payingAccountLabel || null,
    jointCashPool: row.jointCashPool === false ? false : !!row.jointCashPool,
    canonicalPayingAccount: complete && payers.length === 1 ? payers[0] : null,
    canonicalValue: null,
    canonicalTarget: ids.length ? `bills:${ids.join(',')}` : '(unspecified)',
    difference: null,
    status,
    householdObligation,
    note: row.note
      || (row.jointCashPool === false
        ? 'Amanda / external-to-joint-pool'
        : null),
  };
}

function observationsFromAmanda(doc) {
  return ((doc && doc.observations) || []).map(item => ({
    observationId: item.observationId,
    fact: item.fact,
    accountLabel: item.label || item.fact,
    evidenceValue: item.amount != null ? Number(item.amount) : null,
    evidenceDate: item.observedAsOf || null,
    landingAccount: item.landingAccount || null,
    cadenceHint: item.cadenceHint || null,
    scenarioMonthly: item.scenarioMonthly || null,
    unknown: item.unknown === true,
    independentlyObserved: item.independentlyObserved === true,
    established: item.established === true,
    observedBalance: item.observedBalance != null ? Number(item.observedBalance) : null,
    canonical: item.canonical || null,
    source: item.source || null,
    note: item.note || null,
  }));
}

function compareEmploymentDeposit(row, data) {
  const transfer = amandaTransferStream(data);
  const salaryStreams = incomeStreams(data).filter(isAmandaSalaryStream);
  const doubleCount = forecastHasAmandaDoubleCount(data);
  const match = matchingAmandaSalaryStream(row, data);
  const canonicalValue = match
    ? (match.scenarioMonthly && match.scenarioMonthly.expected != null
      ? Number(match.scenarioMonthly.expected)
      : Number(match.amount))
    : null;
  const evidence = row.evidenceValue != null && isFinite(Number(row.evidenceValue))
    ? Number(row.evidenceValue) : null;
  let status;
  if (doubleCount) status = 'CONFLICT';
  else if (match && evidence != null && finiteNumber(canonicalValue) && near(evidence, canonicalValue)) {
    status = 'MATCH';
  } else if (match && evidence != null && finiteNumber(canonicalValue)) {
    status = 'CHANGE';
  } else if (match) status = 'MISSING';
  else status = 'MISSING';
  return {
    observationId: row.observationId,
    fact: 'employment-deposit',
    accountLabel: row.accountLabel,
    evidenceValue: evidence,
    evidenceDate: row.evidenceDate,
    landingAccount: row.landingAccount || null,
    canonicalValue: finiteNumber(canonicalValue) ? canonicalValue : null,
    canonicalTarget: match
      ? `income:${match.id}`
      : (salaryStreams.length
        ? `income:${salaryStreams.map(s => s.id).join(',')}`
        : '(no canonical salary fact)'),
    difference: match && evidence != null && finiteNumber(canonicalValue)
      ? round2(evidence - canonicalValue)
      : null,
    status,
    representation: salaryStreams.length
      ? 'forecast-salary-stream'
      : 'observed-not-promoted',
    intentionallyNotPromoted: salaryStreams.length === 0,
    doubleCount,
    householdTransferAuthority: transfer ? `income:${AMANDA_TRANSFER_ID}` : null,
    note: row.note || (doubleCount
      ? 'salary stream plus amandaTransfer would double-count household income'
      : (match && status === 'MATCH'
        ? 'observed Tennis BC salary matches the owner-confirmed canonical Forecast stream'
        : (salaryStreams.length
          ? 'Tennis BC salary observation does not match a canonical salary stream'
          : 'observed Tennis BC salary; no canonical salary fact'))),
  };
}

function compareHouseholdTransfer(row, data) {
  const target = row.canonical || { collection: 'income', id: AMANDA_TRANSFER_ID };
  const canonical = readCanonical(data, target);
  const doubleCount = forecastHasAmandaDoubleCount(data);
  const independent = row.independentlyObserved === true;
  const observed = independent ? (row.scenarioMonthly || null) : null;
  const observedAmount = independent && row.evidenceValue != null && isFinite(row.evidenceValue)
    ? Number(row.evidenceValue) : null;
  let status;
  if (doubleCount) status = 'CONFLICT';
  else if (!canonical.found) status = 'MISSING';
  else if (!independent) {
    status = 'MATCH';
  } else if (observed && canonical.scenarioMonthly) {
    const keys = ['conservative', 'expected', 'optimistic'];
    const same = keys.every(k => near(observed[k], canonical.scenarioMonthly[k]));
    status = same ? 'MATCH' : 'CHANGE';
  } else if (observedAmount != null && canonical.value != null) {
    status = near(observedAmount, canonical.value) ? 'MATCH' : 'CHANGE';
  } else status = 'MISSING';

  return {
    observationId: row.observationId,
    fact: 'household-transfer',
    accountLabel: row.accountLabel,
    evidenceValue: independent
      ? (observed && observed.expected != null ? Number(observed.expected) : observedAmount)
      : null,
    evidenceDate: row.evidenceDate,
    landingAccount: row.landingAccount || null,
    canonicalValue: canonical.found ? canonical.value : null,
    canonicalTarget: canonical.locator,
    difference: independent && canonical.found && observed && observed.expected != null
      ? round2(Number(observed.expected) - canonical.value)
      : null,
    status,
    doubleCount,
    independentlyObserved: independent,
    scenarioMonthly: independent && canonical.found ? canonical.scenarioMonthly : null,
    note: row.note || (doubleCount
      ? 'amandaTransfer plus a salary stream would double-count household income'
      : (independent
        ? 'household transfer is movement of existing money, not a second salary line'
        : 'incumbent Forecast household-cash authority; not independently observed by this evidence record')),
  };
}

function compareCoachingReceipt(row, data) {
  const coachingStreams = incomeStreams(data).filter(isCoachingIncomeStream);
  const unknown = row.unknown === true || row.evidenceValue == null;
  let status;
  if (coachingStreams.length) status = 'CONFLICT';
  else if (unknown) status = 'MISSING';
  else status = 'MATCH';
  return {
    observationId: row.observationId,
    fact: 'coaching-receipt',
    accountLabel: row.accountLabel,
    evidenceValue: unknown ? null : row.evidenceValue,
    evidenceDate: row.evidenceDate,
    canonicalValue: null,
    canonicalTarget: '(not household Forecast income)',
    difference: null,
    status,
    unknown,
    representation: 'business-inflow',
    note: coachingStreams.length
      ? 'coaching/business receipt must not be a Forecast household-income stream'
      : (row.note || 'coaching/business receipt is not automatically household income'),
  };
}

function compareBusinessObligation(row, data) {
  const unknown = row.unknown === true || row.evidenceValue == null;
  const accountId = row.landingAccount || AMANDA_OPERATING_ID;
  const spendable = spendableAmandaAccount(data, accountId);
  const operational = heldElsewhereOperational(data, accountId);
  let status;
  if (spendable) status = 'CONFLICT';
  else if (unknown) status = 'MISSING';
  else status = 'MATCH';
  return {
    observationId: row.observationId,
    fact: 'business-obligation',
    accountLabel: row.accountLabel,
    evidenceValue: unknown ? null : row.evidenceValue,
    evidenceDate: row.evidenceDate,
    canonicalValue: null,
    canonicalTarget: operational ? `cash:${accountId}` : '(Amanda operating account)',
    difference: null,
    status,
    unknown,
    obligationsKnown: !unknown,
    remainderEstablished: false,
    note: unknown
      ? (row.note || 'unknown business obligations fail closed — remainder unresolved')
      : (row.note || 'known obligation reduces household-available remainder'),
  };
}

function compareInternalTransfer(row, data) {
  const labelled = incomeStreams(data).filter(s =>
    /internal.?transfer|amanda.?to.?amanda/i.test(`${s.id || ''} ${s.label || ''}`));
  const status = labelled.length ? 'CONFLICT' : 'MATCH';
  return {
    observationId: row.observationId,
    fact: 'internal-transfer',
    accountLabel: row.accountLabel,
    evidenceValue: row.evidenceValue,
    evidenceDate: row.evidenceDate,
    canonicalValue: 0,
    canonicalTarget: '(internal movement — $0 new income)',
    difference: null,
    status,
    householdCashInflow: 0,
    newIncome: 0,
    note: labelled.length
      ? 'internal Amanda transfer must not become Forecast income'
      : (row.note || 'internal transfer between Amanda-controlled accounts creates $0 new income'),
  };
}

function compareHouseholdAvailable(row, data) {
  const accountId = row.landingAccount || AMANDA_OPERATING_ID;
  const spendable = spendableAmandaAccount(data, accountId);
  const established = row.established === true
    && row.evidenceValue != null && isFinite(row.evidenceValue);
  const observedBalance = row.observedBalance != null && isFinite(Number(row.observedBalance))
    ? Number(row.observedBalance) : null;
  const canonical = readCanonical(data, { collection: 'cash', id: accountId });
  const canonicalValue = canonical.found ? canonical.value : null;
  const difference = canonical.found && observedBalance != null
    ? round2(observedBalance - canonical.value)
    : null;
  let status;
  if (spendable) status = 'CONFLICT';
  else if (observedBalance == null || !canonical.found) status = 'MISSING';
  else if (near(observedBalance, canonical.value)) status = 'MATCH';
  else status = 'CHANGE';
  return {
    observationId: row.observationId,
    fact: 'household-available',
    accountLabel: row.accountLabel,
    evidenceValue: established ? row.evidenceValue : null,
    evidenceDate: row.evidenceDate,
    observedBalance,
    canonicalValue,
    canonicalTarget: canonical.locator,
    difference,
    status,
    remainderEstablished: established,
    note: spendable
      ? 'DEBT&PAYMENTS must not be treated as spendable household cash'
      : (row.note || (established
        ? 'household-available remainder established from known obligations'
        : 'household-available remainder is unresolved; fail closed')),
  };
}

function householdCashFromCardCapacity() {
  return 0;
}

function readDebtCard(data, id) {
  const locator = `debts:${id || '(unspecified)'}`;
  const row = (data.debts || []).find(r => r.id === id);
  if (!row) {
    return {
      found: false, posted: null, pending: null, pendingPresent: false,
      limit: null, locator,
    };
  }
  const pendingPresent = row.pending != null && row.pending !== '' && isFinite(Number(row.pending));
  return {
    found: true,
    posted: Number(row.balance),
    pending: pendingPresent ? Number(row.pending) : null,
    pendingPresent,
    limit: row.limit == null || row.limit === '' ? null : Number(row.limit),
    locator,
  };
}

function derivePendingFromIdentity(input) {
  const posted = input && input.posted;
  const limit = input && input.limit;
  const available = input && input.available;
  if (input && input.identityProven !== true) {
    return { derived: false, pending: null, reason: 'identity-not-proven' };
  }
  if (!finiteNumber(posted) || !finiteNumber(limit) || !finiteNumber(available)) {
    return { derived: false, pending: null, reason: 'incomplete-identity-inputs' };
  }
  return {
    derived: true,
    pending: round2(Number(limit) - Number(posted) - Number(available)),
    reason: null,
  };
}

function cardExposure(state) {
  const pendingUnknown = !!(state && (state.pendingUnknown === true || state.unknownPending === true));
  const pendingConflict = !!(state && state.pendingConflict === true);
  if (state && state.postedConflict === true) {
    return { amount: null, unknown: true, reason: 'conflicted-posted' };
  }
  if (pendingConflict) {
    return { amount: null, unknown: true, reason: 'conflicted-pending' };
  }
  if (pendingUnknown) {
    return { amount: null, unknown: true, reason: 'unknown-pending' };
  }
  if (!state || !finiteNumber(state.posted)) {
    return { amount: null, unknown: true, reason: 'missing-posted' };
  }
  const includesPending = state.balanceIncludesPending === true;
  if (!includesPending && !finiteNumber(state.pending)) {
    return { amount: null, unknown: true, reason: 'missing-pending' };
  }
  const pending = includesPending ? 0 : Number(state.pending);
  let exposure = round2(Number(state.posted) + pending);
  const seen = new Set();
  for (const payment of state.payments || []) {
    if (!payment || payment.confirmed !== true) continue;
    if (payment.posted !== true) continue;
    if (payment.appliedToPosted === true) continue;
    const id = payment.paymentId || null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    if (!finiteNumber(payment.amount)) continue;
    exposure = round2(exposure - Number(payment.amount));
  }
  return { amount: exposure, unknown: false, reason: null };
}

function observationsFromCards(doc) {
  return ((doc && doc.observations) || []).map(item => ({
    observationId: item.observationId,
    fact: item.fact,
    cardId: item.cardId || (item.canonical && item.canonical.id) || null,
    accountLabel: item.label || item.cardId,
    evidenceValue: item.amount != null ? Number(item.amount) : null,
    observedAsOf: item.observedAsOf || null,
    evidenceDate: item.observedAsOf || null,
    unknown: item.unknown === true,
    identityProven: item.identityProven === true,
    balanceIncludesPending: item.balanceIncludesPending === true,
    paymentId: item.paymentId || null,
    posted: item.posted === true,
    appliedToPosted: item.appliedToPosted === true,
    obligationId: item.obligationId || null,
    canonical: item.canonical || null,
    source: item.source || null,
    note: item.note || null,
  }));
}

function distinctFinite(values) {
  const distinct = [];
  for (const v of values) {
    if (!distinct.some(x => near(x, v))) distinct.push(v);
  }
  return distinct;
}

function comparePostedBalanceGroup(rows, data) {
  const first = rows[0];
  const cardId = first.cardId;
  const debt = readDebtCard(data, cardId);
  const amounts = rows
    .filter(r => r.unknown !== true && r.evidenceValue != null && isFinite(r.evidenceValue))
    .map(r => r.evidenceValue);
  const distinct = distinctFinite(amounts);
  let status;
  if (!debt.found) status = 'MISSING';
  else if (distinct.length > 1) status = 'CONFLICT';
  else if (!amounts.length) status = 'MISSING';
  else if (near(distinct[0], debt.posted)) status = 'MATCH';
  else status = 'CHANGE';
  return rows.map(row => ({
    observationId: row.observationId,
    fact: 'posted-balance',
    cardId,
    accountLabel: row.accountLabel,
    evidenceValue: row.unknown ? null : row.evidenceValue,
    observedAsOf: row.observedAsOf || null,
    evidenceDate: row.evidenceDate,
    canonicalValue: debt.found ? debt.posted : null,
    canonicalTarget: debt.locator,
    difference: debt.found && row.evidenceValue != null && isFinite(row.evidenceValue)
      ? round2(row.evidenceValue - debt.posted)
      : null,
    status,
    balanceIncludesPending: row.balanceIncludesPending === true,
    householdCash: 0,
    note: row.note || (status === 'CONFLICT'
      ? 'same-time posted facts disagree — not guessed'
      : 'posted balance is not pending, limit, or available credit'),
  }));
}

function comparePendingGroup(rows, data) {
  const first = rows[0];
  const cardId = first.cardId;
  const debt = readDebtCard(data, cardId);
  const unknownRows = rows.filter(r => r.unknown === true || r.evidenceValue == null || !isFinite(r.evidenceValue));
  const known = rows.filter(r => r.unknown !== true && r.evidenceValue != null && isFinite(r.evidenceValue));
  const distinct = distinctFinite(known.map(r => r.evidenceValue));
  const mixedUnknownAndKnown = unknownRows.length > 0 && known.length > 0;
  let status;
  if (mixedUnknownAndKnown || distinct.length > 1) status = 'CONFLICT';
  else if (unknownRows.length && !known.length) status = 'MISSING';
  else if (!debt.found) status = 'MISSING';
  else if (!debt.pendingPresent) status = 'MISSING';
  else if (near(distinct[0], debt.pending)) status = 'MATCH';
  else status = 'CHANGE';
  return rows.map(row => {
    const unknown = row.unknown === true || row.evidenceValue == null || !isFinite(row.evidenceValue);
    return {
      observationId: row.observationId,
      fact: 'pending',
      cardId,
      accountLabel: row.accountLabel,
      evidenceValue: unknown ? null : row.evidenceValue,
      observedAsOf: row.observedAsOf || null,
      evidenceDate: row.evidenceDate,
      canonicalValue: debt.found && debt.pendingPresent ? debt.pending : null,
      canonicalTarget: debt.locator + '#pending',
      difference: !unknown && debt.found && debt.pendingPresent
        ? round2(row.evidenceValue - debt.pending)
        : null,
      status,
      unknown,
      identityProven: row.identityProven === true,
      householdCash: 0,
      note: unknown
        ? (row.note || 'unknown pending is not $0')
        : (row.note || 'pending is not posted balance'),
    };
  });
}

function compareLimitGroup(rows, data) {
  const first = rows[0];
  const cardId = first.cardId;
  const debt = readDebtCard(data, cardId);
  const amounts = rows
    .filter(r => r.evidenceValue != null && isFinite(r.evidenceValue))
    .map(r => r.evidenceValue);
  const distinct = distinctFinite(amounts);
  let status;
  if (distinct.length > 1) status = 'CONFLICT';
  else if (!debt.found || debt.limit == null || !isFinite(debt.limit)) status = 'MISSING';
  else if (!amounts.length) status = 'MISSING';
  else if (near(distinct[0], debt.limit)) status = 'MATCH';
  else status = 'CHANGE';
  return rows.map(row => ({
    observationId: row.observationId,
    fact: 'limit',
    cardId,
    accountLabel: row.accountLabel,
    evidenceValue: row.evidenceValue,
    evidenceDate: row.evidenceDate,
    canonicalValue: debt.found && debt.limit != null ? debt.limit : null,
    canonicalTarget: debt.locator + '#limit',
    difference: debt.found && debt.limit != null && row.evidenceValue != null
      ? round2(row.evidenceValue - debt.limit)
      : null,
    status,
    householdCash: householdCashFromCardCapacity(),
    note: row.note || 'credit limit is not household cash',
  }));
}

function compareAvailableCreditGroup(rows) {
  const first = rows[0];
  const cardId = first.cardId;
  const amounts = rows
    .filter(r => r.unknown !== true && r.evidenceValue != null && isFinite(r.evidenceValue))
    .map(r => r.evidenceValue);
  const distinct = distinctFinite(amounts);
  const status = distinct.length > 1 ? 'CONFLICT' : 'MISSING';
  return rows.map(row => ({
    observationId: row.observationId,
    fact: 'available-credit',
    cardId,
    accountLabel: row.accountLabel,
    evidenceValue: row.unknown ? null : row.evidenceValue,
    evidenceDate: row.evidenceDate,
    canonicalValue: null,
    canonicalTarget: '(informational — not household cash)',
    difference: null,
    status,
    householdCash: householdCashFromCardCapacity(),
    identityProven: row.identityProven === true,
    note: status === 'CONFLICT'
      ? (row.note || 'same-time available-credit facts disagree — not guessed')
      : (row.note || 'available credit is observed, not a canonical Atlas field — $0 household cash'),
  }));
}

function compareConfirmedPayment(row) {
  const unknown = row.unknown === true || row.evidenceValue == null || !isFinite(row.evidenceValue);
  const posted = row.posted === true;
  const applied = row.appliedToPosted === true;
  return {
    observationId: row.observationId,
    fact: 'confirmed-payment',
    cardId: row.cardId,
    accountLabel: row.accountLabel,
    evidenceValue: unknown ? null : row.evidenceValue,
    evidenceDate: row.evidenceDate,
    canonicalValue: null,
    canonicalTarget: '(observed payment — not a canonical payment event)',
    difference: null,
    status: 'MISSING',
    paymentId: row.paymentId || null,
    posted,
    appliedToPosted: applied,
    householdCash: 0,
    note: row.note || (applied
      ? 'confirmed posted payment already in posted balance — do not subtract again; no canonical payment event'
      : (posted
        ? 'confirmed posted payment reduces exposure once; no canonical payment event'
        : 'payment initiated is not payment posted')),
  };
}

function compareScheduledPayment(row, data) {
  const target = row.canonical || (row.obligationId
    ? { collection: 'obligations', id: row.obligationId }
    : null);
  const canonical = target ? readCanonical(data, target) : { found: false, value: null, locator: '(unspecified)' };
  let status;
  if (!canonical.found) status = 'MISSING';
  else if (row.evidenceValue != null && isFinite(row.evidenceValue)
    && !near(row.evidenceValue, canonical.value)) status = 'CHANGE';
  else status = 'MATCH';
  return {
    observationId: row.observationId,
    fact: 'scheduled-payment',
    cardId: row.cardId,
    accountLabel: row.accountLabel,
    evidenceValue: row.evidenceValue,
    evidenceDate: row.evidenceDate,
    canonicalValue: canonical.found ? canonical.value : null,
    canonicalTarget: canonical.locator,
    difference: canonical.found && row.evidenceValue != null
      ? round2(row.evidenceValue - canonical.value)
      : null,
    status,
    reducesExposure: false,
    householdCash: 0,
    note: row.note || 'scheduled payment reminder is not a confirmed posted payment',
  };
}

function compareCardObservations(cardObservations, data) {
  const rows = [];
  const groups = new Map();
  for (const obs of cardObservations || []) {
    if (!CARD_FACTS.has(obs.fact)) continue;
    const date = obs.evidenceDate || '(none)';
    const key = `${obs.cardId || obs.observationId}:${obs.fact}:${date}`;
    const list = groups.get(key) || [];
    list.push(obs);
    groups.set(key, list);
  }
  for (const group of groups.values()) {
    const fact = group[0].fact;
    if (fact === 'posted-balance') rows.push(...comparePostedBalanceGroup(group, data));
    else if (fact === 'pending') rows.push(...comparePendingGroup(group, data));
    else if (fact === 'limit') rows.push(...compareLimitGroup(group, data));
    else if (fact === 'available-credit') rows.push(...compareAvailableCreditGroup(group));
    else if (fact === 'confirmed-payment') {
      for (const row of group) rows.push(compareConfirmedPayment(row));
    } else if (fact === 'scheduled-payment') {
      for (const row of group) rows.push(compareScheduledPayment(row, data));
    }
  }
  return rows;
}

function observationsFromPosting(doc) {
  return ((doc && doc.observations) || []).map(item => ({
    observationId: item.observationId,
    fact: item.fact || 'posting',
    eventId: item.eventId || (item.canonical && item.canonical.id) || null,
    accountLabel: item.label || item.eventId,
    evidenceValue: null,
    observedAsOf: item.observedAsOf || null,
    evidenceDate: item.observedAsOf || null,
    scheduledDate: item.scheduledDate || null,
    posted: item.posted === true,
    unknown: item.unknown === true || (item.posted !== true && item.posted !== false),
    canonical: item.canonical || (item.eventId
      ? { collection: 'representedEvents', id: item.eventId, date: item.scheduledDate || null }
      : null),
    source: item.source || null,
    note: item.note || null,
  }));
}

function schedulePlanWithoutCutover(plan) {
  return {
    income: (plan && plan.income) || [],
    obligations: (plan && plan.obligations) || [],
    bills: (plan && plan.bills) || [],
    commitments: (plan && plan.commitments) || [],
    startingCash: plan && plan.startingCash,
  };
}

function scheduledEventExists(data, eventId, scheduledDate) {
  if (!eventId || !scheduledDate) return false;
  const plan = ((data || {}).plan) || {};
  // Forecast decides whether {id, date} is a cash occurrence. Opening
  // cutover is posting, not schedule, so representedEvents is omitted.
  const events = Forecast.expandEvents(
    schedulePlanWithoutCutover(plan),
    Forecast.statementOccurrenceDate(plan, eventId, scheduledDate),
    Forecast.statementOccurrenceDate(plan, eventId, scheduledDate),
    { keepRepresented: true }
  );
  const original = Forecast.statementOccurrenceIdentity(plan, eventId, scheduledDate);
  return events.some(e => e.id === eventId && (e.scheduledDate || e.date) === original && e.kind !== 'noncash');
}

function representedOnOpening(data, eventId, date) {
  const opening = (((data || {}).plan) || {}).opening || null;
  if (!opening || !eventId || !date) return false;
  return Forecast.representedOccurrence(data.plan, eventId, date, opening.asOf);
}

function openingAsOf(data) {
  const opening = (((data || {}).plan) || {}).opening || null;
  return opening && opening.asOf ? opening.asOf : null;
}

function postingState(row) {
  if (!row || row.unknown === true) return 'unknown';
  if (row.posted === true) return 'posted';
  if (row.posted === false) return 'unposted';
  return 'unknown';
}

function derivedPostingStatus(postedState, represented) {
  if (postedState === 'unknown') return represented ? 'invented-posting' : 'posting-unknown';
  if (postedState === 'posted') return represented ? 'posted-represented' : 'posted-not-represented';
  return represented ? 'unposted-but-represented' : 'scheduled-unposted';
}

function comparePostingGroup(rows, data) {
  const first = rows[0];
  const eventId = first.eventId || (first.canonical && first.canonical.id) || null;
  const scheduledDate = first.scheduledDate || null;
  const states = [];
  for (const row of rows) {
    const state = postingState(row);
    if (!states.includes(state)) states.push(state);
  }
  const mixed = states.length > 1;
  const exists = scheduledEventExists(data, eventId, scheduledDate);
  const represented = representedOnOpening(data, eventId, scheduledDate);
  const asOf = openingAsOf(data);
  const locator = eventId
    ? `representedEvents:${eventId}@${scheduledDate || '(none)'}`
    : '(unspecified)';

  return rows.map(row => {
    const state = postingState(row);
    let status;
    if (mixed) status = 'CONFLICT';
    else if (!exists) status = 'MISSING';
    else if (state === 'unknown') status = represented ? 'CONFLICT' : 'MISSING';
    else if (state === 'posted') status = represented ? 'MATCH' : 'CHANGE';
    else status = represented ? 'CONFLICT' : 'MATCH';
    const derived = mixed
      ? 'conflicted-posting'
      : derivedPostingStatus(state, represented);
    return {
      observationId: row.observationId,
      fact: 'posting',
      eventId,
      accountLabel: row.accountLabel,
      evidenceValue: null,
      observedAsOf: row.observedAsOf || null,
      evidenceDate: row.evidenceDate,
      scheduledDate,
      posted: state === 'posted',
      unknown: state === 'unknown',
      represented,
      openingAsOf: asOf,
      scheduledExists: exists,
      derivedStatus: derived,
      canonicalValue: represented ? 1 : (exists ? 0 : null),
      canonicalTarget: locator,
      difference: null,
      status,
      note: mixed
        ? (row.note || 'same-time posting facts disagree — not guessed')
        : (row.note || (state === 'unknown'
          ? 'unknown posting is not posted and is not unposted'
          : (state === 'posted'
            ? 'posted occurrence must be named on representedEvents when opening.asOf is that date'
            : 'schedule is not proof of posting'))),
    };
  });
}

function comparePostingObservations(postingObservations, data) {
  const rows = [];
  const groups = new Map();
  for (const obs of postingObservations || []) {
    if (!POSTING_FACTS.has(obs.fact)) continue;
    const eventId = obs.eventId || (obs.canonical && obs.canonical.id) || obs.observationId;
    const date = obs.scheduledDate || '(none)';
    const key = `${eventId}:${date}`;
    const list = groups.get(key) || [];
    list.push(obs);
    groups.set(key, list);
  }
  for (const group of groups.values()) {
    rows.push(...comparePostingGroup(group, data));
  }
  return rows;
}

function observationTime(row) {
  if (!row) return '';
  const d = row.observedAsOf || row.evidenceDate;
  if (d == null || d === '' || d === '(none)') return '';
  return String(d);
}

function freshnessOwnedByMetaAsOf(row) {
  return !!(row && (!row.fact || META_ASOF_FRESHNESS_FACTS.has(row.fact)));
}

// Date comparison only. This is not a STALE assignment: there is no
// owner-defined age threshold. "canonical-older" means the published
// freshness timestamp is older than this row's observation time.
// Due, settlement, and scheduled dates are not observation times.
// meta.asOf is used only for snapshot facts whose freshness it owns.
const DATE_RELATIONS = ['canonical-older', 'same-day', 'canonical-newer', 'incomparable'];
function dateRelation(observed, canonicalFreshness) {
  const ev = observed == null || observed === '' || observed === '(none)'
    ? '' : String(observed);
  const asOf = canonicalFreshness == null || canonicalFreshness === '' ? '' : String(canonicalFreshness);
  if (!ev || !asOf) return 'incomparable';
  if (ev === asOf) return 'same-day';
  if (ev > asOf) return 'canonical-older';
  return 'canonical-newer';
}
function annotateDateRelation(rows, canonicalAsOf) {
  const counts = { 'canonical-older': 0, 'same-day': 0, 'canonical-newer': 0, incomparable: 0 };
  for (const row of rows || []) {
    const observed = observationTime(row);
    const freshness = freshnessOwnedByMetaAsOf(row)
      ? (canonicalAsOf == null || canonicalAsOf === '' ? '' : String(canonicalAsOf))
      : '';
    row.dateRelation = dateRelation(observed, freshness);
    counts[row.dateRelation] = (counts[row.dateRelation] || 0) + 1;
  }
  return counts;
}

function cardSummaries(cardRows) {
  const byCard = new Map();
  for (const row of cardRows || []) {
    const id = row.cardId;
    if (!id) continue;
    const entry = byCard.get(id) || {
      cardId: id,
      posted: null,
      pending: null,
      pendingUnknown: false,
      pendingConflict: false,
      postedConflict: false,
      balanceIncludesPending: false,
      limit: null,
      available: null,
      availableConflict: false,
      confirmedPayments: [],
      scheduledPayments: [],
      unresolved: [],
      householdCashFromLimit: 0,
      householdCashFromAvailable: 0,
      _postedAsOf: null,
      _pendingAsOf: null,
    };
    if (row.fact === 'posted-balance') {
      const t = observationTime(row);
      if (entry._postedAsOf == null || t > entry._postedAsOf) {
        entry._postedAsOf = t;
        entry.postedConflict = row.status === 'CONFLICT';
        entry.posted = entry.postedConflict || row.evidenceValue == null ? null : row.evidenceValue;
        entry.balanceIncludesPending = !entry.postedConflict && row.balanceIncludesPending === true;
      } else if (t === entry._postedAsOf) {
        if (row.status === 'CONFLICT') {
          entry.postedConflict = true;
          entry.posted = null;
          entry.balanceIncludesPending = false;
        } else if (!entry.postedConflict && row.evidenceValue != null) {
          entry.posted = row.evidenceValue;
          entry.balanceIncludesPending = row.balanceIncludesPending === true;
        }
      }
    }
    if (row.fact === 'pending') {
      if (row.unknown) entry.unresolved.push('pending unknown');
      const t = observationTime(row);
      if (entry._pendingAsOf == null || t > entry._pendingAsOf) {
        entry._pendingAsOf = t;
        entry.pendingConflict = row.status === 'CONFLICT';
        entry.pendingUnknown = entry.pendingConflict || row.unknown === true;
        entry.pending = entry.pendingUnknown || row.evidenceValue == null ? null : row.evidenceValue;
      } else if (t === entry._pendingAsOf) {
        if (row.status === 'CONFLICT') {
          entry.pendingConflict = true;
          entry.pendingUnknown = true;
          entry.pending = null;
        } else if (row.unknown) {
          entry.pendingUnknown = true;
          entry.pending = null;
        } else if (!entry.pendingUnknown && !entry.pendingConflict && row.evidenceValue != null) {
          entry.pending = row.evidenceValue;
        }
      }
    }
    if (row.fact === 'limit' && row.evidenceValue != null) entry.limit = row.evidenceValue;
    if (row.fact === 'available-credit') {
      if (row.status === 'CONFLICT') entry.availableConflict = true;
      if (row.evidenceValue != null && entry.available == null) entry.available = row.evidenceValue;
    }
    if (row.fact === 'confirmed-payment') {
      entry.confirmedPayments.push({
        paymentId: row.paymentId,
        amount: row.evidenceValue,
        posted: row.posted === true,
        appliedToPosted: row.appliedToPosted === true,
        confirmed: true,
      });
    }
    if (row.fact === 'scheduled-payment') {
      entry.scheduledPayments.push({ amount: row.evidenceValue });
    }
    if (row.status === 'MISSING' || row.status === 'CONFLICT' || row.status === 'CHANGE') {
      entry.unresolved.push(`${row.fact} ${row.status}`);
    }
    byCard.set(id, entry);
  }
  return [...byCard.values()].map(entry => {
    if (entry._pendingAsOf == null) {
      entry.pendingUnknown = true;
      entry.pending = null;
    }
    const exposure = cardExposure({
      posted: entry.posted,
      pending: entry.pending,
      pendingUnknown: entry.pendingUnknown,
      pendingConflict: entry.pendingConflict === true,
      postedConflict: entry.postedConflict === true,
      balanceIncludesPending: entry.balanceIncludesPending === true,
      payments: entry.confirmedPayments,
    });
    const published = Object.assign({}, entry, {
      exposure: exposure.amount,
      exposureUnknown: exposure.unknown === true,
      exposureReason: exposure.reason,
    });
    delete published._postedAsOf;
    delete published._pendingAsOf;
    return published;
  });
}

function compareGroup(rows, data) {
  const first = rows[0];
  const target = first.canonical;
  const canonical = readCanonical(data, target);
  // An observation the observer qualified as unknown (for example a balance
  // dated after the request day, or with no semantic balance date) is never
  // a value here. It cannot become MATCH or CHANGE, and the flag survives
  // onto the published row so every later proposal boundary still sees it.
  const isUnknown = r => r.unknown === true;
  const values = rows
    .filter(r => !isUnknown(r) && r.evidenceValue != null && isFinite(r.evidenceValue))
    .map(r => r.evidenceValue);
  const unknownCount = rows.filter(isUnknown).length;
  const distinct = [];
  for (const v of values) {
    if (!distinct.some(x => near(x, v))) distinct.push(v);
  }

  let status;
  if (!canonical.found) status = 'MISSING';
  else if (unknownCount && values.length) status = 'CONFLICT';
  else if (distinct.length > 1) status = 'CONFLICT';
  else if (!values.length) status = 'MISSING';
  else if (near(values[0], canonical.value)) status = 'MATCH';
  else status = 'CHANGE';

  const evidenceValue = values.length === 1 ? values[0]
    : values.length ? values[0] : null;
  const difference = canonical.found && evidenceValue != null
    ? Math.round((evidenceValue - canonical.value) * 100) / 100
    : null;

  return rows.map(row => {
    const unknown = isUnknown(row);
    const out = {
      observationId: row.observationId,
      accountLabel: row.accountLabel,
      evidenceValue: unknown ? null : row.evidenceValue,
      evidenceDate: row.evidenceDate,
      canonicalValue: canonical.found ? canonical.value : null,
      canonicalTarget: canonical.locator,
      difference: unknown ? null : canonical.found && row.evidenceValue != null
        ? Math.round((row.evidenceValue - canonical.value) * 100) / 100
        : difference,
      status,
      sourceMissing: !!row.sourceMissing,
    };
    if (unknown) {
      out.unknown = true;
      if (row.unknownReason) out.unknownReason = row.unknownReason;
    }
    return out;
  });
}

function reconcile(input) {
  const data = input.data;
  const map = input.map;
  const raw = input.observations
    || observationsFromPositions(input.positionRows || [], map);
  const extraSettlements = input.settlementObservations
    || observationsFromSettlements(input.settlements);
  const extraUtility = input.utilityObservations
    || observationsFromUtility(input.utility);
  const extraAmanda = input.amandaObservations
    || observationsFromAmanda(input.amanda);
  const extraCards = input.cardObservations
    || observationsFromCards(input.cards);
  const extraPosting = input.postingObservations
    || observationsFromPosting(input.posting);
  const observations = raw.filter(o =>
    o.fact !== 'settlement'
    && !UTILITY_FACTS.has(o.fact)
    && !AMANDA_FACTS.has(o.fact)
    && !CARD_FACTS.has(o.fact)
    && !POSTING_FACTS.has(o.fact));
  const settlementObservations = raw.filter(o => o.fact === 'settlement')
    .concat(extraSettlements || []);
  const utilityObservations = raw.filter(o => UTILITY_FACTS.has(o.fact))
    .concat(extraUtility || []);
  const amandaObservations = raw.filter(o => AMANDA_FACTS.has(o.fact))
    .concat(extraAmanda || []);
  const cardObservations = raw.filter(o => CARD_FACTS.has(o.fact))
    .concat(extraCards || []);
  const postingObservations = raw.filter(o => POSTING_FACTS.has(o.fact))
    .concat(extraPosting || []);
  const groups = new Map();
  for (const obs of observations) {
    const key = obs.canonical
      ? `${obs.canonical.collection}:${obs.canonical.id}`
      : obs.observationId;
    const list = groups.get(key) || [];
    list.push(obs);
    groups.set(key, list);
  }
  const settlementGroups = new Map();
  for (const obs of settlementObservations) {
    const id = (obs.canonical && obs.canonical.id) || obs.commitmentId || obs.observationId;
    const key = `commitments:${id}`;
    const list = settlementGroups.get(key) || [];
    list.push(obs);
    settlementGroups.set(key, list);
  }
  const rows = [];
  for (const group of groups.values()) {
    rows.push(...compareGroup(group, data));
  }
  for (const group of settlementGroups.values()) {
    rows.push(...compareSettlementGroup(group, data));
  }
  const datedDueGroups = new Map();
  for (const obs of utilityObservations) {
    if (obs.fact === 'account-balance') {
      rows.push(compareAccountBalance(obs, data));
      continue;
    }
    if (obs.fact === 'paying-account') {
      rows.push(comparePayingAccount(obs, data));
      continue;
    }
    if (obs.fact === 'dated-due') {
      const id = (obs.canonical && obs.canonical.id) || obs.observationId;
      const key = `bills:${id}`;
      const list = datedDueGroups.get(key) || [];
      list.push(obs);
      datedDueGroups.set(key, list);
    }
  }
  for (const group of datedDueGroups.values()) {
    rows.push(...compareDatedDueGroup(group, data));
  }
  for (const obs of amandaObservations) {
    if (obs.fact === 'employment-deposit') rows.push(compareEmploymentDeposit(obs, data));
    else if (obs.fact === 'household-transfer') rows.push(compareHouseholdTransfer(obs, data));
    else if (obs.fact === 'coaching-receipt') rows.push(compareCoachingReceipt(obs, data));
    else if (obs.fact === 'business-obligation') rows.push(compareBusinessObligation(obs, data));
    else if (obs.fact === 'internal-transfer') rows.push(compareInternalTransfer(obs, data));
    else if (obs.fact === 'household-available') rows.push(compareHouseholdAvailable(obs, data));
  }
  rows.push(...compareCardObservations(cardObservations, data));
  rows.push(...comparePostingObservations(postingObservations, data));
  const counts = { MATCH: 0, STALE: 0, CHANGE: 0, CONFLICT: 0, MISSING: 0 };
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  const canonicalAsOf = data.meta && data.meta.asOf ? data.meta.asOf : null;
  const dateRelationCounts = annotateDateRelation(rows, canonicalAsOf);
  return {
    writesCanonicalState: false,
    canonicalAsOf,
    staleAssigned: false,
    staleReason: (map && map.stale)
      || 'No owner-defined age threshold exists. Evidence dates are reported; STALE is not inferred.',
    dateRelationCounts,
    amandaTransferAuthority: amandaTransferAuthorityContext(data),
    cardSummaries: cardSummaries(rows.filter(r => CARD_FACTS.has(r.fact))),
    rows,
    counts,
  };
}

function formatReport(result) {
  const lines = [];
  lines.push('Atlas reconciliation — non-writing compare');
  lines.push('Source: docs/positions.csv (Household cash/debt rows with a map entry)');
  lines.push('Settlement source: docs/reconciliation/commitment-settlements.json');
  lines.push('Hydro source: docs/reconciliation/utility-observations.json');
  lines.push('Amanda source: docs/reconciliation/amanda-income-observations.json');
  lines.push('Card source: docs/reconciliation/card-state-observations.json');
  lines.push('Posting source: docs/reconciliation/posting-observations.json');
  lines.push('Canonical: data.json via id locator (not array-index JSON Pointer)');
  lines.push(`Canonical as-of: ${result.canonicalAsOf || '(none)'}`);
  lines.push(`STALE: not assigned — ${result.staleReason}`);
  const rel = result.dateRelationCounts || {};
  lines.push('Date relation (not a STALE assignment): '
    + DATE_RELATIONS.map(k => `${rel[k] || 0} ${k}`).join(', '));
  lines.push('canonical-older means this observation time is newer than a comparable canonical freshness date.');
  lines.push('Due, settlement, and scheduled dates are not observation times. meta.asOf is not a universal substitute.');
  lines.push('This command does not write data.json.');
  lines.push('');
  const cols = [
    ['observation', 28],
    ['evidence', 12],
    ['date', 12],
    ['canonical', 12],
    ['diff', 10],
    ['status', 10],
    ['target', 28],
  ];
  const pad = (s, n) => String(s == null ? '' : s).padEnd(n).slice(0, n);
  lines.push(cols.map(([h, n]) => pad(h, n)).join(' '));
  for (const row of result.rows) {
    const evidence = row.fact === 'settlement'
      ? (row.evidenceSettledOn || '—')
      : row.fact === 'paying-account'
        ? (row.payingAccountLabel || row.payingAccount || '—')
        : row.fact === 'household-available'
          ? (row.observedBalance == null ? 'unresolved' : n2(row.observedBalance))
        : (row.fact === 'coaching-receipt' || row.fact === 'business-obligation'
          || row.fact === 'household-transfer')
          && row.evidenceValue == null
          ? (row.fact === 'household-transfer' ? 'not observed' : 'unresolved')
        : row.fact === 'available-credit'
          ? (row.evidenceValue == null ? '—' : n2(row.evidenceValue))
        : (row.fact === 'pending' && row.unknown)
          ? 'unknown'
        : row.fact === 'posting'
          ? (row.unknown ? 'unknown' : (row.posted ? 'posted' : 'unposted'))
        : (row.fact === 'confirmed-payment' && row.appliedToPosted)
          ? n2(row.evidenceValue)
          : (row.evidenceValue == null ? '—' : n2(row.evidenceValue));
    const canonical = row.fact === 'settlement'
      ? (row.canonicalSettledOn || 'unsettled')
      : row.fact === 'account-balance'
        ? 'not scheduled'
        : row.fact === 'paying-account'
          ? (row.canonicalPayingAccount || (row.status === 'MISSING' ? 'missing' : '—'))
          : row.fact === 'employment-deposit'
            ? (row.status === 'CONFLICT' ? 'double-count' : 'not promoted')
            : row.fact === 'internal-transfer'
              ? '$0 income'
              : row.fact === 'coaching-receipt'
                ? 'not household'
                : row.fact === 'business-obligation'
                  ? (row.remainderEstablished ? n2(row.canonicalValue) : 'unresolved')
                : row.fact === 'household-available'
                  ? (row.canonicalValue == null ? '—' : n2(row.canonicalValue))
            : row.fact === 'household-transfer' && row.independentlyObserved !== true
              ? 'canonical ctx'
              : row.fact === 'available-credit' || row.fact === 'limit'
                ? '$0 cash'
                : (row.fact === 'pending' && row.unknown)
                  ? 'not $0'
                  : row.fact === 'confirmed-payment' && row.appliedToPosted
                    ? 'already in'
                    : row.fact === 'scheduled-payment'
                      ? 'schedule only'
                  : row.fact === 'posting'
                    ? (row.represented ? 'represented' : (row.scheduledExists ? 'not represented' : 'missing'))
              : (row.canonicalValue == null ? '—' : n2(row.canonicalValue));
    lines.push([
      pad(row.observationId, 28),
      pad(evidence, 12),
      pad(row.evidenceDate || '—', 12),
      pad(canonical, 12),
      pad(row.difference == null ? '—' : n2(row.difference), 10),
      pad(row.status, 10),
      pad(row.canonicalTarget, 28),
    ].join(' '));
  }
  const hydro = result.rows.filter(r => UTILITY_FACTS.has(r.fact));
  if (hydro.length) {
    lines.push('');
    lines.push('Hydro / household-obligation distinctions:');
    for (const row of hydro) {
      const bits = [`  ${row.observationId}: ${row.fact}`];
      if (row.fact === 'account-balance') bits.push(row.note || 'informational / not scheduled amount');
      if (row.fact === 'dated-due') {
        bits.push(row.status === 'MISSING'
          ? 'canonical missing/change'
          : `canonical ${row.status.toLowerCase()}`);
      }
      if (row.fact === 'paying-account') {
        bits.push(row.payingAccountLabel || row.payingAccount || 'paying account');
        bits.push(row.jointCashPool === false
          ? 'Amanda / external-to-joint-pool'
          : 'joint-cash pool');
      }
      lines.push(bits.join(' — '));
    }
  }
  const amanda = result.rows.filter(r => AMANDA_FACTS.has(r.fact));
  if (amanda.length) {
    lines.push('');
    lines.push('Amanda income / coaching / transfer distinctions:');
    for (const row of amanda) {
      const bits = [`  ${row.observationId}: ${row.fact}`];
      if (row.fact === 'employment-deposit') {
        bits.push('observed Amanda Tennis BC salary');
        if (row.status === 'CONFLICT') {
          bits.push('CONFLICT — salary plus transfer would double-count');
        } else if (row.status === 'MATCH') {
          bits.push(`MATCH against ${row.canonicalTarget}`);
        } else if (row.intentionallyNotPromoted) {
          bits.push('no canonical salary fact');
        } else {
          bits.push(row.status);
        }
      }
      if (row.fact === 'household-transfer') {
        bits.push(row.doubleCount
          ? 'CONFLICT — must not sit beside a salary stream'
          : (row.independentlyObserved
            ? 'independently observed household transfer'
            : 'canonical authority reference — not independently verified by this evidence'));
      }
      if (row.fact === 'coaching-receipt') bits.push('business inflow, not automatically household income');
      if (row.fact === 'business-obligation') {
        bits.push(row.unknown
          ? 'unknown — fail closed, remainder unresolved'
          : 'reduces household-available remainder');
      }
      if (row.fact === 'internal-transfer') bits.push('$0 new income');
      if (row.fact === 'household-available') {
        bits.push(row.remainderEstablished
          ? 'remainder established from known obligations'
          : 'remainder unresolved — do not treat account balance as spendable');
      }
      lines.push(bits.join(' — '));
    }
  }
  const cards = result.rows.filter(r => CARD_FACTS.has(r.fact));
  if (cards.length) {
    lines.push('');
    lines.push('Card current-state distinctions:');
    for (const row of cards) {
      const bits = [`  ${row.observationId}: ${row.fact}`];
      if (row.fact === 'posted-balance') bits.push('posted is not pending');
      if (row.fact === 'pending') {
        bits.push(row.unknown
          ? 'unknown pending is not $0'
          : 'pending is not posted');
      }
      if (row.fact === 'limit') bits.push('limit is not household cash');
      if (row.fact === 'available-credit') {
        bits.push(row.status === 'CONFLICT'
          ? 'CONFLICT — same-time available-credit facts disagree, not household cash'
          : 'available credit is not household cash');
      }
      if (row.fact === 'confirmed-payment') {
        bits.push(row.appliedToPosted
          ? 'already in posted — do not subtract again'
          : (row.posted ? 'reduces exposure once' : 'initiated is not posted'));
      }
      if (row.fact === 'scheduled-payment') bits.push('schedule is not a confirmed posted payment');
      lines.push(bits.join(' — '));
    }
    const summaries = result.cardSummaries || [];
    if (summaries.length) {
      lines.push('');
      lines.push('Card exposure (fail-closed; not a second authority):');
      for (const card of summaries) {
        const pending = card.pendingConflict
          ? 'CONFLICT'
          : (card.pendingUnknown ? 'unknown' : (card.pending == null ? '—' : n2(card.pending)));
        const exposure = card.exposureUnknown ? `unknown (${card.exposureReason})` : n2(card.exposure);
        const available = card.availableConflict
          ? 'CONFLICT'
          : (card.available == null ? '—' : n2(card.available));
        lines.push(`  ${card.cardId}: posted ${card.posted == null ? '—' : n2(card.posted)} · pending ${pending} · limit ${card.limit == null ? '—' : n2(card.limit)} · available ${available} · exposure ${exposure} · household cash from limit/available $0.00`);
      }
    }
  }
  const posting = result.rows.filter(r => POSTING_FACTS.has(r.fact));
  if (posting.length) {
    lines.push('');
    lines.push('Schedule vs posted distinctions:');
    for (const row of posting) {
      const bits = [`  ${row.observationId}: posting`];
      if (row.unknown) bits.push('unknown posting is not posted and is not unposted');
      else if (row.posted) bits.push('posted is not merely scheduled');
      else bits.push('schedule is not proof of posting');
      bits.push(row.derivedStatus || row.status);
      lines.push(bits.join(' — '));
    }
  }
  const auth = result.amandaTransferAuthority;
  if (auth) {
    lines.push('');
    lines.push('Amanda household-income Forecast authority (canonical context):');
    if (auth.doubleCount) {
      lines.push('  CONFLICT — salary plus amandaTransfer would double-count household income');
    }
    if (auth.salaryPresent) {
      lines.push(`  ${auth.locator} — owner-confirmed Tennis BC salary is Forecast household income`);
      if (auth.canonicalExpected != null) {
        lines.push(`  canonical monthly salary total: ${n2(auth.canonicalExpected)}`);
      }
      lines.push('  coaching surplus is not forecast; later salary transfers are not a second income line; raw TENNIS INCOME balance is not spendable');
    } else if (auth.transferPresent) {
      lines.push(`  ${auth.locator} — incumbent estimated household-cash authority`);
      if (auth.canonicalExpected != null) {
        lines.push(`  canonical expected (from data.json, not this evidence record): ${n2(auth.canonicalExpected)}`);
      }
      lines.push('  Aug. 14 session did not independently observe or verify the canonical scenarioMonthly values');
    } else {
      lines.push('  no canonical Amanda salary or transfer stream');
    }
  }
  lines.push('');
  lines.push('Summary: '
    + STATUSES.map(s => `${result.counts[s] || 0} ${s}`).join(', '));
  lines.push('Owner-approved canonical edits remain a separate explicit action.');
  return lines.join('\n');
}

function loadDefaults() {
  return {
    data: JSON.parse(fs.readFileSync(DEFAULT_DATA, 'utf8')),
    map: JSON.parse(fs.readFileSync(DEFAULT_MAP, 'utf8')),
    positionRows: householdPositionRows(fs.readFileSync(DEFAULT_CSV, 'utf8')),
    settlements: JSON.parse(fs.readFileSync(DEFAULT_SETTLEMENTS, 'utf8')),
    utility: JSON.parse(fs.readFileSync(DEFAULT_UTILITY, 'utf8')),
    amanda: JSON.parse(fs.readFileSync(DEFAULT_AMANDA, 'utf8')),
    cards: JSON.parse(fs.readFileSync(DEFAULT_CARDS, 'utf8')),
    posting: JSON.parse(fs.readFileSync(DEFAULT_POSTING, 'utf8')),
  };
}

function runCli() {
  const loaded = loadDefaults();
  const result = reconcile(loaded);
  console.log(formatReport(result));
}

const api = {
  EPSILON,
  STATUSES,
  DATE_RELATIONS,
  dateRelation,
  freshnessOwnedByMetaAsOf,
  parseCsvLine,
  householdPositionRows,
  observationsFromPositions,
  observationsFromSettlements,
  observationsFromUtility,
  observationsFromAmanda,
  observationsFromCards,
  observationsFromPosting,
  representedOnOpening,
  scheduledEventExists,
  classifyAmandaMovement,
  householdCashFromAmandaMovements,
  householdCashFromCardCapacity,
  derivePendingFromIdentity,
  cardExposure,
  cardSummaries,
  amandaHouseholdAvailable,
  amandaTransferAuthorityContext,
  forecastHasAmandaDoubleCount,
  isAmandaSalaryStream,
  matchingAmandaSalaryStream,
  readCanonical,
  reconcile,
  formatReport,
  DEFAULT_DATA,
  DEFAULT_CSV,
  DEFAULT_MAP,
  DEFAULT_SETTLEMENTS,
  DEFAULT_UTILITY,
  DEFAULT_AMANDA,
  DEFAULT_CARDS,
  DEFAULT_POSTING,
  AMANDA_FACTS,
  CARD_FACTS,
  POSTING_FACTS,
  CARD_IDS,
  AMANDA_TRANSFER_ID,
  AMANDA_OPERATING_ID,
};

if (require.main === module) runCli();
else module.exports = api;
