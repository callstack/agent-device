package com.callstack.agentdevice.snapshothelper;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeoutException;

public final class PressSequenceTest {
  private static final long TIMEOUT = PressSequence.INJECTION_TIMEOUT_MS;

  private PressSequenceTest() {}

  static void run() {
    endsWithTheStartDownTime();
    retriesADroppedStartAfterTheAnimationSyncWithAFreshDownTime();
    retriesAStartRefusedJustBeforeTheInjectionDeadline();
    cancelsAndDoesNotRetryAStartRefusedAtTheInjectionDeadline();
    discardsAStartDroppedAgainAfterTheSync();
    cancelsARetriedStartThatTimesOut();
    doesNotCancelARefusedEnd();
    failsADroppedStartAtOnceWhenInjectionWaitsForAnimations();
    reportsAnUnavailableAnimationSyncApartFromARefusal();
    keepsTheTimeoutWhenItsCancelThrows();
    retriesADroppedStartWhenItsDiscardThrows();
    failsATimedOutKeyStartWithATimeoutAndInjectsNoEnd();
    failsARefusedEndAsARefusal();
  }

  private static void endsWithTheStartDownTime() {
    FakeInjections injections = FakeInjections.skippingTheWait(accepted());
    expect(PressSequence.run(injections), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "end 1");
  }

  private static void retriesADroppedStartAfterTheAnimationSyncWithAFreshDownTime() {
    FakeInjections injections = FakeInjections.skippingTheWait(refusedAfter(0), accepted());
    expect(PressSequence.run(injections), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "discard 1", "sync", "start 3", "end 3");
  }

  private static void retriesAStartRefusedJustBeforeTheInjectionDeadline() {
    FakeInjections injections =
        FakeInjections.skippingTheWait(refusedAfter(TIMEOUT - 2), accepted());
    expect(PressSequence.run(injections), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "discard 1", "sync", "start 30001", "end 30001");
  }

  private static void cancelsAndDoesNotRetryAStartRefusedAtTheInjectionDeadline() {
    FakeInjections injections =
        FakeInjections.skippingTheWait(refusedAfter(TIMEOUT - 1), accepted());
    expect(PressSequence.run(injections), PressSequence.Outcome.START_TIMED_OUT);
    expect(injections.calls, "start 1", "cancel 1");
  }

  private static void discardsAStartDroppedAgainAfterTheSync() {
    FakeInjections injections = FakeInjections.skippingTheWait(refusedAfter(0), refusedAfter(0));
    expect(PressSequence.run(injections), PressSequence.Outcome.START_REFUSED);
    expect(injections.calls, "start 1", "discard 1", "sync", "start 3", "discard 3");
  }

  private static void cancelsARetriedStartThatTimesOut() {
    FakeInjections injections =
        FakeInjections.skippingTheWait(refusedAfter(0), refusedAfter(TIMEOUT));
    expect(PressSequence.run(injections), PressSequence.Outcome.START_TIMED_OUT);
    expect(injections.calls, "start 1", "discard 1", "sync", "start 3", "cancel 3");
  }

  private static void doesNotCancelARefusedEnd() {
    FakeInjections injections = FakeInjections.skippingTheWait(accepted());
    injections.endAccepted = false;
    expect(PressSequence.run(injections), PressSequence.Outcome.END_REFUSED);
    expect(injections.calls, "start 1", "end 1");
  }

  private static void failsADroppedStartAtOnceWhenInjectionWaitsForAnimations() {
    FakeInjections injections = FakeInjections.skippingTheWait(refusedAfter(0), accepted());
    injections.skipsAnimationWait = false;
    expect(PressSequence.run(injections), PressSequence.Outcome.START_REFUSED);
    expect(injections.calls, "start 1");
  }

  private static void reportsAnUnavailableAnimationSyncApartFromARefusal() {
    FakeInjections injections = FakeInjections.skippingTheWait(refusedAfter(0), accepted());
    injections.syncAvailable = false;
    expect(PressSequence.run(injections), PressSequence.Outcome.ANIMATION_SYNC_UNAVAILABLE);
    expect(injections.calls, "start 1", "discard 1", "sync");
  }

