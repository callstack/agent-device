package com.callstack.agentdevice.snapshothelper;

public final class AccessibilityTreeXmlTest {
  private AccessibilityTreeXmlTest() {}

  static void run() {
    assertBounds("bounds", -40, 0, 1080, 2400, " bounds=\"[-40,0][1080,2400]\"");
    assertBounds(
        "window-bounds", Integer.MIN_VALUE, -1, 0, Integer.MAX_VALUE,
        " window-bounds=\"[-2147483648,-1][0,2147483647]\"");
  }

  private static void assertBounds(
      String name, int left, int top, int right, int bottom, String expected) {
    StringBuilder xml = new StringBuilder();
    AccessibilityTreeXml.appendBoundsAttribute(xml, name, left, top, right, bottom);
    if (!expected.equals(xml.toString())) {
      throw new AssertionError("Expected " + expected + ", got " + xml);
    }
  }
}
