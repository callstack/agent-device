#if AGENT_DEVICE_RUNNER_UNIT_TESTS
import XCTest

extension RunnerTests {
  private static func foldNode(
    _ index: Int,
    type: String,
    label: String? = nil,
    rect: SnapshotRect,
    depth: Int,
    parentIndex: Int?
  ) -> RawAXNode {
    RawAXNode(
      index: index, type: type, label: label, identifier: nil, value: nil, rect: rect,
      enabled: true, focused: nil, selected: nil, hittable: false, depth: depth,
      parentIndex: parentIndex, hiddenContentAbove: nil, hiddenContentBelow: nil
    )
  }

  private static func folded(
    _ nodes: [RawAXNode],
    viewport: CGRect,
    interactiveOnly: Bool = false,
    policy: SnapshotVisibilityFold.Policy = .cursorProjected
  ) -> [SnapshotPresentationNode] {
    SnapshotVisibilityFold.fold(
      nodes, viewport: viewport, interactiveOnly: interactiveOnly, policy: policy)
  }

  func testRegularFoldClipsScrollOverflowReparentsAndBooksHints() {
    let nodes = [
      Self.foldNode(0, type: "Application", label: "App",
        rect: SnapshotRect(x: 0, y: 0, width: 402, height: 874), depth: 0, parentIndex: nil),
      Self.foldNode(1, type: "ScrollView",
        rect: SnapshotRect(x: 0, y: 96, width: 402, height: 700), depth: 1, parentIndex: 0),
      Self.foldNode(2, type: "Cell", label: "Visible row",
        rect: SnapshotRect(x: 0, y: 120, width: 402, height: 52),
        depth: 2, parentIndex: 1),
      Self.foldNode(3, type: "StaticText", label: "Detail",
        rect: SnapshotRect(x: 16, y: 130, width: 200, height: 20), depth: 3, parentIndex: 2),
      Self.foldNode(4, type: "Cell", label: "Offscreen row",
        rect: SnapshotRect(x: 0, y: 900, width: 402, height: 52),
        depth: 2, parentIndex: 1),
      Self.foldNode(5, type: "StaticText", label: "Clamped child",
        rect: SnapshotRect(x: 16, y: 96, width: 100, height: 20), depth: 3, parentIndex: 4),
      // An offscreen generic wrapper does not own visibility; its visible overlay survives and is
      // reparented to the scroll container.
      Self.foldNode(6, type: "Other",
        rect: SnapshotRect(x: 0, y: 900, width: 402, height: 52), depth: 2, parentIndex: 1),
      Self.foldNode(7, type: "StaticText", label: "Visible overlay",
        rect: SnapshotRect(x: 16, y: 200, width: 100, height: 20), depth: 3, parentIndex: 6),
    ]
    let folded = Self.folded(nodes, viewport: CGRect(x: 0, y: 0, width: 402, height: 874))

    XCTAssertEqual(
      folded.map { $0.raw.type },
      ["Application", "ScrollView", "Cell", "StaticText", "StaticText"])
    XCTAssertEqual(
      folded.compactMap { $0.raw.label },
      ["App", "Visible row", "Detail", "Visible overlay"])
    XCTAssertEqual(folded.map { $0.raw.depth }, [0, 1, 2, 3, 2])
    XCTAssertEqual(folded.map { $0.raw.parentIndex }, [nil, 0, 1, 2, 1])
    XCTAssertEqual(folded.first { $0.raw.type == "ScrollView" }?.raw.hiddenContentBelow, true)
  }

  func testRegularFoldKeepsWindowCarriersButNeverHittableOutsideClip() {
    let nodes = [
      Self.foldNode(0, type: "Application", label: "App",
        rect: SnapshotRect(x: 0, y: 0, width: 402, height: 874), depth: 0, parentIndex: nil),
      Self.foldNode(1, type: "Window", label: "Second screen",
        rect: SnapshotRect(x: 402, y: 0, width: 402, height: 874),
        depth: 1, parentIndex: 0),
      Self.foldNode(2, type: "Button", label: "Gone",
        rect: SnapshotRect(x: 500, y: 100, width: 100, height: 44),
        depth: 2, parentIndex: 1),
    ]
    let folded = Self.folded(nodes, viewport: CGRect(x: 0, y: 0, width: 402, height: 874))

    XCTAssertEqual(folded.map { $0.raw.type }, ["Application", "Window"])
    XCTAssertEqual(folded.last?.raw.hittable, false)
    XCTAssertEqual(folded.last?.effectiveRect.x, 402)
    XCTAssertEqual(folded.last?.effectiveRect.y, 0)
    XCTAssertEqual(folded.last?.effectiveRect.width, 0)
    XCTAssertEqual(folded.last?.effectiveRect.height, 0)
    XCTAssertFalse(folded.contains { $0.raw.label == "Gone" })
  }

