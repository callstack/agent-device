import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  func executeSnapshotDispatched(command: Command) throws -> Response {
    try executeDispatchedWithRecovery(command: command) {
      try self.executeSnapshotDispatchedOnce(command: command)
    }
  }

  private func executeSnapshotDispatchedOnce(command: Command) throws -> Response {
    let preparation: SnapshotCommandPreparation = try runMainThreadWork(
      "command_preparation",
      timeout: Self.mainThreadExecutionTimeout,
      timeoutError: Self.mainThreadExecutionTimeoutError
    ) { () -> SnapshotCommandPreparation in
      switch try self.prepareActiveCommandContextSafely(command: command, routeToSpringboard: false) {
      case .response(let response):
        return .response(response)
      case .context(let context):
        return .capture(
          self.takeSnapshotCaptureTarget(app: context.app),
          systemSurface: context.systemSurface
        )
      }
    }
    switch preparation {
    case .response(let response):
      return response
    case .capture(let target, let systemSurface):
      return try executeSnapshotPrepared(
        command: command,
        target: target,
        systemSurface: systemSurface
      )
    }
  }

  @MainActor
  private func prepareActiveCommandContextSafely(
    command: Command,
    routeToSpringboard: Bool
  ) throws -> ActiveCommandPreparation {
    var preparation: ActiveCommandPreparation?
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      preparation = self.prepareActiveCommandContext(
        command: command,
        routeToSpringboard: routeToSpringboard
      )
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

  /// Pure command→options projection, extracted so the runner unit bundle can
  /// prove the decoded wire field actually reaches presentation options (#1634 P2).
  static func presentationOptions(from command: Command) -> PresentationOptions {
    let customActions = command.customActions ?? false
    return PresentationOptions(
      interactiveOnly: command.interactiveOnly ?? false,
      depth: command.depth,
      scope: command.scope,
      raw: command.raw ?? false,
      // Custom actions are only readable through the private AX client, so
      // asking for them pins that backend rather than silently returning a
      // capture that structurally cannot carry them. An explicit pin wins.
      preferredBackend: command.preferredBackend
        ?? (customActions ? SnapshotBackendKind.privateAX.rawValue : nil),
      customActions: customActions
    )
  }

  private func executeSnapshotPrepared(
    command: Command,
    target: SnapshotCaptureTarget,
    systemSurface: SystemSurfaceHost?
  ) throws -> Response {
    let options = Self.presentationOptions(from: command)
    do {
      var payload: DataPayload
      if options.raw {
        payload = try snapshotRaw(target: target, options: options)
      } else {
        payload = try snapshotFast(target: target, options: options)
      }
      if let systemSurface {
        payload.systemSurface = SystemSurfaceProvenancePayload(
          bundleId: systemSurface.bundleId,
          kind: systemSurface.kind.rawValue
        )
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

  func setNeedsPostSnapshotInteractionDelay() {
    guard !hasAbandonedMainThreadWork() else {
      NSLog("AGENT_DEVICE_RUNNER_POST_SNAPSHOT_DELAY_MARK_SKIPPED_XCTEST_OCCUPIED")
      return
    }
    do {
      try runMainThreadWork(
        "post_snapshot_delay_mark",
        timeout: 1,
        timeoutError: Self.mainThreadExecutionTimeoutError
      ) {
        self.mainOwned.needsPostSnapshotInteractionDelay = true
      }
    } catch {
      NSLog("AGENT_DEVICE_RUNNER_POST_SNAPSHOT_DELAY_MARK_FAILED=%@", String(describing: error))
    }
  }

  func invalidateCachedTargetAfterSnapshotFailure() {
    applyMainOwnedSnapshotState("target_invalidation") {
      self.invalidateCachedTarget(reason: "ax_snapshot_failure")
    }
  }
}
