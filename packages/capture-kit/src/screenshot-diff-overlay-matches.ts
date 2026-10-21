import type {
  ScreenshotDiffRegion,
  ScreenshotDiffRegionOverlayMatch,
} from './screenshot-diff-regions.ts';
import type { ScreenshotOverlayRef } from '@agent-device/kernel/snapshot';
import { rectArea } from '@agent-device/kernel/rect';
import { intersectArea } from '@agent-device/kernel/screenshot-geometry';

const MAX_MATCHES_PER_REGION = 3;

export function attachCurrentOverlayMatches(
  regions: ScreenshotDiffRegion[],
  overlayRefs: ScreenshotOverlayRef[],
  currentScale = { x: 1, y: 1 },
): ScreenshotDiffRegion[] {
  const scaledRefs = overlayRefs.map((ref) => ({
    ...ref,
    overlayRect: {
      x: ref.overlayRect.x * currentScale.x,
      y: ref.overlayRect.y * currentScale.y,
      width: ref.overlayRect.width * currentScale.x,
      height: ref.overlayRect.height * currentScale.y,
    },
  }));
  return regions.map((region) => {
    const matches = findRegionOverlayMatches(region, scaledRefs);
    return matches.length > 0 ? { ...region, currentOverlayMatches: matches } : region;
  });
}

function findRegionOverlayMatches(
  region: ScreenshotDiffRegion,
  overlayRefs: ScreenshotOverlayRef[],
): ScreenshotDiffRegionOverlayMatch[] {
  const regionArea = rectArea(region.rect);
  return overlayRefs
    .map((overlayRef) => {
      const overlayRect = overlayRef.overlayRect;
      const overlapArea = intersectArea(region.rect, overlayRect);
      if (overlapArea <= 0) return null;
      return {
        ref: overlayRef.ref,
        ...(overlayRef.label ? { label: overlayRef.label } : {}),
        rect: overlayRect,
        overlayCoveragePercentage: roundPercentage(overlapArea / rectArea(overlayRect)),
        regionCoveragePercentage: roundPercentage(overlapArea / regionArea),
      };
    })
    .filter(
      (match): match is ScreenshotDiffRegionOverlayMatch & { overlayCoveragePercentage: number } =>
        match !== null,
    )
    .sort((left, right) => {
      const coverageDelta = right.regionCoveragePercentage - left.regionCoveragePercentage;
      if (coverageDelta !== 0) return coverageDelta;
      return right.overlayCoveragePercentage - left.overlayCoveragePercentage;
    })
    .slice(0, MAX_MATCHES_PER_REGION)
    .map((match) => ({
      ref: match.ref,
      ...(match.label ? { label: match.label } : {}),
      rect: match.rect,
      regionCoveragePercentage: match.regionCoveragePercentage,
    }));
}

function roundPercentage(ratio: number): number {
  return Math.round(ratio * 100 * 100) / 100;
}
