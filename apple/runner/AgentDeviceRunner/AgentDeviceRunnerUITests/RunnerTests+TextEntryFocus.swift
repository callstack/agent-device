import XCTest

// Text-entry target acquisition: choosing the element a `type`/`fill` will address and getting
// focus onto it — the one-shot tap witness, the post-tap stabilization, and the two
// `focusTextInputForTextEntry` entry points the command layer calls. Whether that target is ready
// is RunnerTests+TextEntryReadiness.swift's question, and this file asks it rather than answering
// it.
extension RunnerTests {
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
}
