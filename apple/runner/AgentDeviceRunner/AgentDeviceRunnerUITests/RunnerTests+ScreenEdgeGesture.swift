import XCTest

/// The plan value for a contact that starts as a screen-edge touch. Mirrors
/// `GestureContactOrigin` in packages/contracts/src/gesture-plan-types.ts.
let runnerScreenEdgeContactOrigin = "screen-edge"

extension RunnerTests {
#if os(iOS) && targetEnvironment(simulator)
  /// Dispatches a screen-edge plan as one HID touch with the digitizer edge mask. XCTest
  /// synthesized touches never carry that mask, so UIKit edge recognizers ignore them.
  @MainActor
  func screenEdgePlannedGesture(
    app: XCUIApplication,
    plan: RunnerGesturePlan
  ) throws -> RunnerInteractionOutcome {
    switch try dispatchScreenEdgeTouch(app: app, plan: plan) {
    case .sent:
      return .performed
    case .notSent(let message, let hint), .interrupted(let message, let hint):
      return .unsupported(message: message, hint: hint)
    }
  }

  /// The edge touch and whether it reached the device: every refusal before touch-down is `.notSent`.
  @MainActor
  private func dispatchScreenEdgeTouch(app: XCUIApplication, plan: RunnerGesturePlan) throws -> TouchDispatch {
    switch try prepareScreenEdgeTouch(app: app, plan: plan) {
    case .ready(let dispatch): return try dispatch()
    case .notSent(let message, let hint): return .notSent(message: message, hint: hint)
    }
  }

  /// Resolves an edge touch up to its contact: the plan's samples, the display, and its touchscreen
  /// sender. The returned dispatch runs only the contact.
  @MainActor
  private func prepareScreenEdgeTouch(app: XCUIApplication, plan: RunnerGesturePlan) throws -> PreparedTouch {
    // The coordinate context books a foldable's lit-panel window and keeps its typed refusal.
    let planned: NativePlannedGesture
    switch try nativePlannedGesture(app: app, plan: plan, gesture: "edge swipe") {
    case .resolved(let resolved): planned = resolved
    case .refused(let outcome): return PreparedTouch(notSent: outcome)
    }
    guard let portraitSize = edgeTouchDisplayPortraitSize(), let samples = planned.pointerSamples.first else {
      return PreparedTouch(notSent: Self.unmeasuredSoleDisplayOutcome(gesture: "edge swipe"))
    }
    let hint = "Retry after the app is foregrounded on a simulator display with a touchscreen."
    var failure: NSString?
    guard let touch = RunnerSimulatorEdgeTouch.prepare(
      application: app,
      resolvedWindow: planned.context.resolvedWindow,
      failure: &failure
    ) else {
      return .notSent(message: (failure as String?) ?? "the edge touch could not be prepared", hint: hint)
    }
    return .ready {
      var touchDown: ObjCBool = false
      guard let message = touch.dispatch(samples: samples, screenSize: portraitSize, touchDown: &touchDown) else {
        return .sent
      }
      return touchDown.boolValue
        ? .interrupted(message: message, hint: hint)
        : .notSent(message: message, hint: hint)
    }
  }

  /// The left-edge back swipe at `backSwipeEndpoints`, as one edge-masked touch, resolved up to its
  /// contact.
  @MainActor
  func prepareScreenEdgeBackSwipe(app: XCUIApplication, surface: CGRect) throws -> PreparedTouch {
    let (start, end) = Self.backSwipeEndpoints(in: surface)
    return try prepareScreenEdgeTouch(app: app, plan: Self.backFlingPlan(
      from: start,
      to: end,
      durationMs: Self.backSwipeDurationMs,
      across: surface,
      contactOrigin: runnerScreenEdgeContactOrigin
    ))
  }

  /// The portrait size of the display that hosts the app: the request's lit panel on a foldable,
  /// whose sides swap with the window's turn, else the sole screen.
  @MainActor
  private func edgeTouchDisplayPortraitSize() -> CGSize? {
    guard let panel = requestLitPanel else { return soleDisplayPortraitSize() }
    return CGSize(width: min(panel.widthPt, panel.heightPt), height: max(panel.widthPt, panel.heightPt))
  }
#endif
}
