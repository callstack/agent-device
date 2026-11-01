import XCTest
import Network

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  private static let transportToken = String(repeating: "k", count: 32)

  /// Serves through the production listener factory with a fixed token.
  private func startTransportListener() throws -> NWListener {
    listenerToken = RunnerListenerToken(Self.transportToken)
    let listener = try Self.makeRunnerListener(port: .any)
    let ready = expectation(description: "HTTP listener ready")
    listener.stateUpdateHandler = { state in
      if case .ready = state { ready.fulfill() }
    }
    listener.newConnectionHandler = { connection in
      self.handle(connection: connection)
    }
    listener.start(queue: transportQueue)
    wait(for: [ready], timeout: 2)
    return listener
  }

  func testUptimeHttpRemainsResponsiveWhileCommandQueueIsOccupied() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
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
    var status: Int?
    var authHeader: String?
    var error: Error?

    func response() throws -> Response {
      if let error { throw error }
      return try JSONDecoder().decode(Response.self, from: XCTUnwrap(data))
    }
  }

  private func transportHttpRequest(
    client: URLSession,
    port: NWEndpoint.Port,
    payload: String,
    token: String? = RunnerTests.transportToken
  ) -> TransportHttpReply {
    let reply = TransportHttpReply()
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port.rawValue)/command")!)
    request.httpMethod = "POST"
    request.httpBody = Data(payload.utf8)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token {
      request.setValue(token, forHTTPHeaderField: RunnerListenerToken.requestHeaderName)
    }
    client.dataTask(with: request) { data, response, error in
      reply.status = (response as? HTTPURLResponse)?.statusCode
      reply.authHeader = (response as? HTTPURLResponse)?.value(
        forHTTPHeaderField: Self.authEnforcedResponseHeader
      )
      reply.data = data
      reply.error = error
      reply.finished.fulfill()
    }.resume()
    return reply
  }

  private func transportHttpResponse(
    client: URLSession,
    port: NWEndpoint.Port,
    payload: String,
    token: String? = RunnerTests.transportToken
  ) throws -> Response {
    let reply = transportHttpRequest(client: client, port: port, payload: payload, token: token)
    wait(for: [reply.finished], timeout: 2)
    return try reply.response()
  }

  func testRunnerListenerBindsLoopbackOffDevice() throws {
    let listener = try Self.makeRunnerListener(port: .any)
    #if targetEnvironment(simulator) || os(macOS)
      guard case .hostPort(let host, _) = try XCTUnwrap(listener.parameters.requiredLocalEndpoint),
        case .ipv4(let address) = host
      else {
        return XCTFail("listener must require a loopback local endpoint")
      }
      XCTAssertTrue(address.isLoopback)
    #endif
  }

  func testListenerRefusesRequestsWithoutTheTokenBeforeDecoding() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let client = URLSession(configuration: .ephemeral)
    defer { client.invalidateAndCancel() }

    for token in [nil, "wrong"] as [String?] {
      let reply = transportHttpRequest(
        client: client,
        port: port,
        payload: #"{"command":"appState","commandId":"without-token"}"#,
        token: token
      )
      wait(for: [reply.finished], timeout: 2)
      XCTAssertEqual(reply.status, 401)
      XCTAssertEqual(reply.authHeader, "required")
      XCTAssertEqual(try reply.response().error?.code, "UNAUTHORIZED")
    }
    XCTAssertEqual(
      commandJournal.status(normalizedCommandId: "without-token").lifecycleState,
      RunnerCommandLifecycleState.notAccepted.rawValue
    )
  }

  func testListenerKeepsServingAfterRefusingABadlyFramedRequest() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let token = "\(RunnerListenerToken.requestHeaderName): \(Self.transportToken)"
    let tooLarge = RunnerHttpRequestFraming.maxBodyBytes + 1
    let refusals = [
      ("POST /command HTTP/1.1\r\n\(token)\r\nContent-Length: -5\r\n\r\n{}", 400),
      ("POST /command HTTP/1.1\r\n\(token)\r\nContent-Length: \(tooLarge)\r\n\r\n", 413),
      ("POST /command HTTP/1.1\r\nContent-Length: \(tooLarge)\r\n\r\n", 401),
    ]
    for (request, status) in refusals {
      XCTAssertEqual(try rawTransportStatus(port: port, request: request), status, request)
    }
    let client = URLSession(configuration: .ephemeral)
    defer { client.invalidateAndCancel() }
    let uptime = try transportHttpResponse(
      client: client,
      port: port,
      payload: #"{"command":"uptime"}"#
    )
    XCTAssertTrue(uptime.ok)
  }

  /// Sends raw bytes and returns the status the runner answered with.
  private func rawTransportStatus(port: NWEndpoint.Port, request: String) throws -> Int? {
    let socket = TransportSocket(port: port)
    defer { socket.connection.cancel() }
    try socket.send(request)
    let status = try socket.response().status
    try socket.expectEOF()
    return status
  }

  func testHttpConnectionServesSequentialRequestsAndCommandErrors() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let socket = try TransportSocket(port: XCTUnwrap(listener.port))
    defer { socket.connection.cancel() }
    for (payload, status) in [(#"{"command":"uptime"}"#, 200), ("not-json", 400), (#"{"command":"uptime"}"#, 200)] {
      try socket.send(rawCommand(payload))
      let response = try socket.response()
      XCTAssertEqual(response.status, status)
      XCTAssertTrue(response.head.contains("Connection: keep-alive"))
      XCTAssertTrue(response.head.contains("X-Agent-Device-Runner-Auth: required"))
      XCTAssertEqual(try response.envelope().ok, status == 200)
    }
  }

  func testHttpConnectionPreservesPipelinedRequestsAndResponseOrder() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let socket = try TransportSocket(port: XCTUnwrap(listener.port))
    defer { socket.connection.cancel() }
    let queued = rawCommand(#"{"command":"appState","commandId":"pipeline-first"}"#)
    let inline = rawCommand(#"{"command":"uptime"}"#)
    // The inline command must not overtake queued work, and a partial third head must survive.
    try socket.send(queued + inline + String(inline.prefix(13)))
    let first = try socket.response()
    XCTAssertEqual(first.status, 200)
    XCTAssertFalse(try first.envelope().ok)
    XCTAssertEqual(try first.envelope().error?.message, "appState requires appBundleId")
    let second = try socket.response()
    XCTAssertNotNil(try second.envelope().data?.currentUptimeMs)
    try socket.send(String(inline.dropFirst(13)))
    let third = try socket.response()
    XCTAssertEqual(third.status, 200)
    XCTAssertNotNil(try third.envelope().data?.currentUptimeMs)
  }

  func testHttpConnectionAuthenticatesEveryRequestAndClosesOnRefusal() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let socket = TransportSocket(port: port)
    defer { socket.connection.cancel() }
    try socket.send(rawCommand(#"{"command":"uptime"}"#))
    XCTAssertEqual(try socket.response().status, 200)
    try socket.send(
      rawCommand(#"{"command":"appState","commandId":"unauthorized-followup"}"#, token: "wrong")
        + rawCommand(#"{"command":"appState","commandId":"after-refusal"}"#)
    )
    let denied = try socket.response()
    XCTAssertEqual(denied.status, 401)
    XCTAssertEqual(try denied.envelope().error?.code, "UNAUTHORIZED")
    XCTAssertTrue(denied.head.contains("Connection: close"))
    try socket.expectEOF()
    for id in ["unauthorized-followup", "after-refusal"] {
      XCTAssertEqual(commandJournal.status(normalizedCommandId: id).lifecycleState, RunnerCommandLifecycleState.notAccepted.rawValue)
    }
    let other = TransportSocket(port: port)
    defer { other.connection.cancel() }
    try other.send(rawCommand(#"{"command":"uptime"}"#))
    XCTAssertEqual(try other.response().status, 200)
  }

  func testHttpConnectionRefusesMalformedFollowupBeforeReadingItsBody() throws {
    try withWarmTransportSocket { socket in
      try socket.send("POST /command HTTP/1.1\r\nX-Agent-Device-Runner-Token: \(Self.transportToken)\r\nContent-Length: 4\r\nContent-Length: 4\r\n\r\n")
      XCTAssertEqual(try socket.response().status, 411)
      try socket.expectEOF()
    }
  }

  func testHttpPartialFollowupGetsAnArrivalDeadline() throws {
    try withWarmTransportSocket { socket in
      let request = rawCommand(#"{"command":"uptime"}"#)
      try socket.send(String(request.dropLast(2)))
      let timedOut = try socket.response(timeout: Self.requestTimeout + 3)
      XCTAssertEqual(timedOut.status, 408)
      XCTAssertTrue(timedOut.head.contains("Connection: close"))
      try socket.expectEOF()
    }
  }

  private func withWarmTransportSocket(_ body: (TransportSocket) throws -> Void) throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let socket = try TransportSocket(port: XCTUnwrap(listener.port))
    defer { socket.connection.cancel() }
    try socket.send(rawCommand(#"{"command":"uptime"}"#))
    XCTAssertEqual(try socket.response().status, 200)
    try body(socket)
  }

  func testHttpConnectionClosesForHttp10AndExplicitClose() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    for (version, headers) in [("HTTP/1.0", ""), ("HTTP/1.1", "Connection: keep-alive\r\nConnection: CLOSE\r\n")] {
      let socket = try TransportSocket(port: XCTUnwrap(listener.port))
      defer { socket.connection.cancel() }
      try socket.send(rawCommand(#"{"command":"uptime"}"#, version: version, headers: headers)
        + rawCommand(#"{"command":"appState","commandId":"after-close"}"#))
      let response = try socket.response()
      XCTAssertEqual(response.status, 200)
      XCTAssertTrue(response.head.contains("Connection: close"))
      try socket.expectEOF()
      XCTAssertEqual(commandJournal.status(normalizedCommandId: "after-close").lifecycleState, RunnerCommandLifecycleState.notAccepted.rawValue)
    }
  }

  func testHttp10ConnectionReusesWhenExplicitlyRequested() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let socket = try TransportSocket(port: XCTUnwrap(listener.port))
    defer { socket.connection.cancel() }
    for _ in 0..<2 {
      try socket.send(rawCommand(#"{"command":"uptime"}"#, version: "HTTP/1.0", headers: "Connection: keep-alive\r\n"))
      XCTAssertEqual(try socket.response().status, 200)
    }
  }

  func testHttpShutdownClosesOtherConnectionsAndDropsPipelineTail() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let idle = TransportSocket(port: port)
    let shutdown = TransportSocket(port: port)
    defer { idle.connection.cancel(); shutdown.connection.cancel() }
    try idle.send(rawCommand(#"{"command":"uptime"}"#))
    XCTAssertEqual(try idle.response().status, 200)
    try shutdown.send(rawCommand(#"{"command":"shutdown"}"#)
      + rawCommand(#"{"command":"appState","commandId":"after-shutdown"}"#))
    let response = try shutdown.response()
    XCTAssertEqual(response.status, 200)
    XCTAssertTrue(response.head.contains("Connection: close"))
    try shutdown.expectEOF()
    try idle.expectEOF()
    XCTAssertEqual(commandJournal.status(normalizedCommandId: "after-shutdown").lifecycleState, RunnerCommandLifecycleState.notAccepted.rawValue)
  }

  func testCoalescedShutdownDeliversEveryResponseBeforeClosingTransport() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let sockets = (0..<32).map { _ in TransportSocket(port: port) }
    defer { sockets.forEach { $0.connection.cancel() } }

    let releaseCommand = DispatchSemaphore(value: 0)
    commandExecutionQueue.async { releaseCommand.wait() }
    defer { releaseCommand.signal() }
    for socket in sockets {
      try socket.send(rawCommand(#"{"command":"shutdown","commandId":"shared-shutdown"}"#))
    }
    let deadline = Date().addingTimeInterval(3)
    var waiterCount = 0
    repeat {
      inFlightCommandLock.lock()
      waiterCount = inFlightCommandWaiters["shared-shutdown"]?.count ?? 0
      inFlightCommandLock.unlock()
      if waiterCount == sockets.count - 1 { break }
      Thread.sleep(forTimeInterval: 0.01)
    } while Date() < deadline
    XCTAssertEqual(waiterCount, sockets.count - 1)
    releaseCommand.signal()

    for socket in sockets {
      let reply = try socket.response()
      XCTAssertEqual(reply.status, 200)
      XCTAssertTrue(try reply.envelope().ok)
      XCTAssertTrue(reply.head.contains("Connection: close"))
      try socket.expectEOF()
    }
  }

  func testHttpIdleExpiryPreservesUnusedLoopbackListenerWatch() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let watch = TransportSocket(port: port)
    let used = TransportSocket(port: port)
    defer { watch.connection.cancel(); used.connection.cancel() }
    try used.send(rawCommand(#"{"command":"uptime"}"#))
    XCTAssertEqual(try used.response().status, 200)
    try used.expectEOF(timeout: Self.connectionIdleTimeout + 3)
    try watch.send(rawCommand(#"{"command":"uptime"}"#))
    XCTAssertEqual(try watch.response().status, 200)
  }

  private func rawCommand(
    _ payload: String,
    token: String = RunnerTests.transportToken,
    version: String = "HTTP/1.1",
    headers: String = ""
  ) -> String {
    "POST /command \(version)\r\nX-Agent-Device-Runner-Token: \(token)\r\nContent-Length: \(payload.utf8.count)\r\n\(headers)\r\n\(payload)"
  }

  private final class TransportSocket: @unchecked Sendable {
    let connection: NWConnection
    var buffer = Data()
    var ended = false
    var error: Error?

    init(port: NWEndpoint.Port) {
      connection = NWConnection(host: .ipv4(.loopback), port: port, using: .tcp)
      connection.start(queue: DispatchQueue(label: "agent-device.test.http-client"))
    }

    func send(_ text: String) throws {
      let sent = XCTestExpectation(description: "raw request sent")
      connection.send(content: Data(text.utf8), completion: .contentProcessed { error in
        self.error = error
        sent.fulfill()
      })
      guard XCTWaiter.wait(for: [sent], timeout: 3) == .completed else { throw SocketError.timedOut }
      if let error { throw error }
    }

    struct Reply {
      let head: String
      let body: Data
      var status: Int? { Int(head.split(separator: " ")[1]) }
      func envelope() throws -> Response { try JSONDecoder().decode(Response.self, from: body) }
    }

    enum SocketError: Error { case timedOut, prematureEOF, missingLength }

    func response(timeout: TimeInterval = 3) throws -> Reply {
      while true {
        if let split = buffer.range(of: Data("\r\n\r\n".utf8)) {
          let head = String(decoding: buffer[..<split.lowerBound], as: UTF8.self)
          let lengthLine = head.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("content-length:") }
          guard let lengthLine, let length = Int(lengthLine.dropFirst("Content-Length:".count).trimmingCharacters(in: .whitespaces)) else {
            throw SocketError.missingLength
          }
          let end = split.upperBound + length
          if buffer.count >= end {
            let body = Data(buffer[split.upperBound..<end])
            buffer = Data(buffer.suffix(from: end))
            return Reply(head: head, body: body)
          }
        }
        if ended { throw SocketError.prematureEOF }
        try read(timeout: timeout)
      }
    }

    func expectEOF(timeout: TimeInterval = 3) throws {
      XCTAssertTrue(buffer.isEmpty, "unexpected response after close")
      if !ended { try read(timeout: timeout) }
      XCTAssertTrue(ended, "connection must close")
      XCTAssertTrue(buffer.isEmpty, "unexpected bytes after close")
    }

    private func read(timeout: TimeInterval) throws {
      let received = XCTestExpectation(description: "raw response bytes")
      connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, done, error in
        if let data { self.buffer.append(data) }
        self.ended = done
        self.error = error
        received.fulfill()
      }
      guard XCTWaiter.wait(for: [received], timeout: timeout) == .completed else { throw SocketError.timedOut }
      if let error { throw error }
    }
  }

  func testDuplicateCommandIdCoalescesOntoInFlightExecution() throws {
    // `scroll` keeps its response body in the journal, so the test can tell a replayed outcome from the
    // typed refusal a bodyless command's repeat gets.
    let command = try JSONDecoder().decode(
      Command.self,
      from: Data(#"{"command":"scroll","commandId":"scroll-coalesce"}"#.utf8)
    )
    final class Delivered {
      var primaryData: RunnerHttpResponse?
      var waiterData: RunnerHttpResponse?
      var lateJoinerData: RunnerHttpResponse?
    }
    let delivered = Delivered()
    defer { inFlightCommandWaiters.removeAll() }

    // The execute path hands the sending connection's completion to the execution's own delivery; the
    // join path registers its completion as a waiter of that execution.
    guard case .execute = commandJournal.accept(command: command) else {
      return XCTFail("the first send of a commandId must be admitted for execution")
    }
    guard case .join = commandJournal.accept(command: command) else {
      return XCTFail("a send of a commandId whose execution has not finished must join it")
    }
    attachToInFlightExecution(command: command) { result in
      delivered.waiterData = result.response
    }

    commandJournal.start(command: command)
    commandJournal.markDispatched(command: command)
    commandJournal.finish(
      command: command,
      response: Response(ok: true, data: DataPayload(message: "captured"))
    )
    let result = RunnerHttpResponse(status: 200, body: "single-result")
    deliverCommandResult(command: command, result: (result, false)) { result in
      delivered.primaryData = result.response
    }

    XCTAssertEqual(delivered.primaryData, result)
    XCTAssertEqual(delivered.waiterData, result)
    XCTAssertNil(inFlightCommandWaiters["snapshot-coalesce"])

    // The execution has answered and closed. A send that arrives now is the finished command's repeat,
    // and it must be answered from the journal instead of waiting for a delivery that already went out.
    guard case .terminal(let outcome) = commandJournal.accept(command: command) else {
      return XCTFail("a send of a finished commandId must be answered from the journal")
    }
    XCTAssertTrue(outcome.ok)
    XCTAssertEqual(outcome.data?.message, "captured")

    let lateCommand = try JSONDecoder().decode(
      Command.self,
      from: Data(#"{"command":"snapshot","commandId":"snapshot-late-join"}"#.utf8)
    )
    commandJournal.accept(command: lateCommand)
    commandJournal.markDispatched(command: lateCommand)
    commandJournal.finish(
      command: lateCommand,
      response: Response(ok: true, data: DataPayload(message: "captured late"))
    )
    attachToInFlightExecution(command: lateCommand) { result in
      delivered.lateJoinerData = result.response
    }
    XCTAssertNotNil(delivered.lateJoinerData, "a join after the answer was recorded must still be answered")
    XCTAssertNil(inFlightCommandWaiters["snapshot-late-join"], "a journal answer must not register a waiter")
  }

  /// The bug this repo cannot survive: a repeat of a `commandId` whose command already finished used to
  /// be admitted again and drive the device a second time — a second tap. Sends go through the real
  /// listener here, because admission is the transport's route, not any helper's.
  ///
  /// `recordStop` makes the second execution observable without recording anything: with no active
  /// recording it answers "recording already stopped", so a re-execution would be seen as the recorder
  /// the test installed being consumed instead of the recorded answer being replayed.
  func testTransportNeverRepeatsAFinishedCommandsExecution() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let client = URLSession(configuration: .ephemeral)
    defer { client.invalidateAndCancel() }
    let payload = #"{"command":"recordStop","commandId":"record-stop-twice"}"#

    activeRecording = nil
    let first = try transportHttpResponse(client: client, port: port, payload: payload)
    XCTAssertTrue(first.ok, String(describing: first.error))
    XCTAssertEqual(first.data?.message, "recording already stopped")

    // Prove nothing ran the second time: had it run, this recorder would be stopped and cleared.
    let installed = ScreenRecorder(outputPath: "", fps: 30)
    activeRecording = installed
    defer { activeRecording = nil }

    let repeatSend = try transportHttpResponse(client: client, port: port, payload: payload)

    XCTAssertIdentical(activeRecording, installed, "a finished commandId must not execute again")
    XCTAssertEqual(repeatSend.ok, true)
    XCTAssertEqual(
      repeatSend.data?.message,
      "recording already stopped",
      "the repeat must be answered with the outcome the runner recorded, got \(String(describing: repeatSend.data?.message))"
    )
    XCTAssertEqual(
      commandJournal.status(normalizedCommandId: "record-stop-twice").lifecycleState,
      RunnerCommandLifecycleState.completed.rawValue
    )
  }

  /// Routes `command` the way the transport routes it: an inline read, then the journal's verdict on its
  /// `commandId`. A finished id comes back as the answer the runner recorded for it; the execute path
  /// rethrows what the dispatch threw, which the wire path turns into its own response. Sends that need
  /// the wire path itself, including coalescing and admission end to end, go through
  /// `startTransportListener` instead.
  func execute(command: Command) throws -> Response {
    dispatchPrecondition(condition: .onQueue(.main))
    if let response = inlineResponse(for: command) {
      return response
    }
    switch commandJournal.accept(command: command) {
    case .terminal(let outcome):
      return outcome
    case .join:
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.commandReturnedNoResponse,
        userInfo: [
          NSLocalizedDescriptionKey:
            "this seam does not coalesce onto an in-flight execution; send through the transport listener"
        ]
      )
    case .execute:
      break
    }
    final class ResultBox {
      var result: Result<Response, Error>?
    }
    let box = ResultBox()
    let executed = XCTestExpectation(description: "\(command.command.rawValue) executed off main")
    enqueueAdmittedExecution(command: command) { result in
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
