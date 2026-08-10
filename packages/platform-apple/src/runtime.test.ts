import { expect, test } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform';
import type { AppleOS, DeviceInfo } from '@agent-device/kernel/device';
import { createApplePlatformRuntime } from './runtime.ts';

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
  const binding = await createApplePlatformRuntime({} as PlatformRuntimeHost).bind({
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
  expect(facts.operations.networkDump).toEqual({ available: true });
  for (const operation of ['appLogInspect', 'appLogDoctor', 'appLogStart'] as const) {
    const fact = facts.operations[operation];
    expect(fact.available).toBe(available);
    if (!available && hint) expect(fact).toHaveProperty('hint', expect.stringContaining(hint));
  }
});
