package com.callstack.agentdevice.snapshothelper;

public final class ScreenshotDisplayTest {
  private ScreenshotDisplayTest() {}

  static void run() {
    assertRotation(ScreenshotDisplay.whenBothAgree(1, 1), 1, "both reads of one landscape display");
    assertRotation(ScreenshotDisplay.whenBothAgree(0, 0), 0, "both reads of one portrait display");
    // A rotation landing inside the capture would pair one rotation with the other's pixels.
    assertRotation(
        ScreenshotDisplay.whenBothAgree(0, 1), ScreenshotDisplay.UNKNOWN, "display turned mid-capture");
    assertRotation(
        ScreenshotDisplay.whenBothAgree(ScreenshotDisplay.UNKNOWN, 0),
        ScreenshotDisplay.UNKNOWN,
        "read before the capture failed");
    assertRotation(
        ScreenshotDisplay.whenBothAgree(0, ScreenshotDisplay.UNKNOWN),
        ScreenshotDisplay.UNKNOWN,
        "read after the capture failed");
  }

  private static void assertRotation(int actual, int expected, String label) {
    if (actual != expected) {
      throw new AssertionError(
          "wrong rotation for " + label + ": expected " + expected + " but got " + actual);
    }
  }
}
