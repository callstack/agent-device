import { expect, test } from 'vitest';
import { resolveMaestroTimingPolicy } from '../compatibility-policy.ts';

test('uses the Maestro-compatible extended wait default', () => {
  expect(resolveMaestroTimingPolicy().extendedWaitUntilTimeoutMs).toBe(17_000);
});
