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
// Captured history: 5.3, 5.4 and 5.8 use the A11 (#818) capture path through
// the harness's `w.capturedHistory` or consecutive refreshes in one session.
// Seeds are earlier observed worlds, captured by the production archive code;
// they do not inject an expected publication.
//
// Invented history: the Sep 25 - Oct 8 period closed with Groceries 70
// (Oct 3, Invented grocer C) against a plan of 300, and the internet bill
// 60 paid on its Sep 28 due date. As-of is Oct 14 (period Oct 9 - 22).

const assert = require('node:assert/strict');
const CLOSED = '2026-09-25';
const CURRENT = '2026-10-09';

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

async function stackGroceries(p, periodKey) {
  if (await p.page.evaluate(() => window.StackBlocks.context().selectedPeriodKey) !== periodKey) {
    await p.selectPeriod(periodKey);
  }
  const budget = p.page.locator('#stack-root [data-stack-card="budget"]');
  if (!await budget.evaluate(node => node.open)) await budget.locator('summary').click();
  const target = budget.locator('[data-stack-sheet="budget:groceries"]');
  assert.ok(await target.isVisible(), 'the selected period has a visible Groceries row');
  await target.click();
  const sheet = p.page.locator('#stack-root [data-stack-block="sheet"] [role="dialog"]');
  assert.equal(await sheet.locator('h3').innerText(), 'Groceries');
  const result = await sheet.evaluate(dialog => {
    const ctx = window.StackBlocks.context();
    const view = ctx.recommendation.payPeriodViews.find(v => v.start === ctx.selectedPeriodKey);
    const row = view.householdBudget.find(item => item.id === 'groceries');
    return {
      key: view.start, captured: view.capturedClose?.source === 'period-history',
      spent: row.spent, planned: row.planned,
      printedSpent: dialog.querySelector('.stack-sheet-big > span').textContent,
      printedPlan: dialog.querySelector('.stack-sheet-big > i')?.textContent.trim() ?? null,
    };
  });
  assert.equal(result.key, periodKey, 'the figures came from the selected pay period');
  await p.page.keyboard.press('Escape');
  return result;
}

function expectSpent(row, amount, printed) {
  assert.deepEqual([row.spent, row.printedSpent], [amount, printed], 'published and printed category spend');
}

function expectPlan(row, amount, printed) {
  assert.deepEqual([row.planned, row.printedPlan], [amount, printed], 'published and printed original target');
}

