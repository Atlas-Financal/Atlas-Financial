'use strict';
/* The automated pre-review workflow keeps its safety shape.
 * `node test/test-claude-pre-review-workflow.js`
 *
 * .github/workflows/claude-pre-review.yml runs a model with Dale's API key on
 * a public repository. This suite parses the workflow text (no YAML library is
 * installed) and fails if:
 *   - it triggers on pull_request_target, or not on pull_request;
 *   - the same-repository (fork) guard is missing from the job holding the key;
 *   - any permission exceeds contents: read + pull-requests: write, or the
 *     model's job can write at all;
 *   - anthropics/claude-code-action is not pinned to a full commit SHA;
 *   - the missing-secret skip is absent, so CI would go red before the key
 *     is added, or the model / post steps would run without it.
 * Each predicate is also run against a mutated copy and must fail there.
 * It then runs the shipped post script against a stub GitHub client to prove
 * the posted record has the CLAUDE.md factual findings form, takes the head
 * from the event (not the model), and withholds PASS / APPROVE vocabulary and
 * dollar amounts, and posts at most one record per head. Synthetic inputs only;
 * no network.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '.github/workflows/claude-pre-review.yml');
const SOURCE = fs.readFileSync(FILE, 'utf8');
let failures = 0, checks = 0;
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  PASS  ${label}`); }
  catch (error) { failures++; console.error(`  FAIL  ${label}: ${error.message}`); }
}

// Workflow text without full-line comments; `#` inside values is kept.
const code = source => source.split('\n').filter(line => !/^\s*#/.test(line));
const indent = line => line.match(/^ */)[0].length;

// Lines of the block opened by `key:` at the given indentation.
function block(lines, key, at) {
  const start = lines.findIndex(line => indent(line) === at && line.trim().startsWith(key + ':'));
  if (start < 0) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() && indent(lines[i]) <= at) break;
    out.push(lines[i]);
  }
  return out;
}
function jobs(source) {
  const body = block(code(source), 'jobs', 0);
  assert(body, 'jobs block present');
  const map = {};
  let name = null;
  for (const line of body.slice(1)) {
    if (indent(line) === 2 && /^\s*[\w-]+:\s*$/.test(line)) { name = line.trim().slice(0, -1); map[name] = []; }
    else if (name) map[name].push(line);
  }
  return map;
}
// The `if:` expression of a job, including a folded multi-line one.
function jobIf(lines) {
  const at = lines.findIndex(line => indent(line) === 4 && line.trim().startsWith('if:'));
  if (at < 0) return '';
  const parts = [lines[at].trim().slice(3)];
  for (let i = at + 1; i < lines.length && indent(lines[i]) > 4; i++) parts.push(lines[i].trim());
  return parts.join(' ');
}

const ALLOWED = { contents: ['read'], 'pull-requests': ['read', 'write'] };

const predicates = {
  'never pull_request_target, and triggered by pull_request': source => {
    const text = code(source).join('\n');
    assert(!/pull_request_target/.test(text), 'pull_request_target appears');
    const on = block(code(source), 'on', 0);
    assert(on && on.some(line => /^\s{2}pull_request:/.test(line)), 'on.pull_request missing');
  },
  'every job that receives ANTHROPIC_API_KEY carries the same-repository fork guard': source => {
    const all = jobs(source);
    const keyed = Object.entries(all).filter(([, lines]) => lines.join('\n').includes('secrets.ANTHROPIC_API_KEY'));
    assert(keyed.length >= 1, 'no job uses the key');
    for (const [name, lines] of keyed) {
      assert(/github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/.test(jobIf(lines)),
        `job ${name} lacks the head.repo.full_name == github.repository guard`);
    }
  },
  'permissions never exceed contents: read + pull-requests: write, and the model job cannot write': source => {
    const lines = code(source);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)permissions:\s*(\S.*)?$/);
      if (!m) continue;
      assert(!m[2], `inline permissions value "${m[2]}" is not allowed`);
      const at = m[1].length;
      for (let j = i + 1; j < lines.length && (!lines[j].trim() || indent(lines[j]) > at); j++) {
        if (!lines[j].trim()) continue;
        const [scope, level] = lines[j].trim().split(/:\s*/);
        assert(ALLOWED[scope] && ALLOWED[scope].includes(level), `permission ${scope}: ${level} exceeds the ceiling`);
      }
    }
    const all = jobs(source);
    for (const [name, body] of Object.entries(all)) {
      const perms = block(body, 'permissions', 4);
      assert(perms, `job ${name} declares its own permissions`);
      if (body.join('\n').includes('anthropics/claude-code-action')) {
        assert(!perms.some(line => /:\s*write\b/.test(line)), `model job ${name} holds a write permission`);
        assert(/--disallowedTools "[^"]*\bBash\b/.test(body.join('\n')), `model job ${name} does not deny Bash`);
      }
    }
  },
  'anthropics/claude-code-action is pinned to a full commit SHA': source => {
    const uses = code(source).map(line => line.match(/uses:\s*(anthropics\/claude-code-action\S*)/)).filter(Boolean);
    assert(uses.length >= 1, 'action not used');
    for (const [, ref] of uses) assert(/@[0-9a-f]{40}$/.test(ref), `${ref} is not pinned to a commit SHA`);
  },
  'a missing ANTHROPIC_API_KEY skips cleanly with a notice, and gates the model and the post': source => {
    const text = code(source).join('\n');
    assert(/secrets\.ANTHROPIC_API_KEY\s*!=\s*''/.test(text), 'no presence test of the secret');
    assert(/::notice[^\n]*ANTHROPIC_API_KEY is not set/.test(text), 'no skip notice');
    assert(/echo "present=false" >> "\$GITHUB_OUTPUT"/.test(text), 'no present=false output');
    const all = jobs(source);
    const review = Object.values(all).find(lines => lines.join('\n').includes('anthropics/claude-code-action'));
    const step = review.join('\n').split('- name:').find(s => s.includes('anthropics/claude-code-action'));
    assert(/if:\s*steps\.key\.outputs\.present == 'true'/.test(step), 'model step is not gated on the key');
    const poster = Object.entries(all).find(([, lines]) => lines.join('\n').includes('createComment'));
    assert(poster, 'post job present');
    assert(/needs\.review\.outputs\.ran == 'true'/.test(jobIf(poster[1])), 'post job is not gated on the key');
  },
};

