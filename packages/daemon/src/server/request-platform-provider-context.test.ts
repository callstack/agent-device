import assert from 'node:assert/strict';
import { test } from 'vitest';
import { IOS_SIMULATOR, WEB_DESKTOP_DEVICE } from '@agent-device/test-kit';
import { withTestDeviceInventoryProvider } from '@agent-device/device-selection/inventory-gateways-fixtures';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { makeIosSession } from '../__tests__/support/session-factories.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import { resolvePlatformProviderRequestContext } from './request-platform-provider-context.ts';

const OTHER_IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'sim-2',
  name: 'iPhone 17',
  kind: 'simulator',
  booted: true,
};

test('request provider context follows an explicit device selector for an existing session', async () => {
  const context = await withTestDeviceInventoryProvider(
    async () => [OTHER_IOS_SIMULATOR],
    async () =>
      await resolvePlatformProviderRequestContext({
        req: {
          ...request('apps'),
          flags: { platform: 'ios', device: 'iPhone 17' },
        },
        existingSession: makeIosSession('default'),
      }),
  );

  assert.equal(context?.device.id, OTHER_IOS_SIMULATOR.id);
  assert.equal(context?.session?.name, 'default');
});

test('request provider context skips sharded test orchestration requests', async () => {
  const context = await withTestDeviceInventoryProvider(
    async () => {
      throw new Error('A sharded test request must not resolve a provider device');
    },
    async () =>
      await resolvePlatformProviderRequestContext({
        req: { ...request('test'), flags: { platform: 'ios', shardAll: 2 } },
        existingSession: undefined,
      }),
  );

  assert.equal(context, undefined);
});

test('request provider context follows an explicit sessionless web selector', async () => {
  const context = await withTestDeviceInventoryProvider(
    async () => [WEB_DESKTOP_DEVICE],
    async () =>
      await resolvePlatformProviderRequestContext({
        req: { ...request('snapshot'), flags: { platform: 'web' } },
        existingSession: undefined,
      }),
  );

  assert.equal(context?.device.id, WEB_DESKTOP_DEVICE.id);
  assert.equal(context?.session, undefined);
});

test('request provider context preserves an explicitly empty request id', async () => {
  const context = await resolvePlatformProviderRequestContext({
    req: { ...request('snapshot'), meta: { requestId: '' } },
    existingSession: makeIosSession('ios-session'),
  });

  assert.equal(context?.requestId, '');
  assert.equal(context?.device.id, IOS_SIMULATOR.id);
});

function request(command: string): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command,
    positionals: [],
    flags: {},
    meta: { requestId: `req-${command}` },
  };
}
