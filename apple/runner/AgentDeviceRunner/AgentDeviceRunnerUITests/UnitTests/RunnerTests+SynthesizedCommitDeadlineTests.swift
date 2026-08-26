import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  /// A hand-driven clock for the commit waits. Time moves only where the wait sleeps, which is
  /// what makes "the burst kept landing" and "the pipeline froze" expressible as two sequences of
  /// the same length rather than as wall-clock luck — and a test that never advances it cannot
  /// expire any budget, so only a test asking about time names `stallBudget`/`ceiling`.
  final class CommitWaitClock {
    private let origin = Date(timeIntervalSinceReferenceDate: 0)
    private var current = Date(timeIntervalSinceReferenceDate: 0)

    var read: () -> Date { { self.current } }

    func advance(_ seconds: TimeInterval) {
      current = current.addingTimeInterval(seconds)
    }

    /// Seconds elapsed on this clock, for asserting *when* a wait gave up.
    var elapsed: TimeInterval { current.timeIntervalSince(origin) }
  }

  // #1874, through the shipped wait rather than a detached policy object: a burst that keeps
  // landing must outlive the flat 3s deadline that used to govern it. Each poll advances the
  // clock 2s and delivers one more character, so the wait is never idle for a full stall budget
  // and must walk all the way to the match at t=6s. Reverting the wait to a flat deadline turns
  // this red at the third poll.
  func testCommitWaitOutlivesTheFlatDeadlineWhileTheExpectedPrefixGrows() {
    let expected = "hardware"
    let clock = CommitWaitClock()
    var landed = 0
    let outcome = Self.awaitSynthesizedCommitOutcome(
      expectedText: expected,
      placeholder: nil,
      stallBudget: 3,
      ceiling: 10,
      now: clock.read,
      observe: { String(expected.prefix(landed * 2)) },
      waitForNextObservation: {
        landed += 1
        clock.advance(2)
      }
    )
    XCTAssertEqual(outcome, .settled)
    XCTAssertEqual(clock.elapsed, 8, "the wait must still be polling well past the 3s stall budget")
  }

  // Review finding: the wait's setup reads the field's placeholder first, and that is an AX
  // round-trip which takes seconds on exactly the loaded host this budget exists for. An earlier
  // revision started the clock before that read, so slow setup spent the budget and the wait gave
  // up after a single poll — sooner than the flat deadline it replaced, in the one condition it
  // was written for. The clock now starts inside the loop, so a slow setup buys nothing and costs
  // nothing.
  func testCommitWaitBudgetStartsAtTheLoopRatherThanBeforeIt() {
    let clock = CommitWaitClock()
    clock.advance(60)
    var polls = 0
    let outcome = Self.awaitSynthesizedCommitOutcome(
      expectedText: "hardware",
      placeholder: nil,
      stallBudget: 3,
      ceiling: 10,
      now: clock.read,
      observe: { "ha" },
      waitForNextObservation: {
        polls += 1
        clock.advance(1)
      }
    )
    XCTAssertEqual(outcome, .notObserved)
    XCTAssertEqual(polls, 3, "the wait must get its whole stall budget however slow its setup was")
  }

  // The other half, and the reason the stall budget keeps the flat deadline's number: a pipeline
  // that delivers nothing is condemned at exactly the instant it always was, so nothing that
  // fails today starts passing merely by waiting longer.
  func testCommitWaitCondemnsAFrozenPipelineAtTheStallBudget() {
    let clock = CommitWaitClock()
    let outcome = Self.awaitSynthesizedCommitOutcome(
      expectedText: "hardware",
      placeholder: nil,
      stallBudget: 3,
      ceiling: 10,
      now: clock.read,
      observe: { "ha" },
      waitForNextObservation: { clock.advance(1) }
    )
    XCTAssertEqual(outcome, .notObserved)
    XCTAssertEqual(clock.elapsed, 3, "a frozen prefix must give up on the stall budget, not the ceiling")
  }

  // Progress buys time, but not without bound: one character per stall window would otherwise
  // hold the command open until the daemon's own 45s budget killed the request. Here every poll
  // lands a character, so only the ceiling can stop it.
  func testCommitWaitCeilingStopsAnIndefinitelyThrottledPipeline() {
    let clock = CommitWaitClock()
    var landed = 0
    let outcome = Self.awaitSynthesizedCommitOutcome(
      expectedText: String(repeating: "a", count: 100),
      placeholder: nil,
      stallBudget: 3,
      ceiling: 10,
      now: clock.read,
      observe: { String(repeating: "a", count: landed) },
      waitForNextObservation: {
        landed += 1
        clock.advance(2)
      }
    )
    XCTAssertEqual(outcome, .notObserved)
    XCTAssertEqual(clock.elapsed, 10, "the ceiling is absolute, however long characters keep arriving")
  }

  // Only forward movement is evidence the burst is still landing. A field the app clears
  // mid-flight would otherwise reset the stall clock on every poll and hold every wedged wait
  // open to the ceiling. Replacement mode, because that is where a non-matching value keeps
  // polling rather than settling as `.diverged`.
  func testCommitWaitTreatsARetreatingValueAsNoProgress() {
    let clock = CommitWaitClock()
    let observations = ["ada@", "", "ada@", "", "ada@"]
    var index = 0
    let outcome = Self.awaitSynthesizedReplacementCommitOutcome(
      expectedText: "ada@example",
      placeholder: nil,
      stallBudget: 3,
      ceiling: 10,
      now: clock.read,
      observe: { observations[min(index, observations.count - 1)] },
      waitForNextObservation: {
        index += 1
        clock.advance(1)
      }
    )
    XCTAssertEqual(outcome, .notObserved)
    XCTAssertEqual(clock.elapsed, 3, "churn between two values is not progress and must not buy time")
  }

  // The replacement route earns time the same way, and is bounded the same way — it is the route
  // `fill` takes when the XCTest channel is penalized, i.e. the one that runs on a loaded host.
  // Here every poll lands one more character of a value that never completes, so the wait can only
  // end at the ceiling: it proves the growing prefix carried it past the 3s stall budget (a flat
  // deadline stops at t=3) and that the ceiling still stops it.
  func testReplacementCommitWaitOutlivesTheFlatDeadlineThenStopsAtTheCeiling() {
    let expected = "ada@example.com"
    let clock = CommitWaitClock()
    var landed = 0
    let outcome = Self.awaitSynthesizedReplacementCommitOutcome(
      expectedText: expected,
      placeholder: nil,
      stallBudget: 3,
      ceiling: 10,
      now: clock.read,
      observe: { String(expected.prefix(landed)) },
      waitForNextObservation: {
        landed += 1
        clock.advance(2)
      }
    )
    XCTAssertEqual(outcome, .notObserved)
    XCTAssertEqual(clock.elapsed, 10, "progress must carry the wait past 3s, and the ceiling must end it")
    XCTAssertEqual(landed, 5, "one character per poll, five polls inside the ceiling")
  }
#endif
}
