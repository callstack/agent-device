import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

private final class RunnerSynthesizedSwipeFailureStub: NSObject {
  @objc(synthesizeSwipeWithApplication:x:y:x2:y2:durationMs:)
  class func synthesizeSwipe(
    application: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    durationMs: Double
  ) -> String? {
    "forced private synthesis failure"
  }
}
#endif

extension RunnerTests {
  // MARK: - Main Thread Dispatch

  private func currentUptimeMs() -> Double {
    ProcessInfo.processInfo.systemUptime * 1000
  }

  private func measureGesture(_ action: () -> Void) -> (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double) {
    let gestureStartUptimeMs = currentUptimeMs()
    action()
    return (gestureStartUptimeMs, currentUptimeMs())
  }

  func synthesizedSwipeFallbackHoldDuration(durationMs: Double) -> TimeInterval {
    min(max((durationMs / 5.0) / 1000.0, 0.016), 0.120)
  }

  func coordinateDragHoldDuration() -> TimeInterval {
    0.050
  }

  func unsupportedResponse(for outcome: RunnerInteractionOutcome) -> Response? {
    switch outcome {
    case .performed:
      return nil
    case .unsupported(let message, let hint):
      return Response(
        ok: false,
        error: ErrorPayload(code: "UNSUPPORTED_OPERATION", message: message, hint: hint)
      )
    }
  }

  /// Optional visualization frame returned with a gesture response.
  enum GestureFrame {
    case none
    case touch(TouchVisualizationFrame?)
    case drag(DragVisualizationFrame)
  }

  struct GestureFallback {
    let strategy: String
    let message: String
    let hint: String?
  }

  private func gestureFallback(strategy: String, from outcome: RunnerInteractionOutcome) -> GestureFallback? {
    switch outcome {
    case .performed:
      return nil
    case .unsupported(let message, let hint):
      return GestureFallback(strategy: strategy, message: message, hint: hint)
    }
  }


  /// Runs a gesture action with uniform timing capture. Touch gestures pass `idleTimeout: true`
  /// (the default) to run inside the scroll idle-timeout + quiescence-skip wrapper; synthesis
  /// pointer-plan gestures pass `false` because RunnerSynthesizedGesture governs their
  /// own timing. Returns the captured timing and the action's outcome.
  ///
  /// NOTE: a new SYNTHESIS gesture must pass `idleTimeout: false` — the default `true` would wrap
  /// it in the scroll idle-timeout/quiescence-skip path and change its runtime behavior.
  func performGesture(
    _ app: XCUIApplication,
    idleTimeout: Bool = true,
    _ action: () -> RunnerInteractionOutcome
  ) -> (timing: (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double), outcome: RunnerInteractionOutcome) {
    var outcome = RunnerInteractionOutcome.performed
    let timing = measureGesture {
      if idleTimeout {
        withTemporaryScrollIdleTimeoutIfSupported(app) { outcome = action() }
      } else {
        outcome = action()
      }
    }
    return (timing, outcome)
  }

  /// Single factory for the success payload every gesture returns (message + gesture timing +
  /// an optional touch/drag visualization frame), so the field shape lives in one place.
  private func gestureResponse(
    message: String,
    timing: (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double),
    frame: GestureFrame = .none,
    fallback: GestureFallback? = nil,
    maestroNonHittableCoordinateFallbackUsed: Bool? = nil
  ) -> Response {
    let data: DataPayload
    switch frame {
    case .none:
      data = DataPayload(
        message: message,
        gestureStartUptimeMs: timing.gestureStartUptimeMs,
        gestureEndUptimeMs: timing.gestureEndUptimeMs,
        gestureFallback: fallback?.strategy,
        gestureFallbackMessage: fallback?.message,
        gestureFallbackHint: fallback?.hint,
        maestroNonHittableCoordinateFallbackUsed: maestroNonHittableCoordinateFallbackUsed
      )
    case .touch(let f):
      data = DataPayload(
        message: message,
        gestureStartUptimeMs: timing.gestureStartUptimeMs,
        gestureEndUptimeMs: timing.gestureEndUptimeMs,
        x: f?.x,
        y: f?.y,
        referenceWidth: f?.referenceWidth,
        referenceHeight: f?.referenceHeight,
        gestureFallback: fallback?.strategy,
        gestureFallbackMessage: fallback?.message,
        gestureFallbackHint: fallback?.hint,
        maestroNonHittableCoordinateFallbackUsed: maestroNonHittableCoordinateFallbackUsed
      )
    case .drag(let f):
      data = DataPayload(
        message: message,
        gestureStartUptimeMs: timing.gestureStartUptimeMs,
        gestureEndUptimeMs: timing.gestureEndUptimeMs,
        x: f.x,
        y: f.y,
        x2: f.x2,
        y2: f.y2,
        referenceWidth: f.referenceWidth,
        referenceHeight: f.referenceHeight,
        gestureFallback: fallback?.strategy,
        gestureFallbackMessage: fallback?.message,
        gestureFallbackHint: fallback?.hint
      )
    }
    return Response(ok: true, data: data)
  }

  /// Gesture plans already return canonical centroid endpoints from the portable runtime.
  /// Keep runner timing/fallback diagnostics, but do not leak the coordinate-drag adapter's
  /// visualization frame into only the fast-fling response shape.
  private func canonicalPlannedGestureResponse(_ response: Response) -> Response {
    guard response.ok, let data = response.data else { return response }
    return Response(
      ok: true,
      data: DataPayload(
        message: data.message,
        gestureStartUptimeMs: data.gestureStartUptimeMs,
        gestureEndUptimeMs: data.gestureEndUptimeMs,
        gestureFallback: data.gestureFallback,
        gestureFallbackMessage: data.gestureFallbackMessage,
        gestureFallbackHint: data.gestureFallbackHint
      )
    )
  }

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  func testGestureResponseIncludesSynthesizedTapFallbackDiagnostics() {
    let response = gestureResponse(
      message: "tapped",
      timing: (gestureStartUptimeMs: 1, gestureEndUptimeMs: 2),
      fallback: GestureFallback(
        strategy: "xctest-coordinate-tap",
        message: "Runner synthesized coordinate tap is unavailable",
        hint: "Using XCTest coordinate tap fallback."
      )
    )

    XCTAssertEqual(response.ok, true)
    XCTAssertEqual(response.data?.gestureFallback, "xctest-coordinate-tap")
    XCTAssertEqual(
      response.data?.gestureFallbackMessage,
      "Runner synthesized coordinate tap is unavailable"
    )
    XCTAssertEqual(response.data?.gestureFallbackHint, "Using XCTest coordinate tap fallback.")
  }

  func testGestureResponseIncludesMaestroNonHittableFallbackUsage() {
    let response = gestureResponse(
      message: "tapped via non-hittable coordinate fallback",
      timing: (gestureStartUptimeMs: 1, gestureEndUptimeMs: 2),
      frame: .touch(nil),
      maestroNonHittableCoordinateFallbackUsed: true
    )

    XCTAssertEqual(response.data?.maestroNonHittableCoordinateFallbackUsed, true)
  }

