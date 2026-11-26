import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  cacheRemoteDaemonHealth,
  cachedRemoteHealth,
  invalidateRemoteDaemonHealth,
  readCachedRemoteHealth,
} from '../daemon-client-remote-health-cache.ts';
import type { RemoteDaemonHealth } from '../daemon-client-health-record.ts';

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

// The state dir holds one answer named by a digest of the daemon identity. A different token or URL,
// an unusable answer, or an unreadable file reads as a miss, so the caller probes.
test('persisted health is reused only for the identity that cached it', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-health-store-');
  const file = path.join(stateDir, 'remote-daemon-health.json');
  const info = { baseUrl: 'http://remote.example.test:7777', token: 'store-test', pid: 0 };
  const other = { ...info, token: 'other-token' };
  const forget = () => invalidateRemoteDaemonHealth(info);

  cacheRemoteDaemonHealth(info, { reachable: true }, stateDir);
  assert.equal(fs.existsSync(file), false, 'an answer without an instance is not persisted');

  cacheRemoteDaemonHealth(info, { ...HEALTHY, statusCode: 200, timedOut: true }, stateDir);
  forget();
  const reused = readCachedRemoteHealth(info, stateDir);
  assert.equal(reused?.reachable, true);
  assert.equal(reused?.instanceId, HEALTHY.instanceId);
  assert.equal(reused?.statusCode, undefined, 'only the record is persisted');
  assert.equal(reused?.timedOut, undefined);
  forget();
  assert.equal(readCachedRemoteHealth(other, stateDir), undefined);

  invalidateRemoteDaemonHealth(other, stateDir);
  assert.equal(fs.existsSync(file), true, 'another identity leaves the entry alone');
  invalidateRemoteDaemonHealth(info, stateDir);
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, '{not json');
  assert.equal(readCachedRemoteHealth(info, stateDir), undefined);
});
