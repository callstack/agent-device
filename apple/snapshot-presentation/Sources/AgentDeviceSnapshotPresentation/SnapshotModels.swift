import Foundation
import CoreGraphics

public struct SnapshotRect: Codable, Equatable {
  public let x: Double
  public let y: Double
  public let width: Double
  public let height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  public var cgRect: CGRect {
    CGRect(x: x, y: y, width: width, height: height)
  }

  public init(_ rect: CGRect) {
    self.init(
      x: Double(rect.origin.x),
      y: Double(rect.origin.y),
      width: Double(rect.size.width),
      height: Double(rect.size.height)
    )
  }
}

public struct RawAXNode: Equatable {
  public let index: Int
  public let type: String
  public let label: String?
  public let identifier: String?
  public let value: String?
  public var rect: SnapshotRect
  public let enabled: Bool
  public let focused: Bool?
  public let selected: Bool?
  public var hittable: Bool
  public let depth: Int
  public let parentIndex: Int?
  public let hiddenContentAbove: Bool?
  public let hiddenContentBelow: Bool?
  public var actions: [String]?

  public init(
    index: Int,
    type: String,
    label: String?,
    identifier: String?,
    value: String?,
    rect: SnapshotRect,
    enabled: Bool,
    focused: Bool?,
    selected: Bool?,
    hittable: Bool,
    depth: Int,
    parentIndex: Int?,
    hiddenContentAbove: Bool?,
    hiddenContentBelow: Bool?,
    actions: [String]? = nil
  ) {
    self.index = index
    self.type = type
    self.label = label
    self.identifier = identifier
    self.value = value
    self.rect = rect
    self.enabled = enabled
    self.focused = focused
    self.selected = selected
    self.hittable = hittable
    self.depth = depth
    self.parentIndex = parentIndex
    self.hiddenContentAbove = hiddenContentAbove
    self.hiddenContentBelow = hiddenContentBelow
    self.actions = actions
  }

  func replacing(rect: SnapshotRect, hittable: Bool) -> RawAXNode {
    var updated = self
    updated.rect = rect
    updated.hittable = hittable
    return updated
  }

  public var hasSemanticContent: Bool {
    [label, identifier, value].contains {
      !($0?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }
  }
}

public struct CaptureHint: Equatable {
  public enum Projection: String {
    case regular
    case raw
  }

  public let projection: Projection
  public let depth: Int?
  public let regularPresentedDepth: Int?
  public let interactiveOnly: Bool
  public let customActions: Bool

  public init(
    projection: Projection,
    depth: Int?,
    regularPresentedDepth: Int?,
    interactiveOnly: Bool,
    customActions: Bool
  ) {
    self.projection = projection
    self.depth = depth
    self.regularPresentedDepth = regularPresentedDepth
    self.interactiveOnly = interactiveOnly
    self.customActions = customActions
  }

  public var rawTraversalDepth: Int? {
    projection == .raw ? depth : nil
  }

  public var isRaw: Bool {
    projection == .raw
  }
}

public struct PresentationOptions: Equatable {
  public let interactiveOnly: Bool
  public let depth: Int?
  public let scope: String?
  public let raw: Bool
  public var preferredBackend: String?
  public var customActions: Bool

  public init(
    interactiveOnly: Bool,
    depth: Int?,
    scope: String?,
    raw: Bool,
    preferredBackend: String? = nil,
    customActions: Bool = false
  ) {
    self.interactiveOnly = interactiveOnly
    self.depth = depth
    self.scope = scope
    self.raw = raw
    self.preferredBackend = preferredBackend
    self.customActions = customActions
  }
}

/// What a capture knows about the viewport hosting its tree, as the three-case fact the host's
/// `IosViewportEvidence` already uses (#2891). A rectangle is never allowed to stand for "unknown":
/// `CGRect.infinite` crossing this boundary read as "everything is actionable" on the runner and as
/// "publish nothing" on the host, which is the same state resolved in two directions.
public enum SnapshotViewport: Equatable {
  /// A box that `SnapshotGeometry.isPositiveFinite` has already accepted. The initialiser is internal,
  /// which is what keeps this an enumerated fact instead of a checked suggestion: outside this package
  /// the only way to put a box inside a viewport fact is `reported(box:)` or `derived(box:)` below, so
  /// no caller can name a case around them and hand over the sentinel again (#2891).
  public struct Box: Equatable {
    public let rect: CGRect

    init(positiveFinite rect: CGRect) {
      self.rect = rect
    }
  }

  /// The platform's own box for the app's surface.
  case reported(Box)
  /// A box the capture inferred for itself out of its own root element instead of a screen read. It
  /// clips and contains like a reported box, and it never anchors a rotation: the tier that produces
  /// it reports no interface orientation beside it (#2612).
  case derived(Box)
  /// No box. See `SnapshotGeometry.isGeometricallyActionable` for the one policy this answers.
  case missing(reason: MissingReason)

  public enum MissingReason: Equatable {
    /// Nothing was read: the read was skipped, or it raised.
    case notProvided
    /// A box arrived that cannot be a viewport: null, empty, inverted, or non-finite, which is what
    /// `SnapshotGeometry.isPositiveFinite` refuses.
    case invalid
  }

