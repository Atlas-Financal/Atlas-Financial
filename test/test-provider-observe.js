'use strict';
/* Read-only Lunch Money observation spike. Independent of Forecast.recommend.
 * Does not write data.json. Does not treat available credit or HELOC as cash.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const O = require('../scripts/provider-observe.js');
const R = require('../scripts/reconcile.js');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'lunchmoney-sample.json');
const MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'provider-account-map.json');
const LIVE_MAP = path.join(ROOT, 'docs', 'connectivity', 'provider-account-map.json');
const DATA = path.join(ROOT, 'data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const clone = x => JSON.parse(JSON.stringify(x));

const payload = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const accountMap = JSON.parse(fs.readFileSync(MAP, 'utf8'));
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));

console.log('=== A. fixture import is read-only ===');
{
  const before = hashFile(DATA);
  const report = O.observe({ provider: 'lunchmoney', payload, accountMap, data });
  ok(report.writesCanonicalState === false, 'observe report declares no canonical write');
  ok(report.reconciliation && report.reconciliation.writesCanonicalState === false,
    'B91 reconcile also declares no canonical write');
  ok(hashFile(DATA) === before, 'data.json bytes are unchanged after observe()');
}

console.log('=== B. CLI fixture run does not modify data.json ===');
{
  const before = hashFile(DATA);
  const out = execFileSync(process.execPath, [
    path.join(ROOT, 'scripts', 'provider-observe.js'),
    '--provider', 'lunchmoney',
    '--fixture', FIXTURE,
  ], { cwd: ROOT, encoding: 'utf8' });
  const parsed = JSON.parse(out);
  ok(parsed.writesCanonicalState === false, 'CLI JSON says writesCanonicalState false');
  ok(hashFile(DATA) === before, 'CLI run leaves data.json untouched');
}

console.log('=== C. stable provider account ID maps to one Atlas ID ===');
{
  const report = O.observe({ provider: 'lunchmoney', payload, accountMap, data });
  const cheq = report.mapped.filter(m => m.providerAccountId === '1001');
  ok(cheq.length === 1 && cheq[0].atlasId === 'chequing-a',
    'provider 1001 maps only to chequing-a', JSON.stringify(cheq));
}

console.log('=== D. unknown provider account stays unmapped ===');
{
  const report = O.observe({ provider: 'lunchmoney', payload, accountMap, data });
  const mystery = report.unmapped.find(u => u.providerAccountId === '9999');
  ok(!!mystery && mystery.reason === 'unmapped-provider-account',
    'Mystery Account is unmapped, not auto-created');
  ok(!report.mapped.some(m => m.providerAccountId === '9999'),
    'unmapped id is absent from mapped list');
  ok(!report.observations.some(o => o.providerAccountId === '9999'),
    'unmapped account produces no reconciliation observation');
}

console.log('=== E. display-name change does not create a second Atlas account ===');
{
  const renamed = clone(payload);
  renamed.accounts = renamed.accounts.map(a => (
    a.id === 1001 ? Object.assign({}, a, { name: 'Household Chequing Renamed' }) : a
  ));
  const report = O.observe({ provider: 'lunchmoney', payload: renamed, accountMap, data });
  const hits = report.mapped.filter(m => m.atlasId === 'chequing-a');
  ok(hits.length === 1 && hits[0].providerAccountId === '1001',
    'renamed 1001 still maps to one chequing-a');
  ok(hits[0].displayName === 'Household Chequing Renamed',
    'new display name is preserved as a label');
}

console.log('=== F. balance observation keeps the provider timestamp ===');
{
  const report = O.observe({ provider: 'lunchmoney', payload, accountMap, data });
  const cash = report.observations.find(o => o.observationId === 'lm-1001-cash');
  ok(cash && cash.observedAsOf === '2026-08-16',
    'cash observation date is the semantic balance_last_update day (fixture carries both)', cash && cash.observedAsOf);
  ok(report.fetchedAt === payload.fetchedAt, 'payload fetchedAt is preserved');
}

console.log('=== F2. posted-balance evidence prefers balance_as_of over updated_at ===');
{
  const acc = O.normalizeLunchMoneyAccount({
    id: 4110,
    name: 'Triangle Fixture',
    type: 'credit',
    subtype: 'credit_card',
    balance: 13495.32,
    credit_limit: 13500,
    updated_at: '2026-08-16T20:44:19.898Z',
    balance_as_of: '2026-08-19T03:25:33.904Z',
  });
  ok(acc.updatedAt === '2026-08-16T20:44:19.898Z'
    && acc.balanceAsOf === '2026-08-19T03:25:33.904Z'
    && acc.dateLastFetched == null,
    'distinct provider timestamps are preserved, not collapsed');
  ok(!Object.prototype.hasOwnProperty.call(acc, 'providerUpdatedAt'),
    'normalized account does not expose a collapsed providerUpdatedAt');
  ok(O.postedBalanceEvidenceInstant(acc) === '2026-08-19T03:25:33.904Z',
    'posted-balance instant is balance_as_of, not updated_at');
  const mapping = {
    atlasRole: 'revolving-credit',
    canonical: { collection: 'debts', id: 'triangle' },
    providerAccountId: '4110',
  };
  const obs = O.observationsFromMappedAccount(acc, mapping, '2026-08-19T04:00:00.000Z');
  const posted = obs.find(o => o.fact === 'posted-balance');
  ok(posted && posted.evidenceDate === '2026-08-18' && posted.observedAsOf === '2026-08-18',
    'posted observation is dated 2026-08-18 from balance_as_of, not 2026-08-16',
    posted && posted.evidenceDate);
  const cashAcc = O.normalizeLunchMoneyAccount({
    id: 4101,
    name: 'Chequing Fixture',
    type: 'cash',
    balance: 997.71,
    updated_at: '2026-08-16T20:00:00.000Z',
    balance_as_of: '2026-08-19T03:25:33.904Z',
  });
  ok(O.cashBalanceEvidenceInstant(cashAcc) === '2026-08-19T03:25:33.904Z', 'live cash dates from balance_as_of, never updated_at');
  ok(O.genericAccountEvidenceInstant(cashAcc) === '2026-08-16T20:00:00.000Z',
    'the generic helper (mortgage/HELOC) still dates from updated_at; live cash uses cashBalanceEvidenceInstant (N1)');
}

console.log('=== G. pending stays distinct from posted ===');
{
  const report = O.observe({ provider: 'lunchmoney', payload, accountMap, data });
  const pending = report.transactions.filter(t => t.providerTransactionId === '88002' && t.pending);
  const posted = report.transactions.filter(t => t.providerTransactionId === '88002' && !t.pending);
  ok(pending.length === 1 && posted.length === 1,
    'same provider tx id can appear pending and posted without inventing a second id');
  ok(pending[0].payee !== posted[0].payee,
    'description change does not mint a new provider transaction id');
}

console.log('=== H. available credit is never household cash ===');
{
  const report = O.observe({ provider: 'lunchmoney', payload, accountMap, data });
  ok(report.cardCapacityIsCash === 0, 'householdCashFromCardCapacity is 0');
  ok(R.householdCashFromCardCapacity() === 0, 'reconciler helper independently returns 0');
  const avail = report.observations.find(o => o.fact === 'available-credit');
  ok(avail && avail.evidenceValue === 3200.5, 'available credit is observed as its own fact');
  ok(report.spendableCash === 79.84,
    'spendable cash is only mapped cash balances, not 79.84+3200.50',
    String(report.spendableCash));
}

console.log('=== I. HELOC / mortgage balances are not spendable cash ===');
{
  const report = O.observe({ provider: 'lunchmoney', payload, accountMap, data });
  const heloc = report.mapped.find(m => m.providerAccountId === '2002');
  const mort = report.mapped.find(m => m.providerAccountId === '2003');
  ok(heloc && heloc.collection === 'debts' && heloc.atlasRole === 'heloc',
    'HELOC maps to debts/heloc');
  ok(mort && mort.collection === 'debts' && mort.atlasRole === 'mortgage',
    'mortgage maps to debts/mortgage');
  ok(report.spendableCash === 79.84,
    'HELOC 201586.16 and mortgage 412000 are excluded from spendable cash');
}

console.log('=== J. observations feed existing reconcile, not a second engine ===');
{
  const report = O.observe({ provider: 'lunchmoney', payload, accountMap, data });
  const cashRow = report.reconciliation.rows.find(r => r.observationId === 'lm-1001-cash');
  const cardRow = report.reconciliation.rows.find(r => r.observationId === 'lm-2001-debt');
  const helocRow = report.reconciliation.rows.find(r => r.observationId === 'lm-2002-debt');
  ok(cashRow && cashRow.canonicalTarget === 'cash:chequing-a',
    'cash uses B91 cash locator, not the card posted-balance path',
    cashRow && cashRow.canonicalTarget);
  ok(cashRow && cashRow.status === 'CHANGE',
    'fixture 79.84 vs live Chequing A is CHANGE, not a silent rewrite',
    cashRow && cashRow.status);
  ok(cardRow && cardRow.fact === 'posted-balance' && cardRow.cardId === 'tdcc',
    'revolving card posted balance stays on the existing card compare');
  ok(helocRow && helocRow.canonicalTarget === 'debts:heloc' && !helocRow.cardId,
    'HELOC balance compares as a debt, not as spendable cash');
  ok(typeof R.reconcile === 'function', 'the only compare authority is scripts/reconcile.js');
}

console.log('=== K. missing API secret fails closed and is not printed ===');
{
  let threw = false;
  let message = '';
  try {
    execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'provider-observe.js'),
      '--provider', 'lunchmoney',
      '--live',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        LUNCHMONEY_ACCESS_TOKEN: '',
        ATLAS_LUNCHMONEY_CREDENTIAL_FILE: path.join(os.tmpdir(), 'atlas-missing-lunchmoney.dat'),
      }),
    });
  } catch (e) {
    threw = true;
    message = String(e.stderr || e.stdout || e.message || '');
  }
  ok(threw, '--live without a token exits non-zero');
  ok(/LUNCHMONEY_ACCESS_TOKEN is not set/.test(message),
    'error names the env var without inventing a token');
  if (process.platform === 'win32') {
    ok(/local credential bootstrap has not been completed/.test(message),
      'Windows missing store fails closed on bootstrap');
  } else {
    ok(/Windows local credential fallback is not available/.test(message),
      'non-Windows does not emulate DPAPI');
  }
  ok(!/Bearer\s+\S+/.test(message), 'failure text does not contain a bearer token');
}

console.log('=== L. live transaction request includes pending ===');
{
  const url = O.lunchMoneyTransactionsUrl('2026-08-16T18:00:00.000Z');
  ok(url.pathname === '/v2/transactions', 'live request targets GET /v2/transactions');
  ok(url.searchParams.get('include_pending') === 'true',
    'live transactions URL sets include_pending=true', url.search);
  ok(url.searchParams.get('include_metadata') === 'true',
    'live transactions URL sets include_metadata=true', url.search);
  const boundary = O.lunchMoneyTransactionsUrl('2026-08-19T01:06:40.929Z');
  ok(boundary.searchParams.get('end_date') === '2026-08-18',
    'history window end is the household date, not the UTC date prefix',
    boundary.searchParams.get('end_date'));

  const harness = [
    "'use strict';",
    "const https = require('https');",
    "const { EventEmitter } = require('events');",
    'const seen = [];',
    'https.request = (url, options, cb) => {',
    "  seen.push(url && url.href ? url.href : String(url));",
    '  const req = new EventEmitter();',
    '  req.end = () => {',
    '    process.nextTick(() => {',
    '      const res = new EventEmitter();',
    '      res.statusCode = 200;',
    '      cb(res);',
    "      res.emit('data', Buffer.from('{}'));",
    "      res.emit('end');",
    '    });',
    '  };',
    '  return req;',
    '};',
    `const O = require(${JSON.stringify(path.join(ROOT, 'scripts', 'provider-observe.js'))});`,
    "O.fetchLunchMoneyLive('test-token', '2026-08-16T18:00:00.000Z').then(() => {",
    '  process.stdout.write(JSON.stringify(seen));',
    '}).catch((err) => {',
    '  process.stderr.write(String(err && err.message || err));',
    '  process.exit(1);',
    '});',
  ].join('\n');
  const captured = JSON.parse(execFileSync(process.execPath, ['-e', harness], {
    cwd: ROOT,
    encoding: 'utf8',
  }));
  const tx = captured.find(u => /\/v2\/transactions(?:\?|$)/.test(u) && /include_pending=true/.test(u));
  ok(!!tx, 'live fetch actually GET /v2/transactions', JSON.stringify(captured));
  ok(tx && new URL(tx).searchParams.get('include_pending') === 'true',
    'live request URL contains include_pending=true', tx);
  ok(tx && new URL(tx).searchParams.get('include_metadata') === 'true',
    'live request URL contains include_metadata=true', tx);
  const pendingUniverse = captured.find(u => /\/v2\/transactions(?:\?|$)/.test(u) && /is_pending=true/.test(u));
  ok(!!pendingUniverse, 'live fetch also GET /v2/transactions?is_pending=true', JSON.stringify(captured));
  const pendingUrl = new URL(pendingUniverse);
  ok(pendingUrl.searchParams.get('is_pending') === 'true',
    'pending-universe live request sets is_pending=true');
  ok(pendingUrl.searchParams.get('include_metadata') === 'true',
    'pending-universe live request sets include_metadata=true');
  ok(!pendingUrl.searchParams.has('start_date') && !pendingUrl.searchParams.has('end_date'),
    'pending-universe live request is not date-bounded');
}

console.log('=== L2. bounded transaction window is paged and truncated pages fail closed ===');
{
  const harness = [
    "'use strict';",
    "const https = require('https');",
    "const { EventEmitter } = require('events');",
    'const pages = {};',
    'https.request = (url, options, cb) => {',
    '  const href = url && url.href ? url.href : String(url);',
    '  const parsed = new URL(href);',
    '  const req = new EventEmitter();',
    '  req.end = () => {',
    '    process.nextTick(() => {',
    '      const res = new EventEmitter();',
    '      res.statusCode = 200;',
    '      cb(res);',
    "      let body = { has_more: false, transactions: [] };",
    "      if (parsed.pathname === '/v2/me' || parsed.pathname === '/v2/plaid_accounts'",
    "        || parsed.pathname === '/v2/manual_accounts' || parsed.pathname === '/v2/assets'",
    "        || parsed.pathname === '/v2/categories') {",
    '        body = {};',
    "      } else if (parsed.searchParams.get('include_pending') === 'true') {",
    "        const offset = Number(parsed.searchParams.get('offset') || 0);",
    '        if (offset === 0) {',
    "          body = { has_more: true, transactions: [{ id: 1, date: '2026-08-15', amount: 10 }] };",
    '        } else {',
    "          body = { has_more: false, transactions: [{ id: 2, date: '2026-08-16', amount: 11 }] };",
    '        }',
    "      } else if (parsed.searchParams.get('is_pending') === 'true') {",
    "        body = { has_more: false, transactions: [] };",
    '      }',
    "      res.emit('data', Buffer.from(JSON.stringify(body)));",
    "      res.emit('end');",
    '    });',
    '  };',
    '  return req;',
    '};',
    `const O = require(${JSON.stringify(path.join(ROOT, 'scripts', 'provider-observe.js'))});`,
    "O.fetchLunchMoneyLive('test-token', '2026-08-16T18:00:00.000Z').then((payload) => {",
    '  process.stdout.write(JSON.stringify({',
    '    ids: (payload.transactions || []).map(t => t.id),',
    '    complete: payload.transactionWindow && payload.transactionWindow.complete,',
    '    truncated: payload.transactionWindow && payload.transactionWindow.truncated,',
    '  }));',
    '}).catch((err) => {',
    '  process.stderr.write(String(err && err.message || err));',
    '  process.exit(1);',
    '});',
  ].join('\n');
  const paged = JSON.parse(execFileSync(process.execPath, ['-e', harness], {
    cwd: ROOT,
    encoding: 'utf8',
  }));
  ok(paged.ids[0] === 1 && paged.ids[1] === 2,
    'bounded window keeps paging until has_more=false', JSON.stringify(paged.ids));
  ok(paged.complete === true && paged.truncated === false,
    'complete posted window is published only after has_more=false');

  const truncatedHarness = [
    "'use strict';",
    "const https = require('https');",
    "const { EventEmitter } = require('events');",
    'https.request = (url, options, cb) => {',
    '  const href = url && url.href ? url.href : String(url);',
    '  const parsed = new URL(href);',
    '  const req = new EventEmitter();',
    '  req.end = () => {',
    '    process.nextTick(() => {',
    '      const res = new EventEmitter();',
    '      res.statusCode = 200;',
    '      cb(res);',
    "      let body = { has_more: false, transactions: [] };",
    "      if (parsed.pathname === '/v2/me' || parsed.pathname === '/v2/plaid_accounts'",
    "        || parsed.pathname === '/v2/manual_accounts' || parsed.pathname === '/v2/assets'",
    "        || parsed.pathname === '/v2/categories') body = {};",
    "      else if (parsed.searchParams.get('include_pending') === 'true') {",
    "        body = { has_more: true, transactions: [{ id: 9, date: '2026-08-15', amount: 40 }] };",
    '      }',
    "      res.emit('data', Buffer.from(JSON.stringify(body)));",
    "      res.emit('end');",
    '    });',
    '  };',
    '  return req;',
    '};',
    `const O = require(${JSON.stringify(path.join(ROOT, 'scripts', 'provider-observe.js'))});`,
    `const F = require(${JSON.stringify(path.join(ROOT, 'public', 'forecast.js'))});`,
    "O.fetchLunchMoneyLive('test-token', '2026-08-16T18:00:00.000Z').then((payload) => {",
    "  const actuals = O.sanitizedCurrentPeriodActuals({",
    '    fetchedAt: payload.fetchedAt,',
    '    transactionWindow: payload.transactionWindow,',
    '    pendingCoverage: payload.pendingCoverage,',
    '    collapsedTransactions: payload.transactions,',
    '    representedEventCandidates: [],',
    '  }, { asOf: "2026-08-16" });',
    "  const action = F.currentPeriodAction({",
    "    windowDays: 40, defaults: { targetBuffer: 0 }, startingCash: { amount: 4000 },",
    "    opening: { asOf: '2026-08-16', representedEvents: [] },",
    "    income: [{ id: 'pay', label: 'Pay', frequency: 'once', date: '2026-08-28', amount: 2500 }],",
    "    obligations: [], bills: [], commitments: [],",
    "    budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedMonthly: 1800 }] },",
    "  }, '2026-08-16', { paydayFloor: 1000, currentPeriodActuals: actuals });",
    '  process.stdout.write(JSON.stringify({',
    '    truncated: payload.transactionWindow && payload.transactionWindow.truncated,',
    '    complete: payload.transactionWindow && payload.transactionWindow.complete,',
    '    packet: actuals.transactionCoverage,',
    '    remainingClaim: action.remainingClaim,',
    '  }));',
    '}).catch((err) => {',
    '  process.stderr.write(String(err && err.message || err));',
    '  process.exit(1);',
    '});',
  ].join('\n');
  const truncated = JSON.parse(execFileSync(process.execPath, ['-e', truncatedHarness], {
    cwd: ROOT,
    encoding: 'utf8',
  }));
  ok(truncated.truncated === true && truncated.complete === false,
    'a posted window that never reaches has_more=false is truncated');
  ok(truncated.packet === 'truncated' && truncated.remainingClaim === 'unavailable',
    'Atlas cannot claim precise remaining from an incomplete posted page');
}

console.log('=== L3. ATLAS-067 FR1: a 200 page without a transactions array fails closed ===');
{
  // A malformed page must never pose as a genuine empty window: a missing,
  // null, object or string `transactions` field is unproven, so the window
  // is truncated — exactly like a missing has_more. A genuine empty array
  // stays a valid complete empty window, and genuine pagination still works.
  const pagedHarness = [
    "'use strict';",
    "const https = require('https');",
    "const { EventEmitter } = require('events');",
    'https.request = (url, options, cb) => {',
    '  const href = url && url.href ? url.href : String(url);',
    '  const parsed = new URL(href);',
    '  const req = new EventEmitter();',
    '  req.end = () => {',
    '    process.nextTick(() => {',
    '      const res = new EventEmitter();',
    '      res.statusCode = 200;',
    '      cb(res);',
    "      const scenario = parsed.searchParams.get('scenario');",
    "      let body = { has_more: false, transactions: [] };",
    "      if (scenario === 'missing') body = { has_more: false };",
    "      else if (scenario === 'null') body = { has_more: false, transactions: null };",
    "      else if (scenario === 'object') body = { has_more: false, transactions: {} };",
    "      else if (scenario === 'string') body = { has_more: false, transactions: 'oops' };",
    "      else if (scenario === 'paged') {",
    "        const offset = Number(parsed.searchParams.get('offset') || 0);",
    '        body = offset === 0',
    "          ? { has_more: true, transactions: [{ id: 1, date: '2026-08-15', amount: 10 }] }",
    "          : { has_more: false, transactions: [{ id: 2, date: '2026-08-16', amount: 11 }] };",
    '      }',
    "      res.emit('data', Buffer.from(JSON.stringify(body)));",
    "      res.emit('end');",
    '    });',
    '  };',
    '  return req;',
    '};',
    `const O = require(${JSON.stringify(path.join(ROOT, 'scripts', 'provider-observe.js'))});`,
    "const scenarios = ['missing', 'null', 'object', 'string', 'empty', 'paged'];",
    '(async () => {',
    '  const out = {};',
    '  for (const scenario of scenarios) {',
    '    try {',
    "      const url = new URL('https://lm.test/v2/transactions?scenario=' + scenario);",
    "      const page = await O.fetchLunchMoneyTransactionsPaged(url, 'test-token');",
    '      out[scenario] = {',
    '        complete: page.complete, truncated: page.truncated,',
    '        ids: page.transactions.map(t => t && t.id),',
    '        rows: page.transactions.length,',
    '      };',
    '    } catch (err) {',
    '      out[scenario] = { error: String(err && err.message || err) };',
    '    }',
    '  }',
    '  process.stdout.write(JSON.stringify(out));',
    '})().catch((err) => {',
    "  process.stderr.write(String(err && err.message || err));",
    '  process.exit(1);',
    '});',
  ].join('\n');
  const paged = JSON.parse(execFileSync(process.execPath, ['-e', pagedHarness], {
    cwd: ROOT,
    encoding: 'utf8',
  }));
  for (const scenario of ['missing', 'null', 'object', 'string']) {
    ok(paged[scenario] && !paged[scenario].error
      && paged[scenario].complete === false && paged[scenario].truncated === true,
      `a 200 page whose transactions field is ${scenario} is truncated, never complete`,
      JSON.stringify(paged[scenario]));
  }
  ok(paged.string && paged.string.rows === 0,
    'a string transactions field yields no character rows', JSON.stringify(paged.string));
  ok(paged.empty && paged.empty.complete === true && paged.empty.truncated === false
    && paged.empty.rows === 0,
    'a genuine empty array stays a valid complete empty window', JSON.stringify(paged.empty));
  ok(paged.paged && paged.paged.complete === true && paged.paged.truncated === false
    && JSON.stringify(paged.paged.ids) === '[1,2]',
    'genuine two-page pagination still completes with every row', JSON.stringify(paged.paged));

  // Through the live fetch: both the posted window and the pending universe
  // page through the same function, so a malformed page on either query must
  // fail that side closed while the healthy side keeps its verdict.
  const liveHarness = (malformed) => [
    "'use strict';",
    "const https = require('https');",
    "const { EventEmitter } = require('events');",
    'https.request = (url, options, cb) => {',
    '  const href = url && url.href ? url.href : String(url);',
    '  const parsed = new URL(href);',
    '  const req = new EventEmitter();',
    '  req.end = () => {',
    '    process.nextTick(() => {',
    '      const res = new EventEmitter();',
    '      res.statusCode = 200;',
    '      cb(res);',
    "      let body = { has_more: false, transactions: [] };",
    "      if (parsed.pathname === '/v2/me' || parsed.pathname === '/v2/plaid_accounts'",
    "        || parsed.pathname === '/v2/manual_accounts' || parsed.pathname === '/v2/assets') {",
    '        body = {};',
    "      } else if (parsed.pathname === '/v2/categories') {",
    '        body = { categories: [] };',
    "      } else if (parsed.pathname === '/v2/tags') {",
    '        body = { tags: [] };',
    "      } else if (parsed.searchParams.get('include_pending') === 'true') {",
    ...(malformed === 'posted' ? ["        body = { has_more: false };"] : []),
    "      } else if (parsed.searchParams.get('is_pending') === 'true') {",
    ...(malformed === 'pending' ? ["        body = { has_more: false, transactions: null };"] : []),
    '      }',
    "      res.emit('data', Buffer.from(JSON.stringify(body)));",
    "      res.emit('end');",
    '    });',
    '  };',
    '  return req;',
    '};',
    `const O = require(${JSON.stringify(path.join(ROOT, 'scripts', 'provider-observe.js'))});`,
    "O.fetchLunchMoneyLive('test-token', '2026-08-16T18:00:00.000Z').then((payload) => {",
    '  process.stdout.write(JSON.stringify({',
    '    window: payload.transactionWindow,',
    '    pending: payload.pendingCoverage,',
    '  }));',
    '}).catch((err) => {',
    '  process.stderr.write(String(err && err.message || err));',
    '  process.exit(1);',
    '});',
  ].join('\n');
  const badPosted = JSON.parse(execFileSync(process.execPath, ['-e', liveHarness('posted')], {
    cwd: ROOT,
    encoding: 'utf8',
  }));
  ok(badPosted.window && badPosted.window.complete === false && badPosted.window.truncated === true,
    'a malformed posted page makes the published window truncated, not complete',
    JSON.stringify(badPosted.window));
  ok(badPosted.pending && badPosted.pending.complete === true,
    'a healthy pending page still proves the pending universe beside a malformed posted page',
    JSON.stringify(badPosted.pending));
  const badPending = JSON.parse(execFileSync(process.execPath, ['-e', liveHarness('pending')], {
    cwd: ROOT,
    encoding: 'utf8',
  }));
  ok(badPending.pending && badPending.pending.complete === false && badPending.pending.truncated === true,
    'a malformed pending page leaves pending coverage unproven — never proven-zero pending',
    JSON.stringify(badPending.pending));
  ok(badPending.window && badPending.window.complete === true,
    'a healthy posted window still completes beside a malformed pending page',
    JSON.stringify(badPending.window));
}

console.log('=== L4. ATLAS-067 FR2: a /categories 404 fails the live fetch closed ===');
{
  // Category metadata is not optional decoration: a transaction whose raw
  // row carries only a category_id takes its label and income flag solely
  // from the category index. tryGetJson swallows HTTP 404 into null, so a
  // /categories 404 used to publish categories: [] — the payroll row below
  // lost 'Payroll Income' / isIncome while both coverages still reported
  // complete. A 503 on the same endpoint already rejects the whole fetch
  // (tryGetJson rethrows non-404), and a failed refresh must not qualify
  // as a complete replacement observation — so a categories 404 must
  // reject identically. A genuine 200 (empty or nonempty) stays valid,
  // and the account-endpoint 404 fallback (manual_accounts -> assets),
  // which legitimately relies on the same swallow, is preserved.
  const fr2Harness = (scenario) => [
    "'use strict';",
    "const https = require('https');",
    "const { EventEmitter } = require('events');",
    `const scenario = ${JSON.stringify(scenario)};`,
    'https.request = (url, options, cb) => {',
    '  const href = url && url.href ? url.href : String(url);',
    '  const parsed = new URL(href);',
    '  const req = new EventEmitter();',
    '  req.end = () => {',
    '    process.nextTick(() => {',
    '      const res = new EventEmitter();',
    '      let status = 200;',
    '      let body = {};',
    "      if (parsed.pathname === '/v2/me') {",
    '        body = {};',
    "      } else if (parsed.pathname === '/v2/plaid_accounts') {",
    '        body = {};',
    "      } else if (parsed.pathname === '/v2/manual_accounts') {",
    "        if (scenario === 'acctFallback') status = 404;",
    '        else body = {};',
    "      } else if (parsed.pathname === '/v2/assets') {",
    "        body = { assets: [{ id: 7001, name: 'Fallback Asset' }] };",
    "      } else if (parsed.pathname === '/v2/categories') {",
    "        if (scenario === 'cat404') status = 404;",
    "        else if (scenario === 'cat503') status = 503;",
    "        else if (scenario === 'catEmpty') body = { categories: [] };",
    "        else body = { categories: [{ id: 501, name: 'Payroll Income', is_income: true }] };",
    "      } else if (parsed.pathname === '/v2/tags') {",
    '        body = { tags: [] };',
    "      } else if (parsed.searchParams.get('include_pending') === 'true') {",
    "        body = { has_more: false, transactions: [{ id: 9001, account_id: 1001, date: '2026-08-15', amount: -2500, category_id: 501, is_pending: false }] };",
    "      } else if (parsed.searchParams.get('is_pending') === 'true') {",
    '        body = { has_more: false, transactions: [] };',
    '      }',
    '      res.statusCode = status;',
    '      cb(res);',
    "      res.emit('data', Buffer.from(JSON.stringify(body)));",
    "      res.emit('end');",
    '    });',
    '  };',
    '  return req;',
    '};',
    `const O = require(${JSON.stringify(path.join(ROOT, 'scripts', 'provider-observe.js'))});`,
    "O.fetchLunchMoneyLive('test-token', '2026-08-16T18:00:00.000Z').then((payload) => {",
    '  let payroll = null;',
    '  try {',
    '    const normalized = O.normalizeLunchMoneyPayload(payload);',
    "    payroll = normalized.transactions.find(t => t.providerTransactionId === '9001') || null;",
    '  } catch (e) { payroll = null; }',
    '  process.stdout.write(JSON.stringify({',
    "    outcome: 'resolved',",
    '    categories: (payload.categories || []).length,',
    '    accounts: (payload.accounts || []).map(a => String(a.id)),',
    '    windowComplete: payload.transactionWindow && payload.transactionWindow.complete,',
    '    pendingComplete: payload.pendingCoverage && payload.pendingCoverage.complete,',
    '    payrollLabel: payroll ? payroll.categoryLabel : null,',
    '    payrollIsIncome: payroll ? payroll.isIncome === true : false,',
    '  }));',
    '}).catch((err) => {',
    "  process.stdout.write(JSON.stringify({ outcome: 'rejected', message: String(err && err.message || err) }));",
    '});',
  ].join('\n');
  const runFr2 = (scenario) => JSON.parse(execFileSync(process.execPath, ['-e', fr2Harness(scenario)], {
    cwd: ROOT,
    encoding: 'utf8',
  }));

  const cat404 = runFr2('cat404');
  ok(cat404.outcome === 'rejected' && /HTTP 404/.test(cat404.message || ''),
    'a /categories 404 rejects the live fetch — no silently degraded observation is produced',
    JSON.stringify(cat404));

  const cat503 = runFr2('cat503');
  ok(cat503.outcome === 'rejected' && /HTTP 503/.test(cat503.message || ''),
    'a /categories 503 still rejects the live fetch (the existing path FR2 mirrors)',
    JSON.stringify(cat503));

  const cat200 = runFr2('cat200');
  ok(cat200.outcome === 'resolved' && cat200.categories === 1
    && cat200.payrollLabel === 'Payroll Income' && cat200.payrollIsIncome === true,
    'healthy categories keep the payroll label and income flag from the category index',
    JSON.stringify(cat200));
  ok(cat200.windowComplete === true && cat200.pendingComplete === true,
    'healthy categories leave window and pending coverage complete',
    JSON.stringify(cat200));

  const catEmpty = runFr2('catEmpty');
  ok(catEmpty.outcome === 'resolved' && catEmpty.categories === 0
    && catEmpty.windowComplete === true && catEmpty.pendingComplete === true,
    'a genuine empty categories array stays a valid complete observation',
    JSON.stringify(catEmpty));

  const acctFallback = runFr2('acctFallback');
  ok(acctFallback.outcome === 'resolved' && acctFallback.accounts.includes('7001'),
    'the account-endpoint 404 fallback (manual_accounts -> assets) is preserved',
    JSON.stringify(acctFallback));
}

console.log('=== L5. ATLAS-067 tags: a /tags 404 fails the live fetch closed ===');
{
  // Tag names are classification inputs, not display decoration: a tag
  // named fuel/gas is explicit fuel evidence (Forecast
  // hasExplicitFuelEvidence) and a tag named Amanda assigns the personal
  // owner behind the guilt-free buckets. tryGetJson swallows HTTP 404 into
  // null, so a /tags 404 used to publish tags: [] — bare-ID tags kept their
  // ID with name: null, the fuel-evidence stamp and the Amanda owner were
  // silently lost, both coverages still reported complete, and the
  // poisoned payload qualified for storage and replay as a complete
  // replacement observation. A 503 on the same endpoint already rejects
  // the whole fetch (tryGetJson rethrows non-404) — so a tags 404 must
  // reject identically, exactly as FR2 required for /categories. A genuine
  // 200 (empty or nonempty) stays valid, object-embedded tag names never
  // needed the index, and tryGetJson itself is untouched so the
  // account-endpoint 404 fallback is preserved (pinned by L4 above).
  const tagsHarness = (scenario) => [
    "'use strict';",
    "const https = require('https');",
    "const { EventEmitter } = require('events');",
    "const fs = require('fs');",
    `const scenario = ${JSON.stringify(scenario)};`,
    "const TAGS = [{ id: 501, name: 'fuel' }, { id: 502, name: 'Amanda' }];",
    "const ACCOUNT = { id: 1001, name: 'Synthetic Chequing', type: 'cash', subtype: 'checking', institution_name: 'Synthetic Bank', balance: 1000, currency: 'cad', updated_at: '2026-08-16T17:55:00.000Z' };",
    "const LEG1 = [",
    "  { id: 7001, account_id: 1001, date: '2026-08-14', amount: 50, currency: 'cad', payee: 'ROUTE 66 SERVICE', category_id: 900, is_pending: false, status: 'cleared', tags: [501] },",
    "  { id: 7002, account_id: 1001, date: '2026-08-14', amount: 25, currency: 'cad', payee: 'CHAPTERS BOOKSTORE', category_id: 900, is_pending: false, status: 'cleared', tags: [502] },",
    "  { id: 7003, account_id: 1001, date: '2026-08-14', amount: 60, currency: 'cad', payee: 'ROUTE 66 SERVICE', category_id: 900, is_pending: false, status: 'cleared', tags: [{ id: 501, name: 'fuel' }] },",
    "  { id: 7004, account_id: 1001, date: '2026-08-14', amount: 10, currency: 'cad', payee: 'PAPER GOODS DEPOT', category_id: 900, is_pending: false, status: 'cleared' },",
    "];",
    "const GATE = [",
    "  { id: 7005, account_id: 1001, date: '2026-08-14', amount: 80, currency: 'cad', payee: null, original_name: null, category_id: 901, is_pending: false, status: 'cleared', tags: [501] },",
    "];",
    'https.request = (url, options, cb) => {',
    '  const href = url && url.href ? url.href : String(url);',
    '  const parsed = new URL(href);',
    '  const req = new EventEmitter();',
    '  req.end = () => {',
    '    process.nextTick(() => {',
    '      const res = new EventEmitter();',
    '      let status = 200;',
    '      let body = {};',
    "      if (parsed.pathname === '/v2/me') {",
    '        body = {};',
    "      } else if (parsed.pathname === '/v2/plaid_accounts') {",
    '        body = { plaid_accounts: [ACCOUNT] };',
    "      } else if (parsed.pathname === '/v2/manual_accounts') {",
    '        body = {};',
    "      } else if (parsed.pathname === '/v2/assets') {",
    '        body = {};',
    "      } else if (parsed.pathname === '/v2/categories') {",
    "        body = { categories: [{ id: 900, name: 'Shopping', is_income: false }, { id: 901, name: 'Fuel & transport', is_income: false }] };",
    "      } else if (parsed.pathname === '/v2/tags') {",
    "        if (scenario === 'tags404' || scenario === 'gate404') status = 404;",
    "        else if (scenario === 'tags503') status = 503;",
    "        else if (scenario === 'tagsEmpty') body = { tags: [] };",
    '        else body = { tags: TAGS };',
    "      } else if (parsed.pathname === '/v2/transactions') {",
    "        if (parsed.searchParams.get('is_pending') === 'true') {",
    '          body = { has_more: false, transactions: [] };',
    '        } else {',
    "          body = { has_more: false, transactions: scenario.indexOf('gate') === 0 ? GATE : LEG1 };",
    '        }',
    '      }',
    '      res.statusCode = status;',
    '      cb(res);',
    "      res.emit('data', Buffer.from(JSON.stringify(body)));",
    "      res.emit('end');",
    '    });',
    '  };',
    '  return req;',
    '};',
    `const O = require(${JSON.stringify(path.join(ROOT, 'scripts', 'provider-observe.js'))});`,
    `const F = require(${JSON.stringify(path.join(ROOT, 'public', 'forecast.js'))});`,
    `const accountMap = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'provider-account-map.json'))}, 'utf8'));`,
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'data.json'))}, 'utf8'));`,
    "O.fetchLunchMoneyLive('test-token', '2026-08-16T18:00:00.000Z').then((payload) => {",
    '  const report = O.observe({ provider: \'lunchmoney\', payload, accountMap, data });',
    '  const packet = report.currentPeriodActuals || {};',
    '  const rows = packet.transactions || [];',
    '  const byAmt = (a) => rows.find(r => r && r.amount === a) || null;',
    '  const slim = (r) => r ? {',
    '    fuelEvidence: r.fuelEvidence === true,',
    '    personalOwner: r.personalOwner || null,',
    '  } : null;',
    '  const classify = (r) => {',
    '    if (!r) return null;',
    '    const c = F.classifyCurrentPeriodTransaction(r, data.plan);',
    '    return c ? { kind: c.kind, categoryId: c.categoryId, reason: c.reason || null } : null;',
    '  };',
    '  process.stdout.write(JSON.stringify({',
    "    outcome: 'resolved',",
    '    tags: (payload.tags || []).length,',
    '    windowComplete: payload.transactionWindow && payload.transactionWindow.complete,',
    '    pendingComplete: payload.pendingCoverage && payload.pendingCoverage.complete,',
    '    coverage: packet.transactionCoverage,',
    '    pending: packet.pendingCoverage,',
    '    F: slim(byAmt(50)), A: slim(byAmt(25)), O: slim(byAmt(60)), N: slim(byAmt(10)),',
    '    classifyA: classify(byAmt(25)),',
    '    G: slim(byAmt(80)), classifyG: classify(byAmt(80)),',
    '  }));',
    '}).catch((err) => {',
    "  process.stdout.write(JSON.stringify({ outcome: 'rejected', message: String(err && err.message || err) }));",
    '});',
  ].join('\n');
  const runTags = (scenario) => JSON.parse(execFileSync(process.execPath, ['-e', tagsHarness(scenario)], {
    cwd: ROOT,
    encoding: 'utf8',
  }));

  const tags404 = runTags('tags404');
  ok(tags404.outcome === 'rejected' && /HTTP 404/.test(tags404.message || ''),
    'a /tags 404 rejects the live fetch — no silently name-less observation is produced',
    JSON.stringify(tags404));

  const tags503 = runTags('tags503');
  ok(tags503.outcome === 'rejected' && /HTTP 503/.test(tags503.message || ''),
    'a /tags 503 still rejects the live fetch (the existing path this repair mirrors)',
    JSON.stringify(tags503));

  const tags200 = runTags('tags200');
  ok(tags200.outcome === 'resolved' && tags200.tags === 2,
    'healthy tags resolve with the full tag list', JSON.stringify(tags200));
  ok(tags200.F && tags200.F.fuelEvidence === true,
    'a bare-ID tag named fuel stamps fuel evidence when /tags answers',
    JSON.stringify(tags200.F));
  ok(tags200.A && tags200.A.personalOwner === 'amanda',
    'a bare-ID tag named Amanda assigns the personal owner when /tags answers',
    JSON.stringify(tags200.A));
  ok(tags200.classifyA && tags200.classifyA.kind === 'spend'
    && tags200.classifyA.categoryId === 'amanda-guilt-free',
    'the Amanda-tagged row classifies into her guilt-free bucket',
    JSON.stringify(tags200.classifyA));
  ok(tags200.O && tags200.O.fuelEvidence === true,
    'an object-embedded fuel tag name keeps its evidence without the index',
    JSON.stringify(tags200.O));
  ok(tags200.N && tags200.N.fuelEvidence === false && tags200.N.personalOwner === null,
    'an untagged row gains no tag-derived stamps', JSON.stringify(tags200.N));
  ok(tags200.coverage === 'complete' && tags200.pending === 'complete',
    'healthy tags leave published coverage complete', JSON.stringify(tags200));

  const tagsEmpty = runTags('tagsEmpty');
  ok(tagsEmpty.outcome === 'resolved' && tagsEmpty.tags === 0
    && tagsEmpty.windowComplete === true && tagsEmpty.pendingComplete === true,
    'a genuine empty tags array stays a valid complete observation',
    JSON.stringify(tagsEmpty));

  const gate404 = runTags('gate404');
  ok(gate404.outcome === 'rejected' && /HTTP 404/.test(gate404.message || ''),
    'a /tags 404 rejects the fetch even when a bare-ID tag is the only fuel evidence for a missing-merchant row',
    JSON.stringify(gate404));

  const gate200 = runTags('gate200');
  ok(gate200.outcome === 'resolved' && gate200.G && gate200.G.fuelEvidence === true
    && gate200.classifyG && gate200.classifyG.kind === 'spend'
    && gate200.classifyG.categoryId === 'fuel',
    'with /tags healthy, the missing-merchant fuel row classifies as Fuel spend on its tag evidence',
    JSON.stringify(gate200.classifyG));

  // Payload leg (the investigation's leg 2): identical payloads differing
  // only in the top-level tags list. This pins WHY tags are required — the
  // swallowed-404 outcome (tags: []) silently holds a missing-merchant
  // Fuel-category row out of Fuel while coverage claims complete. The
  // fetch-level pins above make that outcome unreachable from a 404.
  const F = require('../public/forecast.js');
  const gateAccount = { id: 1001, name: 'Synthetic Chequing', type: 'cash', subtype: 'checking', institution_name: 'Synthetic Bank', balance: 1000, currency: 'cad', updated_at: '2026-08-16T17:55:00.000Z' };
  const gateTx = { id: 7005, account_id: 1001, date: '2026-08-14', amount: 80, currency: 'cad', payee: null, original_name: null, category_id: 901, is_pending: false, status: 'cleared', tags: [501] };
  const gatePayload = (tags) => ({
    provider: 'lunchmoney',
    fetchedAt: '2026-08-16T18:00:00.000Z',
    accounts: [gateAccount],
    categories: [{ id: 901, name: 'Fuel & transport', is_income: false }],
    tags,
    transactions: [gateTx],
    transactionWindow: { startDate: '2026-08-02', endDate: '2026-08-16', complete: true, hasMore: false, truncated: false },
  });
  const gateRun = (tags) => {
    const report = O.observe({ provider: 'lunchmoney', payload: gatePayload(tags), accountMap, data });
    const packet = report.currentPeriodActuals || {};
    const row = (packet.transactions || []).find(r => r && r.amount === 80) || null;
    const cls = row ? F.classifyCurrentPeriodTransaction(row, data.plan) : null;
    return { packet, row, cls };
  };
  const gateHealthy = gateRun([{ id: 501, name: 'fuel' }]);
  ok(gateHealthy.row && gateHealthy.row.fuelEvidence === true
    && gateHealthy.cls && gateHealthy.cls.kind === 'spend' && gateHealthy.cls.categoryId === 'fuel',
    'payload leg: a healthy tags list lets the bare-ID fuel tag open the missing-merchant gate',
    JSON.stringify(gateHealthy.cls));
  const gateSwallowed = gateRun([]);
  ok(gateSwallowed.row && gateSwallowed.row.fuelEvidence === false
    && gateSwallowed.cls && gateSwallowed.cls.kind === 'unclassified'
    && gateSwallowed.cls.reason === 'fuel-merchant-missing'
    && gateSwallowed.packet.transactionCoverage === 'complete',
    'payload leg: the post-404 tags: [] outcome silently holds the same row out of Fuel while coverage claims complete',
    JSON.stringify(gateSwallowed.cls));
}

console.log('=== M. unobserved live account IDs cannot match fixture mappings ===');
{
  const liveMap = JSON.parse(fs.readFileSync(LIVE_MAP, 'utf8'));
  const fixtureIds = ['1001', '1002', '2001', '2002', '2003'];
  ok(liveMap.scope === 'live', 'default map is the live/owner-observed scope');
  ok(Array.isArray(liveMap.mappings) && liveMap.mappings.length === 0,
    'default live map has no synthetic fixture IDs');
  ok(!liveMap.mappings.some(m => fixtureIds.includes(String(m.providerAccountId))),
    'fixture IDs 1001–2003 are absent from the live map');
  const report = O.observe({ provider: 'lunchmoney', payload, accountMap: liveMap, data });
  ok(report.mapped.length === 0, 'fixture accounts stay unmapped under the live map');
  ok(fixtureIds.every(id => report.unmapped.some(u => u.providerAccountId === id)),
    'unobserved live IDs do not inherit fixture canonical mappings');
  ok(!report.observations.some(o => fixtureIds.includes(String(o.providerAccountId))),
    'fixture IDs produce no live canonical observations');

  let threw = false;
  let message = '';
  try {
    execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'provider-observe.js'),
      '--provider', 'lunchmoney',
      '--live',
      '--map', MAP,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: Object.assign({}, process.env, { LUNCHMONEY_ACCESS_TOKEN: 'test-token-not-used' }),
    });
  } catch (e) {
    threw = true;
    message = String(e.stderr || e.stdout || e.message || '');
  }
  ok(threw, 'live CLI refuses a fixture-scoped account map');
  ok(/Fixture account map cannot authorize a live canonical mapping/.test(message),
    'refusal names the fixture-map live boundary');
  ok(!/Bearer\s+\S+/.test(message), 'fixture-map refusal does not print a bearer token');
}

console.log('=== N. Lunch Money normalize extracts Plaid transaction identity ===');
{
  const pending = O.normalizeLunchMoneyTransaction({
    id: 'lm-pending-101',
    account_id: 3006,
    date: '2026-08-31',
    amount: 100,
    is_pending: true,
    payee: 'AMZN Mktp CA',
    plaid_metadata: { transaction_id: 'plaid-pending-abc' },
  });
  const posted = O.normalizeLunchMoneyTransaction({
    id: 'lm-posted-202',
    account_id: 3006,
    date: '2026-08-31',
    amount: 97.5,
    is_pending: false,
    payee: 'AMZN Mktp CA',
    plaid_metadata: {
      transaction_id: 'plaid-posted-def',
      pending_transaction_id: 'plaid-pending-abc',
    },
  });
  ok(pending.providerTransactionId === 'lm-pending-101'
      && posted.providerTransactionId === 'lm-posted-202',
    'providerTransactionId stays the Lunch Money row id');
  ok(pending.plaidTransactionId === 'plaid-pending-abc'
      && posted.plaidTransactionId === 'plaid-posted-def'
      && posted.plaidPendingTransactionId === 'plaid-pending-abc',
    'normalize reads Plaid transaction_id and pending_transaction_id from plaid_metadata');
  ok(pending.plaidTransactionId !== pending.providerTransactionId
      && posted.plaidPendingTransactionId !== posted.providerTransactionId,
    'Plaid ids are not redefined as Lunch Money ids');
}

console.log('=== O. amount qualification precedes scalar numeric conversion ===');
for (const [name, rawAmount, expected] of [
  ['numeric zero', 0, 0], ['decimal zero', '0.00', 0], ['signed zero', '-0.0000', 0],
  ['numeric debit', 500, 500], ['decimal debit', '500.00', 500],
  ['numeric credit', -500, -500], ['decimal credit', '-500.00', -500],
  ['provider four-place precision', '12.3456', 12.3456],
  ['trimmed signed decimal', ' +12.50 ', 12.5], ['fractional decimal', '.50', 0.5],
  ['trailing decimal point', '12.', 12],
  ['empty string', '', null], ['whitespace string', ' ', null],
  ['blank control whitespace', '\t\r\n', null], ['blank nonbreaking whitespace', '\u00a0', null],
  ['boolean false', false, null], ['boolean true', true, null],
  ['empty array', [], null], ['numeric array', [500], null],
  ['decimal array', ['500.00'], null], ['object', {}, null],
  ['null', null, null], ['undefined', undefined, null],
  ['nonfinite number', Infinity, null], ['not-a-number', NaN, null],
  ['hexadecimal string', '0x1', null], ['binary string', '0b1', null],
  ['octal string', '0o1', null], ['infinity string', 'Infinity', null],
  ['nonnumeric string', 'unavailable', null],
]) {
  ok(O.lunchMoneyDebitAmount(rawAmount) === expected, name + ' preserves only a qualified scalar amount');
  const row = O.normalizeLunchMoneyTransaction({ id: 93011, account_id: 2002,
    date: '2026-08-16', currency: 'cad', amount: rawAmount, is_pending: false });
  ok(row.amount === expected, name + ' normalization does not lose the qualification');
  ok(row.providerTransactionId === '93011' && row.providerAccountId === '2002'
    && row.date === '2026-08-16' && row.currency === 'cad' && row.pending === false,
    name + ' preserves native identity/date/currency/pending fields');
}

console.log('=== N. outgoing e-transfer identity boolean (SEND E-TFR, originalName only) ===');
{
  // Atlas decision 2026-10-12, as refined: the boolean is stamped in the
  // sanitized packet from tx.originalName alone, anchored 'SEND E-TFR' with
  // an end/non-alphanumeric boundary after the channel token; SEND E-TFR FEE
  // is a fee, not a transfer. No raw descriptor ever enters the packet.
  const mk = (id, extra) => O.normalizeLunchMoneyTransaction(Object.assign({
    id, account_id: 1001, date: '2026-08-16', amount: 50 + id, currency: 'cad',
    is_pending: false, status: 'cleared', payee: 'Household recipient',
    category_name: 'Transfer',
  }, extra));
  const cases = [
    ['SEND E-TFR', true, 'bare channel token'],
    ['send e-tfr', true, 'lowercase variant'],
    ['  SEND   E-TFR\tJ SMITH  ', true, 'whitespace runs collapse, suffix after a space boundary'],
    ['SEND E-TFR/ABC123', true, 'non-alphanumeric boundary after the token'],
    ['SEND E-TFRXYZ', false, 'arbitrary SEND E-TFR-prefixed word is not the channel token'],
    ['SEND E-TFR2', false, 'alphanumeric continuation is not a boundary'],
    ['SEND E-TFR FEE', false, 'SEND E-TFR FEE is a fee, not a transfer'],
    ['send e-tfr fee charge', false, 'fee variant stays a fee after normalization'],
    ['XSEND E-TFR', false, 'token must anchor at the start, not merely appear'],
    ['Payment to a person', false, 'Payment descriptor is not identity evidence'],
    ['Transfer to savings', false, 'Transfer descriptor is not identity evidence'],
    ['ACME STORE', false, 'ordinary merchant descriptor'],
  ];
  const txs = cases.map(([original_name], i) => mk(94100 + i, { original_name }));
  // Fallback traps: identity must not come from payee, nor from the
  // originalMerchant fallback (originalName || payee).
  txs.push(mk(94150, { payee: 'SEND E-TFR SOMEONE' }));
  txs.push(mk(94151, { original_name: null, payee: 'SEND E-TFR SOMEONE' }));
  const packet = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-08-16T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-01', endDate: '2026-08-16', complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true },
    transactions: txs, collapsedTransactions: txs,
    representedEventCandidates: [],
  }, { asOf: '2026-08-16', accountMap, plan: data.plan });
  // Rows keep input order in the packet; match by position.
  cases.forEach(([descriptor, expected, label], i) => {
    const row = packet.transactions[i];
    ok(row && row.outgoingETransferIdentity === expected,
      `${label}: ${JSON.stringify(descriptor)} -> outgoingETransferIdentity ${expected}`,
      row && String(row.outgoingETransferIdentity));
  });
  ok(packet.transactions[txs.length - 2].outgoingETransferIdentity === false
    && packet.transactions[txs.length - 1].outgoingETransferIdentity === false,
    'payee-only / originalMerchant-fallback SEND E-TFR text never stamps the boolean');
  ok(!JSON.stringify(packet).includes('SEND E-TFR'),
    'the packet publishes the boolean only — no raw descriptor text anywhere');
  ok(packet.transactions.every(row => typeof row.outgoingETransferIdentity === 'boolean'),
    'every packet row carries the boolean (true or false), never the descriptor');
  // Provenance repair (Atlas, 2026-10-12): the packet carries the window
  // bounds themselves so Forecast can validate them instead of trusting
  // coverage dates that fall back to the transactions' own min/max.
  ok(JSON.stringify(packet.transactionWindow) === JSON.stringify({
    startDate: '2026-08-01', endDate: '2026-08-16', complete: true, hasMore: false, truncated: false,
  }), 'the packet carries the sanitized transaction window bounds',
    JSON.stringify(packet.transactionWindow));
  const noWindowPacket = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-08-16T18:00:00.000Z',
    pendingCoverage: { complete: true },
    transactions: txs, collapsedTransactions: txs,
    representedEventCandidates: [],
  }, { asOf: '2026-08-16', accountMap, plan: data.plan });
  ok(noWindowPacket.transactionWindow && noWindowPacket.transactionWindow.startDate === null
    && noWindowPacket.transactionWindow.endDate === null
    && noWindowPacket.transactionWindow.complete === null,
    'a report with no window yields explicit null bounds on the packet — never invented ones',
    JSON.stringify(noWindowPacket.transactionWindow));
}

console.log('=== N2. unprocessable outgoing e-transfer candidates (P1 4253396900) ===');
{
  // Repair (Atlas BLOCK 5497313211): a household-cash SEND E-TFR row with a
  // valid date but an unqualified amount is dropped by the amount guard
  // before the identity matcher runs. The packet must retain sanitized,
  // window-scoped evidence of the candidate — {date, reason} only, never
  // the descriptor and never an invented amount — so Forecast can withhold
  // the outgoing e-transfer all-clear. The row itself stays omitted. C1
  // supersedes the earlier "global coverage untouched" decision: a dropped
  // household row now also marks transactionCoverage incomplete.
  const mk2 = (id, extra) => O.normalizeLunchMoneyTransaction(Object.assign({
    id, account_id: 1001, date: '2026-08-16', amount: 'unavailable', currency: 'cad',
    is_pending: false, status: 'cleared', payee: 'Household recipient',
    category_name: 'Transfer',
  }, extra));
  const reportFor = txs => ({
    fetchedAt: '2026-08-16T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-01', endDate: '2026-08-16', complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true },
    transactions: txs, collapsedTransactions: txs,
    representedEventCandidates: [],
  });

  // Invalid-only: exactly one dates-only entry; the row stays omitted and
  // global coverage now reads incomplete (C1) as well as the publication degrading.
  const invalidOnly = O.sanitizedCurrentPeriodActuals(
    reportFor([mk2(94200, { original_name: 'SEND E-TFR J SMITH' })]),
    { asOf: '2026-08-16', accountMap, plan: data.plan });
  ok(Array.isArray(invalidOnly.outgoingETransferUnconfirmed)
    && invalidOnly.outgoingETransferUnconfirmed.length === 1,
    'an unqualified-amount household-cash SEND E-TFR row leaves exactly one unconfirmed entry',
    JSON.stringify(invalidOnly.outgoingETransferUnconfirmed));
  const entry = (invalidOnly.outgoingETransferUnconfirmed || [])[0] || {};
  ok(JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(['date', 'reason'])
    && entry.date === '2026-08-16' && entry.reason === 'transaction-amount-unconfirmed',
    'the entry is dates-and-reason only — no descriptor, no provider id, no amount',
    JSON.stringify(entry));
  ok(invalidOnly.transactions.length === 0,
    'the unprocessable row itself stays omitted from packet transactions');
  ok(invalidOnly.transactionCoverage === 'incomplete',
    'a dropped household row marks global transactionCoverage incomplete (C1), alongside the publication-level diagnostic');
  ok(!JSON.stringify(invalidOnly).includes('SEND E-TFR'),
    'no raw descriptor text anywhere in the packet');

  // Exclusions: FEE rows, revolving-credit rows and non-descriptor rows
  // never produce an entry; a qualified SEND E-TFR row survives as before.
  const exclusions = O.sanitizedCurrentPeriodActuals(reportFor([
    mk2(94201, { original_name: 'SEND E-TFR FEE' }),
    mk2(94202, { account_id: 2001, original_name: 'SEND E-TFR J SMITH' }),
    mk2(94203, { original_name: 'ACME STORE' }),
    mk2(94204, { original_name: 'SEND E-TFR J SMITH', amount: 75 }),
  ]), { asOf: '2026-08-16', accountMap, plan: data.plan });
  ok(Array.isArray(exclusions.outgoingETransferUnconfirmed)
    && exclusions.outgoingETransferUnconfirmed.length === 0,
    'FEE, revolving-credit and non-descriptor unqualified rows leave no entry',
    JSON.stringify(exclusions.outgoingETransferUnconfirmed));
  ok(exclusions.transactions.length === 1
    && exclusions.transactions[0].outgoingETransferIdentity === true,
    'the qualified SEND E-TFR row still survives with its identity boolean');

  // Combined producer run (#595 coexistence): the same sanitizer pass also
  // records account-scoped Savings provenance for an unqualified Savings
  // row; neither channel disturbs the other.
  const combinedMap = clone(accountMap);
  combinedMap.mappings.push({ providerAccountId: '3001', atlasRole: 'household-cash',
    canonical: { collection: 'cash', id: 'savings' } });
  const combined = O.sanitizedCurrentPeriodActuals(reportFor([
    mk2(94210, { original_name: 'SEND E-TFR J SMITH' }),
    mk2(94211, { account_id: 3001, original_name: 'SAVINGS TRANSFER' }),
  ]), { asOf: '2026-08-16', accountMap: combinedMap, plan: data.plan });
  ok(Array.isArray(combined.outgoingETransferUnconfirmed)
    && combined.outgoingETransferUnconfirmed.length === 1
    && combined.outgoingETransferUnconfirmed[0].date === '2026-08-16',
    'combined run: the e-transfer diagnostic entry is recorded',
    JSON.stringify(combined.outgoingETransferUnconfirmed));
  ok(combined.savingsMovementUnconfirmed.some(row => row.accountId === 'savings'
    && row.reason === 'transaction-amount-or-date-unconfirmed'),
    'combined run: #595 Savings provenance is recorded in the same pass',
    JSON.stringify(combined.savingsMovementUnconfirmed));
}

console.log('=== P. malformed transaction IDs fail closed (trustworthy-ID boundary) ===');
{
  // Boundary (Atlas, approved 2026-10-12): a Lunch Money transaction ID is
  // trustworthy only as a safe-integer number, or as a nonempty string
  // exactly equal to its own trim() — trustworthy strings are opaque
  // identities preserved verbatim. Everything else is untrustworthy:
  // unmergeable at fetch (mergeTransactionsById passes the row through,
  // never keyed into the dedup Set) and rejected at normalization through
  // the EXISTING missing-id failure path, so observe() aborts and produces
  // no report/packet — downstream gates withhold by absence.
  const MISSING_ID = 'Lunch Money transaction is missing a stable id.';
  const baseTx = { account_id: 1001, date: '2026-08-16', amount: 25, currency: 'cad', is_pending: false };
  const normalizeError = raw => {
    try {
      O.normalizeLunchMoneyTransaction(raw);
      return null;
    } catch (err) {
      return err && err.message;
    }
  };

  // Baseline that already holds today: null/undefined take the same path.
  ok(normalizeError(Object.assign({}, baseTx, { id: null })) === MISSING_ID
    && normalizeError(Object.assign({}, baseTx, { id: undefined })) === MISSING_ID,
    'null/undefined IDs fail through the existing missing-id path (baseline)');

  // Malformed IDs: each fails closed at normalization with the SAME
  // missing-id error — not a new error, not a silent stringification.
  for (const [label, badId] of [
    ['empty-string ID', ''],
    ['whitespace-only string ID', '   '],
    ['whitespace-padded string ID', ' 123 '],
    ['array ID', [123]],
    ['object ID', { value: 123 }],
    ['boolean true ID', true],
    ['boolean false ID', false],
    ['NaN ID', NaN],
    ['Infinity ID', Infinity],
    ['non-integer number ID', 12.5],
    ['unsafe integer ID', Number.MAX_SAFE_INTEGER + 1],
  ]) {
    ok(normalizeError(Object.assign({}, baseTx, { id: badId })) === MISSING_ID,
      `${label} fails closed at normalization with the missing-id error`);
  }

  // Trustworthy IDs normalize exactly as today; identity is the String()
  // form, so number/string equivalence is preserved and opaque strings are
  // kept verbatim (case and leading zeros are identity).
  ok(O.normalizeLunchMoneyTransaction(Object.assign({}, baseTx, { id: 123 })).providerTransactionId === '123'
    && O.normalizeLunchMoneyTransaction(Object.assign({}, baseTx, { id: '123' })).providerTransactionId === '123',
    "number 123 and string '123' keep the same String() identity (current behaviour)");
  ok(O.normalizeLunchMoneyTransaction(Object.assign({}, baseTx, { id: '0123' })).providerTransactionId === '0123',
    "opaque string '0123' is preserved verbatim — a distinct identity from '123'");
  ok(O.normalizeLunchMoneyTransaction(Object.assign({}, baseTx, { id: 'AbC-009x' })).providerTransactionId === 'AbC-009x',
    'mixed-case opaque string ID is preserved verbatim');
  ok(O.normalizeLunchMoneyTransaction(Object.assign({}, baseTx, { id: 0 })).providerTransactionId === '0',
    'numeric zero is a safe integer and stays trustworthy');
  ok(O.normalizeLunchMoneyTransaction(Object.assign({}, baseTx, { id: Number.MAX_SAFE_INTEGER })).providerTransactionId === String(Number.MAX_SAFE_INTEGER),
    'Number.MAX_SAFE_INTEGER stays trustworthy');

  // Identity controls at the (frozen) collapse: a valid same-ID
  // pending→posted pair still collapses with correct identityEvidence;
  // number/string '123' are one identity; '0123' is a different one.
  const collapseOf = raws => O.collapseByProviderTransactionId(
    raws.map(raw => O.normalizeLunchMoneyTransaction(raw)));
  const pair = collapseOf([
    Object.assign({}, baseTx, { id: 777, is_pending: true }),
    Object.assign({}, baseTx, { id: 777, is_pending: false }),
  ]);
  ok(pair.transactions.length === 1 && pair.transactions[0].priorPending === true
    && pair.identityEvidence.length === 1
    && pair.identityEvidence[0].providerTransactionId === '777'
    && pair.identityEvidence[0].transition === 'pending-to-posted'
    && pair.identityEvidence[0].pendingCount === 1
    && pair.identityEvidence[0].postedCount === 1,
    'valid pending→posted same-ID pair still collapses with correct identityEvidence',
    JSON.stringify(pair.identityEvidence));
  const numericStringPair = collapseOf([
    Object.assign({}, baseTx, { id: 123, is_pending: true }),
    Object.assign({}, baseTx, { id: '123', is_pending: false }),
  ]);
  ok(numericStringPair.transactions.length === 1
    && numericStringPair.identityEvidence.length === 1,
    "number 123 pending + string '123' posted collapse as one identity");
  const opaquePair = collapseOf([
    Object.assign({}, baseTx, { id: '0123' }),
    Object.assign({}, baseTx, { id: '123' }),
  ]);
  ok(opaquePair.transactions.length === 2 && opaquePair.identityEvidence.length === 0,
    "'0123' and '123' remain distinct identities — no collapse");

  // Observe-level: one malformed row aborts the whole observation. The
  // array ID [88001] String()-collides with the fixture's genuine 88001
  // today and is silently absorbed; after the boundary it must produce
  // NO report and NO packet.
  const malformedPayload = clone(payload);
  malformedPayload.transactions = payload.transactions.concat([
    { id: [88001], account_id: 1001, date: '2026-08-15', amount: 10, is_pending: false },
  ]);
  let observeError = null;
  try {
    O.observe({ provider: 'lunchmoney', payload: malformedPayload, accountMap, data });
  } catch (err) {
    observeError = err && err.message;
  }
  ok(observeError === MISSING_ID,
    'a payload carrying an array ID alongside genuine 88001 aborts observe() — no report, no packet');

  // CLI artifact path: the same payload through the CLI prints no report.
  const tmpFixture = path.join(os.tmpdir(), `atlas-malformed-id-fixture-${process.pid}.json`);
  fs.writeFileSync(tmpFixture, JSON.stringify(malformedPayload));
  let cliThrew = false;
  let cliStderr = '';
  let cliStdout = '';
  try {
    cliStdout = execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'provider-observe.js'),
      '--provider', 'lunchmoney',
      '--fixture', tmpFixture,
    ], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    cliThrew = true;
    cliStderr = String(e.stderr || '');
    cliStdout = String(e.stdout || '');
  } finally {
    fs.unlinkSync(tmpFixture);
  }
  ok(cliThrew && cliStderr.includes(MISSING_ID) && !cliStdout.includes('"writesCanonicalState"'),
    'CLI run on a malformed-ID fixture aborts with the missing-id error and prints no report artifact');

  // Fetch-level: the array-ID row must survive mergeTransactionsById (never
  // deduped away against the genuine 123) and fail at normalization. Proved
  // through the live fetch harness: primary page carries genuine 123, the
  // pending universe carries [123].
  const harness = [
    "'use strict';",
    "const https = require('https');",
    "const { EventEmitter } = require('events');",
    'https.request = (url, options, cb) => {',
    '  const href = url && url.href ? url.href : String(url);',
    '  const parsed = new URL(href);',
    '  const req = new EventEmitter();',
    '  req.end = () => {',
    '    process.nextTick(() => {',
    '      const res = new EventEmitter();',
    '      res.statusCode = 200;',
    '      cb(res);',
    "      let body = { has_more: false, transactions: [] };",
    "      if (parsed.pathname === '/v2/me' || parsed.pathname === '/v2/plaid_accounts'",
    "        || parsed.pathname === '/v2/manual_accounts' || parsed.pathname === '/v2/assets') {",
    '        body = {};',
    "      } else if (parsed.pathname === '/v2/categories') {",
    '        body = { categories: [] };',
    "      } else if (parsed.pathname === '/v2/tags') {",
    '        body = { tags: [] };',
    "      } else if (parsed.searchParams.get('include_pending') === 'true') {",
    "        body = { has_more: false, transactions: [{ id: 123, account_id: 1001, date: '2026-08-15', amount: 10, is_pending: false }] };",
    "      } else if (parsed.searchParams.get('is_pending') === 'true') {",
    "        body = { has_more: false, transactions: [{ id: [123], account_id: 1001, date: '2026-08-15', amount: 10, is_pending: true }] };",
    '      }',
    "      res.emit('data', Buffer.from(JSON.stringify(body)));",
    "      res.emit('end');",
    '    });',
    '  };',
    '  return req;',
    '};',
    `const O = require(${JSON.stringify(path.join(ROOT, 'scripts', 'provider-observe.js'))});`,
    "O.fetchLunchMoneyLive('test-token', '2026-08-16T18:00:00.000Z').then((payload) => {",
    '  const kinds = (payload.transactions || []).map(t => (Array.isArray(t.id) ? \'array\' : String(t.id)));',
    "  let threw = false; let message = '';",
    '  try {',
    '    O.normalizeLunchMoneyPayload(payload);',
    '  } catch (err) {',
    '    threw = true; message = String(err && err.message || err);',
    '  }',
    '  process.stdout.write(JSON.stringify({ count: (payload.transactions || []).length, kinds, threw, message }));',
    '}).catch((err) => {',
    '  process.stderr.write(String(err && err.message || err));',
    '  process.exit(1);',
    '});',
  ].join('\n');
  const fetched = JSON.parse(execFileSync(process.execPath, ['-e', harness], {
    cwd: ROOT,
    encoding: 'utf8',
  }));
  ok(fetched.count === 2 && fetched.kinds.includes('array') && fetched.kinds.includes('123'),
    'fetch merge never dedupes the array-ID row away against genuine 123 — both rows reach normalization',
    JSON.stringify(fetched));
  ok(fetched.threw === true && fetched.message === MISSING_ID,
    'the surviving array-ID row fails at normalization with the missing-id error — no silent disappearance',
    JSON.stringify(fetched));
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll provider-observe checks passed.');