  func testCanonicalPlannedGestureResponseOmitsDragFrameAndPreservesDiagnostics() {
    let response = gestureResponse(
      message: "fling",
      timing: (gestureStartUptimeMs: 1, gestureEndUptimeMs: 2),
      frame: .drag(
        DragVisualizationFrame(
          x: 160,
          y: 150,
          x2: 40,
          y2: 150,
          referenceWidth: 200,
          referenceHeight: 300
        )
      ),
      fallback: GestureFallback(
        strategy: "xctest-coordinate-drag",
        message: "Private synthesis unavailable",
        hint: "Using XCTest coordinate fallback."
      )
    )

    let canonical = canonicalPlannedGestureResponse(response)

    XCTAssertEqual(canonical.data?.gestureStartUptimeMs, 1)
    XCTAssertEqual(canonical.data?.gestureEndUptimeMs, 2)
    XCTAssertEqual(canonical.data?.gestureFallback, "xctest-coordinate-drag")
    XCTAssertEqual(canonical.data?.gestureFallbackMessage, "Private synthesis unavailable")
    XCTAssertEqual(canonical.data?.gestureFallbackHint, "Using XCTest coordinate fallback.")
    XCTAssertNil(canonical.data?.x)
    XCTAssertNil(canonical.data?.y)
    XCTAssertNil(canonical.data?.x2)
    XCTAssertNil(canonical.data?.y2)
    XCTAssertNil(canonical.data?.referenceWidth)
    XCTAssertNil(canonical.data?.referenceHeight)
  }

#if os(iOS)
  func testSinglePointerFlingFallsBackToXCTestCoordinateDragWhenPrivateSynthesisFails() throws {
    let selector = NSSelectorFromString(
      "synthesizeSwipeWithApplication:x:y:x2:y2:durationMs:"
    )
    guard
      let synthesizedSwipeMethod = class_getClassMethod(RunnerSynthesizedGesture.self, selector),
      let failureStubMethod = class_getClassMethod(RunnerSynthesizedSwipeFailureStub.self, selector)
    else {
      XCTFail("unable to install synthesized swipe failure stub")
      return
    }
    let originalImplementation = method_getImplementation(synthesizedSwipeMethod)
    method_setImplementation(
      synthesizedSwipeMethod,
      method_getImplementation(failureStubMethod)
    )
    app.launch()
    runnerAccessibilityHealth = .healthy
    defer {
      method_setImplementation(synthesizedSwipeMethod, originalImplementation)
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let command = try runnerCommandFixture(
      """
      {"command":"gesture","commandId":"gesture-fling-fallback","gesturePlan":{"topology":"single","intent":"fling","durationMs":100,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":160,"y":150}},{"offsetMs":100,"point":{"x":40,"y":150}}]}]}}
      """
    )

    let response = try executeOnMainPrepared(command: command, activeApp: app)

    XCTAssertTrue(response.ok)
    XCTAssertEqual(response.data?.message, "fling")
    XCTAssertEqual(response.data?.gestureFallback, "xctest-coordinate-drag")
    XCTAssertEqual(response.data?.gestureFallbackMessage, "forced private synthesis failure")
    XCTAssertEqual(
      response.data?.gestureFallbackHint,
      "Private XCTest event synthesis is required for AX-free coordinate drag on iOS; update Xcode if this persists."
    )
    XCTAssertNil(response.data?.x)
    XCTAssertNil(response.data?.y)
    XCTAssertNil(response.data?.x2)
    XCTAssertNil(response.data?.y2)
  }
#endif

  func testXCTestRecordedFailureResponseFailsMutatingSuccesses() throws {
    let command = try runnerCommandFixture(#"{"command":"tap","commandId":"tap-1"}"#)
    let response = Response(ok: true, data: DataPayload(message: "tapped"))

    let failureResponse = xctestRecordedFailureResponse(command: command, response: response)

    XCTAssertEqual(failureResponse?.ok, false)
    XCTAssertEqual(failureResponse?.error?.code, "XCTEST_RECORDED_FAILURE")
    XCTAssertEqual(
      failureResponse?.error?.message,
      "XCTest recorded a failure while executing tap; the action may not have been performed."
    )
  }

  func testXCTestRecordedFailureResponseDoesNotWrapReadOnlyOrRunnerFatalResponses() throws {
    let snapshotCommand = try runnerCommandFixture(#"{"command":"snapshot","commandId":"snapshot-1"}"#)
    let tapCommand = try runnerCommandFixture(#"{"command":"tap","commandId":"tap-1"}"#)
    let runnerFatalResponse = Response(
      ok: true,
      data: DataPayload(runnerFatal: true, runnerFatalReason: "ax_snapshot_unavailable")
    )

    XCTAssertNil(
      xctestRecordedFailureResponse(
        command: snapshotCommand,
        response: Response(ok: true, data: DataPayload(nodes: [], truncated: false))
      )
    )
    XCTAssertNil(xctestRecordedFailureResponse(command: tapCommand, response: runnerFatalResponse))
  }

  func testMissingBundleCommandInvalidatesCompleteCachedTargetState() throws {
    app.launch()
    currentApp = app
    currentBundleId = "com.example.stale-target"
    currentAppProcessIdentifier = 42
    snapshotXCTestPenaltyWarmupExemptionPending = true
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let command = try runnerCommandFixture(
      #"{"command":"snapshot","commandId":"snapshot-without-bundle"}"#
    )

    _ = prepareActiveCommandContext(command: command)

    XCTAssertNil(currentApp)
    XCTAssertNil(currentBundleId)
    XCTAssertNil(currentAppProcessIdentifier)
    XCTAssertFalse(snapshotXCTestPenaltyWarmupExemptionPending)
  }

  func testSkipAppActivationPreflightOnlyIncludesCoordinateOnlySynthesizedTaps() throws {
    currentApp = app
    currentBundleId = nil
    defer {
      currentApp = nil
      currentBundleId = nil
    }
    let tap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-1","x":10,"y":20,"synthesized":true}"#
    )

    XCTAssertTrue(shouldSkipAppActivationPreflight(tap))
  }

  func testSkipAppActivationPreflightRejectsSelectorAndMixedSequenceGestures() throws {
    currentApp = app
    currentBundleId = nil
    defer {
      currentApp = nil
      currentBundleId = nil
    }
    let selectorTap = try runnerCommandFixture(
      #"{"command":"tap","commandId":"tap-1","selectorKey":"label","selectorValue":"Search","synthesized":true}"#
    )
    let standardDrag = try runnerCommandFixture(
      #"{"command":"drag","commandId":"drag-1","x":10,"y":20,"x2":30,"y2":40}"#
    )
    let mixedSequence = try runnerCommandFixture(
      """
      {"command":"sequence","commandId":"seq-1","steps":[
        {"kind":"tap","x":10,"y":20,"synthesized":true},
        {"kind":"doubleTap","x":30,"y":40}
      ]}
      """
    )

    XCTAssertFalse(shouldSkipAppActivationPreflight(selectorTap))
    XCTAssertFalse(shouldSkipAppActivationPreflight(standardDrag))
    XCTAssertFalse(shouldSkipAppActivationPreflight(mixedSequence))
  }

  func testSkipAppActivationPreflightRequiresCachedTarget() throws {
    currentApp = nil
    currentBundleId = nil
    let scroll = try runnerCommandFixture(
      #"{"command":"scroll","commandId":"scroll-1","direction":"down","pixels":400}"#
    )

    XCTAssertFalse(shouldSkipAppActivationPreflight(scroll))
  }

  func testSkipAppActivationPreflightKeepsDragScrollAndSequenceOnForegroundGuard() throws {
    currentApp = app
    currentBundleId = nil
    defer {
      currentApp = nil
      currentBundleId = nil
    }
    let drag = try runnerCommandFixture(
      #"{"command":"drag","commandId":"drag-1","x":10,"y":20,"x2":30,"y2":40,"synthesized":true}"#
    )
    let scroll = try runnerCommandFixture(
      #"{"command":"scroll","commandId":"scroll-1","direction":"down","pixels":400}"#
    )
    let sequence = try runnerCommandFixture(
      """
      {"command":"sequence","commandId":"seq-1","steps":[
        {"kind":"tap","x":10,"y":20,"synthesized":true},
        {"kind":"longPress","x":10,"y":200,"durationMs":300}
      ]}
      """
    )

    XCTAssertFalse(shouldSkipAppActivationPreflight(drag))
    XCTAssertFalse(shouldSkipAppActivationPreflight(scroll))
    XCTAssertFalse(shouldSkipAppActivationPreflight(sequence))
  }

  func testExecuteDispatchedReturnsBusyBeforeMainThreadFastPath() throws {
    let command = try runnerCommandFixture(#"{"command":"snapshot","commandId":"snapshot-busy"}"#)
    abandonedMainThreadWorkCount = 1
    abandonedMainThreadWorkSince = Date(timeIntervalSinceNow: -2)
    defer {
      abandonedMainThreadWorkCount = 0
      abandonedMainThreadWorkSince = nil
    }

    let response = try executeDispatched(command: command)

    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "RUNNER_BUSY")
    XCTAssertTrue(response.error?.message.contains("previous command") == true)
  }

  func testExecuteDispatchedReturnsWedgedBeforeMainThreadFastPath() throws {
    let command = try runnerCommandFixture(#"{"command":"snapshot","commandId":"snapshot-wedged"}"#)
    abandonedMainThreadWorkCount = 1
    abandonedMainThreadWorkSince = Date(timeIntervalSinceNow: -(mainThreadWedgeThreshold + 1))
    defer {
      abandonedMainThreadWorkCount = 0
      abandonedMainThreadWorkSince = nil
    }

    let response = try executeDispatched(command: command)

    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, "RUNNER_WEDGED")
    XCTAssertTrue(response.error?.hint?.contains("runner session will be restarted") == true)
  }

  func testAlertResolutionCannotBypassRequestedDeadline() throws {
    final class ResultBox {
      var error: Error?
      var observedDeadline: Date?
    }
    let box = ResultBox()
    let releaseResolution = DispatchSemaphore(value: 0)
    let resolutionExited = expectation(description: "bounded alert resolution exited")
    let commandFinished = expectation(description: "alert command respected its deadline")
    let startedAt = Date()
    let command = try runnerCommandFixture(
      #"{"command":"alert","commandId":"alert-deadline","appBundleId":"com.apple.springboard","action":"get","timeoutMs":50}"#
    )
    currentApp = springboard
    currentBundleId = Self.springboardBundleId
    alertResolutionOverrideForTesting = { deadline in
      box.observedDeadline = deadline
      _ = releaseResolution.wait(timeout: .now() + 1)
      resolutionExited.fulfill()
      return nil
    }
    defer {
      releaseResolution.signal()
      alertResolutionOverrideForTesting = nil
      currentApp = nil
      currentBundleId = nil
    }

    DispatchQueue(label: "agent-device.runner.tests.alert-deadline").async {
      do {
        _ = try self.executeDispatched(command: command)
      } catch {
        box.error = error
      }
      commandFinished.fulfill()
    }

    wait(for: [commandFinished], timeout: 1)
    let error = box.error as NSError?
    XCTAssertEqual(error?.domain, RunnerErrorDomain.general)
    XCTAssertEqual(error?.code, RunnerErrorCode.mainThreadExecutionTimedOut)
    XCTAssertNotNil(box.observedDeadline)
    if let observedDeadline = box.observedDeadline {
      XCTAssertGreaterThan(observedDeadline.timeIntervalSince(startedAt), 0)
      XCTAssertLessThan(observedDeadline.timeIntervalSince(startedAt), 0.2)
    }

    releaseResolution.signal()
    wait(for: [resolutionExited], timeout: 1)
  }

  func testRunMainThreadWorkExecutesOffMainCallerOnMainThread() {
    final class ResultBox {
      var observedMainThread: Bool?
      var error: Error?
    }
    let box = ResultBox()
    let finished = expectation(description: "off-main caller finished")

    DispatchQueue(label: "agent-device.runner.tests.off-main").async {
      do {
        box.observedMainThread = try self.runMainThreadWork(
          command: nil,
          timeout: 1,
          timeoutError: self.mainThreadExecutionTimeoutError
        ) {
          Thread.isMainThread
        }
      } catch {
        box.error = error
      }
      finished.fulfill()
    }

    wait(for: [finished], timeout: 2)
    XCTAssertNil(box.error)
    XCTAssertEqual(box.observedMainThread, true)
  }

  func testRunMainThreadWorkTimeoutMarksAbandonedUntilDrained() {
    final class ResultBox {
      var error: Error?
      var abandonedCount: Int?
      var abandonedSinceSet: Bool?
      var drainedCount: Int?
      var drainedSinceCleared: Bool?
    }
    let box = ResultBox()
    let releaseWork = DispatchSemaphore(value: 0)
    let observedAbandoned = DispatchSemaphore(value: 0)
    let finished = expectation(description: "off-main caller timed out")
    let drained = expectation(description: "abandoned main work drained")

    DispatchQueue(label: "agent-device.runner.tests.timeout").async {
      do {
        _ = try self.runMainThreadWork(
          command: nil,
          timeout: 0,
          timeoutError: self.mainThreadExecutionTimeoutError,
          onAbandoned: {
            box.abandonedCount = self.abandonedMainThreadWorkCount
            box.abandonedSinceSet = self.abandonedMainThreadWorkSince != nil
            observedAbandoned.signal()
          },
          onDrained: {
            self.mainThreadWorkLock.lock()
            box.drainedCount = self.abandonedMainThreadWorkCount
            box.drainedSinceCleared = self.abandonedMainThreadWorkSince == nil
            self.mainThreadWorkLock.unlock()
            drained.fulfill()
          }
        ) {
          _ = releaseWork.wait(timeout: .now() + 1)
          return true
        }
      } catch {
        box.error = error
      }
      finished.fulfill()
    }

    DispatchQueue(label: "agent-device.runner.tests.release-timeout").async {
      _ = observedAbandoned.wait(timeout: .now() + 1)
      releaseWork.signal()
    }

    wait(for: [finished, drained], timeout: 2)
    XCTAssertEqual((box.error as NSError?)?.code, RunnerErrorCode.mainThreadExecutionTimedOut)
    XCTAssertEqual(box.abandonedCount, 1)
    XCTAssertEqual(box.abandonedSinceSet, true)
    XCTAssertEqual(box.drainedCount, 0)
    XCTAssertEqual(box.drainedSinceCleared, true)
  }

  func testPostSnapshotDelayMarkDoesNotQueueBehindAbandonedTreeCapture() {
    abandonedTreeCaptureCount = 1
    defer {
      abandonedTreeCaptureCount = 0
      needsPostSnapshotInteractionDelay = false
    }

    let finished = expectation(description: "off-main caller finished")
    DispatchQueue(label: "agent-device.runner.tests.post-snapshot-delay").async {
      self.setNeedsPostSnapshotInteractionDelay()
      finished.fulfill()
    }

    wait(for: [finished], timeout: 1)
    mainThreadWorkLock.lock()
    let abandonedWorkCount = abandonedMainThreadWorkCount
    mainThreadWorkLock.unlock()
    XCTAssertEqual(abandonedWorkCount, 0)
  }
#endif

  func execute(command: Command) throws -> Response {
    if command.command == .status {
      return executeStatus(command: command)
    }
    if command.command == .uptime {
      return executeUptime()
    }
    commandJournal.accept(command: command)
    return try executeAccepted(command: command)
  }

  func executeAccepted(command: Command) throws -> Response {
    commandJournal.start(command: command)
    do {
      let response = try executeDispatched(command: command)
      commandJournal.finish(command: command, response: response)
      return response
    } catch {
      commandJournal.fail(command: command, error: error)
      throw error
    }
  }

  func executeStatus(command: Command) -> Response {
    guard
      let statusCommandId = command.statusCommandId?
        .trimmingCharacters(in: .whitespacesAndNewlines),
      !statusCommandId.isEmpty
    else {
      return Response(
        ok: false,
        error: ErrorPayload(
          code: "INVALID_ARGS",
          message: "status requires statusCommandId",
          hint: "Set statusCommandId to the commandId of the runner command to inspect."
        )
      )
    }
    return Response(ok: true, data: commandJournal.status(commandId: statusCommandId))
  }

  func executeUptime() -> Response {
    // Placeholder value: the transport layer (jsonResponse) overwrites currentUptimeMs with a
    // fresher send-time stamp on every ok response; kept so direct callers still get a value.
    Response(
      ok: true,
      data: DataPayload(currentUptimeMs: currentUptimeMs())
    )
  }

  /// Tracks one main-queue dispatch so the watchdog and the dispatched block can agree —
  /// under `mainThreadWorkLock` — on exactly one of: finished in time, or abandoned.
  private final class MainThreadWorkState {
    var finished = false
    var abandoned = false
  }

  struct ActiveCommandContext {
    let app: XCUIApplication
  }

  enum ActiveCommandPreparation {
    case response(Response)
    case context(ActiveCommandContext)
  }

  enum MainThreadBusyState {
    case idle
    case busy(abandonedForSeconds: TimeInterval)
    case wedged(abandonedForSeconds: TimeInterval)
  }

  func currentMainThreadBusyState() -> MainThreadBusyState {
    mainThreadWorkLock.lock()
    defer { mainThreadWorkLock.unlock() }
    guard abandonedMainThreadWorkCount > 0 else { return .idle }
    let abandonedFor = abandonedMainThreadWorkSince.map { Date().timeIntervalSince($0) } ?? 0
    if abandonedFor > mainThreadWedgeThreshold {
      return .wedged(abandonedForSeconds: abandonedFor)
    }
    return .busy(abandonedForSeconds: abandonedFor)
  }

  private func runnerBusyResponse(command: Command, abandonedForSeconds: TimeInterval) -> Response {
    NSLog(
      "AGENT_DEVICE_RUNNER_BUSY command=%@ commandId=%@ abandonedForSeconds=%.1f",
      command.command.rawValue,
      command.commandId ?? "",
      abandonedForSeconds
    )
    return Response(
      ok: false,
      error: ErrorPayload(
        code: "RUNNER_BUSY",
        message:
          "The iOS runner is still finishing a previous command that exceeded its execution watchdog (usually an accessibility capture on a heavy or animating screen).",
        hint:
          "Wait a few seconds and retry. If snapshots keep failing on this screen, use screenshot as visual truth and interact by coordinates, or navigate to another screen."
      )
    )
  }

  private func runnerWedgedResponse(command: Command, abandonedForSeconds: TimeInterval) -> Response {
    NSLog(
      "AGENT_DEVICE_RUNNER_WEDGED command=%@ commandId=%@ abandonedForSeconds=%.1f",
      command.command.rawValue,
      command.commandId ?? "",
      abandonedForSeconds
    )
    return Response(
      ok: false,
      error: ErrorPayload(
        code: "RUNNER_WEDGED",
        message:
          "The iOS runner main thread has been stuck in abandoned work for \(Int(abandonedForSeconds)) seconds and cannot recover on its own.",
        hint:
          "The runner session will be restarted. Retry the command after the restart; if this screen keeps wedging captures, use screenshot as visual truth and interact by coordinates."
      )
    )
  }

  private func executeDispatched(command: Command) throws -> Response {
    // XCTest work cannot be cancelled mid-flight: once the watchdog abandons a main-queue
    // block, queueing more main-thread commands behind it only buries the runner deeper.
    // Refuse fast instead so the daemon backs off while the abandoned work drains; past the
    // wedge threshold, escalate so the daemon recycles this runner (#1105).
    switch currentMainThreadBusyState() {
    case .idle:
      break
    case .busy(let abandonedForSeconds):
      return runnerBusyResponse(command: command, abandonedForSeconds: abandonedForSeconds)
    case .wedged(let abandonedForSeconds):
      return runnerWedgedResponse(command: command, abandonedForSeconds: abandonedForSeconds)
    }
    if Thread.isMainThread {
      let alertDeadline = command.command == .alert
        ? Date().addingTimeInterval(Self.alertCommandTimeout(timeoutMs: command.timeoutMs))
        : nil
      return try executeOnMainSafely(command: command, alertDeadline: alertDeadline)
    }
    if command.command == .snapshot {
      return try executeSnapshotDispatched(command: command)
    }
    if command.command == .alert {
      let deadline = Date().addingTimeInterval(
        Self.alertCommandTimeout(timeoutMs: command.timeoutMs)
      )
      return try runMainThreadWork(
        command: command,
        timeout: max(0.001, deadline.timeIntervalSinceNow),
        timeoutError: mainThreadExecutionTimeoutError
      ) {
        try self.executeOnMainSafely(command: command, alertDeadline: deadline)
      }
    }
    return try runMainThreadWork(
      command: command,
      timeout: mainThreadExecutionTimeout,
      timeoutError: mainThreadExecutionTimeoutError
    ) {
      try self.executeOnMainSafely(command: command)
    }
  }

  func runMainThreadWork<T>(
    command: Command?,
    timeout: TimeInterval,
    timeoutError: @escaping () -> Error,
    onAbandoned: (() -> Void)? = nil,
    onDrained: (() -> Void)? = nil,
    _ work: @escaping () throws -> T
  ) throws -> T {
    if Thread.isMainThread {
      return try work()
    }
    var result: Result<T, Error>?
    let semaphore = DispatchSemaphore(value: 0)
    let workState = MainThreadWorkState()
    DispatchQueue.main.async {
      do {
        result = .success(try work())
      } catch {
        result = .failure(error)
      }
      self.mainThreadWorkLock.lock()
      if workState.abandoned {
        self.abandonedMainThreadWorkCount -= 1
        if self.abandonedMainThreadWorkCount == 0 {
          self.abandonedMainThreadWorkSince = nil
          NSLog("AGENT_DEVICE_RUNNER_ABANDONED_WORK_DRAINED")
        }
        self.mainThreadWorkLock.unlock()
        onDrained?()
      } else {
        workState.finished = true
        self.mainThreadWorkLock.unlock()
      }
      semaphore.signal()
    }
    let waitResult = semaphore.wait(timeout: .now() + timeout)
    if waitResult == .timedOut {
      mainThreadWorkLock.lock()
      let stillRunning = !workState.finished
      if stillRunning {
        workState.abandoned = true
        abandonedMainThreadWorkCount += 1
        if abandonedMainThreadWorkSince == nil {
          abandonedMainThreadWorkSince = Date()
        }
        onAbandoned?()
      }
      mainThreadWorkLock.unlock()
      throw timeoutError()
    }
    switch result {
    case .success(let value):
      return value
    case .failure(let error):
      throw error
    case .none:
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.noResponseFromMainThread,
        userInfo: [NSLocalizedDescriptionKey: "no response from main thread"]
      )
    }
  }

  private func mainThreadExecutionTimeoutError() -> Error {
    NSError(
      domain: RunnerErrorDomain.general,
      code: RunnerErrorCode.mainThreadExecutionTimedOut,
      userInfo: [NSLocalizedDescriptionKey: "main thread execution timed out"]
    )
  }

  // MARK: - Command Handling

  private func executeOnMainSafely(
    command: Command,
    alertDeadline: Date? = nil
  ) throws -> Response {
    var hasRetried = false
    while true {
      var response: Response?
      var swiftError: Error?
      let failureCountBefore = currentXCTestFailureCount()
      let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
        do {
          response = try self.executeOnMain(command: command, alertDeadline: alertDeadline)
        } catch {
          swiftError = error
        }
      })

      if let exceptionMessage {
        invalidateCachedTarget(reason: "objc_exception")
        if !hasRetried, shouldRetryException(command, message: exceptionMessage) {
          NSLog(
            "AGENT_DEVICE_RUNNER_RETRY command=%@ reason=objc_exception",
            command.command.rawValue
          )
          hasRetried = true
          sleepFor(retryCooldown)
          continue
        }
        throw NSError(
          domain: RunnerErrorDomain.exception,
          code: RunnerErrorCode.objcException,
          userInfo: [NSLocalizedDescriptionKey: exceptionMessage]
        )
      }
      if let swiftError {
        throw swiftError
      }
      guard let response else {
        throw NSError(
          domain: RunnerErrorDomain.general,
          code: RunnerErrorCode.commandReturnedNoResponse,
          userInfo: [NSLocalizedDescriptionKey: "command returned no response"]
        )
      }
      if didRecordXCTestFailure(since: failureCountBefore),
        let failureResponse = xctestRecordedFailureResponse(command: command, response: response)
      {
        invalidateCachedTarget(reason: "xctest_recorded_failure")
        return failureResponse
      }
      if !hasRetried, shouldRetryCommand(command), shouldRetryResponse(response) {
        NSLog(
          "AGENT_DEVICE_RUNNER_RETRY command=%@ reason=response_unavailable",
          command.command.rawValue
        )
        hasRetried = true
        invalidateCachedTarget(reason: "response_unavailable")
        sleepFor(retryCooldown)
        continue
      }
      return response
    }
  }

