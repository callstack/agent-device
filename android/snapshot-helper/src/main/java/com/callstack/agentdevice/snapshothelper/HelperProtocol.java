package com.callstack.agentdevice.snapshothelper;

/** Wire-protocol constants shared by the one-shot and persistent-session response paths. */
final class HelperProtocol {
  static final String PROTOCOL = "android-snapshot-helper-v1";
  static final String OUTPUT_FORMAT = "uiautomator-xml";
  static final String HELPER_API_VERSION = "2";

  private HelperProtocol() {}
}
