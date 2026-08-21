import Foundation

/// The regular projection's single visibility interpreter for every snapshot backend. It applies
/// the platform clip policy, reparents survivors, and records hidden-content hints behind one pure
/// interface so acquisition backends cannot recreate only part of the projection contract.
enum SnapshotVisibilityFold {
  enum Policy {
    /// An out-of-clip Cell or scroll container owns its descendants' visibility.
    case cursorProjected
    /// Each node is intersected independently with the viewport.
    case plainViewport

    static var platformDefault: Policy {
      #if os(iOS)
        return .cursorProjected
      #else
        return .plainViewport
      #endif
    }
  }

  /// Wire-name vocabulary corresponding to XCTest's scroll-container element types.
  static let scrollContainerTypeNames: Set<String> = ["CollectionView", "ScrollView", "Table"]

  private enum Geometry {
    case geometryless
    case framed(intersectsClip: Bool)
  }

  private enum DescendantVisibility {
    case independent
    case owned
  }

  private struct ProjectionCursor {
    static let root = ProjectionCursor(ancestorProjectedOut: false)

    private let ancestorProjectedOut: Bool

    var isProjectedOut: Bool { ancestorProjectedOut }

    func project(
      geometry: Geometry,
      descendantVisibility: DescendantVisibility
    ) -> ProjectionDecision {
      let nodeProjectedOut: Bool
      switch geometry {
      case .geometryless:
        nodeProjectedOut = false
      case .framed(let intersectsClip):
        nodeProjectedOut = !intersectsClip
      }
      let presentationVisible = !ancestorProjectedOut && !nodeProjectedOut
      let descendantsProjectedOut = ancestorProjectedOut
        || (nodeProjectedOut && descendantVisibility == .owned)
      return ProjectionDecision(
        presentationVisible: presentationVisible,
        descendants: ProjectionCursor(ancestorProjectedOut: descendantsProjectedOut)
      )
    }
  }

  private struct ProjectionDecision {
    let presentationVisible: Bool
    let descendants: ProjectionCursor
  }
  private struct ProjectionTransition {
    let decision: ProjectionDecision
    let hiddenContentFrame: CGRect?
  }
  private struct BranchState {
    let cursor: ProjectionCursor
    let anchor: (index: Int, rect: CGRect)?
    let keptIndex: Int?
    let keptDepth: Int
  }

  private static let negligibleDecorationTolerance = 1.0
  private static let visibilityExemptCarrierTypes: Set<String> = ["Application", "Window"]

  static func fold(
    _ nodes: [RawAXNode],
    viewport: CGRect,
    interactiveOnly: Bool,
    policy: Policy
  ) -> [RawAXNode] {
    var hasChildren = [Bool](repeating: false, count: nodes.count)
    for node in nodes {
      if let parentIndex = node.parentIndex, parentIndex >= 0, parentIndex < nodes.count {
        hasChildren[parentIndex] = true
      }
    }

    var states = [BranchState?](repeating: nil, count: nodes.count)
    var kept: [RawAXNode] = []
    var hints: [Int: (above: Bool, below: Bool)] = [:]

    for (offset, node) in nodes.enumerated() {
      let parentState = node.parentIndex.flatMap { states[$0] }
      let parentCursor = parentState?.cursor ?? .root
      let parentAnchor = parentState?.anchor
      let rect = CGRect(
        x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height
      )
      let intersects = intersectsClip(rect, viewport: viewport, scrollAnchor: parentAnchor)
      let transition = projectionTransition(
        frame: rect,
        intersectsClip: intersects,
        typeName: node.type,
        hasChildren: hasChildren[offset],
        cursor: parentCursor,
        policy: policy
      )

      let negligibleDecoration = policy == .cursorProjected
        && node.parentIndex != nil
        && !node.hasSemanticContent
        && (rect.isEmpty
          || rect.width <= negligibleDecorationTolerance
          || rect.height <= negligibleDecorationTolerance)
      let visible = transition.decision.presentationVisible && !negligibleDecoration
      let include = shouldInclude(
        node,
        visible: visible,
        interactiveOnly: interactiveOnly,
        policy: policy
      )

      if let hiddenFrame = transition.hiddenContentFrame, let parentAnchor {
        rememberHiddenContentHint(for: hiddenFrame, relativeTo: parentAnchor, hints: &hints)
      }

      var keptIndex = parentState?.keptIndex
      var keptDepth = parentState?.keptDepth ?? -1
      if include {
        let outIndex = kept.count
        let outDepth = keptDepth + 1
        kept.append(
          RawAXNode(
            index: outIndex,
            type: node.type,
            label: node.label,
            identifier: node.identifier,
            value: node.value,
            rect: node.rect,
            enabled: node.enabled,
            focused: node.focused,
            selected: node.selected,
            hittable: node.hittable && intersects,
            depth: outDepth,
            parentIndex: keptIndex,
            hiddenContentAbove: node.hiddenContentAbove,
            hiddenContentBelow: node.hiddenContentBelow,
            actions: node.actions
          )
        )
        keptIndex = outIndex
        keptDepth = outDepth
      }

      var anchor = parentAnchor
      if include,
        let newAnchor = scrollContainerAnchor(
          forTypeName: node.type,
          hasChildren: hasChildren[offset],
          visible: intersects,
          frame: rect,
          nodeIndex: keptIndex
        )
      {
        anchor = newAnchor
      }
      states[offset] = BranchState(
        cursor: transition.decision.descendants,
        anchor: anchor,
        keptIndex: keptIndex,
        keptDepth: keptDepth
      )
    }
    return applyHiddenContentHints(hints, to: kept)
  }

  private static func projectionTransition(
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

  private static func shouldInclude(
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

  private static func intersectsClip(
    _ rect: CGRect,
    viewport: CGRect,
    scrollAnchor: (index: Int, rect: CGRect)?
  ) -> Bool {
    guard !rect.isNull, !rect.isEmpty, rect.intersects(viewport) else { return false }
    guard let scrollAnchor else { return true }
    return rect.intersects(scrollAnchor.rect)
  }

  private static func scrollContainerAnchor(
    forTypeName typeName: String,
    hasChildren: Bool,
    visible: Bool,
    frame: CGRect,
    nodeIndex: Int?
  ) -> (index: Int, rect: CGRect)? {
    guard let nodeIndex,
      visible,
      hasChildren,
      scrollContainerTypeNames.contains(typeName)
    else { return nil }
    return (nodeIndex, frame)
  }

  private static func rememberHiddenContentHint(
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

  private static func applyHiddenContentHints(
    _ hints: [Int: (above: Bool, below: Bool)],
    to nodes: [RawAXNode]
  ) -> [RawAXNode] {
    if hints.isEmpty { return nodes }
    return nodes.map { node in
      guard let hint = hints[node.index] else { return node }
      return RawAXNode(
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
      )
    }
  }
}