  private func executeSnapshotDispatched(command: Command) throws -> Response {
    try executeDispatchedWithRecovery(command: command) {
      try self.executeSnapshotDispatchedOnce(command: command)
    }
  }

  /// The dispatched snapshot recovery loop: read-only retry + XCTest-recorded-failure invalidation,
  /// matching what `executeOnMainSafely` gives the generic path. `perform` runs the capture and its
  /// own bounded main-thread work.
  func executeDispatchedWithRecovery(
    command: Command,
    perform: () throws -> Response
  ) throws -> Response {
    var hasRetried = false
    while true {
      let failureCountBefore = try runMainThreadWork(
        command: command,
        timeout: mainThreadExecutionTimeout,
        timeoutError: mainThreadExecutionTimeoutError
      ) {
        self.currentXCTestFailureCount()
      }
      let response = try perform()
      // Recovered independently — re-entering main for bookkeeping would queue behind the still-
      // abandoned XCTest query and re-stall the command (#1244), so skip it until that work drains.
      if hasAbandonedTreeCapture() {
        NSLog(
          "AGENT_DEVICE_RUNNER_DISPATCH_RECOVERY_SKIPPED_XCTEST_OCCUPIED command=%@",
          command.command.rawValue
        )
        return response
      }
      let recordedFailureResponse = try runMainThreadWork(
        command: command,
        timeout: mainThreadExecutionTimeout,
        timeoutError: mainThreadExecutionTimeoutError
      ) {
        self.didRecordXCTestFailure(since: failureCountBefore)
          ? self.xctestRecordedFailureResponse(command: command, response: response)
          : nil
      }
      if let recordedFailureResponse {
        try runMainThreadWork(
          command: command,
          timeout: mainThreadExecutionTimeout,
          timeoutError: mainThreadExecutionTimeoutError
        ) {
          self.invalidateCachedTarget(reason: "xctest_recorded_failure")
        }
        return recordedFailureResponse
      }
      if !hasRetried, shouldRetryCommand(command), shouldRetryResponse(response) {
        NSLog(
          "AGENT_DEVICE_RUNNER_RETRY command=%@ reason=response_unavailable",
          command.command.rawValue
        )
        hasRetried = true
        try runMainThreadWork(
          command: command,
          timeout: mainThreadExecutionTimeout,
          timeoutError: mainThreadExecutionTimeoutError
        ) {
          self.invalidateCachedTarget(reason: "response_unavailable")
          self.sleepFor(self.retryCooldown)
        }
        continue
      }
      return response
    }
  }

