import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testTopLeadingNavigationFallbackPointTargetsHeaderControlBand() throws {
    let point = try XCTUnwrap(
      Self.topLeadingNavigationFallbackPoint(
        in: CGRect(x: 0, y: 0, width: 430, height: 932)
      )
    )

    XCTAssertEqual(point.x, 34.4, accuracy: 0.01)
    XCTAssertEqual(point.y, 132, accuracy: 0.01)
  }

  func testTopLeadingNavigationFallbackPointRejectsInvalidFrame() {
    XCTAssertNil(Self.topLeadingNavigationFallbackPoint(in: .infinite))
    XCTAssertNil(Self.topLeadingNavigationFallbackPoint(in: .zero))
  }

  func testNavigationBackControlRankPrefersBackThenCloseThenCancel() {
    XCTAssertEqual(Self.navigationBackControlRank(label: "Back", identifier: ""), 0)
    XCTAssertEqual(Self.navigationBackControlRank(label: "Close", identifier: ""), 1)
    XCTAssertEqual(Self.navigationBackControlRank(label: "Cancel search", identifier: ""), 2)
    XCTAssertNil(Self.navigationBackControlRank(label: "Search for more feeds", identifier: ""))
  }

  func testNavigationBackPredicateUsesTheSharedKeywordTable() {
    let predicate = Self.navigationBackPredicate()

    XCTAssertTrue(predicate.evaluate(with: ["label": "Back", "identifier": ""]))
    XCTAssertTrue(predicate.evaluate(with: ["label": "", "identifier": "close-button"]))
    XCTAssertFalse(predicate.evaluate(with: ["label": "Search for more feeds", "identifier": ""]))
  }

  func testTopNavigationControlFrameAcceptsOnlyHeaderBand() {
    let window = CGRect(x: 0, y: 0, width: 430, height: 932)

    XCTAssertTrue(
      Self.isTopNavigationControlFrame(
        CGRect(x: 340, y: 84, width: 72, height: 44),
        in: window
      )
    )
    XCTAssertFalse(
      Self.isTopNavigationControlFrame(
        CGRect(x: 20, y: 760, width: 72, height: 44),
        in: window
      )
    )
    XCTAssertFalse(Self.isTopNavigationControlFrame(.infinite, in: window))
  }

  func testNavigationVisualVerificationSeparatesNoChangeFromNoSample() {
    XCTAssertEqual(
      Self.navigationVisualObservation(before: Data([1, 2, 3]), after: Data([1, 2, 4])),
      .changed
    )
    XCTAssertEqual(
      Self.navigationVisualObservation(before: Data([1, 2, 3]), after: Data([1, 2, 3])),
      .unchanged
    )
    // A missing sample is neither a change nor a no-change; treating it as "unchanged" would let a
    // capture that refused become the reason the `back` command claims no control exists (#2728).
    XCTAssertEqual(Self.navigationVisualObservation(before: nil, after: Data([1])), .unobserved)
    XCTAssertEqual(Self.navigationVisualObservation(before: Data([1]), after: nil), .unobserved)
    XCTAssertEqual(Self.navigationVisualObservation(before: nil, after: nil), .unobserved)
  }

  func testNavigationFallbackReportsTheRefusalItHitNotADefaultCode() {
    // The refusal from the most recent sample wins, so the code names what the fallback last looked at
    // before giving up; an earlier refusal is reported only when the later sample carried none (#2728).
    let after = NavigationVisualSample(
      data: nil,
      refusalCode: "APP_SCREEN_WINDOW_UNRESOLVED",
      refusalHint: "after hint"
    )
    let before = NavigationVisualSample(
      data: nil,
      refusalCode: "APP_SCREEN_UNRESOLVED",
      refusalHint: "before hint"
    )
    let laterWins = Self.navigationFallbackErrorPayload(after: after, before: before)
    XCTAssertEqual(laterWins.code, "APP_SCREEN_WINDOW_UNRESOLVED")
    XCTAssertEqual(laterWins.hint, "after hint")

    let onlyBefore = Self.navigationFallbackErrorPayload(
      after: NavigationVisualSample(data: nil),
      before: before
    )
    XCTAssertEqual(onlyBefore.code, "APP_SCREEN_UNRESOLVED")
    XCTAssertEqual(onlyBefore.hint, "before hint")

    // Neither side named a reason (unreachable on iOS): a real capture code, never a bare failure.
    let unnamed = Self.navigationFallbackErrorPayload(
      after: NavigationVisualSample(data: nil),
      before: NavigationVisualSample(data: nil)
    )
    XCTAssertEqual(unnamed.code, "APP_SCREEN_UNRESOLVED")
    XCTAssertTrue(unnamed.message.contains("unknown outcome"))
  }

  func testVerifyNavigationFallbackOutcomeReportsUnresolvedWindowWithoutSystemSurface() {
    // The in-app `back` fallback ran its tap but the app resolved no window. It must name that refusal
    // as an unknown outcome AND must not have sampled the system surface: capturing SpringBoard's home
    // screen twice reads as "unchanged" and launders a wrong-process frame into "no back control
    // exists" (#2728). This drives the SAME `navigationFallbackSample` production calls, handing it a
    // system surface that fails the test if consulted — so reverting the fallback to sample SpringBoard
    // (or dropping the refusal code) turns this red, which an inline `.never` re-creation could not.
    var askedSystemSurface = false
    let sample = Self.navigationFallbackSample(
      resolvingApp: { .failure(.unresolvedWindow) },
      systemSurface: {
        askedSystemSurface = true
        return .failure(.unresolvedWindow)
      },
      encoding: { _ in Data([1, 2, 3]) }
    )
    XCTAssertFalse(askedSystemSurface, "the in-app fallback samples the app only, never SpringBoard")

    XCTAssertNil(sample.data)
    XCTAssertEqual(sample.refusalCode, "APP_SCREEN_WINDOW_UNRESOLVED")

    let observation = Self.navigationVisualObservation(before: sample.data, after: sample.data)
    XCTAssertEqual(observation, .unobserved)

    switch Self.inAppBackOutcome(observation: observation, before: sample, after: sample) {
    case .unverified(let payload):
      XCTAssertEqual(payload.code, "APP_SCREEN_WINDOW_UNRESOLVED")
    case .performed, .unavailable:
      XCTFail("a refused capture must report an unknown outcome, not 'no back control'")
    }
  }

  func testNavigationVisualSampleDistinguishesEncodedFrameFromRefusal() {
    // The same capture entry point yields three different samples, and only the refusal ones may carry
    // a code: an encoded frame is evidence, a resolved-but-unencodable image and a refusal are not
    // (#2728). Reverting the mapping to a plain no-sample loses the reason a host keys on.
    let captured = CapturedAppScreen(
      image: RunnerImage(),
      displayID: 3,
      pixelWidth: 12,
      pixelHeight: 24,
      pixelsPerPoint: 3
    )

    let encoded = Self.navigationVisualSample(
      from: .success(captured),
      encoding: { _ in Data([7, 7]) }
    )
    XCTAssertEqual(encoded.data, Data([7, 7]))
    XCTAssertNil(encoded.refusalCode)

    let unencodable = Self.navigationVisualSample(
      from: .success(captured),
      encoding: { _ in nil }
    )
    XCTAssertNil(unencodable.data)
    XCTAssertEqual(unencodable.refusalCode, "APP_SCREEN_CAPTURE_UNRENDERABLE")

    let refused = Self.navigationVisualSample(
      from: .failure(.unresolvedScreen),
      encoding: { _ in Data([7, 7]) }
    )
    XCTAssertNil(refused.data)
    XCTAssertEqual(refused.refusalCode, "APP_SCREEN_UNRESOLVED")
  }
}
#endif
