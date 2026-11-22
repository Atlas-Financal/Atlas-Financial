// Stack page B3: Bills, Budget and Savings cards (no Mortgage card). Invented figures only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'stack-cards.js');

// --- invented published view (shapes from #1426 stackSummary, #1429 paidState, existing budgetProgress) ---
const view = {
  start: '2026-01-01',
  stackSummary: { bills: { mortgage: 1234.56, cardMinimums: [{ debtId: 'card-a', amount: 77.77 }], other: 888.88, trust: 'calculated', paid: 111.11, paidTrust: 'calculated' } },
  bills: [
    // Each counted row carries Forecast's place for it in the split (stackBillPart) and the amount it counts
    // there (stackBillAmount); the page groups by that alone. The carried row is not counted, so it has no mark.
    { id: 'hydro', date: '2026-01-05', label: 'Hydro', amount: 111.11, paidState: 'paid', stackBillPart: 'other', stackBillAmount: 111.11, stackBillPaymentEvidence: 'posted-equal', stackBillAmountTrust: 'calculated', stackBillPaid: true },
    { id: 'phone', date: '2026-01-07', label: 'Phone', amount: 222.22, paidState: 'not-paid', stackBillPart: 'other', stackBillAmount: 222.22, stackBillPaymentEvidence: 'none', stackBillAmountTrust: 'calculated', stackBillPaid: false },
    { id: 'old', label: 'Carried one', amount: 999.99, paidState: 'carried' },
    { id: 'mortgage', date: '2026-01-02', label: 'Mortgage', amount: 1234.56, paidState: 'not-paid', stackBillPart: 'mortgage', stackBillAmount: 1234.56, stackBillPaymentEvidence: 'none', stackBillAmountTrust: 'calculated', stackBillPaid: false },
    { id: 'cardmin', label: 'Card A minimum', amount: 77.77, paidState: 'paid', stackBillPart: 'cardMinimum', stackBillAmount: 77.77, stackBillDebtId: 'card-a' },
  ],
  budgetProgress: { household: { actual: { amount: 333.33 }, planned: { amount: 666.66 } } },
  householdBudget: [
    { id: 'groceries', label: 'Groceries', spent: 123.45, planned: 400 },
    { id: 'fun', label: 'Fun <money>', spent: 10.1, planned: 50.5 },
    { label: 'Hidden', informational: true, spent: 5, planned: 5 },
  ],
};
const ctx = (v, key) => ({ data: {}, plan: {}, recommendation: { payPeriodViews: [v] }, selectedPeriodKey: key === undefined ? '2026-01-01' : key, Forecast: {} });

let registered = {};
global.window = undefined;
// B5: the cards read the shell's one trust rule, so the stub carries the real shell's rule and budget reader.
const shell = (() => {
  const sandbox = { window: {}, location: { search: '' }, URLSearchParams, Intl, Map, Number, String, Object, Array, JSON, Math, console };
  require('vm').runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-shell.js'), 'utf8'), sandbox);
  return sandbox.window.StackBlocks;
})();
const STUB = globalThis.StackBlocks = { register: (n, f) => { registered[n] = f; }, isEstimated: shell.isEstimated, estClass: shell.estClass,
  budgetTrust: shell.budgetTrust, barWidth: shell.barWidth, money: shell.money, billName: shell.billName };
delete require.cache[require.resolve(file)];
const mod = require(file);
assert.strictEqual(typeof registered.cards, 'function', 'registers as cards');
const { buildCardsHTML } = mod;

