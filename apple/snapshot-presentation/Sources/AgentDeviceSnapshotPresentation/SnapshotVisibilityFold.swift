import Foundation
import CoreGraphics

public enum SnapshotVisibilityFold {
  public enum Policy {
    case cursorProjected
    case plainViewport

    public static var platformDefault: Self {
      #if os(iOS)
        return .cursorProjected
      #else
        return .plainViewport
      #endif
    }
  }

  public static let scrollContainerTypeNames: Set<String> = ["CollectionView", "ScrollView", "Table"]

  enum Geometry {
    case geometryless
    case framed(intersectsClip: Bool)
  }

  enum DescendantVisibility {
    case independent
    case owned
  }

  struct ProjectionCursor {
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

  struct ProjectionDecision {
    let presentationVisible: Bool
    let descendants: ProjectionCursor
  }

  struct ProjectionTransition {
    let decision: ProjectionDecision
    let hiddenContentFrame: CGRect?
  }

  public struct TraversalState {
    fileprivate let cursor: ProjectionCursor
    fileprivate let ancestorClip: CGRect?

    fileprivate init(cursor: ProjectionCursor, ancestorClip: CGRect?) {
      self.cursor = cursor
      self.ancestorClip = ancestorClip
    }

    public static let root = TraversalState(cursor: .root, ancestorClip: nil)

    public var descendantsMayBeVisible: Bool {
      !cursor.isProjectedOut
    }
  }

  public struct TraversalDecision {
    public let isIncluded: Bool
    public let descendantsMayBeVisible: Bool
    public let descendants: TraversalState
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

  public static func traversalDecision(
    for node: RawAXNode,
    parent: TraversalState,
    viewport: CGRect,
    interactiveOnly: Bool,
    hasChildren: Bool,
    policy: Policy
  ) -> TraversalDecision {
    let ancestorClip = policy == .cursorProjected ? parent.ancestorClip : nil
    let rect = node.rect.cgRect
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
      && (rect.isEmpty || rect.width <= negligibleDecorationTolerance || rect.height <= negligibleDecorationTolerance)
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

  public static func fold(
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
      let rect = node.rect.cgRect
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
              hittable: node.parentIndex != nil && node.hittable
                && SnapshotGeometry.isGeometricallyActionable(
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

}
