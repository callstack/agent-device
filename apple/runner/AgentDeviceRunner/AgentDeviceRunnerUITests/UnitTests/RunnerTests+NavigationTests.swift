import AgentDeviceSnapshotPresentation
import XCTest
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
#if os(iOS)
  @MainActor
  func testInAppBackSwipesFromTheLeftEdgeAndVerifiesTheChange() throws {
    let status = try launchBackFixture(["--agent-device-back-regression"])
    defer { endBackFixture() }

    guard case .performed = try performInAppBack(app: app) else {
      return XCTFail("a left-edge swipe the app answers must read as performed")
    }
    XCTAssertEqual(status.label, "Back performed")
  }

  /// A swipe the app ignores leaves the screen unchanged, so back refuses with the typed reason and
  /// a hint to press the visible control instead.
  @MainActor
  func testInAppBackReportsASwipeThatChangedNothing() throws {
    _ = try launchBackFixture([])
    defer { endBackFixture() }

    let response = try execute(command: try runnerCommandFixture(
      #"{"command":"backInApp","commandId":"back-no-change","appBundleId":"com.callstack.agentdevice.runner"}"#
    ))
    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.backSwipeNoChange)
    XCTAssertNotNil(response.error?.hint)
  }

  /// A screen that changes on its own would read as a back navigation, so back reports an unknown
  /// outcome there, never success.
  @MainActor
  func testInAppBackOnAScreenThatKeepsChangingReportsAnUnknownOutcome() throws {
    _ = try launchBackFixture(["--agent-device-back-regression", "--animating"])
    defer { endBackFixture() }

    guard case .unconfirmed(let payload) = try performInAppBack(app: app) else {
      return XCTFail("a screen that changes on its own must not read as performed")
    }
    XCTAssertEqual(payload.code, RunnerWireErrorCode.backSwipeUnverified)
  }

  /// A screen that repaints itself every 0.45 s, with a swipe that does nothing, is never still for
  /// the required span (about 0.55 s on a simulator), so its own repaint after the swipe is never
  /// read as a back. Attempt k starts k * 0.09 s after a repaint, five phases across the cycle.
  @MainActor
  func testInAppBackNeverCreditsASlowSelfRepaintToANoOpSwipe() throws {
    _ = try launchBackFixture(["--slow-toggle"])
    defer { endBackFixture() }

    for offset in (0..<5).map({ Double($0) * Self.slowTogglePeriod / 5 }) {
      waitForSlowToggleOffset(offset)
      guard case .unconfirmed(let payload) = try performInAppBack(app: app) else {
        return XCTFail("a repaint \(offset) s before the attempt must not read as a back")
      }
      XCTAssertEqual(payload.code, RunnerWireErrorCode.backSwipeUnverified, "offset \(offset) s")
    }
  }

  /// The navigation bar's system back button is pressed from the live tree: the fixture's
  /// interactive pop is off, so only that button can pop the detail screen.
  @MainActor
  func testInAppBackPressesTheNavigationBarBackButton() throws {
    let status = try launchBackNavigationFixture(["--agent-device-back-navigation-bar"])
    defer { endBackFixture() }

    guard case .performed = try performInAppBack(app: app) else {
      return XCTFail("a visible navigation bar back button must be pressed")
    }
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.pressed, true, "the button, not the swipe, popped")
    let popped = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Back pressed"), object: status)
    XCTAssertEqual(XCTWaiter().wait(for: [popped], timeout: 5), .completed)
  }

  /// A floating back button with no label, outside the bar's subtree as on the iPhone Duo, is pressed
  /// and its pop is confirmed through the bar's title.
  @MainActor
  func testInAppBackPressesAFloatingUnlabeledBackButtonAndConfirmsThroughTheBarTitle() throws {
    let status = try launchBackNavigationFixture(["--agent-device-back-navigation-bar", "--floating-back"])
    defer { endBackFixture() }
    XCTAssertEqual(app.navigationBars.buttons.matching(identifier: Self.navigationBarBackButtonIdentifier).count, 0)

    try assertBackPressesTheButtonAndPops(status, "a floating back button beside a navigation bar must be pressed and confirmed")
  }

  /// A bar that retitles itself, such as a countdown, never holds still for an unlabeled back button,
  /// whose pop the title alone shows: nothing is tapped.
  @MainActor
  func testInAppBackNeverPressesAnUnlabeledBackButtonUnderATickingBarTitle() throws {
    _ = try launchBackNavigationFixture(["--agent-device-back-navigation-bar", "--floating-back", "--fast-ticking-title"])
    defer { endBackFixture() }

    _ = try performInAppBack(app: app)
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.pressed, false)
    XCTAssertTrue(["moving", "unreadable"].contains(lastNavigationBarBackTraceForTesting?.found ?? ""), "the lookup never holds still")
  }

  /// An in-content button identified `BackButton` is no candidate: the bar's own back button is still
  /// the one pressed, not counted as ambiguous.
  @MainActor
  func testInAppBackPressesTheBarBackButtonBesideAnInContentBackButton() throws {
    let status = try launchBackNavigationFixture(["--agent-device-back-navigation-bar", "--content-back-button"])
    defer { endBackFixture() }
    XCTAssertEqual(app.buttons.matching(identifier: Self.navigationBarBackButtonIdentifier).count, 2)

    try assertBackPressesTheButtonAndPops(status, "the bar's back button must be pressed beside an in-content button of the same identifier")
  }

  /// An in-content `BackButton` that keeps moving does not hold the lookup back: it is not compared.
  @MainActor
  func testInAppBackIsNotBlockedByAMovingInContentBackButton() throws {
    _ = try launchBackNavigationFixture(["--agent-device-back-navigation-bar", "--moving-content-back"])
    defer { endBackFixture() }

    guard case .performed = try performInAppBack(app: app) else {
      return XCTFail("a moving in-content button must not block the bar's back button")
    }
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.found, "yes")
  }

  /// A back button identified `BackButton` in an app with no navigation bar is not a system back
  /// button: nothing is pressed.
  @MainActor
  func testInAppBackNeverPressesABackButtonWhenTheAppShowsNoNavigationBar() throws {
    _ = try launchBackNavigationFixture(["--agent-device-back-navigation-bar", "--floating-back", "--hidden-bar"])
    defer { endBackFixture() }

    _ = try performInAppBack(app: app)
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.found, "no")
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.pressed, false)
  }

  /// A delivered tap on the system back button is not a navigation: when the bar does not change,
  /// back reports an unknown outcome and never swipes after the tap.
  @MainActor
  func testInAppBackReportsAPressedBackButtonThatDoesNotNavigateAsUnverified() throws {
    guard #available(iOS 16.0, *) else { throw XCTSkip("UINavigationItem.backAction needs iOS 16") }
    _ = try launchBackNavigationFixture(["--agent-device-back-navigation-bar", "--blocked-back"])
    defer { endBackFixture() }

    guard case .unconfirmed(let payload) = try performInAppBack(app: app) else {
      return XCTFail("a back button tap that leaves the bar unchanged must not read as performed")
    }
    XCTAssertEqual(payload.code, RunnerWireErrorCode.backSwipeUnverified)
    XCTAssertTrue(app.navigationBars["Detail"].exists)
  }

  /// A bar title that counts down on its own is not a navigation: a tap that navigates nowhere on
  /// such a bar reports an unknown outcome, though the title changes within the confirmation window.
  @MainActor
  func testInAppBackDoesNotCreditATickingBarTitleToAPressedBackButton() throws {
    guard #available(iOS 16.0, *) else { throw XCTSkip("UINavigationItem.backAction needs iOS 16") }
    _ = try launchBackNavigationFixture(["--agent-device-back-navigation-bar", "--blocked-back", "--ticking-title"])
    defer { endBackFixture() }

    guard case .unconfirmed(let payload) = try performInAppBack(app: app) else {
      return XCTFail("a ticking bar title must not confirm a back button tap that navigated nowhere")
    }
    XCTAssertEqual(payload.code, RunnerWireErrorCode.backSwipeUnverified)
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.pressed, true)
    XCTAssertEqual(app.navigationBars.buttons.matching(identifier: Self.navigationBarBackButtonIdentifier).count, 1)
  }

  /// A back button that only moves after the tap is not a navigation: a tap that navigates nowhere
  /// but shifts the bar, as a large-title collapse does, reports an unknown outcome.
  @MainActor
  func testInAppBackDoesNotCreditAMovedBackButtonToAPressedBackButton() throws {
    guard #available(iOS 16.0, *) else { throw XCTSkip("UINavigationItem.backAction needs iOS 16") }
    _ = try launchBackNavigationFixture(["--agent-device-back-navigation-bar", "--blocked-back", "--shifting-back"])
    defer { endBackFixture() }
    let backButton = app.navigationBars.buttons.matching(identifier: Self.navigationBarBackButtonIdentifier).firstMatch
    let frameBefore = backButton.frame

    guard case .unconfirmed(let payload) = try performInAppBack(app: app) else {
      return XCTFail("a back button that only moved must not confirm a tap that navigated nowhere")
    }
    XCTAssertEqual(payload.code, RunnerWireErrorCode.backSwipeUnverified)
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.pressed, true)
    XCTAssertTrue(app.navigationBars["Detail"].exists)
    XCTAssertNotEqual(backButton.frame.minY, frameBefore.minY, "the fixture must move the back button")
  }

  /// An XCTest issue while the back button is looked up, such as a button gone mid-transition, means
  /// no button: back answers from the swipe path. An issue that escaped the read would fail this
  /// test as it fails the command with a recorded failure. The swipe's own outcome is not asserted:
  /// iOS 27 pops this fixture on the edge swipe even with its interactive pop turned off.
  @MainActor
  func testInAppBackWithAnIssueInTheButtonLookupAnswersFromTheSwipe() throws {
    _ = try launchBackNavigationFixture(["--agent-device-back-navigation-bar"])
    defer { endBackFixture() }
    navigationBarBackReadForTesting = { $0 == .lookup ? Self.vanishedBackButtonIssue : nil }
    defer { navigationBarBackReadForTesting = nil }

    let response = try execute(command: try runnerCommandFixture(
      #"{"command":"backInApp","commandId":"back-lookup-issue","appBundleId":"com.callstack.agentdevice.runner"}"#
    ))

    XCTAssertNotEqual(response.error?.code, "XCTEST_RECORDED_FAILURE")
    let trace = try XCTUnwrap(lastNavigationBarBackTraceForTesting)
    XCTAssertEqual(trace.found, "unreadable")
    XCTAssertFalse(trace.pressed, "back answered from the swipe path")
  }

  /// A hung query before the tap stays visible to XCTest, as `record(_:)` requires, and back sends
  /// nothing: neither the button tap nor the swipe follows a hung query.
  @MainActor
  func testInAppBackWithAHungQueryInTheButtonLookupSendsNothing() throws {
    _ = try launchBackNavigationFixture(["--agent-device-back-navigation-bar"])
    defer { endBackFixture() }
    defer { navigationBarBackReadForTesting = nil }

    let outcome = try expectingHungQueryRecorded {
      navigationBarBackReadForTesting = { $0 == .lookup ? Self.hungQueryIssue : nil }
      return try performInAppBack(app: app)
    }

    guard case .refused(let payload) = outcome else { return XCTFail("a hung lookup must send nothing") }
    XCTAssertEqual(payload.code, RunnerWireErrorCode.backSwipeNotDispatched)
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.found, "hung")
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.pressed, false)
    navigationBarBackReadForTesting = nil
    XCTAssertTrue(app.navigationBars["Detail"].exists, "nothing popped the detail screen")
  }

  /// A hung query after a delivered tap stays visible to XCTest, and back answers unverified at once
  /// instead of querying the hung tree again.
  @MainActor
  func testInAppBackWithAHungQueryInTheConfirmationAnswersUnverified() throws {
    _ = try launchBackNavigationFixture(["--agent-device-back-navigation-bar"])
    defer { endBackFixture() }
    defer { navigationBarBackReadForTesting = nil }

    let outcome = try expectingHungQueryRecorded {
      navigationBarBackReadForTesting = { $0 == .confirmation ? Self.hungQueryIssue : nil }
      return try performInAppBack(app: app)
    }

    guard case .unconfirmed(let payload) = outcome else { return XCTFail("a hung confirmation must not read as performed") }
    XCTAssertEqual(payload.code, RunnerWireErrorCode.backSwipeUnverified)
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.pressed, true)
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.confirmed, "hung")
  }

  /// Two hittable system back buttons, one per stack, are ambiguous: back presses neither and
  /// answers from the swipe path.
  @MainActor
  func testInAppBackPressesNoneOfTwoNavigationBarBackButtons() throws {
    _ = try launchBackNavigationFixture(["--agent-device-back-navigation-bar", "--two-stacks"])
    defer { endBackFixture() }
    XCTAssertEqual(app.navigationBars.buttons.matching(identifier: Self.navigationBarBackButtonIdentifier).count, 2)

    _ = try performInAppBack(app: app)

    let trace = try XCTUnwrap(lastNavigationBarBackTraceForTesting)
    XCTAssertEqual(trace.found, "ambiguous")
    XCTAssertFalse(trace.pressed, "back answered from the swipe path")
  }

  /// A penalized XCTest snapshot channel is not read: back skips the button lookup and swipes.
  @MainActor
  func testInAppBackSkipsTheButtonLookupOnAPenalizedChannel() throws {
    _ = try launchBackNavigationFixture(["--agent-device-back-navigation-bar"])
    defer { endBackFixture() }
    penalizeSnapshotXCTestChannel(bundleId: mainOwned.bundleId, reason: "navigation-test")
    defer { clearSnapshotXCTestChannelPenalty(reason: "navigation-test") }

    _ = try performInAppBack(app: app)

    let trace = try XCTUnwrap(lastNavigationBarBackTraceForTesting)
    XCTAssertEqual(trace.found, "skipped")
    XCTAssertFalse(trace.pressed, "back answered from the swipe path")
    XCTAssertEqual(trace.lookupMs, 0)
  }

  /// An XCTest issue in every read after a delivered tap proves nothing: back answers unverified and
  /// never swipes after the tap. An escaped issue would fail this test.
  @MainActor
  func testInAppBackWithAnIssueInTheConfirmationAnswersUnverified() throws {
    let status = try launchBackNavigationFixture(["--agent-device-back-navigation-bar"])
    defer { endBackFixture() }
    navigationBarBackReadForTesting = { $0 == .lookup ? nil : Self.vanishedBackButtonIssue }
    defer { navigationBarBackReadForTesting = nil }

    let response = try execute(command: try runnerCommandFixture(
      #"{"command":"backInApp","commandId":"back-confirmation-issue","appBundleId":"com.callstack.agentdevice.runner"}"#
    ))

    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.backSwipeUnverified)
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.pressed, true)
    navigationBarBackReadForTesting = nil
    let popped = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Back pressed"), object: status)
    XCTAssertEqual(XCTWaiter().wait(for: [popped], timeout: 5), .completed, "the tap itself was delivered")
  }

  /// A slow host can spend the whole confirmation budget on reads of the bar that is vanishing mid-pop,
  /// each one an issue that proves nothing. Every read that starts in the budget fails here, so only
  /// the read after the budget, which sees the settled screen, can confirm the pop.
  @MainActor
  func testInAppBackConfirmsAPopWhoseReadsInTheBudgetAllFail() throws {
    _ = try launchBackNavigationFixture(["--agent-device-back-navigation-bar"])
    defer { endBackFixture() }
    var budgetReads = 0
    var finalReads = 0
    navigationBarBackReadForTesting = { phase in
      switch phase {
      case .lookup: return nil
      case .confirmation:
        budgetReads += 1
        return Self.vanishedBackButtonIssue
      case .finalConfirmation:
        finalReads += 1
        return nil
      }
    }
    defer { navigationBarBackReadForTesting = nil }

    guard case .performed = try performInAppBack(app: app) else {
      return XCTFail("a pop read after the budget must read as performed")
    }
    XCTAssertGreaterThan(budgetReads, 0, "the reads in the budget ran and failed")
    XCTAssertEqual(finalReads, 1, "the one read after the budget confirmed the pop")
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.confirmed, "yes")
  }

  /// A bar button titled "Back" is not the system back button, so back never presses it: it swipes,
  /// and the swipe that changes nothing reports so.
  @MainActor
  func testInAppBackNeverPressesABarButtonOnlyTitledBack() throws {
    let status = try launchBackNavigationFixture(["--agent-device-back-navigation-bar", "--custom-back-item"])
    defer { endBackFixture() }

    guard case .unconfirmed(let payload) = try performInAppBack(app: app) else {
      return XCTFail("a bar button titled Back must not count as the back button")
    }
    XCTAssertEqual(payload.code, RunnerWireErrorCode.backSwipeNoChange)
    XCTAssertEqual(status.label, "Navigation root")
  }

  @MainActor
  func testInAppBackDoesNotSwipeOffTheLitPanel() throws {
    let status = try launchBackFixture(["--agent-device-back-regression"])
    defer {
      setRequestLitPanel(from: try! runnerCommandFixture(#"{"command":"uptime"}"#))
      endBackFixture()
    }
    setRequestLitPanel(from: try runnerCommandFixture(
      #"{"command":"backInApp","litPanel":{"displayId":999,"widthPt":669,"heightPt":951}}"#
    ))
    XCTAssertThrowsError(try performInAppBack(app: app)) {
      XCTAssertEqual($0 as? RunnerAppScreenCaptureFailure, .offLitPanel)
    }
    assertBackNeverPerformed(status)
  }

  /// A hidden status bar (landscape, full-screen video, an RN screen that hides it) changes nothing:
  /// the comparison always leaves the same top band out, so back swipes and verifies as anywhere else.
  @MainActor
  func testInAppBackWithAHiddenStatusBarIsPerformed() throws {
    let status = try launchBackFixture(["--agent-device-back-regression", "--hide-status-bar"])
    defer { endBackFixture() }

    guard case .performed = try performInAppBack(app: app) else {
      return XCTFail("a screen without a status bar must still swipe and verify")
    }
    XCTAssertEqual(status.label, "Back performed")
  }

  /// The route witness: after the app's tree rejects the windows query, back reaches the screen
  /// through whichever route opens (the sole screen where the app proves it fills it), swipes, and
  /// verifies the change there.
  @MainActor
  func testInAppBackAfterARejectedQuerySwipesAndVerifiesOnTheRouteThatOpens() throws {
    let status = try launchBackFixture(["--agent-device-back-regression"])
    defer { endBackFixture() }

    let outcome = try withRejectedAppTree(framesReadable: true, rejections: 1) {
      try performInAppBack(app: app)
    }

    guard case .performed = outcome else {
      return XCTFail("back must swipe and verify through the route that opens after a rejected query")
    }
    XCTAssertEqual(status.label, "Back performed")
  }

#if targetEnvironment(simulator)
  /// A slow host: every capture takes 0.3 s and resolving the edge touch takes 0.8 s. The touch is
  /// resolved before the sample the change is measured from, and the screen settles for as long as
  /// the gap a slow capture makes, so a real pop on a still screen reads as performed.
  @MainActor
  func testInAppBackOnASlowHostWithAStillScreenIsPerformed() throws {
    let status = try launchBackFixture(["--agent-device-back-regression"])
    defer { endBackFixture() }
    var slowCaptures = 0
    let restoreCapture = try slowScreenshots(by: 0.3) { slowCaptures += 1 }
    defer { restoreCapture() }
    let restorePreparation = try slowEdgeTouchPreparation(by: 0.8)
    defer { restorePreparation() }

    let outcome = try performInAppBack(app: app)

    guard case .performed = outcome else {
      return XCTFail("a still screen on a slow host must read as performed, got \(outcome)")
    }
    XCTAssertEqual(status.label, "Back performed")
    XCTAssertGreaterThanOrEqual(slowCaptures, 4, "settle, just-before, and after samples were all slowed")
  }

  /// A device's timing on the simulator's edge touch: every capture takes 0.4 s and the contact is
  /// delayed to 0.2 s, as long as a physical iPhone's capture and fling. The still span grows with the
  /// capture, so the pop reads as performed.
  @MainActor
  func testInAppBackWithSlowCapturesAndALongerContactIsPerformed() throws {
    let status = try launchBackFixture(["--agent-device-back-regression"])
    defer { endBackFixture() }
    let restoreCapture = try slowScreenshots(by: 0.4) {}
    defer { restoreCapture() }
    let restoreContact = try slowEdgeTouchContact(by: 0.1)
    defer { restoreContact() }

    let outcome = try performInAppBack(app: app)

    guard case .performed = outcome else {
      return XCTFail("0.4 s captures and a 0.2 s contact on a still screen must read as performed, got \(outcome)")
    }
    XCTAssertEqual(status.label, "Back performed")
  }

  /// The guard still holds: a contact that outruns the time the screen had been still reports an
  /// unknown outcome even though the screen changed.
  @MainActor
  func testInAppBackWhoseContactOutrunsTheStillSpanIsUnverified() throws {
    let status = try launchBackFixture(["--agent-device-back-regression"])
    defer { endBackFixture() }
    let restoreContact = try slowEdgeTouchContact(by: 1.5)
    defer { restoreContact() }

    guard case .unconfirmed(let payload) = try performInAppBack(app: app) else {
      return XCTFail("a gap longer than the still span must not read as performed")
    }
    XCTAssertEqual(payload.code, RunnerWireErrorCode.backSwipeUnverified)
    XCTAssertTrue(payload.message.contains("longer than the screen had been still"))
    XCTAssertEqual(status.label, "Back performed", "the swipe itself still ran")
  }

  /// Delays every `XCUIScreen.screenshot` by `seconds`, calling `onCapture` for each.
  private func slowScreenshots(by seconds: TimeInterval, onCapture: @escaping () -> Void) throws -> () -> Void {
    let selector = #selector(XCUIScreen.screenshot)
    let method = try XCTUnwrap(class_getInstanceMethod(XCUIScreen.self, selector))
    let original = method_getImplementation(method)
    let slowed = imp_implementationWithBlock({ (target: AnyObject) -> AnyObject in
      onCapture()
      Thread.sleep(forTimeInterval: seconds)
      typealias Screenshot = @convention(c) (AnyObject, Selector) -> AnyObject
      return unsafeBitCast(original, to: Screenshot.self)(target, selector)
    } as @convention(block) (AnyObject) -> AnyObject)
    method_setImplementation(method, slowed)
    return {
      method_setImplementation(method, original)
      imp_removeBlock(slowed)
    }
  }

  /// Delays resolving the edge touch (display, HID client, touchscreen sender) by `seconds`.
  private func slowEdgeTouchPreparation(by seconds: TimeInterval) throws -> () -> Void {
    let selector = NSSelectorFromString("prepareWithApplication:resolvedWindow:failure:")
    let method = try XCTUnwrap(class_getClassMethod(RunnerSimulatorEdgeTouch.self, selector))
    let original = method_getImplementation(method)
    typealias Prepare = @convention(c) (
      AnyObject, Selector, AnyObject, AnyObject?, AutoreleasingUnsafeMutablePointer<NSString?>
    ) -> AnyObject?
    let slowed = imp_implementationWithBlock({ (
      target: AnyObject, application: AnyObject, window: AnyObject?, failure: AutoreleasingUnsafeMutablePointer<NSString?>
    ) -> AnyObject? in
      Thread.sleep(forTimeInterval: seconds)
      return unsafeBitCast(original, to: Prepare.self)(target, selector, application, window, failure)
    } as @convention(block) (AnyObject, AnyObject, AnyObject?, AutoreleasingUnsafeMutablePointer<NSString?>) -> AnyObject?)
    method_setImplementation(method, slowed)
    return {
      method_setImplementation(method, original)
      imp_removeBlock(slowed)
    }
  }

  /// Delays the edge touch's contact itself by `seconds`, before it goes down.
  private func slowEdgeTouchContact(by seconds: TimeInterval) throws -> () -> Void {
    let selector = NSSelectorFromString("dispatchSamples:screenSize:touchDown:")
    let method = try XCTUnwrap(class_getInstanceMethod(RunnerSimulatorEdgeTouch.self, selector))
    let original = method_getImplementation(method)
    typealias Dispatch = @convention(c) (AnyObject, Selector, NSArray, CGSize, UnsafeMutablePointer<ObjCBool>) -> NSString?
    let slowed = imp_implementationWithBlock({ (
      target: AnyObject, samples: NSArray, size: CGSize, touchDown: UnsafeMutablePointer<ObjCBool>
    ) -> NSString? in
      Thread.sleep(forTimeInterval: seconds)
      return unsafeBitCast(original, to: Dispatch.self)(target, selector, samples, size, touchDown)
    } as @convention(block) (AnyObject, NSArray, CGSize, UnsafeMutablePointer<ObjCBool>) -> NSString?)
    method_setImplementation(method, slowed)
    return {
      method_setImplementation(method, original)
      imp_removeBlock(slowed)
    }
  }
#endif

  /// Only a swipe refused before touch-down is the not-dispatched refusal; one cut short after its
  /// touch-down may have navigated and stays an unknown outcome.
  func testBackGestureRefusalSeparatesNotSentFromInterrupted() {
    XCTAssertNil(Self.backGestureRefusal(.sent))
    guard case .refused(let notSent) = Self.backGestureRefusal(.notSent(message: "no touchscreen", hint: nil)) else {
      return XCTFail("a swipe that never touched down must refuse as not dispatched")
    }
    XCTAssertEqual(notSent.code, RunnerWireErrorCode.backSwipeNotDispatched)
    guard case .unconfirmed(let interrupted) = Self.backGestureRefusal(.interrupted(message: "lift failed", hint: nil))
    else {
      return XCTFail("a swipe cut short after touch-down must not claim nothing was dispatched")
    }
    // It may already have navigated, so it is the unknown outcome, never a retryable refusal.
    XCTAssertEqual(interrupted.code, RunnerWireErrorCode.backSwipeUnverified)
    XCTAssertTrue(interrupted.hint?.contains("snapshot") == true)
  }

  /// Fails when the fixture reports a back within a short window, so a gesture the app handles
  /// after the call returned still fails the test.
  @MainActor
  private func assertBackNeverPerformed(_ status: XCUIElement) {
    let performed = expectation(for: NSPredicate(format: "label == %@", "Back performed"), evaluatedWith: status)
    performed.isInverted = true
    wait(for: [performed], timeout: 1)
  }

  /// Waits until `offset` seconds have passed since the `--slow-toggle` fixture's last repaint.
  private func waitForSlowToggleOffset(_ offset: TimeInterval) {
    let sinceRepaint = Date().timeIntervalSince1970.truncatingRemainder(dividingBy: Self.slowTogglePeriod)
    let wait = offset - sinceRepaint
    sleepFor(wait < 0 ? wait + Self.slowTogglePeriod : wait)
  }

  /// Launches the runner app and waits for its fixture surface. With
  /// `--agent-device-back-regression` a left-edge swipe sets the status to "Back performed", and
  /// without it the app ignores the swipe.
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
  static let vanishedBackButtonIssue = "Back button vanished during the navigation bar read"
  static let hungQueryIssue = "Timed out while evaluating UI query."

  /// Runs `body` and requires the hung query it records to reach XCTest exactly once.
  @MainActor
  private func expectingHungQueryRecorded<T>(_ body: () throws -> T) throws -> T {
    let options = XCTExpectedFailure.Options()
    var observed = 0
    options.issueMatcher = { issue in
      guard issue.compactDescription == Self.hungQueryIssue else { return false }
      observed += 1
      return true
    }
    var result: Result<T, Error>?
    XCTExpectFailure("The hung query is the condition under test", options: options) {
      result = Result { try body() }
    }
    XCTAssertEqual(observed, 1, "a hung query reaches XCTest once, and no query follows it")
    return try XCTUnwrap(result).get()
  }

  /// `back` presses a back button, confirms the pop, and the fixture's root reports it.
  @MainActor
  private func assertBackPressesTheButtonAndPops(_ status: XCUIElement, _ failure: String) throws {
    guard case .performed = try performInAppBack(app: app) else { return XCTFail(failure) }
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.found, "yes")
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.pressed, true)
    XCTAssertEqual(lastNavigationBarBackTraceForTesting?.confirmed, "yes")
    let popped = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Back pressed"), object: status)
    XCTAssertEqual(XCTWaiter().wait(for: [popped], timeout: 5), .completed)
  }

  @MainActor
  private func launchBackNavigationFixture(_ arguments: [String]) throws -> XCUIElement {
    app.launchArguments = arguments
    app.launch()
    mainOwned.app = app
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    clearSnapshotXCTestChannelPenalty(reason: "navigation-test")
    let ready = arguments.contains("--hidden-bar") ? app.buttons[Self.navigationBarBackButtonIdentifier] : app.navigationBars.firstMatch
    XCTAssertTrue(ready.waitForFixtureExistence(timeout: appExistenceTimeout))
    return app.staticTexts["agent-device-back-navigation-status"]
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
    _ body: () throws -> T
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
    return try body()
  }

