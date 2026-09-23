import XCTest
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

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
      try recorder.start(
        bootstrap: {
          captureCalls += 1
          return .failure(.unresolvedWindow)
        },
        frame: { _ in nil }
      )
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

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
/// Frames for a recording test. Every capture draws a new image, so an appended frame is identified
/// by instance. An armed wedge makes the next capture block the main thread until released, and
/// remembers the image that capture will hand back late.
private final class RecordingFrameSource {
  static let side = 128
  private let lock = NSLock()
  private var wedgeArmed = false
  private var wedgedImage: RunnerImage?
  let wedgeEntered = DispatchSemaphore(value: 0)
  let releaseWedge = DispatchSemaphore(value: 0)

  var lateImage: RunnerImage? {
    lock.lock()
    defer { lock.unlock() }
    return wedgedImage
  }

  func armWedge() {
    lock.lock()
    wedgeArmed = true
    lock.unlock()
  }

  func capture() -> Result<CapturedAppScreen, RunnerAppScreenCaptureFailure> {
    let image = Self.makeImage()
    lock.lock()
    let wedge = wedgeArmed
    wedgeArmed = false
    if wedge {
      wedgedImage = image
    }
    lock.unlock()
    if wedge {
      wedgeEntered.signal()
      _ = releaseWedge.wait(timeout: .now() + 10)
    }
    return .success(
      CapturedAppScreen(
        image: image,
        displayID: 0,
        pixelWidth: Self.side,
        pixelHeight: Self.side,
        pixelsPerPoint: 1
      )
    )
  }

  private static func makeImage() -> RunnerImage {
    let context = CGContext(
      data: nil,
      width: side,
      height: side,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
    )!
    context.setFillColor(red: 0, green: 0.4, blue: 1, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: side, height: side))
    let cgImage = context.makeImage()!
    #if canImport(UIKit)
    return UIImage(cgImage: cgImage)
    #else
    return NSImage(cgImage: cgImage, size: NSSize(width: side, height: side))
    #endif
  }
}

extension RunnerTests {
  func testRecordingFrameTimeoutDropsTheFrameAndResumesOnceTheWorkDrains() throws {
    let source = RecordingFrameSource()
    let recorder = ScreenRecorder(outputPath: recordingTestOutputPath(), fps: 10)
    try startRecording(recorder, capture: source.capture)
    defer { try? recorder.stop() }
    XCTAssertTrue(pumpMainThread(until: { recorder.appendedFrameSnapshotForTesting().count >= 3 }))

    final class Observation {
      var abandonedWhileWedged: Int?
      var framesWhileWedged: Int?
      var secondsToAbandon: TimeInterval?
    }
    let observation = Observation()
    let observed = expectation(description: "the wedged frame was abandoned and released")
    source.armWedge()
    DispatchQueue(label: "agent-device.runner.tests.recording-timeout").async {
      defer {
        source.releaseWedge.signal()
        observed.fulfill()
      }
      guard source.wedgeEntered.wait(timeout: .now() + 3) == .success else { return }
      let enteredAt = Date()
      guard self.waitOffMain(until: { self.hasAbandonedMainThreadWork() }) else { return }
      observation.secondsToAbandon = Date().timeIntervalSince(enteredAt)
      self.mainThreadWorkLock.lock()
      observation.abandonedWhileWedged = self.abandonedMainThreadWorkCount
      self.mainThreadWorkLock.unlock()
      observation.framesWhileWedged = recorder.appendedFrameSnapshotForTesting().count
    }
    wait(for: [observed], timeout: 15)

    let framesAtRelease = observation.framesWhileWedged ?? 0
    XCTAssertTrue(
      pumpMainThread(until: {
        !self.hasAbandonedMainThreadWork()
          && recorder.appendedFrameSnapshotForTesting().count >= framesAtRelease + 2
      }),
      "the abandoned capture drains and the recorder appends frames again"
    )
    XCTAssertEqual(observation.abandonedWhileWedged, 1, "the timed-out frame counts as abandoned")
    XCTAssertLessThan(
      observation.secondsToAbandon ?? .infinity,
      1.5,
      "a frame is bounded by the tick interval, not a command-scale timeout"
    )
    let lateImage = try XCTUnwrap(source.lateImage)
    XCTAssertFalse(
      recorder.appendedFrameSnapshotForTesting().contains { $0 === lateImage },
      "the late result of the abandoned capture is never appended"
    )
  }

