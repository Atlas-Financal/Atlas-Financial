'use strict';
// Check 4 — Owner-paid items turn green and leave future funding.
// Spec: #787 6622324225 (check 4 scenarios), 6593395684 (A4/A5 amendments), the adopted
// blueprint #787 6620986508 §3 ("Confirmed, then late spending") and §4 A5
// check-4 cases. Owner rules R1 and R5:
//   R1 the owner's word is proof; settledOn is the CONFIRMATION date, never a
//      payment date; a partial confirmation stays partial.
//   R5 a confirmed-paid item turns green now and drops off future periods;
//      unpaid siblings stay.
// Invented numbers only; expectations hand-derived from those rules.
//
// Owner confirmation is `commitment.settledOn` (the incumbent field) for a
// full confirmation. A5 landed the partial shape as its own field,
// `ownerPaid: { amount, confirmedOn }`, with no settledOn beside it, so a
// reader that does not know it keeps the full need.

function confirm(c, on, amount) {
  if (amount != null) return { ...c, ownerPaid: { amount, confirmedOn: on } };
  return { ...c, settledOn: on };
}

// Two items, ungrouped so each has its own goal row; `grouped` puts both in
// one group to test sibling visibility.
function ownerWorld(H, grouped = false) {
  const w = H.baseWorld();
  if (grouped) w.groups = [{ id: 'holiday', label: 'Invented holiday', planSpendSummary: true }];
  w.commitments = [
    { id: 'tickets', label: 'Invented tickets', date: '2026-11-20', amount: 200, confidence: 'confirmed', sinkingFund: true },
    { id: 'hotel', label: 'Invented hotel', date: '2026-11-27', amount: 300, confidence: 'confirmed', sinkingFund: true },
  ].map(c => grouped ? { ...c, group: 'holiday' } : c);
  w.savingsPool = {};
  w.accounts.find(a => a.id === 'savings').value = 100;
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}
// Goal rows may be listed per member or per group; find the member's text
// anywhere in the Savings section and goal rows.
async function itemText(H, p, label) {
  const s = await H.snap(p);
  const row = s.goals.find(t => t.includes(label)) || '';
  return { s, row };
}

