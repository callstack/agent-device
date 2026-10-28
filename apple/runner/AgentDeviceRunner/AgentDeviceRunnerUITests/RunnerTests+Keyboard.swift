import XCTest
import AgentDeviceSnapshotPresentation

private enum KeyboardDismissObservationTiming {
  static let timeout: TimeInterval = 2
  // #1542: dismissing the keyboard can trigger the host app's own content-offset
  // adjustment (e.g. a ScrollView correcting the inset it grew to keep a focused
  // field above the keyboard). That adjustment is a separate, unsynchronized
  // animation the keyboard's own `waitForNonExistence` above knows nothing about:
  // the keyboard AX element can vanish well before the app settles. The very next
  // command is frequently a synthesized, AX-free drag (scroll/gesture — kept
  // AX-free so it still works under #1105-family AX degradation), which has no
  // XCTest quiescence wait of its own, so it can land mid-animation and net to
  // zero. These bounds cap the settle wait this trades in.
  // A spring-driven content-offset correction can pass through a near-zero-
  // velocity inflection (the top of an overshoot) that two adjacent samples
  // alone cannot distinguish from true rest. Requiring 3 consecutive matching
  // samples demands ~2 full sample intervals of actual stillness before
  // stopping early, so a momentary pause mid-animation cannot look settled.
  static let settleTimeout: TimeInterval = 2.0
  static let settleSampleInterval: TimeInterval = 0.15
  static let settleRequiredConsecutiveMatches: Int = 3
}

// The mechanism that actually resigned the keyboard, disclosed to the caller
// (#1598) so a response never claims "dismissed" without saying how — a
// safe-area tap has a very different reliability/side-effect profile than
// tapping the keyboard's own Done key, and callers need to know which one
// fired.
enum RunnerKeyboardDismissMechanism: String {
  case dismissKey
}

/// Keyboard coverage read from the capture's complete pre-projection root snapshot on iOS XCTest.
/// Visible frames include the input assistant and share the nodes' normalized coordinate space.
/// A complete scan with no keyboard establishes absence; projected or partial trees never do.
enum RunnerKeyboardBandFact: Equatable {
  case visible(CGRect)
  case absent
  case unmeasurable(String)

  var payload: KeyboardBandFactPayload {
    switch self {
    case .visible(let frame):
      return KeyboardBandFactPayload(
        kind: "visible",
        frame: SnapshotRect(
          x: Double(frame.origin.x),
          y: Double(frame.origin.y),
          width: Double(frame.size.width),
          height: Double(frame.size.height)
        ),
        reason: nil
      )
    case .absent:
      return KeyboardBandFactPayload(kind: "absent", frame: nil, reason: nil)
    case .unmeasurable(let reason):
      return KeyboardBandFactPayload(kind: "unmeasurable", frame: nil, reason: reason)
    }
  }

  var logKind: String {
    switch self {
    case .visible: return "visible"
    case .absent: return "absent"
    case .unmeasurable: return "unmeasurable"
    }
  }

  var logReason: String {
    switch self {
    case .visible, .absent: return "-"
    case .unmeasurable(let reason): return reason
    }
  }
}

/// The reason codes a capture publishes beside `unmeasurable`. Key behavior travels on these, never
/// on prose: a daemon log line and a `snapshot --json` reader have to agree on what `unmeasurable`
/// meant without parsing a sentence.
enum RunnerKeyboardBandReason {
  /// The keyboard exists and reports no usable box. It is on screen — only its band is unknown, which
  /// is not the same claim as `absent`.
  static let unusableFrame = "keyboard-frame-unusable"
  /// The captured-tree scan did not finish within its slice of the snapshot budget.
  static let queryTimeout = "keyboard-frame-query-timeout"
  /// No slice was left at all, so the read was never dispatched.
  static let budgetExhausted = "capture-plan-budget-exhausted"
}

