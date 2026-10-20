#if AGENT_DEVICE_RUNNER_UNIT_TESTS
import XCTest

extension XCUIElement {
  func waitForFixtureExistence(timeout: TimeInterval) -> Bool {
    exists || waitForExistence(timeout: timeout)
  }
}
#endif
