#if os(watchOS)
import XCTest

// The watchOS leaf of the runner: the Digital Crown, the system text input sheet, back, and
// one-finger synthesized gestures. Everything else a watch admits runs the shared paths.
extension RunnerTests {
  /// Crown rotations that scroll about one viewport. Measured on watchOS 27 simulators: half a turn
  /// moved a Settings list by one screen height.
  static let watchCrownRotationsPerViewport = 0.5
  /// How long the input sheet may take to appear after the tap that focuses a field.
  static let watchInputSheetTimeout: TimeInterval = 3.0
  /// The input sheet's commit button. The sheet exposes no identifier for it.
  static let watchInputSheetDoneLabel = "Done"

  /// `scroll` on a watch turns the Digital Crown, the watch's scroll input. The crown is vertical,
  /// so a horizontal scroll is refused; horizontal pages answer `swipe`.
  @MainActor
  func watchCrownScroll(app: XCUIApplication, command: Command, direction: RunnerScrollDirection) throws -> Response {
    guard direction.isVertical else {
      return Response(ok: false, error: ErrorPayload(
        code: "UNSUPPORTED_OPERATION",
        message: "scroll \(direction.rawValue) is not supported on watchOS",
        hint: "The Digital Crown scrolls vertically. Use swipe for horizontal pages."
      ))
    }
    let viewportFraction: Double
    if let pixels = command.pixels {
      let height = try resolvedTouchReferenceFrame(app: app).height
      guard height > 0 else {
        return Response(ok: false, error: ErrorPayload(message: "scroll could not resolve a usable interaction frame"))
      }
      viewportFraction = pixels / Double(height)
    } else if let amount = runnerDragCommandDefaults(command).scrollAmount {
      viewportFraction = amount
    } else {
      return Response(ok: false, error: ErrorPayload(code: "INVALID_ARGS", message: "scroll requires an amount or pixels"))
    }
    let delta = viewportFraction * Self.watchCrownRotationsPerViewport
    let timing = measureGesture {
      withBoundedInteractionIdleTimeoutIfSupported(app, waits: .bothSkipped) {
        XCUIDevice.shared.rotateDigitalCrown(delta: direction == .down ? delta : -delta)
      }
    }
    return gestureResponse(message: "scrolled", timing: timing)
  }

  /// Back on a watch presses the navigation bar's back button, else swipes in from the left edge,
  /// the two ways watchOS pops a navigation stack.
  @MainActor
  func performWatchBack(app: XCUIApplication) throws -> InAppBackOutcome {
    let button = app.buttons[Self.navigationBarBackButtonIdentifier]
    if button.exists, button.isHittable {
      let frame = button.frame
      _ = try tapAt(app: app, x: frame.midX, y: frame.midY)
      return .performed
    }
    let surface = try resolvedTouchReferenceFrame(app: app)
    _ = try dragAt(
      app: app,
      x: surface.minX + 1,
      y: surface.midY,
      x2: surface.minX + surface.width * 0.8,
      y2: surface.midY,
      holdDuration: coordinateDragHoldDuration()
    )
    return .performed
  }

  /// A one-finger planned gesture through the private synthesizer, which keeps the plan's timing. A
  /// watch has no rotation and its app fills the screen, so plan points are digitizer points.
  @MainActor
  func watchSampledPlannedGesture(app: XCUIApplication, plan: RunnerGesturePlan) throws -> RunnerInteractionOutcome {
    guard plan.pointers.count == 1 else {
      return .unsupported(
        message: "multi-touch gestures are not supported on watchOS",
        hint: "watchOS apps have no multi-touch gestures. Use swipe, gesture pan, or scroll."
      )
    }
    let pointerSamples: [[[String: NSNumber]]] = plan.pointers.map { pointer in
      pointer.samples.map { sample in
        [
          "x": NSNumber(value: sample.point.x),
          "y": NSNumber(value: sample.point.y),
          "offsetMs": NSNumber(value: sample.offsetMs),
        ]
      }
    }
    var dispatched: ObjCBool = false
    let failure = RunnerSynthesizedGesture.synthesizeGesture(
      withApplication: app,
      resolvedWindow: app.windows.firstMatch,
      interfaceOrientation: 1,
      pointerSamples: pointerSamples,
      dispatched: &dispatched
    )
    return try Self.synthesizedGestureOutcome(
      failure: failure,
      dispatched: dispatched.boolValue,
      refusalHint: "This gesture uses private XCTest event-synthesis APIs; rebuild the runner with a supported Xcode if this persists."
    )
  }

  /// watchOS edits text in a system input sheet that a field tap opens; the field itself never takes
  /// keyboard focus. Typing goes to the sheet, and Done commits it to the field.
  @MainActor
  func watchTypeCommandResponse(activeApp: XCUIApplication, command: Command, text: String) throws -> Response {
    var point: CGPoint?
    if let x = command.x, let y = command.y {
      if case .unsupported(let message, let hint) = try tapAt(app: activeApp, x: x, y: y) {
        return Response(ok: false, error: ErrorPayload(message: message, hint: hint))
      }
      point = CGPoint(x: x, y: y)
    }
    guard waitForWatchInputSheet(app: activeApp) else {
      let failure = TextEntryFailure.notFocused
      return Response(ok: false, error: ErrorPayload(
        code: failure.rawValue,
        message: failure.message,
        hint: "Press the text field first. On watchOS the field opens a system input sheet, and the text goes there."
      ))
    }
    withBoundedInteractionIdleTimeoutIfSupported(activeApp, waits: .bothSkipped) {
      if resolveTextEntryMode(command) == .replacement {
        let existing = (activeApp.textViews.firstMatch.value as? String) ?? ""
        if !existing.isEmpty {
          activeApp.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
        }
      }
      activeApp.typeText(text)
    }
    let done = activeApp.buttons[Self.watchInputSheetDoneLabel]
    guard done.exists else {
      return Response(ok: false, error: ErrorPayload(
        code: TextEntryFailure.commitNotObserved.rawValue,
        message: "the watchOS input sheet has no Done button to commit the text",
        hint: "The text is typed into the open input sheet. Press its commit button by ref."
      ))
    }
    withBoundedInteractionIdleTimeoutIfSupported(activeApp, waits: .bothSkipped) {
      done.tap()
    }
    return Response(ok: true, data: DataPayload(
      message: "typed",
      x: point.map { Double($0.x) },
      y: point.map { Double($0.y) },
      textEntryRoute: "watch-input-sheet"
    ))
  }

  private func waitForWatchInputSheet(app: XCUIApplication) -> Bool {
    let deadline = Date().addingTimeInterval(Self.watchInputSheetTimeout)
    repeat {
      if app.keyboards.firstMatch.exists { return true }
      RunLoop.current.run(until: Date().addingTimeInterval(TextEntryTiming.pollInterval * 5))
    } while Date() < deadline
    return false
  }
}
#endif
