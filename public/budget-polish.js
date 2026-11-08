'use strict';
/* Atlas Budget visual polish.
 *
 * Presentation only. public/plan.js has already rendered every financial
 * figure and settlement state from Forecast before this file runs. This layer
 * groups those existing DOM nodes into the approved phone-first visual
 * hierarchy and adds human-readable status badges. It does not call Forecast,
 * read canonical data, total money, infer settlement, or move an obligation.
 *
 * Bill colours reprint published payment states. Dates never clear a bill
 * or replace pending/unconfirmed evidence with a paid-looking badge.
 */

(function init(factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') api.boot(document);
})(function buildApi() {
  const APPLIED = 'data-atlas-budget-ui';
  function billStatePresentation(status, settlement) {
    const key = String(status == null ? '' : status).trim().toLowerCase();
    const evidence = String(settlement == null ? '' : settlement).trim().toLowerCase();
    if (key === 'pending' || evidence === 'pending') return { label: 'Pending', kind: 'pending' };
    if (evidence === 'unverified' || ['to confirm', 'not confirmed', 'needs confirmation'].includes(key)) {
      return { label: 'To confirm', kind: 'check' };
    }
    if (evidence === 'unknown' || ['unknown', 'unavailable'].includes(key)) return { label: 'Unknown', kind: 'unknown' };
    if (key === 'paid') return { label: 'Paid', kind: 'paid' };
    if (['not paid', 'unpaid'].includes(key) || ['still due', 'planned'].includes(key) && evidence === 'upcoming') {
      return { label: 'Not paid', kind: 'to-pay' };
    }
    return { label: 'Unknown', kind: 'unknown' };
  }

  function planningBillChrome(status, dueDate, asOf, settlement) {
    // Keep the existing caller signature; schedule dates carry no payment evidence.
    return { ...billStatePresentation(status, settlement), planning: false };
  }

  function cleanBillLabel(value, status) {
    let out = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const key = String(status == null ? '' : status).trim().toLowerCase();
    const suffix = ['paid', 'still due', 'pending', 'needs confirmation', 'to confirm',
      'not confirmed', 'unknown', 'unavailable', 'not paid', 'unpaid'].includes(key) ? key : null;
    if (!suffix) return out;
    // A trusted-on-due-date PAID keeps its marker; only the repeated status word goes.
    if (suffix === 'paid') out = out.replace(/\s*·\s*paid(\s*·\s*trusted on due date \(not seen\))\s*$/i, '$1').trim();
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return out.replace(new RegExp(`\\s*·\\s*${escaped}\\s*$`, 'i'), '').trim();
  }

  function directElementChildren(node) {
    return Array.from((node && node.children) || []);
  }

  function householdAsOf(line) {
    let node = line;
    while (node) {
      if (node.getAttribute) {
        const value = node.getAttribute('data-household-as-of');
        if (value) return value;
      }
      node = node.parentElement || node.parentNode;
    }
    const root = line && line.ownerDocument;
    const host = root && root.querySelector && root.querySelector('[data-household-as-of]');
    return host && host.getAttribute('data-household-as-of');
  }

  function decorateBillLine(doc, line) {
    if (!line || line.hasAttribute('data-atlas-bill-row')) return false;
    const status = line.getAttribute('data-bill-status');
    const dueDate = line.getAttribute('data-bill-date');
    const meta = planningBillChrome(status, dueDate, householdAsOf(line), line.getAttribute('data-bill-settlement'));
    if (!meta) return false;
    const children = directElementChildren(line);
    const label = children[0] || null;
    const amount = children.length > 1 ? children[children.length - 1] : null;
    if (!label || !amount) return false;

    label.textContent = cleanBillLabel(label.textContent, status);
    const badge = doc.createElement('span');
    badge.className = `atlas-bill-state atlas-bill-state-${meta.kind}`;
    badge.setAttribute('data-atlas-bill-state', meta.kind);
    badge.textContent = meta.label;
    if (meta.kind === 'check' || meta.kind === 'unknown') {
      badge.setAttribute('title', 'Payment is not confirmed. Missing evidence does not mean unpaid.');
    }
    line.insertBefore(badge, amount);
    line.classList.add('atlas-bill-row', `atlas-bill-row-${meta.kind}`);
    line.setAttribute('data-atlas-bill-row', 'true');
    line.setAttribute('data-atlas-bill-chrome', meta.kind);
    return true;
  }

  function sectionCard(doc, waterfall, className, nodes) {
    const kept = (nodes || []).filter(Boolean);
    if (!kept.length) return null;
    const card = doc.createElement('section');
    card.className = `atlas-budget-section ${className}`;
    kept.forEach(node => card.appendChild(node));
    waterfall.appendChild(card);
    return card;
  }

  function isOperatingCashExplanation(node) {
    if (!node || node.nodeType !== 1) return false;
    if (typeof node.hasAttribute === 'function'
        && node.hasAttribute('data-operating-cash-explanation')) {
      return true;
    }
    if (node.classList && typeof node.classList.contains === 'function'
        && node.classList.contains('operating-cash-explanation')) {
      return true;
    }
    const cls = typeof node.getAttribute === 'function'
      ? String(node.getAttribute('class') || '')
      : String(node.className || '');
    return /(^|\s)operating-cash-explanation(\s|$)/.test(cls);
  }

  // querySelector can miss a late or ejected node. Walk elements so the
  // live enhance path still finds the plan.js reprint.
  function findOperatingCashExplanation(waterfall) {
    const scan = root => {
      const kids = directElementChildren(root);
      for (let i = 0; i < kids.length; i++) {
        if (isOperatingCashExplanation(kids[i])) return kids[i];
      }
      for (let i = 0; i < kids.length; i++) {
        const nested = scan(kids[i]);
        if (nested) return nested;
      }
      return null;
    };
    const inside = scan(waterfall)
      || (waterfall && waterfall.querySelector
        && (waterfall.querySelector('.operating-cash-explanation')
          || waterfall.querySelector('[data-operating-cash-explanation]')));
    if (inside) return inside;
    const parent = waterfall && (waterfall.parentElement || waterfall.parentNode);
    if (!parent || parent === waterfall) return null;
    const siblings = directElementChildren(parent);
    for (let i = 0; i < siblings.length; i++) {
      if (isOperatingCashExplanation(siblings[i])) return siblings[i];
    }
    return null;
  }

  function insertAfter(parent, node, ref) {
    if (!parent || !node || !ref) return false;
    const next = ref.nextSibling;
    if (next === node) return false;
    if (next && typeof parent.insertBefore === 'function') {
      parent.insertBefore(node, next);
      return true;
    }
    parent.appendChild(node);
    return true;
  }

  // Card grouping is one-shot (APPLIED). Placement is not: live boot can
  // mark APPLIED before plan.js has injected the explanation, or a later
  // enhance pass can leave it as an orphan next to Current Balance.
  function placeOperatingCashExplanation(waterfall) {
    const afterBudget = waterfall && waterfall.querySelector
      && waterfall.querySelector('[data-operating-question="07"]');
    const budgetCard = waterfall && waterfall.querySelector
      && waterfall.querySelector('.atlas-household-budget-card');
    if (!afterBudget || !budgetCard) return false;
    const explanation = findOperatingCashExplanation(waterfall);
    if (!explanation) return false;
    const kids = directElementChildren(budgetCard);
    const q07At = kids.indexOf(afterBudget);
    if (explanation.parentNode === budgetCard && q07At >= 0 && kids[q07At + 1] === explanation) {
      return false;
    }
    if (afterBudget.parentNode !== budgetCard) budgetCard.appendChild(afterBudget);
    insertAfter(budgetCard, explanation, afterBudget);
    return true;
  }

  function decorateWaterfall(doc, waterfall) {
    if (!waterfall) return false;
    if (waterfall.getAttribute('data-operating-plan') === 'unavailable') return false;

    // Native step disclosures already provide the selected-period hierarchy.
    // Keep published bill badges, but do not reparent steps into legacy cards.
    if (waterfall.querySelector('.budget-step-details')) {
      let changed = false;
      waterfall.querySelectorAll('[data-bill-status]').forEach(line => {
        if (decorateBillLine(doc, line)) changed = true;
      });
      return changed;
    }

    let grouped = false;
    if (!waterfall.hasAttribute(APPLIED)) {
      waterfall.setAttribute(APPLIED, 'true');
      grouped = true;

      const question = number => waterfall.querySelector(`[data-operating-question="${number}"]`);
      const income = question('02');
      const bills = question('04');
      const afterBills = question('05');
      const budget = question('06');
      const afterBudget = question('07');
      const explanation = findOperatingCashExplanation(waterfall);

      const paydayBalance = income && income.querySelector('[data-payday-balance]');
      if (paydayBalance) {
        paydayBalance.classList.add('atlas-income-closing');
      }

      const incomeCard = sectionCard(doc, waterfall, 'atlas-income-card', [income]);
      const billsCard = sectionCard(doc, waterfall, 'atlas-bills-card', [bills, afterBills]);
      // plan.js injects the explanation immediately after Q07. appendChild
      // would otherwise leave that sibling behind, so it reprints under
      // Current Balance before the re-appended Income/Bills/Household cards.
      sectionCard(doc, waterfall, 'atlas-household-budget-card', [
        budget,
        afterBudget,
        afterBudget ? explanation : null,
      ]);

      if (incomeCard) incomeCard.setAttribute('data-atlas-section', 'income');
      if (billsCard) {
        billsCard.setAttribute('data-atlas-section', 'bills');
        billsCard.querySelectorAll('[data-bill-status]').forEach(line => decorateBillLine(doc, line));
      }
      const budgetCard = waterfall.querySelector('.atlas-household-budget-card');
      if (budgetCard) budgetCard.setAttribute('data-atlas-section', 'household-budget');
    }

    const placed = placeOperatingCashExplanation(waterfall);
    return grouped || placed;
  }

  function enhance(doc) {
    const body = doc && doc.getElementById && doc.getElementById('operating-surface-body');
    if (!body || !body.querySelector('[data-calendar-waterfalls]')) return false;
    let changed = false;
    body.querySelectorAll('[data-calendar-waterfall]').forEach(waterfall => {
      if (decorateWaterfall(doc, waterfall)) changed = true;
    });
    const current = body.querySelector('[data-live-current-balance]');
    if (current) current.classList.add('atlas-current-balance-card');
    body.classList.add('atlas-budget-ui-ready');
    return changed;
  }

  function boot(doc) {
    const body = doc && doc.getElementById && doc.getElementById('operating-surface-body');
    if (!body) return null;
    enhance(doc);
    if (typeof MutationObserver === 'undefined') return null;
    const observer = new MutationObserver(() => enhance(doc));
    observer.observe(body, { childList: true, subtree: true });
    return observer;
  }

  return {
    billStatePresentation,
    planningBillChrome,
    cleanBillLabel,
    decorateBillLine,
    decorateWaterfall,
    enhance,
    boot,
  };
});