const scenarios = [
  {
    id: '5.1', basis: 'derived', name: 'a closed period shows the spending and bill payment it closed with',
    async run(H) {
      await H.withBudget(historyWorld(H), async (classic, packets, built) => {
        const s = await closed(H, classic);
        H.expectMatch(H.bill(s, 'Invented internet'), /\$60\.00\s*Paid/, 'the Sep 28 bill shows Paid');
        const stack = await H.openBudget(built[0].data, { view: 'stack' });
        try {
          expectSpent(await stackGroceries(stack, CLOSED), 70, '$70');
        } finally { await stack.close(); }
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
    async run(H) {
      const w = historyWorld(H);
      w.budget[0].plannedPayday = 350;
      // Given: the Sep 25 - Oct 8 close was captured before the plan changed.
      w.capturedHistory = [historyWorld(H)];
      await H.withBudget(w, async p => {
        expectPlan(await stackGroceries(p, CURRENT), 350, '/ $350');
        const past = await stackGroceries(p, CLOSED);
        assert.equal(past.captured, true, 'the earlier plan was captured');
        expectPlan(past, 300, '/ $300');
      }, { view: 'stack' });
    },
  },
  {
    id: '5.4', basis: 'derived', name: 'closed history survives a refresh whose fetch window no longer covers it',
    // First observation covers Sep 1 onward; the next refresh fetches only
    // from Oct 9. After reload, the closed period still shows Groceries 70.
    async run(H) {
      const first = historyWorld(H);
      const later = historyWorld(H);
      later.windowStart = '2026-10-09';
      later.transactions = later.transactions.filter(t => t.date >= '2026-10-09');
      await H.withBudget([first, later], async p => {
        expectSpent(await stackGroceries(p, CLOSED), 70, '$70');
        await p.reload();
        const past = await stackGroceries(p, CLOSED);
        assert.equal(past.captured, true, 'the second observation reads the saved close');
        expectSpent(past, 70, '$70');
      }, { view: 'stack' });
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
        const past = await stackGroceries(p, CLOSED);
        assert.equal(past.captured, false, 'the uncovered period has no saved close');
        expectSpent(past, null, '');
        expectSpent(await stackGroceries(p, CURRENT), 0, '$0');
      }, { view: 'stack' });
    },
  },
  {
    id: '5.6', basis: 'blueprint', name: 'a refund after the close does not rewrite the closed period',
    // Oct 12 refund of 20 against the Oct 3 grocery purchase. The closed
    // period keeps Spent 70; the refund lands in the open period (Groceries
    // spent -20 there), inheriting its bucket.
    async run(H) {
      const w = historyWorld(H);
      // LEDGER A item 3 (Grok Bot, rule 17): only a ledger-linked refund nets; a Lunch Money grouped pair
      // arrives as one group-parent row, so the refund here is that linked form (is_group_parent).
      w.transactions.push(H.lm({ date: '2026-10-12', amount: -20, category: 'Groceries', payee: 'Invented grocer C', raw: { is_group_parent: true } }));
      await H.withBudget(w, async p => {
        expectSpent(await stackGroceries(p, CURRENT), -20, '−$20');
        expectSpent(await stackGroceries(p, CLOSED), 70, '$70');
      }, { view: 'stack' });
    },
  },
  {
    id: '5.7', basis: 'spec', name: 'no snapshot but complete history: the reconstructed close says estimated',
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
    // Owner decision #818 comment 6700247600: close means completed-period
    // actuals, not the last-day projection that still holds unspent budget.
    // Independent arithmetic: income 1,400 - paid bill 60 - spent 70 = 1,270.
    // Both observations below are after the close was captured. A single
    // household session retains that capture across the later budget edit.
    async run(H) {
      const atClose = historyWorld(H);
      atClose.capturedHistory = [historyWorld(H)];
      const later = historyWorld(H);
      later.asOf = '2026-10-20';
      later.budget[0].plannedPayday = 350;
      await H.withBudget([atClose, later], async (p, packets, built) => {
        const captured = data => data.periodHistory.find(record => record.content.kind === 'closing'
          && record.content.period.start === '2026-09-25' && record.content.period.end === '2026-10-08');
        const firstCapture = captured(built[0].data);
        H.expect(firstCapture && firstCapture.content.closingState === 'complete-at-capture',
          'the first observation has a complete captured close');
        H.expect(JSON.stringify(captured(built[1].data)) === JSON.stringify(firstCapture),
          'the later refresh retains the exact original captured publication');
        await closed(H, p);
        const figure = async () => ((await p.rows('[data-operating-question="07"]')).join(' ')
          .match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1];
        H.expect(await figure() === '$1,270.00', 'captured close is income 1,400 minus bill 60 minus spending 70');
        const disclosure = (await p.rows('[data-budget-captured-close]')).join(' ');
        H.expectIncludes(disclosure, '2026-10-14', 'the close is shown as captured on Oct 14');

        // A reload keeps the selected period for the tab, so return to the
        // current period first so stepping back selects the same close after reload.
        await p.step(1);
        await p.reload();
        await closed(H, p);
        H.expect(await figure() === '$1,270.00', 'today\'s budget edit cannot change the captured 1,270 close');
        H.expect((await p.rows('[data-budget-captured-close]')).join(' ') === disclosure,
          'the original capture disclosure survives the budget edit');

        // The stored close figure and its capture disclosure above still need their classic proof.
        // Both pages receive the exact same pair of observed documents.
        const stack = await H.openBudget(built.map(result => result.data), { view: 'stack' });
        try {
          const before = await stackGroceries(stack, CLOSED);
          assert.equal(before.captured, true);
          expectPlan(before, 300, '/ $300');
          await stack.reload();
          expectPlan(await stackGroceries(stack, CURRENT), 350, '/ $350');
          const after = await stackGroceries(stack, CLOSED);
          assert.equal(after.captured, true);
          expectPlan(after, 300, '/ $300');
        } finally { await stack.close(); }
      });
    },
  },
  {
    id: '5.9', basis: 'spec', name: "no savings evidence for the closed period: Unknown, not today's balance",
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
