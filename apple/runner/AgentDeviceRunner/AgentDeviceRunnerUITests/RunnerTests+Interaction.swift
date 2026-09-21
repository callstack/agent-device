import XCTest
import AgentDeviceSnapshotPresentation

#if os(macOS)
import CoreGraphics
#endif

private struct RunnerUnsupportedOperationError: LocalizedError {
  let message: String

  var errorDescription: String? { message }
}

extension RunnerTests {
  enum PlannedGestureExecution: Equatable {
    case fastSwipe
    case sampled
  }

  enum SynthesizedDragProfile: Equatable {
    case continuous
    case controlledScroll
    case fastSwipe
  }

  func scrollDragProfile(
    releaseBehavior: ScrollReleaseBehavior?
  ) -> SynthesizedDragProfile {
    releaseBehavior == .inertial ? .fastSwipe : .controlledScroll
  }

  struct TouchVisualizationFrame {
    let x: Double
    let y: Double
    let referenceWidth: Double
    let referenceHeight: Double
  }

  struct DragVisualizationFrame {
    let x: Double
    let y: Double
    let x2: Double
    let y2: Double
    let referenceWidth: Double
    let referenceHeight: Double
  }

  struct DragPoints {
    let x: Double
    let y: Double
    let x2: Double
    let y2: Double
  }

  struct SynthesizedDragPlan {
    let points: DragPoints
    let context: SynthesizedCoordinateContext

    var referenceFrame: CGRect {
      context.referenceFrame
    }
  }

  struct SelectorElementMatch {
    let element: XCUIElement?
    let isAmbiguous: Bool
    let usedNonHittableFallback: Bool
  }

  func performBackGesture(app: XCUIApplication) {
    if pressTvRemote(.menu) {
      return
    }
    performCoordinateBackGesture(app: app)
  }

  private func performCoordinateBackGesture(app: XCUIApplication) {
#if !os(tvOS)
    let target = app.windows.firstMatch.exists ? app.windows.firstMatch : app
    let start = target.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
    let end = target.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: end)
#endif
  }

  func performSystemBackAction(app: XCUIApplication) -> Bool {
#if os(macOS)
    return false
#else
    if pressTvRemote(.menu) {
      return true
    }
    performBackGesture(app: app)
    return true
#endif
  }

  func performAppSwitcherGesture(app: XCUIApplication) {
    if pressTvRemote(.home) {
      sleepFor(resolveTvRemoteDoublePressDelay())
      _ = pressTvRemote(.home)
      return
    }
    performCoordinateAppSwitcherGesture(app: app)
  }

  private func performCoordinateAppSwitcherGesture(app: XCUIApplication) {
#if !os(tvOS)
    let target = app.windows.firstMatch.exists ? app.windows.firstMatch : app
    let start = target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.99))
    let end = target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
    start.press(forDuration: 0.6, thenDragTo: end)
