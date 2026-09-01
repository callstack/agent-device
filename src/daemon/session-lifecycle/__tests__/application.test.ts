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
    handleSessionCloseCommands: vi.fn(actual.handleSessionCloseCommands),
    handleSessionInventoryCommands: vi.fn(actual.handleSessionInventoryCommands),
    handleSessionOpenCommands: vi.fn(actual.handleSessionOpenCommands),
  };
});

import { handleSessionCommands } from '../../handlers/session.ts';
import {
  handleSessionCloseCommands,
  handleSessionInventoryCommands,
  handleSessionOpenCommands,
} from '../index.ts';

const mockHandleSessionCloseCommands = vi.mocked(handleSessionCloseCommands);
const mockHandleSessionInventoryCommands = vi.mocked(handleSessionInventoryCommands);
const mockHandleSessionOpenCommands = vi.mocked(handleSessionOpenCommands);

beforeEach(() => {
  mockHandleSessionCloseCommands.mockClear();
  mockHandleSessionInventoryCommands.mockClear();
  mockHandleSessionOpenCommands.mockClear();
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

test('open routes only its lifecycle input through the public facade', async () => {
  const expected: DaemonResponse = { ok: true, data: { session: 'default' } };
  mockHandleSessionOpenCommands.mockImplementationOnce(async () => expected);

  await expect(run('open')).resolves.toEqual(expected);

  const forwarded = mockHandleSessionOpenCommands.mock.calls.at(-1)?.[0];
  expect(Object.keys(forwarded ?? {}).sort()).toEqual(
    [
      'bindDevice',
      'inspectFacts',
      'logPath',
      'reconcileOrphanedDeviceClaim',
      'req',
      'sessionName',
      'sessionStore',
    ].sort(),
  );
  expect(forwarded).toMatchObject({
    req: expect.objectContaining({ command: 'open' }),
    sessionName: 'default',
    logPath: '/tmp/agent-device-session-lifecycle-route.log',
  });
});

test('close routes only its lifecycle input through the public facade', async () => {
  const expected: DaemonResponse = { ok: true, data: { session: 'default' } };
  mockHandleSessionCloseCommands.mockImplementationOnce(async () => expected);

  await expect(run('close')).resolves.toEqual(expected);

  const forwarded = mockHandleSessionCloseCommands.mock.calls.at(-1)?.[0];
  expect(Object.keys(forwarded ?? {}).sort()).toEqual(
    [
      'bindDevice',
      'inspectFacts',
      'leaseLifecycleProvider',
      'leaseRegistry',
      'logPath',
      'platformResourceCleanup',
      'req',
      'sessionName',
      'sessionStore',
    ].sort(),
  );
  expect(forwarded).toMatchObject({
    req: expect.objectContaining({ command: 'close' }),
    sessionName: 'default',
    logPath: '/tmp/agent-device-session-lifecycle-route.log',
  });
});
