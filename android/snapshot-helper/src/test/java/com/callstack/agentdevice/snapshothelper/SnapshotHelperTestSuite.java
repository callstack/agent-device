package com.callstack.agentdevice.snapshothelper;

public final class SnapshotHelperTestSuite {
  private SnapshotHelperTestSuite() {}

  public static void main(String[] args) throws Exception {
    PointerEventScheduleTest.run();
    PressSequenceTest.run();
    FillTextEntryTimeTest.run();
    AccessibilityCaptureStabilizerTest.run();
    AccessibilityReadBatchTest.run();
    AccessibilityTreeXmlTest.run();
    BoundedUiAutomationConnectionTest.run();
    SessionPeerPolicyTest.run();
    SessionHandshakeTest.run();
    SessionResponseWriterTest.run();
    SessionFrameWriterTest.run();
    GestureViewportReaderTest.run();
    DisplayExtentTest.run();
    ScreenshotDisplayTest.run();
  }
}
