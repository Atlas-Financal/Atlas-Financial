'use strict';

// Assemble only the files the demo runtime can use. Install dependencies in
// the resulting directory before starting it. The destination must be new.
const fs = require('node:fs');
const path = require('node:path');
const {
  ASSET_FILES, FIXTURE_PATH, DIGESTS_REL, TEXT_ASSET, DEMO_SCRIPT_MARKER,
  loadApprovedAssets, verifyAsset,
} = require('./demo-server');
const privacy = require('./privacy-guard');
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
    '  const SEASPAN_CURRENT_ANNUAL = NaN;\n'
    + '  const SEASPAN_RAISE_LAST_EFFECTIVE = null, SEASPAN_RAISE_NEXT_EFFECTIVE = null;\n'
    + "  const SEASPAN_BONUS_LAST_DEPOSIT = '';\n"
    + '  const SEASPAN_OBSERVED_SALARY_REGIMES = [], SEASPAN_OBSERVED_BONUS_GROSS = {};\n'
    + "  const DALE_NET_MODELLED_THROUGH = '9999-12-30', DALE_PAYROLL_REGIME_FROM = '9999-12-31';\n\n");
  text = replaceRequired(text, /^  function seaspanEmployeePensionRate\(date\) \{[\s\S]*?^  \}/gm,
    '  function seaspanEmployeePensionRate() { return 0; }');
  text = replaceRequired(text, /^  function readPayrollPlanningAssumptions\(plan\) \{[\s\S]*?^  \}/gm,
    '  function readPayrollPlanningAssumptions() { return null; }');
  text = replaceRequired(text, /^  function isTennisIncomeAccount\(text\) \{[\s\S]*?^  \}/gm,
    '  function isTennisIncomeAccount() { return false; }');
  for (const [name, evidence] of [
    ['isConfirmedGroceryMerchant', 'tx?.confirmedGrocery === true'],
    ['isDaleGuiltFreeMerchant', 'tx?.daleGuiltFreeMerchant === true'],
    ['isConfirmedFuelMerchant', 'tx?.confirmedFuel === true || isOwnerConfirmedFuelTransaction(tx)'],
  ]) {
    const pattern = new RegExp(`^  function ${name}\\(tx\\) \\{[\\s\\S]*?^  \\}`, 'gm');
    text = replaceRequired(text, pattern, `  function ${name}(tx) { return ${evidence}; }`);
  }
  for (const name of ['FuelTransaction', 'SpotifyTransaction', 'NobleOccurrence']) {
    const matcher = new RegExp(`^  function isOwnerConfirmed${name}\\(tx\\) \\{[\\s\\S]*?^  \\}`, 'gm');
    const flag = name.replace(/Transaction$/, '');
    text = replaceRequired(text, matcher, `  function isOwnerConfirmed${name}(tx) { return tx?.ownerConfirmed${flag} === true; }`);
  }
  return text;
}

