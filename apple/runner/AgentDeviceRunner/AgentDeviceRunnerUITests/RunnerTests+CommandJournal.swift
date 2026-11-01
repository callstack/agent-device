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
  /// An execution is claimed and has not finished: the caller runs nothing and is answered by that
  /// execution. `accept(command:registeringJoin:)` has already registered the send it gave this verdict.
  case join
  /// Execution finished, and the work reached the device: the caller answers from the journal and
  /// never executes this command again.
  case terminal(outcome: Response)
}

/// The runner's one command-lifecycle record: what it holds for a `commandId`, whether that id may run,
/// and what `status` answers for it. The transport asks this type before enqueuing anything, so one
/// `commandId` is executed at most once in a runner process, and a command that already finished cannot be
/// replayed onto the device by a repeat that arrives after its answer was delivered. The one release is
/// `closedCommandIdSafetyValve`, and `pruneIfNeeded` states the bound it leaves.
final class RunnerCommandJournal {
  private let lock = NSLock()
  private let maxEntries = 64
  /// Memory safety valve on closed-id retention, not an admission boundary: the journal keeps a closed
  /// id as long as it runs, and this only stops a runner from growing without limit. It is 64x the entry
  /// window because a marker holds no outcome body, only the id. Tests read it rather than repeat it.
  static let closedCommandIdSafetyValve = 4096
  private let maxResponseJsonBytes = 16 * 1024
  private var entries: [String: RunnerCommandJournalEntry] = [:]
  private var order: [String] = []
  /// Ids whose dispatched execution closed and whose entry has since been pruned: the admission half of
  /// what the entry recorded, kept without a body so bounded memory cannot make a spent id executable
  /// again. It settles admission only. `status` still answers `notAccepted` for such an id, because the
  /// outcome the entry held is gone and only the entry can report one. Retention ends only at the safety
  /// valve above: an id older than that can be admitted again, and `pruneIfNeeded` states that bound.
  private var closedCommandIds: Set<String> = []
  private var closedOrder: [String] = []

  /// Settles one send, and when the answer is to join a running execution, registers that send for the
  /// answer inside the same locked operation. No transition can close the entry between the two, which is
  /// what keeps a joined send from waiting on a delivery that already went out. `register` runs on the
  /// calling thread while the journal's lock is held: it may take a lock of its own, and must not call
  /// back into this journal. The wire route passes one; a caller that only reads the verdict — a journal
  /// test, or a probe that will not itself answer for the execution — leaves it unregistered and must not
  /// treat a `.join` verdict as a send that will be answered.
  @discardableResult
  func accept(
    command: Command,
    registeringJoin register: (String) -> Void = { _ in }
  ) -> RunnerCommandAdmission {
    guard let commandId = command.commandId?.trimmedNonEmpty else { return .execute }
    lock.lock()
    defer { lock.unlock() }
    guard let entry = entries[commandId] else {
      // The entry can be pruned; the fact it recorded is not, so an id that spent itself on the device
      // never executes again.
      if closedCommandIds.contains(commandId) {
        return .terminal(outcome: alreadyFinishedRefusal(command: command, commandId: commandId, outcomeDropped: true))
      }
      return claim(command: command, commandId: commandId)
    }
    if !entry.state.isTerminal {
      register(commandId)
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

  /// Records the failure that ended this command's execution. The typed wire code goes with it, the
  /// same one the transport puts on the live reply for the same throw: a repeat of this `commandId` is
  /// answered from this record, and a failure that arrives without its code reads to the daemon as an
  /// ordinary served refusal — which for a `MAIN_THREAD_TIMEOUT` would report the main thread drained
  /// when the command that just timed out is what occupied it.
  func fail(command: Command, error: Error) {
    update(
      command: command,
      state: .failed,
      responseOk: nil,
      responseJson: nil,
      error: ErrorPayload(
        code: RunnerTests.wireErrorCode(for: error),
        message: error.localizedDescription
      ),
      marksDispatched: false
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

  /// Drops the oldest closed entries, keeping each one's id as the fact that settles admission for it.
  /// An entry whose execution is claimed but not finished is never dropped, however deep the backlog:
  /// `status` answers `notAccepted` only for an id this journal does not hold, and the daemon cannot read
  /// that as a safe terminal state — it would invalidate a session whose runner is still executing the
  /// command it lost the answer to.
  private func pruneIfNeeded() {
    while order.count > maxEntries {
      guard let removable = order.first(where: { entries[$0]?.state.isTerminal == true }) else {
        return
      }
      order.removeAll { $0 == removable }
      // Only work that reached the device spends its id. A pruned refusal leaves the id free, which is
      // what the busy resend of the same `commandId` depends on (ADR 0005).
      if entries[removable]?.dispatched == true {
        closedCommandIds.insert(removable)
        closedOrder.append(removable)
        while closedOrder.count > Self.closedCommandIdSafetyValve {
          // The safety valve is the one place a spent id returns to circulation: a resend more than
          // 4096 completed dispatches later, within this runner process, can re-execute. A runner
          // restart starts a new journal, which answers `notAccepted` for every id.
          closedCommandIds.remove(closedOrder.removeFirst())
        }
      }
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
    return alreadyFinishedRefusal(
      commandId: entry.commandId,
      commandName: entry.command,
      outcomeDropped: false
    )
  }

  private func alreadyFinishedRefusal(
    command: Command,
    commandId: String,
    outcomeDropped: Bool
  ) -> Response {
    alreadyFinishedRefusal(
      commandId: commandId,
      commandName: command.command.rawValue,
      outcomeDropped: outcomeDropped
    )
  }

  private func alreadyFinishedRefusal(
    commandId: String,
    commandName: String,
    outcomeDropped: Bool
  ) -> Response {
    // Two whole messages rather than one sentence spliced into another: which record is gone is the
    // fact the caller acts on, so each variant has to read as a sentence on its own.
    let reason =
      outcomeDropped
      ? "The runner already finished \(commandName) with id \(commandId). That command's recorded outcome has since been dropped from the journal, so there is no response to replay."
      : "The runner already finished \(commandName) with id \(commandId) and kept no response to replay."
    return Response(
      ok: false,
      error: ErrorPayload(
        code: RunnerTests.RunnerWireErrorCode.commandAlreadyFinished,
        message: reason,
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
