import XCTest

// MARK: - Snapshot capture plans (ADR 0004)
//
// Each snapshot strategy declares an ordered chain of capture backends. One runner walks the
// chain: capture, classify, accept the first payload the quality classifier calls usable, and
// stamp the outcome with a structured quality verdict so the daemon renders state instead of
// re-deriving it from node shapes. Recovery ordering is data here, never a per-call-site branch.

/// Structured quality verdict shipped with every iOS snapshot payload.
struct SnapshotQuality: Codable {
  /// healthy: first backend produced a usable tree. recovered: a later backend did.
  /// sparse: no backend produced a usable tree; the best attempt is returned as-is.
  let state: String
  /// Backend that produced the returned payload: tree | queries | private-ax.
  let backend: String
  /// Why recovery ran (first failure) or why the payload is degraded.
  let reason: String?
  /// Machine-readable reason: ax-rejected | sparse-tree | budget | no-nodes.
  let reasonCode: String?
  /// Private AX ladder cap when the accepted tree is shallower than requested.
  let effectiveDepth: Int?
  /// Leaves that merge many labels — a container marked accessible hides its descendants.
  let collapsedLeafIndexes: [Int]?
}

enum SnapshotBackendKind: String, CaseIterable {
  case recursiveTree = "tree"
  case querySweep = "queries"
  case privateAX = "private-ax"

  var usesXCTestAccessibilityChannel: Bool {
    switch self {
    case .recursiveTree, .querySweep:
      return true
    case .privateAX:
      return false
    }
  }

  var isAvailableOnCurrentPlatform: Bool {
    switch self {
    case .recursiveTree, .querySweep:
      return true
    case .privateAX:
      #if os(iOS) && targetEnvironment(simulator)
        return true
      #else
        return false
      #endif
    }
  }
}

enum SnapshotXCTestChannelPlanState: Equatable {
  case normal
  case deferredToIndependentBackend
  case boundedXCTestProbe
}

struct EffectiveSnapshotCapturePlan {
  let plan: [SnapshotBackendKind]
  let xCTestChannelState: SnapshotXCTestChannelPlanState
  let treeCaptureSliceBudgetOverride: TimeInterval?
}

/// What the plan runner does when every backend failed or stayed sparse.
enum SnapshotCaptureTerminalPolicy {
  /// Return the best sparse payload; if the tree backend hit a real AX serialization failure
  /// on an interactive request, fail closed: invalidate the cached target and mark runnerFatal
  /// (AX-unavailable target invalidation, CONTEXT.md).
  case sparseWithFatalOnAXFailure
  /// Re-throw the tree backend's AX failure (raw diagnostics preserve errors, ADR 0004).
  case throwOnAXFailure
}

struct SnapshotBackendCapture {
  let payload: DataPayload
  /// Set by the private AX backend when the ladder accepted a shallower depth than requested.
  let effectiveDepth: Int?
}

extension RunnerTests {
  static let sparseRecoveryTruncatedNodeThreshold = 8
  /// Umbrella wall-clock budget for one capture plan. Individual backends bound themselves,
  /// but chained recovery tiers must never stack past the 30s main-thread watchdog: when the
  /// budget is spent, remaining tiers are skipped and the best payload so far is returned.
  static let snapshotPlanBudget: TimeInterval = 20
  static let penalizedXCTestProbeTreeSliceBudget: TimeInterval = 1
  static let collapsedLeafMinimumSegments = 10

  static func payloadNodeCount(_ payload: DataPayload?) -> Int {
    payload?.nodes?.count ?? 0
  }

  // MARK: Plan definitions

  static let regularVisiblePlan: [SnapshotBackendKind] = [.recursiveTree, .querySweep, .privateAX]
  static let rawDiagnosticPlan: [SnapshotBackendKind] = [.recursiveTree, .privateAX]

