package com.callstack.agentdevice.snapshothelper;

public final class SnapshotHelperTestSuite {
  private SnapshotHelperTestSuite() {}

  public static void main(String[] args) throws Exception {
    PointerEventScheduleTest.run();
    AccessibilityCaptureStabilizerTest.run();
    AccessibilityReadBatchTest.run();
    BoundedUiAutomationConnectionTest.run();
    GestureViewportReaderTest.run();
    DisplayExtentTest.run();
  }
}
