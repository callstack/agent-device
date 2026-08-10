import { expect, test } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAndroidPlatformRuntime } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'android-fact',
  name: 'Android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test.each([
  ['emulator', device],
  ['device', { ...device, kind: 'device' as const }],
])('classifies the Android %s runtime denominator', async (_name, runtimeDevice) => {
  const host = {
    processTransports: { resolve: async () => ({ mode: 'local' as const }) },
  } as unknown as PlatformRuntimeHost;
  const binding = await createAndroidPlatformRuntime(host).bind({
    device: runtimeDevice,
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
});
