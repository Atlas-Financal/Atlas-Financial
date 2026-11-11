'use strict';
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const View = require('../public/budget-card-movements');
const vm = require('node:vm'), fs = require('node:fs');
const { fixture, copy } = require('./fixtures/card-period-movements-data');
let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const publish = x => F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
  { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, liveOverlay: x.overlay || null });
const x = fixture(), before = JSON.stringify(x), pub = publish(x);
// Existing engine mutation suites expose module.exports without require.
const sandbox = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(require.resolve('../public/forecast'), 'utf8'), sandbox);
const vmCycle = sandbox.module.exports.spendingCycle(x.plan, x.asOf);
eq([vmCycle.start, vmCycle.end, vmCycle.nextPayday, vmCycle.days],
  ['2026-08-14', '2026-08-27', '2026-08-28', 14],
  'incumbent Forecast VM works without require');
eq(pub.cards.map(row => row.id), ['travelvisa', 'cashback', 'tdcc', 'triangle', 'mbna'], 'all five canonical identities');
eq(pub.cards[4].label, 'Amazon Mastercard', 'owner-visible Amazon name');
// Two independent methods: institution-like invented endpoints and a ledger
// written in integer cents here, never by calling the producing calculator.
const independentTravelCents = 17240 + 6375 - 10000 - 3500 + 625;
eq(independentTravelCents, 10740, 'independent ledger includes payment/refund/interest');
eq(92740 - 82000, 10740, 'independent endpoints agree');
eq(pub.cards[0].netChange.amount, 107.40, 'Travel posted debt change');
eq(pub.cards[0].netChange.direction, 'up', 'debt increase');
eq(pub.cards[1].netChange.amount, -135.80, '11420 - 25000 = -13580, cash leg never added');
eq(pub.cards[1].netChange.direction, 'down', 'debt decrease');
eq(pub.cards[2].netChange.amount, 0, 'complete true zero');
eq(pub.cards[2].status, 'ready', 'explicit empty Emerald ledger stays ready');
eq(pub.cards[2].netChange.trust, 'calculated', 'explicit empty Emerald ledger stays calculated');
eq(pub.cards[2].netChange.completeness, 'complete', 'explicit empty Emerald ledger stays complete');
eq(pub.cards[0].posted.map(tx => tx.kind), ['charge', 'charge', 'payment', 'interest', 'refund'], 'native explicit type, sorted identity');
eq(pub.cards[0].posted.length, 5, 'card leg counts once');
eq(pub.cards[0].pending.length, 1, 'pending remains separate');
eq(pub.cards[3].netChange.amount, null, 'Triangle opening remains unknown');
eq(pub.cards[4].netChange.amount, null, 'dated Amazon never becomes current closing');
eq(pub.cards[4].reportedBalance.date, '2026-08-08', 'manual evidence not retimed');
const nativeDate = copy(x); delete nativeDate.debts[4].evidenceDate;
nativeDate.overlay = { overlays: [{ locator: 'debts:mbna', field: 'balance', proposedValue: 760, evidenceDate: '2026-08-08' }] };
eq(publish(nativeDate).cards[4].reportedBalance.date, '2026-08-08', 'native colon locator preserves manual date without a canonical date');
nativeDate.overlay.overlays[0].evidenceDate = '2026-08-21';
eq(publish(nativeDate).cards[4].reportedBalance.date, null, 'future observation not promoted into current date');
nativeDate.overlay.overlays[0].evidenceDate = '2026-08-08';
nativeDate.overlay.overlays[0].proposedValue = 761;
eq(publish(nativeDate).cards[4].reportedBalance.date, null, 'different provider stock not assigned to canonical stock');
eq(JSON.stringify(x), before, 'no input write');
for (const [name, mutate, amount, reason] of [
  ['missing opening', y => { delete y.balanceEvidence.cards[0].opening; }, null, 'opening-unavailable'],
  ['unconfirmed opening', y => { y.balanceEvidence.cards[0].opening.confirmed = false; }, null, 'opening-unqualified'],
  ['date without temporal claim', y => { delete y.balanceEvidence.cards[0].opening.temporalClaim; }, null, 'opening-unqualified'],
  ['stale closing', y => { y.balanceEvidence.cards[0].closing.date = '2026-08-08'; }, null, 'closing-unqualified'],
  ['fractional-cent endpoint', y => { y.balanceEvidence.cards[0].closing.amount = 927.401; }, null, 'closing-unqualified'],
  ['same endpoint reference', y => { y.balanceEvidence.cards[0].closing.evidenceRef = y.balanceEvidence.cards[0].opening.evidenceRef; }, null, 'endpoint-identity-conflict'],
  ['duplicate endpoint records', y => { y.balanceEvidence.cards.push(copy(y.balanceEvidence.cards[0])); }, null, 'endpoint-identity-conflict'],
  ['malformed endpoint container', y => { y.balanceEvidence.cards = {}; }, null, 'opening-unavailable'],
  ['truncated pages', y => { y.packet.transactionCoverage = 'truncated'; }, null, 'posted-coverage-incomplete'],
  ['missing first page', y => { y.packet.coverageStart = '2026-08-15'; }, null, 'posted-coverage-incomplete'],
  ['missing last page', y => { y.packet.coverageThrough = '2026-08-19'; }, null, 'posted-coverage-incomplete'],
  ['stale observation', y => { y.packet.observationAsOf = '2026-08-19'; }, null, 'observation-unavailable'],
  ['USD movement', y => { y.packet.transactions[0].currency = 'usd'; }, null, 'transaction-amount-unqualified'],
  ['amount string', y => { y.packet.transactions[0].amount = '172.40'; }, null, 'transaction-amount-unqualified'],
  ['fractional-cent movement', y => { y.packet.transactions[0].amount = 172.401; }, null, 'transaction-amount-unqualified'],
  ['duplicate posted id', y => { y.packet.transactions.push(copy(y.packet.transactions[0])); }, null, 'duplicate-identity'],
  ['pending versus posted ambiguity', y => { y.packet.transactions[0].pendingPostedAmbiguous = true; }, null, 'transaction-evidence-unconfirmed'],
  ['pending duplicate identity', y => { y.packet.transactions[0].pendingPostedDuplicate = true; }, null, 'transaction-evidence-unconfirmed'],
  ['contradictory posted evidence', y => { y.packet.transactions[0].contradictoryEvidence = true; }, null, 'transaction-evidence-unconfirmed'],
  ['unknown card mapping', y => { y.packet.transactions.push({ ...y.packet.transactions[0], id: 'unknown', accountRole: 'unmapped' }); }, null, 'unmapped-card-identity'],
  ['discrepancy', y => { y.balanceEvidence.cards[0].closing.amount = 940; }, null, 'balance-ledger-discrepancy'],
  ['large pending authorization', y => { y.packet.transactions.find(tx => tx.pending).amount = 750; }, 107.40, null],
  ['pending coverage unknown', y => { y.packet.pendingCoverage = 'unknown'; }, 107.40, null],
  ['next payday charge', y => { y.packet.transactions.push({ ...y.packet.transactions[0], id: 'next', date: '2026-08-28', amount: 900 }); }, 107.40, null],
  ['spending exclusion still changes liability', y => { y.packet.transactions[2].excludeFromBudget = true; y.packet.transactions[2].excludeFromTotals = true; }, 107.40, null],
  ['posted fee or adjustment included', y => { y.packet.transactions.push({ ...y.packet.transactions[0], id: 'fee', amount: 29, displayedPayee: 'Example fee' }); y.balanceEvidence.cards[0].closing.amount = 956.40; }, 136.40, null],
  ['posted reversal', y => { y.packet.transactions.push({ ...y.packet.transactions[0], id: 'reversal', amount: 100 }); y.balanceEvidence.cards[0].closing.amount = 1027.40; }, 207.40, null],
  ['ambiguous credit type', y => { delete y.packet.transactions.find(tx => tx.id === 'payment-a').kindHint; }, 107.40, null],
]) {
  const y = copy(x); mutate(y); const result = publish(y).cards[0];
  eq(result.netChange.amount, amount, name + ' numeric truth');
  if (reason) { assert.ok(result.reasons.includes(reason), name + ' reason'); checks++; }
  eq(result.posted.some(tx => tx.id === 'cash-leg-a'), false, name + ' cash leg excluded');
}
const ambiguous = copy(x); delete ambiguous.packet.transactions.find(tx => tx.id === 'payment-a').kindHint;
eq(publish(ambiguous).cards[0].posted.find(tx => tx.id === 'payment-a').kind, 'credit-unconfirmed', 'sign does not prove payment or refund');
const split = copy(x); split.packet.transactions.push({ ...split.packet.transactions[0], id: 'parent', isGroup: true });
eq(publish(split).cards[0].netChange.amount, null, 'unproven parent fails closed');
split.packet.transactions[0].parentId = 'parent';
eq(publish(split).cards[0].netChange.amount, 107.40, 'parent not added to child');
const future = copy(x); future.window = { start: '2026-08-28', end: '2026-09-10' };
eq(publish(future).cards.every(row => row.status === 'not-observed' && row.netChange.amount === null && !row.posted.length), true, 'future does not borrow current movement');
const invalid = copy(x); invalid.window.start = '2026-02-30';
eq(publish(invalid).cards.every(row => row.netChange.amount === null), true, 'invalid calendar identity');
const wrongPeriod = copy(x); wrongPeriod.window.start = '2026-08-15';
eq(publish(wrongPeriod).cards[0].reasons.includes('selected-period-unavailable'), true, 'arbitrary dates not a Seaspan period');
const historical = copy(x); historical.window = { start: '2026-07-31', end: '2026-08-13' };
const historicalCard = publish(historical).cards[0];
eq(historicalCard.netChange.amount, null, 'current packet does not establish historical endpoints');
eq(historicalCard.reportedBalance, null, 'current stock never copied into history');
eq(historicalCard.posted, [], 'current period charges never copied into history');
const currencyPoint = copy(x); currencyPoint.balanceEvidence.cards[0].opening.currency = 'USD';
eq(publish(currencyPoint).cards[0].opening, null, 'USD endpoint never displayed as CAD opening');
// Malformed ledger is not a calculated complete zero. Independent Emerald
// endpoints 123456 - 123456 = 0 do not invent a ready ledger when the
// transactions container is missing, null, an object or a string.
const emptyLedger = copy(x);
emptyLedger.packet.transactions = [];
emptyLedger.balanceEvidence.cards.find(row => row.id === 'tdcc').opening.amount = 1234.56;
emptyLedger.balanceEvidence.cards.find(row => row.id === 'tdcc').closing.amount = 1234.56;
eq(123456 - 123456, 0, 'independent equal Emerald endpoints are zero');
eq(publish(emptyLedger).cards[2].netChange.amount, 0, 'explicit empty array remains a true zero');
eq(publish(emptyLedger).cards[2].status, 'ready', 'explicit empty array remains ready');
eq(publish(emptyLedger).cards[2].pendingCoverage, 'complete-provider-response',
  'explicit valid empty ledger preserves proven empty pending coverage');
