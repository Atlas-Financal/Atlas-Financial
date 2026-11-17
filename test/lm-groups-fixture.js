'use strict';
// TEST-ONLY fixture builder for slice 1: budget rows read Lunch Money
// category GROUPS by id (Dale, #821 6958331123). Production never reads a
// category name as routing; tests that build invented transactions by
// category NAME use this to lay those invented categories out in invented
// groups, the way the household lays out groups in Lunch Money.
//
// Each invented category is placed in the group of the row (or excluded
// kind) it reached before group routing, so a migrated test keeps its
// assertions: the same invented row lands on the same budget row. The name
// lists below exist only to build that invented layout. They are fixture
// data, not an Atlas rule, and nothing in public/ or scripts/ reads them.
//
// A category no row or kind claims stays ungrouped, which under Dale's (b)
// is Other spending, counted, with no hand-confirm.

const KIND_LABELS = Object.freeze({
  transfer: ['transfer', 'payment', 'payment, transfer'],
  'card-payment': ['credit card payment', 'cc payment'],
  'debt-payment': ['personal loan payment'],
  mortgage: ['mortgage'],
  refund: ['refund', 'refunds', 'reimbursement'],
  interest: ['interest charge', 'purchase interest', 'cash advance interest', 'cash-advance interest',
    'balance transfer interest', 'bt interest', 'retail interest', 'cash interest', 'finance charge'],
  fee: ['other bank fees'],
  bill: ['bills', 'bill', 'subscription', 'subscriptions', 'insurance', 'telecom', 'telephone', 'natural gas'],
});
const EATING_OUT = ['restaurants', 'fast food', 'food delivery', 'coffee shops'];
const norm = v => String(v == null ? '' : v).trim().toLowerCase();
const FUEL_CATEGORY_ID = 'fixture-category:fuel';
const groupIdFor = key => 'fixture-group:' + key;
const clone = v => JSON.parse(JSON.stringify(v));

// The plan with an invented group on every budget row and excluded entry that
// has none, plus one invented group per excluded kind. Returns a new plan.
function groupPlan(plan) {
  const out = clone(plan || {});
  out.budget = out.budget || {};
  out.budget.categories = (out.budget.categories || []).map(row => (!row || !row.id
    || row.lunchMoneyCategoryGroupId != null) ? row
    : { ...row, lunchMoneyCategoryGroupId: groupIdFor('row:' + row.id) })
    // Fuel evidence is the Fuel category's own id (Grok Bot, "partly"). The
    // pre-slice-1 baseline treated a category named exactly "Fuel" as evidence;
    // its invented id is FUEL_CATEGORY_ID unless a payload names another.
    .map(row => row && row.id === 'fuel' && row.lunchMoneyFuelCategoryId == null
      ? { ...row, lunchMoneyFuelCategoryId: FUEL_CATEGORY_ID } : row);
  const excluded = (out.budget.excluded || []).map((row, i) => (!row || row.lunchMoneyCategoryGroupId != null) ? row
    : { kind: 'business', ...row, lunchMoneyCategoryGroupId: groupIdFor('excluded:' + i) });
  for (const kind of Object.keys(KIND_LABELS)) {
    if (!excluded.some(row => row && row.kind === kind && String(row.lunchMoneyCategoryGroupId).startsWith('fixture-group:kind:'))) {
      excluded.push({ kind, lunchMoneyCategoryGroupId: groupIdFor('kind:' + kind), why: 'Invented fixture group' });
    }
  }
  out.budget.excluded = excluded;
  return out;
}

function aliasesOf(row) {
  return [row.id, row.label].concat(row.historyCategories || row.from || []).map(norm).filter(Boolean);
}

// FROZEN PRE-PR BASELINE, FIXTURE MIGRATION ONLY. This is the name-based
// route Atlas used before slice 1 (category aliases and the retired label
// sets), kept here solely to lay out existing tests' invented categories in
// invented groups so their assertions stay byte-identical. It must never be
// required from public/ or scripts/ (test/test-budget-rows-lm-groups.js
// checks that), must not be extended, and is deleted in slice 1b once tests
// are written in group terms directly (BACKLOG).
function preGroupRouteBaseline(label, plan) {
  const l = norm(label);
  if (!l) return null;
  const rows = ((plan && plan.budget && plan.budget.categories) || []).filter(r => r && r.id);
  const rowGroup = id => { const r = rows.find(x => x.id === id); return r ? r.lunchMoneyCategoryGroupId : null; };
  const kindGroup = kind => groupIdFor('kind:' + kind);
  if (KIND_LABELS.transfer.includes(l)) return kindGroup('transfer');
  if (KIND_LABELS['card-payment'].includes(l)) return kindGroup('card-payment');
  const excluded = ((plan && plan.budget && plan.budget.excluded) || [])
    .findIndex(row => row && !String(row.lunchMoneyCategoryGroupId).startsWith('fixture-group:kind:')
      && [].concat(row.historyCategories || row.from || [], row.label || []).map(norm).includes(l));
  if (excluded >= 0) return plan.budget.excluded[excluded].lunchMoneyCategoryGroupId;
  if (l === 'dale' && rowGroup('dale-guilt-free')) return rowGroup('dale-guilt-free');
  if (l === 'amanda' && rowGroup('amanda-guilt-free')) return rowGroup('amanda-guilt-free');
  if (EATING_OUT.includes(l) && rowGroup('restaurants')) return rowGroup('restaurants');
  const matched = rows.filter(r => aliasesOf(r).includes(l));
  if (matched.length) return matched[0].lunchMoneyCategoryGroupId;
  for (const kind of ['debt-payment', 'mortgage', 'refund', 'interest', 'fee', 'bill']) {
    if (KIND_LABELS[kind].includes(l)) return kindGroup(kind);
  }
  return null;
}

