import XCTest

#if os(macOS)
import CoreGraphics
#endif

private enum RunnerInterfaceOrientation {
  static let unknown = 0
  static let portrait = 1
  static let portraitUpsideDown = 2
  static let landscapeRight = 3
  static let landscapeLeft = 4
}

extension RunnerTests {
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
    let referenceFrame: CGRect
  }

  struct SelectorElementMatch {
    let element: XCUIElement?
    let isAmbiguous: Bool
    let usedNonHittableFallback: Bool
  }

  // MARK: - Navigation Gestures

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
    return false
#endif
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

  func rotateDevice(to orientationName: String) -> Bool {
#if os(macOS) || os(tvOS) || os(visionOS)
    return false
#else
    switch orientationName {
    case "portrait":
      XCUIDevice.shared.orientation = .portrait
    case "portrait-upside-down":
      XCUIDevice.shared.orientation = .portraitUpsideDown
    case "landscape-left":
      XCUIDevice.shared.orientation = .landscapeLeft
    case "landscape-right":
      XCUIDevice.shared.orientation = .landscapeRight
    default:
      return false
    }
    sleepFor(0.2)
    return true
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
    allowNonHittableFallback: Bool = false
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

    var matchedElement: XCUIElement?
    var nonHittableElement: XCUIElement?
    let matches = app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex
    for element in matches where element.exists {
      if !element.isHittable {
        if allowNonHittableFallback && hasTappableFrame(app: app, element: element) {
          guard nonHittableElement == nil else {
            return SelectorElementMatch(element: nil, isAmbiguous: true, usedNonHittableFallback: false)
          }
          nonHittableElement = element
        }
        continue
      }
      guard matchedElement == nil else {
        return SelectorElementMatch(element: nil, isAmbiguous: true, usedNonHittableFallback: false)
      }
      matchedElement = element
    }
    if let matchedElement {
      return SelectorElementMatch(element: matchedElement, isAmbiguous: false, usedNonHittableFallback: false)
    }
    return SelectorElementMatch(
      element: nonHittableElement,
      isAmbiguous: false,
      usedNonHittableFallback: nonHittableElement != nil
    )
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
    let match = findElement(app: app, selectorKey: selectorKey, selectorValue: selectorValue)
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
    let node = SnapshotNode(
      index: 0,
      type: elementTypeName(element.elementType),
      label: label.isEmpty ? nil : label,
      identifier: identifier.isEmpty ? nil : identifier,
      value: valueText.isEmpty ? nil : valueText,
      rect: snapshotRect(from: element.frame),
      enabled: element.isEnabled,
      focused: nil,
      selected: element.isSelected ? true : nil,
      hittable: element.isHittable,
      depth: 0,
      parentIndex: nil,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
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
      .sorted { left, right in
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

  func textInputAt(app: XCUIApplication, x: Double, y: Double) -> XCUIElement? {
    return textInputCandidatesAt(app: app, point: CGPoint(x: x, y: y)).first
  }

  private func textInputCandidatesAt(app: XCUIApplication, point: CGPoint) -> [XCUIElement] {
    safely("TEXT_INPUT_AT_POINT", []) {
      // Query the text-input element types directly instead of enumerating the entire tree
      // (app.descendants(.any).allElementsBoundByIndex snapshots every element and is ~10x
      // slower — it dominated fill latency because resolveTextEntryElement re-runs this on
      // each verify/repair poll once the focused field reference goes stale).
      // Prefer the smallest matching field so nested editable controls win over large containers.
      [
        app.textFields,
        app.secureTextFields,
        app.searchFields,
        app.textViews,
      ]
        .flatMap { $0.allElementsBoundByIndex }
        .filter { element in
          guard element.exists else { return false }
          let frame = element.frame
          return !frame.isEmpty && frameContainsPoint(frame, point, tolerance: 2)
        }
        .sorted { left, right in
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
    }
  }

  private func frameContainsPoint(_ frame: CGRect, _ point: CGPoint, tolerance: CGFloat) -> Bool {
    point.x >= frame.minX - tolerance
      && point.x <= frame.maxX + tolerance
      && point.y >= frame.minY - tolerance
      && point.y <= frame.maxY + tolerance
  }

  func isKeyboardVisible(app: XCUIApplication) -> Bool {
    return visibleKeyboardFrame(app: app) != nil
  }

  func dismissKeyboard(app: XCUIApplication) -> (wasVisible: Bool, dismissed: Bool, visible: Bool) {
    let wasVisible = isKeyboardVisible(app: app)
    guard wasVisible else {
      return (wasVisible: false, dismissed: false, visible: false)
    }

#if os(tvOS)
    _ = pressTvRemote(.menu)
    sleepFor(0.2)
    let visible = isKeyboardVisible(app: app)
    return (wasVisible: true, dismissed: !visible, visible: visible)
#else
    if tapKeyboardDismissControl(app: app) {
      sleepFor(0.2)
      let visible = isKeyboardVisible(app: app)
      return (wasVisible: true, dismissed: !visible, visible: visible)
    }

    return (wasVisible: true, dismissed: false, visible: isKeyboardVisible(app: app))
#endif
  }

  func pressKeyboardReturn(app: XCUIApplication) -> (wasVisible: Bool, pressed: Bool, visible: Bool) {
#if os(tvOS)
    return (wasVisible: false, pressed: pressTvRemote(.select), visible: false)
#elseif os(iOS)
    let wasVisible = isKeyboardVisible(app: app)
    if tapKeyboardReturnControl(app: app) {
      sleepFor(0.2)
      return (wasVisible: wasVisible, pressed: true, visible: isKeyboardVisible(app: app))
    }

    var typed = false
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      app.typeText(XCUIKeyboardKey.return.rawValue)
      typed = true
    })
    if let exceptionMessage {
      NSLog(
        "AGENT_DEVICE_RUNNER_KEYBOARD_RETURN_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      if let singleTarget = singleTextEntryElement(app: app) {
        return pressKeyboardReturn(on: singleTarget, app: app, wasVisible: wasVisible)
      }
      return (wasVisible: wasVisible, pressed: false, visible: isKeyboardVisible(app: app))
    }
    sleepFor(0.2)
    return (wasVisible: wasVisible, pressed: typed, visible: isKeyboardVisible(app: app))
#else
    return (wasVisible: false, pressed: false, visible: false)
#endif
  }

  private func pressKeyboardReturn(
    on element: XCUIElement,
    app: XCUIApplication,
    wasVisible: Bool
  ) -> (wasVisible: Bool, pressed: Bool, visible: Bool) {
#if os(iOS)
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      element.tap()
      element.typeText(XCUIKeyboardKey.return.rawValue)
    })
    if let exceptionMessage {
      NSLog(
        "AGENT_DEVICE_RUNNER_KEYBOARD_RETURN_TARGET_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      return (wasVisible: wasVisible, pressed: false, visible: isKeyboardVisible(app: app))
    }
    sleepFor(0.2)
    return (wasVisible: wasVisible, pressed: true, visible: isKeyboardVisible(app: app))
#else
    return (wasVisible: wasVisible, pressed: false, visible: false)
#endif
  }

  private func singleTextEntryElement(app: XCUIApplication) -> XCUIElement? {
#if os(iOS)
    let matches = safely("KEYBOARD_RETURN_TEXT_ENTRY_QUERY", []) {
      app.descendants(matching: .any).allElementsBoundByIndex.filter { element in
        guard element.exists else { return false }
        switch element.elementType {
        case .textField, .secureTextField, .searchField, .textView:
          return true
        default:
          return false
        }
      }
    }
    return matches.count == 1 ? matches[0] : nil
#else
    return nil
#endif
  }

  private func tapKeyboardDismissControl(app: XCUIApplication) -> Bool {
#if os(tvOS)
    return false
#else
    guard let keyboardFrame = visibleKeyboardFrame(app: app) else {
      return false
    }
    for label in ["Hide keyboard", "Dismiss keyboard", "Done"] {
      let candidates = [
        app.keyboards.buttons[label],
        app.keyboards.keys[label],
        app.keyboards.toolbars.buttons[label],
      ]
      if let hittable = candidates.first(where: { $0.exists && $0.isHittable }) {
        hittable.tap()
        return true
      }

      let toolbarButtonPredicate = NSPredicate(
        format: "label == %@ OR identifier == %@",
        label,
        label
      )
      let toolbarButtons = app.descendants(matching: .button)
        .matching(toolbarButtonPredicate)
        .allElementsBoundByIndex
      if let hittable = toolbarButtons.first(where: {
        $0.exists && $0.isHittable && isKeyboardAccessoryControl($0, keyboardFrame: keyboardFrame)
      }) {
        hittable.tap()
        return true
      }
    }
    return false
#endif
  }

  private func tapKeyboardReturnControl(app: XCUIApplication) -> Bool {
#if os(iOS)
    for label in ["return", "Return", "Enter", "Go", "Search", "Next", "Done", "Send", "Join"] {
      let candidates = [
        app.keyboards.buttons[label],
        app.keyboards.keys[label],
      ]
      if let hittable = candidates.first(where: { $0.exists && $0.isHittable }) {
        hittable.tap()
        return true
      }
    }
#endif
    return false
  }

  private func isKeyboardAccessoryControl(_ element: XCUIElement, keyboardFrame: CGRect) -> Bool {
    let frame = element.frame
    guard !frame.isEmpty && !keyboardFrame.isEmpty else {
      return false
    }
    return frame.intersects(keyboardFrame) || abs(frame.maxY - keyboardFrame.minY) <= 80
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

  func findScopeElement(app: XCUIApplication, scope: String) -> XCUIElement? {
    let predicate = NSPredicate(
      format: "label CONTAINS[c] %@ OR identifier CONTAINS[c] %@",
      scope,
      scope
    )
    let element = app.descendants(matching: .any).matching(predicate).firstMatch
    return element.exists ? element : nil
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
      throw NSError(
        domain: "AgentDeviceRunner",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "middle mouse button is not supported"]
      )
    default:
      throw NSError(
        domain: "AgentDeviceRunner",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "unsupported mouse button: \(button)"]
      )
    }
