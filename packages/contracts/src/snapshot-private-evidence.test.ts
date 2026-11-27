import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  attachSnapshotClickabilityEvidence,
  attachSnapshotScreenReaderOrderEvidence,
  copySnapshotClickabilityEvidence,
  copySnapshotScreenReaderOrderEvidence,
  readSnapshotClickabilityEvidence,
  readSnapshotScreenReaderOrderEvidence,
} from './snapshot-private-evidence.ts';

test('retains exact evidence without adding enumerable snapshot or node fields', () => {
  const node = { index: 0, identifier: 'save' };
  const snapshot = { createdAt: 0, nodes: [node] };
  const evidence = {
    kind: 'exact' as const,
    provider: 'android-helper' as const,
    clickableByNodeIndex: new Map<number, boolean | undefined>([[0, true]]),
    longClickableByNodeIndex: new Map<number, boolean | undefined>([[0, false]]),
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

test('computes the screen-reader order once on the first read and shares it across concurrent reads', async () => {
  const source = {};
  const target = {};
  const evidence = { windows: [{ nodeIndexes: [0], omittedStops: 0 }] };
  let runs = 0;
  attachSnapshotScreenReaderOrderEvidence(source, () => {
    runs += 1;
    return Promise.resolve(evidence);
  });
  copySnapshotScreenReaderOrderEvidence(source, target);
  assert.equal(runs, 0);

  const [targetOrder, sourceOrder] = await Promise.all([
    readSnapshotScreenReaderOrderEvidence(target),
    readSnapshotScreenReaderOrderEvidence(source),
  ]);
  assert.equal(targetOrder, evidence);
  assert.equal(sourceOrder, evidence);
  assert.equal(runs, 1);
});