// Independent of the page: whole dollars, half away from zero ($888.88 prints $889), U+2212 for a negative.
const fmt = n => { const d = Math.floor(Math.abs(n) + 0.5); return (n < 0 && d ? '−' : '') + '$' + String(d).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
const amounts = html => (html.replace(/<[^>]+>/g, ' ').match(/−?\$[\d,]+(?:\.\d\d)?/g) || []);

// 1. every printed amount equals a published value it names; nothing computed
const html = buildCardsHTML(ctx(view));
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-cards.css'), 'utf8');
const allowed = new Set([888.88, 1234.56, 111.11, 222.22, 333.33, 666.66, 123.45, 400, 10.1, 50.5].map(fmt));
const printed = amounts(html);
assert(printed.length > 0);
printed.forEach(a => assert(allowed.has(a), 'unpublished amount printed: ' + a));
// each card's headline is exactly its published value
const card = k => html.split('data-stack-card="' + k + '"')[1].split('</details>')[0];
// Dale (2026-11-20, "bills needs the paid/owed"): Forecast's paid over the Bills total, as Budget prints spent / budget.
assert(card('bills').includes('<span class="sc-f">' + fmt(111.11) + '<i> / ' + fmt(888.88) + '</i></span>'), 'bills headline = stackSummary.bills.paid / .other');
assert(card('budget').includes(fmt(333.33)) && card('budget').includes(fmt(666.66)));
assert(!html.includes('data-stack-card="mortgage"') && !html.includes(fmt(1234.56)) && !html.includes('--sc-mortgage'), 'there is no Mortgage card and its amount is on no card');
// the go button's text: everything inside <span class="sc-go"> once its tags are removed (the chevron is an svg, so none)
const goText = h => { const m = /<span class="sc-go"[^>]*>([\s\S]*?)<\/span>/.exec(h); if (!m) throw new Error('no go button'); return m[1].replace(/<[^>]*>/g, '').trim(); };
assert(goText('<summary><span class="sc-go" aria-hidden="true"><svg></svg></span></summary>') === '', 'control: an svg-only go button has no text');
assert(goText('<summary><span class="sc-go" aria-hidden="true">Open</span></summary>') === 'Open', 'control: the check reports text put in the go button');
assert((() => { try { goText('<summary></summary>'); return false; } catch (e) { return true; } })(), 'control: a head with no go button throws, never passes');
// every head carries the round go button, a chevron with no text, and mirrors its open state in aria-expanded
['bills', 'budget'].forEach(k => {
  const head = card(k).split('</summary>')[0];
  assert(/<summary aria-expanded="false">/.test(head) && /<span class="sc-go" aria-hidden="true"><svg class="sc-chev"/.test(head), k + ' head: aria-expanded and the go button');
  assert(goText(head) === '', k + ' go button has no text', JSON.stringify(goText(head)));
});
// the open state reaches the head's aria-expanded
{
  const listeners = {};
  const c = { innerHTML: '', addEventListener: (t, fn, cap) => { (listeners[t] = listeners[t] || []).push({ fn, cap }); } };
  require("../public/stack-cards.js").render(c, ctx(view));
  const attrs = { 'aria-expanded': 'false' };
  const sum = { setAttribute: (n, v) => { attrs[n] = v; } };
  const det = { querySelector: () => sum, hasAttribute: () => true };
  listeners.toggle[0].fn({ target: det });
  assert(listeners.toggle[0].cap === true && attrs['aria-expanded'] === 'true', 'opening a card sets aria-expanded on its head');
  det.hasAttribute = () => false; listeners.toggle[0].fn({ target: det });
  assert(attrs['aria-expanded'] === 'false', 'closing it clears aria-expanded');
}
// excluded: mortgage, card minimum and carried rows are not in Bills; their amounts never appear there
['Mortgage', 'Card A minimum', 'Carried one'].forEach(n => assert(!card('bills').includes(n), n + ' leaked into Bills'));
assert(!card('bills').includes(fmt(77.77)) && !card('bills').includes(fmt(999.99)));
assert(!html.includes(fmt(999.99)) && !html.includes('Hidden'));
// rows: item, amount, and the check for a matched payment (#1465, Dale); no status word visible (owner direction)
const CHECK = '<span class="sc-check" role="img" aria-label="Paid">\u2713</span>';
const rowOf = (h, label) => h.split('<li class="sc-row sc-bill').slice(1).map(x => x.split('</li>')[0]).find(x => x.includes('>' + label + '<'));
assert(rowOf(card('bills'), 'Hydro').includes(CHECK), 'a paid row shows the check');
assert(!rowOf(card('bills'), 'Phone').includes('sc-check') && !rowOf(card('bills'), 'Phone').includes('\u2713'), 'an unpaid row shows no mark');
for (const k of ['bills', 'budget']) {
  // Screen-reader-only words (sc-sr, hidden by the CSS proved below) are not visible text.
  const visible = card(k).replace(/<span class="sc-sr">[^<]*<\/span>/g, ' ').replace(/<[^>]+>/g, ' ');
  assert(!/paid|Paid|Not paid/.test(visible), 'no status word is visible on ' + k);
}
assert(!/ of \d+ paid|paid \/ total/.test(html), 'no paid count or descriptor on the strips');
assert(rowOf(card('bills'), 'Hydro').includes(fmt(111.11)) && rowOf(card('bills'), 'Phone').includes(fmt(222.22)), 'the amount stays');
{
  const mp = JSON.parse(JSON.stringify(view)); mp.bills[3].stackBillPaymentEvidence = 'posted-equal'; mp.bills[3].stackBillPaid = true;
  const mh = buildCardsHTML(ctx(mp));
  assert(!/mortgage/i.test(mh), 'a paid mortgage row prints nothing on the cards (its sheet opens from the waterfall)');
  const unk = JSON.parse(JSON.stringify(view)); unk.bills[0].stackBillPaymentEvidence = 'maybe'; unk.bills[3].stackBillPaymentEvidence = 'maybe';
  // The check is Forecast's flag alone (stackBillPaid true): an absent or non-boolean flag renders none.
  unk.bills[0].stackBillPaid = 'maybe'; delete unk.bills[3].stackBillPaid;
  const u = buildCardsHTML(ctx(unk));
  assert(!u.includes('sc-check') && !u.includes('\u2713'), 'an unknown evidence word renders no check');
  const nul = JSON.parse(JSON.stringify(view)); nul.bills[0].stackBillAmount = null;
  const n = buildCardsHTML(ctx(nul)).split('data-stack-card="bills"')[1].split('</details>')[0];
  assert(rowOf(n, 'Hydro').includes('<span class="sc-a">\u2014</span>') && !/[$]0/.test(n), 'an unpublished amount is a dash, never a zero');
}
// membership is Forecast's mark only (stackBillPart), never this page's own rule
{
  // A plain bill named "mortgage" that Forecast files under other stays in Bills; a row with no mark is listed nowhere.
  const look = JSON.parse(JSON.stringify(view));
  look.bills.push({ id: 'mortgage', date: '2026-01-09', label: 'Mortgage lookalike', amount: 44.44, paidState: 'not-paid', stackBillPart: 'other', stackBillAmount: 44.44 });
  look.bills.push({ id: 'unmarked', date: '2026-01-10', label: 'Unmarked', amount: 55.55, paidState: 'not-paid' });
  const lh = buildCardsHTML(ctx(look));
  const of = k => lh.split('data-stack-card="' + k + '"')[1].split('</details>')[0];
  assert(of('bills').includes('Mortgage lookalike'), 'a plain bill named mortgage stays in Bills, by its mark');
  assert(!lh.includes('Unmarked') && !lh.includes(fmt(55.55)), 'a row with no mark is listed nowhere');
  // The row prints the amount the split counts there, not the row's own amount.
  const counted = JSON.parse(JSON.stringify(view)); counted.bills[0].stackBillAmount = 131.31;
  const ch = buildCardsHTML(ctx(counted)).split('data-stack-card="bills"')[1].split('</details>')[0];
  assert(rowOf(ch, 'Hydro').includes(fmt(131.31)) && !rowOf(ch, 'Hydro').includes(fmt(111.11)), 'a row prints its stackBillAmount');
  // No marks at all (Forecast could not say): the heads stay, no row is listed.
  const bare = JSON.parse(JSON.stringify(view));
  bare.bills.forEach(b => { delete b.stackBillPart; delete b.stackBillAmount; delete b.stackBillDebtId; });
  const bh = buildCardsHTML(ctx(bare));
  assert(!/sc-row sc-bill/.test(bh) && bh.includes(fmt(888.88)), 'unmarked rows: the heads, and no bill row');
}
// category rows read spent of planned; markup is escaped
assert(card('budget').includes(fmt(123.45)) && card('budget').includes(fmt(400)));
assert(card('budget').includes('Fun &lt;money&gt;'));
// closed strips: native <details>, no `open` attribute
assert(!/<details[^>]* open/.test(html));

// 2. not published => nothing, never $0
const bare = JSON.parse(JSON.stringify(view));
bare.stackSummary.bills = { mortgage: null, cardMinimums: null, other: null, trust: 'unavailable' };
bare.budgetProgress.household = { actual: { amount: null }, planned: { amount: null } };
// A withheld split marks no row (Forecast publishStackBillParts; proved in forecast-authorized-additions).
bare.bills.forEach(b => { delete b.paidState; delete b.stackBillPart; delete b.stackBillAmount; delete b.stackBillDebtId; delete b.stackBillPaymentEvidence; delete b.stackBillAmountTrust; });
bare.householdBudget = [{ label: 'X', spent: null }];
const h2 = buildCardsHTML(ctx(bare));
assert(!/\$0(\.00)?\b/.test(h2) && amounts(h2).length === 0, 'unpublished figure printed');
assert(/class="sc-f">\u2014</.test(h2), 'an unpublished headline is a dash'); assert(!/[$]0(\.00)?\b/.test(h2));
assert(!h2.includes('sc-check') && !h2.includes('\u2713'), 'no check without paidState');
const none = { start: '2026-01-01' }; // no stackSummary at all (#1426 not merged)
assert.strictEqual(amounts(buildCardsHTML(ctx(none))).length, 0);
assert.strictEqual(buildCardsHTML(ctx(view, 'zzz')), '', 'unknown period renders nothing');
assert.strictEqual(buildCardsHTML(null), '');
// a published zero is a real value and prints
const z = JSON.parse(JSON.stringify(view)); z.stackSummary.bills.other = 0;
assert(buildCardsHTML(ctx(z)).includes('$0<'));

// card colours: every kind's variable is defined in the CSS file
['bills', 'budget', 'savings'].forEach(k => assert(css.includes('--sc-' + k + ':'), 'css var missing: ' + k));
// both themes: fixed fills with dark ink, so no theme-dependent rule is needed; every selector is scoped
assert(css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g).every(s => s.split(',').every(x => x.trim().startsWith('html.stack-view '))), 'selectors scoped');

