import XCTest
import Network

extension RunnerTests {
  // MARK: - Connection Lifecycle

  /// How long one request may take to arrive. A tunnel peer's clock starts when it connects; a
  /// loopback peer may idle, so its clock starts at its first byte.
  static let requestTimeout: TimeInterval = 30

  /// An unused loopback connection watches listener lifetime. Used connections have bounded idle time.
  static let connectionIdleTimeout: TimeInterval = 30

  /// Every request is authenticated, including subsequent requests on an admitted connection.
  func handle(connection: NWConnection) {
    guard let token = listenerToken else {
      connection.cancel()
      return
    }
    transportConnections[ObjectIdentifier(connection)] = connection
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        self?.admit(connection, token: token)
      case .failed:
        connection.cancel()
      case .cancelled:
        connection.stateUpdateHandler = nil
        self?.transportConnections.removeValue(forKey: ObjectIdentifier(connection))
      default:
        break
      }
    }
    connection.start(queue: transportQueue)
  }

  private func admit(_ connection: NWConnection, token: RunnerListenerToken) {
    let peer = RunnerListenerPeer.of(connection)
    guard peer != .directNetwork else {
      connection.cancel()
      return
    }
    let inbound = RunnerInboundRequest(token: token)
    if peer == .tunnel {
      armDeadline(for: inbound, over: connection)
    }
    receiveRequest(inbound, over: connection)
  }

  // MARK: - Request Parsing

  private func receiveRequest(_ inbound: RunnerInboundRequest, over connection: NWConnection) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
      [weak self] data, _, isComplete, error in
      guard let self, !inbound.closed else { return }
      if let data, !data.isEmpty {
        self.consume(data, for: inbound, over: connection)
      } else if error != nil || isComplete {
        inbound.close()
        connection.cancel()
      } else {
        self.receiveRequest(inbound, over: connection)
      }
    }
  }

  private func consume(_ data: Data, for inbound: RunnerInboundRequest, over connection: NWConnection) {
    inbound.idleDeadline?.cancel()
    inbound.idleDeadline = nil
    if inbound.deadline == nil {
      armDeadline(for: inbound, over: connection)
    }
    let alreadyScanned = inbound.buffer.count
    inbound.buffer.append(data)
    if inbound.head == nil {
      switch RunnerHttpRequestFraming.admitHead(
        inbound.buffer,
        token: inbound.token,
        alreadyScanned: alreadyScanned
      ) {
      case .incomplete:
        receiveRequest(inbound, over: connection)
        return
      case .rejected(let rejection):
        reject(inbound, with: rejection, over: connection)
        return
      case .admitted(let head):
        inbound.head = head
      }
    }
    guard let head = inbound.head else { return }
    let bodyEnd = head.bodyOffset + head.contentLength
    guard inbound.buffer.count >= bodyEnd else {
      receiveRequest(inbound, over: connection)
      return
    }
    inbound.close()
    let body = inbound.buffer.subdata(in: head.bodyOffset..<bodyEnd)
    let remainder = Data(inbound.buffer.suffix(from: bodyEnd))
    handleRequestBody(body) { [weak self, token = inbound.token] result in
      self?.sendResult(result, over: connection, request: head, token: token, remainder: remainder)
    }
  }

  private func armDeadline(for inbound: RunnerInboundRequest, over connection: NWConnection) {
    let deadline = DispatchWorkItem { [weak self, inbound] in
      guard let self, !inbound.closed else { return }
      self.reject(inbound, with: .timedOut, over: connection)
    }
    inbound.deadline = deadline
    transportQueue.asyncAfter(deadline: .now() + Self.requestTimeout, execute: deadline)
  }

  private func reject(
    _ inbound: RunnerInboundRequest,
    with rejection: RunnerHttpRequestRejection,
    over connection: NWConnection
  ) {
    inbound.close()
    NSLog("AGENT_DEVICE_RUNNER_REQUEST_REJECTED status=%d", rejection.status)
    let response = jsonResponse(
      status: rejection.status,
      response: errorResponse(code: rejection.code, message: rejection.message)
    )
    sendResponse(response, over: connection, closeConnection: true)
  }

  private func sendResult(
    _ result: (response: RunnerHttpResponse, shouldFinish: Bool),
    over connection: NWConnection,
    request: RunnerHttpAdmittedHead,
    token: RunnerListenerToken,
    remainder: Data
  ) {
    let closeConnection = !request.keepsConnectionAlive || result.shouldFinish
    if result.shouldFinish { shutdownResponseWrites.enter() }
    sendResponse(result.response, over: connection, closeConnection: closeConnection) { [weak self] sent in
      guard let self else { return }
      if result.shouldFinish {
        self.shutdownResponseWrites.leave()
      } else if sent && !closeConnection {
        self.readNextRequest(over: connection, token: token, buffered: remainder)
      }
    }
  }

  private func readNextRequest(over connection: NWConnection, token: RunnerListenerToken, buffered: Data) {
    guard transportConnections[ObjectIdentifier(connection)] != nil else { return }
    let inbound = RunnerInboundRequest(token: token)
    if !buffered.isEmpty {
      consume(buffered, for: inbound, over: connection)
      return
    }
    // Idle expiry is silent; a partial request gets its own full arrival deadline and a 408.
    let idleDeadline = DispatchWorkItem {
      guard !inbound.closed else { return }
      inbound.close()
      connection.cancel()
    }
    inbound.idleDeadline = idleDeadline
    transportQueue.asyncAfter(deadline: .now() + Self.connectionIdleTimeout, execute: idleDeadline)
    receiveRequest(inbound, over: connection)
  }

  private func sendResponse(
    _ response: RunnerHttpResponse,
    over connection: NWConnection,
    closeConnection: Bool,
    afterSend: @escaping @Sendable (Bool) -> Void = { _ in }
  ) {
    // Network delivers send completions on the connection's transport queue.
    connection.send(content: response.encoded(closeConnection: closeConnection), completion: .contentProcessed { error in
      if let error {
        NSLog("AGENT_DEVICE_RUNNER_SEND_FAILED=%@", String(describing: error))
      }
      if closeConnection || error != nil { connection.cancel() }
      afterSend(error == nil)
    })
  }

  private func handleRequestBody(
    _ body: Data,
    completion: @escaping @Sendable ((response: RunnerHttpResponse, shouldFinish: Bool)) -> Void
  ) {
    guard String(data: body, encoding: .utf8) != nil else {
      completion((
        jsonResponse(
          status: 400,
          response: errorResponse(
            code: "INVALID_ARGS",
            message: "runner request body must be UTF-8 JSON",
            hint: "Send a JSON object matching the runner command protocol."
          )
        ),
        false
      ))
      return
    }

    do {
      let command = try JSONDecoder().decode(Command.self, from: body)
      if let response = inlineResponse(for: command) {
        completion((jsonResponse(status: 200, response: response), false))
        return
      }
      // The journal decides whether this send may run the command at all. Reading that verdict here, at
      // the one route an inbound request takes, is what keeps one `commandId` to one execution: a
      // command that already finished is answered from the journal, so a repeat that arrives after its
      // answer was delivered cannot drive the device a second time.
      switch commandJournal.accept(command: command) {
      case .join:
        // Re-sends of a still-executing commandId (the daemon's transport retry loop) attach to the
        // in-flight execution and receive its response instead of piling a second execution onto the
        // main queue behind it (#1105 capture pileup).
        attachToInFlightExecution(command: command, completion: completion)
      case .terminal(let outcome):
        NSLog(
          "AGENT_DEVICE_RUNNER_COMMAND_ALREADY_FINISHED command=%@ commandId=%@",
          command.command.rawValue,
          command.commandId ?? ""
        )
        completion((jsonResponse(status: 200, response: outcome), false))
      case .execute:
        NSLog(
          "AGENT_DEVICE_RUNNER_COMMAND_ACCEPTED command=%@ commandId=%@",
          command.command.rawValue,
          command.commandId ?? ""
        )
        enqueueAdmittedExecution(command: command) { result in
          switch result {
          case .success(let response):
            NSLog(
              "AGENT_DEVICE_RUNNER_COMMAND_COMPLETED command=%@ commandId=%@ ok=%d",
              command.command.rawValue,
              command.commandId ?? "",
              response.ok ? 1 : 0
            )
            self.deliverCommandResult(
              command: command,
              result: (self.jsonResponse(status: 200, response: response), command.command == .shutdown),
              completion: completion
            )
          case .failure(let error):
            NSLog(
              "AGENT_DEVICE_RUNNER_COMMAND_FAILED command=%@ commandId=%@ error=%@",
              command.command.rawValue,
              command.commandId ?? "",
              String(describing: error)
            )
            self.deliverCommandResult(
              command: command,
              result: (
                self.jsonResponse(status: 500, response: self.commandFailedResponse(from: error)),
                false
              ),
              completion: completion
            )
          }
        }
      }
    } catch {
      completion((
        jsonResponse(
          status: 400,
          response: errorResponse(
            code: "INVALID_ARGS",
            message: "runner command payload is invalid: \(String(describing: error))",
            hint: "Check the command name and fields against the runner protocol."
          )
        ),
        false
      ))
    }
  }

  // MARK: - Command Routing

  /// Status and uptime read runner state without entering the journal or the command queue.
  func inlineResponse(for command: Command) -> Response? {
    switch command.command {
    case .status:
      return executeStatus(command: command)
    case .uptime:
      return executeUptime()
    default:
      return nil
    }
  }

  /// Executes an already-admitted `command` on `commandExecutionQueue`; `completion` runs on that
  /// queue. Admission is not this function's decision: the route asked the journal for the verdict
  /// before calling it, so nothing here can re-admit a spent `commandId`.
  func enqueueAdmittedExecution(
    command: Command,
    completion: @escaping @Sendable (Result<Response, Error>) -> Void
  ) {
    commandExecutionQueue.async {
      completion(Result { try self.executeAccepted(command: command) })
    }
  }

  // MARK: - In-Flight Command Coalescing

  /// Attaches this send to the in-flight execution the journal just told it to join, so the execution's
  /// own delivery answers it. The journal closes an entry before its delivery drains this waiter list, and
  /// both take `inFlightCommandLock`, so checking here under that lock decides which answer this send is
  /// owed exactly once: one that arrives after the entry closed answers from the journal instead of
  /// waiting for a delivery that already went out.
  func attachToInFlightExecution(
    command: Command,
    completion: @escaping @Sendable ((response: RunnerHttpResponse, shouldFinish: Bool)) -> Void
  ) {
    guard let commandId = command.commandId?.trimmedNonEmpty else { return }
    inFlightCommandLock.lock()
    if let outcome = commandJournal.closedOutcome(for: command) {
      inFlightCommandLock.unlock()
      completion((jsonResponse(status: 200, response: outcome), false))
      return
    }
    inFlightCommandWaiters[commandId, default: []].append(completion)
    inFlightCommandLock.unlock()
    NSLog(
      "AGENT_DEVICE_RUNNER_COMMAND_COALESCED command=%@ commandId=%@",
      command.command.rawValue,
      commandId
    )
  }

  func deliverCommandResult(
    command: Command,
    result: (response: RunnerHttpResponse, shouldFinish: Bool),
    completion: ((response: RunnerHttpResponse, shouldFinish: Bool)) -> Void
  ) {
    var waiters: [@Sendable ((response: RunnerHttpResponse, shouldFinish: Bool)) -> Void] = []
    if let commandId = command.commandId?.trimmedNonEmpty {
      inFlightCommandLock.lock()
      waiters = inFlightCommandWaiters.removeValue(forKey: commandId) ?? []
      inFlightCommandLock.unlock()
    }
    completion(result)
    for waiter in waiters {
      waiter(result)
    }
    // Register after every waiter starts its write, so a fast response cannot close slower peers.
    if result.shouldFinish {
      shutdownResponseWrites.notify(queue: transportQueue) { self.finish() }
    }
  }

  // MARK: - Response Encoding

  private func jsonResponse(status: Int, response: Response) -> RunnerHttpResponse {
    // Stamp the gesture-clock uptime at the END of command handling, just before the HTTP
    // write, so the warm snapshot and recordStart responses carry the anchor for free. This
    // runs AFTER commandJournal.finish, so journal-stored lifecycleResponseJson stays
    // unstamped — recovered/status-replayed results carry no anchor and the daemon falls back
    // rather than pairing a stale uptime with a much-later receipt time.
    let stamped =
      response.ok
      ? response
        .stampingCurrentUptimeMs(ProcessInfo.processInfo.systemUptime * 1000)
        .stampingCurrentMainThreadBusy(currentMainThreadBusyState().reportsMainThreadBusy)
      : response
    let encoder = JSONEncoder()
    let body = (try? encoder.encode(stamped)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    return RunnerHttpResponse(status: status, body: body)
  }

  private func errorResponse(code: String, message: String, hint: String? = nil) -> Response {
    Response(ok: false, error: ErrorPayload(code: code, message: message, hint: hint))
  }

  /// Turns a thrown command error into its wire response. The execution-watchdog timeout keeps its
  /// own typed code so the daemon records the runner as main-thread-occupied from the stalling
  /// command itself, not only from a later `RUNNER_BUSY` refusal (#2552); every other throw stays the
  /// generic `COMMAND_FAILED`.
  func commandFailedResponse(from error: Error) -> Response {
    let nsError = error as NSError
    if nsError.domain == RunnerErrorDomain.general,
      nsError.code == RunnerErrorCode.mainThreadExecutionTimedOut
    {
      return Response(
        ok: false,
        error: ErrorPayload(
          code: RunnerWireErrorCode.mainThreadTimeout,
          message: nsError.localizedDescription,
          hint:
            "The runner abandoned this command's main-thread work past its execution watchdog and it is still draining. Wait and retry, or use a screenshot and interact by coordinates."
        )
      )
    }
    return errorResponse(
      code: "COMMAND_FAILED",
      message: error.localizedDescription,
      hint: "Check the runner log for XCTest details, then retry after the app is foregrounded if this was a timeout or activation failure."
    )
  }

  /// Present on every response so the daemon can refuse a runner build that predates the token.
  static let authEnforcedResponseHeader = "X-Agent-Device-Runner-Auth"

  func closeTransport() {
    listener?.cancel()
    listener = nil
    for connection in transportConnections.values { connection.cancel() }
    transportConnections.removeAll()
  }

  private func finish() {
    closeTransport()
    doneExpectation?.fulfill()
    doneExpectation = nil
  }
}

