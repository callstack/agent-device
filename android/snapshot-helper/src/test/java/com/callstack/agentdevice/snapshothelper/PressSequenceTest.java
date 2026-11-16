package com.callstack.agentdevice.snapshothelper;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public final class PressSequenceTest {
  private static final long ROOM = PressSequence.RETRY_WORST_CASE_MS;
  /** A deadline far enough away that it never limits the press. */
  private static final long OPEN = Long.MAX_VALUE / 2;

  private PressSequenceTest() {}

  static void run() {
    endsWithTheStartDownTime();
    releasesARefusedStartAndRetriesItAfterTheSyncWithAFreshDownTime();
    retriesWhenTheDeadlineLeavesExactlyRoomForTheRetry();
    releasesWithoutRetryingWhenTheDeadlineLeavesNoRoomForTheRetry();
    releasesWithoutRetryingAStartRefusedLateInTheBudget();
    releasesAStartRefusedAgainAfterTheSync();
    doesNotCancelARefusedEnd();
    releasesAndFailsADroppedStartAtOnceWhenInjectionWaitsForAnimations();
    reportsAnUnavailableAnimationSyncApartFromARefusal();
    retriesWhenTheReleaseThrows();
    failsARefusedPressAsARefusal();
    failsAnUnavailableSyncAsUnsupported();
  }

  private static void endsWithTheStartDownTime() {
    FakeInjections injections = new FakeInjections(accepted());
    expect(PressSequence.run(injections, OPEN), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "end 1");
  }

  private static void releasesARefusedStartAndRetriesItAfterTheSyncWithAFreshDownTime() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), accepted());
    expect(PressSequence.run(injections, OPEN), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "release 1", "sync", "start 3", "end 3");
  }

  private static void retriesWhenTheDeadlineLeavesExactlyRoomForTheRetry() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), accepted());
    expect(PressSequence.run(injections, 2 + ROOM), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "release 1", "sync", "start 3", "end 3");
  }

  private static void releasesWithoutRetryingWhenTheDeadlineLeavesNoRoomForTheRetry() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), accepted());
    expect(PressSequence.run(injections, 1 + ROOM), PressSequence.Outcome.START_REFUSED);
    expect(injections.calls, "start 1", "release 1");
  }

  private static void releasesWithoutRetryingAStartRefusedLateInTheBudget() {
    FakeInjections injections = new FakeInjections(refusedAfter(30_000), accepted());
    expect(PressSequence.run(injections, 40_000), PressSequence.Outcome.START_REFUSED);
    expect(injections.calls, "start 1", "release 1");
  }

  private static void releasesAStartRefusedAgainAfterTheSync() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), refusedAfter(0));
    expect(PressSequence.run(injections, OPEN), PressSequence.Outcome.START_REFUSED);
    expect(injections.calls, "start 1", "release 1", "sync", "start 3", "release 3");
  }

  private static void doesNotCancelARefusedEnd() {
    FakeInjections injections = new FakeInjections(accepted());
    injections.endAccepted = false;
    expect(PressSequence.run(injections, OPEN), PressSequence.Outcome.END_REFUSED);
    expect(injections.calls, "start 1", "end 1");
  }

  private static void releasesAndFailsADroppedStartAtOnceWhenInjectionWaitsForAnimations() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), accepted());
    injections.skipsAnimationWait = false;
    expect(PressSequence.run(injections, OPEN), PressSequence.Outcome.START_REFUSED);
    expect(injections.calls, "start 1", "release 1");
  }

  private static void reportsAnUnavailableAnimationSyncApartFromARefusal() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), accepted());
    injections.syncAvailable = false;
    expect(PressSequence.run(injections, OPEN), PressSequence.Outcome.ANIMATION_SYNC_UNAVAILABLE);
    expect(injections.calls, "start 1", "release 1", "sync");
  }

  private static void retriesWhenTheReleaseThrows() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), accepted());
    injections.releaseThrows = true;
    expect(PressSequence.run(injections, OPEN), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "release 1", "sync", "start 3", "end 3");
  }

  private static void failsARefusedPressAsARefusal() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), refusedAfter(0));
    expectFailure(injections, IllegalStateException.class, "Key injection was refused");
  }

  private static void failsAnUnavailableSyncAsUnsupported() {
    FakeInjections injections = new FakeInjections(refusedAfter(0), accepted());
    injections.syncAvailable = false;
    expectFailure(injections, UnsupportedOperationException.class,
        "Key injection was refused and this runtime cannot wait for animations to retry it");
  }

  private static void expectFailure(
      FakeInjections injections, Class<? extends RuntimeException> type, String message) {
    try {
      PressSequence.requireDispatched(PressSequence.run(injections, OPEN), "Key");
    } catch (RuntimeException error) {
      if (error.getClass() != type || !message.equals(error.getMessage())) {
        throw new AssertionError("Expected " + type.getName() + ": " + message + ", got " + error);
      }
      return;
    }
    throw new AssertionError("Expected " + type.getName() + ", but the press dispatched");
  }

  /** A start the framework accepts at once. */
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
    public void releaseRefusedStart(long downTime) {
      calls.add("release " + downTime);
      if (releaseThrows) throw new IllegalStateException("release failed");
    }

    @Override
    public boolean awaitAnimations() {
      calls.add("sync");
      return syncAvailable;
    }
  }
}