// Savings card (owner rule 2026-11-20, invented values): nothing until published
assert(!html.includes('data-stack-card="savings"'), 'savings renders nothing until published');
const withSavings = s => { const v = JSON.parse(JSON.stringify(view)); v.stackSummary.savings = s; return v; };
const savingsOf = v => { const h = buildCardsHTML(ctx(v)); const p = h.split('data-stack-card="savings"')[1]; return p ? p.split('</details>')[0] : null; };
const txt = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// Savings (owner rule, Dale 2026-11-20): the balance poured nearest due first. Head "$saved / $needed" with the bar;
// one row per goal "$saved / $needed" with its own bar; Unallocated last, only when above $0; dashes when withheld.
const POURED = { items: [
  { id: 'club', label: 'Club <fund>', saved: 95, needed: 230, trust: 'calculated' },
  { id: 'home', label: 'Home', saved: 24, needed: 24, trust: 'calculated' },
  { id: 'trip', label: 'Trip', saved: 0, needed: 40, trust: 'calculated' }],
  totals: { balance: 160, saved: 119, needed: 294, unallocated: 41, trust: 'calculated', reasons: ['owner-rule:balance-poured-nearest-due-first', 'balance-current'] } };
const cur = savingsOf(withSavings(POURED));
assert(cur.includes('class="sc-f">' + fmt(119) + '<i> / ' + fmt(294) + '</i>'), 'head: total saved / total needed');
assert(cur.includes('style="width:' + shell.barWidth(119, 294) * 100 + '%"'), 'head bar = barWidth(saved, needed)');
assert(cur.includes('<span class="sc-a">' + fmt(95) + '<i> / ' + fmt(230) + '</i></span>') && cur.includes('style="width:' + shell.barWidth(95, 230) * 100 + '%"'),
  'a partly saved goal: "$95 / $230" and its own bar');
