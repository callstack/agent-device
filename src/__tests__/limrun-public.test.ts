import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLimrunRuntimeFromEnv } from '../sdk/limrun.ts';

test('public limrun entrypoint creates the provider runtime from environment configuration', async () => {
  assert.equal(createLimrunRuntimeFromEnv({}), undefined);

  const runtime = createLimrunRuntimeFromEnv({ LIMRUN_API_KEY: 'lim_test_key' });
  assert.ok(runtime);
  assert.equal(runtime.provider, 'limrun');

  await runtime.shutdown();
});