  // MARK: XCTest accessibility channel penalty (cross-attempt memory, #1105/#1156)
  //
  // On some deep/dynamic screens the XCTest bulk snapshot no longer fails fast with
  // kAXErrorIllegalArgument (the #758 signature) — it grinds for many seconds first. One slow
  // grind is tolerable; re-grinding on every subsequent capture of the same screen buries the
  // main thread past the execution watchdog. After a slow, timed-out, or abandoned XCTest-backed
  // capture, later plans for the same bundle use non-XCTest recovery tiers until the penalty expires.

  func penalizeSnapshotXCTestChannel(bundleId: String?, reason: String) {
    snapshotXCTestChannelPenaltyLock.lock()
    snapshotXCTestChannelPenaltyBundleId = bundleId
    snapshotXCTestChannelPenaltyUntil = Date().addingTimeInterval(snapshotXCTestChannelPenaltyDuration)
    snapshotXCTestChannelPenaltyLock.unlock()
    NSLog(
      "AGENT_DEVICE_RUNNER_SNAPSHOT_XCTEST_CHANNEL_PENALIZED bundle=%@ reason=%@",
      bundleId ?? "",
      reason
    )
  }

  func isSnapshotXCTestChannelPenalized(bundleId: String?) -> Bool {
    snapshotXCTestChannelPenaltyLock.lock()
    defer { snapshotXCTestChannelPenaltyLock.unlock() }
    guard Date() < snapshotXCTestChannelPenaltyUntil else { return false }
    // A penalty recorded without a bundle id applies to whatever target is current.
    guard let penalized = snapshotXCTestChannelPenaltyBundleId else { return true }
    return penalized == bundleId
  }

  /// Pure plan-reorder rule: a penalized XCTest accessibility channel uses independent backends
  /// when the platform has one, otherwise it keeps XCTest work on a short probe. The raw
  /// diagnostic plan keeps tree-first errors, and unknown plans are left untouched.
  static func effectiveSnapshotCapturePlan(
    _ plan: [SnapshotBackendKind],
    xCTestChannelPenalized: Bool,
    availableBackends: Set<SnapshotBackendKind> = Set(SnapshotBackendKind.allCases)
  ) -> EffectiveSnapshotCapturePlan {
    guard xCTestChannelPenalized, plan == Self.regularVisiblePlan else {
      return EffectiveSnapshotCapturePlan(
        plan: plan,
        xCTestChannelState: .normal,
        treeCaptureSliceBudgetOverride: nil
      )
    }
    let availablePlan = plan.filter { availableBackends.contains($0) }
    let recoveryPlan = availablePlan.filter { !$0.usesXCTestAccessibilityChannel }
    if !recoveryPlan.isEmpty {
      return EffectiveSnapshotCapturePlan(
        plan: recoveryPlan,
        xCTestChannelState: .deferredToIndependentBackend,
        treeCaptureSliceBudgetOverride: nil
      )
    }
    return EffectiveSnapshotCapturePlan(
      plan: availablePlan.filter(\.usesXCTestAccessibilityChannel),
      xCTestChannelState: .boundedXCTestProbe,
      treeCaptureSliceBudgetOverride: Self.penalizedXCTestProbeTreeSliceBudget
    )
  }

  func shouldSkipSnapshotBackendForAbandonedTreeCapture(_ kind: SnapshotBackendKind) -> Bool {
    kind.usesXCTestAccessibilityChannel && hasAbandonedTreeCapture()
  }

  // MARK: Plan runner

