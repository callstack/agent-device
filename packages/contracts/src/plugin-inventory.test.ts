import { expect, test } from 'vitest';
import { pluginCredentialVariables, readPluginInventory } from './plugin-inventory.ts';

const credentials = { variables: ['A'], byBackend: { ios: ['A', 'B'] } };

test('the reader keeps well-formed entries and drops entries that lose plugin state', () => {
  const active = { provider: 'p', source: 'store', state: 'active', credentials };
  const failed = {
    source: 'builtin',
    state: 'failed',
    error: { code: 'INVALID_ARGS', message: 'bad', reason: 'invalid_plugin' },
    credentials,
  };
  expect(
    readPluginInventory([
      active,
      failed,
      { ...active, credentials: undefined },
      { ...active, credentials: { variables: 'A' } },
      { ...failed, error: undefined },
      { ...active, state: 'unknown' },
      'not an entry',
    ]),
  ).toEqual([active, failed]);
});

test('credential variables narrow to the lease backend of an active plugin only', () => {
  const inventory = readPluginInventory([
    { provider: 'p', source: 'store', state: 'active', credentials },
    {
      provider: 'q',
      source: 'store',
      state: 'failed',
      error: { code: 'X', message: 'm' },
      credentials,
    },
  ]);
  expect(pluginCredentialVariables(inventory, 'p', 'ios')).toEqual(['A', 'B']);
  expect(pluginCredentialVariables(inventory, 'p', 'android')).toEqual(['A']);
  expect(pluginCredentialVariables(inventory, 'q')).toBeUndefined();
});
