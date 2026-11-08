'use strict';

// Build the generated spending / interest / fee history consumed by Forecast.
//
// Normal operation (owner-approved feed):
//   node scripts/periods.js <project-root> [asOf YYYY-MM-DD]
//
// Explicit file-evidence fallback:
//   node scripts/periods.js <project-root> [asOf YYYY-MM-DD] --source local
//
// Lunch Money is evidence, not a planner. This adapter turns its cleaned,
// posted transaction history into the incumbent Atlas period event shape. It
// never writes canonical data.json and never publishes provider ids, payees, or
// raw transactions. public/periods.json remains the sole spending-history
// authority and Forecast remains the calculation authority.

const fs = require('fs');
const path = require('path');
const Forecast = require(path.join(__dirname, '..', 'public', 'forecast.js'));
const Provider = require('./provider-observe.js');

const DEFAULT_HISTORY_DAYS = 650;
const PAYPAL = /^PAYPAL/i;
const PAYMENT_LABELS = new Set([
  'payment',
  'payment, transfer',
  'transfer',
  'credit card payment',
  'credit card',
  'personal loan payment',
  'mortgage',
]);

const LUNCH_MONEY_CATEGORY_MAP = new Map();
function mapLabels(labels, category, type) {
  for (const label of labels) {
    LUNCH_MONEY_CATEGORY_MAP.set(normalizeLabel(label), { category, type });
  }
}

// Provider category names are evidence labels. This is the narrow adapter into
// the existing Atlas categories public/periods.json already publishes. Travel
// stays separate from ordinary Fuel & transport so the owner target that
// excludes tournament travel is not silently widened.
mapLabels(['Groceries', 'Superstores'], 'Groceries', 'essential');
mapLabels(['Fuel', 'Transportation', 'Ridesharing'], 'Fuel & transport', 'essential');
mapLabels(['Shopping', 'Online Purchases'], 'Shopping', 'discretionary');
mapLabels(['Personal Care'], 'Health', 'discretionary');
mapLabels(
  ['Gas and electricity', 'Natural Gas', 'Electricity', 'Sewage and waste management'],
  'Household', 'essential'
);
mapLabels(['Insurance'], 'Insurance', 'essential');
mapLabels(
  ['Restaurants', 'Fast Food', 'Food Delivery', 'Food and drink', 'Coffee Shops'],
  'Restaurants', 'discretionary'
);
mapLabels(['Lodging', 'Travel', 'Other travel'], 'Travel', 'discretionary');
mapLabels(['Kids Sports'], 'Sport & fitness', 'discretionary');
mapLabels(
  ['Alcohol, Bars', 'Sporting events amusement parks and museums', 'Tv and movies',
    'Video games', 'Other entertainment'],
  'Entertainment', 'discretionary'
);
mapLabels(['Telephone', 'Phone', 'Internet and cable'], 'Telecom', 'essential');
mapLabels(['AI'], 'Subscriptions', 'discretionary');
// Lunch Money Pets / Pet supplies is not mapped. GET-only validation showed
// that category is materially misclassified (debt payments and unrelated
// merchants). Do not canonize it. Recategorizing the provider is a write and
// is not authorized here; those rows stay Uncategorised or are excluded by
// the incumbent debt-payment rules.
mapLabels(['Tax payment'], 'Tax', 'essential');
mapLabels(['Childcare'], 'School & clubs', 'essential');
mapLabels(['Union Dues'], 'Union dues', 'essential');
mapLabels(['Work'], 'Business', 'business');

const FEE_CATEGORIES = new Map([
  ['other bank fees', ['Service charge', 'structural']],
  ['atm fees', ['Out-of-network ATM', 'avoidable']],
  ['overdraft fees', ['Overdraft protection', 'structural']],
  ['fees', ['Service charge', 'structural']],
  ['insufficient funds', ['NSF fee', 'avoidable']],
]);

const CARD_ID = {
  cashback: 'cashback',
  travelvisa: 'travelvisa',
  'amazon-mbna': 'mbna',
  'personal-visa': 'tdcc',
};

