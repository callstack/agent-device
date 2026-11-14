import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { test } from 'vitest';
import {
  isVersionOnlyCommit,
  planRelease,
  type ReleasePlan,
  repositorySetupGaps,
} from '../release-plan.mjs';

const MAIN = 'a'.repeat(40);
const NIGHTLY_COMMIT = 'b'.repeat(40);

function skipReason(plan: ReleasePlan): string {
  assert.equal(plan.mode, 'skip');
  return plan.reason;
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    event: 'schedule',
    ref: 'refs/heads/main',
    sha: MAIN,
    rootVersion: '0.21.25-dev',
    today: '20261011',
    runNumber: '42',
    tags: new Map([
      ['v0.21.24', 'c'.repeat(40)],
      ['nightly/v0.21.25-nightly.20261010.41', NIGHTLY_COMMIT],
    ]),
    latestStable: '0.21.24',
    ciConclusion: 'success',
    onMain: undefined,
    ...overrides,
  };
}

test('a pull request builds a nightly-shaped version and publishes nothing', () => {
  assert.deepEqual(planRelease(run({ event: 'pull_request', ref: 'refs/pull/7/merge' })), {
    mode: 'dry-run',
    version: '0.21.25-nightly.20261011.42',
  });
});

test('a scheduled nightly publishes main once its CI passed', () => {
  assert.deepEqual(planRelease(run()), {
    mode: 'nightly',
    version: '0.21.25-nightly.20261011.42',
    distTag: 'nightly',
    commit: MAIN,
  });
});

test('a scheduled nightly waits for new commits and green CI', () => {
  assert.match(skipReason(planRelease(run({ sha: NIGHTLY_COMMIT }))), /already ships/);
  assert.match(skipReason(planRelease(run({ ciConclusion: 'failure' }))), /is failure/);
});

test('a dispatched nightly republishes the shipped HEAD but still requires green CI', () => {
  const dispatched = run({ event: 'workflow_dispatch', sha: NIGHTLY_COMMIT });
  assert.equal(planRelease(dispatched).mode, 'nightly');
  assert.throws(() => planRelease({ ...dispatched, ciConclusion: 'failure' }), /CI on .* failure/);
});

test('a nightly refuses a main whose -dev version trails the published release', () => {
  assert.throws(() => planRelease(run({ latestStable: '0.21.25' })), /not ahead of the published/);
});

test('a stable tag publishes its own commit once it is on main and its CI passed', () => {
  const stable = run({ event: 'workflow_dispatch', ref: 'refs/tags/v0.21.25', onMain: true });
  assert.deepEqual(planRelease(stable), {
    mode: 'stable',
    version: '0.21.25',
    distTag: 'latest',
    commit: MAIN,
    previousTag: 'v0.21.24',
  });
  assert.equal(planRelease({ ...stable, latestStable: '0.21.25' }).mode, 'stable');
  assert.throws(() => planRelease({ ...stable, latestStable: '0.21.26' }), /older than/);
  assert.throws(() => planRelease({ ...stable, onMain: false }), /not on main/);
  assert.throws(
    () => planRelease({ ...stable, ciConclusion: 'in_progress' }),
    /run Release on v0\.21\.25/,
  );
  assert.throws(() => planRelease({ ...stable, ref: 'refs/tags/v0.21.25-rc.1' }), /vX\.Y\.Z tag/);
});

test('releases refuse to run from any other branch', () => {
  assert.throws(() => planRelease(run({ ref: 'refs/heads/feature' })), /main or a vX\.Y\.Z tag/);
});

test("the workflow's -dev bump stands on its parent's CI, and nothing else does", () => {
  const bump = {
    parents: [{ sha: MAIN }],
    files: [
      {
        filename: 'package.json',
        patch: '@@ -2 +2 @@\n-  "version": "0.21.25",\n+  "version": "0.21.26-dev",',
      },
      {
        filename: 'packages/proxy/package.json',
        patch: '-  "version": "0.21.25",\n+  "version": "0.21.26-dev",',
      },
      {
        filename: 'server.json',
        patch: '-      "version": "0.21.25"\n+      "version": "0.21.26-dev"',
      },
    ],
  };
  assert.equal(isVersionOnlyCommit(bump), true);
  const dependency = {
    ...bump,
    files: [
      { filename: 'package.json', patch: '-    "undici": "7.29.0",\n+    "undici": "8.0.0",' },
    ],
  };
  assert.equal(isVersionOnlyCommit(dependency), false);
  const source = { ...bump, files: [...bump.files, { filename: 'src/index.ts', patch: '+x' }] };
  assert.equal(isVersionOnlyCommit(source), false);
  assert.equal(
    isVersionOnlyCommit({ ...bump, parents: [{ sha: MAIN }, { sha: NIGHTLY_COMMIT }] }),
    false,
  );
  assert.equal(isVersionOnlyCommit({ ...bump, files: [] }), false);
});

