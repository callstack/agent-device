package com.callstack.agentdevice.snapshothelper;

public final class DisplaySizeReaderTest {
  private DisplaySizeReaderTest() {}

  static void run() {
    assertReportsAUsableDisplayExtent();
    assertRefusesADisplayThatAnsweredWithNoExtent();
  }

  private static void assertReportsAUsableDisplayExtent() {
    DisplaySizeReader.Size portrait = DisplaySizeReader.resolve(1080, 2400);
    assertSize(portrait, 1080, 2400, "portrait phone");

    // The rotation matters: the caller hands in whichever extent the metrics currently carry, and a
    // landscape capture publishes the box its bounds are actually measured in.
    DisplaySizeReader.Size landscape = DisplaySizeReader.resolve(2400, 1080);
    assertSize(landscape, 2400, 1080, "landscape phone");

    // One pixel wide is still a box a rect can be measured in; the gate is zero, not plausibility.
    DisplaySizeReader.Size minimal = DisplaySizeReader.resolve(1, 1);
    assertSize(minimal, 1, 1, "smallest usable display");
  }

  private static void assertRefusesADisplayThatAnsweredWithNoExtent() {
    // A refused read is what the host reads as "unknown". Answering 0 instead would tell a consumer
    // this screen has no width, which is a claim no producer ever measured.
    assertNull(DisplaySizeReader.resolve(0, 2400), "zero width");
    assertNull(DisplaySizeReader.resolve(1080, 0), "zero height");
    assertNull(DisplaySizeReader.resolve(0, 0), "both dimensions zero");
    assertNull(DisplaySizeReader.resolve(-1, 2400), "negative width");
    assertNull(DisplaySizeReader.resolve(1080, -1), "negative height");
  }

  private static void assertSize(DisplaySizeReader.Size size, int width, int height, String label) {
    if (size == null) {
      throw new AssertionError("expected a size for " + label);
    }
    if (size.width != width || size.height != height) {
      throw new AssertionError(
          "wrong size for " + label + ": got " + size.width + "x" + size.height);
    }
  }

  private static void assertNull(DisplaySizeReader.Size size, String label) {
    if (size != null) {
      throw new AssertionError("expected no size for " + label + " but got " + size.width + "x" + size.height);
    }
  }
}
