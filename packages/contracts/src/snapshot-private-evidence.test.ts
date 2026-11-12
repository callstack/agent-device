import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  attachSnapshotClickabilityEvidence,
  attachSnapshotOcclusionContextEvidence,
  attachSnapshotViewportEvidence,
  assertSnapshotScreenOrigin,
  readSnapshotOcclusionContextEvidence,
  readSnapshotNativePressTargets,
  transferSnapshotPrivateEvidence,
  copySnapshotClickabilityEvidence,
  readSnapshotClickabilityEvidence,
} from './snapshot-private-evidence.ts';

test('retains exact evidence without adding enumerable snapshot or node fields', () => {
  const node = { index: 0, identifier: 'save' };
  const snapshot = { createdAt: 0, nodes: [node] };
  const evidence = {
    kind: 'exact' as const,
    provider: 'android-helper' as const,
    clickableByNodeIndex: new Map<number, boolean | undefined>([[0, true]]),
  };

  attachSnapshotClickabilityEvidence(snapshot, evidence);

  assert.deepEqual(readSnapshotClickabilityEvidence(snapshot), evidence);
  assert.deepEqual(Object.keys(node), ['index', 'identifier']);
  assert.equal(JSON.stringify(snapshot).includes('clickable'), false);
});

test('copies evidence across internal snapshot construction without serializing the sidecar', () => {
  const source = {};
  const target = { nodes: [] };
  const evidence = {
    kind: 'divergence' as const,
    provider: 'apple-xctest' as const,
    reason: 'maestro-clickable-not-exposed-by-provider' as const,
  };

  attachSnapshotClickabilityEvidence(source, evidence);
  copySnapshotClickabilityEvidence(source, target);

  assert.deepEqual(readSnapshotClickabilityEvidence(target), evidence);
  assert.deepEqual(JSON.parse(JSON.stringify(target)), { nodes: [] });
});

test('generic construction and cloning remap captured facts without upgrading origin authority', async () => {
  const rect = { x: 20, y: 100, width: 300, height: 100 };
  const source = transferSnapshotPrivateEvidence(
    {},
    {
      nodes: [{ index: 30, type: 'Button', nativePressTarget: { type: 9, label: 'Save', rect } }],
    },
    new Map(),
  );
  attachSnapshotClickabilityEvidence(source, {
    kind: 'exact',
    provider: 'android-helper',
    clickableByNodeIndex: new Map([
      [30, true],
      [40, false],
    ]),
  });
  attachSnapshotOcclusionContextEvidence(source, {
    nodes: [{ index: 300 }, { index: 400 }],
    sourceIndexByNodeIndex: new Map([
      [30, 300],
      [40, 400],
    ]),
  });
  attachSnapshotViewportEvidence(source.nodes, { kind: 'derived', rect });
  const projected = transferSnapshotPrivateEvidence(
    source,
    {
      nodes: [{ index: 2, type: 'Button', rect: { ...rect, y: 150, height: 50 } }],
    },
    new Map([[2, 30]]),
  );
  const cloned = transferSnapshotPrivateEvidence(
    projected,
    structuredClone(projected),
    new Map([[2, 2]]),
  );
  assert.deepEqual(readSnapshotNativePressTargets(cloned.nodes)?.get(2), {
    type: 9,
    label: 'Save',
    rect,
  });
  assert.deepEqual(readSnapshotClickabilityEvidence(cloned), {
    kind: 'exact',
    provider: 'android-helper',
    clickableByNodeIndex: new Map([[2, true]]),
  });
  assert.deepEqual(
    readSnapshotOcclusionContextEvidence(cloned)?.sourceIndexByNodeIndex,
    new Map([[2, 300]]),
  );
  await assert.rejects(
    assertSnapshotScreenOrigin(cloned.nodes, 'Target'),
    (error: unknown) =>
      (error as { details?: Record<string, unknown> }).details?.reason === 'window-origin-unknown',
  );
  assert.equal(JSON.stringify(cloned).includes('nativePressTarget'), false);
  assert.deepEqual(readSnapshotNativePressTargets(source.nodes)?.get(30), {
    type: 9,
    label: 'Save',
    rect,
  });
});
