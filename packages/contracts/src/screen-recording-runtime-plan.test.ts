import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  screenRecordingAdmissionUse,
  screenRecordingRuntimePlanUses,
  resolveScreenRecordingRuntimePlan,
} from './screen-recording-runtime-plan.ts';

test('declares separate start, live-stop, and recovery-stop plans', () => {
  assert.deepEqual(resolveScreenRecordingRuntimePlan({ action: 'start', scope: 'app' }), {
    kind: 'start',
    use: screenRecordingRuntimePlanUses[0],
  });
  assert.deepEqual(resolveScreenRecordingRuntimePlan({ action: 'start', scope: 'device' }), {
    kind: 'start',
    use: screenRecordingRuntimePlanUses[0],
  });
  assert.deepEqual(resolveScreenRecordingRuntimePlan({ action: 'stop', hasLiveHandle: true }), {
    kind: 'stop-live',
    use: { required: [], preferred: [] },
  });
  assert.deepEqual(resolveScreenRecordingRuntimePlan({ action: 'stop', hasLiveHandle: false }), {
    kind: 'stop-recovery',
    use: screenRecordingRuntimePlanUses[1],
  });
});

test('keeps an adopted live stop out of descriptor runtime admission', () => {
  assert.deepEqual(resolveScreenRecordingRuntimePlan({ action: 'stop', hasLiveHandle: true }).use, {
    required: [],
    preferred: [],
  });
  assert.deepEqual(screenRecordingRuntimePlanUses[1], {
    required: ['screenRecordingReattach', 'screenRecordingCleanup'],
    preferred: [],
  });
});

test('admission prefers start without rejecting an owner that only supports recovery', () => {
  assert.deepEqual(screenRecordingAdmissionUse, {
    required: [],
    preferred: ['screenRecordingStart'],
  });
});

test.each([
  { input: { action: 'pause' }, message: 'record requires start or stop' },
  {
    input: { action: 'start', scope: 'whole-screen' },
    message: 'record scope must be app, device, or system',
  },
])('rejects invalid recording plan input', ({ input, message }) => {
  assert.throws(() => resolveScreenRecordingRuntimePlan(input), { message });
});
