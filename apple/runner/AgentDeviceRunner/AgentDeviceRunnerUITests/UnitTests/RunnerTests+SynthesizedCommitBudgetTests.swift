import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  private static func budget(
    startedAt: Date,
    stallBudget: TimeInterval = 3,
    ceiling: TimeInterval = 10
  ) -> SynthesizedCommitBudget {
    SynthesizedCommitBudget(startedAt: startedAt, stallBudget: stallBudget, ceiling: ceiling)
  }

  // The #1874 regression, stated as the budget sees it: a burst that keeps landing must keep its
  // wait alive past the old flat deadline. Before this policy the wait expired at 3s regardless,
  // so a throttled-but-working `type`/`fill` reported TEXT_INPUT_COMMIT_NOT_OBSERVED — the red
  // that kept appearing on branches touching no iOS code. Reverting `record` to a no-op turns
  // this red.
  func testProgressKeepsTheCommitWaitAliveBeyondTheFlatDeadline() {
    let start = Date(timeIntervalSinceReferenceDate: 0)
    let budget = Self.budget(startedAt: start)
    // One character per 2 seconds: never idle for 3s, so never expired on the stall rule.
    for (index, second) in [2.0, 4.0, 6.0].enumerated() {
      budget.record(expectedPrefixLength: index + 1, at: start.addingTimeInterval(second))
      XCTAssertFalse(
        budget.isExpired(at: start.addingTimeInterval(second)),
        "progress at \(second)s must not be expired"
      )
    }
    XCTAssertFalse(budget.isExpired(at: start.addingTimeInterval(8)))
  }

  // The other half, and the reason the stall budget keeps the flat deadline's number: a pipeline
  // that delivers nothing is condemned at exactly the instant it always was. Nothing that fails
  // today starts passing by waiting longer.
  func testAWedgedPipelineStillExpiresAtTheStallBudget() {
    let start = Date(timeIntervalSinceReferenceDate: 0)
    let budget = Self.budget(startedAt: start)
    XCTAssertFalse(budget.isExpired(at: start.addingTimeInterval(2.99)))
    XCTAssertTrue(budget.isExpired(at: start.addingTimeInterval(3)))
  }

  // Progress buys time, but not without bound: one character per stall window would otherwise
  // hold a command open until the daemon's own 45s timeout killed the runner's request.
  func testTheCeilingBoundsAnIndefinitelyThrottledPipeline() {
    let start = Date(timeIntervalSinceReferenceDate: 0)
    let budget = Self.budget(startedAt: start)
    for index in 1...5 {
      let now = start.addingTimeInterval(Double(index) * 2)
      budget.record(expectedPrefixLength: index, at: now)
      XCTAssertEqual(budget.isExpired(at: now), index == 5, "at \(index * 2)s")
    }
  }

  // Only forward movement is evidence the burst is still landing. A field the app clears
  // mid-flight, or an unreadable poll (`observe` reports -1), must not reset the stall clock —
  // that would let a wedge disguised as churn hold the wait open to the ceiling every time.
  func testBackwardsAndUnreadableObservationsBuyNoTime() {
    let start = Date(timeIntervalSinceReferenceDate: 0)
    let budget = Self.budget(startedAt: start)
    budget.record(expectedPrefixLength: 5, at: start.addingTimeInterval(1))
    for (prefixLength, second) in [(0, 2.0), (-1, 3.0), (5, 3.5)] {
      budget.record(expectedPrefixLength: prefixLength, at: start.addingTimeInterval(second))
    }
    XCTAssertTrue(
      budget.isExpired(at: start.addingTimeInterval(4)),
      "the stall clock must still date from the 1s observation that actually advanced"
    )
  }
#endif
}
