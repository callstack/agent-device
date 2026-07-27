// Entrypoint regressions for the scheduled-lane health watcher: the model
// self-test covers the health verdict, this covers the git seam the model
// cannot — deriving when a workflow's *current* schedule actually became active
// from real repository history (schedule added later to an old workflow,
// comment mentioning `schedule:`, and a remove/re-add).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runCmdSync } from '../../src/utils/exec.ts';
import { ALERT_ISSUE_TITLE } from './model.ts';
import {
  deriveScheduleActivatedAt,
  findExistingAlertIssue,
  raiseAlert,
  type GithubContext,
} from './run.ts';

const WORKFLOW = '.github/workflows/lane.yml';

const UNSCHEDULED = ['name: Lane', 'on:', '  workflow_dispatch: {}'].join('\n') + '\n';
const SCHEDULED = ['name: Lane', 'on:', '  schedule:', "    - cron: '0 5 * * *'"].join('\n') + '\n';
// A workflow that only mentions `schedule:` inside a comment must NOT count as scheduled.
const COMMENTED = ['name: Lane', '# schedule: not really', 'on:', '  push: {}'].join('\n') + '\n';

function git(cwd: string, args: string[], whenIso?: string): void {
  const env = whenIso
    ? { ...process.env, GIT_AUTHOR_DATE: whenIso, GIT_COMMITTER_DATE: whenIso }
    : process.env;
  runCmdSync('git', args, { cwd, env });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-health-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  return dir;
}

function commitWorkflow(dir: string, content: string, message: string, whenIso: string): void {
  const abs = path.join(dir, WORKFLOW);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message], whenIso);
}

/** Run git with separately-controlled author and committer dates. */
function gitDated(dir: string, args: string[], authorIso: string, committerIso: string): void {
  runCmdSync('git', args, {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: authorIso, GIT_COMMITTER_DATE: committerIso },
  });
}

function headCommitterIso(dir: string): string {
  return runCmdSync('git', ['log', '-1', '--format=%cI'], { cwd: dir }).stdout.trim();
}

function headAuthorIso(dir: string): string {
  return runCmdSync('git', ['log', '-1', '--format=%aI'], { cwd: dir }).stdout.trim();
}

