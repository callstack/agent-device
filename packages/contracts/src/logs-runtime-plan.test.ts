import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  appLogAdmissionUse,
  appLogRuntimePlanUses,
  resolveLogsRuntimePlan,
} from './logs-runtime-plan.ts';

const appLogInspectUse = resolveLogsRuntimePlan({ action: 'path' }).use;
const appLogDoctorUse = resolveLogsRuntimePlan({ action: 'doctor' }).use;

test('normalizes all seven logs plans with their exact non-superset runtime use', () => {
  const startUse = resolveLogsRuntimePlan({ action: 'start' }).use;
  assert.deepEqual(resolveLogsRuntimePlan({}), {
    kind: 'path',
    requiresAppSession: false,
    use: appLogInspectUse,
  });
  assert.deepEqual(resolveLogsRuntimePlan({ action: 'start' }), {
    kind: 'start',
    requiresAppSession: true,
    use: startUse,
  });
  assert.deepEqual(resolveLogsRuntimePlan({ action: 'stop' }), {
    kind: 'stop',
    requiresAppSession: false,
    use: appLogInspectUse,
  });
  assert.deepEqual(resolveLogsRuntimePlan({ action: 'doctor' }), {
    kind: 'doctor',
    requiresAppSession: false,
    use: appLogDoctorUse,
  });
  assert.deepEqual(resolveLogsRuntimePlan({ action: 'mark', marker: 'checkpoint' }), {
    kind: 'mark',
    marker: 'checkpoint',
    requiresAppSession: false,
    use: appLogInspectUse,
  });
  assert.deepEqual(resolveLogsRuntimePlan({ action: 'clear' }), {
    kind: 'clear',
    requiresAppSession: false,
    use: appLogInspectUse,
  });
  assert.deepEqual(resolveLogsRuntimePlan({ action: 'clear', restart: true }), {
    kind: 'clear-restart',
    requiresAppSession: true,
    use: startUse,
  });
  assert.deepEqual(appLogRuntimePlanUses, [appLogInspectUse, appLogDoctorUse, startUse]);
  assert.deepEqual(appLogDoctorUse, {
    required: ['appLogInspect', 'appLogDoctor'],
    preferred: [],
  });
  assert.deepEqual(startUse, {
    required: ['appLogInspect', 'appLogStart'],
    preferred: [],
  });
});

test('keeps fact-derived admission separate from every execution plan', () => {
  assert.deepEqual(appLogAdmissionUse, {
    required: [],
    preferred: ['appLogInspect'],
  });
  assert.equal((appLogRuntimePlanUses as readonly object[]).includes(appLogAdmissionUse), false);
});

test('rejects unknown actions and restart outside clear with typed invalid arguments', () => {
  for (const input of [
    { action: 'wat' },
    { action: 'path', restart: true },
    { action: 'start', restart: true },
  ]) {
    assert.throws(
      () => resolveLogsRuntimePlan(input),
      (error) => error instanceof AppError && error.code === 'INVALID_ARGS',
    );
  }
});
