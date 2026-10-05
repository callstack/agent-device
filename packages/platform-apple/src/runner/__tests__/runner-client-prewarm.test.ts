import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { makeRunnerSession } from './runner-session-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../../core/tool-provider.ts';

const {
  mockEnsureRunnerSession,
  mockExecuteRunnerCommandWithSession,
  mockEnsureXctestrunArtifact,
  mockEmitDiagnostic,
} = vi.hoisted(() => ({
  mockEnsureRunnerSession: vi.fn(),
  mockExecuteRunnerCommandWithSession: vi.fn(),
  mockEnsureXctestrunArtifact: vi.fn(),
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

vi.mock('../runner-xctestrun.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-xctestrun.ts')>('../runner-xctestrun.ts');
  return { ...actual, ensureXctestrunArtifact: mockEnsureXctestrunArtifact };
});

import { prewarmAppleRunnerCache, prewarmIosRunnerSession } from '../runner-client.ts';

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

test('prewarmAppleRunnerCache builds the runner artifact when the host serves Apple tooling', async () => {
  mockEnsureXctestrunArtifact.mockResolvedValueOnce({});

  await prewarmAppleRunnerCache(IOS_SIMULATOR, { requestId: 'cache-request' });

  assert.equal(mockEnsureXctestrunArtifact.mock.calls.length, 1);
  assert.equal(mockEnsureXctestrunArtifact.mock.calls[0]?.[0], IOS_SIMULATOR);
  assert.equal(mockEnsureXctestrunArtifact.mock.calls[0]?.[1]?.requestId, 'cache-request');
});

test('prewarmAppleRunnerCache starts no host build while a provider serves Apple tooling', async () => {
  const providerCalls: string[] = [];
  const scriptedTools = createLocalAppleToolProvider({
    runCommand: async (cmd, args) => {
      providerCalls.push([cmd, ...args].join(' '));
      throw new Error('a cache prewarm must not reach provider-served Apple tooling');
    },
  });

  const scoped = await withAppleToolProvider(scriptedTools, async () => ({
    prewarm: prewarmAppleRunnerCache(IOS_SIMULATOR, { requestId: 'provider-request' }),
  }));

  assert.equal(scoped.prewarm, undefined);
  assert.equal(mockEnsureXctestrunArtifact.mock.calls.length, 0);
  assert.deepEqual(providerCalls, []);
  assert.deepEqual(mockEmitDiagnostic.mock.calls, [
    [
      {
        level: 'debug',
        phase: 'ios_runner_cache_prewarm_unavailable',
        data: { deviceId: IOS_SIMULATOR.id },
      },
    ],
  ]);
});
