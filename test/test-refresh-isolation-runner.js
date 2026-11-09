'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { withMutatedFixture, timeoutForSuite, runSuite, isExpectedFailure, failureOutput } =
  require('./lib/refresh-isolation-runner');

let checks = 0;
function check(label, fn) {
  fn(); checks++;
  console.log(`  PASS  ${label}`);
}
const root = path.resolve(__dirname, '..');
function simulate(file, error, output = '  PASS  synthetic child\n') {
  let captured;
  let tick = 100;
  const result = runSuite(file, root, {
    now: () => { tick += 25; return tick; },
    execute(command, args, options) {
      captured = { command, args, options };
      if (error) throw error;
      return output;
    },
  });
  return { result, captured };
}

console.log('=== B92 child-process harness synthetic controls ===');
check('only the exact next-move, status-band and counterfactuals children receive 600 seconds', () => {
  for (const name of ['test-nextmove.js', 'test-status-band.js', 'test-counterfactuals.js']) {
    assert.strictEqual(timeoutForSuite(name), 600000);
  }
  for (const name of ['test-forecast.js', 'test-invariants.js', 'test-nextmove-copy.js', 'other/test-nextmove.js', 'other/test-status-band.js', 'test-counterfactuals-copy.js', 'toString', 'constructor']) {
    assert.strictEqual(timeoutForSuite(name), 180000);
  }
});
check('selected deadline, command and script reach the actual execution seam', () => {
  for (const [file, limit] of [['test-nextmove.js', 600000], ['test-invariants.js', 180000]]) {
    const { result, captured } = simulate(file);
    assert.strictEqual(captured.command, process.execPath);
    assert.deepStrictEqual(captured.args, [path.join(root, 'test', file)]);
    assert.deepStrictEqual(captured.options, { cwd: root, encoding: 'utf8', timeout: limit });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.elapsedMs, 25);
    assert.strictEqual(result.timeoutMs, limit);
  }
});
const timeout = simulate('test-invariants.js', {
  code: 'ETIMEDOUT', signal: 'SIGTERM', status: null,
  stdout: '  PASS  child reached page boot\n', stderr: 'partial boot diagnostic\n',
}).result;
check('timeout carries zero failed assertions and retains termination metadata', () => {
  assert.strictEqual(timeout.ok, false);
  assert.strictEqual(timeout.kind, 'timeout');
  assert.strictEqual(timeout.fails, 0);
  assert.strictEqual(timeout.code, 'ETIMEDOUT');
  assert.strictEqual(timeout.signal, 'SIGTERM');
  assert.strictEqual(timeout.status, null);
  assert.strictEqual(timeout.elapsedMs, 25);
});
check('timeout remains unexpected even for an allowed live-reconciliation suite', () => {
  assert.strictEqual(isExpectedFailure(timeout, ['test-invariants.js']), false);
});
check('timeout report contains reason, elapsed time and both output streams', () => {
  const report = failureOutput(timeout);
  for (const text of ['timeout', '0 assertion(s)', 'elapsed=25ms', 'limit=180000ms',
    'code=ETIMEDOUT', 'status=null', 'signal=SIGTERM', 'child reached page boot', 'partial boot diagnostic']) {
    assert(report.includes(text), text);
  }
  assert(!report.includes('1 assertion(s)'));
});
const assertion = simulate('test-invariants.js', {
  status: 1, signal: null, stdout: '  FAIL  synthetic conservation assertion\n',
  stderr: '  FAIL  synthetic second assertion\n',
}).result;
check('ordinary assertion failure retains real count and allowed reconciliation sensitivity', () => {
  assert.strictEqual(assertion.ok, false);
  assert.strictEqual(assertion.kind, 'assertion-failure');
  assert.strictEqual(assertion.fails, 2);
  assert.strictEqual(assertion.status, 1);
  assert.strictEqual(isExpectedFailure(assertion, ['test-invariants.js']), true);
  assert.strictEqual(isExpectedFailure(assertion, []), false);
  assert(failureOutput(assertion).includes('synthetic conservation assertion'));
});
check('a timed-out child with partial FAIL output cannot satisfy the allowed assertion gate', () => {
  const result = simulate('test-invariants.js', {
    code: 'ETIMEDOUT', signal: 'SIGTERM', status: null, stdout: '  FAIL  partial assertion\n',
  }).result;
  assert.strictEqual(result.kind, 'timeout');
  assert.strictEqual(result.fails, 1);
  assert.strictEqual(isExpectedFailure(result, ['test-invariants.js']), false);
});
check('signal and execution failures cannot masquerade as expected assertion failures', () => {
  for (const [error, kind] of [
    [{ signal: 'SIGKILL', status: null }, 'signal'],
    [{ status: 1, stderr: 'synthetic syntax error' }, 'execution-failure'],
    [{ code: 'ENOENT', status: null }, 'execution-failure'],
  ]) {
    const result = simulate('test-invariants.js', error).result;
    assert.strictEqual(result.kind, kind);
    assert.strictEqual(result.fails, 0);
    assert.strictEqual(isExpectedFailure(result, ['test-invariants.js']), false);
  }
});
console.log('=== B20 deliberate reconciliation rejection ===');
{
  const { snapshotFirstReading } = require('./lib/b20-snapshot-reconciliation');
  const data = { meta: { asOf: '2037-02-03' }, plan: { opening: { asOf: '2037-02-03' } }, debts: [{ id: 'mbna', balance: 600 }] };
  const positions = [{ account_label: 'Invented card', balance: '100.00', as_of: '2037-02-03' }];
  const map = { mappings: [{ accountLabel: 'Invented card', canonical: { collection: 'debts', id: 'mbna' } }] };
  const message = 'mbna: canonical 600 disagrees with positions.csv 100.00 on 2037-02-03\n';
  const rejection = { status: 1, signal: null, stdout: '', stderr: message };
  function probe(error, fixture = data, pos = positions, mappings = map) {
    let output = '', seen;
    try {
      snapshotFirstReading(() => { throw error; }, fixture, pos, mappings, (condition, label) => {
        assert.strictEqual(condition, false); output += '  FAIL  ' + label + '\n';
      });
    } catch (caught) { seen = caught; }
    assert.strictEqual(seen, error, 'the exact original error must still be thrown');
    const result = runSuite('test-b20-history.js', root, {
      now: () => 0,
      execute: () => { throw { ...error, stdout: output + (error.stdout || '') }; },
    });
    return { result, output, expected: isExpectedFailure(result, ['test-b20-history.js']) };
  }
  check('the exact known rejection emits one real FAIL then preserves the original rejection', () => {
    const result = probe(rejection);
    assert.strictEqual(result.result.kind, 'assertion-failure');
    assert.strictEqual(result.result.fails, 1);
    assert.strictEqual(result.expected, true);
  });
  check('clean command return and output are preserved without a new assertion', () => {
    let called = false;
    assert.strictEqual(snapshotFirstReading(() => 'written synthetic', data, positions, map, () => { called = true; }), 'written synthetic');
    assert.strictEqual(called, false);
  });
  for (const [label, error] of [
    ['arbitrary execution error', { ...rejection, stderr: 'synthetic syntax error\n' }],
    ['timeout', { ...rejection, code: 'ETIMEDOUT', signal: 'SIGTERM', status: null }],
    ['signal termination', { ...rejection, signal: 'SIGKILL', status: null }],
    ['buffer or other execution code', { ...rejection, code: 'ENOBUFS' }],
    ['wrong exit status', { ...rejection, status: 2 }],
    ['different account rejection', { ...rejection, stderr: message.replace('mbna:', 'other-card:') }],
    ['extra stderr output', { ...rejection, stderr: message + 'unrelated error\n' }],
    ['unexpected child stdout', { ...rejection, stdout: 'unexpected output\n' }],
  ]) check(label + ' remains an unexpected hard failure', () => {
    const result = probe(error);
    assert.strictEqual(result.output, '');
    assert.strictEqual(result.result.fails, 0);
    assert.strictEqual(result.expected, false);
  });
  check('a different mutation amount cannot use the known-control assertion', () => {
    const changed = structuredClone(data); changed.debts[0].balance = 601;
    const result = probe({ ...rejection, stderr: message.replace('canonical 600', 'canonical 601') }, changed);
    assert.strictEqual(result.expected, false); assert.strictEqual(result.output, '');
  });
  check('different date, mapping or duplicate reading cannot use the known-control assertion', () => {
    for (const [fixture, pos, mappings] of [
      [{ ...data, meta: { asOf: '2037-02-04' } }, positions, map],
      [data, positions, { mappings: [] }],
      [data, positions.concat(positions), map],
    ]) {
      const result = probe(rejection, fixture, pos, mappings);
      assert.strictEqual(result.expected, false); assert.strictEqual(result.output, '');
    }
  });
  check('limits stay 600 seconds for the three long-running children and 180 seconds for B20 and other suites', () => {
    assert.strictEqual(timeoutForSuite('test-nextmove.js'), 600000);
    assert.strictEqual(timeoutForSuite('test-b20-history.js'), 180000);
    assert.strictEqual(timeoutForSuite('test-invariants.js'), 180000);
  });
}
console.log('=== complete fixture lifecycle (synthetic repository, real children) ===');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-refresh-controls-'));
const source = path.join(sandbox, 'source');
fs.mkdirSync(source);
function write(relative, content) {
  const file = path.join(source, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function git(args, cwd = source) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
try {
  write('data.json', '{"number":10}\n');
  write('.gitignore', 'raw/\n.env\n');
  write('docs/provenance.txt', 'synthetic independent history\n');
  write('public/marker.js', 'module.exports = "committed source";\n');
  write('test/behavior.js', `
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
assert.strictEqual(require('../data.json').number, 17);
assert.strictEqual(require('../public/marker'), 'current edited source');
assert.strictEqual(fs.readFileSync(path.join(process.cwd(), 'docs/provenance.txt'), 'utf8'),
  'synthetic independent history\\n');
assert.strictEqual(JSON.parse(execFileSync('git', ['show', 'HEAD:data.json'], { encoding: 'utf8' })).number, 10);
console.log('  PASS  complete fixture, current source, relative requires, cwd and independent Git history');
`);
  write('test/reconciliation.js', `
const changed = require('../data.json').number !== 10;
console.log(changed ? '  FAIL  synthetic canonical reconciliation' : '  PASS  synthetic reconciliation');
process.exit(changed ? 1 : 0);
`);
  write('test/marker-reader.js', `
require('../public/marker.js');
console.log('  PASS  current tracked module loads');
`);
  git(['init', '--quiet']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic fixture baseline']);
  write('public/marker.js', 'module.exports = "current edited source";\n');
  write('raw/never-copy.txt', 'ignored local sentinel');
  write('.env', 'ignored local sentinel');
  const canonical = path.join(source, 'data.json');
  const original = fs.readFileSync(canonical);
  const originalMtime = fs.statSync(canonical, { bigint: true }).mtimeNs;
  const unchanged = () => {
    assert(fs.readFileSync(canonical).equals(original));
    assert.strictEqual(fs.statSync(canonical, { bigint: true }).mtimeNs, originalMtime);
  };
  check('clone and mutation setup failures remove their temporary fixtures', () => {
    const temp = path.join(sandbox, 'setup-temp');
    fs.mkdirSync(temp);
    const setup = `
const assert = require('assert');
const fs = require('fs');
const [runner, source, temp] = process.argv.slice(1);
const { withMutatedFixture } = require(runner);
const error = new Error('synthetic mutation failure');
assert.throws(() => withMutatedFixture(source, () => { throw error; }, () => {
  throw new Error('callback must not run');
}), caught => caught === error);
assert.deepStrictEqual(fs.readdirSync(temp), []);
assert.throws(() => withMutatedFixture(source + '-missing', () => {}, () => {}));
assert.deepStrictEqual(fs.readdirSync(temp), []);
`;
    execFileSync(process.execPath, ['-e', setup,
      path.join(__dirname, 'lib/refresh-isolation-runner.js'), source, temp], {
      encoding: 'utf8', stdio: 'pipe', timeout: 20000,
      env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp },
    });
    assert.deepStrictEqual(fs.readdirSync(temp), []);
    unchanged();
  });
  let fixture;
  check('real child suites receive the complete mutated fixture while canonical bytes never move', () => {
    const returned = withMutatedFixture(source, data => { data.number += 7; }, copy => {
      fixture = copy;
      unchanged();
      assert(!fs.existsSync(path.join(copy, 'raw')));
      assert(!fs.existsSync(path.join(copy, '.env')));
      assert.strictEqual(fs.readFileSync(path.join(copy, 'data.json'), 'utf8'), '{\n  "number": 17\n}\n');
      const behavior = runSuite('behavior.js', copy);
      assert.strictEqual(behavior.ok, true, behavior.out);
      const recon = runSuite('reconciliation.js', copy);
      assert.strictEqual(recon.fails, 1, recon.out);
      assert.strictEqual(isExpectedFailure(recon, ['reconciliation.js']), true);
      unchanged();
      return 'callback result';
    });
    assert.strictEqual(returned, 'callback result');
    assert(!fs.existsSync(fixture), 'normal completion removes the fixture');
    unchanged();
  });
  check('callback exceptions retain the exact error and remove the mutated fixture', () => {
    const error = new Error('synthetic callback failure');
    assert.throws(() => withMutatedFixture(source, data => { data.number = 99; }, copy => {
      fixture = copy;
      unchanged();
      throw error;
    }), caught => caught === error);
    assert(!fs.existsSync(fixture), 'exception cleanup removes the fixture');
    unchanged();
  });
  const sameIndex = copy => {
    assert.strictEqual(git(['ls-files', '--stage', '-z'], copy),
      git(['ls-files', '--stage', '-z']));
    assert.strictEqual(git(['diff', '--cached', '--raw', '-z'], copy),
      git(['diff', '--cached', '--raw', '-z']));
  };
  const sameMissingModule = copy => {
    const sourceRun = runSuite('marker-reader.js', source);
    const fixtureRun = runSuite('marker-reader.js', copy);
    for (const result of [sourceRun, fixtureRun]) {
      assert.strictEqual(result.kind, 'execution-failure', result.out);
      assert(result.out.includes('MODULE_NOT_FOUND'), result.out);
      assert.strictEqual(isExpectedFailure(result, ['marker-reader.js']), false);
    }
    assert(!fs.existsSync(path.join(copy, 'public/marker.js')));
    sameIndex(copy);
    unchanged();
  };
  check('unstaged tracked deletion stays absent and the real child still fails', () => {
    fs.unlinkSync(path.join(source, 'public/marker.js'));
    withMutatedFixture(source, () => {}, sameMissingModule);
    write('public/marker.js', 'module.exports = "current edited source";\n');
  });
  check('staged deletion cannot be resurrected from HEAD into a false green', () => {
    git(['rm', '--quiet', '--force', 'public/marker.js']);
    withMutatedFixture(source, () => {}, sameMissingModule);
    git(['reset', '--quiet', 'HEAD', '--', 'public/marker.js']);
    write('public/marker.js', 'module.exports = "current edited source";\n');
  });
  check('staged addition keeps index membership and staged bytes beneath current edits', () => {
    write('public/added.js', 'module.exports = "staged addition";\n');
    git(['add', 'public/added.js']);
    write('public/added.js', 'module.exports = "unstaged addition edit";\n');
    withMutatedFixture(source, () => {}, copy => {
      sameIndex(copy);
      assert(git(['ls-files', '-z'], copy).split('\0').includes('public/added.js'));
      assert.strictEqual(git(['show', ':public/added.js'], copy),
        'module.exports = "staged addition";\n');
      assert.strictEqual(require(path.join(copy, 'public/added.js')), 'unstaged addition edit');
      unchanged();
    });
  });
  check('staged rename keeps its new path and never restores the missing old module', () => {
    git(['mv', 'public/marker.js', 'public/renamed.js']);
    withMutatedFixture(source, () => {}, copy => {
      sameMissingModule(copy);
      assert(git(['ls-files', '-z'], copy).split('\0').includes('public/renamed.js'));
      assert.strictEqual(require(path.join(copy, 'public/renamed.js')), 'current edited source');
    });
  });
  check('mixed staged/unstaged edits preserve current files and the distinct staged view', () => {
    write('public/renamed.js', 'module.exports = "staged modification";\n');
    git(['add', 'public/renamed.js']);
    write('public/renamed.js', 'module.exports = "unstaged modification";\n');
    withMutatedFixture(source, () => {}, copy => {
      sameIndex(copy);
      assert.strictEqual(git(['show', ':public/renamed.js'], copy),
        'module.exports = "staged modification";\n');
      assert.strictEqual(require(path.join(copy, 'public/renamed.js')), 'unstaged modification');
      assert.strictEqual(require(path.join(copy, 'public/added.js')), 'unstaged addition edit');
      assert(!fs.existsSync(path.join(copy, 'public/marker.js')));
      unchanged();
    });
  });
  check('an index-only deletion preserves a physically present HEAD path without tracking it', () => {
    write('public/marker.js', 'module.exports = "physically present untracked HEAD path";\n');
    withMutatedFixture(source, () => {}, copy => {
      sameIndex(copy);
      assert(!git(['ls-files', '-z'], copy).split('\0').includes('public/marker.js'));
      assert.strictEqual(require(path.join(copy, 'public/marker.js')),
        'physically present untracked HEAD path');
      assert.strictEqual(runSuite('marker-reader.js', copy).ok, true);
      unchanged();
    });
  });
  check('split source index remains independent and preserves staged/current views', () => {
    git(['update-index', '--split-index']);
    assert(git(['rev-parse', '--shared-index-path']).trim());
    withMutatedFixture(source, () => {}, copy => {
      sameIndex(copy);
      assert.strictEqual(git(['show', ':public/added.js'], copy),
        'module.exports = "staged addition";\n');
      assert.strictEqual(require(path.join(copy, 'public/added.js')), 'unstaged addition edit');
      unchanged();
    });
  });
  check('abrupt termination cannot write canonical data; leftover copy is confined to the temporary directory', () => {
    const temp = path.join(sandbox, 'cancel-temp');
    fs.mkdirSync(temp);
    const cancel = `
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const [runner, source, temp] = process.argv.slice(1);
const canonical = path.join(source, 'data.json');
const before = fs.readFileSync(canonical);
const mtime = fs.statSync(canonical, { bigint: true }).mtimeNs;
const childCode = \`const fs = require('fs');
const [runner, source] = process.argv.slice(1);
require(runner).withMutatedFixture(source, d => { d.number = 777; }, fixture => {
  fs.writeSync(1, fixture + String.fromCharCode(10));
  while (true) {}
});\`;
const child = spawn(process.execPath, ['-e', childCode, runner, source], {
  env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let fixture;
let output = '';
const timer = setTimeout(() => { child.kill('SIGKILL'); }, 15000);
child.stdout.on('data', chunk => {
  output += chunk;
  if (fixture || !output.includes('\\n')) return;
  fixture = output.trim();
  assert.strictEqual(path.dirname(fixture), temp);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(fixture, 'data.json'))).number, 777);
  assert(fs.readFileSync(canonical).equals(before));
  assert.strictEqual(fs.statSync(canonical, { bigint: true }).mtimeNs, mtime);
  assert(child.kill('SIGKILL'));
});
child.once('close', (code, signal) => {
  clearTimeout(timer);
  assert(fixture, 'child must reach the active mutation before it is killed');
  assert(code !== 0 || signal, 'child must terminate abruptly');
  assert(fs.readFileSync(canonical).equals(before));
  assert.strictEqual(fs.statSync(canonical, { bigint: true }).mtimeNs, mtime);
  assert(fs.existsSync(fixture), 'forced kill may bypass fixture cleanup');
  fs.rmSync(fixture, { recursive: true, force: true });
  assert(!fs.existsSync(fixture), 'the test supervisor removes its leftover copy');
  console.log('cancelled safely; canonical bytes and mtime unchanged; supervisor cleanup passed');
});
`;
    const output = execFileSync(process.execPath, ['-e', cancel,
      path.join(__dirname, 'lib/refresh-isolation-runner.js'), source, temp],
    { encoding: 'utf8', timeout: 20000 });
    assert(output.includes('cancelled safely'), output);
    assert.deepStrictEqual(fs.readdirSync(temp), []);
    unchanged();
  });
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
console.log(`ALL ${checks} CHECKS PASSED (synthetic execution and real fixture children; no deadline wait)`);
