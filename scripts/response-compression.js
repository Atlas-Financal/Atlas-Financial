'use strict';
// Response compression for an explicit allowlist of page and data responses.
//
// Purpose: the Budget page ships several large scripts and stylesheets and a
// large data.json on every load (Cache-Control is no-store), so the transfer
// size dominates load time on a slow connection. Compressing those bodies
// cuts the bytes without changing a single byte the browser decodes.
//
// Scope is an allowlist, not a blanket middleware. Only these may compress:
//   GET /data.json, GET /balance-history.json, GET / and /index.html, and
//   GET of a public .html/.js/.css/.json/.svg/.webmanifest file.
// Everything else is untouched: login, logout, sessions, the auth gate's
// 401/redirect (it answers before this runs), /assistant/*, OAuth metadata,
// /settlement/*, /healthz, redirects and every error status. A response is
// compressed only when its status is 200, it carries no Content-Encoding of
// its own, it sets no cookie, and its body is at least MIN_BYTES.
//
// Built-in zlib only: Brotli (quality 4, a fast level) when the client
// accepts it, else gzip, else identity. Every allowlisted 200, whether
// compressed or not, carries Vary: Accept-Encoding so a shared cache never
// serves one encoding to a client that asked for another. No other header
// is changed; Content-Length is restated for the encoded body.
//
// BREACH (a compression side-channel) needs a secret and attacker-reflected
// input in the same compressed body. The allowlisted bodies reflect no
// request input (data.json validates its one query option and echoes
// nothing), and no session token or CSRF value is ever in them.

const zlib = require('zlib');

const MIN_BYTES = 1024;
const STATIC_EXTENSIONS = /\.(?:html|js|css|json|svg|webmanifest)$/i;
const ROUTES = new Set(['/', '/index.html', '/data.json', '/balance-history.json']);
const EXCLUDED_PREFIXES = /^\/(?:login|logout|healthz|assistant|settlement|\.well-known)(?:[\/.]|$)/i;
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:json|javascript|manifest\+json)|image\/svg\+xml)/i;

function allowlisted(req) {
  if (req.method !== 'GET') return false;
  const p = req.path;
  if (EXCLUDED_PREFIXES.test(p)) return false;
  return ROUTES.has(p) || STATIC_EXTENSIONS.test(p);
}

// Parse Accept-Encoding (RFC 9110 §12.5.3) into the chosen coding:
// 'br', 'gzip' or null. An explicit q=0 refuses a coding; '*' covers any
// coding not named.
function negotiate(header) {
  if (typeof header !== 'string' || header.trim() === '') return null;
  const q = new Map();
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.toLowerCase().split(';');
    const name = rawName.trim();
    if (!name) continue;
    let weight = 1;
    for (const param of params) {
      // A malformed weight refuses the coding rather than accepting it.
      const m = /^\s*q\s*=(.*)$/.exec(param);
      if (m) weight = /^\s*[0-9.]+\s*$/.test(m[1]) ? Number(m[1]) : 0;
    }
    if (!Number.isFinite(weight)) weight = 0;
    q.set(name, weight);
  }
  const weightOf = name => (q.has(name) ? q.get(name) : (q.get('*') || 0));
  const br = weightOf('br');
  const gzip = weightOf('gzip');
  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return null;
}

function toBuffer(chunk, encoding) {
  if (chunk == null) return null;
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
}

function compressBody(coding, body, done) {
  if (coding === 'br') {
    return zlib.brotliCompress(body, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    }, done);
  }
  return zlib.gzip(body, { level: 6 }, done);
}

function shouldCompress(res, body) {
  if (res.statusCode !== 200 || res.headersSent) return false;
  if (body.length < MIN_BYTES) return false;
  if (res.getHeader('Content-Encoding')) return false;
  if (res.getHeader('Set-Cookie')) return false;
  const type = String(res.getHeader('Content-Type') || '');
  return COMPRESSIBLE_TYPE.test(type);
}

// Express middleware. Mounted after the auth gate, so a request that reaches
// it is already authorised (or is the public stylesheet the login page needs).
function compressAllowlisted(req, res, next) {
  if (!allowlisted(req)) return next();
  const coding = negotiate(req.get('Accept-Encoding'));

  const chunks = [];
  const originalWrite = res.write;
  const originalEnd = res.end;
  let ended = false;
  let chunkStatus = null;
  // Body chunks belong to the status they were written under. If the status
  // then changes (a static read that fails partway hands the response to the
  // error handler, which sets 500 and writes its own page with its own
  // Content-Length), the chunks already buffered are an abandoned body:
  // drop them, so the error response goes out exactly as its handler wrote it.
  function keep(buffer) {
    if (chunkStatus !== null && res.statusCode !== chunkStatus) chunks.length = 0;
    chunkStatus = res.statusCode;
    if (buffer) chunks.push(buffer);
  }

  res.write = function write(chunk, encoding, callback) {
    const buffer = toBuffer(chunk, encoding);
    if (buffer) keep(buffer);
    const cb = typeof encoding === 'function' ? encoding : callback;
    if (typeof cb === 'function') process.nextTick(cb);
    return true;
  };

  res.end = function end(chunk, encoding, callback) {
    if (ended) return res;
    ended = true;
    if (typeof chunk === 'function') { callback = chunk; chunk = null; }
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    keep(toBuffer(chunk, encoding));
    res.write = originalWrite;
    res.end = originalEnd;
    const body = Buffer.concat(chunks);
    const finishIdentity = () => res.end(body, callback);
    // Only a 200 can be compressed, so only a 200 varies by encoding; a
    // redirect, a 404 or an error keeps exactly the headers it had.
    if (res.statusCode === 200 && !res.headersSent) res.vary('Accept-Encoding');
    if (!coding || !shouldCompress(res, body)) return finishIdentity();
    compressBody(coding, body, (err, encoded) => {
      if (res.destroyed) return;
      // Headers flushed while zlib ran cannot be changed any more: send the
      // body as is rather than throw ERR_HTTP_HEADERS_SENT in this callback.
      if (err || res.headersSent) return finishIdentity();
      res.setHeader('Content-Encoding', coding);
      res.setHeader('Content-Length', encoded.length);
      res.end(encoded, callback);
    });
    return res;
  };

  return next();
}

module.exports = { compressAllowlisted, negotiate, allowlisted, MIN_BYTES };
