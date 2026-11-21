'use strict';
/* Stack Savings: the savings balance poured into the goals, nearest due first
 * (owner rule, Dale 2026-11-20: "Savings is stupid simple. It takes the grand
 * total of what I have in my savings account and it funds each savings item
 * in order. That's all there is to it.").
 *
 * The current and next pay periods publish stackSummary.savings; every other
 * period publishes null (no card).
 *   totals.balance      savingsFunding.stock.reportedStock.amount: both savings
 *                       pool accounts summed (the grand total);
 *   items[] (one per savingsFunding.rows row, in pour order)
 *     saved             the row's members' pour, min(needed, what is left);
 *     needed            the row's members' needed, summed;
 *     trust             the weakest of the balance's trust (current ->
 *                       calculated; dated or carried -> estimated) and the
 *                       members' need trust;
 *   totals.saved / needed  the rows summed; unallocated = what is left.
 * A withheld balance withholds every figure (null, never 0) and keeps every
 * goal's name: the card shows dashes, it is never hidden.
 *
 *   1. hand-derived invented worlds (figures input savings-live-ready: goals
 *      near 60 due 10-21, home 24 due 10-25, far 170 due 10-28; rows club =
 *      near + far, home): balance covers all; covers some; one goal partly
 *      saved and later ones 0; zero; a dated balance is estimated; a missing
 *      balance withholds every figure and keeps the names; the next period
 *      repeats the pour; no other period publishes a card;
 *   2. the pure pour on invented packets: equal due dates keep plan order; an
 *      unknown need stops the pour; rows that do not cover the items withhold;
 *      a negative balance withholds; a goal poured after an estimated need is
 *      estimated; a goal confirmed paid is left off; an unresolved goal stops
 *      the pour at the end;
 *   3. every period of the invented corpus: the pour invariants;
 *   4. every existing field is byte-equal without the new key;
 *   5. mutants are caught;
 *   6. the figures snapshot captures every figure and tag;
 *   7. the card pours the reported total as is (owner ruling, Dale
 *      2026-11-21), including where the Savings allocator holds its own
 *      Saved (a later Savings payment, an unpaid card charge for a goal, one
 *      transfer in both balances).
 *
 * Invented data only. `node test/test-stack-savings-summary.js` */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const H = require('./acceptance/harness.js');
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
// Each copy exposes its own stackSavings, so the pure pour can be called on an invented packet.
const EXPOSE = ['  function stackSavings(view, result) {',
  '  globalThis.__stackSavings = (view, result) => stackSavings(view, result);\n  function stackSavings(view, result) {'];
function copy(text, name) {
  const F = compile(replaceOnce(text, ...EXPOSE, 'expose ' + name), name);
  const pour = globalThis.__stackSavings;
  delete globalThis.__stackSavings;
  return { F, pour };
}
const mutant = (from, to, label) => copy(replaceOnce(SOURCE, from, to, label), label.replace(/\W+/g, '-'));
const ORDER = '        return da < db ? -1 : da > db ? 1 : a.rank - b.rank;';
const shipped = copy(SOURCE, 'shipped');
const copies = {
  shipped,
  without: { F: compile(replaceOnce(SOURCE, ', savings: stackSavings(view, result) }', ' }', 'pass off'), 'without') },
  farthestFirst: mutant(ORDER, '        return da < db ? 1 : da > db ? -1 : a.rank - b.rank;', 'farthest first'),
  tiesReversed: mutant(ORDER, '        return da < db ? -1 : da > db ? 1 : b.rank - a.rank;', 'ties reversed'),
  noCap: mutant('      const take = Math.min(savingsFigureCents(item.needed), left);', '      const take = savingsFigureCents(item.needed);', 'no cap'),
  skipUnknown: mutant("      if (!known) { if (left !== null) reasons.push('pour-stopped-at-unknown-need'); left = null; poured.set(item && item.key, null); continue; }",
    '      if (!known) { poured.set(item && item.key, null); continue; }', 'skip unknown'),
  staleCalculated: mutant("    const fresh = { current: 'calculated', dated: 'estimated', carried: 'estimated' };",
    "    const fresh = { current: 'calculated', dated: 'calculated', carried: 'calculated' };", 'stale calculated'),
  noUnallocated: mutant('        unallocated: complete && left !== null ? left / 100 : null,', '        unallocated: null,', 'no unallocated'),
  oneAccount: mutant('    const stock = funding && funding.stock && funding.stock.reportedStock;',
    "    const first = funding && funding.stock && funding.stock.reportedStock;\n"
    + "    const stock = first && { ...first, amount: first.amount - 24 };", 'one account'),
  currentOnly: mutant("    if (role !== 'current' && role !== 'next') return null;", "    if (role !== 'current') return null;", 'current only'),
  ownTrustOnly: mutant('      running = stackWeakerTrust(running, item.trust);', '      running = stackWeakerTrust(balance.trust, item.trust);', 'own trust only'),
  paidKept: mutant("      ? funding.rows.filter(row => row && typeof row.key === 'string' && row.paymentStatus !== 'paid') : [];",
    "      ? funding.rows.filter(row => row && typeof row.key === 'string') : [];", 'paid kept'),
  noUnresolved: mutant("      ...(funding && Array.isArray(funding.unresolved) ? funding.unresolved : [])];", '];', 'no unresolved'),
  hiddenWhenWithheld: mutant('    return {\n      items: out,', '    if (balance.cents === null) return null;\n    return {\n      items: out,', 'hidden when withheld'),
};
const pour = shipped.pour;

