import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  static let axSnapshotErrorCode = "IOS_AX_SNAPSHOT_FAILED"
  static let axSnapshotFailureMessage =
    "iOS XCTest snapshot failed while serializing the accessibility tree."
  private static let axSnapshotUnavailableReason = "ax_snapshot_unavailable"
  static let axSnapshotHint =
    "Snapshot state is unavailable because XCTest could not serialize this iOS accessibility tree. This can be specific to the current screen. Use plain screenshot, not screenshot --overlay-refs, as visual truth; navigate with coordinate commands if needed; then retry snapshot -i after reaching another screen. If you own the app and need full-tree inspection, simplify this screen's accessibility tree and expose stable ids on actionable controls."
  private static let rawSnapshotTooLargeCode = "IOS_RAW_SNAPSHOT_TOO_LARGE"
  private static let rawSnapshotMaxNodes = 5_000
  private static let rawSnapshotTooLargeHint =
    "Raw iOS snapshot exceeded the runner payload guard. Use regular snapshot for visible UI, or scope/depth-limit raw snapshot when inspecting a large accessibility tree."
  // Runaway guard for the regular tree walk: a work bound only. A screen that trips it raises this
  // number in ADR 0004's name rather than bounding the walk by geometry again.
  private static let regularSnapshotMaxNodes = 50_000
  private static let regularSnapshotTooLargeCode = "IOS_SNAPSHOT_TOO_LARGE"
  private static let regularSnapshotTooLargeHint =
    "iOS snapshot walked an unexpectedly large accessibility tree. Scope the snapshot to a subtree or use screenshot."
  struct SnapshotTraversalContext {
    let queryRoot: XCUIElement
    let rootSnapshot: XCUIElementSnapshot
    let viewport: CGRect
    /** Which way the app's interface is turned from the device's native space (#2612). */
    let interfaceOrientation: Int
    /**
     * The keyboard band this capture measured, published beside the tree so the daemon's tap guard
     * measures against the producer's own reading rather than a band it derives from these rects
     * (#2660). Nil only where the platform has no iOS keyboard to measure.
     */
    let keyboardBand: RunnerKeyboardBandFact?
  }

  struct SnapshotEvaluation {
    let label: String
    let identifier: String
    let valueText: String?
    let focused: Bool
    let selected: Bool
  }

  private struct SnapshotTraversalEntry {
    let snapshot: XCUIElementSnapshot
    let depth: Int
    let parentIndex: Int?
  }

  /// The acquisition work bound for a tree walk: raw traversal depth only. A regular capture carries
  /// no raw bound, so it walks the whole materialized tree and `SnapshotPresentation` does the
  /// presented-depth cut and the visibility fold on the normalized array. An acquisition bound must
  /// not read geometry: consulting the fold mid-walk was how a turned keyboard subtree got pruned by
  /// its un-normalized rect under `--depth` (#2612, #2661).
  static func canDescendAtRawDepth(_ depth: Int, hint: CaptureHint) -> Bool {
    guard let rawLimit = hint.rawTraversalDepth else { return true }
    return depth < rawLimit
  }

  struct SnapshotCaptureFailure: Error {
    let code: String
    let message: String
    let hint: String
    let qualityReasonCode: String?

    init(code: String, message: String, hint: String, qualityReasonCode: String? = nil) {
      self.code = code
      self.message = message
      self.hint = hint
      self.qualityReasonCode = qualityReasonCode
    }
  }

  // MARK: - Snapshot Entry

  /// One raw-value table covers public XCTest cases and the SDK-hidden Keyboard/Key values.
  static let elementTypeNamesByRawValue = [
    XCUIElement.ElementType.application.rawValue: "Application",
    XCUIElement.ElementType.window.rawValue: "Window",
    XCUIElement.ElementType.button.rawValue: "Button",
    XCUIElement.ElementType.cell.rawValue: "Cell",
    XCUIElement.ElementType.staticText.rawValue: "StaticText",
    XCUIElement.ElementType.textField.rawValue: "TextField",
    XCUIElement.ElementType.textView.rawValue: "TextView",
    XCUIElement.ElementType.secureTextField.rawValue: "SecureTextField",
    XCUIElement.ElementType.switch.rawValue: "Switch",
    XCUIElement.ElementType.slider.rawValue: "Slider",
    XCUIElement.ElementType.link.rawValue: "Link",
    XCUIElement.ElementType.image.rawValue: "Image",
    XCUIElement.ElementType.navigationBar.rawValue: "NavigationBar",
    XCUIElement.ElementType.tabBar.rawValue: "TabBar",
    XCUIElement.ElementType.collectionView.rawValue: "CollectionView",
    XCUIElement.ElementType.table.rawValue: "Table",
    XCUIElement.ElementType.scrollView.rawValue: "ScrollView",
    XCUIElement.ElementType.toolbar.rawValue: "Toolbar",
    XCUIElement.ElementType.searchField.rawValue: "SearchField",
    XCUIElement.ElementType.segmentedControl.rawValue: "SegmentedControl",
    XCUIElement.ElementType.stepper.rawValue: "Stepper",
    XCUIElement.ElementType.picker.rawValue: "Picker",
    XCUIElement.ElementType.activityIndicator.rawValue: "ActivityIndicator",
    XCUIElement.ElementType.progressIndicator.rawValue: "ProgressIndicator",
    XCUIElement.ElementType.checkBox.rawValue: "CheckBox",
    XCUIElement.ElementType.menuItem.rawValue: "MenuItem",
    XCUIElement.ElementType.webView.rawValue: "WebView",
    XCUIElement.ElementType.other.rawValue: "Other",
    19: "Keyboard",
    20: "Key"
  ]

  func elementTypeName(_ type: XCUIElement.ElementType) -> String {
    Self.elementTypeNamesByRawValue[type.rawValue] ?? "Element(\(type.rawValue))"
  }

  static let structuralOnlyNodeTypes: Set<String> = [
    "Application",
    "Window",
    "Other",
    "ScrollView"
  ]

  static let collapsedTabCandidateTypes: Set<XCUIElement.ElementType> = [
    .button,
    .link,
    .menuItem,
    .other,
    .staticText
  ]

  static let scrollContainerTypes: Set<XCUIElement.ElementType> = [
    .collectionView,
    .scrollView,
    .table
  ]

  static let flatInteractiveFallbackBudget: TimeInterval = 1.0

  /// What one capture may spend reading the keyboard band before it gives up on the fact and lets the
  /// tap guard fall back to the tree rule. The scroll path pays this query per gesture and stays well
  /// inside a second; the number here is a ceiling for a read that normally returns in milliseconds,
  /// sized so a hostile keyboard surface cannot extend a capture the way the unbounded read it
  /// replaced would have (#2660).
  static let keyboardBandProbeBudget: TimeInterval = 0.3

  // The single production entry point -- always compiled, no unit-test overload. A unit test
  // exercises this exact function; the only injectable seam lives inside
  // `boundedBlockingSystemAlertSnapshot`'s probe closure (see `systemModalProbeOverrideForTesting`
  // in RunnerTests.swift), so reverting this entry point to bypass the bounded probe fails the
  // regression test.
  func snapshotFast(app: XCUIApplication, options: PresentationOptions) throws -> DataPayload {
    let deadline = Date().addingTimeInterval(Self.snapshotPlanBudget)
    if let blocking = boundedBlockingSystemAlertSnapshot(deadline: deadline) {
      return blocking
    }
    return try runSnapshotCapturePlan(
      Self.regularVisiblePlan,
      app: app,
      options: options,
      terminal: .sparseWithFatalOnAXFailure,
      deadline: deadline
    )
  }

  func recursiveTreeSnapshotAcquisition(
    context: SnapshotTraversalContext,
    hint: CaptureHint
  ) throws -> SnapshotAcquisition {
    var cachedDescendantElements: [XCUIElement]?
    func collapsedTabDescendants() -> [XCUIElement] {
      if let cachedDescendantElements {
        return cachedDescendantElements
      }
      let result = snapshotElementsQuery {
        context.queryRoot.descendants(matching: .any).allElementsBoundByIndex
      }
      cachedDescendantElements = result.elements
      return result.elements
    }

    // Acquisition serializes reported frames only; no coordinate space or fold decision is carried
    // down the walk (#2661). Its sole bounds are raw traversal depth (nil for a regular capture) and
    // the node cap; `SnapshotPresentation` folds and cuts the normalized array.
    var nodes: [RawAXNode] = []
    nodes.append(
      makeSnapshotNode(
        snapshot: context.rootSnapshot,
        evaluation: evaluateSnapshot(context.rootSnapshot),
        depth: 0,
        index: 0,
        parentIndex: nil
      )
    )
    if Self.canDescendAtRawDepth(0, hint: hint) {
      appendCollapsedTabFallbackNodes(
        to: &nodes,
        containerSnapshot: context.rootSnapshot,
        resolveElements: collapsedTabDescendants,
        depth: 1,
        parentIndex: 0
      )
    }

    var seen = Set<String>()
    var stack: [SnapshotTraversalEntry] = []
    if Self.canDescendAtRawDepth(0, hint: hint) {
      stack = context.rootSnapshot.children.map {
        SnapshotTraversalEntry(snapshot: $0, depth: 1, parentIndex: 0)
      }
    }

    while let entry = stack.popLast() {
      let snapshot = entry.snapshot
      let depth = entry.depth
      if let limit = hint.rawTraversalDepth, depth > limit { continue }

      let evaluation = evaluateSnapshot(snapshot)
      let node = makeSnapshotNode(
        snapshot: snapshot,
        evaluation: evaluation,
        depth: depth,
        index: nodes.count,
        parentIndex: entry.parentIndex
      )
      let key = Self.snapshotTraversalIdentity(
        elementType: snapshot.elementType,
        label: evaluation.label,
        identifier: evaluation.identifier,
        frame: snapshot.frame
      )
      let isDuplicate = seen.contains(key)
      if !isDuplicate {
        seen.insert(key)
      }

      // A repeated node collapses into its parent: its children re-parent onto `entry.parentIndex`,
      // so identical rows share one addressable owner.
      let currentIndex = isDuplicate ? entry.parentIndex : nodes.count
      for child in snapshot.children.reversed() {
        stack.append(
          SnapshotTraversalEntry(snapshot: child, depth: depth + 1, parentIndex: currentIndex)
        )
      }

      if isDuplicate { continue }

      nodes.append(node)
      if nodes.count > Self.regularSnapshotMaxNodes {
        throw regularSnapshotTooLargeFailure(nodeCount: nodes.count)
      }
      if Self.canDescendAtRawDepth(depth, hint: hint) {
        appendCollapsedTabFallbackNodes(
          to: &nodes,
          containerSnapshot: snapshot,
          resolveElements: collapsedTabDescendants,
          depth: depth + 1,
          parentIndex: node.index
        )
      }
    }

    return SnapshotAcquisition(
      hint: hint,
      nodes: nodes,
      truncated: false,
      effectiveDepth: nil,
      viewport: context.viewport,
      interfaceOrientation: context.interfaceOrientation
    )
  }

  // See `snapshotFast` above: the single production entry point, no unit-test overload.
  func snapshotRaw(app: XCUIApplication, options: PresentationOptions) throws -> DataPayload {
    let deadline = Date().addingTimeInterval(Self.snapshotPlanBudget)
    if let blocking = boundedBlockingSystemAlertSnapshot(deadline: deadline) {
      return blocking
    }
    return try runSnapshotCapturePlan(
      Self.rawDiagnosticPlan,
      app: app,
      options: options,
      terminal: .throwOnAXFailure,
      deadline: deadline
    )
  }

  /// Runs the pre-plan SpringBoard system-modal probe as a bounded capture tier sharing the plan
  /// deadline, so a slow alert enumeration cannot bypass the snapshot timeout and stall (#1244).
  func boundedBlockingSystemAlertSnapshot(deadline: Date) -> DataPayload? {
    boundedBlockingSystemAlertSnapshotBody(deadline: deadline) { probeDeadline in
      #if AGENT_DEVICE_RUNNER_UNIT_TESTS
      if let override = self.systemModalProbeOverrideForTesting {
        return override(probeDeadline)
      }
      #endif
      return self.blockingSystemAlertSnapshot(deadline: probeDeadline)
    }
  }

  /// The real bounding/hook machinery used by `boundedBlockingSystemAlertSnapshot` above: the
  /// probe closure it's given always calls `self.blockingSystemAlertSnapshot` in production, and
  /// in unit-test builds may first consult `systemModalProbeOverrideForTesting`. Keeping this in
  /// one place means the main-thread dispatch and its penalty hook can never drift between what
  /// production runs and what the unit tests exercise.
  private func boundedBlockingSystemAlertSnapshotBody(
    deadline: Date,
    probe: @escaping (Date) -> DataPayload?
  ) -> DataPayload? {
    #if os(macOS)
      return nil
    #else
    let slice = Self.systemModalProbeSlice(
      budget: systemModalProbeBudget,
      deadlineRemaining: deadline.timeIntervalSinceNow
    )
    guard slice > 0 else {
      NSLog("AGENT_DEVICE_RUNNER_SYSTEM_MODAL_PROBE_SKIPPED reason=budget_exhausted")
      return nil
    }
    let probeDeadline = Date().addingTimeInterval(slice)
    let startedAt = Date()
    do {
      return try runMainThreadWork(
        "system_modal_probe",
        timeout: slice,
        timeoutError: {
          SnapshotCaptureFailure(
            code: Self.xCTestSnapshotTimeoutCode,
            message: "the system-modal probe exceeded its \(slice)s time slice",
            hint: "The capture plan recovers through non-XCTest snapshot tiers while the modal probe drains."
          )
        },
        onAbandoned: {
          self.penalizeSnapshotXCTestChannel(
            bundleId: self.currentBundleId,
            reason: "system_modal_probe_timeout"
          )
        }
      ) {
        probe(probeDeadline)
      }
    } catch {
      NSLog(
        "AGENT_DEVICE_RUNNER_SYSTEM_MODAL_PROBE_ABORTED elapsedMs=%d error=%@",
        Int(Date().timeIntervalSince(startedAt) * 1000),
        String(describing: error)
      )
      return nil
    }
    #endif
  }

  /// The probe gets its own budget, clamped by whatever remains of the shared plan deadline, and
  /// 0 (skip entirely) once that deadline is already spent.
  static func systemModalProbeSlice(
    budget: TimeInterval,
    deadlineRemaining: TimeInterval
  ) -> TimeInterval {
    guard deadlineRemaining > 0 else { return 0 }
    return min(budget, deadlineRemaining)
  }

  func rawTreeSnapshotAcquisition(
    context: SnapshotTraversalContext,
    hint: CaptureHint
  ) throws -> SnapshotAcquisition {
    var nodes: [RawAXNode] = []

    func walk(
      _ snapshot: XCUIElementSnapshot,
      depth: Int,
      parentIndex: Int?
    ) throws {
      if let limit = hint.rawTraversalDepth, depth > limit { return }

      let evaluation = evaluateSnapshot(snapshot)
      if nodes.count >= Self.rawSnapshotMaxNodes {
        throw rawSnapshotTooLargeFailure(nodeCount: nodes.count + 1)
      }
      let currentIndex = nodes.count
      nodes.append(
        makeSnapshotNode(
          snapshot: snapshot,
          evaluation: evaluation,
          depth: depth,
          index: currentIndex,
          parentIndex: parentIndex
        )
      )

      let children = snapshot.children
      for child in children {
        try walk(
          child,
          depth: depth + 1,
          parentIndex: currentIndex
        )
      }
    }

    try walk(
      context.rootSnapshot,
      depth: 0,
      parentIndex: nil
    )
    return SnapshotAcquisition(
      hint: hint,
      nodes: nodes,
      truncated: false,
      effectiveDepth: nil,
      viewport: context.viewport,
      interfaceOrientation: context.interfaceOrientation
    )
  }

  func querySweepSnapshotAcquisition(
    app: XCUIApplication,
    hint: CaptureHint,
    planDeadline: Date = .distantFuture
  ) -> SnapshotAcquisition {
    var nodes: [RawAXNode] = [
      interactiveRootNode(rect: .zero)
    ]
    if hint.rawTraversalDepth == 0 || hint.regularPresentedDepth == 0 {
      return SnapshotAcquisition(
        hint: hint,
        nodes: nodes,
        truncated: false,
        effectiveDepth: nil,
        viewport: .infinite,
        interfaceOrientation: RunnerInterfaceOrientation.unknown
      )
    }

    // Bounded by both its own sweep budget and the umbrella capture-plan deadline, so a
    // chained recovery tier can never push the plan past the main-thread watchdog (#1105).
    let sweepDeadline = hint.interactiveOnly
      ? Date().addingTimeInterval(Self.flatInteractiveFallbackBudget)
      : Date.distantFuture
    let deadline = min(sweepDeadline, planDeadline)
    let viewport = safeSnapshotViewport(app: app)
    var seen = Set<String>()
    var candidates: [RawAXNode] = []
    let flatElements = flatInteractiveElements(app: app, deadline: deadline)
    var truncated = flatElements.truncated
    for element in flatElements.elements {
      if Date() >= deadline {
        NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_FLAT_FALLBACK_DEADLINE")
        truncated = true
        break
      }
      guard let node = flatSnapshotNode(element: element, index: 0, parentIndex: 0) else {
        continue
      }
      let key = "\(node.type)-\(node.label ?? "")-\(node.identifier ?? "")-\(node.value ?? "")-\(node.rect.x)-\(node.rect.y)-\(node.rect.width)-\(node.rect.height)"
      if seen.contains(key) { continue }
      seen.insert(key)
      candidates.append(node)
    }
    candidates.sort { left, right in
      if left.rect.y != right.rect.y {
        return left.rect.y < right.rect.y
      }
      if left.rect.x != right.rect.x {
        return left.rect.x < right.rect.x
      }
      return left.type < right.type
    }

    // The synthetic root doubles as the daemon's viewport (find.ts prefers on-screen matches
    // inside nodes[0].rect): use the real screen viewport when capture produced a finite one,
    // so off-screen candidates can never inflate the root and masquerade as on-screen.
    let rootRect = viewport.isInfinite || viewport.isNull || viewport.isEmpty
      ? interactiveRootFrame(for: candidates)
      : viewport
    nodes[0] = interactiveRootNode(rect: rootRect)
    for candidate in candidates {
      nodes.append(
        RawAXNode(
          index: nodes.count,
          type: candidate.type,
          label: candidate.label,
          identifier: candidate.identifier,
          value: candidate.value,
          rect: candidate.rect,
          enabled: candidate.enabled,
          focused: candidate.focused,
          selected: candidate.selected,
          hittable: candidate.hittable,
          depth: 1,
          parentIndex: 0,
          hiddenContentAbove: nil,
          hiddenContentBelow: nil
        )
      )
    }
    return SnapshotAcquisition(
      hint: hint,
      nodes: nodes,
      truncated: truncated,
      effectiveDepth: nil,
      viewport: viewport,
      interfaceOrientation: RunnerInterfaceOrientation.unknown
    )
  }

  func snapshotAccessibilityUnavailable(failure: SnapshotCaptureFailure) -> DataPayload {
    NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_AX_UNAVAILABLE=%@", failure.message)
    runnerAccessibilityHealth = .unavailable
    invalidateCachedTarget(reason: Self.axSnapshotUnavailableReason)
    // This is a planned terminal result, so it carries the structured verdict like every other
    // planned snapshot — downstream sparse handling keys off the verdict, not node shapes.
    return sparseTruncatedSnapshotPayload(
      message: recoveredSnapshotMessage(failure),
      snapshotQuality: SnapshotQuality(
        state: "sparse",
        backend: SnapshotBackendKind.recursiveTree.rawValue,
        reason: failure.message,
        reasonCode: "ax-rejected",
        effectiveDepth: nil,
        collapsedLeafIndexes: nil,
        customActions: nil
      ),
      runnerFatal: true,
      runnerFatalReason: Self.axSnapshotUnavailableReason
    )
  }

  private func recoveredSnapshotMessage(_ failure: SnapshotCaptureFailure) -> String {
    return "\(failure.message) Hint: \(failure.hint)"
  }

  private func rawSnapshotTooLargeFailure(nodeCount: Int) -> SnapshotCaptureFailure {
    SnapshotCaptureFailure(
      code: Self.rawSnapshotTooLargeCode,
      message: "iOS raw snapshot exceeded \(Self.rawSnapshotMaxNodes) nodes while walking node \(nodeCount).",
      hint: Self.rawSnapshotTooLargeHint
    )
  }

  private func regularSnapshotTooLargeFailure(nodeCount: Int) -> SnapshotCaptureFailure {
    SnapshotCaptureFailure(
      code: Self.regularSnapshotTooLargeCode,
      message: "iOS snapshot exceeded \(Self.regularSnapshotMaxNodes) nodes while walking node \(nodeCount).",
      hint: Self.regularSnapshotTooLargeHint
    )
  }

  func sparseTruncatedSnapshotPayload(
    message: String? = nil,
    snapshotQuality: SnapshotQuality? = nil,
    runnerFatal: Bool? = nil,
    runnerFatalReason: String? = nil
  ) -> DataPayload {
    return DataPayload(
      message: message,
      nodes: [SnapshotPresentation.singleElementRead(interactiveRootNode(rect: .zero))],
      truncated: true,
      snapshotQuality: snapshotQuality,
      runnerFatal: runnerFatal,
      runnerFatalReason: runnerFatalReason
    )
  }

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  func testSnapshotAccessibilityUnavailableMarksSparseSnapshotRunnerFatal() {
    currentApp = app
    currentBundleId = "com.example.app"

    let payload = snapshotAccessibilityUnavailable(
      failure: SnapshotCaptureFailure(
        code: Self.axSnapshotErrorCode,
        message: Self.axSnapshotFailureMessage,
        hint: Self.axSnapshotHint
      )
    )

    XCTAssertEqual(payload.message, "\(Self.axSnapshotFailureMessage) Hint: \(Self.axSnapshotHint)")
    XCTAssertEqual(payload.nodes?.count, 1)
    XCTAssertEqual(payload.nodes?.first?.type, "Application")
    XCTAssertEqual(payload.truncated, true)
    XCTAssertEqual(payload.runnerFatal, true)
    XCTAssertEqual(payload.runnerFatalReason, Self.axSnapshotUnavailableReason)
    // The planned terminal result carries the structured verdict like every other planned
    // snapshot — downstream sparse handling keys off it, not off node shapes.
    XCTAssertEqual(payload.snapshotQuality?.state, "sparse")
    XCTAssertEqual(payload.snapshotQuality?.reasonCode, "ax-rejected")
    XCTAssertEqual(payload.snapshotQuality?.reason, Self.axSnapshotFailureMessage)
    XCTAssertNil(currentApp)
    XCTAssertNil(currentBundleId)
  }

  func testRecoveredSnapshotMessagePreservesHint() {
    let message = recoveredSnapshotMessage(
      SnapshotCaptureFailure(
        code: Self.axSnapshotErrorCode,
        message: Self.axSnapshotFailureMessage,
        hint: Self.axSnapshotHint
      )
    )

    XCTAssertTrue(message.contains(Self.axSnapshotFailureMessage))
    XCTAssertTrue(message.contains(Self.axSnapshotHint))
  }

  func testRawSnapshotTooLargeFailureIsStructured() {
    let failure = rawSnapshotTooLargeFailure(nodeCount: Self.rawSnapshotMaxNodes + 1)

    XCTAssertEqual(failure.code, Self.rawSnapshotTooLargeCode)
    XCTAssertTrue(failure.message.contains("\(Self.rawSnapshotMaxNodes) nodes"))
    XCTAssertEqual(failure.hint, Self.rawSnapshotTooLargeHint)
  }

  func testSystemModalProbeSliceSharesAndClampsToPlanDeadline() {
    // Fresh plan deadline: the probe gets its full dedicated budget.
    XCTAssertEqual(Self.systemModalProbeSlice(budget: 4, deadlineRemaining: 20), 4)
    // Nearly-spent plan deadline: the probe is clamped so it can't run past the shared budget.
    XCTAssertEqual(Self.systemModalProbeSlice(budget: 4, deadlineRemaining: 1.5), 1.5)
    // Exactly/already exhausted deadline: skip the probe entirely (0), never a negative timeout.
    XCTAssertEqual(Self.systemModalProbeSlice(budget: 4, deadlineRemaining: 0), 0)
    XCTAssertEqual(Self.systemModalProbeSlice(budget: 4, deadlineRemaining: -5), 0)
  }

  // Simulator-only: the bounded probe body returns nil on macOS (no SpringBoard host), so the
  // timeout/penalty/drain machinery below only exists on the iOS branch.