#endif
  }

  func pressHomeButton() {
#if os(macOS)
    return
#else
    if pressTvRemote(.home) {
      return
    }
    XCUIDevice.shared.press(.home)
#endif
  }

  /// Presses the iPhone Action Button, returning false when this device cannot express the press.
  ///
  /// `XCUIDevice.press(_:)` has no hold-duration overload, so a single press is the whole gesture
  /// this API can express. `hasHardwareButton(.action)` is what separates a model with the button
  /// from one without, and both it and `Button.action` need iOS 16 while the deployment target is
  /// lower, so an older system refuses rather than pressing a control that cannot exist there.
  @discardableResult
  func pressActionButton() -> Bool {
#if os(iOS)
    guard #available(iOS 16.0, *) else { return false }
    guard XCUIDevice.shared.hasHardwareButton(.action) else { return false }
    XCUIDevice.shared.press(.action)
    return true
#else
    return false
#endif
  }

  func findElement(app: XCUIApplication, text: String) -> XCUIElement? {
    let predicate = NSPredicate(format: "label CONTAINS[c] %@ OR identifier CONTAINS[c] %@ OR value CONTAINS[c] %@", text, text, text)
    let element = app.descendants(matching: .any).matching(predicate).firstMatch
    return element.exists ? element : nil
  }

  func findElement(
    app: XCUIApplication,
    selectorKey: String,
    selectorValue: String,
    allowNonHittableFallback: Bool = false,
    expectedPoint: CGPoint? = nil,
    rawMatchPolicy: DirectSelectorRawMatchPolicy = .rejectDistinctMatches
  ) -> SelectorElementMatch {
    let value = selectorValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else {
      return SelectorElementMatch(element: nil, isAmbiguous: false, usedNonHittableFallback: false)
    }
    let predicate: NSPredicate
    switch selectorKey {
    case "id":
      predicate = NSPredicate(format: "identifier ==[c] %@", value)
    case "label":
      predicate = NSPredicate(format: "label ==[c] %@", value)
    case "value":
      predicate = NSPredicate(format: "value ==[c] %@", value)
    case "text":
      predicate = NSPredicate(format: "label ==[c] %@ OR identifier ==[c] %@ OR value ==[c] %@", value, value, value)
    default:
      return SelectorElementMatch(element: nil, isAmbiguous: false, usedNonHittableFallback: false)
    }

    let matches = app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex
      .filter(\.exists)
    let facts = matches.map { element in
      SelectorCandidateFacts(
        isHittable: element.isHittable,
        hasTappableFrame: hasTappableFrame(app: app, element: element),
        containsExpectedPoint: expectedPoint.map(element.frame.contains) ?? true
      )
    }
    switch classifyDirectSelectorCandidates(
      facts,
      allowNonHittableFallback: allowNonHittableFallback,
      filtersByExpectedPoint: expectedPoint != nil,
      rawMatchPolicy: rawMatchPolicy
    ) {
    case .noMatch:
      return SelectorElementMatch(element: nil, isAmbiguous: false, usedNonHittableFallback: false)
    case .ambiguous:
      return SelectorElementMatch(element: nil, isAmbiguous: true, usedNonHittableFallback: false)
    case let .selected(index, usedNonHittableFallback):
      return SelectorElementMatch(
        element: matches[index],
        isAmbiguous: false,
        usedNonHittableFallback: usedNonHittableFallback
      )
    }
  }

  // Maestro-compat gate for the non-hittable coordinate fallback: an element
  // with no frame at all cannot be coordinate-tapped, otherwise the decision
  // is the shared TapPointPolicy center-in-frame rule (golden parity table
  // with the TS twin). app.frame is the frame source here — replay taps
  // resolved bounds Maestro-style, so the union frame is intentional.
  private func hasTappableFrame(app: XCUIApplication, element: XCUIElement) -> Bool {
    let frame = element.frame
    if frame.isEmpty {
      return false
    }
    return TapPointPolicy.isAllowed(elementFrame: frame, windowFrame: app.frame)
  }

  // The tappable on-screen viewport. app.frame is unsuitable: it unions
  // transformed subtrees, so a closed drawer at negative x inflates it and
  // out-of-window coordinates still pass containment. Falls back to app.frame
  // when no window frame is readable.
  func onScreenWindowFrame(app: XCUIApplication) -> CGRect {
    let window = app.windows.element(boundBy: 0)
    if window.exists {
      let frame = window.frame
      if !frame.isEmpty {
        return frame
      }
    }
    return app.frame
  }

  func queryElement(app: XCUIApplication, selectorKey: String, selectorValue: String) -> Response {
    // querySelector is a read — it backs get/is/wait and the offscreen-refusal
    // double-check, none of which mutate. The fail-closed raw-match rule exists
    // to stop a mutation acting on an unseen duplicate; applying it here would
    // instead turn a decorative non-hittable duplicate into an AMBIGUOUS_MATCH
    // for readers that previously resolved the hittable element.
    let match = findElement(
      app: app,
      selectorKey: selectorKey,
      selectorValue: selectorValue,
      rawMatchPolicy: .preferHittableMatch
    )
    if match.isAmbiguous {
      return Response(ok: false, error: ErrorPayload(code: "AMBIGUOUS_MATCH", message: "selector matched multiple elements"))
    }
    guard let element = match.element else {
      return Response(ok: true, data: DataPayload(found: false, nodes: []))
    }

    let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    let valueText = String(describing: element.value ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let node = SnapshotPresentation.singleElementRead(
      RawAXNode(
        index: 0,
        type: elementTypeName(element.elementType),
        label: label.isEmpty ? nil : label,
        identifier: identifier.isEmpty ? nil : identifier,
        value: valueText.isEmpty ? nil : valueText,
        rect: SnapshotRect(element.frame),
        enabled: element.isEnabled,
        focused: nil,
        selected: element.isSelected ? true : nil,
        hittable: element.isHittable,
        depth: 0,
        parentIndex: nil,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    )
    return Response(
      ok: true,
      data: DataPayload(
        text: readableText(for: element),
        found: true,
        nodes: [node]
      )
    )
  }

  /// Shared ordering for point-hit candidates: smallest area wins, then top-to-bottom,
  /// left-to-right, then stable element-type order for ties.
  func smallestElementFirst(_ left: XCUIElement, _ right: XCUIElement) -> Bool {
    let leftArea = max(1, left.frame.width * left.frame.height)
    let rightArea = max(1, right.frame.width * right.frame.height)
    if leftArea != rightArea {
      return leftArea < rightArea
    }
    if left.frame.minY != right.frame.minY {
      return left.frame.minY < right.frame.minY
    }
    if left.frame.minX != right.frame.minX {
      return left.frame.minX < right.frame.minX
    }
    return left.elementType.rawValue < right.elementType.rawValue
  }

  func readTextAt(app: XCUIApplication, x: Double, y: Double) -> String? {
    let point = CGPoint(x: x, y: y)
    let textInputCandidates = textInputCandidatesAt(app: app, point: point)
    for element in textInputCandidates where prefersExpandedTextRead(element) {
      if let text = readableText(for: element) {
        return text
      }
    }

    let candidates = app.descendants(matching: .any).allElementsBoundByIndex
      .filter { element in
        element.exists && !element.frame.isEmpty && element.frame.contains(point)
      }
      .sorted(by: smallestElementFirst)

    for element in candidates where prefersExpandedTextRead(element) {
      if let text = readableText(for: element) {
        return text
      }
    }
    for element in candidates {
      if let text = readableText(for: element) {
        return text
      }
    }
    return nil
  }

  private func readableText(for element: XCUIElement) -> String? {
    let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    let valueText = String(describing: element.value ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    switch element.elementType {
    case .textField, .secureTextField, .searchField, .textView:
      if !valueText.isEmpty { return valueText }
      if !label.isEmpty { return label }
      return identifier.isEmpty ? nil : identifier
    default:
      if !label.isEmpty { return label }
      if !valueText.isEmpty { return valueText }
      return identifier.isEmpty ? nil : identifier
    }
  }

  private func prefersExpandedTextRead(_ element: XCUIElement) -> Bool {
    switch element.elementType {
    case .textField, .secureTextField, .searchField, .textView:
      return true
    default:
      return false
    }
  }

  func tapAt(app: XCUIApplication, x: Double, y: Double) -> RunnerInteractionOutcome {
    if let outcome = selectFocusedTvElement(app: app, point: CGPoint(x: x, y: y), action: "tap") {
      return outcome
    }
    return performCoordinateTap(app: app, x: x, y: y)
  }

  func mouseClickAt(app: XCUIApplication, x: Double, y: Double, button: String) throws {
#if os(macOS)
    let coordinate = interactionCoordinate(app: app, x: x, y: y)
    switch button {
    case "primary":
      coordinate.tap()
    case "secondary":
      coordinate.rightClick()
    case "middle":
      throw RunnerUnsupportedOperationError(message: "middle mouse button is not supported")
    default:
      throw RunnerUnsupportedOperationError(message: "unsupported mouse button: \(button)")
    }
#elseif os(tvOS)
    throw RunnerUnsupportedOperationError(message: "mouseClick is not supported on tvOS")
#else
    throw RunnerUnsupportedOperationError(message: "mouseClick is only supported on macOS")
#endif
  }

  func desktopScrollAt(
    app: XCUIApplication,
    x: Double,
    y: Double,
    direction: RunnerScrollDirection,
    pixels: Double,
    durationMs: Double?
  ) throws {
#if os(macOS)
    let events = desktopScrollWheelDeltaEvents(
      direction: direction,
      pixels: pixels,
      durationMs: durationMs
    )

    let coordinate = interactionCoordinate(app: app, x: x, y: y)
    let interval = desktopScrollEventIntervalSeconds(durationMs: durationMs, eventCount: events.count)
    for (index, deltas) in events.enumerated() {
      // Keep desktop scrolling on XCTest's coordinate API so macOS owns wheel synthesis, natural
      // scrolling preference handling, and cursor placement instead of posting raw CGEvents.
      coordinate.scroll(
        byDeltaX: CGFloat(deltas.horizontal),
        deltaY: CGFloat(deltas.vertical)
      )
      if interval > 0 && index < events.count - 1 {
        Thread.sleep(forTimeInterval: interval)
      }
    }
#elseif os(tvOS)
    throw RunnerUnsupportedOperationError(message: "desktopScroll is not supported on tvOS")
#else
    throw RunnerUnsupportedOperationError(message: "desktopScroll is only supported on macOS")
#endif
  }

  func desktopScrollWheelDeltas(
    direction: RunnerScrollDirection,
    pixels: Double
  ) -> (vertical: Int32, horizontal: Int32) {
    let magnitude = Int32(max(1, min(Double(Int32.max), pixels.rounded())))
    switch direction {
    case .up:
      return (vertical: magnitude, horizontal: 0)
    case .down:
      return (vertical: -magnitude, horizontal: 0)
    case .left:
      return (vertical: 0, horizontal: magnitude)
    case .right:
      return (vertical: 0, horizontal: -magnitude)
    }
  }

  func desktopScrollWheelDeltaEvents(
    direction: RunnerScrollDirection,
    pixels: Double,
    durationMs: Double?
  ) -> [(vertical: Int32, horizontal: Int32)] {
    let totalDeltas = desktopScrollWheelDeltas(direction: direction, pixels: pixels)
    let magnitude = max(abs(Int(totalDeltas.vertical)), abs(Int(totalDeltas.horizontal)))
    let duration = max(0, durationMs ?? 0)
    let requestedEventCount = duration > 0 ? Int(ceil(duration / 16.0)) : 1
    let eventCount = max(1, min(magnitude, requestedEventCount))
    guard eventCount > 1 else {
      return [totalDeltas]
    }

    if totalDeltas.vertical != 0 {
      return distributeDesktopScrollDelta(totalDeltas.vertical, eventCount: eventCount)
        .map { (vertical: $0, horizontal: 0) }
    }
    return distributeDesktopScrollDelta(totalDeltas.horizontal, eventCount: eventCount)
      .map { (vertical: 0, horizontal: $0) }
  }

  func desktopScrollEventIntervalSeconds(durationMs: Double?, eventCount: Int) -> TimeInterval {
    guard let durationMs, durationMs > 0, eventCount > 1 else { return 0 }
    return (durationMs / 1000.0) / Double(eventCount - 1)
  }

  private func distributeDesktopScrollDelta(_ delta: Int32, eventCount: Int) -> [Int32] {
    let sign: Int32 = delta < 0 ? -1 : 1
    let magnitude = abs(Int(delta))
    let base = magnitude / eventCount
    let remainder = magnitude % eventCount
    return (0..<eventCount).map { index in
      sign * Int32(base + (index < remainder ? 1 : 0))
    }
  }

  func doubleTapAt(app: XCUIApplication, x: Double, y: Double) -> RunnerInteractionOutcome {
    if let outcome = selectFocusedTvElement(app: app, point: CGPoint(x: x, y: y), action: "double tap") {
      guard case .performed = outcome else { return outcome }
      sleepFor(0.1)
      _ = pressTvRemote(.select)
      return .performed
    }
    return performCoordinateDoubleTap(app: app, x: x, y: y)
  }

  func longPressAt(app: XCUIApplication, x: Double, y: Double, duration: TimeInterval) -> RunnerInteractionOutcome {
    if let outcome = longSelectFocusedTvElement(app: app, point: CGPoint(x: x, y: y), duration: duration) {
      return outcome
    }
    return performCoordinateLongPress(app: app, x: x, y: y, duration: duration)
  }

  func dragAt(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    holdDuration: TimeInterval
  ) -> RunnerInteractionOutcome {
    // tvOS has no coordinate drag. Preserve the direction as a focus move.
    let dx = x2 - x
    let dy = y2 - y
    let button: TvRemoteButton = abs(dx) > abs(dy)
      ? (dx > 0 ? .right : .left)
      : (dy > 0 ? .down : .up)
    if pressTvRemote(button) {
      return .performed
    }
    return performCoordinateDrag(app: app, x: x, y: y, x2: x2, y2: y2, holdDuration: holdDuration)
  }

  private func interactionRoot(app: XCUIApplication) -> XCUIElement {
    let windows = app.windows.allElementsBoundByIndex
    if let window = windows.first(where: { $0.exists && !$0.frame.isEmpty }) {
      return window
    }
    return app
  }

  private func performCoordinateTap(app: XCUIApplication, x: Double, y: Double) -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported(
      message: "coordinate tap is not supported on tvOS; move focus with swipe or scroll, then select the focused element",
      hint: "tvOS has no coordinate input; move focus with swipe/scroll to the target, then select it."
    )
#else
    interactionCoordinate(app: app, x: x, y: y).tap()
    return .performed
#endif
  }

  private func performCoordinateDoubleTap(app: XCUIApplication, x: Double, y: Double) -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported(
      message: "coordinate double tap is not supported on tvOS; move focus with swipe or scroll, then select the focused element",
      hint: "tvOS has no coordinate input; move focus with swipe/scroll to the target, then select it."
    )
#else
    interactionCoordinate(app: app, x: x, y: y).doubleTap()
    return .performed
#endif
  }

  private func performCoordinateLongPress(app: XCUIApplication, x: Double, y: Double, duration: TimeInterval) -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported(
      message: "coordinate long press is not supported on tvOS; move focus with swipe or scroll, then long-select the focused element",
      hint: "tvOS has no coordinate input; move focus with swipe/scroll to the target, then long-select it."
    )
#else
    interactionCoordinate(app: app, x: x, y: y).press(forDuration: duration)
    return .performed
#endif
  }

  private func performCoordinateDrag(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    holdDuration: TimeInterval
  ) -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported(
      message: "coordinate drag is not supported on tvOS",
      hint: "tvOS has no coordinate input; use remote-driven swipe/scroll to move focus instead."
    )
