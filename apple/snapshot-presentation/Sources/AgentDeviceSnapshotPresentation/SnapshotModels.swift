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
}

public struct RawAXNode: Equatable {
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

public struct SnapshotAcquisition {
  public let hint: CaptureHint
  public let nodes: [RawAXNode]
  public let truncated: Bool
  public let effectiveDepth: Int?
  public var customActions: SnapshotCustomActionCoverage?
  public let viewport: CGRect

  public init(
    hint: CaptureHint,
    nodes: [RawAXNode],
    truncated: Bool,
    effectiveDepth: Int?,
    customActions: SnapshotCustomActionCoverage? = nil,
    viewport: CGRect
  ) {
    self.hint = hint
    self.nodes = nodes
    self.truncated = truncated
    self.effectiveDepth = effectiveDepth
    self.customActions = customActions
    self.viewport = viewport
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
