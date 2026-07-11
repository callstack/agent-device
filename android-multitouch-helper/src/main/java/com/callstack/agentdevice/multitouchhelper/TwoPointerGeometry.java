package com.callstack.agentdevice.multitouchhelper;

final class TwoPointerGeometry {
  private static final double INITIAL_ANGLE_DEGREES = -90.0d;

  private TwoPointerGeometry() {}

  static float[][] pointsAt(
      double centerX, double centerY, double radius, double rotationDegrees) {
    double angle = Math.toRadians(INITIAL_ANGLE_DEGREES + rotationDegrees);
    return new float[][] {
      {
        (float) (centerX + Math.cos(angle) * radius),
        (float) (centerX - Math.cos(angle) * radius)
      },
      {
        (float) (centerY + Math.sin(angle) * radius),
        (float) (centerY - Math.sin(angle) * radius)
      }
    };
  }
}
