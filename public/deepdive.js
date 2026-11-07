'use strict';
/* Deep Dive — the historical and forensic analysis. This is the original
   dashboard's material, moved off the homepage but preserved whole. */

// Cash is not one thing. Money in a household spending account and money in a
// pass-through account earmarked for someone else are different in kind, and
// adding them together produces a number that is true of nothing.
const CASH_CLASS_LABEL = {
  spendable: 'spendable household cash',
  operational: 'operational / pass-through',
  staging: 'staging',
  'other-liquid': 'other liquid',
  restricted: 'restricted',
};

/* HELOC caption: Forecast owns the current opening, the prior-month delta,
 * and whether every month since the February paydown rose. This page
 * interpolates those facts into the stored historical-window sentence. */
const HELOC_VS_PRIOR = {
  growing: (h) =>
    `Against the ${h.prior.m} observation of ${money2(h.prior.v)}, the ${h.asOf} opening of ${money2(h.current)} is ${money2(Math.abs(h.vsPrior))} higher.`,
  falling: (h) =>
    `Against the ${h.prior.m} observation of ${money2(h.prior.v)}, the ${h.asOf} opening of ${money2(h.current)} is ${money2(Math.abs(h.vsPrior))} lower.`,
  unchanged: (h) =>
    `Against the ${h.prior.m} observation of ${money2(h.prior.v)}, the ${h.asOf} opening of ${money2(h.current)} is unchanged.`,
};
const HELOC_SINCE_PAYDOWN = {
  higher: (h) =>
    `Since the February 2026 paydown (${money2(h.paydown.v)}) the opening is ${money2(Math.abs(h.sincePaydown))} higher`,
  lower: (h) =>
    `Since the February 2026 paydown (${money2(h.paydown.v)}) the opening is ${money2(Math.abs(h.sincePaydown))} lower`,
  unchanged: (h) =>
    `Since the February 2026 paydown (${money2(h.paydown.v)}) the opening is unchanged`,
};

function helocCaption(story, windowProse) {
  const parts = [];
  if (windowProse) parts.push(windowProse.replace(/\s+$/, ''));
  if (story && story.prior && story.current != null && HELOC_VS_PRIOR[story.vsPriorId]) {
    parts.push(HELOC_VS_PRIOR[story.vsPriorId](story));
  }
  if (story && story.paydown && story.sincePaydownId && HELOC_SINCE_PAYDOWN[story.sincePaydownId]) {
    const monthly = story.roseEveryMonthSincePaydown
      ? 'and it has risen every month.'
      : 'and it has not risen every month.';
    parts.push(HELOC_SINCE_PAYDOWN[story.sincePaydownId](story) + ', ' + monthly);
  }
  return parts.join(' ');
}

