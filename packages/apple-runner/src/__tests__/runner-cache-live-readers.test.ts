import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, onTestFinished, test, vi } from 'vitest';
import type { ExecResult } from '@agent-device/host-kit/command';
import { appleRunnerTestHost } from '../test-host.ts';
import { ensureXctestrunArtifact } from '../runner-artifact.ts';
import { markRunnerXctestrunArtifactBadForRun } from '../runner-cache.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import {
  REPO_ROOT_FOR_TEST,
  withoutRunnerDerivedPathEnv,
  writeXctestrunFixture,
} from './runner-xctestrun.fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

// Two sessions share one keyed runner cache entry. A session that indicts the entry and rebuilds it
// must leave every file the other session resolved in place: that session may be mid-launch from
// them. The apple-runner project gives each test file its own HOME, so the key is this file's own.

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
  const launching = await ensureXctestrunArtifact(IOS_SIMULATOR, {});
  assert.equal(launching.artifact, 'valid');
  const launchingTree = readTree(path.dirname(launching.xctestrunPath));

  await markRunnerXctestrunArtifactBadForRun(launching, 'runner health failed twice');
  const rebuilt = await ensureXctestrunArtifact(IOS_SIMULATOR, {
    forceRunnerXctestrunRebuild: true,
  });

  assert.equal(rebuilt.artifact, 'rebuilt');
  assert.notEqual(path.dirname(rebuilt.xctestrunPath), path.dirname(launching.xctestrunPath));
  assert.deepEqual(readTree(path.dirname(launching.xctestrunPath)), launchingTree);
});

test('two sessions rebuilding one entry keep each other’s fresh tree', async () => {
  withoutRunnerDerivedPathEnv();
  const first = removeCacheEntryAfterTest(await ensureXctestrunArtifact(IOS_SIMULATOR, {}));
  const second = await ensureXctestrunArtifact(IOS_SIMULATOR, {});

  await markRunnerXctestrunArtifactBadForRun(first, 'runner health failed twice');
  const firstRebuilt = await ensureXctestrunArtifact(IOS_SIMULATOR, {
    forceRunnerXctestrunRebuild: true,
  });
  const firstRebuiltTree = readTree(path.dirname(firstRebuilt.xctestrunPath));
  await markRunnerXctestrunArtifactBadForRun(second, 'runner health failed twice');
  const secondRebuilt = await ensureXctestrunArtifact(IOS_SIMULATOR, {
    forceRunnerXctestrunRebuild: true,
  });

  assert.equal(secondRebuilt.artifact, 'rebuilt');
  assert.deepEqual(readTree(path.dirname(firstRebuilt.xctestrunPath)), firstRebuiltTree);
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
