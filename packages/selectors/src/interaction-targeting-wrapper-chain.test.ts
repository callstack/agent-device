import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSnapshotState } from './snapshot-geometry.fixtures.ts';
import { UNVERIFIED_HITTABILITY_WRAPPER_CHAIN_NODES } from './interaction-targeting.fixtures.ts';
import { resolveUnverifiedWrapperControl } from './interaction-targeting-wrapper-chain.ts';

function wrapperChainCandidates() {
  const snapshot = makeSnapshotState(UNVERIFIED_HITTABILITY_WRAPPER_CHAIN_NODES);
  return snapshot.nodes.filter((node) => node.identifier === 'scoring_home_button');
}

test('resolves the captured SwiftUI toolbar wrapper chain to its button', () => {
  const control = resolveUnverifiedWrapperControl(wrapperChainCandidates());

  assert.equal(control?.index, 1);
  assert.equal(control?.type, 'XCUIElementTypeButton');
});

test('keeps candidates with any verified hittability on the existing rules', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 1,
      type: 'XCUIElementTypeOther',
      identifier: 'profile',
      rect: { x: 20, y: 63, width: 36, height: 36 },
      hittable: false,
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      identifier: 'profile',
      rect: { x: 20, y: 63, width: 36, height: 36 },
      hittable: true,
    },
  ]);

  assert.equal(
    resolveUnverifiedWrapperControl(snapshot.nodes.filter((node) => node.identifier === 'profile')),
    null,
  );
});

test('refuses a chain whose rects differ beyond sub-pixel slack', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 1,
      type: 'XCUIElementTypeOther',
      identifier: 'profile',
      rect: { x: 20, y: 63, width: 60, height: 36 },
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      identifier: 'profile',
      rect: { x: 20, y: 63, width: 36, height: 36 },
    },
  ]);

  assert.equal(
    resolveUnverifiedWrapperControl(snapshot.nodes.filter((node) => node.identifier === 'profile')),
    null,
  );
});

test('refuses a chain whose deepest candidate is not a semantic touch target', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 1,
      type: 'XCUIElementTypeOther',
      identifier: 'banner',
      rect: { x: 20, y: 63, width: 36, height: 36 },
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'XCUIElementTypeOther',
      identifier: 'banner',
      rect: { x: 20, y: 63, width: 36, height: 36 },
    },
  ]);

  assert.equal(
    resolveUnverifiedWrapperControl(snapshot.nodes.filter((node) => node.identifier === 'banner')),
    null,
  );
});
