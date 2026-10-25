import Foundation

// MARK: - XCTest accessibility channel policy (ADR 0004, #1105/#1156/#3896)
//
// One owner for what a capture must know about the XCTest channel's health: the penalty value,
// the plan-reorder rule, and the execution mode each plan step carries. The old interface accepted
// a defaulted `.normal` channel state at evidence time, which is how #3896's self-renewal bug was
// reachable.

/// What the plan runner does with one backend on this capture. The penalty recorder reads this,
/// never a re-derived plan position, to decide which evidence an attempt may produce.
enum SnapshotCaptureExecutionMode: Equatable {
  /// A regular attempt: its acquisition facts may arm or renew the channel penalty.
  case ordinary
  /// A bounded attempt inside a penalized plan: it may never arm or renew the penalty.
  case boundedRecovery(claimsPeriodicProbe: Bool)
}

/// One executed step of an effective plan: the backend together with its execution mode, built
/// once by the plan factory. The tree tier's bounded slice and the probe claim derive from the
/// mode, so no caller threads a plan-wide budget override or a positional rule beside the plan it
/// already carries. The penalty recorder reads the mode: only an ordinary attempt may produce
/// arming evidence.
struct SnapshotCaptureStep {
  /// The whole-slice budget a bounded tree attempt gets while the channel is penalized.
  static let boundedTreeSliceBudget: TimeInterval = 1

  let backend: SnapshotBackendKind
  let execution: SnapshotCaptureExecutionMode

  static func ordinary(_ backend: SnapshotBackendKind) -> SnapshotCaptureStep {
    SnapshotCaptureStep(backend: backend, execution: .ordinary)
  }

  static func boundedRecovery(
    _ backend: SnapshotBackendKind,
    claimsPeriodicProbe: Bool = false
  ) -> SnapshotCaptureStep {
    SnapshotCaptureStep(backend: backend, execution: .boundedRecovery(claimsPeriodicProbe: claimsPeriodicProbe))
  }

  /// The tree tier's bounded slice, from this step's own mode. The query sweep's slice has its own
  /// owner (`querySweepSliceDeadline`), which the penalty does not shorten.
  var treeCaptureSliceBudgetOverride: TimeInterval? {
    guard backend == .recursiveTree, execution != .ordinary else { return nil }
    return Self.boundedTreeSliceBudget
  }

  /// Only the leading step of the deferred plan that is running the due probe claims it.
  var claimsPeriodicRecoveryProbe: Bool {
    if case let .boundedRecovery(claims) = execution { return claims }
    return false
  }
}

enum SnapshotXCTestChannelPlanState: Equatable {
  case normal
  case deferredToIndependentBackend
  case boundedXCTestProbe
}

/// The XCTest accessibility channel penalty (#1105/#1156). While it is active, regular plans for its
/// bundle defer XCTest tiers. Each recovery interval, one deferred plan runs the bounded tree probe
/// first, inside that capture, so a screen that is light again can clear the penalty before it
/// expires (#3844). It is the only expiry/due-time owner: no schedule, queue, or cache runs beside it.
struct SnapshotXCTestChannelPenalty: Equatable {
  static let duration: TimeInterval = 120
  static let recoveryProbeInterval: TimeInterval = 30

  private(set) var bundleId: String?
  private(set) var until = Date.distantPast
  private(set) var probeDueAt = Date.distantFuture

  /// A penalty armed without a bundle id applies to whatever target is current.
  func isActive(for bundleId: String?, at now: Date) -> Bool {
    guard now < until else { return false }
    guard let penalized = self.bundleId else { return true }
    return penalized == bundleId
  }

  func isProbeDue(for bundleId: String?, at now: Date) -> Bool {
    isActive(for: bundleId, at: now) && now >= probeDueAt
  }

  mutating func arm(bundleId: String?, at now: Date) {
    self.bundleId = bundleId
    until = now.addingTimeInterval(Self.duration)
    probeDueAt = now.addingTimeInterval(Self.recoveryProbeInterval)
  }

  /// A started probe moves the next one a full interval out, whatever the probe finds.
  mutating func claimProbe(at now: Date) {
    probeDueAt = now.addingTimeInterval(Self.recoveryProbeInterval)
  }

  mutating func clear() {
    self = SnapshotXCTestChannelPenalty()
  }
}

extension RunnerTests {
  func penalizeSnapshotXCTestChannel(bundleId: String?, reason: String) {
    snapshotXCTestChannelPenaltyLock.lock()
    snapshotXCTestChannelPenalty.arm(bundleId: bundleId, at: Date())
    snapshotXCTestChannelPenaltyLock.unlock()
    NSLog(
      "AGENT_DEVICE_RUNNER_SNAPSHOT_XCTEST_CHANNEL_PENALIZED bundle=%@ reason=%@",
      bundleId ?? "",
      reason
    )
  }