  private static void keepsTheTimeoutWhenItsCancelThrows() {
    FakeInjections injections = FakeInjections.skippingTheWait(refusedAfter(TIMEOUT), accepted());
    injections.releaseThrows = true;
    expect(PressSequence.run(injections), PressSequence.Outcome.START_TIMED_OUT);
    expect(injections.calls, "start 1", "cancel 1");
  }

  private static void retriesADroppedStartWhenItsDiscardThrows() {
    FakeInjections injections = FakeInjections.skippingTheWait(refusedAfter(0), accepted());
    injections.releaseThrows = true;
    expect(PressSequence.run(injections), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "discard 1", "sync", "start 3", "end 3");
  }

  private static void failsATimedOutKeyStartWithATimeoutAndInjectsNoEnd() {
    FakeInjections injections = FakeInjections.skippingTheWait(refusedAfter(TIMEOUT), accepted());
    expectFailure(injections, TimeoutException.class,
        "Key injection timed out before the app finished handling it; it was cancelled");
    expect(injections.calls, "start 1", "cancel 1");
  }

  private static void failsARefusedEndAsARefusal() {
    FakeInjections injections = FakeInjections.skippingTheWait(accepted());
    injections.endAccepted = false;
    expectFailure(injections, IllegalStateException.class, "Key injection was refused");
    expect(injections.calls, "start 1", "end 1");
  }

  private static void expectFailure(
      FakeInjections injections, Class<? extends Exception> type, String message) {
    try {
      PressSequence.requireDispatched(PressSequence.run(injections), "Key");
    } catch (Exception error) {
      if (error.getClass() != type || !message.equals(error.getMessage())) {
        throw new AssertionError("Expected " + type.getName() + ": " + message + ", got " + error);
      }
      return;
    }
    throw new AssertionError("Expected " + type.getName() + ", but the press dispatched");
  }

  /** A start the framework accepts. */
  private static long accepted() {
    return -1;
  }

  /** A start the framework refuses after this many milliseconds. */
  private static long refusedAfter(long elapsedMs) {
    return elapsedMs;
  }

  private static void expect(PressSequence.Outcome actual, PressSequence.Outcome expected) {
    if (actual != expected) throw new AssertionError("Expected " + expected + ", got " + actual);
  }

  private static void expect(List<String> actual, String... expected) {
    if (!actual.equals(Arrays.asList(expected))) {
      throw new AssertionError("Expected " + Arrays.asList(expected) + ", got " + actual);
    }
  }

  /** Each {@code now()} advances the clock by 1 ms; a refused start also advances it by its delay. */
  private static final class FakeInjections implements PressSequence.Injections {
    final List<String> calls = new ArrayList<>();
    private final long[] starts;
    private int startIndex;
    private long clock;
    boolean skipsAnimationWait = true;
    boolean syncAvailable = true;
    boolean endAccepted = true;
    boolean releaseThrows;

    private FakeInjections(long[] starts) {
      this.starts = starts;
    }

    static FakeInjections skippingTheWait(long... starts) {
      return new FakeInjections(starts);
    }

    @Override
    public long now() {
      return ++clock;
    }

    @Override
    public boolean skipsAnimationWait() {
      return skipsAnimationWait;
    }

    @Override
    public boolean start(long downTime) {
      calls.add("start " + downTime);
      long refusedAfterMs = starts[startIndex++];
      if (refusedAfterMs < 0) return true;
      clock += refusedAfterMs;
      return false;
    }

    @Override
    public boolean end(long downTime) {
      calls.add("end " + downTime);
      return endAccepted;
    }

    @Override
    public void discardDroppedStart(long downTime) {
      calls.add("discard " + downTime);
      if (releaseThrows) throw new IllegalStateException("discard failed");
    }

    @Override
    public void cancelStart(long downTime) {
      calls.add("cancel " + downTime);
      if (releaseThrows) throw new IllegalStateException("cancel failed");
    }

    @Override
    public boolean awaitAnimations() {
      calls.add("sync");
      return syncAvailable;
    }
  }
}
