import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  cachedRemoteHealth,
  invalidateRemoteDaemonHealth,
} from '../daemon-client-remote-health-cache.ts';
import type { RemoteDaemonHealth } from '../daemon-client-transport.ts';

const HEALTHY: RemoteDaemonHealth = { reachable: true, instanceId: 'remote-instance' };

// An invalidation that lands while a probe is in flight wins: the probe's answer is returned to its
// caller but not cached, so the next caller probes again instead of reading a stale answer.
test('a probe answer that lands after an invalidation is not cached', async () => {
  const info = { baseUrl: 'http://remote.example.test:7777', token: 'cache-test', pid: 0 };
  let answer: (health: RemoteDaemonHealth) => void = () => {};
  const inFlight = cachedRemoteHealth(
    info,
    () => new Promise<RemoteDaemonHealth>((resolve) => (answer = resolve)),
  );
  invalidateRemoteDaemonHealth(info);
  answer(HEALTHY);
  assert.deepEqual(await inFlight, HEALTHY);

  let probes = 0;
  const next = await cachedRemoteHealth(info, async () => {
    probes += 1;
    return HEALTHY;
  });
  assert.deepEqual(next, HEALTHY);
  assert.equal(probes, 1, 'the stale answer was not cached');
  // The closest negative: with no invalidation in flight, that usable answer is cached.
  await cachedRemoteHealth(info, async () => {
    probes += 1;
    return HEALTHY;
  });
  assert.equal(probes, 1);
});
