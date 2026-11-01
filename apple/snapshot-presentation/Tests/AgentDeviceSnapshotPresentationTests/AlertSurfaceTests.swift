import CoreGraphics
import XCTest
@testable import AgentDeviceSnapshotPresentation

final class AlertSurfaceTests: XCTestCase {
  func testEveryRecordedSurfaceIsFoundByItsSourceOnly() throws {
    let recordings = try recordedAlertSurfaces()
    XCTAssertFalse(recordings.isEmpty)
    for (name, recorded) in recordings {
      let root = RecordedAlertSurface.tree(recorded.honorModal)
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
