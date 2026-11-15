'use strict';
// Per-pay-period bank check, Forecast's side (the last 1.0 item; owner: Dale, #821 6888496919 and 6888727089; design: #1151
// comment 6893697862; lead rulings recorded on the PR). `Forecast.periodBankCheck` compares what the two chequing accounts did
// over the period (closing observation minus the balance the previous close SAVED) with exactly what Forecast counted, and
// publishes the gap:  unexplained = (closing - opening) - (counted in - counted out), over A + B.
// Hand-worked values on the invented Budget-surface household (observed Thu Aug 20; the current period is Aug 14-27; payroll
// 2,600 posted Aug 14 on Bills; mortgage 1,400 Aug 15 on Bills; five spending rows on Weekly spending). Window rows after the
// opening day (Aug 14) net -1,400.00 on Bills and -444.49 on Weekly spending: -1,844.49. Opening saved on Aug 14 with 2,615.00
// and 604.49 (so the closing 1,215.00 + 160.00 = 1,375.00 is exactly explained); the saved cut holds Aug 14's one posted row
// (the payroll, -2,600.00 in the provider's debit-positive sign) on Bills and none on Weekly spending.
// The published tag is capped at estimated until the balance assumption is proved privately (step 0): `trustBeforeAssumption`
// carries what the design's table gives, and the tests read both.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const O = require('../scripts/provider-observe');
const fx = require('./fixtures/budget-surface-data');

let checks = 0;
const ok = (cond, label, detail) => { assert.ok(cond, label + (detail ? ' - ' + detail : '')); checks++; };
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const cents = value => Math.round(Number(value) * 100);

const SAVED = (overrides = {}) => ({ status: 'saved', reason: null, edge: { rule: 'household-day', end: '2026-08-13', tz: 'America/Vancouver' },
  accounts: [
    { id: 'chequing-a', balance: 2615, evidenceDate: '2026-08-14', postedOnOrAfter: { count: 1, total: -2600 } },
    { id: 'chequing-b', balance: 604.49, evidenceDate: '2026-08-14', postedOnOrAfter: { count: 0, total: 0 } }], ...overrides });
const record = (block, extra = {}) => ({ schema: 'atlas-private-period-history-projection/v1', capturedAt: '2026-08-14T19:00:00.000Z',
  content: { period: { start: '2026-07-31', end: '2026-08-13', timezone: 'America/Vancouver' }, kind: 'closing',
    closingState: 'complete-at-capture', ...(block ? { periodBankBalances: block } : {}),
    publication: { start: '2026-07-31', end: '2026-08-13' } }, ...extra });

// Raw legs on the two chequing accounts (1001 Bills, 1002 Weekly spending); a posted leg moves its account's closing balance.
function world({ legs = [], block = SAVED(), history, cards = null, observed } = {}) {
  const data = fx.canonical();
  const payload = fx.payload();
  payload.categories.push({ id: 17, name: 'Transfer', is_income: false, exclude_from_totals: true });
  const ACCOUNT = { 1001: 'chequing-a', 1002: 'chequing-b' };
  let id = 94000;
  for (const leg of legs) {
    payload.transactions.push({ id: ++id, account_id: leg.account || 1001, date: leg.date || '2026-08-19', amount: leg.amount,
      currency: leg.currency || 'cad', payee: leg.payee || 'Synthetic recipient', ...(leg.original ? { original_name: leg.original } : {}),
      category_id: leg.category || 17, is_pending: leg.pending === true, status: leg.pending ? 'pending' : 'cleared' });
    if (leg.pending !== true) payload.accounts.find(a => a.id === (leg.account || 1001)).balance -= leg.amount;
    data.plan.startingCash.breakdown.find(row => row.id === ACCOUNT[leg.account || 1001]).value -= leg.pending ? 0 : leg.amount;
  }
  if (cards) cards(payload, data);
  const served = Live.fromObservation({ data, payload, accountMap: fx.map, identity: fx.identity }).data;
  const periodHistory = history === undefined ? (block ? [record(block)] : []) : history;
  const advice = F.recommend(served.plan, '2026-08-20', { ...served.plan.defaults, debts: served.debts || [],
    currentPeriodActuals: served.liveOverlay.currentPeriodActuals, representedEvents: served.liveOverlay.representedEvents,
    observedCash: observed === undefined ? served.liveOverlay.observedCash : observed, periodHistory });
  const cur = advice.payPeriodViews.find(view => view.timelineRole === 'current');
  return { served, advice, cur, bc: cur.bankCheck };
}
// The two identities, in whole cents, for every available result.
function law(bc, label) {
  if (bc.unexplained == null) return;
  eq(cents(bc.opening.balance) + cents(bc.countedIn) - cents(bc.countedOut) + cents(bc.unexplained), cents(bc.closing.balance), label + ': opening + in - out + unexplained = closing');
  eq([bc.identity.closes, cents(bc.identity.a) - cents(bc.identity.b) - cents(bc.identity.c) + cents(bc.identity.d)], [true, cents(bc.unexplained)], label + ': A - B - C + D = unexplained');
}
const noNumbers = bc => !/\d\.\d\d|"unexplained":-?\d/.test(JSON.stringify({ ...bc, accounts: undefined, reason: undefined }));