const scenarios = [
  {
    id: '4.1', basis: 'spec', name: 'owner-confirmed item is green "Paid" with no transaction proof',
    async run(H) {
      const w = ownerWorld(H);
      w.commitments[0] = confirm(w.commitments[0], '2026-10-12');
      await H.withBudget(w, async p => {
        const { s, row } = await itemText(H, p, 'Invented tickets');
        H.expect(row, 'the confirmed item stays listed this period');
        H.expectMatch(row, /Paid/, 'it reads as Paid');
        H.expectMatch(row, /owner-confirmed/i, 'it says owner-confirmed');
        H.expectFigure(row, 'Still to fund', '$0.00', 'a full confirmation needs nothing more');
        H.expect(await p.page.locator('[data-budget-savings-goal*="tickets"] .is-paid, [data-budget-savings-goal*="tickets"] [class*="is-paid"]').count() > 0
          || /is-paid/.test(await p.page.evaluate(() => [...document.querySelectorAll('[data-budget-savings-goal]')].map(e => e.outerHTML).join(''))),
        'the row carries the paid (green) state');
        void s;
      });
    },
  },
  {
    id: '4.2', basis: 'spec', name: 'no amount or date: Paid, amount and date Unknown, Oct 12 labelled as the confirmation date',
    // Unknown actual amount and date: the page may say "confirmed Oct 12" but
    // must never say "paid on Oct 12", and the actual amount stays Unknown.
    async run(H) {
      const w = ownerWorld(H);
      w.commitments[0] = confirm(w.commitments[0], '2026-10-12');
      await H.withBudget(w, async p => {
        const { s, row } = await itemText(H, p, 'Invented tickets');
        H.expectMatch(row, /Paid/, 'status is Paid');
        H.expectMatch(row, /Unknown/, 'the actual amount and date are Unknown');
        H.expectMatch(s.all, /[Cc]onfirm[a-z]*[^.]{0,30}(Oct(ober)? 12|2026-10-12)/, 'the confirmation date is shown as a confirmation');
        H.expectNoMatch(s.all, /[Pp]aid (on )?(Oct(ober)? 12|2026-10-12)/, 'the confirmation date is never a payment date');
      });
    },
  },
  {
    id: '4.3', basis: 'spec', name: 'partial owner confirmation of 50 out of 200 leaves 150',
    async run(H) {
      const w = ownerWorld(H);
      w.commitments[0] = confirm(w.commitments[0], '2026-10-12', 50);
      await H.withBudget(w, async p => {
        const { row } = await itemText(H, p, 'Invented tickets');
        H.expectFigure(row, 'Paid', '$50.00', 'owner partial is the paid amount');
        H.expectIncludes(row, '$150.00', 'remaining need is 200 - 50');
        H.expectNoMatch(row, /is-paid|\bPaid in full\b/, 'a partial confirmation never closes the item');
      });
    },
  },
  {
    id: '4.4', basis: 'spec', name: 'confirmed item is absent from the next period',
    async run(H) {
      const w = ownerWorld(H);
      w.commitments[0] = confirm(w.commitments[0], '2026-10-12');
      await H.withBudget(w, async p => {
        await p.step(1);
        const s = await H.snap(p);
        H.expectMatch(s.range, /Oct 23/, 'stepped to the next period');
        H.expectIncludes(s.goals.join(' '), 'Invented hotel', 'next period goals render');
        H.expectExcludes(s.goals.join(' ') + s.savings, 'Invented tickets', 'a paid item drops off future periods');
      });
    },
  },
  {
    id: '4.5', basis: 'blueprint', name: 'the unpaid sibling in the same group stays, now and next period',
    async run(H) {
      const w = ownerWorld(H, true);
      w.commitments[0] = confirm(w.commitments[0], '2026-10-12');
      await H.withBudget(w, async p => {
        H.expectIncludes((await H.snap(p)).savings, 'Invented hotel', 'unpaid sibling stays this period');
        await p.step(1);
        const s = await H.snap(p);
        H.expectIncludes(s.goals.join(' ') + s.savings, 'Invented hotel', 'unpaid sibling stays next period');
        H.expectMatch(s.goals.join(' | '), /\$300\.00\s*Needed/, 'remaining need is the sibling only (300)');
        H.expectNoMatch(s.goals.join(' | '), /\$500\.00\s*Needed/, 'the paid item is not added back');
      });
    },
  },
  {
    id: '4.6', basis: 'derived', name: 'the confirmed item no longer takes Savings backing',
    // Pool 100: before confirmation tickets (Nov 20) take all 100. After a
    // full confirmation the 100 backs the hotel instead (need 300, gap 200).
    async run(H) {
      const w = ownerWorld(H);
      w.commitments[0] = confirm(w.commitments[0], '2026-10-12');
      await H.withBudget(w, async p => {
        const { row } = await itemText(H, p, 'Invented hotel');
        H.expectMatch(row, /\$100\.00\s*Saved/, 'the hotel receives the freed 100');
        H.expectFigure(row, 'Still to fund', '$200.00', 'hotel gap is 300 - 100');
      });
    },
  },
  {
    id: '4.7', basis: 'blueprint', name: 'late spending after a full confirmation keeps it green and shows both facts',
    // Confirmed Oct 10 (no amount); a linked 90 purchase posts Oct 12. Item
    // stays Paid, future need 0; the observed 90 and the Oct 10 confirmation
    // are shown separately. No invented owner amount is added.
    async run(H) {
      const w = ownerWorld(H);
      w.commitments[0] = confirm(w.commitments[0], '2026-10-10');
      w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'tickets' }, occurrenceDate: '2026-11-20', effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 90, category: 'Trip', payee: 'Invented box office' }));
      await H.withBudget(w, async p => {
        const { s, row } = await itemText(H, p, 'Invented tickets');
        H.expectMatch(row, /Paid/, 'still Paid');
        H.expectFigure(row, 'Still to fund', '$0.00', 'future need stays 0');
        H.expectIncludes(s.all, '$90.00', 'the observed 90 is shown');
        H.expectNoMatch(row, /\$290\.00/, 'no owner amount is invented on top');
      });
    },
  },
  {
    id: '4.8', basis: 'spec', name: 'dated sinking fund confirmed paid: visible green dot, Paid, planned cost, no estimated zero',
    async run(H) {
      const w = ownerWorld(H);
      w.commitments[0] = confirm(w.commitments[0], '2026-10-12');
      await H.withBudget(w, async p => {
        const face = p.page.locator('.blend-goal-legend > li').filter({ hasText: 'Invented tickets' });
        H.expect(await face.count() === 1, 'one visible goal face');
        const text = await face.innerText();
        H.expectMatch(text, /Planned\s*\$200\.00/, 'the original planned cost remains visible');
        H.expectMatch(text, /(?:^|\n)Paid\s*(?:\n|$)/, 'Paid stands alone when the actual amount is unknown');
        H.expectNoMatch(text, /Paid\s*[—$]|Needed\s*\$|≈|planning gap|Estimate:/i, 'no invented paid figure or estimated settlement');
        // Still to fund moved behind the tap (clean main view, owner
        // direction 2026-11-09): the same printed figure is read in the
        // goal's tap-to-explain window instead of on the visible row.
        H.expectNoMatch(text, /Still to fund/, 'Still to fund is not on the main view');
        await face.locator('button.blend-goal-row').click();
        const explain = p.page.locator('dialog[data-blend-explain][open]');
        await explain.waitFor({ timeout: 5000 });
        const explained = await explain.innerText();
        H.expectFigure(explained, 'Still to fund', '$0.00', 'confirmed settlement needs no further funding');
        H.expectNoMatch(explained, /≈|planning gap|Estimate:/i, 'no estimated settlement in the window');
        // Owner live walk (#821 6785886971 item 2): the blank Paid value of
        // an owner-confirmed item reads as words, with the printed note.
        H.expectMatch(explained.replace(/\s+/g, ' '), /Paid Amount not given owner-confirmed/, 'a confirmed item with no stated amount says so in words');
        H.expectMatch(explained, /Actual amount and date Unknown/, 'the window never invents a payment amount or date');
        H.expectNoMatch(explained, /Paid\s*[—$]/, 'no invented paid figure in the window');
        await p.page.keyboard.press('Escape');
        await p.page.waitForFunction(() => !document.querySelector('dialog[data-blend-explain]')?.open, null, { timeout: 5000 });
        const colors = await face.evaluate(el => {
          const probe = document.createElement('span');
          probe.style.backgroundColor = 'var(--blend-income)';
          el.appendChild(probe);
          const expected = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return { dot: getComputedStyle(el, '::before').backgroundColor, expected };
        });
        H.expect(colors.dot === colors.expected && colors.dot !== 'rgba(0, 0, 0, 0)', 'the actual visible dot uses the green income color');
        const { row } = await itemText(H, p, 'Invented tickets');
        H.expectMatch(row, /Actual amount and date Unknown/, 'confirmation never invents a payment amount or date');
        H.expectNoMatch(row, /paid on/i, 'confirmation date is not a payment date');
        await p.step(1);
        H.expect(await p.page.locator('.blend-goal-legend > li').filter({ hasText: 'Invented tickets' }).count() === 0,
          'the settled goal leaves the next period');
      });
    },
  },
  {
    id: '4.9', basis: 'spec', name: 'an owner-paid item sits in the Saving for list by its date, not at the bottom',
    // Owner request, Dale 2026-11-10. Three invented items dated Oct, Nov, Dec;
    // the Nov one is owner-paid. Order only.
    async run(H) {
      const w = H.baseWorld();
      w.commitments = [
        { id: 'oct-item', label: 'Invented october item', date: '2026-10-28', amount: 100, confidence: 'confirmed', sinkingFund: true },
        { id: 'nov-item', label: 'Invented november item', date: '2026-11-20', amount: 200, confidence: 'confirmed', sinkingFund: true },
        { id: 'dec-item', label: 'Invented december item', date: '2026-12-15', amount: 300, confidence: 'confirmed', sinkingFund: true },
      ];
      w.commitments[1] = confirm(w.commitments[1], '2026-10-12');
      w.savingsPool = {};
      w.accounts.find(a => a.id === 'savings').value = 100;
      w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        const idx = ['october', 'november', 'december'].map(m => s.goals.findIndex(t => t.includes('Invented ' + m + ' item')));
        H.expect(idx.every(i => i >= 0), 'all three items are listed (positions ' + idx.join(',') + ')');
        H.expect(idx[0] < idx[1] && idx[1] < idx[2], 'rendered order is Oct, Nov, Dec (got positions ' + idx.join(',') + ')');
        H.expectMatch(s.goals[idx[1]], /Paid/, 'the paid item still reads Paid');
        H.expectMatch(s.goals[idx[1]], /owner-confirmed/i, 'and owner-confirmed');
      });
    },
  },

];

module.exports = { check: 4, title: 'Owner-paid items turn green and leave future funding', scenarios };
