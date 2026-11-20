'use strict';
/* B1, the Stack Wallet page shell: the static and no-flag guarantees, checked in CI without a browser.
 * (test/browser-stack-shell.js is the real-browser proof: no-flag body identical, chips print published values only.)
 *
 *   1. Without ?view=stack, stack-shell.js defines window.StackBlocks and touches nothing else: no element, class,
 *      stylesheet, App hook or listener. The four block placeholders only register a no-op.
 *   2. With ?view=stack it registers exactly one App render hook and adds the two Stack stylesheets.
 *   3. Every rule in public/stack.css and the four block stylesheets is scoped to html.stack-view, so none can
 *      restyle the current page.
 *   4. index.html loads the shell and then the four block files, after every current script.
 *   5. L-001: the shell prints money only from stackSummary.surplus.amount; it does no arithmetic on a figure.
 * `node test/test-stack-shell.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const BLOCKS = ['waterfall', 'cards', 'credit', 'sheet'];

function sandbox(search) {
  const touched = [];
  const trap = name => new Proxy(function () {}, { get: (_t, key) => { touched.push(name + '.' + String(key)); return trap(name + '.' + String(key)); },
    apply: () => { touched.push(name + '()'); return trap(name + '()'); } });
  const hooks = [];
  const ctx = { console, URLSearchParams, Intl, Map, Number, String, Object, Array, JSON,
    location: { search }, document: search.includes('view=stack') ? {
      documentElement: { classList: { add: c => touched.push('class:' + c) } },
      head: { appendChild: el => touched.push('link:' + el.href) },
      createElement: () => ({ addEventListener: () => {} }), querySelector: () => null, getElementById: () => null, body: null,
    } : trap('document'),
    App: { register: fn => hooks.push(fn) } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/stack-shell.js'), ctx);
  for (const name of BLOCKS) vm.runInContext(read(`public/stack-${name}.js`), ctx);
  return { ctx, touched, hooks };
}

console.log('1. no flag');
{
  const { ctx, touched, hooks } = sandbox('');
  ok(typeof ctx.window.StackBlocks.register === 'function', 'window.StackBlocks is defined for the block files');
  ok(touched.length === 0, 'the document is never touched', touched.join(', '));
  ok(hooks.length === 0, 'no App render hook is registered');
  ok(ctx.window.StackBlocks.names().join() === BLOCKS.join(), 'each placeholder registers its own block name', ctx.window.StackBlocks.names().join());
  const other = sandbox('?view=classic');
  ok(other.touched.length === 0 && other.hooks.length === 0, 'any other view value is the current page too');
}

console.log('2. ?view=stack');
{
  const { touched, hooks } = sandbox('?view=stack');
  ok(hooks.length === 1, 'exactly one App render hook is registered');
  ok(touched.join() === ['class:stack-view', 'link:/budget-stack-fonts.css', 'link:/stack.css',
    ...BLOCKS.map(n => `link:/stack-${n}.css`)].join(),
  'the page is marked and the font, shell and four block stylesheets are added, nothing more', touched.join());
}

console.log('3. the stylesheet is scoped');
{
  const css = ['stack', ...BLOCKS.map(n => 'stack-' + n)].map(f => read(`public/${f}.css`)).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  const walk = text => {
    let depth = 0, start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') {
        const head = text.slice(start, i).trim();
        if (depth === 0 && head.startsWith('@media')) { const end = matching(text, i); walk(text.slice(i + 1, end)); i = end; start = i + 1; continue; }
        if (depth === 0) selectors.push(...head.split(',').map(s => s.trim()));
        depth++;
      } else if (text[i] === '}') { depth--; if (depth === 0) start = i + 1; }
    }
  };
  const matching = (text, open) => { let d = 0; for (let i = open; i < text.length; i++) { if (text[i] === '{') d++; else if (text[i] === '}' && --d === 0) return i; } return text.length; };
  walk(css);
  const loose = selectors.filter(s => s && !s.startsWith('html.stack-view'));
  ok(selectors.length > 20 && loose.length === 0, `all ${selectors.length} selectors in the shell and block stylesheets start with html.stack-view`, loose.join(' | '));
}

console.log('4. index.html');
{
  const html = read('public/index.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  const want = ['/stack-shell.js', ...BLOCKS.map(n => `/stack-${n}.js`)];
  ok(JSON.stringify(scripts.slice(-5)) === JSON.stringify(want), 'the shell and then the four block files load last', scripts.slice(-5).join(' '));
  ok(!/stack\.css|budget-stack-fonts/.test(html), 'index.html links no Stack stylesheet (the shell adds them only under the flag)');
}

console.log('5. L-001: no arithmetic on money in the shell');
{
  const src = read('public/stack-shell.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const lines = src.split('\n').filter(line => /\.amount\b/.test(line));
  ok(lines.length === 1 && /s && typeof s\.amount === 'number' && Number\.isFinite\(s\.amount\) \? s\.amount : null/.test(lines[0]),
    'the only figure read is stackSummary.surplus.amount, passed through as published');
  // An operator applied to a figure: a +, -, * or / with whitespace or a bracket before it (so an attribute name such as
  // data-stack-chip-amount is not one), next to amount, view.<field> or v.<field>.
  ok(!/\.reduce\(|Math\.(round|abs|floor|ceil)\(|[\s)][+\-*/]\s*(amount\b|view\.|v\.)|\b(amount|view\.\w+|v\.\w+)\s*[+\-*/]\s/.test(src),
    'no sum, rounding or arithmetic on a figure');
}

console.log('6. no text labels (owner decision, 2026-11-19)');
{
  const src = read('public/stack-shell.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/Projected|'Past'|Last pay period|This pay period/.test(src) && /view\.evidenceState === 'projected'/.test(src),
    'the shell prints no period label; a projected chip is marked from the published evidenceState');
}

console.log('7. phone layout rules (the browser proof is test/browser-stack-layout.js, local)');
{
  const pile = read('public/stack.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const gap = /html\.stack-view \.stack-bare \+ \.stack-bare \{ margin-top: (\d+)px; \}/.exec(pile);
  ok(gap && Number(gap[1]) > 0, 'a bare block after a bare block (Credit after the cards) stands apart instead of overlapping the last card');
  const wf = read('public/stack-waterfall.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const slab = /\.wf-slab \{[^}]*container-type: inline-size;/.test(wf);
  const size = /\.wf-slab \.n, html\.stack-view \.stack-waterfall \.wf-slab \.wf-dash \{ font-size: min\(66px, (\d+(?:\.\d+)?)cqi\); white-space: nowrap; \}/.exec(wf);
  ok(slab && size && Number(size[1]) <= 16 && !/\.wf-slab \.n[^{]*\{[^}]*font-size: \d+px/.test(wf),
    'the surplus is sized to its slab (at most 16cqi, never a fixed px size that can spill past the edge)');
  // The narrow-phone rows: one block, below 375px only, that keeps each label on one line with a gap before its amount.
  const narrow = /@media \(max-width: (\d+(?:\.\d+)?)px\) \{([\s\S]*?)\n\}/.exec(wf);
  ok(narrow && Number(narrow[1]) < 375 && /\.lab \{ white-space: nowrap; \}/.test(narrow[2]) && /column-gap: \d+px/.test(narrow[2]),
    'the waterfall rows tighten only below 375px (labels on one line, a column gap before the amount)', narrow && narrow[1]);
}

console.log(`\nPASS Stack shell static checks (${checks})`);
