package com.callstack.agentdevice.multitouchhelper;

import java.util.ArrayList;
import java.util.List;

/** Defines the platform-independent event order consumed by Android touch injection. */
final class PointerEventSchedule {
  private static final long POINTER_LIFT_DELAY_MS = 8;

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

    Step(Action action, int sampleIndex, int pointerCount, long offsetMs) {
      this.action = action;
      this.sampleIndex = sampleIndex;
      this.pointerCount = pointerCount;
      this.offsetMs = offsetMs;
    }
  }

  private PointerEventSchedule() {}

  static List<Step> create(int pointerCount, long[] sampleOffsetsMs) {
    if (pointerCount != 1 && pointerCount != 2) {
      throw new IllegalArgumentException("Pointer event schedule requires one or two pointers");
    }
    if (sampleOffsetsMs.length < 2) {
      throw new IllegalArgumentException("Pointer event schedule requires at least two samples");
    }

    int lastIndex = sampleOffsetsMs.length - 1;
    List<Step> steps = new ArrayList<>(sampleOffsetsMs.length + (pointerCount == 1 ? 1 : 3));
    steps.add(new Step(Action.DOWN, 0, 1, 0));
    if (pointerCount == 2) {
      long pointerDownOffset = Math.max(1, Math.min(8, sampleOffsetsMs[1] - 1));
      steps.add(new Step(Action.POINTER_DOWN, 0, 2, pointerDownOffset));
    }
    for (int sampleIndex = 1; sampleIndex <= lastIndex; sampleIndex += 1) {
      steps.add(
          new Step(Action.MOVE, sampleIndex, pointerCount, sampleOffsetsMs[sampleIndex]));
    }
    if (pointerCount == 2) {
      steps.add(
          new Step(Action.POINTER_UP, lastIndex, 2, sampleOffsetsMs[lastIndex]));
    }
    long finalUpOffset =
        sampleOffsetsMs[lastIndex] + (pointerCount == 2 ? POINTER_LIFT_DELAY_MS : 0);
    steps.add(new Step(Action.UP, lastIndex, 1, finalUpOffset));
    return steps;
  }
}
