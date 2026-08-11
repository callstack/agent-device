import { expect, test } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyPlatformRuntime } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-fact',
  name: 'HarmonyOS',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

test('classifies the HarmonyOS runtime denominator', async () => {
  const host = {
    processTransports: { resolve: async () => ({ mode: 'local' as const }) },
  } as unknown as PlatformRuntimeHost;
  const binding = await createHarmonyPlatformRuntime(host).bind({
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
  expect(facts.operations.networkDump).toMatchObject({
    available: false,
    reason: 'unsupported-platform-leaf',
  });
  expect(facts.operations.appLogInspect).toEqual({ available: true });
  expect(facts.operations.screenRecordingStart).toEqual({ available: true });
  expect(facts.operations.screenRecordingReattach).toEqual({ available: true });
  expect(facts.operations.screenRecordingCleanup).toEqual({ available: true });
});
