import type { RawSnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';

/**
 * The permanent contract fixture trees (ADR 0011 Layer 3): the real
 * Bluesky-shaped snapshots that found the offscreen/occlusion/non-hittable
 * bugs, kept as the shapes every dispatch path is proven against.
 */

// Closed drawer: the only "Explore" match sits fully left of the Application
// viewport. Tapping it would silently press out-of-viewport coordinates.
export function closedDrawerSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'Button',
      label: 'Explore',
      rect: { x: -320, y: 240, width: 300, height: 50 },
      hittable: true,
    },
  ]);
}

// Closed drawer item plus a visible bottom-tab twin: both match
// `label=Profile`, and the on-screen candidate must win disambiguation.
export function drawerWithVisibleTwinSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'Button',
      label: 'Profile',
      rect: { x: 20, y: 740, width: 200, height: 50 },
      hittable: true,
    },
    {
      index: 2,
      depth: 3,
      parentIndex: 0,
      type: 'Button',
      label: 'Profile',
      rect: { x: -320, y: 240, width: 100, height: 20 },
      hittable: false,
    },
  ]);
}

// React Native wrapper chain: cell/button/text expose the same label, but all
// three structurally identify the one actionable button.
export function equivalentWrapperChainSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Cell',
      label: 'Chat',
      rect: { x: 20, y: 740, width: 100, height: 50 },
      hittable: false,
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Chat',
      rect: { x: 20, y: 740, width: 100, height: 50 },
      hittable: true,
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'StaticText',
      label: 'Chat',
      rect: { x: 20, y: 740, width: 100, height: 50 },
      hittable: false,
    },
  ]);
}

// Bluesky regression: the closed drawer's overlay container pokes a fraction
// of a pixel into the viewport (float rounding), but every tap point is far
// off-screen. Edge overlap must not count as on-screen.
export function edgeGrazingDrawerSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      rect: { x: -321.6, y: 0, width: 321.67, height: 874 },
      hittable: false,
    },
    {
      index: 2,
      depth: 3,
      parentIndex: 1,
      type: 'Button',
      label: 'Explore',
      rect: { x: -321.6, y: 240, width: 321.33, height: 50 },
      hittable: false,
    },
  ]);
}

// A button flagged covered by a floating tab bar overlay.
export function coveredButtonSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Save draft',
      rect: { x: 16, y: 790, width: 140, height: 44 },
      hittable: false,
      interactionBlocked: 'covered',
      presentationHints: ['covered'],
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'TabBar',
      rect: { x: 0, y: 760, width: 390, height: 84 },
      hittable: true,
    },
  ]);
}

// A semantic parent whose entire surface belongs to independently interactive
// children. Parent-targeted coordinate paths must fail closed and preserve the
// caller's selector/ref context instead of silently activating any child.
export function fullyTiledParentSnapshot(): SnapshotState {
  const children = Array.from({ length: 10 }, (_, childIndex) => ({
    index: childIndex + 2,
    depth: 2,
    parentIndex: 1,
    type: 'Button',
    label: `Action ${childIndex + 1}`,
    rect: { x: 20, y: 100 + childIndex * 20, width: 360, height: 20 },
    hittable: true,
  }));
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Link',
      label: 'Card',
      rect: { x: 20, y: 100, width: 360, height: 200 },
      hittable: true,
    },
    ...children,
  ]);
}

// A visible list cell that iOS reports as non-hittable (#1037 shape): the
// interaction must proceed but be annotated.
export function nonHittableCellSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeOther',
      label: 'Settings list',
      rect: { x: 10, y: 20, width: 300, height: 80 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeCell',
      label: 'Account',
      rect: { x: 20, y: 10, width: 100, height: 40 },
      hittable: false,
    },
  ]);
}

// Baseline happy-path tree: one hittable button.
export function continueButtonSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Continue',
      value: 'Continue',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
  ]);
}

// Same button, reported non-hittable.
export function nonHittableButtonSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Continue',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: false,
    },
  ]);
}

// Post-action settled tree for --settle scenarios: vs continueButtonSnapshot
// the Continue button is replaced by a Welcome text — exactly one addition and
// one removal in the settled diff, with the added line carrying its ref.
export function settledWelcomeSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'StaticText',
      label: 'Welcome!',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
  ]);
}

// Viewport-only tree for coordinate scenarios.
export function viewportOnlySnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
  ]);
}

/** Dual-endpoint drag tree with an off-screen destination twin for ranking coverage. */
export function dragEndpointsSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'View',
      identifier: 'source',
      label: 'Source',
      rect: { x: 20, y: 100, width: 100, height: 60 },
      hittable: true,
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'View',
      identifier: 'destination',
      label: 'Drop',
      rect: { x: 240, y: 500, width: 120, height: 80 },
      hittable: true,
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 0,
      type: 'View',
      label: 'Other drop',
      rect: { x: -200, y: 500, width: 120, height: 80 },
      hittable: false,
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 2,
      type: 'StaticText',
      label: 'Drop',
      rect: { x: 240, y: 500, width: 120, height: 80 },
      hittable: false,
    },
  ]);
}

export function runnerPresentedDragEndpointsNodes(): RawSnapshotNode[] {
  return dragEndpointsSnapshot()
    .nodes.filter((node) => node.index !== 3)
    .map(({ ref: _ref, ...node }) => node);
}

/**
 * Runner-side node payloads (the shape `ios.runner.snapshot` returns) for the
 * provider-transcript scenarios.
 */

export const RUNNER_CONTINUE_NODES = [
  {
    index: 0,
    type: 'Application',
    label: 'Example',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Continue',
    hittable: true,
    rect: { x: 100, y: 300, width: 200, height: 44 },
  },
] as const;

export const RUNNER_NON_HITTABLE_TEXT_INPUT_NODES = [
  {
    index: 0,
    type: 'Application',
    label: 'Example',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'TextField',
    label: 'Pin',
    hittable: false,
    rect: { x: 20, y: 40, width: 160, height: 40 },
  },
] as const;

// #2589 shape, recorded from the iOS repro: the bottom tab bar sits behind the system keyboard.
// The keyboard is its own system surface, so it is never a covering sibling of app content here
// (`occlusion` stays silent) and the tab bar is still inside the app's own window rect
// (`offscreen` passes) — the tap used to report success while the key ate the touch.
// The key rects are the bottom row measured on iPhone 17 Pro (26.2): a keyboard the guard will
// measure has to report one unbroken run of columns, so a reduced layout cannot stop at two keys.
export function keyboardCoveredTabBarSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 1,
      depth: 2,
      parentIndex: 0,
      type: 'Button',
      label: 'Form',
      rect: { x: 148, y: 791, width: 104, height: 83 },
      hittable: true,
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Keyboard',
      rect: { x: 0, y: 583, width: 402, height: 291 },
      hittable: false,
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 2,
      type: 'Key',
      label: 'globe',
      rect: { x: 4.67, y: 752, width: 49.33, height: 54 },
      hittable: true,
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 2,
      type: 'Key',
      label: '.?123',
      rect: { x: 54, y: 752, width: 49.33, height: 54 },
      hittable: true,
    },
    {
      index: 5,
      depth: 2,
      parentIndex: 2,
      type: 'Key',
      label: 'space',
      rect: { x: 103.33, y: 752, width: 197.33, height: 54 },
      hittable: true,
    },
    {
      index: 6,
      depth: 2,
      parentIndex: 2,
      type: 'Key',
      label: 'return',
      rect: { x: 300.67, y: 752, width: 99, height: 54 },
      hittable: true,
    },
  ]);
}
