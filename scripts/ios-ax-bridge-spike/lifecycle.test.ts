import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runLifecycleProbes } from './lifecycle.ts';

test('records typed lifecycle failures and recovery probes', async () => {
  const evidence = await runLifecycleProbes();
  assert.deepEqual(
    {
      crash: evidence.crash,
      timeout: evidence.timeout,
      cancellation: evidence.cancellation,
      staleGeneration: evidence.staleGeneration,
    },
    {
      crash: { failure: 'process-crash', recovered: true },
      timeout: { failure: 'timeout', recovered: true },
      cancellation: { failure: 'cancelled', recovered: true },
      staleGeneration: { failure: 'stale-generation', recovered: true },
    },
  );
});
