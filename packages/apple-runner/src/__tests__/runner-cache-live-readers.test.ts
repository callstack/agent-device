import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, onTestFinished, test, vi } from 'vitest';
import type { ExecResult } from '@agent-device/host-kit/command';
import { appleRunnerTestHost } from '../test-host.ts';
import { ensureXctestrunArtifact } from '../runner-artifact.ts';
import { markRunnerXctestrunArtifactBadForRun } from '../runner-cache.ts';
import { withRunnerLeaseLock, writeRunnerLease } from '../runner-lease.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import {
  REPO_ROOT_FOR_TEST,
  withoutRunnerDerivedPathEnv,
  writeXctestrunFixture,
} from './runner-xctestrun.fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

// Two sessions share one keyed runner cache entry. A session that indicts the entry and rebuilds it
// must leave every tree another session holds in place: that session may be mid-launch from it. The
// apple-runner project gives each test file its own HOME, so the key is this file's own.

/** A second device on the same cache key: its session never holds the first device's lease lock. */
const OTHER_SIMULATOR = { ...IOS_SIMULATOR, id: 'sim-2' };

const runCmdStreaming = vi.fn();
let builds = 0;

beforeEach(() => {
  vi.resetAllMocks();
  builds = 0;
  const previousLeaseDir = process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync('agent-device-lease-root-');
  runCmdStreaming.mockImplementation(xcodebuildIntoSymroot);
  appleRunnerTestHost.update({
    runCmdStreaming,
    readProcessStartTime: () => 'test-process-start',
  });
  return () => {
    if (previousLeaseDir === undefined) delete process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
    else process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = previousLeaseDir;
  };
});

test('a rebuild leaves the tree another session is launching from untouched', async () => {
  withoutRunnerDerivedPathEnv();
  removeCacheEntryAfterTest(await ensureXctestrunArtifact(IOS_SIMULATOR, {}));
  await withRunnerLeaseLock(IOS_SIMULATOR.id, async () => {
    const launching = await ensureXctestrunArtifact(IOS_SIMULATOR, {});
    assert.equal(launching.artifact, 'valid');
    const launchingTree = readTree(path.dirname(launching.xctestrunPath));

    await markRunnerXctestrunArtifactBadForRun(launching, 'runner health failed twice');
    const rebuilt = await ensureXctestrunArtifact(OTHER_SIMULATOR, {
      forceRunnerXctestrunRebuild: true,
    });

    assert.equal(rebuilt.artifact, 'rebuilt');
    assert.notEqual(path.dirname(rebuilt.xctestrunPath), path.dirname(launching.xctestrunPath));
    assert.deepEqual(readTree(path.dirname(launching.xctestrunPath)), launchingTree);
  });
});

test('two sessions rebuilding one entry keep each other’s fresh tree', async () => {
  withoutRunnerDerivedPathEnv();
  const first = removeCacheEntryAfterTest(await ensureXctestrunArtifact(IOS_SIMULATOR, {}));
  const second = await ensureXctestrunArtifact(OTHER_SIMULATOR, {});

  await markRunnerXctestrunArtifactBadForRun(first, 'runner health failed twice');
  await withRunnerLeaseLock(IOS_SIMULATOR.id, async () => {
    const firstRebuilt = await ensureXctestrunArtifact(IOS_SIMULATOR, {
      forceRunnerXctestrunRebuild: true,
    });
    const firstRebuiltTree = readTree(path.dirname(firstRebuilt.xctestrunPath));
    await markRunnerXctestrunArtifactBadForRun(second, 'runner health failed twice');
    const secondRebuilt = await ensureXctestrunArtifact(OTHER_SIMULATOR, {
      forceRunnerXctestrunRebuild: true,
    });

    assert.equal(secondRebuilt.artifact, 'rebuilt');
    assert.deepEqual(readTree(path.dirname(firstRebuilt.xctestrunPath)), firstRebuiltTree);
  });
});

test('a launch holds its tree past any time window, until it lets go', async () => {
  withoutRunnerDerivedPathEnv();
  removeCacheEntryAfterTest(await ensureXctestrunArtifact(IOS_SIMULATOR, {}));
  const launching = await withRunnerLeaseLock(IOS_SIMULATOR.id, async () => {
    const resolved = await ensureXctestrunArtifact(IOS_SIMULATOR, {});
    // The launch stalls ten minutes in plist preparation, and nothing touches its tree meanwhile.
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(path.dirname(resolved.xctestrunPath), anHourAgo, anHourAgo);

    await markRunnerXctestrunArtifactBadForRun(resolved, 'runner health failed twice');
    await ensureXctestrunArtifact(OTHER_SIMULATOR, { forceRunnerXctestrunRebuild: true });
    assert.equal(fs.existsSync(resolved.xctestrunPath), true);
    return resolved;
  });

  await markRunnerXctestrunArtifactBadForRun(launching, 'runner health failed twice');
  await ensureXctestrunArtifact(OTHER_SIMULATOR, { forceRunnerXctestrunRebuild: true });
  assert.equal(fs.existsSync(path.dirname(launching.xctestrunPath)), false);
});

