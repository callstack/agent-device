package com.callstack.agentdevice.multitouchhelper;

import java.util.List;

public final class PointerEventScheduleTest {
  private PointerEventScheduleTest() {}

  public static void main(String[] args) {
    assertSteps(
        PointerEventSchedule.create(1, new long[] {0, 16, 32}),
        "DOWN:0:1:0",
        "MOVE:1:1:16",
        "MOVE:2:1:32",
        "UP:2:1:32");
    assertSteps(
        PointerEventSchedule.create(2, new long[] {0, 16, 32}),
        "DOWN:0:1:0",
        "POINTER_DOWN:0:2:8",
        "MOVE:1:2:16",
        "MOVE:2:2:32",
        "POINTER_UP:2:2:32",
        "UP:2:1:40");
  }

  private static void assertSteps(List<PointerEventSchedule.Step> actual, String... expected) {
    if (actual.size() != expected.length) {
      throw new AssertionError("Expected " + expected.length + " steps, got " + actual.size());
    }
    for (int index = 0; index < expected.length; index += 1) {
      PointerEventSchedule.Step step = actual.get(index);
      String description =
          step.action
              + ":"
              + step.sampleIndex
              + ":"
              + step.pointerCount
              + ":"
              + step.offsetMs;
      if (!expected[index].equals(description)) {
        throw new AssertionError(
            "Step " + index + ": expected " + expected[index] + ", got " + description);
      }
    }
  }
}
