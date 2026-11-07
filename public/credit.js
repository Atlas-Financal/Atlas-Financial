'use strict';
/* Credit — "What do we owe?" A factual debt and account page, not strategy.
 *
 * Every row comes from Forecast.creditAccounts on the served /data.json the
 * shared core fetched: the debt records are the canonical balances (with any
 * trusted live overlay already applied server-side), headroom is
 * Forecast.utilisation, and the next required payment is the first
 * occurrence in the same Forecast schedule the Plan calendar reads, on or
 * after the financial as-of. This file formats those outputs. It never
 * subtracts a balance from a limit, never picks a due date from the clock,
 * never orders debts by its own rule, and never suggests what to pay first.
 *
 * An unknown fact stays "Unknown". It is never printed as $0, 0%, "nothing
 * due", or unlimited credit. */

const CREDIT_CONFIDENCE_CHIP = { verified: 'v', confirmed: 'v', calculated: 'e', estimated: 'w' };

function creditConfidenceChip(confidence) {
  const value = confidence || 'unknown';
  const cls = CREDIT_CONFIDENCE_CHIP[value] || 'c';
  return `<span class="chip ${cls}">${value.toUpperCase()}</span>`;
}

function creditUnknown(reason) {
  return `<span class="credit-unknown">Unknown</span>${reason ? `<small>${reason}</small>` : ''}`;
}

function creditFact(label, value, small, attrs) {
  return `<div class="credit-fact"${attrs ? ' ' + attrs : ''}><dt>${label}</dt><dd>${value}${small ? `<small>${small}</small>` : ''}</dd></div>`;
}

function creditMoneyFact(label, amount, small, attrs) {
  if (amount == null || !isFinite(Number(amount))) return creditFact(label, creditUnknown(), null, attrs);
  return creditFact(label, money2(amount), small, attrs);
}

function creditRateFact(row) {
  if (row.rate == null) return creditFact('Interest rate', creditUnknown('Rate not recorded'), null, 'data-credit-fact="rate"');
  return creditFact('Interest rate', pct(row.rate), row.rateBasis || '', 'data-credit-fact="rate"');
}

// Forecast.utilisation already decided what may be published. Unknown
// pending withholds headroom; over the limit is a different fact from $0.
function creditAvailableFact(row) {
  if (row.limit == null) {
    return creditFact('Available credit', creditUnknown('No credit limit recorded'), null, 'data-credit-fact="available"');
  }
  if (row.overLimit === true) {
    return creditFact('Available credit', money2(0), `Over the limit by ${money2(row.overLimitBy)}`, 'data-credit-fact="available" data-credit-over-limit="true"');
  }
  if (row.pendingUnknown || row.available == null) {
    return creditFact('Available credit', '<span class="credit-unknown">Not published</span>', 'Pending not observed — posted room is not headroom', 'data-credit-fact="available" data-credit-pending-unknown="true"');
  }
  const includes = row.pending ? `Includes ${money2(row.pending)} pending, already incurred` : '';
  return creditFact('Available credit', money2(row.available), includes, 'data-credit-fact="available"');
}

function creditLimitFact(row) {
  if (row.limit == null) return creditFact('Credit limit', creditUnknown(), null, 'data-credit-fact="limit"');
  return creditFact('Credit limit', money2(row.limit), '', 'data-credit-fact="limit"');
}

// The next required payment is one Forecast schedule occurrence. Estimated
// keeps ≈ and its chip. No occurrence in the knowledge horizon is Unknown,
// not "no payment due".
function creditNextPaymentFacts(row, amountLabel, dateLabel) {
  const next = row.nextPayment;
  if (!next) {
    return creditFact(amountLabel, creditUnknown('No scheduled occurrence in the Forecast horizon'), null, 'data-credit-fact="minimum"')
      + creditFact(dateLabel, creditUnknown(), null, 'data-credit-fact="due"');
  }
  const estimated = next.confidence === 'estimated';
  const amount = `${estimated ? '≈ ' : ''}${money2(next.amount)}`;
  const dateHint = next.dateConfidence === 'estimated' ? ` · ${creditConfidenceChip(next.dateConfidence)}` : '';
  const dateTrust = next.dateConfidence ? ` data-credit-date-confidence="${next.dateConfidence}"` : '';
  return creditFact(amountLabel, amount, `${creditConfidenceChip(next.confidence)}`, `data-credit-fact="minimum" data-credit-confidence="${next.confidence || 'unknown'}"`)
    + creditFact(dateLabel, fmtDateFull(next.date), next.label + dateHint, `data-credit-fact="due" data-credit-due="${next.date}"${dateTrust}`);
}

function creditPendingLine(row) {
  if (row.pendingUnknown) {
    return '<div class="credit-pending" data-credit-pending="unknown">Pending not observed — not $0</div>';
  }
  if (row.pending) {
    return `<div class="credit-pending" data-credit-pending="${row.pending}">+ ${money2(row.pending)} pending, already incurred</div>`;
  }
  return '';
}

