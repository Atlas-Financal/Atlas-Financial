'use strict';
/* Display-only assembly of dated balance snapshots.
 *
 * Reads already-written historical observations, orders them, and formats
 * deltas. Does not decide Forecast policy, does not invent missing points,
 * and does not treat credit as cash. The page holds the HTML only.
 */
(function (root) {
  const money2 = n => {
    const v = Number(n);
    const abs = Math.abs(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? '−$' : '$') + abs;
  };
  const fmtDate = iso => {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-CA', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const round2 = v => Math.round(Number(v) * 100) / 100;

  function snapshotsOf(history) {
    return ((history && history.snapshots) || [])
      .filter(s => s && typeof s.asOf === 'string' && Array.isArray(s.accounts))
      .slice()
      .sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
  }

  function accountIds(history) {
    const ids = new Set();
    for (const snap of snapshotsOf(history)) {
      for (const acc of snap.accounts) {
        if (acc && acc.id) ids.add(acc.id);
      }
    }
    return [...ids].sort();
  }

  function seriesFor(history, id) {
    const pts = [];
    for (const snap of snapshotsOf(history)) {
      const acc = snap.accounts.find(a => a.id === id);
      if (!acc || !Number.isFinite(Number(acc.balance))) continue;
      pts.push({
        asOf: snap.asOf,
        id: acc.id,
        label: acc.label,
        collection: acc.collection,
        side: acc.side,
        currency: acc.currency || 'CAD',
        balance: Number(acc.balance),
        pending: acc.pendingUnknown ? null : (acc.pending == null ? null : Number(acc.pending)),
        pendingUnknown: acc.pendingUnknown === true,
        pot: acc.pot || null,
      });
    }
    return pts;
  }

  function isDebtPoint(pt) {
    return !!(pt && (pt.collection === 'debts' || pt.side === 'liability'));
  }

  function pendingAmount(pt) {
    if (!pt || pt.pendingUnknown) return null;
    if (pt.pending == null) return 0;
    const n = Number(pt.pending);
    return Number.isFinite(n) ? n : null;
  }

  function exposureOf(pt) {
    const pending = pendingAmount(pt);
    if (pending == null || !pt || !Number.isFinite(Number(pt.balance))) return null;
    return round2(Number(pt.balance) + pending);
  }

  function signedDirection(delta) {
    if (delta > 0) return 'up';
    if (delta < 0) return 'down';
    return 'unchanged';
  }

  function emptyMove(current) {
    return {
      sufficient: false,
      current: current || null,
      prior: null,
      delta: null,
      direction: null,
      postedDelta: null,
      postedDirection: null,
      exposureSufficient: false,
      currentExposure: current ? exposureOf(current) : null,
      priorExposure: null,
      exposureDelta: null,
      exposureDirection: null,
      pendingUnknown: !!(current && current.pendingUnknown),
    };
  }

  function displayMove(points) {
    if (!points || points.length === 0) return emptyMove(null);
    const current = points[points.length - 1];
    if (points.length < 2) return emptyMove(current);
    const prior = points[points.length - 2];
    const postedDelta = round2(current.balance - prior.balance);
    const postedDirection = signedDirection(postedDelta);
    const currentExposure = exposureOf(current);
    const priorExposure = exposureOf(prior);
    const exposureSufficient = currentExposure != null && priorExposure != null;
    const exposureDelta = exposureSufficient ? round2(currentExposure - priorExposure) : null;
    const exposureDirection = exposureSufficient ? signedDirection(exposureDelta) : null;
    const pendingUnknown = current.pendingUnknown === true || prior.pendingUnknown === true;
    const sufficient = isDebtPoint(current) ? (exposureSufficient && !pendingUnknown) : true;
    const direction = sufficient
      ? (isDebtPoint(current) && exposureSufficient ? exposureDirection : postedDirection)
      : null;
    return {
      sufficient,
      current,
      prior,
      delta: postedDelta,
      direction,
      postedDelta,
      postedDirection,
      exposureSufficient,
      currentExposure,
      priorExposure,
      exposureDelta,
      exposureDirection,
      pendingUnknown,
    };
  }

  function movementWord(move, label) {
    const name = label || (move.current && move.current.label) || 'This account';
    if (move.pendingUnknown && isDebtPoint(move.current)) {
      const when = move.prior
        ? `Between ${fmtDate(move.prior.asOf)} and ${fmtDate(move.current.asOf)} `
        : (move.current ? `On ${fmtDate(move.current.asOf)} ` : '');
      return `${when}${name} posted balance is visible, but pending is unknown. Not a complete debt trend.`;
    }
    if (!move.sufficient) {
      if (move.current) {
        return `${name} has one dated opening (${fmtDate(move.current.asOf)}). Not enough history yet for a trend.`;
      }
      return `${name} has no dated opening yet.`;
    }
    const useExposure = isDebtPoint(move.current) && move.exposureSufficient;
    const direction = useExposure ? move.exposureDirection : move.direction;
    const amount = useExposure ? move.exposureDelta : move.delta;
    const pendingUsed = useExposure && (
      (pendingAmount(move.current) || 0) !== 0 || (pendingAmount(move.prior) || 0) !== 0
    );
    const what = pendingUsed ? 'posted-plus-pending exposure' : 'balance';
    if (direction === 'unchanged') {
      return `Between ${fmtDate(move.prior.asOf)} and ${fmtDate(move.current.asOf)} the ${name} ${what} was unchanged.`;
    }
    const verb = direction === 'down' ? 'fell' : 'rose';
    return `Between ${fmtDate(move.prior.asOf)} and ${fmtDate(move.current.asOf)} the ${name} ${what} ${verb} ${money2(Math.abs(amount))}.`;
  }

  function spendableRowsOf(snap) {
    return ((snap && snap.accounts) || []).filter(a =>
      a && a.collection === 'cash' && a.pot === 'spendable' && Number.isFinite(Number(a.balance)));
  }

  // Completeness is historical coverage from the snapshot, not a page-owned
  // identity list. Missing metadata fails closed: an incomplete or undeclared
  // set is not a complete recorded cash aggregate. The legacy coverage/pot
  // names describe captured membership, not Forecast's current spendable scope.
  function coverageExpectedIds(snap) {
    const ids = snap && snap.spendableCoverage && snap.spendableCoverage.expectedIds;
    if (!Array.isArray(ids) || ids.length === 0) return null;
    const out = [];
    const seen = new Set();
    for (const id of ids) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out.length ? out : null;
  }

  function isCompleteSpendable(snap) {
    const expected = coverageExpectedIds(snap);
    if (!expected) return false;
    const present = new Set(spendableRowsOf(snap).map(r => r.id));
    return expected.every(id => present.has(id));
  }

  function spendableSeries(history) {
    const pts = [];
    for (const snap of snapshotsOf(history)) {
      const expected = coverageExpectedIds(snap);
      if (!expected || !isCompleteSpendable(snap)) continue;
      const byId = new Map(spendableRowsOf(snap).map(r => [r.id, r]));
      const rows = expected.map(id => byId.get(id));
      pts.push({
        asOf: snap.asOf,
        id: 'spendable-cash',
        label: 'Recorded cash balances',
        collection: 'cash',
        side: 'asset',
        complete: true,
        ids: expected.slice().sort(),
        includedAccounts: rows.map(r => ({ id: r.id, label: r.label || r.id })),
        balance: round2(rows.reduce((s, r) => s + Number(r.balance), 0)),
      });
    }
    return pts;
  }

  function comparableSpendable(points) {
    if (!points || points.length < 2) return points || [];
    const last = points[points.length - 1];
    const key = last.ids.join(',');
    return points.filter(p => p.ids.join(',') === key);
  }

  function accountRows(history) {
    const rows = [];
    const spendable = comparableSpendable(spendableSeries(history));
    if (spendable.length) {
      rows.push({ kind: 'aggregate', id: 'spendable-cash', label: 'Recorded cash balances', side: 'asset', move: displayMove(spendable), points: spendable });
    }
    for (const id of accountIds(history)) {
      const points = seriesFor(history, id);
      if (!points.length) continue;
      const head = points[points.length - 1];
      rows.push({
        kind: 'account',
        id,
        label: head.label,
        side: head.side,
        collection: head.collection,
        move: displayMove(points),
        points,
      });
    }
    return rows;
  }

  function signedMoney(n) {
    const v = round2(n);
    if (v === 0) return money2(0);
    return (v > 0 ? '+' : '−') + money2(Math.abs(v)).slice(1);
  }

  function formatOpening(pt) {
    if (!pt) return '—';
    const posted = money2(pt.balance);
    if (!isDebtPoint(pt)) return posted;
    if (pt.pendingUnknown) return `${posted} posted · pending unknown`;
    return `${posted} posted · ${money2(pendingAmount(pt))} pending`;
  }

  function formatMovement(move) {
    if (!move || !move.current) return '—';
    if (isDebtPoint(move.current)) {
      if (move.pendingUnknown || !move.exposureSufficient) return '—';
      return signedMoney(move.exposureDelta);
    }
    return move.sufficient ? signedMoney(move.delta) : '—';
  }

  // This module also loads in node without app.js, so it keeps its own
  // escape (the same mapping as app.js escapeHtml) for every rendered string.
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render(history) {
    const rows = accountRows(history);
    if (!rows.length) {
      return '<p class="lede" id="balance-history-empty">No dated account openings have been stored yet.</p>';
    }
    const heloc = rows.find(r => r.id === 'heloc');
    const helocLine = heloc ? `<p class="lede" id="balance-history-heloc">${escape(movementWord(heloc.move, 'HELOC'))}</p>` : '';
    const body = rows.map(r => {
      const move = r.move;
      const current = formatOpening(move.current);
      const prior = formatOpening(move.prior);
      const delta = formatMovement(move);
      const dates = move.prior && move.current
        ? `${fmtDate(move.prior.asOf)} → ${fmtDate(move.current.asOf)}`
        : (move.current ? fmtDate(move.current.asOf) : '—');
      const note = movementWord(move, r.kind === 'aggregate' ? 'recorded cash' : r.label);
      const scope = r.kind === 'aggregate' ? recordedCashScopeHtml(move) : '';
      return `<tr>
        <td>${escape(r.label)}${r.kind === 'aggregate' ? ' <span class="chip">sum</span>' : ''}</td>
        <td>${r.side === 'liability' ? 'Liability' : 'Asset'}</td>
        <td class="num">${current}</td>
        <td class="num">${prior}</td>
        <td class="num">${delta}</td>
        <td>${dates}</td>
        <td>${escape(note)}${scope}</td>
      </tr>`;
    }).join('');
    return `${helocLine}
      <div class="card scroll recorded-balance-history">
        <table>
          <thead><tr>
            <th>Account</th><th>Side</th><th class="num">Latest</th><th class="num">Prior</th>
            <th class="num">Movement</th><th>Dates</th><th>Reading</th>
          </tr></thead>
          <tbody id="balance-history-rows">${body}</tbody>
        </table>
      </div>`;
  }

  function recordedCashScopeHtml(move) {
    const points = [move.prior, move.current].filter(Boolean);
    const dates = points.map(point => `<li><time datetime="${escape(point.asOf)}">${fmtDate(point.asOf)}</time>: ${
      (point.includedAccounts || []).map(account => escape(account.label)).join('; ')}</li>`).join('');
    return `<details class="recorded-cash-scope"><summary>Included accounts</summary>
      <p>Recorded balances include any reserve accounts listed here. This total does not show what is safe to spend.</p>
      <ul>${dates}</ul></details>`;
  }

  const BalanceHistory = {
    snapshotsOf,
    accountIds,
    seriesFor,
    displayMove,
    movementWord,
    spendableSeries,
    comparableSpendable,
    isCompleteSpendable,
    coverageExpectedIds,
    accountRows,
    signedMoney,
    formatOpening,
    formatMovement,
    render,
    money2,
    fmtDate,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BalanceHistory;
  else root.BalanceHistory = BalanceHistory;
})(typeof window !== 'undefined' ? window : globalThis);
