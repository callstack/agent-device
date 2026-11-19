import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  revylLease,
  startRevylFixtureBackend,
  type RevylFixtureBackend,
} from './revyl-backend.fixtures.ts';
import { REVYL_KEEP_ALIVE_INTERVAL_MS } from './revyl-session.ts';

const openBackends: RevylFixtureBackend[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(openBackends.splice(0).map((fixture) => fixture.close()));
});

const KEEP_ALIVE = 'GET /api/v1/execution/device-proxy/run-1/appearance';

/** Waits until the fixture has recorded `count` keep-alive reads; the read is a real HTTP request. */
async function keepAlivesReach(fixture: RevylFixtureBackend, count: number): Promise<void> {
  await vi.waitFor(() => {
    assert.equal(fixture.paths().filter((path) => path === KEEP_ALIVE).length, count);
  });
}

test('a held session reads appearance on each keep-alive beat, and its release stops the beat', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const fixture = await startRevylFixtureBackend({
    respond: { [KEEP_ALIVE]: { body: { appearance: 'light' } } },
  });
  openBackends.push(fixture);
  const runtime = fixture.createRuntime();
  const lease = revylLease('ios');
  await runtime.leaseLifecycle?.allocate?.(lease);

  assert.equal(fixture.paths().includes(KEEP_ALIVE), false, 'no read before the first beat');
  vi.advanceTimersByTime(REVYL_KEEP_ALIVE_INTERVAL_MS);
  await keepAlivesReach(fixture, 1);
  vi.advanceTimersByTime(REVYL_KEEP_ALIVE_INTERVAL_MS);
  await keepAlivesReach(fixture, 2);

  await runtime.leaseLifecycle?.release?.(lease);
  vi.advanceTimersByTime(REVYL_KEEP_ALIVE_INTERVAL_MS * 3);
  assert.equal(fixture.paths().filter((path) => path === KEEP_ALIVE).length, 2);
});

test('a keep-alive read that finds the session gone stops the beat', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const fixture = await startRevylFixtureBackend({
    respond: { [KEEP_ALIVE]: { status: 404, body: { detail: 'Session not found' } } },
  });
  openBackends.push(fixture);
  const runtime = fixture.createRuntime();
  const lease = revylLease('android');
  await runtime.leaseLifecycle?.allocate?.(lease);

  vi.advanceTimersByTime(REVYL_KEEP_ALIVE_INTERVAL_MS);
  await keepAlivesReach(fixture, 1);
  await vi.waitFor(() => assert.equal(vi.getTimerCount(), 0));
  vi.advanceTimersByTime(REVYL_KEEP_ALIVE_INTERVAL_MS * 3);
  assert.equal(fixture.paths().filter((path) => path === KEEP_ALIVE).length, 1);
  await runtime.leaseLifecycle?.release?.(lease);
});

test('a failed keep-alive read leaves the session held and the next beat reads again', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const fixture = await startRevylFixtureBackend({
    respond: { [KEEP_ALIVE]: { status: 501, body: { detail: 'Unsupported on device' } } },
  });
  openBackends.push(fixture);
  const runtime = fixture.createRuntime();
  const lease = revylLease('android');
  await runtime.leaseLifecycle?.allocate?.(lease);

  vi.advanceTimersByTime(REVYL_KEEP_ALIVE_INTERVAL_MS);
  await keepAlivesReach(fixture, 1);
  vi.advanceTimersByTime(REVYL_KEEP_ALIVE_INTERVAL_MS);
  await keepAlivesReach(fixture, 2);
  const listed = await runtime.deviceInventoryProvider?.({
    leaseProvider: 'revyl',
    leaseId: lease.leaseId,
    platform: 'android',
  });
  assert.equal(listed?.length, 1);
  await runtime.leaseLifecycle?.release?.(lease);
});
