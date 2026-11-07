'use strict';
/* The two interactive modellers — payoff and the May 2027 renewal.

   Both answers are the engine's. The payoff figures are
   `Forecast.payoffDebts` / `Forecast.payoffModel`'s and the renewal comparison
   is `Forecast.renewal`'s. This file reads the controls, hands them over, and
   formats what comes back: it compounds nothing, charges no interest, solves
   for no payment, and decides neither which debt may be modelled nor which side
   of the renewal trade is better. Everything here is wording, colour and
   layout. */

/* --------------------------------------------------------------- wording */
/* ------------------------------------------------------------ the payoff */

// The preset buttons. The engine decides what each one costs and drops any it
// cannot price; this decides only what they are called.
const PAYOFF_PRESET_LABEL = {
  minimum: 'Minimum',
  'clear-60': 'Clear in 5 yrs',
  'clear-36': 'Clear in 3 yrs',
  'clear-12': 'Clear in 1 yr',
};

// A rate means nothing without the convention it is charged under, so the
// modeller says which one this debt carries rather than leaving it implied.
const PAYOFF_CONVENTION_NOTE = {
  card: 'charged as a daily rate over the days in each statement cycle',
  variable: 'a prime-linked rate, quoted compounded monthly',
};

// ...and a convention means nothing without saying how closely it is modelled.
// A card does not charge monthly, so a monthly model prices its AVERAGE cycle:
// right over a year, approximate for any one month. Publishing that single
// month's figure as though it were the real charge is the thing this refuses
// to do — so it is published with the band the cycle length actually allows.
const PAYOFF_PRECISION_NOTE = {
  exact: () => '',
  'monthly-equivalent': x => ` That monthly figure prices an average statement cycle: a real one runs `
    + `${x.interestOnlyBand.minDays}–${x.interestOnlyBand.maxDays} days, which puts the first charge between `
    + `${money2(x.interestOnlyBand.low)} and ${money2(x.interestOnlyBand.high)}. Over a full year the cycles `
    + `add up either way, so the payoff time below moves far less than that band suggests.`,
};
// The month-1 row carries the same caveat where it applies, because that row is
// the single-period figure the band is about.
const PAYOFF_MONTH1_LABEL = {
  exact: 'Of which interest, month 1',
  'monthly-equivalent': 'Of which interest, month 1 (average cycle)',
};

// How well the minimum is known. Most of them are a future statement amount
// held at today's level rather than a confirmed bill, and every payoff figure
// on this page is measured against that number — so it is tagged where it is
// stated, and again on the line that compares against it.
const PAYOFF_MINIMUM_CONFIDENCE = {
  confirmed: '',
  estimated: ' — estimated, because the plan carries it as a future statement minimum '
    + 'rather than a confirmed amount',
};
const PAYOFF_VERSUS_MINIMUM = { confirmed: 'the minimum', estimated: 'the estimated minimum' };

// Whether there is a monthly cash minimum to measure a larger payment against.
// A facility whose only charge is capitalised has none, and saying so is the
// difference between "$0.00 a month" and "$814.18 a month that nobody pays".
const PAYOFF_MINIMUM_NOTE = {
  cash: x => `The minimum is ${money2(x.minimum)} a month${PAYOFF_MINIMUM_CONFIDENCE[x.minimumConfidence]}.`,
  none: () => 'No household cash leaves an account for it, so it has no minimum '
    + 'to compare against — at $0 a month the balance simply grows by the interest.',
  unknown: () => 'Its monthly minimum is unknown, so no payment here is compared against it.',
};

// Named, so the household can see which obligation is missing rather than only
// that the minimum above is short by something.
const PAYOFF_MINIMUM_GAP = x => x.minimumId === 'unknown'
  ? ` (${x.unmodelled.join(', ')} ${x.unmodelled.length === 1 ? 'has' : 'have'} no known monthly amount.)`
  : ` ${x.unmodelled.length === 1 ? 'One further payment' : 'Further payments'} against it `
  + `(${x.unmodelled.join(', ')}) ${x.unmodelled.length === 1 ? 'has' : 'have'} no monthly `
  + `equivalent, so ${x.unmodelled.length === 1 ? 'it is' : 'they are'} not in that minimum.`;

/* ----------------------------------------------------------- the renewal */
/* One entry per result the engine can return. These choose none of it — a
   missing entry is a rendering failure, which is why test-renewal.js checks
   that the two sides still name the same set. */

