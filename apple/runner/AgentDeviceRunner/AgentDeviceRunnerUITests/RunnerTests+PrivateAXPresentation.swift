import XCTest

/// Reported facts for one private-AX element, read once so both projections describe a node the
/// same way. Only membership and clip-derived state differ between them.
struct PrivateAXFields {
  let rect: CGRect
  let label: String
  let identifier: String
  let value: String
  let rawType: Int
  let elementType: XCUIElement.ElementType?
  let enabled: Bool
  let focused: Bool?
  let selected: Bool?
  let actions: [String]?
  let children: [[String: Any]]

  var hasSemanticContent: Bool { [label, identifier, value].contains { !$0.isEmpty } }
  var hasFrame: Bool { !rect.isNull && !rect.isEmpty }
}

extension RunnerTests {
  private static let privateAXProjectionTolerance: CGFloat = 1

  /// Acquisition entry point for the private AX backend.
  ///
  /// The regular projection folds the viewport and scroll clips and records scroll hints; the raw
  /// projection is the acquired tree, so it drops nothing and keeps traversal depth (#1797 D4 — a
  /// recovered `snapshot --raw` used to return viewport-pruned nodes labeled raw).
  func privateAXAcquisition(rawRoot: [String: Any], hint: CaptureHint, viewport: CGRect)
    -> [RawAXNode]
  {
    var nodes: [RawAXNode] = []
    switch hint.projection {
    case .raw:
      appendPrivateAXRawNode(rawRoot, to: &nodes, hint: hint, viewport: viewport,
        depth: 0, parentIndex: nil)
      return nodes
    case .regular:
      var hints: [Int: (above: Bool, below: Bool)] = [:]
      appendPrivateAXNode(rawRoot, to: &nodes, hints: &hints, hint: hint, viewport: viewport,
        depth: 0, parentIndex: nil, scrollContext: nil,
        projectionCursor: .root)
      return applyHiddenContentHints(hints, to: nodes)
    }
  }

  /// Raw projection: every serialized node, in traversal order, at traversal depth. Depth is the
  /// one narrowing a raw acquisition can prove complete, because raw depth *is* traversal depth.
  private func appendPrivateAXRawNode(_ raw: [String: Any], to nodes: inout [RawAXNode],
    hint: CaptureHint, viewport: CGRect, depth: Int, parentIndex: Int?)
  {
    if let limit = hint.depth, depth > limit { return }
    let fields = privateAXFields(raw)
    // No clip fold outside the regular projection: hittability stays the reported geometric fact.
    let onScreen = fields.hasFrame && isVisibleInViewport(fields.rect, viewport)
    let index = nodes.count
    nodes.append(
      privateAXNode(fields, index: index, depth: depth, parentIndex: parentIndex, onScreen: onScreen)
    )
    for child in fields.children {
      appendPrivateAXRawNode(child, to: &nodes, hint: hint, viewport: viewport,
        depth: depth + 1, parentIndex: index)
    }
  }

  private func appendPrivateAXNode(_ raw: [String: Any], to nodes: inout [RawAXNode],
    hints: inout [Int: (above: Bool, below: Bool)], hint: CaptureHint, viewport: CGRect,
    depth: Int, parentIndex: Int?,
    scrollContext: (index: Int, rect: CGRect)?, projectionCursor: FlatSnapshotProjectionCursor)
  {
    if let limit = hint.depth, depth > limit { return }
    let fields = privateAXFields(raw)
    let rect = fields.rect
    let children = fields.children
    let elementType = fields.elementType
    let negligibleDecoration = parentIndex != nil
      && !fields.hasSemanticContent
      && (!fields.hasFrame
        || rect.width <= Self.privateAXProjectionTolerance
        || rect.height <= Self.privateAXProjectionTolerance)
    let onScreen = fields.hasFrame
      && isVisibleInRegularSnapshot(
        rect,
        viewport: viewport,
        scrollContainerAnchor: scrollContext
      )
    let projectionTransition = flatSnapshotProjectionTransition(
      frame: rect,
      intersectsViewportAndScrollClip: onScreen,
      elementType: elementType,
      hasChildren: !children.isEmpty,
      cursor: projectionCursor
    )
    let projection = projectionTransition.decision
    let presentationVisible = projection.presentationVisible && !negligibleDecoration
    let decision = flatSnapshotFilterDecision(
      FlatSnapshotFilterNode(isRoot: parentIndex == nil, visible: presentationVisible),
      hint: hint, visibilityPolicy: .viewportProjected)
    let include = decision.include

    if let hiddenFrame = projectionTransition.hiddenContentFrame, let scrollContext {
      rememberHiddenContentHint(for: hiddenFrame, relativeTo: scrollContext, hints: &hints)
    }

    let currentIndex: Int?
    if include {
      currentIndex = nodes.count
      nodes.append(
        privateAXNode(
          fields, index: nodes.count, depth: depth, parentIndex: parentIndex, onScreen: onScreen)
      )
    } else { currentIndex = parentIndex }

    let nextScrollContext: (index: Int, rect: CGRect)?
    if include, let elementType, let currentIndex {
      nextScrollContext = scrollContainerAnchor(
        for: elementType,
        hasChildren: !children.isEmpty,
        visible: onScreen,
        frame: rect,
        nodeIndex: currentIndex
      ) ?? scrollContext
    } else { nextScrollContext = scrollContext }
    for child in children {
      appendPrivateAXNode(child, to: &nodes, hints: &hints, hint: hint, viewport: viewport,
        depth: depth + 1, parentIndex: currentIndex,
        scrollContext: nextScrollContext,
        projectionCursor: projection.descendants)
    }
  }