// ---- 1: the base world: everything the bank did is counted
{
  const { bc, cur } = world();
  eq([bc.unexplained, bc.trustBeforeAssumption, bc.trust], [0, 'calculated', 'estimated'], '1: unexplained 0.00; calculated by the table, capped to estimated until step 0');
  eq([bc.opening, bc.closing], [{ date: '2026-08-14', balance: 3219.49 }, { date: '2026-08-20', balance: 1375 }], '1: the saved opening and today\'s observation');
  eq([bc.countedIn, bc.countedOut, bc.expected], [0, 1844.49, 1375], '1: counted in/out and what Atlas expects');
  eq([bc.lists.atTheBankNotCounted.length, bc.lists.countedNoBankTransaction.length, bc.lists.countedMoreThanOnce.length, bc.lists.notInAnyTransaction], [0, 0, 0, 0], '1: every list is empty');
  law(bc, '1');
  ok(cur.start === '2026-08-14' && cur.timelineRole === 'current', '1: published on the current period row');
}

// ---- 2 and 3 (audit): a transfer-labelled debit Atlas ignored reads as unexplained, and is listed, not explained
{
  const t = world({ legs: [{ amount: 400 }] }); // a 400.00 debit on Bills, category Transfer
  eq(t.bc.unexplained, -400, '2: a 400 e-transfer Atlas ignored reads -400.00');
  eq([t.bc.lists.atTheBankNotCounted.length, t.bc.lists.atTheBankNotCounted[0].amount], [1, 400], '2: it is in list A: at the bank, not counted');
  law(t.bc, '2');
  const g = world({ legs: [{ amount: 400, category: 11 }] }); // the same row filed Groceries: the ledger now accounts for it
  eq(g.bc.unexplained, 0, '2: the same row filed as Groceries counts: 0.00');
  const two = world({ legs: [{ amount: 250 }, { amount: 150, date: '2026-08-18' }] }); // a savings move and an extra card payment, both Transfer
  eq([two.bc.unexplained, two.bc.lists.atTheBankNotCounted.length], [-400, 2], '3: a savings move 250 and a card payment 150, both labelled Transfer: -400.00, two rows in list A');
  law(two.bc, '3');
}

// ---- 6, 7, 16: Unavailable cases carry a reason and no figure anywhere
{
  const weekly = world({ observed: { complete: true, asOf: '2026-08-20', accounts: [{ id: 'chequing-a', value: 1215, evidenceDate: '2026-08-20' }] } });
  eq([weekly.bc.status, weekly.bc.reasonCode, weekly.bc.accounts], ['unavailable', 'closing-unavailable', ['Weekly spending']], '6: a missing or undated balance names the account');
  ok(weekly.bc.unexplained === null && noNumbers(weekly.bc), '6: no amount appears anywhere in the Unavailable result');
  const none = world({ block: null });
  eq([none.bc.status, none.bc.reasonCode], ['unavailable', 'no-opening'], '7: no saved opening is Unavailable');
  ok(none.bc.unexplained === null && noNumbers(none.bc), '7: no figure');
  const bad = world({ block: { status: 'unavailable', reason: 'balance-undated', edge: SAVED().edge, accounts: [] } });
  eq([bad.bc.status, bad.bc.reasonCode, bad.bc.openingReason], ['unavailable', 'opening-unavailable', 'balance-undated'], '7: a saved but unavailable opening is Unavailable, with its reason');
  const past = world().advice.payPeriodViews.filter(view => view.timelineRole === 'past' || view.lookback === true);
  ok(past.length > 0 && past.every(view => view.bankCheck && view.bankCheck.status === 'unavailable' && view.bankCheck.reasonCode === 'not-saved-at-close' && view.bankCheck.unexplained === null),
    '16: a past period with no saved check is Unavailable, never computed from today\'s balance');
  const future = world().advice.payPeriodViews.filter(view => view.timelineRole === 'future');
  ok(!future.some(view => Object.hasOwn(view, 'bankCheck')), '16: a future period has no bank check');
  eq(world({ history: [record(SAVED(), { content: undefined })] }).bc.reasonCode, 'no-opening', '7: a malformed saved record is ignored, never thrown');
}

