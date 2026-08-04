import XCTest

// Text entry & keyboard-readiness for the runner: the focus -> type -> verify -> repair
// pipeline, readiness polling, and field clearing. Behavior-preserving extraction from
// RunnerTests+Interaction.swift (no logic changes) to keep that file navigable.
extension RunnerTests {
  enum TextTypingRepairMode {
    case none
    case append
    case replacement
  }

  enum TextEntryTiming {
    static let focusTimeout: TimeInterval = 0.4
    static let readinessTimeout: TimeInterval = 2.0
    static let hardwareKeyboardFallbackTimeout: TimeInterval = 0.35
    static let pollInterval: TimeInterval = 0.02
    static let warmupValueTimeout: TimeInterval = 0.4
    static let verificationStabilityWindow: TimeInterval = 0.2
  }

  struct TextEntryResult {
    let verified: Bool?
    let repaired: Bool
    let expectedText: String?
    let observedText: String?
    var textEntryRoute: String? = nil
  }

  struct TextEntryTarget {
    let element: XCUIElement?
    let refreshPoint: CGPoint?
    let prefersFocusedElement: Bool

    func withElement(_ nextElement: XCUIElement?) -> TextEntryTarget {
      guard let nextElement else {
        return self
      }
      let frame = nextElement.frame
      let point = frame.isEmpty ? refreshPoint : CGPoint(x: frame.midX, y: frame.midY)
      return TextEntryTarget(
        element: nextElement,
        refreshPoint: point,
        prefersFocusedElement: prefersFocusedElement
      )
    }
  }

  struct TextEntryStabilization {
    let element: XCUIElement?
    let focusConfirmed: Bool
  }

  func clearTextInput(_ element: XCUIElement) {
    // Skip the clear (delete burst + moveCaretToEnd edge-tap) ONLY when we can confirm the
    // field is empty. Why skip: the edge-tap computes a point from the element frame, which can
    // be stale after the field repositions on focus (e.g. the Settings search bar jumps
    // bottom->top and reveals a "Suggestions" list) — tapping there navigates away instead of
    // clearing; and replacing into an already-empty field is a no-op anyway.
    // editableTextValue returns nil for secure (and unknown) fields, where we CANNOT confirm
    // emptiness — those must still be cleared, or replace would concatenate stale + new text.
    // So distinguish nil (clear) from "" (skip).
    if let existing = editableTextValue(for: element, treatingPlaceholderAsEmpty: true),
       existing.isEmpty {
      return
    }
#if !os(tvOS)
    moveCaretToEnd(element: element)
#endif
    let count = estimatedDeleteCount(for: element)
    let deletes = String(repeating: XCUIKeyboardKey.delete.rawValue, count: count)
    element.typeText(deletes)
  }

  func focusedTextInput(app: XCUIApplication) -> XCUIElement? {
#if os(iOS)
    // iOS focus predicates can return stale or misleading text-input matches
    // under XCUITest, so text entry readiness is driven by tap/keyboard state.
    return nil
#else
    return safely("FOCUSED_INPUT_QUERY") {
      let candidates = app
        .descendants(matching: .any)
        .matching(NSPredicate(format: "hasKeyboardFocus == 1"))
        .allElementsBoundByIndex
      for candidate in candidates where candidate.exists {
        switch candidate.elementType {
        case .textField, .secureTextField, .searchField, .textView:
          return candidate
        default:
          continue
        }
      }
      return nil
    }
#endif
  }