const INPUTS = Snap.loadInventedInputs();
const input = id => INPUTS.find(x => x.id === id);
function run(F, inp, opts = {}) {
  const data = structuredClone(inp.doc.data);
  if (opts.observe) opts.observe(data.plan.savingsPoolObservation);
  return F.recommend(data.plan, F.addDays(data.meta.asOf, opts.shift || 0),
    Snap.pageOptions(data, inp.doc.periods == null ? null : structuredClone(inp.doc.periods)));
}
const byRole = (r, role) => r.payPeriodViews.filter(v => v.timelineRole === role);
const sav = v => v && v.stackSummary && v.stackSummary.savings;
const setBalance = (a, b, date) => o => {
  o.accounts[0].value = a; o.accounts[1].value = b;
  if (date) o.accounts.forEach(row => { row.evidenceDate = date; });
};
const world = (copyOf, observe) => sav(byRole(run(copyOf.F, input('savings-live-ready'), { observe }), 'current')[0]);
const pick = s => s && { items: s.items.map(x => [x.id, x.saved, x.needed, x.trust]),
  totals: [s.totals.balance, s.totals.saved, s.totals.needed, s.totals.unallocated, s.totals.trust] };
const same = (s, want) => JSON.stringify(pick(s)) === JSON.stringify(want);
const COVERS_SOME = { items: [['group:club', 95, 230, 'calculated'], ['yearly-bill:home-cost', 24, 24, 'calculated']], totals: [119, 119, 254, 0, 'calculated'] };

