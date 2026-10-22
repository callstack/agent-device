import XCTest

extension RunnerTests {
  /// Books the tap as the address for the next bare `type`. `element` is a text input the caller
  /// classified BEFORE dispatching, or nil when the tap hit nothing worth typing into; that is the whole
  /// contract, and this function must not re-check it. A tap holds a handle bound to the query that
  /// resolved the element, so asking the handle re-runs that query, and an element that stopped answering
  /// it — a Flutter password field once focus makes its accessibility attributes disagree — makes XCTest
  /// record a failure. That failure ends the runner session for a tap the dispatch had already landed
  /// (#3060), and ADR 0005 already keeps a tap's outcome independent of this bookkeeping.
  @MainActor
  func rememberTextEntryTap(_ element: XCUIElement?) {
    guard let element else {
      clearRememberedTextEntryTap()
      return
    }
    textEntryTapWitness = TextEntryTapWitness(
      element: element,
      bundleId: mainOwned.bundleId,
      processIdentifier: mainOwned.processIdentifier
    )
  }

  func clearRememberedTextEntryTap() {
    textEntryTapWitness = nil
  }

  @MainActor
  private func rememberedTextEntryTarget() -> TextEntryTarget? {
    guard let witness = textEntryTapWitness else {
      return nil
    }
    // The tap is proof for one immediately-following bare type only. Consume it before checking
    // the element so a failed or interrupted type cannot reuse stale focus evidence.
    clearRememberedTextEntryTap()
    guard witness.matches(
      bundleId: mainOwned.bundleId,
      processIdentifier: mainOwned.processIdentifier
    ) else {
      return nil
    }
    let element = witness.element
    // XCUIElement is query-backed rather than a stable node identity. A same-identifier field
    // introduced by app-side navigation between tap and this immediate type can therefore
    // re-resolve here; keep the witness one-shot and fail closed on every observable identity
    // boundary instead of using frame equality, which would reject legitimate layout changes.
    guard safely("LAST_TAPPED_TEXT_INPUT_EXISTS", false, { element.exists }) else {
      return nil
    }
    // Keep the target scoped to the element that the preceding tap actually selected. Do not
    // attach a refresh point: if that element disappeared, bare type must fail closed rather
    // than rediscovering a different field or dispatching unscoped app.typeText.
    return TextEntryTarget(
      element: element,
      refreshPoint: nil,
      prefersFocusedElement: false,
      fromTapWitness: true
    )
  }

  func stabilizeTextInputBeforeTyping(
    app: XCUIApplication,
    target: XCUIElement?,
    keyboardVisibleBeforeTap: Bool? = nil
  ) -> TextEntryStabilization {
#if os(tvOS)
    return TextEntryStabilization(element: target, evidence: .focusEngine)
#else
    let keyboardVisibleAtEntry = keyboardVisibleBeforeTap ?? isKeyboardVisible(app: app)
    let deadline = Date().addingTimeInterval(TextEntryTiming.focusTimeout)
    while Date() < deadline {
      if let focused = focusedTextInput(app: app) {
        return TextEntryStabilization(element: focused, evidence: .focusedInput)
      }
#if os(iOS)
      // The tapped input's own read comes before the keyboard. While a software keyboard is
      // presented, the keyboard query blocks and then finds none: after a fill's focus tap it took
      // 0.68 s on an iPhone 17 Pro simulator (iOS 27.0) and 0.57–3.77 s on CI. An input that
      // reports keyboard focus is stronger evidence than the keyboard's arrival, which shows only
      // that some input took focus.
      if let target, let frame = keyboardFocusedInputFrame(target) {
        return TextEntryStabilization(element: target, evidence: .inputReportsKeyboardFocus, inputFrame: frame)
      }
#endif
      // focusedTextInput is intentionally nil on iOS; the keyboard transitioning to visible after
      // our tap is also a focus-moved signal. Don't fast-path when it was already up.
      if keyboardBecameVisible(app: app, wasVisibleAtEntry: keyboardVisibleAtEntry) {
        return TextEntryStabilization(element: target, evidence: .keyboardAppeared)
      }
#if os(iOS)
      if let target, keyboardFocusConfirmed(app: app, element: target) {
        return TextEntryStabilization(element: target, evidence: .focusQueryMatchesInput)
      }
#endif
      sleepFor(TextEntryTiming.pollInterval)
    }
    return TextEntryStabilization(element: target, evidence: nil)
#endif
  }

