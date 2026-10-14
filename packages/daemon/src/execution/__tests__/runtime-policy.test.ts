import { expect, test } from 'vitest';
import { createDaemonRuntimePolicy } from '../runtime-policy.ts';

test('createDaemonRuntimePolicy uses local policy and unsupported artifacts', async () => {
  const runtimePolicy = createDaemonRuntimePolicy('snapshot');

  expect(runtimePolicy.policy).toBeDefined();
  if (!runtimePolicy.policy) {
    throw new Error('Expected daemon runtime policy');
  }
  expect(runtimePolicy.policy.allowLocalInputPaths).toBe(true);
  expect(runtimePolicy.policy.allowLocalOutputPaths).toBe(true);
  await expect(
    runtimePolicy.artifacts.createTempFile({ prefix: 'snapshot', ext: '.png' }),
  ).rejects.toThrow(/snapshot does not create temporary files/);
});