assert(cur.includes('<span class="sc-a">' + fmt(24) + '<i> / ' + fmt(24) + '</i></span>') && cur.includes('width:100%'), 'a full goal reads full');
assert(cur.includes('<span class="sc-a">$0<i> / ' + fmt(40) + '</i></span>') && cur.includes('<i style="width:0%">'), 'a goal the pour has not reached: $0 and an empty bar');
assert(cur.includes('Club &lt;fund&gt;') && !cur.includes('<fund>'), 'goal names are escaped');
assert((cur.match(/sc-full/g) || []).length === 3, 'a bar on every goal, none on Unallocated');
assert(/<b class="sc-n">Unallocated<\/b><\/span><span class="sc-a">\$41<\/span><\/li><\/ul>$/.test(cur), 'Unallocated is the last row, its amount alone');
assert(txt(cur).indexOf('Club') < txt(cur).indexOf('Home') && txt(cur).indexOf('Home') < txt(cur).indexOf('Trip'), 'goals print in Forecast\'s pour order');
amounts(cur).forEach(a => assert([119, 294, 95, 230, 24, 0, 40, 41].map(fmt).includes(a), 'unpublished amount ' + a));
assert(!cur.includes(fmt(160)), 'the balance itself is not printed (the head is saved / needed)');
assert(!/Funded|funded|moved|entitlement|this period/.test(txt(cur)), 'no funded or period words');
// Nothing left over: no Unallocated row
{
  const v = JSON.parse(JSON.stringify(POURED)); v.totals.unallocated = 0;
  assert(!/Unallocated/.test(savingsOf(withSavings(v))), 'unallocated $0: no row');
  v.totals.unallocated = null;
  assert(!/Unallocated/.test(savingsOf(withSavings(v))), 'unallocated withheld: no row');
}
// The balance withheld: the card stays, a dash head and a dash on every goal, names kept, no amount at all
const nt = savingsOf(withSavings({ items: [{ id: 'club', label: 'Club', saved: null, needed: null, trust: 'unavailable' },
  { id: 'home', label: 'Home', saved: null, needed: null, trust: 'unavailable' }],
  totals: { balance: null, saved: null, needed: null, unallocated: null, trust: 'unavailable', reasons: ['owner-rule:balance-poured-nearest-due-first', 'balance-unavailable'] } }));
assert(nt && /class="sc-f">\u2014</.test(nt) && (nt.match(/<span class="sc-a">\u2014<\/span>/g) || []).length === 2 && /Club/.test(nt) && /Home/.test(nt),
  'balance withheld: the card stays with every goal name and a dash, never hidden');
assert(amounts(nt).length === 0 && !/sc-full/.test(nt) && /<i style="width:0%">/.test(nt), 'balance withheld: no amount, no goal bar, an empty head track');
// Forecast publishes null on every period but the current and next: no card
{
  const v = withSavings(null);
  assert(savingsOf(v) === null, 'null savings: no card');
  ['current', 'next', 'future', 'past', undefined].forEach(role => { const w = withSavings(POURED); w.timelineRole = role; assert(savingsOf(w) !== null, 'the card follows what Forecast publishes, not the role: ' + role); });
}
assert(savingsOf(withSavings({ items: [], totals: { saved: null, entitlement: null } })) === null, 'empty savings renders nothing');

// card colours: every kind's variable is defined in the CSS file
['bills', 'budget', 'savings'].forEach(k => assert(css.includes('--sc-' + k + ':'), 'css var missing: ' + k));
// both themes: fixed fills with dark ink, so no theme-dependent rule is needed; every selector is scoped
assert(css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g).every(s => s.split(',').every(x => x.trim().startsWith('html.stack-view '))), 'selectors scoped');

