import XCTest
import AgentDeviceSnapshotPresentation

// MARK: - Snapshot capture plans (ADR 0004)
//
// Each snapshot strategy declares an ordered chain of capture backends. One runner walks the
// chain: capture, classify, accept the first payload the quality classifier calls usable, and
// stamp the outcome with a structured quality verdict so the daemon renders state instead of
// re-deriving it from node shapes. Recovery ordering is data here, never a per-call-site branch.

/// The closed set of verdict states the host accepts. The wire strings are the shared table at
/// `contracts/fixtures/ios-snapshot-quality-states.json`, which `allCases` is pinned to; `reasonCode`
/// stays open because an unknown one costs only its wording, never the verdict.
enum SnapshotQualityState: String, Codable, CaseIterable {
  /// First backend produced a usable tree.
  case healthy
  /// A later backend did.
  case recovered
  /// No backend produced a usable tree; the best attempt is returned as-is.
  case sparse
}

/// Structured quality verdict shipped with every iOS snapshot payload.
struct SnapshotQuality: Codable {
  let state: SnapshotQualityState
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

/// How one tier's bounded work ended. `deadlineExhausted` is a tier timeout: the tier stopped
/// starting work it could not finish inside its own slice, so what it returns is a partial result
/// it never completed collecting. The plan keeps that result only as the fallback and lets the next
/// backend answer; a node count cannot tell the two apart, because a short sweep still collects
/// more than the sparse threshold (#2781).
enum SnapshotTierOutcome: Equatable {
  case completed
  case deadlineExhausted
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
  /// The keyboard band this capture measured, carried beside the tree it came with (#2660). Only the
  /// tree tier reads the keyboard, so only that tier has one; the daemon reads a missing band as "this
  /// producer could not measure", which is exactly what the query-sweep and private-AX tiers did.
  var keyboardBand: KeyboardBandFactPayload? = nil
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

  func shouldSkipSnapshotBackendForAbandonedMainThreadWork(_ kind: SnapshotBackendKind) -> Bool {
    kind.usesXCTestAccessibilityChannel && hasAbandonedMainThreadWork()
  }

  // MARK: Plan runner

  func runSnapshotCapturePlan(
    _ plan: [SnapshotBackendKind],
    target: SnapshotCaptureTarget,
    options: PresentationOptions,
    terminal: SnapshotCaptureTerminalPolicy,
    deadline: Date? = nil
  ) throws -> DataPayload {
    var best: (kind: SnapshotBackendKind, capture: SnapshotBackendCapture)?
    var firstFailure: (reason: String, code: String)?
    var axFailure: SnapshotCaptureFailure?
    // A caller may share the pre-plan system-modal probe's deadline; otherwise own the full budget (#1244).
    let deadline = deadline ?? Date().addingTimeInterval(Self.snapshotPlanBudget)
    let suppressXCTestPenalty = snapshotXCTestPenaltyWarmupExemption.consume()

    // Reorder is iOS-only because hostile screens can make XCTest tree/query work grind while
    // the app remains visually responsive. Simulators can avoid that channel through private AX;
    // physical devices have no independent semantic backend yet, so they use a bounded probe.
    // A daemon-preferred private-AX capture (same-backend evidence probe) takes the exact
    // penalized route: privateAX-first plan, 'deferred' verdict — the backend was pre-selected
    // deliberately, so no degradation warning should render for it.
    var xCTestChannelPenalized = false
    var xCTestChannelPenalizedByBreaker = false
#if os(iOS)
    xCTestChannelPenalizedByBreaker = isSnapshotXCTestChannelPenalized(bundleId: target.bundleId)
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
      NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_XCTEST_CHANNEL_DEFERRED bundle=%@", target.bundleId ?? "")
    case .boundedXCTestProbe:
      NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_XCTEST_CHANNEL_PROBE_BOUNDED bundle=%@", target.bundleId ?? "")
    }