  func clearSnapshotXCTestChannelPenalty(reason: String) {
    snapshotXCTestChannelPenaltyLock.lock()
    let hadActivePenalty = Date() < snapshotXCTestChannelPenalty.until
    snapshotXCTestChannelPenalty.clear()
    snapshotXCTestChannelPenaltyLock.unlock()
    if hadActivePenalty {
      NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_XCTEST_CHANNEL_PENALTY_CLEARED reason=%@", reason)
    }
  }

  func isSnapshotXCTestChannelPenalized(bundleId: String?) -> Bool {
    snapshotXCTestChannelPenaltyLock.lock()
    defer { snapshotXCTestChannelPenaltyLock.unlock() }
    return snapshotXCTestChannelPenalty.isActive(for: bundleId, at: Date())
  }

  func isSnapshotXCTestRecoveryProbeDue(bundleId: String?) -> Bool {
    snapshotXCTestChannelPenaltyLock.lock()
    defer { snapshotXCTestChannelPenaltyLock.unlock() }
    return snapshotXCTestChannelPenalty.isProbeDue(for: bundleId, at: Date())
  }

  func claimSnapshotXCTestRecoveryProbe(bundleId: String?) {
    snapshotXCTestChannelPenaltyLock.lock()
    snapshotXCTestChannelPenalty.claimProbe(at: Date())
    snapshotXCTestChannelPenaltyLock.unlock()
    NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_XCTEST_RECOVERY_PROBE bundle=%@", bundleId ?? "")
  }

