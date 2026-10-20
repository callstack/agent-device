package com.callstack.agentdevice.snapshothelper;

import java.util.ArrayList;
import java.util.List;

/**
 * Defines the platform-independent event order consumed by Android touch injection.
 *
 * <p>Extra contacts go down in ascending index order before the first planned move sample and lift
 * in descending order 8 ms apart after the last one, so the active contacts are always indices 0 to
 * {@code pointerCount - 1} and the changing contact is always the highest of them. With two
 * contacts this is the original single-transition schedule.
 */
final class PointerEventSchedule {
  private static final long POINTER_TRANSITION_DELAY_MS = 8;

  enum Action {
    DOWN,
    POINTER_DOWN,
    MOVE,
    POINTER_UP,
    UP
  }

  static final class Step {
    final Action action;
    final int sampleIndex;
    final int pointerCount;
    final long offsetMs;
    final boolean waitForDispatch;

    Step(
        Action action,
        int sampleIndex,
        int pointerCount,
        long offsetMs,
        boolean waitForDispatch) {
      this.action = action;
      this.sampleIndex = sampleIndex;
      this.pointerCount = pointerCount;
      this.offsetMs = offsetMs;
      this.waitForDispatch = waitForDispatch;
    }
  }

  private PointerEventSchedule() {}

  static List<Step> create(int pointerCount, long[] sampleOffsetsMs) {
    if (pointerCount < 1 || pointerCount > TouchPlan.MAX_CONTACTS) {
      throw new IllegalArgumentException(
          "Pointer event schedule requires 1 to " + TouchPlan.MAX_CONTACTS + " pointers");
    }
    if (sampleOffsetsMs.length < 2) {
      throw new IllegalArgumentException("Pointer event schedule requires at least two samples");
    }

    int lastIndex = sampleOffsetsMs.length - 1;
    long lastOffset = sampleOffsetsMs[lastIndex];
    long transitionMs = transitionSpacing(pointerCount, sampleOffsetsMs[1]);
    List<Step> steps = new ArrayList<>(sampleOffsetsMs.length + 2 * pointerCount);
    steps.add(new Step(Action.DOWN, 0, 1, 0, true));
    for (int contact = 2; contact <= pointerCount; contact += 1) {
      steps.add(new Step(Action.POINTER_DOWN, 0, contact, (contact - 1) * transitionMs, true));
    }
    for (int sampleIndex = 1; sampleIndex <= lastIndex; sampleIndex += 1) {
      steps.add(
          new Step(
              Action.MOVE,
              sampleIndex,
              pointerCount,
              sampleOffsetsMs[sampleIndex],
              pointerCount == 1 || sampleIndex == lastIndex));
    }
    for (int contact = pointerCount; contact >= 2; contact -= 1) {
      long offset = lastOffset + (pointerCount - contact) * POINTER_TRANSITION_DELAY_MS;
      steps.add(new Step(Action.POINTER_UP, lastIndex, contact, offset, true));
    }
    long finalUpOffset = lastOffset + (pointerCount - 1) * POINTER_TRANSITION_DELAY_MS;
    steps.add(new Step(Action.UP, lastIndex, 1, finalUpOffset, true));
    return steps;
  }

  /** The gap between touch-downs: up to 8 ms, shrunk so every contact is down before the first move. */
  private static long transitionSpacing(int pointerCount, long firstSampleOffsetMs) {
    if (pointerCount == 1) return 0;
    long fitting = (firstSampleOffsetMs - 1) / (pointerCount - 1);
    return Math.max(1, Math.min(POINTER_TRANSITION_DELAY_MS, fitting));
  }
}
