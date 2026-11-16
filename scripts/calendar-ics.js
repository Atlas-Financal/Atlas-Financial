// Build an importable calendar of every payment date.  [B29, B74]
//
//   node scripts/calendar-ics.js [asOf YYYY-MM-DD]
//
// Writes derived/household-payments.ics — import it into Google Calendar.
//
// Cash-payment VEVENTs are DERIVED from the Plan via Forecast.expandEvents —
// the same expander the Plan calendar, nextPaymentOut and nextDue already
// use. Joint-cash outflows and dated card-paid reserves both become payment
// VEVENTs; the reserve description is distinct so a card charge is not
// labelled an external obligation. Standing reminders (statement closes,
// tax deadlines, mortgage renewal) are a thin overlay for look-points that
// are not household cash movements. A reminder must never masquerade as a
// chequing outflow.

const fs = require('fs');
const path = require('path');
const Forecast = require('../public/forecast.js');
const data = require('../data.json');

const DEFAULT_AS_OF = (data.meta && data.meta.asOf) || '2026-08-09';
// Through mortgage maturity: longer than the 91-day Plan display, still the
// same expander rather than a second recurrence engine.
const ICS_HORIZON_END = '2027-05-01';
const OUT = path.join(__dirname, '..', 'derived', 'household-payments.ics');
const KNOWLEDGE_REGISTER_PATH = path.join(__dirname, '..', 'docs/knowledge_evidence/register.json');
const TD_RENEWAL_KNOWLEDGE_ID = 'EXT-TD-RENEWAL-001';

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;')
                          .replace(/,/g, '\\,').replace(/\n/g, '\\n');

function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const take = i === 0 ? 75 : 74;
    let end = Math.min(i + take, bytes.length);
    while (end > i && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push((i === 0 ? '' : ' ') + bytes.slice(i, end).toString('utf8'));
    i = end;
  }
  return out.join('\r\n');
}

const dateOnly = d => d.replace(/-/g, '');
const nextDay = d => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10).replace(/-/g, '');
};

const MONTHLY = d => `FREQ=MONTHLY;BYMONTHDAY=${d}`;

function planItem(plan, id) {
  for (const list of [plan.income, plan.obligations, plan.bills, plan.commitments]) {
    const hit = (list || []).find(x => x.id === id);
    if (hit) return hit;
  }
  return null;
}

function money(n) {
  return Number(n).toFixed(2);
}

function paymentDescription(plan, event, asOf) {
  const item = planItem(plan, event.id);
  const note = item && item.note ? item.note.trim() : '';
  const confidence = event.confidence || (item && item.confidence) || 'estimated';
  return [
    `Household cash payment of $${money(-event.amount)}.`,
    note,
    `Kind: household cash payment — not a reminder. Derived from the Plan (${event.id}) on ${asOf}. Tagged ${confidence}.`,
  ].filter(Boolean).join('\n\n');
}

function householdObligationDescription(plan, event, asOf) {
  const item = planItem(plan, event.id);
  const note = item && item.note ? item.note.trim() : '';
  const payer = event.payingAccount || (item && item.payingAccount) || 'an account outside the joint-cash pool';
  return [
    `Household obligation of $${money(Math.abs(event.amount))}. Paid from ${payer} — not a joint-cash outflow.`,
    note,
    `Kind: reminder — household obligation, not a chequing outflow from the joint-cash pool. Derived from the Plan (${event.id}) on ${asOf}.`,
  ].filter(Boolean).join('\n\n');
}

function cardPaidReserveDescription(plan, event, asOf) {
  const item = planItem(plan, event.id);
  const note = item && item.note ? item.note.trim() : '';
  const payer = event.payingAccount || (item && item.payingAccount) || 'the card';
  return [
    `Card-paid reserve of $${money(Math.abs(event.amount))}. The Plan holds this amount against projected joint cash on ${event.date}; the charge is on ${payer}, not a second chequing withdrawal.`,
    note,
    `Kind: household cash reserve — not an external obligation and not a reminder. Derived from the Plan (${event.id}) on ${asOf}.`,
  ].filter(Boolean).join('\n\n');
}

