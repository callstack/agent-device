import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { beforeEach, expect, test, vi } from 'vitest';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';

vi.mock('../internal/session-observability.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../internal/session-observability.ts')>();
  return {
    ...actual,
    handleSessionObservabilityCommands: vi.fn(actual.handleSessionObservabilityCommands),
  };
});

import { handleSessionCommands } from '../../handlers/session.ts';
import { handleSessionObservabilityCommands } from '../internal/session-observability.ts';

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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
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
        'platformServices',
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
