import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  /// Pins the raw value of every `XCUIApplication.State` the TypeScript decoder names and of the
  /// foreground state it omits. Each expectation is compared against the SDK's own enum, never
  /// against a second handwritten table: the decoder maps the integer the runner stamps, and #2726
  /// shipped `runningBackground` and `runningBackgroundSuspended` reversed.
  ///
  /// The host lane runs this on every PR; the simulator lane derives it from the platform branch
  /// below so the suspended case, compiled out of the macOS build, is pinned on every PR too.
  /// `packages/platform-apple/src/runner/__tests__/target-activation.test.ts` reads these calls back
  /// and compares them with its decode table, so a table that drifts from them fails on any host
  /// instead of waiting for a lane to report a mislabelled repair.
  func testApplicationStateRawValuesMatchTheActivationDecoder() {
    assertDecoderPins(.unknown, name: "unknown", raw: 0)
    assertDecoderPins(.notRunning, name: "notRunning", raw: 1)
#if !os(macOS)
    // The SDK declares the suspended state only for non-macOS platforms, so the host lane — which
    // compiles this bundle for macOS — has no case to pin and the iOS lanes do.
    assertDecoderPins(.runningBackgroundSuspended, name: "runningBackgroundSuspended", raw: 2)
#endif
    assertDecoderPins(.runningBackground, name: "runningBackground", raw: 3)
    assertDecoderPins(.runningForeground, name: "runningForeground", raw: 4)
  }

  /// The `appState` command names each state for the TypeScript `AppleApplicationState` type.
  func testApplicationStateNamesMatchTheAppStateContract() {
    XCTAssertEqual(Self.applicationStateName(.unknown), "unknown")
    XCTAssertEqual(Self.applicationStateName(.notRunning), "notRunning")
#if !os(macOS)
    XCTAssertEqual(Self.applicationStateName(.runningBackgroundSuspended), "runningBackgroundSuspended")
#endif
    XCTAssertEqual(Self.applicationStateName(.runningBackground), "runningBackground")
    XCTAssertEqual(Self.applicationStateName(.runningForeground), "runningForeground")
  }

  private func assertDecoderPins(_ state: XCUIApplication.State, name: String, raw: Int) {
    XCTAssertEqual(
      Int(state.rawValue),
      raw,
      "XCUIApplication.State \(name) no longer carries the raw value the decoder maps it to (#2726)"
    )
  }
}
#endif
