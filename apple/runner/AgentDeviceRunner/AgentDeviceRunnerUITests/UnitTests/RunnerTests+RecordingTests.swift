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
#endif
}