console.log('1. Hand-derived invented worlds');
{
  // As published: 95 + 24 = 119 across both accounts. near 60 (59 left), home 24 (35 left), far 35 of 170
  // -> club (near + far) 95 of 230, home 24 of 24, nothing left.
  const base = world(shipped);
  ok(same(base, COVERS_SOME), 'covers some: 119 poured near 60, home 24, far 35 -> club 95 / 230, home 24 / 24, nothing left', JSON.stringify(pick(base)));
  ok(base.items[0].id === 'group:club', 'rows are listed in pour order (club holds the nearest goal)');
  const all = world(shipped, setBalance(300, 0));
  ok(same(all, { items: [['group:club', 230, 230, 'calculated'], ['yearly-bill:home-cost', 24, 24, 'calculated']], totals: [300, 254, 254, 46, 'calculated'] }),
    'covers all: 300 fills every goal and leaves 46 unallocated', JSON.stringify(pick(all)));
  const some = world(shipped, setBalance(70, 0));
  ok(same(some, { items: [['group:club', 60, 230, 'calculated'], ['yearly-bill:home-cost', 10, 24, 'calculated']], totals: [70, 70, 254, 0, 'calculated'] }),
    'one goal partly saved, later ones 0: 70 -> near 60, home 10 of 24, far 0', JSON.stringify(pick(some)));
  const zero = world(shipped, setBalance(0, 0));
  ok(same(zero, { items: [['group:club', 0, 230, 'calculated'], ['yearly-bill:home-cost', 0, 24, 'calculated']], totals: [0, 0, 254, 0, 'calculated'] }),
    'a zero balance saves 0 in every goal (a published 0, not withheld)', JSON.stringify(pick(zero)));
  const dated = world(shipped, setBalance(95, 24, '2026-10-01'));
  ok(same(dated, { items: [['group:club', 95, 230, 'estimated'], ['yearly-bill:home-cost', 24, 24, 'estimated']], totals: [119, 119, 254, 0, 'estimated'] })
    && dated.totals.reasons.includes('balance-dated'), 'a balance dated before today is estimated, every figure with it', JSON.stringify(pick(dated)));
  const oneDated = world(shipped, o => { o.accounts[1].evidenceDate = '2026-10-01'; });
  ok(oneDated.totals.trust === 'estimated' && oneDated.items.every(x => x.trust === 'estimated'),
    'one of the two balances dated: the weaker tag wins (estimated)', JSON.stringify(pick(oneDated)));
  const missing = world(shipped, o => { o.accounts.pop(); });
  ok(missing.items.length === 2 && missing.items.every(x => x.label && x.saved === null && x.needed === null && x.trust === 'unavailable')
    && missing.totals.balance === null && missing.totals.saved === null && missing.totals.unallocated === null && missing.totals.trust === 'unavailable'
    && missing.totals.reasons.includes('balance-unavailable'),
    'regression: a withheld balance on the current period keeps every goal name, every figure a dash (never hidden)', JSON.stringify(missing));
  const r = run(shipped.F, input('savings-live-ready'));
  ok(JSON.stringify(sav(byRole(r, 'next')[0])) === JSON.stringify(sav(byRole(r, 'current')[0])), 'the next period repeats today\'s pour');
  const others = r.payPeriodViews.filter(v => !['current', 'next'].includes(v.timelineRole));
  ok(others.length > 2 && others.every(v => v.stackSummary && v.stackSummary.savings === null), `no other period publishes a card (${others.length} periods)`);
  for (const role of ['current', 'next']) {
    ok(!/future-period|past-period/.test(JSON.stringify(sav(byRole(r, role)[0]))), `the ${role} view carries no later- or past-period code`);
  }
  const none = sav(byRole(run(shipped.F, input('card-paid-clear')), 'current')[0]);
  ok(none && none.items.length === 0 && none.totals.saved === null && none.totals.reasons.includes('no-savings-items'),
    'a household with no savings goals publishes no figure, with a reason', JSON.stringify(none && none.totals));
}

