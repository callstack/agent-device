import XCTest

@testable import AgentDeviceMacOSInput

final class MouseClickScheduleTests: XCTestCase {
  // The original schedule posted move, down and up back to back. AppKit and SwiftUI
  // never delivered the release, so every surface press opened a tracking session that
  // no control ever completed: 0 of 15 measured clicks activated their control.
  func testHoldShorterThanTheDeliverableFloorIsRaised() {
    XCTAssertEqual(mouseClickHoldMs(requestedMs: 0), defaultMouseClickHoldMs)
    XCTAssertEqual(mouseClickHoldMs(requestedMs: 1), minimumMouseClickHoldMs)
    XCTAssertEqual(mouseClickHoldMs(requestedMs: 39), minimumMouseClickHoldMs)
    XCTAssertGreaterThan(defaultMouseClickHoldMs, minimumMouseClickHoldMs)
  }

  func testNamedLongPressHoldIsKept() {
    XCTAssertEqual(mouseClickHoldMs(requestedMs: 800), 800)
  }

  // `--count N` means N independent presses on every platform; a rising click state would
  // turn `--count 2` into a double-click and `--count 3` into a triple-click.
  func testRepeatClicksAreIndependentPressesAtClickStateOne() {
    let presses = mouseClickPresses(clicks: 3, doubleClick: false, intervalMs: 150)
    XCTAssertEqual(presses.map(\.clickState), [1, 1, 1])
    XCTAssertEqual(presses.map(\.delayBeforeMs), [0, 150, 150])
  }

  // Only `--double-tap` raises the click state, and it does so per press, so it composes
  // with `--count` into that many double-clicks rather than one triple-click.
  func testDoubleClickRaisesTheStateInsideEachPress() {
    XCTAssertEqual(
      mouseClickPresses(clicks: 1, doubleClick: true, intervalMs: 120).map(\.clickState),
      [1, 2]
    )
    let three = mouseClickPresses(clicks: 3, doubleClick: true, intervalMs: 500)
    XCTAssertEqual(three.map(\.clickState), [1, 2, 1, 2, 1, 2])
    XCTAssertEqual(
      three.map(\.delayBeforeMs),
      [0, mouseClickPairGapMs, 500, mouseClickPairGapMs, 500, mouseClickPairGapMs]
    )
    XCTAssertLessThan(mouseClickPairGapMs, 500, "a pair must land inside the system double-click interval")
  }

  func testZeroClicksStillPostsOnePress() {
    XCTAssertEqual(mouseClickPresses(clicks: 0, doubleClick: false, intervalMs: 0).count, 1)
  }

  // The process timeout the caller sets is derived from this: a schedule the timeout does
  // not cover is killed mid-hold.
  func testScheduleDurationSumsEveryHoldAndGap() {
    XCTAssertEqual(mouseClickScheduleMs(holdMs: 0, clicks: 1, doubleClick: false, intervalMs: 120), defaultMouseClickHoldMs)
    XCTAssertEqual(mouseClickScheduleMs(holdMs: 10_000, clicks: 4, doubleClick: false, intervalMs: 120), 4 * 10_000 + 3 * 120)
    XCTAssertEqual(
      mouseClickScheduleMs(holdMs: 60, clicks: 2, doubleClick: true, intervalMs: 100),
      4 * 60 + 2 * mouseClickPairGapMs + 100
    )
  }
}
