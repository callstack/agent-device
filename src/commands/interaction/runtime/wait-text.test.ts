import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createFakeClock,
  createSelectorDevice,
  selectorReadSnapshot,
} from './__tests__/test-utils/index.ts';

// A text wait has exactly one source of truth: the polled capture. The backend `findText` seam
// that short-circuited it on Apple was wait's second platform-execution path and retired with
// wait's ADR 0019 cutover, so the tree answer is the only answer — in both directions.
test('runtime wait resolves text from the polled snapshot', async () => {
  const device = createSelectorDevice(selectorReadSnapshot(), { now: 10 });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'text', text: 'Continue', timeoutMs: 100 },
  });

  assert.deepEqual(result, { kind: 'text', text: 'Continue', waitedMs: 0 });
});

test('runtime wait times out on text the polled snapshot does not carry', async () => {
  const device = createSelectorDevice(selectorReadSnapshot(), { clock: createFakeClock() });

  await assert.rejects(
    async () =>
      await device.selectors.wait({
        session: 'default',
        target: { kind: 'text', text: 'Ready', timeoutMs: 100 },
      }),
    (error: Error) => error.message.includes('wait timed out for text: Ready'),
  );
});
