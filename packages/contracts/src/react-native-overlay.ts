import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';

export type ReactNativeOverlayNode = Pick<
  RawSnapshotNode,
  'index' | 'type' | 'role' | 'subrole' | 'label' | 'value' | 'identifier' | 'rect' | 'hittable'
>;

/**
 * The box a banner rect is measured in: the capture's published viewport, or the full-screen
 * container a banner sits inside. Absent means the reader holds no box, so a placement rule cannot
 * run.
 *
 * `rectUnitsPerDp` says how many of the box's rect units make one density-independent pixel: 1 for a
 * tree published in points (Apple), the display's density for one published in physical pixels
 * (Android). Absent means 1, so a capture whose rects are already layout units needs no extra fact;
 * a producer that publishes a bigger number is the only one that can shift a dp-written constant.
 */
export type ReactNativeOverlaySurface = Readonly<{
  width: number;
  height: number;
  rectUnitsPerDp?: number;
}>;

/** The capture facts a placement rule measures against: the published box and the units it carries. */
export type ReactNativeOverlayCaptureSurface = Readonly<{
  viewport?: Readonly<{ width: number; height: number }>;
  rectUnitsPerDp?: number;
}>;

/**
 * The surface a capture offers a placement rule, or nothing when it published no box. Callers hand
 * over the state they already hold, so the box and the units it is measured in travel together.
 */
export function reactNativeOverlaySurfaceFromCapture(
  capture: ReactNativeOverlayCaptureSurface,
): ReactNativeOverlaySurface | undefined {
  if (!capture.viewport) return undefined;
  return {
    width: capture.viewport.width,
    height: capture.viewport.height,
    ...(capture.rectUnitsPerDp === undefined ? {} : { rectUnitsPerDp: capture.rectUnitsPerDp }),
  };
}

/** App text such as "Error: invalid email" also starts this way, so it is not overlay evidence alone. */
const GENERIC_SEVERITY_PREFIX_PATTERN = /^(warn|warning|error):\s+/;
/**
 * From two entries up, LogBox's badge renders the entry count instead of `!`
 * (`LogBoxNotificationCountBadge`), and both platforms join the badge text with the message after
 * `", "`, so a count banner reads `"20, Failed to fetch"`. Ordinary app rows open the same way, so
 * the shape arms only on LogBox's own banner placement — see
 * {@link isReactNativeCollapsedWarningCountBadgeBanner}.
 */
const COLLAPSED_COUNT_BADGE_PREFIX_PATTERN = /^(?:[2-9]|[1-9][0-9]+),\s+\S/;
const COLLAPSED_WARNING_PREFIX_PATTERNS = [
  /^!,\s+/,
  GENERIC_SEVERITY_PREFIX_PATTERN,
  /\b(?:possible\s+)?unhandled (?:promise )?rejection\b/,
] as const;
/**
 * LogBox pins its banner stack with `left: 10; right: 10; bottom: 20` inside its own
 * `LogBoxNotificationContainer`, and the notification row is 48 high. Those are dp constants, so the
 * side gap reads as 10 rect units only where a unit is a dp; on a device-pixel capture it reads as
 * 10 times the display's density. A banner's two side gaps are its own width, so they match each
 * other; an inset app card sits further in, and a flush row — a tab bar, a footer, a bottom sheet —
 * sits at 0 and is app chrome however it opens. The tolerance absorbs sub-pixel rounding in the tree.
 */
const COLLAPSED_BANNER_SIDE_INSET_DP = 10;
const COLLAPSED_BANNER_SIDE_INSET_TOLERANCE = 1;
/** LogBox anchors the stack 20 dp above the bottom edge, and the row is 48 dp, in any unit scale. */
const COLLAPSED_BANNER_BOTTOM_FLOAT_MIN_DP = 12;
const COLLAPSED_BANNER_BOTTOM_FLOAT_MAX_DP = 160;
const COLLAPSED_WARNING_TEXT_MARKERS = [
  'open debugger to view warnings',
  'getsnapshot should be cached to avoid an infinite loop',
  'unique "key" prop',
  "unique 'key' prop",
  'virtualizedlists should never be nested',
  'failed prop type',
] as const;

export function isReactNativeCollapsedWarningWrapperCandidate(
  node: ReactNativeOverlayNode,
): boolean {
  const label = node.label?.trim();
  return (
    (isReactNativeCollapsedWarningLabel(label) ||
      isReactNativeCollapsedWarningCountBadgeLabel(label)) &&
    isFullScreenOverlayRect(node.rect)
  );
}

export function isReactNativeCollapsedWarningWrapperWithVisibleBanner(
  node: ReactNativeOverlayNode,
  descendants: ReactNativeOverlayNode[],
): boolean {
  const nodeLabel = node.label?.trim();
  if (!nodeLabel || !isReactNativeCollapsedWarningWrapperCandidate(node)) return false;
  const surface = reactNativeOverlaySurfaceFrom(node.rect);
  return descendants.some(
    (descendant) =>
      descendant.label?.trim() === nodeLabel &&
      isReactNativeCollapsedWarningBannerNode(descendant, surface),
  );
}

