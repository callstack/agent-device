import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  @MainActor
  func testPasteboardWriteRefusesARequestWithoutText() throws {
    let response = executePasteboardWrite(command: try runnerCommandFixture(#"{"command":"pasteboardWrite"}"#))
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "INVALID_ARGS")
  }

#if os(iOS) || os(visionOS)
  @MainActor
  func testPasteboardWriteLeavesTheTextOnTheGeneralPasteboard() throws {
    let text = "one-time code \(UUID().uuidString)"
    defer { UIPasteboard.general.items = [] }
    let request = #"{"command":"pasteboardWrite","text":"\#(text)"}"#
    let response = executePasteboardWrite(command: try runnerCommandFixture(request))
    XCTAssertTrue(response.ok)
    XCTAssertEqual(UIPasteboard.general.string, text)
  }
#else
  @MainActor
  func testPasteboardWriteIsUnsupportedWithoutAUIKitPasteboard() throws {
    let request = #"{"command":"pasteboardWrite","text":"code"}"#
    let response = executePasteboardWrite(command: try runnerCommandFixture(request))
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "UNSUPPORTED_OPERATION")
  }
#endif
}
#endif
