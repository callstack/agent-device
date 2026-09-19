import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AppError, normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import { appleRunnerTestHost } from '../test-host.ts';
import type { ExecResult } from '../host.ts';
import { createRunnerPhaseBudget, ensureXctestrunArtifact } from '../runner-xctestrun.ts';
import {
  RUNNER_ERROR_RULES,
  RUNNER_STARTUP_FAILURE_REASONS,
  RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON,
  type RunnerStartupFailureReason,
} from '../runner-contract.ts';
import { appleToolchainProbeResult } from './apple-toolchain-fixtures.ts';
import { IOS_DEVICE } from './device-fixtures.ts';
import {
  RUNNER_STARTUP_FAILURE_FIXTURES,
  buildForTestingExecError,
  buildForTestingFixtures,
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
 * `diagnosticId` out of `details` to the top level, so a reason that survives in `details` and a
 * hint that survives at top level are two different claims about where the error was built.
 */

const CACHE_RECOVERY_HINT = /clean:xcuitest|apple-runner\/derived/;

const HINT_FOR_REASON: Record<RunnerStartupFailureReason, RegExp> = {
  bundle_identifier_already_registered: /AGENT_DEVICE_IOS_BUNDLE_ID/,
  signing_no_development_team: /AGENT_DEVICE_IOS_TEAM_ID/,
  signing_provisioning_profile_missing: /AGENT_DEVICE_IOS_PROVISIONING_PROFILE/,
  signing_style_conflict: /CODE_SIGN_STYLE/,
  signing_unspecified: /Automatic Signing/,
  devtools_security_developer_mode_disabled: /DevToolsSecurity -enable/,
  build_failed_unclassified: CACHE_RECOVERY_HINT,
};

const runCmdSync = vi.fn();
const runCmdStreaming = vi.fn();
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
  appleRunnerTestHost.update({
    runCmdSync,
    runCmdStreaming,
    findProjectRoot: () => projectRoot,
    readVersion: () => '0.0.0-test',
  });
});

afterEach(() => {
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
});

for (const fixture of buildForTestingFixtures()) {
  test(`a build-for-testing failure publishes ${fixture.reason}`, async () => {
    const envelope = await driveBuildFailure(buildForTestingExecError(fixture));

    assert.equal(envelope.code, 'COMMAND_FAILED');
    assert.equal(envelope.message, 'xcodebuild build-for-testing failed');
    assert.equal(envelope.details?.reason, fixture.reason);
    assert.match(String(envelope.hint), HINT_FOR_REASON[fixture.reason]);
    assert.equal(envelope.logPath, logPath);
    assert.equal(envelope.diagnosticId, DIAGNOSTIC_ID);
    // normalizeError hoists these out of `details`; a caller must read them at top level.
    assert.equal(envelope.details?.hint, undefined);
    assert.equal(envelope.details?.logPath, undefined);
    assert.equal(envelope.details?.diagnosticId, undefined);
    // The tool output stays reachable for a human reading the failure. It is redacted and
    // length-bounded on the way out, which is another reason the reason is typed: classification
    // happens before the truncation a caller sees.
    const nestedDetails = envelope.details?.details as Record<string, unknown> | undefined;
    assert.match(String(nestedDetails?.stdout), /AgentDeviceRunner/);
  });
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
    assert.ok(reasonsFromRules.has(reason), `no rule row yields the ${reason} reason`);
  }
});

test('an identical message without the typed host fact is not read as a DevToolsSecurity refusal', async () => {
  // Same message the host probe throws; the only difference is the typed `devToolsSecurityStatus`
  // fact the probe publishes. Text alone must not activate a reason (#2680).
  const withoutFact = new AppError('COMMAND_FAILED', 'Developer mode is disabled', {
    stdout: 'developer mode is disabled\n',
    stderr: '',
    exitCode: 65,
    processExitError: true,
  });

  const envelope = await driveBuildFailure(withoutFact);

  assert.equal(envelope.details?.reason, RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON);
  assert.match(String(envelope.hint), CACHE_RECOVERY_HINT);
  assert.doesNotMatch(String(envelope.hint), /DevToolsSecurity/);
});

test('an app identifier named without the availability fact is not read as a taken bundle id', async () => {
  const nearMiss = buildForTestingExecError({
    output:
      "error: App Identifier 'com.yourname.agentdevice.runner' is invalid. (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n",
  });

  const envelope = await driveBuildFailure(nearMiss);

  assert.equal(envelope.details?.reason, RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON);
  assert.match(String(envelope.hint), CACHE_RECOVERY_HINT);
  assert.doesNotMatch(String(envelope.hint), /AGENT_DEVICE_IOS_BUNDLE_ID/);
});

test('a signing failure that only names code signing keeps the generic signing advice', async () => {
  const generic = buildForTestingExecError({
    output: "error: Code signing is required for product type 'Application' in SDK 'iOS 26.2'\n",
  });

  const envelope = await driveBuildFailure(generic);

  assert.equal(envelope.details?.reason, 'signing_unspecified');
  assert.match(String(envelope.hint), /Automatic Signing/);
  assert.doesNotMatch(String(envelope.hint), CACHE_RECOVERY_HINT);
});

test('a conflicting-settings failure is not downgraded to a missing profile', async () => {
  // The conflicting-settings line names a profile while explaining that the styles disagree, so
  // the more specific row has to win the race the generic profile row would also run.
  const conflict = buildForTestingExecError({
    output:
      'error: "AgentDeviceRunner" has conflicting provisioning settings. AgentDeviceRunner is automatically signed, but provisioning profile "match-development" has been manually specified.\n',
  });

  const envelope = await driveBuildFailure(conflict);

  assert.equal(envelope.details?.reason, 'signing_style_conflict');
  assert.match(String(envelope.hint), /CODE_SIGN_STYLE/);
});

async function driveBuildFailure(execError: AppError): Promise<NormalizedError> {
  runCmdStreaming.mockReset().mockRejectedValue(execError);

  let envelope: NormalizedError | undefined;
  await assert.rejects(
    () =>
      ensureXctestrunArtifact(IOS_DEVICE, {
        logPath,
        budget: createRunnerPhaseBudget(120_000, undefined),
      }),
    (error: unknown) => {
      envelope = normalizeError(error, { diagnosticId: DIAGNOSTIC_ID, logPath });
      return true;
    },
  );
  assert.ok(envelope, 'the build-failure catch must throw');
  return envelope;
}
