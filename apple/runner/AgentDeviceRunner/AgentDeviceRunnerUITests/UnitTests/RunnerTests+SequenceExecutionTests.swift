import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
// MARK: - In-bundle unit tests (device-free)

extension RunnerTests {
  func testSequenceDecodesStepsFromWire() throws {
    let json = """
    {"command":"sequence","commandId":"seq-1","steps":[
      {"kind":"tap","x":100,"y":200},
      {"kind":"doubleTap","x":101,"y":200},
      {"kind":"longPress","x":102,"y":200,"durationMs":300,"pauseMs":50}
    ]}
    """
    let command = try JSONDecoder().decode(Command.self, from: Data(json.utf8))
    XCTAssertEqual(command.command, .sequence)
    XCTAssertEqual(command.steps?.count, 3)
    XCTAssertEqual(command.steps?[0].kind, "tap")
    XCTAssertEqual(command.steps?[1].kind, "doubleTap")
    XCTAssertEqual(command.steps?[2].pauseMs, 50)
  }

  @MainActor
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

  @MainActor
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

  @MainActor
  func testSequenceRejectsEmpty() {
    let response = executeSequenceForTest(steps: [])
    XCTAssertEqual(response.ok, false)
    XCTAssertEqual(response.error?.code, "INVALID_ARGS")
  }

  @MainActor
  func testSequenceRejectsTooManySteps() {
    let steps = (0..<21).map { _ in sequenceStep(kind: "tap", x: 1, y: 2) }
    let response = executeSequenceForTest(steps: steps)
    XCTAssertEqual(response.ok, false)
    XCTAssertEqual(response.error?.code, "INVALID_ARGS")
    XCTAssertTrue(response.error?.message.contains("at most 20") ?? false)
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
      sequenceStep(kind: "longPress", x: 2, y: 2),
      sequenceStep(kind: "tap", x: 3, y: 3),
    ]
    var calls: [Int] = []
    let execution = assembleSequenceExecution(steps: steps) { index, _ in
      calls.append(index)
      if index == 1 {
        return SequenceStepOutcome(
          outcome: .unsupported(message: "long press unsupported", hint: nil),
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
    XCTAssertEqual(execution.results[1].errorMessage, "long press unsupported")
  }

  func testSequenceWorstCaseResponseStaysUnderJournalCap() throws {
    let longMessage = String(repeating: "e", count: 200)
    let results = (0..<20).map { index in
      SequenceStepResult(
        ok: index < 19,
        kind: "longPress",
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
    y: Double? = nil
  ) -> SequenceStep {
    SequenceStep(
      kind: kind,
      x: x,
      y: y,
      durationMs: nil,
      pauseMs: nil,
      synthesized: nil
    )
  }

  /// Validation runs before any executor call, so the INVALID_ARGS paths are exercised without
  /// reaching the device executor (which is never invoked when validation rejects).
  @MainActor
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

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
extension RunnerTests {
  func testSynthesizedSequenceTapFallsBackToXCTestCoordinateTapWhenAccessibilityIsUnavailable() throws {
    let restoreSynthesizedTap = try forceSynthesizedTapFailure()
    app.launch()
    currentApp = app
    defer {
      restoreSynthesizedTap()
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let label = app.staticTexts["Agent Device Runner"]
    XCTAssertTrue(label.waitForExistence(timeout: appExistenceTimeout))
    let point = CGPoint(x: label.frame.midX, y: label.frame.midY)
    runnerAccessibilityHealth = .unavailable
    let command = try runnerCommandFixture(
      #"{"command":"sequence","commandId":"sequence-synthesized-tap-fallback","steps":[{"kind":"tap","x":\#(point.x),"y":\#(point.y),"synthesized":true}]}"#
    )

    let response = try executeOnMainPrepared(command: command, activeApp: app)

    XCTAssertTrue(response.ok)
    XCTAssertEqual(response.data?.completedSteps, 1)
    XCTAssertNil(response.data?.failedStepIndex)
    XCTAssertEqual(response.data?.sequenceResults?.first?.ok, true)
  }
}
#endif
