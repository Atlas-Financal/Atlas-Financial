'use strict';
/* "Credit left, everywhere" is unknown when any facility's headroom is.
 *
 * Forecast.utilisation used to sum `r.available || 0`, so a card whose
 * pending charges were not observed (available withheld, `null`) counted as
 * $0 and the combined total still printed as a precise figure — while the
 * Credit page said "Not published" for that same card.
 *
 * Invented facilities, hand-computed here and not by the code under test:
 *   card-a     balance 1,000  pending 200  limit 5,000 → 5,000 − 1,200 = 3,800
 *   card-b     balance   500  pending ?    limit 3,000 → not published
 *   overdraft  used 100 of 400                           → 400 − 100   =   300
 *   all known (card-b pending 0): 3,800 + 2,500 + 300 = 6,600
 *
 * The page path (Budget snapshot tile and Deep Dive) is proved in the
 * browser by test/browser-credit-left-unknown.js; this suite proves the
 * engine, publicationTotals, the plan.js tile helper, the positions rows
 * and the Talk answer built from the assistant packet.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const Positions = require('../scripts/positions-summary.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const read = p => sourceText(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));

const CARD_A = { id: 'card-a', label: 'Invented card A', balance: 1000, pending: 200, limit: 5000 };
const CARD_B = { id: 'card-b', label: 'Invented card B', balance: 500, limit: 3000 };
const MORTGAGE = { id: 'mortgage', label: 'Invented mortgage', balance: 90000, secured: true };
const OVERDRAFT = [{ id: 'od', label: 'Invented overdraft', used: 100, limit: 400, pending: 0 }];
const HAND_A = 5000 - (1000 + 200);
const HAND_B_KNOWN = 3000 - (500 + 0);
const HAND_OD = 400 - 100;
const HAND_ALL_KNOWN = HAND_A + HAND_B_KNOWN + HAND_OD;

const unknownDebts = [CARD_A, Object.assign({}, CARD_B, { pendingUnknown: true }), MORTGAGE];
const knownDebts = [CARD_A, Object.assign({}, CARD_B, { pending: 0 }), MORTGAGE];

console.log('=== hand arithmetic ===');
ok(HAND_A === 3800 && HAND_B_KNOWN === 2500 && HAND_OD === 300 && HAND_ALL_KNOWN === 6600,
  'hand totals: 3,800 + 2,500 + 300 = 6,600');

console.log('\n=== engine: Forecast.utilisation ===');
const uUnknown = F.utilisation(unknownDebts, OVERDRAFT, null);
const rowB = uUnknown.rows.find(r => r.id === 'card-b');
ok(rowB && rowB.available === null, 'card-b with unknown pending has no published headroom (row unchanged)');
ok(uUnknown.rows.find(r => r.id === 'card-a').available === HAND_A, 'card-a row is still 3,800');
ok(uUnknown.rows.find(r => r.id === 'od').available === HAND_OD, 'overdraft row is still 300');
ok(uUnknown.totalAvailable === null,
  'combined total is null (unknown), not a sum counting card-b as $0', String(uUnknown.totalAvailable));
ok(uUnknown.totalAvailable !== HAND_A + HAND_OD, 'the old precise 4,100 is not published');
const uKnown = F.utilisation(knownDebts, OVERDRAFT, null);
ok(uKnown.totalAvailable === HAND_ALL_KNOWN, 'every facility known: total is the hand 6,600', String(uKnown.totalAvailable));
const overLimitUnknown = F.utilisation([CARD_A,
  Object.assign({}, CARD_B, { balance: 3500, pendingUnknown: true })], [], null);
ok(overLimitUnknown.rows.find(r => r.id === 'card-b').available === 0
  && overLimitUnknown.totalAvailable === HAND_A,
  'a card over its limit on posted alone publishes 0 room, so the total stays known: 3,800');
ok(F.utilisation([MORTGAGE], [], null).totalAvailable === 0, 'no revolving facility: total is 0, not unknown');

console.log('\n=== publicationTotals.creditLeft ===');
const pubUnknown = F.publicationTotals({ debts: unknownDebts, revolvingExtra: OVERDRAFT, meta: {}, plan: {} });
ok(pubUnknown.creditLeft === null, 'creditLeft is null when one facility is unknown', String(pubUnknown.creditLeft));
ok(pubUnknown.revolvingFacilityCount === 3, 'facility count still 3');
const pubKnown = F.publicationTotals({ debts: knownDebts, revolvingExtra: OVERDRAFT, meta: {}, plan: {} });
ok(pubKnown.creditLeft === HAND_ALL_KNOWN, 'creditLeft is 6,600 when all are known');

console.log('\n=== plan.js snapshot tile ===');
const appSrc = read('public/app.js');
const planSrc = read('public/plan.js');
const moneyLine = /^const money = .*$/m.exec(appSrc)[0];
const helper = /^function creditLeftTile\([\s\S]*?\n\}$/m.exec(planSrc);
ok(!!helper, 'plan.js has one creditLeftTile helper');
ok((planSrc.match(/^    creditLeftTile\(revolving\),$/gm) || []).length === 2,
  'both snapshot renders (normal and settlement-unavailable) use it');
ok(!/lab: 'Credit left, everywhere', val: money\(revolving\)/.test(planSrc.replace(helper ? helper[0] : '', '')),
  'no other plan.js tile prints money(revolving) for credit left');
const tile = helper ? vm.runInNewContext(`${moneyLine}\n${helper[0]}\ncreditLeftTile`, {}) : () => ({ val: '', note: '' });
const tUnknown = tile(null);
ok(tUnknown.val === 'Unknown' && !/\$\d/.test(tUnknown.val + tUnknown.note), 'null prints Unknown with no dollar figure');
ok(tile(HAND_ALL_KNOWN).val === '$6,600', 'a known total prints $6,600');
ok(tile(0).val === '$0', 'a known zero still prints $0, not Unknown');

console.log('\n=== deepdive.js tile ===');
const ddSrc = read('public/deepdive.js');
ok(/display: pub\.creditLeft == null \? 'Unknown' : null/.test(ddSrc), 'Deep Dive maps a null creditLeft to Unknown');
ok(/t\.display != null \? t\.display : money\(t\.value\)/.test(ddSrc), 'the tile renderer prints the display text when set');

console.log('\n=== positions rows ===');
const CSV = [
  'entity,institution,account_label',
  'CREDIT,,Total revolving credit available,,Net,CAD,1.00',
  'LIQUIDITY,,Immediate liquidity total,,Net,CAD,1.00',
].join('\n');
const posData = k => ({
  meta: { asOf: '2026-08-20' }, debts: k ? knownDebts : unknownDebts, revolvingExtra: OVERDRAFT,
  plan: { startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented', value: 1000 }] } },
});
const rowOf = (text, label) => Positions.parse(text.split('\n').find(r => Positions.parse(r)[2] === label));
const posUnknown = Positions.regenerateComputedRows(posData(false), CSV, { periods: null }).text;
const credU = rowOf(posUnknown, 'Total revolving credit available');
const liqU = rowOf(posUnknown, 'Immediate liquidity total');
ok(credU[6] === '' && credU[18] === 'UNKNOWN', 'positions credit row is blank and UNKNOWN', `${credU[6]}|${credU[18]}`);
ok(liqU[6] === '' && liqU[18] === 'UNKNOWN', 'immediate liquidity is blank and UNKNOWN', `${liqU[6]}|${liqU[18]}`);
const posKnown = Positions.regenerateComputedRows(posData(true), CSV, { periods: null }).text;
ok(rowOf(posKnown, 'Total revolving credit available')[6] === '6600.00', 'positions credit row is 6600.00 when known');
ok(rowOf(posKnown, 'Immediate liquidity total')[6] === (1000 + HAND_ALL_KNOWN).toFixed(2),
  'immediate liquidity is cash 1,000 + 6,600 when known');

console.log('\n=== Talk: the household-visible consumer ===');
// Talk reads current.debts.totalAvailableCredit from the assistant packet.
// Fixture card: limit 5,000, balance 2,000, pending 0 → 3,000 known room.
const Assistant = require('../scripts/assistant-packet.js');
const TalkPresentation = require('../scripts/talk-presentation.js');
const fx = require('./fixtures/budget-surface-data');
const talkKnown = fx.served();
const fixtureCard = talkKnown.debts[0];
const HAND_FIXTURE_ROOM = fixtureCard.limit - (fixtureCard.balance + (fixtureCard.pending || 0));
const packetKnown = Assistant.buildPacket({ data: talkKnown, periods: null, questionsMarkdown: '' });
ok(packetKnown.current.debts.totalAvailableCredit === HAND_FIXTURE_ROOM,
  'packet total is the fixture card room when every facility is known',
  String(packetKnown.current.debts.totalAvailableCredit));
const talkUnknown = fx.served();
talkUnknown.debts = talkUnknown.debts.concat([Object.assign({}, CARD_B, { pendingUnknown: true })]);
const packetUnknown = Assistant.buildPacket({ data: talkUnknown, periods: null, questionsMarkdown: '' });
ok(packetUnknown.current.debts.totalAvailableCredit === null,
  'packet total is null when a facility has unknown pending, not the known room alone',
  String(packetUnknown.current.debts.totalAvailableCredit));
const said = TalkPresentation.presentVerifiedClaims({
  status: 'explained',
  claims: [{ path: 'current.debts.totalAvailableCredit', value: packetUnknown.current.debts.totalAvailableCredit }],
}, packetUnknown);
ok(said && /unavailable/.test(said.answer) && !/\$\d/.test(said.answer),
  'Talk answers that total available credit is unavailable, with no dollar figure', said && said.answer);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
