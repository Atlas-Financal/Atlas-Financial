'use strict';
/* Opening-gap recovery must not convert debt capacity into cash.
 *
 * The 2026-08-21 live acceptance run had household cash $747.81 including
 * $0.58 designated savings. Forecast spendable opening is chequing-only
 * $747.23. Buffer gap $104.89, Amanda $0, and HELOC headroom $2,167.84.
 * buffer gap, Amanda $0, and HELOC headroom $2,167.84. Forecast auto-drew
 * the HELOC and published a borrowing-enabled weekly cap. B70 already
 * says remaining headroom must never increase safe-to-spend.
 *
 * Synthetic fixture, independent arithmetic (L-006). Live cents are the
 * owner-stated acceptance amounts, not a copy of data.json as spec.
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;

const AS_OF = '2026-08-21';
const CASH = 747.23;
const BREAKDOWN_TOTAL = 747.81;
const BUFFER = 500;
const GAP = 104.89;
const FLOOR = BUFFER - GAP;
const PRE_PAYDAY = CASH - FLOOR;
const HELOC_LIMIT = 202654;
const HELOC_POSTED = 200486.16;
const HELOC_ROOM = HELOC_LIMIT - HELOC_POSTED;

function fixture(extra = {}) {
  const plan = {
    windowDays: 21,
    defaults: { targetBuffer: BUFFER },
    startingCash: {
      breakdown: [
        { id: 'chequing-a', value: 629.27 },
        { id: 'chequing-b', value: 117.96 },
        { id: 'savings', value: 0.58 },
      ],
      heldElsewhere: [{ id: 'amanda-debt-payments', value: 2691.85 }],
    },
    opening: { asOf: AS_OF },
    income: [{
      id: 'pay', label: 'Payday', frequency: 'once', date: '2026-08-28',
      amount: 4000, confidence: 'confirmed',
    }],
    bills: [{
      id: 'pre', label: 'Pre-payday bills', frequency: 'once',
      date: '2026-08-27', amount: PRE_PAYDAY, confidence: 'confirmed',
    }],
    obligations: [],
    commitments: extra.commitments || [],
    funding: {
      options: extra.fundingOptions || [
        { id: 'amanda', cash: 'amanda-debt-payments', rank: 1, unusable: false },
        {
          id: 'heloc', debtId: 'heloc', rank: 2, unusable: false,
          label: 'Draw on the HELOC', short: 'a HELOC draw',
        },
        { id: 'overdraft', cash: 'chequing-b', rank: 3, unusable: true },
        { id: 'cards', rank: 4, unusable: true },
      ],
    },
  };
  const debts = extra.debts || [
    { id: 'heloc', balance: HELOC_POSTED, pending: 0, limit: HELOC_LIMIT, secured: true, rate: 4.9 },
    { id: 'card', balance: 100, pending: 0, pendingUnknown: false, secured: false, limit: 200 },
  ];
  const extraFacilities = extra.extraFacilities || [
    { id: 'overdraft', cash: 'chequing-b', limit: 600, pending: 0 },
  ];
  return { plan, debts, extraFacilities };
}

function recommend(data, extraOpts) {
  return F.recommend(data.plan, AS_OF, Object.assign({
    fundingSources: data.plan.funding.options,
    debts: data.debts,
    extraFacilities: data.extraFacilities,
    targetBuffer: BUFFER,
  }, extraOpts || {}));
}

console.log('=== independent fixture matches the live-equivalent gap ===');
{
  const data = fixture();
  const spend = data.plan.startingCash.breakdown
    .filter(b => b && (b.id === 'chequing-a' || b.id === 'chequing-b'))
    .reduce((s, b) => s + b.value, 0);
  const breakdown = data.plan.startingCash.breakdown.reduce((s, b) => s + b.value, 0);
  ok(near(spend, CASH), 'opening cash is independently $747.23 chequing-only', String(spend));
  ok(near(breakdown, BREAKDOWN_TOTAL),
    'designated savings remains on the breakdown ($747.81 total)', String(breakdown));
  ok(near(HELOC_ROOM, 2167.84), 'HELOC headroom is independently $2,167.84', String(HELOC_ROOM));
  const zero = F.simulate(data.plan, AS_OF, { weeklyVariable: 0, targetBuffer: BUFFER });
  ok(near(zero.min.balance, FLOOR) && zero.min.date === '2026-08-27',
    'zero-spend floor is independently $395.11 on 27 August',
    `${zero.min.balance} on ${zero.min.date}`);
  ok(near(BUFFER - zero.min.balance, GAP),
    'buffer gap is independently $104.89', String(BUFFER - zero.min.balance));
  const sources = F.resolveFundingSources(
    data.plan.funding.options, data.extraFacilities, data.plan, data.debts);
  ok(near(sources.find(s => s.id === 'amanda').available, 0),
    'Amanda funding is $0');
  ok(near(sources.find(s => s.id === 'heloc').available, HELOC_ROOM),
    'HELOC capacity remains visible on resolveFundingSources');
  ok(sources.find(s => s.id === 'overdraft').unusable === true
    && sources.find(s => s.id === 'cards').unusable === true,
    'overdraft and cards stay unusable household cash');
}

console.log('\n=== HELOC headroom does not auto-fund the opening gap ===');
{
  const data = fixture();
  const rec = recommend(data);
  ok(rec.mode === 'openingGap', 'mode stays openingGap', rec.mode);
  ok(near(rec.gap.amount, GAP), 'the $104.89 shortfall is preserved', String(rec.gap.amount));
  ok(rec.funding && rec.funding.feasible === false,
    'HELOC capacity alone does not make the gap feasible');
  ok(near(rec.funding.shortfall, GAP),
    'the unfunded recovery shortfall is the independent $104.89',
    String(rec.funding.shortfall));
  ok(near(rec.funding.borrowed, 0) && rec.funding.parts.every(p => !p.debtId),
    'no debtId source is injected', JSON.stringify(rec.funding.parts));
  ok(!(rec.simOptions.injections || []).some(i => i.debtId),
    'recovery injections carry no HELOC draw');
  ok(rec.weekly === 0,
    'no borrowing-enabled weekly cap is published as safe-to-spend',
    `$${rec.weekly}/week`);
  const heloc = rec.funding.sources.find(s => s.id === 'heloc');
  ok(heloc && near(heloc.available, HELOC_ROOM) && heloc.verdict === 'insufficient'
    && near(heloc.contributes, 0),
    'HELOC room stays visible as capacity and is not a cover',
    `${heloc && heloc.verdict} contributes ${heloc && heloc.contributes}`);
  ok(rec.plannedDebt && rec.plannedDebt.permitted === false
    && rec.plannedDebt.borrowed === 0,
    'plannedDebt stays opt-in and is not invented for the gap');
  const mission = F.mission(rec, F.projectDebts(data.plan, data.debts, AS_OF,
    Object.assign({}, rec.simOptions, { weeklyVariable: rec.weekly })));
  ok(mission.parts.some(p => p.id === 'fundingShortfall'),
    'the mission names the funding shortfall');
  ok(!mission.parts.some(p => p.id === 'holdSpending'),
    'the mission does not instruct a weekly spend while the gap is unfunded');
}

console.log('\n=== legacy fundingDebtId cannot authorize an opening-gap draw ===');
{
  const data = fixture();
  const rec = F.recommend(data.plan, AS_OF, {
    debts: data.debts,
    extraFacilities: data.extraFacilities,
    targetBuffer: BUFFER,
    fundingDebtId: 'heloc',
  });
  ok(rec.mode === 'openingGap', 'mode stays openingGap', rec.mode);
  ok(near(rec.gap.amount, GAP), 'the independent $104.89 gap is preserved',
    String(rec.gap && rec.gap.amount));
  ok(rec.plannedDebt && rec.plannedDebt.permitted === false
    && rec.plannedDebt.borrowed === 0,
    'plannedDebt stays unpermitted when only fundingDebtId is supplied');
  ok(rec.funding && rec.funding.feasible === false,
    'the hint does not make the gap feasible');
  ok(near(rec.funding.shortfall, GAP),
    'the unfunded shortfall remains the independent $104.89',
    String(rec.funding && rec.funding.shortfall));
  ok(near(rec.funding.borrowed, 0) && (rec.funding.parts || []).every(p => !p.debtId),
    'no debt injection is created', JSON.stringify(rec.funding && rec.funding.parts));
  ok(!(rec.simOptions.injections || []).some(i => i.debtId),
    'recovery injections carry no HELOC draw');
  ok(rec.weekly === 0,
    'no borrowing-enabled weekly cap is published as safe-to-spend',
    `$${rec.weekly}/week`);
}

console.log('\n=== a usable non-debt cash source may still cover the gap ===');
{
  const data = fixture({
    fundingOptions: [
      {
        id: 'cash-pot', label: 'Owner-authorized cash', short: 'cash',
        available: 200, rank: 1, debtId: null,
      },
      {
        id: 'heloc', debtId: 'heloc', rank: 2, unusable: false,
        label: 'Draw on the HELOC', short: 'a HELOC draw',
      },
    ],
  });
  const rec = recommend(data);
  ok(rec.funding && rec.funding.feasible === true,
    'an explicit cash source that reaches the gap still funds it');
  ok(rec.funding.parts.length === 1 && rec.funding.parts[0].id === 'cash-pot',
    'from the cash source, not the HELOC');
  ok(near(rec.funding.borrowed, 0), 'and nothing is borrowed');
  ok(rec.weekly > 0, 'a cash-funded recovery may still publish a weekly cap',
    `$${rec.weekly}/week`);
  ok(!(rec.simOptions.injections || []).some(i => i.debtId),
    'the cash recovery does not attach a debtId');
}

console.log('\n=== explicitly authorized planned debt still works ===');
{
  const plan = {
    windowDays: 40,
    defaults: { targetBuffer: 500 },
    startingCash: { amount: 600 },
    income: [{
      id: 'later-cover', label: 'Later cover', frequency: 'once',
      date: '2026-09-10', amount: 2500, confidence: 'confirmed',
    }],
    obligations: [],
    bills: [],
    commitments: [{
      id: 'named-gap', label: 'Named purpose', date: '2026-09-05',
      amount: 2000, confidence: 'confirmed',
    }],
  };
  const debts = [{
    id: 'heloc', balance: HELOC_POSTED, pending: 0, limit: HELOC_LIMIT,
    secured: true, rate: 4.9,
  }];
  const permitted = F.plannedDebt(plan, AS_OF, {
    allowPlannedDebt: true,
    plannedDebtFacility: 'heloc',
    plannedDebtPurposes: ['named-gap'],
    plannedDebtPayment: 200,
    debts,
    weeklyVariable: 0,
    targetBuffer: 500,
  });
  ok(permitted.permitted === true && permitted.borrowed > 0,
    'named planned-debt still draws when explicitly permitted',
    String(permitted.borrowed));
  ok(permitted.draws && permitted.draws[0] && permitted.draws[0].id === 'named-gap',
    'the draw stays purpose-specific');
  const denied = F.plannedDebt(plan, AS_OF, { debts, weeklyVariable: 0, targetBuffer: 500 });
  ok(denied.permitted === false && denied.borrowed === 0,
    'default plannedDebt still invents no permission');
}

console.log('\n=== no sources declared at all — omitted and empty fail closed (ATLAS-076) ===');
{
  // A caller that declares no funding sources has not authorized any
  // money. Absent or empty fundingSources must behave exactly like the
  // declared genuine-zero source below: no invented part, the full gap
  // stays an unfunded shortfall, nothing enters the recovery sim, and
  // no weekly cap is published off the unfunded gap.
  const omittedData = fixture();
  delete omittedData.plan.funding;
  const omitted = F.recommend(omittedData.plan, AS_OF, {
    debts: omittedData.debts,
    extraFacilities: omittedData.extraFacilities,
    targetBuffer: BUFFER,
  });
  ok(omitted.mode === 'openingGap', 'omitted: mode stays openingGap', omitted.mode);
  ok(near(omitted.gap.amount, GAP), 'omitted: the $104.89 gap is preserved',
    String(omitted.gap.amount));
  ok(omitted.funding && omitted.funding.feasible === false,
    'omitted: no declared sources cannot make the gap feasible');
  ok(near(omitted.funding.shortfall, GAP),
    'omitted: the unfunded shortfall is the full $104.89',
    String(omitted.funding.shortfall));
  ok((omitted.funding.parts || []).length === 0
    && !(omitted.funding.parts || []).some(p => p.id === 'gapFunding'),
    'omitted: no unattributed gapFunding part is invented',
    JSON.stringify(omitted.funding.parts));
  ok(near(omitted.funding.allocated, 0) && near(omitted.funding.borrowed, 0),
    'omitted: nothing is allocated or borrowed');
  ok((omitted.simOptions.injections || []).length === 0,
    'omitted: no phantom injection enters the recovery sim',
    JSON.stringify(omitted.simOptions.injections));
  ok(omitted.weekly === 0,
    'omitted: no weekly cap is published off an unfunded gap',
    `$${omitted.weekly}/week`);

  const emptyData = fixture();
  delete emptyData.plan.funding;
  const empty = F.recommend(emptyData.plan, AS_OF, {
    fundingSources: [],
    debts: emptyData.debts,
    extraFacilities: emptyData.extraFacilities,
    targetBuffer: BUFFER,
  });
  ok(empty.mode === 'openingGap', 'empty: mode stays openingGap', empty.mode);
  ok(empty.funding && empty.funding.feasible === false,
    'empty: an empty source list cannot make the gap feasible');
  ok(near(empty.funding.shortfall, GAP),
    'empty: the unfunded shortfall is the full $104.89',
    String(empty.funding.shortfall));
  ok((empty.funding.parts || []).length === 0
    && !(empty.funding.parts || []).some(p => p.id === 'gapFunding'),
    'empty: no unattributed gapFunding part is invented',
    JSON.stringify(empty.funding.parts));
  ok((empty.simOptions.injections || []).length === 0,
    'empty: no phantom injection enters the recovery sim',
    JSON.stringify(empty.simOptions.injections));
  ok(empty.weekly === 0,
    'empty: no weekly cap is published off an unfunded gap',
    `$${empty.weekly}/week`);

  const zeroData = fixture();
  const zeroDecl = F.recommend(zeroData.plan, AS_OF, {
    fundingSources: [{
      id: 'zero-pot', label: 'Cash pot', short: 'cash pot',
      available: 0, rank: 1, debtId: null,
    }],
    debts: zeroData.debts,
    extraFacilities: zeroData.extraFacilities,
    targetBuffer: BUFFER,
  });
  ok(zeroDecl.funding && zeroDecl.funding.feasible === false
    && near(zeroDecl.funding.shortfall, GAP)
    && (zeroDecl.funding.parts || []).length === 0
    && zeroDecl.weekly === 0,
    'declared genuine zero: infeasible, full shortfall, no parts, no weekly cap');
  ok(omitted.funding.feasible === zeroDecl.funding.feasible
    && near(omitted.funding.shortfall, zeroDecl.funding.shortfall)
    && omitted.funding.parts.length === zeroDecl.funding.parts.length
    && omitted.weekly === zeroDecl.weekly
    && empty.funding.feasible === zeroDecl.funding.feasible
    && near(empty.funding.shortfall, zeroDecl.funding.shortfall)
    && empty.weekly === zeroDecl.weekly,
    'omitted and empty agree with the declared genuine-zero outcome');
}

console.log('\n=== a partial cash source keeps its genuine shortfall (ATLAS-076 control) ===');
{
  const data = fixture();
  const rec = F.recommend(data.plan, AS_OF, {
    fundingSources: [{
      id: 'part-pot', label: 'Cash pot', short: 'cash pot',
      available: 50, rank: 1, debtId: null,
    }],
    debts: data.debts,
    extraFacilities: data.extraFacilities,
    targetBuffer: BUFFER,
  });
  ok(rec.funding && rec.funding.feasible === false,
    'partial: a source short of the gap does not make it feasible');
  ok(near(rec.funding.shortfall, GAP - 50),
    'partial: the genuine shortfall is $54.89', String(rec.funding.shortfall));
  ok(rec.funding.parts.length === 1 && rec.funding.parts[0].id === 'part-pot'
    && near(rec.funding.parts[0].amount, 50),
    'partial: the only part is the declared source at its real amount',
    JSON.stringify(rec.funding.parts));
  ok(near(rec.funding.allocated, 50), 'partial: allocated is the declared $50');
  ok((rec.simOptions.injections || []).length === 1
    && near(rec.simOptions.injections[0].amount, 50)
    && !rec.simOptions.injections[0].debtId,
    'partial: only the declared $50 enters the recovery sim');
  ok(rec.weekly === 0,
    'partial: no weekly cap is published off a shortfall', `$${rec.weekly}/week`);
}


console.log('\n=== overdraft headroom is not cash even without an unusable flag ===');
{
  const asOf = '2026-09-20';
  const extraFacilities = [{ id: 'overdraft', cash: 'chequing-b', limit: 600, pending: 0 }];
  const plan = {
    windowDays: 21, opening: { asOf }, defaults: { targetBuffer: 500 },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 400 }, { id: 'chequing-b', value: 200 }] },
    income: [{ id: 'pay', frequency: 'once', date: '2026-09-28', amount: 3000, confidence: 'confirmed' }],
    bills: [{ id: 'bill', frequency: 'once', date: '2026-09-25', amount: 250, confidence: 'confirmed' }],
    obligations: [], commitments: [],
  };
  const opts = { debts: [], extraFacilities, targetBuffer: 500 };
  const expectedGap = 500 - (400 + 200 - 250);
  const countercases = [
    ['disabled', { id: 'overdraft', cash: 'chequing-b', unusable: true }],
    ['usable', { id: 'overdraft', cash: 'chequing-b', unusable: false }],
    ['flag omitted, matched by cash account', { id: 'facility-alias', cash: 'chequing-b' }],
    ['residual utilisation includes overdraft', { id: 'cards' }],
  ];
  for (const [label, source] of countercases) {
    const rec = F.recommend(plan, asOf, { ...opts, fundingSources: [source] });
    const row = rec.funding?.sources.find(item => item.id === source.id);
    ok(row?.available === 600 && row.contributes === 0 && row.verdict === 'insufficient',
      label + ': headroom is shown, not offered as cash');
    ok(rec.mode === 'openingGap' && rec.funding?.feasible === false
      && rec.funding.shortfall === expectedGap && rec.weekly === 0,
    label + ': the entire gap stays unfunded and weekly stays zero');
    ok(!rec.simOptions?.injections?.length, label + ': there is no recovery injection');
    if (source.unusable !== true) {
      ok(row?.shortBy === expectedGap, label + ': the source is short by the full gap');
    }
    if (source.id === 'cards') {
      const replay = F.recommend(plan, asOf, rec.planOptions);
      ok(replay.funding?.feasible === false && replay.weekly === 0,
        'in-memory rerun does not reinterpret derived capacity as declared cash');
    }
  }
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All opening-gap no-auto-borrow checks passed'));
process.exit(failures === 0 ? 0 : 1);