function renderDeepDive(d) {
  $('coverage-line').textContent = `${d.meta.coverage} · ${d.meta.transactions.toLocaleString('en-CA')} transactions, ${d.meta.statements} statements`;
  $('disclaimer').textContent = d.meta.disclaimer;

  // The cash tile is DERIVED from the plan's cash register, not stored. HOW
  // the held-elsewhere balances group and total is a financial decision and
  // belongs to Forecast.deepDive — where the node suite can reach it. This
  // page prints the returned spendable amount and elsewhere total, and looks
  // the class labels up. It no longer sums or groups.
  const dive = Forecast.deepDive(d);
  const pub = Forecast.publicationTotals(d);
  const classLine = (dive.classes || [])
    .map(v => `${money(v.total)} ${CASH_CLASS_LABEL[v.class] || v.class} (${
      v.labels.map(lab => lab.replace(/ —.*$/, '')).join(', ')})`)
    .join('; ');
  const cashTile = {
    label: 'Spendable household cash',
    value: dive.cashAmount,
    tone: 'alert',
    note: `Chequing A and Chequing B only. Designated Savings remains reserve evidence and is excluded from this ` +
      `spendable amount. A further ${money(dive.elsewhere)} sits elsewhere and is not household spending money: ${classLine}.`,
  };
  // Total debt, annual interest and revolving headroom used to be stored in
  // `data.json` `headline`. They are Forecast.publicationTotals now — the
  // same sums and the same utilisation figure the Plan already publishes —
  // so a balance change cannot leave a stale tile behind. This page prints
  // the returned numbers and holds the wording.
  const headlineTiles = [
    {
      label: 'Total debt',
      value: pub.totalDebt,
      tone: 'plain',
      note: 'Every consumer debt in the household is now captured. Nothing outstanding.',
    },
    {
      label: 'Interest cost / year',
      value: pub.annualInterest,
      tone: 'warn',
      sub: { value: pub.annualInterestExMortgage, label: 'excluding the mortgage' },
      note: `About ${money(pub.monthlyInterest)} every month, of which about ` +
        `${money(pub.monthlyInterestExMortgage)} is not the mortgage`,
    },
    {
      label: 'Credit left, everywhere',
      value: pub.creditLeft,
      tone: 'alert',
      note: `Across ${pub.revolvingFacilityCount} facilities combined`,
    },
  ];

  $('tiles').innerHTML = [cashTile].concat(headlineTiles).map(t => `
    <div class="tile ${t.tone === 'plain' ? '' : t.tone}">
      <div class="lab">${t.label}</div>
      <div class="val">${money(t.value)}</div>
      ${t.sub ? `<div class="subval">${money(t.sub.value)} <span>${t.sub.label}</span></div>` : ''}
      <div class="note">${t.note}</div>
    </div>`).join('');

  // Days between the as-of date and a due date, so urgency can be shown
  // relative to the data rather than to whenever the page happens to be opened.
  const asOfDate = new Date(d.meta.asOf + 'T00:00:00');
  const daysUntil = due => Math.round((new Date(due + 'T00:00:00') - asOfDate) / 86400000);
  const dueWord = n => n === 0 ? 'today' : n < 0 ? Math.abs(n) + 'd ago' : 'in ' + n + 'd';

  const asOf = d.meta.asOf;
  const windowEnd = Forecast.addDays(asOf, (d.plan.windowDays || 91) - 1);
  const schedule = Forecast.expandEvents(d.plan, asOf, windowEnd);
  const dated = schedule.filter(e => e.amount < 0 || e.kind === 'noncash');
  const settled = d.settled || [];
  // Display-only. Plan already has the same lookup; this is not a second
  // authority — it only names the payingAccount expandEvents already set.
  const externalPayerLabel = (plan, event) => {
    const id = event && event.payingAccount;
    if (id === 'amanda-debt-payments') return 'Amanda / TENNIS INCOME';
    const cash = (plan && plan.startingCash) || {};
    const row = (cash.breakdown || []).concat(cash.heldElsewhere || [])
      .find(r => r.id === id);
    return (row && row.label) || id || 'an account outside the joint-cash pool';
  };
  const noteFor = id => {
    for (const list of [d.plan.obligations, d.plan.bills, d.plan.commitments]) {
      const hit = (list || []).find(x => x.id === id);
      if (hit && hit.note) return hit.note;
    }
    return '';
  };

  const rangeDates = settled.map(s => s.date).concat(dated.map(e => e.date)).sort();
  $('upcoming-head').textContent = rangeDates.length
    ? `Dated payments, ${fmtDate(rangeDates[0])} – ${fmtDate(rangeDates[rangeDates.length - 1])}`
    : 'Dated payments';

  const settledRows = settled.map(u => {
    const n = daysUntil(u.date);
    return `
    <tr class="paid">
      <td>${fmtDate(u.date)} <span class="chip v">paid</span></td>
      <td>${u.what}</td>
      <td class="num">${money2(u.amount)}</td>
      <td class="pos"><strong>Paid</strong> — ${u.note || 'Settled'}</td>
    </tr>`;
  });
  const datedRows = dated.map(e => {
    const n = daysUntil(e.date);
    const noncash = e.kind === 'noncash';
    const cardPaid = e.cardPaid === true;
    const external = e.jointCash === false && !cardPaid;
    const soon = !noncash && !external && n >= 0 && n <= 7;
    const chip = noncash ? '<span class="chip">charged</span>'
      : cardPaid ? '<span class="chip">card reserve</span>'
      : external ? '<span class="chip">external</span>'
      : `<span class="chip ${soon ? 'w' : 'e'}">${dueWord(n)}</span>`;
    const kind = e.kind === 'commitment' ? ' <span class="chip">commitment</span>'
      : noncash ? ' <span class="chip">non-cash</span>'
      : cardPaid ? ' <span class="chip">card-paid reserve</span>'
      : external ? ' <span class="chip">not joint-cash</span>' : '';
    const amount = (noncash || external) ? Math.abs(e.amount) : -e.amount;
    const note = noteFor(e.id) || (noncash ? 'No cash leaves' : cardPaid ? 'Card-paid reserve' : 'Due');
    const payer = external ? externalPayerLabel(d.plan, e) : '';
    const status = noncash
      ? '<strong>No cash leaves</strong> — '
      : cardPaid
        ? '<strong>Card-paid reserve — reduces projected joint cash</strong>'
          + (noteFor(e.id) ? ' — ' : '')
        : external
        ? '<strong>Household obligation — paid from ' + payer + ', not joint-cash</strong>'
          + (noteFor(e.id) ? ' — ' : '')
        : '';
    const detail = (external || cardPaid) ? (noteFor(e.id) || '') : note;
    return `
    <tr class="${noncash || external ? '' : soon ? 'soon' : ''}">
      <td>${fmtDate(e.date)} ${chip}</td>
      <td>${e.label}${kind}</td>
      <td class="num">${noncash || external
        ? `<span class="mutedtext">${money2(amount)}</span>` : money2(amount)}</td>
      <td>${status}${detail}</td>
    </tr>`;
  });
  $('upcoming').innerHTML = settledRows.concat(datedRows).join('');
  $('upcoming-note').textContent = d.upcomingNote;

  // Known major costs on the master plan. The rows and the total come
  // from Forecast.publicationTotals (plan.commitments). The heading is
  // presentation chrome.
  if (d.commitments) {
    const c = d.commitments;
    const items = pub.commitmentItems || [];
    const shownAmount = i => i.amount != null ? money(i.amount)
      : (i.amountMin != null && i.amountMax != null)
        ? `${money(i.amountMin)}–${money(i.amountMax)}` : '';
    $('commit-head').textContent = c.heading;
    $('commit-note').textContent = c.note;
    $('commit-list').innerHTML = items.map(i => `
      <div class="commit">
        <div class="commit-top">
          <span class="commit-what">${i.what}</span>
          <span class="commit-amt">${shownAmount(i)}</span>
        </div>
        <div class="commit-meta">
          <span>${i.when}</span>
          <span class="chip ${i.adjustable ? 'w' : 'e'}">${i.confidence}${i.adjustable ? ' · flexible' : ''}</span>
        </div>
        <p class="commit-note">${i.note}</p>
      </div>`).join('')
      + `<div class="commit total">
           <div class="commit-top"><span class="commit-what">Total</span><span class="commit-amt">${money(pub.commitmentsTotal)}</span></div>
         </div>`;
    $('commit-total-note').textContent = c.totalNote;
    $('commitments').hidden = false;
  }

  // Which obligation is next is a selection, not formatting: it decides what
  // the household is told it owes soonest. The engine owns it, where the node
  // suite can prove which item wins and why. This block renders the answer.
  // The stream is the Plan's expandEvents output — the same authority as the
  // Plan calendar and nextPaymentOut — not a hand-kept upcoming list.
  const next = Forecast.nextDue(schedule, asOf);
  const nd = $('next-due');
  if (nd && next) {
    nd.hidden = false;
    nd.innerHTML = `<span class="nd-lab">Next named payment due</span><b>${next.what}</b>` +
      `<span>${money2(next.amount)} on ${fmtDateLong(next.due)} — this one obligation, not the day's cash-out total</span>` +
      `<span class="chip ${next.daysUntil <= 7 ? 'w' : 'e'}">${dueWord(next.daysUntil)}</span>`;
  }

  const known = d.debts.filter(x => x.annualInterest != null);
  hbar($('c-debt'), known.map((x, i) => ({
    label: x.label, v: x.annualInterest,
    colour: [css('--s1'), css('--s2'), css('--critical'), css('--critical')][i] || css('--s1'),
    tip: `${money2(x.balance)} at ${pct(x.rate)} · ${x.structure}`,
  })), { rowH: 44, padL: 176 });

  $('debt-table').innerHTML = d.debts.map(x => `
    <tr>
      <td>${x.label}</td>
      <td class="num">${x.balance == null ? '<span class="chip c">unknown</span>' : money2(x.balance)}</td>
      <td class="num ${x.rate >= 20 ? 'neg' : x.rate && x.rate < 5 ? 'pos' : ''}">${x.rate == null ? '—' : pct(x.rate)}</td>
      <td>${x.structure}</td>
      <td class="num">${x.annualInterest == null ? '—' : '~' + money(x.annualInterest)}</td>
    </tr>`).join('');
  if (d.debtsNote) $('debt-note').textContent = d.debtsNote;

  // Derived from the debt records, never a second hand-kept list. `used`
  // already includes known pending charges, because a charge that has been
  // authorised has spent the credit whether or not it has posted yet.
  const util = Forecast.utilisation(d.debts, d.revolvingExtra, d.plan);
  hbar($('c-util'), util.rows.map(u => ({
    label: u.label, v: u.pct,
    colour: u.pct > 95 ? css('--critical') : css('--serious'),
    // Over the limit is a different fact from merely near it, so say so rather
    // than showing "$0 left" and letting the bar imply it. Unknown pending is
    // not posted room — do not print "$200 left" from limit − posted.
    vlabel: u.overLimit ? money(u.overLimitBy) + ' OVER'
      : (u.pendingUnknown || u.available == null ? 'pending unknown' : money(u.available) + ' left'),
    tip: `${money2(u.used)} of a ${money2(u.limit)} limit · ${u.pct.toFixed(1)}% used`
      + (u.pendingUnknown ? ' · pending not observed, not $0'
        : (u.pending ? ` · includes ${money2(u.pending)} pending, already incurred` : '')),
  })), { rowH: 40, padL: 176 });
  if (d.utilisationNote) $('util-note').textContent = d.utilisationNote;

  lineChart($('c-heloc'), dive.heloc.history, pub.helocLimit);
  $('heloc-note').textContent = helocCaption(dive.heloc, d.helocSummary);

  diverge($('c-flow'), d.cashflow);
  $('flow-note').textContent = d.cashflowNote;

  const grey = css('--muted');

  // Income. The coaching line is gross revenue, so it is coloured as a caution
  // rather than as money the household keeps.
  if (d.income) {
    hbar($('c-income'), (pub.incomeLines || d.income).map(i => ({
      label: i.label, v: i.total,
      colour: /REVENUE/i.test(i.stability || '') || /REVENUE/i.test(i.label) ? css('--serious') : css('--s2'),
      tip: `${i.perMonth ? '~' + money(i.perMonth) + '/month · ' : ''}${i.stability || ''}`,
    })), { rowH: 40, padL: 190 });
    $('income-note').textContent =
      `${money2(pub.incomeTotal)} over ${pub.incomeMonths} months, about ${money(pub.incomePerMonth)}/month. ${d.incomeNote || ''}`;
    if (d.incomeWarning) $('income-warning').textContent = d.incomeWarning;
  }

  $('paypal-table').innerHTML = d.paypal.categories.map(c => `
    <tr><td>${c.label}</td><td class="num">${money2(c.total)}</td><td class="num">~${money(c.perMonth)}</td></tr>`).join('')
    + `<tr><td><strong>Total</strong></td><td class="num"><strong>—</strong></td><td class="num"><strong>~${money(d.paypal.perMonth)}</strong></td></tr>`;
  $('paypal-note').textContent = `${d.paypal.note} Cross-checked against ${money(d.paypal.crossCheck)}/month of bank funding pulls.`;

  hbar($('c-unex'), d.unexplained.map(u => ({
    label: u.label, v: u.amount,
    colour: u.amount > 40000 ? css('--critical') : css('--serious'),
    tip: u.note,
  })), { rowH: 40, padL: 190 });

  // What the HELOC was actually spent on. Interest is coloured apart from the
  // rest: it is the price of the facility, not a thing anyone chose to buy.
  if (d.helocUse) {
    hbar($('c-heloc-use'), d.helocUse.map(u => ({
      label: u.label, v: u.amount,
      colour: /bills, paid direct/i.test(u.label) ? css('--critical')
            : /Interest charged/i.test(u.label) ? grey : css('--s1'),
      tip: `${u.n} transaction${u.n === 1 ? '' : 's'} · ${u.note}`,
    })), { rowH: 40, padL: 210 });
    $('heloc-use-note').textContent = d.helocUseNote;
    $('heloc-chains').textContent = d.helocChains;
  }

  // The Cash Back Visa interest reconciliation. WHICH cycles do not fit the
  // card's rate, the implied and charged totals, and the rate itself, are
  // Forecast.deepDive — the rate is the Cash Back Visa record, the ±4pp
  // band is the incumbent rule, and the page no longer carries a 26.99
  // literal. This block renders the returned rows.
  if (dive.interest) {
    const ic = d.interestCheck;
    $('interest-check').innerHTML = dive.interest.rows.map(r => {
      return `<tr><td>${r.stmt}</td><td class="num">${money2(r.avg)}</td>
        <td class="num">${money2(r.implied)}</td><td class="num">${money2(r.charged)}</td>
        <td class="num ${r.off ? 'neg' : ''}">${r.eff.toFixed(2)}%</td></tr>`;
    }).join('') + `<tr><td><strong>Five cycles</strong></td><td class="num">—</td>
      <td class="num"><strong>${money2(dive.interest.impliedTotal)}</strong></td>
      <td class="num"><strong>${money2(dive.interest.chargedTotal)}</strong></td>
      <td class="num"><strong>${dive.interest.rate.toFixed(2)}%</strong></td></tr>`;
    $('interest-check-note').textContent = ic.note;
    $('interest-check-cash').textContent = ic.cash;
  }

  // Youth lacrosse. Two charts: what can be seen, and what paid for it.
  if (d.lacrosse) {
    const L = d.lacrosse;
    hbar($('c-lacrosse'), L.sources.map(s => ({
      label: s.label, v: s.amount,
      colour: css('--s1'),
      tip: `${s.n} charge${s.n === 1 ? '' : 's'} · ${s.note}`,
    })), { rowH: 40, padL: 190 });
    $('lacrosse-note').textContent =
      `${money2(pub.lacrosseVerified)} verified across ${L.sources.reduce((s, x) => s + x.n, 0)} charges — about ${money(L.perMonth)} a month. ${L.note}`;

    hbar($('c-lacrosse-fund'), L.funding.map(f => ({
      label: f.label, v: f.amount,
      colour: /HELOC/i.test(f.label) ? css('--critical') : css('--s2'),
      tip: f.note || money2(f.amount),
    })), { rowH: 36, padL: 190 });
    $('lacrosse-inferred').textContent = L.inferredNote;
    $('lacrosse-gap').textContent = L.gapNote;
  }

  // E-transfer counterparties, and why the coverage is what it is.
  if (d.counterparties) {
    const c = d.counterparties;
    const pctOf = n => Math.round((n / c.total) * 100) + '%';
    $('cp-stat').innerHTML = [
      { lab: 'Attributed now', val: `${c.attributed} of ${c.total}`, note: pctOf(c.attributed) + ' of all e-transfers', tone: '' },
      { lab: 'Before this pass', val: `${c.previous} of ${c.total}`, note: pctOf(c.previous) + ' — the rest were in the bin', tone: '' },
      { lab: 'Still anonymous', val: `${c.total - c.attributed}`, note: 'no payee, and mostly unrecoverable', tone: 'alert' },
    ].map(t => `
      <div class="tile ${t.tone}">
        <div class="lab">${t.lab}</div><div class="val">${t.val}</div><div class="note">${t.note}</div>
      </div>`).join('');
    $('cp-note').textContent = c.note;
    $('cp-finding').textContent = c.finding;
    $('cp-action').textContent = c.action;
    $('cp-matching').textContent = c.matching;
  }

  // The coaching remittance, traced hop by hop. The last row is the point, so
  // it is marked rather than left for the reader to spot.
  if (d.coachPayment) {
    const c = d.coachPayment;
    $('coach-chain').innerHTML = c.chain.map((h, i) => `
      <tr><td>${h.when}</td><td${i === c.chain.length - 1 ? ' class="neg"' : ''}>${h.what}</td>
      <td class="num">${money2(h.balance)}</td></tr>`).join('');
    $('coach-note').textContent = c.note;
    $('coach-reading').textContent = c.reading;
    $('coach-remaining').textContent = c.remaining;
  }

  if (d.spendingNote) $('spending-detail').textContent = d.spendingNote;

  // Tiers are priority (1/2/3), not status. OPEN / ANSWERED is owned by
  // docs/01_OPEN_QUESTIONS.md; this page must not independently close a question.
  $('questions').innerHTML = d.questions.map(q => `
    <div class="qcard ${q.tier === 2 ? 't2' : q.tier === 3 ? 't3' : ''}">
      <h3>${q.q}</h3>
      <p>${q.detail}</p>
      <p class="chg"><strong>What it changes:</strong> ${q.changes} <span class="chip">${q.owner}</span></p>
    </div>`).join('');
}

