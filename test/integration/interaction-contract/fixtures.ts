import type { SnapshotState } from '../../../src/kernel/snapshot.ts';
import { makeSnapshotState } from '../../../src/__tests__/test-utils/index.ts';

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
      label: 'Explore',
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

// Seven identically labeled, on-screen "Item" rows at increasing depth: the
// deepest (last) row wins disambiguation, leaving 6 losing candidates so the
// ADR 0012 decision 2 five-alternative cap actually has something to cap.
export function manyMatchingItemRowsSnapshot(): SnapshotState {
  return makeSnapshotState(
    Array.from({ length: 7 }, (_, i) => ({
      index: i,
      depth: i + 1,
      type: 'Button',
      label: 'Item',
      rect: { x: 0, y: i * 40, width: 100, height: 40 },
      hittable: true,
    })),
  );
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

export const RUNNER_CHANGED_NODES = [
  {
    index: 0,
    type: 'Application',
    label: 'Example',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'StaticText',
    label: 'Welcome!',
    rect: { x: 100, y: 300, width: 200, height: 44 },
  },
] as const;

// Runner-side closed drawer: the only match is off-screen, so the runtime
// fallback path must refuse it instead of tapping out-of-viewport coordinates.
export const RUNNER_CLOSED_DRAWER_NODES = [
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
    label: 'Explore',
    hittable: true,
    rect: { x: -320, y: 240, width: 300, height: 50 },
  },
] as const;

// Runner-side covered control (#1091 delegation): the runner skips it as
// non-hittable (ELEMENT_NOT_FOUND) and the runtime fallback must refuse with
// the covered shape instead of tapping through the overlay.
export const RUNNER_COVERED_NODES = [
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
    label: 'Save draft',
    hittable: false,
    interactionBlocked: 'covered',
    rect: { x: 16, y: 700, width: 140, height: 44 },
  },
] as const;

// Runner-side visible-but-non-hittable cell (#1037 shape): the runner reports
// ELEMENT_NOT_FOUND, the runtime fallback proceeds by coordinates and
// annotates the result instead of failing.
export const RUNNER_NON_HITTABLE_NODES = [
  {
    index: 0,
    type: 'Application',
    label: 'Example',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'Cell',
    label: 'Recents row',
    hittable: false,
    rect: { x: 20, y: 300, width: 360, height: 60 },
  },
] as const;