for (const [name, assign] of [
  ['missing transactions', y => { delete y.packet.transactions; }],
  ['null transactions', y => { y.packet.transactions = null; }],
  ['object transactions', y => { y.packet.transactions = {}; }],
  ['string transactions', y => { y.packet.transactions = '[]'; }],
]) {
  const y = copy(emptyLedger); assign(y); const card = publish(y).cards[2];
  eq(card.netChange.amount, null, name + ' does not publish zero');
  eq(card.status, 'unavailable', name + ' status');
  eq(card.netChange.trust, 'unavailable', name + ' trust');
  eq(card.netChange.completeness, 'unavailable', name + ' completeness');
  eq(card.postedCoverage, 'incomplete', name + ' coverage');
  eq(card.pendingCoverage, 'unavailable', name + ' pending coverage cannot prove emptiness');
  const rendered = View.html(publish(y), { money: value => '$' + value.toFixed(2), date: value => value });
  eq(rendered.includes('No pending authorizations returned.'), false, name + ' no false pending all-clear');
  eq(rendered.includes('Pending coverage unavailable.'), true, name + ' renderer copies unavailable pending evidence');
  assert.ok(card.reasons.includes('posted-coverage-incomplete'), name + ' reason'); checks++;
}
// Cross-card source identity, alias conflict and unflagged posted/pending
// reuse withhold only the affected cards. Independent invented ledgers:
// Travel 17240+6375-10000-3500+625=10740; Cash Back 11420-25000=-13580.
eq(17240 + 6375 - 10000 - 3500 + 625, 10740, 'Travel ledger remains independently 10740');
eq(11420 - 25000, -13580, 'Cash Back ledger remains independently -13580');
const collide = copy(x);
const travelCharge = collide.packet.transactions.find(tx => tx.id === 'charge-a');
const cashCharge = collide.packet.transactions.find(tx => tx.id === 'cashback-charge');
cashCharge.id = travelCharge.id;
cashCharge.coverageRef = travelCharge.coverageRef;
const collided = publish(collide);
eq(collided.cards[0].netChange.amount, null, 'Travel withheld on shared source identity');
eq(collided.cards[1].netChange.amount, null, 'Cash Back withheld on shared source identity');
eq(collided.cards[2].netChange.amount, 0, 'Emerald remains an independent true zero');
eq(collided.cards[2].status, 'ready', 'unaffected Emerald stays ready');
assert.ok(collided.cards[0].reasons.includes('duplicate-identity'), 'Travel shared-identity reason'); checks++;
assert.ok(collided.cards[1].reasons.includes('duplicate-identity'), 'Cash Back shared-identity reason'); checks++;
const alias = copy(x);
alias.packet.transactions[0].account = 'cashback';
const aliased = publish(alias);
eq(aliased.cards[0].netChange.amount, null, 'Travel withheld on conflicting aliases');
eq(aliased.cards[1].netChange.amount, null, 'Cash Back withheld on conflicting aliases');
eq(aliased.cards[2].netChange.amount, 0, 'Emerald remains ready after alias conflict');
assert.ok(aliased.cards[0].reasons.includes('unmapped-card-identity'), 'Travel alias reason'); checks++;
assert.ok(aliased.cards[1].reasons.includes('unmapped-card-identity'), 'Cash Back alias reason'); checks++;
const pendingReuse = copy(x);
const pendingRow = pendingReuse.packet.transactions.find(tx => tx.id === 'pending-a');
pendingRow.id = 'charge-a';
pendingRow.coverageRef = 'invented-charge-a';
const reused = publish(pendingReuse);
eq(reused.cards[0].netChange.amount, null, 'unflagged posted/pending identity reuse withholds Travel');
eq(reused.cards[1].netChange.amount, -135.80, 'Cash Back remains independent after pending reuse');
eq(reused.cards[2].netChange.amount, 0, 'Emerald remains independent after pending reuse');
assert.ok(reused.cards[0].reasons.includes('duplicate-identity'), 'posted/pending reuse reason'); checks++;
// Source ownership is qualified before date/window slicing. Independent
// Travel 10740 / Cash Back -13580 / Emerald 0 remain the only published
// numbers when a colliding counterpart escapes the selected interval.
const escapedDate = copy(x);
const escapedCash = escapedDate.packet.transactions.find(tx => tx.id === 'cashback-charge');
escapedCash.id = 'charge-a';
escapedCash.date = 'not-a-date';
const escapedDatePub = publish(escapedDate);
eq(escapedDatePub.cards[0].netChange.amount, null, 'Travel withheld when colliding Cash Back date is malformed');
eq(escapedDatePub.cards[1].netChange.amount, null, 'Cash Back withheld on malformed colliding date');
eq(escapedDatePub.cards[2].netChange.amount, 0, 'Emerald remains an independent true zero after escaped date');
assert.ok(escapedDatePub.cards[0].reasons.includes('duplicate-identity'), 'malformed-date collision reason'); checks++;
const escapedPending = copy(x);
const latePending = escapedPending.packet.transactions.find(tx => tx.id === 'pending-a');
latePending.id = 'charge-a';
latePending.coverageRef = 'invented-charge-a';
latePending.date = '2026-08-21';
const escapedPendingPub = publish(escapedPending);
eq(escapedPendingPub.cards[0].netChange.amount, null, 'Travel withheld when colliding pending is after through');
eq(escapedPendingPub.cards[1].netChange.amount, -135.80, 'Cash Back remains independent after post-through pending reuse');
eq(escapedPendingPub.cards[2].netChange.amount, 0, 'Emerald remains independent after post-through pending reuse');
assert.ok(escapedPendingPub.cards[0].reasons.includes('duplicate-identity'), 'post-through pending collision reason'); checks++;
const escapedBefore = copy(x);
const earlyCash = escapedBefore.packet.transactions.find(tx => tx.id === 'cashback-charge');
earlyCash.id = 'charge-a';
earlyCash.date = '2026-08-10';
const escapedBeforePub = publish(escapedBefore);
eq(escapedBeforePub.cards[0].netChange.amount, null, 'Travel withheld when colliding Cash Back is before start');
eq(escapedBeforePub.cards[1].netChange.amount, null, 'Cash Back withheld on pre-window colliding source');
eq(escapedBeforePub.cards[2].netChange.amount, 0, 'Emerald remains independent after pre-window collision');
assert.ok(escapedBeforePub.cards[0].reasons.includes('duplicate-identity'), 'pre-window collision reason'); checks++;
const independentBadDate = copy(x);
independentBadDate.packet.transactions.find(tx => tx.id === 'cashback-charge').date = 'not-a-date';
const independentBadDatePub = publish(independentBadDate);
eq(independentBadDatePub.cards[0].netChange.amount, 107.40, 'Travel stays publishable when a distinct Cash Back date is malformed');
eq(independentBadDatePub.cards[1].netChange.amount, null, 'Cash Back withholds its own malformed date');
eq(independentBadDatePub.cards[2].netChange.amount, 0, 'Emerald remains independent of an unrelated malformed date');
// Positive institution satisfaction is preserved independently of payment
// purpose. These invented occurrences already have qualified issuer proof.
const issuer = require('./fixtures/bills-header-payments-data').fixture();
const issuerBefore = F.cardMinimumState(issuer.plan, issuer.asOf);
eq(issuerBefore.payments.map(row => row.issuerMinimumStatus), ['satisfied', 'satisfied', 'satisfied'], 'independent issuer evidence fixture');
publish({ ...x, plan: issuer.plan });
eq(F.cardMinimumState(issuer.plan, issuer.asOf), issuerBefore, 'reporting never invents another liability over issuer proof');
// New reporting must not mutate or settle any existing household authority.
const minimumBefore = F.cardMinimumState(x.plan, x.asOf);
const adviceBefore = F.recommend(x.plan, x.asOf, { debts: x.debts, currentPeriodActuals: x.packet });
publish(x);
eq(F.cardMinimumState(x.plan, x.asOf), minimumBefore, 'ambiguous provider credit does not settle household minimum');
eq(F.recommend(x.plan, x.asOf, { debts: x.debts, currentPeriodActuals: x.packet }), adviceBefore, 'all incumbent cash/spending/obligation/funding publications unchanged');
// Owner requested the existing secured revolving facility in the same list.
// Independent invented ledger and institution-style endpoints, in cents:
// 50000 - 60000 + 12535 = 2535; 4202535 - 4200000 = 2535.
const helocInput = require('./fixtures/card-period-movements-data').helocFixture();
const helocBefore = JSON.stringify(helocInput), helocPub = publish(helocInput);
const heloc = helocPub.cards.find(row => row.id === 'heloc');
eq(50000 - 60000 + 12535, 2535, 'independent HELOC posted ledger');
eq(4202535 - 4200000, 2535, 'independent HELOC endpoint difference');
eq(helocPub.cards.map(row => row.id), ['travelvisa', 'cashback', 'tdcc', 'triangle', 'mbna', 'heloc'], 'native HELOC appended once');
eq(heloc.netChange.amount, 25.35, 'HELOC does not include the pending 900 or current stock');
eq(heloc.posted.map(tx => tx.id), ['heloc-advance', 'heloc-payment', 'heloc-interest'], 'posted native facility identities');
eq(heloc.posted.map(tx => tx.kind), ['movement-unconfirmed', 'payment', 'interest'], 'advance is not guessed to be household spending');
eq(heloc.pending.length, 1, 'HELOC pending is separate');
eq(heloc.manualStatement, false, 'HELOC does not adopt manual card freshness');
eq(JSON.stringify(helocInput), helocBefore, 'HELOC publication does not write inputs');
for (const [name, change, reason] of [
  ['missing opening', y => { delete y.balanceEvidence.cards.find(row => row.id === 'heloc').opening; }, 'opening-unavailable'],
  ['incomplete ledger', y => { y.packet.transactionCoverage = 'truncated'; }, 'posted-coverage-incomplete'],
  ['endpoint discrepancy', y => { y.balanceEvidence.cards.find(row => row.id === 'heloc').closing.amount = 42026; }, 'balance-ledger-discrepancy'],
  ['future', y => { y.window = { start: '2026-08-28', end: '2026-09-10' }; }, 'future-not-observed'],
  ['conflicting identity', y => { y.packet.transactions.find(tx => tx.id === 'heloc-advance').account = 'travelvisa'; }, 'unmapped-card-identity'],
]) {
  const y = copy(helocInput); change(y); const row = publish(y).cards.find(row => row.id === 'heloc');
  eq(row.netChange.amount, null, 'HELOC ' + name + ' stays unavailable');
  eq(row.reasons.includes(reason), true, 'HELOC ' + name + ' retains reason');
}
const helocHtml = View.html(helocPub, { money: value => '$' + value.toFixed(2), date: value => value });
eq(helocHtml.includes('data-budget-card-toggle="heloc"'), true, 'native renderer supplies the HELOC trigger');
eq(helocHtml.includes('data-budget-card-panel="heloc"'), true, 'native renderer supplies the HELOC panel');
// Sheet routing contract + the face trigger balance (renderer level):
// triggers name the native dialog, panels render hidden as sheet sources,
// and no inline expansion state or private close control remains.
const fmt = { money: value => '$' + value.toFixed(2), date: value => value };
const sheetHtml = View.html(pub, fmt);
eq(sheetHtml.includes('aria-haspopup="dialog"'), true, 'card triggers name the native dialog lifecycle');
eq(sheetHtml.includes('aria-expanded'), false, 'no competing inline expansion state remains');
eq(sheetHtml.includes('data-budget-card-close'), false, 'panel carries no private close control; the sheet owns dismissal');
eq(/data-budget-card-panel="travelvisa"[^>]* hidden>/.test(sheetHtml), true, 'panels render hidden as native sheet sources');
// mbna is the publication's manual-statement card. Its statement is dated
// before the page's date, so its face adds a small "as of <date>" beside the
// amount (owner-approved 2026-11-11); the manual source stays panel evidence.
// The amount itself is unchanged.
eq(/data-budget-card-toggle="mbna"[\s\S]*?card-movement-balance">\$760\.00 <small class="card-movement-asof" data-card-movement-asof>as of 2026-08-08<\/small><\/span>/.test(sheetHtml), true,
  'stale manual trigger balance shows the amount and its as-of date; provenance stays in the panel');
