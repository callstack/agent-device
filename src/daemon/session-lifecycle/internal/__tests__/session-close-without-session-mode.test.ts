import { test, expect, vi } from 'vitest';

import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest, DaemonResponse } from '../../../daemon-request.ts';
import { SessionStore } from '../../../session-store.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

const mockResolveTargetDevice = vi.hoisted(() => vi.fn());

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  const { selectionFromResolveTargetDevice } =
    await import('../../../__tests__/device-selection-stub.ts');
  return {
    ...actual,
    resolveTargetDevice: mockResolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(selectionFromResolveTargetDevice(mockResolveTargetDevice)),
  };
});

import {
  handleSessionCommands,
  mockBindDeviceRuntime,
} from '../../../handlers/__tests__/session-command-harness.ts';

const noopInvoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({ ok: true, data: {} });

const ANDROID_DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-session-close-without-session-');
  return new SessionStore(path.join(root, 'sessions'));
}

// #2749 review: `closeWithoutSession` (session-close.ts) is a second `mode: 'kill'` dispatch site
// alongside `dispatchTargetedPlatformClose`, exercised only when no session is stored for the
// requested name (`close <app>` straight from flags). Nothing previously proved it threads
// `killApp` into the platform `closeApplication` call the way the stored-session path is proven.
test('an app-only kill close with no stored session still carries mode kill to the platform close', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue(ANDROID_DEVICE);
  const seenInputs: Array<{
    mode?: unknown;
    positionals?: unknown;
    surface?: unknown;
    outPath?: unknown;
    ensureReady?: unknown;
  }> = [];
  const baseBind = mockBindDeviceRuntime.getMockImplementation();
  mockBindDeviceRuntime.mockImplementationOnce(async (device, use) => {
    const binding = await baseBind!(device, use);
    const innerClose = binding.operations.closeApplication;
    if (!innerClose) return binding;
    return {
      ...binding,
      operations: {
        ...binding.operations,
        closeApplication: async (input: Parameters<typeof innerClose>[0]) => {
          seenInputs.push(input);
        },
      },
    };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'no-such-session',
      command: 'close',
      positionals: ['com.example.app'],
      flags: { serial: 'emulator-5554' },
      internal: { closeAppOnly: true, killApp: true },
    },
    sessionName: 'no-such-session',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(seenInputs).toHaveLength(1);
  expect(seenInputs[0]?.mode).toBe('kill');
  expect(seenInputs[0]?.positionals).toEqual(['com.example.app']);
  expect(seenInputs[0]?.surface).toBe('app');
  expect(seenInputs[0]?.outPath).toBeUndefined();
  expect(seenInputs[0]?.ensureReady).toBe(true);
});
