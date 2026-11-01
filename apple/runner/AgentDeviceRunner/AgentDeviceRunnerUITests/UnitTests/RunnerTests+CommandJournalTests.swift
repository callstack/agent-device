import Foundation
import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testUptimeBypassesCommandJournal() throws {
    let command = runnerJournalCommand("uptime", id: "uptime-probe")

    let response = try execute(command: command)
    let status = commandJournal.status(normalizedCommandId: "uptime-probe")

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

  func testStampingCurrentMainThreadBusyPreservesPayload() {
    let stamped = Response(ok: true, data: DataPayload(nodes: [], truncated: false))
      .stampingCurrentMainThreadBusy(true)

    XCTAssertEqual(stamped.ok, true)
    XCTAssertEqual(stamped.data?.runnerMainThreadBusy, true)
  }

  func testStampingCurrentMainThreadBusySkipsErrorResponses() {
    let response = Response(ok: false, error: ErrorPayload(code: "RUNNER_BUSY", message: "busy"))
    let stamped = response.stampingCurrentMainThreadBusy(true)

    XCTAssertEqual(stamped.ok, false)
    XCTAssertNil(stamped.data)
    XCTAssertEqual(stamped.error?.code, "RUNNER_BUSY")
  }

  func testMainThreadBusyStateReportsOccupancy() {
    XCTAssertFalse(MainThreadBusyState.idle.reportsMainThreadBusy)
    XCTAssertTrue(MainThreadBusyState.busy(abandonedForSeconds: 5).reportsMainThreadBusy)
    XCTAssertTrue(MainThreadBusyState.wedged(abandonedForSeconds: 200).reportsMainThreadBusy)
    XCTAssertEqual(
      Response(ok: true).stampingCurrentMainThreadBusy(false).data?.runnerMainThreadBusy, false)
  }

  func testCommandFailedResponseTagsMainThreadTimeoutWithTypedCode() {
    let timeout = NSError(
      domain: RunnerErrorDomain.general,
      code: RunnerErrorCode.mainThreadExecutionTimedOut,
      userInfo: [NSLocalizedDescriptionKey: "main thread execution timed out"]
    )

    let response = commandFailedResponse(from: timeout)

    XCTAssertEqual(response.ok, false)
    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.mainThreadTimeout)
  }

  func testCommandFailedResponseKeepsGenericCodeForOtherErrors() {
    let other = NSError(domain: "SomeOtherDomain", code: 99, userInfo: nil)

    let response = commandFailedResponse(from: other)

    XCTAssertEqual(response.error?.code, "COMMAND_FAILED")
  }

  func testJournalStoredResponseStaysUnstamped() throws {
    let journal = RunnerCommandJournal()
    let recordStart = runnerJournalCommand("recordStart", id: "record-start-anchor")

    journal.accept(command: recordStart)
    journal.finish(
      command: recordStart,
      response: Response(ok: true, data: DataPayload(message: "recording started"))
    )

    let status = journal.status(normalizedCommandId: "record-start-anchor")
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

    let scalarStatus = journal.status(normalizedCommandId: "small-scalar")
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

    let objectStatus = journal.status(normalizedCommandId: "small-object")
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

    let snapshotStatus = journal.status(normalizedCommandId: "snapshot-tree")
    XCTAssertEqual(snapshotStatus.lifecycleState, RunnerCommandLifecycleState.completed.rawValue)
    XCTAssertEqual(snapshotStatus.lifecycleResponseOk, true)
    XCTAssertNil(snapshotStatus.lifecycleResponseJson)

    let screenshot = runnerJournalCommand("screenshot", id: "screenshot-artifact")
    journal.accept(command: screenshot)
    journal.finish(
      command: screenshot,
      response: Response(ok: true, data: DataPayload(message: "tmp/screenshot-1.png"))
    )

    let screenshotStatus = journal.status(normalizedCommandId: "screenshot-artifact")
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

    let scrollStatus = journal.status(normalizedCommandId: "scroll-drag")
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

    let largeReadStatus = journal.status(normalizedCommandId: "large-read")
    XCTAssertEqual(largeReadStatus.lifecycleState, RunnerCommandLifecycleState.completed.rawValue)
    XCTAssertEqual(largeReadStatus.lifecycleResponseOk, true)
    XCTAssertNil(largeReadStatus.lifecycleResponseJson)
  }

  /// Fills the 64-entry retention window the way a busy session does: closed commands, oldest first. The
  /// transport's own retention tests need the same pressure, so this is the one implementation.
  /// `dispatched` decides whether that work reached the device, which is what spends an id.
  func runnerJournalFinishOtherCommands(
    _ journal: RunnerCommandJournal,
    _ count: Int,
    idPrefix: String = "settled",
    dispatched: Bool = false
  ) {
    for index in 0..<count {
      let settled = runnerJournalCommand("recordStop", id: "\(idPrefix)-\(index)")
      journal.accept(command: settled)
      if dispatched {
        journal.markDispatched(command: settled)
      }
      journal.finish(
        command: settled,
        response: Response(ok: true, data: DataPayload(text: "x"))
      )
    }
  }

  /// The 64-entry window must never cost the runner the ability to answer "is this command still
  /// running?". A queued or executing command is the one entry pruning may not drop: `status` reports
  /// `notAccepted` for an id it does not hold, and the daemon cannot read that as a safe terminal
  /// state, so a snapshot burst behind one slow command would push the daemon to invalidate the session
  /// of a runner that is still executing that command.
  func testJournalKeepsAnExecutingCommandQueryablePastTheRetentionWindow() throws {
    let journal = RunnerCommandJournal()
    let running = runnerJournalCommand("tap", id: "running-tap")
    journal.accept(command: running)
    journal.start(command: running)

    runnerJournalFinishOtherCommands(journal, 64)

    let status = journal.status(normalizedCommandId: "running-tap")
    XCTAssertEqual(
      status.lifecycleState,
      RunnerCommandLifecycleState.started.rawValue,
      "a command the runner is still executing must stay queryable however many settled entries arrive"
    )
  }

  /// A transition for an id the journal no longer holds says nothing about a command the runner is
  /// running: it has no record to advance. Re-opening one would report `started` for work nobody
  /// enqueued, which the daemon holds as an in-flight exchange it must wait out or invalidate on.
  func testJournalDoesNotInventAnEntryForAPrunedCommandId() throws {
    let journal = RunnerCommandJournal()
    let early = runnerJournalCommand("tap", id: "pruned-tap")
    journal.accept(command: early)
    journal.finish(
      command: early,
      response: Response(ok: true, data: DataPayload(message: "tapped"))
    )
    runnerJournalFinishOtherCommands(journal, 64)
    XCTAssertEqual(
      journal.status(normalizedCommandId: "pruned-tap").lifecycleState,
      RunnerCommandLifecycleState.notAccepted.rawValue
    )

    journal.start(command: early)

    XCTAssertEqual(
      journal.status(normalizedCommandId: "pruned-tap").lifecycleState,
      RunnerCommandLifecycleState.notAccepted.rawValue,
      "a late transition for a pruned id must not report it as running"
    )
  }

  /// Closes one command whose work reached the device, which is what spends its id. Both closed-id tests
  /// need the same opening, so this is the one implementation.
  private func runnerJournalCloseDispatchedCommand(
    _ journal: RunnerCommandJournal,
    _ command: Command,
    message: String
  ) {
    journal.accept(command: command)
    journal.markDispatched(command: command)
    journal.finish(command: command, response: Response(ok: true, data: DataPayload(message: message)))
  }

  /// Bounded memory has to drop something, and what it may drop is the outcome body, never the fact that
  /// the id was spent. Otherwise the retention window itself becomes the bug the journal exists to
  /// prevent: finish a dispatched tap, let 64 later commands push its entry out, and a delayed resend of
  /// that tap would be admitted as a new execution and tap the device a second time.
  func testJournalNeverReAdmitsAPrunedCommandsId() throws {
    let journal = RunnerCommandJournal()
    let tap = runnerJournalCommand("tap", id: "spent-tap")
    runnerJournalCloseDispatchedCommand(journal, tap, message: "tapped")
    runnerJournalFinishOtherCommands(journal, 64)

    guard case .terminal(let outcome, _) = journal.accept(command: tap) else {
      return XCTFail("a pruned id whose work reached the device must never be admitted again")
    }
    XCTAssertFalse(outcome.ok)
    XCTAssertEqual(
      outcome.error?.code,
      RunnerTests.RunnerWireErrorCode.commandAlreadyFinished,
      "the pruned id's outcome body is gone, so the answer is the typed refusal, got \(String(describing: outcome.error?.code))"
    )
  }

  /// The closed-id window is a memory safety valve, not an admission boundary: a running journal keeps a
  /// spent id, and the valve exists only so a runner cannot grow without limit. The rule it enforces is
  /// therefore exact, and these are both halves of it: a spent id is refused for the whole window, and the
  /// only id the valve releases is the oldest one, when a close fills the window past it. An id released
  /// there is one whose command completed more than `closedCommandIdSafetyValve` dispatched commands
  /// earlier, within this runner process, which is the residual bound ADR 0005 states.
  func testJournalRefusesASpentIdAcrossTheClosedIdWindowAndReleasesOnlyTheOldest() throws {
    let journal = RunnerCommandJournal()
    let tap = runnerJournalCommand("tap", id: "spent-tap")
    runnerJournalCloseDispatchedCommand(journal, tap, message: "tapped")

    // The first 63 closes only fill the 64-entry window and leave no marker; every close after them adds
    // exactly one. This leaves the safety valve exactly full, with `spent-tap` at its front.
    runnerJournalFinishOtherCommands(
      journal,
      RunnerCommandJournal.closedCommandIdSafetyValve + 63,
      idPrefix: "window",
      dispatched: true
    )
    guard case .terminal(let refusal, _) = journal.accept(command: tap) else {
      return XCTFail("a spent id must stay refused for the whole closed-id window")
    }
    XCTAssertEqual(
      refusal.error?.code,
      RunnerTests.RunnerWireErrorCode.commandAlreadyFinished,
      "the last close inside the window must still refuse the spent id"
    )

    // One more dispatched close fills the window, and the valve moves on by exactly one id. That id
    // is checked first while asking about a neighbour cannot disturb it: admitting the released id
    // below claims an entry, which pressures the window to evict one more.
    runnerJournalFinishOtherCommands(journal, 1, idPrefix: "valve", dispatched: true)

    let nextOldest = runnerJournalCommand("recordStop", id: "window-0")
    guard case .terminal(let stillRefused, _) = journal.accept(command: nextOldest) else {
      return XCTFail("the valve must release the oldest closed id only, not the next-oldest")
    }
    XCTAssertEqual(
      stillRefused.error?.code,
      RunnerTests.RunnerWireErrorCode.commandAlreadyFinished,
      "one close past the valve releases exactly one id"
    )

    guard case .execute = journal.accept(command: tap) else {
      return XCTFail("the valve must release exactly the oldest closed id")
    }
  }

  /// The one id pruning must leave free: a command the runner refused before dispatch left nothing on the
  /// device, and its read-only resend arrives with the same `commandId` (ADR 0005). A closed marker for it
  /// would refuse that resend and lose a command the runner never ran.
  func testJournalReAdmitsAPrunedIdWhoseExecutionNeverDispatched() throws {
    let journal = RunnerCommandJournal()
    let refused = runnerJournalCommand("recordStop", id: "refused-before-dispatch")
    journal.accept(command: refused)
    journal.finish(
      command: refused,
      response: Response(
        ok: false,
        error: ErrorPayload(code: "RUNNER_BUSY", message: "The iOS runner is still finishing a previous command.")
      )
    )
    runnerJournalFinishOtherCommands(journal, 64)

    XCTAssertEqual(
      journal.status(normalizedCommandId: "refused-before-dispatch").lifecycleState,
      RunnerCommandLifecycleState.notAccepted.rawValue,
      "the test must have pushed this refusal's own entry out of the window"
    )

    guard case .execute = journal.accept(command: refused) else {
      return XCTFail("an id the runner refused before dispatch carries no effect and must stay executable")
    }
  }

  /// The journal closes only ids whose execution began, so a `RUNNER_BUSY` refusal that dispatched
  /// nothing leaves the id executable once the runner is idle, and travels as the journal failure the
  /// status recovery classifies as `RUNNER_BUSY`. Scoped to journal admission: the daemon's same-id
  /// busy resend covers read-only commands (`index-busy-resend.test.ts`), and `recordStop` is here
  /// for its observable no-op answer, not for its class.
  func testJournalAdmitsAgainACommandIdRefusedBeforeDispatch() throws {
    let command = runnerJournalCommand("recordStop", id: "busy-then-idle")
    let installed = ScreenRecorder(outputPath: "", fps: 30)
    activeRecording = installed
    abandonedMainThreadWorkCount = 1
    abandonedMainThreadWorkSince = Date(timeIntervalSinceNow: -2)
    defer {
      abandonedMainThreadWorkCount = 0
      abandonedMainThreadWorkSince = nil
      activeRecording = nil
    }

    let refused = try execute(command: command)
    let refusalStatus = commandJournal.status(normalizedCommandId: "busy-then-idle")
    abandonedMainThreadWorkCount = 0
    abandonedMainThreadWorkSince = nil

    XCTAssertEqual(refused.error?.code, "RUNNER_BUSY")
    XCTAssertEqual(refusalStatus.lifecycleState, RunnerCommandLifecycleState.failed.rawValue)
    XCTAssertEqual(refusalStatus.lifecycleErrorCode, "RUNNER_BUSY")
    XCTAssertIdentical(activeRecording, installed, "a pre-dispatch refusal must not stop recording")
    activeRecording = nil

    let served = try execute(command: command)

    XCTAssertTrue(served.ok, "the refused commandId must run once the runner is idle, got \(String(describing: served.error?.code))")
    XCTAssertEqual(served.data?.message, "recording already stopped")
  }

  /// Whether `accept` reports that the answer it hands over is the runner's own `shutdown` answer.
  private func journalAnswersShutdown(
    _ journal: RunnerCommandJournal,
    command: Command
  ) -> Bool {
    switch journal.accept(command: command) {
    case .terminal(_, let answersShutdown):
      return answersShutdown
    case .execute:
      XCTFail("a finished, dispatched commandId must be answered from the journal")
      return false
    case .join:
      XCTFail("this test leaves no execution in flight")
      return false
    }
  }

  /// Which answer ends the runner is the journal's fact about the record, not the repeat's: a caller may
  /// reuse a spent `commandId` under another command name, and the outcome it receives stays the recorded
  /// command's. Naming `shutdown` in the repeat must not end the runner on some other command's answer,
  /// and naming another command must not withhold the end that a recorded `shutdown` answer owes.
  func testJournalDecidesFromTheRecordWhetherAReplayEndsTheRunner() throws {
    let journal = RunnerCommandJournal()
    let tap = runnerJournalCommand("tap", id: "spent-then-named-shutdown")
    journal.accept(command: tap)
    journal.markDispatched(command: tap)
    journal.finish(command: tap, response: Response(ok: true, data: DataPayload(message: "tapped")))

    guard case .terminal = journal.accept(command: runnerJournalCommand("snapshot", id: "spent-then-named-shutdown")) else {
      return XCTFail("renaming a spent mutation to a read must not bypass admission")
    }

    let shutdown = runnerJournalCommand("shutdown", id: "spent-then-named-shutdown")
    XCTAssertEqual(
      journalAnswersShutdown(journal, command: shutdown),
      false,
      "a recorded tap answer must not end the runner because the repeat named shutdown"
    )

    let shutdownId = "shutdown-then-named-tap"
    let realShutdown = runnerJournalCommand("shutdown", id: shutdownId)
    journal.accept(command: realShutdown)
    journal.markDispatched(command: realShutdown)
    journal.finish(
      command: realShutdown,
      response: Response(ok: true, data: DataPayload(message: "shutdown"))
    )
    XCTAssertEqual(
      journalAnswersShutdown(journal, command: runnerJournalCommand("tap", id: shutdownId)),
      true,
      "a recorded shutdown answer must still end the runner when the repeat names another command"
    )
  }

  /// The live path withholds the finish from a `shutdown` that threw, so a replay of that refusal has to
  /// withhold it too. A refused shutdown means the runner is still serving for its caller — ending it here
  /// would tear down the runner the resend is still talking to, on an answer that said it stayed up.
  func testJournalWithholdsTheFinishFromAReplayedFailedShutdown() throws {
    let journal = RunnerCommandJournal()
    let command = runnerJournalCommand("shutdown", id: "refused-shutdown")
    journal.accept(command: command)
    journal.markDispatched(command: command)
    journal.fail(command: command, error: Self.mainThreadExecutionTimeoutError())

    let replayed = journal.accept(command: command)
    guard case .terminal(let outcome, let answersShutdown) = replayed else {
      return XCTFail("a refused, dispatched shutdown must be answered from the journal")
    }
    XCTAssertEqual(outcome.ok, false, "the recorded refusal is what the repeat is answered with")
    XCTAssertEqual(
      answersShutdown,
      false,
      "a recorded shutdown refusal must not end the runner the caller still holds"
    )
  }

  /// The recorded failure has to carry the same code the live answer carried, because the daemon reads
  /// that code to decide whether the runner's main thread is still draining. A repeat of a command that
  /// timed out on the execution watchdog is answered from this record, and a failure stored without its
  /// code reaches the daemon as an ordinary served refusal: it would report the thread drained at the
  /// exact moment the timed-out command occupied it.
  func testJournalReplayOfAThrownFailureCarriesItsWholeErrorBody() throws {
    let journal = RunnerCommandJournal()
    let command = runnerJournalCommand("recordStop", id: "timed-out-then-repeated")
    journal.accept(command: command)
    journal.markDispatched(command: command)
    journal.fail(command: command, error: Self.mainThreadExecutionTimeoutError())
    // Nothing of a timed-out command is retained to replay, so the recorded failure is the only answer
    // a repeat can be given.
    XCTAssertEqual(
      journal.status(normalizedCommandId: "timed-out-then-repeated").lifecycleResponseJson,
      nil
    )

    guard case .terminal(let replay, _) = journal.accept(command: command) else {
      return XCTFail("a repeat of a finished, dispatched commandId is answered from the journal")
    }

    XCTAssertEqual(replay.ok, false)
    XCTAssertEqual(
      replay.error?.code,
      RunnerWireErrorCode.mainThreadTimeout,
      "a replayed failure must carry the code the live answer carried, got \(String(describing: replay.error?.code))"
    )
    // The hint is what a caller acts on, so the record has to hold the whole error body the live reply
    // carried, not just its code: this one is the watchdog's "wait and retry" advice. Compared with the
    // live reply for the same throw, so the two cannot drift without failing here.
    XCTAssertEqual(
      replay.error?.hint,
      commandFailedResponse(from: Self.mainThreadExecutionTimeoutError()).error?.hint,
      "a replayed failure must carry the hint the live answer carried"
    )
    XCTAssertEqual(
      journal.status(normalizedCommandId: "timed-out-then-repeated").lifecycleErrorCode,
      RunnerWireErrorCode.mainThreadTimeout,
      "`status` recovery reads the same record and must see the code too"
    )
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

    let status = journal.status(normalizedCommandId: "snapshot-error")
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

    let status = journal.status(normalizedCommandId: "sequence-completed")
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

    let status = journal.status(normalizedCommandId: "sequence-failed")
    XCTAssertEqual(status.lifecycleState, RunnerCommandLifecycleState.completed.rawValue)
    let decoded = try decodeRunnerJournalResponse(status.lifecycleResponseJson)
    XCTAssertEqual(decoded.data?.completedSteps, 2)
    XCTAssertEqual(decoded.data?.failedStepIndex, 2)
    XCTAssertEqual(decoded.data?.sequenceResults?.count, 3)
    XCTAssertEqual(decoded.data?.sequenceResults?[2].ok, false)
    XCTAssertEqual(decoded.data?.sequenceResults?[2].errorCode, "UNSUPPORTED_OPERATION")
  }

  func testJournalReexecutesFinishedReadsWithoutSpendingTheirIds() throws {
    for name in ["snapshot", "screenshot", "readText", "findText", "gestureViewport", "appState", "status", "alert"] {
      for failed in [false, true] {
        let journal = RunnerCommandJournal()
        let command = runnerJournalCommand(name, id: "repeated-read")
        journal.accept(command: command)
        journal.markDispatched(command: command)
        if failed {
          journal.fail(command: command, error: Self.mainThreadExecutionTimeoutError())
        } else {
          journal.finish(command: command, response: Response(ok: true, data: DataPayload(text: "first")))
        }
        guard case .execute = journal.accept(command: command) else {
          XCTFail("a finished \(name) read must execute again, including after a failure: \(failed)")
          continue
        }
        journal.markDispatched(command: command)
        journal.finish(command: command, response: Response(ok: true))
        runnerJournalFinishOtherCommands(journal, 64)
        XCTAssertEqual(journal.status(normalizedCommandId: "repeated-read").lifecycleState, "notAccepted")
        guard case .execute = journal.accept(command: command) else {
          XCTFail("a pruned \(name) read must leave no closed-id marker")
          continue
        }
      }
    }
  }

  func testJournalDoesNotSpendPrunedReadIds() throws {
    for name in ["snapshot", "screenshot", "readText", "alert"] {
      let journal = RunnerCommandJournal()
      let read = runnerJournalCommand(name, id: "pruned-read")
      runnerJournalCloseDispatchedCommand(journal, read, message: "read")
      runnerJournalFinishOtherCommands(journal, 64)
      XCTAssertEqual(journal.status(normalizedCommandId: "pruned-read").lifecycleState, "notAccepted")
      guard case .execute = journal.accept(command: read) else {
        XCTFail("pruning a \(name) read must leave its id reusable")
        continue
      }
    }
  }

  private func runnerJournalCommand(_ command: String, id: String) -> Command {
    let json = #"{"command":"\#(command)","commandId":"\#(id)"}"#
    return try! JSONDecoder().decode(Command.self, from: Data(json.utf8))
  }

  private func runnerJournalNode() -> PresentedNode {
    SnapshotPresentation.singleElementRead(
      RawAXNode(
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
    )
  }

  private func decodeRunnerJournalResponse(_ responseJson: String?) throws -> Response {
    let responseJson = try XCTUnwrap(responseJson)
    return try JSONDecoder().decode(Response.self, from: Data(responseJson.utf8))
  }
}
#endif
