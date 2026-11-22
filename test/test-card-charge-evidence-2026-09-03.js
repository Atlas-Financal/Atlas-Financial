'use strict';
/* 2026-09-03 owner-provided revolving-card evidence intake.
 * `node test/test-card-charge-evidence-2026-09-03.js`
 *
 * Proves the pack is filed with coverage caveats and that plan.bills was
 * not extended from discovery. Independent of Forecast.occurrences:
 * forbidden merchants are checked on the live bills array itself.
 */
const fs = require('fs');
const path = require('path');
const data = require('../data.json');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const INTAKE = path.join(ROOT, 'docs/source_intake/HOUSEHOLD_CARD_CHARGE_EVIDENCE_2026-09-03.md');
const REGISTER = path.join(ROOT, 'docs/evidence_use/register.json');
const QUESTIONS = path.join(ROOT, 'docs/01_OPEN_QUESTIONS.md');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const intake = sourceText(fs.readFileSync(INTAKE, 'utf8'));
const questions = sourceText(fs.readFileSync(QUESTIONS, 'utf8'));
const register = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));
const bills = data.plan.bills || [];

function registerRow(id) {
  return (register.items || []).find(row => row.id === id);
}

function routesPhoenix(row) {
  if (!row || row.disposition !== 'CONSUMED' || !row.routed_to
      || row.routed_to.path !== 'data.json') return false;
  const pointer = row.routed_to.json_pointer;
  if (typeof pointer !== 'string' || !/^\/plan\/bills\/\d+$/.test(pointer)) return false;
  const bill = pointer.slice(1).split('/').reduce((cur, part) => (
    cur == null || !Object.prototype.hasOwnProperty.call(cur, part) ? null : cur[part]
  ), data);
  return !!bill && bill.id === 'phoenix-digital-health';
}

function routesPrimeAdFree(row) {
  if (!row || row.disposition !== 'CONSUMED'
      || row.source !== 'docs/source_intake/STREAMING_BILLS_2026-10-10.md'
      || !row.routed_to || row.routed_to.path !== 'data.json') return false;
  const pointer = row.routed_to.json_pointer;
  if (typeof pointer !== 'string' || !/^\/plan\/bills\/\d+$/.test(pointer)) return false;
  const bill = pointer.slice(1).split('/').reduce((cur, part) => (
    cur == null || !Object.prototype.hasOwnProperty.call(cur, part) ? null : cur[part]
  ), data);
  return !!bill && bill.id === 'prime-video-ad-free';
}

function isOwnerApprovedAdFree(bill, route) {
  return !!bill && bill.id === 'prime-video-ad-free'
    && /^Owner 2026-10-10/.test(bill.note || '')
    // Owner fact 2026-11-21 ("all on Bills now"): paid from Bills, no longer via Wise.
    && bill.subscription === true
    && bill.payingAccount === 'chequing-a' && /Owner fact 2026-11-21/.test(bill.note || '')
    && routesPrimeAdFree(route);
}

console.log('=== coverage caveat is recorded, not 18–24 months ===');
{
  ok(/2026-02-02/.test(intake) && /2026-09-03/.test(intake),
    'inclusive card window 2026-02-02 → 2026-09-03 is recorded');
  ok(/~7 months/.test(intake) && /not 18.?24 months/i.test(intake),
    'pack states ~7 months and refuses an 18–24 month claim');
  ok(/travelvisa/.test(intake) && /215/.test(intake),
    'Travel Visa 215 txns recorded');
  ok(/cashback/.test(intake) && /152/.test(intake),
    'Cash Back 152 txns recorded');
  ok(/PERSONAL CREDIT CARD \| 17 \|/.test(intake),
    'Personal Credit Card 17 txns recorded');
  ok(/Amazon MBNA Credit Card \| 7 \|/.test(intake),
    'MBNA 7 txns recorded');
  ok(/Triangle Mastercard \| \*\*ZERO\*\*/.test(intake)
    && /not evidence of absence/.test(intake),
    'Triangle zero is recorded as not evidence of absence');
}