  func testRecordingPersistentWedgeKeepsOneCaptureQueuedOnMain() throws {
    let source = RecordingFrameSource()
    let recorder = ScreenRecorder(outputPath: recordingTestOutputPath(), fps: 20)
    try startRecording(recorder, capture: source.capture)
    defer { try? recorder.stop() }
    XCTAssertTrue(pumpMainThread(until: { recorder.appendedFrameSnapshotForTesting().count >= 2 }))

    final class Observation {
      var maxAbandoned = 0
    }
    let observation = Observation()
    let observed = expectation(description: "the wedge was held for many ticks")
    source.armWedge()
    DispatchQueue(label: "agent-device.runner.tests.recording-wedge").async {
      defer {
        source.releaseWedge.signal()
        observed.fulfill()
      }
      guard source.wedgeEntered.wait(timeout: .now() + 3) == .success else { return }
      let holdUntil = Date().addingTimeInterval(0.6)
      while Date() < holdUntil {
        self.mainThreadWorkLock.lock()
        observation.maxAbandoned = max(observation.maxAbandoned, self.abandonedMainThreadWorkCount)
        self.mainThreadWorkLock.unlock()
        usleep(10_000)
      }
    }
    wait(for: [observed], timeout: 15)
    XCTAssertTrue(pumpMainThread(until: { !self.hasAbandonedMainThreadWork() }))

    XCTAssertEqual(
      observation.maxAbandoned,
      1,
      "twelve ticks against a wedged main thread leave one recorder capture pending, not one per tick"
    )
  }

  func testRecordingStopDuringATimedOutCaptureAppendsNoLateFrame() throws {
    let source = RecordingFrameSource()
    let recorder = ScreenRecorder(outputPath: recordingTestOutputPath(), fps: 10)
    try startRecording(recorder, capture: source.capture)
    XCTAssertTrue(pumpMainThread(until: { recorder.appendedFrameSnapshotForTesting().count >= 2 }))

    final class Observation {
      var stopError: Error?
      var stopReturnedWhileWedged = false
      var framesAtStop: Int?
    }
    let observation = Observation()
    let observed = expectation(description: "stop returned during the timed-out capture")
    source.armWedge()
    DispatchQueue(label: "agent-device.runner.tests.recording-stop").async {
      defer {
        source.releaseWedge.signal()
        observed.fulfill()
      }
      guard source.wedgeEntered.wait(timeout: .now() + 3) == .success else { return }
      guard self.waitOffMain(until: { self.hasAbandonedMainThreadWork() }) else { return }
      do {
        try recorder.stop()
      } catch {
        observation.stopError = error
      }
      observation.stopReturnedWhileWedged = self.hasAbandonedMainThreadWork()
      observation.framesAtStop = recorder.appendedFrameSnapshotForTesting().count
    }
    wait(for: [observed], timeout: 20)
    XCTAssertTrue(pumpMainThread(until: { !self.hasAbandonedMainThreadWork() }))
    sleepFor(0.3)

    XCTAssertNil(observation.stopError)
    XCTAssertTrue(observation.stopReturnedWhileWedged, "stop must not wait for the wedged capture")
    XCTAssertEqual(recorder.appendedFrameSnapshotForTesting().count, observation.framesAtStop)
    let lateImage = try XCTUnwrap(source.lateImage)
    XCTAssertFalse(recorder.appendedFrameSnapshotForTesting().contains { $0 === lateImage })
  }

