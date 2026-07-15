import XCTest

extension RunnerTests {
  func testSnapshotTraversalIdentityPreservesSameOriginNodesWithDifferentBounds() {
    let wrapper = Self.snapshotTraversalIdentity(
      elementType: .other,
      label: "Article",
      identifier: "",
      frame: CGRect(x: 0, y: 97, width: 393, height: 48)
    )
    let leaf = Self.snapshotTraversalIdentity(
      elementType: .other,
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
}