// travelvisa has no evidence date and no manual flag: its face balance is
// likewise the bare amount, so no date and no synced source is invented;
// the panel keeps the full evidence, stated as date unavailable.
eq(/data-budget-card-toggle="travelvisa"[\s\S]*?card-movement-balance">\$927\.40<\/span>/.test(sheetHtml), true,
  'undated non-manual trigger balance invents neither date nor source');
eq(/data-budget-card-panel="travelvisa"[\s\S]*?Reported balance \$927\.40 · Date unavailable/.test(sheetHtml), true,
  'panel keeps the undated reported-balance evidence');
// Face balances print the bare amount for every card — no prefix, no
// as-of date, no source suffix, no canonical-id exception: Cash Back's
// face is the amount alone while its panel keeps the dated evidence,
// and Triangle, previously a face-date exception, prints the bare
// amount too.
eq(/data-budget-card-toggle="cashback"[\s\S]*?card-movement-balance">\$2264\.20<\/span>/.test(sheetHtml), true,
  'Cash Back face is the bare amount');
eq(/data-budget-card-panel="cashback"[\s\S]*?Reported balance \$2264\.20/.test(sheetHtml), true,
  'Cash Back panel keeps the reported-balance evidence line');
eq(/data-budget-card-toggle="triangle"[\s\S]*?card-movement-balance">\$1980\.00 <small class="card-movement-asof" data-card-movement-asof>as of [0-9-]+<\/small><\/span>/.test(sheetHtml), true,
  'Triangle (manual statement, dated before the page) prints its amount plus an as-of note');
