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
  /// Which execution of this `commandId` the record belongs to, minted when the id was claimed. The
  /// transport answers joiners from it, so a delivery reaches only the sends that joined the execution that
  /// closed. It has to outlive the entry's close: an id the runner refused before dispatch is claimed
  /// again, and the sends of that new execution must not be answered by the delivery of the refusal that
  /// freed the id.
  let executionToken: Int
}

/// The journal's verdict on one command that carries a `commandId`.
enum RunnerCommandAdmission {
  /// Nothing is running for this id and nothing has finished: the caller owns the one execution,
  /// identified by `executionToken` for as long as that claim answers for it.
  case execute(executionToken: Int)
  /// An execution is claimed and has not finished: the caller runs nothing and is answered by that
  /// execution, the one `executionToken` names. `accept(command:registeringJoin:)` has already
  /// registered the send it gave this verdict.
  case join(executionToken: Int)
  /// Execution finished, and the work reached the device: the caller answers from the journal and
  /// never executes this command again. `answersShutdown` says whether the answer being handed over is
  /// the runner's own successful `shutdown` answer, which the caller owes the runner's end. Neither the
  /// repeat's request nor the command name alone can answer that: a caller may reuse a spent `commandId`
  /// under another command name, and the live path withholds the finish from a `shutdown` that threw.
  case terminal(outcome: Response, answersShutdown: Bool)
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
  /// Mints the identity of each claim, so a delivery can tell the sends that joined its own execution from
  /// the sends that joined a later one under the same `commandId`.
  private var nextExecutionToken = 0

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
    registeringJoin register: (Int) -> Void = { _ in }
  ) -> RunnerCommandAdmission {
    lock.lock()
    defer { lock.unlock() }
    guard let commandId = command.commandId?.trimmedNonEmpty else {
      // No `commandId`, so nothing to settle and no other send can share this claim.
      return .execute(executionToken: mintExecutionToken())
    }
    guard let entry = entries[commandId] else {
      // The entry can be pruned; the fact it recorded is not, so an id that spent itself on the device
      // never executes again. Only the entry named the command, so this refusal can name only what the
      // repeat asked for.
      if closedCommandIds.contains(commandId) {
        // The record that named this id is gone, so all this refusal can promise is that the id is
        // spent — it is no command's answer, and so never the runner's own.
        return .terminal(
          outcome: alreadyFinishedRefusal(command: command, commandId: commandId, outcomeDropped: true),
          answersShutdown: false
        )
      }
      return claim(command: command, commandId: commandId)
    }
    if !entry.state.isTerminal {
      let executionToken = entry.executionToken
      register(executionToken)
      return .join(executionToken: executionToken)
    }
    // Nothing of this command ever reached the device, so the id carries no effect to protect and the
    // send that reuses it is that command's own first execution.
    guard entry.dispatched else {
      return claim(command: command, commandId: commandId)
    }
    let outcome = recordedOutcome(for: entry)
    // Only a recorded `shutdown` that succeeded ends the runner. The live path withholds that finish from
    // a `shutdown` that threw, so replaying its refusal must not stop a runner whose caller is still
    // holding it for another command.
    return .terminal(
      outcome: outcome,
      answersShutdown: entry.command == CommandType.shutdown.rawValue && outcome.ok
    )
  }

  /// Mints a claim identity. Callers hold the journal's lock, except for the no-`commandId` route, which
  /// needs no entry and only asks for a value no other claim carries.
  private func mintExecutionToken() -> Int {
    nextExecutionToken += 1
    return nextExecutionToken
  }

  func start(command: Command) {
    transition(command: command, reorders: true) { entry in
      entry.state = .started
    }
  }

  /// Records that this command's work was handed to the device, as opposed to being refused while it
  /// was still queued. Until this point a refusal owes the caller a retry of the same `commandId`.
  func finish(command: Command, response: Response) {
    transition(command: command, reorders: true) { entry in
      entry.state = response.ok ? .completed : .failed
      entry.responseOk = response.ok
      entry.responseJson = encodeResponseJson(command: command, response: response)
      entry.error = response.error
    }
  }

  /// Records the failure that ended this command's execution. The typed wire code goes with it, the
  /// same one the transport puts on the live reply for the same throw: a repeat of this `commandId` is
  /// answered from this record, and a failure that arrives without its code reads to the daemon as an
  /// ordinary served refusal — which for a `MAIN_THREAD_TIMEOUT` would report the main thread drained
  /// when the command that just timed out is what occupied it.
  func fail(command: Command, error: Error) {
    let payload = ErrorPayload(
      code: RunnerTests.wireErrorCode(for: error),
      message: error.localizedDescription
    )
    transition(command: command, reorders: true) { entry in
      entry.state = .failed
      entry.error = payload
    }
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
    let executionToken = mintExecutionToken()
    entries[commandId] = RunnerCommandJournalEntry(
      commandId: commandId,
      command: command.command.rawValue,
      state: .accepted,
      responseOk: nil,
      responseJson: nil,
      error: nil,
      executionToken: executionToken
    )
    order.removeAll { $0 == commandId }
    order.append(commandId)
    pruneIfNeeded()
    return .execute(executionToken: executionToken)
  }

  /// Records that this command's work was handed to the device, as opposed to being refused while it
  /// was still queued. Until this point a refusal owes the caller a retry of the same `commandId`. Only
  /// the mark moves: the entry keeps its place in the retention order, which is claim order, and the
  /// state `start` already wrote is what `status` reports for a running command.
  func markDispatched(command: Command) {
    transition(command: command, reorders: false) { entry in
      entry.dispatched = true
    }
  }

  /// Applies one transition to the record this command's id holds. A transition for an id the journal does
  /// not hold describes work it never claimed, and one for an entry that already finished restates a
  /// closed outcome: neither may open a record again. Re-opening one would report `accepted` or `started`
  /// for work that is not running, and the daemon holds that verdict as an in-flight exchange on a runner
  /// it would otherwise hand off. `reorders` is what settling does: an entry that finishes goes to the back
  /// of the retention order, which records claim order.
  private func transition(
    command: Command,
    reorders: Bool,
    _ mutate: (inout RunnerCommandJournalEntry) -> Void
  ) {
    guard let commandId = command.commandId?.trimmedNonEmpty else { return }
    lock.lock()
    defer { lock.unlock() }
    guard var entry = entries[commandId], !entry.state.isTerminal else { return }
    mutate(&entry)
    entries[commandId] = entry
    guard reorders else { return }
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
        // The two closed-id structures stay one-to-one, and nothing here needs a duplicate check to keep
        // them that way: an id enters `closedCommandIds` only in this branch, and an id whose entry this
        // journal no longer holds can be claimed again only once the marker is gone — which the valve
        // below does by removing the id from both structures together. So a second close of a released id
        // finds an id in neither structure, and one still marked can never have an entry to prune.
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
