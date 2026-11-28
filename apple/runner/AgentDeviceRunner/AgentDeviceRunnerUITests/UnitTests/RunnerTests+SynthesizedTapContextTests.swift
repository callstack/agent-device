import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

extension RunnerTests {
  /// Whether this device takes the coordinate tap's deferred route: an iPhone with one screen.
  private var tapDefersTheWindowQuery: Bool {
    UIDevice.current.userInterfaceIdiom == .phone && XCUIScreen.screens.count == 1
  }

  /// Runs `body` while counting every XCTest element query that lists its matches.
  func countingElementQueries<T>(_ body: () throws -> T) throws -> (result: T, queries: Int) {
    let selector = #selector(getter: XCUIElementQuery.allElementsBoundByIndex)
    let query = try XCTUnwrap(class_getInstanceMethod(XCUIElementQuery.self, selector))
    let originalQuery = method_getImplementation(query)
    var queries = 0
    let countedQuery = imp_implementationWithBlock({ (target: AnyObject) -> NSArray in
      queries += 1
      typealias Query = @convention(c) (AnyObject, Selector) -> NSArray
      return unsafeBitCast(originalQuery, to: Query.self)(target, selector)
    } as @convention(block) (AnyObject) -> NSArray)
    method_setImplementation(query, countedQuery)
    defer {
      method_setImplementation(query, originalQuery)
      imp_removeBlock(countedQuery)
    }
    let result = try body()
    return (result, queries)
  }

  /// An iPhone coordinate tap books the screen, in the app's orientation, as its window without
  /// a windows query, and that screen is the frame the windows query names.
  @MainActor
  func testCoordinateTapOnASoleScreenPhoneBooksTheScreenWithoutAWindowsQuery() throws {
    guard tapDefersTheWindowQuery else { return }
    app.launch()
    mainOwned.app = app
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let windowContext = try XCTUnwrap(try synthesizedCoordinateContext(app: app))
    XCTAssertNotNil(windowContext.resolvedWindow, "the fixture tree must name its window")

    let (booked, queries) = try countingElementQueries { deferredWindowTapContext(app: app) }
    let tapContext = try XCTUnwrap(booked)

    XCTAssertEqual(queries, 0, "the tap's context runs no windows query")
    guard case .deferred = tapContext.windowSource else {
      return XCTFail("the tap defers its windows query: \(tapContext.windowSource)")
    }
    XCTAssertNil(tapContext.dispatchWindow)
    XCTAssertFalse(tapContext.treeUnreadable, "nothing proved the tree unreadable")
    XCTAssertEqual(tapContext.accessibilityHealth, windowContext.accessibilityHealth)
    XCTAssertEqual(tapContext.geometry.windowOnScreen.rect, windowContext.geometry.windowOnScreen.rect)
    XCTAssertEqual(tapContext.geometry.orientation, windowContext.geometry.orientation)
  }

  /// A tap synthesis that fails runs the deferred windows query before the fallback decision: a tree
  /// that answers a window still takes the XCTest coordinate tap, one that answers none refuses it,
  /// exactly as when the query ran before the tap.
  @MainActor
  func testFailedTapSynthesisProvesTheTreeBeforeChoosingTheXCTestFallback() throws {
    guard tapDefersTheWindowQuery else { return }
    app.launch()
    mainOwned.app = app
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let failing: () throws -> RunnerInteractionOutcome? = {
      .unsupported(message: "injected synthesis failure", hint: nil)
    }

    let readable = try XCTUnwrap(deferredWindowTapContext(app: app))
    let (readableAttempt, readableQueries) = try countingElementQueries {
      try performSynthesizedGesture(app, kind: .coordinateTap, context: readable, synthesize: failing)
    }
    guard case .xctestFallback = readableAttempt else {
      return XCTFail("a readable tree keeps the XCTest fallback: \(readableAttempt)")
    }
    XCTAssertGreaterThan(readableQueries, 0, "the fallback decision ran the deferred windows query")

    let restoreXCTest = try simulateUnserializableAppTree()
    defer { restoreXCTest() }
    let unreadable = try XCTUnwrap(deferredWindowTapContext(app: app))
    guard case .deferred = unreadable.windowSource else { return XCTFail("the tap defers its windows query") }
    guard case .refused = try performSynthesizedGesture(
      app, kind: .coordinateTap, context: unreadable, synthesize: failing
    ) else {
      return XCTFail("a tree that answers no window refuses the XCTest fallback")
    }

    XCTAssertTrue(
      Self.synthesizedGesturePolicyLine(kind: .coordinateTap, context: unreadable, fallbackAttempted: false)
        .contains(" fallbackAllowed=unproven "),
      "a deferred context logs no fallback decision it has not proven"
    )
    let proven = provingDeferredWindowQuery(unreadable, app: app)
    guard case .soleScreen = proven.windowSource else { return XCTFail("a tree with no window is unreadable") }
    XCTAssertEqual(proven.accessibilityHealth, .unavailable)
    XCTAssertTrue(
      Self.synthesizedGesturePolicyLine(kind: .coordinateTap, context: proven, fallbackAttempted: false)
        .contains(" fallbackAllowed=false ")
    )
  }

