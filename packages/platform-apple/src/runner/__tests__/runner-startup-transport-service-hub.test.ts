import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import type { ExecBackgroundResult } from '@agent-device/host-kit/command';
import { buildRunnerEarlyExitError, waitForRunner } from '../runner-startup-transport.ts';
import { readRunnerLogTail } from '../runner-io.ts';
import { RunnerCommandAccounting, type RunnerSession } from '../runner-session-types.ts';
import {
  isRetryableRunnerError,
  shouldRebuildCachedRunnerArtifact,
  shouldRestartRunnerAfterReadinessPreflight,
  shouldRestartRunnerBeforeCommandSend,
  shouldRetryRunnerConnectError,
} from '../runner-error-classification.ts';
import { RUNNER_ENDPOINT_FIXTURE, iosSimulator } from './runner-transport.fixtures.ts';
import { buildFixtureById } from './runner-startup-failure-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

beforeEach(resetAllProcessMemosForTests);

/**
 * An Xcode older than the macOS it sits on cannot load its own `DTServiceHub`: AMFI refuses its
 * version-restriction entitlement (#3449). Every `xcodebuild test-without-building` then writes the
 * bless refusal into `runner.log` while the runner never serves a command, and the caller only ever
 * saw `Runner did not accept connection` on a runner the request had just restarted. The cause is
 * readable nowhere but that log, so both connect-stage failures have to read it, name it, and refuse
 * the restart and resend they would otherwise order. These cases drive the real producers.
 */

const BLESS_LOG = buildFixtureById('simulator-service-hub-bless-refused').output;

function sessionWithLaunchLog(log: string, exitCode: number | null): RunnerSession {
  const runnerLogPath = path.join(mkdtempForTestSync('runner-service-hub-'), 'runner.log');
  fs.writeFileSync(runnerLogPath, log);
  return {
    sessionId: 'service-hub-session',
    device: iosSimulator,
    deviceId: iosSimulator.id,
    endpoint: RUNNER_ENDPOINT_FIXTURE,
    xctestrunPath: '/tmp/runner.xctestrun',
    jsonPath: '/tmp/runner.json',
    runnerLogPath,
    readLogTail: (maxBytes) =>
      readRunnerLogTail({ logPath: runnerLogPath, startOffset: 0 }, maxBytes),
    testPromise:
      exitCode === null
        ? new Promise<never>(() => {})
        : Promise.resolve({ exitCode, stdout: '', stderr: '' }),
    child: { pid: 4242, exitCode } as ExecBackgroundResult['child'],
    state: 'starting',
    commandCharges: new RunnerCommandAccounting(),
  };
}

/** The device states a simulator startup carries; the bless cause must outrank them (#2683). */
const SIMULATOR_WITH_IMAGE_DOWN = {
  developerMode: 'enabled' as const,
  developerDiskImage: 'unavailable' as const,
  developerDiskImageHint: 'Unlock the iPhone so it can mount the developer disk image.',
};

test('a launch that cannot bless the simulator service names the Xcode cause and its fix', async () => {
  const session = {
    ...sessionWithLaunchLog(BLESS_LOG, 65),
    startupDeviceStates: SIMULATOR_WITH_IMAGE_DOWN,
  };

  const error = await buildRunnerEarlyExitError({ session, port: 8100 });
  const envelope = normalizeError(error, { diagnosticId: 'diag-service-hub' });

  assert.equal(envelope.code, 'COMMAND_FAILED');
  assert.equal(
    envelope.message,
    'Runner did not accept connection (xcodebuild exited early): this Xcode cannot start its simulator service on this macOS',
  );
  assert.equal(envelope.details?.reason, 'simulator_service_hub_unavailable');
  // The fix is the daemon host's Xcode selection, so the hint has to name both levers for it.
  assert.match(String(envelope.hint), /xcode-select -s/);
  assert.match(String(envelope.hint), /DEVELOPER_DIR/);
  // The bless line is in the runner's log, and that is the file the caller is sent to.
  assert.equal(envelope.logPath, session.runnerLogPath);
  assert.equal(envelope.diagnosticId, 'diag-service-hub');
  // A cause this log proved outranks a device state read before the launch; the state still travels.
  assert.equal(envelope.details?.developerDiskImage, 'unavailable');
});

test('a still-alive xcodebuild whose log carries the bless refusal fails the connect stage by name and stays terminal', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8100'), {
        code: 'ECONNREFUSED',
      });
    }),
  );
  const session = sessionWithLaunchLog(BLESS_LOG, null);

  const error = await waitForRunner(
    iosSimulator,
    RUNNER_ENDPOINT_FIXTURE,
    { command: 'tap', x: 200, y: 300 },
    undefined,
    300,
    session,
  ).catch((error: unknown) => error as AppError);

  assert.ok(error instanceof AppError);
  assert.equal(
    error.message,
    'Runner did not accept connection: this Xcode cannot start its simulator service on this macOS',
  );
  assert.equal(error.details?.reason, 'simulator_service_hub_unavailable');
  assert.match(String(error.details?.hint), /xcode-select -s/);
  assert.equal(error.details?.logPath, session.runnerLogPath);
  // Nothing was written before the loop gave up, so the disclosure the refusal earns still holds.
  assert.equal(error.details?.dispatched, 'no');
  // Before the cause had a name, this same failure ordered a session restart, a resend, and a clean
  // rebuild of the very binary this macOS refuses to load (#3449). None of that may survive.
  assert.equal(shouldRetryRunnerConnectError(error), false);
  assert.equal(isRetryableRunnerError(error), false);
  assert.equal(shouldRestartRunnerBeforeCommandSend(error, { command: 'tap' }), false);
  assert.equal(shouldRebuildCachedRunnerArtifact(error), false);
});

test('a still-alive xcodebuild whose log names no service-hub cause keeps the ordinary connect failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8100'), {
        code: 'ECONNREFUSED',
      });
    }),
  );

  await assert.rejects(
    () =>
      waitForRunner(
        iosSimulator,
        RUNNER_ENDPOINT_FIXTURE,
        { command: 'snapshot' },
        undefined,
        300,
        sessionWithLaunchLog(
          '2026-10-15 10:23:41.112 xcodebuild[9:1] [MT] iOSSimulator: waiting for the simulator to boot\n',
          null,
        ),
      ),
    (error: unknown) => {
      const appError = error as AppError;
      assert.equal(appError.message, 'Runner did not accept connection');
      assert.equal(appError.details?.reason, 'IOS_RUNNER_CONNECT_TIMEOUT');
      return true;
    },
  );
});

test('bless wording without the typed reason cannot stop the connect retry or the resend', () => {
  // The recovery rows key on the reason the launch paths publish, so foreign text carrying Xcode's
  // own sentence — in a message or a captured log — cannot by itself mark a failure terminal.
  const untyped = new AppError(
    'COMMAND_FAILED',
    'Runner did not accept connection: DTServiceHubClient failed to bless service hub for simulator iPhone (UDID)',
    { stderr: BLESS_LOG },
  );

  // The connect loop keeps waiting on it, exactly as it does on any unclassified connect failure.
  assert.equal(shouldRetryRunnerConnectError(untyped), true);
  assert.equal(shouldRestartRunnerAfterReadinessPreflight(untyped), false);
});