// ---- 8: a pending debit is left out of both sides and shown as a memo
{
  const p = world({ legs: [{ amount: 30, category: 11, pending: true, date: '2026-08-20' }] });
  eq([p.bc.unexplained, p.bc.memo.pendingNotAtTheBank, p.bc.memo.pendingCount], [0, -30, 1], '8: a pending 30 debit counted in Groceries: 0.00, memo 30 (not at the bank yet)');
  law(p.bc, '8');
}

// ---- 10: a move between the two chequing accounts nets to zero only when BOTH proven legs are present
{
  const pair = [{ account: 1001, amount: 200, original: 'AB123 TFR-TO INVENTED SPENDING' }, { account: 1002, amount: -200, original: 'AB123 TFR-FR INVENTED BILLS' }];
  eq(world({ legs: pair }).bc.unexplained, 0, '10: a proven A to B pair of 200 nets to zero: 0.00');
  eq(world({ legs: pair }).bc.lists.atTheBankNotCounted.length, 0, '10: the proven pair is counted (moved between accounts), so neither leg is listed as uncounted');
  law(world({ legs: pair }).bc, '10');
  eq(world({ legs: [pair[0]] }).bc.unexplained, -200, '10: one leg without its partner reads -200.00');
}

// ---- 13: the edge cut: matched cut calculated; a late opening-day row, or a missing one, is Unavailable (no attribution by amount)
{
  eq(world().bc.trustBeforeAssumption, 'calculated', '13: a matched cut is calculated');
  const late = world({ legs: [{ amount: 25, category: 11, date: '2026-08-14' }] }); // a row dated the opening day that the saved cut did not hold
  eq([late.bc.status, late.bc.reasonCode], ['unavailable', 'opening-day-postings-changed'], '13: a late opening-day row is Unavailable');
  ok(late.bc.unexplained === null && noNumbers(late.bc), '13: and shows no figure');
  const missing = world({ block: SAVED({ accounts: [
    { id: 'chequing-a', balance: 2615, evidenceDate: '2026-08-14', postedOnOrAfter: { count: 2, total: -2600 } },
    { id: 'chequing-b', balance: 604.49, evidenceDate: '2026-08-14', postedOnOrAfter: { count: 0, total: 0 } }] }) });
  eq([missing.bc.status, missing.bc.reasonCode, missing.bc.detail], ['unavailable', 'coverage-incomplete', 'opening-day-postings-missing'], '13: an opening-day row the opening held but the packet lacks is Unavailable (coverage)');
  const total = world({ block: SAVED({ accounts: [
    { id: 'chequing-a', balance: 2615, evidenceDate: '2026-08-14', postedOnOrAfter: { count: 1, total: -2599 } },
    { id: 'chequing-b', balance: 604.49, evidenceDate: '2026-08-14', postedOnOrAfter: { count: 0, total: 0 } }] }) });
  eq(total.bc.reasonCode, 'opening-day-postings-changed', '13: the same count with a different total is also Unavailable');
}

// ---- 14: incomplete posted coverage, and a non-CAD chequing row
{
  const more = world();
  const packet = JSON.parse(JSON.stringify(more.served.liveOverlay.currentPeriodActuals));
  const run = patch => { const p = JSON.parse(JSON.stringify(packet)); patch(p);
    const adv = F.recommend(more.served.plan, '2026-08-20', { ...more.served.plan.defaults, debts: more.served.debts || [], currentPeriodActuals: p,
      representedEvents: more.served.liveOverlay.representedEvents, observedCash: more.served.liveOverlay.observedCash, periodHistory: [record(SAVED())] });
    return adv.payPeriodViews.find(view => view.timelineRole === 'current').bankCheck; };
  eq(run(p => { p.transactionWindow.hasMore = true; }).reasonCode, 'coverage-incomplete', '14: hasMore is Unavailable (coverage)');
  eq(run(p => { p.transactionWindow.truncated = true; }).reasonCode, 'coverage-incomplete', '14: a truncated window is Unavailable (coverage)');
  eq(run(p => { p.transactions.find(t => t.atlasAccountId === 'chequing-b').currency = 'usd'; }).reasonCode, 'currency-unconfirmed', '14: a USD chequing row is Unavailable (currency)');
  eq(run(p => { p.coverageStart = '2026-08-15'; }).reasonCode, 'coverage-incomplete', '14: coverage that starts after the opening day is Unavailable');
}