console.log('\n=== Phoenix historical discovery and later owner routing ===');
{
  ok(/Phoenix Digital Health/.test(intake) && /PHOENIX DIGITAL HEALTH/.test(intake),
    'exact merchant is recorded');
  ok(/2026-08-05/.test(intake) && /124\.99/.test(intake),
    'first hit 2026-08-05 −$124.99 is recorded');
  ok(/2026-09-03/.test(intake) && /174\.99/.test(intake) && /pending/i.test(intake),
    'second hit 2026-09-03 −$174.99 pending is recorded');
  ok(/Interval 29 days/.test(intake) && /Monthly is UNPROVEN/i.test(intake),
    '29-day interval is not promoted to a proven monthly bill');
  ok(/Two hits[\s\S]{0,40}not a bill/i.test(intake),
    'two hits are not a bill');
  const phoenixSection = intake.split('## Phoenix Digital Health')[1].split('\n## ')[0];
  ok(/As of 2026-09-03/.test(phoenixSection)
      && /Owner 2026-10-06/.test(phoenixSection)
      && /Routed to live `plan\.bills` `phoenix-digital-health`/.test(phoenixSection),
    'Phoenix intake separates historical discovery from the dated owner promotion');
  ok(/category remains unconfirmed/i.test(phoenixSection),
    'Phoenix routing leaves its category unconfirmed');
  ok(/Owner-stated planning assumption: monthly on the 3rd/.test(phoenixSection)
      && /renewal day is not invoice-verified/i.test(phoenixSection),
    'Phoenix planning cadence is attributed to the owner, not verified from merchant history');
  ok(/Owner 2026-11-21[\s\S]{0,120}due on the 4th of each month/.test(phoenixSection)
      && /supersedes the day-3 planning\s+assumption/.test(phoenixSection)
      && /day 4,\s+firstDue 2026-10-04/.test(phoenixSection),
    'Phoenix intake records the owner 2026-11-21 due day (the 4th) superseding the day-3 assumption, matching plan.bills');
  const phoenixRow = bills.find(b => b.id === 'phoenix-digital-health') || {};
  ok(phoenixRow.day === 4 && phoenixRow.firstDue === '2026-10-04',
    'plan.bills phoenix-digital-health is day 4, firstDue 2026-10-04', JSON.stringify([phoenixRow.day, phoenixRow.firstDue]));
  ok(!/phoenix/i.test(questions),
    'this pack does not open a Phoenix purpose question');
}

console.log('\n=== Amazon shopping stays off plan.bills; membership is CARD-011 ===');
{
  ok(/36 shopping charges/.test(intake) && /Not a subscription/i.test(intake),
    'Travel Visa Amazon shopping is recorded as not a subscription');
  ok(/CARD-011/.test(intake) && /\$11\.19/.test(intake)
      && /Routed to live `plan\.bills` `amazon-prime`/.test(intake),
    'Prime membership $11.19 evidence is declared as CARD-011 and routed');
  ok(/\$24\.63/.test(intake) && /not the membership/i.test(intake),
    'the separate $24.63 charge stays outside the membership');
  ok(/not automatically Amanda/i.test(intake) && /2026-07-13/.test(intake),
    'MBNA Amazon is not Amanda by default');
}

console.log('\n=== unplanned card candidates are evidence only ===');
{
  ok(/MAILCHIMP/.test(intake) && /31\.73/.test(intake) && /32\.53/.test(intake),
    'Mailchimp five-hit series is recorded');
  ok(/AICHATAPP\+18888287054/.test(intake) && /44\.99/.test(intake),
    'AICHATAPP merchant and $44.99 cadence are recorded');
  ok(/Not enough to call already planned/i.test(intake),
    'AICHATAPP is not treated as ChatGPT Plus');
  ok(/CALENDLY/.test(intake) && /19\.09/.test(intake),
    'Calendly four-hit series is recorded');
  ok(/INTEREST CHARGE -PURCHASE/.test(intake)
    && /not a new `plan\.bills` row/.test(intake),
    'card interest stays off plan.bills');
}

