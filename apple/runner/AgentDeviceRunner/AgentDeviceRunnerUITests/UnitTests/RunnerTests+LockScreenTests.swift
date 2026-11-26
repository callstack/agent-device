import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
/// Scripted device steps for one lock-screen transition: successive state reads (the last one
/// repeats), a deadline that allows `waitsAllowed` waits, and a log of what ran in which order.
private final class LockScreenScript {
  var reads: [LockScreenStateRead]
  var surfaceReads: [Bool]
  var passcodePrompt = false
  var waitsAllowed: Int
  var dispatchRefusal: Response?
  private(set) var log: [String] = []

  init(reads: [LockScreenStateRead], surfaceReads: [Bool] = [true], waitsAllowed: Int = 0) {
    self.reads = reads
    self.surfaceReads = surfaceReads
    self.waitsAllowed = waitsAllowed
  }

  var dispatches: Int { log.filter { $0 == "dispatch" }.count }
  var waits: Int { log.filter { $0 == "wait" }.count }

  var steps: LockScreenTransitionSteps {
    LockScreenTransitionSteps(
      readState: {
        self.log.append("read")
        return self.reads.count > 1 ? self.reads.removeFirst() : self.reads[0]
      },
      dispatch: {
        self.log.append("dispatch")
        return self.dispatchRefusal
      },
      lockScreenSurfaceIsVisible: {
        self.log.append("surface")
        return self.surfaceReads.count > 1 ? self.surfaceReads.removeFirst() : self.surfaceReads[0]
      },
      passcodePromptIsVisible: {
        self.log.append("passcode")
        return self.passcodePrompt
      },
      shouldContinue: { self.waits < self.waitsAllowed },
      wait: { self.log.append("wait") },
      startVerificationWindow: { self.log.append("window") }
    )
  }
}

extension RunnerTests {
  func testLockScreenStatusReadsAnyNonzeroLockStateAsLocked() {
    for state: UInt64 in [1, 2] {
      let response = lockScreenStatusResponse(.success(state))
      XCTAssertTrue(response.ok)
      XCTAssertEqual(response.data?.locked, true)
    }
  }

  func testLockScreenStatusReadsAZeroLockStateAsUnlocked() {
    let response = lockScreenStatusResponse(.success(0))
    XCTAssertTrue(response.ok)
    XCTAssertEqual(response.data?.locked, false)
  }

