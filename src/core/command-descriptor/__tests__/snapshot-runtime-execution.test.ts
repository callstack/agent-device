import { readFileSync } from 'node:fs';
import { snapshotRuntimePlanUses } from '@agent-device/contracts/platform';
import { expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

const snapshotRuntimeSource = readFileSync(
  new URL('../../../daemon/snapshot-runtime.ts', import.meta.url),
  'utf8',
);
const snapshotRuntimeBindingSource = readFileSync(
  new URL('../../../daemon/snapshot-runtime-binding.ts', import.meta.url),
  'utf8',
);
const snapshotRuntimeCommandSource = readFileSync(
  new URL('../../../daemon/snapshot-command-runtime.ts', import.meta.url),
  'utf8',
);

test('snapshot descriptor declares its complete planned capture uses with no legacy projection', () => {
  const snapshot = commandDescriptors.find(({ name }) => name === 'snapshot');

  expect(snapshot).not.toHaveProperty('capability');
  expect(snapshot).not.toHaveProperty('dispatch');
  expect(snapshot?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: snapshotRuntimePlanUses,
  });
  expect(snapshotRuntimePlanUses.map(({ required }) => required)).toEqual([
    ['captureSnapshot'],
    ['captureSnapshot', 'captureSnapshotWithCustomActions'],
    ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
    ['captureSnapshot', 'captureSnapshotWithCustomActions', 'captureSnapshotWithoutActiveApp'],
  ]);
});

test('diff descriptor reuses the complete snapshot plan uses with no legacy projection', () => {
  const diff = commandDescriptors.find(({ name }) => name === 'diff');

  expect(diff).not.toHaveProperty('capability');
  expect(diff).not.toHaveProperty('dispatch');
  expect(diff?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: snapshotRuntimePlanUses,
  });
});

test('shared snapshot owning interface inspects facts and binds the declared use exactly once', () => {
  const publicRoute = snapshotRuntimeSource.slice(
    snapshotRuntimeSource.indexOf('export async function dispatchSnapshotViaRuntime'),
    snapshotRuntimeSource.indexOf('function publishedSnapshotGeneration'),
  );
  const owningInterface = snapshotRuntimeBindingSource.slice(
    snapshotRuntimeBindingSource.indexOf(
      'export async function resolveBoundSnapshotCaptureRuntime',
    ),
    snapshotRuntimeBindingSource.indexOf('async function bindSnapshotCaptureRuntime'),
  );

  expect(publicRoute).toContain('dispatchSnapshotRuntimeCommand({');
  expect(
    snapshotRuntimeCommandSource.match(
      /resolveBoundSnapshotCaptureRuntime\(params, params\.command\)/g,
    ),
  ).toHaveLength(1);
  expect(owningInterface.match(/resolveSnapshotRuntimePlan\(\{/g)).toHaveLength(1);
  expect(owningInterface.match(/inspectRequiredRuntimeUse\(\{/g)).toHaveLength(1);
  expect(
    owningInterface.match(/bindSnapshotCaptureRuntime\(params\.bindDevice, device, plan\)/g),
  ).toHaveLength(1);
  expect(
    owningInterface.match(/use: plan\.use,[\s\S]*inspectFacts: params\.inspectFacts/g),
  ).toHaveLength(1);
  expect(
    snapshotRuntimeBindingSource.match(/const bind = requireRuntimeBinding\(bindDevice\)/g),
  ).toHaveLength(1);
  expect(owningInterface.match(/runtime\.captureSnapshot\(/g)).toHaveLength(1);
  expect(publicRoute).not.toContain("requireCommandSupported('snapshot'");
  for (const policyName of ['isIosFamily', 'isIosSimulator', 'providerOwned']) {
    expect(snapshotRuntimeBindingSource).not.toContain(policyName);
  }
});
