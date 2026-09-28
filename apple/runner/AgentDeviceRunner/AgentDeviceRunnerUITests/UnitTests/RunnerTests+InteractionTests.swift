import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testDesktopScrollWheelDeltasMapDirections() {
    XCTAssertEqual(desktopScrollWheelDeltas(direction: .up, pixels: 120).vertical, 120)
    XCTAssertEqual(desktopScrollWheelDeltas(direction: .down, pixels: 120).vertical, -120)
    XCTAssertEqual(desktopScrollWheelDeltas(direction: .left, pixels: 120).horizontal, 120)
    XCTAssertEqual(desktopScrollWheelDeltas(direction: .right, pixels: 120).horizontal, -120)
  }

  func testDesktopScrollWheelDeltaEventsHonorDurationAndPreservePixels() {
    let events = desktopScrollWheelDeltaEvents(direction: .down, pixels: 200, durationMs: 50)
    XCTAssertEqual(events.count, 4)
    XCTAssertEqual(events.map(\.vertical).reduce(0, +), -200)
    XCTAssertEqual(events.map(\.horizontal).reduce(0, +), 0)
    XCTAssertEqual(desktopScrollEventIntervalSeconds(durationMs: 50, eventCount: events.count), 0.05 / 3.0)
  }

  func testDesktopScrollWheelDeltaEventsKeepInstantScrollSingleEvent() {
    let events = desktopScrollWheelDeltaEvents(direction: .down, pixels: 200, durationMs: 0)
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.vertical, -200)
  }

#if os(iOS) && targetEnvironment(simulator)
  func testPrivateAXPointInspectionReturnsContainingElementsSmallestFirst() {
    let root: [String: Any] = [
      "type": NSNumber(value: XCUIElement.ElementType.window.rawValue),
      "label": "",
      "identifier": "root",
      "value": "",
      "frame": ["x": 0, "y": 0, "width": 400, "height": 800],
      "children": [[
        "type": NSNumber(value: XCUIElement.ElementType.button.rawValue),
        "label": "Native Action",
        "identifier": "native-action",
        "value": "",
        "frame": ["x": 100, "y": 500, "width": 200, "height": 48],
        "children": [],
      ]],
    ]

    let inspection = privateAXPointInspection(root: root, point: CGPoint(x: 200, y: 520))

    XCTAssertEqual(inspection.text, "Native Action")
    XCTAssertEqual(inspection.elements.count, 2)
    XCTAssertEqual(inspection.elements.first?.identifier, "native-action")
    XCTAssertEqual(inspection.elements.last?.identifier, "root")
    XCTAssertEqual(inspection.elements.first?.frame, SnapshotRect(x: 100, y: 500, width: 200, height: 48))
    XCTAssertNil(inspection.elements.first?.hittable)
  }

  func testPrivateAXPointInspectionReturnsNoElementForHonestMiss() {
    let root: [String: Any] = [
      "type": NSNumber(value: XCUIElement.ElementType.window.rawValue),
      "label": "Root",
      "identifier": "root",
      "value": "",
      "frame": ["x": 0, "y": 0, "width": 100, "height": 100],
      "children": [],
    ]

    let inspection = privateAXPointInspection(root: root, point: CGPoint(x: 200, y: 200))

    XCTAssertNil(inspection.text)
    XCTAssertTrue(inspection.elements.isEmpty)
  }

  func testPrivateAXPointInspectionOmitsOwningApplicationLabel() {
    let root: [String: Any] = [
      "type": NSNumber(value: XCUIElement.ElementType.application.rawValue),
      "label": "ET N Action",
      "identifier": "com.expotargets.example.native.action",
      "value": "",
      "frame": ["x": 0, "y": 0, "width": 400, "height": 800],
      "children": [[
        "type": NSNumber(value: XCUIElement.ElementType.window.rawValue),
        "label": "Share Sheet",
        "identifier": "share-sheet",
        "value": "",
        "frame": ["x": 0, "y": 400, "width": 400, "height": 400],
        "children": [],
      ]],
    ]

    let inspection = privateAXPointInspection(root: root, point: CGPoint(x: 200, y: 520))

    XCTAssertEqual(inspection.text, "Share Sheet")
    XCTAssertFalse(inspection.elements.contains { $0.label == "ET N Action" })
  }
#endif
}
#endif