/// Classifies a complete capture's keyboard observation; failed or timed-out captures never call it.
func runnerKeyboardBandFact(
  exists: Bool,
  frame: CGRect
) -> RunnerKeyboardBandFact {
  guard exists else { return .absent }
  guard SnapshotGeometry.isPositiveFinite(frame) else {
    return .unmeasurable(RunnerKeyboardBandReason.unusableFrame)
  }
  return .visible(frame)
}

private struct KeyboardBandProbeTimeout: Error {}

extension RunnerTests {
  /// The band the visible keyboard owns in the captured tree.
  ///
  /// Returns nil only where there is no iOS keyboard to look for. Every other outcome is stated,
  /// including the ones where looking failed: a missing field would leave the daemon guessing which
  /// tier answered, while a published `unmeasurable` names the reason where the band would have been.
  ///
  /// The tree and keyboard band describe the same capture, even if the live keyboard disappears.
  /// Its own bounded main-thread hop preserves the existing budget and timeout evidence.
  func captureKeyboardBandFact(snapshot: XCUIElementSnapshot, viewport: SnapshotViewport, deadline: Date) -> RunnerKeyboardBandFact? {
#if os(iOS)
    let slice = min(Self.keyboardBandProbeBudget, max(0, deadline.timeIntervalSinceNow))
    guard slice > 0 else {
      NSLog(
        "AGENT_DEVICE_RUNNER_KEYBOARD_BAND_FACT kind=unmeasurable reason=%@ elapsedMs=0",
        RunnerKeyboardBandReason.budgetExhausted
      )
      return .unmeasurable(RunnerKeyboardBandReason.budgetExhausted)
    }
    let startedAt = Date()
    let fact: RunnerKeyboardBandFact
    do {
      fact = try runMainThreadWork(
        "keyboard_band",
        timeout: slice,
        timeoutError: { KeyboardBandProbeTimeout() }
      ) {
        self.keyboardBandFact(snapshot: snapshot, viewport: viewport)
      }
    } catch {
      fact = .unmeasurable(RunnerKeyboardBandReason.queryTimeout)
    }
    NSLog(
      "AGENT_DEVICE_RUNNER_KEYBOARD_BAND_FACT kind=%@ reason=%@ elapsedMs=%d",
      fact.logKind,
      fact.logReason,
      Int(Date().timeIntervalSince(startedAt) * 1000)
    )
    return fact
#else
    return nil
#endif
  }

  private func keyboardBandFact(snapshot: XCUIElementSnapshot, viewport: SnapshotViewport) -> RunnerKeyboardBandFact {
    // A live exists/frame pair can race keyboard dismissal after the tree was captured.
    var pending: [(XCUIElementSnapshot, SnapshotGeometrySpace, String?)] = [(snapshot, .appOrientation, nil)]
    var keyboardFrame: CGRect?
    var assistantFrame = CGRect.null
    var sawKeyboard = false
    while let (node, inheritedSpace, parentType) = pending.popLast() {
      let type = elementTypeName(node.elementType)
      let space = SnapshotGeometrySpace.space(
        reportedType: type,
        parentType: parentType,
        reportedFrame: node.frame,
        inheritedFrom: inheritedSpace,
        viewport: viewport
      )
      let frame = space.orientedFrame(of: node.frame)
      if node.elementType == .keyboard {
        sawKeyboard = true
        // A stale keyboard in another window must not hide a valid captured keyboard.
        if SnapshotGeometry.isPositiveFinite(node.frame), SnapshotGeometry.isPositiveFinite(frame) {
          keyboardFrame = keyboardFrame.map { $0.union(frame) } ?? frame
        }
      } else if SnapshotKeyboardSurface.isInputAssistant(type: type, identifier: node.identifier),
        SnapshotGeometry.isPositiveFinite(node.frame), SnapshotGeometry.isPositiveFinite(frame) {
        assistantFrame = assistantFrame.union(frame)
      }
      pending.append(contentsOf: node.children.map { ($0, space, type) })
    }
    guard let keyboardFrame else {
      return sawKeyboard
        ? .unmeasurable(RunnerKeyboardBandReason.unusableFrame)
        : runnerKeyboardBandFact(exists: false, frame: .zero)
    }
    return runnerKeyboardBandFact(exists: true, frame: keyboardFrame.union(assistantFrame))
  }
}

