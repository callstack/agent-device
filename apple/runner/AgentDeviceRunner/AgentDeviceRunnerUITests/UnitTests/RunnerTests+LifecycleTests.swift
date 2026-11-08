import Foundation
import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
/// One row of the cross-language golden table. Its `query` column names the shared fact — this alert
/// request changes nothing — which each side maps to its own consumer: replay eligibility here, and
/// the TypeScript `readOnly` trait there.
private struct AlertCommandTraitsFixture: Decodable {
  let name: String
  let command: Command
  let query: Bool
}

extension RunnerTests {
#if os(iOS)
  /// A frame sample resolves the lit panel without booking it, so it never replaces the request's booking.
  @MainActor
  func testFrameSamplingResolvesTheLitPanelWithoutBookingIt() throws {
    try withLitPanelWindow(frame: CGRect(x: 0, y: 0, width: 669, height: 951)) { _ in
      setRequestLitPanel(from: try runnerCommandFixture(#"{"command":"snapshot","litPanel":{"displayId":3,"widthPt":669,"heightPt":951}}"#))
      _ = captureRunnerFrame(app: app)
      XCTAssertNil(litPanelState.surface)
    }
  }
#endif

  func testAlertRetryFactMatchesTheSharedGoldenTable() throws {
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
      XCTAssertEqual(
        fixture.command.traits.retryOnSessionLoss,
        fixture.query,
        fixture.name
      )
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
    // into the runner's data container on iOS, regardless of the host's TMPDIR.
    let fileName = URL(fileURLWithPath: message).lastPathComponent
    XCTAssertTrue(message.hasSuffix(fileName), message)
#if os(iOS)
    XCTAssertTrue(message.hasPrefix("tmp/"), message)
#elseif os(macOS)
    XCTAssertTrue(message.hasPrefix("/"), message)
#endif
#if os(iOS)
    let storedPath = (NSHomeDirectory() as NSString).appendingPathComponent(message)
#else
    let storedPath = (NSTemporaryDirectory() as NSString).appendingPathComponent(fileName)
#endif
    XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: storedPath)), pngData)
    XCTAssertEqual(response.data?.screenshotMetadata?.pixelsPerPoint, 3)
    try? FileManager.default.removeItem(atPath: storedPath)
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(macOS)
extension RunnerTests {
  /// Pins every state the macOS screenshot raise condition reads (#3254), together with the read
  /// arm's answer for the same state, so one table owns the pair. Both predicates run their real
  /// bodies: a drifted condition on either side lands as a red row rather than a silent behavior
  /// change. The rows encode the two platform facts the split rests on: the macOS SDK declares no
  /// suspended state (see `RunnerTests+ApplicationStateRawValueTests`), so these two predicates
  /// cannot disagree on it here, and every state that is not `.runningBackground` keeps its
  /// activating route for reads — which for a capture is also where the raise lives. The one
  /// deliberate divergence is background itself: a read is served in place because the tree answers
  /// from anywhere, while a window-level capture raises because its pixels are a region grab that
  /// the occluding app spoils (#3254's measurement). Full-screen captures raise only a stopped app,
  /// where the activation is the launch it has always performed.
  func testMacBackgroundServingAndCaptureRaiseConditionsArePinnedPerState() throws {
    let read = try runnerCommandFixture(#"{"command":"snapshot","commandId":"table","appBundleId":"com.example.any"}"#)
    let noBundle = try runnerCommandFixture(#"{"command":"snapshot","commandId":"table"}"#)
    let states: [(state: XCUIApplication.State, expected: Bool)] = [
      (.unknown, false),
      (.notRunning, false),
      (.runningBackground, true),
      (.runningForeground, false),
    ]
    let foreground = XCUIApplication.State.runningForeground
    let unknown = XCUIApplication.State.unknown
    let notRunning = XCUIApplication.State.notRunning
    let raiseRows: [(fullscreen: Bool?, state: XCUIApplication.State, expected: Bool)] = [
      (nil, foreground, false),
      (nil, .runningBackground, true),
      (nil, unknown, true),
      (nil, notRunning, true),
      (false, foreground, false),
      (false, .runningBackground, true),
      (false, unknown, true),
      (false, notRunning, true),
      (true, foreground, false),
      (true, .runningBackground, false),
      (true, unknown, false),
      (true, notRunning, true),
    ]
    for row in states {
      XCTAssertEqual(
        macReadMayBeServedInBackground(command: read, targetState: row.state),
        row.expected,
        "read state=\(row.state.rawValue)"
      )
    }
    XCTAssertFalse(
      macReadMayBeServedInBackground(command: noBundle, targetState: .runningBackground),
      "a read naming no app has no session app to serve in place"
    )
    for row in raiseRows {
      XCTAssertEqual(
        macAppCaptureNeedsRaise(fullscreen: row.fullscreen, targetState: row.state),
        row.expected,
        "capture fullscreen=\(String(describing: row.fullscreen)) state=\(row.state.rawValue)"
      )
    }
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  @MainActor
  func testResettingTargetBoundStateForgetsTheLastWrittenMarkers() {
    defer { invalidateCachedTarget(reason: "unit_test_cleanup") }
    lastLoggedFastAppGuardLine = "AGENT_DEVICE_RUNNER_FAST_APP_GUARD bundle=app state=4"
    lastLoggedGesturePolicyLines[.scroll] = "AGENT_DEVICE_RUNNER_SYNTHESIZED_GESTURE_POLICY kind=scroll"
    resetTargetBoundState()
    XCTAssertNil(lastLoggedFastAppGuardLine, "a rebind must state the guard once more")
    XCTAssertTrue(lastLoggedGesturePolicyLines.isEmpty, "a rebind must state the policy once more")
  }

  @MainActor
  func testFastAppGuardMarkerWritesOnceUntilTheFactChanges() {
    var written: [String] = []
    runnerMarkerWriter = { written.append($0) }
    defer {
      runnerMarkerWriter = { NSLog("%@", $0) }
      invalidateCachedTarget(reason: "unit_test_cleanup")
    }
    writeFastAppGuardMarker(bundleId: "com.example.app", state: .runningForeground)
    writeFastAppGuardMarker(bundleId: "com.example.app", state: .runningForeground)
    XCTAssertEqual(written.count, 1, "a repeated fact writes no second line")
    writeFastAppGuardMarker(bundleId: "com.example.other", state: .runningForeground)
    XCTAssertEqual(written.count, 2, "a changed fact writes a new line")
    resetTargetBoundState()
    writeFastAppGuardMarker(bundleId: "com.example.other", state: .runningForeground)
    XCTAssertEqual(written.count, 3, "a rebind states the same fact once more")
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
extension RunnerTests {
  /// Installed on every Simulator runtime and cheap to leave terminated.
  private static let notRunningTargetBundleId = "com.apple.Preferences"

  @MainActor
  private func executeOnTerminatedTarget(_ json: String) throws -> (Response, XCUIApplication) {
    let target = XCUIApplication(bundleIdentifier: Self.notRunningTargetBundleId)
    target.terminate()
    invalidateCachedTarget(reason: "unit_test_setup")
    defer { invalidateCachedTarget(reason: "unit_test_cleanup") }
    return (try execute(command: try runnerCommandFixture(json)), target)
  }

  /// Covers a user-level read, a mutation's leading read (a gesture's `gestureViewport`), and the read
  /// that resolves a selector tap (`querySelector`, whose refusal the retry fact alone used to decide,
  /// #2890).
  @MainActor
  func testReadRefusesToLaunchANotRunningSessionApp() throws {
    let bundleId = Self.notRunningTargetBundleId
    for request in [
      #"{"command":"snapshot","commandId":"read","appBundleId":"\#(bundleId)"}"#,
      #"{"command":"gestureViewport","commandId":"read","appBundleId":"\#(bundleId)"}"#,
      #"{"command":"querySelector","selectorKey":"label","selectorValue":"Settings","commandId":"read","appBundleId":"\#(bundleId)"}"#
    ] {
      let (response, target) = try executeOnTerminatedTarget(request)
      XCTAssertEqual(response.error?.code, RunnerWireErrorCode.appNotRunning, request)
      XCTAssertEqual(target.state, .notRunning, "\(request) must not launch the session app")
      target.terminate()
    }
  }

  @MainActor
  func testNonReadCommandStillLaunchesANotRunningSessionApp() throws {
    let (response, target) = try executeOnTerminatedTarget(
      #"{"command":"activate","commandId":"repair","appBundleId":"\#(Self.notRunningTargetBundleId)"}"#
    )
    defer { target.terminate() }
    XCTAssertTrue(response.ok)
    XCTAssertNotEqual(target.state, .notRunning)
  }
}
#endif
