import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { beforeEach, expect, test, vi } from 'vitest';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { sessionOrDeviceSelectorRequiredDetails } from '@agent-device/kernel/errors';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';

vi.mock('@agent-device/device-selection/device-inventory-context', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@agent-device/device-selection/device-inventory-context')
    >();
  return { ...actual, listDeviceInventory: vi.fn(async () => []) };
});

vi.mock('../internal/session-close.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../internal/session-close.ts')>();
  return { ...actual, handleSessionCloseCommands: vi.fn(actual.handleSessionCloseCommands) };
});

vi.mock('../internal/inventory.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../internal/inventory.ts')>();
  return {
    ...actual,
    handleSessionInventoryCommands: vi.fn(actual.handleSessionInventoryCommands),
  };
});

vi.mock('../internal/session-open.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../internal/session-open.ts')>();
  return { ...actual, handleSessionOpenCommands: vi.fn(actual.handleSessionOpenCommands) };
});

import { handleSessionCommands } from '../../handlers/session.ts';
import { handleSessionCloseCommands } from '../internal/session-close.ts';
import { handleSessionInventoryCommands } from '../internal/inventory.ts';
import { handleSessionOpenCommands } from '../internal/session-open.ts';

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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
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
        details: sessionOrDeviceSelectorRequiredDetails(),
      },
    },
    apps: {
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        message:
          'apps requires an active session or an explicit device selector (e.g. --platform ios).',
        details: sessionOrDeviceSelectorRequiredDetails(),
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

test('open routes only its lifecycle input through its owner', async () => {
  const expected: DaemonResponse = { ok: true, data: { session: 'default' } };
  mockHandleSessionOpenCommands.mockImplementationOnce(async () => expected);

  await expect(run('open')).resolves.toEqual(expected);

  const forwarded = mockHandleSessionOpenCommands.mock.calls.at(-1)?.[0];
  expect(Object.keys(forwarded ?? {}).sort()).toEqual(
    [
      'bindDevice',
      'createCommandSurface',
      'inspectFacts',
      'logPath',
      'platformServices',
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

test('close routes only its lifecycle input through its owner', async () => {
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
      'platformServices',
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