// Which rate convention the household is looking at. Canada quotes fixed and
// variable mortgage rates on different compounding, so the same slider position
// is a different payment — saying which one this is, is part of the answer.
const RATE_BASIS_LABEL = { fixed: 'fixed', variable: 'variable' };
const RATE_BASIS_NOTE = {
  fixed: 'Fixed rates are quoted <b>compounded semi-annually</b> — the convention TD and every '
    + 'Canadian lender price a fixed mortgage on. This is the one to use for a quoted renewal offer.',
  variable: 'Variable rates are quoted <b>compounded monthly</b>. This is the convention the current '
    + 'mortgage is on (TD Mortgage Prime − 0.96%) and the one the HELOC accrues at.',
};

// The paragraph beside the sliders: what today actually costs.
const RENEWAL_CONTEXT = {
  capitalised: r => r.today.helocCash > 0
    ? `<b>Today, household cash:</b> mortgage ${renewalCash(r.today.mortgageCash)}/month equivalent plus the HELOC cash minimum ${renewalCash(r.today.helocCash)} — ${renewalCash(r.today.householdCash)} a month.<br>`
      + `<b>Today, HELOC economic cost:</b> ${money(r.today.helocEconomic)}/month of interest `
      + `<b>capitalised onto the balance</b>. The cash minimum leaves chequing and is a payment against that balance; capitalised interest is the rest of the charge, not a second bill.`
    : `<b>Today, household cash:</b> the mortgage only — ${renewalCash(r.today.mortgageCash)}/month equivalent. `
      + `Nothing leaves any chequing account for the HELOC.<br>`
      + `<b>Today, HELOC economic cost:</b> ${money(r.today.helocEconomic)}/month of interest `
      + `<b>capitalised onto the balance</b>, so the debt grows by that much every month with nothing `
      + `repaying it. It is a real cost and it buys no equity — it is simply not a bill that gets paid.`,
  paid: r =>
    `Today: mortgage ${renewalCash(r.today.mortgageCash)}/month equivalent plus the HELOC payment `
    + `${renewalCash(r.today.helocCash)} — ${renewalCash(r.today.householdCash)} a month of household cash.`,
};

// The closing note under the figures.
const RENEWAL_NOTE = {
  consolidated: () => 'Both debts amortise. The HELOC principal actually gets repaid.',
  interestOnlyCapitalising: r => r.today.helocCash > 0
    ? `The HELOC stays interest-only AND its interest capitalises. The declared cash minimum is a payment against that compounding balance:
           ${money(r.heloc.opening)} today becomes <b>${money(r.helocOwed)}</b> after ${r.years} years.`
    : `The HELOC stays interest-only AND its interest capitalises, so nothing repays it and it compounds:
           ${money(r.heloc.opening)} today becomes <b>${money(r.helocOwed)}</b> after ${r.years} years.`,
  interestOnlyFlat: r =>
    `The HELOC stays interest-only, so after ${r.years} years its ${money(r.heloc.opening)} is still owed in full.`,
};
const RENEWAL_TONE = {
  consolidated: 'goodline',
  interestOnlyCapitalising: 'warnline',
  interestOnlyFlat: 'warnline',
};
// Whether anything is left owing on the HELOC at the horizon.
const RENEWAL_OWED_TONE = {
  consolidated: 'pos',
  interestOnlyCapitalising: 'neg',
  interestOnlyFlat: 'neg',
};

// The capitalisation row, when there is one to show.
const CAPITALISATION_ROW = {
  stopped: c =>
    `<div class="row"><span>HELOC interest no longer capitalising</span><span class="pos">${money2(c.amount)} / month</span></div>`,
  continues: c =>
    `<div class="row"><span>HELOC interest still capitalising</span><span class="neg">${money2(c.amount)} / month, compounding</span></div>`,
};

