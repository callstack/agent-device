import Foundation
import XCTest

enum RunnerCommandLifecycleState: String {
  case notAccepted
  case accepted
  case started
  case completed
  case failed
}

struct RunnerCommandJournalEntry {
  let commandId: String
  let command: String
  var state: RunnerCommandLifecycleState
  var responseOk: Bool?
  var responseJson: String?
  var error: ErrorPayload?
}

final class RunnerCommandJournal {
  private let lock = NSLock()
  private let maxEntries = 64
  private let maxResponseJsonBytes = 16 * 1024
  private var entries: [String: RunnerCommandJournalEntry] = [:]
  private var order: [String] = []

  func accept(command: Command) {
    guard let commandId = normalizedCommandId(command.commandId) else { return }
    lock.lock()
    defer { lock.unlock() }
    entries[commandId] = RunnerCommandJournalEntry(
      commandId: commandId,
      command: command.command.rawValue,
      state: .accepted,
      responseOk: nil,
      responseJson: nil,
      error: nil
    )
    order.removeAll { $0 == commandId }
    order.append(commandId)
    pruneIfNeeded()
  }

  func start(command: Command) {
    update(command: command, state: .started, responseOk: nil, responseJson: nil, error: nil)
  }

  func finish(command: Command, response: Response) {
    update(
      command: command,
      state: response.ok ? .completed : .failed,
      responseOk: response.ok,
      responseJson: encodeResponseJson(command: command, response: response),
      error: response.error
    )
  }

  func fail(command: Command, error: Error) {
    update(
      command: command,
      state: .failed,
      responseOk: nil,
      responseJson: nil,
      error: ErrorPayload(message: error.localizedDescription)
    )
  }

  func status(commandId: String) -> DataPayload {
    guard let normalized = normalizedCommandId(commandId) else {
      return DataPayload(lifecycleState: RunnerCommandLifecycleState.notAccepted.rawValue)
    }
    lock.lock()
    let entry = entries[normalized]
    lock.unlock()
    guard let entry else {
      return DataPayload(
        commandId: normalized,
        lifecycleState: RunnerCommandLifecycleState.notAccepted.rawValue
      )
    }
    return DataPayload(
      commandId: entry.commandId,
      lifecycleState: entry.state.rawValue,
      lifecycleCommand: entry.command,
      lifecycleResponseOk: entry.responseOk,
      lifecycleResponseJson: entry.responseJson,
      lifecycleErrorCode: entry.error?.code,
      lifecycleErrorMessage: entry.error?.message,
      lifecycleErrorHint: entry.error?.hint
    )
  }

  private func update(
    command: Command,
    state: RunnerCommandLifecycleState,
    responseOk: Bool?,
    responseJson: String?,
    error: ErrorPayload?
  ) {
    guard let commandId = normalizedCommandId(command.commandId) else { return }
    lock.lock()
    defer { lock.unlock() }
    var entry = entries[commandId] ?? RunnerCommandJournalEntry(
      commandId: commandId,
      command: command.command.rawValue,
      state: .accepted,
      responseOk: nil,
      responseJson: nil,
      error: nil
    )
    entry.state = state
    entry.responseOk = responseOk
    entry.responseJson = responseJson
    entry.error = error
    entries[commandId] = entry
    order.removeAll { $0 == commandId }
    order.append(commandId)
    pruneIfNeeded()
  }

  private func pruneIfNeeded() {
    while order.count > maxEntries {
      let removed = order.removeFirst()
      entries.removeValue(forKey: removed)
    }
  }

