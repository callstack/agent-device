import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct RecordedAlertSurfaceNode: Encodable {
  struct Rect: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
  }

  let index: Int
  let parentIndex: Int?
  let type: String
  let identifier: String
  let label: String
  let rect: Rect
}

extension RunnerTests {
  func testAlertSurfaceActionableTypesMatchTheRunnerActionableTypes() {
    XCTAssertEqual(Set(actionableTypes.map { elementTypeName($0) }), AlertSurface.actionableTypes)
  }

  /// Records an app's whole accessibility tree for the alert surface corpus. It runs only from
  /// `pnpm capture:alert-surface`, which sets the bundle and the output path.
  @MainActor
  func testCaptureAlertSurfaceTree() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let bundleId = environment["AGENT_DEVICE_ALERT_SURFACE_BUNDLE_ID"],
          let output = environment["AGENT_DEVICE_ALERT_SURFACE_OUTPUT"]
    else {
      throw XCTSkip("Run through pnpm capture:alert-surface")
    }
    let snapshot = try XCUIApplication(bundleIdentifier: bundleId).snapshot()
    var nodes: [RecordedAlertSurfaceNode] = []
    func record(_ node: AlertSurfaceNode, parentIndex: Int?) {
      let index = nodes.count
      nodes.append(RecordedAlertSurfaceNode(
        index: index,
        parentIndex: parentIndex,
        type: node.type,
        identifier: node.identifier,
        label: node.label,
        rect: .init(x: node.frame.minX, y: node.frame.minY, width: node.frame.width, height: node.frame.height)
      ))
      node.children.forEach { record($0, parentIndex: index) }
    }
    record(alertSurfaceNode(snapshot), parentIndex: nil)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    encoder.nonConformingFloatEncodingStrategy = .convertToString(
      positiveInfinity: "Infinity",
      negativeInfinity: "-Infinity",
      nan: "NaN"
    )
    try encoder.encode(nodes).write(to: URL(fileURLWithPath: output))
  }
}
#endif
