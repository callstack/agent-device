import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  @MainActor
  func synthesizedDragAt(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    durationMs: Double,
    profile: SynthesizedDragProfile,
    context: SynthesizedCoordinateContext? = nil
  ) -> RunnerInteractionOutcome {
#if os(iOS)
    guard x.isFinite, y.isFinite, x2.isFinite, y2.isFinite else {
      return .unsupported(
        message: "synthesized coordinate drag requires finite coordinates",
        hint: "Retry with finite x, y, x2, and y2 values."
      )
    }
    let orientation = Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app))
    guard let context = context ?? synthesizedCoordinateContext(
      app: app,
      policy: synthesizedGesturePolicy(.synthesizedDrag)
    ) else {
      return .unsupported(
        message: "synthesized coordinate drag could not resolve an app window with a finite screen frame",
        hint: "Retry after the app is foregrounded, or use a plain screenshot to choose coordinates."
      )
    }
    let frame = context.referenceFrame
    let start = CoordinateSpaceRotation.native(
      point: CGPoint(x: x, y: y),
      in: frame,
      interfaceOrientation: orientation
    )
    let end = CoordinateSpaceRotation.native(
      point: CGPoint(x: x2, y: y2),
      in: frame,
      interfaceOrientation: orientation
    )
    logSynthesizedDispatch(
      kind: "drag",
      start: start,
      end: end,
      referenceFrame: frame,
      orientation: orientation
    )
    let message = switch profile {
    case .controlledScroll:
      RunnerSynthesizedGesture.synthesizeControlledScroll(
        withApplication: app,
        resolvedWindow: context.resolvedWindow,
        x: Double(start.x),
        y: Double(start.y),
        x2: Double(end.x),
        y2: Double(end.y),
        durationMs: durationMs
      )
    case .fastSwipe:
      RunnerSynthesizedGesture.synthesizeSwipe(
        withApplication: app,
        resolvedWindow: context.resolvedWindow,
        x: Double(start.x),
        y: Double(start.y),
        x2: Double(end.x),
        y2: Double(end.y),
        durationMs: durationMs
      )
    }
    if let message {
      return .unsupported(
        message: message,
        hint: "Private XCTest event synthesis is required for AX-free coordinate drag on iOS; update Xcode if this persists."
      )
    }
    return .performed
#elseif os(tvOS)
    return .unsupported(
      message: "coordinate drag is not supported on tvOS",
      hint: "tvOS has no coordinate input; use remote-driven swipe/scroll to move focus instead."
    )
#else
    return .unsupported(
      message: "coordinate drag is not supported on macOS",
      hint: "macOS automation has no touchscreen; use mouse-driven interactions instead."
    )
#endif
  }

  @MainActor
  func synthesizedTapAt(
    app: XCUIApplication,
    x: Double,
    y: Double,
    context: SynthesizedCoordinateContext? = nil
  ) -> RunnerInteractionOutcome {
#if os(iOS)
    guard x.isFinite, y.isFinite else {
      return .unsupported(
        message: "synthesized coordinate tap requires finite coordinates",
        hint: "Retry with finite x and y values."
      )
    }
    let orientation = Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app))
    guard let context = context ?? synthesizedCoordinateContext(
      app: app,
      policy: synthesizedGesturePolicy(.coordinateTap)
    ) else {
      return .unsupported(
        message: "synthesized coordinate tap could not resolve an app window with a finite screen frame",
        hint: "Retry after the app is foregrounded, or use a plain screenshot to choose coordinates."
      )
    }
    let point = CoordinateSpaceRotation.native(
      point: CGPoint(x: x, y: y),
      in: context.referenceFrame,
      interfaceOrientation: orientation
    )
    logSynthesizedDispatch(
      kind: "tap",
      start: point,
      end: nil,
      referenceFrame: context.referenceFrame,
      orientation: orientation
    )
    if let message = RunnerSynthesizedGesture.synthesizeTap(
      withApplication: app,
      resolvedWindow: context.resolvedWindow,
      x: Double(point.x),
      y: Double(point.y)
    ) {
      return .unsupported(
        message: message,
        hint: "Falling back to XCTest coordinate tap may be slower and can still need a healthy accessibility tree."
      )
    }
    return .performed
#elseif os(tvOS)
    return .unsupported(
      message: "coordinate tap is not supported on tvOS; move focus with swipe or scroll, then select the focused element",
      hint: "tvOS has no coordinate input; move focus with swipe/scroll to the target, then select it."
    )
#else
    return .unsupported(
      message: "synthesized coordinate tap is not supported on macOS",
      hint: "macOS automation has no touchscreen; use mouse-driven interactions instead."
    )
