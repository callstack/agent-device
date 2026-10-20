import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { test, expect, vi } from 'vitest';

import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { CloseApplicationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DaemonRequest } from '../../../../core/daemon-request.ts';
import { SessionStore } from '../../../../core/session-store.ts';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';
import {
  createLiveTestHostEnvironment,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';

const mockResolveTargetDevice = vi.hoisted(() => vi.fn());

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  const { selectionFromResolveTargetDevice } =
    await import('../../../../__tests__/support/device-selection-stub.ts');
  return {
    ...actual,
    resolveTargetDevice: mockResolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(selectionFromResolveTargetDevice(mockResolveTargetDevice)),
  };
});

import {
  handleSessionCommands,
  mockBindDeviceRuntime,
} from '../../../../__tests__/support/handlers/session-command-harness.ts';

const noopInvoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({ ok: true, data: {} });

const ANDROID_DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test('an app-only kill close with no stored session carries mode kill to the platform close', async () => {
  const sessionStore = new SessionStore(
    path.join(mkdtempForTestSync('agent-device-session-close-without-session-'), 'sessions'),
    createLiveTestHostEnvironment(),
  );
  mockResolveTargetDevice.mockResolvedValue(ANDROID_DEVICE);
  const seenInputs: CloseApplicationInput[] = [];

  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
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
    bindDevice: async (device, use) => {
      const binding = await mockBindDeviceRuntime(device, use);
      return {
        ...binding,
        operations: {
          ...binding.operations,
          closeApplication: async (input: CloseApplicationInput) => {
            seenInputs.push(input);
          },
        },
      };
    },
  });

  expect(response?.ok).toBe(true);
  expect(seenInputs).toEqual([
    expect.objectContaining({
      mode: 'kill',
      positionals: ['com.example.app'],
      surface: 'app',
      ensureReady: true,
    }),
  ]);
});
