import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
// #3565: a capture has to say whether it read a modal presentation over the app. The blocking
// system-modal probe is the one capture that can state `presented` without reading any window
// structure: the tree it publishes holds only the modal, so nothing downstream could read a
// presentation out of it. Only the payload factory is pinned here, because the probe body that calls it
// enumerates XCUIElements and needs a device.
extension RunnerTests {
  func testResolvedBlockingSystemModalPayloadStatesAPresentedSurface() throws {
    XCTAssertEqual(try Self.blockingSystemModalPayload(nodes: []).presentedSurface, .presented)
  }

  func testBlockingSystemModalClipsOverflowAndDisclosesItWithoutRecovery() throws {
    let nodes = [
      Self.modalGeometryNode(0, type: "Alert", y: 0, height: 240),
      Self.modalGeometryNode(1, type: "Button", y: 210, height: 60),
      Self.modalGeometryNode(2, type: "StaticText", y: 20, height: 230),
      Self.modalGeometryNode(3, type: "Button", y: 260, height: 44),
      Self.modalGeometryNode(4, type: "Button", y: 100, height: 44),
    ]
    let payload = try Self.blockingSystemModalPayload(nodes: nodes)
    XCTAssertEqual(payload.nodes?.map(\.label), ["node-0", "node-1", "node-2", "node-4"])
    XCTAssertEqual(payload.nodes?.map(\.index), [0, 1, 2, 3])
    XCTAssertEqual(payload.nodes?[1].rect.height, 30)
    XCTAssertEqual(payload.nodes?[2].rect.height, 220)
    XCTAssertEqual(payload.nodes?[1].hittable, true)
    XCTAssertEqual(payload.nodes?[2].hittable, false)
    XCTAssertEqual(payload.nodes?[3].parentIndex, 0)
    XCTAssertNil(payload.snapshotQuality)
    XCTAssertEqual(payload.snapshotQualityNotes?.first?.code, .regularGeometryClipped)
    XCTAssertEqual(payload.snapshotQualityNotes?.first?.clippedNodeCount, 2)
    XCTAssertEqual(payload.snapshotQualityNotes?.first?.droppedNodeCount, 1)
    XCTAssertEqual(payload.truncated, false)
    let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any])
    XCTAssertNil(wire["snapshotQuality"])
    let notes = try XCTUnwrap(wire["snapshotQualityNotes"] as? [[String: Any]])
    XCTAssertEqual(notes.first?["clippedNodeCount"] as? Int, 2)
    XCTAssertEqual(notes.first?["droppedNodeCount"] as? Int, 1)

    let raw = try Self.blockingSystemModalPayload(
      nodes: nodes,
      options: PresentationOptions(interactiveOnly: true, depth: nil, scope: nil, raw: true)
    )
    XCTAssertEqual(raw.nodes?.count, 5)
    XCTAssertEqual(raw.nodes?[1].rect, nodes[1].rect)
    XCTAssertEqual(raw.nodes?[3].rect, nodes[3].rect)
    XCTAssertNil(raw.snapshotQuality)
    XCTAssertNil(raw.snapshotQualityNotes)
  }

  func testOrdinaryBlockingModalDoesNotInventQuality() throws {
    let payload = try Self.blockingSystemModalPayload(nodes: [
      Self.modalGeometryNode(0, type: "Alert", y: 0, height: 240),
      Self.modalGeometryNode(1, type: "Button", y: 100, height: 44),
    ])
    let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any])
    XCTAssertNil(wire["snapshotQuality"])
    XCTAssertNil(wire["snapshotQualityNotes"])
    XCTAssertEqual(payload.nodes?.count, 2)
  }

  private static func modalGeometryNode(_ index: Int, type: String, y: Double, height: Double) -> RawAXNode {
    RawAXNode(
      index: index, type: type, label: "node-\(index)", identifier: nil, value: nil,
      rect: SnapshotRect(x: 0, y: y, width: 320, height: height),
      enabled: true, focused: nil, selected: nil, hittable: type != "StaticText",
      depth: index == 0 ? 0 : 1, parentIndex: index == 0 ? nil : 0,
      hiddenContentAbove: nil, hiddenContentBelow: nil
    )
  }

  // Silence is the answer a consumer must not be able to confuse with absence: a capture the runner
  // never classified (an older runner, a tier that published no reading) encodes no key at all.
  func testUnclassifiedSnapshotPayloadEncodesNoPresentedSurfaceKey() throws {
    let encoded = try JSONEncoder().encode(DataPayload(nodes: [], truncated: false))
    let object = try XCTUnwrap(
      JSONSerialization.jsonObject(with: encoded) as? [String: Any],
      "the snapshot payload encodes as an object"
    )
    XCTAssertNil(object["presentedSurface"])
  }
}
#endif