/* --------------------------------------------------- periods (interactive) */
let CURRENT = 'lastMonth';   // a complete month reads better on first load than
                             // a part-finished one

function renderPeriod(d, periods) {
  if (!periods) return;
  const p = periods.periods[CURRENT];
  const grey = css('--muted');
  const dive = Forecast.deepDive(d, p);
  const snap = dive.period;

  [...$('period-bar').children].forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.k === CURRENT)));

  const per = snap.spendingMonthly != null
    ? ` · ${money(snap.spendingMonthly)}/month across ${snap.months} months` : '';
  $('period-summary').innerHTML =
    `<b>${money2(p.spendingTotal)}</b> spending · <b>${money2(p.interestTotal)}</b> interest · ` +
    `<b>${money2(p.feesTotal)}</b> fees${per}`;

  hbar($('c-spend'), p.spending.map(s => {
    const cls = Forecast.publishedSpendType(s.types || [s.type]);
    return {
      label: s.label, v: s.total,
      colour: cls === 'essential' ? css('--s1')
            : cls === 'business' ? css('--s2')
            : cls === 'unknown' ? grey : css('--serious'),
      tip: `${cls} · ${money2(s.total)}`,
    };
  }), { rowH: 30, padL: 180 });

  const caveat = (d && d.spendingNote) ? ' ' + d.spendingNote : '';
  $('spend-note').textContent =
    `${p.label}, captured through ${fmtDateLong(periods.asOf)}. Blue is essential, orange discretionary, grey unidentified or mixed. ` +
    `Discretionary is ${money2(snap.discretionary)} — ${snap.discretionaryShare.toFixed(0)}% of the total, ` +
    `and the part that is a decision rather than a fixed cost.` + caveat;

  hbar($('c-interest'), p.interest.map(s => ({
    label: s.label, v: s.total, colour: css('--serious'), tip: money2(s.total),
  })), { rowH: 34, padL: 180 });
  $('interest-note').textContent =
    `${money2(p.interestTotal)} of interest charged in ${p.label.toLowerCase()}. ` +
    `The mortgage adds about ${money(dive.mortgageMonthly)}/month on top, inside its payment rather than as a charge.`;

  hbar($('c-fees'), p.fees.map(s => ({
    label: s.label, v: s.total,
    colour: s.type === 'avoidable' ? css('--critical') : css('--s1'),
    tip: `${s.type} · ${money2(s.total)}`,
  })), { rowH: 34, padL: 180 });
  $('fees-note').textContent = p.feesTotal
    ? `${money2(p.feesTotal)} of fees, of which ${money2(snap.avoidable)} was avoidable — red bars. `
      + `Avoidable means it followed from something that happened, not from holding the account.`
    : 'No fees in this period.';

  grouped($('c-trend'), periods.monthly, [
    { key: 'spending', label: 'Spending', colour: css('--s1') },
    { key: 'interest', label: 'Interest', colour: css('--serious') },
    { key: 'fees', label: 'Fees', colour: css('--critical') },
  ]);
  $('trend-note').textContent =
    'Every month captured, on one scale — so interest and fees look small beside spending, which is the '
    + 'honest comparison but hard to read. Hover any month for exact figures. Card spending only begins in '
    + 'August 2025, so earlier months show chequing alone and are lower for that reason rather than because '
    + 'less was spent.';
}

function setupPeriods(d, periods) {
  if (!periods) return;
  const bar = $('period-bar');
  bar.replaceChildren();
  for (const [k, v] of Object.entries(periods.periods)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'preset'; b.dataset.k = k;
    b.textContent = v.label.replace(/ \(.*\)/, '');
    b.title = v.label;
    b.addEventListener('click', () => { CURRENT = k; renderPeriod(App.data, periods); });
    bar.appendChild(b);
  }
}

App.once(setupPeriods);
App.register(renderDeepDive);
App.register(renderPeriod);
App.boot({ periods: true });
