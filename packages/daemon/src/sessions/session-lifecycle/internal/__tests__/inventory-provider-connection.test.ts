import { test, expect, vi } from 'vitest';
import { withTestDeviceInventory } from '@agent-device/device-selection/inventory-gateways-fixtures';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { makeSessionStore } from '../../../../__tests__/support/store-factory.ts';
import type { DaemonRequest } from '../../../../core/daemon-request.ts';
import { handleSessionInventoryCommands } from '../inventory.ts';

const localSimulator: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'local-simulator',
  name: 'iPhone 17',
  kind: 'simulator',
  booted: true,
};
const limrunDevice: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'limrun:ios:lease-1',
  name: 'Limrun ios ios_euna',
  kind: 'simulator',
  booted: true,
};

// #4304: on a Limrun connection, `devices` listed this host's simulators instead of the instance.
test('devices on a provider connection lists the leased device, not the host inventory', async () => {
  const local = vi.fn(async () => [localSimulator]);
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'devices',
    positionals: [],
    flags: { platform: 'ios', leaseProvider: 'limrun' },
    meta: { tenantId: 'limrun', runId: 'run-1', leaseId: 'lease-1', leaseProvider: 'limrun' },
  };
  const response = await withTestDeviceInventory(
    {
      local,
      provider: {
        discover: async (request) =>
          request.leaseProvider === 'limrun' && request.leaseId === 'lease-1'
            ? { kind: 'inventory', devices: [limrunDevice] }
            : { kind: 'declined' },
      },
    },
    () =>
      handleSessionInventoryCommands({
        host: createTestHostEnvironment(),
        platformServices: daemonPlatformServicesFixture(),
        req,
        sessionName: 'limrun:default',
        sessionStore: makeSessionStore('agent-device-inventory-provider-'),
      }),
  );
  expect(response).toMatchObject({ ok: true, data: { devices: [{ id: limrunDevice.id }] } });
  expect(response?.ok && response.data?.devices).toHaveLength(1);
  expect(local).not.toHaveBeenCalled();
});

// A proxy connection defers its lease for `devices` and lists the devices of the host behind it.
test('devices on a proxy connection without a lease lists the host inventory', async () => {
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'devices',
    positionals: [],
    flags: { platform: 'ios', leaseProvider: 'proxy' },
    meta: { tenantId: 'tenant-a', runId: 'run-1', leaseProvider: 'proxy' },
  };
  const response = await withTestDeviceInventory({ local: async () => [localSimulator] }, () =>
    handleSessionInventoryCommands({
      host: createTestHostEnvironment(),
      platformServices: daemonPlatformServicesFixture(),
      req,
      sessionName: 'tenant-a:default',
      sessionStore: makeSessionStore('agent-device-inventory-proxy-'),
    }),
  );
  expect(response).toMatchObject({ ok: true, data: { devices: [{ id: localSimulator.id }] } });
});
