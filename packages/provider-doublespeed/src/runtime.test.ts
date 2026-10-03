import { afterEach, expect, test, vi } from 'vitest';
import { createDoublespeedRuntime } from './runtime.ts';
import {
  doublespeedLease,
  doublespeedTestDependencies,
  readySimulator,
  scriptedFetch,
} from './runtime.fixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('allocates a labelled simulator per lease, serves it as inventory, and releases it', async () => {
  const { fetch, calls } = scriptedFetch([
    () => ({
      status: 202,
      body: readySimulator({ ready: false, status: 'queued', api_url: null }),
    }),
    () => ({ body: readySimulator() }),
    () => ({ body: readySimulator({ status: 'cancelled', ready: false }) }),
  ]);
  vi.stubGlobal('fetch', fetch);
  const runtime = createDoublespeedRuntime(
    { apiKey: 'dsx_test_key', device: 'iPhone 16 Pro' },
    doublespeedTestDependencies,
  );
  const lease = doublespeedLease();

  const allocated = await runtime.leaseLifecycle.allocate?.(lease);
  expect(allocated).toMatchObject({ doublespeedSimulatorId: 'sim-a' });
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
    device: 'iPhone 16 Pro',
    labels: {
      tenantId: 'team-a',
      runId: 'run-a',
      leaseId: 'lease-a',
      provider: 'doublespeed',
      source: 'agent-device-cli',
    },
    wait: true,
  });
  const inventory = await runtime.deviceInventoryProvider({
    leaseProvider: 'doublespeed',
    leaseId: 'lease-a',
    platform: 'ios',
  });
  expect(inventory).toHaveLength(1);
  const device = inventory![0]!;
  expect(device).toMatchObject({
    id: 'doublespeed:ios:lease-a',
    kind: 'simulator',
    appleOs: 'ios',
  });
  expect(runtime.ownsDevice(device)).toBe(true);
  expect(runtime.getInteractor(device)).toBeDefined();
  expect(runtime.getDeviceSession(device)).toBeDefined();
  expect(await runtime.leaseLifecycle.allocate?.(lease)).toMatchObject({
    doublespeedSimulatorId: 'sim-a',
  });
  expect(calls).toHaveLength(2);

  await expect(runtime.leaseLifecycle.release?.(lease)).resolves.toEqual({
    doublespeedSimulatorId: 'sim-a',
  });
  expect(`${calls[2]?.init.method} ${calls[2]?.url}`).toBe(
    'DELETE https://api.mac.doublespeed.ai/v1/xcode/simulators/sim-a',
  );
  expect(runtime.getInteractor(device)).toBeUndefined();
});

test('ignores leases it does not own and recovers orphaned simulators by label', async () => {
  const { fetch, calls } = scriptedFetch([
    () => ({ body: { simulators: [readySimulator({ id: 'sim-orphan' })] } }),
    () => ({ body: readySimulator({ id: 'sim-orphan', status: 'cancelled', ready: false }) }),
  ]);
  vi.stubGlobal('fetch', fetch);
  const runtime = createDoublespeedRuntime({ apiKey: 'dsx_test_key' }, doublespeedTestDependencies);

  expect(
    await runtime.leaseLifecycle.allocate?.({ ...doublespeedLease(), leaseProvider: 'limrun' }),
  ).toBeUndefined();
  expect(
    await runtime.leaseLifecycle.allocate?.({ ...doublespeedLease(), backend: 'android-instance' }),
  ).toBeUndefined();
  await expect(
    runtime.recoverExpiredLease({ ...doublespeedLease(), backend: 'android-instance' }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });

  await runtime.recoverExpiredLease(doublespeedLease('lease-orphan'));
  expect(calls[0]?.url).toBe(
    'https://api.mac.doublespeed.ai/v1/xcode/simulators?label_selector=provider%3Ddoublespeed%2CleaseId%3Dlease-orphan',
  );
  expect(`${calls[1]?.init.method} ${calls[1]?.url}`).toBe(
    'DELETE https://api.mac.doublespeed.ai/v1/xcode/simulators/sim-orphan',
  );
});

test('releases a simulator whose session never exposed an API', async () => {
  const { fetch, calls } = scriptedFetch([
    () => ({ body: readySimulator({ api_url: null, token: null }) }),
    () => ({ body: readySimulator({ status: 'cancelled', ready: false }) }),
  ]);
  vi.stubGlobal('fetch', fetch);
  const runtime = createDoublespeedRuntime({ apiKey: 'dsx_test_key' }, doublespeedTestDependencies);
  await expect(runtime.leaseLifecycle.allocate?.(doublespeedLease())).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
  });
  expect(calls[1]?.init.method).toBe('DELETE');
});

test('registers a provider-runtime owner keyed by an opaque principal', () => {
  const registration = createDoublespeedRuntime(
    { apiKey: 'dsx_test_key' },
    doublespeedTestDependencies,
    { includePlatformModule: true },
  );
  expect(registration.runtime.provider).toBe('doublespeed');
  expect(registration.platformModule.owner).toMatchObject({
    kind: 'provider-runtime',
    provider: 'doublespeed',
  });
  expect(registration.platformModule.owner.instance).not.toContain('dsx_test_key');
});