#elseif os(tvOS)
    throw NSError(
      domain: "AgentDeviceRunner",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "mouseClick is not supported on tvOS"]
    )
#else
    throw NSError(
      domain: "AgentDeviceRunner",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "mouseClick is only supported on macOS"]
    )
#endif
  }

  func desktopScrollAt(
    app: XCUIApplication,
    x: Double,
    y: Double,
    direction: String,
    pixels: Double,
    durationMs: Double?
  ) throws {
#if os(macOS)
    guard let events = desktopScrollWheelDeltaEvents(
      direction: direction,
      pixels: pixels,
      durationMs: durationMs
    ) else {
      throw NSError(
        domain: "AgentDeviceRunner",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "unsupported desktop scroll direction: \(direction)"]
      )
    }

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
    throw NSError(
      domain: "AgentDeviceRunner",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "desktopScroll is not supported on tvOS"]
    )
#else
    throw NSError(
      domain: "AgentDeviceRunner",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "desktopScroll is only supported on macOS"]
    )
#endif
  }

  func desktopScrollWheelDeltas(direction: String, pixels: Double) -> (vertical: Int32, horizontal: Int32)? {
    let magnitude = Int32(max(1, min(Double(Int32.max), pixels.rounded())))
    switch direction {
    case "up":
      return (vertical: magnitude, horizontal: 0)
    case "down":
      return (vertical: -magnitude, horizontal: 0)
    case "left":
      return (vertical: 0, horizontal: magnitude)
    case "right":
      return (vertical: 0, horizontal: -magnitude)
    default:
      return nil
    }
  }

  func desktopScrollWheelDeltaEvents(
    direction: String,
    pixels: Double,
    durationMs: Double?
  ) -> [(vertical: Int32, horizontal: Int32)]? {
    guard let totalDeltas = desktopScrollWheelDeltas(direction: direction, pixels: pixels) else {
      return nil
    }
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

  /// Rotates an interface-oriented point into the device-native (portrait) space the
  /// synthesized event path consumes — synthesized events skip XCTest's orientation
  /// handling, so without this a landscape tap lands in the wrong place.
  func nativeSynthesizedPoint(
    orientedX x: Double,
    orientedY y: Double,
    in frame: CGRect,
    interfaceOrientation: Int
  ) -> CGPoint {
    let localX = x - Double(frame.minX)
    let localY = y - Double(frame.minY)
    let width = Double(frame.width)
    let height = Double(frame.height)
    switch interfaceOrientation {
    case RunnerInterfaceOrientation.landscapeRight:
      return CGPoint(x: height - localY, y: localX)
    case RunnerInterfaceOrientation.landscapeLeft:
      return CGPoint(x: localY, y: width - localX)
    case RunnerInterfaceOrientation.portraitUpsideDown:
      return CGPoint(x: width - localX, y: height - localY)
    default:  // portrait or unknown
      return CGPoint(x: localX, y: localY)
    }
  }

  /// Rotates an interface-oriented translation vector into the same native
  /// coordinate space as `nativeSynthesizedPoint`.
  func nativeSynthesizedVector(
    orientedDx dx: Double,
    orientedDy dy: Double,
    interfaceOrientation: Int
  ) -> CGVector {
    switch interfaceOrientation {
    case RunnerInterfaceOrientation.landscapeRight:
      return CGVector(dx: -dy, dy: dx)
    case RunnerInterfaceOrientation.landscapeLeft:
      return CGVector(dx: dy, dy: -dx)
    case RunnerInterfaceOrientation.portraitUpsideDown:
      return CGVector(dx: -dx, dy: -dy)
    default:  // portrait or unknown
      return CGVector(dx: dx, dy: dy)
    }
  }

  func synthesizedDragAt(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    durationMs: Double,
    referenceFrame: CGRect? = nil
  ) -> RunnerInteractionOutcome {
#if os(iOS)
    guard x.isFinite, y.isFinite, x2.isFinite, y2.isFinite else {
      return .unsupported(
        message: "synthesized coordinate drag requires finite coordinates",
        hint: "Retry with finite x, y, x2, and y2 values."
      )
    }
    let orientation = Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app))
    guard let frame = referenceFrame ?? synthesizedGestureReferenceFrame(app: app) else {
      return .unsupported(
        message: "synthesized coordinate drag could not resolve a finite screen frame",
        hint: "Retry after the app is foregrounded, or use a plain screenshot to choose coordinates."
      )
    }
    let start = nativeSynthesizedPoint(orientedX: x, orientedY: y, in: frame, interfaceOrientation: orientation)
    let end = nativeSynthesizedPoint(orientedX: x2, orientedY: y2, in: frame, interfaceOrientation: orientation)
    if let message = RunnerSynthesizedGesture.synthesizeSwipe(
      withApplication: app,
      x: Double(start.x),
      y: Double(start.y),
      x2: Double(end.x),
      y2: Double(end.y),
      durationMs: durationMs
    ) {
      return .unsupported(
        message: message,
        hint: "Private XCTest event synthesis is required for AX-free coordinate drag on iOS; update Xcode if this persists."
      )
    }
    return .performed
