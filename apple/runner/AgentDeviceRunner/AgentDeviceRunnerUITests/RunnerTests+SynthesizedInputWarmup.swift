import XCTest

// One-time warm-up of the private XCTest synthesized-input pipeline.
//
// XCTest attaches its HID digitizer to the system lazily, on the first synthesized event a runner
// process posts. On a warm host that attach is immediate; on a cold or loaded simulator it can lag
// several seconds behind the synthesizeWithError call that triggered it. When the first synthesized
// gesture of a process is a *timed* one (a drag with an activation hold, a paced pan), the touch-down
// then lands seconds into a window whose later samples were scheduled relative to the intended
// touch-down, so the gesture the app reconstructs is malformed even though synthesizeWithError
// reported success. Once the digitizer is attached, every later synthesized gesture in the process —
// including after a target relaunch — lands on schedule.
//
// Absorbing that first-attach latency with a throwaway synthesized contact, before the first real
// gesture runs, keeps the real gesture's timing intact. This is not tolerance widening: the gesture's
// own timings are unchanged; the warm-up only moves the unavoidable one-time attach cost off the
// first user gesture. It is a no-op on a warm host (the attach it forces has already happened).

extension RunnerTests {
  /// Whether the synthesized-input pipeline still needs its one-time warm-up. Pure so the
  /// once-per-process contract is testable without a live pipeline.
  func shouldWarmSynthesizedInput(alreadyWarmed: Bool) -> Bool {
    !alreadyWarmed
  }

  /// The throwaway warm-up contact point: the top-center of the touch reference frame, in the
  /// status-bar band. The digitizer attaches on the first synthesis regardless of where the contact
  /// lands, so the point is chosen to be inert — the status-bar band does not forward touches to app
  /// content — rather than meaningful. Returns nil when the frame is unusable.
  func synthesizedInputWarmupPoint(referenceFrame: CGRect) -> CGPoint? {
    guard referenceFrame.width > 0, referenceFrame.height > 0 else { return nil }
    return CGPoint(x: referenceFrame.midX, y: referenceFrame.minY + 1)
  }

  /// Best-effort: force the HID digitizer attach once per runner process, before the first real
  /// synthesized gesture. Never fails the caller — a warm-up that cannot resolve a frame or that the
  /// synthesizer refuses leaves the flag set (a real gesture would hit the same condition) so the
  /// warm-up is not retried on every gesture.
  func ensureSynthesizedInputWarmed(app: XCUIApplication) {
#if os(iOS)
    guard shouldWarmSynthesizedInput(alreadyWarmed: didWarmSynthesizedInput) else { return }
    didWarmSynthesizedInput = true
    let frame = resolvedTouchReferenceFrame(app: app, appFrame: app.frame)
    guard let point = synthesizedInputWarmupPoint(referenceFrame: frame) else {
      NSLog("AGENT_DEVICE_RUNNER_SYNTHESIZED_INPUT_WARMUP outcome=skipped reason=no_reference_frame")
      return
    }
    let startedAt = ProcessInfo.processInfo.systemUptime
    let outcome = synthesizedTapAt(app: app, x: Double(point.x), y: Double(point.y))
    let elapsedMs = (ProcessInfo.processInfo.systemUptime - startedAt) * 1000
    switch outcome {
    case .performed:
      NSLog("AGENT_DEVICE_RUNNER_SYNTHESIZED_INPUT_WARMUP outcome=performed elapsedMs=%.0f", elapsedMs)
    case .unsupported(let message, _):
      NSLog(
        "AGENT_DEVICE_RUNNER_SYNTHESIZED_INPUT_WARMUP outcome=unsupported elapsedMs=%.0f detail=%@",
        elapsedMs,
        message
      )
    }
#endif
  }
}