  private func executeSnapshotDispatchedOnce(command: Command) throws -> Response {
    let preparation = try runMainThreadWork(
      command: command,
      timeout: mainThreadExecutionTimeout,
      timeoutError: mainThreadExecutionTimeoutError
    ) {
      try self.prepareActiveCommandContextSafely(command: command)
    }
    switch preparation {
    case .response(let response):
      return response
    case .context(let context):
      return try executeSnapshotPrepared(command: command, activeApp: context.app)
    }
  }

  private func executeSnapshotPrepared(command: Command, activeApp: XCUIApplication) throws -> Response {
    let options = SnapshotOptions(
      interactiveOnly: command.interactiveOnly ?? false,
      depth: command.depth,
      scope: command.scope,
      raw: command.raw ?? false
    )
    do {
      let payload: DataPayload
      if options.raw {
        payload = try snapshotRaw(app: activeApp, options: options)
      } else {
        payload = try snapshotFast(app: activeApp, options: options)
      }
      setNeedsPostSnapshotInteractionDelay()
      return Response(ok: true, data: payload)
    } catch let failure as SnapshotCaptureFailure {
      invalidateCachedTargetAfterSnapshotFailure()
      return Response(
        ok: false,
        error: ErrorPayload(
          code: failure.code,
          message: failure.message,
          hint: failure.hint
        )
      )
    }
  }

  private func setNeedsPostSnapshotInteractionDelay() {
    if Thread.isMainThread {
      needsPostSnapshotInteractionDelay = true
      return
    }
    guard !hasAbandonedTreeCapture() else {
      NSLog("AGENT_DEVICE_RUNNER_POST_SNAPSHOT_DELAY_MARK_SKIPPED_XCTEST_OCCUPIED")
      return
    }
    do {
      try runMainThreadWork(
        command: nil,
        timeout: 1,
        timeoutError: mainThreadExecutionTimeoutError
      ) {
        self.needsPostSnapshotInteractionDelay = true
      }
    } catch {
      NSLog("AGENT_DEVICE_RUNNER_POST_SNAPSHOT_DELAY_MARK_FAILED=%@", String(describing: error))
    }
  }

  private func invalidateCachedTargetAfterSnapshotFailure() {
    if Thread.isMainThread {
      invalidateCachedTarget(reason: "ax_snapshot_failure")
      return
    }
    do {
      try runMainThreadWork(
        command: nil,
        timeout: 1,
        timeoutError: mainThreadExecutionTimeoutError
      ) {
        self.invalidateCachedTarget(reason: "ax_snapshot_failure")
      }
    } catch {
      NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_INVALIDATION_FAILED=%@", String(describing: error))
    }
  }

