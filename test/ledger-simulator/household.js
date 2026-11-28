'use strict';

// Dates and amounts in the economic journal are integer UTC days and cents.
// Only the provider projection leaves this module. Forecast never sees the journal.
const H = require('../acceptance/harness');
const openingCoverage = require('../fixtures/card-coverage-opening');
const epoch = Date.UTC(2026, 9, 9);
const date = (offset) => new Date(epoch + offset * 86400000).toISOString().slice(0, 10);
const offset = (day) => (Date.parse(day) - epoch) / 86400000;
const START = 1;
const labels = [
  'Groceries',
  'Restaurants',
  'Fuel',
  'Household',
  'Pets',
  'Shopping',
  'Personal',
  'Guilt-free Indigo',
  'Guilt-free Ochre',
  'Other spending',
  'Travel',
  'Entertainment',
  'Health',
  'Sport & fitness',
  'Transportation',
  'Streaming',
  'Gas',
  'Gifts',
  'Clothing',
  'Craft supplies',
  'Hobbies',
  'Natural Gas',
  'Telephone',
  'Internet',
  'Utilities',
  'Subscriptions',
  'Other bank fees',
  'Payment, Transfer',
  'Payroll',
  'Transfer',
  'Uncategorised',
  'Income',
  'Reimbursement',
  'Credit Card Payment',
  'Dining',
  'Fast Food',
  'Food Delivery',
  'Eating out',
  'Dog food',
  'Business',
  'Insurance',
  'Telecom',
  'Children',
  'Sports',
  'Health & medical',
  'Fitness',
  'Housing',
  'Home maintenance',
  'Water',
  'Electricity',
  'Internet & cable',
  'Public transit',
  'Auto maintenance',
  'Parking',
  'Coffee shops',
  'Alcohol',
  'Education',
  'Personal care',
  'Charity',
  'Interest',
  'Fees',
  'Savings',
  'Minimum payment - Invented Indigo Card',
  'Uncategorized',
  'Clothing & accessories',
];
const ids = Object.fromEntries(labels.map((label, i) => [label, 601 + i]));
const account = {
  bills: 'chequing-a',
  weekly: 'chequing-b',
  pool: 'savings',
  reserve: 'savings-dont-touch',
  studio: 'sim-studio',
  card: 'travelvisa',
  second: 'cashback',
  manual: 'mbna',
  line: 'heloc',
  pocket: 'sim-pocket',
};
const inventory = Object.keys(account);
const providerId = (key) => 67101 + inventory.indexOf(key);
// Keyed draws keep one dial from changing the sequence for any other habit.
function draw(...fields) {
  let n = 2166136261;
  for (const c of fields.join('|')) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  n ^= n >>> 16;
  n = Math.imul(n, 0x21f0aaad);
  n ^= n >>> 15;
  return n >>> 0;
}
function terms(seed) {
  return {
    pay: 183100 + (draw(seed, 'salary') % 70000),
    bill: 6311 + (draw(seed, 'bill') % 1300),
    subscription: 1237 + (draw(seed, 'sub') % 413),
    min: 3217 + (draw(seed, 'minimum') % 800),
    lineMin: 7921 + (draw(seed, 'line') % 700),
    goal: 24013 + (draw(seed, 'goal') % 2400),
  };
}
function initial(seed, key) {
  return (key === 'manual' ? 410500 : 120000 + (draw(seed, key) % 110000)) + (key === 'bills' ? 250000 : 0);
}
const anchor = (day) => 151 + (day % 17);
function monthDays(months) {
  const end = new Date(epoch);
  end.setUTCMonth(end.getUTCMonth() + months);
  return offset(end.toISOString().slice(0, 10));
}
const openingDay = 0;
function world(seed, day, events) {
  const t = terms(seed),
    asOf = date(day),
    w = H.baseWorld(asOf);
  w.income[0].amount = t.pay / 100;
  w.categories = labels.map((name) => ({
    id: ids[name],
    name,
    is_income: ['Payroll', 'Income'].includes(name),
    exclude_from_totals: ['Transfer', 'Payment, Transfer', 'Credit Card Payment'].includes(name),
  }));
  w.savingsPool = true;
  w.tags = [1, 2, 3].map((i) => ({
    id: 72100 + i,
    name: i === 3 ? 'Invented kite (old)' : 'Invented item ' + i,
  }));
  w.commitments = ['kite', 'loom'].map((id, i) => ({
    id,
    date: date(12 + i * 51),
    label: 'Invented ' + id,
    amount: t.goal / 100,
    confidence: 'confirmed',
  }));
  w.links = w.commitments.map((g, i) => ({
    tagId: 72101 + i,
    goalRef: { kind: 'commitment', id: g.id },
    occurrenceDate: g.date,
    effectiveFrom: date(0),
    effectiveThrough: date(180),
  }));
  w.bills = [
    { id: 'kiln', label: 'Invented kiln', amount: t.bill / 100, payee: 'Invented kiln' },
    {
      id: 'bell',
      label: 'Invented bell',
      amount: t.subscription / 100,
      payee: 'Invented bell',
      rule: { settlesWhen: 'schedule-trust-on-due' },
    },
  ].map((b) => ({
    ...b,
    day: 12,
    payingAccount: account.bills,
    frequency: 'monthly',
    confidence: 'confirmed',
  }));
  w.obligations = [
    ['card', t.min],
    ['line', t.lineMin],
    ['second', 1103],
  ].map(([key, cents]) => ({
    id: 'sim-' + key + '-minimum',
    label: 'Invented ' + key + ' minimum',
    debtId: account[key],
    effect: 'payment',
    frequency: 'monthly',
    day: 18,
    amount: cents / 100,
    confidence: 'confirmed',
    payingAccount: account.bills,
  }));
  w.budget.push(
    ...['Fuel', 'Household', 'Pets', 'Travel', 'Health', 'Entertainment', 'Sport & fitness'].map((label) => ({
      id: label.toLowerCase().split(' ')[0],
      label,
      from: [label],
      plannedPayday: 27.13,
      confidence: 'confirmed',
    }))
  );
  w.budget.push({
    id: 'shopping',
    label: 'Personal',
    from: ['Shopping', 'Personal'],
    plannedPayday: 41.11,
    confidence: 'confirmed',
  });
  for (const key of ['studio', 'card', 'second', 'line']) {
    const role = {
      studio: 'household-external',
      card: 'revolving-credit',
      second: 'revolving-credit',
      line: 'heloc',
      pocket: 'sim-pocket',
    }[key];
    w.accounts.push({
      id: account[key],
      role,
      collection: key === 'studio' ? 'external' : 'debts',
      label: 'Invented ' + key,
      externalId: key === 'studio' ? 'sim-studio' : undefined,
    });
  }
  const opening = Object.fromEntries(inventory.map((key) => [key, initial(seed, key)]));
  const balances = { ...opening };
  const evidence = [];
  for (let d = openingDay; d <= day; d += 14) {
    evidence.push({
      id: 310000 + d,
      when: d,
      key: 'bills',
      cents: -t.pay,
      label: 'Payroll',
      payee: 'Invented employer',
    });
    balances.bills += t.pay;
  }
  // A changing, independently priced sibling every day. Two posted charges
  // after the canonical opening also give synced cards real balance evidence.
  for (let d = 0; d <= day; d++) {
    evidence.push({
      id: 410000 + d,
      when: d,
      key: 'weekly',
      cents: anchor(d),
      label: 'Groceries',
      payee: 'Invented orchard',
    });
    balances.weekly -= anchor(d);
  }
  for (let k = 0; k <= day; k += 14)
    for (const [i, key] of ['card', 'second'].entries()) {
      evidence.push({
        id: 415000 + 2 * (k / 14) + i,
        when: k,
        key,
        cents: 211 + i,
        label: 'Groceries',
        payee: 'Invented stall',
      });
      balances[key] += 211 + i;
    }
  for (const event of events) {
    if (event.start > day) continue;
    for (const effect of event.entries) {
      if (effect.day > day) continue;
      const sign = ['card', 'second', 'manual', 'line'].includes(effect.key) ? 1 : -1;
      balances[effect.key] += sign * effect.cents;
    }
    for (const revision of event.rows) {
      if (revision.sync <= day && (revision.until == null || revision.until > day)) evidence.push(revision);
    }
  }
  w.transactions = evidence.map((r) =>
    H.lm({
      id: r.id,
      date: date(r.when),
      account: 'injected',
      providerAccountId: providerId(r.key),
      amount: r.cents / 100,
      category: ids[r.label],
      payee: r.payee || 'Invented market',
      notes: r.notes,
      pending: r.pending,
      tagIds: r.tags,
      raw: r.raw,
    })
  );
  if (evidence.some((r) => r.key === 'pocket'))
    w.accounts.push({
      id: account.pocket,
      role: 'household-cash',
      collection: 'cash',
      label: 'Invented third chequing',
    });
  w.accounts = w.accounts.map((a) => {
    const key = inventory.find((k) => account[k] === a.id);
    return {
      ...a,
      label: 'Invented ' + key + ' ' + draw(seed, key, 'label').toString(36),
      providerId: providerId(key),
      value: balances[key] / 100,
    };
  });
  w.debts = ['card', 'second', 'line', 'manual'].map((key) => ({
    id: account[key],
    label: 'Invented ' + key,
    structure: key === 'line' ? 'Interest-only revolving' : 'Revolving',
    secured: key === 'line',
    pending: 0,
    rate: 8.73,
    balance: opening[key] / 100,
    limit: 5013,
    evidenceDate: date(0),
    statementCloseDay: 14,
  }));
  w.planPatch = (plan) => {
    plan.windowDays = 29;
    plan.cardPurchaseCoverage = openingCoverage(date(0));
    plan.startingCash.breakdown = plan.startingCash.breakdown.filter((a) =>
      ['chequing-a', 'chequing-b', 'savings', account.pocket].includes(a.id)
    );
    for (const row of plan.startingCash.breakdown) {
      row.value = opening[inventory.find((k) => account[k] === row.id)] / 100;
    }
  };
  const edits = events.filter((e) => e.start <= day);
  for (const event of edits) event.configure?.(w, day);
  w.windowStart = date(day - 120);
  H.productionOpening(w);
  const data = H.canonicalOf(w, H.planOf(w)),
    payload = H.rawPayload(w);
  data.revolvingExtra = [{ id: 'invented-overdraft', cash: account.weekly, limit: 1900, pending: 0 }];
  const accountMap = H.accountMapOf(w);
  for (const m of accountMap.mappings) if (m.atlasRole === 'household-external') delete m.canonical;
  for (const a of payload.plaid_accounts) a.last_fetch = asOf + 'T17:00:00Z';
  payload.transactions = payload.transactions.filter((tx) => tx.is_pending || tx.date >= w.windowStart);
  let previousWeekly = opening.weekly;
  for (let d = 0; d < day; d++) previousWeekly -= anchor(d);
  for (const event of events)
    for (const entry of event.entries) {
      if (entry.key === 'weekly' && entry.day < day) previousWeekly -= entry.cents;
    }
  return {
    data,
    payload,
    accountMap,
    identity: H.identityOf(w),
    previousWeekly: previousWeekly / 100,
    periods: [],
  };
}
module.exports = {
  START,
  anchor,
  date,
  offset,
  labels,
  ids,
  account,
  providerId,
  world,
  draw,
  terms,
  monthDays,
};
