import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testAlertAcceptTreatsOpenAsAffirmative() {
    XCTAssertTrue(isAcceptButton("Open"))
  }
}
#endif
