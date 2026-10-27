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
    guard let context = context ?? synthesizedCoordinateContext(app: app) else {
      return .unsupported(
        message: "synthesized coordinate drag could not resolve an app window with a finite screen frame",
        hint: "Retry after the app is foregrounded, or use a plain screenshot to choose coordinates."
      )
    }
    let frame = context.referenceFrame
    let rotationFrame = synthesizedRotationFrame(fallback: frame, interfaceOrientation: orientation)
    let start = CoordinateSpaceRotation.native(
      point: CGPoint(x: x, y: y),
      in: rotationFrame,
      interfaceOrientation: orientation
    )
    let end = CoordinateSpaceRotation.native(
      point: CGPoint(x: x2, y: y2),
      in: rotationFrame,
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
    context: SynthesizedCoordinateContext? = nil,
    deadline: Date? = nil
  ) -> RunnerInteractionOutcome? {
#if os(iOS)
    guard x.isFinite, y.isFinite else {
      return .unsupported(
        message: "synthesized coordinate tap requires finite coordinates",
        hint: "Retry with finite x and y values."
      )
    }
    let orientation = Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app))
    guard let context = context ?? synthesizedCoordinateContext(app: app) else {
      return .unsupported(
        message: "synthesized coordinate tap could not resolve an app window with a finite screen frame",
        hint: "Retry after the app is foregrounded, or use a plain screenshot to choose coordinates."
      )
    }
    let point = CoordinateSpaceRotation.native(
      point: CGPoint(x: x, y: y),
      in: synthesizedRotationFrame(fallback: context.referenceFrame, interfaceOrientation: orientation),
      interfaceOrientation: orientation
    )
    logSynthesizedDispatch(
      kind: "tap",
      start: point,
      end: nil,
      referenceFrame: context.referenceFrame,
      orientation: orientation
    )
    var message: NSString?
    let status = RunnerSynthesizedGesture.synthesizeTap(
      withApplication: app,
      resolvedWindow: context.resolvedWindow,
      x: Double(point.x),
      y: Double(point.y),
      deadline: deadline,
      errorMessage: &message
    )
    switch status {
    case .succeeded:
      return .performed
    case .deadlineExceeded:
      return nil
    case .failed:
      return .unsupported(
        message: message as String? ?? "private XCTest event synthesis failed",
        hint: "Falling back to XCTest coordinate tap may be slower and can still need a healthy accessibility tree."
      )
    @unknown default:
      return .unsupported(
        message: "private XCTest event synthesis returned an unknown status",
        hint: "Inspect the current app before deciding whether to act again."
      )
    }
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

#if os(iOS)
  /// A long press is one stationary contact held for `durationMs`, synthesized like a tap: it needs
  /// no app tree, so on a tree XCTest cannot serialize it lands through the sole-screen route.
  @MainActor
  func synthesizedLongPressAt(
    app: XCUIApplication,
    x: Double,
    y: Double,
    durationMs: Double,
    context: SynthesizedCoordinateContext?
  ) -> RunnerInteractionOutcome {
    guard x.isFinite, y.isFinite, durationMs.isFinite, durationMs > 0 else {
      return .unsupported(
        message: "synthesized coordinate long press requires finite coordinates and a positive duration",
        hint: "Retry with finite x and y values and a positive durationMs."
      )
    }
    guard let context else {
      return .unsupported(
        message: "synthesized coordinate long press could not resolve an app window with a finite screen frame",
        hint: "Retry after the app is foregrounded, or use a plain screenshot to choose coordinates."
      )
    }
    let orientation = Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app))
    let point = CoordinateSpaceRotation.native(
      point: CGPoint(x: x, y: y),
      in: synthesizedRotationFrame(fallback: context.referenceFrame, interfaceOrientation: orientation),
      interfaceOrientation: orientation
    )
    logSynthesizedDispatch(
      kind: "longPress",
      start: point,
      end: nil,
      referenceFrame: context.referenceFrame,
      orientation: orientation
    )
    let samples: [[String: NSNumber]] = [0, durationMs].map { offsetMs in
      [
        "x": NSNumber(value: Double(point.x)),
        "y": NSNumber(value: Double(point.y)),
        "offsetMs": NSNumber(value: offsetMs),
      ]
    }
    if let message = RunnerSynthesizedGesture.synthesizeGesture(
      withApplication: app,
      resolvedWindow: context.resolvedWindow,
      pointerSamples: [samples]
    ) {
      return .unsupported(
        message: message,
        hint: "Private XCTest event synthesis is required for an AX-free long press on iOS; update Xcode if this persists."
      )
    }
    return .performed
  }