  private func privateAXFields(_ raw: [String: Any]) -> PrivateAXFields {
    let rawType = privateAXPresentationInt(raw["type"]) ?? 0
    return PrivateAXFields(
      rect: privateAXRect(raw["frame"]),
      label: privateAXPresentationString(raw["label"]),
      identifier: privateAXPresentationString(raw["identifier"]),
      value: privateAXPresentationString(raw["value"]),
      rawType: rawType,
      elementType: flatSnapshotElementType(rawElementType: rawType),
      enabled: privateAXPresentationBool(raw["enabled"]) ?? true,
      focused: privateAXPresentationBool(raw["focused"]) == true ? true : nil,
      selected: privateAXPresentationBool(raw["selected"]) == true ? true : nil,
      actions: raw["actions"] as? [String],
      children: raw["children"] as? [[String: Any]] ?? []
    )
  }

  private func privateAXNode(_ fields: PrivateAXFields, index: Int, depth: Int, parentIndex: Int?,
    onScreen: Bool) -> RawAXNode
  {
    RawAXNode(index: index,
      type: fields.elementType.map(elementTypeName) ?? "Element(\(fields.rawType))",
      label: fields.label.isEmpty ? nil : fields.label,
      identifier: fields.identifier.isEmpty ? nil : fields.identifier,
      value: fields.value.isEmpty ? nil : fields.value,
      rect: snapshotRect(from: fields.rect), enabled: fields.enabled,
      focused: fields.focused, selected: fields.selected,
      hittable: onScreen && fields.enabled
        && privateAXInteractiveCandidate(rawElementType: fields.rawType),
      depth: depth, parentIndex: parentIndex, hiddenContentAbove: nil, hiddenContentBelow: nil,
      actions: fields.actions)
  }

  private func privateAXPresentationString(_ value: Any?) -> String {
    guard let value else { return "" }
    return (value as? String ?? String(describing: value))
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
  private func privateAXPresentationInt(_ value: Any?) -> Int? {
    (value as? Int) ?? (value as? NSNumber)?.intValue
  }
  private func privateAXPresentationBool(_ value: Any?) -> Bool? {
    (value as? Bool) ?? (value as? NSNumber)?.boolValue
  }
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  fileprivate static func privateAXFrame(
    _ x: Double, _ y: Double, _ width: Double, _ height: Double
  ) -> [String: Any] {
    ["x": x, "y": y, "width": width, "height": height]
  }

  /// A scroll container whose second row is scrolled out of the viewport, plus an unlabeled
  /// decoration: the shapes the regular projection folds away and the raw projection must keep.
  fileprivate static var privateAXScrolledFixture: [String: Any] {
    let frame = privateAXFrame
    return ["type": Int(XCUIElement.ElementType.application.rawValue),
      "label": "Element", "frame": frame(0, 0, 402, 874), "children": [[
        "type": Int(XCUIElement.ElementType.scrollView.rawValue), "frame": frame(0, 96, 402, 700),
        "actions": ["Scroll down"],
        "children": [
          ["type": Int(XCUIElement.ElementType.button.rawValue), "label": "Profile picture",
            "frame": frame(16, 120, 44, 44),
            "children": [["type": Int(XCUIElement.ElementType.image.rawValue),
              "frame": frame(16, 120, 1, 1)]]],
          ["type": Int(XCUIElement.ElementType.button.rawValue), "label": "Theme",
            "frame": frame(16, 900, 360, 44)]]]]]
  }

  func testPrivateAXRegularPresentationProjectsToViewportAndKeepsScrollHint() {
    let nodes = privateAXAcquisition(rawRoot: Self.privateAXScrolledFixture,
      hint: CaptureHint(projection: .regular, depth: nil, interactiveOnly: false,
        customActions: false),
      viewport: CGRect(x: 0, y: 0, width: 402, height: 874))
    XCTAssertEqual(nodes.compactMap(\.label), ["Element", "Profile picture"])
    let scrollView = nodes.first { $0.type == "ScrollView" }
    XCTAssertEqual(scrollView?.hiddenContentBelow, true)
    XCTAssertEqual(scrollView?.actions, ["Scroll down"])
  }

  /// #1797 D4: the raw projection is the acquired tree. The offscreen row and the sub-pixel
  /// decoration the regular projection folds away are both present, at traversal depth, and every
  /// regular node still appears — `regular ⊆ raw` on the same capture.
  func testPrivateAXRawProjectionKeepsEveryAcquiredNode() {
    let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)
    let root = Self.privateAXScrolledFixture
    let regular = privateAXAcquisition(rawRoot: root,
      hint: CaptureHint(projection: .regular, depth: nil, interactiveOnly: true,
        customActions: false),
      viewport: viewport)
    let raw = privateAXAcquisition(rawRoot: root,
      hint: CaptureHint(projection: .raw, depth: nil, interactiveOnly: false, customActions: false),
      viewport: viewport)

    XCTAssertEqual(raw.map(\.type), ["Application", "ScrollView", "Button", "Image", "Button"])
    XCTAssertEqual(raw.map(\.depth), [0, 1, 2, 3, 2])
    XCTAssertEqual(raw.map(\.parentIndex), [nil, 0, 1, 2, 1])
    XCTAssertEqual(raw.compactMap(\.label), ["Element", "Profile picture", "Theme"])
    // The offscreen row is a reported fact in raw, and reported facts do not become hittable
    // just because the projection kept them.
    XCTAssertEqual(raw.last?.hittable, false)
    XCTAssertTrue(raw.allSatisfy { $0.hiddenContentAbove == nil && $0.hiddenContentBelow == nil })

    let rawKeys = Set(raw.map { "\($0.type)-\($0.label ?? "")-\($0.rect.y)" })
    for node in regular {
      XCTAssertTrue(
        rawKeys.contains("\(node.type)-\(node.label ?? "")-\(node.rect.y)"),
        "regular node \(node.type)/\(node.label ?? "") is missing from the raw projection"
      )
    }
    XCTAssertGreaterThan(raw.count, regular.count)
  }

