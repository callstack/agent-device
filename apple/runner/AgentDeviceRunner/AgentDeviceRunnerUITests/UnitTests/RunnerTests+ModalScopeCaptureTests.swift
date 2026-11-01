import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  /// The server stops at `maxNodes`, so a read that fills the cap exactly may have lost the node
  /// after the last one, even when that last node is the final child walked.
  func testAModalScopeTreeThatFillsTheNodeCapIsTruncated() {
    let tree = RunnerAXSnapshotBridge.modalScopeTree(
      fromSnapshot: ModalScopeSnapshotForTesting.app(childCount: 2),
      maxDepth: 64,
      maxNodes: 3,
      includeClassNames: false
    )
    XCTAssertEqual(tree?.nodes.count, 3)
    XCTAssertEqual(tree?.truncated, true)
  }

  func testAModalScopeTreeBelowTheNodeCapIsComplete() {
    let tree = RunnerAXSnapshotBridge.modalScopeTree(
      fromSnapshot: ModalScopeSnapshotForTesting.app(childCount: 2),
      maxDepth: 64,
      maxNodes: 4,
      includeClassNames: false
    )
    XCTAssertEqual(tree?.nodes.map(\.element), ["7:0.1", "7:10.2", "7:10.3"])
    XCTAssertEqual(tree?.nodes.map(\.parentElement), [nil, "7:0.1", "7:0.1"])
    XCTAssertEqual(tree?.nodes.first?.frame, CGRect(x: 0, y: 0, width: 402, height: 874))
    XCTAssertEqual(tree?.truncated, false)
  }
}

private final class ModalScopeElementForTesting: NSObject {
  @objc let processIdentifier: Int32 = 7
  @objc let elementOrHash: UInt64
  @objc let elementID: UInt64

  init(elementOrHash: UInt64, elementID: UInt64) {
    self.elementOrHash = elementOrHash
    self.elementID = elementID
  }
}

private final class ModalScopeSnapshotForTesting: NSObject {
  @objc let accessibilityElement: ModalScopeElementForTesting
  @objc let elementType = XCUIElement.ElementType.other.rawValue
  @objc let identifier = ""
  @objc let label = ""
#if os(macOS)
  @objc let frame = NSValue(rect: CGRect(x: 0, y: 0, width: 402, height: 874))
#else
  @objc let frame = NSValue(cgRect: CGRect(x: 0, y: 0, width: 402, height: 874))
#endif
  @objc let children: [ModalScopeSnapshotForTesting]

  init(element: ModalScopeElementForTesting, children: [ModalScopeSnapshotForTesting]) {
    self.accessibilityElement = element
    self.children = children
  }

  static func app(childCount: Int) -> ModalScopeSnapshotForTesting {
    ModalScopeSnapshotForTesting(
      element: ModalScopeElementForTesting(elementOrHash: 0, elementID: 1),
      children: (0..<childCount).map { index in
        ModalScopeSnapshotForTesting(
          element: ModalScopeElementForTesting(elementOrHash: 10, elementID: UInt64(index + 2)),
          children: []
        )
      }
    )
  }
}
#endif