function creditAccountOpen(row, headingTag) {
  return `<article class="credit-account credit-${row.shape}" data-credit-id="${row.id}" data-credit-shape="${row.shape}">
    <div class="credit-head">
      <${headingTag}>${row.label}</${headingTag}>
      ${creditConfidenceChip(row.confidence)}
    </div>
    <div class="credit-balance">
      <span class="lab">${row.shape === 'card' ? 'Posted balance' : 'Current balance'}</span>
      <b>${row.balance == null ? creditUnknown() : money2(row.balance)}</b>
      ${creditPendingLine(row)}
    </div>
    <dl class="credit-facts">`;
}

function creditAccountClose(row) {
  // Card structure prose can retain dated balances and activity after a live
  // overlay. Keep the explanation structural; the facts above own amounts.
  const structure = row.shape === 'card'
    ? 'Revolving credit: purchases and interest add to the balance; payments reduce it.'
    : row.structure;
  return `</dl>${structure ? `<p class="credit-structure">${structure}</p>` : ''}</article>`;
}

// Mortgage: a secured term debt. Balance, rate, the regular payment on the
// record, and the next schedule occurrence.
function securedTermHtml(row) {
  const regular = row.regularPayment != null
    ? creditFact('Regular payment', money2(row.regularPayment), row.frequency || '', 'data-credit-fact="regular"')
    : creditFact('Regular payment', creditUnknown(), null, 'data-credit-fact="regular"');
  return creditAccountOpen(row, 'h2')
    + creditRateFact(row)
    + regular
    + creditNextPaymentFacts(row, 'Next payment', 'Next payment due')
    + creditAccountClose(row);
}

// HELOC: a secured revolving facility. Two different facts are kept apart:
// the interest charge that capitalises onto the balance (no cash leaves) and
// the household's cash minimum (cash does leave). Neither is a "payment"
// in the card sense, and the interest is never a second cash minimum.
function securedRevolvingHtml(row) {
  const cap = row.nextCapitalise;
  const capitalising = row.interestTreatment === 'capitalised';
  const interest = capitalising
    ? (cap
      ? creditFact('Interest charged onto the balance', money2(cap.amount),
        `${fmtDateFull(cap.date)} · adds to the balance; no cash leaves`, 'data-credit-fact="capitalise" data-credit-noncash="true"')
      : (row.monthlyInterest != null
        ? creditFact('Interest charged onto the balance', money2(row.monthlyInterest), 'Monthly · adds to the balance; no cash leaves', 'data-credit-fact="capitalise" data-credit-noncash="true"')
        : ''))
    : '';
  const min = row.nextCashMinimum;
  const cashMinimum = min
    ? creditFact('Household cash minimum', `${min.confidence === 'estimated' ? '≈ ' : ''}${money2(min.amount)}`,
      creditConfidenceChip(min.confidence), `data-credit-fact="cash-minimum" data-credit-confidence="${min.confidence || 'unknown'}"`)
      + creditFact('Cash minimum due', fmtDateFull(min.date), min.label, `data-credit-fact="cash-minimum-due" data-credit-due="${min.date}"`)
    : (capitalising
      ? creditFact('Household cash minimum', creditUnknown('No cash minimum scheduled in the Forecast horizon'), null, 'data-credit-fact="cash-minimum"')
      : creditNextPaymentFacts(row, 'Next payment', 'Next payment due'));
  return creditAccountOpen(row, 'h2')
    + creditLimitFact(row)
    + creditAvailableFact(row)
    + creditRateFact(row)
    + interest
    + cashMinimum
    + creditAccountClose(row);
}

function cardHtml(row) {
  return creditAccountOpen(row, 'h3')
    + creditLimitFact(row)
    + creditAvailableFact(row)
    + creditRateFact(row)
    + creditNextPaymentFacts(row, 'Minimum payment', 'Due date')
    + creditAccountClose(row);
}

function securedAccountHtml(row) {
  return row.shape === 'secured-term' ? securedTermHtml(row) : securedRevolvingHtml(row);
}

function creditPageHtml(accounts) {
  const secured = (accounts.secured || []).map(securedAccountHtml).join('');
  const cards = (accounts.cards || []).map(cardHtml).join('');
  return {
    secured: secured || '<p class="lede">No secured debt is on this opening.</p>',
    cards: cards || '<p class="lede">No active credit card is on this opening.</p>',
    cardsLede: accounts.cards && accounts.cards.length
      ? `${accounts.cards.length} active household card${accounts.cards.length === 1 ? '' : 's'} on the ${fmtDateFull(accounts.asOf)} opening. Available credit is Forecast.utilisation and already counts known pending charges. Minimum and due date are the next Forecast schedule occurrence on or after that date.`
      : '',
    note: `Balances and limits are the served opening as at ${fmtDateFull(accounts.asOf)}. Available credit is never household cash. Nothing here ranks debts, suggests a payment order, or permits borrowing — the payday plan is on Budget.`,
  };
}

function renderCredit(d) {
  const accounts = Forecast.creditAccounts(d.plan, d.debts, d.meta.asOf, {
    extraFacilities: d.revolvingExtra,
  });
  const html = creditPageHtml(accounts);
  $('credit-secured').innerHTML = html.secured;
  $('credit-cards').innerHTML = html.cards;
  $('credit-cards-lede').textContent = html.cardsLede;
  $('credit-note').textContent = html.note;
}

App.register(renderCredit);
App.boot();
