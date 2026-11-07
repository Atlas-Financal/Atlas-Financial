'use strict';
/* Talk to Atlas — household conversation shell plus session Gemini explainer.
 *
 * This file fetches GET /talk/context and GET /talk/capability with the
 * same-origin session cookie, and POSTs { question } only to /talk/ask
 * when the model path is available. It asks for text/event-stream so
 * the server can emit allowlisted progress phases, then the same
 * verified JSON body. It never renders a stream event as household
 * copy unless the phase is locally allowlisted or the final payload
 * has the incumbent answer shape. It does not send prior turns; the
 * server holds ephemeral session context. It does not call
 * /assistant/current or /assistant/mcp, does not send a Bearer or OAuth
 * token, does not hold the Talk model secret, does not read Forecast,
 * and does not publish a figure of its own. Model answer text is
 * assigned via textContent.
 * Provenance, trust, citations, and one optional action link come from
 * the server presentation. Structured answer cards reprint server.cards
 * strings into #talk-cards. A trusted presentation.summary reprints
 * server-assembled decision-summary sections into #talk-summary.
 * Missing or malformed summary fails closed to cards. Missing or
 * malformed cards fail closed to the plain answer bubble. This file
 * does not invent card content, citations, summary wording, or money,
 * and only follows existing Atlas routes.
 *
 * Send stays disabled until capability says the model path is available.
 * When it is not, suggested prompts keep the Slice 1/2 stub.
 */

const TALK_STUB_COPY = 'Talk is not connected yet. It will not invent an answer.';
const TALK_LOADING_COPY = 'Atlas is reading the current picture…';
const TALK_STREAM_PHASES = {
  understanding: 'Understanding your question…',
  'checking-atlas-context': 'Checking the current Atlas picture…',
  'running-forecast': 'Running Forecast…',
  'preparing-verified-answer': 'Preparing a verified answer…',
};
const TALK_ERROR_COPY = 'Atlas could not answer just now. Try again, or see Budget, Bills, Credit or Planning.';
const TALK_CONTEXT_PATH = '/talk/context';
const TALK_CAPABILITY_PATH = '/talk/capability';
const TALK_ASK_PATH = '/talk/ask';
const TALK_PACKET_SCHEMA = 'atlas-assistant-packet/v1';
const TALK_QUESTION_MAX = 2000;
const TALK_SEAM_UNAVAILABLE = 'Coming soon — Talk is a place to ask. It is not a second planner and does not answer yet.';
const TALK_SEAM_AVAILABLE = 'Atlas explains the current Atlas picture. It is not a second planner.';
const TALK_SUB_UNAVAILABLE = 'Ask Atlas about this payday, bills, credit or planning. Atlas does not invent numbers. Context can connect; answers are not connected yet.';
const TALK_SUB_AVAILABLE = 'Ask Atlas about this payday, bills, credit or planning. Atlas explains the current picture. It does not invent numbers.';
const TALK_EMPTY_UNAVAILABLE = 'The live picture stays on Budget, Bills, Credit and Planning. Talk will not invent an answer. Pick a starting question — Send is not connected yet.';
const TALK_EMPTY_AVAILABLE = 'The live picture stays on Budget, Bills, Credit and Planning. Ask a question and Atlas will explain the current picture. It will not invent an answer.';
const TALK_ACTION_HREFS = {
  '/': 'View Budget',
  '/bills.html': 'View Bills',
  '/credit.html': 'View Credit',
  '/planning.html': 'View Planning',
};
const TALK_CITATION_SURFACES = {
  '/': 'Budget',
  '/bills.html': 'Bills',
  '/credit.html': 'Credit',
  '/planning.html': 'Planning',
};
const TALK_CITATION_SOURCES = {
  Forecast: true,
  Bills: true,
  Credit: true,
  Planning: true,
};

let talkModelAvailable = false;
let talkAskInFlight = false;
let talkAskAbort = null;

function talkEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function talkThread() {
  return $('talk-thread');
}

