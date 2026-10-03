import AgentDeviceSnapshotPresentation
import CoreGraphics
import XCTest

final class SnapshotVisibilityFoldTests: XCTestCase {
  func testFoldPreservesCapturedAttributesWhileReparentingClippingAndMergingHints() throws {
    let root = node(0, "Application", y: 0, height: 100, depth: 0, parent: nil)
    let dropped = node(1, "Other", y: 120, height: 10, depth: 1, parent: 0)
    let scroll = RawAXNode(
      index: 2, type: "ScrollView", label: "Results", identifier: "search-results", value: "loaded",
      placeholder: "Search", rect: SnapshotRect(x: 80, y: 20, width: 40, height: 60),
      enabled: true, focused: false, selected: true, hittable: nil,
      depth: 2, parentIndex: 1, hiddenContentAbove: true, hiddenContentBelow: false,
      actions: ["Refresh", "Jump"]
    )

    for (hiddenY, expectedBelow) in [(0.0, nil as Bool?), (90.0, true as Bool?)] {
      let hidden = node(3, "Button", y: hiddenY, height: 10, depth: 3, parent: 2)
      let folded = SnapshotVisibilityFold.fold(
        [root, dropped, scroll, hidden],
        viewport: .reported(box: CGRect(x: 0, y: 0, width: 100, height: 100)),
        interactiveOnly: false,
        policy: .cursorProjected
      )

      XCTAssertEqual(folded.count, 2)
      let presentation = try XCTUnwrap(folded.last)
      let raw = presentation.raw
      XCTAssertEqual(raw.index, 1)
      XCTAssertEqual(raw.depth, 1)
      XCTAssertEqual(raw.parentIndex, 0)
      XCTAssertEqual(raw.hittable, true)
      XCTAssertEqual(folded[0].raw.hittable, false)
      XCTAssertEqual(raw.hiddenContentAbove, true)
      XCTAssertEqual(raw.hiddenContentBelow, expectedBelow)
      XCTAssertEqual(presentation.effectiveRect, SnapshotRect(x: 80, y: 20, width: 20, height: 60))
      XCTAssertEqual(raw.rect, scroll.rect)
      XCTAssertEqual(raw.type, scroll.type)
      XCTAssertEqual(raw.label, scroll.label)
      XCTAssertEqual(raw.identifier, scroll.identifier)
      XCTAssertEqual(raw.value, scroll.value)
      XCTAssertEqual(raw.placeholder, scroll.placeholder)
      XCTAssertEqual(raw.enabled, scroll.enabled)
      XCTAssertEqual(raw.focused, scroll.focused)
      XCTAssertEqual(raw.selected, scroll.selected)
      XCTAssertEqual(raw.actions, scroll.actions)
    }
  }

  private func node(
    _ index: Int, _ type: String, y: Double, height: Double, depth: Int, parent: Int?
  ) -> RawAXNode {
    RawAXNode(
      index: index, type: type, label: nil, identifier: nil, value: nil,
      rect: SnapshotRect(x: 80, y: y, width: 20, height: height),
      enabled: true, focused: nil, selected: nil, hittable: false,
      depth: depth, parentIndex: parent, hiddenContentAbove: nil, hiddenContentBelow: nil
    )
  }
}
