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
  /// How long a back-button press may take to change the navigation bar before it is unconfirmed.
  static let watchBackConfirmationTimeout: TimeInterval = 1.0
  /// How long a crown scroll waits for its deceleration. A tap sent while the list still moves is
  /// absorbed by the scroll view instead of reaching its target.
  static let watchCrownSettleInterval: TimeInterval = 0.35

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
    RunLoop.current.run(until: Date().addingTimeInterval(Self.watchCrownSettleInterval))
    return gestureResponse(message: "scrolled", timing: timing)
  }

  /// Back on a watch presses the navigation bar's back button. watchOS pops a stack by edge swipe
  /// only while that button is shown, so a screen without one has nothing back can do, and nothing
  /// is sent.
  @MainActor
  func performWatchBack(app: XCUIApplication) throws -> InAppBackOutcome {
    // A push transition can briefly show two back buttons; only an unambiguous one is pressed.
    let buttons = app.buttons.matching(identifier: Self.navigationBarBackButtonIdentifier).allElementsBoundByIndex
    guard buttons.count == 1, let button = buttons.first, button.isHittable else {
      return .refused(ErrorPayload(
        code: RunnerWireErrorCode.backSwipeNotDispatched,
        message: "This screen has no navigation back button.",
        hint: "A root screen has nothing to go back to. Otherwise press the screen's close control by its ref from a fresh snapshot."
      ))
    }
    let before = watchNavigationBarIdentity(app: app)
    let frame = button.frame
    switch try tapAt(app: app, x: frame.midX, y: frame.midY) {
    case .performed:
      break
    case .unsupported(let message, let hint), .notDispatched(let message, let hint):
      return .refused(ErrorPayload(code: RunnerWireErrorCode.backSwipeNotDispatched, message: message, hint: hint))
    }
    // A pop changes the navigation bar: its title, or the back button leaves at the root.
    let popped = watchPoll(timeout: Self.watchBackConfirmationTimeout) {
      guard let before, let after = watchNavigationBarIdentity(app: app) else { return false }
      return after != before
    }
    if popped { return .performed }
    return .unconfirmed(ErrorPayload(
      code: RunnerWireErrorCode.backSwipeUnverified,
      message: "back pressed the navigation bar back button, but the navigation bar did not change within 1 s. This is an unknown outcome.",
      hint: "Take a snapshot to see where the app is."
    ))
  }

  /// The navigation bars' identities and the back button's presence, read from one snapshot so a
  /// vanishing element cannot record an XCTest failure. Free text is left out, so a ticking clock or
  /// timer cannot read as a pop. `nil` when the tree cannot be read.
  private func watchNavigationBarIdentity(app: XCUIApplication) -> [String]? {
    guard let root = try? app.snapshot() else { return nil }
    var identity: [String] = []
    func visit(_ node: any XCUIElementSnapshot) {
      if node.elementType == .navigationBar {
        identity.append("bar|\(node.identifier)|\(node.label)")
      } else if node.identifier == Self.navigationBarBackButtonIdentifier {
        identity.append("back")
      }
      node.children.forEach(visit)
    }
    visit(root)
    return identity
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
    guard let resolved = resolveRunnerWindowElement(app: app) else {
      return .notDispatched(message: "gesture could not resolve the app window", hint: nil)
    }
    if plan.contactOrigin == runnerScreenEdgeContactOrigin,
      let first = plan.pointers[0].samples.first,
      let last = plan.pointers[0].samples.last
    {
      // watchOS starts an edge swipe (back) only from a touch on the screen edge itself, and only
      // a drag with real travel time; a short synthesized path is read as a tap on a row.
      let edgeX = first.point.x < Double(resolved.frame.midX)
        ? Double(resolved.frame.minX) + 1
        : Double(resolved.frame.maxX) - 1
      // The coordinate drag would otherwise wait for the app to idle first, which an animating
      // screen never does inside the command's watchdog.
      var outcome: Result<RunnerInteractionOutcome, Error> = .success(.performed)
      withBoundedInteractionIdleTimeoutIfSupported(app, waits: .bothSkipped) {
        outcome = Result {
          try dragAt(
            app: app,
            x: edgeX,
            y: first.point.y,
            x2: last.point.x,
            y2: last.point.y,
            holdDuration: coordinateDragHoldDuration()
          )
        }
      }
      return try outcome.get()
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
    return try dispatchSynthesizedPointerSamples(
      app: app, window: resolved.window, orientation: 1, pointerSamples: pointerSamples
    )
  }

  /// watchOS edits text in a system input sheet that a field tap opens; the field itself never takes
  /// keyboard focus. Typing goes to the sheet, and Done commits it to the field.
  @MainActor
  func watchTypeCommandResponse(activeApp: XCUIApplication, command: Command, text: String) throws -> Response {
    var point: CGPoint?
    if let x = command.x, let y = command.y {
      switch try tapAt(app: activeApp, x: x, y: y) {
      case .performed:
        break
      case .unsupported(let message, let hint), .notDispatched(let message, let hint):
        return Response(ok: false, error: ErrorPayload(message: message, hint: hint))
      }
      point = CGPoint(x: x, y: y)
    }
    guard watchPoll(timeout: Self.watchInputSheetTimeout, until: { activeApp.keyboards.firstMatch.exists }) else {
      let failure = TextEntryFailure.notFocused
      return Response(ok: false, error: ErrorPayload(
        code: failure.rawValue,
        message: failure.message,
        hint: "Press the text field first. On watchOS the field opens a system input sheet, and the text goes there."
      ))
    }
    withBoundedInteractionIdleTimeoutIfSupported(activeApp, waits: .bothSkipped) {
      let sheetText = activeApp.textViews.firstMatch
      if resolveTextEntryMode(command) == .replacement, sheetText.exists {
        let existing = (sheetText.value as? String) ?? ""
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
    guard watchPoll(timeout: Self.watchInputSheetTimeout, until: { !activeApp.keyboards.firstMatch.exists }) else {
      return Response(ok: false, error: ErrorPayload(
        code: TextEntryFailure.commitNotObserved.rawValue,
        message: "the watchOS input sheet stayed open after Done",
        hint: "Check the screen with snapshot; the text may still be in the open input sheet."
      ))
    }
    return Response(ok: true, data: DataPayload(
      message: "typed",
      x: point.map { Double($0.x) },
      y: point.map { Double($0.y) },
      textEntryRoute: "watch-input-sheet"
    ))
  }

  /// Polls `condition` on the main run loop until it holds or `timeout` passes.
  private func watchPoll(timeout: TimeInterval, until condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if condition() { return true }
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    } while Date() < deadline
    return false
  }
}
#endif
