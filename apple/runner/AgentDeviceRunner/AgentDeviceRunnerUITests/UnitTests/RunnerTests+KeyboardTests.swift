import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testKeyboardBandFactReadFailureIsStatedAsUnmeasurableNotAbsence() {
    // Absence would let a consumer claim the screen is clear of a keyboard on the strength of a read
    // that never answered.
    let fact = runnerKeyboardBandFact(
      readSucceeded: false,
      exists: false,
      frame: CGRect(x: 0, y: 198, width: 402, height: 204)
    )
    XCTAssertEqual(fact, .unmeasurable(RunnerKeyboardBandReason.queryFailed))
    XCTAssertEqual(fact.payload.kind, "unmeasurable")
    XCTAssertEqual(fact.payload.reason, RunnerKeyboardBandReason.queryFailed)
    XCTAssertNil(fact.payload.frame)
  }

  func testKeyboardBandFactPublishesAbsenceWhenTheQueryFindsNoKeyboard() {
    let fact = runnerKeyboardBandFact(readSucceeded: true, exists: false, frame: .zero)
    XCTAssertEqual(fact, .absent)
    XCTAssertEqual(fact.payload.kind, "absent")
    XCTAssertNil(fact.payload.frame)
    XCTAssertNil(fact.payload.reason)
  }

  func testKeyboardBandFactPublishesTheMeasuredBandInAppOrientationSpace() {
    // The landscape band measured on iPhone 17 Pro (iOS 26.2) after #2653: full width across the
    // bottom of a 402 pt-tall app, which is what the tree reported as a strip down the left edge.
    let frame = CGRect(x: 0, y: 198, width: 874, height: 204)
    let fact = runnerKeyboardBandFact(readSucceeded: true, exists: true, frame: frame)
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
      CGRect(x: 0, y: 198, width: 0, height: 204),
      CGRect(x: 0, y: 198, width: 874, height: -1),
      CGRect(x: 0, y: 198, width: -874, height: 204),
      CGRect(x: 0, y: nan, width: 874, height: 204),
      CGRect(x: 0, y: 198, width: nan, height: 204),
      CGRect(x: infinite, y: 198, width: 874, height: 204)
    ]
    for frame in unusable {
      let fact = runnerKeyboardBandFact(readSucceeded: true, exists: true, frame: frame)
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
}
#endif