function demoScript(name, text, fixture) {
  const literal = new Uint8Array(text.length);
  const masked = mask(text, literal);
  let stripped = text.split('').map((char, i) => masked[i] === ' ' && !literal[i] ? ' ' : char).join('');
  if (name === 'forecast.js') stripped = demoForecast(stripped);
  if (name === 'plan.js') {
    stripped = replaceRequired(stripped, /^(\s*telecomUnrouted: r => )`[^`]*`,/gm,
      '$1`Telecommunications planned: ${money(r.planned)}`,');
    stripped = replaceRequired(stripped, /`TELUS IS CLOSED\.[^`]*`/g,
      '`This example uses the telecommunications amounts in the demo plan.`');
    stripped = replaceRequired(stripped, /^(function budgetBillDisplayLabel\(row\) \{\n)[\s\S]*?(^  return String\(row\.label)/gm,
      '$1$2');
  }
  // Exact dated browser policy literals can carry observed household events.
  // Allocate fresh dates in chronological order after the invented fixture's horizon.
  // Repeated dates stay equal and comparisons between those dates keep order.
  const datedPolicy = /\b20\d{2}-\d{2}-\d{2}\b/g;
  const days = [...new Set(stripped.match(datedPolicy))].sort();
  const oneDay = 24 * 60 * 60 * 1000;
  let next = Date.parse(fixture.data.meta.asOf) + fixture.data.plan.windowDays * oneDay;
  const originals = new Set(days);
  const dates = new Map();
  for (const day of days) {
    let invented;
    do {
      next += oneDay;
      invented = new Date(next).toISOString().slice(0, 10);
    } while (originals.has(invented));
    dates.set(day, invented);
  }
  stripped = stripped.replace(datedPolicy, day => dates.get(day));
  return DEMO_SCRIPT_MARKER + stripped.replace(/\bDale\b/gi, word => word === word.toLowerCase() ? 'demoPrimary' : 'Primary')
    .replace(/\bAmanda\b/gi, word => word === word.toLowerCase() ? 'demoPartner' : 'Partner')
    .replace(/\bTennis BC\b/gi, 'employer')
    .replace(/\bTennis Income\b/gi, 'Example secondary account')
    .replace(/\bSeaspan\b/gi, word => word === word.toLowerCase() ? 'demoEmployer' : 'Primary employer');
}

const assetFiles = ASSET_FILES;

function prepareAsset(name, bytes, fixture) {
  if (!TEXT_ASSET.test(name)) return bytes;
  let text = bytes.toString('utf8').replaceAll('\r\n', '\n');
  if (name.endsWith('.js')) text = demoScript(path.basename(name), text, fixture);
  if (name.endsWith('.css')) text = text.replace(/\/\*(?![!])[\s\S]*?\*\//g, '');
  if (name.endsWith('.html')) text = text.replace(/<!--[\s\S]*?-->/g, '');
  return Buffer.from(text);
}

function checkDemoPrivacy(name, body, fingerprints) {
  if (!TEXT_ASSET.test(name)) return;
  const hits = privacy.scanFiles({ files: [name], patterns: privacy.CONTENT_PATTERNS,
    readFile: () => body.toString('utf8'), fingerprints });
  if (hits.length) throw new Error(`Demo asset rejected by privacy guard: ${name}`);
}

function readSource(name, sourceRoot = root) {
  const source = path.join(sourceRoot, name);
  if (fs.realpathSync(source) !== source) throw new Error('Unexpected demo file location');
  return fs.readFileSync(source);
}

function packageDemo(destination, sourceRoot = root) {
  const resolvedRoot = fs.realpathSync(path.resolve(sourceRoot));
  const approved = loadApprovedAssets(path.join(resolvedRoot, DIGESTS_REL));
  const fixtureBytes = prepareAsset(FIXTURE_PATH, readSource(FIXTURE_PATH, resolvedRoot));
  checkDemoPrivacy(FIXTURE_PATH, fixtureBytes);
  verifyAsset(FIXTURE_PATH, fixtureBytes, approved);
  const fixture = JSON.parse(fixtureBytes);
  const assets = new Map([[FIXTURE_PATH, fixtureBytes]]);
  for (const name of assetFiles) {
    if (assets.has(name)) continue;
    const prepared = prepareAsset(name, readSource(name, resolvedRoot), fixture);
    checkDemoPrivacy(name, prepared);
    verifyAsset(name, prepared, approved);
    assets.set(name, prepared);
  }
  const files = [
    'server.js', 'package.json', 'package-lock.json', 'scripts/demo-server.js',
    ...assetFiles.map(name => `${DIGESTS_REL}/${name}.sha256`),
  ];
  fs.mkdirSync(destination);
  for (const name of files) {
    const source = path.join(resolvedRoot, name);
    if (fs.realpathSync(source) !== source) throw new Error('Unexpected demo file location');
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
  for (const [name, prepared] of assets) {
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, prepared, { flag: 'wx' });
  }
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/package-demo.js <new directory>');
  packageDemo(path.resolve(process.argv[2]));
}

module.exports = { packageDemo, assetFiles, prepareAsset, checkDemoPrivacy };
