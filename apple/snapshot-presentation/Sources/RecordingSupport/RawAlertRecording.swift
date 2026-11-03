import Foundation
import AgentDeviceSnapshotPresentation

package struct RawAlertRecording: Decodable {
  package struct Node: Decodable {
    package let index: Int
    package let parentIndex: Int?
    package let element: String
    package let type: String
    package let identifier: String
    package let label: String
    package let rect: FixtureRect
  }

  let format: Int
  package let plain: [Node]
  package let honorModal: [Node]

  package static func load(_ file: URL) throws -> RawAlertRecording {
    let recording = try JSONDecoder().decode(Self.self, from: Data(contentsOf: file))
    func invalid(_ detail: String) -> NSError {
      NSError(domain: "alert-recording", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(file.path): \(detail)"])
    }
    guard recording.format == 2 else { throw invalid("format \(recording.format) is not 2. Capture it again.") }
    for (name, nodes) in [("plain", recording.plain), ("honorModal", recording.honorModal)] {
      guard !nodes.isEmpty else { throw invalid("\(name): empty tree") }
      for (position, node) in nodes.enumerated() {
        guard node.index == position, node.parentIndex.map({ $0 >= 0 && $0 < position }) ?? (position == 0) else {
          throw invalid("\(name) node \(position): invalid preorder index or parent")
        }
      }
    }
    return recording
  }

  package static func tree(_ nodes: [Node], at root: Int = 0) -> AlertSurfaceNode {
    var children: [Int: [Int]] = [:]
    for node in nodes {
      if let parent = node.parentIndex { children[parent, default: []].append(node.index) }
    }
    func build(_ index: Int) -> AlertSurfaceNode {
      let node = nodes[index]
      return AlertSurfaceNode(
        type: node.type,
        identifier: node.identifier,
        label: node.label,
        frame: node.rect.cgRect,
        children: (children[index] ?? []).map(build)
      )
    }
    return build(root)
  }

  package static func modalScopeNodes(_ nodes: [Node]) -> [ModalScopeNode] {
    nodes.map { node in
      ModalScopeNode(
        element: node.element,
        parentElement: node.parentIndex.map { nodes[$0].element },
        frame: node.rect.cgRect
      )
    }
  }
}
