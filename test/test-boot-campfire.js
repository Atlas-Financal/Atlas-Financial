'use strict';
// The campfire loading scene (owner, Dale, 2026-11-20: "Make this video the
// loading screen"). Static checks on what the household's phone downloads
// and on the site's security policy:
//   1  the scene is an image the existing policy already allows
//      (img-src 'self'): an animated AVIF and a still JPEG, no <video>
//      anywhere in the page, and the server's policy names no media-src;
//   2  the animation stays small (every load downloads it: static files
//      are served no-store), and the still smaller still;
//   3  the scene is set only on the two boot layers, reduced motion swaps
//      in the still, and the crit surface uses the still.
//   node test/test-boot-campfire.js
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
let checks = 0;
function ok(cond, what) {
  checks++;
  if (!cond) { console.error('FAIL ' + what); process.exit(1); }
  console.log('  ok ' + what);
}
const read = rel => fs.readFileSync(path.join(root, rel));

const avif = read('public/boot-campfire.avif');
const jpg = read('public/boot-campfire.jpg');
ok(avif.slice(4, 12).toString('latin1') === 'ftypavis', 'the animation is an animated AVIF image (an image sequence, "avis" brand)');
ok(jpg[0] === 0xff && jpg[1] === 0xd8, 'the still is a JPEG');
ok(avif.length <= 300 * 1024, 'the animation is at most 300 KB (' + Math.round(avif.length / 1024) + ' KB)');
ok(jpg.length <= 80 * 1024, 'the still is at most 80 KB (' + Math.round(jpg.length / 1024) + ' KB)');

const html = read('public/index.html').toString('utf8');
const server = read('server.js').toString('utf8');
ok(!/<video\b/i.test(html), 'the page has no <video> element');
ok(/img-src 'self'/.test(server) && !/media-src/.test(server), 'the security policy is unchanged: images from the site only, no media-src');

const css = read('public/styles.css').toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const uses = [...css.matchAll(/([^{}]+)\{[^{}]*boot-campfire\.(avif|jpg)/g)].map(m => [m[1].trim(), m[2]]);
ok(uses.length > 0 && uses.every(([sel]) => sel.split(',').every(s => /\.boot-static|\[data-boot-notice\]/.test(s))),
  'the scene is set only on the boot layers (.boot-static, [data-boot-notice])');
ok(uses.some(([sel, kind]) => /\[data-boot-notice\]\.crit/.test(sel) && kind === 'jpg'), 'the crit surface shows the still');
const reduced = (/@media \(prefers-reduced-motion: reduce\) \{\s*\.boot-static, \[data-boot-notice\] \{[^}]*\}/.exec(css.slice(css.lastIndexOf('boot-campfire') - 2000)) || [''])[0];
ok(/boot-campfire\.jpg/.test(reduced) && !/boot-campfire\.avif/.test(reduced), 'reduced motion shows the still, not the animation');

console.log(`\nPASS campfire loading scene (${checks})`);
