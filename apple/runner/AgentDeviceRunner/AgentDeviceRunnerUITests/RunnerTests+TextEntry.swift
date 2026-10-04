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
        return "The field may hold none, part, or all of the text. Run snapshot -i and inspect the field: if it already matches, continue; otherwise retry fill with the full text quoted and --delay-ms \(TextEntryTiming.recoveryDelayMilliseconds). Do not use type, which appends to whatever committed."
      case .synthesisBudgetExceeded:
        let recoveryDelay = TextEntryTiming.recoveryDelayMilliseconds
        let recoveryBudget = SynthesizedDeliveryBudget.maxTextLength(
          delaySeconds: Double(recoveryDelay) / 1000
        )
        // Kept inside the 400-character diagnostic bound the host applies to every error string
        // (`REDACTED_STRING_MAX_LENGTH` in packages/kernel/src/redaction.ts): a hint truncated at
        // that boundary looks actionable and is not, which is the failure the iOS open-command hint
        // already refuses to produce.
        return "Fill at most \(SynthesizedDeliveryBudget.maxTextLength(delaySeconds: 0)) characters per command without --delay-ms and append the rest with separate type commands. --delay-ms lowers the limit: each character then gets its own synthesize call and each gap pays the delay, so \(recoveryDelay) ms fits \(recoveryBudget). This route is chosen when the accessibility channel is already degraded, so a longer timeout does not help."
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
    /// How long a replacement value may take to move off its baseline, and then how long an unechoed
    /// value may keep changing before it must hold for `verificationStabilityWindow`; the app renders
    /// the last characters' summary late.
    static let unconfirmedSettleCeiling: TimeInterval = 1.0
    /// How long the commit wait tolerates seeing NO further progress toward the expected value.
    /// Numerically the flat deadline this replaced, so a pipeline that delivers nothing is
    /// condemned at exactly the same instant it always was (see `SynthesizedCommitDeadline`).
    static let synthesizedCommitStallTimeout: TimeInterval = 3.0
    /// The commit wait's absolute bound, however long characters keep arriving. Synthesized
    /// delivery happens before this wait starts and is bounded by `synthesizedDeliveryCeiling`.
    static let synthesizedCommitCeiling: TimeInterval = 10.0
    /// What a synthesized replacement spends before its first character: focusing the field took
    /// 374–500 ms through the daemon on an iPhone 17 Pro simulator.
    static let synthesizedReplacementFocusAllowance: TimeInterval = 2.0
    /// How long a synthesized burst may spend posting its characters: what the command's
    /// main-thread watchdog leaves after focus and the longest commit wait. The private synthesize
    /// call delivers as it returns, so text that does not fit is refused before the first character
    /// is posted; otherwise the watchdog abandons the command with the runner still typing.
    static let synthesizedDeliveryCeiling: TimeInterval = RunnerTests.mainThreadExecutionTimeout
      - synthesizedReplacementFocusAllowance
      - synthesizedCommitCeiling
    /// XCTest's `typingSpeed:` argument: characters per second a synthesized text-input record is
    /// typed at. At 60 the 11 characters of a `fill` arrived at a fixture field across 131 ms
    /// (~13 ms per gap), which is faster than an app that owns its field's value and re-applies it
    /// after the edit (a controlled React Native `TextInput`, an async validator) can acknowledge:
    /// such a write lands between two characters of the burst and erases what was typed while it was
    /// in flight, leaving a value that is stable short of the request. 12 characters/second spaces
    /// them ~83 ms apart on average, which reduces that loss but does not remove it: XCTest does not
    /// space the characters evenly, and two of them can reach the app a few milliseconds apart.
    /// Against a fixture app that acknowledges each edit within 40 ms, 60 characters/second left 1
    /// of 11 characters in 20 of 20 bursts, and this pace left 10 or 11. The command refuses a
    /// field left short; back-pressure from the field (#2906) is what would prevent it. This is the
    /// one pace declaration: it is passed to the bridge that types, and the delivery budget below
    /// charges it, so the pace the app sees and the pace the command is refused at cannot drift. It
    /// is a `UInt` because that is the bridge's argument type, so no call site converts it.
    static let synthesizedCharactersPerSecond: UInt = 12
    /// Seconds two characters of one synthesized burst are typed apart.
    static let synthesizedCharacterInterval: TimeInterval = 1.0 / Double(synthesizedCharactersPerSecond)
    /// What one private synthesize call costs beyond typing its characters, which a `--delay-ms`
    /// plan pays once per character. One-character calls at the shipped pace took 222 ms on average
    /// on an iPhone 17 Pro simulator (212–617 ms over 235 calls), 83 ms of it the character.
    static let synthesizeCallOverhead: TimeInterval = 0.15
    /// The spacing the `TEXT_INPUT_COMMIT_NOT_OBSERVED` recovery tells the caller to retry with.
    static let recoveryDelayMilliseconds = 80
    static let synthesizedCommitPollInterval: TimeInterval = 0.2
  }

  struct TextEntryResult {
    let verified: Bool?
    let repaired: Bool
    let expectedText: String?
    let observedText: String?
    var textEntryRoute: String? = nil
    var failure: TextEntryFailure? = nil
    var unconfirmed: TextEntryUnconfirmedEvidence? = nil
  }

  /// The input a text entry command bound to. XCUIElement exposes no per-instance id, and a query
  /// bound by index or point re-resolves to whatever input occupies that slot now, so element type
  /// plus identifier is the identity. It is unique only when the identifier is non-empty. Unlike
  /// `TextEntryElementIdentity` it leaves out the frame: it must hold across every post of a fill,
  /// while the field can still be moving with the keyboard.
  struct TextEntryInputIdentity: Equatable {
    let elementType: XCUIElement.ElementType
    let identifier: String

    var isDistinguishable: Bool { !identifier.isEmpty }
  }

  struct TextEntryTarget {
    let element: XCUIElement?
    let refreshPoint: CGPoint?
    let prefersFocusedElement: Bool
    let fromTapWitness: Bool
    /// The input the first resolved element was. Once bound, resolution refuses any other input.
    let boundIdentity: TextEntryInputIdentity?

    init(
      element: XCUIElement?,
      refreshPoint: CGPoint?,
      prefersFocusedElement: Bool,
      fromTapWitness: Bool = false,
      boundIdentity: TextEntryInputIdentity? = nil
    ) {
      self.element = element
      self.refreshPoint = refreshPoint
      self.prefersFocusedElement = prefersFocusedElement
      self.fromTapWitness = fromTapWitness
      self.boundIdentity = boundIdentity
    }

    func withElement(_ nextElement: XCUIElement?) -> TextEntryTarget {
      guard let nextElement else {
        return self
      }
      // Reading `frame` from an input the app has removed records an XCTest failure; a snapshot
      // only throws, after XCTest waits about two seconds for a match, so it is skipped when the
      // input is already gone.
      let snapshot = nextElement.exists ? try? nextElement.snapshot() : nil
      let frame = snapshot?.frame ?? .zero
      let point = frame.isEmpty ? refreshPoint : CGPoint(x: frame.midX, y: frame.midY)
      return TextEntryTarget(
        element: nextElement,
        refreshPoint: point,
        prefersFocusedElement: prefersFocusedElement,
        fromTapWitness: fromTapWitness,
        boundIdentity: boundIdentity ?? snapshot.map {
          TextEntryInputIdentity(elementType: $0.elementType, identifier: $0.identifier)
        }
      )
    }
  }

  /// What one snapshot of a candidate element proved.
  enum TextEntryInputProbe: Equatable {
    case input(TextEntryInputIdentity)
    /// XCTest found no element for the query: the only error that proves absence.
    case noMatch
    /// Any other snapshot failure, such as a transient accessibility error or multiple matches.
    case unavailable
  }

  static let xCTestUITestingErrorDomain = "com.apple.dt.xctest.ui-testing.error"
  /// `snapshot()` of a query that matches nothing, as for an input the app removed. A query with
  /// several matches throws 10006 and one into an app that is not running throws 10001.
  static let xCTestNoMatchesErrorCode = 10008

  /// Classifies a candidate's `snapshot()` error: only XCTest's no-match proves the input is gone.
  static func textEntryInputProbe(snapshotError error: Error) -> TextEntryInputProbe {
    let error = error as NSError
    return error.domain == xCTestUITestingErrorDomain && error.code == xCTestNoMatchesErrorCode
      ? .noMatch
      : .unavailable
  }

  /// Repair clears and retypes whatever input resolves, so it needs an identity that a
  /// successor input cannot share. An unbound target keeps its unguarded repair.
  static func textEntryRepairCanTarget(boundIdentity: TextEntryInputIdentity?) -> Bool {
    boundIdentity?.isDistinguishable ?? true
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

  /// Resolves the target's input. A bound target accepts only an element whose snapshot carries
  /// its bound identity, so every post, read-back, verification poll, and repair refuses an input
  /// that took the bound one's place.
  func resolveTextEntryElement(app: XCUIApplication, target: TextEntryTarget) -> XCUIElement? {
    guard let boundIdentity = target.boundIdentity else {
      return resolveUnboundTextEntryElement(app: app, target: target)
    }
    func isBoundInput(_ candidate: XCUIElement) -> Bool {
      candidate.exists && probeTextEntryInput(candidate) == .input(boundIdentity)
    }
    if target.prefersFocusedElement, let focused = focusedTextInput(app: app), isBoundInput(focused) {
      return focused
    }
    if let element = target.element, isBoundInput(element) {
      return element
    }
    if let refreshPoint = target.refreshPoint,
       case .matches(let candidates) = probeTextInputs(app: app, point: refreshPoint),
       let match = candidates.first(where: isBoundInput) {
      return match
    }
    if let focused = focusedTextInput(app: app), isBoundInput(focused) {
      return focused
    }
    if let byIdentifier = boundTextEntryInputQuery(app: app, identity: boundIdentity), isBoundInput(byIdentifier) {
      return byIdentifier
    }
    return nil
  }

  /// Whether a bound target's input is proven gone: XCTest found no match for it, or a different
  /// input answers in its place, and nothing at its point carries its identity. A failed probe
  /// proves nothing. Unbound targets and unidentified inputs without an element cannot be proven
  /// gone.
  func boundTextEntryInputIsGone(app: XCUIApplication, target: TextEntryTarget) -> Bool {
    guard let boundIdentity = target.boundIdentity,
          let query = boundTextEntryInputQuery(app: app, identity: boundIdentity) ?? target.element
    else {
      return false
    }
    switch probeTextEntryInput(query) {
    case .input(let identity) where identity != boundIdentity:
      break
    case .noMatch:
      break
    case .input, .unavailable:
      return false
    }
    guard let refreshPoint = target.refreshPoint else {
      return true
    }
    switch probeTextInputs(app: app, point: refreshPoint) {
    case .absent:
      return true
    case .matches(let candidates):
      return candidates.allSatisfy { probeTextEntryInput($0) != .input(boundIdentity) }
    case .unavailable:
      return false
    }
  }

  /// The app-wide query for an input whose identifier is unique enough to search by.
  private func boundTextEntryInputQuery(app: XCUIApplication, identity: TextEntryInputIdentity) -> XCUIElement? {
    guard identity.isDistinguishable else {
      return nil
    }
    return app.descendants(matching: identity.elementType).matching(identifier: identity.identifier).element
  }

  /// Snapshots one candidate: its identity, a proven no-match, or a failure that proves nothing.
  private func probeTextEntryInput(_ element: XCUIElement) -> TextEntryInputProbe {
    var probe = TextEntryInputProbe.unavailable
    let (_, exception) = catchingObjCException(fallback: ()) {
      do {
        let snapshot = try element.snapshot()
        probe = .input(TextEntryInputIdentity(elementType: snapshot.elementType, identifier: snapshot.identifier))
      } catch {
        probe = Self.textEntryInputProbe(snapshotError: error)
      }
    }
    return exception == nil ? probe : .unavailable
  }

  /// Resolution for a target not bound to an input yet: the first element that exists.
  private func resolveUnboundTextEntryElement(app: XCUIApplication, target: TextEntryTarget) -> XCUIElement? {
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
    for element: (any XCUIElementAttributes)?,
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

  private func isPlaceholderValue(_ value: String, for element: any XCUIElementAttributes) -> Bool {
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
