import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testGestureResponseIncludesSynthesizedTapFallbackDiagnostics() {
    let response = gestureResponse(
      message: "tapped",
      timing: (gestureStartUptimeMs: 1, gestureEndUptimeMs: 2),
      fallback: GestureFallback(
        strategy: "xctest-coordinate-tap",
        message: "Runner synthesized coordinate tap is unavailable",
        hint: "Using XCTest coordinate tap fallback."
      )
    )

    XCTAssertEqual(response.ok, true)
    XCTAssertEqual(response.data?.gestureFallback, "xctest-coordinate-tap")
    XCTAssertEqual(
      response.data?.gestureFallbackMessage,
      "Runner synthesized coordinate tap is unavailable"
    )
    XCTAssertEqual(response.data?.gestureFallbackHint, "Using XCTest coordinate tap fallback.")
  }

  func testGestureResponseIncludesMaestroNonHittableFallbackUsage() {
    let response = gestureResponse(
      message: "tapped via non-hittable coordinate fallback",
      timing: (gestureStartUptimeMs: 1, gestureEndUptimeMs: 2),
      frame: .touch(nil),
      maestroNonHittableCoordinateFallbackUsed: true
    )

    XCTAssertEqual(response.data?.maestroNonHittableCoordinateFallbackUsed, true)
  }

  func testCanonicalPlannedGestureResponseOmitsDragFrameAndPreservesDiagnostics() {
    let response = gestureResponse(
      message: "fling",
      timing: (gestureStartUptimeMs: 1, gestureEndUptimeMs: 2),
      frame: .drag(
        DragVisualizationFrame(
          x: 160,
          y: 150,
          x2: 40,
          y2: 150,
          referenceWidth: 200,
          referenceHeight: 300
        )
      ),
      fallback: GestureFallback(
        strategy: "xctest-coordinate-drag",
        message: "Private synthesis unavailable",
        hint: "Using XCTest coordinate fallback."
      )
    )

    let canonical = canonicalPlannedGestureResponse(response)

    XCTAssertEqual(canonical.data?.gestureStartUptimeMs, 1)
    XCTAssertEqual(canonical.data?.gestureEndUptimeMs, 2)
    XCTAssertEqual(canonical.data?.gestureFallback, "xctest-coordinate-drag")
    XCTAssertEqual(canonical.data?.gestureFallbackMessage, "Private synthesis unavailable")
    XCTAssertEqual(canonical.data?.gestureFallbackHint, "Using XCTest coordinate fallback.")
    XCTAssertNil(canonical.data?.x)
    XCTAssertNil(canonical.data?.y)
    XCTAssertNil(canonical.data?.x2)
    XCTAssertNil(canonical.data?.y2)
    XCTAssertNil(canonical.data?.referenceWidth)
    XCTAssertNil(canonical.data?.referenceHeight)
  }
}
#endif
