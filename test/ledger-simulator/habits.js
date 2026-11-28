'use strict';

const { account, date, draw, ids, labels, offset, providerId, terms } = require('./household');

// Each entry has its own probability per eligible day. CLI overrides are independent.
// A purchase's journal posting and its bank representations have different identities.
const habits = {};
function register(names, rate, build, eligible = () => true) {
  for (const name of names.split(' ')) habits[name] = { rate, build, eligible };
}
register('topup topup-late topup-pending topup-receive-first topup-reused-reference', 0.07, (b, name) => {
  for (let i = 0; i < 3; i++)
    b.move('bills', 'weekly', b.amount + i, {
      lag: name === 'topup-late' ? 2 : 0,
      pending: name === 'topup-pending',
      senderLag: name === 'topup-receive-first' ? 1 : 0,
      ref: name === 'topup-reused-reference' ? 'AA713' : undefined,
    });
});
register(
  'card-bills card-weekly card-pool card-reserve card-studio card-noted card-late card-pending-receipt card-pending-debit card-odd card-missing-receipt',
  0.016,
  (b, n) => {
    const payer = n.slice(5);
    b.move(Object.hasOwn(account, payer) ? payer : 'bills', 'card', b.amount + 3, {
      noted: n === 'card-noted',
      lag: n === 'card-late' ? 4 : n === 'card-missing-receipt' ? 9 : 0,
      pending: n === 'card-pending-receipt',
      payerPending: n === 'card-pending-debit',
    });
  }
);
register('equal-card equal-two-cards', 0.026, (b, n) => {
  b.move('bills', 'card', b.amount);
  b.move('bills', n === 'equal-card' ? 'card' : 'second', b.amount, { at: n === 'equal-card' ? 2 : 0 });
});
register('line-draw line-payment line-roundtrip', 0.028, (b, n) => {
  if (n !== 'line-payment') b.move('line', 'bills', b.t.lineMin);
  if (n !== 'line-draw') b.move('bills', 'line', b.t.lineMin, { noted: true });
});
register('near-minimum', 0.035, (b) =>
  b.out('bills', b.t.min, 'Payment, Transfer', { payee: 'INTERAC E-TRANSFER SENT' })
);
register('etransfer-in etransfer-in-noted etransfer-out etransfer-out-noted pass-through', 0.025, (b, n) => {
  const noted = n.endsWith('-noted');
  if (n.includes('-in') || n === 'pass-through')
    b.out('bills', -b.amount, noted ? 'Income' : 'Transfer', {
      payee: 'INTERAC E-TRANSFER RECEIVED',
      notes: noted ? 'Invented reimbursement' : null,
    });
  if (n.includes('-out') || n === 'pass-through')
    b.out('bills', b.amount, 'Transfer', {
      payee: 'INTERAC E-TRANSFER SENT',
      notes: noted ? 'Invented shared cost' : null,
    });
});
register(
  'park-return studio-payday studio-income studio-expense studio-groceries overdraft',
  0.009,
  (b, n) => {
    if (n === 'park-return') {
      b.move('bills', 'pool', b.amount);
      b.move('pool', 'bills', b.amount, { at: 3 });
      b.purchase('bills', b.amount, 'Household', { at: 4 });
    }
    if (n === 'studio-payday') b.move('studio', 'bills', b.t.pay - 611);
    if (n === 'studio-income') b.out('studio', -b.amount, 'Income');
    if (n === 'studio-expense') b.out('studio', b.amount, 'Craft supplies');
    if (n === 'studio-groceries') b.purchase('studio', b.amount, 'Groceries');
    if (n === 'overdraft') {
      b.purchase('weekly', 340121, 'Household');
      b.move('bills', 'weekly', 340121, { at: 2 });
    }
  },
  (d, n) => n !== 'studio-payday' || d % 14 === 10
);
register(
  'paypal-purchase paypal-transfer shopping unnamed-category true-duplicate rekeyed-duplicate repeat-purchase',
  0.045,
  (b, n) => {
    const label =
      { shopping: 'Shopping', 'unnamed-category': 'Hobbies', 'paypal-transfer': 'Transfer' }[n] ||
      'Groceries';
    const r = b.purchase('weekly', b.amount, label, {
      payee: n.startsWith('paypal') ? 'PAYPAL *INVENTED MARKET' : 'Invented market',
    });
    if (n === 'true-duplicate' || n === 'rekeyed-duplicate') b.copy(r, n === 'true-duplicate');
    if (n === 'repeat-purchase') b.purchase('weekly', b.amount, label);
  }
);
for (const label of labels)
  register('category-' + ids[label], 0.003, (b) => b.purchase('weekly', b.amount, label));
