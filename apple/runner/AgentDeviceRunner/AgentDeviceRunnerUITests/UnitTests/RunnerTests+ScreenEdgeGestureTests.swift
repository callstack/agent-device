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

  func testTouchscreenWithoutATransportIsTheDisplaysOnlyCandidate() {
    // Reported on iOS 18.1 and 26.5 simulators: the touchscreen service reads no Transport.
    let selection = touchscreenSelection([touchscreen(registryID: 7, transport: nil)])

    XCTAssertNil(selection.failure)
    XCTAssertEqual(selection.sender, 7)
  }

  func testCoreDeviceTouchscreenWinsOverAServiceWithoutTransport() {
    let selection = touchscreenSelection([
      touchscreen(registryID: 3, transport: nil),
      touchscreen(registryID: 9, transport: "CoreDevice"),
    ])

    XCTAssertNil(selection.failure)
    XCTAssertEqual(selection.sender, 9)
  }

  func testOldestCoreDeviceTouchscreenWinsWhenAWindowAddsAnother() {
    let selection = touchscreenSelection([
      touchscreen(registryID: 20, transport: "CoreDevice"),
      touchscreen(registryID: 10, transport: "CoreDevice"),
    ])

    XCTAssertNil(selection.failure)
    XCTAssertEqual(selection.sender, 10)
  }

  func testTouchscreensWithoutCoreDeviceAreAmbiguousWhenThereAreSeveral() {
    let selection = touchscreenSelection([
      touchscreen(registryID: 3, transport: nil),
      touchscreen(registryID: 4, transport: 42 as NSNumber),
    ])

    XCTAssertEqual(selection.sender, 0)
    let failure = selection.failure ?? ""
    XCTAssertTrue(failure.contains("2 touchscreen HID services without a CoreDevice transport"), failure)
    XCTAssertTrue(failure.contains("missing: 1"), failure)
    XCTAssertTrue(failure.contains("other type: 1"), failure)
  }

  func testNoCandidateNamesTheConditionThatRejectedTheTouchscreens() {
    let otherDisplay = touchscreenSelection([touchscreen(registryID: 5, transport: "CoreDevice", displayUUID: "D2")])
    let unreadableID = touchscreenSelection([touchscreen(registryID: "5" as NSString, transport: "CoreDevice")])

    XCTAssertTrue(otherDisplay.failure?.contains("1 touchscreen service, 0 on this display") == true, otherDisplay.failure ?? "nil")
    XCTAssertTrue(unreadableID.failure?.contains("1 on this display, 0 with a readable registry ID") == true, unreadableID.failure ?? "nil")
  }

  private func touchscreen(registryID: Any, transport: Any?, displayUUID: String = "D1") -> [String: Any] {
    var service: [String: Any] = [
      "PrimaryUsagePage": 13,
      "PrimaryUsage": 4,
      "displayUUID": displayUUID,
      "registryID": registryID,
    ]
    if let transport { service["Transport"] = transport }
    return service
  }

  private func touchscreenSelection(_ services: [[String: Any]]) -> (failure: String?, sender: UInt64) {
    var sender: UInt64 = 0
    let failure = RunnerTouchscreenSelection(services, "D1", &sender)
    return (failure, sender)
  }
}
#endif
