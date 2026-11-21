import { describe, expect, test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { snapshotViewportSizeFrom } from '@agent-device/kernel/rect';
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

describe('React Native overlay evidence', () => {
  test('app text with a generic severity prefix is not an overlay', () => {
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        type: 'StaticText',
        label: 'Error: invalid email',
        rect: { x: 16, y: 300, width: 300, height: 44 },
      }),
      node({ index: 1, ref: 'e2', type: 'Button', label: 'Close', hittable: true }),
    ];
    expect(analyzeReactNativeOverlay(nodes).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes)).toBe(undefined);
  });

  test('iOS app error text in a two-line banner-sized StaticText is not an overlay', () => {
    // iOS reports `hittable` from geometry, so every visible StaticText is hittable: neither that
    // flag nor the banner shape is evidence for a bare severity prefix.
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        type: 'StaticText',
        label: 'Error: password must contain at least 8 characters and one number',
        rect: { x: 16, y: 412, width: 370, height: 40 },
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes)).toBe(undefined);
  });

  test('a generic severity banner counts once a React Native stack frame is on screen', () => {
    const nodes = [
      node({ index: 0, ref: 'e1', label: 'Warning: state update on unmounted component' }),
      node({ index: 1, ref: 'e2', label: 'App.tsx:42:7', rect: collapsedBannerRect }),
    ];
    expect(analyzeReactNativeOverlay(nodes).detected).toBe(true);
  });

  test('a collapsed LogBox summary banner is an overlay by itself', () => {
    const nodes = [
      node({ index: 0, ref: 'e1', label: '!, Warning: x', rect: collapsedBannerRect }),
    ];
    expect(analyzeReactNativeOverlay(nodes).detected).toBe(true);
  });
});

/**
 * From two entries up, LogBox's badge renders the entry count instead of `!`
 * (`LogBoxNotificationCountBadge`), so the banner's joined label starts with a number. App rows
 * open the same way, which is why the count form arms only on LogBox's own banner placement.
 */
describe('React Native collapsed banner with the entry-count badge', () => {
  const iosViewport = snapshotViewportSizeFrom({ x: 0, y: 0, width: 402, height: 874 });
  const androidViewport = snapshotViewportSizeFrom({ x: 0, y: 0, width: 1080, height: 2400 });
  /** LogBox's frame on a 402x874 surface: `left: 10; right: 10; bottom: 20`, notification 48 high. */
  const iosCountBannerRect = { x: 10, y: 806, width: 382, height: 48 };

  test('a banner whose badge shows the entry count is an overlay and a dismiss target', () => {
    const state = analyzeReactNativeOverlay(
      [
        node({
          index: 0,
          ref: 'e1',
          label: '20, Failed to fetch',
          rect: iosCountBannerRect,
          hittable: true,
        }),
      ],
      iosViewport,
    );

    expect(state.detected).toBe(true);
    expect(state.primaryAction).toMatchObject({
      action: 'close-collapsed-banner',
      ref: 'e1',
      label: '20, Failed to fetch',
    });
  });

  test('a device-pixel count banner floating off the bottom edge is an overlay', () => {
    const state = analyzeReactNativeOverlay(
      [
        node({
          index: 0,
          ref: 'e1',
          label: '8, Network request failed',
          rect: { x: 28, y: 2213, width: 1024, height: 132 },
          hittable: true,
        }),
      ],
      androidViewport,
    );

    expect(state.detected).toBe(true);
  });

  test('an ordinary row whose label starts with a number is not an overlay', () => {
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        label: '2, Morning',
        rect: { x: 0, y: 320, width: 402, height: 52 },
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes, iosViewport).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes, iosViewport)).toBe(undefined);
  });

  test('a tab bar row whose label starts with a number is not an overlay', () => {
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        label: '3, Cart',
        rect: { x: 202, y: 811, width: 200, height: 63 },
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes, iosViewport).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes, iosViewport)).toBe(undefined);
  });

  test('a full-width footer row flush with the bottom edge is not an overlay', () => {
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        label: '2, Continue shopping',
        rect: { x: 0, y: 822, width: 402, height: 52 },
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes, iosViewport).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes, iosViewport)).toBe(undefined);
  });

  test('a tablet-width count banner keeps the fixed LogBox side gap', () => {
    // LogBox's side gap is a fixed 10 units, so a 1% floor would reject the real banner once the
    // surface passes 1000 units: a 13" iPad Pro portrait window, every iPad in landscape, an
    // unfolded foldable.
    const iPadViewport = snapshotViewportSizeFrom({ x: 0, y: 0, width: 1032, height: 1376 });
    const state = analyzeReactNativeOverlay(
      [
        node({
          index: 0,
          ref: 'e1',
          label: '7, Unable to load image',
          rect: { x: 10, y: 1308, width: 1012, height: 48 },
          hittable: true,
        }),
      ],
      iPadViewport,
    );

    expect(state.detected).toBe(true);
  });

  test('an inset card above the tab bar is not an overlay', () => {
    // The card keeps 16pt side gaps, wider than LogBox's fixed 10, so only the banner's own gap
    // width separates it from a count banner.
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        label: '3, New messages',
        rect: { x: 16, y: 719, width: 370, height: 72 },
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes, iosViewport).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes, iosViewport)).toBe(undefined);
  });

  test('a price label is not an overlay', () => {
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        label: '20,000원',
        rect: iosCountBannerRect,
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes, iosViewport).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes, iosViewport)).toBe(undefined);
  });

  test('a count banner is not an overlay when the capture published no box', () => {
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        label: '20, Failed to fetch',
        rect: iosCountBannerRect,
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes).detected).toBe(false);
  });
});
