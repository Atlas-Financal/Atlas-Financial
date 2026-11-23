'use strict';
/* Grouped savings rows expose their published member rows on both consumer
 * surfaces (Budget savings sheet + tile in plan.js, and SavingsInventory).
 * Fixtures are hand-built sealed publications in the exact shape
 * Forecast.savingsDailyFunding publishes and savingsFundingPublication
 * validates; every expected figure below is read from the fixture itself,
 * never recomputed by the code under test. All labels and amounts are
 * invented. The renderers must print published member values verbatim,
 * keep group totals at the published row values, and never turn a missing,
 * duplicate or unknown-trust member value into a zero. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const F = require('../public/forecast');
const contractFx = require('./fixtures/savings-daily-allocation-contract');
const chronoFx = require('./fixtures/chronological-savings-data');

const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const ctx = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {}, document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } }, localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
ctx.window = ctx; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
for (const script of ['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan']) {
  if (script === 'bill-detail') vm.runInContext('App.boot=()=>{};', ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/' + script + '.js'), 'utf8'), ctx);
}
vm.runInContext('state.targetBuffer=20;state.extraDebtMonthly=0;state.debts=[];', ctx);

const AS_OF = '2027-01-15', START = '2027-01-02', END = '2027-01-15';
const periodView = { id: 'period-current', timelineRole: 'current', start: START, end: END };
const item = fields => ({ scheduledDate: fields.date || null, when: null, group: null, groupLabel: null,
  source: 'commitment', neededRange: null, saved: null, inactive: false, poolId: 'combined-savings',
  dateBasis: 'cash-planning-date', ...fields });

// A three-member team-fee group (the Burrards shape: two instalments for one
// child, one for another), one lessons group with published groupLabel, an
// unknown-trust withheld member and a ranged estimated member, and one
// single-member row. A fourth team fee is settled in the world and therefore
// absent from the publication; it must never be reconstructed.
function mainPacket() {
  const a1 = item({ key: 'north-fee-1@2027-03-01', id: 'north-fee-1', label: 'North instalment 1', date: '2027-03-01', group: 'burrards-team-fees', saved: 100, needed: 250, trust: 'calculated' });
  const a2 = item({ key: 'north-fee-2@2027-04-01', id: 'north-fee-2', label: 'North instalment 2', date: '2027-04-01', group: 'burrards-team-fees', saved: 0, needed: 250, trust: 'calculated' });
  const a3 = item({ key: 'south-fee@2027-03-15', id: 'south-fee', label: 'South team fee', date: '2027-03-15', group: 'burrards-team-fees', saved: 50, needed: 300, trust: 'estimated' });
  const b1 = item({ key: 'lesson-a@2027-05-01', id: 'lesson-a', label: 'Lesson A', date: '2027-05-01', group: 'synthetic-lessons', groupLabel: 'Synthetic lessons', saved: 20, needed: 40, trust: 'calculated' });
  const b3 = item({ key: 'lesson-c@2027-05-15', id: 'lesson-c', label: 'Lesson C', date: '2027-05-15', group: 'synthetic-lessons', groupLabel: 'Synthetic lessons', saved: 5, needed: null, neededRange: { min: 10, max: 12 }, trust: 'estimated' });
  const b2 = item({ key: 'lesson-b@2027-05-08', id: 'lesson-b', label: 'Lesson B', date: '2027-05-08', group: 'synthetic-lessons', groupLabel: 'Synthetic lessons', saved: null, needed: null, neededRange: { min: 30, max: 45 }, trust: 'unknown', reason: 'Point requirement or evidence not established.' });
  const c1 = item({ key: 'solo-fee@2027-06-01', id: 'solo-fee', label: 'Solo fee', date: '2027-06-01', saved: 10, needed: 10, trust: 'calculated' });
  return {
    source: 'Forecast.savingsDailyFunding', asOf: AS_OF, currency: 'CAD',
    actionPermission: 'not-granted', moneyMovementPermission: 'not-granted', status: 'ready',
    allocationDescription: 'Current observed stock allocated chronologically from one combined savings pot.',
    stock: { status: 'ready', amount: 900, trust: 'calculated', asOf: AS_OF },
    backing: { status: 'ready', reason: null, trust: 'calculated',
      pools: [{ id: 'combined-savings', accountId: 'synthetic-reserve', label: 'Synthetic reserve', observedCash: 900, observedAsOf: AS_OF, deficit: 0 }],
      items: [a1, a2, a3, b1, b3, c1], unallocated: 0 },
    unresolved: [b2],
    rows: [
      { key: 'group:burrards-team-fees', label: 'North instalment 1', poolId: 'combined-savings',
        members: [a1.key, a2.key, a3.key], saved: 150, needed: 800, trust: 'calculated',
        savedTrust: 'calculated', neededTrust: 'calculated', thisPeriod: 120, thisPeriodTrust: 'calculated',
        remainingThisPeriod: 60, remainingThisPeriodTrust: 'calculated' },
      { key: 'group:synthetic-lessons', label: 'Lesson A', poolId: 'combined-savings',
        members: [b1.key, b2.key, b3.key], saved: null, needed: null, neededRange: { min: 80, max: 97 },
        trust: 'unknown', savedTrust: 'unknown', neededTrust: 'unknown',
        thisPeriod: 10, thisPeriodTrust: 'calculated', remainingThisPeriod: 10, remainingThisPeriodTrust: 'calculated' },
      { key: 'commitment:solo-fee', label: 'Solo fee', poolId: 'combined-savings',
        members: [c1.key], saved: 10, needed: 10, trust: 'calculated',
        savedTrust: 'calculated', neededTrust: 'calculated', thisPeriod: 0, thisPeriodTrust: 'calculated',
        remainingThisPeriod: 0, remainingThisPeriodTrust: 'calculated' },
    ],
    period: { status: 'ready', basis: 'operating-surplus-before-proposals', start: START, end: END,
      entitlement: 300, transferred: 0, nativePeriodSurplus: 300, alreadySavedIncome: 0,
      remainingEntitlement: 300, availableNow: 200, proposal: 100, unassigned: 20,
      trust: 'calculated', actualSaved: null,
      allocations: [{ id: a1.key, amount: 60 }],
      cycleAllocations: [{ id: a1.key, amount: 70 }, { id: a3.key, amount: 50 }, { id: b1.key, amount: 10 }] },
    periodViews: [{ id: periodView.id, start: START, end: END, role: 'current' }],
  };
}

// Identity failure modes: a member key listed twice in the row, a member key
// backed by two published items, a member key with no published item, and a
// member named by two published allocations. None may be guessed, summed or
// defaulted; the group-level published values stand.
function edgePacket() {
  const dup1 = item({ key: 'dup-item@2027-08-01', id: 'dup-item', label: 'Dup one', date: '2027-08-01', group: 'edge', saved: 1, needed: 2, trust: 'calculated' });
  const dup2 = item({ key: 'dup-item@2027-08-01', id: 'dup-item', label: 'Dup two', date: '2027-08-01', group: 'edge', saved: 3, needed: 4, trust: 'calculated' });
  const ok = item({ key: 'ok-item@2027-08-02', id: 'ok-item', label: 'OK item', date: '2027-08-02', group: 'edge', saved: 7, needed: 9, trust: 'calculated' });
  const packet = mainPacket();
  packet.backing = { ...packet.backing, items: [dup1, dup2, ok] };
  packet.unresolved = [];
  packet.rows = [{ key: 'group:edge', label: 'Edge group', poolId: 'combined-savings',
    members: ['dup-item@2027-08-01', 'ok-item@2027-08-02', 'ghost-item@2027-08-03', 'ok-item@2027-08-02'],
    saved: 7, needed: 9, trust: 'calculated', savedTrust: 'calculated', neededTrust: 'calculated',
    thisPeriod: 7, thisPeriodTrust: 'calculated', remainingThisPeriod: 7, remainingThisPeriodTrust: 'calculated' }];
  packet.period = { ...packet.period, allocations: [{ id: ok.key, amount: 7 }],
    cycleAllocations: [{ id: ok.key, amount: 3 }, { id: ok.key, amount: 4 }] };
  return packet;
}

const memberBlocks = (html, hook) => {
  const blocks = {};
  for (const segment of html.split(`data-${hook}="`)) {
    const match = segment.match(/^([^"]+)">/);
    if (match) blocks[match[1]] = segment.split('</li>')[0];
  }
  return blocks;
};
const figure = (block, hook) => block.split(`${hook}>`)[1].split('<small>')[0];
const amounts = text => [...text.replace(/<[^>]*>/g, '').matchAll(/\$([\d,]+\.\d{2})/g)].map(m => Number(m[1]));

function checkSheet(packet, label) {
  ctx.src = { plan: {}, debts: [], asOf: AS_OF, advice: { savingsFunding: packet, payPeriodViews: [periodView], savingsInventory: null } };
  const sealed = vm.runInContext('budgetDailySavingsFor(src)', ctx);
  assert.equal(sealed.status, 'ready', label + ': fixture passes the publication gate');
  const before = JSON.stringify(packet);
  const html = vm.runInContext('budgetDailySavingsHtml(budgetDailySavingsFor(src), "", null, { asOf: src.asOf })', ctx);
  assert.equal(JSON.stringify(packet), before, label + ': renderer does not alter the publication');
  return html;
}

function checkTile(packet, label) {
  ctx.src = { plan: {}, debts: [], asOf: AS_OF, advice: { savingsFunding: packet, payPeriodViews: [periodView], savingsInventory: null } };
  ctx.period = periodView;
  const before = JSON.stringify(packet);
  const html = vm.runInContext('budgetSavingsGoalsHtml(src, period, null)', ctx);
  assert.equal(JSON.stringify(packet), before, label + ': tile renderer does not alter the publication');
  return html;
}

function checkInventory(packet, label) {
  const before = JSON.stringify(packet);
  ctx.packetArg = packet; ctx.invContext = { asOf: AS_OF, advice: { payPeriodViews: [periodView] } };
  const html = vm.runInContext('SavingsInventory.html(packetArg, invContext)', ctx);
  assert.equal(JSON.stringify(packet), before, label + ': inventory renderer does not alter the publication');
  return html;
}

// ---- Main packet: Budget sheet ----
{
  const html = checkSheet(mainPacket(), 'sheet');
  const header = html.split('data-budget-savings-total-goal="group:burrards-team-fees"')[1].split('<ul class="budget-savings-members">')[0];
  assert.match(header, /Burrards team fees/, 'sheet: presentation title replaces the first member name');
  assert.equal(figure(header, 'data-budget-savings-total-saved').includes('150.00'), true, 'sheet: group saved stays the published row value');
  assert.equal(figure(header, 'data-budget-savings-total-needed').includes('800.00'), true, 'sheet: group needed stays the published row value');
  assert.equal(figure(header, 'data-budget-savings-proposed').includes('120.00'), true, 'sheet: group this-period stays the published row value');

  const members = memberBlocks(html, 'budget-savings-member');
  assert.deepEqual(Object.keys(members), ['north-fee-1@2027-03-01', 'north-fee-2@2027-04-01', 'south-fee@2027-03-15',
    'lesson-a@2027-05-01', 'lesson-b@2027-05-08', 'lesson-c@2027-05-15'], 'sheet: every grouped member prints once, in published order');
  const a1 = members['north-fee-1@2027-03-01'], a2 = members['north-fee-2@2027-04-01'], a3 = members['south-fee@2027-03-15'];
  assert.match(a1, /North instalment 1/); assert.match(a1, /Mar 1/, 'sheet: member keeps its own published date');
  assert.equal(figure(a1, 'data-budget-savings-member-saved').includes('100.00'), true);
  assert.equal(figure(a1, 'data-budget-savings-member-needed').includes('250.00'), true);
  assert.equal(figure(a1, 'data-budget-savings-member-proposed').includes('70.00'), true, 'sheet: member this-period is the published allocation');
  assert.equal(figure(a2, 'data-budget-savings-member-saved').includes('0.00'), true, 'sheet: genuine zero saved prints as zero');
  assert.doesNotMatch(figure(a2, 'data-budget-savings-member-saved'), /Unavailable/, 'sheet: genuine zero is not withheld');
  assert.match(figure(a2, 'data-budget-savings-member-proposed'), /Unavailable/, 'sheet: a member with no published allocation stays unavailable, never zero');
  assert.match(a3, /South team fee/);
  assert.match(figure(a3, 'data-budget-savings-member-saved'), /\$50\.00/);
  assert.doesNotMatch(a3, /≈|estimated/i, 'sheet: member figures have no trust qualifier');
  assert.equal(figure(a3, 'data-budget-savings-member-proposed').includes('50.00'), true);
  const printed = [a1, a2, a3].flatMap(block => amounts(figure(block, 'data-budget-savings-member-proposed')));
  assert.equal(printed.reduce((sum, n) => sum + n, 0), 120, 'sheet: printed member allocations reconcile exactly to the published group this-period — no double counting, none invented');

  const b2 = members['lesson-b@2027-05-08'], b3 = members['lesson-c@2027-05-15'];
  assert.match(b2, /Lesson B/, 'sheet: unknown-trust withheld member is still named');
  assert.match(figure(b2, 'data-budget-savings-member-saved'), /Unavailable/, 'sheet: unknown-trust member saved is unavailable');
  assert.match(figure(b2, 'data-budget-savings-member-needed'), /Unavailable/, 'sheet: unknown-trust member need is unavailable');
  assert.doesNotMatch(figure(b2, 'data-budget-savings-member-saved'), /0\.00/, 'sheet: unknown never becomes $0');
  assert.equal(figure(b3, 'data-budget-savings-member-saved').includes('5.00'), true);
  assert.equal(figure(b3, 'data-budget-savings-member-needed').includes('10.00'), true, 'sheet: estimated range minimum prints');
  assert.equal(figure(b3, 'data-budget-savings-member-needed').includes('12.00'), true, 'sheet: estimated range maximum prints');

  const lessonsHeader = html.split('data-budget-savings-total-goal="group:synthetic-lessons"')[1].split('<ul class="budget-savings-members">')[0];
  assert.match(lessonsHeader, /Synthetic lessons/, 'sheet: published groupLabel titles the group');

  const solo = html.split('data-budget-savings-total-goal="commitment:solo-fee"')[1].split('</li>')[0];
  assert.match(solo, /Solo fee/); assert.doesNotMatch(solo, /data-budget-savings-member/, 'sheet: single-member row renders exactly as before');
  assert.doesNotMatch(html, /North settled fee/, 'sheet: settled member is absent from the publication and never reconstructed');
}

// ---- Main packet: Budget tile ----
{
  const html = checkTile(mainPacket(), 'tile');
  const group = html.split('data-budget-savings-goal="group:burrards-team-fees"')[1].split('</li>')[0];
  assert.match(group, /<strong>Burrards team fees<\/strong>/, 'tile: presentation title replaces the first member name');
  assert.match(group, /150\.00/); assert.match(group, /800\.00/); assert.match(group, /120\.00/, 'tile: group figures stay the published row values');
  const members = memberBlocks(group, 'budget-savings-member');
  assert.deepEqual(Object.keys(members), ['north-fee-1@2027-03-01', 'north-fee-2@2027-04-01', 'south-fee@2027-03-15'], 'tile: the same members print as on the sheet');
  assert.equal(figure(members['north-fee-2@2027-04-01'], 'data-budget-savings-member-saved').includes('0.00'), true, 'tile: genuine zero prints as zero');
  assert.match(figure(members['north-fee-2@2027-04-01'], 'data-budget-savings-member-proposed'), /Unavailable/, 'tile: unpublished allocation stays unavailable');
  const solo = html.split('data-budget-savings-goal="commitment:solo-fee"')[1].split('</li>')[0];
  assert.doesNotMatch(solo, /data-budget-savings-member/, 'tile: single-member row renders exactly as before');
  assert.doesNotMatch(html, /North settled fee/, 'tile: settled member never reconstructed');
}

// ---- Main packet: SavingsInventory ----
{
  const html = checkInventory(mainPacket(), 'inventory');
  const group = html.split('data-savings-goal="group:burrards-team-fees"')[1].split('</article>')[0];
  assert.match(group, /<h3>Burrards team fees<\/h3>/, 'inventory: presentation title replaces the first member name');
  assert.match(group, /\$150\.00/); assert.match(group, /\$800\.00/); assert.match(group, /\$120\.00/, 'inventory: group figures stay the published row values');
  const members = memberBlocks(group, 'savings-member');
  assert.deepEqual(Object.keys(members), ['north-fee-1@2027-03-01', 'north-fee-2@2027-04-01', 'south-fee@2027-03-15'], 'inventory: the same members print as on the Budget surfaces');
  const backed = block => block.split('data-savings-member-backed>')[1].split('</div>')[0];
  assert.match(backed(members['north-fee-1@2027-03-01']), /\$100\.00/);
  assert.match(backed(members['north-fee-2@2027-04-01']), /\$0\.00/, 'inventory: genuine zero prints as zero');
  assert.match(backed(members['south-fee@2027-03-15']), /<dd>\$50\.00<\/dd>/, 'inventory: member backing prints its published amount without a qualifier');

  const lessons = html.split('data-savings-goal="group:synthetic-lessons"')[1].split('</article>')[0];
  assert.match(lessons, /<h3>Synthetic lessons<\/h3>/, 'inventory: published groupLabel titles the group');
  const lessonMembers = memberBlocks(lessons, 'savings-member');
  assert.match(backed(lessonMembers['lesson-b@2027-05-08']), /Unknown/, 'inventory: unknown-trust member backed is unknown');
  assert.doesNotMatch(backed(lessonMembers['lesson-b@2027-05-08']), /\$0\.00/, 'inventory: unknown never becomes $0');
  const cNeeded = lessonMembers['lesson-c@2027-05-15'].split('data-savings-member-needed>')[1].split('</div>')[0];
  assert.match(cNeeded, /\$10\.00/); assert.match(cNeeded, /\$12\.00/, 'inventory: estimated range prints both published ends');
  const solo = html.split('data-savings-goal="commitment:solo-fee"')[1].split('</article>')[0];
  assert.doesNotMatch(solo, /data-savings-member/, 'inventory: single-member row renders exactly as before');
  assert.doesNotMatch(html, /North settled fee/, 'inventory: settled member never reconstructed');
}

// ---- Edge packet: identity failures fail closed on every surface ----
for (const [label, render] of [['sheet', checkSheet], ['tile', checkTile], ['inventory', checkInventory]]) {
  const html = render(edgePacket(), 'edge ' + label);
  const members = memberBlocks(html, label === 'inventory' ? 'savings-member' : 'budget-savings-member');
  assert.deepEqual(Object.keys(members), ['dup-item@2027-08-01', 'ok-item@2027-08-02', 'ghost-item@2027-08-03'],
    label + ': duplicate member key prints once; every listed member is accounted for');
  assert.match(members['dup-item@2027-08-01'], /Member name unavailable/, label + ': duplicate published item identity is not guessed');
  assert.match(members['ghost-item@2027-08-03'], /Member name unavailable/, label + ': missing published item is not invented');
  assert.match(members['ok-item@2027-08-02'], /OK item/, label + ': the uniquely published member still prints');
  if (label !== 'inventory') {
    assert.match(figure(members['dup-item@2027-08-01'], 'data-budget-savings-member-saved'), /Unavailable/, label + ': ambiguous member figures stay unavailable');
    assert.match(figure(members['ok-item@2027-08-02'], 'data-budget-savings-member-proposed'), /Unavailable/,
      label + ': duplicate allocations are never summed or first-wins');
  }
}

// ---- Native publications: real Forecast packets over invented inputs ----
// The fixture world runs the full Forecast pipeline (recommend) on invented
// ledgers, so the packets below are the genuine published shapes: current
// allocations keyed by occurrence key, projected (next/future) allocations
// keyed by bare requirement id, and historical packets whose rows withhold
// needed (null / neededTrust unknown) while backing.items retain the current
// requirement metadata. Expected figures are read from the packets
// themselves, never recomputed.
const NAT_AS_OF = '2026-10-07';
function nativeWorld() {
  const input = chronoFx.policy(contractFx.advance(contractFx.fixture(), NAT_AS_OF));
  input.plan.commitments.push({ id: 'third', label: 'Invented third club cost', group: 'club',
    date: '2026-11-04', amount: 90, confidence: 'confirmed', adjustable: false, sinkingFund: true });
  const advice = F.recommend(input.plan, input.asOf, { ...input.opts, weeklyVariable: 40, debts: [] });
  return { input, advice };
}
function nativeSheet(advice, plan, periodId) {
  ctx.src = { plan, debts: [], asOf: NAT_AS_OF, advice };
  ctx.selId = periodId || null;
  return vm.runInContext('budgetDailySavingsHtml(budgetDailySavingsFor(src, selId), "", null, { asOf: src.asOf })', ctx);
}
function nativeTile(advice, plan, view) {
  ctx.src = { plan, debts: [], asOf: NAT_AS_OF, advice };
  ctx.period = view;
  return vm.runInContext('budgetSavingsGoalsHtml(src, period, null)', ctx);
}
function nativeInventory(advice, periodId) {
  ctx.packetArg = advice.savingsFunding;
  ctx.invContext = { asOf: NAT_AS_OF, advice, periodId: periodId || null };
  return vm.runInContext('SavingsInventory.html(packetArg, invContext)', ctx);
}
const planFigures = block => ({
  saved: figure(block, 'data-budget-savings-member-saved'),
  needed: figure(block, 'data-budget-savings-member-needed'),
  proposed: figure(block, 'data-budget-savings-member-proposed') });
const invFigures = block => ({
  saved: block.split('data-savings-member-backed>')[1].split('</div>')[0],
  needed: block.split('data-savings-member-needed>')[1].split('</div>')[0],
  proposed: block.split('data-savings-member-period>')[1].split('</div>')[0] });

{
  const { input, advice } = nativeWorld();
  const sf = advice.savingsFunding;
  assert.equal(sf.status, 'ready', 'native: invented world yields a ready savings publication');
  const groupRow = sf.rows.find(row => row.key === 'group:club');
  assert.deepEqual(groupRow.members, ['near@2026-10-21', 'far@2026-10-28', 'third@2026-11-04'],
    'native: the club group publishes three members');
  const [near, far, third] = groupRow.members;
  const currentView = advice.payPeriodViews.find(view => view.timelineRole === 'current');
  const pastView = advice.payPeriodViews.filter(view => view.timelineRole === 'past').at(-1);
  const nextView = advice.payPeriodViews.find(view => view.timelineRole === 'next');
  const surfaces = (periodId, view) => [
    ['sheet', nativeSheet(advice, input.plan, periodId), 'budget-savings-member', planFigures],
    ['tile', nativeTile(advice, input.plan, view), 'budget-savings-member', planFigures],
    ['inventory', nativeInventory(advice, periodId), 'savings-member', invFigures]];

  // Current packet: allocations are named by occurrence key.
  assert.deepEqual(sf.period.cycleAllocations.map(part => part.id), [far],
    'native current: the published allocation uses the occurrence key');
  for (const [label, html, hook, figures] of surfaces(null, currentView)) {
    const members = memberBlocks(html, hook);
    assert.deepEqual(Object.keys(members).filter(key => groupRow.members.includes(key)), groupRow.members,
      `native current ${label}: all three members print`);
    assert.equal(figures(members[far]).proposed.includes('80.00'), true,
      `native current ${label}: the occurrence-key allocation prints for its member`);
    assert.match(figures(members[near]).proposed, /Unavailable|Unknown/, `native current ${label}: unpublished member allocation stays unavailable`);
    assert.match(figures(members[third]).proposed, /Unavailable|Unknown/, `native current ${label}: unpublished member allocation stays unavailable`);
    assert.equal(figures(members[near]).needed.includes('60.00'), true, `native current ${label}: member needed prints`);
    assert.equal(figures(members[far]).needed.includes('170.00'), true, `native current ${label}: member needed prints`);
    assert.equal(figures(members[third]).needed.includes('90.00'), true, `native current ${label}: member needed prints`);
  }

  // Next packet: allocations are named by bare requirement id (Finding 2).
  // One authority (2026-11-19): the projected top-up reprints the Budget's own
  // next-period funding, which closes at 80 (funding gap) and funds only far;
  // the cash-walk schedule's 135 + 10 = 145 no longer publishes here.
  const nextPacket = F.savingsFundingPublication(sf, { asOf: NAT_AS_OF, advice, periodId: nextView.id });
  assert.equal(nextPacket.period.kind, 'projected', 'native next: projected packet');
  assert.deepEqual(nextPacket.period.cycleAllocations.map(part => part.id), ['far'],
    'native next: published allocations use bare requirement ids');
  assert.equal(nextPacket.period.proposal, nextView.plannedCostFunding.contribution,
    'native next: the proposal is the Budget period funding');
  const nextRow = nextPacket.rows.find(row => row.key === 'group:club');
  assert.equal(nextRow.thisPeriod, 80, 'native next: Forecast sums the bare-id allocations into the row');
  for (const [label, html, hook, figures] of surfaces(nextView.id, nextView)) {
    // Owner direction 2026-10-14 (payday sweep) supersedes the retention
    // outcome pinned here before (closing stock 25): the current-tail 80
    // sweeps in on 2026-10-16 and the native 60/24/170 costs are consumed
    // once, leaving the pot signed -55 at this close
    // (11900 + 8000 - 6000 - 2400 - 17000 = -5500). A negative closing pot
    // is a protected deficit: the close withholds stock and member figures
    // on every surface, and later closes recover as further surpluses land
    // (the 2026-11-13 close publishes 15 with every cost paid).
    // The deadline-minimum packet above is unchanged.
    assert.equal(nextPacket.forecastClosing.status, 'unavailable');
    assert.equal(nextPacket.forecastClosing.stock, null);
    assert.equal(nextPacket.forecastClosing.diagnostics.signedSavings, -55);
    assert.deepEqual(nextPacket.forecastClosing.items, []);
    assert.match(html, /Funding gap on 2026-10-29: \$55\.00|Named savings unavailable|Unavailable/);
    assert.doesNotMatch(html, /25\.00/);
    assert.doesNotMatch(html, />Forecast<|budget-v3-est|If eligible surplus|this scenario/);
    assert.doesNotMatch(html, /Invented first club cost|Invented second club cost|Invented third club cost/);
  }

  // Historical packet: rows withhold needed while items retain it (Finding 1).
  const pastPacket = F.savingsFundingPublication(sf, { asOf: NAT_AS_OF, advice, periodId: pastView.id });
  assert.equal(pastPacket.period.kind, 'historical', 'native past: historical packet');
  const pastRow = pastPacket.rows.find(row => row.key === 'group:club');
  assert.equal(pastRow.needed, null, 'native past: the row withholds needed');
  assert.equal(pastRow.neededTrust, 'unknown', 'native past: the row withholds needed trust');
  assert.equal(pastPacket.backing.items.find(entry => entry.key === near).needed, 60,
    'native past: backing items retain the current requirement (the leak precondition)');
  for (const [label, html, hook, figures] of surfaces(pastView.id, pastView)) {
    const members = memberBlocks(html, hook);
    assert.deepEqual(Object.keys(members).filter(key => groupRow.members.includes(key)), groupRow.members,
      `native past ${label}: the published member roster still prints`);
    for (const key of groupRow.members) {
      const memberFigures = figures(members[key]);
      assert.match(members[key], /Invented (first|second|third) club cost/, `native past ${label}: member name prints`);
      assert.match(memberFigures.saved, /Unavailable|Unknown/, `native past ${label}: member saved withheld like the row`);
      assert.match(memberFigures.needed, /Unavailable|Unknown/, `native past ${label}: member needed withheld like the row`);
      assert.match(memberFigures.proposed, /Unavailable|Unknown/, `native past ${label}: member this-period withheld like the row`);
      assert.doesNotMatch(members[key], /\b(60|170|90)\.00/, `native past ${label}: no current requirement figure leaks under the historical group`);
    }
  }
}

// ---- Historical view packet transcribed from Forecast's own construction ----
// Forecast builds historical view packets by mapping rows to needed=null /
// neededTrust='unknown', nulling backing items' saved, and passing
// unresolved through verbatim — so a withheld member can still carry a
// current saved amount. Member figures must withhold identically.
function viewWorld(viewPacket, nativeView) {
  const pub = mainPacket();
  pub.periodViews = [{ id: nativeView.id, start: nativeView.start, end: nativeView.end, role: nativeView.timelineRole, packet: viewPacket }];
  return { pub, nativeView };
}
function viewSheet(pub, nativeView) {
  ctx.src = { plan: {}, debts: [], asOf: AS_OF, advice: { savingsFunding: pub, payPeriodViews: [periodView, nativeView], savingsInventory: null } };
  ctx.selId = nativeView.id;
  return vm.runInContext('budgetDailySavingsHtml(budgetDailySavingsFor(src, selId), "", null, { asOf: src.asOf })', ctx);
}
function viewTile(pub, nativeView) {
  ctx.src = { plan: {}, debts: [], asOf: AS_OF, advice: { savingsFunding: pub, payPeriodViews: [periodView, nativeView], savingsInventory: null } };
  ctx.period = nativeView;
  return vm.runInContext('budgetSavingsGoalsHtml(src, period, null)', ctx);
}
function viewInventory(pub, nativeView) {
  ctx.packetArg = pub;
  ctx.invContext = { asOf: AS_OF, advice: { payPeriodViews: [periodView, nativeView] }, periodId: nativeView.id };
  return vm.runInContext('SavingsInventory.html(packetArg, invContext)', ctx);
}
{
  const h1 = item({ key: 'hist-a@2027-02-01', id: 'hist-a', label: 'Hist A', date: '2027-02-01', group: 'hist', saved: null, needed: 60, trust: 'calculated' });
  const h2 = item({ key: 'hist-b@2027-02-08', id: 'hist-b', label: 'Hist B', date: '2027-02-08', group: 'hist', saved: 25, needed: 40, trust: 'calculated', reason: 'Point requirement or evidence not established.' });
  const viewPacket = { source: 'Forecast.savingsDailyFunding', asOf: AS_OF, currency: 'CAD',
    actionPermission: 'not-granted', moneyMovementPermission: 'not-granted', status: 'unavailable',
    allocationDescription: 'Historical saving evidence is unavailable. Current observed savings are not substituted into this earlier period.',
    stock: { status: 'unavailable', amount: null },
    backing: { status: 'unavailable', reason: null, trust: 'unknown', pools: [], items: [h1], unallocated: null },
    unresolved: [h2],
    rows: [{ key: 'group:hist', label: 'Hist A', poolId: 'combined-savings', members: [h1.key, h2.key],
      saved: null, needed: null, neededRange: null, trust: 'unknown', savedTrust: 'unknown', neededTrust: 'unknown',
      thisPeriod: null, thisPeriodTrust: 'unknown', remainingThisPeriod: null, remainingThisPeriodTrust: 'unknown' }],
    period: { status: 'unavailable', kind: 'historical', basis: 'operating-surplus-before-proposals',
      start: '2026-12-19', end: '2027-01-01', trust: 'unknown', proposal: null, actualSaved: null,
      allocations: [], cycleAllocations: [], reason: 'Historical saved evidence is unknown.' } };
  const { pub, nativeView } = viewWorld(viewPacket, { id: 'period-past', timelineRole: 'past', start: '2026-12-19', end: '2027-01-01' });
  for (const [label, render, hook, figures] of [
    ['sheet', viewSheet, 'budget-savings-member', planFigures],
    ['tile', viewTile, 'budget-savings-member', planFigures],
    ['inventory', viewInventory, 'savings-member', invFigures]]) {
    const members = memberBlocks(render(pub, nativeView), hook);
    assert.deepEqual(Object.keys(members).filter(key => [h1.key, h2.key].includes(key)), [h1.key, h2.key],
      `historical view ${label}: both members print as roster`);
    for (const key of [h1.key, h2.key]) {
      const memberFigures = figures(members[key]);
      assert.match(memberFigures.saved, /Unavailable|Unknown/, `historical view ${label}: member saved withheld`);
      assert.match(memberFigures.needed, /Unavailable|Unknown/, `historical view ${label}: member needed withheld`);
      assert.match(memberFigures.proposed, /Unavailable|Unknown/, `historical view ${label}: member this-period withheld`);
      assert.doesNotMatch(members[key], /\b(60|40|25)\.00/, `historical view ${label}: the withheld member's current saved/needed never print`);
    }
  }
}

// ---- Projected identity ambiguity: no dual-alias fallback, no guessing ----
// Projected packets name allocations by bare requirement id. Two published
// occurrences of one recurring requirement share that bare id, so a single
// allocation naming it cannot be attributed to either member; duplicate
// allocation entries for one id are likewise unattributable; and an
// occurrence-key allocation inside a projected packet (or a bare-id
// allocation inside a current packet) is the wrong published form and must
// not be picked up through the other alias.
function projectedWorld(members, allocations, rowThisPeriod) {
  const viewPacket = { source: 'Forecast.savingsDailyFunding', asOf: AS_OF, currency: 'CAD',
    actionPermission: 'not-granted', moneyMovementPermission: 'not-granted', status: 'ready',
    allocationDescription: 'Projected top-ups from this same opening.',
    stock: { status: 'unavailable', amount: null },
    backing: { status: 'unavailable', reason: null, trust: 'unknown', pools: [],
      items: members.map(entry => ({ ...entry, saved: null })), unallocated: null },
    unresolved: [],
    rows: [{ key: 'group:proj', label: members[0].label, poolId: 'combined-savings', members: members.map(entry => entry.key),
      saved: null, savedTrust: 'unknown', needed: 100, neededRange: null, trust: 'calculated', neededTrust: 'calculated',
      thisPeriod: rowThisPeriod, thisPeriodTrust: 'estimated', remainingThisPeriod: null, remainingThisPeriodTrust: 'unknown' }],
    period: { status: 'ready', kind: 'projected', basis: 'operating-surplus-before-proposals',
      start: '2027-01-16', end: '2027-01-29', trust: 'estimated', proposal: rowThisPeriod, actualSaved: null,
      allocations, cycleAllocations: allocations, reason: null } };
  return viewWorld(viewPacket, { id: 'period-next', timelineRole: 'next', start: '2027-01-16', end: '2027-01-29' });
}
for (const [label, render, hook, figures] of [
  ['sheet', viewSheet, 'budget-savings-member', planFigures],
  ['tile', viewTile, 'budget-savings-member', planFigures],
  ['inventory', viewInventory, 'savings-member', invFigures]]) {
  { // One bare id, two published occurrences: ambiguous, both fail closed.
    const r1 = item({ key: 'recur-fee@2027-03-01', id: 'recur-fee', label: 'Recur one', date: '2027-03-01', group: 'proj', saved: 0, needed: 50, trust: 'calculated' });
    const r2 = item({ key: 'recur-fee@2027-04-01', id: 'recur-fee', label: 'Recur two', date: '2027-04-01', group: 'proj', saved: 0, needed: 50, trust: 'calculated' });
    const { pub, nativeView } = projectedWorld([r1, r2], [{ id: 'recur-fee', amount: 25 }], 25);
    const members = memberBlocks(render(pub, nativeView), hook);
    assert.match(figures(members[r1.key]).proposed, /Unavailable|Unknown/, `projected ambiguous ${label}: first occurrence cannot claim the shared bare-id allocation`);
    assert.match(figures(members[r2.key]).proposed, /Unavailable|Unknown/, `projected ambiguous ${label}: second occurrence cannot claim it either`);
  }
  { // Duplicate allocation entries naming one unique member: never summed, never first-wins.
    const s1 = item({ key: 'solo-fee@2027-03-01', id: 'solo-fee', label: 'Solo one', date: '2027-03-01', group: 'proj', saved: 0, needed: 50, trust: 'calculated' });
    const s2 = item({ key: 'solo-two@2027-03-08', id: 'solo-two', label: 'Solo two', date: '2027-03-08', group: 'proj', saved: 0, needed: 50, trust: 'calculated' });
    const { pub, nativeView } = projectedWorld([s1, s2], [{ id: 'solo-fee', amount: 10 }, { id: 'solo-fee', amount: 15 }], 25);
    const members = memberBlocks(render(pub, nativeView), hook);
    assert.match(figures(members[s1.key]).proposed, /Unavailable|Unknown/, `projected duplicate allocations ${label}: not summed, not first-wins`);
    assert.doesNotMatch(figures(members[s1.key]).proposed, /25\.00|10\.00|15\.00/, `projected duplicate allocations ${label}: no candidate amount prints`);
  }
  { // Occurrence-key allocation inside a projected packet: wrong form, no alias fallback.
    const k1 = item({ key: 'keyed-fee@2027-03-01', id: 'keyed-fee', label: 'Keyed one', date: '2027-03-01', group: 'proj', saved: 0, needed: 50, trust: 'calculated' });
    const k2 = item({ key: 'keyed-two@2027-03-08', id: 'keyed-two', label: 'Keyed two', date: '2027-03-08', group: 'proj', saved: 0, needed: 50, trust: 'calculated' });
    const { pub, nativeView } = projectedWorld([k1, k2], [{ id: 'keyed-fee@2027-03-01', amount: 33 }], 33);
    const members = memberBlocks(render(pub, nativeView), hook);
    assert.match(figures(members[k1.key]).proposed, /Unavailable|Unknown/, `projected wrong-form ${label}: occurrence keys are not consulted in projected packets`);
  }
}
{ // Bare-id allocation inside a current packet: wrong form, no alias fallback.
  const c1 = item({ key: 'bare-fee@2027-03-01', id: 'bare-fee', label: 'Bare one', date: '2027-03-01', group: 'cur', saved: 0, needed: 50, trust: 'calculated' });
  const c2 = item({ key: 'bare-two@2027-03-08', id: 'bare-two', label: 'Bare two', date: '2027-03-08', group: 'cur', saved: 0, needed: 50, trust: 'calculated' });
  const packet = mainPacket();
  packet.backing = { ...packet.backing, items: [c1, c2] };
  packet.unresolved = [];
  packet.rows = [{ key: 'group:cur', label: 'Bare one', poolId: 'combined-savings', members: [c1.key, c2.key],
    saved: 0, needed: 100, neededRange: null, trust: 'calculated', savedTrust: 'calculated', neededTrust: 'calculated',
    thisPeriod: 33, thisPeriodTrust: 'calculated', remainingThisPeriod: 33, remainingThisPeriodTrust: 'calculated' }];
  packet.period = { ...packet.period, allocations: [{ id: 'bare-fee', amount: 33 }], cycleAllocations: [{ id: 'bare-fee', amount: 33 }] };
  for (const [label, render, hook] of [['sheet', checkSheet, 'budget-savings-member'], ['tile', checkTile, 'budget-savings-member'], ['inventory', checkInventory, 'savings-member']]) {
    const members = memberBlocks(render(packet, 'current wrong-form ' + label), hook);
    const memberFigures = (hook === 'savings-member' ? invFigures : planFigures)(members[c1.key]);
    assert.match(memberFigures.proposed, /Unavailable|Unknown/, `current wrong-form ${label}: bare ids are not consulted in current packets`);
  }
}

// Cost facts are sealed, independently invented publications. Deliberately
// inconsistent group/member totals prove the consumer never rebuilds a group.
const costKnown = (amount, range = null) => ({ status: 'known', amount, range });
const costUnknown = (status = 'unavailable') => ({ status, amount: null, range: null });
const costFacts = (original, paid, unpaid, asOf = AS_OF) => ({ asOf,
  originalCost: original, confirmedLinkedPaid: paid, unpaidCost: unpaid });
const costValue = (html, name) => html.split(`data-savings-cost-${name}>`)[1]?.split('</dd>')[0];
function costPacket(facts = costFacts(costKnown(230), costKnown(25), costKnown(205))) {
  const packet = mainPacket();
  const near = item({ key: 'cost-a@2027-03-01', id: 'cost-a', label: 'Same invented fee',
    date: '2027-03-01', group: 'costs', saved: 35, needed: 35, trust: 'calculated',
    commitmentCost: costFacts(costKnown(60), costKnown(25), costKnown(35)) });
  const far = item({ key: 'cost-b@2027-04-01', id: 'cost-b', label: near.label,
    date: '2027-04-01', group: 'costs', saved: 60, needed: 170, trust: 'calculated',
    commitmentCost: costFacts(costKnown(170), costKnown(0), costKnown(170)) });
  packet.backing.items = [near, far]; packet.unresolved = [];
  packet.rows = [{ ...packet.rows[0], key: 'group:costs', label: near.label,
    members: [near.key, far.key], saved: 95, needed: 205, commitmentCost: facts }];
  return packet;
}
for (const [label, render, hook] of [['sheet', checkSheet, 'budget-savings-member'], ['inventory', checkInventory, 'savings-member']]) {
  const packet = costPacket(), html = render(packet, 'cost ' + label);
  assert.match(costValue(html, 'original'), /230\.00/, label + ': group original comes from group packet');
  assert.match(costValue(html, 'paid'), /25\.00/);
  assert.match(costValue(html, 'unpaid'), /205\.00/);
  assert.match(costValue(html, 'saved'), /95\.00/, label + ': independent saved stock');
  const members = memberBlocks(html, hook);
  assert.match(costValue(members[packet.rows[0].members[0]], 'original'), /60\.00/);
  assert.match(costValue(members[packet.rows[0].members[0]], 'unpaid'), /35\.00/);
  assert.match(costValue(members[packet.rows[0].members[1]], 'original'), /170\.00/);
  assert.match(costValue(members[packet.rows[0].members[1]], 'paid'), /0\.00/);
  assert.match(html, /Confirmed payment assignments/);
  assert.match(html, /Known means published, not bank-verified/);
  assert.match(html, /Unpaid cost is not additional savings needed/);

  // Single surviving member: no retired member is reconstructed or added.
  const retired = costPacket(costFacts(costKnown(170), costKnown(0), costKnown(170)));
  retired.backing.items.shift(); retired.rows[0].members.shift();
  const retiredHtml = render(retired, 'retired ' + label);
  assert.match(costValue(retiredHtml, 'original'), /170\.00/);
  assert.doesNotMatch(retiredHtml, /cost-a@|60\.00/);

  // Missing and duplicate native identities never borrow the same-label facts.
  for (const missing of [true, false]) {
    const bad = costPacket();
    if (missing) bad.backing.items.shift(); else bad.backing.items.push({ ...bad.backing.items[0] });
    const block = memberBlocks(render(bad, 'identity ' + label), hook)['cost-a@2027-03-01'];
    assert.doesNotMatch(block, /data-savings-cost-original>[\s\S]*?60\.00/);
  }
  const independent = costPacket(costFacts(costKnown(999), costKnown(3), costKnown(222)));
  assert.match(costValue(render(independent, 'verbatim ' + label), 'unpaid'), /222\.00/,
    'no subtraction or sum is used to repair a publication');
}
// The collapsed tile retains its incumbent values and typed funding-bar inputs.
{
  const html = checkTile(costPacket(), 'compact costs');
  const collapsed = html.split('<div data-budget-funding-savings hidden>')[0];
  assert.doesNotMatch(collapsed, /data-savings-cost-|Original cost|Confirmed payment assignments/);
  assert.match(collapsed, /data-budget-goal-saved-amount="95"/);
  assert.match(collapsed, /data-budget-goal-required-amount="205"/);
}
// Confirmed-intent inventory retains its distinct backing/intent semantics.
{
  ctx.manualCost = { status: 'ready', pools: [], goals: [{ key: 'commitment:invented', label: 'Invented manual goal',
    intent: 12, backed: 9, backedTrust: 'calculated', target: 35, targetTrust: 'calculated',
    commitmentCost: costFacts(costKnown(60), costKnown(25), costKnown(35)) }] };
  const html = vm.runInContext('SavingsInventory.html(manualCost)', ctx);
  assert.match(costValue(html, 'original'), /60\.00/);
  assert.match(costValue(html, 'unpaid'), /35\.00/);
  assert.match(costValue(html, 'saved'), /9\.00/);
}
// A historical wrapper must still withhold even if a retained item carries
// current cost facts. No opening date or actual amount may leak through it.
{
  const past = costPacket();
  past.status = past.backing.status = past.period.status = 'unavailable';
  past.period.kind = 'historical'; past.period.proposal = null;
  for (const row of past.rows) Object.assign(row, { saved: null, savedTrust: 'unknown',
    needed: null, neededTrust: 'unknown', thisPeriod: null, thisPeriodTrust: 'unknown' });
  const { pub, nativeView } = viewWorld(past, { id: 'cost-past', timelineRole: 'past', start: START, end: END });
  for (const render of [viewSheet, viewInventory]) {
    const html = render(pub, nativeView);
    assert.doesNotMatch(html, /Cost facts as of|\$(230|205|95|60|35|170|25)\.00/);
    assert.match(costValue(html, 'original'), /Unknown/);
  }
}

console.log('PASS grouped savings members and attached cost facts: exact publications on sheet/inventory, compact tile and unchanged funding attributes');