// A transaction with its invented group stamped (a declared one is kept).
function groupTx(tx, plan) {
  if (!tx || typeof tx !== 'object') return tx;
  let out = tx;
  // A hand-built row named exactly "Fuel" is the invented Fuel category
  // (fuel evidence before slice 1 was that exact name).
  const fuelRow = ((plan && plan.budget && plan.budget.categories) || []).find(r => r && r.id === 'fuel');
  if (fuelRow && fuelRow.lunchMoneyFuelCategoryId != null && out.categoryId == null && norm(out.categoryLabel) === 'fuel') {
    out = { ...out, categoryId: fuelRow.lunchMoneyFuelCategoryId };
  }
  if (out.categoryGroupId != null) return out;
  const groupId = groupForLabel(out.categoryLabel, plan);
  return groupId ? { ...out, categoryGroupId: groupId } : out;
}

// Every invented group id the plan names: the groups "Lunch Money returned".
function groupIdsOf(plan) {
  const b = (plan && plan.budget) || {};
  return [...new Set([].concat(b.categories || [], b.excluded || [])
    .map(row => row && row.lunchMoneyCategoryGroupId).filter(id => id != null).map(String))].sort();
}

// A served packet with its transactions grouped and the groups listed.
function groupPacket(packet, plan) {
  if (!packet || typeof packet !== 'object') return packet;
  const out = { ...packet };
  if (Array.isArray(packet.transactions)) out.transactions = packet.transactions.map(tx => groupTx(tx, plan));
  if (!Array.isArray(packet.categoryGroupIds)) out.categoryGroupIds = groupIdsOf(plan);
  return out;
}

// The plan's fuel row names the payload's own invented "Fuel" category (the
// exact name that was fuel evidence before slice 1). The grouped plan passed
// in is updated in place, so the plan and payload a test serves agree.
function pointFuelAt(plan, categories) {
  const fuelRow = ((plan && plan.budget && plan.budget.categories) || []).find(r => r && r.id === 'fuel');
  const named = categories.find(c => c && !c.is_group && norm(c.name) === 'fuel');
  if (fuelRow && named && fuelRow.lunchMoneyFuelCategoryId === FUEL_CATEGORY_ID) fuelRow.lunchMoneyFuelCategoryId = named.id;
}

// A raw Lunch Money payload (as fed to the observer) with its invented
// categories laid out in the plan's invented groups, and one group category
// per invented group, as Lunch Money returns them.
function groupPayload(payload, plan) {
  if (!payload || typeof payload !== 'object') return payload;
  // A raw row that names its category (category_name) without a category_id
  // is a fixture shorthand; real Lunch Money rows carry the id. Give each
  // such invented name an invented category id so it can sit in a group.
  const named = (payload.transactions || []).filter(tx => tx && tx.category_id == null
    && typeof tx.category_name === 'string' && tx.category_name.trim());
  if (!Array.isArray(payload.categories) && !named.length) return payload;
  const base = Array.isArray(payload.categories) ? payload.categories.slice() : [];
  const transactions = (payload.transactions || []).map(tx => {
    if (!named.includes(tx)) return tx;
    const id = 'fixture-category:' + tx.category_name.trim().toLowerCase();
    if (!base.some(c => c && String(c.id) === id)) base.push({ id, name: tx.category_name.trim() });
    return { ...tx, category_id: id };
  });
  const categories = base.map(c => {
    if (!c || c.is_group || c.group_id != null) return c;
    const groupId = groupForLabel(c.name, plan);
    return groupId != null ? { ...c, group_id: groupId } : c;
  });
  for (const id of groupIdsOf(plan)) {
    if (!categories.some(c => c && String(c.id) === id)) categories.push({ id, name: 'Invented group ' + id, is_group: true });
  }
  pointFuelAt(plan, categories);
  return { ...payload, categories, transactions };
}

const groupForLabel = preGroupRouteBaseline;

module.exports = { groupPlan, groupTx, groupPacket, groupPayload, groupForLabel, groupIdsOf, pointFuelAt, KIND_LABELS };
