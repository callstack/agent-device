import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  private static let privateAXSnapshotMaxNodes = 5_000

  /// Upper bound on element-rooted follow-up snapshot requests per capture. A
  /// depth-capped Bluesky-class tree resolves in 1-3 chained requests (~100-300ms
  /// each); the bound exists so a pathological tree cannot stack requests past
  /// the capture-plan deadline, which is also enforced per call.
  static let privateAXDeepExtensionCallLimit = 8

  /// Upper bound on per-element custom-action reads per capture. Each is its own
  /// AX round trip (~100ms on an idle simulator), so this caps the opt-in cost
  /// at roughly a second on top of the capture; the capture-plan deadline stops
  /// it earlier under load. A screenful of merged cards is well under this.
  private static let privateAXCustomActionLimit = 12

  /// A capture is depth-limited unless its frontier extension resolved every
  /// capped node: frontiers left pending (budget/deadline) or missed (element
  /// vanished, re-rooted request failed) mean subtrees are still absent, and
  /// presenting such a capture as complete would hide exactly the content the
  /// extension exists to recover. nil extension counts = extension never ran.
  static func privateAXDepthLimited(
    effectiveDepth: Int,
    requestedDepth: Int,
    pendingFrontiers: Int?,
    missedFrontiers: Int?
  ) -> Bool {
    guard effectiveDepth < requestedDepth else { return false }
    guard let pendingFrontiers, let missedFrontiers else { return true }
    return pendingFrontiers > 0 || missedFrontiers > 0
  }
  /// Deep React Native trees make the AX server reject bulk snapshot requests outright with
  /// kAXErrorIllegalArgument once the requested depth crosses a tree-size-dependent limit
  /// (observed between depth 56 and 64 on the Bluesky Home feed; the limit moves with live
  /// content). Retrying the same request at a shallower depth succeeds, so on failure we walk
  /// this ladder instead of giving up. Capped at 4 attempts to bound worst-case latency on
  /// apps where the AX surface is genuinely unavailable.
  static let privateAXSnapshotDepthLadder = [56, 40, 24, 12]

  /// Ladder rungs for one capture. A remembered accepted depth (recorded when a prior capture's
  /// deep request was rejected) drops the rungs above it, so the known-rejected deep request is
  /// not re-paid on every capture of the same screen class.
  static func privateAXAttemptDepths(requestedDepth: Int, rememberedDepth: Int?) -> [Int] {
    var depths = [requestedDepth]
    depths.append(contentsOf: privateAXSnapshotDepthLadder.filter { $0 < requestedDepth })
    guard let remembered = rememberedDepth, remembered < requestedDepth else { return depths }
    return depths.filter { $0 <= remembered }
  }

  /// The bridge omits the key entirely when the capture did not ask for custom
  /// actions, which is the difference between "nothing to disclose" and "read
  /// none of them" — so a missing key must stay nil, never (0, 0).
  static func privateAXCustomActionCoverage(_ raw: Any?) -> SnapshotCustomActionCoverage? {
    guard let coverage = raw as? [String: Any],
      let read = (coverage[RunnerAXSnapshotCustomActionsReadKey] as? NSNumber)?.intValue,
      let candidates = (coverage[RunnerAXSnapshotCustomActionsCandidatesKey] as? NSNumber)?.intValue,
      let truncated = (coverage[RunnerAXSnapshotCustomActionsTruncatedKey] as? NSNumber)?.intValue,
      let blocked = (coverage[RunnerAXSnapshotCustomActionsBlockedKey] as? NSNumber)?.boolValue
    else { return nil }
    return SnapshotCustomActionCoverage(
      read: read, candidates: candidates, truncated: truncated, blocked: blocked)
  }

  struct PrivateAXLadderOutcome {
    let response: [String: Any]
    let effectiveDepth: Int
    let deadlineSpent: Bool
    let lastError: String

    var succeeded: Bool { response["ok"] as? Bool == true }
  }

  /// Walks the ladder rungs until one capture succeeds. The first rung always runs (the plan
  /// gated entry on its own budget); later rungs stop when the capture-plan deadline is spent so
  /// ladder retries can never stack past the runner's main-thread watchdog (#1105).
  static func privateAXLadderCapture(
    attemptDepths: [Int],
    deadline: Date,
    capture: (Int) -> [String: Any]
  ) -> PrivateAXLadderOutcome {
    var response: [String: Any] = [:]
    var effectiveDepth = attemptDepths.first ?? 0
    var lastError = "unknown private AX snapshot failure"
    for depth in attemptDepths {
      if depth != attemptDepths.first, Date() >= deadline {
        NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_BUDGET_EXHAUSTED depth=%ld", depth)
        return PrivateAXLadderOutcome(
          response: response, effectiveDepth: effectiveDepth, deadlineSpent: true,
          lastError: lastError)
      }
      response = capture(depth)
      if response["ok"] as? Bool == true {
        effectiveDepth = depth
        break
      }
      lastError = response["error"] as? String ?? lastError
      NSLog(
        "AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_DEPTH_RETRY depth=%ld error=%@",
        depth,
        lastError
      )
    }
    return PrivateAXLadderOutcome(
      response: response, effectiveDepth: effectiveDepth, deadlineSpent: false, lastError: lastError)
  }

  /// Only a capture that actually descended records memory: a first-rung success on a
  /// remembered depth deliberately does NOT refresh the TTL, so expiry re-probes the full
  /// requested depth once per window instead of capping this screen class forever.
  func recordPrivateAXAcceptedDepth(
    bundleId: String?,
    processIdentifier: Int?,
    exactDepthRequested: Bool,
    effectiveDepth: Int,
    attemptDepths: [Int]
  ) {
    guard !exactDepthRequested, effectiveDepth != attemptDepths.first else { return }
    rememberPrivateAXAcceptedDepth(
      bundleId: bundleId,
      processIdentifier: processIdentifier,
      depth: effectiveDepth
    )
  }

  func rememberPrivateAXAcceptedDepth(bundleId: String?, processIdentifier: Int?, depth: Int) {
    // No PID means no way to notice a relaunch later; record nothing rather than risk serving
    // a stale shallow rung to a fresh process.
    guard let processIdentifier else { return }
    privateAXAcceptedDepthLock.lock()
    privateAXAcceptedDepthBundleId = bundleId
    privateAXAcceptedDepthProcessIdentifier = processIdentifier
    privateAXAcceptedDepth = depth
    privateAXAcceptedDepthUntil = Date().addingTimeInterval(snapshotXCTestChannelPenaltyDuration)
    privateAXAcceptedDepthLock.unlock()
    NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_DEPTH_REMEMBERED depth=%ld bundle=%@", depth, bundleId ?? "")
  }

  func rememberedPrivateAXAcceptedDepth(bundleId: String?, processIdentifier: Int?) -> Int? {
    privateAXAcceptedDepthLock.lock()
    defer { privateAXAcceptedDepthLock.unlock() }
    guard Date() < privateAXAcceptedDepthUntil else { return nil }
    guard privateAXAcceptedDepthBundleId == bundleId else { return nil }
    guard let processIdentifier, privateAXAcceptedDepthProcessIdentifier == processIdentifier else {
      return nil
    }
    return privateAXAcceptedDepth
  }

  func clearPrivateAXAcceptedDepth(reason: String) {
    privateAXAcceptedDepthLock.lock()
    let hadMemory = privateAXAcceptedDepth != nil && Date() < privateAXAcceptedDepthUntil
    privateAXAcceptedDepthBundleId = nil
    privateAXAcceptedDepthProcessIdentifier = nil
    privateAXAcceptedDepth = nil
    privateAXAcceptedDepthUntil = .distantPast
    privateAXAcceptedDepthLock.unlock()
    if hadMemory {
      NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_DEPTH_MEMORY_CLEARED reason=%@", reason)
    }
  }

  func privateAXSnapshotAcquisition(
    target: SnapshotCaptureTarget,
    hint: CaptureHint,
    deadline: Date = .distantFuture
  ) -> SnapshotAcquisition? {
    #if os(iOS) && targetEnvironment(simulator)
      let app = target.app
      let requestedDepth = hint.rawTraversalDepth ?? 64
      // An explicit --depth request is honored as asked: no accepted-depth
      // memory, no frontier extension past it.
      let exactDepthRequested = hint.rawTraversalDepth != nil
      let rememberedDepth =
        exactDepthRequested
        ? nil
        : rememberedPrivateAXAcceptedDepth(
          bundleId: target.bundleId,
          processIdentifier: target.processIdentifier
        )
      let attemptDepths = Self.privateAXAttemptDepths(
        requestedDepth: requestedDepth,
        rememberedDepth: rememberedDepth
      )
      // Declared residue (#1797): the bridge caps the tree at 5000 nodes while serializing,
      // BEFORE either projection exists, so a raw capture of a huge screen is bounded rather
      // than failing the way the tree backend's own raw cap does. The cap is disclosed as
      // `truncated`, and it applied to the acquired tree before this projection split too.
      let ladder = Self.privateAXLadderCapture(attemptDepths: attemptDepths, deadline: deadline) {
        depth in
        RunnerAXSnapshotBridge.snapshotTree(
          for: app,
          maxDepth: depth,
          maxNodes: Self.privateAXSnapshotMaxNodes,
          deepExtensionCallLimit: exactDepthRequested ? 0 : Self.privateAXDeepExtensionCallLimit,
          customActionLimit: hint.customActions ? Self.privateAXCustomActionLimit : 0,
          deadline: deadline
        )
      }
      let response = ladder.response
      let effectiveDepth = ladder.effectiveDepth
      guard ladder.succeeded else {
        NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_FAILED=%@", ladder.lastError)
        return nil
      }
      recordPrivateAXAcceptedDepth(
        bundleId: target.bundleId,
        processIdentifier: target.processIdentifier,
        exactDepthRequested: exactDepthRequested,
        effectiveDepth: effectiveDepth,
        attemptDepths: attemptDepths
      )
      guard let root = response["root"] as? [String: Any] else {
        NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_FAILED=missing root")
        return nil
      }

      let rootFrame = privateAXRect(root["frame"])
      let geometry = privateAXSnapshotGeometry(
        app: app,
        bundleId: target.bundleId,
        rootFrame: rootFrame
      )
      let viewport = geometry.viewport
      let nodes = privateAXAcquisition(
        rawRoot: root,
        hint: hint
      )
      // Serialization-level emptiness only: an acquired-but-fully-clipped tree is presentation's
      // verdict now, surfaced by the plan's sparse classifier on the presented payload (#1797).
      if nodes.count <= 1 {
        NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_SPARSE=%ld", nodes.count)
        return nil
      }

      // A capture whose frontier extension resolved every capped node is
      // complete despite the per-request depth cap — reporting it as
      // depth-limited would send agents chasing deeper content that is not
      // there. Pending or missed frontiers keep the depth-limited verdict.
      let deepExtension = response[RunnerAXSnapshotDeepExtensionKey] as? [String: Any]
      let depthLimited = Self.privateAXDepthLimited(
        effectiveDepth: effectiveDepth,
        requestedDepth: requestedDepth,
        pendingFrontiers: deepExtension?[RunnerAXSnapshotDeepExtensionPendingKey] as? Int,
        missedFrontiers: deepExtension?[RunnerAXSnapshotDeepExtensionMissedKey] as? Int
      )
      NSLog(
        "AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_USED nodes=%ld depth=%ld extended=%ld",
        nodes.count,
        effectiveDepth,
        deepExtension?[RunnerAXSnapshotDeepExtensionNodesAddedKey] as? Int ?? 0
      )
      return SnapshotAcquisition(
        hint: hint,
        nodes: nodes,
        truncated: (response["truncated"] as? Bool) == true,
        effectiveDepth: depthLimited ? effectiveDepth : nil,
        customActions: Self.privateAXCustomActionCoverage(
          response[RunnerAXSnapshotCustomActionsKey]
        ),
        viewport: viewport,
        interfaceOrientation: geometry.interfaceOrientation
      )
    #else
      return nil
    #endif
  }

  /// The viewport read is XCTest main-thread work — the exact channel the penalty marks as
  /// grinding on this screen class. Under penalty it reliably burns its full timeout and
  /// falls back anyway (~1s added to every private AX capture on the Bluesky bench feed),
  /// so honor the penalty here the same way capture plans do.
  func shouldReadPrivateAXViewportViaXCTest(bundleId: String?) -> Bool {
    !hasAbandonedMainThreadWork() && !isSnapshotXCTestChannelPenalized(bundleId: bundleId)
  }

  /// The geometry this tier may anchor a rotation on. The bridge's own root frame is declared
  /// `.derived` rather than reported — it is a box this capture inferred for itself, not the app's
  /// frame — so a capture anchored on it reports no interface orientation and normalizes nothing:
  /// rotated system surfaces then stay as reported, which the consumers already treat as geometry
  /// they cannot measure (#2612).
  private func privateAXSnapshotGeometry(
    app: XCUIApplication,
    bundleId: String?,
    rootFrame: CGRect
  ) -> (viewport: SnapshotViewport, interfaceOrientation: Int) {
    let fallback = SnapshotViewport.derived(box: rootFrame)
    guard shouldReadPrivateAXViewportViaXCTest(bundleId: bundleId) else {
      return (fallback, RunnerInterfaceOrientation.unknown)
    }
    do {
      let anchor = try runMainThreadWork(
        "private_ax_viewport",
        timeout: 1,
        timeoutError: snapshotMainThreadTimeoutError("reading private AX viewport")
      ) {
        (
          viewport: self.safeSnapshotViewport(app: app),
          interfaceOrientation: self.capturedInterfaceOrientation(app: app)
        )
      }
      if anchor.viewport.rect == nil {
        return (fallback, RunnerInterfaceOrientation.unknown)
      }
      return (anchor.viewport, anchor.interfaceOrientation)
    } catch {
      NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_VIEWPORT_FALLBACK=%@", String(describing: error))
      return (fallback, RunnerInterfaceOrientation.unknown)
    }
  }

  func privateAXRect(_ value: Any?) -> CGRect {
    guard let frame = value as? [String: Any] else {
      return .zero
    }
    return CGRect(
      x: privateAXDouble(frame["x"]) ?? 0,
      y: privateAXDouble(frame["y"]) ?? 0,
      width: privateAXDouble(frame["width"]) ?? 0,
      height: privateAXDouble(frame["height"]) ?? 0
    )
  }

  private func privateAXDouble(_ value: Any?) -> Double? {
    if let value = value as? Double { return value }
    if let value = value as? NSNumber { return value.doubleValue }
    return nil
  }
}