console.log('2. The pure pour on invented packets');
const packet = over => Object.assign({
  stock: { reportedStock: { status: 'ready', amount: 50, freshness: 'current' } },
  backing: { items: [
    { key: 'a@2026-12-01', date: '2026-12-01', needed: 40, trust: 'calculated' },
    { key: 'b@2026-12-01', date: '2026-12-01', needed: 40, trust: 'estimated' },
    { key: 'c@2026-11-25', date: '2026-11-25', needed: 5, trust: 'calculated' }] },
  rows: [{ key: 'row:a', label: 'A', members: ['a@2026-12-01'] }, { key: 'row:b', label: 'B', members: ['b@2026-12-01'] },
    { key: 'row:c', label: 'C', members: ['c@2026-11-25'] }],
}, over);
// The invented packets carry the reported stock's account ids and balance dates (both accounts, dated today), as
// Forecast's reported stock does; with no transactions no item payment is taken off.
const withAccounts = funding => {
  const stock = funding.stock && funding.stock.reportedStock;
  if (stock && !stock.accountIds) Object.assign(stock, { accountIds: ['savings', 'savings-dont-touch'],
    balanceDates: [{ accountId: 'savings', date: '2026-11-20' }, { accountId: 'savings-dont-touch', date: '2026-11-20' }] });
  return funding;
};
const call = (copyOf, over) => copyOf.pour({ timelineRole: 'current' }, { savingsFunding: withAccounts(packet(over)) });
const TIE = { items: [['row:c', 5, 5, 'calculated'], ['row:a', 40, 40, 'calculated'], ['row:b', 5, 40, 'estimated']], totals: [50, 50, 85, 0, 'estimated'] };
const UNKNOWN = { backing: { items: [
  { key: 'a@2026-12-01', date: '2026-12-01', needed: null, trust: 'unknown' },
  { key: 'b@2026-12-01', date: '2026-12-01', needed: 40, trust: 'estimated' },
  { key: 'c@2026-11-25', date: '2026-11-25', needed: 5, trust: 'calculated' }] } };
{
  ok(typeof pour === 'function', 'the pour is reachable on an exposed copy');
  // 50: c (nearest, 11-25) takes 5; a and b tie on 12-01: a first (plan order) takes 40, b the last 5.
  const tie = call(shipped, {});
  ok(same(tie, TIE), 'equal due dates keep the plan\'s order; a goal\'s estimated need makes it, and the head, estimated', JSON.stringify(pick(tie)));
  const unknown = call(shipped, UNKNOWN);
  ok(same(unknown, { items: [['row:c', 5, 5, 'calculated'], ['row:a', null, null, 'unavailable'], ['row:b', null, null, 'unavailable']], totals: [50, null, null, null, 'unavailable'] })
    && unknown.totals.reasons.includes('pour-stopped-at-unknown-need'),
    'an unknown need stops the pour: it and every later goal are withheld, never skipped', JSON.stringify(pick(unknown)));
  const orphan = call(shipped, { rows: [{ key: 'row:a', label: 'A', members: ['a@2026-12-01'] }, { key: 'row:c', label: 'C', members: ['c@2026-11-25'] }] });
  ok(orphan.items.length === 2 && orphan.items.every(x => x.saved === null) && orphan.totals.balance === null && orphan.totals.reasons.includes('rows-items-mismatch'),
    'a goal in no row withholds every figure (the rows would not add up to the pour)', JSON.stringify(pick(orphan)));
  const negative = call(shipped, { stock: { reportedStock: { status: 'ready', amount: -10, freshness: 'current' } } });
  ok(negative.items.every(x => x.saved === null) && negative.totals.reasons.includes('balance-negative'), 'a negative balance withholds every figure');
  const carried = call(shipped, { stock: { reportedStock: { status: 'ready', amount: 50, freshness: 'carried' } } });
  ok(carried.totals.trust === 'estimated' && carried.items.every(x => x.trust === 'estimated'), 'a balance carried from the last good refresh is estimated');
  const odd = call(shipped, { stock: { reportedStock: { status: 'ready', amount: 50, freshness: 'fresh' } } });
  ok(odd.totals.balance === null && odd.totals.trust === 'unavailable', 'an unknown freshness word withholds the balance (never defaults to calculated)');
  const grouped = call(shipped, { rows: [{ key: 'row:ab', label: 'AB', members: ['a@2026-12-01', 'b@2026-12-01'] }, { key: 'row:c', label: 'C', members: ['c@2026-11-25'] }] });
  ok(same(grouped, { items: [['row:c', 5, 5, 'calculated'], ['row:ab', 45, 80, 'estimated']], totals: [50, 50, 85, 0, 'estimated'] }),
    'a grouped row is the sum of its members\' pour', JSON.stringify(pick(grouped)));
  // Codex P1 (hand-derived): 1,000 poured into an estimated 600 trip (due first) then a confirmed 600 gift. The gift's
  // 400 is what the trip's estimate leaves, so it is estimated too, never calculated.
  const DEPENDS = { stock: { reportedStock: { status: 'ready', amount: 1000, freshness: 'current' } },
    backing: { items: [{ key: 'trip@2026-12-01', date: '2026-12-01', needed: 600, trust: 'estimated' },
      { key: 'gift@2026-12-20', date: '2026-12-20', needed: 600, trust: 'calculated' }] },
    rows: [{ key: 'row:trip', label: 'Trip', members: ['trip@2026-12-01'] }, { key: 'row:gift', label: 'Gift', members: ['gift@2026-12-20'] }] };
  const depends = call(shipped, DEPENDS);
  ok(same(depends, { items: [['row:trip', 600, 600, 'estimated'], ['row:gift', 400, 600, 'estimated']], totals: [1000, 1000, 1200, 0, 'estimated'] }),
    'a goal poured after an estimated need is estimated (its saved depends on that estimate)', JSON.stringify(pick(depends)));
  const firstEst = call(shipped, { ...DEPENDS, backing: { items: [{ key: 'trip@2026-12-01', date: '2026-12-01', needed: 600, trust: 'calculated' },
    { key: 'gift@2026-12-20', date: '2026-12-20', needed: 600, trust: 'estimated' }] } });
  ok(firstEst.items[0].trust === 'calculated' && firstEst.items[1].trust === 'estimated',
    'an estimated need later in the pour does not soften the goals poured before it');
  // Codex P2 (hand-derived): an owner-confirmed paid trip is a display row with no backing item; the 600 gift takes
  // 600 of 1,000 and 400 is left. The paid row is left off; the card is not blanked.
  const PAID = { stock: { reportedStock: { status: 'ready', amount: 1000, freshness: 'current' } },
    backing: { items: [{ key: 'gift@2026-12-20', date: '2026-12-20', needed: 600, trust: 'calculated' }] },
    rows: [{ key: 'commitment:trip', label: 'Trip', members: ['trip@2026-12-01'], paymentStatus: 'paid', needed: 0 },
      { key: 'commitment:gift', label: 'Gift', members: ['gift@2026-12-20'] }] };
  const paid = call(shipped, PAID);
  ok(same(paid, { items: [['commitment:gift', 600, 600, 'calculated']], totals: [1000, 600, 600, 400, 'calculated'] })
    && !paid.totals.reasons.includes('rows-items-mismatch'), 'a goal confirmed paid is left off, and the rest still pours', JSON.stringify(pick(paid)));
  // An unresolved goal (savingsFunding.unresolved: no need or date) sits in the rows; it comes last and stops the
  // pour there: the dated goals keep their figures, it and the head and unallocated are withheld.
  const UNRESOLVED = { stock: { reportedStock: { status: 'ready', amount: 1000, freshness: 'current' } },
    backing: { items: [{ key: 'gift@2026-12-20', date: '2026-12-20', needed: 600, trust: 'calculated' }] },
    unresolved: [{ key: 'roof', needed: null, trust: 'unknown' }],
    rows: [{ key: 'commitment:gift', label: 'Gift', members: ['gift@2026-12-20'] }, { key: 'commitment:roof', label: 'Roof', members: ['roof'] }] };
  const unres = call(shipped, UNRESOLVED);
  ok(same(unres, { items: [['commitment:gift', 600, 600, 'calculated'], ['commitment:roof', null, null, 'unavailable']], totals: [1000, null, null, null, 'unavailable'] })
    && unres.totals.reasons.includes('pour-stopped-at-unknown-need') && !unres.totals.reasons.includes('rows-items-mismatch'),
    'an unresolved goal stops the pour at the end; the goals before it keep their figures', JSON.stringify(pick(unres)));
  ok(call(copies.ownTrustOnly, DEPENDS).items[1].trust === 'calculated', 'mutant caught: a saved tagged by its own need only');
  ok(call(copies.paidKept, PAID).totals.reasons.includes('rows-items-mismatch'), 'mutant caught: a paid display row blanks the card');
  ok(call(copies.noUnresolved, UNRESOLVED).totals.reasons.includes('rows-items-mismatch'), 'mutant caught: an unresolved goal blanks the card');
  ok(pour({ timelineRole: 'past' }, { savingsFunding: packet({}) }) === null && pour({ timelineRole: 'future' }, { savingsFunding: packet({}) }) === null,
    'past and later periods publish null (no card)');
  const empty = pour({ timelineRole: 'current' }, {});
  ok(empty && empty.items.length === 0 && empty.totals.trust === 'unavailable', 'no savings packet at all: no figure, no goal');
}

