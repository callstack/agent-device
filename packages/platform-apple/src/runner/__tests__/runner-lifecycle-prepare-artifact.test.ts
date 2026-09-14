import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';
import { Deadline } from '../host.ts';
import type { RunnerXctestrunArtifact } from '../runner-xctestrun.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { createTestRequestCancellation, makeRunnerSession } from './runner-session-fixtures.ts';

const {
  mockEnsureRunnerSession,
  mockExecuteRunnerCommandWithSession,
  mockEmitDiagnostic,
  mockGetRunnerSessionSnapshot,
  mockInvalidateRunnerSession,
  mockMarkRunnerXctestrunArtifactBadForRun,
} = vi.hoisted(() => ({
  mockEnsureRunnerSession: vi.fn(),
  mockExecuteRunnerCommandWithSession: vi.fn(),
  mockEmitDiagnostic: vi.fn(),
  mockGetRunnerSessionSnapshot: vi.fn(),
  mockInvalidateRunnerSession: vi.fn(),
  mockMarkRunnerXctestrunArtifactBadForRun: vi.fn(),
}));

vi.mock('../runner-session.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-session.ts')>('../runner-session.ts');
  return {
    ...actual,
    ensureRunnerSession: mockEnsureRunnerSession,
    executeRunnerCommandWithSession: mockExecuteRunnerCommandWithSession,
    getRunnerSessionSnapshot: mockGetRunnerSessionSnapshot,
    invalidateRunnerSession: mockInvalidateRunnerSession,
  };
});

vi.mock('../runner-xctestrun.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-xctestrun.ts')>('../runner-xctestrun.ts');
  return {
    ...actual,
    markRunnerXctestrunArtifactBadForRun: mockMarkRunnerXctestrunArtifactBadForRun,
  };
});

import { prepareIosRunner } from '../runner-client.ts';
import { resetRunnerRecycleLedgerForTests } from '../runner-recycle-ledger.ts';

function makeRunnerArtifact(
  overrides: Partial<RunnerXctestrunArtifact> = {},
): RunnerXctestrunArtifact {
  return {
    xctestrunPath: '/tmp/runner.xctestrun',
    derived: '/tmp/derived',
    cache: 'exact',
    artifact: 'valid',
    buildMs: 0,
    xctestrunPathSource: 'manifest',
    ...overrides,
  };
}

const requestCancellation = createTestRequestCancellation();
const { isRequestCanceled } = requestCancellation;

beforeEach(() => {
  vi.resetAllMocks();
  resetRunnerRecycleLedgerForTests();
  mockGetRunnerSessionSnapshot.mockReturnValue(null);
  mockMarkRunnerXctestrunArtifactBadForRun.mockResolvedValue(undefined);
  requestCancellation.reset();
  appleRunnerTestHost.update({
    emitDiagnostic: mockEmitDiagnostic,
    isRequestCanceled,
    getRequestSignal: () => undefined,
  });
});

// What a spent prepare deadline does to a restored artifact. Prepare spends one `Deadline` across
// boot and health check, so the failure this decision actually sees is the one
// `readPreparePhaseTimeoutMs` raises when the boot ate the budget: "prepare ios-runner timed out"
// with reason `prepare_deadline_expired`. That indicts the boot, not the derived data it was
// launched from, so the artifact stays and prepare retries with a fresh session. The artifact is
// only wiped by the rules that indict it, such as a runner that refused the connection.

test('a prepare deadline spent during boot keeps the restored artifact and retries', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1_000);
    const restoredSession = makeRunnerSession({
      port: 8100,
      xctestrunPath: '/tmp/restored.xctestrun',
      xctestrunArtifact: makeRunnerArtifact({ xctestrunPath: '/tmp/restored.xctestrun' }),
    });
    const prepareDeadline = Deadline.fromTimeoutMs(45_000);

    mockEnsureRunnerSession.mockImplementation(async () => {
      // The boot consumed the whole prepare budget, so no health phase time remains.
      vi.setSystemTime(46_000);
      return restoredSession;
    });

    await assert.rejects(
      () => prepareIosRunner(IOS_SIMULATOR, { healthTimeoutMs: 90_000, prepareDeadline }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.message, 'prepare ios-runner timed out');
        assert.equal(error.details?.reason, 'prepare_deadline_expired');
        assert.equal(error.details?.phase, 'runner_session');
        return true;
      },
    );

    assert.equal(mockMarkRunnerXctestrunArtifactBadForRun.mock.calls.length, 0);
    assert.deepEqual(mockInvalidateRunnerSession.mock.calls.at(-1), [
      restoredSession,
      'prepare_runner_health_retry',
    ]);
  } finally {
    vi.useRealTimers();
  }
});
