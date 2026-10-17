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
import {
  RUNNER_ENDPOINT_FIXTURE,
  iosSimulator,
  runnerTransportResponse,
} from './runner-transport.fixtures.ts';
import {
  CAPTURED_LAUNCH_DESTINATION_NOT_FOUND_OUTPUT,
  CAPTURED_SCOPED_SIMULATOR,
  buildFixtureById,
} from './runner-startup-failure-fixtures.ts';
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

/** A connect budget far longer than the bless refusal needs, so its arrival is a claim about timing. */
const CONNECT_BUDGET_MS = 5_000;

test('a bless refusal already in the launch log ends the connect loop on its first attempt', async () => {
  // The reporters' 90 seconds came from spending the whole connect budget on a boot that had already
  // said why it would never serve a command (#3449). The signature appears in `runner.log` within the
  // first seconds of the launch, so the loop has to read it and stop.
  const fetchSpy = vi.fn(async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8100'), { code: 'ECONNREFUSED' });
  });
  vi.stubGlobal('fetch', fetchSpy);
  const session = sessionWithLaunchLog(BLESS_LOG, null);
  const startedAt = Date.now();

  const error = await waitForRunner(
    iosSimulator,
    RUNNER_ENDPOINT_FIXTURE,
    { command: 'snapshot' },
    undefined,
    CONNECT_BUDGET_MS,
    session,
  ).catch((error: unknown) => error as AppError);

  const elapsedMs = Date.now() - startedAt;
  assert.ok(error instanceof AppError);
  assert.equal(error.details?.reason, 'simulator_service_hub_unavailable');
  // No connect attempt is dialed once the boot is known terminal, and the failure arrives with most
  // of the budget unspent rather than at its deadline.
  assert.equal(fetchSpy.mock.calls.length, 0);
  assert.ok(
    elapsedMs < CONNECT_BUDGET_MS / 2,
    `expected the failure well before its ${CONNECT_BUDGET_MS}ms deadline, took ${elapsedMs}ms`,
  );
});

test("one tail holding two launch-log causes gets the classifier's own winner, terminal", async () => {
  // The row order decides, not the loop. A scoped-set launch whose log holds both the bless refusal and
  // the missing destination reads as `simulator_set_destination_not_found`, the row that comes first.
  // A pre-check of the loop's own would see the bless, order the stop, and hand back an error whose
  // reason says otherwise — and the first fix did exactly that, so each remaining attempt re-threw
  // without dialing until the deadline. One classifier over the tail cannot produce that pair.
  const fetchSpy = vi.fn(async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8100'), { code: 'ECONNREFUSED' });
  });
  vi.stubGlobal('fetch', fetchSpy);
  const scopedSimulator = {
    ...iosSimulator,
    id: CAPTURED_SCOPED_SIMULATOR.udid,
    simulatorSetPath: CAPTURED_SCOPED_SIMULATOR.setWithoutUdid,
  };
  const session = {
    ...sessionWithLaunchLog(`${CAPTURED_LAUNCH_DESTINATION_NOT_FOUND_OUTPUT}\n${BLESS_LOG}`, null),
    device: scopedSimulator,
    deviceId: scopedSimulator.id,
  };
  const startedAt = Date.now();

  const error = await waitForRunner(
    scopedSimulator,
    RUNNER_ENDPOINT_FIXTURE,
    { command: 'snapshot' },
    undefined,
    CONNECT_BUDGET_MS,
    session,
  ).catch((error: unknown) => error as AppError);

  const elapsedMs = Date.now() - startedAt;
  assert.ok(error instanceof AppError);
  // The reason and the message agree because one row produced both, and the verdict beside them is the
  // terminal one that class shares, so the loop stopped rather than re-throwing at the deadline.
  assert.equal(error.details?.reason, 'simulator_set_destination_not_found');
  assert.ok(error.message.includes(CAPTURED_SCOPED_SIMULATOR.setWithoutUdid), error.message);
  assert.doesNotMatch(error.message, /simulator service/);
  assert.equal(shouldRetryRunnerConnectError(error), false);
  assert.equal(fetchSpy.mock.calls.length, 0);
  assert.ok(
    elapsedMs < CONNECT_BUDGET_MS / 2,
    `expected the failure well before its ${CONNECT_BUDGET_MS}ms deadline, took ${elapsedMs}ms`,
  );
});

test('a bless refusal in an older runner generation does not end this launch early', async () => {
  // The log is append-only across launches, so a bless refusal the previous launch wrote is not
  // evidence about this one (#2681). The session's tail reader starts at this generation's offset.
  const runnerLogPath = path.join(mkdtempForTestSync('runner-service-hub-stale-'), 'runner.log');
  fs.writeFileSync(runnerLogPath, BLESS_LOG);
  const generationStartOffset = BLESS_LOG.length;
  fs.appendFileSync(
    runnerLogPath,
    '2026-10-15 10:24:41.112 xcodebuild[9:1] [MT] iOSSimulator: waiting for the simulator to boot\n',
  );
  const session = {
    ...sessionWithLaunchLog('', null),
    runnerLogPath,
    readLogTail: (maxBytes: number) =>
      readRunnerLogTail({ logPath: runnerLogPath, startOffset: generationStartOffset }, maxBytes),
  };
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
        session,
      ),
    (error: unknown) => {
      // The ordinary connect failure, on the ordinary deadline: nothing named this boot.
      assert.equal((error as AppError).details?.reason, 'IOS_RUNNER_CONNECT_TIMEOUT');
      return true;
    },
  );
});

test('a runner that already answered is not re-judged by its launch log', async () => {
  // A bless line written during a boot that did serve commands (an Xcode fixed mid-session, say) must
  // not refuse a later command on the strength of it.
  const fetchSpy = vi.fn(async () => runnerTransportResponse());
  vi.stubGlobal('fetch', fetchSpy);
  const session = { ...sessionWithLaunchLog(BLESS_LOG, null), state: 'ready' as const };

  const response = await waitForRunner(
    iosSimulator,
    RUNNER_ENDPOINT_FIXTURE,
    { command: 'snapshot' },
    undefined,
    300,
    session,
  );

  assert.equal(response.status, 200);
  assert.equal(fetchSpy.mock.calls.length, 1);
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