// Costs more, costs less, the same — or not comparable, because the engine
// found a scheduled cash payment it could not put on a monthly footing and
// today's baseline is therefore short. The engine ran the comparison and
// decided whether it may be shown; showing an understated difference would
// make the renewal look cheaper against today than it is.
const DELTA_CLASS = { more: 'neg', less: 'pos', same: 'pos', unknown: 'neg' };
const DELTA_TEXT = {
  more: r => '+' + money2(r.delta),
  less: r => money2(r.delta),
  same: r => money2(r.delta),
  unknown: () => 'not comparable',
};
// Named, so the household can see which payment is missing rather than only
// that something is.
// A today figure Forecast could not establish prints "unknown", never $0.
const renewalCash = v => (typeof v === 'number' && Number.isFinite(v) ? money(v) : 'unknown');
const BASELINE_GAP = r =>
  `<br><b>This comparison is withheld:</b> ${r.today.unmodelled.length === 1 ? 'a scheduled payment' : 'scheduled payments'} `
  + `against these debts (${r.today.unmodelled.join(', ')}) ${r.today.unmodelled.length === 1 ? 'has' : 'have'} no monthly `
  + `equivalent, so the figure for today is short by that much and the difference below would flatter the renewal.`;

function setupPayoff(d) {
  // `Forecast.payoffDebts` decides which debts may be modelled, what each one
  // owes today, the rate convention it is charged under, and the minimum a
  // larger payment is measured against. Nothing below reads a debt record.
  const debts = Forecast.payoffDebts(d.plan, d.debts);
  const sel = $('debt-select');
  sel.innerHTML = debts.map((x, i) => `<option value="${i}">${x.label} — ${money(x.balance)} at ${pct(x.rate)}</option>`).join('');
  // Which debt the control OPENS on — a starting view, not an answer. The
  // household's dearest actively-used card is the useful place to land.
  const defaultIdx = debts.findIndex(x => /Triangle/i.test(x.label));
  sel.value = String(defaultIdx >= 0 ? defaultIdx : 0);

  const range = $('pay-range'), presets = $('pay-presets');

  function currentDebt() { return debts[Number(sel.value)]; }

  function syncRange() {
    const x = currentDebt(), b = x.bounds;
    range.min = b.min; range.max = b.max; range.step = 5;
    range.value = b.start;
    presets.innerHTML = '';
    for (const p of x.presets) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'preset';
      btn.textContent = `${PAYOFF_PRESET_LABEL[p.id]} · ${money(p.amount)}`;
      btn.addEventListener('click', () => {
        // A preset outside the slider's own range widens it rather than being
        // clamped to something the household did not ask for.
        range.min = Math.min(range.min, Math.floor(p.amount));
        range.max = Math.max(range.max, Math.ceil(p.amount));
        range.value = Math.round(p.amount); update();
      });
      presets.appendChild(btn);
    }
  }

  function update() {
    const x = currentDebt();
    const P = Number(range.value);
    $('pay-label').textContent = money(P) + ' / month';
    const r = Forecast.payoffModel(x, P);
    const out = $('payoff-out');

    // Plain text, not markup: none of the wording below carries a tag, and the
    // label and structure come from the debt record, so `textContent` keeps a
    // data edit from being able to reach the DOM as HTML.
    $('model-context').textContent =
      `${x.label}: ${money2(x.balance)} at ${pct(x.rate)}, ${PAYOFF_CONVENTION_NOTE[x.convention]}. `
      + `Interest alone runs about ${money(r.interestOnly)} a month, so anything below that makes the balance grow.`
      + `${PAYOFF_PRECISION_NOTE[x.precision](x)} `
      + `${x.structure}. ${PAYOFF_MINIMUM_NOTE[x.minimumId](x)}`
      + (x.unmodelled.length ? PAYOFF_MINIMUM_GAP(x) : '');

    if (!r.clears) {
      out.innerHTML = `
        <div class="big neg">Never clears</div>
        <div class="row"><span>Monthly interest</span><span>${money2(r.interestOnly)}</span></div>
        <div class="row"><span>Your payment</span><span>${money2(r.payment)}</span></div>
        <div class="row"><span>Balance grows by</span><span class="neg">${money2(r.shortfall)}/month</span></div>
        <p class="warnline">This payment is below the interest charge, so the balance rises every month.</p>`;
      return;
    }
    out.innerHTML = `
      <div class="big">${fmtMonths(r.months)}</div>
      <div class="row"><span>Monthly payment</span><span>${money2(r.payment)}</span></div>
      <div class="row"><span>${PAYOFF_MONTH1_LABEL[x.precision]}</span><span>${money2(r.interestOnly)}</span></div>
      <div class="row"><span>Total interest paid</span><span>${money2(r.totalInterest)}</span></div>
      <div class="row"><span>Total paid</span><span>${money2(r.totalPaid)}</span></div>
      ${r.versusMinimum ? `<p class="goodline">Saves ${money2(r.versusMinimum.interestSaved)} in interest versus paying ${PAYOFF_VERSUS_MINIMUM[x.minimumConfidence]} — and clears it ${fmtMonths(r.versusMinimum.monthsSooner)} sooner.</p>` : ''}`;
  }

  sel.addEventListener('change', () => { syncRange(); update(); });
  range.addEventListener('input', update);
  syncRange(); update();
}

