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

  /// One frame for a caller that tolerates a dropped one — keyboard settling, which skips a sample it
  /// cannot take and keeps polling. A frame that must exist goes through `captureRunnerFrameResult`,
  /// which says why it refused.
  ///
  /// On iOS the frame comes from the display owning a window, because a foldable's
  /// `XCUIScreen.main` can be the dark outer panel while the app runs on the inner one — a stream of
  /// identical black frames would then read as a settled screen (#2728). An observation with no
  /// session window falls to the system surface's window, which is what the home screen is. macOS
  /// keeps the host display it always recorded.
  func captureRunnerFrame(app: XCUIApplication) -> RunnerImage? {
    switch captureRunnerFrameResult(app: app) {
    case .success(let captured):
      return captured.image
    case .failure:
      return nil
    }
  }

  /// The same frame as `captureRunnerFrame`, but carrying the reason it refused, so a required first
  /// frame — a recording's bootstrap, which sizes the whole writer from it — fails closed with a
  /// typed code rather than a message. The ongoing pump reads the same result and ignores a refusal
  /// the way it ignored the `nil` it used to get; only a frame that must exist owes a reason (#2728).
  func captureRunnerFrameResult(
    app: XCUIApplication
  ) -> Result<CapturedAppScreen, RunnerAppScreenCaptureFailure> {
#if os(iOS)
    return captureObservedScreen(app: app)
#else
    var outcome: Result<CapturedAppScreen, RunnerAppScreenCaptureFailure> = .failure(
      .unrenderableImage
    )
    let capture = {
      let image = XCUIScreen.main.screenshot().image
      if let cgImage = runnerCGImage(from: image) {
        // The host display has no resolved-panel facts to report; the recorder reads only the image
        // and its pixel size, so these two are inert placeholders, not measurements the host scales by.
        outcome = .success(
          CapturedAppScreen(
            image: image,
            displayID: 0,
            pixelWidth: cgImage.width,
            pixelHeight: cgImage.height,
            pixelsPerPoint: 1
          )
        )
      }
    }
    if Thread.isMainThread {
      capture()
    } else {
      DispatchQueue.main.sync(execute: capture)
    }
    return outcome
#endif
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

  /// Answers a `screenshot` command with one encoded image: inline when the caller asked for bytes,
  /// otherwise as a path the host reads out of the runner's own container. `metadata` carries the
  /// display the image came from whenever the capture resolved one, so the host never has to guess
  /// the density of a panel it did not measure (#2728).
  func screenshotResponse(
    pngData: Data,
    inlineScreenshot: Bool,
    metadata: ScreenshotMetadataPayload? = nil
  ) -> Response {
    if inlineScreenshot {
      return Response(
        ok: true,
        data: DataPayload(imageBase64: pngData.base64EncodedString(), screenshotMetadata: metadata)
      )
    }
    let fileName = "screenshot-\(Int(Date().timeIntervalSince1970 * 1000)).png"
    let filePath = (NSTemporaryDirectory() as NSString).appendingPathComponent(fileName)
    do {
      try pngData.write(to: URL(fileURLWithPath: filePath))
    } catch {
      return Response(
        ok: false,
        error: ErrorPayload(message: "Failed to write screenshot: \(error.localizedDescription)")
      )
    }
#if os(macOS)
    return Response(ok: true, data: DataPayload(message: filePath, screenshotMetadata: metadata))
#else
    // Return path relative to app container root (tmp/ maps to NSTemporaryDirectory)
    return Response(
      ok: true,
      data: DataPayload(message: "tmp/\(fileName)", screenshotMetadata: metadata)
    )
#endif
  }

  /// Encodes a captured image as PNG and answers with it, or with the failure to encode it.
  func screenshotResponse(
    image: RunnerImage,
    inlineScreenshot: Bool,
    metadata: ScreenshotMetadataPayload? = nil
  ) -> Response {
    guard let pngData = runnerPngData(for: image) else {
      return Response(ok: false, error: ErrorPayload(message: "Failed to encode screenshot as PNG"))
    }
    return screenshotResponse(pngData: pngData, inlineScreenshot: inlineScreenshot, metadata: metadata)
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

  @MainActor
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
    mainOwned.app = app
    mainOwned.bundleId = nil
    mainOwned.processIdentifier = nil
    resetTargetBoundState()
  }

  /// State that belongs to the currently bound target and must not outlive it: the text-entry tap
  /// witness, the fresh-process snapshot warmup exemption, and the last-written per-command log
  /// markers. Every site that binds, rebinds, or drops the target runs this.
  func resetTargetBoundState() {
    clearRememberedTextEntryTap()
    snapshotXCTestPenaltyWarmupExemption.isPending = false
    lastLoggedFastAppGuardLine = nil
    lastLoggedGesturePolicyLines.removeAll()
  }

  @MainActor
  func invalidateCachedTarget(reason: String) {
    if mainOwned.app != nil || mainOwned.bundleId != nil {
      NSLog("AGENT_DEVICE_RUNNER_TARGET_CACHE_INVALIDATE reason=%@", reason)
    }
    mainOwned.app = nil
    mainOwned.bundleId = nil
    mainOwned.processIdentifier = nil
    resetTargetBoundState()
  }

  @MainActor
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

  @MainActor
  func refreshCachedTargetIfProcessChanged(bundleId: String) {
    guard mainOwned.bundleId == bundleId, mainOwned.app != nil else { return }
    let candidate = XCUIApplication(bundleIdentifier: bundleId)
    let observedProcessIdentifier = Self.processIdentifier(of: candidate)
    guard Self.shouldRefreshCachedTarget(
      cachedProcessIdentifier: mainOwned.processIdentifier,
      observedProcessIdentifier: observedProcessIdentifier
    ) else { return }
    NSLog(
      "AGENT_DEVICE_RUNNER_TARGET_CACHE_REFRESH bundle=%@ previousPid=%d currentPid=%d",
      bundleId,
      mainOwned.processIdentifier ?? 0,
      observedProcessIdentifier ?? 0
    )
    mainOwned.app = candidate
    mainOwned.processIdentifier = observedProcessIdentifier
    resetTargetBoundState()
    clearSnapshotXCTestChannelPenalty(reason: "target_process_changed")
    clearPrivateAXAcceptedDepth(reason: "target_process_changed")
    snapshotXCTestPenaltyWarmupExemption.isPending = true
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

  @MainActor
  func canUseFastForegroundAppGuard(
    activeApp: XCUIApplication,
    requestedBundleId: String?
  ) -> Bool {
    guard let requestedBundleId, mainOwned.bundleId == requestedBundleId, mainOwned.app != nil else {
      return false
    }
    guard activeApp.state == .runningForeground else { return false }
    writeFastAppGuardMarker(bundleId: requestedBundleId, state: activeApp.state)
    return true
  }

  @MainActor
  func writeFastAppGuardMarker(bundleId: String, state: XCUIApplication.State) {
    // The command is on the adjacent COMMAND_ACCEPTED line; repeating it here would make a deduped
    // marker read as if only that command ever passed the guard.
    let line = "AGENT_DEVICE_RUNNER_FAST_APP_GUARD bundle=\(bundleId) state=\(state.rawValue)"
    if lastLoggedFastAppGuardLine != line {
      lastLoggedFastAppGuardLine = line
      runnerMarkerWriter(line)
    }
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

  /// The `.existingApp` refusal: `activate()` on a not-running app is a bare launch, which would drop
  /// the URL of a launch SpringBoard still holds behind its "Open in …?" confirmation; see
  /// `APP_NOT_RUNNING_RUNNER_CODE` (#2852).
  func notRunningRefusal(command: Command, bundleId: String) -> Response? {
#if os(iOS)
    guard command.traits.launchPolicy == .existingApp,
      XCUIApplication(bundleIdentifier: bundleId).state == .notRunning
    else { return nil }
    NSLog(
      "AGENT_DEVICE_RUNNER_READ_TARGET_NOT_RUNNING bundle=%@ command=%@",
      bundleId,
      command.command.rawValue
    )
    return Response(
      ok: false,
      error: ErrorPayload(
        code: RunnerWireErrorCode.appNotRunning,
        message: "app '\(bundleId)' is not running",
        hint: "Reads do not launch the app. Relaunch it with open; if a system prompt such as a deep-link confirmation holds its launch, answer it with alert accept."
      )
    )
#else
    return nil
#endif
  }

  @MainActor
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
    mainOwned.app = target
    mainOwned.bundleId = bundleId
    mainOwned.processIdentifier = Self.processIdentifier(of: target)
    resetTargetBoundState()
    beginFirstInteractionStabilization()
    return target
  }

  /// Bounds what XCTest waits around one synthesized event instead of letting it spend a command's
  /// whole deadline, keeping whichever settle the caller named in `waits`. Callers gate the
  /// interaction themselves first (a scroll needs no extra wait, a text field is located, an alert
  /// button is read as hittable), which is what the dropped pre-event wait replaces rather than a
  /// check the runner skips (#2546).
  @MainActor
  func withBoundedInteractionIdleTimeoutIfSupported(
    _ target: XCUIApplication,
    waits: RunnerInteractionIdleWaits,
    operation: @MainActor () -> Void
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
  @MainActor
  private func performWithQuiescenceSkippedIfSupported(
    _ target: XCUIApplication,
    waits: RunnerInteractionIdleWaits,
    operation: @MainActor () -> Void
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
      let block: @convention(block) () -> Void = { _ = runOnMainActor(escapableOperation) }
      performWithOptions(
        target,
        selector,
        options,
        block
      )
    }
  }

  // MARK: - Session-Loss Retry

  func shouldRetryException(_ command: Command, message: String) -> Bool {
    guard command.traits.retryOnSessionLoss else { return false }
    // XCTest raises this AX error as an ObjC exception whose reason is the only handle on it.
    return message.lowercased().contains("kaxerrorservernotfound")
  }

  func shouldRetryResponse(_ response: Response) -> Bool {
    guard response.ok == false else { return false }
    return response.error?.retryableFailure != nil
  }

  // MARK: - Interaction Stabilization

  @MainActor
  func applyInteractionStabilizationIfNeeded() {
    if mainOwned.needsPostSnapshotInteractionDelay {
      sleepFor(postSnapshotInteractionDelay)
      mainOwned.needsPostSnapshotInteractionDelay = false
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
