'use strict';
/* B87 — one authority for question OPEN / ANSWERED status.
 * `node test/test-question-status.js`
 *
 * docs/01_OPEN_QUESTIONS.md owns status. Household-facing Deep Dive /
 * data.json.questions may explain evidence; they may not independently close
 * a question, including by overloading tier 0 as "answered".
 * docs/positions.csv and BACKLOG.md may record evidence or completed
 * investigation; they may not claim RESOLVED / ANSWERED / CLOSED for a
 * question the canonical file still has OPEN.
 *
 * Q2 and Q20 are the live proving cases. Q2 is ANSWERED 2026-08-29; Q20
 * remains OPEN. The suite must fail if a publication copy independently
 * marks an OPEN question ANSWERED, or presents a canonical-ANSWERED
 * question as still OPEN. Extra-surface proving case: a positions.csv /
 * BACKLOG Q20 close while Q20 is OPEN.
 */
const fs = require('fs');
const path = require('path');
const { sourceText } = require('./test-source-text');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const read = rel => sourceText(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
const clone = x => JSON.parse(JSON.stringify(x));

const CANONICAL_STATUSES = ['OPEN', 'ASKED', 'ANSWERED', 'BLOCKED'];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseCanonicalQuestions(markdown) {
  markdown = sourceText(markdown);
  const questions = [];
  const seen = new Set();
  const headingRe = /^###\s+(Q\d+[a-zA-Z]?)\.\s+(.+?)\s*$/gm;
  let match;
  while ((match = headingRe.exec(markdown))) {
    const id = match[1].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const title = match[2].replace(/\s*[—–-]\s*ANSWERED\b.*$/i, '').trim();
    const rest = markdown.slice(match.index + match[0].length);
    const nextHeading = rest.search(/\n###\s+/);
    const body = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
    const statusLine = /\*\*Status:\*\*\s*([^\n]+)/.exec(body);
    let status = null;
    if (statusLine) {
      const raw = statusLine[1].trim();
      // PARTIALLY ANSWERED is not ANSWERED. Take the first canonical token.
      if (!/^PARTIALLY\b/i.test(raw)) {
        const tok = new RegExp(`^(${CANONICAL_STATUSES.join('|')})\\b`, 'i').exec(raw);
        status = tok ? tok[1].toUpperCase() : null;
      }
    } else if (/\bANSWERED\b/i.test(match[2])) {
      status = 'ANSWERED';
    }
    questions.push({ id, title, status, body });
  }
  return questions;
}

const CLOSED_STATUSES = new Set(['RESOLVED', 'ANSWERED', 'CLOSED']);

function distinctiveAmount(canonical) {
  const know = /\*\*What we know:\*\*\s*([^\n]+)/.exec(canonical.body || '');
  if (!know) return null;
  const m = /\$([0-9]{1,3}(?:,[0-9]{3})+)/.exec(know[1]);
  return m ? m[1].replace(/,/g, '') : null;
}

function matchesSurface(unit, canonical) {
  if (matchesCanonical({ q: unit, title: unit, detail: unit, changes: unit }, canonical)) {
    return true;
  }
  const n = normalize(unit);
  if (n.split(/\s+/).includes(canonical.id.toLowerCase())) return true;
  const amount = distinctiveAmount(canonical);
  if (amount && amount.length >= 5 && String(unit).replace(/,/g, '').includes(amount)) {
    return true;
  }
  return false;
}

function explicitStatusBindings(unit) {
  const map = new Map();
  const spans = [];
  const groupRe = /\b(Q\d+[a-zA-Z]?(?:\s*\/\s*Q\d+[a-zA-Z]?)*)\b(?:\s+(?:stayed|remains|still|stays|stay|is|are|was|were)(?:\s+later)?)*\s+(OPEN|ASKED|ANSWERED|BLOCKED|CLOSED|RESOLVED)\b/gi;
  let match;
  while ((match = groupRe.exec(unit))) {
    const ids = match[1].match(/Q\d+[a-zA-Z]?/gi) || [];
    const status = match[2].toUpperCase();
    for (const id of ids) map.set(id.toUpperCase(), status);
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { map, spans };
}

function closedStatusClaims(unit) {
  const out = [];
  const re = /\b(RESOLVED|ANSWERED|CLOSED)\b/gi;
  let match;
  while ((match = re.exec(unit))) {
    const token = match[1].toUpperCase();
    const start = match.index;
    if (token === 'CLOSED') {
      const prev = start > 0 ? unit[start - 1] : '';
      if (prev === '/' || prev === '-') continue;
    }
    const before = unit.slice(Math.max(0, start - 56), start);
    const negated = /\b(not|never|without)\b[\s\S]*$/i.test(before);
    const prefix = unit.slice(0, start);
    const inTicks = (prefix.split('`').length % 2) === 0;
    out.push({ token, index: start, negated, inTicks });
  }
  return out;
}

function extraSurfaceDefects(canonical, extraSurfaces) {
  const defects = [];
  for (const surface of extraSurfaces || []) {
    const rel = surface.path || 'unknown';
    const units = String(surface.text || '').split('\n');
    units.forEach((unit, idx) => {
      if (!unit.trim()) return;
      const { map: bindings, spans } = explicitStatusBindings(unit);
      const claims = closedStatusClaims(unit).filter(c => {
        if (c.negated || c.inTicks) return false;
        return !spans.some(s => c.index >= s.start && c.index < s.end);
      });
      for (const q of canonical) {
        if (q.status !== 'OPEN' && q.status !== 'ASKED' && q.status !== 'BLOCKED') continue;
        const bound = bindings.get(q.id);
        if (bound) {
          if (CLOSED_STATUSES.has(bound)) {
            defects.push({
              code: 'open-marked-answered',
              message: `canonical ${q.id} is ${q.status}, but ${rel}:${idx + 1} marks it ${bound}`,
              id: q.id,
              path: rel,
            });
          }
          continue;
        }
        if (!claims.length) continue;
        if (!matchesSurface(unit, q)) continue;
        defects.push({
          code: 'open-marked-answered',
          message: `canonical ${q.id} is ${q.status}, but ${rel}:${idx + 1} marks it ${claims[0].token}`,
          id: q.id,
          path: rel,
        });
      }
    });
  }
  return defects;
}

function encodesAnswered(question) {
  if (!question || typeof question !== 'object') return false;
  if (question.tier === 0 || question.tier === '0') return true;
  const title = String(question.q || question.title || '').trim();
  if (/^(ANSWERED|CLOSED|RESOLVED)\b/i.test(title)) return true;
  const owner = String(question.owner || '').trim();
  if (/^(Closed|Answered|Resolved)\b/i.test(owner)) return true;
  if (question.status && /^(ANSWERED|CLOSED|RESOLVED)\b/i.test(String(question.status).trim())) {
    return true;
  }
  return false;
}

function haystack(question) {
  return normalize([
    question.id, question.q, question.title, question.detail, question.changes, question.owner,
  ].filter(Boolean).join(' '));
}

function matchesCanonical(published, canonical) {
  const publishedId = String(published.id || '').toUpperCase();
  if (publishedId && publishedId === canonical.id) return true;
  const hay = haystack(published);
  if (hay.split(' ').includes(canonical.id.toLowerCase())) return true;
  const quotes = [...String(canonical.title).matchAll(/"([^"]+)"/g)]
    .map(m => normalize(m[1]))
    .filter(Boolean);
  if (quotes.some(phrase => hay.includes(phrase))) return true;
  const canonicalTitle = normalize(canonical.title);
  const publishedTitle = normalize(String(published.q || published.title || '')
    .replace(/^(answered|closed|resolved)\b[\s—–:-]*/i, ''));
  if (publishedTitle && (canonicalTitle === publishedTitle
    || canonicalTitle.includes(publishedTitle)
    || publishedTitle.includes(canonicalTitle))) {
    return true;
  }
  const stop = new Set(['where', 'does', 'the', 'did', 'why', 'what', 'after', 'from', 'with', 'that', 'this', 'into', 'were', 'was']);
  const words = canonicalTitle.split(' ').filter(w => w.length >= 4 && !stop.has(w));
  for (let i = 0; i < words.length - 1; i++) {
    if (hay.includes(`${words[i]} ${words[i + 1]}`)) return true;
  }
  return false;
}

function questionsRenderer(source) {
  const start = source.indexOf("$('questions')");
  if (start < 0) return '';
  const fromMap = source.indexOf('.map(', start);
  if (fromMap < 0) return source.slice(start, start + 400);
  const end = source.indexOf('.join(', fromMap);
  return source.slice(start, end > fromMap ? end : start + 400);
}

function rendererIndependentlyMarksAnswered(source) {
  if (source === null) return false; // no page renders questions any more (#822)
  const block = questionsRenderer(source);
  if (!block) return true;
  if (/\bdone\b/.test(block)) return true;
  if (/tier\s*===?\s*0/.test(block)) return true;
  if (/\.status\b/.test(block) && /ANSWERED/i.test(block)) return true;
  return false;
}

function findQuestionStatusDefects({ markdown, publishedQuestions, rendererSource, extraSurfaces }) {
  const defects = [];
  const canonical = parseCanonicalQuestions(markdown);
  const byId = new Map(canonical.map(q => [q.id, q]));

  if (rendererIndependentlyMarksAnswered(rendererSource)) {
    defects.push({
      code: 'renderer-status-bit',
      message: 'Deep Dive questions renderer independently marks a question answered',
    });
  }

  for (const published of publishedQuestions || []) {
    const matched = canonical.filter(q => matchesCanonical(published, q));
    const answeredClaim = encodesAnswered(published);

    if (answeredClaim) {
      const closedMatch = matched.find(q => q.status === 'ANSWERED');
      if (!closedMatch) {
        const ids = matched.map(q => q.id).join(', ') || 'none';
        defects.push({
          code: 'independent-answered',
          message: `household-facing record independently claims ANSWERED (matched canonical: ${ids})`,
          published,
        });
      }
    }

    for (const hit of matched) {
      if (hit.status !== 'ANSWERED' && answeredClaim) {
        defects.push({
          code: 'open-marked-answered',
          message: `canonical ${hit.id} is ${hit.status || 'unparsed'}, but publication marks it ANSWERED`,
          id: hit.id,
        });
      }
      if (hit.status === 'ANSWERED' && !answeredClaim) {
        defects.push({
          code: 'answered-marked-open',
          message: `canonical ${hit.id} is ANSWERED, but publication still presents it as an open question`,
          id: hit.id,
        });
      }
    }
  }

  defects.push(...extraSurfaceDefects(canonical, extraSurfaces));

  return { canonical, byId, defects };
}

function assertQuestionStatusAuthority(input) {
  const result = findQuestionStatusDefects({ extraSurfaces, ...input });
  if (result.defects.length) {
    const err = new Error(result.defects.map(d => d.message).join('\n'));
    err.defects = result.defects;
    throw err;
  }
  return result;
}

const markdown = read('docs/01_OPEN_QUESTIONS.md');
// The Deep Dive page that rendered data.json.questions was removed under #822,
// so there is no page renderer left to mark a question answered on its own.
const rendererSource = null;
const published = data.questions;
const extraSurfaces = [
  { path: 'docs/positions.csv', text: read('docs/positions.csv') },
  { path: 'BACKLOG.md', text: read('BACKLOG.md') },
];
const live = findQuestionStatusDefects({
  markdown, publishedQuestions: published, rendererSource, extraSurfaces,
});

console.log('=== canonical authority parses ===');
{
  const q2 = live.byId.get('Q2');
  const q5 = live.byId.get('Q5');
  const q9 = live.byId.get('Q9');
  const q20 = live.byId.get('Q20');
  ok(live.canonical.length >= 10, 'canonical file yields household questions',
    String(live.canonical.length));
  ok(q2 && q2.status === 'ANSWERED', 'canonical Q2 is ANSWERED 2026-08-29',
    q2 ? `${q2.status} — ${q2.title}` : 'missing');
  ok(q20 && q20.status === 'OPEN', 'canonical Q20 is OPEN (emergency reserve remains unresolved)',
    q20 ? `${q20.status} — ${q20.title}` : 'missing');
  ok(q5 && q5.status === 'ANSWERED', 'canonical Q5 is ANSWERED (garage/lab income ended)',
    q5 ? q5.status : 'missing');
  ok(q9 && q9.status === 'ANSWERED', 'canonical Q9 is ANSWERED (reverse-direction fixture exists in live file)',
    q9 ? q9.status : 'missing');
  ok(live.canonical.every(q => !q.status || CANONICAL_STATUSES.includes(q.status)
    || q.status === null),
    'parsed statuses stay inside OPEN / ASKED / ANSWERED / BLOCKED');
}

console.log('\n=== live publication cannot contradict canonical status ===');
{
  ok(live.defects.length === 0,
    'live Deep Dive / data.json.questions / positions.csv / BACKLOG.md do not contradict 01_OPEN_QUESTIONS.md',
    live.defects.map(d => d.message).join('; ') || 'clean');
  ok(!published.some(q => q.tier === 0 || q.tier === '0'),
    'no published question uses tier 0 as an answered bit');
  ok(!published.some(q => Object.prototype.hasOwnProperty.call(q, 'status')),
    'published questions do not carry a second status field');
  ok(!fs.existsSync(path.join(__dirname, '..', 'public/deepdive.js')),
    'the Deep Dive questions renderer is removed, so no page can mark a question answered');
  const q2pub = published.filter(q => matchesCanonical(q, live.byId.get('Q2')));
  const q5pub = published.filter(q => matchesCanonical(q, live.byId.get('Q5')));
  const q20pub = published.filter(q => matchesCanonical(q, live.byId.get('Q20')));
  ok(q2pub.length === 0 || q2pub.every(q => encodesAnswered(q)),
    'canonical-ANSWERED Q2 is not independently presented as OPEN',
    q2pub.map(q => q.q).join(' | ') || 'absent');
  ok(q5pub.length === 0 || q5pub.every(q => encodesAnswered(q)),
    'canonical-ANSWERED Q5 is not independently presented as OPEN',
    q5pub.map(q => q.q).join(' | ') || 'absent');
  ok(q20pub.every(q => !encodesAnswered(q)),
    'household-facing Q20 is not marked ANSWERED',
    q20pub.map(q => q.q).join(' | ') || 'absent');
  const q9pub = published.filter(q => matchesCanonical(q, live.byId.get('Q9')));
  ok(q9pub.length === 0 || q9pub.every(q => encodesAnswered(q)),
    'canonical-ANSWERED Q9 is not independently presented as OPEN');
  const extraDefects = extraSurfaceDefects(live.canonical, extraSurfaces);
  ok(extraDefects.length === 0,
    'live positions.csv and BACKLOG.md do not close a canonical-OPEN question',
    extraDefects.map(d => d.message).join('; ') || 'clean');
}

console.log('\n=== mutation recreates the old defect ===');
{
  const oldQ2Open = {
    id: 'Q2',
    tier: 1,
    q: 'Where do the "TFR-TO C/C" transfers go?',
    detail: 'Independently presented as still open.',
    changes: 'Must fail while Q2 is ANSWERED.',
    owner: 'Dale',
  };
  const oldQ20 = {
    tier: 0,
    q: 'ANSWERED — emergency reserve target is $10,000',
    detail: 'Invented close of Q20.',
    changes: 'Must fail while Q20 is OPEN.',
    owner: 'Closed 16 Aug 2026',
  };
  const q2OpenMutant = clone(published).map(q => (q.id === 'Q2' ? oldQ2Open : q));
  const q20Mutant = clone(published).concat(oldQ20);
  let q2Err = null;
  let q20Err = null;
  try {
    assertQuestionStatusAuthority({ markdown, publishedQuestions: q2OpenMutant, rendererSource });
  } catch (err) { q2Err = err; }
  try {
    assertQuestionStatusAuthority({ markdown, publishedQuestions: q20Mutant, rendererSource });
  } catch (err) { q20Err = err; }
  ok(!!q2Err && /Q2/i.test(q2Err.message),
    'presenting canonical-ANSWERED Q2 as an open Deep Dive card fails',
    q2Err ? q2Err.message.split('\n')[0] : 'suite stayed green');
  ok(!!q20Err && /Q20/i.test(q20Err.message),
    'mutating publication to mark canonical-OPEN Q20 ANSWERED fails',
    q20Err ? q20Err.message.split('\n')[0] : 'suite stayed green');

  const idMutant = clone(published);
  const q2card = idMutant.find(q => q.id === 'Q2');
  ok(!!q2card, 'live publication still carries a Q2 pointer for the identity mutation');
  if (q2card) {
    q2card.q = 'Where do the "TFR-TO C/C" transfers go?';
    q2card.owner = 'Dale';
  }
  let idErr = null;
  try {
    assertQuestionStatusAuthority({ markdown, publishedQuestions: idMutant, rendererSource });
  } catch (err) { idErr = err; }
  ok(!!idErr && /Q2/i.test(idErr.message),
    'stripping ANSWERED encoding from the live Q2 card fails while Q2 is ANSWERED',
    idErr ? idErr.message.split('\n')[0] : 'suite stayed green');
}

console.log('\n=== reverse: canonical ANSWERED cannot stay independently OPEN ===');
{
  const fixtureMd = [
    markdown,
    '',
    '### Q99. Proving fixture for answered publication',
    '**Status:** ANSWERED · **Owner:** test',
    '**What we know:** Fixture only.',
  ].join('\n');
  const openPresentation = clone(published).concat({
    id: 'Q99',
    tier: 1,
    q: 'Proving fixture for answered publication',
    detail: 'This card has no answered encoding.',
    changes: 'Should fail.',
    owner: 'test',
  });
  let reverseErr = null;
  try {
    assertQuestionStatusAuthority({
      markdown: fixtureMd,
      publishedQuestions: openPresentation,
      rendererSource,
    });
  } catch (err) { reverseErr = err; }
  ok(!!reverseErr && /Q99/i.test(reverseErr.message) && /ANSWERED/i.test(reverseErr.message),
    'canonical-ANSWERED fixture presented as an open Deep Dive card fails',
    reverseErr ? reverseErr.message.split('\n')[0] : 'suite stayed green');

  const closedPresentation = clone(published).concat({
    id: 'Q99',
    tier: 1,
    q: 'ANSWERED — Proving fixture for answered publication',
    detail: 'Derived from the canonical file for this fixture.',
    changes: 'None.',
    owner: 'Answered in canonical file',
  });
  let closedErr = null;
  try {
    assertQuestionStatusAuthority({
      markdown: fixtureMd,
      publishedQuestions: closedPresentation,
      rendererSource,
    });
  } catch (err) { closedErr = err; }
  ok(!closedErr,
    'the same fixture may be shown as ANSWERED when the canonical file is ANSWERED',
    closedErr ? closedErr.message : 'aligned');
}

console.log('\n=== extra-surface mutation recreates the Q20 close ===');
{
  const OLD_POSITIONS_Q20_ROW = 'RESOLVED,,emergency reserve target,,Outflow,CAD,0.00,,,,,,Answered,,,,,,VERIFIED,2026-08-16,RESOLVED - Q20 emergency reserve is ANSWERED';
  const OLD_B20 = '- **B20** Q20 emergency reserve is ANSWERED';
  const SYNTHETIC_Q20_CLOSE = 'RESOLVED — Q20. The emergency reserve target is ANSWERED.';

  const withOldPositions = extraSurfaces.map(s => s.path === 'docs/positions.csv'
    ? { ...s, text: `${s.text.replace(/\n$/, '')}\n${OLD_POSITIONS_Q20_ROW}\n` }
    : s);
  const withOldB20 = extraSurfaces.map(s => s.path === 'BACKLOG.md'
    ? { ...s, text: `${s.text.replace(/\n$/, '')}\n${OLD_B20}\n` }
    : s);
  const withSynthetic = extraSurfaces.map(s => s.path === 'BACKLOG.md'
    ? { ...s, text: `${s.text.replace(/\n$/, '')}\n${SYNTHETIC_Q20_CLOSE}\n` }
    : s);

  let positionsErr = null;
  let b20Err = null;
  let syntheticErr = null;
  try {
    assertQuestionStatusAuthority({
      markdown, publishedQuestions: published, rendererSource, extraSurfaces: withOldPositions,
    });
  } catch (err) { positionsErr = err; }
  try {
    assertQuestionStatusAuthority({
      markdown, publishedQuestions: published, rendererSource, extraSurfaces: withOldB20,
    });
  } catch (err) { b20Err = err; }
  try {
    assertQuestionStatusAuthority({
      markdown, publishedQuestions: published, rendererSource, extraSurfaces: withSynthetic,
    });
  } catch (err) { syntheticErr = err; }

  ok(!!positionsErr && /Q20/i.test(positionsErr.message) && /positions\.csv/i.test(positionsErr.message),
    'reintroducing a RESOLVED Q20 positions.csv row fails while Q20 is OPEN',
    positionsErr ? positionsErr.message.split('\n')[0] : 'suite stayed green');
  ok(!!b20Err && /Q20/i.test(b20Err.message) && /BACKLOG/i.test(b20Err.message),
    'reintroducing a BACKLOG claim that Q20 is ANSWERED fails while Q20 is OPEN',
    b20Err ? b20Err.message.split('\n')[0] : 'suite stayed green');
  ok(!!syntheticErr && /Q20/i.test(syntheticErr.message) && /ANSWERED|RESOLVED/i.test(syntheticErr.message),
    'a synthetic RESOLVED/ANSWERED Q20 claim outside the authority fails',
    syntheticErr ? syntheticErr.message.split('\n')[0] : 'suite stayed green');
}

console.log('\n=== live authority holds after mutations of copies ===');
{
  let liveErr = null;
  try {
    assertQuestionStatusAuthority({ markdown, publishedQuestions: published, rendererSource });
  } catch (err) { liveErr = err; }
  ok(!liveErr, 'unmutated live inputs still pass', liveErr ? liveErr.message : '');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
