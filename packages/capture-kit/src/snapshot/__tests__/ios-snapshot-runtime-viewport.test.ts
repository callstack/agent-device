import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-acquisition';
import { presentIosSnapshotAcquisition } from '../ios-snapshot-runtime.ts';
import type { IosViewportEvidence } from '@agent-device/contracts/ios-snapshot';
import { AppError } from '@agent-device/kernel/errors';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

// #3182: the provider acquisitions — the simulator AX bridge, an Appium page source, a Limrun tree —
// already resolve the box their nodes are measured in, and this presenter is the one seam that turns
// an acquisition into a snapshot result. Publishing nothing here left the default local-iOS producer
// without a viewport while it held the evidence, which is the issue's first `Done when` line.

const SCREEN = { x: 0, y: 0, width: 390, height: 844 };

const NODES: readonly RawSnapshotNode[] = [
  { index: 0, type: 'Application', rect: SCREEN },
  { index: 1, parentIndex: 0, type: 'Button', label: 'Open', rect: { ...SCREEN, width: 80 } },
];

function acquire(viewport: IosViewportEvidence) {
  return createIosSnapshotAcquisition({
    producer: 'appium-source',
    nodes: NODES,
    viewport,
    lineage: { targetId: 'sim-1:com.example.app' },
  });
}

test('an acquisition publishes the viewport box the regular fold measured against (#3182)', () => {
  const presented = presentIosSnapshotAcquisition(acquire({ kind: 'reported', rect: SCREEN }));

  assert.deepEqual(presented.viewport, { width: 390, height: 844 });
});

// The regular fold refuses a capture with no viewport, so absence is only reachable on a raw
// projection — which is also the projection that validates no box at all.
test('a raw acquisition publishes no viewport, since nothing checked it (#3182)', () => {
  const presented = presentIosSnapshotAcquisition(acquire({ kind: 'reported', rect: SCREEN }), {
    raw: true,
  });

  assert.equal('viewport' in presented, false);
});

test('a raw acquisition carrying the failed-read box publishes no viewport (#3182)', () => {
  const presented = presentIosSnapshotAcquisition(
    acquire({
      kind: 'reported',
      rect: {
        x: -Number.MAX_VALUE / 2,
        y: -Number.MAX_VALUE / 2,
        width: Number.MAX_VALUE,
        height: Number.MAX_VALUE,
      },
    }),
    { raw: true },
  );

  assert.equal('viewport' in presented, false);
});

test('a regular acquisition with no viewport evidence still refuses rather than minting one', () => {
  assert.throws(
    () => presentIosSnapshotAcquisition(acquire({ kind: 'missing', reason: 'not-provided' })),
    (error: unknown) => error instanceof AppError && error.code === 'COMMAND_FAILED',
  );
});

// The issue's second Done-when line: an empty screen still reports the box. The box is a property of
// the surface the producer read, so a tree that names nothing on it still answers the question.
test('an empty iOS acquisition still publishes the viewport it read (#3182)', () => {
  const empty = createIosSnapshotAcquisition({
    producer: 'appium-source',
    nodes: [],
    viewport: { kind: 'reported', rect: SCREEN },
    lineage: { targetId: 'sim-1:com.example.app' },
  });

  const presented = presentIosSnapshotAcquisition(empty);

  assert.deepEqual(presented.nodes, []);
  assert.deepEqual(presented.viewport, { width: 390, height: 844 });
});