#endif
  }

  func keyboardAvoidingDragPoints(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double
  ) -> DragPoints {
    let original = DragPoints(x: x, y: y, x2: x2, y2: y2)
#if os(iOS)
    guard let keyboardFrame = visibleKeyboardFrame(app: app) else {
      return original
    }
    let minX = min(x, x2)
    let minY = min(y, y2)
    let gestureBounds = CGRect(
      x: CGFloat(minX),
      y: CGFloat(minY),
      width: CGFloat(max(abs(x2 - x), 1)),
      height: CGFloat(max(abs(y2 - y), 1))
    )
    guard gestureBounds.intersects(keyboardFrame) else {
      return original
    }

    let appFrame = onScreenWindowFrame(app: app)
    guard !appFrame.isEmpty else {
      return original
    }

    let padding: Double = 12
    let targetMaxY = Double(keyboardFrame.minY) - padding
    let currentMaxY = max(y, y2)
    let shift = currentMaxY - targetMaxY
    guard shift > 0 else {
      return original
    }

    let adjustedY = y - shift
    let adjustedY2 = y2 - shift
    guard min(adjustedY, adjustedY2) >= Double(appFrame.minY) + padding else {
      return original
    }

    NSLog(
      "AGENT_DEVICE_RUNNER_KEYBOARD_AVOIDING_DRAG from=(%.1f,%.1f)->(%.1f,%.1f) adjusted=(%.1f,%.1f)->(%.1f,%.1f) keyboardMinY=%.1f",
      x,
      y,
      x2,
      y2,
      x,
      adjustedY,
      x2,
      adjustedY2,
      Double(keyboardFrame.minY)
    )
    return DragPoints(x: x, y: adjustedY, x2: x2, y2: adjustedY2)
#else
    return original
#endif
  }

  func resolvedTouchVisualizationFrame(app: XCUIApplication, x: Double, y: Double) -> TouchVisualizationFrame {
    let appFrame = app.frame
    let referenceFrame = resolvedTouchReferenceFrame(app: app, appFrame: appFrame)
    let originX = appFrame.isEmpty ? referenceFrame.minX : appFrame.minX
    let originY = appFrame.isEmpty ? referenceFrame.minY : appFrame.minY
    return TouchVisualizationFrame(
      x: originX + x,
      y: originY + y,
      referenceWidth: referenceFrame.width,
      referenceHeight: referenceFrame.height
    )
  }

  func resolvedDragVisualizationFrame(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double
  ) -> DragVisualizationFrame {
    let start = resolvedTouchVisualizationFrame(app: app, x: x, y: y)
    let end = resolvedTouchVisualizationFrame(app: app, x: x2, y: y2)
    return DragVisualizationFrame(
      x: start.x,
      y: start.y,
      x2: end.x,
      y2: end.y,
      referenceWidth: start.referenceWidth,
      referenceHeight: start.referenceHeight
    )
  }

  func resolvedTouchReferenceFrame(app: XCUIApplication, appFrame: CGRect) -> CGRect {
    let resolved = resolveRunnerWindow(app: app)
    if resolved.window != nil {
      return frameAvoidingKeyboard(app: app, frame: resolved.frame)
    }
    if !appFrame.isEmpty {
      return frameAvoidingKeyboard(app: app, frame: appFrame)
    }
    return CGRect(x: 0, y: 0, width: 0, height: 0)
  }

  private func frameAvoidingKeyboard(app: XCUIApplication, frame: CGRect) -> CGRect {
#if os(iOS)
    guard let keyboardFrame = visibleKeyboardFrame(app: app), !frame.isEmpty else {
      return frame
    }
    let intersection = frame.intersection(keyboardFrame)
    guard !intersection.isNull && intersection.height > 0 else {
      return frame
    }
    let keyboardCoverage = intersection.width / max(frame.width, 1)
    guard keyboardCoverage >= 0.5 else {
      return frame
    }
    let safeHeight = keyboardFrame.minY - frame.minY
    guard safeHeight >= frame.height * 0.25 else {
      return frame
    }
    return CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: safeHeight)
#else
    return frame
