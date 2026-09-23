import XCTest

extension RunnerTests {
  // MARK: - Sequence command

  /// Hard cap mirrored from the daemon (MAX_RUNNER_SEQUENCE_STEPS). Keeps the worst-case
  /// retained journal response well under the 16KB cap and bounds the lost-response window.
  var maxSequenceSteps: Int { 20 }

  /// Allowlisted step kinds. Validated on both sides so an unsupported kind is rejected with a
  /// clear INVALID_ARGS naming the step index, executing nothing.
  private var sequenceableStepKinds: Set<String> { ["tap", "doubleTap", "longPress"] }

  /// Per-step outcome carried by `assembleSequenceExecution`. The timing is captured by the
  /// executor closure (via performGesture) so ordering/stop-on-failure stay device-free testable.
  struct SequenceStepOutcome {
    let outcome: RunnerInteractionOutcome
    let gestureStartUptimeMs: Double
    let gestureEndUptimeMs: Double
  }

  func executeSequence(command: Command, activeApp: XCUIApplication) -> Response {
    guard let steps = command.steps, !steps.isEmpty else {
      return sequenceInvalidArgs("sequence requires at least one step")
    }
    guard steps.count <= maxSequenceSteps else {
      return sequenceInvalidArgs(
        "sequence accepts at most \(maxSequenceSteps) steps, received \(steps.count)"
      )
    }
    for (index, step) in steps.enumerated() {
      if let error = validateSequenceStep(step, index: index) {
        return error
      }
    }

    // Touch frame resolves from the first step's coords so recording-gestures works unchanged.
    let firstStep = steps[0]
    let firstFrame = (firstStep.x != nil && firstStep.y != nil)
      ? resolvedTouchVisualizationFrame(app: activeApp, x: firstStep.x!, y: firstStep.y!)
      : nil

    let synthesizedContext = synthesizedSequenceCoordinateContext(steps: steps, app: activeApp)

    let execution = assembleSequenceExecution(steps: steps) { _, step in
      performSequenceStep(step, activeApp: activeApp, synthesizedContext: synthesizedContext)
    }
    return sequenceResponse(execution: execution, touchFrame: firstFrame)
  }

  /// Pure, device-free assembler: runs each step in order via `perform`, stops at the first
  /// `.unsupported` outcome, and assembles the DataPayload (completedSteps, optional
  /// failedStepIndex, per-step results, top-level gesture timing spanning first..last executed).
  /// Steps after the failed index are never invoked and produce no result entries, so
  /// results.count == completedSteps + (failedStepIndex != nil ? 1 : 0).
  func assembleSequenceExecution(
    steps: [SequenceStep],
    perform: (Int, SequenceStep) -> SequenceStepOutcome
  ) -> SequenceExecutionResult {
    var results: [SequenceStepResult] = []
    var completedSteps = 0
    var failedStepIndex: Int?
    var gestureStartUptimeMs: Double?
    var gestureEndUptimeMs: Double?

    for (index, step) in steps.enumerated() {
      let stepOutcome = perform(index, step)
      if gestureStartUptimeMs == nil {
        gestureStartUptimeMs = stepOutcome.gestureStartUptimeMs
      }
      gestureEndUptimeMs = stepOutcome.gestureEndUptimeMs

      switch stepOutcome.outcome {
      case .performed:
        results.append(
          SequenceStepResult(
            ok: true,
            kind: step.kind,
            errorCode: nil,
            errorMessage: nil,
            gestureStartUptimeMs: stepOutcome.gestureStartUptimeMs,
            gestureEndUptimeMs: stepOutcome.gestureEndUptimeMs
          )
        )
        completedSteps += 1
      case .unsupported(let message, _):
        results.append(
          SequenceStepResult(
            ok: false,
            kind: step.kind,
            errorCode: "UNSUPPORTED_OPERATION",
            errorMessage: message,
            gestureStartUptimeMs: stepOutcome.gestureStartUptimeMs,
            gestureEndUptimeMs: stepOutcome.gestureEndUptimeMs
          )
        )
        failedStepIndex = index
        return SequenceExecutionResult(
          results: results,
          completedSteps: completedSteps,
          failedStepIndex: failedStepIndex,
          gestureStartUptimeMs: gestureStartUptimeMs,
          gestureEndUptimeMs: gestureEndUptimeMs
        )
      }
    }

    return SequenceExecutionResult(
      results: results,
      completedSteps: completedSteps,
      failedStepIndex: nil,
      gestureStartUptimeMs: gestureStartUptimeMs,
      gestureEndUptimeMs: gestureEndUptimeMs
    )
  }

  struct SequenceExecutionResult {
    let results: [SequenceStepResult]
    let completedSteps: Int
    let failedStepIndex: Int?
    let gestureStartUptimeMs: Double?
    let gestureEndUptimeMs: Double?
  }

  // MARK: - Step validation / execution

