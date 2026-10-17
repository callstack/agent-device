#if AGENT_DEVICE_RUNNER_UNIT_TESTS
import XCTest
import AgentDeviceSnapshotPresentation

/// An element's attributes as XCTest hands them to a query predicate.
@MainActor
private final class ElementAttributesFixture: NSObject, XCUIElementSnapshot {
  let elementType: XCUIElement.ElementType
  let frame: CGRect
  let label: String

  init(_ elementType: XCUIElement.ElementType, _ frame: CGRect, label: String = "") {
    self.elementType = elementType
    self.frame = frame
    self.label = label
  }

  var identifier: String { "" }
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
  var children: [XCUIElementSnapshot] { [] }
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
}
#endif
