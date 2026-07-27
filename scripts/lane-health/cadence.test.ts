import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  cadenceHours,
  evaluateLane,
  laneCadenceHours,
  renderLaneHealth,
  unhealthy,
} from './cadence.ts';
import { observe, scheduledLanes } from './run.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOUR = 3600_000;
const now = Date.parse('2026-02-01T00:00:00Z');

test('cadence comes from the coarsest set cron field', () => {
  assert.equal(cadenceHours('0 5 * * 0'), 24 * 7);
  assert.equal(cadenceHours('0 3 * * *'), 24);
  assert.equal(cadenceHours('*/15 * * * *'), 1);
  assert.equal(cadenceHours('0 0 1 * *'), 24 * 30);
  assert.equal(laneCadenceHours(['0 5 * * 0', '0 3 * * *']), 24);
});

test('the scheduled lane list is derived from the workflow directory', () => {
  const lanes = scheduledLanes(path.join(repoRoot, '.github/workflows'));
  // The lane this PR adds must be watched by the monitor without being listed.
  assert.deepEqual(lanes.get('mutation-weekly.yml'), ['0 5 * * 0']);
  assert.ok(lanes.size >= 3, `expected several scheduled lanes, found ${lanes.size}`);
  assert.ok(!lanes.has('ci.yml'), 'PR CI is not a scheduled lane');
});

test('a lane that missed two cadences is dark', () => {
  const weekly = { lane: 'mutation-weekly.yml', cadenceHours: 24 * 7 };
  const fresh = evaluateLane(
    {
      ...weekly,
      lastRunAt: new Date(now - 24 * HOUR).toISOString(),
      lastSuccessAt: undefined,
      recentConclusions: ['success'],
      declaredAt: undefined,
    },
    now,
  );
  assert.equal(fresh.status, 'fresh');
  const dark = evaluateLane(
    {
      ...weekly,
      lastRunAt: new Date(now - 15 * 24 * HOUR).toISOString(),
      lastSuccessAt: undefined,
      recentConclusions: ['success'],
      declaredAt: undefined,
    },
    now,
  );
  assert.equal(dark.status, 'dark');
  assert.match(dark.detail, /15\.0d ago/);
  // One missed cadence is a hiccup, not an alert.
  assert.equal(
    evaluateLane(
      {
        ...weekly,
        lastRunAt: new Date(now - 9 * 24 * HOUR).toISOString(),
        lastSuccessAt: undefined,
        recentConclusions: ['success'],
        declaredAt: undefined,
      },
      now,
    ).status,
    'fresh',
  );
});

test('two consecutive non-success conclusions are failing; cancellations do not count', () => {
  const base = {
    lane: 'perf-nightly.yml',
    cadenceHours: 24,
    lastRunAt: new Date(now - HOUR).toISOString(),
    lastSuccessAt: undefined,
    declaredAt: undefined,
  };
  assert.equal(
    evaluateLane({ ...base, recentConclusions: ['failure', 'success'] }, now).status,
    'fresh',
  );
  assert.equal(
    evaluateLane({ ...base, recentConclusions: ['failure', 'cancelled', 'timed_out'] }, now).status,
    'failing',
  );
  assert.equal(evaluateLane({ ...base, recentConclusions: [] }, now).status, 'fresh');
});

test('a lane that never ran is reported once it is overdue, not while it is new', () => {
  const never = {
    lane: 'mutation-weekly.yml',
    cadenceHours: 24 * 7,
    lastRunAt: undefined,
    lastSuccessAt: undefined,
    recentConclusions: [],
  };
  // Merged an hour ago: it has legitimately not fired yet.
  assert.equal(
    evaluateLane({ ...never, declaredAt: new Date(now - HOUR).toISOString() }, now).status,
    'fresh',
  );
  const overdue = evaluateLane(
    { ...never, declaredAt: new Date(now - 30 * 24 * HOUR).toISOString() },
    now,
  );
  assert.equal(overdue.status, 'never-run');
  assert.equal(unhealthy([overdue]).length, 1);
});

test('observations map API runs onto the model, ignoring in-flight runs', () => {
  const observation = observe(
    'mutation-weekly.yml',
    ['0 5 * * 0'],
    [
      { conclusion: null, createdAt: '2026-02-01T05:00:00Z', status: 'in_progress' },
      { conclusion: 'failure', createdAt: '2026-01-25T05:00:00Z', status: 'completed' },
      { conclusion: 'success', createdAt: '2026-01-18T05:00:00Z', status: 'completed' },
    ],
  );
  assert.equal(observation.lastRunAt, '2026-02-01T05:00:00Z');
  assert.equal(observation.lastSuccessAt, '2026-01-18T05:00:00Z');
  assert.deepEqual(observation.recentConclusions, ['failure', 'success']);
  assert.equal(observation.cadenceHours, 24 * 7);
});

test('the rendered report names the unhealthy lanes', () => {
  const markdown = renderLaneHealth([
    { lane: 'mutation-weekly.yml', status: 'dark', detail: 'last scheduled run 20.0d ago' },
    { lane: 'perf-nightly.yml', status: 'fresh', detail: 'last scheduled run now' },
  ]);
  assert.match(markdown, /1 of 2 scheduled lane\(s\) need attention: mutation-weekly\.yml/);
  assert.match(markdown, /\| `mutation-weekly\.yml` \| dark \|/);
});
