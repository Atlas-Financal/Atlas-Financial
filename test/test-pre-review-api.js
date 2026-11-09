'use strict';
/* Pure parts of scripts/pre-review-api.js. `node test/test-pre-review-api.js`
 * No network: the API call is replaced by a mocked fetch. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const m = require('../scripts/pre-review-api.js');

let failures = 0, checks = 0;
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  PASS  ${label}`); }
  catch (e) { failures++; console.error(`  FAIL  ${label}: ${e.message}`); }
}

(async () => {
  await check('diff pathspecs exclude data files and .env, and the range is base...head', () => {
    const args = m.diffArgs('b'.repeat(40), 'h'.repeat(40));
    assert.equal(args[1], `${'b'.repeat(40)}...${'h'.repeat(40)}`);
    for (const x of ['data.json', 'snapshots/**', 'raw/**', 'derived/**', '.env'])
      assert(args.includes(`:(exclude)${x}`), x);
  });

  await check('the pathspec really excludes excluded files in a scratch git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prapi-'));
    const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    for (const f of ['a.txt', 'data.json', '.env', 'snapshots/s.json', 'raw/r.csv', 'derived/d.json', 'sub/.env'])
      { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'SECRETVALUE\n'); }
    git('add', '-f', '.'); git('commit', '-qm', 'head');
    const out = git(...m.diffArgs(base, 'HEAD'));
    assert(out.includes('a.txt'));
    for (const f of ['data.json', '.env', 'snapshots/s.json', 'raw/r.csv', 'derived/d.json', 'sub/.env'])
      assert(!out.includes(`b/${f}`), `${f} leaked`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('truncation keeps short diffs and cuts long ones at the limit, flagged', () => {
    assert.deepEqual(m.truncateDiff('abc', 10), { text: 'abc', truncated: false, total: 3 });
    const t = m.truncateDiff('x'.repeat(25), 10);
    assert.equal(t.text.length, 10); assert(t.truncated); assert.equal(t.total, 25);
    assert.equal(m.MAX_DIFF_CHARS, 150000);
  });

  await check('contract sections are cut at the next heading of the same or higher level', () => {
    const md = '# T\n#### Bounded review protocol\nA\n##### sub\nB\n#### Factual findings record\nC\n#### Other\nD\n';
    const c = m.contractText(md);
    assert(c.includes('A') && c.includes('B') && c.includes('C') && !c.includes('D'));
    const real = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
    assert(m.contractText(real).includes('Findings: BLOCKERS FOUND | NO BLOCKERS FOUND | INCOMPLETE'));
  });

  await check('the request offers only the single schema tool', () => {
    const r = m.buildRequest('hi');
    assert.equal(r.model, 'claude-sonnet-5-5');
    assert.equal(r.tools.length, 1);
    assert.deepEqual(r.tool_choice, { type: 'auto' });
    assert.equal(r.tools[0].input_schema, m.SCHEMA);
    assert.deepEqual(m.SCHEMA.required, ['findings', 'blocking_findings', 'verification', 'scope_and_limitations', 'non_blocking_observations']);
  });

  await check('the prompt carries pr, head, base, diff and truncation note', () => {
    const p = m.buildPrompt({ pr: 9, head: 'H', base: 'B', files: 'M\tx', contract: 'C', diff: m.truncateDiff('d'.repeat(20), 5) });
    for (const t of ['#9', 'exact head H', '(base B)', 'truncated to the first 5 of 20', 'M\tx']) assert(p.includes(t), t);
  });

  await check('tool input is extracted from a response; none gives null', () => {
    const input = { findings: 'INCOMPLETE', blocking_findings: [], verification: 'v', scope_and_limitations: 's', non_blocking_observations: [] };
    assert.deepEqual(m.extractToolInput({ content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: m.TOOL_NAME, input }] }), input);
    assert.equal(m.extractToolInput({ content: [{ type: 'text', text: 'x' }] }), null);
    assert.equal(m.extractToolInput(null), null);
  });

  await check('error line carries only status, type and message', () => {
    const l = m.errorLine(400, { error: { type: 'invalid_request_error', message: 'Credit balance is too low' } });
    assert.equal(l, 'Anthropic API error: HTTP 400 invalid_request_error: Credit balance is too low');
    assert(m.errorLine(500, null).includes('HTTP 500'));
  });

  await check('GITHUB_OUTPUT heredoc form round-trips multiline JSON', () => {
    const o = m.formatOutput({ a: 'line1\nline2' }, 'DELIM');
    assert.equal(o, 'structured<<DELIM\n{"a":"line1\\nline2"}\nDELIM\n');
    assert.throws(() => m.formatOutput({ a: 'DELIM' }, 'DELIM'));
  });

  await check('main with a mocked fetch writes structured output; an API error exits 1 without leaking the key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prapi-'));
    const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
    git('init', '-q'); fs.writeFileSync(path.join(dir, 'a'), '1\n'); git('add', '.'); git('commit', '-qm', 'b');
    const base = git('rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(dir, 'a'), '2\n'); git('commit', '-qam', 'h');
    const head = git('rev-parse', 'HEAD').trim();
    const out = path.join(dir, 'out.txt');
    const env = { ANTHROPIC_API_KEY: 'sk-test-KEY', BASE_SHA: base, HEAD_SHA: head, PR_NUMBER: '3', GITHUB_OUTPUT: out };
    const cwd = process.cwd(), realFetch = global.fetch, realErr = console.error;
    const input = { findings: 'NO BLOCKERS FOUND', blocking_findings: [], verification: 'v', scope_and_limitations: 's', non_blocking_observations: [] };
    let seen; const logged = [];
    console.error = (...a) => logged.push(a.join(' '));
    try {
      process.chdir(dir);
      global.fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'tool_use', name: m.TOOL_NAME, input }] }) }; };
      assert.equal(await m.main(env), 0);
      assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
      assert.equal(seen.init.headers['x-api-key'], 'sk-test-KEY');
      assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');
      assert.equal(JSON.parse(seen.init.body).tools.length, 1);
      assert(/^structured<<(EOF_\w+)\n.*\n\1\n$/s.test(fs.readFileSync(out, 'utf8')));
      fs.writeFileSync(out, '');
      global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { type: 'invalid_request_error', message: 'Credit balance is too low' } }) });
      assert.equal(await m.main(env), 1);
      assert.equal(fs.readFileSync(out, 'utf8'), '');
      assert(logged.join('\n').includes('HTTP 400 invalid_request_error: Credit balance is too low'));
      assert(!logged.join('\n').includes('sk-test-KEY'));
    } finally { process.chdir(cwd); global.fetch = realFetch; console.error = realErr; fs.rmSync(dir, { recursive: true, force: true }); }
  });

  console.log(`\n${checks - failures}/${checks} pre-review API script checks`);
  if (failures) process.exit(1);
})();