#elseif os(tvOS)
    return .unsupported(
      message: "coordinate drag is not supported on tvOS",
      hint: "tvOS has no coordinate input; use remote-driven swipe/scroll to move focus instead."
    )
#else
    return .unsupported(
      message: "coordinate drag is not supported on macOS",
      hint: "macOS automation has no touchscreen; use mouse-driven interactions instead."
    )
#endif
  }

  func synthesizedTapAt(app: XCUIApplication, x: Double, y: Double, referenceFrame: CGRect? = nil) -> RunnerInteractionOutcome {
#if os(iOS)
    guard x.isFinite, y.isFinite else {
      return .unsupported(
        message: "synthesized coordinate tap requires finite coordinates",
        hint: "Retry with finite x and y values."
      )
    }
    let orientation = Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app))
    guard let frame = referenceFrame ?? synthesizedGestureReferenceFrame(app: app) else {
      return .unsupported(
        message: "synthesized coordinate tap could not resolve a finite screen frame",
        hint: "Retry after the app is foregrounded, or use a plain screenshot to choose coordinates."
      )
    }
    let point = nativeSynthesizedPoint(orientedX: x, orientedY: y, in: frame, interfaceOrientation: orientation)
    if let message = RunnerSynthesizedGesture.synthesizeTap(
      withApplication: app,
      x: Double(point.x),
      y: Double(point.y)
    ) {
      return .unsupported(
        message: message,
        hint: "Falling back to XCTest coordinate tap may be slower and can still need a healthy accessibility tree."
      )
    }
    return .performed
