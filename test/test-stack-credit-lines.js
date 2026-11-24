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
 * Path: the invented card week (test/fixtures/stack-card-week.js) -> Forecast.cardPeriodMovements ->
 * Forecast.stackCreditLines, with an invented bills split. By hand (posted rows only):
 *   Travel: paid 100.00, spent 236.00 (207.40 posted + the pending 28.60, Dale 2026-11-22) -> to-go 136.00. Minimum 25 -> covered (100 >= 25).
 *   Cash Back: paid 250.00, spent 114.20 -> paid-back, toGo 0. Minimum 300 -> not covered (250 < 300).
 *   Emerald: 0 / 0 -> paid-back. No minimum row -> minimum null, covered unknown.
 *   Triangle, Amazon Mastercard: paid / spent unavailable -> status null, covered unknown.
 *   HELOC: minimum 50 from the split; paid / spent not published -> status null, covered unknown.
 *
 * `node test/test-stack-credit-lines.js`
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const fx = require('./fixtures/stack-card-week');

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
  ok(t.status === 'to-go' && t.toGo.amount === 136 && t.toGo.trust === 'estimated',
    'Travel: to-go 236.00 - 100.00 = 136.00, estimated (a pending charge and an unreconciled payment)', JSON.stringify(t.toGo));
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
  // Stated: Travel 100 / 236.00 (its pending 28.60 counts), Cash Back 250 / 114.20, Emerald 0 / 0. Triangle and Amazon are unavailable.
  ok(t.paid === 350 && t.spent === 350.2 && t.completeness === 'partial' && same(t.excluded, ['triangle', 'mbna'])
    && same(t.reasons, ['some-cards-unavailable']),
  'partial: paid 100 + 250 + 0 = 350, spent 236.00 + 114.20 + 0 = 350.20, excluding Triangle and Amazon', JSON.stringify(t));
  ok(t.trust === 'estimated', 'trust is the weakest stated line (Travel and Cash Back payments are estimated), not relabelled');
  ok(!t.excluded.includes('heloc'), 'HELOC is never in the totals and never listed as excluded');
  const all = fx.fixture();
  all.packet.syncEvidence.forEach(r => { r.syncEvidence = 'proven'; r.fields.last_fetch = true; });
  const full = totals(all);
  ok(full.completeness === 'complete' && full.excluded.length === 0 && full.reasons.length === 0
    && full.paid === 350 && full.spent === 445.5,
  'complete when every card is stated: spent 350.20 + Triangle 51.30 + Amazon 44.00 = 445.50', JSON.stringify(full));
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
      payerPaid: { amount: 40, trust: 'calculated', reasons: [] },
      posted: [{ id: 'c', date: '2026-08-18', payee: 'Invented', amount: 30, kind: 'charge', pending: false },
        { id: 'p', date: '2026-08-18', payee: 'Invented', amount: -40, kind: 'payment', pending: false,
          paymentAllocation: { status: 'reconciled' } }] }] };
  const reconciled = F.stackCreditLines(pub, split).lines[0];
  ok(reconciled.minimumCovered.value === true && reconciled.minimumCovered.trust === 'calculated',
    'an exact payer-note payment of 40 against a calculated 25 minimum: covered, calculated');
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

console.log('7. minimums due: over every listed credit line, the HELOC included (one membership for Credit, ATLAS LEAD 12, 2026-11-22), and covered over due');
{
  const x = fx.fixture();
  const t = totals(x);
  // Travel 25 (covered) and Cash Back 300 (not covered) have a minimum due; Emerald, Triangle and Amazon Mastercard have none
  // in the split (no-minimum-due-in-period); the HELOC's 50 is due too, the same rows the waterfall's Credit line sums.
  ok(t.minimumsDue.amount === 375 && t.minimumsDue.trust === 'calculated' && same(t.minimumsDue.reasons, []),
    'minimumsDue is 375 (25 + 300 + 50): every listed line\'s published minimum, the HELOC\'s included', JSON.stringify(t.minimumsDue));
  ok(t.minimumsDueCount === 3 && t.minimumsCoveredCount === 1 && t.minimumsCoveredTrust === 'estimated',
    'three minimums are due and one is covered (Travel; a HELOC\'s coverage is not published, so it never counts covered)', JSON.stringify([t.minimumsDueCount, t.minimumsCoveredCount]));
  const allCovered = totals(x, { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }], trust: 'calculated' });
  ok(allCovered.minimumsDue.amount === 25 && allCovered.minimumsDueCount === 1 && allCovered.minimumsCoveredCount === 1,
    'one due minimum, covered: covered equals due (the only case a bar is full)');
  const untracked = totals(x, { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }, { debtId: 'mbna', amount: 400 }], trust: 'calculated' });
  ok(untracked.minimumsDue.amount === 425 && untracked.minimumsDueCount === 2 && untracked.minimumsCoveredCount === 1,
    'a card with a minimum due but no paid / spent evidence (unknown coverage) counts as due and not covered');
  const none = totals(x, { cardMinimums: [{ debtId: 'heloc', amount: 50 }], trust: 'calculated' });
  ok(none.minimumsDue.amount === 50 && none.minimumsDueCount === 1 && none.minimumsCoveredCount === 0,
    'only the HELOC has a minimum: its 50 is due, and it never counts covered', JSON.stringify([none.minimumsDue.amount, none.minimumsDueCount, none.minimumsCoveredCount]));
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
  // membership: the minimums due span every listed line (the HELOC included); the HELOC is never listed as excluded
  ok(!JSON.stringify(t.excluded).includes('heloc') && t.minimumsDue.amount === 375, 'the HELOC is in the minimums due and never listed as excluded');
}

