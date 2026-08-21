import XCTest

extension RunnerTests {
  private static let axSnapshotErrorCode = "IOS_AX_SNAPSHOT_FAILED"
  private static let axSnapshotFailureMessage =
    "iOS XCTest snapshot failed while serializing the accessibility tree."
  private static let axSnapshotUnavailableReason = "ax_snapshot_unavailable"
  private static let axSnapshotHint =
    "Snapshot state is unavailable because XCTest could not serialize this iOS accessibility tree. This can be specific to the current screen. Use plain screenshot, not screenshot --overlay-refs, as visual truth; navigate with coordinate commands if needed; then retry snapshot -i after reaching another screen. If you own the app and need full-tree inspection, simplify this screen's accessibility tree and expose stable ids on actionable controls."
  private static let rawSnapshotTooLargeCode = "IOS_RAW_SNAPSHOT_TOO_LARGE"
  private static let rawSnapshotMaxNodes = 5_000
  private static let rawSnapshotTooLargeHint =
    "Raw iOS snapshot exceeded the runner payload guard. Use regular snapshot for visible UI, or scope/depth-limit raw snapshot when inspecting a large accessibility tree."
  struct SnapshotTraversalContext {
    let queryRoot: XCUIElement
    let rootSnapshot: XCUIElementSnapshot
    let viewport: CGRect
    let maxDepth: Int
  }

  private struct SnapshotEvaluation {
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

