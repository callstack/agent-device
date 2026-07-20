export type MaestroCompatibilityTimingPolicy = {
  assertVisibleTimeoutMs: number;
  assertNotVisibleTimeoutMs: number;
  extendedWaitUntilTimeoutMs: number;
  runFlowConditionTimeoutMs: number;
};

// Maestro 2.5.1 defaults at a4c7c95f. The conformance oracle cross-checks the
// retry cap, swipe duration, erase cap, and animation-wait constants below
// against JVM-generated semantic vectors (scripts/maestro-conformance).
export const MAESTRO_COMPATIBILITY_PRESETS = {
  control: {
    retryMaxRetries: 3,
  },
  command: {
    retryTapMaxAttempts: 2,
    targetLookupTimeoutMs: 17_000,
    optionalTargetLookupTimeoutMs: 7_000,
    scrollUntilVisibleTimeoutMs: 20_000,
    waitForAnimationToEndTimeoutMs: 15_000,
    waitForAnimationToEndDifferencePercent: 0.005,
    longPressDurationMs: 3_000,
    swipeDurationMs: 400,
    repeatDelayMs: 100,
    scrollUntilVisibleSpeed: 40,
    scrollUntilVisiblePercentage: 100,
    eraseTextMaxCharacters: 50,
  },
  // ScreenshotUtils.waitForAppToSettle and MAX_TIMEOUT_WAIT_TO_SETTLE_MS.
  observation: {
    pollIntervalMs: 200,
    defaultSettleAttempts: 10,
  },
  // AndroidDriver.swipe(elementPoint, ...) and IOSDriver.swipe(elementPoint, ...).
  targetSwipe: {
    nearEdgeFraction: 0.1,
    farEdgeFraction: 0.9,
  },
  // Vertical AndroidDriver.swipe(direction, ...) and IOSDriver.swipe(direction, ...).
  // Horizontal presets use the shared in-page gesture planner to avoid OS edge gestures.
  screenSwipe: {
    nearEdgeFraction: 0.1,
    farEdgeFraction: 0.9,
    centerFraction: 0.5,
    downStartFraction: 0.2,
    upStartFraction: { android: 0.5, ios: 0.9 },
  },
  // Maestro.swipeFromCenter delegates to driver.swipe(center, direction).
  // Both mobile drivers use these axis-edge fractions for that overload.
  scrollUntilVisibleSwipe: {
    nearEdgeFraction: 0.1,
    farEdgeFraction: 0.9,
  },
} as const;

export function maestroScrollDurationFromSpeed(speed: number): number {
  // ScrollUntilVisibleCommand.speedToDuration intentionally adds one millisecond.
  return Math.trunc((1_000 * (100 - speed)) / 100) + 1;
}

export const DEFAULT_MAESTRO_COMPATIBILITY_TIMING_POLICY = {
  assertVisibleTimeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.targetLookupTimeoutMs,
  assertNotVisibleTimeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.targetLookupTimeoutMs,
  extendedWaitUntilTimeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.targetLookupTimeoutMs,
  runFlowConditionTimeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.optionalTargetLookupTimeoutMs,
} as const satisfies MaestroCompatibilityTimingPolicy;

export const MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS =
  MAESTRO_COMPATIBILITY_PRESETS.observation.pollIntervalMs *
  MAESTRO_COMPATIBILITY_PRESETS.observation.defaultSettleAttempts;

export function resolveMaestroTimingPolicy(
  overrides: Partial<MaestroCompatibilityTimingPolicy> = {},
): MaestroCompatibilityTimingPolicy {
  const policy = { ...DEFAULT_MAESTRO_COMPATIBILITY_TIMING_POLICY, ...overrides };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new AppError(
        'INVALID_ARGS',
        `Maestro timing policy ${name} must be a non-negative integer.`,
      );
    }
  }
  return policy;
}
import { AppError } from '../../kernel/errors.ts';
