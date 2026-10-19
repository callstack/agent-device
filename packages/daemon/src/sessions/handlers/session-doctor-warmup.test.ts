import { createTestHostEnvironment } from '@agent-device/test-kit';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { beforeEach, expect, test, vi } from 'vitest';
import type { DoctorCheck } from '@agent-device/contracts/observability';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { withTestDeviceInventory } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { handleDoctorCommand } from './session-doctor.ts';
import { hostDiagnosticsFixture } from '../../__tests__/support/host-diagnostics-fixture.ts';
import { installProviderDeviceAdmission } from '../../core/provider-device-admission.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';

vi.mock('./session-doctor-app.ts', () => ({
  appendAppChecks: vi.fn(async () => {}),
}));
vi.mock('./session-doctor-metro.ts', () => ({
  probeMetro: vi.fn(async () => ({ id: 'metro', status: 'pass', summary: 'mocked' })),
}));

const IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'doctor-sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

const warmupCheck = vi.fn<NonNullable<ReturnType<typeof hostDiagnosticsFixture>['warmupCheck']>>();
const hostDiagnostics = hostDiagnosticsFixture({ warmupCheck });

beforeEach(() => {
  warmupCheck.mockReset();
  warmupCheck.mockResolvedValue(undefined);
  installProviderDeviceAdmission({ isActive: () => false });
});

async function runDoctorWithSessionDevice(device: DeviceInfo): Promise<DaemonResponse | null> {
  const sessionStore = makeSessionStore('agent-device-doctor-warmup-');
  sessionStore.publish('doctor-session', {
    name: 'doctor-session',
    createdAt: Date.now(),
    device,
    actions: [],
  });
  return await withTestDeviceInventory(
    {},
    async () =>
      await handleDoctorCommand({
        host: createTestHostEnvironment(),
        req: {
          token: 't',
          session: 'doctor-session',
          command: 'doctor',
          positionals: [],
          flags: { session: 'doctor-session' },
        },
        sessionName: 'doctor-session',
        sessionStore,
        hostDiagnostics,
      }),
  );
}

async function runSessionlessDoctor(
  source: 'host' | 'provider',
  flags: { targetApp?: string } = {},
): Promise<DaemonResponse | null> {
  const inventory =
    source === 'host'
      ? { local: async () => [IOS_SIMULATOR] }
      : {
          provider: {
            discover: async () => ({ kind: 'inventory' as const, devices: [IOS_SIMULATOR] }),
          },
        };
  return await withTestDeviceInventory(
    inventory,
    async () =>
      await handleDoctorCommand({
        host: createTestHostEnvironment(),
        req: { token: 't', session: 'default', command: 'doctor', positionals: [], flags },
        sessionName: 'default',
        sessionStore: makeSessionStore('agent-device-doctor-warmup-'),
        hostDiagnostics,
      }),
  );
}

function readCheck(response: DaemonResponse | null, id: string): Record<string, unknown> | null {
  if (!response?.ok) return null;
  const checks = (response.data as { checks?: Array<Record<string, unknown>> }).checks ?? [];
  return checks.find((check) => check.id === id) ?? null;
}

const RUNNER_CACHE_CHECKS: DoctorCheck[] = [
  {
    id: 'ios-runner-cache',
    status: 'pass',
    summary: 'iOS runner build started in the background',
  },
  { id: 'ios-runner-cache', status: 'pass', summary: 'iOS runner artifact cached' },
];

test.each(RUNNER_CACHE_CHECKS)(
  'doctor reports the warmup check the host returned ($summary)',
  async (check) => {
    warmupCheck.mockResolvedValue(check);

    const response = await runDoctorWithSessionDevice(IOS_SIMULATOR);

    expect(response?.ok).toBe(true);
    expect(warmupCheck).toHaveBeenCalledTimes(1);
    expect(readCheck(response, 'ios-runner-cache')).toMatchObject({
      status: check.status,
      summary: check.summary,
    });
  },
);

test('doctor offers every session device to the host warmup and adds no line when it declines', async () => {
  const device: DeviceInfo = { ...IOS_SIMULATOR, id: 'doctor-device-1', kind: 'device' };

  const response = await runDoctorWithSessionDevice(device);

  expect(response?.ok).toBe(true);
  expect(warmupCheck).toHaveBeenCalledTimes(1);
  expect(warmupCheck).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'device' }),
    expect.any(Object),
  );
  expect(readCheck(response, 'ios-runner-cache')).toBeNull();
});

test('doctor hands the warmup the active provider ownership of the device', async () => {
  const seen: boolean[] = [];
  warmupCheck.mockImplementation(async (device, context) => {
    seen.push(context.isProviderDevice(device));
    return undefined;
  });

  await runDoctorWithSessionDevice(IOS_SIMULATOR);
  installProviderDeviceAdmission({ isActive: () => true });
  const response = await runDoctorWithSessionDevice(IOS_SIMULATOR);

  expect(response?.ok).toBe(true);
  expect(seen).toEqual([false, true]);
  expect(readCheck(response, 'ios-runner-cache')).toBeNull();
});

const SESSIONLESS_WARMUP_CANDIDATES = [
  { name: 'an inventory simulator', flags: {} },
  { name: 'the --app device', flags: { targetApp: 'com.example.demo' } },
];

test.each(SESSIONLESS_WARMUP_CANDIDATES)(
  'doctor warms the runner cache for $name this host discovered',
  async ({ flags }) => {
    const response = await runSessionlessDoctor('host', flags);

    expect(response?.ok).toBe(true);
    expect(warmupCheck).toHaveBeenCalledTimes(1);
    expect(warmupCheck).toHaveBeenCalledWith(
      expect.objectContaining({ id: IOS_SIMULATOR.id }),
      expect.any(Object),
    );
  },
);

test.each(SESSIONLESS_WARMUP_CANDIDATES)(
  'doctor starts no runner warmup for $name a provider reported',
  async ({ flags }) => {
    const response = await runSessionlessDoctor('provider', flags);

    expect(response?.ok).toBe(true);
    expect(warmupCheck).not.toHaveBeenCalled();
  },
);
