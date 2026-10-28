import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
#if os(iOS)
  @MainActor
  func testCapturedKeyboardBandIncludesTheInputAssistantOutsideTheKeyboard() {
    let keyboard = ElementAttributesFixture(.keyboard, CGRect(x: 0, y: 600, width: 390, height: 244))
    let assistant = ElementAttributesFixture(
      .other, CGRect(x: 0, y: 556, width: 390, height: 44), identifier: "SystemInputAssistantView"
    )
    let window = ElementAttributesFixture(.window, CGRect(x: 0, y: 0, width: 390, height: 844), children: [assistant, keyboard])
    let root = ElementAttributesFixture(.application, window.frame, children: [window])

    XCTAssertEqual(
      captureKeyboardBandFact(snapshot: root, viewport: .reported(box: window.frame), deadline: .distantFuture),
      .visible(CGRect(x: 0, y: 556, width: 390, height: 288))
    )
  }

  @MainActor
  func testCapturedKeyboardBandNormalizesKeyboardAndAssistantBeforeCombiningThem() {
    let viewport = CGRect(x: 0, y: 0, width: 874, height: 402)
    let native = CGRect(x: 0, y: 0, width: 402, height: 874)
    let keyboard = ElementAttributesFixture(.keyboard, CGRect(x: 2, y: 75, width: 202, height: 724))
    let keyboardHost = ElementAttributesFixture(.other, native, children: [keyboard])
    let keyboardWindow = ElementAttributesFixture(.window, native, children: [keyboardHost])
    let assistant = ElementAttributesFixture(
      .other, CGRect(x: 75, y: 154, width: 724, height: 44), identifier: "SystemInputAssistantView"
    )
    let assistantHost = ElementAttributesFixture(.other, viewport, children: [assistant])
    let assistantWindow = ElementAttributesFixture(.window, viewport, children: [assistantHost])
    let root = ElementAttributesFixture(.application, viewport, children: [keyboardWindow, assistantWindow])

    XCTAssertEqual(
      captureKeyboardBandFact(
        snapshot: root,
        viewport: .reported(box: viewport, interfaceOrientation: RunnerInterfaceOrientation.landscapeRight),
        deadline: .distantFuture
      ),
      .visible(CGRect(x: 75, y: 154, width: 724, height: 246))
    )
  }

  @MainActor
  func testCapturedKeyboardBandRejectsInvalidNativeGeometryBeforeRotation() {
    let viewport = CGRect(x: 0, y: 0, width: 874, height: 402)
    let native = CGRect(x: 0, y: 0, width: 402, height: 874)
    let invalid = CGRect(x: 2, y: 75, width: -202, height: 724)
    let badKeyboard = ElementAttributesFixture(.keyboard, invalid)
    let host = ElementAttributesFixture(.other, native, children: [badKeyboard])
    let window = ElementAttributesFixture(.window, native, children: [host])
    let root = ElementAttributesFixture(.application, viewport, children: [window])
    let reported = SnapshotViewport.reported(box: viewport, interfaceOrientation: RunnerInterfaceOrientation.landscapeRight)
    XCTAssertEqual(
      captureKeyboardBandFact(snapshot: root, viewport: reported, deadline: .distantFuture),
      .unmeasurable(RunnerKeyboardBandReason.unusableFrame)
    )

    let keyboard = ElementAttributesFixture(.keyboard, CGRect(x: 2, y: 75, width: 202, height: 724))
    let badAssistant = ElementAttributesFixture(.other, invalid, identifier: "SystemInputAssistantView")
    let validHost = ElementAttributesFixture(.other, native, children: [keyboard, badAssistant])
    let validWindow = ElementAttributesFixture(.window, native, children: [validHost])
    let validRoot = ElementAttributesFixture(.application, viewport, children: [validWindow])
    XCTAssertEqual(
      captureKeyboardBandFact(snapshot: validRoot, viewport: reported, deadline: .distantFuture),
      .visible(CGRect(x: 75, y: 198, width: 724, height: 202))
    )
  }

  @MainActor
  func testCapturedKeyboardBandRequiresAKeyboardAndPreservesGeometryValidation() {
    let frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    let assistant = ElementAttributesFixture(
      .other, CGRect(x: 0, y: 556, width: 390, height: 44), identifier: "SystemInputAssistantView"
    )
    XCTAssertEqual(
      captureKeyboardBandFact(snapshot: ElementAttributesFixture(.application, frame, children: [assistant]), viewport: .reported(box: frame), deadline: .distantFuture),
      .absent
    )
    let keyboard = ElementAttributesFixture(.keyboard, CGRect(x: 0, y: 600, width: 390, height: 244))
    let unrelated = ElementAttributesFixture(.button, CGRect(x: 0, y: 100, width: 390, height: 44), identifier: "SystemInputAssistantView")
    XCTAssertEqual(
      captureKeyboardBandFact(snapshot: ElementAttributesFixture(.application, frame, children: [unrelated, keyboard]), viewport: .reported(box: frame), deadline: .distantFuture),
      .visible(keyboard.frame)
    )
    let invalid = ElementAttributesFixture(.keyboard, .zero)
    XCTAssertEqual(
      captureKeyboardBandFact(snapshot: ElementAttributesFixture(.application, frame, children: [invalid]), viewport: .reported(box: frame), deadline: .distantFuture),
      .unmeasurable(RunnerKeyboardBandReason.unusableFrame)
    )
    XCTAssertEqual(
      captureKeyboardBandFact(snapshot: ElementAttributesFixture(.application, frame, children: [invalid, assistant]), viewport: .reported(box: frame), deadline: .distantFuture),
      .unmeasurable(RunnerKeyboardBandReason.unusableFrame)
    )
  }

  @MainActor
  func testCapturedKeyboardBandIgnoresStaleKeyboardFramesWhenAnotherWindowIsUsable() {
    let viewport = CGRect(x: 0, y: 0, width: 390, height: 844)
    let frame = CGRect(x: 0, y: 600, width: 390, height: 244)
    let usable = ElementAttributesFixture(.window, viewport, children: [ElementAttributesFixture(.keyboard, frame)])
    let stale = ElementAttributesFixture(.window, viewport, children: [ElementAttributesFixture(.keyboard, .zero)])
    for windows in [[usable, stale], [stale, usable]] {
      let root = ElementAttributesFixture(.application, viewport, children: windows)
      XCTAssertEqual(
        captureKeyboardBandFact(snapshot: root, viewport: .reported(box: viewport), deadline: .distantFuture),
        .visible(frame)
      )
    }
  }

  @MainActor
  func testCapturedKeyboardBandUnionsUsableKeyboardFramesAcrossWindows() {
    let viewport = CGRect(x: 0, y: 0, width: 390, height: 844)
    let windows = [CGRect(x: 0, y: 600, width: 195, height: 244), CGRect(x: 195, y: 580, width: 195, height: 264)]
      .map { ElementAttributesFixture(.window, viewport, children: [ElementAttributesFixture(.keyboard, $0)]) }
    let root = ElementAttributesFixture(.application, viewport, children: windows)
    XCTAssertEqual(
      captureKeyboardBandFact(snapshot: root, viewport: .reported(box: viewport), deadline: .distantFuture),
      .visible(CGRect(x: 0, y: 580, width: 390, height: 264))
    )
  }

