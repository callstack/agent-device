import XCTest

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  func testRecordStopIsIdempotentAfterNativeRecorderAlreadyStopped() throws {
    activeRecording = nil

    for commandId in ["record-stop-recovery-one", "record-stop-recovery-two"] {
      let json = #"{"command":"recordStop","commandId":"\#(commandId)"}"#
      let command = try JSONDecoder().decode(Command.self, from: Data(json.utf8))
      let response = try execute(command: command)

      XCTAssertTrue(response.ok)
      XCTAssertEqual(response.data?.message, "recording already stopped")
      XCTAssertNil(activeRecording)
    }
  }

  func testScreenRecorderClampsNonMonotonicFrameTimestamps() {
    let recorder = ScreenRecorder(outputPath: "", fps: 30)

    XCTAssertEqual(recorder.allocateTimestampForTesting(100), 100)
    // The helper records each returned value as an accepted frame.
    XCTAssertEqual(recorder.allocateTimestampForTesting(0), 101)
  }

  func testRecordingBootstrapErrorKeepsTheTypedRefusalAndFallsBackGenerically() {
    // A capture that refused is the honest bootstrap error; nothing refusing keeps the pre-panel
    // untyped record error, so the iOS typed path and the macOS generic path are both pinned (#2728).
    let typed = RunnerTests.recordingBootstrapError(from: .unresolvedWindow)
    XCTAssertEqual(
      (typed as? RunnerAppScreenCaptureFailure)?.rawValue,
      "APP_SCREEN_WINDOW_UNRESOLVED"
    )

    let generic = RunnerTests.recordingBootstrapError(from: nil)
    XCTAssertNil(generic as? RunnerAppScreenCaptureFailure)
    XCTAssertEqual((generic as NSError).code, 1)
  }

  func testRecordingStartSurfacesACaptureRefusalAsATypedCode() {
    // The bootstrap frame is required, so a no-window refusal must travel as its own code rather than
    // the generic record error it used to collapse into; a real writer failure keeps its message (#2728).
    let refusal = RunnerTests.recordingStartErrorPayload(
      for: RunnerAppScreenCaptureFailure.unresolvedWindow
    )
    XCTAssertEqual(refusal.code, "APP_SCREEN_WINDOW_UNRESOLVED")
    XCTAssertNotNil(refusal.hint)

    let writerFailure = NSError(
      domain: "AgentDeviceRunner.Record",
      code: 5,
      userInfo: [NSLocalizedDescriptionKey: "failed to append frame"]
    )
    let generic = RunnerTests.recordingStartErrorPayload(for: writerFailure)
    XCTAssertNil(generic.code)
    XCTAssertTrue(generic.message.contains("failed to start recording"))
    XCTAssertTrue(generic.message.contains("failed to append frame"))
  }
#endif
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
extension RunnerTests {
  func testRecordStartThrowsTheCaptureRefusalItReceived() throws {
    // The bootstrap frame is required, so `record start` must surface the exact refusal its capture
    // saw rather than the generic "failed to capture initial frame" every refusal used to collapse
    // into, and that refusal must reach the host as its own code. Driving `start` with an always-
    // refusing capture and mapping the ACTUAL thrown error — not a re-typed literal — proves the
    // bootstrap forwards its last refusal end to end; the pure mapping tests cannot catch that wiring.
    let outputPath = (NSTemporaryDirectory() as NSString).appendingPathComponent(
      "record-refusal-\(UUID().uuidString).mp4"
    )
    let recorder = ScreenRecorder(outputPath: outputPath, fps: 30)

    var captureCalls = 0
    var thrown: Error?
    XCTAssertThrowsError(
      try recorder.start(capture: {
        captureCalls += 1
        return .failure(.unresolvedWindow)
      })
    ) { error in
      thrown = error
      XCTAssertEqual(
        (error as? RunnerAppScreenCaptureFailure)?.rawValue,
        "APP_SCREEN_WINDOW_UNRESOLVED",
        "the thrown bootstrap error is the refusal the capture returned"
      )
    }
    XCTAssertGreaterThan(captureCalls, 0, "the bootstrap must poll the injected capture")

    // The refusal the bootstrap actually threw maps to its own host code, not the generic record error.
    let payload = RunnerTests.recordingStartErrorPayload(for: try XCTUnwrap(thrown))
    XCTAssertEqual(payload.code, "APP_SCREEN_WINDOW_UNRESOLVED")
  }
}
#endif
