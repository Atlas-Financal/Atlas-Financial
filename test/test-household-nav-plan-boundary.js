'use strict';
/* Household information architecture: Budget (/) is the only household page and has no page nav,
 * and a Plan waterfall that ends at Balance After Deductions. (Talk was removed: #821
 * comment 6786692208; the legacy Bills / Subscriptions / Credit / Forecast / Modellers /
 * Plan spend pages were deleted and their URLs redirect to /.)
 *
 * Presentation only. Forecast still computes the extra-debt / big-purchase
 * chain and the projected ending; this suite proves those fields survive and
 * still reconcile by independent arithmetic, while the household Plan surface
 * prints nothing past Q07.
 *
 * The last section starts server.js with synthetic secrets so Budget is proved
 * served behind the session gate and a deleted legacy URL redirects to /.
 */
const { loadBudgetPage, liveBudgetComposerSource } = require('./lib/budget-page-harness');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const F = require('../public/forecast.js');
const data = require('../data.json');
const periods = require('../public/periods.json');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const PASS = 'synthetic-site-password';
const SECRET = 'synthetic-session-secret';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const exists = file => fs.existsSync(path.join(ROOT, file));

const REMOVED_ROWS = [
  'Extra credit-card repayment',
  'Balance after debt repayment',
  'Big-purchase savings',
  'Projected ending balance',
];
const KEPT_ROWS = [
  'Income',
  'Bills',
  'Balance after bills',
  'Household budget',
  'Balance After Deductions',

];

function siteNav(html) {
  const match = /<nav class="sitenav(?: [^"]*)?" aria-label="Pages">([\s\S]*?)<\/nav>/.exec(html);
  if (!match) return null;
  return [...match[1].matchAll(/<a href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g)].map(m => {
    const labelled = /class="sitenav-label"[^>]*>([^<]+)</.exec(m[3]);
    return {
      href: m[1],
      current: /aria-current="page"/.test(m[2]),
      label: (labelled ? labelled[1] : m[3]).replace(/<[^>]+>/g, '').trim(),
    };
  });
}

function loadComposer() {
  // The real Budget page (test/lib/budget-page-harness.js). operatingSurfaceHtml
  // is the live composition: the Today card plus the compact pay-period content.
  const page = loadBudgetPage({ Forecast: F, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } });
  return { operatingSurfaceHtml: ctx => page.surfaceHtml(ctx),
    calendarWaterfallHtml: page.get('calendarWaterfallHtml'), weeklyCapView: page.get('weeklyCapView'), paydayCoverageNote: page.get('paydayCoverageNote'), money2: page.get('money2') };
}

function currentAdvice() {
  const plan = data.plan;
  const asOf = data.meta.asOf;
  return F.recommend(plan, asOf, {
    scenario: 'expected',
    targetBuffer: plan.defaults.targetBuffer,
    extraDebtMonthly: 0,
    disabled: [],
    fundingSources: plan.funding && plan.funding.options,
    debts: data.debts,
    extraFacilities: data.revolvingExtra,
    extraDebtTarget: plan.nextDollar && plan.nextDollar.target,
    periods,
    paypalPerMonth: data.paypal && data.paypal.perMonth,
  });
}

console.log('=== 1. Budget has no page nav ===');
{
  const page = read('public/index.html');
  ok(siteNav(page) === null, 'the Budget page has no page nav');
  ok(!/class="sitenav sitenav-household"/.test(page),
    'the Budget page does not reserve a household dock');
  ok(/class="blend-brand"/.test(page) && /data-blend-theme/.test(page),
    'the Budget header is the logo and the theme control');
  ok(!/data-nav="budget"/.test(page) && !/data-nav="forecast"/.test(page),
    'Budget does not print the household destination links');
}

console.log('\n=== 3. Deep Dive and Records are removed; Budget has no page nav ===');
{
  ok(siteNav(read('public/index.html')) === null, 'index.html has no page nav');
  for (const file of ['deepdive.html', 'deepdive.js', 'records.html', 'records.js']) {
    ok(!exists('public/' + file), `${file} is removed (#822); its path still redirects to /`);
  }
}

