'use strict';
/* Read-only recurring card-charge audit.
 *
 *   node scripts/recurring-audit.js --fixture <file> [--map <file>] [--data <file>]
 *   node scripts/recurring-audit.js --live [--history-days N]
 *
 * Discovers merchants on canonical revolving-credit accounts that repeat
 * often enough, regularly enough, or at similar enough amounts that the
 * household should review whether they are recurring costs.
 *
 * This is evidence analysis. It does not decide the financial plan.
 * Forecast remains the sole planning/calculation authority. This script
 * never writes data.json, never writes plan.bills, never writes public
 * artifacts, and never promotes a candidate into a bill.
 *
 * Live mode uses the incumbent Lunch Money GET-only seam
 * (scripts/provider-observe.js). Fixture mode is for tests and does not
 * authorize a live mapping.
 *
 * Output is a sanitized summary: canonical card ids, normalized merchant
 * identity, dates, amounts, cadence, and Atlas status. Provider transaction
 * ids, provider account ids, notes, and tags never appear.
 */

const fs = require('fs');
const path = require('path');
const Forecast = require('../public/forecast.js');
const Provider = require('./provider-observe.js');
const Periods = require('./periods.js');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DATA = path.join(ROOT, 'data.json');
const DEFAULT_HISTORY_DAYS = Periods.DEFAULT_HISTORY_DAYS;
const SCHEMA = 'atlas-recurring-card-audit/v1';

// Conservative, documented, tested thresholds. Dates may drift; monthly
// billing is accepted at ~28–32 day intervals, not the same calendar day.
const THRESHOLDS = Object.freeze({
  weekly: Object.freeze({
    minOccurrences: 4,
    medianMin: 6,
    medianMax: 8,
    intervalMin: 5,
    intervalMax: 9,
    minShareInWindow: 0.7,
  }),
  biweekly: Object.freeze({
    minOccurrences: 3,
    medianMin: 13,
    medianMax: 16,
    intervalMin: 12,
    intervalMax: 17,
    minShareInWindow: 0.7,
  }),
  monthly: Object.freeze({
    minOccurrences: 3,
    medianMin: 27,
    medianMax: 33,
    intervalMin: 26,
    intervalMax: 35,
    minShareInWindow: 0.7,
  }),
  quarterly: Object.freeze({
    minOccurrences: 3,
    medianMin: 85,
    medianMax: 100,
    intervalMin: 80,
    intervalMax: 105,
    minShareInWindow: 0.66,
  }),
  annual: Object.freeze({
    minOccurrences: 2,
    medianMin: 350,
    medianMax: 380,
    intervalMin: 340,
    intervalMax: 390,
    minSpanDays: 330,
  }),
  otherRegular: Object.freeze({
    minOccurrences: 3,
    maxCv: 0.12,
    minMedian: 7,
  }),
  nearFixedAbs: 1,
  nearFixedRel: 0.05,
  semiMonthlyClusterWidth: 3,
  semiMonthlyCenterGap: 8,
  isolatedPairMax: 2,
});

const FEE_LABELS = new Set([
  'other bank fees',
  'atm fees',
  'overdraft fees',
  'fees',
  'insufficient funds',
  'interest charge',
]);

const CARD_PAYMENT_PAYEE =
  /PAYMENT|THANKYOU|THANK YOU|AUTOPAY|\bPMT\b|CR CARD|CREDIT CARD PAY|ONLINE PAYMENT|MOBILE PAYMENT/i;
const DEBT_PAYEE =
  /TD MORTGAGE|CAN TIRE MC|MBNA M\/C|AFFIRM|FLEXITI|PYT TO|PAYMENT TO|TO:TD C\/C/i;
const PAYPAL_PREFIX = /^PAYPAL\s*\*?/i;

const GENERIC_BILL_TOKENS = new Set([
  'THE', 'OF', 'AND', 'OR', 'FOR', 'A', 'AN', 'TO',
  'SERVICES', 'SERVICE', 'MONTHLY', 'ANNUAL', 'YEARLY',
  'CONTRIBUTION', 'ACCOUNT', 'MINIMUM', 'PAYMENT', 'PLUS',
  'MEMBERSHIP', 'PREMIUM', 'DISPOSAL', 'GARBAGE',
]);

function loadDefaultIdentity() {
  try {
    return JSON.parse(fs.readFileSync(Provider.DEFAULT_IDENTITY, 'utf8'));
  } catch (err) {
    return { schema: null, rules: [] };
  }
}

function resolveIdentity(identity) {
  if (identity && Array.isArray(identity.rules)) return identity;
  return loadDefaultIdentity();
}

function identityRules(identity) {
  return ((identity && identity.rules) || []).filter(Provider.ruleHasIdentity);
}

function chargeAsIdentityTx(charge) {
  const payee = charge && (charge.payee || charge.merchantLabel) || null;
  const original = charge && (charge.originalName || charge.originalMerchant) || null;
  return {
    payee,
    displayedPayee: payee,
    originalName: original,
    original_name: original,
    originalMerchant: original || payee,
    date: charge && charge.date || null,
    amount: charge && charge.amount,
    pending: false,
  };
}

const RAW_LEAK_RE =
  /providerTransactionId|providerAccountId|provider_transaction_id|provider_account_id|"payee"\s*:|"notes"\s*:|"tags"\s*:|plaidId|plaid_id|externalId|external_id/i;

function fail(message) {
  const err = new Error(message);
  err.code = 'recurring-audit-failed';
  throw err;
}

