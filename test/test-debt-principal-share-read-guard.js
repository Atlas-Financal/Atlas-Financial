'use strict';
/* Static guard: a debt's `principalShare` is read only through the one
 * dated-principal-share resolver, Forecast.debtPrincipalShareFor.
 *
 * Unlike the obligation guard, no binding is traced: `principalShare` is a
 * debt-split field only, so ANY member read (`x.principalShare`,
 * `x?.principalShare`, `x['principalShare']`) or destructuring
 * (`const { principalShare } = x`, `{ principalShare: s }`) in production
 * sources (public/*.js, scripts/*.js, server.js) outside the allow-listed
 * resolver fails. That covers direct, aliased and destructured reads.
 *
 * Known limits: a computed key built at run time (`x['principal' + 'Share']`)
 * or a whole-object spread is not detected. The published-path tests in
 * test-debt-principal-share-schedule.js are the behavioural proof.
 *
 * `node test/test-debt-principal-share-read-guard.js`
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const ALLOWED_FUNCTIONS = new Set(['debtPrincipalShareFor']);

function enclosingFunction(lines, index) {
  for (let i = index; i >= 0; i--) {
    const m = lines[i].match(/^\s*(?:async\s+)?function\s+(\w+)\s*\(/)
      || lines[i].match(/^\s*const\s+(\w+)\s*=\s*(?:\([^)]*\)|\w+)\s*=>/);
    if (m) return m[1];
  }
  return null;
}

const READ = /(?:\?\.|\.)\s*principalShare\b|\[\s*['"`]principalShare['"`]\s*\]/;
const DESTRUCTURE = /\{[^{}]*\bprincipalShare\b[^{}]*\}\s*=/;

function check(source, file) {
  const lines = source.split('\n');
  const findings = [];
  lines.forEach((raw, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(raw)) return;
    const text = raw.replace(/\/\/.*$/, '');
    if (!READ.test(text) && !DESTRUCTURE.test(text)) return;
    const fn = enclosingFunction(lines, i);
    if (ALLOWED_FUNCTIONS.has(fn)) return;
    findings.push({ file, line: i + 1, fn, text: raw.trim().slice(0, 140) });
  });
  return findings;
}

console.log('=== 1. the checker catches synthetic bypasses ===');
{
  const direct = `function a(debt) {\n  return amount * debt.principalShare;\n}`;
  ok(check(direct, 's.js').length === 1, 'direct read');
  const optional = `function b(debt) {\n  return debt?.principalShare;\n}`;
  ok(check(optional, 's.js').length === 1, 'optional-chain read');
  const destructured = `function c(debt) {\n  const { principalShare } = debt;\n  return principalShare;\n}`;
  ok(check(destructured, 's.js').length === 1, 'destructuring `const { principalShare } = debt`');
  const renamed = `function d(debt) {\n  const { rate, principalShare: s } = debt;\n  return s;\n}`;
  ok(check(renamed, 's.js').length === 1, 'renamed destructuring');
  const aliased = `function e(debts) {\n  const m = debts[0];\n  const row = m;\n  return row.principalShare;\n}`;
  ok(check(aliased, 's.js').length === 1, 'alias `const row = m; row.principalShare`');
  const computed = `function f(debt) {\n  return debt['principalShare'];\n}`;
  ok(check(computed, 's.js').length === 1, 'string-keyed read');
  const allowed = `function debtPrincipalShareFor(debt, date) {\n  return debt.principalShare;\n}`;
  ok(check(allowed, 's.js').length === 0, 'the resolver may read the regular field');
  const schedule = `function g(debt) {\n  return debt.principalShareSchedule;\n}`;
  ok(check(schedule, 's.js').length === 0, 'principalShareSchedule is not a share read');
  const comment = `function h(debt) {\n  // debt.principalShare is the regular split\n  return 0;\n}`;
  ok(check(comment, 's.js').length === 0, 'comments are ignored');
}

console.log('\n=== 2. production sources read principalShare only through the resolver ===');
{
  const root = path.join(__dirname, '..');
  const files = [].concat(
    fs.readdirSync(path.join(root, 'public')).filter(f => f.endsWith('.js')).map(f => 'public/' + f),
    fs.readdirSync(path.join(root, 'scripts')).filter(f => f.endsWith('.js')).map(f => 'scripts/' + f),
    ['server.js']);
  const findings = files.flatMap(file => check(fs.readFileSync(path.join(root, file), 'utf8'), file));
  ok(findings.length === 0, `no unrouted principalShare reads in ${files.length} files`,
    findings.map(f => `${f.file}:${f.line} (${f.fn}) ${f.text}`).join(' | '));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
