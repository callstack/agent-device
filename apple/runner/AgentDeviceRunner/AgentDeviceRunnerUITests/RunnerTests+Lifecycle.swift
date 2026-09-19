import XCTest
#if canImport(AppKit)
import AppKit
#endif

func runnerPngData(for image: RunnerImage) -> Data? {
#if canImport(UIKit)
  return image.pngData()
#elseif canImport(AppKit)
  guard let cgImage = runnerCGImage(from: image) else { return nil }
  let bitmap = NSBitmapImageRep(cgImage: cgImage)
  return bitmap.representation(using: .png, properties: [:])
#endif
}

func runnerCGImage(from image: RunnerImage) -> CGImage? {
#if canImport(UIKit)
  return image.cgImage
#elseif canImport(AppKit)
  return image.cgImage(forProposedRect: nil, context: nil, hints: nil)
#endif
}

/// Which of XCTest's two waits around one synthesized event a caller gives up.
///
/// The two waits answer to different callers. The pre-event wait is what #2546 bounds: the runner
/// has already decided the interaction may be synthesized, and XCTest's default wait for the app to
/// idle outlives a bounded command, so the event lands after the caller was told it failed. The
/// post-event wait is the settle margin before the runner reads the app back, and a caller whose
/// verdict is that next read cannot give it up.
enum RunnerInteractionIdleWaits {
  /// Neither wait, for a caller whose next step is its own poll rather than a verdict read off this
  /// event: a scroll re-checks its own content, a text field was already located, a swipe has
  /// nothing to verify.
  case bothSkipped
  /// Pre-event wait dropped, post-event quiescence kept under the same bound, for a caller whose
  /// verdict is the state this event produced. Alert verification reads the alert the tap replaced,
  /// and a read taken mid-transition finds no alert and reports a dismissal nothing proved.
  case preEventSkipped
}

extension RunnerTests {
  // MARK: - Recording

  func captureRunnerFrame() -> RunnerImage? {
    var image: RunnerImage?
    let capture = {
      let screenshot = XCUIScreen.main.screenshot()
      image = screenshot.image
    }
    if Thread.isMainThread {
      capture()
    } else {
      DispatchQueue.main.sync(execute: capture)
    }
    return image
  }

  func screenshotRoot(app: XCUIApplication) -> XCUIElement {
#if os(macOS)
    let windows = app.windows.allElementsBoundByIndex
    if let window = windows.first(where: { $0.exists && !$0.frame.isNull && !$0.frame.isEmpty }) {
      return window
    }
#endif
    return app
  }

  func stopRecordingIfNeeded() {
    guard let recorder = activeRecording else { return }
    do {
      try recorder.stop()
    } catch {
      NSLog("AGENT_DEVICE_RUNNER_RECORD_STOP_FAILED=%@", String(describing: error))
    }
    activeRecording = nil
  }

  func resolveRecordingOutPath(_ requestedOutPath: String) -> String {
#if os(macOS)
    if requestedOutPath.hasPrefix("/") {
      return requestedOutPath
    }
#endif
    let fileName = URL(fileURLWithPath: requestedOutPath).lastPathComponent
    let fallbackName = "agent-device-recording-\(Int(Date().timeIntervalSince1970 * 1000)).mp4"
    let safeFileName = fileName.isEmpty ? fallbackName : fileName
    return (NSTemporaryDirectory() as NSString).appendingPathComponent(safeFileName)
  }

  // MARK: - Target Activation

  func ensureRunnerHostAppActive(reason: String) {
    NSLog(
      "AGENT_DEVICE_RUNNER_HOST_ACTIVATE state=%d reason=%@",
      app.state.rawValue,
      reason
    )
    if app.state == .unknown || app.state == .notRunning {
      app.launch()
    } else if app.state != .runningForeground {
      app.activate()
    }
    currentApp = app
    currentBundleId = nil
    currentAppProcessIdentifier = nil
    clearRememberedTextEntryTap()
    snapshotXCTestPenaltyWarmupExemptionPending = false
  }

