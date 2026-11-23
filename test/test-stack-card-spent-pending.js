'use strict';
/* A card's Spent and Paid count its pending rows, never twice (Dale, 2026-11-22: "we can say with high confidence that
 * that pending charge will eventually be a cost and it can count towards the spend. It's just when the actual charge
 * comes in, I don't want to have that doubled up"; dispatched by ATLAS LEAD 12).
 *
 *   1. Invariant: one invented charge followed through its life (pending only -> pending and its posted twin -> posted
 *      only) adds the same amount to Spent at every step, never doubled. The twin is paired by Forecast's existing
 *      pairing, both by the provider's pendingPostedDuplicate flags and by the household budget's own key pairing.
 *   2. Trust: a Spent or Paid that a pending row adds to reads estimated, never calculated; posted only stays calculated.
 *   3. Reversal pair: a pending charge and a same-amount pending credit count as the ledger has them. A credit the ledger
 *      marks a refund nets the charge out; an unlabelled credit withholds the figure, as the same row does when posted.
 *      Which row of the pair is real is the ledger's call (rule 17, Grok Bot), never decided here.
 *   4. A posted amount that differs from its pending (a tip, a hold): the existing pairing does not pair them, so both
 *      count (a known limit, stated in the merge card).
 *   5. A lone pending/posted flag (no twin) still withholds the figure; an ambiguous pair still withholds.
 *   6. A pending payment counts in Paid, estimated. The posted movement and the HELOC stay posted-only.
 *
 * The expected figures are worked by hand below, never read back from the code under test.
 * Invented data only. `node test/test-stack-card-spent-pending.js`
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const fx = require('./fixtures/card-posted-period-movement-data');
const { copy } = fx;

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const publish = x => F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
  { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, liveOverlay: x.overlay });
const travel = x => F.stackCardSummary(publish(x)).find(c => c.id === 'travelvisa');
const cents = v => Math.round(v * 100);

// The invented card week without its own pending row. By hand, Travel's posted Spent is
// 172.40 + 63.75 + 6.25 (interest) - 35.00 (refund) = 207.40, and its Paid is the 100.00 payment.
const BASE_SPENT = 207.40, BASE_PAID = 100;
function world(extra = []) {
  const x = fx.fixture();
  x.packet.transactions = x.packet.transactions.filter(tx => tx.id !== 'pending-a').concat(extra);
  return x;
}
const row = (id, amount, { pending = false, payee = 'Example diner', date = '2026-08-19', kindHint, ...extra } = {}) => ({
  id, coverageRef: 'invented-' + id, atlasAccountId: 'travelvisa', account: 'travelvisa', accountRole: 'revolving-credit',
  date, amount, currency: 'cad', displayedPayee: payee, categoryLabel: 'Groceries', kindHint, pending,
  savingsPostingEvidence: pending ? 'pending' : 'posted', ...extra });

console.log('0. The base week: posted only, calculated');
{
  const t = travel(world());
  ok(cents(t.spent.amount) === cents(BASE_SPENT) && t.spent.trust === 'calculated', 'Travel posted Spent is 207.40, calculated', JSON.stringify(t.spent));
}

console.log('1. One charge through its life: the same cost at every step, never doubled');
{
  const X = 48.5;
  const stages = [
    ['pending only', [row('x-pend', X, { pending: true })]],
    ['pending and its posted twin, flagged by the provider', [row('x-pend', X, { pending: true, pendingPostedDuplicate: true }),
      row('x-post', X, { pendingPostedDuplicate: true })]],
    ['pending and its posted twin, paired by the household budget\'s key (no flags)', [row('x-pend', X, { pending: true }), row('x-post', X)]],
    ['posted only', [row('x-post', X)]],
  ];
  const spent = {};
  for (const [label, rows] of stages) {
    const t = travel(world(rows));
    spent[label] = t.spent;
    ok(t.spent.amount !== null && cents(t.spent.amount) === cents(BASE_SPENT + X),
      label + ': Spent is 207.40 + 48.50 = 255.90, the charge counted once', JSON.stringify(t.spent));
  }
  const values = Object.values(spent).map(f => cents(f.amount));
  ok(values.every(v => v === values[0]), 'the same Spent at every stage: never doubled, never dropped', JSON.stringify(values));
  ok(spent['pending only'].trust === 'estimated' && spent['posted only'].trust === 'calculated',
    'pending only reads estimated; once only the posted row is left it reads calculated');
  ok(spent['pending and its posted twin, flagged by the provider'].trust === 'calculated'
    && spent['pending and its posted twin, paired by the household budget\'s key (no flags)'].trust === 'calculated',
    'a replaced pending adds nothing, so with its posted twin in, Spent is calculated again');
  // MUTANT: counting every pending row, replaced or not, doubles the charge once its posted twin lands.
  {
    const Module = require('module'), fs = require('node:fs'), pathMod = require('node:path');
    const file = require.resolve('../public/forecast-card-period.js');
    const src = fs.readFileSync(file, 'utf8');
    const target = '.concat(allPending.filter(row => row.replacedByPosted !== true))';
    ok(src.includes(target), 'the double-count mutant targets the replaced-pending rule');
    const m = new Module(file, null); m.filename = file; m.paths = Module._nodeModulePaths(pathMod.dirname(file));
    m._compile(src.replace(target, '.concat(allPending)'), file);
    const doubled = m.exports.stackCards(publish(world(stages[1][1]))).find(c => c.id === 'travelvisa').spent;
    ok(cents(doubled.amount) === cents(BASE_SPENT + 2 * X), 'MUTANT: without it the pair counts twice (207.40 + 2 x 48.50), which the invariant rejects', JSON.stringify(doubled));
  }
  const both = travel(world(stages[1][1]));
  ok(both.transactions.filter(r => r.amount === X).length === 2 && both.transactions.filter(r => r.amount === X && r.pending).length === 1,
    'no row is dropped from view: the replaced pending row is still listed (marked pending) beside its posted twin');
}

console.log('2. Trust: any figure a pending row adds to is estimated');
{
  const t = travel(world([row('p1', 12, { pending: true }), row('p2', 30, { pending: true })]));
  ok(cents(t.spent.amount) === cents(BASE_SPENT + 42) && t.spent.trust === 'estimated' && t.spent.reasons.includes('includes-pending'),
    'two pending charges: 207.40 + 12 + 30 = 249.40, estimated with its reason', JSON.stringify(t.spent));
  ok(t.net.trust === 'estimated', 'the net inherits the weaker trust');
  const mutantModule = (() => {
    const Module = require('module'), fs = require('node:fs'), pathMod = require('node:path');
    const file = require.resolve('../public/forecast-card-period.js');
    const src = fs.readFileSync(file, 'utf8');
    const target = "{ spentTrust = 'estimated'; spentReasons.push('includes-pending'); }";
    ok(src.includes(target), 'the trust mutant targets the pending-trust rule');
    const m = new Module(file, null); m.filename = file; m.paths = Module._nodeModulePaths(pathMod.dirname(file));
    m._compile(src.replace(target, "{ spentReasons.push('includes-pending'); }"), file);
    return m.exports;
  })();
  const pub = publish(world([row('p1', 12, { pending: true })]));
  ok(mutantModule.stackCards(pub).find(c => c.id === 'travelvisa').spent.trust === 'calculated',
    'MUTANT: dropping the estimated tag leaves a pending-inclusive Spent calculated, which the check above rejects');
}

console.log('3. A reversal pair counts as the ledger has it');
{
  const charge = row('r-charge', 234.61, { pending: true, payee: 'Example warehouse' });
  const refund = travel(world([charge, row('r-credit', -234.61, { pending: true, payee: 'Card transaction', kindHint: 'refund' })]));
  ok(cents(refund.spent.amount) === cents(BASE_SPENT) && refund.spent.trust === 'estimated',
    'a pending charge and a same-amount pending credit the ledger marks a refund net out: Spent stays 207.40, estimated', JSON.stringify(refund.spent));
  // Owner decision, Dale, 2026-11-23 (#821 7089360610, 7089379689; lead ruling (b)): a pending charge and a pending
  // credit of exactly opposite amount carrying the charge's own category are one hold and its release
  // (Forecast.pendingHoldReleases), so both are dropped and Spent is not withheld. Proved in test-pending-hold-release.js.
  const released = travel(world([charge, row('r-credit', -234.61, { pending: true, payee: 'Card transaction' })]));
  ok(cents(released.spent.amount) === cents(BASE_SPENT) && released.spent.trust === 'calculated',
    'a pending charge and its same-category, same-amount pending release are one hold: both dropped, Spent stays 207.40', JSON.stringify(released.spent));
  const otherCategory = travel(world([charge, row('r-credit', -234.61, { pending: true, payee: 'Card transaction', categoryLabel: 'Restaurants' })]));
  ok(otherCategory.spent.amount === null && otherCategory.spent.reasons.includes('card-credit-purpose-unconfirmed'),
    'an unlabelled pending credit in another category is not a release: it still withholds Spent (never guessed)', JSON.stringify(otherCategory.spent));
  const postedUnlabelled = travel(world([row('r-charge', 234.61, { payee: 'Example warehouse' }), row('r-credit', -234.61, { payee: 'Card transaction' })]));
  ok(postedUnlabelled.spent.amount === null && postedUnlabelled.spent.reasons.includes('card-credit-purpose-unconfirmed'),
    'control: the same pair posted is withheld the same way');
}

console.log('4. A posted amount that differs from its pending: the posted charge supersedes its hold (rule B), the known limit closed');
{
  // Owner decision addendum, Dale, 2026-11-23 (#821 7089379689): a posted charge from the same merchant and account,
  // 0-7 days later, within the larger of 20% and $25, supersedes the pending hold (Forecast.pendingHoldReleases, B).
  const t = travel(world([row('tip-pend', 40, { pending: true }), row('tip-post', 48)]));
  ok(cents(t.spent.amount) === cents(BASE_SPENT + 48) && t.spent.trust === 'calculated',
    'pending 40 and posted 48 (a tip): the posted 48 supersedes the hold, so Spent is 207.40 + 48 = 255.40, calculated', JSON.stringify(t.spent));
  const far = travel(world([row('tip-pend', 40, { pending: true }), row('tip-post', 66)]));
  ok(cents(far.spent.amount) === cents(BASE_SPENT + 106),
    'outside the tolerance (40 against 66: more than $25 apart) both still count, 207.40 + 40 + 66 = 313.40', JSON.stringify(far.spent));
}

console.log('4b. A pending row its posting names as a distinct authorization is a separate charge (the household budget\'s exception)');
{
  // Same date, account, amount and merchant, but the posted row names the pending one as a different authorization
  // (distinctPendingId): two purchases. By hand: 207.40 + 48.50 (posted) + 48.50 (pending) = 304.40, estimated. The
  // household budget counts the same pending row as an estimate (test-pending-lookalike).
  const t = travel(world([row('d-pend', 48.5, { pending: true }), row('d-post', 48.5, { distinctPendingId: 'd-pend' })]));
  ok(cents(t.spent.amount) === cents(BASE_SPENT + 97) && t.spent.trust === 'estimated',
    'a distinct authorization counts beside its lookalike posting: Spent 304.40, estimated', JSON.stringify(t.spent));
}

console.log('5. A lone flag or an ambiguous pair still withholds');
{
  const lone = travel(world([row('lone', 20, { pendingPostedDuplicate: true })]));
  ok(lone.spent.amount === null && lone.spent.trust === 'unavailable', 'a posted row flagged as a twin with no pending twin: withheld', JSON.stringify(lone.spent));
  const ambiguous = travel(world([row('a-pend', 20, { pending: true, pendingPostedDuplicate: true, pendingPostedAmbiguous: true }),
    row('a-post', 20, { pendingPostedDuplicate: true, pendingPostedAmbiguous: true })]));
  ok(ambiguous.spent.amount === null, 'an ambiguous pair: withheld', JSON.stringify(ambiguous.spent));
}

console.log('6. A pending payment counts in Paid; the posted movement and the HELOC stay posted-only');
{
  const x = world([row('pay-pend', -60, { pending: true, payee: 'Payment received', kindHint: 'payment' }), row('c-pend', 10, { pending: true })]);
  const t = travel(x);
  ok(cents(t.paid.amount) === cents(BASE_PAID + 60) && t.paid.trust === 'estimated', 'Paid is 100 + 60 = 160, estimated', JSON.stringify(t.paid));
  const pub = publish(x);
  const movement = pub.cards.find(c => c.id === 'travelvisa').postedMovement;
  // By hand: the posted liability movement is 172.40 + 63.75 - 100 - 35 + 6.25 = 107.40; pending never enters it.
  ok(cents(movement.amount) === 10740 && movement.trust === 'calculated', 'the posted movement is still 107.40, posted only', JSON.stringify(movement));
  ok(!F.stackCardSummary(pub).some(c => c.id === 'heloc'), 'the HELOC is not a stack card');
  const helocLine = F.stackCreditLines(pub, { cardMinimums: [{ debtId: 'heloc', amount: 50 }], trust: 'calculated' }).lines.find(l => l.id === 'heloc');
  ok(helocLine && helocLine.paidToward && helocLine.paidToward.trust !== 'calculated', 'the HELOC line keeps its own paid rule');
}

console.log('7. The posted-only contract is untouched: a flagged pair still withholds the posted movement and the endpoint check');
{
  // A genuine pair (pending and posted, same date, card, amount and merchant, flagged by the provider and paired by
  // Forecast) on a week with complete balance endpoints. By hand: the posted rows move the liability 107.40 + 48.50 =
  // 155.90, so the closing is 820.00 + 155.90 = 975.90. Main withholds both posted outputs for any flag; so must this.
  const prev = require('./fixtures/card-period-movements-data');
  const withEndpoints = rows => { const x = world(rows); x.balanceEvidence = prev.fixture().balanceEvidence;
    x.balanceEvidence.cards.find(c => c.id === 'travelvisa').closing.amount = 975.90; return x; };
  const flagged = withEndpoints([row('x-pend', 48.5, { pending: true, pendingPostedDuplicate: true }), row('x-post', 48.5, { pendingPostedDuplicate: true })]);
  const pubCard = publish(flagged).cards.find(c => c.id === 'travelvisa');
  ok(pubCard.postedMovement.amount === null && pubCard.postedMovement.trust === 'unavailable'
    && pubCard.postedMovement.reasons.includes('transaction-evidence-unconfirmed'),
    'flagged pair: the posted movement is withheld with transaction-evidence-unconfirmed, as on main', JSON.stringify(pubCard.postedMovement));
  ok(pubCard.netChange.amount === null && pubCard.status === 'unavailable' && pubCard.reasons.includes('transaction-evidence-unconfirmed'),
    'flagged pair: the endpoint netChange is withheld, as on main', JSON.stringify([pubCard.netChange, pubCard.status]));
  const t = travel(flagged);
  ok(cents(t.spent.amount) === cents(BASE_SPENT + 48.5) && t.spent.trust === 'calculated',
    'while the Stack Spent counts the posted twin once: 255.90 (the replaced pending adds nothing, so it stays calculated)', JSON.stringify(t.spent));
  // Control: the same pair with no provider flags (Forecast's key pairing only) withholds nothing: the endpoints reconcile.
  const control = publish(withEndpoints([row('x-pend', 48.5, { pending: true }), row('x-post', 48.5)])).cards.find(c => c.id === 'travelvisa');
  ok(cents(control.postedMovement.amount) === 15590 && control.netChange.amount === 155.9 && control.status === 'ready',
    'control: unflagged, the posted movement is 155.90 and the endpoints reconcile (820.00 -> 975.90)', JSON.stringify([control.postedMovement.amount, control.netChange]));
}

console.log('8. Relief only for rows Forecast actually paired; anything else fails closed');
{
  // Flagged by the provider, but Forecast's pairing does not match them (the amounts differ): no partner, so withheld,
  // even though the card has one flagged posted row and one flagged pending row.
  const t = travel(world([row('u-pend', 40, { pending: true, pendingPostedDuplicate: true }), row('u-post', 48, { pendingPostedDuplicate: true })]));
  ok(t.spent.amount === null && t.spent.trust === 'unavailable', 'flags Forecast did not pair: withheld (one-for-one counts are not proof)', JSON.stringify(t.spent));
  // A flagged posted row beside an unrelated flagged pending on another merchant: also withheld.
  const cross = travel(world([row('c-pend', 20, { pending: true, pendingPostedDuplicate: true, payee: 'Example kiosk' }),
    row('c-post', 20, { pendingPostedDuplicate: true, payee: 'Example diner' })]));
  ok(cross.spent.amount === null, 'flagged rows on different merchants: withheld', JSON.stringify(cross.spent));
}

console.log('9. A pair counts as accounted for only when its partner falls inside the period (fails closed otherwise)');
{
  // Forecast's pairing key includes the date, so it cannot produce a pair across the period's edge; the guard makes
  // failing closed independent of that key's shape. Inject the pairing directly: the pending P (dated in the period) is
  // paired with a posted Q dated after `through` (2026-08-20), both flagged.
  const Module = require('module'), fs = require('node:fs'), pathMod = require('node:path');
  const CP = require('../public/forecast-card-period.js');
  const x = world([row('edge-pend', 30, { pending: true, pendingPostedDuplicate: true }),
    row('edge-post', 30, { pendingPostedDuplicate: true, date: '2026-08-21' })]);
  // Capture the real call's input and primitives, then republish with the injected pairing.
  let captured = null;
  const original = CP.publish;
  CP.publish = (input, primitives) => { captured = { input, primitives }; return original(input, primitives); };
  try { publish(x); } finally { CP.publish = original; }
  const injected = Object.assign({}, captured.primitives, {
    replacedPending: tx => tx.id === 'edge-pend',
    pendingPostedPartner: tx => ({ 'edge-pend': 'edge-post', 'edge-post': 'edge-pend' })[tx && tx.id] || null });
  const spentWith = mod => mod.stackCards(mod.publish(captured.input, injected)).find(c => c.id === 'travelvisa').spent;
  const guarded = spentWith(CP);
  ok(guarded.amount === null && guarded.trust === 'unavailable', 'a partner dated after the period: not accounted for, Spent withheld', JSON.stringify(guarded));
  const file = require.resolve('../public/forecast-card-period.js');
  const src = fs.readFileSync(file, 'utf8');
  const target = "!date(partner.date) || partner.date < start || !through || partner.date > through\n          || ";
  ok(src.includes(target), 'the mutant targets the partner date guard');
  const m = new Module(file, null); m.filename = file; m.paths = Module._nodeModulePaths(pathMod.dirname(file));
  m._compile(src.replace(target, ''), file);
  ok(spentWith(m.exports).amount !== null, 'MUTANT: without the date guard the out-of-period partner relieves the pair, which the check above rejects');
}

console.log('10. A pending payment counts in Paid, never toward the minimum (lead ruling, 2026-11-22)');
{
  // By hand: Travel has a posted 100.00 payment and a pending 60.00 payment, against a 150.00 minimum. Paid (all) is 160.00,
  // estimated; paid toward the minimum is the posted 100.00 only, so the 150.00 minimum is not covered.
  const pay = row('pay-pend', -60, { pending: true, payee: 'Payment received', kindHint: 'payment' });
  const bills = min => ({ cardMinimums: [{ debtId: 'travelvisa', amount: min }], trust: 'calculated' });
  const result = F.stackCreditLines(publish(world([pay])), bills(150));
  const line = result.lines.find(l => l.id === 'travelvisa');
  ok(cents(line.paid.amount) === 16000 && line.paid.trust === 'estimated', 'Paid counts the pending payment: 100 + 60 = 160, estimated', JSON.stringify(line.paid));
  ok(cents(line.paidToward.amount) === 10000 && cents(result.totals.minimumsPaid.amount) === 10000,
    'paid toward the minimum and minimumsPaid are the posted 100.00 only', JSON.stringify([line.paidToward, result.totals.minimumsPaid]));
  ok(line.minimumCovered.value === false, 'posted 100 < 150: the minimum is not covered, though 160 including the pending payment would be', JSON.stringify(line.minimumCovered));
  // A pending payment alone: the card's only payment is pending. By hand: paid toward the minimum is 0, not covered.
  const alone = world([pay]);
  alone.packet.transactions = alone.packet.transactions.filter(tx => tx.id !== 'payment-a' && tx.id !== 'cash-leg-a');
  const aloneLine = F.stackCreditLines(publish(alone), bills(25)).lines.find(l => l.id === 'travelvisa');
  ok(cents(aloneLine.paid.amount) === 6000 && cents(aloneLine.paidToward.amount) === 0 && aloneLine.minimumCovered.value === false,
    'a pending 60 payment alone against a 25 minimum: Paid 60, paid toward the minimum 0, not covered', JSON.stringify([aloneLine.paid, aloneLine.paidToward, aloneLine.minimumCovered]));
  // MUTANT: covered read from the pending-inclusive Paid turns the pending payment alone into a covered minimum.
  const fs = require('node:fs'), Module = require('module'), pathMod = require('node:path');
  const file = require.resolve('../public/forecast-card-period.js');
  const src = fs.readFileSync(file, 'utf8');
  const target = 'const paidForMinimum = card.paidPosted || paid;';
  ok(src.includes(target), 'the mutant targets the posted-only minimum rule');
  const m = new Module(file, null); m.filename = file; m.paths = Module._nodeModulePaths(pathMod.dirname(file));
  m._compile(src.replace(target, 'const paidForMinimum = paid;'), file);
  ok(m.exports.stackCreditLines(publish(alone), bills(25)).lines.find(l => l.id === 'travelvisa').minimumCovered.value === true,
    'MUTANT: reading the pending-inclusive Paid makes the pending payment alone cover the minimum, which the check above rejects');
}

console.log('10b. A pending row never withholds the posted-only paid behind the minimums (Atlas re-review, ba677461)');
{
  // Complete posted evidence: Travel's posted 100.00 payment covers a 25.00 minimum. By hand: paid toward the minimum and
  // minimumsPaid are 100.00 and the minimum is covered, exactly as on main, whatever a pending row does. An unrelated
  // pending row that withholds the pending-inclusive Paid and Spent (an unlabelled credit; a row with no usable amount)
  // must leave them so.
  const bills = { cardMinimums: [{ debtId: 'travelvisa', amount: 25 }], trust: 'calculated' };
  for (const [label, pendingRow] of [
    ['an unlabelled pending credit', row('pc-credit', -15, { pending: true, payee: 'Card transaction' })],
    ['a pending row with no usable amount (USD)', row('pc-usd', 15, { pending: true, currency: 'usd' })],
  ]) {
    const result = F.stackCreditLines(publish(world([pendingRow])), bills);
    const line = result.lines.find(l => l.id === 'travelvisa');
    ok(cents(line.paidToward.amount) === 10000 && cents(result.totals.minimumsPaid.amount) === 10000 && line.minimumCovered.value === true,
      label + ': paid toward the minimum and minimumsPaid stay 100.00 and the minimum stays covered (as on main)',
      JSON.stringify([line.paidToward, result.totals.minimumsPaid, line.minimumCovered]));
    ok(line.paid.amount === null && line.spent.amount === null,
      label + ': the pending-inclusive Paid and Spent are withheld, as the same row would withhold them posted', JSON.stringify([line.paid, line.spent]));
  }
}

console.log('11. A matched pair beside a separate flagged row: only the pair is relieved, the card stays withheld');
{
  // Pair P/Q (matched by Forecast, both flagged) plus a lone flagged posted row L that nothing pairs. Each flagged row pushed
  // one transaction-evidence-unconfirmed into the posted gaps; the pair's two are lifted for the Stack, L's one remains.
  const pair = [row('m-pend', 30, { pending: true, pendingPostedDuplicate: true }), row('m-post', 30, { pendingPostedDuplicate: true })];
  const lone = row('m-lone', 12, { pendingPostedDuplicate: true, payee: 'Example kiosk' });
  const both = publish(world(pair.concat([lone]))).cards.find(c => c.id === 'travelvisa');
  ok(Array.isArray(both.stackPendingGaps) && both.stackPendingGaps.includes('transaction-evidence-unconfirmed'),
    'pair + lone flag: the Stack gate still carries the lone row\'s transaction-evidence-unconfirmed', JSON.stringify(both.stackPendingGaps));
  const t = travel(world(pair.concat([lone])));
  ok(t.spent.amount === null && t.paid.amount === null, 'pair + lone flag: Spent and Paid stay withheld', JSON.stringify(t.spent));
  const alone = publish(world(pair)).cards.find(c => c.id === 'travelvisa');
  ok(Array.isArray(alone.stackPendingGaps) && alone.stackPendingGaps.length === 0
    && alone.postedMovement.reasons.includes('transaction-evidence-unconfirmed'),
    'control: the pair alone lifts exactly its own flags (no Stack gaps left), while the posted movement keeps them', JSON.stringify([alone.stackPendingGaps, alone.postedMovement.reasons]));
}

console.log('12. The posted-only paid is internal: no published card or Credit line carries it');
{
  const pub = publish(world([row('pay-pend', -60, { pending: true, payee: 'Payment received', kindHint: 'payment' })]));
  const cards = F.stackCardSummary(pub);
  const lines = F.stackCreditLines(pub, { cardMinimums: [{ debtId: 'travelvisa', amount: 150 }], trust: 'calculated' }).lines;
  ok(cards.every(c => !Object.hasOwn(c, 'paidPosted')) && lines.every(l => !Object.hasOwn(l, 'paidPosted')),
    'stackCardSummary cards and stackCreditLines lines have no paidPosted field (their published shape is unchanged)');
}

console.log(`\nPASS Stack card Spent counts pending, never twice (${checks})`);
