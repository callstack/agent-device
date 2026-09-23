import Foundation
import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct AlertCommandTraitsFixture: Decodable {
  let name: String
  let command: Command
  let readOnly: Bool
}

extension RunnerTests {
  func testAlertReadOnlyClassificationMatchesGoldenTable() throws {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("contracts/fixtures/alert-command-traits.json")
    let cases = try JSONDecoder().decode(
      [AlertCommandTraitsFixture].self,
      from: Data(contentsOf: fixtureURL)
    )
    XCTAssertEqual(cases.map { $0.command.action }, [nil, "get", "accept", "dismiss"])
    for fixture in cases {
      XCTAssertEqual(isReadOnlyCommand(fixture.command), fixture.readOnly, fixture.name)
    }
  }

  func testTargetAppUnavailableResponseIsRetried() {
    for bundleId in ["com.example.app", nil] as [String?] {
      let response = Response(ok: false, error: .targetAppUnavailable(bundleId: bundleId))
      XCTAssertTrue(shouldRetryResponse(response), String(describing: bundleId))
    }
    let reworded = ErrorPayload(message: "target vanished", retryableFailure: .targetAppUnavailable)
    XCTAssertTrue(shouldRetryResponse(Response(ok: false, error: reworded)))
  }

  func testUntypedUnavailableMessageIsNotRetried() {
    for message in ["app 'com.example.app' is not available", "runner app is not available"] {
      let response = Response(ok: false, error: ErrorPayload(message: message))
      XCTAssertFalse(shouldRetryResponse(response), message)
    }
    let succeeded = Response(ok: true, error: .targetAppUnavailable(bundleId: nil))
    XCTAssertFalse(shouldRetryResponse(succeeded))
  }

  func testExceptionRetryIsLimitedToTheAxServerNotFoundReadOnlyCase() throws {
    let readText = try runnerCommandFixture(#"{"command":"readText"}"#)
    let snapshot = try runnerCommandFixture(#"{"command":"snapshot"}"#)
    let tap = try runnerCommandFixture(#"{"command":"tap"}"#)
    let axServerNotFound = "NSException: Error kAXErrorServerNotFound"
    XCTAssertTrue(shouldRetryException(readText, message: axServerNotFound))
    XCTAssertFalse(shouldRetryException(tap, message: axServerNotFound))
    XCTAssertFalse(
      shouldRetryException(readText, message: "NSException: main thread execution timed out")
    )
    XCTAssertFalse(shouldRetryException(snapshot, message: "NSException: query timed out"))
  }

  func testInlineScreenshotResponseKeepsDisplayFactsBesideTheImage() throws {
    let pngData = Data([0x89, 0x50, 0x4E, 0x47])
    let response = screenshotResponse(
      pngData: pngData,
      inlineScreenshot: true,
      metadata: ScreenshotMetadataPayload(
        displayID: 3,
        pixelWidth: 2852,
        pixelHeight: 2006,
        pixelsPerPoint: 3
      )
    )
    XCTAssertTrue(response.ok)
    XCTAssertEqual(response.data?.imageBase64, pngData.base64EncodedString())
    XCTAssertEqual(response.data?.screenshotMetadata?.displayID, 3)
    XCTAssertNil(response.data?.message, "an inline answer must not also name a file")
  }

  func testFileScreenshotResponseWritesTheImageAndStillReportsItsDisplay() throws {
    let pngData = Data([0x89, 0x50, 0x4E, 0x47])
    let response = screenshotResponse(
      pngData: pngData,
      inlineScreenshot: false,
      metadata: ScreenshotMetadataPayload(
        displayID: 1,
        pixelWidth: 1398,
        pixelHeight: 2034,
        pixelsPerPoint: 3
      )
    )
    XCTAssertTrue(response.ok)
    XCTAssertNil(response.data?.imageBase64, "a file answer must not also carry bytes")
    let message = try XCTUnwrap(response.data?.message)
    // The answer names the file rather than carrying bytes, and the name is a host-resolvable form:
    // absolute on macOS, container-relative `tmp/…` on iOS. Both name the one file just written
    // into the runner's temporary directory.
    let fileName = URL(fileURLWithPath: message).lastPathComponent
    XCTAssertTrue(message.hasSuffix(fileName), message)
    let storedPath = (NSTemporaryDirectory() as NSString).appendingPathComponent(fileName)
    XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: storedPath)), pngData)
    XCTAssertEqual(response.data?.screenshotMetadata?.pixelsPerPoint, 3)
    try? FileManager.default.removeItem(atPath: storedPath)
  }
}
#endif