// ---- 15: the property, over every world above, plus an overspend world and an estimated opening
{
  for (const [label, w] of [['income', world({ legs: [{ amount: -300, category: 15 }] })], ['refund', world({ legs: [{ amount: -45.5, category: 11 }] })],
    ['mixed', world({ legs: [{ amount: 12.34 }, { amount: 99.99, category: 12 }, { amount: 7, category: 11, account: 1002 }] })]]) law(w.bc, '15 ' + label);
}

// ---- 11, 4, 5: line-level cases through the pure function (hand-built rows over the base world's packet)
{
  const base = world();
  const view = JSON.parse(JSON.stringify(base.cur));
  const call = (mutate, opts) => { const v = JSON.parse(JSON.stringify(view)); mutate && mutate(v);
    return F.periodBankCheck(base.served.plan, '2026-08-20', v, { ...opts, currentPeriodActuals: base.served.liveOverlay.currentPeriodActuals,
      observedCash: base.served.liveOverlay.observedCash }, [record(SAVED())], null); };
  // 11: a bill settled on schedule trust has no bank row; it is counted on its row date and listed in B
  const trust = call(v => { v.bills.push({ id: 'trusted', label: 'Invented trusted bill', status: 'PAID', settlement: 'trust', settlementBasis: 'schedule-trust-on-due',
    date: '2026-08-18', planned: 37, amount: 37, actual: null, confidence: 'confirmed' }); });
  eq([trust.unexplained, trust.lists.countedNoBankTransaction.length, trust.trustBeforeAssumption], [37, 1, 'estimated'], '11: a schedule-trusted bill of 37 with no bank row: +37.00, estimated, listed in B');
  law(trust, '11');
  // 4: two rows that each link one bank transaction are counted twice; nothing de-duplicates
  const mortgage = base.served.liveOverlay.currentPeriodActuals.representedActuals.find(item => item.id === 'mortgage');
  const dup = F.periodBankCheck(base.served.plan, '2026-08-20', (() => { const v = JSON.parse(JSON.stringify(view)); v.bills.push({ ...v.bills.find(b => b.id === 'mortgage'), id: 'mortgage-again' }); return v; })(),
    { currentPeriodActuals: { ...base.served.liveOverlay.currentPeriodActuals, representedActuals: [...base.served.liveOverlay.currentPeriodActuals.representedActuals,
      { ...mortgage, id: 'mortgage-again' }] }, observedCash: base.served.liveOverlay.observedCash }, [record(SAVED())], null);
  eq([dup.unexplained, dup.lists.countedMoreThanOnce.length, dup.lists.countedMoreThanOnce[0] && dup.lists.countedMoreThanOnce[0].times], [1400, 1, 2], '4: one 1,400 mortgage transaction counted by two rows: +1,400.00, listed in C');
  law(dup, '4');
  // 5: an early deposit counted by two income lines
  const deposit = JSON.parse(JSON.stringify(base.served.liveOverlay.currentPeriodActuals));
  const pay = { id: 'tx-dep', date: '2026-08-16', amount: -1400, currency: 'cad', pending: false, savingsPostingEvidence: 'posted', accountRole: 'household-cash', atlasAccountId: 'chequing-a', account: 'chequing-a' };
  deposit.transactions.push(pay);
  deposit.representedActuals.push({ id: 'income-a', date: '2026-08-16', actual: -1400, postedOn: '2026-08-16', transactionId: 'tx-dep' },
    { id: 'income-b', date: '2026-08-16', actual: -1400, postedOn: '2026-08-16', transactionId: 'tx-dep' });
  const v2 = JSON.parse(JSON.stringify(view));
  for (const id of ['income-a', 'income-b']) v2.income.push({ id, label: 'Invented ' + id, status: 'received', settlement: 'represented', actual: -1400, planned: 1400, date: '2026-08-16', confidence: 'confirmed', actualTrust: 'calculated' });
  const obs = JSON.parse(JSON.stringify(base.served.liveOverlay.observedCash)); obs.accounts.find(a => a.id === 'chequing-a').value += 1400;
  const early = F.periodBankCheck(base.served.plan, '2026-08-20', v2, { currentPeriodActuals: deposit, observedCash: obs }, [record(SAVED())], null);
  eq([early.unexplained, early.lists.countedMoreThanOnce.length], [-1400, 1], '5: one 1,400 deposit counted by two income lines: -1,400.00, listed in C');
  law(early, '5');
}

