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
  const unlabelled = travel(world([charge, row('r-credit', -234.61, { pending: true, payee: 'Card transaction' })]));
  ok(unlabelled.spent.amount === null && unlabelled.spent.trust === 'unavailable' && unlabelled.spent.reasons.includes('card-credit-purpose-unconfirmed'),
    'an unlabelled pending credit withholds Spent, exactly as the same credit does when posted (never guessed)', JSON.stringify(unlabelled.spent));
  const postedUnlabelled = travel(world([row('r-charge', 234.61, { payee: 'Example warehouse' }), row('r-credit', -234.61, { payee: 'Card transaction' })]));
  ok(postedUnlabelled.spent.amount === null && postedUnlabelled.spent.reasons.includes('card-credit-purpose-unconfirmed'),
    'control: the same pair posted is withheld the same way');
}

console.log('4. A posted amount that differs from its pending is not paired, so both count (a known limit)');
{
  const t = travel(world([row('tip-pend', 40, { pending: true }), row('tip-post', 48)]));
  ok(cents(t.spent.amount) === cents(BASE_SPENT + 88) && t.spent.trust === 'estimated',
    'pending 40 and posted 48 (a tip): the pairing does not match them, so Spent counts 207.40 + 40 + 48 = 295.40, estimated', JSON.stringify(t.spent));
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

console.log(`\nPASS Stack card Spent counts pending, never twice (${checks})`);