#endif

  func testKeyboardBandFactPublishesAbsenceWhenTheCompleteCaptureHasNoKeyboard() {
    let fact = runnerKeyboardBandFact(exists: false, frame: .zero)
    XCTAssertEqual(fact, .absent)
    XCTAssertEqual(fact.payload.kind, "absent")
    XCTAssertNil(fact.payload.frame)
    XCTAssertNil(fact.payload.reason)
  }

  func testKeyboardBandFactPublishesTheMeasuredBandInAppOrientationSpace() {
    // The landscape band measured on iPhone 17 Pro (iOS 26.2) after #2653: full width across the
    // bottom of a 402 pt-tall app, which is what the tree reported as a strip down the left edge.
    let frame = CGRect(x: 0, y: 198, width: 874, height: 204)
    let fact = runnerKeyboardBandFact(exists: true, frame: frame)
    XCTAssertEqual(fact, .visible(frame))
    let payload = fact.payload
    XCTAssertEqual(payload.kind, "visible")
    XCTAssertEqual(payload.frame, SnapshotRect(x: 0, y: 198, width: 874, height: 204))
    XCTAssertNil(payload.reason)
  }

  func testKeyboardBandFactRefusesUnusableGeometryInsteadOfClaimingAbsence() {
    let nan = CGFloat(Double.nan)
    let infinite = CGFloat.infinity
    let unusable: [CGRect] = [
      .zero,
      .infinite,
      CGRect(x: CGFloat.greatestFiniteMagnitude, y: 198, width: CGFloat.greatestFiniteMagnitude, height: 204),
      CGRect(x: 0, y: 198, width: 0, height: 204),
      CGRect(x: 0, y: 198, width: 874, height: -1),
      CGRect(x: 0, y: 198, width: -874, height: 204),
      CGRect(x: 0, y: nan, width: 874, height: 204),
      CGRect(x: 0, y: 198, width: nan, height: 204),
      CGRect(x: infinite, y: 198, width: 874, height: 204)
    ]
    for frame in unusable {
      let fact = runnerKeyboardBandFact(exists: true, frame: frame)
      XCTAssertEqual(
        fact,
        .unmeasurable(RunnerKeyboardBandReason.unusableFrame),
        "expected \(frame) to be refused as a band"
      )
    }
  }

  func testKeyboardBandFactPayloadRoundTripsThroughTheWireShape() throws {
    let cases: [RunnerKeyboardBandFact] = [
      .visible(CGRect(x: 0, y: 583, width: 402, height: 291)),
      .absent,
      .unmeasurable(RunnerKeyboardBandReason.queryTimeout)
    ]
    for fact in cases {
      let data = try JSONEncoder().encode(fact.payload)
      // `encodeIfPresent` for the two optional fields: a fact carries its own evidence and nothing
      // else, so the daemon never has to distinguish a null from an absent key.
      let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      switch fact {
      case .visible:
        XCTAssertNil(object["reason"])
        XCTAssertNotNil(object["frame"])
      case .absent:
        XCTAssertNil(object["frame"])
        XCTAssertNil(object["reason"])
      case .unmeasurable:
        XCTAssertNil(object["frame"])
        XCTAssertNotNil(object["reason"])
      }
      XCTAssertEqual(try JSONDecoder().decode(KeyboardBandFactPayload.self, from: data), fact.payload)
    }
  }

  func testRunnerScreenshotStabilitySettledNeedsEnoughSamples() {
    XCTAssertFalse(runnerScreenshotStabilitySettled([], requiredConsecutiveMatches: 3))
    XCTAssertFalse(runnerScreenshotStabilitySettled([Data([1])], requiredConsecutiveMatches: 3))
    let frame = Data([1, 2, 3])
    XCTAssertFalse(
      runnerScreenshotStabilitySettled([frame, frame], requiredConsecutiveMatches: 3)
    )
  }

  func testRunnerScreenshotStabilitySettledFalseOnMidWindowMismatch() {
    // A momentary pause (two matching samples) followed by resumed movement
    // must not read as settled: the 3-sample window still spans the mismatch.
    let frame = Data([1, 2, 3])
    let moved = Data([4, 5, 6])
    XCTAssertFalse(
      runnerScreenshotStabilitySettled([frame, frame, moved], requiredConsecutiveMatches: 3)
    )
  }

  func testRunnerScreenshotStabilitySettledFalseOnFailedCapture() {
    // A nil sample (failed screenshot) never counts as a match, even against
    // other nils — an unverifiable run must not look "stable".
    XCTAssertFalse(runnerScreenshotStabilitySettled([nil, nil, nil], requiredConsecutiveMatches: 3))
    let frame = Data([1, 2, 3])
    XCTAssertFalse(
      runnerScreenshotStabilitySettled([frame, frame, nil], requiredConsecutiveMatches: 3)
    )
  }

  func testRunnerScreenshotStabilitySettledOnlyLooksAtTheTrailingWindow() {
    // An older mismatch before the trailing window must not block settlement
    // once the required run of most-recent samples agrees.
    let frame = Data([9])
    XCTAssertTrue(
      runnerScreenshotStabilitySettled(
        [Data([1]), Data([2]), frame, frame, frame],
        requiredConsecutiveMatches: 3
      )
    )
  }

  func testRunnerScreenshotStabilitySettledRejectsDegenerateRequirement() {
    // Fewer than 2 required matches would make any single sample "settled" —
    // guard against a misconfigured caller rather than silently no-op the wait.
    XCTAssertFalse(
      runnerScreenshotStabilitySettled([Data([1])], requiredConsecutiveMatches: 1)
    )
  }

  func testNoKeyboardFocusIssueIsOnlyXCTestsRefusalToTypeUnfocused() {
    XCTAssertTrue(Self.isNoKeyboardFocusIssue(
      "Failed to synthesize event: Neither element nor any descendant has keyboard focus. Event dispatch snapshot: Application"
    ))
    XCTAssertFalse(Self.isNoKeyboardFocusIssue("Timed out while evaluating UI query."))
  }

#if os(iOS)
  @MainActor
  func testKeyboardReturnWithNothingFocusedFailsWithoutInvalidatingTheRunnerSession() throws {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    XCTAssertTrue(
      app.textFields["agent-device-hardware-keyboard-input"].waitForFixtureExistence(timeout: appExistenceTimeout)
    )
    mainOwned.app = app
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    mainOwned.processIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))
    let failures = currentXCTestFailureCount()
    let command = try runnerCommandFixture(
      #"{"appBundleId":"com.callstack.agentdevice.runner","command":"keyboardReturn","commandId":"return-unfocused"}"#
    )

    let response = try execute(command: command)
    let recordedFailures = currentXCTestFailureCount() - failures

    XCTAssertEqual(recordedFailures, 0)
    XCTAssertEqual(response.error?.code, "UNSUPPORTED_OPERATION")
  }
#endif
}
#endif
