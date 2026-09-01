import XCTest
import AgentDeviceSnapshotPresentation

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
  /// Why recovery ran (first failure), why the payload is degraded, or why an internal backend
  /// selection was honored.
  let reason: String?
  /// Machine-readable reason: ax-rejected | sparse-tree | budget | no-nodes | capture-failed |
  /// presentation-failed | deferred | requested-backend.
  let reasonCode: String?
  /// Private AX ladder cap when the accepted tree is shallower than requested.
  let effectiveDepth: Int?
  /// Leaves that merge many labels — a container marked accessible hides its descendants.
  let collapsedLeafIndexes: [Int]?
  /// Coverage of the bounded custom-action pass, when the capture asked for one.
  let customActions: SnapshotCustomActionCoverage?
  /// Response-level timing for the accepted backend attempt, never repeated per node.
  var timing: SnapshotCaptureTiming? = nil
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
  /// Non-nil only when the plan was narrowed by an explicit internal backend preference. This
  /// keeps the quality marker tied to the plan decision rather than to an untrusted request field.
  let preferredBackend: SnapshotBackendKind?
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
  let effectiveDepth: Int?
  var customActions: SnapshotCustomActionCoverage? = nil
  var qualityPayload: DataPayload? = nil
  var timing: SnapshotCaptureTiming? = nil
}

extension RunnerTests {
  static func makeSnapshotBackendCapture(
    from result: AgentDeviceSnapshotPresentation.SnapshotPresentationResult
  ) -> SnapshotBackendCapture {
    SnapshotBackendCapture(
      payload: DataPayload(nodes: result.nodes, truncated: result.truncated),
      effectiveDepth: result.effectiveDepth,
      customActions: result.customActions,
      qualityPayload: result.qualityNodes.map {
        DataPayload(nodes: $0, truncated: result.truncated)
      }
    )
  }

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
  /// Derived from the backend trait rather than hand-listed: a backend that cannot serve the raw
  /// projection drops out of the raw plan by construction, and a new one joins it by declaring the
  /// trait instead of by someone remembering this line.
  static let rawDiagnosticPlan: [SnapshotBackendKind] = regularVisiblePlan.filter(\.supportsRawProjection)

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

  func clearSnapshotXCTestChannelPenalty(reason: String) {
    snapshotXCTestChannelPenaltyLock.lock()
    let hadActivePenalty = Date() < snapshotXCTestChannelPenaltyUntil
    snapshotXCTestChannelPenaltyBundleId = nil
    snapshotXCTestChannelPenaltyUntil = Date.distantPast
    snapshotXCTestChannelPenaltyLock.unlock()
    if hadActivePenalty {
      NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_XCTEST_CHANNEL_PENALTY_CLEARED reason=%@", reason)
    }
  }

  func isSnapshotXCTestChannelPenalized(bundleId: String?) -> Bool {
    snapshotXCTestChannelPenaltyLock.lock()
    defer { snapshotXCTestChannelPenaltyLock.unlock() }
    guard Date() < snapshotXCTestChannelPenaltyUntil else { return false }
    // A penalty recorded without a bundle id applies to whatever target is current.
    guard let penalized = snapshotXCTestChannelPenaltyBundleId else { return true }
    return penalized == bundleId
  }

  func consumeSnapshotXCTestPenaltyWarmupExemption() -> Bool {
    let pending = snapshotXCTestPenaltyWarmupExemptionPending
    snapshotXCTestPenaltyWarmupExemptionPending = false
    return pending
  }

