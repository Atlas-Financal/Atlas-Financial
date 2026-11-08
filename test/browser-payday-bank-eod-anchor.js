'use strict';
// Real authenticated local server + native Chromium + wholly invented evidence.
// CHROME_PATH=<Chromium executable> node test/browser-payday-bank-eod-anchor.js
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const os=require('node:os'),net=require('node:net'),{spawn}=require('node:child_process');
const {once}=require('node:events');
const {withServer}=require('./test-savings-evidence-integration');
const {fixture}=require('./fixtures/payday-bank-eod-anchor');
const shell=require('./fixtures/savings-daily-consumer-data');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function input(approved) {
  const i=fixture();i.asOf='2026-10-14';i.window.endDate=i.asOf;
  i.plan.income[0].anchor='2026-10-09';i.plan.income[1].date='2026-10-23';i.plan.income[2].date='2026-11-06';
  i.plan.income.push({id:'p3',label:'Invented third receipt',frequency:'once',date:'2026-11-20',amount:1000,confidence:'confirmed'});
  i.data.plan.opening.cashReconstructionAnchor.ownerApproved=approved;
  i.payload.fetchedAt='2026-10-14T18:00:00Z';i.payload.transactionWindow.endDate=i.asOf;
  i.payload.accounts.forEach(a=>{a.updated_at=a.balance_last_update='2026-10-14T17:55:00Z';});
  const data=shell('ready');data.meta={asOf:'2026-09-29',title:'Invented bank EOD acceptance'};
  data.plan=i.data.plan;data.debts=[];
  return{data,payload:i.payload,map:i.accountMap};
}
(async()=>{
  const exe=process.env.CHROME_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  assert(fs.existsSync(exe),'Chromium executable is required');
  const out=process.env.ATLAS_BANK_EOD_BROWSER_PROOF||fs.mkdtempSync(path.join(os.tmpdir(),'atlas-bank-eod-proof-'));
  fs.mkdirSync(out,{recursive:true});
  const report={synthetic:true,cases:[],errors:[],externalRequests:[],writes:[]};
  await withServer(input(false),async server=>{
    const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
    const port=probe.address().port;await new Promise(r=>probe.close(r));
    const profile=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-bank-eod-browser-'));
    const browser=spawn(exe,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
      '--disable-background-networking','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,
      '--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
    let ws;
    try {
      let targets;
      for(let i=0;i<60;i++){try{targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();if(targets.length)break;}catch{}await delay(250);}
      assert(targets?.some(t=>t.type==='page'),'local DevTools page available');
      ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
      await Promise.race([once(ws,'open'),delay(15000).then(()=>{throw Error('DevTools timeout');})]);
      let id=0;const waiting=new Map();
      ws.addEventListener('message',e=>{
        const m=JSON.parse(e.data),p=waiting.get(m.id);
        if(p){waiting.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}
        else if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.text);
        else if(m.method==='Network.requestWillBeSent'){
          const r=m.params.request,u=new URL(r.url);
          if(/^https?:$/.test(u.protocol)&&u.origin!==server.base)report.externalRequests.push(u.origin);
          if(r.method!=='GET')report.writes.push(r.method);
        }
      });
      const call=(method,params={})=>new Promise((resolve,reject)=>{
        const next=++id,timer=setTimeout(()=>{waiting.delete(next);reject(Error(method+' timeout'));},20000);
        waiting.set(next,{resolve:x=>{clearTimeout(timer);resolve(x);},reject:e=>{clearTimeout(timer);reject(e);}});
        ws.send(JSON.stringify({id:next,method,params}));
      });
      const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
        if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
      await call('Page.enable');await call('Runtime.enable');await call('Network.enable');
      await call('Page.addScriptToEvaluateOnNewDocument',{source:'localStorage.setItem("hfd-plan-knobs-v1",JSON.stringify({weeklyVariable:0}))'});
      const split=server.cookie.indexOf('=');
      await call('Network.setCookie',{name:server.cookie.slice(0,split),value:decodeURIComponent(server.cookie.slice(split+1)),url:server.base});
      for(const width of [390,1440])for(const approved of [false,true]) {
        server.write(input(approved));
        await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===390});
        await call('Page.navigate',{url:server.base+'/'});
        let ready=false;for(let n=0;n<120;n++){
          if(await evaluate('typeof App!=="undefined"&&!!App.data&&!!document.querySelector("[data-budget-savings-goals]")')){ready=true;break;}
          await delay(100);
        }assert(ready,'Budget boot');
        const original=await evaluate('JSON.stringify(App.data)');
        for(const [n,start] of ['2026-10-23','2026-11-06','2026-11-20'].entries()) {
          await evaluate('document.querySelector(".river").focus()');
          await call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
          await call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
          let selected=false;for(let j=0;j<60;j++){
            if(await evaluate('document.querySelector("[data-budget-window-progress]")?.dataset.start')===start){selected=true;break;}await delay(100);
          }assert(selected,'selected future period '+start);
          const facts=await evaluate(`(()=>{const d=App.data,a=Forecast.recommend(d.plan,d.meta.asOf,
            {...d.plan.defaults,...d.liveOverlay,weeklyVariable:0,debts:d.debts||[]}),v=a.savingsFunding.periodViews.find(v=>v.start==='${start}'),
            p=Forecast.savingsFundingPublication(a.savingsFunding,{asOf:d.meta.asOf,advice:a,periodId:v.id}).forecastClosing;
            return{start:p.start,status:p.status,reason:p.reason,stock:p.stock,operating:p.operatingCash,actualSaved:p.actualSaved,
              permission:p.moneyMovementPermission,overflow:document.documentElement.scrollWidth>innerWidth,
              savingsText:document.querySelector('[data-budget-savings-goals]').innerText};})()`);
          assert.equal(facts.start,start);assert.equal(facts.actualSaved,null);assert.equal(facts.permission,'not-granted');
          assert.equal(facts.overflow,false);
          if(approved){assert.equal(facts.status,'ready',facts.reason);assert.equal(facts.stock+facts.operating,119+106+(n+1)*1000);
            assert.doesNotMatch(facts.savingsText,/\bUnavailable\b/,'every displayed future Savings figure is qualified');
            assert(facts.savingsText.includes('Savings at period close: $'+facts.stock.toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2})));}
          else{assert.equal(facts.status,'unavailable');assert.equal(facts.stock,null);
            assert.match(facts.savingsText,/Savings at period close: Unavailable\./);}
          assert.equal(await evaluate('JSON.stringify(App.data)'),original,'UI did not mutate source evidence');
          await evaluate('document.querySelector("[data-budget-savings-goals]").scrollIntoView({block:"center"})');await delay(80);
          const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
          const file=path.join(out,(approved?'approved':'unapproved')+'-'+width+'-'+start+'.png');fs.writeFileSync(file,Buffer.from(shot.data,'base64'));
          report.cases.push({approved,width,...facts,screenshot:file,inputUnchanged:true});
          console.log('PASS '+(approved?'approved':'unapproved')+' '+width+' '+start);
        }
      }
      assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.writes,[]);
      fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify(report,null,2));
    } finally {
      if(ws)ws.close();if(browser.exitCode==null){browser.kill();await Promise.race([once(browser,'exit'),delay(2000)]);}
      const resolved=path.resolve(profile),temp=path.resolve(os.tmpdir())+path.sep;
      if(resolved.startsWith(temp)&&path.basename(resolved).startsWith('atlas-bank-eod-browser-'))try{fs.rmSync(resolved,{recursive:true,force:true});}catch{}
    }
  });
})().catch(e=>{console.error(e);process.exitCode=1;});
