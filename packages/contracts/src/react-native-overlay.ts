import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';

export type ReactNativeOverlayNode = Pick<
  RawSnapshotNode,
  'index' | 'type' | 'role' | 'subrole' | 'label' | 'value' | 'identifier' | 'rect' | 'hittable'
>;

/**
 * The box a banner rect is measured in: the capture's published viewport, or the full-screen
 * container a banner sits inside. Absent means the reader holds no box, so a placement rule cannot
 * run.
 */
export type ReactNativeOverlaySurface = Readonly<{ width: number; height: number }>;

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
/** LogBox insets the banner 10 units from each side, so it never spans the whole surface. */
const COLLAPSED_BANNER_MIN_WIDTH_SURFACE_RATIO = 0.8;
/** LogBox anchors the banner stack 20 units above the bottom edge; a safe area can sit between. */
const COLLAPSED_BANNER_MAX_BOTTOM_MARGIN = 160;
const COLLAPSED_BANNER_MAX_BOTTOM_MARGIN_SURFACE_RATIO = 0.15;
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
 * A banner whose label carries the entry-count badge, proven by LogBox's own placement: it spans
 * nearly the whole surface and hangs off its bottom edge. Without a box to measure against the
 * placement cannot be read, so the answer is no.
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
  const bottomMargin = height - (rect.y + rect.height);
  return (
    rect.width >= width * COLLAPSED_BANNER_MIN_WIDTH_SURFACE_RATIO &&
    bottomMargin >= 0 &&
    bottomMargin <=
      Math.max(
        COLLAPSED_BANNER_MAX_BOTTOM_MARGIN,
        height * COLLAPSED_BANNER_MAX_BOTTOM_MARGIN_SURFACE_RATIO,
      )
  );
}

function isFullScreenOverlayRect(rect: RawSnapshotNode['rect']): boolean {
  if (!rect) return false;
  return rect.x <= 1 && rect.y <= 1 && rect.width >= 300 && rect.height >= 600;
}
