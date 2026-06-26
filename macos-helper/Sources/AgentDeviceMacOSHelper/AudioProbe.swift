import AVFoundation
import AudioToolbox
import CoreMedia
import Foundation
import ScreenCaptureKit

private let audioProbeSilenceDb = -90

struct AudioProbeResponse: Codable {
  let audio: String
  let state: String
  let active: Bool
  let heard: Bool
  let source: String
  let backend: String
  let durationMs: Int
  let elapsedMs: Int
  let bucketMs: Int
  let sampleCount: Int
  let sourceCount: Int
  let rmsDbfs: [Int]
  let peakDbfs: [Int]
  let startedAt: String
  let stoppedAt: String?
  let reason: String?
}

private struct AudioProbeBucket {
  var totalSquares: Double = 0
  var totalSamples: Int = 0
  var peak: Double = 0
}

private final class AudioProbeStatusWriter {
  private let outPath: String
  private let startedAt = Date()
  private let durationMs: Int
  private let bucketMs: Int
  private let lock = NSLock()
  private var current = AudioProbeBucket()
  private var rmsDbfs: [Int] = []
  private var peakDbfs: [Int] = []
  private var heard = false
  private var stoppedAt: Date?
  private var reason: String?

  init(outPath: String, durationMs: Int, bucketMs: Int) {
    self.outPath = outPath
    self.durationMs = durationMs
    self.bucketMs = bucketMs
  }

  func add(sampleBuffer: CMSampleBuffer) {
    guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else {
      return
    }
    let format = AVAudioFormat(cmAudioFormatDescription: formatDescription)
    let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
    guard frameCount > 0,
      let pcmBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)
    else {
      return
    }
    let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
      sampleBuffer,
      at: 0,
      frameCount: Int32(frameCount),
      into: pcmBuffer.mutableAudioBufferList
    )
    guard status == noErr else {
      return
    }
    pcmBuffer.frameLength = frameCount
    add(audioBufferList: pcmBuffer.mutableAudioBufferList, format: format)
  }

  func flushRunning() throws {
    lock.lock()
    appendCurrentBucket()
    let response = buildResponse(state: "running", active: true)
    lock.unlock()
    try write(response)
  }

  func finish(reason: String) throws {
    lock.lock()
    if current.totalSamples > 0 || rmsDbfs.isEmpty {
      appendCurrentBucket()
    }
    self.stoppedAt = Date()
    self.reason = reason
    let response = buildResponse(state: "stopped", active: false)
    lock.unlock()
    try write(response)
  }

  private func add(audioBufferList: UnsafeMutablePointer<AudioBufferList>, format: AVAudioFormat) {
    let streamDescription = format.streamDescription.pointee
    let bitsPerChannel = Int(streamDescription.mBitsPerChannel)
    guard bitsPerChannel > 0 else {
      return
    }
    let bytesPerSample = max(1, bitsPerChannel / 8)
    let isFloat = (streamDescription.mFormatFlags & kAudioFormatFlagIsFloat) != 0
    let isSignedInteger = (streamDescription.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0
    var bucket = AudioProbeBucket()
    for buffer in UnsafeMutableAudioBufferListPointer(audioBufferList) {
      guard let data = buffer.mData else {
        continue
      }
      let sampleCount = Int(buffer.mDataByteSize) / bytesPerSample
      if isFloat && bytesPerSample == 4 {
        let samples = data.bindMemory(to: Float.self, capacity: sampleCount)
        for index in 0..<sampleCount {
          bucket.add(Double(samples[index]))
        }
      } else if isSignedInteger && bytesPerSample == 2 {
        let samples = data.bindMemory(to: Int16.self, capacity: sampleCount)
        for index in 0..<sampleCount {
          bucket.add(Double(samples[index]) / Double(Int16.max))
        }
      } else if isSignedInteger && bytesPerSample == 4 {
        let samples = data.bindMemory(to: Int32.self, capacity: sampleCount)
        for index in 0..<sampleCount {
          bucket.add(Double(samples[index]) / Double(Int32.max))
        }
      }
    }
    guard bucket.totalSamples > 0 else {
      return
    }
    lock.lock()
    current.totalSquares += bucket.totalSquares
    current.totalSamples += bucket.totalSamples
    current.peak = max(current.peak, bucket.peak)
    lock.unlock()
  }

  private func appendCurrentBucket() {
    let rms = current.totalSamples > 0
      ? sqrt(current.totalSquares / Double(current.totalSamples))
      : 0
    let rmsDb = dbfs(rms)
    let peakDb = dbfs(current.peak)
    rmsDbfs.append(rmsDb)
    peakDbfs.append(peakDb)
    if rmsDb > audioProbeSilenceDb || peakDb > audioProbeSilenceDb {
      heard = true
    }
    current = AudioProbeBucket()
  }

  private func buildResponse(state: String, active: Bool) -> AudioProbeResponse {
    let end = stoppedAt ?? Date()
    let elapsed = min(durationMs, max(0, Int(end.timeIntervalSince(startedAt) * 1000)))
    return AudioProbeResponse(
      audio: "probe",
      state: state,
      active: active,
      heard: heard,
      source: "system-audio",
      backend: "macos-screencapturekit",
      durationMs: durationMs,
      elapsedMs: elapsed,
      bucketMs: bucketMs,
      sampleCount: rmsDbfs.count,
      sourceCount: 1,
      rmsDbfs: rmsDbfs,
      peakDbfs: peakDbfs,
      startedAt: iso8601(startedAt),
      stoppedAt: stoppedAt.map(iso8601),
      reason: reason
    )
  }

  private func write(_ response: AudioProbeResponse) throws {
    let outputURL = URL(fileURLWithPath: outPath)
    try FileManager.default.createDirectory(
      at: outputURL.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    let data = try JSONEncoder().encode(response)
    try data.write(to: outputURL, options: .atomic)
  }
}

private final class AudioProbeStreamOutput: NSObject, SCStreamOutput {
  private let writer: AudioProbeStatusWriter

  init(writer: AudioProbeStatusWriter) {
    self.writer = writer
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio else {
      return
    }
    writer.add(sampleBuffer: sampleBuffer)
  }
}

extension AudioProbeBucket {
  fileprivate mutating func add(_ value: Double) {
    guard value.isFinite else {
      return
    }
    let clipped = min(1, max(-1, value))
    totalSquares += clipped * clipped
    totalSamples += 1
    peak = max(peak, abs(clipped))
  }
}

func runAudioProbe(durationMs: Int, bucketMs: Int, outPath: String) throws -> AudioProbeResponse {
  guard #available(macOS 13.0, *) else {
    throw HelperError.commandFailed("audio probe requires macOS 13 or newer")
  }
  let semaphore = DispatchSemaphore(value: 0)
  var response: AudioProbeResponse?
  var runError: Error?
  Task {
    do {
      response = try await runAudioProbeAsync(durationMs: durationMs, bucketMs: bucketMs, outPath: outPath)
    } catch {
      runError = error
    }
    semaphore.signal()
  }
  semaphore.wait()
  if let runError {
    throw runError
  }
  guard let response else {
    throw HelperError.commandFailed("audio probe failed")
  }
  return response
}

