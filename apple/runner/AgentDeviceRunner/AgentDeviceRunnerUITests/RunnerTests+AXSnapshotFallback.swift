import XCTest

extension RunnerTests {
  private static let privateAXSnapshotMaxNodes = 5_000

  /// Upper bound on element-rooted follow-up snapshot requests per capture. A
  /// depth-capped Bluesky-class tree resolves in 1-3 chained requests (~100-300ms
  /// each); the bound exists so a pathological tree cannot stack requests past
  /// the capture-plan deadline, which is also enforced per call.
  private static let privateAXDeepExtensionCallLimit = 8

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
      let candidates = (coverage[RunnerAXSnapshotCustomActionsCandidatesKey] as? NSNumber)?.intValue
    else { return nil }
    // read/candidates are the ratio and must both be present; the truncation
    // count is additive, so an older bridge that omits it reads as zero rather
    // than voiding the whole coverage.
    let truncated =
      (coverage[RunnerAXSnapshotCustomActionsTruncatedKey] as? NSNumber)?.intValue ?? 0
    let blocked = (coverage[RunnerAXSnapshotCustomActionsBlockedKey] as? NSNumber)?.boolValue ?? false
    return SnapshotCustomActionCoverage(
      read: read, candidates: candidates, truncated: truncated, blocked: blocked)
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
    app: XCUIApplication,
    hint: CaptureHint,
    deadline: Date = .distantFuture
  ) -> SnapshotAcquisition? {
    #if os(iOS) && targetEnvironment(simulator)
      let requestedDepth = hint.depth ?? 64
      // An explicit --depth request is honored as asked: no accepted-depth
      // memory, no frontier extension past it.
      let exactDepthRequested = hint.depth != nil
      let rememberedDepth =
        exactDepthRequested
        ? nil
        : rememberedPrivateAXAcceptedDepth(
          bundleId: currentBundleId,
          processIdentifier: currentAppProcessIdentifier
        )
      let attemptDepths = Self.privateAXAttemptDepths(
        requestedDepth: requestedDepth,
        rememberedDepth: rememberedDepth
      )
      var response: [String: Any] = [:]
      var effectiveDepth = requestedDepth
      var lastError = "unknown private AX snapshot failure"
      for depth in attemptDepths {
        // The first rung always runs (the plan gated entry on its own budget); later rungs
        // stop when the capture-plan deadline is spent so ladder retries can never stack
        // past the runner's main-thread watchdog (#1105).
        if depth != attemptDepths.first, Date() >= deadline {
          NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_BUDGET_EXHAUSTED depth=%ld", depth)
          break
        }
        // Declared residue (#1797): the bridge caps the tree at 5000 nodes while serializing,
        // BEFORE either projection exists, so a raw capture of a huge screen is bounded rather
        // than failing the way the tree backend's own raw cap does. The cap is disclosed as
        // `truncated`, and it applied to the acquired tree before this projection split too.
        response = RunnerAXSnapshotBridge.snapshotTree(
          for: app,
          maxDepth: depth,
          maxNodes: Self.privateAXSnapshotMaxNodes,
          deepExtensionCallLimit: exactDepthRequested ? 0 : Self.privateAXDeepExtensionCallLimit,
          customActionLimit: hint.customActions ? Self.privateAXCustomActionLimit : 0,
          deadline: deadline
        )
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
      guard response["ok"] as? Bool == true else {
        NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_FAILED=%@", lastError)
        return nil
      }
      // Only a capture that actually descended records memory: a first-rung success on a
      // remembered depth deliberately does NOT refresh the TTL, so expiry re-probes the full
      // requested depth once per window instead of capping this screen class forever.
      if !exactDepthRequested, effectiveDepth != attemptDepths.first {
        rememberPrivateAXAcceptedDepth(
          bundleId: currentBundleId,
          processIdentifier: currentAppProcessIdentifier,
          depth: effectiveDepth
        )
      }
      guard let root = response["root"] as? [String: Any] else {
        NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_FAILED=missing root")
        return nil
      }

      let rootFrame = privateAXRect(root["frame"])
      let viewport = privateAXSnapshotViewport(app: app, rootFrame: rootFrame)
      let nodes = privateAXAcquisition(
        rawRoot: root,
        hint: hint,
        viewport: viewport
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
        viewport: viewport
      )
    #else
      return nil
    #endif
  }

  /// The viewport read is XCTest main-thread work — the exact channel the penalty marks as
  /// grinding on this screen class. Under penalty it reliably burns its full timeout and
  /// falls back anyway (~1s added to every private AX capture on the Bluesky bench feed),
  /// so honor the penalty here the same way capture plans do.
  func shouldReadPrivateAXViewportViaXCTest() -> Bool {
    !hasAbandonedTreeCapture() && !isSnapshotXCTestChannelPenalized(bundleId: currentBundleId)
  }

  private func privateAXSnapshotViewport(app: XCUIApplication, rootFrame: CGRect) -> CGRect {
    let fallback = rootFrame.isEmpty ? CGRect.infinite : rootFrame
    guard shouldReadPrivateAXViewportViaXCTest() else {
      return fallback
    }
    do {
      let viewport = try runMainThreadWork(
        timeout: 1,
        timeoutError: snapshotMainThreadTimeoutError("reading private AX viewport")
      ) {
        self.safeSnapshotViewport(app: app)
      }
      if viewport.isInfinite || viewport.isNull || viewport.isEmpty {
        return fallback
      }
      return viewport
    } catch {
      NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_VIEWPORT_FALLBACK=%@", String(describing: error))
      return fallback
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

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
// MARK: - In-bundle unit tests

extension RunnerTests {
  func testPrivateAXAttemptDepthsAppliesRememberedDepth() {
    XCTAssertEqual(
      Self.privateAXAttemptDepths(requestedDepth: 64, rememberedDepth: nil),
      [64, 56, 40, 24, 12]
    )
    XCTAssertEqual(
      Self.privateAXAttemptDepths(requestedDepth: 64, rememberedDepth: 56),
      [56, 40, 24, 12]
    )
    XCTAssertEqual(Self.privateAXAttemptDepths(requestedDepth: 64, rememberedDepth: 12), [12])
    // Remembered at/above the requested depth changes nothing.
    XCTAssertEqual(
      Self.privateAXAttemptDepths(requestedDepth: 64, rememberedDepth: 64),
      [64, 56, 40, 24, 12]
    )
    // A shallower explicit request keeps its own rungs; deeper stale memory is ignored.
    XCTAssertEqual(Self.privateAXAttemptDepths(requestedDepth: 24, rememberedDepth: 56), [24, 12])
  }

  /// Executed producer contract for the #1627 review blocker: a frontier whose
  /// live element vanished, and one whose re-rooted request fails, must BOTH
  /// count as missed — an all-miss extension reporting itself drained would
  /// present a capped capture as complete. Goes red if either miss-path
  /// increment in extendSnapshotFrontiers is removed.
  func testDeepExtensionCountsMissedFrontiers() {
    // Element vanished (list churn between serialization and extension): the
    // fabricated snapshot answers nil for accessibilityElement — missed, and
    // no request call is consumed. (An explicit nil property: bare NSObject
    // resolves the key through a UIKit category and would take the call path.)
    let orphan = RunnerAXSnapshotFrontier()
    orphan.snapshot = FrontierSnapshotWithoutElementForTesting()
    orphan.node = NSMutableDictionary()
    // Re-rooted request fails: the element resolves but the client cannot
    // serve requestSnapshotForElement — one consumed call AND a miss.
    let unreachable = RunnerAXSnapshotFrontier()
    unreachable.snapshot = FrontierSnapshotWithElementForTesting()
    unreachable.node = NSMutableDictionary()

    var nodeCount = 0
    var truncated = ObjCBool(false)
    let outcome = RunnerAXSnapshotBridge.extend(
      NSMutableArray(array: [orphan, unreachable]),
      axClient: NSObject(),
      attributes: [],
      maxDepth: 56,
      maxNodes: 5_000,
      nodeCount: &nodeCount,
      truncated: &truncated,
      callsAllowed: 8,
      mergedLeaves: nil,
      deadline: nil
    )

    XCTAssertEqual(outcome?[RunnerAXSnapshotDeepExtensionMissedKey] as? Int, 2)
    XCTAssertEqual(outcome?[RunnerAXSnapshotDeepExtensionCallsKey] as? Int, 1)
    XCTAssertEqual(outcome?[RunnerAXSnapshotDeepExtensionPendingKey] as? Int, 0)
    XCTAssertEqual(outcome?[RunnerAXSnapshotDeepExtensionNodesAddedKey] as? Int, 0)
    XCTAssertFalse(truncated.boolValue)
    // And the consumer verdict over exactly this outcome: still depth-limited.
    XCTAssertTrue(
      Self.privateAXDepthLimited(
        effectiveDepth: 56, requestedDepth: 64, pendingFrontiers: 0, missedFrontiers: 2))
  }

  func testPrivateAXDepthLimitedRequiresEveryFrontierResolved() {
    // Un-capped capture is never depth-limited, extension or not.
    XCTAssertFalse(
      Self.privateAXDepthLimited(
        effectiveDepth: 64, requestedDepth: 64, pendingFrontiers: nil, missedFrontiers: nil))
    // Capped with no extension outcome (never ran) stays depth-limited.
    XCTAssertTrue(
      Self.privateAXDepthLimited(
        effectiveDepth: 56, requestedDepth: 64, pendingFrontiers: nil, missedFrontiers: nil))
    // Fully drained extension clears the verdict.
    XCTAssertFalse(
      Self.privateAXDepthLimited(
        effectiveDepth: 56, requestedDepth: 64, pendingFrontiers: 0, missedFrontiers: 0))
    // Budget exhaustion (pending frontiers) keeps it.
    XCTAssertTrue(
      Self.privateAXDepthLimited(
        effectiveDepth: 56, requestedDepth: 64, pendingFrontiers: 2, missedFrontiers: 0))
    // The #1627 review blocker: an all-miss extension (elements vanished or
    // re-rooted requests failed) resolved nothing — it must NOT present the
    // capture as complete just because the queue emptied.
    XCTAssertTrue(
      Self.privateAXDepthLimited(
        effectiveDepth: 56, requestedDepth: 64, pendingFrontiers: 0, missedFrontiers: 8))
  }

  func testPrivateAXAcceptedDepthMemoryMatchesBundleProcessAndExpires() {
    defer { clearPrivateAXAcceptedDepth(reason: "test-cleanup") }

    rememberPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: 111, depth: 56)
    XCTAssertEqual(
      rememberedPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: 111),
      56
    )
    XCTAssertNil(rememberedPrivateAXAcceptedDepth(bundleId: "com.other.app", processIdentifier: 111))
    // A relaunch changes the PID; the new process must re-probe the full depth even inside the
    // TTL, and an unknown current PID (post-invalidation) must never match.
    XCTAssertNil(rememberedPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: 222))
    XCTAssertNil(rememberedPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: nil))

    // Expired memory stops applying (the expiry re-probes the full requested depth).
    privateAXAcceptedDepthUntil = Date(timeIntervalSinceNow: -1)
    XCTAssertNil(rememberedPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: 111))
  }

  func testPrivateAXAcceptedDepthMemoryRequiresProcessIdentifierToRecord() {
    defer { clearPrivateAXAcceptedDepth(reason: "test-cleanup") }

    rememberPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: nil, depth: 56)
    XCTAssertNil(
      rememberedPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: nil)
    )
  }

  func testViewportReadSkippedWhileXCTestChannelPenalized() {
    // Pins the viewport fast path (#1587 review): every penalized private AX capture used to burn
    // the full 1s main-thread timeout on a doomed viewport read before falling back.
    currentBundleId = "xyz.blueskyweb.app"
    defer {
      currentBundleId = nil
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      abandonedTreeCaptureCount = 0
    }

    XCTAssertTrue(shouldReadPrivateAXViewportViaXCTest())

    penalizeSnapshotXCTestChannel(bundleId: "xyz.blueskyweb.app", reason: "test")
    XCTAssertFalse(shouldReadPrivateAXViewportViaXCTest())

    clearSnapshotXCTestChannelPenalty(reason: "test")
    XCTAssertTrue(shouldReadPrivateAXViewportViaXCTest())

    abandonedTreeCaptureCount = 1
    XCTAssertFalse(shouldReadPrivateAXViewportViaXCTest())
  }

  /// The wire field must reach both capture options AND the backend pin: custom
  /// actions are only readable through the private AX client, so a capture that
  /// asked for them but planned the XCTest tree backend would return a payload
  /// that structurally cannot carry them.
  func testCustomActionsRequestPinsPrivateAXBackend() throws {
    let asked = try JSONDecoder().decode(
      Command.self, from: Data(#"{"command":"snapshot","customActions":true}"#.utf8))
    let options = Self.presentationOptions(from: asked)
    XCTAssertTrue(options.customActions)
    XCTAssertEqual(options.preferredBackend, SnapshotBackendKind.privateAX.rawValue)
    XCTAssertTrue(
      Self.snapshotXCTestChannelTreatedAsPenalized(
        penalized: false, preferredBackend: options.preferredBackend))

    // An explicit pin is never overwritten by the implied one.
    let pinned = try JSONDecoder().decode(
      Command.self,
      from: Data(#"{"command":"snapshot","customActions":true,"preferredBackend":"tree"}"#.utf8))
    XCTAssertEqual(Self.presentationOptions(from: pinned).preferredBackend, "tree")

    // And the default capture neither asks nor pins.
    let bare = try JSONDecoder().decode(Command.self, from: Data(#"{"command":"snapshot"}"#.utf8))
    XCTAssertFalse(Self.presentationOptions(from: bare).customActions)
    XCTAssertNil(Self.presentationOptions(from: bare).preferredBackend)
  }

  /// A request-pinned backend degraded nothing, so its verdict must not claim
  /// slow accessibility work — that reason drives a user-facing warning.
  func testRequestPinnedBackendReportsItsOwnReason() {
    let requested = Self.xcTestChannelStateFirstFailure(
      .deferredToIndependentBackend, requestPinnedBackend: true)
    XCTAssertEqual(requested?.code, "requested-backend")
    XCTAssertFalse(requested?.reason.contains("slow accessibility work") ?? true)

    // The circuit breaker's own deferral keeps its established code and wording.
    let breaker = Self.xcTestChannelStateFirstFailure(.deferredToIndependentBackend)
    XCTAssertEqual(breaker?.code, "deferred")

    // The bounded probe and the healthy plan are untouched by the new flag.
    XCTAssertEqual(
      Self.xcTestChannelStateFirstFailure(.boundedXCTestProbe, requestPinnedBackend: true)?.code,
      "budget")
    XCTAssertNil(Self.xcTestChannelStateFirstFailure(.normal, requestPinnedBackend: true))
  }

  /// The disclosure only exists if the counts survive the bridge boundary, and
  /// "did not ask" must stay distinguishable from "read none".
  func testCustomActionCoverageParsesOnlyCompletePairs() {
    let coverage = Self.privateAXCustomActionCoverage([
      RunnerAXSnapshotCustomActionsReadKey: 12,
      RunnerAXSnapshotCustomActionsCandidatesKey: 19,
    ])
    XCTAssertEqual(coverage?.read, 12)
    XCTAssertEqual(coverage?.candidates, 19)

    // Absent key = the capture never asked; it must not read as (0, 0), which
    // would warn "0 of 0" on every default capture.
    XCTAssertNil(Self.privateAXCustomActionCoverage(nil))
    // A half-present pair cannot express a ratio, so it is dropped whole.
    XCTAssertNil(
      Self.privateAXCustomActionCoverage([RunnerAXSnapshotCustomActionsReadKey: 12]))
  }

  /// The AX call cannot be cancelled once issued, so the read deadline frees
  /// only the caller — the call keeps running. Without containment, repeating
  /// `snapshot --actions` against a wedged element would stack orphaned reads,
  /// all sharing one XCAXClient. This pins the containment: one serial queue and
  /// a single-flight refusal that adds no work while a read is outstanding.
  func testHungCustomActionReadIsContainedAndRecovers() {
    let hung = HungAXClientForTesting()
    let element = NSObject()
    let dispatchesBefore = RunnerAXSnapshotBridge.customActionReadDispatchCount()
    let blockedBefore = RunnerAXSnapshotBridge.customActionReadBlockedCount()
    defer { hung.release() }

    // 1. First read wedges. The caller is freed by the deadline, but the call is
    //    still out there, so it stays counted in flight.
    var completed = ObjCBool(true)
    let firstStarted = Date()
    let first = RunnerAXSnapshotBridge.customActionNames(
      forElement: element, axClient: hung, completed: &completed)
    XCTAssertNil(first)
    XCTAssertFalse(completed.boolValue)
    XCTAssertGreaterThanOrEqual(-firstStarted.timeIntervalSinceNow, 0.9)
    XCTAssertEqual(RunnerAXSnapshotBridge.customActionReadsInFlight(), 1)
    XCTAssertEqual(
      RunnerAXSnapshotBridge.customActionReadDispatchCount(), dispatchesBefore + 1)

    // 2. Repeats do NOT accumulate: no new dispatch, still exactly one in
    //    flight, and every repeat is refused by single-flight admission.
    for _ in 0..<5 {
      XCTAssertNil(
        RunnerAXSnapshotBridge.customActionNames(
          forElement: element, axClient: hung, completed: &completed))
      XCTAssertFalse(completed.boolValue)
    }
    XCTAssertEqual(RunnerAXSnapshotBridge.customActionReadsInFlight(), 1)
    XCTAssertEqual(
      RunnerAXSnapshotBridge.customActionReadDispatchCount(), dispatchesBefore + 1)
    XCTAssertEqual(RunnerAXSnapshotBridge.customActionReadBlockedCount(), blockedBefore + 5)

    // 3. A capture in that state discloses the skip rather than presenting the
    //    unread elements as action-free — and spends no read budget doing it.
    let leaf = RunnerAXSnapshotFrontier()
    leaf.snapshot = FrontierSnapshotWithElementForTesting()
    leaf.node = NSMutableDictionary(dictionary: ["label": "feedItem", "children": []])
    let coverage = RunnerAXSnapshotBridge.annotateCustomActions(
      onMergedLeaves: [leaf], axClient: hung, limit: 12, rootFrame: .zero, deadline: nil)
    XCTAssertEqual(coverage[RunnerAXSnapshotCustomActionsBlockedKey] as? Bool, true)
    XCTAssertEqual(coverage[RunnerAXSnapshotCustomActionsReadKey] as? Int, 0)
    XCTAssertEqual(coverage[RunnerAXSnapshotCustomActionsCandidatesKey] as? Int, 1)
    XCTAssertEqual(
      RunnerAXSnapshotBridge.customActionReadDispatchCount(), dispatchesBefore + 1)

    // And the rendered verdict names the hang, not the scroll remedy.
    let blockedWarnings = Self.customActionCoverageWarnings(
      Self.privateAXCustomActionCoverage(coverage)!)
    XCTAssertEqual(blockedWarnings.count, 1)
    XCTAssertTrue(blockedWarnings[0].contains("still hung"))
    XCTAssertFalse(blockedWarnings[0].contains("Scroll"))

    // 4. Recovery: once the wedged call returns, reads resume by themselves.
    hung.release()
    let recovered = expectation(description: "in-flight drains")
    DispatchQueue.global().async {
      while RunnerAXSnapshotBridge.customActionReadsInFlight() > 0 {
        usleep(20_000)
      }
      recovered.fulfill()
    }
    wait(for: [recovered], timeout: 5)

    completed = ObjCBool(false)
    XCTAssertNil(
      RunnerAXSnapshotBridge.customActionNames(
        forElement: element, axClient: hung, completed: &completed))
    // Completed (the fake answers nil actions), which is the point: the pass is
    // live again rather than latched off.
    XCTAssertTrue(completed.boolValue)
    XCTAssertEqual(
      RunnerAXSnapshotBridge.customActionReadDispatchCount(), dispatchesBefore + 2)
  }

  /// The element budget bounds how many elements we read; these caps bound what
  /// any ONE element can put in the response. Clipping must be reported, since
  /// a clipped list looks exactly like a complete one.
  func testActionNamesAreCappedPerElementAndReported() {
    var truncated = ObjCBool(true)

    // Under both caps: untouched, nothing to report.
    let small = ["Reply", "Repost"]
    XCTAssertEqual(
      RunnerAXSnapshotBridge.cappedActionNames(small, truncated: &truncated), small)
    XCTAssertFalse(truncated.boolValue)

    // More actions than the per-element cap: clipped to the first 8, reported.
    let many = (1...20).map { "Action \($0)" }
    let cappedMany = RunnerAXSnapshotBridge.cappedActionNames(many, truncated: &truncated)
    XCTAssertEqual(cappedMany.count, 8)
    XCTAssertEqual(cappedMany.first, "Action 1")
    XCTAssertTrue(truncated.boolValue)

    // A single very long name is shortened, reported, and stays one string.
    let long = String(repeating: "a", count: 500)
    let cappedLong = RunnerAXSnapshotBridge.cappedActionNames([long], truncated: &truncated)
    XCTAssertEqual(cappedLong.count, 1)
    XCTAssertTrue(truncated.boolValue)
    XCTAssertLessThan(cappedLong[0].count, long.count)
    XCTAssertTrue(cappedLong[0].hasSuffix("…"))

    // Empty input is not "truncated".
    XCTAssertEqual(RunnerAXSnapshotBridge.cappedActionNames([], truncated: &truncated), [])
    XCTAssertFalse(truncated.boolValue)
  }

  /// A capped pass must say so; a complete one must stay silent.
  func testPartialCustomActionPassIsDisclosedAndCompleteOneIsNot() {
    let partial = SnapshotQuality(
      state: "recovered", backend: "private-ax", reason: nil, reasonCode: "requested-backend",
      effectiveDepth: nil, collapsedLeafIndexes: nil,
      customActions: SnapshotCustomActionCoverage(read: 12, candidates: 19, truncated: 0, blocked: false))
    let message = Self.legacyQualityMessage(partial)
    XCTAssertTrue(message?.contains("12 of 19 merged elements") == true)
    XCTAssertTrue(message?.contains("remaining 7") == true)
    XCTAssertTrue(message?.contains("Scroll them into view") == true)

    // Every candidate read: nothing to disclose, and a healthy capture stays silent.
    let complete = SnapshotQuality(
      state: "healthy", backend: "private-ax", reason: nil, reasonCode: nil,
      effectiveDepth: nil, collapsedLeafIndexes: nil,
      customActions: SnapshotCustomActionCoverage(read: 19, candidates: 19, truncated: 0, blocked: false))
    XCTAssertNil(Self.legacyQualityMessage(complete))

    // A healthy capture with an incomplete pass still discloses — the guard must
    // not key the disclosure off degradation state.
    let healthyButCapped = SnapshotQuality(
      state: "healthy", backend: "private-ax", reason: nil, reasonCode: nil,
      effectiveDepth: nil, collapsedLeafIndexes: nil,
      customActions: SnapshotCustomActionCoverage(read: 12, candidates: 19, truncated: 0, blocked: false))
    XCTAssertTrue(
      Self.legacyQualityMessage(healthyButCapped)?.contains("12 of 19") == true)
  }

  /// Action names annotated by the bridge must survive into the emitted node —
  /// the whole point of the capture is that the merged card names its hidden
  /// affordances.
  func testPrivateAXNodesCarryAnnotatedCustomActions() {
    let tree: [String: Any] = [
      "type": Int(XCUIElement.ElementType.application.rawValue),
      "label": "Blue Sky",
      "frame": ["x": 0, "y": 0, "width": 390, "height": 844],
      "children": [
        [
          "type": Int(XCUIElement.ElementType.link.rawValue),
          "label": "feedItem-by-whiskers.test",
          "frame": ["x": 0, "y": 100, "width": 390, "height": 200],
          "actions": ["Reply", "Repost", "Open post options menu"],
          "children": [],
        ],
        [
          "type": Int(XCUIElement.ElementType.button.rawValue),
          "label": "Compose",
          "frame": ["x": 300, "y": 700, "width": 60, "height": 60],
          "children": [],
        ],
      ],
    ]
    let nodes = privateAXAcquisition(
      rawRoot: tree,
      hint: CaptureHint(
        projection: .regular, depth: nil, interactiveOnly: false, customActions: false),
      viewport: CGRect(x: 0, y: 0, width: 390, height: 844)
    )

    let card = nodes.first { $0.label == "feedItem-by-whiskers.test" }
    XCTAssertEqual(card?.actions, ["Reply", "Repost", "Open post options menu"])
    // A node the bridge did not annotate stays absent, not empty.
    XCTAssertNil(nodes.first { $0.label == "Compose" }?.actions)
  }

  func testPrivateAXAcquisitionDoesNotInterpretScope() {
    let tree: [String: Any] = [
      "type": 1, "label": "App",
      "children": [
        [
          "type": 9, "identifier": "homeScreen",
          "children": [
            ["type": 48, "label": "Post body without the scope text", "children": []]
          ],
        ],
        ["type": 9, "label": "unrelated sibling", "children": []],
      ],
    ]
    // Scope never reaches acquisition: the hint derived for a scoped request carries no scope,
    // and the backend has no way to interpret one.
    let nodes = privateAXAcquisition(
      rawRoot: tree,
      hint: SnapshotPresentation.captureHint(
        for: PresentationOptions(
          interactiveOnly: false,
          depth: nil,
          scope: "homeScreen",
          raw: false
        )
      ),
      viewport: .infinite
    )

    let labels = nodes.compactMap { $0.label ?? $0.identifier }
    XCTAssertTrue(labels.contains("homeScreen"))
    // Descendants of the matched scope are included even when they do not contain the text.
    XCTAssertTrue(labels.contains("Post body without the scope text"))
    XCTAssertTrue(labels.contains("unrelated sibling"))
  }

  func testPrivateAXInteractiveFiltersLoginLikeHiddenDrawer() {
    let tree: [String: Any] = [
      "type": Int(XCUIElement.ElementType.application.rawValue),
      "label": "Blue Sky",
      "frame": ["x": 0, "y": 0, "width": 390, "height": 844],
      "children": [
        [
          "type": Int(XCUIElement.ElementType.scrollView.rawValue),
          "frame": ["x": 0, "y": 0, "width": 390, "height": 844],
          "children": [
            [
              "type": Int(XCUIElement.ElementType.image.rawValue),
              "label": "Callstack",
              "frame": ["x": 145, "y": 104, "width": 100, "height": 100],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.staticText.rawValue),
              "label": "Welcome back",
              "frame": ["x": 32, "y": 260, "width": 326, "height": 32],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.textField.rawValue),
              "label": "Email",
              "identifier": "login.email",
              "frame": ["x": 32, "y": 348, "width": 326, "height": 48],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.secureTextField.rawValue),
              "label": "Password",
              "identifier": "login.password",
              "frame": ["x": 32, "y": 412, "width": 326, "height": 48],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.button.rawValue),
              "label": "Sign in",
              "identifier": "login.submit",
              "frame": ["x": 32, "y": 492, "width": 326, "height": 52],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.link.rawValue),
              "label": "Forgot password?",
              "frame": ["x": 128, "y": 568, "width": 134, "height": 32],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.button.rawValue),
              "label": "Admin settings",
              "frame": ["x": -260, "y": 184, "width": 220, "height": 44],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.other.rawValue),
              "frame": ["x": 16, "y": 184, "width": 220, "height": 44],
              "children": [],
            ],
          ],
        ]
      ],
    ]
    let viewport = CGRect(x: 0, y: 0, width: 390, height: 844)
    let hint = CaptureHint(
      projection: .regular, depth: nil, interactiveOnly: true, customActions: false)
    let acquired = privateAXAcquisition(rawRoot: tree, hint: hint, viewport: viewport)
    // Acquisition serializes the drawer too; the shared fold is what hides it (#1797).
    XCTAssertTrue(acquired.compactMap(\.label).contains("Admin settings"))

    let capture = SnapshotPresentation.presentRegular(
      SnapshotAcquisition(
        hint: hint, nodes: acquired, truncated: false, effectiveDepth: nil, viewport: viewport),
      options: PresentationOptions(interactiveOnly: true, depth: nil, scope: nil, raw: false),
      policy: .cursorProjected
    )
    let labels = (capture.payload.nodes ?? []).compactMap { $0.label }
    XCTAssertEqual(
      labels,
      ["Blue Sky", "Callstack", "Welcome back", "Email", "Password", "Sign in", "Forgot password?"]
    )
    XCTAssertFalse(labels.contains("Admin settings"))
  }
}

