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
    let flatSnapshots: [XCUIElementSnapshot]
    let snapshotRanges: [ObjectIdentifier: (Int, Int)]
    let maxDepth: Int
  }

  private struct SnapshotEvaluation {
    let label: String
    let identifier: String
    let valueText: String?
    let hittable: Bool
    let focused: Bool
    let selected: Bool
    let visible: Bool
  }

  struct SnapshotCaptureFailure: Error {
    let code: String
    let message: String
    let hint: String
  }

  // MARK: - Snapshot Entry

  func elementTypeName(_ type: XCUIElement.ElementType) -> String {
    switch type {
    case .application: return "Application"
    case .window: return "Window"
    case .button: return "Button"
    case .cell: return "Cell"
    case .staticText: return "StaticText"
    case .textField: return "TextField"
    case .textView: return "TextView"
    case .secureTextField: return "SecureTextField"
    case .switch: return "Switch"
    case .slider: return "Slider"
    case .link: return "Link"
    case .image: return "Image"
    case .navigationBar: return "NavigationBar"
    case .tabBar: return "TabBar"
    case .collectionView: return "CollectionView"
    case .table: return "Table"
    case .scrollView: return "ScrollView"
    case .searchField: return "SearchField"
    case .segmentedControl: return "SegmentedControl"
    case .stepper: return "Stepper"
    case .picker: return "Picker"
    case .checkBox: return "CheckBox"
    case .menuItem: return "MenuItem"
    case .other: return "Other"
    default:
      switch type.rawValue {
      case 19:
        return "Keyboard"
      case 20:
        return "Key"
      case 24:
        return "SearchField"
      default:
        return "Element(\(type.rawValue))"
      }
    }
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

  func snapshotFast(app: XCUIApplication, options: SnapshotOptions) throws -> DataPayload {
    if let blocking = blockingSystemAlertSnapshot() {
      return blocking
    }
    return try runSnapshotCapturePlan(
      Self.regularVisiblePlan,
      app: app,
      options: options,
      terminal: .sparseWithFatalOnAXFailure
    )
  }

  func recursiveTreeSnapshotPayload(
    context: SnapshotTraversalContext,
    options: SnapshotOptions
  ) -> DataPayload {
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

    var nodes: [SnapshotNode] = []
    var hiddenContentHintsByNodeIndex: [Int: (above: Bool, below: Bool)] = [:]
    let rootEvaluation = evaluateSnapshot(context.rootSnapshot, in: context)
    nodes.append(
      makeSnapshotNode(
        snapshot: context.rootSnapshot,
        evaluation: rootEvaluation,
        depth: 0,
        index: 0,
        parentIndex: nil
      )
    )
    if context.maxDepth > 0 {
      appendCollapsedTabFallbackNodes(
        to: &nodes,
        containerSnapshot: context.rootSnapshot,
        resolveElements: collapsedTabDescendants,
        depth: 1,
        parentIndex: 0
      )
    }

    var seen = Set<String>()
    let rootScrollAnchor = scrollContainerAnchor(
      for: context.rootSnapshot,
      visible: rootEvaluation.visible,
      nodeIndex: 0
    )
    var stack: [(XCUIElementSnapshot, Int, Int, Int?, (index: Int, rect: CGRect)?)] =
      context.rootSnapshot.children.map {
        ($0, 1, 1, 0, rootScrollAnchor)
      }

    while let (snapshot, depth, visibleDepth, parentIndex, nearestScrollAnchor) = stack.popLast() {
      if let limit = options.depth, depth > limit { continue }

      let evaluation = evaluateSnapshot(snapshot, in: context)
      let regularVisible = isVisibleInRegularSnapshot(
        snapshot.frame,
        viewport: context.viewport,
        scrollContainerAnchor: nearestScrollAnchor
      )
      if !regularVisible, let nearestScrollAnchor {
        rememberHiddenContentHint(
          for: snapshot.frame,
          relativeTo: nearestScrollAnchor,
          hints: &hiddenContentHintsByNodeIndex
        )
      }
      let include = shouldInclude(
        snapshot: snapshot,
        label: evaluation.label,
        identifier: evaluation.identifier,
        valueText: evaluation.valueText,
        options: options,
        hittable: evaluation.hittable,
        visible: regularVisible,
        regularSnapshot: true
      )

      let key = "\(snapshot.elementType)-\(evaluation.label)-\(evaluation.identifier)-\(snapshot.frame.origin.x)-\(snapshot.frame.origin.y)"
      let isDuplicate = seen.contains(key)
      if !isDuplicate {
        seen.insert(key)
      }

      let currentIndex = include && !isDuplicate ? nodes.count : parentIndex
      if depth < context.maxDepth {
        let nextVisibleDepth = include && !isDuplicate ? visibleDepth + 1 : visibleDepth
        let nextScrollContainerAnchor: (index: Int, rect: CGRect)?
        if include && !isDuplicate {
          nextScrollContainerAnchor =
            scrollContainerAnchor(
              for: snapshot,
              visible: regularVisible,
              nodeIndex: currentIndex
            )
            ?? nearestScrollAnchor
        } else {
          nextScrollContainerAnchor = nearestScrollAnchor
        }
        for child in snapshot.children.reversed() {
          stack.append((child, depth + 1, nextVisibleDepth, currentIndex, nextScrollContainerAnchor))
        }
      }

      if !include || isDuplicate { continue }

      let index = nodes.count
      nodes.append(
        makeSnapshotNode(
          snapshot: snapshot,
          evaluation: evaluation,
          depth: min(context.maxDepth, visibleDepth),
          index: index,
          parentIndex: parentIndex
        )
      )
      if visibleDepth < context.maxDepth {
        appendCollapsedTabFallbackNodes(
          to: &nodes,
          containerSnapshot: snapshot,
          resolveElements: collapsedTabDescendants,
          depth: visibleDepth + 1,
          parentIndex: index
        )
      }

    }

    return DataPayload(
      nodes: applyHiddenContentHints(hiddenContentHintsByNodeIndex, to: nodes),
      truncated: false
    )
  }

  func snapshotRaw(app: XCUIApplication, options: SnapshotOptions) throws -> DataPayload {
    if let blocking = blockingSystemAlertSnapshot() {
      return blocking
    }
    return try runSnapshotCapturePlan(
      Self.rawDiagnosticPlan,
      app: app,
      options: options,
      terminal: .throwOnAXFailure
    )
  }

  func rawTreeSnapshotPayload(
    context: SnapshotTraversalContext,
    options: SnapshotOptions
  ) throws -> DataPayload {
    var nodes: [SnapshotNode] = []

    func walk(_ snapshot: XCUIElementSnapshot, depth: Int, parentIndex: Int?) throws {
      if let limit = options.depth, depth > limit { return }

      let evaluation = evaluateSnapshot(snapshot, in: context)
      let include = shouldInclude(
        snapshot: snapshot,
        label: evaluation.label,
        identifier: evaluation.identifier,
        valueText: evaluation.valueText,
        options: options,
        hittable: evaluation.hittable,
        visible: evaluation.visible
      )
      let currentIndex = include ? nodes.count : parentIndex
      if include {
        if nodes.count >= Self.rawSnapshotMaxNodes {
          throw rawSnapshotTooLargeFailure(nodeCount: nodes.count + 1)
        }
        nodes.append(
          makeSnapshotNode(
            snapshot: snapshot,
            evaluation: evaluation,
            depth: depth,
            index: nodes.count,
            parentIndex: parentIndex
          )
        )
      }

      let children = snapshot.children
      for child in children {
        try walk(child, depth: depth + 1, parentIndex: currentIndex)
      }
    }

    try walk(context.rootSnapshot, depth: 0, parentIndex: nil)
    return DataPayload(nodes: nodes, truncated: false)
  }

  func snapshotFlatInteractive(
    app: XCUIApplication,
    options: SnapshotOptions,
    planDeadline: Date = .distantFuture
  ) -> DataPayload {
    var nodes: [SnapshotNode] = [
      interactiveRootNode(rect: .zero)
    ]
    if options.depth == 0 {
      return DataPayload(nodes: nodes, truncated: false)
    }

    // Bounded by both its own sweep budget and the umbrella capture-plan deadline, so a
    // chained recovery tier can never push the plan past the main-thread watchdog (#1105).
    let sweepDeadline = options.interactiveOnly
      ? Date().addingTimeInterval(Self.flatInteractiveFallbackBudget)
      : Date.distantFuture
    let deadline = min(sweepDeadline, planDeadline)
    let viewport = safeSnapshotViewport(app: app)
    var seen = Set<String>()
    var candidates: [SnapshotNode] = []
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
        viewport: viewport,
        options: options
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
        SnapshotNode(
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
    return DataPayload(nodes: nodes, truncated: truncated)
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
        collapsedLeafIndexes: nil
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
      nodes: [interactiveRootNode(rect: .zero)],
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
#endif

  private func interactiveRootNode(rect: CGRect) -> SnapshotNode {
    SnapshotNode(
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

  private func interactiveRootFrame(for candidates: [SnapshotNode]) -> CGRect {
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

  private func shouldInclude(
    snapshot: XCUIElementSnapshot,
    label: String,
    identifier: String,
    valueText: String?,
    options: SnapshotOptions,
    hittable: Bool,
    visible: Bool,
    regularSnapshot: Bool = false
  ) -> Bool {
    let type = snapshot.elementType
    let hasContent = !label.isEmpty || !identifier.isEmpty || (valueText != nil)
    if options.interactiveOnly {
      if isScrollableContainer(snapshot, visible: visible) { return true }
      #if os(macOS)
        if !visible && type != .application {
          return false
        }
      #endif
      if interactiveTypes.contains(type) { return true }
      if hittable && type != .other { return true }
      if hasContent { return true }
      return false
    }
    if regularSnapshot {
      if type == .application || type == .window { return true }
      return visible
    }
    return true
  }

  private func computedSnapshotHittable(
    _ snapshot: XCUIElementSnapshot,
    viewport: CGRect,
    laterNodes: ArraySlice<XCUIElementSnapshot>
  ) -> Bool {
    guard snapshot.isEnabled else { return false }
    let frame = snapshot.frame
    if frame.isNull || frame.isEmpty { return false }
    let center = CGPoint(x: frame.midX, y: frame.midY)
    if !viewport.contains(center) { return false }
    for node in laterNodes {
      if !isOccludingType(node.elementType) { continue }
      let nodeFrame = node.frame
      if nodeFrame.isNull || nodeFrame.isEmpty { continue }
      if nodeFrame.contains(center) { return false }
    }
    return true
  }

  func makeSnapshotTraversalContext(
    app: XCUIApplication,
    options: SnapshotOptions,
    captureDeadline: Date = .distantFuture
  ) throws -> SnapshotTraversalContext? {
    let (viewport, queryRoot) = try runMainThreadWork(
      command: nil,
      timeout: min(1.0, max(0.1, captureDeadline.timeIntervalSinceNow)),
      timeoutError: snapshotMainThreadTimeoutError("preparing tree snapshot")
    ) {
      (
        self.safeSnapshotViewport(app: app),
        options.scope.flatMap { self.findScopeElement(app: app, scope: $0) } ?? app
      )
    }

    let slice = min(treeCaptureSliceBudget, max(0.5, captureDeadline.timeIntervalSinceNow))
    guard let rootSnapshot = try captureSnapshotRootBounded(queryRoot, sliceSeconds: slice) else {
      return nil
    }

    let (flatSnapshots, snapshotRanges) = flattenedSnapshots(rootSnapshot)
    return SnapshotTraversalContext(
      queryRoot: queryRoot,
      rootSnapshot: rootSnapshot,
      viewport: viewport,
      flatSnapshots: flatSnapshots,
      snapshotRanges: snapshotRanges,
      maxDepth: options.depth ?? Int.max
    )
  }

  static let treeCaptureTimeoutCode = "IOS_TREE_CAPTURE_TIMEOUT"

  func hasAbandonedTreeCapture() -> Bool {
    treeCaptureLock.lock()
    defer { treeCaptureLock.unlock() }
    return abandonedTreeCaptureCount > 0
  }

  /// Runs the blocking tree-snapshot XPC on the main thread bounded by `sliceSeconds`. On
  /// timeout the XPC keeps running on main (it cannot be cancelled); the capture is marked
  /// abandoned so plans avoid XCTest-backed tiers until it drains, the tree backend is penalized
  /// for this bundle, and the plan moves on to the private AX backend (#1105/#1122).
  private func captureSnapshotRootBounded(
    _ element: XCUIElement,
    sliceSeconds: TimeInterval
  ) throws -> XCUIElementSnapshot? {
    if Thread.isMainThread {
      return try captureSnapshotRoot(element)
    }
    return try runMainThreadWork(
      command: nil,
      timeout: sliceSeconds,
      timeoutError: treeCaptureTimeoutError(sliceSeconds: sliceSeconds),
      onAbandoned: {
        self.treeCaptureLock.lock()
        self.abandonedTreeCaptureCount += 1
        self.treeCaptureLock.unlock()
        NSLog("AGENT_DEVICE_RUNNER_TREE_CAPTURE_SLICE_TIMEOUT slice=%.1f", sliceSeconds)
        self.penalizeSnapshotTreeBackend(
          bundleId: self.currentBundleId,
          reason: "tree_capture_slice_timeout"
        )
      },
      onDrained: {
        self.treeCaptureLock.lock()
        self.abandonedTreeCaptureCount -= 1
        self.treeCaptureLock.unlock()
        NSLog("AGENT_DEVICE_RUNNER_TREE_CAPTURE_DRAINED")
      }
    ) {
      try self.captureSnapshotRoot(element)
    }
  }

  private func treeCaptureTimeoutError(sliceSeconds: TimeInterval) -> () -> Error {
    {
      SnapshotCaptureFailure(
        code: Self.treeCaptureTimeoutCode,
        message: "the XCTest tree capture exceeded its \(Int(sliceSeconds))s time slice",
        hint: "The capture plan recovers through the private AX backend on this screen."
      )
    }
  }

  func snapshotMainThreadTimeoutError(_ operation: String) -> () -> Error {
    {
      SnapshotCaptureFailure(
        code: Self.treeCaptureTimeoutCode,
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

  private func evaluateSnapshot(
    _ snapshot: XCUIElementSnapshot,
    in context: SnapshotTraversalContext
  ) -> SnapshotEvaluation {
    let label = aggregatedLabel(for: snapshot) ?? snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = snapshot.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    let valueText = snapshotValueText(snapshot)
    let laterNodes = laterSnapshots(
      for: snapshot,
      in: context.flatSnapshots,
      ranges: context.snapshotRanges
    )
    return SnapshotEvaluation(
      label: label,
      identifier: identifier,
      valueText: valueText,
      hittable: computedSnapshotHittable(snapshot, viewport: context.viewport, laterNodes: laterNodes),
      focused: snapshotHasFocus(snapshot),
      selected: snapshotIsSelected(snapshot),
      visible: isVisibleInViewport(snapshot.frame, context.viewport)
    )
  }

  private func makeSnapshotNode(
    snapshot: XCUIElementSnapshot,
    evaluation: SnapshotEvaluation,
    depth: Int,
    index: Int,
    parentIndex: Int?
  ) -> SnapshotNode {
    return SnapshotNode(
      index: index,
      type: elementTypeName(snapshot.elementType),
      label: evaluation.label.isEmpty ? nil : evaluation.label,
      identifier: evaluation.identifier.isEmpty ? nil : evaluation.identifier,
      value: evaluation.valueText,
      rect: snapshotRect(from: snapshot.frame),
      enabled: snapshot.isEnabled,
      focused: evaluation.focused ? true : nil,
      selected: evaluation.selected ? true : nil,
      hittable: evaluation.hittable,
      depth: depth,
      parentIndex: parentIndex,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }

  private func isOccludingType(_ type: XCUIElement.ElementType) -> Bool {
    switch type {
    case .application, .window:
      return false
    default:
      return true
    }
  }

  private func flattenedSnapshots(
    _ root: XCUIElementSnapshot
  ) -> ([XCUIElementSnapshot], [ObjectIdentifier: (Int, Int)]) {
    var ordered: [XCUIElementSnapshot] = []
    var ranges: [ObjectIdentifier: (Int, Int)] = [:]

    @discardableResult
    func visit(_ snapshot: XCUIElementSnapshot) -> Int {
      let start = ordered.count
      ordered.append(snapshot)
      var end = start
      for child in snapshot.children {
        end = max(end, visit(child))
      }
      ranges[ObjectIdentifier(snapshot)] = (start, end)
      return end
    }

    _ = visit(root)
    return (ordered, ranges)
  }

  private func laterSnapshots(
    for snapshot: XCUIElementSnapshot,
    in ordered: [XCUIElementSnapshot],
    ranges: [ObjectIdentifier: (Int, Int)]
  ) -> ArraySlice<XCUIElementSnapshot> {
    guard let (_, subtreeEnd) = ranges[ObjectIdentifier(snapshot)] else {
      return ordered.suffix(from: ordered.count)
    }
    let nextIndex = subtreeEnd + 1
    if nextIndex >= ordered.count {
      return ordered.suffix(from: ordered.count)
    }
    return ordered.suffix(from: nextIndex)
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

  func isVisibleInViewport(_ rect: CGRect, _ viewport: CGRect) -> Bool {
    if rect.isNull || rect.isEmpty { return false }
    return rect.intersects(viewport)
  }

  private func isVisibleInRegularSnapshot(
    _ rect: CGRect,
    viewport: CGRect,
    scrollContainerAnchor: (index: Int, rect: CGRect)?
  ) -> Bool {
    if !isVisibleInViewport(rect, viewport) { return false }
    guard let scrollContainerAnchor else { return true }
    return isVisibleInViewport(rect, scrollContainerAnchor.rect)
  }

  private func appendCollapsedTabFallbackNodes(
    to nodes: inout [SnapshotNode],
    containerSnapshot: XCUIElementSnapshot,
    resolveElements: () -> [XCUIElement],
    depth: Int,
    parentIndex: Int
  ) {
    let fallbackNodes = collapsedTabFallbackNodes(
      for: containerSnapshot,
      resolveElements: resolveElements,
      startingIndex: nodes.count,
      depth: depth,
      parentIndex: parentIndex
    )
    nodes.append(contentsOf: fallbackNodes)
  }

  private func scrollContainerAnchor(
    for snapshot: XCUIElementSnapshot,
    visible: Bool,
    nodeIndex: Int?
  ) -> (index: Int, rect: CGRect)? {
    guard let nodeIndex else { return nil }
    if !isScrollableContainer(snapshot, visible: visible) { return nil }
    return (nodeIndex, snapshot.frame)
  }

  private func rememberHiddenContentHint(
    for frame: CGRect,
    relativeTo scrollContainerAnchor: (index: Int, rect: CGRect),
    hints: inout [Int: (above: Bool, below: Bool)]
  ) {
    if frame.isNull || frame.isEmpty { return }
    var hint = hints[scrollContainerAnchor.index] ?? (above: false, below: false)
    if frame.maxY <= scrollContainerAnchor.rect.minY {
      hint.above = true
    } else if frame.minY >= scrollContainerAnchor.rect.maxY {
      hint.below = true
    } else {
      return
    }
    hints[scrollContainerAnchor.index] = hint
  }

  private func applyHiddenContentHints(
    _ hints: [Int: (above: Bool, below: Bool)],
    to nodes: [SnapshotNode]
  ) -> [SnapshotNode] {
    if hints.isEmpty { return nodes }
    return nodes.map { node in
      guard let hint = hints[node.index] else { return node }
      let hiddenContentAbove: Bool? = (node.hiddenContentAbove == true || hint.above) ? true : nil
      let hiddenContentBelow: Bool? = (node.hiddenContentBelow == true || hint.below) ? true : nil
      return SnapshotNode(
        index: node.index,
        type: node.type,
        label: node.label,
        identifier: node.identifier,
        value: node.value,
        rect: node.rect,
        enabled: node.enabled,
        focused: node.focused,
        selected: node.selected,
        hittable: node.hittable,
        depth: node.depth,
        parentIndex: node.parentIndex,
        hiddenContentAbove: hiddenContentAbove,
        hiddenContentBelow: hiddenContentBelow
      )
    }
  }

  private func collapsedTabFallbackNodes(
    for containerSnapshot: XCUIElementSnapshot,
    resolveElements: () -> [XCUIElement],
    startingIndex: Int,
    depth: Int,
    parentIndex: Int
  ) -> [SnapshotNode] {
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
        containerFrame: containerFrame
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
      SnapshotNode(
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
    containerFrame: CGRect
  ) -> SnapshotNode? {
    var node: SnapshotNode?
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

      node = SnapshotNode(
        index: 0,
        type: elementTypeName(elementType),
        label: label.isEmpty ? nil : label,
        identifier: identifier.isEmpty ? nil : identifier,
        value: valueText,
        rect: snapshotRect(from: frame),
        enabled: element.isEnabled,
        focused: elementHasFocus(element) ? true : nil,
        selected: element.isSelected ? true : nil,
        hittable: element.isHittable,
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
    viewport: CGRect,
    options: SnapshotOptions
  ) -> SnapshotNode? {
    var node: SnapshotNode?
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      if !element.exists { return }
      let frame = element.frame
      if frame.isNull || frame.isEmpty { return }
      let visible = isVisibleInViewport(frame, viewport)
      if options.interactiveOnly && !visible { return }
      #if os(macOS)
        if !visible { return }
      #endif
      let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
      let identifier = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
      let valueText = snapshotValueText(element)
      let elementType = element.elementType
      let enabled = element.isEnabled
      let hittable = visible && enabled && element.isHittable
      let filterNode = FlatSnapshotFilterNode(
        isRoot: false,
        label: label,
        identifier: identifier,
        valueText: valueText,
        visible: visible
      )
      if !flatSnapshotFilterDecision(filterNode, options: options, insideMatchedScope: false).include {
        return
      }

      node = SnapshotNode(
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

  private func isScrollableContainer(_ snapshot: XCUIElementSnapshot, visible: Bool) -> Bool {
    if !visible { return false }
    if !Self.scrollContainerTypes.contains(snapshot.elementType) { return false }
    return !snapshot.children.isEmpty
  }
}