// ---- 12: balance instants become household days (America/Vancouver, DST-aware): the capture's rule, restated
{
  eq([F.financialDate('2026-10-10T06:30:00Z'), F.financialDate('2026-11-01T08:30:00Z'), F.financialDate('2026-11-01T07:30:00Z')], ['2026-10-09', '2026-11-01', '2026-11-01'], '12: a balance instant is the Vancouver household day (Oct 10 06:30Z is Oct 9; the Nov 1 DST day boundary)');
}

// ---- 9: card-funded spending never touches chequing; a card payment counts only when the card ledger accepted it
{
  const card = (accept) => (payload, data) => {
    payload.transactions.push({ id: 94801, account_id: 2001, date: '2026-08-18', amount: 80, currency: 'cad', payee: 'Synthetic card purchase', category_id: 14, is_pending: false, status: 'cleared' });
    payload.transactions.push({ id: 94802, account_id: 2001, date: '2026-08-19', amount: -80, currency: 'cad', payee: 'PAYMENT - THANK YOU', category_id: 17, is_pending: false, status: 'cleared' });
    if (accept) {
      const ref = id => O.cardCoverageReference(O.normalizeLunchMoneyTransaction(payload.transactions.find(tx => tx.id === id)));
      data.plan.cardPurchaseCoverage.payments = [{ id: 'pay-1', confirmed: true, debitRef: ref(94001), creditRef: ref(94802), allocations: [{ purchaseRef: ref(94801), amount: 80 }], otherAmount: 0 }];
    }
  };
  eq(world({ cards: (p, d) => p.transactions.push({ id: 94810, account_id: 2001, date: '2026-08-18', amount: 80, currency: 'cad', payee: 'Synthetic card purchase', category_id: 14, is_pending: false, status: 'cleared' }) }).bc.unexplained, 0, '9: an 80 groceries-type purchase on the card: 0.00 (never touches chequing)');
  const paid = world({ legs: [{ amount: 80 }], cards: card(true) });
  eq(paid.bc.unexplained, 0, '9: an 80 card payment from Bills that the card ledger accepted is counted: 0.00');
  law(paid.bc, '9');
  const unpaid = world({ legs: [{ amount: 80 }], cards: card(false) });
  eq(unpaid.bc.unexplained, -80, '9: the same payment with no accepted pair is not counted: -80.00');
}

// ---- 17: the saved block is served closed, and nothing renders it yet
{
  const Read = require('../scripts/period-history-read');
  const projected = { ...record(SAVED()), sequence: 1, contentKey: 'k'.repeat(64), previousRevision: null, baselineRevision: null, revisionId: 'a'.repeat(64) };
  projected.content.asOf = '2026-08-13'; projected.content.engine = {}; projected.content.provenance = { policyFingerprint: 'p'.repeat(64) };
  const served = (async () => new Promise(resolve => {
    let now = 0;
    const reader = Read.create({ env: { [Read.FLAG]: 'on' }, clock: () => now, log: () => {},
      openStore: async () => ({ async read(opts) { return opts ? projected : [{ revisionId: projected.revisionId, kind: 'closing', period: projected.content.period }]; }, async retire() {} }) });
    reader.withHistory({ meta: { asOf: '2026-08-20' } });
    setTimeout(() => resolve(reader.withHistory({ meta: { asOf: '2026-08-20' } })), 20);
  }))();
  served.then(doc => {
    const block = doc.periodHistory[0].content.periodBankBalances;
    eq(Object.keys(block).sort(), ['accounts', 'edge', 'reason', 'status'], '17: the served block carries only the allowlisted keys');
    eq(block.accounts.map(row => Object.keys(row).sort()), [['balance', 'evidenceDate', 'id', 'postedOnOrAfter'], ['balance', 'evidenceDate', 'id', 'postedOnOrAfter']], '17: each row only balance, date, id and the cut');
    eq(Object.keys(block.accounts[0].postedOnOrAfter).sort(), ['count', 'total'], '17: the cut is a count and a total');
    ok(!JSON.stringify(block).match(/payee|memo|note|tag|merchant|displayed/i), '17: no transaction text or id');
    // nothing renders it before the page PR
    const pages = fs.readdirSync(path.join(__dirname, '../public')).filter(name => name.endsWith('.js') && name !== 'forecast.js');
    ok(pages.every(name => !/bankCheck|periodBankBalances/.test(fs.readFileSync(path.join(__dirname, '../public', name), 'utf8'))), '17: no page script reads the bank check or the saved block');
    console.log(`PASS period bank check: ${checks} checks`);
  }).catch(error => { console.error(error); process.exit(1); });
}
