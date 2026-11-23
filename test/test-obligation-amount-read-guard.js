'use strict';
/* Static guard: an obligation row's `.amount` / `.cashPayment` is read only
 * through the dated-schedule resolver (desk ruling on dated obligation
 * amounts: one place resolves an occurrence's amount).
 *
 * The checker scans production sources (public/*.js, scripts/*.js,
 * server.js) for variables bound to a plan obligation row:
 *   - `x = ...obligations....find(...)`, `for (const x of ...obligations...)`,
 *     and the callback parameter of find/filter/some/every/map/forEach on
 *     `...obligations...`;
 *   - aliases of those (`const y = x`, `const y = x || ...`);
 * and flags, within a window after the binding, `x.amount` / `x?.amount` /
 * `x.cashPayment`, and destructuring (`const { amount } = x`). A flagged read
 * passes only inside an allow-listed resolver function or a listed, reasoned
 * exemption.
 *
 * Known limits (static detection is heuristic, not a proof): a row passed
 * into a function under a fresh parameter name is not traced across the
 * call; bindings are tracked by name inside a fixed line window, not by
 * real lexical scope; computed access (`x['amount']`) and spreads are not
 * detected. The published-path tests in test-obligation-amount-schedule.js
 * are the behavioural proof; this guard catches the common bypass shapes.
 *
 * `node test/test-obligation-amount-read-guard.js`
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const WINDOW = 60;
// Resolver functions allowed to read the regular fields.
const ALLOWED_FUNCTIONS = new Set([
  'obligationScheduledBase', 'capitalisingCashLegAmount', 'obligationMayBePositive',
  'obligationOccurrencePositive', 'capitalisingCashLegMayBePositive', 'obligationRegularAmountUnknown',
  'obligationAmountEvidenceUnavailable', 'obligationCycleAmount',
]);
// Reasoned exemptions: file + enclosing function.
const EXEMPT = [
  // Reconciles the authored regular `amount` against an authored data target:
  // the raw field itself is the subject, not an occurrence amount.
  { file: 'scripts/reconcile.js', fn: 'readCanonical', why: 'authored-field reconciliation' },
  // `cashPayment === undefined` is a schema-presence test that excludes
  // capitalising legs from payment-history candidates; it reads no amount.
  { file: 'scripts/provider-observe.js', fn: 'plainObligation', why: 'schema presence, no amount' },
];

function enclosingFunction(lines, index) {
  for (let i = index; i >= 0; i--) {
    const m = lines[i].match(/^\s*(?:async\s+)?function\s+(\w+)\s*\(/)
      || lines[i].match(/^\s*const\s+(\w+)\s*=\s*(?:\([^)]*\)|\w+)\s*=>/);
    if (m) return m[1];
  }
  return null;
}

function check(source, file) {
  const lines = source.split('\n');
  const findings = [];
  const bind = [];
  lines.forEach((text, i) => {
    if (/^\s*(\/\/|\*)/.test(text)) return;
    if (/obligations\b/.test(text)) {
      let m;
      // `obligations` as the iterated list itself: directly followed by the
      // array method (allowing `|| [])` and closing parens), never a member
      // of it (`alloc.obligations.items`) and never an assignment target.
      const LIST = 'obligations(?!\\s*=[^=])(?:\\s*\\|\\|\\s*\\[\\])?\\s*\\)*';
      const found = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=[^;]*\\b${LIST}\\.find\\(`).exec(text)
        || new RegExp(`^\\s*(\\w+)\\s*=[^;=]*\\b${LIST}\\.find\\(`).exec(text);
      if (found) bind.push({ name: found[1], line: i });
      const loop = new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+(\\w+)\\s+of\\s+[^)]*\\b${LIST}\\)\\s*\\{`).exec(text);
      if (loop) bind.push({ name: loop[1], line: i });
      const cb = new RegExp(`\\b${LIST}\\.(?:find|filter|some|every|map|forEach)\\(\\s*\\(?\\s*(\\w+)`, 'g');
      while ((m = cb.exec(text))) bind.push({ name: m[1], line: i });
    }
  });
  // Aliases, transitively, within the window of their source binding.
  for (let k = 0; k < bind.length; k++) {
    const { name, line } = bind[k];
    for (let j = line; j < Math.min(lines.length, line + WINDOW); j++) {
      const alias = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*${name}\\b\\s*(?:[;,)]|\\|\\||$)`).exec(lines[j]);
      if (alias && !bind.some(b => b.name === alias[1] && b.line === j)) bind.push({ name: alias[1], line: j });
    }
  }
  const seen = new Set();
  for (const { name, line } of bind) {
    const read = new RegExp(`\\b${name}\\??\\.(amount|cashPayment)\\b`);
    const destructure = new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${name}\\b`);
    const rebind = new RegExp(`(?:\\b${name}\\s*=>|\\((?:\\s*${name}\\s*)\\)\\s*=>|(?:const|let|var)\\s+${name}\\b)`);
    for (let j = line; j < Math.min(lines.length, line + WINDOW); j++) {
      if (/^\s*(\/\/|\*)/.test(lines[j])) continue;
      // A later re-binding of the same name (another callback or declaration
      // that is not itself an obligation binding) ends this binding's reach.
      if (j > line && rebind.test(lines[j]) && !bind.some(b => b.name === name && b.line === j)) break;
      const d = destructure.exec(lines[j]);
      const hit = read.test(lines[j]) || (d && /\b(amount|cashPayment)\b/.test(d[1]));
      if (!hit || seen.has(j)) continue;
      seen.add(j);
      const fn = enclosingFunction(lines, j);
      if (ALLOWED_FUNCTIONS.has(fn)) continue;
      if (EXEMPT.some(e => e.file === file && e.fn === fn)) continue;
      findings.push({ file, line: j + 1, fn, text: lines[j].trim().slice(0, 140) });
    }
  }
  return findings;
}

console.log('=== 1. the checker catches synthetic bypasses ===');
{
  const direct = `function a(plan) {\n  const row = plan.obligations.find(o => o.id === 'x');\n  return row.amount;\n}`;
  ok(check(direct, 'synthetic.js').length === 1, 'direct read through a found row');
  const destructured = `function b(plan) {\n  for (const o of plan.obligations || []) {\n    const { amount } = o;\n    use(amount);\n  }\n}`;
  ok(check(destructured, 'synthetic.js').length === 1, 'destructuring `const { amount } = o`');
  const aliased = `function c(plan) {\n  for (const o of plan.obligations) {\n    const row = o;\n    total += row.amount;\n  }\n}`;
  ok(check(aliased, 'synthetic.js').some(f => /row\.amount/.test(f.text)), 'alias `const row = o; row.amount`');
  const callback = `function d(plan) {\n  return (plan.obligations || []).some(item => Number(item.cashPayment) > 0);\n}`;
  ok(check(callback, 'synthetic.js').length === 1, 'callback parameter read of cashPayment');
  const optional = `function e(plan) {\n  const h = (plan.obligations || []).find(o => o.id === 'h');\n  return h?.amount;\n}`;
  ok(check(optional, 'synthetic.js').length === 1, 'optional-chain read');
  const allowed = `function obligationScheduledBase(o, d) {\n  for (const o of plan.obligations) return o.amount;\n}`;
  ok(check(allowed, 'synthetic.js').length === 0, 'an allow-listed resolver may read the regular field');
  const event = `function f(plan) {\n  const row = plan.obligations.find(o => o.id === 'x');\n  return occurrence.amount + e.amount;\n}`;
  ok(check(event, 'synthetic.js').length === 0, 'occurrence / event amounts are not row reads');
}

console.log('\n=== 2. production sources read obligation amounts only through the resolver ===');
{
  const root = path.join(__dirname, '..');
  const files = [].concat(
    fs.readdirSync(path.join(root, 'public')).filter(f => f.endsWith('.js')).map(f => 'public/' + f),
    fs.readdirSync(path.join(root, 'scripts')).filter(f => f.endsWith('.js')).map(f => 'scripts/' + f),
    ['server.js']);
  const findings = files.flatMap(file => check(fs.readFileSync(path.join(root, file), 'utf8'), file));
  ok(findings.length === 0, `no unrouted obligation .amount / .cashPayment reads in ${files.length} files`,
    findings.map(f => `${f.file}:${f.line} (${f.fn}) ${f.text}`).join(' | '));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
