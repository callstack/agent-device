// Scheduled-lane health classification (#1430).
//
// Every category comes from recorded run fields, so these cases pin the exact boundaries an alert
// fires on: a lane that stopped running, one that failed twice, and one that is merely flaky.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCmdSync } from '../../src/utils/exec.ts';
import { discoverScheduledLanes } from './discover.ts';
import {
  cadenceHours,
  healthTable,
  laneHealth,
  type LaneCadence,
  type LaneRun,
  unhealthyLanes,
} from './health-model.ts';
import { scheduleRegisteredAt } from './schedule-registration.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = Date.parse('2026-07-27T12:00:00Z');
const NIGHTLY: LaneCadence = {
  workflow: 'replays-nightly.yml',
  name: 'Replay Nightly',
  cronExpressions: ['0 3 * * *'],
  cadenceHours: 24,
};

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function known(runs: LaneRun[], scheduledHoursAgo = 1000) {
  return {
    known: true,
    scheduleRegisteredAt: new Date(NOW - scheduledHoursAgo * 60 * 60 * 1000).toISOString(),
    runs,
  };
}

function run(hoursAgo: number, conclusion: LaneRun['conclusion']): LaneRun {
  return {
    conclusion,
    createdAt: new Date(NOW - hoursAgo * 60 * 60 * 1000).toISOString(),
    url: 'https://example.test/run',
  };
}

describe('cadence', () => {
  it('reads daily, multi-hour, and weekly crons', () => {
    expect(cadenceHours(['0 3 * * *'])).toBe(24);
    expect(cadenceHours(['0 3,15 * * *'])).toBe(12);
    expect(cadenceHours(['0 3 * * 1'])).toBe(168);
  });

  it('takes the tightest cadence when a lane has several schedules', () => {
    expect(cadenceHours(['0 3 * * 1', '0 3 * * *'])).toBe(24);
  });
});

describe('lane health', () => {
  it('is healthy when the last run succeeded within cadence', () => {
    const lane = laneHealth(NIGHTLY, known([run(2, 'success'), run(26, 'success')]), NOW);
    expect(lane.state).toBe('healthy');
    expect(lane.hoursSinceLastSuccess).toBeCloseTo(2);
    expect(unhealthyLanes([lane])).toEqual([]);
  });

  it('tolerates a single failure — one red night is not an outage', () => {
    const lane = laneHealth(NIGHTLY, known([run(2, 'failure'), run(26, 'success')]), NOW);
    expect(lane.state).toBe('healthy');
    expect(lane.consecutiveFailures).toBe(1);
  });

  it('is failing after two consecutive failed cadences', () => {
    const lane = laneHealth(NIGHTLY, known([run(2, 'failure'), run(26, 'failure')]), NOW);
    expect(lane.state).toBe('failing');
    expect(lane.reason).toContain('2 consecutive');
  });

  it('is dark when no run arrived for two cadences', () => {
    const lane = laneHealth(NIGHTLY, known([run(60, 'success')]), NOW);
    expect(lane.state).toBe('dark');
    expect(lane.reason).toContain('over 48h of cadence');
  });

  it('is dark when a long-scheduled lane has never run on schedule', () => {
    const lane = laneHealth(NIGHTLY, known([]), NOW);
    expect(lane.state).toBe('dark');
    expect(lane.lastRunAt).toBeNull();
    expect(lane.hoursSinceLastSuccess).toBeNull();
  });

  // The production transition that matters: `schedule:` added to a workflow that has existed for
  // months. Anchoring on the workflow's own creation date would alert on its first minute.
  it('gives a just-scheduled old workflow the same two-cadence grace before its first run', () => {
    const lane = laneHealth(NIGHTLY, known([], 5), NOW);
    expect(lane.state).toBe('pending');
    expect(lane.reason).toContain('first run not yet 48h overdue');
    expect(unhealthyLanes([lane])).toEqual([]);
  });

  it('stays pending when a run-less lane has no schedule date to judge', () => {
    const lane = laneHealth(NIGHTLY, { known: true, scheduleRegisteredAt: null, runs: [] }, NOW);
    expect(lane.state).toBe('pending');
    expect(unhealthyLanes([lane])).toEqual([]);
  });

  it('is pending, not dark, when the run history could not be read', () => {
    const lane = laneHealth(NIGHTLY, { known: false, reason: 'no token', runs: [] }, NOW);
    expect(lane.state).toBe('pending');
    expect(unhealthyLanes([lane])).toEqual([]);
  });

  it('renders one table row per lane', () => {
    const table = healthTable([laneHealth(NIGHTLY, known([run(2, 'success')]), NOW)]);
    expect(table).toContain('| Replay Nightly | `replays-nightly.yml` | healthy |');
  });
});

