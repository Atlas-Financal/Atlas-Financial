'use strict';
/* Subscriptions — "What recurring subscriptions and memberships does the household carry?"
 *
 * Every card comes from Forecast.householdSubscriptions on the served
 * /data.json the shared core fetched. Cadence, next date, monthly-equivalent
 * and the page total are Forecast's. This file formats those outputs into the
 * same fact-card language Credit uses. It never annualises a charge, never
 * relabels yearly or biweekly as monthly, never invents a next date from the
 * clock, never classifies a merchant as a subscription, and never totals page
 * constants.
 *
 * An unknown fact stays "Unknown". It is never printed as $0 or as a monthly
 * charge merely for presentation. */

const SUBSCRIPTIONS_CONFIDENCE_CHIP = { verified: 'v', confirmed: 'v', calculated: 'e', estimated: 'w' };

function subscriptionsConfidenceChip(confidence) {
  const value = confidence || 'unknown';
  const cls = SUBSCRIPTIONS_CONFIDENCE_CHIP[value] || 'c';
  return `<span class="chip ${cls}">${escapeHtml(String(value).toUpperCase())}</span>`;
}

function subscriptionsUnknown() {
  return '<span class="fact-unknown">Unknown</span>';
}

function subscriptionsMoney(amount, confidence) {
  if (amount == null || !isFinite(Number(amount))) return subscriptionsUnknown();
  const estimated = confidence === 'estimated';
  return `${estimated ? '≈ ' : ''}${money2(amount)}`;
}

function subscriptionsFact(label, value, small, attrs) {
  return `<div class="fact-card-fact"${attrs ? ' ' + attrs : ''}><dt>${label}</dt><dd>${value}${small ? `<small>${small}</small>` : ''}</dd></div>`;
}

function subscriptionsCardHtml(row) {
  const cadence = row.frequencyLabel ? escapeHtml(row.frequencyLabel) : subscriptionsUnknown();
  const next = row.nextDate ? fmtDateFull(row.nextDate) : subscriptionsUnknown();
  const monthly = row.monthlyEquivalent == null || !isFinite(Number(row.monthlyEquivalent))
    ? subscriptionsUnknown()
    : money2(row.monthlyEquivalent);
  return `<article class="fact-card" data-subscription-id="${escapeHtml(row.id)}" data-subscription-frequency="${escapeHtml(row.frequency || 'unknown')}">
    <div class="fact-card-head">
      <h2>${escapeHtml(row.label)}</h2>
      ${subscriptionsConfidenceChip(row.confidence)}
    </div>
    <div class="fact-card-amount" data-subscriptions-fact="amount">
      <span class="lab">Amount</span>
      <b>${subscriptionsMoney(row.amount, row.confidence)}</b>
    </div>
    <dl class="fact-card-facts">
      ${subscriptionsFact('Cadence', cadence, row.cadenceNote == null ? null : escapeHtml(row.cadenceNote), 'data-subscriptions-fact="cadence"')}
      ${subscriptionsFact('Next charge', next, null, 'data-subscriptions-fact="next"')}
      ${subscriptionsFact('Monthly equivalent', monthly, null, 'data-subscriptions-fact="monthly"')}
    </dl>
  </article>`;
}

function subscriptionsListHtml(view) {
  const rows = Array.isArray(view.subscriptions) ? view.subscriptions : [];
  if (!rows.length) {
    return '<p class="lede">No subscriptions are on this opening.</p>';
  }
  return rows.map(subscriptionsCardHtml).join('');
}

function subscriptionsTotalHtml(view) {
  const total = view.monthlyEquivalentTotal;
  if (total == null || !isFinite(Number(total))) {
    return `<div data-subscriptions-total="unknown">
      <span>Total monthly equivalent</span>
      <b>${subscriptionsUnknown()}</b>
    </div>
    <p class="subscriptions-total-note">No subscription on this page has a cadence Atlas can convert to a monthly equivalent.</p>`;
  }
  const excluded = Number(view.monthlyEquivalentExcludedCount) || 0;
  const excludedNote = excluded
    ? ` ${excluded} subscription${excluded === 1 ? '' : 's'} with an unknown or one-time cadence ${excluded === 1 ? 'is' : 'are'} listed above and ${excluded === 1 ? 'is' : 'are'} not in this total.`
    : '';
  return `<div data-subscriptions-total="known">
      <span>Total monthly equivalent</span>
      <b>${money2(total)}</b>
    </div>
    <p class="subscriptions-total-note">Monthly equivalent normalizes non-monthly charges. It is not the amount that will leave the account every month.${excludedNote}</p>`;
}

function subscriptionsPageHtml(view) {
  const rows = Array.isArray(view.subscriptions) ? view.subscriptions : [];
  const asOf = view.asOf ? fmtDateFull(view.asOf) : 'this opening';
  return {
    lede: rows.length
      ? `${rows.length} subscription${rows.length === 1 ? '' : 's'} on the ${asOf} opening.`
      : '',
    list: subscriptionsListHtml(view),
    total: subscriptionsTotalHtml(view),
    note: 'Cards are Forecast.householdSubscriptions from the served plan. Household bills are a separate list. A yearly or biweekly charge keeps that cadence on screen. Unknown facts stay Unknown. Nothing here cancels a service or moves money.',
  };
}

function renderSubscriptions(d) {
  const view = Forecast.householdSubscriptions(d.plan, d.meta.asOf);
  const html = subscriptionsPageHtml(view);
  $('subscriptions-lede').textContent = html.lede;
  $('subscriptions-list').innerHTML = html.list;
  $('subscriptions-total').innerHTML = html.total;
  $('subscriptions-note').textContent = html.note;
}

App.register(renderSubscriptions);
App.boot();
