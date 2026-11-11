'use strict';
/* Household mobile navigation presentation: Budget | Forecast | Bills |
 * Subscriptions | Credit | Plan spend, shared dock treatment, iPhone
 * safe-area clearance, and no new UI dependency. Presentation only —
 * Forecast authority is untouched. (Talk was removed: #821 comment 6786692208.)
 *
 * `node test/test-household-nav-presentation.js`
 */
const fs = require('fs');
const path = require('path');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const HOUSEHOLD_PAGES = [
  ['public/index.html', 'Budget', '/'],
  ['public/planning.html', 'Forecast', '/planning.html'],
  ['public/bills.html', 'Bills', '/bills.html'],
  ['public/subscriptions.html', 'Subscriptions', '/subscriptions.html'],
  ['public/credit.html', 'Credit', '/credit.html'],
  ['public/plan-spend.html', 'Plan spend', '/plan-spend.html'],
];
const HOUSEHOLD_NAV = [
  ['/', 'Budget', 'budget'],
  ['/planning.html', 'Forecast', 'forecast'],
  ['/bills.html', 'Bills', 'bills'],
  ['/subscriptions.html', 'Subscriptions', 'subscriptions'],
  ['/credit.html', 'Credit', 'credit'],
  ['/plan-spend.html', 'Plan spend', 'plan-spend'],
];

function siteNav(html) {
  const match = /<nav class="sitenav(?: [^"]*)?" aria-label="Pages">([\s\S]*?)<\/nav>/.exec(html);
  if (!match) return null;
  return [...match[1].matchAll(/<a href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g)].map(m => {
    const labelled = /class="sitenav-label"[^>]*>([^<]+)</.exec(m[3]);
    const nav = /data-nav="([^"]+)"/.exec(m[2]);
    return {
      href: m[1],
      current: /aria-current="page"/.test(m[2]),
      label: (labelled ? labelled[1] : m[3]).replace(/<[^>]+>/g, '').trim(),
      dataNav: nav ? nav[1] : '',
      hasIcon: /class="sitenav-icon"/.test(m[3]),
    };
  });
}