  func testRegularFoldDropsSubPixelContentlessDecorationOnEveryBackend() {
    let nodes = [
      Self.foldNode(0, type: "Application", label: "App",
        rect: SnapshotRect(x: 0, y: 0, width: 402, height: 874), depth: 0, parentIndex: nil),
      Self.foldNode(1, type: "Button",
        rect: SnapshotRect(x: 0, y: 100, width: 402, height: 1),
        depth: 1, parentIndex: 0),
      Self.foldNode(2, type: "StaticText", label: "Hairline caption",
        rect: SnapshotRect(x: 0, y: 200, width: 402, height: 1), depth: 1, parentIndex: 0),
      Self.foldNode(3, type: "StaticText", label: "Frameless semantics",
        rect: SnapshotRect(x: 0, y: 0, width: 0, height: 0),
        depth: 1, parentIndex: 0),
    ]
    let folded = Self.folded(nodes, viewport: CGRect(x: 0, y: 0, width: 402, height: 874))

    XCTAssertEqual(
      folded.compactMap { $0.raw.label },
      ["App", "Hairline caption", "Frameless semantics"])
    XCTAssertFalse(folded.contains { $0.raw.type == "Button" })
    XCTAssertEqual(folded.first { $0.raw.label == "Frameless semantics" }?.raw.hittable, false)
  }

  func testPlainViewportPolicyFoldsWithoutAncestorCursor() {
    let nodes = [
      Self.foldNode(0, type: "Application", label: "App",
        rect: SnapshotRect(x: 0, y: 0, width: 800, height: 600), depth: 0, parentIndex: nil),
      Self.foldNode(1, type: "Window", label: "Offscreen window",
        rect: SnapshotRect(x: 900, y: 0, width: 800, height: 600), depth: 1, parentIndex: 0),
      Self.foldNode(2, type: "Cell", label: "Offscreen row",
        rect: SnapshotRect(x: 0, y: 900, width: 800, height: 52), depth: 1, parentIndex: 0),
      Self.foldNode(3, type: "StaticText", label: "Clamped child",
        rect: SnapshotRect(x: 16, y: 100, width: 100, height: 20), depth: 2, parentIndex: 2),
    ]
    let viewport = CGRect(x: 0, y: 0, width: 800, height: 600)

    let regular = Self.folded(nodes, viewport: viewport, policy: .plainViewport)
    XCTAssertEqual(
      regular.compactMap { $0.raw.label }, ["App", "Offscreen window", "Clamped child"])

    let interactive = Self.folded(
      nodes, viewport: viewport, interactiveOnly: true, policy: .plainViewport)
    XCTAssertFalse(interactive.contains { $0.raw.label == "Offscreen window" })
  }

  func testPlainViewportPolicyDoesNotClipToScrollAncestor() {
    let nodes = [
      Self.foldNode(0, type: "Application", label: "App",
        rect: SnapshotRect(x: 0, y: 0, width: 800, height: 600), depth: 0, parentIndex: nil),
      Self.foldNode(1, type: "ScrollView", label: "Scroll",
        rect: SnapshotRect(x: 0, y: 100, width: 800, height: 100), depth: 1, parentIndex: 0),
      Self.foldNode(2, type: "StaticText", label: "Outside scroll clip",
        rect: SnapshotRect(x: 16, y: 240, width: 100, height: 20), depth: 2, parentIndex: 1),
    ]
    let viewport = CGRect(x: 0, y: 0, width: 800, height: 600)

    let plain = Self.folded(nodes, viewport: viewport, policy: .plainViewport)
    XCTAssertTrue(plain.contains { $0.raw.label == "Outside scroll clip" })

    let cursorProjected = Self.folded(nodes, viewport: viewport, policy: .cursorProjected)
    XCTAssertFalse(cursorProjected.contains { $0.raw.label == "Outside scroll clip" })
  }

  func testScrollContainerTypeNamesMatchElementTypeSet() {
    XCTAssertEqual(
      SnapshotVisibilityFold.scrollContainerTypeNames,
      Set(Self.scrollContainerTypes.map(elementTypeName))
    )
    XCTAssertEqual(elementTypeName(.cell), "Cell")
  }
}
#endif
