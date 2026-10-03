import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { makeRunnerSession } from './runner-session-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';

const { mockEnsureRunnerSession, mockExecuteRunnerCommandWithSession, mockEmitDiagnostic } =
  vi.hoisted(() => ({
    mockEnsureRunnerSession: vi.fn(),
    mockExecuteRunnerCommandWithSession: vi.fn(),
    mockEmitDiagnostic: vi.fn(),
  }));

vi.mock('../runner-session.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-session.ts')>('../runner-session.ts');
  return {
    ...actual,
    ensureRunnerSession: mockEnsureRunnerSession,
    executeRunnerCommandWithSession: mockExecuteRunnerCommandWithSession,
  };
});

import { prewarmIosRunnerSession } from '../runner-client.ts';

beforeEach(() => {
  vi.resetAllMocks();
  appleRunnerTestHost.update({ emitDiagnostic: mockEmitDiagnostic });
});

test('prewarmIosRunnerSession proves cached runner health with uptime', async () => {
  const session = makeRunnerSession({ port: 8100 });
  mockEnsureRunnerSession.mockResolvedValueOnce(session);
  mockExecuteRunnerCommandWithSession.mockResolvedValueOnce({ uptimeMs: 42 });

  const prewarm = prewarmIosRunnerSession(IOS_SIMULATOR, {
    buildTimeoutMs: 300_000,
    requestId: 'prewarm-request',
  });

  await prewarm;

  assert.equal(mockEnsureRunnerSession.mock.calls.length, 1);
  assert.equal(mockEnsureRunnerSession.mock.calls[0]?.[1]?.buildTimeoutMs, 300_000);
  assert.equal(mockEnsureRunnerSession.mock.calls[0]?.[1]?.requestId, 'prewarm-request');
  assert.equal(mockEnsureRunnerSession.mock.calls[0]?.[1]?.healthTimeoutMs, 45_000);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 1);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[0]?.[1], session);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[0]?.[2].command, 'uptime');
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[0]?.[4], 45_000);
});

test('prewarmIosRunnerSession can start a session without a redundant health command', async () => {
  const session = makeRunnerSession({ port: 8100 });
  mockEnsureRunnerSession.mockResolvedValueOnce(session);

  const prewarm = prewarmIosRunnerSession(IOS_SIMULATOR, { healthCheck: false });

  await prewarm;

  assert.equal(mockEnsureRunnerSession.mock.calls.length, 1);
  assert.equal(mockEnsureRunnerSession.mock.calls[0]?.[1]?.healthCheck, undefined);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 0);
});

test('prewarmIosRunnerSession can propagate setup failures for blocking callers', async () => {
  const failure = new AppError('COMMAND_FAILED', 'Developer mode is disabled');
  mockEnsureRunnerSession.mockRejectedValueOnce(failure);
  const prewarm = prewarmIosRunnerSession(IOS_SIMULATOR, { propagateError: true });

  assert.ok(prewarm);
  await assert.rejects(prewarm, (error: unknown) => error === failure);

  assert.deepEqual(mockEmitDiagnostic.mock.calls[0]?.[0], {
    level: 'warn',
    phase: 'ios_runner_session_prewarm_failed',
    data: {
      deviceId: IOS_SIMULATOR.id,
      error: 'Developer mode is disabled',
    },
  });
  assert.equal(mockEnsureRunnerSession.mock.calls[0]?.[1]?.propagateError, undefined);
});
