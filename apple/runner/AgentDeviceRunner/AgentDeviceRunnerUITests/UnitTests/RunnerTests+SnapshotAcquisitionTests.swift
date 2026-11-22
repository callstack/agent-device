#if AGENT_DEVICE_RUNNER_UNIT_TESTS
import XCTest
import AgentDeviceSnapshotPresentation

/// Snapshot attributes shared by query-predicate and capture-plan fixtures.
@MainActor
final class ElementAttributesFixture: NSObject, XCUIElementSnapshot {
  let elementType: XCUIElement.ElementType
  let frame: CGRect
  let label: String
  let children: [XCUIElementSnapshot]
  let identifier: String
  @objc let displayID: NSNumber?

  init(_ elementType: XCUIElement.ElementType, _ frame: CGRect, label: String = "", identifier: String = "", children: [XCUIElementSnapshot] = [], displayID: NSNumber? = nil) {
    self.elementType = elementType
    self.frame = frame
    self.label = label
    self.children = children
    self.identifier = identifier
    self.displayID = displayID
  }

  var value: Any? { nil }
  var title: String { "" }
  var isEnabled: Bool { true }
  var horizontalSizeClass: XCUIElement.SizeClass { .unspecified }
  var verticalSizeClass: XCUIElement.SizeClass { .unspecified }
  var placeholderValue: String? { nil }
  var isSelected: Bool { false }
#if !os(macOS)
  var hasFocus: Bool { false }
#endif
  var dictionaryRepresentation: [XCUIElement.AttributeName: Any] { [:] }
}

extension RunnerTests {
  private static let containerFrame = CGRect(x: 20, y: 800, width: 360, height: 31)

  /// A snapshot frame is in window content space, so only a full-screen window at the origin may stand
  /// in for the live window read. A placed iPad window's content frame starts at the origin too, so
  /// AXRuntime's full-screen frame is what tells the two apart.
  func testSnapshotViewportUsesOnlyAFullScreenWindowAtTheOrigin() {
    let screen = CGRect(x: 0, y: 0, width: 440, height: 956)
    XCTAssertEqual(Self.fullScreenWindowFrame(windowFrames: [screen], fullScreenFrame: screen), screen)
    XCTAssertEqual(
      Self.fullScreenWindowFrame(windowFrames: [.zero, screen], fullScreenFrame: screen),
      screen,
      "an unmeasured window is skipped, as the live read skips it"
    )

    let ipadScreen = CGRect(x: 0, y: 0, width: 1032, height: 1376)
    let liveRead: [(name: String, windows: [CGRect], fullScreen: CGRect)] = [
      ("not full screen", [screen], .null),
      ("placed iPad window", [CGRect(x: 0, y: 0, width: 375, height: 575)], ipadScreen),
      ("offset window", [CGRect(x: 0, y: 20, width: 440, height: 956)], screen),
      ("landscape window", [CGRect(x: 0, y: 0, width: 956, height: 440)], screen),
      ("first usable window is not the screen", [CGRect(x: 0, y: 0, width: 320, height: 480), screen], screen),
      ("no window", [], screen),
    ]
    for testCase in liveRead {
      XCTAssertNil(
        Self.fullScreenWindowFrame(windowFrames: testCase.windows, fullScreenFrame: testCase.fullScreen),
        testCase.name
      )
    }
  }

  @MainActor
  func testCollapsedTabCandidatePredicateMatchesLabeledCandidatesCenteredInAContainer() {
    var matched: [String] = []
    let predicate = Self.collapsedTabCandidatePredicate(containerFrames: [
      CGRect(x: 0, y: 0, width: 400, height: 50),
      Self.containerFrame,
    ]) { matched.append($0.label) }

    XCTAssertTrue(predicate.evaluate(with: ElementAttributesFixture(.button, CGRect(x: 30, y: 800, width: 100, height: 30), label: "Left")))
    XCTAssertTrue(predicate.evaluate(with: ElementAttributesFixture(.staticText, CGRect(x: 10, y: 10, width: 80, height: 20), label: "Home")))
    XCTAssertEqual(matched, ["Left", "Home"], "every accepted element's attributes reach the caller")
  }