  func stabilizeTextInputBeforeTyping(
    app: XCUIApplication,
    target: XCUIElement?,
    keyboardVisibleBeforeTap: Bool? = nil
  ) -> TextEntryStabilization {
#if os(tvOS)
    return TextEntryStabilization(element: target, focusConfirmed: true)
#else
    let latest = target
    let keyboardVisibleAtEntry = keyboardVisibleBeforeTap ?? isKeyboardVisible(app: app)
    let deadline = Date().addingTimeInterval(TextEntryTiming.focusTimeout)
    while Date() < deadline {
      if let focused = focusedTextInput(app: app) {
        return TextEntryStabilization(element: focused, focusConfirmed: true)
      }
      // focusedTextInput is intentionally nil on iOS; treat the keyboard transitioning to
      // visible after our tap as the focus-moved signal. Don't fast-path when it was already up.
      if keyboardBecameVisible(app: app, wasVisibleAtEntry: keyboardVisibleAtEntry) {
        return TextEntryStabilization(element: latest, focusConfirmed: true)
      }
      sleepFor(TextEntryTiming.pollInterval)
    }
    return TextEntryStabilization(element: latest, focusConfirmed: false)
#endif
  }

  func focusTextInputForTextEntry(app: XCUIApplication, x: Double?, y: Double?) -> TextEntryTarget {
    guard let x, let y else {
      // Bare `type` targets the current first responder. On iOS we intentionally do not trust
      // `hasKeyboardFocus`, but an already-visible software keyboard is sufficient evidence that
      // app.typeText has a receiver; waiting the full readiness timeout cannot prove a stronger
      // target because there is no selector/coordinate focus move to validate.
      if isKeyboardVisible(app: app) {
        return TextEntryTarget(
          element: focusedTextInput(app: app),
          refreshPoint: nil,
          prefersFocusedElement: true
        )
      }
      let focused = waitForTextEntryReadiness(
        app: app,
        target: TextEntryTarget(
          element: focusedTextInput(app: app),
          refreshPoint: nil,
          prefersFocusedElement: true
        )
      )
      return TextEntryTarget(element: focused, refreshPoint: nil, prefersFocusedElement: true)
    }

    let keyboardVisibleBeforeTap = isKeyboardVisible(app: app)
    let target = textInputAt(app: app, x: x, y: y)
    let requestedPoint = CGPoint(x: x, y: y)
    if let target {
      let frame = target.frame
      if !frame.isEmpty {
        _ = tapAt(app: app, x: frame.midX, y: frame.midY)
      } else {
        _ = tapAt(app: app, x: x, y: y)
      }
    } else {
      _ = tapAt(app: app, x: x, y: y)
    }
    // A visible keyboard is not enough evidence for app.typeText, because focus may still
    // belong to a previous field. With a concrete target we type through XCUIElement.typeText,
    // so after tapping it the iOS readiness timeout cannot prove anything stronger.
    if keyboardVisibleBeforeTap, let target {
      return TextEntryTarget(
        element: target,
        refreshPoint: textEntryRefreshPoint(for: target) ?? requestedPoint,
        prefersFocusedElement: false
      )
    }
    let stabilized = stabilizeTextInputBeforeTyping(
      app: app,
      target: target,
      keyboardVisibleBeforeTap: keyboardVisibleBeforeTap
    )
    let readyTarget = TextEntryTarget(
      element: stabilized.element ?? target,
      refreshPoint: requestedPoint,
      prefersFocusedElement: false
    )
    let concreteTargetReady = keyboardVisibleBeforeTap && readyTarget.element != nil
    let element = stabilized.focusConfirmed || concreteTargetReady
      ? (stabilized.element ?? target)
      : (waitForTextEntryReadiness(app: app, target: readyTarget) ?? stabilized.element ?? target)
    return TextEntryTarget(
      element: element,
      refreshPoint: textEntryRefreshPoint(for: element) ?? requestedPoint,
      prefersFocusedElement: false
    )
  }

