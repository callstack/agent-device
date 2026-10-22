import XCTest
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
#if os(iOS)
  @MainActor
  func testRankedInAppBackUsesSynthesisWithoutXCTestTap() throws {
    try assertInAppBackDispatch(navigationBar: false)
  }

  /// A navigation bar button keeps XCTest's element tap, which aims at its computed hittable point.
  @MainActor
  func testNavigationBarBackKeepsTheElementTap() throws {
    try assertInAppBackDispatch(navigationBar: true)
  }

  @MainActor
  func testInAppBackVerifiesSoleScreenWhenXCTestCannotReadFramesOrEnumerate() throws {
    let status = try launchBackFixture(["--agent-device-back-regression"])
    defer { endBackFixture() }

    let outcome = try withRejectedAppTree(framesReadable: false) { tapInAppBackControl(app: app) }

    guard showsAppsOnlyFullScreen else {
      guard case .unavailable = outcome else {
        return XCTFail("without a window or a sole screen there is no route to tap")
      }
      return
    }
    guard case .performed = outcome else {
      return XCTFail("a window-less back must synthesize and verify against the sole display")
    }
    XCTAssertEqual(status.label, "Back performed")
  }

  /// The sole-screen route compares real captures: a tap that lands on nothing leaves the screen
  /// unchanged, so back is unavailable rather than performed.
  @MainActor
  func testInAppBackOnTheSoleScreenReportsATapThatChangedNothingAsUnavailable() throws {
    _ = try launchBackFixture([])
    defer { endBackFixture() }

    let outcome = try withRejectedAppTree(framesReadable: false) { tapInAppBackControl(app: app) }

    guard case .unavailable = outcome else {
      return XCTFail("a top-leading tap on an app without a back control must not read as performed")
    }
  }

  /// Only an iPhone with one screen can skip the windows query after the tree rejected one; anywhere
  /// else the windows query is still asked, and its window carries the tap.
  @MainActor
  func testInAppBackStillAsksForWindowsWhereNoSoleScreenAnswers() throws {
    let status = try launchBackFixture(["--agent-device-back-regression"])
    defer { endBackFixture() }

    let outcome = try withRejectedAppTree(framesReadable: true, rejections: 1) {
      tapInAppBackControl(app: app)
    }

    guard case .performed = outcome else {
      return XCTFail("back must reach the fixture's top-leading control through a window or the sole screen")
    }
    XCTAssertEqual(status.label, "Back performed")
  }

  private var showsAppsOnlyFullScreen: Bool {
    UIDevice.current.userInterfaceIdiom == .phone && XCUIScreen.screens.count == 1
  }

  /// Launches the runner app; with `--agent-device-back-regression` it shows a top-leading back
  /// control whose press sets the returned status to "Back performed", and without it nothing there.
  @MainActor
  private func launchBackFixture(_ arguments: [String]) throws -> XCUIElement {
    app.launchArguments = arguments
    app.launch()
    mainOwned.app = app
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    clearSnapshotXCTestChannelPenalty(reason: "navigation-test")
    let status = arguments.contains("--agent-device-back-regression")
      ? app.staticTexts["agent-device-back-status"]
      : app.staticTexts.element(matching: NSPredicate(format: "label == %@", "Agent Device Runner"))
    XCTAssertTrue(status.waitForFixtureExistence(timeout: appExistenceTimeout))
    return status
  }

  @MainActor
  private func endBackFixture() {
    invalidateCachedTarget(reason: "unit_test_cleanup")
    app.terminate()
  }

  /// Stands in for XCTest on a tree it cannot serialize while `body` runs: the first `rejections`
  /// queries record the rejection the runner suppresses and find nothing, and unless
  /// `framesReadable`, every element frame reads empty.
  @MainActor
  private func withRejectedAppTree<T>(
    framesReadable: Bool,
    rejections: Int = .max,
    _ body: () -> T
  ) throws -> T {
    var restorations: [() -> Void] = []
    defer { restorations.reversed().forEach { $0() } }
    let selector = NSSelectorFromString("allElementsBoundByIndex")
    let query = try XCTUnwrap(class_getInstanceMethod(XCUIElementQuery.self, selector))
    let originalQuery = method_getImplementation(query)
    var remainingRejections = rejections
    let rejectedQuery = imp_implementationWithBlock({ (target: AnyObject) -> NSArray in
      guard remainingRejections > 0 else {
        typealias Query = @convention(c) (AnyObject, Selector) -> NSArray
        return unsafeBitCast(originalQuery, to: Query.self)(target, selector)
      }
      remainingRejections -= 1
      self.record(XCTIssue(type: .assertionFailure, compactDescription: "Failed to resolve query: kAXErrorIllegalArgument"))
      return []
    } as @convention(block) (AnyObject) -> NSArray)
    method_setImplementation(query, rejectedQuery)
    restorations.append {
      method_setImplementation(query, originalQuery)
      imp_removeBlock(rejectedQuery)
    }
    if !framesReadable {
      let frame = try XCTUnwrap(class_getInstanceMethod(XCUIElement.self, NSSelectorFromString("frame")))
      let originalFrame = method_getImplementation(frame)
      let unavailableFrame = imp_implementationWithBlock({ (_: AnyObject) -> CGRect in .zero } as @convention(block) (AnyObject) -> CGRect)
      method_setImplementation(frame, unavailableFrame)
      restorations.append {
        method_setImplementation(frame, originalFrame)
        imp_removeBlock(unavailableFrame)
      }
    }
    return body()
  }

  @MainActor
  private func assertInAppBackDispatch(navigationBar: Bool) throws {
    app.launchArguments = ["--agent-device-back-regression"] + (navigationBar ? ["--navigation-bar"] : [])
    app.launch()
    mainOwned.app = app
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    clearSnapshotXCTestChannelPenalty(reason: "navigation-test")
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let status = app.staticTexts["agent-device-back-status"]
    XCTAssertTrue(status.waitForFixtureExistence(timeout: appExistenceTimeout))
    var xctestTaps = 0
    var restorations: [() -> Void] = []
    defer { restorations.reversed().forEach { $0() } }
    for type in [XCUIElement.self, XCUICoordinate.self] {
      let selector = NSSelectorFromString("tap")
      let method = try XCTUnwrap(class_getInstanceMethod(type, selector))
      let original = method_getImplementation(method)
      let replacement = imp_implementationWithBlock({ (target: AnyObject) in
        xctestTaps += 1
        typealias Tap = @convention(c) (AnyObject, Selector) -> Void
        unsafeBitCast(original, to: Tap.self)(target, selector)
      } as @convention(block) (AnyObject) -> Void)
      method_setImplementation(method, replacement)
      restorations.append {
        method_setImplementation(method, original)
        imp_removeBlock(replacement)
      }
    }

    guard case .performed = tapInAppBackControl(app: app) else {
      return XCTFail("the selected back control must dispatch")
    }
    let changed = expectation(for: NSPredicate(format: "label == %@", "Back performed"), evaluatedWith: status)
    wait(for: [changed], timeout: appExistenceTimeout)
    if navigationBar {
      XCTAssertEqual(xctestTaps, 1, "a navigation bar button keeps the element tap")
    } else {
      XCTAssertEqual(xctestTaps, 0, "a ranked back control uses synthesized dispatch without idle waits")
    }
  }