  /// The pre-seeded first-failure a penalized plan stamps into its verdict. The deferred case
  /// uses the dedicated 'deferred' code: the breaker pre-selected the backend, nothing new
  /// degraded on this capture, and the daemon keys warning suppression and the settle budget
  /// reset off exactly that distinction. The bounded probe keeps 'budget': its short XCTest
  /// slice genuinely constrains what this capture could read.
  ///
  /// `requestPinnedBackend` separates the two ways the plan can arrive at the same
  /// deferred shape. A capture that ASKED for a private-AX-only reading (custom
  /// actions) degraded nothing, so reporting slow accessibility work would name a
  /// cause that does not exist.
  static func xcTestChannelStateFirstFailure(
    _ state: SnapshotXCTestChannelPlanState,
    requestPinnedBackend: Bool = false,
    preferredBackend: String? = nil
  ) -> (reason: String, code: String)? {
    if state == .normal && preferredBackend == SnapshotBackendKind.recursiveTree.rawValue {
      return (
        "the recursive XCTest tree backend was explicitly selected for this capture",
        "requested-backend"
      )
    }
    switch state {
    case .normal:
      return nil
    case .deferredToIndependentBackend:
      if requestPinnedBackend {
        return (
          "the private AX backend was selected because this capture asked for accessibility custom actions",
          "requested-backend"
        )
      }
      return (
        "XCTest-backed snapshot tiers were deferred after recent slow accessibility work on this screen",
        "deferred"
      )
    case .boundedXCTestProbe:
      return (
        "XCTest-backed snapshot tiers are running with a short recovery probe after recent slow accessibility work on this screen",
        "budget"
      )
    }
  }

  /// Pure gate: a capture is planned as penalized when the channel penalty is
  /// active OR the daemon pinned the private-AX backend (same-backend evidence
  /// probe) — both mean "do not enter XCTest tree work first, and stamp the
  /// pre-selection as 'deferred' rather than a degradation".
  static func snapshotXCTestChannelTreatedAsPenalized(
    penalized: Bool,
    preferredBackend: String?
  ) -> Bool {
    penalized || preferredBackend == SnapshotBackendKind.privateAX.rawValue
  }

  /// Pure plan-reorder rule: an internal preferred backend pins the regular plan to that backend;
  /// this is the only force seam used by same-backend evidence and conformance captures. A
  /// penalized XCTest accessibility channel uses independent backends when the platform has one,
  /// otherwise it keeps XCTest work on a short probe. The raw diagnostic plan keeps tree-first
  /// errors, and unknown plans are left untouched.
  static func effectiveSnapshotCapturePlan(
    _ plan: [SnapshotBackendKind],
    xCTestChannelPenalized: Bool,
    availableBackends: Set<SnapshotBackendKind> = Set(SnapshotBackendKind.allCases),
    preferredBackend: String? = nil
  ) -> EffectiveSnapshotCapturePlan {
    if
      plan == Self.regularVisiblePlan,
      let preferred = preferredBackend.flatMap(SnapshotBackendKind.init(rawValue:)),
      preferred.isForceable,
      availableBackends.contains(preferred)
    {
      return EffectiveSnapshotCapturePlan(
        plan: [preferred],
        xCTestChannelState: preferred == .privateAX ? .deferredToIndependentBackend : .normal,
        treeCaptureSliceBudgetOverride: nil,
        preferredBackend: preferred
      )
    }
    guard xCTestChannelPenalized, plan == Self.regularVisiblePlan else {
      return EffectiveSnapshotCapturePlan(
        plan: plan,
        xCTestChannelState: .normal,
        treeCaptureSliceBudgetOverride: nil,
        preferredBackend: nil
      )
    }
    let availablePlan = plan.filter { availableBackends.contains($0) }
    let recoveryPlan = availablePlan.filter { !$0.usesXCTestAccessibilityChannel }
    if !recoveryPlan.isEmpty {
      return EffectiveSnapshotCapturePlan(
        plan: recoveryPlan,
        xCTestChannelState: .deferredToIndependentBackend,
        treeCaptureSliceBudgetOverride: nil,
        preferredBackend: nil
      )
    }
    return EffectiveSnapshotCapturePlan(
      plan: availablePlan.filter(\.usesXCTestAccessibilityChannel),
      xCTestChannelState: .boundedXCTestProbe,
      treeCaptureSliceBudgetOverride: Self.penalizedXCTestProbeTreeSliceBudget,
      preferredBackend: nil
    )
  }

