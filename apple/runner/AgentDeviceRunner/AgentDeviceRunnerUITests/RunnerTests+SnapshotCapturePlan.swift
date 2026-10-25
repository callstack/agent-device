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

/// Structured quality verdict from an iOS capture plan.
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

/// How one tier's bounded work ended. `deadlineExhausted` is a tier timeout: the tier stopped
/// starting work it could not finish inside its own slice, so what it returns is a partial result
/// it never completed collecting. The plan keeps that result only as the fallback and lets the next
/// backend answer; a node count cannot tell the two apart, because a short sweep still collects
/// more than the sparse threshold (#2781).
enum SnapshotTierOutcome: Equatable {
  case completed
  case deadlineExhausted
}

/// The plan one capture runs: ordered steps, the channel state the selection chose, and the pin —
/// if any — that narrowed it.
struct EffectiveSnapshotCapturePlan {
  let steps: [SnapshotCaptureStep]
  let xCTestChannelState: SnapshotXCTestChannelPlanState
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
  var qualityNotes: [SnapshotQualityNote] = []
  /// The keyboard band this capture measured, carried beside the tree it came with (#2660). Only the
  /// tree tier reads the keyboard, so only that tier has one; the daemon reads a missing band as "this
  /// producer could not measure", which is exactly what the query-sweep and private-AX tiers did.
  var keyboardBand: KeyboardBandFactPayload? = nil
  /// Whether this capture read a modal presentation over the app (#3565), classified on the
  /// acquisition this capture presents. A tier that classified nothing carries nothing, and the host
  /// reads that as no evidence rather than as absence.
  var presentedSurface: PresentedSurface? = nil
}

extension RunnerTests {
  /// Assembles what one tier answered, from the tree it presented and the acquisition it read. The
  /// presented-surface fact is classified on the acquisition rather than the presentation, because
  /// interactive filtering, depth and scope are all cuts into what the tier actually saw (#3565): a
  /// capture of a presented screen that kept four nodes still read the presentation.
  static func makeSnapshotBackendCapture(
    from result: AgentDeviceSnapshotPresentation.SnapshotPresentationResult,
    acquired acquisition: SnapshotAcquisition
  ) -> SnapshotBackendCapture {
    SnapshotBackendCapture(
      payload: DataPayload(nodes: result.nodes, truncated: result.truncated),
      effectiveDepth: result.effectiveDepth,
      customActions: result.customActions,
      qualityPayload: result.qualityNodes.map {
        DataPayload(nodes: $0, truncated: result.truncated)
      },
      qualityNotes: result.qualityNotes,
      presentedSurface: SnapshotPresentedSurface.classify(acquisition)
    )
  }

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
  /// Derived from the backend trait rather than hand-listed: a backend that cannot serve the raw
  /// projection drops out of the raw plan by construction, and a new one joins it by declaring the
  /// trait instead of by someone remembering this line.
  static let rawDiagnosticPlan: [SnapshotBackendKind] = regularVisiblePlan.filter(\.supportsRawProjection)

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
    var xCTestTierRan = false

