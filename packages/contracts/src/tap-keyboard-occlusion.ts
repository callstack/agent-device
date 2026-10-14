import type {
  Point,
  RawSnapshotNode,
  Rect,
  SnapshotKeyboardBandFact,
} from '@agent-device/kernel/snapshot';
import { containsPoint, isPositiveFiniteRect } from '@agent-device/kernel/rect';
import {
  IOS_KEYBOARD_SURFACE_ROLES,
  IOS_KEYBOARD_SETTLE_CHROME_ROLES,
  IOS_KEYBOARD_SUBTREE_CHROME_ROLES,
  IOS_KEYBOARD_CHROME_MARKER_ROLES,
  isAndroidInputMethodNode,
  hasIosKeyboardRole,
} from './android-input-ownership.ts';
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
 * A capture whose producer measured the band directly publishes a {@link SnapshotKeyboardBandFact}
 * beside its tree, and the guard measures the tap point against that band — a point-in-rect check
 * with no geometry to believe. The Apple runner does this from `app.keyboards.firstMatch`, which
 * answers in the app's own orientation space (#2660); the Android helper does it from the input
 * method window's screen bounds.
 *
 * Otherwise the band is derived from the captured tree every acting path already holds, so the guard
 * costs no round trip. This is the path for Android captures that could not list every window and for
 * the producers that never see the app's windows (`appium-source`, `limrun-ios-tree`, the runner's own query-sweep tier).
 * Derivation, the rules that decide whether reported geometry may be measured at all, and the verdict
 * on a point are proven against `contracts/fixtures/tap-keyboard-occlusion-policy.json`; change a rule
 * only through that table.
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
  /** An explicit observation established absence. */
  | { kind: 'no-keyboard' }
  /**
   * Keyboard visibility or its band cannot be established — no resolvable viewport, no usable keyboard
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
 * app content waiting behind it. The table is shared with the settle chrome classifier.
 */

/** Every node the keyboard owns, whether or not it contributes geometry to the band. */
function isKeyboardSurfaceNode(node: RawSnapshotNode): boolean {
  return isKeyboardAnchorNode(node) || IOS_KEYBOARD_SURFACE_ROLES.has(node.role ?? '');
}

/** Keyboard hosts that own descendants, until an app-fillable marker interrupts the ancestry. */
function isKeyboardSubtreeHost(node: RawSnapshotNode): boolean {
  return isKeyboardAnchorNode(node) || hasIosKeyboardRole(node, IOS_KEYBOARD_SUBTREE_CHROME_ROLES);
}

/** Per-node ownership and system-only ancestry never cross an app-fillable assistant marker. */
function isKeyboardOwnedNode(
  node: RawSnapshotNode,
  byIndex: ReadonlyMap<number, RawSnapshotNode>,
): boolean {
  if (
    isKeyboardSurfaceNode(node) ||
    hasIosKeyboardRole(node, IOS_KEYBOARD_SETTLE_CHROME_ROLES) ||
    hasIosKeyboardRole(node, IOS_KEYBOARD_CHROME_MARKER_ROLES) ||
    isKeyboardSubtreeHost(node)
  )
    return true;
  const visited = new Set<number>();
  let parentIndex = node.parentIndex;
  while (typeof parentIndex === 'number' && !visited.has(parentIndex)) {
    visited.add(parentIndex);
    const parent = byIndex.get(parentIndex);
    if (!parent) return false;
    if (hasIosKeyboardRole(parent, IOS_KEYBOARD_CHROME_MARKER_ROLES)) return false;
    if (isKeyboardSubtreeHost(parent)) return true;
    parentIndex = parent.parentIndex;
  }
  return false;
}

/** The band needs an edge to run to, which an absent or zero-area viewport does not report. */
function isMeasurableViewport(viewport: Rect | null): viewport is Rect {
  return viewport !== null && isPositiveFiniteRect(viewport);
}

/** Zero-area placeholders (iOS reports `Padding-Left` keys this way) are not geometry. */
function usableRects(nodes: readonly RawSnapshotNode[]): Rect[] {
  return nodes.flatMap((node) => (isPositiveFiniteRect(node.rect) ? [node.rect] : []));
}

/**
 * The surface indices that have a keyboard node of their own below them — the plane containers. Each
 * surface climbs the projection's parent links, so a projection that flattens keys beside app chrome
 * leaves each key a leaf.
 */
