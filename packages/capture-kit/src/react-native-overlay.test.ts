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

  test('a collapsed LogBox bar labelled with only a severity prefix is still an overlay', () => {
    // No `!, ` prefix, no listed marker, no stack text: the pressable banner shape is the signal.
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        type: 'Other',
        label: 'Warning: state update on an unmounted component',
        rect: collapsedBannerRect,
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes).detected).toBe(true);
    expect(formatReactNativeOverlayWarning(nodes)).toContain('dismiss-overlay');
  });

  test('passive app error text in a banner-sized label is not an overlay', () => {
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        type: 'StaticText',
        label: 'Error: invalid email',
        rect: collapsedBannerRect,
        hittable: false,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes).detected).toBe(false);
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
