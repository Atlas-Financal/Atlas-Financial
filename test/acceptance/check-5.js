'use strict';
// Check 5 — Closed periods preserve their history and trust labels.
// Spec: #787 6622324225 (check 5 scenarios), 6593395684 (check 5; "A11 must preserve captured closes.
// Today's plan never rewrites a closed period"), the bills blueprint
// #787 6595179923 ("refunds ... never rewrite captured closes") and the
// trust rule (missing is never zero). Invented numbers only; expectations
// hand-derived from the invented history below.
//
// 5.7-5.9 are the adopted spec scenarios; 5.1-5.5 are derived; 5.6 is from
// the bills blueprint.
//
// Captured history: 5.3, 5.4 and 5.8 test that a CLOSE IS PRESERVED, which
// needs the capture A11 (#818) introduces. Main has no capture path the page
// can read, so the harness cannot seed one yet. A11 must route its capture
// through `w.capturedHistory` (served by the harness; see harness.js) so
// these scenarios feed a real captured record instead of expecting recovery
// of unavailable data.
//
// Invented history: the Sep 25 - Oct 8 period closed with Groceries 70
// (Oct 3, Invented grocer C) against a plan of 300, and the internet bill
// 60 paid on its Sep 28 due date. As-of is Oct 14 (period Oct 9 - 22).

