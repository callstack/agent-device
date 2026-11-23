import { expect, test } from 'vitest';
import { PROVIDER_INVENTORY_REASONS } from '@agent-device/contracts/device';
import { NO_PLUGIN_CREDENTIALS } from '@agent-device/contracts/plugin-inventory';
import { enrichProviderCatalogError } from './provider-runtime-admission.ts';

test('catalog error enrichment looks up the dormant provider by its canonical name', () => {
  const error = enrichProviderCatalogError(
    {
      code: 'DEVICE_NOT_FOUND',
      message: 'Allocate a lease first.',
      details: {
        reason: PROVIDER_INVENTORY_REASONS.instanceUnallocated.reason,
        leaseProvider: ' limrun ',
      },
    },
    [],
    [
      {
        state: 'dormant',
        source: 'embedder',
        provider: 'limrun',
        credentials: NO_PLUGIN_CREDENTIALS,
        dormant: {
          reason: 'missing_provider_credentials',
          message: 'Limrun credentials are missing.',
          hint: 'Set LIMRUN_API_KEY.',
        },
      },
    ],
  );

  expect(error).toMatchObject({
    code: 'INVALID_ARGS',
    details: { provider: 'limrun', reason: 'missing_provider_credentials' },
    hint: 'Set LIMRUN_API_KEY.',
  });
});