  func runSnapshotCapturePlan(
    _ plan: [SnapshotBackendKind],
    app: XCUIApplication,
    options: SnapshotOptions,
    terminal: SnapshotCaptureTerminalPolicy
  ) throws -> DataPayload {
    var best: (kind: SnapshotBackendKind, capture: SnapshotBackendCapture)?
    var firstFailure: (reason: String, code: String)?
    var axFailure: SnapshotCaptureFailure?
    let deadline = Date().addingTimeInterval(Self.snapshotPlanBudget)

    // Reorder is iOS-only because hostile screens can make XCTest tree/query work grind while
    // the app remains visually responsive. Simulators can avoid that channel through private AX;
    // physical devices have no independent semantic backend yet, so they use a bounded probe.
    var xCTestChannelPenalized = false
#if os(iOS)
    xCTestChannelPenalized = isSnapshotXCTestChannelPenalized(bundleId: currentBundleId)
#endif
    let effective = Self.effectiveSnapshotCapturePlan(
      plan,
      xCTestChannelPenalized: xCTestChannelPenalized,
      availableBackends: Set(SnapshotBackendKind.allCases.filter(\.isAvailableOnCurrentPlatform))
    )
    let effectivePlan = effective.plan
    switch effective.xCTestChannelState {
    case .normal:
      break
    case .deferredToIndependentBackend:
      firstFailure = (
        "XCTest-backed snapshot tiers were deferred after recent slow accessibility work on this screen",
        "budget"
      )
      NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_XCTEST_CHANNEL_DEFERRED bundle=%@", currentBundleId ?? "")
    case .boundedXCTestProbe:
      firstFailure = (
        "XCTest-backed snapshot tiers are running with a short recovery probe after recent slow accessibility work on this screen",
        "budget"
      )
      NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_XCTEST_CHANNEL_PROBE_BOUNDED bundle=%@", currentBundleId ?? "")
    }

    for kind in effectivePlan {
      if kind != effectivePlan.first && Date() >= deadline {
        NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_PLAN_BUDGET_EXHAUSTED skipped=%@", kind.rawValue)
        if firstFailure == nil {
          firstFailure = ("the capture plan ran out of its time budget", "budget")
        }
        break
      }
      // While an abandoned tree capture is still grinding inside testmanagerd, XCTest-backed
      // tiers would block behind it; only independent backends stay responsive (#1105).
      if shouldSkipSnapshotBackendForAbandonedTreeCapture(kind) {
        NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_TIER_SKIPPED_XCTEST_OCCUPIED tier=%@", kind.rawValue)
        if firstFailure == nil {
          firstFailure = (
            "the XCTest capture channel is occupied by an abandoned tree capture",
            "budget"
          )
        }
        continue
      }
      let capture: SnapshotBackendCapture
      let backendStartedAt = Date()
      do {
        guard
          let result = try captureWithBackend(
            kind,
            app: app,
            options: options,
            deadline: deadline,
            treeCaptureSliceBudgetOverride: effective.treeCaptureSliceBudgetOverride
          )
        else {
          recordSlowXCTestSnapshotBackendIfNeeded(kind, startedAt: backendStartedAt)
          continue
        }
        capture = result
        recordSlowXCTestSnapshotBackendIfNeeded(kind, startedAt: backendStartedAt)
      } catch let failure as SnapshotCaptureFailure {
        recordXCTestSnapshotBackendFailureIfNeeded(kind, failure: failure)
        recordSlowXCTestSnapshotBackendIfNeeded(kind, startedAt: backendStartedAt)
        if Self.isAxSnapshotFailure(failure) { axFailure = failure }
        if firstFailure == nil {
          firstFailure = (failure.message, Self.isAxSnapshotFailure(failure) ? "ax-rejected" : "capture-failed")
        }
        NSLog(
          "AGENT_DEVICE_RUNNER_SNAPSHOT_BACKEND_FAILED backend=%@ error=%@",
          kind.rawValue,
          failure.message
        )
        continue
      }

      if let sparseReason = Self.sparsePayloadReason(capture.payload) {
        if firstFailure == nil { firstFailure = sparseReason }
        if Self.payloadNodeCount(capture.payload) > Self.payloadNodeCount(best?.capture.payload) {
          best = (kind, capture)
        }
        continue
      }

      let recovered = kind != effectivePlan.first || effective.xCTestChannelState != .normal
      if recovered {
        NSLog(
          "AGENT_DEVICE_RUNNER_SNAPSHOT_RECOVERED backend=%@ reason=%@",
          kind.rawValue,
          firstFailure?.reason ?? "sparse tree"
        )
      }
      return stampedSnapshotPayload(
        capture,
        backend: kind,
        state: recovered ? "recovered" : "healthy",
        reason: recovered ? firstFailure : nil
      )
    }

    if let axFailure {
      switch Self.resolveSnapshotPlanTerminal(
        terminal: terminal,
        interactiveOnly: options.interactiveOnly
      ) {
      case .throwAxFailure:
        throw axFailure
      case .failClosed:
        // Fail closed on any interactive AX serialization failure that no backend recovered:
        // invalidate the cached target so the next command reacquires it (AX-unavailable target
        // invalidation, CONTEXT.md). A sparse `best` from a later tier (e.g. the query sweep's
        // synthetic root) must NOT suppress this — reaching the terminal already means no backend
        // produced a usable tree.
        return snapshotAccessibilityUnavailable(failure: axFailure)
      case .sparseBest:
        break
      }
    }

    let fallbackPayload =
      best.map { stampedSnapshotPayload($0.capture, backend: $0.kind, state: "sparse", reason: firstFailure) }
      ?? stampedSnapshotPayload(
        SnapshotBackendCapture(payload: sparseTruncatedSnapshotPayload(), effectiveDepth: nil),
        backend: effectivePlan.last ?? plan.last ?? .recursiveTree,
        state: "sparse",
        reason: firstFailure
      )
    return fallbackPayload
  }

