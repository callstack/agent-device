import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';
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

// What a prepare deadline does to a restored artifact. The wipe that rebuilds a suspect
// artifact comes from the rules that indict the artifact itself; a runner that never
// answers inside its budget indicts the boot, not the derived data it was launched from,
// so the artifact stays and the session goes.

test('a restored artifact whose runner never answers past its deadline is kept while the session is dropped', async () => {
  const restoredSession = makeRunnerSession({
    port: 8100,
    xctestrunPath: '/tmp/restored.xctestrun',
    xctestrunArtifact: makeRunnerArtifact({ xctestrunPath: '/tmp/restored.xctestrun' }),
  });

  mockEnsureRunnerSession.mockResolvedValue(restoredSession);
  mockExecuteRunnerCommandWithSession.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'xcrun simctl spawn did not answer', {
      cmd: 'xcrun',
      timeoutMs: 45_000,
    }),
  );

  await assert.rejects(
    () => prepareIosRunner(IOS_SIMULATOR, { healthTimeoutMs: 90_000 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'xcrun simctl spawn did not answer');
      return true;
    },
  );

  assert.equal(mockMarkRunnerXctestrunArtifactBadForRun.mock.calls.length, 0);
  assert.equal(mockEnsureRunnerSession.mock.calls.length, 2);
  assert.deepEqual(mockInvalidateRunnerSession.mock.calls.at(-1), [
    restoredSession,
    'prepare_runner_health_failed',
  ]);
});