/// One request on a connection, read on the transport queue.
final class RunnerInboundRequest {
  let token: RunnerListenerToken
  var buffer = Data()
  var head: RunnerHttpAdmittedHead?
  var deadline: DispatchWorkItem?
  var idleDeadline: DispatchWorkItem?
  private(set) var closed = false

  init(token: RunnerListenerToken) {
    self.token = token
  }

  /// Ends reading this request: its body is complete, it was refused, or the peer left. Dropping the
  /// deadline also releases the request it holds.
  func close() {
    closed = true
    deadline?.cancel()
    deadline = nil
    idleDeadline?.cancel()
    idleDeadline = nil
  }
}

/// Coalesced commands share their response, but each connection owns its persistence policy.
struct RunnerHttpResponse: Equatable, Sendable {
  let status: Int
  let body: String

  func encoded(closeConnection: Bool) -> Data {
    let headers = [
      "HTTP/1.1 \(status) \(Self.reasonPhrase(status))",
      "Content-Type: application/json",
      "Content-Length: \(body.utf8.count)",
      "\(RunnerTests.authEnforcedResponseHeader): required",
      "Connection: \(closeConnection ? "close" : "keep-alive")",
      "",
      body
    ].joined(separator: "\r\n")
    return Data(headers.utf8)
  }

  private static func reasonPhrase(_ status: Int) -> String {
    switch status {
    case 200: return "OK"
    case 400: return "Bad Request"
    case 401: return "Unauthorized"
    case 404: return "Not Found"
    case 405: return "Method Not Allowed"
    case 408: return "Request Timeout"
    case 411: return "Length Required"
    case 413: return "Content Too Large"
    case 431: return "Request Header Fields Too Large"
    default: return "Internal Server Error"
    }
  }
}
