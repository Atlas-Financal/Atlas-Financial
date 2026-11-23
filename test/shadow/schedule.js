'use strict';

// Input dates are household financial dates, not instants. Count Gregorian days
// in UTC so a daylight-saving transition cannot add or remove a day.
const DAY = 86400000;
const dayNumber = date => Date.parse(date + 'T00:00:00Z') / DAY;
const dayString = n => new Date(n * DAY).toISOString().slice(0, 10);
const cents = amount => Number.isFinite(amount) ? Math.round(amount * 100) : null;

function periodDates(plan, asOf) {
  const payroll = plan.income.find(row => row.id === 'payroll' && row.frequency === 'biweekly');
  // ACCOUNT_FACTS.md:81–91 names this particular schedule as the boundary.
  // Two secondary monthly deposits supply income but cannot define a cycle.
  if (!payroll || !Number.isFinite(dayNumber(payroll.anchor))) return null;
  const anchor = dayNumber(payroll.anchor);
  const cyclesElapsed = Math.floor((dayNumber(asOf) - anchor) / 14);
  const start = anchor + cyclesElapsed * 14;
  return { start: dayString(start), end: dayString(start + 13), nextPayday: dayString(start + 14) };
}

function scheduledOn(row, day) {
  const date = dayString(day);
  switch (row.frequency) {
    case 'once':
      return row.date === date;
    case 'biweekly':
      return (day - dayNumber(row.anchor)) % 14 === 0;
    case 'monthly': {
      const month = new Date(day * DAY);
      const lastDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
      return month.getUTCDate() === Math.min(row.day, lastDay);
    }
    default:
      throw new Error('No documented shadow recurrence for ' + row.frequency);
  }
}

function scheduledRows(plan, start, end) {
  const income = [];
  const bills = [];
  const mortgage = plan.obligations.filter(row => row.debtId === 'mortgage' && row.effect === 'payment');
  const billSources = [...plan.bills, ...mortgage];
  for (let day = dayNumber(start); day <= dayNumber(end); day++) {
    const date = dayString(day);
    for (const row of plan.income) {
      if (scheduledOn(row, day)) income.push({ id: row.id, date, cents: cents(row.amount) });
    }
    for (const row of billSources) {
      if (scheduledOn(row, day)) {
        const isMortgage = row.debtId === 'mortgage';
        // An authored bill needs a positive point price (ARCHITECTURE.md,
        // Missing or invalid scheduled amounts and dates). This differs
        // from an explicitly documented no-payment occurrence.
        const amount = isMortgage || row.amount > 0 ? cents(row.amount) : null;
        bills.push({ id: row.id, date, cents: amount, cash: true, kind: isMortgage ? 'mortgage' : 'bill' });
      }
    }
  }
  return { income, bills };
}

module.exports = { periodDates, scheduledRows };
