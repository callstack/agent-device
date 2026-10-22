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
    let rootReadStartedAt = Date()
    guard let rootSnapshot = try captureSnapshotRootBounded(app, sliceSeconds: slice) else {
      return nil
    }
    let rootReadDuration = Date().timeIntervalSince(rootReadStartedAt)

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
      rootReadDuration: rootReadDuration,
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

  private func treeCaptureTimeoutError(sliceSeconds: TimeInterval) -> @Sendable () -> Error {
    {
      SnapshotCaptureFailure(
        code: Self.xCTestSnapshotTimeoutCode,
        message: "the XCTest tree capture exceeded its \(Int(sliceSeconds))s time slice",
        hint: "The capture plan will avoid or tightly bound XCTest-backed snapshot tiers on this screen."
      )
    }
  }

  func snapshotMainThreadTimeoutError(_ operation: String) -> @Sendable () -> Error {
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
    let valueText = Self.valueText(snapshot.value)
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

  /// An element's value as the node publishes it; blank reads as no value.
  static func valueText(_ value: Any?) -> String? {
    guard let value else { return nil }
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

  /// The element types whose `placeholderValue` the element sweeps read. On a live `XCUIElement`
  /// every attribute is one more lookup inside the sweep's deadline, so only text entry pays for
  /// it; a snapshot-based producer reads the attribute off the snapshot it already holds.
  static let placeholderElementTypes: Set<XCUIElement.ElementType> = [
    .textField, .secureTextField, .searchField, .textView,
  ]

  func elementPlaceholderText(_ element: XCUIElement, type: XCUIElement.ElementType) -> String? {
    guard Self.placeholderElementTypes.contains(type) else { return nil }
    return placeholderText(element.placeholderValue)
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
    if let valueText = Self.valueText(snapshot.value) { return valueText }
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
    resolveCandidates: () -> [CollapsedTabCandidate],
    depth: Int,
    parentIndex: Int
  ) {
    let fallbackNodes = collapsedTabFallbackNodes(
      for: containerSnapshot,
      resolveCandidates: resolveCandidates,
      startingIndex: nodes.count,
      depth: depth,
      parentIndex: parentIndex
    )
    nodes.append(contentsOf: fallbackNodes)
  }

  /// Every descendant of `root` in its captured snapshot, without `root` itself.
  static func snapshotDescendants(of root: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
    var descendants: [XCUIElementSnapshot] = []
    var stack = Array(root.children.reversed())
    while let snapshot = stack.popLast() {
      descendants.append(snapshot)
      stack.append(contentsOf: snapshot.children.reversed())
    }
    return descendants
  }

  /// One live element a collapsed tab container may adopt, as the matching query's predicate read it.
  struct CollapsedTabCandidate {
    let type: XCUIElement.ElementType
    let frame: CGRect
    let label: String
    let identifier: String
    let valueText: String?
    let enabled: Bool
    let focused: Bool
    let selected: Bool
  }

  /// The live elements any collapsed tab container in this capture may adopt, read in one XCTest
  /// query: `collapsedTabCandidatePredicate` copies each match's attributes while XCTest evaluates
  /// it, so no match costs a further round trip. The query starts only while the time left before
  /// `processingDeadline` covers what this capture's root tree read took; nil means it did not start.
  @MainActor
  func collapsedTabCandidates(
    context: SnapshotTraversalContext,
    processingDeadline: Date
  ) -> [CollapsedTabCandidate]? {
    let containerFrames = Self.snapshotDescendants(of: context.rootSnapshot)
      .filter(isCollapsedTabContainer)
      .map(\.frame)
    var candidates: [CollapsedTabCandidate] = []
    let predicate = Self.collapsedTabCandidatePredicate(containerFrames: containerFrames) { attributes in
      candidates.append(self.collapsedTabCandidate(attributes))
    }
    guard
      Self.xctestQueryCanStart(
        deadline: processingDeadline,
        now: Date(),
        expectedCost: context.rootReadDuration
      )
    else {
      NSLog("AGENT_DEVICE_RUNNER_SNAPSHOT_TAB_FALLBACK_QUERY_NOT_STARTED")
      return nil
    }
    let matches = snapshotElementsQuery {
      context.queryRoot.descendants(matching: .any).matching(predicate).allElementsBoundByIndex
    }.elements
    return matches.isEmpty ? [] : candidates
  }

  private func collapsedTabCandidate(_ attributes: XCUIElementAttributes) -> CollapsedTabCandidate {
    CollapsedTabCandidate(
      type: attributes.elementType,
      frame: attributes.frame,
      label: attributes.label.trimmingCharacters(in: .whitespacesAndNewlines),
      identifier: attributes.identifier.trimmingCharacters(in: .whitespacesAndNewlines),
      valueText: Self.valueText(attributes.value),
      enabled: attributes.isEnabled,
      focused: focusBool(attributes as! NSObject),
      selected: attributes.isSelected
    )
  }

  /// Matches an element some container in `containerFrames` may adopt: it has content
  /// (`hasCollapsedTabContent`) and the type and geometry `isCollapsedTabCandidate` accepts. XCTest
  /// evaluates it against each element's attributes while it resolves the query, and `matched`
  /// receives the attributes of each element it accepts.
  static func collapsedTabCandidatePredicate(
    containerFrames: [CGRect],
    matched: @escaping (XCUIElementAttributes) -> Void
  ) -> NSPredicate {
    NSPredicate { object, _ in
      guard let attributes = object as? XCUIElementAttributes, hasCollapsedTabContent(attributes),
        containerFrames.contains(where: {
          isCollapsedTabCandidate(type: attributes.elementType, frame: attributes.frame, in: $0)
        })
      else {
        return false
      }
      matched(attributes)
      return true
    }
  }

  /// The geometry and type a collapsed tab container's item has: a candidate type, smaller than the
  /// container, and centered inside it.
  static func isCollapsedTabCandidate(
    type: XCUIElement.ElementType,
    frame: CGRect,
    in containerFrame: CGRect
  ) -> Bool {
    guard collapsedTabCandidateTypes.contains(type), !frame.isNull, !frame.isEmpty else {
      return false
    }
    let area = max(CGFloat(1), frame.width * frame.height)
    let containerArea = max(CGFloat(1), containerFrame.width * containerFrame.height)
    return area < containerArea * 0.9 && containerFrame.contains(CGPoint(x: frame.midX, y: frame.midY))
  }

  /// Whether an element names something an agent can address: a label, identifier or value that is
  /// not blank. Candidate types carry no placeholder.
  static func hasCollapsedTabContent(_ attributes: XCUIElementAttributes) -> Bool {
    [attributes.label, attributes.identifier]
      .contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
      || valueText(attributes.value) != nil
  }

  private func collapsedTabFallbackNodes(
    for containerSnapshot: XCUIElementSnapshot,
    resolveCandidates: () -> [CollapsedTabCandidate],
    startingIndex: Int,
    depth: Int,
    parentIndex: Int
  ) -> [RawAXNode] {
    guard isCollapsedTabContainer(containerSnapshot) else { return [] }
    // Candidates are read from live elements, which XCTest reports in the app's own space, and a
    // collapsed tab container sits under the app's own window. `SnapshotGeometrySpace.normalized` keys
    // rotation on ancestry, so these nodes never enter a declared native space and need no special
    // case here; `isCollapsedTabCandidate` compares reported frames to each other.
    let containerFrame = containerSnapshot.frame
    let candidates = resolveCandidates().compactMap { candidate in
      collapsedTabCandidateNode(
        candidate: candidate,
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
      node.reindexed(index: startingIndex + offset, depth: depth, parentIndex: parentIndex)
    }
  }

  private func collapsedTabCandidateNode(
    candidate: CollapsedTabCandidate,
    containerSnapshot: XCUIElementSnapshot,
    containerFrame: CGRect
  ) -> RawAXNode? {
    if !Self.isCollapsedTabCandidate(type: candidate.type, frame: candidate.frame, in: containerFrame) {
      return nil
    }
    if sameSemanticElement(
      containerSnapshot: containerSnapshot,
      elementType: candidate.type,
      label: candidate.label,
      identifier: candidate.identifier
    ) {
      return nil
    }

    // The containment and area rules above compared reported frames with each other; the node
    // joins the tree carrying the frame the platform reported, and normalization places it.
    return RawAXNode(
      index: 0,
      type: elementTypeName(candidate.type),
      label: candidate.label.isEmpty ? nil : candidate.label,
      identifier: candidate.identifier.isEmpty ? nil : candidate.identifier,
      value: candidate.valueText,
      placeholder: nil,
      rect: SnapshotRect(candidate.frame),
      enabled: candidate.enabled,
      focused: candidate.focused ? true : nil,
      selected: candidate.selected ? true : nil,
      hittable: false,
      depth: 0,
      parentIndex: nil,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }

  func snapshotHasFocus(_ snapshot: XCUIElementSnapshot) -> Bool {
    return focusBool(snapshot as! NSObject)
  }

  /// `hasKeyboardFocus` alone: whether the snapshot's element is the one a keyboard types into.
  func snapshotHasKeyboardFocus(_ snapshot: XCUIElementSnapshot) -> Bool {
    return kvcBool(snapshot as! NSObject, forKey: "hasKeyboardFocus")
  }

  /// Either focus is focus. `hasFocus` is the focus engine's answer (tvOS, keyboard navigation);
  /// the field a software keyboard is typing into holds `hasKeyboardFocus` instead, which the
  /// text-entry readiness check already consults. Both an element and its snapshot answer the two
  /// keys through KVC, so one reader serves the XCTest producers (recursive tree, query sweep,
  /// collapsed tabs); a key the object lacks reads as false. The private-AX bridge is not among
  /// them: the AX server declares no keyboard-focus attribute, so it reads `hasFocus` alone.
  func focusBool(_ object: NSObject) -> Bool {
    return kvcBool(object, forKey: "hasKeyboardFocus") || kvcBool(object, forKey: "hasFocus")
  }

  private func kvcBool(_ object: NSObject, forKey key: String) -> Bool {
    var result = false
    _ = RunnerObjCExceptionCatcher.catchException({
      if let value = object.value(forKey: key) as? Bool {
        result = value
      }
    })
    return result
  }

  private func snapshotIsSelected(_ snapshot: XCUIElementSnapshot) -> Bool {
    return snapshot.isSelected
  }

  /// A wide tab bar or segmented control that XCTest reports without children.
  func isCollapsedTabContainer(_ snapshot: XCUIElementSnapshot) -> Bool {
    if !snapshot.children.isEmpty { return false }
    let frame = snapshot.frame
    if frame.isNull || frame.isEmpty { return false }
    if frame.width < max(CGFloat(160), frame.height * 1.75) { return false }
    switch snapshot.elementType {
    case .tabBar, .segmentedControl:
      return true
    default:
      return false
    }
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

  @MainActor
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
  /// finish before `deadline` (`xctestQueryCanStart`). A sweep stopped by the deadline reports
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
      if !xctestQueryCanStart(deadline: deadline, now: now()) {
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

  @MainActor
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
      let valueText = Self.valueText(element.value)
      let elementType = element.elementType
      let enabled = element.isEnabled

      node = RawAXNode(
        index: index,
        type: elementTypeName(elementType),
        label: label.isEmpty ? nil : label,
        identifier: identifier.isEmpty ? nil : identifier,
        value: valueText,
        placeholder: elementPlaceholderText(element, type: elementType),
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
