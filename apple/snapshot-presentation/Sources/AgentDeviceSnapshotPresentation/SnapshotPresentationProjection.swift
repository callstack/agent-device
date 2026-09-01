import Foundation

extension SnapshotPresentation {
  static let eligibleInteractiveTypes: Set<String> = [
    "Button",
    "Cell",
    "CheckBox",
    "CollectionView",
    "Link",
    "MenuItem",
    "Picker",
    "SearchField",
    "SecureTextField",
    "SegmentedControl",
    "Slider",
    "ScrollView",
    "Stepper",
    "Switch",
    "TabBar",
    "Table",
    "TextField",
    "TextView",
    "WebView",
  ]

  static func project(
    _ projectionNodes: [SnapshotPresentationNode],
    acquisition: SnapshotAcquisition,
    options: PresentationOptions,
    projection: CaptureHint.Projection
  ) -> SnapshotPresentationResult {
    let scopedRawNodes = applyScope(to: projectionNodes, options: options, projection: projection)
    let nodes = presentedNodes(
      from: scopedRawNodes,
      projection: projection,
      maximumDepth: projection == .regular ? options.depth : nil
    )
    let qualityNodes: [PresentedNode]? = SnapshotScopePolicy.isActive(options.scope)
      ? presentedNodes(from: projectionNodes, projection: projection, maximumDepth: nil)
      : nil
    return SnapshotPresentationResult(
      nodes: nodes,
      truncated: acquisition.truncated,
      effectiveDepth: acquisition.effectiveDepth,
      customActions: acquisition.customActions,
      qualityNodes: qualityNodes
    )
  }

  static func presentedNodes(
    from rawNodes: [SnapshotPresentationNode],
    projection: CaptureHint.Projection,
    maximumDepth: Int? = nil
  ) -> [PresentedNode] {
    if projection == .raw {
      return rawNodes.map { PresentedNode(presenting: $0) }
    }

    var nodes: [PresentedNode] = []
    var nearestPresentedNodeByRawIndex: [Int: (index: Int, depth: Int)] = [:]
    for node in rawNodes {
      let raw = node.raw
      let presentedParent = raw.parentIndex.flatMap { nearestPresentedNodeByRawIndex[$0] }
      guard isEligibleForRegularPresentation(raw) else {
        if let presentedParent {
          nearestPresentedNodeByRawIndex[raw.index] = presentedParent
        }
        continue
      }

      let presentedIndex = nodes.count
      let presentedDepth = presentedParent.map { $0.depth + 1 } ?? 0
      if let maximumDepth, presentedDepth > maximumDepth {
        if let presentedParent {
          nearestPresentedNodeByRawIndex[raw.index] = presentedParent
        }
        continue
      }
      nearestPresentedNodeByRawIndex[raw.index] = (presentedIndex, presentedDepth)
      nodes.append(
        PresentedNode(
          presenting: raw,
          rect: node.effectiveRect,
          index: presentedIndex,
          depth: presentedDepth,
          parentIndex: presentedParent?.index
        )
      )
    }
    return nodes
  }

  static func applyScope(
    to rawNodes: [SnapshotPresentationNode],
    options: PresentationOptions,
    projection: CaptureHint.Projection
  ) -> [SnapshotPresentationNode] {
    switch SnapshotScopePolicy.select(
      fromPreorder: rawNodes,
      scope: options.scope,
      depth: { $0.raw.depth },
      semanticValues: { [$0.raw.label, $0.raw.identifier, $0.raw.value] },
      subtreeContributes: { range in
        projection == .raw || rawNodes[range].contains { isEligibleForRegularPresentation($0.raw) }
      }
    ) {
    case .unscoped:
      return rawNodes
    case .missing:
      return []
    case .matched(let startIndex):
      let startDepth = rawNodes[startIndex].raw.depth
      let range = SnapshotScopePolicy.subtreeRange(
        from: startIndex,
        in: rawNodes,
        depth: { $0.raw.depth }
      )
      let maxDepth = options.depth ?? Int.max
      let scopedNodes = projection == .raw
        ? Array(rawNodes[range]).filter { $0.raw.depth - startDepth <= maxDepth }
        : Array(rawNodes[range])
      return reindex(scopedNodes, depthOffset: startDepth)
    }
  }

  static func reindex(
    _ nodes: [SnapshotPresentationNode],
    depthOffset: Int
  ) -> [SnapshotPresentationNode] {
    let indexMap = Dictionary(
      uniqueKeysWithValues: nodes.enumerated().map { ($0.element.raw.index, $0.offset) })
    return nodes.enumerated().map { offset, node in
      let raw = node.raw
      return SnapshotPresentationNode(
        raw: RawAXNode(
          index: offset,
          type: raw.type,
          label: raw.label,
          identifier: raw.identifier,
          value: raw.value,
          rect: raw.rect,
          enabled: raw.enabled,
          focused: raw.focused,
          selected: raw.selected,
          hittable: raw.hittable,
          depth: max(0, raw.depth - depthOffset),
          parentIndex: raw.parentIndex.flatMap { indexMap[$0] },
          hiddenContentAbove: raw.hiddenContentAbove,
          hiddenContentBelow: raw.hiddenContentBelow,
          actions: raw.actions
        ),
        effectiveRect: node.effectiveRect
      )
    }
  }

  static func isEligibleForRegularPresentation(_ node: RawAXNode) -> Bool {
    if node.parentIndex == nil { return true }
    return eligibleInteractiveTypes.contains(node.type) || node.hasSemanticContent
  }
}