console.log('3. Every period of the corpus');
const corpus = [];
for (const inp of INPUTS) for (const shift of [0, 3, 7, 14]) corpus.push(F => run(F, inp, { shift }));
{
  const w = H.baseWorld();
  w.commitments = [{ id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true }];
  w.savingsPool = { value: 1000 };
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  const { data, packet: actuals, error } = H.dataOf(w);
  if (error) throw error;
  corpus.push(F => F.recommend(structuredClone(data.plan), w.asOf, { debts: structuredClone(data.debts), currentPeriodActuals: structuredClone(actuals) }));
}
const REASONS = new Set(['owner-rule:balance-poured-nearest-due-first', 'balance-current', 'balance-dated', 'balance-carried', 'balance-unavailable',
  'balance-negative', 'rows-items-mismatch',
  'pour-stopped-at-unknown-need', 'no-savings-items']);
const TRUST = new Set(['calculated', 'estimated', 'unavailable']);
const cents = v => Math.round(v * 100);
function audit(F) {
  const r = { periods: 0, cards: 0, poured: 0, roleFail: 0, nameFail: 0, capFail: 0, orderFail: 0, sumFail: 0, balanceFail: 0, trustFail: 0, reasonFail: 0 };
  for (const args of corpus) {
    const res = args(F);
    const funding = res.savingsFunding;
    for (const v of res.payPeriodViews || []) {
      r.periods++;
      const s = v.stackSummary && v.stackSummary.savings;
      if (!['current', 'next'].includes(v.timelineRole)) { if (s !== null) r.roleFail++; continue; }
      if (!s) { r.roleFail++; continue; }
      r.cards++;
      const rows = funding && Array.isArray(funding.rows) ? funding.rows.filter(row => row.paymentStatus !== 'paid') : [];
      if (s.items.length !== rows.length || s.items.some(x => !rows.some(row => row.key === x.id && x.label === row.label))) r.nameFail++;
      for (const x of s.items) {
        if ((x.saved === null) !== (x.needed === null) || x.saved !== null && (x.saved < 0 || x.saved > x.needed)) r.capFail++;
        if (!TRUST.has(x.trust) || (x.saved === null) !== (x.trust === 'unavailable')) r.trustFail++;
      }
      const t = s.totals;
      if (t.saved !== null) {
        r.poured++;
        if (cents(t.saved) !== s.items.reduce((c, x) => c + cents(x.saved), 0) || cents(t.needed) !== s.items.reduce((c, x) => c + cents(x.needed), 0)
            || cents(t.saved) + cents(t.unallocated) !== cents(t.balance)) r.sumFail++;
        // The balance is the reported stock, both accounts summed, as published.
        const stock = funding.stock.reportedStock;
        if (t.balance !== stock.amount) r.balanceFail++;
        if (stock.freshness !== 'current' && t.trust !== 'estimated') r.trustFail++;
        // Nearest due first (independent of the page's order): a goal holds money only once every goal due
        // strictly earlier is full.
        const items = [...funding.backing.items, ...(funding.unresolved || [])];
        const pours = new Map(items.map(i => [i.key, 0])), trusts = new Map();
        let left = cents(t.balance), trust = stock.freshness === 'current' ? 'calculated' : 'estimated';
        for (const i of [...items].sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : items.indexOf(p) - items.indexOf(q)))) {
          const take = Math.min(cents(i.needed), left); left -= take; pours.set(i.key, take);
          if (i.trust === 'estimated') trust = 'estimated';
          trusts.set(i.key, trust);
        }
        for (const x of s.items) {
          const row = rows.find(rw => rw.key === x.id);
          if (row.members.reduce((c, m) => c + pours.get(m), 0) !== cents(x.saved)) r.orderFail++;
          // Never more certain than the balance and every need poured up to this goal's members.
          if (row.members.some(m => trusts.get(m) === 'estimated') && x.trust !== 'estimated') r.trustFail++;
        }
      } else if (t.needed !== null || t.unallocated !== null || t.trust !== 'unavailable') r.sumFail++;
      if (!t.reasons.every(c => REASONS.has(c))) r.reasonFail++;
    }
  }
  return r;
}
const a = audit(shipped.F);
ok(a.periods > 100 && a.cards > 20 && a.poured >= 5 && a.roleFail === 0,
  `the card is published on the current and next periods only (${a.cards} cards, ${a.poured} poured, ${a.periods} periods)`, JSON.stringify(a));
