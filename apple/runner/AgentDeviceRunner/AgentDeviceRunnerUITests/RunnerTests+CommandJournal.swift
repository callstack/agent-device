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

extension RunnerCommandLifecycleState {
  /// Whether execution has ended for an entry in this state. `notAccepted` is never written to an
  /// entry — `status` synthesizes it for an id the journal does not hold — so it is not terminal.
  var isTerminal: Bool {
    self == .completed || self == .failed
  }
}

struct RunnerCommandJournalEntry {
  let commandId: String
  let command: String
  var state: RunnerCommandLifecycleState
  var responseOk: Bool?
  var responseJson: String?
  var error: ErrorPayload?
  /// Whether any of this command's work reached the device. The runner refuses a command whose main
  /// thread is still draining abandoned work before running anything, so such a refusal left nothing
  /// on the device and its terminal entry must not close the id: the read-only busy resend carries the
  /// same `commandId` (ADR 0005).
  var dispatched = false
}

/// The journal's verdict on one command that carries a `commandId`.
enum RunnerCommandAdmission {
  /// Nothing is running for this id and nothing has finished: the caller owns the one execution.
  case execute
  /// An execution is claimed and has not finished: the caller joins its outcome and runs nothing.
  case join
  /// Execution finished, and the work reached the device: the caller answers from the journal and
  /// never executes this command again.
  case terminal(outcome: Response)
}

/// The runner's one command-lifecycle record: what it holds for a `commandId`, whether that id may run,
/// and what `status` answers for it. The transport asks this type before enqueuing anything, so one
/// `commandId` is executed at most once, and a command that already finished cannot be replayed onto the
/// device by a repeat that arrives after its answer was delivered.
final class RunnerCommandJournal {
  private let lock = NSLock()
  private let maxEntries = 64
  private let maxResponseJsonBytes = 16 * 1024
  private var entries: [String: RunnerCommandJournalEntry] = [:]
  private var order: [String] = []

  @discardableResult
  func accept(command: Command) -> RunnerCommandAdmission {
    guard let commandId = command.commandId?.trimmedNonEmpty else { return .execute }
    lock.lock()
    defer { lock.unlock() }
    guard let entry = entries[commandId] else {
      return claim(command: command, commandId: commandId)
    }
    if !entry.state.isTerminal {
      return .join
    }
    // Nothing of this command ever reached the device, so the id carries no effect to protect and the
    // send that reuses it is that command's own first execution.
    guard entry.dispatched else {
      return claim(command: command, commandId: commandId)
    }
    return .terminal(outcome: recordedOutcome(for: entry))
  }

  func start(command: Command) {
    update(
      command: command,
      state: .started,
      responseOk: nil,
      responseJson: nil,
      error: nil,
      marksDispatched: false
    )
  }

  /// Records that this command's work was handed to the device, as opposed to being refused while it
  /// was still queued. Until this point a refusal owes the caller a retry of the same `commandId`.
  func markDispatched(command: Command) {
    update(
      command: command,
      state: .started,
      responseOk: nil,
      responseJson: nil,
      error: nil,
      marksDispatched: true
    )
  }

  func finish(command: Command, response: Response) {
    update(
      command: command,
      state: response.ok ? .completed : .failed,
      responseOk: response.ok,
      responseJson: encodeResponseJson(command: command, response: response),
      error: response.error,
      marksDispatched: false
    )
  }

  func fail(command: Command, error: Error) {
    update(
      command: command,
      state: .failed,
      responseOk: nil,
      responseJson: nil,
      error: ErrorPayload(message: error.localizedDescription),
      marksDispatched: false
    )
  }

  /// The answer owed a send that joined an execution which has since closed: the outcome the runner
  /// recorded, whether or not the work reached the device. Registering that send as a waiter instead
  /// would leave it waiting on a delivery that already went out. `accept` answers a closed id on its own
  /// terms, so this is narrower than admission.
  func closedOutcome(for command: Command) -> Response? {
    guard let commandId = command.commandId?.trimmedNonEmpty else { return nil }
    lock.lock()
    let entry = entries[commandId]
    lock.unlock()
    guard let entry, entry.state.isTerminal else { return nil }
    return recordedOutcome(for: entry)
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

  /// Writes the claim for one execution. Callers hold the lock.
  private func claim(command: Command, commandId: String) -> RunnerCommandAdmission {
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
    return .execute
  }

  /// Moves one claimed entry forward. A transition for an id the journal does not hold describes work it
  /// never claimed, and one for an entry that already finished restates a closed outcome: neither may
  /// open a record again. Re-opening one would report `accepted` or `started` for work that is not
  /// running, and the daemon holds that verdict as an in-flight exchange on a runner it would otherwise
  /// hand off.
  private func update(
    command: Command,
    state: RunnerCommandLifecycleState,
    responseOk: Bool?,
    responseJson: String?,
    error: ErrorPayload?,
    marksDispatched: Bool
  ) {
    guard let commandId = command.commandId?.trimmedNonEmpty else { return }
    lock.lock()
    defer { lock.unlock() }
    guard var entry = entries[commandId], !entry.state.isTerminal else { return }
    entry.state = state
    entry.responseOk = responseOk
    entry.responseJson = responseJson
    entry.error = error
    if marksDispatched {
      entry.dispatched = true
    }
    entries[commandId] = entry
    order.removeAll { $0 == commandId }
    order.append(commandId)
    pruneIfNeeded()
  }

  /// Drops the oldest closed entries. An entry whose execution is claimed but not finished is never
  /// dropped, however deep the backlog: `status` answers `notAccepted` only for an id this journal does
  /// not hold, and the daemon cannot read that as a safe terminal state — it would invalidate a session
  /// whose runner is still executing the command it lost the answer to.
  private func pruneIfNeeded() {
    while order.count > maxEntries {
      guard let removable = order.first(where: { entries[$0]?.state.isTerminal == true }) else {
        return
      }
      order.removeAll { $0 == removable }
      entries.removeValue(forKey: removable)
    }
  }

  /// The answer owed a repeat of a finished `commandId`: the outcome the runner kept, then the failure it
  /// kept, and only then a typed refusal for a command whose own classification retains no body at all.
  private func recordedOutcome(for entry: RunnerCommandJournalEntry) -> Response {
    if let responseJson = entry.responseJson,
      let recorded = try? JSONDecoder().decode(Response.self, from: Data(responseJson.utf8))
    {
      return recorded
    }
    if let error = entry.error {
      return Response(ok: false, error: error)
    }
    return Response(
      ok: false,
      error: ErrorPayload(
        code: RunnerTests.RunnerWireErrorCode.commandAlreadyFinished,
        message:
          "The runner already finished \(entry.command) with id \(entry.commandId) and kept no response to replay.",
        hint:
          "Read the screen with snapshot before sending anything else: the finished command's effect is already on the device."
      )
    )
  }

  private func encodeResponseJson(command: Command, response: Response) -> String? {
    guard command.traits.retainsJournalResponseJson else { return nil }
    guard let data = try? JSONEncoder().encode(response) else { return nil }
    guard data.count <= maxResponseJsonBytes else { return nil }
    return String(data: data, encoding: .utf8)
  }
}
