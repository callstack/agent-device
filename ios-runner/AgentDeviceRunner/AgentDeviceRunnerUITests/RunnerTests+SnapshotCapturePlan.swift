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
  static let collapsedLeafMinimumSegments = 10

  static func payloadNodeCount(_ payload: DataPayload?) -> Int {
    payload?.nodes?.count ?? 0
  }

  // MARK: Plan definitions

  static let regularVisiblePlan: [SnapshotBackendKind] = [.recursiveTree, .querySweep, .privateAX]
  static let rawDiagnosticPlan: [SnapshotBackendKind] = [.recursiveTree, .privateAX]

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

    for kind in plan {
      if kind != plan.first && Date() >= deadline {
        NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_PLAN_BUDGET_EXHAUSTED skipped=%@", kind.rawValue)
        if firstFailure == nil {
          firstFailure = ("the capture plan ran out of its time budget", "budget")
        }
        break
      }
      let capture: SnapshotBackendCapture
      do {
        guard let result = try captureWithBackend(kind, app: app, options: options) else {
          continue
        }
        capture = result
      } catch let failure as SnapshotCaptureFailure {
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

      let recovered = kind != plan.first
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
        backend: plan.last ?? .recursiveTree,
        state: "sparse",
        reason: firstFailure
      )
    return fallbackPayload
  }

  private func captureWithBackend(
    _ kind: SnapshotBackendKind,
    app: XCUIApplication,
    options: SnapshotOptions
  ) throws -> SnapshotBackendCapture? {
    switch kind {
    case .recursiveTree:
      guard let context = try makeSnapshotTraversalContext(app: app, options: options) else {
        return nil
      }
      let payload = options.raw
        ? try rawTreeSnapshotPayload(context: context, options: options)
        : recursiveTreeSnapshotPayload(context: context, options: options)
      return SnapshotBackendCapture(payload: payload, effectiveDepth: nil)
    case .querySweep:
      return SnapshotBackendCapture(
        payload: snapshotFlatInteractive(app: app, options: options),
        effectiveDepth: nil
      )
    case .privateAX:
      return privateAXSnapshotCapture(app: app, options: options)
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
        "Recovered this snapshot with the \(quality.backend) accessibility backend"
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
    XCTAssertTrue(message?.contains("queries accessibility backend") == true)
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
