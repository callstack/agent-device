import XCTest

extension RunnerTests {
  private static let privateAXProjectionTolerance: CGFloat = 1

  func privateAXPresentation(rawRoot: [String: Any], options: SnapshotOptions, viewport: CGRect)
    -> [SnapshotNode]
  {
    var nodes: [SnapshotNode] = []
    var hints: [Int: (above: Bool, below: Bool)] = [:]
    appendPrivateAXNode(rawRoot, to: &nodes, hints: &hints, options: options, viewport: viewport,
      depth: 0, parentIndex: nil, insideMatchedScope: false, scrollContext: nil)
    return applyHiddenContentHints(hints, to: nodes)
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
    let children = raw["children"] as? [[String: Any]] ?? []
    let hasSemanticContent = [label, identifier, value].contains(where: { !$0.isEmpty })
    let elementType = flatSnapshotElementType(rawElementType: rawType)
    let hasFrame = !rect.isNull && !rect.isEmpty
    let negligibleDecoration = parentIndex != nil
      && !hasSemanticContent
      && (!hasFrame
        || rect.width <= Self.privateAXProjectionTolerance
        || rect.height <= Self.privateAXProjectionTolerance)
    let onScreen = hasFrame
      && isVisibleInRegularSnapshot(
        rect,
        viewport: viewport,
        scrollContainerAnchor: scrollContext
      )
    let presentationVisible = !negligibleDecoration && (!hasFrame || onScreen)
    let decision = flatSnapshotFilterDecision(
      FlatSnapshotFilterNode(isRoot: parentIndex == nil, label: label, identifier: identifier,
        valueText: value.isEmpty ? nil : value, visible: presentationVisible),
      options: options, visibilityPolicy: .viewportProjected,
      insideMatchedScope: insideMatchedScope)
    let include = decision.include

    if !presentationVisible, let scrollContext {
      rememberHiddenContentHint(for: rect, relativeTo: scrollContext, hints: &hints)
    }

    let currentIndex: Int?
    if include {
      currentIndex = nodes.count
      let typeName = elementType.map(elementTypeName) ?? "Element(\(rawType))"
      nodes.append(SnapshotNode(index: nodes.count, type: typeName,
        label: label.isEmpty ? nil : label, identifier: identifier.isEmpty ? nil : identifier,
        value: value.isEmpty ? nil : value, rect: snapshotRect(from: rect), enabled: enabled,
        focused: privateAXPresentationBool(raw["focused"]) == true ? true : nil,
        selected: privateAXPresentationBool(raw["selected"]) == true ? true : nil,
        hittable: onScreen && enabled && privateAXInteractiveCandidate(rawElementType: rawType),
        depth: depth, parentIndex: parentIndex, hiddenContentAbove: nil, hiddenContentBelow: nil,
        actions: raw["actions"] as? [String]))
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
      appendPrivateAXNode(child, to: &nodes, hints: &hints, options: options, viewport: viewport,
        depth: depth + 1, parentIndex: currentIndex,
        insideMatchedScope: decision.insideMatchedScope, scrollContext: nextScrollContext)
    }
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
        "actions": ["Scroll down"],
        "children": [["type": Int(XCUIElement.ElementType.button.rawValue), "label": "Profile picture", "frame": frame(16, 120, 44, 44)],
          ["type": Int(XCUIElement.ElementType.button.rawValue), "label": "Theme", "frame": frame(16, 900, 360, 44)]]]]]
    let nodes = privateAXPresentation(rawRoot: root,
      options: SnapshotOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false),
      viewport: CGRect(x: 0, y: 0, width: 402, height: 874))
    XCTAssertEqual(nodes.compactMap(\.label), ["Element", "Profile picture"])
    let scrollView = nodes.first { $0.type == "ScrollView" }
    XCTAssertEqual(scrollView?.hiddenContentBelow, true)
    XCTAssertEqual(scrollView?.actions, ["Scroll down"])
  }

  func testPrivateAXGeometrylessSemanticsAreNeverActionableOrScrollContexts() {
    let zero = ["x": 0, "y": 0, "width": 0, "height": 0]
    let root: [String: Any] = ["type": Int(XCUIElement.ElementType.application.rawValue),
      "label": "Element", "frame": ["x": 0, "y": 0, "width": 402, "height": 874],
      "children": [["type": Int(XCUIElement.ElementType.scrollView.rawValue),
        "label": "Settings semantics", "frame": zero, "children": [[
          "type": Int(XCUIElement.ElementType.button.rawValue), "label": "Theme", "frame": zero],
        ["type": Int(XCUIElement.ElementType.other.rawValue), "frame": zero]]]]]
    let nodes = privateAXPresentation(rawRoot: root,
      options: SnapshotOptions(interactiveOnly: true, depth: nil, scope: nil, raw: false),
      viewport: CGRect(x: 0, y: 0, width: 402, height: 874))
    XCTAssertEqual(nodes.compactMap(\.label), ["Element", "Settings semantics", "Theme"])
    XCTAssertEqual(nodes.filter { $0.index != 0 }.map(\.hittable), [false, false])
    XCTAssertFalse(nodes.contains { $0.type == "Other" })
    XCTAssertTrue(nodes.allSatisfy { $0.hiddenContentAbove == nil && $0.hiddenContentBelow == nil })
  }
}
#endif
