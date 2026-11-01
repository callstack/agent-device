import XCTest

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
  let element: String
  let type: String
  let identifier: String
  let label: String
  let rect: RecordedAlertSurfaceRect
  let viewClass: String?
  let viewControllerClass: String?
}

private struct RecordedAlertSurfaceCapture: Encodable {
  let order: [String]
  let milliseconds: [String: Int]
  let plain: [RecordedAlertSurfaceNode]
  let honorModal: [RecordedAlertSurfaceNode]
}

extension RunnerTests {
  /// Records an app's plain and honor-modal accessibility trees for the alert surface corpus, and
  /// fails when the reads do not pair. It runs only from `pnpm capture:alert-surface`, which sets
  /// the bundle and the output path.
  @MainActor
  func testCaptureAlertSurfaceTree() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let bundleId = environment["AGENT_DEVICE_ALERT_SURFACE_BUNDLE_ID"],
          let output = environment["AGENT_DEVICE_ALERT_SURFACE_OUTPUT"]
    else {
      throw XCTSkip("Run through pnpm capture:alert-surface")
    }
    let acquisition = ModalScopeAcquisition.acquire(
      of: XCUIApplication(bundleIdentifier: bundleId),
      includeClassNames: true,
      deadline: Date().addingTimeInterval(30)
    )
    guard case let .paired(reads) = acquisition else {
      XCTFail("No paired capture: \(acquisition)")
      return
    }
    func record(_ tree: RunnerAXModalScopeTree) -> [RecordedAlertSurfaceNode] {
      tree.nodes.enumerated().map { index, node in
        RecordedAlertSurfaceNode(
          index: index,
          parentIndex: node.parentIndex < 0 ? nil : node.parentIndex,
          element: node.element,
          type: alertSurfaceTypeName(XCUIElement.ElementType(rawValue: UInt(node.elementType)) ?? .any),
          identifier: node.identifier,
          label: node.label,
          rect: RecordedAlertSurfaceRect(frame: node.frame),
          viewClass: node.viewClass,
          viewControllerClass: node.viewControllerClass
        )
      }
    }
    let capture = RecordedAlertSurfaceCapture(
      order: ["honorModal", "plain", "confirmingHonorModal"],
      milliseconds: [
        "honorModal": Int((reads.honorModal.duration * 1_000).rounded()),
        "plain": Int((reads.plain.duration * 1_000).rounded()),
        "confirmingHonorModal": Int((reads.confirmingHonorModal.duration * 1_000).rounded()),
      ],
      plain: record(reads.plain),
      honorModal: record(reads.honorModal)
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    try encoder.encode(capture).write(to: URL(fileURLWithPath: output))
  }
}
#endif
