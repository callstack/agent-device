import XCTest

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
  /// gestures (pinch/rotate/transform) pass `false` because RunnerSynthesizedGesture governs its
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
    fallback: GestureFallback? = nil
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
        gestureFallbackHint: fallback?.hint
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
        gestureFallbackHint: fallback?.hint
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

  private func executeDispatched(command: Command) throws -> Response {
    if Thread.isMainThread {
      return try executeOnMainSafely(command: command)
    }
    var result: Result<Response, Error>?
    let semaphore = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
      do {
        result = .success(try self.executeOnMainSafely(command: command))
      } catch {
        result = .failure(error)
      }
      semaphore.signal()
    }
    let waitResult = semaphore.wait(timeout: .now() + mainThreadExecutionTimeout)
    if waitResult == .timedOut {
      // The main queue work may still be running; we stop waiting and report timeout.
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.mainThreadExecutionTimedOut,
        userInfo: [NSLocalizedDescriptionKey: "main thread execution timed out"]
      )
    }
    switch result {
    case .success(let response):
      return response
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

  // MARK: - Command Handling

  private func executeOnMainSafely(command: Command) throws -> Response {
    var hasRetried = false
    while true {
      var response: Response?
      var swiftError: Error?
      let failureCountBefore = currentXCTestFailureCount()
      let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
        do {
          response = try self.executeOnMain(command: command)
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

  private func executeOnMain(command: Command) throws -> Response {
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
        }
      } else {
        // Do not reuse stale bundle targets when the caller does not explicitly request one.
        currentApp = nil
        currentBundleId = nil
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
            return Response(ok: false, error: ErrorPayload(message: "app '\(bundleId)' is not available"))
          }
        } else {
          return Response(ok: false, error: ErrorPayload(message: "runner app is not available"))
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
            return Response(ok: false, error: ErrorPayload(message: "app '\(bundleId)' is not available"))
          }
          return Response(ok: false, error: ErrorPayload(message: "runner app is not available"))
        }
        applyInteractionStabilizationIfNeeded()
      }
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
          if !match.usedNonHittableFallback
            && !onScreenWindowFrame(app: activeApp).contains(CGPoint(x: frame.midX, y: frame.midY)) {
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
            frame: .touch(touchFrame)
          )
        }
        return Response(ok: false, error: ErrorPayload(code: "ELEMENT_NOT_FOUND", message: "element not found"))
      }
      if let text = command.text {
        if let element = findElement(app: activeApp, text: text) {
          let (timing, outcome) = performGesture(activeApp) {
            activateElement(app: activeApp, element: element, action: "tap by text")
          }
          if let response = unsupportedResponse(for: outcome) {
            return response
          }
          return gestureResponse(message: "tapped", timing: timing)
        }
        return Response(ok: false, error: ErrorPayload(message: "element not found"))
      }
      if let x = command.x, let y = command.y {
        var fallback: GestureFallback?
        if command.synthesized == true {
          let (timing, outcome) = performGesture(activeApp, idleTimeout: false) {
            synthesizedTapAt(app: activeApp, x: x, y: y)
          }
          if case .performed = outcome {
            return gestureResponse(message: "tapped", timing: timing)
          }
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
      return Response(ok: false, error: ErrorPayload(message: "tap requires text or x/y"))
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
        message: "dragged"
      )
    case .scroll:
      // Fused frame-resolve + drag scroll for non-tvOS. Resolves the interaction frame via
      // resolvedTouchReferenceFrame, computes drag endpoints with the Swift port of
      // buildScrollGesturePlan, then runs the same non-synthesized drag path scroll's drag used.
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
      let frame = resolvedTouchReferenceFrame(app: activeApp, appFrame: activeApp.frame)
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
        synthesized: command.durationMs != nil,
        message: "scrolled"
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
        needsPostSnapshotInteractionDelay = true
        return Response(ok: true, data: payload)
      } catch let failure as SnapshotCaptureFailure {
        invalidateCachedTarget(reason: "ax_snapshot_failure")
        // Other thrown errors fall through to executeOnMainSafely's generic error response.
        return Response(
          ok: false,
          error: ErrorPayload(
            code: failure.code,
            message: failure.message,
            hint: failure.hint
          )
        )
      }
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
            message: "Unable to dismiss the iOS keyboard without a safe native dismiss control"
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
      guard let alert = resolveAlert(app: activeApp) else {
        return Response(ok: false, error: ErrorPayload(message: "alert not found"))
      }
      return handleAlert(alert, action: action)
    case .pinch:
      guard let scale = command.scale, scale > 0 else {
        return Response(ok: false, error: ErrorPayload(message: "pinch requires scale > 0"))
      }
      let (timing, outcome) = performGesture(activeApp, idleTimeout: false) {
        pinch(app: activeApp, scale: scale, x: command.x, y: command.y)
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return gestureResponse(message: "pinched", timing: timing)
    case .sequence:
      return executeSequence(command: command, activeApp: activeApp)
    case .rotateGesture:
      guard let degrees = command.degrees, degrees.isFinite else {
        return Response(ok: false, error: ErrorPayload(message: "rotateGesture requires degrees"))
      }
      let velocity = command.velocity ?? (degrees >= 0 ? 1.0 : -1.0)
      guard velocity.isFinite && velocity != 0 else {
        return Response(ok: false, error: ErrorPayload(message: "rotateGesture velocity must be non-zero"))
      }
      let (timing, outcome) = performGesture(activeApp, idleTimeout: false) {
        rotateGesture(
          app: activeApp,
          degrees: degrees,
          x: command.x,
          y: command.y,
          velocity: velocity
        )
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return gestureResponse(message: "rotatedGesture", timing: timing)
    case .transformGesture:
      guard
        let x = command.x,
        let y = command.y,
        let dx = command.dx,
        let dy = command.dy,
        x.isFinite,
        y.isFinite,
        dx.isFinite,
        dy.isFinite
      else {
        return Response(ok: false, error: ErrorPayload(message: "transformGesture requires finite x y dx dy"))
      }
      guard let scale = command.scale, scale.isFinite, scale > 0 else {
        return Response(ok: false, error: ErrorPayload(message: "transformGesture requires scale > 0"))
      }
      guard let degrees = command.degrees, degrees.isFinite else {
        return Response(ok: false, error: ErrorPayload(message: "transformGesture requires finite degrees"))
      }
      let durationMs = command.durationMs ?? 300
      guard durationMs.isFinite && durationMs >= 16 else {
        return Response(ok: false, error: ErrorPayload(message: "transformGesture durationMs must be >= 16"))
      }
      let (timing, outcome) = performGesture(activeApp, idleTimeout: false) {
        transformGesture(
          app: activeApp,
          x: x,
          y: y,
          dx: dx,
          dy: dy,
          scale: scale,
          degrees: degrees,
          durationMs: durationMs
        )
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return gestureResponse(message: "transformedGesture", timing: timing)
    }
  }

  /// Shared drag execution for `.drag` and the fused `.scroll`. Mirrors the original `.drag` body
  /// exactly: keyboardAvoidingDragPoints -> resolvedDragVisualizationFrame -> synthesized branch
  /// (16-10000ms clamp) or non-synthesized dragAt with coordinateDragHoldDuration ->
  /// gestureResponse(.drag). `.scroll` uses the synthesized path only when a duration is requested.
  private func executeDragGesture(
    activeApp: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    durationMs: Double?,
    synthesized: Bool,
    message: String
  ) -> Response {
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
    // Coordinate-only synthesized taps can run after an AX-fatal screen because they do not need
    // app activation, window lookup, keyboard lookup, or element resolution. Selector/text taps
    // intentionally stay on the normal AX path because they need an element query.
    return command.command == .tap
      && command.synthesized == true
      && command.x != nil
      && command.y != nil
      && command.text == nil
      && command.selectorKey == nil
#else
    return false
#endif
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
      target = focusTextInputForTextEntry(app: activeApp, element: element)
    } else {
      target = focusTextInputForTextEntry(app: activeApp, x: command.x, y: command.y)
    }
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
      repairMode: textEntryMode
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
        referenceHeight: frame.isEmpty ? nil : Double(frame.height)
      )
    )
  }
}