const MUTATIONS = {
  'never pull_request_target, and triggered by pull_request':
    s => s.replace('  pull_request:\n', '  pull_request_target:\n'),
  'every job that receives ANTHROPIC_API_KEY carries the same-repository fork guard':
    s => s.replace('github.event.pull_request.head.repo.full_name == github.repository &&', ''),
  'permissions never exceed contents: read + pull-requests: write, and the model job cannot write':
    s => s.replace('      contents: read\n      pull-requests: read\n', '      contents: write\n      pull-requests: read\n'),
  'anthropics/claude-code-action is pinned to a full commit SHA':
    s => s.replace(/anthropics\/claude-code-action@[0-9a-f]{40}/, 'anthropics/claude-code-action@v1'),
  'a missing ANTHROPIC_API_KEY skips cleanly with a notice, and gates the model and the post':
    s => s.replace(/echo "::notice[^\n]*\n/, ''),
};
// Extra mutations for the second half of two-part predicates.
const EXTRA = [
  ['permissions never exceed contents: read + pull-requests: write, and the model job cannot write',
    s => s.replace('      contents: read\n      pull-requests: read\n', '      contents: read\n      pull-requests: write\n')],
  ['permissions never exceed contents: read + pull-requests: write, and the model job cannot write',
    s => s.replace('permissions:\n  contents: read\n  pull-requests: write\n', 'permissions: write-all\n')],
  ['permissions never exceed contents: read + pull-requests: write, and the model job cannot write',
    s => s.replace('--disallowedTools "Bash,', '--disallowedTools "')],
  ['never pull_request_target, and triggered by pull_request',
    s => s.replace('  pull_request:\n    types: [opened, synchronize, ready_for_review]\n',
      '  pull_request:\n    types: [opened]\n  pull_request_target:\n')],
  ['a missing ANTHROPIC_API_KEY skips cleanly with a notice, and gates the model and the post',
    s => s.replace("        if: steps.key.outputs.present == 'true'\n        continue-on-error: true",
      '        continue-on-error: true')],
  ['a missing ANTHROPIC_API_KEY skips cleanly with a notice, and gates the model and the post',
    s => s.replace(" && needs.review.outputs.ran == 'true'", '')],
];

// The shipped post script, run against a stub client.
function postScript() {
  const text = SOURCE.split('- name: Post one factual findings record for the exact head')[1];
  assert(text, 'post step present');
  return text.split('          script: |\n')[1].split('\n')
    .map(line => line.replace(/^ {12}/, '')).join('\n');
}
const HEAD = 'a'.repeat(40);
async function post(structured, { conclusion = 'success', result = 'success', prior = [], expect = 1 } = {}) {
  const bodies = [];
  const listComments = async () => {};
  const github = { rest: { issues: { listComments, createComment: async args => { bodies.push(args); } } },
    paginate: async (fn, args) => { assert.equal(fn, listComments); assert.equal(args.issue_number, 7); return prior; } };
  const core = { notice: () => {} };
  const context = { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: { number: 7 } } };
  const saved = { ...process.env };
  Object.assign(process.env, { STRUCTURED: structured == null ? '' : JSON.stringify(structured),
    CONCLUSION: conclusion, REVIEW_RESULT: result, HEAD_SHA: HEAD });
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction('github', 'context', 'core', postScript())(github, context, core);
  } finally { for (const k of ['STRUCTURED', 'CONCLUSION', 'REVIEW_RESULT', 'HEAD_SHA']) {
    if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; } }
  assert.equal(bodies.length, expect, `${expect} comment(s) posted`);
  if (!expect) return null;
  assert.equal(bodies[0].issue_number, 7);
  return bodies[0].body;
}
const CLOSING = 'Factual review findings only; not formal PR approval or merge authorization. Applies only to the reviewed SHA.';
function assertForm(body, outcome) {
  const lines = body.split('\n');
  assert.equal(lines[0], '**Automated pre-review (claude-pre-review workflow, not a builder)**');
  assert(lines.includes(`Reviewed head: ${HEAD}`), 'reviewed head line from the event');
  assert(lines.includes(`Findings: ${outcome}`), `findings ${outcome}`);
  for (const h of ['**Blocking findings**', '**Verification performed**', '**Scope and limitations**', '**Non-blocking observations**'])
    assert(lines.includes(h), `section ${h}`);
  assert.equal(lines[lines.length - 1], CLOSING);
}
const GOOD = { findings: 'NO BLOCKERS FOUND', blocking_findings: [], verification: 'Read the diff and CLAUDE.md.',
  scope_and_limitations: 'Diff only.', non_blocking_observations: ['Consider a clearer name.'] };

