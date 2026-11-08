'use strict';
/* Talk payday leftover reprints Forecast Balance After Deductions.
 *
 * Independent proof: Talk-published leftover equals Forecast leftover for
 * the same fixture. Talk does not calculate leftover. History is
 * referential only. Ambiguous leftover deixis fails closed. Unavailable
 * leftover is not $0. Gemini extracts leftover intent or referent only.
 * `node test/test-talk-payday-leftover.js`
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
const LEFTOVER_PATH = TalkSession.LEFTOVER_PATH;

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const liveHash = hashFile(DATA);
const forecastHash = hashFile(path.join(ROOT, 'public/forecast.js'));
const talkJsHash = hashFile(path.join(ROOT, 'public/talk.js'));
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
  ok(hashFile(path.join(ROOT, 'public/forecast.js')) === forecastHash,
    `${label}: public/forecast.js bytes unchanged`);
  ok(hashFile(path.join(ROOT, 'public/talk.js')) === talkJsHash,
    `${label}: public/talk.js bytes unchanged`);
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

function adviceFor(data, periods) {
  const overlay = data && data.liveOverlay;
  const asOf = (overlay && overlay.applied === true && overlay.effectiveAsOf)
    || (data.plan && data.plan.opening && data.plan.opening.asOf)
    || (data.meta && data.meta.asOf);
  const actuals = overlay && overlay.applied === true
    ? overlay.currentPeriodActuals
    : null;
  return Forecast.recommend(data.plan, asOf, {
    fundingSources: data.plan.funding && data.plan.funding.options,
    debts: data.debts,
    revolvingExtra: data.revolvingExtra,
    periods: periods || null,
    currentPeriodActuals: actuals,
    operatingPlan: overlay && overlay.operatingPlan,
    operatingPlanNote: overlay && overlay.operatingPlanNote,
  });
}

function leftoverFields(row) {
  return {
    currentBalance: row && row.currentBalance,
    afterBills: row && row.afterBills,
    afterHouseholdBudget: row && row.afterHouseholdBudget,
    afterDebtRepayment: row && row.afterDebtRepayment,
    afterBigPurchases: row && row.afterBigPurchases,
  };
}

function leftoverPacket(amount, extras) {
  extras = extras || {};
  return {
    schema: Assistant.SCHEMA,
    authority: { planner: 'Forecast' },
    metadata: {
      effectiveAsOf: extras.asOf || '2026-09-15',
      freshness: { confidence: extras.freshness || 'canonical-opening' },
    },
    forecast: {
      predictedEndingBalance: extras.unavailable
        ? { status: 'unavailable', reason: 'balance-after-deductions-unavailable' }
        : {
          status: 'ok',
          source: 'Forecast.calendarPeriodWaterfalls',
          identity: 'balance-after-deductions',
          amount,
        },
      paydayAllocation: extras.unavailable
        ? { status: 'unavailable', reason: 'payday-leftover-unavailable' }
        : {
          status: 'ok',
          source: 'Forecast.paydayAllocation',
          runningLeftover: leftoverFields({
            currentBalance: extras.currentBalance,
            afterBills: extras.afterBills,
            afterHouseholdBudget: extras.afterHouseholdBudget,
            afterDebtRepayment: extras.afterDebtRepayment,
            afterBigPurchases: amount,
          }),
        },
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
      debts: {
        facilities: [
          { id: 'high', label: 'High-rate card', available: 400, trust: 'calculated' },
        ],
      },
    },
  };
}

function leftoverTurn(amount) {
  return {
    kind: 'explained',
    question: 'What does this payday leave us with?',
    presented: `Balance after deductions for this pay period is ${TalkPresentation.formatCurrency(amount)}.`,
    referentPaths: [LEFTOVER_PATH],
  };
}

console.log('=== 1. Authority path stays Forecast leftover; no Talk/browser arithmetic ===');
{
  const packetSrc = read('scripts/assistant-packet.js');
  const sessionSrc = read('scripts/talk-session.js');
  const presentationSrc = read('scripts/talk-presentation.js');
  const geminiSrc = TalkGemini.INSTRUCTION;
  const talkSrc = read('public/talk.js');
  const forecastSrc = fs.readFileSync(path.join(ROOT, 'public/forecast.js'), 'utf8');
  ok(/projectPredictedEndingBalance/.test(packetSrc)
      && /predictedEndingBalance/.test(packetSrc)
      && /Forecast\.calendarPeriodWaterfalls/.test(packetSrc),
    'assistant packet projects Forecast Balance After Deductions');
  ok(!/require\(['"][^'"]*forecast/i.test(sessionSrc),
    'talk-session.js does not import Forecast');
  ok(/payday-leftover/.test(sessionSrc)
      && /what does this payday leave us with/.test(sessionSrc)
      && /what does that leave us with/.test(sessionSrc),
    'session leftover deixis extends PATH_RULE / last-presented binding');
  ok(/forecast\.predictedEndingBalance\.amount/.test(presentationSrc)
      && /Balance after deductions for this pay period is/.test(presentationSrc)
      && /Balance after deductions is unavailable/.test(presentationSrc),
    'PATH_RULE reprints Balance After Deductions and fails closed when it is missing');
  ok(/intent":"payday-leftover/.test(geminiSrc)
      && /never a leftover amount/.test(geminiSrc)
      && /Gemini extracts leftover intent or referent only/.test(geminiSrc),
    'Gemini leftover contract is intent/referent only');
  ok(/Do not return leftover, amount, equals, runningLeftover/.test(geminiSrc),
    'Gemini instruction forbids leftover amount fields');
  ok(!/Forecast\.|recommend\(|money2\(|paydayAllocation/.test(talkSrc),
    'talk.js still does not calculate leftover');
  ok(!/resolved-reference|payday-leftover|leave us with/.test(forecastSrc),
    'public/forecast.js is untouched');
}

console.log('\n=== 2. Packet leftover equals independent Forecast leftover ===');
const liveData = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const periods = Assistant.loadPeriods();
const advice = adviceFor(liveData, periods);
const packet = Assistant.buildPacket({
  data: liveData,
  periods,
  now: '2026-09-15T12:00:00.000Z',
  env: {},
});
const forecastLeftover = leftoverFields(advice && advice.paydayAllocation
  && advice.paydayAllocation.runningLeftover);
const packetLeftover = leftoverFields(packet.forecast
  && packet.forecast.paydayAllocation
  && packet.forecast.paydayAllocation.runningLeftover);
const forecastPeb = advice && advice.defaultView
  && advice.defaultView.predictedEndingBalance;
const packetPeb = packet.forecast && packet.forecast.predictedEndingBalance;
{
  ok(advice && advice.paydayAllocation && advice.paydayAllocation.runningLeftover,
    'Forecast.recommend still publishes paydayAllocation.runningLeftover');
  ok(packet.forecast.paydayAllocation
      && packet.forecast.paydayAllocation.status === 'ok'
      && packet.forecast.paydayAllocation.source === 'Forecast.paydayAllocation',
    'packet forecast block still exposes sanitized paydayAllocation leftover');
  ok(Object.keys(forecastLeftover).every(key => near(packetLeftover[key], forecastLeftover[key])),
    'packet runningLeftover equals independent Forecast.paydayAllocation.runningLeftover',
    `${JSON.stringify(packetLeftover)} vs ${JSON.stringify(forecastLeftover)}`);
  if (forecastPeb != null && Number.isFinite(Number(forecastPeb))) {
    ok(packetPeb && packetPeb.status === 'ok'
        && packetPeb.source === 'Forecast.calendarPeriodWaterfalls'
        && near(packetPeb.amount, forecastPeb),
      'packet Balance After Deductions equals the calendar leftover');
  } else {
    ok(packetPeb && packetPeb.status === 'unavailable',
      'packet Balance After Deductions is unavailable when Forecast withholds it');
  }
}

console.log('\n=== 3. Talk-published leftover equals that Forecast leftover ===');
{
  const claims = TalkWhy.publishablePaths([LEFTOVER_PATH], packet);
  const presented = TalkPresentation.presentVerifiedClaims(
    { status: 'explained', claims },
    packet
  );
  const expectedPeb = forecastPeb != null && Number.isFinite(Number(forecastPeb))
    ? forecastPeb
    : null;
  const expectedMoney = expectedPeb != null
    ? TalkPresentation.formatCurrency(expectedPeb) : null;
  if (expectedPeb != null) {
    ok(claims.length === 1
        && near(claims[0].value, expectedPeb)
        && presented.answer === `Balance after deductions for this pay period is ${expectedMoney}.`,
      'Talk leftover sentence reprints independently formatted Forecast Balance After Deductions');
  } else {
    ok(presented.answer === TalkPresentation.UNAVAILABLE_ANSWER
        || /Balance after deductions is unavailable/.test(presented.answer),
      'Talk leftover is unavailable when Forecast Balance After Deductions is withheld');
  }
  if (expectedPeb != null) {
    ok(presented.cards
        && presented.cards.items[0].body === presented.answer
        && presented.summary
        && JSON.stringify(presented.summary).indexOf(expectedMoney) !== -1
        && JSON.stringify(presented.cards).indexOf(expectedMoney) !== -1,
      'cards and decision summary reprint leftover and do not alter the figure');
    // Atlas #923 finding 1: Talk carries Forecast's own qualification of BAD
    // (null = calculated), never a stronger one.
    const activePeriod = ((advice && advice.defaultView && advice.defaultView.calendarPeriods) || [])
      .find(row => row && row.role === 'active');
    const expectedTrust = activePeriod && activePeriod.balanceAfterDeductionsTrust != null
      ? activePeriod.balanceAfterDeductionsTrust : 'calculated';
    ok(presented.source === 'Forecast'
        && presented.trust === expectedTrust
        && (presented.citations || []).some(row => row.source === 'Forecast')
        && (presented.citations || []).some(row => row.href === '/' && row.label === 'Budget'),
      'leftover provenance and Budget citation survive');
    ok(presented.action && presented.action.href === '/',
      'leftover keeps the existing Budget surface action');
  }
}

console.log('\n=== 4. Referent binding: this payday now; that leftover only when earned ===');
{
  const fixture = leftoverPacket(321.5);
  const debts = [{ id: 'high', label: 'High-rate card' }];
  const direct = TalkSession.resolveFollowup({
    question: 'What does this payday leave us with?',
    priorTurn: null,
    debts,
    packet: fixture,
  });
  ok(direct.status === 'resolved-reference'
      && direct.referentKey === 'payday-leftover'
      && direct.paths[0] === LEFTOVER_PATH,
    'this-payday leftover reads the leftover path without a prior turn');

  ok(TalkSession.resolveFollowup({
    question: 'What does that leave us with?',
    priorTurn: null,
    debts,
    packet: fixture,
  }).status === 'ambiguous',
    'that-leave-us-with without a leftover presentation fails closed');

  const leftoverPrior = leftoverTurn(99.99);
  const that = TalkSession.resolveFollowup({
    question: 'What does that leave us with?',
    priorTurn: leftoverPrior,
    debts,
    packet: leftoverPacket(12.34),
  });
  ok(that.status === 'resolved-reference' && that.paths[0] === LEFTOVER_PATH,
    'that-leave-us-with binds leftover after a verified leftover presentation');
  const staleClaims = TalkWhy.publishablePaths(that.paths, leftoverPacket(12.34));
  const stalePresented = TalkPresentation.presentVerifiedClaims({
    status: 'explained',
    claims: staleClaims,
  }, leftoverPacket(12.34));
  ok(near(staleClaims[0].value, 12.34)
      && stalePresented.answer.indexOf('$12.34') !== -1
      && stalePresented.answer.indexOf('99.99') === -1,
    'leftover follow-up re-reads the current packet, not stale leftover prose');

  ok(TalkSession.resolveFollowup({
    question: 'What does that leave us with?',
    priorTurn: {
      kind: 'explained',
      question: 'What is remaining?',
      presented: 'You have $1,415.95 remaining.',
      referentPaths: ['forecast.currentPeriodAction.essentialRemaining'],
    },
    debts,
    packet: fixture,
  }).status === 'ambiguous',
    'pay-period remaining is not leftover; leftover deixis stays unavailable');

  ok(TalkSession.resolveFollowup({
    question: 'What does that leave us with?',
    priorTurn: {
      kind: 'explained',
      question: 'What is available on the high-rate card?',
      presented: 'A credit facility has $400.00 available.',
      referentPaths: ['current.debts.facilities[0].available'],
    },
    debts,
    packet: fixture,
  }).status === 'ambiguous',
    'card presentation does not earn leftover deixis');

  ok(TalkSession.resolveFollowup({
    question: 'What does that leave us with?',
    priorTurn: {
      kind: 'explained',
      question: 'How much leftover?',
      presented: 'This payday leaves us with $99,999.00.',
    },
    debts,
    packet: fixture,
  }).status === 'ambiguous',
    'prose-only leftover history cannot invent leftover');

  const store = TalkSession.createSessionContext({ secret: SECRET });
  const key = store.keyFromToken('cookie-leftover');
  ok(store.append(key, leftoverTurn(321.5)) === true,
    'explained leftover turn stores the leftover path');
  const stored = store.turns(key)[0];
  ok(stored.referentKeys && stored.referentKeys.includes('payday-leftover'),
    'sanitized leftover turn derives the payday-leftover key');
  ok(TalkSession.publicConversation(store.turns(key)).every(row => (
    !row.referentPaths && !row.referentKeys
  )), 'public conversation still exposes leftover wording only');
}

console.log('\n=== 5. Unavailable leftover is not zero; Gemini cannot invent leftover ===');
{
  const missing = TalkPresentation.presentVerifiedClaims({
    status: 'explained',
    claims: [{ path: LEFTOVER_PATH, value: null }],
  }, leftoverPacket(null, { unavailable: false }));
  ok(missing.answer === 'Balance after deductions is unavailable.'
      && missing.trust === 'unavailable'
      && !/\$0/.test(JSON.stringify(missing))
      && !/0\.00/.test(JSON.stringify(missing)),
    'null leftover stays unavailable and is not $0');

  const zero = TalkPresentation.presentVerifiedClaims({
    status: 'explained',
    claims: [{ path: LEFTOVER_PATH, value: 0 }],
  }, leftoverPacket(0));
  ok(zero.answer === 'Balance after deductions for this pay period is $0.00.'
      && zero.trust === 'calculated',
    'a genuine Forecast leftover of $0 stays $0');

  const invented = TalkSession.parseLeftoverExtract({
    intent: TalkSession.LEFTOVER_INTENT,
    leftover: 99999,
  });
  ok(invented.ok === false && invented.reason === 'invented leftover',
    'Gemini leftover extract cannot carry a leftover amount');

  const leftoverIntent = TalkSession.parseLeftoverExtract({
    intent: TalkSession.LEFTOVER_INTENT,
  });
  ok(leftoverIntent.ok === true && leftoverIntent.intent === TalkSession.LEFTOVER_INTENT,
    'leftover extract may name leftover intent only');
  const fromIntent = TalkSession.resolvePaydayLeftover({
    question: 'How much leftover after payday?',
    priorTurn: null,
    extract: leftoverIntent,
  });
  const intentClaims = TalkWhy.publishablePaths(fromIntent.paths, leftoverPacket(77.7));
  const intentPresented = TalkPresentation.presentVerifiedClaims({
    status: 'explained',
    claims: intentClaims,
  }, leftoverPacket(77.7));
  ok(fromIntent.status === 'resolved-reference'
      && near(intentClaims[0].value, 77.7)
      && intentPresented.answer.indexOf('$77.70') !== -1,
    'leftover intent still reads leftover from the packet, not from Gemini');

  ok(TalkSession.resolvePaydayLeftover({
    question: 'What does that leave us with?',
    priorTurn: null,
    extract: {
      ok: true,
      intent: TalkSession.LEFTOVER_INTENT,
      referentKey: 'last-presented',
    },
  }).status === 'ambiguous',
    'Gemini last-presented leftover without an earned leftover ref fails closed');

  const wrongEquals = TalkGemini.materializeExplainerAnswer(JSON.stringify({
    status: 'explained',
    claims: [{ path: LEFTOVER_PATH, equals: 99999 }],
  }), leftoverPacket(forecastPeb != null ? forecastPeb : 12.34));
  ok(wrongEquals.ok === false,
    'Gemini cannot publish a leftover amount that is not the packet leftover');

  const parsedWrong = TalkGemini.parseTalkModelOutput(JSON.stringify({
    intent: TalkSession.LEFTOVER_INTENT,
    leftover: 12,
  }));
  ok(parsedWrong.ok === false && parsedWrong.kind === TalkSession.LEFTOVER_INTENT,
    'leftover extract with an amount is rejected before presentation');
}

console.log('\n=== 6. Session HTTP leftover equals Forecast and does not call Gemini ===');
async function runHttpProof() {
  const expectedPeb = forecastPeb != null && Number.isFinite(Number(forecastPeb))
    ? forecastPeb
    : null;
  const expectedMoney = expectedPeb != null
    ? TalkPresentation.formatCurrency(expectedPeb)
    : null;
  const mock = await startMockGemini([
    JSON.stringify({
      intent: TalkSession.LEFTOVER_INTENT,
      leftover: 99999,
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

    const first = await askJson(base, sessionA.cookie, 'What does this payday leave us with?');
    const firstBody = await first.json();
    ok(first.status === 200
        && (expectedMoney
          ? firstBody.answer === `Balance after deductions for this pay period is ${expectedMoney}.`
          : (firstBody.answer === TalkPresentation.UNAVAILABLE_ANSWER
            || /Balance after deductions is unavailable/.test(firstBody.answer)))
        && mock.captured.length === 0,
      'this-payday leftover reprints Forecast Balance After Deductions and does not call Gemini',
      firstBody && firstBody.answer);
    ok(expectedMoney
        ? (firstBody.cards
          && firstBody.cards.items.some(item => item.body === firstBody.answer)
          && JSON.stringify(firstBody.summary || {}).indexOf(expectedMoney) !== -1
          && (firstBody.citations || []).some(row => row.source === 'Forecast'))
        : (firstBody.answer === TalkPresentation.UNAVAILABLE_ANSWER
          || /Balance after deductions is unavailable/.test(firstBody.answer)),
      'HTTP leftover cards, summary, and citations keep the Forecast leftover');

    const that = await askJson(base, sessionA.cookie, 'What does that leave us with?');
    const thatBody = await that.json();
    ok(that.status === 200
        && thatBody.answer === firstBody.answer
        && mock.captured.length === 0,
      'earned leftover deixis re-reads leftover and still does not call Gemini');

    const isolated = await askJson(base, sessionB.cookie, 'What does that leave us with?');
    const isolatedBody = await isolated.json();
    ok(isolated.status === 200
        && isolatedBody.answer === TalkPresentation.UNAVAILABLE_ANSWER
        && isolatedBody.answer.indexOf(expectedMoney) === -1
        && mock.captured.length === 0,
      'session B cannot bind session A leftover deixis');
  } finally {
    await atlas.stop();
    await mock.close();
  }
  filesUnchanged('Talk payday leftover');
}

runHttpProof().then(() => {
  ok(hashFile(DATA) === liveHash, 'live data.json bytes unchanged at suite end');
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