console.log('\n=== plan.bills was not extended from this discovery ===');
{
  const forbidden = /phoenix|calendly|aichat|shopify/i;
  // Owner 2026-10-06 later confirmed Phoenix as one monthly card-paid bill (the
  // promotion CARD-002 deferred to a one-outcome PR); discovery itself added none.
  const hits = bills.filter(b => forbidden.test(`${b.id} ${b.label}`)
    && !(b.id === 'phoenix-digital-health' && /^Owner 2026-10-06/.test(b.note || '')
      && routesPhoenix(registerRow('CARD-002'))));
  ok(hits.length === 0,
    'no forbidden merchant became a plan.bills id or label from this discovery',
    hits.map(b => b.id).join(','));
  ok(bills.filter(b => b.id === 'phoenix-digital-health').length === 1,
    'the owner-confirmed Phoenix bill has one canonical row');
  const primeRows = bills.filter(b => b && b.id === 'amazon-prime');
  ok(primeRows.length === 1
      && primeRows[0].amount === 11.19
      && primeRows[0].day === 19
      && primeRows[0].firstDue === '2026-09-19'
      && primeRows[0].payingAccount === 'travelvisa'
      && primeRows[0].jointCash === false,
    'owner 2026-09-22 promoted only the $11.19 Travel Visa Prime membership');
  // The later streaming approval has its own receipt intake and routing. It
  // must not weaken this pack's shopping/$24.63 exclusion or CARD-011 identity.
  const adFreeRoute = registerRow('STREAMING-003');
  ok(!bills.some(b => b && b.id !== 'amazon-prime' && /prime/i.test(`${b.id} ${b.label}`)
      && !isOwnerApprovedAdFree(b, adFreeRoute)),
    'no second Prime row was added from shopping or the $24.63 charge');
  const adFree = bills.find(b => b.id === 'prime-video-ad-free');
  ok(isOwnerApprovedAdFree(adFree, adFreeRoute),
    'the separate ad-free bill traces to the later owner-approved STREAMING-003 source');
  ok(!isOwnerApprovedAdFree({ ...adFree, id: 'prime-shopping' }, adFreeRoute)
      && !isOwnerApprovedAdFree({ ...adFree, note: 'Repeated shopping discovery' }, adFreeRoute)
      && !isOwnerApprovedAdFree({ ...adFree, payingAccount: 'travelvisa' }, adFreeRoute),
    'the exception rejects shopping identity, discovery-only evidence and inferred Travel Visa');
  ok(!routesPrimeAdFree({ ...adFreeRoute, disposition: 'EXCLUDED' })
      && !routesPrimeAdFree({ ...adFreeRoute, source: 'docs/source_intake/HOUSEHOLD_CARD_CHARGE_EVIDENCE_2026-09-03.md' })
      && !routesPrimeAdFree({ ...adFreeRoute, routed_to: registerRow('CARD-011').routed_to }),
    'ad-free routing rejects an excluded row, old discovery source and Prime membership pointer');
  ok(!bills.some(b => /mailchimp/i.test(b.id + ' ' + b.label)),
    'Mailchimp is not a plan.bills row');
  ok(/Canva, Mailchimp, Guitar Tabs monthly, and GitHub annual have no forward recurrence/.test(data.plan.billsNote),
    'Mailchimp remains off forward recurrence in billsNote');

  const dale = bills.find(b => b.id === 'chatgpt-plus-dale');
  ok(dale && dale.amount === 28 && dale.day === 14 && dale.confidence === 'estimated',
    'ChatGPT Plus Dale remains $28 estimated on the 14th, not AICHATAPP $44.99 on the 2nd');
  const amanda = bills.find(b => b.id === 'chatgpt-plus-amanda');
  ok(amanda && amanda.amount === 24.99 && amanda.day === 14,
    'ChatGPT Plus Amanda remains $24.99 on the 14th');

  const bell = bills.find(b => b.id === 'bell');
  ok(bell && bell.amount === 160 && bell.day === 15 && bell.needsDate !== true
      && bell.firstDue === '2026-10-15'
      && bell.confidence === 'confirmed' && bell.payingAccount === 'chequing-a',
    'Bell standing is confirmed $160, dated from BILLS ACCOUNT on the 15th from October');
  ok(/\$250/.test(bell.note) && /\$69\.15/.test(bell.note) && /settlement/i.test(bell.note),
    'Bell $250 / $69.15 stay settlement/route evidence on the existing row');

  const noble = bills.find(b => b.id === 'noble-garbage');
  ok(noble && noble.amount === 95.85 && noble.frequency === 'quarterly',
    'noble-garbage remains the quarterly $95.85 row');

  ok(!bills.some(b => b.id === 'cmaw' || /cmaw/i.test(b.label)),
    'cancelled CMAW was not re-added');
  ok(!bills.some(b => /telus/i.test(b.id + b.label)),
    'closed Telus was not re-added');
  const affirm = bills.find(b => b.id === 'affirm-final');
  ok(affirm && affirm.amount === 32.53 && affirm.date === '2026-09-21' && affirm.frequency === 'once',
    'Affirm remains the one remaining $32.53 once row');
}