@available(macOS 13.0, *)
private func runAudioProbeAsync(durationMs: Int, bucketMs: Int, outPath: String) async throws -> AudioProbeResponse {
  let content: SCShareableContent
  do {
    content = try await SCShareableContent.current
  } catch {
    throw HelperError.commandFailed(
      "audio probe requires Screen Recording permission on macOS",
      details: ["permission": "screen-recording", "error": error.localizedDescription]
    )
  }
  guard let display = content.displays.first else {
    throw HelperError.commandFailed("audio probe could not resolve a macOS display")
  }

  let configuration = SCStreamConfiguration()
  configuration.width = max(2, display.width)
  configuration.height = max(2, display.height)
  configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
  configuration.queueDepth = 1
  configuration.capturesAudio = true
  configuration.sampleRate = 48_000
  configuration.channelCount = 2
  configuration.excludesCurrentProcessAudio = true

  let filter = SCContentFilter(display: display, excludingWindows: [])
  let writer = AudioProbeStatusWriter(outPath: outPath, durationMs: durationMs, bucketMs: bucketMs)
  let output = AudioProbeStreamOutput(writer: writer)
  let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
  let queue = DispatchQueue(label: "com.callstack.agent-device.audio-probe")
  try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: queue)
  try await stream.startCapture()
  try writer.flushRunning()

  let deadline = Date().addingTimeInterval(Double(durationMs) / 1000)
  while Date() < deadline {
    let remainingMs = Int(deadline.timeIntervalSinceNow * 1000)
    let sleepMs = max(1, min(bucketMs, remainingMs))
    try await Task.sleep(nanoseconds: UInt64(sleepMs) * 1_000_000)
    try writer.flushRunning()
  }

  try await stream.stopCapture()
  try writer.finish(reason: "completed")
  let data = try Data(contentsOf: URL(fileURLWithPath: outPath))
  return try JSONDecoder().decode(AudioProbeResponse.self, from: data)
}

private func dbfs(_ value: Double) -> Int {
  if !value.isFinite || value <= 0 {
    return audioProbeSilenceDb
  }
  let db = Int((20 * log10(value)).rounded())
  return max(audioProbeSilenceDb, min(0, db))
}

private func iso8601(_ date: Date) -> String {
  ISO8601DateFormatter().string(from: date)
}
