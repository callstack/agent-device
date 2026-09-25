import XCTest
import AgentDeviceSnapshotPresentation

extension RunnerTests {
  func interactiveRootNode(rect: CGRect) -> RawAXNode {
    RawAXNode(
      index: 0,
      type: "Application",
      label: nil,
      identifier: nil,
      value: nil,
      rect: SnapshotRect(rect),
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

  func interactiveRootFrame(for candidates: [RawAXNode]) -> CGRect {
    guard !candidates.isEmpty else {
      return .zero
    }
    let maxX = candidates.map { CGFloat($0.rect.x + $0.rect.width) }.max() ?? 0
    let maxY = candidates.map { CGFloat($0.rect.y + $0.rect.height) }.max() ?? 0
    return CGRect(x: 0, y: 0, width: max(1, maxX), height: max(1, maxY))
  }

  // MARK: - Snapshot Filtering

  func makeSnapshotTraversalContext(
    app: XCUIApplication,
    hint: CaptureHint,
    captureDeadline: Date = .distantFuture,
    treeCaptureSliceBudgetOverride: TimeInterval? = nil
  ) throws -> SnapshotTraversalContext? {
    let treeSliceBudget = treeCaptureSliceBudgetOverride ?? treeCaptureSliceBudget
    let slice = min(treeSliceBudget, max(0.5, captureDeadline.timeIntervalSinceNow))
    guard let rootSnapshot = try captureSnapshotRootBounded(app, sliceSeconds: slice) else {
      return nil
    }

    // The viewport and the interface orientation are one hop: geometry that arrives in the device's
    // native space can only be placed relative to the app's own frame and rotation, and asking for
    // the pair twice would read them at two different moments of a rotation.
    let viewport = try runMainThreadWork(
      "snapshot_viewport",
      timeout: min(1.0, max(0.1, captureDeadline.timeIntervalSinceNow)),
      timeoutError: snapshotMainThreadTimeoutError("reading snapshot viewport")
    ) {
      self.safeSnapshotViewport(app: app, readingOrientation: true)
    }
    // Read after the tree, so the band is never older than the tree it will be compared against: a
    // keyboard that appeared while the tree was being captured would otherwise publish `absent`
    // beside key nodes that the tap guard would then have to trust less than the absence (#2660).
    // It keeps its own hop and slice rather than joining the geometry pair above, because a keyboard
    // this capture cannot measure must cost the fact and not the tree tier behind it.
    let keyboardBand = captureKeyboardBandFact(app: app, deadline: captureDeadline)

    return SnapshotTraversalContext(
      queryRoot: app,
      rootSnapshot: rootSnapshot,
      viewport: viewport,
      keyboardBand: keyboardBand
    )
  }

  static let xCTestSnapshotTimeoutCode = "IOS_TREE_CAPTURE_TIMEOUT"

  /// Runs the blocking tree-snapshot XPC on the main thread bounded by `sliceSeconds`. On
  /// timeout the XPC keeps running on main (it cannot be cancelled); the capture is marked
  /// abandoned so plans avoid XCTest-backed tiers until it drains, the timed-out attempt
  /// penalizes the tree backend for this bundle (unless the fresh-process warmup exemption
  /// applies), and the plan moves to the platform's independent recovery tier when one exists
  /// (#1105/#1122).
  private func captureSnapshotRootBounded(
    _ element: XCUIElement,
    sliceSeconds: TimeInterval
  ) throws -> XCUIElementSnapshot? {
    if Thread.isMainThread {
      return try captureSnapshotRoot(element)
    }
    return try runMainThreadWork(
      "tree_capture",
      timeout: sliceSeconds,
      timeoutError: treeCaptureTimeoutError(sliceSeconds: sliceSeconds)
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

  /// The viewport as a declared fact; a read that raises is `.missing(reason: .notProvided)` (#2891).
  /// `readingOrientation` reads the interface orientation in the same hop, for tiers whose frames can
  /// arrive in the device's native space; without it the viewport cannot anchor a rotation.
  func safeSnapshotViewport(app: XCUIApplication, readingOrientation: Bool) -> SnapshotViewport {
    safely("SNAPSHOT_VIEWPORT", .missing(reason: .notProvided)) {
      .reported(
        box: snapshotAppFrame(app: app),
        interfaceOrientation: readingOrientation
          ? capturedInterfaceOrientation(app: app)
          : RunnerInterfaceOrientation.unknown
      )
    }
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

  func evaluateSnapshot(_ snapshot: XCUIElementSnapshot) -> SnapshotEvaluation {
    let label = aggregatedLabel(for: snapshot) ?? snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = snapshot.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    let valueText = snapshotValueText(snapshot)
    return SnapshotEvaluation(
      label: label,
      identifier: identifier,
      valueText: valueText,
      placeholder: placeholderText(snapshot.placeholderValue),
      focused: snapshotHasFocus(snapshot),
      selected: snapshotIsSelected(snapshot)
    )
  }

  func makeSnapshotNode(
    snapshot: XCUIElementSnapshot,
    evaluation: SnapshotEvaluation,
    depth: Int,
    index: Int,
    parentIndex: Int?
  ) -> RawAXNode {
    // Acquisition carries the frame the platform reported; `SnapshotGeometrySpace.normalized` turns
    // it into the app's orientation space and recomputes `hittable` from that one pass (#2661).
    return RawAXNode(
      index: index,
      type: elementTypeName(snapshot.elementType),
      label: evaluation.label.isEmpty ? nil : evaluation.label,
      identifier: evaluation.identifier.isEmpty ? nil : evaluation.identifier,
      value: evaluation.valueText,
      placeholder: evaluation.placeholder,
      rect: SnapshotRect(snapshot.frame),
      enabled: snapshot.isEnabled,
      focused: evaluation.focused ? true : nil,
      selected: evaluation.selected ? true : nil,
      hittable: false,
      depth: depth,
      parentIndex: parentIndex,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }

  /// The app's own interface orientation: the fact that names which way the device's native space is
  /// turned from the space the capture publishes. Unreadable or unnamed means no rotation.
  func capturedInterfaceOrientation(app: XCUIApplication) -> Int {
    safely("SNAPSHOT_INTERFACE_ORIENTATION", RunnerInterfaceOrientation.unknown) {
      Int(RunnerSynthesizedGesture.interfaceOrientation(forApplication: app))
    }
  }

  private func snapshotValueText(_ snapshot: XCUIElementSnapshot) -> String? {
    guard let value = snapshot.value else { return nil }
    let text = String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  /// The placeholder as the node publishes it: XCTest answers `placeholderValue` for a text field
  /// whether or not the field is empty, and an empty string for everything else, which reads as
  /// no placeholder. The private-AX bridge asks the AX server the same attribute.
  func placeholderText(_ placeholderValue: String?) -> String? {
    let text = placeholderValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return text.isEmpty ? nil : text
  }

  private func snapshotAppFrame(app: XCUIApplication) -> CGRect {
#if os(iOS)
    return onScreenWindowFrame(app: app)
#else
    return app.frame
#endif
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

  func appendCollapsedTabFallbackNodes(
    to nodes: inout [RawAXNode],
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

  private func collapsedTabFallbackNodes(
    for containerSnapshot: XCUIElementSnapshot,
    resolveElements: () -> [XCUIElement],
    startingIndex: Int,
    depth: Int,
    parentIndex: Int
  ) -> [RawAXNode] {
    if !containerSnapshot.children.isEmpty { return [] }
    // This fallback reads live element frames, which XCTest reports in the app's own space, and a
    // collapsed tab container sits under the app's own window. `SnapshotGeometrySpace.normalized`
    // keys rotation on ancestry, so these nodes never enter a declared native space and need no
    // special case here; the containment and area rules below compare reported frames to each other.
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
      RawAXNode(
        index: startingIndex + offset,
        type: node.type,
        label: node.label,
        identifier: node.identifier,
        value: node.value,
        placeholder: node.placeholder,
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
      let placeholder = placeholderText(element.placeholderValue)
      let hasContent = !label.isEmpty || !identifier.isEmpty || valueText != nil || placeholder != nil
      if !hasContent { return }
      if sameSemanticElement(
        containerSnapshot: containerSnapshot,
        elementType: elementType,
        label: label,
        identifier: identifier
      ) {
        return
      }

      // The containment and area rules above compared reported frames with each other; the node
      // joins the tree carrying the frame the platform reported, and normalization places it.
      node = RawAXNode(
        index: 0,
        type: elementTypeName(elementType),
        label: label.isEmpty ? nil : label,
        identifier: identifier.isEmpty ? nil : identifier,
        value: valueText,
        placeholder: placeholder,
        rect: SnapshotRect(frame),
        enabled: element.isEnabled,
        focused: elementHasFocus(element) ? true : nil,
        selected: element.isSelected ? true : nil,
        hittable: false,
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

  func flatInteractiveElements(
    app: XCUIApplication,
    deadline: Date
  ) -> (elements: [XCUIElement], outcome: SnapshotTierOutcome) {
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

    return Self.runFlatInteractiveQueries(queries, deadline: deadline) { query in
      self.snapshotElementsQuery {
        query.allElementsBoundByIndex
      }
    }
  }

  /// Runs sweep queries in order until one reports AX unavailable, or until the next one could not
  /// finish before `deadline` (`querySweepCanStartQuery`). A sweep stopped by the deadline reports
  /// `.deadlineExhausted` rather than a truncation flag: what it collected is a partial tree, and
  /// only the caller that owns the tier decides whether that counts as an answer (#2781).
  static func runFlatInteractiveQueries<Query, Element>(
    _ queries: [Query],
    deadline: Date,
    now: () -> Date = { Date() },
    run: (Query) -> (elements: [Element], axUnavailable: Bool)
  ) -> (elements: [Element], outcome: SnapshotTierOutcome) {
    var elements: [Element] = []
    for query in queries {
      if !querySweepCanStartQuery(deadline: deadline, now: now()) {
        NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_FLAT_FALLBACK_DEADLINE")
        return (elements, .deadlineExhausted)
      }
      let result = run(query)
      elements.append(contentsOf: result.elements)
      if result.axUnavailable {
        break
      }
    }
    return (elements, .completed)
  }

  func snapshotElementsQuery(
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

  func flatSnapshotNode(
    element: XCUIElement,
    index: Int,
    parentIndex: Int?
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

      node = RawAXNode(
        index: index,
        type: elementTypeName(elementType),
        label: label.isEmpty ? nil : label,
        identifier: identifier.isEmpty ? nil : identifier,
        value: valueText,
        placeholder: placeholderText(element.placeholderValue),
        rect: SnapshotRect(frame),
        enabled: enabled,
        focused: elementHasFocus(element) ? true : nil,
        selected: element.isSelected ? true : nil,
        hittable: false,
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