#endif

  /// A 402x874 iPhone's navigation bar spans y 62-116 and its back control 62-106.
  func testTopLeadingNavigationFallbackPointTargetsHeaderControlBand() throws {
    let point = try XCTUnwrap(
      Self.topLeadingNavigationFallbackPoint(
        in: CGRect(x: 0, y: 0, width: 402, height: 874)
      )
    )

    XCTAssertEqual(point.x, 32.16, accuracy: 0.01)
    XCTAssertEqual(point.y, 87.4, accuracy: 0.01)
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

  func testTopNavigationBackCandidateAcceptsIOS27FloatingBarSystemBackButton() {
    let window = CGRect(x: 0, y: 0, width: 466, height: 678)
    let floatingBarBack = CGRect(x: 399, y: 175, width: 38, height: 38)

    XCTAssertFalse(Self.isTopNavigationControlFrame(floatingBarBack, in: window))
    XCTAssertTrue(
      Self.isTopNavigationBackCandidateFrame(floatingBarBack, in: window, identifier: "BackButton")
    )
  }

  func testTopNavigationBackCandidateRejectsKeywordOnlyMatchBelowHeaderBand() {
    let window = CGRect(x: 0, y: 0, width: 466, height: 678)
    let floatingBarBack = CGRect(x: 399, y: 175, width: 38, height: 38)

    XCTAssertFalse(
      Self.isTopNavigationBackCandidateFrame(floatingBarBack, in: window, identifier: "back-link")
    )
    XCTAssertFalse(
      Self.isTopNavigationBackCandidateFrame(floatingBarBack, in: window, identifier: "")
    )
  }

  func testTopNavigationBackCandidateBoundsSystemBackButtonToUpperWindow() {
    // 40% of 932 is 372.8; the classic band ends at 180, so only the floating-bar bound decides.
    let window = CGRect(x: 0, y: 0, width: 430, height: 932)

    XCTAssertTrue(
      Self.isTopNavigationBackCandidateFrame(
        CGRect(x: 20, y: 348, width: 44, height: 44),
        in: window,
        identifier: "BackButton"
      )
    )
    XCTAssertFalse(
      Self.isTopNavigationBackCandidateFrame(
        CGRect(x: 20, y: 356, width: 44, height: 44),
        in: window,
        identifier: "BackButton"
      )
    )
    XCTAssertFalse(
      Self.isTopNavigationBackCandidateFrame(.infinite, in: window, identifier: "BackButton")
    )
  }

  func testTopNavigationBackCandidateKeepsClassicHeaderBandForKeywordMatches() {
    let window = CGRect(x: 0, y: 0, width: 430, height: 932)

    XCTAssertTrue(
      Self.isTopNavigationBackCandidateFrame(
        CGRect(x: 340, y: 84, width: 72, height: 44),
        in: window,
        identifier: "back-link"
      )
    )
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