console.log('12. minimums paid: the paid side of the Credit head, over exactly the cards whose minimums are due (Dale, 2026-11-20)');
{
  // A future period or current manual card with missing payer history keeps its estimated zero fallback.
  // For a tracked card, incomplete paying-side history withholds the amount.
  const x = fx.fixture();
  const mp = (bills, world = x) => totals(world, bills).minimumsPaid;
  const due = cm => ({ cardMinimums: cm, trust: 'calculated' });
  // By hand, on the invented card week: Travel paid 100 and Cash Back paid 250 (both payer notes are by amount, so estimated), the Emerald
  // card (id tdcc) has no named payer debit. Triangle and Amazon lack a receiving ledger.
  const both = mp(split);
  ok(both.amount === 350 && both.trust === 'estimated' && same(both.reasons, ['card-payment-by-amount', 'paid-unavailable-counted-as-zero', 'heloc-not-observed']),
    'Travel (25 due), Cash Back (300 due) and the HELOC (50 due): 100 + 250 + an unseen HELOC counted 0 = 350, estimated', JSON.stringify(both));
  ok(mp(due([{ debtId: 'travelvisa', amount: 25 }])).amount === 100,
    'an overpaid card counts its full paid, uncapped: Travel paid 100 against a 25 minimum reads 100, like its own row');
  const nothing = mp(due([{ debtId: 'tdcc', amount: 40 }]));
  ok(nothing.amount === 0 && nothing.trust === 'estimated' && same(nothing.reasons, ['no-confirmed-paying-side-payments']) && totals(x, due([{ debtId: 'tdcc', amount: 40 }])).minimumsDue.amount === 40,
    'no confirmed payer debit on the due card: an estimated zero over its 40', JSON.stringify(nothing));
  const seen = fx.fixture(); seen.packet.syncEvidence.forEach(r => { r.syncEvidence = 'proven'; r.fields.last_fetch = true; });
  const seenNothing = mp(due([{ debtId: 'triangle', amount: 40 }, { debtId: 'mbna', amount: 10 }]), seen);
  ok(seenNothing.amount === 0 && seenNothing.trust === 'estimated' && same(seenNothing.reasons, ['no-confirmed-paying-side-payments']),
    'even with proven card sync, no named payer debit for either due card yields an estimated zero', JSON.stringify(seenNothing));
  const seenMixed = mp(due([{ debtId: 'travelvisa', amount: 25 }, { debtId: 'triangle', amount: 40 }]), seen);
  ok(seenMixed.amount === 100 && seenMixed.trust === 'estimated' && same(seenMixed.reasons, ['card-payment-by-amount', 'no-confirmed-paying-side-payments']),
    'a by-amount payer note keeps its estimated amount: Travel 100 + Triangle 0, estimated', JSON.stringify(seenMixed));
  // A current manual card can have fully observed paying-side evidence even without a receiving ledger.
  const manualBills = due([{ debtId: 'triangle', amount: 400 }]);
  const manual = mp(manualBills);
  ok(manual.amount === 0 && manual.trust === 'estimated' && same(manual.reasons, ['no-confirmed-paying-side-payments']),
    'a complete payer ledger has no payment to Triangle, independent of its missing card ledger', JSON.stringify(manual));
  const withUnseen = mp(due([{ debtId: 'travelvisa', amount: 25 }, { debtId: 'triangle', amount: 400 }]));
  ok(withUnseen.amount === 100 && withUnseen.trust === 'estimated' && same(withUnseen.reasons, ['card-payment-by-amount', 'no-confirmed-paying-side-payments']),
    'Travel’s by-amount payer note and no payment to Triangle: 100 + 0, estimated', JSON.stringify(withUnseen));
  // Upcoming period: nothing is observed yet; the cards count $0 the same way.
  const future = fx.fixture(); future.window = F.spendingCycle(future.plan, '2026-08-28');
  const futureMp = mp(due([{ debtId: 'travelvisa', amount: 25 }, { debtId: 'triangle', amount: 400 }]), future);
  ok(F.stackCreditLines(publish(future), split).lines.every(l => l.status === 'upcoming') && futureMp.amount === 0 && futureMp.trust === 'estimated',
    'an upcoming period (nothing observed yet): $0 over the minimums due, estimated in the data', JSON.stringify(futureMp));
  const receivingFailure = fx.fixture();
  receivingFailure.packet.syncEvidence.filter(r => r.role === 'revolving-credit').forEach(r => { r.syncEvidence = 'failed'; });
  const travelDue = due([{ debtId: 'travelvisa', amount: 25 }]);
  ok(mp(travelDue, receivingFailure).amount === 100,
    'a failed receiving-card sync cannot erase a posted named debit from the paying account');
  const failed = fx.fixture();
  failed.packet.transactionWindow.complete = false;
  const failedTravel = mp(travelDue, failed);
  ok(failedTravel.amount === null && failedTravel.trust === 'unavailable' && failedTravel.reasons.includes('paying-side-coverage-incomplete'),
    'incomplete payer history withholds the tracked card’s paid amount', JSON.stringify(failedTravel));
  ok(mp(due([{ debtId: 'travelvisa', amount: 25 }, { debtId: 'triangle', amount: 40 }]), failed).amount === null,
    'one withheld due card withholds the sum, including when another card is manual');
  const manualFallback = mp(manualBills, failed);
  ok(manualFallback.amount === 0 && manualFallback.trust === 'estimated'
    && manualFallback.reasons.includes('paid-unavailable-counted-as-zero') && manualFallback.reasons.includes('paying-side-coverage-incomplete'),
    'a current manual card with incomplete payer history keeps its estimated zero fallback', JSON.stringify(manualFallback));
  // A past period with incomplete posted coverage keeps the dash.
  const past = fx.fixture(); past.window = F.spendingCycle(past.plan, '2026-07-20');
  const pastMp = mp(due([{ debtId: 'travelvisa', amount: 25 }, { debtId: 'cashback', amount: 300 }]), past);
  ok(F.stackCreditLines(publish(past), split).lines.every(l => l.status !== 'upcoming') && pastMp.amount === null && pastMp.trust === 'unavailable'
    && pastMp.reasons[0] === 'paid-unavailable' && pastMp.reasons.includes('paying-side-coverage-incomplete'),
  'a past period with no payer coverage: withheld with paying-side-coverage-incomplete, never $0 (a $0 there could hide a real payment)', JSON.stringify(pastMp));
  const helocOnly = mp(due([{ debtId: 'heloc', amount: 50 }]));
  ok(helocOnly.amount === 0 && helocOnly.trust === 'estimated' && same(helocOnly.reasons, ['paid-unavailable-counted-as-zero', 'heloc-not-observed'])
    && totals(x, due([{ debtId: 'heloc', amount: 50 }])).minimumsDue.amount === 50,
    'only the HELOC due (no HELOC publication card): its 50 is due, and its paid side is an estimated $0 with its reason, never more certain', JSON.stringify(helocOnly));
  const zeroMin = mp(due([{ debtId: 'tdcc', amount: 40 }, { debtId: 'triangle', amount: 0 }]));
  ok(zeroMin.amount === 0 && same(zeroMin, nothing), 'adding a card with a zero minimum leaves the due card’s paid amount and trust intact', JSON.stringify(zeroMin));
  const off = mp(null);
  ok(off.amount === null && off.trust === 'unavailable' && off.reasons.length > 0,
    'the minimums due withheld: the paid side is withheld with them', JSON.stringify(off));
  ok(totals(x, due([{ debtId: 'travelvisa', amount: 25 }])).paid === 350 && mp(due([{ debtId: 'travelvisa', amount: 25 }])).amount === 100,
    'minimumsPaid is not totals.paid: with only Travel due, all payments to the stated cards are 350 and the paid toward the due card is 100');
  // MUTANTS
  const Module = require('module'), fs = require('node:fs'), pathMod = require('node:path');
  const file = require.resolve('../public/forecast-card-period.js');
  const src = fs.readFileSync(file, 'utf8');
  const load = text => { const m = new Module(file, null); m.filename = file; m.paths = Module._nodeModulePaths(pathMod.dirname(file)); m._compile(text, file); return m.exports; };
  const guard = "future || (publication.role === 'current' && pubCard?.manualStatement === true)";
  ok(src.includes(guard), 'the mutants target the per-line manual fallback');
  const pastManual = mp(manualBills, past);
  ok(pastManual.amount === null && pastManual.reasons[0] === 'paid-unavailable', 'a manual card in a past period with missing payer history is withheld', JSON.stringify(pastManual));
  const noPast = load(src.replace(guard, 'future || pubCard?.manualStatement === true'));
  ok(noPast.stackCreditLines(publish(past), manualBills).totals.minimumsPaid.amount === 0,
    'MUTANT: applying the manual fallback in a past period hides missing history');
  const feedAsZero = load(src.replace(guard, 'true'));
  ok(feedAsZero.stackCreditLines(publish(failed), travelDue).totals.minimumsPaid.amount === 0,
    'MUTANT: applying the manual fallback to a tracked card hides missing payer history');
  const dashEverywhere = load(src.replace(guard, 'false'));
  ok(dashEverywhere.stackCreditLines(publish(failed), manualBills).totals.minimumsPaid.amount === null,
    'MUTANT: removing the fallback withholds a current manual card with incomplete payer evidence');
  const lies = load(src.replace("trust: dueLines.length ? weakest(...dueLines.map(line => line.paidToward.trust)) : splitTrust,", "trust: 'calculated',"));
  ok(lies.stackCreditLines(publish(failed), manualBills).totals.minimumsPaid.trust === 'calculated',
    'MUTANT: a trust word of calculated on an unseen card reads calculated, which the honest-trust checks above reject');
}

