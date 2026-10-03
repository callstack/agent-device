import AVFoundation
import CoreVideo

extension RunnerTests {
  // MARK: - Screen Recorder

  final class ScreenRecorder {
    private let outputPath: String
    private let fps: Int32?
    private var effectiveFps: Int32 {
      max(1, fps ?? RunnerTests.defaultRecordingFps)
    }
    private var frameInterval: TimeInterval {
      1.0 / Double(effectiveFps)
    }
    private let queue = DispatchQueue(label: "agent-device.runner.recorder")
    private let lock = NSLock()
    private var assetWriter: AVAssetWriter?
    private var writerInput: AVAssetWriterInput?
    private var pixelBufferAdaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var timer: DispatchSourceTimer?
    private var recordingStartUptime: TimeInterval?
    private var lastTimestampValue: Int64 = -1
    private var isStopping = false
    private var startedSession = false
    private var startError: Error?
    #if AGENT_DEVICE_RUNNER_UNIT_TESTS
    private var appendedFramesForTesting: [RunnerImage] = []
    #endif

    init(outputPath: String, fps: Int32?) {
      self.outputPath = outputPath
      self.fps = fps
    }

    /// `bootstrap` must produce the frame that sizes the writer and runs on the caller's thread.
    /// `frame` answers each tick with an image, or `nil` to drop the tick.
    func start(
      bootstrap: () -> Result<CapturedAppScreen, RunnerAppScreenCaptureFailure>,
      frame: @escaping @Sendable () -> RunnerImage?
    ) throws {
      let url = URL(fileURLWithPath: outputPath)
      let directory = url.deletingLastPathComponent()
      try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: nil
      )
      if FileManager.default.fileExists(atPath: outputPath) {
        try FileManager.default.removeItem(atPath: outputPath)
      }

      var dimensions: CGSize = .zero
      var bootstrapImage: RunnerImage?
      var lastFailure: RunnerAppScreenCaptureFailure?
      let bootstrapDeadline = Date().addingTimeInterval(2.0)
      while Date() < bootstrapDeadline {
        switch bootstrap() {
        case .success(let captured):
          bootstrapImage = captured.image
          dimensions = CGSize(width: captured.pixelWidth, height: captured.pixelHeight)
        case .failure(let failure):
          lastFailure = failure
        }
        if dimensions.width > 0, dimensions.height > 0 {
          break
        }
        Thread.sleep(forTimeInterval: 0.05)
      }
      guard dimensions.width > 0, dimensions.height > 0 else {
        // The bootstrap frame is required: the writer is sized from it. A capture that refused names
        // why (no window, no display, unencodable image) so the host sees a typed reason rather than
        // the generic "no frame" it used to collapse every refusal into (#2728). macOS keeps its
        // host-display behavior and its original error, because nothing here is a panel question.
        #if os(iOS)
        throw RunnerTests.recordingBootstrapError(from: lastFailure)
        #else
        // macOS/tvOS preserve their original untyped record error regardless of why the host capture
        // refused; the reason is read here only so the shared bootstrap loop carries no dead write.
        _ = lastFailure
        throw RunnerTests.recordingBootstrapError(from: nil)
        #endif
      }