function mobileNavBlock(css) {
  const start = css.search(/@media \(max-width:640px\) \{/);
  if (start < 0) return '';
  let i = css.indexOf('{', start) + 1;
  let depth = 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(start, i);
}

const css = read('public/styles.css');
const glass = read('public/nav-glass.css');
const householdView = read('public/household-view.css');
const pkg = JSON.parse(read('package.json'));
const mobile = mobileNavBlock(css);

console.log('=== 1–8. Shared household destinations, routes, order, and current page ===');
{
  const expected = JSON.stringify(HOUSEHOLD_NAV.map(n => [n[0], n[1]]));
  for (const [file, label] of HOUSEHOLD_PAGES) {
    if (file === 'public/index.html') {
      const html = read(file);
      ok(siteNav(html) === null, 'Budget has no page nav');
      ok(!/class="sitenav sitenav-household"/.test(html),
        'Budget does not reserve a household dock');
      ok(/class="blend-brand"/.test(html) && /data-blend-theme/.test(html),
        'Budget header is the logo and the theme control');
      continue;
    }
    const nav = siteNav(read(file));
    ok(nav && nav.length === 6, `${file} has exactly six household destinations`,
      nav ? nav.map(l => l.label).join(' | ') : 'no nav');
    ok(nav && JSON.stringify(nav.map(l => [l.href, l.label])) === expected,
      `${file} reads Budget | Forecast | Bills | Subscriptions | Credit | Plan spend`);
    ok(nav && nav[0].href === '/' && nav[0].label === 'Budget',
      `${file} Budget still routes to /`);
    ok(nav && nav[1].href === '/planning.html' && nav[1].label === 'Forecast'
        && nav[2].href === '/bills.html' && nav[3].href === '/subscriptions.html'
        && nav[4].href === '/credit.html' && nav[5].href === '/plan-spend.html',
      `${file} keeps Forecast beside Budget, then Bills / Subscriptions / Credit / Plan spend`);
    ok(nav && !nav.some(l => l.label === 'Talk' || l.href === '/talk.html' || l.dataNav === 'talk'),
      `${file} has no Talk tab`);
    const current = nav ? nav.filter(l => l.current) : [];
    ok(current.length === 1 && current[0].label === label,
      `${file} marks exactly one destination current: ${label}`);
    ok(nav && nav.every(l => l.hasIcon && l.dataNav),
      `${file} uses the shared icon + data-nav vocabulary, not label-only links`);
    ok(/class="sitenav sitenav-household"/.test(read(file)),
      `${file} marks the household dock so diagnostic sitenav is not restyled`);
  }
}

console.log('\n=== 9–13. iPhone dock: safe area, clearance, touch targets, motion ===');
{
  ok(/viewport-fit=cover/.test(read('public/index.html'))
      && HOUSEHOLD_PAGES.every(([file]) => /viewport-fit=cover/.test(read(file))),
    'every household page enables viewport-fit=cover so iOS safe-area insets apply');
  ok(/--nav-dock-height:66px/.test(css) && /--nav-dock-lift:12px/.test(css)
      && /--nav-dock-inset:10px/.test(css),
    'shared dock tokens name height, lift above the home indicator, and side inset');
  ok(mobile.includes('env(safe-area-inset-bottom, 0px)')
      && /bottom:calc\(\s*var\(--nav-dock-lift\)\s*\+\s*env\(safe-area-inset-bottom/.test(mobile)
      && /left:calc\(\s*var\(--nav-dock-inset\)\s*\+\s*env\(safe-area-inset-left/.test(mobile)
      && /right:calc\(\s*var\(--nav-dock-inset\)\s*\+\s*env\(safe-area-inset-right/.test(mobile),
    'the floating dock is placed relative to the iOS safe area, not flush to the physical edge');
  ok(/body:has\(\.sitenav-household\) \{[\s\S]*padding-bottom:calc\(\s*var\(--nav-dock-height\)\s*\+\s*var\(--nav-dock-lift\)\s*\+\s*18px\s*\+\s*env\(safe-area-inset-bottom/.test(mobile)
      && /\.sitenav-household \{/.test(mobile)
      && !/\.sitenav:not\(\.subnav\)/.test(css),
    'dock clearance and the six-column dock apply only to household nav, not every sitenav');
  ok(/grid-template-columns:\s*repeat\(6,minmax\(0,1fr\)\)/.test(mobile),
    'mobile dock is a six-column grid, not the retired four-column website bar');
  ok(/min-height:52px/.test(mobile) && /min-height:var\(--nav-dock-height\)/.test(mobile),
    'dock items keep a ≥52px touch target and the dock itself is at least 66px tall');
  ok(/white-space:nowrap/.test(mobile) && !/overflow-wrap:anywhere/.test(mobile),
    'mobile labels stay on one line so Subscriptions does not wrap to a stray s');
  const reduced = /@media \(max-width:640px\) and \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/.exec(css);
  ok(reduced && /transition:\s*none/.test(reduced[0]) && /transform:\s*none/.test(reduced[0]),
    'press-scale and color motion are disabled when the household prefers reduced motion');
  ok(/transition:color \.16s ease/.test(mobile) && /a:active \{ transform:scale\(\.96\); \}/.test(mobile),
    'active-state motion exists and stays short');
}

console.log('\n=== 13b. Diagnostic pages keep the four-link text nav ===');
{
  const diagnostic = [
    ['public/modellers.html', 'Modellers'],
  ];
  const expected = JSON.stringify([
    ['/', 'Plan'],
    ['/modellers.html', 'Modellers'],
    ['/deepdive.html', 'Deep Dive'],
    ['/records.html', 'Records'],
  ]);
  for (const [file, label] of diagnostic) {
    const html = read(file);
    const nav = siteNav(html);
    ok(!/sitenav-household/.test(html),
      `${file} is not marked as the household dock`);
    ok(nav && nav.length === 4, `${file} still has four diagnostic destinations`,
      nav ? nav.map(l => l.label).join(' | ') : 'no nav');
    ok(nav && JSON.stringify(nav.map(l => [l.href, l.label])) === expected,
      `${file} still reads Plan | Modellers | Deep Dive | Records`);
    ok(nav && nav.every(l => !l.hasIcon && !l.dataNav),
      `${file} stays text-only — no empty icon wells`);
    const current = nav ? nav.filter(l => l.current) : [];
    ok(current.length === 1 && current[0].label === label,
      `${file} marks exactly one diagnostic destination current: ${label}`);
  }
}

console.log('\n=== 13c. iOS glass selector and cross-page sliding selection ===');
{
  ok(/^@import url\('\/nav-glass\.css'\);/.test(householdView),
    'Budget loads the shared glass dock through its existing household-view stylesheet');
  for (const file of ['public/bills.html', 'public/subscriptions.html', 'public/credit.html', 'public/planning.html', 'public/plan-spend.html']) {
    ok(/<link rel="stylesheet" href="\/nav-glass\.css">/.test(read(file)),
      `${file} loads the shared glass dock stylesheet`);
  }
  ok(/@view-transition\s*\{\s*navigation:\s*auto;\s*\}/.test(glass)
      && /view-transition-name:\s*atlas-tab-indicator/.test(glass)
      && /::view-transition-group\(atlas-tab-indicator\)/.test(glass),
    'the selected glass lens participates in cross-document view transitions instead of popping onto the next tab');

  const glassMobile = mobileNavBlock(glass);
  const dockRule = /\.sitenav-household\s*\{([^}]*)\}/.exec(glassMobile);
  const dock = dockRule ? dockRule[1] : '';
  const lensRules = [...glassMobile.matchAll(/\.sitenav-household::before\s*\{([^}]*)\}/g)].map(m => m[1]);
  const lens = lensRules.find(body => /content:\s*""/.test(body)) || '';
  const num = (re, text) => { const m = re.exec(text); return m ? Number(m[1]) : NaN; };
  const dockHeight = num(/--nav-dock-height:\s*([\d.]+)px/, css);
  const edge = num(/--nav-edge:\s*([\d.]+)px/, dock);
  const lensHeight = num(/--nav-lens-height:\s*([\d.]+)px/, dock);
  const lensInset = num(/--nav-lens-inset:\s*([\d.]+)px/, dock);

  ok(lensRules.filter(body => /content:\s*""/.test(body)).length === 1
      && (glass.match(/view-transition-name:\s*atlas-tab-indicator/g) || []).length === 1
      && /view-transition-name:\s*atlas-tab-indicator/.test(lens)
      && /\.sitenav-household a\[aria-current\]::before\s*\{\s*content:none;\s*\}/.test(glassMobile),
    'exactly one lens is drawn by the dock itself and shared by all six tabs; no per-tab capsule remains');

  const columns = /grid-template-columns:\s*((?:minmax\(0,[\d.]+fr\)\s*){6});/.exec(dock);
  const factors = columns ? [...columns[1].matchAll(/minmax\(0,([\d.]+)fr\)/g)].map(m => Number(m[1])) : [];
  const total = factors.reduce((a, b) => a + b, 0);
  const starts = factors.map((_, i) => factors.slice(0, i).reduce((a, b) => a + b, 0));
  const unitDivisor = num(/--nav-unit:\s*calc\(\(100% - 2 \* var\(--nav-edge\)\) \/ ([\d.]+)\)/, dock);
  ok(factors.length === 6 && Math.abs(unitDivisor - total) < 1e-9 && /gap:\s*0;/.test(dock),
    'the lens unit divides the dock by the same total as the six contiguous grid columns',
    `columns ${factors.join(' | ')} → ${total}; unit divisor ${unitDivisor}`);
  const positions = HOUSEHOLD_NAV.map(([, , name]) => {
    const m = new RegExp(`\\.sitenav-household:has\\(a\\[data-nav="${name}"\\]\\[aria-current="page"\\]\\)\\s*\\{([^}]*)\\}`).exec(glassMobile);
    if (!m) return null;
    const start = /--nav-slot-start:\s*([\d.]+)/.exec(m[1]);
    const span = /--nav-slot-span:\s*([\d.]+)/.exec(m[1]);
    return { start: start ? Number(start[1]) : NaN, span: span ? Number(span[1]) : 1 };
  });
  ok(positions.every(Boolean)
      && positions.every((p, i) => Math.abs(p.start - starts[i]) < 1e-9 && Math.abs(p.span - factors[i]) < 1e-9)
      && new Set(positions.map(p => p.start)).size === 6
      && /left:calc\(var\(--nav-edge\) \+ var\(--nav-slot-start\) \* var\(--nav-unit\) \+ var\(--nav-lens-inset\)\)/.test(lens)
      && /width:calc\(var\(--nav-slot-span\) \* var\(--nav-unit\) - 2 \* var\(--nav-lens-inset\)\)/.test(lens),
    'aria-current alone places the lens on six deterministic slots that line up with the grid columns');
  const label = /font-size:clamp\(([\d.]+)rem,([\d.]+)vw,([\d.]+)rem\)/.exec(glassMobile);
  const labelAt390 = label ? Math.min(Math.max(Number(label[1]) * 16, Number(label[2]) * 3.9), Number(label[3]) * 16) : NaN;
  ok(factors.length === 6 && factors[3] > 1 && factors[3] === Math.max(...factors)
      && factors.filter(f => f === factors[3]).length === 1
      && factors[0] === factors[1] && factors[1] === factors[2]
      && factors[2] === factors[4] && factors[4] === factors[5]
      && HOUSEHOLD_NAV[3][2] === 'subscriptions'
      && /white-space:nowrap/.test(glassMobile) && !/overflow-wrap:anywhere/.test(glassMobile)
      && label && Number(label[1]) * 16 >= 8 && labelAt390 >= 9.5 && Number(label[3]) * 16 <= 11,
    'Subscriptions owns the unique widest slot; the other five shorter labels share equal width, stay on one line, and labels read ≥9.5px at the 390px target',
    `label ${label ? labelAt390.toFixed(2) : '?'}px at 390px`);
  ok(lensInset > 0 && lensHeight > 0 && lensHeight < dockHeight - 2 * edge
      && /top:calc\(\(var\(--nav-dock-height\) - var\(--nav-lens-height\)\) \/ 2\)/.test(lens)
      && /height:var\(--nav-lens-height\)/.test(lens)
      && Math.abs((dockHeight - lensHeight) / 2 - (edge + lensInset)) < 1e-9
      && /border-radius:calc\(var\(--nav-dock-height\) \/ 2\)/.test(dock)
      && /border-radius:calc\(var\(--nav-lens-height\) \/ 2\)/.test(lens),
    'the lens is inset from its slot on every side and its capsule corner is concentric with the dock capsule',
    `dock ${dockHeight}px, lens ${lensHeight}px, edge ${edge}px + inset ${lensInset}px`);
  ok(!/(^|[^-])border:/.test(lens)
      && /inset 0 1px 0 var\(--nav-glass-lens-rim\)/.test(lens)
      && /var\(--nav-glass-lens-shadow\)/.test(lens)
      && /--nav-glass-lens-fill:\s*linear-gradient\(180deg,\s*rgba\(255,255,255,\.\d+\),\s*rgba\(255,255,255,\.\d+\)\),\s*color-mix\([^;]*transparent\)/.test(glass),
    'the lens has no hard border: a translucent top-lit fill, a rim highlight and a soft lift shadow give it its edge');
  ok(/backdrop-filter:blur\(\d+px\)/.test(dock) && /-webkit-backdrop-filter:blur\(\d+px\)/.test(dock)
      && /--nav-glass-dock-fill:\s*color-mix\(in srgb, var\(--surface-1\) \d+%, transparent\)/.test(glass)
      && /border:0;/.test(dock) && /0 0 0 1px var\(--nav-glass-dock-ring\)/.test(dock),
    'the dock is one frosted, translucent surface with a hairline ring rather than a solid bordered bar');
  const darkTokens = ['--nav-glass-dock-fill', '--nav-glass-lens-fill', '--nav-glass-lens-rim'];
  const prefersDark = /@media \(prefers-color-scheme:dark\) \{\s*:root:where\(:not\(\[data-theme="light"\]\)\) \{([^}]*)\}/.exec(glass);
  const forcedDark = /:root\[data-theme="dark"\] \{([^}]*)\}/.exec(glass);
  ok(prefersDark && forcedDark
      && darkTokens.every(t => prefersDark[1].includes(t) && forcedDark[1].includes(t)),
    'dark glass tokens follow both the system scheme and the explicit theme toggle');
  ok(/--nav-icon-budget:url\("data:image\/svg\+xml[^\n]*M3\.5 10\.5 12 3\.5/.test(glass)
      && /--nav-icon-credit:url\("data:image\/svg\+xml[^\n]*rect x='2\.75' y='5\.5'/.test(glass),
    'Budget uses a home icon while Credit keeps a distinct credit-card icon');
  ok(/min-height:calc\(var\(--nav-dock-height\) - 2 \* var\(--nav-edge\)\)/.test(glassMobile)
      && dockHeight - 2 * edge >= 44,
    'tab targets fill the dock interior and stay at least 44px tall');
  const group = /::view-transition-group\(atlas-tab-indicator\)\s*\{([^}]*)\}/.exec(glass);
  const duration = group ? num(/animation-duration:\s*([\d.]+)s/, group[1]) : NaN;
  ok(group && duration > 0 && duration <= 0.5 && /animation-timing-function:\s*cubic-bezier/.test(group[1]),
    'the lens travels between tabs quickly with a deceleration curve', `${duration}s`);
  const reducedGlobal = /@media \(prefers-reduced-motion:reduce\) \{\s*@view-transition \{\s*navigation: none;\s*\}[\s\S]*?::view-transition-group\(atlas-tab-indicator\) \{\s*animation-duration:\.01ms;/.test(glass);
  const reducedMobile = /@media \(max-width:640px\) and \(prefers-reduced-motion:reduce\) \{[\s\S]*?\.sitenav-household a \{\s*transition:none;/.test(glass);
  ok(reducedGlobal && reducedMobile,
    'reduced motion turns off the cross-page glide and the in-dock press/colour motion');
  ok(/@supports not selector\(:has\(a\)\) \{\s*\.sitenav-household::before \{ content:none; \}/.test(glassMobile),
    'a browser without :has() shows the colour-only selected state rather than a lens stuck on Budget');
}

console.log('\n=== 14–17. No new dependency; Forecast and Credit content stay put ===');
{
  ok(!Object.keys(pkg.dependencies || {}).some(name =>
      /icon|fontawesome|lucide|heroicons|feather|bootstrap|react|vue|svelte|tailwind/i.test(name)),
    'package.json gained no icon library, UI kit, or frontend framework');
  ok(/--nav-icon-budget:url\("data:image\/svg\+xml/.test(css)
      && /--nav-icon-bills:url\("data:image\/svg\+xml/.test(css)
      && /--nav-icon-subscriptions:url\("data:image\/svg\+xml/.test(css)
      && /--nav-icon-credit:url\("data:image\/svg\+xml/.test(css)
      && /--nav-icon-planning:url\("data:image\/svg\+xml/.test(css)
      && /--nav-icon-plan-spend:url\("data:image\/svg\+xml/.test(css)
      && /data-nav="forecast"/.test(css)
      && /data-nav="plan-spend"/.test(css)
      && !/data-nav="talk"/.test(css),
    'the six icons remain inline SVG data URIs with no external icon dependency');
  ok(!/cdn\.|unpkg\.|jsdelivr|fontawesome|fonts\.google/.test(css + glass)
      && HOUSEHOLD_PAGES.every(([file]) => !/cdn\.|unpkg\.|jsdelivr/.test(read(file))),
    'household pages and styles load no external icon or UI host');
  const forecast = read('public/forecast.js');
  ok(/function paydayAllocation\(/.test(forecast) && /function recommend\(/.test(forecast)
      && /function creditAccounts\(/.test(forecast) && /function householdBills\(/.test(forecast)
      && /function householdSubscriptions\(/.test(forecast),
    'Forecast authorities still live in forecast.js; this suite does not rewrite them');
  const credit = read('public/credit.html');
  ok(/data-page-shell="credit"/.test(credit)
      && /<h1>Credit<\/h1>/.test(credit)
      && /id="credit-secured"/.test(credit)
      && /id="credit-cards"/.test(credit)
      && /class="credit-list credit-list-secured"/.test(credit)
      && /class="credit-list credit-list-cards"/.test(credit)
      && /Credit cards/.test(credit),
    'Credit keeps its incumbent financial content structure');
  ok(/\.credit-account \{/.test(css) && /top:0; left:0; right:0; height:3px/.test(css),
    'Credit card visual language (white surface, top rule) is still in styles.css');
  ok(/class="fact-card-list"/.test(read('public/bills.html'))
      && /class="fact-card-list"/.test(read('public/subscriptions.html'))
      && /\.fact-card, \.credit-account \{/.test(css),
    'Bills and Subscriptions keep the merged Credit-style fact-card implementation');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
