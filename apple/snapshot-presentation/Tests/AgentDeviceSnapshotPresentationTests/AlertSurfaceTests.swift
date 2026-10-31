import CoreGraphics
import Foundation
import XCTest
@testable import AgentDeviceSnapshotPresentation

/// A tree recorded by `pnpm capture:alert-surface`, and what the alert rules must find in it.
/// `nodes` are never edited by hand. `expect` names, for each source, the one surface that source
/// must find; a source it does not name must find nothing.
private struct RecordedAlertSurface: Decodable {
  struct Node: Decodable {
    let index: Int
    let parentIndex: Int?
    let type: String
    let identifier: String
    let label: String
    let rect: FixtureRect
  }

  struct Expectation: Decodable {
    let title: String
    let buttons: [String]
  }

  let capture: [String: String]
  let expect: [String: Expectation]
  let nodes: [Node]

  func tree() throws -> AlertSurfaceNode {
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
    // A preorder list: each node's index is its position, and its parent comes before it.
    let wellFormed = nodes.indices.allSatisfy { position in
      let node = nodes[position]
      guard node.index == position else { return false }
      guard let parent = node.parentIndex else { return position == 0 }
      return parent >= 0 && parent < position
    }
    guard wellFormed, !nodes.isEmpty else { throw CocoaError(.coderReadCorrupt) }
    return build(0)
  }
}

final class AlertSurfaceTests: XCTestCase {
  func testEveryRecordedSurfaceIsFoundByItsSourceOnly() throws {
    let files = try FileManager.default.contentsOfDirectory(at: alertSurfaceCorpusURL(), includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "json" }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
    XCTAssertFalse(files.isEmpty)
    let decoder = JSONDecoder()
    for file in files {
      let name = file.lastPathComponent
      let recorded = try decoder.decode(RecordedAlertSurface.self, from: Data(contentsOf: file))
      let root = try recorded.tree()
      for key in recorded.expect.keys {
        XCTAssertNotNil(AlertSurfaceSource(rawValue: key), "\(name): unknown source \(key)")
      }
      for source in AlertSurfaceSource.allCases {
        let found = AlertSurface.candidates(in: root, source: source, viewport: root.frame)
          .map { AlertSurface.presentation(of: $0) }
        let expected = recorded.expect[source.rawValue]
        XCTAssertEqual(found.map(\.title), expected.map { [$0.title] } ?? [], "\(name): \(source) title")
        XCTAssertEqual(found.map(\.buttons), expected.map { [$0.buttons] } ?? [], "\(name): \(source) buttons")
      }
    }
  }

  func testAModalIsPlacedInItsOwnPanelWindow() {
    let outerPanel = CGRect(x: 0, y: 0, width: 466, height: 678)
    let innerPanel = CGRect(x: 0, y: 0, width: 951, height: 669)
    let innerPanelAlert = CGRect(x: 341, y: 250, width: 270, height: 170)
    XCTAssertTrue(AlertSurface.isPlaced(innerPanelAlert, in: innerPanel))
    XCTAssertFalse(AlertSurface.isPlaced(innerPanelAlert, in: outerPanel))
    XCTAssertFalse(AlertSurface.isPlaced(innerPanelAlert, in: CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 669)))
    XCTAssertFalse(AlertSurface.isPlaced(.zero, in: innerPanel))
  }

  func testAnInnerPanelAlertIsPlacedInItsWindowNotTheApplicationFrame() {
    let alert = AlertSurfaceNode(type: "Alert", identifier: "", label: "", frame: CGRect(x: 341, y: 250, width: 270, height: 170), children: [])
    let innerPanel = AlertSurfaceNode(type: "Window", identifier: "", label: "", frame: CGRect(x: 0, y: 0, width: 951, height: 669), children: [alert])
    let root = AlertSurfaceNode(type: "Application", identifier: "", label: "", frame: CGRect(x: 0, y: 0, width: 466, height: 678), children: [innerPanel])
    XCTAssertEqual(AlertSurface.candidates(in: root, source: .appAlert, viewport: root.frame), [alert])
  }

  func testADismissPopupWindowIsPlacedInTheBoxItSitsIn() {
    let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)
    func popup(x: CGFloat) -> AlertSurfaceNode {
      let frame = CGRect(x: x, y: 0, width: 402, height: 874)
      let marker = AlertSurfaceNode(type: "Other", identifier: "", label: "dismiss popup", frame: frame, children: [])
      return AlertSurfaceNode(type: "Window", identifier: "", label: "", frame: frame, children: [marker])
    }
    XCTAssertEqual(AlertSurface.candidates(in: popup(x: 0), source: .dismissPopup, viewport: viewport).count, 1)
    XCTAssertTrue(AlertSurface.candidates(in: popup(x: 1000), source: .dismissPopup, viewport: viewport).isEmpty)
  }

  func testTheDismissPopupMarkerMatchesTheWholeLabelInAnyCase() {
    XCTAssertTrue(AlertSurface.isDismissPopupMarker(" Dismiss Popup "))
    XCTAssertFalse(AlertSurface.isDismissPopupMarker("dismiss popup now"))
  }
}

private func alertSurfaceCorpusURL(from filePath: String = #filePath) -> URL {
  URL(fileURLWithPath: filePath)
    .deletingLastPathComponent() // AgentDeviceSnapshotPresentationTests
    .deletingLastPathComponent() // Tests
    .appendingPathComponent("AlertSurfaceCorpus")
}
