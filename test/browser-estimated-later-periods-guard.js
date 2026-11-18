'use strict';
/* Shared browser guard for the "Later pay periods" card (#1312; owner decision,
 * Dale, #821 6964438984). While today's cash is unconfirmed the Budget keeps
 * "Current plan unavailable" for today and lists each later pay period that
 * Forecast released as an estimate. Suites that forbid every precise figure on
 * a withheld page use this to allow exactly that card and nothing else:
 *
 * - the card appears only while today's plan is unavailable, and every period
 *   it lists starts after the as-of date;
 * - each of its figures is a dollar amount tagged "estimate", or reads Unavailable;
 * - the card prints no other dollar figure;
 * - the rest of the page is read with the card left out, so the suite's own
 *   no-precise-figure scan still covers every opening-seeded figure.
 */
const TERM = /^(?:[−-]?\$[\d,]+\.\d\d estimate|Unavailable(?: unavailable)?)$/;
const PRECISE = /[$]\s?\d/;

// Run in the page: the card(s), read without changing the page.
function readLaterPeriods() {
  const boxes = [...document.querySelectorAll('[data-estimated-later-periods]')];
  return {
    todayUnavailable: !!document.querySelector('[data-budget-surface="unavailable"]'),
    boxes: boxes.map(box => {
      const terms = [...box.querySelectorAll('[data-estimated-term] dd')];
      const clone = box.cloneNode(true);
      clone.querySelectorAll('[data-estimated-term] dd').forEach(dd => dd.remove());
      return {
        starts: [...box.querySelectorAll('[data-estimated-later-period]')].map(a => a.getAttribute('data-estimated-later-period')),
        terms: terms.map(dd => dd.textContent.replace(/\s+/g, ' ').trim()),
        otherText: clone.textContent.replace(/\s+/g, ' ').trim(),
      };
    }),
  };
}

// Failures, as plain strings, for one reading; [] when the card is as #1312 publishes it.
function laterPeriodFailures(reading, asOf) {
  const failures = [];
  if (reading.boxes.length && !reading.todayUnavailable) failures.push('the Later pay periods card is shown while today\'s plan is available');
  if (reading.boxes.length > 1) failures.push('more than one Later pay periods card');
  for (const box of reading.boxes) {
    if (!box.starts.length) failures.push('the Later pay periods card lists no period');
    for (const start of box.starts) if (!(start > asOf)) failures.push(`a listed period (${start}) does not start after ${asOf}`);
    if (box.terms.length !== box.starts.length * 4) failures.push(`expected four figures per period, got ${box.terms.length} for ${box.starts.length}`);
    for (const term of box.terms) if (!TERM.test(term)) failures.push(`a later-period figure is not an estimate: "${term}"`);
    if (PRECISE.test(box.otherText)) failures.push('the Later pay periods card prints a figure outside its terms');
  }
  return failures;
}

// Run in the page: text of `selector` (textContent) with the card left out.
function textWithoutLaterPeriods(selector) {
  return [...document.querySelectorAll(selector)].map(element => {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('[data-estimated-later-periods]').forEach(box => box.remove());
    return clone.textContent;
  }).join(' | ');
}

module.exports = { readLaterPeriods, laterPeriodFailures, textWithoutLaterPeriods, PRECISE };
