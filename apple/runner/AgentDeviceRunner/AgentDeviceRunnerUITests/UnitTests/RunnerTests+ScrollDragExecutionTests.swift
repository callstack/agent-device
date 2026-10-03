import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

private final class RunnerSynthesizedSwipeFailureStub: NSObject {
  @objc(synthesizeSwipeWithApplication:resolvedWindow:x:y:x2:y2:durationMs:)
  class func synthesizeSwipe(
    application: XCUIApplication,
    resolvedWindow: Any?,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    durationMs: Double
  ) -> String? {
    "forced private synthesis failure"
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
#if os(iOS)
  @MainActor
  func testSinglePointerFlingFallsBackToXCTestCoordinateDragWhenPrivateSynthesisFails() throws {
    let selector = NSSelectorFromString(
      "synthesizeSwipeWithApplication:resolvedWindow:x:y:x2:y2:durationMs:"
    )
    guard
      let synthesizedSwipeMethod = class_getClassMethod(RunnerSynthesizedGesture.self, selector),
      let failureStubMethod = class_getClassMethod(RunnerSynthesizedSwipeFailureStub.self, selector)
    else {
      XCTFail("unable to install synthesized swipe failure stub")
      return
    }
    let originalImplementation = method_getImplementation(synthesizedSwipeMethod)
    method_setImplementation(
      synthesizedSwipeMethod,
      method_getImplementation(failureStubMethod)
    )
    app.launch()
    mainOwned.accessibilityHealth = .healthy
    defer {
      method_setImplementation(synthesizedSwipeMethod, originalImplementation)
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let command = try runnerCommandFixture(
      """
      {"command":"gesture","commandId":"gesture-fling-fallback","gesturePlan":{"topology":"single","intent":"fling","executionProfile":"endpoint-hold","durationMs":100,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":160,"y":150}},{"offsetMs":100,"point":{"x":40,"y":150}}]}]}}
      """
    )

    let response = try executeOnMainPrepared(command: command, activeApp: app)

    XCTAssertTrue(response.ok)
    XCTAssertEqual(response.data?.message, "fling")
    XCTAssertEqual(response.data?.gestureFallback, "xctest-coordinate-drag")
    XCTAssertEqual(response.data?.gestureFallbackMessage, "forced private synthesis failure")
    XCTAssertEqual(
      response.data?.gestureFallbackHint,
      "Private XCTest event synthesis is required for AX-free coordinate drag on iOS; update Xcode if this persists."
    )
    XCTAssertNil(response.data?.x)
    XCTAssertNil(response.data?.y)
    XCTAssertNil(response.data?.x2)
    XCTAssertNil(response.data?.y2)
  }
#endif
}
#endif