#endif

  func testNavigationVisualObservationSeparatesChangeFromRefusal() {
    // A refused side makes the pair uncomparable, not "unchanged"; reading it as "unchanged" would
    // let a capture that refused become the reason `back` claims its swipe changed nothing.
    // When both refuse, the later refusal names what back last looked at before giving up.
    typealias Sample = Result<Data, RunnerAppScreenCaptureFailure>
    let refused: Sample = .failure(.unresolvedScreen)
    let windowless: Sample = .failure(.unresolvedWindow)
    let captured: Sample = .success(grid(0))
    let changed: Sample = .success(grid(255))
    let other: Sample = .success(grid(0))

    XCTAssertEqual(Self.navigationVisualObservation(before: captured, after: changed), .changed, "changed")
    XCTAssertEqual(Self.navigationVisualObservation(before: captured, after: captured), .unchanged, "unchanged")
    XCTAssertEqual(
      Self.navigationVisualObservation(before: refused, after: other),
      .unobserved(refusal: .unresolvedScreen),
      "before refused"
    )
    XCTAssertEqual(
      Self.navigationVisualObservation(before: other, after: windowless),
      .unobserved(refusal: .unresolvedWindow),
      "after refused"
    )
    XCTAssertEqual(
      Self.navigationVisualObservation(before: refused, after: windowless),
      .unobserved(refusal: .unresolvedWindow),
      "both refused: the later refusal wins"
    )
  }

  /// A back navigation redraws most of the screen; a spinner, a clock tick, or a low-contrast
  /// shimmer must not read as one, or as a screen that never settles.
  func testVisualSamplesDifferOnlyForNavigationSizedChange() {
    let base = grid(100)
    let below = Self.backCompareTopRowsIgnored * Self.visualGridSize.width
    var spinner = base
    for index in below..<(below + 20) { spinner[index] = 255 }
    let shimmer = grid(120)
    var pushed = base
    for index in below..<(below + 1500) { pushed[index] = 255 }

    XCTAssertFalse(Self.visualSamplesDiffer(base, spinner), "20 cells below the top band is not navigation")
    XCTAssertFalse(Self.visualSamplesDiffer(base, shimmer), "every cell moving by 20 stays inside the tolerance")
    XCTAssertTrue(Self.visualSamplesDiffer(base, pushed), "a third of the screen redrawn is navigation")
    XCTAssertTrue(Self.visualSamplesDiffer(base, base.dropLast()), "a different grid size is uncomparable")
  }

  /// The top band (status bar, clock, Dynamic Island) is never compared, so a clock tick or a status
  /// bar that appears or hides cannot count as a change, while the first row below it does.
  func testVisualSamplesIgnoreAChangeConfinedToTheTopBand() {
    let base = grid(100)
    let band = Self.backCompareTopRowsIgnored * Self.visualGridSize.width
    var clockTick = base
    for index in 0..<band { clockTick[index] = 255 }
    var firstRowBelow = base
    for index in band..<(band + Self.visualGridSize.width) { firstRowBelow[index] = 255 }

    XCTAssertFalse(Self.visualSamplesDiffer(base, clockTick), "every cell of the top band changed")
    XCTAssertTrue(Self.visualSamplesDiffer(base, firstRowBelow), "one full row below the band is over 1%")
  }

  /// The grid's first row is the top of the screen, so the ignored band is where the status bar is.
  func testVisualGridKeepsTheTopOfTheScreenFirst() throws {
    let width = 120, height = 240
    let context = try XCTUnwrap(CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
    ))
    context.setFillColor(gray: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(gray: 1, alpha: 1)
    // CoreGraphics' origin is bottom-left, so the top 10% of the image is the high-y strip.
    context.fill(CGRect(x: 0, y: CGFloat(height) * 0.9, width: CGFloat(width), height: CGFloat(height) * 0.1))
    let image = try XCTUnwrap(context.makeImage())

    let cells = try XCTUnwrap(Self.visualGrid(of: image))

    XCTAssertGreaterThan(cells[0], 200, "the first grid row is the top of the screen")
    XCTAssertLessThan(cells[cells.count - 1], 50, "the last grid row is the bottom")
  }

  private func grid(_ value: UInt8) -> Data {
    Data(repeating: value, count: Self.visualGridSize.width * Self.visualGridSize.height)
  }

  /// The runner's back swipe and the host's `right-edge` preset read the same golden table.
  func testBackSwipeEndpointsMatchTheHostRightEdgePreset() throws {
    let cases = try XCTUnwrap(runnerContractFixture("back-swipe-geometry.json") as? [[String: Any]])
    XCTAssertFalse(cases.isEmpty)
    func point(_ value: Any?) throws -> CGPoint {
      let object = try XCTUnwrap(value as? [String: Double])
      return CGPoint(x: try XCTUnwrap(object["x"]), y: try XCTUnwrap(object["y"]))
    }
    for fixture in cases {
      let name = fixture["name"] as? String ?? "?"
      let surface = try XCTUnwrap(fixture["surface"] as? [String: Double], name)
      let rect = CGRect(
        x: try XCTUnwrap(surface["x"]), y: try XCTUnwrap(surface["y"]),
        width: try XCTUnwrap(surface["width"]), height: try XCTUnwrap(surface["height"])
      )
      let endpoints = Self.backSwipeEndpoints(in: rect)
      XCTAssertEqual(endpoints.start, try point(fixture["start"]), name)
      XCTAssertEqual(endpoints.end, try point(fixture["end"]), name)
      XCTAssertEqual(Self.backSwipeDurationMs, fixture["durationMs"] as? Double, name)
    }
  }

  /// A swipe whose gap outran the time the screen had been still cannot tell its effect from a
  /// self-repaint slower than the window.
  func testBackSwipeGapIsCoveredOnlyByAsLongAStillWindow() {
    XCTAssertTrue(Self.backSwipeGapIsCovered(stableSinceMs: 0, justBeforeMs: 600, afterMs: 1100))
    XCTAssertTrue(Self.backSwipeGapIsCovered(stableSinceMs: 0, justBeforeMs: 600, afterMs: 1200))
    XCTAssertFalse(Self.backSwipeGapIsCovered(stableSinceMs: 0, justBeforeMs: 600, afterMs: 1300))
  }

  /// The still span grows with the slowest capture, so the gap a slow capture makes stays covered.
  func testBackSwipeRequiredStillSpanGrowsWithTheSlowestCapture() {
    let fast = Self.backSwipeRequiredStillMs(maxCaptureMs: 100)
    let slow = Self.backSwipeRequiredStillMs(maxCaptureMs: 600)
    XCTAssertEqual(slow - fast, 500)
    XCTAssertGreaterThanOrEqual(slow, Self.backSwipeDurationMs + Self.backSwipeVerificationDelay * 1000 + 600)
  }

  /// The `--slow-toggle` fixture's repaint period; it repaints on whole multiples of it of the wall
  /// clock, which this process shares.
  static let slowTogglePeriod: TimeInterval = 0.45

  /// The still span outlasts a 0.5 s self-repaint at a simulator's 0.1 s capture, and the
  /// `--slow-toggle` fixture's period by at least 100 ms. It stays longer than the after-sample gap
  /// (contact, verification delay, capture), whatever the delay.
  func testBackSwipeRequiredStillSpanOutlastsAHalfSecondRepaint() {
    let required = Self.backSwipeRequiredStillMs(maxCaptureMs: 100)
    XCTAssertGreaterThan(required, 500)
    XCTAssertGreaterThanOrEqual(required, Self.slowTogglePeriod * 1000 + 100)
    XCTAssertEqual(required, Self.backGestureAllowanceMs + Self.backSwipeStillMarginMs + 100)
    XCTAssertGreaterThan(required, Self.backGestureAllowanceMs + Self.backSwipeVerificationDelay * 1000 + 100)
  }

