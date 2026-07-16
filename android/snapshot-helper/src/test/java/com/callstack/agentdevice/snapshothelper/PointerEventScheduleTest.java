package com.callstack.agentdevice.snapshothelper;

import java.util.List;

public final class PointerEventScheduleTest {
  private PointerEventScheduleTest() {}

  public static void main(String[] args) {
    assertSteps(
        PointerEventSchedule.create(1, new long[] {0, 16, 32}),
        "DOWN:0:1:0:true",
        "MOVE:1:1:16:true",
        "MOVE:2:1:32:true",
        "UP:2:1:32:true");
    assertSteps(
        PointerEventSchedule.create(2, new long[] {0, 16, 32}),
        "DOWN:0:1:0:true",
        "POINTER_DOWN:0:2:8:true",
        "MOVE:1:2:16:false",
        "MOVE:2:2:32:true",
        "POINTER_UP:2:2:32:true",
        "UP:2:1:40:true");
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
              + step.offsetMs
              + ":"
              + step.waitForDispatch;
      if (!expected[index].equals(description)) {
        throw new AssertionError(
            "Step " + index + ": expected " + expected[index] + ", got " + description);
      }
    }
  }
}
