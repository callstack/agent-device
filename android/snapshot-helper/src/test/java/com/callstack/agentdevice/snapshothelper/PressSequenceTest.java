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
    retriesADropThatLeavesRoomForTheSyncAndTheRetryDeadline();
    skipsTheRetryOfADropThatLeavesNoRoomForTheSyncAndTheRetryDeadline();
    skipsTheRetryWhenTheSyncLeavesNoRoomForTheRetryDeadline();
    discardsAStartRefusedJustBeforeTheInjectionDeadlineAsADrop();
    cancelsAndDoesNotRetryAStartRefusedAtTheInjectionDeadline();
    discardsAStartDroppedAgainAfterTheSync();
    cancelsARetriedStartThatTimesOut();
    waitsForTheEndWhenItsDeadlineFits();
    injectsTheEndWithoutWaitingWhenItsDeadlineDoesNotFit();
    doesNotCancelARefusedEnd();
    failsADroppedStartAtOnceWhenInjectionWaitsForAnimations();
    reportsAnUnavailableAnimationSyncApartFromARefusal();
    reportsARefusedCancelOfATimedOutStart();
    treatsAThrowingCancelAsRefused();
    retriesADroppedStartWhenItsDiscardThrows();
    failsATimedOutKeyStartWithATimeoutAndInjectsNoEnd();
    namesARefusedCancelInTheTimeout();
    failsARefusedEndAsARefusal();
  }

  private static void endsWithTheStartDownTime() {
    FakeInjections injections = new FakeInjections(accepted());
    expect(PressSequence.run(injections), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "end 1");
  }

  private static void retriesADroppedStartAfterTheAnimationSyncWithAFreshDownTime() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), accepted());
    expect(PressSequence.run(injections), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "discard 1", "sync", "start 5", "end 5");
  }

  private static void retriesADropThatLeavesRoomForTheSyncAndTheRetryDeadline() {
    FakeInjections injections = new FakeInjections(refusedAfter(4_998), accepted());
    expect(PressSequence.run(injections), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "discard 1", "sync", "start 5003", "end 5003");
  }

  private static void skipsTheRetryOfADropThatLeavesNoRoomForTheSyncAndTheRetryDeadline() {
    FakeInjections injections = new FakeInjections(refusedAfter(4_999), accepted());
    expect(PressSequence.run(injections), PressSequence.Outcome.START_REFUSED);
    expect(injections.calls, "start 1", "discard 1");
  }

  private static void skipsTheRetryWhenTheSyncLeavesNoRoomForTheRetryDeadline() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), accepted());
    injections.syncMs = 11_000;
    expect(PressSequence.run(injections), PressSequence.Outcome.START_REFUSED);
    expect(injections.calls, "start 1", "discard 1", "sync");
  }

  private static void discardsAStartRefusedJustBeforeTheInjectionDeadlineAsADrop() {
    FakeInjections injections = new FakeInjections(refusedAfter(TIMEOUT - 2), accepted());
    expect(PressSequence.run(injections), PressSequence.Outcome.START_REFUSED);
    expect(injections.calls, "start 1", "discard 1");
  }

  private static void cancelsAndDoesNotRetryAStartRefusedAtTheInjectionDeadline() {
    FakeInjections injections = new FakeInjections(refusedAfter(TIMEOUT - 1), accepted());
    expect(PressSequence.run(injections), PressSequence.Outcome.START_TIMED_OUT);
    expect(injections.calls, "start 1", "cancel 1");
  }

  private static void discardsAStartDroppedAgainAfterTheSync() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), refusedAfter(0));
    expect(PressSequence.run(injections), PressSequence.Outcome.START_REFUSED);
    expect(injections.calls, "start 1", "discard 1", "sync", "start 5", "discard 5");
  }

  private static void cancelsARetriedStartThatTimesOut() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), refusedAfter(TIMEOUT));
    expect(PressSequence.run(injections), PressSequence.Outcome.START_TIMED_OUT);
    expect(injections.calls, "start 1", "discard 1", "sync", "start 5", "cancel 5");
  }

  private static void waitsForTheEndWhenItsDeadlineFits() {
    FakeInjections injections = new FakeInjections(acceptedAfter(9_999));
    expect(PressSequence.run(injections), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "end 1");
  }

  private static void injectsTheEndWithoutWaitingWhenItsDeadlineDoesNotFit() {
    FakeInjections injections = new FakeInjections(acceptedAfter(10_000));
    expect(PressSequence.run(injections), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "end-async 1");
  }

  private static void doesNotCancelARefusedEnd() {
    FakeInjections injections = new FakeInjections(accepted());
    injections.endAccepted = false;
    expect(PressSequence.run(injections), PressSequence.Outcome.END_REFUSED);
    expect(injections.calls, "start 1", "end 1");
  }

  private static void failsADroppedStartAtOnceWhenInjectionWaitsForAnimations() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), accepted());
    injections.skipsAnimationWait = false;
    expect(PressSequence.run(injections), PressSequence.Outcome.START_REFUSED);
    expect(injections.calls, "start 1");
  }

  private static void reportsAnUnavailableAnimationSyncApartFromARefusal() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), accepted());
    injections.syncAvailable = false;
    expect(PressSequence.run(injections), PressSequence.Outcome.ANIMATION_SYNC_UNAVAILABLE);
    expect(injections.calls, "start 1", "discard 1", "sync");
  }

  private static void reportsARefusedCancelOfATimedOutStart() {
    FakeInjections injections = new FakeInjections(refusedAfter(TIMEOUT), accepted());
    injections.cancelAccepted = false;
    expect(PressSequence.run(injections), PressSequence.Outcome.START_TIMED_OUT_CANCEL_REFUSED);
    expect(injections.calls, "start 1", "cancel 1");
  }

  private static void treatsAThrowingCancelAsRefused() {
    FakeInjections injections = new FakeInjections(refusedAfter(TIMEOUT), accepted());
    injections.releaseThrows = true;
    expect(PressSequence.run(injections), PressSequence.Outcome.START_TIMED_OUT_CANCEL_REFUSED);
    expect(injections.calls, "start 1", "cancel 1");
  }

  private static void retriesADroppedStartWhenItsDiscardThrows() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), accepted());
    injections.releaseThrows = true;
    expect(PressSequence.run(injections), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "discard 1", "sync", "start 5", "end 5");
  }

  private static void failsATimedOutKeyStartWithATimeoutAndInjectsNoEnd() {
    FakeInjections injections = new FakeInjections(refusedAfter(TIMEOUT), accepted());
    expectFailure(injections, TimeoutException.class,
        "Key injection timed out before the app finished handling it; it was cancelled");
    expect(injections.calls, "start 1", "cancel 1");
  }

  private static void namesARefusedCancelInTheTimeout() {
    FakeInjections injections = new FakeInjections(refusedAfter(TIMEOUT), accepted());
    injections.cancelAccepted = false;
    expectFailure(injections, TimeoutException.class,
        "Key injection timed out before the app finished handling it, and its cancel was refused,"
            + " so the app may still hold it");
    expect(injections.calls, "start 1", "cancel 1");
  }

  private static void failsARefusedEndAsARefusal() {
    FakeInjections injections = new FakeInjections(accepted());
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

  /** A start the framework accepts at once. */
  private static long accepted() {
    return acceptedAfter(0);
  }

  /** A start the framework accepts after this many milliseconds. */
  private static long acceptedAfter(long elapsedMs) {
    return -elapsedMs - 1;
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

  /**
   * Each {@code now()} advances the clock by 1 ms. A start advances it by its delay, and the sync by
   * {@code syncMs}.
   */
  private static final class FakeInjections implements PressSequence.Injections {
    final List<String> calls = new ArrayList<>();
    private final long[] starts;
    private int startIndex;
    private long clock;
    boolean skipsAnimationWait = true;
    boolean syncAvailable = true;
    long syncMs;
    boolean endAccepted = true;
    boolean cancelAccepted = true;
    boolean releaseThrows;

    FakeInjections(long... starts) {
      this.starts = starts;
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
      long spec = starts[startIndex++];
      boolean accepted = spec < 0;
      clock += accepted ? -spec - 1 : spec;
      return accepted;
    }

    @Override
    public boolean end(long downTime, boolean waitForDispatch) {
      calls.add((waitForDispatch ? "end " : "end-async ") + downTime);
      return endAccepted;
    }

    @Override
    public void discardDroppedStart(long downTime) {
      calls.add("discard " + downTime);
      if (releaseThrows) throw new IllegalStateException("discard failed");
    }

    @Override
    public boolean cancelStart(long downTime) {
      calls.add("cancel " + downTime);
      if (releaseThrows) throw new IllegalStateException("cancel failed");
      return cancelAccepted;
    }

    @Override
    public boolean awaitAnimations() {
      calls.add("sync");
      clock += syncMs;
      return syncAvailable;
    }
  }
}