register(
  'bill-bills bill-weekly bill-renamed bill-above bill-below bill-early bill-late subscription-paypal',
  0.45,
  (b, n) => {
    const sub = n === 'subscription-paypal';
    const cents = sub
      ? b.t.subscription
      : n === 'bill-above'
        ? 2 * b.t.bill
        : n === 'bill-below'
          ? b.t.bill - 991
          : b.t.bill;
    b.out(n === 'bill-weekly' ? 'weekly' : 'bills', cents, sub ? 'Subscriptions' : 'Utilities', {
      payee: sub ? 'PAYPAL *ORBIT' : n === 'bill-renamed' ? 'Invented firing room' : 'Invented kiln',
    });
  },
  (d, n) => Number(date(d).slice(-2)) === (n === 'bill-early' ? 9 : n === 'bill-late' ? 16 : 12)
);
register(
  'pending-same-day pending-new-date pending-drift pending-across-payday fuel-preauth pending-linked pending-payer-twin',
  0.033,
  (b, n) => {
    const lag = n === 'pending-same-day' ? 0 : 2;
    b.pending(
      n === 'fuel-preauth' ? 'card' : 'weekly',
      n === 'fuel-preauth' ? b.amount * 5 : b.amount,
      n === 'pending-drift' ? b.amount + 317 : b.amount,
      'Groceries',
      {
        lag,
        linked: n === 'pending-linked',
        postLabel: n === 'pending-payer-twin' ? 'Transfer' : 'Groceries',
      }
    );
  },
  (d, n) => n !== 'pending-across-payday' || d % 14 === 13
);
register('statement-early statement-partial statement-roll manual-stale manual-row', 0.017, (b, n) => {
  if (n === 'manual-row') return b.purchase('manual', b.amount, 'Groceries');
  if (n === 'manual-stale')
    return b.configure((w) => {
      const m = w.debts.find((x) => x.id === account.manual);
      m.balance = m.limit + 193.77;
      m.evidenceDate = date(-29);
    });
  b.move('bills', 'card', n === 'statement-partial' ? b.t.min - 811 : b.t.min, { noted: true });
  if (n === 'statement-roll')
    b.configure((w) => {
      const first = new Date(date(b.start) + 'T00:00:00Z');
      first.setUTCDate(18);
      const next = new Date(first);
      next.setUTCMonth(next.getUTCMonth() + 1);
      w.obligations[0].statementOccurrences = [first, next]
        .filter((v) => offset(v.toISOString().slice(0, 10)) - 10 <= offset(w.asOf))
        .map((v, i) => ({
          scheduledDate: v.toISOString().slice(0, 10),
          dueDate: v.toISOString().slice(0, 10),
          minimum: (b.t.min + i * 431) / 100,
          currency: 'cad',
          confidence: 'confirmed',
        }));
    });
});
register(
  'savings-purchase savings-card savings-covered savings-conflict savings-old savings-expired savings-overlap savings-overspend savings-after-date savings-refund savings-refund-untagged savings-refund-excess savings-refund-pending savings-refund-later savings-rename savings-redate savings-yearly-bill savings-pending-twin savings-tag-lost savings-short-history',
  0.009,
  (b, n) => {
    const tag = 72101,
      key = ['savings-card', 'savings-covered'].includes(n) ? 'card' : 'weekly';
    const tags = n === 'savings-conflict' ? [tag, tag + 1] : [n === 'savings-old' ? tag + 2 : tag];
    if (n === 'savings-pending-twin' || n === 'savings-tag-lost')
      b.pending(key, b.amount, b.amount + 213, 'Household', {
        lag: 2,
        tags,
        postTags: n === 'savings-tag-lost' ? [] : tags,
      });
    else
      b.purchase(key, n === 'savings-overspend' ? b.t.goal + 731 : b.amount, 'Household', {
        tags,
        payee: n === 'savings-yearly-bill' ? 'Invented kiln' : 'PAYPAL *INVENTED WORKSHOP',
      });
    if (n === 'savings-covered') b.move('pool', 'card', b.amount, { noted: true, at: 2 });
    if (n.includes('refund'))
      b.out(key, -(n.endsWith('excess') ? b.amount + 711 : b.amount - 101), 'Household', {
        at: n.endsWith('later') ? 16 : 1,
        pending: n.endsWith('pending'),
        tags: n.endsWith('untagged') ? [] : tags,
        payee: 'PAYPAL *INVENTED WORKSHOP',
      });
    b.configure((w, day) => {
      if (day < b.start + 2 && ['savings-rename', 'savings-redate'].includes(n)) return;
      if (n === 'savings-rename') w.commitments[0].label = 'Invented paper kite';
      if (n === 'savings-redate') w.commitments[0].date = date(32);
      if (n === 'savings-expired') w.links[0].effectiveThrough = date(0);
      if (n === 'savings-overlap') w.links.push({ ...w.links[1], tagId: tag });
      if (n === 'savings-short-history') w.links[0].effectiveFrom = date(-240);
      if (n === 'savings-yearly-bill') w.bills[0].amount = b.amount / 100;
    });
  },
  (d, n) => n !== 'savings-after-date' || d > 26
);
require('./variants')(register);
register('card-extra-cash', 0.008, (b) => b.move('pocket', 'card', b.amount));
register('manual-offline-purchase', 0.006, (b) => {
  // The institution-side purchase exists; the owner has not updated the
  // manually entered balance. No invented bank row can leak it to Forecast.
  b.book('manual', b.amount);
  b.configure((w) => {
    w.debts.find((d) => d.id === account.manual).evidenceDate = date(-26);
  });
});
register('pass-through-gift pass-through-reimbursement', 0.007, (b, n) => {
  b.out('bills', -b.amount, n.endsWith('gift') ? 'Gifts' : 'Reimbursement', {
    notes: 'Invented ' + n,
    payee: 'INTERAC E-TRANSFER RECEIVED',
  });
  b.out('bills', b.amount, 'Transfer', {
    notes: 'Invented forwarded proceeds',
    payee: 'INTERAC E-TRANSFER SENT',
  });
});

