'use strict';
/* Talk verified follow-up references.
 *
 * Proves campaign-style deixis resolves only against ephemeral
 * structured refs from a prior verified presentation, re-reads this
 * request's packet or recomputes Forecast, and fails closed on
 * ambiguous or prose-only history. Hyp/compare inheritance and Why?
 * last-presented stay in force. Mocked Gemini only.
 * `node test/test-talk-followup-refs.js`
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Assistant = require('../scripts/assistant-packet.js');
const TalkGemini = require('../scripts/talk-gemini.js');
const TalkPresentation = require('../scripts/talk-presentation.js');
const TalkSession = require('../scripts/talk-session.js');
const TalkWhy = require('../scripts/talk-why.js');
const Forecast = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');
const POSITIONS = path.join(ROOT, 'docs', 'positions.csv');
const SNAPSHOT_DIR = path.join(ROOT, 'snapshots');
const PASS = 'synthetic-site-password';
const SECRET = 'synthetic-session-secret';
const GEMINI_KEY = 'synthetic-talk-gemini-key-32chars!!';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) {
    failures += 1;
  }
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));

const liveHash = hashFile(DATA);
const positionsHash = fs.existsSync(POSITIONS) ? hashFile(POSITIONS) : null;
const snapshotHashes = fs.readdirSync(SNAPSHOT_DIR)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => `${name}:${hashFile(path.join(SNAPSHOT_DIR, name))}`);

function snapshotState() {
  return fs.readdirSync(SNAPSHOT_DIR)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => `${name}:${hashFile(path.join(SNAPSHOT_DIR, name))}`);
}

function filesUnchanged(label) {
  ok(hashFile(DATA) === liveHash, `${label}: data.json bytes unchanged`);
  if (positionsHash) {
    ok(hashFile(POSITIONS) === positionsHash, `${label}: positions.csv bytes unchanged`);
  }
  const now = snapshotState();
  ok(now.length === snapshotHashes.length
    && now.every((row, i) => row === snapshotHashes[i]),
    `${label}: snapshots unchanged`);
}

function isolatedEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const key of Object.keys(env)) {
    if (/^(ATLAS_|LUNCHMONEY_)/.test(key)) delete env[key];
  }
  return Object.assign(env, extra || {});
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(err => err ? reject(err) : resolve(port));
    });
    server.on('error', reject);
  });
}

function startAtlas(env) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('server start timeout\n' + stderr));
    }, 8000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!settled && /listening/.test(stdout)) {
        settled = true;
        clearTimeout(timer);
        resolve({
          stop: () => new Promise(done => {
            child.once('exit', () => done());
            child.kill('SIGTERM');
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } }, 2000);
          }),
        });
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${stderr}`));
    });
  });
}

async function login(base, password) {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(password || PASS)}`,
  });
  const setCookie = res.headers.get('set-cookie') || '';
  return { status: res.status, cookie: setCookie.split(';')[0], setCookie };
}

function geminiOkBody(text) {
  return JSON.stringify({
    candidates: [{
      content: { parts: [{ text }], role: 'model' },
      finishReason: 'STOP',
    }],
  });
}

function packetFromGeminiRequest(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  const parts = body
    && body.contents
    && body.contents[0]
    && body.contents[0].parts;
  const text = Array.isArray(parts)
    ? parts.map(part => (part && part.text) || '').join('\n')
    : '';
  const marker = 'Incumbent Atlas assistant packet';
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  const jsonStart = text.indexOf('{', idx);
  if (jsonStart < 0) return null;
  try {
    return JSON.parse(text.slice(jsonStart));
  } catch {
    return null;
  }
}

function startMockGemini(replies) {
  const captured = [];
  const queue = Array.isArray(replies) ? replies.slice() : [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      captured.push({ method: req.method, url: req.url, raw });
      const next = queue.length > 0 ? queue.shift() : JSON.stringify({
        status: 'explained',
        claims: [{ path: 'authority.planner', equals: 'Forecast' }],
      });
      const text = typeof next === 'function' ? next(raw) : next;
      res.setHeader('content-type', 'application/json');
      // One connection per Gemini call. Under hosted-CI CPU load, server.js's
      // synchronous packet build can hold its event loop past this mock's 5s
      // keep-alive, so the server reused a socket the mock had already closed
      // ("other side closed"): that turn 502'd and the reply queue shifted.
      res.setHeader('connection', 'close');
      res.end(geminiOkBody(typeof text === 'string' ? text : JSON.stringify(text)));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        captured,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
    server.on('error', reject);
  });
}

function askJson(base, cookie, question) {
  return fetch(`${base}/talk/ask`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ question }),
  });
}

function fixtureDebts() {
  return [
    {
      id: 'high', label: 'High-rate card',
      balance: 800, pending: 0, rate: 26.99, rateConvention: 'card',
      structure: 'Revolving — synthetic high', secured: false, limit: 1200,
    },
    {
      id: 'heloc', label: 'HELOC',
      balance: 5000, pending: 0, rate: 4.9, rateConvention: 'variable',
      structure: 'Interest-only revolving — never amortises', secured: true, limit: 6000,
    },
  ];
}

function fixturePacket() {
  return {
    schema: Assistant.SCHEMA,
    authority: { planner: 'Forecast' },
    metadata: {
      effectiveAsOf: '2026-09-15',
      freshness: { confidence: 'canonical-opening' },
    },
    forecast: {
      currentPeriodAction: {
        essentialRemaining: 1415.95,
        weeklyCap: 400,
        periodStart: '2026-09-11',
        periodEnd: '2026-09-24',
        nextPayday: '2026-09-25',
        remainingClaim: 'precise',
      },
    },
    current: {
      spendableHouseholdCash: { status: 'ok', value: 939.62, trust: 'calculated' },
      debts: {
        monthlyInterest: 88.2,
        totalAvailableCredit: 1500,
        overLimitCount: 1,
        facilities: [
          { id: 'high', label: 'High-rate card', available: 400, trust: 'calculated' },
          { id: 'heloc', label: 'HELOC', available: 1000, trust: 'calculated' },
        ],
      },
    },
  };
}

console.log('=== 1. Verified follow-up refs are structured, ephemeral, and fail closed ===');
{
  const sessionSrc = read('scripts/talk-session.js');
  const sessionRaw = fs.readFileSync(path.join(ROOT, 'scripts/talk-session.js'), 'utf8');
  const serverSrc = read('server.js');
  const forecastSrc = fs.readFileSync(path.join(ROOT, 'public/forecast.js'), 'utf8');
  ok(!/fs\.(write|append)File|sqlite|indexedDB|localStorage|createWriteStream/.test(sessionSrc),
    'talk-session.js still has no durable store');
  ok(/never conversation prose/.test(sessionRaw)
      && /resolveVerifiedReference/.test(sessionSrc)
      && /resolved-reference/.test(sessionSrc),
    'session module states structured-ref follow-ups, not chat-memory figures');
  ok(/resolved-reference/.test(serverSrc)
      && /publishablePaths/.test(serverSrc)
      && /referentKeys/.test(serverSrc),
    'server re-reads allowlisted paths for a resolved verified follow-up');
  ok(!/require\(['"][^'"]*forecast/i.test(sessionSrc),
    'talk-session.js does not import Forecast');
  ok(/Do not fill a missing amount or named debt from prior turns/.test(TalkGemini.INSTRUCTION),
    'Gemini instruction still forbids promoting chat text to household fact');
  ok(!/resolved-reference|referentKeys|what about next payday/.test(forecastSrc),
    'public/forecast.js is untouched');
}

console.log('\n=== 2. Unique structured refs resolve; ambiguity and prose fail closed ===');
{
  const packet = fixturePacket();
  const debts = fixtureDebts();
  const periodTurn = {
    kind: 'explained',
    question: 'What is remaining?',
    presented: 'You have $9.99 remaining. Next payday is 1999-01-01.',
    referentPaths: ['forecast.currentPeriodAction.essentialRemaining'],
  };
  const payday = TalkSession.resolveFollowup({
    question: 'What about next payday?',
    priorTurn: periodTurn,
    debts,
    packet,
  });
  ok(payday.status === 'resolved-reference'
      && payday.referentKey === 'next-payday'
      && payday.paths[0] === 'forecast.currentPeriodAction.nextPayday',
    'next-payday follow-up binds the pay-period sibling path, not presented prose');
  const moved = JSON.parse(JSON.stringify(packet));
  moved.forecast.currentPeriodAction.nextPayday = '2026-10-09';
  const claims = TalkWhy.publishablePaths(payday.paths, moved);
  const presentedPayday = TalkPresentation.presentVerifiedClaims({
    status: 'explained',
    claims,
  }, moved);
  ok(claims.length === 1
      && claims[0].value === '2026-10-09'
      && /2026-10-09/.test(presentedPayday.answer)
      && presentedPayday.answer.indexOf('1999-01-01') === -1
      && presentedPayday.answer.indexOf('$9.99') === -1,
    'next-payday re-reads the current packet and ignores stale presented wording');

  ok(TalkSession.resolveFollowup({
    question: 'What about next payday?',
    priorTurn: null,
    debts,
    packet,
  }).status === 'ambiguous',
    'next-payday deixis without a structured pay-period ref is unavailable');

  const cardTurn = {
    kind: 'explained',
    question: 'What is available on the high-rate card?',
    presented: 'A credit facility has $99,999.00 available.',
    referentPaths: ['current.debts.facilities[0].available'],
  };
  const card = TalkSession.resolveFollowup({
    question: 'What about that card?',
    priorTurn: cardTurn,
    debts,
    packet,
  });
  ok(card.status === 'resolved-reference'
      && card.referentKey === 'card'
      && card.paths.includes('current.debts.facilities[0].label')
      && card.paths.includes('current.debts.facilities[0].available'),
    'that-card follow-up uses the unique facility ref');
  const cardClaims = TalkWhy.publishablePaths(card.paths, packet);
  const presentedCard = TalkPresentation.presentVerifiedClaims({
    status: 'explained',
    claims: cardClaims,
  }, packet);
  ok(cardClaims.some(row => row.path === 'current.debts.facilities[0].available'
        && row.value === 400)
      && /High-rate card/.test(presentedCard.answer)
      && /\$400\.00/.test(presentedCard.answer)
      && presentedCard.answer.indexOf('99,999') === -1,
    'that-card re-reads current facility fields, not the old $99,999 prose');

  ok(TalkSession.resolveFollowup({
    question: 'What about that card?',
    priorTurn: {
      kind: 'explained',
      question: 'What is the credit picture?',
      presented: 'Two cards.',
      referentPaths: [
        'current.debts.facilities[0].available',
        'current.debts.facilities[1].available',
      ],
    },
    debts,
    packet,
  }).status === 'ambiguous',
    'that-card with two facility refs is unavailable');

  const interestTurn = {
    kind: 'explained',
    question: 'What is monthly interest?',
    presented: 'Monthly interest is $99,999.00.',
    referentPaths: ['current.debts.monthlyInterest'],
  };
  const interest = TalkSession.resolveFollowup({
    question: 'How much interest was that again?',
    priorTurn: interestTurn,
    debts,
    packet,
  });
  ok(interest.status === 'resolved-reference'
      && interest.referentKey === 'interest'
      && interest.paths[0] === 'current.debts.monthlyInterest',
    'interest-again binds the published monthly-interest path');
  const interestClaims = TalkWhy.publishablePaths(interest.paths, packet);
  const presentedInterest = TalkPresentation.presentVerifiedClaims({
    status: 'explained',
    claims: interestClaims,
  }, packet);
  ok(interestClaims[0].value === 88.2
      && /\$88\.20/.test(presentedInterest.answer)
      && presentedInterest.answer.indexOf('99,999') === -1,
    'interest-again re-reads current monthly interest, not presented prose');

  const proseOnly = {
    kind: 'explained',
    question: 'How much interest?',
    presented: 'Monthly interest is $99,999.00. Next payday is 1999-01-01.',
  };
  ok(TalkSession.resolveFollowup({
    question: 'How much interest was that again?',
    priorTurn: proseOnly,
    debts,
    packet,
  }).status === 'ambiguous',
    'prose-only history cannot invent an interest figure');
  ok(TalkSession.resolveFollowup({
    question: 'What about next payday?',
    priorTurn: proseOnly,
    debts,
    packet,
  }).status === 'ambiguous',
    'prose-only history cannot invent a next-payday date');
  ok(TalkSession.resolveFollowup({
    question: 'What about that?',
    priorTurn: proseOnly,
    debts,
    packet,
  }).status === 'ambiguous',
    'bare that-deixis without structured paths is unavailable');

  const priorHyp = {
    kind: 'hypothetical',
    question: 'What if I put $200 on the High-rate card?',
    amount: 200,
    debtId: 'high',
    debtLabel: 'High-rate card',
    referentKeys: ['interest'],
  };
  const hypInterest = TalkSession.resolveFollowup({
    question: 'How much interest was that again?',
    priorTurn: priorHyp,
    debts,
    packet,
  });
  ok(hypInterest.status === 'resolved-hypothetical'
      && hypInterest.amount === 200
      && hypInterest.debtId === 'high',
    'interest-again after a hyp recomputes that extra on current Forecast inputs');
  ok(TalkSession.resolveFollowup({
    question: 'How much interest was that again?',
    priorTurn: {
      kind: 'comparison',
      scenarios: [
        { amount: 200, debtId: 'high', debtLabel: 'High-rate card' },
        { amount: 200, debtId: 'heloc', debtLabel: 'HELOC' },
      ],
    },
    debts,
    packet,
  }).status === 'ambiguous',
    'interest-again after a comparison is ambiguous');

  const amountSwap = TalkSession.resolveFollowup({
    question: 'What about $500 instead?',
    priorTurn: priorHyp,
    debts,
    packet,
  });
  ok(amountSwap.status === 'resolved-hypothetical'
      && amountSwap.amount === 500
      && amountSwap.debtId === 'high',
    'authorized amount inheritance is unchanged');
  ok(TalkSession.resolveFollowup({
    question: 'And what about the HELOC payment?',
    priorTurn: priorHyp,
    debts,
    packet,
  }).status === 'none',
    'HELOC payment explainer follow-up is still not a silent inherited extra');

  const lastWhy = TalkWhy.resolve({
    question: 'Why is Atlas telling me that?',
    packet,
    priorTurn: periodTurn,
  });
  ok(lastWhy.status === 'ready'
      && lastWhy.claims[0].path === 'forecast.currentPeriodAction.essentialRemaining'
      && lastWhy.claims[0].value === 1415.95,
    'Why? last-presented still re-reads the stored path from this packet');

  const store = TalkSession.createSessionContext({ secret: SECRET });
  const key = store.keyFromToken('cookie-refs');
  ok(store.append(key, {
    kind: 'explained',
    question: 'What is remaining?',
    presented: 'You have $1,415.95 remaining.',
    referentPaths: ['forecast.currentPeriodAction.essentialRemaining'],
  }) === true, 'explained turn stores derived pay-period keys from paths');
  const stored = store.turns(key)[0];
  ok(stored.referentKeys
      && stored.referentKeys.includes('pay-period'),
    'sanitized turn derives the pay-period result key');
  ok(TalkSession.publicConversation(store.turns(key)).every(row => (
    !row.referentPaths && !row.referentKeys
  )), 'public conversation still exposes wording only');
}

console.log('\n=== 3. Session HTTP re-reads current packet / Forecast ===');
async function runHttpProof() {
  const liveData = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const livePacket = Assistant.buildPacket({
    data: liveData,
    env: {},
    now: new Date().toISOString(),
  });
  const remaining = livePacket.forecast.currentPeriodAction.essentialRemaining;
  const payday = livePacket.forecast.currentPeriodAction.nextPayday;
  const facility = livePacket.current.debts.facilities[0];
  ok(Number.isFinite(Number(remaining)) && typeof payday === 'string' && payday,
    'live packet still publishes remaining and next payday for independent HTTP proof');
  ok(facility && typeof facility.label === 'string' && Number.isFinite(Number(facility.available)),
    'live packet still publishes one facility for the card follow-up');
  // Independent Forecast expectation for the hyp turn, computed before any
  // HTTP turn so this process does no long synchronous work while holding an
  // idle keep-alive socket to Atlas. Same unchanged data.json (asserted below).
  const hypExpected = Forecast.hypotheticalExtraPayment(
    liveData.plan,
    liveData.debts,
    liveData.plan.opening.asOf,
    { amount: 200, debtId: 'cashback', nature: 'hypothetical' }
  );

  const mock = await startMockGemini([
    (raw) => {
      const packet = packetFromGeminiRequest(raw);
      const value = packet
        && packet.forecast
        && packet.forecast.currentPeriodAction
        && packet.forecast.currentPeriodAction.essentialRemaining;
      return JSON.stringify({
        status: 'explained',
        claims: [{
          path: 'forecast.currentPeriodAction.essentialRemaining',
          equals: value,
        }],
      });
    },
    JSON.stringify({
      status: 'explained',
      claims: [{
        path: 'current.debts.monthlyInterest',
        equals: 99999,
      }],
    }),
    (raw) => {
      const packet = packetFromGeminiRequest(raw);
      const row = packet
        && packet.current
        && packet.current.debts
        && packet.current.debts.facilities
        && packet.current.debts.facilities[0];
      return JSON.stringify({
        status: 'explained',
        claims: [{
          path: 'current.debts.facilities[0].available',
          equals: row && row.available,
        }],
      });
    },
    JSON.stringify({
      intent: 'hypothetical-extra-payment',
      amount: 200,
      debtLabel: 'TD Cash Back Visa',
    }),
  ]);
  const port = await freePort();
  const atlas = await startAtlas(isolatedEnv({
    SITE_PASSWORD: PASS,
    SESSION_SECRET: SECRET,
    ATLAS_TALK_GEMINI_API_KEY: GEMINI_KEY,
    ATLAS_TALK_GEMINI_BASE_URL: mock.url,
    PORT: String(port),
  }));
  const base = `http://127.0.0.1:${port}`;
  try {
    const sessionA = await login(base);
    await new Promise(resolve => setTimeout(resolve, 5));
    const sessionB = await login(base);

    const first = await askJson(base, sessionA.cookie, 'What is remaining in this pay period?');
    const firstBody = await first.json();
    ok(first.status === 200
        && /remaining/i.test(firstBody.answer)
        && firstBody.answer !== TalkPresentation.UNAVAILABLE_ANSWER,
      'first turn publishes a verified remaining answer from this packet');
    const geminiAfterFirst = mock.captured.length;

    const paydayFollow = await askJson(base, sessionA.cookie, 'What about next payday?');
    const paydayBody = await paydayFollow.json();
    ok(paydayFollow.status === 200
        && paydayBody.answer.indexOf(payday) !== -1
        && paydayBody.answer.indexOf('1999-01-01') === -1
        && mock.captured.length === geminiAfterFirst,
      'next-payday follow-up re-reads the current packet and does not call Gemini');

    const isolatedPayday = await askJson(base, sessionB.cookie, 'What about next payday?');
    const isolatedBody = await isolatedPayday.json();
    ok(isolatedPayday.status === 200
        && isolatedBody.answer === TalkPresentation.UNAVAILABLE_ANSWER
        && isolatedBody.answer.indexOf(payday) === -1,
      'session B cannot resolve session A payday refs');

    const invented = await askJson(base, sessionB.cookie, 'How much is monthly interest?');
    ok(invented.status === 502 && mock.captured.length === geminiAfterFirst + 1,
      'Gemini cannot publish a chat-invented interest figure that the packet does not have');

    const cardAsk = await askJson(base, sessionB.cookie, 'What is available on the first card?');
    const cardBody = await cardAsk.json();
    ok(cardAsk.status === 200
        && cardBody.answer.indexOf(TalkPresentation.formatCurrency(facility.available)) !== -1,
      'unique facility presentation binds a card ref');
    const geminiAfterCard = mock.captured.length;
    const cardFollow = await askJson(base, sessionB.cookie, 'What about that card?');
    const cardFollowBody = await cardFollow.json();
    ok(cardFollow.status === 200
        && cardFollowBody.answer.indexOf(facility.label) !== -1
        && cardFollowBody.answer.indexOf(TalkPresentation.formatCurrency(facility.available)) !== -1
        && mock.captured.length === geminiAfterCard,
      'that-card follow-up re-reads the current facility and does not call Gemini');

    const hyp = await askJson(base, sessionA.cookie, 'What if I put $200 on the TD Cash Back Visa?');
    const hypBody = await hyp.json();
    ok(hyp.status === 200
        && hypExpected.status === 'ready'
        && hypBody.answer.indexOf(TalkPresentation.formatCurrency(hypExpected.delta.debt.interest)) !== -1,
      'hyp turn publishes independently recomputed Forecast interest');
    const geminiAfterHyp = mock.captured.length;
    const again = await askJson(base, sessionA.cookie, 'How much interest was that again?');
    const againBody = await again.json();
    const againExpected = Forecast.hypotheticalExtraPayment(
      liveData.plan,
      liveData.debts,
      liveData.plan.opening.asOf,
      { amount: 200, debtId: 'cashback', nature: 'hypothetical' }
    );
    ok(again.status === 200
        && againExpected.status === 'ready'
        && againBody.answer.indexOf(TalkPresentation.formatCurrency(againExpected.delta.debt.interest)) !== -1
        && mock.captured.length === geminiAfterHyp,
      'interest-again after a hyp recomputes Forecast on current state and does not call Gemini');
  } finally {
    await atlas.stop();
    await mock.close();
  }
  filesUnchanged('Talk verified follow-up refs');
}

runHttpProof().then(() => {
  ok(hashFile(DATA) === liveHash, 'live data.json bytes unchanged at suite end');
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