#if os(iOS)
  /// Regression for #1244/#1248: drives the bounded system-modal probe through a real,
  /// production-only command entry point (`snapshotFast` or `snapshotRaw` -- see the two test
  /// methods below), not `boundedBlockingSystemAlertSnapshot` directly, with
  /// `systemModalProbeOverrideForTesting` set to a closure that blocks past the probe's real
  /// slice, forcing a real `runMainThreadWork` timeout. This is revert-sensitive on both halves
  /// of the fix, for either entry point:
  ///   - if the entry point reverted to calling the unbounded `blockingSystemAlertSnapshot`
  ///     directly (or dropped the `runMainThreadWork` wrap), nothing here would ever time out,
  ///     so the mid-flight busy/penalty assertions below would never be met;
  ///   - if the `onAbandoned` penalty hook or the abandoned-work accounting were dropped, the
  ///     timeout would still fire, but the busy/penalty and drain assertions would not hold.
  ///
  /// The drain assertion is synchronized on the *real* release rather than raced: after
  /// signaling the probe to finish, the background queue polls `hasAbandonedMainThreadWork()`
  /// (bounded) and only then fulfills `drained`, which the test `wait(for:timeout:)`s on before
  /// asserting `.idle`/`hasAbandonedMainThreadWork() == false` below -- so a slow drain fails that
  /// assertion instead of racing a fixed-timing guess.
  private func assertBoundedSystemModalProbeTimeoutRecoversThenReleasesOnDrain(
    entryPointName: String,
    callEntryPoint: @escaping (XCUIApplication, PresentationOptions) throws -> DataPayload
  ) {
    let targetBundleId = "com.callstack.agentdevice.runner.missing.snapshot-timeout-test"
    let snapshotTarget = XCUIApplication(bundleIdentifier: targetBundleId)
    let probeReleaseGate = DispatchSemaphore(value: 0)
    currentApp = snapshotTarget
    currentBundleId = targetBundleId
    defer {
      probeReleaseGate.signal()
      currentApp = nil
      currentBundleId = nil
      systemModalProbeOverrideForTesting = nil
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
    }

    final class ResultBox {
      var payload: DataPayload?
      var wasBusyBeforeDrain = false
      var hadAbandonedCaptureBeforeDrain = false
      var wasPenalizedBeforeDrain = false
    }
    let box = ResultBox()
    // The test owns release of the injected probe. A fixed timeout races the capture plan's
    // independent fallback tiers on loaded CI hosts and can drain before the test records the
    // abandoned-work state. The defer above still releases the probe if an earlier assertion or
    // expectation fails.
    systemModalProbeOverrideForTesting = { _ in
      probeReleaseGate.wait()
      return nil
    }

    let completion = expectation(
      description: "\(entryPointName) recovered while the probe was abandoned, then released it"
    )
    let drained = expectation(description: "\(entryPointName) modal probe drained")
    DispatchQueue(label: "agent-device.runner.tests.modal-probe-timeout").async {
      box.payload = try? callEntryPoint(
        snapshotTarget,
        PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false)
      )

      // 1) Penalty/busy accounting: must already be in place by the time the entry point
      // returns, well before we release the still-blocked probe below.
      if case .busy = self.currentMainThreadBusyState() {
        box.wasBusyBeforeDrain = true
      }
      box.hadAbandonedCaptureBeforeDrain = self.hasAbandonedMainThreadWork()
      box.wasPenalizedBeforeDrain = self.isSnapshotXCTestChannelPenalized(bundleId: self.currentBundleId)

      // 2) `box.payload` above was already produced -- through the capture plan's recovery
      // tiers -- while the probe is still blocked on `probeReleaseGate`, i.e. recovered before
      // drain, not queued behind it.
      completion.fulfill()

      // 3) Only now let the abandoned probe finish, then block this queue (never the test's
      // main-thread wait) on the *real* drain signal -- the abandoned-work count reaching zero
      // -- bounded so a revert that never drains fulfills `drained` anyway and lets the
      // assertions below report the regression explicitly instead of just timing out.
      probeReleaseGate.signal()
      let drainDeadline = Date().addingTimeInterval(5)
      while self.hasAbandonedMainThreadWork(), Date() < drainDeadline {
        self.sleepFor(0.002)
      }
      drained.fulfill()
    }

    wait(for: [completion], timeout: 15)

    // 1) Penalty/busy accounting.
    XCTAssertTrue(
      box.wasBusyBeforeDrain,
      "expected RUNNER_BUSY while the \(entryPointName) modal probe timeout is outstanding"
    )
    XCTAssertTrue(
      box.hadAbandonedCaptureBeforeDrain,
      "onAbandoned must retain the abandoned XCTest channel work for \(entryPointName)"
    )
    XCTAssertTrue(
      box.wasPenalizedBeforeDrain,
      "a timed-out modal probe must penalize the XCTest snapshot channel for \(entryPointName)"
    )

    // 2) Recovered response before drain.
    XCTAssertNotNil(
      box.payload,
      "\(entryPointName) must recover a payload through the capture plan while the probe drains"
    )

    // 3) Bounded, deterministic drain barrier, then release assertions.
    wait(for: [drained], timeout: 6)
    guard case .idle = currentMainThreadBusyState() else {
      return XCTFail("expected the runner to be idle once the abandoned \(entryPointName) probe drained")
    }
    XCTAssertFalse(
      hasAbandonedMainThreadWork(),
      "the drained probe must release the main thread for \(entryPointName)"
    )
  }

  func testBoundedSystemModalProbeTimeoutRecoversThenReleasesOnDrain() {
    assertBoundedSystemModalProbeTimeoutRecoversThenReleasesOnDrain(entryPointName: "snapshotFast") {
      target, options in
      try self.snapshotFast(app: target, options: options)
    }
  }

  func testBoundedSystemModalProbeTimeoutRecoversThenReleasesOnDrainForSnapshotRaw() {
    assertBoundedSystemModalProbeTimeoutRecoversThenReleasesOnDrain(entryPointName: "snapshotRaw") {
      target, options in
      try self.snapshotRaw(app: target, options: options)
    }
  }
