import Darwin
import XCTest

extension RunnerTests {
  private static let screenLockStateNotification = "com.apple.springboard.lockstate"
  private static let screenLockVerificationTimeout: TimeInterval = 5
  private static let screenLockPollInterval: TimeInterval = 0.05

  /// Mirrors WebDriverAgent's audited simulator route: XCTest dispatches the private lock-button
  /// primitive and SpringBoard's Darwin notification state independently verifies the transition.
  /// The pre-read makes the operation idempotent; a dispatch alone is never reported as success.
  func executeScreenLockCommand() -> Response {
    #if os(iOS) && targetEnvironment(simulator)
      let deadline = Date().addingTimeInterval(Self.screenLockVerificationTimeout)
      return executeScreenLockTransition(
        readState: currentScreenLockState,
        dispatch: dispatchScreenLock,
        verifyVisibleSurface: verifyLockScreenSurface,
        shouldContinue: { Date() < deadline },
        wait: {
          RunLoop.current.run(
            until: Date().addingTimeInterval(Self.screenLockPollInterval)
          )
        }
      )
    #else
      return Response(
        ok: false,
        error: ErrorPayload(
          code: "UNSUPPORTED_OPERATION",
          message: "screenLock is supported only on iPhone and iPad Simulators"
        )
      )
    #endif
  }

  #if os(iOS) && targetEnvironment(simulator)
    enum ScreenLockStateRead {
      case success(Bool)
      case failure(Response)
    }

    func executeScreenLockTransition(
      readState: () -> ScreenLockStateRead,
      dispatch: () -> Response?,
      verifyVisibleSurface: () -> Bool,
      shouldContinue: () -> Bool,
      wait: () -> Void
    ) -> Response {
      switch readState() {
      case .success(true):
        return screenLockVisibleResponse(
          readState: readState,
          verifyVisibleSurface: verifyVisibleSurface,
          shouldContinue: shouldContinue,
          wait: wait
        )
      case .failure(let response):
        return response
      case .success(false):
        break
      }

      if let dispatchFailure = dispatch() { return dispatchFailure }

      while shouldContinue() {
        switch readState() {
        case .success(true):
          return screenLockVisibleResponse(
            readState: readState,
            verifyVisibleSurface: verifyVisibleSurface,
            shouldContinue: shouldContinue,
            wait: wait
          )
        case .failure(let response):
          return response
        case .success(false):
          wait()
        }
      }

      // The lock transition may complete during the last wait even when that wait crosses the
      // deadline. Read once more before reporting timeout so a completed transition is not lost.
      switch readState() {
      case .success(true):
        return screenLockVisibleResponse(
          readState: readState,
          verifyVisibleSurface: verifyVisibleSurface,
          shouldContinue: shouldContinue,
          wait: wait
        )
      case .failure(let response):
        return response
      case .success(false):
        break
      }

      return Response(
        ok: false,
        error: ErrorPayload(
          code: "COMMAND_FAILED",
          message: "XCTest dispatched the simulator lock button, but SpringBoard did not report a locked screen",
          hint: "Verify that the selected Simulator is booted and that its SpringBoard lock-state service is available."
        )
      )
    }

    private func screenLockVisibleResponse(
      readState: () -> ScreenLockStateRead,
      verifyVisibleSurface: () -> Bool,
      shouldContinue: () -> Bool,
      wait: () -> Void
    ) -> Response {
      while true {
        switch readState() {
        case .success(false):
          return Response(
            ok: false,
            error: ErrorPayload(
              code: "COMMAND_FAILED",
              message: "SpringBoard no longer reports a locked screen while verifying the Lock Screen surface"
            )
          )
        case .failure(let response):
          return response
        case .success(true):
          break
        }
        if verifyVisibleSurface() {
          return Response(ok: true, data: DataPayload(message: "Screen locked", state: "locked"))
        }
        guard shouldContinue() else { break }
        wait()
      }
      return Response(
        ok: false,
        error: ErrorPayload(
          code: "COMMAND_FAILED",
          message: "SpringBoard reported a locked state, but the Lock Screen surface was not visible"
        )
      )
    }

    private func dispatchScreenLock() -> Response? {
      let device = XCUIDevice.shared
      let selector = NSSelectorFromString("pressLockButton")
      guard device.responds(to: selector) else {
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "UNSUPPORTED_OPERATION",
            message: "The selected XCTest runtime does not expose simulator screen locking"
          )
        )
      }
      device.perform(selector)
      return nil
    }

    private func verifyLockScreenSurface() -> Bool {
      let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      let dateView = springboard.descendants(matching: .any)
        .matching(identifier: "lockscreen-date-view")
        .firstMatch
      return springboard.exists && dateView.exists && !dateView.frame.isEmpty
    }

    private func currentScreenLockState() -> ScreenLockStateRead {
      var token: Int32 = 0
      let registerStatus = notify_register_check(Self.screenLockStateNotification, &token)
      guard registerStatus == NOTIFY_STATUS_OK else {
        return .failure(screenLockStateReadFailure("register", status: registerStatus))
      }
      defer { notify_cancel(token) }

      var state: UInt64 = 0
      let readStatus = notify_get_state(token, &state)
      guard readStatus == NOTIFY_STATUS_OK else {
        return .failure(screenLockStateReadFailure("read", status: readStatus))
      }
      return .success(state != 0)
    }

    private func screenLockStateReadFailure(_ phase: String, status: UInt32) -> Response {
      Response(
        ok: false,
        error: ErrorPayload(
          code: "COMMAND_FAILED",
          message: "Unable to \(phase) SpringBoard lock state (notify status \(status))"
        )
      )
    }
  #endif
}
