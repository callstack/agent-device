import AgentDeviceSnapshotPresentation
import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  func testSnapshotTraversalIdentityPreservesSameOriginNodesWithDifferentBounds() {
    let wrapper = RegularSnapshotTree.Policy.platformDefault.identity(
      elementType: "Other",
      label: "Article",
      identifier: "",
      frame: CGRect(x: 0, y: 97, width: 393, height: 48)
    )
    let leaf = RegularSnapshotTree.Policy.platformDefault.identity(
      elementType: "Other",
      label: "Article",
      identifier: "",
      frame: CGRect(x: 0, y: 97, width: 131, height: 48)
    )

    #if os(iOS)
    XCTAssertNotEqual(wrapper, leaf)
    #else
    XCTAssertEqual(wrapper, leaf)
    #endif
  }
#endif
}