#else
    let start = interactionCoordinate(app: app, x: x, y: y)
    let end = interactionCoordinate(app: app, x: x2, y: y2)
    start.press(forDuration: holdDuration, thenDragTo: end)
    return .performed
#endif
  }

#if !os(tvOS)
  private func interactionCoordinate(app: XCUIApplication, x: Double, y: Double) -> XCUICoordinate {
    let root = interactionRoot(app: app)
    let origin = root.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
    let rootFrame = root.frame
    let offsetX = x - Double(rootFrame.origin.x)
    let offsetY = y - Double(rootFrame.origin.y)
    return origin.withOffset(CGVector(dx: offsetX, dy: offsetY))
  }
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  func testDesktopScrollWheelDeltasMapDirections() {
    XCTAssertEqual(desktopScrollWheelDeltas(direction: .up, pixels: 120).vertical, 120)
    XCTAssertEqual(desktopScrollWheelDeltas(direction: .down, pixels: 120).vertical, -120)
    XCTAssertEqual(desktopScrollWheelDeltas(direction: .left, pixels: 120).horizontal, 120)
    XCTAssertEqual(desktopScrollWheelDeltas(direction: .right, pixels: 120).horizontal, -120)
  }

  func testDesktopScrollWheelDeltaEventsHonorDurationAndPreservePixels() {
    let events = desktopScrollWheelDeltaEvents(direction: .down, pixels: 200, durationMs: 50)
    XCTAssertEqual(events.count, 4)
    XCTAssertEqual(events.map(\.vertical).reduce(0, +), -200)
    XCTAssertEqual(events.map(\.horizontal).reduce(0, +), 0)
    XCTAssertEqual(desktopScrollEventIntervalSeconds(durationMs: 50, eventCount: events.count), 0.05 / 3.0)
  }

  func testDesktopScrollWheelDeltaEventsKeepInstantScrollSingleEvent() {
    let events = desktopScrollWheelDeltaEvents(direction: .down, pixels: 200, durationMs: 0)
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.vertical, -200)
  }
#endif
}
