import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createGuestSimulatorFrameworkBridgeAdapter } from './guest-adapter.ts';

test('guest adapter fails closed when the guest bridge executable is not configured', async () => {
  const adapter = createGuestSimulatorFrameworkBridgeAdapter({ repoRoot: '/repo' });
  const result = await adapter.acquireBatch([
    {
      version: 1,
      id: 'guest-unavailable',
      candidate: 'guest-simulator-framework-bridge',
      simulatorUdid: 'simulator',
      state: 'warm',
      screen: 'quiet',
      limits: {
        maxRequestBytes: 64 * 1024,
        maxResponseBytes: 4 * 1024 * 1024,
        maxNodes: 1500,
        maxTraversalDepth: 12,
        maxCpuMs: 2000,
        maxMemoryBytes: 256 * 1024 * 1024,
        maxDurationMs: 5000,
      },
    },
  ]);
  assert.deepEqual(result.responses[0]?.failure, {
    kind: 'unsupported-mechanism',
    code: 'guest-tool-unavailable',
  });
});