function hideTalkEmpty() {
  const empty = $('talk-empty');
  if (empty) empty.hidden = true;
}

function appendTalkBubble(role, className, text) {
  const thread = talkThread();
  if (!thread) return null;
  const article = document.createElement('article');
  article.className = 'talk-bubble ' + className;
  article.setAttribute('data-talk-role', role);
  const p = document.createElement('p');
  p.textContent = text;
  article.appendChild(p);
  thread.appendChild(article);
  return article;
}

function talkStubHtml() {
  return `<article class="talk-bubble talk-bubble-atlas" data-talk-role="atlas-stub">
      <p>${TALK_STUB_COPY}</p>
      <p class="talk-card-links">See <a href="/">Budget</a>, <a href="/bills.html">Bills</a>, <a href="/credit.html">Credit</a> or <a href="/planning.html">Planning</a>.</p>
    </article>`;
}

function talkUserHtml(text) {
  return `<article class="talk-bubble talk-bubble-household" data-talk-role="household">
      <p>${talkEscape(text)}</p>
    </article>`;
}

function showTalkPreview(text) {
  const thread = talkThread();
  if (!thread || !text) return;
  hideTalkEmpty();
  thread.insertAdjacentHTML('beforeend', talkUserHtml(text) + talkStubHtml());
}

function setTalkSendEnabled(enabled) {
  const send = $('talk-send');
  if (!send) return;
  send.disabled = !enabled;
  send.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

function renderTalkModelAvailability(available) {
  talkModelAvailable = available === true;
  setTalkSendEnabled(talkModelAvailable && !talkAskInFlight);
  const seam = $('talk-seam');
  if (seam) seam.textContent = talkModelAvailable ? TALK_SEAM_AVAILABLE : TALK_SEAM_UNAVAILABLE;
  const root = typeof document !== 'undefined' ? document : null;
  const sub = root && root.querySelector('#talk .sub');
  if (sub) sub.textContent = talkModelAvailable ? TALK_SUB_AVAILABLE : TALK_SUB_UNAVAILABLE;
  const emptyCopy = root && root.querySelector('.talk-empty-copy');
  if (emptyCopy) emptyCopy.textContent = talkModelAvailable ? TALK_EMPTY_AVAILABLE : TALK_EMPTY_UNAVAILABLE;
}

function talkContextStatus(packet) {
  if (!packet || packet.schema !== TALK_PACKET_SCHEMA || !packet.metadata) {
    return { state: 'unavailable', text: 'Atlas context unavailable' };
  }
  const asOf = packet.metadata.effectiveAsOf || packet.metadata.canonicalAsOf || null;
  const freshness = packet.metadata.freshness || {};
  const trust = freshness.confidence || null;
  const parts = ['Atlas context connected'];
  if (asOf) parts.push('as of ' + asOf);
  if (trust) parts.push(trust);
  return { state: 'available', text: parts.join(' · ') };
}

function renderTalkContext(status) {
  const el = $('talk-context');
  if (!el || !status) return;
  el.textContent = status.text;
  el.dataset.talkContext = status.state;
}

async function loadTalkContext() {
  const el = $('talk-context');
  if (!el) return;
  try {
    const res = await fetch(TALK_CONTEXT_PATH, { credentials: 'same-origin' });
    if (!res.ok) {
      renderTalkContext({ state: 'unavailable', text: 'Atlas context unavailable' });
      return;
    }
    const packet = await res.json();
    renderTalkContext(talkContextStatus(packet));
  } catch {
    renderTalkContext({ state: 'unavailable', text: 'Atlas context unavailable' });
  }
}

async function loadTalkCapability() {
  try {
    const res = await fetch(TALK_CAPABILITY_PATH, { credentials: 'same-origin' });
    if (!res.ok) {
      renderTalkModelAvailability(false);
      return;
    }
    const body = await res.json();
    renderTalkModelAvailability(body && body.available === true);
  } catch {
    renderTalkModelAvailability(false);
  }
}

function normalizeComposerQuestion(raw) {
  const question = String(raw || '').trim();
  if (!question) return '';
  if (question.length > TALK_QUESTION_MAX) return question.slice(0, TALK_QUESTION_MAX);
  return question;
}

function replaceTalkLoading(node) {
  const loading = document.querySelector('[data-talk-role="atlas-loading"]');
  if (loading && loading.parentNode) loading.parentNode.removeChild(loading);
  if (node) {
    const thread = talkThread();
    if (thread) thread.appendChild(node);
  }
}

function talkStreamStatusText(phase) {
  if (typeof phase !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(TALK_STREAM_PHASES, phase)
    ? TALK_STREAM_PHASES[phase]
    : null;
}

function updateTalkLoading(text) {
  if (typeof text !== 'string' || !text) return;
  const loading = document.querySelector('[data-talk-role="atlas-loading"]');
  if (!loading) return;
  const p = loading.querySelector ? loading.querySelector('p') : null;
  if (p) p.textContent = text;
}

function parseTalkSse(buffer) {
  const events = [];
  let rest = String(buffer || '');
  for (;;) {
    const split = rest.indexOf('\n\n');
    if (split < 0) break;
    const raw = rest.slice(0, split);
    rest = rest.slice(split + 2);
    let event = 'message';
    const dataLines = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line || line.charAt(0) === ':') continue;
      if (line.indexOf('event:') === 0) {
        event = line.slice(6).trim();
      } else if (line.indexOf('data:') === 0) {
        const payload = line.slice(5);
        dataLines.push(payload.charAt(0) === ' ' ? payload.slice(1) : payload);
      }
    }
    if (!dataLines.length) continue;
    events.push({ event, data: dataLines.join('\n') });
  }
  return { events, rest };
}

