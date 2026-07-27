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
import { deriveScheduleActivatedAt } from './run.ts';

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
