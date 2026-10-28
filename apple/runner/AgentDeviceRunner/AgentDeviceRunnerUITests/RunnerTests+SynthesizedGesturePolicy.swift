import XCTest
import AgentDeviceSnapshotPresentation

// Runner-local policy for AX-free/private synthesized iOS gestures.
//
// This policy is intentionally separate from the TS interaction guarantee matrix:
// ADR 0011 models element-targeting guarantees, while this module models command
// paths that must keep scroll/drag/sequence usable when XCTest AX is unhealthy.

enum RunnerAccessibilityHealth: String, Equatable {
  case unknown
  case healthy
  case unavailable
}

enum SynthesizedGesturePolicyKind: String, Equatable, Hashable {
  case coordinateTap
  case coordinateLongPress
  case scroll
  case synthesizedDrag

  /// Whether the call site's XCTest coordinate gesture may run after private synthesis fails.
  /// Scroll's swipe is viewport-center-symmetric, so an unverified dispatch cannot be told apart
  /// from one that never reached the view, and it keeps the refusal. A coordinate long press
  /// resolves the app frame through the tree, so on a tree XCTest cannot serialize that read fails
  /// after its retries and raises an exception that ends the runner test; its fallback needs a tree
  /// that answers.
  func allowsXCTestCoordinateFallback(accessibilityHealth: RunnerAccessibilityHealth) -> Bool {
    switch self {
    case .coordinateTap:
      return true
    case .coordinateLongPress, .synthesizedDrag:
      return accessibilityHealth != .unavailable
    case .scroll:
      return false
    }
  }
}

struct SynthesizedCoordinateContext {
  let referenceFrame: CGRect
  /// The window `referenceFrame` was measured on. Synthesized records route their display ID
  /// through this same window so geometry and routing can never name different windows. Nil is the
  /// sole-screen route: XCTest could not resolve the window, `referenceFrame` is the device's only
  /// screen, and the record is routed to that screen.
  let resolvedWindow: XCUIElement?
  let accessibilityHealth: RunnerAccessibilityHealth

  func withReferenceFrame(_ frame: CGRect) -> SynthesizedCoordinateContext {
    SynthesizedCoordinateContext(
      referenceFrame: frame,
      resolvedWindow: resolvedWindow,
      accessibilityHealth: accessibilityHealth
    )
  }

  /// The keyboard probe is not free — `visibleKeyboardFrame` resolves `app.keyboards.firstMatch`
  /// with a live AX fetch — so `.unavailable` skips it: there the fetch is known not to answer,
  /// and a gesture that needs the frame fails open on a missing one. `.unknown` still probes;
  /// skipping it there left the first scroll of a session swiping under the keys.
  var allowsKeyboardProbe: Bool {
    accessibilityHealth != .unavailable
  }
}

func shouldProbeCoordinateTapTextInput(
  xCTestChannelPenalized: Bool,
  evidence: CoordinateTapTextInputEvidence?,
  point: CGPoint?,
  targetBundleId: String?
) -> Bool {
  if xCTestChannelPenalized { return false }
  guard let evidence, let point, point.x.isFinite, point.y.isFinite,
    !evidence.targetBundleId.isEmpty, evidence.targetBundleId == targetBundleId,
    evidence.point.x == point.x, evidence.point.y == point.y
  else { return true }
  for input in evidence.textInputRects {
    let rect = CGRect(x: input.x, y: input.y, width: input.width, height: input.height)
    guard SnapshotGeometry.isPositiveFinite(rect) else { return true }
    if isCoordinateTextInputCandidate(enabled: true, frame: rect, point: point) { return true }
  }
  return false
}

/// A synthesized `tap` step in a `sequence` is a standalone coordinate tap and follows its policy. On
/// iOS a `longPress` step is a standalone long press, which is always synthesized.
func synthesizedPolicyKind(forSequenceStep step: SequenceStep) -> SynthesizedGesturePolicyKind? {
  switch step.kind {
  case "tap":
    return step.synthesized == true ? .coordinateTap : nil
#if os(iOS)
  case "longPress":
    return .coordinateLongPress
#endif
  default:
    return nil
  }
}

