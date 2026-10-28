import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
/// Shared reading of the sole-screen rule for the runner unit bundle.
///
/// The rule has one owner (`RunnerResolveSoleScreen`), so a test that asks "does this device family
/// show the app full on its only screen" must read its answer rather than restate a device list.
extension RunnerTests {
  /// Whether the launched app can route a window-less gesture through the device's only screen: an
  /// iPhone always, an iPad only while the app proves it fills that screen.
  func soleScreenRouteIsOpen(for app: XCUIApplication) -> Bool {
    var screen: AnyObject?
    var displayID: UInt = 0
    return RunnerResolveSoleScreen(app, &screen, &displayID) == nil
  }
}
#endif
