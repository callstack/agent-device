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

  init(_ elementType: XCUIElement.ElementType, _ frame: CGRect, label: String = "", identifier: String = "", children: [XCUIElementSnapshot] = []) {
    self.elementType = elementType
    self.frame = frame
    self.label = label
    self.children = children
    self.identifier = identifier
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