/// Stands in for an AX client whose `attributesForElement:` never returns —
/// the wedged-server case the containment exists for. `release()` lets the
/// hung call finish so recovery is observable.
private final class HungAXClientForTesting: NSObject {
  private let gate = DispatchSemaphore(value: 0)
  private let releasedOnce = NSLock()
  private var released = false

  @objc(attributesForElement:attributes:error:)
  func attributes(forElement element: Any, attributes: Any, error: NSErrorPointer) -> Any? {
    releasedOnce.lock()
    let alreadyReleased = released
    releasedOnce.unlock()
    // Once the wedge clears, the server answers normally again — that is what
    // makes the recovery leg a recovery rather than a second hang.
    if alreadyReleased {
      return nil
    }
    gate.wait()
    return nil
  }

  func release() {
    releasedOnce.lock()
    defer { releasedOnce.unlock() }
    guard !released else { return }
    released = true
    gate.signal()
  }
}

/// Minimal snapshot stand-in whose accessibilityElement resolves (so the
/// extension proceeds to the request) while the paired fake client cannot
/// serve it — the failed-re-root miss path.
private final class FrontierSnapshotWithElementForTesting: NSObject {
  @objc let accessibilityElement = NSObject()
}

/// The vanished-element case: KVC resolves the property and gets nil.
private final class FrontierSnapshotWithoutElementForTesting: NSObject {
  @objc let accessibilityElement: NSObject? = nil
}
#endif
