import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertRecordRuntimeExecution } from './record-runtime-cutover.ts';
import {
  screenRecordingRuntimePlanUses,
  resolveScreenRecordingRuntimePlan,
} from './screen-recording-runtime-plan.ts';

test('record descriptor execution joins exactly to the two runtime-bearing plan uses', () => {
  assert.doesNotThrow(() =>
    assertRecordRuntimeExecution({ kind: 'device-runtime', uses: screenRecordingRuntimePlanUses }),
  );
});

test('rejects incomplete and widened record descriptor declarations', () => {
  const startUse = resolveScreenRecordingRuntimePlan({ action: 'start' }).use;
  assert.throws(
    () => assertRecordRuntimeExecution({ kind: 'device-runtime', use: startUse }),
    /exactly one|two runtime-bearing plans/,
  );
  assert.throws(
    () =>
      assertRecordRuntimeExecution({
        kind: 'device-runtime',
        uses: [
          ...screenRecordingRuntimePlanUses,
          { required: ['screenRecordingCleanup'], preferred: [] },
        ],
      }),
    /exactly one|two runtime-bearing plans/,
  );
});

test('rejects duplicate declared uses even when their identity set looks complete', () => {
  const [startUse, recoveryUse] = screenRecordingRuntimePlanUses;
  assert.ok(startUse && recoveryUse);
  assert.throws(
    () =>
      assertRecordRuntimeExecution({
        kind: 'device-runtime',
        uses: [startUse, startUse, recoveryUse],
      }),
    /exactly one|two runtime-bearing plans/,
  );
});
