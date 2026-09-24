import XCTest
import Network

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testDuplicateCommandIdCoalescesOntoInFlightExecution() throws {
    let command = try JSONDecoder().decode(
      Command.self,
      from: Data(#"{"command":"snapshot","commandId":"snapshot-coalesce"}"#.utf8)
    )
    final class Delivered {
      var primaryData: Data?
      var waiterData: Data?
    }
    let delivered = Delivered()
    defer {
      inFlightCommandIds.removeAll()
      inFlightCommandWaiters.removeAll()
    }

    XCTAssertFalse(
      attachToInFlightCommandIfNeeded(command: command) { result in
        delivered.primaryData = result.data
      }
    )
    XCTAssertTrue(
      attachToInFlightCommandIfNeeded(command: command) { result in
        delivered.waiterData = result.data
      }
    )

    let result = Data("single-result".utf8)
    deliverCommandResult(
      command: command,
      result: (result, false)
    ) { result in
      delivered.primaryData = result.data
    }

    XCTAssertEqual(delivered.primaryData, result)
    XCTAssertEqual(delivered.waiterData, result)
    XCTAssertFalse(inFlightCommandIds.contains("snapshot-coalesce"))
    XCTAssertNil(inFlightCommandWaiters["snapshot-coalesce"])
  }

  /// Routes `command` through the transport's inline and queued paths. The calling test's main
  /// thread serves the command's main-thread work while it waits.
  func execute(command: Command) throws -> Response {
    dispatchPrecondition(condition: .onQueue(.main))
    if let response = inlineResponse(for: command) {
      return response
    }
    final class ResultBox {
      var result: Result<Response, Error>?
    }
    let box = ResultBox()
    let executed = XCTestExpectation(description: "\(command.command.rawValue) executed off main")
    enqueueAccepted(command: command) { result in
      box.result = result
      executed.fulfill()
    }
    guard XCTWaiter.wait(for: [executed], timeout: Self.mainThreadExecutionTimeout + 5) == .completed,
      let result = box.result
    else {
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.commandReturnedNoResponse,
        userInfo: [NSLocalizedDescriptionKey: "command did not finish on the command queue"]
      )
    }
    return try result.get()
  }
}
#endif
