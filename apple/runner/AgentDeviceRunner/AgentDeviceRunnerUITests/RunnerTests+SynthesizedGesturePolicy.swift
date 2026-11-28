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
  /// that answers. A coordinate tap resolves its anchor through the same read, but its refusal
  /// needs the proof of the call's own windows query (`treeUnreadable`), not the health the last
  /// snapshot left behind: a tree that answers now still takes the XCTest tap.
  func allowsXCTestCoordinateFallback(
    accessibilityHealth: RunnerAccessibilityHealth,
    treeUnreadable: Bool = false
  ) -> Bool {
    switch self {
    case .coordinateTap:
      return !treeUnreadable
    case .coordinateLongPress, .synthesizedDrag:
      return accessibilityHealth != .unavailable
    case .scroll:
      return false
    }
  }
}

/// Where a synthesized gesture's window frame came from, which decides both where its records
/// route and what the frame proves about the app's tree.
enum SynthesizedWindowSource {
  /// This call's windows query named the window. One that fills an iPhone's only screen is on that
  /// screen's display, so its records route to the screen and dispatch skips re-reading the window's
  /// frame and screen, two XCTest round trips per gesture.
  case resolved(XCUIElement, fillsSoleScreen: Bool)
  /// This call's windows query answered no window and the sole-screen route supplied the frame, so
  /// XCTest cannot anchor a coordinate on the app's tree.
  case soleScreen
  /// The call skipped the windows query because a sole-screen iPhone's screen is its window, so
  /// nothing yet proves whether the tree answers. A fallback decision runs the query first
  /// (`provingDeferredWindowQuery`).
  case deferred
}

struct SynthesizedCoordinateContext {
  let geometry: SurfaceGeometry
  let windowSource: SynthesizedWindowSource
  let accessibilityHealth: RunnerAccessibilityHealth

  /// The window this call's windows query named, or nil when it named none or did not run.
  var resolvedWindow: XCUIElement? {
    guard case .resolved(let window, _) = windowSource else { return nil }
    return window
  }

  /// This call's windows query ran and answered no window.
  var treeUnreadable: Bool {
    guard case .soleScreen = windowSource else { return false }
    return true
  }

  /// The window a synthesized record routes by, or nil for the sole-screen route.
  var dispatchWindow: XCUIElement? {
    guard case .resolved(let window, fillsSoleScreen: false) = windowSource else { return nil }
    return window
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
  /// Synthesis failed and the policy refuses an XCTest coordinate gesture. `refusal` is the
  /// producer's `.unsupported` or `.notDispatched` outcome, never `.performed`.
  case refused(
    timing: (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double),
    refusal: RunnerInteractionOutcome
  )
}

extension RunnerTests {
  @MainActor
  func synthesizedSequenceCoordinateContext(
    steps: [SequenceStep],
    app: XCUIApplication
  ) throws -> SynthesizedCoordinateContext? {
    guard steps.lazy.contains(where: { synthesizedPolicyKind(forSequenceStep: $0) != nil }) else {
      return nil
    }
    return try synthesizedCoordinateContext(app: app)
  }

  @MainActor
  func performSynthesizedTapGesture(
    app: XCUIApplication,
    x: Double,
    y: Double,
    context: SynthesizedCoordinateContext? = nil
  ) throws -> SynthesizedGestureAttempt {
    let context = try context ?? synthesizedCoordinateContext(app: app)
    return try performSynthesizedGesture(app, kind: .coordinateTap, context: context) {
      try synthesizedTapAt(app: app, x: x, y: y, context: context)
    }
  }

  /// `context` is nil when no window frame resolved; `kind`'s fallback decision then reads the
  /// runner's current accessibility health.
  @MainActor
  func performSynthesizedGesture(
    _ app: XCUIApplication,
    kind: SynthesizedGesturePolicyKind,
    context: SynthesizedCoordinateContext?,
    synthesize: () throws -> RunnerInteractionOutcome?
  ) throws -> SynthesizedGestureAttempt {
    var outcome: RunnerInteractionOutcome?
    let timing: (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double)
    do {
      timing = try measureGesture { outcome = try synthesize() }
    } catch let unknown as RunnerGestureOutcomeUnknown {
      // A gesture that may have run is never repeated through a fallback.
      logSynthesizedGesturePolicyDecision(kind: kind, context: context, fallbackAttempted: false)
      throw unknown
    }
    guard let outcome else {
      logSynthesizedGesturePolicyDecision(kind: kind, context: context, fallbackAttempted: false)
      return .refused(
        timing: timing,
        refusal: .unsupported(message: "synthesized gesture deadline expired before dispatch", hint: nil)
      )
    }
    guard case let (message, hint)? = outcome.refusalText else {
      logSynthesizedGesturePolicyDecision(kind: kind, context: context, fallbackAttempted: false)
      return .performed(timing: timing)
    }
    let context = context.map { provingDeferredWindowQuery($0, app: app) }
    let fallbackAllowed = kind.allowsXCTestCoordinateFallback(
      accessibilityHealth: context?.accessibilityHealth ?? mainOwned.accessibilityHealth,
      treeUnreadable: context?.treeUnreadable ?? false
    )
    logSynthesizedGesturePolicyDecision(
      kind: kind,
      context: context,
      fallbackAttempted: fallbackAllowed
    )
    return fallbackAllowed
      ? .xctestFallback(message: message, hint: hint)
      : .refused(timing: timing, refusal: outcome)
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
    let fallbackAllowed: String
    switch context.windowSource {
    case .deferred:
      // The windows query has not run, so the fallback decision is not known yet.
      fallbackAllowed = "unproven"
    case .resolved, .soleScreen:
      fallbackAllowed = "\(kind.allowsXCTestCoordinateFallback(accessibilityHealth: context.accessibilityHealth, treeUnreadable: context.treeUnreadable))"
    }
    return "AGENT_DEVICE_RUNNER_SYNTHESIZED_GESTURE_POLICY kind=\(kind.rawValue)"
      + " axHealth=\(context.accessibilityHealth.rawValue)"
      + " fallbackAllowed=\(fallbackAllowed)"
      + " fallbackAttempted=\(fallbackAttempted)"
  }
}

extension SynthesizedCoordinateContext {
  /// Nil when the window has no finite, non-empty box.
  init?(
    validating geometry: SurfaceGeometry,
    windowSource: SynthesizedWindowSource,
    accessibilityHealth: RunnerAccessibilityHealth
  ) {
    guard SnapshotGeometry.isPositiveFinite(geometry.windowOnScreen.rect) else { return nil }
    self.init(geometry: geometry, windowSource: windowSource, accessibilityHealth: accessibilityHealth)
  }
}
