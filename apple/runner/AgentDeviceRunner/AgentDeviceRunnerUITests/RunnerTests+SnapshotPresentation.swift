import Foundation

/// Backend-owned snapshot output before it crosses the presentation seam.
///
/// Step 1 deliberately carries the fields computed by today's backend-specific implementations.
/// Later #1797 migration steps move those decisions behind `SnapshotPresentation` without changing
/// either the acquisition interface or the wire-facing `PresentedNode` type.
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
    index = raw.index
    type = raw.type
    label = raw.label
    identifier = raw.identifier
    value = raw.value
    rect = raw.rect
    enabled = raw.enabled
    focused = raw.focused
    selected = raw.selected
    hittable = raw.hittable
    depth = raw.depth
    parentIndex = raw.parentIndex
    hiddenContentAbove = raw.hiddenContentAbove
    hiddenContentBelow = raw.hiddenContentBelow
    actions = raw.actions
  }
}

enum SnapshotPresentation {
  /// Transitional adapter for #1797 migration steps 1 and 2. Acquisition still computes today's
  /// backend-specific decisions; this seam changes construction authority without changing output.
  static func preservingCurrentSemantics(_ nodes: [RawAXNode]) -> [PresentedNode] {
    nodes.map(PresentedNode.init(presenting:))
  }

  /// Explicit carve-out for selector queries and system-modal reads that intentionally return one
  /// already-resolved element instead of traversing a snapshot backend.
  static func singleElementRead(_ node: RawAXNode) -> PresentedNode {
    PresentedNode(presenting: node)
  }
}

extension DataPayload {
  init(presenting nodes: [RawAXNode], truncated: Bool) {
    self.init(
      nodes: SnapshotPresentation.preservingCurrentSemantics(nodes),
      truncated: truncated
    )
  }
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
import XCTest

extension RunnerTests {
  func testSnapshotPresentationPreservesCurrentWireShape() throws {
    // Non-vacuity: setting PresentedNode.label to nil made this test execute once and fail on the
    // missing `"label":"Continue"` field before the production mapping was restored.
    let raw = RawAXNode(
      index: 3,
      type: "Button",
      label: "Continue",
      identifier: "continue-button",
      value: "Ready",
      rect: SnapshotRect(x: 10, y: 20, width: 100, height: 44),
      enabled: true,
      focused: true,
      selected: true,
      hittable: true,
      depth: 2,
      parentIndex: 1,
      hiddenContentAbove: true,
      hiddenContentBelow: true,
      actions: ["Open menu"]
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]

    let encoded = try encoder.encode(SnapshotPresentation.preservingCurrentSemantics([raw]))

    XCTAssertEqual(
      String(decoding: encoded, as: UTF8.self),
      #"[{"actions":["Open menu"],"depth":2,"enabled":true,"focused":true,"hiddenContentAbove":true,"hiddenContentBelow":true,"hittable":true,"identifier":"continue-button","index":3,"label":"Continue","parentIndex":1,"rect":{"height":44,"width":100,"x":10,"y":20},"selected":true,"type":"Button","value":"Ready"}]"#
    )
  }
}
#endif