const CARD_NAME = {
  cashback: 'TD Cash Back Visa',
  travelvisa: 'Travel Visa',
  'amazon-mbna': 'Amazon Mastercard',
  'personal-visa': 'TD personal Visa',
};

const money = n => Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const normMerchant = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function normalizeLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const c of String(line || '')) {
    if (c === '"') { quoted = !quoted; continue; }
    if (c === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function readCsv(file) {
  if (!file || !fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  const head = splitCsv(lines.shift());
  return lines.map(line => {
    const cols = splitCsv(line);
    const row = {};
    head.forEach((name, index) => { row[name.trim()] = cols[index]; });
    return row;
  });
}

function parseArgs(argv) {
  const args = { root: null, asOf: null, source: 'lunchmoney', historyDays: DEFAULT_HISTORY_DAYS };
  const positional = [];
  for (let i = 0; i < (argv || []).length; i++) {
    const value = argv[i];
    if (value === '--source') args.source = argv[++i];
    else if (value === '--history-days') args.historyDays = Number(argv[++i]);
    else if (value === '--help' || value === '-h') args.help = true;
    else if (String(value).startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  args.root = positional[0] || path.join(__dirname, '..');
  args.asOf = positional[1] || null;
  if (!['lunchmoney', 'local'].includes(args.source)) {
    throw new Error('Source must be lunchmoney or local.');
  }
  if (!Number.isFinite(args.historyDays) || args.historyDays < 1) {
    throw new Error('--history-days must be a positive number.');
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/periods.js <project-root> [asOf YYYY-MM-DD]',
    '       node scripts/periods.js <project-root> [asOf YYYY-MM-DD] --source local',
    '',
    'Default: read cleaned, posted Lunch Money history through the GET-only seam.',
    'The local source is the explicit file-evidence fallback.',
  ].join('\n') + '\n';
}

function merchantLibrary(root) {
  const local = path.join(root, 'docs', 'merchant-library.csv');
  const file = fs.existsSync(local)
    ? local
    : path.join(__dirname, '..', 'docs', 'merchant-library.csv');
  return readCsv(file).map(row => ({
    pattern: row.pattern,
    category: row.category,
    type: row.type,
  }));
}

function merchantClassifier(root) {
  const library = merchantLibrary(root);
  return description => {
    const normalized = normMerchant(description);
    for (const row of library) {
      if (row.pattern && normalized.includes(row.pattern)) {
        return [row.category, row.type];
      }
    }
    return ['Uncategorised', 'unknown'];
  };
}

const INTERNAL = /TFR-(TO|FR)|SEND E-TFR|E-TRANSFER|E-TFR|ATM DEP|CASH WITHDRA|ATM W\/D|PTS FRM|EMS (FR|TO)|CANCEL|TD WATERHOUSE/i;
const DEBT = /TD MORTGAGE|CAN TIRE MC|MBNA M\/C|AFFIRM|FLEXITI|PYT TO|PAYMENT TO|TO:TD C\/C/i;
const CHEQUE = /^CHQ#/i;
const INTEREST_RULES = [
  [/OVERDRAFT INTEREST/i, 'Overdraft interest'],
  [/^INTEREST$|RETAIL ?INTEREST|CASH ?INTEREST|INTEREST CHARGE/i, 'Interest'],
];
const LOCAL_FEE_RULES = [
  [/NSF/i, 'NSF fee', 'avoidable'],
  [/OVERDRAFT|O\.?D\.?P\.? FEE/i, 'Overdraft protection', 'structural'],
  [/MONTHLY ACCOUNT FEE/i, 'Monthly account fee', 'structural'],
  [/CHQ RETURN FEE/i, 'Cheque return fee', 'avoidable'],
  [/SEND E-TFR FEE|E-TFR FEE/i, 'E-transfer fee', 'structural'],
  [/PAYMENT COVERAGE FEE/i, 'Payment coverage fee', 'avoidable'],
  [/WITHDRAWAL FEE|NON-TD ATM/i, 'Out-of-network ATM', 'avoidable'],
  [/FX ATM W\/D FEE/i, 'Foreign ATM fee', 'avoidable'],
  [/OVERLIMIT/i, 'Over-limit fee', 'avoidable'],
  [/SERVICE CHARGE/i, 'Service charge', 'structural'],
];

function localInterestKind(description, account) {
  for (const [rule, label] of INTEREST_RULES) {
    if (rule.test(description)) return label === 'Interest' ? (account || 'Interest') : label;
  }
  return null;
}

function localFeeKind(description) {
  for (const [rule, label, type] of LOCAL_FEE_RULES) {
    if (rule.test(description)) return [label, type];
  }
  return null;
}

function buildLocalEvents(root) {
  const rawDir = path.join(root, 'raw');
  const derivedDir = path.join(root, 'derived');
  const classify = merchantClassifier(root);
  const events = [];
  const accounts = [
    ['chequingA_18mo.csv', 'Chequing A'],
    ['chequingB_18mo.csv', 'Chequing B'],
    ['savings_18mo.csv', 'Savings'],
    ['heloc_18mo.csv', 'HELOC'],
    [path.join('wife-td', 'debt-and-payments_18mo.csv'), 'DEBT&PAYMENTS'],
    [path.join('wife-td', 'savings-dont-touch_18mo.csv'), 'SAVINGS-DONT TOUCH'],
  ];

  for (const [relative, account] of accounts) {
    const file = path.join(rawDir, relative);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(value => value.trim())) {
      const cols = splitCsv(line);
      const date = (cols[0] || '').trim();
      const description = (cols[1] || '').trim().replace(/\s+_[A-Z]$/, '').trim();
      const withdrawal = parseFloat(cols[2]) || 0;
      if (!date || withdrawal <= 0) continue;
      const month = date.slice(0, 7);
      const interest = localInterestKind(description, account);
      if (interest) {
        events.push({ month, kind: 'interest', category: interest, type: 'structural', amount: withdrawal, source: account });
        continue;
      }
      const fee = localFeeKind(description);
      if (fee) {
        events.push({ month, kind: 'fee', category: fee[0], type: fee[1], amount: withdrawal, source: account });
        continue;
      }
      if (INTERNAL.test(description) || DEBT.test(description) || PAYPAL.test(description) || CHEQUE.test(description)) continue;
      if (account === 'HELOC') continue;
      const [category, type] = classify(description);
      events.push({ month, kind: 'spend', category, type, amount: withdrawal, source: 'chequing' });
    }
  }

  addFallbackCardEvents(events, {
    spendingRows: readCsv(path.join(derivedDir, 'card-spending.csv')),
    transactionRows: readCsv(path.join(derivedDir, 'card-transactions.csv')),
    providerStartByCard: new Map(),
  });

  return {
    events,
    metadata: {
      basis: 'local-file-evidence',
      complete: true,
      categoryClaim: 'merchant-library',
    },
  };
}

function canonicalDebtLabel(data, canonicalId) {
  const row = ((data && data.debts) || []).find(debt => debt.id === canonicalId);
  return row && row.label ? row.label : canonicalId || 'Interest';
}

function interestLabel(mapping, data) {
  const canonical = mapping && mapping.canonical;
  if (!canonical) return 'Interest';
  if (canonical.collection === 'debts') return canonicalDebtLabel(data, canonical.id);
  if (canonical.id === 'chequing-b') return 'Overdraft interest';
  return 'Interest';
}

function providerEventSource(mapping) {
  if (mapping && mapping.atlasRole === 'heloc') return 'lunchmoney-heloc';
  if (mapping && mapping.atlasRole === 'revolving-credit') return 'lunchmoney-card';
  return 'lunchmoney-cash';
}

function helocFallbackEventsFromFile(root) {
  const file = path.join(root, 'raw', 'heloc_18mo.csv');
  if (!file || !fs.existsSync(file)) return [];
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(value => value.trim())) {
    const cols = splitCsv(line);
    const date = (cols[0] || '').trim();
    const description = (cols[1] || '').trim().replace(/\s+_[A-Z]$/, '').trim();
    const withdrawal = parseFloat(cols[2]) || 0;
    if (!date || withdrawal <= 0) continue;
    const interest = localInterestKind(description, 'HELOC');
    if (!interest) continue;
    events.push({
      month: date.slice(0, 7),
      kind: 'interest',
      category: 'HELOC',
      type: 'structural',
      amount: withdrawal,
      source: 'heloc-fallback',
    });
  }
  return events;
}

function addFallbackHelocEvents(events, options) {
  const opts = options || {};
  const providerMonths = new Set(
    (events || [])
      .filter(event => event.kind === 'interest' && event.source === 'lunchmoney-heloc')
      .map(event => event.month)
  );
  const label = opts.helocLabel || 'HELOC';
  for (const row of opts.helocFallbackEvents || []) {
    const month = row.month || (row.date && String(row.date).slice(0, 7));
    const amount = Number(row.amount) || 0;
    if (!month || amount <= 0 || providerMonths.has(month)) continue;
    events.push({
      month,
      kind: 'interest',
      category: label,
      type: 'structural',
      amount,
      source: 'heloc-fallback',
    });
  }
}

function mappedHeloc(accountMap) {
  return ((accountMap && accountMap.mappings) || []).some(mapping => (
    mapping.atlasRole === 'heloc' || (mapping.canonical && mapping.canonical.id === 'heloc')
  ));
}

function assertHelocCoverage(accountMap, events) {
  if (!mappedHeloc(accountMap)) return;
  const helocInterest = (events || []).filter(event => (
    event.kind === 'interest'
    && (event.source === 'lunchmoney-heloc' || event.source === 'heloc-fallback')
  ));
  const total = round2(helocInterest.reduce((sum, event) => sum + event.amount, 0));
  if (!helocInterest.length || total <= 0) {
    throw new Error('HELOC historical interest is missing; refusing to publish an incomplete series as complete.');
  }
}

function buildAccountCoverage(accountMap, posted) {
  const rows = [];
  for (const mapping of (accountMap && accountMap.mappings) || []) {
    if (mapping.atlasRole === Provider.EXTERNAL_LIVE_ROLE) continue;
    const txns = (posted || []).filter(transaction => (
      String(transaction.providerAccountId) === String(mapping.providerAccountId)
    ));
    const dates = txns.map(transaction => transaction.date).filter(Boolean).sort();
    rows.push({
      role: mapping.atlasRole,
      canonicalId: mapping.canonical && mapping.canonical.id || null,
      postedCount: txns.length,
      coverageStart: dates[0] || null,
      coverageThrough: dates[dates.length - 1] || null,
    });
  }
  rows.sort((left, right) => (
    String(left.role).localeCompare(String(right.role))
    || String(left.canonicalId || '').localeCompare(String(right.canonicalId || ''))
  ));
  return rows;
}

function addFallbackCardEvents(events, options) {
  const opts = options || {};
  const starts = opts.providerStartByCard || new Map();
  const accepts = (card, date) => {
    const canonical = CARD_ID[card];
    const start = canonical && starts.get(canonical);
    return !start || (date && date < start);
  };

  for (const row of opts.spendingRows || []) {
    if (!row.iso || !accepts(row.card, row.iso)) continue;
    events.push({
      month: row.iso.slice(0, 7),
      kind: 'spend',
      category: row.category || 'Uncategorised',
      type: row.type || 'unknown',
      amount: Number(row.amount) || 0,
      source: 'card-fallback',
    });
  }

  for (const row of opts.transactionRows || []) {
    if (row.kind !== 'cost' || !row.iso || !accepts(row.card, row.iso)) continue;
    const amount = Number(row.amount) || 0;
    const fee = /FEE|OVERLIMIT/i.test(row.merchant || '');
    const canonical = CARD_ID[row.card];
    events.push({
      month: row.iso.slice(0, 7),
      kind: fee ? 'fee' : 'interest',
      category: fee
        ? 'Over-limit fee'
        : (canonical && opts.data
          ? canonicalDebtLabel(opts.data, canonical)
          : (CARD_NAME[row.card] || row.card || 'Card')),
      type: fee ? 'avoidable' : 'structural',
      amount,
      source: 'card-fallback',
    });
  }
}

function buildLunchMoneyEvents(options) {
  const opts = options || {};
  const data = opts.data || {};
  const accountMap = opts.accountMap;
  Provider.assertLiveMap(accountMap, { data });
  const normalized = opts.normalized || Provider.normalizeLunchMoneyPayload(opts.payload, opts.fetchedAt);
  const window = normalized.transactionWindow || {};
  if (window.complete !== true) throw new Error('Lunch Money history window is incomplete or truncated.');
  if (!window.startDate || !window.endDate) throw new Error('Lunch Money history window has no bounded coverage dates.');

  const mappingByProviderId = new Map((accountMap.mappings || []).map(mapping => [
    String(mapping.providerAccountId), mapping,
  ]));
  const posted = (normalized.transactions || []).filter(transaction => transaction.pending !== true);
  const postedIds = new Set();
  for (const transaction of posted) {
    const id = String(transaction.providerTransactionId || '');
    if (!id) throw new Error('Lunch Money history contains a posted transaction without a stable id.');
    if (postedIds.has(id)) throw new Error('Lunch Money history contains a duplicate posted transaction id.');
    postedIds.add(id);
  }
  const providerStartByCard = new Map();
  for (const transaction of posted) {
    const mapping = mappingByProviderId.get(String(transaction.providerAccountId));
    if (!mapping) throw new Error('Lunch Money history contains an unmapped provider account.');
    if (mapping.atlasRole !== 'revolving-credit' || !transaction.date) continue;
    const id = mapping.canonical && mapping.canonical.id;
    const previous = providerStartByCard.get(id);
    if (id && (!previous || transaction.date < previous)) providerStartByCard.set(id, transaction.date);
  }

  const events = [];
  const excluded = {
    transfer: 0,
    income: 0,
    debtPayment: 0,
    paypalFunding: 0,
    householdExternal: 0,
    reversal: 0,
    helocNonInterest: 0,
  };
  let uncategorisedCount = 0;
  let uncategorisedNet = 0;
  let classifiedProviderNet = 0;
  // A posted row whose date or amount cannot be read is dropped from the
  // totals, so the period it belongs to cannot be complete. A row with a
  // readable month marks that month; a row with no readable date could
  // belong to any period and marks them all.
  const malformedByMonth = {};
  let malformedUndated = 0;

  for (const transaction of posted) {
    const dated = typeof transaction.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(transaction.date);
    const amount = transaction.amount === null || transaction.amount === undefined || transaction.amount === ''
      ? NaN
      : Number(transaction.amount);
    if (!dated || !Number.isFinite(amount)) {
      if (dated) {
        const month = transaction.date.slice(0, 7);
        malformedByMonth[month] = (malformedByMonth[month] || 0) + 1;
      } else {
        malformedUndated += 1;
      }
      continue;
    }
    if (amount === 0) continue;
    const mapping = mappingByProviderId.get(String(transaction.providerAccountId));
    if (!mapping) throw new Error('Lunch Money history contains an unmapped provider account.');
    if (mapping.atlasRole === Provider.EXTERNAL_LIVE_ROLE) {
      excluded.householdExternal += 1;
      continue;
    }

    const label = normalizeLabel(transaction.categoryLabel);
    if (transaction.isIncome === true) {
      excluded.income += 1;
      continue;
    }
    if (transaction.excludeFromTotals === true || label === 'payment, transfer' || label === 'transfer') {
      excluded.transfer += 1;
      continue;
    }
    if (PAYMENT_LABELS.has(label)) {
      excluded.debtPayment += 1;
      continue;
    }
    // The incumbent budget adds PayPal settled spending from data.paypal. A
    // provider-side PayPal pull is therefore funding/rail evidence, even when
    // it has a cleaned merchant category, and must not be counted a second time.
    if (PAYPAL.test(String(transaction.payee || ''))) {
      excluded.paypalFunding += 1;
      continue;
    }
    if (DEBT.test(String(transaction.payee || ''))) {
      excluded.debtPayment += 1;
      continue;
    }

    const month = transaction.date.slice(0, 7);
    const source = providerEventSource(mapping);
    if (label === 'interest charge') {
      if (amount < 0) { excluded.reversal += 1; continue; }
      events.push({
        month,
        kind: 'interest',
        category: interestLabel(mapping, data),
        type: 'structural',
        amount,
        source,
      });
      classifiedProviderNet += amount;
      continue;
    }
    if (mapping.atlasRole === 'heloc') {
      excluded.helocNonInterest += 1;
      continue;
    }
    if (FEE_CATEGORIES.has(label)) {
      if (amount < 0) { excluded.reversal += 1; continue; }
      const [category, type] = FEE_CATEGORIES.get(label);
      events.push({
        month,
        kind: 'fee',
        category,
        type,
        amount,
        source,
      });
      classifiedProviderNet += amount;
      continue;
    }

    const mapped = LUNCH_MONEY_CATEGORY_MAP.get(label);
    let category = mapped ? mapped.category : 'Uncategorised';
    let type = mapped ? mapped.type : 'unknown';
    // Owner-confirmed 2026-08-27: Instacart is Groceries, even when the
    // provider labels it Food Delivery / Restaurants.
    if (/INSTACART/i.test(String(transaction.payee || ''))) {
      category = 'Groceries';
      type = 'essential';
    }
    if (!mapped) {
      uncategorisedCount += 1;
      uncategorisedNet += amount;
    }
    events.push({
      month,
      kind: 'spend',
      category,
      type,
      amount,
      source,
    });
    classifiedProviderNet += amount;
  }

  addFallbackCardEvents(events, {
    spendingRows: opts.spendingRows || [],
    transactionRows: opts.transactionRows || [],
    providerStartByCard,
    data,
  });
  const helocFallbackEvents = opts.helocFallbackEvents
    || (opts.root ? helocFallbackEventsFromFile(opts.root) : []);
  addFallbackHelocEvents(events, {
    helocFallbackEvents,
    helocLabel: canonicalDebtLabel(data, 'heloc'),
  });
  assertHelocCoverage(accountMap, events);

  const providerEvents = events.filter(event => event.source.startsWith('lunchmoney-'));
  const providerEventNet = round2(providerEvents.reduce((sum, event) => sum + event.amount, 0));
  if (providerEventNet !== round2(classifiedProviderNet)) {
    throw new Error('Lunch Money event reconciliation failed.');
  }

  const accountCoverage = buildAccountCoverage(accountMap, posted);
  const fallbackHelocEvents = events.filter(event => event.source === 'heloc-fallback').length;
  const helocCoverage = accountCoverage.find(row => row.role === 'heloc' || row.canonicalId === 'heloc');
  const helocCovered = !mappedHeloc(accountMap)
    || events.some(event => event.kind === 'interest'
      && (event.source === 'lunchmoney-heloc' || event.source === 'heloc-fallback'));

  const malformedTransactions = malformedUndated
    + Object.values(malformedByMonth).reduce((sum, count) => sum + count, 0);

  return {
    events,
    metadata: {
      basis: 'lunchmoney-cleaned-history',
      complete: window.complete === true && helocCovered && malformedTransactions === 0,
      // Window and HELOC coverage alone, before malformed rows, so a period
      // without a malformed row can still be judged against the source.
      coverageComplete: window.complete === true && helocCovered,
      coverageStart: posted.map(transaction => transaction.date).filter(Boolean).sort()[0] || null,
      coverageThrough: window.endDate,
      queryWindowStart: window.startDate,
      postedTransactions: posted.length,
      providerEventNet,
      fallbackCardEvents: events.filter(event => event.source === 'card-fallback').length,
      fallbackHelocEvents,
      accountCoverage,
      helocPostedCount: helocCoverage ? helocCoverage.postedCount : 0,
      categoryClaim: uncategorisedCount || malformedTransactions ? 'incomplete' : 'precise',
      uncategorisedTransactions: uncategorisedCount,
      uncategorisedNet: round2(uncategorisedNet),
      malformedTransactions,
      malformedByMonth,
      malformedUndated,
      excluded,
    },
  };
}

function rollup(events, predicate) {
  const selected = events.filter(event => predicate(event.month));
  const fees = {};
  const interest = {};
  for (const event of selected) {
    if (event.kind === 'fee') {
      fees[event.category] = fees[event.category] || { total: 0, type: event.type };
      fees[event.category].total += event.amount;
    } else if (event.kind === 'interest') {
      interest[event.category] = interest[event.category] || { total: 0 };
      interest[event.category].total += event.amount;
    }
  }
  const rows = (source, includeType) => Object.entries(source)
    .map(([label, value]) => ({
      label,
      total: round2(value.total),
      ...(includeType ? { type: value.type } : {}),
    }))
    .sort((left, right) => right.total - left.total);
  const months = [...new Set(selected.map(event => event.month))].length || 1;
  const spendingEvents = selected.filter(event => event.kind === 'spend');
  return {
    months,
    spending: Forecast.rollupSpending(spendingEvents),
    spendingTotal: round2(spendingEvents.reduce((sum, event) => sum + event.amount, 0)),
    fees: rows(fees, true),
    feesTotal: round2(selected.filter(event => event.kind === 'fee')
      .reduce((sum, event) => sum + event.amount, 0)),
    interest: rows(interest, false),
    interestTotal: round2(selected.filter(event => event.kind === 'interest')
      .reduce((sum, event) => sum + event.amount, 0)),
  };
}

function previousMonth(asOf) {
  const date = new Date(`${asOf}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Malformed-row evidence from the Lunch Money history metadata, or null for
// a basis that does not report it (the local file fallback).
function malformedIn(metadata) {
  if (!metadata || !metadata.malformedByMonth || typeof metadata.malformedByMonth !== 'object') return null;
  return {
    byMonth: metadata.malformedByMonth,
    undated: Number(metadata.malformedUndated) || 0,
  };
}

// A period holding a dropped malformed row (or any period, for a row with no
// readable date) is incomplete; its totals are a floor, not the whole period.
function malformedClaim(malformed, test) {
  if (!malformed) return {};
  const count = malformed.undated + Object.entries(malformed.byMonth)
    .filter(([month]) => test(month))
    .reduce((sum, [, n]) => sum + n, 0);
  return count ? { complete: false, categoryClaim: 'incomplete', malformedTransactions: count } : {};
}

function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

// Whether the fetched history window covers a period's whole span. Only a
// source that reports its query window (the Lunch Money basis) can say; a
// period starting before the fetch, or ending after it, is not covered.
function periodCoverage(metadata, span) {
  if (!metadata || typeof metadata.queryWindowStart !== 'string' || typeof metadata.coverageThrough !== 'string') return {};
  if (!span) return { coverageComplete: true };
  return { coverageComplete: metadata.queryWindowStart <= span[0] && metadata.coverageThrough >= span[1] };
}

function buildPeriods(events, asOf, metadata) {
  if (!events.length) throw new Error('No period events were produced; refusing to publish zeros.');
  const thisMonth = asOf.slice(0, 7);
  const lastMonth = previousMonth(asOf);
  const year = asOf.slice(0, 4);
  const months = [...new Set(events.map(event => event.month))].filter(Boolean).sort();
  const firstCardMonth = events.filter(event =>
    event.source === 'card-fallback' || event.source === 'lunchmoney-card')
    .map(event => event.month).sort()[0] || null;
  const lastMonthEnd = monthEnd(lastMonth);
  const definitions = {
    thisMonth: { label: `This month (${thisMonth})`, test: month => month === thisMonth,
      span: [`${thisMonth}-01`, asOf] },
    lastMonth: { label: `Last month (${lastMonth})`, test: month => month === lastMonth,
      span: [`${lastMonth}-01`, lastMonthEnd < asOf ? lastMonthEnd : asOf] },
    ytd: { label: `Year to date (${year})`, test: month => month.startsWith(year),
      span: [`${year}-01-01`, asOf] },
    // "All captured" is by definition the fetched window.
    all: { label: `All captured (${months.length} months)`, test: () => true, span: null },
  };
  const out = {
    asOf,
    thisMonth,
    lastMonth,
    source: metadata || null,
    periods: {},
    monthly: [],
  };
  const malformed = malformedIn(metadata);
  for (const [id, definition] of Object.entries(definitions)) {
    out.periods[id] = {
      label: definition.label,
      ...rollup(events, definition.test),
      ...periodCoverage(metadata, definition.span),
      ...malformedClaim(malformed, definition.test),
    };
  }
  for (const month of months) {
    const selected = events.filter(event => event.month === month);
    out.monthly.push({
      ...malformedClaim(malformed, value => value === month),
      m: month,
      spending: round2(selected.filter(event => event.kind === 'spend')
        .reduce((sum, event) => sum + event.amount, 0)),
      interest: round2(selected.filter(event => event.kind === 'interest')
        .reduce((sum, event) => sum + event.amount, 0)),
      fees: round2(selected.filter(event => event.kind === 'fee')
        .reduce((sum, event) => sum + event.amount, 0)),
      cardsCovered: firstCardMonth ? month >= firstCardMonth : false,
    });
  }
  return out;
}

function writePeriods(out, root) {
  const derivedDir = path.join(root, 'derived');
  fs.mkdirSync(derivedDir, { recursive: true });
  fs.writeFileSync(path.join(derivedDir, 'periods.json'), JSON.stringify(out, null, 2));
  const publicFile = path.join(__dirname, '..', 'public', 'periods.json');
  fs.writeFileSync(publicFile, JSON.stringify(out));
  return publicFile;
}

function printSummary(out, eventCount, publicFile, root) {
  process.stdout.write(`Wrote ${publicFile}\n\n`);
  process.stdout.write(`Periods built from ${eventCount} aggregate events across ${out.monthly.length} months\n\n`);
  process.stdout.write('Period'.padEnd(30) + 'Spending'.padStart(12)
    + 'Interest'.padStart(11) + 'Fees'.padStart(10) + 'Months'.padStart(8) + '\n');
  process.stdout.write('-'.repeat(71) + '\n');
  for (const period of Object.values(out.periods)) {
    process.stdout.write(period.label.padEnd(30)
      + money(period.spendingTotal).padStart(12)
      + money(period.interestTotal).padStart(11)
      + money(period.feesTotal).padStart(10)
      + String(period.months).padStart(8) + '\n');
  }
  process.stdout.write(`\nWrote ${path.join(root, 'derived', 'periods.json')}\n`);
}

async function liveLunchMoneyEvents(root, historyDays) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const credential = await Provider.resolveLiveCredential();
  const fetchedAt = new Date().toISOString();
  const payload = await Provider.fetchLunchMoneyLive(
    credential.token,
    fetchedAt,
    historyDays
  );
  const accountMap = Provider.loadLiveAccountMap(process.env, data);
  const derivedDir = path.join(root, 'derived');
  return buildLunchMoneyEvents({
    payload,
    fetchedAt,
    accountMap,
    data,
    root,
    spendingRows: readCsv(path.join(derivedDir, 'card-spending.csv')),
    transactionRows: readCsv(path.join(derivedDir, 'card-transactions.csv')),
  });
}

async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  const asOf = args.asOf || Forecast.financialDate(new Date().toISOString());
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('asOf must be YYYY-MM-DD.');
  const built = args.source === 'local'
    ? buildLocalEvents(args.root)
    : await liveLunchMoneyEvents(args.root, args.historyDays);
  const out = buildPeriods(built.events, asOf, built.metadata);
  const publicFile = writePeriods(out, args.root);
  printSummary(out, built.events.length, publicFile, args.root);
  return 0;
}

const api = {
  DEFAULT_HISTORY_DAYS,
  LUNCH_MONEY_CATEGORY_MAP,
  PAYMENT_LABELS,
  parseArgs,
  normalizeLabel,
  readCsv,
  buildLocalEvents,
  buildLunchMoneyEvents,
  addFallbackCardEvents,
  addFallbackHelocEvents,
  helocFallbackEventsFromFile,
  assertHelocCoverage,
  buildAccountCoverage,
  buildPeriods,
  writePeriods,
  liveLunchMoneyEvents,
  run,
};

if (require.main === module) {
  run(process.argv.slice(2)).then(code => {
    process.exit(code);
  }).catch(error => {
    process.stderr.write(`${error && error.message ? error.message : 'period generation failed'}\n`);
    process.exit(1);
  });
} else {
  module.exports = api;
}