ok(a.nameFail === 0, 'every card names every savingsFunding goal row, published or withheld', String(a.nameFail));
ok(a.capFail === 0, 'each goal\'s saved is between 0 and its needed, both published or both withheld', String(a.capFail));
ok(a.orderFail === 0, 'each goal\'s saved is an independent nearest-due-first pour of the balance', String(a.orderFail));
ok(a.sumFail === 0, 'the head is the rows summed, and saved + unallocated is the balance exactly', String(a.sumFail));
ok(a.balanceFail === 0, 'the balance is the reported stock of both savings accounts, as published', String(a.balanceFail));
ok(a.trustFail === 0 && a.reasonFail === 0, 'tags never exceed the balance; reasons are from the closed set', JSON.stringify([a.trustFail, a.reasonFail]));

console.log('4. Every existing field is byte-equal');
{
  const strip = res => { for (const v of res.payPeriodViews || []) if (v.stackSummary) delete v.stackSummary.savings; return JSON.stringify(res); };
  let n = 0;
  for (const args of corpus) if (strip(args(shipped.F)) === JSON.stringify(args(copies.without.F))) n++;
  ok(n === corpus.length, `the advice without stackSummary.savings is byte-equal on all ${corpus.length} cases`, `${n} of ${corpus.length}`);
}

