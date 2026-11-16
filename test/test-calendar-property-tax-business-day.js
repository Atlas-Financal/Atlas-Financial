'use strict';
// A22: the property-tax reminder falls on the first business day of July,
// not a fixed 2 July. Expected dates are read off a calendar by hand.
//   node test/test-calendar-property-tax-business-day.js
const assert = require('node:assert/strict');
const C = require('../scripts/calendar-ics.js');

const expected = {
  2027: '2027-07-02', // 1 Jul Thu -> Fri 2nd
  2028: '2028-07-03', // 1 Jul Sat; 2nd is Sunday -> Mon 3rd (no Saturday shift assumed)
  2029: '2029-07-03', // 1 Jul Sun -> Mon 2nd observed holiday -> Tue 3rd
  2030: '2030-07-02', // 1 Jul Mon -> Tue 2nd
  2033: '2033-07-04', // 1 Jul Fri; 2nd Sat, 3rd Sun -> Mon 4th
  2035: '2035-07-03', // 1 Jul Sun -> Mon 2nd observed -> Tue 3rd
};
let checks = 0;
for (const [year, date] of Object.entries(expected)) {
  assert.equal(C.firstBusinessDayOfJuly(Number(year)), date, `first business day of July ${year}`);
  checks++;
}

const plan = require('../data.json').plan;
const built = C.buildHouseholdCalendar(plan, '2026-11-16');
const tax = built.events.filter(e => /^atlas-reminder-property-tax/.test(e.uid));
assert.equal(tax.length, 10, 'ten dated reminders'); checks++;
assert.ok(tax.every(e => !e.rrule), 'no fixed-day yearly rule'); checks++;
assert.deepEqual(tax.slice(0, 3).map(e => e.start), ['2027-07-02', '2028-07-03', '2029-07-03'],
  'the next three due dates from 2026-11-16'); checks++;
assert.equal(new Set(tax.map(e => e.uid)).size, 10, 'one uid per year'); checks++;
const before = C.buildHouseholdCalendar(plan, '2027-07-01').events.filter(e => /^atlas-reminder-property-tax/.test(e.uid));
assert.equal(before[0].start, '2027-07-02', 'on 1 July the same year is still ahead'); checks++;
const after = C.buildHouseholdCalendar(plan, '2027-07-03').events.filter(e => /^atlas-reminder-property-tax/.test(e.uid));
assert.equal(after[0].start, '2028-07-03', 'after the due date the next year is first'); checks++;

console.log(`test-calendar-property-tax-business-day: ${checks} checks passed`);
