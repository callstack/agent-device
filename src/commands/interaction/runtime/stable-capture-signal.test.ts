import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSnapshotState } from '../../../__tests__/test-utils/snapshot-builders.ts';
import { stableCaptureSignal, stableCaptureSignalsEqual } from './stable-capture-signal.ts';
import { elementSettingsSnapshot } from './stable-capture.fixtures.ts';

function snapshot(jitter: number, hiddenY: number) {
  return makeSnapshotState(
    [
      {
        index: 0,
        depth: 0,
        type: 'Application',
        label: 'Element',
        rect: { x: 0, y: 0, width: 402, height: 874 },
        hittable: false,
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'ScrollView',
        rect: { x: 0, y: 96, width: 402, height: 700 },
        hittable: true,
      },
      {
        index: 2,
        depth: 2,
        parentIndex: 1,
        type: 'Button',
        label: 'Profile',
        rect: { x: 17 + jitter, y: 120, width: 44, height: 44 },
        hittable: true,
      },
      {
        index: 3,
        depth: 2,
        parentIndex: 1,
        type: 'Button',
        label: 'Theme',
        rect: { x: 16, y: hiddenY, width: 360, height: 44 },
        hittable: false,
      },
    ],
    {
      backend: 'xctest',
      snapshotQuality: {
        state: 'recovered',
        backend: 'private-ax',
        reasonCode: 'deferred',
        reason: 'penalty',
      },
    },
  );
}

test('private-ax stability ignores offscreen churn', () => {
  assert.equal(
    stableCaptureSignalsEqual(
      stableCaptureSignal(snapshot(0, 900)),
      stableCaptureSignal(snapshot(0, 980)),
    ),
    true,
  );
});

test('private-ax stability tolerates one-pixel geometry jitter', () => {
  assert.equal(
    stableCaptureSignalsEqual(
      stableCaptureSignal(snapshot(0, 900)),
      stableCaptureSignal(snapshot(1, 900)),
    ),
    true,
  );
});

test('regular snapshot stability ignores offscreen scroll-descendant churn', () => {
  assert.equal(
    stableCaptureSignalsEqual(
      stableCaptureSignal(elementSettingsSnapshot([1_138, 1_423, 2_144, 2_434])),
      stableCaptureSignal(elementSettingsSnapshot([1_187, 1_423, 1_858, 2_144, 2_261])),
    ),
    true,
  );
});

test('capture backend transitions reset otherwise identical visible semantics', () => {
  const tree = snapshot(0, 700);
  const privateAx = snapshot(0, 700);
  tree.snapshotQuality = { state: 'healthy', backend: 'tree' };
  privateAx.snapshotQuality = { state: 'recovered', backend: 'private-ax' };

  assert.equal(
    stableCaptureSignalsEqual(stableCaptureSignal(tree), stableCaptureSignal(privateAx)),
    false,
  );
});

test('non-iOS captures retain their backend-owned node projection', () => {
  const left = snapshot(0, 900);
  const right = snapshot(0, 980);
  left.backend = 'android';
  right.backend = 'android';

  assert.equal(
    stableCaptureSignalsEqual(stableCaptureSignal(left), stableCaptureSignal(right)),
    false,
  );
});

test('stable semantic projection stays linear on large scroll trees', () => {
  const state = elementSettingsSnapshot(
    Array.from({ length: 256 }, (_, offset) => 900 + offset * 49),
  );
  let nodeReads = 0;
  state.nodes = new Proxy(state.nodes, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) nodeReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  const signal = stableCaptureSignal(state);

  assert.equal(signal.nodes.length, 3);
  assert.ok(
    nodeReads <= state.nodes.length * 20,
    `projected ${state.nodes.length} nodes with ${nodeReads} node reads`,
  );
});

test('stable semantic projection stays linear on flat XCTest trees', () => {
  const state = makeSnapshotState(
    [
      {
        index: 0,
        depth: 0,
        type: 'Application',
        rect: { x: 0, y: 0, width: 402, height: 874 },
      },
      ...Array.from({ length: 256 }, (_, offset) => ({
        index: offset + 1,
        depth: 1,
        parentIndex: 0,
        type: 'Button',
        label: `Button ${offset}`,
        rect: { x: 16, y: 900 + offset * 49, width: 360, height: 44 },
      })),
    ],
    { backend: 'xctest', snapshotQuality: { state: 'healthy', backend: 'tree' } },
  );
  let nodeReads = 0;
  state.nodes = new Proxy(state.nodes, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) nodeReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  assert.equal(stableCaptureSignal(state).nodes.length, 1);
  assert.ok(
    nodeReads <= state.nodes.length * 20,
    `projected ${state.nodes.length} nodes with ${nodeReads} node reads`,
  );
});

test('regular snapshot stability preserves rounded geometry tolerance', () => {
  const left = snapshot(0, 900);
  const right = snapshot(0.6, 900);
  left.snapshotQuality = { state: 'healthy', backend: 'tree' };
  right.snapshotQuality = { state: 'healthy', backend: 'tree' };
  assert.equal(
    stableCaptureSignalsEqual(stableCaptureSignal(left), stableCaptureSignal(right)),
    true,
  );
});

test('a semantic identity change is never stable', () => {
  const changed = snapshot(0, 900);
  changed.nodes[2]!.label = 'Settings';
  assert.equal(
    stableCaptureSignalsEqual(stableCaptureSignal(snapshot(0, 900)), stableCaptureSignal(changed)),
    false,
  );
});

test('a semantic value change is never stable', () => {
  const changed = snapshot(0, 900);
  changed.nodes[2]!.value = 'Enabled';
  assert.equal(
    stableCaptureSignalsEqual(stableCaptureSignal(snapshot(0, 900)), stableCaptureSignal(changed)),
    false,
  );
});

test('semantic whitespace changes do not restart the stability window', () => {
  const padded = snapshot(0, 900);
  padded.nodes[2]!.label = ' Profile ';
  padded.nodes[2]!.identifier = ' profile-button ';
  padded.nodes[2]!.value = ' Enabled ';
  const trimmed = snapshot(0, 900);
  trimmed.nodes[2]!.label = 'Profile';
  trimmed.nodes[2]!.identifier = 'profile-button';
  trimmed.nodes[2]!.value = 'Enabled';

  assert.equal(
    stableCaptureSignalsEqual(stableCaptureSignal(padded), stableCaptureSignal(trimmed)),
    true,
  );
});

test('geometry movement beyond the stability tolerance is never stable', () => {
  assert.equal(
    stableCaptureSignalsEqual(
      stableCaptureSignal(snapshot(0, 900)),
      stableCaptureSignal(snapshot(3, 900)),
    ),
    false,
  );
});
