import XCTest

// Text entry & keyboard-readiness for the runner: the focus -> type -> verify -> repair
// pipeline, readiness polling, and field clearing. Behavior-preserving extraction from
// RunnerTests+Interaction.swift (no logic changes) to keep that file navigable.
extension RunnerTests {
  enum TextEntryFailure: String {
    case notFocused = "TEXT_INPUT_NOT_FOCUSED"
    case synthesisUnavailable = "TEXT_INPUT_SYNTHESIS_UNAVAILABLE"
    case commitNotObserved = "TEXT_INPUT_COMMIT_NOT_OBSERVED"
    case clearNotObserved = "TEXT_INPUT_CLEAR_NOT_OBSERVED"
    case synthesisBudgetExceeded = "TEXT_INPUT_SYNTHESIS_BUDGET_EXCEEDED"

    var message: String {
      switch self {
      case .notFocused:
        return "No focused text input was available for typing."
      case .synthesisUnavailable:
        return "Reliable text synthesis is unavailable while the software keyboard is hidden."
      case .commitNotObserved:
        return "The runner could not confirm the typed text reached the field."
      case .clearNotObserved:
        return "The runner could not clear the field before typing, so it typed nothing."
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
      case .clearNotObserved:
        return "The field may still hold some or all of its old text. Run snapshot -i and inspect the field, then retry fill. Do not use type, which appends to whatever the field holds."
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
    /// Initial replacement observation budget; a late first read gets one stability window.
    static let replacementSettleCeiling: TimeInterval = 1.0
    /// How long the commit wait tolerates seeing NO further progress toward the expected value.
    /// Numerically the flat deadline this replaced, so a pipeline that delivers nothing is
    /// condemned at exactly the same instant it always was (see `SynthesizedCommitDeadline`).
    static let synthesizedCommitStallTimeout: TimeInterval = 3.0
    /// The commit wait's absolute bound, however long characters keep arriving. Synthesized
    /// delivery happens before this wait starts and is bounded by `synthesizedDeliveryCeiling`.
    static let synthesizedCommitCeiling: TimeInterval = 10.0
    /// What a synthesized replacement spends before its first character: focusing the field took
    /// 374–500 ms through the daemon on an iPhone 17 Pro simulator, and finding the input under the
    /// point before that tap took up to 2.0 s more on a React Native bottom sheet (iPhone 17 Pro
    /// Max, iOS 26.5).
    static let synthesizedReplacementFocusAllowance: TimeInterval = 4.0
    /// What one read of the field between a replacement's clear passes is charged. On a penalized
    /// channel, a clear pass on a React Native bottom-sheet field took 1.18–1.26 s over 22 passes
    /// (iPhone 17 Pro Max, iOS 26.5); less the pass's charged synthesize calls and delete key, the
    /// read took 0.80–0.88 s. A login field read in 0.26–0.40 s.
    static let synthesizedClearReadAllowance: TimeInterval = 0.9
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

  /// A text input found under a point, and the identity it carried when found. The element is an
  /// index-bound query handle: an input inserted or reordered ahead of it later re-binds the handle
  /// to that input, and the identity is what notices.
  struct TextInputAtPoint {
    let element: XCUIElement
    let identity: TextEntryInputIdentity
  }

  struct TextEntryTarget {
    let element: XCUIElement?
    let refreshPoint: CGPoint?
    let prefersFocusedElement: Bool
    let fromTapWitness: Bool
    /// The input the first resolved element was. Once bound, resolution refuses any other input.
    let boundIdentity: TextEntryInputIdentity?
    /// The text input that sat under `refreshPoint` before the focus tap, which binds the target to
    /// its identity. Focusing a field can move the layout (keyboard avoidance, a bottom sheet
    /// extending above the keyboard), after which the point hits a different field or none, so once
    /// this is set the point no longer names the field. It identifies the field for reads and
    /// clears, never for routing.
    let inputAtRefreshPoint: TextInputAtPoint?
    /// `element` as the focus step read it after its last dispatch: a `TextEntryReader` hands it
    /// out as its first read. A target moved to another read has none.
    let postFocusRead: ResolvedTextEntryInput?

    init(
      element: XCUIElement?,
      refreshPoint: CGPoint?,
      prefersFocusedElement: Bool,
      fromTapWitness: Bool = false,
      boundIdentity: TextEntryInputIdentity? = nil,
      inputAtRefreshPoint: TextInputAtPoint? = nil,
      postFocusRead: ResolvedTextEntryInput? = nil
    ) {
      self.element = element
      self.refreshPoint = refreshPoint
      self.prefersFocusedElement = prefersFocusedElement
      self.fromTapWitness = fromTapWitness
      self.boundIdentity = boundIdentity ?? inputAtRefreshPoint?.identity
      self.inputAtRefreshPoint = inputAtRefreshPoint
      self.postFocusRead = postFocusRead
    }

    /// The target moved to the input a resolution read: its element, a refresh point at its center,
    /// and its identity while the target is unbound.
    func withResolvedInput(_ input: ResolvedTextEntryInput?) -> TextEntryTarget {
      guard let input else {
        return self
      }
      let frame = input.snapshot?.frame ?? .zero
      return TextEntryTarget(
        element: input.element,
        refreshPoint: frame.isEmpty ? refreshPoint : CGPoint(x: frame.midX, y: frame.midY),
        prefersFocusedElement: prefersFocusedElement,
        fromTapWitness: fromTapWitness,
        boundIdentity: boundIdentity ?? input.identity,
        inputAtRefreshPoint: inputAtRefreshPoint
      )
    }
  }

  /// A text input element read through one snapshot. Later reads take the input's attributes from
  /// the snapshot: each attribute read from the live element runs its query again, and each query
  /// snapshots the whole application, about 90 ms on Bluesky's React Native Search screen (iPhone 17
  /// Pro, iOS 27.0). Where a live read of an element that stopped answering its query, such as a
  /// removed input or a focused Flutter password field (#3060), records an XCTest failure that ends
  /// the runner session, the snapshot only throws.
  struct ResolvedTextEntryInput {
    let element: XCUIElement
    /// Nil when the element exists but could not be snapshotted.
    let snapshot: XCUIElementSnapshot?

    private init(element: XCUIElement, snapshot: XCUIElementSnapshot?) {
      self.element = element
      self.snapshot = snapshot
    }

    /// Reads a handle that may name an input the app has removed; nil when it names none or the read
    /// raised. The snapshot of a missing element throws only after XCTest waits about two seconds for
    /// a match, so existence is read first.
    init?(reading element: XCUIElement) {
      var exists = false
      var snapshot: XCUIElementSnapshot?
      if let exception = RunnerObjCExceptionCatcher.catchException({
        exists = element.exists
        snapshot = exists ? try? element.snapshot() : nil
      }) {
        NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_READ_IGNORED_EXCEPTION=%@", exception)
        return nil
      }
      guard exists else { return nil }
      self.init(element: element, snapshot: snapshot)
    }

    /// Reads a handle its query has just listed, inside the caller's exception containment, so the
    /// snapshot is read first and existence only when the snapshot fails; nil when it names no element.
    init?(readingListed element: XCUIElement) {
      let snapshot = try? element.snapshot()
      guard snapshot != nil || element.exists else { return nil }
      self.init(element: element, snapshot: snapshot)
    }

    var identity: TextEntryInputIdentity? {
      snapshot.map { TextEntryInputIdentity(elementType: $0.elementType, identifier: $0.identifier) }
    }

    var attributes: any XCUIElementAttributes {
      if let snapshot {
        return snapshot
      }
      return element
    }
  }

  /// A text entry target and its input as last read. `input()` hands the last read out again until
  /// `dispatch` runs, and resolves the target again after that, so a bound target refuses an input
  /// that took its place. Each resolution moves the target to the input it read. Every post and every
  /// pause between reads goes through `dispatch`; the pause a typing plan takes itself follows a post.
  struct TextEntryReader {
    private(set) var target: TextEntryTarget
    private var lastRead: ResolvedTextEntryInput?
    private let resolve: (TextEntryTarget) -> ResolvedTextEntryInput?

    init(target: TextEntryTarget, resolve: @escaping (TextEntryTarget) -> ResolvedTextEntryInput?) {
      self.target = target.withResolvedInput(target.postFocusRead)
      lastRead = target.postFocusRead
      self.resolve = resolve
    }

    mutating func input() -> ResolvedTextEntryInput? {
      if let lastRead {
        return lastRead
      }
      let read = resolve(target)
      target = target.withResolvedInput(read)
      lastRead = read
      return read
    }

    /// Runs `dispatch`, which posts to the app or pauses, so the next `input()` resolves again.
    mutating func dispatch<T>(_ dispatch: () -> T) -> T {
      lastRead = nil
      return dispatch()
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

  /// What confirmed that a focus tap's input took focus.
  enum TextEntryFocusEvidence {
    /// tvOS moves focus with the focus engine, so there is nothing to wait for.
    case focusEngine
    /// The app-wide focus query named a text input (not iOS).
    case focusedInput
    /// The tapped input's own read reports keyboard focus. That read is the focus step's post-focus
    /// read.
    case inputReportsKeyboardFocus(ResolvedTextEntryInput)
    /// A software keyboard appeared after the tap, so some input took focus.
    case keyboardAppeared
    /// The app-wide keyboard-focus query answered with the tapped input.
    case focusQueryMatchesInput

    /// The name `runner.log` records.
    var name: String {
      switch self {
      case .focusEngine: return "focus-engine"
      case .focusedInput: return "focused-input"
      case .inputReportsKeyboardFocus: return "input-reports-keyboard-focus"
      case .keyboardAppeared: return "keyboard-appeared"
      case .focusQueryMatchesInput: return "focus-query-matches-input"
      }
    }
  }

  struct TextEntryStabilization {
    let element: XCUIElement?
    /// Nil when nothing confirmed focus before the focus timeout.
    let evidence: TextEntryFocusEvidence?

    var focusConfirmed: Bool { evidence != nil }
  }

  struct TextEntryTapWitness {
    let element: XCUIElement
    let bundleId: String?
    let processIdentifier: Int?

    func matches(bundleId: String?, processIdentifier: Int?) -> Bool {
      self.bundleId == bundleId && self.processIdentifier == processIdentifier
    }
  }

  /// Clears `input`, which must have been read with nothing dispatched since.
  func clearTextInput(app: XCUIApplication, _ input: ResolvedTextEntryInput) {
    // Skip the clear (delete burst + moveCaretToEnd edge-tap) ONLY when we can confirm the
    // field is empty. Why skip: the edge-tap computes a point from the element frame, which can
    // be stale after the field repositions on focus (e.g. the Settings search bar jumps
    // bottom->top and reveals a "Suggestions" list) — tapping there navigates away instead of
    // clearing; and replacing into an already-empty field is a no-op anyway.
    // editableTextValue returns nil for secure (and unknown) fields, where we CANNOT confirm
    // emptiness — those must still be cleared, or replace would concatenate stale + new text.
    // So distinguish nil (clear) from "" (skip).
    if let existing = editableTextValue(for: input.attributes, treatingPlaceholderAsEmpty: true),
       existing.isEmpty {
      return
    }
    // Read before the caret tap, which dispatches to the app.
    let count = estimatedDeleteCount(for: input.attributes)
#if !os(tvOS)
    moveCaretToEnd(app: app, input: input)
#endif
    let deletes = String(repeating: XCUIKeyboardKey.delete.rawValue, count: count)
    input.element.typeText(deletes)
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

  /// Resolves the target's input, with the snapshot the resolution read it through. A bound target
  /// accepts only an input whose snapshot carries its bound identity, so every post, read-back,
  /// verification poll, and repair refuses an input that took the bound one's place.
  func resolveTextEntryInput(app: XCUIApplication, target: TextEntryTarget) -> ResolvedTextEntryInput? {
    guard let boundIdentity = target.boundIdentity else {
      return resolveUnboundTextEntryInput(app: app, target: target)
    }
    func boundInput(_ candidate: XCUIElement) -> ResolvedTextEntryInput? {
      guard let input = ResolvedTextEntryInput(reading: candidate), input.identity == boundIdentity else { return nil }
      return input
    }
    if target.prefersFocusedElement, let focused = focusedTextInput(app: app), let input = boundInput(focused) {
      return input
    }
    if let element = target.element, let input = boundInput(element) {
      return input
    }
    if let input = target.inputAtRefreshPoint, let read = textInputIfStillResolves(input) {
      return read
    }
    if target.inputAtRefreshPoint == nil,
       let refreshPoint = target.refreshPoint,
       case .matches(let candidates) = probeTextInputs(app: app, point: refreshPoint),
       let match = candidates.first(where: { $0.identity == boundIdentity }) {
      return match
    }
    if let focused = focusedTextInput(app: app), let input = boundInput(focused) {
      return input
    }
    if let byIdentifier = boundTextEntryInputQuery(app: app, identity: boundIdentity),
       let input = boundInput(byIdentifier) {
      return input
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
      return candidates.allSatisfy { $0.identity != boundIdentity }
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
  func probeTextEntryInput(_ element: XCUIElement) -> TextEntryInputProbe {
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
  private func resolveUnboundTextEntryInput(app: XCUIApplication, target: TextEntryTarget) -> ResolvedTextEntryInput? {
    if target.prefersFocusedElement, let focused = focusedTextInput(app: app).flatMap(ResolvedTextEntryInput.init(reading:)) {
      return focused
    }
    if let element = target.element, let input = ResolvedTextEntryInput(reading: element) {
      return input
    }
    if let refreshPoint = target.refreshPoint,
       let refreshed = textInputAt(app: app, x: refreshPoint.x, y: refreshPoint.y) {
      return refreshed
    }
    return focusedTextInput(app: app).flatMap(ResolvedTextEntryInput.init(reading:))
  }

  private func moveCaretToEnd(app: XCUIApplication, input: ResolvedTextEntryInput) {
#if os(tvOS)
    return
#else
    // Both the point AND its dispatch must stay off the handle: this runs AFTER the command's own
    // focus tap, and an input that stopped answering its resolving query on focus (#3060) makes
    // every post-focus handle touch a recorder — `element.frame` records directly, and an
    // element-anchored `coordinate(...).tap()` re-runs that same query to resolve its anchor when
    // the action executes. The input's snapshot, read with nothing dispatched since, proves the handle
    // answered moments earlier, not that it still answers at tap-dispatch time. So the point comes
    // from the snapshot frame and
    // goes out app-relative through `tapAt`, which resolves no element at all — the shape
    // `waitForTextEntryReadinessAfterTap` settled on in #3237. With no trustworthy frame, or a
    // zero-size one (how a departed handle reads), there is no point to dispatch — an edge-tap
    // from a frame the field moved after records a failure or navigates away, the shape
    // `clearTextInput`'s comment refuses — so degrade to the caller's point-free delete burst.
    guard let frame = input.snapshot?.frame, !frame.isEmpty else {
      return
    }
    _ = tapAt(
      app: app,
      x: frame.minX + max(2, frame.width - 4),
      y: frame.minY + max(2, frame.height / 2)
    )
#endif
  }

  private func estimatedDeleteCount(for element: any XCUIElementAttributes) -> Int {
    let valueText = normalizedElementText(element.value)
    let base = valueText.isEmpty ? 24 : (valueText.count + 8)
    return max(24, min(120, base))
  }

  private func normalizedElementText(_ value: Any?) -> String {
    String(describing: value ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// What a text entry element's value says about its text.
  enum TextValueRead: Equatable {
    case text(String)
    /// The value carries no information about the text: a secure field, or a masked value.
    case unreadable
    /// The read could not answer, or no input resolves.
    case unavailable

    func warmupReadIsPending(expectedText: String) -> Bool {
      switch self {
      case .text(let value): return value != expectedText
      case .unreadable: return false
      case .unavailable: return true
      }
    }
  }

  /// What a text entry element's accessibility value says about its text. The one owner of the
  /// "value unreadable" rule: a `.secureTextField`, or a plain field whose value is a password
  /// mask, as a React Native `secureTextEntry` input reports (tester-army/e2e#872). Every route
  /// that decides readability reads through here, so none can disagree with another.
  func textValueRead(
    for element: (any XCUIElementAttributes)?,
    treatingPlaceholderAsEmpty: Bool = false
  ) -> TextValueRead {
    guard let element else {
      return .unavailable
    }
    let elementType = element.elementType
    switch elementType {
    case .textField, .searchField, .textView:
      let value = String(describing: element.value ?? "")
      if treatingPlaceholderAsEmpty && isPlaceholderValue(value, for: element) {
        return .text("")
      }
      return Self.textValueRead(elementType: elementType, value: value)
    default:
      return Self.textValueRead(elementType: elementType, value: "")
    }
  }

  /// `textValueRead(for:)` with the element's type and value already read, so the rule is
  /// exercisable without an element.
  static func textValueRead(elementType: XCUIElement.ElementType, value: String) -> TextValueRead {
    switch elementType {
    case .secureTextField:
      return .unreadable
    case .textField, .searchField, .textView:
      return isMaskedTextValue(value) ? .unreadable : .text(value)
    default:
      return .unavailable
    }
  }

  /// The element's text when it can be read, nil when it is unreadable or unavailable. Callers
  /// that need the two told apart read `textValueRead(for:)` instead.
  func editableTextValue(
    for element: (any XCUIElementAttributes)?,
    treatingPlaceholderAsEmpty: Bool = false
  ) -> String? {
    guard case .text(let value) = textValueRead(
      for: element,
      treatingPlaceholderAsEmpty: treatingPlaceholderAsEmpty
    ) else {
      return nil
    }
    return value
  }

  /// Whether an accessibility value is a masked rendering of a secure field: one or more
  /// password bullets and nothing else. The bullet count need not match the typed length, so
  /// such a value carries no information about what the field holds. A field whose real text is
  /// only bullets is unreadable too, so a failed fill into it reports unverified, not a mismatch.
  static func isMaskedTextValue(_ value: String) -> Bool {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return false
    }
    return trimmed.allSatisfy { Self.passwordMaskCharacters.contains($0) }
  }

  /// U+2022 is what UIKit renders for a secure field; U+25CF is the other bullet some custom
  /// inputs substitute for it.
  private static let passwordMaskCharacters: Set<Character> = ["\u{2022}", "\u{25CF}"]

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