extension RunnerTests {
  func isKeyboardVisible(app: XCUIApplication) -> Bool {
    return visibleKeyboardFrame(app: app) != nil
  }

  func dismissKeyboard(
    app: XCUIApplication
  ) -> (wasVisible: Bool, dismissed: Bool, visible: Bool, mechanism: RunnerKeyboardDismissMechanism?) {
    let keyboard = app.keyboards.firstMatch
    let wasVisible = isKeyboardVisible(app: app)
    guard wasVisible else {
      return (wasVisible: false, dismissed: false, visible: false, mechanism: nil)
    }

#if os(tvOS)
    _ = pressTvRemote(.menu)
    sleepFor(0.2)
    let visible = isKeyboardVisible(app: app)
    return (wasVisible: true, dismissed: !visible, visible: visible, mechanism: visible ? nil : .dismissKey)
#else
    if tapKeyboardDismissControl(app: app) {
      _ = keyboard.waitForNonExistence(timeout: KeyboardDismissObservationTiming.timeout)
      waitForScreenshotStability(
        app: app,
        timeout: KeyboardDismissObservationTiming.settleTimeout,
        sampleInterval: KeyboardDismissObservationTiming.settleSampleInterval,
        requiredConsecutiveMatches: KeyboardDismissObservationTiming.settleRequiredConsecutiveMatches
      )
      let visible = isKeyboardVisible(app: app)
      return (wasVisible: true, dismissed: !visible, visible: visible, mechanism: visible ? nil : .dismissKey)
    }

    // #1606 review P1 (twice): generic background-tap dismissal is
    // deliberately UNSUPPORTED. No geometry or role query can prove a
    // coordinate is side-effect-free — a full-screen unlabeled Pressable is
    // indistinguishable from an inert backdrop, so a "safe-area" tap can
    // navigate or submit while reporting a successful dismiss. The dismiss
    // key is the only mechanism the runner can vouch for.
    return (wasVisible: true, dismissed: false, visible: isKeyboardVisible(app: app), mechanism: nil)
#endif
  }


  // AX-free on purpose (screenshot bytes, not the accessibility tree) so it holds
  // under the same AX degradation the synthesized gesture lane is built to survive.
  // Bounded and self-terminating: returns as soon as `requiredConsecutiveMatches`
  // consecutive samples match, so an already-settled screen (the common case)
  // pays close to nothing. The stopping decision itself
  // (`runnerScreenshotStabilitySettled`) is a pure function of the samples taken
  // so far, so it is unit-testable without a real screenshot pipeline; this loop
  // is the thin, untestable I/O shell around it.
  private func waitForScreenshotStability(
    app: XCUIApplication,
    timeout: TimeInterval,
    sampleInterval: TimeInterval,
    requiredConsecutiveMatches: Int
  ) {
    let deadline = Date().addingTimeInterval(timeout)
    var samples: [Data?] = [screenshotFingerprintForStabilityCheck(app: app)]
    while Date() < deadline {
      sleepFor(sampleInterval)
      samples.append(screenshotFingerprintForStabilityCheck(app: app))
      if runnerScreenshotStabilitySettled(samples, requiredConsecutiveMatches: requiredConsecutiveMatches) {
        logScreenshotStability(samples: samples, settled: true)
        return
      }
    }
    logScreenshotStability(samples: samples, settled: false)
  }

