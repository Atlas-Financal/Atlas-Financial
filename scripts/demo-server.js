'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Deny every other environment key, including new credentials whose names
// Atlas does not yet know. Check presence, including empty values.
const BOOT_ENV = new Set([
  'ATLAS_DEMO', 'PORT', 'NODE_ENV', 'PATH',
  // libuv automatically supplies these to Windows child processes.
  'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP',
  'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
]);
const ROOT = path.join(__dirname, '..');
const FIXTURE_PATH = 'test/fixtures/figures-inputs/stack-card-summary.json';
const DIGESTS_REL = 'scripts/demo-asset-digests';
const DIGESTS_DIR = path.join(ROOT, DIGESTS_REL);
const TEXT_ASSET = /\.(?:js|json|html|css|svg|webmanifest)$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const HOUSEHOLD_PATHS = ['data.json', 'public/periods.json', 'raw', 'derived', 'snapshots'];
const CREDENTIAL_PATHS = ['scripts/local-config.json', 'docs/connectivity/provider-account-map.local.json'];
const DEMO_SCRIPT_MARKER = '/* Atlas demo asset */\n';

// Only Budget's reviewed assets. A new file in public/ is private by default.
const ASSETS = [
  'app.js', 'display-name.js', 'forecast-card-period.js', 'forecast.js',
  'forecast-chequing.js', 'balance-history.js', 'bill-detail.js', 'savings-inventory.js',
  'budget-surface.js', 'budget-card-movements.js', 'budget-sheet-motion.js', 'plan.js',
  'household-view.js', 'budget-polish.js', 'aurora.js', 'budget-river.js', 'budget-blend.js',
  'stack-shell.js', 'stack-waterfall.js', 'stack-cards.js', 'stack-credit.js', 'stack-sheet.js',
  'fonts.css', 'styles.css', 'household-view.css', 'nav-glass.css', 'budget-polish.css',
  'bill-detail.css', 'savings-inventory.css', 'running-build.css', 'budget-surface.css',
  'budget-blend.css', 'budget-gface.css', 'budget-sheet-motion.css', 'atlas-toolbar.css',
  'budget-stack-fonts.css', 'stack.css', 'stack-waterfall.css', 'stack-cards.css',
  'stack-credit.css', 'stack-sheet.css', 'fonts/Geist.woff2', 'fonts/GeistMono.woff2',
  'fonts/Outfit-latin.woff2', 'fonts/Outfit-latin-ext.woff2',
  'boot-campfire.avif', 'boot-campfire.jpg', 'manifest.webmanifest',
  'apple-touch-icon.png', 'icon.svg', 'icon-192.png', 'icon-512.png',
];
const ASSET_FILES = Object.freeze([FIXTURE_PATH, 'public/index.html', ...ASSETS.map(name => 'public/' + name)]);
const ASSET_FILE_SET = new Set(ASSET_FILES);

const BANNER = '<p id="atlas-demo-banner" style="margin:0;padding:10px 16px;background:#ffe7a3;' +
  'color:#241c0a;text-align:center;font:600 15px/1.4 system-ui">' +
  'Demo — made-up numbers, not a real household.</p>';

function assetDigest(body) {
  return createHash('sha256').update(Buffer.isBuffer(body) ? body : Buffer.from(body)).digest('hex');
}

function formatDigest(hash) {
  return hash + '\n';
}

function parseDigest(text, label) {
  const normalized = text.replaceAll('\r\n', '\n');
  if (!normalized.endsWith('\n')) throw new Error(`Malformed demo asset digest: ${label}`);
  const lines = normalized.slice(0, -1).split('\n');
  if (lines.length !== 1 || !HASH_RE.test(lines[0])) {
    throw new Error(`Malformed demo asset digest: ${label}`);
  }
  return lines[0];
}