  func testLockScreenStatusRefusesAnUnreadableState() {
    let response = lockScreenStatusResponse(
      .failure(LockScreenNotifyError("Unable to read com.apple.springboard.lockstate"))
    )
    XCTAssertFalse(response.ok)
    XCTAssertNil(response.data?.locked)
    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.observationUnavailable)
  }

  func testLockScreenLeavesAnAlreadyLockedScreenAlone() {
    let script = LockScreenScript(reads: [.locked])
    let response = executeLockScreenTransition(lock: true, steps: script.steps)
    XCTAssertTrue(response.ok)
    XCTAssertEqual(script.dispatches, 0)
  }

  func testUnlockScreenLeavesAnAlreadyUnlockedScreenAlone() {
    let script = LockScreenScript(reads: [.unlocked])
    let response = executeLockScreenTransition(lock: false, steps: script.steps)
    XCTAssertTrue(response.ok)
    XCTAssertEqual(script.dispatches, 0)
  }

  /// The window opens only once the dispatch returned, and a dispatch that used up the whole window
  /// is still followed by a read rather than a timeout.
  func testLockScreenReadsAfterADispatchThatOutlastedTheWindow() {
    let script = LockScreenScript(reads: [.unlocked, .locked], waitsAllowed: 0)
    let response = executeLockScreenTransition(lock: true, steps: script.steps)
    XCTAssertTrue(response.ok, response.error?.message ?? "")
    XCTAssertEqual(Array(script.log.prefix(4)), ["read", "dispatch", "window", "read"])
  }

  func testLockScreenReadsAgainAfterTheLastWait() {
    let script = LockScreenScript(reads: [.unlocked, .unlocked, .locked], waitsAllowed: 1)
    let response = executeLockScreenTransition(lock: true, steps: script.steps)
    XCTAssertTrue(response.ok, response.error?.message ?? "")
    XCTAssertEqual(script.waits, 1)
  }

  func testUnlockScreenReportsUnverifiedWhenTheScreenStaysLocked() {
    let script = LockScreenScript(reads: [.locked], waitsAllowed: 2)
    let response = executeLockScreenTransition(lock: false, steps: script.steps)
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.lockScreenUnverified)
    XCTAssertEqual(script.dispatches, 1)
    XCTAssertEqual(script.waits, 2)
    XCTAssertEqual(script.log.last, "passcode", "the last wait is followed by a read")
  }

  func testUnlockScreenRefusesAPasscodePromptWithoutWaitingOutTheWindow() {
    let script = LockScreenScript(reads: [.locked], waitsAllowed: 5)
    script.passcodePrompt = true
    let response = executeLockScreenTransition(lock: false, steps: script.steps)
    XCTAssertFalse(response.ok)
    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.lockScreenSecure)
    XCTAssertEqual(script.waits, 0)
  }

  /// A screen SpringBoard reports unlocked but blanked shows nothing, so unlock still dispatches.
  func testUnlockScreenWakesAnUnlockedScreenThatIsOff() {
    let script = LockScreenScript(reads: [.unlockedScreenOff, .unlocked])
    let response = executeLockScreenTransition(lock: false, steps: script.steps)
    XCTAssertTrue(response.ok, response.error?.message ?? "")
    XCTAssertEqual(script.dispatches, 1)
  }

  func testUnlockScreenRefusesAScreenThatStaysOff() {
    let script = LockScreenScript(reads: [.locked, .unlockedScreenOff], waitsAllowed: 2)
    script.passcodePrompt = true
    let response = executeLockScreenTransition(lock: false, steps: script.steps)
    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.lockScreenUnverified)
    XCTAssertEqual(script.log.filter { $0 == "passcode" }.count, 0, "an unlocked screen asks for no passcode")
  }

  /// A dark screen is woken first; the lock button is pressed again only if the wake left it unlocked.
  func testLockScreenWakesADarkScreenAndPressesAgainOnlyWhileUnlocked() {
    for (afterWake, presses) in [(LockScreenStateRead.unlocked, 1), (.locked, 0)] {
      var log: [String] = []
      let refusal = dispatchLock(
        screenIsBlanked: { true },
        wake: { log.append("wake"); return nil },
        readState: { afterWake },
        press: { log.append("press"); return nil }
      )
      XCTAssertNil(refusal)
      XCTAssertEqual(log, ["wake"] + Array(repeating: "press", count: presses), "\(afterWake)")
    }
  }

  func testLockScreenPressesALitScreenOnceWithoutWaking() {
    var log: [String] = []
    let refusal = dispatchLock(
      screenIsBlanked: { false },
      wake: { log.append("wake"); return nil },
      readState: { .unlocked },
      press: { log.append("press"); return nil }
    )
    XCTAssertNil(refusal)
    XCTAssertEqual(log, ["press"])
  }

  func testLockScreenPropagatesAWakeRefusalWithoutPressing() {
    var presses = 0
    let refusal = dispatchLock(
      screenIsBlanked: { true },
      wake: {
        Response(ok: false, error: ErrorPayload(
          code: RunnerWireErrorCode.hardwareControlUnavailable,
          message: "no lock button"
        ))
      },
      readState: { .unlocked },
      press: { presses += 1; return nil }
    )
    XCTAssertEqual(refusal?.error?.code, RunnerWireErrorCode.hardwareControlUnavailable)
    XCTAssertEqual(presses, 0)
  }

  func testLockScreenNeverAsksForAPasscodePrompt() {
    let script = LockScreenScript(reads: [.unlocked], waitsAllowed: 1)
    script.passcodePrompt = true
    let response = executeLockScreenTransition(lock: true, steps: script.steps)
    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.lockScreenUnverified)
    XCTAssertFalse(script.log.contains("passcode"))
  }

  func testLockScreenPropagatesADispatchRefusalWithoutPolling() {
    let script = LockScreenScript(reads: [.unlocked], waitsAllowed: 5)
    script.dispatchRefusal = Response(ok: false, error: ErrorPayload(
      code: RunnerWireErrorCode.hardwareControlUnavailable,
      message: "no lock button"
    ))
    let response = executeLockScreenTransition(lock: true, steps: script.steps)
    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.hardwareControlUnavailable)
    XCTAssertEqual(script.log, ["read", "dispatch"])
  }

  func testLockScreenRefusesAnUnreadableStateBeforeDispatch() {
    let script = LockScreenScript(reads: [.unreadable("notify failed")])
    let response = executeLockScreenTransition(lock: true, steps: script.steps)
    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.observationUnavailable)
    XCTAssertEqual(script.dispatches, 0)
  }

  func testLockScreenReportsAnUnreadableStateAfterDispatchAsUnverified() {
    let script = LockScreenScript(reads: [.unlocked, .unreadable("notify failed")], waitsAllowed: 5)
    let response = executeLockScreenTransition(lock: true, steps: script.steps)
    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.lockScreenUnverified)
    XCTAssertEqual(script.dispatches, 1)
  }

  func testLockScreenWaitsForTheLockScreenSurface() {
    let script = LockScreenScript(reads: [.unlocked, .locked], surfaceReads: [false, true], waitsAllowed: 1)
    let response = executeLockScreenTransition(lock: true, steps: script.steps)
    XCTAssertTrue(response.ok, response.error?.message ?? "")
    XCTAssertEqual(script.waits, 1)
  }

  func testLockScreenRefusesALockStateWithNoLockScreenSurface() {
    let script = LockScreenScript(reads: [.locked], surfaceReads: [false], waitsAllowed: 2)
    let response = executeLockScreenTransition(lock: true, steps: script.steps)
    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.lockScreenUnverified)
    XCTAssertEqual(script.dispatches, 0)
  }

  func testLockScreenRefusesAScreenThatUnlocksWhileTheSurfaceIsAwaited() {
    let script = LockScreenScript(
      reads: [.unlocked, .locked, .locked, .unlocked],
      surfaceReads: [false],
      waitsAllowed: 5
    )
    let response = executeLockScreenTransition(lock: true, steps: script.steps)
    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.lockScreenUnverified)
    XCTAssertEqual(script.waits, 1)
  }
}
#endif
