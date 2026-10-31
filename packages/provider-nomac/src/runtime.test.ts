import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { fakeNomac } from './fake-nomac.fixtures.ts';
import { createNomacRuntime, leaseLabel, leaseRequestKey } from './runtime.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

const lease = (leaseId: string): DeviceLease => ({
  leaseId,
  tenantId: 't',
  runId: 'r',
  backend: 'ios-instance',
  leaseProvider: 'nomac',
  createdAt: 0,
  heartbeatAt: 0,
  expiresAt: 0,
});

function runtimeWith(nomac: ReturnType<typeof fakeNomac>, apiKey = 'nmk_test') {
  return createNomacRuntime({
    apiKey,
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: nomac.fetch,
    runtimeInstance: 'test',
  }).runtime;
}

test("a lease starts a phone under the lease's own request key and label, waits for it, and its release stops it", async () => {
  const nomac = fakeNomac({ readyAfter: 2 });
  const runtime = runtimeWith(nomac);
  const allocated = await runtime.leaseLifecycle.allocate!(lease('lease-a'), {
    flags: { device: 'ipad' },
  });
  expect(allocated).toMatchObject({
    nomacPhoneId: expect.stringMatching(/^ses_/),
    device: { id: 'nomac:ios:lease-a', model: 'iPad Pro 11-inch (M5)' },
  });
  const start = nomac.seen.find(
    (r) => r.method === 'POST' && r.path === '/api/v1/simulator/sessions',
  )!;
  expect(start.key).toBe('agent-device-lease-lease-a');
  expect(start.body).toEqual({ device: 'ipad', label: 'agent-device-lease-a' });
  expect(start.auth).toBe('Bearer nmk_test');
  // The same lease again answers the same phone; the inventory names it; it has an interactor.
  expect((await runtime.leaseLifecycle.allocate!(lease('lease-a'))) as object).toMatchObject({
    nomacPhoneId: (allocated as { nomacPhoneId: string }).nomacPhoneId,
  });
  const [device] =
    (await runtime.deviceInventoryProvider({ leaseProvider: 'nomac', leaseId: 'lease-a' })) ?? [];
  expect(device?.id).toBe('nomac:ios:lease-a');
  expect(runtime.getInteractor(device!)).toBeDefined();
  expect(
    await runtime.deviceInventoryProvider({ leaseProvider: 'limrun', leaseId: 'lease-a' }),
  ).toBeNull();
  await runtime.leaseLifecycle.release!(lease('lease-a'));
  expect(nomac.seen.some((r) => r.method === 'DELETE')).toBe(true);
  expect(runtime.getInteractor(device!)).toBeUndefined();
});

test('a phone that does not start is a clear failure; a refused profile field never starts one', async () => {
  const nomac = fakeNomac({ failStart: 'capacity_unavailable' });
  const runtime = runtimeWith(nomac);
  await expect(runtime.leaseLifecycle.allocate!(lease('lease-b'))).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { hint: expect.stringMatching(/in use for 5 minutes/) },
  });
  const before = nomac.seen.length;
  await expect(
    runtime.leaseLifecycle.allocate!(lease('lease-c'), { flags: { providerTimezone: 'UTC' } }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(nomac.seen.length).toBe(before);
});

test("a lease the daemon lost track of is released by its label; another provider's lease is not NoMac's", async () => {
  const nomac = fakeNomac();
  await runtimeWith(nomac).leaseLifecycle.allocate!(lease('lease-d'));
  const restarted = runtimeWith(nomac);
  expect(await restarted.leaseLifecycle.release!(lease('lease-d'))).toMatchObject({
    nomacPhoneCount: 1,
  });
  expect(
    await restarted.leaseLifecycle.allocate!({ ...lease('lease-e'), leaseProvider: 'limrun' }),
  ).toBeUndefined();
});

test('a daemon with no key starts; a lease refuses and names the variable', async () => {
  const runtime = runtimeWith(fakeNomac(), '');
  await expect(runtime.leaseLifecycle.allocate!(lease('lease-f'))).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
    message: expect.stringMatching(/NOMAC_API_KEY/),
  });
  await runtime.shutdown();
});

test('a Simulator .app is packed, uploaded, unpacked and installed, answering its bundle id; an .ipa is refused', async () => {
  const nomac = fakeNomac();
  const runtime = runtimeWith(nomac);
  await runtime.leaseLifecycle.allocate!(lease('lease-g'));
  const [device] = (await runtime.deviceInventoryProvider({
    leaseProvider: 'nomac',
    leaseId: 'lease-g',
  }))!;
  const dir = mkdtempForTestSync('nomac-app-');
  fs.mkdirSync(path.join(dir, 'Demo.app'));
  fs.writeFileSync(path.join(dir, 'Demo.app', 'Info.plist'), '<plist/>');
  const installed = await runtime.installApp!(
    device!,
    'dev.simtap.demo',
    path.join(dir, 'Demo.app'),
  );
  expect(installed).toEqual({
    bundleId: 'dev.simtap.demo',
    launchTarget: 'dev.simtap.demo',
    appName: 'Demo',
  });
  expect(nomac.seen.find((r) => r.path.endsWith('/tools/app_control'))?.body).toEqual({
    action: 'install',
    app: '/Volumes/nmw-x/src/agent-device-app/Demo.app',
  });
  fs.writeFileSync(path.join(dir, 'Demo.ipa'), 'x');
  await expect(
    runtime.installApp!(device!, 'dev.simtap.demo', path.join(dir, 'Demo.ipa')),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
});

test("request keys and labels fit NoMac's rules, hashing a lease id that does not", () => {
  expect(leaseRequestKey('abc-123')).toBe('agent-device-lease-abc-123');
  expect(leaseLabel('abc-123')).toBe('agent-device-abc-123');
  expect(leaseRequestKey('a b/c')).toMatch(/^agent-device-lease-[a-f0-9]{32}$/);
  expect(leaseLabel('x'.repeat(80))).toMatch(/^agent-device-[a-f0-9]{32}$/);
});