#if os(iOS)
  /// #3899: a placed iPad window's snapshot frames start at the window's own origin, while the live
  /// button frame is in screen points. The still bar holds the live button only through the window's
  /// screen origin.
  func testNavigationBarBackStateHoldsTheLiveButtonOfAPlacedWindow() {
    let snapshotButton = CGRect(x: 8, y: 54, width: 44, height: 44)
    let state = NavigationBarBackState(barCount: 1, backButtonLabels: ["Root"], backButtonFrames: [snapshotButton])
    let placed = SurfaceGeometry(
      windowOnScreen: SurfaceRect(CGRect(x: 224, y: 128, width: 386, height: 954)),
      panelNativeSize: nil,
      orientation: RunnerInterfaceOrientation.portrait
    )
    let liveButton = CGRect(x: 232, y: 182, width: 44, height: 44)

    XCTAssertTrue(Self.navigationBarBackState(state, holdsButton: liveButton, geometry: placed))
    XCTAssertFalse(Self.navigationBarBackState(state, holdsButton: snapshotButton, geometry: placed))

    let fullScreen = SurfaceGeometry(
      windowOnScreen: SurfaceRect(CGRect(x: 0, y: 0, width: 402, height: 874)),
      panelNativeSize: nil,
      orientation: RunnerInterfaceOrientation.portrait
    )
    XCTAssertTrue(Self.navigationBarBackState(state, holdsButton: snapshotButton, geometry: fullScreen))
  }

  /// After the tap, only a change of the bar count, the back button count, a back button label, or,
  /// for a back button with no label, a bar title shows a pop. A back button that only moved, such as by a large-title collapse, shows none, but
  /// it is never a still bar before the tap.
  func testNavigationBarBackPoppedOnlyOnABarBackButtonOrUnlabeledBarTitleChange() {
    let button = CGRect(x: 8, y: 54, width: 44, height: 44)
    let detail = NavigationBarBackState(barCount: 1, backButtonLabels: ["Root"], backButtonFrames: [button])

    let moved = NavigationBarBackState(barCount: 1, backButtonLabels: ["Root"], backButtonFrames: [button.offsetBy(dx: 0, dy: 30)])
    XCTAssertFalse(Self.navigationBarBackPopped(from: detail, to: moved))
    XCTAssertNotEqual(moved, detail)
    let relabeled = NavigationBarBackState(barCount: 1, backButtonLabels: ["Settings"], backButtonFrames: [button])
    XCTAssertTrue(Self.navigationBarBackPopped(from: detail, to: relabeled))
    let atRoot = NavigationBarBackState(barCount: 1, backButtonLabels: [], backButtonFrames: [])
    XCTAssertTrue(Self.navigationBarBackPopped(from: detail, to: atRoot))
    let barGone = NavigationBarBackState(barCount: 0, backButtonLabels: [], backButtonFrames: [])
    XCTAssertTrue(Self.navigationBarBackPopped(from: atRoot, to: barGone))

    // A back button with no label shows a pop only through the bar title.
    let unlabeled = NavigationBarBackState(barCount: 1, backButtonLabels: [""], backButtonFrames: [button], barTitles: ["About"])
    let unlabeledPopped = NavigationBarBackState(barCount: 1, backButtonLabels: [""], backButtonFrames: [button], barTitles: ["General"])
    XCTAssertTrue(Self.navigationBarBackPopped(from: unlabeled, to: unlabeledPopped))
    XCTAssertTrue(unlabeled.canShowAPop)
    // Without a bar title an unlabeled button could never confirm its pop, so it is not tapped.
    XCTAssertFalse(NavigationBarBackState(barCount: 1, backButtonLabels: [""], backButtonFrames: [button], barTitles: [""]).canShowAPop)
    XCTAssertTrue(NavigationBarBackState(barCount: 1, backButtonLabels: ["Root"], backButtonFrames: [button]).canShowAPop)
  }

  /// The Duo's floating back button (measured on iOS 27.1 in all three poses) and an iPhone's button
  /// inside its bar belong to a bar. A content button far below the bar, or outside the bar's
  /// horizontal span, does not.
  func testBackButtonBelongsToABarOnlyWhenItIsByTheBar() {
    XCTAssertTrue(Self.backButtonBelongsToABar(
      CGRect(x: 884, y: 125, width: 38, height: 38), barFrames: [CGRect(x: 0, y: 24, width: 951, height: 58)], windowHeight: 669))
    XCTAssertTrue(Self.backButtonBelongsToABar(
      CGRect(x: 399, y: 175, width: 38, height: 38), barFrames: [CGRect(x: 0, y: 24, width: 466, height: 58)], windowHeight: 678))
    XCTAssertTrue(Self.backButtonBelongsToABar(
      CGRect(x: 8, y: 60, width: 44, height: 44), barFrames: [CGRect(x: 0, y: 54, width: 402, height: 44)], windowHeight: 874))
    let bar = CGRect(x: 0, y: 54, width: 402, height: 44)
    XCTAssertFalse(Self.backButtonBelongsToABar(CGRect(x: 8, y: 700, width: 44, height: 44), barFrames: [bar], windowHeight: 874))
    XCTAssertFalse(Self.backButtonBelongsToABar(CGRect(x: 8, y: 20, width: 44, height: 20), barFrames: [bar], windowHeight: 874))
    XCTAssertFalse(Self.backButtonBelongsToABar(
      CGRect(x: 500, y: 60, width: 44, height: 44), barFrames: [CGRect(x: 0, y: 54, width: 320, height: 44)], windowHeight: 874))
    XCTAssertFalse(Self.backButtonBelongsToABar(CGRect(x: 8, y: 60, width: 44, height: 44), barFrames: [], windowHeight: 874))
  }