#elseif os(tvOS)
    return .unsupported(
      message: "coordinate tap is not supported on tvOS; move focus with swipe or scroll, then select the focused element",
      hint: "tvOS has no coordinate input; move focus with swipe/scroll to the target, then select it."
    )
#else
    return .unsupported(
      message: "synthesized coordinate tap is not supported on macOS",
      hint: "macOS automation has no touchscreen; use mouse-driven interactions instead."
    )
#endif
  }

  func keyboardAvoidingDragPoints(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double
  ) -> DragPoints {
    let original = DragPoints(x: x, y: y, x2: x2, y2: y2)
#if os(iOS)
    guard let keyboardFrame = visibleKeyboardFrame(app: app) else {
      return original
    }
    let minX = min(x, x2)
    let minY = min(y, y2)
    let gestureBounds = CGRect(
      x: CGFloat(minX),
      y: CGFloat(minY),
      width: CGFloat(max(abs(x2 - x), 1)),
      height: CGFloat(max(abs(y2 - y), 1))
    )
    guard gestureBounds.intersects(keyboardFrame) else {
      return original
    }

    let window = app.windows.firstMatch
    let appFrame = window.exists && !window.frame.isEmpty ? window.frame : app.frame
    guard !appFrame.isEmpty else {
      return original
    }

    let padding: Double = 12
    let targetMaxY = Double(keyboardFrame.minY) - padding
    let currentMaxY = max(y, y2)
    let shift = currentMaxY - targetMaxY
    guard shift > 0 else {
      return original
    }

    let adjustedY = y - shift
    let adjustedY2 = y2 - shift
    guard min(adjustedY, adjustedY2) >= Double(appFrame.minY) + padding else {
      return original
    }

    NSLog(
      "AGENT_DEVICE_RUNNER_KEYBOARD_AVOIDING_DRAG from=(%.1f,%.1f)->(%.1f,%.1f) adjusted=(%.1f,%.1f)->(%.1f,%.1f) keyboardMinY=%.1f",
      x,
      y,
      x2,
      y2,
      x,
      adjustedY,
      x2,
      adjustedY2,
      Double(keyboardFrame.minY)
    )
    return DragPoints(x: x, y: adjustedY, x2: x2, y2: adjustedY2)
#else
    return original
#endif
  }

  func resolvedTouchVisualizationFrame(app: XCUIApplication, x: Double, y: Double) -> TouchVisualizationFrame {
    let appFrame = app.frame
    let referenceFrame = resolvedTouchReferenceFrame(app: app, appFrame: appFrame)
    let originX = appFrame.isEmpty ? referenceFrame.minX : appFrame.minX
    let originY = appFrame.isEmpty ? referenceFrame.minY : appFrame.minY
    return TouchVisualizationFrame(
      x: originX + x,
      y: originY + y,
      referenceWidth: referenceFrame.width,
      referenceHeight: referenceFrame.height
    )
  }

  func resolvedDragVisualizationFrame(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double
  ) -> DragVisualizationFrame {
    let start = resolvedTouchVisualizationFrame(app: app, x: x, y: y)
    let end = resolvedTouchVisualizationFrame(app: app, x: x2, y: y2)
    return DragVisualizationFrame(
      x: start.x,
      y: start.y,
      x2: end.x,
      y2: end.y,
      referenceWidth: start.referenceWidth,
      referenceHeight: start.referenceHeight
    )
  }

  func resolvedTouchReferenceFrame(app: XCUIApplication, appFrame: CGRect) -> CGRect {
    let window = app.windows.firstMatch
    if window.exists {
      let windowFrame = window.frame
      if !windowFrame.isEmpty {
        return frameAvoidingKeyboard(app: app, frame: windowFrame)
      }
    }
    if !appFrame.isEmpty {
      return frameAvoidingKeyboard(app: app, frame: appFrame)
    }
    return CGRect(x: 0, y: 0, width: 0, height: 0)
  }

  private func frameAvoidingKeyboard(app: XCUIApplication, frame: CGRect) -> CGRect {
#if os(iOS)
    guard let keyboardFrame = visibleKeyboardFrame(app: app), !frame.isEmpty else {
      return frame
    }
    let intersection = frame.intersection(keyboardFrame)
    guard !intersection.isNull && intersection.height > 0 else {
      return frame
    }
    let keyboardCoverage = intersection.width / max(frame.width, 1)
    guard keyboardCoverage >= 0.5 else {
      return frame
    }
    let safeHeight = keyboardFrame.minY - frame.minY
    guard safeHeight >= frame.height * 0.25 else {
      return frame
    }
    return CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: safeHeight)
