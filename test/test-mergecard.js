'use strict';

/* Mechanical coverage for .github/workflows/merge-card-check.yml.
 * The suite executes the workflow's real inline script. It proves the check
 * catches missing fields and invalid closed forms, and that it does NOT hang
 * a PR on a review SHA, PASS/PENDING, or ChatGPT identity. It also proves
 * the check reads the live PR body, not the workflow event body, and fails
 * closed when the live PR is closed, retargeted, or no longer the event head.
 * It proves CLAUDE.md's documented current-state verdict vocabulary matches
 * the workflow CURRENT_STATE list, so a builder following CLAUDE.md verbatim
 * can write a verdict the mechanical check accepts. It deliberately does not
 * test the meaning of prose.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WORKFLOW = path.join(__dirname, '..', '.github/workflows/merge-card-check.yml');
const HEAD = 'a'.repeat(40);
let passed = 0;
let failed = 0;

function ok(condition, name, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function extractScript() {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s+script:\s*\|\s*$/.test(line));
  if (start < 0) throw new Error('merge-card-check.yml has no inline script block');
  const indent = lines[start].match(/^\s*/)[0].length + 2;
  const script = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && line.match(/^\s*/)[0].length < indent) break;
    script.push(line.slice(Math.min(indent, line.length)));
  }
  return script.join('\n');
}

const SCRIPT = extractScript();

function workflowCurrentStateValues() {
  const match = /const CURRENT_STATE = \[([\s\S]*?)\];/.exec(SCRIPT);
  if (!match) throw new Error('merge-card-check.yml CURRENT_STATE list not found');
  const tokens = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  if (tokens.length === 0) throw new Error('merge-card-check.yml CURRENT_STATE values missing');
  return tokens;
}

