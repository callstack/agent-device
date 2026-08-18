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

test('snapshot public route inspects facts and binds the declared use exactly once', () => {
  const publicRoute = snapshotRuntimeSource.slice(
    snapshotRuntimeSource.indexOf('export async function dispatchSnapshotViaRuntime'),
    snapshotRuntimeSource.indexOf('function publishedSnapshotGeneration'),
  );

  expect(publicRoute.match(/resolveSnapshotRuntimePlan\(\{/g)).toHaveLength(1);
  expect(publicRoute.match(/inspectRequiredRuntimeUse\(\{/g)).toHaveLength(1);
  expect(
    publicRoute.match(/bindSnapshotCaptureRuntime\(params\.bindDevice, device, plan\)/g),
  ).toHaveLength(1);
  expect(
    publicRoute.match(/use: plan\.use,[\s\S]*inspectFacts: params\.inspectFacts/g),
  ).toHaveLength(1);
  expect(
    snapshotRuntimeBindingSource.match(/const bind = requireRuntimeBinding\(bindDevice\)/g),
  ).toHaveLength(1);
  expect(publicRoute.match(/runtime\.captureSnapshot\(/g)).toHaveLength(1);
  expect(publicRoute).not.toContain("requireCommandSupported('snapshot'");
  for (const policyName of ['isIosFamily', 'isIosSimulator', 'providerOwned']) {
    expect(snapshotRuntimeBindingSource).not.toContain(policyName);
  }
});
