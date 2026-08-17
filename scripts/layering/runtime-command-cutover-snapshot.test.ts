import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotPlatformPolicyBranchViolations } from './runtime-command-cutover-snapshot.ts';

const SNAPSHOT_RUNTIME_BINDING_FILE = 'src/daemon/snapshot-runtime-binding.ts';
const SNAPSHOT_FACTS_FIRST_ADMISSION = `
  const facts = await requireRuntimeFacts(params.inspectFacts)(device);
  const plan = resolveSnapshotRuntimePlan({
    customActions: params.req.flags?.snapshotCustomActions === true,
    hasActiveApp: session?.appBundleId !== undefined,
  });
  for (const operation of plan.use.required) {
    const fact = facts.operations[operation];
    if (fact.available) continue;
  }
`;

function violationsFor(extraAdmission = ''): string[] {
  return snapshotPlatformPolicyBranchViolations(
    new Map([
      [
        SNAPSHOT_RUNTIME_BINDING_FILE,
        `
          function inspectSnapshotCaptureAdmission(params, device, session) {
            ${SNAPSHOT_FACTS_FIRST_ADMISSION}
            ${extraAdmission}
          }
        `,
      ],
    ]),
  ).map(({ file, message }) => `${file}: ${message}`);
}

test('R32 snapshot accepts only the normalized plan and selected operation facts seam', () => {
  assert.deepEqual(violationsFor(), []);
});

test('R32 snapshot rejects a direct device-leaf branch in daemon admission', () => {
  assert.deepEqual(
    violationsFor("if (device.platform === 'apple' && device.kind === 'simulator') return plan;"),
    [
      'src/daemon/snapshot-runtime-binding.ts: snapshot admission reads device-owner identity instead of selected operation facts',
    ],
  );
});

test('R32 snapshot rejects a provider-mode branch in daemon admission', () => {
  assert.deepEqual(
    violationsFor("if (facts.device.providerMode === 'provider-runtime') return plan;"),
    [
      'src/daemon/snapshot-runtime-binding.ts: snapshot admission reads device-owner identity instead of selected operation facts',
    ],
  );
});

test('R32 snapshot rejects device-owner policy through chained aliases', () => {
  assert.deepEqual(
    violationsFor(`
      const identity = device;
      const owner = identity;
      if (owner.platform === 'apple') return plan;
    `),
    [
      'src/daemon/snapshot-runtime-binding.ts: snapshot admission reads device-owner identity instead of selected operation facts',
    ],
  );
});

test('R32 snapshot rejects destructured provider-owner policy', () => {
  assert.deepEqual(
    violationsFor(`
      const { providerMode } = facts.device;
      if (providerMode === 'provider-runtime') return plan;
    `),
    [
      'src/daemon/snapshot-runtime-binding.ts: snapshot admission reads device-owner identity instead of selected operation facts',
    ],
  );
});

test('R32 snapshot rejects nested device-leaf destructuring from admission params', () => {
  assert.deepEqual(
    violationsFor(`
      const { device: selectedDevice } = params;
      const { kind } = selectedDevice;
      if (kind === 'simulator') return plan;
    `),
    [
      'src/daemon/snapshot-runtime-binding.ts: snapshot admission reads device-owner identity instead of selected operation facts',
    ],
  );
});

test('R32 snapshot rejects device-owner policy through an assigned alias', () => {
  assert.deepEqual(
    violationsFor(`
      let identity;
      identity = device;
      if (identity.kind === 'simulator') return plan;
    `),
    [
      'src/daemon/snapshot-runtime-binding.ts: snapshot admission reads device-owner identity instead of selected operation facts',
    ],
  );
});

test('R32 snapshot rejects device-owner policy delegated to a renamed helper', () => {
  assert.deepEqual(violationsFor('if (supportsIosSimulator(device)) return plan;'), [
    'src/daemon/snapshot-runtime-binding.ts: snapshot admission reads device-owner identity instead of selected operation facts',
  ]);
});

test('R32 snapshot rejects device-owner policy through object-rest identity', () => {
  assert.deepEqual(
    violationsFor(`
      const { ...identity } = device;
      if (identity.platform === 'apple') return plan;
    `),
    [
      'src/daemon/snapshot-runtime-binding.ts: snapshot admission reads device-owner identity instead of selected operation facts',
    ],
  );
});
