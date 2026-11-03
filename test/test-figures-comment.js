'use strict';
/* Independent proof that the figures-review comment states the snapshot's
 * scope (Plan, Budget, Savings, Bills, Subscriptions, Credit, and Planning on
 * the captured inputs) and does not claim the whole site, or every figure the
 * household can read, is unchanged. `node test/test-figures-comment.js`
 *
 * The snapshot script's own header is the scope authority. This suite does
 * not extend that snapshot to Deep Dive, Records, or Modellers.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { sourceText } = require('./test-source-text');
const {
  MARKER,
  formatFiguresComment,
} = require('../scripts/figures-comment.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const workflow = sourceText(fs.readFileSync(
  path.join(__dirname, '..', '.github/workflows/figures-review.yml'), 'utf8'));
const snapshotSrc = sourceText(fs.readFileSync(
  path.join(__dirname, '..', 'scripts/figures-snapshot.js'), 'utf8'));
const helperSrc = sourceText(fs.readFileSync(
  path.join(__dirname, '..', 'scripts/figures-comment.js'), 'utf8'));
const BROKEN_HEAD = '6f936052427802901c9e93c1681d3d4404331340';
const brokenWorkflow = sourceText(execFileSync(
  'git', ['show', `${BROKEN_HEAD}:.github/workflows/figures-review.yml`],
  { encoding: 'utf8' }));

const OVERCLAIM = 'Whatever this PR changes, it does not change what the household is told';
const SITEWIDE = 'what the household is told';

console.log('=== pre-fix head overclaimed Plan-page identity ===');
ok(brokenWorkflow.includes(OVERCLAIM),
  '6f936052 unchanged comment claims the household is told nothing changed');
ok(/Every row below is something the household would read differently/.test(brokenWorkflow),
  '6f936052 moved comment does not name Plan-page scope');

console.log('\n=== snapshot authority is Plan, Budget, Savings, Bills, Subscriptions, Credit, and Planning ===');
ok(/household could read it off the[\s\S]{0,80}Plan, Budget, Savings, Bills, Subscriptions, Credit, or Planning/.test(snapshotSrc),
  'figures-snapshot.js owns Plan, Budget, Savings, Bills, Subscriptions, Credit, and Planning membership');
{
  const header = snapshotSrc.split('Output is a flat')[0];
  ok(/Deep Dive, Records,[\s\S]{0,40}Modellers remain outside/.test(header),
    'snapshot header names Deep Dive, Records, and Modellers only as outside');
  ok(!/covers Deep Dive|including Deep Dive|off the Deep Dive/i.test(header),
    'snapshot header does not claim those pages are in the snapshot');
}

console.log('\n=== workflow uses the helper; overclaim is gone ===');
ok(/node scripts\/figures-comment\.js/.test(workflow),
  'figures-review.yml runs the helper as a process');
ok(!workflow.includes(OVERCLAIM) && !workflow.includes(SITEWIDE),
  'the workflow file no longer contains the site-wide unchanged claim');
ok(!helperSrc.includes(OVERCLAIM),
  'the helper no longer contains the old unchanged overclaim sentence');
ok(/Plan, Budget pay periods, Savings, Bills, Subscriptions, Credit,\s+\* Planning/.test(helperSrc),
  'the helper names Plan, Budget, Savings, Bills, Subscriptions, Credit, and Planning scope');
ok(/household figures at a live\s+\* opening/.test(helperSrc) && /page-side decisions/.test(helperSrc),
  'the helper names what the comparison does not cover');
ok(/formatFiguresComment\(base, head, baseRef\)/.test(helperSrc),
  'the helper still owns the posted formatter');

const identical = { weekly: 920, buffer: 500, windowDays: 91 };
const unchanged = formatFiguresComment(identical, { ...identical }, 'main');

console.log('\n=== identical snapshots do not claim the whole site ===');
ok(unchanged.startsWith(MARKER), 'unchanged comment keeps the marker');
ok(/All 3 captured fields are identical on this head and on `main`/.test(unchanged),
  'unchanged comment names the captured fields and both revisions');
ok(/That covers only the captured fields on those inputs; page rendering, page-side decisions and household figures at a live opening are outside it\./.test(unchanged),
  'unchanged comment narrows itself to the captured fields and names what is outside');
ok(!/Every one of the \d+ figures the household can read/.test(unchanged),
  'the retired "every figure the household can read" overclaim is gone');
ok(!unchanged.includes(OVERCLAIM) && !unchanged.includes(SITEWIDE),
  'unchanged comment stops after saying what was compared');
ok(!/Deep Dive|Records|Modellers/i.test(unchanged),
  'unchanged comment does not mention other pages as compared or identical');
ok(!/does not change/.test(unchanged),
  'unchanged comment does not generalise past the snapshot');

const movedHead = { weekly: 900, buffer: 500, windowDays: 91 };
const moved = formatFiguresComment(identical, movedHead, 'main');

console.log('\n=== a moved figure is still reported, scoped to the snapshot ===');
ok(/1 compared field moved/.test(moved), 'one numeric snapshot move is reported');
ok(/`weekly`/.test(moved) && /\$920\.00/.test(moved) && /\*\*`?\$900\.00`?\*\*/.test(moved),
  'the moved row names weekly and both values');
ok(/Household rows are published figures on the household dated opening; confirm each was intended and is stated on the merge card\./.test(moved)
    && /#### Household dated opening — published-figure fields \(1 moved\)/.test(moved),
  'moved comment labels household rows as household dated-opening figures instead of the whole site');