console.log('\n=== register routes the declared CARD ids ===');
{
  const ids = [
    'CARD-001', 'CARD-002', 'CARD-003', 'CARD-004', 'CARD-005',
    'CARD-006', 'CARD-007', 'CARD-008', 'CARD-009', 'CARD-010',
    'CARD-011',
  ];
  ok(ids.every(id => intake.includes(id)),
    'intake evidence-ids fence lists CARD-001 through CARD-011');
  for (const id of ids) {
    const row = registerRow(id);
    ok(!!row, `${id} has a register row`);
  }
  const phoenixRoute = registerRow('CARD-002');
  ok(routesPhoenix(phoenixRoute),
    'CARD-002 is CONSUMED onto the named Phoenix bill');
  ok(!routesPhoenix({ ...phoenixRoute, disposition: 'EXCLUDED' }),
    'Phoenix routing rejects a stale excluded disposition');
  ok(!routesPhoenix({ ...phoenixRoute, routed_to: {
    path: 'data.json', json_pointer: registerRow('CARD-011').routed_to.json_pointer,
  } }), 'Phoenix routing rejects a pointer to another bill');
  ok(!routesPhoenix({ ...phoenixRoute, routed_to: {
    path: 'docs/ACCOUNT_FACTS.md', json_pointer: '/plan/bills/23',
  } }), 'Phoenix routing rejects a pointer on the wrong incumbent');
  ok(registerRow('CARD-003').disposition === 'EXCLUDED'
      && /shopping/i.test(registerRow('CARD-003').exclusion_reason)
      && /CARD-011/.test(registerRow('CARD-003').exclusion_reason),
    'Amazon shopping stays EXCLUDED; membership is CARD-011');
  ok(registerRow('CARD-004').disposition === 'EXCLUDED'
      && /Mailchimp/.test(registerRow('CARD-004').exclusion_reason)
      && /AICHATAPP/.test(registerRow('CARD-004').exclusion_reason)
      && /Calendly/.test(registerRow('CARD-004').exclusion_reason)
      && /CARD-011/.test(registerRow('CARD-004').exclusion_reason),
    'Mailchimp, AICHATAPP, and Calendly stay EXCLUDED');
  ok(registerRow('CARD-006').disposition === 'CONSUMED'
    && registerRow('CARD-006').routed_to
    && /Bell Mobility/.test(registerRow('CARD-006').routed_to.heading),
    'Bell card hits route to the incumbent Bell heading');
  ok(registerRow('CARD-010').disposition === 'CONSUMED'
    && registerRow('CARD-010').routed_to.json_pointer === '/plan/bills',
    'already-planned roster routes to live plan.bills');
  const primeRoute = registerRow('CARD-011');
  const primePointer = primeRoute && primeRoute.routed_to && primeRoute.routed_to.json_pointer;
  let routedBill = null;
  if (primePointer && primePointer.startsWith('/')) {
    routedBill = primePointer.slice(1).split('/').reduce((cur, part) => (
      cur == null || !Object.prototype.hasOwnProperty.call(cur, part) ? null : cur[part]
    ), data);
  }
  ok(primeRoute && primeRoute.disposition === 'CONSUMED'
      && primeRoute.routed_to && primeRoute.routed_to.path === 'data.json'
      && routedBill && routedBill.id === 'amazon-prime'
      && routedBill.amount === 11.19
      && routedBill.day === 19
      && routedBill.payingAccount === 'travelvisa',
    'CARD-011 is CONSUMED onto plan.bills amazon-prime');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll proofs passed.');
