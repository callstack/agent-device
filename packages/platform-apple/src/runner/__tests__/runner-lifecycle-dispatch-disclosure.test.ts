import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
} from '@agent-device/contracts/dispatch-disclosure-fixtures';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { createTestRequestCancellation, makeRunnerSession } from './runner-session-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';

// contracts/fixtures/dispatch-disclosure.json, ios-runner pre-send and transport rows: each row
// drives runAppleRunnerCommand through the real lifecycle and restart path with the session start
// mocked; the connect rows run the real connect loop (waitForRunner) over a stubbed fetch and simctl
// curl, and assert the failure the caller receives.

const {
  mockEnsureRunnerSession,
  mockExecuteRunnerCommandWithSession,
  mockInvalidateRunnerSession,
} = vi.hoisted(() => ({
  mockEnsureRunnerSession: vi.fn(),
  mockExecuteRunnerCommandWithSession: vi.fn(),
  mockInvalidateRunnerSession: vi.fn(),
}));

vi.mock('../runner-session.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-session.ts')>('../runner-session.ts');
  return {
    ...actual,
    ensureRunnerSession: mockEnsureRunnerSession,
    executeRunnerCommandWithSession: mockExecuteRunnerCommandWithSession,
    readRunnerSessionLiveness: vi.fn(() => null),
    invalidateRunnerSession: mockInvalidateRunnerSession,
  };
});

import { runAppleRunnerCommand } from '../runner-client.ts';
import { resetRunnerRecycleLedgerForTests } from '../runner-recycle-ledger.ts';
import { waitForRunner } from '../runner-startup-transport.ts';

const requestCancellation = createTestRequestCancellation();

beforeEach(() => {
  mockEnsureRunnerSession.mockReset();
  mockExecuteRunnerCommandWithSession.mockReset();
  mockInvalidateRunnerSession.mockReset();
  resetRunnerRecycleLedgerForTests();
  requestCancellation.reset();
  appleRunnerTestHost.update({
    emitDiagnostic: vi.fn(),
    isRequestCanceled: requestCancellation.isRequestCanceled,
    getRequestSignal: () => undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function tap(): Promise<unknown> {
  return await runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 });
}

const readinessPreflightFailure = (): AppError =>
  new AppError('COMMAND_FAILED', 'Runner readiness refused', {
    runnerReadinessPreflightFailed: true,
  });

/**
 * The first attempt runs the real connect loop against a simulator whose every fetch fails the
 * same way and whose simctl curl fallback exits with `curlExitCode`; the restart it earns fails.
 */
async function connectLoopThenFailedRestart(transport: {
  fetchFailure: () => Error;
  curlExitCode: number;
}): Promise<unknown> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw transport.fetchFailure();
    }),
  );
  appleRunnerTestHost.update({
    runXcrun: vi.fn(async () => ({
      exitCode: transport.curlExitCode,
      stdout: '',
      stderr: `curl exited ${transport.curlExitCode}`,
    })),
  });
  mockEnsureRunnerSession
    .mockResolvedValueOnce(makeRunnerSession())
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'runner restart failed'));
  mockExecuteRunnerCommandWithSession.mockImplementationOnce(
    async (device, session, command) =>
      await waitForRunner(device, session.port, command, undefined, 400),
  );
  try {
    return await tap();
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.runnerRestartReason, 'runner_connect_failed_before_command_send');
    throw error;
  }
}

const DRIVERS: Record<string, () => Promise<unknown>> = {
  'ios-runner.pre-send.session-start-failed': async () => {
    mockEnsureRunnerSession.mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'xcodebuild build-for-testing failed'),
    );
    return await tap();
  },
  'ios-runner.pre-send.connect-refused-before-write': () =>
    connectLoopThenFailedRestart({
      fetchFailure: () =>
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8100'), {
            code: 'ECONNREFUSED',
          }),
        }),
      curlExitCode: 7,
    }),
  'ios-runner.transport.written-then-lost': () =>
    connectLoopThenFailedRestart({
      fetchFailure: () => new AppError('COMMAND_FAILED', 'Runner command deadline exceeded'),
      curlExitCode: 28,
    }),
  'ios-runner.pre-send.readiness-preflight-after-restart': async () => {
    mockEnsureRunnerSession
      .mockResolvedValueOnce(makeRunnerSession())
      .mockResolvedValueOnce(makeRunnerSession({ port: 8101 }));
    mockExecuteRunnerCommandWithSession
      .mockRejectedValueOnce(readinessPreflightFailure())
      .mockRejectedValueOnce(readinessPreflightFailure());
    return await tap();
  },
  'ios-runner.transport.replay-failed-after-unwritten-first-attempt': async () => {
    mockEnsureRunnerSession
      .mockResolvedValueOnce(makeRunnerSession())
      .mockResolvedValueOnce(makeRunnerSession({ port: 8101 }));
    mockExecuteRunnerCommandWithSession
      .mockRejectedValueOnce(readinessPreflightFailure())
      .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'runner replay failed'));
    try {
      return await tap();
    } finally {
      assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
    }
  },
};

const ROWS = dispatchDisclosureRowsOwnedBy(
  import.meta.url,
  fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
);

test('every ios-runner pre-send dispatch-disclosure row has exactly one driver', () => {
  assertDispatchDisclosureDriversMatchRows(ROWS, Object.keys(DRIVERS));
});

for (const row of ROWS) {
  test(`${row.id}: ${row.trigger} → dispatched ${row.dispatched}`, async () => {
    const drive = DRIVERS[row.id];
    assert.ok(drive, `no driver for ${row.id}`);
    await assert.rejects(drive(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.dispatched, row.dispatched);
      return true;
    });
  });
}

test('a plain Error before the exchange is normalized and discloses no', async () => {
  mockEnsureRunnerSession.mockRejectedValueOnce(new Error('spawn EACCES'));
  await assert.rejects(tap(), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.message, 'spawn EACCES');
    assert.equal(error.details?.dispatched, 'no');
    return true;
  });
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 0);
});
