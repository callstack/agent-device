import { expect, test } from 'vitest';
import { attachSnapshotClickabilityEvidence } from '@agent-device/contracts/capture';
import {
  rankMaestroCandidates,
  selectMaestroSnapshotMatch,
  selectMaestroSnapshotMatches,
} from '../runtime-target-ranking.ts';
import { makeSnapshot } from './runtime-target-fixtures.ts';

test('typed target matching preserves snapshot read order', () => {
  const snapshot = makeSnapshot([
    { index: 1, label: 'Save', rect: { x: 10, y: 10, width: 100, height: 40 } },
    { index: 2, label: 'Save', rect: { x: 10, y: 80, width: 100, height: 40 } },
  ]);

  expect(
    rankMaestroCandidates(snapshot, { text: 'Save' }, 'ios').matches.map((node) => node.index),
  ).toEqual([1, 2]);
});

test('supported Android evidence applies stable clickableFirst ordering across all groups', () => {
  const snapshot = attachSnapshotClickabilityEvidence(
    makeSnapshot([
      { index: 0, identifier: 'candidate', rect: { x: 0, y: 0, width: 20, height: 20 } },
      { index: 1, identifier: 'candidate', rect: { x: 0, y: 20, width: 20, height: 20 } },
      { index: 2, identifier: 'candidate', rect: { x: 0, y: 40, width: 20, height: 20 } },
      { index: 3, identifier: 'candidate', rect: { x: 0, y: 60, width: 20, height: 20 } },
      { index: 4, identifier: 'candidate', rect: { x: 0, y: 80, width: 20, height: 20 } },
    ]),
    {
      kind: 'exact',
      provider: 'android-helper',
      clickableByNodeIndex: new Map([
        [0, false],
        [1, true],
        [2, undefined],
        [3, true],
        [4, false],
      ]),
    },
  );

  const ranked = rankMaestroCandidates(snapshot, { id: 'candidate' }, 'android');

  expect(ranked.matches.map((node) => node.index)).toEqual([0, 1, 2, 3, 4]);
  expect(ranked.ranked.map((node) => node.index)).toEqual([1, 3, 0, 4, 2]);
  expect(ranked.clickability).toMatchObject({ kind: 'exact', provider: 'android-helper' });
});

test('authored index bypasses clickableFirst and keeps y/x ordering', () => {
  const snapshot = attachSnapshotClickabilityEvidence(
    makeSnapshot([
      {
        index: 0,
        identifier: 'candidate',
        rect: { x: 0, y: 200, width: 20, height: 20 },
      },
      {
        index: 1,
        identifier: 'candidate',
        rect: { x: 10, y: 20, width: 20, height: 20 },
      },
    ]),
    {
      kind: 'exact',
      provider: 'android-helper',
      clickableByNodeIndex: new Map([
        [0, true],
        [1, false],
      ]),
    },
  );

  const ranked = rankMaestroCandidates(snapshot, { id: 'candidate', index: 0 }, 'android');
  const resolution = selectMaestroSnapshotMatch(ranked.ranked, 0);

  expect(ranked.ranked.map((node) => node.index)).toEqual([0, 1]);
  expect(resolution).toMatchObject({ node: { index: 1 } });
});

test('unsupported iOS evidence is classified and never inferred from hittable or type', () => {
  const snapshot = makeSnapshot([
    {
      index: 0,
      identifier: 'candidate',
      type: 'Button',
      hittable: false,
      rect: { x: 0, y: 0, width: 20, height: 20 },
    },
    {
      index: 1,
      identifier: 'candidate',
      type: 'StaticText',
      hittable: true,
      rect: { x: 0, y: 20, width: 20, height: 20 },
    },
  ]);

  const ranked = rankMaestroCandidates(snapshot, { id: 'candidate' }, 'ios');

  expect(ranked.ranked.map((node) => node.index)).toEqual([0, 1]);
  expect(ranked.clickability).toEqual({
    kind: 'divergence',
    provider: 'apple-xctest',
    reason: 'maestro-clickable-not-exposed-by-provider',
  });
});

test('target selection preserves snapshot aggregate order when no index is authored', () => {
  const snapshot = makeSnapshot([
    {
      index: 10,
      type: 'StaticText',
      label: 'Save',
      rect: { x: 24, y: 100, width: 120, height: 44 },
    },
    {
      index: 2,
      type: 'Button',
      label: 'Save',
      rect: { x: 24, y: 300, width: 120, height: 44 },
    },
  ]);

  expect(selectMaestroSnapshotMatch(snapshot.nodes, undefined)).toMatchObject({
    node: { index: 10 },
  });
});

test('authored index sorts by y then x with missing bounds last', () => {
  const snapshot = makeSnapshot([
    {
      index: 1,
      type: 'StaticText',
      label: 'Save',
    },
    {
      index: 2,
      type: 'StaticText',
      label: 'Save',
      rect: { x: 24, y: 100, width: 120, height: 44 },
    },
    {
      index: 3,
      type: 'Button',
      label: 'Save',
      rect: { x: 24, y: 300, width: 120, height: 44 },
    },
  ]);

  expect(selectMaestroSnapshotMatch(snapshot.nodes, undefined)).toMatchObject({
    node: { index: 2 },
  });
  expect(selectMaestroSnapshotMatch(snapshot.nodes, 0)).toMatchObject({
    node: { index: 2 },
  });
  expect(selectMaestroSnapshotMatch(snapshot.nodes, 1)).toMatchObject({
    node: { index: 3 },
  });
  expect(selectMaestroSnapshotMatch(snapshot.nodes, 2)).toBeNull();
});

test('nested childOf applies its own index before scoping the candidate', () => {
  const snapshot = makeSnapshot([
    { index: 0, identifier: 'row', rect: { x: 0, y: 200, width: 200, height: 80 } },
    { index: 1, identifier: 'row', rect: { x: 0, y: 20, width: 200, height: 80 } },
    { index: 2, parentIndex: 0, label: 'Delete', rect: { x: 120, y: 220, width: 60, height: 40 } },
    { index: 3, parentIndex: 1, label: 'Delete', rect: { x: 120, y: 40, width: 60, height: 40 } },
  ]);

  expect(
    selectMaestroSnapshotMatches(snapshot, {
      text: 'Delete',
      childOf: { id: 'row', index: 1 },
    }).map((node) => node.index),
  ).toEqual([2]);
});

test('target selection never fabricates a rectangle or promotes to an ancestor', () => {
  const snapshot = makeSnapshot([
    {
      index: 1,
      type: 'Button',
      rect: { x: 20, y: 100, width: 220, height: 64 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Continue',
      rect: { x: 40, y: 112, width: 120, height: 40 },
    },
    {
      index: 3,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Missing geometry',
    },
  ]);

  expect(selectMaestroSnapshotMatch([snapshot.nodes[0]!], undefined)).toMatchObject({
    node: { index: 1 },
    rect: { x: 20, y: 100, width: 220, height: 64 },
  });
  expect(selectMaestroSnapshotMatch([snapshot.nodes[1]!], undefined)).toMatchObject({
    node: { index: 2 },
    rect: { x: 40, y: 112, width: 120, height: 40 },
  });
  expect(selectMaestroSnapshotMatch([snapshot.nodes[2]!], undefined)).toBeNull();
});