  /// Marks XCTest-backed snapshot tiers as penalized when one attempt ground past the slow-capture
  /// threshold — even a successful one: the next capture of this screen must not re-grind.
  private func recordSlowXCTestSnapshotBackendIfNeeded(_ kind: SnapshotBackendKind, startedAt: Date) {
    guard kind.usesXCTestAccessibilityChannel else { return }
    let elapsed = Date().timeIntervalSince(startedAt)
    guard elapsed > snapshotXCTestSlowCaptureThreshold else { return }
    penalizeSnapshotXCTestChannel(
      bundleId: currentBundleId,
      reason: "slow_\(kind.rawValue)_capture_\(Int(elapsed * 1000))ms"
    )
  }

  private func recordXCTestSnapshotBackendFailureIfNeeded(
    _ kind: SnapshotBackendKind,
    failure: SnapshotCaptureFailure
  ) {
    guard kind.usesXCTestAccessibilityChannel, failure.code == Self.xCTestSnapshotTimeoutCode else { return }
    penalizeSnapshotXCTestChannel(
      bundleId: currentBundleId,
      reason: "\(kind.rawValue)_backend_timeout"
    )
  }

  private func captureWithBackend(
    _ kind: SnapshotBackendKind,
    app: XCUIApplication,
    options: SnapshotOptions,
    deadline: Date,
    treeCaptureSliceBudgetOverride: TimeInterval?
  ) throws -> SnapshotBackendCapture? {
    switch kind {
    case .recursiveTree:
      guard
        let context = try makeSnapshotTraversalContext(
          app: app,
          options: options,
          captureDeadline: deadline,
          treeCaptureSliceBudgetOverride: treeCaptureSliceBudgetOverride
        )
      else {
        return nil
      }
      let payload = try runMainThreadWork(
        command: nil,
        timeout: min(treeCaptureSliceBudget, max(0.5, deadline.timeIntervalSinceNow)),
        timeoutError: snapshotMainThreadTimeoutError("processing tree snapshot")
      ) {
        options.raw
          ? try self.rawTreeSnapshotPayload(context: context, options: options)
          : self.recursiveTreeSnapshotPayload(context: context, options: options)
      }
      return SnapshotBackendCapture(payload: payload, effectiveDepth: nil)
    case .querySweep:
      let payload = try runMainThreadWork(
        command: nil,
        timeout: min(Self.flatInteractiveFallbackBudget, max(0.1, deadline.timeIntervalSinceNow)),
        timeoutError: snapshotMainThreadTimeoutError("running query-sweep snapshot")
      ) {
        self.snapshotFlatInteractive(app: app, options: options, planDeadline: deadline)
      }
      return SnapshotBackendCapture(payload: payload, effectiveDepth: nil)
    case .privateAX:
      return privateAXSnapshotCapture(app: app, options: options, deadline: deadline)
    }
  }