/// A synthesized gesture's result for its call site, which owns the XCTest coordinate gesture.
enum SynthesizedGestureAttempt {
  case performed(timing: (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double))
  /// Synthesis failed and the policy allows the call site's XCTest coordinate gesture.
  case xctestFallback(message: String, hint: String?)
  /// Synthesis failed and the policy refuses an XCTest coordinate gesture.
  case refused(
    timing: (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double),
    message: String,
    hint: String?
  )
}

extension RunnerTests {
  @MainActor
  func synthesizedSequenceCoordinateContext(
    steps: [SequenceStep],
    app: XCUIApplication
  ) -> SynthesizedCoordinateContext? {
    guard steps.lazy.contains(where: { synthesizedPolicyKind(forSequenceStep: $0) != nil }) else {
      return nil
    }
    return synthesizedCoordinateContext(app: app)
  }

  /// `context` is nil when no window frame resolved; `kind`'s fallback decision then reads the
  /// runner's current accessibility health.
  @MainActor
  func performSynthesizedGesture(
    _ app: XCUIApplication,
    kind: SynthesizedGesturePolicyKind,
    context: SynthesizedCoordinateContext?,
    synthesize: () -> RunnerInteractionOutcome?
  ) -> SynthesizedGestureAttempt {
    var outcome: RunnerInteractionOutcome?
    let timing = measureGesture { outcome = synthesize() }
    guard let outcome else {
      logSynthesizedGesturePolicyDecision(kind: kind, context: context, fallbackAttempted: false)
      return .refused(timing: timing, message: "synthesized gesture deadline expired before dispatch", hint: nil)
    }
    guard case .unsupported(let message, let hint) = outcome else {
      logSynthesizedGesturePolicyDecision(kind: kind, context: context, fallbackAttempted: false)
      return .performed(timing: timing)
    }
    let fallbackAllowed = kind.allowsXCTestCoordinateFallback(
      accessibilityHealth: context?.accessibilityHealth ?? mainOwned.accessibilityHealth
    )
    logSynthesizedGesturePolicyDecision(
      kind: kind,
      context: context,
      fallbackAttempted: fallbackAllowed
    )
    return fallbackAllowed
      ? .xctestFallback(message: message, hint: hint)
      : .refused(timing: timing, message: message, hint: hint)
  }

  @MainActor
  func logSynthesizedGesturePolicyDecision(
    kind: SynthesizedGesturePolicyKind,
    context: SynthesizedCoordinateContext?,
    fallbackAttempted: Bool
  ) {
#if os(iOS)
    let line = Self.synthesizedGesturePolicyLine(
      kind: kind,
      context: context,
      fallbackAttempted: fallbackAttempted
    )
    // The same decision for the same gesture kind on every command is one line; a changed policy
    // (AX health or the fallback decision) is a new one.
    if lastLoggedGesturePolicyLines[kind] != line {
      lastLoggedGesturePolicyLines[kind] = line
      runnerMarkerWriter(line)
    }
#endif
  }

  static func synthesizedGesturePolicyLine(
    kind: SynthesizedGesturePolicyKind,
    context: SynthesizedCoordinateContext?,
    fallbackAttempted: Bool
  ) -> String {
    guard let context else {
      return "AGENT_DEVICE_RUNNER_SYNTHESIZED_GESTURE_POLICY kind=\(kind.rawValue)"
        + " context=unavailable fallbackAttempted=\(fallbackAttempted)"
    }
    return "AGENT_DEVICE_RUNNER_SYNTHESIZED_GESTURE_POLICY kind=\(kind.rawValue)"
      + " axHealth=\(context.accessibilityHealth.rawValue)"
      + " fallbackAllowed=\(kind.allowsXCTestCoordinateFallback(accessibilityHealth: context.accessibilityHealth))"
      + " fallbackAttempted=\(fallbackAttempted)"
  }
}