#else
    return frame
#endif
  }

  private func visibleKeyboardFrame(app: XCUIApplication) -> CGRect? {
#if os(iOS)
    return safely("KEYBOARD_FRAME") {
      let keyboard = app.keyboards.firstMatch
      guard keyboard.exists else { return nil }
      let keyboardFrame = keyboard.frame
      guard !keyboardFrame.isEmpty else { return nil }
      return keyboardFrame
    }
#else
    return nil
#endif
  }

  func axFreeSynthesizedDragPlan(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    referenceFrame: CGRect? = nil,
    avoidKeyboardWhenSafe: Bool = false
  ) -> SynthesizedDragPlan? {
#if os(iOS)
    guard x.isFinite, y.isFinite, x2.isFinite, y2.isFinite,
      let frame = referenceFrame ?? synthesizedGestureReferenceFrame(app: app)
    else {
      return nil
    }
    let points = avoidKeyboardWhenSafe
      ? keyboardAvoidingSynthesizedDragPoints(app: app, x: x, y: y, x2: x2, y2: y2)
      : DragPoints(x: x, y: y, x2: x2, y2: y2)
    return SynthesizedDragPlan(
      points: points,
      referenceFrame: frame
    )
#else
    return nil
#endif
  }

  func axFreeDragVisualizationFrame(
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    referenceFrame: CGRect
  ) -> DragVisualizationFrame {
    return DragVisualizationFrame(
      x: x,
      y: y,
      x2: x2,
      y2: y2,
      referenceWidth: Double(referenceFrame.width),
      referenceHeight: Double(referenceFrame.height)
    )
  }

  func synthesizedGestureReferenceFrame(app: XCUIApplication) -> CGRect? {
#if os(iOS)
    return finiteSynthesizedReferenceFrame(
      appFrame: .zero,
      fallbackBounds: .zero,
      fallbackScreenshotSize: { XCUIScreen.main.screenshot().image.size }
    )
#else
    return nil
#endif
  }

  func finiteSynthesizedReferenceFrame(
    appFrame: CGRect,
    fallbackBounds: CGRect,
    fallbackScreenshotSize: () -> CGSize
  ) -> CGRect? {
    if isUsableReferenceFrame(appFrame) {
      return appFrame
    }
    if isUsableReferenceFrame(fallbackBounds) {
      return CGRect(x: 0, y: 0, width: fallbackBounds.width, height: fallbackBounds.height)
    }
    let screenshotSize = fallbackScreenshotSize()
    guard screenshotSize.width.isFinite, screenshotSize.height.isFinite,
      screenshotSize.width > 0,
      screenshotSize.height > 0
    else {
      return nil
    }
    return CGRect(x: 0, y: 0, width: screenshotSize.width, height: screenshotSize.height)
  }

  func synthesizedFrameAvoidingKeyboardWhenSafe(app: XCUIApplication, frame: CGRect) -> CGRect {
#if os(iOS)
    guard shouldProbeKeyboardForSynthesizedGesture() else { return frame }
    return frameAvoidingKeyboard(app: app, frame: frame)
#else
    return frame
#endif
  }

  func keyboardAvoidingSynthesizedDragPoints(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double
  ) -> DragPoints {
#if os(iOS)
    guard shouldProbeKeyboardForSynthesizedGesture() else {
      return DragPoints(x: x, y: y, x2: x2, y2: y2)
    }
    return keyboardAvoidingDragPoints(app: app, x: x, y: y, x2: x2, y2: y2)
#else
    return DragPoints(x: x, y: y, x2: x2, y2: y2)
#endif
  }

  private func shouldProbeKeyboardForSynthesizedGesture() -> Bool {
#if os(iOS)
    return !lastSnapshotHadAccessibilityUnavailable
#else
    return false
#endif
  }

  private func isUsableReferenceFrame(_ frame: CGRect) -> Bool {
    return !frame.isNull
      && !frame.isEmpty
      && !frame.isInfinite
      && frame.minX.isFinite
      && frame.minY.isFinite
      && frame.width.isFinite
      && frame.height.isFinite
      && frame.width > 0
      && frame.height > 0
  }


  func swipe(app: XCUIApplication, direction: String) -> DragVisualizationFrame? {
    if performTvRemoteSwipeIfAvailable(direction: direction) {
      let frame = resolvedTouchReferenceFrame(app: app, appFrame: app.frame)
      let midX = frame.midX
      let midY = frame.midY
      return DragVisualizationFrame(
        x: midX,
        y: midY,
        x2: midX,
        y2: midY,
        referenceWidth: frame.width,
        referenceHeight: frame.height
      )
    }
    return nil
  }

  private func performTvRemoteSwipeIfAvailable(direction: String) -> Bool {
    switch direction {
    case "up":
      return pressTvRemote(.up)
    case "down":
      return pressTvRemote(.down)
    case "left":
      return pressTvRemote(.left)
    case "right":
      return pressTvRemote(.right)
    default:
      return false
    }
  }

  func pinch(app: XCUIApplication, scale: Double, x: Double?, y: Double?) -> RunnerInteractionOutcome {
#if os(iOS)
    // A coordinate tap+drag is a single-finger gesture: React Native reads it as a pan
    // and the pinch scale never changes (#629). Drive the two-finger XCTest synthesis
    // path (the same one transformGesture uses) with zero translation/rotation so RN's
    // pinch recognizer actually fires.
    let frame = interactionRoot(app: app).frame
    let centerX = x ?? Double(frame.midX)
    let centerY = y ?? Double(frame.midY)
    return transformGesture(
      app: app,
      x: centerX,
      y: centerY,
      dx: 0,
      dy: 0,
      scale: scale,
      degrees: 0,
      durationMs: 300
    )
#elseif os(tvOS)
    return .unsupported(
      message: "pinch is not supported on tvOS",
      hint: "tvOS has no touch input; pinch requires a touchscreen (run on iOS)."
    )
#else
    return .unsupported(
      message: "pinch is not supported on macOS",
      hint: "macOS automation has no multi-touch input; pinch requires a touchscreen (run on iOS)."
    )
#endif
  }

  func rotateGesture(app: XCUIApplication, degrees: Double, x: Double?, y: Double?, velocity: Double) -> RunnerInteractionOutcome {
#if os(iOS)
    // Drive the two-finger XCTest synthesis path (the same one pinch/transformGesture use, #634)
    // with zero translation/scale so React Native's rotation recognizer actually fires. The native
    // XCUIElement.rotate(withVelocity:) injects a single synthetic rotation that RN's gesture
    // handler does not read reliably — the same class of problem #629/#634 fixed for pinch.
    // velocity is unused on iOS (synthesis speed is governed by durationMs); the wire contract
    // keeps it for compatibility and direction is carried entirely by the sign of `degrees`.
    let frame = interactionRoot(app: app).frame
    let centerX = x ?? Double(frame.midX)
    let centerY = y ?? Double(frame.midY)
    return transformGesture(
      app: app,
      x: centerX,
      y: centerY,
      dx: 0,
      dy: 0,
      scale: 1,
      degrees: degrees,
      durationMs: 300
    )
#elseif os(tvOS)
    return .unsupported(
      message: "rotate-gesture is not supported on tvOS",
      hint: "tvOS has no touch input; rotation gestures require a touchscreen (run on iOS)."
    )
#else
    return .unsupported(
      message: "rotate-gesture is not supported on macOS",
      hint: "macOS automation has no multi-touch input; rotation gestures require a touchscreen (run on iOS)."
    )
#endif
  }

  func transformGesture(
    app: XCUIApplication,
    x: Double,
    y: Double,
    dx: Double,
    dy: Double,
    scale: Double,
    degrees: Double,
    durationMs: Double
  ) -> RunnerInteractionOutcome {
#if os(iOS)
    let target = interactionRoot(app: app)
    let orientation = Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app))
    let point = nativeSynthesizedPoint(orientedX: x, orientedY: y, in: app.frame, interfaceOrientation: orientation)
    let vector = nativeSynthesizedVector(orientedDx: dx, orientedDy: dy, interfaceOrientation: orientation)
    if let message = RunnerSynthesizedGesture.synthesizeTransform(
      withApplication: app,
      x: Double(point.x),
      y: Double(point.y),
      dx: Double(vector.dx),
      dy: Double(vector.dy),
      scale: scale,
      degrees: degrees,
      radius: transformGestureRadius(frame: target.frame, scale: scale),
      durationMs: durationMs
    ) {
      return .unsupported(
        message: message,
        hint: "This gesture uses private XCTest event-synthesis APIs; rebuild the runner with a supported Xcode (these APIs can change across Xcode versions)."
      )
    }
    return .performed