  /// The pre-seeded first-failure a penalized plan stamps into its verdict. The deferred case
  /// uses the dedicated 'deferred' code: the breaker pre-selected the backend, nothing new
  /// degraded on this capture, and the daemon keys warning suppression and the settle budget
  /// reset off exactly that distinction. The bounded probe keeps 'budget': its short XCTest
  /// slice genuinely constrains what this capture could read.
  ///
  /// `requestPinnedBackend` separates the two ways the plan can arrive at the same
  /// deferred shape. A capture that ASKED for a private-AX-only reading (custom
  /// actions) degraded nothing, so it seeds no failure at all — reporting slow
  /// accessibility work would name a cause that does not exist. Its answer comes from
  /// `snapshotPlanPreSelectionReason`.
  static func xcTestChannelStateFirstFailure(
    _ state: SnapshotXCTestChannelPlanState,
    requestPinnedBackend: Bool = false
  ) -> (reason: String, code: String)? {
    switch state {
    case .normal:
      return nil
    case .deferredToIndependentBackend:
      if requestPinnedBackend {
        return nil
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

  /// The 'requested-backend' answer for a plan the request itself pinned: the recursive tree the
  /// caller asked for, or the private AX the custom-actions reading requires. A pin names a plan
  /// decision, not a failure, so it never enters the failure slot; `planVerdictReason` reports it
  /// only while no tier failed on this capture.
  static func snapshotPlanPreSelectionReason(
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
    if state == .deferredToIndependentBackend && requestPinnedBackend {
      return (
        "the private AX backend was selected because this capture asked for accessibility custom actions",
        "requested-backend"
      )
    }
    return nil
  }

  /// The reason a capture's verdict carries: the first tier failure when one exists, otherwise the
  /// pre-selection the plan started with. Once an XCTest-backed tier ran behind a deferred plan,
  /// it ran on the bounded probe's short slice, so the capture reports that constraint ('budget')
  /// whether the tier recovered it or the plan ended sparse, rather than the pre-selection
  /// ('deferred') the plan was seeded with.
  static func planVerdictReason(
    xCTestTierRan: Bool,
    state: SnapshotXCTestChannelPlanState,
    firstFailure: (reason: String, code: String)?,
    preSelection: (reason: String, code: String)?
  ) -> (reason: String, code: String)? {
    guard xCTestTierRan, state == .deferredToIndependentBackend else { return firstFailure ?? preSelection }
    return xcTestChannelStateFirstFailure(.boundedXCTestProbe)
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
  /// otherwise it keeps XCTest work on a short probe. A due recovery probe puts that short tree
  /// ahead of the independent backend, and only that leading tree step claims the probe. The raw
  /// diagnostic plan keeps tree-first errors, and unknown plans are left untouched. Each step
  /// carries the execution mode this rule chose; nothing downstream re-derives it from position.
  static func effectiveSnapshotCapturePlan(
    _ plan: [SnapshotBackendKind],
    xCTestChannelPenalized: Bool,
    xCTestRecoveryProbeDue: Bool = false,
    availableBackends: Set<SnapshotBackendKind> = Set(SnapshotBackendKind.allCases),
    preferredBackend: String? = nil
  ) -> EffectiveSnapshotCapturePlan {
    if
      plan == Self.regularVisiblePlan,
      let preferred = preferredBackend.flatMap(SnapshotBackendKind.init(rawValue:)),
      preferred.isForceable,
      availableBackends.contains(preferred)
    {
      let state: SnapshotXCTestChannelPlanState = preferred == .privateAX ? .deferredToIndependentBackend : .normal
      return EffectiveSnapshotCapturePlan(
        steps: Self.snapshotCaptureSteps(for: [preferred], state: state, probeLeads: false),
        xCTestChannelState: state,
        preferredBackend: preferred
      )
    }
    guard xCTestChannelPenalized, plan == Self.regularVisiblePlan else {
      return EffectiveSnapshotCapturePlan(
        steps: Self.snapshotCaptureSteps(for: plan, state: .normal, probeLeads: false),
        xCTestChannelState: .normal,
        preferredBackend: nil
      )
    }
    let availablePlan = plan.filter { availableBackends.contains($0) }
    let recoveryPlan = availablePlan.filter { !$0.usesXCTestAccessibilityChannel }
    if !recoveryPlan.isEmpty {
      // The independent backend reads only the app it can match as the active AX application, so
      // an out-of-process surface over the app (the Save Password sheet) leaves it empty for the
      // whole penalty. The tree, on the bounded probe's short slice, stays behind it, or leads when
      // the recovery probe is due; the query sweep does not, since its grind is what the penalty
      // keeps off the main thread.
      let boundedTree = availablePlan.filter { $0 == .recursiveTree }
      let probeLeads = xCTestRecoveryProbeDue && !boundedTree.isEmpty
      return EffectiveSnapshotCapturePlan(
        steps: Self.snapshotCaptureSteps(
          for: probeLeads ? boundedTree + recoveryPlan : recoveryPlan + boundedTree,
          state: .deferredToIndependentBackend,
          probeLeads: probeLeads
        ),
        xCTestChannelState: .deferredToIndependentBackend,
        preferredBackend: nil
      )
    }
    return EffectiveSnapshotCapturePlan(
      steps: Self.snapshotCaptureSteps(
        for: availablePlan.filter(\.usesXCTestAccessibilityChannel),
        state: .boundedXCTestProbe,
        probeLeads: false
      ),
      xCTestChannelState: .boundedXCTestProbe,
      preferredBackend: nil
    )
  }

  /// Factory: one step per planned backend, each carrying the execution mode the penalized state
  /// chose. A normal plan runs ordinary attempts; any penalized state runs every tier as bounded
  /// recovery, so no attempt from it can arm or renew the penalty it is recovering from. Only the
  /// leading XCTest step of the deferred plan that is running the due probe claims the probe.
  static func snapshotCaptureSteps(
    for plan: [SnapshotBackendKind],
    state: SnapshotXCTestChannelPlanState,
    probeLeads: Bool
  ) -> [SnapshotCaptureStep] {
    plan.enumerated().map { offset, kind in
      guard state != .normal else { return .ordinary(kind) }
      let claims = probeLeads && offset == 0 && kind.usesXCTestAccessibilityChannel
      return .boundedRecovery(kind, claimsPeriodicProbe: claims)
    }
  }

  /// Why an ordinary XCTest attempt shows a hostile channel, or nil. A bounded recovery attempt
  /// has no arming branch here at all: forgetting that would let a probe renew its own penalty,
  /// which is exactly the self-renewal #3896 removed at the recorder.
  ///
  /// The breaker observes acquisition facts only. Presentation is a separate phase and cannot arm
  /// the breaker, even when it is slower than the acquisition that produced the tree.
  static func snapshotXCTestPenaltyReason(
    for attempt: SnapshotBackendAttempt,
    slowThresholdMs: Double
  ) -> String? {
    guard case .ordinary = attempt.step.execution else { return nil }
    let kind = attempt.step.backend
    guard kind.usesXCTestAccessibilityChannel else { return nil }
    if case let .failed(failure, phase: .acquisition) = attempt.outcome,
      failure.code == Self.xCTestSnapshotTimeoutCode
    {
      return "\(kind.rawValue)_backend_timeout"
    }
    if attempt.tierOutcome == .deadlineExhausted {
      return "\(kind.rawValue)_backend_timeout"
    }
    guard attempt.timing.acquisitionMs > slowThresholdMs else { return nil }
    return "slow_\(kind.rawValue)_capture_\(Int(attempt.timing.acquisitionMs))ms"
  }

  /// Only an accepted, fast tree from a bounded recovery attempt proves that the channel recovered
  /// and clears the penalty early. An ordinary tree capture never clears it; it can only arm it.
  static func snapshotBoundedRecoveryRestoredChannel(_ attempt: SnapshotBackendAttempt) -> Bool {
    guard case .boundedRecovery = attempt.step.execution,
      attempt.step.backend == .recursiveTree,
      attempt.timing.acquisitionMs <= SnapshotCaptureStep.boundedTreeSliceBudget * 1_000,
      case let .captured(capture) = attempt.outcome
    else { return false }
    return Self.snapshotTierRejectionReason(
      outcome: attempt.tierOutcome,
      kind: attempt.step.backend,
      payload: capture.qualityPayload ?? capture.payload
    ) == nil
  }
}
