import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  func testSynthesizedInputWarmupRunsOnceThenNotAgain() {
    XCTAssertTrue(shouldWarmSynthesizedInput(alreadyWarmed: false), "cold process must warm")
    XCTAssertFalse(shouldWarmSynthesizedInput(alreadyWarmed: true), "an already-warmed process must not warm again")
  }

  func testSynthesizedInputWarmupPointSitsInTheStatusBarBandOfTheFrame() throws {
    let frame = CGRect(x: 10, y: 20, width: 300, height: 600)
    let point = try XCTUnwrap(synthesizedInputWarmupPoint(referenceFrame: frame))
    XCTAssertEqual(point.x, frame.midX, accuracy: 0.001, "warm-up contact is horizontally centered")
    XCTAssertEqual(point.y, frame.minY + 1, accuracy: 0.001, "warm-up contact sits in the top band, off app content")
    XCTAssertTrue(frame.contains(point), "warm-up contact stays inside the reference frame")
  }

  func testSynthesizedInputWarmupPointIsUnavailableForAnEmptyFrame() {
    XCTAssertNil(synthesizedInputWarmupPoint(referenceFrame: .zero))
    XCTAssertNil(synthesizedInputWarmupPoint(referenceFrame: CGRect(x: 0, y: 0, width: 0, height: 100)))
  }
#endif
}
