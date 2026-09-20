import XCTest

@testable import AgentDeviceMacOSInput

final class MouseClickScheduleTests: XCTestCase {
  // The original schedule posted move, down and up back to back. AppKit and SwiftUI
  // never delivered the release, so every surface press opened a tracking session that
  // no control ever completed: 0 of 15 measured clicks activated their control.
  func testEveryReleaseIsHeldApartFromItsPress() {
    for holdMs in [0, 5, 40, 60, 800] {
      let steps = mouseClickSteps(holdMs: holdMs, clicks: 1, intervalMs: 120)
      let press = steps.firstIndex(where: { $0.kind == .down })
      let release = steps.firstIndex(where: { $0.kind == .up })
      guard let pressIndex = press, let releaseIndex = release,
            releaseIndex == pressIndex + 1
      else {
        XCTFail("hold \(holdMs)ms did not pair a press with the release that follows it: \(steps)")
        continue
      }
      XCTAssertGreaterThanOrEqual(
        steps[releaseIndex].delayBeforeMs,
        minimumMouseClickHoldMs,
        "hold \(holdMs)ms released inside the window where the release is dropped"
      )
    }
  }

  func testHoldShorterThanTheDeliverableFloorIsRaised() {
    XCTAssertEqual(mouseClickHoldMs(requestedMs: 0), defaultMouseClickHoldMs)
    XCTAssertEqual(mouseClickHoldMs(requestedMs: 1), minimumMouseClickHoldMs)
    XCTAssertEqual(mouseClickHoldMs(requestedMs: 39), minimumMouseClickHoldMs)
  }

  func testNamedLongPressHoldIsKept() {
    XCTAssertEqual(mouseClickHoldMs(requestedMs: 800), 800)
    let steps = mouseClickSteps(holdMs: 800, clicks: 1, intervalMs: 120)
    XCTAssertEqual(steps.last?.delayBeforeMs, 800)
  }

  func testRepeatClicksSeparatePressesAndKeepOneCursorMotion() {
    let steps = mouseClickSteps(holdMs: 0, clicks: 3, intervalMs: 150)
    XCTAssertEqual(steps.filter { $0.kind == .move }.count, 1)
    XCTAssertEqual(steps.filter { $0.kind == .down }.count, 3)
    XCTAssertEqual(steps.filter { $0.kind == .up }.count, 3)
    XCTAssertEqual(steps.first?.delayBeforeMs, 0)

    let downs = steps.enumerated().filter { $0.element.kind == .down }.map { $0.offset }
    XCTAssertEqual(downs.first.map { steps[$0].delayBeforeMs }, 0)
    for index in downs.dropFirst() {
      XCTAssertEqual(steps[index].delayBeforeMs, 150)
    }
  }

  func testCursorParksBeforeThePressAndNeverAfterTheRelease() {
    let steps = mouseClickSteps(holdMs: 0, clicks: 2, intervalMs: 100)
    XCTAssertEqual(steps.first?.kind, .move)
    XCTAssertEqual(steps.last?.kind, .up)
  }
}
