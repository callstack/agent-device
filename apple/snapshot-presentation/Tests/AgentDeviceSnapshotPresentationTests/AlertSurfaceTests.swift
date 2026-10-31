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

  struct NearMiss: Decodable, Equatable {
    let type: String
    let identifier: String
    let label: String
    let buttons: [String]

    init(_ nearMiss: AlertSurfaceNearMiss) {
      type = nearMiss.type
      identifier = nearMiss.identifier
      label = nearMiss.label
      buttons = nearMiss.buttons
    }
  }

  let capture: [String: String]
  let expect: [String: Expectation]
  /// The near misses every alert rule leaves unexplained, in document order.
  let nearMisses: [NearMiss]?
  /// The near misses that appear when the named source's rule is dropped, so a rule that stops
  /// matching is reported instead of silently lost.
  let nearMissesOmitting: [String: [NearMiss]]?
  let nodes: [Node]

  enum CodingKeys: String, CodingKey {
    case capture
    case expect
    case nearMisses
    case nearMissesOmitting
    case nodes
  }

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
      // Every fixture states what the near-miss rule reports for it, so a screen nobody checked
      // cannot pass by silence; the assertion below prints what the rule found.
      let recordedNearMisses = try XCTUnwrap(
        recorded.nearMisses,
        "\(name): record \"nearMisses\" as what the rule reports here, [] when it reports none"
      )
      XCTAssertEqual(
        AlertSurface.nearMisses(in: root, viewport: root.frame).map(RecordedAlertSurface.NearMiss.init),
        recordedNearMisses,
        "\(name): near misses with every rule on"
      )
      for (dropped, expected) in recorded.nearMissesOmitting ?? [:] {
        let source = try XCTUnwrap(AlertSurfaceSource(rawValue: dropped), "\(name): unknown source \(dropped)")
        let found = AlertSurface.nearMisses(
          in: root,
          viewport: root.frame,
          sources: AlertSurfaceSource.allCases.filter { $0 != source }
        )
        XCTAssertEqual(found.map(RecordedAlertSurface.NearMiss.init), expected, "\(name): near misses omitting \(dropped)")
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

  func testANearMissNeedsItsOwnCopyAndFewButtonsAndNoFurniture() {
    let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)
    func button(_ label: String, _ y: CGFloat) -> AlertSurfaceNode {
      AlertSurfaceNode(
        type: "Button", identifier: "", label: label,
        frame: CGRect(x: 200, y: y, width: 60, height: 30), children: [])
    }
    func copy(_ text: String) -> AlertSurfaceNode {
      AlertSurfaceNode(
        type: "StaticText", identifier: "", label: text,
        frame: CGRect(x: 20, y: 120, width: 240, height: 30), children: [])
    }
    func container(frame: CGRect, children: [AlertSurfaceNode]) -> AlertSurfaceNode {
      AlertSurfaceNode(type: "Other", identifier: "Panel", label: "", frame: frame, children: children)
    }
    let prompt = container(
      frame: CGRect(x: 20, y: 110, width: 340, height: 130),
      children: [copy("Open this page?"), button("Cancel", 200), button("Open", 200)]
    )
    XCTAssertEqual(
      AlertSurface.nearMisses(in: prompt, viewport: viewport),
      [AlertSurfaceNearMiss(
        type: "Other", identifier: "Panel", label: "Open this page?", buttons: ["Cancel", "Open"]
      )]
    )

    // The container's own label names it, so it needs no text node.
    let labelled = AlertSurfaceNode(
      type: "Other", identifier: "Panel", label: "Share sheet",
      frame: CGRect(x: 20, y: 110, width: 340, height: 130),
      children: [button("Copy", 200), button("Open", 200)]
    )
    XCTAssertEqual(AlertSurface.nearMisses(in: labelled, viewport: viewport).map(\.label), ["Share sheet"])

    // A cluster of buttons with no copy of its own is a bar, not a prompt.
    let bar = container(
      frame: CGRect(x: 0, y: 800, width: 402, height: 74),
      children: [button("Back", 820), button("Bookmarks", 820), button("Tabs", 820)]
    )
    XCTAssertTrue(AlertSurface.nearMisses(in: bar, viewport: viewport).isEmpty)

    // An action that names nothing is a row in a list, not a choice a prompt offers.
    let suggestions = container(
      frame: CGRect(x: 20, y: 110, width: 340, height: 200),
      children: [
        copy("Suggestions"), button("Search", 200),
        button("", 240), button("Clear", 280),
      ]
    )
    XCTAssertTrue(AlertSurface.nearMisses(in: suggestions, viewport: viewport).isEmpty)

    // Words an action already carries are not copy the container asks. A web page's navigation
    // cell repeats the words of the link it wraps, so it is page content, not a prompt.
    let navItem = AlertSurfaceNode(
      type: "Other", identifier: "", label: "Sklep",
      frame: CGRect(x: 20, y: 110, width: 340, height: 60),
      children: [
        AlertSurfaceNode(
          type: "Link", identifier: "", label: "Sklep",
          frame: CGRect(x: 20, y: 110, width: 60, height: 30),
          children: [copy("Sklep")]
        ),
        button("Menu Sklep", 140),
      ]
    )
    XCTAssertTrue(AlertSurface.nearMisses(in: navItem, viewport: viewport).isEmpty)

    // Too many actions is a menu, too few is not a choice.
    let many = container(
      frame: CGRect(x: 20, y: 110, width: 340, height: 300),
      children: [copy("Choose")] + (1...5).map { button("Act \($0)", 200) }
    )
    XCTAssertTrue(AlertSurface.nearMisses(in: many, viewport: viewport).isEmpty)
    let one = container(
      frame: CGRect(x: 20, y: 110, width: 340, height: 130),
      children: [copy("Done"), button("OK", 200)]
    )
    XCTAssertTrue(AlertSurface.nearMisses(in: one, viewport: viewport).isEmpty)

    // The screen's own content, and a surface that covers the keyboard, are never near misses.
    let fullBleed = container(
      frame: CGRect(x: 0, y: 0, width: 402, height: 874),
      children: [copy("Feed"), button("Like", 800), button("Share", 800)]
    )
    XCTAssertTrue(AlertSurface.nearMisses(in: fullBleed, viewport: viewport).isEmpty)
    let overKeyboard = container(
      frame: CGRect(x: 20, y: 500, width: 340, height: 300),
      children: [
        copy("Suggest"), button("Paste", 700), button("Lookup", 700),
        AlertSurfaceNode(
          type: "Keyboard", identifier: "", label: "",
          frame: CGRect(x: 0, y: 640, width: 402, height: 234), children: []),
      ]
    )
    XCTAssertTrue(AlertSurface.nearMisses(in: overKeyboard, viewport: viewport).isEmpty)
  }

  func testAReportedNearMissIsNotDescendedIntoAndAnAnsweredSurfaceIsNotReported() {
    let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)
    func button(_ label: String) -> AlertSurfaceNode {
      AlertSurfaceNode(
        type: "Button", identifier: "", label: label,
        frame: CGRect(x: 200, y: 200, width: 60, height: 30), children: [])
    }
    let inner = AlertSurfaceNode(
      type: "Other", identifier: "Inner", label: "Keep this note?",
      frame: CGRect(x: 40, y: 130, width: 300, height: 110),
      children: [button("Delete"), button("Keep")]
    )
    let outer = AlertSurfaceNode(
      type: "Other", identifier: "Outer", label: "Save draft?",
      frame: CGRect(x: 20, y: 110, width: 340, height: 150),
      children: [inner, button("Cancel"), button("Save")]
    )
    XCTAssertEqual(AlertSurface.nearMisses(in: outer, viewport: viewport).map(\.identifier), ["Outer"])

    // A container a source answers is explained by that source, and so is everything inside it.
    let alert = AlertSurfaceNode(
      type: "Alert", identifier: "", label: "Allow access?",
      frame: CGRect(x: 40, y: 300, width: 322, height: 150),
      children: [
        AlertSurfaceNode(
          type: "Other", identifier: "Inner", label: "Allow access?",
          frame: CGRect(x: 60, y: 320, width: 282, height: 110),
          children: [button("Don’t Allow"), button("Allow")]),
      ]
    )
    XCTAssertTrue(AlertSurface.nearMisses(in: alert, viewport: viewport).isEmpty)
  }

  func testARowListIsNotANearMissBecauseItsTextSitsInsideItsActions() {
    let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)
    func text(_ label: String, _ y: CGFloat, height: CGFloat = 20) -> AlertSurfaceNode {
      AlertSurfaceNode(
        type: "StaticText", identifier: "", label: label,
        frame: CGRect(x: 60, y: y, width: 240, height: height), children: [])
    }
    func row(_ title: String, _ subtitle: String, _ y: CGFloat) -> AlertSurfaceNode {
      AlertSurfaceNode(
        type: "Cell", identifier: "", label: title,
        frame: CGRect(x: 20, y: y, width: 340, height: 60),
        children: [text(title, y + 4), text(subtitle, y + 28)]
      )
    }
    // Two rows, each with a label and its own subtitle, and no copy outside them. Every word here
    // belongs to a cell, so the container asks nothing.
    let list = AlertSurfaceNode(
      type: "Other", identifier: "Panel", label: "",
      frame: CGRect(x: 20, y: 110, width: 340, height: 130),
      children: [row("Notifications", "Daily digest", 110), row("Sound", " Alerts only", 180)]
    )
    XCTAssertTrue(AlertSurface.nearMisses(in: list, viewport: viewport).isEmpty)

    // The same container with copy beside the rows is the prompt it was not.
    let asked = AlertSurfaceNode(
      type: "Other", identifier: "Panel", label: "",
      frame: CGRect(x: 20, y: 110, width: 340, height: 160),
      children: [
        text("Change both settings?", 110, height: 20),
        row("Notifications", "Daily digest", 140),
        row("Sound", "Alerts only", 210),
      ]
    )
    XCTAssertEqual(AlertSurface.nearMisses(in: asked, viewport: viewport).map(\.label), ["Change both settings?"])
  }

  func testNearMissReportsAreCappedAtFourInDocumentOrder() {
    let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)
    func prompt(_ name: String, _ y: CGFloat) -> AlertSurfaceNode {
      func button(_ label: String, _ buttonY: CGFloat) -> AlertSurfaceNode {
        AlertSurfaceNode(
          type: "Button", identifier: "", label: label,
          frame: CGRect(x: 40, y: buttonY, width: 120, height: 30), children: [])
      }
      func copy(_ text: String, _ copyY: CGFloat) -> AlertSurfaceNode {
        AlertSurfaceNode(
          type: "StaticText", identifier: "", label: text,
          frame: CGRect(x: 40, y: copyY, width: 240, height: 30), children: [])
      }
      return AlertSurfaceNode(
        type: "Other", identifier: name, label: "",
        frame: CGRect(x: 20, y: y, width: 340, height: 130),
        children: [copy("Choose \(name)", y + 10), button("Cancel", y + 50), button("OK", y + 90)]
      )
    }
    let screen = AlertSurfaceNode(
      type: "Application", identifier: "", label: "App",
      frame: CGRect(x: 0, y: 0, width: 402, height: 874),
      children: (1...6).map { prompt("Panel\($0)", CGFloat(100 * $0)) }
    )
    let reported = AlertSurface.nearMisses(in: screen, viewport: viewport)
    XCTAssertEqual(reported.count, AlertSurface.nearMissMaxReports)
    XCTAssertEqual(reported.map(\.label), ["Choose Panel1", "Choose Panel2", "Choose Panel3", "Choose Panel4"])
  }

  // The scroll-indicator label is never the text a container asks, whichever of the two places a
  // copy can come from it lands. Recorded trees report the indicator as an `Other` node, so the
  // first case pins what the rule sees today; the other two pin the label itself, which is what the
  // rule is about and is the shape a re-typed indicator would arrive in.
  func testAScrollIndicatorIsNotAPromptsCopy() {
    let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)
    func cluster(_ copyNode: AlertSurfaceNode, label containerLabel: String = "") -> AlertSurfaceNode {
      AlertSurfaceNode(
        type: "Other", identifier: "Panel", label: containerLabel,
        frame: CGRect(x: 20, y: 110, width: 340, height: 130),
        children: [
          copyNode,
          AlertSurfaceNode(
            type: "Button", identifier: "", label: "Cancel",
            frame: CGRect(x: 40, y: 160, width: 120, height: 30), children: []),
          AlertSurfaceNode(
            type: "Button", identifier: "", label: "OK",
            frame: CGRect(x: 40, y: 200, width: 120, height: 30), children: []),
        ]
      )
    }
    func scrolled(_ type: String, _ label: String) -> AlertSurfaceNode {
      AlertSurfaceNode(
        type: type, identifier: "", label: label,
        frame: CGRect(x: 20, y: 120, width: 20, height: 100), children: [])
    }

    // The shape the recorded trees show: an `Other` node labelled for its axis and extent.
    XCTAssertTrue(
      AlertSurface.nearMisses(
        in: cluster(scrolled("Other", "Vertical scroll bar, 8 pages")), viewport: viewport).isEmpty)
    // A text node carrying that label, and the container labelled with it itself.
    XCTAssertTrue(
      AlertSurface.nearMisses(
        in: cluster(scrolled("StaticText", "Vertical scroll bar, 8 pages")), viewport: viewport).isEmpty)
    XCTAssertTrue(
      AlertSurface.nearMisses(
        in: cluster(scrolled("Other", ""), label: "Horizontal scroll bar, 1 page"),
        viewport: viewport).isEmpty)

    // A question in the same places is the copy the rule is for, so the guard cannot pass by
    // refusing everything.
    XCTAssertEqual(
      AlertSurface.nearMisses(
        in: cluster(scrolled("StaticText", "Save this password?")), viewport: viewport).map(\.label),
      ["Save this password?"])
  }
}

private func alertSurfaceCorpusURL(from filePath: String = #filePath) -> URL {
  URL(fileURLWithPath: filePath)
    .deletingLastPathComponent() // AgentDeviceSnapshotPresentationTests
    .deletingLastPathComponent() // Tests
    .appendingPathComponent("AlertSurfaceCorpus")
}
