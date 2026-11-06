'use strict';
// Explicit local operator interface. No live GETs, credentials or activation.
const fs = require('node:fs');
const History = require('./private-period-history');

function run(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--enable-private-history') options.enabled = true;
    else if (['--destination', '--input', '--revision'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
      options[args[i].slice(2)] = args[++i];
    } else throw new Error('history-cli-arguments-invalid');
  }
  if (command === 'capture' && options.input && !options.revision) {
    const candidate = History.capture(JSON.parse(fs.readFileSync(options.input, 'utf8')));
    return options.enabled
      ? History.append({ destination: options.destination, enabled: true, candidate })
      : { status: 'disabled-preview', ...History.metadata(candidate) };
  }
  if (command === 'capture-closing' && options.input && !options.revision) {
    const parsed = JSON.parse(fs.readFileSync(options.input, 'utf8'));
    return options.enabled
      ? History.appendClosing({ destination: options.destination, enabled: true, input: parsed })
      : { status: 'disabled-preview', ...History.metadata(History.captureClosing(parsed)) };
  }
  if (command === 'list' && !options.input && !options.enabled && !options.revision) return History.read(options);
  if (command === 'inspect' && options.revision && !options.input && !options.enabled) {
    return History.metadata(History.read({ destination: options.destination, revisionId: options.revision }));
  }
  throw new Error('history-cli-arguments-invalid');
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(run(process.argv.slice(2))) + '\n'); }
  catch (e) {
    const code = /^history-[a-z-]+$/.test(e.code || e.message) ? (e.code || e.message) : 'history-cli-failed';
    process.stderr.write(code + '\n'); process.exitCode = 1;
  }
}
module.exports = { run };
