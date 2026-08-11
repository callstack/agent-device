import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { LINUX_DEVICE, makeSessionStore } from '../../../__tests__/test-utils/index.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
} from '@agent-device/contracts/platform';
import { handleDoctorCommand } from '../session-doctor.ts';

vi.mock('../session-doctor-device.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-doctor-device.ts')>();
  return {
    ...actual,
    appendDeviceInventoryCheck: vi.fn(async () => undefined),
  };
});
vi.mock('../session-doctor-toolchain.ts', () => ({
  appendToolchainChecks: vi.fn(async () => {}),
}));
vi.mock('../session-doctor-android.ts', () => ({
  appendAndroidChecks: vi.fn(async () => {}),
}));
vi.mock('../session-doctor-metro.ts', () => ({
  probeMetro: vi.fn(async () => ({ id: 'metro', status: 'pass', summary: 'mocked' })),
}));
vi.mock('../session-doctor-web.ts', () => ({
  appendWebBrowserLifecycleCheck: vi.fn(async () => {}),
}));

test('doctor app checks retain runtime admission failures as a failed target-app check', async () => {
  const sessionName = 'doctor-app-runtime-failure';
  const sessionStore = makeSessionStore('agent-device-doctor-app-runtime-');
  sessionStore.set(sessionName, {
    name: sessionName,
    device: LINUX_DEVICE,
    createdAt: Date.now(),
    actions: [],
  });
  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => {
    throw new AppError('COMMAND_FAILED', 'runtime facts admission failed');
  });
  const bindDevice: BindDeviceRuntime = vi.fn(async () => {
    throw new AppError('COMMAND_FAILED', 'runtime binding should not be reached');
  });

  const response = await handleDoctorCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'doctor',
      positionals: [],
      flags: { session: sessionName, targetApp: 'com.example.app' },
    },
    sessionName,
    sessionStore,
    inspectFacts,
    bindDevice,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  const checks = (response.data as { checks: Array<Record<string, unknown>> }).checks;
  expect(checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'target-app',
        status: 'fail',
        summary: expect.stringContaining('runtime facts admission failed'),
      }),
    ]),
  );
  expect(inspectFacts).toHaveBeenCalledOnce();
});

test('doctor preserves the legacy unsupported HarmonyOS target-app check', async () => {
  const harmonyDevice = {
    platform: 'harmonyos' as const,
    id: 'harmony-doctor-device',
    name: 'HarmonyOS doctor device',
    kind: 'device' as const,
    target: 'mobile' as const,
    booted: true,
  };
  const available = { available: true } as const;
  const unavailable = { available: false, reason: 'unsupported-platform-leaf' } as const;
  const runtimeFacts = (): RuntimeFacts<PlatformRuntimeOperations> => ({
    device: { family: 'harmonyos', kind: 'device', target: 'mobile', providerMode: 'local' },
    operations: {
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
      listApps: available,
      networkDump: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: available,
      bootTarget: unavailable,
      bootTargetHeadless: unavailable,
    },
  });
  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => runtimeFacts());
  const ensureReady = vi.fn(async () => ({ ...harmonyDevice, booted: true }));
  const listApps = vi.fn(async () => [{ id: 'com.example.application', name: 'application' }]);
  const bindCount = vi.fn();
  const bindDevice: BindDeviceRuntime = async (device, use) => {
    bindCount();
    return narrowDeviceBinding(
      {
        device,
        owner: localRuntimeOwner('harmonyos'),
        facts: runtimeFacts(),
        operations: { ensureReady, listApps },
        [Symbol.asyncDispose]: async () => {},
      },
      use,
    );
  };
  const sessionName = 'doctor-harmony-app-runtime';
  const sessionStore = makeSessionStore('agent-device-doctor-harmony-');
  sessionStore.set(sessionName, {
    name: sessionName,
    device: harmonyDevice,
    createdAt: Date.now(),
    actions: [],
  });

  const response = await handleDoctorCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'doctor',
      positionals: [],
      flags: { session: sessionName, targetApp: 'com.example.application' },
    },
    sessionName,
    sessionStore,
    inspectFacts,
    bindDevice,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  const checks = (response.data as { checks: Array<Record<string, unknown>> }).checks;
  expect(checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'target-app',
        status: 'info',
        summary: 'Target app installation checks are not supported for harmonyos.',
      }),
    ]),
  );
  expect(inspectFacts).not.toHaveBeenCalled();
  expect(bindCount).not.toHaveBeenCalled();
  expect(ensureReady).not.toHaveBeenCalled();
  expect(listApps).not.toHaveBeenCalled();
});