export function isReactNativeCollapsedWarningLabel(rawLabel: string | undefined): boolean {
  const label = rawLabel?.trim().toLowerCase();
  if (!label) return false;
  return (
    COLLAPSED_WARNING_TEXT_MARKERS.some((marker) => label.includes(marker)) ||
    COLLAPSED_WARNING_PREFIX_PATTERNS.some((pattern) => pattern.test(label))
  );
}

/**
 * A collapsed-warning label that names React Native by itself: every collapsed match except one
 * that only carries the generic `warn:`/`warning:`/`error:` prefix.
 */
export function isReactNativeCollapsedWarningEvidenceLabel(rawLabel: string | undefined): boolean {
  const label = rawLabel?.trim().toLowerCase();
  if (!label || !isReactNativeCollapsedWarningLabel(label)) return false;
  return (
    COLLAPSED_WARNING_TEXT_MARKERS.some((marker) => label.includes(marker)) ||
    COLLAPSED_WARNING_PREFIX_PATTERNS.some(
      (pattern) => pattern !== GENERIC_SEVERITY_PREFIX_PATTERN && pattern.test(label),
    )
  );
}

/** The `<count>, <message>` shape a collapsed banner carries from two entries up. */
function isReactNativeCollapsedWarningCountBadgeLabel(rawLabel: string | undefined): boolean {
  const label = rawLabel?.trim().toLowerCase();
  if (!label) return false;
  return COLLAPSED_COUNT_BADGE_PREFIX_PATTERN.test(label);
}

/**
 * A banner whose label carries the entry-count badge, proven by LogBox's own placement: it floats
 * just inside the surface's sides and just above its bottom edge. Without a box to measure against,
 * the placement cannot be read, so the answer is no.
 */
export function isReactNativeCollapsedWarningCountBadgeBanner(
  node: ReactNativeOverlayNode,
  surface: ReactNativeOverlaySurface | undefined,
): boolean {
  if (!isReactNativeCollapsedWarningCountBadgeLabel(node.label)) return false;
  if (!node.rect || !isReactNativeCollapsedWarningBanner(node)) return false;
  return isCollapsedBannerAtLogBoxPlacement(node.rect, surface);
}

/** A banner-sized node that either names itself as a collapsed warning or places like one. */
function isReactNativeCollapsedWarningBannerNode(
  node: ReactNativeOverlayNode,
  surface: ReactNativeOverlaySurface | undefined,
): boolean {
  if (!node.rect || !isReactNativeCollapsedWarningBanner(node)) return false;
  return (
    isReactNativeCollapsedWarningLabel(node.label?.trim()) ||
    isReactNativeCollapsedWarningCountBadgeBanner(node, surface)
  );
}

function reactNativeOverlaySurfaceFrom(
  rect: Rect | undefined,
): ReactNativeOverlaySurface | undefined {
  if (!rect) return undefined;
  return { width: rect.width, height: rect.height };
}

export function isReactNativeOverlayDismissLabel(label: string): boolean {
  return /^dismiss(?:\s*\([^)]*\))?$/i.test(label);
}

export function isReactNativeOverlayMinimizeLabel(label: string): boolean {
  return /^minimi[sz]e(?:\b|\s|\()/i.test(label);
}

export function isReactNativeCollapsedWarningBanner(node: ReactNativeOverlayNode): boolean {
  if (!node.rect) return false;
  return node.rect.width >= 120 && node.rect.height >= 36 && node.rect.height <= 180;
}

function isCollapsedBannerAtLogBoxPlacement(
  rect: Rect,
  surface: ReactNativeOverlaySurface | undefined,
): boolean {
  if (!surface) return false;
  const { width, height } = surface;
  if (!(width > 0) || !(height > 0)) return false;
  const unitsPerDp = surface.rectUnitsPerDp ?? 1;
  const sideInset = COLLAPSED_BANNER_SIDE_INSET_DP * unitsPerDp;
  const leftInset = rect.x;
  const rightInset = width - (rect.x + rect.width);
  const bottomFloat = (height - (rect.y + rect.height)) / unitsPerDp;
  return (
    isCloseTo(leftInset, sideInset) &&
    isCloseTo(rightInset, sideInset) &&
    bottomFloat >= COLLAPSED_BANNER_BOTTOM_FLOAT_MIN_DP &&
    bottomFloat <= COLLAPSED_BANNER_BOTTOM_FLOAT_MAX_DP
  );
}

/** True when a measured gap is the one LogBox renders, allow for sub-pixel rounding in the tree. */
function isCloseTo(measured: number, expected: number): boolean {
  return Math.abs(measured - expected) <= COLLAPSED_BANNER_SIDE_INSET_TOLERANCE;
}

export function isFullScreenOverlayRect(rect: RawSnapshotNode['rect']): boolean {
  if (!rect) return false;
  return rect.x <= 1 && rect.y <= 1 && rect.width >= 300 && rect.height >= 600;
}
