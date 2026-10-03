import XCTest

@testable import AgentDeviceMacOSHelper

private struct ScrollGestureFixture: Decodable {
  struct Constants: Decodable {
    let defaultScrollAmount: Double
  }
  struct Expected: Decodable {
    let pixels: Double
  }
  struct Case: Decodable {
    let name: String
    let direction: String
    let amount: Double?
    let pixels: Double?
    let referenceWidth: Double
    let referenceHeight: Double
    let expected: Expected
  }

  let constants: Constants
  let cases: [Case]
}

private struct HelperOutcomesFixture: Decodable {
  let refusalReasons: [String]
  let deliveryMechanisms: [String]
}

/// `#filePath` is `<repo>/apple/macos-helper/Tests/AgentDeviceMacOSHelperTests/<file>`.
private let repoRoot = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  .deletingLastPathComponent().deletingLastPathComponent()

final class BackgroundInteractionTests: XCTestCase {
  /// The host keys refusals and mechanisms on these strings; the table is their one declaration.
  func testOutcomeVocabularyMatchesTheSharedTable() throws {
    let fixture = try JSONDecoder().decode(
      HelperOutcomesFixture.self,
      from: Data(
        contentsOf: repoRoot.appendingPathComponent("contracts/fixtures/macos-native-helper-outcomes.json"))
    )
    XCTAssertEqual(BackgroundRefusal.allCases.map(\.rawValue), fixture.refusalReasons)
    XCTAssertEqual(BackgroundDeliveryMechanism.allCases.map(\.rawValue), fixture.deliveryMechanisms)
  }

  /// The native backend scrolls as far as the runner does: its travel agrees with every case of
  /// the cross-language table the runner and the TypeScript planner are held to.
  func testScrollTravelMatchesTheSharedScrollGestureTable() throws {
    let fixtureURL = repoRoot.appendingPathComponent("contracts/fixtures/scroll-gesture.json")
    let fixture = try JSONDecoder().decode(
      ScrollGestureFixture.self, from: Data(contentsOf: fixtureURL))
    XCTAssertFalse(fixture.cases.isEmpty)
    for testCase in fixture.cases {
      let isVertical = testCase.direction == "up" || testCase.direction == "down"
      let travel = scrollTravelPixels(
        axisLength: isVertical ? testCase.referenceHeight : testCase.referenceWidth,
        amount: testCase.amount,
        pixels: testCase.pixels
      )
      XCTAssertEqual(travel, testCase.expected.pixels, testCase.name)
    }
    XCTAssertEqual(
      scrollTravelPixels(axisLength: 1000, amount: nil, pixels: nil),
      (1000 * fixture.constants.defaultScrollAmount).rounded(),
      "an unspecified distance travels the table's default amount"
    )
  }

  func testScrollBarValueMovesByTheTravelShareOfTheOverflow() {
    XCTAssertEqual(scrollBarValue(current: 0, signedTravel: 300, overflow: 1200), 0.25)
    XCTAssertEqual(scrollBarValue(current: 0.5, signedTravel: -300, overflow: 1200), 0.25)
  }

  func testScrollBarValueStopsAtTheEnds() {
    XCTAssertEqual(scrollBarValue(current: 0.9, signedTravel: 600, overflow: 1200), 1)
    XCTAssertEqual(scrollBarValue(current: 0.1, signedTravel: -600, overflow: 1200), 0)
  }

  /// Chromium marks wrapper groups pressable; only a control role may win the press outright.
  func testWrapperGroupsAreNotPressableControls() {
    XCTAssertTrue(isPressableControlRole("AXButton"))
    XCTAssertTrue(isPressableControlRole("AXLink"))
    XCTAssertFalse(isPressableControlRole("AXGroup"))
    XCTAssertFalse(isPressableControlRole("AXWebArea"))
  }
}
