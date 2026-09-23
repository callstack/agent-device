import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct ScrollGestureFixture: Decodable {
  struct Constants: Decodable {
    let defaultIosScrollAmount: Double
    let defaultMobileScrollDurationMs: Double
    let defaultIosScrollDurationMs: Double
    let defaultScrollAmount: Double
    let defaultEdgePaddingFraction: Double
    let ordinaryScrollReleaseBehavior: String
    let edgeScrollReleaseBehavior: String
  }
  struct Expected: Decodable {
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double
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

extension RunnerTests {
  // Cross-language parity table: every case in contracts/fixtures/scroll-gesture.json must agree
  // with the vitest twin (packages/contracts/src/scroll-gesture.test.ts). Add vectors there,
  // never fork the math.
  private func loadScrollGestureFixture() throws -> ScrollGestureFixture {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // UnitTests
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("scroll-gesture.json")
    return try JSONDecoder().decode(ScrollGestureFixture.self, from: Data(contentsOf: fixtureURL))
  }

  func testRunnerScrollGesturePlanMatchesParityTable() throws {
    let fixture = try loadScrollGestureFixture()
    XCTAssertFalse(fixture.cases.isEmpty, "parity table must not be empty")
    for testCase in fixture.cases {
      let plan = try XCTUnwrap(
        runnerScrollGesturePlan(
          direction: try XCTUnwrap(RunnerScrollDirection(rawValue: testCase.direction)),
          amount: testCase.amount,
          pixels: testCase.pixels,
          referenceWidth: testCase.referenceWidth,
          referenceHeight: testCase.referenceHeight
        ),
        testCase.name
      )
      XCTAssertEqual(plan.x1, testCase.expected.x1, testCase.name)
      XCTAssertEqual(plan.y1, testCase.expected.y1, testCase.name)
      XCTAssertEqual(plan.x2, testCase.expected.x2, testCase.name)
      XCTAssertEqual(plan.y2, testCase.expected.y2, testCase.name)
      XCTAssertEqual(plan.travelPixels, testCase.expected.pixels, testCase.name)
    }
  }

  // The planner constants are private on both sides; the table pins them behaviourally on a
  // 1000px axis where every rounding step is exact.
  func testRunnerScrollGesturePlanUsesParityTableConstants() throws {
    let constants = try loadScrollGestureFixture().constants
    let defaultScroll = try JSONDecoder().decode(
      Command.self, from: Data(#"{"command":"scroll"}"#.utf8))
    let defaults = runnerDragCommandDefaults(defaultScroll)
    XCTAssertEqual(defaults.durationMs, constants.defaultIosScrollDurationMs)
    XCTAssertEqual(defaults.scrollAmount, constants.defaultIosScrollAmount)
    let defaulted = try XCTUnwrap(
      runnerScrollGesturePlan(
        direction: .down, amount: nil, pixels: nil, referenceWidth: 1000, referenceHeight: 1000
      )
    )
    XCTAssertEqual(defaulted.travelPixels, 1000 * constants.defaultScrollAmount)
    let saturated = try XCTUnwrap(
      runnerScrollGesturePlan(
        direction: .down, amount: 10, pixels: nil, referenceWidth: 1000, referenceHeight: 1000
      )
    )
    XCTAssertEqual(
      saturated.travelPixels, 1000 - 2 * 1000 * constants.defaultEdgePaddingFraction)
  }

  func testRunnerScrollAndDragCommandDefaultsStayDistinct() throws {
    func command(_ json: String) throws -> Command {
      try JSONDecoder().decode(Command.self, from: Data(json.utf8))
    }

    let pixelScroll = runnerDragCommandDefaults(
      try command(#"{"command":"scroll","pixels":120}"#))
    XCTAssertNil(pixelScroll.scrollAmount)
    XCTAssertEqual(pixelScroll.durationMs, 400)

    let drag = runnerDragCommandDefaults(try command(#"{"command":"drag"}"#))
    XCTAssertNil(drag.scrollAmount)
    XCTAssertEqual(drag.durationMs, 250)

    let explicitScroll = runnerDragCommandDefaults(
      try command(#"{"command":"scroll","amount":0.5,"durationMs":125}"#))
    XCTAssertEqual(explicitScroll.scrollAmount, 0.5)
    XCTAssertEqual(explicitScroll.durationMs, 125)

    let explicitDrag = runnerDragCommandDefaults(
      try command(#"{"command":"drag","durationMs":125}"#))
    XCTAssertEqual(explicitDrag.durationMs, 125)
  }

  func testRunnerScrollReleaseBehaviorSelectsTheDragProfile() throws {
    let constants = try loadScrollGestureFixture().constants
    let controlled = try XCTUnwrap(ScrollReleaseBehavior(rawValue: constants.ordinaryScrollReleaseBehavior))
    let inertial = try XCTUnwrap(ScrollReleaseBehavior(rawValue: constants.edgeScrollReleaseBehavior))
    XCTAssertEqual(
      scrollDragProfile(releaseBehavior: nil),
      .controlledScroll
    )
    XCTAssertEqual(
      scrollDragProfile(releaseBehavior: controlled),
      .controlledScroll
    )
    XCTAssertEqual(
      scrollDragProfile(releaseBehavior: inertial),
      .fastSwipe
    )
  }

  func testControlledScrollProfileUsesReliableCadenceAndMonotonicDeceleration() {
    XCTAssertEqual(RunnerControlledScrollFrameCount(350), 21)
    XCTAssertEqual(RunnerControlledScrollFrameCount(400), 24)
    XCTAssertEqual(RunnerControlledScrollFrameCount(500), 30)
    XCTAssertEqual(RunnerControlledScrollFrameCount(1_000), 30)
    XCTAssertEqual(RunnerControlledScrollFrameCount(10_000), 30)

    let frameCount = RunnerControlledScrollFrameCount(400)
    let progress = (0...frameCount).map {
      RunnerControlledScrollProgress(Double($0) / Double(frameCount))
    }
    let deltas = zip(progress.dropFirst(), progress).map { $0.0 - $0.1 }
    XCTAssertEqual(progress.first, 0)
    XCTAssertEqual(progress.last, 1)
    XCTAssertTrue(zip(deltas, deltas.dropFirst()).allSatisfy { $0.1 <= $0.0 })

    let iPhoneViewportPoints = 874.0
    let defaultFingerTravel = iPhoneViewportPoints * 0.65
    let finalSampleTravel = (1 - progress[progress.count - 2]) * defaultFingerTravel
    XCTAssertLessThan(finalSampleTravel, 0.1)
  }

  func testRunnerScrollGesturePlanRejectsUnknownDirection() {
    XCTAssertNil(RunnerScrollDirection(rawValue: "sideways"))
  }

  func testRunnerScrollGesturePlanRejectsInvalidAmountAndPixels() {
    XCTAssertNil(
      runnerScrollGesturePlan(
        direction: .down,
        amount: 0,
        pixels: nil,
        referenceWidth: 300,
        referenceHeight: 600
      )
    )
    XCTAssertNil(
      runnerScrollGesturePlan(
        direction: .down,
        amount: nil,
        pixels: -10,
        referenceWidth: 300,
        referenceHeight: 600
      )
    )
    XCTAssertNil(
      runnerScrollGesturePlan(
        direction: .down,
        amount: .infinity,
        pixels: nil,
        referenceWidth: 300,
        referenceHeight: 600
      )
    )
  }
}
#endif
