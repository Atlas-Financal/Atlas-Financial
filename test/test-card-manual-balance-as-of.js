'use strict';
// A Credit cards row whose balance comes from a manual statement older than
// the page's date prints a small "as of <date>"; fresh provider balances and
// same-day statements print exactly as before. Display only: the published
// amounts and trust are untouched. Invented fixture; expected text hand-written.
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
const x = fixture(), pub = publish(x), before = JSON.stringify(pub);
const html = View.html(pub, fmt);
const mbna = pub.cards.find(c => c.id === 'mbna');
eq([mbna.manualStatement, mbna.reportedBalance.date < pub.asOf], [true, true], 'invented Amazon statement is manual and older than the page date');
eq(face(html, 'mbna').includes('>$760.00 <small class="card-movement-asof" data-card-movement-asof>as of 2026-08-08</small></span>'), true, 'stale manual row notes its date');
eq(face(html, 'travelvisa').includes('card-movement-asof'), false, 'provider-fresh/non-manual row unchanged');
eq(face(html, 'travelvisa').includes('card-movement-balance">$927.40</span>'), true, 'non-manual row amount printed bare as before');
eq((html.match(/data-card-movement-asof/g) || []).length, pub.cards.filter(c => c.manualStatement && c.reportedBalance && c.reportedBalance.date < pub.asOf).length, 'note appears only on stale manual rows');
// A statement dated on the page's own date, or with no date, is not stale.
for (const [name, date] of [['same-day', pub.asOf], ['undated', null], ['future', '2099-01-01']]) {
  const y = copy(pub); y.cards.find(c => c.id === 'mbna').reportedBalance.date = date;
  eq(face(View.html(y, fmt), 'mbna').includes('card-movement-asof'), false, name + ' manual statement prints no note');
}
// A missing page date never invents a note.
const noDate = copy(pub); noDate.asOf = null;
eq(View.html(noDate, fmt).includes('card-movement-asof'), false, 'no page date, no note');
// Escaping: the date prints through the page formatter, escaped.
const evil = copy(pub); evil.cards.find(c => c.id === 'mbna').reportedBalance.date = '2026-08-08';
eq(face(View.html(evil, { ...fmt, date: () => '<b>' }), 'mbna').includes('as of &lt;b&gt;'), true, 'date text is escaped');
eq(JSON.stringify(pub), before, 'rendering never mutates the publication');
eq(JSON.stringify(publish(x).cards.map(c => [c.id, c.reportedBalance && c.reportedBalance.amount, c.netChange.trust])), JSON.stringify(pub.cards.map(c => [c.id, c.reportedBalance && c.reportedBalance.amount, c.netChange.trust])), 'amounts and trust unchanged');
console.log('PASS card manual-balance as-of (' + checks + ' checks)');
