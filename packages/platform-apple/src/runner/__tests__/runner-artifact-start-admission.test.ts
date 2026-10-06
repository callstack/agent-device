import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import type { ExecResult } from '@agent-device/host-kit/command';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  addRunnerStartWaiter,
  cancelRunnerStartWaiter,
  ensureXctestrunArtifact,
  fenceRunnerStartAdmissionsForTeardown,
  openRunnerStartAdmission,
  runnerStartAdmitsPreparation,
} from '../runner-xctestrun.ts';
import { appleToolchainProbeResult } from './apple-toolchain-fixtures.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { seedRunnerProductBundle } from './runner-xctestrun.fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

// The preparation-spawn seam of #3220: admission is read immediately before `xcodebuild
// build-for-testing` is created, so a start whose device went down never answers the kill with
// a replacement build. The tests drive `ensureXctestrunArtifact` with a stand-in `xcodebuild`
// so the gate is proven at the spawn itself, not at a mock above it.

const runCmdStreaming = vi.fn();
let projectRoot: string;
let derived: string;

beforeEach(() => {
  projectRoot = mkdtempForTestSync('agent-device-start-admission-root-');
  fs.mkdirSync(
    path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner', 'AgentDeviceRunner.xcodeproj'),
    { recursive: true },
  );
  derived = mkdtempForTestSync('agent-device-start-admission-derived-');
  process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = derived;
  runCmdStreaming.mockReset();
  appleRunnerTestHost.update({
    runCmdSync: vi.fn().mockImplementation(appleToolchainProbeResult),
    runCmdStreaming,
    findProjectRoot: () => projectRoot,
    readVersion: () => '0.0.0-test',
  });
});

afterEach(() => {
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
});

/**
 * The cold-build retry of the incident: a teardown kills the first `build-for-testing` before it
 * ever takes the session lock, and the retired start re-enters to build again. The second spawn
 * is what made close wait out its timeout, and it is exactly what the pre-spawn gate refuses —
 * the child that would be the replacement never exists.
 */
test('a start whose device was torn down spawns no replacement build after its first was killed', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-admission-retry-sim' };
  const admission = openRunnerStartAdmission(device.id);
  let killFirstBuild: () => void = () => {};
  const firstBuildKilled = new Promise<void>((resolve) => {
    killFirstBuild = resolve;
  });
  runCmdStreaming.mockImplementationOnce(() => {
    killFirstBuild();
    // What a killed build surfaces as at this seam: the exec layer rejects once the tree was
    // signaled, and the start's retry re-enters from here.
    return Promise.reject(new Error('Command was aborted'));
  });

  const firstStart = ensureXctestrunArtifact(device, { startAdmission: admission }).catch(
    (error: unknown) => error,
  );
  await firstBuildKilled;
  // The teardown fences the device and lifts once it settles. The start's own verdict survives
  // that: the retry which re-enters with a closed admission is the replacement build #3220 is
  // about, so it stays refused.
  fenceRunnerStartAdmissionsForTeardown(device.id)();

  const failure = await firstStart;
  assert.equal(runCmdStreaming.mock.calls.length, 1, 'the killed build was the only spawn');
  assert.ok(failure instanceof Error, 'the killed build failed its start');

  // The health retry the incident measured: same start, same options, after the kill.
  const retry = await ensureXctestrunArtifact(device, {
    startAdmission: admission,
  }).catch((error: unknown) => error);

  assert.ok(isRequestCanceledError(retry), 'the fenced start fails as a canceled start');
  assert.equal(runCmdStreaming.mock.calls.length, 1, 'no replacement build was spawned');
});

/**
 * The nearest negative: the same retry on a device no teardown touched must still build. A
 * guard that refused preparation on any hint of a prior failure would pass the case above and
 * break every cold start.
 */