function collectKeyboardPlaneIndices(
  nodes: readonly RawSnapshotNode[],
  surfaces: readonly RawSnapshotNode[],
): Set<number> {
  const parents = new Map(nodes.map((node) => [node.index, node.parentIndex] as const));
  const surfaceIndices = new Set(surfaces.map((node) => node.index));
  const planes = new Set<number>();
  for (const surface of surfaces) {
    for (const ancestor of collectAncestorSurfaceIndices(parents, surfaceIndices, surface.index)) {
      planes.add(ancestor);
    }
  }
  return planes;
}

/** The keyboard nodes above `index`, each visited once however the projection loops its ancestry. */
function collectAncestorSurfaceIndices(
  parents: ReadonlyMap<number, number | undefined>,
  surfaceIndices: ReadonlySet<number>,
  index: number,
): number[] {
  const ancestors: number[] = [];
  const visited = new Set<number>();
  let parent = parents.get(index);
  while (typeof parent === 'number' && !visited.has(parent)) {
    visited.add(parent);
    if (surfaceIndices.has(parent)) ancestors.push(parent);
    parent = parents.get(parent);
  }
  return ancestors;
}

/**
 * How far the keyboard's own reported geometry may stop short of the viewport's bottom edge and still
 * own the band down to it. A docked software keyboard is flush with the bottom of the screen, but the
 * projection stops reporting it above the home-indicator strip: measured on iPhone 17 Pro (iOS 26.2),
 * the reported key plane bottoms out at 816 of an 874 pt portrait viewport, 58 pt short, and at 402 of
 * a 402 pt landscape viewport, exactly on the edge. A surface stopping further up than this budget is
 * not docked — an iPad floating or split keyboard, or an app-drawn keypad — and its geometry says
 * nothing about the bottom of the screen. The budget counts in the units the rects arrive in, and that
 * is what Android asks for rather than what a dp table would: with three-button navigation on Pixel 7
 * (Android 16, 1080x2400 at 420 dpi), Gboard's reported region runs to the physical display bottom at
 * 2400 and the 126 px navigation bar sits inside it at 2274..2400, so the bar costs the band nothing.
 * An IME that did stop above its own bar would simply stop being measured, the way every other
 * unmeasurable geometry fails open. Height is no proxy for docking: the same keyboard measures
 * 233 pt against an 874 pt viewport in portrait and 327 pt against a 402 pt one in landscape, so the
 * fraction that admits the first is the fraction that refuses to look at the second.
 */
const KEYBOARD_BOTTOM_ANCHOR_TOLERANCE = 80;

/**
 * How far two reported keys may sit apart and still be one keyboard's worth of columns. Reported seams
 * are zero on measured trees — iPhone 17 Pro (26.2) keys adjoin across 395 pt, iPad Pro 11-inch (M4)
 * across 743.5 pt, and Gboard's across 1070 px, none with a gap above a point — so this absorbs
 * projection rounding, not layout.
 */
const KEYBOARD_KEY_SEAM_ALLOWANCE = 2;

/**
 * Whether these rects tile a width instead of claiming one. A split iPad keyboard docks its two
 * clusters at the bottom edge while its surface container still spans the whole screen, so the docking
 * and width rules above both pass and the band would run across the middle of the screen, where the
 * app content between the clusters is visible and tappable. Only the keys report where the keyboard's
 * controls are, and a gap that wide is not a reporting seam. Nothing in the tree says where either
 * cluster ends, so a gap cannot be measured around: the band stays unmeasured and the tap fails open,
 * the way it does for geometry that arrived rotated.
 */
function tilesMeasuredWidth(rects: readonly Rect[]): boolean {
  const columns = rects
    .map((rect) => [rect.x, rect.x + rect.width] as const)
    .sort((left, right) => left[0] - right[0]);
  let reach = columns[0]?.[1] ?? 0;
  for (const [start, end] of columns) {
    if (start - reach > KEYBOARD_KEY_SEAM_ALLOWANCE) return false;
    reach = Math.max(reach, end);
  }
  return true;
}

/**
 * The band a docked keyboard owns: its own columns, from its topmost reported node down to the bottom
 * of the viewport. Null when the reported geometry is not a keyboard a band can be measured from.
 */
