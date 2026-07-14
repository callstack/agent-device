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
  },
  // ScreenshotUtils.waitForAppToSettle and MAX_TIMEOUT_WAIT_TO_SETTLE_MS.
  observation: {
    pollIntervalMs: 200,
    defaultSettleAttempts: 10,
    maxSettleTimeoutMs: 30_000,
  },
  // Element swipes in Maestro's AndroidDriver and IOSDriver.
  targetSwipe: {
    defaultDirection: 'up' as const,
    nearEdgeFraction: 0.1,
    farEdgeFraction: 0.9,
  },
} as const;

export const DEFAULT_MAESTRO_COMPATIBILITY_TIMING_POLICY = {
  assertVisibleTimeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.targetLookupTimeoutMs,
  assertNotVisibleTimeoutMs: 3_000,
  extendedWaitUntilTimeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.targetLookupTimeoutMs,
  runFlowConditionTimeoutMs: 3_000,
} as const satisfies MaestroCompatibilityTimingPolicy;

export const MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS =
  MAESTRO_COMPATIBILITY_PRESETS.observation.pollIntervalMs *
  MAESTRO_COMPATIBILITY_PRESETS.observation.defaultSettleAttempts;
