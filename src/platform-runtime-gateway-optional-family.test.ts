import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import { createComposedPlatformRuntimeGateway } from './platform-runtime-gateway.ts';
import {
  gatewayFixtureScope as scope,
  runtimeModuleRegistryFixture as moduleRegistry,
} from './platform-runtime-gateway.fixtures.ts';

// An absent optional family (ADR 0034) is a missing plugin, not a contract error: the runtime
// lookup fails with the typed plugin-not-installed outcome before any host load, and so before
// any device binding. The module registry answers presence, so the gateway owns no presence rule.
test('an absent Linux family module fails plugin-not-installed before host load or binding', async () => {
  // Linux is not bundled any more, so a host without the plugin reaches the same typed outcome as
  // any other optional family: the module registry answers absence and the gateway loads nothing.
  const hostLoad = vi.fn(async () => ({}) as PlatformRuntimeHost);
  const runtimeGateway = createComposedPlatformRuntimeGateway({
    modules: moduleRegistry(),
    loadHost: hostLoad,
  });
  const linuxDevice: DeviceInfo = {
    platform: 'linux',
    id: 'local',
    kind: 'device',
    target: 'desktop',
    name: 'Linux desktop',
  };

  await expect(runtimeGateway.inspectFacts(linuxDevice)).rejects.toMatchObject({
    code: 'UNSUPPORTED_PLATFORM',
    details: {
      reason: 'plugin-not-installed',
      family: 'linux',
      package: '@agent-device/linux',
      installCommand: expect.stringContaining('agent-device plugins add @agent-device/linux'),
    },
  });
  await expect(
    runtimeGateway.bind({ device: linuxDevice, intent: { kind: 'ordinary' }, scope }),
  ).rejects.toMatchObject({
    details: { reason: 'plugin-not-installed', family: 'linux' },
  });
  expect(hostLoad).not.toHaveBeenCalled();
});

test('an absent Vega family module fails plugin-not-installed before host load or binding', async () => {
  const hostLoad = vi.fn(async () => ({}) as PlatformRuntimeHost);
  const runtimeGateway = createComposedPlatformRuntimeGateway({
    modules: moduleRegistry(),
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