  @MainActor
  func testCollapsedTabCandidatePredicateRefusesTheContainerOtherTypesAndOutsiders() {
    // Closest negatives, each labeled unless it tests content: the container's own frame and a
    // wrapper centered on it, both too large; an unlabeled view over it; a non-candidate type over
    // it; and a candidate overlapping it with its center outside.
    var matched: [String] = []
    let predicate = Self.collapsedTabCandidatePredicate(containerFrames: [Self.containerFrame]) {
      matched.append($0.label)
    }
    let item = CGRect(x: 30, y: 800, width: 100, height: 30)

    XCTAssertFalse(predicate.evaluate(with: ElementAttributesFixture(.other, Self.containerFrame, label: "Volume")))
    XCTAssertFalse(predicate.evaluate(with: ElementAttributesFixture(.other, CGRect(x: 0, y: 515, width: 400, height: 600), label: "Sheet")))
    XCTAssertFalse(predicate.evaluate(with: ElementAttributesFixture(.other, item, label: "  ")))
    XCTAssertFalse(predicate.evaluate(with: ElementAttributesFixture(.image, item, label: "Left")))
    XCTAssertFalse(predicate.evaluate(with: ElementAttributesFixture(.button, CGRect(x: 30, y: 780, width: 100, height: 30), label: "Left")))
    XCTAssertEqual(matched, [], "a refused element's attributes are not recorded")
  }

  /// The Limrun provider applies the same geometry to its tab bar hit-tests and reads this table too.
  @MainActor
  func testCollapsedTabGeometryMatchesGoldenFixture() throws {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("contracts/fixtures/ios-collapsed-tab-geometry.json")
    let fixture = try JSONDecoder().decode(CollapsedTabGeometryFixture.self, from: Data(contentsOf: fixtureURL))
    XCTAssertFalse(fixture.containers.isEmpty)
    XCTAssertFalse(fixture.candidates.isEmpty)
    XCTAssertFalse(fixture.rows.isEmpty)
    for row in fixture.containers {
      XCTAssertEqual(isCollapsedTabContainer(ElementAttributesFixture(.tabBar, row.frame.cgRect)), row.expected, row.name)
    }
    for row in fixture.candidates {
      XCTAssertEqual(
        Self.isCollapsedTabCandidate(type: .button, frame: row.frame.cgRect, in: row.container.cgRect),
        row.expected, row.name
      )
    }
    for row in fixture.rows {
      XCTAssertEqual(
        Self.collapsedTabRowFits(midpoints: row.midpoints, containerHeight: row.container.height),
        row.expected, row.name
      )
    }
  }

  /// A grafted node joins right after its parent, so the walk's preorder and index = position hold,
  /// and every later node keeps pointing at the same parent.
  func testInsertingFirstChildKeepsPreorderAndParentReferences() {
    func node(_ index: Int, _ identifier: String, depth: Int, parent: Int?) -> RawAXNode {
      RawAXNode(
        index: index,
        type: "Other",
        label: nil,
        identifier: identifier,
        value: nil,
        rect: SnapshotRect(x: 0, y: 0, width: 10, height: 10),
        enabled: true,
        focused: nil,
        selected: nil,
        hittable: false,
        depth: depth,
        parentIndex: parent,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    }
    let nodes = [
      node(0, "root", depth: 0, parent: nil),
      node(1, "container", depth: 1, parent: 0),
      node(2, "container-child", depth: 2, parent: 1),
      node(3, "sibling", depth: 1, parent: 0),
      node(4, "sibling-child", depth: 2, parent: 3),
    ]
    let inserted = Self.insertingFirstChild(node(0, "input", depth: 0, parent: nil), under: 1, into: nodes)

    XCTAssertEqual(
      inserted.map { $0.identifier },
      ["root", "container", "input", "container-child", "sibling", "sibling-child"]
    )
    XCTAssertEqual(inserted.map(\.index), Array(0..<6))
    XCTAssertEqual(inserted.map(\.parentIndex), [nil, 0, 1, 1, 0, 4])
    XCTAssertEqual(inserted.map(\.depth), [0, 1, 2, 2, 1, 2])
  }
}

private struct CollapsedTabGeometryFixture: Decodable {
  struct Rect: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
  }
  struct Container: Decodable {
    let name: String
    let frame: Rect
    let expected: Bool
  }
  struct Candidate: Decodable {
    let name: String
    let container: Rect
    let frame: Rect
    let expected: Bool
  }
  struct Row: Decodable {
    let name: String
    let container: Rect
    let midpoints: [Double]
    let expected: Bool
  }
  let containers: [Container]
  let candidates: [Candidate]
  let rows: [Row]
}
#endif
