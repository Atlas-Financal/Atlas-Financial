'use strict';
// Static guard for the page-renderer escaping (external audit C2).
//
// The failure it catches: a covered renderer interpolates a data field
// straight into HTML, e.g. `<h2>${row.label}</h2>` or `data-bill-id="${row.id}"`.
// That is exactly the stored-XSS shape the audit found, and the release
// decision it changes is "may this renderer merge".
//
// The predicate is mechanical and deliberately narrow. Inside any template
// literal that builds HTML (its own text, or an enclosing template's text,
// contains "<"), every ${...} is split into the operands that can become its
// value: ternary branches (never the condition), and the operands of
// top-level ||, ??, && and +. A value operand that is a property read —
// `row.label`, `a.b.c`, `x[0].y`, or a method on one such as
// `row.label.toUpperCase()` — fails, unless it is wrapped in a call (for
// example escapeHtml(...) or money2(...)), is `.length`, or is a numeric
// `.toFixed(...)` / mapped `.join(...)`. Bare local names and calls pass:
// they are covered by the behavioural payload suite
// (test/test-page-renderer-escaping.js), which drives the real renderers.
// No prose is parsed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');

// The renderers index.html loads, plus the legacy pages that share the helper.
const COVERED = ['app', 'plan', 'balance-history', 'bill-detail', 'budget-blend', 'budget-card-movements',
  'budget-polish', 'budget-river', 'budget-sheet-motion', 'budget-surface', 'forecast-card-period',
  'forecast-chequing', 'household-view', 'savings-inventory', 'transaction-review', 'aurora',
  'bills', 'subscriptions', 'credit', 'records', 'deepdive'];

// Property reads that hold markup a renderer built on purpose (formatted
// money with trust marks, a nested section). Each is pinned to its exact
// count, so a new raw read of the same name still fails.
const DELIBERATE_MARKUP = {
  plan: {
    'figures.saved': 2, 'figures.needed': 2, 'figures.proposed': 2, // budgetSavingsMoney / budgetV3Money markup
    'state.label': 4, // budgetBrowseMoney markup in the Budget browse rows
    'entry.amount': 1, // budgetDailyNeededHtml
    'item.label': 1, // pay-period wheel items: escaped where each label is built
    'stillToFund.html': 1, 'summary?.appendix': 1, 'options.attrs': 1,
    'MAJOR_VERDICT[p.verdict](p)': 1, // fixed verdict wording; it escapes p.label itself
    'verdict.text(s, needed)': 1, // FUND_VERDICT: fixed wording around money() output
  },
  'savings-inventory': { 'members.html': 1 },
};

// Skip a quoted string or regex-free code until the matching close. Returns
// the index just past the closing quote.
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q) return j + 1;
    if (src[j] === '\n') throw new Error(`unterminated string at ${i}`);
  }
  throw new Error(`unterminated string at ${i}`);
}

// Parse a template literal starting at src[i] === '`'. Returns
// { end, quasis: [text...], exprs: [{ code, start }] }.
function parseTemplate(src, i) {
  const quasis = [];
  const exprs = [];
  let text = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { text += src.slice(j, j + 2); j += 2; continue; }
    if (c === '`') { quasis.push(text); return { end: j + 1, quasis, exprs }; }
    if (c === '$' && src[j + 1] === '{') {
      quasis.push(text); text = '';
      const start = j + 2;
      const end = skipExpression(src, start);
      exprs.push({ code: src.slice(start, end), start });
      j = end + 1;
      continue;
    }
    text += c; j++;
  }
  throw new Error(`unterminated template at ${i}`);
}

// Comments, quoted strings and regex literals hold no template literal.
// Return the index past one starting at src[i], or i when none starts there.
function skipNonCode(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); return nl < 0 ? src.length : nl; }
  if (c === '/' && src[i + 1] === '*') return src.indexOf('*/', i + 2) + 2;
  if (c === '"' || c === "'") return skipString(src, i);
  if (c === '/' && /(^|[=(,:!&|?{};[+\-*%<>~^]|\breturn)\s*$/.test(src.slice(Math.max(0, i - 20), i))) {
    // A regex literal: skip to its unescaped close.
    let j = i + 1, cls = false;
    for (; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
      else if (src[j] === '/' && !cls) break;
    }
    return j + 1;
  }
  return i;
}

// From inside ${, return the index of the matching }.
function skipExpression(src, i) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    const skipped = skipNonCode(src, i);
    if (skipped > i) { i = skipped; continue; }
    if (c === '`') { i = parseTemplate(src, i).end; continue; }
    if (c === '{') depth++;
    if (c === '}') { if (depth === 0) return i; depth--; }
    i++;
  }
  throw new Error('unterminated ${');
}

