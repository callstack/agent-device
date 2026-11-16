package com.callstack.agentdevice.snapshothelper;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public final class PressSequenceTest {
  private PressSequenceTest() {}

  static void run() {
    endsWithTheStartDownTime();
    retriesARefusedStartAfterTheAnimationSyncWithAFreshDownTime();
    discardsAStartRefusedAgainAfterTheSync();
    doesNotCancelARefusedEnd();
    doesNotRetryWhenInjectionAlreadyWaited();
    reportsAnUnavailableAnimationSyncApartFromARefusal();
  }

  private static void endsWithTheStartDownTime() {
    FakeInjections injections = new FakeInjections(PressSequence.AnimationSync.WAITED, true);
    expect(PressSequence.run(injections), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "end 1");
  }

  private static void retriesARefusedStartAfterTheAnimationSyncWithAFreshDownTime() {
    FakeInjections injections = new FakeInjections(PressSequence.AnimationSync.WAITED, false, true);
    expect(PressSequence.run(injections), PressSequence.Outcome.DISPATCHED);
    expect(injections.calls, "start 1", "discard 1", "sync", "start 2", "end 2");
  }

  private static void discardsAStartRefusedAgainAfterTheSync() {
    FakeInjections injections =
        new FakeInjections(PressSequence.AnimationSync.WAITED, false, false);
    expect(PressSequence.run(injections), PressSequence.Outcome.START_REFUSED);
    expect(injections.calls, "start 1", "discard 1", "sync", "start 2", "discard 2");
  }

  private static void doesNotCancelARefusedEnd() {
    FakeInjections injections = new FakeInjections(PressSequence.AnimationSync.WAITED, true);
    injections.endAccepted = false;
    expect(PressSequence.run(injections), PressSequence.Outcome.END_REFUSED);
    expect(injections.calls, "start 1", "end 1");
  }

  private static void doesNotRetryWhenInjectionAlreadyWaited() {
    FakeInjections injections =
        new FakeInjections(PressSequence.AnimationSync.ALREADY_WAITED, false, true);
    expect(PressSequence.run(injections), PressSequence.Outcome.START_REFUSED);
    expect(injections.calls, "start 1", "discard 1", "sync");
  }

  private static void reportsAnUnavailableAnimationSyncApartFromARefusal() {
    FakeInjections injections =
        new FakeInjections(PressSequence.AnimationSync.UNAVAILABLE, false, true);
    expect(PressSequence.run(injections), PressSequence.Outcome.ANIMATION_SYNC_UNAVAILABLE);
    expect(injections.calls, "start 1", "discard 1", "sync");
  }

  private static void expect(PressSequence.Outcome actual, PressSequence.Outcome expected) {
    if (actual != expected) throw new AssertionError("Expected " + expected + ", got " + actual);
  }

  private static void expect(List<String> actual, String... expected) {
    if (!actual.equals(Arrays.asList(expected))) {
      throw new AssertionError("Expected " + Arrays.asList(expected) + ", got " + actual);
    }
  }

  private static final class FakeInjections implements PressSequence.Injections {
    final List<String> calls = new ArrayList<>();
    private final PressSequence.AnimationSync sync;
    private final boolean[] startAccepted;
    private int starts;
    private long clock;
    boolean endAccepted = true;

    FakeInjections(PressSequence.AnimationSync sync, boolean... startAccepted) {
      this.sync = sync;
      this.startAccepted = startAccepted;
    }

    @Override
    public long now() {
      return ++clock;
    }

    @Override
    public boolean start(long downTime) {
      calls.add("start " + downTime);
      return startAccepted[starts++];
    }

    @Override
    public boolean end(long downTime) {
      calls.add("end " + downTime);
      return endAccepted;
    }

    @Override
    public void discardRefusedStart(long downTime) {
      calls.add("discard " + downTime);
    }

    @Override
    public PressSequence.AnimationSync awaitAnimations() {
      calls.add("sync");
      return sync;
    }
  }
}
