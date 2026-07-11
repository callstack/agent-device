package com.callstack.agentdevice.multitouchhelper;

public final class TwoPointerGeometryTest {
  private TwoPointerGeometryTest() {}

  public static void main(String[] args) {
    float[][] points = TwoPointerGeometry.pointsAt(300.0d, 400.0d, 60.0d, 0.0d);

    assertNear(300.0f, points[0][0], "first x");
    assertNear(300.0f, points[0][1], "second x");
    assertNear(340.0f, points[1][0], "first y");
    assertNear(460.0f, points[1][1], "second y");
  }

  private static void assertNear(float expected, float actual, String label) {
    if (Math.abs(expected - actual) > 0.001f) {
      throw new AssertionError(label + ": expected " + expected + ", got " + actual);
    }
  }
}
