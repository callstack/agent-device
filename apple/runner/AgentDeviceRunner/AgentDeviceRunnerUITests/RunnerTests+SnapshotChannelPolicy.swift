import Foundation

// MARK: - XCTest accessibility channel policy (ADR 0004, #1105/#1156/#3896)

/// One executed step of an effective plan. The mode decides which evidence the attempt may produce
/// and travels with it, so evidence cannot reach the recorder detached from its authority (#3896).
enum SnapshotCaptureStep {
  /// A regular attempt: its acquisition facts may arm or renew the channel penalty.
  case ordinary(SnapshotBackendKind)
  /// A bounded attempt inside a penalized plan: it may never arm or renew the penalty.
  case boundedRecovery(SnapshotBackendKind, claimsPeriodicProbe: Bool)

  /// The slice budget a bounded tree attempt gets while the channel is penalized. The query
  /// sweep's slice has its own owner (`querySweepSliceDeadline`), which the penalty does not
  /// shorten.
  static let boundedTreeSliceBudget: TimeInterval = 1

  var backend: SnapshotBackendKind {
    switch self {
    case let .ordinary(kind): return kind
    case let .boundedRecovery(kind, _): return kind
    }
  }

  var treeCaptureSliceBudgetOverride: TimeInterval? {
    guard backend == .recursiveTree, case .boundedRecovery = self else { return nil }
    return Self.boundedTreeSliceBudget
  }

  var claimsPeriodicRecoveryProbe: Bool {
    if case let .boundedRecovery(_, claims) = self { return claims }
    return false
  }
}

enum SnapshotXCTestChannelPlanState: Equatable {
  case normal
  case deferredToIndependentBackend
  case boundedXCTestProbe
}

/// The channel penalty (#1105/#1156): re-grinding a slow XCTest capture on every plan buries the
/// main thread past the watchdog, so while it is active regular plans defer XCTest tiers, and each
/// recovery interval one deferred plan runs the bounded tree probe first, inside that capture, so a
/// light screen clears the penalty early (#3844). It is the only expiry/due-time owner.
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

  /// Deferred uses the 'deferred' code, not a failure code: the daemon keys warning suppression
  /// and the settle-budget reset off that distinction. The bounded probe keeps 'budget'.
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

  /// A pin names a plan decision, not a failure, so it reports through this slot and never
  /// through the failure slot (`planVerdictReason`).
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

  /// Once an XCTest tier ran behind a deferred plan, it ran on the probe's short slice, so the
  /// capture reports 'budget' rather than the 'deferred' pre-selection it was seeded with.
  static func planVerdictReason(
    xCTestTierRan: Bool,
    state: SnapshotXCTestChannelPlanState,
    firstFailure: (reason: String, code: String)?,
    preSelection: (reason: String, code: String)?
  ) -> (reason: String, code: String)? {
    guard xCTestTierRan, state == .deferredToIndependentBackend else { return firstFailure ?? preSelection }
    return xcTestChannelStateFirstFailure(.boundedXCTestProbe)
  }

  /// The daemon's private-AX pin takes the penalized route deliberately, not from degradation.
  static func snapshotXCTestChannelTreatedAsPenalized(
    penalized: Bool,
    preferredBackend: String?
  ) -> Bool {
    penalized || preferredBackend == SnapshotBackendKind.privateAX.rawValue
  }

  /// An internal preferred backend pins the regular plan. A penalized channel defers XCTest tiers
  /// to independent backends where the platform has one (every step bounded recovery, so no
  /// attempt can renew the penalty), otherwise it keeps XCTest work on a short probe. A due
  /// recovery probe puts the bounded tree first, claiming the probe. Raw and unknown plans are
  /// untouched.
  static func effectiveSnapshotCapturePlan(
    _ plan: [SnapshotBackendKind],
    xCTestChannelPenalized: Bool,
    xCTestRecoveryProbeDue: Bool = false,
    availableBackends: Set<SnapshotBackendKind> = Set(SnapshotBackendKind.allCases),
    preferredBackend: String? = nil
  ) -> EffectiveSnapshotCapturePlan {
    var ordered = plan
    var state: SnapshotXCTestChannelPlanState = .normal
    var preferred: SnapshotBackendKind?
    var probeLeads = false
    if
      plan == Self.regularVisiblePlan,
      let candidate = preferredBackend.flatMap(SnapshotBackendKind.init(rawValue:)),
      candidate.isForceable,
      availableBackends.contains(candidate)
    {
      ordered = [candidate]
      preferred = candidate
      state = candidate == .privateAX ? .deferredToIndependentBackend : .normal
    } else if xCTestChannelPenalized, plan == Self.regularVisiblePlan {
      let availablePlan = plan.filter { availableBackends.contains($0) }
      let recoveryPlan = availablePlan.filter { !$0.usesXCTestAccessibilityChannel }
      if !recoveryPlan.isEmpty {
        // The independent backend reads only the app it matches as the active AX application, so an
        // out-of-process surface leaves it empty for the whole penalty; the bounded tree stays
        // behind it as the sparse fallback. The query sweep stays deferred: its grind is what the
        // penalty keeps off the main thread.
        let boundedTree = availablePlan.filter { $0 == .recursiveTree }
        probeLeads = xCTestRecoveryProbeDue && !boundedTree.isEmpty
        ordered = probeLeads ? boundedTree + recoveryPlan : recoveryPlan + boundedTree
        state = .deferredToIndependentBackend
      } else {
        ordered = availablePlan.filter(\.usesXCTestAccessibilityChannel)
        state = .boundedXCTestProbe
      }
    }
    // A penalized state runs every tier as bounded recovery, so no attempt from it can arm or
    // renew the penalty it is recovering from. Only the leading XCTest step of a probe-leading
    // deferred plan claims the probe.
    let steps = ordered.enumerated().map { offset, kind -> SnapshotCaptureStep in
      guard state != .normal else { return .ordinary(kind) }
      let claims = probeLeads && offset == 0 && kind.usesXCTestAccessibilityChannel
      return .boundedRecovery(kind, claimsPeriodicProbe: claims)
    }
    return EffectiveSnapshotCapturePlan(
      steps: steps,
      xCTestChannelState: state,
      preferredBackend: preferred
    )
  }

  /// A bounded recovery attempt has no arming branch at all: that gate is what stops a probe from
  /// renewing its own penalty (#3896). The breaker observes acquisition facts only; presentation
  /// is a separate phase and cannot arm it.
  static func snapshotXCTestPenaltyReason(
    for attempt: SnapshotBackendAttempt,
    slowThresholdMs: Double
  ) -> String? {
    guard case .ordinary(let kind) = attempt.step else { return nil }
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

  /// Only an accepted, fast tree from a bounded recovery attempt clears the penalty early; an
  /// ordinary tree capture can only arm it.
  static func snapshotBoundedRecoveryRestoredChannel(_ attempt: SnapshotBackendAttempt) -> Bool {
    guard case .boundedRecovery(.recursiveTree, _) = attempt.step,
      attempt.timing.acquisitionMs <= SnapshotCaptureStep.boundedTreeSliceBudget * 1_000,
      case let .captured(capture) = attempt.outcome
    else { return false }
    return Self.snapshotTierRejectionReason(
      outcome: attempt.tierOutcome,
      kind: .recursiveTree,
      payload: capture.qualityPayload ?? capture.payload
    ) == nil
  }
}
