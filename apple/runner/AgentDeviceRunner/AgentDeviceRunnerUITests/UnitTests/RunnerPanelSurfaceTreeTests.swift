import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
// MARK: - What one panel's fact says about a captured tree (ADR 0025)

extension RunnerTests {
  /// The Duo's lit inner panel as the interaction space reports it: the panel table names 669x951 and
  /// the system presents that panel turned, so its surface box swaps the side lengths.
  private static let litSurface = CGRect(x: 0, y: 0, width: 951, height: 669)
  /// SpringBoard's outer-panel window, which the platform handed back as the app's only window on the
  /// run that found this bug. The device was unfolded, so nothing in it can be seen.
  private static let offPanelWindow = CGRect(x: 0, y: 0, width: 466, height: 678)

  private static func panelNode(
    _ index: Int,
    type: String,
    rect: CGRect,
    parentIndex: Int?
  ) -> RawAXNode {
    RawAXNode(
      index: index,
      type: type,
      label: nil,
      identifier: nil,
      value: nil,
      rect: SnapshotRect(rect),
      enabled: true,
      focused: nil,
      selected: nil,
      hittable: parentIndex == nil ? false : true,
      depth: parentIndex == nil ? 0 : 1,
      parentIndex: parentIndex,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }

  /// The tree the bug produced: an app root naming the dark panel, one window naming the dark panel, and
  /// content under it.
  private static func darkPanelOnlyTree() -> [RawAXNode] {
    [
      panelNode(0, type: "Application", rect: Self.offPanelWindow, parentIndex: nil),
      panelNode(1, type: "Window", rect: Self.offPanelWindow, parentIndex: 0),
      panelNode(2, type: "Button", rect: CGRect(x: 20, y: 120, width: 250, height: 42), parentIndex: 1),
    ]
  }

  func testPanelBoxMatchesItsOwnBoxAndThatBoxTurned() {
    XCTAssertTrue(
      RunnerPanelSurfaceTree.matchesSurfaceBox(Self.litSurface, Self.litSurface),
      "the panel's own box is its surface"
    )
    XCTAssertTrue(
      RunnerPanelSurfaceTree.matchesSurfaceBox(
        CGRect(x: 0, y: 0, width: 669, height: 951),
        Self.litSurface
      ),
      "the panel table reports native points and the system presents the panel turned"
    )
    XCTAssertFalse(
      RunnerPanelSurfaceTree.matchesSurfaceBox(Self.offPanelWindow, Self.litSurface),
      "another panel's box is not this panel's surface"
    )
    XCTAssertFalse(
      RunnerPanelSurfaceTree.matchesSurfaceBox(
        CGRect(x: 0, y: 0, width: 951, height: 600),
        Self.litSurface
      ),
      "a window that stops short of the panel is an app occupying part of it, not the surface"
    )
  }

  func testASurfaceLiesOnThePanelItCanBeSeenOn() {
    XCTAssertTrue(
      RunnerPanelSurfaceTree.liesOnSurface(CGRect(x: 0, y: 0, width: 951, height: 669), Self.litSurface)
    )
    XCTAssertTrue(
      RunnerPanelSurfaceTree.liesOnSurface(
        CGRect(x: 100, y: 50, width: 300, height: 200),
        Self.litSurface
      ),
      "a sheet inside the panel's box is on the panel"
    )
    XCTAssertFalse(
      RunnerPanelSurfaceTree.liesOnSurface(Self.offPanelWindow, Self.litSurface),
      "a box reaching past the panel's bottom edge is on another display"
    )
    XCTAssertFalse(
      RunnerPanelSurfaceTree.liesOnSurface(CGRect(x: 0, y: 0, width: 0, height: 669), Self.litSurface),
      "a box with no width names no surface at all"
    )
  }

  /// The root node is the box the host reads as the payload's viewport, so an app root that reports a
  /// panel's box is republished with the surface box the capture resolved.
  func testPanelTreePublishesTheSurfaceBoxOnItsRoot() throws {
    let published = try XCTUnwrap(
      RunnerPanelSurfaceTree.publishing(nodes: Self.darkPanelOnlyTree(), surface: Self.litSurface)
    )
    XCTAssertTrue(published.republishedRoot)
    XCTAssertEqual(published.droppedSurfaces, 1)
    XCTAssertEqual(published.nodes.count, 1, "the dark panel's window and its content are both gone")
    XCTAssertEqual(published.nodes[0].rect.cgRect, Self.litSurface)
    XCTAssertNil(published.nodes[0].parentIndex)
  }

  /// Dropping a surface drops its subtree: a ref for a control on a dark panel would name a point no
  /// gesture can land on, and the host's own containment rule refuses the node anyway.
  func testPanelTreeDropsAWindowsWholeSubtree() throws {
    var nodes = Self.darkPanelOnlyTree()
    nodes.append(
      Self.panelNode(
        3,
        type: "Cell",
        rect: CGRect(x: 20, y: 170, width: 250, height: 42),
        parentIndex: 1
      )
    )
    nodes.append(
      Self.panelNode(
        4,
        type: "Window",
        rect: Self.litSurface,
        parentIndex: 0
      )
    )
    nodes.append(
      Self.panelNode(
        5,
        type: "Button",
        rect: CGRect(x: 470, y: 54, width: 60, height: 60),
        parentIndex: 4
      )
    )
    let published = try XCTUnwrap(RunnerPanelSurfaceTree.publishing(nodes: nodes, surface: Self.litSurface))
    XCTAssertEqual(published.droppedSurfaces, 1)
    XCTAssertEqual(
      published.nodes.map(\.type),
      ["Application", "Window", "Button"],
      "the lit panel's window and its control survive"
    )
    XCTAssertEqual(published.nodes.map(\.index), Array(0..<3), "the wire array stays positional")
    XCTAssertEqual(published.nodes[1].parentIndex, 0, "the kept window is still the app's child")
    XCTAssertEqual(published.nodes[2].parentIndex, 1, "the kept control is still its window's child")
    XCTAssertEqual(
      published.nodes[2].depth,
      nodes[5].depth,
      "whole siblings were removed, so no kept node changed depth"
    )
  }

  /// The common case must cost nothing: an app whose window fills the lit panel already publishes the
  /// right root box, and there is nothing to drop.
  func testPanelTreeLeavesATreeOfTheLitPanelAlone() {
    let nodes = [
      Self.panelNode(0, type: "Application", rect: Self.litSurface, parentIndex: nil),
      Self.panelNode(1, type: "Window", rect: Self.litSurface, parentIndex: 0),
    ]
    XCTAssertNil(RunnerPanelSurfaceTree.publishing(nodes: nodes, surface: Self.litSurface))
  }

  /// A keyboard band, an alert, or a hosted surface that reaches past the panel's edge is content the
  /// fold clips, so only a root's own children are ever dropped.
  func testPanelTreeKeepsContentThatReachesPastThePanel() {
    let nodes = [
      Self.panelNode(0, type: "Application", rect: Self.litSurface, parentIndex: nil),
      Self.panelNode(1, type: "Window", rect: Self.litSurface, parentIndex: 0),
      Self.panelNode(
        2,
        type: "ScrollView",
        rect: CGRect(x: -57, y: -40, width: 1065, height: 749),
        parentIndex: 1
      ),
    ]
    XCTAssertNil(RunnerPanelSurfaceTree.publishing(nodes: nodes, surface: Self.litSurface))
  }

  /// The private-AX tier's tree and a scoped capture are rooted at what they read rather than at an
  /// application element. Such a payload was read from one surface, so its nodes are left as they were
  /// read: narrowing them would be a guess about which screen they came from.
  func testPanelTreeLeavesATreeNotRootedAtAnApplicationAlone() {
    for nodes in [
      [Self.panelNode(0, type: "Window", rect: Self.offPanelWindow, parentIndex: nil)],
      [
        Self.panelNode(0, type: "Other", rect: Self.offPanelWindow, parentIndex: nil),
        Self.panelNode(1, type: "Window", rect: Self.offPanelWindow, parentIndex: 0),
      ],
    ] {
      XCTAssertNil(
        RunnerPanelSurfaceTree.publishing(nodes: nodes, surface: Self.litSurface),
        "no application root, so no window list to narrow"
      )
    }
  }

  /// The capture's own evidence that its tree already shows the lit panel, which is what decides whether
  /// a second read of the resolved window is needed at all.
  func testCarriesSurfaceWindowReadsOneLayerOnly() {
    struct Layer {
      let type: String
      let rect: CGRect
    }
    let layers = [
      Layer(type: "Other", rect: Self.litSurface),
      Layer(type: "Window", rect: Self.offPanelWindow),
    ]
    XCTAssertFalse(
      RunnerPanelSurfaceTree.carriesSurfaceWindow(
        layers,
        surface: Self.litSurface,
        isSurface: { $0.type == "Window" },
        frame: { $0.rect }
      ),
      "the only window is on another panel"
    )
    XCTAssertTrue(
      RunnerPanelSurfaceTree.carriesSurfaceWindow(
        layers + [Layer(type: "Window", rect: CGRect(x: 0, y: 0, width: 669, height: 951))],
        surface: Self.litSurface,
        isSurface: { $0.type == "Window" },
        frame: { $0.rect }
      ),
      "a turned window on the panel counts"
    )
    XCTAssertFalse(
      RunnerPanelSurfaceTree.carriesSurfaceWindow(
        [Layer(type: "Other", rect: Self.litSurface)],
        surface: Self.litSurface,
        isSurface: { $0.type == "Window" },
        frame: { $0.rect }
      ),
      "a container is not a surface"
    )
  }
}
#endif
