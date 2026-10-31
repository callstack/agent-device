import { expect, test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { fakeNomac } from './fake-nomac.fixtures.ts';
import { createNomacRuntime } from './runtime.ts';

const lease: DeviceLease = {
  leaseId: 'lease-p',
  tenantId: 't',
  runId: 'r',
  backend: 'ios-instance',
  leaseProvider: 'nomac',
  createdAt: 0,
  heartbeatAt: 0,
  expiresAt: 0,
};
const host = {
  snapshot: { presentIosAcquisition: async () => ({}) },
  appleDeployment: { prepareArtifact: async () => ({}) },
} as unknown as PlatformRuntimeHost;

async function setup() {
  const nomac = fakeNomac();
  const { runtime, platformModule } = createNomacRuntime({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: nomac.fetch,
    runtimeInstance: 'test',
  });
  const owner = await platformModule.loadRuntime(host);
  return { runtime, owner, nomac };
}

test("a live phone's facts: what NoMac serves is available, every gap says why and where to go", async () => {
  const { runtime, owner } = await setup();
  await runtime.leaseLifecycle.allocate!(lease);
  const [device] = (await runtime.deviceInventoryProvider({
    leaseProvider: 'nomac',
    leaseId: 'lease-p',
  }))!;
  const facts = (await owner.inspectFacts(device!)).operations as Record<
    string,
    { available: boolean; hint?: string }
  >;
  for (const op of [
    'captureSnapshot',
    'captureScreenshot',
    'tapPoint',
    'longPressPoint',
    'fillPoint',
    'focusPoint',
    'typeText',
    'scrollDirection',
    'back',
    'home',
    'openApplication',
    'closeApplication',
    'deployApp',
    'ensureReady',
  ]) {
    expect(facts[op]?.available, op).toBe(true);
  }
  for (const op of [
    'setOrientation',
    'readClipboard',
    'appLogStart',
    'listApps',
    'performGesturePlan',
    'setSetting',
    'acceptAlert',
    'configureProviderPortReverse',
    'uninstallApp',
  ]) {
    expect(facts[op]?.available, op).toBe(false);
  }
  expect(JSON.stringify(facts.configureProviderPortReverse)).toMatch(/cloud tunnel/);
  expect(owner.ownsDevice(device!)).toBe(true);
});

test('a phone that is no longer live reports nothing available and refuses to bind', async () => {
  const { runtime, owner } = await setup();
  await runtime.leaseLifecycle.allocate!(lease);
  const [device] = (await runtime.deviceInventoryProvider({
    leaseProvider: 'nomac',
    leaseId: 'lease-p',
  }))!;
  await runtime.leaseLifecycle.release!(lease);
  const facts = (await owner.inspectFacts(device!)).operations as Record<
    string,
    { available: boolean }
  >;
  expect(Object.values(facts).every((f) => !f.available)).toBe(true);
  await expect(
    owner.bind({
      device: device!,
      intent: { kind: 'ordinary' },
      scope: { signal: new AbortController().signal } as never,
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
});

test("a live phone binds its operations without a tool call, and a bound one reaches the phone's tools", async () => {
  const { runtime, owner, nomac } = await setup();
  await runtime.leaseLifecycle.allocate!(lease);
  const [device] = (await runtime.deviceInventoryProvider({
    leaseProvider: 'nomac',
    leaseId: 'lease-p',
  }))!;
  const binding = await owner.bind({
    device: device!,
    intent: { kind: 'ordinary' },
    scope: { signal: new AbortController().signal } as never,
  });
  const ops = binding.operations as Record<string, unknown>;
  for (const op of [
    'captureSnapshot',
    'captureScreenshot',
    'tapPoint',
    'typeText',
    'scrollDirection',
    'back',
    'home',
    'openApplication',
    'deployApp',
    'deployMaterializedApp',
  ]) {
    expect(typeof ops[op], op).toBe('function');
  }
  expect(ops.setOrientation).toBeUndefined();
  expect(await (ops.ensureReady as () => Promise<{ booted: boolean }>)()).toMatchObject({
    booted: true,
  });
  expect(nomac.seen.filter((r) => r.path.includes('/tools/')).length).toBe(0);
  await (ops.tapPoint as (input: unknown) => Promise<unknown>)({
    point: { x: 201, y: 350 },
    options: {
      button: 'primary',
      count: 1,
      intervalMs: 0,
      holdMs: 0,
      jitterPx: 0,
      doubleTap: false,
    },
  });
  await (ops.triggerAppEvent as (input: unknown) => Promise<unknown>)({
    eventUrl: 'demo://items/3',
  });
  expect(
    nomac.seen
      .filter((r) => r.path.includes('/tools/'))
      .map((r) => [r.path.split('/').pop(), r.body]),
  ).toEqual([
    ['ui_act', { steps: ['tap @201,350'] }],
    ['app_control', { action: 'open_url', value: 'demo://items/3' }],
  ]);
  await binding[Symbol.asyncDispose]();
});
