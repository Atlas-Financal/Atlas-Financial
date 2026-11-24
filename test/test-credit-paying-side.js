'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Forecast = require('../public/forecast');
const { fixture } = require('./fixtures/card-posted-period-movement-data');
const { loadStackPage } = require('./lib/budget-page-harness');

const FIRST = '2026-08-18';
const THIRD = '2026-08-20';
const EXACT = 'card payment: Travel Visa';
const payment = (notes, extra = {}) => ({
  id: 'outgoing', date: FIRST, atlasAccountId: 'chequing-a', accountRole: 'household-cash',
  categoryLabel: 'Credit Card Payment', kindHint: 'payment', amount: 43, currency: 'cad', pending: false,
  notes, ...extra,
});
const issuer = {
  id: 'incoming', date: THIRD, atlasAccountId: 'travelvisa', accountRole: 'revolving-credit',
  displayedPayee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', kindHint: 'payment',
  amount: -43, currency: 'cad', pending: false,
};

function world(asOf, rows) {
  const { plan, debts, overlay, packet } = fixture();
  plan.obligations.find(o => o.debtId === 'travelvisa').amount = 20;
  plan.cardPurchaseCoverage.opening.asOf = '2026-08-13';
  packet.syncEvidence.push({ id: 'chequing-a', role: 'household-cash', syncEvidence: 'proven', fields: { last_fetch: true } });
  packet.observationAsOf = asOf;
  packet.coverageThrough = asOf;
  packet.transactionWindow.endDate = asOf;
  packet.transactions = rows.map(raw => {
    // Pass only the decision fields the provider packet retains. The browser never sees the raw ledger note.
    const { notes, original_name, ...row } = raw;
    return { ...row, ...Forecast.classifyCurrentPeriodTransaction.derivedFlags(raw, plan),
      coverageRef: 'invented-' + row.id, savingsPostingEvidence: row.pending ? 'pending' : 'posted' };
  });
  overlay.overlays = overlay.overlays.map(item => ({ ...item, evidenceDate: asOf }));
  return { meta: { asOf }, accounts: [], revolvingExtra: [], plan, debts,
    liveOverlay: { ...overlay, operatingPlan: 'live', currentPeriodActuals: packet } };
}

async function render(asOf, rows, editPacket) {
  const data = world(asOf, rows);
  if (editPacket) editPacket(data.liveOverlay.currentPeriodActuals, data.plan);
  return renderWorld(data);
}

async function renderWorld(data) {
  const page = await loadStackPage({ data });
  assert.equal(page.status(), 'rendered');
  const ctx = page.context();
  const view = ctx.recommendation.payPeriodViews.find(v => v.start === page.selectedKey());
  assert.equal(view.timelineRole, 'current');
  return { period: { start: view.start, end: view.end }, credit: view.stackSummary.credit, card: page.blockHtml('credit'),
    sheet: id => page.sandbox.StackSheet.html(ctx, 'card:' + id) };
}

