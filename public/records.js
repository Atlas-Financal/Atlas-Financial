'use strict';
/* Records — balance sheet, coverage, and the forecast's stated assumptions. */

function recordsCashScopeNote(note) {
  return String(note || '').replace(/Chequing A, Chequing B and Savings/g,
    'Chequing A and Chequing B (designated Savings is reserve evidence, excluded from spendable cash)');
}

function renderRecords(d) {
  $('coverage-line').textContent = `${d.meta.coverage} · ${d.meta.transactions.toLocaleString('en-CA')} transactions, ${d.meta.statements} statements`;
  $('disclaimer').textContent = d.meta.disclaimer;

  const pub = Forecast.publicationTotals(d);
  $('assets').innerHTML = pub.assetRows.map(a => `
    <tr><td>${a.label}</td><td class="num ${a.value < 0 ? 'neg' : ''}">${money2(a.value)}</td></tr>`).join('')
    + `<tr><td><strong>Total assets</strong></td><td class="num"><strong>${money2(pub.assets)}</strong></td></tr>`
    + `<tr><td><strong>Total known debt</strong></td><td class="num neg"><strong>${money2(pub.totalDebt)}</strong></td></tr>`
    + `<tr><td><strong>Financial accounts only</strong></td><td class="num neg"><strong>${money2(pub.financialAccountsOnly)}</strong></td></tr>`;
  if (d.assetsNote) $('assets-note').textContent = d.assetsNote;
  $('nw-caveat').textContent = d.netWorth.caveat;

  $('coverage').innerHTML = d.coverage.map(c => `
    <tr><td><strong>${c.source}</strong></td><td>${c.what}</td>
    <td><span class="chip ${c.status === 'complete' ? 'v' : c.status === 'blocked' ? 'e' : 'c'}">${c.status}</span></td></tr>`).join('');

  if (d.plan) {
    $('assumptions').innerHTML = d.plan.assumptions.map(a => `<li>${recordsCashScopeNote(a)}</li>`).join('');

    // Every stream and obligation with its stated basis, so a figure on the
    // Plan page can always be traced to its source here.
    const li = (label, amount, freq, conf, note) => `
      <div class="deriv">
        <div class="deriv-top">
          <span>${label}</span>
          <span class="chip ${conf === 'confirmed' ? 'v' : 'w'}">${conf}</span>
          <span class="deriv-amt">${amount} <span class="mutedtext">${freq}</span></span>
        </div>
        ${note ? `<p class="deriv-note">${note}</p>` : ''}
      </div>`;
    const freqWord = s => s.frequency === 'biweekly' ? 'bi-weekly'
      : s.frequency === 'once' ? 'one-time'
      : s.frequency === 'quarterly' ? 'every 3 months'
      : s.frequency === 'yearly' ? 'yearly'
      : 'monthly';
    const shownAmount = i => i.amount != null ? money(i.amount)
      : (i.amountMin != null && i.amountMax != null)
        ? `${money(i.amountMin)}–${money(i.amountMax)}` : '';
    const settledCommitments = (d.plan.commitments || [])
      .filter(c => Forecast.commitmentStatus(c) === 'settled');
    $('derivations').innerHTML =
      '<h3>Income streams</h3>' +
      d.plan.income.map(s => li(s.label,
        s.amount != null ? money2(s.amount)
          : Object.entries(s.scenarioMonthly).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)} ${money(v)}`).join(' · '),
        s.amount != null ? freqWord(s) : 'per month, by scenario', s.confidence, s.note)).join('') +
      '<h3>Debt minimums &amp; mortgage</h3>' +
      d.plan.obligations.map(o => li(o.label, money2(o.amount), freqWord(o), o.confidence, o.note)).join('') +
      '<h3>Recurring bills</h3>' +
      (d.plan.bills || []).map(b => li(b.label, money2(b.amount), freqWord(b), b.confidence, b.note)).join('') +
      (d.plan.billsNote ? `<p class="deriv-note">${d.plan.billsNote}</p>` : '') +
      '<h3>Commitments</h3>' +
      settledCommitments.map(c => li(`${c.label} — ${c.date ? fmtDate(c.date)
        : (c.when || (c.settledOn ? fmtDate(c.settledOn) : 'TBD'))}`, money2(c.amount),
        'settled', c.confidence, c.note)).join('') +
      (pub.commitmentItems || []).map(i => li(`${i.what} — ${i.when}`, shownAmount(i),
        i.adjustable ? 'optional' : 'one-time',
        i.confidence, i.note)).join('');
  }
}

App.register(renderRecords);
App.boot();