function interpretTalkStreamEvent(raw) {
  if (!raw || (raw.event !== 'status' && raw.event !== 'result' && raw.event !== 'error')) {
    return { type: 'ignore' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.data);
  } catch {
    return { type: 'ignore' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { type: 'ignore' };
  }
  if (raw.event === 'status') {
    const text = talkStreamStatusText(parsed.phase);
    if (!text) return { type: 'ignore' };
    return { type: 'status', phase: parsed.phase, text };
  }
  if (raw.event === 'error') {
    if (typeof parsed.error !== 'string' || !parsed.error) return { type: 'ignore' };
    return { type: 'error', error: parsed.error };
  }
  if (typeof parsed.answer !== 'string' || !parsed.answer.trim()) {
    return { type: 'ignore' };
  }
  return {
    type: 'result',
    payload: {
      answer: parsed.answer,
      source: parsed.source || null,
      trust: parsed.trust || null,
      asOf: parsed.asOf || null,
      freshness: parsed.freshness || null,
      action: parsed.action || null,
      cards: parsed.cards || null,
      citations: parsed.citations || null,
      summary: parsed.summary || null,
    },
  };
}

function applyTalkStreamEvents(events, onStatus) {
  let result = null;
  let error = null;
  if (!Array.isArray(events)) return { result, error };
  for (let i = 0; i < events.length; i += 1) {
    const item = interpretTalkStreamEvent(events[i]);
    if (item.type === 'status') {
      if (typeof onStatus === 'function') onStatus(item.text);
    } else if (item.type === 'error' && !result) {
      error = item.error;
    } else if (item.type === 'result') {
      result = item.payload;
      error = null;
    }
  }
  return { result, error };
}

async function readTalkAskStream(res, onStatus, signal) {
  if (!res || !res.body || typeof res.body.getReader !== 'function') {
    throw new Error('error');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  let streamError = null;
  try {
    while (true) {
      if (signal && signal.aborted) {
        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      const parsed = parseTalkSse(buffer);
      buffer = parsed.rest;
      const applied = applyTalkStreamEvents(parsed.events, onStatus);
      if (applied.result) {
        result = applied.result;
        streamError = null;
        break;
      }
      if (applied.error) {
        streamError = applied.error;
        break;
      }
    }
  } finally {
    try { reader.cancel(); } catch (e) { /* already closed */ }
  }
  if (streamError) {
    throw new Error(streamError === 'talk unavailable' ? 'unavailable' : 'error');
  }
  if (!result) throw new Error('error');
  return result;
}

function talkPresentation(value) {
  if (typeof value === 'string') {
    return { answer: value, source: null, trust: null, asOf: null, freshness: null, action: null, cards: null, citations: null, summary: null };
  }
  if (!value || typeof value !== 'object' || typeof value.answer !== 'string') {
    return { answer: '', source: null, trust: null, asOf: null, freshness: null, action: null, cards: null, citations: null, summary: null };
  }
  return {
    answer: value.answer,
    source: value.source || null,
    trust: value.trust || null,
    asOf: value.asOf || null,
    freshness: value.freshness || null,
    action: value.action || null,
    cards: value.cards || null,
    citations: value.citations || null,
    summary: value.summary || null,
  };
}

const TALK_CARD_KINDS = {
  answer: true,
  option: true,
  result: true,
  judgment: true,
  provenance: true,
  action: true,
  note: true,
};

function talkValidCards(cards) {
  if (!cards || typeof cards !== 'object' || cards.version !== 1) return null;
  if (!Array.isArray(cards.items) || !cards.items.length) return null;
  const items = [];
  for (let i = 0; i < cards.items.length; i += 1) {
    const raw = cards.items[i];
    if (!raw || typeof raw !== 'object') return null;
    if (!TALK_CARD_KINDS[raw.kind]) return null;
    if (typeof raw.title !== 'string' || !raw.title) return null;
    if (typeof raw.body !== 'string' || !raw.body) return null;
    if (raw.kind === 'action') {
      const action = talkAllowedAction({ href: raw.href, label: raw.label || raw.body });
      if (!action) return null;
      items.push({
        kind: 'action',
        title: raw.title,
        body: action.label,
        href: action.href,
        label: action.label,
      });
    } else {
      items.push({
        kind: raw.kind,
        title: raw.title,
        body: raw.body,
      });
    }
  }
  return items.length ? items : null;
}

function talkCardsMount() {
  const reserved = $('talk-cards');
  if (reserved) {
    const insideAnswer = typeof reserved.closest === 'function'
      && reserved.closest('[data-talk-role="atlas-answer"]');
    if (!insideAnswer) {
      reserved.hidden = false;
      if (typeof reserved.removeAttribute === 'function') reserved.removeAttribute('hidden');
      while (reserved.firstChild) reserved.removeChild(reserved.firstChild);
      return reserved;
    }
  }
  const mount = document.createElement('div');
  mount.className = 'talk-cards';
  return mount;
}

const TALK_SUMMARY_ORDER = ['knows', 'changes', 'unchanged', 'risk', 'unknown'];
const TALK_SUMMARY_TITLES = {
  knows: 'What Atlas knows',
  changes: 'What changes',
  unchanged: 'What does not change',
  risk: 'Risk / uncertainty',
  unknown: 'What Atlas cannot determine yet',
};

function talkValidSummary(summary) {
  if (!summary || typeof summary !== 'object' || summary.version !== 1) return null;
  if (!Array.isArray(summary.sections) || summary.sections.length !== TALK_SUMMARY_ORDER.length) {
    return null;
  }
  const sections = [];
  for (let i = 0; i < TALK_SUMMARY_ORDER.length; i += 1) {
    const raw = summary.sections[i];
    const key = TALK_SUMMARY_ORDER[i];
    const title = TALK_SUMMARY_TITLES[key];
    if (!raw || typeof raw !== 'object') return null;
    if (raw.key !== key || raw.title !== title) return null;
    if (!Array.isArray(raw.items) || !raw.items.length) return null;
    const items = [];
    for (let j = 0; j < raw.items.length; j += 1) {
      const item = raw.items[j];
      if (!item || typeof item !== 'object') return null;
      if (typeof item.body !== 'string' || !item.body) return null;
      items.push({ body: item.body });
    }
    sections.push({ key: key, title: title, items: items });
  }
  return sections;
}

function talkSummaryMount() {
  const reserved = $('talk-summary');
  if (reserved) {
    const insideAnswer = typeof reserved.closest === 'function'
      && reserved.closest('[data-talk-role="atlas-answer"]');
    if (!insideAnswer) {
      reserved.hidden = false;
      if (typeof reserved.removeAttribute === 'function') reserved.removeAttribute('hidden');
      while (reserved.firstChild) reserved.removeChild(reserved.firstChild);
      return reserved;
    }
  }
  const mount = document.createElement('div');
  mount.className = 'talk-summary';
  return mount;
}

function talkSummaryAnswerNode(sections) {
  const article = document.createElement('article');
  article.className = 'talk-bubble talk-bubble-atlas talk-bubble-answer talk-bubble-summary';
  article.setAttribute('data-talk-role', 'atlas-answer');
  const mount = talkSummaryMount();
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    const card = document.createElement('section');
    card.className = 'talk-summary-section';
    card.setAttribute('data-talk-summary', section.key);
    const title = document.createElement('h3');
    title.className = 'talk-summary-title';
    title.textContent = section.title;
    card.appendChild(title);
    for (let j = 0; j < section.items.length; j += 1) {
      const body = document.createElement('p');
      body.className = 'talk-summary-item';
      body.textContent = section.items[j].body;
      card.appendChild(body);
    }
    mount.appendChild(card);
  }
  article.appendChild(mount);
  return article;
}

function talkValidCitations(citations) {
  if (!Array.isArray(citations) || !citations.length) return null;
  const items = [];
  for (let i = 0; i < citations.length; i += 1) {
    const raw = citations[i];
    if (!raw || typeof raw !== 'object') return null;
    if (raw.kind === 'surface') {
      const expected = TALK_CITATION_SURFACES[raw.href];
      if (!expected || raw.label !== expected) return null;
      if (!TALK_CITATION_SOURCES[raw.source]) return null;
      items.push({
        kind: 'surface',
        source: raw.source,
        href: raw.href,
        label: expected,
      });
    } else if (raw.kind === 'provenance') {
      if (typeof raw.label !== 'string' || !raw.label) return null;
      if (raw.source && !TALK_CITATION_SOURCES[raw.source]) return null;
      if (raw.trust === 'verified' || raw.source === 'verified') return null;
      if ((raw.trust === 'estimated' || raw.trust === 'unknown' || raw.trust === 'unavailable')
          && /verified/i.test(raw.label)) {
        return null;
      }
      items.push({
        kind: 'provenance',
        source: raw.source || null,
        asOf: typeof raw.asOf === 'string' ? raw.asOf : null,
        trust: typeof raw.trust === 'string' ? raw.trust : null,
        freshness: typeof raw.freshness === 'string' ? raw.freshness : null,
        label: raw.label,
      });
    } else {
      return null;
    }
  }
  return items.length ? items : null;
}

function talkCitationsNode(citations) {
  const wrap = document.createElement('div');
  wrap.className = 'talk-citations';
  wrap.setAttribute('data-talk-citations', 'atlas');
  const title = document.createElement('p');
  title.className = 'talk-citations-title';
  title.textContent = 'Sources';
  wrap.appendChild(title);
  const list = document.createElement('ul');
  list.className = 'talk-citations-list';
  for (let i = 0; i < citations.length; i += 1) {
    const item = citations[i];
    const li = document.createElement('li');
    li.className = 'talk-citation talk-citation-' + item.kind;
    li.setAttribute('data-talk-citation', item.kind);
    if (item.kind === 'surface') {
      const link = document.createElement('a');
      link.setAttribute('href', item.href);
      link.textContent = item.label;
      li.appendChild(link);
    } else {
      li.textContent = item.label;
    }
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

function talkCardsAnswerNode(cards) {
  const article = document.createElement('article');
  article.className = 'talk-bubble talk-bubble-atlas talk-bubble-answer talk-bubble-cards';
  article.setAttribute('data-talk-role', 'atlas-answer');
  const mount = talkCardsMount();
  for (let i = 0; i < cards.length; i += 1) {
    const item = cards[i];
    const card = document.createElement('section');
    card.className = 'talk-card talk-card-' + item.kind;
    card.setAttribute('data-talk-card', item.kind);
    const title = document.createElement('h3');
    title.className = 'talk-card-title';
    title.textContent = item.title;
    card.appendChild(title);
    if (item.kind === 'action') {
      const nav = document.createElement('p');
      nav.className = 'talk-answer-action';
      const link = document.createElement('a');
      link.setAttribute('href', item.href);
      link.textContent = item.label;
      nav.appendChild(link);
      card.appendChild(nav);
    } else {
      const body = document.createElement('p');
      body.className = 'talk-card-body';
      body.textContent = item.body;
      card.appendChild(body);
    }
    mount.appendChild(card);
  }
  article.appendChild(mount);
  return article;
}

function talkAnswerMetaText(presentation) {
  const parts = [];
  if (presentation.source === 'Forecast'
      || presentation.source === 'Bills'
      || presentation.source === 'Credit'
      || presentation.source === 'Planning') {
    parts.push(presentation.source);
  }
  if (typeof presentation.asOf === 'string' && presentation.asOf) {
    parts.push('as of ' + presentation.asOf);
  }
  if (typeof presentation.trust === 'string' && presentation.trust) {
    parts.push(presentation.trust);
  }
  if (typeof presentation.freshness === 'string' && presentation.freshness
      && presentation.freshness !== presentation.trust) {
    parts.push(presentation.freshness);
  }
  return parts.join(' · ');
}

// The trust meta line (source · as of · trust · freshness) travels with
// every answer shape. A summary or card answer reprints the same figures as
// the plain bubble, so it never drops their trust.
function talkAppendMeta(article, presentation) {
  const meta = talkAnswerMetaText(presentation);
  if (!meta) return;
  const line = document.createElement('p');
  line.className = 'talk-answer-meta';
  line.textContent = meta;
  article.appendChild(line);
}

function talkAllowedAction(action) {
  if (!action || typeof action !== 'object') return null;
  const href = action.href;
  const expected = TALK_ACTION_HREFS[href];
  if (!expected) return null;
  const label = typeof action.label === 'string' && action.label ? action.label : expected;
  if (href === '/' && label === 'View Plan') return { href: href, label: 'View Plan' };
  return { href: href, label: expected };
}

function talkAnswerNode(value) {
  const presentation = talkPresentation(value);
  const citations = talkValidCitations(presentation.citations);
  const summary = talkValidSummary(presentation.summary);
  const cards = talkValidCards(presentation.cards);
  if (summary) {
    const article = talkSummaryAnswerNode(summary);
    talkAppendMeta(article, presentation);
    if (citations) article.appendChild(talkCitationsNode(citations));
    return article;
  }
  if (cards) {
    const article = talkCardsAnswerNode(cards);
    talkAppendMeta(article, presentation);
    if (citations) article.appendChild(talkCitationsNode(citations));
    return article;
  }
  const article = document.createElement('article');
  article.className = 'talk-bubble talk-bubble-atlas talk-bubble-answer';
  article.setAttribute('data-talk-role', 'atlas-answer');
  const p = document.createElement('p');
  p.textContent = presentation.answer;
  article.appendChild(p);
  talkAppendMeta(article, presentation);
  const action = talkAllowedAction(presentation.action);
  if (action) {
    const nav = document.createElement('p');
    nav.className = 'talk-answer-action';
    const link = document.createElement('a');
    link.setAttribute('href', action.href);
    link.textContent = action.label;
    nav.appendChild(link);
    article.appendChild(nav);
  }
  if (citations) article.appendChild(talkCitationsNode(citations));
  return article;
}

function talkErrorNode(text) {
  const article = document.createElement('article');
  article.className = 'talk-bubble talk-bubble-atlas talk-bubble-error';
  article.setAttribute('data-talk-role', 'atlas-error');
  const p = document.createElement('p');
  p.textContent = text;
  article.appendChild(p);
  return article;
}

async function askTalk(question, signal) {
  const res = await fetch(TALK_ASK_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({ question }),
    signal,
  });
  const contentType = String(res.headers && res.headers.get
    ? res.headers.get('content-type')
    : '').toLowerCase();
  if (contentType.indexOf('text/event-stream') !== -1) {
    if (!res.ok) {
      throw new Error('error');
    }
    return readTalkAskStream(res, updateTalkLoading, signal);
  }
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  if (!res.ok) {
    const err = new Error(body && body.error === 'talk unavailable' ? 'unavailable' : 'error');
    throw err;
  }
  if (typeof body.answer !== 'string' || !body.answer.trim()) {
    throw new Error('error');
  }
  return {
    answer: body.answer,
    source: body.source || null,
    trust: body.trust || null,
    asOf: body.asOf || null,
    freshness: body.freshness || null,
    action: body.action || null,
    cards: body.cards || null,
    citations: body.citations || null,
    summary: body.summary || null,
  };
}

async function submitTalkQuestion(raw) {
  const question = normalizeComposerQuestion(raw);
  if (!question || talkAskInFlight) return;
  hideTalkEmpty();
  appendTalkBubble('household', 'talk-bubble-household', question);
  const input = $('talk-input');
  if (input) input.value = '';
  if (!talkModelAvailable) {
    const thread = talkThread();
    if (thread) thread.insertAdjacentHTML('beforeend', talkStubHtml());
    return;
  }
  talkAskInFlight = true;
  setTalkSendEnabled(false);
  if (talkAskAbort && typeof talkAskAbort.abort === 'function') {
    try { talkAskAbort.abort(); } catch (e) { /* already ended */ }
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  talkAskAbort = controller;
  appendTalkBubble('atlas-loading', 'talk-bubble-atlas talk-bubble-loading', TALK_LOADING_COPY);
  try {
    const answer = await askTalk(question, controller ? controller.signal : undefined);
    replaceTalkLoading(talkAnswerNode(answer));
  } catch (err) {
    if (err && err.name === 'AbortError') {
      replaceTalkLoading(talkErrorNode(TALK_ERROR_COPY));
    } else if (err && err.message === 'unavailable') {
      replaceTalkLoading(null);
      const thread = talkThread();
      if (thread) thread.insertAdjacentHTML('beforeend', talkStubHtml());
    } else {
      replaceTalkLoading(talkErrorNode(TALK_ERROR_COPY));
    }
  } finally {
    if (talkAskAbort === controller) talkAskAbort = null;
    talkAskInFlight = false;
    setTalkSendEnabled(talkModelAvailable);
  }
}

function setupTalkSurface() {
  const composer = $('talk-composer');
  const input = $('talk-input');
  const send = $('talk-send');
  const prompts = $('talk-prompts');

  // Fail closed: Send stays disabled until GET /talk/capability says
  // the Gemini path is available. The model secret never enters this file.
  if (send) {
    send.disabled = true;
    send.setAttribute('aria-disabled', 'true');
  }
  if (input) {
    input.setAttribute('maxlength', String(TALK_QUESTION_MAX));
  }
  if (composer) {
    composer.addEventListener('submit', event => {
      event.preventDefault();
      if (!talkModelAvailable) return;
      submitTalkQuestion(input ? input.value : '');
    });
  }
  if (prompts) {
    prompts.addEventListener('click', event => {
      const button = event.target.closest('[data-talk-prompt]');
      if (!button) return;
      const text = button.getAttribute('data-talk-prompt') || '';
      if (talkModelAvailable) {
        submitTalkQuestion(text);
      } else {
        if (input) input.value = text;
        showTalkPreview(text);
      }
    });
  }
  loadTalkContext();
  loadTalkCapability();
}

setupTalkSurface();
App.boot();
