import XCTest

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

enum SynthesizedKeyboardPolicy: String, Equatable, Hashable {
  case never
  case requiredWhenAvailable

  func allowsProbe(accessibilityHealth: RunnerAccessibilityHealth) -> Bool {
    switch self {
    case .never:
      return false
    case .requiredWhenAvailable:
      return accessibilityHealth != .unavailable
    }
  }
}

enum SynthesizedFallbackPolicy: String, Equatable, Hashable {
  case privateSynthesisRequired
  case xctestCoordinateWhenAccessibilityAvailable
  case xctestCoordinateAllowed

  func allowsXCTestCoordinateFallback(accessibilityHealth: RunnerAccessibilityHealth) -> Bool {
    switch self {
    case .privateSynthesisRequired:
      return false
    case .xctestCoordinateWhenAccessibilityAvailable:
      return accessibilityHealth != .unavailable
    case .xctestCoordinateAllowed:
      return true
    }
  }
}

enum SynthesizedGesturePolicyKind: String, Equatable, Hashable {
  case coordinateTap
  case scroll
  case synthesizedDrag
}

struct SynthesizedGesturePolicy: Equatable, Hashable {
  let keyboardPolicy: SynthesizedKeyboardPolicy
  let fallbackPolicy: SynthesizedFallbackPolicy
}

struct SynthesizedCoordinateContext {
  let referenceFrame: CGRect
  /// The window `referenceFrame` was measured on. Synthesized records route their display ID
  /// through this same window so geometry and routing can never name different windows.
  let resolvedWindow: XCUIElement
  let keyboardPolicy: SynthesizedKeyboardPolicy
  let accessibilityHealth: RunnerAccessibilityHealth

  func withReferenceFrame(_ frame: CGRect) -> SynthesizedCoordinateContext {
    SynthesizedCoordinateContext(
      referenceFrame: frame,
      resolvedWindow: resolvedWindow,
      keyboardPolicy: keyboardPolicy,
      accessibilityHealth: accessibilityHealth
    )
  }

  var allowsKeyboardProbe: Bool {
    keyboardPolicy.allowsProbe(accessibilityHealth: accessibilityHealth)
  }
}

func synthesizedGesturePolicy(_ kind: SynthesizedGesturePolicyKind) -> SynthesizedGesturePolicy {
  switch kind {
  case .coordinateTap:
    return SynthesizedGesturePolicy(
      keyboardPolicy: .never,
      fallbackPolicy: .xctestCoordinateAllowed
    )
  case .scroll:
    // Scroll places a viewport-center-symmetric swipe, so it cannot tell a keyboard-struck swipe
    // from a scroll that reached the edge without reading the live keyboard frame (#2500). The
    // probe is not free — `visibleKeyboardFrame` resolves `app.keyboards.firstMatch` with a live AX
    // fetch — but skipping it on `.unknown` left the first scroll of a session swiping under the
    // keys, which is the failure this command exists to avoid. `.unavailable` still skips it: there
    // the fetch is known not to answer, and `ScrollViewportPolicy` fails open on a missing frame.
    return SynthesizedGesturePolicy(
      keyboardPolicy: .requiredWhenAvailable,
      fallbackPolicy: .privateSynthesisRequired
    )
  case .synthesizedDrag:
    return SynthesizedGesturePolicy(
      keyboardPolicy: .requiredWhenAvailable,
      fallbackPolicy: .xctestCoordinateWhenAccessibilityAvailable
    )
  }
}

func shouldProbeCoordinateTapTextInput(xCTestChannelPenalized: Bool) -> Bool {
  !xCTestChannelPenalized
}

/// A synthesized `tap` step in a `sequence` is a standalone coordinate tap and follows its policy.
func synthesizedPolicyKind(forSequenceStep step: SequenceStep) -> SynthesizedGesturePolicyKind? {
  step.synthesized == true && step.kind == "tap" ? .coordinateTap : nil
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
    guard let kind = steps.lazy.compactMap(synthesizedPolicyKind(forSequenceStep:)).first else {
      return nil
    }
    return synthesizedCoordinateContext(app: app, policy: synthesizedGesturePolicy(kind))
  }

  /// `context` is nil when no window frame resolved; `kind`'s fallback policy then reads the
  /// runner's current accessibility health.
  @MainActor
  func performSynthesizedGesture(
    _ app: XCUIApplication,
    kind: SynthesizedGesturePolicyKind,
    context: SynthesizedCoordinateContext?,
    synthesize: () -> RunnerInteractionOutcome
  ) -> SynthesizedGestureAttempt {
    let (timing, outcome) = performGesture(app, idleTimeout: false, synthesize)
    guard case .unsupported(let message, let hint) = outcome else {
      logSynthesizedGesturePolicyDecision(kind: kind, context: context, fallbackAttempted: false)
      return .performed(timing: timing)
    }
    let fallbackAllowed = synthesizedGesturePolicy(kind).fallbackPolicy.allowsXCTestCoordinateFallback(
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
    // (AX health, keyboard, fallback) is a new one.
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
    let fallbackPolicy = synthesizedGesturePolicy(kind).fallbackPolicy
    return "AGENT_DEVICE_RUNNER_SYNTHESIZED_GESTURE_POLICY kind=\(kind.rawValue)"
      + " axHealth=\(context.accessibilityHealth.rawValue) frameSource=window"
      + " keyboardPolicy=\(context.keyboardPolicy.rawValue)"
      + " fallbackPolicy=\(fallbackPolicy.rawValue)"
      + " fallbackAllowed=\(fallbackPolicy.allowsXCTestCoordinateFallback(accessibilityHealth: context.accessibilityHealth))"
      + " fallbackAttempted=\(fallbackAttempted)"
  }
}
