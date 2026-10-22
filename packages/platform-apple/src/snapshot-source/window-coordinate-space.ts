import type { Rect } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';

/**
 * Which coordinate space one captured window's own box declares — the geometry a snapshot decoder
 * has to settle before it can publish any rect under that window, including the keyboard geometry
 * `tap-keyboard-occlusion.ts` measures.
 *
 * iOS hosts some system surfaces in the device's native (portrait-up) space even while the app is
 * rotated, so their whole subtree arrives quarter-turned. Measured on iPhone 17 Pro (iOS 26.2) with
 * the system keyboard up over a landscape app frame `(0,0,874,402)`, `UIRemoteKeyboardWindow` reports
 * its own box as `(0,0,402,874)` — the app's box with the two side lengths swapped — while the app's
 * own `UIWindow`, `UITextEffectsWindow` and a dev-menu overlay window all report `(0,0,874,402)`. In
 * portrait that same keyboard window reports `(0,0,402,874)` against a `(0,0,402,874)` app frame: the
 * two spaces coincide and nothing is turned. Rules that read the reported numbers refused app content
 * the keyboard was nowhere near and let a tap through into a key (#2612).
 *
 * A window that does not fill the screen — iPad Windowed Apps or Stage Manager — declares the other
 * space. Measured on iPad Pro 11-inch (M5, iOS 27.0) with a Calendar window whose screen box is
 * `(224,207,386,682)`, the window itself reports that screen box while the subtree under it arrives
 * anchored at its own top-left: the application root reads `(0,0,386,682)` and its `Add` button
 * `(335,14,37,36)` — the button's screen position `(559,221)` minus the window origin. Published as
 * reported, that tree mixes two spaces, clips its own content, and moves every tap by the window
 * origin (#3899). `windowContentTranslation` names the one vector that puts the subtree back.
 *
 * A rule that reads a box reads what the box can say. The quarter turn is a statement about which
 * axis a box runs along, so it compares side lengths and nothing else. A content translation is a
 * statement about where a subtree starts, so it reads all four numbers of the carrier's box against
 * the viewport box the platform reported: the carrier must be the app's own window — a `(0,0)`-anchored
 * copy of the viewport's side lengths — and the viewport must start somewhere else on the screen.
 * A full-screen window, an iPhone, and each foldable panel report origins at zero on both sides, so
 * the rule reads no translation there and every published rect stays as the platform reported it.
 *
 * The same rules are enforced in Swift for the capture that produces these trees, and one table
 * proves they are one rule: `contracts/fixtures/window-coordinate-space.json` is replayed here and
 * against `SnapshotGeometrySpace` and `SnapshotContentTranslation` in
 * `apple/snapshot-presentation/Sources/AgentDeviceSnapshotPresentation/SnapshotCoordinateSpace.swift`. The table also
 * pins the way back (`CoordinateSpaceRotation.oriented(rect:in:interfaceOrientation:)`, Swift-only
 * today); change any rule only through that table.
 *
 * Why this is a detector and not a repair: the bridge guest cannot read the app's interface
 * orientation. Measured in the #2659 spike (verdict on the issue, write-up in the diff of #2667):
 * AX attribute `XC_kAXXCAttributeApplicationOrientation` (id 1503) resolves but reads 0 through the
 * guest's snapshot channel, and the cheap BackBoard read is device orientation, which turns a
 * rotation-locked app's screen that never turned. The bar for retiring this file is a guest read
 * that names the foreground app's orientation and survives a rotation-locked app; attribute 1503 is
 * the handle to watch.
 */

/**
 * How far a window's side lengths may miss the app's swapped side lengths, and how far an app frame's
 * two sides may miss each other before it counts as square. Measured captures match the swap to the
 * point; this absorbs float representation only, which is why a box off by half a point is still the
 * app's box turned and a box off by two points is some other box.
 */
export const WINDOW_QUARTER_TURN_TOLERANCE = 1;

/**
 * Whether this window reports its subtree in the device's native space rather than in the app's.
 *
 * False on anything the rule cannot read a space from: a frame that is not finite, positive and
 * non-empty on either side — geometry the capture cannot place is not a claim about where it is — and
 * an app frame square to within the tolerance, whose own quarter turn is indistinguishable from it.
 */
export function isQuarterTurnedWindowFrame(windowFrame: Rect, appFrame: Rect): boolean {
  if (!isPositiveFiniteRect(windowFrame) || !isPositiveFiniteRect(appFrame)) return false;
  if (Math.abs(appFrame.width - appFrame.height) <= WINDOW_QUARTER_TURN_TOLERANCE) return false;
  return (
    Math.abs(windowFrame.width - appFrame.height) <= WINDOW_QUARTER_TURN_TOLERANCE &&
    Math.abs(windowFrame.height - appFrame.width) <= WINDOW_QUARTER_TURN_TOLERANCE
  );
}

/** The vector that carries a window-relative subtree into the screen space the viewport names. */
export type WindowContentTranslation = {
  offsetX: number;
  offsetY: number;
};

/**
 * The vector from a carrier's own box to the screen space it is placed at, or null when the carrier's
 * box declares no translation. The carrier's subtree was reported in the carrier's content space, so
 * adding the vector to each reported rect publishes the subtree in the viewport's screen space (#3899).
 *
 * Null on anything that is not the app's own placed window: a box that is not a `(0,0)`-anchored copy
 * of the viewport's side lengths names no space, and a viewport that already starts at the screen
 * origin needs no move. Replayed against `windowContentCases` in
 * `contracts/fixtures/window-coordinate-space.json`, in the Swift twin and here.
 */
export function windowContentTranslation(
  reportedBox: Rect,
  viewportBox: Rect,
): WindowContentTranslation | null {
  if (!isPositiveFiniteRect(reportedBox) || !isPositiveFiniteRect(viewportBox)) return null;
  if (
    Math.abs(reportedBox.x) > WINDOW_QUARTER_TURN_TOLERANCE ||
    Math.abs(reportedBox.y) > WINDOW_QUARTER_TURN_TOLERANCE
  ) {
    return null;
  }
  if (
    Math.abs(viewportBox.x) <= WINDOW_QUARTER_TURN_TOLERANCE &&
    Math.abs(viewportBox.y) <= WINDOW_QUARTER_TURN_TOLERANCE
  ) {
    return null;
  }
  if (
    Math.abs(reportedBox.width - viewportBox.width) > WINDOW_QUARTER_TURN_TOLERANCE ||
    Math.abs(reportedBox.height - viewportBox.height) > WINDOW_QUARTER_TURN_TOLERANCE
  ) {
    return null;
  }
  return { offsetX: viewportBox.x, offsetY: viewportBox.y };
}
