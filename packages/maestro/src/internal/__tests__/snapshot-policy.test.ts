import { describe, expect, test } from 'vitest';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import { isMaestroNodeVisible } from '../snapshot-policy.ts';
import { makeSnapshot } from './runtime-target-fixtures.ts';

const ANDROID_ROOTLESS_VISIBILITY_FIXTURE = makeSnapshot([
  {
    index: 0,
    type: 'android.widget.FrameLayout',
    visibleToUser: true,
    rect: { x: 0, y: 0, width: 1080, height: 2400 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'android.widget.TextView',
    visibleToUser: true,
    rect: { x: 40, y: 300, width: 400, height: 80 },
  },
]);

const ANDROID_SCROLL_CLIPPED_VISIBILITY_FIXTURE = makeSnapshot([
  {
    index: 0,
    type: 'android.widget.FrameLayout',
    visibleToUser: true,
    rect: { x: 0, y: 0, width: 1080, height: 2400 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'androidx.recyclerview.widget.RecyclerView',
    visibleToUser: true,
    rect: { x: 20, y: 100, width: 1040, height: 500 },
  },
  {
    index: 2,
    parentIndex: 1,
    type: 'android.widget.TextView',
    visibleToUser: true,
    rect: { x: 40, y: 700, width: 400, height: 80 },
  },
]);

const ANDROID_GEOMETRYLESS_VISIBILITY_FIXTURE = makeSnapshot([
  {
    index: 0,
    type: 'android.widget.FrameLayout',
    visibleToUser: true,
    rect: { x: 0, y: 0, width: 1080, height: 2400 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'android.widget.Button',
    hittable: true,
    visibleToUser: true,
    rect: { x: 40, y: 300, width: 400, height: 80 },
  },
  {
    index: 2,
    parentIndex: 1,
    type: 'android.widget.TextView',
    visibleToUser: true,
  },
]);

const IOS_GEOMETRYLESS_VISIBILITY_FIXTURE = makeSnapshot([
  {
    index: 0,
    type: 'Application',
    rect: { x: 0, y: 0, width: 402, height: 874 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    hittable: false,
    rect: { x: 20, y: 100, width: 200, height: 60 },
  },
  {
    index: 2,
    parentIndex: 1,
    type: 'StaticText',
  },
  {
    index: 3,
    parentIndex: 0,
    type: 'Button',
    hittable: true,
  },
]);

describe('Android emitted visibility', () => {
  test('keeps a visible positive-geometry node in a rootless tree', () => {
    const snapshot = ANDROID_ROOTLESS_VISIBILITY_FIXTURE;
    const context = createSnapshotVisibility(snapshot.nodes);

    expect(isMaestroNodeVisible(snapshot.nodes[1]!, context, 'android')).toBe(true);
  });

  test('clips a node against its nearest RecyclerView ancestor', () => {
    const snapshot = ANDROID_SCROLL_CLIPPED_VISIBILITY_FIXTURE;
    const context = createSnapshotVisibility(snapshot.nodes);

    expect(isMaestroNodeVisible(snapshot.nodes[2]!, context, 'android')).toBe(false);
  });

  test('uses a hittable positive-geometry ancestor for a geometryless node', () => {
    const snapshot = ANDROID_GEOMETRYLESS_VISIBILITY_FIXTURE;
    const context = createSnapshotVisibility(snapshot.nodes);

    expect(isMaestroNodeVisible(snapshot.nodes[2]!, context, 'android')).toBe(true);
  });

  test('rejects visibleToUser false before geometry resolution', () => {
    const snapshot = ANDROID_ROOTLESS_VISIBILITY_FIXTURE;
    const context = createSnapshotVisibility(snapshot.nodes);

    expect(
      isMaestroNodeVisible({ ...snapshot.nodes[1]!, visibleToUser: false }, context, 'android'),
    ).toBe(false);
  });
});

describe('iOS emitted visibility', () => {
  test('uses a positive-geometry ancestor for a geometryless node', () => {
    const snapshot = IOS_GEOMETRYLESS_VISIBILITY_FIXTURE;
    const context = createSnapshotVisibility(snapshot.nodes);

    expect(isMaestroNodeVisible(snapshot.nodes[2]!, context, 'ios')).toBe(true);
  });

  test('keeps the direct hittability decision for a geometryless node', () => {
    const snapshot = IOS_GEOMETRYLESS_VISIBILITY_FIXTURE;
    const context = createSnapshotVisibility(snapshot.nodes);

    expect(isMaestroNodeVisible(snapshot.nodes[3]!, context, 'ios')).toBe(true);
  });
});
