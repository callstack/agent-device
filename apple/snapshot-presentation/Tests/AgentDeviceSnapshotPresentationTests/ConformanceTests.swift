import AgentDeviceSnapshotPresentation
import CoreGraphics
import XCTest

final class ConformanceTests: XCTestCase {
  func testStandaloneHarnessUsesPresenterForAClippedRegularNode() throws {
    let options = PresentationOptions(
      interactiveOnly: false,
      depth: nil,
      scope: nil,
      raw: false
    )
    let result = try SnapshotPresentation.presentRegular(
      SnapshotAcquisition(
        hint: SnapshotPresentation.captureHint(for: options),
        nodes: [
          RawAXNode(
            index: 0,
            type: "Application",
            label: "App",
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
            label: "Continue",
            identifier: nil,
            value: nil,
            rect: SnapshotRect(x: 80, y: 10, width: 40, height: 20),
            enabled: true,
            focused: nil,
            selected: nil,
            hittable: true,
            depth: 1,
            parentIndex: 0,
            hiddenContentAbove: nil,
            hiddenContentBelow: nil
          ),
        ],
        truncated: false,
        effectiveDepth: nil,
        viewport: CGRect(x: 0, y: 0, width: 100, height: 100)
      ),
      options: options,
      policy: .cursorProjected
    )

    XCTAssertEqual(result.nodes.map(\.label), ["App", "Continue"])
    XCTAssertEqual(result.nodes[1].rect, SnapshotRect(x: 80, y: 10, width: 20, height: 20))
  }
}