  /// Says what the settle actually looked at: samples that are all `nil` means the capture refused to
  /// produce a frame, which is a different fact from a screen that never held still, and the two read
  /// identically from the outside (#2728).
  private func logScreenshotStability(samples: [Data?], settled: Bool) {
    NSLog(
      "AGENT_DEVICE_RUNNER_KEYBOARD_STABILITY samples=%ld captured=%ld settled=%@",
      samples.count,
      samples.compactMap { $0 }.count,
      settled ? "yes" : "no"
    )
  }

  private func screenshotFingerprintForStabilityCheck(app: XCUIApplication) -> Data? {
    guard let image = captureRunnerFrame(app: app) else { return nil }
    return runnerPngData(for: image)
  }

  func pressKeyboardReturn(app: XCUIApplication) -> (wasVisible: Bool, pressed: Bool, visible: Bool) {
#if os(tvOS)
    return (wasVisible: false, pressed: pressTvRemote(.select), visible: false)
#elseif os(iOS)
    let wasVisible = isKeyboardVisible(app: app)
    if tapKeyboardReturnControl(app: app) {
      sleepFor(0.2)
      return (wasVisible: wasVisible, pressed: true, visible: isKeyboardVisible(app: app))
    }

    guard typeKeyboardReturn({ app.typeText(XCUIKeyboardKey.return.rawValue) }) else {
      if let singleTarget = singleTextEntryElement(app: app) {
        return pressKeyboardReturn(on: singleTarget, app: app, wasVisible: wasVisible)
      }
      return (wasVisible: wasVisible, pressed: false, visible: isKeyboardVisible(app: app))
    }
    sleepFor(0.2)
    return (wasVisible: wasVisible, pressed: true, visible: isKeyboardVisible(app: app))
#else
    return (wasVisible: false, pressed: false, visible: false)
#endif
  }

  func visibleKeyboardFrame(app: XCUIApplication) -> CGRect? {
#if os(iOS)
    return safely("KEYBOARD_FRAME") {
      let keyboard = app.keyboards.firstMatch
      guard keyboard.exists else { return nil }
      let keyboardFrame = keyboard.frame
      guard !keyboardFrame.isEmpty else { return nil }
      return keyboardFrame
    }
#else
    return nil
#endif
  }

  private func pressKeyboardReturn(
    on element: XCUIElement,
    app: XCUIApplication,
    wasVisible: Bool
  ) -> (wasVisible: Bool, pressed: Bool, visible: Bool) {
#if os(iOS)
    // `element` is bound by index, and the keyboard the tap raises shifts those indices, so the
    // return goes to whatever the tap focused rather than to a re-resolved `element`.
    let typed = typeKeyboardReturn({
      element.tap()
      app.typeText(XCUIKeyboardKey.return.rawValue)
    })
    guard typed else {
      return (wasVisible: wasVisible, pressed: false, visible: isKeyboardVisible(app: app))
    }
    sleepFor(0.2)
    return (wasVisible: wasVisible, pressed: true, visible: isKeyboardVisible(app: app))
#else
    return (wasVisible: wasVisible, pressed: false, visible: false)
#endif
  }

  /// Types a return, false when nothing was typed: an ObjC exception, or XCTest's refusal to type
  /// with nothing focused. XCTest records that refusal as an issue, which would invalidate the runner
  /// session, so it alone is dropped; every other issue is recorded as usual.
  private func typeKeyboardReturn(_ type: () -> Void) -> Bool {
    let (issues, exceptionMessage) = holdingRecordedIssues(type)
    let noFocus = issues.filter { Self.isNoKeyboardFocusIssue($0.compactDescription) }
    issues.filter { !Self.isNoKeyboardFocusIssue($0.compactDescription) }.forEach { record($0) }
    if !noFocus.isEmpty { NSLog("AGENT_DEVICE_RUNNER_KEYBOARD_RETURN_NO_FOCUS") }
    if let exceptionMessage {
      NSLog("AGENT_DEVICE_RUNNER_KEYBOARD_RETURN_IGNORED_EXCEPTION=%@", exceptionMessage)
    }
    return noFocus.isEmpty && exceptionMessage == nil
  }

