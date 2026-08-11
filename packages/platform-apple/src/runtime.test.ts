import { expect, test, vi } from 'vitest';
import type { AppleOS, DeviceInfo } from '@agent-device/kernel/device';
import { createApplePlatformRuntime } from './runtime.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';

function appleDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: 'apple-fact',
    name: 'Apple',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
    ...overrides,
  };
}

const leaves = {
  ios: appleDevice(),
  ipados: appleDevice({ appleOs: 'ipados' }),
  tvos: appleDevice({ appleOs: 'tvos', target: 'tv' }),
  macos: appleDevice({ appleOs: 'macos', kind: 'device', target: 'desktop' }),
  visionos: appleDevice({ appleOs: 'visionos' }),
  watchos: appleDevice({ appleOs: 'watchos' }),
} satisfies Record<AppleOS, DeviceInfo>;

test.each([
  ['iOS simulator', leaves.ios, true, undefined],
  [
    'iOS physical CoreDevice',
    appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
    true,
    undefined,
  ],
  [
    'iOS physical XCTest',
    appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'xctest' }),
    false,
    'CoreDevice-backed physical iOS device',
  ],
  ['iPadOS simulator', leaves.ipados, true, undefined],
  ['tvOS simulator', leaves.tvos, true, undefined],
  ['macOS host', leaves.macos, true, undefined],
  ['visionOS simulator', leaves.visionos, true, undefined],
  ['watchOS sentinel', leaves.watchos, false, 'watchOS app logs are not supported'],
])('classifies the %s leaf explicitly', async (_name, device, available, hint) => {
  const binding = await createApplePlatformRuntime(platformRuntimeHostFixture()).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  const { facts } = binding;
  expect(facts.device.providerMode).toBe('local');
  expect(facts.operations.appState).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: expect.stringContaining('session state'),
  });
  expect(binding.operations.appState).toBeUndefined();
  expect(facts.operations.networkDump).toEqual({ available: true });
  expect(facts.operations.listApps.available).toBe(
    device.appleOs !== 'watchos' && device.iosPhysicalDeviceBackend !== 'xctest',
  );
  for (const operation of ['appLogInspect', 'appLogDoctor', 'appLogStart'] as const) {
    const fact = facts.operations[operation];
    expect(fact.available).toBe(available);
    if (!available && hint) expect(fact).toHaveProperty('hint', expect.stringContaining(hint));
  }
  for (const operation of [
    'screenRecordingStart',
    'screenRecordingReattach',
    'screenRecordingCleanup',
  ] as const) {
    expect(facts.operations[operation].available).toBe(available);
  }
  if (device.iosPhysicalDeviceBackend === 'xctest') {
    expect(facts.operations.screenRecordingStart).toMatchObject({
      hint: expect.stringContaining('CoreDevice-backed physical iOS device'),
    });
  }
  if (device.appleOs === 'watchos') {
    expect(facts.operations.screenRecordingStart).toMatchObject({
      hint: 'watchOS recording is not supported.',
    });
  }
  expect(facts.operations.ensureReady.available).toBe(device.appleOs !== 'watchos');
  expect(facts.operations.bootTarget.available).toBe(
    device.appleOs !== 'macos' && device.appleOs !== 'watchos',
  );
  expect(facts.operations.bootTargetHeadless.available).toBe(false);
});

test('readiness and boot keep the Apple automation helper warm inside the platform runtime', async () => {
  const host = platformRuntimeHostFixture();
  const keepHot = vi.fn();
  let state = 'Shutdown';
  const runtime = createApplePlatformRuntime({
    ...host,
    appleTools: {
      ...host.appleTools,
      run: vi.fn(async (request) => {
        if (request.args.includes('list')) {
          return {
            stdout: JSON.stringify({ devices: { ios: [{ udid: 'apple-fact', state }] } }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (request.args.includes('boot')) state = 'Booted';
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    },
    deviceReadiness: {
      ...host.deviceReadiness,
      appleAutomation: { keepHot },
    },
  });
  const device = appleDevice({ booted: false });
  const binding = await runtime.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  await binding.operations.ensureReady?.({});
  await binding.operations.bootTarget?.({});

  expect(keepHot).toHaveBeenCalledTimes(3);
  expect(keepHot).toHaveBeenNthCalledWith(1, device);
  expect(keepHot).toHaveBeenNthCalledWith(2, device);
  expect(keepHot).toHaveBeenNthCalledWith(3, device);
});

test('macOS readiness is a no-op while boot remains unavailable', async () => {
  const host = platformRuntimeHostFixture();
  const ensureConnected = vi.fn(host.deviceReadiness.applePhysical.ensureConnected);
  const binding = await createApplePlatformRuntime({
    ...host,
    deviceReadiness: {
      ...host.deviceReadiness,
      applePhysical: { ensureConnected },
    },
  }).bind({
    device: leaves.macos,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  await expect(binding.operations.ensureReady?.({})).resolves.toMatchObject({ booted: true });
  expect(ensureConnected).not.toHaveBeenCalled();
  expect(binding.operations.bootTarget).toBeUndefined();
});

test('routes Apple app inventory through the injected host facet', async () => {
  const host = platformRuntimeHostFixture();
  const listApps = vi.fn(async () => [{ id: 'com.example.app', name: 'Example' }]);
  const runtime = createApplePlatformRuntime({
    ...host,
    appInventory: {
      ...host.appInventory,
      apple: { listApps },
    },
  });
  const device = appleDevice();
  const binding = await runtime.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  await expect(binding.operations.listApps?.({ device, filter: 'all' })).resolves.toEqual([
    { id: 'com.example.app', name: 'Example' },
  ]);
  expect(listApps).toHaveBeenCalledWith(device, 'all', expect.any(AbortSignal));
});
