import { expect, test } from 'vitest';
import { resolveMaestroTimingPolicy } from '../engine-flow.ts';

test('uses the Maestro-compatible extended wait default', () => {
  expect(resolveMaestroTimingPolicy().extendedWaitUntilTimeoutMs).toBe(17_000);
});