function measureDockedKeyboardFrame(params: {
  anchorRects: readonly Rect[];
  reportedBottom: number;
  viewport: Rect;
}): Rect | null {
  const minY = Math.min(...params.anchorRects.map((rect) => rect.y));
  const minX = Math.min(...params.anchorRects.map((rect) => rect.x));
  const maxRight = Math.max(...params.anchorRects.map((rect) => rect.x + rect.width));
  const bottomEdge = params.viewport.y + params.viewport.height;
  // The keyboard's own geometry stops above the edge the band would run to: not docked.
  if (params.reportedBottom < bottomEdge - KEYBOARD_BOTTOM_ANCHOR_TOLERANCE) return null;
  // A band taller than it is wide did not come from a producer that normalized it. iOS hosts some
  // system surfaces in the device's native (portrait-up) space while the app is rotated, so their
  // rects arrive quarter-turned, and only a producer that can name the app's interface orientation
  // can turn them back: the runner's tree tiers publish the app's own space through
  // `SnapshotGeometrySpace`, and the Simulator AX bridge refuses the capture so the runner answers it
  // (ADR 0004). A capture from either of those now answers this question from its own measured band
  // and never reaches here (#2660), so what still does is a capture that declares no space at all:
  // the runner's query-sweep tier, whose flat query has no window ancestry to read one from, and the
  // `appium-source` and `limrun-ios-tree` producers. Unnormalized landscape geometry measured on
  // iPhone 17 Pro reports a 162 x 327 key plane and a dock button at y 8 of a 402 pt viewport while
  // the screenshot shows the keyboard full width across the bottom 327 pt. A band from that would
  // refuse app content the keyboard is nowhere near while missing the keyboard itself, which is
  // worse than not measuring — see the landscape cases in the golden table.
  if (maxRight - minX <= params.reportedBottom - minY) return null;
  return { x: minX, y: minY, width: maxRight - minX, height: bottomEdge - minY };
}

/**
 * Whether the keys form one unbroken run of columns across the width the anchors claim. The container
 * says where the platform thinks the keyboard is; only the keys say where its controls are, so this
 * reads keys and falls back to every anchor when the projection nests nothing.
 *
 * Blunt both ways on purpose, and both costs are table rows: a sparse layout — the iOS emoji panel,
 * corner keys over a wide container — does not tile, so the guard abstains rather than decide which
 * gaps are app content; and a container reported with no keys has nothing left to check, so the band is
 * the container's own claim.
 */
function keysFormOneColumnRun(params: {
  anchorNodes: readonly RawSnapshotNode[];
  anchorRects: readonly Rect[];
  planeIndices: ReadonlySet<number>;
}): boolean {
  const keyRects = usableRects(
    params.anchorNodes.filter((node) => !params.planeIndices.has(node.index)),
  );
  return tilesMeasuredWidth(keyRects.length > 0 ? keyRects : params.anchorRects);
}

/** The keyboard's own controls as the tree reports them, without deciding where its band is. */
function collectKeyboardControlRects(nodes: readonly RawSnapshotNode[]): Rect[] {
  const surfaceNodes = nodes.filter(
    (node) =>
      isKeyboardSurfaceNode(node) ||
      (node.keyboardOwned === true &&
        [node.type, node.role].some((value) => normalizeType(value ?? '') === 'button')),
  );
  const planeIndices = collectKeyboardPlaneIndices(nodes, surfaceNodes);
  return usableRects(surfaceNodes.filter((node) => !planeIndices.has(node.index)));
}

/** The band the keyboard reports, or null when the tree holds no keyboard or the band cannot be
 * measured. Fails open on an unusable frame, mirroring `clipScrollViewportAboveKeyboard`: a keyboard
 * the platform cannot measure is not evidence that a surface is blocked. */
function deriveDockedKeyboardFrame(
  nodes: readonly RawSnapshotNode[],
  viewport: Rect | null,
): Rect | null {
  const anchorNodes = nodes.filter(isKeyboardAnchorNode);
  const anchorRects = usableRects(anchorNodes);
  if (anchorRects.length === 0) return null;
  if (!isMeasurableViewport(viewport)) return null;
  const surfaceNodes = nodes.filter(isKeyboardSurfaceNode);
  const reportedRects = usableRects(surfaceNodes);
  if (reportedRects.length === 0) return null;
  const frame = measureDockedKeyboardFrame({
    anchorRects,
    reportedBottom: Math.max(...reportedRects.map((rect) => rect.y + rect.height)),
    viewport,
  });
  if (!frame || !isPositiveFiniteRect(frame)) return null;
  const planeIndices = collectKeyboardPlaneIndices(nodes, surfaceNodes);
  if (!keysFormOneColumnRun({ anchorNodes, anchorRects, planeIndices })) return null;
  return frame;
}

type ProviderKeyboardInput = {
  nodes: readonly RawSnapshotNode[];
  viewport: Rect | null;
  visibility?: boolean | 'unsupported' | 'failed';
};

