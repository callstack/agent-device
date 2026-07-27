import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALERT_ISSUE_TITLE,
  buildAlertBody,
  cronCadenceMs,
  discoverScheduledLanes,
  evaluateLaneHealth,
  expandCronField,
  parseScheduledLane,
  type LaneRun,
} from './model.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function isoAgo(now: number, ms: number): string {
  return new Date(now - ms).toISOString();
}

test('expandCronField expands wildcards, lists, ranges, and steps', () => {
  assert.deepEqual(expandCronField('*', 0, 6), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(expandCronField('1,15', 0, 59), [1, 15]);
  assert.deepEqual(expandCronField('0-3', 0, 59), [0, 1, 2, 3]);
  assert.deepEqual(expandCronField('*/6', 0, 23), [0, 6, 12, 18]);
  // Unknown syntax fails open to the full range (never under-counts fires).
  assert.deepEqual(expandCronField('garbage', 0, 2), [0, 1, 2]);
});

test('cronCadenceMs estimates common cadences', () => {
  assert.equal(cronCadenceMs('0 5 * * *'), DAY_MS); // daily
  assert.equal(cronCadenceMs('0 * * * *'), HOUR_MS); // hourly
  // Weekly (Sundays) is ~7 days.
  assert.equal(cronCadenceMs('0 5 * * 0'), 7 * DAY_MS);
  // Twice daily → ~12h.
  assert.equal(cronCadenceMs('0 0,12 * * *'), 12 * HOUR_MS);
});

test('parseScheduledLane picks up schedule-triggered workflows and skips others', () => {
  const scheduled = parseScheduledLane(
    'nightly.yml',
    ['name: Nightly Sweep', 'on:', '  schedule:', "    - cron: '0 5 * * *'", 'jobs: {}'].join('\n'),
  );
  assert.ok(scheduled);
  assert.equal(scheduled.name, 'Nightly Sweep');
  assert.equal(scheduled.cadenceMs, DAY_MS);

  const pushOnly = parseScheduledLane('ci.yml', ['name: CI', 'on:', '  push: {}'].join('\n'));
  assert.equal(pushOnly, undefined);
});

test('discoverScheduledLanes excludes the watcher itself', () => {
  const files = [
    { file: 'a.yml', content: ['on:', '  schedule:', "    - cron: '0 5 * * *'"].join('\n') },
    { file: 'scheduled-lane-health.yml', content: ['on:', '  schedule:', "    - cron: '0 8 * * *'"].join('\n') },
    { file: 'ci.yml', content: ['on:', '  push: {}'].join('\n') },
  ];
  const lanes = discoverScheduledLanes(files, 'scheduled-lane-health.yml');
  assert.deepEqual(
    lanes.map((l) => l.file),
    ['a.yml'],
  );
});

test('evaluateLaneHealth: a fresh lane is healthy', () => {
  const now = Date.now();
  const lane = { file: 'nightly.yml', name: 'Nightly', cadenceMs: DAY_MS };
  const runs: LaneRun[] = [{ conclusion: 'success', createdAt: isoAgo(now, 3 * HOUR_MS) }];
  assert.equal(evaluateLaneHealth({ lane, runs, now }).healthy, true);
});

test('evaluateLaneHealth: a lane gone dark (no runs for two cadences) is unhealthy', () => {
  const now = Date.now();
  const lane = { file: 'nightly.yml', name: 'Nightly', cadenceMs: DAY_MS };
  // Last success was 3 days ago and nothing since — two cadences missed.
  const runs: LaneRun[] = [{ conclusion: 'success', createdAt: isoAgo(now, 3 * DAY_MS) }];
  const health = evaluateLaneHealth({ lane, runs, now });
  assert.equal(health.healthy, false);
  assert.match(health.reason, /two/);
});

test('evaluateLaneHealth: a lane with no successful run ever is unhealthy', () => {
  const now = Date.now();
  const lane = { file: 'nightly.yml', name: 'Nightly', cadenceMs: DAY_MS };
  const runs: LaneRun[] = [
    { conclusion: 'failure', createdAt: isoAgo(now, HOUR_MS) },
    { conclusion: 'failure', createdAt: isoAgo(now, DAY_MS) },
  ];
  const health = evaluateLaneHealth({ lane, runs, now });
  assert.equal(health.healthy, false);
  assert.match(health.reason, /failing every cadence/);
});

test('buildAlertBody summarizes only unhealthy lanes, or nothing when all healthy', () => {
  const now = Date.now();
  const healths = [
    { file: 'a.yml', name: 'A', healthy: true, reason: 'fresh' },
    { file: 'b.yml', name: 'B', healthy: false, reason: 'went dark' },
  ];
  const body = buildAlertBody({ healths, now, runUrl: 'https://example/run/1' });
  assert.ok(body);
  assert.match(body, /b\.yml/);
  assert.doesNotMatch(body, /a\.yml/);
  assert.match(body, /https:\/\/example\/run\/1/);

  const healthy = buildAlertBody({
    healths: [{ file: 'a.yml', name: 'A', healthy: true, reason: 'fresh' }],
    now,
  });
  assert.equal(healthy, undefined);
});

test('ALERT_ISSUE_TITLE is stable so the watcher pings one issue', () => {
  assert.equal(typeof ALERT_ISSUE_TITLE, 'string');
  assert.ok(ALERT_ISSUE_TITLE.length > 0);
});
