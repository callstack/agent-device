import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AppError, normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import {
  IOS_DEVICE_DEVELOPER_DISK_IMAGE_HINT,
  IOS_DEVICE_DEVELOPER_MODE_OFF_HINT,
} from '../../core/devicectl.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ExecResult } from '@agent-device/host-kit/command';
import { createRunnerPhaseBudget, ensureXctestrunArtifact } from '../runner-xctestrun.ts';
import {
  enrichRunnerStartupFailureWithDeviceStates,
  RUNNER_DEVICE_READINESS_FAILURE_REASONS,
  RUNNER_ERROR_RULES,
  classifyRunnerStartupFailure,
  RUNNER_STARTUP_FAILURE_REASONS,
  RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON,
  type RunnerStartupFailureReason,
} from '../runner-error-classification.ts';
import { assertDevToolsSecurityForIosRunner } from '../runner-dev-tools-security.ts';
import { appleToolchainProbeResult, STUBBED_APPLE_TOOLCHAIN } from './apple-toolchain-fixtures.ts';
import { IOS_DEVICE } from './device-fixtures.ts';
import {
  CAPTURED_SCOPED_SIMULATOR,
  RUNNER_STARTUP_FAILURE_FIXTURES,
  buildFixtureById,
  buildForTestingExecFailure,
  buildForTestingFixtures,
  type RunnerStartupFailureFixture,
} from './runner-startup-failure-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

/**
 * A `build-for-testing` failure used to reach the caller as prose only, so every consumer that
 * wanted to know *which* signing problem it was had to re-match the same substrings (#2680). These
 * cases drive each recorded output through the real build-failure catch and assert on the
 * normalized envelope: the code is `COMMAND_FAILED` for all of them, so `details.reason` is the
 * assertion, and the hint beside it has to be the hint the rule that named the reason carries.
 *
 * The envelope assertions are deliberate: `normalizeError` moves `hint`, `logPath` and
 * `diagnosticId` out of `details` to the top level, and it is called here with no `logPath`
 * fallback — a top-level `logPath` therefore proves the build catch put it there. The negative
 * cases matter just as much: argv, our own emitted reason, and wording without a typed fact behind
 * it must all stay unclassified.
 */

const CACHE_RECOVERY_HINT = /clean:xcuitest|apple-runner\/derived/;

/**
 * The phrase each reason's advice has to contain. Kept as text rather than as syntax because two of
 * them are quotations from `core/devicectl.ts`, and a fifth escaping helper for a prose remedy with
 * parentheses in it is not this suite's job.
 */
const HINT_FOR_REASON: Record<RunnerStartupFailureReason, string> = {
  bundle_identifier_already_registered: 'AGENT_DEVICE_IOS_BUNDLE_ID',
  signing_no_development_team: 'AGENT_DEVICE_IOS_TEAM_ID',
  signing_provisioning_profile_missing: 'AGENT_DEVICE_IOS_PROVISIONING_PROFILE',
  signing_unspecified: 'Automatic Signing',
  devtools_security_developer_mode_disabled: 'DevToolsSecurity -enable',
  simulator_set_destination_not_found: '-DVTSimulatorSetLocation',
  // Both device remedies are owned by `core/devicectl.ts` and travel on the device report, so this
  // table quotes them instead of restating them; `runner-device-readiness.test.ts` is where the
  // preflight publishing them is asserted.
  device_developer_mode_disabled: IOS_DEVICE_DEVELOPER_MODE_OFF_HINT,
  device_developer_disk_image_unavailable: IOS_DEVICE_DEVELOPER_DISK_IMAGE_HINT,
  build_failed_unclassified: 'clean:xcuitest',
};

const runCmdSync = vi.fn();
const runCmdStreaming = vi.fn();
const runAppleToolCommand = vi.fn();
const DIAGNOSTIC_ID = 'diag-build-failure-1';
let projectRoot: string;
let derivedPath: string;
let logPath: string;

beforeEach(() => {
  resetAllProcessMemosForTests();
  projectRoot = mkdtempForTestSync('agent-device-startup-failure-root-');
  // `buildXctestrunArtifact` refuses to start a build without the runner project.
  fs.mkdirSync(
    path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner', 'AgentDeviceRunner.xcodeproj'),
    { recursive: true },
  );
  derivedPath = mkdtempForTestSync('agent-device-startup-failure-derived-');
  logPath = path.join(derivedPath, 'runner.log');
  process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = derivedPath;
  runCmdSync.mockReset().mockImplementation(appleToolchainProbeResult);
  runCmdStreaming.mockReset().mockImplementation(async (): Promise<ExecResult> => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  }));
  runAppleToolCommand.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  appleRunnerTestHost.update({
    runCmdSync,
    runCmdStreaming,
    runAppleToolCommand,
    findProjectRoot: () => projectRoot,
    readVersion: () => '0.0.0-test',
  });
});