const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function unconfirmedText(page, id) {
  const section = page.sheet(id).match(/<section[^>]*data-stack-unconfirmed-payments[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(section, 'the selected card sheet shows the unassigned payment');
  return plain(section[1]);
}

function checkPayment(page, amount, trust, reason, cardId = 'travelvisa') {
  const { credit } = page;
  const line = credit.lines.find(item => item.id === cardId);
  for (const figure of [line.paidToward, line.paidBack, credit.totals.minimumsPaid]) {
    assert.equal(figure.amount, amount, 'paid toward, Paid back and the head use the single paying-side amount');
    assert.equal(figure.trust, trust);
  }
  if (reason) {
    assert.ok(line.paidToward.reasons.includes(reason));
    assert.ok(line.paidBack.reasons.includes(reason));
    assert.ok(credit.totals.minimumsPaid.reasons.includes(reason));
  }
  assert.equal(line.minimum.amount, 20);
  const covered = amount >= 20;
  assert.equal(line.minimumCovered.value, covered);
  assert.equal(credit.totals.minimumsCoveredCount, Number(covered));
  const row = page.card.split('<li>').find(item => item.includes('data-stack-sheet="card:' + cardId + '"'))?.split('</li>')[0];
  assert.ok(row, 'the selected card appears on the rendered Credit page');
  assert.equal(row.includes('aria-label="Minimum covered'), covered);
  const paid = row.match(/<span class="stack-credit-x[^"]*"[^>]*>([^<]+)<\/span>/)?.[1];
  assert.ok(paid === '$' + amount || paid === '+$' + amount, 'the row prints its own Paid back');
  const head = page.card.match(/data-stack-credit-total>([\s\S]*?)<\/i>/)?.[1];
  assert.ok(head, 'the Credit head has a published amount');
  assert.equal(plain(head), '$' + amount + ' / $20');
  assert.match(plain(page.sheet(cardId)), new RegExp('Paid back \\+?\\$' + amount + '(?![\\d.])'));
}

test('a ledger-named paying transfer pays its own card before the issuer posts and exactly once afterwards', async () => {
  for (const [asOf, rows] of [[FIRST, [payment(EXACT)]], [THIRD, [payment(EXACT), issuer]]]) {
    const page = await render(asOf, rows);
    checkPayment(page, 43, 'calculated');
    assert.equal(page.credit.lines.find(l => l.id === 'cashback').paidBack.amount, 0);
    assert.doesNotMatch(page.sheet('travelvisa'), /data-stack-unconfirmed-payments/);
  }
  checkPayment(await render(THIRD, [issuer]), 0, 'estimated', 'no-confirmed-paying-side-payments');
});

test('the by-amount note can cover a minimum but retains estimated trust', async () => {
  const page = await render(FIRST, [payment(EXACT + ' (by amount)')]);
  checkPayment(page, 43, 'estimated', 'card-payment-by-amount');
  assert.doesNotMatch(page.sheet('travelvisa'), /data-stack-unconfirmed-payments/);
});

test('payments without one recognized card remain visible and unassigned', async () => {
  for (const notes of [undefined, 'card payment:', 'card payment: Invented Card', EXACT + '; card payment: TD Cash Back Visa']) {
    const page = await render(FIRST, [payment(notes)]);
    checkPayment(page, 0, 'estimated', 'card-payment-destination-unconfirmed');
    assert.equal(page.credit.unconfirmedPayments.length, 1);
    assert.equal(page.credit.unconfirmedPayments[0].amount, 43);
    assert.equal(page.credit.unconfirmedPayments[0].date, FIRST);
    assert.deepEqual(Object.keys(page.credit.unconfirmedPayments[0]).sort(), ['amount', 'date']);
    for (const id of ['travelvisa', 'cashback']) {
      const line = page.credit.lines.find(item => item.id === id);
      assert.equal(line.paidBack.amount, 0);
      const shown = unconfirmedText(page, id);
      assert.match(shown, /Unconfirmed payments/);
      assert.match(shown, /Aug 18/);
      assert.match(shown, /Paying account · Card unidentified/);
      assert.match(shown, /\$43(?:\.00)?\b/);
    }
  }
});

test('a separate unconfirmed transfer cannot inflate or erase the known paying-side amount', async () => {
  const page = await render(FIRST, [payment(EXACT), payment(undefined, { id: 'second-transfer', amount: 71 })]);
  checkPayment(page, 43, 'estimated', 'card-payment-destination-unconfirmed');
  assert.equal(page.credit.unconfirmedPayments.length, 1);
  assert.equal(page.credit.unconfirmedPayments[0].amount, 71);
});

test('a non-due card keeps its named payment when a separate debit has no destination', async () => {
  const page = await render(FIRST, [
    payment('card payment: TD Cash Back Visa'), payment(undefined, { id: 'unassigned', amount: 71 }),
  ]);
  checkPayment(page, 0, 'estimated', 'card-payment-destination-unconfirmed');
  assert.equal(page.credit.totals.minimumsDueCount, 1);
  const line = page.credit.lines.find(item => item.id === 'cashback');
  assert.ok(line.minimum.reasons.includes('no-minimum-due-in-period'));
  assert.equal(line.target.amount, 0);
  for (const figure of [line.paidToward, line.paidBack]) {
    assert.equal(figure.amount, 43);
    assert.equal(figure.trust, 'calculated');
    assert.ok(!figure.reasons.includes('card-payment-destination-unconfirmed'));
  }
  assert.match(plain(page.sheet('cashback')), /Paid back [+$−]*43\b/);
  assert.equal(page.credit.unconfirmedPayments.length, 1);
  assert.equal(page.credit.unconfirmedPayments[0].amount, 71);
});

test('a card with new spending and no minimum keeps its named amount at estimated trust when another payment is unassigned', async () => {
  const purchase = { id: 'new-spending', date: FIRST, atlasAccountId: 'cashback', accountRole: 'revolving-credit',
    categoryLabel: 'Groceries', displayedPayee: 'Invented market', amount: 60, currency: 'cad', pending: false };
  const page = await render(FIRST, [purchase, payment('card payment: TD Cash Back Visa'),
    payment(undefined, { id: 'unassigned', amount: 71 })]);
  const line = page.credit.lines.find(item => item.id === 'cashback');
  assert.ok(line.minimum.reasons.includes('no-minimum-due-in-period'));
  assert.equal(line.target.amount, 60);
  assert.equal(page.credit.unconfirmedPayments.length, 1);
  assert.equal(page.credit.unconfirmedPayments[0].amount, 71);
  assert.equal(line.stillToPayBack.amount, 17);
  assert.equal(line.targetCovered.value, false);
  for (const figure of [line.paidToward, line.paidBack]) {
    assert.equal(figure.amount, 43);
    assert.equal(figure.trust, 'estimated');
    assert.ok(figure.reasons.includes('card-payment-destination-unconfirmed'));
  }
});

test('the head retains the unidentified debit reason even when no card has a minimum due', async () => {
  const page = await render(FIRST, [payment(undefined)], (_packet, plan) => {
    plan.obligations = plan.obligations.filter(item => item.debtId !== 'travelvisa');
  });
  const totals = page.credit.totals;
  assert.equal(totals.minimumsDueCount, 0);
  assert.equal(totals.minimumsDue.amount, 0);
  assert.equal(totals.minimumsPaid.amount, 0);
  assert.equal(totals.minimumsPaid.trust, 'estimated');
  assert.ok(totals.minimumsPaid.reasons.includes('card-payment-destination-unconfirmed'));
  assert.equal(page.credit.unconfirmedPayments.length, 1);
});

test('pending transfers, other accounts and unrelated purchases never pay a posted minimum', async () => {
  const rows = [
    payment(EXACT, { pending: true }),
    payment(EXACT, { id: 'external', atlasAccountId: 'outside', accountRole: 'household-external' }),
    payment(EXACT, { id: 'groceries', kindHint: 'purchase', categoryLabel: 'Groceries' }),
    payment(undefined, { id: 'ordinary-transfer', kindHint: 'transfer', categoryLabel: 'Transfer' }),
  ];
  const page = await render(FIRST, rows);
  checkPayment(page, 0, 'estimated', 'no-confirmed-paying-side-payments');
  assert.doesNotMatch(page.sheet('travelvisa'), /data-stack-unconfirmed-payments/);
});

test('a saved destination without the note-strength field counts with estimated provenance', async () => {
  const page = await render(FIRST, [payment(EXACT)], packet => {
    const row = packet.transactions[0];
    assert.equal(row.cardPaymentNoteDestination, 'travelvisa');
    assert.ok(!Object.hasOwn(row, 'notes'));
    delete row.cardPaymentNoteByAmount;
  });
  checkPayment(page, 43, 'estimated', 'card-payment-note-provenance-unconfirmed');
  assert.doesNotMatch(page.sheet('travelvisa'), /data-stack-unconfirmed-payments/);
});

test('a named reserve debit pays the minimum even with no issuer sync evidence', async () => {
  const reserve = payment(EXACT, { atlasAccountId: 'savings', accountRole: 'household-reserve' });
  const page = await render(FIRST, [reserve], packet => {
    // The reserve payment itself supplies the payer evidence. Neither the Bills sync nor the issuer sync can help.
    packet.syncEvidence = packet.syncEvidence.filter(account => account.id !== 'travelvisa' && account.id !== 'chequing-a');
  });
  checkPayment(page, 43, 'calculated');
  assert.doesNotMatch(page.sheet('travelvisa'), /data-stack-unconfirmed-payments/);
});

test('a manual-statement card receives its named payment from the payer alone', async () => {
  const data = world(FIRST, [payment('card payment: Triangle Mastercard')]);
  const packet = data.liveOverlay.currentPeriodActuals;
  packet.syncEvidence = packet.syncEvidence.filter(account => account.id !== 'triangle');
  data.plan.obligations.find(item => item.debtId === 'travelvisa').debtId = 'triangle';

  const page = await renderWorld(data);
  const movements = Forecast.cardPeriodMovements(data.plan, data.debts, FIRST, page.period, data.liveOverlay);
  const manual = movements.cards.find(card => card.id === 'triangle');
  assert.equal(manual.manualStatement, true);
  assert.deepEqual(manual.posted, []);
  assert.deepEqual(manual.pending, []);
  checkPayment(page, 43, 'calculated', null, 'triangle');
  assert.equal(page.credit.lines.find(card => card.id === 'travelvisa').paidBack.amount, 0);
});

function checkWithheld(page, reason) {
  const line = page.credit.lines.find(item => item.id === 'travelvisa');
  for (const figure of [line.paidToward, line.paidBack, page.credit.totals.minimumsPaid]) {
    assert.equal(figure.amount, null);
    assert.equal(figure.trust, 'unavailable');
  }
  assert.ok(line.paidBack.reasons.includes(reason));
  assert.equal(line.minimumCovered.value, 'unknown');
  assert.match(plain(page.card.match(/data-stack-credit-total>([\s\S]*?)<\/i>/)[1]), /^— \/ \$20$/);
}

test('a named reversal withholds the affected payment and its minimum coverage', async () => {
  const page = await render(THIRD, [
    payment(EXACT), payment(EXACT, { id: 'reversal', date: THIRD, amount: -43 }),
    payment('card payment: TD Cash Back Visa', { id: 'unrelated', amount: 11 }),
  ]);
  checkWithheld(page, 'payment-direction-unresolved');
  const line = page.credit.lines.find(item => item.id === 'travelvisa');
  assert.equal(line.stillToPayBack.amount, null);
  assert.equal(line.targetCovered.value, 'unknown');
  assert.equal(page.credit.totals.minimumsCoveredCount, 0);
  assert.ok(page.credit.totals.minimumsPaid.reasons.includes('payment-direction-unresolved'));
  const other = page.credit.lines.find(item => item.id === 'cashback');
  assert.equal(other.paidBack.amount, 11);
  assert.equal(other.paidBack.trust, 'calculated');
});

test('a reversal alone cannot establish payer coverage for another tracked card', async () => {
  const page = await render(FIRST, [payment(EXACT, { amount: -43 })], packet => {
    packet.syncEvidence = packet.syncEvidence.filter(account => !['household-cash', 'household-reserve'].includes(account.role));
  });
  const other = page.credit.lines.find(item => item.id === 'cashback');
  for (const figure of [other.paidToward, other.paidBack]) {
    assert.equal(figure.amount, null);
    assert.equal(figure.trust, 'unavailable');
    assert.ok(figure.reasons.includes('paying-account-not-observed'));
  }
});

test('an unidentified payment reversal withholds the paid head', async () => {
  const page = await render(THIRD, [
    payment(EXACT), payment(undefined, { id: 'unassigned-reversal', date: THIRD, amount: -43 }),
  ]);
  const { totals } = page.credit;
  assert.equal(totals.minimumsPaid.amount, null);
  assert.equal(totals.minimumsPaid.trust, 'unavailable');
  assert.ok(totals.minimumsPaid.reasons.includes('payment-direction-unresolved'));
  const named = page.credit.lines.find(item => item.id === 'travelvisa');
  assert.equal(named.paidBack.amount, 43);
  assert.equal(page.credit.unconfirmedPayments.length, 1);
  assert.equal(page.credit.unconfirmedPayments[0].amount, -43);
  const shown = unconfirmedText(page, 'travelvisa');
  assert.match(shown, /Paying account · Reversal, card unidentified/);
  assert.match(shown, /[−-]\$43(?:\.00)?\b/);
});

test('an unidentified reversal withholds the head even if no minimum is due', async () => {
  const page = await render(FIRST, [payment(undefined, { amount: -43 })], (_packet, plan) => {
    plan.obligations = plan.obligations.filter(item => item.debtId !== 'travelvisa');
  });
  const { totals } = page.credit;
  assert.equal(totals.minimumsDueCount, 0);
  assert.equal(totals.minimumsCoveredCount, 0);
  assert.equal(totals.minimumsPaid.amount, null);
  assert.equal(totals.minimumsPaid.trust, 'unavailable');
  assert.ok(totals.minimumsPaid.reasons.includes('payment-direction-unresolved'));
});

test('a named reversal on a manual-statement card cannot fall back to an estimated zero', async () => {
  const note = 'card payment: Triangle Mastercard';
  const page = await render(THIRD, [payment(note), payment(note, { id: 'reversal', date: THIRD, amount: -43 })],
    (packet, plan) => {
      packet.syncEvidence = packet.syncEvidence.filter(item => item.id !== 'triangle');
      plan.obligations.find(item => item.debtId === 'travelvisa').debtId = 'triangle';
    });
  const manual = page.credit.lines.find(item => item.id === 'triangle');
  for (const figure of [manual.paidToward, manual.paidBack, page.credit.totals.minimumsPaid]) {
    assert.equal(figure.amount, null);
    assert.equal(figure.trust, 'unavailable');
    assert.ok(figure.reasons.includes('payment-direction-unresolved'));
  }
  assert.equal(manual.minimumCovered.value, 'unknown');
});

for (const [source, field] of [['payee', 'cardPaymentDestination'], ['category', 'minimumCategoryDebt']]) {
  test('a ledger note contradicting the ' + source + ' destination pays neither card', async () => {
    const page = await render(FIRST, [payment(EXACT, { [field]: 'cashback' })]);
    const { totals, lines, unconfirmedPayments } = page.credit;
    for (const id of ['travelvisa', 'cashback']) {
      const line = lines.find(item => item.id === id);
      assert.equal(line.paidBack.amount, 0, 'the conflicting debit cannot pay ' + id);
      assert.notEqual(line.minimumCovered.value, true);
    }
    assert.equal(unconfirmedPayments.length, 1);
    assert.equal(unconfirmedPayments[0].date, FIRST);
    assert.equal(unconfirmedPayments[0].amount, 43);
    const shown = unconfirmedText(page, 'travelvisa');
    assert.match(shown, /Paying account · Conflicting card destinations/);
    assert.match(shown, /\$43(?:\.00)?\b/);
    const due = lines.find(item => item.id === 'travelvisa');
    assert.equal(due.paidBack.trust, 'estimated');
    assert.ok(due.paidBack.reasons.includes('card-payment-destination-conflict'));
    assert.equal(totals.minimumsPaid.amount, 0);
    assert.equal(totals.minimumsPaid.trust, 'estimated');
    assert.ok(totals.minimumsPaid.reasons.includes('card-payment-destination-conflict'));
    assert.equal(totals.minimumsCoveredCount, 0);
  });
}

test('a complete response without payer evidence cannot establish a zero, even with an issuer receipt', async () => {
  for (const rows of [[], [issuer]]) {
    const page = await render(THIRD, rows, packet => {
      packet.syncEvidence = packet.syncEvidence.filter(account => account.role !== 'household-cash');
    });
    checkWithheld(page, 'paying-account-not-observed');
    assert.equal(page.credit.totals.minimumsDueCount, 1);
    assert.equal(page.credit.totals.minimumsCoveredCount, 0);
    assert.equal(page.credit.totals.minimumsCoveredTrust, 'unavailable');
  }
});

test('a future due minimum keeps estimated coverage-count trust while payment is unobserved', async () => {
  const page = await loadStackPage({ data: world(THIRD, []) });
  assert.equal(page.status(), 'rendered');
  // The invented plan schedules its next monthly card minimum on September 22.
  const dueDate = '2026-09-22';
  const view = page.context().recommendation.payPeriodViews.find(v => v.start <= dueDate && dueDate <= v.end);
  assert.equal(view.timelineRole, 'future');
  const { lines, totals } = view.stackSummary.credit;
  const line = lines.find(item => item.id === 'travelvisa');
  assert.equal(line.minimum.amount, 20);
  assert.equal(line.minimum.trust, 'estimated');
  assert.equal(line.minimumCovered.value, 'unknown');
  assert.equal(line.minimumCovered.trust, 'unavailable');
  assert.equal(totals.minimumsDue.amount, 20);
  assert.equal(totals.minimumsDueCount, 1);
  assert.equal(totals.minimumsCoveredCount, 0);
  assert.equal(totals.minimumsPaid.amount, 0);
  assert.equal(totals.minimumsPaid.trust, 'estimated');
  assert.ok(totals.minimumsPaid.reasons.includes('future-not-observed'));
  assert.equal(totals.minimumsCoveredTrust, 'estimated');
});

test('a posted payer transfer sharing a native ID with a different ledger row cannot establish Paid back', async () => {
  const unrelated = { ...issuer, id: 'outgoing', kindHint: 'purchase', categoryLabel: 'Groceries',
    original_name: 'Invented grocer', amount: 7 };
  const page = await render(THIRD, [payment(EXACT), unrelated], packet => {
    // Different references rule out a reference collision: only the duplicate native ID conflicts.
    packet.transactions[1].coverageRef = 'invented-issuer-charge';
  });
  checkWithheld(page, 'duplicate-identity');
});
