import { expect, test, vi } from 'vitest';
import { withTestDeviceInventory } from '@agent-device/device-selection/inventory-gateways-fixtures';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest } from '../daemon-request.ts';
import {
  resolveRequestTargetDevice,
  resolveRequestTargetDeviceSelection,
} from '../request-device-resolution.ts';

const device: DeviceInfo = {
  id: 'local-simulator',
  name: 'iPhone',
  platform: 'apple',
  appleOs: 'ios',
  kind: 'simulator',
  booted: true,
};

for (const resolve of [resolveRequestTargetDevice, resolveRequestTargetDeviceSelection]) {
  test(`${resolve.name} carries provider metadata into inventory before local selection`, async () => {
    const local = vi.fn(async () => [device]);
    const req: DaemonRequest = {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['com.apple.Preferences'],
      flags: { platform: 'ios' },
      meta: { leaseProvider: 'limrun' },
    };
    await expect(
      withTestDeviceInventory({ local }, async () => {
        await resolve(req, { env: {} });
      }),
    ).rejects.toMatchObject({
      code: 'DEVICE_NOT_FOUND',
      details: { reason: 'provider_instance_unallocated' },
    });
    expect(local).not.toHaveBeenCalled();
  });
}

test('request lease metadata overrides stale selector flags and selects the allocated device', async () => {
  const allocated: DeviceInfo = { ...device, id: 'allocated-simulator' };
  const local = vi.fn(async () => [device]);
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'boot',
    positionals: [],
    flags: { platform: 'ios', leaseProvider: 'stale', leaseId: 'stale-lease' },
    meta: { leaseProvider: 'limrun', leaseId: 'current-lease' },
  };
  const selection = await withTestDeviceInventory(
    {
      local,
      provider: {
        discover: async (request) => ({
          kind: 'inventory',
          devices:
            request.leaseProvider === 'limrun' && request.leaseId === 'current-lease'
              ? [allocated]
              : [],
        }),
      },
    },
    () => resolveRequestTargetDeviceSelection(req, { env: {} }),
  );
  expect(selection.device).toEqual(allocated);
  expect(selection.source).toBe('provider');
  expect(local).not.toHaveBeenCalled();
});
