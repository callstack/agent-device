import AgentDeviceSnapshotPresentation
import XCTest

final class SnapshotPresentationProjectionTests: XCTestCase {
  func testRawScopeReindexesWithoutDroppingCapturedAttributes() throws {
    let scoped = RawAXNode(
      index: 7, type: "TextField", label: "Account", identifier: "account-input", value: "saved",
      placeholder: "Enter account", rect: SnapshotRect(x: 12, y: 23, width: 34, height: 45),
      enabled: false, focused: true, selected: false, hittable: nil,
      depth: 3, parentIndex: 6, hiddenContentAbove: false, hiddenContentBelow: true,
      actions: ["Clear", "Inspect"]
    )
    let child = RawAXNode(
      index: 8, type: "Button", label: "Clear", identifier: nil, value: nil,
      rect: SnapshotRect(x: 13, y: 24, width: 10, height: 11),
      enabled: true, focused: nil, selected: nil, hittable: false,
      depth: 4, parentIndex: 7, hiddenContentAbove: nil, hiddenContentBelow: nil
    )
    let options = PresentationOptions(interactiveOnly: false, depth: nil, scope: "Account", raw: true)
    let result = SnapshotPresentation.presentRaw(
      SnapshotAcquisition(
        hint: SnapshotPresentation.captureHint(for: options), nodes: [scoped, child],
        truncated: false, effectiveDepth: nil, viewport: .missing(reason: .notProvided)
      ),
      options: options
    )

    XCTAssertEqual(result.nodes.count, 2)
    let presented = try XCTUnwrap(result.nodes.first)
    XCTAssertEqual(presented.index, 0)
    XCTAssertEqual(presented.depth, 0)
    XCTAssertNil(presented.parentIndex)
    XCTAssertEqual(result.nodes[1].index, 1)
    XCTAssertEqual(result.nodes[1].depth, 1)
    XCTAssertEqual(result.nodes[1].parentIndex, 0)
    XCTAssertEqual(presented.type, scoped.type)
    XCTAssertEqual(presented.label, scoped.label)
    XCTAssertEqual(presented.identifier, scoped.identifier)
    XCTAssertEqual(presented.value, scoped.value)
    XCTAssertEqual(presented.placeholder, scoped.placeholder)
    XCTAssertEqual(presented.rect, scoped.rect)
    XCTAssertEqual(presented.enabled, scoped.enabled)
    XCTAssertEqual(presented.focused, scoped.focused)
    XCTAssertEqual(presented.selected, scoped.selected)
    XCTAssertEqual(presented.hittable, scoped.hittable)
    XCTAssertEqual(presented.hiddenContentAbove, scoped.hiddenContentAbove)
    XCTAssertEqual(presented.hiddenContentBelow, scoped.hiddenContentBelow)
    XCTAssertEqual(presented.actions, scoped.actions)
  }
}
