import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS) && targetEnvironment(simulator)
private let cancelBit: UInt32 = 1 << 7

extension RunnerTests {
  func testEdgeContactLiftsWithoutUsingTheReservedCancel() {
    var failure: NSString?
    let events = RunnerEdgeContactDispatches(-1, &failure)

    XCTAssertNil(failure)
    XCTAssertEqual(events.count, 5, "touch-down, three moves, touch-up")
    XCTAssertEqual(events.map { $0["touching"]?.boolValue }, [true, true, true, true, false])
    XCTAssertFalse(events.contains { ($0["mask"]?.uint32Value ?? 0) & cancelBit != 0 })
  }

  func testEdgeContactDispatchesNothingWhenItCannotReserveItsEnd() {
    for failingFrame in [0, 1] {
      var failure: NSString?
      let events = RunnerEdgeContactDispatches(failingFrame, &failure)

      XCTAssertNotNil(failure, "frame \(failingFrame)")
      XCTAssertTrue(events.isEmpty, "frame \(failingFrame): nothing goes down without its terminal event")
    }
  }

  func testEdgeContactCancelsWhenAMoveOrTheLiftCannotBeBuilt() {
    for (failingFrame, movesBeforeCancel) in [(2, 0), (3, 1), (5, 3)] {
      var failure: NSString?
      let events = RunnerEdgeContactDispatches(failingFrame, &failure)
      let terminal = events.last

      XCTAssertNotNil(failure, "frame \(failingFrame)")
      XCTAssertEqual(events.count, 2 + movesBeforeCancel, "frame \(failingFrame): down, moves, cancel")
      XCTAssertEqual(
        events.dropLast().map { $0["touching"]?.boolValue },
        Array(repeating: true, count: 1 + movesBeforeCancel),
        "frame \(failingFrame): touch-down and every move before the cancel touched"
      )
      XCTAssertEqual(terminal?["touching"]?.boolValue, false, "frame \(failingFrame)")
      XCTAssertNotEqual((terminal?["mask"]?.uint32Value ?? 0) & cancelBit, 0, "frame \(failingFrame)")
      XCTAssertEqual(terminal?["restamped"]?.boolValue, true, "frame \(failingFrame): stamped at dispatch")
    }
  }
}
#endif
