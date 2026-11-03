import AgentDeviceSnapshotPresentation
import CoreGraphics
import Foundation

private struct Recording: Decodable {
  struct Rect: Decodable {
    let infinite: Bool?
    let nonFinite: Bool?
    let x: Double?
    let y: Double?
    let width: Double?
    let height: Double?

    func frame() throws -> CGRect {
      if infinite == true { return .infinite }
      if nonFinite == true {
        return CGRect(x: -.infinity, y: -.infinity, width: .infinity, height: .infinity)
      }
      guard let x, let y, let width, let height else { throw CocoaError(.coderReadCorrupt) }
      return CGRect(x: x, y: y, width: width, height: height)
    }
  }

  struct Node: Decodable {
    let index: Int
    let parentIndex: Int?
    let element: String
    let type: String
    let identifier: String
    let label: String
    let rect: Rect
  }

  let format: Int
  let plain: [Node]
  let honorModal: [Node]

  func scope(_ nodes: [Node], allowEmpty: Bool) throws -> [ModalScopeNode] {
    guard allowEmpty || !nodes.isEmpty else { throw CocoaError(.coderReadCorrupt) }
    return try nodes.enumerated().map { position, node in
      guard node.index == position else { throw CocoaError(.coderReadCorrupt) }
      if let parent = node.parentIndex {
        guard parent >= 0 && parent < position else { throw CocoaError(.coderReadCorrupt) }
      } else if position != 0 {
        throw CocoaError(.coderReadCorrupt)
      }
      return ModalScopeNode(
        element: node.element,
        parentElement: node.parentIndex.map { nodes[$0].element },
        frame: try node.rect.frame()
      )
    }
  }
}

func printAlertSurface(_ arguments: [String]) throws {
  guard let file = arguments.first, arguments.count <= 2,
    arguments.count == 1 || ["honorModal", "plain"].contains(arguments[1])
  else {
    throw NSError(domain: "print:alert-surface", code: 1, userInfo: [
      NSLocalizedDescriptionKey: "Usage: pnpm print:alert-surface <recording.json> [honorModal|plain]"
    ])
  }
  let recording = try JSONDecoder().decode(Recording.self, from: Data(contentsOf: URL(fileURLWithPath: file)))
  guard recording.format == 2 else {
    throw NSError(domain: "print:alert-surface", code: 1, userInfo: [
      NSLocalizedDescriptionKey: "\(file): format \(recording.format) is not 2. Capture it again."
    ])
  }
  let plain = try recording.scope(recording.plain, allowEmpty: false)
  let honorModal = try recording.scope(recording.honorModal, allowEmpty: true)
  let reading = ModalSurface.read(
    plain: plain, honorModal: honorModal, confirmingHonorModal: honorModal, truncated: false
  )
  let answer: String
  var markers: [Int: String] = [:]
  switch reading {
  case let .modal(surfaces):
    answer = "modal"
    for surface in surfaces {
      markers[surface.host] = "  [surface roots: \(surface.roots.map(String.init).joined(separator: ", "))]"
    }
  case .noExclusion:
    answer = "noExclusion"
  case let .unknown(reason):
    answer = "unknown(\(reason))"
  }
  print("ModalSurface reads (the rule's answer, not ground truth): \(answer)")
  let printPlain = arguments.last == "plain"
  let nodes = printPlain ? recording.plain : recording.honorModal
  var depths: [Int] = []
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  for node in nodes {
    let depth = node.parentIndex.map { depths[$0] + 1 } ?? 0
    depths.append(depth)
    let label = String(decoding: try encoder.encode(node.label), as: UTF8.self)
    let index = String(repeating: " ", count: max(0, 4 - String(node.index).count)) + String(node.index)
    let marker = printPlain ? "" : markers[node.index] ?? ""
    print("\(index) \(String(repeating: "  ", count: depth))\(node.type) \(label)\(marker)")
  }
}
