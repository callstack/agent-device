import type { Point, RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { containsPoint, isPositiveFiniteRect } from '@agent-device/kernel/rect';
import { isAndroidInputMethodNode } from './android-input-ownership.ts';
import { normalizeType } from './snapshot-text.ts';

/**
 * Keyboard occlusion on the tap paths — the interaction twin of the scroll policy in
 * `scroll-gesture.ts`.
 *
 * A software keyboard is its own system surface, so it never appears as a covering sibling of app
 * content: the same-window occlusion classifier (ADR 0011 `occlusion`) cannot see it, and a covered
 * tab bar is still inside the app's own window rect, so the viewport rule (`offscreen`) passes it
 * too. The result was a silent misfire: pressing an element behind the keyboard reported success
 * while the touch activated a key (#2589).
 *
 * The band is derived from the captured tree every acting path already holds, so the guard costs no
 * round trip. Derivation and the center rule are proven against
 * `contracts/fixtures/tap-keyboard-occlusion-policy.json`; change the rule only through that table.
 */

/** The one reason a tap refuses because the visible keyboard owns its tap point. */
export const TAP_KEYBOARD_OCCLUDES_TARGET_REASON = 'tap_keyboard_occludes_target';

/**
 * The hint every owner publishes beside the reason, naming the recovery that actually works.
 * `keyboard dismiss` taps the keyboard's own dismiss control and refuses when it exposes none
 * (#1598/#1606), so an app control that ends editing, or `keyboard enter` when submitting is the
 * goal, come first. Nothing here dismisses the keyboard for the caller: dropping focus commits or
 * cancels edit state, which is the caller's decision rather than a side effect of a tap — the same
 * stance `scroll-gesture.ts` takes for the surface it refuses to swipe.
 *
 * The verdict is read from the tree the command measured against, and no owner re-probes the
 * keyboard to confirm it: `keyboard status`/`get` are Android-only, and #1542's double-check
 * confirms the target's own live rect, which a covering keyboard leaves intact. So the hint names
 * the re-measurement instead of pretending the refusal already has it.
 */
export const TAP_KEYBOARD_OCCLUDES_TARGET_DETAILS = Object.freeze({
  reason: TAP_KEYBOARD_OCCLUDES_TARGET_REASON,
  hint:
    'The visible keyboard covers this target, so the tap would land on a key instead of on it. ' +
    "End editing first: tap the app's own Done/Cancel/close control, or run `keyboard enter` when submitting is what you want " +
    '(`keyboard dismiss` works only when the keyboard exposes its own dismiss key). ' +
    'This reads the snapshot the command measured against, so if the keyboard closed since it was taken, ' +
    'run `snapshot -i` and retry.',
});

const IOS_KEYBOARD_TYPE_NAMES: ReadonlySet<string> = new Set(['keyboard', 'key']);

/** The occluding band of the visible keyboard, plus the rects that prove a tap meant the keyboard. */
export type KeyboardSurface = {
  /**
   * From the topmost keyboard node down to the bottom of the viewport, across the keyboard's own
   * columns. The keyboard is a bottom-anchored surface and the projected tree stops reporting it
   * below the key plane — the home-indicator strip has no node of its own — so ending the band at
   * the reported key rects would leave that strip, and anything parked in it, looking tappable.
   */
  frame: Rect;
  /**
   * The keyboard's own controls, as reported: a bare coordinate inside one of these is the keyboard
   * the caller asked for. Only controls that report no keyboard node of their own qualify — the plane
   * container spans every key on it, so counting it would excuse any point in the band and quietly
   * disarm the coordinate disclosure.
   */
  controlRects: readonly Rect[];
};

export type KeyboardTapOcclusion =
  /** No keyboard in the tree: nothing to refuse. */
  | { kind: 'no-keyboard' }
  /**
   * Keyboard nodes exist but the band cannot be measured — no resolvable viewport, no usable keyboard
   * rect, or geometry that is not docked to the bottom edge the band would need. Fails open like every
   * other missing platform fact; the distinction from `no-keyboard` exists so a caller can disclose
   * that it could not check rather than claiming the target was clear.
   */
  | { kind: 'undetermined' }
  | { kind: 'clear'; surface: KeyboardSurface }
  | { kind: 'occluded'; surface: KeyboardSurface };

/**
 * The band's sources: iOS reports the key plane as `Keyboard` and each key as `Key`; Android input
 * method nodes carry package provenance. Type and provenance only — never a label, which is
 * locale-dependent, and never a bare container by identifier, which an app could name the same way.
 */
function isKeyboardAnchorNode(node: RawSnapshotNode): boolean {
  return (
    IOS_KEYBOARD_TYPE_NAMES.has(normalizeType(node.type ?? '')) || isAndroidInputMethodNode(node)
  );
}

/**
 * iOS names the keyboard's own surface elements by accessibility role, and the interactive projection
 * flattens them beside app content, so ancestry cannot reach them. The dock strip is the clearest
 * case: its buttons sit below the reported keys, inside the band, and are the keyboard rather than
 * app content waiting behind it.
 */
const IOS_KEYBOARD_SURFACE_ROLES: ReadonlySet<string> = new Set([
  'UIKeyboardDockItemButton',
  'UIAccessibilityElementKBKey',
]);

/** Every node the keyboard owns, whether or not it contributes geometry to the band. */
function isKeyboardSurfaceNode(node: RawSnapshotNode): boolean {
  return isKeyboardAnchorNode(node) || IOS_KEYBOARD_SURFACE_ROLES.has(node.role ?? '');
}

/**
 * Whether this node belongs to the keyboard rather than to the app: a key, the key plane, an IME
 * node, or anything inside one of them. Ownership walks ancestors only, so a flattened projection
 * that lifts keys beside app chrome cannot promote app content into the keyboard.
 */
function isKeyboardOwnedNode(
  node: RawSnapshotNode,
  nodesByIndex: ReadonlyMap<number, RawSnapshotNode>,
): boolean {
  if (isKeyboardSurfaceNode(node)) return true;
  const visited = new Set<number>();
  let current =
    typeof node.parentIndex === 'number' ? nodesByIndex.get(node.parentIndex) : undefined;
  while (current && !visited.has(current.index)) {
    visited.add(current.index);
    if (isKeyboardSurfaceNode(current)) return true;
    current =
      typeof current.parentIndex === 'number' ? nodesByIndex.get(current.parentIndex) : undefined;
  }
  return false;
}

/** Zero-area placeholders (iOS reports `Padding-Left` keys this way) are not geometry. */
function usableRects(nodes: readonly RawSnapshotNode[]): Rect[] {
  return nodes.flatMap((node) => (isPositiveFiniteRect(node.rect) ? [node.rect] : []));
}

/**
 * The surface indices that have a keyboard node of their own below them — the plane containers. The
 * walk climbs from every surface node through its ancestors, so a projection that flattens keys
 * beside app chrome leaves each key a leaf.
 */
function collectKeyboardPlaneIndices(
  nodes: readonly RawSnapshotNode[],
  surfaces: readonly RawSnapshotNode[],
): Set<number> {
  const parentByIndex = new Map(nodes.map((node) => [node.index, node.parentIndex] as const));
  const surfaceIndices = new Set(surfaces.map((node) => node.index));
  const planes = new Set<number>();
  for (const surface of surfaces) {
    const visited = new Set<number>();
    let parent = parentByIndex.get(surface.index);
    while (typeof parent === 'number' && !visited.has(parent)) {
      visited.add(parent);
      if (surfaceIndices.has(parent)) planes.add(parent);
      parent = parentByIndex.get(parent);
    }
  }
  return planes;
}

/**
 * How far the keyboard's own reported geometry may stop short of the viewport's bottom edge and still
 * own the band down to it. A docked software keyboard is flush with the bottom of the screen, but the
 * projection stops reporting it above the home-indicator strip: measured on iPhone 17 Pro (iOS 26.2),
 * the reported key plane bottoms out at 816 of an 874 pt portrait viewport, 58 pt short, and at 402 of
 * a 402 pt landscape viewport, exactly on the edge. A surface stopping further up than this budget is
 * not docked — an iPad floating or split keyboard, or an app-drawn keypad — and its geometry says
 * nothing about the bottom of the screen. Height is no proxy for docking: the same keyboard measures
 * 233 pt against an 874 pt viewport in portrait and 327 pt against a 402 pt one in landscape, so the
 * fraction that admits the first is the fraction that refuses to look at the second.
 */
const KEYBOARD_BOTTOM_ANCHOR_TOLERANCE = 80;

/**
 * The band the visible keyboard owns, or null when the tree holds no keyboard or the band cannot be
 * measured. Fails open on an unusable frame, mirroring `clipScrollViewportAboveKeyboard`: a keyboard
 * the platform cannot measure is not evidence that a surface is blocked.
 */
function resolveVisibleKeyboardSurface(
  nodes: readonly RawSnapshotNode[],
  viewport: Rect | null,
): KeyboardSurface | null {
  const anchorRects = usableRects(nodes.filter(isKeyboardAnchorNode));
  if (anchorRects.length === 0) return null;
  const surfaceNodes = nodes.filter(isKeyboardSurfaceNode);
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return null;
  const reportedRects = usableRects(surfaceNodes);
  if (reportedRects.length === 0) return null;
  const minY = Math.min(...anchorRects.map((rect) => rect.y));
  const bottomEdge = viewport.y + viewport.height;
  const reportedBottom = Math.max(...reportedRects.map((rect) => rect.y + rect.height));
  if (reportedBottom < bottomEdge - KEYBOARD_BOTTOM_ANCHOR_TOLERANCE) return null;
  // Reported geometry that arrives taller than it is wide is not in the app's orientation space. iOS
  // gives up the landscape iPhone keyboard's rects in the keyboard's own rotated space: measured on
  // iPhone 17 Pro, its key plane is 162 x 327 and its dock button reports y 8 of a 402 pt viewport,
  // while the screenshot shows the keyboard full width across the bottom 327 pt. A band from that
  // would refuse app content the keyboard is nowhere near while missing the keyboard itself, which is
  // worse than not measuring — see the landscape cases in the golden table.
  const reportedLeft = Math.min(...reportedRects.map((rect) => rect.x));
  const reportedRight = Math.max(...reportedRects.map((rect) => rect.x + rect.width));
  if (reportedRight - reportedLeft <= reportedBottom - minY) return null;
  const minX = Math.min(...anchorRects.map((rect) => rect.x));
  const maxRight = Math.max(...anchorRects.map((rect) => rect.x + rect.width));
  const planes = collectKeyboardPlaneIndices(nodes, surfaceNodes);
  return {
    frame: { x: minX, y: minY, width: maxRight - minX, height: bottomEdge - minY },
    controlRects: usableRects(surfaceNodes.filter((node) => !planes.has(node.index))),
  };
}

/**
 * Whether this tap point belongs to the visible keyboard rather than to app content behind it.
 *
 * The point is the rect center an interaction would activate — the same point
 * `isTapPointInsideViewport` guards — so an element only partly under the keyboard whose center is
 * still above the key plane keeps tapping. Callers choose the consequence: an acting element path
 * refuses, while a coordinate path that never captured this tree discloses instead of refusing.
 */
export function resolveKeyboardTapOcclusion(params: {
  nodes: readonly RawSnapshotNode[];
  viewport: Rect | null;
  point: Point;
  /** The resolved element, when the caller named one; absent for a bare coordinate. */
  node?: RawSnapshotNode | null;
}): KeyboardTapOcclusion {
  const surface = resolveVisibleKeyboardSurface(params.nodes, params.viewport);
  if (!surface) {
    return params.nodes.some(isKeyboardAnchorNode)
      ? { kind: 'undetermined' }
      : { kind: 'no-keyboard' };
  }
  if (!params.node) return classifyKeyboardPoint(params.point, surface);
  // A resolved element is excused only by belonging to the keyboard, never by sitting under a key:
  // the caller named the element, and behind the keyboard a tap does not reach it.
  const nodesByIndex = new Map(params.nodes.map((node) => [node.index, node]));
  if (isKeyboardOwnedNode(params.node, nodesByIndex)) return { kind: 'clear', surface };
  return containsPoint(surface.frame, params.point.x, params.point.y)
    ? { kind: 'occluded', surface }
    : { kind: 'clear', surface };
}

/**
 * A bare coordinate carries no element identity, so the only intent evidence is where it lands: a
 * point on a reported keyboard control is the keyboard the caller asked for. An element whose
 * center lands on that same key is still refused — the asymmetry is the point.
 */
function classifyKeyboardPoint(point: Point, surface: KeyboardSurface): KeyboardTapOcclusion {
  const onKeyboardControl = surface.controlRects.some((rect) =>
    containsPoint(rect, point.x, point.y),
  );
  if (onKeyboardControl) return { kind: 'clear', surface };
  return containsPoint(surface.frame, point.x, point.y)
    ? { kind: 'occluded', surface }
    : { kind: 'clear', surface };
}