  private func prepareActiveCommandContextSafely(command: Command) throws -> ActiveCommandPreparation {
    var preparation: ActiveCommandPreparation?
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      preparation = self.prepareActiveCommandContext(command: command)
    })
    if let exceptionMessage {
      throw NSError(
        domain: RunnerErrorDomain.exception,
        code: RunnerErrorCode.objcException,
        userInfo: [NSLocalizedDescriptionKey: exceptionMessage]
      )
    }
    guard let preparation else {
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.commandReturnedNoResponse,
        userInfo: [NSLocalizedDescriptionKey: "snapshot preflight returned no response"]
      )
    }
    return preparation
  }

  private func executeOnMain(command: Command, alertDeadline: Date?) throws -> Response {
    let preparation = prepareActiveCommandContext(command: command)
    let activeApp: XCUIApplication
    switch preparation {
    case .response(let response):
      return response
    case .context(let context):
      activeApp = context.app
    }

    switch command.command {
    case .status:
      return executeStatus(command: command)
    case .shutdown:
      stopRecordingIfNeeded()
      return Response(ok: true, data: DataPayload(message: "shutdown"))
    case .recordStart:
      guard
        let requestedOutPath = command.outPath?.trimmingCharacters(in: .whitespacesAndNewlines),
        !requestedOutPath.isEmpty
      else {
        return Response(ok: false, error: ErrorPayload(message: "recordStart requires outPath"))
      }
      let hasAppBundleId = !(command.appBundleId?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .isEmpty ?? true)
      guard hasAppBundleId else {
        return Response(ok: false, error: ErrorPayload(message: "recordStart requires appBundleId"))
      }
      if activeRecording != nil {
        return Response(ok: false, error: ErrorPayload(message: "recording already in progress"))
      }
      if let requestedFps = command.fps, (requestedFps < minRecordingFps || requestedFps > maxRecordingFps) {
        return Response(ok: false, error: ErrorPayload(message: "recordStart fps must be between \(minRecordingFps) and \(maxRecordingFps)"))
      }
      if let requestedMaxSize = command.maxSize, requestedMaxSize < 1 {
        return Response(ok: false, error: ErrorPayload(message: "recordStart maxSize must be a positive integer"))
      }
      do {
        let resolvedOutPath = resolveRecordingOutPath(requestedOutPath)
        let fpsLabel = command.fps.map(String.init) ?? String(RunnerTests.defaultRecordingFps)
        let maxSizeLabel = command.maxSize.map(String.init) ?? "native"
        NSLog(
          "AGENT_DEVICE_RUNNER_RECORD_START requestedOutPath=%@ resolvedOutPath=%@ fps=%@ maxSize=%@",
          requestedOutPath,
          resolvedOutPath,
          fpsLabel,
          maxSizeLabel
        )
        let recorder = ScreenRecorder(
          outputPath: resolvedOutPath,
          fps: command.fps.map { Int32($0) },
          maxSize: command.maxSize
        )
        try recorder.start { [weak self] in
          return self?.captureRunnerFrame()
        }
        activeRecording = recorder
        return Response(ok: true, data: DataPayload(message: "recording started"))
      } catch {
        activeRecording = nil
        return Response(ok: false, error: ErrorPayload(message: "failed to start recording: \(error.localizedDescription)"))
      }
    case .recordStop:
      guard let recorder = activeRecording else {
        return Response(ok: false, error: ErrorPayload(message: "no active recording"))
      }
      do {
        try recorder.stop()
        activeRecording = nil
        return Response(ok: true, data: DataPayload(message: "recording stopped"))
      } catch {
        activeRecording = nil
        return Response(ok: false, error: ErrorPayload(message: "failed to stop recording: \(error.localizedDescription)"))
      }
    case .uptime:
      return executeUptime()
    default:
      break
    }
    return try executeOnMainPrepared(
      command: command,
      activeApp: activeApp,
      alertDeadline: alertDeadline
    )
  }

  private func prepareActiveCommandContext(command: Command) -> ActiveCommandPreparation {
    var activeApp = currentApp ?? app
    if shouldSkipAppActivationPreflight(command) {
      activeApp = resolveAppWithoutActivation(command: command)
    } else if !isRunnerLifecycleCommand(command.command) {
      let normalizedBundleId = command.appBundleId?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      let requestedBundleId = (normalizedBundleId?.isEmpty == true) ? nil : normalizedBundleId
      if let bundleId = requestedBundleId {
        if currentBundleId != bundleId || currentApp == nil {
          _ = activateTarget(bundleId: bundleId, reason: "bundle_changed")
        } else {
          refreshCachedTargetIfProcessChanged(bundleId: bundleId)
        }
      } else {
        // Do not reuse stale bundle targets when the caller does not explicitly request one.
        invalidateCachedTarget(reason: "missing_app_bundle")
      }

      activeApp = currentApp ?? app
      if let bundleId = requestedBundleId, targetNeedsActivation(activeApp) {
        activeApp = activateTarget(bundleId: bundleId, reason: "stale_target")
      } else if requestedBundleId == nil, targetNeedsActivation(activeApp) {
        ensureRunnerHostAppActive(reason: "missing_app_bundle")
        activeApp = app
      }

      let skipExistenceWait = canUseFastForegroundAppGuard(
        activeApp: activeApp,
        requestedBundleId: requestedBundleId,
        command: command.command
      )
      if !skipExistenceWait && !activeApp.waitForExistence(timeout: appExistenceTimeout) {
        if let bundleId = requestedBundleId {
          activeApp = activateTarget(bundleId: bundleId, reason: "missing_after_wait")
          guard activeApp.waitForExistence(timeout: appExistenceTimeout) else {
            return .response(Response(ok: false, error: ErrorPayload(message: "app '\(bundleId)' is not available")))
          }
        } else {
          return .response(Response(ok: false, error: ErrorPayload(message: "runner app is not available")))
        }
      }

      if isInteractionCommand(command.command) {
        if let bundleId = requestedBundleId, activeApp.state != .runningForeground {
          activeApp = activateTarget(bundleId: bundleId, reason: "interaction_foreground_guard")
        } else if requestedBundleId == nil, activeApp.state != .runningForeground {
          ensureRunnerHostAppActive(reason: "interaction_missing_app_bundle")
          activeApp = app
        }
        let skipInteractionExistenceWait = canUseFastForegroundAppGuard(
          activeApp: activeApp,
          requestedBundleId: requestedBundleId,
          command: command.command
        )
        if !skipInteractionExistenceWait && !activeApp.waitForExistence(timeout: 2) {
          if let bundleId = requestedBundleId {
            return .response(Response(ok: false, error: ErrorPayload(message: "app '\(bundleId)' is not available")))
          }
          return .response(Response(ok: false, error: ErrorPayload(message: "runner app is not available")))
        }
        applyInteractionStabilizationIfNeeded()
      }
    }
    return .context(ActiveCommandContext(app: activeApp))
  }

  private func executeOnMainPrepared(
    command: Command,
    activeApp: XCUIApplication,
    alertDeadline: Date? = nil
  ) throws -> Response {
    var activeApp = activeApp
    switch command.command {
    case .status, .shutdown, .recordStart, .recordStop, .uptime:
      return Response(
        ok: false,
        error: ErrorPayload(
          code: "UNSUPPORTED_OPERATION",
          message: "\(command.command.rawValue) cannot be executed through the prepared command path"
        )
      )
    case .tap:
      if let selectorKey = command.selectorKey, let selectorValue = command.selectorValue {
        let match = findElement(
          app: activeApp,
          selectorKey: selectorKey,
          selectorValue: selectorValue,
          allowNonHittableFallback: command.allowNonHittableCoordinateFallback == true
        )
        if match.isAmbiguous {
          return Response(ok: false, error: ErrorPayload(code: "AMBIGUOUS_MATCH", message: "selector matched multiple elements"))
        }
        if let element = match.element {
          let frame = element.frame
          // XCTest reports closed-drawer/off-viewport items as hittable, then
          // "taps" coordinates outside the visible window as a silent no-op.
          // Refuse instead; the daemon falls back to tree-based resolution,
          // which can prefer an on-screen candidate or explain the off-screen
          // state. The check uses the main window frame, not app.frame: on RN
          // apps app.frame unions transformed subtrees (a closed drawer at
          // negative x), so it happily "contains" unreachable coordinates.
          // The DECISION lives in TapPointPolicy (golden parity table with the
          // TS twin); onScreenWindowFrame only supplies the frame.
          if !match.usedNonHittableFallback
            && !TapPointPolicy.isAllowed(
              elementFrame: frame,
              windowFrame: onScreenWindowFrame(app: activeApp)
            ) {
            return Response(ok: false, error: ErrorPayload(
              code: "ELEMENT_OFFSCREEN",
              message: "element resolved off-screen at (\(Int(frame.midX)), \(Int(frame.midY)))"))
          }
          let isTextEntry = isTextEntryElement(element)
          let touchFrame = frame.isEmpty
            ? nil
            : resolvedTouchVisualizationFrame(app: activeApp, x: frame.midX, y: frame.midY)
          let (timing, outcome) = performGesture(activeApp) {
            if match.usedNonHittableFallback {
              // Maestro compatibility: RN E2E backdoor controls can be 1x1 and
              // reported non-hittable by XCTest, while Maestro still taps their
              // resolved bounds. Keep this behind the explicit replay-only flag.
              return tapAt(app: activeApp, x: frame.midX, y: frame.midY)
            }
            return activateElement(app: activeApp, element: element, action: "tap by selector")
          }
          if let response = unsupportedResponse(for: outcome) {
            return response
          }
          if isTextEntry {
            waitForTextEntryReadinessAfterTap(app: activeApp, element: element)
          }
          return gestureResponse(
            message: match.usedNonHittableFallback ? "tapped via non-hittable coordinate fallback" : "tapped",
            timing: timing,
            frame: .touch(touchFrame),
            maestroNonHittableCoordinateFallbackUsed:
              command.allowNonHittableCoordinateFallback == true
              ? match.usedNonHittableFallback
              : nil
          )
        }
        return Response(ok: false, error: ErrorPayload(code: "ELEMENT_NOT_FOUND", message: "element not found"))
      }
      if let x = command.x, let y = command.y {
        var fallback: GestureFallback?
        if command.synthesized == true {
          let policyKind = SynthesizedGesturePolicyKind.coordinateTap
          let context = synthesizedCoordinateContext(policy: synthesizedGesturePolicy(policyKind))
          let (timing, outcome) = performGesture(activeApp, idleTimeout: false) {
            synthesizedTapAt(app: activeApp, x: x, y: y, context: context)
          }
          if case .performed = outcome {
            logSynthesizedGesturePolicyDecision(kind: policyKind, context: context, fallbackAttempted: false)
            return gestureResponse(message: "tapped", timing: timing)
          }
          logSynthesizedGesturePolicyDecision(kind: policyKind, context: context, fallbackAttempted: true)
          fallback = gestureFallback(strategy: "xctest-coordinate-tap", from: outcome)
        }
        let touchFrame = resolvedTouchVisualizationFrame(app: activeApp, x: x, y: y)
        let (timing, outcome) = performGesture(activeApp) { tapAt(app: activeApp, x: x, y: y) }
        if let response = unsupportedResponse(for: outcome) {
          return response
        }
        return gestureResponse(
          message: "tapped",
          timing: timing,
          frame: .touch(touchFrame),
          fallback: fallback
        )
      }
      return Response(ok: false, error: ErrorPayload(message: "tap requires a selector or x/y"))
    case .mouseClick:
      guard let x = command.x, let y = command.y else {
        return Response(ok: false, error: ErrorPayload(message: "mouseClick requires x and y"))
      }
      let touchFrame = resolvedTouchVisualizationFrame(app: activeApp, x: x, y: y)
      do {
        // mouseClick throws (it has no RunnerInteractionOutcome), so it keeps raw measureGesture
        // and only routes the success payload through gestureResponse.
        var clickError: Error?
        let timing = measureGesture {
          do {
            try mouseClickAt(app: activeApp, x: x, y: y, button: command.button ?? "primary")
          } catch {
            clickError = error
          }
        }
        if let clickError {
          throw clickError
        }
        return gestureResponse(message: "clicked", timing: timing, frame: .touch(touchFrame))
      } catch {
        return Response(ok: false, error: ErrorPayload(message: error.localizedDescription))
      }
    case .longPress:
      guard let x = command.x, let y = command.y else {
        return Response(ok: false, error: ErrorPayload(message: "longPress requires x and y"))
      }
      let duration = (command.durationMs ?? 800) / 1000.0
      let touchFrame = resolvedTouchVisualizationFrame(app: activeApp, x: x, y: y)
      let (timing, outcome) = performGesture(activeApp) {
        longPressAt(app: activeApp, x: x, y: y, duration: duration)
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return gestureResponse(message: "long pressed", timing: timing, frame: .touch(touchFrame))
    case .drag:
      guard let x = command.x, let y = command.y, let x2 = command.x2, let y2 = command.y2 else {
        return Response(ok: false, error: ErrorPayload(message: "drag requires x, y, x2, and y2"))
      }
      return executeDragGesture(
        activeApp: activeApp,
        x: x,
        y: y,
        x2: x2,
        y2: y2,
        durationMs: command.durationMs,
        synthesized: command.synthesized == true,
        message: "dragged",
        synthesizedPolicyKind: .synthesizedDrag
      )
    case .scroll:
      // Fused frame-resolve + drag scroll for non-tvOS. On iOS this intentionally stays on the
      // AX-free synthesized coordinate lane so scroll keeps working when XCTest cannot serialize
      // the accessibility tree.
      guard let direction = command.direction,
        direction == "up" || direction == "down" || direction == "left" || direction == "right"
      else {
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "INVALID_ARGS",
            message: "scroll requires direction up|down|left|right"
          )
        )
      }
      let scrollPolicyKind = SynthesizedGesturePolicyKind.scroll
      guard let scrollContext = synthesizedCoordinateContext(policy: synthesizedGesturePolicy(scrollPolicyKind)) else {
        return Response(
          ok: false,
          error: ErrorPayload(message: "scroll could not resolve a usable interaction frame")
        )
      }
      let frame = scrollReferenceFrame(app: activeApp, context: scrollContext)
      guard frame.width > 0, frame.height > 0 else {
        return Response(
          ok: false,
          error: ErrorPayload(message: "scroll could not resolve a usable interaction frame")
        )
      }
      guard let plan = runnerScrollGesturePlan(
        direction: direction,
        amount: command.amount,
        pixels: command.pixels,
        referenceWidth: frame.width,
        referenceHeight: frame.height
      ) else {
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "INVALID_ARGS",
            message: "scroll could not compute a gesture plan"
          )
        )
      }
      if let durationMs = command.durationMs,
        durationMs.isFinite == false || durationMs < 0 || durationMs > 10000
      {
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "INVALID_ARGS",
            message: "scroll durationMs must be between 0 and 10000"
          )
        )
      }
      return executeDragGesture(
        activeApp: activeApp,
        x: frame.minX + plan.x1,
        y: frame.minY + plan.y1,
        x2: frame.minX + plan.x2,
        y2: frame.minY + plan.y2,
        durationMs: command.durationMs,
        synthesized: shouldUseSynthesizedScrollPath(),
        message: "scrolled",
        synthesizedContext: scrollContext.withReferenceFrame(frame),
        synthesizedPolicyKind: scrollPolicyKind
      )
    case .desktopScroll:
      guard let direction = command.direction,
        direction == "up" || direction == "down" || direction == "left" || direction == "right"
      else {
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "INVALID_ARGS",
            message: "desktopScroll requires direction up|down|left|right"
          )
        )
      }
      let appFrame = activeApp.frame
      let frame = resolvedTouchReferenceFrame(app: activeApp, appFrame: appFrame)
      guard frame.width > 0, frame.height > 0 else {
        return Response(
          ok: false,
          error: ErrorPayload(message: "desktopScroll could not resolve a usable interaction frame")
        )
      }
      guard let plan = runnerScrollGesturePlan(
        direction: direction,
        amount: command.amount,
        pixels: command.pixels,
        referenceWidth: frame.width,
        referenceHeight: frame.height
      ) else {
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "INVALID_ARGS",
            message: "desktopScroll could not compute a wheel plan"
          )
        )
      }
      let x = frame.midX
      let y = frame.midY
      let localX = x - (appFrame.isEmpty ? frame.minX : appFrame.minX)
      let localY = y - (appFrame.isEmpty ? frame.minY : appFrame.minY)
      if let durationMs = command.durationMs,
        durationMs.isFinite == false || durationMs < 0 || durationMs > 10000
      {
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "INVALID_ARGS",
            message: "desktopScroll durationMs must be between 0 and 10000"
          )
        )
      }
      let touchFrame = resolvedTouchVisualizationFrame(
        app: activeApp,
        x: localX,
        y: localY
      )
      do {
        var scrollError: Error?
        let timing = measureGesture {
          do {
            try desktopScrollAt(
              app: activeApp,
              x: x,
              y: y,
              direction: direction,
              pixels: plan.travelPixels,
              durationMs: command.durationMs
            )
          } catch {
            scrollError = error
          }
        }
        if let scrollError {
          throw scrollError
        }
        return gestureResponse(message: "scrolled", timing: timing, frame: .touch(touchFrame))
      } catch {
        return Response(ok: false, error: ErrorPayload(message: error.localizedDescription))
      }
    case .remotePress:
      guard let button = tvRemoteButton(from: command.remoteButton) else {
        return Response(ok: false, error: ErrorPayload(message: "remotePress requires remoteButton"))
      }
      let duration = (command.durationMs ?? 0) / 1000.0
      guard pressTvRemote(button, duration: duration) else {
        return Response(
          ok: false,
          error: ErrorPayload(code: "UNSUPPORTED_OPERATION", message: "remotePress is only supported on tvOS")
        )
      }
      return Response(ok: true, data: DataPayload(message: "remote pressed"))
    case .type:
      var response: Response?
      withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
        response = executeTypeCommand(activeApp: activeApp, command: command)
      }
      return response ?? Response(ok: false, error: ErrorPayload(message: "type produced no response"))
    case .swipe:
      guard let direction = command.direction else {
        return Response(ok: false, error: ErrorPayload(message: "swipe requires direction"))
      }
      // swipe returns an optional frame (tvOS-only) rather than a RunnerInteractionOutcome, so it
      // keeps raw measureGesture and only routes the success payload through gestureResponse.
      var executedFrame: DragVisualizationFrame?
      let timing = measureGesture {
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          executedFrame = swipe(app: activeApp, direction: direction)
        }
      }
      guard let dragFrame = executedFrame else {
        return Response(ok: false, error: ErrorPayload(message: "swipe is only supported on tvOS"))
      }
      return gestureResponse(message: "swiped", timing: timing, frame: .drag(dragFrame))
    case .findText:
      guard let text = command.text else {
        return Response(ok: false, error: ErrorPayload(message: "findText requires text"))
      }
      let found = findElement(app: activeApp, text: text) != nil
      return Response(ok: true, data: DataPayload(found: found))
    case .querySelector:
      guard let selectorKey = command.selectorKey, let selectorValue = command.selectorValue else {
        return Response(ok: false, error: ErrorPayload(message: "querySelector requires selectorKey and selectorValue"))
      }
      return queryElement(app: activeApp, selectorKey: selectorKey, selectorValue: selectorValue)
    case .readText:
      guard let x = command.x, let y = command.y else {
        return Response(ok: false, error: ErrorPayload(message: "readText requires x and y"))
      }
      guard let text = readTextAt(app: activeApp, x: x, y: y) else {
        return Response(ok: false, error: ErrorPayload(message: "readText did not resolve text"))
      }
      return Response(ok: true, data: DataPayload(text: text))
    case .snapshot:
      return try executeSnapshotPrepared(command: command, activeApp: activeApp)
    case .screenshot:
      let screenshot: XCUIScreenshot