afterEach(() => {
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
});

for (const fixture of buildForTestingFixtures()) {
  test(`a build-for-testing failure publishes ${fixture.reason} for ${fixture.id}`, async () => {
    const envelope = await driveBuildFailure(fixture);

    assertFailureEnvelope(envelope, fixture);
    // The device's answer travels on the failure it explains, and on nothing else: a fixture with no
    // recorded device report must not grow one (#2683).
    assert.equal(envelope.details?.developerDiskImage, fixture.deviceReport?.developerDiskImage);
  });
}

/** The states of a phone whose developer disk image is down, as `preflightIosRunnerDeviceReadiness` reads them. */
const DEVICE_WITH_IMAGE_DOWN = {
  developerMode: 'enabled',
  developerDiskImage: 'unavailable',
  developerDiskImageHint: IOS_DEVICE_DEVELOPER_DISK_IMAGE_HINT,
} as const;

test('a command the host killed names no device cause even without the threaded fact', () => {
  // The install and launch steps fail with the exec's own timeout error, which no build catch has
  // wrapped, so the deadline has to be read off the error itself (#2690 review).
  const killed = new AppError('COMMAND_FAILED', 'xcodebuild timed out after 900000ms', {
    cmd: 'xcodebuild',
    timeoutMs: 900_000,
  });

  const enriched = enrichRunnerStartupFailureWithDeviceStates(
    killed,
    DEVICE_WITH_IMAGE_DOWN,
  ) as AppError;

  assert.equal(enriched.details?.reason, undefined);
  assert.equal(enriched.details?.hint, undefined);
  assert.equal(enriched.details?.developerDiskImage, 'unavailable');
});

test('the device speaking for a failure keeps the error that caused it', () => {
  const caused = new AppError(
    'COMMAND_FAILED',
    'xcodebuild build-for-testing failed',
    { reason: RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON },
    new Error('xcodebuild was killed by the host'),
  );

  const enriched = enrichRunnerStartupFailureWithDeviceStates(
    caused,
    DEVICE_WITH_IMAGE_DOWN,
  ) as AppError;

  assert.equal(enriched.details?.reason, 'device_developer_disk_image_unavailable');
  // The cause is what a reader of the daemon log follows to the command that actually died.
  assert.equal(enriched.cause, caused.cause);
});

/**
 * Every startup failure reaches a caller through one envelope: the typed reason in `details`, its hint
 * and the log path hoisted to top level by `normalizeError`, and the tool output still reachable
 * underneath for a human. The envelope is asserted per fixture rather than once because the reason and
 * the hint have to travel together for every recorded shape, not just for one of them.
 */
function assertFailureEnvelope(
  envelope: NormalizedError,
  fixture: RunnerStartupFailureFixture,
): void {
  assert.equal(envelope.code, 'COMMAND_FAILED');
  assert.ok(envelope.message.startsWith('xcodebuild build-for-testing failed'));
  assert.equal(envelope.details?.reason, fixture.reason);
  assert.ok(
    String(envelope.hint).includes(HINT_FOR_REASON[fixture.reason]),
    `the ${fixture.reason} hint must carry "${HINT_FOR_REASON[fixture.reason]}"`,
  );
  // No `logPath` was handed to `normalizeError`: the top-level value can only be the one the
  // build catch wrote into the error it throws.
  assert.equal(envelope.logPath, logPath);
  assert.equal(envelope.diagnosticId, DIAGNOSTIC_ID);
  // normalizeError hoists these out of `details`; a caller must read them at top level.
  assert.equal(envelope.details?.hint, undefined);
  assert.equal(envelope.details?.logPath, undefined);
  assert.equal(envelope.details?.diagnosticId, undefined);
  // Plumbing one catch leaves for the next, never for a caller: `reason` and `hint` already carry the
  // verdict these facts produced (#2690 review).
  assert.equal(envelope.details?.startupRuleMatched, undefined);
  assert.equal(envelope.details?.startupHostDeadlineHit, undefined);
  assertToolOutputReachable(envelope, fixture);
}

/**
 * The tool output stays reachable for a human reading the failure, redacted and length-bounded on the
 * way out — one more reason the reason is typed: classification happens before the truncation a caller
 * sees. A message-only failure carries no tool output to reach, which is exactly why the message is
 * part of the haystack.
 */
function assertToolOutputReachable(
  envelope: NormalizedError,
  fixture: RunnerStartupFailureFixture,
): void {
  if ((fixture.carrier ?? 'exec-details') === 'message-only') {
    assert.equal(envelope.details?.details, undefined);
    return;
  }
  const nestedDetails = envelope.details?.details as Record<string, unknown> | undefined;
  assert.match(String(nestedDetails?.stdout), /AgentDeviceRunner/);
}

