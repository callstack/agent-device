import { onTestFinished, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isReadOnlyRunnerCommand } from '../runner-command-traits.ts';
import { withRunnerCommandId } from '../runner-contract.ts';
import {
  resolveRunnerBuildDestination,
  resolveRunnerDestination,
} from '../apple-runner-platform.ts';
import {
  acquireRunnerXctestrunCacheLock,
  assertSafeDerivedCleanup,
  shouldDeleteRunnerDerivedRootEntry,
} from '../runner-cache.ts';
import {
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
} from '../runner-xctestrun.ts';
import { stubAppleToolchainProbes } from './apple-toolchain-fixtures.ts';
import {
  REPO_ROOT_FOR_TEST,
  makeScratchDir,
  withoutRunnerDerivedPathEnv,
} from './runner-xctestrun.fixtures.ts';

const iosSimulator: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone Simulator',
  kind: 'simulator',
  booted: true,
};

const iosDevice: DeviceInfo = {
  platform: 'apple',
  id: '00008110-000E12341234002E',
  name: 'iPhone',
  kind: 'device',
  booted: true,
};

const tvOsSimulator: DeviceInfo = {
  platform: 'apple',
  id: 'tv-sim-1',
  name: 'Apple TV',
  kind: 'simulator',
  target: 'tv',
  booted: true,
};

const tvOsDevice: DeviceInfo = {
  platform: 'apple',
  id: '00008120-000E12341234003F',
  name: 'Apple TV',
  kind: 'device',
  target: 'tv',
  booted: true,
};

const macOsDevice: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

const repoRoot = REPO_ROOT_FOR_TEST;

// These cases key the cache without building it, so they answer the cache's toolchain probes
// from a fixed Xcode instead of the host's.
stubAppleToolchainProbes();

test('resolveRunnerDestination uses simulator destination for simulators', () => {
  assert.equal(resolveRunnerDestination(iosSimulator), 'platform=iOS Simulator,id=sim-1');
});

test('withRunnerCommandId replaces blank command ids', () => {
  const command = withRunnerCommandId({ command: 'uptime', commandId: '   ' });

  assert.match(command.commandId ?? '', /^runner-/);
});

test('withRunnerCommandId preserves existing command ids', () => {
  const command = withRunnerCommandId({ command: 'uptime', commandId: 'runner-existing' });

  assert.deepEqual(command, { command: 'uptime', commandId: 'runner-existing' });
});

test('scroll is a mutating, command-id-tracked runner command', () => {
  // Runner command traits classify fused scroll as mutating, routing it through single-send
  // (no transport retry), command-id tracking, and status recovery.
  assert.equal(isReadOnlyRunnerCommand({ command: 'scroll' }), false);

  const command = withRunnerCommandId({ command: 'scroll', direction: 'down', pixels: 120 });
  assert.match(command.commandId ?? '', /^runner-/);
});

test('desktopScroll is a mutating, command-id-tracked runner command', () => {
  assert.equal(isReadOnlyRunnerCommand({ command: 'desktopScroll' }), false);

  const command = withRunnerCommandId({
    command: 'desktopScroll',
    direction: 'down',
    pixels: 120,
  });
  assert.match(command.commandId ?? '', /^runner-/);
});

test('withRunnerCommandId does not add command ids to status probes', () => {
  const command = withRunnerCommandId({
    command: 'status',
    statusCommandId: 'runner-command-1',
  });

  assert.deepEqual(command, { command: 'status', statusCommandId: 'runner-command-1' });
});

test('resolveRunnerDestination uses device destination for physical devices', () => {
  assert.equal(resolveRunnerDestination(iosDevice), 'platform=iOS,id=00008110-000E12341234002E');
});

test('resolveRunnerBuildDestination uses generic iOS destination for physical devices', () => {
  assert.equal(resolveRunnerBuildDestination(iosDevice), 'generic/platform=iOS');
});

test('resolveRunnerDestination uses tvOS simulator destination for tvOS simulators', () => {
  assert.equal(resolveRunnerDestination(tvOsSimulator), 'platform=tvOS Simulator,id=tv-sim-1');
});

test('resolveRunnerDestination uses tvOS destination for tvOS devices', () => {
  assert.equal(resolveRunnerDestination(tvOsDevice), 'platform=tvOS,id=00008120-000E12341234003F');
});

test('resolveRunnerBuildDestination uses tvOS destinations for tvOS devices and simulators', () => {
  assert.equal(resolveRunnerBuildDestination(tvOsSimulator), 'platform=tvOS Simulator,id=tv-sim-1');
  assert.equal(resolveRunnerBuildDestination(tvOsDevice), 'generic/platform=tvOS');
});

test('assertSafeDerivedCleanup allows cleaning when no override is set', () => {
  assert.doesNotThrow(() => {
    assertSafeDerivedCleanup('/tmp/derived', {});
  });
});

test('assertSafeDerivedCleanup rejects cleaning override path by default', () => {
  assert.throws(() => {
    assertSafeDerivedCleanup('/tmp/custom', {
      AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: '/tmp/custom',
    });
  }, /Refusing to clean AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH automatically/);
});