function listDigestFiles(dir) {
  const baseStat = fs.lstatSync(dir);
  if (!baseStat.isDirectory()) throw new Error('Unexpected demo digest directory');
  const rootReal = fs.realpathSync(dir);
  const out = [];
  const walk = rel => {
    const abs = rel ? path.join(rootReal, rel) : rootReal;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected demo digest file: ${childRel}`);
      if (fs.realpathSync(childAbs) !== childAbs) throw new Error(`Unexpected demo digest file: ${childRel}`);
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) out.push(childRel);
      else throw new Error(`Unexpected demo digest file: ${childRel}`);
    }
  };
  walk('');
  return out.sort();
}

function loadApprovedAssets(dir = DIGESTS_DIR) {
  const files = listDigestFiles(dir);
  const approved = new Map();
  for (const rel of files) {
    if (!rel.endsWith('.sha256')) throw new Error(`Unexpected demo digest file: ${rel}`);
    const name = rel.slice(0, -'.sha256'.length);
    if (!ASSET_FILE_SET.has(name)) throw new Error(`Unexpected demo digest file: ${rel}`);
    const text = fs.readFileSync(path.join(dir, rel), 'utf8');
    approved.set(name, parseDigest(text, rel));
  }
  for (const name of ASSET_FILES) {
    if (!approved.has(name)) throw new Error(`Missing demo asset digest: ${name}`);
  }
  return approved;
}

let approvedAssets = null;
function getApprovedAssets() {
  if (!approvedAssets) approvedAssets = loadApprovedAssets();
  return approvedAssets;
}

function verifyAsset(name, body, approved = getApprovedAssets()) {
  const expected = approved.get(name);
  if (!expected || assetDigest(body) !== expected) {
    throw new Error(`Unexpected demo asset contents: ${name}`);
  }
}

function readApprovedFile(name) {
  const filename = path.join(ROOT, name);
  if (fs.realpathSync(filename) !== filename) throw new Error('Unexpected demo file location');
  const body = fs.readFileSync(filename);
  verifyAsset(name, body);
  return body;
}

function privateEntryKind(directory, recursive) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    // Match .gitignore's statement directory family before entering it.
    if (/^statements(?:$|-)/i.test(entry.name)) return 'household';
    if (/^\.env(?:[._-]|$|rc$)|\.local$|^(?:secrets\.json|lunchmoney\.dat)$/i.test(entry.name)) return 'credential';
    if (recursive && entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) {
      const kind = privateEntryKind(path.join(directory, entry.name), true);
      if (kind) return kind;
    }
  }
  return null;
}

function privatePathKind(cwd) {
  for (const directory of new Set([ROOT, cwd])) {
    if (HOUSEHOLD_PATHS.some(name => fs.lstatSync(path.join(directory, name), { throwIfNoEntry: false }))) return 'household';
    if (CREDENTIAL_PATHS.some(name => fs.lstatSync(path.join(directory, name), { throwIfNoEntry: false }))) return 'credential';
  }
  return privateEntryKind(ROOT, true) || (cwd === ROOT ? null : privateEntryKind(cwd, false));
}

function start(environment) {
  if (environment.ATLAS_DEMO !== '1' || Object.keys(environment).some(key => !BOOT_ENV.has(key.toUpperCase()))) {
    console.error('FATAL: demo requires an isolated startup environment.');
    process.exitCode = 1;
    return;
  }
  const privatePath = privatePathKind(process.cwd());
  if (privatePath === 'household') {
    console.error('FATAL: demo requires a checkout without household data paths.');
    process.exitCode = 1;
    return;
  }
  if (privatePath === 'credential') {
    console.error('FATAL: demo requires a checkout without local credential files.');
    process.exitCode = 1;
    return;
  }

  const express = require('express');
  approvedAssets = loadApprovedAssets();
  const fixture = JSON.parse(readApprovedFile(FIXTURE_PATH));
  if (fixture.schema !== 'atlas-figures-input/v1' || fixture.id !== 'stack-card-summary'
    || fixture.invented !== true || !fixture.data?.meta?.asOf) {
    throw new Error('Invented demo fixture is unavailable');
  }

  const template = readApprovedFile('public/index.html').toString('utf8');
  if (!template.includes('<body>')) throw new Error('Demo Budget template has no banner mount');
  const budget = template.replace('</head>',
    '<style>[data-manual-refresh], [data-stack-refresh] { display: none !important; }</style>\n</head>')
    .replace('<body>', '<body>\n' + BANNER)
    .replace('<script src="/client-timing.js"></script>', '');
  const assetRoutes = new Map(ASSETS.map(name => {
    const type = path.extname(name);
    const body = readApprovedFile('public/' + name);
    if (type === '.js' && body.toString('utf8', 0, DEMO_SCRIPT_MARKER.length) !== DEMO_SCRIPT_MARKER) {
      throw new Error('Demo requires packaged browser scripts');
    }
    return ['/' + name, { type, body }];
  }));
  const data = JSON.stringify(fixture.data);
  const periods = JSON.stringify(fixture.periods);

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use((req, res) => {
    res.set({
      'Cache-Control': 'no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).set('Allow', 'GET, HEAD').end();

    // Exact URL keys only. No request path is decoded into a filesystem path.
    const route = req.url.split('?', 1)[0];
    if (route === '/' || route === '/index.html') return res.type('html').send(budget);
    if (route === '/data.json') return res.type('json').send(data);
    if (route === '/periods.json') return res.type('json').send(periods);
    if (route === '/healthz') return res.type('text/plain').send('ok');
    if (route === '/robots.txt') return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
    const asset = assetRoutes.get(route);
    if (asset) return res.type(asset.type).send(asset.body);
    return res.status(404).type('text/plain').send('Not found');
  });

  const server = app.listen(Number(environment.PORT ?? 3000), () => {
    console.log(`Atlas demo listening on ${server.address().port}`);
  });
  return server;
}

module.exports = {
  start, ASSETS, ASSET_FILES, FIXTURE_PATH, DIGESTS_REL, DIGESTS_DIR, TEXT_ASSET,
  DEMO_SCRIPT_MARKER, assetDigest, formatDigest, parseDigest, listDigestFiles,
  loadApprovedAssets, verifyAsset,
};
