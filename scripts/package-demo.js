'use strict';

// Assemble only the files the demo runtime can use. Install dependencies in
// the resulting directory before starting it. The destination must be new.
const fs = require('node:fs');
const path = require('node:path');
const { ASSETS, FIXTURE, DEMO_SCRIPT_MARKER } = require('./demo-server');
const { mask } = require('./js-scan');
const root = path.join(__dirname, '..');

function replaceRequired(text, pattern, replacement) {
  const matches = text.match(pattern);
  if (!matches || matches.length !== 1) throw new Error('Demo asset source changed at a required redaction');
  return text.replace(pattern, replacement);
}

// The shared Forecast asset contains a small set of exact household facts as
// code literals, outside the packets. The demo uses the same Budget renderer
// and fixture-driven Forecast paths, with these household overrides removed.
function demoForecast(text) {
  text = replaceRequired(text, /^  const SEASPAN_CURRENT_ANNUAL\b[\s\S]*?(?=^  const CRA_2026_STATUTORY\b)/gm,
    block => {
      const boundaries = block.match(/^  const DALE_(?:NET_MODELLED_THROUGH|PAYROLL_REGIME_FROM) = '[0-9-]+';$/gm);
      if (boundaries?.length !== 2) throw new Error('Demo payroll boundaries changed');
      return '  const SEASPAN_CURRENT_ANNUAL = NaN;\n'
        + '  const SEASPAN_RAISE_LAST_EFFECTIVE = null, SEASPAN_RAISE_NEXT_EFFECTIVE = null;\n'
        + "  const SEASPAN_BONUS_LAST_DEPOSIT = '';\n"
        + '  const SEASPAN_OBSERVED_SALARY_REGIMES = [], SEASPAN_OBSERVED_BONUS_GROSS = {};\n'
        + boundaries.join('\n') + '\n\n';
    });
  text = replaceRequired(text, /^  function seaspanEmployeePensionRate\(date\) \{[\s\S]*?^  \}/gm,
    '  function seaspanEmployeePensionRate() { return 0; }');
  for (const name of ['FuelTransaction', 'SpotifyTransaction', 'NobleOccurrence']) {
    const matcher = new RegExp(`^  function isOwnerConfirmed${name}\\(tx\\) \\{[\\s\\S]*?^  \\}`, 'gm');
    const flag = name.replace(/Transaction$/, '');
    text = replaceRequired(text, matcher, `  function isOwnerConfirmed${name}(tx) { return tx?.ownerConfirmed${flag} === true; }`);
  }
  return text;
}

function demoScript(name, text) {
  const literal = new Uint8Array(text.length);
  const masked = mask(text, literal);
  let stripped = text.split('').map((char, i) => masked[i] === ' ' && !literal[i] ? ' ' : char).join('');
  if (name === 'forecast.js') stripped = demoForecast(stripped);
  if (name === 'plan.js') {
    stripped = replaceRequired(stripped, /`TELUS IS CLOSED\.[^`]*`/g,
      '`This example uses the telecommunications amounts in the demo plan.`');
  }
  return DEMO_SCRIPT_MARKER + stripped.replace(/\bDale\b/g, 'Primary')
    .replace(/\bAmanda\b/g, 'Partner').replace(/\bTennis BC\b/g, 'employer').replace(/\bSeaspan\b/g, 'Primary employer');
}

function packageDemo(destination) {
  fs.mkdirSync(destination);
  const files = [
    'server.js', 'package.json', 'package-lock.json', 'scripts/demo-server.js',
    path.relative(root, FIXTURE), 'public/index.html', ...ASSETS.map(name => 'public/' + name),
  ];
  for (const name of files) {
    const source = path.join(root, name);
    if (fs.realpathSync(source) !== source) throw new Error('Unexpected demo file location');
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (name.startsWith('public/') && name.endsWith('.js')) {
      const script = demoScript(path.basename(name), fs.readFileSync(source, 'utf8').replaceAll('\r\n', '\n'));
      fs.writeFileSync(target, script, { flag: 'wx' });
      continue;
    }
    if (name.endsWith('.css') || name === 'public/index.html') {
      const comments = name.endsWith('.css') ? /\/\*(?![!])[\s\S]*?\*\//g : /<!--[\s\S]*?-->/g;
      const markup = fs.readFileSync(source, 'utf8').replace(comments, '');
      fs.writeFileSync(target, markup, { flag: 'wx' });
      continue;
    }
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/package-demo.js <new directory>');
  packageDemo(path.resolve(process.argv[2]));
}

module.exports = { packageDemo };
