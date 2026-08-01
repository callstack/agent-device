package com.callstack.agentdevice.snapshothelper;

final class AccessibilityCaptureStabilizer {
  private static final long RETRY_INTERVAL_MS = 50;

  interface Capture {
    boolean isComplete();
  }

  interface Attempt<T extends Capture> {
    T capture();
  }

  interface Clock {
    long nowMs();
  }

  interface Sleeper {
    void sleep(long durationMs) throws InterruptedException;
  }

  static final class IncompleteCaptureException extends Exception {
    IncompleteCaptureException(long timeoutMs) {
      super("Android accessibility capture remained incomplete after " + timeoutMs + " ms");
    }
  }

  private AccessibilityCaptureStabilizer() {}

  static boolean requiresActiveWindowFallback(
      int capturedWindowCount, boolean activeWindowRootMissing) {
    return capturedWindowCount == 0 || activeWindowRootMissing;
  }

  static boolean canAppendActiveWindowFallback(
      int capturedWindowCount, boolean activeWindowMetadataAvailable) {
    return capturedWindowCount == 0 || activeWindowMetadataAvailable;
  }

  static <T extends Capture> T capture(Attempt<T> attempt, long timeoutMs)
      throws InterruptedException, IncompleteCaptureException {
    return capture(
        attempt,
        timeoutMs,
        () -> System.nanoTime() / 1_000_000,
        Thread::sleep);
  }

  static <T extends Capture> T capture(
      Attempt<T> attempt, long timeoutMs, Clock clock, Sleeper sleeper)
      throws InterruptedException, IncompleteCaptureException {
    T capture = attempt.capture();
    if (capture.isComplete()) {
      return capture;
    }
    if (timeoutMs <= 0) {
      throw new IncompleteCaptureException(timeoutMs);
    }

    long startedAtMs = clock.nowMs();
    long deadlineMs = startedAtMs + timeoutMs;
    if (deadlineMs < startedAtMs) {
      deadlineMs = Long.MAX_VALUE;
    }
    while (!capture.isComplete()) {
      long remainingMs = deadlineMs - clock.nowMs();
      if (remainingMs <= 0) {
        throw new IncompleteCaptureException(timeoutMs);
      }
      try {
        sleeper.sleep(Math.min(RETRY_INTERVAL_MS, remainingMs));
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw error;
      }
      capture = attempt.capture();
    }
    return capture;
  }
}
