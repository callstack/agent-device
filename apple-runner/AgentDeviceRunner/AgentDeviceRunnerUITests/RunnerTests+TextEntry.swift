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

  func stabilizeTextInputBeforeTyping(app: XCUIApplication, target: XCUIElement?) -> XCUIElement? {
#if os(tvOS)
    return target
#else
    let latest = target
    let keyboardVisibleAtEntry = isKeyboardVisible(app: app)
    let deadline = Date().addingTimeInterval(TextEntryTiming.focusTimeout)
    while Date() < deadline {
      if let focused = focusedTextInput(app: app) {
        return focused
      }
      // focusedTextInput is intentionally nil on iOS; treat the keyboard transitioning to
      // visible after our tap as the focus-moved signal. Don't fast-path when it was already up.
      if keyboardBecameVisible(app: app, wasVisibleAtEntry: keyboardVisibleAtEntry) {
        return latest
      }
      sleepFor(TextEntryTiming.pollInterval)
    }
    return latest
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
    let stabilized = stabilizeTextInputBeforeTyping(app: app, target: target)
    let element = waitForTextEntryReadiness(
      app: app,
      target: TextEntryTarget(
        element: stabilized ?? target,
        refreshPoint: requestedPoint,
        prefersFocusedElement: false
      )
    ) ?? stabilized ?? target
    return TextEntryTarget(
      element: element,
      refreshPoint: textEntryRefreshPoint(for: element) ?? requestedPoint,
      prefersFocusedElement: false
    )
  }

  func focusTextInputForTextEntry(app: XCUIApplication, element: XCUIElement) -> TextEntryTarget {
    let point = textEntryRefreshPoint(for: element)
    if let point {
      _ = tapAt(app: app, x: point.x, y: point.y)
    }
    let stabilized = stabilizeTextInputBeforeTyping(app: app, target: element)
    let resolved = waitForTextEntryReadiness(
      app: app,
      target: TextEntryTarget(
        element: stabilized ?? element,
        refreshPoint: point,
        prefersFocusedElement: false
      )
    ) ?? stabilized ?? element
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
      return command.clearFirst == true ? .replacement : .none
    }
  }

  func typeTextReliably(
    app: XCUIApplication,
    target: TextEntryTarget,
    text: String,
    delaySeconds: Double,
    repairMode: TextTypingRepairMode = .none
  ) -> TextEntryResult {
    guard !text.isEmpty else {
      return TextEntryResult(verified: true, repaired: false, expectedText: "", observedText: "")
    }
    var activeTarget = target
    let initialTarget = resolveTextEntryElement(app: app, target: activeTarget)
    activeTarget = activeTarget.withElement(initialTarget)
    let currentText = editableTextValue(for: initialTarget, treatingPlaceholderAsEmpty: true)
    let initialText = repairMode == .append ? currentText : nil
    let expectedText = expectedTextEntryValue(typedText: text, mode: repairMode, initialText: initialText)

    if repairMode == .replacement {
      guard let replacementTarget = initialTarget else {
        return TextEntryResult(verified: nil, repaired: false, expectedText: expectedText, observedText: nil)
      }
      if currentText == nil || currentText?.isEmpty == false {
        clearTextInput(replacementTarget)
        activeTarget = activeTarget.withElement(replacementTarget)
      }
    }

    func typeIntoCurrentTarget(_ value: String) -> XCUIElement? {
      if let currentTarget = resolveTextEntryElement(app: app, target: activeTarget) {
        app.typeText(value)
        return currentTarget
      } else {
        app.typeText(value)
        return resolveTextEntryElement(app: app, target: activeTarget)
      }
    }

    func waitForWarmupValue(_ expectedValue: String?, target: TextEntryTarget) {
      guard let expectedValue else {
        sleepFor(TextEntryTiming.pollInterval)
        return
      }
      let deadline = Date().addingTimeInterval(TextEntryTiming.warmupValueTimeout)
      while Date() < deadline {
        if editableTextValue(for: resolveTextEntryElement(app: app, target: target)) == expectedValue {
          return
        }
        sleepFor(TextEntryTiming.pollInterval)
      }
    }

    let characters = Array(text)
    if delaySeconds > 0 && characters.count > 1 {
      var typedTarget: XCUIElement?
      for (index, character) in characters.enumerated() {
        typedTarget = typeIntoCurrentTarget(String(character)) ?? typedTarget
        if index + 1 < characters.count {
          sleepFor(delaySeconds)
        }
      }
      if repairMode == .none {
        return TextEntryResult(verified: nil, repaired: false, expectedText: nil, observedText: nil)
      }
      let repairResult = repairTextEntryIfNeeded(
        app: app,
        target: activeTarget.withElement(typedTarget),
        expectedText: expectedText,
        repairMode: repairMode
      )
      return verifyTextEntry(
        app: app,
        target: activeTarget.withElement(typedTarget),
        expectedText: expectedText,
        repaired: repairResult.repaired
      )
    }

    let typedTarget: XCUIElement?
    if repairMode != .none && characters.count > 1 {
      let firstCharacter = String(characters[0])
      var firstTypedTarget = typeIntoCurrentTarget(firstCharacter)
      activeTarget = activeTarget.withElement(firstTypedTarget)
      let warmupExpectedText = expectedTextEntryValue(
        typedText: firstCharacter,
        mode: repairMode,
        initialText: initialText
      )
      waitForWarmupValue(warmupExpectedText, target: activeTarget)
      let remainingText = String(characters.dropFirst())
      firstTypedTarget = typeIntoCurrentTarget(remainingText) ?? firstTypedTarget
      typedTarget = firstTypedTarget
    } else {
      typedTarget = typeIntoCurrentTarget(text)
    }
    if repairMode == .none {
      return TextEntryResult(verified: nil, repaired: false, expectedText: nil, observedText: nil)
    }
    let repairResult = repairTextEntryIfNeeded(
      app: app,
      target: activeTarget.withElement(typedTarget),
      expectedText: expectedText,
      repairMode: repairMode
    )
    return verifyTextEntry(
      app: app,
      target: activeTarget.withElement(typedTarget),
      expectedText: expectedText,
      repaired: repairResult.repaired
    )
  }

  private func repairTextEntryIfNeeded(
    app: XCUIApplication,
    target: TextEntryTarget,
    expectedText: String?,
    repairMode: TextTypingRepairMode
  ) -> TextEntryResult {
#if os(iOS)
    guard let targetElement = resolveTextEntryElement(app: app, target: target) else {
      return TextEntryResult(verified: nil, repaired: false, expectedText: expectedText, observedText: nil)
    }
    guard let expectedText else {
      let observedText = editableTextValue(for: targetElement)
      return TextEntryResult(verified: nil, repaired: false, expectedText: nil, observedText: observedText)
    }
    guard shouldRepairTextEntry(
      app: app,
      target: target,
      expectedText: expectedText,
      repairMode: repairMode
    ) else {
      return verifyTextEntry(app: app, target: target, expectedText: expectedText, repaired: false)
    }

    guard let repairTarget = resolveTextEntryElement(app: app, target: target) else {
      return TextEntryResult(verified: nil, repaired: false, expectedText: expectedText, observedText: nil)
    }
    let observedText = editableTextValue(for: repairTarget) ?? ""
    NSLog(
      "AGENT_DEVICE_RUNNER_REPAIR_TEXT_ENTRY expectedLength=%d observedLength=%d",
      expectedText.count,
      observedText.count
    )
    clearTextInput(repairTarget)
    app.typeText(expectedText)
    return verifyTextEntry(app: app, target: target, expectedText: expectedText, repaired: true)
#else
    return TextEntryResult(verified: nil, repaired: false, expectedText: expectedText, observedText: nil)
#endif
  }

  private func verifyTextEntry(
    app: XCUIApplication,
    target: TextEntryTarget,
    expectedText: String?,
    repaired: Bool
  ) -> TextEntryResult {
    let targetElement = resolveTextEntryElement(app: app, target: target)
    guard let expectedText else {
      return TextEntryResult(
        verified: nil,
        repaired: repaired,
        expectedText: nil,
        observedText: editableTextValue(for: targetElement)
      )
    }
    guard let observedText = editableTextValue(for: targetElement) else {
      return TextEntryResult(verified: nil, repaired: repaired, expectedText: expectedText, observedText: nil)
    }
    guard textEntryValueMatchesExpected(targetElement, observedText: observedText, expectedText: expectedText) else {
      return TextEntryResult(
        verified: false,
        repaired: repaired,
        expectedText: expectedText,
        observedText: observedText
      )
    }
    let stableDeadline = Date().addingTimeInterval(TextEntryTiming.verificationStabilityWindow)
    var latestObservedText = observedText
    while Date() < stableDeadline {
      sleepFor(TextEntryTiming.pollInterval)
      guard let nextObservedText = editableTextValue(for: resolveTextEntryElement(app: app, target: target)) else {
        return TextEntryResult(verified: nil, repaired: repaired, expectedText: expectedText, observedText: nil)
      }
      latestObservedText = nextObservedText
      guard textEntryValueMatchesExpected(
        resolveTextEntryElement(app: app, target: target),
        observedText: nextObservedText,
        expectedText: expectedText
      ) else {
        return TextEntryResult(
          verified: false,
          repaired: repaired,
          expectedText: expectedText,
          observedText: nextObservedText
        )
      }
    }
    return TextEntryResult(
      verified: true,
      repaired: repaired,
      expectedText: expectedText,
      observedText: latestObservedText
    )
  }

  private func textEntryValueMatchesExpected(
    _ element: XCUIElement?,
    observedText: String,
    expectedText: String
  ) -> Bool {
    if observedText == expectedText {
      return true
    }
    guard hasTextEntrySubmitSuffix(expectedText), element?.elementType != .textView else {
      return false
    }
    var submittedText = expectedText
    while hasTextEntrySubmitSuffix(submittedText) {
      submittedText.removeLast()
    }
    return observedText == submittedText
  }

  private func hasTextEntrySubmitSuffix(_ text: String) -> Bool {
    text.hasSuffix("\n") || text.hasSuffix("\r")
  }

  private func expectedTextEntryValue(
    typedText: String,
    mode: TextTypingRepairMode,
    initialText: String?
  ) -> String? {
    switch mode {
    case .none:
      return nil
    case .append:
      guard let initialText else {
        return nil
      }
      return initialText + typedText
    case .replacement:
      return typedText
    }
  }

  private func shouldRepairTextEntry(
    app: XCUIApplication,
    target: TextEntryTarget,
    expectedText: String,
    repairMode: TextTypingRepairMode
  ) -> Bool {
#if os(iOS)
    var latestObservedText: String?
    let deadline = Date().addingTimeInterval(TextEntryTiming.verificationStabilityWindow)
    repeat {
      guard let observedText = editableTextValue(for: resolveTextEntryElement(app: app, target: target)) else {
        return false
      }
      if textEntryValueMatchesExpected(
        resolveTextEntryElement(app: app, target: target),
        observedText: observedText,
        expectedText: expectedText
      ) {
        return false
      }
      latestObservedText = observedText
      if !isRepairableTextEntryMismatch(
        observedText: observedText,
        expectedText: expectedText,
        repairMode: repairMode
      ) {
        return false
      }
      sleepFor(TextEntryTiming.pollInterval)
    } while Date() < deadline

    guard let latestObservedText else {
      return false
    }
    guard !textEntryValueMatchesExpected(
      resolveTextEntryElement(app: app, target: target),
      observedText: latestObservedText,
      expectedText: expectedText
    ) else {
      return false
    }
    return isRepairableTextEntryMismatch(
      observedText: latestObservedText,
      expectedText: expectedText,
      repairMode: repairMode
    )
#else
    return false
#endif
  }

  private func isRepairableTextEntryMismatch(
    observedText: String,
    expectedText: String,
    repairMode: TextTypingRepairMode
  ) -> Bool {
    guard observedText != expectedText else {
      return false
    }
    if repairMode == .replacement {
      return true
    }
    return observedText.isEmpty || isLikelyDroppedCharacterTextEntryMismatch(
      observedText: observedText,
      expectedText: expectedText
    )
  }

  private func isLikelyDroppedCharacterTextEntryMismatch(observedText: String, expectedText: String) -> Bool {
    guard observedText.count < expectedText.count else {
      return false
    }
    let missingCharacterCount = expectedText.count - observedText.count
    guard missingCharacterCount <= max(2, expectedText.count / 4) else {
      return false
    }
    var expectedIndex = expectedText.startIndex
    for character in observedText {
      guard let matchIndex = expectedText[expectedIndex...].firstIndex(of: character) else {
        return false
      }
      expectedIndex = expectedText.index(after: matchIndex)
    }
    return true
  }

  private func resolveTextEntryElement(app: XCUIApplication, target: TextEntryTarget) -> XCUIElement? {
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

  private func editableTextValue(
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
