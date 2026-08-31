import { describe, expect, test } from 'vitest';
import { buildMaestroVisibilityContext, isMaestroNodeVisible } from '../snapshot-policy.ts';
import {
  ANDROID_GEOMETRYLESS_VISIBILITY_FIXTURE,
  ANDROID_ROOTLESS_VISIBILITY_FIXTURE,
  ANDROID_SCROLL_CLIPPED_VISIBILITY_FIXTURE,
  IOS_GEOMETRYLESS_VISIBILITY_FIXTURE,
} from './runtime-target-fixtures.ts';

describe('Android emitted visibility', () => {
  test('keeps a visible positive-geometry node in a rootless tree', () => {
    const snapshot = ANDROID_ROOTLESS_VISIBILITY_FIXTURE;
    const context = buildMaestroVisibilityContext(snapshot.nodes);

    expect(isMaestroNodeVisible(snapshot.nodes[1]!, context, 'android')).toBe(true);
  });

  test('clips a node against its nearest RecyclerView ancestor', () => {
    const snapshot = ANDROID_SCROLL_CLIPPED_VISIBILITY_FIXTURE;
    const context = buildMaestroVisibilityContext(snapshot.nodes);

    expect(isMaestroNodeVisible(snapshot.nodes[2]!, context, 'android')).toBe(false);
  });

  test('uses a hittable positive-geometry ancestor for a geometryless node', () => {
    const snapshot = ANDROID_GEOMETRYLESS_VISIBILITY_FIXTURE;
    const context = buildMaestroVisibilityContext(snapshot.nodes);

    expect(isMaestroNodeVisible(snapshot.nodes[2]!, context, 'android')).toBe(true);
  });

  test('rejects visibleToUser false before geometry resolution', () => {
    const snapshot = ANDROID_ROOTLESS_VISIBILITY_FIXTURE;
    const context = buildMaestroVisibilityContext(snapshot.nodes);

    expect(
      isMaestroNodeVisible({ ...snapshot.nodes[1]!, visibleToUser: false }, context, 'android'),
    ).toBe(false);
  });
});

describe('iOS emitted visibility', () => {
  test('uses a positive-geometry ancestor for a geometryless node', () => {
    const snapshot = IOS_GEOMETRYLESS_VISIBILITY_FIXTURE;
    const context = buildMaestroVisibilityContext(snapshot.nodes);

    expect(isMaestroNodeVisible(snapshot.nodes[2]!, context, 'ios')).toBe(true);
  });

  test('keeps the direct hittability decision for a geometryless node', () => {
    const snapshot = IOS_GEOMETRYLESS_VISIBILITY_FIXTURE;
    const context = buildMaestroVisibilityContext(snapshot.nodes);

    expect(isMaestroNodeVisible(snapshot.nodes[3]!, context, 'ios')).toBe(true);
  });
});