function parseArgs(argv) {
  const out = {
    fixture: null,
    live: false,
    map: null,
    data: DEFAULT_DATA,
    historyDays: DEFAULT_HISTORY_DAYS,
    json: false,
    out: null,
    help: false,
  };
  for (let i = 0; i < (argv || []).length; i++) {
    const a = argv[i];
    if (a === '--fixture') out.fixture = argv[++i];
    else if (a === '--live') out.live = true;
    else if (a === '--map') out.map = argv[++i];
    else if (a === '--data') out.data = argv[++i];
    else if (a === '--history-days') out.historyDays = Number(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else fail(`Unknown option: ${a}`);
  }
  if (out.live && out.fixture) fail('Use --live or --fixture, not both.');
  if (!out.live && !out.fixture) fail('Provide --live or --fixture <file>.');
  if (!Number.isFinite(out.historyDays) || out.historyDays < 1) {
    fail('--history-days must be a positive number.');
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/recurring-audit.js --fixture <file> [--map <file>] [--data <file>]',
    '  node scripts/recurring-audit.js --live [--history-days N]',
    '',
    'Read-only recurring card-charge discovery. Never writes data.json.',
    'Default history window matches scripts/periods.js (650 days).',
  ].join('\n') + '\n';
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function daysBetween(from, to) {
  return Forecast.diffDays(from, to);
}

function median(values) {
  const list = (values || []).filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  if (list.length % 2) return list[mid];
  return (list[mid - 1] + list[mid]) / 2;
}

function mean(values) {
  const list = (values || []).filter(v => Number.isFinite(v));
  if (!list.length) return null;
  return list.reduce((s, v) => s + v, 0) / list.length;
}

function stdev(values) {
  const list = (values || []).filter(v => Number.isFinite(v));
  if (list.length < 2) return 0;
  const m = mean(list);
  const varSum = list.reduce((s, v) => s + (v - m) * (v - m), 0);
  return Math.sqrt(varSum / (list.length - 1));
}

function coeffVar(values) {
  const m = mean(values);
  if (m == null || m === 0) return null;
  return stdev(values) / Math.abs(m);
}

function shareInWindow(values, lo, hi) {
  const list = values || [];
  if (!list.length) return 0;
  return list.filter(v => v >= lo && v <= hi).length / list.length;
}

function normalizeMerchantKey(value) {
  return String(value == null ? '' : value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactMerchantKey(value) {
  return normalizeMerchantKey(value).replace(/\s+/g, '');
}

function sanitizeMerchantLabel(value) {
  const key = normalizeMerchantKey(value)
    .replace(/\b[A-Z]{2}\d{3}\b/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return key ? key.slice(0, 48) : null;
}

function firstMerchantToken(key) {
  const spaced = normalizeMerchantKey(key);
  return spaced.split(' ')[0] || '';
}

function isAmazonMerchantLabel(label) {
  const key = normalizeMerchantKey(label);
  if (!key) return false;
  const first = firstMerchantToken(key);
  if (first !== 'AMAZON' && first !== 'AMZN'
    && first !== 'AMAZONCA' && first !== 'AMAZONCOM') {
    return false;
  }
  if (/\b(REWARDS|MASTERCARD|PAYMENT|PMT|AUTOPAY)\b/.test(key)) return false;
  return true;
}

function isAmazonPrimeLikeLabel(label) {
  if (!isAmazonMerchantLabel(label)) return false;
  return /\bPRIME\b/.test(normalizeMerchantKey(label));
}

function isTravelVisaId(cardId) {
  const norm = String(cardId || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  return norm === 'travelvisa';
}

function isDaleCursorLabel(label) {
  const key = normalizeMerchantKey(label);
  if (!key) return false;
  return key === 'CURSOR' || key.startsWith('CURSOR ');
}

function merchantFamilyKey(label) {
  const compact = compactMerchantKey(label);
  if (!compact) return null;
  if (isAmazonMerchantLabel(label)) {
    return isAmazonPrimeLikeLabel(label) ? 'AMAZONPRIME' : 'AMAZON';
  }
  return compact;
}

function merchantFromPayee(payee, originalName) {
  let raw = String(payee || '').trim();
  if (PAYPAL_PREFIX.test(raw)) {
    raw = raw.replace(PAYPAL_PREFIX, '').replace(/^\*+\s*/, '').trim();
    if (!raw) return null;
  }
  if (!raw) raw = String(originalName || '').trim();
  if (!raw) return null;
  if (CARD_PAYMENT_PAYEE.test(raw.replace(/\s+/g, ''))) return null;
  if (DEBT_PAYEE.test(raw)) return null;
  const label = sanitizeMerchantLabel(raw);
  if (!label) return null;
  return label;
}

function normalizeCategoryLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function shouldSkipTransaction(tx) {
  if (!tx || tx.pending === true) return 'pending';
  if (tx.isIncome === true) return 'income';
  const label = normalizeCategoryLabel(tx.categoryLabel);
  if (tx.excludeFromTotals === true || label === 'payment, transfer' || label === 'transfer') {
    return 'transfer';
  }
  if (Periods.PAYMENT_LABELS.has(label)) return 'payment';
  if (FEE_LABELS.has(label)) return 'fee-or-interest';
  const amount = Number(tx.amount);
  if (!Number.isFinite(amount) || amount <= 0) return 'non-charge';
  return null;
}

function cardLabelFor(data, cardId) {
  const row = ((data && data.debts) || []).find(d => d && d.id === cardId);
  return row && row.label ? String(row.label) : String(cardId);
}

function revolvingCardIds(data) {
  const ids = new Set();
  for (const row of (data && data.debts) || []) {
    if (!row || !row.id) continue;
    if (row.id === 'heloc' || row.id === 'mortgage') continue;
    ids.add(String(row.id));
  }
  return ids;
}

function chargesFromNormalized(options) {
  const opts = options || {};
  const data = opts.data || {};
  const accountMap = opts.accountMap;
  if (!accountMap || !Array.isArray(accountMap.mappings)) {
    fail('Account map is missing mappings.');
  }
  const knownCards = revolvingCardIds(data);
  const mappingBy = new Map((accountMap.mappings || []).map(mapping => [
    String(mapping.providerAccountId), mapping,
  ]));
  const normalized = opts.normalized
    || Provider.normalizeLunchMoneyPayload(opts.payload, opts.fetchedAt);
  const skipped = {
    pending: 0,
    income: 0,
    transfer: 0,
    payment: 0,
    'fee-or-interest': 0,
    'non-charge': 0,
    unmapped: 0,
    'non-card': 0,
    'no-canonical': 0,
    'unknown-card': 0,
    'no-merchant': 0,
  };
  const cardsSeen = new Map();
  const charges = [];

  for (const tx of normalized.transactions || []) {
    const skip = shouldSkipTransaction(tx);
    if (skip) {
      skipped[skip] += 1;
      continue;
    }
    if (!tx.date || !/^\d{4}-\d{2}-\d{2}$/.test(tx.date)) continue;
    const mapping = mappingBy.get(String(tx.providerAccountId));
    if (!mapping) {
      skipped.unmapped += 1;
      continue;
    }
    if (mapping.atlasRole === Provider.EXTERNAL_LIVE_ROLE) {
      skipped['non-card'] += 1;
      continue;
    }
    if (mapping.atlasRole !== 'revolving-credit') {
      skipped['non-card'] += 1;
      continue;
    }
    const cardId = mapping.canonical && mapping.canonical.id;
    if (!cardId) {
      skipped['no-canonical'] += 1;
      continue;
    }
    if (knownCards.size && !knownCards.has(String(cardId))) {
      skipped['unknown-card'] += 1;
      continue;
    }
    const merchantLabel = merchantFromPayee(tx.payee, tx.originalName);
    if (!merchantLabel) {
      skipped['no-merchant'] += 1;
      continue;
    }
    const family = merchantFamilyKey(merchantLabel);
    if (!family) {
      skipped['no-merchant'] += 1;
      continue;
    }
    if (!cardsSeen.has(String(cardId))) {
      cardsSeen.set(String(cardId), {
        cardId: String(cardId),
        cardLabel: cardLabelFor(data, cardId),
        chargeCount: 0,
      });
    }
    cardsSeen.get(String(cardId)).chargeCount += 1;
    charges.push({
      date: tx.date,
      amount: round2(tx.amount),
      currency: tx.currency,
      pending: tx.pending,
      savingsPostingEvidence: tx.savingsPostingEvidence,
      providerTransactionId: tx.providerTransactionId,
      asOf: opts.asOf || null,
      cardId: String(cardId),
      cardLabel: cardLabelFor(data, cardId),
      merchantLabel,
      merchantKey: family,
      payee: tx.payee || merchantLabel,
      originalName: tx.originalName || tx.original_name || null,
      amazonMerchant: isAmazonMerchantLabel(merchantLabel),
      amazonPrimeLike: isAmazonPrimeLikeLabel(merchantLabel),
    });
  }

  charges.sort((a, b) =>
    a.date.localeCompare(b.date)
    || a.cardId.localeCompare(b.cardId)
    || a.merchantKey.localeCompare(b.merchantKey)
    || a.amount - b.amount);

  const dates = charges.map(c => c.date).filter(Boolean).sort();
  return {
    charges,
    skipped,
    cards: [...cardsSeen.values()].sort((a, b) => a.cardId.localeCompare(b.cardId)),
    coverageStart: dates[0] || null,
    coverageEnd: dates[dates.length - 1] || null,
  };
}

function intervalsFor(dates) {
  const out = [];
  for (let i = 1; i < dates.length; i++) {
    const n = daysBetween(dates[i - 1], dates[i]);
    if (n != null) out.push(n);
  }
  return out;
}

function dayClusters(dates) {
  const days = dates.map(d => Number(String(d).slice(8, 10))).filter(n => n >= 1 && n <= 31);
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length < 2) return null;
  let bestI = 0;
  let bestGap = 0;
  for (let i = 0; i < unique.length - 1; i++) {
    const gap = unique[i + 1] - unique[i];
    if (gap > bestGap) {
      bestGap = gap;
      bestI = i;
    }
  }
  if (bestGap < THRESHOLDS.semiMonthlyCenterGap) return null;
  const left = unique.slice(0, bestI + 1);
  const right = unique.slice(bestI + 1);
  const c1 = median(left);
  const c2 = median(right);
  const width = THRESHOLDS.semiMonthlyClusterWidth;
  if (days.every(d => Math.abs(d - c1) <= width || Math.abs(d - c2) <= width)) {
    return [c1, c2];
  }
  return null;
}

function chargesPerMonthMedian(dates) {
  const byMonth = new Map();
  for (const d of dates) {
    const month = String(d).slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + 1);
  }
  return median([...byMonth.values()]);
}

function namedCadence(name, dates, intervals, spec) {
  if (dates.length < spec.minOccurrences) return null;
  const med = median(intervals);
  if (med == null || med < spec.medianMin || med > spec.medianMax) return null;
  const share = shareInWindow(intervals, spec.intervalMin, spec.intervalMax);
  if (share < spec.minShareInWindow) return null;
  return { cadence: name, share, medianInterval: med };
}

function classifyCadence(dates) {
  const sorted = (dates || []).slice().sort();
  const n = sorted.length;
  const intervals = intervalsFor(sorted);
  if (n < 2) {
    return { cadence: 'none', confidence: 'none', medianInterval: null, intervalCv: null };
  }
  if (n === THRESHOLDS.isolatedPairMax) {
    const gap = intervals[0];
    const annual = THRESHOLDS.annual;
    const span = daysBetween(sorted[0], sorted[sorted.length - 1]);
    if (gap >= annual.intervalMin && gap <= annual.intervalMax
      && span >= annual.minSpanDays) {
      return {
        cadence: 'annual',
        confidence: 'possible',
        medianInterval: gap,
        intervalCv: 0,
      };
    }
    return {
      cadence: 'irregular',
      confidence: 'none',
      medianInterval: gap,
      intervalCv: 0,
    };
  }

  const weekly = namedCadence('weekly', sorted, intervals, THRESHOLDS.weekly);
  const biweekly = namedCadence('biweekly', sorted, intervals, THRESHOLDS.biweekly);
  const monthly = namedCadence('monthly', sorted, intervals, THRESHOLDS.monthly);
  const quarterly = namedCadence('quarterly', sorted, intervals, THRESHOLDS.quarterly);
  const annual = namedCadence('annual', sorted, intervals, {
    minOccurrences: THRESHOLDS.annual.minOccurrences,
    medianMin: THRESHOLDS.annual.medianMin,
    medianMax: THRESHOLDS.annual.medianMax,
    intervalMin: THRESHOLDS.annual.intervalMin,
    intervalMax: THRESHOLDS.annual.intervalMax,
    minShareInWindow: 0.5,
  });
  const clusters = dayClusters(sorted);
  const perMonth = chargesPerMonthMedian(sorted);
  const semiMonthly = clusters
    && n >= 4
    && perMonth != null
    && perMonth >= 1.5
    && perMonth <= 2.5;

  let chosen = null;
  if (weekly) chosen = weekly;
  else if (semiMonthly && biweekly) {
    chosen = { cadence: 'semi-monthly', share: biweekly.share, medianInterval: biweekly.medianInterval };
  } else if (biweekly) chosen = biweekly;
  else if (semiMonthly) {
    chosen = { cadence: 'semi-monthly', share: 1, medianInterval: median(intervals) };
  } else if (monthly) chosen = monthly;
  else if (quarterly) chosen = quarterly;
  else if (annual) {
    const span = daysBetween(sorted[0], sorted[sorted.length - 1]);
    if (span >= THRESHOLDS.annual.minSpanDays) chosen = annual;
  }

  if (!chosen) {
    const cv = coeffVar(intervals);
    const med = median(intervals);
    if (n >= THRESHOLDS.otherRegular.minOccurrences
      && cv != null && cv <= THRESHOLDS.otherRegular.maxCv
      && med != null && med >= THRESHOLDS.otherRegular.minMedian) {
      chosen = { cadence: 'other-regular', share: 1, medianInterval: med };
    }
  }

  if (!chosen) {
    return {
      cadence: 'irregular',
      confidence: 'none',
      medianInterval: median(intervals),
      intervalCv: coeffVar(intervals),
    };
  }

  const confidence = chosen.share >= 0.8 && n >= (chosen.cadence === 'annual' ? 2 : 3)
    ? 'strong'
    : 'possible';
  return {
    cadence: chosen.cadence,
    confidence,
    medianInterval: chosen.medianInterval,
    intervalCv: coeffVar(intervals),
  };
}

function classifyAmountPattern(amounts, cadence) {
  const list = (amounts || []).map(round2);
  if (!list.length) return { amountPattern: 'unknown', amountMedian: null, amountMin: null, amountMax: null };
  const min = Math.min(...list);
  const max = Math.max(...list);
  const med = median(list);
  const span = max - min;
  const near = span <= THRESHOLDS.nearFixedAbs
    || (med != null && span <= Math.abs(med) * THRESHOLDS.nearFixedRel);
  let amountPattern;
  if (cadence && cadence !== 'none' && cadence !== 'irregular') {
    amountPattern = near ? (span === 0 ? 'fixed' : 'near-fixed') : 'variable';
  } else {
    amountPattern = 'irregular-repeat';
  }
  return {
    amountPattern,
    amountMedian: med,
    amountMin: min,
    amountMax: max,
  };
}

function recurringBills(plan) {
  return ((plan && plan.bills) || []).filter(bill =>
    bill && bill.id && bill.frequency && bill.frequency !== 'once');
}

function billOverlapKeys(bill) {
  const keys = new Set();
  const compactId = compactMerchantKey(String(bill.id).replace(/-/g, ' '));
  if (compactId.length >= 5) keys.add(compactId);
  const labelCompact = compactMerchantKey(bill.label || '');
  if (labelCompact.length >= 5) keys.add(labelCompact);
  const tokens = normalizeMerchantKey(bill.label || '').split(' ').filter(Boolean);
  for (const token of tokens) {
    if (GENERIC_BILL_TOKENS.has(token)) continue;
    if (token.length >= 4) keys.add(token);
  }
  return [...keys].filter(Boolean);
}

function merchantOverlapsBillText(merchantKey, merchantLabel, bill) {
  const compact = compactMerchantKey(merchantKey || merchantLabel);
  const labelCompact = compactMerchantKey(merchantLabel);
  if (!compact && !labelCompact) return false;
  for (const key of billOverlapKeys(bill)) {
    if (!key || key.length <= 3) continue;
    if (compact === key || labelCompact === key) return true;
    if (key.length >= 5 && (compact.includes(key) || labelCompact.includes(key))) return true;
  }
  return false;
}

function chargeAsRepresentedInput(charge, plan, identity) {
  const cardId = charge && charge.cardId != null ? String(charge.cardId) : '';
  if (!charge || !cardId || !charge.date) return null;
  const asOf = charge.asOf;
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)
      || !Number.isFinite(Date.parse(asOf + 'T00:00:00Z'))
      || new Date(asOf + 'T00:00:00Z').toISOString().slice(0, 10) !== asOf
      || charge.date > asOf || charge.currency !== 'cad'
      || charge.pending !== false || charge.savingsPostingEvidence !== 'posted') return null;
  const providerAccountId = `atlas-audit-account:${cardId}`;
  const payee = charge.payee || charge.merchantLabel || null;
  const original = charge.originalName || charge.originalMerchant || charge.merchantLabel || null;
  return {
    plan: plan || {},
    asOf,
    identityRules: identityRules(identity),
    accountMap: {
      mappings: [{
        providerAccountId,
        atlasRole: 'revolving-credit',
        canonical: { collection: 'debts', id: cardId },
      }],
    },
    transactions: [{
      providerTransactionId: charge.providerTransactionId || `atlas-audit-tx:${cardId}:${charge.date}`,
      providerAccountId,
      date: charge.date,
      amount: Number(charge.amount),
      currency: charge.currency,
      savingsPostingEvidence: charge.savingsPostingEvidence,
      payee,
      displayedPayee: payee,
      originalName: original,
      original_name: original,
      originalMerchant: original,
      pending: charge.pending,
    }],
    transactionWindow: { complete: true },
  };
}

function identityProvesBill(charge, bill, plan, identity) {
  if (!charge || !bill || !bill.id) return null;
  const input = chargeAsRepresentedInput(charge, plan, identity);
  if (!input || !input.identityRules.length) return null;
  const receiptId = input.transactions[0].providerTransactionId;
  const proven = (Provider.representedEventCandidates(input) || [])
    .find(hit => hit && hit.id === bill.id && (hit.providerTransactionId === receiptId
      || hit.providerTransactionIds?.includes(receiptId)));
  if (!proven) return null;
  return {
    id: bill.id,
    label: bill.label,
    frequency: bill.frequency,
    identity: proven.identity || 'payee+account+date',
  };
}

function identityPayeeOverlapsBill(charge, bill, identity) {
  const tx = chargeAsIdentityTx(charge);
  const payeeFields = [tx.payee, tx.displayedPayee, tx.originalName, tx.originalMerchant];
  for (const rule of identityRules(identity)) {
    if (rule.eventId !== bill.id) continue;
    const patterns = [].concat(rule.payeePatterns || [],
      rule.payeePattern ? [rule.payeePattern] : []);
    if (patterns.some(pattern => payeeFields.some(value =>
      value && String(value).toLowerCase().includes(String(pattern).toLowerCase())))) {
      return true;
    }
  }
  return false;
}

function matchKnownBills(charge, plan, identity) {
  const hits = [];
  for (const bill of recurringBills(plan)) {
    const proven = identityProvesBill(charge, bill, plan, identity);
    if (proven) hits.push(proven);
  }
  hits.sort((a, b) => a.id.localeCompare(b.id));
  return hits;
}

function overlappingPlannedBills(charge, plan, identity) {
  const merchantKey = charge && charge.merchantKey;
  const merchantLabel = charge && charge.merchantLabel;
  const hits = [];
  const seen = new Set();
  for (const bill of recurringBills(plan)) {
    if (identityProvesBill(charge, bill, plan, identity)) continue;
    const overlap = merchantOverlapsBillText(merchantKey, merchantLabel, bill)
      || identityPayeeOverlapsBill(charge, bill, identity);
    if (!overlap || seen.has(bill.id)) continue;
    seen.add(bill.id);
    hits.push({ id: bill.id, label: bill.label, frequency: bill.frequency });
  }
  hits.sort((a, b) => a.id.localeCompare(b.id));
  return hits;
}

function standingRuleFor(charge) {
  if (charge.amazonMerchant && isTravelVisaId(charge.cardId)) {
    return {
      id: 'amanda-amazon-travelvisa',
      summary: 'Amazon + canonical Travel Visa → Amanda guilt-free spending',
    };
  }
  if (isDaleCursorLabel(charge.merchantLabel)) {
    return {
      id: 'dale-guilt-free-cursor',
      summary: 'Cursor → Dale guilt-free spending',
    };
  }
  return null;
}

function groupCharges(charges) {
  const groups = new Map();
  for (const charge of charges) {
    const key = `${charge.cardId}|${charge.merchantKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(charge);
  }
  return groups;
}

function whyItMatters(row) {
  if (row.atlasStatus === 'known-planned') {
    return `Already represented as ${row.matchedBills.map(b => b.id).join(', ')}.`;
  }
  if (row.atlasStatus === 'merchant-overlaps-planned-bill') {
    const ids = (row.overlappingBills || []).map(b => b.id).join(', ');
    return `Merchant text overlaps ${ids || 'a planned bill'}, but incumbent identity does not prove this card occurrence is that bill.`;
  }
  if (row.amazonPrimeLike && row.atlasStatus === 'candidate-unplanned') {
    return 'Prime-style fixed sequence on a card; not promoted to a bill.';
  }
  if (row.amazonMerchant && !row.amazonPrimeLike) {
    return 'Amazon shopping repeats; standing Travel Visa rule is Amanda guilt-free only.';
  }
  if (row.atlasStatus === 'candidate-unplanned') {
    return 'Repeated card charge is not in plan.bills.';
  }
  if (row.atlasStatus === 'repeating-not-bill') {
    return 'Merchant repeats without enough cadence evidence of a bill.';
  }
  return 'Review whether this is a household cost Atlas should plan.';
}

function classifyGroup(charges, plan, identity) {
  const ordered = (charges || []).slice().sort((a, b) =>
    a.date.localeCompare(b.date) || a.amount - b.amount);
  const sample = ordered[ordered.length - 1];
  const dates = ordered.map(c => c.date);
  const amounts = ordered.map(c => c.amount);
  const cadence = classifyCadence(dates);
  const amount = classifyAmountPattern(amounts, cadence.cadence);
  const matchedBills = matchKnownBills(sample, plan, identity);
  const overlappingBills = matchedBills.length
    ? []
    : overlappingPlannedBills(sample, plan, identity);
  const amazonMerchant = ordered.every(c => c.amazonMerchant) || sample.amazonMerchant;
  const amazonPrimeLike = ordered.some(c => c.amazonPrimeLike);
  const amazonShopping = amazonMerchant && !amazonPrimeLike;
  const hasCadence = cadence.cadence !== 'none' && cadence.cadence !== 'irregular';
  let atlasStatus;
  if (matchedBills.length) {
    atlasStatus = 'known-planned';
  } else if (overlappingBills.length) {
    atlasStatus = 'merchant-overlaps-planned-bill';
  } else if (amazonShopping) {
    atlasStatus = 'repeating-not-bill';
  } else if (hasCadence && ordered.length >= (cadence.cadence === 'annual' ? 2 : 3)) {
    atlasStatus = 'candidate-unplanned';
  } else {
    atlasStatus = 'repeating-not-bill';
  }
  const reviewWarranted = atlasStatus === 'candidate-unplanned'
    || atlasStatus === 'merchant-overlaps-planned-bill'
    || (amazonPrimeLike && atlasStatus !== 'known-planned');
  const rules = ordered.map(standingRuleFor).filter(Boolean);
  const standingRule = rules[0] || null;
  const last = ordered[ordered.length - 1];
  return {
    merchantKey: sample.merchantKey,
    merchantLabel: sample.merchantLabel,
    cardId: sample.cardId,
    cardLabel: sample.cardLabel,
    occurrenceCount: ordered.length,
    dates: dates.slice(),
    amounts: amounts.map(round2),
    recentAmounts: amounts.slice(-3).map(round2),
    lastDate: last.date,
    lastAmount: round2(last.amount),
    cadence: cadence.cadence,
    cadenceConfidence: cadence.confidence,
    medianIntervalDays: cadence.medianInterval == null ? null : round2(cadence.medianInterval),
    amountPattern: amount.amountPattern,
    amountMedian: amount.amountMedian == null ? null : round2(amount.amountMedian),
    amountMin: amount.amountMin,
    amountMax: amount.amountMax,
    atlasStatus,
    matchedBills,
    overlappingBills,
    standingRule,
    amazonMerchant,
    amazonPrimeLike,
    reviewWarranted,
  };
}

function sectionFor(row) {
  if (row.atlasStatus === 'known-planned') return 'known';
  if (row.atlasStatus === 'merchant-overlaps-planned-bill') {
    return row.cadenceConfidence === 'strong' ? 'strong' : 'possible';
  }
  if (row.atlasStatus === 'candidate-unplanned' && row.cadenceConfidence === 'strong') {
    return 'strong';
  }
  if (row.atlasStatus === 'candidate-unplanned') return 'possible';
  return 'repeatingNotBill';
}

function investigatePhoenix(charges, plan, identity) {
  const hits = charges.filter(c =>
    /PHOENIX/.test(c.merchantKey) || /PHOENIX/.test(c.merchantLabel));
  if (!hits.length) {
    return {
      found: false,
      merchantLabel: null,
      cards: [],
      occurrenceCount: 0,
      dates: [],
      amounts: [],
      around179Count: 0,
      cadence: 'none',
      supportsMonthly: false,
      alreadyPlanned: false,
      evidenceStatus: 'NO MATCHING CARD CHARGE FOUND',
      note: 'No card charge whose normalized merchant identity contains PHOENIX.',
    };
  }
  const groups = [...groupCharges(hits).values()].map(g => classifyGroup(g, plan, identity));
  groups.sort((a, b) => b.occurrenceCount - a.occurrenceCount || a.cardId.localeCompare(b.cardId));
  const around179 = hits.filter(c => Math.abs(c.amount - 179) <= 15);
  const primary = groups[0];
  const supportsMonthly = groups.some(g => g.cadence === 'monthly');
  const alreadyPlanned = groups.some(g => g.atlasStatus === 'known-planned');
  let evidenceStatus;
  if (hits.length === 1) evidenceStatus = 'SINGLE OCCURRENCE — NOT ENOUGH TO CALL RECURRING';
  else if (supportsMonthly) evidenceStatus = 'MULTIPLE OCCURRENCES — MONTHLY CADENCE SUPPORTED';
  else evidenceStatus = 'MULTIPLE OCCURRENCES — MONTHLY CADENCE NOT SUPPORTED';
  return {
    found: true,
    merchantLabel: primary.merchantLabel,
    merchantKey: primary.merchantKey,
    cards: [...new Set(hits.map(c => c.cardId))].sort(),
    occurrenceCount: hits.length,
    dates: hits.map(c => c.date).sort(),
    amounts: hits.map(c => c.amount),
    around179Count: around179.length,
    cadence: primary.cadence,
    cadenceConfidence: primary.cadenceConfidence,
    supportsMonthly,
    alreadyPlanned,
    atlasStatus: primary.atlasStatus,
    evidenceStatus,
    groups,
    note: hits.length === 1
      ? 'Only one Phoenix card occurrence is in the audited window.'
      : 'Phoenix findings are evidence only and are not promoted into plan.bills.',
  };
}

function amazonAnalysis(charges, plan, identity) {
  const amazon = charges.filter(c => c.amazonMerchant);
  const byCardMap = new Map();
  for (const charge of amazon) {
    if (!byCardMap.has(charge.cardId)) {
      byCardMap.set(charge.cardId, []);
    }
    byCardMap.get(charge.cardId).push(charge);
  }
  const byCard = [...byCardMap.entries()].map(([cardId, list]) => {
    const classified = classifyGroup(list, plan, identity);
    const standing = list.map(standingRuleFor).filter(Boolean)[0] || null;
    return {
      cardId,
      cardLabel: list[0].cardLabel,
      occurrenceCount: list.length,
      dates: list.map(c => c.date),
      amounts: list.map(c => c.amount),
      cadence: classified.cadence,
      cadenceConfidence: classified.cadenceConfidence,
      amountPattern: classified.amountPattern,
      looksLikeShopping: classified.cadence === 'irregular' || classified.cadence === 'none'
        || classified.amountPattern === 'variable'
        || classified.amountPattern === 'irregular-repeat',
      standingRule: standing,
      atlasStatus: 'repeating-not-bill',
    };
  }).sort((a, b) => a.cardId.localeCompare(b.cardId));

  const primeCharges = amazon.filter(c => c.amazonPrimeLike);
  const primeGroups = [...groupCharges(primeCharges).values()].map(g => classifyGroup(g, plan, identity));
  primeGroups.sort((a, b) => a.cardId.localeCompare(b.cardId) || a.merchantKey.localeCompare(b.merchantKey));

  return {
    standingRule: {
      id: 'amanda-amazon-travelvisa',
      summary: 'Amazon + canonical Travel Visa → Amanda guilt-free spending',
      notGeneralized: [
        'Amazon on MBNA is not Amanda guilt-free by this rule',
        'Every Amazon charge is not Amanda',
        'Prime is not automatically a bill',
        'Amazon merchant recurrence is not automatically a subscription',
      ],
    },
    totalOccurrences: amazon.length,
    byCard,
    primeLike: primeGroups,
  };
}

function assertNoRawLeak(value, label) {
  const blob = JSON.stringify(value);
  if (RAW_LEAK_RE.test(blob)) {
    fail(`${label} leaked raw provider or transaction metadata.`);
  }
}

function auditFromCharges(charges, options) {
  const opts = options || {};
  const plan = opts.plan || {};
  const identity = resolveIdentity(opts.identity);
  const asOf = opts.asOf || null;
  const source = opts.source || 'charges';
  const ordered = (charges || []).map(charge => ({ ...charge, asOf: opts.asOf ?? charge.asOf ?? null })).sort((a, b) =>
    String(a.date).localeCompare(String(b.date))
    || String(a.cardId).localeCompare(String(b.cardId))
    || String(a.merchantKey).localeCompare(String(b.merchantKey))
    || Number(a.amount) - Number(b.amount)
    || String(a.merchantLabel).localeCompare(String(b.merchantLabel)));
  const groups = [...groupCharges(ordered).values()]
    .map(g => classifyGroup(g, plan, identity))
    .sort((a, b) => a.cardId.localeCompare(b.cardId) || a.merchantKey.localeCompare(b.merchantKey));
  for (const row of groups) {
    row.why = whyItMatters(row);
  }
  const sections = {
    strong: groups.filter(g => sectionFor(g) === 'strong'),
    possible: groups.filter(g => sectionFor(g) === 'possible'),
    known: groups.filter(g => sectionFor(g) === 'known'),
    repeatingNotBill: groups.filter(g => sectionFor(g) === 'repeatingNotBill'),
  };
  const report = {
    schema: SCHEMA,
    writesCanonicalState: false,
    source,
    synthetic: source !== 'live',
    asOf,
    coverage: {
      start: opts.coverageStart || (ordered[0] && ordered[0].date) || null,
      end: opts.coverageEnd || (ordered.length ? ordered[ordered.length - 1].date : null),
      postedCharges: ordered.length,
      cards: opts.cards || [...new Map(ordered.map(c => [c.cardId, {
        cardId: c.cardId,
        cardLabel: c.cardLabel,
      }])).values()],
    },
    skipped: opts.skipped || {},
    candidates: groups,
    sections,
    phoenix: investigatePhoenix(ordered, plan, identity),
    amazon: amazonAnalysis(ordered, plan, identity),
  };
  assertNoRawLeak(report, 'audit report');
  return report;
}

function auditObservation(options) {
  const extracted = chargesFromNormalized(options);
  return auditFromCharges(extracted.charges, {
    plan: options.data && options.data.plan,
    identity: options.identity,
    asOf: options.asOf || null,
    source: options.source || 'observation',
    coverageStart: extracted.coverageStart,
    coverageEnd: extracted.coverageEnd,
    cards: extracted.cards,
    skipped: extracted.skipped,
  });
}

function money(n) {
  const v = round2(n);
  return (v < 0 ? '-' : '') + Math.abs(v).toFixed(2);
}

function formatCandidate(row) {
  const amounts = row.recentAmounts.map(money).join(', ');
  const standing = row.standingRule ? row.standingRule.id : 'none';
  const matched = row.matchedBills.length
    ? row.matchedBills.map(b => b.id).join(', ')
    : 'none';
  const overlap = (row.overlappingBills || []).length
    ? row.overlappingBills.map(b => b.id).join(', ')
    : 'none';
  return [
    `Merchant     ${row.merchantLabel}`,
    `Card         ${row.cardLabel} (${row.cardId})`,
    `Occurrences  ${row.occurrenceCount}  last ${row.lastDate} ${money(row.lastAmount)}`,
    `Recent amts  ${amounts}`,
    `Cadence      ${row.cadence} (${row.cadenceConfidence})  median ${row.medianIntervalDays == null ? 'n/a' : row.medianIntervalDays + 'd'}`,
    `Amount       ${row.amountPattern}  median ${row.amountMedian == null ? 'n/a' : money(row.amountMedian)}`,
    `Atlas status ${row.atlasStatus}  known bill ${matched}  overlap ${overlap}  standing rule ${standing}`,
    `Why          ${row.why}`,
  ].join('\n');
}

function formatSection(title, rows) {
  const lines = [`${title}` , '='.repeat(title.length)];
  if (!rows.length) {
    lines.push('(none)');
    return lines.join('\n');
  }
  return lines.concat(rows.map(formatCandidate).join('\n\n')).join('\n');
}

function formatReport(report) {
  const lines = [];
  lines.push('ATLAS RECURRING CARD-CHARGE AUDIT');
  lines.push('Read-only discovery. Forecast remains the planner. No bill promotion.');
  if (report.synthetic) {
    lines.push('SOURCE IS NOT LIVE HOUSEHOLD EVIDENCE unless independently provided.');
  }
  lines.push(`schema ${report.schema}  writesCanonicalState ${report.writesCanonicalState}`);
  lines.push(`asOf ${report.asOf || 'n/a'}  charges ${report.coverage.postedCharges}`
    + `  ${report.coverage.start || '?'} .. ${report.coverage.end || '?'}`);
  const cards = (report.coverage.cards || []).map(c => `${c.cardId}`).join(', ') || 'none';
  lines.push(`cards ${cards}`);
  lines.push('');
  lines.push(formatSection('RECURRING / STRONG CANDIDATES', report.sections.strong));
  lines.push('');
  lines.push(formatSection('POSSIBLE / NEEDS MORE EVIDENCE', report.sections.possible));
  lines.push('');
  lines.push(formatSection('KNOWN / ALREADY PLANNED', report.sections.known));
  lines.push('');
  lines.push(formatSection('REPEATING BUT NOT A RECURRING BILL', report.sections.repeatingNotBill));
  lines.push('');
  lines.push('PHOENIX INVESTIGATION');
  lines.push('=====================');
  const p = report.phoenix;
  if (!p.found) {
    lines.push(p.evidenceStatus);
    lines.push(p.note);
  } else {
    lines.push(`Merchant     ${p.merchantLabel}`);
    lines.push(`Cards        ${p.cards.join(', ')}`);
    lines.push(`Occurrences  ${p.occurrenceCount}  dates ${p.dates.join(', ')}`);
    lines.push(`Amounts      ${p.amounts.map(money).join(', ')}`);
    lines.push(`~$179 hits   ${p.around179Count}`);
    lines.push(`Cadence      ${p.cadence} (${p.cadenceConfidence || 'n/a'})`);
    lines.push(`Monthly?     ${p.supportsMonthly ? 'YES — evidence supports monthly' : 'NO — evidence does not support monthly'}`);
    lines.push(`Planned?     ${p.alreadyPlanned ? 'YES — already in plan.bills' : 'NO — not promoted, not in plan.bills as this merchant'}`);
    lines.push(`Status       ${p.evidenceStatus}`);
    lines.push(p.note);
  }
  lines.push('');
  lines.push('AMAZON ANALYSIS');
  lines.push('===============');
  lines.push(report.amazon.standingRule.summary);
  lines.push('Not generalized: ' + report.amazon.standingRule.notGeneralized.join('; '));
  lines.push(`Amazon charges: ${report.amazon.totalOccurrences}`);
  if (!report.amazon.byCard.length) {
    lines.push('No Amazon card charges in the audited window.');
  } else {
    for (const row of report.amazon.byCard) {
      const standing = row.standingRule ? row.standingRule.id : 'none';
      lines.push(`  ${row.cardLabel} (${row.cardId}): ${row.occurrenceCount}x`
        + ` cadence ${row.cadence} amounts ${row.amountPattern}`
        + ` shopping=${row.looksLikeShopping ? 'yes' : 'no'}`
        + ` standing=${standing}`);
      lines.push(`    dates ${row.dates.join(', ')}`);
      lines.push(`    amounts ${row.amounts.map(money).join(', ')}`);
    }
  }
  if (report.amazon.primeLike.length) {
    lines.push('Prime-like recurring candidates (not promoted to bills):');
    for (const row of report.amazon.primeLike) {
      lines.push(`  ${row.merchantLabel} on ${row.cardId}: ${row.occurrenceCount}x`
        + ` ${row.cadence} ${row.amountPattern} status ${row.atlasStatus}`);
    }
  } else {
    lines.push('No Prime-like fixed recurring candidate in this window.');
  }
  lines.push('');
  lines.push('This audit does not modify plan.bills, obligations, commitments,');
  lines.push('income, budget targets, merchant ownership policy, or subscription facts.');
  return lines.join('\n') + '\n';
}

function resolveOutPath(outPath) {
  if (!outPath) return null;
  const resolved = path.resolve(outPath);
  const derivedRoot = path.resolve(path.join(ROOT, 'derived')) + path.sep;
  if (resolved !== path.resolve(path.join(ROOT, 'derived'))
    && !resolved.startsWith(derivedRoot)) {
    fail('--out may only write under derived/ (gitignored).');
  }
  return resolved;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveFixtureMap(args) {
  if (args.map) return loadJson(args.map);
  return loadJson(Provider.FIXTURE_MAP);
}

async function runLive(args, data) {
  const credential = await Provider.resolveLiveCredential();
  const fetchedAt = new Date().toISOString();
  const payload = await Provider.fetchLunchMoneyLive(
    credential.token,
    fetchedAt,
    args.historyDays
  );
  const accountMap = Provider.loadLiveAccountMap(process.env, data);
  return auditObservation({
    payload,
    fetchedAt,
    accountMap,
    data,
    asOf: Forecast.financialDate(fetchedAt),
    source: 'live',
  });
}

function runFixture(args, data) {
  const payload = loadJson(args.fixture);
  const accountMap = resolveFixtureMap(args);
  const fetchedAt = payload.fetchedAt || '2026-09-03T00:00:00.000Z';
  return auditObservation({
    payload,
    fetchedAt,
    accountMap,
    data,
    asOf: Forecast.financialDate(fetchedAt) || '2026-09-03',
    source: 'fixture',
  });
}

async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  const data = loadJson(args.data);
  const before = fs.readFileSync(args.data);
  const report = args.live ? await runLive(args, data) : runFixture(args, data);
  const after = fs.readFileSync(args.data);
  if (!before.equals(after)) fail('Audit mutated data.json.');
  report.writesCanonicalState = false;
  const text = args.json ? JSON.stringify(report, null, 2) + '\n' : formatReport(report);
  assertNoRawLeak(text, 'printed audit');
  const outPath = resolveOutPath(args.out);
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

const api = {
  SCHEMA,
  THRESHOLDS,
  DEFAULT_HISTORY_DAYS,
  parseArgs,
  usage,
  normalizeMerchantKey,
  compactMerchantKey,
  sanitizeMerchantLabel,
  isAmazonMerchantLabel,
  isAmazonPrimeLikeLabel,
  isTravelVisaId,
  merchantFamilyKey,
  merchantFromPayee,
  chargesFromNormalized,
  classifyCadence,
  classifyAmountPattern,
  matchKnownBills,
  overlappingPlannedBills,
  standingRuleFor,
  auditFromCharges,
  auditObservation,
  formatReport,
  resolveOutPath,
  run,
};

if (require.main === module) {
  run(process.argv.slice(2)).then(code => {
    process.exit(code);
  }).catch(error => {
    process.stderr.write(`${error && error.message ? error.message : 'recurring audit failed'}\n`);
    process.exit(1);
  });
} else {
  module.exports = api;
}
