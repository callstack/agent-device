import XCTest

extension RunnerTests {
  // MARK: - Sequence command

  /// Hard cap mirrored from the daemon (MAX_RUNNER_SEQUENCE_STEPS). Keeps the worst-case
  /// retained journal response well under the 16KB cap and bounds the lost-response window.
  var maxSequenceSteps: Int { 20 }

  /// Allowlisted step kinds. Validated on both sides so an unsupported kind is rejected with a
  /// clear INVALID_ARGS naming the step index, executing nothing.
  private var sequenceableStepKinds: Set<String> { ["tap", "doubleTap", "longPress", "drag"] }

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

    let execution = assembleSequenceExecution(steps: steps) { _, step in
      performSequenceStep(step, activeApp: activeApp)
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
        "sequence step \(index) has unsupported kind \"\(step.kind)\"; allowed: tap, doubleTap, longPress, drag"
      )
    }
    guard let x = step.x, let y = step.y, x.isFinite, y.isFinite else {
      return sequenceInvalidArgs("sequence step \(index) (\(step.kind)) requires finite x and y")
    }
    if step.kind == "drag" {
      guard let x2 = step.x2, let y2 = step.y2, x2.isFinite, y2.isFinite else {
        return sequenceInvalidArgs("sequence step \(index) (drag) requires finite x2 and y2")
      }
    }
    return nil
  }

  private func performSequenceStep(
    _ step: SequenceStep,
    activeApp: XCUIApplication
  ) -> SequenceStepOutcome {
    let x = step.x ?? 0
    let y = step.y ?? 0
    // Synthesized HID tap fast path mirrors the individual `tap` command (idleTimeout:false, with
    // a tapAt fallback when synthesis is unsupported), so fusing a jittered tap series does not
    // change the touch mechanism for these inputs.
    if step.kind == "tap", step.synthesized == true {
      let (timing, outcome) = performGesture(activeApp, idleTimeout: false) {
        synthesizedTapAt(app: activeApp, x: x, y: y)
      }
      if case .performed = outcome {
        if let pauseMs = step.pauseMs, pauseMs > 0 {
          sleepFor(min(max(pauseMs, 0), 10000) / 1000.0)
        }
        return SequenceStepOutcome(
          outcome: outcome,
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs
        )
      }
      // Synthesis unsupported (e.g. macOS) — fall through to the drag-based tapAt below.
    }
    if step.kind == "drag", step.synthesized == true {
      let dragPoints = keyboardAvoidingDragPoints(
        app: activeApp, x: x, y: y, x2: step.x2 ?? x, y2: step.y2 ?? y)
      let durationMs = min(max(step.durationMs ?? 250, 16), 10000)
      let (timing, outcome) = performGesture(activeApp, idleTimeout: false) {
        synthesizedDragAt(
          app: activeApp,
          x: dragPoints.x,
          y: dragPoints.y,
          x2: dragPoints.x2,
          y2: dragPoints.y2,
          durationMs: durationMs
        )
      }
      if case .performed = outcome {
        if let pauseMs = step.pauseMs, pauseMs > 0 {
          sleepFor(min(max(pauseMs, 0), 10000) / 1000.0)
        }
        return SequenceStepOutcome(
          outcome: outcome,
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs
        )
      }
      let fallbackHoldDuration = synthesizedSwipeFallbackHoldDuration(durationMs: step.durationMs ?? 250)
      let (fallbackTiming, fallbackOutcome) = performGesture(activeApp) {
        dragAt(
          app: activeApp,
          x: dragPoints.x,
          y: dragPoints.y,
          x2: dragPoints.x2,
          y2: dragPoints.y2,
          holdDuration: fallbackHoldDuration
        )
      }
      if case .performed = fallbackOutcome, let pauseMs = step.pauseMs, pauseMs > 0 {
        sleepFor(min(max(pauseMs, 0), 10000) / 1000.0)
      }
      return SequenceStepOutcome(
        outcome: fallbackOutcome,
        gestureStartUptimeMs: fallbackTiming.gestureStartUptimeMs,
        gestureEndUptimeMs: fallbackTiming.gestureEndUptimeMs
      )
    }
    let (timing, outcome) = performGesture(activeApp) {
      switch step.kind {
      case "doubleTap":
        // doubleTapAt per step, matching the behavior of the retired tapSeries doubleTap path.
        return doubleTapAt(app: activeApp, x: x, y: y)
      case "longPress":
        let duration = min(max(step.durationMs ?? 800, 16), 10000) / 1000.0
        return longPressAt(app: activeApp, x: x, y: y, duration: duration)
      case "drag":
        // Route through keyboardAvoidingDragPoints for parity with the individual `.drag` command.
        // The non-synthesized coordinate-drag path ignores durationMs, matching that command's
        // non-synthesized branch.
        let dragPoints = keyboardAvoidingDragPoints(
          app: activeApp, x: x, y: y, x2: step.x2 ?? x, y2: step.y2 ?? y)
        return dragAt(
          app: activeApp,
          x: dragPoints.x,
          y: dragPoints.y,
          x2: dragPoints.x2,
          y2: dragPoints.y2,
          holdDuration: coordinateDragHoldDuration()
        )
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

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
// MARK: - In-bundle unit tests (device-free)

extension RunnerTests {
  func testSequenceDecodesStepsFromWire() throws {
    let json = """
    {"command":"sequence","commandId":"seq-1","steps":[
      {"kind":"tap","x":100,"y":200},
      {"kind":"doubleTap","x":101,"y":200},
      {"kind":"longPress","x":102,"y":200,"durationMs":300},
      {"kind":"drag","x":10,"y":600,"x2":10,"y2":200,"durationMs":250,"pauseMs":50}
    ]}
    """
    let command = try JSONDecoder().decode(Command.self, from: Data(json.utf8))
    XCTAssertEqual(command.command, .sequence)
    XCTAssertEqual(command.steps?.count, 4)
    XCTAssertEqual(command.steps?[0].kind, "tap")
    XCTAssertEqual(command.steps?[1].kind, "doubleTap")
    XCTAssertEqual(command.steps?[3].x2, 10)
    XCTAssertEqual(command.steps?[3].pauseMs, 50)
  }

  func testSequenceAcceptsDoubleTapKind() {
    // A doubleTap step missing coords must fail on the coords check, not the kind allowlist —
    // proving "doubleTap" passes validateSequenceStep without needing a device to execute on.
    let response = executeSequenceForTest(steps: [
      sequenceStep(kind: "doubleTap", x: nil)
    ])
    XCTAssertEqual(response.ok, false)
    XCTAssertEqual(response.error?.code, "INVALID_ARGS")
    XCTAssertTrue(response.error?.message.contains("requires finite x and y") ?? false)
    XCTAssertFalse(response.error?.message.contains("unsupported kind") ?? true)
  }

  func testSequenceRejectsUnknownKind() throws {
    let response = executeSequenceForTest(steps: [
      sequenceStep(kind: "tap", x: 1, y: 2),
      sequenceStep(kind: "pinch", x: 3, y: 4),
    ])
    XCTAssertEqual(response.ok, false)
    XCTAssertEqual(response.error?.code, "INVALID_ARGS")
    XCTAssertTrue(response.error?.message.contains("step 1") ?? false)
    XCTAssertTrue(response.error?.message.contains("pinch") ?? false)
  }

  func testSequenceRejectsEmpty() {
    let response = executeSequenceForTest(steps: [])
    XCTAssertEqual(response.ok, false)
    XCTAssertEqual(response.error?.code, "INVALID_ARGS")
  }

  func testSequenceRejectsTooManySteps() {
    let steps = (0..<21).map { _ in sequenceStep(kind: "tap", x: 1, y: 2) }
    let response = executeSequenceForTest(steps: steps)
    XCTAssertEqual(response.ok, false)
    XCTAssertEqual(response.error?.code, "INVALID_ARGS")
    XCTAssertTrue(response.error?.message.contains("at most 20") ?? false)
  }

  func testSequenceRejectsDragMissingSecondPoint() {
    let response = executeSequenceForTest(steps: [
      sequenceStep(kind: "tap", x: 1, y: 2),
      sequenceStep(kind: "drag", x: 3, y: 4),
    ])
    XCTAssertEqual(response.ok, false)
    XCTAssertEqual(response.error?.code, "INVALID_ARGS")
    XCTAssertTrue(response.error?.message.contains("step 1") ?? false)
  }

  func testAssembleSequencePreservesOrderOnSuccess() {
    let steps = [
      sequenceStep(kind: "tap", x: 1, y: 1),
      sequenceStep(kind: "longPress", x: 2, y: 2),
      sequenceStep(kind: "tap", x: 3, y: 3),
    ]
    var calls: [Int] = []
    let execution = assembleSequenceExecution(steps: steps) { index, _ in
      calls.append(index)
      return SequenceStepOutcome(
        outcome: .performed,
        gestureStartUptimeMs: Double(index * 10),
        gestureEndUptimeMs: Double(index * 10 + 5)
      )
    }
    XCTAssertEqual(calls, [0, 1, 2])
    XCTAssertEqual(execution.completedSteps, 3)
    XCTAssertNil(execution.failedStepIndex)
    XCTAssertEqual(execution.results.map { $0.kind }, ["tap", "longPress", "tap"])
    XCTAssertEqual(execution.gestureStartUptimeMs, 0)
    XCTAssertEqual(execution.gestureEndUptimeMs, 25)
  }

  func testAssembleSequenceStopsAtFirstFailure() {
    let steps = [
      sequenceStep(kind: "tap", x: 1, y: 1),
      sequenceStep(kind: "drag", x: 2, y: 2),
      sequenceStep(kind: "tap", x: 3, y: 3),
    ]
    var calls: [Int] = []
    let execution = assembleSequenceExecution(steps: steps) { index, _ in
      calls.append(index)
      if index == 1 {
        return SequenceStepOutcome(
          outcome: .unsupported(message: "drag unsupported", hint: nil),
          gestureStartUptimeMs: 10,
          gestureEndUptimeMs: 15
        )
      }
      return SequenceStepOutcome(outcome: .performed, gestureStartUptimeMs: 0, gestureEndUptimeMs: 5)
    }
    // Step 2 is never invoked.
    XCTAssertEqual(calls, [0, 1])
    XCTAssertEqual(execution.completedSteps, 1)
    XCTAssertEqual(execution.failedStepIndex, 1)
    // results.count == completedSteps + 1 (the failed step).
    XCTAssertEqual(execution.results.count, 2)
    XCTAssertEqual(execution.results[1].ok, false)
    XCTAssertEqual(execution.results[1].errorCode, "UNSUPPORTED_OPERATION")
    XCTAssertEqual(execution.results[1].errorMessage, "drag unsupported")
  }

  func testSequenceWorstCaseResponseStaysUnderJournalCap() throws {
    let longMessage = String(repeating: "e", count: 200)
    let results = (0..<20).map { index in
      SequenceStepResult(
        ok: index < 19,
        kind: "drag",
        errorCode: index < 19 ? nil : "UNSUPPORTED_OPERATION",
        errorMessage: index < 19 ? nil : longMessage,
        gestureStartUptimeMs: 123456.789,
        gestureEndUptimeMs: 123466.789
      )
    }
    let response = Response(
      ok: true,
      data: DataPayload(
        message: "sequence",
        completedSteps: 19,
        failedStepIndex: 19,
        sequenceResults: results
      )
    )
    let encoded = try JSONEncoder().encode(response)
    XCTAssertLessThan(encoded.count, 16 * 1024)
  }

  private func sequenceStep(
    kind: String,
    x: Double?,
    y: Double? = nil,
    x2: Double? = nil,
    y2: Double? = nil
  ) -> SequenceStep {
    SequenceStep(
      kind: kind, x: x, y: y, x2: x2, y2: y2, durationMs: nil, pauseMs: nil, synthesized: nil)
  }

  /// Validation runs before any executor call, so the INVALID_ARGS paths are exercised without
  /// reaching the device executor (which is never invoked when validation rejects).
  private func executeSequenceForTest(steps: [SequenceStep]) -> Response {
    let command = makeSequenceCommand(steps: steps)
    return executeSequence(command: command, activeApp: app)
  }

  /// Build a sequence Command via JSON so the test does not depend on the memberwise init's
  /// parameter order.
  private func makeSequenceCommand(steps: [SequenceStep]) -> Command {
    struct SequenceCommandFixture: Encodable {
      let command = "sequence"
      let commandId = "seq-test"
      let steps: [SequenceStep]
    }
    let data = try! JSONEncoder().encode(SequenceCommandFixture(steps: steps))
    return try! JSONDecoder().decode(Command.self, from: data)
  }
}
#endif
