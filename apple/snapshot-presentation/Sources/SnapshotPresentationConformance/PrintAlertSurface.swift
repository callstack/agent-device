import AgentDeviceSnapshotPresentation
import CoreGraphics
import Foundation

import RecordingSupport

func printAlertSurface(_ arguments: [String]) throws {
  guard let file = arguments.first, arguments.count <= 2,
    arguments.count == 1 || ["honorModal", "plain"].contains(arguments[1])
  else {
    throw NSError(domain: "print:alert-surface", code: 1, userInfo: [
      NSLocalizedDescriptionKey: "Usage: pnpm print:alert-surface <recording.json> [honorModal|plain]"
    ])
  }
  let recording = try RawAlertRecording.load(URL(fileURLWithPath: file))
  let plain = RawAlertRecording.modalScopeNodes(recording.plain)
  let honorModal = RawAlertRecording.modalScopeNodes(recording.honorModal)
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
