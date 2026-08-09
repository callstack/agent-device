import { test, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import { makeAndroidSession, makeSessionStore } from '../../../__tests__/test-utils/index.ts';
import { withTestDeviceInventoryProvider as withTargetDeviceResolutionScope } from '../../../__tests__/test-utils/device-inventory-gateways.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
  type AppLogRuntimeOperations,
  type DeviceBinding,
  type RuntimeProviderMode,
} from '@agent-device/contracts/platform';
import type { BindDeviceRuntime } from '../../request-runtime-binding.ts';
import { handleSessionCommands } from '../session.ts';

function assertAndroidCapabilityHonesty(availableCommands: unknown): void {
  expect(availableCommands).not.toContain(PUBLIC_COMMANDS.prepare);
  expect(availableCommands).not.toContain(PUBLIC_COMMANDS.viewport);
}

test('capabilities reports supported commands for the selected session device', async () => {
  const sessionName = 'android-capabilities';
  const sessionStore = makeSessionStore('agent-device-capabilities-');
  sessionStore.set(sessionName, makeAndroidSession(sessionName));
  const runtime = createAdmissionRuntime({ available: true, providerMode: 'local' });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: PUBLIC_COMMANDS.capabilities,
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    bindDevice: runtime.bindDevice,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;

  expect(response.data?.device).toMatchObject({
    platform: 'android',
    kind: 'emulator',
  });
  expect(response.data?.availableCommands).toEqual(
    expect.arrayContaining([
      'open',
      'screenshot',
      'snapshot',
      'appstate',
      'press',
      'fill',
      'network',
      'perf',
      PUBLIC_COMMANDS.logs,
      PUBLIC_COMMANDS.gesture,
    ]),
  );
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.capabilities);
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.devices);
  assertAndroidCapabilityHonesty(response.data?.availableCommands);
  expect(runtime.uses).toEqual([{ required: [], preferred: ['appLogInspect'] }]);
});

test('capabilities excludes logs from an unavailable provider-mode XCTest runtime fact', async () => {
  const sessionName = 'provider-xctest-capabilities';
  const sessionStore = makeSessionStore('agent-device-capabilities-provider-xctest-');
  sessionStore.set(sessionName, {
    name: sessionName,
    device: {
      platform: 'apple',
      appleOs: 'ios',
      id: 'provider-ios-device',
      name: 'Provider iPhone',
      kind: 'device',
      iosPhysicalDeviceBackend: 'xctest',
    },
    createdAt: Date.now(),
    actions: [],
  });
  const runtime = createAdmissionRuntime({
    available: false,
    providerMode: 'provider-runtime',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: PUBLIC_COMMANDS.capabilities,
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    bindDevice: runtime.bindDevice,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.logs);
  expect(runtime.uses).toEqual([{ required: [], preferred: ['appLogInspect'] }]);
});

test('capabilities accepts a stopped Android AVD placeholder for explicit platform discovery', async () => {
  const stoppedAvd: DeviceInfo = {
    platform: 'android',
    id: 'Pixel_8_API_35',
    name: 'Pixel 8 API 35',
    kind: 'emulator',
    booted: false,
  };
  const sessionStore = makeSessionStore('agent-device-capabilities-stopped-avd-');

  const response = await withTargetDeviceResolutionScope(
    async (request) => (request.platform === 'android' ? [stoppedAvd] : []),
    async () =>
      await handleSessionCommands({
        req: {
          token: 't',
          session: 'default',
          command: PUBLIC_COMMANDS.capabilities,
          positionals: [],
          flags: { platform: 'android' },
        },
        sessionName: 'default',
        logPath: path.join(os.tmpdir(), 'daemon.log'),
        sessionStore,
        invoke: async () => ({ ok: true, data: {} }),
      }),
  );

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;

  expect(response.data?.device).toMatchObject({
    platform: 'android',
    id: 'Pixel_8_API_35',
    kind: 'emulator',
    booted: false,
  });
  expect(response.data?.availableCommands).toEqual(
    expect.arrayContaining(['open', 'screenshot', 'snapshot', 'press', 'fill']),
  );
});

function createAdmissionRuntime(options: {
  available: boolean;
  providerMode: RuntimeProviderMode;
}) {
  const uses: Array<{ required: readonly string[]; preferred: readonly string[] }> = [];
  const bindDevice: BindDeviceRuntime = async (device, use) => {
    uses.push({ required: [...use.required], preferred: [...use.preferred] });
    const unavailable = {
      available: false as const,
      reason:
        options.providerMode === 'provider-runtime'
          ? ('unsupported-provider-mode' as const)
          : ('owner-capability-missing' as const),
    };
    const binding: DeviceBinding<AppLogRuntimeOperations> = {
      device,
      owner:
        options.providerMode === 'provider-runtime'
          ? providerRuntimeOwner('test', 'capabilities')
          : localRuntimeOwner(device.platform),
      facts: {
        device: {
          family: device.platform,
          ...(device.appleOs === undefined ? {} : { appleOs: device.appleOs }),
          kind: device.kind,
          ...(device.target === undefined ? {} : { target: device.target }),
          ...(device.iosPhysicalDeviceBackend === undefined
            ? {}
            : { iosPhysicalDeviceBackend: device.iosPhysicalDeviceBackend }),
          providerMode: options.providerMode,
        },
        operations: {
          appLogInspect: options.available ? { available: true } : unavailable,
          appLogDoctor: unavailable,
          appLogStart: unavailable,
          appLogReattach: unavailable,
          appLogCleanup: unavailable,
        },
      },
      operations: options.available ? { appLogInspect: async () => ({ backend: 'android' }) } : {},
      [Symbol.asyncDispose]: async () => {},
    };
    return narrowDeviceBinding(binding, use);
  };
  return { bindDevice, uses };
}
