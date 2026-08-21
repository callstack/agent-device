#if AGENT_DEVICE_RUNNER_UNIT_TESTS
import Foundation
import XCTest

extension RunnerTests {
  func testRegularPresentationPublishesGeometricActionabilityWithoutOcclusionOrTypeGate() throws {
    // Non-vacuity: restoring the old raw `hittable` copy would make the covered button and the
    // labeled image false, while dropping the enabled check would make the disabled button true.
    let nodes = [
      RawAXNode(
        index: 0,
        type: "Application",
        label: "Example",
        identifier: nil,
        value: nil,
        rect: SnapshotRect(x: 0, y: 0, width: 100, height: 100),
        enabled: true,
        focused: nil,
        selected: nil,
        hittable: false,
        depth: 0,
        parentIndex: nil,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      ),
      RawAXNode(
        index: 1,
        type: "Button",
        label: "Covered button",
        identifier: nil,
        value: nil,
        rect: SnapshotRect(x: 10, y: 10, width: 30, height: 30),
        enabled: true,
        focused: nil,
        selected: nil,
        hittable: false,
        depth: 1,
        parentIndex: 0,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      ),
      RawAXNode(
        index: 2,
        type: "TabBar",
        label: "Overlay",
        identifier: nil,
        value: nil,
        rect: SnapshotRect(x: 10, y: 10, width: 30, height: 30),
        enabled: true,
        focused: nil,
        selected: nil,
        hittable: true,
        depth: 1,
        parentIndex: 0,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      ),
      RawAXNode(
        index: 3,
        type: "Image",
        label: "Labeled image",
        identifier: nil,
        value: nil,
        rect: SnapshotRect(x: 60, y: 10, width: 30, height: 30),
        enabled: true,
        focused: nil,
        selected: nil,
        hittable: false,
        depth: 1,
        parentIndex: 0,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      ),
      RawAXNode(
        index: 4,
        type: "Button",
        label: "Disabled button",
        identifier: nil,
        value: nil,
        rect: SnapshotRect(x: 10, y: 60, width: 30, height: 30),
        enabled: false,
        focused: nil,
        selected: nil,
        hittable: true,
        depth: 1,
        parentIndex: 0,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      ),
    ]
    let options = PresentationOptions(
      interactiveOnly: false, depth: nil, scope: nil, raw: false)
    let capture = SnapshotPresentation.presentRegular(
      SnapshotAcquisition(
        hint: SnapshotPresentation.captureHint(for: options),
        nodes: nodes,
        truncated: false,
        effectiveDepth: nil,
        viewport: CGRect(x: 0, y: 0, width: 100, height: 100)
      ),
      options: options
    )
    let presented = try XCTUnwrap(capture.payload.nodes)

    XCTAssertEqual(presented.first { $0.label == "Covered button" }?.hittable, true)
    XCTAssertEqual(presented.first { $0.label == "Labeled image" }?.hittable, true)
    XCTAssertEqual(presented.first { $0.label == "Disabled button" }?.hittable, false)
  }

  func testSnapshotAcquisitionDoesNotReintroduceRunnerOcclusionScan() throws {
    let sourceURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("RunnerTests+Snapshot.swift")
    let source = try String(contentsOf: sourceURL, encoding: .utf8)

    for obsoleteSymbol in [
      "computedSnapshotHittable", "flattenedSnapshots", "snapshotRanges", "laterSnapshots",
      "isOccludingType", "isVisibleInViewport", "ArraySlice<XCUIElementSnapshot>",
      "element.isHittable",
    ] {
      XCTAssertFalse(
        source.contains(obsoleteSymbol),
        "Runner snapshot acquisition must not restore the retired occlusion helper: \(obsoleteSymbol)"
      )
    }
  }
}
#endif
