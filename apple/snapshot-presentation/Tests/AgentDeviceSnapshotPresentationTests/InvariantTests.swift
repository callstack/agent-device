import CoreGraphics
import XCTest
@testable import AgentDeviceSnapshotPresentation

final class InvariantTests: XCTestCase {
  func testRegularInvariantUsesOneParentClipLookupPerNode() throws {
    let nodeCount = 5_000
    let viewport = CGRect(x: 0, y: 0, width: 100, height: 100)
    let nodes = (0..<nodeCount).map { index in
      let raw = RawAXNode(
        index: index,
        type: index == 0 ? "Application" : "ScrollView",
        label: nil,
        identifier: nil,
        value: nil,
        rect: SnapshotRect(x: 0, y: 0, width: 100, height: 100),
        enabled: true,
        focused: nil,
        selected: nil,
        hittable: false,
        depth: index,
        parentIndex: index == 0 ? nil : index - 1,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
      return SnapshotPresentationNode(raw: raw, effectiveRect: raw.rect)
    }

    let stats = try SnapshotPresentationInvariant.validateRegularWithStats(
      nodes,
      viewport: viewport,
      policy: .cursorProjected
    )

    XCTAssertEqual(stats.parentClipLookups, nodeCount - 1)
  }
}
