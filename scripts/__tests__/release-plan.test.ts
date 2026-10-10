import assert from 'node:assert/strict';
import { test } from 'vitest';
import { planRelease } from '../release-plan.mjs';

const MAIN = 'a'.repeat(40);
const NIGHTLY_COMMIT = 'b'.repeat(40);

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

test('a scheduled nightly waits for new commits, a new day, and green CI', () => {
  assert.match(planRelease(run({ sha: NIGHTLY_COMMIT })).reason, /already ships/);
  assert.match(planRelease(run({ today: '20261010' })).reason, /shipped today/);
  assert.match(planRelease(run({ ciConclusion: 'in_progress' })).reason, /is in_progress/);
});

test('a dispatched nightly skips the cadence checks but still requires green CI', () => {
  const dispatched = run({ event: 'workflow_dispatch', sha: NIGHTLY_COMMIT, today: '20261010' });
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
