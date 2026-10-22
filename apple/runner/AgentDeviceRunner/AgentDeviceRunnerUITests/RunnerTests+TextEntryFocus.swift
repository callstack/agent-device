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
    return TextEntryStabilization(element: target, focusConfirmed: true)
#else
    let keyboardVisibleAtEntry = keyboardVisibleBeforeTap ?? isKeyboardVisible(app: app)
    let deadline = Date().addingTimeInterval(TextEntryTiming.focusTimeout)
    while Date() < deadline {
      if let focused = focusedTextInput(app: app) {
        return TextEntryStabilization(element: focused, focusConfirmed: true)
      }
      // focusedTextInput is intentionally nil on iOS; treat the keyboard transitioning to
      // visible after our tap as the focus-moved signal. Don't fast-path when it was already up.
      if keyboardBecameVisible(app: app, wasVisibleAtEntry: keyboardVisibleAtEntry) {
        return TextEntryStabilization(element: target, focusConfirmed: true)
      }
#if os(iOS)
      if let target, keyboardFocusConfirmed(app: app, element: target) {
        return TextEntryStabilization(element: target, focusConfirmed: true)
      }
#endif
      sleepFor(TextEntryTiming.pollInterval)
    }
    return TextEntryStabilization(element: target, focusConfirmed: false)
#endif
  }

  @MainActor
  func focusTextInputForTextEntry(app: XCUIApplication, x: Double?, y: Double?) -> TextEntryTarget {
    guard let x, let y else {
      let softwareKeyboardVisible = isKeyboardVisible(app: app)
      if !softwareKeyboardVisible, let rememberedTarget = rememberedTextEntryTarget() {
        return rememberedTarget
      }
      // Bare `type` targets the current first responder. On iOS we intentionally do not trust
      // `hasKeyboardFocus`, but an already-visible software keyboard is sufficient evidence that
      // app.typeText has a receiver; waiting the full readiness timeout cannot prove a stronger
      // target because there is no selector/coordinate focus move to validate.
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
    let input = textInputAt(app: app, x: x, y: y)
    let target = input?.element
    let requestedPoint = CGPoint(x: x, y: y)
    if let frame = input?.attributes.frame, !frame.isEmpty {
      _ = tapAt(app: app, x: frame.midX, y: frame.midY)
    } else {
      _ = tapAt(app: app, x: x, y: y)
    }
    // A visible keyboard is not enough evidence for app.typeText, because focus may still
    // belong to a previous field. With a concrete target we type through XCUIElement.typeText,
    // so after tapping it the iOS readiness timeout cannot prove anything stronger.
    if keyboardVisibleBeforeTap, let target {
      return focusedTextEntryTarget(target, requestedPoint: requestedPoint)
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
    let element = stabilized.focusConfirmed
      ? readyTarget.element
      : (waitForTextEntryReadiness(app: app, target: readyTarget) ?? readyTarget.element)
    return focusedTextEntryTarget(element, requestedPoint: requestedPoint)
  }

  /// The target the focus step hands to text entry, with the read its refresh point came from.
  private func focusedTextEntryTarget(_ element: XCUIElement?, requestedPoint: CGPoint) -> TextEntryTarget {
    guard let element else {
      return TextEntryTarget(element: nil, refreshPoint: requestedPoint, prefersFocusedElement: false)
    }
    let read = ResolvedTextEntryInput(reading: element)
    return TextEntryTarget(
      element: element,
      refreshPoint: textEntryRefreshPoint(frame: read?.snapshot?.frame, fallbackTo: requestedPoint),
      prefersFocusedElement: false,
      postFocusRead: read?.snapshot == nil ? nil : read
    )
  }

  /// The field's current center for a refresh point that survives a focus move, or `requestedPoint`
  /// when the field reads with an empty frame. Read through a snapshot, not
  /// `element.frame`: this runs after the focus tap, and a field that stopped answering its
  /// resolving query on focus (#3060) turns that read into a recorded failure which ends the runner
  /// session for a focus the dispatch had already landed. When the read could not answer at all,
  /// the target gets NO refresh point rather than the pre-focus one: this route's first resolve is
  /// not yet bound to an identity, and a field that went unqueryable on focus may have moved the
  /// layout so the old point names a different input, so fail closed with a typed reason instead of
  /// typing into that other field.
  private func textEntryRefreshPoint(
    frame: CGRect?,
    fallbackTo requestedPoint: CGPoint
  ) -> CGPoint? {
    guard let frame else {
      return nil
    }
    guard !frame.isEmpty else {
      return requestedPoint
    }
    return CGPoint(x: frame.midX, y: frame.midY)
  }
}
