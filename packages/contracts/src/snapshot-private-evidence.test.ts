import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  attachSnapshotClickabilityEvidence,
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
