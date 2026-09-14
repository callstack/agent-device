package com.callstack.agentdevice.snapshothelper;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public final class GestureViewportReaderTest {
  private GestureViewportReaderTest() {}

  private static final GestureViewportReader.WindowEdges APPLICATION =
      new GestureViewportReader.WindowEdges(0, 0, 1080, 2400);
  private static final GestureViewportReader.WindowEdges KEY_PLANE =
      new GestureViewportReader.WindowEdges(0, 1517, 1080, 2400);
  private static final GestureViewportReader.WindowEdges COMPOSER =
      new GestureViewportReader.WindowEdges(0, 1400, 1080, 1517);
  private static final GestureViewportReader.WindowEdges SIDE_STRIP =
      new GestureViewportReader.WindowEdges(900, 1200, 1080, 2400);

  static void run() {
    assertNoInputMethodOnScreen();
    assertComposerAboveItsKeyPlaneKeepsItsEarlierTopEdge();
    assertWindowBesideTheSwipePathIsIgnored();
  }

  private static void assertNoInputMethodOnScreen() {
    assertEdges(
        GestureViewportReader.struckInputMethod(
            Collections.<GestureViewportReader.WindowEdges>emptyList(), APPLICATION),
        null,
        "no input method window on screen");
  }

  private static void assertComposerAboveItsKeyPlaneKeepsItsEarlierTopEdge() {
    List<GestureViewportReader.WindowEdges> both = Arrays.asList(KEY_PLANE, COMPOSER);
    // The key plane is the larger rectangle. Keeping only it would plan a swipe ending inside the
    // composer, whose top edge reaches 117px further up the screen.
    assertEdges(
        GestureViewportReader.struckInputMethod(both, APPLICATION),
        new GestureViewportReader.WindowEdges(0, 1400, 1080, 2400),
        "composer above its key plane");
    assertEdges(
        GestureViewportReader.struckInputMethod(Arrays.asList(COMPOSER, KEY_PLANE), APPLICATION),
        new GestureViewportReader.WindowEdges(0, 1400, 1080, 2400),
        "composer listed after its key plane");
  }

  private static void assertWindowBesideTheSwipePathIsIgnored() {
    // A floating candidate strip at the right edge never crosses the centre line a vertical swipe
    // travels, so its higher top edge must not shorten the band.
    assertEdges(
        GestureViewportReader.struckInputMethod(Arrays.asList(KEY_PLANE, SIDE_STRIP), APPLICATION),
        KEY_PLANE,
        "input method window beside the swipe path");
    assertEdges(
        GestureViewportReader.struckInputMethod(
            Collections.singletonList(SIDE_STRIP), APPLICATION),
        null,
        "only an unreachable input method window on screen");
  }

  private static void assertEdges(
      GestureViewportReader.WindowEdges actual,
      GestureViewportReader.WindowEdges expected,
      String label) {
    if (expected == null) {
      if (actual != null) {
        throw new AssertionError(
            "Expected no input method rect for " + label + ", got " + describe(actual));
      }
      return;
    }
    if (actual == null) {
      throw new AssertionError("Expected " + describe(expected) + " for " + label + ", got none");
    }
    if (actual.left != expected.left
        || actual.top != expected.top
        || actual.right != expected.right
        || actual.bottom != expected.bottom) {
      throw new AssertionError(
          "Expected " + describe(expected) + " for " + label + ", got " + describe(actual));
    }
  }

  private static String describe(GestureViewportReader.WindowEdges edges) {
    return "[" + edges.left + "," + edges.top + "][" + edges.right + "," + edges.bottom + "]";
  }
}
