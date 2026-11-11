'use strict';
// Independent invented reporting inputs. The approved 450 target is policy;
// every balance/category amount here is invented, not scaled household data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process'),S=require('../scripts/positions-summary'),F=require('../public/forecast');
const clone=x=>JSON.parse(JSON.stringify(x)),root=path.join(__dirname,'..');
const data={meta:{asOf:'2026-08-19'},accounts:[],assets:[],debts:[],revolvingExtra:[],plan:{
 opening:{asOf:'2026-08-19'},defaults:{},income:[],bills:[],obligations:[],commitments:[],
 startingCash:{breakdown:[{id:'chequing-a',value:700},{id:'chequing-b',value:150}]},
 budget:{basis:'ytd',categories:[{id:'groceries',label:'Invented essentials',class:'essential',plannedMonthly:275,from:[]},
  {id:'other-spend',label:'Other spend',class:'essential',plannedMonthly:null,plannedPayday:450,
   targetEffectiveFrom:'2026-09-25',targetSource:'owner-stated-2026-10-04',
   targetHistory:[{effectiveThrough:'2026-09-24',plannedMonthly:800,targetSource:'owner-stated-2026-09-18'}],from:[]}]}}};
const periods={asOf:'2026-08-24',source:{coverageThrough:'2026-08-24'},periods:{ytd:{months:1,spending:[]}}};
const labels=['Essential spending estimate','Weeks of essentials covered'];
const row=(type,label,value,date,note)=>{const c=Array(21).fill('');c[0]=type;c[2]=label;c[6]=String(value);c[19]=date;c[20]=note;return S.line(c);};
const captured=row('Household','Invented captured evidence',700,'2026-08-19','Independent captured row; preserve unchanged');
const input=[row('Type','Label','Value','AsOf','Note'),captured,...labels.map(label=>row('LIQUIDITY',label,0,'2026-08-19',''))].join('\n');
const before=JSON.stringify(data),actual=S.regenerateComputedRows(data,input,{periods}).text;
const rows=text=>text.split(/\r?\n/).map(S.parse),find=(text,label)=>rows(text).find(c=>c[2]===label);
// Independent cents: 450 * (1461/48 calendar days) / 14 = 978.35
// monthly; plus invented 275 = 1253.35. Existing report week is 12/52.
assert.equal(find(actual,labels[0])[6],'1253.35');
assert.equal(find(actual,labels[1])[6],'2.9','850 / (1253.35 * 12/52), rounded to one decimal');
assert.match(find(actual,labels[1])[20],/289\.23 a week/);
for(const label of labels){
 const c=find(actual,label);assert.equal(c[19],'2026-10-04');
 assert.match(c[20],/Financial-account opening 2026-08-19/);
 assert.match(c[20],/historical actuals through 2026-08-24/);
 assert.match(c[20],/owner budget target 2026-10-04/);
}
assert.ok(actual.split('\n').includes(captured),'captured financial evidence remains byte-for-byte unchanged');
assert.equal(JSON.stringify(data),before,'reporting does not rewrite canonical inputs');
assert.equal(F.budgetBreakdown(data.plan,periods,{asOf:'2026-08-19'}).requiredMonthly,1075,
 'historical opening still uses 275 + retired 800; reporting must not change Forecast history');

// Construct retired quantities with a falsely advanced provenance stamp.
// --check must reject this exact defect, rather than accepting the old target
// simply because the financial account opening precedes the restatement.
const historical=clone(data),other=historical.plan.budget.categories[1];
other.plannedMonthly=800;delete other.plannedPayday;delete other.targetEffectiveFrom;delete other.targetHistory;
other.targetSource='owner-stated-2026-09-18';
const historicalReport=S.regenerateComputedRows(historical,input,{periods}).text;
assert.equal(find(historicalReport,labels[0])[6],'1075.00');
const stale=rows(historicalReport).map(c=>{
 if(labels.includes(c[2])){c[19]='2026-10-04';c[20]=c[20].replace('owner budget target 2026-09-18','owner budget target 2026-10-04');}
 return S.line(c);
}).join('\n');
const tempRoot=path.resolve(os.tmpdir()),temp=fs.mkdtempSync(path.join(tempRoot,'atlas-report-policy-'));
try{
 for(const folder of ['scripts','public','docs'])fs.mkdirSync(path.join(temp,folder));
 for(const file of ['scripts/positions-summary.js','public/forecast.js','public/forecast-card-period.js','public/display-name.js'])fs.copyFileSync(path.join(root,file),path.join(temp,file));
 fs.writeFileSync(path.join(temp,'data.json'),JSON.stringify(data));
 fs.writeFileSync(path.join(temp,'public/periods.json'),JSON.stringify(periods));
 const csv=path.join(temp,'docs/positions.csv'),script=path.join(temp,'scripts/positions-summary.js');
 const run=(args)=>spawnSync(process.execPath,[script,...args],{cwd:temp,encoding:'utf8'});
 fs.writeFileSync(csv,stale);
 const denied=run(['--check']);assert.equal(denied.status,1,'late provenance with retired quantities is stale');
 assert.match(denied.stderr,/positions\.csv is STALE/);assert.equal(fs.readFileSync(csv,'utf8'),stale,'--check never rewrites evidence');
 const regenerated=run([]);assert.equal(regenerated.status,0,regenerated.stderr);
 assert.equal(fs.readFileSync(csv,'utf8'),actual,'real CLI uses the same dated reporting authority');
 const accepted=run(['--check']);assert.equal(accepted.status,0,accepted.stderr);
}finally{
 if(!path.resolve(temp).startsWith(tempRoot+path.sep))throw Error('Unsafe temporary cleanup target');
 fs.rmSync(temp,{recursive:true,force:true});
}
console.log('PASS dated owner-target report: independent current cents, preserved historical opening, mixed provenance and real --check stale rejection/regeneration');
