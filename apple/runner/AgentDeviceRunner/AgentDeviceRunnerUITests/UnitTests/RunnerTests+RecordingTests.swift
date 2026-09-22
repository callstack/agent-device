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