#endif

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

  /// The touch visualization frame of a synthesized gesture, read from its context instead of the
  /// app tree.
  func touchVisualizationFrame(
    x: Double,
    y: Double,
    context: SynthesizedCoordinateContext
  ) -> TouchVisualizationFrame {
    TouchVisualizationFrame(
      x: Double(context.referenceFrame.minX) + x,
      y: Double(context.referenceFrame.minY) + y,
      referenceWidth: Double(context.referenceFrame.width),
      referenceHeight: Double(context.referenceFrame.height)
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

  /// The viewport the portable gesture planner lays pointer paths in: the frame of the synthesized
  /// context its record is routed through, so a tree with no window whose app provably fills its
  /// sole screen plans on that screen, the same route a synthesized tap or scroll takes.
  @MainActor
  func gestureViewportFrame(app: XCUIApplication) -> CGRect {
#if os(iOS)
    guard let context = synthesizedCoordinateContext(app: app) else {
      return frameAvoidingKeyboard(app: app, frame: app.frame)
    }
    // The sole-screen route means the windows query just failed, so a keyboard probe would too.
    return context.resolvedWindow == nil
      ? context.referenceFrame
      : frameAvoidingKeyboard(app: app, frame: context.referenceFrame)
#else
    return resolvedTouchReferenceFrame(app: app, appFrame: app.frame)
#endif
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
    let context = context ?? synthesizedCoordinateContext(app: app)
    guard x.isFinite, y.isFinite, x2.isFinite, y2.isFinite,
      let context
    else {
      return nil
    }
    let points = context.allowsKeyboardProbe
      ? keyboardAvoidingDragPoints(app: app, x: x, y: y, x2: x2, y2: y2)
      : DragPoints(x: x, y: y, x2: x2, y2: y2)
    return SynthesizedDragPlan(
      points: points,
      context: context
    )
#else
    return nil
#endif
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
    windowQueryRejected: Bool = false
  ) -> SynthesizedCoordinateContext? {
#if os(iOS)
    var health = mainOwned.accessibilityHealth
    let window: XCUIElement?
    let referenceFrame: CGRect
    // A tree that just rejected a query skips the windows query only where the sole screen answers
    // without it; anywhere else that query is still the only route.
    let rejectedTreeSoleScreenFrame = windowQueryRejected ? soleScreenReferenceFrame(app: app) : nil
    if rejectedTreeSoleScreenFrame == nil, let resolved = resolveRunnerWindowElement(app: app) {
      window = resolved.window
      referenceFrame = resolved.frame
    } else if let soleScreenFrame = rejectedTreeSoleScreenFrame ?? soleScreenReferenceFrame(app: app) {
      window = nil
      referenceFrame = soleScreenFrame
      // The windows query just failed on this tree, so this gesture's keyboard probes and XCTest
      // fallbacks would fail on it too, after XCTest's own retries.
      health = .unavailable
    } else {
      return nil
    }
    guard referenceFrame.width.isFinite, referenceFrame.height.isFinite,
      referenceFrame.width > 0, referenceFrame.height > 0
    else {
      return nil
    }
    return SynthesizedCoordinateContext(
      referenceFrame: referenceFrame,
      resolvedWindow: window,
      accessibilityHealth: health
    )
#else
    return nil
#endif
  }


#if os(iOS)
  /// The reference frame of the sole-screen route, read without the app's accessibility tree: when
  /// the app provably fills the device's only screen, its window is that screen. A deep app tree
  /// makes the windows query fail with `kAXErrorIllegalArgument`, and without this route every
  /// synthesized tap and scroll on such a screen failed even though synthesis itself needs no tree.
  /// `RunnerResolveSoleScreen` owns which devices prove that — an iPhone always, an iPad only while
  /// the app fills the screen — so this reads the same answer the record's routing takes, and
  /// anything else (a windowed iPad, a multi-screen foldable) keeps requiring a window.
  @MainActor
  func soleScreenReferenceFrame(app: XCUIApplication) -> CGRect? {
    var resolvedScreen: AnyObject?
    var resolvedDisplayID: UInt = 0
    guard RunnerResolveSoleScreen(app, &resolvedScreen, &resolvedDisplayID) == nil else {
      return nil
    }
    let frame = soleDisplayFrame(
      interfaceOrientation: Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app))
    )
    NSLog(
      "AGENT_DEVICE_RUNNER_SYNTHESIZED_SOLE_SCREEN_ROUTE resolved=%@",
      frame.map { NSCoder.string(for: $0) } ?? "none"
    )
    return frame
  }

  /// The box a synthesized turn swaps side lengths about. The digitizer turns about its display, so a
  /// placed iPad window's smaller box is not the basis (#3899); a multi-screen host keeps the
  /// resolved window, which names its panel (ADR 0025).
  func synthesizedRotationFrame(fallback: CGRect, interfaceOrientation: Int) -> CGRect {
    soleDisplayFrame(interfaceOrientation: interfaceOrientation) ?? fallback
  }

  private func soleDisplayFrame(interfaceOrientation: Int) -> CGRect? {
    guard XCUIScreen.screens.count == 1 else { return nil }
    let screen = UIScreen.main
    let scale = screen.nativeScale
    guard scale > 0 else { return nil }
    return Self.soleScreenReferenceFrame(
      nativePortraitSize: CGSize(
        width: screen.nativeBounds.width / scale,
        height: screen.nativeBounds.height / scale
      ),
      interfaceOrientation: interfaceOrientation
    )
  }