    // Reorder is iOS-only: physical devices have no independent semantic backend, so a penalized
    // channel there uses the bounded probe instead of deferral.
    var xCTestChannelPenalized = false
    var breakerPenalized = false
    var xCTestRecoveryProbeDue = false
#if os(iOS)
    breakerPenalized = isSnapshotXCTestChannelPenalized(bundleId: target.bundleId)
    xCTestRecoveryProbeDue = isSnapshotXCTestRecoveryProbeDue(bundleId: target.bundleId)
    xCTestChannelPenalized = Self.snapshotXCTestChannelTreatedAsPenalized(
      penalized: breakerPenalized,
      preferredBackend: options.preferredBackend
    )
#endif
    let effective = Self.effectiveSnapshotCapturePlan(
      plan,
      xCTestChannelPenalized: xCTestChannelPenalized,
      xCTestRecoveryProbeDue: xCTestRecoveryProbeDue,
      availableBackends: Set(SnapshotBackendKind.allCases.filter(\.isAvailableOnCurrentPlatform)),
      preferredBackend: options.preferredBackend
    )
    // A request pin answers through its own slot, never the failure slot: a tier that failed on
    // this capture owns the verdict reason there, and planVerdictReason falls back to the pin only
    // when nothing failed. Only a customActions-implied pin is request-pinned; the daemon's
    // same-backend evidence probe pins for its own reasons and keeps its 'deferred' seed.
    let requestPinnedBackend = options.customActions && !breakerPenalized
    firstFailure = Self.xcTestChannelStateFirstFailure(
      effective.xCTestChannelState,
      requestPinnedBackend: requestPinnedBackend
    )
    let preSelectionReason = Self.snapshotPlanPreSelectionReason(
      effective.xCTestChannelState,
      requestPinnedBackend: requestPinnedBackend,
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

    for step in effective.steps {
      let kind = step.backend
      if kind != effective.steps.first?.backend && Date() >= deadline {
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
      // The claim is synchronous: a skipped step must leave the probe for the next plan.
      if step.claimsPeriodicRecoveryProbe {
        claimSnapshotXCTestRecoveryProbe(bundleId: target.bundleId)
      }
      if kind.usesXCTestAccessibilityChannel { xCTestTierRan = true }
      let attempt = try captureWithBackend(
        step,
        target: target,
        options: options,
        deadline: deadline
      )
      recordXCTestSnapshotBackendAttemptIfNeeded(
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

      let recovered = kind != effective.steps.first?.backend || effective.xCTestChannelState != .normal
      let verdictReason = Self.planVerdictReason(
        xCTestTierRan: kind.usesXCTestAccessibilityChannel,
        state: effective.xCTestChannelState,
        firstFailure: firstFailure,
        preSelection: preSelectionReason
      )
      if recovered {
        NSLog(
          "AGENT_DEVICE_RUNNER_SNAPSHOT_RECOVERED backend=%@ reason=%@",
          kind.rawValue,
          verdictReason?.reason ?? "sparse tree"
        )
      }
      return stampedSnapshotPayload(
        capture,
        backend: kind,
        state: recovered ? .recovered : .healthy,
        reason: recovered || verdictReason?.code == "requested-backend" ? verdictReason : nil
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

    let terminalReason = Self.planVerdictReason(
      xCTestTierRan: xCTestTierRan,
      state: effective.xCTestChannelState,
      firstFailure: firstFailure,
      preSelection: preSelectionReason
    )
    let fallbackPayload =
      best.map { stampedSnapshotPayload($0.capture, backend: $0.kind, state: .sparse, reason: terminalReason) }
      ?? stampedSnapshotPayload(
        SnapshotBackendCapture(payload: sparseTruncatedSnapshotPayload(), effectiveDepth: nil),
        backend: effective.steps.last?.backend ?? plan.last ?? .recursiveTree,
        state: .sparse,
        reason: terminalReason
      )
    return fallbackPayload
  }

  private func captureWithBackend(
    _ step: SnapshotCaptureStep,
    target: SnapshotCaptureTarget,
    options: PresentationOptions,
    deadline: Date
  ) throws -> SnapshotBackendAttempt {
    let kind = step.backend
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
              treeCaptureSliceBudgetOverride: step.treeCaptureSliceBudgetOverride
            )
          else {
            return (nil, .completed)
          }
          keyboardBand = context.keyboardBand
          let processingSlice = min(self.treeCaptureSliceBudget, max(0.5, deadline.timeIntervalSinceNow))
          let processingDeadline = Date().addingTimeInterval(processingSlice)
          let tree = try self.runMainThreadWork(
            "tree_processing",
            timeout: processingSlice,
            timeoutError: self.snapshotMainThreadTimeoutError("processing tree snapshot")
          ) {
            hint.isRaw
              ? (try self.rawTreeSnapshotAcquisition(context: context, hint: hint), .completed)
              : try self.recursiveTreeSnapshotAcquisition(
                context: context,
                hint: hint,
                processingDeadline: processingDeadline
              )
          }
          return (tree.acquisition, tree.outcome)
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
          #if AGENT_DEVICE_RUNNER_UNIT_TESTS
          if let override = self.privateAXAcquisitionOverrideForTesting {
            return (override(), .completed)
          }
          #endif
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
        step: step,
        outcome: .failed(failure, phase: .acquisition),
        timing: timer.timing
      )
    }
    guard let acquisition else {
      return SnapshotBackendAttempt(
        step: step,
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
        return Self.makeSnapshotBackendCapture(from: result, acquired: normalizedAcquisition)
      }
    } catch let failure as SnapshotPresentationFailure {
      return SnapshotBackendAttempt(
        step: step,
        outcome: .failed(Self.snapshotCaptureFailure(for: failure), phase: .presentation),
        timing: timer.timing,
        tierOutcome: tierOutcome
      )
    } catch let failure as SnapshotCaptureFailure {
      return SnapshotBackendAttempt(
        step: step,
        outcome: .failed(failure, phase: .presentation),
        timing: timer.timing,
        tierOutcome: tierOutcome
      )
    }

    var capture = presented
    capture.timing = timer.timing
    capture.keyboardBand = keyboardBand?.payload
    return SnapshotBackendAttempt(
      step: step,
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
      snapshotQualityNotes: capture.qualityNotes.isEmpty ? nil : capture.qualityNotes,
      presentedSurface: capture.presentedSurface,
      keyboard: capture.keyboardBand,
      runnerFatal: payload.runnerFatal,
      runnerFatalReason: payload.runnerFatalReason
    )
  }
}
