'use strict';

// Integer-cent, UTC civil-date model for the invented plan domain described in
// README.md. It accepts authored facts, never occurrence lists from Forecast.
const { scheduledRows } = require('./schedule');
const DAY = 86400000;

function iso(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function cents(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function monthlyDate(year, monthIndex, day) {
  const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return iso(Date.UTC(year, monthIndex, Math.min(day, monthEnd)));
}

function plannedMinimum(obligation, statement) {
  const issuer = statement ? cents(statement.minimum) : null;
  const snapshot = obligation.fixedInterestMinimum;
  if (!snapshot) return issuer ?? cents(obligation.amount);
  // Written card rule in #1498 (linked by BACKLOG.md): round one month's
  // interest UP to whole dollars. Inputs here are cents and annual basis
  // points: 100 cents/dollar × 10,000 basis points × 12 months/year.
  const fixedDollars = Math.ceil(cents(snapshot.balance) * cents(snapshot.rate) / 12_000_000);
  return Math.max(issuer ?? 0, 100 * fixedDollars);
}

// ARCHITECTURE.md, "One statement minimum occurrence" and "HELOC cash
// minimum and month-end capitalise are two facts". Enumerate originals first;
// an override may move a date into this span even from the preceding/following
// month. Neighbouring originals remain boundaries even when they fall outside
// the dates requested by the caller.
function statementByOriginal(obligation, day, firstDue) {
  const byOriginal = new Map();
  for (const statement of obligation.statementOccurrences || []) {
    const year = Number(statement.scheduledDate.slice(0, 4));
    const month = Number(statement.scheduledDate.slice(5, 7)) - 1;
    const previous = monthlyDate(year, month - 1, day);
    const next = monthlyDate(year, month + 1, day);
    if (((!firstDue || previous >= firstDue) && statement.dueDate <= previous) || statement.dueDate >= next) {
      throw new RangeError('Statement crosses another original occurrence');
    }
    byOriginal.set(statement.scheduledDate, statement);
  }
  return byOriginal;
}

function minimumRows(plan, start, end) {
  const first = new Date(start);
  const last = new Date(end);
  const firstMonth = first.getUTCFullYear() * 12 + first.getUTCMonth();
  const lastMonth = last.getUTCFullYear() * 12 + last.getUTCMonth();
  const rows = [];
  for (const obligation of plan.obligations) {
    const heloc = obligation.debtId === 'heloc' && obligation.effect === 'capitalise';
    if (!heloc && (obligation.debtId === 'mortgage' || obligation.effect !== 'payment')) continue;
    const day = heloc ? obligation.cashDay : obligation.day;
    const regularAmount = heloc ? obligation.cashPayment : obligation.amount;
    const firstDue = heloc ? obligation.cashFirstDue : obligation.firstDue;
    if (!day || (heloc && regularAmount == null)) continue;
    const statements = statementByOriginal(obligation, day, firstDue);
    for (let month = firstMonth - 1; month <= lastMonth + 1; month++) {
      const year = Math.floor(month / 12);
      const monthIndex = month % 12;
      const scheduledDate = monthlyDate(year, monthIndex, day);
      if (firstDue && scheduledDate < firstDue) continue;
      const statement = statements.get(scheduledDate);
      const date = statement ? statement.dueDate : scheduledDate;
      if (date < start || date > end) continue;
      rows.push({
        id: obligation.id,
        debtId: obligation.debtId,
        date,
        scheduledDate,
        cents: heloc ? cents(regularAmount) : plannedMinimum(obligation, statement),
        type: heloc ? 'heloc' : 'card'
      });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

// ARCHITECTURE.md, "Spendable household cash and the unknown chequing opening".
// Only the operating accounts contribute. An unknown component withholds the
// entire opening even if the other account's balance is known.
function openingCents(plan) {
  let total = 0;
  for (const row of plan.startingCash.breakdown) {
    if (!['chequing-a', 'chequing-b'].includes(row.id)) continue;
    const amount = cents(row.value);
    if (amount === null || row.unknown === true) return null;
    total += amount;
  }
  return total;
}

// ARCHITECTURE.md, "Revolving headroom, limits, pending". The fixture supplies
// a dated, known pending stock. Card spending is exposure, never chequing cash.
function cardPositions(debts) {
  return debts.filter(debt => debt.limit != null).map(debt => {
    const postedCents = cents(debt.balance);
    const pendingCents = cents(debt.pending);
    const usedCents = postedCents + pendingCents;
    const room = cents(debt.limit) - usedCents;
    return {
      id: debt.id,
      postedCents,
      pendingCents,
      usedCents,
      availableCents: Math.max(0, room),
      overLimit: room < 0,
      overLimitByCents: Math.max(0, -room)
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function expectedCash({ plan, asOf, horizonDays, opts, weeklyVariable = 0 }) {
  const start = Date.parse(asOf);
  const end = iso(start + DAY * (horizonDays - 1));
  const { income, bills } = scheduledRows(plan, asOf, end);
  const minimums = minimumRows(plan, asOf, end);
  const cards = cardPositions(opts.debts);
  const movements = new Map();

  function record(date, amount) {
    const previous = movements.get(date) || 0;
    movements.set(date, previous + amount);
  }

  for (const row of income) record(row.date, row.cents);
  // ARCHITECTURE.md, "Effective date of represented cash movement". A
  // named, already-in-opening minimum keeps its contractual date/amount but
  // cannot spend the same cash again. Use explicit IDs and scheduled dates.
  const receipts = plan.opening?.asOf === asOf ? (plan.opening.representedEvents || []) : [];
  const outstanding = minimums.filter(row => !receipts.some(receipt =>
    receipt.id === row.id && receipt.date === row.scheduledDate &&
    (!receipt.effectiveAsOf || receipt.effectiveAsOf <= asOf)));
  const deductions = bills.filter(row => row.cash).concat(outstanding);
  const opening = openingCents(plan);
  if (opening === null || deductions.some(row => row.cents === null)) {
    return { daily: null, minimumCents: null, endingCents: null, minimumRows: minimums, cards };
  }
  for (const row of deductions) record(row.date, -row.cents);
  const daily = [];
  // The documented deduction is weeklyVariable / 7 every walked day
  // (ARCHITECTURE.md, "Forecast master-period stages"). Keep seventh-cents
  // until publication so seven days deduct exactly one weekly charge. An
  // integer over seven can never be halfway between two integer cents.
  const weeklyCents = cents(weeklyVariable);
  let balanceSevenths = 7 * opening;
  let lowestSevenths = balanceSevenths;
  const publishedCents = sevenths => Math.round(sevenths / 7) || 0;
  for (let offset = 0; offset < horizonDays; offset++) {
    const date = iso(start + offset * DAY);
    balanceSevenths += 7 * (movements.get(date) || 0) - weeklyCents;
    daily.push({ date, cents: publishedCents(balanceSevenths) });
    lowestSevenths = Math.min(lowestSevenths, balanceSevenths);
  }
  return {
    daily, minimumCents: publishedCents(lowestSevenths),
    endingCents: publishedCents(balanceSevenths), minimumRows: minimums, cards
  };
}

module.exports = { expectedCash, minimumRows };
