'use strict';
/* The shell privately captures bootstrap stderr and sends all stdout to the
 * independent record validator. No runner or capture module is loaded here. */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
// Hosted ubuntu-latest runners have 4 vCPUs.
const STANDARD_JOBS = 4;
const SIGNALS = ['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGHUP', 'SIGINT', 'SIGKILL',
  'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM'];
function main(group) {
  function finish(code, signal) {
    code = Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
    fs.writeSync(1, JSON.stringify({ type: 'ci-worker-outcome', identity: group,
      status: code === 0 ? 'pass' : 'fail', category: signal ? 'signal-terminated'
        : code === 0 ? 'none' : 'process-failed', exitCode: code,
      signal: SIGNALS.includes(signal) ? signal : null }) + '\n');
    if (SIGNALS.includes(signal) && process.platform !== 'win32') process.kill(process.pid, signal);
    else process.exitCode = code === null ? 1 : code;
  }
  try {
    if (!['standard', 'refresh-isolation', 'install-runtime'].includes(group) || !process.env.ATLAS_CI_BOOTSTRAP_DIR)
      throw new Error('invalid-configuration');
    const root = path.join(__dirname, '..');
    const args = group === 'install-runtime'
      ? [path.join(root, 'scripts/ci-output.js'), '--identity', 'install-runtime', '--', 'npm', 'ci', '--omit=dev']
      : [path.join(root, 'test/test.js'), '--group', group,
        // The standard group is hundreds of independent suites; the one-suite
        // refresh-isolation group has nothing to schedule. Records stay serial.
        ...(group === 'standard' ? ['--jobs', String(STANDARD_JOBS)] : [])];
    const child = spawn(process.execPath, args,
      { cwd: root, env: { ...process.env, ATLAS_PUBLIC_CI: '1' },
        stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    // close follows error and preserves the original process result once.
    child.on('error', () => {});
    child.on('close', finish);
  } catch { finish(1, null); }
}
if (require.main === module) main(process.argv[2]);