  // MARK: Quality classifier (the single source of "is this snapshot degraded")

  /// Returns a degradation reason + machine code when the payload is too degraded to accept.
  static func sparsePayloadReason(_ payload: DataPayload) -> (reason: String, code: String)? {
    guard let nodes = payload.nodes, !nodes.isEmpty else {
      return ("snapshot returned no nodes", "no-nodes")
    }
    if isSparseApplicationWindowTree(nodes) {
      return ("snapshot returned only structural application/window nodes", "sparse-tree")
    }
    if payload.truncated == true && nodes.count <= sparseRecoveryTruncatedNodeThreshold {
      return ("snapshot was cut off by its budget with almost nothing collected", "budget")
    }
    return nil
  }

  /// Terminal action when a capture plan exhausted every backend with an AX serialization
  /// failure still pending. Pure so the fail-closed-vs-sparse policy is unit-testable without
  /// a live app (the ordering gap the architecture review flagged).
  enum SnapshotPlanTerminalAction: Equatable {
    case throwAxFailure
    case failClosed
    case sparseBest
  }

  static func resolveSnapshotPlanTerminal(
    terminal: SnapshotCaptureTerminalPolicy,
    interactiveOnly: Bool
  ) -> SnapshotPlanTerminalAction {
    switch terminal {
    case .throwOnAXFailure:
      return .throwAxFailure
    case .sparseWithFatalOnAXFailure:
      return interactiveOnly ? .failClosed : .sparseBest
    }
  }

  static func isSparseApplicationWindowTree(_ nodes: [SnapshotNode]) -> Bool {
    guard !nodes.isEmpty else { return false }
    return nodes.allSatisfy { node in
      // Application/Window labels are just the app/window name, and full-screen roots
      // compute as hittable; neither says anything about tree health.
      let isRootContainer = node.type == "Application" || node.type == "Window"
      let hasContent = (!isRootContainer && node.label?.isEmpty == false)
        || node.identifier?.isEmpty == false
        || node.value?.isEmpty == false
      return !hasContent
        && (isRootContainer || !node.hittable)
        && Self.structuralOnlyNodeTypes.contains(node.type)
    }
  }

  /// A leaf whose label joins many short segments is a container marked as an accessibility
  /// element: the platform folds every descendant into one merged node. Nothing below it can
  /// be addressed — by automation or by assistive tech. This is app-side; no backend recovers it.
  static func collapsedLeafIndexes(_ nodes: [SnapshotNode]) -> [Int]? {
    let parents = Set(nodes.compactMap { $0.parentIndex })
    let collapsed = nodes.filter { node in
      guard !parents.contains(node.index) else { return false }
      guard !(node.type.lowercased().contains("text")) else { return false }
      let label = node.label ?? ""
      return label.split(separator: ",").count > collapsedLeafMinimumSegments
    }
    return collapsed.isEmpty ? nil : collapsed.map(\.index)
  }

  // MARK: Outcome stamping

  private func stampedSnapshotPayload(
    _ capture: SnapshotBackendCapture,
    backend: SnapshotBackendKind,
    state: String,
    reason: (reason: String, code: String)?
  ) -> DataPayload {
    runnerAccessibilityHealth = reason?.code == "ax-rejected" ? .unavailable : .healthy
    let payload = capture.payload
    let quality = SnapshotQuality(
      state: state,
      backend: backend.rawValue,
      reason: reason?.reason,
      reasonCode: reason?.code,
      effectiveDepth: capture.effectiveDepth,
      collapsedLeafIndexes: Self.collapsedLeafIndexes(payload.nodes ?? [])
    )
    return DataPayload(
      // Legacy human text for older daemons that read message instead of snapshotQuality.
      message: Self.legacyQualityMessage(quality) ?? payload.message,
      nodes: payload.nodes,
      truncated: payload.truncated == true || state != "healthy" || capture.effectiveDepth != nil,
      snapshotQuality: quality,
      runnerFatal: payload.runnerFatal,
      runnerFatalReason: payload.runnerFatalReason
    )
  }