#endif

  /// A still screen settles before the budget runs out at any capture time: the settle loop's
  /// timeline, replayed with fixed captures, reaches the required still span first. On a simulator
  /// the base budget holds; a 1 s capture extends it.
  func testBackSwipeSettleBudgetLetsAStillScreenSettleOnASlowHost() {
    XCTAssertEqual(Self.backSwipeSettleBudgetMs(maxCaptureMs: 100), Self.backSwipeSettleBaseBudgetMs)
    for captureMs in stride(from: 50.0, through: 2000.0, by: 50.0) {
      let required = Self.backSwipeRequiredStillMs(maxCaptureMs: captureMs)
      let budget = Self.backSwipeSettleBudgetMs(maxCaptureMs: captureMs)
      var now = captureMs
      let runStart = now
      while now - runStart < required {
        XCTAssertLessThan(now, budget, "capture \(captureMs) ms ran out of budget before settling")
        now += Self.backSwipeSettleSampleInterval * 1000 + captureMs
      }
    }
  }

  func testBackSwipeOutcomeNamesNoChangeAndAnUnsampledScreenApart() {
    switch Self.backSwipeOutcome(observation: .unchanged) {
    case .unconfirmed(let payload):
      XCTAssertEqual(payload.code, RunnerWireErrorCode.backSwipeNoChange)
    case .performed, .refused:
      XCTFail("an unchanged screen must refuse with the no-change reason")
    }
    // A screen that refused to be sampled after the swipe is an unknown outcome, never a success.
    switch Self.backSwipeOutcome(observation: .unobserved(refusal: .unresolvedWindow)) {
    case .unconfirmed(let payload):
      XCTAssertEqual(payload.code, RunnerWireErrorCode.backSwipeUnverified)
      XCTAssertEqual(payload.hint, RunnerAppScreenCaptureFailure.unresolvedWindow.hint)
      XCTAssertTrue(payload.message.contains("unknown outcome"))
    case .performed, .refused:
      XCTFail("an unsampled screen after the swipe must report an unknown outcome")
    }
  }

  func testNavigationVisualSampleDistinguishesEncodedFrameFromRefusal() {
    // The same capture entry point yields three different answers, and only the refusals carry a
    // reason: an encoded frame is evidence, a resolved-but-unencodable image and a refusal are not.
    // Reverting the mapping to a plain no-sample loses the code a host keys on.
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