  func invalidateCachedTarget(reason: String) {
    if currentApp != nil || currentBundleId != nil {
      NSLog("AGENT_DEVICE_RUNNER_TARGET_CACHE_INVALIDATE reason=%@", reason)
    }
    currentApp = nil
    currentBundleId = nil
    currentAppProcessIdentifier = nil
    clearRememberedTextEntryTap()
    snapshotXCTestPenaltyWarmupExemptionPending = false
  }

  func resetTargetAfterExternalRelaunch() -> Response {
    invalidateCachedTarget(reason: "external_app_relaunch")
    // The app process is replaced, but the retained runner survives. Clear
    // process-bound capture state explicitly because invalidation drops the
    // old PID before refreshCachedTargetIfProcessChanged can observe it.
    clearSnapshotXCTestChannelPenalty(reason: "external_app_relaunch")
    clearPrivateAXAcceptedDepth(reason: "external_app_relaunch")
    beginFirstInteractionStabilization()
    return Response(ok: true, data: DataPayload(message: "target reset"))
  }

  func refreshCachedTargetIfProcessChanged(bundleId: String) {
    guard currentBundleId == bundleId, currentApp != nil else { return }
    let candidate = XCUIApplication(bundleIdentifier: bundleId)
    let observedProcessIdentifier = Self.processIdentifier(of: candidate)
    guard Self.shouldRefreshCachedTarget(
      cachedProcessIdentifier: currentAppProcessIdentifier,
      observedProcessIdentifier: observedProcessIdentifier
    ) else { return }
    NSLog(
      "AGENT_DEVICE_RUNNER_TARGET_CACHE_REFRESH bundle=%@ previousPid=%d currentPid=%d",
      bundleId,
      currentAppProcessIdentifier ?? 0,
      observedProcessIdentifier ?? 0
    )
    currentApp = candidate
    currentAppProcessIdentifier = observedProcessIdentifier
    clearRememberedTextEntryTap()
    clearSnapshotXCTestChannelPenalty(reason: "target_process_changed")
    clearPrivateAXAcceptedDepth(reason: "target_process_changed")
    snapshotXCTestPenaltyWarmupExemptionPending = true
    beginFirstInteractionStabilization()
  }

  static func processIdentifier(of target: XCUIApplication) -> Int? {
    let value = RunnerAXSnapshotBridge.processIdentifier(for: target)
    return value > 0 ? value : nil
  }

  static func shouldRefreshCachedTarget(
    cachedProcessIdentifier: Int?,
    observedProcessIdentifier: Int?
  ) -> Bool {
    guard let cachedProcessIdentifier, let observedProcessIdentifier else { return false }
    return cachedProcessIdentifier != observedProcessIdentifier
  }

  func targetNeedsActivation(_ target: XCUIApplication) -> Bool {
    let state = target.state
#if os(macOS)
    if state == .unknown || state == .notRunning || state == .runningBackground {
      return true
    }
#else
    if state == .unknown || state == .notRunning || state == .runningBackground
      || state == .runningBackgroundSuspended
    {
      return true
    }
#endif
    return false
  }

  func canUseFastForegroundAppGuard(
    activeApp: XCUIApplication,
    requestedBundleId: String?,
    command: CommandType
  ) -> Bool {
    guard let requestedBundleId, currentBundleId == requestedBundleId, currentApp != nil else {
      return false
    }
    guard activeApp.state == .runningForeground else { return false }
    NSLog(
      "AGENT_DEVICE_RUNNER_FAST_APP_GUARD command=%@ bundle=%@ state=%d",
      String(describing: command),
      requestedBundleId,
      activeApp.state.rawValue
    )
    return true
  }

