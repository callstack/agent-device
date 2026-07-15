import XCTest

extension RunnerTests {
  static let navigationBackKeywords = ["back", "close", "cancel"]
  static let navigationFallbackVerificationDelay: TimeInterval = 0.25

  func tapInAppBackControl(app: XCUIApplication) -> Bool {
#if os(macOS)
    if let back = macOSNavigationBackElement(app: app) {
      tapElementCenter(app: app, element: back)
      return true
    }
    return false
#elseif os(tvOS)
    _ = pressTvRemote(.menu)
    return true
#else
    let buttons = app.navigationBars.buttons.allElementsBoundByIndex
    if let back = buttons.first(where: { $0.isHittable }) {
      back.tap()
      return true
    }
    if isSnapshotXCTestChannelPenalized(bundleId: currentBundleId) {
      NSLog("AGENT_DEVICE_RUNNER_IN_APP_BACK_SKIPPED_XCTEST_ENUMERATION bundle=%@", currentBundleId ?? "")
    } else if let back = topNavigationBackElement(app: app) {
      tapElementCenter(app: app, element: back)
      return true
    }
    return tapTopLeadingNavigationFallback(app: app)
#endif
  }

  private func tapElementCenter(app: XCUIApplication, element: XCUIElement) {
    let frame = element.frame
    if !frame.isEmpty {
      _ = tapAt(app: app, x: frame.midX, y: frame.midY)
      return
    }
#if !os(tvOS)
    element.tap()
#endif
  }

  private func topNavigationBackElement(app: XCUIApplication) -> XCUIElement? {
#if os(iOS)
    let frame = onScreenWindowFrame(app: app)
    let candidates = app.buttons.matching(Self.navigationBackPredicate()).allElementsBoundByIndex.compactMap {
      element -> (XCUIElement, Int)? in
      guard element.exists, element.isHittable else { return nil }
      guard Self.isTopNavigationControlFrame(element.frame, in: frame) else { return nil }
      guard let rank = Self.navigationBackControlRank(
        label: element.label,
        identifier: element.identifier
      ) else {
        return nil
      }
      return (element, rank)
    }
    return candidates.sorted { lhs, rhs in
      if lhs.1 != rhs.1 { return lhs.1 < rhs.1 }
      let leftFrame = lhs.0.frame
      let rightFrame = rhs.0.frame
      if leftFrame.minY != rightFrame.minY { return leftFrame.minY < rightFrame.minY }
      return leftFrame.minX < rightFrame.minX
    }.first?.0
#else
    return nil
#endif
  }

  static func navigationBackPredicate() -> NSPredicate {
    let clauses = navigationBackKeywords.flatMap { _ in
      ["label CONTAINS[c] %@", "identifier CONTAINS[c] %@"]
    }.joined(separator: " OR ")
    let arguments = navigationBackKeywords.flatMap { [$0, $0] }
    return NSPredicate(format: clauses, argumentArray: arguments)
  }

  static func navigationBackControlRank(label: String, identifier: String) -> Int? {
    let text = "\(label) \(identifier)".lowercased()
    return navigationBackKeywords.firstIndex { text.contains($0) }
  }

  static func isTopNavigationControlFrame(_ candidate: CGRect, in window: CGRect) -> Bool {
    guard
      candidate.width.isFinite,
      candidate.height.isFinite,
      window.width.isFinite,
      window.height.isFinite,
      candidate.width > 0,
      candidate.height > 0,
      window.width > 0,
      window.height > 0
    else {
      return false
    }
    // Accept the compact navigation/search header band without matching deep content controls.
    let maxY = window.minY + min(max(window.height * 0.22, 96), 180)
    return candidate.midY >= window.minY && candidate.midY <= maxY
  }

  static func topLeadingNavigationFallbackPoint(in frame: CGRect) -> CGPoint? {
    guard frame.width.isFinite, frame.height.isFinite, frame.width > 0, frame.height > 0 else {
      return nil
    }
    // Aim at the standard leading navigation slot, bounded for compact and tablet widths.
    let xOffset = min(max(frame.width * 0.08, 28), 44)
    // Sit below the status/dynamic-island region and inside common custom RN search headers.
    let yOffset = min(max(frame.height * 0.155, 56), 132)
    return CGPoint(x: frame.minX + xOffset, y: frame.minY + yOffset)
  }

  private func tapTopLeadingNavigationFallback(app: XCUIApplication) -> Bool {
#if os(iOS)
    let frame = onScreenWindowFrame(app: app)
    guard let point = Self.topLeadingNavigationFallbackPoint(in: frame) else {
      return false
    }
    let before = captureNavigationFallbackVisualState()
    let context = synthesizedCoordinateContext(
      policy: synthesizedGesturePolicy(.coordinateTap)
    )?.withReferenceFrame(frame)
    let synthesized = performGesture(app, idleTimeout: false) {
      synthesizedTapAt(app: app, x: point.x, y: point.y, context: context)
    }
    if case .performed = synthesized.outcome {
      return didNavigationFallbackChangeVisualState(before: before)
    }
    let fallback = performGesture(app) {
      tapAt(app: app, x: point.x, y: point.y)
    }
    if case .performed = fallback.outcome {
      return didNavigationFallbackChangeVisualState(before: before)
    }
#endif
    return false
  }

  private func captureNavigationFallbackVisualState() -> Data? {
#if os(iOS)
    runnerPngData(for: XCUIScreen.main.screenshot().image)
#else
    return nil
#endif
  }

  private func didNavigationFallbackChangeVisualState(before: Data?) -> Bool {
    sleepFor(Self.navigationFallbackVerificationDelay)
    let after = captureNavigationFallbackVisualState()
    let changed = Self.didNavigationFallbackChangeVisualState(before: before, after: after)
    if !changed {
      NSLog("AGENT_DEVICE_RUNNER_IN_APP_BACK_FALLBACK_NO_STATE_CHANGE")
    }
    return changed
  }

  static func didNavigationFallbackChangeVisualState(before: Data?, after: Data?) -> Bool {
    guard let before, let after else { return false }
    return before != after
  }

  private func macOSNavigationBackElement(app: XCUIApplication) -> XCUIElement? {
    let predicate = NSPredicate(
      format: "identifier == %@ OR label == %@",
      "go back",
      "Back"
    )
    let element = app.descendants(matching: .any).matching(predicate).firstMatch
    return element.exists ? element : nil
  }

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
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

  func testNavigationFallbackRequiresObservedVisualChange() {
    XCTAssertTrue(
      Self.didNavigationFallbackChangeVisualState(
        before: Data([1, 2, 3]),
        after: Data([1, 2, 4])
      )
    )
    XCTAssertFalse(
      Self.didNavigationFallbackChangeVisualState(
        before: Data([1, 2, 3]),
        after: Data([1, 2, 3])
      )
    )
    XCTAssertFalse(Self.didNavigationFallbackChangeVisualState(before: nil, after: Data([1])))
    XCTAssertFalse(Self.didNavigationFallbackChangeVisualState(before: Data([1]), after: nil))
  }
#endif
}
