'use strict';
// An independent legacy locale oracle: reuse formatter objects, never results.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const f = vm.runInNewContext(source.slice(0, source.indexOf('// Household YYYY-MM-DD only.'))
  + '\n({money2,fmtDate,fmtDateLong,fmtDateFull})');
const plan = fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8');
const p = vm.runInNewContext(plan.slice(plan.indexOf('const addDays ='), plan.indexOf('/* --------------------------------------------------- the mission'))
  + '\n({fmtMonth,fmtRange})');
for (const value of [0, -0, 1.005, 1234567.89, -987654.32, '1200.40', null, undefined, NaN, Infinity, -Infinity]) {
  // Finite values keep the exact legacy cents; an unknown (null, undefined,
  // NaN, ±Infinity) prints Unknown, never $0.00 / $NaN / $∞ (#893).
  const expected = !Number.isFinite(Number(value)) || value === null ? 'Unknown'
    : (value < 0 ? '−$' : '$') + Math.abs(Number(value)).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.equal(f.money2(value), expected);
}
for (const iso of ['2026-01-01', '2026-03-08', '2026-08-14', '2026-11-01', '2026-12-31', '2027-01-01', 'unavailable', '', null]) {
  assert.equal(p.fmtMonth(iso), new Date(iso + 'T00:00:00').toLocaleDateString('en-CA', {month:'long'}));
  for (const [name, options] of [['fmtDate', {day:'numeric',month:'short'}], ['fmtDateLong', {day:'numeric',month:'long'}], ['fmtDateFull', {day:'numeric',month:'long',year:'numeric'}]]) {
    assert.equal(f[name](iso), new Date(iso + 'T00:00:00').toLocaleDateString('en-CA', options));
  }
}
for (const [a,b] of [['2026-08-14','2026-08-27'],['2026-08-28','2026-09-10'],['2026-12-25','2027-01-07'],['unavailable','']]) {
  const s=new Date(a+'T00:00:00'),e=new Date(b+'T00:00:00');
  const sm=s.toLocaleDateString('en-CA',{month:'short'}),em=e.toLocaleDateString('en-CA',{month:'short'});
  assert.equal(p.fmtRange(a,b),sm===em?`${s.getDate()}–${e.getDate()} ${em}`:`${s.getDate()} ${sm} – ${e.getDate()} ${em}`);
}
console.log('PASS selector locale formatting: exact legacy cents, signs, unknowns as Unknown, local dates, year boundaries and invalid dates');

// Exercise the same standalone extraction that failed in the four composers.
// No plan.js globals are supplied; the two renderers must carry their own
// formatter dependencies, and reuse objects rather than cache date strings.
const extract = name => {
  const match = plan.match(new RegExp('^function '+name+'\\([\\s\\S]*?\\n\\}', 'm'));
  assert.ok(match, 'real renderer is available: '+name); return match[0];
};
let constructed = 0;
const renderer = vm.runInNewContext([
  extract('payPeriodCloseMonth'), extract('payPeriodMonths'), extract('payPeriodNavigatorHtml'),
  '({payPeriodMonths,payPeriodNavigatorHtml})',
].join('\n'), {
  Intl: { DateTimeFormat: function(...args) { constructed++; return new Intl.DateTimeFormat(...args); } },
  payPeriodRangeLabel: row => `${row.start} – ${row.end}`,
  payPeriodStatusLabel: row => row.timelineRole,
});
const rows = [
  {id:'aug',start:'2026-08-14',end:'2026-08-27',timelineRole:'current'},
  {id:'sep-first',start:'2026-08-28',end:'2026-09-10',timelineRole:'future'},
  {id:'sep-second',start:'2026-09-11',end:'2026-09-24',timelineRole:'future'},
  {id:'jan',start:'2026-12-25',end:'2027-01-07',timelineRole:'future'},
];
assert.equal(renderer.payPeriodNavigatorHtml({period:null,rows:[],index:-1}), '');
assert.equal(constructed, 0, 'an absent native period does not format an invented date');
const expectedMonths = [rows[0],rows[1],rows[3]].map(row => ({
  key:row.end.slice(0,7),id:row.id,
  label:new Date(row.end+'T12:00:00').toLocaleDateString('en-CA',{month:'long'}),
  name:new Date(row.end+'T12:00:00').toLocaleDateString('en-CA',{month:'long',year:'numeric'}),
}));
for (let i=0;i<rows.length;i++) {
  const selection={rows,period:rows[i],index:i};
  assert.deepEqual(JSON.parse(JSON.stringify(renderer.payPeriodMonths(selection))),expectedMonths);
  const full = value => new Date(value+'T12:00:00').toLocaleDateString('en-CA',{month:'short',day:'numeric',year:'numeric'});
  assert.ok(renderer.payPeriodNavigatorHtml(selection).includes(`${full(rows[i].start)} – ${full(rows[i].end)}`));
}
const next={id:'later-year',start:'2027-12-24',end:'2028-01-06',timelineRole:'future'};
assert.equal(renderer.payPeriodMonths({rows:[next]})[0].name,'January 2028');
assert.equal(constructed,3,'date, month and month/year objects are reused across selections and changed date inputs');
console.log('PASS standalone selector renderers: isolated date/month dependencies, exact locale output and three reused formatter objects');
