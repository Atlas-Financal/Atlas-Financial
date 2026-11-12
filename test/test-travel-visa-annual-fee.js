'use strict';
/* Travel Visa annual fee: a bill, not a savings goal.
 *
 * Forecast publishes the fee's yearly-bill funding row (source
 * 'yearly-card-paid-bill', id 'travelvisa-annual-fee-2027') so the reserve
 * protection stands; the Savings surfaces must not print that row — the fee
 * is shown once under Bills as an upcoming annual bill, read from the
 * CURRENT publication. Fixtures are hand-built sealed publications in the
 * exact shape Forecast.savingsDailyFunding publishes; every expected figure
 * is read from the fixture itself, never recomputed by the code under test.
 * The renderers must never alter the publication, never print the fee's
 * saved figure under Bills, never invent a figure or date for a duplicated
 * or unresolved identity, and must keep every other row byte-for-byte.
 *
 * `node test/test-travel-visa-annual-fee.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const F = require('../public/forecast');

const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const ctx = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {}, document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } }, localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
ctx.window = ctx; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
for (const script of ['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan']) {
  if (script === 'bill-detail') vm.runInContext('App.boot=()=>{};', ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/' + script + '.js'), 'utf8'), ctx);
}
vm.runInContext('state.targetBuffer=20;state.extraDebtMonthly=0;state.debts=[];', ctx);

const AS_OF = '2026-10-05', START = '2026-10-02', END = '2026-10-15';
const FEE_ID = 'travelvisa-annual-fee-2027', FEE_KEY = 'yearly-bill:' + FEE_ID;
// Atlas's approved smallest resolution (Slack 1791764127.160729): ONE
// neutral note on every Savings surface in every state — it claims only
// that the fee is treated as a bill and that its funding is unchanged,
// never anything about the Bills destination the current view renders.
const NEUTRAL_NOTE = 'Travel Visa annual fee is treated as a bill; its funding is unchanged.';
const periodView = { id: 'period-current', timelineRole: 'current', start: START, end: END };
const item = fields => ({ scheduledDate: fields.date || null, when: null, group: null, groupLabel: null,
  neededRange: null, saved: null, inactive: false, poolId: 'combined-savings',
  dateBasis: 'cash-planning-date', ...fields });

const feeItem = item({ key: FEE_ID + '@2027-10-06', id: FEE_ID, label: 'Travel Visa annual fee',
  date: '2027-10-06', source: 'yearly-card-paid-bill', needed: 149, saved: 0, trust: 'estimated' });
const homeItem = item({ key: 'home-cost@2026-10-25', id: 'home-cost', label: 'Invented annual home cost',
  date: '2026-10-25', source: 'yearly-card-paid-bill', needed: 24, saved: 24, trust: 'calculated' });
const soloItem = item({ key: 'solo-fee@2026-11-01', id: 'solo-fee', label: 'Solo fee',
  date: '2026-11-01', source: 'commitment', needed: 50, saved: 10, trust: 'calculated' });
const row = fields => ({ poolId: 'combined-savings', remainingThisPeriod: null,
  actualContribution: null, ...fields });

function packet({ fee = 'ready' } = {}) {
  const items = [homeItem, soloItem], unresolved = [], rows = [
    row({ key: 'yearly-bill:home-cost', label: homeItem.label, members: [homeItem.key],
      saved: 24, savedTrust: 'calculated', needed: 24, neededTrust: 'calculated', trust: 'calculated',
      thisPeriod: 0, thisPeriodTrust: 'calculated' }),
    row({ key: 'commitment:solo-fee', label: soloItem.label, members: [soloItem.key],
      saved: 10, savedTrust: 'calculated', needed: 50, neededTrust: 'calculated', trust: 'calculated',
      thisPeriod: 5, thisPeriodTrust: 'calculated' }),
  ];
  if (fee === 'ready') {
    items.push(feeItem);
    rows.push(row({ key: FEE_KEY, label: feeItem.label, members: [feeItem.key],
      saved: 0, savedTrust: 'calculated', needed: 149, neededTrust: 'estimated', trust: 'estimated',
      thisPeriod: 0, thisPeriodTrust: 'estimated' }));
  }
  if (fee === 'unresolved') {
    const held = item({ key: FEE_ID + '@undated', id: FEE_ID, label: feeItem.label, date: null,
      source: 'yearly-card-paid-bill', needed: null, saved: null, trust: 'unknown',
      contribution: null, reason: 'Planning date not established.' });
    unresolved.push(held);
    rows.push(row({ key: FEE_KEY, label: feeItem.label, members: [held.key],
      saved: null, savedTrust: 'unknown', needed: null, neededTrust: 'unknown', trust: 'unknown',
      thisPeriod: null, thisPeriodTrust: 'unknown' }));
  }
  if (fee === 'duplicate') {
    const second = item({ ...feeItem, key: FEE_ID + '@2028-10-06', date: '2028-10-06', scheduledDate: '2028-10-06' });
    items.push(feeItem, second);
    rows.push(row({ key: FEE_KEY, label: feeItem.label, members: [feeItem.key, second.key],
      saved: null, savedTrust: 'unknown', needed: null, neededTrust: 'unknown', trust: 'unknown',
      thisPeriod: null, thisPeriodTrust: 'unknown' }));
  }
  return {
    source: 'Forecast.savingsDailyFunding', asOf: AS_OF, currency: 'CAD',
    actionPermission: 'not-granted', moneyMovementPermission: 'not-granted', status: 'ready',
    allocationDescription: 'Current observed stock allocated chronologically from one combined savings pot.',
    stock: { status: 'ready', amount: 119, trust: 'calculated', asOf: AS_OF },
    backing: { status: 'ready', reason: null, trust: 'calculated',
      pools: [{ id: 'combined-savings', accountId: 'synthetic-reserve', label: 'Synthetic reserve', observedCash: 119, observedAsOf: AS_OF, deficit: 0 }],
      items, unallocated: 0 },
    unresolved, rows,
    period: { status: 'ready', basis: 'operating-surplus-before-proposals', start: START, end: END,
      entitlement: 90, transferred: 0, nativePeriodSurplus: 90, alreadySavedIncome: 0,
      remainingEntitlement: 90, availableNow: 60, proposal: 42, unassigned: 3,
      trust: 'calculated', actualSaved: null, allocations: [], cycleAllocations: [] },
    periodViews: [{ id: periodView.id, start: START, end: END, role: 'current' }],
  };
}

const srcFor = p => ({ plan: {}, debts: [], asOf: AS_OF,
  advice: { savingsFunding: p, payPeriodViews: [periodView], savingsInventory: null } });

function renderSheet(p) {
  ctx.src = srcFor(p);
  const before = JSON.stringify(p);
  const html = vm.runInContext('budgetDailySavingsHtml(budgetDailySavingsFor(src), "", null, { asOf: src.asOf })', ctx);
  assert.equal(JSON.stringify(p), before, 'sheet renderer does not alter the publication');
  return html;
}
function renderTile(p) {
  ctx.src = srcFor(p); ctx.period = periodView;
  const before = JSON.stringify(p);
  const html = vm.runInContext('budgetSavingsGoalsHtml(src, period, null)', ctx);
  assert.equal(JSON.stringify(p), before, 'tile renderer does not alter the publication');
  return html;
}
function renderInventory(p) {
  ctx.packetArg = p; ctx.invContext = { asOf: AS_OF, advice: { payPeriodViews: [periodView] } };
  const before = JSON.stringify(p);
  const html = vm.runInContext('SavingsInventory.html(packetArg, invContext)', ctx);
  assert.equal(JSON.stringify(p), before, 'inventory renderer does not alter the publication');
  return html;
}
function renderBills(p, period) {
  ctx.src = srcFor(p); ctx.periodArg = period;
  const before = JSON.stringify(p);
  const html = vm.runInContext('budgetBillsSectionHtml(periodArg, src)', ctx);
  assert.equal(JSON.stringify(p), before, 'bills renderer does not alter the publication');
  return html;
}
const billsPeriod = fields => ({ bills: [], remainingBills: 0, paidBills: 0,
  totalBillsThisPeriod: 0, periodBillLoad: 0, ...fields });
const bucketSegment = (html, key) => {
  const at = html.indexOf(`data-budget-bill-bucket="${key}"`);
  assert.notEqual(at, -1, `bucket ${key} is rendered`);
  return html.slice(at, html.indexOf('</section>', at));
};
const count = (html, needle) => html.split(needle).length - 1;

// ---- Savings exclusion: sheet, tile, inventory ----
{
  const p = packet();
  for (const [name, html, hook] of [
    ['sheet', renderSheet(p), 'data-budget-savings-total-goal'],
    ['tile', renderTile(p), 'data-budget-savings-goal'],
    ['inventory', renderInventory(p), 'data-savings-goal'],
  ]) {
    assert.equal(count(html, `${hook}="${FEE_KEY}"`), 0, `${name}: the fee row is not printed as a savings goal`);
    assert.equal(count(html, `${hook}="yearly-bill:home-cost"`), 1, `${name}: the control yearly bill still prints`);
    assert.equal(count(html, `${hook}="commitment:solo-fee"`), 1, `${name}: the control commitment still prints`);
    assert.ok(!html.includes('149.00'), `${name}: the fee's figures appear nowhere on the Savings surface`);
    assert.match(html, /24\.00/, `${name}: control figures are unchanged`);
    assert.match(html, /50\.00/, `${name}: control figures are unchanged`);
  }
  const sheet = renderSheet(p);
  assert.match(sheet, /data-budget-daily-proposal[^>]*>[\s\S]*?42\.00/, 'sheet: the published period proposal still prints verbatim');
  assert.equal(count(sheet, 'data-budget-savings-annual-bill-note'), 1, 'sheet: exactly one aggregate note');
  const tile = renderTile(p);
  assert.equal(count(tile.slice(0, tile.indexOf('<div data-budget-funding-savings')), 'data-budget-savings-annual-bill-note'), 0,
    'tile: the Saving-for card itself prints no note (display tidy-up: the sentence left the tile)');
  assert.ok(!tile.slice(0, tile.indexOf('<div data-budget-funding-savings')).includes(NEUTRAL_NOTE),
    'tile: the sentence is absent from the Saving-for card itself');
  assert.equal(count(tile, 'data-budget-savings-annual-bill-note'), 1,
    'tile: the embedded daily-savings detail is a separate surface and keeps its own note');
  assert.equal(count(renderInventory(p), 'data-savings-annual-bill-note'), 1, 'inventory: exactly one aggregate note');
  for (const html of [sheet, renderTile(p), renderInventory(p)]) {
    assert.ok(html.includes(NEUTRAL_NOTE),
      'the note is the one neutral note on every surface; it prints no total and no saved figure');
    assert.ok(!html.includes('shown under Bills as an upcoming annual bill'),
      'no surface claims the Bills destination in the note copy');
  }
  assert.ok(p.rows.some(r => r.key === FEE_KEY) && p.backing.items.some(i => i.id === FEE_ID),
    'the publication itself still carries the fee row and its backing (protection unchanged)');
}

// ---- No fee row published: no exclusion, no note ----
{
  const p = packet({ fee: 'none' });
  for (const [name, html, hook] of [
    ['sheet', renderSheet(p), 'data-budget-savings-total-goal'],
    ['tile', renderTile(p), 'data-budget-savings-goal'],
    ['inventory', renderInventory(p), 'data-savings-goal'],
  ]) {
    assert.ok(!html.includes('annual-bill-note'), `${name}: no note when the fee row was not in the render`);
    assert.equal(count(html, `${hook}="yearly-bill:home-cost"`), 1, `${name}: control rows still print`);
  }
  assert.ok(!renderBills(p, billsPeriod(periodView)).includes('data-budget-bill-bucket="upcoming"'),
    'bills: no upcoming bucket when the fee is not published');
}

// ---- Bills: current period shows the upcoming entry, plainly ----
{
  const p = packet();
  const html = renderBills(p, billsPeriod(periodView));
  const seg = bucketSegment(html, 'upcoming');
  assert.match(seg, /Upcoming annual bills/, 'the bucket is separately labelled');
  assert.match(seg, /Travel Visa annual fee/, 'the published label prints');
  assert.match(seg, /149\.00/, 'the published amount prints');
  assert.match(seg, /October 6, 2027/, 'the published occurrence date prints with its year');
  assert.match(seg, /estimated/i, 'the estimated qualification prints');
  assert.ok(!seg.includes('data-budget-bill-open'), 'the row is plain markup: it never opens the bill sheet');
  assert.ok(!/Currently backed|Saved/.test(seg.replace('Travel Visa annual fee', '')), 'the published saved figure never prints under Bills');
  assert.equal(count(html, 'data-budget-annual-bill="travelvisa-annual-fee-2027"'), 1, 'the entry prints exactly once');
}

// ---- Bills: historical period omits the entry (#571 posture) ----
{
  const html = renderBills(packet(), billsPeriod({ id: 'period-past', timelineRole: 'past', start: '2026-09-18', end: '2026-10-01' }));
  assert.ok(!html.includes('data-budget-bill-bucket="upcoming"'), 'historical: no upcoming bucket');
  assert.match(html, /Completed-period bills/, 'historical: the #571 framing is intact');
  assert.match(html, /Historical settlement evidence, not an amount due now\./, 'historical: the #571 qualification is intact');
}

// ---- Bills: the period containing the occurrence defers to the native bucket ----
{
  const native = { id: FEE_ID, label: 'Travel Visa annual fee', date: '2027-10-06',
    status: 'planned', settlement: 'upcoming', movement: -149, confidence: 'estimated' };
  const html = renderBills(packet(), billsPeriod({ id: 'period-fee', timelineRole: 'future',
    start: '2027-10-01', end: '2027-10-14', bills: [native] }));
  assert.ok(!html.includes('data-budget-bill-bucket="upcoming"'), 'contained: the upcoming entry steps aside');
  assert.equal(count(html, `data-budget-bill-open="${FEE_ID}"`), 1, 'contained: the fee prints exactly once, in its native bucket');
  assert.match(bucketSegment(html, 'due'), /Travel Visa annual fee/, 'contained: the native row is the Due bucket row');
}

// ---- Unknown fee: excluded from Savings; Bills prints qualifications, invents nothing ----
{
  const p = packet({ fee: 'unresolved' });
  const sheet = renderSheet(p);
  assert.equal(count(sheet, `data-budget-savings-total-goal="${FEE_KEY}"`), 0, 'unresolved: the fee row is still excluded from Savings');
  assert.equal(count(sheet, 'data-budget-savings-annual-bill-note'), 1, 'unresolved: the note still prints');
  const seg = bucketSegment(renderBills(p, billsPeriod(periodView)), 'upcoming');
  assert.match(seg, /Travel Visa annual fee/, 'unresolved: the label prints');
  assert.match(seg, /Date unavailable/, 'unresolved: no date is invented');
  assert.match(seg, /Unavailable/, 'unresolved: the amount stays explicitly unavailable');
  assert.ok(!seg.includes('149') && !seg.includes('2027-10-06') && !seg.includes('October 6'),
    'unresolved: no published figure or date leaks in (the id itself carries the 2027 suffix)');
}

// ---- Duplicate identity: fails closed on both surfaces ----
{
  const p = packet({ fee: 'duplicate' });
  const sheet = renderSheet(p);
  assert.equal(count(sheet, `data-budget-savings-total-goal="${FEE_KEY}"`), 0, 'duplicate: the collapsed row is still excluded from Savings');
  assert.equal(count(sheet, 'data-budget-savings-annual-bill-note'), 1, 'duplicate: the note still prints');
  const seg = bucketSegment(renderBills(p, billsPeriod(periodView)), 'upcoming');
  assert.equal(count(seg, 'data-budget-annual-bill="travelvisa-annual-fee-2027"'), 1, 'duplicate: exactly one entry prints');
  assert.match(seg, /Date unavailable/, 'duplicate: no occurrence is picked');
  assert.match(seg, /Unavailable/, 'duplicate: the amount fails closed to unavailable');
  assert.ok(!seg.includes('149.00') && !seg.includes('2027-10-06') && !seg.includes('2028-10-06') && !seg.includes('October 6'),
    'duplicate: neither occurrence figure or date is printed');
}

// ---- Unavailable publication: the roster fallback must not resurrect the fee ----
// Systems Review BLOCK 5485506265 (advisory 4243676567): when the shared
// savings publication is unavailable, budgetDailySavingsFor returns empty
// rows and the Saving-for card falls back to the period's plannedCostFunding
// roster, which names the fee by its bare item id — not the published
// yearly-bill row key. The exclusion must catch that canonical bare form
// too, print the aggregate note, and leave every other roster goal —
// including an unrelated goal carrying the same label — untouched.
{
  const rosterPeriod = { ...periodView, plannedCostFunding: { status: 'ready',
    items: [
      { id: FEE_ID, label: feeItem.label },
      { id: 'home-cost', label: homeItem.label },
      { id: 'other-annual-fee', label: feeItem.label },
    ], unscheduled: [] } };
  ctx.src = { plan: {}, debts: [], asOf: AS_OF,
    advice: { savingsFunding: null, payPeriodViews: [rosterPeriod], savingsInventory: null } };
  ctx.period = rosterPeriod;
  const before = JSON.stringify(rosterPeriod.plannedCostFunding);
  const html = vm.runInContext('budgetSavingsGoalsHtml(src, period, null)', ctx);
  assert.equal(JSON.stringify(rosterPeriod.plannedCostFunding), before,
    'unavailable: rendering does not alter the funding roster (funding preserved)');
  assert.equal(count(html, `data-budget-savings-goal="${FEE_ID}"`), 0,
    'unavailable: the fee bare fallback identity is not printed as a Savings goal');
  assert.equal(count(html, `data-budget-savings-goal="${FEE_KEY}"`), 0,
    'unavailable: the fee published row key is not printed as a Savings goal');
  assert.equal(count(html, 'data-budget-savings-goal="home-cost"'), 1,
    'unavailable: the unrelated annual goal still prints');
  assert.equal(count(html, 'data-budget-savings-goal="other-annual-fee"'), 1,
    'unavailable: an unrelated goal with the same label still prints (identity, never label, is matched)');
  const cardPart = html.slice(0, html.indexOf('<div data-budget-funding-savings'));
  assert.equal(count(cardPart, 'data-budget-savings-annual-bill-note'), 0,
    'unavailable: no note on the Saving-for card (display tidy-up)');
  // Codex P1 4243785333 on head 7a0ebb5f: in this degraded state the Bills
  // surface reads the same unavailable publication, finds no backing and
  // prints no upcoming entry — so the Savings note must NOT claim the fee
  // "is shown under Bills" or that published funding stands. The interim
  // unavailable-evidence copy (head 20d769ae) is superseded by Atlas's
  // approved smallest resolution (Slack 1791764127.160729): ONE neutral
  // note across all states, claiming only treatment + unchanged funding.
  // The Bills section is still rendered here so exclusion, note and the
  // Bills destination are proven together in this same fixture.
  assert.ok(!cardPart.includes(NEUTRAL_NOTE),
    'unavailable: the sentence is absent from the Saving-for card');
  assert.ok(!cardPart.includes('is shown under Bills as an upcoming annual bill'),
    'unavailable: the note does not claim the fee is shown under Bills');
  assert.ok(!cardPart.includes('published savings funding is unchanged'),
    'unavailable: the note does not claim published funding stands');
  assert.ok(!cardPart.includes('Savings evidence is unavailable for this view'),
    'unavailable: the superseded unavailable-evidence copy distinction is gone');
  const billsHtml = renderBills(null, billsPeriod(periodView));
  assert.ok(!billsHtml.includes('data-budget-bill-bucket="upcoming"'),
    'unavailable: the Bills section prints no upcoming bucket (same unavailable publication)');
  assert.ok(!billsHtml.includes('data-budget-annual-bill="travelvisa-annual-fee-2027"'),
    'unavailable: the Bills section prints no annual-bill entry for the fee');
}

// ---- Unavailable publication, PREFIXED fallback identity: same pair ----
// The roster fallback keys rows by the roster item's id verbatim, so the
// fee can also reach the filter under its published row key form. Both
// canonical forms must be excluded with the same neutral note, unrelated
// goals (including one sharing the fee's label) preserved, roster intact.
{
  const rosterPeriod = { ...periodView, plannedCostFunding: { status: 'ready',
    items: [
      { id: FEE_KEY, label: feeItem.label },
      { id: 'home-cost', label: homeItem.label },
      { id: 'other-annual-fee', label: feeItem.label },
    ], unscheduled: [] } };
  ctx.src = { plan: {}, debts: [], asOf: AS_OF,
    advice: { savingsFunding: null, payPeriodViews: [rosterPeriod], savingsInventory: null } };
  ctx.period = rosterPeriod;
  const before = JSON.stringify(rosterPeriod.plannedCostFunding);
  const html = vm.runInContext('budgetSavingsGoalsHtml(src, period, null)', ctx);
  assert.equal(JSON.stringify(rosterPeriod.plannedCostFunding), before,
    'unavailable-prefixed: rendering does not alter the funding roster (funding preserved)');
  assert.equal(count(html, `data-budget-savings-goal="${FEE_KEY}"`), 0,
    'unavailable-prefixed: the fee under its published row key is not printed as a Savings goal');
  assert.equal(count(html, `data-budget-savings-goal="${FEE_ID}"`), 0,
    'unavailable-prefixed: the fee bare identity is not printed as a Savings goal');
  assert.equal(count(html, 'data-budget-savings-goal="home-cost"'), 1,
    'unavailable-prefixed: the unrelated annual goal still prints');
  assert.equal(count(html, 'data-budget-savings-goal="other-annual-fee"'), 1,
    'unavailable-prefixed: an unrelated goal with the same label still prints');
  const cardPart = html.slice(0, html.indexOf('<div data-budget-funding-savings'));
  assert.equal(count(cardPart, 'data-budget-savings-annual-bill-note'), 0,
    'unavailable-prefixed: no note on the Saving-for card (display tidy-up)');
  assert.ok(!cardPart.includes(NEUTRAL_NOTE),
    'unavailable-prefixed: the sentence is absent from the Saving-for card');
}

// ---- Historical period: exclusion + neutral note, paired with Bills ----
// The period-scoped publication for a past view carries the fee row under
// its published key. The Savings surfaces must still exclude it and print
// the one neutral note (which makes no Bills-destination claim), while the
// Bills section for that same historical period prints no upcoming entry.
{
  const pastView = { id: 'period-past', timelineRole: 'past', start: '2026-09-18', end: '2026-10-01' };
  const pastPacket = packet();
  pastPacket.period = { ...pastPacket.period, start: pastView.start, end: pastView.end };
  pastPacket.periodViews = [{ id: pastView.id, start: pastView.start, end: pastView.end, role: 'past' }];
  const outer = packet();
  outer.periodViews = [
    { id: periodView.id, start: START, end: END, role: 'current' },
    { id: pastView.id, start: pastView.start, end: pastView.end, role: 'past', packet: pastPacket },
  ];
  ctx.src = { plan: {}, debts: [], asOf: AS_OF,
    advice: { savingsFunding: outer, payPeriodViews: [periodView, pastView], savingsInventory: null } };
  ctx.period = pastView;
  const before = JSON.stringify(outer);
  const html = vm.runInContext('budgetSavingsGoalsHtml(src, period, null)', ctx);
  assert.equal(JSON.stringify(outer), before,
    'historical: rendering does not alter the publication (funding preserved)');
  assert.equal(count(html, `data-budget-savings-goal="${FEE_KEY}"`), 0,
    'historical: the fee row is not printed as a Savings goal');
  assert.equal(count(html, 'data-budget-savings-goal="yearly-bill:home-cost"'), 1,
    'historical: the control yearly bill still prints');
  assert.equal(count(html, 'data-budget-savings-goal="commitment:solo-fee"'), 1,
    'historical: the control commitment still prints');
  const cardPart = html.slice(0, html.indexOf('<div data-budget-funding-savings'));
  assert.equal(count(cardPart, 'data-budget-savings-annual-bill-note'), 0,
    'historical: no note on the Saving-for card (display tidy-up)');
  assert.equal(count(html, 'data-budget-savings-annual-bill-note'), 1,
    'historical: the embedded daily-savings detail carries its own note');
  assert.ok(!cardPart.includes(NEUTRAL_NOTE),
    'historical: the sentence is absent from the Saving-for card');
  const billsHtml = renderBills(outer, billsPeriod(pastView));
  assert.ok(!billsHtml.includes('data-budget-bill-bucket="upcoming"'),
    'historical: the Bills section prints no upcoming bucket for the same period');
}

// ---- Own-occurrence period: exclusion + neutral note, paired with Bills ----
// The period containing the published occurrence (2027-10-06) has its own
// period-scoped publication carrying the fee row. Savings must still
// exclude it with the neutral note, while Bills defers to the native
// bucket and prints the fee exactly once there — the note claims neither.
{
  const feeView = { id: 'period-fee', timelineRole: 'future', start: '2027-10-01', end: '2027-10-14' };
  const feePacket = packet();
  feePacket.period = { ...feePacket.period, start: feeView.start, end: feeView.end };
  feePacket.periodViews = [{ id: feeView.id, start: feeView.start, end: feeView.end, role: 'future' }];
  const outer = packet();
  outer.periodViews = [
    { id: periodView.id, start: START, end: END, role: 'current' },
    { id: feeView.id, start: feeView.start, end: feeView.end, role: 'future', packet: feePacket },
  ];
  ctx.src = { plan: {}, debts: [], asOf: AS_OF,
    advice: { savingsFunding: outer, payPeriodViews: [periodView, feeView], savingsInventory: null } };
  ctx.period = feeView;
  const before = JSON.stringify(outer);
  const html = vm.runInContext('budgetSavingsGoalsHtml(src, period, null)', ctx);
  assert.equal(JSON.stringify(outer), before,
    'own-occurrence: rendering does not alter the publication (funding preserved)');
  assert.equal(count(html, `data-budget-savings-goal="${FEE_KEY}"`), 0,
    'own-occurrence: the fee row is not printed as a Savings goal');
  assert.equal(count(html, 'data-budget-savings-goal="yearly-bill:home-cost"'), 1,
    'own-occurrence: the control yearly bill still prints');
  assert.equal(count(html, 'data-budget-savings-goal="commitment:solo-fee"'), 1,
    'own-occurrence: the control commitment still prints');
  const cardPart = html.slice(0, html.indexOf('<div data-budget-funding-savings'));
  assert.equal(count(cardPart, 'data-budget-savings-annual-bill-note'), 0,
    'own-occurrence: no note on the Saving-for card (display tidy-up)');
  assert.equal(count(html, 'data-budget-savings-annual-bill-note'), 1,
    'own-occurrence: the embedded daily-savings detail carries its own note');
  assert.ok(!cardPart.includes(NEUTRAL_NOTE),
    'own-occurrence: the sentence is absent from the Saving-for card');
  const native = { id: FEE_ID, label: 'Travel Visa annual fee', date: '2027-10-06',
    status: 'planned', settlement: 'upcoming', movement: -149, confidence: 'estimated' };
  const billsHtml = renderBills(outer, billsPeriod({ ...feeView, bills: [native] }));
  assert.ok(!billsHtml.includes('data-budget-bill-bucket="upcoming"'),
    'own-occurrence: the Bills section prints no upcoming bucket for the same period');
  assert.equal(count(billsHtml, `data-budget-bill-open="${FEE_ID}"`), 1,
    'own-occurrence: the fee prints exactly once, in its native Bills bucket');
}

console.log('PASS travel-visa-annual-fee: Savings exclusion + one neutral note on all three surfaces across normal, '
  + 'unavailable-fallback (bare + prefixed), historical and own-occurrence states, publication untouched, '
  + 'Upcoming annual bills under All with label/amount/date/trust, historical omit, contained-period native single print, '
  + 'unresolved and duplicate identities fail closed');