// strips are numbers only: Budget reads the spent figure, then "of" the budget figure in the muted style, no words
{
  const b = card('budget');
  assert(b.includes('<span class="sc-f">' + fmt(333.33) + '<i> / ' + fmt(666.66) + '</i></span>'), 'Budget strip: X / Y');
  assert(!/<span class="sc-s">/.test(b) && b.includes('<span class="sc-sr">spent / budget</span>'),
    'Budget head: no visible grey subtitle (Dale, 2026-11-20); the words stay as screen-reader-only text');
  assert(/\.sc-sr\{position:absolute;width:1px;height:1px;[^}]*clip:rect\(0 0 0 0\)/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-cards.css'), 'utf8')),
    'the screen-reader-only class really hides the words');
  assert(!/<span class="sc-s">/.test(card('bills')) && !/<span class="sc-sr">/.test(card('bills')), 'Bills head: no subtitle, visible or hidden (no wording beyond the approved design)');
}

// 2b. sheet contract: each published row carries the right attribute, is focusable and a button; no savings rows
const attr = (h, v) => h.includes('data-stack-sheet="' + v + '" role="button" tabindex="0"');
assert(attr(card('bills'), 'bill:hydro@2026-01-05') && attr(card('bills'), 'bill:phone@2026-01-07'));
assert(!card('bills').includes('mortgage:') && !card('bills').includes('bill:old@'));
assert(attr(card('budget'), 'budget:groceries') && attr(card('budget'), 'budget:fun'));
assert(!/mortgage:mortgage@/.test(html), 'no card opens a mortgage sheet');
const noId = JSON.parse(JSON.stringify(view)); delete noId.bills[0].date; delete noId.householdBudget[0].id;
const nh = buildCardsHTML(ctx(noId));
assert(!nh.includes('bill:hydro') && !nh.includes('budget:groceries'), 'no attribute without the ids');
assert(!savingsOf(withSavings(POURED)).includes('data-stack-sheet'));
// Enter / Space act as a click
{
  let handler = null, clicked = 0;
  const cont = { addEventListener: (n, f) => { if (n === 'keydown') handler = f; }, innerHTML: '' };
  require(file).render(cont, ctx(view));
  assert(handler && cont.innerHTML.includes('data-stack-sheet'));
  const row = { getAttribute: () => 'bill:hydro@2026-01-05', click: () => clicked++ };
  ['Enter', ' ', 'a'].forEach(key => handler({ key, target: row, preventDefault() {} }));
  assert.strictEqual(clicked, 2, 'Enter and Space click; other keys do not');
}

