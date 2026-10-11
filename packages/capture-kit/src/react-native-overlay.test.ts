import { describe, expect, test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  analyzeReactNativeOverlay,
  formatReactNativeOverlayWarning,
} from './react-native-overlay.ts';

/**
 * Exercises the collapsed-warning scoring seam through the package's public analyzer. The
 * scoring comparators only run once two or more banner candidates are tied for dismissal, so
 * the single-banner daemon-handler tests never reach them.
 */

function node(overrides: Partial<SnapshotNode> & { ref: string; index: number }): SnapshotNode {
  return { kind: 'Unknown', ...overrides } as SnapshotNode;
}

const collapsedBannerRect = { x: 0, y: 794, width: 402, height: 52 };

describe('React Native collapsed warning dismissal', () => {
  test('a hittable banner wins dismissal over a non-hittable one at any position', () => {
    const state = analyzeReactNativeOverlay([
      node({
        index: 0,
        ref: 'e1',
        label: '!, Warning at the very bottom',
        rect: { ...collapsedBannerRect, y: 900 },
        hittable: false,
      }),
      node({
        index: 1,
        ref: 'e2',
        label: '!, Warning above it',
        rect: { ...collapsedBannerRect, y: 794 },
        hittable: true,
      }),
    ]);

    expect(state.detected).toBe(true);
    // Hittability outranks position: the tappable banner wins even though the other sits lower.
    expect(state.primaryAction).toMatchObject({
      action: 'close-collapsed-banner',
      ref: 'e2',
      label: '!, Warning above it',
    });
  });

  test('between two equally hittable banners the wider one is dismissed first', () => {
    const state = analyzeReactNativeOverlay([
      node({
        index: 0,
        ref: 'e1',
        label: '!, Narrow warning',
        rect: { x: 0, y: 500, width: 200, height: 52 },
        hittable: true,
      }),
      node({
        index: 1,
        ref: 'e2',
        label: '!, Wide warning',
        rect: { x: 0, y: 400, width: 402, height: 52 },
        hittable: true,
      }),
    ]);

    expect(state.primaryAction?.ref).toBe('e2');
  });

  test('two banners without a hittable fact fall back to width and then the lower position', () => {
    const state = analyzeReactNativeOverlay([
      node({
        index: 0,
        ref: 'e1',
        label: '!, Upper warning',
        rect: { x: 0, y: 300, width: 402, height: 52 },
      }),
      node({
        index: 1,
        ref: 'e2',
        label: '!, Lower warning',
        rect: { x: 0, y: 794, width: 402, height: 52 },
      }),
    ]);

    // Both score 0 on hittable and width, so the greater y — the banner the user sees last — wins.
    expect(state.primaryAction?.ref).toBe('e2');
  });

  test('formatReactNativeOverlayWarning answers only for a detected overlay', () => {
    const warning = formatReactNativeOverlayWarning([
      node({
        index: 0,
        ref: 'e1',
        label: '!, Open debugger to view warnings.',
        rect: collapsedBannerRect,
        hittable: true,
      }),
    ]);
    expect(warning).toContain('agent-device react-native dismiss-overlay');

    expect(formatReactNativeOverlayWarning([node({ index: 0, ref: 'e1', label: 'Save' })])).toBe(
      undefined,
    );
  });
});
