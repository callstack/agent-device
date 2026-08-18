import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotPlatformPolicyBranchViolations } from './runtime-command-cutover-snapshot.ts';

const ROUTE = 'src/daemon/snapshot-runtime.ts';
const BINDING = 'src/daemon/snapshot-runtime-binding.ts';

function violationsFor(route: string, binding = ''): string[] {
  return snapshotPlatformPolicyBranchViolations(
    new Map([
      [ROUTE, route],
      [BINDING, binding],
    ]),
  ).map(({ message }) => message);
}

const FACTS_FIRST_ROUTE = `
  async function dispatchSnapshotViaRuntime(params) {
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
  assert.deepEqual(violationsFor(FACTS_FIRST_ROUTE), []);
});

test('R32 rejects a locally reimplemented admission policy, including object-wrapped identity', () => {
  assert.deepEqual(
    violationsFor(
      `
        async function dispatchSnapshotViaRuntime(params) {
          const plan = resolveSnapshotRuntimePlan(normalizedIntent);
          return inspectSnapshotCaptureAdmission(params, plan);
        }
      `,
      `
        function inspectSnapshotCaptureAdmission(device) {
          const wrapped = { device };
          if (wrapped.device.platform === 'apple') return { admitted: true };
        }
      `,
    ),
    [
      'snapshot route must admit exactly once through inspectRequiredRuntimeUse(device, plan.use, inspectFacts)',
      'snapshot admission must not be reimplemented beside the shared facts seam',
    ],
  );
});

test('R32 rejects an admission call not coupled to the selected plan use', () => {
  assert.deepEqual(
    violationsFor(FACTS_FIRST_ROUTE.replace('use: plan.use', 'use: captureSnapshotUse')),
    [
      'snapshot route must admit exactly once through inspectRequiredRuntimeUse(device, plan.use, inspectFacts)',
    ],
  );
});