  /// Raw depth is traversal depth, so a raw `--depth` request is the one narrowing this backend
  /// can prove complete.
  func testPrivateAXRawProjectionAppliesRequestedTraversalDepth() {
    let raw = privateAXAcquisition(rawRoot: Self.privateAXScrolledFixture,
      hint: CaptureHint(projection: .raw, depth: 2, interactiveOnly: false, customActions: false),
      viewport: CGRect(x: 0, y: 0, width: 402, height: 874))
    XCTAssertEqual(raw.map(\.type), ["Application", "ScrollView", "Button", "Button"])
    XCTAssertEqual(raw.map(\.depth), [0, 1, 2, 2])
  }

  func testPrivateAXPresentationKeepsOffscreenSubtreeExcludedWhenChildFramesAreClamped() {
    let frame = Self.privateAXFrame
    let root: [String: Any] = ["type": Int(XCUIElement.ElementType.application.rawValue),
      "label": "Element", "frame": frame(0, 0, 402, 874), "children": [[
        "type": Int(XCUIElement.ElementType.table.rawValue), "frame": frame(0, 96, 402, 700),
        "children": [["type": Int(XCUIElement.ElementType.cell.rawValue),
          "label": "Theme", "frame": frame(0, 900, 402, 44), "children": [[
            "type": Int(XCUIElement.ElementType.staticText.rawValue),
            "label": "Theme", "frame": frame(16, 96, 120, 44)],
          ["type": Int(XCUIElement.ElementType.switch.rawValue),
            "label": "Theme", "frame": frame(340, 96, 46, 44)]]]]]]]

    let nodes = privateAXAcquisition(rawRoot: root,
      hint: CaptureHint(projection: .regular, depth: nil, interactiveOnly: false,
        customActions: false),
      viewport: CGRect(x: 0, y: 0, width: 402, height: 874))

    XCTAssertEqual(nodes.compactMap(\.label), ["Element"])
    XCTAssertEqual(nodes.first { $0.type == "Table" }?.hiddenContentBelow, true)
  }

  func testPrivateAXGeometrylessSemanticsAreNeverActionableOrScrollContexts() {
    let zero = ["x": 0, "y": 0, "width": 0, "height": 0]
    let root: [String: Any] = ["type": Int(XCUIElement.ElementType.application.rawValue),
      "label": "Element", "frame": ["x": 0, "y": 0, "width": 402, "height": 874],
      "children": [["type": Int(XCUIElement.ElementType.scrollView.rawValue),
        "label": "Settings semantics", "frame": zero, "children": [[
          "type": Int(XCUIElement.ElementType.button.rawValue), "label": "Theme", "frame": zero],
        ["type": Int(XCUIElement.ElementType.other.rawValue), "frame": zero]]]]]
    let nodes = privateAXAcquisition(rawRoot: root,
      hint: CaptureHint(projection: .regular, depth: nil, interactiveOnly: true,
        customActions: false),
      viewport: CGRect(x: 0, y: 0, width: 402, height: 874))
    XCTAssertEqual(nodes.compactMap(\.label), ["Element", "Settings semantics", "Theme"])
    XCTAssertEqual(nodes.filter { $0.index != 0 }.map(\.hittable), [false, false])
    XCTAssertFalse(nodes.contains { $0.type == "Other" })
    XCTAssertTrue(nodes.allSatisfy { $0.hiddenContentAbove == nil && $0.hiddenContentBelow == nil })
  }
}
#endif
