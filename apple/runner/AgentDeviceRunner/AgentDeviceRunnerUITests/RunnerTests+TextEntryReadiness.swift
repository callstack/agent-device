import XCTest

// Text-entry readiness: whether the target is actually able to receive text yet. The waits, the
// keyboard signals they read, and the focus corroboration that ends the hardware-keyboard window.
// RunnerTests+TextEntryFocus.swift is the only caller of the two non-private entries here; nothing
// in this file reaches back into it.
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

  func waitForTextEntryReadiness(
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

  /// Gives a tapped text input one readiness window to take focus, then taps it once more if focus did
  /// not arrive. The caller has already decided this element is a text input, so this function must not
  /// re-derive that fact from the element: both tap routes classify BEFORE dispatching, and asking the
  /// handle afterwards re-runs its query. On a Flutter password field that re-run is exactly what fails
  /// (#3060): XCTest refuses the element with "computed TextField from legacy attributes vs Other from
  /// modern attribute", so a post-dispatch classification would also classify differently from the caller.
  ///
  /// The frame still has to be read, and reading it through `element.frame` records an XCTest failure when
  /// the element has stopped answering its query; `didRecordXCTestFailure` turns that into
  /// `XCTEST_RECORDED_FAILURE` plus an invalidated target for a tap the dispatch had already landed.
  /// `snapshot()` answers the same question through the throwing channel and records nothing, which is why
  /// `probeTextEntryInput` and `withElement` already read elements this way. It is read again after the
  /// wait rather than reused, because focusing a field moves the layout: the repeat aims at where the
  /// field is then, which is the moment the read it replaced ran at.
  func waitForTextEntryReadinessAfterTap(app: XCUIApplication, element: XCUIElement) {
#if os(iOS)
    if waitForFocusedTextInput(app: app, timeout: TextEntryTiming.readinessTimeout) != nil {
      return
    }
    guard let settled = safely("TEXT_ENTRY_READINESS_FRAME", { try? element.snapshot() }) else {
      return
    }
    let frame = settled.frame
    if !frame.isEmpty {
      _ = tapAt(app: app, x: frame.midX, y: frame.midY)
      _ = waitForFocusedTextInput(app: app, timeout: TextEntryTiming.readinessTimeout)
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

  func keyboardBecameVisible(app: XCUIApplication, wasVisibleAtEntry: Bool) -> Bool {
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
