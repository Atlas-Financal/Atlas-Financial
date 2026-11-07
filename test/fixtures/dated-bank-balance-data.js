'use strict';
// Invented dated-bank-balance world: accounts, cents, bills and income are
// all invented. No data.json, raw/ or derived/ reads. Shared by
// test/test-dated-bank-balance.js (npm test) and
// test/browser-dated-bank-balance.js (the full browser page proof).
const fixture = require('./payday-gap-reserve-data');
const shell = require('./savings-daily-consumer-data');
const Live = require('../../scripts/live-plan.js');

const OPENING = '2026-09-29';
const TODAY = '2026-10-14';
const BALANCE_DAY = '2026-10-13';
const FETCHED_AT = '2026-10-14T18:00:00Z';           // Oct 14, 11:00 am Pacific
const TODAY_SYNC = '2026-10-14T17:55:00Z';           // Oct 14, 10:55 am Pacific
const LAST_EVENING = '2026-10-14T04:32:00Z';         // Oct 13, 9:32 pm Pacific
const TWO_DAYS_BACK = '2026-10-13T04:32:00Z';        // Oct 12, 9:32 pm Pacific
const OPENING_CASH = 83 + 30;                        // invented Bills + Weekly balances

const IDENTITY = {
  rules: [
    { eventId: 'giftD', payeePattern: 'INVENTED GIFT D', atlasAccountId: 'chequing-a',
      direction: 'credit', postingDateRule: 'covers-due-on-or-before-posting' },
    { eventId: 'giftT', payeePattern: 'INVENTED GIFT T', atlasAccountId: 'chequing-a', direction: 'credit' },
    { eventId: 'hydroD', payeePattern: 'INVENTED HYDRO', atlasAccountId: 'chequing-a',
      direction: 'debit', postingDateRule: 'covers-due-on-or-before-posting' },
  ],
  billPaymentPayees: [],
};

// dates: one balance_last_update per invented account id, or one for all.
function world(opts = {}) {
  const i = fixture.input();
  i.asOf = i.x.asOf = TODAY;
  i.window.endDate = TODAY;
  i.plan.income.push(
    { id: 'giftD', label: 'Invented deposit due on the balance day', frequency: 'once',
      date: BALANCE_DAY, amount: 200, confidence: 'confirmed' },
    { id: 'giftT', label: 'Invented deposit due today', frequency: 'once',
      date: TODAY, amount: 300, confidence: 'confirmed' });
  i.plan.bills = (i.plan.bills || []).concat([
    { id: 'water', label: 'Invented bill due today', frequency: 'once', date: TODAY,
      amount: 50, confidence: 'confirmed', account: 'chequing-a' },
    { id: 'hydroD', label: 'Invented bill due on the balance day', frequency: 'once', date: BALANCE_DAY,
      amount: 40, confidence: 'confirmed', account: 'chequing-a' }]);
  const canonical = shell('ready');
  canonical.meta = { asOf: OPENING, title: 'Invented dated-balance review' };
  canonical.plan = i.plan;
  canonical.debts = [];
  const payload = fixture.payload(i);
  payload.fetchedAt = opts.fetchedAt || FETCHED_AT;
  for (const account of payload.accounts) {
    account.updated_at = TODAY_SYNC;
    const at = opts.dates && Object.prototype.hasOwnProperty.call(opts.dates, account.id)
      ? opts.dates[account.id] : (opts.at === undefined ? TODAY_SYNC : opts.at);
    if (at === 'omit') delete account.balance_last_update;
    else account.balance_last_update = at;
  }
  for (const tx of opts.transactions || []) {
    payload.transactions.push({ id: tx.id, account_id: 9101, date: tx.date, amount: tx.amount,
      currency: 'CAD', is_pending: tx.pending === true, payee: tx.payee });
  }
  return { canonical, payload, accountMap: i.accountMap };
}

function observe(opts) {
  const w = world(opts);
  return Live.fromObservation({ data: w.canonical, payload: w.payload, accountMap: w.accountMap, identity: IDENTITY });
}

module.exports = { OPENING, TODAY, BALANCE_DAY, FETCHED_AT, TODAY_SYNC, LAST_EVENING,
  TWO_DAYS_BACK, OPENING_CASH, IDENTITY, world, observe };