  private func validateSequenceStep(_ step: SequenceStep, index: Int) -> Response? {
    guard sequenceableStepKinds.contains(step.kind) else {
      return sequenceInvalidArgs(
        "sequence step \(index) has unsupported kind \"\(step.kind)\"; allowed: tap, doubleTap, longPress"
      )
    }
    guard let x = step.x, let y = step.y, x.isFinite, y.isFinite else {
      return sequenceInvalidArgs("sequence step \(index) (\(step.kind)) requires finite x and y")
    }
    return nil
  }

  private func performSequenceStep(
    _ step: SequenceStep,
    activeApp: XCUIApplication,
    synthesizedContext: SynthesizedCoordinateContext? = nil
  ) -> SequenceStepOutcome {
    let x = step.x ?? 0
    let y = step.y ?? 0
    // Synthesized HID tap fast path mirrors the individual `tap` command (idleTimeout:false, with
    // a tapAt fallback when synthesis is unsupported), so fusing a jittered tap series does not
    // change the touch mechanism for these inputs.
    if step.kind == "tap", step.synthesized == true {
      let policyKind = SynthesizedGesturePolicyKind.synthesizedDrag
#if os(iOS)
      guard let synthesizedContext else {
        let nowMs = ProcessInfo.processInfo.systemUptime * 1000
        logSynthesizedGesturePolicyDecision(kind: policyKind, context: nil, fallbackAttempted: false)
        return SequenceStepOutcome(
          outcome: .unsupported(
            message: "synthesized coordinate tap could not resolve a finite coordinate frame",
            hint: "Retry after the app is foregrounded, or use a plain screenshot to choose coordinates."
          ),
          gestureStartUptimeMs: nowMs,
          gestureEndUptimeMs: nowMs
        )
      }
#endif
      let (timing, outcome) = performGesture(activeApp, idleTimeout: false) {
        synthesizedTapAt(app: activeApp, x: x, y: y, context: synthesizedContext)
      }
      if case .performed = outcome {
        logSynthesizedGesturePolicyDecision(kind: policyKind, context: synthesizedContext, fallbackAttempted: false)
        if let pauseMs = step.pauseMs, pauseMs > 0 {
          sleepFor(min(max(pauseMs, 0), 10000) / 1000.0)
        }
        return SequenceStepOutcome(
          outcome: outcome,
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs
        )
      }
#if os(iOS)
      guard synthesizedContext.allowsXCTestCoordinateFallback else {
        logSynthesizedGesturePolicyDecision(kind: policyKind, context: synthesizedContext, fallbackAttempted: false)
        return SequenceStepOutcome(
          outcome: outcome,
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs
        )
      }
      logSynthesizedGesturePolicyDecision(kind: policyKind, context: synthesizedContext, fallbackAttempted: true)
#endif
      // Synthesis unsupported (e.g. macOS) — fall through to the drag-based tapAt below.
    }
    let (timing, outcome) = performGesture(activeApp) {
      switch step.kind {
      case "doubleTap":
        // doubleTapAt per step, matching the behavior of the retired tapSeries doubleTap path.
        return doubleTapAt(app: activeApp, x: x, y: y)
      case "longPress":
        let duration = min(max(step.durationMs ?? 800, 16), 10000) / 1000.0
        return longPressAt(app: activeApp, x: x, y: y, duration: duration)
      default:
        return tapAt(app: activeApp, x: x, y: y)
      }
    }
    // Sleep AFTER the step — pauseMs is the inter-step gap — but only when the step performed.
    // assembleSequenceExecution stops at the first unsupported outcome, so pausing after a failed
    // step would burn up to 10s of watchdog budget with no following step to separate from.
    if case .performed = outcome, let pauseMs = step.pauseMs, pauseMs > 0 {
      sleepFor(min(max(pauseMs, 0), 10000) / 1000.0)
    }
    return SequenceStepOutcome(
      outcome: outcome,
      gestureStartUptimeMs: timing.gestureStartUptimeMs,
      gestureEndUptimeMs: timing.gestureEndUptimeMs
    )
  }

  private func sequenceResponse(
    execution: SequenceExecutionResult,
    touchFrame: TouchVisualizationFrame?
  ) -> Response {
    return Response(
      ok: true,
      data: DataPayload(
        message: "sequence",
        gestureStartUptimeMs: execution.gestureStartUptimeMs,
        gestureEndUptimeMs: execution.gestureEndUptimeMs,
        x: touchFrame?.x,
        y: touchFrame?.y,
        referenceWidth: touchFrame?.referenceWidth,
        referenceHeight: touchFrame?.referenceHeight,
        completedSteps: execution.completedSteps,
        failedStepIndex: execution.failedStepIndex,
        sequenceResults: execution.results
      )
    )
  }

  private func sequenceInvalidArgs(_ message: String) -> Response {
    Response(ok: false, error: ErrorPayload(code: "INVALID_ARGS", message: message))
  }
}