test('every startup failure reason has a recorded fixture', () => {
  const reasonsWithFixtures = new Set(RUNNER_STARTUP_FAILURE_FIXTURES.map((f) => f.reason));

  assert.equal(reasonsWithFixtures.size, RUNNER_STARTUP_FAILURE_REASONS.length);
  for (const reason of RUNNER_STARTUP_FAILURE_REASONS) {
    assert.ok(reasonsWithFixtures.has(reason), `no fixture records the ${reason} reason`);
  }
});

test('every reason the classifier can name is produced by a rule row', () => {
  const reasonsFromRules = new Set(
    RUNNER_ERROR_RULES.flatMap((rule) => (rule.buildFailure ? [rule.buildFailure.reason] : [])),
  );

  for (const reason of RUNNER_STARTUP_FAILURE_REASONS) {
    // The catch-all is the classifier's own answer when no row matched, so it names no row.
    if (reason === RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON) continue;
    // The device-readiness members are named by the device's own states in
    // `runner-device-readiness.ts`, not by a rule row: no amount of tool text establishes them,
    // which is exactly why they are declared as a subset (#2683).
    if ((RUNNER_DEVICE_READINESS_FAILURE_REASONS as readonly string[]).includes(reason)) continue;
    assert.ok(reasonsFromRules.has(reason), `no rule row yields the ${reason} reason`);
  }
});

test('a scoped-set simulator xcodebuild cannot find names its set and the Xcode', async () => {
  const { udid, setWithoutUdid } = CAPTURED_SCOPED_SIMULATOR;
  const envelope = await driveBuildFailure(buildFixtureById('scoped-set-destination-not-found'));

  assert.equal(envelope.details?.reason, 'simulator_set_destination_not_found');
  assert.equal(envelope.details?.simulatorSetPath, setWithoutUdid);
  assert.equal(envelope.details?.xcodeVersion, STUBBED_APPLE_TOOLCHAIN.xcodeVersion);
  assert.equal(
    envelope.message,
    `xcodebuild build-for-testing failed: xcodebuild found no simulator ${udid} in simulator set ${setWithoutUdid} with Xcode ${STUBBED_APPLE_TOOLCHAIN.xcodeVersion}`,
  );
  const buildArgs = runCmdStreaming.mock.calls[0]?.[1] as string[];
  assert.ok(buildArgs.includes(`-DVTSimulatorSetLocation=${setWithoutUdid}`));
});

test('a default-set simulator xcodebuild cannot find names no simulator set', async () => {
  const envelope = await driveBuildFailure(buildFixtureById('default-set-destination-not-found'));

  assert.equal(envelope.details?.reason, RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON);
  assert.equal(envelope.details?.simulatorSetPath, undefined);
  assert.equal(envelope.message, 'xcodebuild build-for-testing failed');
  assert.doesNotMatch(String(envelope.hint), /DVTSimulatorSetLocation/);
  const buildArgs = runCmdStreaming.mock.calls[0]?.[1] as string[];
  assert.equal(
    buildArgs.some((arg) => arg.startsWith('-DVTSimulatorSetLocation')),
    false,
  );
});

test('an argv that names a provisioning profile is not evidence of a signing failure', async () => {
  // The exec reports the invocation we asked for in `details.args`. Reading the whole details bag
  // would let a caller's own pinned profile name the cause of an unrelated compile error and take
  // the cache-recovery hint with it (#2680).
  const argvFixture = buildFixtureById('argv-names-a-provisioning-profile');

  const envelope = await driveBuildFailure(argvFixture);

  assert.equal(envelope.details?.reason, RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON);
  assert.match(String(envelope.hint), CACHE_RECOVERY_HINT);
  assert.doesNotMatch(String(envelope.hint), /AGENT_DEVICE_IOS_PROVISIONING_PROFILE/);
});

test('a signing sentence that arrives only in the thrown message is still classified', async () => {
  // The catch wraps a non-AppError as `new AppError('COMMAND_FAILED', String(error))`, so the tool's
  // sentence can reach the classifier in the message with no details behind it (#2680).
  const messageOnly = buildFixtureById('requires-development-team-message-only');

  const envelope = await driveBuildFailure(messageOnly);

  assert.equal(envelope.details?.reason, 'signing_no_development_team');
  assert.match(String(envelope.hint), /AGENT_DEVICE_IOS_TEAM_ID/);
});