function protectedRuleset() {
  return {
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'] } },
    rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }],
  };
}

function protectedSetup() {
  return {
    npmPublish: { deployment_branch_policy: { custom_branch_policies: true } },
    npmPublishPolicies: [
      { name: 'main', type: 'branch' },
      { name: 'v*', type: 'tag' },
    ],
    tagRulesets: [protectedRuleset()],
  };
}

test('publishing needs the protections GitHub enforces, not this script', () => {
  assert.deepEqual(repositorySetupGaps(protectedSetup()), []);
  assert.equal(
    repositorySetupGaps({
      npmPublish: null,
      npmPublishPolicies: [],
      tagRulesets: [],
    }).length,
    2,
  );
});

test('each missing protection is named on its own', () => {
  const setup = protectedSetup();
  const anyBranch = {
    ...setup,
    npmPublishPolicies: [...setup.npmPublishPolicies, { name: '*', type: 'branch' }],
  };
  assert.match(repositorySetupGaps(anyBranch).join(), /npm-publish environment/);
  const evaluating = {
    ...setup,
    tagRulesets: [{ ...protectedRuleset(), enforcement: 'evaluate' }],
  };
  assert.match(repositorySetupGaps(evaluating).join(), /tag ruleset/);
  const anyBranchToggle = {
    ...setup,
    npmPublish: { deployment_branch_policy: { custom_branch_policies: false } },
  };
  assert.match(repositorySetupGaps(anyBranchToggle).join(), /npm-publish environment/);
  const excluding = {
    ...setup,
    tagRulesets: [
      {
        ...protectedRuleset(),
        conditions: { ref_name: { include: ['refs/tags/v*'], exclude: ['refs/tags/v9*'] } },
      },
    ],
  };
  assert.match(repositorySetupGaps(excluding).join(), /tag ruleset/);
  const writerBypass = {
    ...setup,
    tagRulesets: [
      { ...protectedRuleset(), bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 4 }] },
    ],
  };
  assert.match(repositorySetupGaps(writerBypass).join(), /tag ruleset/);
  const adminBypass = {
    ...setup,
    tagRulesets: [
      { ...protectedRuleset(), bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5 }] },
    ],
  };
  assert.deepEqual(repositorySetupGaps(adminBypass), []);
  const creatable = {
    ...setup,
    tagRulesets: [{ ...protectedRuleset(), rules: [{ type: 'deletion' }] }],
  };
  assert.match(repositorySetupGaps(creatable).join(), /tag ruleset/);
});

test('the 0.22 source publishes an isolated nightly channel from its own version and SHA', () => {
  assert.deepEqual(
    planRelease(run({ sourceBranch: '0.22', sha: NIGHTLY_COMMIT, rootVersion: '0.22.0-dev' })),
    {
      mode: 'nightly',
      version: '0.22.0-nightly-0-22.20261011.42',
      distTag: 'nightly-0.22',
      commit: NIGHTLY_COMMIT,
    },
  );
});

for (const latestStable of ['0.22.0', '0.22.1', '0.23.0']) {
  test(`0.22 nightlies remain available after stable ${latestStable} ships`, () => {
    const source = run({
      sourceBranch: '0.22',
      rootVersion: '0.22.0-dev',
      latestStable,
    });
    for (const event of ['schedule', 'workflow_dispatch']) {
      assert.deepEqual(planRelease({ ...source, event }), {
        mode: 'nightly',
        version: '0.22.0-nightly-0-22.20261011.42',
        distTag: 'nightly-0.22',
        commit: MAIN,
      });
    }
    assert.throws(
      () => planRelease({ ...source, sourceBranch: 'main' }),
      /not ahead of the published/,
    );
  });
}

