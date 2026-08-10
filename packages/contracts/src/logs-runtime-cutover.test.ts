import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertLogsRuntimeExecution } from './logs-runtime-cutover.ts';
import { appLogRuntimePlanUses, resolveLogsRuntimePlan } from './logs-runtime-plan.ts';

const appLogInspectUse = resolveLogsRuntimePlan({ action: 'path' }).use;
const appLogDoctorUse = resolveLogsRuntimePlan({ action: 'doctor' }).use;
const appLogStartUse = resolveLogsRuntimePlan({ action: 'start' }).use;

test('logs descriptor execution joins exactly to the seven normalized plans', () => {
  assert.doesNotThrow(() =>
    assertLogsRuntimeExecution({ kind: 'device-runtime', uses: appLogRuntimePlanUses }),
  );
});

test.each([
  { name: 'static superset', execution: { kind: 'device-runtime', use: appLogStartUse } },
  {
    name: 'missing plan use',
    execution: {
      kind: 'device-runtime',
      uses: [appLogInspectUse, appLogStartUse],
    },
  },
  {
    name: 'unreferenced use',
    execution: {
      kind: 'device-runtime',
      uses: [
        appLogInspectUse,
        appLogDoctorUse,
        appLogStartUse,
        { required: ['appLogCleanup'], preferred: [] },
      ],
    },
  },
])('rejects a planted $name declaration', ({ execution }) => {
  assert.throws(() => assertLogsRuntimeExecution(execution), /seven plans/);
});
