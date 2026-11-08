'use strict';
// The page renderers' shared escapeHtml, lifted from public/app.js so a node
// suite that loads a renderer without app.js runs the same helper the browser
// does. It is read from app.js, never restated here.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const line = /^const escapeHtml = .*$/m.exec(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'));
if (!line) throw new Error('public/app.js no longer defines escapeHtml on one line');
module.exports = vm.runInNewContext(`${line[0]}\nescapeHtml;`);