test('0.22 deduplication ignores main nightlies and skips only its own published source', () => {
  const source = run({ sourceBranch: '0.22', sha: NIGHTLY_COMMIT, rootVersion: '0.22.0-dev' });
  assert.equal(planRelease(source).mode, 'nightly');
  const tags = new Map([
    ...source.tags,
    ['nightly-0.22/v0.22.0-nightly-0-22.20261010.41', NIGHTLY_COMMIT],
  ]);
  assert.match(skipReason(planRelease({ ...source, tags })), /already ships/);
  assert.equal(planRelease(run({ tags })).mode, 'nightly');
});

test('0.22 refuses another series, unsupported sources, non-main workflow refs and stable selection', () => {
  assert.throws(() => planRelease(run({ sourceBranch: '0.22' })), /0\.22.*version/);
  assert.throws(() => planRelease(run({ sourceBranch: 'feature' })), /source/);
  assert.throws(
    () => planRelease(run({ sourceBranch: '0.22', ref: 'refs/heads/0.22' })),
    /main or a vX/,
  );
  assert.throws(
    () => planRelease(run({ sourceBranch: '0.22', ref: 'refs/tags/v0.22.0' })),
    /source/,
  );
});

for (const ciConclusion of [
  'failure',
  'cancelled',
  'missing',
  'queued',
  'in_progress',
  'pending',
]) {
  test(`0.22 skips scheduled ${ciConclusion} CI and refuses a manual publish`, () => {
    const source = run({ sourceBranch: '0.22', rootVersion: '0.22.0-dev', ciConclusion });
    assert.equal(planRelease(source).mode, 'skip');
    assert.throws(() => planRelease({ ...source, event: 'workflow_dispatch' }), /CI on/);
  });
}