  func focusTextInputForTextEntry(app: XCUIApplication, element: XCUIElement) -> TextEntryTarget {
    let point = textEntryRefreshPoint(for: element)
    let keyboardVisibleBeforeTap = isKeyboardVisible(app: app)
    if let point {
      _ = tapAt(app: app, x: point.x, y: point.y)
    }
    // See the coordinate-target path above: direct element typing keeps this scoped to the
    // tapped target, while the first-character warmup and final verify still catch dropped input.
    if keyboardVisibleBeforeTap {
      return TextEntryTarget(
        element: element,
        refreshPoint: textEntryRefreshPoint(for: element) ?? point,
        prefersFocusedElement: false
      )
    }
    let stabilized = stabilizeTextInputBeforeTyping(
      app: app,
      target: element,
      keyboardVisibleBeforeTap: keyboardVisibleBeforeTap
    )
    let readyTarget = TextEntryTarget(
      element: stabilized.element ?? element,
      refreshPoint: point,
      prefersFocusedElement: false
    )
    let resolved = stabilized.focusConfirmed
      ? (stabilized.element ?? element)
      : (waitForTextEntryReadiness(app: app, target: readyTarget) ?? stabilized.element ?? element)
    return TextEntryTarget(
      element: resolved,
      refreshPoint: textEntryRefreshPoint(for: resolved) ?? point,
      prefersFocusedElement: false
    )
  }

  func isTextEntryElement(_ element: XCUIElement) -> Bool {
    switch element.elementType {
    case .textField, .secureTextField, .searchField, .textView:
      return true
    default:
      return false
    }
  }

  func resolveTextEntryMode(_ command: Command) -> TextTypingRepairMode {
    switch command.textEntryMode {
    case "append":
      return .append
    case "replace":
      return .replacement
    default:
      return .none
    }
  }

  func resolveTextEntryElement(app: XCUIApplication, target: TextEntryTarget) -> XCUIElement? {
    if target.prefersFocusedElement {
      if let focused = focusedTextInput(app: app) {
        return focused
      }
      if let element = target.element, element.exists {
        return element
      }
    } else {
      if let element = target.element, element.exists {
        return element
      }
    }
    if let refreshPoint = target.refreshPoint,
       let refreshed = textInputAt(app: app, x: refreshPoint.x, y: refreshPoint.y) {
      return refreshed
    }
    if let focused = focusedTextInput(app: app) {
      return focused
    }
    return nil
  }

  private func waitForTextEntryReadiness(
    app: XCUIApplication,
    target: TextEntryTarget,
    timeout: TimeInterval = TextEntryTiming.readinessTimeout
  ) -> XCUIElement? {
#if os(iOS)
    var latest = resolveTextEntryElement(app: app, target: target)
    let keyboardVisibleAtEntry = isKeyboardVisible(app: app)
    let deadline = Date().addingTimeInterval(timeout)
    let hardwareKeyboardFallback = Date().addingTimeInterval(
      min(TextEntryTiming.hardwareKeyboardFallbackTimeout, timeout)
    )
    var sawSoftwareKeyboard = false
    while Date() < deadline {
      if let focused = focusedTextInput(app: app) {
        latest = focused
        if isKeyboardVisible(app: app) {
          return focused
        }
      }
      // Fast-path on a keyboard hidden->visible transition: our tapped field gained focus, so
      // return immediately instead of burning the full readinessTimeout (warmup-first-char echo
      // + post-type verify/repair remain as drop safety nets). When the keyboard was ALREADY up
      // (back-to-back fills), this isn't a focus signal — fall through to the settle/timeout so
      // text isn't sent to the previously-focused field.
      if keyboardBecameVisible(app: app, wasVisibleAtEntry: keyboardVisibleAtEntry) {
        return latest
      }
      sawSoftwareKeyboard = sawSoftwareKeyboard || keyboardElementExists(app: app)
      if !sawSoftwareKeyboard && Date() >= hardwareKeyboardFallback && latest != nil {
        return latest
      }
      sleepFor(TextEntryTiming.pollInterval)
    }
    return focusedTextInput(app: app) ?? latest
#else
    return resolveTextEntryElement(app: app, target: target)
#endif
  }