console.log('5. Mutants are caught');
{
  ok(!same(world(copies.farthestFirst), COVERS_SOME), 'pouring farthest due first is caught (the covers-some world)', JSON.stringify(pick(world(copies.farthestFirst))));
  ok(!same(call(copies.tiesReversed, {}), TIE), 'equal due dates in reverse plan order are caught (the tie packet)');
  ok(world(copies.noCap).totals.saved !== 119, 'a goal saved past what is left (no cap) is caught', JSON.stringify(pick(world(copies.noCap))));
  ok(call(copies.skipUnknown, UNKNOWN).items.some(x => x.id === 'row:b' && x.saved !== null), 'skipping an unknown need instead of stopping is caught');
  ok(world(copies.staleCalculated, setBalance(95, 24, '2026-10-01')).totals.trust !== 'estimated', 'a dated balance tagged calculated is caught (the dated world)');
  ok(world(copies.noUnallocated, setBalance(300, 0)).totals.unallocated !== 46, 'a dropped unallocated is caught (the covers-all world)');
  ok(world(copies.oneAccount).totals.balance !== 119, 'one account in place of the grand total is caught');
  ok(sav(byRole(run(copies.currentOnly.F, input('savings-live-ready')), 'next')[0]) === null, 'a next period without the card is caught');
  ok(world(copies.hiddenWhenWithheld, o => { o.accounts.pop(); }) === null, 'a card hidden when the balance is withheld is caught');
  for (const [name, c] of [['farthest first', copies.farthestFirst], ['no cap', copies.noCap], ['no unallocated', copies.noUnallocated],
    ['one account', copies.oneAccount], ['current only', copies.currentOnly]]) {
    const m = audit(c.F);
    ok(m.roleFail + m.capFail + m.orderFail + m.sumFail + m.balanceFail + m.trustFail > 0, `the corpus audit also catches: ${name}`, JSON.stringify(m));
  }
}

console.log('6. The figures snapshot captures every figure and tag');
{
  const inp = input('savings-live-ready');
  const snap = Snap.buildFiguresSnapshot(structuredClone(inp.doc.data), inp.doc.periods == null ? null : structuredClone(inp.doc.periods));
  const view = byRole(run(shipped.F, inp), 'current')[0];
  const s = sav(view);
  let missing = 0;
  for (const g of s.items) for (const field of ['saved', 'needed', 'trust']) {
    const key = 'period.' + view.start + '.stackSavingsGoal.' + g.id + '.' + field;
    if (!Object.hasOwn(snap, key) || JSON.stringify(snap[key]) !== JSON.stringify(g[field])) missing++;
  }
  for (const [field, key] of [['balance', 'stackSavingsBalance'], ['saved', 'stackSavingsSaved'], ['needed', 'stackSavingsNeeded'],
    ['unallocated', 'stackSavingsUnallocated'], ['trust', 'stackSavingsTrust']]) {
    const k = 'period.' + view.start + '.' + key;
    if (!Object.hasOwn(snap, k) || JSON.stringify(snap[k]) !== JSON.stringify(s.totals[field])) missing++;
  }
  ok(s.items.length > 1 && missing === 0, 'the balance, the head, unallocated and each goal\'s saved, needed and trust are captured as published', String(missing));
  ok(snap['period.' + view.start + '.stackSavingsGoal.group:club.saved'] === 95, 'club saved 95 is in the snapshot');
}

