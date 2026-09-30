import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
} from '@agent-device/contracts/dispatch-disclosure-fixtures';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import {
  createTestRequestCancellation,
  makeRunnerSession,
  runnerConnectFailure,
} from './runner-session-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';

// contracts/fixtures/dispatch-disclosure.json, ios-runner pre-send rows: each row drives
// runAppleRunnerCommand through the real lifecycle and restart path with only the session start
// and the exchange mocked, and asserts the failure the caller receives.

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

async function tap(): Promise<unknown> {
  return await runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 });
}

const readinessPreflightFailure = (): AppError =>
  new AppError('COMMAND_FAILED', 'Runner readiness refused', {
    runnerReadinessPreflightFailed: true,
  });

const DRIVERS: Record<string, () => Promise<unknown>> = {
  'ios-runner.pre-send.session-start-failed': async () => {
    mockEnsureRunnerSession.mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'xcodebuild build-for-testing failed'),
    );
    return await tap();
  },
  'ios-runner.pre-send.connect-refused-restart-failed': async () => {
    mockEnsureRunnerSession
      .mockResolvedValueOnce(makeRunnerSession())
      .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'runner restart failed'));
    mockExecuteRunnerCommandWithSession.mockRejectedValueOnce(
      runnerConnectFailure('runner_connect_refused'),
    );
    return await tap();
  },
  'ios-runner.pre-send.readiness-preflight-after-restart': async () => {
    mockEnsureRunnerSession
      .mockResolvedValueOnce(makeRunnerSession())
      .mockResolvedValueOnce(makeRunnerSession({ port: 8101 }));
    mockExecuteRunnerCommandWithSession
      .mockRejectedValueOnce(readinessPreflightFailure())
      .mockRejectedValueOnce(readinessPreflightFailure());
    return await tap();
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