function git(cwd: string, args: string[], date?: string): void {
  const stamp = date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  runCmdSync('git', args, { cwd, timeoutMs: 30_000, env: { ...process.env, ...stamp } });
}

/** A workflow that exists for a year, then gains a `schedule:` trigger — the transition that broke. */
function repoWithLaterSchedule(): { dir: string; scheduledAt: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-git-'));
  temporaryDirs.push(dir);
  const workflowDir = path.join(dir, '.github/workflows');
  const file = path.join(workflowDir, 'old.yml');
  fs.mkdirSync(workflowDir, { recursive: true });
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'lane@example.test']);
  git(dir, ['config', 'user.name', 'Lane Test']);
  fs.writeFileSync(file, 'name: Old\non:\n  workflow_dispatch:\njobs: {}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '--quiet', '-m', 'add workflow'], '2025-01-02T03:04:05+00:00');
  fs.writeFileSync(file, 'name: Old\non:\n  schedule:\n    - cron: "0 3 * * *"\njobs: {}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '--quiet', '-m', 'schedule it'], '2026-06-07T08:09:10+00:00');
  return { dir, scheduledAt: '2026-06-07T08:09:10+00:00' };
}

describe('schedule registration', () => {
  // Anchored on the commit that introduced `schedule:`, not the workflow's creation date.
  it('reads when a lane was scheduled out of git history', () => {
    const scheduled = scheduleRegisteredAt('.github/workflows', 'replays-nightly.yml');
    expect(scheduled).not.toBeNull();
    expect(Number.isFinite(Date.parse(scheduled ?? ''))).toBe(true);
  });

  // The pattern must be POSIX (`[[:space:]]`, not `\s`): the shorthand matches nothing on macOS,
  // and a silent no-match is indistinguishable from "cannot tell" — every lane stuck pending.
  it('finds the schedule commit, not the workflow creation commit', () => {
    const { dir, scheduledAt } = repoWithLaterSchedule();
    const scheduled = scheduleRegisteredAt('.github/workflows', 'old.yml', dir);
    expect(scheduled).not.toBeNull();
    expect(Date.parse(scheduled ?? '')).toBe(Date.parse(scheduledAt));
    expect(Date.parse(scheduled ?? '')).toBeGreaterThan(Date.parse('2025-01-02T03:04:05+00:00'));
  });

  it('keeps that lane pending right after scheduling, and only alerts two cadences later', () => {
    const { dir, scheduledAt } = repoWithLaterSchedule();
    const history = {
      known: true,
      scheduleRegisteredAt: scheduleRegisteredAt('.github/workflows', 'old.yml', dir),
      runs: [],
    };
    const scheduled = Date.parse(scheduledAt);
    const hour = 60 * 60 * 1000;
    expect(laneHealth(NIGHTLY, history, scheduled + hour).state).toBe('pending');
    expect(laneHealth(NIGHTLY, history, scheduled + 49 * hour).state).toBe('dark');
  });

  it('returns null — never a guess — for a file git knows nothing about', () => {
    expect(scheduleRegisteredAt('.github/workflows', 'no-such-workflow.yml')).toBeNull();
  });
});

describe('terminal failures', () => {
  // A monitor whose API call fails must still leave evidence behind, or the lane it watches goes
  // dark twice over: once in CI and once in the artifact a human would look for.
  it('writes an error envelope and snapshot when the Actions API is unreachable', () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-health-'));
    temporaryDirs.push(artifactDir);
    const result = runCmdSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(REPO_ROOT, 'scripts/scheduled-lane/health.ts'),
        '--artifact-dir',
        artifactDir,
        '--dry-run',
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GITHUB_TOKEN: 'not-a-real-token',
          GITHUB_API_URL: 'http://127.0.0.1:1',
        },
        timeoutMs: 60_000,
        allowFailure: true,
      },
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(
      fs.readFileSync(path.join(artifactDir, 'run-envelope.json'), 'utf8'),
    );
    expect(envelope.result).toBe('error');
    expect(envelope.lane).toBe('scheduled-lane-health');
    expect(String(envelope.details.error).length).toBeGreaterThan(0);
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(artifactDir, 'lane-health.json'), 'utf8'),
    );
    expect(snapshot.error).not.toBeNull();
  });
});

describe('lane discovery', () => {
  // Derived from the workflow directory: a scheduled lane cannot opt out of being watched.
  it('finds every schedule-triggered workflow in this repo', () => {
    const lanes = discoverScheduledLanes(path.join(REPO_ROOT, '.github/workflows'));
    expect(lanes.map((lane) => lane.workflow)).toContain('replays-nightly.yml');
    expect(lanes.every((lane) => lane.cronExpressions.length > 0)).toBe(true);
    expect(lanes.every((lane) => lane.cadenceHours > 0)).toBe(true);
  });
});
