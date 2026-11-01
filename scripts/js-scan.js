'use strict';
/* G1 (adopted design 6554987596 §8): the dependency-free JavaScript scanner,
 * shared by the page capture (scripts/figures-page-capture.js: masked loading
 * checks) and the source contract (test/lib/savings-consumer-contract.js).
 * Pinned as figures machinery.
 */
// ---- a dependency-free scanner: masks comments, strings, template text and
// regex literals so brace matching and identifier scans see code only. It
// throws on anything it cannot classify, so an unsupported file fails closed.
function mask(src, literal = null) {
  const out = src.split('');
  const n = src.length;
  const templates = [];
  let i = 0, depth = 0, prev = '';
  const blank = (a, b, isLiteral = true) => {
    for (let k = a; k < b; k++) { if (out[k] !== '\n') out[k] = ' '; if (literal && isLiteral) literal[k] = 1; }
  };
  const regexAllowed = () => /^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(prev)
    || /^(return|typeof|case|do|else|in|of|new|delete|void|throw|instanceof|yield|await)$/.test(prev);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end, false); i = end; continue; }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) throw new Error('scanner: unterminated comment at ' + i);
      blank(i, e + 2, false); i = e + 2; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') throw new Error('scanner: newline in string at ' + i); j++; }
      if (j >= n) throw new Error('scanner: unterminated string at ' + i);
      blank(i + 1, j); i = j + 1; prev = 'x'; continue;
    }
    if (c === '`' || (c === '}' && templates.length && templates[templates.length - 1] === depth)) {
      if (c === '}') templates.pop();
      let j = i + 1;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') break;
        j++;
      }
      if (j >= n) throw new Error('scanner: unterminated template at ' + i);
      blank(i + 1, j);
      if (src[j] === '`') { i = j + 1; prev = 'x'; continue; }
      templates.push(depth); i = j + 2; prev = '{'; continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, cls = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') throw new Error('scanner: newline in regex at ' + i);
        if (ch === '[') cls = true; else if (ch === ']') cls = false; else if (ch === '/' && !cls) break;
        j++;
      }
      blank(i + 1, j); j++;
      while (/[a-z]/i.test(src[j] || '')) j++;
      i = j; prev = 'x'; continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
        prev = src.slice(i, j); i = j; continue;
      }
      prev = c;
    }
    i++;
  }
  if (templates.length || depth !== 0) throw new Error('scanner: unbalanced braces or template');
  return out.join('');
}

module.exports = { mask };