  func shouldSkipSnapshotBackendForAbandonedTreeCapture(_ kind: SnapshotBackendKind) -> Bool {
    kind.usesXCTestAccessibilityChannel && hasAbandonedTreeCapture()
  }

  // MARK: Plan runner

  func runSnapshotCapturePlan(
    _ plan: [SnapshotBackendKind],
    app: XCUIApplication,
    options: PresentationOptions,
    terminal: SnapshotCaptureTerminalPolicy,
    deadline: Date? = nil
  ) throws -> DataPayload {
    var best: (kind: SnapshotBackendKind, capture: SnapshotBackendCapture)?
    var firstFailure: (reason: String, code: String)?
    var axFailure: SnapshotCaptureFailure?
    // A caller may share the pre-plan system-modal probe's deadline; otherwise own the full budget (#1244).
    let deadline = deadline ?? Date().addingTimeInterval(Self.snapshotPlanBudget)
    let suppressXCTestPenalty = consumeSnapshotXCTestPenaltyWarmupExemption()

    // Reorder is iOS-only because hostile screens can make XCTest tree/query work grind while
    // the app remains visually responsive. Simulators can avoid that channel through private AX;
    // physical devices have no independent semantic backend yet, so they use a bounded probe.
    // A daemon-preferred private-AX capture (same-backend evidence probe) takes the exact
    // penalized route: privateAX-first plan, 'deferred' verdict — the backend was pre-selected
    // deliberately, so no degradation warning should render for it.
    var xCTestChannelPenalized = false
    var xCTestChannelPenalizedByBreaker = false
#if os(iOS)
    xCTestChannelPenalizedByBreaker = isSnapshotXCTestChannelPenalized(bundleId: currentBundleId)
    xCTestChannelPenalized = Self.snapshotXCTestChannelTreatedAsPenalized(
      penalized: xCTestChannelPenalizedByBreaker,
      preferredBackend: options.preferredBackend
    )
#endif
    let effective = Self.effectiveSnapshotCapturePlan(
      plan,
      xCTestChannelPenalized: xCTestChannelPenalized,
      availableBackends: Set(SnapshotBackendKind.allCases.filter(\.isAvailableOnCurrentPlatform)),
      preferredBackend: options.preferredBackend
    )
    let effectivePlan = effective.plan
    // Only a customActions-implied pin is request-pinned; the daemon's
    // same-backend evidence probe pins for its own reasons and keeps 'deferred'.
    firstFailure = Self.xcTestChannelStateFirstFailure(
      effective.xCTestChannelState,
      requestPinnedBackend: options.customActions && !xCTestChannelPenalizedByBreaker,
      preferredBackend: effective.preferredBackend?.rawValue
    )
    switch effective.xCTestChannelState {
    case .normal:
      break
    case .deferredToIndependentBackend:
      NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_XCTEST_CHANNEL_DEFERRED bundle=%@", currentBundleId ?? "")
    case .boundedXCTestProbe:
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
      let attempt = try captureWithBackend(
        kind,
        app: app,
        options: options,
        deadline: deadline,
        treeCaptureSliceBudgetOverride: effective.treeCaptureSliceBudgetOverride
      )
      recordXCTestSnapshotBackendAttemptIfNeeded(
        kind,
        attempt: attempt,
        penaltySuppressed: suppressXCTestPenalty
      )
      if case let .failed(failure, phase: _) = attempt.outcome {
        if Self.isAxSnapshotFailure(failure) { axFailure = failure }
        if firstFailure == nil {
          firstFailure = (failure.message, Self.snapshotQualityReasonCode(for: failure))
        }
        NSLog(
          "AGENT_DEVICE_RUNNER_SNAPSHOT_BACKEND_FAILED backend=%@ error=%@",
          kind.rawValue,
          failure.message
        )
        continue
      }
      guard case let .captured(capture) = attempt.outcome else { continue }

      if let sparseReason = Self.sparsePayloadReason(capture.qualityPayload ?? capture.payload) {
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
        reason: recovered || firstFailure?.code == "requested-backend" ? firstFailure : nil
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

  private func captureWithBackend(
    _ kind: SnapshotBackendKind,
    app: XCUIApplication,
    options: PresentationOptions,
    deadline: Date,
    treeCaptureSliceBudgetOverride: TimeInterval?
  ) throws -> SnapshotBackendAttempt {
    let hint = SnapshotPresentation.captureHint(for: options)
    var timer = SnapshotPhaseTimer()
    // Scoped depth is relative to a presentation-selected root, so its hint stays broad and the
    // backend capability gate applies only to an unscoped regular frontier.
    let requestedRegularDepth = options.raw || SnapshotScopePolicy.isActive(options.scope)
      ? nil
      : options.depth
    guard kind.canServeRegularPresentedDepth(requestedRegularDepth) else {
      NSLog(
        "AGENT_DEVICE_RUNNER_SNAPSHOT_BACKEND_DEPTH_UNSUPPORTED backend=%@ depth=%ld",
        kind.rawValue,
        requestedRegularDepth ?? -1
      )
      return SnapshotBackendAttempt(
        outcome: .noCapture,
        timing: timer.timing
      )
    }
    let acquisition: SnapshotAcquisition?
    do {
      acquisition = try timer.measure(.acquisition) {
        switch kind {
        case .recursiveTree:
          guard
            let context = try self.makeSnapshotTraversalContext(
              app: app,
              hint: hint,
              captureDeadline: deadline,
              treeCaptureSliceBudgetOverride: treeCaptureSliceBudgetOverride
            )
          else {
            return nil
          }
          return try self.runMainThreadWork(
            timeout: min(self.treeCaptureSliceBudget, max(0.5, deadline.timeIntervalSinceNow)),
            timeoutError: self.snapshotMainThreadTimeoutError("processing tree snapshot")
          ) {
            hint.isRaw
              ? try self.rawTreeSnapshotAcquisition(context: context, hint: hint)
              : self.recursiveTreeSnapshotAcquisition(context: context, hint: hint)
          }
        case .querySweep:
          return try self.runMainThreadWork(
            timeout: min(Self.flatInteractiveFallbackBudget, max(0.1, deadline.timeIntervalSinceNow)),
            timeoutError: self.snapshotMainThreadTimeoutError("running query-sweep snapshot")
          ) {
            self.querySweepSnapshotAcquisition(
              app: app,
              hint: hint,
              planDeadline: deadline
            )
          }
        case .privateAX:
          return self.privateAXSnapshotAcquisition(
            app: app,
            hint: hint,
            deadline: deadline
          )
        }
      }
    } catch let failure as SnapshotCaptureFailure {
      return SnapshotBackendAttempt(
        outcome: .failed(failure, phase: .acquisition),
        timing: timer.timing
      )
    }
    guard let acquisition else {
      return SnapshotBackendAttempt(
        outcome: .noCapture,
        timing: timer.timing
      )
    }

    let presented: SnapshotBackendCapture
    do {
      presented = try timer.measure(.presentation) {
        guard let result = try SnapshotPresentation.present(acquisition, options: options) else {
          throw Self.snapshotProjectionMismatchFailure(
            kind,
            requested: hint.projection,
            acquired: acquisition.hint.projection
          )
        }
        return Self.makeSnapshotBackendCapture(from: result)
      }
    } catch let failure as SnapshotPresentationFailure {
      return SnapshotBackendAttempt(
        outcome: .failed(Self.snapshotCaptureFailure(for: failure), phase: .presentation),
        timing: timer.timing
      )
    } catch let failure as SnapshotCaptureFailure {
      return SnapshotBackendAttempt(
        outcome: .failed(failure, phase: .presentation),
        timing: timer.timing
      )
    }

    var capture = presented
    capture.timing = timer.timing
    return SnapshotBackendAttempt(
      outcome: .captured(capture),
      timing: timer.timing
    )
  }

  /// A backend that answers a request with the other projection loses its tier and says why, so
  /// the miss lands in the quality verdict instead of shipping as a correct-looking capture.
  static func snapshotProjectionMismatchFailure(
    _ kind: SnapshotBackendKind,
    requested: CaptureHint.Projection,
    acquired: CaptureHint.Projection
  ) -> SnapshotCaptureFailure {
    SnapshotCaptureFailure(
      code: "IOS_SNAPSHOT_PROJECTION_MISMATCH",
      message:
        "the \(kind.rawValue) backend returned a \(acquired.rawValue) capture for a \(requested.rawValue) snapshot request",
      hint: "This is a runner bug: report it with the failing command and the app under test."
    )
  }

  // MARK: Quality classifier (the single source of "is this snapshot degraded")

  /// Returns a degradation reason + machine code when the payload is too degraded to accept.
  static func sparsePayloadReason(_ payload: DataPayload) -> (reason: String, code: String)? {
    guard let nodes = payload.nodes, !nodes.isEmpty else {
      return ("snapshot returned no nodes", "no-nodes")
    }
    if isSparseApplicationWindowTree(nodes) {
      return ("snapshot returned no semantic controls or content", "sparse-tree")
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

  static func isSparseApplicationWindowTree(_ nodes: [PresentedNode]) -> Bool {
    guard !nodes.isEmpty else { return false }
    let rootRects = nodes.compactMap { node in
      node.type == "Application" || node.type == "Window" ? node.rect : nil
    }
    return nodes.allSatisfy { node in
      // Application/Window labels are just the app/window name, and full-screen roots
      // compute as hittable; neither says anything about tree health.
      let isRootContainer = node.type == "Application" || node.type == "Window"
      guard Self.structuralOnlyNodeTypes.contains(node.type) else { return false }
      guard !isRootContainer else { return true }

      let isFullScreenContainer = !node.hittable && rootRects.contains { rootRect in
        rootRect.x == node.rect.x && rootRect.y == node.rect.y
          && rootRect.width == node.rect.width && rootRect.height == node.rect.height
      }
      let hasAddressableIdentifier = node.identifier?.isEmpty == false && !isFullScreenContainer
      return !Self.isSemanticSnapshotText(node.label)
        && !Self.isSemanticSnapshotText(node.value)
        && !hasAddressableIdentifier
    }
  }

  /// Private AX can stringify an unserializable accessibility label as the JavaScript object
  /// placeholder. It is transport residue, not UI content, and must not make a shell-only tree
  /// look healthy.
  static func isSemanticSnapshotText(_ text: String?) -> Bool {
    guard let text else { return false }
    let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return !normalized.isEmpty && normalized.lowercased() != "[object object]"
  }

  /// A leaf whose label joins many short segments is a container marked as an accessibility
  /// element: the platform folds every descendant into one merged node. Nothing below it can
  /// be addressed — by automation or by assistive tech. This is app-side; no backend recovers it.
  static func collapsedLeafIndexes(_ nodes: [PresentedNode]) -> [Int]? {
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
      collapsedLeafIndexes: Self.collapsedLeafIndexes(payload.nodes ?? []),
      customActions: capture.customActions,
      timing: capture.timing
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

  /// Response level, one line per incompleteness. An unread merged element is
  /// byte-identical to one with no actions, and a clipped list looks complete,
  /// so both have to name themselves.
  static func customActionCoverageWarnings(_ coverage: SnapshotCustomActionCoverage) -> [String] {
    var lines: [String] = []
    if coverage.blocked {
      // Scrolling is the remedy for a budget stop, not for this one — saying it
      // here would send the reader off doing something that cannot help.
      lines.append(
        "Custom actions were not read: an earlier accessibility read is still hung, so this "
          + "capture skipped the read pass instead of queueing behind it. No element's actions "
          + "list is authoritative here. Reads resume once that call returns.")
    } else if coverage.read < coverage.candidates {
      lines.append(
        "Custom actions were read for \(coverage.read) of \(coverage.candidates) merged elements, "
          + "on-screen ones first; the remaining \(coverage.candidates - coverage.read) were not read, "
          + "so an absent actions list on those is not evidence that they have none. "
          + "Scroll them into view and re-run to read them.")
    }
    if coverage.truncated > 0 {
      lines.append(
        "\(coverage.truncated) element(s) published more custom actions than are shown; those "
          + "lists are clipped to the first 8 names, and long names are shortened.")
    }
    return lines
  }

  static func legacyQualityMessage(_ quality: SnapshotQuality) -> String? {
    let customActionWarnings =
      quality.customActions.map { Self.customActionCoverageWarnings($0) } ?? []
    guard quality.state != "healthy" || quality.collapsedLeafIndexes != nil
      || !customActionWarnings.isEmpty
    else { return nil }
    var parts: [String] = []
    if quality.state == "recovered" {
      let meaning: String
      switch quality.reasonCode {
      case "budget", "deferred":
        meaning = " The primary capture ran out of its time budget (busy app or simulator); the recovered tree is authoritative for this screen."
      case "presentation-failed":
        meaning = " The runner rejected a regular presentation because its cumulative clip invariant failed; report this as a runner bug and treat screenshot as visual truth."
      default:
        meaning = " This usually means the app publishes an unhealthy accessibility tree — fixing the app's accessibility is the real cure. Treat screenshot as visual truth when this warning appears."
      }
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
    parts.append(contentsOf: customActionWarnings)
    if let depth = quality.effectiveDepth {
      // No --depth remedy here: an explicit --depth capture disables the
      // frontier extension, so following it would return strictly less than
      // this capture did. A plain re-run retries with a fresh extension budget.
      parts.append(
        "The accessibility server rejected deeper requests; content below depth \(depth) may be missing — re-run snapshot to retry deeper content."
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
  ) -> PresentedNode {
    SnapshotPresentation.singleElementRead(
      RawAXNode(
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
    )
  }

  func testSparsePayloadReasonMatrix() {
    let root = planTestNode(index: 0, type: "Application", label: "Example App", hittable: true)
    let window = planTestNode(index: 1, type: "Window", parentIndex: 0)
    let button = planTestNode(index: 1, type: "Button", label: "Ok", hittable: true, parentIndex: 0)
    let shell = planTestNode(
      index: 1,
      type: "Other",
      identifier: "appShell",
      parentIndex: 0
    )
    let serializationPlaceholder = planTestNode(
      index: 2,
      type: "Other",
      label: "[object Object]",
      parentIndex: 1
    )

    // Labeled, hittable root over a bare window is still sparse.
    XCTAssertNotNil(Self.sparsePayloadReason(DataPayload(nodes: [root, window], truncated: false)))
    // Deadline-truncated near-empty sweep needs recovery even with one real control.
    XCTAssertNotNil(Self.sparsePayloadReason(DataPayload(nodes: [root, button], truncated: true)))
    // The same tiny tree from a completed sweep is a legitimately minimal screen.
    XCTAssertNil(Self.sparsePayloadReason(DataPayload(nodes: [root, button], truncated: false)))
    // Container metadata plus a stringified serialization placeholder is not readable UI.
    XCTAssertNotNil(
      Self.sparsePayloadReason(
        DataPayload(nodes: [root, shell, serializationPlaceholder], truncated: false)
      )
    )
    let actionableShell = planTestNode(
      index: 1,
      type: "Other",
      identifier: "checkout",
      hittable: true,
      parentIndex: 0
    )
    XCTAssertNil(
      Self.sparsePayloadReason(DataPayload(nodes: [root, actionableShell], truncated: false))
    )
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
      collapsedLeafIndexes: nil,
      customActions: nil
    )
    let message = Self.legacyQualityMessage(recovered)
    XCTAssertTrue(message?.contains("queries snapshot backend") == true)
    XCTAssertTrue(message?.contains("fixing the app's accessibility") == true)
    XCTAssertTrue(message?.contains("screenshot as visual truth") == true)
    XCTAssertNil(
      Self.legacyQualityMessage(
        SnapshotQuality(
          state: "healthy", backend: "tree", reason: nil, reasonCode: nil, effectiveDepth: nil,
          collapsedLeafIndexes: nil, customActions: nil)
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

  func testXCTestChannelStateFirstFailureStampsDeferredCodeOnlyForDeferral() {
    XCTAssertNil(Self.xcTestChannelStateFirstFailure(.normal))
    XCTAssertEqual(Self.xcTestChannelStateFirstFailure(.deferredToIndependentBackend)?.code, "deferred")
    XCTAssertEqual(Self.xcTestChannelStateFirstFailure(.boundedXCTestProbe)?.code, "budget")
  }

  func testSnapshotQualityCarriesPhaseTimingAtResponseLevel() {
    let timing = SnapshotCaptureTiming(acquisitionMs: 12, presentationMs: 34)
    let capture = SnapshotBackendCapture(
      payload: DataPayload(
        nodes: [planTestNode(index: 0, type: "Application", label: "App")],
        truncated: false
      ),
      effectiveDepth: nil,
      timing: timing
    )

    let payload = stampedSnapshotPayload(
      capture,
      backend: .recursiveTree,
      state: "healthy",
      reason: nil
    )

    XCTAssertEqual(payload.snapshotQuality?.timing, timing)
    XCTAssertEqual(payload.nodes?.count, 1)
  }

  func testDirectPresentationDoesNotClaimPlanTiming() {
    let options = PresentationOptions(
      interactiveOnly: false,
      depth: nil,
      scope: nil,
      raw: true
    )
    let result = SnapshotPresentation.presentRaw(
      SnapshotAcquisition(
        hint: SnapshotPresentation.captureHint(for: options),
        nodes: [],
        truncated: false,
        effectiveDepth: nil,
        viewport: .infinite
      ),
      options: options
    )
    let capture = Self.makeSnapshotBackendCapture(from: result)

    let payload = stampedSnapshotPayload(
      capture,
      backend: .recursiveTree,
      state: "healthy",
      reason: nil
    )

    XCTAssertNil(payload.snapshotQuality?.timing)
  }

  /// The raw plan is derived from what each backend can actually serve, not from a second
  /// hand-maintained list. Non-vacuity: flipping `querySweep.supportsRawProjection` to true adds it
  /// to the plan and fails the first two assertions — which is exactly the shape of #1797 D4, a
  /// `--raw` request answered by a backend that has no hierarchy to return.
  func testRawDiagnosticPlanCarriesOnlyBackendsThatCanServeRaw() {
    XCTAssertEqual(Self.rawDiagnosticPlan, [.recursiveTree, .privateAX])
    XCTAssertEqual(
      SnapshotBackendKind.allCases.filter { !$0.supportsRawProjection }, [.querySweep])
    XCTAssertTrue(Self.rawDiagnosticPlan.allSatisfy(\.supportsRawProjection))
    // Tree-first error propagation is the raw plan's other contract (ADR 0004).
    XCTAssertEqual(Self.rawDiagnosticPlan.first, .recursiveTree)
  }

  /// A projection mismatch is a runner bug, not an accessibility failure: it must not take the
  /// AX-failure terminal route (rethrow / fail-closed), just drop its tier with a named reason.
  func testProjectionMismatchFailureIsStructuredAndNotAnAxFailure() {
    let failure = Self.snapshotProjectionMismatchFailure(
      .querySweep, requested: .raw, acquired: .regular)
    XCTAssertEqual(failure.code, "IOS_SNAPSHOT_PROJECTION_MISMATCH")
    XCTAssertTrue(failure.message.contains("queries"))
    XCTAssertTrue(failure.message.contains("raw"))
    XCTAssertFalse(Self.isAxSnapshotFailure(failure))
  }

  /// #1634 P2: the decoded wire field must reach capture options and its
  /// applicable plan. A pinned REGULAR capture defers to privateAX-first; the
  /// RAW diagnostic plan is never rerouted by the pin — raw keeps tree-first
  /// error propagation, which is exactly why raw baselines are excluded from
  /// corroboration daemon-side.
  func testDecodedPreferredBackendReachesOptionsAndApplicablePlan() throws {
    let json = #"{"command":"snapshot","preferredBackend":"private-ax"}"#
    let command = try JSONDecoder().decode(Command.self, from: Data(json.utf8))
    let options = Self.presentationOptions(from: command)
    XCTAssertEqual(options.preferredBackend, "private-ax")
    XCTAssertFalse(options.raw)

    let treated = Self.snapshotXCTestChannelTreatedAsPenalized(
      penalized: false, preferredBackend: options.preferredBackend)
    let pinned = Self.effectiveSnapshotCapturePlan(
      Self.regularVisiblePlan,
      xCTestChannelPenalized: treated,
      preferredBackend: options.preferredBackend
    )
    XCTAssertEqual(pinned.plan, [.privateAX])
    XCTAssertEqual(pinned.xCTestChannelState, .deferredToIndependentBackend)

    let raw = Self.effectiveSnapshotCapturePlan(
      Self.rawDiagnosticPlan,
      xCTestChannelPenalized: treated,
      preferredBackend: options.preferredBackend
    )
    XCTAssertEqual(raw.plan, Self.rawDiagnosticPlan)

    // A command without the field decodes to no pin and a normal plan.
    let bare = try JSONDecoder().decode(
      Command.self, from: Data(#"{"command":"snapshot"}"#.utf8))
    XCTAssertNil(Self.presentationOptions(from: bare).preferredBackend)
  }

  /// #1635: the force seam must select the recursive tree even when the XCTest
  /// channel is currently penalized. Without the preferred-backend argument,
  /// this call returns the independent private-AX recovery plan instead.
  func testPreferredTreeBackendPinsRegularPlanAndLeavesStructuredEvidence() {
    let forced = Self.effectiveSnapshotCapturePlan(
      Self.regularVisiblePlan,
      xCTestChannelPenalized: true,
      preferredBackend: SnapshotBackendKind.recursiveTree.rawValue
    )
    XCTAssertEqual(forced.plan, [.recursiveTree])
    XCTAssertEqual(forced.xCTestChannelState, .normal)
    XCTAssertEqual(
      Self.xcTestChannelStateFirstFailure(
        forced.xCTestChannelState,
        preferredBackend: forced.preferredBackend?.rawValue
      )?.code,
      "requested-backend"
    )
  }

  /// Same-backend evidence probes: a daemon-pinned private-AX capture takes the
  /// penalized route even with a healthy channel, so tap-outcome corroboration
  /// baselines and probes are always captured by the same backend (backends are
  /// never comparable views of a screen). Composed with the plan rule, the pin
  /// yields the privateAX-first deferred plan.
  func testPreferredPrivateAXBackendPlansAsPenalized() {
    XCTAssertTrue(
      Self.snapshotXCTestChannelTreatedAsPenalized(penalized: false, preferredBackend: "private-ax"))
    XCTAssertTrue(
      Self.snapshotXCTestChannelTreatedAsPenalized(penalized: true, preferredBackend: nil))
    XCTAssertFalse(
      Self.snapshotXCTestChannelTreatedAsPenalized(penalized: false, preferredBackend: nil))
    XCTAssertFalse(
      Self.snapshotXCTestChannelTreatedAsPenalized(penalized: false, preferredBackend: "tree"))

    let pinned = Self.effectiveSnapshotCapturePlan(
      Self.regularVisiblePlan,
      xCTestChannelPenalized: Self.snapshotXCTestChannelTreatedAsPenalized(
        penalized: false, preferredBackend: "private-ax"
      ),
      preferredBackend: "private-ax"
    )
    XCTAssertEqual(pinned.plan, [.privateAX])
    XCTAssertEqual(pinned.xCTestChannelState, .deferredToIndependentBackend)
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
}
#endif
