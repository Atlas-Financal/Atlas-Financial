'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Deny every other environment key, including new credentials whose names
// Atlas does not yet know. Check presence, including empty values.
const BOOT_ENV = new Set([
  'ATLAS_DEMO', 'PORT', 'NODE_ENV', 'PATH',
  // libuv automatically supplies these to Windows child processes.
  'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP',
  'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
]);
const PUBLIC = path.join(__dirname, '..', 'public');
const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'figures-inputs', 'stack-card-summary.json');
const HOUSEHOLD_PATHS = ['data.json', 'public/periods.json', 'raw', 'derived', 'snapshots'];
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

const BANNER = '<p id="atlas-demo-banner" style="margin:0;padding:10px 16px;background:#ffe7a3;' +
  'color:#241c0a;text-align:center;font:600 15px/1.4 system-ui">' +
  'Demo — made-up numbers, not a real household.</p>';

function readFixedFile(filename) {
  if (fs.realpathSync(filename) !== filename) throw new Error('Unexpected demo file location');
  return fs.readFileSync(filename);
}

function start(environment) {
  if (environment.ATLAS_DEMO !== '1' || Object.keys(environment).some(key => !BOOT_ENV.has(key.toUpperCase()))) {
    console.error('FATAL: demo requires an isolated startup environment.');
    process.exitCode = 1;
    return;
  }
  if (HOUSEHOLD_PATHS.some(name => fs.lstatSync(path.join(__dirname, '..', name), { throwIfNoEntry: false }))) {
    console.error('FATAL: demo requires a checkout without household data paths.');
    process.exitCode = 1;
    return;
  }

  const express = require('express');
  const fixture = JSON.parse(readFixedFile(FIXTURE));
  if (fixture.schema !== 'atlas-figures-input/v1' || fixture.id !== 'stack-card-summary'
    || fixture.invented !== true || !fixture.data?.meta?.asOf) {
    throw new Error('Invented demo fixture is unavailable');
  }

  const template = readFixedFile(path.join(PUBLIC, 'index.html')).toString('utf8');
  if (!template.includes('<body>')) throw new Error('Demo Budget template has no banner mount');
  const budget = template.replace('</head>',
    '<style>[data-manual-refresh], [data-stack-refresh] { display: none !important; }</style>\n</head>')
    .replace('<body>', '<body>\n' + BANNER)
    .replace('<script src="/client-timing.js"></script>', '');
  const assetRoutes = new Map(ASSETS.map(name => {
    const type = path.extname(name);
    const body = readFixedFile(path.join(PUBLIC, name));
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

module.exports = { start, ASSETS, FIXTURE, DEMO_SCRIPT_MARKER };
