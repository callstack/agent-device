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
    let defaultRefreshPullAmount: Double
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
  struct PullCase: Decodable {
    let name: String
    let container: RunnerWireRect
    let amount: Double?
    let pixels: Double?
    let referenceWidth: Double
    let referenceHeight: Double
    let expected: Expected
  }

  let constants: Constants
  let cases: [Case]
  let pullCases: [PullCase]
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

  private func assertPlan(
    _ plan: RunnerScrollGesturePlan,
    matches expected: ScrollGestureFixture.Expected,
    _ name: String
  ) {
    XCTAssertEqual(plan.x1, expected.x1, name)
    XCTAssertEqual(plan.y1, expected.y1, name)
    XCTAssertEqual(plan.x2, expected.x2, name)
    XCTAssertEqual(plan.y2, expected.y2, name)
    XCTAssertEqual(plan.travelPixels, expected.pixels, name)
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
      assertPlan(plan, matches: testCase.expected, testCase.name)
    }
  }

  // The pull planner (runnerPullRefreshGesturePlan) shares the parity table's `pullCases`,
  // asserted here AND by the TS port (buildPullRefreshGesturePlan in
  // packages/contracts/src/scroll-gesture.test.ts).
  func testRunnerPullRefreshGesturePlanMatchesParityTable() throws {
    let fixture = try loadScrollGestureFixture()
    XCTAssertFalse(fixture.pullCases.isEmpty, "pull parity table must not be empty")
    for testCase in fixture.pullCases {
      let plan = try XCTUnwrap(
        runnerPullRefreshGesturePlan(
          amount: testCase.amount,
          pixels: testCase.pixels,
          frame: CGRect(x: 0, y: 0, width: testCase.referenceWidth, height: testCase.referenceHeight),
          container: testCase.container.rect
        ),
        testCase.name
      )
      assertPlan(plan, matches: testCase.expected, testCase.name)
    }
  }

  func testRunnerContainerInPlanFrameSubtractsANonZeroWindowOrigin() {
    // iPad split view: the window's on-screen rect starts at (400, 120), and the daemon's
    // scrollPullContainer arrives in screen coordinates.
    let frame = CGRect(x: 400, y: 120, width: 600, height: 900)
    let container = CGRect(x: 420, y: 240, width: 560, height: 700)
    let converted = runnerContainerInPlanFrame(container, frame: frame)
    XCTAssertEqual(converted, CGRect(x: 20, y: 120, width: 560, height: 700))
    // A full-screen window keeps the container unchanged.
    let fullScreen = CGRect(x: 0, y: 0, width: 1000, height: 1000)
    XCTAssertEqual(
      runnerContainerInPlanFrame(container, frame: fullScreen),
      container
    )
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
