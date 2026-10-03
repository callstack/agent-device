import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  func invalidScrollDirectionResponse(commandName: String) -> Response {
    Response(
      ok: false,
      error: ErrorPayload(
        code: "INVALID_ARGS",
        message: "\(commandName) requires direction up|down|left|right"
      )
    )
  }

  func scrollDurationIsValid(_ durationMs: Double?) -> Bool {
    guard let durationMs else { return true }
    return durationMs.isFinite && durationMs >= 0 && durationMs <= 10000
  }

  func invalidScrollDurationResponse(commandName: String) -> Response {
    return Response(
      ok: false,
      error: ErrorPayload(
        code: "INVALID_ARGS",
        message: "\(commandName) durationMs must be between 0 and 10000"
      )
    )
  }

  @MainActor
  func executeScrollDragGesture(
    activeApp: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    durationMs: Double,
    message: String,
    context: SynthesizedCoordinateContext,
    releaseBehavior: ScrollReleaseBehavior?
  ) -> Response {
#if os(iOS)
    return executeDragGesture(
      activeApp: activeApp,
      x: x,
      y: y,
      x2: x2,
      y2: y2,
      durationMs: durationMs,
      message: message,
      synthesizedContext: context,
      synthesized: (profile: scrollDragProfile(releaseBehavior: releaseBehavior), policyKind: .scroll)
    )
#else
    return executeDragGesture(
      activeApp: activeApp,
      x: x,
      y: y,
      x2: x2,
      y2: y2,
      durationMs: durationMs,
      message: message
    )
#endif
  }

  /// Shared coordinate drag execution. Callers that pass `synthesized` take the iOS synthesized
  /// lane with that profile and fallback policy; the rest perform an XCTest coordinate drag.
  @MainActor
  func executeDragGesture(
    activeApp: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    durationMs: Double?,
    message: String,
    synthesizedContext: SynthesizedCoordinateContext? = nil,
    synthesized: (profile: SynthesizedDragProfile, policyKind: SynthesizedGesturePolicyKind)? = nil
  ) -> Response {
    let durationMs = durationMs ?? runnerDefaultDragDurationMs
    let commandName = dragCommandName(message: message)
    guard x.isFinite, y.isFinite, x2.isFinite, y2.isFinite else {
      return Response(
        ok: false,
        error: ErrorPayload(code: "INVALID_ARGS", message: "\(commandName) requires finite coordinates")
      )
    }
    if let synthesized, let synthesizedResponse = executeSynthesizedDragGesture(
      activeApp: activeApp,
      x: x,
      y: y,
      x2: x2,
      y2: y2,
      durationMs: durationMs,
      message: message,
      context: synthesizedContext,
      policyKind: synthesized.policyKind,
      profile: synthesized.profile
    ) {
      return synthesizedResponse
    }
    let dragPoints = keyboardAvoidingDragPoints(app: activeApp, x: x, y: y, x2: x2, y2: y2)
    let dragFrame = resolvedDragVisualizationFrame(
      app: activeApp,
      x: dragPoints.x,
      y: dragPoints.y,
      x2: dragPoints.x2,
      y2: dragPoints.y2
    )
    let holdDuration = synthesized == nil
      ? coordinateDragHoldDuration()
      : synthesizedSwipeFallbackHoldDuration(durationMs: durationMs)
    let (timing, outcome) = performGesture(activeApp) {
      dragAt(
        app: activeApp,
        x: dragPoints.x,
        y: dragPoints.y,
        x2: dragPoints.x2,
        y2: dragPoints.y2,
        holdDuration: holdDuration
      )
    }
    if let response = unsupportedResponse(for: outcome) {
      return response
    }
    return gestureResponse(message: message, timing: timing, frame: .drag(dragFrame))
  }

  @MainActor
  private func executeSynthesizedDragGesture(
    activeApp: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    durationMs: Double,
    message: String,
    context: SynthesizedCoordinateContext?,
    policyKind: SynthesizedGesturePolicyKind,
    profile: SynthesizedDragProfile
  ) -> Response? {
#if os(iOS)
    let policy = synthesizedGesturePolicy(policyKind)
    let context = context ?? synthesizedCoordinateContext(app: activeApp, policy: policy)
    guard let plan = axFreeSynthesizedDragPlan(
      app: activeApp,
      x: x,
      y: y,
      x2: x2,
      y2: y2,
      context: context
    )
    else {
      logSynthesizedGesturePolicyDecision(kind: policyKind, context: context, fallbackAttempted: false)
      return Response(
        ok: false,
        error: ErrorPayload(
          code: "INVALID_ARGS",
          message: "\(dragCommandName(message: message)) could not resolve a finite synthesized coordinate frame"
        )
      )
    }
    let durationMs = min(max(durationMs, 16), 10000)
    let dragFrame = axFreeDragVisualizationFrame(
      x: plan.points.x,
      y: plan.points.y,
      x2: plan.points.x2,
      y2: plan.points.y2,
      referenceFrame: plan.referenceFrame
    )
    switch performSynthesizedGesture(activeApp, kind: policyKind, context: plan.context, synthesize: {
      synthesizedDragAt(
        app: activeApp,
        x: plan.points.x,
        y: plan.points.y,
        x2: plan.points.x2,
        y2: plan.points.y2,
        durationMs: durationMs,
        profile: profile,
        context: plan.context
      )
    }) {
    case .performed(let timing):
      return gestureResponse(message: message, timing: timing, frame: .drag(dragFrame))
    case .xctestFallback(let fallbackMessage, let hint):
      return executeCoordinateDragFallback(
        activeApp: activeApp,
        x: plan.points.x,
        y: plan.points.y,
        x2: plan.points.x2,
        y2: plan.points.y2,
        durationMs: durationMs,
        message: message,
        fallback: GestureFallback(strategy: "xctest-coordinate-drag", message: fallbackMessage, hint: hint)
      )
    case .refused(_, let refusalMessage, let hint):
      return unsupportedResponse(message: refusalMessage, hint: hint)
    }
#else
    return nil
#endif
  }

  @MainActor
  private func executeCoordinateDragFallback(
    activeApp: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    durationMs: Double,
    message: String,
    fallback: GestureFallback
  ) -> Response {
    let dragPoints = keyboardAvoidingDragPoints(app: activeApp, x: x, y: y, x2: x2, y2: y2)
    let dragFrame = resolvedDragVisualizationFrame(
      app: activeApp,
      x: dragPoints.x,
      y: dragPoints.y,
      x2: dragPoints.x2,
      y2: dragPoints.y2
    )
    let holdDuration = synthesizedSwipeFallbackHoldDuration(durationMs: durationMs)
    let (timing, outcome) = performGesture(activeApp) {
      dragAt(
        app: activeApp,
        x: dragPoints.x,
        y: dragPoints.y,
        x2: dragPoints.x2,
        y2: dragPoints.y2,
        holdDuration: holdDuration
      )
    }
    if let response = unsupportedResponse(for: outcome) {
      return response
    }
    return gestureResponse(
      message: message,
      timing: timing,
      frame: .drag(dragFrame),
      fallback: fallback
    )
  }

  /// Adds the #2500 avoidance evidence to a scroll response. Only the frame resolver knows whether
  /// it trimmed the swipe for a keyboard, and only `scroll` has this evidence to carry, so it is
  /// attached where the frame was resolved rather than threaded through every gesture response.
  /// The refusal a keyboard forces. It performs no gesture: swiping into the keys would leave the
  /// surface where it was, which the daemon's no-progress fingerprint reads as a stuck container
  /// (#2499) and an agent reads as a broken scroll. The TS owner maps the code to the
  /// `scroll_keyboard_occludes_surface` reason and the "dismiss the keyboard" hint.
  func scrollKeyboardOccludedResponse(
    direction: String,
    keyboardMinY: Double,
    visibleHeight: Double
  ) -> Response {
    return Response(
      ok: false,
      error: ErrorPayload(
        code: ScrollViewportPolicy.occlusionRunnerCode,
        message: String(
          format:
            "scroll %@ refused: the keyboard leaves %.0fpt of visible surface above it, too little to swipe",
          direction,
          visibleHeight
        )
      )
    )
  }

  private func dragCommandName(message: String) -> String {
    return message == "scrolled" ? "scroll" : "drag"
  }
}
