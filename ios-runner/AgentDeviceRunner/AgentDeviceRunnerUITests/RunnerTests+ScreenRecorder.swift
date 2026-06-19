import AVFoundation
import CoreVideo

extension RunnerTests {
  // MARK: - Screen Recorder

  final class ScreenRecorder {
    private let outputPath: String
    private let fps: Int32?
    private let maxSize: Int?
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

    init(outputPath: String, fps: Int32?, maxSize: Int?) {
      self.outputPath = outputPath
      self.fps = fps
      self.maxSize = maxSize
    }

    func start(captureFrame: @escaping () -> RunnerImage?) throws {
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
      let bootstrapDeadline = Date().addingTimeInterval(2.0)
      while Date() < bootstrapDeadline {
        if let image = captureFrame(), let cgImage = runnerCGImage(from: image) {
          bootstrapImage = image
          dimensions = scaledDimensions(width: cgImage.width, height: cgImage.height)
          break
        }
        Thread.sleep(forTimeInterval: 0.05)
      }
      guard dimensions.width > 0, dimensions.height > 0 else {
        throw NSError(
          domain: "AgentDeviceRunner.Record",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "failed to capture initial frame"]
        )
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
      timer.setEventHandler { [weak self] in
        guard let self else { return }
        if self.shouldStop() { return }
        guard let image = captureFrame() else { return }
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
      let nowUptime = ProcessInfo.processInfo.systemUptime
      if recordingStartUptime == nil {
        recordingStartUptime = nowUptime
      }
      let elapsed = max(0, nowUptime - (recordingStartUptime ?? nowUptime))
      let timescale = effectiveFps
      var timestampValue = Int64((elapsed * Double(timescale)).rounded(.down))
      if timestampValue <= lastTimestampValue {
        timestampValue = lastTimestampValue + 1
      }
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

    private func scaledDimensions(width: Int, height: Int) -> CGSize {
      guard let maxSize, maxSize > 0 else {
        return CGSize(width: width, height: height)
      }
      let longest = max(width, height)
      guard longest > maxSize else {
        return CGSize(width: width, height: height)
      }
      let scale = Double(maxSize) / Double(longest)
      return CGSize(
        width: scaledEvenDimension(width, scale: scale),
        height: scaledEvenDimension(height, scale: scale)
      )
    }

    private func scaledEvenDimension(_ value: Int, scale: Double) -> Int {
      max(2, Int((Double(value) * scale / 2.0).rounded()) * 2)
    }
  }
}