#endif

  /// The screen in the app's interface orientation, anchored at the origin like a window frame. An
  /// unknown orientation cannot say which way to lay the screen, so it names no frame.
  static func soleScreenReferenceFrame(
    nativePortraitSize size: CGSize,
    interfaceOrientation: Int
  ) -> CGRect? {
    guard size.width > 0, size.height > 0 else { return nil }
    switch interfaceOrientation {
    case RunnerInterfaceOrientation.portrait, RunnerInterfaceOrientation.portraitUpsideDown:
      return CGRect(origin: .zero, size: size)
    case RunnerInterfaceOrientation.landscapeLeft, RunnerInterfaceOrientation.landscapeRight:
      return CGRect(x: 0, y: 0, width: size.height, height: size.width)
    default:
      return nil
    }
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
    guard plan.topology == "single" || plan.topology == "multi" else {
      return "planned gesture topology must be single or multi"
    }
    let isTap = plan.topology == "multi" && plan.intent == "tap"
    let supportedIntent = plan.topology == "single"
      ? plan.intent == "fling" || plan.intent == "pan"
      : isTap || plan.intent == "pan" || plan.intent == "pinch" || plan.intent == "rotate"
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
    let pointerCountMatches = plan.topology == "single"
      ? plan.pointers.count == 1
      : isTap
        ? (2...runnerGestureMaxContacts).contains(plan.pointers.count)
        : plan.pointers.count == 2
    guard pointerCountMatches else {
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
    if isTap {
      return plannedTapValidationError(plan)
    }
    if plan.topology == "multi" {
      guard let firstStart = firstSamples.first?.point,
        let secondStart = plan.pointers[1].samples.first?.point,
        hypot(firstStart.x - secondStart.x, firstStart.y - secondStart.y) > 0
      else {
        return "planned pointer paths require a positive initial span"
      }
    }
    return nil
  }

  /// Tap contacts stay where they land, and two contacts on one point would merge into one touch.
  private func plannedTapValidationError(_ plan: RunnerGesturePlan) -> String? {
    var starts: [(x: Double, y: Double)] = []
    for pointer in plan.pointers {
      guard let start = pointer.samples.first?.point else {
        return "planned pointer paths require at least two samples"
      }
      for sample in pointer.samples where sample.point.x != start.x || sample.point.y != start.y {
        return "planned tap contacts must not move"
      }
      if starts.contains(where: { $0.x == start.x && $0.y == start.y }) {
        return "planned tap contacts must start on distinct points"
      }
      starts.append((x: start.x, y: start.y))
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
    let rotationFrame = synthesizedRotationFrame(fallback: frame, interfaceOrientation: orientation)
    let pointerSamples: [[[String: NSNumber]]] = plan.pointers.map { pointer in
      pointer.samples.map { sample in
        let point = CoordinateSpaceRotation.native(
          point: CGPoint(x: sample.point.x, y: sample.point.y),
          in: rotationFrame,
          interfaceOrientation: orientation
        )
        return [
          "x": NSNumber(value: Double(point.x)),
          "y": NSNumber(value: Double(point.y)),
          "offsetMs": NSNumber(value: sample.offsetMs),
        ]
      }
    }
    let resolvedWindow = resolveRunnerWindowElement(app: app)?.window
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
      message: "multi-touch gestures are not supported on tvOS",
      hint: "tvOS has no touch input; use remote-driven navigation."
    )
#elseif os(visionOS)
    return .unsupported(
      message: "multi-touch gestures are not supported on visionOS",
      hint: "The current XCTest synthesizer supports iOS and iPadOS touch simulators only."
    )
#else
    return .unsupported(
      message: "multi-touch gestures are not supported on macOS",
      hint: "macOS automation has no multi-touch input; run on an iOS simulator."
    )
#endif
  }

}
