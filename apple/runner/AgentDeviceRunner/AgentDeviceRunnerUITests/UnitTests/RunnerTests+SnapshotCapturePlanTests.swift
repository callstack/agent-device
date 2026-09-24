import XCTest
import AgentDeviceSnapshotPresentation

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
        rect: SnapshotRect(.zero),
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

  /// A sweep the slice cut short is rejected as a tier timeout even when what it collected clears
  /// every bar the quality classifier has, while the identical payload from a sweep that ran all its
  /// queries is accepted. The pair is the point: node count cannot see the deadline (#2781).
  func testDeadlineExhaustedTierIsRejectedWhileItsIdenticalCompletedPayloadIsAccepted() {
    let root = planTestNode(index: 0, type: "Application", label: "Example App", hittable: true)
    let nodes: [PresentedNode] = [root] + (1..<13).map { index in
      planTestNode(index: index, type: "Button", label: "Row \(index)", hittable: true, parentIndex: 0)
    }
    let payload = DataPayload(nodes: nodes, truncated: true)
    XCTAssertNil(
      Self.sparsePayloadReason(payload),
      "this payload clears the classifier on its own, so only the tier outcome can reject it"
    )
    XCTAssertEqual(
      Self.snapshotTierRejectionReason(
        outcome: .deadlineExhausted,
        kind: .querySweep,
        payload: payload
      )?.code,
      "budget",
      "a tier that spent its capture slice is a timeout whatever it collected"
    )
    XCTAssertNil(
      Self.snapshotTierRejectionReason(
        outcome: .completed,
        kind: .querySweep,
        payload: payload
      )
    )
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
      state: .healthy,
      reason: nil
    )

    XCTAssertEqual(payload.snapshotQuality?.timing, timing)
    XCTAssertEqual(payload.nodes?.count, 1)
  }

  func testStampedPayloadCarriesDisclosuresOnlyInTheVerdict() {
    let root = planTestNode(index: 0, type: "Application", label: "App")
    let merged = planTestNode(
      index: 1,
      type: "Other",
      label: (0...30).map { "Tab \($0)" }.joined(separator: ", "),
      parentIndex: 0
    )
    let coverage = SnapshotCustomActionCoverage(
      read: 12, candidates: 19, truncated: 0, blocked: false)
    let silent = stampedSnapshotPayload(
      SnapshotBackendCapture(
        payload: DataPayload(nodes: [root, merged], truncated: false),
        effectiveDepth: nil,
        customActions: coverage
      ),
      backend: .recursiveTree,
      state: .healthy,
      reason: nil
    )
    XCTAssertNil(silent.message)
    XCTAssertEqual(silent.snapshotQuality?.customActions, coverage)
    XCTAssertEqual(silent.snapshotQuality?.collapsedLeafIndexes, [1])

    let underlying = stampedSnapshotPayload(
      SnapshotBackendCapture(
        payload: DataPayload(message: "underlying", nodes: [root], truncated: false),
        effectiveDepth: 4
      ),
      backend: .privateAX,
      state: .recovered,
      reason: (reason: "tree capture timed out", code: "budget")
    )
    XCTAssertEqual(underlying.message, "underlying")
  }

  func testStampedPayloadTruncationTracksCompletenessNotRecoveryProvenance() {
    let complete = SnapshotBackendCapture(
      payload: DataPayload(
        nodes: [
          planTestNode(index: 0, type: "Application", label: "App"),
          planTestNode(index: 1, type: "Button", label: "Open", parentIndex: 0),
        ],
        truncated: false
      ),
      effectiveDepth: nil
    )
    let deferred: (reason: String, code: String) = (
      "XCTest-backed snapshot tiers were deferred after recent slow accessibility work", "deferred"
    )

    // The CI signature behind `is absent ... capture was truncated`: a complete private AX
    // tree selected while the XCTest channel is penalized is whole, and must say so.
    let recovered = stampedSnapshotPayload(
      complete, backend: .privateAX, state: .recovered, reason: deferred)
    XCTAssertEqual(recovered.snapshotQuality?.state, .recovered)
    XCTAssertEqual(recovered.truncated, false)

    let depthLimited = stampedSnapshotPayload(
      SnapshotBackendCapture(payload: complete.payload, effectiveDepth: 56),
      backend: .privateAX, state: .recovered, reason: deferred)
    XCTAssertEqual(depthLimited.truncated, true)

    let cappedPayload = stampedSnapshotPayload(
      SnapshotBackendCapture(
        payload: DataPayload(nodes: complete.payload.nodes ?? [], truncated: true),
        effectiveDepth: nil),
      backend: .recursiveTree, state: .healthy, reason: nil)
    XCTAssertEqual(cappedPayload.truncated, true)

    let sparse = stampedSnapshotPayload(
      complete, backend: .querySweep, state: .sparse,
      reason: ("snapshot returned no semantic controls or content", "sparse-tree"))
    XCTAssertEqual(sparse.truncated, true)
  }

  func testSnapshotQualityCarriesUnscopedQualityPayload() {
    let quality = DataPayload(
      nodes: [planTestNode(index: 0, type: "Application", label: "App")],
      truncated: false
    )
    let capture = SnapshotBackendCapture(
      payload: quality,
      effectiveDepth: nil,
      qualityPayload: quality
    )

    let payload = stampedSnapshotPayload(
      capture,
      backend: .recursiveTree,
      state: .healthy,
      reason: nil
    )

    XCTAssertEqual(payload.qualityPayload?.nodes.count, 1)
    XCTAssertEqual(payload.qualityPayload?.truncated, false)
    XCTAssertNil(payload.qualityPayload?.scope)
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
        viewport: .reported(box: CGRect(x: 0, y: 0, width: 402, height: 874))
      ),
      options: options
    )
    let capture = Self.makeSnapshotBackendCapture(from: result)

    let payload = stampedSnapshotPayload(
      capture,
      backend: .recursiveTree,
      state: .healthy,
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

  func testAbandonedMainThreadWorkSkipsOnlyXCTestBackedSnapshotTiers() {
    abandonedMainThreadWorkCount = 1
    defer { abandonedMainThreadWorkCount = 0 }

    XCTAssertTrue(shouldSkipSnapshotBackendForAbandonedMainThreadWork(.recursiveTree))
    XCTAssertTrue(shouldSkipSnapshotBackendForAbandonedMainThreadWork(.querySweep))
    XCTAssertFalse(shouldSkipSnapshotBackendForAbandonedMainThreadWork(.privateAX))
  }

#if os(iOS)
  /// #2403: a plan pinned to private AX serves a regular `--depth` request through acquisition
  /// and presentation. With a backend depth gate in `captureWithBackend`, private AX returns no
  /// capture, the plan falls through to the synthetic sparse root, and the daemon rejects that
  /// zero-rect root as a missing viewport.
  @MainActor
  func testPrivateAXPinnedRegularDepthReachesAcquisitionAndPresentation() throws {
    app.launchArguments = ["--agent-device-selector-read-regression"]
    app.launch()
    mainOwned.app = app
    mainOwned.bundleId = nil
    defer {
      mainOwned.app = nil
      clearPrivateAXAcceptedDepth(reason: "test-cleanup")
      app.terminate()
    }
    func capture(depth: Int?) throws -> DataPayload {
      try runSnapshotCapturePlan(
        Self.regularVisiblePlan,
        target: takeSnapshotCaptureTarget(app: app),
        options: PresentationOptions(
          interactiveOnly: false,
          depth: depth,
          scope: nil,
          raw: false,
          preferredBackend: SnapshotBackendKind.privateAX.rawValue
        ),
        terminal: .sparseWithFatalOnAXFailure
      )
    }

    let capped = try capture(depth: 1)

    let quality = try XCTUnwrap(capped.snapshotQuality)
    XCTAssertEqual(quality.backend, SnapshotBackendKind.privateAX.rawValue)
    XCTAssertNotEqual(quality.state, .sparse)
    let nodes = try XCTUnwrap(capped.nodes)
    XCTAssertGreaterThan(nodes.count, 1)
    XCTAssertEqual(nodes.map(\.depth).max(), 1)
    XCTAssertNotEqual(nodes[0].rect, SnapshotRect(x: 0, y: 0, width: 0, height: 0))
    XCTAssertTrue(nodes.contains { $0.label == "Readable target" })

    // The presented cut only ever narrows the unscoped capture from the same backend.
    let unscoped = try XCTUnwrap(try capture(depth: nil).nodes)
    XCTAssertLessThanOrEqual(nodes.count, unscoped.count)
  }
#endif
}
#endif