console.log('13. paidToward: one published paid figure per line, read by the row and summed by the head (Dale, 2026-11-20)');
{
  const lineOf = (world, id, bills = split) => F.stackCreditLines(publish(world), bills).lines.find(l => l.id === id);
  const toward = (world, id, bills) => lineOf(world, id, bills).paidToward;
  const x = fx.fixture();
  // Spend cards read their paying-side evidence independently of the state of the receiving ledger.
  ok(same([toward(x, 'travelvisa').amount, toward(x, 'travelvisa').trust], [100, 'estimated']) && same([toward(x, 'tdcc').amount, toward(x, 'tdcc').trust], [0, 'estimated']),
    'the by-amount Travel payer note and the quiet Emerald payer ledger both carry estimated trust');
  const tri = toward(x, 'triangle'), mb = toward(x, 'mbna');
  ok(tri.amount === 0 && tri.trust === 'estimated' && same(tri.reasons, ['no-confirmed-paying-side-payments']) && same([mb.amount, mb.trust], [0, 'estimated']),
    'the complete payer ledger has no payment to either manual card', JSON.stringify([tri, mb]));
  const failed = fx.fixture(); failed.packet.transactionWindow.complete = false;
  const ft = toward(failed, 'travelvisa');
  ok(ft.amount === null && ft.trust === 'unavailable' && ft.reasons.includes('paying-side-coverage-incomplete'),
    'a tracked card with incomplete payer history is withheld', JSON.stringify(ft));
  // The HELOC: observed (its publication card, posted coverage complete) reads the sum of its posted payment rows, $0 with none.
  const helocWorld = (rows, sync = 'proven') => {
    const w = fx.fixture();
    if (sync !== 'missing') w.packet.syncEvidence.push({ id: 'heloc', role: 'heloc', syncEvidence: sync, fields: { last_fetch: sync === 'proven', plaid_last_successful_update: false, status: false } });
    w.debts.push({ id: 'heloc', label: 'Example HELOC', structure: 'HELOC', secured: true, limit: 20000, pending: 0, rate: 7, balance: 9000 });
    w.overlay.overlays.push({ locator: 'debts:heloc', field: 'balance', proposedValue: 9000, evidenceDate: w.asOf });
    rows.forEach(([id, date, amount, kindHint]) => w.packet.transactions.push({ id, coverageRef: 'invented-' + id, atlasAccountId: 'heloc', account: 'heloc',
      accountRole: 'heloc', date, amount, currency: 'cad', displayedPayee: 'Example HELOC', kindHint, pending: false, savingsPostingEvidence: 'posted' }));
    return w;
  };
  const none = toward(helocWorld([]), 'heloc');
  ok(none.amount === 0 && none.trust === 'estimated' && same(none.reasons, []), 'HELOC with its sync proven, nothing posted: a known $0 (published, no counted-as-zero reason)', JSON.stringify(none));
  // Its own sync row is read as the cards' is: proven stands; absent or missing is an unseen card; an explicit failure withholds.
  for (const state of ['absent', 'missing']) {
    const z = toward(helocWorld([], state), 'heloc');
    ok(z.amount === 0 && z.trust === 'estimated' && z.reasons[0] === 'paid-unavailable-counted-as-zero' && z.reasons.includes('heloc-sync-unproven'),
      'HELOC sync ' + state + ', nothing posted: $0 counted as zero, estimated, with its reason (the manual-card rule)', JSON.stringify(z));
  }
  const shown = toward(helocWorld([['heloc-pay', '2026-08-18', -150, 'payment']], 'absent'), 'heloc');
  ok(shown.amount === 150 && shown.trust === 'estimated' && same(shown.reasons, ['heloc-sync-unproven']),
    'HELOC sync absent but a payment is posted: the payment the ledger shows (150), estimated, with the reason (never hidden as $0)', JSON.stringify(shown));
  const failedSync = toward(helocWorld([], 'failed'), 'heloc');
  ok(failedSync.amount === null && failedSync.trust === 'unavailable' && failedSync.reasons.includes('sync-failed'),
    'HELOC sync explicitly failed: withheld (missing data), never $0', JSON.stringify(failedSync));
  const paid = toward(helocWorld([['heloc-pay', '2026-08-18', -150, 'payment'], ['heloc-interest', '2026-08-19', 22.5, 'interest']]), 'heloc');
  ok(paid.amount === 150 && paid.trust === 'estimated', 'HELOC observed with a posted payment of 150 and an interest charge: paid is 150 (interest is not a payment)', JSON.stringify(paid));
  const two = toward(helocWorld([['heloc-pay-1', '2026-08-16', -150, 'payment'], ['heloc-pay-2', '2026-08-19', -40, 'bill-payment']]), 'heloc');
  ok(two.amount === 190, 'two posted payments: 150 + 40 = 190', JSON.stringify(two));
  const unlabelled = toward(helocWorld([['heloc-credit', '2026-08-18', -150, undefined]]), 'heloc');
  ok(unlabelled.amount === null && unlabelled.reasons.includes('card-credit-purpose-unconfirmed'), 'an unlabelled credit on the HELOC is not a known payment: withheld', JSON.stringify(unlabelled));
  const partial = helocWorld([]); partial.packet.transactionCoverage = 'incomplete';
  const pc = toward(partial, 'heloc');
  ok(pc.amount === null && pc.reasons.includes('posted-coverage-incomplete'), 'HELOC with incomplete posted coverage: withheld (missing history), never $0', JSON.stringify(pc));
  const unobserved = toward(x, 'heloc');
  ok(unobserved.amount === 0 && unobserved.trust === 'estimated' && unobserved.reasons.includes('heloc-not-observed'), 'no HELOC publication card (its account is not observed): $0, estimated, with its reason', JSON.stringify(unobserved));
  const future = helocWorld([]); future.window = F.spendingCycle(future.plan, '2026-08-28');
  const past = helocWorld([]); past.window = F.spendingCycle(past.plan, '2026-07-20');
  ok(toward(future, 'heloc').amount === 0 && toward(past, 'heloc').amount === null && toward(past, 'heloc').reasons.includes('not-current-period'),
    'HELOC: an upcoming period reads $0; a past period is missing history and is withheld');
  // The head is the sum of every due line's paidToward, the HELOC's included (one membership for Credit), so the rows always add up to it.
  const worlds = [['current', x], ['payer coverage incomplete', failed], ['HELOC paid', helocWorld([['heloc-pay', '2026-08-18', -150, 'payment']])], ['past', past], ['upcoming', future]];
  const bills = { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }, { debtId: 'cashback', amount: 300 }, { debtId: 'triangle', amount: 400 }, { debtId: 'heloc', amount: 50 }], trust: 'calculated' };
  for (const [label, w] of worlds) {
    const r = F.stackCreditLines(publish(w), bills);
    const dueRows = r.lines.filter(l => l.minimum.amount !== null && l.minimum.amount > 0);
    const sum = dueRows.every(l => l.paidToward.amount !== null) ? dueRows.reduce((a, l) => a + Math.round(l.paidToward.amount * 100), 0) / 100 : null;
    ok(r.totals.minimumsPaid.amount === sum, label + ': the head\'s minimumsPaid is the sum of the due rows\' paidToward (' + sum + '), the HELOC\'s included', JSON.stringify(r.totals.minimumsPaid));
  }
  const helocPaidWorld = F.stackCreditLines(publish(helocWorld([['heloc-pay', '2026-08-18', -150, 'payment']])), bills);
  ok(helocPaidWorld.lines.find(l => l.id === 'heloc').paidToward.amount === 150 && helocPaidWorld.totals.minimumsPaid.trust === 'estimated',
    'a HELOC payment enters the head with the HELOC\'s minimum (one membership), and the head stays estimated', JSON.stringify(helocPaidWorld.totals.minimumsPaid));
  // MUTANTS
  const Module = require('module'), fs = require('node:fs'), pathMod = require('node:path');
  const file = require.resolve('../public/forecast-card-period.js');
  const src = fs.readFileSync(file, 'utf8');
  const load = text => { const m = new Module(file, null); m.filename = file; m.paths = Module._nodeModulePaths(pathMod.dirname(file)); m._compile(text, file); return m.exports; };
  const covGuard = "if (pubCard.postedCoverage !== 'complete-provider-response') gaps.push('posted-coverage-incomplete');";
  const obsGuard = "if (!pubCard) return countedZero(['heloc-not-observed']);";
  ok(src.includes(covGuard) && src.includes(obsGuard), 'the HELOC mutants target the coverage and observation guards');
  const reasonGaps = "const gaps = (Array.isArray(pubCard.reasons) ? pubCard.reasons : []).filter(r => r !== 'opening-unavailable' && r !== 'closing-unavailable');";
  ok(src.includes(reasonGaps), 'the HELOC mutant also targets the publication-reasons guard');
  const noCov = load(src.replace(covGuard, '').replace(reasonGaps, 'const gaps = [];'));
  ok(noCov.stackCreditLines(publish(partial), bills).lines.find(l => l.id === 'heloc').paidToward.amount === 0,
    'MUTANT: with no coverage check at all (neither the explicit one nor the publication\'s reasons) an incomplete-coverage HELOC reads $0, which the incomplete-coverage check above rejects');
  const noObs = load(src.replace(obsGuard, "if (!pubCard) return withheldPaid(['heloc-not-observed']);"));
  ok(noObs.stackCreditLines(publish(x), bills).lines.find(l => l.id === 'heloc').paidToward.amount === null,
    'MUTANT: withholding for an unobserved HELOC reads a dash, which the not-observed check above rejects');
  const syncGuard = "if (pubCard.syncState === 'proven') return { amount: paidCents / 100, trust: 'estimated', reasons: [] };";
  ok(src.includes(syncGuard), 'the HELOC sync mutants target the proven guard');
  const syncIgnored = load(src.replace(syncGuard, "return { amount: paidCents / 100, trust: 'estimated', reasons: [] };"));
  ok(same(syncIgnored.stackCreditLines(publish(helocWorld([], 'absent')), bills).lines.find(l => l.id === 'heloc').paidToward.reasons, []),
    'MUTANT: ignoring the HELOC sync row makes an unproven $0 look known (no reason), which the sync-absent check above rejects');
  const failIgnored = load(src.replace("if (pubCard.syncState === 'failed') gaps.push('sync-failed');", ''));
  ok(failIgnored.stackCreditLines(publish(helocWorld([], 'failed')), bills).lines.find(l => l.id === 'heloc').paidToward.amount === 0,
    'MUTANT: ignoring an explicit HELOC sync failure reads $0, which the failed-sync check above rejects');
  const interestAsPaid = load(src.replace("if (row.kind === 'payment') paidCents += -value;", "if (row.kind === 'payment' || row.kind === 'interest') paidCents += -value;"));
  ok(interestAsPaid.stackCreditLines(publish(helocWorld([['heloc-pay', '2026-08-18', -150, 'payment'], ['heloc-interest', '2026-08-19', 22.5, 'interest']])), bills).lines.find(l => l.id === 'heloc').paidToward.amount === 127.5,
    'MUTANT: counting HELOC interest as a payment reads 127.5, which the interest check above rejects');
}

console.log(`\nAll stack credit line checks passed (${checks}).`);
