import Foundation
import AgentDeviceSnapshotPresentation

/// The tree a multi-panel device publishes.
///
/// A capture walks the application element, and on a foldable that hands back whichever window the
/// platform serializes. On an iPhone Duo home screen, the application's subtree reported SpringBoard's
/// outer-panel window and the menu that had already closed on it, while the icons on the lit panel were
/// absent. Booking the viewport against the lit panel, as the surface rule does, would then make every
/// published node a claim about a screen nobody is looking at.
///
/// Three answers come from the panel the request named, and this type is the only place that applies
/// them (ADR 0025):
///
/// 1. The root node carries the panel's box, because the host reads that node as the box the payload is
///    measured in. On a multi-panel device the application element's own frame names a panel, not the
///    panel in use.
/// 2. Surfaces that cannot be seen on that panel are dropped, because their refs would name points on a
///    dark screen and the fold can only clip them into a shape nobody can act on.
/// 3. When the tree carries no window for the panel at all, the caller reads the resolved surface window
///    once and grafts it, which is what makes the lit panel's icons addressable.
///
/// A request that names no panel reaches none of this: on a single-panel device the application element's
/// frame is the surface box and every window is on the one panel, so the historic tree is published as it
/// was read.
enum RunnerPanelSurfaceTree {
  /// One point of drift between two reported window boxes is layout, not a different panel. This is
  /// looser than the surface rule's half point (`AGENT_DEVICE_PANEL_SURFACE_TOLERANCE`) on purpose:
  /// that rule compares an app's box against the panel fact the host divided out of pixels, while this
  /// type compares two boxes the runtime reported itself.
  static let tolerance: CGFloat = 1

  /// The wire types a whole surface arrives as, in the payload's own vocabulary. `Other` is
  /// deliberately absent: XCTest reports it for most containers, and treating it as a surface would
  /// drop content the fold can clip. `Sheet` and `Drawer` are what XCTest would name them; today its
  /// tree reports them as `Element(<raw>)`, so in practice only `Window` is dropped, which is the
  /// conservative direction. The graft asks the platform's element types instead
  /// (`RunnerTests.surfaceElementTypes`), because it reads live elements rather than a payload.
  static let surfaceTypeNames: Set<String> = ["Application", "Window", "Sheet", "Drawer"]

  /// Whether a reported box is that panel's box, either way up: the system presents the inner panel
  /// turned, so its window arrives in the panel's own native space (ADR 0025).
  static func matchesSurfaceBox(_ frame: CGRect, _ surface: CGRect) -> Bool {
    guard isMeasurable(frame), isMeasurable(surface) else { return false }
    guard abs(frame.minX) <= tolerance, abs(frame.minY) <= tolerance else { return false }
    return (near(frame.width, surface.width) && near(frame.height, surface.height))
      || (near(frame.width, surface.height) && near(frame.height, surface.width))
  }

  /// Whether a reported box can be seen on the named panel.
  static func liesOnSurface(_ frame: CGRect, _ surface: CGRect) -> Bool {
    guard isMeasurable(frame), isMeasurable(surface) else { return false }
    return frame.minX >= surface.minX - tolerance
      && frame.minY >= surface.minY - tolerance
      && frame.maxX <= surface.maxX + tolerance
      && frame.maxY <= surface.maxY + tolerance
  }

  /// Whether one already-read layer of a capture carries a window on the named panel. That is the
  /// capture's own evidence that it already shows the lit panel, so no second read is needed.
  static func carriesSurfaceWindow<Layer>(
    _ layer: [Layer],
    surface: CGRect,
    isSurface: (Layer) -> Bool,
    frame: (Layer) -> CGRect
  ) -> Bool {
    layer.contains { isSurface($0) && matchesSurfaceBox(frame($0), surface) }
  }

  /// What narrowing a payload to one panel changed, so the caller can report it and a test can read it.
  struct Published {
    let nodes: [RawAXNode]
    /// Whether the root moved onto the panel's box.
    let republishedRoot: Bool
    /// How many surfaces were removed with their subtrees.
    let droppedSurfaces: Int
  }

  /// The tree as published on the named panel: the root carrying the panel's box and the off-panel
  /// surfaces removed with their subtrees, re-indexed for the payload.
  ///
  /// `nil` means the tree already said exactly this, which is the common case and costs no copy. Only a
  /// payload rooted at the application is rewritten: that root is the node whose children are the app's
  /// whole window list, so it is the one shape where a child naming a surface names a screen. A payload
  /// already rooted at a window was read from one surface and cannot hold another one's content.
  ///
  /// Only a root's own children are dropped: a surface is a whole screen, so its subtree stands or falls
  /// with it, while a node deeper in the tree that reaches past the panel is content the fold clips.
  static func publishing(nodes: [RawAXNode], surface: CGRect) -> Published? {
    guard let root = nodes.first, root.parentIndex == nil, root.type == "Application",
      nodes.dropFirst().contains(where: { $0.parentIndex == nil }) == false
    else {
      return nil
    }
    let offPanel = nodes.filter { node in
      node.parentIndex == root.index
        && node.index != root.index
        && surfaceTypeNames.contains(node.type)
        && !liesOnSurface(node.rect.cgRect, surface)
    }
    let panelBox = SnapshotRect(surface)
    let republishRoot = root.rect != panelBox
    guard republishRoot || !offPanel.isEmpty else { return nil }

    let dropped = subtreeIndexes(of: offPanel.map(\.index), in: nodes)
    var kept: [RawAXNode] = []
    kept.reserveCapacity(nodes.count - dropped.count)
    var reindex: [Int: Int] = [:]
    reindex.reserveCapacity(nodes.count - dropped.count)
    for node in nodes where !dropped.contains(node.index) {
      reindex[node.index] = kept.count
      kept.append(node)
    }
    let published = kept.map { node in
      let republished = node.parentIndex == nil
        ? node.replacing(rect: panelBox, hittable: node.hittable)
        : node
      return republished.reindexed(
        index: reindex[node.index] ?? node.index,
        depth: node.depth,
        parentIndex: node.parentIndex.flatMap { reindex[$0] }
      )
    }
    return Published(
      nodes: published,
      republishedRoot: republishRoot,
      droppedSurfaces: offPanel.count
    )
  }

  /// Depth counts ancestors and only whole sibling subtrees are removed, so a kept node keeps its depth.
  /// Indexes shift because the payload's wire array is positional.
  private static func subtreeIndexes(of roots: [Int], in nodes: [RawAXNode]) -> Set<Int> {
    var childrenByParent: [Int: [Int]] = [:]
    for node in nodes {
      if let parent = node.parentIndex {
        childrenByParent[parent, default: []].append(node.index)
      }
    }
    var dropped = Set(roots)
    var frontier = roots
    while let index = frontier.popLast() {
      for child in childrenByParent[index] ?? [] where dropped.insert(child).inserted {
        frontier.append(child)
      }
    }
    return dropped
  }

  private static func isMeasurable(_ frame: CGRect) -> Bool {
    frame.minX.isFinite && frame.minY.isFinite && frame.size.width.isFinite && frame.size.height.isFinite
      && frame.size.width > 0 && frame.size.height > 0
  }

  private static func near(_ left: CGFloat, _ right: CGFloat) -> Bool {
    abs(left - right) <= tolerance
  }
}