// The Amazon face name is exactly 'Amazon', keyed on the canonical id;
// the publication label itself is unchanged and still names the panel.
eq(/data-budget-card-toggle="mbna"[\s\S]*?card-movement-title">Amazon<span/.test(sheetHtml), true,
  'Amazon face name is exactly Amazon');
eq(sheetHtml.includes('data-budget-card-panel="mbna" aria-label="Amazon Mastercard activity"'), true,
  'Amazon panel keeps the full publication label');
// A display label that merely contains 'Amazon' is not the Amazon card:
// the face rules key on canonical identity, never the label substring.
const decoy = copy(pub); decoy.cards[0].label = 'Amazon Unlimited';
const decoyHtml = View.html(decoy, fmt);
eq(/data-budget-card-toggle="travelvisa"[\s\S]*?card-movement-title">Amazon Unlimited<span/.test(decoyHtml), true,
  'a label containing Amazon is not relabelled');
eq(/data-budget-card-toggle="travelvisa"[\s\S]*?card-movement-balance">\$927\.40<\/span>/.test(decoyHtml), true,
  'a label containing Amazon does not change the bare face amount');
eq(sheetHtml.toLowerCase().includes('payday balance'), false, 'reported balance is never called a payday balance');
const zeroDebt = copy(x); zeroDebt.debts[2].balance = 0;
eq(/data-budget-card-toggle="tdcc"[\s\S]*?card-movement-balance">\$0\.00/.test(View.html(publish(zeroDebt), fmt)), true,
  'genuine zero reported balance renders as zero');