  static func legacyQualityMessage(_ quality: SnapshotQuality) -> String? {
    guard quality.state != "healthy" || quality.collapsedLeafIndexes != nil else { return nil }
    var parts: [String] = []
    if quality.state == "recovered" {
      let meaning = quality.reasonCode == "budget"
        ? " The primary capture ran out of its time budget (busy app or simulator); the recovered tree is authoritative for this screen."
        : " This usually means the app publishes an unhealthy accessibility tree — fixing the app's accessibility is the real cure. Treat screenshot as visual truth when this warning appears."
      parts.append(
        "Detected an overly complex or slow accessibility tree. Fell back to the \(quality.backend) snapshot backend"
          + (quality.reason.map { " after: \($0)." } ?? ".")
          + meaning
      )
    }
    if quality.state == "sparse" {
      parts.append(
        "No snapshot backend could read this screen"
          + (quality.reason.map { " (\($0))" } ?? "")
          + ". Use screenshot as visual truth and coordinate taps."
      )
    }
    if let depth = quality.effectiveDepth {
      parts.append(
        "The accessibility server rejected deeper requests; this tree is capped at depth \(depth) — re-run with --depth \(depth) --scope <container> for deeper content."
      )
    }
    return parts.isEmpty ? nil : parts.joined(separator: " ")
  }
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
// MARK: - In-bundle unit tests

extension RunnerTests {
  private func planTestNode(
    index: Int,
    type: String,
    label: String? = nil,
    identifier: String? = nil,
    hittable: Bool = false,
    parentIndex: Int? = nil
  ) -> SnapshotNode {
    SnapshotNode(
      index: index,
      type: type,
      label: label,
      identifier: identifier,
      value: nil,
      rect: snapshotRect(from: .zero),
      enabled: true,
      focused: nil,
      selected: nil,
      hittable: hittable,
      depth: parentIndex == nil ? 0 : 1,
      parentIndex: parentIndex,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }

  func testSparsePayloadReasonMatrix() {
    let root = planTestNode(index: 0, type: "Application", label: "Example App", hittable: true)
    let window = planTestNode(index: 1, type: "Window", parentIndex: 0)
    let button = planTestNode(index: 1, type: "Button", label: "Ok", hittable: true, parentIndex: 0)

    // Labeled, hittable root over a bare window is still sparse.
    XCTAssertNotNil(Self.sparsePayloadReason(DataPayload(nodes: [root, window], truncated: false)))
    // Deadline-truncated near-empty sweep needs recovery even with one real control.
    XCTAssertNotNil(Self.sparsePayloadReason(DataPayload(nodes: [root, button], truncated: true)))
    // The same tiny tree from a completed sweep is a legitimately minimal screen.
    XCTAssertNil(Self.sparsePayloadReason(DataPayload(nodes: [root, button], truncated: false)))
    // Empty payloads are degraded.
    XCTAssertNotNil(Self.sparsePayloadReason(DataPayload(nodes: [], truncated: false)))
  }

  func testCollapsedLeafIndexesFlagsMergedContainersOnly() {
    let root = planTestNode(index: 0, type: "Application", label: "App")
    let merged = planTestNode(
      index: 1,
      type: "Other",
      label: (0...30).map { "Row \($0), Tap" }.joined(separator: ", "),
      parentIndex: 0
    )
    let prose = planTestNode(
      index: 2,
      type: "StaticText",
      label: (0...30).map { "clause \($0)" }.joined(separator: ", "),
      parentIndex: 0
    )
    XCTAssertEqual(Self.collapsedLeafIndexes([root, merged, prose]), [1])
    XCTAssertNil(Self.collapsedLeafIndexes([root, prose]))
  }

  func testLegacyQualityMessageStatesFallbackMeaning() {
    let recovered = SnapshotQuality(
      state: "recovered",
      backend: "queries",
      reason: "snapshot returned only structural application/window nodes",
      reasonCode: "sparse-tree",
      effectiveDepth: nil,
      collapsedLeafIndexes: nil
    )
    let message = Self.legacyQualityMessage(recovered)
    XCTAssertTrue(message?.contains("queries snapshot backend") == true)
    XCTAssertTrue(message?.contains("fixing the app's accessibility") == true)
    XCTAssertTrue(message?.contains("screenshot as visual truth") == true)
    XCTAssertNil(
      Self.legacyQualityMessage(
        SnapshotQuality(
          state: "healthy", backend: "tree", reason: nil, reasonCode: nil, effectiveDepth: nil,
          collapsedLeafIndexes: nil)
      )
    )
  }
  func testTerminalFailsClosedOnInteractiveAxFailureRegardlessOfSparseBest() {
    // Interactive AX failure must invalidate + fail closed; a later tier's sparse synthetic-root
    // "best" must never downgrade this to a returned-sparse payload (regression: best == nil guard).
    XCTAssertEqual(
      Self.resolveSnapshotPlanTerminal(terminal: .sparseWithFatalOnAXFailure, interactiveOnly: true),
      .failClosed
    )
    XCTAssertEqual(
      Self.resolveSnapshotPlanTerminal(terminal: .sparseWithFatalOnAXFailure, interactiveOnly: false),
      .sparseBest
    )
    XCTAssertEqual(
      Self.resolveSnapshotPlanTerminal(terminal: .throwOnAXFailure, interactiveOnly: true),
      .throwAxFailure
    )
  }

  func testEffectiveSnapshotCapturePlanDefersXCTestBackedTiersOnlyWhenPenalizedRegularPlan() {
    let regular = Self.effectiveSnapshotCapturePlan(
      Self.regularVisiblePlan,
      xCTestChannelPenalized: true
    )
    XCTAssertEqual(regular.plan, [.privateAX])
    XCTAssertEqual(regular.xCTestChannelState, .deferredToIndependentBackend)
    XCTAssertNil(regular.treeCaptureSliceBudgetOverride)

    let unpenalized = Self.effectiveSnapshotCapturePlan(
      Self.regularVisiblePlan,
      xCTestChannelPenalized: false
    )
    XCTAssertEqual(unpenalized.plan, Self.regularVisiblePlan)
    XCTAssertEqual(unpenalized.xCTestChannelState, .normal)
    XCTAssertNil(unpenalized.treeCaptureSliceBudgetOverride)

    // The raw diagnostic plan preserves tree-first error propagation even under penalty.
    let raw = Self.effectiveSnapshotCapturePlan(
      Self.rawDiagnosticPlan,
      xCTestChannelPenalized: true
    )
    XCTAssertEqual(raw.plan, Self.rawDiagnosticPlan)
    XCTAssertEqual(raw.xCTestChannelState, .normal)
    XCTAssertNil(raw.treeCaptureSliceBudgetOverride)
  }

  func testEffectiveSnapshotCapturePlanUsesBoundedXCTestProbeWhenNoIndependentBackendRuns() {
    let physicalDevicePlan = Self.effectiveSnapshotCapturePlan(
      Self.regularVisiblePlan,
      xCTestChannelPenalized: true,
      availableBackends: [.recursiveTree, .querySweep]
    )

    XCTAssertEqual(physicalDevicePlan.plan, [.recursiveTree, .querySweep])
    XCTAssertEqual(physicalDevicePlan.xCTestChannelState, .boundedXCTestProbe)
    XCTAssertEqual(
      physicalDevicePlan.treeCaptureSliceBudgetOverride,
      Self.penalizedXCTestProbeTreeSliceBudget
    )
  }

  func testSnapshotXCTestChannelPenaltyMatchesBundleAndExpires() {
    defer {
      snapshotXCTestChannelPenaltyBundleId = nil
      snapshotXCTestChannelPenaltyUntil = .distantPast
    }

    penalizeSnapshotXCTestChannel(bundleId: "xyz.blueskyweb.app", reason: "test")
    XCTAssertTrue(isSnapshotXCTestChannelPenalized(bundleId: "xyz.blueskyweb.app"))
    XCTAssertFalse(isSnapshotXCTestChannelPenalized(bundleId: "com.other.app"))

    // A penalty recorded without a bundle applies to any current target.
    penalizeSnapshotXCTestChannel(bundleId: nil, reason: "test")
    XCTAssertTrue(isSnapshotXCTestChannelPenalized(bundleId: "com.other.app"))

    // Expired penalties stop applying.
    snapshotXCTestChannelPenaltyUntil = Date(timeIntervalSinceNow: -1)
    XCTAssertFalse(isSnapshotXCTestChannelPenalized(bundleId: "com.other.app"))
  }

  func testAbandonedTreeCaptureSkipsOnlyXCTestBackedSnapshotTiers() {
    abandonedTreeCaptureCount = 1
    defer { abandonedTreeCaptureCount = 0 }

    XCTAssertTrue(shouldSkipSnapshotBackendForAbandonedTreeCapture(.recursiveTree))
    XCTAssertTrue(shouldSkipSnapshotBackendForAbandonedTreeCapture(.querySweep))
    XCTAssertFalse(shouldSkipSnapshotBackendForAbandonedTreeCapture(.privateAX))
  }

  // Pins the record(_:) suppression class via its pure classifier. record(_:) itself is not
  // invoked here: feeding it the must-record variants would record real failures and fail
  // this very test run.
  func testSuppressedAxSnapshotIssueClassifier() {
    // AX-server rejections inside a matching-snapshot fetch are muted...
    XCTAssertTrue(
      Self.isSuppressedAxSnapshotIssueDescription(
        "Failed to get matching snapshot: Error kAXErrorIllegalArgument getting snapshot for element <AXUIElementRef 0x600000fd9a40> {pid=33837}"
      )
    )
    // ...including sibling AX server codes.
    XCTAssertTrue(
      Self.isSuppressedAxSnapshotIssueDescription(
        "Failed to get matching snapshot: Error kAXErrorCannotComplete getting snapshot for element"
      )
    )
    // The hung-query timeout variant must keep recording.
    XCTAssertFalse(
      Self.isSuppressedAxSnapshotIssueDescription(
        "Failed to get matching snapshot: Timed out while evaluating UI query."
      )
    )
    // Unrelated issues must keep recording.
    XCTAssertFalse(
      Self.isSuppressedAxSnapshotIssueDescription(
        "XCTAssertEqual failed: (\"1\") is not equal to (\"2\")"
      )
    )
    // A kAXError outside the matching-snapshot fetch context is not this class.
    XCTAssertFalse(
      Self.isSuppressedAxSnapshotIssueDescription(
        "Error kAXErrorIllegalArgument while performing scroll"
      )
    )
  }

  func testSnapshotAccessibilityUnavailableCarriesSparseVerdict() {
    currentApp = app
    currentBundleId = "com.example.app"
    defer {
      currentApp = nil
      currentBundleId = nil
    }
    let payload = snapshotAccessibilityUnavailable(
      failure: SnapshotCaptureFailure(
        code: "IOS_AX_SNAPSHOT_FAILED",
        message: "kAXErrorIllegalArgument",
        hint: "use screenshot"
      )
    )
    XCTAssertEqual(payload.runnerFatal, true)
    XCTAssertEqual(payload.snapshotQuality?.state, "sparse")
    XCTAssertEqual(payload.snapshotQuality?.reasonCode, "ax-rejected")
  }
}
#endif
