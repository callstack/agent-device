package com.callstack.agentdevice.snapshothelper;

public final class DisplayExtentTest {
  private DisplayExtentTest() {}

  private static final DisplayExtent.Extent PORTRAIT = new DisplayExtent.Extent(1080, 2400);
  private static final DisplayExtent.Extent LANDSCAPE = new DisplayExtent.Extent(2400, 1080);

  static void run() {
    assertTwoReadsOfTheSameDisplayPublishItsExtent();
    assertADisplayThatMovedUnderTheDumpPublishesNothing();
    assertAReadThatFailedPublishesNothing();
  }

  private static void assertTwoReadsOfTheSameDisplayPublishItsExtent() {
    // The rotation matters: a landscape capture publishes the box its bounds are actually measured
    // in, which is why the extent is read per capture rather than kept across a helper session.
    assertExtent(
        DisplayExtent.whenBothAgree(PORTRAIT, new DisplayExtent.Extent(1080, 2400)),
        1080,
        2400,
        "both reads of one portrait display");
    assertExtent(
        DisplayExtent.whenBothAgree(LANDSCAPE, LANDSCAPE),
        2400,
        1080,
        "both reads of one landscape display");
  }

  private static void assertADisplayThatMovedUnderTheDumpPublishesNothing() {
    // A rotation landing inside the tree dump would pair that rotation's node bounds with the other
    // rotation's dimensions. The capture then names no box at all rather than a wrong one (#3182).
    assertNull(
        DisplayExtent.whenBothAgree(PORTRAIT, LANDSCAPE), "display rotated mid-dump");
    assertNull(
        DisplayExtent.whenBothAgree(
            PORTRAIT, new DisplayExtent.Extent(1076, 2400)),
        "display resized mid-dump");
  }

  private static void assertAReadThatFailedPublishesNothing() {
    // A read that failed on either side of the dump leaves the box unknown: the surviving read says
    // nothing about what the tree between the two was measured against.
    assertNull(DisplayExtent.whenBothAgree(null, PORTRAIT), "read before the dump failed");
    assertNull(DisplayExtent.whenBothAgree(PORTRAIT, null), "read after the dump failed");
    assertNull(DisplayExtent.whenBothAgree(null, null), "both reads failed");
  }

  private static void assertExtent(
      DisplayExtent.Extent extent, int width, int height, String label) {
    if (extent == null) {
      throw new AssertionError("expected an extent for " + label);
    }
    if (extent.width != width || extent.height != height) {
      throw new AssertionError(
          "wrong extent for " + label + ": got " + extent.width + "x" + extent.height);
    }
  }

  private static void assertNull(DisplayExtent.Extent extent, String label) {
    if (extent != null) {
      throw new AssertionError(
          "expected no extent for " + label + " but got " + extent.width + "x" + extent.height);
    }
  }
}
