import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeSnapshotState } from '../../__tests__/test-utils/snapshot-builders.ts';
import type { SessionState } from '../types.ts';

/**
 * Shared fixtures for the deferred-interaction-outcome test cluster:
 * post-gesture-stabilization.test.ts (the async capture loop),
 * post-gesture-stabilization-verdict.test.ts (the pure verdict/classifier
 * coverage — split by subject per #1563 review, to stay under the repo's
 * 500-line test-file tripwire, AGENTS.md), deferred-interaction-outcome.test.ts,
 * and session-snapshot-freshness.test.ts. Not a `.test.ts` file, so vitest
 * never tries to run it directly.
 */

export function pickupSnapshot(y = 500) {
  return makeSnapshotState([
    { index: 0, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'shipping-pickup',
      label: 'Pickup',
      rect: { x: 20, y, width: 200, height: 44 },
    },
  ]);
}

// Same Application root as pickupSnapshot, but a DIFFERENT real element —
// models a genuine, successful scroll that swapped every real element in
// view, so the only entry shared with a pickupSnapshot baseline is the root.
export function deliverySnapshot(y = 500) {
  return makeSnapshotState([
    { index: 0, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'shipping-delivery',
      label: 'Delivery',
      rect: { x: 20, y, width: 200, height: 44 },
    },
  ]);
}

// Broader-scope variant: adds a non-interactive text node an interactive-only
// capture would never return, modeling the real pre-gesture-baseline vs
// post-gesture-selector-capture scope mismatch.
export function pickupSnapshotWithExtraText(y = 500) {
  const base = pickupSnapshot(y);
  return {
    ...base,
    nodes: [
      ...base.nodes,
      {
        ref: 'e3',
        index: 2,
        parentIndex: 0,
        type: 'Text',
        label: 'Delivery choices',
        rect: { x: 20, y: 300, width: 200, height: 20 },
      },
    ],
  };
}

/**
 * Fixed tab-bar chrome + a list whose visible cells sit at stable row rects.
 * Two captures with DIFFERENT cell ids model a successful scroll that
 * replaced every list row while the chrome (a discriminating, shared,
 * unmoved entry) stayed put: `classifyBaselineSurfaceEvidence` reads
 * 'unchanged' from the shared chrome alone (#1601 review P1) — the exact
 * accept-stale false negative that must never surface as an agent-facing
 * no-effect claim.
 */
export function chromeWithListSnapshot(cellIds: [string, string]) {
  return makeSnapshotState([
    { index: 0, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'tab-home',
      label: 'Home',
      rect: { x: 0, y: 800, width: 195, height: 44 },
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'Cell',
      identifier: cellIds[0],
      label: cellIds[0],
      rect: { x: 0, y: 100, width: 390, height: 60 },
    },
    {
      index: 3,
      parentIndex: 0,
      type: 'Cell',
      identifier: cellIds[1],
      label: cellIds[1],
      rect: { x: 0, y: 160, width: 390, height: 60 },
    },
  ]);
}

export function applicationRootNode() {
  return {
    ref: 'e-root',
    index: 0,
    type: 'Application',
    label: 'App',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  };
}

/**
 * A keyboard-window subtree modeling the #1563 review's second finding: a
 * `[Keyboard]` container PLUS a sibling "Next keyboard" assistant button
 * under the SAME window — a container-descendant-only walk provably misses
 * the sibling (see `collectKeyboardChrome`'s doc comment in
 * src/core/snapshot-chrome.ts, the source of truth this fixture's shape is
 * drawn from: "a SIBLING subtree holding the 'Next keyboard' and 'Dictate'
 * buttons — siblings of the container, so a container-descendant walk alone
 * provably misses them"). Neither entry is the container itself, so sharing
 * only these between a baseline and a later capture is the exact
 * keyboard-descendants-only regression shape.
 */
export function keyboardWindowNodes() {
  return [
    {
      ref: 'e-kb-window',
      index: 10,
      parentIndex: 0,
      type: 'Window',
      rect: { x: 0, y: 400, width: 390, height: 444 },
    },
    {
      ref: 'e-kb-container',
      index: 11,
      parentIndex: 10,
      type: 'Keyboard',
      rect: { x: 0, y: 500, width: 390, height: 300 },
    },
    {
      ref: 'e-kb-key-a',
      index: 12,
      parentIndex: 11, // descendant of the container
      type: 'Key',
      label: 'A',
      rect: { x: 10, y: 520, width: 30, height: 40 },
    },
    {
      ref: 'e-kb-next',
      index: 13,
      parentIndex: 10, // sibling of the container, NOT a descendant
      type: 'Button',
      label: 'Next keyboard',
      rect: { x: 340, y: 520, width: 40, height: 40 },
    },
  ];
}

export function makeSession(platform: 'ios' | 'android' = 'ios'): SessionState {
  return {
    name: platform,
    device: platform === 'android' ? ANDROID_EMULATOR : IOS_SIMULATOR,
    createdAt: Date.now(),
    actions: [],
  };
}