// 2c. trust: estimated figures are drawn softer (class stack-est); the word never appears; calculated ones carry no class
{
  const e = JSON.parse(JSON.stringify(view));
  e.budgetProgress.household.actual.trust = 'estimated';
  e.householdBudget[0].plannedTrust = 'estimated';
  e.stackSummary.bills.trust = 'estimated';
  const eh = buildCardsHTML(ctx(e)), cardOf = k => eh.split('data-stack-card="' + k + '"')[1].split('</details>')[0];
  assert(/class="sc-f stack-est"/.test(cardOf('budget')) && /class="sc-bar stack-est"/.test(cardOf('budget')), 'budget headline and bar drawn soft');
  assert((cardOf('budget').match(/class="stack-est"/g) || []).length === 1 && /<i class="stack-est"> \/ /.test(cardOf('budget')),
    'only the estimated amount (the first row\'s plan) is soft');
  // No greyed bill amounts on the rows (owner decision, Dale, 2026-11-22): an estimated row amount prints plain (its
  // trust is drawn in its tap-in sheet). The head and its bar have no sheet, so they stay soft when estimated (lead
  // ruling on pre-review 7074755817): the only place that total's trust can show.
  assert(/class="sc-f stack-est"/.test(cardOf('bills')) && /class="sc-bar stack-est"/.test(cardOf('bills')),
    'an estimated Bills total keeps its soft head and bar');
  {
    const rowsOfBills = h => (h.match(/<li class="sc-row sc-bill[\s\S]*?<\/li>/g) || []);
    const eb = JSON.parse(JSON.stringify(e));
    eb.stackSummary.bills.paidTrust = 'estimated';
    eb.bills.forEach(b => { if (b.stackBillAmount != null) b.stackBillAmountTrust = 'estimated'; });
    const bc = buildCardsHTML(ctx(eb)).split('data-stack-card="bills"')[1].split('</details>')[0];
    const br = rowsOfBills(bc);
    assert(br.length > 0 && br.every(r => !/stack-est/.test(r)), 'estimated bill row amounts are not greyed on the card');
    assert(/class="sc-f stack-est"/.test(bc), 'an estimated paid keeps the head soft');
    const pb = JSON.parse(JSON.stringify(view)); pb.evidenceState = 'projected';
    const pc = buildCardsHTML(ctx(pb)).split('data-stack-card="bills"')[1].split('</details>')[0];
    assert(rowsOfBills(pc).every(r => !/stack-est/.test(r)) && /class="sc-f stack-est"/.test(pc),
      'a projected period: rows print plain, the head (a projected total) stays soft');
    const calc = buildCardsHTML(ctx(view)).split('data-stack-card="bills"')[1].split('</details>')[0];
    assert(!/stack-est/.test(calc), 'a calculated Bills card carries no soft class at all');
  }
  assert(!/estimated/i.test(eh), 'the word estimated never appears in the DOM');
  // the category mini bar is soft with its row's figures: an estimated amount, and a projected period (Codex on #1467)
  const rowsOf = h => (h.match(/<li class="sc-row[^>]*data-stack-sheet="budget:[\s\S]*?<\/li>/g) || []);
  const er = rowsOf(cardOf('budget'));
  assert(er.length === 2 && /class="sc-mini stack-est"/.test(er[0]) && /class="sc-mini"/.test(er[1]), 'a category with an estimated plan draws a soft bar; a calculated one does not');
  const pv = JSON.parse(JSON.stringify(view)); pv.evidenceState = 'projected';
  const pr = rowsOf(buildCardsHTML(ctx(pv)).split('data-stack-card="budget"')[1].split('</details>')[0]);
  assert(pr.length === 2 && pr.every(r => /class="sc-mini stack-est"/.test(r)), 'a projected period: every category bar is soft');
  const ar = rowsOf(card('budget'));
  assert(ar.length === 2 && ar.every(r => !/sc-mini stack-est/.test(r)), 'an actual period with calculated figures: no bar is soft');
  assert(!html.includes('stack-est'), 'calculated figures carry no class');
  const se = withSavings({ items: [{ id: 'r', label: 'Rainy', saved: 3, needed: 8, trust: 'estimated' }],
    totals: { balance: 5, saved: 3, needed: 8, unallocated: 2, trust: 'estimated', reasons: [] } });
  const sh = savingsOf(se);
  assert(/class="sc-f stack-est"/.test(sh) && /sc-a stack-est/.test(sh) && /sc-mini sc-full stack-est/.test(sh) && !/estimated/i.test(sh),
    'a dated balance: the head, each goal and Unallocated are soft, never worded');
  assert((sh.match(/sc-a stack-est/g) || []).length === 2, 'the goal and Unallocated amounts are both soft');
  assert(!/class="sc-f stack-est"/.test(savingsOf(withSavings(POURED))) && !/stack-est/.test(savingsOf(withSavings(POURED))), 'a current balance: nothing soft');
  assert(/stack-est/.test(css), 'the css draws the soft style');
}
// 2d. a completed period whose original plan Forecast withholds: no category denominator, no progress bar
{
  const h = JSON.parse(JSON.stringify(view));
  h.budgetProgress.household.planned = { amount: null, trust: 'unavailable' };
  const hh = buildCardsHTML(ctx(h)), b = hh.split('data-stack-card="budget"')[1].split('</details>')[0];
  assert(!b.includes(fmt(400)) && !b.includes(fmt(50.5)) && !/sc-mini"><i style="width:[1-9]/.test(b) && /sc-mini"><i style="width:0%"/.test(b),
    'withheld plan: not printed, and each row draws an empty track, never a guessed fill');
  assert(b.includes(fmt(123.45)), 'spent still printed');
}

// 2f. the bar fill comes from the shell's shared StackBlocks.barWidth; no local ratio helper
assert(!/drawWidth/.test(fs.readFileSync(file, 'utf8')), 'local drawWidth removed');
{
  const wide = JSON.parse(JSON.stringify(view)); wide.householdBudget[0].spent = 200; wide.householdBudget[0].planned = 400;
  const b = buildCardsHTML(ctx(wide)).split('data-stack-card="budget"')[1];
  assert(b.includes('style="width:' + shell.barWidth(200, 400) * 100 + '%"'), 'row bar = barWidth(spent, planned)');
  const zero = JSON.parse(JSON.stringify(view)); zero.householdBudget[0].planned = 0;
  assert(buildCardsHTML(ctx(zero)).split('data-stack-card="budget"')[1].includes('width:0%'), 'no whole: empty bar');
}

// 2g. no explanatory words anywhere on the cards (owner rule): names, numbers, bars and the check only
{
  const all = withSavings(POURED);
  all.stackSummary.bills.trust = 'estimated'; all.budgetProgress.household.actual.trust = 'estimated';
  all.bills[0].stackBillPaymentEvidence = 'posted-equal'; all.bills[3].stackBillPaymentEvidence = 'posted-equal'; all.bills[0].stackBillPaid = all.bills[3].stackBillPaid = true;
  // the screen-reader-only Budget words are not visible text; they are removed before the visible-word check
  const visible = buildCardsHTML(ctx(all)).replace(/<[^>]+>/g, ' ').replace('spent / budget', ' ');
  assert(!/needs|set aside|planned|spent|estimated|projected|confirm|excludes|moved|entitlement|paid|period/i.test(visible), 'a word label is visible: ' + visible);
}

// 3. no money arithmetic in the page code
const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
assert(!/\.reduce\(/.test(src), 'no reduce over money');

// 4. no-flag: nothing outside this file loads it, and without a shell nothing renders
const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
// B1's index.html loads the file after the shell; with ?view=classic the shell never calls a renderer, and
// loading the file itself only registers a function (no element, style, listener or fetch).
assert(index.indexOf('/stack-shell.js') < index.indexOf('/stack-cards.js'), 'cards file loads after the shell');
assert(!/document\.(createElement|write)|addEventListener\('(DOMContentLoaded|load)/.test(fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('function render')[0]), 'no load-time side effects');
registered = {}; delete globalThis.StackBlocks; delete require.cache[require.resolve(file)];
require(file); // loads inertly with no StackBlocks
assert.deepStrictEqual(registered, {});
globalThis.StackBlocks = STUB; // the checks below render again, through the shell's money format
console.log('test-stack-cards: ok');



// B: the bar lives in the head (always visible closed), the bar follows the design's sizes, no dashed outline, Savings peach
{
  const css1 = fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-cards.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const sh = fs.readFileSync(path.join(__dirname, '..', 'public', 'stack.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const cr = fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-credit.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ['bills', 'budget'].forEach(k => {
    const head = card(k).split('</summary>')[0];
    assert(/<span class="sc-bar[^"]*" aria-hidden="true"><i style="width:[\d.]+%"><\/i><\/span>/.test(head), k + ': the bar is in the head, so it shows closed');
    assert(!/<\/summary>[\s\S]*sc-bar/.test(card(k).replace(/<li[\s\S]*?<\/li>/g, '')), k + ': no second bar below the head');
  });
  assert(/\.sc-bar\{[^}]*height:8px[^}]*margin-top:12px/.test(css1) && /\.sc-card\[open\] \.sc-bar\{height:12px;margin-top:14px\}/.test(css1), 'bar: 8px closed with 12px above, 12px open with 14px above');
  assert(/\.sc-card\[open\] \.sc-f\{font-size:52px/.test(css1), 'the open head figure is 52px');
  assert(!/dashed/.test(css1 + cr) && !/stack-(credit-bar|credit-minibar|sheet-bar)[^{]*\{[^}]*dashed/.test(sh), 'no dashed outline on any bar');
  assert(/\.sc-bar\.stack-est>i[^{]*\{opacity:\.58\}/.test(css1) && /\.sc-bar\.stack-est[^{]*\{opacity:1\}/.test(css1), 'an estimated bar keeps its track and softens only its fill');
  assert(/--sc-savings:#ffcfb3/.test(css1) && !/--sc-savings:#b4ead3/.test(css1), 'Savings is peach, not mint');
  assert(/\.stack-chev \{[^}]*width: 14px; height: 14px/.test(cr), 'Credit\'s chevron is the same 14px as the other cards\' (not stretched by the global svg rule)');
  // an unpublished budget figure: a dash and an empty track, never a $0 or a guessed fill
  const nb = JSON.parse(JSON.stringify(view)); nb.budgetProgress.household.actual = null; nb.householdBudget = [];
  const b0 = buildCardsHTML(ctx(nb)).split('data-stack-card="budget"')[1].split('</summary>')[0];
  assert(/—/.test(b0) && /<i style="width:0%">/.test(b0) && !/\$0/.test(b0), 'a withheld Budget head: a dash and an empty track');
}

// B (rows and bars): mini bars show (block), every sheet row has its chevron, Bills bar stays empty until a paid figure is published
{
  const css1 = fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-cards.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const cr = fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-credit.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert(/\.sc-mini\{display:block;height:6px;border-radius:3px/.test(css1), 'the category mini bar is a block with its 6px height (an inline span would draw nothing)');
  const rows = h => (h.match(/<li class="sc-row[^>]*data-stack-sheet[\s\S]*?<\/li>/g) || []);
  ['bills', 'budget'].forEach(k => {
    const rs = rows(card(k));
    assert(rs.length > 0 && rs.every(r => /<svg class="sc-cv"/.test(r)), k + ': every row that opens a sheet carries its chevron');
  });
  assert(/<svg class="sc-cv"/.test(rowOf(card('bills'), 'Hydro')) === true, 'a bill row ends with its chevron');
  // The Bills bar fills paid / owed through the shell's one drawing ratio, as Budget's: 111.11 / 888.88 = 12.5%.
  assert(/<span class="sc-bar[^"]*" aria-hidden="true"><i style="width:12.5%"><\/i><\/span>/.test(card('bills').split('</summary>')[0]),
    'bills: the bar fills paid / owed (12.5%)');
  const np = JSON.parse(JSON.stringify(view)); np.stackSummary.bills.paid = null; np.stackSummary.bills.paidTrust = 'unavailable';
  const nh = buildCardsHTML(ctx(np)).split('data-stack-card="bills"')[1].split('</details>')[0].split('</summary>')[0];
  assert(/<span class="sc-bar" aria-hidden="true"><i style="width:0%"><\/i><\/span>/.test(nh) && !/[$]0</.test(nh),
    'bills: an unpublished paid is a dash and an empty track, never $0 or a fill from the total');
  assert(/\.sc-f>\[role=img\]\{font-size:\.6em/.test(css1) && /\.stack-credit-figure\[data-unpublished\] \{ font-size: 14\.4px/.test(cr),
    'a withheld head figure is a small soft dash like the "/ b" part, not a big minus');
}

// C1 S4 B2: a real recommendation whose operating plan is unavailable. Replaces the classic page's printed "unavailable
// Plan surface lists no bills or Household Budget planned dollars" (test-plan-calendar-waterfalls.js section 18): with the
// plan unavailable Forecast publishes no bills total and no budget figures for the current period, and the cards must
// print no amount for it, never $0. The trusted control prints its published figures; a mutant printing $0 is caught.
{
  const H = require('./acceptance/harness.js');
  const F = require('../public/forecast.js');
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  w.bills = [{ id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed' }];
  const { data, packet, error } = H.dataOf(w);
  if (error) throw error;
  const base = { debts: data.debts, currentPeriodActuals: packet };
  const trusted = F.recommend(data.plan, w.asOf, base);
  const unavailable = F.recommend(data.plan, w.asOf, Object.assign({ operatingPlan: 'unavailable', operatingPlanNote: 'Current plan unavailable. The dated opening is stale.' }, base));
  const active = rec => rec.payPeriodViews.find(v => v.role === 'active');
  const cardsOf = (rec, view, builder) => (builder || buildCardsHTML)({ data, plan: data.plan, recommendation: rec, selectedPeriodKey: view.start, Forecast: F });
  const aT = active(trusted), aU = active(unavailable);
  assert(unavailable.operatingPlanUnavailable === true && aU.stackSummary.bills.other == null
      && aU.budgetProgress.household.planned.amount == null && aU.budgetProgress.household.actual.amount == null
      && aT.stackSummary.bills.other === 90 && aT.budgetProgress.household.planned.amount === 400,
    'independent facts: the trusted current period publishes bills $90 and a $400 budget plan, the unavailable one publishes neither');
  const htmlT = cardsOf(trusted, aT), htmlU = cardsOf(unavailable, aU);
  assert(amounts(htmlT).includes('$90') && amounts(htmlT).includes('$400'), 'control: the trusted current period prints its $90 bills and $400 budget plan');
  assert(amounts(htmlU).length === 0, 'the unavailable current period prints no amount on the cards: ' + JSON.stringify(amounts(htmlU)));
  assert(!/[$]0(?![\d.,])/.test(htmlU), 'and nothing reads $0');
  // Mutation: print an unpublished figure as $0; the unavailable period then prints money and the checks above fail.
  const src = fs.readFileSync(file, 'utf8');
  const target = 'return isNum(v) ? root.StackBlocks.money(v) : null;';
  assert(src.split(target).length === 2, 'the mutation target appears once');
  const Module = require('module');
  const mm = new Module(file);
  mm.filename = file;
  mm.paths = Module._nodeModulePaths(path.dirname(file));
  mm._compile(src.replace(target, 'return root.StackBlocks.money(isNum(v) ? v : 0);'), file);
  const mutantHtml = cardsOf(unavailable, aU, mm.exports.buildCardsHTML);
  assert(amounts(mutantHtml).length > 0, 'mutant: printing an unpublished figure as $0 shows money on the unavailable period and is caught');
  console.log('PASS unavailable-plan period prints no amount on the cards (real recommendation, control, $0 mutant)');
}

// Bill names print without their timing qualifiers (owner decision, Dale, queued 2026-11-22): the shell's one rule,
// StackBlocks.billName. Invented labels; the published label itself is unchanged.
{
  const n = shell.billName;
  assert.strictEqual(n('Rehearsal room (estimated timing)'), 'Rehearsal room');
  assert.strictEqual(n('Rehearsal room (Estimated Timing) '), 'Rehearsal room');
  assert.strictEqual(n('Car insurance \u2014 15 August posting unknown'), 'Car insurance');
  assert.strictEqual(n('Car insurance - 15 August posting unknown'), 'Car insurance');
  assert.strictEqual(n('Car insurance posting unknown'), 'Car insurance');
  assert.strictEqual(n('Hydro'), 'Hydro', 'a plain label is untouched');
  assert.strictEqual(n('Mid-month top-up'), 'Mid-month top-up', 'a hyphen alone is not a qualifier');
  assert.strictEqual(n('Car-insurance posting unknown'), 'Car-insurance', 'a hyphen inside a name is not the qualifier dash');
  assert.strictEqual(n('Car-insurance \u2014 9 March posting unknown'), 'Car-insurance', 'a hyphenated name keeps its hyphen before the dash');
  assert.strictEqual(n('(estimated timing)'), '(estimated timing)', 'an all-qualifier label prints as given, never empty');
  assert.strictEqual(n(null), '');
  const q = JSON.parse(JSON.stringify(view));
  q.bills[1].label = 'Phone (estimated timing)';
  q.bills[0].label = 'Hydro \u2014 15 August posting unknown';
  const qh = buildCardsHTML(ctx(q));
  assert(!/estimated timing|posting unknown/i.test(qh) && qh.includes('>Phone<') && qh.includes('>Hydro<'),
    'the Bills card rows print the names without the qualifiers');
  assert.strictEqual(q.bills[1].label, 'Phone (estimated timing)', 'the published label is not changed');
}
console.log('bill names and ungreyed bills: ok');