  private static let collapsedTabCandidateTypes: Set<XCUIElement.ElementType> = [
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
  ) -> SnapshotAcquisition {
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

    // Acquisition serializes facts: every traversed node is emitted at raw traversal depth, and
    // the regular projection's clip fold runs once inside `SnapshotPresentation` (#1797). The two
    // walks this backend keeps are budget and augmentation, never membership: the traversal-depth
    // cut (declared residue -- regular presentation emits collapsed depth) and the collapsed-tab
    // expansion, which needs live element handles.
    var nodes: [RawAXNode] = []
    let rootEvaluation = evaluateSnapshot(context.rootSnapshot)
    nodes.append(
      makeSnapshotNode(
        snapshot: context.rootSnapshot,
        evaluation: rootEvaluation,
        depth: 0,
        index: 0,
        parentIndex: nil,
        viewport: context.viewport
      )
    )
    if context.maxDepth > 0 {
      appendCollapsedTabFallbackNodes(
        to: &nodes,
        containerSnapshot: context.rootSnapshot,
        resolveElements: collapsedTabDescendants,
        depth: 1,
        parentIndex: 0,
        viewport: context.viewport
      )
    }

    var seen = Set<String>()
    var stack: [SnapshotTraversalEntry] = context.rootSnapshot.children.map {
      SnapshotTraversalEntry(
        snapshot: $0,
        depth: 1,
        parentIndex: 0
      )
    }

    while let entry = stack.popLast() {
      let snapshot = entry.snapshot
      let depth = entry.depth
      let parentIndex = entry.parentIndex
      if let limit = hint.depth, depth > limit { continue }

      let evaluation = evaluateSnapshot(snapshot)
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

      let currentIndex = !isDuplicate ? nodes.count : parentIndex
      if depth < context.maxDepth {
        for child in snapshot.children.reversed() {
          stack.append(
            SnapshotTraversalEntry(
              snapshot: child,
              depth: depth + 1,
              parentIndex: currentIndex
            )
          )
        }
      }

      if isDuplicate { continue }

      let index = nodes.count
      nodes.append(
        makeSnapshotNode(
          snapshot: snapshot,
          evaluation: evaluation,
          depth: depth,
          index: index,
          parentIndex: parentIndex,
          viewport: context.viewport
        )
      )
      if depth < context.maxDepth {
        appendCollapsedTabFallbackNodes(
          to: &nodes,
          containerSnapshot: snapshot,
          resolveElements: collapsedTabDescendants,
          depth: depth + 1,
          parentIndex: index,
          viewport: context.viewport
        )
      }
    }

    return SnapshotAcquisition(
      hint: hint,
      nodes: nodes,
      truncated: false,
      effectiveDepth: nil,
      viewport: context.viewport
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
  /// one place means the `runMainThreadWork` wrap and the `onAbandoned`/`onDrained` hooks can
  /// never drift between what production runs and what the unit tests exercise.
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
        timeout: slice,
        timeoutError: {
          SnapshotCaptureFailure(
            code: Self.xCTestSnapshotTimeoutCode,
            message: "the system-modal probe exceeded its \(slice)s time slice",
            hint: "The capture plan recovers through non-XCTest snapshot tiers while the modal probe drains."
          )
        },
        onAbandoned: {
          self.retainAbandonedXCTestChannelWork()
          NSLog("AGENT_DEVICE_RUNNER_SYSTEM_MODAL_PROBE_TIMEOUT slice=%.1f", slice)
          self.penalizeSnapshotXCTestChannel(
            bundleId: self.currentBundleId,
            reason: "system_modal_probe_timeout"
          )
        },
        onDrained: {
          self.releaseAbandonedXCTestChannelWork()
          NSLog("AGENT_DEVICE_RUNNER_SYSTEM_MODAL_PROBE_DRAINED")
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

    func walk(_ snapshot: XCUIElementSnapshot, depth: Int, parentIndex: Int?) throws {
      if let limit = hint.depth, depth > limit { return }

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
          parentIndex: parentIndex,
          viewport: context.viewport
        )
      )

      let children = snapshot.children
      for child in children {
        try walk(child, depth: depth + 1, parentIndex: currentIndex)
      }
    }

    try walk(context.rootSnapshot, depth: 0, parentIndex: nil)
    return SnapshotAcquisition(
      hint: hint,
      nodes: nodes,
      truncated: false,
      effectiveDepth: nil,
      viewport: context.viewport
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
    if hint.depth == 0 {
      return SnapshotAcquisition(
        hint: hint,
        nodes: nodes,
        truncated: false,
        effectiveDepth: nil,
        viewport: .infinite
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
      guard let node = flatSnapshotNode(
        element: element,
        index: 0,
        parentIndex: 0,
        viewport: viewport
      ) else {
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
      viewport: viewport
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
  ///   - if the `onAbandoned`/`onDrained` retain/release hooks were dropped, the timeout would
  ///     still fire, but the busy/penalty accounting and the drain assertion would not hold.
  ///
  /// The drain assertion is synchronized on the *real* release rather than raced: after
  /// signaling the probe to finish, the background queue polls `hasAbandonedTreeCapture()`
  /// (bounded) and only then fulfills `drained`, which the test `wait(for:timeout:)`s on before
  /// asserting `.idle`/`hasAbandonedTreeCapture() == false` below -- so a slow drain fails that
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
      box.hadAbandonedCaptureBeforeDrain = self.hasAbandonedTreeCapture()
      box.wasPenalizedBeforeDrain = self.isSnapshotXCTestChannelPenalized(bundleId: self.currentBundleId)

      // 2) `box.payload` above was already produced -- through the capture plan's recovery
      // tiers -- while the probe is still blocked on `probeReleaseGate`, i.e. recovered before
      // drain, not queued behind it.
      completion.fulfill()

      // 3) Only now let the abandoned probe finish, then block this queue (never the test's
      // main-thread wait) on the *real* drain signal -- `onDrained`'s
      // `releaseAbandonedXCTestChannelWork` -- bounded so a revert that never drains fulfills
      // `drained` anyway and lets the assertions below report the regression explicitly instead
      // of just timing out.
      probeReleaseGate.signal()
      let drainDeadline = Date().addingTimeInterval(5)
      while self.hasAbandonedTreeCapture(), Date() < drainDeadline {
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
      hasAbandonedTreeCapture(),
      "onDrained must release the abandoned XCTest channel work for \(entryPointName)"
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
    let recovered = Response(ok: false, error: ErrorPayload(message: "target is not available"))

    setAbandonedXCTestWork(1)
    defer { setAbandonedXCTestWork(0) }
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

    setAbandonedXCTestWork(0)
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

  private func setAbandonedXCTestWork(_ count: Int) {
    treeCaptureLock.lock(); abandonedTreeCaptureCount = count; treeCaptureLock.unlock()
    mainThreadWorkLock.lock()
    abandonedMainThreadWorkCount = count
    abandonedMainThreadWorkSince = count > 0 ? Date(timeIntervalSinceNow: -1) : nil
    mainThreadWorkLock.unlock()
  }
#endif

  private func interactiveRootNode(rect: CGRect) -> RawAXNode {
    RawAXNode(
      index: 0,
      type: "Application",
      label: nil,
      identifier: nil,
      value: nil,
      rect: snapshotRect(from: rect),
      enabled: true,
      focused: nil,
      selected: nil,
      hittable: false,
      depth: 0,
      parentIndex: nil,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }

  private func interactiveRootFrame(for candidates: [RawAXNode]) -> CGRect {
    guard !candidates.isEmpty else {
      return .zero
    }
    let maxX = candidates.map { CGFloat($0.rect.x + $0.rect.width) }.max() ?? 0
    let maxY = candidates.map { CGFloat($0.rect.y + $0.rect.height) }.max() ?? 0
    return CGRect(x: 0, y: 0, width: max(1, maxX), height: max(1, maxY))
  }

  func snapshotRect(from frame: CGRect) -> SnapshotRect {
    return SnapshotRect(
      x: Double(frame.origin.x),
      y: Double(frame.origin.y),
      width: Double(frame.size.width),
      height: Double(frame.size.height)
    )
  }

  // MARK: - Snapshot Filtering

  func makeSnapshotTraversalContext(
    app: XCUIApplication,
    hint: CaptureHint,
    captureDeadline: Date = .distantFuture,
    treeCaptureSliceBudgetOverride: TimeInterval? = nil
  ) throws -> SnapshotTraversalContext? {
    let viewport = try runMainThreadWork(
      timeout: min(1.0, max(0.1, captureDeadline.timeIntervalSinceNow)),
      timeoutError: snapshotMainThreadTimeoutError("preparing tree snapshot")
    ) {
      self.safeSnapshotViewport(app: app)
    }

    let treeSliceBudget = treeCaptureSliceBudgetOverride ?? treeCaptureSliceBudget
    let slice = min(treeSliceBudget, max(0.5, captureDeadline.timeIntervalSinceNow))
    guard let rootSnapshot = try captureSnapshotRootBounded(app, sliceSeconds: slice) else {
      return nil
    }

    return SnapshotTraversalContext(
      queryRoot: app,
      rootSnapshot: rootSnapshot,
      viewport: viewport,
      maxDepth: hint.depth ?? Int.max
    )
  }

  static let xCTestSnapshotTimeoutCode = "IOS_TREE_CAPTURE_TIMEOUT"

  func hasAbandonedTreeCapture() -> Bool {
    treeCaptureLock.lock()
    defer { treeCaptureLock.unlock() }
    return abandonedTreeCaptureCount > 0
  }

  /// The watchdog abandoned one unit of XCTest main-thread capture work that is still draining on
  /// main; XCTest-backed snapshot tiers skip (`hasAbandonedTreeCapture`) until a matching release.
  func retainAbandonedXCTestChannelWork() {
    treeCaptureLock.lock()
    abandonedTreeCaptureCount += 1
    treeCaptureLock.unlock()
  }

  func releaseAbandonedXCTestChannelWork() {
    treeCaptureLock.lock()
    abandonedTreeCaptureCount -= 1
    treeCaptureLock.unlock()
  }

  /// Runs the blocking tree-snapshot XPC on the main thread bounded by `sliceSeconds`. On
  /// timeout the XPC keeps running on main (it cannot be cancelled); the capture is marked
  /// abandoned so plans avoid XCTest-backed tiers until it drains, the tree backend is penalized
  /// for this bundle, and the plan moves to the platform's independent recovery tier when one
  /// exists (#1105/#1122).
  private func captureSnapshotRootBounded(
    _ element: XCUIElement,
    sliceSeconds: TimeInterval
  ) throws -> XCUIElementSnapshot? {
    if Thread.isMainThread {
      return try captureSnapshotRoot(element)
    }
    return try runMainThreadWork(
      timeout: sliceSeconds,
      timeoutError: treeCaptureTimeoutError(sliceSeconds: sliceSeconds),
      onAbandoned: {
        self.retainAbandonedXCTestChannelWork()
        NSLog("AGENT_DEVICE_RUNNER_TREE_CAPTURE_SLICE_TIMEOUT slice=%.1f", sliceSeconds)
        self.penalizeSnapshotXCTestChannel(
          bundleId: self.currentBundleId,
          reason: "tree_capture_slice_timeout"
        )
      },
      onDrained: {
        self.releaseAbandonedXCTestChannelWork()
        NSLog("AGENT_DEVICE_RUNNER_TREE_CAPTURE_DRAINED")
      }
    ) {
      try self.captureSnapshotRoot(element)
    }
  }

  private func treeCaptureTimeoutError(sliceSeconds: TimeInterval) -> () -> Error {
    {
      SnapshotCaptureFailure(
        code: Self.xCTestSnapshotTimeoutCode,
        message: "the XCTest tree capture exceeded its \(Int(sliceSeconds))s time slice",
        hint: "The capture plan will avoid or tightly bound XCTest-backed snapshot tiers on this screen."
      )
    }
  }

  func snapshotMainThreadTimeoutError(_ operation: String) -> () -> Error {
    {
      SnapshotCaptureFailure(
        code: Self.xCTestSnapshotTimeoutCode,
        message: "timed out while \(operation) on the XCTest main thread",
        hint: "The capture plan will skip XCTest-backed snapshot tiers while the previous main-thread work drains."
      )
    }
  }

  private func captureSnapshotRoot(_ element: XCUIElement) throws -> XCUIElementSnapshot? {
    var rootSnapshot: XCUIElementSnapshot?
    var swiftErrorMessage: String?
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      do {
        rootSnapshot = try element.snapshot()
      } catch {
        swiftErrorMessage = describeSnapshotError(error)
      }
    })

    if let rootSnapshot {
      return rootSnapshot
    }
    let message = exceptionMessage ?? swiftErrorMessage ?? "snapshot returned no root"
    if Self.isAxIllegalArgument(message) {
      throw axSnapshotFailure(message)
    }
    return nil
  }

  func safeSnapshotViewport(app: XCUIApplication) -> CGRect {
    safely("SNAPSHOT_VIEWPORT", CGRect.infinite) { snapshotViewport(app: app) }
  }

  private func describeSnapshotError(_ error: Error) -> String {
    let localized = error.localizedDescription
    let debug = String(describing: error)
    if localized.isEmpty { return debug }
    if debug == localized { return localized }
    return "\(localized) (\(debug))"
  }

  private func axSnapshotFailure(_ message: String) -> SnapshotCaptureFailure {
    let detail = message.trimmingCharacters(in: .whitespacesAndNewlines)
    let failureMessage: String
    if detail.isEmpty {
      failureMessage = Self.axSnapshotFailureMessage
    } else {
      failureMessage = "\(Self.axSnapshotFailureMessage) \(detail)"
    }
    return SnapshotCaptureFailure(
      code: Self.axSnapshotErrorCode,
      message: failureMessage,
      hint: Self.axSnapshotHint
    )
  }

  private static func isAxIllegalArgument(_ message: String) -> Bool {
    let normalized = message.lowercased()
    return normalized.contains("kaxerrorillegalargument")
      || (normalized.contains("illegal argument") && normalized.contains("snapshot"))
  }

  static func isAxSnapshotFailure(_ failure: SnapshotCaptureFailure) -> Bool {
    failure.code == Self.axSnapshotErrorCode || isAxIllegalArgument(failure.message)
  }

  private func evaluateSnapshot(_ snapshot: XCUIElementSnapshot) -> SnapshotEvaluation {
    let label = aggregatedLabel(for: snapshot) ?? snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = snapshot.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    let valueText = snapshotValueText(snapshot)
    return SnapshotEvaluation(
      label: label,
      identifier: identifier,
      valueText: valueText,
      focused: snapshotHasFocus(snapshot),
      selected: snapshotIsSelected(snapshot)
    )
  }

  private func makeSnapshotNode(
    snapshot: XCUIElementSnapshot,
    evaluation: SnapshotEvaluation,
    depth: Int,
    index: Int,
    parentIndex: Int?,
    viewport: CGRect
  ) -> RawAXNode {
    return RawAXNode(
      index: index,
      type: elementTypeName(snapshot.elementType),
      label: evaluation.label.isEmpty ? nil : evaluation.label,
      identifier: evaluation.identifier.isEmpty ? nil : evaluation.identifier,
      value: evaluation.valueText,
      rect: snapshotRect(from: snapshot.frame),
      enabled: snapshot.isEnabled,
      focused: evaluation.focused ? true : nil,
      selected: evaluation.selected ? true : nil,
      hittable: parentIndex != nil && SnapshotGeometry.isGeometricallyActionable(
        enabled: snapshot.isEnabled,
        frame: snapshot.frame,
        viewport: viewport
      ),
      depth: depth,
      parentIndex: parentIndex,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }

  private func snapshotValueText(_ snapshot: XCUIElementSnapshot) -> String? {
    guard let value = snapshot.value else { return nil }
    let text = String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  private func snapshotViewport(app: XCUIApplication) -> CGRect {
    let appFrame = app.frame
    if !appFrame.isNull && !appFrame.isEmpty {
      return appFrame
    }
    return .infinite
  }

  static func snapshotTraversalIdentity(
    elementType: XCUIElement.ElementType,
    label: String,
    identifier: String,
    frame: CGRect
  ) -> String {
    #if os(iOS)
    "\(elementType)-\(label)-\(identifier)-\(frame.origin.x)-\(frame.origin.y)-\(frame.width)-\(frame.height)"
    #else
    return "\(elementType)-\(label)-\(identifier)-\(frame.origin.x)-\(frame.origin.y)"
    #endif
  }

  private func aggregatedLabel(for snapshot: XCUIElementSnapshot, depth: Int = 0) -> String? {
    if depth > 4 { return nil }
    let text = snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty { return text }
    if let valueText = snapshotValueText(snapshot) { return valueText }
    for child in snapshot.children {
      if let childLabel = aggregatedLabel(for: child, depth: depth + 1) {
        return childLabel
      }
    }
    return nil
  }

  private func appendCollapsedTabFallbackNodes(
    to nodes: inout [RawAXNode],
    containerSnapshot: XCUIElementSnapshot,
    resolveElements: () -> [XCUIElement],
    depth: Int,
    parentIndex: Int,
    viewport: CGRect
  ) {
    let fallbackNodes = collapsedTabFallbackNodes(
      for: containerSnapshot,
      resolveElements: resolveElements,
      startingIndex: nodes.count,
      depth: depth,
      parentIndex: parentIndex,
      viewport: viewport
    )
    nodes.append(contentsOf: fallbackNodes)
  }

  private func collapsedTabFallbackNodes(
    for containerSnapshot: XCUIElementSnapshot,
    resolveElements: () -> [XCUIElement],
    startingIndex: Int,
    depth: Int,
    parentIndex: Int,
    viewport: CGRect
  ) -> [RawAXNode] {
    if !containerSnapshot.children.isEmpty { return [] }
    guard shouldExpandCollapsedTabContainer(containerSnapshot) else { return [] }
    let containerFrame = containerSnapshot.frame
    if containerFrame.isNull || containerFrame.isEmpty { return [] }

    // Collapsed tab containers should be rare, so a full descendant scan is acceptable once per
    // snapshot as a fallback for XCTest omitting the tab children from the snapshot tree.
    let elements = resolveElements()
    let candidates = elements.compactMap { element in
      collapsedTabCandidateNode(
        element: element,
        containerSnapshot: containerSnapshot,
        containerFrame: containerFrame,
        viewport: viewport
      )
    }
    .sorted { left, right in
      if left.rect.x != right.rect.x {
        return left.rect.x < right.rect.x
      }
      return left.rect.y < right.rect.y
    }

    if candidates.count < 2 { return [] }
    let rowMidpoints = candidates.map { $0.rect.y + ($0.rect.height / 2) }
    let rowSpread = (rowMidpoints.max() ?? 0) - (rowMidpoints.min() ?? 0)
    // Allow modest vertical jitter and short two-row wraps while still rejecting unrelated controls.
    if rowSpread > max(24.0, Double(containerFrame.height) * 0.6) { return [] }

    var seen = Set<String>()
    let uniqueCandidates = candidates.filter { node in
      let key = "\(node.type)-\(node.label ?? "")-\(node.identifier ?? "")-\(node.value ?? "")-\(node.rect.x)-\(node.rect.y)-\(node.rect.width)-\(node.rect.height)"
      if seen.contains(key) { return false }
      seen.insert(key)
      return true
    }
    if uniqueCandidates.count < 2 { return [] }

    return uniqueCandidates.enumerated().map { offset, node in
      RawAXNode(
        index: startingIndex + offset,
        type: node.type,
        label: node.label,
        identifier: node.identifier,
        value: node.value,
        rect: node.rect,
        enabled: node.enabled,
        focused: node.focused,
        selected: node.selected,
        hittable: node.hittable,
        depth: depth,
        parentIndex: parentIndex,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    }
  }

  private func collapsedTabCandidateNode(
    element: XCUIElement,
    containerSnapshot: XCUIElementSnapshot,
    containerFrame: CGRect,
    viewport: CGRect
  ) -> RawAXNode? {
    var node: RawAXNode?
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      if !element.exists { return }
      let elementType = element.elementType
      if !Self.collapsedTabCandidateTypes.contains(elementType) { return }
      let frame = element.frame
      if frame.isNull || frame.isEmpty { return }
      if frame.equalTo(containerFrame) { return }
      let area = max(CGFloat(1), frame.width * frame.height)
      let containerArea = max(CGFloat(1), containerFrame.width * containerFrame.height)
      if area >= containerArea * 0.9 { return }
      let center = CGPoint(x: frame.midX, y: frame.midY)
      if !containerFrame.contains(center) { return }

      let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
      let identifier = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
      let valueText = snapshotValueText(element)
      let hasContent = !label.isEmpty || !identifier.isEmpty || valueText != nil
      if !hasContent { return }
      if sameSemanticElement(
        containerSnapshot: containerSnapshot,
        elementType: elementType,
        label: label,
        identifier: identifier
      ) {
        return
      }

      node = RawAXNode(
        index: 0,
        type: elementTypeName(elementType),
        label: label.isEmpty ? nil : label,
        identifier: identifier.isEmpty ? nil : identifier,
        value: valueText,
        rect: snapshotRect(from: frame),
        enabled: element.isEnabled,
        focused: elementHasFocus(element) ? true : nil,
        selected: element.isSelected ? true : nil,
        hittable: SnapshotGeometry.isGeometricallyActionable(
          enabled: element.isEnabled,
          frame: frame,
          viewport: viewport
        ),
        depth: 0,
        parentIndex: nil,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    })
    if let exceptionMessage {
      NSLog(
        "AGENT_DEVICE_RUNNER_SNAPSHOT_TAB_FALLBACK_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      return nil
    }
    return node
  }

  private func snapshotHasFocus(_ snapshot: XCUIElementSnapshot) -> Bool {
    var focused = false
    _ = RunnerObjCExceptionCatcher.catchException({
      if let value = (snapshot as! NSObject).value(forKey: "hasFocus") as? Bool {
        focused = value
      }
    })
    return focused
  }

  private func snapshotIsSelected(_ snapshot: XCUIElementSnapshot) -> Bool {
    return snapshot.isSelected
  }

  private func shouldExpandCollapsedTabContainer(_ snapshot: XCUIElementSnapshot) -> Bool {
    let frame = snapshot.frame
    if frame.isNull || frame.isEmpty { return false }
    if frame.width < max(CGFloat(160), frame.height * 1.75) { return false }
    switch snapshot.elementType {
    case .tabBar, .segmentedControl, .slider:
      return true
    default:
      return false
    }
  }

  private func snapshotValueText(_ element: XCUIElement) -> String? {
    let text = String(describing: element.value ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  private func sameSemanticElement(
    containerSnapshot: XCUIElementSnapshot,
    elementType: XCUIElement.ElementType,
    label: String,
    identifier: String
  ) -> Bool {
    if containerSnapshot.elementType != elementType { return false }
    let containerLabel = containerSnapshot.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let containerIdentifier = containerSnapshot.identifier
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return containerLabel == label && containerIdentifier == identifier
  }

  private func flatInteractiveElements(
    app: XCUIApplication,
    deadline: Date
  ) -> (elements: [XCUIElement], truncated: Bool) {
    let queries: [XCUIElementQuery] = [
      app.buttons,
      app.links,
      app.textFields,
      app.secureTextFields,
      app.searchFields,
      app.textViews,
      app.switches,
      app.sliders,
      app.segmentedControls,
      app.cells,
      app.collectionViews,
      app.tables,
      app.scrollViews,
      app.pickers,
      app.steppers,
      app.tabBars,
      app.menuItems,
      app.staticTexts,
      app.images
    ]

    var elements: [XCUIElement] = []
    var truncated = false
    for query in queries {
      if Date() >= deadline {
        NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_FLAT_FALLBACK_DEADLINE")
        truncated = true
        break
      }
      let result = snapshotElementsQuery {
        query.allElementsBoundByIndex
      }
      elements.append(contentsOf: result.elements)
      if result.axUnavailable {
        break
      }
    }
    return (elements, truncated)
  }

  private func snapshotElementsQuery(
    _ fetch: () -> [XCUIElement]
  ) -> (elements: [XCUIElement], axUnavailable: Bool) {
    let (elements, exceptionMessage) = catchingObjCException(fallback: [], fetch)
    guard let exceptionMessage else {
      return (elements, false)
    }
    NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_QUERY_IGNORED_EXCEPTION=%@", exceptionMessage)
    if Self.isAxIllegalArgument(exceptionMessage) {
      invalidateCachedTarget(reason: "ax_snapshot_query_unavailable")
      return ([], true)
    }
    return ([], false)
  }

  private func flatSnapshotNode(
    element: XCUIElement,
    index: Int,
    parentIndex: Int?,
    viewport: CGRect
  ) -> RawAXNode? {
    var node: RawAXNode?
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      if !element.exists { return }
      // Declared residue: a flat element query has no hierarchy for geometryless semantics to
      // attach to, so frameless elements are dropped at acquisition rather than presented.
      let frame = element.frame
      if frame.isNull || frame.isEmpty { return }
      let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
      let identifier = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
      let valueText = snapshotValueText(element)
      let elementType = element.elementType
      let enabled = element.isEnabled
      let hittable = SnapshotGeometry.isGeometricallyActionable(
        enabled: enabled,
        frame: frame,
        viewport: viewport
      )

      node = RawAXNode(
        index: index,
        type: elementTypeName(elementType),
        label: label.isEmpty ? nil : label,
        identifier: identifier.isEmpty ? nil : identifier,
        value: valueText,
        rect: snapshotRect(from: frame),
        enabled: enabled,
        focused: elementHasFocus(element) ? true : nil,
        selected: element.isSelected ? true : nil,
        hittable: hittable,
        depth: 1,
        parentIndex: parentIndex,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    })
    if let exceptionMessage {
      NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_FLAT_IGNORED_EXCEPTION=%@", exceptionMessage)
      return nil
    }
    return node
  }

}
