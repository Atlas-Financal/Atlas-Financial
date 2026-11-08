'use strict';
/* A20 — a Talk follow-up about "that card" never silently switches cards.
 *
 * A turn used to remember a card only as current.debts.facilities[i]. If
 * the facilities list reordered before the follow-up, "that card" read
 * whichever card now sat at index i. Each turn now records the stable
 * facility id behind every facility path it presented; follow-ups re-find
 * the card by that id, and ask (ambiguous) or withhold when it is gone.
 *
 * Path exercised: the server's binding step (TalkSession.attachFacilityRefs
 * on the presented turn with the answering packet) → the real session store
 * (createSessionContext().append / turns / lastTurn) → resolveFollowup and
 * TalkWhy.resolve on a later packet → publishablePaths. Invented cards and
 * amounts only; expectations are stated by hand.
 *
 * `node test/test-talk-stable-card-referent.js`
 */
const fs = require('fs');
const path = require('path');
const TalkSession = require('../scripts/talk-session.js');
const TalkWhy = require('../scripts/talk-why.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const CARD_A = { id: 'invented-card-a', label: 'Invented Card A', available: 111, trust: 'calculated' };
const CARD_B = { id: 'invented-card-b', label: 'Invented Card B', available: 222, trust: 'calculated' };
const packetWith = facilities => ({
  schema: 'atlas-assistant-current/v1',
  current: { debts: { status: 'ok', facilities } },
});

function storedTurnFor(answeringPacket, referentPaths) {
  const store = TalkSession.createSessionContext({ secret: 'synthetic-a20-secret', now: () => 1000 });
  const key = store.keyFromToken('synthetic-a20-cookie');
  const sessionTurn = { kind: 'explained', referentPaths };
  TalkSession.attachFacilityRefs(sessionTurn, answeringPacket);
  // Same field list the server's appendTalkSessionTurn passes.
  store.append(key, {
    question: 'What is available on Invented Card B?',
    presented: 'Invented Card B has $222.00 available.',
    kind: sessionTurn.kind,
    referentPaths: sessionTurn.referentPaths,
    facilityRefs: sessionTurn.facilityRefs,
  });
  return TalkSession.lastTurn(store.turns(key));
}

const valueAt = (paths, packet, field) => {
  const claims = TalkWhy.publishablePaths(paths, packet);
  const row = claims.find(c => c.path.endsWith('.' + field));
  return row ? row.value : undefined;
};

// Card B was presented at index 1.
const before = packetWith([CARD_A, CARD_B]);
const prior = storedTurnFor(before, ['current.debts.facilities[1].available']);

console.log('=== 1. the stored turn carries the card identity ===');
ok(prior && Array.isArray(prior.facilityRefs)
    && prior.facilityRefs.length === 1
    && prior.facilityRefs[0].index === 1 && prior.facilityRefs[0].id === 'invented-card-b',
  'session store keeps index 1 → invented-card-b');

console.log('\n=== 2. after a reorder, "that card" still reads Card B ===');
{
  const reordered = packetWith([CARD_B, CARD_A]);
  const card = TalkSession.resolveFollowup({ question: 'What about that card?', priorTurn: prior, debts: [], packet: reordered });
  ok(card.status === 'resolved-reference' && card.referentKey === 'card', 'card follow-up resolves', JSON.stringify(card));
  ok(card.paths && card.paths.every(p => p.startsWith('current.debts.facilities[0].')),
    'paths are re-bound to Card B\'s new index 0');
  ok(valueAt(card.paths, reordered, 'available') === 222 && valueAt(card.paths, reordered, 'label') === 'Invented Card B',
    'the answer reads Card B (222), not Card A (111) at the old index');
}

console.log('\n=== 3. a generic "that" follow-up re-binds too ===');
{
  const reordered = packetWith([CARD_B, CARD_A]);
  const that = TalkSession.resolveFollowup({ question: 'What about that?', priorTurn: prior, debts: [], packet: reordered });
  ok(that.status === 'resolved-reference' && that.referentKey === 'last-presented',
    '"What about that?" reaches the last-presented re-read', JSON.stringify(that));
  ok(valueAt(that.paths || [], reordered, 'available') === 222, 'last-presented re-reads Card B (222)');
}

console.log('\n=== 4. "why" about the last answer re-binds by identity ===');
{
  const reordered = packetWith([CARD_B, CARD_A]);
  const why = TalkWhy.resolve({ question: 'Why is Atlas telling me that?', packet: reordered, priorTurn: prior });
  ok(why.status === 'ready' && why.claims.some(c => c.path === 'current.debts.facilities[0].available' && c.value === 222)
      && !why.claims.some(c => c.value === 111),
    'why reads Card B at its new index', JSON.stringify(why).slice(0, 200));
}

console.log('\n=== 5. a card that disappeared is asked about or withheld, never swapped ===');
{
  const gone = packetWith([CARD_A, { id: 'invented-card-c', label: 'Invented Card C', available: 333, trust: 'calculated' }]);
  const card = TalkSession.resolveFollowup({ question: 'What about that card?', priorTurn: prior, debts: [], packet: gone });
  ok(card.status === 'ambiguous', '"that card" asks rather than reading Card C at index 1', card.status);
  const that = TalkSession.resolveFollowup({ question: 'What about that?', priorTurn: prior, debts: [], packet: gone });
  ok(that.status === 'ambiguous', '"What about that?" asks rather than reading a substitute card', JSON.stringify(that));
  const why = TalkWhy.resolve({ question: 'Why is Atlas telling me that?', packet: gone, priorTurn: prior });
  ok(why.status === 'unavailable', 'why withholds when the card is gone', why.status);
}

console.log('\n=== 6. a facility path with no recorded identity is not trusted ===');
{
  const legacy = { kind: 'explained', question: 'q', presented: 'p', referentPaths: ['current.debts.facilities[1].available'] };
  const card = TalkSession.resolveFollowup({ question: 'What about that card?', priorTurn: legacy, debts: [], packet: before });
  ok(card.status === 'ambiguous', 'an index-only card reference asks instead of guessing');
}

console.log('\n=== 7. the server records the identity on every stored turn ===');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/facilityRefs: presented\.sessionTurn && presented\.sessionTurn\.facilityRefs/.test(src),
    'appendTalkSessionTurn passes facilityRefs to the session store');
  ok(/TalkSession\.attachFacilityRefs\(presented\.sessionTurn, packet\);\s*return \{ presented \};/.test(src),
    'presentTalkAskTurn binds identities with the answering packet before returning');
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All A20 stable card referent checks passed'));
process.exit(failures ? 1 : 0);
