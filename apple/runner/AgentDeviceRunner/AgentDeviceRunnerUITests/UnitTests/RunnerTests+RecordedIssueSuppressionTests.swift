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
    // ...and the query-resolution fetch the query-sweep tier records once per element type. On
    // the Bluesky feed 19 of these per capture ended the runner after every hostile snapshot.
    XCTAssertTrue(
      Self.isSuppressedAxSnapshotIssueDescription(
        "Failed to resolve query: Error kAXErrorIllegalArgument getting snapshot for element <AXUIElementRef 0x600001060090> {pid=34802} {uid=[ID:1 hash:0x0]}"
      )
    )
    // The hung-query timeout variant must keep recording, in either fetch context.
    XCTAssertFalse(
      Self.isSuppressedAxSnapshotIssueDescription(
        "Failed to get matching snapshot: Timed out while evaluating UI query."
      )
    )
    XCTAssertFalse(
      Self.isSuppressedAxSnapshotIssueDescription(
        "Failed to resolve query: Timed out while evaluating UI query."
      )
    )
    // A target that is gone is not an AX-server rejection and must keep recording.
    XCTAssertFalse(
      Self.isSuppressedAxSnapshotIssueDescription(
        "Failed to resolve query: Application xyz.blueskyweb.app is not running"
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
