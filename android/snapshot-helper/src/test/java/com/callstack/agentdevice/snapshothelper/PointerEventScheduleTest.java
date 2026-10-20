package com.callstack.agentdevice.snapshothelper;

import java.util.List;

public final class PointerEventScheduleTest {
  private PointerEventScheduleTest() {}

  static void run() {
    assertSteps(
        PointerEventSchedule.create(1, new long[] {0, 16, 32}),
        "DOWN:0:1:0:true",
        "MOVE:1:1:16:true",
        "MOVE:2:1:32:true",
        "UP:2:1:32:true");
    assertSteps(
        PointerEventSchedule.create(1, new long[] {0, 16}),
        "DOWN:0:1:0:true",
        "MOVE:1:1:16:true",
        "UP:1:1:16:true");
    assertSteps(
        PointerEventSchedule.create(2, new long[] {0, 16, 32}),
        "DOWN:0:1:0:true",
        "POINTER_DOWN:0:2:8:true",
        "MOVE:1:2:16:false",
        "MOVE:2:2:32:true",
        "POINTER_UP:2:2:32:true",
        "UP:2:1:40:true");
    // A short two-contact plan keeps its original schedule: the second contact goes down before
    // the first move, and the last contact lifts 8 ms after the second.
    assertSteps(
        PointerEventSchedule.create(2, new long[] {0, 5, 11, 16}),
        "DOWN:0:1:0:true",
        "POINTER_DOWN:0:2:4:true",
        "MOVE:1:2:5:false",
        "MOVE:2:2:11:false",
        "MOVE:3:2:16:true",
        "POINTER_UP:3:2:16:true",
        "UP:3:1:24:true");
    // A five-contact 16 ms tap: every contact is down before the hold ends, 3 ms apart, and the
    // contacts lift in reverse order 8 ms apart, so the changing contact is the highest index.
    assertSteps(
        PointerEventSchedule.create(5, new long[] {0, 16}),
        "DOWN:0:1:0:true",
        "POINTER_DOWN:0:2:3:true",
        "POINTER_DOWN:0:3:6:true",
        "POINTER_DOWN:0:4:9:true",
        "POINTER_DOWN:0:5:12:true",
        "MOVE:1:5:16:true",
        "POINTER_UP:1:5:16:true",
        "POINTER_UP:1:4:24:true",
        "POINTER_UP:1:3:32:true",
        "POINTER_UP:1:2:40:true",
        "UP:1:1:48:true");
    // A three-contact tap with the default 50 ms hold keeps the full 8 ms spacing.
    assertSteps(
        PointerEventSchedule.create(3, new long[] {0, 50}),
        "DOWN:0:1:0:true",
        "POINTER_DOWN:0:2:8:true",
        "POINTER_DOWN:0:3:16:true",
        "MOVE:1:3:50:true",
        "POINTER_UP:1:3:50:true",
        "POINTER_UP:1:2:58:true",
        "UP:1:1:66:true");
    assertRejected(6);
    assertRejected(0);
  }

  private static void assertRejected(int pointerCount) {
    try {
      PointerEventSchedule.create(pointerCount, new long[] {0, 16});
    } catch (IllegalArgumentException expected) {
      return;
    }
    throw new AssertionError("Expected " + pointerCount + " pointers to be rejected");
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
