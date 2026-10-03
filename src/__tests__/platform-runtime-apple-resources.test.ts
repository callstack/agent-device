import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { appleSessionObservation } from '../platform-runtime-apple-resources.ts';
import { withTestDeviceInventory } from './test-utils/device-inventory-gateways.ts';

test('foreground observation uses request-local inventory without consulting a provider', async () => {
  const local = vi.fn(async () => []);
  const provider = { discover: vi.fn(async () => ({ kind: 'declined' as const })) };

  await expect(
    withTestDeviceInventory({ local, provider }, () =>
      appleSessionObservation.resolveSoleForegroundApp(),
    ),
  ).resolves.toBeUndefined();
  expect(local).toHaveBeenCalledOnce();
  expect(provider.discover).not.toHaveBeenCalled();
});

test('foreground observation requires the request inventory context', async () => {
  await expect(appleSessionObservation.resolveSoleForegroundApp()).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'device_inventory_context_unavailable' },
  });
});

test.each([
  new AppError('COMMAND_FAILED', 'probe failed', { reason: 'request_canceled' }),
  new DOMException('probe failed', 'AbortError'),
])('foreground observation propagates control flow: %s', async (error) => {
  await expect(
    withTestDeviceInventory(
      {
        local: async () => {
          throw error;
        },
      },
      () => appleSessionObservation.resolveSoleForegroundApp(),
    ),
  ).rejects.toBe(error);
});

test('the same message without a control-flow reason remains inconclusive', async () => {
  await expect(
    withTestDeviceInventory(
      {
        local: async () => {
          throw new AppError('COMMAND_FAILED', 'probe failed');
        },
      },
      () => appleSessionObservation.resolveSoleForegroundApp(),
    ),
  ).resolves.toBeUndefined();
});
