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

/// The band the visible keyboard owns, measured by the one producer that can ask the keyboard
/// directly instead of rebuilding it from a captured tree.
///
/// `app.keyboards.firstMatch` answers in the app's own orientation space, which no tree tier can say
/// about its own rects while the app is rotated (#2612, #2653). Publishing the measurement is what
/// lets the daemon's tap guard answer with a point-in-rect test instead of guessing where a
/// plausible-looking band would be (#2660).
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
  /// The `app.keyboards` read threw or otherwise produced no answer at all.
  static let queryFailed = "keyboard-frame-query-failed"
  /// The keyboard exists and reports no usable box. It is on screen — only its band is unknown, which
  /// is not the same claim as `absent`.
  static let unusableFrame = "keyboard-frame-unusable"
  /// The read did not return inside the slice this capture had left for it, so the band was abandoned
  /// rather than waited on: a keyboard this capture cannot afford to measure is not worth a stalled
  /// capture, and the daemon's tap guard falls back to the tree rule for this capture alone.
  static let queryTimeout = "keyboard-frame-query-timeout"
  /// No slice was left at all, so the read was never dispatched.
  static let budgetExhausted = "capture-plan-budget-exhausted"
}

/// Whether a keyboard's reported box can be a band at all. A zero-area or non-finite box is what an
/// element XCTest cannot measure looks like.
///
/// Reads `origin` and `size` rather than the rect's own accessors: `CGRect.width` and `CGRect.height`
/// standardize, so a box reported with a negative size answers them with a positive one and an
/// unmeasurable element would ship as a measured band. The daemon's reader applies the same rule to
/// the wire frame, so neither language can publish a band the other would refuse.
func runnerKeyboardFrameIsUsable(_ frame: CGRect) -> Bool {
  let size = frame.size
  let origin = frame.origin
  return [origin.x, origin.y, size.width, size.height].allSatisfy(\.isFinite)
    && size.width > 0 && size.height > 0
}

/// The one decision the keyboard-band probe makes, kept away from the live query so the unit lane can
/// pin it without a keyboard on screen. Three outcomes and no fourth: a read that failed says it
/// failed, a keyboard that is not there is proven absent, and a keyboard whose box cannot be measured
/// is unmeasurable rather than absent — the difference is whether anything may claim this screen is
/// clear of a keyboard.
func runnerKeyboardBandFact(
  readSucceeded: Bool,
  exists: Bool,
  frame: CGRect
) -> RunnerKeyboardBandFact {
  guard readSucceeded else { return .unmeasurable(RunnerKeyboardBandReason.queryFailed) }
  guard exists else { return .absent }
  guard runnerKeyboardFrameIsUsable(frame) else {
    return .unmeasurable(RunnerKeyboardBandReason.unusableFrame)
  }
  return .visible(frame)
}

private struct KeyboardBandProbeTimeout: Error {}

