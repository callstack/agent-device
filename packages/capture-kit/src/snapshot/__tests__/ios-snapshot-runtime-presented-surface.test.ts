import assert from 'node:assert/strict';
import { test } from 'vitest';
import { presentIosSnapshotAcquisition } from '../ios-snapshot-runtime.ts';
import { createIosSnapshotRequest, deriveIosCaptureHint } from '../../ios-snapshot-planning.ts';
import type { IosSnapshotAcquisition } from '@agent-device/contracts/ios-snapshot';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

// #3565: this seam is where an acquisition becomes the snapshot result the daemon, the Linux provider
// and the macOS desktop consume, so it is where the presented-surface fact enters `SnapshotResult`.
// Nothing else reaches it: the engine's own tests stop at the publication it builds, and the carriage
// tests enter above it through a backend, so a projection that dropped the field here would leave a
// settle confirmation reading silence as "no producer spoke".

const SCREEN = { x: 0, y: 0, width: 390, height: 844 };

/** One window, one presentation container, and the dimming view that container owns. */
const PRESENTED_NODES: readonly RawSnapshotNode[] = [
  { index: 0, type: 'Application', role: 'UIApplication', rect: SCREEN },
  { index: 1, parentIndex: 0, type: 'Window', role: 'UIWindow', rect: SCREEN },
  { index: 2, parentIndex: 1, type: 'Other', role: 'UITransitionView', rect: SCREEN },
  {
    index: 3,
    parentIndex: 2,
    type: 'Other',
    role: 'UIDimmingView',
    rect: SCREEN,
    userInteractionEnabled: true,
  },
];

/** The same tree as a producer that reports no UIKit class names publishes it. */
const CLASS_BLIND_NODES: readonly RawSnapshotNode[] = PRESENTED_NODES.map(
  ({ role: _role, ...node }) => node,
);

/**
 * Both cases state that nothing was capped, so the answers below differ by class evidence alone and
 * not by a completeness statement the producer never made.
 */
function acquiring(nodes: readonly RawSnapshotNode[]): SnapshotRuntimeAcquiredResult {
  const hint = deriveIosCaptureHint(createIosSnapshotRequest({}));
  const acquisition: IosSnapshotAcquisition = {
    producer: 'simulator-ax-bridge',
    intent: 'full',
    hint: { ...hint, acquisitionIntent: 'full' },
    nodes,
    truncated: false,
    viewport: { kind: 'reported', rect: SCREEN },
    lineage: { targetId: 'simulator-1', generation: 'generation-1' },
    residue: [],
  };
  return { stage: 'acquired', acquisition };
}

test('the snapshot result carries the presented-surface fact of the tree it projects (#3565)', () => {
  const presented = presentIosSnapshotAcquisition(acquiring(PRESENTED_NODES));

  assert.equal(presented.presentedSurface, 'presented');
});

// A capture whose producer reports no class names can show no window structure, so it cannot earn
// `absent`. It answers `unknown` rather than nothing, which is what lets a consumer tell "this
// producer could not read it" apart from "no producer classified this capture at all".
test('a class-blind acquisition answers unknown rather than silence (#3565)', () => {
  const presented = presentIosSnapshotAcquisition(acquiring(CLASS_BLIND_NODES));

  assert.equal(presented.presentedSurface, 'unknown');
});
