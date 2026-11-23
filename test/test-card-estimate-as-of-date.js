'use strict';
// Dale's owner decision (2026-11-18, via the lead): "instead of an estimated
// tag show the last update date". Where the Budget page shows a figure that
// Forecast publishes as estimated ONLY because card coverage is an estimate
// (a card payment or credit To confirm, #1358 and #1367), the visible label
// leads with "as of <bank data date>", followed by a small muted "≈ estimate"
// mark (Dale chose option A: the word stays, no longer the headline). The
// estimate tag and "≈ estimated" mark it replaces are gone. The trust contract is unchanged
// underneath: the trust stays 'estimated', the element keeps
// data-trust="estimated" and tells assistive technology "estimate: card
// payment to confirm", and the To-confirm row stays. Any other estimate cause
// keeps its wording; a confirmed world shows neither. Invented data only.
//
// The page renders only what Forecast publishes: Forecast adds
// estimateCause 'card-coverage' (fromTodayFunding) and
// paydayShellEstimateCause (payday shell) exactly when the figure's trust is
// estimated and would be calculated without the card term.
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

const ROOT = path.join(__dirname, '..');
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

// The page scripts in a minimal sandbox (as test-assistant-packet-equals-page).
const mk = id => {
  const el = { id, textContent: '', style: {}, attributes: {}, children: [], addEventListener() {}, setAttribute() {},
    removeAttribute() {}, appendChild(c) { return c; }, append() {}, remove() {}, insertAdjacentHTML() {}, querySelectorAll: () => [] };
  let h = ''; Object.defineProperty(el, 'innerHTML', { get: () => h, set(v) { h = String(v); } });
  return el;
};
const sb = {
  document: { getElementById: mk, createElement: () => mk('c'), createElementNS: () => mk('s'), querySelector: () => null,
    querySelectorAll: () => [], documentElement: mk('html'), body: { scrollHeight: 0 } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, addEventListener() {}, matchMedia: () => ({ addEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }), requestAnimationFrame() {}, innerWidth: 1200, innerHeight: 800, scrollY: 0,
  console: { log() {}, warn() {}, error() {}, info() {} }, fetch: () => new Promise(() => {}),
};
sb.window = sb; sb.globalThis = sb; Object.assign(sb, { AbortController, setTimeout, clearTimeout });
vm.createContext(sb);
for (const f of ['public/app.js', 'public/forecast.js', 'public/budget-surface.js', 'public/plan.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
const page = name => vm.runInContext(name, sb);

const purchase = ['card', 80, null, 'purchase'];
const cashLeg = (amount, extra = {}) => ['bills', amount, null, 'cash',
  { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C', category_name: 'Transfer', ...extra }];
const unknownCredit = ['card', -30, null, 'credit', { payee: 'Invented credit', original_name: 'Invented credit', category_name: 'Payment, Transfer' }];
const TRAVEL = 'card payment: Travel Visa ...9999';
const AS_OF = 'as of September 20';
const dateOnly = /data-card-estimate-as-of[^>]*>as of September 20<\/span>/;
const neutral = html => !/≈|trust-estimated|class="est"|<small[^>]*>[^<]*estimate|(?:aria-label|title)="[^"]*estimat|>\s*estimated?\s*</i.test(html);

// The two Budget surfaces whose figures carry a card-coverage estimate.
function render(s, overlay = s.observed.data.liveOverlay) {
  const shell = page('paydayInstructionShellHtml')(s.advice, s.period, null, overlay);
  const spending = page('budgetSpendingSectionHtml')(s.period, { advice: s.advice, asOf: s.advice.defaultView?.asOf || '2026-09-20', liveOverlay: overlay });
  return { shell, spending, html: shell + spending };
}
const count = (html, re) => (html.match(re) || []).length;
const block = (html, title) => {
  const i = html.indexOf('<h3>' + title + '</h3>');
  return i < 0 ? '' : html.slice(i, html.indexOf('</details>', i));
};
const stillPlanned = html => {
  const m = html.match(/<span>Still planned<\/span><strong data-budget-browse-remaining>([\s\S]*?)<\/strong>/);
  return m ? m[1] : '';
};

console.log('1. Forecast publishes the cause only where card coverage is the estimate\'s only cause');
const degraded = run(world([purchase, cashLeg(105)]));
const credit = run(world([purchase, unknownCredit]));
const both = run(world([purchase, cashLeg(105), unknownCredit]));
const resolved = run(world([purchase, cashLeg(105, { notes: TRAVEL })]));
for (const [why, s] of [['payment To confirm (#1358)', degraded], ['credit To confirm (#1367)', credit], ['both', both]]) {
  check(s.period.fromTodayFunding.trust === 'estimated' && s.period.fromTodayFunding.estimateCause === 'card-coverage',
    why + ': available-now funding stays estimated, cause card-coverage');
  check(s.advice.paydayShellTrust.available === 'estimated' && s.advice.paydayShellTrust.household === 'estimated',
    why + ': the shell trust stays estimated');
  check(s.advice.paydayShellEstimateCause && s.advice.paydayShellEstimateCause.available === 'card-coverage'
    && s.advice.paydayShellEstimateCause.household === 'card-coverage', why + ': the shell publishes the cause');
  check(s.advice.cardPurchaseCoverage.trust === 'estimated' && s.advice.cardPurchaseCoverage.toConfirm.length > 0,
    why + ': coverage stays an estimate with its To-confirm rows');
}
// #1573 (lead, 2026-11-23): this world gives no card ledger evidence, so each card's charges already counted above
// are unread and its target is a fall-back: the remainder is an estimate. Toward caution only. 'card-coverage' means a
// card payment to confirm, and there is none here, so no cause is published (lead, 2026-11-23).
check(resolved.coverage.trust === undefined && resolved.period.fromTodayFunding.trust === 'estimated'
  && resolved.period.fromTodayFunding.estimateCause === undefined && resolved.advice.paydayShellEstimateCause === undefined,
  'confirmed coverage: the card-target estimate alone publishes no card-coverage cause (estimated, no cause)');
// The negative (#1573): beside a card payment to confirm, a non-card estimate (the invented payroll estimated) still
// reads as non-card: no card cause.
{
  const incomeEstimated = run(world([purchase, cashLeg(105)], { edit: w => { w.data.plan.income[0].confidence = 'estimated'; } }));
  check(incomeEstimated.coverage.trust === 'estimated' && incomeEstimated.period.fromTodayFunding.trust === 'estimated'
    && incomeEstimated.period.fromTodayFunding.estimateCause === undefined,
    'a payment To confirm beside an estimated income: estimated, and no card cause');
}

console.log('2. The page shows the observation date without a trust marker, for this cause');
for (const [why, s] of [['payment To confirm', degraded], ['credit To confirm', credit], ['both', both]]) {
  const r = render(s);
  for (const title of ['Money available', 'Current household spending']) {
    const b = block(r.shell, title);
    check(dateOnly.test(b), why + ': ' + title + ' preserves the dated observation');
    check(neutral(b), why + ': ' + title + ' has no visible or accessible estimate marker');
    check(/data-trust="estimated"/.test(b), why + ': ' + title + ' keeps internal trust');
  }
  const cell = stillPlanned(r.spending);
  check(dateOnly.test(cell) && neutral(cell),
    `${why}: Still planned shows the observation date without a trust mark (${cell.replace(/<[^>]+>/g, '')})`);
  check(cell.indexOf('$70.00') < cell.indexOf(AS_OF), `${why}: Still planned: the amount, then the date`);
  check(/data-trust="estimated"/.test(cell), `${why}: Still planned keeps data-trust="estimated"`);
}

console.log('3. A confirmed world shows no card-payment date tag');
{
  const r = render(resolved);
  check(count(r.html, /data-card-estimate-as-of/g) === 0 && !r.html.includes('card payment to confirm'),
    'confirmed: no date tag and no card-payment wording');
  // #1573: this world's card targets are fall-backs (no card ledger evidence), so Forecast publishes these figures estimated
  // (section 1). Since #1613 (Dale, 2026-11-23) the page prints no estimate styling on them either way.
  check(!/trust-estimated/.test(block(r.shell, 'Money available')) && !/≈/.test(stillPlanned(r.spending)),
    'confirmed coverage, fall-back card targets: published estimated, printed without estimate styling (#1613)');
}

console.log('4. Other estimate causes print amounts without a qualifier');
{
  // The cause is published only when the figure would be calculated without
  // the card term. Here the shell's own trust is already estimated for another
  // reason (today's income is an estimate), so the cause is withheld and the
  // estimate word stays.
  const advice = JSON.parse(JSON.stringify(degraded.advice));
  delete advice.paydayShellEstimateCause;
  const shell = page('paydayInstructionShellHtml')(advice, degraded.period, null, degraded.observed.data.liveOverlay);
  check(neutral(block(shell, 'Money available')) && !block(shell, 'Money available').includes('data-card-estimate-as-of'),
    'no published cause: the amount has no trust qualifier');
  const period = JSON.parse(JSON.stringify(degraded.period));
  delete period.fromTodayFunding.estimateCause;
  const cell = stillPlanned(page('budgetSpendingSectionHtml')(period, { advice: degraded.advice, asOf: '2026-09-20',
    liveOverlay: degraded.observed.data.liveOverlay }));
  check(neutral(cell) && /\$/.test(cell) && !cell.includes('data-card-estimate-as-of'), 'no published cause: Still planned prints a plain amount');
  // Forecast's own rule: estimated for another reason as well publishes no cause.
  const F = require('../public/forecast');
  check(typeof F.recommend === 'function', 'Forecast loads');
  // A second cause injected after observation (the observer rebuilds the
  // starting cash): the Bills balance itself is an estimate.
  const Live = require('../scripts/live-plan');
  const observed = Live.fromObservation(world([purchase, cashLeg(105)]));
  observed.data.plan.startingCash.breakdown.forEach(row => { if (row.id === 'chequing-a') row.confidence = 'estimated'; });
  const staleAdvice = F.recommend(observed.data.plan, '2026-09-20', { debts: observed.data.debts,
    currentPeriodActuals: observed.data.liveOverlay.currentPeriodActuals });
  const f = staleAdvice.payPeriodViews.find(p => p.role === 'active').fromTodayFunding;
  check(f && f.trust === 'estimated', 'an estimated Bills balance as well: still estimated (' + (f && f.trust) + ')');
  check(f.estimateCause === undefined, 'an estimated Bills balance as well: no card-only cause');
  const cellStale = stillPlanned(page('budgetSpendingSectionHtml')(staleAdvice.payPeriodViews.find(p => p.role === 'active'),
    { advice: staleAdvice, asOf: '2026-09-20', liveOverlay: observed.data.liveOverlay }));
  check(!cellStale.includes('data-card-estimate-as-of'), 'an estimated Bills balance as well: Still planned keeps its estimate wording');
  // #1373's recorded case: NO card estimate (the payment is confirmed) and an
  // estimated Bills balance. Forecast publishes no card cause, so the page
  // shows the estimate wording and never the card's as-of date.
  const noCard = Live.fromObservation(world([purchase, cashLeg(105, { notes: TRAVEL })]));
  noCard.data.plan.startingCash.breakdown.forEach(row => { if (row.id === 'chequing-a') row.confidence = 'estimated'; });
  const noCardAdvice = F.recommend(noCard.data.plan, '2026-09-20', { debts: noCard.data.debts,
    currentPeriodActuals: noCard.data.liveOverlay.currentPeriodActuals });
  const noCardPeriod = noCardAdvice.payPeriodViews.find(p => p.role === 'active');
  check(noCardAdvice.cardPurchaseCoverage.trust !== 'estimated', 'no card estimate: coverage is not an estimate');
  check(noCardPeriod.fromTodayFunding.estimateCause === undefined
    && !Object.values(noCardAdvice.paydayShellEstimateCause || {}).includes(F.CARD_ESTIMATE_CAUSE),
    'no card estimate and an estimated Bills balance: no card cause is published');
  const noCardHtml = page('paydayInstructionShellHtml')(noCardAdvice, noCardPeriod, null, noCard.data.liveOverlay)
    + page('budgetSpendingSectionHtml')(noCardPeriod, { advice: noCardAdvice, asOf: '2026-09-20', liveOverlay: noCard.data.liveOverlay });
  check(count(noCardHtml, /data-card-estimate-as-of/g) === 0, 'no card estimate and an estimated Bills balance: no as-of tag');
  // #1373 pre-review note: with no card estimate, fromTodayFunding has no
  // fundingTrustExceptCard. A figure estimated only by a FORWARD funding term
  // (here an invented future commitment whose amount is an estimate) must
  // never read that absence as "calculated without the card" and gain the
  // card cause.
  const fwd = Live.fromObservation(world([purchase, cashLeg(105, { notes: TRAVEL })]));
  fwd.data.plan.commitments = [{ id: 'roof', label: 'Invented roof', date: '2026-12-15', amount: 400, confidence: 'estimated' }];
  const fwdAdvice = F.recommend(fwd.data.plan, '2026-09-20', { debts: fwd.data.debts,
    currentPeriodActuals: fwd.data.liveOverlay.currentPeriodActuals });
  const fwdPeriod = fwdAdvice.payPeriodViews.find(p => p.role === 'active');
  check(fwdAdvice.cardPurchaseCoverage.trust !== 'estimated' && fwdPeriod.fromTodayFunding.trust === 'estimated',
    'a forward-funding estimate with no card estimate: the figure is estimated (' + fwdPeriod.fromTodayFunding.trust + ')');
  check(fwdPeriod.fromTodayFunding.estimateCause === undefined
    && !Object.values(fwdAdvice.paydayShellEstimateCause || {}).includes(F.CARD_ESTIMATE_CAUSE),
    'a forward-funding estimate with no card estimate: no card cause is published');
  const fwdCell = stillPlanned(page('budgetSpendingSectionHtml')(fwdPeriod, { advice: fwdAdvice, asOf: '2026-09-20',
    liveOverlay: fwd.data.liveOverlay }));
  check(neutral(fwdCell) && /\$/.test(fwdCell) && !fwdCell.includes('data-card-estimate-as-of'),
    'a forward-funding estimate with no card estimate: Still planned prints the unqualified amount, no as-of tag');
}

console.log('4b. One home for the card-estimate cause, basis and reasons');
{
  const F = require('../public/forecast');
  check(F.CARD_ESTIMATE_CAUSE === 'card-coverage' && page('Forecast.CARD_ESTIMATE_CAUSE') === F.CARD_ESTIMATE_CAUSE,
    'Forecast owns the cause code, and the page reads the same one');
  check(Object.isFrozen(F.CARD_ESTIMATE_REASONS) && Object.keys(F.CARD_ESTIMATE_REASONS).sort().join() ===
    ['card-coverage-rows-unconfirmed', 'card-credit-purpose-unconfirmed', 'card-payment-destination-unconfirmed', 'card-payment-source-unconfirmed'].join(),
    'Forecast owns the closed basis set and one fixed reason each');
  const est = basis => ({ status: 'ready', trust: 'estimated', estimateBasis: basis });
  check(F.cardCoverageEstimateBasis(est('card-credit-purpose-unconfirmed')) === 'card-credit-purpose-unconfirmed'
    && F.cardCoverageEstimateBasis(est('not-a-basis')) === 'card-coverage-rows-unconfirmed'
    && F.cardCoverageEstimateBasis({ status: 'ready', trust: 'calculated' }) === null
    && F.cardCoverageEstimateBasis({ status: 'unavailable', trust: 'estimated' }) === null && F.cardCoverageEstimateBasis(null) === null,
    'cardCoverageEstimateBasis: its own basis, the combined fallback, or null when not an estimate');
  // No consumer keeps its own copy: each reason text and basis code is
  // written only in public/forecast.js.
  for (const f of ['scripts/assistant-packet.js', 'scripts/operating-answer.js', 'public/plan.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const [basis, reason] of Object.entries(F.CARD_ESTIMATE_REASONS)) {
      check(!src.includes(reason), `${f} keeps no copy of the ${basis} reason`);
      check(!src.includes(`'${basis}'`), `${f} keeps no copy of the ${basis} code`);
    }
    check(!/=== 'card-coverage'/.test(src), `${f} compares no literal card-coverage cause`);
  }
}

console.log('4c. The payday shell under a card estimate and an income estimate (lead dispatch 2026-11-18)');
{
  // The shell decides its card cause from its own trust before the card term,
  // which is estimated exactly when an income landing TODAY is estimated
  // (available = opening + today's income). Future income does not enter the
  // shell's available or household figures, so it cannot make them estimates.
  const F = require('../public/forecast');
  const Live = require('../scripts/live-plan');
  const base = Live.fromObservation(world([purchase, cashLeg(105)]));
  const shellOf = edit => {
    const plan = JSON.parse(JSON.stringify(base.data.plan)); edit(plan);
    const advice = F.recommend(plan, '2026-09-20', { debts: base.data.debts,
      currentPeriodActuals: base.data.liveOverlay.currentPeriodActuals });
    const period = advice.payPeriodViews.find(p => p.role === 'active');
    const html = page('paydayInstructionShellHtml')(advice, period, null, base.data.liveOverlay);
    return { advice, alloc: advice.paydayAllocation, html };
  };
  const plain = shellOf(() => {});
  check(plain.advice.cardPurchaseCoverage.trust === 'estimated', 'the card estimate is live');
  // 1. Plan income estimated (and its amount moved): the shell figures do not depend on it.
  for (const factor of [1, 2, 0.5]) {
    const r = shellOf(plan => plan.income.forEach(row => { row.confidence = 'estimated'; row.amount *= factor; }));
    check(r.alloc.available === plain.alloc.available
      && JSON.stringify(r.alloc.essentials) === JSON.stringify(plain.alloc.essentials),
      `future income estimated (x${factor}): available and the household allowance do not move`);
    check(r.advice.paydayShellEstimateCause?.available === F.CARD_ESTIMATE_CAUSE
      && r.advice.paydayShellEstimateCause?.household === F.CARD_ESTIMATE_CAUSE,
      `future income estimated (x${factor}): the card is still the only cause, so the card cause stands`);
  }
  // 2. An estimated income landing today is part of available: the cause is withheld.
  const todayIncome = confidence => plan => plan.income.push({ id: 'gift', label: 'Invented gift', frequency: 'once',
    date: '2026-09-20', amount: 50, confidence });
  const est = shellOf(todayIncome('estimated'));
  check(est.alloc.todayIncome === 50 && est.alloc.available === plain.alloc.available + 50,
    'an income landing today is part of available');
  check(est.advice.paydayShellTrust.available === 'estimated' && est.advice.paydayShellEstimateCause === undefined,
    'today\'s income estimated as well: still estimated, and no card cause');
  check(neutral(block(est.html, 'Money available')) && !est.html.includes('data-card-estimate-as-of'),
    'today\'s income estimated as well: no estimate wording or as-of tag');
  // 3. The same income confirmed: the card is again the only cause.
  const conf = shellOf(todayIncome('confirmed'));
  check(conf.advice.paydayShellEstimateCause?.available === F.CARD_ESTIMATE_CAUSE
    && block(conf.html, 'Money available').includes('data-card-estimate-as-of'),
    'today\'s income confirmed: the card cause and its as-of tag stand');
}

console.log('5. No single bank date: the amount has no trust qualifier (never an undated or guessed date)');
{
  const overlay = JSON.parse(JSON.stringify(degraded.observed.data.liveOverlay));
  const accounts = overlay.observedCash && overlay.observedCash.accounts;
  check(Array.isArray(accounts) && accounts.length >= 2, 'the invented overlay has several dated accounts');
  accounts[0].evidenceDate = '2026-09-19'; accounts[0].observedAsOf = '2026-09-19';
  const r = render(degraded, overlay);
  check(count(r.html, /data-card-estimate-as-of/g) === 0, 'mixed dates: no date tag');
  check(neutral(block(r.shell, 'Money available')) && neutral(stillPlanned(r.spending)),
    'mixed dates: the amount has no trust qualifier');
  const untrusted = { ...degraded.observed.data.liveOverlay, applied: false };
  check(count(render(degraded, untrusted).html, /data-card-estimate-as-of/g) === 0, 'an overlay not applied: no date tag');
}

console.log('6. Hostile text never reaches the page raw');
{
  const overlay = JSON.parse(JSON.stringify(degraded.observed.data.liveOverlay));
  for (const row of overlay.observedCash.accounts) row.evidenceDate = row.observedAsOf = '<img src=x onerror=alert(1)>';
  overlay.observedAsOf = '"><script>alert(1)</script>';
  const r = render(degraded, overlay);
  check(!/<img|<script/.test(r.html) && count(r.html, /data-card-estimate-as-of/g) === 0, 'a hostile date is not a date: no tag, nothing raw');
  const tag = page('cardEstimateAsOfHtml')({ applied: true, operatingPlan: 'live', observedAsOf: '2026-09-20', observedCash: { accounts: [] } });
  check(tag && /data-trust="estimated"/.test(tag) && dateOnly.test(tag) && neutral(tag),
    'a valid date renders the tag: only the observation date');
  check(page('cardEstimateAsOfHtml')(null) === null && page('cardEstimateAsOfHtml')({}) === null, 'no overlay: null');
}

console.log(`\nAll card-estimate as-of-date checks passed (${checks}).`);
process.exit(0);
