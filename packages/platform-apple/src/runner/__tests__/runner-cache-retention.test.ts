import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  acquireRunnerXctestrunCacheLock,
  resolveRunnerCacheMetadataPath,
} from '../runner-cache.ts';
import { evictStaleRunnerCaches, resolveRunnerCacheKeepCount } from '../runner-cache-retention.ts';
import { ensureXctestrunArtifact } from '../runner-xctestrun.ts';
import {
  cleanupRunnerLeasesForOwner,
  writeRunnerLease,
  type RunnerLease,
} from '../runner-lease.ts';
import { appleToolchainProbeResult } from './apple-toolchain-fixtures.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { seedRunnerProductBundle } from './runner-xctestrun.fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

const DAY_MS = 24 * 60 * 60_000;
const NOW_MS = Date.parse('2026-10-05T12:00:00Z');

let base: string;
let previousLeaseDir: string | undefined;
let previousDerivedOverride: string | undefined;

beforeEach(() => {
  base = mkdtempForTestSync('agent-device-runner-retention-');
  previousLeaseDir = process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync('agent-device-lease-root-');
  previousDerivedOverride = process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  delete process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP;
});

afterEach(() => {
  restoreEnv('AGENT_DEVICE_IOS_RUNNER_LEASE_DIR', previousLeaseDir);
  restoreEnv('AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH', previousDerivedOverride);
  delete process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP;
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A cache key as a build leaves it: products plus the metadata file reuse touches. */
function seedKey(name: string, idleDays: number | null): string {
  const derived = path.join(base, name);
  fs.mkdirSync(path.join(derived, 'Build', 'Products'), { recursive: true });
  if (idleDays !== null) {
    const metadataPath = resolveRunnerCacheMetadataPath(derived);
    fs.writeFileSync(metadataPath, '{}');
    const usedAt = new Date(NOW_MS - idleDays * DAY_MS);
    fs.utimesSync(metadataPath, usedAt, usedAt);
  }
  return derived;
}

function key(index: number): string {
  return `cache-${index.toString(16).padStart(16, '0')}`;
}

function remaining(): string[] {
  return fs
    .readdirSync(base)
    .filter((name) => !name.endsWith('.lock'))
    .sort();
}

function leaseFor(derived: string, overrides: Partial<RunnerLease>): RunnerLease {
  return {
    schemaVersion: 1,
    deviceId: 'SIM-1',
    ownerToken: 'owner-1',
    ownerPid: 4242,
    ownerStartTime: null,
    sessionId: 'session-1',
    runnerPid: null,
    port: 8100,
    xctestrunPath: path.join(derived, 'Build', 'Products', 'Runner.xctestrun'),
    jsonPath: path.join(derived, 'runner.json'),
    createdAtMs: NOW_MS,
    ...overrides,
  };
}

test('keeps the current key and the most recently used keys up to the keep count, evicts the idle rest', async () => {
  const current = seedKey(key(1), 40);
  seedKey(key(2), 2);
  seedKey(key(3), 3);
  seedKey(key(4), 4);
  seedKey(key(5), 5);
  seedKey(key(6), 30);
  process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP = '4';

  const evicted = await evictStaleRunnerCaches(current, process.env, NOW_MS);

  assert.deepEqual(remaining(), [key(1), key(2), key(3), key(4)]);
  assert.deepEqual(evicted.map((entry) => path.basename(entry)).sort(), [key(5), key(6)]);
});

test('keeps a key used within a day even when it ranks past the keep count', async () => {
  process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP = '1';
  const current = seedKey(key(1), 0);
  seedKey(key(2), 0.5);
  seedKey(key(3), 2);

  await evictStaleRunnerCaches(current, process.env, NOW_MS);

  assert.deepEqual(remaining(), [key(1), key(2)]);
});

test('evicts aborted-build stubs that carry no metadata', async () => {
  process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP = '1';
  const current = seedKey(key(1), 0);
  seedKey(key(2), null);

  await evictStaleRunnerCaches(current, process.env, NOW_MS);

  assert.deepEqual(remaining(), [key(1)]);
});

test('leaves entries that are not keyed cache directories alone', async () => {
  process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP = '1';
  const current = seedKey(key(1), 0);
  seedKey(key(2), 30);
  fs.mkdirSync(path.join(base, 'Build'));
  fs.mkdirSync(path.join(base, 'cache-notahash'));
  fs.writeFileSync(path.join(base, key(3)), 'a file named like a key');

  await evictStaleRunnerCaches(current, process.env, NOW_MS);

  assert.deepEqual(remaining(), ['Build', key(1), key(3), 'cache-notahash'].sort());
});

test('keeps a key whose build lock is held', async () => {
  process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP = '1';
  const current = seedKey(key(1), 0);
  const building = seedKey(key(2), 30);
  seedKey(key(3), 30);
  const release = await acquireRunnerXctestrunCacheLock(building);

  try {
    await evictStaleRunnerCaches(current, process.env, NOW_MS);
    assert.deepEqual(remaining(), [key(1), key(2)]);
  } finally {
    await release();
  }
});

test('keeps a key a lease not proven dead points at, by path or cache key, and evicts one only a dead lease points at', async () => {
  process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP = '1';
  const current = seedKey(key(1), 0);
  const live = seedKey(key(2), 30);
  const dead = seedKey(key(3), 30);
  const handedOff = seedKey(key(4), 30);
  const envDirLease = seedKey(key(5), 30);
  const recycled = seedKey(key(6), 30);
  const stateDirGone = seedKey(key(7), 30);
  appleRunnerTestHost.update({
    classifyOwnerLiveness: ({ owner }) => {
      if (owner.pid === 4242) return 'live';
      if (owner.pid === 4245) return 'owner-state-dir-gone';
      if (owner.pid === 9001)
        return owner.startTime === 'runner-start' ? 'live' : 'owner-process-reused';
      if (owner.pid === 9002) return 'owner-process-reused';
      return 'owner-process-dead';
    },
  });
  writeRunnerLease(leaseFor(live, { deviceId: 'SIM-LIVE', ownerPid: 4242 }));
  writeRunnerLease(leaseFor(stateDirGone, { deviceId: 'SIM-DIR-GONE', ownerPid: 4245 }));
  writeRunnerLease(
    leaseFor(recycled, {
      deviceId: 'SIM-RECYCLED',
      ownerPid: 4246,
      runnerPid: 9002,
      runnerStartTime: 'old-start',
    }),
  );
  writeRunnerLease(leaseFor(dead, { deviceId: 'SIM-DEAD', ownerPid: 4243 }));
  writeRunnerLease(
    leaseFor(handedOff, {
      deviceId: 'SIM-HANDED-OFF',
      ownerPid: 4244,
      runnerPid: 9001,
      runnerStartTime: 'runner-start',
    }),
  );

  writeRunnerLease(
    leaseFor(envDirLease, {
      deviceId: 'SIM-ENV-DIR',
      ownerPid: 4242,
      cacheKey: key(5),
      xctestrunPath: path.join(base, 'env-dir', 'Runner.env.xctestrun'),
    }),
  );

  await evictStaleRunnerCaches(current, process.env, NOW_MS);

  assert.deepEqual(remaining(), [key(1), key(2), key(4), key(5), key(7)]);
});

test('evicts nothing when the lease directory cannot be listed', async () => {
  process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP = '1';
  const current = seedKey(key(1), 0);
  seedKey(key(2), 30);
  const leaseRoot = path.join(base, 'leases-is-a-file');
  fs.writeFileSync(leaseRoot, 'not a directory');
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = leaseRoot;

  assert.deepEqual(await evictStaleRunnerCaches(current, process.env, NOW_MS), []);
  assert.deepEqual(remaining(), [key(1), key(2), 'leases-is-a-file'].sort());
});

test('evicts nothing when one lease file cannot be read', async () => {
  process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP = '1';
  const current = seedKey(key(1), 0);
  seedKey(key(2), 30);
  const leaseRoot = process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR!;
  const unreadable = path.join(leaseRoot, 'unreadable.json');
  fs.writeFileSync(unreadable, '{}');
  fs.chmodSync(unreadable, 0o000);

  assert.deepEqual(await evictStaleRunnerCaches(current, process.env, NOW_MS), []);
  assert.deepEqual(remaining(), [key(1), key(2)]);
});

test('owner cleanup still stops a readable lease next to an unreadable lease file', async () => {
  const owned = leaseFor(seedKey(key(1), 0), { ownerPid: 4242, ownerStartTime: null });
  writeRunnerLease(owned);
  const unreadable = path.join(process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR!, 'a-unreadable.json');
  fs.writeFileSync(unreadable, '{}');
  fs.chmodSync(unreadable, 0o000);
  const cleanupTempFile = vi.fn(async () => {});

  await cleanupRunnerLeasesForOwner(
    { pid: 4242, startTime: null },
    {
      cleanupRunnerProcessTree: async () => {},
      cleanupRunnerXcodebuildProcesses: async () => {},
      cleanupTempFile,
    },
  );

  assert.deepEqual(cleanupTempFile.mock.calls, [[owned.xctestrunPath], [owned.jsonPath]]);
});

test('a keep count of 0 turns eviction off', async () => {
  process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP = '0';
  const current = seedKey(key(1), 0);
  seedKey(key(2), 30);

  assert.deepEqual(await evictStaleRunnerCaches(current, process.env, NOW_MS), []);
  assert.deepEqual(remaining(), [key(1), key(2)]);
});

test('a derived path override is not a keyed cache root and is never swept', async () => {
  process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = base;
  const current = seedKey(key(1), 0);
  seedKey(key(2), 30);
  seedKey(key(3), 30);
  seedKey(key(4), 30);
  seedKey(key(5), 30);

  assert.deepEqual(await evictStaleRunnerCaches(current, process.env, NOW_MS), []);
  assert.equal(remaining().length, 5);
});

test('the keep count falls back to 3 for anything but a non-negative integer', () => {
  assert.equal(resolveRunnerCacheKeepCount({}), 3);
  assert.equal(resolveRunnerCacheKeepCount({ AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP: '5' }), 5);
  assert.equal(resolveRunnerCacheKeepCount({ AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP: '0' }), 0);
  for (const invalid of ['-1', '2.5', 'many', '']) {
    assert.equal(
      resolveRunnerCacheKeepCount({ AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP: invalid }),
      3,
      invalid,
    );
  }
});

test('building a new runner cache key sweeps the keys beside it', async () => {
  resetAllProcessMemosForTests();
  const projectRoot = mkdtempForTestSync('agent-device-runner-retention-root-');
  fs.mkdirSync(
    path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner', 'AgentDeviceRunner.xcodeproj'),
    { recursive: true },
  );
  process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP = '1';
  const runCmdStreaming = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
    const symroot = args.find((arg) => arg.startsWith('SYMROOT='))!.slice('SYMROOT='.length);
    await seedRunnerProductBundle(path.join(symroot, 'Debug-iphonesimulator', 'Runner.app'));
    fs.writeFileSync(
      path.join(symroot, 'Runner_iphonesimulator27.0-arm64.xctestrun'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>ProductPaths</key><array>
<string>__TESTROOT__/Debug-iphonesimulator/Runner.app</string>
</array></dict></plist>`,
    );
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  appleRunnerTestHost.update({
    runCmdSync: vi.fn().mockImplementation(appleToolchainProbeResult),
    runCmdStreaming,
    findProjectRoot: () => projectRoot,
    readVersion: () => '0.0.0-test',
  });
  const home = process.env.HOME!;
  const simulatorBase = path.join(
    home,
    '.agent-device',
    'apple-runner',
    'derived',
    'ios-simulator',
  );
  base = simulatorBase;
  const stale = seedKey(key(7), 30);
  const unrelatedPlatform = path.join(path.dirname(simulatorBase), 'macos', key(8));
  fs.mkdirSync(unrelatedPlatform, { recursive: true });

  const built = await ensureXctestrunArtifact(IOS_SIMULATOR, {});

  assert.equal(built.artifact, 'rebuilt');
  await vi.waitFor(() => assert.equal(fs.existsSync(stale), false));
  assert.equal(fs.existsSync(built.derived), true);
  assert.equal(fs.existsSync(unrelatedPlatform), true);
});

test('keeps a key that a runner reused after the listing, found fresh under the lock', async () => {
  process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP = '1';
  const current = seedKey(key(1), 0);
  seedKey(key(2), 5);
  const reused = seedKey(key(3), 9);
  const realRm = fs.promises.rm.bind(fs.promises);
  let touched = false;
  const rm = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
    if (!touched) {
      touched = true;
      const usedAt = new Date(NOW_MS);
      fs.utimesSync(resolveRunnerCacheMetadataPath(reused), usedAt, usedAt);
    }
    return realRm(target, options);
  });
  try {
    const evicted = await evictStaleRunnerCaches(current, process.env, NOW_MS);
    assert.deepEqual(
      evicted.map((entry) => path.basename(entry)),
      [key(2)],
    );
  } finally {
    rm.mockRestore();
  }

  assert.deepEqual(remaining(), [key(1), key(3)]);
});
