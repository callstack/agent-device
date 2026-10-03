import XCTest
import Network

extension RunnerTests {
  // MARK: - Connection Lifecycle

  func handle(connection: NWConnection) {
    receiveRequest(connection: connection, buffer: Data())
  }

  // MARK: - Request Parsing

  private func receiveRequest(connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1024 * 1024) { [weak self] data, _, _, _ in
      guard let self = self, let data = data else {
        connection.cancel()
        return
      }
      if buffer.count + data.count > self.maxRequestBytes {
        let response = self.jsonResponse(
          status: 413,
          response: self.errorResponse(
            code: "INVALID_ARGS",
            message: "runner request body exceeds \(self.maxRequestBytes) bytes",
            hint: "Send one runner command per request and keep the payload below the runner request limit."
          )
        )
        self.sendResponse(response, over: connection) { [weak self] in
          self?.finish()
        }
        return
      }
      let combined = buffer + data
      if let body = self.parseRequest(data: combined) {
        self.handleRequestBody(body) { [weak self] result in
          self?.sendResult(result, over: connection)
        }
      } else {
        self.receiveRequest(connection: connection, buffer: combined)
      }
    }
  }

  private func sendResult(
    _ result: (data: Data, shouldFinish: Bool),
    over connection: NWConnection
  ) {
    sendResponse(result.data, over: connection) { [weak self] in
      if result.shouldFinish {
        self?.finish()
      }
    }
  }

  private func sendResponse(
    _ response: Data,
    over connection: NWConnection,
    afterSend: @escaping @Sendable () -> Void = {}
  ) {
    connection.send(content: response, isComplete: true, completion: .contentProcessed { error in
      if let error {
        NSLog("AGENT_DEVICE_RUNNER_SEND_FAILED=%@", String(describing: error))
      }
      connection.cancel()
      afterSend()
    })
  }

  private func parseRequest(data: Data) -> Data? {
    guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else {
      return nil
    }
    let headerData = data.subdata(in: 0..<headerEnd.lowerBound)
    let bodyStart = headerEnd.upperBound
    let headers = String(decoding: headerData, as: UTF8.self)
    let contentLength = extractContentLength(headers: headers)
    guard let contentLength = contentLength else {
      return nil
    }
    if data.count < bodyStart + contentLength {
      return nil
    }
    let body = data.subdata(in: bodyStart..<(bodyStart + contentLength))
    return body
  }

  private func extractContentLength(headers: String) -> Int? {
    for line in headers.split(separator: "\r\n") {
      let parts = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
      if parts.count == 2 && parts[0].lowercased() == "content-length" {
        return Int(parts[1])
      }
    }
    return nil
  }

  private func handleRequestBody(
    _ body: Data,
    completion: @escaping @Sendable ((data: Data, shouldFinish: Bool)) -> Void
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
      // Re-sends of a still-executing commandId (the daemon's transport retry loop) attach to
      // the in-flight execution and receive its response instead of piling a second execution
      // onto the main queue behind it (#1105 capture pileup).
      if attachToInFlightCommandIfNeeded(command: command, completion: completion) {
        return
      }
      NSLog(
        "AGENT_DEVICE_RUNNER_COMMAND_ACCEPTED command=%@ commandId=%@",
        command.command.rawValue,
        command.commandId ?? ""
      )
      enqueueAccepted(command: command) { result in
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

  /// Journal-accepts `command` and executes it on `commandExecutionQueue`; `completion` runs on that
  /// queue.
  func enqueueAccepted(
    command: Command,
    completion: @escaping @Sendable (Result<Response, Error>) -> Void
  ) {
    commandJournal.accept(command: command)
    commandExecutionQueue.async {
      completion(Result { try self.executeAccepted(command: command) })
    }
  }

  // MARK: - In-Flight Command Coalescing

  /// Returns true when this send duplicated a still-executing commandId and was attached as a
  /// waiter of the in-flight execution. Otherwise marks the commandId in flight and returns
  /// false so the caller enqueues the (single) execution.
  func attachToInFlightCommandIfNeeded(
    command: Command,
    completion: @escaping @Sendable ((data: Data, shouldFinish: Bool)) -> Void
  ) -> Bool {
    guard let commandId = command.commandId?.trimmedNonEmpty else { return false }
    inFlightCommandLock.lock()
    if inFlightCommandIds.contains(commandId) {
      inFlightCommandWaiters[commandId, default: []].append(completion)
      inFlightCommandLock.unlock()
      NSLog(
        "AGENT_DEVICE_RUNNER_COMMAND_COALESCED command=%@ commandId=%@",
        command.command.rawValue,
        commandId
      )
      return true
    }
    inFlightCommandIds.insert(commandId)
    inFlightCommandLock.unlock()
    return false
  }

  func deliverCommandResult(
    command: Command,
    result: (data: Data, shouldFinish: Bool),
    completion: ((data: Data, shouldFinish: Bool)) -> Void
  ) {
    var waiters: [@Sendable ((data: Data, shouldFinish: Bool)) -> Void] = []
    if let commandId = command.commandId?.trimmedNonEmpty {
      inFlightCommandLock.lock()
      inFlightCommandIds.remove(commandId)
      waiters = inFlightCommandWaiters.removeValue(forKey: commandId) ?? []
      inFlightCommandLock.unlock()
    }
    completion(result)
    for waiter in waiters {
      waiter(result)
    }
  }

  // MARK: - Response Encoding

  private func jsonResponse(status: Int, response: Response) -> Data {
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
    return httpResponse(status: status, body: body)
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

  private func httpResponse(status: Int, body: String) -> Data {
    let headers = [
      "HTTP/1.1 \(status) OK",
      "Content-Type: application/json",
      "Content-Length: \(body.utf8.count)",
      "Connection: close",
      "",
      body
    ].joined(separator: "\r\n")
    return Data(headers.utf8)
  }

  private func finish() {
    listener?.cancel()
    listener = nil
    // Guard against double-fulfill: coalesced shutdown sends deliver one result to
    // multiple waiters, each of which may ask to finish.
    doneExpectation?.fulfill()
    doneExpectation = nil
  }
}
