import { describe, expect, test } from 'vitest';
import type { ProviderDeviceInventorySource } from '@agent-device/contracts/device';
import { createTestDeviceInventoryGateways } from '../inventory-gateways.fixtures.ts';

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
} as const;

describe('test device inventory gateways', () => {
  test('a malformed provider outcome fails closed through the shared composer assertion', async () => {
    const gateways = createTestDeviceInventoryGateways({
      provider: { discover: async () => undefined } as unknown as ProviderDeviceInventorySource,
    });
    await expect(
      gateways.providerFirst.discover({ platform: 'android' }, scope),
    ).rejects.toMatchObject({ details: { reason: 'provider_inventory_contract_violation' } });
  });

  test('a declined provider falls through to the local inventory', async () => {
    const device = {
      platform: 'android' as const,
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator' as const,
      booted: true,
    };
    const gateways = createTestDeviceInventoryGateways({
      provider: { discover: async () => ({ kind: 'declined' }) },
      local: async () => [device],
    });
    expect(await gateways.providerFirst.discover({ platform: 'android' }, scope)).toEqual([device]);
  });
});
