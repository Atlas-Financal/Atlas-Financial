'use strict';
/* Bills — "What recurring household bills does the household carry?"
 *
 * Every card comes from Forecast.householdBills on the served /data.json the
 * shared core fetched. Cadence, next date, monthly-equivalent and the page
 * total are Forecast's. This file formats those outputs into the same
 * fact-card language Credit uses. It never annualises a bill, never relabels
 * quarterly or biweekly as monthly, never invents a next date from the clock,
 * never infers paid/unpaid because a date passed, and never totals page
 * constants.
 *
 * An unknown fact stays "Unknown". It is never printed as $0 or as a monthly
 * bill merely for presentation. */

const BILLS_CONFIDENCE_CHIP = { verified: 'v', confirmed: 'v', calculated: 'e', estimated: 'w' };

function billsConfidenceChip(confidence) {
  const value = confidence || 'unknown';
  const cls = BILLS_CONFIDENCE_CHIP[value] || 'c';
  return `<span class="chip ${cls}">${escapeHtml(String(value).toUpperCase())}</span>`;
}

function billsUnknown() {
  return '<span class="fact-unknown">Unknown</span>';
}

function billsMoney(amount, confidence) {
  if (amount == null || !isFinite(Number(amount))) return billsUnknown();
  const estimated = confidence === 'estimated';
  return `${estimated ? '≈ ' : ''}${money2(amount)}`;
}

function billsFact(label, value, small, attrs) {
  return `<div class="fact-card-fact"${attrs ? ' ' + attrs : ''}><dt>${label}</dt><dd>${value}${small ? `<small>${small}</small>` : ''}</dd></div>`;
}

function billsCardHtml(row) {
  const cadence = row.frequencyLabel ? escapeHtml(row.frequencyLabel) : billsUnknown();
  const next = row.nextDate ? fmtDateFull(row.nextDate) : billsUnknown();
  const monthly = row.monthlyEquivalent == null || !isFinite(Number(row.monthlyEquivalent))
    ? billsUnknown()
    : money2(row.monthlyEquivalent);
  return `<article class="fact-card" data-bill-id="${escapeHtml(row.id)}" data-bill-frequency="${escapeHtml(row.frequency || 'unknown')}">
    <div class="fact-card-head">
      <h2>${escapeHtml(row.label)}</h2>
      ${billsConfidenceChip(row.confidence)}
    </div>
    <div class="fact-card-amount" data-bills-fact="amount">
      <span class="lab">Amount</span>
      <b>${billsMoney(row.amount, row.confidence)}</b>
    </div>
    <dl class="fact-card-facts">
      ${billsFact('Cadence', cadence, row.cadenceNote == null ? null : escapeHtml(row.cadenceNote), 'data-bills-fact="cadence"')}
      ${billsFact('Next due', next, null, 'data-bills-fact="next"')}
      ${billsFact('Monthly equivalent', monthly, null, 'data-bills-fact="monthly"')}
    </dl>
  </article>`;
}

function billsListHtml(view) {
  const rows = Array.isArray(view.bills) ? view.bills : [];
  if (!rows.length) {
    return '<p class="lede">No household bills are on this opening.</p>';
  }
  return rows.map(billsCardHtml).join('');
}

function billsTotalHtml(view) {
  const total = view.monthlyEquivalentTotal;
  if (total == null || !isFinite(Number(total))) {
    return `<div data-bills-total="unknown">
      <span>Total monthly equivalent</span>
      <b>${billsUnknown()}</b>
    </div>
    <p class="bills-total-note">No bill on this page has a cadence Atlas can convert to a monthly equivalent.</p>`;
  }
  const excluded = Number(view.monthlyEquivalentExcludedCount) || 0;
  const excludedNote = excluded
    ? ` ${excluded} bill${excluded === 1 ? '' : 's'} with an unknown or one-time cadence ${excluded === 1 ? 'is' : 'are'} listed above and ${excluded === 1 ? 'is' : 'are'} not in this total.`
    : '';
  return `<div data-bills-total="known">
      <span>Total monthly equivalent</span>
      <b>${money2(total)}</b>
    </div>
    <p class="bills-total-note">Comparison figure from bills with a known recurring cadence. It is not the amount that will leave the account every month.${excludedNote}</p>`;
}

function billsPageHtml(view) {
  const rows = Array.isArray(view.bills) ? view.bills : [];
  const asOf = view.asOf ? fmtDateFull(view.asOf) : 'this opening';
  return {
    lede: rows.length
      ? `${rows.length} household bill${rows.length === 1 ? '' : 's'} on the ${asOf} opening. Cadence is the plan frequency. Monthly equivalent is only shown when Forecast can derive it from that cadence.`
      : '',
    list: billsListHtml(view),
    total: billsTotalHtml(view),
    note: 'Cards are Forecast.householdBills from the served plan. Subscriptions and memberships are a separate list and are not here. A dated due whose recurring cadence is not on the plan stays a dated due. A passed date is not treated as paid. Nothing here ranks bills or moves money.',
  };
}

function renderBills(d) {
  const view = Forecast.householdBills(d.plan, d.meta.asOf);
  const html = billsPageHtml(view);
  $('bills-lede').textContent = html.lede;
  $('bills-list').innerHTML = html.list;
  $('bills-total').innerHTML = html.total;
  $('bills-note').textContent = html.note;
}

App.register(renderBills);
App.boot();
