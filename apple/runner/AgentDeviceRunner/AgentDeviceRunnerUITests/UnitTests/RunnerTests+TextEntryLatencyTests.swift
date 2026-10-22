import OSLog
import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  @MainActor
  func testConfirmedInputReadinessReturnsBeforeItsReadinessWindow() throws {
    app.launchArguments = ["--agent-device-text-entry-regression"]
    app.launch()
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForFixtureExistence(timeout: appExistenceTimeout))
    field.tap()
    XCTAssertTrue(keyboardFocusConfirmed(app: app, element: field))
    let failures = currentXCTestFailureCount()
    let startedAt = Date()
    waitForTextEntryReadinessAfterTap(app: app, element: field)
    let elapsed = Date().timeIntervalSince(startedAt)
    XCTAssertFalse(didRecordXCTestFailure(since: failures))
    XCTAssertTrue(keyboardFocusConfirmed(app: app, element: field))
    XCTAssertLessThan(elapsed, TextEntryTiming.readinessTimeout)
  }

  /// Each accessibility query snapshots the whole application. A query took about 90 ms on
  /// Bluesky's React Native Search screen (iPhone 17 Pro, iOS 27.0), so a fill's cost there is its
  /// query count. The fixture field counts how often XCTest reads its value, which it does once per
  /// query. Its value is masked, so the count does not depend on how many read-back polls fit in a
  /// stability window. This fill made 17 queries when each read served the reads after it until the
  /// next dispatch, and 35 when every attribute was read from the live element.
  @MainActor
  func testFillReadsEachResolvedFieldThroughOneSnapshot() throws {
    app.launchArguments = [
      "--agent-device-text-entry-regression",
      "--agent-device-text-entry-soft-keyboard",
      "--agent-device-text-entry-counts-value-reads",
    ]
    app.launch()
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForFixtureExistence(timeout: appExistenceTimeout))
    // With the keyboard already up, the focus step taps and returns without polling for focus, so
    // the count does not depend on how fast the keyboard appears.
    field.tap()
    try XCTSkipUnless(
      app.keyboards.firstMatch.waitForFixtureExistence(timeout: appExistenceTimeout),
      "software keyboard is down: this simulator cannot exercise the keyboard-visible fill branch"
    )
    let valueReads = app.staticTexts["agent-device-text-entry-value-reads"]
    let frame = field.frame
    let fill = try runnerCommandFixture(
      #"{"command":"type","commandId":"fill-counted-reads","text":"hello","textEntryMode":"replace","x":\#(frame.midX),"y":\#(frame.midY)}"#
    )

    let readsBefore = try XCTUnwrap(Int(valueReads.label))
    let response = executeTypeCommand(activeApp: app, command: fill)
    let readsAfter = try XCTUnwrap(Int(valueReads.label))

    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(response.data?.textEntryRoute, "xctest-element")
    XCTAssertEqual(valueReads.value as? String, "hello")
    XCTAssertLessThanOrEqual(readsAfter - readsBefore, 24)
  }

  /// An unbound target without a live element resolves through its refresh point's lookup, which
  /// has already snapshotted the input it finds. The resolution reads the app no more often than the
  /// lookup alone does.
  @MainActor
  func testUnboundResolutionReadsItsInputThroughThePointLookup() throws {
    app.launchArguments = ["--agent-device-text-entry-regression", "--agent-device-text-entry-counts-value-reads"]
    app.launch()
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForFixtureExistence(timeout: appExistenceTimeout))
    let valueReads = app.staticTexts["agent-device-text-entry-value-reads"]
    let frame = field.frame
    let point = CGPoint(x: frame.midX, y: frame.midY)
    func countingReads<T>(_ body: () -> T) throws -> (T, Int) {
      let before = try XCTUnwrap(Int(valueReads.label))
      let value = body()
      return (value, try XCTUnwrap(Int(valueReads.label)) - before)
    }
    let target = TextEntryTarget(element: nil, refreshPoint: point, prefersFocusedElement: false)

    let (lookup, lookupReads) = try countingReads { textInputAt(app: app, x: point.x, y: point.y) }
    let (input, resolutionReads) = try countingReads { resolveTextEntryInput(app: app, target: target) }

    XCTAssertEqual(lookup?.snapshot?.identifier, "agent-device-hardware-keyboard-input")
    XCTAssertEqual(input?.snapshot?.identifier, "agent-device-hardware-keyboard-input")
    XCTAssertEqual(resolutionReads, lookupReads)
  }

  /// After a focus tap raises the software keyboard, stabilization takes focus from the tapped
  /// input's own read before it asks for the keyboard. While the keyboard is presented, the keyboard
  /// query blocks and then finds none. The keyboard is already up here, so asking it first confirms
  /// focus from the keyboard's arrival instead.
  @MainActor
  func testFocusStabilizationAsksTheTappedInputBeforeTheKeyboard() throws {
    app.launchArguments = ["--agent-device-text-entry-regression", "--agent-device-text-entry-soft-keyboard"]
    app.launch()
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForFixtureExistence(timeout: appExistenceTimeout))
    field.tap()
    try XCTSkipUnless(
      app.keyboards.firstMatch.waitForFixtureExistence(timeout: appExistenceTimeout),
      "software keyboard is down: this simulator cannot show the keyboard a focus tap raises"
    )

    let stabilized = stabilizeTextInputBeforeTyping(app: app, target: field, keyboardVisibleBeforeTap: false)

    guard case .inputReportsKeyboardFocus(let read) = stabilized.evidence else {
      return XCTFail("focus confirmed by \(stabilized.evidence?.name ?? "nothing"), not by the tapped input")
    }
    XCTAssertEqual(read.snapshot?.frame, field.frame)
  }

  /// A fill whose focus tap raises the software keyboard hands the read that confirmed focus to the
  /// entry as its first read. The fixture counts queries as in
  /// `testFillReadsEachResolvedFieldThroughOneSnapshot`: this fill made 17, and 19 when the focus step
  /// or the entry read the input again. A read costs two queries. A keyboard that arrives before the
  /// field reports focus ends the poll without handing its read on, so the entry reads the input
  /// again and the fill makes 19 by design. The test skips when the log does not record
  /// `input-reports-keyboard-focus`, so its budget holds only for the route it is about.
  @MainActor
  func testFillThatRaisesTheSoftwareKeyboardReusesTheReadThatConfirmedFocus() throws {
    app.launchArguments = [
      "--agent-device-text-entry-regression",
      "--agent-device-text-entry-soft-keyboard",
      "--agent-device-text-entry-counts-value-reads",
    ]
    app.launch()
    defer { invalidateCachedTarget(reason: "unit_test_cleanup"); app.terminate() }
    XCTAssertTrue(app.waitForFixtureExistence(timeout: appExistenceTimeout))
    let field = app.textFields["agent-device-hardware-keyboard-input"]
    XCTAssertTrue(field.waitForFixtureExistence(timeout: appExistenceTimeout))
    XCTAssertFalse(isKeyboardVisible(app: app))
    let valueReads = app.staticTexts["agent-device-text-entry-value-reads"]
    let frame = field.frame
    let fill = try runnerCommandFixture(
      #"{"command":"type","commandId":"fill-raises-keyboard","text":"hello","textEntryMode":"replace","x":\#(frame.midX),"y":\#(frame.midY)}"#
    )

    let readsBefore = try XCTUnwrap(Int(valueReads.label))
    let fillStartedAt = Date()
    let response = executeTypeCommand(activeApp: app, command: fill)
    let readsAfter = try XCTUnwrap(Int(valueReads.label))

    try XCTSkipUnless(
      app.keyboards.firstMatch.waitForFixtureExistence(timeout: appExistenceTimeout),
      "software keyboard is down: this simulator did not raise the keyboard the focus tap asked for"
    )
    XCTAssertTrue(response.ok, String(describing: response.error))
    XCTAssertEqual(response.data?.textEntryRoute, "xctest-element")
    XCTAssertEqual(valueReads.value as? String, "hello")
    let evidence = try loggedTextEntryFocusEvidence(since: fillStartedAt)
    try XCTSkipUnless(
      evidence == "input-reports-keyboard-focus",
      "focus was confirmed by \(evidence ?? "nothing"), which reads the input again by design"
    )
    XCTAssertLessThanOrEqual(readsAfter - readsBefore, 17)
  }

  /// The evidence name the focus step logged to `runner.log` after `start`, read from this
  /// process's own log.
  private func loggedTextEntryFocusEvidence(since start: Date) throws -> String? {
    let store = try OSLogStore(scope: .currentProcessIdentifier)
    let marker = "AGENT_DEVICE_RUNNER_TEXT_ENTRY_FOCUS evidence="
    return try store.getEntries(at: store.position(date: start))
      .compactMap { ($0 as? OSLogEntryLog)?.composedMessage }
      .compactMap { message in message.range(of: marker).map { String(message[$0.upperBound...]) } }
      .last
  }
#endif
}
