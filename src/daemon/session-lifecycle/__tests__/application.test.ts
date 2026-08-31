import { beforeEach, expect, test, vi } from 'vitest';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';

vi.mock('../../../request/device-inventory-context.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../request/device-inventory-context.ts')>();
  return { ...actual, listDeviceInventory: vi.fn(async () => []) };
});

vi.mock('../index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index.ts')>();
  return {
    ...actual,
    handleSessionInventoryCommands: vi.fn(actual.handleSessionInventoryCommands),
  };
});

import { handleSessionCommands } from '../../handlers/session.ts';
import { handleSessionInventoryCommands } from '../index.ts';

const mockHandleSessionInventoryCommands = vi.mocked(handleSessionInventoryCommands);

beforeEach(() => {
  mockHandleSessionInventoryCommands.mockClear();
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
    logPath: '/tmp/agent-device-session-lifecycle-route.log',
    sessionStore: makeSessionStore('agent-device-session-lifecycle-route-'),
    invoke: async () => ({ ok: true, data: {} }),
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained' as const,
      reason: 'test-harness',
    }),
  });
}

test('inventory commands retain their route responses and typed failures', async () => {
  const expected: Record<string, DaemonResponse> = {
    session_list: { ok: true, data: { sessions: [] } },
    devices: { ok: true, data: { devices: [] } },
    capabilities: {
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        message:
          'capabilities requires an active session or an explicit device selector (e.g. --platform ios).',
      },
    },
    apps: {
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        message:
          'apps requires an active session or an explicit device selector (e.g. --platform ios).',
      },
    },
  };

  for (const command of ['session_list', 'devices', 'capabilities', 'apps'] as const) {
    await expect(run(command)).resolves.toEqual(expected[command]);
    expect(mockHandleSessionInventoryCommands).toHaveBeenLastCalledWith(
      expect.objectContaining({
        req: expect.objectContaining({ command }),
        sessionName: 'default',
      }),
    );
  }
});
