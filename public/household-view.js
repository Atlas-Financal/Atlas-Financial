'use strict';
/* Plain-language presentation for the household operating surface.
 *
 * This file deliberately owns no financial meaning. It reads only the DOM
 * that public/plan.js already rendered from Forecast and makes that same
 * answer easier to scan on a phone: the action first, details collapsed,
 * duplicate diagnostics grouped, and system vocabulary translated into
 * ordinary household language. It never reads canonical current-state
 * files, calls Forecast, fetches evidence, totals money, settles an
 * obligation, or changes a plan.
 */

(function init(factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') api.boot(document);
})(function buildApi() {
  const APPLIED = 'data-household-view-applied';

  const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

  function aggregateTexts(values) {
    const order = [];
    const counts = new Map();
    for (const raw of values || []) {
      const value = clean(raw);
      if (!value) continue;
      if (!counts.has(value)) order.push(value);
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return order.map(text => ({ text, count: counts.get(text) }));
  }

  function friendlyDiagnostic(text, count) {
    const value = clean(text);
    const n = Number(count) || 1;
    const plural = n === 1 ? '' : 's';

    if (value === 'A material observation could not be safely classified.') {
      return `${n} observation${plural} still need${n === 1 ? 's' : ''} classification.`;
    }
    if (value === 'Unmatched household cash movement was not classified into a modeled item.') {
      return `${n} cash movement${plural} still need${n === 1 ? 's' : ''} review.`;
    }
    const unmatched = /^(\d+) unmatched household cash movements were not classified into modeled items\.$/.exec(value);
    if (unmatched) return `${unmatched[1]} cash movements still need review.`;
    if (value === 'Category allocation is incomplete, so named remaining is not an exact claim.') {
      return 'Some spending is still uncategorized, so category remaining amounts are not exact.';
    }
    if (value === 'A modeled item remains unverified. That is not a claim it is unpaid.') {
      return `${n} bill${plural} still need${n === 1 ? 's' : ''} confirmation. That is not a claim ${n === 1 ? 'it is' : 'they are'} unpaid.`;
    }
    return n === 1 ? value : `${n} items: ${value}`;
  }


  function friendlySpendingNote(value) {
    const source = clean(value);
    let out = "This week's spend until the next payday.";
    if (/Essential costs come out of it first\.|Everyday costs come out of it first\./i.test(source)) {
      out += ' Everyday costs come out of it first.';
    }
    if (/Current remaining spend cannot be confirmed|What is left to spend this week is not confirmed/i.test(source)) {
      out += ' What is left to spend this week is not confirmed yet.';
    }
    return out;
  }



  function enhanceQuestionOne(doc, body) {
    const q = body.querySelector('[data-operating-question="01"]');
    const answer = q && q.querySelector('.operating-answer');
    if (!q || !answer) return false;
    const prompt = q.querySelector('.operating-prompt');
    if (prompt) prompt.textContent = 'Current Balance';
    return true;
  }

  function enhanceQuestionTwo(doc, body) {
    const q = body.querySelector('[data-operating-question="02"]');
    const answer = q && q.querySelector('.operating-answer');
    if (!q || !answer) return false;
    const prompt = q.querySelector('.operating-prompt');
    if (prompt) {
      prompt.textContent = q.getAttribute('data-operating-prompt') || 'Bills';
    }
    return true;
  }

  function enhanceQuestionThree(doc, body) {
    const q = body.querySelector('[data-operating-question="03"]');
    const answer = q && q.querySelector('.operating-answer');
    if (!q || !answer) return false;
    const prompt = q.querySelector('.operating-prompt');
    if (prompt) prompt.textContent = 'Balance after bills';
    return true;
  }

  function enhanceQuestionFour(doc, body) {
    const q = body.querySelector('[data-operating-question="04"]');
    const answer = q && q.querySelector('.operating-answer');
    if (!q || !answer) return false;
    const prompt = q.querySelector('.operating-prompt');
    if (prompt) prompt.textContent = 'Household budget';
    if (answer.querySelector('[data-spend-decision]')) {
      const notes = answer.querySelectorAll('.operating-note');
      for (const note of notes) {
        if (/Forecast\.recommend|household spending limit|Current remaining spend|This week's spend/i.test(clean(note.textContent))) {
          note.textContent = friendlySpendingNote(note.textContent);
        }
      }
      const refusal = answer.querySelector('.payday-refuse');
      if (refusal && !answer.querySelector('[data-spend-decision="none"]')) {
        const reason = clean(refusal.textContent);
        const primary = doc.createElement('p');
        primary.className = 'household-primary household-tight';
        primary.setAttribute('data-spend-decision', 'none');
        primary.textContent = "No safe amount for this week's spend.";
        const details = doc.createElement('details');
        details.className = 'household-inline-details';
        const summary = doc.createElement('summary');
        summary.textContent = 'Why?';
        const explanation = doc.createElement('p');
        explanation.textContent = reason;
        details.append(summary, explanation);
        answer.replaceChildren(primary, details);
      }
      return true;
    }
    return true;
  }

  function enhanceQuestionFive(doc, body) {
    const q = body.querySelector('[data-operating-question="05"]');
    const answer = q && q.querySelector('.operating-answer');
    if (!q || !answer) return false;
    const prompt = q.querySelector('.operating-prompt');
    if (prompt) prompt.textContent = 'Balance after household budget';
    return true;
  }

  function enhanceQuestionSix(doc, body) {
    const q = body.querySelector('[data-operating-question="06"]')
      || body.querySelector('[data-operating-question="01"]');
    const answer = q && q.querySelector('.operating-answer');
    if (!q || !answer) return false;
    const prompt = q.querySelector('.operating-prompt');
    if (prompt && q.getAttribute('data-operating-question') === '06') {
      prompt.textContent = 'Credit card to pay off first';
    }
    // The rest of this question's enhancement read a current-period action
    // card (data-current-period-action) that no renderer emits; it was
    // deleted with it. The prompt wording above is the live part.
    return false;
  }

  function aggregateList(doc, list) {
    if (!list) return;
    const rows = aggregateTexts(Array.from(list.querySelectorAll('li')).map(li => li.textContent));
    list.replaceChildren();
    for (const row of rows) {
      const li = doc.createElement('li');
      li.textContent = friendlyDiagnostic(row.text, row.count);
      list.appendChild(li);
    }
  }

  function enhanceTrust(doc, body) {
    const trust = body.querySelector('.refresh-trust');
    if (!trust) return false;
    const asOf = trust.querySelector('.refresh-trust-asof');
    if (asOf) asOf.textContent = clean(asOf.textContent).replace(/^Last observed and reconciled /i, 'Updated ');

    aggregateList(doc, trust.querySelector('.refresh-trust-limits'));
    aggregateList(doc, trust.querySelector('.refresh-trust-unresolved'));
    return true;
  }

  function enhanceCertainty() {
    return false;
  }

  function enhance(doc) {
    const body = doc && doc.getElementById && doc.getElementById('operating-surface-body');
    if (!body) return false;
    const gate = body.querySelector('[data-operating-question="01"]')
      || body.querySelector('[data-operating-question="06"]')
      || body.querySelector('[data-payday-sheet]');
    if (!gate || gate.hasAttribute(APPLIED) || body.hasAttribute(APPLIED)) return false;

    body.setAttribute(APPLIED, 'true');
    if (!body.querySelector('[data-calendar-waterfalls]')) {
      enhanceQuestionOne(doc, body);
      enhanceQuestionTwo(doc, body);
      enhanceQuestionThree(doc, body);
      enhanceQuestionFour(doc, body);
      enhanceQuestionFive(doc, body);
      enhanceQuestionSix(doc, body);
    }
    enhanceCertainty(doc, body);
    enhanceTrust(doc, body);
    body.classList.add('household-view-ready');
    return true;
  }

  function boot(doc) {
    const body = doc && doc.getElementById && doc.getElementById('operating-surface-body');
    if (!body) return null;
    enhance(doc);
    if (typeof MutationObserver === 'undefined') return null;
    const observer = new MutationObserver(() => enhance(doc));
    observer.observe(body, { childList: true, subtree: false });
    return observer;
  }

  return {
    aggregateTexts,
    friendlyDiagnostic,
    friendlySpendingNote,
    enhance,
    boot,
  };
});