function claudeCurrentStateVerdicts() {
  const text = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
  const gate = /## Before editing — the Current-State Verification Gate[\s\S]*?(?=\n## )/.exec(text);
  if (!gate) throw new Error('CLAUDE.md Current-State Verification Gate section not found');
  const verdict = /\*\*Verdict\*\*[\s\S]*?exactly one of([\s\S]*?\.)/.exec(gate[0]);
  if (!verdict) throw new Error('CLAUDE.md Current-State verdict vocabulary not found');
  const tokens = [...verdict[1].matchAll(/`([^`]+)`/g)].map((entry) => entry[1]);
  if (tokens.length === 0) throw new Error('CLAUDE.md Current-State verdict tokens missing');
  return tokens;
}

const FIELDS = {
  Title: 'Simplify review governance',
  'Primary risk': 'auto-safe',
  'Files / categories touched': 'governance only',
  'Current-state verdict': 'STILL BROKEN — owner instruction; checked on current main',
  'Builder surface': 'Codex',
  'Primary builder model': 'GPT-5',
  'Supporting / explore models': 'None',
  'Architecture / dispatch authority': 'ChatGPT',
  'Figures moved': 'none',
  'Reproduced / disproved': 'confirmed against the current workflow',
  'Authority impact': 'CLAUDE.md remains the sole review authority',
  Tests: 'node test-mergecard.js — passing',
  Security: 'unchanged',
  'Advisory review': 'not run',
  'Owner decision required': 'No',
  'Estimated inputs added': 'none',
};

function card({ fields = {}, review = {}, omitField } = {}) {
  const values = { ...FIELDS, ...fields };
  const rows = Object.entries(values)
    .filter(([label]) => label !== omitField)
    .map(([label, value]) => `| **${label}** | ${value} |`);
  const reviewValues = {
    Required: 'NOT REQUIRED — no high-risk trigger fired',
    'Exact reviewed head': 'N/A',
    Reviewer: 'N/A',
    'Review outcome': 'N/A',
    'Findings and fix verification': 'N/A',
    ...review,
  };
  const reviewRows = Object.entries(reviewValues)
    .map(([label, value]) => `- **${label}**: ${value}`);
  return [
    '## 🟦 Atlas Merge Card',
    '',
    '| Field | Value |',
    '|---|---|',
    ...rows,
    '',
    '### Atlas Contract / Systems Review',
    '',
    ...reviewRows,
  ].join('\n');
}

// A merge group: main's tip (the base) and the queue commit built on it.
const GROUP_BASE = 'be80c21a0d0d69def9a01d1a5ab015bda6b4de7d';
const GROUP_HEAD = '1e5afe2810d3c221f4f5bf29c3af04dea109ffec';

async function validate(body, head = HEAD, files = ['docs/status.md'], options = {}) {
  let failure = '';
  const core = {
    setFailed(message) { failure = String(message); },
    info() {},
  };
  const eventNumber = options.eventNumber != null ? options.eventNumber : 1;
  const eventHead = options.eventHead || head;
  const eventBody = Object.prototype.hasOwnProperty.call(options, 'eventBody')
    ? options.eventBody
    : body;
  const livePr = {
    number: options.liveNumber != null ? options.liveNumber : eventNumber,
    state: options.state != null ? options.state : 'open',
    merged: options.merged === true,
    body,
    base: {
      ref: options.baseRef != null ? options.baseRef : 'main',
      repo: { full_name: options.liveRepo || 'owner/repo' },
    },
    head: {
      sha: options.liveHead || head,
      repo: { full_name: options.liveHeadRepo || 'owner/repo' },
    },
  };
  const eventName = options.eventName || 'pull_request';
  const context = {
    eventName,
    sha: options.runSha != null ? options.runSha : eventHead,
    ref: options.ref || '',
    repo: { owner: 'owner', repo: 'repo' },
    payload: eventName === 'workflow_dispatch'
      ? {
        inputs: {
          pr_number: Object.prototype.hasOwnProperty.call(options, 'dispatchPr')
            ? options.dispatchPr
            : eventNumber,
          expected_head_sha: Object.prototype.hasOwnProperty.call(options, 'dispatchHead')
            ? options.dispatchHead
            : eventHead,
        },
        repository: { default_branch: options.defaultBranch || '' },
      }
      : eventName === 'merge_group'
        ? {
          merge_group: {
            head_ref: Object.prototype.hasOwnProperty.call(options, 'groupHeadRef')
              ? options.groupHeadRef
              // Shaped like the real #977 queue run: the ref's SHA is the
              // group's BASE (main's tip), not the PR head.
              : `refs/heads/gh-readonly-queue/main/pr-${eventNumber}-${GROUP_BASE}`,
            base_ref: options.groupBaseRef || 'refs/heads/main',
            base_sha: Object.prototype.hasOwnProperty.call(options, 'groupBaseSha')
              ? options.groupBaseSha
              : GROUP_BASE,
            head_sha: Object.prototype.hasOwnProperty.call(options, 'groupHeadSha')
              ? options.groupHeadSha
              : GROUP_HEAD,
          },
          repository: { default_branch: 'main' },
        }
        : {
          pull_request: { number: eventNumber, body: eventBody, head: { sha: eventHead } },
        },
  };
  const createdChecks = options.createdChecks || [];
  const github = {
    rest: {
      pulls: {
        listFiles() {},
        async get() {
          return { data: livePr };
        },
        listReviews() {},
      },
      repos: {
        async getCommit({ ref }) {
          if (options.groupCommitError) throw new Error(options.groupCommitError);
          if (ref !== GROUP_HEAD) throw new Error('unexpected commit ' + ref);
          const parents = Object.prototype.hasOwnProperty.call(options, 'groupParents')
            ? options.groupParents
            : [GROUP_BASE, eventHead];
          return { data: { sha: ref, parents: parents.map(sha => ({ sha })) } };
        },
      },
      checks: {
        async create(params) {
          createdChecks.push(params);
          if (options.checkCreateError) {
            throw new Error(options.checkCreateError);
          }
          return { data: { id: 1 } };
        },
      },
    },
    paginate: async (fn) => {
      if (fn === github.rest.pulls.listReviews) {
        if (options.reviewsError) throw new Error(options.reviewsError);
        return Array.isArray(options.reviews) ? options.reviews : [];
      }
      return files.map((filename) => ({ filename }));
    },
  };
  await vm.runInNewContext(
    `(async () => {\n${SCRIPT}\n})()`,
    { context, core, github, require: options.require || require, process },
    { timeout: 1000 },
  );
  return failure;
}

const checks = [];
const green = (name, body, files) => {
  checks.push((async () => {
    const message = await validate(body, HEAD, files);
    ok(!message, name, message);
  })());
};
const red = (name, body, pattern, files) => {
  checks.push((async () => {
    const message = await validate(body, HEAD, files);
    ok(Boolean(message) && (!pattern || pattern.test(message)), name, message || 'unexpected green');
  })());
};

green('a complete NOT REQUIRED card passes for ordinary documentation', card(), ['docs/status.md']);
red('the card heading is required', 'plain PR body', /Atlas Merge Card/);

for (const label of Object.keys(FIELDS)) {
  red(`missing mechanical row: ${label}`, card({ omitField: label }), new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

red('a retained HTML placeholder is blank', card({ fields: { Tests: '<!-- exact command -->' } }), /Tests.*blank/i);
red('the current-state verdict uses a closed opening', card({ fields: { 'Current-state verdict': 'NOT CHECKED' } }), /must open/i);

const documentedVerdicts = claudeCurrentStateVerdicts();
const mechanicalVerdicts = workflowCurrentStateValues();
ok(
  JSON.stringify(documentedVerdicts) === JSON.stringify(mechanicalVerdicts),
  'CLAUDE.md current-state verdicts match merge-card-check CURRENT_STATE',
  `claude=${JSON.stringify(documentedVerdicts)} workflow=${JSON.stringify(mechanicalVerdicts)}`,
);
ok(
  documentedVerdicts.includes('STALE-SUPERSEDED')
    && !documentedVerdicts.includes('STALE / SUPERSEDED'),
  'CLAUDE.md documents STALE-SUPERSEDED rather than STALE / SUPERSEDED',
);
for (const token of documentedVerdicts) {
  green(
    `a builder following CLAUDE.md can open with ${token}`,
    card({ fields: { 'Current-state verdict': `${token} — vocabulary proof` } }),
  );
}
red(
  'the pre-alignment slash form STALE / SUPERSEDED fails the mechanical check',
  card({ fields: { 'Current-state verdict': 'STALE / SUPERSEDED — vocabulary proof' } }),
  /must open/i,
);

// Prose meaning is intentionally outside CI. The closed opening is mechanical;
// a reviewer decides whether the rest is honest.
green('later current-state prose is not semantically parsed', card({
  fields: { 'Current-state verdict': 'STILL BROKEN or ALREADY FIXED — reviewer must judge this bad prose' },
}));
green('Primary risk may carry an explanation after the closed value', card({
  fields: { 'Primary risk': 'auto-safe — no published figure moves' },
}));
green('Primary risk accepts ordinary inline-code around auto-safe', card({
  fields: { 'Primary risk': '`auto-safe`' },
}));
green('Primary risk accepts inline-code figures-moved with an explanation', card({
  fields: { 'Primary risk': '`figures-moved` — Plan tile weekly cap' },
}));
green('Primary risk accepts inline-code owner-decision', card({
  fields: { 'Primary risk': '`owner-decision`' },
}));
green('Primary risk accepts inline-code blocked', card({
  fields: { 'Primary risk': '`blocked`' },
}));
red('inline-code around an unknown Primary risk still fails', card({ fields: {
  'Primary risk': '`probably-fine`',
} }), /Primary risk.*must open/i);
red('inline-code around two Primary risk values still fails', card({ fields: {
  'Primary risk': '`auto-safe` `figures-moved`',
} }), /Primary risk.*must open/i);
red('partial Primary risk remains invalid', card({ fields: {
  'Primary risk': 'figures',
} }), /Primary risk.*must open/i);

const required = {
  Required: 'REQUIRED — review machinery changed',
  'Exact reviewed head': HEAD,
  Reviewer: 'ChatGPT',
  'Review outcome': 'PASS',
  'Findings and fix verification': 'No blockers remain on this exact head',
};
green('a passing required review on the exact head passes', card({ review: required }));
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    runSha: 'd'.repeat(40),
  });
  ok(!message, 'pull_request still validates the event head, not github.sha', message);
})());
checks.push((async () => {
  const staleEventBody = card({ review: { ...required, 'Review outcome': 'NOT PASS' } });
  const livePassBody = card({ review: required });
  const message = await validate(livePassBody, HEAD, ['docs/status.md'], {
    eventBody: staleEventBody,
  });
  ok(!message, 'stale event body NOT PASS + live body PASS on the same head succeeds', message);
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    liveHead: 'b'.repeat(40),
  });
  ok(
    Boolean(message) && /failed closed/i.test(message) && /live head/i.test(message),
    'a moved live head fails closed',
    message || 'unexpected green',
  );
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    state: 'closed',
  });
  ok(
    Boolean(message) && /failed closed/i.test(message) && /not open/i.test(message),
    'a closed PR fails closed',
    message || 'unexpected green',
  );
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    baseRef: 'other',
  });
  ok(
    Boolean(message) && /failed closed/i.test(message) && /not main/i.test(message),
    'a base-changed PR fails closed',
    message || 'unexpected green',
  );
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    liveNumber: 99,
  });
  ok(
    Boolean(message) && /failed closed/i.test(message) && /live PR 99/i.test(message),
    'a live PR number mismatch fails closed',
    message || 'unexpected green',
  );
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    liveRepo: 'other/repo',
  });
  ok(
    Boolean(message) && /failed closed/i.test(message) && /live repository/i.test(message),
    'a live repository mismatch fails closed',
    message || 'unexpected green',
  );
})());
green(
  'a complete card covers a high-risk path without a SHA lock',
  card({ review: required }),
  ['data.json'],
);
green(
  'a high-risk path may say NOT REQUIRED — review SHA is not a merge lock',
  card(),
  ['data.json'],
);
green(
  'a workflow change may say NOT REQUIRED — tests are the junk gate',
  card(),
  ['.github/workflows/merge-card-check.yml'],
);
green('an incomplete review SHA does not fail the completeness check', card({ review: {
  ...required, 'Exact reviewed head': 'abc1234',
} }));
green('a stale review SHA does not fail the completeness check', card({ review: {
  ...required, 'Exact reviewed head': 'b'.repeat(40),
} }));
green('a non-ChatGPT reviewer does not fail the completeness check', card({ review: {
  ...required, Reviewer: 'Codex',
} }));
green('a BLOCKING review outcome does not fail the completeness check', card({ review: {
  ...required, 'Review outcome': 'BLOCKING',
} }));
green('a PENDING review outcome does not fail the completeness check', card({ review: {
  ...required, 'Review outcome': 'PENDING',
} }));

const trustedPass = [{
  id: 1,
  commit_id: HEAD,
  submitted_at: '2026-08-16T05:38:55Z',
  user: { login: 'tc5v5s64ym-sketch' },
  body: 'Atlas Contract / Systems Review — PASS\n\nExact reviewed head: `' + HEAD + '`\n',
}];
const pendingRequired = {
  ...required,
  'Review outcome': 'PENDING',
  'Findings and fix verification': 'Awaiting exact-head Atlas review.',
};
checks.push((async () => {
  const message = await validate(card({ review: pendingRequired }), HEAD, ['docs/status.md'], {
    reviews: trustedPass,
  });
  ok(!message, 'PENDING card still passes completeness without a SHA lock', message);
})());
checks.push((async () => {
  const message = await validate(card({ review: pendingRequired }), HEAD, ['.github/workflows/merge-card-check.yml'], {
    eventName: 'pull_request_review',
    reviews: trustedPass,
  });
  ok(!message, 'pull_request_review with a PENDING card still passes completeness', message);
})());
checks.push((async () => {
  const message = await validate(card({ review: pendingRequired }), HEAD, ['docs/status.md'], {
    reviews: [{
      ...trustedPass[0],
      user: { login: 'chatgpt-codex-connector[bot]' },
    }],
  });
  ok(!message, 'Codex review does not fail the completeness check', message);
})());
checks.push((async () => {
  const message = await validate(card({ review: pendingRequired }), HEAD, ['docs/status.md'], {
    reviews: [{
      ...trustedPass[0],
      body: 'Atlas Contract / Systems Review — NOT PASS\n\nExact-head proof is missing.\n',
    }],
  });
  ok(!message, 'trusted NOT PASS does not fail the completeness check', message);
})());
checks.push((async () => {
  const message = await validate(card({ review: pendingRequired }), HEAD, ['docs/status.md'], {
    reviews: [{ ...trustedPass[0], commit_id: 'b'.repeat(40) }],
  });
  ok(!message, 'a review on another SHA does not fail the completeness check', message);
})());
checks.push((async () => {
  const staleCard = card({
    review: {
      ...required,
      'Exact reviewed head': 'b'.repeat(40),
      Reviewer: 'Codex',
      'Review outcome': 'PENDING',
    },
  });
  const message = await validate(staleCard, HEAD, ['docs/status.md'], {
    reviews: trustedPass,
  });
  ok(!message, 'a stale PENDING card still passes completeness', message);
})());
checks.push((async () => {
  const message = await validate(card({ review: {
    ...required,
    'Review outcome': 'BLOCKING',
  } }), HEAD, ['docs/status.md'], {
    reviews: trustedPass,
  });
  ok(!message, 'an explicit BLOCKING card still passes completeness', message);
})());
checks.push((async () => {
  const message = await validate(card({ review: {
    ...required,
    'Review outcome': 'NOT PASS',
  } }), HEAD, ['docs/status.md'], {
    reviews: trustedPass,
  });
  ok(!message, 'an explicit NOT PASS card still passes completeness', message);
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    reviews: [{
      id: 2,
      commit_id: HEAD,
      submitted_at: '2026-08-16T06:00:00Z',
      user: { login: 'tc5v5s64ym-sketch' },
      body: 'Atlas Contract / Systems Review — NOT PASS\n\nNew blocker.\n',
    }],
  });
  ok(!message, 'a later trusted NOT PASS does not fail the completeness check', message);
})());
checks.push((async () => {
  const message = await validate(card({ review: pendingRequired }), HEAD, ['docs/status.md'], {
    reviewsError: 'api down',
  });
  ok(!message, 'completeness does not depend on loading trusted reviews', message);
})());
red('Primary risk uses the closed vocabulary', card({ fields: {
  'Primary risk': 'probably-fine',
} }), /Primary risk.*must open/i);
checks.push((async () => {
  const message = await validate(card(), HEAD, ['docs/status.md'], {
    require() { throw new Error('missing helper'); },
  });
  ok(
    Boolean(message) && /failed closed/i.test(message) && /helper/i.test(message),
    'a missing Primary-risk helper fails closed',
    message || 'unexpected green',
  );
})());
red('required-review notes cannot be blank', card({ review: {
  ...required, 'Findings and fix verification': '<!-- notes -->',
} }), /fix verification.*blank/i);
red('an unknown review decision fails closed', card({ review: {
  Required: 'MAYBE',
} }), /REQUIRED or NOT REQUIRED/i);
red('NOT REQUIRED uses N/A for the reviewed head', card({ review: {
  'Exact reviewed head': HEAD,
} }), /Exact reviewed head: N\/A/i);
red('NOT REQUIRED uses N/A for reviewer', card({ review: {
  Reviewer: 'ChatGPT',
} }), /Reviewer: N\/A/i);
red('NOT REQUIRED uses N/A for outcome', card({ review: {
  'Review outcome': 'PASS',
} }), /Review outcome: N\/A/i);

checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'workflow_dispatch',
    runSha: HEAD,
  });
  ok(!message, 'workflow_dispatch with matching live PR/head and PASS card succeeds', message);
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'workflow_dispatch',
    runSha: HEAD,
    liveHead: 'b'.repeat(40),
  });
  ok(
    Boolean(message) && /failed closed/i.test(message) && /live head/i.test(message),
    'workflow_dispatch fails closed when the live head moved',
    message || 'unexpected green',
  );
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'workflow_dispatch',
    runSha: 'c'.repeat(40),
  });
  ok(
    Boolean(message) && /failed closed/i.test(message) && /workflow run SHA/i.test(message),
    'workflow_dispatch fails closed when the run SHA is not the expected head',
    message || 'unexpected green',
  );
})());
checks.push((async () => {
  const createdChecks = [];
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'workflow_dispatch',
    runSha: 'c'.repeat(40),
    ref: 'refs/heads/evil',
    defaultBranch: 'main',
    createdChecks,
  });
  ok(
    Boolean(message) && /workflow run SHA/i.test(message) && createdChecks.length === 0,
    'workflow_dispatch from a non-default ref still fails closed when the run SHA is not the expected head',
    message || 'unexpected green',
  );
})());
checks.push((async () => {
  const createdChecks = [];
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'workflow_dispatch',
    runSha: 'c'.repeat(40),
    ref: 'refs/heads/main',
    defaultBranch: 'main',
    createdChecks,
  });
  ok(
    !message
      && createdChecks.length === 1
      && createdChecks[0].name === 'Merge card mechanical fields'
      && createdChecks[0].head_sha === HEAD
      && createdChecks[0].conclusion === 'success',
    'default-branch dispatch records the required check on the expected head',
    message || JSON.stringify(createdChecks[0] || {}),
  );
})());
checks.push((async () => {
  const createdChecks = [];
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'workflow_dispatch',
    runSha: HEAD,
    createdChecks,
  });
  ok(
    !message && createdChecks.length === 0,
    'PR-head dispatch still uses the Actions job check, not a synthetic check run',
    message || `checks=${createdChecks.length}`,
  );
})());
checks.push((async () => {
  const createdChecks = [];
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'workflow_dispatch',
    runSha: 'c'.repeat(40),
    ref: 'refs/heads/main',
    defaultBranch: 'main',
    liveHead: 'b'.repeat(40),
    createdChecks,
  });
  ok(
    Boolean(message) && /live head/i.test(message) && createdChecks.length === 0,
    'default-branch dispatch does not record a check when the live head moved',
    message || 'unexpected green',
  );
})());
checks.push((async () => {
  const createdChecks = [];
  const message = await validate(card({ omitField: 'Tests' }), HEAD, ['docs/status.md'], {
    eventName: 'workflow_dispatch',
    runSha: 'c'.repeat(40),
    ref: 'refs/heads/main',
    defaultBranch: 'main',
    createdChecks,
  });
  ok(
    Boolean(message)
      && /Tests/.test(message)
      && createdChecks.length === 1
      && createdChecks[0].head_sha === HEAD
      && createdChecks[0].conclusion === 'failure'
      && createdChecks[0].name === 'Merge card mechanical fields',
    'default-branch dispatch records a failing required check on the expected head',
    message || JSON.stringify(createdChecks[0] || {}),
  );
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'workflow_dispatch',
    runSha: 'c'.repeat(40),
    ref: 'refs/heads/main',
    defaultBranch: 'main',
    checkCreateError: 'api down',
    createdChecks: [],
  });
  ok(
    Boolean(message) && /required check on the expected head/i.test(message),
    'default-branch dispatch fails closed when the required check cannot be recorded',
    message || 'unexpected green',
  );
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'workflow_dispatch',
    runSha: HEAD,
    dispatchHead: 'not-a-sha',
  });
  ok(
    Boolean(message) && /failed closed/i.test(message) && /expected head SHA/i.test(message),
    'workflow_dispatch fails closed without a 40-character expected head SHA',
    message || 'unexpected green',
  );
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'workflow_dispatch',
    runSha: HEAD,
    dispatchPr: 'not-a-number',
  });
  ok(
    Boolean(message) && /failed closed/i.test(message) && /pull request/i.test(message),
    'workflow_dispatch fails closed without a PR number',
    message || 'unexpected green',
  );
})());
checks.push((async () => {
  const staleEventBody = card({ review: { ...required, 'Review outcome': 'NOT PASS' } });
  const livePassBody = card({ review: required });
  const message = await validate(livePassBody, HEAD, ['docs/status.md'], {
    eventName: 'workflow_dispatch',
    runSha: HEAD,
    eventBody: staleEventBody,
  });
  ok(!message, 'workflow_dispatch still reads the live PASS card, not a stale event body', message);
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'issue_comment',
  });
  ok(
    Boolean(message) && /failed closed/i.test(message) && /unsupported event/i.test(message),
    'an unsupported event fails closed',
    message || 'unexpected green',
  );
})());

checks.push((async () => {
  const atlas = require('../scripts/atlas-review-block');
  const livePass = card({
    review: {
      Required: 'REQUIRED — review machinery changed',
      'Exact reviewed head': HEAD,
      Reviewer: 'ChatGPT',
      'Review outcome': 'PASS',
      'Findings and fix verification': atlas.PASS_FINDINGS,
    },
  });
  const message = await validate(livePass, HEAD, ['.github/workflows/merge-card-check.yml'], {
    eventName: 'workflow_dispatch',
    runSha: HEAD,
  });
  ok(
    !message,
    '#55 sequence: trusted PASS card on the current live head validates via workflow_dispatch',
    message,
  );
})());

// Merge queue: no pull_request payload. The PR is read from the group ref and
// the same live card is re-checked; nothing passes without that re-check.
checks.push((async () => {
  const createdChecks = [];
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'merge_group', runSha: 'f'.repeat(40), createdChecks,
  });
  ok(!message && createdChecks.length === 0,
    'merge_group (#977 shape: ref SHA is the base) takes the PR head from the group commit, re-checks the live card and passes', message);
})());
checks.push((async () => {
  const message = await validate(card({ omitField: 'Tests' }), HEAD, ['docs/status.md'], {
    eventName: 'merge_group', runSha: 'f'.repeat(40),
  });
  ok(/Tests/.test(message), 'merge_group fails a card that is missing a row', message || 'unexpected green');
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'merge_group', runSha: 'f'.repeat(40), liveHead: 'b'.repeat(40),
  });
  ok(/failed closed/i.test(message) && /live head/i.test(message),
    'merge_group fails closed when the PR head moved after queueing', message || 'unexpected green');
})());
checks.push((async () => {
  const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
    eventName: 'merge_group', runSha: 'f'.repeat(40), state: 'closed',
  });
  ok(/failed closed/i.test(message) && /not open/i.test(message),
    'merge_group fails closed when the queued PR is closed', message || 'unexpected green');
})());
for (const [name, extra] of [
  ['an unreadable group ref', { groupHeadRef: 'refs/heads/agent/feature' }],
  ['a missing group ref', { groupHeadRef: undefined }],
  ['a group on another base', { groupBaseRef: 'refs/heads/release' }],
  ['more than one PR in the ref', { groupHeadRef: `refs/heads/gh-readonly-queue/main/pr-1-pr-2-${GROUP_BASE}` }],
  ['a group commit whose second parent is not the PR head', { groupParents: [GROUP_BASE, 'c'.repeat(40)] }],
  ['a group commit not built on the group base (stacked on another queued PR)', { groupParents: ['c'.repeat(40), HEAD] }],
  ['a group base SHA that is not the commit\'s first parent', { groupBaseSha: 'c'.repeat(40) }],
  ['a squash/rebase group commit with one parent', { groupParents: [HEAD] }],
  ['a group commit with three parents', { groupParents: [GROUP_BASE, HEAD, 'c'.repeat(40)] }],
  ['a missing group head SHA', { groupHeadSha: undefined }],
  ['a missing group base SHA', { groupBaseSha: undefined }],
  ['a failed group commit fetch', { groupCommitError: 'boom' }],
]) {
  checks.push((async () => {
    const message = await validate(card({ review: required }), HEAD, ['docs/status.md'], {
      eventName: 'merge_group', runSha: 'f'.repeat(40), ...extra,
    });
    ok(/failed closed/i.test(message), `merge_group fails closed on ${name}`, message || 'unexpected green');
  })());
}

// The gate only requires the notes to exist. It does not inspect negation or
// decide whether every finding was dispositioned.
green('review prose and negation are not semantically parsed', card({ review: {
  ...required,
  'Findings and fix verification': 'P1 was not fixed; this is a reviewer judgement, not a regex target',
} }));

Promise.all(checks)
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
