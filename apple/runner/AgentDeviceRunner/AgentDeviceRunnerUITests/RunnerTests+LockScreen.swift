import Darwin
import XCTest

/// One read of SpringBoard's lock and screen state.
enum LockScreenStateRead: Equatable {
  case locked
  /// Unlocked with the screen on: the app in front is on screen.
  case unlocked
  /// Unlocked, but SpringBoard has blanked the screen, so nothing is on screen until it wakes.
  case unlockedScreenOff
  case unreadable(String)
}

/// A SpringBoard notify state that could not be read.
struct LockScreenNotifyError: Error {
  let message: String
  init(_ message: String) { self.message = message }
}

/// The device-facing steps of one `lockScreen` or `unlockScreen` transition, injected so the
/// verification rules are testable without a lock screen.
struct LockScreenTransitionSteps {
  let readState: () -> LockScreenStateRead
  /// Sends the lock button press or the unlock swipe; a response is a refusal before dispatch.
  let dispatch: () -> Response?
  /// Whether a Lock-Screen-specific surface is on screen. Only `lockScreen` reads it.
  let lockScreenSurfaceIsVisible: () -> Bool
  /// Whether SpringBoard asks for a passcode. Only `unlockScreen` reads it.
  let passcodePromptIsVisible: () -> Bool
  let shouldContinue: () -> Bool
  let wait: () -> Void
  /// Restarts the verification window once the dispatch has returned.
  let startVerificationWindow: () -> Void
}

extension RunnerTests {
  private static let springboardLockStateNotification = "com.apple.springboard.lockstate"
  private static let springboardBlankedScreenNotification = "com.apple.springboard.hasBlankedScreen"
  static let lockScreenVerificationTimeout: TimeInterval = 5
  static let lockScreenPollInterval: TimeInterval = 0.05

  /// Locks with XCUIDevice's lock button, or unlocks with a swipe up from the bottom edge, and
  /// answers only once SpringBoard's lock state reports the requested state. A lock also needs a
  /// Lock-Screen-specific surface on screen, and an unlock a screen that is on. A screen already
  /// in the requested state is left alone, and a passcode prompt is refused rather than answered.
  func executeLockScreenCommand(_ type: CommandType) -> Response {
#if os(iOS) && targetEnvironment(simulator)
    var deadline = Date().addingTimeInterval(Self.lockScreenVerificationTimeout)
    let lock = type == .lockScreen
    return executeLockScreenTransition(
      lock: lock,
      steps: LockScreenTransitionSteps(
        readState: currentLockScreenState,
        dispatch: lock ? dispatchLock : dispatchUnlock,
        lockScreenSurfaceIsVisible: lockScreenSurfaceIsVisible,
        passcodePromptIsVisible: passcodePromptIsVisible,
        shouldContinue: { Date() < deadline },
        wait: { RunLoop.current.run(until: Date().addingTimeInterval(Self.lockScreenPollInterval)) },
        startVerificationWindow: {
          deadline = Date().addingTimeInterval(Self.lockScreenVerificationTimeout)
        }
      )
    )
#else
    return Response(ok: false, error: ErrorPayload(
      code: RunnerWireErrorCode.hardwareControlUnavailable,
      message: "\(type.rawValue) is supported only on iPhone and iPad simulators",
      hint: "lock-screen locks iPhone and iPad simulators and Android phones and tablets."
    ))
#endif
  }

  /// The transition rules, independent of the device. The verification window starts only after
  /// the dispatch returned, and every wait is followed by a read, so a state SpringBoard reached
  /// during the last wait is never reported as a failure.
  func executeLockScreenTransition(lock: Bool, steps: LockScreenTransitionSteps) -> Response {
    let target: LockScreenStateRead = lock ? .locked : .unlocked
    switch steps.readState() {
    case target:
      return lockScreenReachedResponse(lock: lock, steps: steps)
    case .unreadable(let message):
      return Response(ok: false, error: ErrorPayload(
        code: RunnerWireErrorCode.observationUnavailable,
        message: message
      ))
    default:
      break
    }
    if let refusal = steps.dispatch() { return refusal }
    steps.startVerificationWindow()
    while true {
      switch steps.readState() {
      case target:
        return lockScreenReachedResponse(lock: lock, steps: steps)
      case .unreadable(let message):
        return lockScreenUnverifiedResponse(message)
      case .locked where !lock:
        if steps.passcodePromptIsVisible() { return passcodeRefusal() }
      default:
        break
      }
      guard steps.shouldContinue() else { break }
      steps.wait()
    }
    return lockScreenUnverifiedResponse(
      lock
        ? "XCTest pressed the simulator lock button, but SpringBoard still reports the screen unlocked"
        : "The unlock swipe was sent, but SpringBoard still reports the screen locked"
    )
  }

  /// SpringBoard reports the requested state. An unlock needs nothing more. A lock also needs a
  /// Lock-Screen-specific surface, and the lock state must hold while that surface is awaited.
  private func lockScreenReachedResponse(lock: Bool, steps: LockScreenTransitionSteps) -> Response {
    guard lock else { return Response(ok: true, data: DataPayload(message: "unlockScreen")) }
    while true {
      switch steps.readState() {
      case .locked:
        if steps.lockScreenSurfaceIsVisible() {
          return Response(ok: true, data: DataPayload(message: "lockScreen"))
        }
      case .unlocked, .unlockedScreenOff:
        return lockScreenUnverifiedResponse(
          "SpringBoard reported the screen unlocked again while the lock screen was awaited"
        )
      case .unreadable(let message):
        return lockScreenUnverifiedResponse(message)
      }
      guard steps.shouldContinue() else { break }
      steps.wait()
    }
    return lockScreenUnverifiedResponse(
      "SpringBoard reports the screen locked, but no lock screen surface is on screen"
    )
  }