#elseif os(tvOS)
    return .unsupported(
      message: "transformGesture is not supported on tvOS",
      hint: "tvOS has no touch input; transform gestures require a touchscreen (run on iOS)."
    )
#else
    return .unsupported(
      message: "transformGesture is not supported on macOS",
      hint: "macOS automation has no multi-touch input; transform gestures require a touchscreen (run on iOS)."
    )
#endif
  }

  private func transformGestureRadius(frame: CGRect, scale: Double) -> Double {
    let shorterSide = Double(min(frame.width, frame.height))
    let frameRadius = shorterSide * 0.20
    let minimumEndRadius = shorterSide * 0.08
    let scaleAdjustedRadius = scale < 1.0 ? max(frameRadius, minimumEndRadius / scale) : frameRadius
    return min(max(scaleAdjustedRadius, 48.0), shorterSide * 0.35)
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
#if os(iOS)
    let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
    return origin.withOffset(CGVector(dx: x, dy: y))
#else
    let root = interactionRoot(app: app)
    let origin = root.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
    let rootFrame = root.frame
    let offsetX = x - Double(rootFrame.origin.x)
    let offsetY = y - Double(rootFrame.origin.y)
    return origin.withOffset(CGVector(dx: offsetX, dy: offsetY))
#endif
  }