  @MainActor
  func focusTextInputForTextEntry(app: XCUIApplication, x: Double?, y: Double?) -> TextEntryTarget {
    guard let x, let y else {
      let softwareKeyboardVisible = isKeyboardVisible(app: app)
      if !softwareKeyboardVisible, let rememberedTarget = rememberedTextEntryTarget() {
        return rememberedTarget
      }
      // Bare `type` targets the current first responder. On iOS we intentionally do not let the
      // app-wide `hasKeyboardFocus` query pick it, but an already-visible software keyboard is
      // sufficient evidence that app.typeText has a receiver; waiting the full readiness timeout
      // cannot prove a stronger target because there is no selector/coordinate focus move to validate.
      if softwareKeyboardVisible {
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
        refreshPoint: textEntryRefreshPoint(for: target, fallbackTo: requestedPoint),
        prefersFocusedElement: false
      )
    }
    let stabilized = stabilizeTextInputBeforeTyping(
      app: app,
      target: target,
      keyboardVisibleBeforeTap: keyboardVisibleBeforeTap
    )
    NSLog("AGENT_DEVICE_RUNNER_TEXT_ENTRY_FOCUS evidence=%@", stabilized.evidence?.rawValue ?? "none")
    if let frame = stabilized.inputFrame {
      // The read that confirmed focus came after the tap, so its frame serves the refresh point.
      return TextEntryTarget(
        element: stabilized.element,
        refreshPoint: textEntryRefreshPoint(frame: frame, fallbackTo: requestedPoint),
        prefersFocusedElement: false
      )
    }
    let readyTarget = TextEntryTarget(
      element: stabilized.element ?? target,
      refreshPoint: requestedPoint,
      prefersFocusedElement: false
    )
    let element = stabilized.focusConfirmed
      ? readyTarget.element
      : (waitForTextEntryReadiness(app: app, target: readyTarget) ?? readyTarget.element)
    return TextEntryTarget(
      element: element,
      refreshPoint: textEntryRefreshPoint(for: element, fallbackTo: requestedPoint),
      prefersFocusedElement: false
    )
  }

  /// The field's current center for a refresh point that survives a focus move, or `requestedPoint`
  /// when the field reads with an empty frame. Read through `textEntrySnapshotFrame`, not
  /// `element.frame`: this runs after the focus tap, and a field that stopped answering its
  /// resolving query on focus (#3060) turns that read into a recorded failure which ends the runner
  /// session for a focus the dispatch had already landed. When the read could not answer at all,
  /// the target gets NO refresh point rather than the pre-focus one: this route's first resolve is
  /// not yet bound to an identity, and a field that went unqueryable on focus may have moved the
  /// layout so the old point names a different input, so fail closed with a typed reason instead of
  /// typing into that other field.
  private func textEntryRefreshPoint(
    for element: XCUIElement?,
    fallbackTo requestedPoint: CGPoint?
  ) -> CGPoint? {
    guard let element else {
      return requestedPoint
    }
    return textEntryRefreshPoint(frame: textEntrySnapshotFrame(element), fallbackTo: requestedPoint)
  }

  /// `textEntryRefreshPoint(for:)` from a frame already read after the focus tap.
  private func textEntryRefreshPoint(frame: CGRect?, fallbackTo requestedPoint: CGPoint?) -> CGPoint? {
    guard let frame else {
      return nil
    }
    guard !frame.isEmpty else {
      return requestedPoint
    }
    return CGPoint(x: frame.midX, y: frame.midY)
  }
}
