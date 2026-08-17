import XCTest

extension RunnerTests {
  func privateAXPresentation(rawRoot: [String: Any], options: SnapshotOptions, viewport: CGRect)
    -> [SnapshotNode]
  {
    var nodes: [SnapshotNode] = []
    var hints: [Int: (above: Bool, below: Bool)] = [:]
    appendPrivateAXNode(rawRoot, to: &nodes, hints: &hints, options: options, viewport: viewport,
      depth: 0, parentIndex: nil, insideMatchedScope: false, scrollContext: nil)
    guard !hints.isEmpty else { return nodes }
    return nodes.map { node in
      guard let hint = hints[node.index] else { return node }
      return SnapshotNode(index: node.index, type: node.type, label: node.label,
        identifier: node.identifier, value: node.value, rect: node.rect, enabled: node.enabled,
        focused: node.focused, selected: node.selected, hittable: node.hittable, depth: node.depth,
        parentIndex: node.parentIndex, hiddenContentAbove: hint.above ? true : node.hiddenContentAbove,
        hiddenContentBelow: hint.below ? true : node.hiddenContentBelow, actions: node.actions)
    }
  }

  private func appendPrivateAXNode(_ raw: [String: Any], to nodes: inout [SnapshotNode],
    hints: inout [Int: (above: Bool, below: Bool)], options: SnapshotOptions, viewport: CGRect,
    depth: Int, parentIndex: Int?, insideMatchedScope: Bool,
    scrollContext: (index: Int, rect: CGRect)?)
  {
    if let limit = options.depth, depth > limit { return }
    let rect = privateAXRect(raw["frame"])
    let label = privateAXPresentationString(raw["label"])
    let identifier = privateAXPresentationString(raw["identifier"])
    let value = privateAXPresentationString(raw["value"])
    let rawType = privateAXPresentationInt(raw["type"]) ?? 0
    let enabled = privateAXPresentationBool(raw["enabled"]) ?? true
    let hasFrame = !rect.isNull && !rect.isEmpty
    let visible = (!hasFrame || isVisibleInViewport(rect, viewport))
      && (!hasFrame || scrollContext.map { isVisibleInViewport(rect, $0.rect) } ?? true)
    let decision = flatSnapshotFilterDecision(
      FlatSnapshotFilterNode(isRoot: parentIndex == nil, label: label, identifier: identifier,
        valueText: value.isEmpty ? nil : value, visible: visible),
      options: options, insideMatchedScope: insideMatchedScope)
    let include = decision.include && (parentIndex == nil || visible)

    if !include, !visible, let scrollContext, hasFrame {
      var hint = hints[scrollContext.index] ?? (above: false, below: false)
      if rect.maxY <= scrollContext.rect.minY { hint.above = true }
      if rect.minY >= scrollContext.rect.maxY { hint.below = true }
      hints[scrollContext.index] = hint
    }

    let currentIndex: Int?
    if include {
      currentIndex = nodes.count
      let typeName = flatSnapshotElementType(rawElementType: rawType).map(elementTypeName)
        ?? "Element(\(rawType))"
      nodes.append(SnapshotNode(index: nodes.count, type: typeName,
        label: label.isEmpty ? nil : label, identifier: identifier.isEmpty ? nil : identifier,
        value: value.isEmpty ? nil : value, rect: snapshotRect(from: rect), enabled: enabled,
        focused: privateAXPresentationBool(raw["focused"]) == true ? true : nil,
        selected: privateAXPresentationBool(raw["selected"]) == true ? true : nil,
        hittable: hasFrame && visible && enabled && privateAXInteractiveCandidate(rawElementType: rawType),
        depth: depth, parentIndex: parentIndex, hiddenContentAbove: nil, hiddenContentBelow: nil,
        actions: raw["actions"] as? [String]))
    } else { currentIndex = parentIndex }

    let nextScrollContext: (index: Int, rect: CGRect)?
    if include, hasFrame, let type = flatSnapshotElementType(rawElementType: rawType),
      Self.scrollContainerTypes.contains(type), let currentIndex {
      nextScrollContext = (currentIndex, rect)
    } else { nextScrollContext = scrollContext }
    for child in raw["children"] as? [[String: Any]] ?? [] {
      appendPrivateAXNode(child, to: &nodes, hints: &hints, options: options, viewport: viewport,
        depth: depth + 1, parentIndex: currentIndex,
        insideMatchedScope: decision.insideMatchedScope, scrollContext: nextScrollContext)
    }
  }

  func appendPrivateAXNode(_ raw: [String: Any], to nodes: inout [SnapshotNode],
    options: SnapshotOptions, viewport: CGRect, depth: Int, parentIndex: Int?,
    insideMatchedScope: Bool)
  {
    var hints: [Int: (above: Bool, below: Bool)] = [:]
    appendPrivateAXNode(raw, to: &nodes, hints: &hints, options: options, viewport: viewport,
      depth: depth, parentIndex: parentIndex, insideMatchedScope: insideMatchedScope,
      scrollContext: nil)
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
  func testPrivateAXRegularPresentationProjectsToViewportAndKeepsScrollHint() {
    func frame(_ x: Double, _ y: Double, _ width: Double, _ height: Double) -> [String: Any] {
      ["x": x, "y": y, "width": width, "height": height]
    }
    let root: [String: Any] = ["type": Int(XCUIElement.ElementType.application.rawValue),
      "label": "Element", "frame": frame(0, 0, 402, 874), "children": [[
        "type": Int(XCUIElement.ElementType.scrollView.rawValue), "frame": frame(0, 96, 402, 700),
        "children": [["type": Int(XCUIElement.ElementType.button.rawValue), "label": "Profile picture", "frame": frame(16, 120, 44, 44)],
          ["type": Int(XCUIElement.ElementType.button.rawValue), "label": "Theme", "frame": frame(16, 900, 360, 44)]]]]]
    let nodes = privateAXPresentation(rawRoot: root,
      options: SnapshotOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false),
      viewport: CGRect(x: 0, y: 0, width: 402, height: 874))
    XCTAssertEqual(nodes.compactMap(\.label), ["Element", "Profile picture"])
    XCTAssertEqual(nodes.first { $0.type == "ScrollView" }?.hiddenContentBelow, true)
  }

  func testPrivateAXGeometrylessSemanticsAreNeverActionableOrScrollContexts() {
    let zero = ["x": 0, "y": 0, "width": 0, "height": 0]
    let root: [String: Any] = ["type": Int(XCUIElement.ElementType.application.rawValue),
      "label": "Element", "frame": ["x": 0, "y": 0, "width": 402, "height": 874],
      "children": [["type": Int(XCUIElement.ElementType.scrollView.rawValue),
        "label": "Settings semantics", "frame": zero, "children": [[
          "type": Int(XCUIElement.ElementType.button.rawValue), "label": "Theme", "frame": zero]]]]]
    let nodes = privateAXPresentation(rawRoot: root,
      options: SnapshotOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false),
      viewport: CGRect(x: 0, y: 0, width: 402, height: 874))
    XCTAssertEqual(nodes.compactMap(\.label), ["Element", "Settings semantics", "Theme"])
    XCTAssertEqual(nodes.filter { $0.index != 0 }.map(\.hittable), [false, false])
    XCTAssertTrue(nodes.allSatisfy { $0.hiddenContentAbove == nil && $0.hiddenContentBelow == nil })
  }
}
#endif