extension RunnerTests {
  /// The band the visible keyboard owns, read once per capture.
  ///
  /// Returns nil only where there is no iOS keyboard to look for. Every other outcome is stated,
  /// including the ones where looking failed: a missing field would leave the daemon guessing which
  /// tier answered, while a published `unmeasurable` names the reason where the band would have been.
  ///
  /// Its own main-thread hop with its own slice, taken after the tree so the fact is never older than
  /// the tree it is compared against, and so a keyboard this capture cannot afford to measure costs the
  /// capture nothing: a timeout abandons the fact and leaves the tree tier standing, the same trade
  /// `boundedBlockingSystemAlertSnapshot` makes for the probe it bounds (#2660). The elapsed time rides
  /// the stamp so the cost of the extra query stays checkable in the field.
  func captureKeyboardBandFact(app: XCUIApplication, deadline: Date) -> RunnerKeyboardBandFact? {
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
        self.keyboardBandFact(app: app)
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

  private func keyboardBandFact(app: XCUIApplication) -> RunnerKeyboardBandFact {
    let read = safely("KEYBOARD_BAND_FACT") { () -> RunnerKeyboardBandFact? in
      let keyboard = app.keyboards.firstMatch
      guard keyboard.exists else {
        return runnerKeyboardBandFact(readSucceeded: true, exists: false, frame: .zero)
      }
      return runnerKeyboardBandFact(readSucceeded: true, exists: true, frame: keyboard.frame)
    }
    return read ?? .unmeasurable(RunnerKeyboardBandReason.queryFailed)
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
    timeout: TimeInterval,
    sampleInterval: TimeInterval,
    requiredConsecutiveMatches: Int
  ) {
    let deadline = Date().addingTimeInterval(timeout)
    var samples: [Data?] = [screenshotFingerprintForStabilityCheck()]
    while Date() < deadline {
      sleepFor(sampleInterval)
      samples.append(screenshotFingerprintForStabilityCheck())
      if runnerScreenshotStabilitySettled(samples, requiredConsecutiveMatches: requiredConsecutiveMatches) {
        return
      }
    }
  }

  private func screenshotFingerprintForStabilityCheck() -> Data? {
    guard let image = captureRunnerFrame() else { return nil }
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

    var typed = false
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      app.typeText(XCUIKeyboardKey.return.rawValue)
      typed = true
    })
    if let exceptionMessage {
      NSLog(
        "AGENT_DEVICE_RUNNER_KEYBOARD_RETURN_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      if let singleTarget = singleTextEntryElement(app: app) {
        return pressKeyboardReturn(on: singleTarget, app: app, wasVisible: wasVisible)
      }
      return (wasVisible: wasVisible, pressed: false, visible: isKeyboardVisible(app: app))
    }
    sleepFor(0.2)
    return (wasVisible: wasVisible, pressed: typed, visible: isKeyboardVisible(app: app))
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
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      element.tap()
      element.typeText(XCUIKeyboardKey.return.rawValue)
    })
    if let exceptionMessage {
      NSLog(
        "AGENT_DEVICE_RUNNER_KEYBOARD_RETURN_TARGET_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      return (wasVisible: wasVisible, pressed: false, visible: isKeyboardVisible(app: app))
    }
    sleepFor(0.2)
    return (wasVisible: wasVisible, pressed: true, visible: isKeyboardVisible(app: app))
#else
    return (wasVisible: wasVisible, pressed: false, visible: false)
#endif
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

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testKeyboardBandFactReadFailureIsStatedAsUnmeasurableNotAbsence() {
    // Absence would let a consumer claim the screen is clear of a keyboard on the strength of a read
    // that never answered.
    let fact = runnerKeyboardBandFact(
      readSucceeded: false,
      exists: false,
      frame: CGRect(x: 0, y: 198, width: 402, height: 204)
    )
    XCTAssertEqual(fact, .unmeasurable(RunnerKeyboardBandReason.queryFailed))
    XCTAssertEqual(fact.payload.kind, "unmeasurable")
    XCTAssertEqual(fact.payload.reason, RunnerKeyboardBandReason.queryFailed)
    XCTAssertNil(fact.payload.frame)
  }

  func testKeyboardBandFactPublishesAbsenceWhenTheQueryFindsNoKeyboard() {
    let fact = runnerKeyboardBandFact(readSucceeded: true, exists: false, frame: .zero)
    XCTAssertEqual(fact, .absent)
    XCTAssertEqual(fact.payload.kind, "absent")
    XCTAssertNil(fact.payload.frame)
    XCTAssertNil(fact.payload.reason)
  }

  func testKeyboardBandFactPublishesTheMeasuredBandInAppOrientationSpace() {
    // The landscape band measured on iPhone 17 Pro (iOS 26.2) after #2653: full width across the
    // bottom of a 402 pt-tall app, which is what the tree reported as a strip down the left edge.
    let frame = CGRect(x: 0, y: 198, width: 874, height: 204)
    let fact = runnerKeyboardBandFact(readSucceeded: true, exists: true, frame: frame)
    XCTAssertEqual(fact, .visible(frame))
    let payload = fact.payload
    XCTAssertEqual(payload.kind, "visible")
    XCTAssertEqual(payload.frame, SnapshotRect(x: 0, y: 198, width: 874, height: 204))
    XCTAssertNil(payload.reason)
  }

  func testKeyboardBandFactRefusesUnusableGeometryInsteadOfClaimingAbsence() {
    let nan = CGFloat(Double.nan)
    let infinite = CGFloat.infinity
    let unusable: [CGRect] = [
      .zero,
      CGRect(x: 0, y: 198, width: 0, height: 204),
      CGRect(x: 0, y: 198, width: 874, height: -1),
      CGRect(x: 0, y: 198, width: -874, height: 204),
      CGRect(x: 0, y: nan, width: 874, height: 204),
      CGRect(x: 0, y: 198, width: nan, height: 204),
      CGRect(x: infinite, y: 198, width: 874, height: 204)
    ]
    for frame in unusable {
      let fact = runnerKeyboardBandFact(readSucceeded: true, exists: true, frame: frame)
      XCTAssertEqual(
        fact,
        .unmeasurable(RunnerKeyboardBandReason.unusableFrame),
        "expected \(frame) to be refused as a band"
      )
    }
  }

  func testKeyboardBandFactPayloadRoundTripsThroughTheWireShape() throws {
    let cases: [RunnerKeyboardBandFact] = [
      .visible(CGRect(x: 0, y: 583, width: 402, height: 291)),
      .absent,
      .unmeasurable(RunnerKeyboardBandReason.queryTimeout)
    ]
    for fact in cases {
      let data = try JSONEncoder().encode(fact.payload)
      // `encodeIfPresent` for the two optional fields: a fact carries its own evidence and nothing
      // else, so the daemon never has to distinguish a null from an absent key.
      let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      switch fact {
      case .visible:
        XCTAssertNil(object["reason"])
        XCTAssertNotNil(object["frame"])
      case .absent:
        XCTAssertNil(object["frame"])
        XCTAssertNil(object["reason"])
      case .unmeasurable:
        XCTAssertNil(object["frame"])
        XCTAssertNotNil(object["reason"])
      }
      XCTAssertEqual(try JSONDecoder().decode(KeyboardBandFactPayload.self, from: data), fact.payload)
    }
  }

  func testRunnerScreenshotStabilitySettledNeedsEnoughSamples() {
    XCTAssertFalse(runnerScreenshotStabilitySettled([], requiredConsecutiveMatches: 3))
    XCTAssertFalse(runnerScreenshotStabilitySettled([Data([1])], requiredConsecutiveMatches: 3))
    let frame = Data([1, 2, 3])
    XCTAssertFalse(
      runnerScreenshotStabilitySettled([frame, frame], requiredConsecutiveMatches: 3)
    )
  }

  func testRunnerScreenshotStabilitySettledTrueWhenWindowMatches() {
    let frame = Data([1, 2, 3])
    XCTAssertTrue(
      runnerScreenshotStabilitySettled([Data([9]), frame, frame, frame], requiredConsecutiveMatches: 3)
    )
  }

  func testRunnerScreenshotStabilitySettledFalseOnMidWindowMismatch() {
    // A momentary pause (two matching samples) followed by resumed movement
    // must not read as settled: the 3-sample window still spans the mismatch.
    let frame = Data([1, 2, 3])
    let moved = Data([4, 5, 6])
    XCTAssertFalse(
      runnerScreenshotStabilitySettled([frame, frame, moved], requiredConsecutiveMatches: 3)
    )
  }

  func testRunnerScreenshotStabilitySettledFalseOnFailedCapture() {
    // A nil sample (failed screenshot) never counts as a match, even against
    // other nils — an unverifiable run must not look "stable".
    XCTAssertFalse(runnerScreenshotStabilitySettled([nil, nil, nil], requiredConsecutiveMatches: 3))
    let frame = Data([1, 2, 3])
    XCTAssertFalse(
      runnerScreenshotStabilitySettled([frame, frame, nil], requiredConsecutiveMatches: 3)
    )
  }

  func testRunnerScreenshotStabilitySettledOnlyLooksAtTheTrailingWindow() {
    // An older mismatch before the trailing window must not block settlement
    // once the required run of most-recent samples agrees.
    let frame = Data([9])
    XCTAssertTrue(
      runnerScreenshotStabilitySettled(
        [Data([1]), Data([2]), frame, frame, frame],
        requiredConsecutiveMatches: 3
      )
    )
  }

  func testRunnerScreenshotStabilitySettledRejectsDegenerateRequirement() {
    // Fewer than 2 required matches would make any single sample "settled" —
    // guard against a misconfigured caller rather than silently no-op the wait.
    XCTAssertFalse(
      runnerScreenshotStabilitySettled([Data([1])], requiredConsecutiveMatches: 1)
    )
  }
}
#endif
