'use strict';
/*
 * One authority for a projected period's savings top-up (lead dispatch
 * 2026-11-19, option 1).
 *
 * The Budget's selected-period funding (payPeriodViews[i].plannedCostFunding,
 * printed by the period waterfall as "This period — proposed" and "Funding
 * shortfall") is the authority. The Savings reprints of the same top-up read
 * from it:
 *   - savingsFunding.periodViews[i].packet.period.proposal / allocations /
 *     cycleAllocations, and packet.rows[].thisPeriod, for next and future views;
 *   - the payday lens ("Proposed this payday").
 * Before this change both came from a second schedule walked on the raw cash
 * path, which ignored the Budget's household hold: on the invented club world
 * the lens printed $105 / $135 beside the waterfall's $80 and its shortfall.
 *
 * Sections:
 *   1. the three club inputs: the top-up equals the Budget figure, computed here
 *      independently from the period's own published terms (income - bills -
 *      household hold, capped by the requirement), and the literal $80;
 *   2. every invented input: a projected view whose Budget funding is not
 *      published is withheld (null, unknown), never a zero;
 *   3. every invented input: a published projected top-up reprints the Budget
 *      funding exactly (proposal, allocations, rows over member ids, lens);
 *   4. two mutants that restore the cash-walk schedule (packet; lens) fail 1;
 *   5. the page: the payday lens prints the waterfall's own proposed total for
 *      the same period. ("Added this period" on a projected card prints the
 *      closing projection's contribution, plan.js budgetDailySavingsHtml; that
 *      second schedule is the recorded NEXT PR and is not asserted here.)
 *   6. the payday panel's linked detail ("Complete exact payday funding plan")
 *      prints the panel's proposal or is withheld, for a capped amount, a
 *      legitimate zero and withheld funding; a Budget shortfall marks and
 *      names the row it affects (requirement id, not occurrence key).
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const Snap = require('../scripts/figures-snapshot.js');

let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ' — ' + detail : ''}`);
};

const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const replaceOnce = (text, from, to, label) => {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error('anchor not found exactly once: ' + label);
  return parts.join(to);
};
function compile(text, name) {
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(text, FILE.replace(/\.js$/, '-' + name + '.js'));
  return mod.exports;
}
const SHIPPED = require('../public/forecast.js');
// Mutant A: the projected packet reads the cash-walk schedule again.
const PACKET_ANCHOR = '          const topUp = projected ? savingsProjectedTopUp(view) : null;\n';
const packetMutant = compile(replaceOnce(SOURCE, PACKET_ANCHOR,
  '          const topUp = projected ? (p => p && savingsSchedule.status !== \'unavailable\'\n'
  + '            ? { ready: true, contribution: p.contribution, allocations: p.allocations, reason: null }\n'
  + '            : { ready: false, contribution: null, allocations: [], reason: \'x\' })(savingsSchedule.paydays?.find(row =>\n'
  + '              row.payday === view.start && row.through === view.end)) : null;\n', 'packet'), 'cash-walk-packet');
// Mutant B: the payday lens reads the cash-walk schedule's first payday again.
const LENS_ANCHOR = '        const nextTopUp = savingsProjectedTopUp(nextPeriod\n'
  + '          ? { start: nextPeriod.start, end: nextPeriod.end, funding: nextPeriod.plannedCostFunding } : null);\n';
const lensMutant = compile(replaceOnce(SOURCE, LENS_ANCHOR,
  '        const nextTopUp = (p => p ? { ready: true, contribution: p.contribution, allocations: p.allocations,\n'
  + '          remaining: p.stillToFund, trust: planSpendFunding.fundingTrust, gap: savingsSchedule.gap, reason: null }\n'
  + '          : { ready: false, contribution: null, allocations: [], remaining: null, trust: \'unknown\', gap: null, reason: \'x\' })(\n'
  + '          savingsSchedule.status !== \'unavailable\' ? savingsSchedule.paydays?.[0] : null);\n', 'lens'), 'cash-walk-lens');

const inputs = Snap.loadInventedInputs();
const run = (F, input) => {
  const data = structuredClone(input.doc.data);
  const opts = Snap.pageOptions(data, input.doc.periods == null ? null : structuredClone(input.doc.periods));
  return { data, opts, advice: F.recommend(data.plan, data.meta.asOf, opts) };
};
const cents = v => Math.round(v * 100);
const sumCents = list => list.reduce((s, v) => s + cents(v), 0);
const projectedViews = advice => (advice.savingsFunding?.periodViews || []).filter(v => ['next', 'future'].includes(v.role));
const lensOf = advice => (advice.savingsFunding?.lenses || []).find(l => l.key === 'payday');
const memberIds = (advice, row) => [...advice.savingsFunding.backing.items, ...advice.savingsFunding.unresolved]
  .filter(item => row.members.includes(item.key)).map(item => item.id);

// 1. The three club inputs, against an independent Budget figure.
const CLUB = ['savings-live-partial', 'savings-live-ready', 'savings-chained-closes'];
const clubCheck = (F, input) => {
  const { advice } = run(F, input);
  const period = advice.payPeriodViews.find(p => p.timelineRole === 'next');
  const view = advice.savingsFunding.periodViews.find(v => v.start === period.start);
  // Independent of both schedules: the Budget's own published terms.
  const left = cents(period.available) - cents(period.periodBillLoad) - cents(period.budgetHold);
  const required = cents(period.plannedCostFunding.gap.required);
  const expected = Math.min(left, required);
  const club = view.packet.rows.find(r => r.key === 'group:club');
  const lens = lensOf(advice);
  return { expected, left, required, proposal: cents(view.packet.period.proposal), club: cents(club.thisPeriod),
    allocations: view.packet.period.allocations, lens: lens && lens.ready ? cents(lens.proposal) : null,
    lensPayday: lens && lens.payday, start: period.start };
};
for (const id of CLUB) {
  const input = inputs.find(i => i.id === id);
  const r = clubCheck(SHIPPED, input);
  ok(r.expected === 8000 && r.left === 8000 && r.required > 8000,
    `${id}: Budget leaves $80 of a larger requirement (income − bills − household hold)`, `${r.left / 100} of ${r.required / 100}`);
  ok(r.proposal === r.expected, `${id}: projected packet proposal = the Budget top-up`, `${r.proposal / 100}`);
  ok(r.club === r.expected, `${id}: group:club "This period" = the Budget top-up`, `${r.club / 100}`);
  ok(JSON.stringify(r.allocations.map(a => [a.id, cents(a.amount)])) === JSON.stringify([['far', 8000]]),
    `${id}: allocations are the Budget's per-cost contributions`, JSON.stringify(r.allocations));
  ok(r.lens === r.expected && r.lensPayday === r.start, `${id}: payday lens = the Budget top-up for the next period`, `${r.lens / 100}`);
}

// 2 and 3. Every invented input: withheld or an exact reprint.
let withheldViews = 0, reprinted = 0, lensChecked = 0;
for (const input of inputs) {
  const { advice } = run(SHIPPED, input);
  if (!advice.savingsFunding?.periodViews) continue;
  for (const view of projectedViews(advice)) {
    const f = view.funding;
    const published = f && (f.status === 'ready' || f.status === 'funding-gap');
    const packet = view.packet;
    if (!published) {
      withheldViews++;
      ok(packet.period.proposal === null && packet.period.status === 'unavailable' && packet.period.allocations.length === 0
        && packet.rows.every(r => r.thisPeriod === null && r.thisPeriodTrust === 'unknown'),
        `${input.id} ${view.start}: Budget funding ${f ? f.status : 'absent'} — top-up withheld, no zero`);
      continue;
    }
    reprinted++;
    const items = f.items.filter(i => i.contribution > 0);
    ok(cents(packet.period.proposal) === cents(f.contribution)
      && JSON.stringify(packet.period.allocations.map(a => [a.id, cents(a.amount)])) === JSON.stringify(items.map(i => [i.id, cents(i.contribution)]))
      && packet.rows.every(r => cents(r.thisPeriod) === sumCents(items.filter(i => memberIds(advice, r).includes(i.id)).map(i => i.contribution))),
      `${input.id} ${view.start}: proposal, allocations and rows reprint the Budget funding`, `${packet.period.proposal} / ${f.contribution}`);
  }
  const lens = lensOf(advice);
  const next = advice.payPeriodViews.find(p => p.timelineRole === 'next');
  if (lens && next) {
    lensChecked++;
    const f = next.plannedCostFunding;
    const published = f && (f.status === 'ready' || f.status === 'funding-gap');
    ok(published ? lens.ready && cents(lens.proposal) === cents(f.contribution) && lens.payday === next.start
      : !lens.ready && lens.proposal === null,
      `${input.id}: payday lens ${published ? 'reprints' : 'withholds'} the next period's Budget funding`, `${lens.proposal}`);
  }
}
ok(withheldViews > 0 && reprinted > 0 && lensChecked >= 6, `corpus reached both branches`,
  `${withheldViews} withheld, ${reprinted} reprinted, ${lensChecked} lenses`);

// 4. The cash-walk mutants fail section 1.
for (const id of CLUB) {
  const input = inputs.find(i => i.id === id);
  const a = clubCheck(packetMutant, input);
  ok(a.proposal !== a.expected && a.club !== a.expected, `${id}: packet mutant (cash-walk schedule) is caught`, `${a.proposal / 100} ≠ ${a.expected / 100}`);
  const b = clubCheck(lensMutant, input);
  ok(b.lens !== b.expected, `${id}: lens mutant (cash-walk schedule) is caught`, `${b.lens / 100} ≠ ${b.expected / 100}`);
}

// 5. The page prints one figure: the payday lens against the waterfall.
const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, setAttribute() {} });
const ctx = vm.createContext({ Forecast: SHIPPED, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
ctx.window = ctx; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
for (const script of ['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan']) {
  if (script === 'bill-detail') vm.runInContext('App.boot=()=>{};', ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/' + script + '.js'), 'utf8'), ctx);
}
vm.runInContext('state.targetBuffer=20;state.extraDebtMonthly=0;state.debts=[];', ctx);
const amountIn = text => { const m = /\$(-?[\d,]+\.\d\d)/.exec(text || ''); return m ? cents(Number(m[1].replace(/,/g, ''))) : null; };
let pagesChecked = 0;
for (const input of inputs) {
  const { data, opts, advice } = run(SHIPPED, input);
  const next = advice.payPeriodViews.find(p => p.timelineRole === 'next');
  if (!advice.savingsFunding?.periodViews || !next) continue;
  ctx.src = { plan: data.plan, debts: [], asOf: data.meta.asOf, advice, liveOverlay: opts, weekly: 40, weeklyOverride: 40 };
  ctx.daily = vm.runInContext('budgetDailySavingsFor(src)', ctx);
  ctx.period = next;
  const waterfall = vm.runInContext('calendarWaterfallHtml(period,src.liveOverlay,null,src.plan,true,{daily:daily,inventory:src.advice.savingsInventory,asOf:src.asOf})', ctx);
  const proposed = [...waterfall.matchAll(/This period — proposed<\/span><span>([^<]*)<\/span>/g)].map(m => amountIn(m[1]));
  const waterfallTotal = proposed.length && proposed.every(v => v != null) ? proposed.reduce((s, v) => s + v, 0) : null;
  const upcoming = vm.runInContext('budgetUpcomingFundingHtml(src)', ctx);
  const panel = upcoming.split('data-budget-funding-panel="payday"')[1] || '';
  const lensText = (panel.split('data-budget-funding-proposal>')[1] || '').split('</strong>')[0];
  const lensPrinted = amountIn(lensText);
  pagesChecked++;
  // A cost list with no proposed line (no cost this period) totals $0.
  const total = waterfallTotal ?? (proposed.length === 0 && /data-budget-funding-item|Funding shortfall/.test(waterfall) ? 0 : null);
  ok(lensPrinted === total || (lensPrinted == null && /Unavailable/.test(lensText) && total == null),
    `${input.id}: page "Proposed this payday" = the waterfall's proposed total for ${next.start}`, `${lensPrinted} / ${total}`);
}
ok(pagesChecked >= 6, 'page corpus reached the payday lens', `${pagesChecked} pages`);

// 6. The payday panel's linked detail and its shortfall row (Atlas findings
// 7026261645 / 7033675700). "Complete exact payday funding plan" opens
// [data-payday-breakdown="planned-cost-funding"] (wireBudgetFunding). That
// detail must print the panel's own proposal or be withheld, never a second
// figure; and a Budget shortfall names and marks the row it affects.
const blockOf = html => {
  const start = html.indexOf('data-payday-breakdown="planned-cost-funding"');
  return start < 0 ? null : html.slice(start, html.indexOf('</details>', start));
};
let linkCapped = 0, linkZero = 0, linkWithheld = 0, gapNamed = 0;
for (const input of inputs) {
  const { data, opts, advice } = run(SHIPPED, input);
  if (!advice.savingsFunding?.periodViews) continue;
  ctx.src = { plan: data.plan, debts: [], asOf: data.meta.asOf, advice, liveOverlay: opts, weekly: 40, weeklyOverride: 40 };
  const upcoming = vm.runInContext('budgetUpcomingFundingHtml(src)', ctx);
  const panel = (upcoming.split('data-budget-funding-panel="payday"')[1] || '').split('data-budget-funding-panel=')[0];
  ok(/data-budget-funding-evidence="payday"/.test(panel), `${input.id}: the payday panel links its detail`);
  const lensPrinted = amountIn((panel.split('data-budget-funding-proposal>')[1] || '').split('</strong>')[0]);
  const block = blockOf(vm.runInContext('budgetTodayCashCardHtml(src)', ctx));
  ok(block != null, `${input.id}: the linked target [data-payday-breakdown="planned-cost-funding"] renders`);
  if (block == null) continue;
  const detailAmount = amountIn((block.split('class="instruction-amount">')[1] || '').split('</p>')[0]);
  ok(detailAmount == null || detailAmount === lensPrinted,
    `${input.id}: the linked detail prints the panel's proposal or nothing`, `${detailAmount} / ${lensPrinted}`);
  const lens = advice.savingsFunding.lenses.find(l => l.key === 'payday');
  if (lens.ready && cents(lens.proposal) > 0 && lens.gap) linkCapped++;
  else if (lens.ready && cents(lens.proposal) === 0) linkZero++;
  else if (!lens.ready) linkWithheld++;
  if (CLUB.includes(input.id)) {
    ok(detailAmount == null || detailAmount === 8000, `${input.id}: capped: the linked detail never prints the cash walk`, `${detailAmount}`);
    // The Budget's shortfall affects requirement 'far'; the lens row is keyed
    // by occurrence (far@...) and carries requirementId 'far'.
    const far = lens.items.find(item => item.requirementId === 'far');
    ok(far && lens.gap.affected.includes('far'), `${input.id}: the Budget shortfall names requirement far`);
    const row = far && panel.split('data-budget-funding-cost="' + far.id + '"')[0].split('<div class="budget-funding-cost').pop();
    ok(row != null && / has-gap/.test(row), `${input.id}: the shortfall row is marked`);
    const affected = (panel.split('<p>Affected: ')[1] || '').split('.</p>')[0];
    ok(far && affected === far.label, `${input.id}: the shortfall names the affected cost by its label`, affected);
    if (far && affected === far.label) gapNamed++;
  }
  if (input.id === 'savings-deficit-cover') {
    ok(lensPrinted === 0 && (detailAmount == null || detailAmount === 0),
      `${input.id}: legitimate zero: the linked detail never prints the cash walk's 100`, `${detailAmount}`);
  }
}
ok(linkCapped >= 3 && linkZero >= 1 && linkWithheld >= 1 && gapNamed === 3,
  'the linked detail was checked for a capped amount, a legitimate zero and withheld funding',
  `${linkCapped} capped, ${linkZero} zero, ${linkWithheld} withheld, ${gapNamed} shortfalls named`);

console.log(failures ? `${failures} of ${checks} FAILED` : `All ${checks} projected top-up checks passed`);
process.exit(failures ? 1 : 0);
