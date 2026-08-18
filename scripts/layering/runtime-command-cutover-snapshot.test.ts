import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotPlatformPolicyBranchViolations } from './runtime-command-cutover-snapshot.ts';

const ROUTE = 'src/daemon/snapshot-runtime.ts';
const COMMAND = 'src/daemon/snapshot-command-runtime.ts';
const BINDING = 'src/daemon/snapshot-runtime-binding.ts';

function violationsFor(route: string, binding = '', command = SHARED_COMMAND): string[] {
  return snapshotPlatformPolicyBranchViolations(
    new Map([
      [ROUTE, route],
      [COMMAND, command],
      [BINDING, binding],
    ]),
  ).map(({ message }) => message);
}

const PUBLIC_ROUTE = `
  async function dispatchSnapshotViaRuntime(params) {
    return dispatchSnapshotRuntimeCommand({ ...params, command: 'snapshot' });
  }
`;

const SHARED_COMMAND = `
  async function dispatchSnapshotRuntimeCommand(params) {
    return resolveBoundSnapshotCaptureRuntime(params, params.command);
  }
`;

const FACTS_FIRST_BINDING = `
  async function resolveBoundSnapshotCaptureRuntime(params) {
    const plan = resolveSnapshotRuntimePlan(normalizedIntent);
    const admission = await inspectRequiredRuntimeUse({
      device,
      use: plan.use,
      inspectFacts: params.inspectFacts,
    });
    if (!admission.admitted) return unavailable(admission);
    return bindSnapshotCaptureRuntime(params.bindDevice, device, plan);
  }
`;

test('R32 accepts the normalized plan through the shared facts-first seam', () => {
  assert.deepEqual(violationsFor(PUBLIC_ROUTE, FACTS_FIRST_BINDING), []);
});

test('R32 rejects a locally reimplemented admission policy, including object-wrapped identity', () => {
  assert.deepEqual(
    violationsFor(
      PUBLIC_ROUTE,
      `
        async function resolveBoundSnapshotCaptureRuntime(params) {
          const plan = resolveSnapshotRuntimePlan(normalizedIntent);
          return inspectSnapshotCaptureAdmission(params, plan);
        }
        function inspectSnapshotCaptureAdmission(device) {
          const wrapped = { device };
          if (wrapped.device.platform === 'apple') return { admitted: true };
        }
      `,
    ),
    [
      'snapshot owning interface must admit exactly once through inspectRequiredRuntimeUse(device, plan.use, inspectFacts)',
      'snapshot admission must not be reimplemented beside the shared facts seam',
    ],
  );
});

test('R32 rejects an admission call not coupled to the selected plan use', () => {
  assert.deepEqual(
    violationsFor(
      PUBLIC_ROUTE,
      FACTS_FIRST_BINDING.replace('use: plan.use', 'use: captureSnapshotUse'),
    ),
    [
      'snapshot owning interface must admit exactly once through inspectRequiredRuntimeUse(device, plan.use, inspectFacts)',
    ],
  );
});
