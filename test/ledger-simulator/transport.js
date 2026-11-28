'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const Observer = require('../../scripts/provider-observe');
const { ids, date, providerId } = require('./household');

const faults = {
  'account-behind': {
    rate: 0.035,
    account: 'weekly',
    fields: ['cash'],
    edit(p, d, previousWeekly) {
      const a = p.plaid_accounts.find((a) => a.id === providerId('weekly'));
      a.balance_last_update = date(d - 1) + 'T12:00:00Z';
      a.balance = String(previousWeekly);
    },
  },
  'missing-balance': {
    rate: 0.02,
    account: 'weekly',
    fields: ['cash'],
    edit(p) {
      delete p.plaid_accounts.find((a) => a.id === providerId('weekly')).balance;
    },
  },
  'thin-card': {
    rate: 0.04,
    account: 'card',
    fields: ['cardSpent', 'cardPaid'],
    edit(p) {
      delete p.plaid_accounts.find((a) => a.id === providerId('card')).last_fetch;
    },
  },
  'unmapped-account': {
    rate: 0.018,
    fields: ['groceries', 'spending'],
    row(r) {
      r.plaid_account_id = 999601;
    },
  },
  'foreign-currency': {
    rate: 0.015,
    fields: ['groceries', 'spending'],
    row(r) {
      r.currency = 'eur';
    },
  },
  'foreign-card': {
    rate: 0.012,
    fields: ['cardSpent', 'groceries', 'spending'],
    target: (day) => 415000 + 2 * Math.floor(day / 14),
    row(r) {
      r.currency = 'eur';
    },
  },
  'thin-payer': {
    rate: 0.012,
    account: 'bills',
    fields: ['cardPaid', 'linePaid'],
    edit(p) {
      delete p.plaid_accounts.find((a) => a.id === providerId('bills')).last_fetch;
    },
  },
  'malformed-statement': {
    rate: 0.006,
    account: 'card',
    fields: ['cardPaid', 'billLoad', 'bad', 'surplus', 'billsEnd'],
    plan(p) {
      p.obligations[0].statementOccurrences = [{ scheduledDate: 'unreadable', minimum: null }];
    },
  },
  'malformed-amount': {
    rate: 0.015,
    fields: ['groceries', 'spending'],
    row(r) {
      r.amount = 'unreadable';
    },
  },
  'edit-between-pages': { rate: 0.012, fields: ['groceries', 'spending'], between: true },
};

// Route the production reader's loopback GETs in-process. No request is delegated.
// An overlapping page boundary delivers the target twice. Page 1 precedes the
// edit. Page 2 reads the new value from the same in-memory record.
async function fetchPayload(source, day, faultName, previousWeekly) {
  const p = structuredClone(source),
    f = faults[faultName];
  const targetId = f?.target?.(day) ?? 410000 + day;
  const target = p.transactions.find((t) => t.id === targetId);
  if (f?.row || f?.between) assert.ok(target, 'fault must reach the designated posted row');
  f?.edit?.(p, day, previousWeekly);
  f?.row?.(target);
  const rows = p.transactions.filter((t) => t.date >= p.transactionWindow.startDate);
  const overlap = f?.between || faultName === 'stable-pages';
  if (overlap) {
    rows.splice(rows.indexOf(target), 1);
    rows.unshift(target, target);
  }
  const trace = [];
  const original = http.request;
  function response(url) {
    const u = new URL(url);
    assert.equal(u.hostname, '127.0.0.1');
    const endpoint = u.pathname.split('/').pop();
    if (endpoint === 'transactions') {
      if (u.searchParams.get('is_pending') === 'true')
        return { has_more: false, transactions: p.transactions.filter((t) => t.is_pending) };
      const offset = Number(u.searchParams.get('offset')),
        limit = Number(u.searchParams.get('limit'));
      if (f?.between && offset === 1) {
        target.category_id = ids.Restaurants;
      }
      const slice = rows.slice(offset, offset + limit);
      if (f?.between && offset <= 1) trace.push([offset, slice[0]?.id, slice[0]?.category_id]);
      return { has_more: offset + limit < rows.length, transactions: slice };
    }
    switch (endpoint) {
      case 'me':
        return { account_id: 731001 };
      case 'plaid_accounts':
        return { plaid_accounts: p.plaid_accounts };
      case 'manual_accounts':
        return { manual_accounts: [] };
      case 'categories':
        return { categories: p.categories };
      case 'tags':
        return { tags: p.tags };
      case 'recurring_items':
        return { recurring_items: [], has_more: false };
      case 'settings':
      case 'summary':
        return {};
      default:
        throw Error('Unhandled synthetic transport read ' + endpoint);
    }
  }
  http.request = (url, options, cb) => {
    assert.equal(options.method, 'GET');
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.end = () =>
      queueMicrotask(() => {
        try {
          const data = response(url);
          const res = new EventEmitter();
          res.statusCode = 200;
          cb(res);
          res.emit('data', Buffer.from(JSON.stringify(data)));
          res.emit('end');
        } catch (err) {
          req.emit('error', err);
        }
      });
    return req;
  };
  try {
    const payload = await Observer.fetchLunchMoneyLive('invented-fixture', p.fetchedAt, 120, {
      env: { ATLAS_LUNCHMONEY_API_BASE: 'http://127.0.0.1/v2' },
      limit: overlap ? 1 : 200,
      maxPages: rows.length + 2,
    });
    if (f?.between) {
      assert.deepEqual(trace, [
        [0, targetId, ids.Groceries],
        [1, targetId, ids.Restaurants],
      ]);
      assert.deepEqual(
        payload.transactions.filter((t) => t.id === targetId).map((t) => t.category_id),
        [ids.Groceries, ids.Restaurants]
      );
    }
    return payload;
  } finally {
    http.request = original;
  }
}
module.exports = { faults, fetchPayload };
