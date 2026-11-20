'use strict';
/* Stack Wallet A6b (lead dispatch, ATLAS LEAD 11, 2026-11-19): the Credit lines. Per card and pay period,
 * Forecast.stackCreditLines(publication, bills) adds to stackCardSummary's paid / spent:
 *   - minimum: the card's row of the period's published bills split (stackSummary.bills.cardMinimums), derived and
 *     never recomputed, so the card and the waterfall's Credit line cannot disagree. No row is null with
 *     'no-minimum-due-in-period'; an unavailable split is null with 'bills-split-unavailable'.
 *   - status: 'upcoming' for a future period; else 'paid-back' when paid >= spent; else 'to-go' with toGo = spent -
 *     paid, computed here. Null with reasons when paid or spent is null.
 *   - minimumCovered: true when paid >= minimum, false when paid < minimum, 'unknown' when either is null.
 * Owner rule: "simple, has more money been put on the card than came off it"; no per-transaction matching. Trust is
 * the weakest input. HELOC is a credit line with its minimum only.
 *
 * Path: the invented card week (test/fixtures/card-posted-period-movement-data.js) -> Forecast.cardPeriodMovements ->
 * Forecast.stackCreditLines, with an invented bills split. By hand (posted rows only):
 *   Travel: paid 100.00, spent 207.40 -> to-go 107.40. Minimum 25 -> covered (100 >= 25).
 *   Cash Back: paid 250.00, spent 114.20 -> paid-back, toGo 0. Minimum 300 -> not covered (250 < 300).
 *   Emerald: 0 / 0 -> paid-back. No minimum row -> minimum null, covered unknown.
 *   Triangle, Amazon Mastercard: paid / spent unavailable -> status null, covered unknown.
 *   HELOC: minimum 50 from the split; paid / spent not published -> status null, covered unknown.
 *
 * `node test/test-stack-credit-lines.js`
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const fx = require('./fixtures/card-posted-period-movement-data');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const publish = x => F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
  { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, liveOverlay: x.overlay });
const split = { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }, { debtId: 'cashback', amount: 300 },
  { debtId: 'heloc', amount: 50 }], trust: 'calculated' };
const lines = (x, bills = split) => F.stackCreditLines(publish(x), bills).lines;
const totals = (x, bills = split) => F.stackCreditLines(publish(x), bills).totals;
const line = (x, id, bills) => lines(x, bills).find(c => c.id === id);

console.log('1. Hand-derived status, to go and minimum covered');
{
  const x = fx.fixture();
  ok(same(lines(x).map(c => c.id), ['travelvisa', 'cashback', 'tdcc', 'triangle', 'mbna', 'heloc']), 'the six credit lines, HELOC included');
  const t = line(x, 'travelvisa');
  ok(t.status === 'to-go' && t.toGo.amount === 107.4 && t.toGo.trust === 'estimated',
    'Travel: to-go 207.40 - 100.00 = 107.40, estimated (its payment source is not reconciled)', JSON.stringify(t.toGo));
  ok(same([t.minimum.amount, t.minimum.trust], [25, 'calculated']) && t.minimumCovered.value === true,
    'Travel: minimum 25 from the split, covered (100 >= 25)');
  const c = line(x, 'cashback');
  ok(c.status === 'paid-back' && c.toGo.amount === 0, 'Cash Back: paid 250.00 >= spent 114.20, paid-back, nothing to go');
  ok(c.minimum.amount === 300 && c.minimumCovered.value === false, 'Cash Back: minimum 300 not covered (250 < 300)');
  const e = line(x, 'tdcc');
  ok(e.status === 'paid-back' && e.minimum.amount === null && same(e.minimum.reasons, ['no-minimum-due-in-period'])
    && e.minimumCovered.value === 'unknown', 'Emerald: nothing spent, paid-back; no minimum due: null, covered unknown');
  for (const id of ['triangle', 'mbna']) {
    const m = line(x, id);
    ok(m.status === null && m.statusReasons.includes('account-transaction-evidence-unavailable') && m.toGo.amount === null
      && m.minimumCovered.value === 'unknown', id + ': paid / spent unavailable, so status and toGo null, covered unknown');
  }
  const h = line(x, 'heloc');
  ok(h.minimum.amount === 50 && h.paid.amount === null && h.paid.reasons.includes('not-a-spend-card')
    && h.status === null && h.minimumCovered.value === 'unknown', 'HELOC: minimum 50 only; paid / spent not published');
}

console.log('2. The minimum is the split\'s row, never recomputed');
{
  const x = fx.fixture();
  const twice = line(x, 'travelvisa', { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }, { debtId: 'travelvisa', amount: 10 }], trust: 'estimated' });
  ok(twice.minimum.amount === 35 && twice.minimum.trust === 'estimated', 'two rows for one card are summed (35), with the split\'s trust');
  ok(line(x, 'travelvisa', null).minimum.reasons[0] === 'bills-split-unavailable'
    && line(x, 'travelvisa', { cardMinimums: null, trust: 'unavailable' }).minimum.amount === null,
  'an unavailable split: minimum null with bills-split-unavailable, never 0');
  const bad = line(x, 'travelvisa', { cardMinimums: [{ debtId: 'travelvisa', amount: 'x' }], trust: 'calculated' });
  ok(bad.minimum.amount === null && bad.minimumCovered.value === 'unknown', 'an unreadable minimum row: null, covered unknown');
  const exact = line(x, 'travelvisa', { cardMinimums: [{ debtId: 'travelvisa', amount: 100 }], trust: 'calculated' });
  ok(exact.minimumCovered.value === true, 'paid exactly the minimum (100 >= 100) covers it');
}

console.log('3. A future period is upcoming');
{
  const x = fx.fixture(); x.window = F.spendingCycle(x.plan, '2026-08-28');
  const all = lines(x);
  ok(all.every(c => c.status === 'upcoming' && c.toGo.amount === null && c.toGo.reasons.includes('future-period')),
    'every line is upcoming, with no to-go amount');
  ok(line(x, 'travelvisa').minimum.amount === 25 && line(x, 'travelvisa').minimumCovered.value === 'unknown',
    'a future minimum is shown; whether it is covered is unknown');
}

console.log('4. A6 is unchanged');
{
  const x = fx.fixture();
  const a6 = F.stackCardSummary(publish(x));
  ok(!a6.some(c => c.id === 'heloc') && a6.every(c => !('minimum' in c) && !('status' in c)),
    'stackCardSummary still publishes the five cards without the A6b fields');
  const t = line(x, 'travelvisa'), base = a6.find(c => c.id === 'travelvisa');
  ok(same([t.paid, t.spent, t.net, t.state, t.transactions], [base.paid, base.spent, base.net, base.state, base.transactions]),
    'stackCreditLines carries A6\'s figures as published');
  ok(F.stackCreditLines(null, split) === null, 'anything but a card-period publication publishes nothing');
}

console.log('5. Totals over stated cards, with completeness explicit');
{
  const x = fx.fixture();
  const t = totals(x);
  // Stated: Travel 100 / 207.40, Cash Back 250 / 114.20, Emerald 0 / 0. Triangle and Amazon are unavailable.
  ok(t.paid === 350 && t.spent === 321.6 && t.completeness === 'partial' && same(t.excluded, ['triangle', 'mbna'])
    && same(t.reasons, ['some-cards-unavailable']),
  'partial: paid 100 + 250 + 0 = 350, spent 207.40 + 114.20 + 0 = 321.60, excluding Triangle and Amazon', JSON.stringify(t));
  ok(t.trust === 'estimated', 'trust is the weakest stated line (Travel and Cash Back payments are estimated), not relabelled');
  ok(!t.excluded.includes('heloc'), 'HELOC is never in the totals and never listed as excluded');
  const all = fx.fixture();
  all.packet.syncEvidence.forEach(r => { r.syncEvidence = 'proven'; r.fields.last_fetch = true; });
  const full = totals(all);
  ok(full.completeness === 'complete' && full.excluded.length === 0 && full.reasons.length === 0
    && full.paid === 350 && full.spent === 416.9,
  'complete when every card is stated: spent 321.60 + Triangle 51.30 + Amazon (89.00 - 45.00) = 416.90', JSON.stringify(full));
  const none = fx.fixture(); none.packet.syncEvidence.forEach(r => { r.syncEvidence = 'failed'; });
  const n = totals(none);
  ok(n.paid === null && n.spent === null && n.completeness === 'none' && n.reasons.length > 0
    && same(n.excluded, ['travelvisa', 'cashback', 'tdcc', 'triangle', 'mbna']), 'none: null with reasons, every card excluded');
}

console.log('6. A payment row with no allocation is estimated, never calculated');
{
  const pub = { source: 'Forecast.cardPeriodMovements', currency: 'CAD', role: 'current',
    cards: [{ id: 'travelvisa', label: 'Travel', postedMovement: { trust: 'calculated', completeness: 'complete', reasons: [] },
      posted: [{ id: 'p', date: '2026-08-18', payee: 'Invented', amount: -40, kind: 'payment', pending: false }], pending: [] }] };
  const card = F.stackCardSummary(pub)[0];
  ok(card.paid.amount === 40 && card.paid.trust === 'estimated' && card.paid.reasons.includes('card-payment-unconfirmed'),
    'a payment with no paymentAllocation: paid 40, estimated');
}

console.log('7. Minimum covered takes the weakest of paid and the minimum (lead pre-review gap 2)');
{
  const x = fx.fixture();
  const t = line(x, 'travelvisa');
  ok(t.minimumCovered.value === true && t.minimumCovered.trust === 'estimated',
    'Travel: covered, estimated (paid 100.00 is estimated; the split is calculated), never relabelled calculated');
  const ready = { trust: 'calculated', completeness: 'complete', reasons: [] };
  const pub = { source: 'Forecast.cardPeriodMovements', currency: 'CAD', role: 'current', asOf: '2026-08-20',
    cards: [{ id: 'travelvisa', label: 'Travel', postedMovement: ready, pending: [],
      posted: [{ id: 'c', date: '2026-08-18', payee: 'Invented', amount: 30, kind: 'charge', pending: false },
        { id: 'p', date: '2026-08-18', payee: 'Invented', amount: -40, kind: 'payment', pending: false,
          paymentAllocation: { status: 'reconciled' } }] }] };
  const reconciled = F.stackCreditLines(pub, split).lines[0];
  ok(reconciled.minimumCovered.value === true && reconciled.minimumCovered.trust === 'calculated',
    'a reconciled 40 payment against a calculated 25 minimum: covered, calculated');
  const est = F.stackCreditLines(pub, { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }], trust: 'estimated' }).lines[0];
  ok(est.minimumCovered.trust === 'estimated', 'an estimated minimum makes the verdict estimated');
}

console.log('8. A card with exactly one of paid / spent stated (lead pre-review gap 1)');
{
  const ready = { trust: 'calculated', completeness: 'complete', reasons: [] };
  const row = (id, amount, kind, extra = {}) => ({ id, date: '2026-08-18', payee: 'Invented', amount, kind, pending: false, ...extra });
  const pub = { source: 'Forecast.cardPeriodMovements', currency: 'CAD', role: 'current', asOf: '2026-08-20',
    cards: [
      { id: 'travelvisa', label: 'Travel', postedMovement: ready, pending: [],
        posted: [row('a', 80, 'charge'), row('b', -80, 'payment', { paymentAllocation: { status: 'reconciled' } })] },
      // Cash Back: a reconciled 50 payment and an unconfirmed movement: paid 50 stated, spent null.
      { id: 'cashback', label: 'Cash Back', postedMovement: ready, pending: [],
        posted: [row('c', -50, 'payment', { paymentAllocation: { status: 'reconciled' } }), row('d', 20, 'movement-unconfirmed')] }] };
  const r = F.stackCreditLines(pub, split);
  const c = r.lines.find(l => l.id === 'cashback');
  ok(c.paid.amount === 50 && c.spent.amount === null && c.status === null && c.toGo.amount === null
    && c.statusReasons.includes('card-movement-unconfirmed'), 'one-sided card: status and toGo null, card-movement-unconfirmed');
  ok(r.totals.paid === 80 && r.totals.spent === 80 && r.totals.completeness === 'partial' && same(r.totals.excluded, ['cashback']),
    'the one-sided card is excluded from both totals (80 / 80, partial), never half-counted');
}

console.log('9. The balance snapshot (Dale, 2026-11-20): last balance, its date, and a cautious trust');
{
  const x = fx.fixture();
  const all = lines(x);
  const b = id => all.find(l => l.id === id).balance;
  ok(same(b('travelvisa'), { amount: 927.4, asOf: '2026-08-20', trust: 'calculated', reasons: [] }),
    'Travel: a dated balance in the current cycle reads as published', JSON.stringify(b('travelvisa')));
  ok(same([b('triangle').amount, b('triangle').asOf, b('triangle').trust, b('triangle').reasons],
    [1980, '2026-08-17', 'estimated', ['manual-balance-before-as-of']]),
  'Triangle: a manual balance dated before as-of is the last snapshot, estimated, with its date');
  ok(b('mbna').amount === 760 && b('mbna').asOf === '2026-08-08' && b('mbna').trust === 'estimated',
    'Amazon: last snapshot 760 as of 2026-08-08, estimated');
  ok(all.find(l => l.id === 'triangle').paid.amount === null && all.find(l => l.id === 'triangle').spent.amount === null,
    'a snapshot is a stock: Triangle paid / spent stay null, never inferred from the balance');
  const t = totals(x).balance;
  ok(t.amount === 7031.6 && t.trust === 'estimated' && t.completeness === 'complete' && t.excluded.length === 0,
    'total balance 927.40 + 2264.20 + 1100.00 + 1980.00 + 760.00 = 7031.60, estimated (two stale snapshots)', JSON.stringify(t));
  ok(b('heloc').amount === null && !t.excluded.includes('heloc'), 'HELOC: no snapshot here, and never in the balance total');

  const stale = fx.fixture();
  stale.debts.find(d => d.id === 'travelvisa').statementCloseDay = 18;
  stale.overlay.overlays.find(o => o.locator === 'debts:travelvisa').evidenceDate = '2026-08-10';
  const s = line(stale, 'travelvisa').balance;
  ok(s.amount === 927.4 && s.asOf === '2026-08-10' && s.trust === 'estimated' && s.reasons.includes('balance-before-statement-cycle'),
    'Forecast\'s verdict on the published date (2026-08-10, cycle from 2026-08-18) keeps the balance and makes it estimated', JSON.stringify(s));

  const undated = fx.fixture();
  undated.overlay.overlays = undated.overlay.overlays.filter(o => o.locator !== 'debts:tdcc');
  const u = line(undated, 'tdcc').balance;
  ok(u.amount === 1100 && u.asOf === null && u.trust === 'estimated' && same(u.reasons, ['balance-date-unavailable']),
    'an undated balance is shown, estimated, with balance-date-unavailable', JSON.stringify(u));

  const gone = fx.fixture(); gone.debts.find(d => d.id === 'mbna').balance = null;
  const g = totals(gone).balance;
  ok(line(gone, 'mbna').balance.amount === null && g.completeness === 'partial' && same(g.excluded, ['mbna'])
    && g.amount === 6271.6 && same(g.reasons, ['some-balances-unavailable']),
  'no snapshot at all: null, never 0, and excluded from a partial total (7031.60 - 760.00 = 6271.60)');

  const future = fx.fixture(); future.window = F.spendingCycle(future.plan, '2026-08-28');
  ok(lines(future).every(l => l.balance.amount === null && same(l.balance.reasons, ['not-current-period']))
    && totals(future).balance.completeness === 'none', 'outside the current period: null with not-current-period');
}

console.log('10. Only a fresh balance reads calculated (lead ruling, 2026-11-20); never verified');
{
  const set = (x, id, fields) => Object.assign(x.debts.find(d => d.id === id), fields);
  const evidence = (x, id, day) => { x.overlay.overlays.find(o => o.locator === 'debts:' + id).evidenceDate = day; };
  const cases = [];
  // Fresh (assessed): close day 18, balance stamped 2026-08-19, inside the cycle from 2026-08-18, even if dated before as-of.
  const assessed = fx.fixture(); set(assessed, 'travelvisa', { statementCloseDay: 18, balanceAsOf: '2026-08-19' }); evidence(assessed, 'travelvisa', '2026-08-19');
  cases.push(['assessed, inside the statement cycle', line(assessed, 'travelvisa').balance, 'calculated', []]);
  // Fresh (not assessed): no close day, dated on as-of.
  cases.push(['not assessed, dated on as-of', line(fx.fixture(), 'cashback').balance, 'calculated', []]);
  // Stale: assessed and the published snapshot predates the cycle.
  const old = fx.fixture(); set(old, 'travelvisa', { statementCloseDay: 18 }); evidence(old, 'travelvisa', '2026-08-10');
  cases.push(['before the statement cycle', line(old, 'travelvisa').balance, 'estimated', ['balance-before-statement-cycle']]);
  // Stale: not assessed and dated before as-of.
  const unassessed = fx.fixture(); evidence(unassessed, 'tdcc', '2026-08-15');
  cases.push(['cycle never assessed, dated before as-of', line(unassessed, 'tdcc').balance, 'estimated', ['balance-cycle-unassessed-before-as-of']]);
  // Stale: undated.
  const undated = fx.fixture(); undated.overlay.overlays = undated.overlay.overlays.filter(o => o.locator !== 'debts:tdcc');
  cases.push(['undated', line(undated, 'tdcc').balance, 'estimated', ['balance-date-unavailable']]);
  // Stale: manual, dated before as-of.
  cases.push(['manual, dated before as-of', line(fx.fixture(), 'mbna').balance, 'estimated', ['manual-balance-before-as-of']]);
  for (const [label, b, trust, reasons] of cases)
    ok(b.amount !== null && b.trust === trust && same(b.reasons, reasons), label + ': ' + trust, JSON.stringify(b));
  ok(cases.every(([, b]) => (b.trust === 'calculated') === (b.reasons.length === 0) && b.trust !== 'verified'),
    'calculated exactly when no staleness reason applies; never verified');
}

console.log('11. Trust is judged on the published snapshot date, never a separate stamp (Atlas, #1447)');
{
  const set = (x, id, fields) => Object.assign(x.debts.find(d => d.id === id), fields);
  const evidence = (x, id, day) => { x.overlay.overlays.find(o => o.locator === 'debts:' + id).evidenceDate = day; };
  // Atlas's case: cycle from 08-18, internal stamp 08-19 (fresh), published observation 08-10 (stale).
  const freshStamp = fx.fixture(); set(freshStamp, 'travelvisa', { statementCloseDay: 18, balanceAsOf: '2026-08-19' });
  evidence(freshStamp, 'travelvisa', '2026-08-10');
  const a = line(freshStamp, 'travelvisa').balance;
  ok(a.asOf === '2026-08-10' && a.trust === 'estimated' && same(a.reasons, ['balance-before-statement-cycle']),
    'a fresh stamp (08-19) does not lift a stale published snapshot (08-10): estimated', JSON.stringify(a));
  // The aggregate inherits it even when every other line is fresh.
  freshStamp.debts.filter(d => ['triangle', 'mbna'].includes(d.id)).forEach(d => { d.evidenceDate = '2026-08-20'; });
  freshStamp.overlay.overlays.filter(o => ['debts:triangle', 'debts:mbna'].includes(o.locator)).forEach(o => { o.evidenceDate = '2026-08-20'; });
  const others = lines(freshStamp).filter(l => l.id !== 'travelvisa' && l.id !== 'heloc');
  ok(others.every(l => l.balance.trust === 'calculated') && totals(freshStamp).balance.trust === 'estimated'
    && totals(freshStamp).balance.completeness === 'complete',
  'the complete total inherits the one stale line: estimated, though every other line is calculated');
  // The other direction: a stale stamp (08-10) with a published snapshot inside the cycle (08-19) is current.
  const staleStamp = fx.fixture(); set(staleStamp, 'travelvisa', { statementCloseDay: 18, balanceAsOf: '2026-08-10' });
  evidence(staleStamp, 'travelvisa', '2026-08-19');
  const b = line(staleStamp, 'travelvisa').balance;
  ok(b.asOf === '2026-08-19' && b.trust === 'calculated' && b.reasons.length === 0,
    'a stale stamp does not drag down a published snapshot inside the cycle (08-19): calculated', JSON.stringify(b));
  // Same date, inside the cycle: the control.
  const control = fx.fixture(); set(control, 'travelvisa', { statementCloseDay: 18, balanceAsOf: '2026-08-19' });
  evidence(control, 'travelvisa', '2026-08-19');
  ok(line(control, 'travelvisa').balance.trust === 'calculated', 'same-date control (08-19, cycle from 08-18): calculated');
  // Future fallback: no matching overlay, debt evidence dated 08-21 for an 08-20 observation.
  const future = fx.fixture(); set(future, 'tdcc', { evidenceDate: '2026-08-21' });
  future.overlay.overlays = future.overlay.overlays.filter(o => o.locator !== 'debts:tdcc');
  const f = line(future, 'tdcc').balance;
  ok(f.amount === 1100 && f.asOf === '2026-08-21' && f.trust === 'estimated' && same(f.reasons, ['balance-date-after-as-of'])
    && totals(future).balance.trust === 'estimated', 'a snapshot dated after as-of (08-21) is unproven: estimated, and so is the total', JSON.stringify(f));
  const futureAssessed = fx.fixture(); set(futureAssessed, 'tdcc', { evidenceDate: '2026-08-21', statementCloseDay: 18 });
  futureAssessed.overlay.overlays = futureAssessed.overlay.overlays.filter(o => o.locator !== 'debts:tdcc');
  ok(same(line(futureAssessed, 'tdcc').balance.reasons, ['balance-date-after-as-of']), 'after as-of is never current, assessed cycle or not');
  // No Forecast verdict at all (a hand-built publication): never current.
  const pub = { source: 'Forecast.cardPeriodMovements', currency: 'CAD', role: 'current', asOf: '2026-08-20',
    cards: [{ id: 'travelvisa', label: 'Travel', postedMovement: { trust: 'calculated', completeness: 'complete', reasons: [] },
      posted: [], pending: [], reportedBalance: { amount: 500, date: '2026-08-20', status: 'dated' } }] };
  const n = F.stackCreditLines(pub, split).lines[0].balance;
  ok(n.amount === 500 && n.trust === 'estimated' && same(n.reasons, ['balance-assessment-unavailable']),
    'a snapshot with no Forecast verdict reads estimated, never calculated', JSON.stringify(n));
}

console.log('7. minimums due: over the spend cards the paid total is over (the HELOC is out), and covered over due');
{
  const x = fx.fixture();
  const t = totals(x);
  // Travel 25 (covered) and Cash Back 300 (not covered) have a minimum due; Emerald, Triangle and Amazon Mastercard have none
  // in the split (no-minimum-due-in-period); the HELOC's 50 is in the waterfall's Credit line, not here.
  ok(t.minimumsDue.amount === 325 && t.minimumsDue.trust === 'calculated' && same(t.minimumsDue.reasons, []),
    'minimumsDue is 325 (25 + 300): the spend cards\' published minimums, the HELOC\'s 50 left out', JSON.stringify(t.minimumsDue));
  ok(t.minimumsDueCount === 2 && t.minimumsCoveredCount === 1 && t.minimumsCoveredTrust === 'estimated',
    'two minimums are due and one is covered (Travel), so a covered / due bar is not full', JSON.stringify([t.minimumsDueCount, t.minimumsCoveredCount]));
  const allCovered = totals(x, { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }], trust: 'calculated' });
  ok(allCovered.minimumsDue.amount === 25 && allCovered.minimumsDueCount === 1 && allCovered.minimumsCoveredCount === 1,
    'one due minimum, covered: covered equals due (the only case a bar is full)');
  const untracked = totals(x, { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }, { debtId: 'mbna', amount: 400 }], trust: 'calculated' });
  ok(untracked.minimumsDue.amount === 425 && untracked.minimumsDueCount === 2 && untracked.minimumsCoveredCount === 1,
    'a card with a minimum due but no paid / spent evidence (unknown coverage) counts as due and not covered');
  const none = totals(x, { cardMinimums: [{ debtId: 'heloc', amount: 50 }], trust: 'calculated' });
  ok(none.minimumsDue.amount === 0 && none.minimumsDueCount === 0 && none.minimumsCoveredCount === 0,
    'only the HELOC has a minimum: none due on the spend cards (a published 0, 0 of 0)');
  for (const [label, bills] of [['a withheld bills split', null], ['an unqualified minimum amount', { cardMinimums: [{ debtId: 'travelvisa', amount: 'x' }], trust: 'calculated' }]]) {
    const w = totals(x, bills);
    ok(w.minimumsDue.amount === null && w.minimumsDue.trust === 'unavailable' && w.minimumsDue.reasons.length > 0
      && w.minimumsDueCount === null && w.minimumsCoveredCount === null, label + ': minimumsDue and both counts are withheld, never a partial sum', JSON.stringify(w.minimumsDue));
  }
  const soft = totals(x, { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }, { debtId: 'cashback', amount: 300 }], trust: 'estimated' });
  ok(soft.minimumsDue.trust === 'estimated' && soft.minimumsCoveredTrust === 'estimated', 'the weakest input\'s trust carries through');
  // A published $0 minimum is nothing owed: out of the sum and both counts (Travel's is 0, Cash Back's is 300).
  const zero = totals(x, { cardMinimums: [{ debtId: 'travelvisa', amount: 0 }, { debtId: 'cashback', amount: 300 }], trust: 'calculated' });
  ok(zero.minimumsDue.amount === 300 && zero.minimumsDueCount === 1 && zero.minimumsCoveredCount === 0,
    'a $0 minimum is not due: it is left out of minimumsDue and both counts', JSON.stringify([zero.minimumsDue.amount, zero.minimumsDueCount, zero.minimumsCoveredCount]));
  // A covered check counts only on trust Forecast stands behind. A split trust of 'unavailable', or any unrecognised word, makes
  // every covered check's trust 'unavailable' (never silently dropped), so none counts as covered.
  for (const word of ['unavailable', 'unknown']) {
    const weak = totals(x, { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }, { debtId: 'cashback', amount: 300 }], trust: word });
    ok(weak.minimumsDueCount === 2 && weak.minimumsCoveredCount === 0 && weak.minimumsCoveredTrust === 'unavailable',
      'a bills split trusted as \'' + word + '\': both minimums are due and none counts as covered, though Travel\'s published check reads true', JSON.stringify([weak.minimumsDueCount, weak.minimumsCoveredCount, weak.minimumsCoveredTrust]));
    ok(line(x, 'travelvisa', { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }], trust: word }).minimumCovered.trust === 'unavailable',
      'the covered check\'s trust is \'unavailable\' for a split trusted as \'' + word + '\' (an unrecognised word is the weakest, not dropped)');
  }
  // membership: the paid total and the minimums due are over the same cards (the spend cards), never the HELOC
  ok(!JSON.stringify(t.excluded).includes('heloc') && t.minimumsDue.amount !== 375, 'the HELOC is in neither total');
}

console.log(`\nAll stack credit line checks passed (${checks}).`);