console.log('7. The card pours the reported total as is (owner ruling, Dale 2026-11-21)');
{
  // Owner ruling (Dale, 2026-11-21, relayed by the lead on #1493): "For savings, all you need is the total amount in
  // my savings account. That's it. ... Savings amount. Funds. Every savings item in order." The card pours the
  // reported total of both savings accounts as reported, nearest due first, and adds none of the Savings
  // allocator's holds; the allocator's own figures keep them. Hand-derived on the invented world of
  // test-savings-dated-balance-item-liability: a 600 trip due Nov 20 (linked to the Trip category) and a 600 gift
  // due Dec 10, as of Oct 14.
  const TRIP_LINK = { categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20',
    effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' };
  const linked = (savings, balanceDate, purchases, { card = false } = {}) => {
    const w = H.baseWorld();
    const acct = w.accounts.find(a => a.id === 'savings');
    acct.value = savings;
    if (balanceDate) acct.balanceDate = balanceDate;
    w.commitments = [
      { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true },
      { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: 600, confidence: 'confirmed', sinkingFund: true },
    ];
    w.savingsPool = {};
    w.links = [TRIP_LINK];
    w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
      ...purchases.map(p => H.lm({ category: 'Trip', payee: 'Invented airline', ...p }))];
    if (card) {
      w.accounts.push({ id: 'travelvisa', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: 0 });
      w.debts = [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false, balance: 0,
        pending: 0, rate: 0, limit: 2000, statementCloseDay: 17 }];
      w.planPatch = plan => { plan.cardPurchaseCoverage = { rule: 'aggregate-per-card-per-pay-period',
        opening: { asOf: '2026-10-09', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } }; };
    }
    return w;
  };
  const engine = (copyOf, w) => {
    const { data, error } = H.dataOf(w);
    if (error) throw error;
    const o = data.liveOverlay;
    const advice = copyOf.F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: o.currentPeriodActuals,
      operatingPlan: o.operatingPlan, observedCash: o.observedCash });
    return { s: sav(byRole(advice, 'current')[0]), sf: advice.savingsFunding };
  };
  const goals = s => s.items.map(x => [x.id, x.saved, x.needed]);
  // A dated balance and a later linked purchase of 500 from Savings: the trip's need is 100 (600 less the 500 it
  // already took), and the reported 1,000 is poured as reported: trip 100 / 100, gift 600 / 600, 300 left.
  const dated = engine(shipped, linked(1000, '2026-10-10', [{ date: '2026-10-12', amount: 500, account: 'savings' }]));
  ok(JSON.stringify(goals(dated.s)) === JSON.stringify([['commitment:trip', 100, 100], ['commitment:gift', 600, 600]])
    && dated.s.totals.balance === 1000 && dated.s.totals.unallocated === 300 && dated.s.items.every(x => x.trust === 'estimated'),
    'a later purchase from Savings: the reported 1,000 poured as is: trip 100 / 100, gift 600 / 600, 300 left (dated: estimated)',
    JSON.stringify(pick(dated.s)));
  // (a) An unpaid card charge of 500 for the trip: its need is 100, and the allocator withholds its own Saved. The card
  // pours the reported total as is: trip 100, gift 600, 300 left.
  const unpaid = engine(shipped, linked(1000, '2026-10-10', [{ date: '2026-10-11', amount: 500, account: 'travelvisa', providerAccountId: 9004 }], { card: true }));
  ok(unpaid.sf.goalAllocation.status === 'unavailable'
    && JSON.stringify(goals(unpaid.s)) === JSON.stringify([['commitment:trip', 100, 100], ['commitment:gift', 600, 600]])
    && unpaid.s.totals.balance === 1000 && unpaid.s.totals.unallocated === 300,
    '(a) an unpaid card charge for a goal: the allocator withholds, the card pours the reported total as is', JSON.stringify(pick(unpaid.s)));
  // (b) One transfer between the two savings accounts held in both reported balances (the repository's fixture): the
  // allocator withholds; the card pours the reported total, 200, as is: near 60, home 24, far 116 of 170 -> club
  // 176 / 230, home 24 / 24, nothing left.
  {
    const x = require('./fixtures/savings-transfer-cutoffs')('double-count');
    const advice = shipped.F.recommend(x.plan, x.asOf, { ...x.opts, debts: x.debts || [] });
    const s = sav(byRole(advice, 'current')[0]);
    ok(advice.savingsFunding.goalAllocation.status === 'unavailable' && s.totals.balance === 200
      && JSON.stringify(goals(s)) === JSON.stringify([['group:club', 176, 230], ['yearly-bill:home-cost', 24, 24]]) && s.totals.unallocated === 0,
    '(b) one transfer in both balances: the allocator withholds, the card pours the reported 200 as is', JSON.stringify(pick(s)));
  }
  // Control: no purchase, the same 1,000 as is: trip 600, gift 400, nothing left.
  const none = engine(shipped, linked(1000, '2026-10-10', []));
  ok(JSON.stringify(goals(none.s)) === JSON.stringify([['commitment:trip', 600, 600], ['commitment:gift', 400, 600]]) && none.s.totals.unallocated === 0,
    'control: no purchase: trip 600 / 600, gift 400 / 600', JSON.stringify(pick(none.s)));
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} stack savings checks passed`);
process.exit(failures ? 1 : 0);
