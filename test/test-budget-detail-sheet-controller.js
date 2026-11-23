'use strict';
// Dependency-free ownership/focus contract tests for the native controller.
// This small DOM double exercises original-node movement and modal events;
// viewport placement and real focus/animation still require browser proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8');
const controller = source.slice(source.indexOf('function budgetDetailSheetController(mount) {'),
  source.indexOf('\nfunction budgetRemount(mount, ctx)'));
const filters = source.slice(source.indexOf('function budgetApplyBillFilter(section, choice) {'),
  source.indexOf('\nfunction wireBudgetBrowse(mount, ctx, sheet)'));
assert.ok(controller.startsWith('function budgetDetailSheetController'));
const cssEscape = value => String(value).replace(/^[0-9]/, digit => '\\' + digit.codePointAt(0).toString(16) + ' ');
const cssUnescape = value => value.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
function selectors(text, separator) {
  let depth = 0, start = 0;
  const result = [];
  for (let i = 0; i < text.length; i++) {
    if ('[('.includes(text[i])) depth++;
    if ('])'.includes(text[i])) depth--;
    if (!depth && text[i] === separator) { result.push(text.slice(start, i)); start = i + 1; }
  }
  result.push(text.slice(start));
  return result.map(value => value.trim()).filter(Boolean);
}
class Element {
  constructor(document, tag, attrs = {}) {
    this.ownerDocument = document; this.tagName = tag; this.attrs = { ...attrs };
    this.children = []; this.parentNode = null; this.listeners = new Map();
    this.hidden = false; this.inert = false; this.disabled = false; this.open = false;
    this.scrollTop = 0; this.textContent = ''; this.tabIndex = ['button', 'summary'].includes(tag) ? 0 : -1;
    const classes = new Set((attrs.class || '').split(' ').filter(Boolean));
    this.classList = { contains: value => classes.has(value), add: value => classes.add(value),
      remove: value => classes.delete(value), toggle: (value, on) => {
        const yes = on === undefined ? !classes.has(value) : on;
        if (yes) classes.add(value); else classes.delete(value); return yes;
      } };
  }
  get isConnected() { return this.ownerDocument.body === this || !!this.parentNode?.isConnected; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  hasAttribute(key) { return key === 'inert' ? this.inert : key === 'hidden' ? this.hidden : key in this.attrs; }
  getAttribute(key) { return this.hasAttribute(key) ? this.attrs[key] ?? '' : null; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  removeAttribute(key) { delete this.attrs[key]; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; }
  insertBefore(node, before) {
    assert.ok(!node.contains(this), 'moving an original source must not form a DOM cycle');
    if (node.parentNode) node.parentNode.removeChild(node);
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
    node.parentNode = this; return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  before(node) { this.parentNode.insertBefore(node, this); }
  matches(selector) {
    const choices = selectors(selector, ',');
    if (choices.length > 1) return choices.some(choice => this.matches(choice));
    const parts = selectors(selector, ' ');
    if (parts.length > 1) return this.matches(parts.pop()) && !!this.parentNode?.closest(parts.join(' '));
    const has = selector.match(/:has\(> (.+)\)$/);
    if (has) { if (!this.children.some(child => child.matches(has[1]))) return false; selector = selector.slice(0, has.index); }
    const not = selector.match(/:not\(([^)]+)\)/);
    if (not) { if (this.matches(not[1])) return false; selector = selector.replace(not[0], ''); }
    const tag = selector.match(/^[a-z]+/);
    if (tag && tag[0] !== this.tagName) return false;
    const classes = [...selector.matchAll(/\.([\w-]+)/g)];
    if (classes.some(match => !this.classList.contains(match[1]))) return false;
    return [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)]
      .every(([, key, value]) => this.hasAttribute(key) && (value === undefined || this.getAttribute(key) === cssUnescape(value)));
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [child, ...child.querySelectorAll('*')])
      .filter(child => selector === '*' || child.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() { return this.isConnected && !this.closest('[hidden]') ? [{}] : []; }
  focus() {
    if (this.getClientRects().length && !this.disabled && !this.closest('[inert]'))
      this.ownerDocument.activeElement = this;
  }
  scrollIntoView() {}
  addEventListener(type, handler) {
    const list = this.listeners.get(type) || []; list.push(handler); this.listeners.set(type, list);
  }
  emit(type, extra = {}) {
    const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }
  getBoundingClientRect() { return { left: 20, right: 520, top: 16, bottom: 884 }; }
  showModal() { assert.equal(this.open, false); this.open = true; this.showCount = (this.showCount || 0) + 1; }
  close() { this.open = false; this.closeCount = (this.closeCount || 0) + 1; this.emit('close'); }
}
function fixture() {
  const document = { createElement(tag) { return new Element(document, tag); } };
  document.body = new Element(document, 'body'); document.activeElement = document.body;
  const add = (parent, tag, attrs) => parent.appendChild(new Element(document, tag, attrs));
  const mount = add(document.body, 'main', {});
  const bento = add(mount, 'div', { 'data-budget-bento': '' });
  const section = add(bento, 'section', { class: 'budget-surface-period', 'data-budget-browse': 'bills' });
  const heading = add(section, 'button', { 'data-blend-bills-open': '', 'aria-expanded': 'false' });
  const panel = add(section, 'div', { 'data-blend-bills-panel': '' }); panel.hidden = true;
  const row = add(panel, 'button', { 'data-budget-bill-open': 'hydro', 'data-budget-browse-origin': 'current',
    'data-budget-bill-date': '2026-10-09', 'aria-expanded': 'false' });
  const owner = add(mount, 'section', { class: 'budget-surface-period' }); owner.hidden = true;
  const detail = add(owner, 'details', { 'data-bill-detail': '' });
  add(detail, 'summary', { 'data-period-bill': 'hydro', 'data-bill-date': '2026-10-09' });
  const evidence = add(detail, 'p', {}); evidence.textContent = 'Fixture publication: $120.00; unconfirmed';
  const after = add(owner, 'span', {});
  const otherTrigger = add(mount, 'button', { 'data-budget-window-choose': '' });
  const other = add(owner, 'div', { 'data-budget-window-picker': '' }); other.hidden = true;
  const dialog = add(mount, 'dialog', { 'data-budget-detail-sheet': '' });
  const header = add(dialog, 'header', {});
  const close = add(header, 'button', { 'data-budget-detail-close': '', 'aria-label': 'Close details' });
  const title = add(header, 'h2', { 'data-budget-detail-title': '' });
  const body = add(dialog, 'div', { 'data-budget-detail-body': '' });
  const calls = [];
  let forwarded = null;
  const context = vm.createContext({ document, CSS: { escape: cssEscape },
    BudgetSheetMotion: {
      from(node, action) { const previous = forwarded; forwarded = node; try { return action(); } finally { forwarded = previous; } },
      opener: () => forwarded,
      origin: node => ({ node }),
      cancel() {},
      departure: node => ({ node }),
      enter() { assert.equal(dialog.open, true); assert.equal(document.activeElement, close); calls.push('enter'); },
      detail(_, direction) { assert.equal(dialog.open, true); calls.push('detail:' + direction); },
      leave() { assert.equal(dialog.open, false); assert.equal(document.activeElement, heading); calls.push('leave'); },
    } });
  vm.runInContext(filters + '\n' + controller, context);
  const sheet = context.budgetDetailSheetController(mount);
  return { document, mount, bento, panel, heading, row, detail, evidence, owner, after, dialog, close, title, body,
    other, otherTrigger, calls, sheet, context, motion: context.BudgetSheetMotion, back: dialog.querySelector('[data-budget-detail-back]') };
}
function openBills(f) { f.sheet.open(f.panel, f.heading, 'Bills'); }
function openBill(f) { f.sheet.open(f.detail, f.row, 'Hydro'); }
function originalEvidence(f) {
  assert.equal(f.detail.parentNode, f.owner);
  assert.equal(f.detail.nextSibling, f.after);
  assert.equal(f.evidence.textContent, 'Fixture publication: $120.00; unconfirmed');
}
{
  const f = fixture(); openBills(f);
  assert.equal(f.panel.parentNode, f.body);
  assert.equal(f.panel.hidden, false);
  assert.equal(f.heading.getAttribute('aria-expanded'), 'true');
  assert.equal(f.back.hidden, true);
  f.body.scrollTop = 240; openBill(f);
  assert.equal(f.dialog.showCount, 1, 'push retains the same native modal');
  assert.equal(f.panel.hidden, true); assert.equal(f.panel.inert, true);
  assert.equal(f.detail.parentNode, f.body);
  assert.equal(f.back.hidden, false);
  assert.equal(f.back.getAttribute('aria-label'), 'Go back');
  f.back.emit('click');
  originalEvidence(f);
  assert.equal(f.panel.parentNode, f.body); assert.equal(f.panel.hidden, false); assert.equal(f.panel.inert, false);
  assert.equal(f.body.scrollTop, 240);
  assert.equal(f.document.activeElement, f.row);
  assert.equal(f.row.getAttribute('aria-expanded'), 'false');
  assert.equal(f.title.textContent, 'Bills');
  assert.equal(f.dialog.open, true); assert.equal(f.dialog.closeCount, undefined);
  assert.deepEqual(f.calls, ['enter', 'detail:1', 'detail:-1']);
  f.close.emit('click');
  assert.equal(f.panel.hidden, true);
  assert.equal(f.panel.parentNode, f.heading.parentNode);
  assert.equal(f.heading.getAttribute('aria-expanded'), 'false');
  assert.equal(f.document.activeElement, f.heading);
  assert.equal(f.close.getAttribute('aria-label'), 'Close details');
  assert.equal(f.dialog.closeCount, 1);
}
for (const action of ['close', 'escape', 'backdrop']) {
  const f = fixture(); openBills(f); openBill(f);
  if (action === 'close') f.close.emit('click');
  if (action === 'escape') assert.equal(f.dialog.emit('cancel').defaultPrevented, true);
  if (action === 'backdrop') f.dialog.emit('click', { clientX: 2, clientY: 2 });
  originalEvidence(f);
  assert.equal(f.panel.parentNode, f.heading.parentNode);
  assert.equal(f.panel.hidden, true); assert.equal(f.panel.inert, false);
  assert.equal(f.document.activeElement, f.heading);
  assert.equal(f.dialog.open, false); assert.equal(f.dialog.closeCount, 1);
  assert.equal(f.document.body.classList.contains('budget-detail-open'), false);
  assert.equal(f.calls.at(-1), 'leave', 'exit decoration starts after native close/focus restoration');
}
{
  const f = fixture(); openBills(f); openBill(f);
  f.sheet.open(f.other, f.otherTrigger, 'Choose period');
  originalEvidence(f);
  assert.equal(f.panel.hidden, true);
  assert.equal(f.back.hidden, true, 'unrelated incumbent opens still replace rather than nest');
  assert.equal(f.other.parentNode, f.body);
  f.otherTrigger.setAttribute('aria-expanded', 'true'); // A skin can finish after native remount restore.
  f.sheet.close(false);
  assert.equal(f.otherTrigger.getAttribute('aria-expanded'), 'false');
  assert.equal(f.other.parentNode, f.owner); assert.equal(f.other.hidden, true);
}
{
  const first = fixture(); openBills(first); openBill(first);
  const state = first.sheet.snapshot();
  assert.equal(state.frames.length, 2);
  assert.ok(!JSON.stringify(state).includes('$120'), 'snapshot stores identities, never financial content');
  first.sheet.close(false); originalEvidence(first);
  const fresh = fixture();
  assert.equal(fresh.sheet.restore(state), true);
  assert.equal(fresh.back.hidden, false);
  assert.equal(fresh.detail.parentNode, fresh.body);
  assert.deepEqual(fresh.calls, [], 'remount restore does not replay entry/detail animation');
  fresh.sheet.back(); assert.equal(fresh.document.activeElement, fresh.row);
  fresh.sheet.close(false); originalEvidence(fresh);
  const missing = fixture(); missing.panel.removeAttribute('data-blend-bills-panel');
  assert.equal(missing.sheet.restore(state), false, 'missing parent must not restore a stranded detail');
  assert.equal(missing.dialog.open, false); originalEvidence(missing);
}
{
  const addIncome = f => {
    const node = f.document.createElement('button');
    node.classList.add('blend-income'); f.mount.appendChild(node); return node;
  };
  const first = fixture(), income = addIncome(first);
  first.motion.leave = () => {
    assert.equal(first.dialog.open, false);
    assert.equal(first.document.activeElement, income, 'native close immediately returns to the visible proxy');
  };
  first.otherTrigger.hidden = true;
  first.motion.from(income, () => first.sheet.open(first.other, first.otherTrigger, 'Income'));
  assert.equal(income.getAttribute('aria-expanded'), 'true');
  assert.equal(income.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(first.other.parentNode, first.body, 'proxy does not replace the original evidence');
  const state = first.sheet.snapshot();
  assert.equal(state.triggerSelector, '[data-budget-window-choose]');
  assert.equal(state.openerSelector, '.blend-income');
  first.sheet.close();
  assert.equal(income.getAttribute('aria-expanded'), 'false');
  const fresh = fixture();
  assert.equal(fresh.sheet.restore(state), true, 'native identity can restore before blend creates the proxy');
  fresh.otherTrigger.hidden = true;
  const nextIncome = addIncome(fresh);
  fresh.motion.leave = () => {};
  fresh.sheet.close();
  assert.equal(fresh.document.activeElement, nextIncome, 'close resolves the visible proxy created after remount');
  assert.equal(nextIncome.getAttribute('aria-expanded'), 'false');
}
function removeBlendBills(f) {
  const section = f.heading.parentNode;
  const nativeNodes = [...f.panel.children];
  nativeNodes.forEach(node => section.appendChild(node)); // Native rows and filters precede skin grouping.
  section.removeChild(f.panel);
  section.removeChild(f.heading);
  f.bento.removeAttribute('data-blend-ready');
  return () => {
    section.appendChild(f.heading);
    section.appendChild(f.panel);
    nativeNodes.forEach(node => f.panel.appendChild(node));
    f.bento.setAttribute('data-blend-ready', '1');
  };
}
function billsSnapshot() {
  const f = fixture();
  openBills(f); f.body.scrollTop = 240;
  openBill(f); f.body.scrollTop = 90;
  const state = f.sheet.snapshot();
  f.sheet.close(false);
  return state;
}
{
  const state = billsSnapshot(), f = fixture(), paint = removeBlendBills(f);
  assert.equal(f.sheet.restore(state, { deferBlend: true }), 'pending');
  assert.equal(f.dialog.open, false, 'a missing skin parent cannot produce a partial modal');
  assert.equal(f.detail.parentNode, f.owner, 'waiting never moves native evidence');
  const pending = f.sheet.snapshot();
  assert.equal(pending.frames.length, 2);
  pending.frames[0].label = 'Do not mutate the saved chain';
  assert.equal(f.sheet.snapshot().frames[0].label, 'Bills', 'pending snapshots are detached copies');
  paint();
  assert.equal(f.sheet.completeDeferredRestore(), true);
  assert.equal(f.title.textContent, 'Hydro');
  assert.equal(f.detail.parentNode, f.body);
  assert.equal(f.panel.parentNode, f.body);
  assert.equal(f.panel.hidden, true); assert.equal(f.panel.inert, true);
  assert.equal(f.body.scrollTop, 90);
  assert.equal(f.back.hidden, false);
  assert.deepEqual(f.calls, [], 'completing a remount does not replay user actions or motion');
  assert.equal(f.sheet.completeDeferredRestore(), false, 'completion is consumed once');
  f.sheet.back();
  assert.equal(f.body.scrollTop, 240, 'Back retains the parent scroll position');
  assert.equal(f.document.activeElement, f.row);
  f.close.emit('click');
  originalEvidence(f);
  assert.equal(f.document.activeElement, f.heading);
}
{
  const initial = billsSnapshot(), first = fixture();
  removeBlendBills(first);
  assert.equal(first.sheet.restore(initial, { deferBlend: true }), 'pending');
  const carried = first.sheet.snapshot();
  first.sheet.close(false); // budgetRemount snapshots before closing its old controller.
  assert.equal(first.sheet.completeDeferredRestore(), false);
  const second = fixture(), paint = removeBlendBills(second);
  assert.equal(second.sheet.restore(carried, { deferBlend: true }), 'pending');
  paint(); assert.equal(second.sheet.completeDeferredRestore(), true);
  assert.equal(second.back.hidden, false);
  second.sheet.back(); assert.equal(second.document.activeElement, second.row);
  second.sheet.close(false); originalEvidence(second);
}
for (const cancel of ['close', 'new-open', 'invalid-open', 'detached']) {
  const f = fixture(), paint = removeBlendBills(f);
  assert.equal(f.sheet.restore(billsSnapshot(), { deferBlend: true }), 'pending');
  if (cancel === 'close') f.sheet.close();
  if (cancel === 'new-open') f.sheet.open(f.other, f.otherTrigger, 'Choose period');
  if (cancel === 'invalid-open') f.sheet.open(null, f.otherTrigger, 'Missing');
  if (cancel === 'detached') f.mount.removeChild(f.dialog);
  paint();
  assert.equal(f.sheet.completeDeferredRestore(), false, cancel + ' cancels obsolete restoration');
  originalEvidence(f);
  if (cancel === 'new-open') {
    assert.equal(f.title.textContent, 'Choose period');
    assert.equal(f.other.parentNode, f.body, 'later paint must not replace a newer user choice');
    f.sheet.close(false);
  } else assert.equal(f.dialog.open, false);
}
{
  const f = fixture(); removeBlendBills(f);
  f.owner.removeChild(f.detail);
  assert.equal(f.sheet.restore(billsSnapshot(), { deferBlend: true }), false,
    'a missing native child is unavailable evidence, not pending skin');
  assert.equal(f.sheet.snapshot(), null);
}
for (const duplicate of ['source', 'trigger']) {
  const f = fixture(); removeBlendBills(f);
  if (duplicate === 'source') {
    const detail = f.document.createElement('details');
    detail.setAttribute('data-bill-detail', '');
    const summary = f.document.createElement('summary');
    summary.setAttribute('data-period-bill', 'hydro');
    summary.setAttribute('data-bill-date', '2026-10-09');
    detail.appendChild(summary); f.owner.appendChild(detail);
  } else {
    const row = f.document.createElement('button');
    for (const [key, value] of Object.entries(f.row.attrs)) row.setAttribute(key, value);
    f.row.parentNode.appendChild(row);
  }
  assert.equal(f.sheet.restore(billsSnapshot(), { deferBlend: true }), false,
    'ambiguous native ' + duplicate + ' must not pick the first match');
  assert.equal(f.sheet.snapshot(), null); originalEvidence(f);
}
{
  const f = fixture(), paint = removeBlendBills(f);
  assert.equal(f.sheet.restore(billsSnapshot(), { deferBlend: true }), 'pending');
  paint();
  f.panel.removeAttribute('data-blend-bills-panel');
  assert.equal(f.sheet.completeDeferredRestore(), false, 'an incomplete completed paint cannot drop its parent');
  assert.equal(f.dialog.open, false); assert.equal(f.document.activeElement, f.heading);
  assert.equal(f.sheet.snapshot(), null); originalEvidence(f);
}
{
  const f = fixture(), paint = removeBlendBills(f);
  assert.equal(f.sheet.restore(billsSnapshot(), { deferBlend: true }), 'pending');
  paint();
  f.panel.removeChild(f.row);
  f.heading.parentNode.appendChild(f.row);
  assert.equal(f.sheet.completeDeferredRestore(), false, 'a resolved child must still belong to the published parent');
  assert.equal(f.dialog.open, false); originalEvidence(f);
}
{
  const f = fixture();
  const question = f.document.createElement('section');
  question.setAttribute('data-operating-question', '06');
  const source = f.document.createElement('div'); source.classList.add('budget-step-body');
  const trigger = f.document.createElement('summary'); trigger.classList.add('budget-step-summary');
  question.appendChild(trigger); question.appendChild(source); f.mount.appendChild(question);
  const literal = '[data-operating-question="06"] .budget-step-body';
  const key = '[data-operating-question="' + cssEscape('06') + '"] .budget-step-body';
  assert.notEqual(key, literal, 'numeric native question identities use CSS.escape');
  assert.equal(f.mount.querySelector(literal), source);
  assert.equal(f.sheet.sourceForIdentity(key), source);
  f.sheet.open(source, trigger, 'Household');
  assert.equal(f.mount.querySelector(key), null, 'moving a source removes its former ancestor selector');
  assert.equal(f.sheet.sourceForIdentity(literal), null, 'equivalent DOM selectors are not the held canonical identity');
  assert.equal(f.sheet.sourceForIdentity(key), source, 'escaped identity resolves the exact controller-owned Q06 source');
  const saved = f.sheet.snapshot();
  assert.equal(saved.sourceSelector, key);
  f.sheet.close(false);
  assert.equal(f.sheet.restore(saved), true);
  assert.equal(f.sheet.sourceForIdentity(key), source, 'canonical lookup survives native remount restoration');
  f.sheet.close(false);
  assert.equal(f.sheet.sourceForIdentity(key), source);
  const duplicate = f.document.createElement('div'); duplicate.classList.add('budget-step-body');
  question.appendChild(duplicate);
  assert.equal(f.sheet.sourceForIdentity(key), null, 'unowned ambiguous sources are never selected arbitrarily');
}
function filterFixture() {
  const f = fixture();
  const add = (parent, tag, attrs) => {
    const node = f.document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    parent.appendChild(node); return node;
  };
  f.paidFilter = add(f.panel, 'button', { 'data-budget-bill-filter': 'paid', 'aria-pressed': 'false' });
  f.allFilter = add(f.panel, 'button', { 'data-budget-bill-filter': 'all', 'aria-pressed': 'true' });
  f.notPaidFilter = add(f.panel, 'button', { 'data-budget-bill-filter': 'check', 'aria-pressed': 'false' });
  f.estimatedFilter = add(f.panel, 'button', { 'data-budget-bill-filter': 'estimated', 'aria-pressed': 'false' });
  f.filterStatus = add(f.panel, 'p', { 'data-budget-bill-filter-status': '' });
  f.filterStatus.textContent = 'Showing all bills.';
  f.paidBucket = add(f.panel, 'div', { 'data-budget-bill-bucket': 'paid' });
  f.notPaidBucket = add(f.panel, 'div', { 'data-budget-bill-bucket': 'check' });
  f.estimatedBucket = add(f.panel, 'div', { 'data-budget-bill-bucket': 'estimated' });
  f.notPaidBucket.appendChild(f.row);
  f.paidRow = add(f.paidBucket, 'button', { 'data-budget-bill-open': 'rent',
    'data-budget-browse-origin': 'current', 'data-budget-bill-date': '2026-10-09' });
  f.paidDetail = add(f.owner, 'details', { 'data-bill-detail': '' });
  add(f.paidDetail, 'summary', { 'data-period-bill': 'rent', 'data-bill-date': '2026-10-09' });
  f.paidEvidence = add(f.paidDetail, 'p', {});
  f.paidEvidence.textContent = 'Fixture publication: $45.00; confirmed';
  return f;
}
for (const choice of ['paid', 'check', 'all']) {
  const first = filterFixture();
  openBills(first);
  // Set the UI state produced by an existing native filter click. The
  // controller must retain this choice, not recalculate a settlement bucket.
  first.paidFilter.setAttribute('aria-pressed', String(choice === 'paid'));
  first.allFilter.setAttribute('aria-pressed', String(choice === 'all'));
  first.notPaidFilter.setAttribute('aria-pressed', String(choice === 'check'));
  first.paidBucket.hidden = choice === 'check';
  first.notPaidBucket.hidden = choice === 'paid';
  if (choice === 'paid') first.sheet.open(first.paidDetail, first.paidRow, 'Rent');
  else openBill(first);
  const saved = first.sheet.snapshot();
  assert.equal(saved.frames[0].billsFilter, choice);
  first.sheet.close(false);
  const fresh = filterFixture(), paint = removeBlendBills(fresh);
  assert.equal(fresh.sheet.restore(saved, { deferBlend: true }), 'pending');
  assert.equal(fresh.sheet.snapshot().frames[0].billsFilter, choice, 'deferred copy retains the display choice');
  paint(); assert.equal(fresh.sheet.completeDeferredRestore(), true);
  fresh.sheet.back();
  assert.equal(fresh.paidFilter.getAttribute('aria-pressed'), String(choice === 'paid'));
  assert.equal(fresh.allFilter.getAttribute('aria-pressed'), String(choice === 'all'));
  assert.equal(fresh.notPaidFilter.getAttribute('aria-pressed'), String(choice === 'check'));
  assert.equal(fresh.paidBucket.hidden, choice === 'check');
  assert.equal(fresh.notPaidBucket.hidden, choice === 'paid');
  assert.equal(fresh.filterStatus.textContent, choice === 'paid'
    ? 'Showing paid bills: money sent or settlement confirmed.' : choice === 'check'
      ? 'Showing bills to confirm. They may already be paid; check the evidence before paying again.' : 'Showing all bills.');
  assert.equal(fresh.document.activeElement, choice === 'paid' ? fresh.paidRow : fresh.row);
  assert.equal(fresh.evidence.textContent, 'Fixture publication: $120.00; unconfirmed');
  assert.equal(fresh.paidEvidence.textContent, 'Fixture publication: $45.00; confirmed');
  assert.equal(fresh.paidEvidence.parentNode, fresh.paidDetail, 'filter restoration never copies evidence');
  assert.equal(fresh.sheet.snapshot().frames[0].billsFilter, choice, 'later remounts capture the restored UI');
  fresh.sheet.close(false);
}
{
  const first = filterFixture();
  openBills(first); first.allFilter.setAttribute('aria-pressed', 'false'); first.paidFilter.setAttribute('aria-pressed', 'true');
  const saved = first.sheet.snapshot(); first.sheet.close(false);
  const fresh = filterFixture();
  fresh.panel.removeChild(fresh.paidFilter);
  assert.equal(fresh.sheet.restore(saved), true);
  assert.equal(fresh.notPaidFilter.getAttribute('aria-pressed'), 'false');
  assert.equal(fresh.paidBucket.hidden, false); assert.equal(fresh.notPaidBucket.hidden, false);
  assert.equal(fresh.filterStatus.textContent, 'Showing all bills.',
    'a no-longer-published filter falls back to the complete current evidence');
  fresh.sheet.close(false);
}
{
  const first = filterFixture();
  first.heading.setAttribute('data-blend-bill', 'day:2026-10-09');
  first.panel.setAttribute('data-budget-bill-day', '2026-10-09');
  first.paidRow.setAttribute('data-budget-bill-date', '2026-10-10');
  openBills(first); openBill(first);
  const initial = first.sheet.snapshot();
  assert.equal(initial.frames[0].billsDay, '2026-10-09');
  first.sheet.open(first.detail, first.row, 'Hydro');
  first.sheet.open(first.detail, first.row, 'Hydro');
  assert.equal(first.sheet.snapshot().frames.length, 2, 'duplicate activation keeps one list/detail stack');
  assert.equal(first.dialog.showCount, 1, 'duplicate activation never replaces the modal');
  first.sheet.close(false);
  const fresh = filterFixture();
  fresh.heading.setAttribute('data-blend-bill', 'day:2026-10-09');
  fresh.paidRow.setAttribute('data-budget-bill-date', '2026-10-10');
  const paint = removeBlendBills(fresh);
  assert.equal(fresh.sheet.restore(initial, { deferBlend: true }), 'pending');
  assert.equal(fresh.sheet.snapshot().frames[0].billsDay, '2026-10-09');
  paint(); assert.equal(fresh.sheet.completeDeferredRestore(), true);
  fresh.sheet.back();
  assert.equal(fresh.panel.getAttribute('data-budget-bill-day'), '2026-10-09');
  assert.equal(fresh.row.hidden, false);
  assert.equal(fresh.paidRow.hidden, true, 'a different occurrence date stays outside the day list');
  assert.equal(fresh.paidBucket.hidden, true);
  assert.equal(fresh.document.activeElement, fresh.row);
  assert.equal(fresh.filterStatus.textContent, 'Showing bills on 2026-10-09.');
  assert.equal(fresh.evidence.textContent, 'Fixture publication: $120.00; unconfirmed');
  fresh.sheet.close();
  assert.equal(fresh.document.activeElement, fresh.heading);
  fresh.panel.removeAttribute('data-budget-bill-day');
  openBills(fresh);
  const complete = fresh.sheet.snapshot(); fresh.sheet.close(false);
  assert.equal(fresh.sheet.restore(complete), true);
  assert.equal(fresh.paidRow.hidden, false, 'the full roster restores rows hidden by a day choice');
  assert.equal(fresh.notPaidBucket.hidden, false); assert.equal(fresh.paidBucket.hidden, false);
  fresh.sheet.close(false);
}
{
  // Card movement panels are native sheet sources: the controller records
  // their stable card identity at open() and restores the sheet across a
  // remount onto the fresh mount's own panel node.
  const addCard = f => {
    const strip = f.document.createElement('section');
    strip.setAttribute('data-budget-card-movements', '');
    const trigger = f.document.createElement('button');
    trigger.setAttribute('data-budget-card-toggle', 'travelvisa');
    trigger.setAttribute('aria-haspopup', 'dialog');
    const panel = f.document.createElement('section');
    panel.setAttribute('data-budget-card-panel', 'travelvisa');
    panel.setAttribute('aria-label', 'Travel activity');
    panel.hidden = true;
    strip.appendChild(trigger); strip.appendChild(panel); f.mount.appendChild(strip);
    return { strip, trigger, panel };
  };
  const first = fixture(); const card = addCard(first);
  first.sheet.open(card.panel, card.trigger, 'Travel activity');
  assert.equal(card.panel.parentNode, first.body, 'card panel moves into the sheet body');
  assert.equal(card.panel.hidden, false);
  assert.equal(first.title.textContent, 'Travel activity');
  const state = first.sheet.snapshot();
  assert.equal(state.sourceSelector, '[data-budget-card-panel="travelvisa"]', 'snapshot records the card panel identity');
  assert.equal(state.triggerSelector, '[data-budget-card-toggle="travelvisa"]', 'snapshot records the card trigger identity');
  first.motion.leave = () => {
    assert.equal(first.document.activeElement, card.trigger, 'close returns focus to the card trigger');
  };
  first.sheet.close();
  assert.equal(card.panel.parentNode, card.strip, 'close returns the original panel node to the strip');
  assert.equal(card.panel.hidden, true);
  const fresh = fixture(); const freshCard = addCard(fresh);
  assert.equal(fresh.sheet.restore(state), true, 'card sheet restores across a remount');
  assert.equal(freshCard.panel.parentNode, fresh.body);
  assert.equal(freshCard.panel.hidden, false);
  fresh.sheet.close(false);
  assert.equal(freshCard.panel.parentNode, freshCard.strip);
  assert.equal(freshCard.panel.hidden, true);
}
// Grok ruling (b): the Settled by schedule pill is a real filter. Applying it presses
// only that pill, shows only the Settled by schedule bucket, prints its own status
// sentence, and survives a save/restore of the drawer state.
{
  const f = filterFixture();
  openBills(f);
  f.context.budgetApplyBillFilter(f.panel, 'estimated');
  assert.equal(f.estimatedFilter.getAttribute('aria-pressed'), 'true', 'the Settled by schedule pill is pressed');
  assert.equal(f.allFilter.getAttribute('aria-pressed'), 'false', 'it does not fall back to All');
  assert.equal(f.paidFilter.getAttribute('aria-pressed'), 'false');
  assert.equal(f.estimatedBucket.hidden, false, 'the Settled by schedule bucket is visible');
  assert.equal(f.paidBucket.hidden, true, 'the Paid bucket is hidden');
  assert.equal(f.notPaidBucket.hidden, true, 'the To confirm bucket is hidden');
  assert.equal(f.filterStatus.textContent, 'Settled by schedule on the due date. Payment not observed.');
  const saved = f.sheet.snapshot();
  assert.equal(saved.frames[0].billsFilter, 'estimated', 'the saved drawer state keeps the Settled by schedule choice');
  f.sheet.close(false);
  const fresh = filterFixture();
  assert.equal(fresh.sheet.restore(saved), true);
  assert.equal(fresh.estimatedFilter.getAttribute('aria-pressed'), 'true', 'the restored drawer shows Settled by schedule pressed');
  assert.equal(fresh.paidBucket.hidden, true);
  assert.equal(fresh.estimatedBucket.hidden, false);
  fresh.sheet.close(false);
}
console.log('PASS native Budget drawer: original-node ownership, Back/focus, immutable evidence, deferred remount chain, cancellation, unique identities, held-source lookup, Bills filters/day and duplicate activation');