#if os(macOS)
      // macOS keeps the app-targeted capture behavior for window-level screenshots.
      if let bundleId = command.appBundleId, !bundleId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        let targetApp = XCUIApplication(bundleIdentifier: bundleId)
        targetApp.activate()
        activeApp = targetApp
        // Brief wait for the app transition animation to complete
        sleepFor(0.5)
      }
      if command.fullscreen == true {
        screenshot = XCUIScreen.main.screenshot()
      } else if let bundleId = command.appBundleId, !bundleId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        screenshot = screenshotRoot(app: activeApp).screenshot()
      } else {
        screenshot = XCUIScreen.main.screenshot()
      }
#else
      screenshot = XCUIScreen.main.screenshot()
#endif
      guard let pngData = runnerPngData(for: screenshot.image) else {
        return Response(ok: false, error: ErrorPayload(message: "Failed to encode screenshot as PNG"))
      }
      let fileName = "screenshot-\(Int(Date().timeIntervalSince1970 * 1000)).png"
      let filePath = (NSTemporaryDirectory() as NSString).appendingPathComponent(fileName)
      do {
        try pngData.write(to: URL(fileURLWithPath: filePath))
      } catch {
        return Response(ok: false, error: ErrorPayload(message: "Failed to write screenshot: \(error.localizedDescription)"))
      }