  func testRecordingStopRefusesAFrameThatFinishedAtTheTimeoutBoundary() throws {
    let source = RecordingFrameSource()
    let recorder = ScreenRecorder(outputPath: recordingTestOutputPath(), fps: 10)
    try startRecording(recorder, capture: source.capture)
    XCTAssertTrue(pumpMainThread(until: { recorder.appendedFrameSnapshotForTesting().count >= 2 }))

    final class Observation {
      var framesAtStop: Int?
    }
    let observation = Observation()
    mainThreadWorkTimedOutForTesting = {
      try? recorder.stop()
      observation.framesAtStop = recorder.appendedFrameSnapshotForTesting().count
      source.releaseWedge.signal()
      DispatchQueue.main.sync {}
    }
    defer { mainThreadWorkTimedOutForTesting = nil }
    source.armWedge()
    XCTAssertTrue(pumpMainThread(until: { observation.framesAtStop != nil }))
    sleepFor(0.3)

    XCTAssertFalse(hasAbandonedMainThreadWork(), "a capture finished at the boundary is not abandoned")
    let lateImage = try XCTUnwrap(source.lateImage)
    XCTAssertFalse(
      recorder.appendedFrameSnapshotForTesting().contains { $0 === lateImage },
      "a frame returned after stop is never appended"
    )
    XCTAssertEqual(recorder.appendedFrameSnapshotForTesting().count, observation.framesAtStop)
  }

  func testRecordingAfterAStopDuringATimedOutCaptureStartsClean() throws {
    let first = RecordingFrameSource()
    let firstRecorder = ScreenRecorder(outputPath: recordingTestOutputPath(), fps: 10)
    try startRecording(firstRecorder, capture: first.capture)
    XCTAssertTrue(pumpMainThread(until: { firstRecorder.appendedFrameSnapshotForTesting().count >= 2 }))
    let stopped = expectation(description: "first recording stopped during its timed-out capture")
    first.armWedge()
    DispatchQueue(label: "agent-device.runner.tests.recording-restart").async {
      defer {
        first.releaseWedge.signal()
        stopped.fulfill()
      }
      guard first.wedgeEntered.wait(timeout: .now() + 3) == .success else { return }
      guard self.waitOffMain(until: { self.hasAbandonedMainThreadWork() }) else { return }
      try? firstRecorder.stop()
    }
    wait(for: [stopped], timeout: 20)
    XCTAssertTrue(pumpMainThread(until: { !self.hasAbandonedMainThreadWork() }))
    let firstFrames = firstRecorder.appendedFrameSnapshotForTesting()

    let second = RecordingFrameSource()
    let secondOutputPath = recordingTestOutputPath()
    let secondRecorder = ScreenRecorder(outputPath: secondOutputPath, fps: 10)
    try startRecording(secondRecorder, capture: second.capture)
    XCTAssertTrue(pumpMainThread(until: { secondRecorder.appendedFrameSnapshotForTesting().count >= 3 }))
    try secondRecorder.stop()

    let secondFrames = secondRecorder.appendedFrameSnapshotForTesting()
    XCTAssertFalse(secondFrames.contains { frame in firstFrames.contains { $0 === frame } })
    let lateImage = try XCTUnwrap(first.lateImage)
    XCTAssertFalse(secondFrames.contains { $0 === lateImage })
    XCTAssertFalse(firstRecorder.appendedFrameSnapshotForTesting().contains { $0 === lateImage })
    XCTAssertEqual(firstRecorder.appendedFrameSnapshotForTesting().count, firstFrames.count)
    XCTAssertFalse(hasAbandonedMainThreadWork())
    let attributes = try FileManager.default.attributesOfItem(atPath: secondOutputPath)
    XCTAssertGreaterThan((attributes[.size] as? NSNumber)?.intValue ?? 0, 0)
  }

  private func recordingTestOutputPath() -> String {
    (NSTemporaryDirectory() as NSString).appendingPathComponent(
      "record-bounded-\(UUID().uuidString).mp4"
    )
  }

  private func pumpMainThread(timeout: TimeInterval = 5, until condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
      if Date() >= deadline { return false }
      sleepFor(0.01)
    }
    return true
  }

  private func waitOffMain(timeout: TimeInterval = 3, until condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
      if Date() >= deadline { return false }
      usleep(5_000)
    }
    return true
  }
}
#endif