test('a start nobody retired still builds after a killed build', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-admission-survivor-sim' };
  const admission = openRunnerStartAdmission(device.id);
  runCmdStreaming
    .mockResolvedValueOnce({ exitCode: 143, stdout: '', stderr: '' } satisfies ExecResult)
    .mockImplementationOnce(async () => {
      await seedBuiltRunner();
      return { exitCode: 0, stdout: '', stderr: '' } satisfies ExecResult;
    });

  await assert.rejects(() => ensureXctestrunArtifact(device, { startAdmission: admission }));
  const rebuilt = await ensureXctestrunArtifact(device, { startAdmission: admission });

  assert.equal(runCmdStreaming.mock.calls.length, 2, 'the retry built the artifact');
  assert.equal(rebuilt.artifact, 'rebuilt');
});

/**
 * A device under a teardown admits preparation no start carried: the prewarm's own build. The
 * fence answers by device, so a build phase carrying no token is refused for the length of the
 * close that raised it (#3220).
 */
test('a fenced device admits a preparation that carries no start', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-admission-prewarm-sim' };
  const settleFence = fenceRunnerStartAdmissionsForTeardown(device.id);
  runCmdStreaming.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } satisfies ExecResult);

  try {
    const failure = await ensureXctestrunArtifact(device, {}).catch((error: unknown) => error);
    assert.ok(isRequestCanceledError(failure));
    assert.equal(runCmdStreaming.mock.calls.length, 0, 'the prewarm build was never spawned');
  } finally {
    settleFence();
  }
  assert.equal(
    runnerStartAdmitsPreparation(device.id),
    true,
    'the fence was the close: once it settles, preparation is admitted again',
  );
});

/**
 * The window #3193 left measured and open: a waiter cancels before the first prep child exists,
 * so a ledger sweep has nothing to stop and the build would simply start. The cancellation closes
 * admission, and the spawn that follows it is refused.
 */
test('a cancellation that arrives before the first prep spawn refuses the build that would follow', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-admission-early-cancel-sim' };
  const admission = openRunnerStartAdmission(device.id);
  const waiter = new AbortController();
  addRunnerStartWaiter(admission, waiter.signal);
  runCmdStreaming.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } satisfies ExecResult);

  assert.equal(cancelRunnerStartWaiter(admission, waiter.signal), true);
  const failure = await ensureXctestrunArtifact(device, { startAdmission: admission }).catch(
    (error: unknown) => error,
  );

  assert.ok(isRequestCanceledError(failure));
  assert.equal(runCmdStreaming.mock.calls.length, 0, 'the never-canceled build was never spawned');
});

/**
 * The nearest negative of the waiter rule, taken at the spawn seam: while another waiter is
 * still interested, a cancellation preserves the work — a start that asks next still builds.
 */
test('a spawn still admitted by a remaining waiter builds', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-admission-peer-waiter-sim' };
  const admission = openRunnerStartAdmission(device.id);
  addRunnerStartWaiter(admission, new AbortController().signal);
  const leaving = new AbortController();
  addRunnerStartWaiter(admission, leaving.signal);
  runCmdStreaming.mockImplementation(async () => {
    await seedBuiltRunner();
    return { exitCode: 0, stdout: '', stderr: '' } satisfies ExecResult;
  });

  assert.equal(cancelRunnerStartWaiter(admission, leaving.signal), false);
  const built = await ensureXctestrunArtifact(device, { startAdmission: admission });

  assert.equal(runCmdStreaming.mock.calls.length, 1, 'the surviving waiter kept the build alive');
  assert.equal(built.artifact, 'rebuilt');
});

/** Stands in for a successful `xcodebuild build-for-testing`: the products land under SYMROOT. */
async function seedBuiltRunner(): Promise<void> {
  const symroot = path.join(derived, 'Build', 'Products');
  await seedRunnerProductBundle(
    path.join(symroot, 'Debug-iphonesimulator', 'AgentDeviceRunner.app'),
  );
  fs.writeFileSync(
    path.join(
      symroot,
      'AgentDeviceRunner_AgentDeviceRunnerUITests_iphonesimulator27.0-arm64.xctestrun',
    ),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ProjectRootHint</key>
  <string>${projectRoot}</string>
  <key>ProductPaths</key>
  <array>
    <string>__TESTROOT__/Debug-iphonesimulator/AgentDeviceRunner.app</string>
  </array>
</dict>
</plist>`,
  );
}
