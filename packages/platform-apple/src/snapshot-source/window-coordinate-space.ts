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
 * The box is the only evidence, so the rule reads side lengths and nothing else. Origins are not
 * compared: a quarter turn says which axis a box runs along, not where it sits, and a window may
 * legitimately be placed elsewhere. A square app frame cannot be told from its own quarter turn, so it
 * is left alone rather than guessed at — rotating geometry that did not need it is the worse failure.
 *
 * The same rule is enforced in Swift for the capture that produces these trees, and one table proves
 * they are one rule: `contracts/fixtures/window-coordinate-space.json` is replayed here and against
 * `SnapshotGeometrySpace` in
 * `apple/snapshot-presentation/Sources/AgentDeviceSnapshotPresentation/SnapshotCoordinateSpace.swift`. The table also
 * pins the way back (`CoordinateSpaceRotation.oriented(rect:in:interfaceOrientation:)`, Swift-only
 * today); change either rule only through that table.
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