function historyWorld(H) {
  const w = H.baseWorld();
  w.bills = [{ id: 'net', label: 'Invented internet', amount: 60, frequency: 'monthly', day: 28, confidence: 'confirmed', payee: 'Invented net co' }];
  w.transactions = [
    H.lm({ id: 900001, date: '2026-09-25', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ id: 900002, date: '2026-09-28', amount: 60, category: 'Internet', account: 'chequing-a', payee: 'Invented net co' }),
    H.lm({ id: 900003, date: '2026-10-03', amount: 70, category: 'Groceries', payee: 'Invented grocer C' }),
    H.lm({ id: 900004, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
  ];
  return w;
}
async function closed(H, p) {
  await p.step(-1);
  const s = await H.snap(p);
  H.expectMatch(s.range, /Sep 25/, 'stepped back to the closed Sep 25 - Oct 8 period');
  return s;
}

const scenarios = [
  {
    id: '5.1', basis: 'derived', name: 'a closed period shows the spending and bill payment it closed with',
    async run(H) {
      await H.withBudget(historyWorld(H), async p => {
        const s = await closed(H, p);
        H.expectMatch(H.category(s, 'Groceries'), /Spent \$70\.00/, 'closed groceries spent is 70');
        H.expectMatch(H.bill(s, 'Invented internet'), /\$60\.00\s*Paid/, 'the Sep 28 bill shows Paid');
      });
    },
  },
  {
    id: '5.2', basis: 'derived', name: "today's changed plan never rewrites the closed period's plan",
    // The owner raised Groceries to 350 on Oct 10. The closed period must not
    // be relabelled with 350; it shows its original 300 or says it is unknown.
    async run(H) {
      const w = historyWorld(H);
      w.budget[0].plannedPayday = 350;
      await H.withBudget(w, async p => {
        const s = await closed(H, p);
        H.expect(H.category(s, 'Groceries'), 'the Groceries row is listed');
        H.expectNoMatch(H.category(s, 'Groceries'), /of planned \$350\.00/, 'closed period is not given the new 350 plan');
      });
    },
  },
  {
    id: '5.3', basis: 'derived', name: 'the closed period shows its captured original plan of 300',
    fixedBy: 'A11 #818',
    async run(H) {
      const w = historyWorld(H);
      w.budget[0].plannedPayday = 350;
      await H.withBudget(w, async p => {
        const s = await closed(H, p);
        H.expectMatch(H.category(s, 'Groceries'), /of planned \$300\.00/, 'captured original plan is 300');
      });
    },
  },
  {
    id: '5.4', basis: 'derived', name: 'closed history survives a refresh whose fetch window no longer covers it',
    fixedBy: 'A11 #818',
    // First observation covers Sep 1 onward; the next refresh fetches only
    // from Oct 9. After reload, the closed period still shows Groceries 70.
    async run(H) {
      const first = historyWorld(H);
      const later = historyWorld(H);
      later.windowStart = '2026-10-09';
      later.transactions = later.transactions.filter(t => t.date >= '2026-10-09');
      await H.withBudget([first, later], async p => {
        await p.reload();
        const s = await closed(H, p);
        H.expectMatch(H.category(s, 'Groceries'), /Spent \$70\.00/, 'captured closed spending is retained');
      });
    },
  },
  {
    id: '5.5', basis: 'derived', name: 'without captured history an uncovered closed period is Unknown, not $0.00',
    // Same later refresh with no capture: what is not known stays Unknown.
    async run(H) {
      const later = historyWorld(H);
      later.windowStart = '2026-10-09';
      later.transactions = later.transactions.filter(t => t.date >= '2026-10-09');
      await H.withBudget(later, async p => {
        const s = await closed(H, p);
        H.expect(H.category(s, 'Groceries'), 'the Groceries row is listed');
        H.expectNoMatch(H.category(s, 'Groceries'), /Spent \$0\.00?/, 'uncovered history is never a zero');
      });
    },
  },
  {
    id: '5.6', basis: 'blueprint', name: 'a refund after the close does not rewrite the closed period',
    // Oct 12 refund of 20 against the Oct 3 grocery purchase. The closed
    // period keeps Spent 70; the refund lands in the open period (Groceries
    // spent -20 there), inheriting its bucket.
    async run(H) {
      const w = historyWorld(H);
      w.transactions.push(H.lm({ date: '2026-10-12', amount: -20, category: 'Groceries', payee: 'Invented grocer C' }));
      await H.withBudget(w, async p => {
        const now = await H.snap(p);
        H.expectMatch(H.category(now, 'Groceries'), /Spent [−-]\$20\.00/, 'the refund is in the open period Groceries');
        const s = await closed(H, p);
        H.expectMatch(H.category(s, 'Groceries'), /Spent \$70\.00/, 'closed period keeps 70');
      });
    },
  },
  {
    id: '5.7', basis: 'spec', name: 'no snapshot but complete history: the reconstructed close says estimated',
    fixedBy: 'A11 #818',
    // Complete Sep 1 onward history, no captured snapshot. The closed period's
    // reconstructed figures are shown, and labelled estimated.
    async run(H) {
      await H.withBudget(historyWorld(H), async p => {
        await closed(H, p);
        const bad = (await p.rows('[data-operating-question="07"]')).join(' ');
        H.expectMatch(bad, /Balance After Deductions[^$]*\$[\d,]+\.\d\d/, 'a reconstructed closing figure is shown');
        H.expectMatch(bad, /≈|estimated|Estimated/, 'and it is labelled estimated');
      });
    },
  },
  {
    id: '5.8', basis: 'spec', name: "a captured close stays put when today's budget changes",
    fixedBy: 'A11 #818',
    // Viewed on its last day (Oct 8) the period closes at some figure X. On
    // Oct 20, after the owner raised Groceries 300 -> 350, the same closed
    // period must still show X. (The spec's "$250" is whatever the period
    // closed at; the invariant is that today's plan cannot move it.)
    async run(H) {
      const atClose = historyWorld(H);
      atClose.asOf = '2026-10-08';
      atClose.transactions = atClose.transactions.filter(t => t.date <= '2026-10-08');
      const later = historyWorld(H);
      later.asOf = '2026-10-20';
      later.budget[0].plannedPayday = 350;
      let x, y;
      await H.withBudget(atClose, async p => {
        x = ((await p.rows('[data-operating-question="07"]')).join(' ').match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1];
      });
      H.expect(x, 'the period shows a closing figure on its last day');
      await H.withBudget(later, async p => {
        await closed(H, p);
        y = ((await p.rows('[data-operating-question="07"]')).join(' ').match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1];
      });
      H.expect(y === x, `closed at ${x}; after the budget change it shows ${y || 'no figure'}`);
    },
  },
  {
    id: '5.9', basis: 'spec', name: "no savings evidence for the closed period: Unknown, not today's balance",
    fixedBy: 'A11 #818',
    // Today the closed period's evidence lists the Oct 14 pool (dated, but
    // today's) instead of saying the Oct 8 savings are Unknown.
    async run(H) {
      const w = historyWorld(H);
      w.commitments = [{ id: 'trip', label: 'Invented trip', date: '2026-12-01', amount: 600, confidence: 'confirmed', sinkingFund: true }];
      w.savingsPool = {};
      w.accounts.find(a => a.id === 'savings').value = 1234;
      await H.withBudget(w, async p => {
        H.expectIncludes((await H.snap(p)).savings, '$1,234.00', "today's 1,234 pool is shown today");
        const s = await closed(H, p);
        H.expectIncludes(s.savings + s.goals.join(' '), 'Invented trip', 'positive control: the closed period lists its savings goal');
        H.expectExcludes(s.savings + s.goals.join(' '), '$1,234.00', "the closed period does not borrow today's balance");
      });
    },
  },
];

module.exports = { check: 5, title: 'Closed periods preserve history and trust labels', scenarios };