      let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
      let outputSettings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: Int(dimensions.width),
        AVVideoHeightKey: Int(dimensions.height)
      ]
      let input = AVAssetWriterInput(mediaType: .video, outputSettings: outputSettings)
      input.expectsMediaDataInRealTime = true
      let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
        kCVPixelBufferWidthKey as String: Int(dimensions.width),
        kCVPixelBufferHeightKey as String: Int(dimensions.height)
      ]
      let adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: attributes
      )
      guard writer.canAdd(input) else {
        throw NSError(
          domain: "AgentDeviceRunner.Record",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "failed to add video input"]
        )
      }
      writer.add(input)
      guard writer.startWriting() else {
        throw writer.error ?? NSError(
          domain: "AgentDeviceRunner.Record",
          code: 3,
          userInfo: [NSLocalizedDescriptionKey: "failed to start writing"]
        )
      }

      lock.lock()
      assetWriter = writer
      writerInput = input
      pixelBufferAdaptor = adaptor
      recordingStartUptime = nil
      lastTimestampValue = -1
      isStopping = false
      startedSession = false
      startError = nil
      lock.unlock()

      if let firstImage = bootstrapImage {
        append(image: firstImage)
      }

      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now() + frameInterval, repeating: frameInterval)
      timer.setEventHandler { @Sendable [weak self] in
        guard let self else { return }
        if self.shouldStop() { return }
        guard let image = frame() else { return }
        self.append(image: image)
      }
      self.timer = timer
      timer.resume()
    }

    func stop() throws {
      var writer: AVAssetWriter?
      var input: AVAssetWriterInput?
      var appendError: Error?
      lock.lock()
      if isStopping {
        lock.unlock()
        return
      }
      isStopping = true
      let activeTimer = timer
      timer = nil
      writer = assetWriter
      input = writerInput
      appendError = startError
      lock.unlock()

      activeTimer?.cancel()
      input?.markAsFinished()
      guard let writer else { return }

      let semaphore = DispatchSemaphore(value: 0)
      writer.finishWriting {
        semaphore.signal()
      }
      var stopFailure: Error?
      let waitResult = semaphore.wait(timeout: .now() + 10)
      if waitResult == .timedOut {
        writer.cancelWriting()
        stopFailure = NSError(
          domain: "AgentDeviceRunner.Record",
          code: 6,
          userInfo: [NSLocalizedDescriptionKey: "recording finalization timed out"]
        )
      } else if let appendError {
        stopFailure = appendError
      } else if writer.status == .failed {
        stopFailure = writer.error ?? NSError(
          domain: "AgentDeviceRunner.Record",
          code: 4,
          userInfo: [NSLocalizedDescriptionKey: "failed to finalize recording"]
        )
      }

      lock.lock()
      assetWriter = nil
      writerInput = nil
      pixelBufferAdaptor = nil
      recordingStartUptime = nil
      lastTimestampValue = -1
      startedSession = false
      startError = nil
      lock.unlock()

      if let stopFailure {
        throw stopFailure
      }
    }

    private func append(image: RunnerImage) {
      guard let cgImage = runnerCGImage(from: image) else { return }
      lock.lock()
      defer { lock.unlock() }
      if isStopping { return }
      if startError != nil { return }
      guard
        let writer = assetWriter,
        let input = writerInput,
        let adaptor = pixelBufferAdaptor
      else {
        return
      }
      if !startedSession {
        writer.startSession(atSourceTime: .zero)
        startedSession = true
      }
      guard input.isReadyForMoreMediaData else { return }
      guard let pixelBuffer = makePixelBuffer(from: cgImage) else { return }
      let candidateTimestampValue = timestampCandidateValue(for: ProcessInfo.processInfo.systemUptime)
      let timestampValue = monotonicTimestampValue(for: candidateTimestampValue)
      let timescale = effectiveFps
      let timestamp = CMTime(value: timestampValue, timescale: timescale)
      if !adaptor.append(pixelBuffer, withPresentationTime: timestamp) {
        startError = writer.error ?? NSError(
          domain: "AgentDeviceRunner.Record",
          code: 5,
          userInfo: [NSLocalizedDescriptionKey: "failed to append frame"]
        )
        return
      }
      lastTimestampValue = timestampValue
      #if AGENT_DEVICE_RUNNER_UNIT_TESTS
      appendedFramesForTesting.append(image)
      #endif
    }

    private func timestampCandidateValue(for nowUptime: TimeInterval) -> Int64 {
      let startUptime = recordingStartUptime ?? nowUptime
      recordingStartUptime = startUptime
      let elapsed = max(0, nowUptime - startUptime)
      return Int64((elapsed * Double(effectiveFps)).rounded(.down))
    }

    private func monotonicTimestampValue(for candidateTimestampValue: Int64) -> Int64 {
      if candidateTimestampValue <= lastTimestampValue {
        return lastTimestampValue + 1
      }
      return candidateTimestampValue
    }

    private func shouldStop() -> Bool {
      lock.lock()
      defer { lock.unlock() }
      return isStopping
    }

    private func makePixelBuffer(from image: CGImage) -> CVPixelBuffer? {
      guard let adaptor = pixelBufferAdaptor else { return nil }
      var pixelBuffer: CVPixelBuffer?
      guard let pool = adaptor.pixelBufferPool else { return nil }
      let status = CVPixelBufferPoolCreatePixelBuffer(
        nil,
        pool,
        &pixelBuffer
      )
      guard status == kCVReturnSuccess, let pixelBuffer else { return nil }

      CVPixelBufferLockBaseAddress(pixelBuffer, [])
      defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
      let width = CVPixelBufferGetWidth(pixelBuffer)
      let height = CVPixelBufferGetHeight(pixelBuffer)
      guard
        let context = CGContext(
          data: CVPixelBufferGetBaseAddress(pixelBuffer),
          width: width,
          height: height,
          bitsPerComponent: 8,
          bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
        )
      else {
        return nil
      }
      context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      return pixelBuffer
    }

  }
}