// Replace nested string and template literals with placeholders, returning
// the flattened code plus the nested templates for recursive checking.
function flatten(code) {
  let out = '';
  const nested = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'") { i = skipString(code, i); out += ' S '; continue; }
    if (c === '`') {
      const t = parseTemplate(code, i);
      nested.push(code.slice(i, t.end));
      i = t.end; out += ' T '; continue;
    }
    const skipped = skipNonCode(code, i);
    if (skipped > i) { i = skipped; out += ' R '; continue; }
    out += c; i++;
  }
  return { flat: out, nested };
}

// Split `s` at top-level occurrences of any operator in `ops`.
function splitTop(s, ops) {
  const parts = [];
  let depth = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0) {
      const op = ops.find(o => s.startsWith(o, i));
      if (op) { parts.push(s.slice(last, i)); i += op.length - 1; last = i + 1; }
    }
  }
  parts.push(s.slice(last));
  return parts;
}

// Value operands of an expression: ternary branches, then ||, ??, &&, +.
function valueOperands(expr) {
  const s = strip(expr);
  // Top-level ternary: find '?' not part of '?.' or '??'.
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && c === '?' && s[i + 1] !== '.' && s[i + 1] !== '?' && s[i - 1] !== '?') {
      // Matching ':' at the same depth, accounting for nested ternaries.
      let d = 0, nest = 0;
      for (let j = i + 1; j < s.length; j++) {
        const cj = s[j];
        if ('([{'.includes(cj)) d++;
        else if (')]}'.includes(cj)) d--;
        else if (d === 0 && cj === '?' && s[j + 1] !== '.' && s[j + 1] !== '?' && s[j - 1] !== '?') nest++;
        else if (d === 0 && cj === ':') {
          if (nest === 0) return valueOperands(s.slice(i + 1, j)).concat(valueOperands(s.slice(j + 1)));
          nest--;
        }
      }
      throw new Error(`unmatched ternary in ${s}`);
    }
  }
  const parts = splitTop(s, ['||', '??', '&&', '+']);
  if (parts.length > 1) return parts.flatMap(valueOperands);
  return [s];
}

const strip = s => {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0, wraps = true;
    for (let i = 0; i < t.length - 1; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') depth--;
      if (depth === 0) { wraps = false; break; }
    }
    if (!wraps) break;
    t = t.slice(1, -1).trim();
  }
  return t;
};