test('a hold whose owner is dead does not keep the tree', async () => {
  withoutRunnerDerivedPathEnv();
  removeCacheEntryAfterTest(await ensureXctestrunArtifact(IOS_SIMULATOR, {}));
  await withRunnerLeaseLock(IOS_SIMULATOR.id, async () => {
    const launching = await ensureXctestrunArtifact(IOS_SIMULATOR, {});
    appleRunnerTestHost.update({ classifyOwnerLiveness: () => 'owner-process-dead' });

    await markRunnerXctestrunArtifactBadForRun(launching, 'runner health failed twice');
    await ensureXctestrunArtifact(OTHER_SIMULATOR, { forceRunnerXctestrunRebuild: true });

    assert.equal(fs.existsSync(path.dirname(launching.xctestrunPath)), false);
  });
});

test('rebuilds that nobody holds leave only the current tree', async () => {
  withoutRunnerDerivedPathEnv();
  let artifact = removeCacheEntryAfterTest(await ensureXctestrunArtifact(IOS_SIMULATOR, {}));
  const productsRoot = path.join(artifact.derived, 'Build');

  for (let rebuild = 0; rebuild < 3; rebuild += 1) {
    await markRunnerXctestrunArtifactBadForRun(artifact, 'runner health failed twice');
    artifact = await ensureXctestrunArtifact(IOS_SIMULATOR, { forceRunnerXctestrunRebuild: true });
  }

  assert.equal(builds, 4);
  assert.deepEqual(fs.readdirSync(productsRoot), [
    path.basename(path.dirname(artifact.xctestrunPath)),
  ]);
});

test('a rebuild keeps a tree a live runner lease names', async () => {
  withoutRunnerDerivedPathEnv();
  const running = removeCacheEntryAfterTest(await ensureXctestrunArtifact(IOS_SIMULATOR, {}));
  const runningTree = path.dirname(running.xctestrunPath);
  writeRunnerLease({
    schemaVersion: 1,
    deviceId: IOS_SIMULATOR.id,
    ownerToken: 'owner-1',
    ownerPid: process.pid,
    ownerStartTime: 'test-process-start',
    sessionId: 'session-1',
    runnerPid: null,
    runnerStartTime: null,
    port: 8100,
    xctestrunPath: path.join(runningTree, 'AgentDeviceRunner.env.session-1.xctestrun'),
    jsonPath: path.join(runningTree, 'AgentDeviceRunner.env.session-1.json'),
    createdAtMs: Date.now(),
  });

  await markRunnerXctestrunArtifactBadForRun(running, 'runner health failed twice');
  await ensureXctestrunArtifact(IOS_SIMULATOR, { forceRunnerXctestrunRebuild: true });

  assert.equal(fs.existsSync(running.xctestrunPath), true);
});

test('a rebuild unlinks a symlinked cache key without touching what it points at', async () => {
  withoutRunnerDerivedPathEnv();
  const cached = removeCacheEntryAfterTest(await ensureXctestrunArtifact(IOS_SIMULATOR, {}));
  const outside = mkdtempForTestSync('agent-device-outside-cache-');
  const outsideFile = path.join(outside, 'keep.txt');
  fs.writeFileSync(outsideFile, 'not the cache\n');
  fs.rmSync(cached.derived, { recursive: true });
  fs.symlinkSync(outside, cached.derived);

  await markRunnerXctestrunArtifactBadForRun(cached, 'runner health failed twice');
  const rebuilt = await ensureXctestrunArtifact(IOS_SIMULATOR, {
    forceRunnerXctestrunRebuild: true,
  });

  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'not the cache\n');
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
  assert.equal(fs.lstatSync(rebuilt.derived).isDirectory(), true);
});

test('a start never returns a path through a symlinked cache key, even to a certified tree', async () => {
  withoutRunnerDerivedPathEnv();
  const cached = removeCacheEntryAfterTest(await ensureXctestrunArtifact(IOS_SIMULATOR, {}));
  const outside = path.join(mkdtempForTestSync('agent-device-outside-cache-'), 'key');
  fs.renameSync(cached.derived, outside);
  fs.symlinkSync(outside, cached.derived);
  const outsideTree = readTree(outside);

  const next = await ensureXctestrunArtifact(IOS_SIMULATOR, {});

  assert.equal(fs.lstatSync(next.derived).isDirectory(), true);
  assert.equal(fs.realpathSync(path.dirname(next.xctestrunPath)).startsWith(outside), false);
  assert.deepEqual(readTree(outside), outsideTree);
});

function removeCacheEntryAfterTest<T extends { derived: string }>(artifact: T): T {
  onTestFinished(() => fs.promises.rm(artifact.derived, { recursive: true, force: true }));
  return artifact;
}

/** Every file under `root` with its bytes, so a replaced file reads as a change. */
function readTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
  }
  return files;
}

/** Stands in for `xcodebuild build-for-testing`: each build lands distinct bytes under SYMROOT. */
async function xcodebuildIntoSymroot(_command: string, args: string[]): Promise<ExecResult> {
  const symroot = args.find((arg) => arg.startsWith('SYMROOT='))!.slice('SYMROOT='.length);
  builds += 1;
  const app = path.join(symroot, 'Debug-iphonesimulator', 'AgentDeviceRunner.app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'AgentDeviceRunner'), `build ${builds}\n`, { mode: 0o755 });
  writeXctestrunFixture(
    path.join(symroot, 'AgentDeviceRunner_AgentDeviceRunnerUITests_iphonesimulator.xctestrun'),
    {
      projectRoot: REPO_ROOT_FOR_TEST,
      productRelativePaths: ['Debug-iphonesimulator/AgentDeviceRunner.app'],
    },
  );
  return { exitCode: 0, stdout: '', stderr: '' };
}
