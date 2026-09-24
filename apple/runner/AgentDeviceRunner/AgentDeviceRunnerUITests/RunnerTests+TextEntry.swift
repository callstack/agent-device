import XCTest

// Text entry & keyboard-readiness for the runner: the focus -> type -> verify -> repair
// pipeline, readiness polling, and field clearing. Behavior-preserving extraction from
// RunnerTests+Interaction.swift (no logic changes) to keep that file navigable.
extension RunnerTests {
  enum TextEntryFailure: String {
    case notFocused = "TEXT_INPUT_NOT_FOCUSED"
    case synthesisUnavailable = "TEXT_INPUT_SYNTHESIS_UNAVAILABLE"
    case commitNotObserved = "TEXT_INPUT_COMMIT_NOT_OBSERVED"
    case synthesisBudgetExceeded = "TEXT_INPUT_SYNTHESIS_BUDGET_EXCEEDED"

    var message: String {
      switch self {
      case .notFocused:
        return "No focused text input was available for typing."
      case .synthesisUnavailable:
        return "Reliable text synthesis is unavailable while the software keyboard is hidden."
      case .commitNotObserved:
        return "The runner could not confirm the typed text reached the field."
      case .synthesisBudgetExceeded:
        return "The text is longer than one runner command can type at this pace."
      }
    }

    var hint: String {
      switch self {
      case .notFocused:
        return "Focus a visible text input, then retry type or fill. If the input is not exposed by accessibility, use a coordinate focus command before typing."
      case .synthesisUnavailable:
        return "Show the software keyboard, then retry type."
      case .commitNotObserved:
        return "The field may hold none, part, or all of the text. Run snapshot -i and inspect the field: if it already matches, continue; otherwise retry fill with the full text quoted and --delay-ms 80. Do not use type, which appends to whatever committed."
      case .synthesisBudgetExceeded:
        return "Fill at most \(SynthesizedDeliveryBudget.maxTextLength(delaySeconds: 0)) characters at a time without --delay-ms and append the rest with separate type commands, keeping each command inside that budget. --delay-ms lowers the budget, because every character then pays its own synthesize call and the delay: \(SynthesizedDeliveryBudget.maxTextLength(delaySeconds: 0.08)) characters at --delay-ms 80. A longer timeout does not help: this route is chosen when the accessibility channel is already degraded, and the pace is what makes the text long."
      }
    }
  }

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
    /// How long the commit wait tolerates seeing NO further progress toward the expected value.
    /// Numerically the flat deadline this replaced, so a pipeline that delivers nothing is
    /// condemned at exactly the same instant it always was (see `SynthesizedCommitDeadline`).
    static let synthesizedCommitStallTimeout: TimeInterval = 3.0
    /// The commit wait's absolute bound, however long characters keep arriving. Synthesized
    /// delivery happens before this wait starts and is bounded by `synthesizedDeliveryCeiling`, so
    /// the two together stay inside the daemon's per-command budget
    /// (`RUNNER_COMMAND_TIMEOUT_MS`, 45s), which also has to cover focus, clear and verification.
    static let synthesizedCommitCeiling: TimeInterval = 10.0
    /// How long a synthesized burst may spend posting its characters. The private synthesize call
    /// delivers as it returns, so this is the slice of the 45s command budget the burst itself may
    /// take, with the commit ceiling, focus, clear and verification subtracted and margin left for
    /// the round trip each character costs. Text that does not fit is refused before the first
    /// character is posted: a transport timeout would end the command with the runner still typing,
    /// and the next command would find it busy.
    static let synthesizedDeliveryCeiling: TimeInterval = 30.0
    /// The edit-acknowledge budget the synthesized pace is sized for: an app that renders each edit
    /// within this window has nothing to erase when a burst replaces its field, and one that needs
    /// longer loses the characters that arrive while a render is in flight.
    /// `testSynthesizedPaceLeavesRoomForAnAppToAcknowledgeEachEdit` pins the pace against it.
    static let synthesizedAcknowledgeWindowSeconds: TimeInterval = 0.04
    static let synthesizedCommitPollInterval: TimeInterval = 0.2
  }

  struct TextEntryResult {
    let verified: Bool?
    let repaired: Bool
    let expectedText: String?
    let observedText: String?
    var textEntryRoute: String? = nil
    var failure: TextEntryFailure? = nil
  }

  struct TextEntryTarget {
    let element: XCUIElement?
    let refreshPoint: CGPoint?
    let prefersFocusedElement: Bool
    let fromTapWitness: Bool

    init(
      element: XCUIElement?,
      refreshPoint: CGPoint?,
      prefersFocusedElement: Bool,
      fromTapWitness: Bool = false
    ) {
      self.element = element
      self.refreshPoint = refreshPoint
      self.prefersFocusedElement = prefersFocusedElement
      self.fromTapWitness = fromTapWitness
    }

    func withElement(_ nextElement: XCUIElement?) -> TextEntryTarget {
      guard let nextElement else {
        return self
      }
      let frame = nextElement.frame
      let point = frame.isEmpty ? refreshPoint : CGPoint(x: frame.midX, y: frame.midY)
      return TextEntryTarget(
        element: nextElement,
        refreshPoint: point,
        prefersFocusedElement: prefersFocusedElement,
        fromTapWitness: fromTapWitness
      )
    }
  }

  struct TextEntryStabilization {
    let element: XCUIElement?
    let focusConfirmed: Bool
  }

  struct TextEntryTapWitness {
    let element: XCUIElement
    let bundleId: String?
    let processIdentifier: Int?

    func matches(bundleId: String?, processIdentifier: Int?) -> Bool {
      self.bundleId == bundleId && self.processIdentifier == processIdentifier
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
    if Self.textMatchesPlaceholder(value, placeholder: element.placeholderValue) {
      return true
    }
    let normalizedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedValue.isEmpty else {
      return false
    }
    if isGenericTextInputLabel(normalizedValue) {
      return true
    }
    let normalizedLabel = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
    return normalizedLabel == normalizedValue && isGenericTextInputLabel(normalizedLabel)
  }

  static func textMatchesPlaceholder(_ text: String, placeholder: String?) -> Bool {
    let normalizedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedText.isEmpty else { return false }
    let normalizedPlaceholder = placeholder?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return !normalizedPlaceholder.isEmpty && normalizedText == normalizedPlaceholder
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
