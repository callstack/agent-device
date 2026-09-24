import Foundation
import XCTest
import AgentDeviceSnapshotPresentation

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
    guard let commandId = command.commandId?.trimmedNonEmpty else { return }
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

  func status(normalizedCommandId commandId: String) -> DataPayload {
    lock.lock()
    let entry = entries[commandId]
    lock.unlock()
    guard let entry else {
      return DataPayload(
        commandId: commandId,
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
    guard let commandId = command.commandId?.trimmedNonEmpty else { return }
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
         .remotePress, .type, .swipe, .scroll, .desktopScroll, .findText, .querySelector, .readText,
         .backInApp, .backSystem, .home, .rotate, .appSwitcher, .actionButton, .keyboardDismiss, .keyboardReturn,
         .alert, .sequence, .gesture, .gestureViewport, .recordStart, .recordStop,
         .status, .uptime, .appState, .activate, .terminate, .targetReset, .shutdown:
      return true
    }
  }
}
