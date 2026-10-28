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
  func testAssistantTapMembershipSurvivesRawAndRegularScoping() throws {
    for raw in [false, true] {
      let options = PresentationOptions(interactiveOnly: !raw, depth: nil, scope: "assistant-action", raw: raw)
      let acquisition = SnapshotAcquisition(
        hint: SnapshotPresentation.captureHint(for: options),
        nodes: [
          RawAXNode(
            index: 0, type: "Other", label: nil, identifier: "SystemInputAssistantView", value: nil,
            rect: SnapshotRect(x: 0, y: 556, width: 390, height: 44), enabled: true,
            focused: nil, selected: nil, hittable: true, depth: 0, parentIndex: nil,
            hiddenContentAbove: nil, hiddenContentBelow: nil
          ),
          RawAXNode(
            index: 1, type: "Button", label: "Assistant action", identifier: "assistant-action", value: nil,
            rect: SnapshotRect(x: 200, y: 560, width: 100, height: 36), enabled: true,
            focused: nil, selected: nil, hittable: true, depth: 1, parentIndex: 0,
            hiddenContentAbove: nil, hiddenContentBelow: nil
          ),
          RawAXNode(
            index: 2, type: "Button", label: "Underlying app control", identifier: nil, value: nil,
            rect: SnapshotRect(x: 200, y: 560, width: 100, height: 36), enabled: true,
            focused: nil, selected: nil, hittable: true, depth: 0, parentIndex: nil,
            hiddenContentAbove: nil, hiddenContentBelow: nil
          ),
        ],
        truncated: false, effectiveDepth: nil,
        viewport: .reported(box: CGRect(x: 0, y: 0, width: 390, height: 844))
      )
      let result = try XCTUnwrap(SnapshotPresentation.present(acquisition, options: options))
      XCTAssertEqual(result.nodes.count, 1)
      let action = try XCTUnwrap(result.nodes.first)
      XCTAssertEqual(action.identifier, "assistant-action")
      XCTAssertNil(action.parentIndex)
      let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(action)) as? [String: Any]
      XCTAssertEqual(payload?["keyboardOwned"] as? Bool, true)
      let unscoped = SnapshotPresentation.presentRaw(acquisition,
        options: PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: true))
      let underlying = try XCTUnwrap(unscoped.nodes.first { $0.label == "Underlying app control" })
      let underlyingPayload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(underlying)) as? [String: Any]
      XCTAssertNil(underlyingPayload?["keyboardOwned"])
    }
  }

}
