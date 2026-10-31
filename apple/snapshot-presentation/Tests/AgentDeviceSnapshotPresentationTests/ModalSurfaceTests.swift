import CoreGraphics
import XCTest
@testable import AgentDeviceSnapshotPresentation

final class ModalSurfaceTests: XCTestCase {
  func testEveryRecordingReadsItsExpectedSurfacesAndActions() throws {
    let recordings = try recordedAlertSurfaces()
    XCTAssertFalse(recordings.isEmpty)
    for (name, recorded) in recordings {
      let honorModal = RecordedAlertSurface.modalScopeNodes(recorded.honorModal)
      let reading = ModalSurface.read(
        plain: RecordedAlertSurface.modalScopeNodes(recorded.plain),
        honorModal: honorModal,
        confirmingHonorModal: honorModal,
        truncated: false
      )
      let expected = recorded.expectModalScope
      switch reading {
      case .noExclusion:
        XCTAssertEqual(expected.reading, "noExclusion", name)
      case let .modal(surfaces):
        XCTAssertEqual(expected.reading, "modal", name)
        let expectedSurfaces = try XCTUnwrap(expected.surfaces, name)
        XCTAssertEqual(surfaces.map(\.host), expectedSurfaces.map(\.host), "\(name): hosts")
        XCTAssertEqual(surfaces.map(\.roots), expectedSurfaces.map(\.roots), "\(name): roots")
        let offered = surfaces.map { surface in
          surface.roots.flatMap { ModalSurface.actions(in: RecordedAlertSurface.tree(recorded.honorModal, at: $0)) }
        }
        XCTAssertEqual(offered.map { $0.map(\.label) }, expectedSurfaces.map(\.actions), "\(name): actions")
        var excluded = ModalSurface.actions(in: RecordedAlertSurface.tree(recorded.honorModal))
        for action in offered.joined() {
          excluded.remove(at: try XCTUnwrap(excluded.firstIndex(of: action), "\(name): \(action.label)"))
        }
        XCTAssertEqual(excluded.map(\.label), expected.excludedActions, "\(name): excluded actions")
      case .unknown:
        XCTFail("\(name): \(reading)")
      }
    }
  }

  private let screen = CGRect(x: 0, y: 0, width: 402, height: 874)

  private func node(_ element: String, _ parent: String?) -> ModalScopeNode {
    ModalScopeNode(element: element, parentElement: parent, frame: screen)
  }

  private func read(_ plain: [ModalScopeNode], _ honorModal: [ModalScopeNode], truncated: Bool = false) -> ModalSurfaceReading {
    ModalSurface.read(plain: plain, honorModal: honorModal, confirmingHonorModal: honorModal, truncated: truncated)
  }

  // A window presents a sheet over its content, and the sheet presents an alert over its own
  // content. Its dimming view stays in the honor-modal read beside the sheet.
  private var sheetUnderAlert: [ModalScopeNode] {
    [
      node("app", nil),
      node("window", "app"),
      node("content", "window"),
      node("dimming", "window"),
      node("sheet", "window"),
      node("sheetContent", "sheet"),
      node("alert", "sheet"),
      node("cancel", "alert"),
    ]
  }

  func testANestedModalIsTheSurfaceWithoutTheUnderlyingModalsControls() {
    let honorModal = sheetUnderAlert.filter { !["content", "sheetContent"].contains($0.element) }
    // app 0, window 1, dimming 2, sheet 3, alert 4
    XCTAssertEqual(read(sheetUnderAlert, honorModal), .modal([ModalSurface(host: 3, roots: [4])]))
  }

  func testAModalOverContentKeepsEveryChildItsHostKept() {
    let plain = Array(sheetUnderAlert.prefix(6))
    let honorModal = plain.filter { $0.element != "content" }
    XCTAssertEqual(read(plain, honorModal), .modal([ModalSurface(host: 1, roots: [2, 3])]))
  }

