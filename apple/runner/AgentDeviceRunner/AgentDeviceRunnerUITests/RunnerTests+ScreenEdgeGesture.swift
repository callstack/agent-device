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
    // The coordinate context books a foldable's lit-panel window and keeps its typed refusal.
    let planned: NativePlannedGesture
    switch try nativePlannedGesture(app: app, plan: plan, gesture: "edge swipe") {
    case .resolved(let resolved): planned = resolved
    case .refused(let outcome): return outcome
    }
    guard let portraitSize = edgeTouchDisplayPortraitSize(), let samples = planned.pointerSamples.first else {
      return Self.unmeasuredSoleDisplayOutcome(gesture: "edge swipe")
    }
    if let message = RunnerSimulatorEdgeTouch.dispatch(
      withApplication: app,
      resolvedWindow: planned.context.resolvedWindow,
      samples: samples,
      screenSize: portraitSize
    ) {
      return .unsupported(
        message: message,
        hint: "Retry after the app is foregrounded on a simulator display with a touchscreen."
      )
    }
    return .performed
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
