import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  // Pins the record(_:) suppression class via its pure classifier. record(_:) itself is not
  // invoked here: feeding it the must-record variants would record real failures and fail
  // this very test run.
  func testSuppressedAxSnapshotIssueClassifier() {
    // AX-server rejections inside a matching-snapshot fetch are muted...
    XCTAssertTrue(
      Self.isSuppressedAxSnapshotIssueDescription(
        "Failed to get matching snapshot: Error kAXErrorIllegalArgument getting snapshot for element <AXUIElementRef 0x600000fd9a40> {pid=33837}"
      )
    )
    // ...including sibling AX server codes.
    XCTAssertTrue(
      Self.isSuppressedAxSnapshotIssueDescription(
        "Failed to get matching snapshot: Error kAXErrorCannotComplete getting snapshot for element"
      )
    )
    // The hung-query timeout variant must keep recording.
    XCTAssertFalse(
      Self.isSuppressedAxSnapshotIssueDescription(
        "Failed to get matching snapshot: Timed out while evaluating UI query."
      )
    )
    // Unrelated issues must keep recording.
    XCTAssertFalse(
      Self.isSuppressedAxSnapshotIssueDescription(
        "XCTAssertEqual failed: (\"1\") is not equal to (\"2\")"
      )
    )
    // A kAXError outside the matching-snapshot fetch context is not this class.
    XCTAssertFalse(
      Self.isSuppressedAxSnapshotIssueDescription(
        "Error kAXErrorIllegalArgument while performing scroll"
      )
    )
  }
}
#endif
