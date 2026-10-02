import XCTest
import Network

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testUptimeHttpRemainsResponsiveWhileCommandQueueIsOccupied() throws {
    let listener = try NWListener(using: .tcp, on: .any)
    let ready = expectation(description: "HTTP listener ready")
    listener.stateUpdateHandler = { state in
      if case .ready = state { ready.fulfill() }
    }
    listener.newConnectionHandler = { connection in
      connection.start(queue: self.transportQueue)
      self.handle(connection: connection)
    }
    listener.start(queue: transportQueue)
    defer { listener.cancel() }
    wait(for: [ready], timeout: 2)
    let port = try XCTUnwrap(listener.port)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 3
    configuration.timeoutIntervalForResource = 3
    let client = URLSession(configuration: configuration)
    defer { client.invalidateAndCancel() }

    let occupied = expectation(description: "command queue occupied")
    let drained = DispatchSemaphore(value: 0)
    let releaseWork = DispatchSemaphore(value: 0)
    commandExecutionQueue.async {
      occupied.fulfill()
      releaseWork.wait()
      drained.signal()
    }
    defer {
      releaseWork.signal()
      XCTAssertEqual(drained.wait(timeout: .now() + 2), .success)
    }
    wait(for: [occupied], timeout: 2)

    let started = ProcessInfo.processInfo.systemUptime
    let uptime = try transportHttpResponse(
      client: client,
      port: port,
      payload: #"{"command":"uptime","commandId":"occupied-preflight"}"#
    )
    let elapsed = ProcessInfo.processInfo.systemUptime - started
    XCTAssertTrue(uptime.ok)
    XCTAssertNotNil(uptime.data?.currentUptimeMs)
    XCTAssertLessThan(elapsed, 1)
    XCTAssertEqual(
      commandJournal.status(normalizedCommandId: "occupied-preflight").lifecycleState,
      RunnerCommandLifecycleState.notAccepted.rawValue
    )

    let queued = transportHttpRequest(
      client: client,
      port: port,
      payload: #"{"command":"appState","commandId":"after-preflight"}"#
    )
    let acceptedDeadline = Date().addingTimeInterval(1)
    var state: String?
    repeat {
      state = try transportHttpResponse(
        client: client,
        port: port,
        payload: #"{"command":"status","statusCommandId":"after-preflight"}"#
      ).data?.lifecycleState
    } while state == RunnerCommandLifecycleState.notAccepted.rawValue && Date() < acceptedDeadline
    XCTAssertEqual(state, RunnerCommandLifecycleState.accepted.rawValue)
    releaseWork.signal()
    wait(for: [queued.finished], timeout: 2)
    let response = try queued.response()
    XCTAssertEqual(response.error?.message, "appState requires appBundleId")
    XCTAssertEqual(
      commandJournal.status(normalizedCommandId: "after-preflight").lifecycleState,
      RunnerCommandLifecycleState.failed.rawValue
    )
    NSLog("AGENT_DEVICE_RUNNER_OCCUPIED_UPTIME_MS=%.1f", elapsed * 1000)
  }

  private final class TransportHttpReply {
    let finished = XCTestExpectation(description: "HTTP response received")
    var data: Data?
    var error: Error?

    func response() throws -> Response {
      if let error { throw error }
      return try JSONDecoder().decode(Response.self, from: XCTUnwrap(data))
    }
  }

  private func transportHttpRequest(
    client: URLSession,
    port: NWEndpoint.Port,
    payload: String
  ) -> TransportHttpReply {
    let reply = TransportHttpReply()
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port.rawValue)/command")!)
    request.httpMethod = "POST"
    request.httpBody = Data(payload.utf8)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    client.dataTask(with: request) { data, _, error in
      reply.data = data
      reply.error = error
      reply.finished.fulfill()
    }.resume()
    return reply
  }

  private func transportHttpResponse(
    client: URLSession,
    port: NWEndpoint.Port,
    payload: String
  ) throws -> Response {
    let reply = transportHttpRequest(client: client, port: port, payload: payload)
    wait(for: [reply.finished], timeout: 2)
    return try reply.response()
  }

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
