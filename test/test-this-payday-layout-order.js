'use strict';
/* This payday printout layout: Current Balance, then pay-period selector;
 * income lines, then Payday balance as the income-card closing total.
 *
 * Presentation only. Forecast still owns period.available / liveCurrentBalance.
 * `node test/test-this-payday-layout-order.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const UI = require('../public/budget-polish.js');
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
    `${source}\n({ calendarIncomeHtml, calendarWaterfallsHtml, money2 });`,
    { Forecast: F }
  );
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

function createElement(doc, tag) {
  const attrs = Object.create(null);
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    parentNode: null,
    childNodes: [],
    get children() { return this.childNodes.filter(node => node.nodeType === 1); },
    get className() { return attrs.class || ''; },
    set className(value) { attrs.class = String(value == null ? '' : value); },
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
    setAttribute(name, value) { attrs[name] = String(value); },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    appendChild(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      el.childNodes.push(node);
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
  };
  return el;
}

function stubWaterfall() {
  const doc = {
    createElement(tag) { return createElement(doc, tag); },
  };
  const waterfall = createElement(doc, 'section');
  waterfall.setAttribute('data-calendar-waterfall', 'this-pay-period');
  const q = (number, prompt, inner) => {
    const wrap = createElement(doc, 'div');
    wrap.setAttribute('data-operating-question', number);
    wrap.setAttribute('data-operating-prompt', prompt);
    const answer = createElement(doc, 'div');
    answer.className = 'operating-answer';
    inner.forEach(node => answer.appendChild(node));
    wrap.appendChild(answer);
    waterfall.appendChild(wrap);
    return wrap;
  };
  const incomeLine = createElement(doc, 'div');
  incomeLine.setAttribute('data-period-income', 'payroll');
  const payday = createElement(doc, 'p');
  payday.setAttribute('data-payday-balance', '');
  q('02', 'Income', [incomeLine, payday]);
  q('04', 'Bills', []);
  q('05', 'Balance after bills', []);
  q('06', 'Household budget', []);
  q('07', 'Balance After Deductions', []);

  return { doc, waterfall };
}

const composer = loadComposer();
const planSrc = read('public/plan.js');
const polishSrc = read('public/budget-polish.js');

console.log('=== 1. Pay-period selector prints before Current Balance ===');
{
  const html = composer.calendarWaterfallsHtml({
    calendarPeriods: [
      { id: 'this-pay-period', label: 'This Pay Period', role: 'active', income: [], bills: [], householdBudget: [] },
      { id: 'next-pay-period', label: 'Next Pay Period', role: 'next', income: [], bills: [], householdBudget: [] },
    ],
    activeCalendarPeriodId: 'this-pay-period',
    liveCurrentBalance: 412.30,
  }, 'this-pay-period', null, { liveCurrentBalance: 412.30 });
  const pickerAt = html.indexOf('data-calendar-period-picker');
  const liveAt = html.indexOf('data-live-current-balance');
  const cardAt = html.indexOf('data-calendar-waterfall="this-pay-period"');
  ok(liveAt >= 0 && pickerAt > liveAt && cardAt > pickerAt,
    'Current Balance, then selector, then the payday snapshot');
  ok(/Current Balance/.test(html.slice(liveAt, cardAt))
      && html.slice(liveAt, cardAt).includes(composer.money2(412.30)),
    'Current Balance content is unchanged and still sits above the snapshot');
  const waterfallsFn = grab(planSrc, /^function calendarWaterfallsHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallsHtml');
  ok(/calendarPickerHtml\(view, pick, extraControls\)/.test(waterfallsFn)
      && waterfallsFn.indexOf('liveCurrentBalanceHtml') < waterfallsFn.indexOf('calendarPickerHtml'),
    'calendarWaterfallsHtml prints live Current Balance before the picker');
}

console.log('\n=== 2. Income card closes with Payday balance under income lines ===');
{
  const html = composer.calendarIncomeHtml({
    available: 100.5,
    income: [
      {
        id: 'payroll', label: 'Dale salary', incomeClass: 'dale',
        amount: 60, glanceKind: 'in', movement: 60,
      },
      {
        id: 'amandaSalary', label: 'Amanda salary', incomeClass: 'amanda',
        amount: 40.5, glanceKind: 'in', movement: 40.5,
      },
    ],
    otherIncome: { amount: 0, items: [] },
  });
  const daleAt = html.indexOf('data-period-income="payroll"');
  const amandaAt = html.indexOf('data-period-income="amandaSalary"');
  const paydayAt = html.indexOf('data-payday-balance');
  ok(daleAt >= 0 && amandaAt > daleAt && paydayAt > amandaAt,
    'named income lines print, then Payday balance as the closing total');
  ok(/Payday balance/.test(html)
      && html.includes(composer.money2(100.5))
      && /payday-totals/.test(html)
      && !/Balance after income/.test(html),
    'closing total reprints Forecast period.available as Payday balance');
  const incomeFn = grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml');
  ok(/period\.available/.test(incomeFn)
      && /data-payday-balance/.test(incomeFn)
      && /payday-totals/.test(incomeFn)
      && /Payday balance/.test(incomeFn),
    'plan.js still renders Forecast available as the income-card Payday balance');
}

console.log('\n=== 3. Operating polish leaves Payday balance inside the income card ===');
{
  ok(!/atlas-period-summary/.test(polishSrc) && !/atlas-payday-summary/.test(polishSrc),
    'polish no longer builds a top-glance payday summary');
  const { doc, waterfall } = stubWaterfall();
  ok(UI.decorateWaterfall(doc, waterfall) === true, 'decorateWaterfall still groups the snapshot');
  const payday = waterfall.querySelector('[data-payday-balance]');
  const incomeCard = waterfall.querySelector('.atlas-income-card');
  const incomeLine = waterfall.querySelector('[data-period-income="payroll"]');
  ok(payday && incomeCard && incomeCard.querySelector('[data-payday-balance]') === payday,
    'Payday balance stays inside the income card after polish');
  ok(!waterfall.querySelector('[data-atlas-period-summary]')
      && !waterfall.querySelector('[data-atlas-payday-summary]'),
    'no duplicate payday glance is created above income');
  ok(payday.classList.contains('atlas-income-closing'),
    'polish marks the incumbent closing total in place');
  const kids = incomeCard && incomeCard.children || [];
  const incomeQ = kids[0];
  ok(incomeQ && incomeLine && payday
      && descendants(incomeQ).indexOf(incomeLine) < descendants(incomeQ).indexOf(payday),
    'after polish, income lines still precede Payday balance');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
