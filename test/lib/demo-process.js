'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { packageDemo } = require('../../scripts/package-demo');

const root = path.join(__dirname, '..', '..');

function launch(env, preloadArgs = [], directory = root) {
  const child = spawn(process.execPath, [...preloadArgs, path.join(directory, 'server.js')], {
    cwd: directory, env: { PORT: '0', ...env }, windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', () => {
      const port = output.match(/listening on (\d+)/)?.[1];
      if (port) resolve(`http://127.0.0.1:${port}`);
    });
    closed.then(({ code }) => reject(new Error(`Server exited before listening (${code}): ${output}`)), reject);
  });
  // Refusal tests wait on closed instead of ready.
  ready.catch(() => {});
  return {
    ready, closed,
    get output() { return output; },
    async stop() { child.kill(); await closed; },
  };
}

function demoPackage() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-demo-proof-'));
  const directory = path.join(temporary, 'demo');
  const clean = () => fs.rmSync(temporary, { recursive: true, force: true });
  try {
    packageDemo(directory);
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
    return { directory, clean };
  } catch (error) {
    clean();
    throw error;
  }
}

module.exports = { launch, demoPackage };