  private func lockScreenUnverifiedResponse(_ message: String) -> Response {
    Response(ok: false, error: ErrorPayload(
      code: RunnerWireErrorCode.lockScreenUnverified,
      message: message,
      hint: "Take a screenshot to see the screen, then retry lock-screen."
    ))
  }

  private func passcodeRefusal() -> Response {
    Response(ok: false, error: ErrorPayload(
      code: RunnerWireErrorCode.lockScreenSecure,
      message: "The simulator asks for a passcode, which lock-screen unlock does not enter",
      hint: "Enter the passcode by hand, or turn it off in Settings > Face ID & Passcode, then retry."
    ))
  }

#if os(iOS) && targetEnvironment(simulator)
  /// `pressLockButton` is a private XCUIDevice selector, the one WebDriverAgent's lock uses. A
  /// runtime without it is refused before anything is sent.
  private func dispatchLockButton() -> Response? {
    let device = XCUIDevice.shared
    let selector = NSSelectorFromString("pressLockButton")
    guard device.responds(to: selector) else {
      return Response(ok: false, error: ErrorPayload(
        code: RunnerWireErrorCode.hardwareControlUnavailable,
        message: "This XCTest runtime exposes no simulator lock button",
        hint: "lock-screen lock needs the XCUIDevice lock button that Xcode's simulator runtimes provide."
      ))
    }
    device.perform(selector)
    return nil
  }

  /// Presses the lock button on a lit screen. On a blanked screen that is still unlocked, the first
  /// press can wake the screen instead of locking it, so the screen is woken first and pressed
  /// again only if it is still unlocked.
  private func dispatchLock() -> Response? {
    if screenIsBlanked() {
      if let refusal = wakeBlankedScreen() { return refusal }
      guard currentLockScreenState() == .unlocked else { return nil }
    }
    return dispatchLockButton()
  }

  /// Wakes a blanked screen with the lock button, then swipes up from the bottom edge, as a person
  /// dismisses the lock screen. A swipe on a blanked screen unlocks SpringBoard but leaves the
  /// screen off. The swipe lands on whatever was in front before the lock, unlike a Home press,
  /// which lands on the Home Screen.
  private func dispatchUnlock() -> Response? {
    if screenIsBlanked(), let refusal = wakeBlankedScreen() { return refusal }
    guard currentLockScreenState() == .locked else { return nil }
    let start = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.99))
    let end = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
    start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0)
    return nil
  }

  /// Presses the lock button to light a blanked screen and waits, within the verification
  /// timeout, until SpringBoard reports it lit.
  private func wakeBlankedScreen() -> Response? {
    if let refusal = dispatchLockButton() { return refusal }
    let wakeDeadline = Date().addingTimeInterval(Self.lockScreenVerificationTimeout)
    while screenIsBlanked() && Date() < wakeDeadline {
      RunLoop.current.run(until: Date().addingTimeInterval(Self.lockScreenPollInterval))
    }
    return nil
  }

  /// The lock screen's date view, or SpringBoard's cover sheet window. The cover sheet also hosts
  /// Notification Center, so it counts only together with the locked state the caller read.
  private func lockScreenSurfaceIsVisible() -> Bool {
    let dateView = springboard.descendants(matching: .any)
      .matching(identifier: "lockscreen-date-view")
      .firstMatch
    let coverSheet = springboard.windows.matching(identifier: "SBCoverSheetWindow").firstMatch
    return (dateView.exists && !dateView.frame.isEmpty)
      || (coverSheet.exists && !coverSheet.frame.isEmpty)
  }

  /// The numeric keypad or the secure text field SpringBoard shows when the lock needs a passcode.
  /// A keypad key's label starts with its digit and may carry its letters after a space.
  private func passcodePromptIsVisible() -> Bool {
    let keypadKeys = springboard.buttons.matching(
      NSPredicate(format: "label MATCHES %@", "^[0-9]( .*)?$")
    )
    return keypadKeys.count >= 10 || springboard.secureTextFields.firstMatch.exists
  }

  func currentLockScreenState() -> LockScreenStateRead {
    switch springboardNotifyState(Self.springboardLockStateNotification) {
    case .failure(let error): return .unreadable(error.message)
    case .success(let locked) where locked != 0: return .locked
    case .success: break
    }
    switch springboardNotifyState(Self.springboardBlankedScreenNotification) {
    case .failure(let error): return .unreadable(error.message)
    case .success(let blanked): return blanked != 0 ? .unlockedScreenOff : .unlocked
    }
  }

  private func screenIsBlanked() -> Bool {
    if case .success(let blanked) = springboardNotifyState(Self.springboardBlankedScreenNotification) {
      return blanked != 0
    }
    return false
  }

  private func springboardNotifyState(_ name: String) -> Result<UInt64, LockScreenNotifyError> {
    var token: Int32 = 0
    let registerStatus = notify_register_check(name, &token)
    guard registerStatus == NOTIFY_STATUS_OK else {
      return .failure(LockScreenNotifyError("Unable to register for \(name) (notify status \(registerStatus))"))
    }
    defer { notify_cancel(token) }
    var state: UInt64 = 0
    let readStatus = notify_get_state(token, &state)
    guard readStatus == NOTIFY_STATUS_OK else {
      return .failure(LockScreenNotifyError("Unable to read \(name) (notify status \(readStatus))"))
    }
    return .success(state)
  }
#endif
}
