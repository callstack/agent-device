import XCTest
import AgentDeviceSnapshotPresentation

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
        reason: nil,
        treeBound: true
      )
    case .absent:
      return KeyboardBandFactPayload(kind: "absent", frame: nil, reason: nil, treeBound: true)
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
    visibleKeyboardFrame(app: app) != nil
  }

  func keyboardStatus(app: XCUIApplication) -> RunnerKeyboardStatus? {
#if os(iOS)
    var result: RunnerKeyboardStatus?
    let (issues, exception) = holdingRecordedIssues {
      let keyboard = app.keyboards.firstMatch
      guard keyboard.exists else {
        result = .hidden
        return
      }
      guard let snapshot = try? keyboard.snapshot(),
        let viewport = try? safeSnapshotViewport(app: app, readingOrientation: true)
      else { return }
      let keys = observedKeyboardKeys(in: snapshot)
      result = RunnerKeyboardStatus.observed(
        keyboardFrame: snapshot.frame,
        keys: keys,
        viewport: viewport
      )
    }
    for issue in issues {
      NSLog("AGENT_DEVICE_RUNNER_KEYBOARD_STATUS_ISSUE=%@", issue.compactDescription)
    }
    if let exception { NSLog("AGENT_DEVICE_RUNNER_KEYBOARD_STATUS_EXCEPTION=%@", exception) }
    return issues.isEmpty && exception == nil ? result : nil
#else
    return .hidden
#endif
  }

#if os(iOS)
  private func observedKeyboardKeys(in keyboard: XCUIElementSnapshot) -> [RunnerKeyboardStatus.ObservedKeyboardKey] {
    var keys: [RunnerKeyboardStatus.ObservedKeyboardKey] = []
    var pending = keyboard.children
    while let node = pending.popLast() {
      pending.append(contentsOf: node.children)
      guard node.elementType == .key || node.elementType == .button else { continue }
      keys.append(.init(label: node.label, identifier: node.identifier, frame: node.frame, isKey: node.elementType == .key))
    }
    return keys
  }
#endif

  func keyboardDismissRefusal() -> ErrorPayload {
    ErrorPayload(
      code: RunnerWireErrorCode.keyboardDismissUnavailable,
      message: "The Apple runner cannot dismiss this keyboard automatically",
      hint: "Inspect the screen and press the visible Hide Keyboard key or an app control that ends editing. If the app supports interactive dismissal, use gesture pan to drag a finger down from inside its scrollable content and check the keyboard state again."
    )
  }

  var keyboardReturnRefusal: ErrorPayload {
    ErrorPayload(
      code: RunnerWireErrorCode.keyboardReturnUnavailable,
      message: "Could not confirm Return was sent to the focused input",
      hint: "Check the screen before retrying. Focus the intended input before sending Return, or press the app's submit control explicitly."
    )
  }

  func pressKeyboardReturn(app: XCUIApplication) -> Bool {
#if os(tvOS)
    return pressTvRemote(.select)
#elseif os(iOS)
    // XCTest reports absent focus through an issue. Any issue leaves dispatch uncertain,
    // so report failure without invalidating the session the caller needs to observe the app.
    let (issues, exception) = holdingRecordedIssues {
      app.typeText(XCUIKeyboardKey.return.rawValue)
    }
    if let exception { NSLog("AGENT_DEVICE_RUNNER_KEYBOARD_RETURN_EXCEPTION=%@", exception) }
    for issue in issues {
      NSLog("AGENT_DEVICE_RUNNER_KEYBOARD_RETURN_ISSUE=%@", issue.compactDescription)
    }
    return issues.isEmpty && exception == nil
#else
    return false
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
}