test('the failure the build catch publishes does not classify itself', async () => {
  // The wrapper carries `reason` and `hint` in its details. Re-running the classifier over it must
  // not read our own verdict back out of the bag the rules scan (#2680).
  const signingFixture = buildFixtureById('requires-development-team');
  const published = await runBuildCatch(() => buildForTestingExecFailure(signingFixture));

  const reclassified = classifyRunnerStartupFailure(published);

  assert.equal(reclassified.reason, RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON);
  assert.match(reclassified.hint, CACHE_RECOVERY_HINT);
});

test('an identical message without the typed host fact is not read as a DevToolsSecurity refusal', async () => {
  // The exact sentence the host probe throws, minus the typed `devToolsSecurityStatus` fact only the
  // probe publishes. Text alone must not activate the reason (#2680).
  const hostRefusal = await expectHostRefusal();
  const withoutFact = new AppError('COMMAND_FAILED', hostRefusal.message, {
    stdout: 'developer mode is disabled\n',
    stderr: '',
    exitCode: 65,
    processExitError: true,
  });

  const envelope = await driveBuildRejection(withoutFact);

  assert.equal(envelope.details?.reason, RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON);
  assert.match(String(envelope.hint), CACHE_RECOVERY_HINT);
  assert.doesNotMatch(String(envelope.hint), /DevToolsSecurity/);
});

test('an app identifier named without the availability fact is not read as a taken bundle id', async () => {
  const nearMiss: RunnerStartupFailureFixture = {
    ...buildFixtureById('app-id-not-available'),
    output:
      "error: App Identifier 'com.yourname.agentdevice.runner' is invalid (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
  };

  const envelope = await driveBuildFailure(nearMiss);

  assert.equal(envelope.details?.reason, RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON);
  assert.match(String(envelope.hint), CACHE_RECOVERY_HINT);
  assert.doesNotMatch(String(envelope.hint), /AGENT_DEVICE_IOS_BUNDLE_ID/);
});

test('a conflicting-settings failure is not answered with missing-profile advice', async () => {
  // The conflicting-settings line names a profile while explaining that the settings disagree. It
  // precedes the profile row and claims no cause of its own (#2680).
  const conflict = buildFixtureById('conflicting-provisioning-settings');

  const envelope = await driveBuildFailure(conflict);

  assert.equal(envelope.details?.reason, RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON);
  assert.match(String(envelope.hint), CACHE_RECOVERY_HINT);
  assert.doesNotMatch(String(envelope.hint), /AGENT_DEVICE_IOS_PROVISIONING_PROFILE/);
});

/**
 * Drives a recorded fixture through the two steps a real startup runs in order: the build catch turns
 * the tool's output into a typed reason, and the session's startup catch hands that failure to the
 * device enrichment step (#2690 review). Both are the production functions; nothing here re-implements
 * either.
 */
async function driveBuildFailure(fixture: RunnerStartupFailureFixture): Promise<NormalizedError> {
  const thrown = await runBuildCatch(() => buildForTestingExecFailure(fixture), fixture.device);
  return normalizeThrown(
    enrichRunnerStartupFailureWithDeviceStates(thrown, deviceStatesOf(fixture)),
  );
}

/** The states `preflightIosRunnerDeviceReadiness` would have handed the startup for this fixture. */
function deviceStatesOf(fixture: RunnerStartupFailureFixture | undefined) {
  if (!fixture?.deviceReport) return undefined;
  return {
    developerMode: fixture.deviceReport.developerMode,
    developerDiskImage: fixture.deviceReport.developerDiskImage,
    developerDiskImageHint: IOS_DEVICE_DEVELOPER_DISK_IMAGE_HINT,
  };
}

/** Drives a hand-built rejection through the same real build catch. */
async function driveBuildRejection(rejection: unknown): Promise<NormalizedError> {
  return normalizeThrown(await runBuildCatch(() => rejection));
}

async function runBuildCatch(
  buildRejection: () => unknown,
  device: DeviceInfo = IOS_DEVICE,
): Promise<unknown> {
  runCmdStreaming.mockReset().mockImplementation(async () => {
    throw buildRejection();
  });

  let caught: unknown;
  await assert.rejects(
    () =>
      ensureXctestrunArtifact(device, {
        logPath,
        budget: createRunnerPhaseBudget(120_000, undefined),
      }),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.ok(caught, 'the build-failure catch must throw');
  return caught;
}

function normalizeThrown(caught: unknown): NormalizedError {
  return normalizeError(caught, { diagnosticId: DIAGNOSTIC_ID });
}

async function expectHostRefusal(): Promise<AppError> {
  runAppleToolCommand.mockImplementation(async () => ({
    exitCode: 0,
    stdout: 'Developer mode is currently disabled for development tools.\n',
    stderr: '',
  }));

  let caught: unknown;
  await assert.rejects(
    () => assertDevToolsSecurityForIosRunner(IOS_DEVICE),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.ok(caught instanceof AppError);
  return caught;
}
