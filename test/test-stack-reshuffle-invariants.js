'use strict';

// Offline ledger re-sorts. All receipts, identities and balances are invented.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const H = require('./acceptance/harness');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Memory = require('../scripts/server-observation-memory');
const { loadStackPage } = require('./lib/budget-page-harness');

// The aggregate fixture imports the default identity registry at load time.
// Supply only this world's bill rule and restore the module cache immediately.
const registry = require.resolve('../docs/connectivity/transaction-identity.json');
const previous = require.cache[registry];
require.cache[registry] = {
  id: registry,
  loaded: true,
  exports: {
    rules: [{ eventId: 'lamp', payeePattern: 'Invented utility', atlasAccountId: 'chequing-a', direction: 'debit' }],
    billPaymentPayees: []
  }
};
let world;
try {
  ({ world } = require('./fixtures/card-coverage-aggregate-world'));
} finally {
  if (previous) require.cache[registry] = previous;
  else delete require.cache[registry];
}
function source(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}
const renderer = { console, URLSearchParams, Intl, location: { search: '' } };
renderer.window = renderer;
vm.createContext(renderer);
vm.runInContext(source('public/stack-shell.js'), renderer);
const renderers = {};
renderer.StackBlocks.register = (name, fn) => {
  renderers[name] = fn;
};
for (const file of ['stack-waterfall', 'stack-credit', 'stack-sheet', 'stack-cards'])
  vm.runInContext(source('public/' + file + '.js'), renderer);