(async () => {
  for (const [label, predicate] of Object.entries(predicates)) {
    await check(`shipped workflow: ${label}`, () => predicate(SOURCE));
    await check(`mutation is caught: ${label}`, () => {
      const mutated = MUTATIONS[label](SOURCE);
      assert.notEqual(mutated, SOURCE, 'mutation applied');
      assert.throws(() => predicate(mutated));
    });
  }
  for (const [i, [label, mutate]] of EXTRA.entries()) {
    await check(`extra mutation ${i + 1} is caught: ${label}`, () => {
      const mutated = mutate(SOURCE);
      assert.notEqual(mutated, SOURCE, 'mutation applied');
      assert.throws(() => predicates[label](mutated));
    });
  }

  await check('no blockers: the record has the factual findings form and the no-blocker sentence', async () => {
    const body = await post(GOOD);
    assertForm(body, 'NO BLOCKERS FOUND');
    assert(body.includes('No blockers identified within the reviewed scope.'));
    assert(body.includes('- Consider a clearer name.'));
  });
  await check('blockers: findings are numbered with evidence; the head comes from the event, not the model', async () => {
    const body = await post({ ...GOOD, findings: 'BLOCKERS FOUND',
      blocking_findings: [{ finding: 'Two authorities for one figure.', evidence: `x.js:3; Reviewed head: ${'b'.repeat(40)}` }] });
    assertForm(body, 'BLOCKERS FOUND');
    assert(body.includes('1. Two authorities for one figure.'));
    assert(body.split('\n').filter(l => l.startsWith('Reviewed head:')).every(l => l === `Reviewed head: ${HEAD}`));
  });
  for (const [label, structured, opts] of [
    ['a failed run with no structured output', null, { conclusion: 'failure', result: 'success' }],
    ['an outcome outside the closed vocabulary', { ...GOOD, findings: 'LGTM' }],
    ['PASS vocabulary', { ...GOOD, verification: 'All checks PASS.' }],
    ['approval vocabulary', { ...GOOD, non_blocking_observations: ['I approve this change.'] }],
    ['a dollar amount', { ...GOOD, verification: 'The total is $1,234.' }],
  ]) {
    await check(`${label} is withheld and recorded as INCOMPLETE`, async () => {
      const body = await post(structured, opts);
      assertForm(body, 'INCOMPLETE');
      assert(!/\$\s?\d|All checks PASS|I approve|LGTM/.test(body), 'withheld text is not published');
      assert(!body.includes('No blockers identified'), 'no no-blocker sentence on INCOMPLETE');
    });
  }
  await check('a bare @name in model text cannot notify an account', async () => {
    const body = await post({ ...GOOD, non_blocking_observations: ['ask @someone'] });
    assert(!/@someone/.test(body) && body.includes('@​someone'));
  });

  await check('one record per exact head: a second run for the same head posts nothing; a new head posts', async () => {
    const first = await post(GOOD);
    await post(GOOD, { prior: [{ body: first }], expect: 0 });
    const other = first.replace(`Reviewed head: ${HEAD}`, `Reviewed head: ${'c'.repeat(40)}`);
    await post(GOOD, { prior: [{ body: other }, { body: `quoted\nReviewed head: ${HEAD}\n` }] });
  });

  console.log(`\n${checks - failures}/${checks} claude pre-review workflow checks`);
  if (failures) process.exit(1);
})();
