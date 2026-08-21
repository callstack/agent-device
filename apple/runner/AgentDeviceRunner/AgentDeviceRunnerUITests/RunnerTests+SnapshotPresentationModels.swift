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

  var hasSemanticContent: Bool {
    [label, identifier, value].contains {
      !($0?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }
  }
}

/// The acquisition-facing view of a snapshot request, derived once by
/// `SnapshotPresentation.captureHint(for:)`.
///
/// Backends read a hint, never `PresentationOptions`: presentation owns interpretation, and a hint
/// may narrow acquisition only where the backend can prove the narrowing complete for the requested
/// projection (#1797 conservatism). Everything else a hint carries is budget and ordering.
struct CaptureHint {
  /// Which projection this acquisition must serve. Backends that cannot serve one are not planned
  /// for it, and presentation refuses an acquisition captured for the other projection rather
  /// than relabeling it.
  enum Projection: String {
    case regular
    case raw
  }

  let projection: Projection
  /// Traversal-depth budget. Regular presentation's collapsed depth retains the visible-depth
  /// frontier residue described by #1797; this cut stays cheap for depth probes.
  let depth: Int?
  /// Regular-projection acquisition budget. Raw projection is the acquired tree and never carries
  /// this narrowing.
  let interactiveOnly: Bool
  let customActions: Bool

  var isRaw: Bool { projection == .raw }
}

/// One backend attempt after acquisition and its current backend-specific interpretation.
///
/// It is the only input snapshot presentation accepts, and it carries the hint it was captured
/// under so the two sides of the seam cannot disagree about which projection this is.
struct SnapshotAcquisition {
  let hint: CaptureHint
  let nodes: [RawAXNode]
  let truncated: Bool
  let effectiveDepth: Int?
  var customActions: SnapshotCustomActionCoverage? = nil
  /// Viewport the regular projection's clip fold runs against. `.infinite` disables the fold for
  /// raw acquisitions and depth-0 probes.
  let viewport: CGRect
}

/// The only snapshot node shape accepted by response payload assembly.
///
/// It has no memberwise initializer, so response assembly has to choose one of the explicit
/// presentation constructors. The encoded shape intentionally remains byte-for-byte compatible
/// with the former `SnapshotNode` wire model.
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

  init(presenting raw: RawAXNode) {
    self.init(
      presenting: raw,
      rect: raw.rect,
      index: raw.index,
      depth: raw.depth,
      parentIndex: raw.parentIndex
    )
  }

  init(presenting node: SnapshotPresentationNode) {
    self.init(
      presenting: node.raw,
      rect: node.effectiveRect,
      index: node.raw.index,
      depth: node.raw.depth,
      parentIndex: node.raw.parentIndex
    )
  }

  init(presenting raw: RawAXNode, index: Int, depth: Int, parentIndex: Int?) {
    self.init(
      presenting: raw,
      rect: raw.rect,
      index: index,
      depth: depth,
      parentIndex: parentIndex
    )
  }

  init(
    presenting raw: RawAXNode,
    rect: SnapshotRect,
    index: Int,
    depth: Int,
    parentIndex: Int?
  ) {
    self.index = index
    type = raw.type
    label = raw.label
    identifier = raw.identifier
    value = raw.value
    self.rect = rect
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
