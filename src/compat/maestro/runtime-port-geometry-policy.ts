import type { MaestroDirection } from './program-ir.ts';

// Maestro's command model supplies this value even when YAML omits `duration`.
export const MAESTRO_DEFAULT_SWIPE_DURATION_MS = 400;

/**
 * Target-relative swipes need enough travel to move a small target, but must
 * remain bounded and inside the viewport to avoid system-edge gesture zones.
 */
export const MAESTRO_TARGET_SWIPE_POLICY = {
  defaultDirection: 'up' as MaestroDirection,
  viewportMarginPx: 8,
  screenTravelFraction: 0.35,
  targetTravelMultiplier: 1.5,
  minTravelPx: 120,
  maxTravelPx: 360,
} as const;
