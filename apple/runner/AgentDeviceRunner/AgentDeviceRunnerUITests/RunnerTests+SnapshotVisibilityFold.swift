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

  fileprivate enum Geometry {
    case geometryless
    case framed(intersectsClip: Bool)
  }

  fileprivate enum DescendantVisibility {
    case independent
    case owned
  }

  fileprivate struct ProjectionCursor {
    static let root = ProjectionCursor(ancestorProjectedOut: false)

    private let ancestorProjectedOut: Bool

    var isProjectedOut: Bool { ancestorProjectedOut }

    fileprivate func project(
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

  fileprivate struct ProjectionDecision {
    let presentationVisible: Bool
    let descendants: ProjectionCursor
  }
  fileprivate struct ProjectionTransition {
    let decision: ProjectionDecision
    let hiddenContentFrame: CGRect?
  }

  /// The fold's traversal state is also consumed by acquisition when a regular depth frontier is
  /// requested. It carries only projection facts; presentation remains the owner of membership
  /// and output construction.
  struct TraversalState {
    fileprivate let cursor: ProjectionCursor
    fileprivate let ancestorClip: CGRect?

    fileprivate init(cursor: ProjectionCursor, ancestorClip: CGRect?) {
      self.cursor = cursor
      self.ancestorClip = ancestorClip
    }

    static let root = TraversalState(cursor: .root, ancestorClip: nil)

    var descendantsMayBeVisible: Bool { !cursor.isProjectedOut }
  }

  struct TraversalDecision {
    /// Whether the shared fold would retain this raw node before regular semantic eligibility.
    let isIncluded: Bool
    /// Whether any descendant can remain visible under the same projection cursor.
    let descendantsMayBeVisible: Bool
    let descendants: TraversalState
    fileprivate let effectiveFrame: CGRect
    fileprivate let hiddenContentFrame: CGRect?
    fileprivate let establishesScrollAnchor: Bool
  }

  private struct BranchState {
    let traversal: TraversalState
    let anchor: (index: Int, rect: CGRect)?
    let keptIndex: Int?
    let keptDepth: Int
  }

  private static let negligibleDecorationTolerance = 1.0
  private static let visibilityExemptCarrierTypes: Set<String> = ["Application", "Window"]

  static func traversalDecision(
    for node: RawAXNode,
    parent: TraversalState,
    viewport: CGRect,
    interactiveOnly: Bool,
    hasChildren: Bool,
    policy: Policy
  ) -> TraversalDecision {
    let ancestorClip = policy == .cursorProjected ? parent.ancestorClip : nil
    let rect = CGRect(
      x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height
    )
    let effectiveFrame = SnapshotGeometry.effectiveFrame(
      reportedFrame: rect,
      viewport: viewport,
      ancestorClip: ancestorClip
    )
    let intersects = !effectiveFrame.isNull && !effectiveFrame.isEmpty
    let transition = projectionTransition(
      frame: rect,
      intersectsClip: intersects,
      typeName: node.type,
      hasChildren: hasChildren,
      cursor: parent.cursor,
      policy: policy
    )
    let negligibleDecoration = policy == .cursorProjected
      && node.parentIndex != nil
      && !node.hasSemanticContent
      && (rect.isEmpty
        || rect.width <= negligibleDecorationTolerance
        || rect.height <= negligibleDecorationTolerance)
    let visible = transition.decision.presentationVisible && !negligibleDecoration
    let isIncluded = shouldInclude(
      node,
      visible: visible,
      interactiveOnly: interactiveOnly,
      policy: policy
    )
    let establishesScrollAnchor = policy == .cursorProjected
      && isIncluded
      && intersects
      && hasChildren
      && scrollContainerTypeNames.contains(node.type)
    let descendants = TraversalState(
      cursor: transition.decision.descendants,
      ancestorClip: establishesScrollAnchor ? effectiveFrame : ancestorClip
    )
    return TraversalDecision(
      isIncluded: isIncluded,
      descendantsMayBeVisible: !transition.decision.descendants.isProjectedOut,
      descendants: descendants,
      effectiveFrame: effectiveFrame,
      hiddenContentFrame: transition.hiddenContentFrame,
      establishesScrollAnchor: establishesScrollAnchor
    )
  }

  static func fold(
    _ nodes: [RawAXNode],
    viewport: CGRect,
    interactiveOnly: Bool,
    policy: Policy
  ) -> [SnapshotPresentationNode] {
    var hasChildren = [Bool](repeating: false, count: nodes.count)
    for node in nodes {
      if let parentIndex = node.parentIndex, parentIndex >= 0, parentIndex < nodes.count {
        hasChildren[parentIndex] = true
      }
    }

    var states = [BranchState?](repeating: nil, count: nodes.count)
    var kept: [SnapshotPresentationNode] = []
    var hints: [Int: (above: Bool, below: Bool)] = [:]

    for (offset, node) in nodes.enumerated() {
      let parentState = node.parentIndex.flatMap { states[$0] }
      let parentTraversal = parentState?.traversal ?? .root
      let parentAnchor = policy == .cursorProjected ? parentState?.anchor : nil
      let rect = CGRect(
        x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height
      )
      let decision = traversalDecision(
        for: node,
        parent: parentTraversal,
        viewport: viewport,
        interactiveOnly: interactiveOnly,
        hasChildren: hasChildren[offset],
        policy: policy
      )

      if let hiddenFrame = decision.hiddenContentFrame, let parentAnchor {
        rememberHiddenContentHint(for: hiddenFrame, relativeTo: parentAnchor, hints: &hints)
      }

      var keptIndex = parentState?.keptIndex
      var keptDepth = parentState?.keptDepth ?? -1
      if decision.isIncluded {
        let outIndex = kept.count
        let outDepth = keptDepth + 1
        kept.append(
          SnapshotPresentationNode(
            raw: RawAXNode(
              index: outIndex,
              type: node.type,
              label: node.label,
              identifier: node.identifier,
              value: node.value,
              rect: node.rect,
              enabled: node.enabled,
              focused: node.focused,
              selected: node.selected,
              hittable: node.parentIndex != nil && SnapshotGeometry.isGeometricallyActionable(
                enabled: node.enabled,
                frame: decision.effectiveFrame,
                viewport: viewport
              ),
              depth: outDepth,
              parentIndex: keptIndex,
              hiddenContentAbove: node.hiddenContentAbove,
              hiddenContentBelow: node.hiddenContentBelow,
              actions: node.actions
            ),
            effectiveRect: SnapshotGeometry.snapshotRect(
              from: decision.effectiveFrame,
              reportedFrame: rect
            )
          )
        )
        keptIndex = outIndex
        keptDepth = outDepth
      }

      var anchor = parentAnchor
      if decision.establishesScrollAnchor, let keptIndex {
        anchor = (index: keptIndex, rect: decision.effectiveFrame)
      }
      states[offset] = BranchState(
        traversal: decision.descendants,
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
