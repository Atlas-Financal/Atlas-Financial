'use strict';
/* Synthetic loopback proof for scripts/provider-recurring-items.js.
 *
 * Every fixture is invented. The stub provider runs on 127.0.0.1 only, the
 * token is a synthetic string, and no production call is possible: the
 * module accepts a non-default base only when it is loopback. Assertions
 * key on mapped field names and counts — raw provider fixture ids are
 * never printed.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Recurring = require('../scripts/provider-recurring-items');

const TOKEN = 'synthetic-test-token';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// A fully valid reviewed item per the pinned v2.11.1 recurringObject
// contract. `to_base` is present in the provider payload on purpose: the
// reader must omit it (Q2).
function validItem(overrides) {
  return Object.assign({
    id: 101,
    description: 'Synthetic streaming subscription',
    status: 'reviewed',
    transaction_criteria: {
      start_date: '2026-01-01',
      end_date: null,
      granularity: 'month',
      quantity: 1,
      anchor_date: '2026-01-15',
      payee: 'Synthetic Stream Co',
      amount: '15.9900',
      to_base: 11.99,
      currency: 'cad',
      plaid_account_id: 9001,
      manual_account_id: null,
    },
    overrides: { payee: 'Stream Co', category_id: 4242 },
    matches: {
      request_start_date: '2026-10-01',
      request_end_date: '2026-10-31',
      expected_occurrence_dates: ['2026-10-15'],
      found_transactions: [{ date: '2026-10-15', transaction_id: 777001 }],
      missing_transaction_dates: [],
    },
    created_by: 31337,
    created_at: '2026-01-02T03:04:05Z',
    updated_at: '2026-09-30T03:04:05Z',
    source: 'manual',
  }, overrides || {});
}

// Loopback stub: handler(requestCount) returns { status, body } where a
// string body is sent verbatim and anything else is JSON-encoded. Every
// request is recorded (method, URL, headers) for contract assertions.
async function withStub(handler, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, url, headers: req.headers });
    let outcome;
    try {
      outcome = handler(requests.length, url) || {};
    } catch (e) {
      outcome = { status: 500, body: { error: 'stub handler failed' } };
    }
    const status = outcome.status || 200;
    const payload = typeof outcome.body === 'string'
      ? outcome.body
      : JSON.stringify(outcome.body == null ? {} : outcome.body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v2`;
  try {
    await run(base, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Fetch a fixed item list through the stub and return the envelope.
async function fetchItems(items) {
  let out;
  await withStub(() => ({ body: { recurring_items: items } }), async (base) => {
    out = await Recurring.fetchRecurringItems({ token: TOKEN, base });
  });
  return out;
}

test('recurring-url-contract', async () => {
  await withStub(() => ({ body: { recurring_items: [] } }), async (base, requests) => {
    await Recurring.fetchRecurringItems({ startDate: '2026-10-01', endDate: '2026-10-31', token: TOKEN, base });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].url.pathname, '/v2/recurring_items');
    assert.equal(requests[0].url.searchParams.get('start_date'), '2026-10-01');
    assert.equal(requests[0].url.searchParams.get('end_date'), '2026-10-31');
    // include_suggested is always sent explicitly; module default false.
    assert.equal(requests[0].url.searchParams.get('include_suggested'), 'false');
    // No pagination parameters are ever sent — the endpoint is unpaginated.
    for (const key of ['limit', 'offset', 'has_more', 'cursor', 'page']) {
      assert.equal(requests[0].url.searchParams.get(key), null, `unexpected param ${key}`);
    }
    assert.equal(requests[0].headers.authorization, `Bearer ${TOKEN}`);
  });
  await withStub(() => ({ body: { recurring_items: [] } }), async (base, requests) => {
    await Recurring.fetchRecurringItems({ includeSuggested: true, token: TOKEN, base });
    assert.equal(requests[0].url.searchParams.get('include_suggested'), 'true');
  });
});

test('recurring-single-response-consumed-whole', async () => {
  const items = [validItem({ id: 1 }), validItem({ id: 2 }), validItem({ id: 3 })];
  await withStub(() => ({ body: { recurring_items: items } }), async (base, requests) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    assert.equal(requests.length, 1, 'exactly one GET — there is no paging to drive');
    assert.equal(result.itemCount, 3);
    assert.equal(result.items.length, 3);
    assert.equal(result.complete, true);
  });
});

test('recurring-valid-zero-and-decimal-strings', async () => {
  const amounts = ['0.0000', '0', '-12.3', '1250.8400'];
  const items = amounts.map((amount, i) => {
    const it = validItem({ id: 10 + i });
    it.transaction_criteria.amount = amount;
    return it;
  });
  await withStub(() => ({ body: { recurring_items: items } }), async (base) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    assert.deepEqual(result.items.map((i) => i.criteria.amount), amounts);
    assert.equal(result.complete, true);
    for (const item of result.items) assert.equal(typeof item.criteria.amount, 'string');
  });
});

test('recurring-malformed-monetary-types-fail-closed', async () => {
  const badAmounts = [12.5, '12.34567', 'abc', null, undefined];
  const items = badAmounts.map((amount, i) => {
    const it = validItem({ id: 20 + i });
    if (amount === undefined) delete it.transaction_criteria.amount;
    else it.transaction_criteria.amount = amount;
    return it;
  });
  await withStub(() => ({ body: { recurring_items: items } }), async (base) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    assert.equal(result.complete, false, 'malformed amounts make the read incomplete');
    for (const item of result.items) {
      assert.equal(item.criteria.amount, null, 'malformed amount is unavailable, never 0');
      assert(item.unavailableFields.includes('criteria.amount'));
    }
  });
});

test('recurring-dates-and-statuses-verbatim', async () => {
  await withStub(() => ({ body: { recurring_items: [validItem()] } }), async (base) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    const item = result.items[0];
    assert.equal(item.status, 'reviewed');
    assert.equal(item.criteria.granularity, 'month');
    assert.equal(item.criteria.quantity, 1);
    assert.equal(item.criteria.anchorDate, '2026-01-15');
    assert.equal(item.criteria.startDate, '2026-01-01');
    assert.equal(item.criteria.endDate, null);
    assert.equal(item.criteria.currency, 'cad');
    assert.equal(item.criteria.plaidAccountId, '9001');
    assert.equal(item.criteria.manualAccountId, null);
    assert.equal(item.description, 'Synthetic streaming subscription');
    assert.equal(item.createdAt, '2026-01-02T03:04:05Z');
    assert.equal(item.updatedAt, '2026-09-30T03:04:05Z');
    assert.equal(item.source, 'manual');
    // Matches are preserved verbatim; found ids stay internal strings.
    assert.deepEqual(item.matches, {
      requestStartDate: '2026-10-01',
      requestEndDate: '2026-10-31',
      expectedOccurrenceDates: ['2026-10-15'],
      foundTransactions: [{ date: '2026-10-15', transactionId: '777001' }],
      missingTransactionDates: [],
    });
    // Q2: the provider's own to_base conversion is never republished.
    assert.equal('toBase' in item.criteria, false);
    assert.equal(JSON.stringify(item).includes('to_base'), false);
    assert.equal(item.unavailableFields.length, 0);
  });
});

test('recurring-matches-null-for-suggested', async () => {
  const suggested = validItem({ id: 55, status: 'suggested', matches: null });
  await withStub(() => ({ body: { recurring_items: [suggested] } }), async (base) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    assert.equal(result.items[0].status, 'suggested');
    // Null matches on a suggested item is the documented state, not a
    // failure and not an empty match set.
    assert.equal(result.items[0].matches, null);
    assert.equal(result.items[0].unavailableFields.includes('matches'), false);
    assert.equal(result.complete, true);
  });
});

test('recurring-out-of-enum-unavailable-never-defaulted', async () => {
  const badStatus = validItem({ id: 61, status: 'active' });
  const badGranularity = validItem({ id: 62 });
  badGranularity.transaction_criteria.granularity = 'fortnight';
  await withStub(() => ({ body: { recurring_items: [badStatus, badGranularity] } }), async (base) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    assert.equal(result.items[0].status, null);
    assert.notEqual(result.items[0].status, 'reviewed', 'a bad status is never defaulted to reviewed');
    assert(result.items[0].unavailableFields.includes('status'));
    assert.equal(result.items[1].criteria.granularity, null);
    assert(result.items[1].unavailableFields.includes('criteria.granularity'));
    assert.equal(result.complete, false);
  });
});

test('recurring-criteria-nulls-preserved', async () => {
  const it = validItem({ id: 71 });
  it.transaction_criteria.start_date = null;
  it.transaction_criteria.end_date = null;
  it.transaction_criteria.payee = null;
  it.transaction_criteria.plaid_account_id = null;
  it.transaction_criteria.manual_account_id = null;
  await withStub(() => ({ body: { recurring_items: [it] } }), async (base) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    const criteria = result.items[0].criteria;
    assert.equal(criteria.startDate, null);
    assert.equal(criteria.endDate, null);
    assert.equal(criteria.payee, null);
    assert.equal(criteria.plaidAccountId, null);
    assert.equal(criteria.manualAccountId, null);
    // Documented nulls are not provider failures.
    assert.equal(result.items[0].unavailableFields.length, 0);
    assert.equal(result.complete, true);
  });
});

test('recurring-duplicates-fail-closed', async () => {
  const items = [validItem({ id: 81 }), validItem({ id: 81 })];
  await withStub(() => ({ body: { recurring_items: items } }), async (base) => {
    await assert.rejects(
      () => Recurring.fetchRecurringItems({ token: TOKEN, base }),
      /duplicate provider id/,
    );
  });
});

test('recurring-missing-identity-fails', async () => {
  const noId = validItem();
  delete noId.id;
  await withStub(() => ({ body: { recurring_items: [noId] } }), async (base) => {
    await assert.rejects(() => Recurring.fetchRecurringItems({ token: TOKEN, base }), /missing a valid provider id/);
  });
  for (const badId of ['abc', 0, -4, 1.5, null]) {
    await withStub(() => ({ body: { recurring_items: [validItem({ id: badId })] } }), async (base) => {
      await assert.rejects(() => Recurring.fetchRecurringItems({ token: TOKEN, base }), /missing a valid provider id/);
    });
  }
});

test('recurring-missing-sources-unavailable', async () => {
  const noCriteria = validItem({ id: 91 });
  delete noCriteria.transaction_criteria;
  const nullSource = validItem({ id: 92, source: null });
  delete nullSource.overrides;
  await withStub(() => ({ body: { recurring_items: [noCriteria, nullSource] } }), async (base) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    assert.equal(result.items[0].criteria, null);
    assert(result.items[0].unavailableFields.includes('criteria'));
    assert.equal(result.complete, false);
    // source: null on older items is documented unavailable provenance —
    // preserved as null, never an invented identity, and not a failure.
    assert.equal(result.items[1].source, null);
    assert.equal(result.items[1].unavailableFields.includes('source'), false);
    assert.equal(result.items[1].overrides, null);
  });
});

test('recurring-empty-result-is-empty', async () => {
  await withStub(() => ({ body: { recurring_items: [] } }), async (base) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    assert.deepEqual(result.items, []);
    assert.equal(result.itemCount, 0);
    assert.equal(result.complete, true, 'an empty list is a valid complete read');
    assert.equal(result.schema, 'atlas-lunchmoney-recurring-items/v1');
    assert.equal(result.caveat, Recurring.CAVEAT);
    assert.match(result.caveat, /not Forecast bills or obligations/);
    assert.match(result.caveat, /never proof of payment/);
    assert.match(result.caveat, /not evidence of an unpaid bill/);
  });
});

test('recurring-malformed-envelope-fails', async () => {
  for (const body of [{}, { recurring_items: {} }, { recurring_items: 'nope' }]) {
    await withStub(() => ({ body }), async (base) => {
      await assert.rejects(() => Recurring.fetchRecurringItems({ token: TOKEN, base }), /malformed/);
    });
  }
  await withStub(() => ({ body: '<html>not json</html>' }), async (base) => {
    await assert.rejects(() => Recurring.fetchRecurringItems({ token: TOKEN, base }), /not JSON/);
  });
  await withStub(() => ({ status: 500, body: { error: 'synthetic failure' } }), async (base) => {
    await assert.rejects(() => Recurring.fetchRecurringItems({ token: TOKEN, base }), /HTTP 500/);
  });
  await withStub(() => ({ status: 401, body: { error: 'synthetic auth failure' } }), async (base) => {
    const err = await Recurring.fetchRecurringItems({ token: TOKEN, base }).catch((e) => e);
    assert(err instanceof Error);
    assert.match(err.message, /rejected the access token/);
    assert.equal(err.message.includes(TOKEN), false, 'errors never carry the token');
  });
});

test('recurring-unexpected-pagination-evidence-incomplete', async () => {
  // A paging-shaped claim in the response means the list can never be
  // declared complete, even though the items parse.
  await withStub(() => ({ body: { recurring_items: [validItem()], has_more: true } }), async (base) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    assert.equal(result.items.length, 1);
    assert.equal(result.unexpectedPaginationEvidence, true);
    assert.equal(result.complete, false);
  });
  // Harmless unknown additive fields — on the envelope and on an item —
  // are tolerated, not rejected for existing.
  const withFuture = validItem();
  withFuture.some_future_field = { nested: true };
  await withStub(() => ({ body: { recurring_items: [withFuture], future_envelope_field: 1 } }), async (base) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    assert.equal(result.unexpectedPaginationEvidence, false);
    assert.equal(result.complete, true);
  });
});

test('recurring-invalid-date-rejected-before-request', async () => {
  await withStub(() => ({ body: { recurring_items: [] } }), async (base, requests) => {
    await assert.rejects(() => Recurring.fetchRecurringItems({ startDate: '2026-02-30', endDate: '2026-03-01', token: TOKEN, base }), /real YYYY-MM-DD calendar date/);
    await assert.rejects(() => Recurring.fetchRecurringItems({ startDate: '10/01/2026', endDate: '2026-10-31', token: TOKEN, base }), /real YYYY-MM-DD calendar date/);
    await assert.rejects(() => Recurring.fetchRecurringItems({ startDate: '2026-10-01', token: TOKEN, base }), /both or neither/);
    await assert.rejects(() => Recurring.fetchRecurringItems({ endDate: '2026-10-31', token: TOKEN, base }), /both or neither/);
    assert.equal(requests.length, 0, 'invalid windows are rejected before any request');
  });
});

test('recurring-reversed-range-rejected-before-request', async () => {
  await withStub(() => ({ body: { recurring_items: [] } }), async (base, requests) => {
    await assert.rejects(
      () => Recurring.fetchRecurringItems({ startDate: '2026-10-31', endDate: '2026-10-01', token: TOKEN, base }),
      /must not be before startDate/,
    );
    assert.equal(requests.length, 0);
  });
});

test('recurring-window-distinguishable', async () => {
  await withStub(() => ({ body: { recurring_items: [] } }), async (base, requests) => {
    const defaulted = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    // No caller dates: providerDefault is recorded and the effective
    // (provider-chosen) dates are never invented.
    assert.deepEqual(defaulted.requestedWindow, { startDate: null, endDate: null, providerDefault: true });
    assert.equal(requests[0].url.searchParams.get('start_date'), null);
    assert.equal(requests[0].url.searchParams.get('end_date'), null);
    const explicit = await Recurring.fetchRecurringItems({ startDate: '2026-09-01', endDate: '2026-09-30', token: TOKEN, base });
    assert.deepEqual(explicit.requestedWindow, { startDate: '2026-09-01', endDate: '2026-09-30', providerDefault: false });
  });
});

test('recurring-no-token-no-request', async () => {
  await withStub(() => ({ body: { recurring_items: [] } }), async (base, requests) => {
    await assert.rejects(() => Recurring.fetchRecurringItems({ base }), /no Lunch Money credential/);
    await assert.rejects(() => Recurring.fetchRecurringItems({ token: '', base }), /no Lunch Money credential/);
    assert.equal(requests.length, 0);
  });
});

test('recurring-redirect-not-followed', async () => {
  // Authorization is never forwarded across a redirect: a 3xx is an
  // error, and the redirect target is never requested.
  const seenPaths = [];
  const server = http.createServer((req, res) => {
    seenPaths.push(req.url);
    if (req.url.startsWith('/v2/recurring_items')) {
      res.writeHead(302, { Location: '/v2/elsewhere' });
      res.end('');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ recurring_items: [] }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v2`;
  try {
    await assert.rejects(() => Recurring.fetchRecurringItems({ token: TOKEN, base }), /HTTP 302/);
    assert.deepEqual(seenPaths.length, 1, 'the redirect target was never requested');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('recurring-response-size-bound', async () => {
  const huge = validItem();
  huge.description = 'x'.repeat(9 * 1024 * 1024);
  await withStub(() => ({ body: { recurring_items: [huge] } }), async (base) => {
    await assert.rejects(() => Recurring.fetchRecurringItems({ token: TOKEN, base }), /maximum size/);
  });
});

test('recurring-no-consumer-wiring', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'provider-recurring-items.js'), 'utf8');
  const requires = Array.from(source.matchAll(/require\('([^']+)'\)/g), (m) => m[1]);
  assert.deepEqual(
    requires.sort(),
    ['./provider-observe.js', 'node:http', 'node:https'],
    'the module may require only node http/https and the incumbent provider module',
  );
  for (const target of requires) {
    for (const forbidden of ['forecast', 'server', 'assistant', 'scheduler', 'recurring-audit', 'canonical']) {
      assert.equal(target.includes(forbidden), false, `module must not require ${forbidden}`);
    }
  }
});

// --- Repair regressions (Systems Review 5479465980) ---------------------
// Each case below is ISOLATED: it starts from an otherwise fully valid
// item and changes exactly one thing, so a failure names one rule.

test('recurring-missing-description-unavailable', async () => {
  const it = validItem();
  delete it.description;
  const result = await fetchItems([it]);
  assert.equal(result.items[0].description, null);
  assert(result.items[0].unavailableFields.includes('description'));
  assert.equal(result.complete, false);
});

test('recurring-null-description-is-documented-null', async () => {
  // Absence is not null: a PRESENT null description is the documented
  // state and must not be flagged — the pair to the deletion case above.
  const result = await fetchItems([validItem({ description: null })]);
  assert.equal(result.items[0].description, null);
  assert.equal(result.items[0].unavailableFields.includes('description'), false);
  assert.equal(result.complete, true);
});

test('recurring-missing-overrides-unavailable', async () => {
  const it = validItem();
  delete it.overrides;
  const result = await fetchItems([it]);
  assert.equal(result.items[0].overrides, null);
  assert(result.items[0].unavailableFields.includes('overrides'));
  assert.equal(result.complete, false);
});

test('recurring-null-overrides-unavailable', async () => {
  // overrides is a required, non-nullable object in the pinned spec.
  const result = await fetchItems([validItem({ overrides: null })]);
  assert.equal(result.items[0].overrides, null);
  assert(result.items[0].unavailableFields.includes('overrides'));
  assert.equal(result.complete, false);
});

test('recurring-override-null-payee-unavailable', async () => {
  const result = await fetchItems([validItem({ overrides: { payee: null } })]);
  assert(result.items[0].unavailableFields.includes('overrides.payee'));
  assert.equal('payee' in result.items[0].overrides, false);
  assert.equal(result.complete, false);
});

test('recurring-override-null-notes-unavailable', async () => {
  const result = await fetchItems([validItem({ overrides: { notes: null } })]);
  assert(result.items[0].unavailableFields.includes('overrides.notes'));
  assert.equal('notes' in result.items[0].overrides, false);
  assert.equal(result.complete, false);
});

test('recurring-override-null-category-unavailable', async () => {
  const result = await fetchItems([validItem({ overrides: { category_id: null } })]);
  assert(result.items[0].unavailableFields.includes('overrides.categoryId'));
  assert.equal('categoryId' in result.items[0].overrides, false);
  assert.equal(result.complete, false);
});

test('recurring-override-category-out-of-domain-unavailable', async () => {
  // Category ids are int32 in the pinned spec.
  const result = await fetchItems([validItem({ overrides: { category_id: 2147483648 } })]);
  assert(result.items[0].unavailableFields.includes('overrides.categoryId'));
  assert.equal(result.complete, false);
});

test('recurring-missing-matches-key-unavailable', async () => {
  const it = validItem();
  delete it.matches;
  const result = await fetchItems([it]);
  assert.equal(result.items[0].matches, null);
  assert(result.items[0].unavailableFields.includes('matches'));
  assert.equal(result.complete, false);
});

test('recurring-missing-source-key-unavailable', async () => {
  // A present null source is documented (older items); an ABSENT source
  // key violates the required list and is unavailable provenance.
  const it = validItem();
  delete it.source;
  const result = await fetchItems([it]);
  assert.equal(result.items[0].source, null);
  assert(result.items[0].unavailableFields.includes('source'));
  assert.equal(result.complete, false);
});

test('recurring-missing-criteria-start-date-unavailable', async () => {
  const it = validItem();
  delete it.transaction_criteria.start_date;
  const result = await fetchItems([it]);
  assert.equal(result.items[0].criteria.startDate, null);
  assert(result.items[0].unavailableFields.includes('criteria.startDate'));
  assert.equal(result.complete, false);
});

test('recurring-missing-criteria-end-date-unavailable', async () => {
  const it = validItem();
  delete it.transaction_criteria.end_date;
  const result = await fetchItems([it]);
  assert.equal(result.items[0].criteria.endDate, null);
  assert(result.items[0].unavailableFields.includes('criteria.endDate'));
  assert.equal(result.complete, false);
});

test('recurring-missing-criteria-payee-unavailable', async () => {
  const it = validItem();
  delete it.transaction_criteria.payee;
  const result = await fetchItems([it]);
  assert.equal(result.items[0].criteria.payee, null);
  assert(result.items[0].unavailableFields.includes('criteria.payee'));
  assert.equal(result.complete, false);
});

test('recurring-missing-criteria-plaid-account-unavailable', async () => {
  const it = validItem();
  delete it.transaction_criteria.plaid_account_id;
  const result = await fetchItems([it]);
  assert.equal(result.items[0].criteria.plaidAccountId, null);
  assert(result.items[0].unavailableFields.includes('criteria.plaidAccountId'));
  assert.equal(result.complete, false);
});

test('recurring-missing-criteria-manual-account-unavailable', async () => {
  const it = validItem();
  delete it.transaction_criteria.manual_account_id;
  const result = await fetchItems([it]);
  assert.equal(result.items[0].criteria.manualAccountId, null);
  assert(result.items[0].unavailableFields.includes('criteria.manualAccountId'));
  assert.equal(result.complete, false);
});

test('recurring-primary-id-int32-boundary', async () => {
  // int32 max is a valid item id, as a number and as a digit string.
  const asNumber = await fetchItems([validItem({ id: 2147483647 })]);
  assert.equal(asNumber.items[0].providerId, '2147483647');
  assert.equal(asNumber.complete, true);
  const asString = await fetchItems([validItem({ id: '2147483647' })]);
  assert.equal(asString.items[0].providerId, '2147483647');
  assert.equal(asString.complete, true);
});

test('recurring-primary-id-out-of-domain-fails', async () => {
  // The reviewer's corruption class: a digit string beyond the
  // exact-integer range, which Number() coercion would silently round.
  // It is also outside the int32 item-id domain, so the read fails
  // closed instead of keying on a rounded id.
  await withStub(() => ({ body: { recurring_items: [validItem({ id: '18014398509481985' })] } }), async (base) => {
    await assert.rejects(() => Recurring.fetchRecurringItems({ token: TOKEN, base }), /missing a valid provider id/);
  });
  await withStub(() => ({ body: { recurring_items: [validItem({ id: 2147483648 })] } }), async (base) => {
    await assert.rejects(() => Recurring.fetchRecurringItems({ token: TOKEN, base }), /missing a valid provider id/);
  });
});

test('recurring-secondary-id-preserved-exactly', async () => {
  // Account ids are int64: these digit strings are in-domain and must be
  // preserved EXACTLY. Under Number() coercion the two DISTINCT values
  // below collapse to the same number (asserted here so the fixture can
  // never silently stop proving the point) — the old mapping rounded
  // one into the other; the exact mapping must not.
  const a = validItem({ id: 201 });
  a.transaction_criteria.plaid_account_id = '18014398509481985';
  const b = validItem({ id: 202 });
  b.transaction_criteria.plaid_account_id = '18014398509481986';
  assert.equal(Number('18014398509481985'), Number('18014398509481986'),
    'fixture premise: Number() coercion collides these distinct ids');
  const result = await fetchItems([a, b]);
  assert.equal(result.items[0].criteria.plaidAccountId, '18014398509481985');
  assert.equal(result.items[1].criteria.plaidAccountId, '18014398509481986');
  assert.equal(result.complete, true);
});

test('recurring-secondary-id-int64-boundary', async () => {
  const it = validItem();
  it.transaction_criteria.manual_account_id = '9223372036854775807';
  const result = await fetchItems([it]);
  assert.equal(result.items[0].criteria.manualAccountId, '9223372036854775807');
  assert.equal(result.complete, true);
});

test('recurring-secondary-id-beyond-int64-unavailable', async () => {
  // One past int64 max, and a value so large Number() made it "Infinity":
  // both are out-of-domain secondary identities — unavailable field, the
  // read itself continues (the agreed Q5 secondary policy).
  const a = validItem({ id: 211 });
  a.transaction_criteria.plaid_account_id = '9223372036854775808';
  const ra = await fetchItems([a]);
  assert.equal(ra.items[0].criteria.plaidAccountId, null);
  assert(ra.items[0].unavailableFields.includes('criteria.plaidAccountId'));
  assert.equal(ra.complete, false);
  const b = validItem({ id: 212 });
  b.transaction_criteria.plaid_account_id = '99999999999999999999999999';
  const rb = await fetchItems([b]);
  assert.equal(rb.items[0].criteria.plaidAccountId, null);
  assert(rb.items[0].unavailableFields.includes('criteria.plaidAccountId'));
  assert.equal(rb.complete, false);
});

test('recurring-identity-representations-collide-loudly', async () => {
  // A number and its digit-string form are the SAME identity: they must
  // hit the duplicate guard, never coexist as two distinct keys.
  const items = [validItem({ id: 42 }), validItem({ id: '42' })];
  await withStub(() => ({ body: { recurring_items: items } }), async (base) => {
    await assert.rejects(() => Recurring.fetchRecurringItems({ token: TOKEN, base }), /duplicate provider id/);
  });
});

test('recurring-created-by-out-of-domain-unavailable', async () => {
  // created_by is a secondary identity (user id, int32): out-of-domain is
  // unavailable provenance, not a whole-read failure.
  const result = await fetchItems([validItem({ created_by: '2147483648' })]);
  assert.equal(result.items[0].createdBy, null);
  assert(result.items[0].unavailableFields.includes('createdBy'));
  assert.equal(result.complete, false);
});

test('recurring-duplicate-error-leaks-no-provider-id', async () => {
  const items = [validItem({ id: 2147483001 }), validItem({ id: '2147483001' })];
  await withStub(() => ({ body: { recurring_items: items } }), async (base) => {
    const err = await Recurring.fetchRecurringItems({ token: TOKEN, base }).catch((e) => e);
    assert(err instanceof Error);
    assert.match(err.message, /duplicate provider id/);
    // The raw provider identity must never appear in an outward error.
    assert.equal(err.message.includes('2147483001'), false);
    assert.equal(String(err).includes('2147483001'), false);
    assert.equal(JSON.stringify(err).includes('2147483001'), false);
  });
});

test('recurring-date-only-created-at-unavailable', async () => {
  // created_at is a date-TIME: a date-only string parses under
  // Date.parse but is not a timestamp.
  const result = await fetchItems([validItem({ created_at: '2026-01-02' })]);
  assert.equal(result.items[0].createdAt, null);
  assert(result.items[0].unavailableFields.includes('createdAt'));
  assert.equal(result.complete, false);
});

test('recurring-date-only-updated-at-unavailable', async () => {
  const result = await fetchItems([validItem({ updated_at: '2026-09-30' })]);
  assert.equal(result.items[0].updatedAt, null);
  assert(result.items[0].unavailableFields.includes('updatedAt'));
  assert.equal(result.complete, false);
});

test('recurring-timestamp-forms-preserved', async () => {
  const result = await fetchItems([validItem({
    created_at: '2026-01-02T03:04:05.123Z',
    updated_at: '2026-09-30T03:04:05+00:00',
  })]);
  assert.equal(result.items[0].createdAt, '2026-01-02T03:04:05.123Z');
  assert.equal(result.items[0].updatedAt, '2026-09-30T03:04:05+00:00');
  assert.equal(result.complete, true);
});

test('recurring-criteria-reversed-range-unavailable', async () => {
  const it = validItem();
  it.transaction_criteria.start_date = '2026-06-01';
  it.transaction_criteria.end_date = '2026-01-01';
  const result = await fetchItems([it]);
  // Neither bound can be trusted once the pair is reversed.
  assert.equal(result.items[0].criteria.startDate, null);
  assert.equal(result.items[0].criteria.endDate, null);
  assert(result.items[0].unavailableFields.includes('criteria.startDate'));
  assert(result.items[0].unavailableFields.includes('criteria.endDate'));
  assert.equal(result.complete, false);
});

test('recurring-matches-reversed-window-unavailable', async () => {
  const it = validItem();
  it.matches.request_start_date = '2026-10-31';
  it.matches.request_end_date = '2026-10-01';
  const result = await fetchItems([it]);
  assert.equal(result.items[0].matches, null);
  assert(result.items[0].unavailableFields.includes('matches'));
  assert.equal(result.complete, false);
});

test('recurring-matches-membership-not-enforced', async () => {
  // Determination (header R4): the pinned spec describes occurrence
  // dates as "within the range" in prose only — no schema constraint or
  // clipping guarantee — so membership is NOT enforced. Out-of-window
  // provider evidence is reported verbatim, never discarded.
  const it = validItem();
  it.matches.expected_occurrence_dates = ['2026-11-15'];
  it.matches.found_transactions = [{ date: '2026-11-15', transaction_id: 777002 }];
  it.matches.missing_transaction_dates = ['2026-09-15'];
  const result = await fetchItems([it]);
  assert.deepEqual(result.items[0].matches.expectedOccurrenceDates, ['2026-11-15']);
  assert.deepEqual(result.items[0].matches.foundTransactions, [{ date: '2026-11-15', transactionId: '777002' }]);
  assert.deepEqual(result.items[0].matches.missingTransactionDates, ['2026-09-15']);
  assert.equal(result.items[0].unavailableFields.length, 0);
  assert.equal(result.complete, true);
});

test('recurring-unsafe-numeric-account-id-unavailable-raw-json', async () => {
  // Isolated RAW-JSON regression (Systems Review 5479885271, R5): the
  // provider body carries the account id as an UNQUOTED JSON number
  // beyond the safe-integer range. JSON.parse rounds it before any
  // mapping runs (premise asserted below), so an object fixture built
  // in JS cannot express this case — the stub must send the literal.
  // The rounded value must never be published as the identity.
  const rawItem = JSON.stringify(validItem({ id: 221 }));
  const raw = `{"recurring_items":[${rawItem.replace('"plaid_account_id":9001', '"plaid_account_id":18014398509481985')}]}`;
  assert.equal(JSON.parse(raw).recurring_items[0].transaction_criteria.plaid_account_id, 18014398509481984,
    'fixture premise: JSON.parse rounds the unsafe numeric literal');
  assert.equal(Number.isSafeInteger(JSON.parse(raw).recurring_items[0].transaction_criteria.plaid_account_id), false);
  await withStub(() => ({ body: raw }), async (base) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    assert.equal(result.items[0].criteria.plaidAccountId, null);
    assert(result.items[0].unavailableFields.includes('criteria.plaidAccountId'));
    assert.equal(result.complete, false);
  });
  // Same exposure on the manual account id.
  const raw2 = `{"recurring_items":[${rawItem.replace('"manual_account_id":null', '"manual_account_id":18014398509481985')}]}`;
  await withStub(() => ({ body: raw2 }), async (base) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    assert.equal(result.items[0].criteria.manualAccountId, null);
    assert(result.items[0].unavailableFields.includes('criteria.manualAccountId'));
    assert.equal(result.complete, false);
  });
});

test('recurring-unsafe-numeric-found-transaction-id-unavailable-raw-json', async () => {
  // R5, found-transaction case: an unsafe unquoted transaction_id inside
  // matches.found_transactions invalidates the matches object (the
  // existing bad-found-transaction policy) instead of publishing the
  // rounded identity with complete:true.
  const rawItem = JSON.stringify(validItem({ id: 222 }));
  const raw = `{"recurring_items":[${rawItem.replace('"transaction_id":777001', '"transaction_id":18014398509481985')}]}`;
  assert.equal(JSON.parse(raw).recurring_items[0].matches.found_transactions[0].transaction_id, 18014398509481984,
    'fixture premise: JSON.parse rounds the unsafe numeric literal');
  await withStub(() => ({ body: raw }), async (base) => {
    const result = await Recurring.fetchRecurringItems({ token: TOKEN, base });
    assert.equal(result.items[0].matches, null);
    assert(result.items[0].unavailableFields.includes('matches'));
    assert.equal(result.complete, false);
  });
});

test('recurring-unsafe-numeric-primary-id-fails-raw-json', async () => {
  // R5, primary case: the item id itself arrives as an UNQUOTED JSON
  // number beyond the safe-integer range. JSON.parse rounds it before
  // any mapping runs (premise asserted below) — the read must fail
  // closed on identity, never key the item by the rounded (wrong) id.
  // (The within-bounds publication hazard is the int64 secondary case,
  // covered by the raw-JSON account / found-transaction regressions.)
  const rawItem = JSON.stringify(validItem({ id: 224 }));
  const raw = `{"recurring_items":[${rawItem.replace('"id":224', '"id":18014398509481985')}]}`;
  assert.equal(JSON.parse(raw).recurring_items[0].id, 18014398509481984,
    'fixture premise: JSON.parse rounds the unsafe numeric literal');
  assert.equal(Number.isSafeInteger(JSON.parse(raw).recurring_items[0].id), false);
  await withStub(() => ({ body: raw }), async (base) => {
    await assert.rejects(
      () => Recurring.fetchRecurringItems({ token: TOKEN, base }),
      /missing a valid provider id/,
    );
  });
});

test('recurring-safe-numeric-secondary-ids-still-accepted', async () => {
  // R5 boundary: safe-integer JSON numbers remain valid identities —
  // only unsafe (already-rounded) numbers are rejected.
  const result = await fetchItems([validItem({ id: 223 })]);
  assert.equal(result.items[0].criteria.plaidAccountId, '9001');
  assert.deepEqual(result.items[0].matches.foundTransactions, [{ date: '2026-10-15', transactionId: '777001' }]);
  assert.equal(result.complete, true);
});

test('recurring-present-null-match-request-date-unavailable', async () => {
  // R6: request dates inside matches are date strings per the pinned
  // schema, NOT nullable — a present null is malformed, unlike absence.
  const a = validItem({ id: 231 });
  a.matches.request_start_date = null;
  const ra = await fetchItems([a]);
  assert.equal(ra.items[0].matches, null);
  assert(ra.items[0].unavailableFields.includes('matches'));
  assert.equal(ra.complete, false);
  const b = validItem({ id: 232 });
  b.matches.request_end_date = null;
  const rb = await fetchItems([b]);
  assert.equal(rb.items[0].matches, null);
  assert(rb.items[0].unavailableFields.includes('matches'));
  assert.equal(rb.complete, false);
});

test('recurring-absent-match-request-dates-allowed', async () => {
  // R6 counterpart: absence invents no failure — the spec lists no
  // required keys inside matches, so missing request dates map to null
  // window bounds and the matches object is still reported.
  const it = validItem({ id: 233 });
  delete it.matches.request_start_date;
  delete it.matches.request_end_date;
  const result = await fetchItems([it]);
  assert.equal(result.items[0].matches.requestStartDate, null);
  assert.equal(result.items[0].matches.requestEndDate, null);
  assert.equal(result.items[0].unavailableFields.length, 0);
  assert.equal(result.complete, true);
});

test('recurring-timezone-less-timestamp-unavailable', async () => {
  // R7 determination: the pinned date-time contract is RFC 3339, which
  // requires a time offset — timezone-less acceptance was only
  // Date.parse permissiveness and is not supported.
  const a = await fetchItems([validItem({ id: 241, created_at: '2026-01-02T03:04:05' })]);
  assert.equal(a.items[0].createdAt, null);
  assert(a.items[0].unavailableFields.includes('createdAt'));
  assert.equal(a.complete, false);
  const b = await fetchItems([validItem({ id: 242, updated_at: '2026-09-30T03:04:05' })]);
  assert.equal(b.items[0].updatedAt, null);
  assert(b.items[0].unavailableFields.includes('updatedAt'));
  assert.equal(b.complete, false);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
    } catch (err) {
      console.error(`FAIL - ${name}`);
      throw err;
    }
    passed += 1;
    console.log(`ok - ${name}`);
  }
  console.log(`All provider-recurring-items checks passed (${passed} named tests).`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
