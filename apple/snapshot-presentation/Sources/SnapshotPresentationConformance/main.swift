import AgentDeviceSnapshotPresentation
import Foundation
import CoreGraphics

private struct Input: Decodable {
  struct Node: Decodable {
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
  }

  let projection: String
  let interactiveOnly: Bool
  let depth: Int?
  let scope: String?
  let viewport: SnapshotRect
  let nodes: [Node]
}

private struct Output: Encodable {
  let nodes: [PresentedNode]
}

private let input = try JSONDecoder().decode(
  Input.self,
  from: FileHandle.standardInput.readDataToEndOfFile()
)
private let options = PresentationOptions(
  interactiveOnly: input.interactiveOnly,
  depth: input.depth,
  scope: input.scope,
  raw: input.projection == CaptureHint.Projection.raw.rawValue
)
private let acquisition = SnapshotAcquisition(
  hint: SnapshotPresentation.captureHint(for: options),
  nodes: input.nodes.map { node in
    RawAXNode(
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
      hiddenContentAbove: node.hiddenContentAbove,
      hiddenContentBelow: node.hiddenContentBelow
    )
  },
  truncated: false,
  effectiveDepth: nil,
  viewport: input.viewport.cgRect
)
private let result = try SnapshotPresentation.present(acquisition, options: options)
  ?? SnapshotPresentationResult(
    nodes: [],
    truncated: false,
    effectiveDepth: nil,
    customActions: nil,
    qualityNodes: nil
  )
private let output = try JSONEncoder().encode(Output(nodes: result.nodes))
FileHandle.standardOutput.write(output)
FileHandle.standardOutput.write(Data([0x0a]))
