'use strict';
// #727: execute the real Budget and Plan Spend entries on invented inputs.
// This is VM/recording-DOM proof, not browser layout or physical-device proof.
// Independent fixture arithmetic: 3,000 buffer - 1,110 zero-spend floor =
// 1,890 unfunded. Missing presentation copy must never stop the later refusal.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const F = require('../public/forecast');
const Capture = require('../scripts/figures-page-capture');
const fx = require('./fixtures/budget-surface-data');

const HOLD = 'Additional savings proposals are withheld until the funding plan accounts for existing assignments and the cash used to pay each cost.';
const SHAPES = [
  ['absent funding', plan => { delete plan.funding; }],
  ['null funding', plan => { plan.funding = null; }],
  ['empty options', plan => { plan.funding = { heading: 'Invented heading', note: 'Invented note', options: [] }; }],
  ['missing options', plan => { plan.funding = { heading: 'Invented heading', note: 'Invented note' }; }],
  ['null options', plan => { plan.funding = { heading: 'Invented heading', note: 'Invented note', options: null }; }],
];

function input(shape) {
  const data = fx.served({ withheldSavings: true });
  data.plan.defaults.targetBuffer = 3000;
  shape(data.plan);
  return data;
}

function declared(plan) {
  plan.startingCash.heldElsewhere = [{ id: 'invented-held', value: 20000 }];
  plan.funding = { heading: 'Invented heading', note: 'Invented note', options: [{
    id: 'invented-cash', cash: 'invented-held', available: 2500, rank: 1,
    unusable: false, label: 'Invented cash source', short: 'invented cash', note: 'Invented only',
  }] };
}

function capture(data) {
  const contexts = {};
  const result = Capture.capturePages(data, null, undefined, {
    recordHtml: true, instrument: false, anchors: false, gates: false,
    states: [{ id: 'default' }],
    onPageContext(context, page) { contexts[page] = context; },
  });
  for (const run of result.runs) {
    assert.deepEqual(run.loadErrors, [], `${run.page}: no script-load errors`);
    assert.equal(run.states[0].error, null, `${run.page}: entry booted`);
  }
  return { contexts, budget: result.runs.find(run => run.page === 'budget').states[0].html,
    spend: result.runs.find(run => run.page === 'planSpend').states[0].html };
}

function assertUnfunded(html, label) {
  const refusal = html['payday-answer-body'] || '';
  assert.match(refusal, /class="payday-refuse"/, `${label}: Budget completed the entry and rendered the refusal`);
  assert.match(refusal, /no feasible weekly cap/i, `${label}: refusal is explicit`);
  assert.match(refusal, /\$1,890\.00/, `${label}: refusal preserves the whole unfunded gap`);
  assert.doesNotMatch(refusal, /class="payday-hero"/, `${label}: no supported-spending hero`);
  assert.match(html['status-band'], /Every usable source combined reaches\s*\$0\.00/);
  assert.match(html['status-band'], /\$1,890\.00/);
  assert.doesNotMatch(JSON.stringify(html), /Gap funding|Invented cash source/,
    `${label}: neither an invented source nor a stale funded event`);
  assert.match(html['savings-inventory'], /data-savings-instructions="withheld"/);
  assert.ok(html['savings-inventory'].includes(HOLD), `${label}: Savings hold wording is unchanged`);
}

for (const [label, shape] of SHAPES) {
  test(`${label}: page entries preserve the refusal, hold and absence of funding`, () => {
    const data = input(shape);
    const before = JSON.stringify(data);
    const advice = F.recommend(data.plan, data.meta.asOf, {
      targetBuffer: 3000, fundingSources: data.plan.funding && data.plan.funding.options,
    });
    assert.equal(advice.gap.amount, 1890);
    assert.equal(advice.funding.shortfall, 1890);
    assert.deepEqual(advice.funding.parts, []);
    assert.deepEqual(advice.funding.sources, []);
    assert.deepEqual(advice.simOptions.injections || [], []);
    const rendered = capture(data);
    assertUnfunded(rendered.budget, label);
    assert.ok(rendered.spend['savings-inventory'].includes(HOLD), `${label}: Plan Spend retains its hold`);
    assert.equal(JSON.stringify(data), before, `${label}: served input is unchanged`);
  });
}

test('declared source still renders and funded-to-missing rerender clears its copy', () => {
  const data = input(declared);
  const { contexts, budget } = capture(data);
  assert.match(budget['funding-options'], /Invented cash source/);
  assert.match(budget['payday-answer-body'], /class="payday-hero"/);
  assert.doesNotMatch(budget['payday-answer-body'], /class="payday-refuse"/);
  for (const [label, shape] of SHAPES) {
    const next = input(shape);
    // Same loaded page, a new served generation: drive its own rerender.
    const html = vm.runInContext(`Object.assign(App.data, JSON.parse(${JSON.stringify(JSON.stringify(next))}));
      App.rerender();
      Object.fromEntries(['payday-answer-body', 'status-band', 'savings-inventory', 'funding-options']
        .map(id => [id, id === 'funding-options' && document.getElementById('funding').hidden
          ? '' : document.getElementById(id).innerHTML]));`, contexts.budget);
    assertUnfunded(html, `${label} after funded`);
    assert.doesNotMatch(html['funding-options'] || '', /class="fund /,
      `${label}: no stale source card remains after rerender`);
  }
});