const historicalHtml = View.html(publish(historical), fmt);
eq(historicalHtml.includes('card-movement-balance is-unavailable">Unavailable'), true,
  'historical period trigger shows the unavailable state in the balance slot');
eq(/card-movement-balance">\$/.test(historicalHtml), false,
  'historical period trigger never borrows the current reported balance');
const badBalance = copy(pub); badBalance.cards[0].reportedBalance = { amount: '927.40', date: '2026-08-20', status: 'dated' };
eq(/data-budget-card-toggle="travelvisa"[\s\S]*?card-movement-balance is-unavailable">Unavailable/.test(View.html(badBalance, fmt)), true,
  'non-numeric reported balance amount is rejected to the state word, not rendered');
// The face carries no net furniture at all: no delta span, no qualifier
// span and no net-unavailable text anywhere in the rendered strip; no
// net figure prints on the face. The panels keep their own pre-existing
// evidence wording (asserted there below and in the publication pins
// above) — unchanged, and no net figure is printed there either.
eq(sheetHtml.includes('card-movement-delta'), false, 'no trigger prints a net-change delta on the face');
eq(sheetHtml.includes('card-movement-qualifier'), false, 'no trigger prints a net qualifier on the face');
eq(sheetHtml.includes('Net unavailable'), false, 'no net-unavailable text prints anywhere in the strip');
// The heading contract is semantic, not just the painted tile title
// (Systems Review 5485851551 R1): the region's accessible name and the
// actual h2 both read exactly 'Credit cards' — no 'Card movement' name
// and no period dates survive in the heading, in any state.
eq(/data-budget-card-movements[^>]*aria-label="Credit cards"/.test(sheetHtml), true,
  'the strip region accessible name is Credit cards');
