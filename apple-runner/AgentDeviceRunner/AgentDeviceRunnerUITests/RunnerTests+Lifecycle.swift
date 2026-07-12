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
    snapshotXCTestPenaltyWarmupExemptionPending = false
  }

  func invalidateCachedTarget(reason: String) {
    if currentApp != nil || currentBundleId != nil {
      NSLog("AGENT_DEVICE_RUNNER_TARGET_CACHE_INVALIDATE reason=%@", reason)
    }
    currentApp = nil
    currentBundleId = nil
    currentAppProcessIdentifier = nil
    snapshotXCTestPenaltyWarmupExemptionPending = false
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
    clearSnapshotXCTestChannelPenalty(reason: "target_process_changed")
    snapshotXCTestPenaltyWarmupExemptionPending = true
    needsFirstInteractionDelay = true
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

  func activateTarget(bundleId: String, reason: String) -> XCUIApplication {
    let target = XCUIApplication(bundleIdentifier: bundleId)
    NSLog(
      "AGENT_DEVICE_RUNNER_ACTIVATE bundle=%@ state=%d reason=%@",
      bundleId,
      target.state.rawValue,
      reason
    )
    // activate avoids terminating and relaunching the target app
    target.activate()
    currentApp = target
    currentBundleId = bundleId
    currentAppProcessIdentifier = Self.processIdentifier(of: target)
    snapshotXCTestPenaltyWarmupExemptionPending = false
    needsFirstInteractionDelay = true
    return target
  }

  func withTemporaryScrollIdleTimeoutIfSupported(
    _ target: XCUIApplication,
    operation: () -> Void
  ) {
    let setter = NSSelectorFromString("setWaitForIdleTimeout:")
    let supportsWaitForIdleTimeout = target.responds(to: setter)
    let previous = supportsWaitForIdleTimeout
      ? (target.value(forKey: "waitForIdleTimeout") as? NSNumber)
      : nil
    if supportsWaitForIdleTimeout {
      target.setValue(scrollInteractionIdleTimeoutDefault, forKey: "waitForIdleTimeout")
    }
    defer {
      if let previous {
        target.setValue(previous.doubleValue, forKey: "waitForIdleTimeout")
      }
    }
    performWithQuiescenceSkippedIfSupported(target, operation: operation)
  }

  // Some apps never report post-gesture quiescence, even after XCTest has synthesized the event.
  private func performWithQuiescenceSkippedIfSupported(
    _ target: XCUIApplication,
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
    withoutActuallyEscaping(operation) { escapableOperation in
      let block: @convention(block) () -> Void = escapableOperation
      performWithOptions(
        target,
        selector,
        skipPreEventQuiescence | skipPostEventQuiescence,
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
    if needsFirstInteractionDelay {
      sleepFor(firstInteractionAfterActivateDelay)
      needsFirstInteractionDelay = false
    }
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
