'use strict';

// Tripwires in the server subprocess, including startup. Test-only preloads
// are passed via Node arguments, so the demo environment stays allowlisted.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const http = require('node:http');
const https = require('node:https');
const root = process.cwd();
const isDemo = process.env.ATLAS_DEMO === '1';

function deny() { throw new Error('Unexpected I/O in demo proof'); }

function guarded(original) {
  return function (filename, ...args) {
    if (typeof filename === 'string') {
      const key = path.relative(root, path.resolve(filename)).replaceAll('\\', '/').toLowerCase();
      if (/^(?:data\.json|public\/periods\.json|(?:raw|derived|snapshots)(?:\/.*)?)$/.test(key)) deny();
      if (isDemo && (/^\.env(?:[._-]|$|rc$)|\.local$|^(?:secrets\.json|lunchmoney\.dat)$/i.test(path.basename(key))
        || ['scripts/local-config.json', 'docs/connectivity/provider-account-map.local.json'].includes(key))) deny();
    }
    return original.call(this, filename, ...args);
  };
}

for (const name of ['open', 'openSync', 'readFile', 'readFileSync', 'readdir', 'readdirSync']) {
  fs[name] = guarded(fs[name]);
}
for (const name of ['open', 'readFile', 'readdir']) fs.promises[name] = guarded(fs.promises[name]);
global.fetch = http.request = http.get = https.request = https.get = deny;

if (isDemo) {
  for (const name of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink']) {
    fs[name] = fs[name + 'Sync'] = fs.promises[name] = deny;
  }
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === path.join(root, 'server.js') && request !== './scripts/demo-server') deny();
    return load.call(this, request, parent, isMain);
  };
}