const COMPARISON = /(===|!==|==|!=|<=|>=|<|>)/;
function unsafeOperand(operand) {
  const t = strip(operand);
  if (t === '' || t === 'S' || t === 'T' || /^-?\d+(\.\d+)?$/.test(t)) return false;
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return false;                   // a bare local
  if (/^!/.test(t) || COMPARISON.test(t.replace(/=>/g, ''))) return false; // a boolean
  if (/^[A-Za-z_$][\w$]*\s*\(/.test(t) && t.endsWith(')')) return false; // a call: escapeHtml(...), money2(...), a builder
  if (/\.length$/.test(t)) return false;
  if (/\.toFixed\([^()]*\)$/.test(t)) return false;                  // numeric
  if (/\.join\(.*\)$/.test(t) && /\.map\(/.test(t)) return false;     // mapped markup, checked as nested templates
  if (/^[A-Za-z_$][\w$]*\.join\([^()]*\)$/.test(t)) return false;   // a local array of built markup
  if (/^[A-Z][\w$]*\.[\w$]+\(.*\)$/.test(t)) return false;           // Math.min(...), Forecast.x(...), SavingsInventory.html(...)
  if (/^Array\.from\([\s\S]*\)\.join\([^()]*\)$/.test(t)) return false; // built markup
  if (/^[A-Za-z_$][\w$]*\.[\w$]*(Html|html)\(.*\)$/.test(t)) return false; // a markup builder method
  if (/^[A-Za-z_$][\w$]*\s*(\.|\[|\?\.)/.test(t)) return true;        // a property read, or a method on one
  return false;
}

function check(src, file) {
  const violations = [];
  const visitTemplate = (code, offset, htmlContext) => {
    const t = parseTemplate(code, 0);
    const html = htmlContext || t.quasis.some(q => q.includes('<'));
    for (const e of t.exprs) {
      const { flat, nested } = flatten(e.code);
      if (html) {
        for (const op of valueOperands(flat)) {
          if (unsafeOperand(op)) {
            const line = src.slice(0, offset + e.start).split('\n').length;
            violations.push(`${file}:${line} \${${e.code.trim().slice(0, 80)}} → ${strip(op)}`);
          }
        }
      }
      // Nested templates: re-locate each in the original code for line numbers.
      let from = 0;
      for (const n of nested) {
        const at = e.code.indexOf(n, from);
        from = at + n.length;
        // Text built as the argument of an escape call is escaped there.
        const escaped = /\b(escapeHtml|escape|[A-Za-z0-9_$]*Escape)\([^()]*$/.test(e.code.slice(0, at));
        visitTemplate(n, offset + e.start + at, html && !escaped);
      }
    }
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const skipped = skipNonCode(src, i);
    if (skipped > i) { i = skipped; continue; }
    if (c === '`') {
      const t = parseTemplate(src, i);
      visitTemplate(src.slice(i, t.end), i, false);
      i = t.end; continue;
    }
    i++;
  }
  return violations;
}

for (const name of COVERED) {
  test(`${name}.js interpolates no unescaped data field into HTML`, () => {
    const file = `public/${name}.js`;
    const allowed = Object.assign({}, DELIBERATE_MARKUP[name] || {});
    const violations = check(fs.readFileSync(path.join(root, file), 'utf8'), file).filter(v => {
      const op = v.slice(v.lastIndexOf('→ ') + 2);
      if (allowed[op] > 0) { allowed[op]--; return false; }
      return true;
    });
    assert.deepEqual(violations, []);
    const unused = Object.entries(allowed).filter(([, n]) => n > 0);
    assert.deepEqual(unused, [], `${file}: a deliberate-markup entry no longer matches; remove it`);
  });
}

// The predicate itself, on the mechanical defect and its safe forms.
test('the predicate fails a raw property read and passes the escaped and formatted forms', () => {
  const bad = [
    'const h = `<h2>${row.label}</h2>`;',
    'const h = `<article data-bill-id="${row.id}">`;',
    "const h = `<td>${u.note || 'Settled'}</td>`;",
    "const h = `<td>${x ? '' : y.label}</td>`;",
    'const h = `<b>${value.label.toUpperCase()}</b>`;',
    "const h = `<p>${a ? `<i>${b.what}</i>` : ''}</p>`;",
    "const h = `<p>${'x' + c.label}</p>`;",
    'const h = `<p>${rows[0].label}</p>`;',
  ];
  for (const src of bad) assert.equal(check(src, 't').length, 1, src);
  const good = [
    'const h = `<h2>${escapeHtml(row.label)}</h2>`;',
    'const h = `<b>${money2(row.amount)}</b>`;',
    "const h = `<td class=\"${x.rate >= 20 ? 'neg' : ''}\">${x.rate == null ? '—' : pct(x.rate)}</td>`;",
    'const h = `<td>${r.eff.toFixed(2)}%</td>`;',
    "const h = `<ul>${rows.map(r => `<li>${escapeHtml(r.label)}</li>`).join('')}</ul>`;",
    'const h = `<p>${rows.length} rows</p>`;',
    'const h = `<p>${escapeHtml(a.label || `${b.start} – ${b.end}`)}</p>`;',
    'const h = `<p>${headingTag}</p>`;',
    'const t = `${row.label} is plain text, escaped at its sink`;',
  ];
  for (const src of good) assert.deepEqual(check(src, 't'), [], src);
});
