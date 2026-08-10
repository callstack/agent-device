import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { isAndroidInputMethodSnapshotNode } from '../android-input-method-overlays.ts';
import { annotateCoveredSnapshotNodes } from '../snapshot-occlusion.ts';

test('an Android input-method window covers app targets emitted after it', () => {
  const nodes: RawSnapshotNode[] = [
    {
      index: 0,
      type: 'android.widget.FrameLayout',
      label: 'Q',
      identifier: 'com.google.android.inputmethod.latin:id/key_pos_0_0',
      bundleId: 'com.google.android.inputmethod.latin',
      rect: { x: 50, y: 500, width: 100, height: 100 },
      hittable: true,
    },
    {
      index: 1,
      type: 'android.widget.Button',
      label: 'Covered app target',
      identifier: 'covered-app-target',
      bundleId: 'com.example.app',
      rect: { x: 0, y: 450, width: 200, height: 200 },
      hittable: true,
    },
  ];

  const annotated = annotateCoveredSnapshotNodes(nodes, {
    isAdditionalOverlayNode: isAndroidInputMethodSnapshotNode,
  });

  assert.equal(annotated[0]?.interactionBlocked, undefined);
  assert.equal(annotated[1]?.interactionBlocked, 'covered');
  assert.equal(annotated[1]?.hittable, false);
});