#endif

  func testDispatchRecoverySkipsBookkeepingWhileXCTestChannelOccupied() {
    // The #1244 recovery shape: the modal probe abandoned an XCTest query that is still grinding on
    // main, the capture recovered independently, and its response is ready. The recovery loop must
    // return it without re-entering the main queue for recorded-failure/retry bookkeeping (that hop
    // would block behind the abandoned query and re-stall the command), and a later command must
    // still see the runner busy until the abandoned work drains. Removing the guard regresses this.
    let command = try! JSONDecoder().decode(
      Command.self,
      from: Data(#"{"command":"snapshot","commandId":"recovery-guard"}"#.utf8)
    )
    let recovered = Response(ok: false, error: .targetAppUnavailable(bundleId: nil))

    setAbandonedMainThreadWork(1)
    defer { setAbandonedMainThreadWork(0) }
    guard case .busy = currentMainThreadBusyState() else {
      return XCTFail("expected RUNNER_BUSY while abandoned XCTest work is outstanding")
    }

    var occupiedCalls = 0
    let occupied = try! executeDispatchedWithRecovery(command: command) {
      occupiedCalls += 1
      return recovered
    }
    XCTAssertEqual(occupiedCalls, 1, "recovered response must not retry behind abandoned XCTest work")
    XCTAssertEqual(occupied.ok, false)

    setAbandonedMainThreadWork(0)
    guard case .idle = currentMainThreadBusyState() else {
      return XCTFail("runner should be idle once the abandoned work drained")
    }
    var drainedCalls = 0
    _ = try! executeDispatchedWithRecovery(command: command) {
      drainedCalls += 1
      return recovered
    }
    XCTAssertEqual(drainedCalls, 2, "with the channel free the read-only retry runs once")
  }

  private func setAbandonedMainThreadWork(_ count: Int) {
    mainThreadWorkLock.lock()
    abandonedMainThreadWorkCount = count
    abandonedMainThreadWorkSince = count > 0 ? Date(timeIntervalSinceNow: -1) : nil
    mainThreadWorkLock.unlock()
  }
#endif

}
