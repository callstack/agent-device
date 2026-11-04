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
    XCTAssertEqual(
      selection.description,
      "registryID=7 Transport=<missing> Product=<missing> Built-In=<missing> displayUUID=D1"
    )
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

  func testSeveralTouchscreensWithoutATransportAreAmbiguous() {
    let selection = touchscreenSelection([
      touchscreen(registryID: 3, transport: nil),
      touchscreen(registryID: 4, transport: nil),
    ])

    XCTAssertEqual(selection.sender, 0)
    XCTAssertEqual(
      selection.failure,
      "display 1 has 2 touchscreen HID services without a Transport, so an edge touch cannot choose one"
    )
  }

  func testAnUnrecognizedTransportIsNeverChosenWithoutACoreDeviceTouchscreen() {
    let otherType = touchscreenSelection([touchscreen(registryID: 4, transport: 42 as NSNumber)])
    let otherValue = touchscreenSelection([touchscreen(registryID: 4, transport: "USB")])
    let besideAMissingOne = touchscreenSelection([
      touchscreen(registryID: 3, transport: nil),
      touchscreen(registryID: 4, transport: "USB"),
    ])

    for (selection, counts) in [
      (otherType, "other type: 1, other value: 0"),
      (otherValue, "other type: 0, other value: 1"),
      (besideAMissingOne, "other type: 0, other value: 1"),
    ] {
      XCTAssertEqual(selection.sender, 0, counts)
      XCTAssertTrue(
        selection.failure?.contains("unrecognized Transport (\(counts))") == true,
        selection.failure ?? "nil"
      )
    }
  }

  func testCoreDeviceTouchscreenWinsBesideAnUnrecognizedTransport() {
    let selection = touchscreenSelection([
      touchscreen(registryID: 4, transport: "USB"),
      touchscreen(registryID: 9, transport: "CoreDevice"),
    ])

    XCTAssertNil(selection.failure)
    XCTAssertEqual(selection.sender, 9)
    XCTAssertTrue(selection.description?.hasPrefix("registryID=9 Transport=CoreDevice") == true)
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

  private func touchscreenSelection(
    _ services: [[String: Any]]
  ) -> (failure: String?, sender: UInt64, description: String?) {
    var sender: UInt64 = 0
    var description: NSString?
    let failure = RunnerTouchscreenSelection(services, "D1", &sender, &description)
    return (failure, sender, description as String?)
  }
}
#endif