  /// The pid of the one other application holding an active accessibility session, or nil unless
  /// exactly one exists. What this proves is that liveness claim and nothing more: the private AX
  /// client exposes no ordering of `activeApplications`, so this is NOT a foreground owner — it is
  /// the only other process that could have been on screen while the session app sat out of the
  /// foreground. The client resolves pids only, answering no bundle id for an arbitrary app, so
  /// anything other than exactly one foreign pid stays unstated rather than guessed (#2682).
  func soleOtherActiveApplicationPid(excluding sessionPid: Int?) -> Int? {
    let pids = RunnerAXSnapshotBridge.activeApplicationProcessIdentifiers().compactMap {
      ($0 as? NSNumber)?.intValue
    }
    let foreign = Set(pids.filter { $0 > 0 && $0 != sessionPid })
    return foreign.count == 1 ? foreign.first : nil
  }

  func activateTarget(bundleId: String, reason: String) -> XCUIApplication {
    let target = XCUIApplication(bundleIdentifier: bundleId)
    let initialState = target.state
    NSLog(
      "AGENT_DEVICE_RUNNER_ACTIVATE bundle=%@ state=%d reason=%@",
      bundleId,
      initialState.rawValue,
      reason
    )
    // activate avoids terminating and relaunching the target app
    if initialState == .runningForeground {
      NSLog(
        "AGENT_DEVICE_RUNNER_ACTIVATE_SKIPPED bundle=%@ reason=already_foreground",
        bundleId
      )
    } else {
      // Read the other app's pid before activating: after `activate()` that app is gone from the
      // active set, so the fact would describe the repair instead of the state it repaired (#2682).
      let otherActiveApplicationPid = soleOtherActiveApplicationPid(excluding: Self.processIdentifier(of: target))
      target.activate()
      pendingTargetActivation = TargetActivationFactPayload(
        reason: reason,
        priorState: Int(initialState.rawValue),
        otherActiveApplicationPid: otherActiveApplicationPid
      )
      NSLog(
        "AGENT_DEVICE_RUNNER_ACTIVATE_FACT bundle=%@ reason=%@ priorState=%d otherActiveApplicationPid=%@",
        bundleId,
        reason,
        initialState.rawValue,
        otherActiveApplicationPid.map(String.init) ?? "-"
      )
    }
    currentApp = target
    currentBundleId = bundleId
    currentAppProcessIdentifier = Self.processIdentifier(of: target)
    clearRememberedTextEntryTap()
    snapshotXCTestPenaltyWarmupExemptionPending = false
    beginFirstInteractionStabilization()
    return target
  }

  /// Bounds what XCTest waits around one synthesized event instead of letting it spend a command's
  /// whole deadline, keeping whichever settle the caller named in `waits`. Callers gate the
  /// interaction themselves first (a scroll needs no extra wait, a text field is located, an alert
  /// button is read as hittable), which is what the dropped pre-event wait replaces rather than a
  /// check the runner skips (#2546).
  func withBoundedInteractionIdleTimeoutIfSupported(
    _ target: XCUIApplication,
    waits: RunnerInteractionIdleWaits,
    operation: () -> Void
  ) {
    let setter = NSSelectorFromString("setWaitForIdleTimeout:")
    let supportsWaitForIdleTimeout = target.responds(to: setter)
    let previous = supportsWaitForIdleTimeout
      ? (target.value(forKey: "waitForIdleTimeout") as? NSNumber)
      : nil
    if supportsWaitForIdleTimeout {
      target.setValue(interactionIdleTimeoutDefault, forKey: "waitForIdleTimeout")
    }
    defer {
      if let previous {
        target.setValue(previous.doubleValue, forKey: "waitForIdleTimeout")
      }
    }
    performWithQuiescenceSkippedIfSupported(target, waits: waits, operation: operation)
  }