  /// XCTest names this refusal only in its English issue text, as it does the AX failures that
  /// `isSuppressedAxSnapshotIssueDescription` matches.
  static func isNoKeyboardFocusIssue(_ description: String) -> Bool {
    description.contains("Neither element nor any descendant has keyboard focus")
  }

  private func singleTextEntryElement(app: XCUIApplication) -> XCUIElement? {
#if os(iOS)
    let matches = safely("KEYBOARD_RETURN_TEXT_ENTRY_QUERY", []) {
      app.descendants(matching: .any).allElementsBoundByIndex.filter { element in
        guard element.exists else { return false }
        switch element.elementType {
        case .textField, .secureTextField, .searchField, .textView:
          return true
        default:
          return false
        }
      }
    }
    return matches.count == 1 ? matches[0] : nil
#else
    return nil
#endif
  }

  private func tapKeyboardDismissControl(app: XCUIApplication) -> Bool {
#if os(tvOS)
    return false
#else
    guard let keyboardFrame = visibleKeyboardFrame(app: app) else {
      return false
    }
    for label in ["Hide keyboard", "Dismiss keyboard", "Done"] {
      let candidates = [
        app.keyboards.buttons[label],
        app.keyboards.keys[label],
        app.keyboards.toolbars.buttons[label],
      ]
      if let hittable = candidates.first(where: { $0.exists && $0.isHittable }) {
        hittable.tap()
        return true
      }

      let toolbarButtonPredicate = NSPredicate(
        format: "label == %@ OR identifier == %@",
        label,
        label
      )
      let toolbarButtons = app.descendants(matching: .button)
        .matching(toolbarButtonPredicate)
        .allElementsBoundByIndex
      if let hittable = toolbarButtons.first(where: {
        $0.exists && $0.isHittable && isKeyboardAccessoryControl($0, keyboardFrame: keyboardFrame)
      }) {
        hittable.tap()
        return true
      }
    }
    return false
#endif
  }

  private func tapKeyboardReturnControl(app: XCUIApplication) -> Bool {
#if os(iOS)
    for label in ["return", "Return", "Enter", "Go", "Search", "Next", "Done", "Send", "Join"] {
      let candidates = [
        app.keyboards.buttons[label],
        app.keyboards.keys[label],
      ]
      if let hittable = candidates.first(where: { $0.exists && $0.isHittable }) {
        hittable.tap()
        return true
      }
    }
#endif
    return false
  }

  private func isKeyboardAccessoryControl(_ element: XCUIElement, keyboardFrame: CGRect) -> Bool {
    let frame = element.frame
    guard !frame.isEmpty && !keyboardFrame.isEmpty else {
      return false
    }
    return frame.intersects(keyboardFrame) || abs(frame.maxY - keyboardFrame.minY) <= 80
  }
}

/// True once the `requiredConsecutiveMatches` most recent samples are all present
/// and byte-identical — i.e. the screen held still across that whole run of
/// polls, not just the last two. A spring-driven content-offset correction can
/// pass through a near-zero-velocity inflection that two adjacent samples alone
/// cannot distinguish from true rest; requiring a longer run of matches demands
/// real elapsed stillness before stopping early. `nil` entries (a screenshot
/// capture that failed) never count toward a match, so a flaky capture cannot
/// look like stability; the caller's bounded loop still terminates on its
/// deadline regardless.
func runnerScreenshotStabilitySettled(
  _ samples: [Data?],
  requiredConsecutiveMatches: Int
) -> Bool {
  guard requiredConsecutiveMatches >= 2, samples.count >= requiredConsecutiveMatches else {
    return false
  }
  let window = samples.suffix(requiredConsecutiveMatches)
  guard let first = window.first, let firstData = first else { return false }
  return window.allSatisfy { $0 == firstData }
}
