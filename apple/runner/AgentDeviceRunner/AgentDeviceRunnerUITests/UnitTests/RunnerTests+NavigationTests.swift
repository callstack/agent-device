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

    guard soleScreenRouteIsOpen(for: app) else {
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

  /// After the tree rejects a query, `back` reaches the top-leading control through whichever route
  /// is open: the sole screen where the app proves it fills it (both families here), the resolved
  /// window everywhere else. The refusal half on a real device is
  /// `testSoleScreenDisplayIDIsNamedOnlyForAnAppThatFillsItsScreen` and the unprovable-foreground
  /// test below, which stand where no simulator here can: its foreground app always fills its screen.
  @MainActor
  func testInAppBackAfterARejectedQueryTapsThroughTheRouteThatOpens() throws {
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

  /// The window route the sole-screen rule leaves when the probe cannot prove the fill: with the
  /// probe's primary-app read stubbed to answer nothing (the evidence seam's `unknown`), the route
  /// closes, and a rejected tree still dispatches `back` through the resolved window. An iPhone
  /// keeps the sole-screen route by idiom — it answers before the probe is ever asked, so no stub
  /// can close it there and the window route is the off-phone half's own. Real windowed geometry
  /// needs an iPad set to Windowed Apps, which no lane runs; `unknown` closes the same route for
  /// the same reason — the fill is not proven.
  @MainActor
  func testInAppBackAfterARejectedQueryWithUnprovableForegroundTapsThroughTheWindow() throws {
    let status = try launchBackFixture(["--agent-device-back-regression"])
    defer { endBackFixture() }
    // Runs the real probe once, which is also what registers the AXRuntime class this seam stubs.
    XCTAssertTrue(soleScreenRouteIsOpen(for: app))
    guard UIDevice.current.userInterfaceIdiom != .phone else {
      return
    }
    let restoreProbe = stubForegroundPrimaryAppAsUnprovable()
    defer { restoreProbe() }
    XCTAssertFalse(
      soleScreenRouteIsOpen(for: app),
      "an iPad whose app the probe cannot prove keeps requiring a resolved window"
    )

    let outcome = try withRejectedAppTree(framesReadable: true, rejections: 1) {
      tapInAppBackControl(app: app)
    }
    guard case .performed = outcome else {
      return XCTFail("a refused sole-screen route must still dispatch back through the resolved window")
    }
    XCTAssertEqual(status.label, "Back performed")
  }

  /// Stands in for a device showing the app in part of its screen as far as the probe can tell: the
  /// probe's `primaryApp` read answers nothing, which the evidence seam reports as `unknown`. The
  /// windowed geometry itself needs an iPad set to Windowed Apps, which no lane runs; `unknown`
  /// closes the same route for the same reason — the fill is not proven.
  private func stubForegroundPrimaryAppAsUnprovable() -> () -> Void {
    let element = NSClassFromString("AXElement")
    let method = element.flatMap { class_getClassMethod($0, NSSelectorFromString("primaryApp")) }
    guard let method else {
      preconditionFailure("AXRuntime did not register AXElement before the probe seam was stubbed")
    }
    let original = method_getImplementation(method)
    let replacement = imp_implementationWithBlock(
      { (_: AnyObject) -> AnyObject? in nil } as @convention(block) (AnyObject) -> AnyObject?
    )
    method_setImplementation(method, replacement)
    return {
      method_setImplementation(method, original)
      imp_removeBlock(replacement)
    }
  }

  /// Launches the runner app and waits for its fixture surface. With
  /// `--agent-device-back-regression` it shows a top-leading back control whose press sets the
  /// returned status to "Back performed", and without it nothing there.
  @MainActor
  private func launchBackFixture(
    _ arguments: [String],
    navigationBar: Bool = false
  ) throws -> XCUIElement {
    app.launchArguments = arguments + (navigationBar ? ["--navigation-bar"] : [])
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
    let status = try launchBackFixture(
      ["--agent-device-back-regression"],
      navigationBar: navigationBar
    )
    defer { endBackFixture() }
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

  /// The fallback point sits inside the top bar on both families, from the screen's own top inset:
  /// an iPhone 17 Pro measures a 59-pt inset with its bar at y 62-116; an iPad Pro 11" measures 32
  /// with its bar at y 32-86, where a frame-height fraction that serves the iPhone (0.1·874=87, and
  /// the old clamp's 96 at any taller height) lands below the iPad's bar.
  func testTopLeadingNavigationFallbackPointTargetsHeaderControlBand() throws {
    let iPhone = try XCTUnwrap(
      Self.topLeadingNavigationFallbackPoint(
        in: CGRect(x: 0, y: 0, width: 402, height: 874),
        topSafeAreaInset: 59
      )
    )
    XCTAssertEqual(iPhone.x, 32.16, accuracy: 0.01)
    XCTAssertEqual(iPhone.y, 81, accuracy: 0.01, "inside the iPhone bar band 62-116")

    let iPad = try XCTUnwrap(
      Self.topLeadingNavigationFallbackPoint(
        in: CGRect(x: 0, y: 0, width: 834, height: 1210),
        topSafeAreaInset: 32
      )
    )
    XCTAssertEqual(iPad.x, 44, accuracy: 0.01, "the leading-slot cap keeps a tablet tap inside the bar")
    XCTAssertEqual(iPad.y, 56, accuracy: 0.01, "inside the iPad bar band 32-86")
  }

  func testTopLeadingNavigationFallbackPointRejectsInvalidFrame() {
    XCTAssertNil(Self.topLeadingNavigationFallbackPoint(in: .infinite, topSafeAreaInset: 59))
    XCTAssertNil(Self.topLeadingNavigationFallbackPoint(in: .zero, topSafeAreaInset: 59))
  }

  /// A runtime that reports no inset proves nothing about the band, so the point stays inside the
  /// compact bar it used to target; a large inset (a surface that pushed the content down) must not
  /// send the tap deep into the page.
  func testTopLeadingNavigationFallbackPointStaysBoundedForUnknownAndLargeInsets() throws {
    let frame = CGRect(x: 0, y: 0, width: 834, height: 1210)
    let noInset = try XCTUnwrap(Self.topLeadingNavigationFallbackPoint(in: frame, topSafeAreaInset: 0))
    XCTAssertEqual(noInset.y, 56, accuracy: 0.01, "the compact bar bound")
    let hugeInset = try XCTUnwrap(Self.topLeadingNavigationFallbackPoint(in: frame, topSafeAreaInset: 400))
    XCTAssertEqual(hugeInset.y, 96, accuracy: 0.01, "never leaves the header band")
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
      Self.navigationVisualObservation(before: .success(Data([1, 2, 3])), after: .success(Data([1, 2, 4]))),
      .changed
    )
    XCTAssertEqual(
      Self.navigationVisualObservation(before: .success(Data([1, 2, 3])), after: .success(Data([1, 2, 3]))),
      .unchanged
    )
    // A refused side makes the pair uncomparable, not "unchanged"; reading it as "unchanged" would
    // let a capture that refused become the reason the `back` command claims no control exists (#2728).
    XCTAssertEqual(
      Self.navigationVisualObservation(before: .failure(.unresolvedWindow), after: .success(Data([1]))),
      .unobserved(refusal: .unresolvedWindow)
    )
    XCTAssertEqual(
      Self.navigationVisualObservation(before: .success(Data([1])), after: .failure(.unresolvedScreen)),
      .unobserved(refusal: .unresolvedScreen)
    )
  }

  func testNavigationFallbackReportsTheRefusalItHitNotADefaultCode() {
    // The later refusal wins, so the code names what the fallback last looked at before giving up;
    // an uncomparable pair always carries a typed reason (#2728).
    let laterRefusal = Self.navigationVisualObservation(
      before: .failure(.unresolvedScreen),
      after: .failure(.unresolvedWindow)
    )
    XCTAssertEqual(laterRefusal, .unobserved(refusal: .unresolvedWindow))
    switch Self.inAppBackOutcome(observation: laterRefusal) {
    case .unverified(let payload):
      XCTAssertEqual(payload.code, "APP_SCREEN_WINDOW_UNRESOLVED")
      XCTAssertEqual(payload.hint, RunnerAppScreenCaptureFailure.unresolvedWindow.hint)
      XCTAssertTrue(payload.message.contains("unknown outcome"))
    case .performed, .unavailable:
      XCTFail("a refused capture must report an unknown outcome, not 'no back control'")
    }

    // An earlier refusal is reported when the later sample captured but cannot pair with it.
    let earlierRefusal = Self.navigationVisualObservation(
      before: .failure(.unresolvedScreen),
      after: .success(Data([1]))
    )
    let payload = Self.navigationFallbackErrorPayload(.unresolvedScreen)
    XCTAssertEqual(earlierRefusal, .unobserved(refusal: .unresolvedScreen))
    XCTAssertEqual(payload.code, "APP_SCREEN_UNRESOLVED")
    XCTAssertEqual(payload.hint, RunnerAppScreenCaptureFailure.unresolvedScreen.hint)
  }

  func testNavigationFallbackReportsAWindowlessRefusalAsUnknown() {
    // The window-less half of the route: a typed refusal stays a typed refusal through the mapping,
    // the pair is unobserved, and the outcome is the unknown that names the refusal — never the
    // definitive "no back control" (#2728).
    let sample = Self.navigationVisualSample(
      from: .failure(.unresolvedWindow),
      encoding: { _ in Data([1, 2, 3]) }
    )
    XCTAssertEqual(sample, .failure(.unresolvedWindow))

    let observation = Self.navigationVisualObservation(before: sample, after: sample)
    XCTAssertEqual(observation, .unobserved(refusal: .unresolvedWindow))

    switch Self.inAppBackOutcome(observation: observation) {
    case .unverified(let payload):
      XCTAssertEqual(payload.code, "APP_SCREEN_WINDOW_UNRESOLVED")
    case .performed, .unavailable:
      XCTFail("a refused capture must report an unknown outcome, not 'no back control'")
    }
  }

  /// The fallback samples the app's own screen only. Asking the system surface would capture
  /// SpringBoard's home screen, which reads as "unchanged" before/after and launders a wrong-process
  /// frame into a false "no back control" (#2728). No test drives that route into the system-surface
  /// capture, so the file-level ban is the pin.
  func testNavigationFallbackSourceNeverReachesForTheSystemSurface() throws {
    let sourceURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("RunnerTests+Navigation.swift")
    let source = try String(contentsOf: sourceURL, encoding: .utf8)

    for forbidden in ["self.springboard", "captureObservedScreen", "selectObservedScreenCapture"] {
      XCTAssertFalse(
        source.contains(forbidden),
        "the in-app back fallback must sample the app only, never the system surface: \(forbidden)"
      )
    }
  }

  func testNavigationVisualSampleDistinguishesEncodedFrameFromRefusal() {
    // The same capture entry point yields three different answers, and only the refusals carry a
    // code: an encoded frame is evidence, a resolved-but-unencodable image and a refusal are not
    // (#2728). Reverting the mapping to a plain no-sample loses the reason a host keys on.
    let captured = CapturedAppScreen(
      image: RunnerImage(),
      displayID: 3,
      pixelWidth: 12,
      pixelHeight: 24,
      pixelsPerPoint: 3
    )

    XCTAssertEqual(
      Self.navigationVisualSample(from: .success(captured), encoding: { _ in Data([7, 7]) }),
      .success(Data([7, 7]))
    )
    XCTAssertEqual(
      Self.navigationVisualSample(from: .success(captured), encoding: { _ in nil }),
      .failure(.unrenderableImage)
    )
    XCTAssertEqual(
      Self.navigationVisualSample(from: .failure(.unresolvedScreen), encoding: { _ in Data([7, 7]) }),
      .failure(.unresolvedScreen)
    )
  }
}
#endif
