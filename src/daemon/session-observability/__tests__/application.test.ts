import { beforeEach, expect, test, vi } from 'vitest';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';

vi.mock('../index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index.ts')>();
  return {
    ...actual,
    handleSessionObservabilityCommands: vi.fn(actual.handleSessionObservabilityCommands),
  };
});

import { handleSessionCommands } from '../../handlers/session.ts';
import { handleSessionObservabilityCommands } from '../index.ts';

const mockHandleSessionObservabilityCommands = vi.mocked(handleSessionObservabilityCommands);

beforeEach(() => {
  mockHandleSessionObservabilityCommands.mockClear();
});

function request(command: DaemonRequest['command']): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command,
    positionals: [],
    flags: {},
  };
}

async function run(command: DaemonRequest['command']): Promise<DaemonResponse | null> {
  return await handleSessionCommands({
    req: request(command),
    sessionName: 'default',
    logPath: '/tmp/agent-device-session-observability-route.log',
    sessionStore: makeSessionStore('agent-device-session-observability-route-'),
    invoke: async () => ({ ok: true, data: {} }),
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained' as const,
      reason: 'test-harness',
    }),
  });
}

test('observability commands retain their route response and narrow facade input', async () => {
  const expected: DaemonResponse = { ok: true, data: { routed: true } };
  mockHandleSessionObservabilityCommands.mockResolvedValue(expected);

  for (const command of ['perf', 'logs', 'events', 'network', 'audio'] as const) {
    await expect(run(command)).resolves.toEqual(expected);
    const forwarded = mockHandleSessionObservabilityCommands.mock.calls.at(-1)?.[0];
    expect(Object.keys(forwarded ?? {}).sort()).toEqual(
      [
        'appLogAdmissionLedger',
        'audioProbeAdmissionLedger',
        'bindDevice',
        'inspectFacts',
        'perfCaptureAdmissionLedger',
        'req',
        'sessionName',
        'sessionStore',
        'throwIfCanceled',
      ].sort(),
    );
    expect(forwarded).toMatchObject({
      req: expect.objectContaining({ command }),
      sessionName: 'default',
    });
  }
});