eq(sheetHtml.includes('<h2>Credit cards</h2>'), true, 'the semantic heading is exactly Credit cards');
eq(sheetHtml.includes('Card movement'), false, 'no Card movement heading or label remains in the strip');
eq(historicalHtml.includes('<h2>Credit cards</h2>'), true, 'the historical strip heading is exactly Credit cards');
// Condensed panel copy: the payments qualifier keeps its meaning, the
// generic provider-observation boilerplate sentence is gone.
eq(sheetHtml.includes('Purpose unconfirmed: payments do not automatically settle scheduled minimums; lender confirmation remains separate.'), true,
  'payments qualifier condensed with its meaning kept');
eq(sheetHtml.includes('purchases remain in their spending categories once'), false, 'generic provider boilerplate removed');
eq(sheetHtml.includes('This dated observation does not establish both period endpoints.'), true,
  'dated-observation endpoint warning retained');
// wire(): a trigger click opens its own panel through the supplied native
// sheet and names the actual dialog; nothing opens inline.
{
  const listeners = {};
  const panel = { attrs: { 'data-budget-card-panel': 'travelvisa', 'aria-label': 'Travel activity' },
    getAttribute(key) { return this.attrs[key] ?? null; } };
  const trigger = { attrs: { 'data-budget-card-toggle': 'travelvisa' },
    getAttribute(key) { return this.attrs[key] ?? null; },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(type, fn) { listeners[type] = fn; } };
  const strip = { querySelectorAll(sel) { return sel.includes('toggle') ? [trigger] : [panel]; } };
  const mount = { querySelector(sel) {
    return sel.includes('card-movements') ? strip : sel.includes('detail-sheet') ? { id: 'budget-detail-sheet' } : null; } };
  const opened = [];
  View.wire(mount, { open: (...args) => opened.push(args) });
  eq(trigger.attrs['aria-haspopup'], 'dialog', 'wire names the native dialog lifecycle');
  eq(trigger.attrs['aria-controls'], 'budget-detail-sheet', 'wire controls the actual dialog');
  listeners.click();
  eq(opened.length, 1, 'trigger click opens through the sheet exactly once');
  eq(opened[0][0], panel, 'sheet receives the card panel node');
  eq(opened[0][1], trigger, 'sheet receives the trigger for focus return');
  eq(opened[0][2], 'Travel activity', 'sheet receives the panel label as its title');
}
// Exercise the real observation -> sanitized overlay -> Forecast -> renderer.
// An omitted malformed record must not turn a ledger into a complete zero.
for (const mode of ['complete', 'empty', 'undated', 'amount-missing', 'foreign-currency', 'malformed-only']) {
  const served = require('./fixtures/card-period-movements-data').helocObserved(mode);
  const observedPub = F.cardPeriodMovements(served.plan, served.debts, x.asOf, x.window,
    { currentPeriodActuals: served.liveOverlay.currentPeriodActuals,
      cardPeriodBalanceEvidence: served.liveOverlay.cardPeriodBalanceEvidence });
  const observedHeloc = observedPub.cards.find(row => row.id === 'heloc');
  const qualified = mode === 'complete' || mode === 'empty';
  eq(observedHeloc.netChange.amount, mode === 'complete' ? 25.35 : mode === 'empty' ? 0 : null, 'native HELOC ' + mode + ' independent net');
  eq(observedHeloc.status, qualified ? 'ready' : 'unavailable', 'native HELOC ' + mode + ' completeness');
  eq(observedHeloc.reasons.includes('transaction-evidence-unconfirmed'), !qualified, 'native HELOC ' + mode + ' preserves lost-record marker');
  const rendered = View.html(observedPub, { money: value => '$' + value.toFixed(2), date: value => value });
  eq(rendered.includes('data-budget-card-toggle="heloc"'), true, 'native HELOC ' + mode + ' renderer identity');
  if (!qualified) {
    const helocTrigger = rendered.slice(rendered.indexOf('data-budget-card-toggle="heloc"'));
    eq(helocTrigger.slice(0, helocTrigger.indexOf('</button>')).includes('Net'), false,
      'native HELOC ' + mode + ' trigger prints no net claim — it never claims zero');
  }
}
// Provider amount types must earn qualification before numeric conversion.
// Equal independently specified endpoints do not prove a missing amount.
// Exercise observation -> sanitized overlay -> Forecast -> native renderer,
// retaining a separate invented pending authorization throughout.
const observedBase = require('./fixtures/budget-surface-data');
const LivePlan = require('../scripts/live-plan');
for (const [name, rawAmount, expectedCents, qualified] of [
  ['numeric zero', 0, 0, true],
  ['decimal zero', '0.00', 0, true],
  ['signed decimal zero', '-0.0000', 0, true],
  ['numeric debit', 500, 50000, true],
  ['decimal debit', '500.00', 50000, true],
  ['four-place decimal', '12.5000', 1250, true],
  ['trimmed signed decimal', ' +12.50 ', 1250, true],
  ['numeric credit', -500, -50000, true],
  ['decimal credit', '-500.00', -50000, true],
  ['empty string', '', 0, false],
  ['whitespace string', ' ', 0, false],
  ['blank control whitespace', '\t\r\n', 0, false],
  ['boolean false', false, 0, false],
  ['boolean true', true, 100, false],
  ['empty array', [], 0, false],
  ['numeric array', [500], 50000, false],
  ['decimal array', ['500.00'], 50000, false],
  ['object', {}, 0, false],
  ['missing null', null, 0, false],
  ['hexadecimal string', '0x1', 100, false],
  ['binary string', '0b1', 100, false],
  ['octal string', '0o1', 100, false],
]) {
  const data = observedBase.canonical(), accountMap = copy(observedBase.map), payload = observedBase.payload();
  data.debts.push(copy(helocInput.debts.find(row => row.id === 'heloc')));
  accountMap.mappings.push({ providerAccountId: '2002', canonical: { collection: 'debts', id: 'heloc' }, atlasRole: 'heloc' });
  // Independent opening 4200000 cents; the posted delta is specified in the
  // table, never calculated by the function under test or raw input coercion.
  const closing = (4200000 + expectedCents) / 100;
  payload.accounts.push({ id: 2002, type: 'credit', balance: closing, currency: 'cad', updated_at: x.asOf + 'T17:55:00.000Z', balance_last_update: x.asOf + 'T17:55:00.000Z' });
  payload.transactions.push(
    { id: 93011, account_id: 2002, currency: 'cad', is_pending: false, status: 'cleared',
      date: '2026-08-16', amount: rawAmount, payee: 'Invented movement' },
    { id: 93012, account_id: 2002, currency: 'cad', is_pending: true, status: 'cleared',
      date: x.asOf, amount: '900.0000', payee: 'Invented pending authorization' }
  );
  const canonicalBefore = JSON.stringify(data), payloadBefore = JSON.stringify(payload), mapBefore = JSON.stringify(accountMap);
  const next = LivePlan.fromObservation({ data, payload, accountMap, identity: observedBase.identity }).data;
  const balanceEvidence = copy(helocInput.balanceEvidence);
  balanceEvidence.cards.find(row => row.id === 'heloc').closing.amount = closing;
  const packet = next.liveOverlay.currentPeriodActuals;
  const publication = F.cardPeriodMovements(next.plan, next.debts, x.asOf, x.window,
    { currentPeriodActuals: packet, cardPeriodBalanceEvidence: balanceEvidence, liveOverlay: next.liveOverlay });
  const row = publication.cards.find(card => card.id === 'heloc');
  eq(row.netChange.amount, qualified ? expectedCents / 100 : null, name + ' native qualified delta');
  eq(row.status, qualified ? 'ready' : 'unavailable', name + ' native qualification');
  eq(row.netChange.trust, qualified ? 'calculated' : 'unavailable', name + ' native trust');
  eq(row.netChange.completeness, qualified ? 'complete' : 'unavailable', name + ' native completeness');
  eq(packet.cardCoverageUnconfirmed.length > 0, !qualified, name + ' missing amount marker survives overlay');
  eq(row.reasons.includes('transaction-evidence-unconfirmed'), !qualified, name + ' native reason');
  eq(packet.transactions.filter(tx => tx.account === 'heloc' && !tx.pending).map(tx => tx.amount === 0 ? 0 : tx.amount),
    qualified ? [expectedCents / 100] : [], name + ' no invented posted amount');
  eq(row.pending.map(tx => tx.amount), [900], name + ' pending remains separate');
  eq(row.posted.length, qualified ? 1 : 0, name + ' posted identity retained only for qualified evidence');
  const rendered = View.html(publication, { money: value => '$' + value.toFixed(2), date: value => value });
  eq(rendered.includes('data-budget-card-toggle="heloc"'), true, name + ' native renderer identity');
  if (!qualified) {
    const helocTrigger = rendered.slice(rendered.indexOf('data-budget-card-toggle="heloc"'));
    eq(helocTrigger.slice(0, helocTrigger.indexOf('</button>')).includes('Net'), false,
      name + ' renderer withholds false zero or one — no net prints on the trigger');
  }
  eq(JSON.stringify(data), canonicalBefore, name + ' no canonical mutation');
  eq(JSON.stringify(payload), payloadBefore, name + ' no provider input mutation');
  eq(JSON.stringify(accountMap), mapBefore, name + ' no map mutation');
}
console.log(`PASS card period movements: ${checks} independent assertions`);