#endif
  }

  @MainActor
  func axFreeSynthesizedDragPlan(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    context: SynthesizedCoordinateContext? = nil
  ) -> SynthesizedDragPlan? {
#if os(iOS)
    let context = context ?? synthesizedCoordinateContext(
      app: app,
      policy: synthesizedGesturePolicy(.synthesizedDrag)
    )
    guard x.isFinite, y.isFinite, x2.isFinite, y2.isFinite,
      let context
    else {
      return nil
    }
    let points = keyboardAvoidingSynthesizedDragPoints(
      app: app,
      x: x,
      y: y,
      x2: x2,
      y2: y2,
      context: context
    )
    return SynthesizedDragPlan(
      points: points,
      context: context
    )
#else
    return nil
#endif
  }

  func axFreeDragVisualizationFrame(
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    referenceFrame: CGRect
  ) -> DragVisualizationFrame {
    return DragVisualizationFrame(
      x: x,
      y: y,
      x2: x2,
      y2: y2,
      referenceWidth: Double(referenceFrame.width),
      referenceHeight: Double(referenceFrame.height)
    )
  }

  func logSynthesizedDispatch(
    kind: String,
    start: CGPoint,
    end: CGPoint?,
    referenceFrame: CGRect,
    orientation: Int
  ) {
    if let end {
      NSLog(
        "AGENT_DEVICE_RUNNER_SYNTHESIZED_DISPATCH kind=%@ start=(%.1f,%.1f) end=(%.1f,%.1f) reference=(%.1f,%.1f,%.1f,%.1f) orientation=%d",
        kind,
        Double(start.x),
        Double(start.y),
        Double(end.x),
        Double(end.y),
        Double(referenceFrame.origin.x),
        Double(referenceFrame.origin.y),
        Double(referenceFrame.width),
        Double(referenceFrame.height),
        orientation
      )
      return
    }
    NSLog(
      "AGENT_DEVICE_RUNNER_SYNTHESIZED_DISPATCH kind=%@ point=(%.1f,%.1f) reference=(%.1f,%.1f,%.1f,%.1f) orientation=%d",
      kind,
      Double(start.x),
      Double(start.y),
      Double(referenceFrame.origin.x),
      Double(referenceFrame.origin.y),
      Double(referenceFrame.width),
      Double(referenceFrame.height),
      orientation
    )
  }

  @MainActor
  func synthesizedCoordinateContext(
    app: XCUIApplication,
    policy: SynthesizedGesturePolicy
  ) -> SynthesizedCoordinateContext? {
#if os(iOS)
    let health = mainOwned.accessibilityHealth
    let resolved = resolveRunnerWindow(app: app)
    guard let window = resolved.window else {
      return nil
    }
    let referenceFrame = resolved.frame
    guard referenceFrame.width.isFinite, referenceFrame.height.isFinite,
      referenceFrame.width > 0, referenceFrame.height > 0
    else {
      return nil
    }
    return SynthesizedCoordinateContext(
      referenceFrame: referenceFrame,
      resolvedWindow: window,
      keyboardPolicy: policy.keyboardPolicy,
      accessibilityHealth: health
    )
#else
    return nil
#endif
  }


  func keyboardAvoidingSynthesizedDragPoints(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    context: SynthesizedCoordinateContext
  ) -> DragPoints {
#if os(iOS)
    guard context.allowsKeyboardProbe else {
      return DragPoints(x: x, y: y, x2: x2, y2: y2)
    }
    return keyboardAvoidingDragPoints(app: app, x: x, y: y, x2: x2, y2: y2)
#else
    return DragPoints(x: x, y: y, x2: x2, y2: y2)
#endif
  }

  func swipe(app: XCUIApplication, direction: String) -> DragVisualizationFrame? {
    if performTvRemoteSwipeIfAvailable(direction: direction) {
      let frame = resolvedTouchReferenceFrame(app: app, appFrame: app.frame)
      let midX = frame.midX
      let midY = frame.midY
      return DragVisualizationFrame(
        x: midX,
        y: midY,
        x2: midX,
        y2: midY,
        referenceWidth: frame.width,
        referenceHeight: frame.height
      )
    }
    return nil
  }

  private func performTvRemoteSwipeIfAvailable(direction: String) -> Bool {
    switch direction {
    case "up":
      return pressTvRemote(.up)
    case "down":
      return pressTvRemote(.down)
    case "left":
      return pressTvRemote(.left)
    case "right":
      return pressTvRemote(.right)
    default:
      return false
    }
  }

  func plannedGestureValidationError(_ plan: RunnerGesturePlan) -> String? {
    guard plan.topology == "single" || plan.topology == "two" else {
      return "planned gesture topology must be single or two"
    }
    let supportedIntent = plan.topology == "single"
      ? plan.intent == "fling" || plan.intent == "pan"
      : plan.intent == "pan" || plan.intent == "pinch" || plan.intent == "rotate"
        || plan.intent == "transform"
    guard supportedIntent else { return "planned gesture has unsupported intent for its topology" }
    if plan.topology == "single" {
      guard plan.executionProfile == "endpoint-hold" || plan.executionProfile == "timed-pan" else {
        return "single-pointer gesture requires a supported execution profile"
      }
    } else if plan.executionProfile != nil {
      return "multi-touch gesture cannot define a single-pointer execution profile"
    }
    guard plan.durationMs.isFinite, plan.durationMs >= 16, plan.durationMs <= 10_000 else {
      return "planned gesture durationMs must be between 16 and 10000"
    }
    let viewport = plan.viewport
    guard viewport.x.isFinite, viewport.y.isFinite, viewport.width.isFinite,
      viewport.height.isFinite, viewport.width > 0, viewport.height > 0
    else {
      return "planned gesture viewport must be finite and positive"
    }
    let expectedPointerCount = plan.topology == "single" ? 1 : 2
    guard plan.pointers.count == expectedPointerCount else {
      return "planned gesture pointer count does not match topology"
    }
    for (index, pointer) in plan.pointers.enumerated() where pointer.pointerId != index {
      return "planned gesture requires ordered pointer ids"
    }
    let firstSamples = plan.pointers[0].samples
    guard firstSamples.count >= 2 else { return "planned pointer paths require at least two samples" }
    for pointer in plan.pointers {
      guard pointer.samples.count == firstSamples.count else {
        return "planned pointer paths require matching samples"
      }
      var previousOffset = -1.0
      for (index, sample) in pointer.samples.enumerated() {
        guard sample.offsetMs.isFinite,
          sample.offsetMs == firstSamples[index].offsetMs,
          sample.offsetMs > previousOffset
        else {
          return "planned pointer sample offsets must match and strictly increase"
        }
        let point = sample.point
        guard point.x.isFinite, point.y.isFinite,
          point.x >= viewport.x,
          point.x <= viewport.x + viewport.width,
          point.y >= viewport.y,
          point.y <= viewport.y + viewport.height
        else {
          return "planned pointer sample lies outside the viewport"
        }
        previousOffset = sample.offsetMs
      }
      guard pointer.samples.first?.offsetMs == 0,
        pointer.samples.last?.offsetMs == plan.durationMs
      else {
        return "planned pointer paths must start at 0 and end at durationMs"
      }
    }
    if plan.topology == "two" {
      guard let firstStart = firstSamples.first?.point,
        let secondStart = plan.pointers[1].samples.first?.point,
        hypot(firstStart.x - secondStart.x, firstStart.y - secondStart.y) > 0
      else {
        return "planned pointer paths require a positive initial span"
      }
    }
    return nil
  }

  func plannedGestureExecution(for plan: RunnerGesturePlan) -> PlannedGestureExecution {
    plan.topology == "single" && plan.executionProfile == "endpoint-hold"
      ? .fastSwipe
      : .sampled
  }

  func sampledPlannedGesture(
    app: XCUIApplication,
    plan: RunnerGesturePlan
  ) -> RunnerInteractionOutcome {
#if os(iOS)
    let orientation = Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app))
    // The portable planner and validation use this exact viewport. Using app.frame here can
    // diverge when XCTest unions transformed/off-screen descendants into the application frame.
    let frame = CGRect(
      x: plan.viewport.x,
      y: plan.viewport.y,
      width: plan.viewport.width,
      height: plan.viewport.height
    )
    let pointerSamples: [[[String: NSNumber]]] = plan.pointers.map { pointer in
      pointer.samples.map { sample in
        let point = CoordinateSpaceRotation.native(
          point: CGPoint(x: sample.point.x, y: sample.point.y),
          in: frame,
          interfaceOrientation: orientation
        )
        return [
          "x": NSNumber(value: Double(point.x)),
          "y": NSNumber(value: Double(point.y)),
          "offsetMs": NSNumber(value: sample.offsetMs),
        ]
      }
    }
    let resolvedWindow = resolveRunnerWindow(app: app).window
    if let message = RunnerSynthesizedGesture.synthesizeGesture(
      withApplication: app,
      resolvedWindow: resolvedWindow,
      pointerSamples: pointerSamples
    ) {
      return .unsupported(
        message: message,
        hint: "This gesture uses private XCTest event-synthesis APIs; rebuild the runner with a supported Xcode if this persists."
      )
    }
    return .performed
#elseif os(tvOS)
    return .unsupported(
      message: "two-finger gestures are not supported on tvOS",
      hint: "tvOS has no touch input; use remote-driven navigation."
    )
#elseif os(visionOS)
    return .unsupported(
      message: "two-finger touch gestures are not supported on visionOS",
      hint: "The current XCTest synthesizer supports iOS and iPadOS touch simulators only."
    )
#else
    return .unsupported(
      message: "two-finger gestures are not supported on macOS",
      hint: "macOS automation has no multi-touch input; run on an iOS simulator."
    )
#endif
  }

}
