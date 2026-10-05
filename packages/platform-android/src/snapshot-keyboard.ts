import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { Rect, SnapshotKeyboardBandFact } from '@agent-device/kernel/snapshot';
import type { AndroidSnapshotBackendMetadata } from './snapshot-types.ts';
import type { AndroidUiHierarchy } from './ui-hierarchy-node.ts';

/** `AccessibilityWindowInfo.TYPE_INPUT_METHOD`. */
const ANDROID_WINDOW_TYPE_INPUT_METHOD = 2;

/**
 * The keyboard band an Android capture measured, read from the window roots the helper already
 * captured: each root carries its `AccessibilityWindowInfo` type and screen bounds, so this costs no
 * adb call. Bounds are screen pixels, the same space as every node rect.
 *
 * An input method that draws nothing (agent-device's test IME) puts no window on screen and reads as
 * `absent`. Only a capture that listed every window can prove absence: the active-window fallback
 * never saw the window list, a root without window metadata cannot be ruled out as the input method,
 * and a truncated capture may have stopped before it.
 */
export function androidSnapshotKeyboardFromTree(
  tree: AndroidUiHierarchy,
  metadata: Pick<AndroidSnapshotBackendMetadata, 'captureMode' | 'helperTruncated'>,
): SnapshotKeyboardBandFact {
  const windows = tree.children;
  const inputMethodRects = windows
    .filter((window) => window.windowType === ANDROID_WINDOW_TYPE_INPUT_METHOD)
    .map((window) => window.windowRect)
    .filter(isPositiveFiniteRect);
  if (inputMethodRects.length > 0) return { kind: 'visible', frame: unionRects(inputMethodRects) };
  if (
    metadata.captureMode !== 'interactive-windows' ||
    windows.some((window) => window.windowType === undefined)
  ) {
    return { kind: 'unmeasurable', reason: 'window-list-unavailable' };
  }
  if (metadata.helperTruncated === true) {
    return { kind: 'unmeasurable', reason: 'capture-truncated' };
  }
  return { kind: 'absent' };
}

function unionRects(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
