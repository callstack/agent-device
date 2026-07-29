package com.callstack.agentdevice.snapshothelper;

public final class AccessibilityCaptureStabilizerTest {
  private AccessibilityCaptureStabilizerTest() {}

  static void run() throws Exception {
    recoversFromTransientRootGap();
    rejectsIncompleteCaptureAtTheDeadline();
    rejectsIncompleteCaptureWithoutRetry();
    propagatesInterruption();
    supplementsCapturedWindowsWhenTheActiveRootIsMissing();
  }

  private static void recoversFromTransientRootGap() throws Exception {
    int[] attempts = {0};
    FakeTime time = new FakeTime();
    FakeCapture capture =
        AccessibilityCaptureStabilizer.capture(
            () -> {
              attempts[0] += 1;
              return new FakeCapture(attempts[0] >= 2);
            },
            500,
            time,
            time);

    if (!capture.isComplete()) {
      throw new AssertionError("Expected capture to recover when a root becomes available");
    }
    if (attempts[0] != 2) {
      throw new AssertionError("Expected 2 capture attempts, got " + attempts[0]);
    }
  }

  private static void rejectsIncompleteCaptureAtTheDeadline() throws InterruptedException {
    int[] attempts = {0};
    FakeTime time = new FakeTime();
    try {
      AccessibilityCaptureStabilizer.capture(
          () -> {
            attempts[0] += 1;
            return new FakeCapture(false);
          },
          100,
          time,
          time);
      throw new AssertionError("Expected incomplete capture to fail at the deadline");
    } catch (AccessibilityCaptureStabilizer.IncompleteCaptureException expected) {
      if (!expected.getMessage().contains("100 ms")) {
        throw new AssertionError("Expected the failure to identify the 100 ms budget");
      }
    }
    if (attempts[0] != 3) {
      throw new AssertionError("Expected 3 bounded capture attempts, got " + attempts[0]);
    }
    if (time.nowMs() != 100) {
      throw new AssertionError("Expected the capture deadline at 100 ms, got " + time.nowMs());
    }
  }

  private static void rejectsIncompleteCaptureWithoutRetry() throws InterruptedException {
    int[] attempts = {0};
    FakeTime time = new FakeTime();
    try {
      AccessibilityCaptureStabilizer.capture(
          () -> {
            attempts[0] += 1;
            return new FakeCapture(false);
          },
          0,
          time,
          time);
      throw new AssertionError("Expected immediate incomplete capture to fail");
    } catch (AccessibilityCaptureStabilizer.IncompleteCaptureException expected) {
      // A zero budget disables retries, not the completeness requirement.
    }

    if (attempts[0] != 1) {
      throw new AssertionError("Expected immediate capture mode to make one attempt");
    }
  }

  private static void propagatesInterruption() {
    Thread.interrupted();
    try {
      AccessibilityCaptureStabilizer.capture(
          () -> new FakeCapture(false),
          500,
          () -> 0,
          durationMs -> {
            throw new InterruptedException("capture canceled");
          });
      throw new AssertionError("Expected capture interruption to propagate");
    } catch (InterruptedException expected) {
      if (!Thread.currentThread().isInterrupted()) {
        throw new AssertionError("Expected capture interruption to restore the thread flag");
      }
    } catch (AccessibilityCaptureStabilizer.IncompleteCaptureException error) {
      throw new AssertionError("Interruption should win over the capture deadline", error);
    } finally {
      Thread.interrupted();
    }
  }

  private static void supplementsCapturedWindowsWhenTheActiveRootIsMissing() {
    if (!AccessibilityCaptureStabilizer.requiresActiveWindowFallback(1, true)) {
      throw new AssertionError("Expected an unresolved active root to use the active-window fallback");
    }
    if (AccessibilityCaptureStabilizer.requiresActiveWindowFallback(1, false)) {
      throw new AssertionError("Expected a complete interactive-window capture to skip fallback");
    }
    if (AccessibilityCaptureStabilizer.canAppendActiveWindowFallback(1, false)) {
      throw new AssertionError("Expected a mixed fallback without window metadata to be rejected");
    }
    if (!AccessibilityCaptureStabilizer.canAppendActiveWindowFallback(1, true)) {
      throw new AssertionError("Expected a metadata-backed mixed fallback to be accepted");
    }
  }

  private static final class FakeCapture implements AccessibilityCaptureStabilizer.Capture {
    private final boolean complete;

    FakeCapture(boolean complete) {
      this.complete = complete;
    }

    @Override
    public boolean isComplete() {
      return complete;
    }
  }

  private static final class FakeTime
      implements AccessibilityCaptureStabilizer.Clock, AccessibilityCaptureStabilizer.Sleeper {
    private long nowMs;

    @Override
    public long nowMs() {
      return nowMs;
    }

    @Override
    public void sleep(long durationMs) {
      nowMs += durationMs;
    }
  }
}