  func testModalsOnTwoPanelsAreSeparateSurfaces() {
    let plain = [
      node("app", nil),
      node("outer", "app"),
      node("outerContent", "outer"),
      node("outerAlert", "outer"),
      node("inner", "app"),
      node("innerContent", "inner"),
      node("innerAlert", "inner"),
    ]
    let honorModal = plain.filter { !$0.element.hasSuffix("Content") }
    XCTAssertEqual(
      read(plain, honorModal),
      .modal([ModalSurface(host: 1, roots: [2]), ModalSurface(host: 3, roots: [4])])
    )
  }

  // One element is listed under two parents. Only the occurrence under the removed content goes,
  // so the kept occurrence must not read as a host that lost children.
  func testARemovedOccurrenceOfASharedElementIsNotAnExclusion() {
    let plain = [
      node("app", nil),
      node("window", "app"),
      node("content", "window"),
      node("close", "content"),
      node("closeChild", "close"),
      node("sheet", "window"),
      node("close", "sheet"),
      node("closeChild", "close"),
    ]
    let honorModal = [plain[0], plain[1], plain[5], plain[6], plain[7]]
    XCTAssertEqual(read(plain, honorModal), .modal([ModalSurface(host: 1, roots: [2])]))
  }

  func testAnIdenticalPairHasNoExclusion() {
    XCTAssertEqual(read(sheetUnderAlert, sheetUnderAlert), .noExclusion)
  }

  func testATruncatedPairIsUnknownEvenWhenItRemovedContent() {
    let honorModal = sheetUnderAlert.filter { $0.element != "content" }
    XCTAssertEqual(read(sheetUnderAlert, honorModal, truncated: true), .unknown(.unstable(.truncated)))
  }

  func testAnUnstablePairIsUnknown() {
    let honorModal = sheetUnderAlert.filter { $0.element != "content" }
    XCTAssertEqual(
      ModalSurface.read(plain: sheetUnderAlert, honorModal: honorModal, confirmingHonorModal: sheetUnderAlert, truncated: false),
      .unknown(.unstable(.screenChanged))
    )
  }

  // The honor-modal read empties a container but keeps nothing beside what it removed, so no
  // node names the modal.
  func testRemovedContentWithoutAKeptSiblingIsUnknown() {
    let plain = [node("app", nil), node("window", "app"), node("content", "window"), node("text", "content")]
    XCTAssertEqual(read(plain, Array(plain.prefix(3))), .unknown(.noSurvivingSurface))
  }

  func testANodeListedBeforeItsParentIsUnknown() {
    let plain = [node("app", nil), node("window", "app"), node("content", "window"), node("sheet", "window")]
    let honorModal = [node("app", nil), node("sheet", "window"), node("window", "app")]
    let reading = ModalSurface.read(plain: plain, honorModal: honorModal, confirmingHonorModal: honorModal, truncated: false)
    XCTAssertEqual(reading, .unknown(.unorderedRead))
  }

  func testKeyboardBranchesOfferNoActions() {
    func leaf(_ type: String, _ label: String, identifier: String = "") -> AlertSurfaceNode {
      AlertSurfaceNode(type: type, identifier: identifier, label: label, frame: screen, children: [])
    }
    func branch(_ type: String, identifier: String = "", _ children: [AlertSurfaceNode]) -> AlertSurfaceNode {
      AlertSurfaceNode(type: type, identifier: identifier, label: "", frame: screen, children: children)
    }
    let root = branch("Other", [
      leaf("Other", "Dismiss Popup"),
      branch("Other", [leaf("Button", "Done")]),
      branch("Keyboard", [leaf("Key", "a"), leaf("Button", "Next keyboard")]),
      branch("Other", identifier: "SystemInputAssistantView", [leaf("Button", "Dictate")]),
    ])
    XCTAssertEqual(ModalSurface.actions(in: root).map(\.label), ["Dismiss Popup", "Done"])
  }
}
