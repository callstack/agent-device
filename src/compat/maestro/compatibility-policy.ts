export type MaestroCompatibilityTimingPolicy = {
  assertVisibleTimeoutMs: number;
  assertNotVisibleTimeoutMs: number;
  extendedWaitUntilTimeoutMs: number;
  runFlowConditionTimeoutMs: number;
};

// Defaults from Maestro Orchestra command models and lookup policy.
export const MAESTRO_COMPATIBILITY_PRESETS = {
  command: {
    targetLookupTimeoutMs: 17_000,
    optionalTargetLookupTimeoutMs: 7_000,
    scrollUntilVisibleTimeoutMs: 20_000,
    waitForAnimationToEndTimeoutMs: 15_000,
    longPressDurationMs: 3_000,
    swipeDurationMs: 400,
    repeatDelayMs: 100,
    scrollUntilVisibleSpeed: 40,
  },
  // ScreenshotUtils.waitForAppToSettle and MAX_TIMEOUT_WAIT_TO_SETTLE_MS.
  observation: {
    pollIntervalMs: 200,
    defaultSettleAttempts: 10,
  },
  // Element swipes in Maestro's AndroidDriver and IOSDriver.
  targetSwipe: {
    defaultDirection: 'up' as const,
    nearEdgeFraction: 0.1,
    farEdgeFraction: 0.9,
  },
  screenSwipe: {
    android: {
      up: { start: { x: 0.5, y: 0.5 }, end: { x: 0.5, y: 0.1 } },
      down: { start: { x: 0.5, y: 0.2 }, end: { x: 0.5, y: 0.9 } },
      left: { start: { x: 0.9, y: 0.5 }, end: { x: 0.1, y: 0.5 } },
      right: { start: { x: 0.1, y: 0.5 }, end: { x: 0.9, y: 0.5 } },
    },
    ios: {
      up: { start: { x: 0.5, y: 0.9 }, end: { x: 0.5, y: 0.1 } },
      down: { start: { x: 0.5, y: 0.2 }, end: { x: 0.5, y: 0.9 } },
      left: { start: { x: 0.9, y: 0.5 }, end: { x: 0.1, y: 0.5 } },
      right: { start: { x: 0.1, y: 0.5 }, end: { x: 0.9, y: 0.5 } },
    },
  },
} as const;

export function maestroScrollDurationFromSpeed(speed: number): number {
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