const cents = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null);
const dollars = (c) => c / 100;
function parameters(index) {
  if (!index) return { base: 80, extra: 37, payment: 25, bill: 16, mortgage: 95, hold: 150, otherHold: 50 };
  let state = (0x5eedc0de ^ Math.imul(index, 2654435761)) >>> 0;
  const rand = (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 4294967296) * n);
  };
  return {
    base: dollars(3000 + rand(5000)),
    extra: dollars(1100 + rand(2800)),
    payment: dollars(1000 + rand(3001)),
    bill: dollars(1400 + rand(1000)),
    mortgage: 80 + rand(50),
    hold: 130 + rand(60),
    otherHold: 45 + rand(30)
  };
}
function ledger(p, scenario) {
  const day = '2026-09-20',
    prior = '2026-09-19';
  const row = (acct, value, kind, id, attrs = {}) => [acct, value, attrs.date || day, kind, { id, ...attrs }];
  const charge = (v, id, attrs = {}) =>
    row('card', v, 'purchase', id, { payee: 'Invented shop', original_name: 'Invented terminal', ...attrs });
  const candidate = (attrs = {}) => charge(p.extra, 103, attrs);
  const bill = row('bills', p.bill, 'purchase', 105, {
    payee: 'Invented utility',
    original_name: 'Invented utility',
    category_name: 'Utilities'
  });
  const payment = row('bills', p.payment, 'cash', 104, {
    notes: 'card payment: Travel Visa',
    original_name: 'TFR-TO C/C'
  });
  const rows = [
    charge(p.base, 101, { payee: 'Invented grocer', original_name: 'Invented grocer', date: prior }),
    payment,
    bill
  ];
  const pair = (a, b) => rows.push(candidate({ id: 102, is_pending: true, ...a }), candidate(b));
  switch (scenario) {
    case 'base':
      break;
    case 'mapped':
      rows.push(candidate());
      break;
    case 'otherMapped':
      rows.push(candidate({ category_name: 'Fuel' }));
      break;
    case 'unknown':
      rows.push(candidate({ category_name: null }));
      break;
    case 'unmapped':
      rows.push(candidate({ category_name: 'Invented unlinked' }));
      break;
    case 'business':
      rows.push(candidate({ category_name: 'Invented business' }));
      break;
    case 'external':
      rows.push(candidate({ category_name: 'Invented external' }));
      break;
    case 'asTransfer':
      rows.push(candidate({ category_name: 'Transfer' }));
      break;
    case 'asPayment':
      rows.push(candidate({ category_name: 'Credit Card Payment' }));
      break;
    case 'rename':
      rows.push(candidate({ payee: 'New display name' }));
      break;
    case 'tag':
      rows.push(candidate({ tags: ['Invented errand'] }));
      break;
    case 'pending':
      rows.push(candidate({ id: 102, is_pending: true }));
      break;
    case 'pendingUnknown':
      rows.push(candidate({ id: 102, is_pending: true, category_name: null }));
      break;
    case 'twins':
      pair({}, {});
      break;
    case 'linkedChanged':
      pair({ date: prior, category_name: null }, { pending_transaction_id: 102, payee: 'New display name' });
      break;
    case 'distinctLookalike':
      pair({ date: prior, original_name: 'Invented terminal' }, {});
      break;
    case 'unlinkedRename':
      pair(
        { date: prior, original_name: null, payee: 'Old shop name' },
        { original_name: null, payee: 'New shop name' }
      );
      break;
    case 'duplicateExact':
      rows.push(candidate(), candidate());
      break;
    case 'duplicateConflict':
      rows.push(candidate(), candidate({ amount: p.extra + 1, payee: 'Different counterparty' }));
      break;
    case 'splitPieces':
    case 'groupChildren':
    case 'splitWithParent': {
      const first = Math.floor(cents(p.extra) / 2);
      const isGroup = scenario === 'groupChildren';
      if (scenario !== 'splitPieces')
        rows.push(
          candidate(
            isGroup
              ? {
                  is_group_parent: true,
                  children: [
                    { id: 106, plaid_account_id: 3004 },
                    { id: 107, plaid_account_id: 3004 }
                  ]
                }
              : { is_split_parent: true }
          )
        );
      const parent = isGroup ? { group_parent_id: 103 } : { split_parent_id: 103 };
      rows.push(charge(dollars(first), 106, parent), charge(dollars(cents(p.extra) - first), 107, parent));
      break;
    }
    case 'refund':
      rows.push(row('card', -p.extra, 'refund', 108, { payee: 'Invented grocer', kind: 'refund' }));
      break;
    case 'payerTransfer':
      payment[4].category_name = 'Transfer';
      rows.push(candidate());
      break;
    case 'payerRecategorized':
      payment[4].category_name = 'Groceries';
      rows.push(candidate());
      break;
    case 'plainTransfer':
    case 'plainPayment':
    case 'plainRecategorized':
      Object.assign(payment[4], {
        payee: 'Invented counter',
        original_name: 'Invented counter',
        category_name: {
          plainTransfer: 'Transfer',
          plainPayment: 'Credit Card Payment',
          plainRecategorized: 'Groceries'
        }[scenario]
      });
      rows.push(candidate());
      break;
    case 'payerRename':
      payment[4].payee = 'Invented display alias';
      rows.push(candidate());
      break;
    case 'billRename':
      bill[4].payee = 'New bill display name';
      rows.push(candidate());
      break;
    case 'billTransfer':
      bill[4].category_name = 'Transfer';
      rows.push(candidate());
      break;
    case 'stale':
    case 'manual':
      rows.push(candidate());
      break;
    case 'oldSync':
      rows.splice(0, 1);
      break;
    case 'overLimitTransfer':
      rows.push(candidate({ category_name: 'Transfer' }));
      break;
    case 'twoCards':
      rows.push(candidate(), row('card2', 19, 'purchase', 111, { payee: 'Second shop' }));
      break;
    case 'reverseOrder':
      rows.push(candidate());
      rows.reverse();
      break;
    case 'carry':
    case 'lateCarry': {
      return world(
        [
          ['bills', 20, '2026-09-26', 'cash'],
          ['card', -20, '2026-09-26', 'credit'],
          ...(scenario === 'lateCarry' ? [['card', p.extra, '2026-09-27', 'purchase']] : [])
        ],
        {
          asOf: '2026-10-05',
          minimumDate: '2026-09-25',
          edit(x) {
            x.payload.accounts.forEach((a) => (a.last_fetch = x.asOf + 'T17:00:00Z'));
          }
        }
      );
    }
    default:
      throw Error(scenario);
  }
  return world(rows, {
    twoCards: scenario === 'twoCards',
    edit(x) {
      const plan = x.data.plan;
      x.payload.tags = [];
      x.payload.categories = [];
      x.payload.pendingCoverage.truncated = false;
      plan.budget.categories[0].plannedPayday = p.hold;
      plan.budget.categories[0].plannedWeekly = p.hold / 2;
      plan.budget.categories.push({
        id: 'fuel',
        label: 'Fuel',
        from: ['Fuel'],
        class: 'essential',
        plannedPayday: p.otherHold,
        confidence: 'confirmed'
      });
      plan.budget.excluded = [{ from: 'Invented business' }, { from: 'Invented external' }];
      plan.bills = [
        {
          id: 'lamp',
          label: 'Invented utility',
          frequency: 'monthly',
          day: 20,
          amount: p.bill,
          confidence: 'confirmed',
          payee: 'Invented utility'
        }
      ];
      plan.obligations.push({
        id: 'mortgage',
        label: 'Invented mortgage',
        debtId: 'mortgage',
        effect: 'payment',
        frequency: 'once',
        date: '2026-09-24',
        amount: p.mortgage,
        confidence: 'confirmed',
        payingAccount: 'chequing-a'
      });
      x.payload.accounts.forEach((a) => (a.last_fetch = day + 'T17:00:00Z'));
      if (scenario === 'twoCards')
        plan.obligations.push({
          id: 'second-min',
          label: 'Second minimum',
          debtId: 'mbna',
          effect: 'payment',
          frequency: 'once',
          date: day,
          amount: 9,
          payingAccount: 'chequing-a',
          confidence: 'confirmed'
        });
      // Balances represent economic events, never split parent + children, or pending + posted twice.
      const card = x.payload.accounts[3];
      const onlyPending = ['pending', 'pendingUnknown'].includes(scenario);
      const addition = scenario === 'base' || onlyPending ? 0 : scenario === 'refund' ? -p.extra : p.extra;
      card.balance = dollars(40000 + cents(p.base) + cents(addition));
      if (scenario === 'oldSync') {
        card.last_fetch = '2026-08-01T17:00:00Z';
        card.balance = 401;
      }
      if (scenario === 'overLimitTransfer') {
        card.credit_limit = 400;
        x.data.debts[0].limit = 400;
      }
      if (scenario === 'manual') {
        delete card.last_fetch;
      }
      if (scenario === 'stale') {
        x.payload.transactionWindow.endDate = prior;
        card.last_fetch = prior + 'T17:00:00Z';
        for (const tx of x.payload.transactions) if (tx.date === day) tx.date = prior;
      }
    }
  });
}
function publication(x) {
  const { data } = Live.fromObservation(x);
  return fromServed(data);
}
function fromServed(data) {
  const rec = F.recommend(data.plan, F.budgetAsOf(data), F.budgetRecommendInputs(data, {}));
  const view =
    rec.payPeriodViews.find((v) => v.role === 'active') || rec.payPeriodViews.find((v) => v.timelineRole === 'current');
  const s = view.stackSummary,
    l = s.credit.lines.find((line) => line.id === 'travelvisa');
  return {
    data,
    rec,
    view,
    s,
    l,
    ctx: { data, plan: data.plan, recommendation: rec, selectedPeriodKey: view.start, Forecast: F }
  };
}