console.log('\n=== 4 + 5. Plan waterfall keeps Balance After Deductions and stops there ===');
{
  const advice = currentAdvice();
  const composer = loadComposer();
  const html = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    liveOverlay: data.liveOverlay,
  });
  const active = (advice.defaultView.calendarPeriods || []).find(p => p.role === 'active')
    || advice.defaultView.calendarPeriods[0];
  ok(/data-calendar-waterfall=/.test(html), 'the default Plan renders the calendar waterfall');
  ok(/data-live-current-balance/.test(html)
      && html.indexOf('data-live-current-balance') < html.indexOf('data-operating-prompt="Income"'),
    'live Current Balance prints before the payday snapshot');
  let previous = -1;
  for (const prompt of KEPT_ROWS) {
    const at = html.indexOf(`data-operating-prompt="${prompt}"`);
    ok(at > previous, `${prompt} is printed, in order`);
    previous = at;
  }
  ok(/data-operating-question="07"[^>]*data-operating-prompt="Balance After Deductions"/.test(html),
    'Q07 is Balance After Deductions');
  ok(html.includes(composer.money2(active.afterHouseholdBudget)),
    'Q07 prints the Forecast afterHouseholdBudget figure');
  const questions = [...html.matchAll(/data-operating-question="([^"]+)"/g)].map(m => m[1]);
  // Live Budget (compact period): the savings row prints after Q07 as the
  // reported combined savings stock.
  const expectedQs = ['02', '04', '05', '06', '07', 'savings'];
  ok(questions.join(',') === expectedQs.join(',') && !questions.includes('03'),
    'the active snapshot includes the bounded proposed-savings disclosure before Q07',
    questions.join(','));

  for (const prompt of REMOVED_ROWS) {
    ok(!html.includes(prompt), `${prompt} is not on the Plan`);
  }
  ok(!/data-payday-first-card|data-card-id=|data-payday-big-purchases|Other credit cards/.test(html),
    'no card row or big-purchase row is rendered (not merely hidden)');
  ok(!/operating-ending/.test(html),
    'no ending-styled row remains in the calendar waterfall');
  ok(!/Extra credit-card repayment|Big-purchase savings|Projected ending balance|Balance after debt repayment/
    .test(composer.calendarWaterfallHtml(active, data.liveOverlay, advice.paydayAllocation)),
  'calendarWaterfallHtml itself emits none of the four removed prompts');
  // Live Budget prints one selected pay period at a time (no "Show both"):
  // render each calendar period as the page does when it is selected.
  const renders = (advice.defaultView.calendarPeriods || []).map(p => composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    liveOverlay: data.liveOverlay, planPayPeriodId: p.id,
  }));
  const both = renders.join('');
  const sections = (both.match(/<section class="calendar-waterfall"/g) || []).length;
  // Each render's selected-period waterfall runs from its section to the end
  // of the render (the compact period nests its own disclosures).
  const sectionOf = role => {
    const r = renders.find(h => h.includes(`data-calendar-role="${role}"`)) || '';
    return r.slice(r.indexOf(`data-calendar-role="${role}"`));
  };
  const activeSection = sectionOf('active');
  const futureSection = sectionOf('future');
  const activeQs = activeSection.match(/data-operating-question=/g) || [];
  const futureQs = futureSection.match(/data-operating-question=/g) || [];
  const expectedActiveCount = 6;
  ok(sections === (advice.defaultView.calendarPeriods || []).length,
    'Show both renders every calendar period',
    `${sections} vs ${(advice.defaultView.calendarPeriods || []).length}`);
  ok(activeQs.length === expectedActiveCount,
    'Show both active snapshot has six questions including proposed savings, without opening',
    String(activeQs.length));
  ok(futureQs.length === 7,
    'Show both future snapshot includes opening as the seventh question',
    String(futureQs.length));
  ok(/data-live-current-balance/.test(both),
    'Show both still prints live Current Balance outside the snapshots');
  ok(!/data-operating-prompt="Current Balance"/.test(activeSection),
    'active snapshot does not print live Current Balance as Q01');
  ok(!/data-operating-prompt="Opening balance"/.test(activeSection),
    'active snapshot does not print payday-boundary opening');
  ok(/data-operating-prompt="Opening balance"/.test(futureSection),
    'future snapshot prints Opening balance');

  ok(!REMOVED_ROWS.some(prompt => both.includes(prompt)),
    'Show both still omits extra-debt and ending rows');
  const planSrc = read('public/plan.js');
  const fn = /function calendarWaterfallHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(fn && !/'08'|'09'|'10'|'11'/.test(fn[0]) && !/projectedEnding|afterDebtRepayment/.test(fn[0]),
    'calendarWaterfallHtml stops at Q07 in source, not by CSS');
  const surfaceFn = liveBudgetComposerSource(planSrc);
  ok(surfaceFn && !/data-operating-warnings/.test(surfaceFn[0])
      && !/operating-limit warn/.test(surfaceFn[0]),
    'the live Budget composer emits no advisory block in source, not by CSS');
  ok(!/data-operating-warnings/.test(html)
      && !/There is no feasible weekly cap/.test(html)
      && !/stays unfunded/.test(html)
      && !/data-refresh-attention/.test(html)
      && !/class="operating-limit warn"/.test(html),
    'the default Plan does not render the advisory block after Balance After Deductions');

  ok(!/There is no feasible weekly cap/.test(composer.calendarWaterfallHtml(active, data.liveOverlay, advice.paydayAllocation)),
    'calendarWaterfallHtml itself emits no weekly-cap advisory');
  const infeasibleAdvice = JSON.parse(JSON.stringify(advice));
  infeasibleAdvice.mode = 'infeasible';
  infeasibleAdvice.weekly = 0;
  infeasibleAdvice.infeasible = {
    label: 'Synthetic protected cost', date: '2026-10-02', shortfall: 321.11,
  };
  infeasibleAdvice.funding = { feasible: false, shortfall: 621.11 };
  infeasibleAdvice.paydayAllocation.risks = [
    { id: 'obligations', reason: 'This payday cannot cover required obligations in cash.', shortfall: 40.5 },
  ];
  const capCopy = composer.weeklyCapView(infeasibleAdvice);
  ok(capCopy.hasFeasibleCap === false
      && /There is no feasible weekly cap/.test(capCopy.reason)
      && /Synthetic protected cost/.test(capCopy.reason)
      && capCopy.reason.includes(composer.money2(321.11)),
    'weeklyCapView still composes the infeasible copy for other views');
  const infeasibleHtml = composer.operatingSurfaceHtml({
    advice: infeasibleAdvice, weekly: 0, recommended: 0,
  });
  ok(/data-operating-prompt="Balance After Deductions"/.test(infeasibleHtml)

      && !/data-operating-warnings/.test(infeasibleHtml)
      && !/There is no feasible weekly cap/.test(infeasibleHtml)
      && !/Synthetic protected cost/.test(infeasibleHtml)
      && !/This payday cannot cover required obligations in cash/.test(infeasibleHtml),
    'infeasible Forecast output is not printed as an advisory after Q07');
  const coverage = composer.paydayCoverageNote(advice.currentPeriodAction);
  ok(typeof coverage === 'string' && coverage.length > 0
      && (infeasibleHtml + html).indexOf(coverage) === -1,
    'paydayCoverageNote still exists and is not dumped onto the usable Plan');
  ok(!/display:\s*none[^}]*operating-question|data-operating-question="(08|09|10|11)"[^}]*display:\s*none/
    .test(read('public/styles.css') + read('public/household-view.css')),
  'no stylesheet hides waterfall rows');
  const page = read('public/index.html');
  ok(!/extra debt and big purchases/.test(page)
      && !/Live Current Balance, then this payday’s income, bills and household budget\./.test(page),
    'the Budget page does not render the removed This payday lede');
  ok(!/extra debt and big purchases/.test(planSrc),
    'the plan.js lede constant matches');
}

