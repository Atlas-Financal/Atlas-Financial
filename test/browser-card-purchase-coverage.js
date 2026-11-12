'use strict';
// Actual authenticated Budget at desktop/mobile widths, with invented fixtures.
// Run manually: CHROME_PATH=<chromium executable> node test/browser-card-purchase-coverage.js
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const os=require('node:os'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
const {withServer}=require('./test-savings-evidence-integration');
const make=require('./fixtures/card-purchase-coverage-data');
const root=path.join(__dirname,'..'),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const cases=[
  {stage:'before',cash:50000,spent:0,remaining:15000,reserve:0,needed:17500,chart:0},
  {stage:'purchase',cash:50000,spent:8000,remaining:7000,reserve:8000,needed:17500,chart:16},
  {stage:'partial',cash:48000,spent:8000,remaining:7000,reserve:6000,needed:15500,chart:12.5},
  {stage:'full',cash:42000,spent:8000,remaining:7000,reserve:0,needed:9500,chart:0},
];
function input(stage){
  const x=make(['partial','full'].includes(stage)?'backfill':stage);
  if(stage==='partial'){
    x.payload.transactions[1].amount=20;x.payload.transactions[2].amount=-20;
    x.payload.accounts[0].balance=480;x.payload.accounts[3].balance=460;
    make.confirm(x,'partial-browser',80002,80003,[[80001,20]]);
  }
  if(stage==='full')make.confirm(x,'full-browser',80002,80003,[[80001,80]]);
  return{data:x.data,payload:x.payload,map:x.accountMap};
}
(async()=>{
  const executable=process.env.CHROME_PATH||(process.platform==='win32'
    ?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':null);
  assert(executable&&fs.existsSync(executable),'Set CHROME_PATH to a Chromium browser');
  const output=process.env.ATLAS_CARD_COVERAGE_EVIDENCE_DIR||fs.mkdtempSync(path.join(os.tmpdir(),'atlas-card-funding-proof-'));
  fs.mkdirSync(output,{recursive:true});
  const head=execFileSync('git',['-c','safe.directory='+root.split(path.sep).join('/'),'rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const report={head,states:[],errors:[],externalRequests:[]};
  await withServer(input('before'),async server=>{
    const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
    const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    const profile=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-card-funding-browser-'));
    const browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],
      {windowsHide:true,stdio:'ignore'});
    let ws;
    try{
      let targets;
      for(let i=0;i<40;i++){try{targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();if(targets.length)break;}catch{}await delay(250);}
      assert(targets?.length,'browser exposes local DevTools');
      ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
      await Promise.race([once(ws,'open'),delay(10000).then(()=>{throw Error('DevTools connection timed out');})]);
      let id=0;const waiting=new Map();
      ws.addEventListener('message',event=>{
        const message=JSON.parse(event.data);
        if(message.id&&waiting.has(message.id)){
          const pending=waiting.get(message.id);waiting.delete(message.id);
          message.error?pending.reject(Error(JSON.stringify(message.error))):pending.resolve(message.result);
        }else if(message.method==='Runtime.exceptionThrown')report.errors.push(message.params.exceptionDetails.text);
        else if(message.method==='Network.requestWillBeSent'){
          const url=new URL(message.params.request.url);
          if(/^https?:$/.test(url.protocol)&&url.origin!==server.base)report.externalRequests.push(url.origin);
        }
      });
      const call=(method,params={})=>new Promise((resolve,reject)=>{
        const next=++id,timer=setTimeout(()=>{waiting.delete(next);reject(Error(method+' timed out'));},15000);
        waiting.set(next,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
        ws.send(JSON.stringify({id:next,method,params}));
      });
      const evaluate=async expression=>{
        const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
        if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;
      };
      await call('Page.enable');await call('Runtime.enable');await call('Network.enable');
      const split=server.cookie.indexOf('=');
      await call('Network.setCookie',{name:server.cookie.slice(0,split),value:decodeURIComponent(server.cookie.slice(split+1)),url:server.base});
      for(const width of [1440,390])for(const expected of cases){
        server.write(input(expected.stage));
        await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===390});
        await call('Page.navigate',{url:server.base+'/'});
        let ready=false;
        for(let i=0;i<100;i++){if(await evaluate('typeof App!=="undefined"&&!!App.data&&!!document.querySelector("[data-budget-cash-how]")')){ready=true;break;}await delay(100);}
        assert(ready,expected.stage+' boot');
        await evaluate('document.querySelector("[data-budget-cash-how]").click()');await delay(100);
        const facts=await evaluate(`(()=>{
          const sheet=document.querySelector('[data-budget-detail-sheet]'),parts=[...sheet.querySelectorAll('[data-budget-cash-part]')];
          const cents=node=>Math.round(Number(node.innerText.match(/\\$([\\d,.]+)/)[1].replace(/,/g,''))*100);
          const answers=[...sheet.querySelector('[data-budget-cash-answer]').children];
          const card=sheet.querySelector('[data-budget-cash-part="card-coverage"]');
          const chart=sheet.querySelector('.budget-cash-segment.budget-cash-card-coverage');
          const category=document.querySelector('[data-budget-category-open="groceries"]');
          const categoryMoney=category.innerText.match(/[$][0-9,.]+/g).map(value=>Math.round(Number(value.slice(1).replace(/,/g,''))*100));
          return{open:sheet.open,parts:Object.fromEntries(parts.map(p=>[p.dataset.budgetCashPart,cents(p)])),
            needed:cents(answers[0]),available:cents(answers[1]),cash:Math.round(App.data.plan.startingCash.breakdown[0].value*100),
            spent:categoryMoney.at(-2),originalCategory:categoryMoney.at(-1),
            minimumStatuses:[...document.querySelectorAll('[data-period-bill="travel"]')].map(row=>row.dataset.billStatus),
            chart:parseFloat(chart.style.width),cardVisible:card.getClientRects().length>0,color:getComputedStyle(chart).backgroundColor,
            explanation:sheet.innerText,overflow:document.documentElement.scrollWidth>innerWidth};
        })()`);
        assert(facts.open&&facts.cardVisible,'card hold is visible in actual funding dialog');
        assert.deepEqual(facts.parts,{bills:2500,household:expected.remaining,'card-coverage':expected.reserve,floor:0,proposed:0});
        // Independent cents oracle totals the visible components, not Forecast.
        const printedTotal=Object.values(facts.parts).reduce((sum,n)=>sum+n,0);
        assert.equal(printedTotal,expected.needed);assert.equal(facts.needed,expected.needed);
        assert.equal(facts.cash,expected.cash);assert.equal(facts.available,32500);
        assert.equal(expected.cash-printedTotal,32500);assert.equal(facts.chart,expected.chart);
        assert.equal(facts.spent,expected.spent);assert.equal(facts.originalCategory,15000);
        assert(facts.minimumStatuses.length&&facts.minimumStatuses.every(status=>status!=='PAID'));
        assert.equal(facts.overflow,false);assert.notEqual(facts.color,'rgba(0, 0, 0, 0)');
        assert.doesNotMatch(facts.explanation,/Cash needed protects remaining bills, household spending, uncovered card purchases and the existing floor/);
        assert.match(facts.explanation,/Uncovered card purchases - keep in Bills/);
        const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        const screenshot=path.join(output,expected.stage+'-'+width+'.png');fs.writeFileSync(screenshot,Buffer.from(shot.data,'base64'));
        report.states.push({stage:expected.stage,width,...facts,printedTotal,screenshot});
        console.log('PASS '+expected.stage+' '+width+'px: printed '+printedTotal+' cents = cash needed; minimum 2500 cents remains separate');
      }
      assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);
      fs.writeFileSync(path.join(output,'proof.json'),JSON.stringify(report,null,2));console.log('Evidence: '+output);
    }finally{
      if(ws)ws.close();if(browser.exitCode==null){browser.kill();await Promise.race([once(browser,'exit'),delay(2000)]);}
      try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
    }
  });
})().catch(error=>{console.error(error);process.exitCode=1;});