  private func normalizedCommandId(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private func encodeResponseJson(command: Command, response: Response) -> String? {
    guard shouldRetainResponseJson(command: command) else { return nil }
    guard let data = try? JSONEncoder().encode(response) else { return nil }
    guard data.count <= maxResponseJsonBytes else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private func shouldRetainResponseJson(command: Command) -> Bool {
    switch command.command {
    case .snapshot, .screenshot:
      return false
    case .tap, .mouseClick, .longPress, .drag,
         .remotePress, .type, .swipe, .scroll, .desktopScroll, .findText, .querySelector, .readText, .back,
         .backInApp, .backSystem, .home, .rotate, .appSwitcher, .keyboardDismiss, .keyboardReturn,
         .alert, .sequence, .gesture, .gestureViewport, .recordStart, .recordStop,
         .status, .uptime, .targetReset, .shutdown:
      return true
    }
  }
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testUptimeBypassesCommandJournal() throws {
    let command = runnerJournalCommand("uptime", id: "uptime-probe")

    let response = try execute(command: command)
    let status = commandJournal.status(commandId: "uptime-probe")

    XCTAssertEqual(response.ok, true)
    XCTAssertNotNil(response.data?.currentUptimeMs)
    XCTAssertEqual(status.lifecycleState, RunnerCommandLifecycleState.notAccepted.rawValue)
  }

  func testStampingCurrentUptimePreservesPayload() {
    let stamped = Response(ok: true, data: DataPayload(message: "recording started"))
      .stampingCurrentUptimeMs(123.5)

    XCTAssertEqual(stamped.ok, true)
    XCTAssertEqual(stamped.data?.message, "recording started")
    XCTAssertEqual(stamped.data?.currentUptimeMs, 123.5)
  }

  func testStampingCurrentUptimeCreatesPayloadWhenNil() {
    let stamped = Response(ok: true).stampingCurrentUptimeMs(456.0)

    XCTAssertEqual(stamped.ok, true)
    XCTAssertEqual(stamped.data?.currentUptimeMs, 456.0)
  }

  func testStampingCurrentUptimeSkipsErrorResponses() {
    let response = Response(ok: false, error: ErrorPayload(message: "boom"))
    let stamped = response.stampingCurrentUptimeMs(789.0)

    XCTAssertEqual(stamped.ok, false)
    XCTAssertNil(stamped.data)
    XCTAssertEqual(stamped.error?.message, "boom")
  }

  func testJournalStoredResponseStaysUnstamped() throws {
    let journal = RunnerCommandJournal()
    let recordStart = runnerJournalCommand("recordStart", id: "record-start-anchor")

    journal.accept(command: recordStart)
    journal.finish(
      command: recordStart,
      response: Response(ok: true, data: DataPayload(message: "recording started"))
    )

    let status = journal.status(commandId: "record-start-anchor")
    let responseJson = try XCTUnwrap(status.lifecycleResponseJson)
    XCTAssertFalse(responseJson.contains("currentUptimeMs"))
  }

  func testCommandJournalRetentionPolicy() throws {
    let journal = RunnerCommandJournal()

    let uptime = runnerJournalCommand("uptime", id: "small-scalar")
    journal.accept(command: uptime)
    journal.finish(
      command: uptime,
      response: Response(ok: true, data: DataPayload(currentUptimeMs: 12.5))
    )

    let scalarStatus = journal.status(commandId: "small-scalar")
    XCTAssertEqual(scalarStatus.lifecycleState, RunnerCommandLifecycleState.completed.rawValue)
    XCTAssertEqual(scalarStatus.lifecycleResponseOk, true)
    XCTAssertNotNil(scalarStatus.lifecycleResponseJson)
    let scalarResponse = try decodeRunnerJournalResponse(scalarStatus.lifecycleResponseJson)
    XCTAssertEqual(scalarResponse.data?.currentUptimeMs, 12.5)

    let querySelector = runnerJournalCommand("querySelector", id: "small-object")
    journal.accept(command: querySelector)
    journal.finish(
      command: querySelector,
      response: Response(ok: true, data: DataPayload(found: true, nodes: [runnerJournalNode()]))
    )

    let objectStatus = journal.status(commandId: "small-object")
    XCTAssertNotNil(objectStatus.lifecycleResponseJson)
    let objectResponse = try decodeRunnerJournalResponse(objectStatus.lifecycleResponseJson)
    XCTAssertEqual(objectResponse.data?.found, true)
    XCTAssertEqual(objectResponse.data?.nodes?.count, 1)

    let snapshot = runnerJournalCommand("snapshot", id: "snapshot-tree")
    journal.accept(command: snapshot)
    journal.finish(
      command: snapshot,
      response: Response(ok: true, data: DataPayload(nodes: [runnerJournalNode()], truncated: false))
    )

    let snapshotStatus = journal.status(commandId: "snapshot-tree")
    XCTAssertEqual(snapshotStatus.lifecycleState, RunnerCommandLifecycleState.completed.rawValue)
    XCTAssertEqual(snapshotStatus.lifecycleResponseOk, true)
    XCTAssertNil(snapshotStatus.lifecycleResponseJson)

    let screenshot = runnerJournalCommand("screenshot", id: "screenshot-artifact")
    journal.accept(command: screenshot)
    journal.finish(
      command: screenshot,
      response: Response(ok: true, data: DataPayload(message: "tmp/screenshot-1.png"))
    )

    let screenshotStatus = journal.status(commandId: "screenshot-artifact")
    XCTAssertEqual(screenshotStatus.lifecycleState, RunnerCommandLifecycleState.completed.rawValue)
    XCTAssertEqual(screenshotStatus.lifecycleResponseOk, true)
    XCTAssertNil(screenshotStatus.lifecycleResponseJson)

    let scroll = runnerJournalCommand("scroll", id: "scroll-drag")
    journal.accept(command: scroll)
    journal.finish(
      command: scroll,
      response: Response(
        ok: true,
        data: DataPayload(
          message: "scrolled",
          gestureStartUptimeMs: 1,
          gestureEndUptimeMs: 2,
          x: 155,
          y: 420,
          x2: 155,
          y2: 301,
          referenceWidth: 300,
          referenceHeight: 600
        )
      )
    )

    let scrollStatus = journal.status(commandId: "scroll-drag")
    XCTAssertEqual(scrollStatus.lifecycleState, RunnerCommandLifecycleState.completed.rawValue)
    XCTAssertEqual(scrollStatus.lifecycleResponseOk, true)
    XCTAssertNotNil(scrollStatus.lifecycleResponseJson)
    let scrollResponse = try decodeRunnerJournalResponse(scrollStatus.lifecycleResponseJson)
    XCTAssertEqual(scrollResponse.data?.x, 155)
    XCTAssertEqual(scrollResponse.data?.y, 420)
    XCTAssertEqual(scrollResponse.data?.x2, 155)
    XCTAssertEqual(scrollResponse.data?.y2, 301)
    XCTAssertEqual(scrollResponse.data?.referenceWidth, 300)
    XCTAssertEqual(scrollResponse.data?.referenceHeight, 600)

    let largeRead = runnerJournalCommand("readText", id: "large-read")
    journal.accept(command: largeRead)
    journal.finish(
      command: largeRead,
      response: Response(ok: true, data: DataPayload(text: String(repeating: "x", count: 17 * 1024)))
    )

    let largeReadStatus = journal.status(commandId: "large-read")
    XCTAssertEqual(largeReadStatus.lifecycleState, RunnerCommandLifecycleState.completed.rawValue)
    XCTAssertEqual(largeReadStatus.lifecycleResponseOk, true)
    XCTAssertNil(largeReadStatus.lifecycleResponseJson)
  }

  func testCommandJournalKeepsErrorMetadataWhenResponseJsonIsDropped() {
    let journal = RunnerCommandJournal()
    let snapshot = runnerJournalCommand("snapshot", id: "snapshot-error")
    let hint = "Try a smaller read such as snapshot -s <visible label or id> -d 8."

    journal.accept(command: snapshot)
    journal.finish(
      command: snapshot,
      response: Response(
        ok: false,
        error: ErrorPayload(
          code: "IOS_AX_SNAPSHOT_FAILED",
          message: "iOS XCTest snapshot failed while serializing the accessibility tree.",
          hint: hint
        )
      )
    )

    let status = journal.status(commandId: "snapshot-error")
    XCTAssertEqual(status.lifecycleState, RunnerCommandLifecycleState.failed.rawValue)
    XCTAssertEqual(status.lifecycleResponseOk, false)
    XCTAssertNil(status.lifecycleResponseJson)
    XCTAssertEqual(status.lifecycleErrorCode, "IOS_AX_SNAPSHOT_FAILED")
    XCTAssertEqual(
      status.lifecycleErrorMessage,
      "iOS XCTest snapshot failed while serializing the accessibility tree."
    )
    XCTAssertEqual(status.lifecycleErrorHint, hint)
  }

  func testCommandJournalRetainsCompletedSequenceResults() throws {
    let journal = RunnerCommandJournal()
    let sequence = runnerJournalCommand("sequence", id: "sequence-completed")
    let results = (0..<20).map { _ in
      SequenceStepResult(
        ok: true,
        kind: "tap",
        errorCode: nil,
        errorMessage: nil,
        gestureStartUptimeMs: 100,
        gestureEndUptimeMs: 120
      )
    }

    journal.accept(command: sequence)
    journal.finish(
      command: sequence,
      response: Response(
        ok: true,
        data: DataPayload(
          message: "sequence",
          completedSteps: 20,
          failedStepIndex: nil,
          sequenceResults: results
        )
      )
    )

    let status = journal.status(commandId: "sequence-completed")
    XCTAssertEqual(status.lifecycleState, RunnerCommandLifecycleState.completed.rawValue)
    XCTAssertEqual(status.lifecycleResponseOk, true)
    let json = try XCTUnwrap(status.lifecycleResponseJson)
    // Worst-case 20-step response must stay under the 16KB journal retention cap.
    XCTAssertLessThan(json.utf8.count, 16 * 1024)
    let decoded = try decodeRunnerJournalResponse(status.lifecycleResponseJson)
    XCTAssertEqual(decoded.data?.completedSteps, 20)
    XCTAssertEqual(decoded.data?.sequenceResults?.count, 20)
  }

  func testCommandJournalRetainsFailedSequenceResults() throws {
    let journal = RunnerCommandJournal()
    let sequence = runnerJournalCommand("sequence", id: "sequence-failed")
    let longError = String(repeating: "z", count: 200)
    let results: [SequenceStepResult] = [
      SequenceStepResult(ok: true, kind: "tap", errorCode: nil, errorMessage: nil,
                         gestureStartUptimeMs: 100, gestureEndUptimeMs: 120),
      SequenceStepResult(ok: true, kind: "tap", errorCode: nil, errorMessage: nil,
                         gestureStartUptimeMs: 130, gestureEndUptimeMs: 150),
      SequenceStepResult(ok: false, kind: "longPress", errorCode: "UNSUPPORTED_OPERATION",
                         errorMessage: longError, gestureStartUptimeMs: 160, gestureEndUptimeMs: 180),
    ]

    journal.accept(command: sequence)
    journal.finish(
      command: sequence,
      response: Response(
        ok: true,
        data: DataPayload(
          message: "sequence",
          completedSteps: 2,
          failedStepIndex: 2,
          sequenceResults: results
        )
      )
    )

    let status = journal.status(commandId: "sequence-failed")
    XCTAssertEqual(status.lifecycleState, RunnerCommandLifecycleState.completed.rawValue)
    let decoded = try decodeRunnerJournalResponse(status.lifecycleResponseJson)
    XCTAssertEqual(decoded.data?.completedSteps, 2)
    XCTAssertEqual(decoded.data?.failedStepIndex, 2)
    XCTAssertEqual(decoded.data?.sequenceResults?.count, 3)
    XCTAssertEqual(decoded.data?.sequenceResults?[2].ok, false)
    XCTAssertEqual(decoded.data?.sequenceResults?[2].errorCode, "UNSUPPORTED_OPERATION")
  }

  private func runnerJournalCommand(_ command: String, id: String) -> Command {
    let json = #"{"command":"\#(command)","commandId":"\#(id)"}"#
    return try! JSONDecoder().decode(Command.self, from: Data(json.utf8))
  }

  private func runnerJournalNode() -> SnapshotNode {
    SnapshotNode(
      index: 0,
      type: "button",
      label: "Continue",
      identifier: "continue",
      value: nil,
      rect: SnapshotRect(x: 10, y: 20, width: 100, height: 44),
      enabled: true,
      focused: nil,
      selected: nil,
      hittable: true,
      depth: 0,
      parentIndex: nil,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }

  private func decodeRunnerJournalResponse(_ responseJson: String?) throws -> Response {
    let responseJson = try XCTUnwrap(responseJson)
    return try JSONDecoder().decode(Response.self, from: Data(responseJson.utf8))
  }
}
#endif