    for kind in effectivePlan {
      if kind != effectivePlan.first && Date() >= deadline {
        NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_PLAN_BUDGET_EXHAUSTED skipped=%@", kind.rawValue)
        if firstFailure == nil {
          firstFailure = ("the capture plan ran out of its time budget", "budget")
        }
        break
      }
      // While abandoned main-thread work is still grinding inside testmanagerd, XCTest-backed
      // tiers would queue behind it; only independent backends stay responsive (#1105).
      if shouldSkipSnapshotBackendForAbandonedMainThreadWork(kind) {
        NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_TIER_SKIPPED_XCTEST_OCCUPIED tier=%@", kind.rawValue)
        if firstFailure == nil {
          firstFailure = (
            "the XCTest capture channel is occupied by abandoned main-thread work",
            "budget"
          )
        }
        continue
      }
      let attempt = try captureWithBackend(
        kind,
        target: target,
        options: options,
        deadline: deadline,
        treeCaptureSliceBudgetOverride: effective.treeCaptureSliceBudgetOverride
      )
      recordXCTestSnapshotBackendAttemptIfNeeded(
        kind,
        attempt: attempt,
        bundleId: target.bundleId,
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

      if attempt.tierOutcome == .deadlineExhausted {
        NSLog(
          "AGENT_DEVICE_RUNNER_SNAPSHOT_TIER_DEADLINE_EXHAUSTED backend=%@ nodes=%d",
          kind.rawValue,
          Self.payloadNodeCount(capture.payload)
        )
      }
      if let rejection = Self.snapshotTierRejectionReason(
        outcome: attempt.tierOutcome,
        kind: kind,
        payload: capture.qualityPayload ?? capture.payload
      ) {
        if firstFailure == nil { firstFailure = rejection }
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
        state: recovered ? .recovered : .healthy,
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
      best.map { stampedSnapshotPayload($0.capture, backend: $0.kind, state: .sparse, reason: firstFailure) }
      ?? stampedSnapshotPayload(
        SnapshotBackendCapture(payload: sparseTruncatedSnapshotPayload(), effectiveDepth: nil),
        backend: effectivePlan.last ?? plan.last ?? .recursiveTree,
        state: .sparse,
        reason: firstFailure
      )
    return fallbackPayload
  }

  private func captureWithBackend(
    _ kind: SnapshotBackendKind,
    target: SnapshotCaptureTarget,
    options: PresentationOptions,
    deadline: Date,
    treeCaptureSliceBudgetOverride: TimeInterval?
  ) throws -> SnapshotBackendAttempt {
    let app = target.app
    let hint = SnapshotPresentation.captureHint(for: options)
    var timer = SnapshotPhaseTimer()
    let acquisition: SnapshotAcquisition?
    let tierOutcome: SnapshotTierOutcome
    // The band is read inside the tree tier's own bounded work, so it has to be lifted out of the
    // acquisition phase and carried to the stamping step, where the payload is assembled (#2660).
    var keyboardBand: RunnerKeyboardBandFact?
    do {
      let measured = try timer.measure(.acquisition) { () -> (SnapshotAcquisition?, SnapshotTierOutcome) in
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
            return (nil, .completed)
          }
          keyboardBand = context.keyboardBand
          let tree = try self.runMainThreadWork(
            "tree_processing",
            timeout: min(self.treeCaptureSliceBudget, max(0.5, deadline.timeIntervalSinceNow)),
            timeoutError: self.snapshotMainThreadTimeoutError("processing tree snapshot")
          ) {
            hint.isRaw
              ? try self.rawTreeSnapshotAcquisition(context: context, hint: hint)
              : try self.recursiveTreeSnapshotAcquisition(context: context, hint: hint)
          }
          return (tree, .completed)
        case .querySweep:
          let sliceDeadline = Self.querySweepSliceDeadline(startedAt: Date(), planDeadline: deadline)
          let sweep = try self.runMainThreadWork(
            "query_sweep",
            timeout: max(0.1, sliceDeadline.timeIntervalSinceNow),
            timeoutError: self.snapshotMainThreadTimeoutError("running query-sweep snapshot")
          ) {
            self.querySweepSnapshotAcquisition(
              app: app,
              hint: hint,
              sliceDeadline: sliceDeadline
            )
          }
          return (sweep.acquisition, sweep.outcome)
        case .privateAX:
          return (
            self.privateAXSnapshotAcquisition(
              target: target,
              hint: hint,
              deadline: deadline
            ),
            .completed
          )
        }
      }
      acquisition = measured.0
      tierOutcome = measured.1
    } catch let failure as SnapshotCaptureFailure {
      return SnapshotBackendAttempt(
        outcome: .failed(failure, phase: .acquisition),
        timing: timer.timing
      )
    }
    guard let acquisition else {
      return SnapshotBackendAttempt(
        outcome: .noCapture,
        timing: timer.timing,
        tierOutcome: tierOutcome
      )
    }

    // The one coordinate-space pass (#2661): reported frames become the app's orientation space
    // before presentation reads them. A backend with unknown orientation (the windowless sweep)
    // turns nothing.
    let normalizedAcquisition = acquisition.replacingNodes(
      SnapshotGeometrySpace.normalized(
        nodes: acquisition.nodes,
        viewport: acquisition.viewport
      )
    )

    let presented: SnapshotBackendCapture
    do {
      presented = try timer.measure(.presentation) {
        guard let result = try SnapshotPresentation.present(normalizedAcquisition, options: options) else {
          NSLog(
            "AGENT_DEVICE_RUNNER_SNAPSHOT_PROJECTION_MISMATCH requested=%@ acquired=%@",
            hint.projection.rawValue,
            normalizedAcquisition.hint.projection.rawValue
          )
          throw Self.snapshotProjectionMismatchFailure(
            kind,
            requested: hint.projection,
            acquired: normalizedAcquisition.hint.projection
          )
        }
        return Self.makeSnapshotBackendCapture(from: result)
      }
    } catch let failure as SnapshotPresentationFailure {
      return SnapshotBackendAttempt(
        outcome: .failed(Self.snapshotCaptureFailure(for: failure), phase: .presentation),
        timing: timer.timing,
        tierOutcome: tierOutcome
      )
    } catch let failure as SnapshotCaptureFailure {
      return SnapshotBackendAttempt(
        outcome: .failed(failure, phase: .presentation),
        timing: timer.timing,
        tierOutcome: tierOutcome
      )
    }

    var capture = presented
    capture.timing = timer.timing
    capture.keyboardBand = keyboardBand?.payload
    return SnapshotBackendAttempt(
      outcome: .captured(capture),
      timing: timer.timing,
      tierOutcome: tierOutcome
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

  /// Why a captured tier may not end the plan, or nil when it may. A tier that stopped starting work
  /// at its own deadline is rejected as a timeout whatever it collected: keeping its payload as the
  /// fallback is right, accepting it is not, and a node count cannot tell a finished capture from a
  /// sweep the slice cut short (#2781).
  static func snapshotTierRejectionReason(
    outcome: SnapshotTierOutcome,
    kind: SnapshotBackendKind,
    payload: DataPayload
  ) -> (reason: String, code: String)? {
    if outcome == .deadlineExhausted {
      return (
        "the \(kind.rawValue) backend spent its capture slice with the collection unfinished",
        "budget"
      )
    }
    return sparsePayloadReason(payload)
  }

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

      let isFullScreenContainer = node.hittable != true && rootRects.contains { rootRect in
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

  func stampedSnapshotPayload(
    _ capture: SnapshotBackendCapture,
    backend: SnapshotBackendKind,
    state: SnapshotQualityState,
    reason: (reason: String, code: String)?
  ) -> DataPayload {
    let health: RunnerAccessibilityHealth = reason?.code == "ax-rejected" ? .unavailable : .healthy
    applyMainOwnedSnapshotState("accessibility_health") {
      self.mainOwned.accessibilityHealth = health
    }
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
      message: payload.message,
      nodes: payload.nodes,
      // Completeness, never provenance: a whole tree that a later backend produced (state
      // "recovered") stays untruncated, so strict absence reads can trust it. Only a real cap
      // (payload truncation, a depth-limited private AX capture) or a sparse terminal payload
      // is truncated.
      truncated: payload.truncated == true || state == .sparse || capture.effectiveDepth != nil,
      qualityPayload: capture.qualityPayload.flatMap { quality in
        guard let nodes = quality.nodes else { return nil }
        return SnapshotQualityPayload(nodes: nodes, truncated: quality.truncated == true)
      },
      snapshotQuality: quality,
      keyboard: capture.keyboardBand,
      runnerFatal: payload.runnerFatal,
      runnerFatalReason: payload.runnerFatalReason
    )
  }
}
