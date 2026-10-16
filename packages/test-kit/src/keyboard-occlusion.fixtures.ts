import { makeSnapshotState } from '@agent-device/capture-kit/snapshot-state-fixtures';
import type { Rect, SnapshotState } from '@agent-device/kernel/snapshot';

/** The #2589 capture's app-owned tab bar, and the band the captured keyboard docks to. */
export const KEYBOARD_COVERED_TAB_BAR_RECT: Rect = { x: 148, y: 791, width: 104, height: 83 };
export const KEYBOARD_COVERED_BAND_RECT: Rect = { x: 0, y: 583, width: 402, height: 291 };

/**
 * The captured #2589 screen: a docked iPhone keyboard whose band owns the app's tab bar.
 *
 * The keyboard is its own system surface, so it is never a covering sibling of app content here
 * (`occlusion` stays silent) and the tab bar is still inside the app's own window rect
 * (`offscreen` passes) — the tap used to report success while the key ate the touch. The key rects
 * are the bottom row measured on iPhone 17 Pro (26.2): a keyboard the rule will measure has to
 * report one unbroken run of columns, so a reduced layout cannot stop at two keys.
 *
 * The variants keep every keyboard-occlusion suite on this one geometry:
 * - `targetRect` moves the app-owned button, so "clear of the keyboard" is the same tree.
 * - `keyboardLifted` hauls the keys above the docking budget, which stops the tree-derived rule
 *   measuring at all — the way to prove a refusal came from the producer's band, not the tree.
 */
export function keyboardCoveredTabBarSnapshot(
  params: { targetRect?: Rect; keyboardLifted?: boolean } = {},
): SnapshotState {
  const nodes = keyboardCoveredTabBarTree().nodes.map((node) => {
    if (node.index === 1 && params.targetRect) return { ...node, rect: params.targetRect };
    if (!params.keyboardLifted) return node;
    return node.rect && (node.type === 'Keyboard' || node.type === 'Key')
      ? { ...node, rect: { ...node.rect, y: node.rect.y - 560 } }
      : node;
  });
  return { ...keyboardCoveredTabBarTree(), nodes };
}

function keyboardCoveredTabBarTree(): SnapshotState {
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
      rect: KEYBOARD_COVERED_TAB_BAR_RECT,
      hittable: true,
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Keyboard',
      rect: KEYBOARD_COVERED_BAND_RECT,
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
