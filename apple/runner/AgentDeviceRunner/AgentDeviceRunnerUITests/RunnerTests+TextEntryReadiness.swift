import XCTest

// Text-entry readiness: which element is about to receive text, and whether it has actually taken
// focus. Split from RunnerTests+TextEntry.swift, which keeps the vocabulary (failures, timings,
// targets), field clearing and value reading; everything that decides "ready" lives here.
extension RunnerTests {
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

  func rememberTextEntryTap(_ element: XCUIElement?) {
    guard let element, isTextEntryElement(element) else {
      clearRememberedTextEntryTap()
      return
    }
    textEntryTapWitness = TextEntryTapWitness(
      element: element,
      bundleId: currentBundleId,
      processIdentifier: currentAppProcessIdentifier
    )
  }

  func clearRememberedTextEntryTap() {
    textEntryTapWitness = nil
  }

  private func rememberedTextEntryTarget() -> TextEntryTarget? {
    guard let witness = textEntryTapWitness else {
      return nil
    }
    // The tap is proof for one immediately-following bare type only. Consume it before checking
    // the element so a failed or interrupted type cannot reuse stale focus evidence.
    clearRememberedTextEntryTap()
    guard witness.matches(
      bundleId: currentBundleId,
      processIdentifier: currentAppProcessIdentifier
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

  private func waitForTextEntryReadiness(
    app: XCUIApplication,
    target: TextEntryTarget,
    timeout: TimeInterval = TextEntryTiming.readinessTimeout
  ) -> XCUIElement? {
#if os(iOS)
    var latest = resolveTextEntryElement(app: app, target: target)
    let keyboardVisibleAtEntry = isKeyboardVisible(app: app)
    let deadline = Date().addingTimeInterval(timeout)
    var hardwareKeyboardFallback = Date().addingTimeInterval(
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
      // A responder that takes no software keyboard (hardware keyboard connected, or a custom
      // `inputView`) would otherwise burn the whole readinessTimeout waiting for one that is never
      // coming. Leaving that window a bare wall-clock guess made readiness a function of ambient
      // simulator state (#1874): on a loaded host the keyboard is merely late, and returning here
      // handed the caller an element that had not taken focus yet. Ask the target itself instead,
      // and re-arm rather than re-asking every poll — the query is cheap, not free.
      if !sawSoftwareKeyboard, Date() >= hardwareKeyboardFallback, let candidate = latest {
        if keyboardFocusConfirmed(app: app, element: candidate) {
          return candidate
        }
        hardwareKeyboardFallback = Date().addingTimeInterval(
          TextEntryTiming.hardwareKeyboardFallbackTimeout
        )
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

  /// Positive evidence that this element — the one readiness is about to hand its caller — holds
  /// keyboard focus. Readable even with no software keyboard on screen, which is what lets the
  /// hardware-keyboard fallback stop guessing from a wall clock.
  ///
  /// This is the same app-wide predicate `focusedTextInput` refuses to trust on iOS, used the
  /// other way round. There, the query PICKS the target, so a stale or unrelated match becomes
  /// the field that gets typed into. Here the target is already chosen and the query only
  /// corroborates it: at most one element holds keyboard focus, so an answer that is not this
  /// element is a refusal, not a substitution. Every way of being wrong therefore ends as `false`
  /// and costs the remaining readiness timeout — exactly what the wait would spend with no
  /// fallback at all.
  func keyboardFocusConfirmed(app: XCUIApplication, element: XCUIElement) -> Bool {
#if os(iOS)
    return safely("TEXT_ENTRY_FOCUS_CONFIRMED", false) {
      // An element that no longer resolves reads as identifier "" and frame `.zero`, which would
      // match any focused element that also reports an empty frame. Require a real frame first,
      // so a dead handle cannot corroborate anything.
      let frame = element.frame
      guard !frame.isEmpty else {
        return false
      }
      let focused = app
        .descendants(matching: .any)
        .matching(NSPredicate(format: "hasKeyboardFocus == 1"))
        .firstMatch
      guard focused.exists else {
        return false
      }
      return focused.identifier == element.identifier && focused.frame == frame
    }
#else
    return false
#endif
  }

  private func keyboardElementExists(app: XCUIApplication) -> Bool {
#if os(iOS)
    return safely("KEYBOARD_EXISTS", false) { app.keyboards.firstMatch.exists }
#else
    return false
#endif
  }
}