  // Some apps never report post-gesture quiescence, even after XCTest has synthesized the event.
  private func performWithQuiescenceSkippedIfSupported(
    _ target: XCUIApplication,
    waits: RunnerInteractionIdleWaits,
    operation: () -> Void
  ) {
    let selector = NSSelectorFromString("_performWithInteractionOptions:block:")
    guard target.responds(to: selector) else {
      operation()
      return
    }
    typealias PerformWithInteractionOptions = @convention(c) (
      NSObject,
      Selector,
      UInt,
      @convention(block) () -> Void
    ) -> Void
    let implementation = target.method(for: selector)
    let performWithOptions = unsafeBitCast(
      implementation,
      to: PerformWithInteractionOptions.self
    )
    let skipPreEventQuiescence = UInt(1)
    let skipPostEventQuiescence = UInt(2)
    let options: UInt
    switch waits {
    case .bothSkipped:
      options = skipPreEventQuiescence | skipPostEventQuiescence
    case .preEventSkipped:
      options = skipPreEventQuiescence
    }
    withoutActuallyEscaping(operation) { escapableOperation in
      let block: @convention(block) () -> Void = escapableOperation
      performWithOptions(
        target,
        selector,
        options,
        block
      )
    }
  }

  func shouldRetryCommand(_ command: Command) -> Bool {
    if RunnerEnv.isTruthy("AGENT_DEVICE_RUNNER_DISABLE_READONLY_RETRY") {
      return false
    }
    return isReadOnlyCommand(command)
  }

  func shouldRetryException(_ command: Command, message: String) -> Bool {
    guard shouldRetryCommand(command) else { return false }
    let normalized = message.lowercased()
    if normalized.contains("kaxerrorservernotfound") {
      return true
    }
    if normalized.contains("main thread execution timed out") {
      return true
    }
    if normalized.contains("timed out") && command.command == .snapshot {
      return true
    }
    return false
  }

  // MARK: - Command Classification

  func isReadOnlyCommand(_ command: Command) -> Bool {
    switch command.command.traits.readOnly {
    case .always:
      return true
    case .never:
      return false
    case .conditional:
      // Today only `alert` is conditional: read-only when getting, mutating otherwise.
      return (command.action ?? "get").lowercased() == "get"
    }
  }

  func shouldRetryResponse(_ response: Response) -> Bool {
    guard response.ok == false else { return false }
    guard let message = response.error?.message.lowercased() else { return false }
    return message.contains("is not available")
  }

  func isInteractionCommand(_ command: CommandType) -> Bool {
    return command.traits.isInteraction
  }

  func isRunnerLifecycleCommand(_ command: CommandType) -> Bool {
    return command.traits.isLifecycle
  }

  // MARK: - Interaction Stabilization

  func applyInteractionStabilizationIfNeeded() {
    if needsPostSnapshotInteractionDelay {
      sleepFor(postSnapshotInteractionDelay)
      needsPostSnapshotInteractionDelay = false
    }
    if let readyUptime = firstInteractionReadyUptime {
      sleepFor(readyUptime - ProcessInfo.processInfo.systemUptime)
      firstInteractionReadyUptime = nil
    }
  }

  /// Start the post-activation settling window. Measured from now, so the time the caller spends
  /// getting back to us counts towards it instead of being charged twice.
  func beginFirstInteractionStabilization() {
    firstInteractionReadyUptime =
      ProcessInfo.processInfo.systemUptime + firstInteractionAfterActivateDelay
  }

  func sleepFor(_ delay: TimeInterval) {
    guard delay > 0 else { return }
    // Keep XCTest/UI sources moving during command-local pauses such as delayed typing.
    if Thread.isMainThread {
      let deadline = Date().addingTimeInterval(delay)
      while Date() < deadline {
        let slice = min(max(deadline.timeIntervalSinceNow, 0), 0.02)
        if slice <= 0 {
          break
        }
        let handledSource = RunLoop.current.run(
          mode: .default,
          before: Date().addingTimeInterval(slice)
        )
        if !handledSource {
          usleep(useconds_t(slice * 1_000_000))
        }
      }
      return
    }
    usleep(useconds_t(delay * 1_000_000))
  }
}
