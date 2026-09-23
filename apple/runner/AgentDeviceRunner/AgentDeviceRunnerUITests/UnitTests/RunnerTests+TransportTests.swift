import XCTest
import Network

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testDuplicateCommandIdCoalescesOntoInFlightExecution() throws {
    let command = try JSONDecoder().decode(
      Command.self,
      from: Data(#"{"command":"snapshot","commandId":"snapshot-coalesce"}"#.utf8)
    )
    var primaryData: Data?
    var waiterData: Data?
    defer {
      inFlightCommandIds.removeAll()
      inFlightCommandWaiters.removeAll()
    }

    XCTAssertFalse(
      attachToInFlightCommandIfNeeded(command: command) { result in
        primaryData = result.data
      }
    )
    XCTAssertTrue(
      attachToInFlightCommandIfNeeded(command: command) { result in
        waiterData = result.data
      }
    )

    let delivered = Data("single-result".utf8)
    deliverCommandResult(
      command: command,
      result: (delivered, false)
    ) { result in
      primaryData = result.data
    }

    XCTAssertEqual(primaryData, delivered)
    XCTAssertEqual(waiterData, delivered)
    XCTAssertFalse(inFlightCommandIds.contains("snapshot-coalesce"))
    XCTAssertNil(inFlightCommandWaiters["snapshot-coalesce"])
  }
}
#endif
