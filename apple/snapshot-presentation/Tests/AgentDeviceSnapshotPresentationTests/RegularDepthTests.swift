import AgentDeviceSnapshotPresentation
import CoreGraphics
import XCTest

/// A backend that acquires past the requested frontier (private AX walks its raw ladder) still
/// serves a regular `--depth` request: the cut is presentation's, applied to whatever hierarchy
/// was acquired (#2403).
final class RegularDepthTests: XCTestCase {
  func testRegularDepthCutsAHierarchyAcquiredPastTheFrontier() throws {
    let options = PresentationOptions(interactiveOnly: false, depth: 1, scope: nil, raw: false)
    let viewport = CGRect(x: 0, y: 0, width: 100, height: 100)
    // Application > Other(wrapper) > Button "Continue" > StaticText "Deep"
    let nodes = [
      node(0, type: "Application", label: "App", depth: 0, parentIndex: nil),
      node(1, type: "Other", label: nil, depth: 1, parentIndex: 0),
      node(2, type: "Button", label: "Continue", depth: 2, parentIndex: 1, hittable: true),
      node(3, type: "StaticText", label: "Deep", depth: 3, parentIndex: 2),
    ]
    let acquisition = SnapshotAcquisition(
      hint: SnapshotPresentation.captureHint(for: options),
      nodes: nodes,
      truncated: false,
      effectiveDepth: nil,
      viewport: viewport
    )

    let result = try XCTUnwrap(SnapshotPresentation.present(acquisition, options: options))

    XCTAssertEqual(result.nodes.map(\.label), ["App", "Continue"])
    XCTAssertEqual(result.nodes.map(\.depth), [0, 1])
    XCTAssertEqual(result.nodes.map(\.parentIndex), [nil, 0])
  }

  private func node(
    _ index: Int,
    type: String,
    label: String?,
    depth: Int,
    parentIndex: Int?,
    hittable: Bool = false
  ) -> RawAXNode {
    RawAXNode(
      index: index,
      type: type,
      label: label,
      identifier: nil,
      value: nil,
      rect: SnapshotRect(x: 10, y: 10, width: 40, height: 20),
      enabled: true,
      focused: nil,
      selected: nil,
      hittable: hittable,
      depth: depth,
      parentIndex: parentIndex,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }
}
