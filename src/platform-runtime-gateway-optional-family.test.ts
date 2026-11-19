import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import { createComposedPlatformRuntimeGateway } from './platform-runtime-gateway.ts';
import { gatewayFixtureScope as scope } from './platform-runtime-gateway.fixtures.ts';

// An absent optional family (ADR 0034) is a missing plugin, not a contract error: the runtime
// lookup fails with the typed plugin-not-installed outcome before any host load, and so before
// any device binding. Required families keep the runtime-contract error.
test('an absent optional family module fails plugin-not-installed before host load or binding', async () => {
  const hostLoad = vi.fn(async () => ({}) as PlatformRuntimeHost);
  const runtimeGateway = createComposedPlatformRuntimeGateway({
    modules: new Map(),
    loadHost: hostLoad,
  });
  const vegaDevice: DeviceInfo = {
    platform: 'vega',
    id: 'vega-tv',
    name: 'Vega TV',
    kind: 'device',
    target: 'tv',
    booted: true,
  };

  await expect(runtimeGateway.inspectFacts(vegaDevice)).rejects.toMatchObject({
    code: 'UNSUPPORTED_PLATFORM',
    details: {
      reason: 'plugin-not-installed',
      family: 'vega',
      package: '@agent-device/vega',
      installCommand: 'agent-device plugins add @agent-device/vega',
    },
  });
  await expect(
    runtimeGateway.bind({ device: vegaDevice, intent: { kind: 'ordinary' }, scope }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_PLATFORM',
    details: { reason: 'plugin-not-installed', family: 'vega' },
  });
  // The lookup fails before any host load, and therefore before any device binding.
  expect(hostLoad).not.toHaveBeenCalled();
});

test('an absent required family module stays a runtime contract error', async () => {
  const runtimeGateway = createComposedPlatformRuntimeGateway({
    modules: new Map(),
    loadHost: async () => ({}) as PlatformRuntimeHost,
  });
  const androidDevice: DeviceInfo = {
    platform: 'android',
    id: 'emulator-1',
    name: 'Emulator',
    kind: 'emulator',
  };
  await expect(runtimeGateway.inspectFacts(androidDevice)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'runtime-contract-invalid' },
  });
});
