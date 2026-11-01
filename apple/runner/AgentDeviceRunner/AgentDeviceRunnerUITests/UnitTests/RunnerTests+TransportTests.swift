import XCTest
import Network
#if os(iOS)
import UIKit
#endif

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
      waiterCount = inFlightCommandWaiters.values.reduce(0) { $0 + $1.count }
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

  /// Routes one `commandId` the way the transport does: an executing send, a second send the journal
  /// settles onto that execution, and the close with its delivery. `outcome` decides whether the execution
  /// finished or failed. Returns the bytes that delivery carried, which is what both sends must be answered
  /// with.
  @discardableResult
  private func runExecutionWithJoiner(
    _ command: Command,
    into delivered: TransportJoiner,
    outcome: Response?
  ) -> RunnerHttpResponse {
    let executed = commandJournal.accept(command: command)
    var executionToken = -1
    let joined = commandJournal.accept(command: command) { [weak self] token in
      executionToken = token
      self?.registerJoiner(for: token) { result in
        delivered.joinerData = result.response
      }
    }
    guard case .execute(let claimedToken) = executed else {
      XCTFail("the first send of a commandId must be admitted for execution")
      return Data()
    }
    guard case .join(let joinedToken) = joined else {
      XCTFail("a send of a commandId whose execution has not finished must join it")
      return Data()
    }
    XCTAssertEqual(
      joinedToken,
      executionToken,
      "the joiner is registered for the execution the verdict names"
    )
    XCTAssertEqual(claimedToken, joinedToken, "both sends speak of one execution")

    commandJournal.start(command: command)
    commandJournal.markDispatched(command: command)
    if let outcome {
      commandJournal.finish(command: command, response: outcome)
    } else {
      commandJournal.fail(command: command, error: NSError(domain: "test", code: 7, userInfo: nil))
    }
    let deliveredBytes = RunnerHttpResponse(status: 200, body: "one-delivery")
    deliverCommandResult(executionToken: claimedToken, result: (deliveredBytes, false)) { result in
      delivered.primaryData = result.response
    }
    return deliveredBytes
  }

  func testDuplicateCommandIdCoalescesOntoInFlightExecution() throws {
    // `scroll` keeps its response body in the journal, so the test can tell a replayed outcome from the
    // typed refusal a bodyless command's repeat gets.
    let command = try transportCommand("scroll", id: "scroll-coalesce")
    let delivered = TransportJoiner()
    defer { inFlightCommandWaiters.removeAll() }

    let delivery = runExecutionWithJoiner(
      command,
      into: delivered,
      outcome: Response(ok: true, data: DataPayload(message: "captured"))
    )

    XCTAssertEqual(delivered.primaryData, delivery)
    XCTAssertEqual(delivered.joinerData, delivery)
    assertNoJoinersLeft("the close must drain every send that joined it")

    // The execution has answered and closed. A send that arrives now is the finished command's repeat, and
    // the journal settles it with the recorded outcome instead of registering it onto a delivery that
    // already went out.
    var registeredLateSend = false
    let lateVerdict = commandJournal.accept(command: command) { _ in
      registeredLateSend = true
    }
    guard case .terminal(let outcome, _) = lateVerdict else {
      return XCTFail("a send of a finished commandId must be answered from the journal")
    }
    XCTAssertFalse(registeredLateSend, "a send answered from the journal must not be registered")
    XCTAssertTrue(outcome.ok)
    XCTAssertEqual(outcome.data?.message, "captured")
    assertNoJoinersLeft("a journal answer must not register a waiter")
  }

  /// The interleaving that used to leave a connection unanswered: the verdict said join, and the execution
  /// closed and drained before the send was registered, so nothing was left to answer it — and pruning had
  /// already hidden the outcome a late check would have read. Settling and registering are one operation
  /// now, so the send is registered before the transition that closes the entry can run.
  func testJournalAnswersAJoinerWhenTheCloseThatAnswersItAlsoPrunesTheEntry() throws {
    // A window full of open commands makes the close that ends this command also prune it: the case where
    // a send that registered afterwards used to find no entry and no delivery left.
    let command = try transportCommand("scroll", id: "scroll-join-pruned")
    let delivered = TransportJoiner()
    defer { inFlightCommandWaiters.removeAll() }
    try openCommandsFillingTheJournalWindow(64)

    let delivery = runExecutionWithJoiner(
      command,
      into: delivered,
      outcome: Response(ok: true, data: DataPayload(message: "captured"))
    )
    assertJournalWindowDropped("scroll-join-pruned")

    XCTAssertEqual(delivery, delivered.joinerData, "the close that pruned the entry must answer its joiner")
    assertNoJoinersLeft("answering must not leave a waiter behind")
  }

  /// A command that fails closes the entry through the same transition, so its joiner is owed the same
  /// answer.
  func testJournalAnswersAJoinerWhenTheExecutionFails() throws {
    let command = try transportCommand("scroll", id: "scroll-join-failed")
    let delivered = TransportJoiner()
    defer { inFlightCommandWaiters.removeAll() }

    let delivery = runExecutionWithJoiner(command, into: delivered, outcome: nil)

    XCTAssertEqual(delivery, delivered.joinerData, "the failure that closed the entry must answer its joiner")
    assertNoJoinersLeft("a failed close must drain its joiner too")
  }

  /// A `commandId` the runner refused before dispatch is claimed again, and the delivery of that refusal
  /// must not answer the sends of the execution that followed it. The journal mints one identity per
  /// claim and the transport keys its joiners by it, so the two generations cannot cross.
  func testDeliveryOfARefusalNeverAnswersTheJoinersOfTheExecutionAfterIt() throws {
    let command = try transportCommand("scroll", id: "scroll-refused-then-rerun")
    defer { inFlightCommandWaiters.removeAll() }

    // Generation one: claimed, refused before dispatch, and its entry closed with `dispatched == false`.
    guard case .execute(let firstToken) = commandJournal.accept(command: command) else {
      return XCTFail("the first send must be admitted")
    }
    commandJournal.start(command: command)
    commandJournal.finish(command: command, response: Response(ok: false, data: nil))

    // Generation two: the same id, admitted again because the refusal left no effect to protect. A send
    // joins this execution while it runs.
    guard case .execute(let secondToken) = commandJournal.accept(command: command) else {
      return XCTFail("a commandId refused before dispatch must be claimable again")
    }
    XCTAssertNotEqual(firstToken, secondToken, "each claim gets its own identity")
    let second = TransportJoiner()
    let joinVerdict = commandJournal.accept(command: command) { [weak self] token in
      self?.registerJoiner(for: token) { result in
        second.joinerData = result.response
      }
    }
    guard case .join = joinVerdict else {
      return XCTFail("a send of the running execution's id must join it")
    }

    // The refused generation delivers its own answer. It must reach nobody from the next generation.
    deliverCommandResult(executionToken: firstToken, result: (Data("refusal".utf8), false)) { _ in }
    XCTAssertNil(second.joinerData, "a refusal must not answer the execution that replaced it")

    commandJournal.start(command: command)
    commandJournal.markDispatched(command: command)
    commandJournal.finish(command: command, response: Response(ok: true, data: DataPayload(message: "ran")))
    deliverCommandResult(executionToken: secondToken, result: (Data("ran".utf8), false)) { _ in }
    XCTAssertEqual(second.joinerData, Data("ran".utf8), "the joiner is answered by its own execution")
  }

  /// Asserts that no send is left waiting for a delivery, whichever execution it joined.
  private func assertNoJoinersLeft(_ message: String) {
    XCTAssertFalse(
      inFlightCommandWaiters.values.contains { !$0.isEmpty },
      message
    )
  }

  /// One send's answers on the transport route: the execution's own delivery and the join's.
  final class TransportJoiner {
    var primaryData: RunnerHttpResponse?
    var joinerData: RunnerHttpResponse?
  }

  /// Fills the retention window with commands the journal holds as running, so a close that lands after
  /// them has to prune.
  private func openCommandsFillingTheJournalWindow(_ count: Int) throws {
    for index in 0..<count {
      let open = try transportCommand("readText", id: "queued-\(index)")
      commandJournal.accept(command: open)
    }
  }

  /// Asserts the journal dropped one id's entry, which is the precondition the pruning tests share: with
  /// the entry gone, only what the journal keeps beside it can decide the next send of that id.
  private func assertJournalWindowDropped(_ commandId: String) {
    XCTAssertEqual(
      commandJournal.status(normalizedCommandId: commandId).lifecycleState,
      RunnerCommandLifecycleState.notAccepted.rawValue,
      "the test must have pushed this command's own entry out of the window"
    )
  }

  /// The bug this repo cannot survive: a repeat of a `commandId` whose command already finished used to be
  /// admitted again and drive the device a second time — a second tap — in either retention state the
  /// finished command's id can sit in: retained in the journal window, or pruned out of it by the pressure
  /// of a busy session. Sends go through the real listener here, because admission is the transport's
  /// route, not any helper's.
  ///
  /// `recordStop` makes a second execution observable without recording anything: with no active recording
  /// it answers "recording already stopped", so a re-execution shows up as the recorder this test installs
  /// being consumed instead of the recorded answer being replayed.
  func testTransportNeverRepeatsAFinishedCommandsExecution() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let client = URLSession(configuration: .ephemeral)
    defer { client.invalidateAndCancel() }
    func recordStop(_ id: String) throws -> Response {
      try transportHttpResponse(
        client: client,
        port: port,
        payload: #"{"command":"recordStop","commandId":"\#(id)"}"#
      )
    }
    func installRecorderAsEvidence() -> ScreenRecorder {
      let installed = ScreenRecorder(outputPath: "", fps: 30)
      activeRecording = installed
      return installed
    }

    activeRecording = nil
    let first = try recordStop("record-stop-twice")
    XCTAssertTrue(first.ok, String(describing: first.error))
    XCTAssertEqual(first.data?.message, "recording already stopped")

    var installed = installRecorderAsEvidence()
    let repeatSend = try recordStop("record-stop-twice")
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

    // Now the same route for an id whose entry pruning has dropped: only the fact the journal keeps
    // beside the entry can answer for it, and that fact owes the typed refusal.
    activeRecording = nil
    XCTAssertTrue(try recordStop("record-stop-pruned").ok)
    runnerJournalFinishOtherCommands(commandJournal, 64)
    assertJournalWindowDropped("record-stop-pruned")
    installed = installRecorderAsEvidence()
    defer { activeRecording = nil }

    let resend = try recordStop("record-stop-pruned")

    XCTAssertIdentical(
      activeRecording,
      installed,
      "a pruned id whose work reached the device must not execute again"
    )
    XCTAssertEqual(resend.ok, false)
    XCTAssertEqual(resend.error?.code, RunnerWireErrorCode.commandAlreadyFinished)
  }

  #if os(iOS)
    @MainActor
    func testTransportReplaysPasteboardWriteWithoutWritingAgain() throws {
      let originalItems = UIPasteboard.general.items
      defer { UIPasteboard.general.items = originalItems }
      try withTransportClient { client, port in
        let first = try transportHttpResponse(
          client: client, port: port,
          payload: #"{"command":"pasteboardWrite","commandId":"pasteboard-twice","text":"journal-first-write"}"#
        )
        XCTAssertTrue(first.ok, String(describing: first.error))
        XCTAssertEqual(UIPasteboard.general.string, "journal-first-write")
        let repeated = try transportHttpResponse(
          client: client, port: port,
          payload: #"{"command":"pasteboardWrite","commandId":"pasteboard-twice","text":"would-overwrite-on-reexecution"}"#
        )
        XCTAssertTrue(repeated.ok, String(describing: repeated.error))
        XCTAssertEqual(UIPasteboard.general.string, "journal-first-write")
        XCTAssertEqual(repeated.data?.runnerMainThreadBusy, false)
      }
    }
  #endif

  @MainActor
  func testTransportReexecutesAFinishedSnapshotWithTheSameId() throws {
    app.launch()
    defer { app.terminate() }
    try withTransportClient { client, port in
      let payload = #"{"command":"snapshot","commandId":"snapshot-twice","interactiveOnly":true}"#

      for _ in 0..<2 {
        let reply = try transportHttpResponse(client: client, port: port, payload: payload)
        XCTAssertTrue(reply.ok, String(describing: reply.error))
        let nodes = try XCTUnwrap(reply.data?.nodes)
        XCTAssertFalse(nodes.isEmpty)
      }
    }
  }

  @MainActor
  func testTransportReexecutesASelectorReadWithTheSameId() throws {
    app.launch()
    defer { app.terminate() }
    try withTransportClient { client, port in
      let first = try transportHttpResponse(
        client: client, port: port,
        payload: #"{"command":"querySelector","commandId":"selector-twice","selectorKey":"label","selectorValue":"Agent Device Runner"}"#
      )
      XCTAssertTrue(first.ok, String(describing: first.error))
      XCTAssertEqual(first.data?.found, true)
      let repeated = try transportHttpResponse(
        client: client, port: port,
        payload: #"{"command":"querySelector","commandId":"selector-twice","selectorKey":"label","selectorValue":"missing-journal-selector"}"#
      )
      XCTAssertTrue(repeated.ok, String(describing: repeated.error))
      XCTAssertEqual(repeated.data?.found, false, "a finished selector read must execute instead of replaying its retained answer")
    }
  }

  @MainActor
  private func withTransportClient(_ body: (URLSession, NWEndpoint.Port) throws -> Void) throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let client = URLSession(configuration: .ephemeral)
    defer { client.invalidateAndCancel() }
    try body(client, port)
  }

  private func transportCommand(_ command: String, id: String) throws -> Command {
    try JSONDecoder().decode(
      Command.self,
      from: Data(#"{"command":"\#(command)","commandId":"\#(id)"}"#.utf8)
    )
  }

  /// A command that closed through the throw path must be answered from the journal with the same code
  /// the live answer carried. The daemon reads that code to decide whether the runner's main thread is
  /// still draining the work this command abandoned: a replayed failure that arrives without it reads
  /// as an ordinary served refusal, which reports the thread drained at the exact moment the timed-out
  /// command occupies it.
  ///
  /// The alert route is the throw path this lane can drive on its own deadline: the resolution outlives
  /// the 500 ms request, so the bounded dispatch throws the watchdog timeout, `executeAccepted` records
  /// it, and the repeat is answered from that record.
  ///
  /// Repeats go through `execute(command:)`, which routes a send the way the transport does, so this
  /// proves the wire path and not a helper's.
  #if os(iOS)
    @MainActor
    func testTransportReplaysAThrownFailureWithItsWireCode() throws {
      let resolutionExited = expectation(description: "blocked alert resolution exited")
      let releaseResolution = DispatchSemaphore(value: 0)
      mainOwned.app = springboard
      mainOwned.bundleId = Self.springboardBundleId
      alertResolutionOverrideForTesting = { _ in
        _ = releaseResolution.wait(timeout: .now() + 2)
        resolutionExited.fulfill()
        return nil
      }
      defer {
        releaseResolution.signal()
        alertResolutionOverrideForTesting = nil
        mainOwned.app = nil
        mainOwned.bundleId = nil
      }
      let payload =
        #"{"command":"alert","commandId":"alert-timed-out","appBundleId":"com.apple.springboard","action":"accept","timeoutMs":500}"#
      let command = try JSONDecoder().decode(Command.self, from: Data(payload.utf8))

      XCTAssertThrowsError(try execute(command: command)) { error in
        XCTAssertEqual((error as NSError).code, RunnerErrorCode.mainThreadExecutionTimedOut)
      }
      releaseResolution.signal()
      wait(for: [resolutionExited], timeout: 2)
      let drainDeadline = Date().addingTimeInterval(2)
      while hasAbandonedMainThreadWork(), Date() < drainDeadline {
        sleepFor(0.005)
      }

      let replay = try execute(command: command)

      XCTAssertEqual(replay.ok, false)
      XCTAssertEqual(
        replay.error?.code,
        RunnerWireErrorCode.mainThreadTimeout,
        "a replayed failure must carry the code the live answer carried, got \(String(describing: replay.error?.code))"
      )
    }
  #endif

  /// A `shutdown` answer is what ends the runner's own XCTest run, so the send that receives it has to be
  /// the one that ends the runner — including the send the journal answers. A resend whose first answer
  /// the daemon lost is exactly the case the journal exists to serve: if that reply is not allowed to
  /// finish, the runner keeps listening with no caller left to stop it, and disposal has to wait out its
  /// timeout and escalate to a signal.
  func testTransportFinishesTheRunnerOnAReplayOfAFinishedShutdown() throws {
    let command = try transportCommand("shutdown", id: "shutdown-answered-twice")
    // The state a resend finds: this shutdown ran, was marked dispatched, and closed with its answer.
    commandJournal.accept(command: command)
    commandJournal.markDispatched(command: command)
    commandJournal.finish(
      command: command,
      response: Response(ok: true, data: DataPayload(message: "shutdown"))
    )

    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let client = URLSession(configuration: .ephemeral)
    defer { client.invalidateAndCancel() }
    let finished = expectation(description: "the replayed shutdown asked the runner to finish")
    // Cleared on the way out so a run that never finished cannot leak the expectation into the next
    // test; the delivery that fulfils it clears it first.
    defer { doneExpectation = nil }
    doneExpectation = finished

    let reply = try transportHttpResponse(
      client: client,
      port: port,
      payload: #"{"command":"shutdown","commandId":"shutdown-answered-twice"}"#
    )

    XCTAssertEqual(reply.ok, true)
    XCTAssertEqual(
      reply.data?.message,
      "shutdown",
      "the repeat is answered from the journal rather than executed again"
    )
    wait(for: [finished], timeout: 2)
  }

  /// The mirror of the case above, and the reason the finish flag is the journal's fact: a caller that
  /// reuses a spent `commandId` under the name `shutdown` receives the recorded answer of whatever that
  /// id really ran. Ending the runner there would stop it on some other command's answer, so the resend
  /// is answered and the runner keeps serving.
  func testTransportDoesNotFinishOnAReplayOfAnotherCommandsRecordedAnswer() throws {
    let spent = try transportCommand("recordStart", id: "spent-then-named-shutdown")
    commandJournal.accept(command: spent)
    commandJournal.markDispatched(command: spent)
    commandJournal.finish(
      command: spent,
      response: Response(ok: true, data: DataPayload(message: "read"))
    )

    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let client = URLSession(configuration: .ephemeral)
    defer { client.invalidateAndCancel() }
    // Fulfilled only by a delivery that wrongly asks the runner to finish, which is what this test
    // rules out. `wait` with no expectation would not catch a finish that happens late.
    let wronglyFinished = expectation(description: "a replay must not finish the runner")
    wronglyFinished.isInverted = true
    doneExpectation = wronglyFinished
    defer { doneExpectation = nil }

    let reply = try transportHttpResponse(
      client: client,
      port: port,
      payload: #"{"command":"shutdown","commandId":"spent-then-named-shutdown"}"#
    )

    XCTAssertEqual(reply.ok, true)
    XCTAssertEqual(
      reply.data?.message,
      "read",
      "the id's recorded answer is served, not a shutdown answer"
    )
    wait(for: [wronglyFinished], timeout: 1)
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
    case .terminal(let outcome, _):
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