#endif

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
  // Identity in portrait/unknown, 90° per landscape, 180° upside-down.
  func testNativeSynthesizedPointRotatesByInterfaceOrientation() {
    let portrait = CGRect(x: 0, y: 0, width: 834, height: 1210)
    let landscape = CGRect(x: 0, y: 0, width: 1210, height: 834)
    let offsetLandscape = CGRect(x: 10, y: 20, width: 1210, height: 834)
    // (frame, UIInterfaceOrientation, expected native point) for a tap at (170, 268).
    let cases: [(CGRect, Int, CGPoint)] = [
      (portrait, RunnerInterfaceOrientation.portrait, CGPoint(x: 170, y: 268)),
      (landscape, RunnerInterfaceOrientation.landscapeRight, CGPoint(x: 566, y: 170)),
      (landscape, RunnerInterfaceOrientation.landscapeLeft, CGPoint(x: 268, y: 1040)),
      (portrait, RunnerInterfaceOrientation.portraitUpsideDown, CGPoint(x: 664, y: 942)),
      (portrait, RunnerInterfaceOrientation.unknown, CGPoint(x: 170, y: 268)),
    ]
    for (frame, orientation, expected) in cases {
      XCTAssertEqual(
        nativeSynthesizedPoint(orientedX: 170, orientedY: 268, in: frame, interfaceOrientation: orientation),
        expected,
        "interfaceOrientation \(orientation)"
      )
    }
    XCTAssertEqual(
      nativeSynthesizedPoint(
        orientedX: 180,
        orientedY: 288,
        in: offsetLandscape,
        interfaceOrientation: RunnerInterfaceOrientation.landscapeLeft
      ),
      CGPoint(x: 268, y: 1040),
      "non-zero frame origin is localized before rotation"
    )
  }

  func testNativeSynthesizedVectorRotatesByInterfaceOrientation() {
    let cases: [(Int, CGVector)] = [
      (RunnerInterfaceOrientation.portrait, CGVector(dx: 40, dy: -20)),
      (RunnerInterfaceOrientation.landscapeRight, CGVector(dx: 20, dy: 40)),
      (RunnerInterfaceOrientation.landscapeLeft, CGVector(dx: -20, dy: -40)),
      (RunnerInterfaceOrientation.portraitUpsideDown, CGVector(dx: -40, dy: 20)),
      (RunnerInterfaceOrientation.unknown, CGVector(dx: 40, dy: -20)),
    ]
    for (orientation, expected) in cases {
      let vector = nativeSynthesizedVector(orientedDx: 40, orientedDy: -20, interfaceOrientation: orientation)
      XCTAssertEqual(vector.dx, expected.dx, "dx interfaceOrientation \(orientation)")
      XCTAssertEqual(vector.dy, expected.dy, "dy interfaceOrientation \(orientation)")
    }
  }

  func testFiniteSynthesizedReferenceFramePrefersValidAppFrame() throws {
    let frame = try XCTUnwrap(
      finiteSynthesizedReferenceFrame(
        appFrame: CGRect(x: 4, y: 8, width: 390, height: 844),
        fallbackBounds: CGRect(x: 0, y: 0, width: 1, height: 1),
        fallbackScreenshotSize: { CGSize(width: 2, height: 2) }
      )
    )

    XCTAssertEqual(frame, CGRect(x: 4, y: 8, width: 390, height: 844))
  }

  func testFiniteSynthesizedReferenceFrameFallsBackWithoutUsingInvalidAppFrame() throws {
    let frame = try XCTUnwrap(
      finiteSynthesizedReferenceFrame(
        appFrame: .infinite,
        fallbackBounds: CGRect(x: 20, y: 30, width: 430, height: 932),
        fallbackScreenshotSize: {
          XCTFail("screenshot fallback should not be used when screen bounds are finite")
          return CGSize(width: 1, height: 1)
        }
      )
    )

    XCTAssertEqual(frame, CGRect(x: 0, y: 0, width: 430, height: 932))
  }

  func testFiniteSynthesizedReferenceFrameFallsBackToScreenshotSize() throws {
    let frame = try XCTUnwrap(
      finiteSynthesizedReferenceFrame(
        appFrame: .infinite,
        fallbackBounds: .zero,
        fallbackScreenshotSize: { CGSize(width: 430, height: 932) }
      )
    )

    XCTAssertEqual(frame, CGRect(x: 0, y: 0, width: 430, height: 932))
  }

  func testFiniteSynthesizedReferenceFrameRejectsInvalidSources() {
    XCTAssertNil(
      finiteSynthesizedReferenceFrame(
        appFrame: .infinite,
        fallbackBounds: .zero,
        fallbackScreenshotSize: { CGSize(width: CGFloat.infinity, height: 932) }
      )
    )
  }

  func testDesktopScrollWheelDeltasMapDirections() throws {
    XCTAssertEqual(try XCTUnwrap(desktopScrollWheelDeltas(direction: "up", pixels: 120)).vertical, 120)
    XCTAssertEqual(try XCTUnwrap(desktopScrollWheelDeltas(direction: "down", pixels: 120)).vertical, -120)
    XCTAssertEqual(try XCTUnwrap(desktopScrollWheelDeltas(direction: "left", pixels: 120)).horizontal, 120)
    XCTAssertEqual(try XCTUnwrap(desktopScrollWheelDeltas(direction: "right", pixels: 120)).horizontal, -120)
    XCTAssertNil(desktopScrollWheelDeltas(direction: "diagonal", pixels: 120))
  }

  func testDesktopScrollWheelDeltaEventsHonorDurationAndPreservePixels() throws {
    let events = try XCTUnwrap(desktopScrollWheelDeltaEvents(direction: "down", pixels: 200, durationMs: 50))
    XCTAssertEqual(events.count, 4)
    XCTAssertEqual(events.map(\.vertical).reduce(0, +), -200)
    XCTAssertEqual(events.map(\.horizontal).reduce(0, +), 0)
    XCTAssertEqual(desktopScrollEventIntervalSeconds(durationMs: 50, eventCount: events.count), 0.05 / 3.0)
  }

  func testDesktopScrollWheelDeltaEventsKeepInstantScrollSingleEvent() throws {
    let events = try XCTUnwrap(desktopScrollWheelDeltaEvents(direction: "down", pixels: 200, durationMs: 0))
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.vertical, -200)
  }
#endif
}