#if os(macOS)
      return Response(ok: true, data: DataPayload(message: filePath))
#else
      // Return path relative to app container root (tmp/ maps to NSTemporaryDirectory)
      return Response(ok: true, data: DataPayload(message: "tmp/\(fileName)"))
#endif
    case .back, .backInApp:
      if tapInAppBackControl(app: activeApp) {
        let message = command.command == .back ? "back" : "backInApp"
        return Response(ok: true, data: DataPayload(message: message))
      }
      return Response(ok: false, error: ErrorPayload(message: "in-app back control is not available"))
    case .backSystem:
      if performSystemBackAction(app: activeApp) {
        return Response(ok: true, data: DataPayload(message: "backSystem"))
      }
      return Response(ok: false, error: ErrorPayload(message: "system back is not available"))
    case .home:
      pressHomeButton()
      return Response(ok: true, data: DataPayload(message: "home"))
    case .rotate:
      guard let orientation = command.orientation?.trimmingCharacters(in: .whitespacesAndNewlines),
        !orientation.isEmpty
      else {
        return Response(ok: false, error: ErrorPayload(message: "rotate requires orientation"))
      }
      if rotateDevice(to: orientation) {
        return Response(
          ok: true,
          data: DataPayload(message: "rotate", orientation: orientation)
        )
      }
      return Response(
        ok: false,
        error: ErrorPayload(message: "unsupported rotate orientation: \(orientation)")
      )
    case .appSwitcher:
      performAppSwitcherGesture(app: activeApp)
      return Response(ok: true, data: DataPayload(message: "appSwitcher"))
    case .keyboardDismiss:
      let result = dismissKeyboard(app: activeApp)
      if result.wasVisible && !result.dismissed {
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "UNSUPPORTED_OPERATION",
            message: "Unable to dismiss the iOS keyboard without a safe native dismiss control",
            hint:
              "The on-screen keyboard usually does not block agent-device interactions: press the next target directly instead of retrying dismiss. If that press fails or reports no visible effect, scroll the target into view, or use keyboard enter to press the return key when submission is wanted."
          )
        )
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "keyboardDismiss",
          visible: result.visible,
          wasVisible: result.wasVisible,
          dismissed: result.dismissed
        )
      )
    case .keyboardReturn:
      let result = pressKeyboardReturn(app: activeApp)
      if !result.pressed {
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "UNSUPPORTED_OPERATION",
            message: "Unable to press the iOS keyboard return key"
          )
        )
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "keyboardReturn",
          visible: result.visible,
          wasVisible: result.wasVisible
        )
      )
    case .alert:
      let action = (command.action ?? "get").lowercased()
      let deadline = alertDeadline ?? Date().addingTimeInterval(
        Self.alertCommandTimeout(timeoutMs: command.timeoutMs)
      )
      guard let alert = resolveAlert(app: activeApp, deadline: deadline) else {
        return Response(ok: false, error: ErrorPayload(message: "alert not found"))
      }
      return handleAlert(alert, action: action, deadline: deadline)
    case .gesture:
      guard let plan = command.gesturePlan else {
        return Response(
          ok: false,
          error: ErrorPayload(code: "INVALID_ARGS", message: "gesture requires gesturePlan")
        )
      }
      if let validationError = plannedGestureValidationError(plan) {
        return Response(
          ok: false,
          error: ErrorPayload(code: "INVALID_ARGS", message: validationError)
        )
      }
      if plannedGestureExecution(for: plan) == .fastSwipe {
        // Validation above guarantees a non-empty, single-pointer path for this execution kind.
        let first = plan.pointers[0].samples.first!.point
        let last = plan.pointers[0].samples.last!.point
        return canonicalPlannedGestureResponse(
          executeDragGesture(
            activeApp: activeApp,
            x: first.x,
            y: first.y,
            x2: last.x,
            y2: last.y,
            durationMs: plan.durationMs,
            synthesized: true,
            message: plan.intent,
            synthesizedPolicyKind: .synthesizedDrag,
            synthesizedProfile: .fastSwipe
          )
        )
      }
      let (timing, outcome) = performGesture(activeApp, idleTimeout: false) {
        sampledPlannedGesture(app: activeApp, plan: plan)
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return gestureResponse(message: plan.intent, timing: timing)
    case .gestureViewport:
      let frame = resolvedTouchReferenceFrame(app: activeApp, appFrame: activeApp.frame)
      guard !frame.isNull, !frame.isInfinite, !frame.isEmpty else {
        return Response(ok: false, error: ErrorPayload(code: "COMMAND_FAILED", message: "Active app interaction viewport is unavailable"))
      }
      return Response(ok: true, data: DataPayload(message: "gestureViewport", x: frame.minX, y: frame.minY, x2: frame.width, y2: frame.height))
    case .sequence:
      return executeSequence(command: command, activeApp: activeApp)
    }
  }

  /// Shared drag execution for `.drag` and the fused `.scroll`. The iOS synthesized lane keeps
  /// each command's fallback policy explicit: scroll requires private synthesis, while explicit
  /// synthesized drag can still use the coordinate fallback unless AX is known unavailable.
  private func executeDragGesture(
    activeApp: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    durationMs: Double?,
    synthesized: Bool,
    message: String,
    synthesizedContext: SynthesizedCoordinateContext? = nil,
    synthesizedPolicyKind: SynthesizedGesturePolicyKind,
    synthesizedProfile: SynthesizedDragProfile = .continuous
  ) -> Response {
    let commandName = dragCommandName(message: message)
    guard x.isFinite, y.isFinite, x2.isFinite, y2.isFinite else {
      return Response(
        ok: false,
        error: ErrorPayload(code: "INVALID_ARGS", message: "\(commandName) requires finite coordinates")
      )
    }
    if synthesized, let synthesizedResponse = executeSynthesizedDragGesture(
      activeApp: activeApp,
      x: x,
      y: y,
      x2: x2,
      y2: y2,
      durationMs: durationMs,
      message: message,
      context: synthesizedContext,
      policyKind: synthesizedPolicyKind,
      profile: synthesizedProfile
    ) {
      return synthesizedResponse
    }
    let dragPoints = keyboardAvoidingDragPoints(app: activeApp, x: x, y: y, x2: x2, y2: y2)
    let dragFrame = resolvedDragVisualizationFrame(
      app: activeApp,
      x: dragPoints.x,
      y: dragPoints.y,
      x2: dragPoints.x2,
      y2: dragPoints.y2
    )
    var fallback: GestureFallback?
    if synthesized {
      let durationMs = min(max(durationMs ?? 250, 16), 10000)
      let context = synthesizedCoordinateContext(policy: synthesizedGesturePolicy(synthesizedPolicyKind))
      let (timing, outcome) = performGesture(activeApp, idleTimeout: false) {
        synthesizedDragAt(
          app: activeApp,
          x: dragPoints.x,
          y: dragPoints.y,
          x2: dragPoints.x2,
          y2: dragPoints.y2,
          durationMs: durationMs,
          profile: synthesizedProfile,
          context: context
        )
      }
      if case .performed = outcome {
        return gestureResponse(message: message, timing: timing, frame: .drag(dragFrame))
      }
      fallback = gestureFallback(strategy: "xctest-coordinate-drag", from: outcome)
    }
    let holdDuration = synthesized
      ? synthesizedSwipeFallbackHoldDuration(durationMs: durationMs ?? 250)
      : coordinateDragHoldDuration()
    let (timing, outcome) = performGesture(activeApp) {
      dragAt(
        app: activeApp,
        x: dragPoints.x,
        y: dragPoints.y,
        x2: dragPoints.x2,
        y2: dragPoints.y2,
        holdDuration: holdDuration
      )
    }
    if let response = unsupportedResponse(for: outcome) {
      return response
    }
    return gestureResponse(
      message: message,
      timing: timing,
      frame: .drag(dragFrame),
      fallback: fallback
    )
  }

  private func executeSynthesizedDragGesture(
    activeApp: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    durationMs: Double?,
    message: String,
    context: SynthesizedCoordinateContext?,
    policyKind: SynthesizedGesturePolicyKind,
    profile: SynthesizedDragProfile
  ) -> Response? {
#if os(iOS)
    let policy = synthesizedGesturePolicy(policyKind)
    let context = context ?? synthesizedCoordinateContext(policy: policy)
    guard let plan = axFreeSynthesizedDragPlan(
      app: activeApp,
      x: x,
      y: y,
      x2: x2,
      y2: y2,
      context: context
    )
    else {
      if context?.allowsXCTestCoordinateFallback == true {
        logSynthesizedGesturePolicyDecision(kind: policyKind, context: context, fallbackAttempted: true)
        return executeCoordinateDragFallback(
          activeApp: activeApp,
          x: x,
          y: y,
          x2: x2,
          y2: y2,
          durationMs: durationMs,
          message: message,
          fallback: nil
        )
      }
      logSynthesizedGesturePolicyDecision(kind: policyKind, context: context, fallbackAttempted: false)
      return Response(
        ok: false,
        error: ErrorPayload(
          code: "INVALID_ARGS",
          message: "\(dragCommandName(message: message)) could not resolve a finite synthesized coordinate frame"
        )
      )
    }
    let durationMs = min(max(durationMs ?? 250, 16), 10000)
    let dragFrame = axFreeDragVisualizationFrame(
      x: plan.points.x,
      y: plan.points.y,
      x2: plan.points.x2,
      y2: plan.points.y2,
      referenceFrame: plan.referenceFrame
    )
    let (timing, outcome) = performGesture(activeApp, idleTimeout: false) {
      synthesizedDragAt(
        app: activeApp,
        x: plan.points.x,
        y: plan.points.y,
        x2: plan.points.x2,
        y2: plan.points.y2,
        durationMs: durationMs,
        profile: profile,
        context: plan.context
      )
    }
    if case .performed = outcome {
      logSynthesizedGesturePolicyDecision(kind: policyKind, context: plan.context, fallbackAttempted: false)
      return gestureResponse(message: message, timing: timing, frame: .drag(dragFrame))
    }
    if plan.context.allowsXCTestCoordinateFallback {
      logSynthesizedGesturePolicyDecision(kind: policyKind, context: plan.context, fallbackAttempted: true)
      return executeCoordinateDragFallback(
        activeApp: activeApp,
        x: plan.points.x,
        y: plan.points.y,
        x2: plan.points.x2,
        y2: plan.points.y2,
        durationMs: durationMs,
        message: message,
        fallback: gestureFallback(strategy: "xctest-coordinate-drag", from: outcome)
      )
    }
    logSynthesizedGesturePolicyDecision(kind: policyKind, context: plan.context, fallbackAttempted: false)
    return unsupportedResponse(for: outcome)
#else
    return nil
#endif
  }

  private func executeCoordinateDragFallback(
    activeApp: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    durationMs: Double?,
    message: String,
    fallback: GestureFallback?
  ) -> Response {
    let dragPoints = keyboardAvoidingDragPoints(app: activeApp, x: x, y: y, x2: x2, y2: y2)
    let dragFrame = resolvedDragVisualizationFrame(
      app: activeApp,
      x: dragPoints.x,
      y: dragPoints.y,
      x2: dragPoints.x2,
      y2: dragPoints.y2
    )
    let holdDuration = synthesizedSwipeFallbackHoldDuration(durationMs: durationMs ?? 250)
    let (timing, outcome) = performGesture(activeApp) {
      dragAt(
        app: activeApp,
        x: dragPoints.x,
        y: dragPoints.y,
        x2: dragPoints.x2,
        y2: dragPoints.y2,
        holdDuration: holdDuration
      )
    }
    if let response = unsupportedResponse(for: outcome) {
      return response
    }
    return gestureResponse(
      message: message,
      timing: timing,
      frame: .drag(dragFrame),
      fallback: fallback
    )
  }

  private func scrollReferenceFrame(app: XCUIApplication, context: SynthesizedCoordinateContext) -> CGRect {
#if os(iOS)
    return synthesizedFrameAvoidingKeyboardWhenAllowed(app: app, context: context)
#else
    return resolvedTouchReferenceFrame(app: app, appFrame: app.frame)
#endif
  }

  private func shouldUseSynthesizedScrollPath() -> Bool {
#if os(iOS)
    return true
#else
    return false
#endif
  }

  private func dragCommandName(message: String) -> String {
    return message == "scrolled" ? "scroll" : "drag"
  }

  private func currentXCTestFailureCount() -> Int {
    return testRun?.failureCount ?? 0
  }

  private func didRecordXCTestFailure(since failureCountBefore: Int) -> Bool {
    return currentXCTestFailureCount() > failureCountBefore
  }

  private func xctestRecordedFailureResponse(command: Command, response: Response) -> Response? {
    guard response.ok else { return nil }
    if response.data?.runnerFatal == true {
      return nil
    }
    guard !isReadOnlyCommand(command), !isRunnerLifecycleCommand(command.command) else {
      return nil
    }
    return Response(
      ok: false,
      error: ErrorPayload(
        code: "XCTEST_RECORDED_FAILURE",
        message: "XCTest recorded a failure while executing \(command.command.rawValue); the action may not have been performed.",
        hint: "The iOS runner session will be restarted. Retry after a fresh snapshot, or use screenshot plus coordinate commands when the accessibility tree is unavailable."
      )
    )
  }

  private func runnerCommandFixture(_ json: String) throws -> Command {
    try JSONDecoder().decode(Command.self, from: Data(json.utf8))
  }

  private func shouldSkipAppActivationPreflight(_ command: Command) -> Bool {
#if os(iOS)
    // Coordinate-only synthesized taps can run after an AX-fatal screen because they do not
    // need app activation, window lookup, keyboard lookup, or element resolution. Selector/text
    // interactions intentionally stay on the normal AX path because they need an element query.
    // Scroll/drag/sequence keep the normal foreground guard and stabilization path.
    guard command.text == nil, command.selectorKey == nil else { return false }
    guard hasCachedTargetForActivationSkip(command: command) else { return false }
    return command.command == .tap
      && command.synthesized == true
      && command.x != nil
      && command.y != nil
#else
    return false
#endif
  }

  private func hasCachedTargetForActivationSkip(command: Command) -> Bool {
    guard currentApp != nil else { return false }
    guard let bundleId = command.appBundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
      !bundleId.isEmpty
    else {
      return true
    }
    return currentBundleId == bundleId
  }

  private func resolveAppWithoutActivation(command: Command) -> XCUIApplication {
    guard let bundleId = command.appBundleId?
      .trimmingCharacters(in: .whitespacesAndNewlines),
      !bundleId.isEmpty
    else {
      return currentApp ?? app
    }
    if currentBundleId == bundleId, let currentApp {
      return currentApp
    }
    return XCUIApplication(bundleIdentifier: bundleId)
  }

  private func executeTypeCommand(activeApp: XCUIApplication, command: Command) -> Response {
    guard let text = command.text else {
      return Response(ok: false, error: ErrorPayload(message: "type requires text"))
    }
    let delaySeconds = Double(max(command.delayMs ?? 0, 0)) / 1000.0
    let textEntryMode = resolveTextEntryMode(command)
    let target: TextEntryTarget
    var maestroNonHittableCoordinateFallbackUsed: Bool?
    let focusStartedAt = Date()
    if let selectorKey = command.selectorKey, let selectorValue = command.selectorValue {
      let match = findElement(
        app: activeApp,
        selectorKey: selectorKey,
        selectorValue: selectorValue,
        allowNonHittableFallback: command.allowNonHittableCoordinateFallback == true
      )
      if match.isAmbiguous {
        return Response(ok: false, error: ErrorPayload(code: "AMBIGUOUS_MATCH", message: "selector matched multiple elements"))
      }
      guard let element = match.element else {
        return Response(ok: false, error: ErrorPayload(code: "NO_MATCH", message: "selector did not match an element"))
      }
      guard isTextEntryElement(element) else {
        return Response(ok: false, error: ErrorPayload(code: "INVALID_TARGET", message: "selector did not match a text input"))
      }
      if command.allowNonHittableCoordinateFallback == true {
        maestroNonHittableCoordinateFallbackUsed = match.usedNonHittableFallback
      }
      target = focusTextInputForTextEntry(app: activeApp, element: element)
    } else {
      target = focusTextInputForTextEntry(app: activeApp, x: command.x, y: command.y)
    }
    NSLog(
      "AGENT_DEVICE_RUNNER_TEXT_ENTRY_PHASE commandId=%@ phase=focus durationMs=%.1f chars=%d mode=%@",
      command.commandId ?? "",
      Date().timeIntervalSince(focusStartedAt) * 1000.0,
      text.count,
      textEntryModeName(textEntryMode)
    )
    if textEntryMode == .replacement {
      guard target.element != nil else {
        let message =
          (command.x != nil && command.y != nil)
          ? "no text input found at the provided coordinates to clear"
          : "no focused text input to clear"
        return Response(ok: false, error: ErrorPayload(message: message))
      }
    }
    let textResult = typeTextReliably(
      app: activeApp,
      target: target,
      text: text,
      delaySeconds: delaySeconds,
      repairMode: textEntryMode,
      commandId: command.commandId
    )
    if textResult.verified == false {
      let expected = textResult.expectedText ?? ""
      let observed = textResult.observedText ?? ""
      return Response(
        ok: false,
        error: ErrorPayload(
          code: "TEXT_ENTRY_MISMATCH",
          message: "text entry verification failed: expected \"\(expected)\", observed \"\(observed)\""
        )
      )
    }
    let point = target.refreshPoint
    let frame = activeApp.frame
    return Response(
      ok: true,
      data: DataPayload(
        message: textResult.repaired ? "typed after repair" : "typed",
        x: point.map { Double($0.x) },
        y: point.map { Double($0.y) },
        referenceWidth: frame.isEmpty ? nil : Double(frame.width),
        referenceHeight: frame.isEmpty ? nil : Double(frame.height),
        maestroNonHittableCoordinateFallbackUsed: maestroNonHittableCoordinateFallbackUsed
      )
    )
  }
}
