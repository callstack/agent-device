import CoreGraphics

extension SnapshotVisibilityFold {
  static let negligibleDecorationTolerance = 1.0
  static let visibilityExemptCarrierTypes: Set<String> = ["Application", "Window"]

  static func projectionTransition(
    frame: CGRect,
    intersectsClip: Bool,
    typeName: String,
    hasChildren: Bool,
    cursor: ProjectionCursor,
    policy: Policy
  ) -> ProjectionTransition {
    if policy == .plainViewport {
      return ProjectionTransition(
        decision: ProjectionDecision(
          presentationVisible: intersectsClip,
          descendants: .root
        ),
        hiddenContentFrame: !intersectsClip ? frame : nil
      )
    }

    let hasFrame = !frame.isNull && !frame.isEmpty
    let geometry: Geometry = hasFrame ? .framed(intersectsClip: intersectsClip) : .geometryless
    let ownsDescendants = hasChildren
      && (typeName == "Cell" || scrollContainerTypeNames.contains(typeName))
    return ProjectionTransition(
      decision: cursor.project(
        geometry: geometry,
        descendantVisibility: ownsDescendants ? .owned : .independent
      ),
      hiddenContentFrame: !cursor.isProjectedOut && hasFrame && !intersectsClip ? frame : nil
    )
  }

  static func shouldInclude(
    _ node: RawAXNode,
    visible: Bool,
    interactiveOnly: Bool,
    policy: Policy
  ) -> Bool {
    if node.parentIndex == nil { return true }
    if policy == .plainViewport && interactiveOnly && !visible && node.type != "Application" {
      return false
    }
    return visibilityExemptCarrierTypes.contains(node.type) || visible
  }

  static func rememberHiddenContentHint(
    for frame: CGRect,
    relativeTo scrollAnchor: (index: Int, rect: CGRect),
    hints: inout [Int: (above: Bool, below: Bool)]
  ) {
    var hint = hints[scrollAnchor.index] ?? (above: false, below: false)
    if frame.maxY <= scrollAnchor.rect.minY {
      hint.above = true
    } else if frame.minY >= scrollAnchor.rect.maxY {
      hint.below = true
    } else {
      return
    }
    hints[scrollAnchor.index] = hint
  }

  static func applyHiddenContentHints(
    _ hints: [Int: (above: Bool, below: Bool)],
    to nodes: [SnapshotPresentationNode]
  ) -> [SnapshotPresentationNode] {
    if hints.isEmpty { return nodes }
    return nodes.map { presentationNode in
      let node = presentationNode.raw
      guard let hint = hints[node.index] else { return presentationNode }
      return SnapshotPresentationNode(
        raw: RawAXNode(
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
          hiddenContentAbove: node.hiddenContentAbove == true || hint.above ? true : nil,
          hiddenContentBelow: node.hiddenContentBelow == true || hint.below ? true : nil,
          actions: node.actions
        ),
        effectiveRect: presentationNode.effectiveRect
      )
    }
  }
}
