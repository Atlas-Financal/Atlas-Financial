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
// Option A: the date first, then the small muted mark, inside the one tag.
const DATE_THEN_MARK = /data-card-estimate-as-of[^>]*>as of September 20 <small class="trust-as-of-mark" data-card-estimate-mark>≈ estimate<\/small><\/span>/;

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
check(resolved.period.fromTodayFunding.trust === 'calculated' && resolved.period.fromTodayFunding.estimateCause === undefined
  && resolved.advice.paydayShellEstimateCause === undefined, 'confirmed: calculated, no cause');

console.log('2. The page leads with the date, then a small "≈ estimate" mark, for this cause');
for (const [why, s] of [['payment To confirm', degraded], ['credit To confirm', credit], ['both', both]]) {
  const r = render(s);
  for (const title of ['Money available', 'Current household spending']) {
    const b = block(r.shell, title);
    check(DATE_THEN_MARK.test(b), `${why}: ${title} shows "${AS_OF}" then the small "≈ estimate" mark`);
    check(!/trust-estimated/.test(b) && (b.match(/estimate</g) || []).length === 1,
      `${why}: ${title}: the old estimate tag is gone; the word appears once, in the small mark`);
    check(/data-trust="estimated"/.test(b) && /aria-label="as of September 20, estimate: card payment to confirm"/.test(b)
      && /title="estimate: card payment to confirm"/.test(b), `${why}: ${title} keeps data-trust and the accessible estimate label`);
  }
  const cell = stillPlanned(r.spending);
  check(DATE_THEN_MARK.test(cell) && !/class="est"|budget-cash-sr/.test(cell),
    `${why}: Still planned shows the date then the small mark, not the ≈ estimated mark (${cell.replace(/<[^>]+>/g, '')})`);
  check(cell.indexOf('$70.00') < cell.indexOf(AS_OF), `${why}: Still planned: the amount, then the date`);
  check(/data-trust="estimated"/.test(cell), `${why}: Still planned keeps data-trust="estimated"`);
}

console.log('3. A confirmed world shows neither');
{
  const r = render(resolved);
  check(count(r.html, /data-card-estimate-as-of/g) === 0, 'confirmed: no date tag');
  check(!/trust-estimated/.test(block(r.shell, 'Money available')) && !/≈/.test(stillPlanned(r.spending)),
    'confirmed: no estimate word on these figures either');
}

console.log('4. Other estimate causes keep their wording');
{
  // The cause is published only when the figure would be calculated without
  // the card term. Here the shell's own trust is already estimated for another
  // reason (today's income is an estimate), so the cause is withheld and the
  // estimate word stays.
  const advice = JSON.parse(JSON.stringify(degraded.advice));
  delete advice.paydayShellEstimateCause;
  const shell = page('paydayInstructionShellHtml')(advice, degraded.period, null, degraded.observed.data.liveOverlay);
  check(/trust-estimated">estimate</.test(block(shell, 'Money available')) && !block(shell, 'Money available').includes('data-card-estimate-as-of'),
    'no published cause: the estimate word stays');
  const period = JSON.parse(JSON.stringify(degraded.period));
  delete period.fromTodayFunding.estimateCause;
  const cell = stillPlanned(page('budgetSpendingSectionHtml')(period, { advice: degraded.advice, asOf: '2026-09-20',
    liveOverlay: degraded.observed.data.liveOverlay }));
  check(/≈/.test(cell) && /estimated/.test(cell) && !cell.includes('data-card-estimate-as-of'), 'no published cause: Still planned keeps ≈ estimated');
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

console.log('5. No single bank date: the estimate word stays (never an undated or guessed date)');
{
  const overlay = JSON.parse(JSON.stringify(degraded.observed.data.liveOverlay));
  const accounts = overlay.observedCash && overlay.observedCash.accounts;
  check(Array.isArray(accounts) && accounts.length >= 2, 'the invented overlay has several dated accounts');
  accounts[0].evidenceDate = '2026-09-19'; accounts[0].observedAsOf = '2026-09-19';
  const r = render(degraded, overlay);
  check(count(r.html, /data-card-estimate-as-of/g) === 0, 'mixed dates: no date tag');
  check(/trust-estimated">estimate</.test(block(r.shell, 'Money available')) && /≈/.test(stillPlanned(r.spending)),
    'mixed dates: the estimate word stays');
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
  check(tag && /^<span class="trust-tag trust-as-of" data-trust="estimated"/.test(tag) && DATE_THEN_MARK.test(tag),
    'a valid date renders the tag: the date, then the small mark');
  check(page('cardEstimateAsOfHtml')(null) === null && page('cardEstimateAsOfHtml')({}) === null, 'no overlay: null');
}

console.log(`\nAll card-estimate as-of-date checks passed (${checks}).`);
process.exit(0);