/** Preserves keyboard geometry and evaluated node ownership before snapshot projection. */
export function acquireProviderKeyboard(params: ProviderKeyboardInput): {
  nodes: RawSnapshotNode[];
  keyboard: SnapshotKeyboardBandFact;
} {
  const byIndex = new Map(params.nodes.map((node) => [node.index, node] as const));
  return {
    nodes: params.nodes.map((node) => ({
      ...node,
      keyboardOwned: isKeyboardOwnedNode(node, byIndex),
    })),
    keyboard: observeProviderKeyboard(params),
  };
}

function observeProviderKeyboard(params: ProviderKeyboardInput): SnapshotKeyboardBandFact {
  const frame = deriveDockedKeyboardFrame(params.nodes, params.viewport);
  if (frame) return { kind: 'derived', derivation: 'docked-tree', frame };
  if (isMeasurableViewport(params.viewport) && params.nodes.some(isKeyboardAnchorNode)) {
    return {
      kind: 'tree-rejected',
      derivation: 'docked-tree',
      ...(typeof params.visibility === 'boolean' ? { visible: params.visibility } : {}),
    };
  }
  if (typeof params.visibility === 'boolean') {
    return { kind: 'visibility-only', visible: params.visibility };
  }
  return {
    kind: 'unmeasurable',
    reason: params.nodes.some(isKeyboardAnchorNode)
      ? 'keyboard-viewport-unavailable'
      : params.visibility === 'failed'
        ? 'keyboard-visibility-probe-failed'
        : params.visibility === 'unsupported'
          ? 'keyboard-visibility-probe-unsupported'
          : 'keyboard-not-observed',
  };
}

/**
 * Whether this tap point belongs to the visible keyboard rather than to app content behind it.
 *
 * The point is the dispatched tap point the interaction resolved — the same point
 * `isTapPointInsideViewport` guards — so an element only partly under the keyboard whose tap point is
 * still above the key plane keeps tapping. Callers choose the consequence: an acting element path
 * refuses, while a coordinate path that never captured this tree discloses instead of refusing.
 *
 * A measured or acquisition-derived frame in `keyboard` survives projection. Measured frames need no
 * docking, column-run, or orientation inference; derived bands already passed those rules during
 * acquisition. Keyboard ownership on surviving nodes retains its acquisition witness after projection.
 * The keyboard's own controls still come from the
 * tree — which node the keyboard rather than the app is responsible for is a different question from
 * where the band is, and only the tree can answer it. Visibility-only observations are additive and never prevent
 * tree derivation. Only
 * `tree-rejected` records a failed full-tree evaluation with a usable viewport and prevents
 * reconstruction after projection. Other failed direct measurements may still use the tree;
 * missing nodes remain
 * undetermined.
 */
export function resolveKeyboardTapOcclusion(params: {
  nodes: readonly RawSnapshotNode[];
  viewport: Rect | null;
  point: Point;
  /** The resolved element, when the caller named one; absent for a bare coordinate. */
  node?: RawSnapshotNode | null;
  /** This capture's measured, acquisition-derived, visibility-only, or unknown keyboard evidence. */
  keyboard?: SnapshotKeyboardBandFact;
}): KeyboardTapOcclusion {
  if (params.keyboard?.kind === 'absent') return { kind: 'no-keyboard' };
  if (params.keyboard?.kind === 'tree-rejected') {
    return { kind: params.keyboard.visible === false ? 'no-keyboard' : 'undetermined' };
  }
  const frame =
    params.keyboard?.kind === 'visible' || params.keyboard?.kind === 'derived'
      ? params.keyboard.frame
      : deriveDockedKeyboardFrame(params.nodes, params.viewport);
  if (!frame) {
    return {
      kind:
        params.keyboard?.kind === 'visibility-only' && !params.keyboard.visible
          ? 'no-keyboard'
          : 'undetermined',
    };
  }
  const surface = { frame, controlRects: collectKeyboardControlRects(params.nodes) };
  if (!params.node) return classifyKeyboardPoint(params.point, surface);
  // A resolved element is excused only by belonging to the keyboard, never by sitting under a key:
  // the caller named the element, and behind the keyboard a tap does not reach it.
  const keyboardOwned =
    params.node.keyboardOwned ??
    isKeyboardOwnedNode(params.node, new Map(params.nodes.map((node) => [node.index, node])));
  if (keyboardOwned) {
    return { kind: 'clear', surface };
  }
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