  /// A resolved window that fills an iPhone's only screen routes its records to that screen, so
  /// dispatch does not re-read the window; the window stays on the context for its other reads.
  @MainActor
  func testAWindowFillingASoleScreenPhoneRoutesRecordsToTheScreen() throws {
    guard tapDefersTheWindowQuery else { return }
    app.launch()
    mainOwned.app = app
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let context = try XCTUnwrap(try synthesizedCoordinateContext(app: app))
    guard case .resolved(_, fillsSoleScreen: true) = context.windowSource else {
      return XCTFail("the fixture window fills the screen: \(context.windowSource)")
    }
    XCTAssertNotNil(context.resolvedWindow)
    XCTAssertNil(context.dispatchWindow)
    XCTAssertEqual(soleScreenReferenceFrame(app: app, phoneOnly: true), context.geometry.windowOnScreen.rect)
  }

  /// The coordinate tap command itself, with the daemon's evidence that no text input is under the
  /// point, taps through the deferred route: the tap lands, and no windows query runs from
  /// preparation to response.
  @MainActor
  func testCoordinateTapCommandOnASoleScreenPhoneLandsWithoutAWindowsQuery() throws {
    guard tapDefersTheWindowQuery else { return }
    app.launchArguments = ["--agent-device-text-entry-regression", "--agent-device-text-entry-tap-witness"]
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.launchArguments = []
      app.terminate()
    }
    mainOwned.app = app
    mainOwned.bundleId = "com.callstack.agentdevice.runner"
    mainOwned.processIdentifier = try XCTUnwrap(Self.processIdentifier(of: app))
    clearSnapshotXCTestChannelPenalty(reason: "fresh-runner")
    let button = app.buttons["agent-device-tap-witness"]
    XCTAssertTrue(button.waitForFixtureExistence(timeout: appExistenceTimeout))
    let frame = button.frame
    let tap = try runnerCommandFixture(
      #"{"appBundleId":"com.callstack.agentdevice.runner","command":"tap","commandId":"tap-deferred-window","x":\#(frame.midX),"y":\#(frame.midY),"synthesized":true,"coordinateTapTextInputEvidence":{"targetBundleId":"com.callstack.agentdevice.runner","point":{"x":\#(frame.midX),"y":\#(frame.midY)},"textInputRects":[]}}"#
    )
    let (response, queries) = try countingElementQueries {
      try executeOnMainPrepared(command: tap, activeApp: app, activeAppBundleId: "com.callstack.agentdevice.runner")
    }
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(queries, 0)
    XCTAssertEqual(app.staticTexts["agent-device-tap-witness-presses"].label, "presses=1")
  }

  /// A tap that synthesizes never needs the deferred query's answer, so it never runs it.
  @MainActor
  func testSynthesizedTapThatSucceedsRunsNoWindowsQuery() throws {
    guard tapDefersTheWindowQuery else { return }
    app.launch()
    mainOwned.app = app
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let context = try XCTUnwrap(deferredWindowTapContext(app: app))
    let (attempt, queries) = try countingElementQueries {
      try performSynthesizedGesture(app, kind: .coordinateTap, context: context) { .performed }
    }
    guard case .performed = attempt else { return XCTFail("the tap was performed: \(attempt)") }
    XCTAssertEqual(queries, 0)
  }
}
#endif