  /// The box to compare geometry against, or `nil` when the capture has none. Nothing that needs a
  /// box may substitute an unbounded one for the absence of one.
  public var rect: CGRect? {
    switch self {
    case .reported(let box), .derived(let box):
      return box.rect
    case .missing:
      return nil
    }
  }

  /// Declares the box the platform reported for the app's surface. A box that cannot be a viewport
  /// becomes `.missing(reason: .invalid)` here, at the one place a box becomes a viewport, so no
  /// consumer has to re-check what it was handed.
  public static func reported(box: CGRect) -> SnapshotViewport {
    SnapshotGeometry.isPositiveFinite(box) ? .reported(Box(positiveFinite: box)) : .missing(reason: .invalid)
  }

  /// Declares the capture's own root box as its viewport. Same refusal as `reported(box:)`: an
  /// unusable root box is no box at all.
  public static func derived(box: CGRect) -> SnapshotViewport {
    SnapshotGeometry.isPositiveFinite(box) ? .derived(Box(positiveFinite: box)) : .missing(reason: .invalid)
  }
}

public struct SnapshotAcquisition {
  public let hint: CaptureHint
  public var nodes: [RawAXNode]
  public let truncated: Bool
  public let effectiveDepth: Int?
  public var customActions: SnapshotCustomActionCoverage?
  public let viewport: SnapshotViewport
  /// The app's interface orientation, consumed by the one `normalized` pass; `unknown` turns nothing.
  public let interfaceOrientation: Int

  public init(
    hint: CaptureHint,
    nodes: [RawAXNode],
    truncated: Bool,
    effectiveDepth: Int?,
    customActions: SnapshotCustomActionCoverage? = nil,
    viewport: SnapshotViewport,
    interfaceOrientation: Int = 0
  ) {
    self.hint = hint
    self.nodes = nodes
    self.truncated = truncated
    self.effectiveDepth = effectiveDepth
    self.customActions = customActions
    self.viewport = viewport
    self.interfaceOrientation = interfaceOrientation
  }

  public func replacingNodes(_ nodes: [RawAXNode]) -> SnapshotAcquisition {
    var updated = self
    updated.nodes = nodes
    return updated
  }
}

public struct SnapshotCustomActionCoverage: Codable, Equatable {
  public let read: Int
  public let candidates: Int
  public let truncated: Int
  public let blocked: Bool

  public init(read: Int, candidates: Int, truncated: Int, blocked: Bool) {
    self.read = read
    self.candidates = candidates
    self.truncated = truncated
    self.blocked = blocked
  }
}

public struct SnapshotPresentationNode {
  public let raw: RawAXNode
  public let effectiveRect: SnapshotRect

  public init(raw: RawAXNode, effectiveRect: SnapshotRect) {
    self.raw = raw
    self.effectiveRect = effectiveRect
  }

  public static func reported(_ raw: RawAXNode) -> Self {
    Self(raw: raw, effectiveRect: raw.rect)
  }
}

public struct PresentedNode: Codable, Equatable {
  public let index: Int
  public let type: String
  public let label: String?
  public let identifier: String?
  public let value: String?
  public let rect: SnapshotRect
  public let enabled: Bool
  public let focused: Bool?
  public let selected: Bool?
  public let hittable: Bool
  public let depth: Int
  public let parentIndex: Int?
  public let hiddenContentAbove: Bool?
  public let hiddenContentBelow: Bool?
  public let actions: [String]?

  internal init(
    presenting raw: RawAXNode,
    rect: SnapshotRect? = nil,
    index: Int? = nil,
    depth: Int? = nil,
    parentIndex: Int?? = nil
  ) {
    self.index = index ?? raw.index
    self.type = raw.type
    self.label = raw.label
    self.identifier = raw.identifier
    self.value = raw.value
    self.rect = rect ?? raw.rect
    self.enabled = raw.enabled
    self.focused = raw.focused
    self.selected = raw.selected
    self.hittable = raw.hittable
    self.depth = depth ?? raw.depth
    self.parentIndex = parentIndex ?? raw.parentIndex
    self.hiddenContentAbove = raw.hiddenContentAbove
    self.hiddenContentBelow = raw.hiddenContentBelow
    self.actions = raw.actions
  }

  internal init(presenting node: SnapshotPresentationNode) {
    self.init(presenting: node.raw, rect: node.effectiveRect)
  }
}

public struct SnapshotPresentationResult {
  public let nodes: [PresentedNode]
  public let truncated: Bool
  public let effectiveDepth: Int?
  public let customActions: SnapshotCustomActionCoverage?
  public let qualityNodes: [PresentedNode]?

  public init(
    nodes: [PresentedNode],
    truncated: Bool,
    effectiveDepth: Int?,
    customActions: SnapshotCustomActionCoverage?,
    qualityNodes: [PresentedNode]?
  ) {
    self.nodes = nodes
    self.truncated = truncated
    self.effectiveDepth = effectiveDepth
    self.customActions = customActions
    self.qualityNodes = qualityNodes
  }
}
