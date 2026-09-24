import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  // MARK: - Main Thread Dispatch

  func executeAccepted(command: Command) throws -> Response {
    commandJournal.start(command: command)
    pendingTargetActivation = nil
    do {
      let response = try executeDispatched(command: command)
      commandJournal.finish(command: command, response: response)
      guard let fact = pendingTargetActivation else { return response }
      // Stamped after `finish`, like the uptime anchor: a journal-replayed result carries no
      // activation fact, because the command that paid for it is the one being replayed, not one
      // that just repaired foreground (#2682).
      pendingTargetActivation = nil
      return response.stampingTargetActivation(fact)
    } catch {
      pendingTargetActivation = nil
      commandJournal.fail(command: command, error: error)
      throw error
    }
  }

  func executeStatus(command: Command) -> Response {
    guard
      let statusCommandId = command.statusCommandId?.trimmedNonEmpty
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
    return Response(ok: true, data: commandJournal.status(normalizedCommandId: statusCommandId))
  }

  func executeUptime() -> Response {
    // Placeholder value: the transport layer (jsonResponse) overwrites currentUptimeMs with a
    // fresher send-time stamp on every ok response; kept so direct callers still get a value.
    Response(
      ok: true,
      data: DataPayload(currentUptimeMs: currentUptimeMs())
    )
  }

  /// The session app's `XCUIApplication.State` by name. A lifecycle read: the activation preflight
  /// is skipped, so `runningBackground` after `home` is reported rather than repaired away.
  @MainActor
  func executeAppState(command: Command) -> Response {
    guard let bundleId = command.appBundleId?.trimmedNonEmpty else {
      return Response(
        ok: false,
        error: ErrorPayload(
          code: "INVALID_ARGS",
          message: "appState requires appBundleId",
          hint: "Set appBundleId to the session app's bundle identifier."
        )
      )
    }
    let state = XCUIApplication(bundleIdentifier: bundleId).state
    return Response(ok: true, data: DataPayload(applicationState: Self.applicationStateName(state)))
  }

  /// `XCUIApplication.State` by the names the TypeScript `AppleApplicationState` type declares, the
  /// same names the activation disclosure gives its prior state.
  static func applicationStateName(_ state: XCUIApplication.State) -> String {
    switch state {
    case .unknown: return "unknown"
    case .notRunning: return "notRunning"
    case .runningBackground: return "runningBackground"
    case .runningForeground: return "runningForeground"
#if !os(macOS)
    case .runningBackgroundSuspended: return "runningBackgroundSuspended"
#endif
    @unknown default: return "unknown"
    }
  }

  struct ActiveCommandContext {
    let app: XCUIApplication
    /// Set when `app` is a system surface served in place over the still-bound session app (#2438).
    var systemSurface: SystemSurfaceHost? = nil
  }

  enum ActiveCommandPreparation {
    case response(Response)
    case context(ActiveCommandContext)
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

  private func runnerUnavailableResponse(command: Command) -> Response? {
    switch currentMainThreadBusyState() {
    case .idle:
      return nil
    case .busy(let abandonedForSeconds):
      return runnerBusyResponse(command: command, abandonedForSeconds: abandonedForSeconds)
    case .wedged(let abandonedForSeconds):
      return runnerWedgedResponse(command: command, abandonedForSeconds: abandonedForSeconds)
    }
  }

  func executeDispatched(command: Command) throws -> Response {
    // XCTest work cannot be cancelled mid-flight: once the watchdog abandons a main-queue
    // block, queueing more main-thread commands behind it only buries the runner deeper.
    // Refuse fast instead so the daemon backs off while the abandoned work drains; past the
    // wedge threshold, escalate so the daemon recycles this runner (#1105).
    if let unavailable = runnerUnavailableResponse(command: command) {
      return unavailable
    }
    let alertDeadline = command.command == .alert
      ? Date().addingTimeInterval(Self.alertCommandTimeout(timeoutMs: command.timeoutMs))
      : nil
    // Resolve this before the command's outer main-thread block. If the bounded probe abandons
    // slow XCTest enumeration, return the established recoverable response instead of queueing
    // command preparation behind work that may outlive the 30-second command watchdog.
    let routeToSpringboard = shouldRouteToSpringboardBlockingSystemModal(command)
    if let unavailable = runnerUnavailableResponse(command: command) {
      return unavailable
    }
    if command.command == .snapshot {
      return try executeSnapshotDispatched(command: command)
    }
    if command.command == .alert, let deadline = alertDeadline {
      return try runMainThreadWork(
        "command_execution",
        timeout: max(0.001, deadline.timeIntervalSinceNow),
        timeoutError: Self.mainThreadExecutionTimeoutError
      ) {
        try self.executeOnMainSafely(
          command: command,
          alertDeadline: deadline,
          routeToSpringboard: routeToSpringboard
        )
      }
    }
    return try runMainThreadWork(
      "command_execution",
      timeout: Self.mainThreadExecutionTimeout,
      timeoutError: Self.mainThreadExecutionTimeoutError
    ) {
      try self.executeOnMainSafely(command: command, routeToSpringboard: routeToSpringboard)
    }
  }

  // MARK: - Command Handling

  @MainActor
  private func executeOnMainSafely(
    command: Command,
    alertDeadline: Date? = nil,
    routeToSpringboard: Bool
  ) throws -> Response {
    var hasRetried = false
    while true {
      var response: Response?
      var swiftError: Error?
      let failureCountBefore = currentXCTestFailureCount()
      let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
        do {
          response = try self.executeOnMain(
            command: command,
            alertDeadline: alertDeadline,
            routeToSpringboard: routeToSpringboard
          )
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
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
      // #1605 merge gate: the REAL gesture already executed above; recording a
      // production-shaped issue here makes the per-command failure-count
      // conversion below fire exactly as in the field (bsky-24: activation
      // lands, bookkeeping records a failure). Compiled out of production.
      if consumeInjectedTapRecordedFailureForTesting(command: command.command) {
        record(
          XCTIssue(
            type: .assertionFailure,
            compactDescription: "Injected tap recorded-failure (#1605 corroboration merge gate)"
          )
        )
      }
#endif
      if didRecordXCTestFailure(since: failureCountBefore),
        let failureResponse = xctestRecordedFailureResponse(command: command, response: response)
      {
        invalidateCachedTarget(reason: "xctest_recorded_failure")
        return failureResponse
      }
      if !hasRetried, command.traits.retryOnSessionLoss, shouldRetryResponse(response) {
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

  /// The dispatched snapshot recovery loop: session-loss retry + XCTest-recorded-failure invalidation,
  /// matching what `executeOnMainSafely` gives the generic path. `perform` runs the capture and its
  /// own bounded main-thread work.
  func executeDispatchedWithRecovery(
    command: Command,
    perform: () throws -> Response
  ) throws -> Response {
    var hasRetried = false
    while true {
      let failureCountBefore = try runMainThreadWork(
        "recorded_failure_count",
        timeout: Self.mainThreadExecutionTimeout,
        timeoutError: Self.mainThreadExecutionTimeoutError
      ) {
        self.currentXCTestFailureCount()
      }
      let response = try perform()
      // Recovered independently — re-entering main for bookkeeping would queue behind the still-
      // abandoned XCTest query and re-stall the command (#1244), so skip it until that work drains.
      if hasAbandonedMainThreadWork() {
        NSLog(
          "AGENT_DEVICE_RUNNER_DISPATCH_RECOVERY_SKIPPED_XCTEST_OCCUPIED command=%@",
          command.command.rawValue
        )
        return response
      }
      let recordedFailureResponse = try runMainThreadWork(
        "recorded_failure_count",
        timeout: Self.mainThreadExecutionTimeout,
        timeoutError: Self.mainThreadExecutionTimeoutError
      ) {
        self.didRecordXCTestFailure(since: failureCountBefore)
          ? self.xctestRecordedFailureResponse(command: command, response: response)
          : nil
      }
      if let recordedFailureResponse {
        try runMainThreadWork(
          "target_invalidation",
          timeout: Self.mainThreadExecutionTimeout,
          timeoutError: Self.mainThreadExecutionTimeoutError
        ) {
          self.invalidateCachedTarget(reason: "xctest_recorded_failure")
        }
        return recordedFailureResponse
      }
      if !hasRetried, command.traits.retryOnSessionLoss, shouldRetryResponse(response) {
        NSLog(
          "AGENT_DEVICE_RUNNER_RETRY command=%@ reason=response_unavailable",
          command.command.rawValue
        )
        hasRetried = true
        try runMainThreadWork(
          "target_invalidation",
          timeout: Self.mainThreadExecutionTimeout,
          timeoutError: Self.mainThreadExecutionTimeoutError
        ) {
          self.invalidateCachedTarget(reason: "response_unavailable")
          self.sleepFor(self.retryCooldown)
        }
        continue
      }
      return response
    }
  }

  @MainActor
  private func executeOnMain(
    command: Command,
    alertDeadline: Date?,
    routeToSpringboard: Bool
  ) throws -> Response {
    let preparation = prepareActiveCommandContext(
      command: command,
      routeToSpringboard: routeToSpringboard
    )
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
    case .targetReset:
      return resetTargetAfterExternalRelaunch()
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
      do {
        let resolvedOutPath = resolveRecordingOutPath(requestedOutPath)
        let fpsLabel = command.fps.map(String.init) ?? String(RunnerTests.defaultRecordingFps)
        NSLog(
          "AGENT_DEVICE_RUNNER_RECORD_START requestedOutPath=%@ resolvedOutPath=%@ fps=%@",
          requestedOutPath,
          resolvedOutPath,
          fpsLabel
        )
        let recorder = ScreenRecorder(
          outputPath: resolvedOutPath,
          fps: command.fps.map { Int32($0) }
        )
        try startRecording(recorder) { [weak self] in
          guard let self else { return .failure(.unresolvedScreen) }
          return self.captureRunnerFrameResult(app: activeApp)
        }
        activeRecording = recorder
        return Response(ok: true, data: DataPayload(message: "recording started"))
      } catch {
        activeRecording = nil
        return Response(ok: false, error: Self.recordingStartErrorPayload(for: error))
      }
    case .recordStop:
      guard let recorder = activeRecording else {
        // The runner protocol is the durable cleanup primitive. A daemon may crash after the
        // native stop succeeds but before it commits the resource transition, so exact-owner
        // recovery must be able to repeat this command safely. Public `record stop` still owns
        // its user-facing no-active validation through the daemon session manifest.
        return Response(ok: true, data: DataPayload(message: "recording already stopped"))
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
    case .appState:
      return executeAppState(command: command)
    case .activate:
      guard
        let bundleId = command.appBundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
        !bundleId.isEmpty
      else {
        return Response(ok: false, error: ErrorPayload(message: "activate requires appBundleId"))
      }
      // prepareActiveCommandContext already activated this bundle. Keep this case as the
      // explicit acknowledgement after that preflight, not as a second activation.
      return Response(ok: true, data: DataPayload(message: "app activated"))
    case .terminate:
      guard
        let bundleId = command.appBundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
        !bundleId.isEmpty
      else {
        return Response(ok: false, error: ErrorPayload(message: "terminate requires appBundleId"))
      }
      XCUIApplication(bundleIdentifier: bundleId).terminate()
      if mainOwned.bundleId == bundleId {
        invalidateCachedTarget(reason: "target_terminated")
      }
      return Response(ok: true, data: DataPayload(message: "app terminated"))
    default:
      break
    }
    return try executeOnMainPrepared(
      command: command,
      activeApp: activeApp,
      alertDeadline: alertDeadline
    )
  }

  /// The target this command runs against, decided by its `launchPolicy` (#2890). Exhaustive over the
  /// policy so a new case is a compile error here rather than a fall-through that quietly launches or
  /// quietly refuses.
  @MainActor
  func prepareActiveCommandContext(
    command: Command,
    routeToSpringboard: Bool = false
  ) -> ActiveCommandPreparation {
    if routeToSpringboard {
      return .context(ActiveCommandContext(app: springboard))
    }
    switch command.traits.launchPolicy {
    case .noApp:
      // Answers from the runner's own capture and state, so the target is resolved exactly as it
      // stands.
      return .context(ActiveCommandContext(app: resolveAppWithoutActivation(command: command)))
    case .presentedSurface:
      // The command is about the surface that already has focus; activating an app under it would
      // cancel exactly what the command is about.
#if os(iOS)
      return .context(ActiveCommandContext(app: resolveAppWithoutActivation(command: command)))
#else
      // The platform exception, written once: `SystemSurfaceHostRegistry` registers no hosts off iOS,
      // so nothing is ever served in place there and such a command keeps the activation route this
      // axis found it on.
      return prepareActivatedTarget(command: command)
#endif
    case .existingApp, .mayLaunch:
      // Asked only where activation is on the table: the bypass decides by querying the cached
      // target's state, and a command that may bring nothing forward has nothing for it to settle.
      if shouldSkipAppActivationPreflight(command) {
        // The one request-dependent bypass: a coordinate-only synthesized tap whose cached target is
        // already foreground needs nothing brought forward.
        return .context(ActiveCommandContext(app: resolveAppWithoutActivation(command: command)))
      }
      return prepareActivatedTarget(command: command)
    }
  }

  /// The route that may bring something forward: a system surface genuinely on screen is served in
  /// place, and otherwise the requested session app is resolved and activated. What happens to a
  /// stopped app is the caller's `launchPolicy`; the `.existingApp` refusal belongs to
  /// `notRunningRefusal` because it is only meaningful once nothing is presented (#2890).
  @MainActor
  private func prepareActivatedTarget(command: Command) -> ActiveCommandPreparation {
    if let presented = presentedSystemSurfaceHost() {
      // Serve and drive the presented surface IN PLACE: never activate it (that cancels what it
      // presents) and never adopt it as the cached session target, so once it is gone the next
      // command resolves back to the still-bound session app (#2438).
      if command.traits.isInteraction {
        applyInteractionStabilizationIfNeeded()
      }
      return .context(ActiveCommandContext(app: presented.app, systemSurface: presented.host))
    }

    let normalizedBundleId = command.appBundleId?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let requestedBundleId = (normalizedBundleId?.isEmpty == true) ? nil : normalizedBundleId
    if let bundleId = requestedBundleId,
      let notRunning = notRunningRefusal(command: command, bundleId: bundleId)
    {
      return .response(notRunning)
    }
    if let bundleId = requestedBundleId {
      if mainOwned.bundleId != bundleId || mainOwned.app == nil {
        _ = activateTarget(bundleId: bundleId, reason: "bundle_changed")
      } else {
        refreshCachedTargetIfProcessChanged(bundleId: bundleId)
      }
    } else {
      // Do not reuse stale bundle targets when the caller does not explicitly request one.
      invalidateCachedTarget(reason: "missing_app_bundle")
    }

    // Read back after the bundle resolution above, which is what may have just bound a target.
    var activeApp = mainOwned.app ?? app
    if let bundleId = requestedBundleId, targetNeedsActivation(activeApp) {
      activeApp = activateTarget(bundleId: bundleId, reason: "stale_target")
    } else if requestedBundleId == nil, targetNeedsActivation(activeApp) {
      ensureRunnerHostAppActive(reason: "missing_app_bundle")
      activeApp = app
    }

    let skipExistenceWait = canUseFastForegroundAppGuard(
      activeApp: activeApp,
      requestedBundleId: requestedBundleId
    )
    if !skipExistenceWait && !activeApp.waitForExistence(timeout: appExistenceTimeout) {
      if let bundleId = requestedBundleId {
        activeApp = activateTarget(bundleId: bundleId, reason: "missing_after_wait")
        guard activeApp.waitForExistence(timeout: appExistenceTimeout) else {
          return .response(Response(ok: false, error: .targetAppUnavailable(bundleId: bundleId)))
        }
      } else {
        return .response(Response(ok: false, error: .targetAppUnavailable(bundleId: nil)))
      }
    }

    if command.traits.isInteraction {
      if let bundleId = requestedBundleId, activeApp.state != .runningForeground {
        activeApp = activateTarget(bundleId: bundleId, reason: "interaction_foreground_guard")
      } else if requestedBundleId == nil, activeApp.state != .runningForeground {
        ensureRunnerHostAppActive(reason: "interaction_missing_app_bundle")
        activeApp = app
      }
      let skipInteractionExistenceWait = canUseFastForegroundAppGuard(
        activeApp: activeApp,
        requestedBundleId: requestedBundleId
      )
      if !skipInteractionExistenceWait && !activeApp.waitForExistence(timeout: 2) {
        return .response(
          Response(ok: false, error: .targetAppUnavailable(bundleId: requestedBundleId))
        )
      }
      applyInteractionStabilizationIfNeeded()
    }
    return .context(ActiveCommandContext(app: activeApp))
  }

  /// A registered system surface host that is genuinely on screen, or nil. Presence is foreground
  /// state, not tree content: a torn-down host still serves a rich tree, and it can only be
  /// foreground-with-a-stale-tree if something activated it, which the open guard refuses. `state`
  /// never activates and is cheap when the host is absent. See docs/adr/0004.
  private func presentedSystemSurfaceHost() -> (host: SystemSurfaceHost, app: XCUIApplication)? {
#if os(iOS)
    for host in SystemSurfaceHostRegistry.hosts {
      let candidate = XCUIApplication(bundleIdentifier: host.bundleId)
      if candidate.state == .runningForeground {
        return (host, candidate)
      }
    }
    return nil
#else
    return nil
#endif
  }

  func currentXCTestFailureCount() -> Int {
    return testRun?.failureCount ?? 0
  }

  func didRecordXCTestFailure(since failureCountBefore: Int) -> Bool {
    return currentXCTestFailureCount() > failureCountBefore
  }

  func xctestRecordedFailureResponse(command: Command, response: Response) -> Response? {
    guard response.ok else { return nil }
    if response.data?.runnerFatal == true {
      return nil
    }
    guard command.traits.convertsRecordedFailure else {
      return nil
    }
    return Response(
      ok: false,
      error: ErrorPayload(
        code: "XCTEST_RECORDED_FAILURE",
        message: "XCTest recorded a failure while executing \(command.command.rawValue); the action may not have been performed.",
        hint: "The iOS runner session was invalidated. Re-observe with a fresh snapshot before retrying; if the accessibility tree is unavailable, use screenshot plus coordinate commands instead of retrying the tap blindly."
      )
    )
  }

  /// The one activation bypass that depends on the request rather than on the command: a tap that
  /// needs nothing the preflight would bring forward. Commands whose own classification answers
  /// without the session app's foreground state are handled by their `launchPolicy` (#2890).
  @MainActor
  func shouldSkipAppActivationPreflight(_ command: Command) -> Bool {
#if os(iOS)
    // Coordinate-only synthesized taps can run after an AX-fatal foreground screen because they do not
    // need app activation, window lookup, keyboard lookup, or element resolution. Selector/text
    // interactions intentionally stay on the normal AX path because they need an element query.
    // Scroll/drag/sequence keep the normal foreground guard and stabilization path.
    guard command.text == nil, command.selectorKey == nil else { return false }
    guard hasCachedTargetForActivationSkip(command: command) else { return false }
    return isCoordinateOnlyTap(command)
#else
    return false
#endif
  }

  func shouldRouteToSpringboardBlockingSystemModal(
    _ command: Command
  ) -> Bool {
#if os(iOS)
    guard isCoordinateOnlyTap(command) else {
      return false
    }
    #if AGENT_DEVICE_RUNNER_UNIT_TESTS
    if let override = blockingSystemModalPresenceOverrideForTesting {
      return override
    }
    #endif
    let probeDeadline = Date().addingTimeInterval(systemModalProbeBudget)
    // Routing runs on the command queue, so this hands the probe a target rather than a bundle id it
    // read across the main boundary: the penalty an abandoned probe arms carries the identity main
    // holds once the probe starts, not one whose write was still queued behind the block that
    // occupied main (#2781).
    return boundedBlockingSystemAlertSnapshot(
      deadline: probeDeadline,
      penaltyTarget: .mainOwnedTarget
    ) != nil
#else
    return false
#endif
  }

  private func isCoordinateOnlyTap(_ command: Command) -> Bool {
    return command.command == .tap
      && command.text == nil
      && command.selectorKey == nil
      && command.x != nil
      && command.y != nil
  }

  @MainActor
  private func hasCachedTargetForActivationSkip(command: Command) -> Bool {
    guard let boundApp = mainOwned.app, boundApp.state == .runningForeground else { return false }
    guard let bundleId = command.appBundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
      !bundleId.isEmpty
    else {
      return true
    }
    return mainOwned.bundleId == bundleId
  }

  @MainActor
  func resolveAppWithoutActivation(command: Command) -> XCUIApplication {
    guard let bundleId = command.appBundleId?
      .trimmingCharacters(in: .whitespacesAndNewlines),
      !bundleId.isEmpty
    else {
      return mainOwned.app ?? app
    }
    if mainOwned.bundleId == bundleId, let boundApp = mainOwned.app {
      return boundApp
    }
    return XCUIApplication(bundleIdentifier: bundleId)
  }
}
