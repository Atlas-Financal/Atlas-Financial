'use strict';
/* Household payday sheet: calendarWaterfallsHtml must NOT print
 * `.operating-cash-explanation` / `[data-operating-cash-explanation]`
 * under Q07, even when period.operatingCashExplanation is present.
 *
 * Synthetic polish tests that construct the node themselves still prove
 * Q07-then-explanation grouping when the node exists. Missing explanation
 * does not break polish.
 *
 * Independent of Forecast. Uses `plan.js` `calendarWaterfallsHtml` markup
 * (the bytes the household page emits), then the live polish path
 * (`boot` → MutationObserver → `enhance`) to prove absence.
 *
 * `node test/test-operating-cash-explanation-placement.js`
 */
const UI = require('../public/budget-polish.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

function grab(src, re, label) {
  const match = re.exec(src);
  if (!match) throw new Error('missing ' + label);
  return match[0];
}

function descendants(root) {
  const out = [];
  const walk = node => {
    for (const child of node.childNodes || []) {
      if (child.nodeType === 1) {
        out.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

function matches(el, selector) {
  const sel = String(selector || '').trim();
  if (!sel || /[\s>+~]/.test(sel.replace(/\[[^\]]*]/g, ''))) return false;
  let rest = sel;
  while (rest) {
    if (rest[0] === '.') {
      const cls = /^\.([\w-]+)/.exec(rest);
      if (!cls || !el.classList.contains(cls[1])) return false;
      rest = rest.slice(cls[0].length);
      continue;
    }
    if (rest[0] === '[') {
      const attr = /^\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/.exec(rest);
      if (!attr || !el.hasAttribute(attr[1].trim())) return false;
      if (attr[2] != null || attr[3] != null || attr[4] != null) {
        const expected = attr[2] != null ? attr[2] : attr[3] != null ? attr[3] : attr[4];
        if (el.getAttribute(attr[1].trim()) !== expected) return false;
      }
      rest = rest.slice(attr[0].length);
      continue;
    }
    return false;
  }
  return true;
}

function decodeEntities(value) {
  return String(value == null ? '' : value)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function createElement(doc, tag) {
  const attrs = Object.create(null);
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    parentNode: null,
    childNodes: [],
    get parentElement() {
      const parent = this.parentNode;
      return parent && parent.nodeType === 1 ? parent : null;
    },
    get children() { return this.childNodes.filter(node => node.nodeType === 1); },
    get className() { return attrs.class || ''; },
    set className(value) { attrs.class = String(value == null ? '' : value); },
    get nextSibling() {
      const parent = this.parentNode;
      if (!parent) return null;
      const index = parent.childNodes.indexOf(this);
      return index >= 0 ? parent.childNodes[index + 1] || null : null;
    },
    get nextElementSibling() {
      const parent = this.parentNode;
      if (!parent) return null;
      const kids = parent.children;
      const index = kids.indexOf(this);
      return index >= 0 ? kids[index + 1] || null : null;
    },
    classList: {
      add(name) {
        const parts = String(attrs.class || '').split(/\s+/).filter(Boolean);
        if (!parts.includes(name)) parts.push(name);
        attrs.class = parts.join(' ');
      },
      contains(name) {
        return String(attrs.class || '').split(/\s+/).includes(name);
      },
    },
    matches(sel) { return matches(el, sel); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    setAttribute(name, value) {
      const key = String(name);
      attrs[key] = String(value);
      if (key === 'id' && doc && doc._ids) doc._ids.set(String(value), el);
    },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    appendChild(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      el.childNodes.push(node);
      node.parentNode = el;
      return node;
    },
    insertBefore(node, ref) {
      if (ref == null) return el.appendChild(node);
      if (node.parentNode) node.parentNode.removeChild(node);
      const index = el.childNodes.indexOf(ref);
      if (index < 0) throw new Error('not a child');
      el.childNodes.splice(index, 0, node);
      node.parentNode = el;
      return node;
    },
    removeChild(node) {
      const index = el.childNodes.indexOf(node);
      if (index < 0) throw new Error('not a child');
      el.childNodes.splice(index, 1);
      node.parentNode = null;
      return node;
    },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { return descendants(el).filter(node => node.matches(sel)); },
    set innerHTML(html) {
      el.childNodes.slice().forEach(child => el.removeChild(child));
      parseFragment(doc, html).childNodes.slice().forEach(child => el.appendChild(child));
    },
  };
  return el;
}

function parseFragment(doc, html) {
  const root = createElement(doc, 'div');
  const stack = [root];
  const src = String(html == null ? '' : html);
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = token.exec(src))) {
    if (m[0].slice(0, 4) === '<!--') continue;
    if (m[1]) {
      const wanted = String(m[1]).toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === wanted) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (m[2]) {
      const raw = String(m[3] || '');
      const selfClose = /\/\s*$/.test(raw) || VOID.has(String(m[2]).toLowerCase());
      const node = createElement(doc, m[2]);
      const attrRe = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let attr;
      const attrSrc = raw.replace(/\/\s*$/, '');
      while ((attr = attrRe.exec(attrSrc))) {
        const name = attr[1];
        const value = attr[2] != null ? attr[2]
          : attr[3] != null ? attr[3]
            : attr[4] != null ? attr[4]
              : '';
        node.setAttribute(name, decodeEntities(value));
        if (name === 'class') node.className = decodeEntities(value);
      }
      stack[stack.length - 1].appendChild(node);
      if (!selfClose) stack.push(node);
      continue;
    }
    if (m[4] && /\S/.test(m[4])) {
      stack[stack.length - 1].childNodes.push({
        nodeType: 3,
        parentNode: stack[stack.length - 1],
        textContent: m[4],
      });
    }
  }
  return root;
}

function createDocument() {
  const ids = new Map();
  const doc = {
    _ids: ids,
    createElement(tag) { return createElement(doc, tag); },
    getElementById(id) { return ids.get(String(id)) || null; },
  };
  return doc;
}

function nextElementSibling(node) {
  const parent = node && node.parentNode;
  if (!parent) return null;
  const kids = parent.children;
  const index = kids.indexOf(node);
  return index >= 0 ? kids[index + 1] || null : null;
}

function treeIndex(root, node) {
  return descendants(root).indexOf(node);
}

function textOf(node) {
  if (!node) return '';
  if (node.nodeType === 3) return String(node.textContent || '');
  return (node.childNodes || []).map(textOf).join('');
}

function liveSourceWaterfall() {
  const doc = createDocument();
  const waterfall = createElement(doc, 'section');
  waterfall.setAttribute('data-calendar-waterfall', 'this-pay-period');
  const q = number => {
    const wrap = createElement(doc, 'div');
    wrap.setAttribute('data-operating-question', number);
    waterfall.appendChild(wrap);
    return wrap;
  };
  q('02');
  q('04');
  q('05');
  q('06');
  const afterBudget = q('07');
  const explanation = createElement(doc, 'div');
  explanation.className = 'operating-cash-explanation';
  explanation.setAttribute('data-operating-cash-explanation', '');
  explanation.setAttribute('data-same-contract', 'false');
  waterfall.appendChild(explanation);
  return { doc, waterfall, afterBudget, explanation };
}

function loadComposer() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
    grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
    grab(planSrc, /^function paydayGlanceCashNote\([\s\S]*?\n\}$/m, 'paydayGlanceCashNote'),
    grab(planSrc, /^function providerBalanceDate\([\s\S]*?\n\}$/m, 'providerBalanceDate'),
    grab(planSrc, /^function glanceUpdatedNote\([\s\S]*?\n\}$/m, 'glanceUpdatedNote'),
    grab(planSrc, /^function glanceSignedMoney\([\s\S]*?\n\}$/m, 'glanceSignedMoney'),
    grab(planSrc, /^function glanceMoney\([\s\S]*?\n\}$/m, 'glanceMoney'),
    grab(planSrc, /^function glanceLineLabel\([\s\S]*?\n\}$/m, 'glanceLineLabel'),
    grab(planSrc, /^function cashGlanceHtml\([\s\S]*?\n\}$/m, 'cashGlanceHtml'),
    grab(planSrc, /^function liveCurrentBalanceHtml\([\s\S]*?\n\}$/m, 'liveCurrentBalanceHtml'),
    grab(planSrc, /^function runningLeftoverHtml\([\s\S]*?\n\}$/m, 'runningLeftoverHtml'),
    grab(planSrc, /^function operatingCashExplanationHtml\([\s\S]*?\n\}$/m, 'operatingCashExplanationHtml'),
    grab(planSrc, /^function periodBillLine\([\s\S]*?\n\}$/m, 'periodBillLine'),
    grab(planSrc, /^function calendarCurrentUnavailableHtml\([\s\S]*?\n\}$/m, 'calendarCurrentUnavailableHtml'),
    grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml'),
    grab(planSrc, /^function householdBudgetCycleText\([\s\S]*?\n\}$/m, 'householdBudgetCycleText'),
    grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
    grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml'),
    grab(planSrc, /^function calendarBudgetHtml\([\s\S]*?\n\}$/m, 'calendarBudgetHtml'),
    grab(planSrc, /^function calendarPeriodBillsHtml\([\s\S]*?\n\}$/m, 'calendarPeriodBillsHtml'),
    grab(planSrc, /^function extraRepaymentHtml\([\s\S]*?\n\}$/m, 'extraRepaymentHtml'),
    grab(planSrc, /^function calendarFromTodayEvidenceHtml\([\s\S]*?\n\}$/m, 'calendarFromTodayEvidenceHtml'),
    grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml'),
    grab(planSrc, /^function calendarPickerHtml\([\s\S]*?\n\}$/m, 'calendarPickerHtml'),
    grab(planSrc, /^function calendarWaterfallsHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallsHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({ calendarWaterfallsHtml, operatingCashExplanationHtml, money2 });`,
    { Forecast: F }
  );
}

function explanationPacket() {
  return {
    sameContract: false,
    leftover: 50,
    leftoverNote: 'Leftover of this payday\'s income after bills and the Household Budget hold. Not cash in the operating accounts.',
    operatingCash: 40,
    operatingCashNote: 'Posted BILLS ACCOUNT plus WEEKLY SPENDING. Not leftover.',
    movements: [{
      operatingCashEffect: 'leaves-operating-cash',
      operatingCashEffectNote: 'Left Current Balance into designated savings. Not leftover spending. Household cash is conserved.',
      sourceLabel: 'Chequing A',
      destinationLabel: 'Savings',
    }],
  };
}

function periodFixture(withExplanation) {
  const period = {
    id: 'this-pay-period',
    role: 'active',
    label: 'This Pay Period',
    rangeLabel: 'Sep 11–Sep 24',
    income: [],
    bills: [],
    householdBudget: [],
    afterBills: 100,
    afterHouseholdBudget: 50,
    available: 150,
  };
  if (withExplanation) period.operatingCashExplanation = explanationPacket();
  return period;
}

function planPaydaySheetHtml(withExplanation) {
  const composer = loadComposer();
  return composer.calendarWaterfallsHtml({
    calendarPeriods: [
      periodFixture(withExplanation),
      {
        id: 'next-pay-period',
        role: 'next',
        label: 'Next Pay Period',
        rangeLabel: 'Sep 25–Oct 8',
        income: [],
        bills: [],
        householdBudget: [],
      },
    ],
    activeCalendarPeriodId: 'this-pay-period',
    liveCurrentBalance: 40,
    asOf: '2026-09-20',
  }, 'this-pay-period', null, { liveCurrentBalance: 40, asOf: '2026-09-20' });
}

function mountPaydayBody(doc, html) {
  const body = createElement(doc, 'div');
  body.setAttribute('id', 'operating-surface-body');
  const sheet = createElement(doc, 'div');
  sheet.className = 'payday-operating-sheet';
  sheet.setAttribute('data-payday-sheet', '');
  body.appendChild(sheet);
  sheet.innerHTML = html;
  return body;
}

// Legacy grouping still supports its delayed-explanation path. Keep that
// fixture explicit now that the production composer emits native disclosures.
function legacyPaydaySheetHtml() {
  return `<div data-calendar-waterfalls><section data-calendar-waterfall="this-pay-period">
    ${['02', '04', '05', '06', '07'].map(number =>
      `<div data-operating-question="${number}"></div>`).join('')}
  </section></div>`;
}

function withMutationObserver(fn) {
  const orig = global.MutationObserver;
  const observers = [];
  global.MutationObserver = function MutationObserver(cb) {
    const obs = {
      cb,
      observe() {},
      disconnect() {},
      fire() { cb(); },
    };
    observers.push(obs);
    return obs;
  };
  try {
    return fn(observers);
  } finally {
    global.MutationObserver = orig;
  }
}

function assertLiveOrder(root, label) {
  const q07 = root.querySelector('[data-operating-question="07"]');
  const expl = root.querySelector('.operating-cash-explanation')
    || root.querySelector('[data-operating-cash-explanation]');
  const incomeCard = root.querySelector('.atlas-income-card');
  const billsCard = root.querySelector('.atlas-bills-card');
  const budgetCard = root.querySelector('.atlas-household-budget-card');
  const current = root.querySelector('[data-live-current-balance]');
  ok(q07 && expl && budgetCard && incomeCard && billsCard,
    `${label}: polish grouped Income/Bills/Household and kept Q07 plus the explanation`);
  ok(budgetCard && q07 && expl
      && q07.parentNode === budgetCard && expl.parentNode === budgetCard,
    `${label}: Q07 and the explanation live in the household-budget card`);
  ok(q07 && expl && nextElementSibling(q07) === expl,
    `${label}: explanation is immediately after Q07`);
  const q07At = treeIndex(root, q07);
  const explAt = treeIndex(root, expl);
  const incomeAt = treeIndex(root, incomeCard);
  const billsAt = treeIndex(root, billsCard);
  const currentAt = current ? treeIndex(root, current) : -1;
  ok(q07At >= 0 && explAt > q07At,
    `${label}: tree order keeps Q07 before the explanation`);
  ok(incomeAt >= 0 && billsAt > incomeAt && explAt > billsAt && explAt > incomeAt,
    `${label}: explanation is not left before Income/Bills (the live smoke failure)`);
  ok(currentAt < 0 || (explAt > currentAt && incomeAt > currentAt && explAt > incomeAt),
    `${label}: explanation is not under Current Balance before Income`);
}

console.log('=== Source sibling order matches plan.js (Q07 then explanation) ===');
{
  const { waterfall, afterBudget, explanation } = liveSourceWaterfall();
  ok(nextElementSibling(afterBudget) === explanation,
    'before polish, explanation is the next sibling after Q07');
  ok(waterfall.children.indexOf(afterBudget) < waterfall.children.indexOf(explanation),
    'before polish, Q07 precedes the explanation among waterfall children');
}

console.log('\n=== After decorateWaterfall, live DOM order is still Q07 then explanation ===');
{
  const { doc, waterfall, afterBudget, explanation } = liveSourceWaterfall();
  ok(UI.decorateWaterfall(doc, waterfall) === true, 'decorateWaterfall groups the snapshot');

  const q07 = waterfall.querySelector('[data-operating-question="07"]');
  const expl = waterfall.querySelector('.operating-cash-explanation');
  const incomeCard = waterfall.querySelector('.atlas-income-card');
  const billsCard = waterfall.querySelector('.atlas-bills-card');
  const budgetCard = waterfall.querySelector('.atlas-household-budget-card');

  ok(q07 === afterBudget && expl === explanation,
    'polish rearranges existing nodes; it does not clone Q07 or the explanation');
  ok(budgetCard && q07.parentNode === budgetCard && expl.parentNode === budgetCard,
    'Q07 and the explanation live in the household-budget card');
  ok(q07 && expl && q07.parentNode === expl.parentNode,
    'Q07 and the explanation remain siblings after polish');
  ok(nextElementSibling(q07) === expl,
    'explanation is immediately after Q07 after decorateWaterfall');

  const q07At = treeIndex(waterfall, q07);
  const explAt = treeIndex(waterfall, expl);
  const incomeAt = treeIndex(waterfall, incomeCard);
  const billsAt = treeIndex(waterfall, billsCard);
  ok(q07At >= 0 && explAt > q07At,
    'tree order keeps Q07 before the explanation');
  ok(incomeAt >= 0 && billsAt > incomeAt && explAt > billsAt && explAt > incomeAt,
    'explanation is not left before Income/Bills (the live smoke failure)');
  const budgetKids = budgetCard && budgetCard.children || [];
  const q06 = waterfall.querySelector('[data-operating-question="06"]');
  ok(budgetKids[0] === q06 && budgetKids[1] === q07 && budgetKids[2] === expl,
    'household-budget card children are Q06, Q07, then explanation');
}

console.log('\n=== Missing explanation does not break polish ===');
{
  const doc = createDocument();
  const waterfall = createElement(doc, 'section');
  waterfall.setAttribute('data-calendar-waterfall', 'this-pay-period');
  ['02', '04', '05', '06', '07'].forEach(number => {
    const wrap = createElement(doc, 'div');
    wrap.setAttribute('data-operating-question', number);
    waterfall.appendChild(wrap);
  });
  ok(UI.decorateWaterfall(doc, waterfall) === true,
    'decorateWaterfall still groups a snapshot with no explanation');
  const budgetCard = waterfall.querySelector('.atlas-household-budget-card');
  ok(budgetCard
      && budgetCard.querySelector('[data-operating-question="07"]')
      && !budgetCard.querySelector('.operating-cash-explanation'),
    'household-budget card still closes at Q07 when there is nothing to reprint');
}

console.log('\n=== plan.js markup does not print the explanation under Q07 ===');
{
  const html = planPaydaySheetHtml(true);
  ok(!/data-operating-cash-explanation/.test(html)
      && !/class="operating-cash-explanation"/.test(html)
      && !/operating-cash-explanation/.test(html),
    'calendarWaterfallsHtml does not contain the explanation even when period.operatingCashExplanation is present');
  ok(/data-operating-question="07"/.test(html),
    'plan.js still emits Q07 on the household waterfall');

  withMutationObserver(observers => {
    const doc = createDocument();
    const body = createElement(doc, 'div');
    body.setAttribute('id', 'operating-surface-body');
    const observer = UI.boot(doc);
    ok(observer && observers.length === 1,
      'boot on the empty operating surface starts the live MutationObserver');
    ok(!body.querySelector('[data-calendar-waterfall]'),
      'boot does not invent a waterfall before plan.js renders');

    const sheet = createElement(doc, 'div');
    sheet.className = 'payday-operating-sheet';
    sheet.setAttribute('data-payday-sheet', '');
    body.appendChild(sheet);
    sheet.innerHTML = html;
    observers[0].fire();

    const waterfall = body.querySelector('[data-calendar-waterfall="this-pay-period"]');
    ok(waterfall && waterfall.querySelectorAll('.budget-step-details').length === 6
        && !waterfall.hasAttribute('data-atlas-budget-ui'),
      'observer preserves the native plan.js disclosures, including proposed savings');
    const expl = body.querySelector('[data-operating-cash-explanation]')
      || body.querySelector('.operating-cash-explanation');
    const q07 = waterfall.querySelector('[data-operating-question="07"]');
    const budgetCard = waterfall.querySelector('.atlas-household-budget-card');
    ok(q07 && !expl,
      'household UI does not print the explanation under Q07');
    ok(q07 && q07.parentNode === waterfall && !budgetCard
        && !nextElementSibling(q07),
      'native waterfall closes at Q07 without a legacy wrapper or explanation');
  });
}

console.log('\n=== APPLIED before the explanation exists (live timing failure) ===');
{
  withMutationObserver(observers => {
    const doc = createDocument();
    const body = createElement(doc, 'div');
    body.setAttribute('id', 'operating-surface-body');
    UI.boot(doc);
    const sheet = createElement(doc, 'div');
    sheet.className = 'payday-operating-sheet';
    sheet.setAttribute('data-payday-sheet', '');
    body.appendChild(sheet);
    sheet.innerHTML = legacyPaydaySheetHtml();
    observers[0].fire();

    const waterfall = body.querySelector('[data-calendar-waterfall="this-pay-period"]');
    ok(waterfall && waterfall.hasAttribute('data-atlas-budget-ui'),
      'first enhance marks APPLIED on a snapshot that has Q07 but no explanation');
    ok(!waterfall.querySelector('[data-operating-cash-explanation]')
        && !waterfall.querySelector('.operating-cash-explanation'),
      'explanation is absent on that first pass');

    const q07 = waterfall.querySelector('[data-operating-question="07"]');
    const composer = loadComposer();
    const explHtml = composer.operatingCashExplanationHtml(explanationPacket());
    const holder = createElement(doc, 'div');
    holder.innerHTML = explHtml;
    const explanation = holder.children[0];
    ok(explanation && explanation.hasAttribute('data-operating-cash-explanation'),
      'late node is the plan.js explanation markup (boolean data attribute)');
    waterfall.appendChild(explanation);
    ok(explanation.parentNode === waterfall,
      'late insert lands as a waterfall sibling — the Current Balance orphan');

    const second = UI.enhance(doc);
    ok(second === true, 'second enhance still places after APPLIED (does not no-op)');
    ok(q07 && nextElementSibling(q07) === explanation,
      'explanation moves to immediately after Q07 once it exists');
    const budgetCard = waterfall.querySelector('.atlas-household-budget-card');
    ok(budgetCard && explanation.parentNode === budgetCard,
      'late explanation sits inside the household-budget card, not under Current Balance');
  });
}

console.log('\n=== MutationObserver has no plan.js explanation to orphan ===');
{
  const doc = createDocument();
  const body = mountPaydayBody(doc, planPaydaySheetHtml(true));
  ok(UI.enhance(doc) === false,
    'empty-bill native snapshot needs no grouping or bill decoration');
  const waterfall = body.querySelector('[data-calendar-waterfall="this-pay-period"]');
  const expl = body.querySelector('[data-operating-cash-explanation]')
    || body.querySelector('.operating-cash-explanation');
  ok(waterfall && !expl,
    'complete plan.js snapshot has no explanation node to orphan under Current Balance');
  const q07 = waterfall.querySelector('[data-operating-question="07"]');
  const budgetCard = waterfall.querySelector('.atlas-household-budget-card');
  ok(q07 && !budgetCard && q07.parentNode === waterfall,
    'Q07 remains in the native waterfall without legacy grouping');
  ok(q07 && !nextElementSibling(q07),
    'Q07 is the last household-budget question; no explanation sibling');
}

console.log('\n=== Selector: class-only and data-attribute-only nodes both move ===');
{
  const doc = createDocument();
  const waterfall = createElement(doc, 'section');
  waterfall.setAttribute('data-calendar-waterfall', 'this-pay-period');
  ['02', '04', '05', '06', '07'].forEach(number => {
    const wrap = createElement(doc, 'div');
    wrap.setAttribute('data-operating-question', number);
    waterfall.appendChild(wrap);
  });
  const classOnly = createElement(doc, 'div');
  classOnly.className = 'operating-cash-explanation';
  waterfall.appendChild(classOnly);
  ok(UI.decorateWaterfall(doc, waterfall) === true, 'class-only node still groups');
  const q07 = waterfall.querySelector('[data-operating-question="07"]');
  ok(nextElementSibling(q07) === classOnly,
    'class-only explanation still sits immediately after Q07');
}
{
  const doc = createDocument();
  const waterfall = createElement(doc, 'section');
  waterfall.setAttribute('data-calendar-waterfall', 'this-pay-period');
  ['02', '04', '05', '06', '07'].forEach(number => {
    const wrap = createElement(doc, 'div');
    wrap.setAttribute('data-operating-question', number);
    waterfall.appendChild(wrap);
  });
  const attrOnly = createElement(doc, 'div');
  attrOnly.setAttribute('data-operating-cash-explanation', '');
  waterfall.appendChild(attrOnly);
  ok(UI.decorateWaterfall(doc, waterfall) === true, 'data-attribute-only node still groups');
  const q07 = waterfall.querySelector('[data-operating-question="07"]');
  ok(nextElementSibling(q07) === attrOnly,
    'data-attribute-only explanation still sits immediately after Q07');
}

console.log('\n=== Polish still does not invent a leftover/cash gap ===');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/budget-polish.js'), 'utf8');
  ok(!/leftover\s*-/.test(src)
      && !/operatingCash\s*-/.test(src)
      && !/sameContract/.test(src)
      && !/Forecast\s*\./.test(src),
    'placement move does not subtract leftover from cash or call Forecast');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
