import CoreGraphics
import Foundation
@testable import AgentDeviceSnapshotPresentation

/// Two trees of one screen recorded by `pnpm capture:alert-surface`, and what the rules must find in
/// them. Trees are never edited by hand. `expect` names, for each alert source, the one surface that
/// source must find in the honor-modal tree; a source it does not name must find nothing.
/// `expectModalScope` is what `ModalSurface` must read from the pair.
struct RecordedAlertSurface: Decodable {
  static let format = 2

  struct Node: Decodable {
    let index: Int
    let parentIndex: Int?
    let element: String
    let type: String
    let identifier: String
    let label: String
    let rect: FixtureRect
  }

  struct Expectation: Decodable {
    let title: String
    let buttons: [String]
  }

  /// `reading` is `modal` or `noExclusion`. A `modal` reading lists each surface by its host and root
  /// positions in the honor-modal tree, with the labels of the actions it offers, and the labels of
  /// the honor-modal tree's actions that no surface offers.
  struct ModalScopeExpectation: Decodable {
    struct Surface: Decodable {
      let host: Int
      let roots: [Int]
      let actions: [String]
    }

    let reading: String
    let surfaces: [Surface]?
    let excludedActions: [String]?
  }

  let format: Int
  let expect: [String: Expectation]
  let expectModalScope: ModalScopeExpectation
  let plain: [Node]
  let honorModal: [Node]

  static func load(_ file: URL) throws -> RecordedAlertSurface {
    let recorded = try JSONDecoder().decode(RecordedAlertSurface.self, from: Data(contentsOf: file))
    guard recorded.format == format, isPreorder(recorded.plain), isPreorder(recorded.honorModal) else {
      throw CocoaError(.coderReadCorrupt)
    }
    return recorded
  }

  // Each node's index is its position, and its parent comes before it.
  private static func isPreorder(_ nodes: [Node]) -> Bool {
    !nodes.isEmpty && nodes.indices.allSatisfy { position in
      let node = nodes[position]
      guard node.index == position else { return false }
      guard let parent = node.parentIndex else { return position == 0 }
      return parent >= 0 && parent < position
    }
  }

  static func tree(_ nodes: [Node], at root: Int = 0) -> AlertSurfaceNode {
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

  static func modalScopeNodes(_ nodes: [Node]) -> [ModalScopeNode] {
    nodes.map { node in
      ModalScopeNode(
        element: node.element,
        parentElement: node.parentIndex.map { nodes[$0].element },
        frame: node.rect.cgRect
      )
    }
  }
}

func recordedAlertSurfaces() throws -> [(name: String, recorded: RecordedAlertSurface)] {
  try FileManager.default.contentsOfDirectory(at: alertSurfaceCorpusURL(), includingPropertiesForKeys: nil)
    .filter { $0.pathExtension == "json" }
    .sorted { $0.lastPathComponent < $1.lastPathComponent }
    .map { ($0.lastPathComponent, try RecordedAlertSurface.load($0)) }
}

private func alertSurfaceCorpusURL(from filePath: String = #filePath) -> URL {
  URL(fileURLWithPath: filePath)
    .deletingLastPathComponent() // AgentDeviceSnapshotPresentationTests
    .deletingLastPathComponent() // Tests
    .appendingPathComponent("AlertSurfaceCorpus")
}