extension RunnerTests {
  /// Starts `recorder` on the frames `capture` produces. The bootstrap frame is taken on the calling
  /// thread, which is main for `record start`. Each later tick is optional work: it hops to main only
  /// while no other main-thread work is in flight, so it never queues behind a command.
  /// A capture still running after `recordingFrameCaptureTimeout` is abandoned and its frame dropped;
  /// its late result is never returned.
  @MainActor
  func startRecording(
    _ recorder: ScreenRecorder,
    capture: @escaping @MainActor () -> Result<CapturedAppScreen, RunnerAppScreenCaptureFailure>
  ) throws {
    try recorder.start(bootstrap: capture) { [weak self] in
      guard let self else { return nil }
      return try? self.runMainThreadWorkIfIdle(
        "recording_frame",
        timeout: self.recordingFrameCaptureTimeout,
        timeoutError: Self.mainThreadExecutionTimeoutError
      ) {
        try capture().get().image
      }
    }
  }

  /// The error a `record start` bootstrap raises when no initial frame arrived. On iOS the last capture
  /// refusal (if any) is the honest reason and travels as its own typed code; only when nothing
  /// refused — a macOS host capture, or a deadline that elapsed before any answer — does it fall back
  /// to the original untyped record error, which keeps pre-panel behavior intact (#2728).
  static func recordingBootstrapError(from lastFailure: RunnerAppScreenCaptureFailure?) -> Error {
    lastFailure
      ?? NSError(
        domain: "AgentDeviceRunner.Record",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "failed to capture initial frame"]
      )
  }

  /// Maps a `record start` failure to the wire payload. A capture that refused carries a typed
  /// `APP_SCREEN_*` reason, so a no-window bootstrap reaches the host as that code rather than the
  /// generic record error it used to collapse into; a genuine writer failure keeps its message.
  static func recordingStartErrorPayload(for error: Error) -> ErrorPayload {
    if let failure = error as? RunnerAppScreenCaptureFailure {
      return ErrorPayload(code: failure.rawValue, message: failure.message, hint: failure.hint)
    }
    return ErrorPayload(message: "failed to start recording: \(error.localizedDescription)")
  }
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests.ScreenRecorder {
  @discardableResult
  func allocateTimestampForTesting(_ candidateTimestampValue: Int64) -> Int64 {
    lock.lock()
    defer { lock.unlock() }
    let allocatedTimestamp = monotonicTimestampValue(for: candidateTimestampValue)
    lastTimestampValue = allocatedTimestamp
    return allocatedTimestamp
  }

  func appendedFrameSnapshotForTesting() -> [RunnerImage] {
    lock.lock()
    defer { lock.unlock() }
    return appendedFramesForTesting
  }
}
#endif
