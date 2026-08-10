import type { ProviderDeviceInventorySource } from '@agent-device/contracts/device';
import type { PlatformRequestScope } from '@agent-device/contracts/platform';
import { expect, test } from 'vitest';
import { createTestDeviceInventoryGateways } from './device-inventory-gateways.ts';

const scope: PlatformRequestScope = Object.freeze({
  signal: new AbortController().signal,
  diagnostics: Object.freeze({ emit: () => {} }),
  progress: Object.freeze({ report: () => {} }),
});

test('test inventory gateways preserve the production fail-closed provider contract', async () => {
  const gateways = createTestDeviceInventoryGateways({
    provider: { discover: async () => undefined } as unknown as ProviderDeviceInventorySource,
  });

  await expect(gateways.providerFirst.discover({}, scope)).rejects.toMatchObject({
    details: { reason: 'provider_inventory_contract_violation' },
  });
});
