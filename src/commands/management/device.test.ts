import { expect, test } from 'vitest';
import { deviceManagementCommandFacets } from './device.ts';

test('pair-wearable selector schema rejects empty wearable identity fields', () => {
  const command = deviceManagementCommandFacets.find((facet) => facet.name === 'pair-wearable');
  const wearable = command?.metadata.inputSchema.properties?.wearable;
  const properties = wearable?.properties;

  expect(properties?.deviceId?.minLength).toBe(1);
  expect(properties?.name?.minLength).toBe(1);
});