const seen = new Set();
const defects = new Set();
let active;
function defect(id, label, actual, expected) {
  assert.deepEqual(actual, expected, 'KNOWN-DEFECT ' + id + ' ' + label + ' (flip in the fixing PR)');
  defects.add(id + ' ' + label);
}
function observe(p, scenario, edit) {
  const x = ledger(p, scenario);
  if (edit) edit(x);
  active = { scenario, p, rows: x.payload.transactions, window: x.payload.transactionWindow };
  seen.add(scenario);
  return publication(x);
}
function capture(html, pattern, label) {
  const m = html.match(pattern);
  assert.ok(m, 'missing ' + label);
  return m[1];
}
const plain = (html) => html.replace(/<[^>]+>/g, '').trim();
const shown = (value) => (value === null ? '\u2014' : '$' + Math.round(value).toLocaleString('en-US'));
function cell(html, source) {
  const span = capture(
    html,
    new RegExp('(<span[^>]* data-source="' + source.replaceAll('.', '\\.') + '"[^>]*>[^<]*</span>)'),
    source
  );
  if (span.includes('data-unpublished="true"')) {
    assert.equal(plain(span), '');
    return null;
  }
  assert.match(plain(span), /^[+\u2212-]?\$[\d,]+(?:\.\d{2})?$/);
  return Number(plain(span).replace('\u2212', '-').replace(/[$,]/g, ''));
}
function waterfall(view, html, roundingDifference = 0) {
  const s = view.stackSummary,
    t = s.surplus.terms;
  const surplus = cell(html, 'stackSummary.surplus.amount');
  assert.equal(surplus, s.surplus.amount === null ? null : Math.round(s.surplus.amount));
  if (!t) {
    assert.equal(s.surplus.amount, null);
    return;
  }
  const terms = [
    ['stackSummary.income.total.amount', s.income.total.amount],
    ['stackSummary.bills.other', s.bills.other],
    ['budgetHold', view.budgetHold],
    ['stackSummary.bills.mortgage', s.bills.mortgage],
    ['stackSummary.surplus.terms.credit', t.credit]
  ];
  if (t.savingsItemSpending) terms.push(['stackSummary.surplus.terms.savingsItemSpending', t.savingsItemSpending]);
  const printed = terms.map(([key, raw]) => {
    assert.ok(Number.isFinite(raw), key);
    const value = cell(html, key);
    assert.equal(value, Math.round(raw), key);
    return value;
  });
  const subtract = ([income, ...outflows]) => income - outflows.reduce((a, b) => a + b, 0);
  assert.equal(cents(s.surplus.amount), subtract(terms.map(([, raw]) => cents(raw))), 'waterfall cents');
  const delta = surplus - subtract(printed);
  if (roundingDifference) defect(12, 'independent half-dollar rounding', delta, roundingDifference);
  else assert.equal(delta, 0, 'printed dollars add up');
}
function cardTile(html, line) {
  const card = capture(
    html,
    new RegExp('(<li><button[^>]*data-stack-sheet="card:' + line.id + '"[\\s\\S]*?</li>)'),
    line.id + ' tile'
  );
  const figure = plain(
    capture(card, /<span class="stack-credit-fig stack-n">([\s\S]*?)<\/button>/, 'card figures')
  ).replace(/[\s\u203a]+$/g, '');
  const target = line.target.amount === 0 ? '' : ' / ' + shown(line.target.amount);
  const paid = (line.paidBack.amount > 0 ? '+' : '') + shown(line.paidBack.amount);
  assert.equal(figure, paid + target, 'rendered paid / target');
  assert.equal(card.includes('aria-label="Minimum covered'), line.minimumCovered.value === true, 'tile tick');
  assert.equal(card.includes('stack-credit-x is-good'), line.targetCovered.value === true, 'rendered payoff claim');
}
function surfaces(r, ids = ['travelvisa'], roundingDifference = 0) {
  const box = { innerHTML: '', addEventListener() {} };
  renderers.credit(box, r.ctx);
  const html = renderer.StackWaterfall.html(r.ctx, { creditOpen: true });
  waterfall(r.view, html, roundingDifference);
  const breakdown = r.s.creditBreakdown;
  const cards = { innerHTML: '' };
  renderers.cards(cards, r.ctx);
  const summary = capture(cards.innerHTML, /data-stack-card="bills"([\s\S]*?)<\/summary>/, 'Bills summary');
  const paidBills = plain(capture(summary, /<span class="sc-f[^"]*">([\s\S]*?)<\/span>/, 'Bills head'));
  assert.equal(
    paidBills,
    r.s.bills.paid === null ? shown(null) : shown(r.s.bills.paid) + ' / ' + shown(r.s.bills.other)
  );
  const header = plain(capture(box.innerHTML, /data-stack-credit-total>([\s\S]*?)<\/i>/, 'Credit header'));
  assert.equal(
    header,
    shown(r.s.credit.totals.minimumsPaid.amount) + ' / ' + shown(r.s.credit.totals.minimumsDue.amount)
  );
  assert.ok(ids.length);
  for (const id of ids) {
    const line = r.s.credit.lines.find((l) => l.id === id);
    assert.ok(line, id + ' Forecast line');
    cardTile(box.innerHTML, line);
    const sheet = renderer.StackSheet.html(r.ctx, 'card:' + id);
    assert.ok(sheet, id + ' sheet');
    const spend = sheet.match(/<dt>New charges<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/);
    assert.equal(
      spend ? plain(spend[1]) : null,
      line.spent.amount === null ? null : shown(line.spent.amount),
      id + ' sheet spend'
    );
    const drop = capture(
      html,
      new RegExp('(<li[^>]*data-debt-id="' + id + '"[^>]*>[\\s\\S]*?</li>)'),
      id + ' dropdown'
    );
    assert.equal(drop.includes('aria-label="Minimum paid'), line.minimumCovered.value === true, id + ' dropdown tick');
    const index = breakdown.rows.findIndex((row) => row.debtId === id);
    assert.ok(index >= 0, id + ' breakdown');
    const row = breakdown.rows[index];
    assert.deepEqual([row.amount, row.trust], [line.stillToPayBack.amount, line.stillToPayBack.trust]);
    assert.equal(
      cell(drop, 'stackSummary.creditBreakdown.rows.' + index + '.amount'),
      row.amount === null ? null : Math.round(row.amount)
    );
    const d = line.deduction;
    if (d.amount !== null)
      assert.equal(cents(d.amount), cents(line.target.amount) - cents(d.countedOffset) - cents(d.beyondNetted));
  }
  if (r.s.surplus.terms)
    assert.equal(
      cents(r.s.surplus.terms.credit),
      cents(r.s.credit.totals.minimumsDue.amount) +
        cents(r.view.predictedEndingBalanceTerms.cardRepaymentAdjustment ?? 0)
    );
}

const ordinary = [
  'mapped',
  'otherMapped',
  'rename',
  'tag',
  'reverseOrder',
  'payerRename',
  'payerTransfer',
  'plainPayment',
  'plainTransfer',
  'billRename',
  'billTransfer',
  'splitPieces',
  'groupChildren',
  'linkedChanged',
  'pending',
  'twins'
];
function preservedPayment(line, expected) {
  assert.equal(cents(line.paidBack.amount), expected, 'payer receipt survives the category edit');
}
function countedOnce(line, expected) {
  assert.equal(cents(line.spent.amount), expected, 'linked replacement counts once');
}
function knownSubtotal(line, known) {
  assert.ok(Number.isFinite(line.spent.amount) && cents(line.spent.amount) >= known, 'known subtotal survives');
}
function unreadFeed(line) {
  assert.deepEqual([line.spent.amount, line.spent.trust], [null, 'unavailable'], 'unread card spend stays unavailable');
}
function generated(p) {
  // Independent economic events, in cents. The two card purchases remain two
  // events whether a provider sends a split parent, two children or a new ID.
  const purchases = [cents(p.base), cents(p.extra)];
  const charges = purchases.reduce((a, b) => a + b, 0),
    paid = cents(p.payment),
    bill = cents(p.bill);
  const hold = cents(p.hold) + cents(p.otherHold),
    surplus = 100000 - cents(p.mortgage) - bill - hold;
  const base = observe(p, 'base');
  assert.equal(cents(base.l.spent.amount), purchases[0]);
  surfaces(base);
  for (const name of ordinary) {
    const r = observe(p, name),
      l = r.l;
    knownSubtotal(l, cents(base.l.spent.amount));
    countedOnce(l, charges);
    preservedPayment(l, paid);
    assert.deepEqual(
      [cents(l.target.amount), cents(l.stillToPayBack.amount), l.minimumCovered.value, l.targetCovered.value],
      [charges, charges - paid, paid >= 2500, false],
      name
    );
    assert.deepEqual(
      [cents(r.s.bills.paid), cents(r.view.budgetHold), cents(r.s.surplus.amount)],
      [bill, hold, surplus],
      name
    );
    const trust = name === 'pending' ? 'estimated' : 'calculated';
    assert.deepEqual(
      [l.spent.trust, l.target.trust, l.deduction.trust, r.s.surplus.trust],
      [trust, trust, trust, trust],
      name + ' trust'
    );
    surfaces(r);
  }
  for (const name of [
    'unknown',
    'unmapped',
    'external',
    'business',
    'pendingUnknown',
    'asTransfer',
    'asPayment',
    'refund',
    'manual'
  ]) {
    const r = observe(p, name),
      l = r.l;
    const id = ['asTransfer', 'asPayment', 'refund', 'manual'].includes(name) ? 6 : 1;
    // #1664 restores ordinary charge recognition and changes the uncertain target.
    defect(
      id,
      name + ' loses supported spend',
      [l.spent.amount, cents(l.target.amount), cents(l.stillToPayBack.amount), l.targetCovered.value],
      [null, 2500, Math.max(0, 2500 - paid), paid >= 2500]
    );
    preservedPayment(l, paid);
    assert.equal(cents(r.s.bills.paid), bill);
    assert.deepEqual(
      [l.spent.trust, l.target.trust, l.deduction.trust, r.s.surplus.trust],
      ['unavailable', 'estimated', 'estimated', 'estimated']
    );
    const extraHold = ['unknown', 'unmapped', 'pendingUnknown'].includes(name) ? purchases[1] : 0;
    assert.equal(cents(r.view.budgetHold), hold + extraHold);
    assert.equal(cents(r.s.surplus.amount), surplus - extraHold - 2500);
    surfaces(r);
  }
  for (const name of ['payerRecategorized', 'plainRecategorized']) {
    const r = observe(p, name);
    defect(
      2,
      name,
      [r.l.paidBack.amount, cents(r.l.stillToPayBack.amount), r.l.minimumCovered.value],
      [0, charges, false]
    );
    surfaces(r);
  }
  for (const name of ['distinctLookalike', 'unlinkedRename', 'splitWithParent']) {
    const r = observe(p, name);
    const counted = name === 'distinctLookalike' ? charges : charges + purchases[1];
    defect(
      name === 'splitWithParent' ? 11 : 7,
      name,
      [cents(r.l.spent.amount), cents(r.l.stillToPayBack.amount), r.l.spent.trust],
      [counted, counted - paid, name === 'unlinkedRename' ? 'estimated' : 'calculated']
    );
    surfaces(r);
  }
  for (const name of ['duplicateExact', 'duplicateConflict']) {
    const r = observe(p, name);
    defect(
      10,
      name + ' withholds unrelated bill',
      [r.s.bills.paid, r.l.spent.amount, r.l.paidBack.amount, r.s.surplus.amount],
      [null, null, null, null]
    );
    surfaces(r);
  }
  const two = observe(p, 'twoCards');
  assert.equal(two.s.credit.totals.minimumsDue.amount, 34);
  surfaces(two, ['travelvisa', 'mbna']);
}

async function pageFor(r) {
  const page = await loadStackPage({ data: r.data });
  assert.equal(page.status(), 'rendered');
  assert.equal(page.selectedKey(), r.view.start);
  return page;
}
async function compact(p) {
  // Successive fetches of the same receipts, first as a pending debit,
  // then beside its directed replacement, finally with the posted row alone.
  const refresh = ledger(p, 'linkedChanged');
  const rows = refresh.payload.transactions;
  for (const [minute, omitted, trust] of [['00', 103, 'estimated'], ['10', null, 'calculated'], ['20', 102, 'calculated']]) {
    refresh.payload.transactions = rows.filter(row => row.id !== omitted);
    const pending = rows.find(row => row.id === 102);
    pending.category_name = 'Groceries';
    refresh.payload.accounts[3].balance = omitted === 103 ? 480 : 517;
    refresh.payload.fetchedAt = refresh.asOf + 'T18:' + minute + ':00Z';
    active = {scenario: 'replacement refresh', at: refresh.payload.fetchedAt, rows: refresh.payload.transactions};
    const r = publication(refresh);
    countedOnce(r.l, 11700);
    assert.deepEqual([r.view.start, r.l.stillToPayBack.amount, r.l.spent.trust], ['2026-09-18', 92, trust]);
    surfaces(r);
  }
  const reversal = observe(p, 'mapped', (x) => {
    const original = x.payload.transactions.find((t) => t.id === 104);
    x.payload.transactions.push({ ...original, id: 109, amount: -original.amount });
    x.payload.accounts[0].balance += original.amount;
  });
  assert.deepEqual(
    [reversal.l.paidBack.amount, reversal.l.minimumCovered.value],
    [null, 'unknown'],
    'named payment reversal'
  );
  surfaces(reversal);
  const limit = observe(p, 'overLimitTransfer');
  assert.deepEqual(
    [limit.l.target.amount, limit.l.stillToPayBack.amount],
    [117, 92],
    'over-limit target survives uncertain activity'
  );
  surfaces(limit);
  const stale = observe(p, 'stale');
  unreadFeed(stale.l);
  assert.equal(stale.l.targetCovered.value, 'unknown');
  surfaces(stale);
  for (const date of ['2026-09-20', '2026-08-01']) {
    const r = observe(p, 'oldSync', (x) => {
      x.payload.accounts[3].last_fetch = date + 'T17:00:00Z';
    });
    const spend = [r.l.spent.amount, r.l.spent.trust];
    if (date === '2026-09-20') assert.deepEqual(spend, [0, 'calculated']);
    else defect(5, 'old contact promotes zero', spend, [0, 'calculated']);
    surfaces(r);
  }
  for (const failed of [false, true]) {
    const r = observe(p, 'twoCards', (x) => {
      x.payload.transactions.find((tx) => tx.id === 104).notes = 'card payment: MBNA';
      if (failed) x.payload.accounts[0].status = 'error';
    });
    const line = r.s.credit.lines.find((l) => l.id === 'mbna');
    if (failed) defect(5, 'manual payer failure', [line.paidBack.amount, line.paidBack.trust], [0, 'estimated']);
    else assert.equal(line.paidBack.amount, 25);
    const page = await pageFor(r);
    cardTile(page.blockHtml('credit'), line);
  }
  for (const rename of [false, true]) {
    const r = observe(p, 'mapped', (x) =>
      Object.assign(
        x.payload.transactions.find((tx) => tx.id === 105),
        { payee: rename ? 'New bill display name' : 'Invented utility', original_name: null }
      )
    );
    const result = [r.s.bills.paid, r.view.budgetHold, r.s.surplus.amount];
    if (rename) defect(3, 'payee-only bill rename', result, [0, 216, 673]);
    else assert.deepEqual(result, [16, 200, 689]);
    const page = await pageFor(r);
    const billHead = plain(
      capture(
        capture(page.blockHtml('cards'), /data-stack-card="bills"([\s\S]*?)<\/summary>/, 'Bills summary'),
        /<span class="sc-f[^"]*">([\s\S]*?)<\/span>/,
        'Bills head'
      )
    );
    assert.equal(billHead, shown(r.s.bills.paid) + ' / $16');
    surfaces(r);
  }
  for (const name of ['carry', 'lateCarry']) {
    const r = observe(p, name);
    // #1663 should flip both rollover cases to $5 due and $845 Surplus.
    defect(8, name, [r.s.credit.totals.minimumsDue.amount, r.s.surplus.amount], [0, 850]);
    const page = await pageFor(r);
    waterfall(r.view, page.sandbox.StackWaterfall.html(page.context(), { creditOpen: true }));
    assert.equal(page.selectPeriod('2026-09-18'), '2026-09-18');
    const ctx = page.context(),
      historical = ctx.recommendation.payPeriodViews.find((v) => v.start === page.selectedKey());
    const line = historical.stackSummary.credit.lines.find((l) => l.id === 'travelvisa');
    assert.deepEqual([line.paidBack.amount, line.target.amount, line.stillToPayBack.amount], [20, 25, 5]);
    cardTile(page.blockHtml('credit'), line);
    const html = page.sandbox.StackWaterfall.html(ctx, { creditOpen: true });
    const drop = capture(html, /(<li[^>]*data-debt-id="travelvisa"[\s\S]*?<\/li>)/, 'historical dropdown');
    defect(9, 'completed period shows minimum', cell(drop, 'stackSummary.bills.cardMinimums.0.amount'), 25);
  }
  surfaces(observe({ ...p, bill: 16.5 }, 'mapped'), ['travelvisa'], 1);
}
function retention(p) {
  for (const next of ['manual', 'stale', 'duplicateExact']) {
    const memory = Memory.create();
    assert.equal(memory.readClearDisplay('invented'), null);
    for (const name of ['mapped', next]) {
      const input = ledger(p, name);
      if (name === next) input.payload.fetchedAt = input.asOf + 'T18:10:00Z';
      active = { scenario: 'retention ' + name, rows: input.payload.transactions };
      const { data } = publication(input);
      memory.publish(
        name,
        { schema: Memory.SCHEMA, payload: input.payload },
        { context: 'invented', data, checkedAt: input.payload.fetchedAt }
      );
      const retained = fromServed(memory.readClearDisplay('invented').data);
      if (name === 'mapped' || name === 'duplicateExact')
        assert.equal(retained.l.spent.amount, 117, 'warm store retains known spend');
      else defect(4, 'warm store admits ' + name, retained.l.spent.amount, null);
      surfaces(retained);
    }
  }
}
async function savings() {
  active = { scenario: 'linked savings spending' };
  const w = H.baseWorld();
  w.commitments = [
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true }
  ];
  w.savingsPool = { value: 1000 };
  w.links = [
    {
      categoryId: 106,
      goalRef: { kind: 'commitment', id: 'trip' },
      occurrenceDate: '2026-11-20',
      effectiveFrom: '2026-09-01',
      effectiveThrough: '2026-12-31'
    }
  ];
  w.transactions = [
    H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ date: '2026-10-12', amount: 200, category: 106, account: 'chequing-a', payee: 'Invented outfitter' })
  ];
  H.productionOpening(w);
  const { data } = Live.fromObservation({
    data: H.canonicalOf(w, H.planOf(w)),
    payload: H.rawPayload(w),
    accountMap: H.accountMapOf(w),
    identity: H.identityOf(w)
  });
  const page = await loadStackPage({ data });
  assert.equal(page.status(), 'rendered');
  const ctx = page.context(),
    view = ctx.recommendation.payPeriodViews.find((v) => v.start === page.selectedKey());
  assert.deepEqual([view.stackSummary.surplus.terms.savingsItemSpending, view.stackSummary.surplus.amount], [200, 800]);
  waterfall(view, page.sandbox.StackWaterfall.html(ctx, { creditOpen: true }));
}
// Two provider-input mutations, then two corrupted Forecast outputs. Exercise
// the same hard assertions as the green controls and require the named failure.
function mutants(p) {
  const dropped = observe(p, 'plainTransfer', (x) => {
    x.payload.transactions.find((t) => t.id === 104).notes = null;
  });
  assert.throws(() => preservedPayment(dropped.l, 2500), /payer receipt survives/);
  const doubled = observe(p, 'linkedChanged', (x) => {
    const posted = x.payload.transactions.find((t) => t.id === 103);
    delete posted.pending_transaction_id;
    posted.original_name = 'Different terminal';
    const pending = x.payload.transactions.find((t) => t.id === 102);
    pending.category_name = 'Groceries';
  });
  assert.throws(() => countedOnce(doubled.l, 11700), /linked replacement counts once/);
  assert.equal(doubled.l.spent.amount, 154, 'mutant counted both $37 rows');
  const known = observe(p, 'mapped').l;
  known.spent = { ...known.spent, amount: null };
  assert.throws(() => knownSubtotal(known, 8000), /known subtotal survives/);
  const stale = observe(p, 'stale').l;
  stale.spent = { ...stale.spent, amount: 0, trust: 'calculated' };
  assert.throws(() => unreadFeed(stale), /unread card spend stays unavailable/);
}
async function main() {
  const start = Date.now();
  assert.ok(ordinary.length);
  for (let index = 0; index < 4; index++) generated(parameters(index));
  const p = parameters(0);
  await compact(p);
  retention(p);
  await savings();
  assert.equal(seen.size, 39, 'all ledger variants exercised before mutant probes');
  mutants(p);
  const ids = new Set([...defects].map((s) => Number(s.split(' ')[0])));
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    Array.from({ length: 12 }, (_, i) => i + 1)
  );
  for (const label of defects) console.log('KNOWN-DEFECT ' + label);
  console.log(
    'Four parameter sets, ' +
      seen.size +
      ' ledger variants, four mutants caught in ' +
      ((Date.now() - start) / 1000).toFixed(2) +
      's'
  );
}
main().catch((error) => {
  const head = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  console.error({ head, seed: '0x5eedc0de', ...active }, error);
  process.exitCode = 1;
});
