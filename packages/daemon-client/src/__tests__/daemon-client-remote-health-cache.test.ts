import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  cacheRemoteDaemonHealth,
  cachedRemoteHealth,
  invalidateRemoteDaemonHealth,
  readCachedRemoteHealth,
} from '../daemon-client-remote-health-cache.ts';
import {
  readCachedRemoteHealthRecord,
  type RemoteDaemonHealth,
} from '../daemon-client-transport.ts';

const clientVersion = vi.hoisted(() => ({ current: '1.0.0' }));
const rpcProtocol = vi.hoisted(() => ({ current: 3 }));
vi.mock('@agent-device/contracts/daemon-http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/contracts/daemon-http')>();
  return {
    ...actual,
    get DAEMON_RPC_PROTOCOL_VERSION() {
      return rpcProtocol.current;
    },
  };
});
vi.mock('@agent-device/host-kit/version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/version')>()),
  readVersion: () => clientVersion.current,
}));

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

// The state dir holds one answer named by a digest of client version, URL and token. It holds neither
// secret, and any other identity, an unusable answer or an unreadable file reads as a miss.
test('persisted health is private and reused only by the identity that cached it', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-health-store-');
  const store = { stateDir, readRecord: readCachedRemoteHealthRecord };
  const file = path.join(stateDir, 'remote-daemon-health.json');
  const info = { baseUrl: 'http://remote.example.test:7777', token: 'store-secret', pid: 0 };
  const forget = () => invalidateRemoteDaemonHealth(info);
  const reuse = (identity: typeof info) => {
    forget();
    return readCachedRemoteHealth(identity, store);
  };

  cacheRemoteDaemonHealth(info, { reachable: true }, stateDir);
  assert.equal(fs.existsSync(file), false, 'an answer without an instance is not persisted');

  cacheRemoteDaemonHealth(info, { ...HEALTHY, statusCode: 200, timedOut: true }, stateDir);
  const written = fs.readFileSync(file, 'utf8');
  assert.equal(written.includes('store-secret'), false, 'the token is never written');
  assert.equal(written.includes('remote.example.test'), false, 'the URL is never written');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const reused = reuse(info);
  assert.equal(reused?.instanceId, HEALTHY.instanceId);
  assert.equal(reused?.statusCode, undefined, 'only the record is persisted');

  assert.equal(reuse({ ...info, token: 'other-token' }), undefined);
  assert.equal(reuse({ ...info, baseUrl: 'http://other.example.test:7777' }), undefined);
  clientVersion.current = '9.9.9';
  assert.equal(reuse(info), undefined, 'a client upgrade probes again');
  clientVersion.current = '1.0.0';
  rpcProtocol.current = 4;
  assert.equal(reuse(info), undefined, 'another RPC protocol probes again');
  rpcProtocol.current = 3;

  invalidateRemoteDaemonHealth({ ...info, token: 'other-token' }, stateDir);
  assert.equal(fs.existsSync(file), true, 'another identity leaves the entry alone');
  invalidateRemoteDaemonHealth(info, stateDir);
  assert.equal(fs.existsSync(file), false);
});

// A shared state dir may hold an entry another user planted. Only a regular file this user owns and
// nobody else can write counts; anything else is a miss, and a FIFO does not block the read.
test.skipIf(process.platform === 'win32')('a planted persisted entry reads as a miss', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-health-planted-');
  const store = { stateDir, readRecord: readCachedRemoteHealthRecord };
  const file = path.join(stateDir, 'remote-daemon-health.json');
  const info = { baseUrl: 'http://remote.example.test:7777', token: 'planted', pid: 0 };
  cacheRemoteDaemonHealth(info, HEALTHY, stateDir);
  const entry = fs.readFileSync(file);
  const reuse = () => {
    invalidateRemoteDaemonHealth(info);
    return readCachedRemoteHealth(info, store);
  };
  assert.equal(
    reuse()?.instanceId,
    HEALTHY.instanceId,
    'the closest negative: our own entry counts',
  );

  fs.chmodSync(file, 0o620);
  assert.equal(reuse(), undefined, 'a group-writable entry');

  const elsewhere = path.join(stateDir, 'elsewhere.json');
  fs.writeFileSync(elsewhere, entry, { mode: 0o600 });
  fs.rmSync(file);
  fs.symlinkSync(elsewhere, file);
  assert.equal(reuse(), undefined, 'a link');

  fs.rmSync(file);
  execFileSync('mkfifo', [file]);
  assert.equal(reuse(), undefined, 'a FIFO');

  fs.rmSync(file);
  fs.writeFileSync(file, '{not json', { mode: 0o600 });
  assert.equal(reuse(), undefined, 'an unreadable entry');
});