ok(/Invented rows are synthetic: they show logic movement on an invented input, not a household figure\./.test(moved),
  'moved comment does not call a synthetic row a household figure');
ok(/2 other captured fields unchanged/.test(moved),
  'unchanged remainder is labelled as captured fields');
ok(!moved.includes(SITEWIDE),
  'moved comment does not claim it covers what the household is told');

console.log('\n=== invented and coverage rows are labelled, and counters are not money ===');
{
  const metaBase = { weekly: 920, 'fixture.invented-a.input.sha256': 'a'.repeat(64), 'fixture.invented-a.plan.weeklyCap': 100,
    'coverage.plan-weekly-cap.household': 1, 'coverage.plan-weekly-cap.invented': 2 };
  const metaHead = { ...metaBase, 'fixture.invented-a.plan.weeklyCap': 90, 'coverage.plan-weekly-cap.invented': 1 };
  const metaMoved = formatFiguresComment(metaBase, metaHead, 'main');
  ok(/#### Invented inputs — synthetic fields, not household figures \(1 moved\)[\s\S]*`fixture\.invented-a\.plan\.weeklyCap`/.test(metaMoved),
    'an invented-input row is in its own synthetic section');
  ok(/\| `coverage\.plan-weekly-cap\.invented` \| 2 \| \*\*1\*\* \| −1 \|/.test(metaMoved),
    'a coverage counter formats as a count with a count delta');
  ok(!/coverage\.plan-weekly-cap\.invented` \| \$/.test(metaMoved), 'a coverage counter is never money');
}

console.log('\n=== introducing the snapshot still has no base comparison ===');
const introduced = formatFiguresComment(null, identical, 'main');
ok(/no baseline to compare against/.test(introduced),
  'null base still reports that there is no comparison');
ok(/`weekly`/.test(introduced) && /\$920\.00/.test(introduced),
  'null base still lists the head snapshot rows');

console.log('\n=== helper CLI is what the workflow formats ===');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figures-comment-'));
try {
  const baseFile = path.join(tmpDir, 'base.json');
  const headFile = path.join(tmpDir, 'head.json');
  fs.writeFileSync(baseFile, JSON.stringify(identical));
  fs.writeFileSync(headFile, JSON.stringify(identical));
  const cliUnchanged = execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts/figures-comment.js'),
    baseFile,
    headFile,
    'main',
  ], { encoding: 'utf8' });
  ok(cliUnchanged === unchanged,
    'CLI stdout for identical snapshots is exactly formatFiguresComment');

  fs.writeFileSync(headFile, JSON.stringify(movedHead));
  const cliMoved = execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts/figures-comment.js'),
    baseFile,
    headFile,
    'main',
  ], { encoding: 'utf8' });
  ok(cliMoved === moved,
    'CLI stdout for a moved snapshot figure is exactly formatFiguresComment');

  fs.writeFileSync(baseFile, 'null\n');
  fs.writeFileSync(headFile, JSON.stringify(identical));
  const cliIntroduced = execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts/figures-comment.js'),
    baseFile,
    headFile,
    'main',
  ], { encoding: 'utf8' });
  ok(cliIntroduced === introduced,
    'CLI stdout for a null base is exactly formatFiguresComment');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('\n=== a Credit rate is not formatted as money ===');
{
  const rateBase = { 'credit.triangle.rate': 21.99, weekly: 920 };
  const rateHead = { 'credit.triangle.rate': 22.99, weekly: 920 };
  const rateMoved = formatFiguresComment(rateBase, rateHead, 'main');
  ok(/21\.99%/.test(rateMoved) && /22\.99%/.test(rateMoved),
    'rate keys print as percents');
  ok(!/\$21\.99/.test(rateMoved) && !/\$22\.99/.test(rateMoved),
    'rate keys are not formatted as dollars');
}

console.log('\n=== privileged posting step does not execute PR JavaScript ===');
const [workflowBeforePost, workflowPost, ...extraGithubScript] = workflow.split(
  /uses:\s*actions\/github-script@[^\n]+/
);
ok(typeof workflowPost === 'string' && extraGithubScript.length === 0,
  'figures-review.yml has exactly one github-script posting step');
ok(/env -u GITHUB_TOKEN -u GH_TOKEN/.test(workflowBeforePost)
  && /node scripts\/figures-comment\.js/.test(workflowBeforePost),
  'formatter runs without GitHub tokens');
ok(/env -u GITHUB_TOKEN -u GH_TOKEN node scripts\/figures-snapshot\.js/.test(workflowBeforePost),
  'head snapshot also runs without GitHub tokens');
ok(/persist-credentials:\s*false/.test(workflowBeforePost),
  'PR checkout does not persist the write-capable token for later git use');
ok(!/formatFiguresComment/.test(workflowPost),
  'privileged github-script does not call the PR formatter');
ok(!/figures-comment\.js/.test(workflowPost),
  'privileged github-script does not load the PR helper');
ok(!/require\([^)]*scripts\//.test(workflowPost)
  && !/GITHUB_WORKSPACE/.test(workflowPost),
  'privileged github-script does not require workspace modules');
ok(/comment\.md/.test(workflowPost) && /readFileSync/.test(workflowPost),
  'privileged github-script posts the inert formatted body');
ok(workflowPost.includes(MARKER),
  'privileged github-script still finds the existing comment by the helper marker');
ok(/formatFiguresComment\(base, head, baseRef\)/.test(helperSrc)
  && /node scripts\/figures-comment\.js/.test(workflowBeforePost),
  'the workflow posts the helper body rather than a second formatter');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
