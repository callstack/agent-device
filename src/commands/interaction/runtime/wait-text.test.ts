import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
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

/**
 * #2484 follow-up: the iOS runner refuses every command with a retriable `RUNNER_BUSY` while it
 * drains the abandoned main-thread work of a command that exceeded its execution watchdog. A
 * budgeted wait is a retry loop, so it must poll through that refusal rather than hand the caller
 * a failure the runner itself says will clear in a few seconds.
 */
test('runtime wait polls through a retriable capture refusal and resolves the text', async () => {
  const snapshot = selectorReadSnapshot();
  let attempts = 0;
  const device = createSelectorDevice(snapshot, {
    clock: createFakeClock(),
    captureSnapshot: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new AppError('COMMAND_FAILED', 'runner is still finishing a previous command', {
          runnerErrorCode: 'RUNNER_BUSY',
          retriable: true,
        });
      }
      return { snapshot };
    },
  });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'text', text: 'Continue', timeoutMs: 10_000 },
  });

  assert.equal(result.kind, 'text');
  assert.equal(attempts, 2);
});
