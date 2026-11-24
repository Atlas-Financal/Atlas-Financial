'use strict';
/* One membership for "Credit" (lead ruling, ATLAS LEAD 12, 2026-11-22, on Dale's walk of the Stack page): the Credit card's
 * head ("paid / card minimums due", Forecast.stackCreditLines totals.minimumsDue and minimumsPaid) spans every listed credit
 * line, the HELOC included, so its due is the waterfall's Credit (Forecast stackSurplus terms.credit, the sum of the
 * period's stackSummary.bills.cardMinimums) for every period where both are published. Before, the head left the HELOC out
 * while the waterfall counted its minimum: two published "Credit" figures that differed by exactly the HELOC minimum.
 *
 *   1. Invariant over every committed invented input and every pay period: head due === the period's minimums (one
 *      membership, to the cent); the waterfall Credit === the Credit breakdown's total where Forecast publishes one (desk
 *      ruling (E), #1573: the targets less what is already counted above), else === the minimums, as before.
 *   2. The same on an invented world with a HELOC cash minimum (the committed inputs carry none), where main differed.
 *   3. The HELOC's paid side keeps its honest trust: wherever a HELOC minimum is due, minimumsPaid is withheld or at most
 *      estimated, never calculated or verified (the HELOC's paidToward is never more certain than estimated).
 *
 * Invented data only. `node test/test-stack-credit-one-membership.js`
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');
const F = require(path.join(root, 'public', 'forecast.js'));
const Snap = require(path.join(root, 'scripts', 'figures-snapshot.js'));
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const cents = v => Math.round(v * 100);
const num = v => typeof v === 'number' && Number.isFinite(v);

// Each pay period's waterfall Credit and Credit head, read the way the page reads them (stack-waterfall.js reads
// stackSummary.surplus.terms.credit; stack-credit.js calls cardPeriodMovements then stackCreditLines with the period's
// bills split).
function periods(data, periodsDoc) {
  const opts = Snap.pageOptions(data, periodsDoc);
  const advice = F.recommend(data.plan, data.meta.asOf, opts);
  return (advice.payPeriodViews || []).map(v => {
    const bills = v.stackSummary ? v.stackSummary.bills : null;
    // The view's one card-target publication (desk ruling (E), #1573): the Credit tile reads it as published.
    const result = v.stackSummary ? v.stackSummary.credit : null;
    const terms = v.stackSummary && v.stackSummary.surplus && v.stackSummary.surplus.terms;
    const breakdown = v.stackSummary ? v.stackSummary.creditBreakdown : null;
    return {
      start: v.start,
      credit: terms && num(terms.credit) ? terms.credit : null,
      // Desk ruling (E): where the targets set the Credit term, the waterfall Credit is the breakdown's total (its rows the
      // tile's targets); the head's due stays the minimums of the same membership.
      breakdownTotal: breakdown && num(breakdown.total) ? breakdown.total : null,
      minimums: bills && Array.isArray(bills.cardMinimums) ? bills.cardMinimums.reduce((sum, row) => sum + cents(row.amount), 0) / 100 : null,
      totals: result && result.totals ? result.totals : null,
      helocLine: result && Array.isArray(result.lines) ? result.lines.find(line => line && line.id === 'heloc') || null : null,
      helocMinimum: ((bills && bills.cardMinimums) || []).filter(row => row && String(row.debtId) === 'heloc')
        .reduce((sum, row) => sum + (num(row.amount) ? row.amount : 0), 0),
    };
  });
}

console.log('1. every committed invented input: the Credit head due is the waterfall Credit');
{
  let compared = 0;
  for (const input of Snap.loadInventedInputs()) {
    const data = structuredClone(input.doc.data);
    for (const p of periods(data, input.doc.periods == null ? null : structuredClone(input.doc.periods))) {
      const due = p.totals && p.totals.minimumsDue ? p.totals.minimumsDue.amount : null;
      if (p.credit === null || !num(due)) continue;
      compared++;
      assert.equal(cents(due), cents(p.minimums), `${input.id} ${p.start}: head due is the minimums of the one membership`);
      assert.equal(cents(p.credit), cents(p.breakdownTotal !== null ? p.breakdownTotal : p.minimums),
        `${input.id} ${p.start}: the waterfall Credit is the targets' breakdown where published, else the minimums`);
    }
  }
  ok(compared > 0, 'head due is the minimums of the one membership, and the waterfall Credit is the breakdown (else the minimums), on every period where both are published', `${compared} periods`);
}

// The committed Stack card input, with an invented HELOC added: its debt and its capitalising obligation with a cash
// minimum (the shape Forecast reads, capitalisingCashMinimumOccurrences), due on the 21st from the input's first period.
function helocWorld() {
  const input = Snap.loadInventedInputs().find(x => x.id === 'stack-card-summary');
  const data = structuredClone(input.doc.data);
  data.debts.push({ id: 'heloc', label: 'Invented line of credit', structure: 'Revolving secured line of credit', secured: true,
    balance: 20000, pending: 0, rate: 7, limit: 50000, confidence: 'calculated' });
  data.plan.obligations = (data.plan.obligations || []).concat([{ id: 'heloc', debtId: 'heloc', effect: 'capitalise',
    label: 'Invented line interest', frequency: 'monthly', day: 31, amount: 115, confidence: 'calculated', nonCash: true,
    payingAccount: 'chequing-a', cashPayment: 115, cashDay: 21, cashFirstDue: '2026-08-21', cashLabel: 'Invented line minimum',
    cashConfidence: 'calculated' }]);
  return { data, periodsDoc: input.doc.periods == null ? null : structuredClone(input.doc.periods) };
}

console.log('2. an invented world with a HELOC minimum: one membership for Credit');
{
  const { data, periodsDoc } = helocWorld();
  const rows = periods(data, periodsDoc);
  const withHeloc = rows.filter(p => p.helocMinimum > 0 && p.credit !== null && p.totals && p.totals.minimumsDue
    && num(p.totals.minimumsDue.amount));
  ok(withHeloc.length > 0, 'the invented world publishes a HELOC minimum in at least one period', `${withHeloc.length} periods`);
  for (const p of withHeloc) {
    assert.equal(cents(p.totals.minimumsDue.amount), cents(p.minimums), `${p.start}: head due is the minimums, the HELOC's included`);
    assert.equal(cents(p.credit), cents(p.breakdownTotal !== null ? p.breakdownTotal : p.minimums),
      `${p.start}: the waterfall Credit is the targets' breakdown where published, else the minimums`);
  }
  ok(true, 'with a HELOC minimum due, the head due counts it and the waterfall Credit reads the same membership in every such period (main left the HELOC out)');
  ok(withHeloc.every(p => num(p.totals.minimumsDueCount) && p.totals.minimumsDueCount >= 1),
    'the HELOC counts among the minimums due');

  console.log('3. the HELOC paid side keeps its honest trust');
  for (const p of rows.filter(r => r.helocMinimum > 0 && r.totals && r.totals.minimumsPaid)) {
    const mp = p.totals.minimumsPaid;
    assert.ok(mp.amount === null ? mp.trust === 'unavailable' : mp.trust === 'estimated',
      `${p.start}: with a HELOC minimum due, minimumsPaid is withheld or estimated (got ${mp.trust})`);
  }
  ok(rows.some(r => r.helocMinimum > 0 && r.totals && r.totals.minimumsPaid),
    'wherever a HELOC minimum is due, paid toward the minimums is withheld or estimated, never calculated or verified');
  const helocPaid = rows.filter(r => r.helocMinimum > 0 && r.helocLine).map(r => r.helocLine.paidToward);
  ok(helocPaid.length > 0 && helocPaid.every(f => (f.amount === null && f.trust === 'unavailable') || (num(f.amount) && f.trust === 'estimated')),
    'the HELOC line\'s own paid toward its minimum is withheld or estimated, never more certain',
    JSON.stringify(helocPaid.map(f => f.trust)));
}

console.log(`\nPASS Stack Credit one membership (${checks})`);
