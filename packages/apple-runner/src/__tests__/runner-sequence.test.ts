import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { runApplePressSeries } from '../runner-sequence.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';

test('a step failure in a later chunk counts the taps every chunk completed', async () => {
  const ok = (count: number) => Array.from({ length: count }, () => ({ ok: true, kind: 'tap' }));
  const answers = [
    { completedSteps: 20, sequenceResults: ok(20) },
    { completedSteps: 2, sequenceResults: [...ok(2), { ok: false, kind: 'tap' }] },
  ];
  await assert.rejects(
    runApplePressSeries(
      IOS_SIMULATOR,
      { x: 10, y: 20 },
      { button: 'primary', count: 25, intervalMs: 0, holdMs: 0, jitterPx: 0, doubleTap: false },
      undefined,
      async () => answers.shift()!,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.failedStepIndex, 22);
      assert.equal(error.details?.dispatched, 'unknown');
      assert.equal(error.details?.dispatchedSteps, 22);
      return true;
    },
  );
});
