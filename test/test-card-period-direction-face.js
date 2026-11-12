'use strict';
// Each credit-card face prints one small line under its balance that copies
// Forecast's own posted net change for the selected period (owner request,
// #821 6809860818; Dale picked option B): '+$X this period' when more went
// onto the card than came off it, '−$X this period' for the reverse, 'No
// change this period' for a true zero. A card without a usable published
// figure prints nothing extra. Display only: the expected text is written
// by hand from the invented fixture, never computed by the page's code.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const View = require('../public/budget-card-movements');
const { fixture, copy } = require('./fixtures/card-period-movements-data');
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const fmt = { money: v => '$' + v.toFixed(2), date: v => v };
const publish = x => F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
  { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, liveOverlay: x.overlay || null });
const face = (html, id) => (html.match(new RegExp('data-budget-card-toggle="' + id + '"[^>]*>[\\s\\S]*?</button>')) || [''])[0];
const line = (html, id) => {
  const m = face(html, id).match(/<span class="card-movement-net is-(\w+)" data-card-movement-net="(\w+)">([^<]*)<\/span>/);
  return m ? [m[1], m[2], m[3]] : null;
};
const x = fixture(), pub = publish(x), before = JSON.stringify(pub);
const html = View.html(pub, fmt);
// Hand-written expectations for the invented fixture (posted ledger only).
eq(line(html, 'travelvisa'), ['up', 'up', '+$107.40 this period'], 'more charged than paid: plus sign and words');
eq(line(html, 'cashback'), ['down', 'down', '−$135.80 this period'], 'more paid than charged: minus sign and words');
eq(line(html, 'tdcc'), ['flat', 'flat', 'No change this period'], 'true zero: plain words, no figure');
eq(line(html, 'triangle'), null, 'unavailable manual card prints no line');
eq(line(html, 'mbna'), null, 'stale manual card prints no line');
// The line sits after the balance; the balance and its as-of note are unchanged.
eq(face(html, 'travelvisa').includes('card-movement-balance">$927.40</span><span class="card-movement-net'), true, 'line follows the bare balance');
eq(face(html, 'mbna').includes('>$760.00 <small class="card-movement-asof" data-card-movement-asof>as of 2026-08-08</small></span>'), true, 'as-of note unchanged');
eq((html.match(/data-card-movement-net=/g) || []).length, 3, 'exactly the three ready cards carry a line');
// Each printed line equals the publication's own direction and magnitude.
for (const card of pub.cards.filter(c => c.status === 'ready')) {
  const [, dir, text] = line(html, card.id);
  eq(dir, card.netChange.direction, card.id + ' direction copied');
  eq(card.netChange.direction === 'flat' ? true : text.includes('$' + card.netChange.magnitude.toFixed(2)), true, card.id + ' magnitude copied');
}
// Fail closed: any unusable published figure prints nothing extra.
const broken = {
  'not ready': c => { c.status = 'unavailable'; },
  'reasons present': c => { c.reasons = ['balance-ledger-discrepancy']; },
  'reasons unreadable': c => { c.reasons = null; },
  'incomplete': c => { c.netChange.completeness = 'partial'; },
  'estimated trust': c => { c.netChange.trust = 'estimated'; },
  'unavailable trust': c => { c.netChange.trust = 'unavailable'; },
  'null magnitude': c => { c.netChange.magnitude = null; },
  'non-finite magnitude': c => { c.netChange.magnitude = Infinity; },
  'string magnitude': c => { c.netChange.magnitude = '107.40'; },
  'unknown direction': c => { c.netChange.direction = 'sideways'; },
  'missing direction': c => { c.netChange.direction = null; },
  'no netChange': c => { delete c.netChange; },
};
for (const [name, mutate] of Object.entries(broken)) {
  const y = copy(pub); mutate(y.cards.find(c => c.id === 'travelvisa'));
  const out = View.html(y, fmt);
  eq(line(out, 'travelvisa'), null, name + ' prints no line');
  eq(face(out, 'travelvisa').includes('$927.40'), true, name + ' keeps the balance');
  eq(line(out, 'cashback'), ['down', 'down', '−$135.80 this period'], name + ' leaves other cards alone');
}
// Pending activity never moves the line: it copies the posted net change only.
const pend = copy(pub); pend.cards.find(c => c.id === 'travelvisa').pending = [{ id: 'p', date: pub.asOf, pending: true, direction: 'up', magnitude: 999, kind: 'charge', payee: 'Invented' }];
eq(line(View.html(pend, fmt), 'travelvisa'), ['up', 'up', '+$107.40 this period'], 'pending does not change the line');
// Escaping: the amount prints through the page formatter, escaped.
eq(line(View.html(pub, { ...fmt, money: () => '<b>' }), 'travelvisa')[2], '+&lt;b&gt; this period', 'amount text is escaped');
eq(JSON.stringify(pub), before, 'rendering never mutates the publication');
console.log('PASS card period direction face (' + checks + ' checks)');