console.log('\n=== 6. Forecast still computes the chain past the household-budget boundary ===');
{
  const advice = currentAdvice();
  const alloc = advice.paydayAllocation;
  const periodsOut = advice.defaultView.calendarPeriods || [];
  const active = periodsOut.find(p => p.role === 'active');
  const next = periodsOut.find(p => p.role === 'future');
  ok(active && active.extraDebt && typeof active.extraDebt.allocated === 'number'
      && Array.isArray(active.bigPurchases) && active.firstCard,
    'the active period still carries extraDebt, firstCard, and bigPurchases');
  if (active.afterHouseholdBudget != null) {
    const purchasesTaken = (active.bigPurchases || [])
      .reduce((s, r) => s + (Number(r.allocation) || 0), 0);
    const independentAfterDebt = Math.round((active.afterHouseholdBudget - active.extraDebt.allocated) * 100) / 100;
    const independentEnding = Math.round((independentAfterDebt - purchasesTaken) * 100) / 100;
    ok(typeof active.afterDebtRepayment === 'number'
        && typeof active.projectedEnding === 'number',
      'Balance After Deductions still publishes afterDebtRepayment and projectedEnding');
    ok(near(active.afterDebtRepayment, independentAfterDebt),
      'afterDebtRepayment = afterHouseholdBudget − extraDebt.allocated (independent arithmetic)');
    ok(near(active.projectedEnding, independentEnding),
      'projectedEnding = afterDebtRepayment − Σ big-purchase allocation (independent arithmetic)');
    const cashLeftover = active.paydayBoundaryOpening === true
      && active.opening != null && active.incomeAdded != null
      && active.periodBillLoad != null && active.budgetHold != null
      ? Math.round((Number(active.opening) + Number(active.incomeAdded)
        - Number(active.periodBillLoad) - Number(active.budgetHold)) * 100) / 100
      : null;
    if (cashLeftover != null) {
      ok(next && next.openingKnown && near(next.opening, cashLeftover),
        'the next pay period opens from cash leftover, not from Balance After Deductions');
    } else {
      ok(!next || next.opening == null || next.openingSource !== 'carry-forward'
          || !near(next.opening, active.projectedEnding),
        'next period does not inherit Balance After Deductions as its opening');
    }
  } else {
    ok(false, 'Balance After Deductions publishes without a payday-boundary opening');
  }
  ok(alloc && alloc.extraDebt && typeof alloc.extraDebt.allocated === 'number'
      && alloc.runningLeftover && typeof alloc.runningLeftover.afterDebtRepayment === 'number'
      && typeof alloc.runningLeftover.afterBigPurchases === 'number',
    'paydayAllocation.extraDebt and runningLeftover.afterDebtRepayment / afterBigPurchases remain');
  const forecastSrc = read('public/forecast.js');
  ok(/projectedEnding:\s*afterBigPurchases/.test(forecastSrc)
      && /afterDebtRepayment,/.test(forecastSrc)
      && /bigPurchases:\s*purchases\.items/.test(forecastSrc),
    'forecast.js still publishes projectedEnding, afterDebtRepayment and bigPurchases on each period');
}

