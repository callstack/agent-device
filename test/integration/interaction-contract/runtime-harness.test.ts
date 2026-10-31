import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createContractDevice } from './runtime-harness.ts';

test('contract devices retain the runtime default store isolation', async () => {
  const snapshot = {
    nodes: [{ ref: 'e1', index: 0, depth: 0, label: 'Initial' }],
    createdAt: 1,
  };
  const device = createContractDevice(snapshot);
  snapshot.nodes[0]!.label = 'Mutated input';
  const stored = await device.sessions.get('default');
  assert.equal(stored?.snapshot?.nodes[0]?.label, 'Initial');
  stored!.snapshot!.nodes[0]!.label = 'Mutated read';
  assert.equal((await device.sessions.get('default'))?.snapshot?.nodes[0]?.label, 'Initial');
});
