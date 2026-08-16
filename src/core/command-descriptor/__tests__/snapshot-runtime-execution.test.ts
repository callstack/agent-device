import { readFileSync } from 'node:fs';
import { captureSnapshotUse } from '@agent-device/contracts/platform';
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

test('snapshot descriptor declares one required capture operation with no legacy projection', () => {
  const snapshot = commandDescriptors.find(({ name }) => name === 'snapshot');

  expect(snapshot).not.toHaveProperty('capability');
  expect(snapshot).not.toHaveProperty('dispatch');
  expect(snapshot?.platformExecution).toEqual({
    kind: 'device-runtime',
    use: captureSnapshotUse,
  });
  expect(captureSnapshotUse).toEqual({
    required: ['captureSnapshot'],
    preferred: [],
  });
});

test('snapshot public route inspects facts and binds the declared use exactly once', () => {
  const publicRoute = snapshotRuntimeSource.slice(
    snapshotRuntimeSource.indexOf('export async function dispatchSnapshotViaRuntime'),
    snapshotRuntimeSource.indexOf('function publishedSnapshotGeneration'),
  );

  expect(publicRoute.match(/inspectSnapshotCaptureAdmission\(params\)/g)).toHaveLength(1);
  expect(
    publicRoute.match(/bindSnapshotCaptureRuntime\(params\.bindDevice, device\)/g),
  ).toHaveLength(1);
  expect(
    snapshotRuntimeBindingSource.match(/requireRuntimeFacts\(params\.inspectFacts\)\(device\)/g),
  ).toHaveLength(1);
  expect(
    snapshotRuntimeBindingSource.match(
      /requireRuntimeBinding\(bindDevice\)\(device, captureSnapshotUse\)/g,
    ),
  ).toHaveLength(1);
  expect(publicRoute.match(/runtime\.operations\.captureSnapshot\(/g)).toHaveLength(1);
  expect(publicRoute).not.toContain("requireCommandSupported('snapshot'");
});
