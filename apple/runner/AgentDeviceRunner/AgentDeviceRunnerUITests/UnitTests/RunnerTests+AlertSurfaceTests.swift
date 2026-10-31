import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
/// A frame as the corpus spells it: the `FixtureRect` spelling, so an unusable box is named.
private struct RecordedAlertSurfaceRect: Encodable {
  let frame: CGRect

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    if frame.isInfinite {
      try container.encode(true, forKey: .infinite)
    } else if ![frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite) {
      try container.encode(true, forKey: .nonFinite)
    } else {
      try container.encode(frame.minX, forKey: .x)
      try container.encode(frame.minY, forKey: .y)
      try container.encode(frame.width, forKey: .width)
      try container.encode(frame.height, forKey: .height)
    }
  }

  private enum CodingKeys: String, CodingKey {
    case x, y, width, height, infinite, nonFinite
  }
}

private struct RecordedAlertSurfaceNode: Encodable {
  let index: Int
  let parentIndex: Int?
  let type: String
  let identifier: String
  let label: String
  let rect: RecordedAlertSurfaceRect
}

extension RunnerTests {
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
        rect: RecordedAlertSurfaceRect(frame: node.frame)
      ))
      node.children.forEach { record($0, parentIndex: index) }
    }
    record(alertSurfaceNode(snapshot), parentIndex: nil)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    try encoder.encode(nodes).write(to: URL(fileURLWithPath: output))
  }
}
#endif