function setupRenewal(d) {
  // The mortgage block supplies remaining amortisation for the slider only —
  // a standing fact. The opening rate is the debt record's rate, the same
  // figure `Forecast.renewal` prices. Every balance the arithmetic runs on
  // already comes from the debt records, inside the engine.
  const m = d.mortgage;
  const mortgageDebt = (d.debts || []).find(x => x.id === 'mortgage');
  let consolidate = false;
  // Opens on variable because that is what this household's mortgage is today
  // — TD Mortgage Prime − 0.96%. Neither convention is a safe default for a
  // quoted offer, which is why the control is on the page rather than implied.
  let basis = 'variable';

  const rate = $('rate-range'), amort = $('amort-range');
  const btnNo = $('consol-no'), btnYes = $('consol-yes');
  const btnVariable = $('basis-variable'), btnFixed = $('basis-fixed');

  function setMode(v) {
    consolidate = v;
    btnNo.setAttribute('aria-pressed', String(!v));
    btnYes.setAttribute('aria-pressed', String(v));
    update();
  }
  btnNo.addEventListener('click', () => setMode(false));
  btnYes.addEventListener('click', () => setMode(true));

  function setBasis(v) {
    basis = v;
    btnVariable.setAttribute('aria-pressed', String(v === 'variable'));
    btnFixed.setAttribute('aria-pressed', String(v === 'fixed'));
    update();
  }
  btnVariable.addEventListener('click', () => setBasis('variable'));
  btnFixed.addEventListener('click', () => setBasis('fixed'));

  function update() {
    // The slider carries hundredths of a percent so it can step in 0.05s.
    const annualPct = Number(rate.value) / 100;
    const years = Number(amort.value);
    $('amort-label').textContent = years + ' years';

    const r = Forecast.renewal(d.plan, d.debts, { rate: annualPct, years, consolidate, basis });

    // The rate never appears without the convention it is quoted under.
    $('rate-label').textContent = `${annualPct.toFixed(2)}% ${RATE_BASIS_LABEL[r.basis]}`;
    $('basis-note').innerHTML = RATE_BASIS_NOTE[r.basis];

    $('renewal-context').innerHTML = RENEWAL_CONTEXT[r.today.id](r)
      + (r.today.unmodelled.length ? BASELINE_GAP(r) : '');

    $('renewal-out').innerHTML = `
      <div class="big">${r.paymentComplete === false ? 'Unknown' : money(r.payment)} <span style="font-size:.95rem;font-weight:500;color:var(--text-secondary)">/ month</span></div>
      <div class="row"><span>Versus today's household cash</span><span class="${DELTA_CLASS[r.direction]}">${DELTA_TEXT[r.direction](r)}</span></div>
      ${r.capitalisation ? CAPITALISATION_ROW[r.capitalisation.id](r.capitalisation) : ''}
      <div class="row"><span>Principal financed</span><span>${money2(r.principal)}</span></div>
      <div class="row"><span>Total interest over ${years} years</span><span>${money(r.interest.total)}</span></div>
      <div class="row"><span>HELOC still owed after ${years} years</span><span class="${RENEWAL_OWED_TONE[r.outcome]}">${money(r.helocOwed)}</span></div>
      <p class="${RENEWAL_TONE[r.outcome]}">${RENEWAL_NOTE[r.outcome](r)}</p>
      <p class="lede" style="margin:10px 0 0;font-size:.8rem">Priced as a <b>${RATE_BASIS_LABEL[r.basis]}</b> rate.
      Illustrative only. Ignores fees, penalties, qualification
      and the loan-to-value test — which needs a home valuation. A licensed mortgage professional should run the real numbers.</p>`;
  }

  rate.addEventListener('input', update);
  amort.addEventListener('input', update);
  rate.value = String(Math.round(mortgageDebt.rate * 100));
  amort.value = String(Math.round(m.remainingYears));
  update();
}

// Controls wire once; nothing here draws from CSS variables, so no theme hook.
App.once(d => { setupPayoff(d); setupRenewal(d); });
App.boot();
