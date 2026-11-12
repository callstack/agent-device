import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

/// Fails every synthesized drag, before handing its record to XCTest unless told otherwise.
private final class RunnerSynthesizedSwipeFailureStub: NSObject {
  static var dispatchedBeforeFailing = false
  @objc(synthesizeDragWithApplication:resolvedWindow:interfaceOrientation:drag:dispatched:)
  class func synthesizeSwipe(
    application: XCUIApplication,
    resolvedWindow: Any?,
    interfaceOrientation: Int,
    drag: RunnerSynthesizedDrag,
    dispatched: UnsafeMutablePointer<ObjCBool>?
  ) -> String? {
    dispatched?.pointee = ObjCBool(dispatchedBeforeFailing)
    return "forced private synthesis failure"
  }
}
#endif

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
#if os(iOS)
  @MainActor
  func testCoordinateDragPreservesFrameWithoutFallbackDiagnostics() throws {
    app.launch()
    defer {
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let referenceFrame = app.frame
    XCTAssertFalse(referenceFrame.isEmpty)
    let command = try runnerCommandFixture(
      """
      {"command":"drag","commandId":"coordinate-drag","x":160,"y":150,"x2":40,"y2":150}
      """
    )

    let response = try executeOnMainPrepared(command: command, activeApp: app)

    XCTAssertTrue(response.ok)
    XCTAssertEqual(response.data?.message, "dragged")
    XCTAssertEqual(response.data?.x, 160)
    XCTAssertEqual(response.data?.y, 150)
    XCTAssertEqual(response.data?.x2, 40)
    XCTAssertEqual(response.data?.y2, 150)
    XCTAssertEqual(response.data?.referenceWidth, Double(referenceFrame.width))
    XCTAssertEqual(response.data?.referenceHeight, Double(referenceFrame.height))
    XCTAssertNil(response.data?.gestureFallback)
    XCTAssertNil(response.data?.gestureFallbackMessage)
    XCTAssertNil(response.data?.gestureFallbackHint)
  }

  @MainActor
  func testSinglePointerFlingFallsBackToXCTestCoordinateDragWhenPrivateSynthesisFails() throws {
    RunnerSynthesizedSwipeFailureStub.dispatchedBeforeFailing = false
    let selector = NSSelectorFromString(
      "synthesizeDragWithApplication:resolvedWindow:interfaceOrientation:drag:dispatched:"
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

  /// A fast-swipe planned gesture refused before its record reached XCTest sent nothing: with no
  /// XCTest fallback allowed it reports the typed not-dispatched code.
  @MainActor
  func testFastSwipePlannedGestureRefusedBeforeDispatchIsNotDispatched() throws {
    let response = try flingWithFailingSynthesis(dispatchedBeforeFailing: false, health: .unavailable)

    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.synthesizedGestureNotDispatched)
  }

  /// One that failed after its record reached XCTest may have run: it reports the unknown outcome
  /// and no XCTest drag repeats it.
  @MainActor
  func testFastSwipePlannedGestureFailingAfterDispatchIsUnknownAndNeverFallsBack() throws {
    let response = try flingWithFailingSynthesis(dispatchedBeforeFailing: true, health: .healthy)

    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.synthesizedGestureOutcomeUnknown)
    XCTAssertNil(response.data?.gestureFallback, "no XCTest drag repeats a fling that may have run")
  }

  /// A scroll whose synthesized drag was refused before hand-off (RunnerCreateEventRecord) sent
  /// nothing: scroll never falls back to an XCTest drag, so it answers the not-dispatched code.
  @MainActor
  func testScrollDragRefusedBeforeHandOffIsNotDispatched() throws {
    let response = try flingWithFailingSynthesis(
      dispatchedBeforeFailing: false,
      health: .healthy,
      command: #"{"command":"scroll","commandId":"scroll-refused-synthesis","direction":"down"}"#
    )

    XCTAssertEqual(response.error?.code, RunnerWireErrorCode.synthesizedGestureNotDispatched)
  }

  @MainActor
  private func flingWithFailingSynthesis(
    dispatchedBeforeFailing: Bool,
    health: RunnerAccessibilityHealth,
    command json: String? = nil
  ) throws -> Response {
    RunnerSynthesizedSwipeFailureStub.dispatchedBeforeFailing = dispatchedBeforeFailing
    let selector = NSSelectorFromString(
      "synthesizeDragWithApplication:resolvedWindow:interfaceOrientation:drag:dispatched:"
    )
    let target = try XCTUnwrap(class_getClassMethod(RunnerSynthesizedGesture.self, selector))
    let stub = try XCTUnwrap(class_getClassMethod(RunnerSynthesizedSwipeFailureStub.self, selector))
    let original = method_setImplementation(target, method_getImplementation(stub))
    app.launch()
    mainOwned.app = app
    mainOwned.accessibilityHealth = health
    defer {
      method_setImplementation(target, original)
      invalidateCachedTarget(reason: "unit_test_cleanup")
      app.terminate()
    }
    let command = try runnerCommandFixture(json ??
      """
      {"command":"gesture","commandId":"gesture-fling-failing-synthesis","gesturePlan":{"topology":"single","intent":"fling","executionProfile":"endpoint-hold","durationMs":100,"viewport":{"x":0,"y":0,"width":200,"height":300},"pointers":[{"pointerId":0,"samples":[{"offsetMs":0,"point":{"x":160,"y":150}},{"offsetMs":100,"point":{"x":40,"y":150}}]}]}}
      """
    )
    return try executeOnMainPrepared(command: command, activeApp: app)
  }
#endif
}
#endif