function noncashDescription(plan, event, asOf) {
  const item = planItem(plan, event.id);
  const note = item && item.note ? item.note.trim() : '';
  return [
    `Reminder only. ${event.label} of $${money(Math.abs(event.amount))} is capitalised — no cash leaves a chequing account.`,
    note,
    `Kind: reminder — not a chequing outflow. Derived from the Plan non-cash obligation (${event.id}) on ${asOf}.`,
  ].filter(Boolean).join('\n\n');
}

function vevent(stamp, { uid, summary, start, rrule, description, alarms = 'full', kind }) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${dateOnly(start)}`,
    `DTEND;VALUE=DATE:${nextDay(start)}`,
    `SUMMARY:${esc(summary)}`,
    `DESCRIPTION:${esc(description)}`,
    `CATEGORIES:${kind === 'payment' ? 'PAYMENT' : 'REMINDER'}`,
    `X-ATLAS-KIND:${kind === 'payment' ? 'payment' : 'reminder'}`,
    'TRANSP:TRANSPARENT',
  ];
  if (rrule) lines.push(`RRULE:${rrule}`);
  if (alarms === 'full') {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(summary)}`,
               'TRIGGER:-P2DT15H', 'END:VALARM');
  }
  lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(summary)}`,
             'TRIGGER:PT9H', 'END:VALARM');
  lines.push('END:VEVENT');
  return lines;
}

function loadKnowledgeRecord(id, register) {
  const data = register || JSON.parse(fs.readFileSync(KNOWLEDGE_REGISTER_PATH, 'utf8'));
  const row = (data.items || []).find(r => r.id === id);
  if (!row) {
    throw new Error(`knowledge record ${id} is missing from docs/knowledge_evidence/register.json`);
  }
  if (!Array.isArray(row.claims) || row.claims.length === 0
      || row.claims.some(c => typeof c !== 'string' || !c.trim())) {
    throw new Error(`knowledge record ${id} has no claims`);
  }
  return row;
}

function derivedExternalReferenceText(row) {
  const sources = ((row.provenance && row.provenance.sources) || [])
    .map(s => s && s.url)
    .filter(Boolean);
  if (sources.length === 0) {
    throw new Error(`knowledge record ${row.id} has no source URLs`);
  }
  const reviewBy = row.freshness && row.freshness.review_by;
  if (!reviewBy) {
    throw new Error(`knowledge record ${row.id} has no freshness.review_by`);
  }
  return [
    row.claims.join('\n\n'),
    `External claims: ${row.id}. Review by ${reviewBy}. Not a household fact.`,
    `Sources:\n${sources.join('\n')}`,
  ].join('\n\n');
}

function subtractCalendarDays(iso, days) {
  const t = new Date(iso + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() - days);
  return t.toISOString().slice(0, 10);
}

function householdMortgageMaturity() {
  const maturity = data.mortgage && data.mortgage.maturity;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(maturity || '')) {
    throw new Error('household mortgage maturity is missing from data.json');
  }
  return maturity;
}

// Offsets come from the knowledge record. Do not hard-code 150/120 here.
const HOLD_OFFSET_RE = /extendable to about (\d+) days/;
const WINDOW_OFFSET_RE = /up to (\d+) days before maturity/;

function tdRenewalClaimOffsets(row) {
  const text = (row.claims || []).join('\n');
  const hold = HOLD_OFFSET_RE.exec(text);
  const window = WINDOW_OFFSET_RE.exec(text);
  const holdDays = hold ? Number(hold[1]) : NaN;
  const windowDays = window ? Number(window[1]) : NaN;
  return {
    holdDays: Number.isFinite(holdDays) && holdDays > 0 ? holdDays : null,
    windowDays: Number.isFinite(windowDays) && windowDays > 0 ? windowDays : null,
  };
}

function renewalLookPoint(uid, days, maturity, recordId, lead, description) {
  return {
    uid,
    summary: `Reminder — Mortgage renewal look-point (${days} days before household maturity; ${recordId})`,
    start: subtractCalendarDays(maturity, days),
    kind: 'reminder',
    description: lead + description,
  };
}

// First business day of July (A22): 1 July is Canada Day; when it falls on a
// Sunday the Monday (2 July) is the observed holiday. A Saturday Canada Day is
// not assumed to move to Monday, so the reminder can be a day early, never late.
function firstBusinessDayOfJuly(year) {
  const iso = d => `${year}-07-${String(d).padStart(2, '0')}`;
  const dow = d => new Date(Date.UTC(year, 6, d)).getUTCDay();
  const holidays = new Set([1]);
  if (dow(1) === 0) holidays.add(2);
  for (let d = 2; d <= 10; d++) {
    if (dow(d) !== 0 && dow(d) !== 6 && !holidays.has(d)) return iso(d);
  }
  throw new Error('no business day in early July ' + year);
}

// The next ten due dates on or after asOf.
function propertyTaxReminderYears(asOf) {
  const year = Number(String(asOf).slice(0, 4));
  const first = firstBusinessDayOfJuly(year) >= asOf ? year : year + 1;
  return Array.from({ length: 10 }, (_, i) => first + i);
}

function standingReminders(asOf, register) {
  const src = `\n\nKind: reminder — not a chequing outflow. Standing look-point from the household finance review, read from the institutions on ${asOf}.`;
  // Mortgage-renewal reminder text, and the 150/120 look-point labels and
  // dates, derive from EXT-TD-RENEWAL-001. Do not hard-code that claim body,
  // those offsets, or the source URLs here.
  const tdRow = loadKnowledgeRecord(TD_RENEWAL_KNOWLEDGE_ID, register);
  const tdRenewalText = derivedExternalReferenceText(tdRow);
  const maturity = householdMortgageMaturity();
  const offsets = tdRenewalClaimOffsets(tdRow);
  const events = [];

  for (const [day, card, note] of [
    [5,  'Travel Visa',          'Watch for pending charges pushing it over its limit.'],
    [6,  'Amazon / MBNA',        'Sets the minimum due at month end.'],
    [7,  'TD Cash Back Visa',    'Check whether the over-limit fee was charged again, and what the new minimum is — it swings hard on this card.'],
    [17, 'Triangle Mastercard',  'Sets the minimum due on the 7th.'],
    [23, 'TD personal Visa',     'Sets the minimum due on the 17th. Also the place to confirm the on-time-payment count towards restoring the lower rate.'],
  ]) {
    const first = day <= 9 ? `2026-09-${String(day).padStart(2, '0')}`
                           : `2026-08-${String(day).padStart(2, '0')}`;
    events.push({
      uid: `atlas-reminder-stmt-${day}@household`,
      summary: `Reminder — ${card} statement closes`,
      start: first,
      rrule: MONTHLY(day),
      alarms: 'day-of',
      kind: 'reminder',
      description: `${note}\n\nNot a payment date — this is when the amount you owe next is decided.` + src,
    });
  }

  events.push(
    { uid: 'atlas-reminder-heloc-due-21@household',
      summary: 'Reminder — HELOC contractual due date (TD-stated 21st)',
      start: '2026-08-21', rrule: MONTHLY(21),
      kind: 'reminder',
      sourceId: 'heloc-contractual-due',
      description: 'TD Home Equity FlexLine contractual due date. Observed posting of the interest charge is month-end capitalisation into the HELOC balance, not that charge leaving chequing. Owner 2026-09-18: expandEvents emits the encoded cashPayment on cashDay 21 from cashFirstDue 2026-09-21 as one chequing obligation (Forecast Required debt). Capitalise remains nonCash. Statements show a PAD around the 1st and that a manual payment at least equal to the minimum, made before the due date, satisfies that minimum rather than causing a second full cash collection. Q19 ANSWERED 2026-08-18: the mid-August payment already inside the 2026-08-16 opening satisfies the August minimum, so no further August HELOC cash is required. Do not invent another August chequing outflow for it. Interest is not free. This reminder does not state that an Aug. 1 PAD occurred.' + src },
    { uid: 'atlas-reminder-cra@household',
      summary: 'Reminder — CRA tax filing and any balance owing', start: '2027-04-30', rrule: 'FREQ=YEARLY',
      kind: 'reminder',
      description: 'Filing deadline and the date any balance owing is due for most individuals. If either of you is self-employed, the filing deadline is 15 June but any balance owing is still due 30 April.\n\nA CRA amount was paid from the HELOC in July 2026. If instalments are ever required they fall on 15 March, 15 June, 15 September and 15 December.\n\nBoth businesses need to be separated before this is straightforward — an accountant\'s question.' + src },
    { uid: 'atlas-reminder-renewal-quotes@household',
      summary: 'Reminder — Mortgage renewal: start collecting quotes (6 months out)', start: '2026-11-02',
      kind: 'reminder',
      description: 'The mortgage matures 1 May 2027. Nothing can be locked yet, but this is the point to start gathering competing offers so you are comparing rather than accepting.\n\nThe live question is whether to fold the interest-only HELOC into the mortgage. Folding it in would force principal repayment and lower the rate, at the cost of a higher monthly payment.\n\nA lender will order its own appraisal and will not take an owner estimate.' + src },
  );
  // A22: BC municipal property tax falls due on the first business day of
  // July, so the reminder is dated per year rather than a fixed 2 July.
  for (const year of propertyTaxReminderYears(asOf)) {
    events.push({ uid: `atlas-reminder-property-tax-${year}@household`,
      summary: 'Reminder — Maple Ridge property tax due', start: firstBusinessDayOfJuly(year),
      kind: 'reminder',
      description: 'Statutory reminder only: BC municipal property tax falls due on the first business day of July. 1 July is Canada Day, so it is normally the 2nd. This reminder is that statutory look-point. It is not the household planning/funding date, and it does not publish the planning amount. The planning date and amount live on the property-tax reserve.\n\nIn 2026 it was PAID FROM THE HELOC — a predictable annual bill converted into permanent debt on a facility that never amortises. Worth funding another way if at all possible.\n\nCheck the Home Owner Grant on the notice: in BC it has to be claimed every year, separately, and it is worth several hundred dollars if you qualify. It is not applied automatically.' + src });
  }
  if (offsets.holdDays != null) {
    events.push(renewalLookPoint(
      'atlas-reminder-renewal-hold@household',
      offsets.holdDays,
      maturity,
      TD_RENEWAL_KNOWLEDGE_ID,
      'From roughly today, ask TD to hold a rate. There is no cost to asking.\n\n',
      tdRenewalText + src
    ));
  }
  if (offsets.windowDays != null) {
    events.push(renewalLookPoint(
      'atlas-reminder-renewal-window@household',
      offsets.windowDays,
      maturity,
      TD_RENEWAL_KNOWLEDGE_ID,
      'If a lender switch is going to happen, do not leave it to April.\n\n',
      tdRenewalText + src
    ));
  }
  events.push(
    { uid: 'atlas-reminder-renewal-letter@household',
      summary: 'Reminder — Mortgage renewal: TD offer letter should have arrived', start: '2027-04-01',
      kind: 'reminder',
      description: 'If nothing has arrived, chase it. A competing quote in hand is what makes negotiating the opening offer work.\n\n' + tdRenewalText + src },
    { uid: 'atlas-reminder-maturity@household',
      summary: 'Reminder — MORTGAGE MATURES', start: '2027-05-01',
      kind: 'reminder',
      description: 'The single most consequential date in the whole picture: the 60-month term ends.\n\nDo not let it arrive undecided.\n\n' + tdRenewalText + src },
  );

  return events;
}

function buildHouseholdCalendar(plan, asOf, end, register) {
  asOf = asOf || DEFAULT_AS_OF;
  end = end || ICS_HORIZON_END;
  const stamp = asOf.replace(/-/g, '') + 'T120000Z';
  const stream = Forecast.expandEvents(plan, asOf, end, {});

  const payments = [];
  const derivedReminders = [];
  for (const event of stream) {
    if (event.kind === 'noncash' || (event.jointCash === false && !event.cardPaid)) {
      const external = event.jointCash === false;
      derivedReminders.push({
        uid: `atlas-reminder-${event.id}-${dateOnly(event.date)}@household`,
        summary: external
          ? `Reminder — ${event.label} (household obligation; not joint cash)`
          : `Reminder — ${event.label} (no cash leaves chequing)`,
        start: event.date,
        kind: 'reminder',
        alarms: 'day-of',
        description: external
          ? householdObligationDescription(plan, event, asOf)
          : noncashDescription(plan, event, asOf),
        sourceId: event.id,
        amount: Math.abs(event.amount),
      });
      continue;
    }
    if (!(event.amount < 0)) continue;
    const cardPaid = event.cardPaid === true;
    payments.push({
      uid: `atlas-pay-${event.id}-${dateOnly(event.date)}@household`,
      summary: cardPaid
        ? `${event.label} — $${money(Math.abs(event.amount))} (card-paid reserve)`
        : `${event.label} — $${money(-event.amount)}`,
      start: event.date,
      kind: 'payment',
      description: cardPaid
        ? cardPaidReserveDescription(plan, event, asOf)
        : paymentDescription(plan, event, asOf),
      sourceId: event.id,
      amount: Math.abs(event.amount),
    });
  }

  const reminders = derivedReminders.concat(standingReminders(asOf, register));
  const events = payments.concat(reminders);
  const body = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//atlas-financial//household payments//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Bills & payments',
    'X-WR-TIMEZONE:' + Forecast.HOUSEHOLD_TIMEZONE,
    `X-WR-CALDESC:${esc('Household cash payments derived from the Plan, plus reminder-only look-points (statement closes, tax, mortgage renewal). Generated ' + asOf + ' by scripts/calendar-ics.js. Payment amounts are the Plan figures as at that date.')}`,
    ...events.flatMap(e => vevent(stamp, e)),
    'END:VCALENDAR',
  ];

  return {
    ics: body.map(fold).join('\r\n') + '\r\n',
    payments,
    reminders,
    events,
    asOf,
    end,
  };
}

function writeHouseholdCalendar(asOf, end) {
  const built = buildHouseholdCalendar(data.plan, asOf, end);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, built.ics);
  return built;
}

if (require.main === module) {
  const asOf = process.argv[2] || DEFAULT_AS_OF;
  const built = writeHouseholdCalendar(asOf);
  console.log(`Wrote ${OUT}`);
  console.log(`${built.payments.length} payment occurrences, ${built.reminders.length} reminders\n`);
  for (const e of built.events) {
    const when = e.rrule ? (e.rrule.includes('YEARLY') ? 'yearly'
                          : e.rrule.includes('WEEKLY') ? 'bi-weekly'
                          : 'monthly, day ' + (e.rrule.match(/BYMONTHDAY=(-?\d+)/) || [])[1])
                         : 'once';
    console.log('  ' + e.start + '  ' + String(when).padEnd(20) + e.summary);
  }
}

module.exports = {
  buildHouseholdCalendar,
  writeHouseholdCalendar,
  loadKnowledgeRecord,
  derivedExternalReferenceText,
  tdRenewalClaimOffsets,
  subtractCalendarDays,
  TD_RENEWAL_KNOWLEDGE_ID,
  ICS_HORIZON_END,
  firstBusinessDayOfJuly,
  DEFAULT_AS_OF,
};
