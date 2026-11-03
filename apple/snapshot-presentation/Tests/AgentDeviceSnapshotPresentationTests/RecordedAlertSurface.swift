import CoreGraphics
import Foundation
@testable import AgentDeviceSnapshotPresentation
import RecordingSupport

/// Two trees of one screen recorded by `pnpm capture:alert-surface`, and what the rules must find in
/// them. Trees are never edited by hand. `expect` names, for each alert source, the one surface that
/// source must find in the honor-modal tree; a source it does not name must find nothing.
/// `expectModalScope` is what `ModalSurface` must read from the pair.
struct RecordedAlertSurface {
  typealias Node = RawAlertRecording.Node
  struct Expectation: Decodable {
    let title: String
    let buttons: [String]
  }

  /// `reading` is `modal`, `noExclusion`, or `unknown` with the `reason` `duplicatedChild`. A
  /// `modal` reading lists each surface by its host and root positions in the honor-modal tree, with
  /// the labels of the actions it offers, and the labels of the honor-modal tree's actions that no
  /// surface offers.
  struct ModalScopeExpectation: Decodable {
    struct Surface: Decodable {
      let host: Int
      let roots: [Int]
      let actions: [String]
    }

    let reading: String
    let reason: String?
    let surfaces: [Surface]?
    let excludedActions: [String]?
  }

  private struct Expectations: Decodable {
    let expect: [String: Expectation]
    let expectModalScope: ModalScopeExpectation
  }

  private let recording: RawAlertRecording
  private let expectations: Expectations
  var expect: [String: Expectation] { expectations.expect }
  var expectModalScope: ModalScopeExpectation { expectations.expectModalScope }
  var plain: [Node] { recording.plain }
  var honorModal: [Node] { recording.honorModal }

  static func load(_ file: URL) throws -> RecordedAlertSurface {
    RecordedAlertSurface(
      recording: try RawAlertRecording.load(file),
      expectations: try JSONDecoder().decode(Expectations.self, from: Data(contentsOf: file))
    )
  }

  static func tree(_ nodes: [Node], at root: Int = 0) -> AlertSurfaceNode {
    RawAlertRecording.tree(nodes, at: root)
  }
  static let modalScopeNodes = RawAlertRecording.modalScopeNodes

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
