import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  func currentUptimeMs() -> Double {
    ProcessInfo.processInfo.systemUptime * 1000
  }

  func measureGesture(_ action: () -> Void) -> (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double) {
    let gestureStartUptimeMs = currentUptimeMs()
    action()
    return (gestureStartUptimeMs, currentUptimeMs())
  }

  func synthesizedSwipeFallbackHoldDuration(durationMs: Double) -> TimeInterval {
    min(max((durationMs / 5.0) / 1000.0, 0.016), 0.120)
  }

  func coordinateDragHoldDuration() -> TimeInterval {
    0.050
  }

  func unsupportedResponse(for outcome: RunnerInteractionOutcome) -> Response? {
    switch outcome {
    case .performed:
      return nil
    case .unsupported(let message, let hint):
      return unsupportedResponse(message: message, hint: hint)
    }
  }

  func unsupportedResponse(message: String, hint: String?) -> Response {
    Response(
      ok: false,
      error: ErrorPayload(code: "UNSUPPORTED_OPERATION", message: message, hint: hint)
    )
  }

  /// Optional visualization frame returned with a gesture response.
  enum GestureFrame {
    case none
    case touch(TouchVisualizationFrame?)
    case drag(DragVisualizationFrame)
  }

  struct GestureFallback {
    let strategy: String
    let message: String
    let hint: String?
  }


  /// Runs a gesture action with uniform timing capture. Touch gestures pass `idleTimeout: true`
  /// (the default) to run inside the scroll idle-timeout + quiescence-skip wrapper; synthesis
  /// pointer-plan gestures pass `false` because RunnerSynthesizedGesture governs their
  /// own timing. Returns the captured timing and the action's outcome.
  ///
  /// NOTE: a new SYNTHESIS gesture must pass `idleTimeout: false` — the default `true` would wrap
  /// it in the scroll idle-timeout/quiescence-skip path and change its runtime behavior.
  @MainActor
  func performGesture(
    _ app: XCUIApplication,
    idleTimeout: Bool = true,
    _ action: () -> RunnerInteractionOutcome
  ) -> (timing: (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double), outcome: RunnerInteractionOutcome) {
    var outcome = RunnerInteractionOutcome.performed
    let timing = measureGesture {
      if idleTimeout {
        withBoundedInteractionIdleTimeoutIfSupported(app, waits: .bothSkipped) {
          outcome = action()
        }
      } else {
        outcome = action()
      }
    }
    return (timing, outcome)
  }

  /// Single factory for the success payload every gesture returns (message + gesture timing +
  /// an optional touch/drag visualization frame), so the field shape lives in one place.
  func gestureResponse(
    message: String,
    timing: (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double),
    frame: GestureFrame = .none,
    fallback: GestureFallback? = nil,
    maestroNonHittableCoordinateFallbackUsed: Bool? = nil
  ) -> Response {
    let data: DataPayload
    switch frame {
    case .none:
      data = DataPayload(
        message: message,
        gestureStartUptimeMs: timing.gestureStartUptimeMs,
        gestureEndUptimeMs: timing.gestureEndUptimeMs,
        gestureFallback: fallback?.strategy,
        gestureFallbackMessage: fallback?.message,
        gestureFallbackHint: fallback?.hint,
        maestroNonHittableCoordinateFallbackUsed: maestroNonHittableCoordinateFallbackUsed
      )
    case .touch(let f):
      data = DataPayload(
        message: message,
        gestureStartUptimeMs: timing.gestureStartUptimeMs,
        gestureEndUptimeMs: timing.gestureEndUptimeMs,
        x: f?.x,
        y: f?.y,
        referenceWidth: f?.referenceWidth,
        referenceHeight: f?.referenceHeight,
        gestureFallback: fallback?.strategy,
        gestureFallbackMessage: fallback?.message,
        gestureFallbackHint: fallback?.hint,
        maestroNonHittableCoordinateFallbackUsed: maestroNonHittableCoordinateFallbackUsed
      )
    case .drag(let f):
      data = DataPayload(
        message: message,
        gestureStartUptimeMs: timing.gestureStartUptimeMs,
        gestureEndUptimeMs: timing.gestureEndUptimeMs,
        x: f.x,
        y: f.y,
        x2: f.x2,
        y2: f.y2,
        referenceWidth: f.referenceWidth,
        referenceHeight: f.referenceHeight,
        gestureFallback: fallback?.strategy,
        gestureFallbackMessage: fallback?.message,
        gestureFallbackHint: fallback?.hint
      )
    }
    return Response(ok: true, data: data)
  }

  /// Gesture plans already return canonical centroid endpoints from the portable runtime.
  /// Keep runner timing/fallback diagnostics, but do not leak the coordinate-drag adapter's
  /// visualization frame into only the fast-fling response shape.
  func canonicalPlannedGestureResponse(_ response: Response) -> Response {
    guard response.ok, let data = response.data else { return response }
    return Response(
      ok: true,
      data: DataPayload(
        message: data.message,
        gestureStartUptimeMs: data.gestureStartUptimeMs,
        gestureEndUptimeMs: data.gestureEndUptimeMs,
        gestureFallback: data.gestureFallback,
        gestureFallbackMessage: data.gestureFallbackMessage,
        gestureFallbackHint: data.gestureFallbackHint
      )
    )
  }

  func plannedGestureResponse(
    plan: RunnerGesturePlan,
    timing: (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double),
    outcome: RunnerInteractionOutcome
  ) -> Response {
    if let response = unsupportedResponse(for: outcome) {
      return response
    }
    return gestureResponse(message: plan.intent, timing: timing)
  }
}
