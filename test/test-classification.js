'use strict';
/* B90 / AF-CLASS-01 — overlapping essential/discretionary classification.

   Atlas publishes two views of household spending:

     Forward plan:  plan.budget.categories[].class
                    (essentials, discretionary room, weekly cap)

     Historical:    docs/merchant-library.csv type
                    → scripts/periods.js
                    → public/periods.json spending[].type
                    (Deep Dive mix / historical category totals)

   The join is the existing `from[]` list on each budget category. Labels are
   compared exactly — that list is the alias map; this file does not guess.

   Comparable classes: essential, discretionary.
   Named non-comparable semantics: business, reserve, unknown.

   Mixed source types inside one mapped category are not a comparable story.
   `Forecast.rollupSpending` publishes that mix as `unknown` (existing unresolved
   semantic) rather than the first event's class, so Health cannot be consumed
   as a clean essential or discretionary answer merely because one source event
   happened first. Totals stay conserved.
*/

const fs = require('fs');
const path = require('path');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const read = rel => sourceText(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
const loadJson = rel => JSON.parse(read(rel));

const COMPARABLE = new Set(['essential', 'discretionary']);
const PAYPAL_CHANNEL = '@paypal';

/* Closed lists. A new essential/discretionary disagreement is a failure unless
 * it is added here AND recorded. These are not wildcards. */
const OWNER_UNRESOLVED = new Set();
const SOURCE_AMBIGUOUS = new Set(['Health']);

const PERSONAL_CARE = [
  'ANNANAILS', 'ZENNKAISALON', 'NAMASTEBEAUTY', 'VNNAILSSPA',
  'TIFFANYNAILBA', 'GREATCLIPS', 'SKINDISTRICTI',
];

function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (const c of line) {
    if (c === '"') { q = !q; continue; }
    if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseLibrary(text) {
  const lines = sourceText(text).split('\n').filter(l => l.trim());
  const head = splitCsv(lines.shift()).map(h => h.trim());
  return lines.map(line => {
    const cols = splitCsv(line);
    const row = {};
    head.forEach((h, i) => { row[h] = (cols[i] || '').trim(); });
    return row;
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function libraryTypes(rows, label) {
  return new Set(rows.filter(r => r.category === label).map(r => r.type).filter(Boolean));
}

function periodTypes(periods, label) {
  const types = new Set();
  for (const period of Object.values((periods && periods.periods) || {})) {
    for (const row of period.spending || []) {
      if (row.label === label && row.type) types.add(row.type);
    }
  }
  return types;
}

function one(set) {
  return set.size === 1 ? [...set][0] : null;
}

/* Incumbent scripts/periods.js spend rollup: the first event's type is kept;
 * later events of the same category only add to the total. */
function publishedTypeByFirstEvent(events, label) {
  let type = null;
  for (const e of events) {
    if (e.category === label && e.type && type == null) type = e.type;
  }
  return type;
}

function sourceTypeSet(events, label) {
  return new Set(events.filter(e => e.category === label).map(e => e.type).filter(Boolean));
}

/* Pure predicate. Returns problem strings; empty means the invariant holds. */
function classificationProblems({
  categories,
  excluded,
  library,
  periods,
  unresolved = OWNER_UNRESOLVED,
  sourceAmbiguous = SOURCE_AMBIGUOUS,
}) {
  const problems = [];
  const excludedLabels = new Set((excluded || []).map(e => e.from));

  const bizLib = libraryTypes(library, 'Business');
  const bizHist = periodTypes(periods, 'Business');
  const bizAll = new Set([...bizLib, ...bizHist]);
  if (bizAll.size && [...bizAll].some(t => t !== 'business')) {
    problems.push('business-coerced');
  }
  if (!excludedLabels.has('Business')) {
    problems.push('business-not-excluded');
  }
  for (const c of categories || []) {
    if ((c.from || []).includes('Business') && COMPARABLE.has(c.class)) {
      problems.push(`business-as-household:${c.id}`);
    }
  }

  for (const c of categories || []) {
    for (const label of c.from || []) {
      if (label === PAYPAL_CHANNEL) continue;

      const libTypes = libraryTypes(library, label);
      const histTypes = periodTypes(periods, label);
      const mixed = libTypes.size > 1;
      const listedAmbiguous = sourceAmbiguous.has(label);
      const libType = one(libTypes);
      const published = one(histTypes);
      if (mixed && !listedAmbiguous) {
        problems.push(`library-mixed:${label}:${[...libTypes].sort().join(',')}`);
      }
      if (!mixed && listedAmbiguous) {
        problems.push(`stale-source-ambiguous:${label}`);
      }
      if (histTypes.size > 1 && !(mixed || listedAmbiguous)) {
        problems.push(`periods-mixed:${label}:${[...histTypes].sort().join(',')}`);
      }
      const publishedOnlyComparable = histTypes.size > 0
        && [...histTypes].every(t => COMPARABLE.has(t));
      if ((mixed || listedAmbiguous) && publishedOnlyComparable) {
        problems.push(`collapsed-mixed:${label}:published=${[...histTypes].sort().join(',')}`);
      }
      if (libType && published && libType !== published) {
        problems.push(`stale-periods:${label}:library=${libType}:periods=${published}`);
      }

      /* Mixed source types cannot be compared via a collapsed published class. */
      if (mixed || listedAmbiguous) continue;

      const historical = published || libType;
      if (!historical) continue;

      const named = unresolved.has(label);
      const fwd = c.class;

      if (fwd === 'reserve') continue;

      if (historical === 'business') {
        problems.push(`business-as-household:${label}:forward=${fwd}`);
        continue;
      }

      const comparablePair = COMPARABLE.has(fwd) && COMPARABLE.has(historical);
      const unknownVsDiscretionary =
        (fwd === 'discretionary' && historical === 'unknown')
        || (fwd === 'unknown' && historical === 'discretionary');

      if (comparablePair || unknownVsDiscretionary) {
        const disagree = fwd !== historical;
        if (disagree && !named) {
          problems.push(`contradiction:${label}:forward=${fwd}:historical=${historical}`);
        }
        if (!disagree && named) {
          problems.push(`stale-unresolved:${label}`);
        }
      }
    }
  }

  for (const label of unresolved) {
    const cat = (categories || []).find(c => (c.from || []).includes(label));
    if (!cat) problems.push(`unresolved-missing-category:${label}`);
  }
  for (const label of sourceAmbiguous) {
    const cat = (categories || []).find(c => (c.from || []).includes(label));
    if (!cat) problems.push(`source-ambiguous-missing-category:${label}`);
  }

  return problems;
}

const F = require('../public/forecast.js');
const data = loadJson('data.json');
const periods = loadJson('public/periods.json');
const libraryText = read('docs/merchant-library.csv');
const library = parseLibrary(libraryText);
const questions = read('docs/01_OPEN_QUESTIONS.md');
const budget = data.plan.budget;
const live = {
  categories: budget.categories,
  excluded: budget.excluded,
  library,
  periods,
};

console.log('=== live overlapping comparable categories ===');
const liveProblems = classificationProblems(live);
ok(liveProblems.length === 0,
  'no silent essential/discretionary contradiction on the live join',
  liveProblems.join('; ') || 'none');

const overlapRows = [];
for (const c of budget.categories) {
  for (const label of c.from || []) {
    if (label === PAYPAL_CHANNEL) {
      overlapRows.push({
        id: c.id, label, forward: c.class, historical: '(paypal channel)',
        comparable: false, disposition: 'non-overlap: funding channel, not a merchant category',
      });
      console.log(`  ${c.id.padEnd(16)} ${c.class.padEnd(14)} ← ${label.padEnd(22)} (channel)      non-overlap: PayPal funding`);
      continue;
    }
    const libTypes = libraryTypes(library, label);
    const published = one(periodTypes(periods, label));
    const libType = one(libTypes);
    const mixed = libTypes.size > 1;
    const historical = mixed
      ? `mixed:${[...libTypes].sort().join(',')}`
      : (published || libType || '(absent)');
    const ownerUnresolved = OWNER_UNRESOLVED.has(label);
    const sourceAmbiguous = SOURCE_AMBIGUOUS.has(label) || mixed;
    const comparable = !sourceAmbiguous && COMPARABLE.has(c.class) && COMPARABLE.has(published || libType);
    let disposition = 'AGREE';
    if (c.class === 'reserve') disposition = 'INTENTIONAL EXCEPTION: reserve';
    else if (c.class === 'unknown' && historical === 'unknown') disposition = 'AGREE (unknown)';
    else if (sourceAmbiguous) disposition = 'SOURCE-SEMANTIC AMBIGUITY';
    else if (ownerUnresolved) disposition = 'OWNER DECISION REQUIRED';
    else if (comparable && c.class !== (published || libType)) disposition = 'CONTRADICTION';
    overlapRows.push({
      id: c.id, label, forward: c.class, historical, comparable, disposition,
    });
    console.log(`  ${c.id.padEnd(16)} ${c.class.padEnd(14)} ← ${label.padEnd(22)} ${String(historical).padEnd(28)} ${disposition}`);
  }
}

const comparableLive = overlapRows.filter(r => r.comparable && r.disposition === 'AGREE');
ok(comparableLive.length >= 10,
  'live comparable overlaps that currently agree are enumerated',
  `${comparableLive.length} agreeing pairs`);
ok(!comparableLive.some(r => r.label === 'Health'),
  'Health is not treated as a clean comparable essential agreement');

const school = overlapRows.find(r => r.label === 'School & clubs');
ok(school && school.forward === 'essential' && school.historical === 'essential',
  'School & clubs is essential on both sides',
  school ? `${school.forward} vs ${school.historical}` : 'missing');
ok(school && school.disposition === 'AGREE',
  'that agreement is a comparable AGREE, not an owner-unresolved split');
ok(/Q24/.test(questions) && /School & clubs/.test(questions)
  && /ANSWERED/.test(questions) && /essential/i.test(questions),
  'Q24 is recorded ANSWERED as essential in 01_OPEN_QUESTIONS.md');

console.log('\n=== named non-comparable semantics ===');
const business = overlapRows.find(r => r.label === 'Business');
ok(!business,
  'Business is not a forward budget category');
ok((budget.excluded || []).some(e => e.from === 'Business'),
  'Business is explicitly excluded from the household cap');
ok(one(libraryTypes(library, 'Business')) === 'business'
  && one(periodTypes(periods, 'Business')) === 'business',
  'historical Business stays type business',
  `${one(libraryTypes(library, 'Business'))} / ${one(periodTypes(periods, 'Business'))}`);

const propertyTax = overlapRows.find(r => r.label === 'Property tax');
const tax = overlapRows.find(r => r.label === 'Tax');
ok(propertyTax && propertyTax.forward === 'reserve' && propertyTax.historical === 'essential',
  'Property tax is forward reserve against historical essential');
ok(tax && tax.forward === 'reserve' && tax.historical === 'essential',
  'CRA Tax is forward reserve against historical essential');
ok(propertyTax.disposition.startsWith('INTENTIONAL EXCEPTION')
  && tax.disposition.startsWith('INTENTIONAL EXCEPTION'),
  'reserve vs historical essential is a named exception, not a comparable flip');

const unknown = overlapRows.find(r => r.label === 'Uncategorised');
ok(unknown && unknown.forward === 'unknown' && unknown.historical === 'unknown',
  'Uncategorised stays unknown on both sides');

console.log('\n=== Health mixed source semantics ===');
const health = overlapRows.find(r => r.label === 'Health');
const healthLib = libraryTypes(library, 'Health');
ok(healthLib.size === 2 && healthLib.has('essential') && healthLib.has('discretionary'),
  'Health merchant-library types are mixed essential and discretionary',
  [...healthLib].sort().join(','));
ok(health && health.disposition === 'SOURCE-SEMANTIC AMBIGUITY',
  'Health mixed source types are surfaced as source-semantic ambiguity, not AGREE');
const allHealth = periods.periods.all.spending.find(row => row.label === 'Health');
ok(allHealth && allHealth.type === 'unknown'
  && (allHealth.types || []).slice().sort().join(',') === 'discretionary,essential',
  'all-history Health publishes the mixed source types, not a collapsed essential class',
  allHealth ? `${allHealth.type}:${(allHealth.types || []).join(',')}` : 'missing');
ok(health && health.forward === 'essential' && health.disposition !== 'AGREE',
  'forward Medical & health being essential does not make mixed Health a clean agreement');

for (const pattern of PERSONAL_CARE) {
  const row = library.find(r => r.pattern === pattern);
  ok(row && row.category === 'Health' && row.type === 'discretionary',
    `${pattern} remains Health/discretionary, not coerced to essential`,
    row ? `${row.category}/${row.type}` : 'missing');
}

const dropHealthAmbiguity = classificationProblems(Object.assign({}, live, {
  sourceAmbiguous: new Set(),
}));
ok(dropHealthAmbiguity.some(p => p.startsWith('library-mixed:Health:')),
  'dropping Health from the closed source-ambiguous list re-exposes the mixed types',
  dropHealthAmbiguity.filter(p => p.includes('Health')).join('; '));

const coerceHealthEssential = clone(live);
coerceHealthEssential.library = clone(library).map(r =>
  r.category === 'Health' ? Object.assign({}, r, { type: 'essential' }) : r);
ok(classificationProblems(coerceHealthEssential).some(p => p === 'stale-source-ambiguous:Health'),
  'making Health unanimous essential while it remains listed as source-ambiguous fails',
  classificationProblems(coerceHealthEssential).filter(p => p.includes('Health')).join('; '));

console.log('\n=== mutation: Health consumer result is independent of first-event order ===');
const medicalEvt = { category: 'Health', type: 'essential', amount: 40 };
const salonEvt = { category: 'Health', type: 'discretionary', amount: 25 };
const groceriesEvt = { category: 'Groceries', type: 'essential', amount: 100 };
const diningEvt = { category: 'Restaurants', type: 'discretionary', amount: 35 };
const caseA = [medicalEvt, salonEvt, groceriesEvt, diningEvt];
const caseB = [salonEvt, medicalEvt, groceriesEvt, diningEvt];

function collapseFirstEvent(events) {
  const byCat = {};
  for (const e of events) {
    byCat[e.category] = byCat[e.category] || { total: 0, type: e.type };
    byCat[e.category].total += e.amount;
  }
  return Object.keys(byCat).map(label => ({
    label,
    total: Math.round(byCat[label].total * 100) / 100,
    type: byCat[label].type,
  }));
}

function periodFrom(rows) {
  const spendingTotal = Math.round(rows.reduce((s, r) => s + r.total, 0) * 100) / 100;
  return { months: 1, spendingTotal, spending: rows, fees: [] };
}

const honestA = F.rollupSpending(caseA);
const honestB = F.rollupSpending(caseB);
const collapseA = collapseFirstEvent(caseA);
const collapseB = collapseFirstEvent(caseB);
const healthHonestA = honestA.find(r => r.label === 'Health');
const healthHonestB = honestB.find(r => r.label === 'Health');
const healthCollapseA = collapseA.find(r => r.label === 'Health');
const healthCollapseB = collapseB.find(r => r.label === 'Health');

ok(healthHonestA.total === 65 && healthHonestB.total === 65
  && healthHonestA.total === healthCollapseA.total
  && healthHonestB.total === healthCollapseB.total,
  'total Health spending is $40+$25 = $65 in both orderings and both aggregators');
ok(periodFrom(honestA).spendingTotal === 200 && periodFrom(honestB).spendingTotal === 200
  && periodFrom(collapseA).spendingTotal === 200 && periodFrom(collapseB).spendingTotal === 200,
  'total historical spending is $200 in both orderings and both aggregators');

ok(healthCollapseA.type === 'essential' && healthCollapseB.type === 'discretionary',
  'incumbent first-event collapse publishes opposite Health classes',
  `${healthCollapseA.type} vs ${healthCollapseB.type}`);
ok(healthHonestA.type === 'unknown' && healthHonestB.type === 'unknown'
  && healthHonestA.type === healthHonestB.type,
  'honest rollup publishes unknown Health in both orderings');
ok(JSON.stringify(healthHonestA.types) === JSON.stringify(['discretionary', 'essential'])
  && JSON.stringify(healthHonestB.types) === JSON.stringify(['discretionary', 'essential']),
  'both orderings preserve the same mixed source types');

const diveHonestA = F.deepDive({ plan: { startingCash: { amount: 0 } } }, periodFrom(honestA));
const diveHonestB = F.deepDive({ plan: { startingCash: { amount: 0 } } }, periodFrom(honestB));
const diveCollapseA = F.deepDive({ plan: { startingCash: { amount: 0 } } }, periodFrom(collapseA));
const diveCollapseB = F.deepDive({ plan: { startingCash: { amount: 0 } } }, periodFrom(collapseB));

ok(diveHonestA.period.discretionary === 35 && diveHonestB.period.discretionary === 35,
  'historical discretionary is $35 (Restaurants only) in both honest orderings',
  `${diveHonestA.period.discretionary} / ${diveHonestB.period.discretionary}`);
ok(diveCollapseA.period.discretionary === 35 && diveCollapseB.period.discretionary === 100,
  'first-event collapse makes Deep Dive discretionary $35 vs $100 — the live defect',
  `${diveCollapseA.period.discretionary} vs ${diveCollapseB.period.discretionary}`);
ok(diveHonestA.period.discretionary === diveHonestB.period.discretionary
  && diveCollapseA.period.discretionary !== diveCollapseB.period.discretionary,
  'honest discretionary is order-independent; collapsed discretionary is not');
ok(F.publishedSpendType(healthHonestA.types || [healthHonestA.type]) === 'unknown'
  && F.publishedSpendType(healthHonestB.types || [healthHonestB.type]) === 'unknown',
  'household-facing Health class is unknown in both honest orderings');
ok(F.publishedSpendType([healthCollapseA.type]) === 'essential'
  && F.publishedSpendType([healthCollapseB.type]) === 'discretionary',
  'collapsed Health is consumed as a clean essential or discretionary class depending on order');
ok(healthHonestA.type !== 'essential' && healthHonestA.type !== 'discretionary'
  && healthHonestB.type !== 'essential' && healthHonestB.type !== 'discretionary',
  'neither honest ordering is consumed as a clean essential or discretionary Health category');

console.log('\n=== mutation: Health first-event ordering is not classification truth ===');
const medical = { category: 'Health', type: 'essential' };
const salon = { category: 'Health', type: 'discretionary' };

function healthOrder(events) {
  const published = publishedTypeByFirstEvent(events, 'Health');
  const source = sourceTypeSet(events, 'Health');
  const lib = [...source].sort().map((t, i) => (
    { pattern: 'H' + i, category: 'Health', type: t }
  ));
  const fixture = {
    categories: [{ id: 'health', class: 'essential', from: ['Health'] }],
    excluded: [{ from: 'Business' }],
    library: lib,
    periods: { periods: { ytd: { spending: [{ label: 'Health', total: 10, type: published }] } } },
  };
  return {
    published,
    source: [...source].sort(),
    mixed: source.size > 1,
    withoutList: classificationProblems(Object.assign({}, fixture, {
      unresolved: new Set(), sourceAmbiguous: new Set(),
    })),
    withList: classificationProblems(Object.assign({}, fixture, {
      unresolved: new Set(), sourceAmbiguous: new Set(['Health']),
    })),
  };
}

const essentialFirst = healthOrder([medical, salon]);
const discretionaryFirst = healthOrder([salon, medical]);

ok(essentialFirst.published === 'essential',
  'essential-first then discretionary publishes essential under first-event collapse',
  essentialFirst.published);
ok(discretionaryFirst.published === 'discretionary',
  'discretionary-first then essential publishes discretionary under first-event collapse',
  discretionaryFirst.published);
ok(essentialFirst.mixed && discretionaryFirst.mixed
  && essentialFirst.source.join(',') === 'discretionary,essential'
  && discretionaryFirst.source.join(',') === 'discretionary,essential',
  'both orderings contain the same mixed source types');
ok(essentialFirst.withoutList.some(p => p.startsWith('library-mixed:Health:'))
  && discretionaryFirst.withoutList.some(p => p.startsWith('library-mixed:Health:')),
  'the guard detects mixed Health source types in both orderings',
  `essential-first=${essentialFirst.withoutList.join(';')} | discretionary-first=${discretionaryFirst.withoutList.join(';')}`);
ok(!essentialFirst.withoutList.some(p => p.startsWith('contradiction:Health:'))
  && !discretionaryFirst.withoutList.some(p => p.startsWith('contradiction:Health:')),
  'mixed Health is not compared as a clean essential/discretionary contradiction via the collapsed type');
ok(essentialFirst.withList.some(p => p === 'collapsed-mixed:Health:published=essential')
  && discretionaryFirst.withList.some(p => p === 'collapsed-mixed:Health:published=discretionary'),
  'SOURCE_AMBIGUOUS does not excuse a collapsed essential/discretionary published type');
ok(essentialFirst.published !== discretionaryFirst.published
  && essentialFirst.withoutList.filter(p => p.startsWith('library-mixed:Health:'))[0]
    === discretionaryFirst.withoutList.filter(p => p.startsWith('library-mixed:Health:'))[0],
  'source-mix detection is independent of which Health event is encountered first');

const honestPublished = {
  categories: [{ id: 'health', class: 'essential', from: ['Health'] }],
  excluded: [{ from: 'Business' }],
  library: [
    { pattern: 'H0', category: 'Health', type: 'discretionary' },
    { pattern: 'H1', category: 'Health', type: 'essential' },
  ],
  periods: { periods: { ytd: { spending: [{
    label: 'Health', total: 65, type: 'unknown', types: ['discretionary', 'essential'],
  }] } } },
  unresolved: new Set(),
};
ok(classificationProblems(Object.assign({}, honestPublished, {
  sourceAmbiguous: new Set(['Health']),
})).length === 0,
  'SOURCE_AMBIGUOUS plus unknown published type is an honest product state');
ok(classificationProblems(Object.assign({}, honestPublished, {
  sourceAmbiguous: new Set(),
})).some(p => p.startsWith('library-mixed:Health:'))
  && !classificationProblems(Object.assign({}, honestPublished, {
    sourceAmbiguous: new Set(),
  })).some(p => p.startsWith('collapsed-mixed:')),
  'unknown publication is not a collapsed clean class; the library mix still needs naming');

console.log('\n=== mutation: agreeing comparable category, essential ↔ discretionary ===');
const groceries = live.categories.find(c => c.id === 'groceries');
ok(groceries && groceries.class === 'essential' && one(periodTypes(periods, 'Groceries')) === 'essential',
  'Groceries currently agrees as essential');

const flipForward = clone(live);
flipForward.categories = clone(live.categories).map(c =>
  c.id === 'groceries' ? Object.assign({}, c, { class: 'discretionary' }) : c);
const flipForwardProblems = classificationProblems(flipForward);
ok(flipForwardProblems.some(p => p.startsWith('contradiction:Groceries:forward=discretionary:historical=essential')),
  'flipping Groceries forward to discretionary fails the reconciliation rule',
  flipForwardProblems.filter(p => p.includes('Groceries')).join('; '));

const flipPublished = clone(live);
flipPublished.periods = clone(periods);
for (const period of Object.values(flipPublished.periods.periods)) {
  for (const row of period.spending || []) {
    if (row.label === 'Groceries') row.type = 'discretionary';
  }
}
const flipPublishedProblems = classificationProblems(flipPublished);
ok(flipPublishedProblems.some(p => p.startsWith('contradiction:Groceries:forward=essential:historical=discretionary')),
  'flipping published Groceries history to discretionary fails the reconciliation rule',
  flipPublishedProblems.filter(p => p.includes('Groceries')).join('; '));

console.log('\n=== mutation: business survives ===');
ok(!classificationProblems(live).some(p => p.startsWith('business')),
  'live business classification does not fail the household comparable check');
const coerceBusiness = clone(live);
coerceBusiness.library = clone(library).map(r =>
  r.category === 'Business' ? Object.assign({}, r, { type: 'essential' }) : r);
ok(classificationProblems(coerceBusiness).includes('business-coerced'),
  'coercing Business into essential fails; business is not flattened');
const budgetBusiness = clone(live);
budgetBusiness.categories = clone(live.categories).concat([{
  id: 'biz', class: 'discretionary', from: ['Business'],
}]);
ok(classificationProblems(budgetBusiness).some(p => p.startsWith('business-as-household')),
  'putting Business into a discretionary budget category fails');

console.log('\n=== mutation: reserve survives ===');
ok(!classificationProblems(live).some(p => p.includes('Property tax') || p.includes(':Tax:')),
  'live reserve vs historical essential does not fail');
const coerceReserve = clone(live);
coerceReserve.categories = clone(live.categories).map(c =>
  c.id === 'propertytax' ? Object.assign({}, c, { class: 'discretionary' }) : c);
ok(classificationProblems(coerceReserve).some(p =>
  p === 'contradiction:Property tax:forward=discretionary:historical=essential'),
  'coercing Property tax from reserve into discretionary contradicts historical essential',
  classificationProblems(coerceReserve).filter(p => p.includes('Property tax')).join('; '));
const keepReserveEssential = clone(live);
keepReserveEssential.categories = clone(live.categories).map(c =>
  c.id === 'propertytax' ? Object.assign({}, c, { class: 'essential' }) : c);
ok(!classificationProblems(keepReserveEssential).some(p => p.includes('Property tax')),
  'reserve is not required to match historical essential — essential would agree, and is a different (cap) decision');

console.log('\n=== mutation: no blanket exception ===');
const flipRestaurants = clone(live);
flipRestaurants.categories = clone(live.categories).map(c =>
  c.id === 'restaurants' ? Object.assign({}, c, { class: 'essential' }) : c);
ok(classificationProblems(flipRestaurants).some(p =>
  p === 'contradiction:Restaurants:forward=essential:historical=discretionary'),
  'an arbitrary Restaurants essential/discretionary flip fails',
  classificationProblems(flipRestaurants).filter(p => p.includes('Restaurants')).join('; '));

const invent = clone(live);
invent.library = clone(library).concat([{ pattern: 'FAKE', category: 'GhostSpend', type: 'discretionary' }]);
invent.periods = clone(periods);
invent.periods.periods.ytd.spending.push({ label: 'GhostSpend', total: 1, type: 'discretionary' });
invent.categories = clone(live.categories).concat([{
  id: 'ghost', class: 'essential', from: ['GhostSpend'],
}]);
ok(classificationProblems(invent).some(p =>
  p === 'contradiction:GhostSpend:forward=essential:historical=discretionary'),
  'a new overlapping essential/discretionary pair fails unless explicitly named',
  classificationProblems(invent).filter(p => p.includes('GhostSpend')).join('; '));

const markSchoolUnresolved = classificationProblems(Object.assign({}, live, {
  unresolved: new Set(['School & clubs']),
}));
ok(markSchoolUnresolved.some(p => p === 'stale-unresolved:School & clubs'),
  'keeping School & clubs on the unresolved list after they agree is stale');

console.log('\n=== generator: library type matches published periods.json ===');
const mappedLabels = new Set();
for (const c of budget.categories) {
  for (const label of c.from || []) {
    if (label !== PAYPAL_CHANNEL) mappedLabels.add(label);
  }
}
mappedLabels.add('Business');
let stale = 0;
for (const label of mappedLabels) {
  if (SOURCE_AMBIGUOUS.has(label)) continue;
  const libType = one(libraryTypes(library, label));
  const published = one(periodTypes(periods, label));
  if (libType && published && libType !== published) stale++;
}
ok(stale === 0,
  'unambiguous overlapping merchant-library types match public/periods.json',
  `${mappedLabels.size} mapped labels`);
ok(/Forecast\.rollupSpending/.test(read('scripts/periods.js')),
  'periods generation rollup uses Forecast.rollupSpending, not first-event type');

const staleLib = clone(live);
staleLib.library = clone(library).map(r =>
  r.category === 'Groceries' ? Object.assign({}, r, { type: 'discretionary' }) : r);
ok(classificationProblems(staleLib).some(p => p.startsWith('stale-periods:Groceries:')),
  'changing a library type without regenerating periods.json fails',
  classificationProblems(staleLib).filter(p => p.includes('Groceries')).join('; '));

console.log('\n' + (failures ? `${failures} CHECKS FAILED` : 'ALL CHECKS PASSED'));
if (failures) process.exit(1);