  func waitForTextEntryReadinessAfterTap(app: XCUIApplication, element: XCUIElement) {
#if os(iOS)
    switch element.elementType {
    case .textField, .secureTextField, .searchField, .textView:
      if waitForFocusedTextInput(app: app, timeout: TextEntryTiming.readinessTimeout) != nil {
        return
      }
      let frame = element.frame
      if !frame.isEmpty {
        _ = tapAt(app: app, x: frame.midX, y: frame.midY)
        _ = waitForFocusedTextInput(app: app, timeout: TextEntryTiming.readinessTimeout)
      }
    default:
      return
    }
#endif
  }

  private func waitForFocusedTextInput(app: XCUIApplication, timeout: TimeInterval) -> XCUIElement? {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if let focused = focusedTextInput(app: app) {
        return focused
      }
      sleepFor(TextEntryTiming.pollInterval)
    }
    return focusedTextInput(app: app)
  }

  private func textEntryRefreshPoint(for element: XCUIElement?) -> CGPoint? {
    guard let element else {
      return nil
    }
    let frame = element.frame
    guard !frame.isEmpty else {
      return nil
    }
    return CGPoint(x: frame.midX, y: frame.midY)
  }

  /// A focus-moved signal for iOS text entry, where `focusedTextInput` is intentionally nil.
  /// The software keyboard TRANSITIONING from hidden (at entry) to visible means the field we
  /// just tapped gained first-responder. If the keyboard was ALREADY up (e.g. back-to-back
  /// fills into different fields), its visibility is not evidence focus moved to the new field,
  /// so callers must keep waiting rather than typing into the previously-focused field.
  private func keyboardBecameVisible(app: XCUIApplication, wasVisibleAtEntry: Bool) -> Bool {
    return !wasVisibleAtEntry && isKeyboardVisible(app: app)
  }

  private func keyboardElementExists(app: XCUIApplication) -> Bool {
#if os(iOS)
    return safely("KEYBOARD_EXISTS", false) { app.keyboards.firstMatch.exists }
#else
    return false
#endif
  }

  private func moveCaretToEnd(element: XCUIElement) {
#if os(tvOS)
    return
#else
    let frame = element.frame
    guard !frame.isEmpty else {
      element.tap()
      return
    }
    let origin = element.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
    let target = origin.withOffset(
      CGVector(dx: max(2, frame.width - 4), dy: max(2, frame.height / 2))
    )
    target.tap()
#endif
  }

  private func estimatedDeleteCount(for element: XCUIElement) -> Int {
    let valueText = normalizedElementText(element.value)
    let base = valueText.isEmpty ? 24 : (valueText.count + 8)
    return max(24, min(120, base))
  }

  private func normalizedElementText(_ value: Any?) -> String {
    String(describing: value ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func editableTextValue(
    for element: XCUIElement?,
    treatingPlaceholderAsEmpty: Bool = false
  ) -> String? {
    guard let element else {
      return nil
    }
    switch element.elementType {
    case .textField, .searchField, .textView:
      let value = String(describing: element.value ?? "")
      if treatingPlaceholderAsEmpty && isPlaceholderValue(value, for: element) {
        return ""
      }
      return value
    case .secureTextField:
      return nil
    default:
      return nil
    }
  }

  private func isPlaceholderValue(_ value: String, for element: XCUIElement) -> Bool {
    let normalizedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedValue.isEmpty else {
      return false
    }
    let placeholder = element.placeholderValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !placeholder.isEmpty && normalizedValue == placeholder {
      return true
    }
    if isGenericTextInputLabel(normalizedValue) {
      return true
    }
    let normalizedLabel = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
    return normalizedLabel == normalizedValue && isGenericTextInputLabel(normalizedLabel)
  }

  private func isGenericTextInputLabel(_ value: String) -> Bool {
    switch value {
    case "Text input field":
      return true
    default:
      return false
    }
  }
}