function build(seed, name, start) {
  const seq = Object.keys(habits).indexOf(name);
  const base = 1000000 + start * 100000 + seq * 64;
  const e = { habit: name, start, entries: [], rows: [], purchases: [], transfers: [] };
  let counter = 0;
  const amount = 1911 + (draw(seed, name, start, 'cents') % 1017);
  function row(key, cents, label, opts = {}) {
    const { at = 0, lag = 0, ...fields } = opts;
    const r = {
      id: base + ++counter,
      when: start + at,
      sync: start + at + lag,
      key,
      cents,
      label,
      ...fields,
    };
    e.rows.push(r);
    return r;
  }
  function out(key, cents, label, opts = {}) {
    const r = row(key, cents, label, opts);
    if (!opts.pending) e.entries.push({ id: r.id, key, cents, day: r.when });
    return r;
  }
  function purchase(key, cents, label, opts = {}) {
    const r = out(key, cents, label, opts);
    e.purchases.push({ key, label, versions: [{ id: r.id, day: r.sync, when: r.when, cents }], ids: [r.id] });
    return r;
  }
  function pending(key, initial, final, label, { lag, linked, sameId, tags, postTags, postLabel }) {
    const p = row(key, initial, label, { pending: true, tags });
    const r = out(key, final, postLabel || label, {
      at: lag,
      tags: postTags ?? tags,
      raw: linked ? { pending_transaction_id: p.id } : undefined,
    });
    if (sameId) {
      const posted = r.id;
      r.id = p.id;
      p.until = r.sync;
      e.entries.find((x) => x.id === posted).id = r.id;
    }
    e.purchases.push({
      key,
      label,
      versions: [
        { id: p.id, day: start, when: start, cents: initial },
        { id: r.id, day: r.sync, when: r.when, cents: final },
      ],
      ids: [p.id, r.id],
    });
  }
  function move(
    from,
    to,
    cents,
    {
      lag = 0,
      at = 0,
      pending = false,
      noted = false,
      senderLag = 0,
      payerPending = false,
      receiptAt = 0,
      ref,
    } = {}
  ) {
    const reference =
      ref ||
      'Q' +
        String.fromCharCode(65 + (Math.floor((base + counter) / 1000) % 26)) +
        String((base + counter) % 1000).padStart(3, '0');
    const category = 'Payment, Transfer';
    const recipient = to === 'line' ? 'HELOC' : to === 'card' ? 'Travel Visa' : 'Invented destination';
    const debit = out(from, cents, category, {
      at,
      lag: senderLag,
      payee: reference + ' TFR-TO INVENTED',
      notes: noted ? 'card payment: ' + recipient : null,
    });
    if (payerPending) {
      const auth = row(from, cents, category, { at, pending: true, payee: debit.payee });
      auth.until = debit.sync = debit.when = start + at + 2;
      e.entries.at(-1).day = debit.when;
    }
    const payee = ['card', 'second'].includes(to) ? 'PAYMENT - THANK YOU' : reference + ' TFR-FR INVENTED';
    const receipt = out(to, -cents, category, { at: at + receiptAt, lag: pending ? 2 : lag, payee });
    if (pending) row(to, -cents, category, { at, pending: true, payee, until: receipt.sync });
    e.transfers.push({ from, to, cents, debit: debit.id, receipt: receipt.id, at: start + at });
  }
  habits[name].build(
    {
      start,
      t: terms(seed),
      amount,
      move,
      out,
      row,
      purchase,
      pending,
      book(key, cents) {
        e.entries.push({ key, cents, day: start });
      },
      configure(fn) {
        e.configure = fn;
      },
      copy(r, sameId) {
        const id = sameId ? r.id : base + ++counter;
        e.rows.push({ ...r, id });
        e.purchases.at(-1).ids.push(id);
      },
    },
    name
  );
  return e;
}
function generate(seed, days, rates = {}) {
  const events = [];
  for (let d = 1; d <= days; d++)
    for (const [name, h] of Object.entries(habits)) {
      if (h.eligible(d, name) && draw(seed, d, name, 'frequency') / 2 ** 32 < (rates[name] ?? h.rate))
        events.push(build(seed, name, d));
    }
  return events;
}
module.exports = { build, generate, habits };