function runPlanner(
  options: {
    schedule?: string;
    source?: string;
    ref?: string;
    ci?: string;
    ciSha?: string;
    ciEvent?: string;
    rootVersion?: string;
    tags?: string;
  } = {},
) {
  const root = mkdtempForTestSync('release-plan-');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.21.38-dev' }));
  const event = path.join(root, 'event.json');
  fs.writeFileSync(
    event,
    JSON.stringify(
      options.source
        ? { inputs: { source_branch: options.source } }
        : { schedule: options.schedule ?? '53 1 * * *' },
    ),
  );
  const git = path.join(bin, 'git');
  fs.writeFileSync(
    git,
    '#!/usr/bin/env node\nprocess.stdout.write(process.env.RELEASE_TEST_TAGS);\n',
    { mode: 0o755 },
  );
  const responses = {
    '/repos/owner/repo/commits/0.22': { sha: NIGHTLY_COMMIT },
    [`/repos/owner/repo/contents/package.json?ref=${NIGHTLY_COMMIT}`]: {
      content: Buffer.from(
        JSON.stringify({ version: options.rootVersion ?? '0.22.0-dev' }),
      ).toString('base64'),
    },
    [`/repos/owner/repo/actions/workflows/ci.yml/runs?head_sha=${NIGHTLY_COMMIT}&event=push&branch=0.22&per_page=1`]:
      {
        workflow_runs: [
          {
            head_sha: options.ciSha ?? NIGHTLY_COMMIT,
            event: options.ciEvent ?? 'push',
            head_branch: '0.22',
            status: options.ci === 'pending' ? 'in_progress' : 'completed',
            conclusion: options.ci ?? 'success',
          },
        ],
      },
    [`/repos/owner/repo/actions/workflows/ci.yml/runs?head_sha=${MAIN}&event=push&branch=main&per_page=1`]:
      {
        workflow_runs: [
          {
            head_sha: MAIN,
            event: 'push',
            head_branch: 'main',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      },
    [`/repos/owner/repo/actions/workflows/ci.yml/runs?head_sha=${MAIN}&event=push&per_page=1`]: {
      workflow_runs: [
        {
          head_sha: MAIN,
          event: 'push',
          head_branch: 'main',
          status: 'completed',
          conclusion: 'success',
        },
      ],
    },
    [`/repos/owner/repo/compare/main...${MAIN}`]: { status: 'identical' },
    '/agent-device/latest': { version: '0.21.37' },
    '/repos/owner/repo/rulesets?targets=tag': [{ id: 1 }],
    '/repos/owner/repo/rulesets/1': protectedRuleset(),
    '/repos/owner/repo/environments/npm-publish': protectedSetup().npmPublish,
    '/repos/owner/repo/environments/npm-publish/deployment-branch-policies': {
      branch_policies: protectedSetup().npmPublishPolicies,
    },
  };
  const requests = path.join(root, 'requests.jsonl');
  const mock = path.join(root, 'fetch.mjs');
  fs.writeFileSync(
    mock,
    `import fs from 'node:fs';
const responses = ${JSON.stringify(responses)};
globalThis.fetch = async (url) => {
  const parsed = new URL(url);
  const key = parsed.pathname + parsed.search;
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(key) + '\\n');
  if (!(key in responses)) throw new Error('Unexpected request ' + key);
  return { ok: true, json: async () => responses[key] };
};
globalThis.setTimeout = (callback) => { callback(); return 0; };
`,
  );
  const output = path.join(root, 'output');
  const result = spawnSync(
    process.execPath,
    ['--import', mock, path.resolve(import.meta.dirname, '../release-plan.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RELEASE_TEST_TAGS: options.tags ?? '',
        GITHUB_EVENT_NAME: options.source ? 'workflow_dispatch' : 'schedule',
        GITHUB_REF: options.ref ?? 'refs/heads/main',
        GITHUB_SHA: MAIN,
        GITHUB_EVENT_PATH: event,
        GITHUB_RUN_NUMBER: '42',
        GITHUB_API_URL: 'https://api.github.test',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_TOKEN: 'fixture',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: path.join(root, 'summary'),
      },
    },
  );
  return {
    ...result,
    output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '',
    requests: fs.existsSync(requests)
      ? fs
          .readFileSync(requests, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [],
  };
}

test('the scheduled planner resolves 0.22 once and reads its manifest and push CI by that exact SHA', () => {
  const result = runPlanner();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /dist_tag=nightly-0\.22/);
  assert.match(result.output, new RegExp(`commit=${NIGHTLY_COMMIT}`));
  assert.match(result.output, /version=0\.22\.0-nightly-0-22\./);
  assert.match(result.output, /nightly_tag=nightly-0\.22\/v0\.22\.0-nightly-0-22/);
  assert.equal(
    result.requests.filter((request) => request === '/repos/owner/repo/commits/0.22').length,
    1,
  );
  assert.ok(
    result.requests.includes(`/repos/owner/repo/contents/package.json?ref=${NIGHTLY_COMMIT}`),
  );
  assert.ok(
    result.requests.includes(
      `/repos/owner/repo/actions/workflows/ci.yml/runs?head_sha=${NIGHTLY_COMMIT}&event=push&branch=0.22&per_page=1`,
    ),
  );
});

for (const options of [
  { ci: 'failure' },
  { ci: 'cancelled' },
  { ci: 'pending' },
  { ciSha: MAIN },
  { ciEvent: 'pull_request' },
]) {
  test(`the 0.22 entrypoint fails closed for CI ${JSON.stringify(options)}`, () => {
    const result = runPlanner(options);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /mode=skip/);
    assert.doesNotMatch(result.output, /dist_tag=nightly-0/);
    assert.ok(
      !result.requests.some(
        (request) => request.includes('/commits/') && !request.endsWith('/0.22'),
      ),
      '0.22 never substitutes parent CI',
    );
  });
}

test('manual fixed-source selection works; unsupported sources, refs and schedules fail before API calls', () => {
  const manual = runPlanner({ source: '0.22' });
  assert.equal(manual.status, 0, manual.stderr);
  assert.match(manual.output, /dist_tag=nightly-0\.22/);
  for (const options of [
    { source: 'feature' },
    { source: '0.22', ref: 'refs/heads/0.22' },
    { source: '0.22', ref: 'refs/tags/v0.22.0' },
    { schedule: '0 0 * * *' },
  ]) {
    const result = runPlanner(options);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.requests, []);
  }
});

test('the original main schedule, manual nightly and stable retry keep their channels and source', () => {
  for (const options of [
    { schedule: '23 1 * * *' },
    { source: 'main' },
    { source: 'main', ref: 'refs/tags/v0.21.38' },
  ]) {
    const result = runPlanner(options);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, new RegExp(`commit=${MAIN}`));
    assert.match(result.output, options.ref ? /dist_tag=latest/ : /dist_tag=nightly\n/);
    assert.ok(!result.requests.includes('/repos/owner/repo/commits/0.22'));
  }
});