test('deriveScheduleActivatedAt anchors on when the schedule was added to an OLD workflow', () => {
  const dir = makeRepo();
  try {
    // A long-lived, unscheduled workflow...
    commitWorkflow(dir, UNSCHEDULED, 'add unscheduled lane', '2024-01-01T00:00:00Z');
    // ...that only recently gained a schedule.
    commitWorkflow(dir, SCHEDULED, 'add schedule', '2026-07-20T00:00:00Z');

    const activated = deriveScheduleActivatedAt({ repoDir: dir, relPath: WORKFLOW });
    assert.ok(activated, 'should resolve an activation time');
    // The recent schedule-add commit, NOT the ancient file creation.
    assert.equal(new Date(activated).getUTCFullYear(), 2026);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveScheduleActivatedAt uses the newest transition after a remove/re-add', () => {
  const dir = makeRepo();
  try {
    commitWorkflow(dir, SCHEDULED, 'first schedule', '2024-01-01T00:00:00Z');
    commitWorkflow(dir, UNSCHEDULED, 'remove schedule', '2025-01-01T00:00:00Z');
    commitWorkflow(dir, SCHEDULED, 're-add schedule', '2026-07-20T00:00:00Z');

    const activated = deriveScheduleActivatedAt({ repoDir: dir, relPath: WORKFLOW });
    assert.ok(activated);
    // The current activation, not the obsolete 2024 introduction.
    assert.equal(new Date(activated).getUTCFullYear(), 2026);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveScheduleActivatedAt does not treat a commented-out schedule as scheduled', () => {
  const dir = makeRepo();
  try {
    commitWorkflow(dir, COMMENTED, 'comment mentions schedule', '2024-01-01T00:00:00Z');
    commitWorkflow(dir, SCHEDULED, 'actually schedule it', '2026-07-20T00:00:00Z');

    const activated = deriveScheduleActivatedAt({ repoDir: dir, relPath: WORKFLOW });
    assert.ok(activated);
    assert.equal(new Date(activated).getUTCFullYear(), 2026);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveScheduleActivatedAt anchors on first appearance when scheduled since creation', () => {
  const dir = makeRepo();
  try {
    commitWorkflow(dir, SCHEDULED, 'born scheduled', '2026-07-20T00:00:00Z');

    const activated = deriveScheduleActivatedAt({ repoDir: dir, relPath: WORKFLOW });
    assert.ok(activated);
    assert.equal(new Date(activated).getUTCFullYear(), 2026);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveScheduleActivatedAt returns undefined when the path has no history', () => {
  const dir = makeRepo();
  try {
    commitWorkflow(dir, SCHEDULED, 'unrelated', '2026-07-20T00:00:00Z');
    assert.equal(
      deriveScheduleActivatedAt({ repoDir: dir, relPath: '.github/workflows/absent.yml' }),
      undefined,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The schedule is added on a feature branch (old author/committer dates), then
// merged onto main much later. The anchor must be the MERGE commit's committer
// time — which is only true when we walk `--first-parent` (else we'd descend
// into the feature commit) with `%cI` (else we'd read the merge's older author
// date). This fixture deliberately makes all three dates distinct so dropping
// `--first-parent` or reverting `%cI`→`%aI` flips the asserted value.
test('deriveScheduleActivatedAt uses the merge commit committer time, not feature/author dates', () => {
  const dir = makeRepo();
  try {
    // main: an old, unscheduled workflow.
    commitWorkflow(dir, UNSCHEDULED, 'base unscheduled', '2024-01-01T00:00:00Z');

    // feature branch: introduce the schedule, with an OLD author+committer date.
    git(dir, ['checkout', '-q', '-b', 'feature']);
    commitWorkflow(dir, SCHEDULED, 'add schedule on feature', '2024-06-01T00:00:00Z');
    const featureIso = headCommitterIso(dir);

    // main advances independently so the later merge is a real divergent merge.
    git(dir, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# main advances\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'main advances'], '2025-06-01T00:00:00Z');

    // Merge feature into main much later, with author date < committer date.
    gitDated(
      dir,
      ['merge', '--no-ff', '--no-edit', '-m', 'merge feature', 'feature'],
      '2025-01-01T00:00:00Z', // merge AUTHOR date (older)
      '2026-07-20T00:00:00Z', // merge COMMITTER/landing date
    );
    const mergeCommitterIso = headCommitterIso(dir);
    const mergeAuthorIso = headAuthorIso(dir);

    // Sanity: the fixture actually distinguishes the three dates.
    assert.notEqual(mergeCommitterIso, mergeAuthorIso, 'merge author != committer date');
    assert.notEqual(mergeCommitterIso, featureIso, 'merge committer != feature committer date');

    const activated = deriveScheduleActivatedAt({ repoDir: dir, relPath: WORKFLOW });
    assert.equal(
      activated,
      mergeCommitterIso,
      'anchor must be the merge commit committer time (first-parent + %cI)',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The nightly watcher's GitHub issue-write route (open a fresh alert vs. ping an
// existing one) only ever runs on the default branch, so it can't be exercised
// from a PR. These stub `fetch` to pin the transport contract — endpoint, method,
// auth header, and payload for both branches — without a live run.
type RecordedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
};

type StubResponse = { status: number; json?: unknown };

function record(input: RequestInfo | URL, init: RequestInit | undefined): RecordedRequest {
  const rawBody = init?.body;
  return {
    method: init?.method ?? 'GET',
    url: typeof input === 'string' ? input : input.toString(),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body:
      typeof rawBody === 'string' ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined,
  };
}

function reply(next: StubResponse): Response {
  return new Response(next.json === undefined ? null : JSON.stringify(next.json), {
    status: next.status,
  });
}

function stubFetch(responses: readonly StubResponse[]): {
  calls: RecordedRequest[];
  restore: () => void;
} {
  const calls: RecordedRequest[] = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(record(input, init));
    return reply(responses[index++] ?? { status: 200, json: {} });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

const CTX: GithubContext = { token: 'secret-token', owner: 'o', repo: 'r' };

test('raiseAlert opens a new alert issue when none is open', async () => {
  const stub = stubFetch([
    { status: 200, json: [] }, // GET open issues → none match
    { status: 201, json: { number: 42 } }, // POST create issue
  ]);
  try {
    await raiseAlert(CTX, 'lane went dark');
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls.length, 2);
  assert.equal(stub.calls[0].method, 'GET');
  assert.match(stub.calls[0].url, /\/repos\/o\/r\/issues\?state=open/);
  assert.equal(stub.calls[1].method, 'POST');
  assert.match(stub.calls[1].url, /\/repos\/o\/r\/issues$/);
  assert.equal(stub.calls[1].headers.authorization, 'Bearer secret-token');
  assert.equal(stub.calls[1].body?.title, ALERT_ISSUE_TITLE);
  assert.equal(stub.calls[1].body?.body, 'lane went dark');
});

test('raiseAlert pings the existing alert issue instead of opening a duplicate', async () => {
  const stub = stubFetch([
    {
      status: 200,
      json: [
        { title: 'unrelated', number: 1 },
        { title: ALERT_ISSUE_TITLE, number: 7 },
      ],
    },
    { status: 201, json: { id: 1 } }, // POST comment
  ]);
  try {
    await raiseAlert(CTX, 'still dark');
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls.length, 2);
  assert.equal(stub.calls[1].method, 'POST');
  assert.match(stub.calls[1].url, /\/repos\/o\/r\/issues\/7\/comments$/);
  assert.equal(stub.calls[1].body?.body, 'still dark');
});

test('findExistingAlertIssue ignores pull requests and non-matching titles', async () => {
  const stub = stubFetch([
    {
      status: 200,
      json: [
        { title: ALERT_ISSUE_TITLE, number: 3, pull_request: {} }, // a PR, not an issue
        { title: 'something else', number: 4 },
      ],
    },
  ]);
  try {
    assert.equal(await findExistingAlertIssue(CTX), undefined);
  } finally {
    stub.restore();
  }
});
