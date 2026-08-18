import Foundation

/// Backend-owned snapshot output before it crosses the presentation seam.
///
/// The incremental #1797 migration still carries derived fields that later semantic layers move
/// behind `SnapshotPresentation`. Eligibility is no longer one of those backend-owned decisions.
struct RawAXNode {
  let index: Int
  let type: String
  let label: String?
  let identifier: String?
  let value: String?
  let rect: SnapshotRect
  let enabled: Bool
  let focused: Bool?
  let selected: Bool?
  let hittable: Bool
  let depth: Int
  let parentIndex: Int?
  let hiddenContentAbove: Bool?
  let hiddenContentBelow: Bool?
  var actions: [String]? = nil
}

/// One backend attempt after acquisition and its current backend-specific interpretation.
///
/// Step 2 makes this the only input accepted by snapshot presentation. Later #1797 steps move the
/// interpretation that still precedes this value into `SnapshotPresentation` without changing the
/// capture-plan seam.
struct SnapshotAcquisition {
  let nodes: [RawAXNode]
  let truncated: Bool
  let effectiveDepth: Int?
  var customActions: SnapshotCustomActionCoverage? = nil
}

/// The only snapshot node shape accepted by response payload assembly.
///
/// Its initializer is private so a backend cannot bypass `SnapshotPresentation`. The encoded shape
/// intentionally remains byte-for-byte compatible with the former `SnapshotNode` wire model.
struct PresentedNode: Codable {
  let index: Int
  let type: String
  let label: String?
  let identifier: String?
  let value: String?
  let rect: SnapshotRect
  let enabled: Bool
  let focused: Bool?
  let selected: Bool?
  let hittable: Bool
  let depth: Int
  let parentIndex: Int?
  let hiddenContentAbove: Bool?
  let hiddenContentBelow: Bool?
  let actions: [String]?

  fileprivate init(presenting raw: RawAXNode) {
    self.init(
      presenting: raw,
      index: raw.index,
      depth: raw.depth,
      parentIndex: raw.parentIndex
    )
  }

  fileprivate init(presenting raw: RawAXNode, index: Int, depth: Int, parentIndex: Int?) {
    self.index = index
    type = raw.type
    label = raw.label
    identifier = raw.identifier
    value = raw.value
    rect = raw.rect
    enabled = raw.enabled
    focused = raw.focused
    selected = raw.selected
    hittable = raw.hittable
    self.depth = depth
    self.parentIndex = parentIndex
    hiddenContentAbove = raw.hiddenContentAbove
    hiddenContentBelow = raw.hiddenContentBelow
    actions = raw.actions
  }
}

enum SnapshotPresentation {
  private static let eligibleInteractiveTypes: Set<String> = [
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

  /// The capture plan's single presentation route for every snapshot backend.
  ///
  /// Eligibility is the first intentional step-3 semantic delta: regular presentation keeps a
  /// root carrier plus nodes with an interactive type or non-empty semantic content. Raw snapshots
  /// retain their acquired membership until the dedicated raw-projection migration lands.
  static func present(
    _ acquisition: SnapshotAcquisition,
    options: PresentationOptions
  ) -> SnapshotBackendCapture {
    SnapshotBackendCapture(
      payload: DataPayload(
        nodes: presentedNodes(from: acquisition.nodes, options: options),
        truncated: acquisition.truncated
      ),
      effectiveDepth: acquisition.effectiveDepth,
      customActions: acquisition.customActions
    )
  }

  /// Explicit carve-out for selector queries and system-modal reads that intentionally return one
  /// already-resolved element instead of traversing a snapshot backend.
  static func singleElementRead(_ node: RawAXNode) -> PresentedNode {
    PresentedNode(presenting: node)
  }

  private static func presentedNodes(
    from rawNodes: [RawAXNode],
    options: PresentationOptions
  ) -> [PresentedNode] {
    if options.raw {
      return rawNodes.map(PresentedNode.init(presenting:))
    }

    var nodes: [PresentedNode] = []
    var nearestPresentedNodeByRawIndex: [Int: (index: Int, depth: Int)] = [:]
    for raw in rawNodes {
      let presentedParent = raw.parentIndex.flatMap {
        nearestPresentedNodeByRawIndex[$0]
      }
      guard isEligibleForRegularPresentation(raw) else {
        if let presentedParent {
          nearestPresentedNodeByRawIndex[raw.index] = presentedParent
        }
        continue
      }

      let presentedIndex = nodes.count
      let presentedDepth = presentedParent.map { $0.depth + 1 } ?? 0
      nearestPresentedNodeByRawIndex[raw.index] = (presentedIndex, presentedDepth)
      nodes.append(
        PresentedNode(
          presenting: raw,
          index: presentedIndex,
          depth: presentedDepth,
          parentIndex: presentedParent?.index
        )
      )
    }
    return nodes
  }

  private static func isEligibleForRegularPresentation(_ node: RawAXNode) -> Bool {
    // The top-level carrier owns viewport geometry and must survive even for query-sweep's
    // deliberately unlabeled synthetic Application node.
    if node.parentIndex == nil { return true }
    return eligibleInteractiveTypes.contains(node.type) || hasSemanticContent(node)
  }

  private static func hasSemanticContent(_ node: RawAXNode) -> Bool {
    [node.label, node.identifier, node.value].contains { value in
      guard let value else { return false }
      return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
  }
}