console.log('\n=== 7. Budget is served behind the incumbent session gate; legacy URLs redirect ===');
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(err => err ? reject(err) : resolve(port));
    });
    server.on('error', reject);
  });
}
function startAtlas(env) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('server start timeout\n' + stderr));
    }, 8000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!settled && /listening/.test(stdout)) {
        settled = true;
        clearTimeout(timer);
        resolve({
          stop: () => new Promise(done => {
            child.once('exit', () => done());
            child.kill('SIGTERM');
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } }, 2000);
          }),
        });
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${stderr}`));
    });
  });
}
(async () => {
  const port = await freePort();
  const env = Object.assign({}, process.env);
  for (const key of Object.keys(env)) {
    if (/^(ATLAS_|LUNCHMONEY_)/.test(key)) delete env[key];
  }
  Object.assign(env, { SITE_PASSWORD: PASS, SESSION_SECRET: SECRET, PORT: String(port) });
  const atlas = await startAtlas(env);
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(PASS)}`,
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    ok(login.status === 302 && /^hfd_session=/.test(cookie), 'synthetic login issues a session');
    // Every legacy page and its script is switched off (one list in server.js;
    // full alias proof in test-legacy-pages-switched-off.js). Their nav markup
    // facts stay pinned against the files themselves in the sections above.
    {
      const res = await fetch(base + '/', { headers: { cookie } });
      const body = await res.text();
      ok(res.status === 200 && siteNav(body) === null && /id="operating-surface"/.test(body),
        '/ serves 200 with the operating surface and no page nav');
      ok(/no-store/.test(res.headers.get('cache-control') || '')
          && /script-src 'self'/.test(res.headers.get('content-security-policy') || ''),
        '/ carries the incumbent no-store and CSP headers');
    }
    // Smoke only: test-legacy-pages-switched-off.js owns the full redirect contract.
    {
      const res = await fetch(base + '/bills.html', { headers: { cookie }, redirect: 'manual' });
      ok(res.status === 302 && (res.headers.get('location') || '') === '/',
        '/bills.html answers 302 to / for a session (switched off)');
    }
    for (const removed of ['/talk.html', '/talk.js']) {
      const res = await fetch(base + removed, { headers: { cookie }, redirect: 'manual' });
      ok(res.status === 404, `${removed} is not served to a session (Talk removed)`);
    }
  } finally {
    await atlas.stop();
  }
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