test('assertSafeDerivedCleanup allows cleaning override path under project .tmp', () => {
  const derivedPath = path.join(repoRoot, '.tmp', 'ios-runner-derived');
  assert.doesNotThrow(() => {
    assertSafeDerivedCleanup(derivedPath, {
      AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: derivedPath,
    });
  });
});

test('resolveRunnerDerivedPath keys default cache by runner metadata', () => {
  withoutRunnerDerivedPathEnv();
  const metadata = resolveExpectedRunnerCacheMetadata(iosSimulator, repoRoot);
  const iosPath = resolveRunnerDerivedPath(iosSimulator, metadata);
  const tvPath = resolveRunnerDerivedPath(tvOsSimulator, {
    ...metadata,
    platformName: 'tvOS',
    target: 'tv',
    buildDestinationFamily: 'appletvsimulator',
  });
  const macPath = resolveRunnerDerivedPath(macOsDevice, {
    ...metadata,
    platformName: 'macOS',
    target: 'desktop',
    buildDestinationFamily: 'macos',
  });
  const unitTestPath = resolveRunnerDerivedPath(iosSimulator, {
    ...metadata,
    runnerSandboxBuildArgs: metadata.runnerSandboxBuildArgs.map((arg) =>
      arg.startsWith('OTHER_SWIFT_FLAGS=')
        ? 'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_UNIT_TESTS'
        : arg,
    ),
  });

  assert.match(iosPath, /\/apple-runner\/derived\/ios-simulator\/cache-[a-f0-9]{16}$/);
  assert.match(tvPath, /\/apple-runner\/derived\/tvos-simulator\/cache-[a-f0-9]{16}$/);
  assert.match(macPath, /\/apple-runner\/derived\/macos\/cache-[a-f0-9]{16}$/);
  assert.notEqual(iosPath, unitTestPath);
});

test('resolveRunnerDerivedPath reuses cache path for identical runner source fingerprints', async () => {
  withoutRunnerDerivedPathEnv();
  const tmpDir = await makeScratchDir();
  const firstRoot = path.join(tmpDir, 'first');
  const secondRoot = path.join(tmpDir, 'second');
  const runnerRelativePath = path.join(
    'apple',
    'runner',
    'AgentDeviceRunner',
    'AgentDeviceRunnerUITests',
    'RunnerTests.swift',
  );
  await fs.promises.mkdir(path.dirname(path.join(firstRoot, runnerRelativePath)), {
    recursive: true,
  });
  await fs.promises.mkdir(path.dirname(path.join(secondRoot, runnerRelativePath)), {
    recursive: true,
  });
  await fs.promises.writeFile(
    path.join(firstRoot, runnerRelativePath),
    'final class RunnerTests {}\n',
  );
  await fs.promises.writeFile(
    path.join(secondRoot, runnerRelativePath),
    'final class RunnerTests {}\n',
  );

  const firstPath = resolveRunnerDerivedPath(
    iosSimulator,
    resolveExpectedRunnerCacheMetadata(iosSimulator, firstRoot),
  );
  const secondPath = resolveRunnerDerivedPath(
    iosSimulator,
    resolveExpectedRunnerCacheMetadata(iosSimulator, secondRoot),
  );
  await fs.promises.writeFile(
    path.join(secondRoot, runnerRelativePath),
    'final class RunnerTests { let changed = true }\n',
  );
  const changedPath = resolveRunnerDerivedPath(
    iosSimulator,
    resolveExpectedRunnerCacheMetadata(iosSimulator, secondRoot),
  );

  assert.equal(firstPath, secondPath);
  assert.notEqual(firstPath, changedPath);
});

test('acquireRunnerXctestrunCacheLock serializes cache access across acquirers', async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const tmpDir = await makeScratchDir();
  const derivedPath = path.join(tmpDir, 'derived');
  const releaseFirst = await acquireRunnerXctestrunCacheLock(derivedPath);
  let secondAcquired = false;
  const second = acquireRunnerXctestrunCacheLock(derivedPath).then(async (releaseSecond) => {
    secondAcquired = true;
    await releaseSecond();
  });

  assert.equal(secondAcquired, false);
  await releaseFirst();
  await vi.advanceTimersByTimeAsync(100);
  await second;
  assert.equal(secondAcquired, true);
});

test('shouldDeleteRunnerDerivedRootEntry only removes known xcode transient entries', () => {
  assert.equal(shouldDeleteRunnerDerivedRootEntry('Build'), true);
  assert.equal(shouldDeleteRunnerDerivedRootEntry('Logs'), true);
  assert.equal(shouldDeleteRunnerDerivedRootEntry('Index.noindex'), true);
  assert.equal(shouldDeleteRunnerDerivedRootEntry('device'), false);
  assert.equal(shouldDeleteRunnerDerivedRootEntry('macos'), false);
  assert.equal(shouldDeleteRunnerDerivedRootEntry('visionos'), false);
});
